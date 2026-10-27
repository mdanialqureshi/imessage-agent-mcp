// Builds a synthetic Messages database and Contacts store for tests.
// Everything here is fictional: 555 numbers, example.com emails, made-up people.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const APPLE_EPOCH_MS = 978307200000;

/** "Now" for tests: Monday morning, so "tuesday" means tomorrow. */
export const NOW = new Date('2026-10-26T09:00:00');

export const PEOPLE = {
  ali: { name: 'Ali Rahman', handle: '+12125550101' },
  maya: { name: 'Maya Chen', handle: '+12125550102' },
  sam: { name: 'Sam Ortiz', handle: '+12125550103' },
  jordan: { name: 'Jordan Lee', handle: '+12125550104' },
  mom: { name: 'Mom', handle: '+12125550105' },
  zara: { name: 'Zara Khan', handle: '+12125550106' },
  chris: { name: 'Chris Park', handle: 'chris@example.com' },
  bank: { name: null, handle: '72345' },
};

/** Encodes text the way macOS stores it in message.attributedBody (typedstream NSAttributedString). */
export function attributedBody(text: string): Buffer {
  const bytes = Buffer.from(text, 'utf8');
  const length =
    bytes.length < 0x80
      ? Buffer.from([bytes.length])
      : Buffer.concat([Buffer.from([0x81]), Buffer.from([bytes.length & 0xff, bytes.length >> 8])]);
  return Buffer.concat([
    Buffer.from('\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08', 'latin1'),
    Buffer.from('NSString'),
    Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]),
    length,
    bytes,
    Buffer.from([0x86, 0x84, 0x02, 0x69, 0x49, 0x01]),
  ]);
}

type Who = keyof typeof PEOPLE | 'me';
interface Msg {
  chat: string;
  from: Who;
  at: string;
  text?: string;
  /** Store text only in attributedBody, like modern macOS. */
  blobOnly?: boolean;
  tapback?: { type: number; target: string };
  key?: string;
}

const CHATS: Record<string, { members: (keyof typeof PEOPLE)[]; name?: string }> = {
  ali: { members: ['ali'] },
  maya: { members: ['maya'] },
  sam: { members: ['sam'] },
  jordan: { members: ['jordan'] },
  mom: { members: ['mom'] },
  zara: { members: ['zara'] },
  chris: { members: ['chris'] },
  bank: { members: ['bank'] },
  crew: { members: ['ali', 'sam'], name: 'Weekend crew' },
};

export const MESSAGES: Msg[] = [
  { chat: 'sam', from: 'sam', at: '2026-10-23T18:02', text: 'dinner thursday?', key: 'sam-dinner' },
  { chat: 'sam', from: 'me', at: '2026-10-23T18:30', tapback: { type: 2001, target: 'sam-dinner' } },
  { chat: 'sam', from: 'sam', at: '2026-10-23T18:31', text: 'my interview is wednesday btw, nervous lol', blobOnly: true },
  { chat: 'maya', from: 'maya', at: '2026-10-24T14:00', text: 'can you send me that resume template?' },
  { chat: 'maya', from: 'me', at: '2026-10-24T14:05', text: "yeah I'll send it tonight", blobOnly: true },
  { chat: 'jordan', from: 'jordan', at: '2026-10-24T18:00', text: 'you coming to my bday thing nov 14? at 412 King St' },
  { chat: 'crew', from: 'ali', at: '2026-10-24T22:00', text: 'we should do vegas sometime lol' },
  { chat: 'crew', from: 'sam', at: '2026-10-24T22:01', text: 'haha one day' },
  { chat: 'bank', from: 'bank', at: '2026-10-25T08:00', text: 'Your verification code is 482913. Do not share it.' },
  { chat: 'mom', from: 'mom', at: '2026-10-25T09:50', text: 'call me when you get a chance' },
  { chat: 'mom', from: 'me', at: '2026-10-25T10:00', text: 'will call you later today', blobOnly: true },
  { chat: 'zara', from: 'me', at: '2026-10-25T12:00', text: "I'll venmo you for the tickets" },
  { chat: 'zara', from: 'zara', at: '2026-10-25T12:03', text: 'ok! also you gotta watch Severance' },
  { chat: 'chris', from: 'chris', at: '2026-10-25T15:00', text: 'lmk if you can do the call friday' },
  { chat: 'chris', from: 'me', at: '2026-10-25T15:10', text: 'lemme check and get back to you' },
  { chat: 'ali', from: 'ali', at: '2026-10-25T21:14', text: 'yo what are you saying on tuesday?' },
  { chat: 'ali', from: 'me', at: '2026-10-25T21:20', text: "let's chill", blobOnly: true },
  { chat: 'ali', from: 'ali', at: '2026-10-25T21:21', text: "bet, I'll hit you after work" },
];

const toAppleNs = (iso: string) => BigInt(new Date(iso).getTime() - APPLE_EPOCH_MS) * 1000000n;

