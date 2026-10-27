import fs from 'node:fs';
import path from 'node:path';
import { type Config, loadConfig, paths } from '../config.ts';
import { ChatDb, type Message } from '../messages/chatdb.ts';
import { Contacts } from '../messages/contacts.ts';
import { Conversations, displayText, formatTime, type Window } from '../messages/conversations.ts';
import { type Evidence, type ItemFields, KINDS, type Kind, Store } from '../store.ts';
import { clip, oneLine } from '../text.ts';
import { buildPrompt, type PromptChat } from './prompt.ts';
import { InterpreterUnavailable, interpreter, type RawOp, ToolUseAttempt } from './runners.ts';

/** Rough per-call transcript budget; large backlogs are split across several interpreter calls. */
const BATCH_CHARS = 60_000;
/** A chat whose batch fails this many runs in a row is skipped, so it can't stall every run. */
const MAX_CHAT_FAILURES = 3;

const OPS = new Set(['create', 'update', 'done', 'cancel']);
const PRECISIONS = new Set(['exact', 'part_of_day', 'day', 'week', 'none']);
const STRENGTHS = new Set(['firm', 'tentative', 'soft']);
const ACTIONS = new Set(['calendar_event', 'reminder', 'reply', 'call', 'check_in', 'pay', 'save', 'none']);
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.slice(0, max) : null);

/**
 * Validates one model op against the output schema. The schema is enforced for codex and
 * claude's structured output, but not for claude's plain-text fallback.
 */
function validOp(raw: unknown): RawOp | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const title = str(o.title, 200);
  if (!OPS.has(o.op as string) || !(KINDS as readonly string[]).includes(o.kind as string) || !title || typeof o.chat_ref !== 'string') return null;
  return {
    op: o.op as RawOp['op'],
    item_id: str(o.item_id, 40),
    chat_ref: o.chat_ref,
    kind: o.kind as string,
    title,
    detail: str(o.detail, 1000),
    person: str(o.person, 200),
    when_start: str(o.when_start, 40),
    when_end: str(o.when_end, 40),
    when_text: str(o.when_text, 200),
    precision: PRECISIONS.has(o.precision as string) ? (o.precision as string) : 'none',
    strength: STRENGTHS.has(o.strength as string) ? (o.strength as string) : 'soft',
    confidence: typeof o.confidence === 'number' && Number.isFinite(o.confidence) ? o.confidence : 0,
    suggested_action: ACTIONS.has(o.suggested_action as string) ? (o.suggested_action as string) : 'none',
    missing_details: Array.isArray(o.missing_details) ? o.missing_details.filter((d) => typeof d === 'string').slice(0, 10).map((d) => d.slice(0, 50)) : [],
    evidence: Array.isArray(o.evidence) ? o.evidence.filter((n) => Number.isInteger(n)).slice(0, 50) : [],
    reason: str(o.reason, 500) ?? '',
  };
}

export interface RunResult {
  chats: number;
  messages: number;
  created: number;
  updated: number;
  closed: number;
  skippedOps: number;
  /** Batches whose output was thrown away because the model tried to use a tool. */
  discardedBatches: number;
  /** Batches that errored; their chats are retried next run, up to MAX_CHAT_FAILURES. */
  failedBatches: number;
  /** Chats skipped after failing MAX_CHAT_FAILURES runs in a row. */
  skippedChats: number;
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
  fs.writeFileSync(file, String(process.pid), { mode: 0o600 });
  return () => fs.rmSync(file, { force: true });
}

/**
 * Groups chats into interpreter calls. A chat with anyone not in Contacts is interpreted
 * alone, so text from a stranger never shares a prompt with other people's conversations.
 */
