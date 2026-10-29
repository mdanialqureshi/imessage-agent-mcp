import type { Config } from '../config.ts';
import type { Chat, ChatDb, Message } from './chatdb.ts';
import { clip, oneLine, visible } from '../text.ts';
import { type Contacts, handleKey, isShortCode } from './contacts.ts';

export interface Window {
  /** Short reference the model uses to point back at this chat, e.g. "C3". */
  ref: string;
  chat: Chat;
  label: string;
  context: Message[];
  fresh: Message[];
  /** Why this chat is included: new messages, or an unanswered message ageing past the threshold. */
  reason: 'new_messages' | 'awaiting_reply';
}

/** Per-message and per-window caps, so one huge message can't break interpretation. */
const MAX_MESSAGE_CHARS = 2000;
const MAX_WINDOW_CHARS = 40_000;

const VERIFICATION_CODE =
  /\b(codes?|passcode|password|verification|verify|OTP|one[- ]time|2FA|MFA|security|log[- ]?in|sign[- ]?in|authenticat\w*)\b/i;
/** Only in capitals: "pin the meeting" is a verb. */
const PIN = /\bPIN\b/;
/** The same words in other common languages (no \b: it only knows ASCII letters). */
const VERIFICATION_CODE_INTL =
  /c[oó]digo|verificaci[oó]n|contraseña|senha|bestätigung|sicherheitscode|kennwort|mot de passe|vérification|codice|verifica|weryfikac|код|验证码|驗證碼|認証|確認コード|인증/i;
/** How close (in characters) one of those words must be to the digits. */
const NEAR = 40;

/**
 * Digits, maybe split by dashes or slashes ("48-29-13"), or by spaces between groups of three or
 * more ("123 456", not a time like "10 30").
 */
const DIGIT_RUNS = /\d+(?:[-/]\d+|\s\d{3,})*/g;
/** Not codes: dates (2026-11-03, 11-14-2026, 11/14/2026) and local phone numbers (555-0123). */
const NOT_A_CODE = /^(?:\d{4}([-/])\d{1,2}\1\d{1,2}|\d{1,2}([-/])\d{1,2}\2\d{4}|\d{3}[-\s]\d{4})$/;

/**
 * A code: 4–8 digits with a code word near them. Invisible characters are removed first, so they
 * can't split the word from the digits ("c\u200bode").
 */
export function isFilteredText(raw: string): boolean {
  const text = visible(raw);
  for (const m of text.matchAll(DIGIT_RUNS)) {
    const digits = m[0].replace(/\D/g, '').length;
    if (digits < 4 || digits > 8 || NOT_A_CODE.test(m[0])) continue;
    const around = text.slice(Math.max(0, m.index - NEAR), m.index + m[0].length + NEAR);
    if (VERIFICATION_CODE.test(around) || PIN.test(around) || VERIFICATION_CODE_INTL.test(around)) return true;
  }
  return false;
}

/**
 * Message text as safe single-line display: verification codes masked, and newlines
 * collapsed so a message can't forge transcript lines ("#123 … Me: …") or brief sections.
 */
export function displayText(text: string | null): string {
  if (!text) return '';
  if (isFilteredText(text)) return '[filtered: verification code]';
  // Cut first, so a huge message costs no more to clean up than a long one.
  return clip(oneLine(text.slice(0, MAX_MESSAGE_CHARS * 2), ' ⏎ '), MAX_MESSAGE_CHARS);
}

export class Conversations {
  private db: ChatDb;
  private contacts: Contacts;
  private config: Config;
  private privateKeys: Set<string>;
  private privateNames: Set<string>;

  constructor(db: ChatDb, contacts: Contacts, config: Config) {
    this.db = db;
    this.contacts = contacts;
    this.config = config;
    this.privateKeys = new Set(config.privateContacts.map(handleKey).filter(Boolean));
    this.privateNames = new Set(config.privateContacts.map((c) => c.trim().toLowerCase()));
  }

  /** Private contacts and short-code senders are never read past this point. */
  isExcluded(chat: Chat): boolean {
    const others = chat.handles.length ? chat.handles : [chat.identifier];
    if (this.config.skipShortCodes && others.every(isShortCode)) return true;
    return others.some((h) => {
      const name = this.contacts.name(h)?.toLowerCase();
      return this.privateKeys.has(handleKey(h)) || (name !== undefined && this.privateNames.has(name));
    });
  }

  /** True when anyone in the chat isn't a saved contact (everyone, without Contacts). Such a chat is interpreted alone. */
  hasUnknownSender(chat: Chat): boolean {
    const others = chat.handles.length ? chat.handles : [chat.identifier];
    return others.some((h) => this.contacts.name(h) === null);
  }

  /**
   * True when someone in the chat isn't in Contacts, so their words are kept out of the brief.
   * Without Contacts (a missing or empty copy) everyone would count, so nobody does.
   */
  fromStranger(chat: Chat): boolean {
    return this.contacts.size > 0 && this.hasUnknownSender(chat);
  }

