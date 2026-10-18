// runtime.js — builds the fully-wired agent used by the TUI and the harness.
// Single place where tools, skills, memory and MCP are assembled, so the TUI and
// the harness behave identically instead of each wiring their own subset.
import { CONFIG, readSettingsFile, applySettingsFile } from '../config.js';
import { BitunixClient } from '../bitunix/client.js';
import { setBitunixClient, bitunixTools } from '../bitunix/futures-tools.js';
import { basicTools, setBasicMemory } from './basic-tools.js';
import { Memory } from './memory.js';
import { listSkills } from './skills.js';
import { loadMcpTools, disposeMcpTools, mcpServerNames, listMcpTools } from './mcp.js';
import { createAgent } from './loop.js';
import { buildSystemPrompt } from '../prompt.js';

export async function buildRuntime({ withMcp = true, withExchangeTools = true, mcpServers = null } = {}) {
  try {
    applySettingsFile(CONFIG, await readSettingsFile());
  } catch {}

  const client = new BitunixClient();
  setBitunixClient(client);

  const memory = new Memory();
  await memory.load();
  setBasicMemory(memory);

  const skills = listSkills('skills');
  const servers = mcpServers ?? (Array.isArray(CONFIG.mcpServers) ? CONFIG.mcpServers : []);
  const mcpTools = withMcp ? await loadMcpTools(servers) : [];
  const tools = [...basicTools, ...(withExchangeTools ? bitunixTools : []), ...mcpTools];

  const agent = createAgent({
    system: () => buildSystemPrompt({ skills, tools, memory: memory.all() }),
    tools,
    memory,
    maxRounds: CONFIG.AGENT_MAX_STEP,
    history: [],
    autoCompact: true,
    thinkingLevel: CONFIG.AGENT_THINKING_LEVEL,
  });

  return { agent, client, memory, skills, tools, mcpTools, disposeMcpTools, mcpServerNames, listMcpTools };
}

export default buildRuntime;