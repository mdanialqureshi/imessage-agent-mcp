// imessage-agent-reader: the only part of imessage-agent-mcp that holds Full Disk Access.
//
// It takes no arguments and does one thing: copies the Messages and Contacts databases
// (with their write-ahead logs) into the agent's private state folder, for the background
// service, which holds no special permissions, to read. Running it reveals nothing beyond
// those two databases, which the service exposes anyway.
//
// Hardening, because anything running as the user can run it or write to the state folder:
// - It's signed with the hardened runtime (`codesign -o runtime`), so DYLD_* variables and
//   injected libraries are ignored and debuggers can't attach.
// - It reaches the state folder one component at a time without following links, then does
//   everything relative to that handle. It never follows a link in the folder or opens one of
//   its files with SQLite. It only modifies a file after checking it's its own; leftovers are
//   deleted without following links.
// - It reaches Messages and Contacts the same way, one folder at a time without following
//   links, and only copies regular files, so nothing planted there can redirect it or stall it.
// - It holds its read lock on the live Messages database only while cloning (or copying, off
//   APFS), writes only through folders on the home filesystem, and a deadline
//   (alarm) ends it if it stalls. (A process that can pause it, e.g. with SIGSTOP, can still
//   delay it; such a process could pause Messages itself just as well.)
//
// launchd runs it as its own job (com.imessage-agent-mcp.reader), so macOS attributes its
// file access to this binary alone. Built by `node src/cli.ts setup`.
#include <copyfile.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pwd.h>
#include <signal.h>
#include <sqlite3.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/acl.h>
#include <sys/clonefile.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <unistd.h>

#ifndef READER_HOME // Tests build with a fake home; the real binary always uses the account's.
#define READER_HOME NULL
#endif

static const char *AB = "AddressBook-v22.abcddb";
static int state = -1;
static dev_t home_dev; // Every folder we write through must be on the home filesystem.


static int join(char *out, const char *a, const char *b) {
  return snprintf(out, PATH_MAX, "%s/%s", a, b) < PATH_MAX ? 0 : ENAMETOOLONG;
}

/**
 * dir/name as a directory handle, refusing a link at name, or a different filesystem there
 * (something mounted over it could stall our writes while we hold the live database).
 */
static int open_dir(int dir, const char *name) {
  int fd = openat(dir, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat st;
  if (fd >= 0 && (fstat(fd, &st) < 0 || st.st_dev != home_dev)) {
    close(fd);
    errno = EXDEV;
    return -1;
  }
  return fd;
}

/** dir/name as a directory handle, opening each of the given path parts in turn. */
static int open_path(int dir, const char *const parts[], size_t n) {
  int fd = dup(dir);
  for (size_t i = 0; i < n && fd >= 0; i++) {
    int next = open_dir(fd, parts[i]);
    int saved = errno;
    close(fd);
    fd = next;
    errno = saved;
  }
  return fd;
}

/** Whether dir/name is a regular file: not a link, folder, pipe or device. */
static int is_regular(int dir, const char *name) {
  struct stat st;
  if (fstatat(dir, name, &st, AT_SYMLINK_NOFOLLOW) < 0) return 0;
  if (!S_ISREG(st.st_mode)) errno = EINVAL;
  return S_ISREG(st.st_mode);
}

/**
 * Whether fd is a directory owned by us that no one else can open: no group or other mode
 * bits, and no access-control list that could grant them access anyway.
 */
static int is_private_dir(int fd) {
  struct stat st;
  if (fd < 0 || fstat(fd, &st) < 0 || !S_ISDIR(st.st_mode) || st.st_uid != getuid() || (st.st_mode & 077)) return 0;
  acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (!acl) return 1;
  acl_entry_t entry;
  int any = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry) == 0;
  acl_free(acl);
  return !any;
}

/** Writes "ok <ms>" or "error <code> <ms>" to reader-status: a fresh file, then renamed. */
static void status(int err) {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  long long ms = (long long)tv.tv_sec * 1000 + tv.tv_usec / 1000;
  unlinkat(state, "reader-status.tmp", 0);
  int fd = openat(state, "reader-status.tmp", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) return;
  int wrote = err ? dprintf(fd, "error %s %lld\n", err == EPERM || err == EACCES ? "EPERM" : "EFAIL", ms)
                  : dprintf(fd, "ok %lld\n", ms);
  if (close(fd) == 0 && wrote > 0) renameat(state, "reader-status.tmp", state, "reader-status");
}

