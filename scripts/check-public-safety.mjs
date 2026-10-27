#!/usr/bin/env node
// Blocks secrets and personal data from entering this public repo.
// Scans staged files by default, or every tracked file with --all.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const all = process.argv.includes('--all');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const files = (all ? git('ls-files') : git('diff', '--cached', '--name-only', '--diff-filter=ACMR'))
  .split('\n')
  .filter(Boolean);

const FORBIDDEN_FILES = [
  /\.(db|db-wal|db-shm|sqlite3?|abcddb)$/i,
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
  ['Secret assignment', /\b(api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"][^'"\s]{12,}['"]/i],
  ['Home path with username', /\/Users\/(?!<|\$|\{|you\b|me\b|example\b|USER\b)[A-Za-z0-9._-]+\//],
];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ALLOWED_EMAIL_DOMAINS = /@(example\.(com|org|net)|users\.noreply\.github\.com|anthropic\.com|apple\.com)$/i;
// North American numbers; fictional ones use the 555 exchange.
const PHONE = /(?:\+?1[\s.-]?)?\(?\b[2-9]\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;

const problems = [];
for (const file of files) {
  if (FORBIDDEN_FILES.some((re) => re.test(file))) {
    problems.push(`${file}: file type must never be committed`);
    continue;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) continue;
  const content = all ? fs.readFileSync(file, 'utf8') : git('show', `:${file}`);
  if (content.includes('\u0000')) {
    problems.push(`${file}: binary file — commit only reviewed text files`);
    continue;
  }
  if (path.resolve(file) === path.resolve('scripts/check-public-safety.mjs')) continue;
  content.split('\n').forEach((line, i) => {
    if (line.includes('safety-allow')) return;
    const where = `${file}:${i + 1}`;
    for (const [name, re] of PATTERNS) if (re.test(line)) problems.push(`${where}: ${name}`);
    for (const email of line.match(EMAIL) ?? []) {
      if (!ALLOWED_EMAIL_DOMAINS.test(email)) problems.push(`${where}: email address ${email}`);
    }
    for (const phone of line.match(PHONE) ?? []) {
      const digits = phone.replace(/\D/g, '').replace(/^1/, '');
      if (digits.slice(3, 6) !== '555') problems.push(`${where}: phone number ${phone}`);
    }
  });
}

if (problems.length) {
  console.error('❌ Public-repo safety check failed:\n' + problems.map((p) => `  ${p}`).join('\n'));
  console.error('\nFix these, or mark a reviewed synthetic value with a `safety-allow` comment.');
  process.exit(1);
}
console.log(`✅ Public-repo safety check passed (${files.length} file${files.length === 1 ? '' : 's'}).`);
