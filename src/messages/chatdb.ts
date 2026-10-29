import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureStateDir, paths } from '../config.ts';

/** Seconds between the Unix epoch and Apple's 2001-01-01 epoch. */
const APPLE_EPOCH_MS = 978307200000;

const TAPBACKS: Record<number, string> = {
  2000: '❤️',
  2001: '👍',
  2002: '👎',
  2003: '😂',
  2004: '‼️',
  2005: '❓',
  2006: '(emoji)',
  2007: '(sticker)',
};

export interface Chat {
  id: number;
  guid: string;
  identifier: string;
  displayName: string | null;
  isGroup: boolean;
  handles: string[];
}

export interface Message {
  rowid: number;
  guid: string;
  chatId: number;
  date: Date;
  fromMe: boolean;
  /** Phone/email of the sender; null when the message is from me. */
  handle: string | null;
  text: string | null;
  reaction: { emoji: string; targetGuid: string; removed: boolean } | null;
  replyToGuid: string | null;
  hasAttachments: boolean;
  isAudio: boolean;
  edited: boolean;
  unsent: boolean;
}

/**
 * Message text has lived in `attributedBody` (an NSAttributedString in Apple's
 * typedstream format) since macOS Ventura. The string follows the `NSString`
 * class name, prefixed with a typedstream-encoded length.
 */
export function decodeAttributedBody(blob: Uint8Array | null | undefined): string | null {
  if (!blob) return null;
  const buf = Buffer.from(blob);
  const marker = buf.indexOf('NSString');
  if (marker < 0) return null;
  let i = marker + 'NSString'.length + 5;
  if (i >= buf.length) return null;
  let length = buf[i];
  i += 1;
  // A truncated or malformed blob decodes to nothing rather than failing the whole query.
  if (length === 0x81) {
    if (i + 2 > buf.length) return null;
    length = buf.readUInt16LE(i);
    i += 2;
  } else if (length === 0x82) {
    if (i + 4 > buf.length) return null;
    length = buf.readUInt32LE(i);
    i += 4;
  }
  if (i + length > buf.length) return null;
  return buf.subarray(i, i + length).toString('utf8');
}

export function appleDateToJs(msSince2001: number | null): Date | null {
  if (msSince2001 == null || msSince2001 === 0) return null;
  return new Date(msSince2001 + APPLE_EPOCH_MS);
}

/** Removes snapshot and half-made reader copies left by a crash; live ones are seconds old. */
export function sweepSnapshots(maxAgeMs = 10 * 60_000): void {
  if (!fs.existsSync(paths.stateDir)) return;
  for (const name of fs.readdirSync(paths.stateDir)) {
    if (!name.startsWith('snapshot') && !name.startsWith('mirror-new-')) continue;
    const dir = path.join(paths.stateDir, name);
    if (Date.now() - fs.statSync(dir).mtimeMs > maxAgeMs) fs.rmSync(dir, { recursive: true, force: true });
  }
}

export class ChatDb {
  private db: DatabaseSync;
  private columns: Set<string>;
  private chatCache = new Map<number, Chat>();
  private cleanupDir: string | null = null;

  /**
   * Opens chat.db read-only. WAL mode lets us read while Messages.app writes; if the
   * live file can't be opened that way, falls back to a snapshot copy.
   */
  static open(source = paths.chatDb): ChatDb {
    try {
      const db = new DatabaseSync(source, { readOnly: !paths.mirror });
      db.prepare('SELECT 1 FROM message LIMIT 1').get();
      return new ChatDb(db);
    } catch {
      try {
        return ChatDb.openSnapshot(source);
      } catch (err: any) {
        throw new Error(
          `Cannot read ${source} (${err.code ?? err.message}). From a terminal, give the terminal app Full Disk ` +
            `Access; the background service instead uses its reader (see \`node src/cli.ts doctor\`).`,
        );
      }
    }
  }

