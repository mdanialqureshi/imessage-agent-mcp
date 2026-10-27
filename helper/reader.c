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
//   its files with SQLite, and only changes a file after checking it's its own.
// - A deadline (alarm) ends it if anything there makes it hang, releasing its read lock on
//   the live Messages database.
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
#include <sys/clonefile.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <unistd.h>

#ifndef READER_HOME // Tests build with a fake home; the real binary always uses the account's.
#define READER_HOME NULL
#endif

static const char *AB = "AddressBook-v22.abcddb";
static int state = -1;

static int join(char *out, const char *a, const char *b) {
  return snprintf(out, PATH_MAX, "%s/%s", a, b) < PATH_MAX ? 0 : ENAMETOOLONG;
}

/** dir/name as a directory handle, refusing a link at name. */
static int open_dir(int dir, const char *name) {
  return openat(dir, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
}

/** Whether fd is a directory owned by us that no one else can open. */
static int is_private_dir(int fd) {
  struct stat st;
  return fd >= 0 && fstat(fd, &st) == 0 && S_ISDIR(st.st_mode) && st.st_uid == getuid() && !(st.st_mode & 077);
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

/** Copies src to dir/name as a private file: an APFS clone, or a plain copy elsewhere. */
static int copy_file(const char *src, int dir, const char *name) {
  if (clonefileat(AT_FDCWD, src, dir, name, CLONE_NOFOLLOW) < 0) {
    if (errno != ENOTSUP && errno != EXDEV) return errno;
    int in = open(src, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (in < 0) return errno;
    int out = openat(dir, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    int err = out < 0 || fcopyfile(in, out, NULL, COPYFILE_DATA) < 0 ? errno : 0;
    close(in);
    if (out >= 0 && close(out) < 0 && !err) err = errno;
    return err;
  }
  // A clone keeps the source's mode. Make it private, after checking it's still our clone
  // (O_NONBLOCK: a FIFO swapped in here must not block us while we hold the live database).
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
 * Copies a SQLite database and its WAL into dir. A read transaction on the live database
 * stops SQLite from checkpointing past our snapshot or resetting the WAL while we copy, so
 * the pair is consistent. The service applies the WAL when it opens its copy.
 */
static int copy_db(const char *src, int dir, const char *name) {
  char src_wal[PATH_MAX], dst_wal[NAME_MAX + 1];
  if (snprintf(src_wal, sizeof src_wal, "%s-wal", src) >= (int)sizeof src_wal ||
      snprintf(dst_wal, sizeof dst_wal, "%s-wal", name) >= (int)sizeof dst_wal)
    return ENAMETOOLONG;
  if (access(src, R_OK) < 0) return errno; // EPERM without Full Disk Access.
  sqlite3 *live = NULL;
  int held = sqlite3_open_v2(src, &live, SQLITE_OPEN_READONLY, NULL) == SQLITE_OK &&
             sqlite3_exec(live, "BEGIN; SELECT count(*) FROM sqlite_master;", NULL, NULL, NULL) == SQLITE_OK;
  // A read-only connection can't open a WAL database whose -wal/-shm are gone. With no WAL,
  // the file already holds every committed change and nothing writes to it, so copy it as is.
  int err = !held && access(src_wal, F_OK) == 0 ? EFAULT : copy_file(src, dir, name);
  if (!err && access(src_wal, F_OK) == 0) err = copy_file(src_wal, dir, dst_wal);
  if (held) sqlite3_exec(live, "COMMIT;", NULL, NULL, NULL);
  sqlite3_close(live);
  if (err) {
    unlinkat(dir, name, 0);
    unlinkat(dir, dst_wal, 0);
  }
  return err;
}

/** Contacts: the root AddressBook database plus one per account under Sources/. */
static void copy_contacts(const char *home, int dir) {
  char ab[PATH_MAX], src[PATH_MAX], sources[PATH_MAX];
  if (join(ab, home, "Library/Application Support/AddressBook") || mkdirat(dir, "AddressBook", 0700) < 0) return;
  int out = open_dir(dir, "AddressBook");
  if (out < 0) return;
  if (!join(src, ab, AB) && access(src, F_OK) == 0) copy_db(src, out, AB);
  DIR *d = join(sources, ab, "Sources") ? NULL : opendir(sources);
  int subs = d && mkdirat(out, "Sources", 0700) == 0 ? open_dir(out, "Sources") : -1;
  struct dirent *e;
  while (subs >= 0 && (e = readdir(d))) {
    char db[PATH_MAX];
    if (e->d_name[0] == '.' || snprintf(db, PATH_MAX, "%s/%s/%s", sources, e->d_name, AB) >= PATH_MAX) continue;
    if (access(db, F_OK) < 0 || mkdirat(subs, e->d_name, 0700) < 0) continue;
    int to = open_dir(subs, e->d_name);
    if (to < 0) continue;
    copy_db(db, to, AB); // An unreadable account is skipped, as before.
    close(to);
  }
  if (subs >= 0) close(subs);
  if (d) closedir(d);
  close(out);
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
  char chat[PATH_MAX];
  if (!home || join(chat, home, "Library/Messages/chat.db")) return 1;

  // Walk to the state folder without following links, so it can't be redirected.
  const char *parts[] = {"Library", "Application Support", "imessage-agent-mcp"};
  int fd = open(home, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  for (size_t i = 0; i < sizeof parts / sizeof *parts && fd >= 0; i++) {
    int next = open_dir(fd, parts[i]);
    close(fd);
    fd = next;
  }
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
  int err = copy_db(chat, out, "chat.db");
  if (!err) copy_contacts(home, out);
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
