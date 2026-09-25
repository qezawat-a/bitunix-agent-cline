import { spawn } from 'child_process';

const activeChildren = new Set();
let nextId = 0;

function serverEnvironment(server) {
  const environment = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'NODE_PATH']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  if (server.env && typeof server.env === 'object' && !Array.isArray(server.env)) {
    for (const [key, value] of Object.entries(server.env)) environment[key] = String(value);
  }
  return environment;
}

function sendJsonRpc(proc, method, params = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const message = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
    let buffer = '';
    let settled = false;
    let timer;
    const cleanup = () => {
      proc.stdout.off('data', onData);
      proc.off('error', onError);
      proc.off('exit', onExit);
      clearTimeout(timer);
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const finish = value => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onData = data => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let response;
        try { response = JSON.parse(line); } catch { continue; }
        if (response.id !== id) continue;
        if (response.error) {
          fail(new Error(`MCP ${method} failed: ${response.error.message || 'unknown error'}`));
          return;
        }
        finish(response.result);
        return;
      }
    };
    const onError = error => fail(error);
    const onExit = (code, signal) => {
      if (!settled) fail(new Error(`MCP process exited (${code ?? signal ?? 'unknown'})`));
    };
    proc.stdout.on('data', onData);
    proc.on('error', onError);
    proc.on('exit', onExit);
    timer = setTimeout(() => {
      fail(new Error('MCP timeout'));
      try { proc.kill(); } catch {}
    }, timeoutMs);
    try { proc.stdin.write(message); } catch (error) { fail(error); }
  });
}

function sendNotification(proc, method, params = {}) {
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

export function disposeMcpTools() {
  for (const child of activeChildren) {
    try { child.kill(); } catch {}
  }
  activeChildren.clear();
}

export async function loadMcpTools(servers = []) {
  const tools = [];
  for (const server of servers) {
    try {
      const loaded = await connectMcpServer(server);
      tools.push(...loaded);
    } catch (error) {
      console.error(`MCP server ${server.name} failed:`, error.message);
    }
  }
  return tools;
}

async function connectMcpServer(server) {
  if (!server || typeof server.command !== 'string' || !server.command.trim()) throw new Error('MCP command is required');
  const proc = spawn(server.command, Array.isArray(server.args) ? server.args.map(String) : [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: serverEnvironment(server),
  });
  activeChildren.add(proc);
  proc.stderr.on('data', () => {});
  proc.once('close', () => activeChildren.delete(proc));
  try {
    await sendJsonRpc(proc, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'j-rock', version: '1.0.0' },
    });
    sendNotification(proc, 'notifications/initialized');
    const list = await sendJsonRpc(proc, 'tools/list');
    return (list?.tools || []).map(tool => ({
      name: `mcp_${server.name}_${tool.name}`,
      description: tool.description || `MCP ${server.name} tool ${tool.name}`,
      parameters: tool.inputSchema || { type: 'object', properties: {} },
      async handler(args) {
        return sendJsonRpc(proc, 'tools/call', { name: tool.name, arguments: args });
      },
    }));
  } catch (error) {
    try { proc.kill(); } catch {}
    activeChildren.delete(proc);
    throw error;
  }
}