  /** A private copy of chat.db, deleted again on close(). */
  static openSnapshot(source = paths.chatDb): ChatDb {
    ensureStateDir();
    sweepSnapshots();
    const snapshotDir = fs.mkdtempSync(path.join(paths.stateDir, 'snapshot-'));
    try {
      const target = path.join(snapshotDir, 'chat.db');
      for (const suffix of ['', '-wal', '-shm']) {
        if (fs.existsSync(source + suffix)) {
          fs.copyFileSync(source + suffix, target + suffix);
          fs.chmodSync(target + suffix, 0o600);
        }
      }
      const db = new ChatDb(new DatabaseSync(target));
      db.cleanupDir = snapshotDir;
      return db;
    } catch (err) {
      fs.rmSync(snapshotDir, { recursive: true, force: true });
      throw err;
    }
  }

  constructor(db: DatabaseSync) {
    this.db = db;
    const cols = this.db.prepare('PRAGMA table_info(message)').all() as { name: string }[];
    this.columns = new Set(cols.map((c) => c.name));
  }

  close(): void {
    this.db.close();
    if (this.cleanupDir) fs.rmSync(this.cleanupDir, { recursive: true, force: true });
  }

  private optional(column: string, expr = `m.${column}`, fallback = 'NULL'): string {
    return this.columns.has(column) ? expr : fallback;
  }

  private messageSelect(): string {
    return `
      SELECT m.ROWID AS rowid, m.guid, cmj.chat_id AS chatId,
        CAST(m.date / 1000000 AS INTEGER) AS dateMs,
        m.is_from_me AS fromMe, h.id AS handle, m.text, m.attributedBody,
        m.associated_message_guid AS assocGuid, m.associated_message_type AS assocType,
        ${this.optional('associated_message_emoji')} AS assocEmoji,
        ${this.optional('thread_originator_guid')} AS replyToGuid,
        m.cache_has_attachments AS hasAttachments,
        ${this.optional('is_audio_message')} AS isAudio,
        ${this.optional('date_edited', 'CAST(m.date_edited / 1000000 AS INTEGER)')} AS editedMs,
        ${this.optional('date_retracted', 'CAST(m.date_retracted / 1000000 AS INTEGER)')} AS retractedMs
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE m.item_type = 0`;
  }

