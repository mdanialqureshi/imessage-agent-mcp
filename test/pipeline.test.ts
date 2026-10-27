import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { attributedBody, buildFixture, NOW } from './fixture.ts';

// Paths are read from the environment at import time, so point them at the fixture first.
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp', 'pipeline');
Object.assign(process.env, buildFixture(dir));

const { decodeAttributedBody, ChatDb } = await import('../src/messages/chatdb.ts');
const { Contacts } = await import('../src/messages/contacts.ts');
const { Conversations } = await import('../src/messages/conversations.ts');
const { loadConfig } = await import('../src/config.ts');
const { interpretNow } = await import('../src/interpret/run.ts');
const { buildPrompt } = await import('../src/interpret/prompt.ts');
const { Store } = await import('../src/store.ts');
const { buildBrief } = await import('../src/brief.ts');
const { createServer } = await import('../src/server.ts');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

type RawOp = import('../src/interpret/runners.ts').RawOp;

function windows() {
  const db = ChatDb.open();
  const conv = new Conversations(db, Contacts.load(), loadConfig());
  const ws = conv.windowsForNew(db.newMessages(0, new Date(0)));
  ws.forEach((w, i) => (w.ref = `C${i + 1}`));
  return { db, conv, ws, text: ws.map((w) => conv.render(w)).join('\n\n') };
}

/** Finds the chat ref the prompt assigned to a contact. */
function refFor(prompt: string, label: string): string {
  const match = prompt.match(new RegExp(`### (C\\d+) — ${label}`));
  assert.ok(match, `no chat for ${label} in prompt`);
  return match[1];
}

function op(fields: Partial<RawOp>): RawOp {
  return {
    op: 'create', item_id: null, chat_ref: 'C1', kind: 'plan', title: 'x', detail: null, person: null,
    when_start: null, when_end: null, when_text: null, precision: 'none', strength: 'firm', confidence: 0.9,
    suggested_action: 'none', missing_details: [], evidence: [], reason: 'test', ...fields,
  };
}

test('decodes attributedBody text, including long messages', () => {
  assert.equal(decodeAttributedBody(attributedBody("let's chill")), "let's chill");
  const long = 'x'.repeat(300) + ' 🎉';
  assert.equal(decodeAttributedBody(attributedBody(long)), long);
  assert.equal(decodeAttributedBody(null), null);
  assert.equal(decodeAttributedBody(Buffer.from('no marker here')), null);
});

