import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../config.ts';
import { OUTPUT_SCHEMA } from './prompt.ts';

export interface RawOp {
  op: 'create' | 'update' | 'done' | 'cancel';
  item_id: string | null;
  chat_ref: string;
  kind: string;
  title: string;
  detail: string | null;
  person: string | null;
  when_start: string | null;
  when_end: string | null;
  when_text: string | null;
  precision: string;
  strength: string;
  confidence: number;
  suggested_action: string;
  missing_details: string[];
  evidence: number[];
  reason: string;
}

const TIMEOUT_MS = 10 * 60_000;

function run(cmd: string, args: string[], input: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited with ${code}: ${(stderr || stdout).trim().slice(-2000)}`));
    });
    child.stdin.end(input);
  });
}

function parseOps(text: string): RawOp[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`Interpreter returned no JSON: ${text.slice(0, 500)}`);
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed.ops)) throw new Error('Interpreter JSON has no ops array');
  return parsed.ops as RawOp[];
}

/** Runs in an empty temp directory so the CLI agent has nothing to read or change. */
function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imessage-agent-'));
  return fn(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

/** Codex CLI signed in with a ChatGPT plan: `codex exec` with a strict output schema. */
async function codex(prompt: string, config: Config): Promise<RawOp[]> {
  return withScratch(async (dir) => {
    const schemaFile = path.join(dir, 'schema.json');
    const outFile = path.join(dir, 'out.json');
    fs.writeFileSync(schemaFile, JSON.stringify(OUTPUT_SCHEMA));
    const args = [
      'exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--color', 'never',
      '--output-schema', schemaFile, '-o', outFile, '-C', dir,
    ];
    if (config.model) args.push('-m', config.model);
    args.push('-');
    await run('codex', args, prompt, dir);
    return parseOps(fs.readFileSync(outFile, 'utf8'));
  });
}

/** Claude Code signed in with a Claude plan: `claude -p` with structured output and no tools. */
async function claude(prompt: string, config: Config): Promise<RawOp[]> {
  return withScratch(async (dir) => {
    const args = ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(OUTPUT_SCHEMA), '--disallowedTools', 'Bash,Edit,Write,Read,WebFetch,WebSearch'];
    if (config.model) args.push('--model', config.model);
    const out = JSON.parse(await run('claude', args, prompt, dir));
    if (out.structured_output) return (out.structured_output as { ops: RawOp[] }).ops;
    return parseOps(String(out.result ?? ''));
  });
}

export function interpreter(config: Config): (prompt: string) => Promise<RawOp[]> {
  const impl = config.interpreter === 'claude' ? claude : codex;
  return (prompt) => impl(prompt, config);
}