  private toMessage(row: Record<string, any>): Message {
    const assocType = Number(row.assocType ?? 0);
    let reaction: Message['reaction'] = null;
    if (assocType >= 2000 && assocType < 4000 && row.assocGuid) {
      const base = assocType >= 3000 ? assocType - 1000 : assocType;
      const emoji = base === 2006 && row.assocEmoji ? String(row.assocEmoji) : (TAPBACKS[base] ?? '(reaction)');
      reaction = {
        emoji,
        targetGuid: String(row.assocGuid).replace(/^.*\//, '').replace(/^bp:/, ''),
        removed: assocType >= 3000,
      };
    }
    const text = (row.text as string | null) || decodeAttributedBody(row.attributedBody);
    return {
      rowid: Number(row.rowid),
      guid: String(row.guid),
      chatId: Number(row.chatId),
      date: appleDateToJs(Number(row.dateMs)) ?? new Date(0),
      fromMe: Number(row.fromMe) === 1,
      handle: row.handle ?? null,
      text: text ? text.replace(/￼/g, '').trim() || null : null,
      reaction,
      replyToGuid: row.replyToGuid || null,
      hasAttachments: Number(row.hasAttachments) === 1,
      isAudio: Number(row.isAudio) === 1,
      edited: Number(row.editedMs ?? 0) > 0,
      unsent: Number(row.retractedMs ?? 0) > 0,
    };
  }

  /** Messages with ROWID above `afterRowid` and newer than `since` (in one chat, if given), oldest first. */
  newMessages(afterRowid: number, since: Date, chatId?: number): Message[] {
    const sinceNs = BigInt(since.getTime() - APPLE_EPOCH_MS) * 1000000n;
    const rows = this.db
      .prepare(`${this.messageSelect()} AND m.ROWID > ? AND m.date > ?${chatId === undefined ? '' : ' AND cmj.chat_id = ?'} ORDER BY m.ROWID`)
      .all(afterRowid, sinceNs, ...(chatId === undefined ? [] : [chatId])) as Record<string, any>[];
    return rows.map((r) => this.toMessage(r));
  }

  /** The `limit` messages in a chat before `beforeRowid`, oldest first. */
  messagesBefore(chatId: number, beforeRowid: number, limit: number): Message[] {
    const rows = this.db
      .prepare(`${this.messageSelect()} AND cmj.chat_id = ? AND m.ROWID < ? ORDER BY m.ROWID DESC LIMIT ?`)
      .all(chatId, beforeRowid, limit) as Record<string, any>[];
    return rows.map((r) => this.toMessage(r)).reverse();
  }

  messagesInChat(chatId: number, limit: number, since?: Date): Message[] {
    const sinceNs = since ? BigInt(since.getTime() - APPLE_EPOCH_MS) * 1000000n : 0n;
    const rows = this.db
      .prepare(`${this.messageSelect()} AND cmj.chat_id = ? AND m.date > ? ORDER BY m.ROWID DESC LIMIT ?`)
      .all(chatId, sinceNs, limit) as Record<string, any>[];
    return rows.map((r) => this.toMessage(r)).reverse();
  }

  messagesSince(since: Date, limit: number): Message[] {
    const sinceNs = BigInt(since.getTime() - APPLE_EPOCH_MS) * 1000000n;
    const rows = this.db
      .prepare(`${this.messageSelect()} AND m.date > ? ORDER BY m.ROWID DESC LIMIT ?`)
      .all(sinceNs, limit) as Record<string, any>[];
    return rows.map((r) => this.toMessage(r)).reverse();
  }

  messageByGuid(guid: string, chatId: number): Message | null {
    const row = this.db.prepare(`${this.messageSelect()} AND m.guid = ? AND cmj.chat_id = ?`).get(guid, chatId) as
      | Record<string, any>
      | undefined;
    return row ? this.toMessage(row) : null;
  }

  /** Latest non-reaction message per chat, for chats active since `since`. */
  lastMessages(since: Date): Message[] {
    const sinceNs = BigInt(since.getTime() - APPLE_EPOCH_MS) * 1000000n;
    const rows = this.db
      .prepare(
        `${this.messageSelect()} AND m.ROWID IN (
          SELECT MAX(m2.ROWID) FROM message m2
          JOIN chat_message_join c2 ON c2.message_id = m2.ROWID
          WHERE m2.item_type = 0 AND COALESCE(m2.associated_message_type, 0) = 0 AND m2.date > ?
          GROUP BY c2.chat_id)`,
      )
      .all(sinceNs) as Record<string, any>[];
    return rows.map((r) => this.toMessage(r));
  }

  chat(chatId: number): Chat | null {
    const cached = this.chatCache.get(chatId);
    if (cached) return cached;
    const row = this.db
      .prepare('SELECT ROWID AS id, guid, chat_identifier AS identifier, display_name AS displayName, style FROM chat WHERE ROWID = ?')
      .get(chatId) as Record<string, any> | undefined;
    if (!row) return null;
    const handles = (
      this.db
        .prepare('SELECT h.id FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id WHERE chj.chat_id = ?')
        .all(chatId) as { id: string }[]
    ).map((h) => h.id);
    const chat: Chat = {
      id: Number(row.id),
      guid: String(row.guid),
      identifier: String(row.identifier),
      displayName: row.displayName || null,
      isGroup: Number(row.style) === 43 || handles.length > 1,
      handles,
    };
    this.chatCache.set(chatId, chat);
    return chat;
  }

  allChats(): Chat[] {
    const ids = this.db.prepare('SELECT ROWID AS id FROM chat').all() as { id: number }[];
    return ids.map((r) => this.chat(Number(r.id))).filter((c): c is Chat => c !== null);
  }

  maxRowid(): number {
    const row = this.db.prepare('SELECT MAX(ROWID) AS max FROM message').get() as { max: number | null };
    return Number(row.max ?? 0);
  }
}
