import fs from 'node:fs';
import path from 'node:path';
import { type Config, loadConfig, paths } from '../config.ts';
import { ChatDb, type Message } from '../messages/chatdb.ts';
import { Contacts } from '../messages/contacts.ts';
import { Conversations, displayText, formatTime, type Window } from '../messages/conversations.ts';
import { type Evidence, type ItemFields, KINDS, type Kind, Store } from '../store.ts';
import { buildPrompt, type PromptChat } from './prompt.ts';
import { interpreter, type RawOp } from './runners.ts';

/** Rough per-call transcript budget; large backlogs are split across several interpreter calls. */
const BATCH_CHARS = 60_000;

export interface RunResult {
  chats: number;
  messages: number;
  created: number;
  updated: number;
  closed: number;
  skippedOps: number;
  prompts?: string[];
}

function acquireLock(): () => void {
  const file = path.join(paths.stateDir, 'interpret.lock');
  try {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        throw new Error(`Interpretation already running (pid ${pid})`);
      } catch (err: any) {
        if (err.code !== 'ESRCH') throw err;
      }
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }
  fs.writeFileSync(file, String(process.pid));
  return () => fs.rmSync(file, { force: true });
}

function batches(windows: Window[], render: (w: Window) => string): Window[][] {
  const out: Window[][] = [];
  let current: Window[] = [];
  let size = 0;
  for (const w of windows) {
    const len = render(w).length;
    if (current.length && size + len > BATCH_CHARS) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(w);
    size += len;
  }
  if (current.length) out.push(current);
  return out;
}

function toFields(op: RawOp, w: Window, conv: Conversations): ItemFields {
  const byRowid = new Map<number, Message>([...w.context, ...w.fresh].map((m) => [m.rowid, m]));
  const evidence: Evidence[] = op.evidence
    .map((id) => byRowid.get(id))
    .filter((m): m is Message => m !== undefined)
    .map((m) => ({
      rowid: m.rowid,
      from: conv.sender(m),
      date: formatTime(m.date),
      text: m.reaction ? `reacted ${m.reaction.emoji}` : displayText(m.text),
    }));
  return {
    kind: op.kind as Kind,
    chatGuid: w.chat.guid,
    chatId: w.chat.id,
    chatLabel: w.label,
    person: op.person,
    title: op.title,
    detail: op.detail,
    whenStart: op.when_start,
    whenEnd: op.when_end,
    whenText: op.when_text,
    precision: op.precision,
    strength: op.strength,
    confidence: Math.max(0, Math.min(1, op.confidence)),
    suggestedAction: op.suggested_action,
    missingDetails: op.missing_details,
    evidence,
  };
}

function applyOps(store: Store, ops: RawOp[], windows: Map<string, Window>, conv: Conversations, result: RunResult): void {
  for (const op of ops) {
    const w = windows.get(op.chat_ref);
    if (!w || !(KINDS as readonly string[]).includes(op.kind)) {
      result.skippedOps++;
      continue;
    }
    const fields = toFields(op, w, conv);
    const existing = op.item_id ? store.getItem(op.item_id) : null;
    if (op.op !== 'create') {
      if (!existing || existing.chatId !== w.chat.id) {
        result.skippedOps++;
        continue;
      }
      if (op.op === 'update') {
        store.updateFields(existing.id, fields);
        result.updated++;
      } else {
        store.setStatus(existing.id, op.op === 'done' ? 'done' : 'cancelled', { note: op.reason });
        result.closed++;
      }
      continue;
    }
    // Guard against the model re-creating an item it was shown.
    const duplicate = store
      .itemsForChat(w.chat.id)
      .find((i) => i.kind === fields.kind && i.title.trim().toLowerCase() === fields.title.trim().toLowerCase());
    if (duplicate) {
      if (['open', 'scheduled', 'snoozed'].includes(duplicate.status)) {
        store.updateFields(duplicate.id, fields);
        result.updated++;
      } else result.skippedOps++;
      continue;
    }
    store.createItem(fields);
    result.created++;
  }
}

/**
 * Reads messages that arrived since the last run (plus 1:1 chats with an unanswered
 * message ageing past the threshold), asks the interpreter what changed, and applies it.
 */
export async function interpretNow(
  opts: { dryRun?: boolean; config?: Config; now?: Date; runner?: (prompt: string) => Promise<RawOp[]> } = {},
): Promise<RunResult> {
  const config = opts.config ?? loadConfig();
  const now = opts.now ?? new Date();
  const release = acquireLock();
  const store = Store.open();
  const db = ChatDb.open();
  const result: RunResult = { chats: 0, messages: 0, created: 0, updated: 0, closed: 0, skippedOps: 0 };
  const runId = opts.dryRun ? null : store.startRun(config.interpreter);
  try {
    const conv = new Conversations(db, Contacts.load(), config);
    const lastRowid = Number(store.getMeta('last_rowid') ?? 0);
    const lookbackDays = lastRowid ? 30 : config.firstRunLookbackDays;
    const fresh = db.newMessages(lastRowid, new Date(now.getTime() - lookbackDays * 86400_000));
    const newWindows = conv.windowsForNew(fresh);
    const replyChecked = new Map<number, number>(Object.entries(JSON.parse(store.getMeta('reply_checked') ?? '{}')).map(([k, v]) => [Number(k), Number(v)]));
    const awaiting = conv.windowsAwaitingReply(now, replyChecked, new Set(newWindows.map((w) => w.chat.id)));
    const all = [...newWindows, ...awaiting];
    all.forEach((w, i) => (w.ref = `C${i + 1}`));
    result.chats = all.length;
    result.messages = all.reduce((n, w) => n + w.fresh.length, 0);

    const run = opts.runner ?? interpreter(config);
    const render = (w: Window) => conv.render(w);
    for (const batch of batches(all, render)) {
      const chats: PromptChat[] = batch.map((w) => ({ ref: w.ref, transcript: render(w), items: store.itemsForChat(w.chat.id) }));
      const prompt = buildPrompt(chats, now, config.replyOwedAfterHours);
      if (opts.dryRun) {
        (result.prompts ??= []).push(prompt);
        continue;
      }
      const ops = await run(prompt);
      applyOps(store, ops, new Map(batch.map((w) => [w.ref, w])), conv, result);
    }

    if (!opts.dryRun) {
      store.setMeta('last_rowid', String(Math.max(lastRowid, db.maxRowid())));
      for (const w of awaiting) replyChecked.set(w.chat.id, w.fresh[0].rowid);
      store.setMeta('reply_checked', JSON.stringify(Object.fromEntries(replyChecked)));
      store.setMeta('last_interpreted_at', now.toISOString());
      store.finishRun(runId!, result);
    }
    return result;
  } catch (err: any) {
    if (runId) store.finishRun(runId, { ...result, error: String(err.message ?? err) });
    throw err;
  } finally {
    db.close();
    store.close();
    release();
  }
}