test('renders conversations with names, context, tapbacks and blob-only text', () => {
  const { db, text } = windows();
  assert.match(text, /Ali Rahman: yo what are you saying on tuesday\?/);
  assert.match(text, /Me: let's chill/, 'attributedBody-only text is decoded');
  assert.match(text, /Me reacted 👍 to #1/, 'tapback points at the message it reacts to');
  assert.match(text, /Weekend crew \(group: Ali Rahman, Sam Ortiz\)/);
  db.close();
});

test('never exposes short-code senders or verification codes', () => {
  const { db, text } = windows();
  assert.doesNotMatch(text, /482913/);
  assert.doesNotMatch(text, /72345/);
  db.close();
});

test('message text cannot forge transcript lines, and codes in normal chats are masked', () => {
  const { db, text } = windows();
  assert.doesNotMatch(text, /^#999/m, 'embedded newline must not start a fake message line');
  assert.match(text, /Eve Mallory: hey ⏎ #999/);
  assert.doesNotMatch(text, /731904/);
  db.close();
});

test('interpreters run with no shell, MCP servers, user config or session files', async () => {
  const { codexArgs, claudeArgs } = await import('../src/interpret/runners.ts');
  const codex = codexArgs('/tmp/x', '/tmp/x/s.json', '/tmp/x/o.json', null).join(' ');
  for (const flag of ['--ephemeral', '--ignore-user-config', '--ignore-rules', '--disable shell_tool', '--disable unified_exec', '--sandbox read-only']) {
    assert.ok(codex.includes(flag), `codex ${flag}`);
  }
  const claude = claudeArgs(null);
  assert.equal(claude[claude.indexOf('--tools') + 1], '', 'claude has no tools');
  assert.equal(claude[claude.indexOf('--setting-sources') + 1], '', 'claude ignores user settings and hooks');
  for (const flag of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(claude.includes(flag), `claude ${flag}`);
});

test('private contacts are excluded entirely', () => {
  const db = ChatDb.open();
  const conv = new Conversations(db, Contacts.load(), { ...loadConfig(), privateContacts: ['Zara Khan'] });
  const text = conv.windowsForNew(db.newMessages(0, new Date(0))).map((w) => conv.render(w)).join('\n');
  assert.doesNotMatch(text, /venmo|Severance/);
  db.close();
});

test('prompt carries the current time and reply threshold', () => {
  const prompt = buildPrompt([{ ref: 'C1', transcript: '### C1 — Test', items: [] }], NOW, 4);
  assert.match(prompt, /Now: Monday, October 26, 2026/);
  assert.match(prompt, /older than 4 hours/);
});

test('interpretation creates, updates and closes items without duplicates', async () => {
  const config = loadConfig();
  const first = await interpretNow({
    config,
    now: NOW,
    runner: async (prompt) => {
      assert.match(prompt, /Existing items for C\d+:\n\(none\)/);
      return [
        op({ chat_ref: refFor(prompt, 'Ali Rahman'), title: 'Chill with Ali', person: 'Ali', when_start: '2026-10-27T18:00', when_text: 'tuesday, after work', precision: 'part_of_day', suggested_action: 'calendar_event', evidence: [16, 17] }),
        op({ chat_ref: refFor(prompt, 'Maya Chen'), kind: 'task', title: 'Send Maya the resume template', evidence: [5] }),
        op({ chat_ref: refFor(prompt, 'Zara Khan'), kind: 'iou', title: 'Venmo Zara for tickets', evidence: [12] }),
        op({ chat_ref: 'C99', title: 'bogus chat ref' }),
      ];
    },
  });
  assert.deepEqual([first.created, first.skippedOps], [3, 1]);

  const store = Store.open();
  const ali = store.listItems({ person: 'Ali' })[0];
  assert.deepEqual(ali.evidence.map((e) => e.text), ['yo what are you saying on tuesday?', "let's chill"]);
  const maya = store.listItems({ person: 'Maya' })[0];
  const zara = store.listItems({ person: 'Zara' })[0];

  // No new messages: only 1:1 chats whose last message is unanswered get re-checked, with their items shown.
  const second = await interpretNow({
    config,
    now: NOW,
    runner: async (prompt) => {
      assert.doesNotMatch(prompt, /Maya Chen/, 'Me replied last to Maya, so it is not re-checked');
      assert.match(prompt, new RegExp(`${zara.id} \\[iou, open\\] Venmo Zara for tickets`));
      const jordan = refFor(prompt, 'Jordan Lee');
      return [
        op({ chat_ref: jordan, kind: 'invite', title: "Jordan's birthday Nov 14", when_start: '2026-11-14', evidence: [6] }),
        op({ chat_ref: refFor(prompt, 'Ali Rahman'), title: 'chill with ali', detail: 'After work', evidence: [18] }),
        op({ op: 'done', item_id: zara.id, chat_ref: refFor(prompt, 'Zara Khan'), kind: 'iou', title: zara.title }),
        op({ op: 'update', item_id: maya.id, chat_ref: jordan, kind: 'task', title: 'wrong chat' }),
      ];
    },
  });
  assert.deepEqual([second.created, second.updated, second.closed, second.skippedOps], [1, 1, 1, 1]);
  assert.equal(store.getItem(zara.id)!.status, 'done');
  assert.equal(store.getItem(maya.id)!.title, 'Send Maya the resume template', 'cross-chat update rejected');
  assert.equal(store.getItem(ali.id)!.evidence.length, 3, 'evidence accumulates on update');
  assert.equal(store.listItems({ person: 'Ali' }).length, 1, 'duplicate create became an update');

  // Everything has been checked: nothing to send to the interpreter.
  const third = await interpretNow({ config, now: NOW, runner: async () => assert.fail('should not be called') });
  assert.equal(third.chats, 0);
  store.close();
});

test('brief orders by urgency and includes ids', () => {
  const store = Store.open();
  const brief = buildBrief(store, { now: NOW });
  assert.match(brief, /## Coming up \(next 7 days\)[\s\S]*chill with ali/i);
  assert.match(brief, /## Open loops[\s\S]*Send Maya the resume template/);
  assert.match(brief, /`it_[0-9a-f]{8}`/);
  assert.match(brief, /> Me \(.*\): let's chill/);
  store.close();
});

test('MCP server exposes read-only tools and updates status', async () => {
  const server = createServer(loadConfig());
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);

  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const name of ['get_brief', 'list_items', 'get_item', 'get_conversation', 'search_messages', 'get_status']) {
    assert.equal(byName[name]?.annotations?.readOnlyHint, true, `${name} is read-only`);
  }
  assert.equal(byName.update_item.annotations?.readOnlyHint, false);

  const brief = await client.callTool({ name: 'get_brief', arguments: {} });
  const briefText = (brief.content as { text: string }[])[0].text;
  const id = briefText.match(/\*\*chill with ali\*\*.*`(it_[0-9a-f]{8})`/i)![1];

  const updated = await client.callTool({ name: 'update_item', arguments: { id, status: 'scheduled' } });
  assert.match((updated.content as { text: string }[])[0].text, /scheduled/);

  const convo = await client.callTool({ name: 'get_conversation', arguments: { with: 'ali rahman', days: 90 } });
  assert.match((convo.content as { text: string }[])[0].text, /let's chill/);

  const search = await client.callTool({ name: 'search_messages', arguments: { query: 'code', days: 365 } });
  assert.doesNotMatch((search.content as { text: string }[])[0].text, /482913/);
  await client.close();
});

test('HTTP endpoint requires a local host header and the bearer token', async () => {
  const { serveHttp, httpToken } = await import('../src/server.ts');
  const config = { ...loadConfig(), http: { host: '127.0.0.1', port: 18765, requireToken: true } };
  const server = await serveHttp({ autoInterpret: false, config });
  const url = 'http://127.0.0.1:18765/mcp';
  const init = {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
  };
  const post = (headers: Record<string, string>) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify(init),
    });
  try {
    assert.equal((await post({})).status, 401, 'no token');
    assert.equal((await post({ authorization: 'Bearer wrong' })).status, 401, 'wrong token');
    assert.equal((await post({ authorization: `Bearer ${httpToken()}`, origin: 'https://evil.example.com' })).status, 403, 'foreign origin');
    const health = (host: string) => new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port: 18765, path: '/health', headers: { host } }, (r) => resolve(r.statusCode!));
    });
    assert.equal(await health('127.0.0.1:18765'), 200);
    assert.equal(await health('rebind.example.com:18765'), 403, 'health rejects foreign Host (DNS rebinding)');
    const ok = await post({ authorization: `Bearer ${httpToken()}` });
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /imessage-agent/);
    await assert.rejects(serveHttp({ autoInterpret: false, config: { ...config, http: { ...config.http, host: '0.0.0.0' } } }), /loopback/);
  } finally {
    server.close();
  }
});

test('state is private to the user', () => {
  const mode = (p: string) => fs.statSync(p).mode & 0o777;
  const state = process.env.IMESSAGE_AGENT_STATE_DIR!;
  assert.equal(mode(state), 0o700);
  assert.equal(mode(path.join(state, 'state.db')), 0o600);
  assert.equal(mode(path.join(state, 'http-token')), 0o600);
  assert.equal(mode(path.join(state, 'config.json')), 0o600);
  assert.deepEqual(fs.readdirSync(state).filter((f) => f.startsWith('snapshot')), [], 'no leftover chat.db snapshots');
});
