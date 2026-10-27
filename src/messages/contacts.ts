import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { paths } from '../config.ts';

/** Normalizes a phone number or email so iMessage handles match Contacts entries. */
export function handleKey(handle: string): string {
  if (handle.includes('@')) return handle.trim().toLowerCase();
  const digits = handle.replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/** SMS short codes (banks, 2FA, deliveries) are 3–8 digits with no email. */
export function isShortCode(handle: string): boolean {
  if (handle.includes('@')) return false;
  if (handle.startsWith('urn:biz:')) return true;
  const digits = handle.replace(/\D/g, '');
  return digits.length > 0 && digits.length < 9;
}

function addressBookFiles(): string[] {
  const root = paths.addressBookDir;
  const files: string[] = [];
  const rootDb = path.join(root, 'AddressBook-v22.abcddb');
  if (fs.existsSync(rootDb)) files.push(rootDb);
  const sources = path.join(root, 'Sources');
  if (fs.existsSync(sources)) {
    for (const dir of fs.readdirSync(sources)) {
      const db = path.join(sources, dir, 'AddressBook-v22.abcddb');
      if (fs.existsSync(db)) files.push(db);
    }
  }
  return files;
}

export class Contacts {
  private names = new Map<string, string>();

  /** Reads every local AddressBook source. Missing or unreadable sources are skipped. */
  static load(): Contacts {
    const contacts = new Contacts();
    for (const file of addressBookFiles()) {
      try {
        const db = new DatabaseSync(file, { readOnly: !paths.mirror }); // The reader's copies need their WAL applied.
        const people = db
          .prepare('SELECT Z_PK AS id, ZFIRSTNAME AS first, ZLASTNAME AS last, ZNICKNAME AS nick, ZORGANIZATION AS org FROM ZABCDRECORD')
          .all() as Record<string, string | null>[];
        const byId = new Map<number, string>();
        for (const p of people) {
          const name = [p.first, p.last].filter(Boolean).join(' ') || p.nick || p.org;
          if (name) byId.set(Number(p.id), name);
        }
        const phones = db.prepare('SELECT ZOWNER AS owner, ZFULLNUMBER AS value FROM ZABCDPHONENUMBER').all();
        const emails = db.prepare('SELECT ZOWNER AS owner, ZADDRESS AS value FROM ZABCDEMAILADDRESS').all();
        for (const row of [...phones, ...emails] as { owner: number; value: string | null }[]) {
          const name = byId.get(Number(row.owner));
          if (name && row.value) contacts.names.set(handleKey(row.value), name);
        }
        db.close();
      } catch {
        // Contacts are a nicety; without them handles are shown as numbers.
      }
    }
    return contacts;
  }

  get size(): number {
    return this.names.size;
  }

  name(handle: string | null): string | null {
    if (!handle) return null;
    return this.names.get(handleKey(handle)) ?? null;
  }

  label(handle: string | null): string {
    if (!handle) return 'unknown';
    return this.name(handle) ?? handle;
  }
}
