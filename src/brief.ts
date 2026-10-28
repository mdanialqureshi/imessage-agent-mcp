import type { Item, Store } from './store.ts';
import { oneLine } from './text.ts';

const ACTIVE = ['open'];
const SAVED_KINDS = new Set(['fact', 'recommendation']);
const LOW_CONFIDENCE = 0.5;


function localDate(d: Date): string {
  return d.toLocaleDateString('en-CA');
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86400_000);
}

/** Untrusted text on one line, without the markup that could fake an item id, emphasis or a link. */
const plain = (text: string) => oneLine(text).replace(/[`*[\]<>]/g, '');

function whenLabel(i: Item): string {
  if (!i.whenStart) return plain(i.whenText ?? '');
  const date = new Date(i.whenStart.length === 10 ? `${i.whenStart}T12:00` : i.whenStart);
  if (Number.isNaN(date.getTime())) return plain(i.whenText ?? i.whenStart);
  const day = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const time = i.precision === 'exact' ? ' ' + date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
  return `${day}${time}${i.whenText ? ` ("${plain(i.whenText)}")` : ''}`;
}


export function formatItem(i: Item, opts: { since?: string; evidence?: number } = {}): string {
  const isNew = opts.since && i.createdAt > opts.since ? '🆕 ' : '';
  // Item text is model output derived from untrusted messages; none of it may add lines.
  const meta = [i.kind, whenLabel(i), i.strength !== 'firm' ? oneLine(i.strength) : '', `${Math.round(i.confidence * 100)}%`]
    .filter(Boolean)
    .join(' · ');
  const lines = [`- ${isNew}**${plain(i.title)}** — ${plain(i.chatLabel)} · ${meta} · \`${i.id}\``];
  if (i.detail) lines.push(`  ${plain(i.detail)}`);
  if (i.missingDetails.length) lines.push(`  Missing: ${plain(i.missingDetails.join(', '))}`);
  for (const e of i.evidence.slice(-(opts.evidence ?? 2))) lines.push(`  > ${plain(e.from)} (${e.date}): ${plain(e.text)}`);
  if (i.suggestedAction !== 'none') lines.push(`  Suggested: ${oneLine(i.suggestedAction).replace('_', ' ')}`);
  return lines.join('\n');
}

/**
 * The digest an agent turns into a notification. Sections are ordered by urgency,
 * and every item carries its id so the agent can call update_item afterwards.
 */
export function buildBrief(store: Store, opts: { since?: string; includeLowConfidence?: boolean; now?: Date } = {}): string {
  const now = opts.now ?? new Date();
  const today = localDate(now);
  const weekOut = localDate(addDays(now, 7));
  const items = store.listItems({ status: ACTIVE });
  const confident = items.filter((i) => i.confidence >= LOW_CONFIDENCE);
  const used = new Set<string>();
  const take = (pred: (i: Item) => boolean) =>
    confident.filter((i) => !used.has(i.id) && pred(i)).map((i) => (used.add(i.id), i));

  const sections: [string, Item[]][] = [
    ['Today & overdue', take((i) => !SAVED_KINDS.has(i.kind) && !!i.whenStart && i.whenStart.slice(0, 10) <= today)],
    ['Replies you owe', take((i) => i.kind === 'reply_owed')],
    ['Needs a decision', take((i) => i.kind === 'invite' || (i.missingDetails.length > 0 && ['plan', 'call'].includes(i.kind)))],
    ['Coming up (next 7 days)', take((i) => !SAVED_KINDS.has(i.kind) && !!i.whenStart && i.whenStart.slice(0, 10) <= weekOut)],
    ['Open loops', take((i) => !SAVED_KINDS.has(i.kind) && !i.whenStart)],
    ['Later', take((i) => !SAVED_KINDS.has(i.kind))],
    ['New details & recommendations', take((i) => SAVED_KINDS.has(i.kind) && (!opts.since || i.createdAt > opts.since))],
  ];
  if (opts.includeLowConfidence) {
    sections.push(['Low confidence (verify before acting)', items.filter((i) => i.confidence < LOW_CONFIDENCE)]);
  }

  const asOf = store.getMeta('last_interpreted_at');
  const header = [
    `# Messages brief — ${now.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' })}`,
    asOf ? `Messages interpreted as of ${new Date(asOf).toLocaleString('en-US')}.` : 'Messages have not been interpreted yet — call refresh.',
    opts.since ? `🆕 = new since ${opts.since}.` : '',
  ].filter(Boolean);
  const body = sections
    .filter(([, list]) => list.length)
    .map(([title, list]) => `## ${title}\n${list.map((i) => formatItem(i, { since: opts.since })).join('\n')}`);
  if (!body.length) body.push('Nothing open. 🎉');
  const footer =
    'Agent notes: ask the user before creating calendar events or reminders, then call update_item ' +
    '(status "scheduled" or "done"). If the user says to ignore something, set status "dismissed".';
  return [...header, '', ...body, '', footer].join('\n');
}
