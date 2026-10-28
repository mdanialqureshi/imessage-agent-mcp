// Signs a release's SHA256SUMS.txt with the release key, for the update check in src/update.ts:
//   UPDATE_SIGNING_KEY=<PEM> node scripts/sign-sums.mjs dist/SHA256SUMS.txt
// writes dist/SHA256SUMS.txt.sig and checks it against the public key the app ships with, so
// a release signed with the wrong key fails here instead of on people's Macs.
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import fs from 'node:fs';
import { UPDATE_PUBLIC_KEY } from '../src/update.ts';

const file = process.argv[2];
const pem = process.env.UPDATE_SIGNING_KEY;
if (!file || !pem) throw new Error('Usage: UPDATE_SIGNING_KEY=<PEM> node scripts/sign-sums.mjs <SHA256SUMS.txt>');
const sums = fs.readFileSync(file);
const signature = sign(null, sums, createPrivateKey(pem));
const key = createPublicKey({ key: Buffer.from(UPDATE_PUBLIC_KEY, 'base64'), format: 'der', type: 'spki' });
if (!verify(null, sums, key, signature)) throw new Error("UPDATE_SIGNING_KEY isn't the key whose public half is UPDATE_PUBLIC_KEY in src/update.ts");
fs.writeFileSync(`${file}.sig`, signature.toString('base64') + '\n');
console.log(`Signed ${file}`);