function buildChatDb(file: string, messages: Msg[]): void {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, display_name TEXT, style INTEGER);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER);
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, handle_id INTEGER, date INTEGER,
      is_from_me INTEGER, item_type INTEGER DEFAULT 0, associated_message_guid TEXT, associated_message_type INTEGER DEFAULT 0,
      associated_message_emoji TEXT, thread_originator_guid TEXT, cache_has_attachments INTEGER DEFAULT 0,
      is_audio_message INTEGER DEFAULT 0, date_edited INTEGER DEFAULT 0, date_retracted INTEGER DEFAULT 0);
  `);
  const handleIds = new Map<string, number>();
  Object.entries(PEOPLE).forEach(([key, p], i) => {
    handleIds.set(key, i + 1);
    db.prepare('INSERT INTO handle VALUES (?, ?, ?)').run(i + 1, p.handle, 'iMessage');
  });
  const chatIds = new Map<string, number>();
  Object.entries(CHATS).forEach(([key, c], i) => {
    const id = i + 1;
    chatIds.set(key, id);
    const identifier = c.members.length > 1 ? `chat${1000 + id}` : PEOPLE[c.members[0]].handle;
    db.prepare('INSERT INTO chat VALUES (?, ?, ?, ?, ?)').run(id, `iMessage;-;${identifier}`, identifier, c.name ?? '', c.members.length > 1 ? 43 : 45);
    for (const m of c.members) db.prepare('INSERT INTO chat_handle_join VALUES (?, ?)').run(id, handleIds.get(m)!);
  });
  const guids = new Map<string, string>();
  messages.forEach((m, i) => {
    const rowid = i + 1;
    const guid = `FAKE-GUID-${String(rowid).padStart(4, '0')}`;
    if (m.key) guids.set(m.key, guid);
    const chat = CHATS[m.chat];
    const sender = m.from === 'me' ? (chat.members.length === 1 ? chat.members[0] : null) : m.from;
    const text = m.tapback ? null : m.blobOnly ? null : (m.text ?? null);
    const blob = m.text && !m.tapback ? attributedBody(m.text) : null;
    db.prepare(
      `INSERT INTO message (ROWID, guid, text, attributedBody, handle_id, date, is_from_me, associated_message_guid, associated_message_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      rowid, guid, text, blob, sender ? handleIds.get(sender)! : 0, toAppleNs(m.at), m.from === 'me' ? 1 : 0,
      m.tapback ? `p:0/${guids.get(m.tapback.target)}` : null, m.tapback?.type ?? 0,
    );
    db.prepare('INSERT INTO chat_message_join VALUES (?, ?, ?)').run(chatIds.get(m.chat)!, rowid, toAppleNs(m.at));
  });
  db.close();
}

function buildAddressBook(dir: string): void {
  const sourceDir = path.join(dir, 'Sources', 'FAKE-SOURCE');
  fs.mkdirSync(sourceDir, { recursive: true });
  const db = new DatabaseSync(path.join(sourceDir, 'AddressBook-v22.abcddb'));
  db.exec(`
    CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, ZFIRSTNAME TEXT, ZLASTNAME TEXT, ZNICKNAME TEXT, ZORGANIZATION TEXT);
    CREATE TABLE ZABCDPHONENUMBER (ZOWNER INTEGER, ZFULLNUMBER TEXT);
    CREATE TABLE ZABCDEMAILADDRESS (ZOWNER INTEGER, ZADDRESS TEXT);
  `);
  Object.values(PEOPLE).forEach((p, i) => {
    if (!p.name) return;
    const [first, ...last] = p.name.split(' ');
    db.prepare('INSERT INTO ZABCDRECORD VALUES (?, ?, ?, NULL, NULL)').run(i + 1, first, last.join(' ') || null);
    if (p.handle.includes('@')) db.prepare('INSERT INTO ZABCDEMAILADDRESS VALUES (?, ?)').run(i + 1, p.handle);
    else db.prepare('INSERT INTO ZABCDPHONENUMBER VALUES (?, ?)').run(i + 1, `(${p.handle.slice(2, 5)}) ${p.handle.slice(5, 8)}-${p.handle.slice(8)}`);
  });
  db.close();
}

/** Creates the fixture under `dir` and returns the env vars that point the app at it. */
export function buildFixture(dir: string, messages: Msg[] = MESSAGES): Record<string, string> {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const chatDb = path.join(dir, 'chat.db');
  const addressBook = path.join(dir, 'AddressBook');
  const state = path.join(dir, 'state');
  buildChatDb(chatDb, messages);
  buildAddressBook(addressBook);
  fs.mkdirSync(state, { recursive: true });
  return { IMESSAGE_DB_PATH: chatDb, ADDRESSBOOK_DIR: addressBook, IMESSAGE_AGENT_STATE_DIR: state };
}

// `node test/fixture.ts <dir>` builds a fixture for manual runs and prints the env vars.
if (import.meta.url === `file://${process.argv[1]}`) {
  const env = buildFixture(path.resolve(process.argv[2] ?? 'test/.tmp/manual'));
  for (const [k, v] of Object.entries(env)) console.log(`export ${k}="${v}"`);
}
