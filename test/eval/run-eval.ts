#!/usr/bin/env node
// Live evaluation of the real interpreter CLIs against labeled synthetic conversations.
// Uses your Claude and/or ChatGPT subscription (no API keys); never touches real messages.
//
//   node test/eval/run-eval.ts [--interpreter claude|codex|both] [--runs N]
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const which = opt('interpreter', 'both');
const runs = Number(opt('runs', '1'));
const child = args.includes('--child');
const here = path.dirname(fileURLToPath(import.meta.url));

interface Outcome {
  interpreter: string;
  run: number;
  results: { name: string; phase: number; pass: boolean }[];
  stats: Record<string, number>[];
  error?: string;
  seconds: number;
}

/** One interpreter, one run, in its own state dir (paths are read from env at import time). */
async function evaluate(): Promise<void> {
  const started = Date.now();
  const { buildFixture, rebuildChatDb } = await import('../fixture.ts');
  const { SPEC, PHASE1, PHASE2, PHASE1_NOW, PHASE2_NOW, CHECKS } = await import('./scenarios.ts');
  const dir = path.join(here, '..', '.tmp', `eval-${which}-${opt('run', '0')}`);
  Object.assign(process.env, buildFixture(dir, PHASE1, SPEC));
  const { loadConfig } = await import('../../src/config.ts');
  const { interpretNow } = await import('../../src/interpret/run.ts');
  const { Store } = await import('../../src/store.ts');
  const config = { ...loadConfig(), interpreter: which as 'claude' | 'codex' };
  const outcome: Outcome = { interpreter: which, run: Number(opt('run', '0')), results: [], stats: [], seconds: 0 };
  const score = (phase: 1 | 2) => {
    const store = Store.open();
    const items = store.listItems();
    store.close();
    for (const c of CHECKS.filter((c) => c.phase === phase)) outcome.results.push({ name: c.name, phase, pass: c.pass(items) });
  };
  try {
    outcome.stats.push((await interpretNow({ config, now: PHASE1_NOW })) as unknown as Record<string, number>);
    score(1);
    rebuildChatDb(dir, [...PHASE1, ...PHASE2], SPEC);
    outcome.stats.push((await interpretNow({ config, now: PHASE2_NOW })) as unknown as Record<string, number>);
    score(2);
  } catch (err: any) {
    outcome.error = String(err.message ?? err);
  }
  outcome.seconds = Math.round((Date.now() - started) / 1000);
  process.stdout.write(JSON.stringify(outcome));
}

function runChild(interpreter: string, run: number): Promise<Outcome> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', '--interpreter', interpreter, '--run', String(run)], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => {
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve({ interpreter, run, results: [], stats: [], error: 'child produced no result', seconds: 0 });
      }
    });
  });
}

async function main(): Promise<void> {
  if (child) return evaluate();
  const interpreters = which === 'both' ? ['claude', 'codex'] : [which];
  const jobs = interpreters.flatMap((i) => Array.from({ length: runs }, (_, r) => runChild(i, r)));
  console.error(`Running ${jobs.length} evaluation(s) in parallel: ${interpreters.join(', ')} × ${runs}…`);
  const outcomes = await Promise.all(jobs);

  const names = [...new Set(outcomes.flatMap((o) => o.results.map((r) => `${r.phase}|${r.name}`)))];
  const header = ['Phase', 'Check', ...interpreters.map((i) => `${i} (${runs})`)];
  const rows = names.map((key) => {
    const [phase, name] = key.split('|');
    return [phase, name, ...interpreters.map((i) => {
      const mine = outcomes.filter((o) => o.interpreter === i);
      const passed = mine.filter((o) => o.results.find((r) => `${r.phase}|${r.name}` === key)?.pass).length;
      return passed === mine.length ? `✅ ${passed}/${mine.length}` : `❌ ${passed}/${mine.length}`;
    })];
  });
  const widths = header.map((_, c) => Math.max(...[header, ...rows].map((r) => [...r[c]].length)));
  const fmt = (r: string[]) => r.map((cell, c) => cell + ' '.repeat(widths[c] - [...cell].length)).join('  ');
  console.log(fmt(header));
  for (const r of rows) console.log(fmt(r));
  console.log('');
  let failed = false;
  for (const i of interpreters) {
    const mine = outcomes.filter((o) => o.interpreter === i);
    const total = mine.reduce((n, o) => n + o.results.length, 0);
    const passed = mine.reduce((n, o) => n + o.results.filter((r) => r.pass).length, 0);
    const discarded = mine.reduce((n, o) => n + o.stats.reduce((m, s) => m + (s.discardedBatches ?? 0), 0), 0);
    const secs = mine.map((o) => o.seconds);
    console.log(`${i}: ${passed}/${total} checks passed · ${discarded} batch(es) discarded · ${Math.min(...secs)}–${Math.max(...secs)}s per run`);
    for (const o of mine.filter((o) => o.error)) console.log(`  run ${o.run} error: ${o.error}`);
    if (passed < total || mine.some((o) => o.error)) failed = true;
  }
  process.exitCode = failed ? 1 : 0;
}

main();
