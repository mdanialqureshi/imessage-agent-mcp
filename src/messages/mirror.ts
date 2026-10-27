import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config.ts';

/**
 * The background service never opens Messages or Contacts itself. imessage-agent-reader
 * (helper/reader.c) is a separate launchd job and the only thing holding Full Disk Access;
 * it copies both databases into <state>/mirror, and the service reads those copies.
 */
export const READER_LABEL = 'com.imessage-agent-mcp.reader';

export const usingMirror = () => process.env.IMESSAGE_AGENT_MIRROR === '1';

/** Built by setup. Rebuilding changes its signature, so macOS asks for access again. */
export const readerBinary = () => path.join(paths.stateDir, 'bin', 'imessage-agent-reader');

/**
 * How the reader is built and signed. The hardened runtime is essential: without it, anything
 * running as the user could inject a library into the reader and inherit its Full Disk Access.
 * Part of setup's rebuild check, so changing it rebuilds existing installs.
 */
export const READER_BUILD = {
  cc: ['-O2', '-Wall', '-lsqlite3'],
  codesign: ['--force', '--sign', '-', '--options', 'runtime', '--identifier', READER_LABEL],
};

/** Compiles and signs the reader to `out`. Tests pass `-DREADER_HOME=…` to aim it at a fake home. */
export function compileReader(source: string, out: string, defines: string[] = []): void {
  execFileSync('/usr/bin/cc', [...defines, ...READER_BUILD.cc, '-o', out, source], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('/usr/bin/codesign', [...READER_BUILD.codesign, out], { stdio: 'ignore' });
}

export interface ReaderStatus {
  ok: boolean;
  /** EPERM: no Full Disk Access. EFAIL: anything else (retried on the next read). */
  error?: 'EPERM' | 'EFAIL';
  at: number;
}

/** The reader's last result, from <state>/reader-status ("ok <ms>" or "error <code> <ms>"). */
export function readerStatus(): ReaderStatus | null {
  let line: string;
  try {
    line = fs.readFileSync(path.join(paths.stateDir, 'reader-status'), 'utf8').trim();
  } catch {
    return null;
  }
  const [state, a, b] = line.split(' ');
  if (state === 'ok' && Number(a)) return { ok: true, at: Number(a) };
  if (state === 'error' && Number(b)) return { ok: false, error: a === 'EPERM' ? 'EPERM' : 'EFAIL', at: Number(b) };
  return null;
}

export const NEEDS_ACCESS =
  "The imessage-agent service on the user's Mac can't read Messages yet: its reader needs Full Disk Access " +
  '(run `node src/cli.ts doctor` on the Mac).';

/** Why the copy can't be used, for agents; null when it can. */
export function mirrorProblem(status: ReaderStatus | null): string | null {
  if (status?.ok) return null;
  if (!status || status.error === 'EPERM') return NEEDS_ACCESS;
  return "The imessage-agent service on the user's Mac couldn't copy Messages just now. Try again in a minute.";
}

const kickstart = () =>
  new Promise<void>((resolve) =>
    execFile('/bin/launchctl', ['kickstart', `gui/${process.getuid!()}/${READER_LABEL}`], { timeout: 5000 }, () => resolve()),
  );

let inFlight: Promise<ReaderStatus | null> | null = null;

/**
 * A copy at most `maxAgeMs` old. Asks launchd to run the reader when the copy is older, and
 * waits up to `waitMs` for it; concurrent callers share one run.
 */
export function freshMirror({ maxAgeMs = 60_000, waitMs = 15_000, kick = kickstart } = {}): Promise<ReaderStatus | null> {
  const current = readerStatus();
  if (current?.ok && Date.now() - current.at < maxAgeMs) return Promise.resolve(current);
  inFlight ??= (async () => {
    const before = current?.at ?? 0;
    await kick();
    const until = Date.now() + waitMs;
    for (;;) {
      const status = readerStatus();
      if ((status && status.at > before) || Date.now() > until) return status;
      await new Promise((r) => setTimeout(r, 200));
    }
  })().finally(() => (inFlight = null));
  return inFlight;
}