function batches(windows: Window[], transcripts: Map<string, string>, isolate: (w: Window) => boolean): Window[][] {
  const out: Window[][] = windows.filter(isolate).map((w) => [w]);
  let current: Window[] = [];
  let size = 0;
  for (const w of windows.filter((w) => !isolate(w))) {
    const len = transcripts.get(w.ref)!.length;
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
      text: m.reaction ? `reacted ${displayText(m.reaction.emoji)}` : displayText(m.text),
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

function applyOps(store: Store, rawOps: unknown[], windows: Map<string, Window>, conv: Conversations, result: RunResult): void {
  for (const raw of rawOps) {
    const op = validOp(raw);
    const w = op && windows.get(op.chat_ref);
    if (!op || !w) {
      result.skippedOps++;
      continue;
    }
    const fields = toFields(op, w, conv);
    // Every change must cite messages from its own chat; closing an item needs a new one.
    const freshRowids = new Set(w.fresh.map((m) => m.rowid));
    const citesFresh = fields.evidence.some((e) => freshRowids.has(e.rowid));
    if (!fields.evidence.length || ((op.op === 'done' || op.op === 'cancel') && !citesFresh)) {
      result.skippedOps++;
      continue;
    }
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
  let dbOpen = true;
  let lastError: unknown = null;
  const result: RunResult = { chats: 0, messages: 0, created: 0, updated: 0, closed: 0, skippedOps: 0, discardedBatches: 0, failedBatches: 0, skippedChats: 0 };
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

    // Everything needed from chat.db is read up front, so it's closed (and any snapshot
    // deleted) before the interpreter runs, which can take minutes.
    const transcripts = new Map(all.map((w) => [w.ref, conv.render(w)]));
    const isolated = new Set(all.filter((w) => conv.hasUnknownSender(w.chat)).map((w) => w.ref));
    const maxRowid = db.maxRowid();
    db.close();
    dbOpen = false;

    const failures: Record<string, number> = JSON.parse(store.getMeta('chat_failures') ?? '{}');
    const runnable = all.filter((w) => {
      if ((failures[w.chat.id] ?? 0) < MAX_CHAT_FAILURES) return true;
      delete failures[w.chat.id];
      result.skippedChats++;
      return false;
    });
    const failedChats: number[] = [];
    let succeeded = 0;

    const run = opts.runner ?? interpreter(config);
    for (const batch of batches(runnable, transcripts, (w) => isolated.has(w.ref))) {
      const chats: PromptChat[] = batch.map((w) => ({ ref: w.ref, transcript: transcripts.get(w.ref)!, items: store.itemsForChat(w.chat.id) }));
      const prompt = buildPrompt(chats, now, config.replyOwedAfterHours);
      if (opts.dryRun) {
        (result.prompts ??= []).push(prompt);
        continue;
      }
      let ops: unknown[];
      try {
        ops = await run(prompt);
        if (!Array.isArray(ops)) throw new Error('Interpreter returned no ops array');
      } catch (err) {
        // A hostile message must not block every future run, so only this batch is dropped.
        // So is a stranger's chat whose output is unusable. An unavailable interpreter
        // (signed out, offline) is retried instead, so nothing is lost to an outage.
        const strangerOnly = batch.every((w) => isolated.has(w.ref));
        if (err instanceof ToolUseAttempt || (strangerOnly && !(err instanceof InterpreterUnavailable))) {
          result.discardedBatches++;
          continue;
        }
        result.failedBatches++;
        failedChats.push(...batch.map((w) => w.chat.id));
        lastError = err;
        continue;
      }
      succeeded++;
      for (const w of batch) delete failures[w.chat.id];
      applyOps(store, ops, new Map(batch.map((w) => [w.ref, w])), conv, result);
    }

    if (result.failedBatches) {
      // Every batch failing means the interpreter itself is down (signed out, offline):
      // retry everything next run. Otherwise count strikes against the failing chats.
      if (succeeded) for (const id of failedChats) failures[id] = (failures[id] ?? 0) + 1;
      store.setMeta('chat_failures', JSON.stringify(failures));
      throw lastError;
    }
    store.setMeta('chat_failures', JSON.stringify(failures));

    if (!opts.dryRun) {
      store.setMeta('last_rowid', String(Math.max(lastRowid, maxRowid)));
      for (const w of awaiting) replyChecked.set(w.chat.id, w.fresh[0].rowid);
      store.setMeta('reply_checked', JSON.stringify(Object.fromEntries(replyChecked)));
      store.setMeta('last_interpreted_at', now.toISOString());
      store.finishRun(runId!, result);
    }
    return result;
  } catch (err: any) {
    // Stored errors are shown to agents; keep them short and on one line.
    if (runId) store.finishRun(runId, { ...result, error: clip(oneLine(String(err.message ?? err)), 300) });
    throw err;
  } finally {
    if (dbOpen) db.close();
    store.close();
    release();
  }
}
