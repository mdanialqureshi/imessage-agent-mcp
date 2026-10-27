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
/** Interpreter output can echo message text, so it's only surfaced when explicitly debugging. */
const DEBUG = process.env.IMESSAGE_AGENT_DEBUG === '1';

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
      if (code === 0) return resolve(stdout);
      const detail = DEBUG ? `: ${(stderr || stdout).trim().slice(-2000)}` : ' (output withheld; rerun with IMESSAGE_AGENT_DEBUG=1)';
      reject(new Error(`${path.basename(cmd)} exited with code ${code}${detail}`));
    });
    child.stdin.end(input);
  });
}

function parseOps(text: string): RawOp[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Interpreter returned no JSON object');
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed.ops)) throw new Error('Interpreter JSON has no ops array');
  return parsed.ops as RawOp[];
}

/** An empty temp working directory, removed afterwards. */
function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imessage-agent-'));
  return fn(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

/**
 * Message text is attacker-controlled, so the interpreter must be a pure text-in/JSON-out
 * call: no shell, no MCP servers, no user config or hooks, no session files. The service
 * holds Full Disk Access and children inherit it, so a shell here could read anything.
 */
export function codexArgs(dir: string, schemaFile: string, outFile: string, model: string | null): string[] {
  const args = [
    'exec', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules',
    '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'view_image',
    '-c', 'web_search="disabled"',
    '--sandbox', 'read-only', '--color', 'never',
    '--output-schema', schemaFile, '-o', outFile, '-C', dir,
  ];
  if (model) args.push('-m', model);
  args.push('-');
  return args;
}

export function claudeArgs(model: string | null): string[] {
  const args = [
    '-p', '--output-format', 'json', '--json-schema', JSON.stringify(OUTPUT_SCHEMA),
    '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '',
    '--disable-slash-commands', '--no-session-persistence',
  ];
  if (model) args.push('--model', model);
  return args;
}

/** Absolute interpreter path when the service pinned one at install time. */
function bin(name: 'codex' | 'claude'): string {
  return process.env[`IMESSAGE_AGENT_${name.toUpperCase()}_BIN`] || name;
}

/** Codex CLI signed in with a ChatGPT plan: `codex exec` with a strict output schema. */
async function codex(prompt: string, config: Config): Promise<RawOp[]> {
  return withScratch(async (dir) => {
    const schemaFile = path.join(dir, 'schema.json');
    const outFile = path.join(dir, 'out.json');
    fs.writeFileSync(schemaFile, JSON.stringify(OUTPUT_SCHEMA));
    await run(bin('codex'), codexArgs(dir, schemaFile, outFile, config.model), prompt, dir);
    return parseOps(fs.readFileSync(outFile, 'utf8'));
  });
}

/** Claude Code signed in with a Claude plan: `claude -p` with structured output and no tools. */
async function claude(prompt: string, config: Config): Promise<RawOp[]> {
  return withScratch(async (dir) => {
    const out = JSON.parse(await run(bin('claude'), claudeArgs(config.model), prompt, dir));
    if (out.structured_output) return (out.structured_output as { ops: RawOp[] }).ops;
    return parseOps(String(out.result ?? ''));
  });
}

export function interpreter(config: Config): (prompt: string) => Promise<RawOp[]> {
  const impl = config.interpreter === 'claude' ? claude : codex;
  return (prompt) => impl(prompt, config);
}
