// imessage-agent-reader: the only part of imessage-agent-mcp that holds Full Disk Access.
//
// It takes no arguments, reads no environment, and does one thing: makes a private,
// consistent copy of the Messages and Contacts databases in the agent's state folder,
// for the background service (which holds no special permissions) to read. Running it
// can't reveal anything beyond those two databases, which the service exposes anyway.
//
// launchd runs it as its own job (com.imessage-agent-mcp.reader), so macOS attributes its
// file access to this binary alone. Built by `node src/cli.ts setup`.
#include <copyfile.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pwd.h>
#include <removefile.h>
#include <sqlite3.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <unistd.h>

#ifndef READER_HOME // Tests build with a fake home; the real binary always uses the account's.
#define READER_HOME NULL
#endif

static char state[PATH_MAX];

static int join(char *out, const char *a, const char *b) {
  return snprintf(out, PATH_MAX, "%s/%s", a, b) < PATH_MAX ? 0 : ENAMETOOLONG;
}

/** Writes "ok <ms>" or "error <code> <ms>" to <state>/reader-status, atomically. */
static void status(int err) {
  char tmp[PATH_MAX], dst[PATH_MAX];
  struct timeval tv;
  gettimeofday(&tv, NULL);
  long long ms = (long long)tv.tv_sec * 1000 + tv.tv_usec / 1000;
  if (join(tmp, state, "reader-status.tmp") || join(dst, state, "reader-status")) return;
  int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0600);
  if (fd < 0) return;
  if (err) dprintf(fd, "error %s %lld\n", err == EPERM || err == EACCES ? "EPERM" : "EFAIL", ms);
  else dprintf(fd, "ok %lld\n", ms);
  close(fd);
  rename(tmp, dst);
}

/**
 * Copies one SQLite database (and its WAL) into dir, then folds the WAL into the copy so it
 * is a single self-contained file. A read transaction on the live database stops SQLite
 * from checkpointing past our snapshot or resetting the WAL while we copy, so the pair is
 * consistent. Copies are APFS clones when possible: instant, and no extra disk space.
 */
static int copy_db(const char *src, const char *dir, const char *name) {
  char dst[PATH_MAX], src_wal[PATH_MAX], dst_wal[PATH_MAX];
  if (join(dst, dir, name)) return ENAMETOOLONG;
  snprintf(src_wal, PATH_MAX, "%s-wal", src);
  snprintf(dst_wal, PATH_MAX, "%s-wal", dst);

  if (access(src, R_OK) < 0) return errno; // EPERM without Full Disk Access.
  sqlite3 *live = NULL;
  int held = sqlite3_open_v2(src, &live, SQLITE_OPEN_READONLY, NULL) == SQLITE_OK &&
             sqlite3_exec(live, "BEGIN; SELECT count(*) FROM sqlite_master;", NULL, NULL, NULL) == SQLITE_OK;
  // A read-only connection can't open a WAL database whose -wal/-shm are gone. With no WAL,
  // the file already holds every committed change and nothing writes to it, so copy it as is.
  if (!held && access(src_wal, F_OK) == 0) {
    sqlite3_close(live);
    return EFAULT;
  }
  int err = 0;
  if (copyfile(src, dst, NULL, COPYFILE_CLONE) < 0) err = errno;
  if (!err && access(src_wal, F_OK) == 0 && copyfile(src_wal, dst_wal, NULL, COPYFILE_CLONE) < 0) err = errno;
  if (held) sqlite3_exec(live, "COMMIT;", NULL, NULL, NULL);
  sqlite3_close(live);
  if (err) return err;
  chmod(dst, 0600); // Clones keep the source's mode, and SQLite gives its side files the same.
  chmod(dst_wal, 0600);

  sqlite3 *copy = NULL;
  int rc = sqlite3_open_v2(dst, &copy, SQLITE_OPEN_READWRITE, NULL);
  if (rc == SQLITE_OK) rc = sqlite3_exec(copy, "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;", NULL, NULL, NULL);
  sqlite3_close(copy);
  char dst_shm[PATH_MAX];
  snprintf(dst_shm, PATH_MAX, "%s-shm", dst);
  unlink(dst_wal);
  unlink(dst_shm);
  return rc == SQLITE_OK ? 0 : EFAULT;
}

/** Contacts: the root AddressBook database plus one per account under Sources/. */
static void copy_contacts(const char *home, const char *dir) {
  char ab[PATH_MAX], src[PATH_MAX], out[PATH_MAX], sources[PATH_MAX], sub[PATH_MAX];
  if (join(ab, home, "Library/Application Support/AddressBook") || join(out, dir, "AddressBook")) return;
  if (mkdir(out, 0700) < 0) return;
  if (!join(src, ab, "AddressBook-v22.abcddb") && access(src, F_OK) == 0) copy_db(src, out, "AddressBook-v22.abcddb");
  if (join(sources, ab, "Sources") || join(sub, out, "Sources") || mkdir(sub, 0700) < 0) return;
  DIR *d = opendir(sources);
  if (!d) return;
  struct dirent *e;
  while ((e = readdir(d))) {
    char from[PATH_MAX], to[PATH_MAX], db[PATH_MAX];
    if (e->d_name[0] == '.' || join(from, sources, e->d_name) || join(db, from, "AddressBook-v22.abcddb")) continue;
    if (access(db, F_OK) || join(to, sub, e->d_name) || mkdir(to, 0700) < 0) continue;
    copy_db(db, to, "AddressBook-v22.abcddb"); // Unreadable accounts are skipped, as before.
  }
  closedir(d);
}

int main(void) {
  umask(077);
  const struct passwd *pw = getpwuid(getuid());
  const char *home = READER_HOME ? READER_HOME : (pw ? pw->pw_dir : NULL);
  if (!home || join(state, home, "Library/Application Support/imessage-agent-mcp")) return 1;

  // Only write into the agent's own private folder: a real directory, ours, mode 0700.
  struct stat st;
  if (lstat(state, &st) < 0 || !S_ISDIR(st.st_mode) || st.st_uid != getuid() || (st.st_mode & 077)) {
    fprintf(stderr, "imessage-agent-reader: %s must be a private folder owned by you\n", state);
    return 1;
  }

  char tmp[PATH_MAX], mirror[PATH_MAX], chat[PATH_MAX];
  if (join(tmp, state, "mirror-new-XXXXXX") || join(mirror, state, "mirror") ||
      join(chat, home, "Library/Messages/chat.db") || !mkdtemp(tmp)) {
    status(EFAULT);
    return 1;
  }
  int err = copy_db(chat, tmp, "chat.db");
  if (err) {
    removefile(tmp, NULL, REMOVEFILE_RECURSIVE);
    status(err);
    fprintf(stderr, "imessage-agent-reader: can't read Messages (%s)\n", strerror(err));
    return 1;
  }
  copy_contacts(home, tmp);

  // Swap the new copy in atomically; readers holding the old one keep their open files.
  if (renamex_np(tmp, mirror, RENAME_SWAP) == 0) removefile(tmp, NULL, REMOVEFILE_RECURSIVE);
  else if (rename(tmp, mirror) < 0) {
    removefile(tmp, NULL, REMOVEFILE_RECURSIVE);
    status(errno);
    return 1;
  }
  status(0);
  return 0;
}
