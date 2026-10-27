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
  register: (command: string[]) => void;
  unregister: () => void;
}

const home = os.homedir();

/** Absolute path of a CLI on PATH, or null. */
export function which(name: string): string | null {
  try {
    return execFileSync('/usr/bin/which', [name], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

const quiet = (cmd: string, args: string[]) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
};

/** Apps configured by a JSON file with an `mcpServers` map (Claude Desktop, Cursor). */
export function jsonApp(file: string): Pick<App, 'registered' | 'register' | 'unregister'> {
  const read = (): Record<string, any> => {
    if (!fs.existsSync(file)) return {};
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new Error(`${file} isn't valid JSON; fix or remove it first (not overwriting it)`);
    }
  };
  const write = (config: Record<string, any>) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const backup = `${file}.before-imessage-agent`;
    if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  };
  return {
    registered: () => {
      try {
        return Boolean(read().mcpServers?.[SERVER_NAME]);
      } catch {
        return false;
      }
    },
    register: ([command, ...args]) => {
      const config = read();
      config.mcpServers = { ...config.mcpServers, [SERVER_NAME]: { command, args } };
      write(config);
    },
    unregister: () => {
      const config = read();
      if (!config.mcpServers?.[SERVER_NAME]) return;
      delete config.mcpServers[SERVER_NAME];
      write(config);
    },
  };
}

/** Apps configured through their own CLI (`<cli> mcp add|remove|get`). */
function cliApp(cli: () => string | null, addArgs: string[], removeArgs: string[]): Pick<App, 'registered' | 'register' | 'unregister'> {
  return {
    registered: () => {
      const bin = cli();
      return Boolean(bin && quiet(bin, ['mcp', 'get', SERVER_NAME]));
    },
    register: (command) => {
      const bin = cli();
      if (!bin) throw new Error('CLI not found');
      quiet(bin, ['mcp', 'remove', ...removeArgs, SERVER_NAME]);
      execFileSync(bin, ['mcp', 'add', ...addArgs, SERVER_NAME, '--', ...command], { stdio: ['ignore', 'pipe', 'pipe'] });
    },
    unregister: () => {
      const bin = cli();
      if (bin) quiet(bin, ['mcp', 'remove', ...removeArgs, SERVER_NAME]);
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
    reach: 'Dot reaches your Mac through the ChatGPT desktop app once you allow computer access on its profile',
    installed: () => fs.existsSync('/Applications/ChatGPT.app') || Boolean(codexCli()),
    ...cliApp(codexCli, [], []),
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
