import http from 'node:http';
import readline from 'node:readline';

/** Shown to the agent (and in app logs) when the background service isn't reachable. */
export const SERVICE_DOWN =
  "imessage-agent's background service isn't running on this Mac. On the Mac, run `node src/cli.ts doctor` " +
  'in the imessage-agent-mcp folder (or `node src/cli.ts setup` to reinstall it).';

interface JsonRpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  result?: { protocolVersion?: string };
}

/**
 * `connect`: the stdio MCP server that desktop apps (ChatGPT/Codex, Claude Desktop, Claude
 * Code, …) launch. It holds no permissions and reads nothing itself; it relays each JSON-RPC
 * message to the background service's Unix socket and writes the reply back. This is why
 * only the service needs Full Disk Access, not every app.
 */
export function bridge(sock: string, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  let protocolVersion: string | undefined;
  const write = (msg: unknown) => output.write(JSON.stringify(msg) + '\n');
  const pending = new Set<Promise<void>>();

  const forward = (msg: JsonRpc, body: string) =>
    new Promise<void>((resolve) => {
      const fail = (message: string) => {
        if (msg.id !== undefined && msg.method) write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message } });
        resolve();
      };
      const req = http.request(
        {
          socketPath: sock,
          path: '/mcp',
          method: 'POST',
          headers: {
            host: 'localhost',
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}),
          },
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (d) => (data += d));
          res.on('end', () => {
            if (!data.trim()) return resolve(); // 202 for notifications.
            let reply: JsonRpc | JsonRpc[];
            try {
              reply = JSON.parse(data);
            } catch {
              return fail('imessage-agent service returned an unreadable response');
            }
            for (const r of Array.isArray(reply) ? reply : [reply]) {
              if (msg.method === 'initialize' && r.result?.protocolVersion) protocolVersion = r.result.protocolVersion;
              write(r);
            }
            resolve();
          });
        },
      );
      req.on('error', () => fail(SERVICE_DOWN));
      req.end(body);
    });

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg: JsonRpc;
      try {
        msg = JSON.parse(line);
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      const p = forward(msg, line).finally(() => pending.delete(p));
      pending.add(p);
    });
    rl.on('close', () => Promise.allSettled(pending).then(() => resolve()));
  });
}

export interface ServiceHealth {
  ok: boolean;
  interpreter: string;
  canReadMessages: boolean;
  messages: number;
  contacts: number;
}

/** GET /health from the service, or null if it isn't running. */
export function serviceHealth(sock: string): Promise<ServiceHealth | null> {
  return new Promise((resolve) => {
    const req = http.get({ socketPath: sock, path: '/health', headers: { host: 'localhost' }, timeout: 15_000 }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => req.destroy());
  });
}
