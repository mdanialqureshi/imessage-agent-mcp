import { execFileSync, spawn } from 'node:child_process';
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

/** The CLI couldn't run or exited non-zero (signed out, offline, usage limit): retryable. */
export class InterpreterUnavailable extends Error {}

interface Output {
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], input: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<Output> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => reject(new InterpreterUnavailable(`${path.basename(cmd)} could not start (${(err as NodeJS.ErrnoException).code ?? 'error'})`)));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      const detail = DEBUG ? `: ${(stderr || stdout).trim().slice(-2000)}` : ' (output withheld; rerun with IMESSAGE_AGENT_DEBUG=1)';
      reject(new InterpreterUnavailable(`${path.basename(cmd)} exited with code ${code}${detail}`));
    });
    child.stdin.end(input);
  });
}

function parseOps(text: string): RawOp[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Interpreter returned no JSON object');
  let parsed: { ops?: unknown };
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    // JSON.parse errors quote the input, which can be message text.
    throw new Error('Interpreter returned invalid JSON');
  }
  if (!Array.isArray(parsed.ops)) throw new Error('Interpreter JSON has no ops array');
  return parsed.ops as RawOp[];
}

/** An empty temp working directory, removed afterwards. */
function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imessage-agent-'));
  return fn(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

/**
 * Codex features that expose tools: shell/exec, ChatGPT connectors (apps, plugins), code
 * mode, sub-agents, browser/computer use, memories, hooks. Always disabled, even if
 * `codex features list` can't be read.
 */
export const CODEX_TOOL_FEATURES = [
  'apps', 'plugins', 'remote_plugin', 'plugin_sharing', 'code_mode_host', 'shell_tool', 'unified_exec',
  'unified_exec_tty', 'view_image', 'multi_agent', 'image_generation', 'memories', 'goals', 'browser_use',
  'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'in_app_browser', 'tool_suggest',
  'skill_search', 'skill_mcp_dependency_install', 'hooks', 'sleep_tool',
];

let codexFeatures: { key: string; features: string[] } | null = null;

/**
 * Every feature enabled in the installed Codex, so tools added by future versions are
 * switched off too. Text-in/JSON-out needs none of them.
 */
export function enabledCodexFeatures(codexBin = bin('codex')): string[] {
  // Re-read after a codex upgrade, which the long-running service would otherwise miss.
  const resolved = execFileSync('/usr/bin/which', [codexBin], { encoding: 'utf8' }).trim() || codexBin;
  const real = fs.realpathSync(resolved);
  const key = `${real}:${fs.statSync(real).mtimeMs}`;
  if (codexFeatures?.key !== key) {
    // exec runs with --ignore-user-config, so list features as defaults (an empty
    // CODEX_HOME) rather than as the user's config.toml has them.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'imessage-agent-codex-'));
    let out: string;
    try {
      out = execFileSync(codexBin, ['features', 'list'], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: home } });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
    const rows = out.split('\n').map((l) => l.trim().split(/\s+/)).filter((cols) => cols.length >= 2);
    // Fail closed if the format changed and the parse no longer finds the features.
    if (!rows.some((cols) => cols[0] === 'shell_tool')) throw new Error('Could not read `codex features list`; refusing to run codex');
    codexFeatures = { key, features: rows.filter((cols) => cols.at(-1) === 'true').map((cols) => cols[0]) };
  }
  return codexFeatures.features;
}

/**
 * Message text is attacker-controlled, so the interpreter must be a pure text-in/JSON-out
 * call: no shell, no connectors or MCP servers, no user config or hooks, no session files.
 * The service reads the reader's private copy of Messages, which the interpreter must not reach.
 */
