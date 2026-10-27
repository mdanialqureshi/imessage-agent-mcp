import { KINDS, type Item } from '../store.ts';

export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ops'],
  properties: {
    ops: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'op', 'item_id', 'chat_ref', 'kind', 'title', 'detail', 'person', 'when_start', 'when_end', 'when_text',
          'precision', 'strength', 'confidence', 'suggested_action', 'missing_details', 'evidence', 'reason',
        ],
        properties: {
          op: { type: 'string', enum: ['create', 'update', 'done', 'cancel'] },
          item_id: { type: ['string', 'null'], description: 'Existing item id for update/done/cancel; null for create.' },
          chat_ref: { type: 'string', description: 'The chat reference, e.g. "C2".' },
          kind: { type: 'string', enum: [...KINDS] },
          title: { type: 'string', description: 'Short, notification-ready summary, e.g. "Chill with Ali".' },
          detail: { type: ['string', 'null'] },
          person: { type: ['string', 'null'], description: 'Who the item is with, as named in the chat.' },
          when_start: { type: ['string', 'null'], description: 'Local ISO datetime or date (YYYY-MM-DD[THH:MM]).' },
          when_end: { type: ['string', 'null'] },
          when_text: { type: ['string', 'null'], description: 'The original time phrase, e.g. "tuesday after work".' },
          precision: { type: 'string', enum: ['exact', 'part_of_day', 'day', 'week', 'none'] },
          strength: { type: 'string', enum: ['firm', 'tentative', 'soft'] },
          confidence: { type: 'number' },
          suggested_action: {
            type: 'string',
            enum: ['calendar_event', 'reminder', 'reply', 'call', 'check_in', 'pay', 'save', 'none'],
          },
          missing_details: { type: 'array', items: { type: 'string' } },
          evidence: { type: 'array', items: { type: 'integer' }, description: 'Message numbers (#) supporting this.' },
          reason: { type: 'string', description: 'One sentence on why, for tuning.' },
        },
      },
    },
  },
} as const;

export interface PromptChat {
  ref: string;
  transcript: string;
  items: Item[];
}

const GUIDE = `You are the memory of a busy person ("Me") who makes plans and promises over text and then forgets them.
Read the conversations below and keep their list of commitments and loose ends accurate.

Read like a friend who was in the chat, not like a keyword matcher. Meaning comes from context:
- "yo what are you saying on tuesday?" → "let's chill" = Me agreed to hang out Tuesday (plan, firm).
- A tapback 👍 or ❤️ on "dinner thurs?" = agreement. ❓ or 😂 usually is not.
- "I'm down", "bet", "say less", "I'm good for that", "works for me" = yes to whatever was just proposed.
- "maybe", "I'll try", "we'll see", "lemme see" = tentative. "we should hang soon" with no time = soft.
- Resolve relative dates ("tuesday", "tmrw", "this weekend", "after work") against the timestamp of the
  message that said them, not against now. Give your best concrete guess and set precision honestly.

Kinds:
- plan: Me agreed to meet / hang out / attend something with someone.
- call: Me agreed to call, FaceTime, or be called.
- task: Me said Me would do something ("I'll send you the deck", "I'll book it").
- follow_up: Me said Me would get back to someone ("lemme check and get back to you").
- consider: Me said Me would think about something.
- reminder: Me asked to be reminded, or someone asked Me not to forget something.
- reply_owed: someone asked Me something or expects a response, and Me has not answered (see rules below).
- invite: Me was invited to something and has not clearly said yes or no.
- they_owe_me: someone else promised Me something ("I'll send you the address").
- iou: money owed in either direction (detail says who owes whom and how much).
- check_in: a life event worth following up on ("interview thursday", "mom's surgery tmrw") — when_start is
  when a check-in would be natural, suggested_action check_in.
- fact: a detail Me will likely need later (address, time, reservation name, gate code, flight). Attach it to
  the plan it belongs to via detail when one exists, and also emit it as a fact.
- recommendation: something recommended to Me (show, restaurant, product, link).

Rules:
- Only extract what the conversation supports. Banter, hypotheticals, jokes and past events are not commitments.
- For plans/calls with no agreed time or place, list what's missing in missing_details (e.g. ["time", "place"]).
- reply_owed: only when the latest messages from them clearly expect an answer, Me has not replied since, and
  their message is older than {REPLY_HOURS} hours as of now. Do not flag reactions, "lol", or messages that end
  the conversation. If Me replies later, close it with op "done".
- You are given each chat's existing items. Never create a duplicate: use op "update" with its item_id when new
  messages change it (new time, place, detail), "done" when it clearly happened or was handled ("sent!", "omw",
  Me replied), and "cancel" when called off or declined. Items with status dismissed were rejected by Me — do
  not recreate them unless something materially new happens.
- If nothing needs to change, return {"ops": []}. Most conversations need no ops.
- Titles are short and notification-ready ("Chill with Ali", "Send Sam the deck", "Reply to Maya about Saturday").
- confidence is 0–1: how sure you are this is real and correctly understood.
- evidence lists the # numbers of the messages that support the item.
- For op "update", give the full corrected item; null leaves a field unchanged. For "done" or "cancel", copy
  the existing item's values.
- Do not run commands or use tools. Answer only with the JSON object.`;

function describeItem(i: Item): string {
  const when = i.whenStart ? ` when=${i.whenStart}` : '';
  return `- ${i.id} [${i.kind}, ${i.status}${when}] ${i.title}${i.detail ? ` — ${i.detail}` : ''}`;
}

export function buildPrompt(chats: PromptChat[], now: Date, replyOwedAfterHours: number): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const nowText = now.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' });
  const sections = chats.map((c) => {
    const items = c.items.length ? c.items.map(describeItem).join('\n') : '(none)';
    return `${c.transcript}\n\nExisting items for ${c.ref}:\n${items}`;
  });
  return [
    GUIDE.replace('{REPLY_HOURS}', String(replyOwedAfterHours)),
    `Now: ${nowText} (${tz}).`,
    `Conversations (message numbers are #ids):`,
    sections.join('\n\n---\n\n'),
  ].join('\n\n');
}
