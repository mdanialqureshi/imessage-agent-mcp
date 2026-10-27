#!/usr/bin/env node
// Blocks secrets and personal data from entering this public repo.
// Scans staged files by default, or every tracked file with --all.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const all = process.argv.includes('--all');
const checkAuthor = process.argv.includes('--check-authors');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const files = (all ? git('ls-files') : git('diff', '--cached', '--name-only', '--diff-filter=ACMR'))
  .split('\n')
  .filter(Boolean);

const FORBIDDEN_FILES = [
  /\.(db|db-wal|db-shm|sqlite3?|abcddb|storedata)$/i,
  /(^|\/)(http-token|interpret\.lock)$/,
  /(^|\/)snapshot(-[^/]*)?\//,
  /(^|\/)\.env(\..*)?$/,
  /(^|\/)config\.json$/,
  /\.log$/,
  /(^|\/)exports?\//,
  /\.export\.txt$/,
];

const PATTERNS = [
  ['OpenAI key', /\bsk-(proj-)?[A-Za-z0-9_-]{20,}/],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ['AWS key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['Bearer token', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/],
  ['Hugging Face token', /\bhf_[A-Za-z0-9]{30,}/],
  ['npm token', /\bnpm_[A-Za-z0-9]{30,}/],
  ['Stripe key', /\b[sr]k_(live|test)_[A-Za-z0-9]{20,}/],
  ['Google OAuth secret', /\bGOCSPX-[A-Za-z0-9_-]{20,}/],
  ['GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}/],
  ['Secret assignment', /(api[_-]?key|secret|password|passwd|token)\w*["']?\s*[:=]\s*['"]?[A-Za-z0-9_\-+/=.]{16,}/i],
  ['Home path with username', /\/Users\/(?!<|\$|\{|you\b|me\b|example\b|USER\b|Shared\b)[A-Za-z0-9._-]+(\/|\b)/],
];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Only reserved example domains, plus the one bot address commit trailers use.
const ALLOWED_EMAIL_DOMAINS = /@(example\.(com|org|net)|users\.noreply\.github\.com)$/i;
const ALLOWED_EMAILS = new Set(['noreply@anthropic.com', 'noreply@github.com']);
// North American numbers, plus anything international-looking (+CC …).
const PHONE = /(?:\+?1[\s.-]?)?\(?\b[2-9]\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b|\+\d[\d\s().-]{8,}\d/g;
// Fictional numbers: the 555-0100–0199 range reserved for fiction.
const isFictionalPhone = (digits) => /^1?\d{3}5550[1]\d\d$/.test(digits);

const problems = [];
for (const file of files) {
  if (FORBIDDEN_FILES.some((re) => re.test(file))) {
    problems.push(`${file}: file type must never be committed`);
    continue;
  }
  // Staged mode reads the index, not the working tree, so a staged-then-deleted file is still scanned.
  if (all && (!fs.existsSync(file) || fs.statSync(file).isDirectory())) continue;
  const content = all ? fs.readFileSync(file, 'utf8') : git('show', `:${file}`);
  if (content.includes('\u0000')) {
    problems.push(`${file}: binary file — commit only reviewed text files`);
    continue;
  }
  const isScanner = path.resolve(file) === path.resolve('scripts/check-public-safety.mjs');
  content.split('\n').forEach((line, i) => {
    const where = `${file}:${i + 1}`;
    // The scanner's own regexes would match themselves; it is still checked for emails and phones.
    if (!isScanner) for (const [name, re] of PATTERNS) if (re.test(line)) problems.push(`${where}: ${name}`);
    for (const email of line.match(EMAIL) ?? []) {
      if (!ALLOWED_EMAIL_DOMAINS.test(email) && !ALLOWED_EMAILS.has(email.toLowerCase())) problems.push(`${where}: email address ${email}`);
    }
    for (const phone of line.match(PHONE) ?? []) {
      if (!isFictionalPhone(phone.replace(/\D/g, ''))) problems.push(`${where}: phone number ${phone}`);
    }
  });
}

// Every commit must use a GitHub noreply identity so no personal email is published.
if (checkAuthor) {
  for (const line of git('log', '--format=%h %ae %ce').split('\n').filter(Boolean)) {
    const [sha, author, committer] = line.split(' ');
    for (const email of [author, committer]) {
      if (!email.endsWith('@users.noreply.github.com') && !ALLOWED_EMAILS.has(email)) problems.push(`commit ${sha}: email ${email} is not a noreply address`);
    }
  }
}

if (problems.length) {
  console.error('❌ Public-repo safety check failed:\n' + problems.map((p) => `  ${p}`).join('\n'));
  console.error('\nFix these. Use only reserved fakes: example.com emails and 555-01xx phone numbers.');
  process.exit(1);
}
console.log(`✅ Public-repo safety check passed (${files.length} file${files.length === 1 ? '' : 's'}).`);
