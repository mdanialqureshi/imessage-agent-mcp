import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type InterpreterName = 'codex' | 'claude';

/**
 * The Mac app this copy runs inside (imessage-agent.app, which bundles Node, this source and
 * a prebuilt reader), or null when it runs from a clone of the repo.
 */
export const appBundle = /^(\/.+\.app)\/Contents\/Resources\/app\/src\/config\.ts$/.exec(fileURLToPath(import.meta.url))?.[1] ?? null;

export interface Config {
  /** Which subscription CLI interprets conversations: Claude Code (default) or Codex. */
  interpreter: InterpreterName;
  /** Optional model override passed to the interpreter CLI. */
  model: string | null;
  /** How far back the very first run looks. */
  firstRunLookbackDays: number;
  /** Messages of earlier context shown before the new ones in each chat. */
  contextMessages: number;
  /** Only flag an unanswered message as `reply_owed` after this many hours. */
  replyOwedAfterHours: number;
  /** How often the background service interprets new messages. */
  autoInterpretMinutes: number;
  /** Names, phone numbers or emails that are never read or sent to a model. */
  privateContacts: string[];
  /** Skip chats with SMS short codes (banks, 2FA, deliveries). */
  skipShortCodes: boolean;
}

const defaults: Config = {
  interpreter: 'claude',
  model: null,
  firstRunLookbackDays: 7,
  contextMessages: 25,
  replyOwedAfterHours: 4,
  autoInterpretMinutes: 120,
  privateContacts: [],
  skipShortCodes: true,
};

const stateDir =
  process.env.IMESSAGE_AGENT_STATE_DIR ?? path.join(os.homedir(), 'Library/Application Support/imessage-agent-mcp');
/**
 * The background service reads copies made by imessage-agent-reader (helper/reader.c), the
 * only part holding Full Disk Access; its launchd job sets IMESSAGE_AGENT_MIRROR=1.
 * Terminal commands read the live files with the terminal's own access.
 */
const mirror = process.env.IMESSAGE_AGENT_MIRROR === '1' ? path.join(stateDir, 'mirror') : null;

export const paths = {
  chatDb: process.env.IMESSAGE_DB_PATH ?? (mirror ? path.join(mirror, 'chat.db') : path.join(os.homedir(), 'Library/Messages/chat.db')),
  addressBookDir:
    process.env.ADDRESSBOOK_DIR ??
    (mirror ? path.join(mirror, 'AddressBook') : path.join(os.homedir(), 'Library/Application Support/AddressBook')),
  stateDir,
  /** Set in the service: the reader's private copies, opened read-write so SQLite applies their WAL. */
  mirror,
};

export function configPath(): string {
  return path.join(paths.stateDir, 'config.json');
}

/** The state dir holds message excerpts and the service's socket, so it's private to this user. */
export function ensureStateDir(): void {
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(paths.stateDir, 0o700);
}

export const INTERPRETERS: InterpreterName[] = ['claude', 'codex'];

export function loadConfigDefaults(): Config {
  return structuredClone(defaults);
}

export function saveConfig(config: Config): void {
  ensureStateDir();
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

export function loadConfig(): Config {
  ensureStateDir();
  const file = configPath();
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(defaults, null, 2) + '\n', { mode: 0o600 });
    return structuredClone(defaults);
  }
  const { http: _removed, ...user } = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Config> & { http?: unknown };
  const config = { ...defaults, ...user };
  // An environment override beats config.json, e.g. for one-off runs or the launchd plist.
  const fromEnv = process.env.IMESSAGE_AGENT_INTERPRETER as InterpreterName | undefined;
  if (fromEnv) config.interpreter = fromEnv;
  if (!INTERPRETERS.includes(config.interpreter)) throw new Error(`interpreter must be "claude" or "codex", got "${config.interpreter}"`);
  return config;
}
