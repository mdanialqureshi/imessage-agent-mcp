import type { Config } from '../config.ts';
import type { Chat, ChatDb, Message } from './chatdb.ts';
import { clip, oneLine } from '../text.ts';
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

const VERIFICATION_CODE = /\b(code|passcode|verification|verify|OTP|one[- ]time|2FA|security)\b/i;

export function isFilteredText(text: string): boolean {
  return VERIFICATION_CODE.test(text) && /\b\d{4,8}\b/.test(text);
}

/**
 * Message text as safe single-line display: verification codes masked, and newlines
 * collapsed so a message can't forge transcript lines ("#123 … Me: …") or brief sections.
 */
export function displayText(text: string | null): string {
  if (!text) return '';
  if (isFilteredText(text)) return '[filtered: verification code]';
  return clip(oneLine(text, ' ⏎ '), MAX_MESSAGE_CHARS);
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

  /** True when anyone in the chat isn't a saved contact. */
  hasUnknownSender(chat: Chat): boolean {
    const others = chat.handles.length ? chat.handles : [chat.identifier];
    return others.some((h) => this.contacts.name(h) === null);
  }

  /** Group names are set by other people, so they get the same one-line treatment as messages. */
  chatLabel(chat: Chat): string {
    if (chat.displayName) return displayText(chat.displayName);
    const names = chat.handles.map((h) => displayText(this.contacts.label(h)));
    return names.join(', ') || chat.identifier;
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