  /** Group names are set by other people, so they get the same one-line treatment as messages. */
  chatLabel(chat: Chat): string {
    return chat.displayName ? displayText(chat.displayName) : this.peopleLabel(chat);
  }

  /** The chat's people by name or number, never a name someone else chose for the group. */
  peopleLabel(chat: Chat): string {
    const names = chat.handles.map((h) => displayText(this.contacts.label(h)));
    return names.join(', ') || displayText(chat.identifier);
  }

  sender(m: Message): string {
    return m.fromMe ? 'Me' : displayText(this.contacts.label(m.handle));
  }

  /** Chats with new messages, each with earlier context so replies make sense. */
  windowsForNew(messages: Message[]): Window[] {
    const byChat = new Map<number, Message[]>();
    for (const m of messages) {
      const list = byChat.get(m.chatId) ?? [];
      list.push(m);
      byChat.set(m.chatId, list);
    }
    const windows: Window[] = [];
    for (const [chatId, fresh] of byChat) {
      const chat = this.db.chat(chatId);
      if (!chat || this.isExcluded(chat)) continue;
      const kept = fresh.slice(-200);
      const context = this.db.messagesBefore(chatId, kept[0].rowid, this.config.contextMessages);
      windows.push({ ref: '', chat, label: this.chatLabel(chat), context, fresh: kept, reason: 'new_messages' });
    }
    return windows;
  }

  /**
   * 1:1 chats whose latest message is from the other person and has gone unanswered
   * longer than `replyOwedAfterHours`. These need a look even with no new messages.
   */
  windowsAwaitingReply(now: Date, alreadyChecked: Map<number, number>, skipChats: Set<number>): Window[] {
    const threshold = now.getTime() - this.config.replyOwedAfterHours * 3600_000;
    const oldest = new Date(now.getTime() - 7 * 86400_000);
    const windows: Window[] = [];
    for (const last of this.db.lastMessages(oldest)) {
      if (last.fromMe || last.date.getTime() > threshold) continue;
      if (skipChats.has(last.chatId) || alreadyChecked.get(last.chatId) === last.rowid) continue;
      const chat = this.db.chat(last.chatId);
      if (!chat || chat.isGroup || this.isExcluded(chat)) continue;
      const context = this.db.messagesBefore(chat.id, last.rowid, this.config.contextMessages);
      windows.push({ ref: '', chat, label: this.chatLabel(chat), context, fresh: [last], reason: 'awaiting_reply' });
    }
    return windows;
  }

  /** Renders a window as numbered, attributed lines the model can cite (#rowid). */
  render(w: Window): string {
    const all = [...w.context, ...w.fresh];
    const byGuid = new Map(all.map((m) => [m.guid, m]));
    const people = w.chat.handles.map((h) => displayText(this.contacts.label(h))).join(', ');
    const lines = [
      `### ${w.ref} — ${w.label}${w.chat.isGroup ? ` (group: ${people})` : ''}`,
      w.reason === 'awaiting_reply' ? '(included because their last message has not been answered)' : '',
    ].filter(Boolean);
    let context = w.context.map((m) => this.line(m, byGuid));
    let fresh = w.fresh.map((m) => this.line(m, byGuid));
    const size = () => [...context, ...fresh].reduce((n, l) => n + l.length + 1, 0);
    while (context.length && size() > MAX_WINDOW_CHARS) context = context.slice(1);
    while (fresh.length > 1 && size() > MAX_WINDOW_CHARS) fresh = fresh.slice(1);
    if (context.length) lines.push('-- earlier context --', ...context);
    lines.push(w.reason === 'awaiting_reply' ? '-- latest message --' : '-- new since last check --', ...fresh);
    return lines.join('\n');
  }

  private line(m: Message, byGuid: Map<string, Message>): string {
    const who = this.sender(m);
    const when = formatTime(m.date);
    if (m.reaction) {
      // Only quote targets from this chat: the sender controls the GUID, and another chat may be private.
      const target = byGuid.get(m.reaction.targetGuid) ?? this.db.messageByGuid(m.reaction.targetGuid, m.chatId);
      const ref = target ? (byGuid.has(target.guid) ? `#${target.rowid}` : `"${clip(displayText(target.text), 80)}"`) : 'a message';
      const verb = m.reaction.removed ? 'removed reaction' : 'reacted';
      return `#${m.rowid} ${when} ${who} ${verb} ${displayText(m.reaction.emoji)} to ${ref}`;
    }
    let body = displayText(m.text);
    if (m.unsent) body = '[unsent a message]';
    if (m.isAudio) body = body ? `[voice message] ${body}` : '[voice message]';
    else if (m.hasAttachments) body = body ? `${body} [attachment]` : '[attachment]';
    const reply = m.replyToGuid && byGuid.get(m.replyToGuid) ? ` (replying to #${byGuid.get(m.replyToGuid)!.rowid})` : '';
    return `#${m.rowid} ${when} ${who}${reply}: ${body}${m.edited ? ' (edited)' : ''}`;
  }
}

export function formatTime(d: Date): string {
  return d.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
