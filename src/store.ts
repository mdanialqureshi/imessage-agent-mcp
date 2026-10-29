import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureStateDir, paths } from './config.ts';

export const KINDS = [
  'plan',
  'call',
  'task',
  'follow_up',
  'consider',
  'reminder',
  'reply_owed',
  'invite',
  'they_owe_me',
  'iou',
  'check_in',
  'fact',
  'recommendation',
] as const;
export type Kind = (typeof KINDS)[number];

export const STATUSES = ['open', 'scheduled', 'snoozed', 'done', 'dismissed', 'cancelled'] as const;
export type Status = (typeof STATUSES)[number];

export interface Evidence {
  rowid: number;
  from: string;
  date: string;
  text: string;
}

export interface Item {
  id: string;
  kind: Kind;
  status: Status;
  chatGuid: string;
  chatId: number;
  chatLabel: string;
  person: string | null;
  title: string;
  detail: string | null;
  whenStart: string | null;
  whenEnd: string | null;
  whenText: string | null;
  precision: string;
  strength: string;
  confidence: number;
  suggestedAction: string;
  missingDetails: string[];
  evidence: Evidence[];
  /** Someone in the chat isn't a saved contact, so the text came from a stranger. */
  unknownSender: boolean;
  note: string | null;
  snoozedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ItemFields = Omit<Item, 'id' | 'status' | 'note' | 'snoozedUntil' | 'createdAt' | 'updatedAt'>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  chat_guid TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  chat_label TEXT NOT NULL,
  person TEXT,
  title TEXT NOT NULL,
  detail TEXT,
  when_start TEXT,
  when_end TEXT,
  when_text TEXT,
  precision TEXT NOT NULL,
  strength TEXT NOT NULL,
  confidence REAL NOT NULL,
  suggested_action TEXT NOT NULL,
  missing_details TEXT NOT NULL,
  evidence TEXT NOT NULL,
  note TEXT,
  snoozed_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS items_chat ON items(chat_id, status);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  interpreter TEXT NOT NULL,
  chats INTEGER NOT NULL DEFAULT 0,
  messages INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  closed INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
`;

function rowToItem(r: Record<string, any>): Item {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    chatGuid: r.chat_guid,
    chatId: Number(r.chat_id),
    chatLabel: r.chat_label,
    person: r.person,
    title: r.title,
    detail: r.detail,
    whenStart: r.when_start,
    whenEnd: r.when_end,
    whenText: r.when_text,
    precision: r.precision,
    strength: r.strength,
    confidence: Number(r.confidence),
    suggestedAction: r.suggested_action,
    missingDetails: JSON.parse(r.missing_details),
    evidence: JSON.parse(r.evidence),
    unknownSender: Boolean(r.unknown_sender),
    note: r.note,
    snoozedUntil: r.snoozed_until,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class Store {
  private db: DatabaseSync;

  static open(file = path.join(paths.stateDir, 'state.db')): Store {
    ensureStateDir();
    // Create the file 0600 before SQLite opens it; SQLite gives -wal/-shm the main file's mode.
    fs.closeSync(fs.openSync(file, 'a', 0o600));
    fs.chmodSync(file, 0o600);
    const store = new Store(new DatabaseSync(file));
    for (const suffix of ['-wal', '-shm']) if (fs.existsSync(file + suffix)) fs.chmodSync(file + suffix, 0o600);
    return store;
  }

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    const runCols = new Set((this.db.prepare('PRAGMA table_info(runs)').all() as { name: string }[]).map((c) => c.name));
    for (const col of ['discarded', 'skipped_chats']) {
      if (!runCols.has(col)) this.db.exec(`ALTER TABLE runs ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
    }
    const itemCols = new Set((this.db.prepare('PRAGMA table_info(items)').all() as { name: string }[]).map((c) => c.name));
    if (!itemCols.has('unknown_sender')) this.db.exec('ALTER TABLE items ADD COLUMN unknown_sender INTEGER NOT NULL DEFAULT 0');
  }

  close(): void {
    this.db.close();
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** Snoozed items whose time has come are reopened before every read. */
  private wakeSnoozed(): void {
    this.db
      .prepare("UPDATE items SET status = 'open', snoozed_until = NULL, updated_at = ? WHERE status = 'snoozed' AND snoozed_until <= ?")
      .run(new Date().toISOString(), new Date().toISOString());
  }

  getItem(id: string): Item | null {
    this.wakeSnoozed();
    const row = this.db.prepare('SELECT * FROM items WHERE id = ?').get(id) as Record<string, any> | undefined;
    return row ? rowToItem(row) : null;
  }

  listItems(filter: { kind?: string; status?: string[]; person?: string; chatId?: number } = {}): Item[] {
    this.wakeSnoozed();
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.kind) {
      where.push('kind = ?');
      args.push(filter.kind);
    }
    if (filter.status?.length) {
      where.push(`status IN (${filter.status.map(() => '?').join(',')})`);
      args.push(...filter.status);
    }
    if (filter.person) {
      where.push('(person LIKE ? OR chat_label LIKE ?)');
      args.push(`%${filter.person}%`, `%${filter.person}%`);
    }
    if (filter.chatId !== undefined) {
      where.push('chat_id = ?');
      args.push(filter.chatId);
    }
    const sql = `SELECT * FROM items ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY COALESCE(when_start, created_at)`;
    return (this.db.prepare(sql).all(...args) as Record<string, any>[]).map(rowToItem);
  }

  /** Open items plus recently closed ones, so the interpreter neither duplicates nor resurrects them. */
  itemsForChat(chatId: number): Item[] {
    const cutoff = new Date(Date.now() - 21 * 86400_000).toISOString();
    return this.listItems({ chatId }).filter(
      (i) => ['open', 'scheduled', 'snoozed'].includes(i.status) || i.updatedAt > cutoff,
    );
  }

  chatGuidsWithItems(): string[] {
    return (this.db.prepare('SELECT DISTINCT chat_guid FROM items WHERE chat_guid IS NOT NULL').all() as { chat_guid: string }[]).map((r) => String(r.chat_guid));
  }

  /** By guid: a chat's ROWID can point at a different chat after Messages rebuilds its database. */
  deleteItemsForChat(chatGuid: string): void {
    this.db.prepare('DELETE FROM items WHERE chat_guid = ?').run(chatGuid);
  }

  /** Someone in the chat is no longer in Contacts: its items are labelled by its people and keep their words out of the brief. */
  markFromStranger(chatGuid: string, chatLabel: string): void {
    this.db.prepare('UPDATE items SET unknown_sender = 1, chat_label = ? WHERE chat_guid = ? AND unknown_sender = 0').run(chatLabel, chatGuid);
  }

  createItem(fields: ItemFields): Item {
    const now = new Date().toISOString();
    const id = 'it_' + crypto.randomBytes(4).toString('hex');
    this.db
      .prepare(
        `INSERT INTO items (id, kind, status, chat_guid, chat_id, chat_label, person, title, detail, when_start, when_end,
          when_text, precision, strength, confidence, suggested_action, missing_details, evidence, unknown_sender, created_at, updated_at)
         VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, fields.kind, fields.chatGuid, fields.chatId, fields.chatLabel, fields.person, fields.title, fields.detail,
        fields.whenStart, fields.whenEnd, fields.whenText, fields.precision, fields.strength, fields.confidence,
        fields.suggestedAction, JSON.stringify(fields.missingDetails), JSON.stringify(fields.evidence), fields.unknownSender ? 1 : 0, now, now,
      );
    return this.getItem(id)!;
  }

  /**
   * Applies interpreter updates. Null fields keep their existing value, so a partial
   * update can't erase a known time or detail; evidence accumulates.
   */
  updateFields(id: string, fields: ItemFields): void {
    const existing = this.getItem(id);
    if (!existing) return;
    const seen = new Set(existing.evidence.map((e) => e.rowid));
    const evidence = [...existing.evidence, ...fields.evidence.filter((e) => !seen.has(e.rowid))];
    const hasTime = fields.whenStart !== null;
    // Once a stranger's, an item keeps its people label (a contact's update would bring back the group's name).
    const chatLabel = existing.unknownSender && !fields.unknownSender ? existing.chatLabel : fields.chatLabel;
    this.db
      .prepare(
        `UPDATE items SET kind = ?, person = ?, title = ?, detail = ?, when_start = ?, when_end = ?, when_text = ?,
          precision = ?, strength = ?, confidence = ?, suggested_action = ?, missing_details = ?, evidence = ?,
          chat_label = ?, unknown_sender = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        fields.kind, fields.person ?? existing.person, fields.title, fields.detail ?? existing.detail,
        hasTime ? fields.whenStart : existing.whenStart, hasTime ? fields.whenEnd : existing.whenEnd,
        fields.whenText ?? existing.whenText, hasTime ? fields.precision : existing.precision,
        fields.strength, fields.confidence, fields.suggestedAction,
        JSON.stringify(fields.missingDetails), JSON.stringify(evidence), chatLabel,
        fields.unknownSender || existing.unknownSender ? 1 : 0, new Date().toISOString(), id,
      );
  }

  setStatus(id: string, status: Status, opts: { note?: string | null; snoozedUntil?: string | null } = {}): Item | null {
    this.db
      .prepare('UPDATE items SET status = ?, note = COALESCE(?, note), snoozed_until = ?, updated_at = ? WHERE id = ?')
      .run(status, opts.note ?? null, opts.snoozedUntil ?? null, new Date().toISOString(), id);
    return this.getItem(id);
  }

  startRun(interpreter: string): number {
    const res = this.db.prepare('INSERT INTO runs (started_at, interpreter) VALUES (?, ?)').run(new Date().toISOString(), interpreter);
    return Number(res.lastInsertRowid);
  }

  finishRun(
    id: number,
    stats: { chats: number; messages: number; created: number; updated: number; closed: number; discardedBatches?: number; skippedChats?: number; error?: string },
  ): void {
    this.db
      .prepare('UPDATE runs SET finished_at = ?, chats = ?, messages = ?, created = ?, updated = ?, closed = ?, discarded = ?, skipped_chats = ?, error = ? WHERE id = ?')
      .run(
        new Date().toISOString(), stats.chats, stats.messages, stats.created, stats.updated, stats.closed,
        stats.discardedBatches ?? 0, stats.skippedChats ?? 0, stats.error ?? null, id,
      );
  }

  lastRun(): Record<string, any> | null {
    return (this.db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get() as Record<string, any>) ?? null;
  }

  lastSuccessfulRun(): Record<string, any> | null {
    return (this.db.prepare('SELECT * FROM runs WHERE error IS NULL AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1').get() as Record<string, any>) ?? null;
  }
}