/** Deletes dir/name and everything under it, never following links. 0 when it's gone. */
static int remove_tree(int dir, const char *name, int depth) {
  if (unlinkat(dir, name, 0) == 0 || errno == ENOENT) return 0;
  int fd = depth < 6 ? open_dir(dir, name) : -1;
  if (fd < 0) return -1;
  DIR *d = fdopendir(fd);
  if (!d) {
    close(fd);
    return -1;
  }
  // Deleting while reading a directory can skip entries, so take a few passes; an entry that
  // can't be deleted (locked, unreadable, too deep) just leaves this directory in place.
  for (int pass = 0, progress = 1; progress && pass < 3; pass++) {
    progress = 0;
    rewinddir(d);
    struct dirent *e;
    while ((e = readdir(d))) {
      if (strcmp(e->d_name, ".") && strcmp(e->d_name, "..") && remove_tree(dirfd(d), e->d_name, depth + 1) == 0) progress = 1;
    }
  }
  closedir(d);
  return unlinkat(dir, name, AT_REMOVEDIR);
}

/** Copies sdir/src to dir/name: an APFS clone, or a plain copy elsewhere. */
static int copy_file(int sdir, const char *src, int dir, const char *name) {
  if (clonefileat(sdir, src, dir, name, CLONE_NOFOLLOW) == 0) return 0;
  if (errno != ENOTSUP && errno != EXDEV) return errno;
  int in = openat(sdir, src, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (in < 0) return errno;
  int out = openat(dir, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  int err = out < 0 || fcopyfile(in, out, NULL, COPYFILE_DATA) < 0 ? errno : 0;
  close(in);
  if (out >= 0 && close(out) < 0 && !err) err = errno;
  return err;
}

/**
 * Makes dir/name private (a clone keeps the source's mode), after checking it's still our
 * copy. O_NONBLOCK: a FIFO swapped in here must not block us.
 */
static int make_private(int dir, const char *name) {
  int fd = openat(dir, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) return errno;
  struct stat st;
  int err = fstat(fd, &st) < 0 ? errno
            : !S_ISREG(st.st_mode) || st.st_nlink != 1 || st.st_uid != getuid() ? EEXIST
            : fchmod(fd, 0600) < 0 ? errno
            : 0;
  close(fd);
  return err;
}

/**
 * Copies the SQLite database sdir/name (at path sdir_path) and its WAL into dir. A read
 * transaction on the live database stops SQLite from checkpointing past our snapshot or
 * resetting the WAL while we copy, so the pair is consistent. The service applies the WAL
 * when it opens its copy.
 */
static int copy_db(int sdir, const char *sdir_path, const char *name, int dir) {
  char src[PATH_MAX], wal_name[NAME_MAX + 1];
  if (join(src, sdir_path, name) || snprintf(wal_name, sizeof wal_name, "%s-wal", name) >= (int)sizeof wal_name) return ENAMETOOLONG;
  if (!is_regular(sdir, name)) return errno; // EPERM without Full Disk Access.
  sqlite3 *live = NULL;
  int held = sqlite3_open_v2(src, &live, SQLITE_OPEN_READONLY | SQLITE_OPEN_NOFOLLOW, NULL) == SQLITE_OK &&
             sqlite3_exec(live, "BEGIN; SELECT count(*) FROM sqlite_master;", NULL, NULL, NULL) == SQLITE_OK;
  // A read-only connection can't open a WAL database whose -wal/-shm are gone. With no WAL,
  // the file already holds every committed change and nothing writes to it, so copy it as is.
  int wal = is_regular(sdir, wal_name);
  int err = !held && wal ? EFAULT : copy_file(sdir, name, dir, name);
  if (!err && wal) err = copy_file(sdir, wal_name, dir, wal_name);
  // Release the live database before checking and changing the copies.
  if (held) sqlite3_exec(live, "COMMIT;", NULL, NULL, NULL);
  sqlite3_close(live);
  if (!err) err = make_private(dir, name);
  if (!err && wal) err = make_private(dir, wal_name);
  if (err) {
    unlinkat(dir, name, 0);
    unlinkat(dir, wal_name, 0);
  }
  return err;
}

/** Contacts: the root AddressBook database plus one per account under Sources/. */
static void copy_contacts(int home_fd, const char *home, int dir) {
  static const char *const parts[] = {"Library", "Application Support", "AddressBook"};
  char ab_path[PATH_MAX], sources_path[PATH_MAX];
  if (join(ab_path, home, "Library/Application Support/AddressBook") || join(sources_path, ab_path, "Sources")) return;
  int ab = open_path(home_fd, parts, 3);
  if (ab < 0 || mkdirat(dir, "AddressBook", 0700) < 0) goto done;
  int out = open_dir(dir, "AddressBook");
  if (out < 0) goto done;
  if (is_regular(ab, AB)) copy_db(ab, ab_path, AB, out);
  int sources = open_dir(ab, "Sources");
  int listing = sources >= 0 ? dup(sources) : -1;
  DIR *d = listing >= 0 ? fdopendir(listing) : NULL;
  if (!d && listing >= 0) close(listing);
  int subs = d && mkdirat(out, "Sources", 0700) == 0 ? open_dir(out, "Sources") : -1;
  struct dirent *e;
  while (subs >= 0 && (e = readdir(d))) {
    char sub_path[PATH_MAX];
    if (e->d_name[0] == '.' || join(sub_path, sources_path, e->d_name)) continue;
    int sub = open_dir(sources, e->d_name); // Not a link: an account folder of this AddressBook.
    if (sub < 0) continue;
    if (is_regular(sub, AB) && mkdirat(subs, e->d_name, 0700) == 0) {
      int to = open_dir(subs, e->d_name);
      if (to >= 0) {
        copy_db(sub, sub_path, AB, to); // An unreadable account is skipped.
        close(to);
      }
    }
    close(sub);
  }
  if (subs >= 0) close(subs);
  if (d) closedir(d);
  if (sources >= 0) close(sources);
  close(out);
done:
  if (ab >= 0) close(ab);
}

int main(void) {
  umask(077);
  // launchd or whoever runs us may have ignored or blocked SIGALRM; the deadline must work.
  sigset_t alrm;
  sigemptyset(&alrm);
  sigaddset(&alrm, SIGALRM);
  signal(SIGALRM, SIG_DFL);
  sigprocmask(SIG_UNBLOCK, &alrm, NULL);
  alarm(120);
  const struct passwd *pw = getpwuid(getuid());
  const char *home = READER_HOME ? READER_HOME : (pw ? pw->pw_dir : NULL);
  char messages[PATH_MAX];
  if (!home || join(messages, home, "Library/Messages")) return 1;

  // Walk to the state folder without following links, so it can't be redirected.
  static const char *const state_parts[] = {"Library", "Application Support", "imessage-agent-mcp"};
  static const char *const messages_parts[] = {"Library", "Messages"};
  int home_fd = open(home, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  struct stat st_home;
  if (home_fd < 0 || fstat(home_fd, &st_home) < 0) return 1;
  home_dev = st_home.st_dev;
  int fd = open_path(home_fd, state_parts, 3);
  if (!is_private_dir(fd)) {
    fprintf(stderr, "imessage-agent-reader: ~/Library/Application Support/imessage-agent-mcp must be a private folder owned by you\n");
    return 1;
  }
  state = fd;

  char tmp[] = "mirror-new-XXXXXX";
  int out = mkdtempat_np(state, tmp) ? open_dir(state, tmp) : -1;
  if (!is_private_dir(out)) {
    if (out >= 0) close(out);
    remove_tree(state, tmp, 0);
    status(EFAULT);
    return 1;
  }
  int msgs = open_path(home_fd, messages_parts, 2);
  int err = msgs < 0 ? errno : copy_db(msgs, messages, "chat.db", out); // EPERM without Full Disk Access.
  if (msgs >= 0) close(msgs);
  if (!err) copy_contacts(home_fd, home, out);
  close(out);
  if (err) {
    remove_tree(state, tmp, 0);
    status(err);
    fprintf(stderr, "imessage-agent-reader: can't read Messages (%s)\n", strerror(err));
    return 1;
  }

  // Swap the new copy in atomically; the service keeps reading any copy it already has open.
  if (renameatx_np(state, tmp, state, "mirror", RENAME_SWAP) == 0) {
    remove_tree(state, tmp, 0);
  } else if (errno != ENOENT || renameatx_np(state, tmp, state, "mirror", RENAME_EXCL) < 0) {
    err = errno;
    remove_tree(state, tmp, 0);
    status(err);
    return 1;
  }
  status(0);
  return 0;
}
