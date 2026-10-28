// Registers the `connect` bridge with the AI apps installed on this Mac. Each app launches
// the bridge itself, locally; nothing is exposed to the network.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SERVER_NAME = 'imessage';

export interface App {
  id: string;
  name: string;
  /** How a cloud agent reaches it, for the setup summary. */
  reach: string;
  installed: () => boolean;
  registered: () => boolean;
  /** Whether it's connected to this copy's bridge (and not, say, a clone the app replaced). */
  connectedTo: (cli: string) => boolean;
  register: (command: string[]) => void;
  unregister: () => void;
}

const home = os.homedir();

/** Absolute path of a CLI on PATH, or null. */
export function which(name: string): string | null {
  try {
    return execFileSync('/usr/bin/which', [name], { encoding: 'utf8', timeout: 10_000 }).trim() || null;
  } catch {
    return null;
  }
}

const quiet = (cmd: string, args: string[]) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
  } catch {
    return null;
  }
};

const isPlainObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Whether a configured server is this project's bridge, so we never replace or remove someone else's. */
const isBridge = (text: string) => /cli\.ts\b/.test(text) && /\bconnect\b/.test(text);

const NOT_OURS = `an unrelated MCP server named "${SERVER_NAME}" is already configured; rename or remove it first`;

/** Apps configured by a JSON file with an `mcpServers` map (Claude Desktop, Cursor). */
export function jsonApp(file: string): Pick<App, 'registered' | 'connectedTo' | 'register' | 'unregister'> {
  const read = (): Record<string, any> => {
    if (!fs.existsSync(file)) return {};
    let config: unknown;
    try {
      config = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new Error(`${file} isn't valid JSON; fix or remove it first (not overwriting it)`);
    }
    if (!isPlainObject(config) || (config.mcpServers !== undefined && !isPlainObject(config.mcpServers))) {
      throw new Error(`${file} has an unexpected shape; not changing it`);
    }
    return config;
  };
  const entry = (config: Record<string, any>) => config.mcpServers?.[SERVER_NAME];
  const ours = (e: any) => isPlainObject(e) && isBridge(JSON.stringify([e.command, e.args]));
  const write = (config: Record<string, any>) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  };
  const ourEntry = () => {
    try {
      const e = entry(read());
      return ours(e) ? JSON.stringify([e.command, e.args]) : null;
    } catch {
      return null;
    }
  };
  return {
    registered: () => ourEntry() !== null,
    connectedTo: (cli) => Boolean(ourEntry()?.includes(JSON.stringify(cli))),
    register: ([command, ...args]) => {
      const config = read();
      if (entry(config) && !ours(entry(config))) throw new Error(NOT_OURS);
      // A copy of the file as it was before this project first changed it.
      const backup = `${file}.before-imessage-agent`;
      if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
      config.mcpServers = { ...config.mcpServers, [SERVER_NAME]: { command, args } };
      write(config);
    },
    unregister: () => {
      const config = read();
      if (!ours(entry(config))) return;
      delete config.mcpServers[SERVER_NAME];
      write(config);
    },
  };
}

/** Apps configured through their own CLI (`<cli> mcp add|remove|get`). */
function cliApp(
  cli: () => string | null,
  addArgs: string[],
  removeArgs: string[],
  configFile?: () => string,
): Pick<App, 'registered' | 'connectedTo' | 'register' | 'unregister'> {
  const current = () => {
    const bin = cli();
    return bin ? quiet(bin, ['mcp', 'get', SERVER_NAME]) : null;
  };
  return {
    registered: () => isBridge(current() ?? ''),
    connectedTo: (cli) => {
      const text = current() ?? '';
      return isBridge(text) && text.includes(cli);
    },
    register: (command) => {
      const bin = cli();
      if (!bin) throw new Error('CLI not found');
      const existing = current();
      if (existing && !isBridge(existing)) throw new Error(NOT_OURS);
      const file = configFile?.();
      if (file && fs.existsSync(file) && !fs.existsSync(`${file}.before-imessage-agent`)) fs.copyFileSync(file, `${file}.before-imessage-agent`);
      if (existing) quiet(bin, ['mcp', 'remove', ...removeArgs, SERVER_NAME]);
      execFileSync(bin, ['mcp', 'add', ...addArgs, SERVER_NAME, '--', ...command], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
    },
    unregister: () => {
      const bin = cli();
      if (bin && isBridge(current() ?? '')) quiet(bin, ['mcp', 'remove', ...removeArgs, SERVER_NAME]);
    },
  };
}

/** The Codex CLI, or the copy bundled inside the ChatGPT desktop app. Both use ~/.codex/config.toml. */
function codexCli(): string | null {
  const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/codex';
  return process.env.IMESSAGE_AGENT_CODEX_BIN || which('codex') || (fs.existsSync(bundled) ? bundled : null);
}

const claudeDesktopConfig = path.join(home, 'Library/Application Support/Claude/claude_desktop_config.json');
const cursorConfig = path.join(home, '.cursor/mcp.json');

export const APPS: App[] = [
  {
    id: 'chatgpt',
    name: 'ChatGPT desktop app & Codex (for Dot)',
    reach: 'Dot should reach it through the ChatGPT desktop app once you allow computer access on its profile (not yet verified)',
    installed: () => fs.existsSync('/Applications/ChatGPT.app') || Boolean(codexCli()),
    ...cliApp(codexCli, [], [], () => path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'config.toml')),
  },
  {
    id: 'claude-desktop',
    name: 'Claude desktop app',
    reach: 'Claude uses it from the desktop app on this Mac',
    installed: () => fs.existsSync('/Applications/Claude.app') || fs.existsSync(path.dirname(claudeDesktopConfig)),
    ...jsonApp(claudeDesktopConfig),
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    reach: 'Claude Code sessions on this Mac can use it',
    installed: () => Boolean(process.env.IMESSAGE_AGENT_CLAUDE_BIN || which('claude')),
    ...cliApp(() => process.env.IMESSAGE_AGENT_CLAUDE_BIN || which('claude'), ['--scope', 'user'], ['--scope', 'user']),
  },
  {
    id: 'cursor',
    name: 'Cursor',
    reach: 'Cursor on this Mac can use it',
    installed: () => fs.existsSync('/Applications/Cursor.app') || fs.existsSync(path.dirname(cursorConfig)),
    ...jsonApp(cursorConfig),
  },
];