export function codexArgs(dir: string, schemaFile: string, outFile: string, model: string | null, features: string[] = []): string[] {
  const disabled = [...new Set([...CODEX_TOOL_FEATURES, ...features])];
  const args = [
    // --ephemeral is load-bearing: codex 0.164 still exposes collaboration tools that no
    // flag removes, and spawn_agent only fails because ephemeral threads have no rollout.
    'exec', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules',
    ...disabled.flatMap((f) => ['--disable', f]),
    '-c', 'web_search="disabled"',
    '--sandbox', 'read-only', '--color', 'never', '--json',
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

/** The model tried to use a tool, which only an injected instruction would cause. */
export class ToolUseAttempt extends Error {}

/** Allowlists for codex's --json stream; anything else fails the batch. */
const CODEX_EVENTS = new Set(['thread.started', 'turn.started', 'item.started', 'item.updated', 'item.completed', 'turn.completed']);
const CODEX_TEXT_ITEMS = new Set(['agent_message', 'reasoning']);
/** The one notice codex emits before the turn because code mode is disabled. */
const CODE_MODE_NOTICE = /^Code Mode is unavailable because code-mode host is disabled/;
/**
 * Log target that records every tool call, including sub-agent threads. It names only
 * the tool and thread, never arguments or message text.
 */
export const CODEX_TOOL_LOG = 'codex_core::stream_events_utils=info';

/**
 * Fails closed: the --json stream must contain only a pure text answer, and codex's own
 * log must record no tool call. Many tool calls (code mode, sub-agents) never appear in
 * the --json stream, so the log is the authoritative signal. This runs after the fact:
 * it keeps an injected tool call from affecting results, while the disabled features
 * keep those calls from reaching anything.
 */
export function assertNoToolUse(jsonl: string, log = ''): void {
  if (/ToolCall: /.test(log)) throw new ToolUseAttempt('Interpreter attempted a tool call; output discarded');
  let inTurn = false;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let event: { type?: string; item?: { type?: string; message?: string } };
    try {
      event = JSON.parse(line);
    } catch {
      throw new ToolUseAttempt('Interpreter emitted an unrecognized event; output discarded');
    }
    if (!event.type || !CODEX_EVENTS.has(event.type)) {
      throw new ToolUseAttempt(`Interpreter emitted ${event.type ?? 'an untyped'} event; output discarded`);
    }
    if (event.type === 'turn.started') inTurn = true;
    const item = event.item;
    if (!item) continue;
    const startupNotice = !inTurn && item.type === 'error' && CODE_MODE_NOTICE.test(item.message ?? '');
    if (!startupNotice && !CODEX_TEXT_ITEMS.has(item.type ?? '')) {
      throw new ToolUseAttempt(`Interpreter emitted a ${item.type ?? 'untyped'} item; output discarded`);
    }
  }
  if (!inTurn) throw new Error('Interpreter never started a turn');
}

/** Codex CLI signed in with a ChatGPT plan: `codex exec` with a strict output schema. */
async function codex(prompt: string, config: Config): Promise<RawOp[]> {
  return withScratch(async (dir) => {
    const schemaFile = path.join(dir, 'schema.json');
    const outFile = path.join(dir, 'out.json');
    fs.writeFileSync(schemaFile, JSON.stringify(OUTPUT_SCHEMA));
    const env = { ...process.env, RUST_LOG: CODEX_TOOL_LOG };
    const { stdout, stderr } = await run(bin('codex'), codexArgs(dir, schemaFile, outFile, config.model, enabledCodexFeatures()), prompt, dir, env);
    assertNoToolUse(stdout, stderr);
    return parseOps(fs.readFileSync(outFile, 'utf8'));
  });
}

/** Claude Code signed in with a Claude plan: `claude -p` with structured output and no tools. */
async function claude(prompt: string, config: Config): Promise<RawOp[]> {
  return withScratch(async (dir) => {
    const { stdout } = await run(bin('claude'), claudeArgs(config.model), prompt, dir, claudeEnv());
    let out: { structured_output?: { ops?: unknown }; result?: unknown };
    try {
      out = JSON.parse(stdout);
    } catch {
      throw new Error('claude returned invalid JSON');
    }
    if (Array.isArray(out.structured_output?.ops)) return out.structured_output.ops as RawOp[];
    return parseOps(String(out.result ?? ''));
  });
}

export function interpreter(config: Config): (prompt: string) => Promise<RawOp[]> {
  const impl = config.interpreter === 'claude' ? claude : codex;
  return (prompt) => impl(inertMentions(prompt), config);
}

/**
 * Interpreter CLIs treat `@path` in a prompt as "attach this file", even with every tool off.
 * Message text is written by other people, so every @ becomes a look-alike (＠) that no CLI
 * acts on but the model still reads as an @.
 */
export const inertMentions = (prompt: string) => prompt.replace(/@/g, '\uFF20');

/** Claude Code's environment: file mentions off too, in case one ever slips through. */
export const claudeEnv = (): NodeJS.ProcessEnv => ({ ...process.env, CLAUDE_CODE_DISABLE_FILE_MENTIONS: '1' });
