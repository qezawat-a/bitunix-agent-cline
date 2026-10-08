// agent/tui.js — the `npm run agent` entry point: an interactive terminal chat
// with the agent, plus local commands for settings, skills, MCP and diagnostics.
import { CONFIG } from '../config.js';
import { listSkills, loadSkill } from './skills.js';
import { mcpServerNames, listMcpTools } from './mcp.js';
import { buildRuntime } from './runtime.js';
import { startTui, formatSettings, formatStatus, getSetting, setSetting } from '../ui/tui.js';

const { agent, tools } = await buildRuntime();

const HELP = [
  'Commands:',
  '  /help                 this list',
  '  /status               agent + trading status',
  '  /settings             all trading settings',
  '  /get <key>            read one setting',
  '  /set <key> <value>    change one setting (validated)',
  '  /skills               list skills',
  '  /skill <id>           read a skill in full',
  '  /mcp                  MCP servers and tools',
  '  /tools                every tool the agent can call',
  '  /clear                clear conversation history',
  '  /quit                 exit',
  '',
  'Anything else is sent to the agent.',
].join('\n');

startTui({
  async handleInput(text) {
    const [cmdRaw, ...rest] = text.split(/\s+/);
    const cmd = (cmdRaw || '').toLowerCase();
    const arg = rest.join(' ').trim();

    switch (cmd) {
      case '/help':
        return HELP;
      case '/status':
        return formatStatus();
      case '/settings':
        return formatSettings();
      case '/get':
        return getSetting(arg);
      case '/set': {
        const [key, ...valueParts] = rest;
        return setSetting(key, valueParts.join(' '));
      }
      case '/skills': {
        const skills = listSkills('skills');
        if (!skills.length) return 'No skills loaded.';
        return skills.map(s => `${s.id}${s.description ? ` — ${s.description}` : ''}`).join('\n');
      }
      case '/skill': {
        if (!arg) return 'Usage: /skill <id>  (see /skills)';
        const skill = loadSkill(arg, 'skills');
        if (!skill) {
          const available = listSkills('skills').map(s => s.id);
          return `Skill "${arg}" not found. Available: ${available.join(', ') || 'none'}`;
        }
        return `${skill.name}\n\n${skill.body}`;
      }
      case '/mcp': {
        const servers = mcpServerNames();
        const mcpTools = listMcpTools();
        const lines = [
          `servers: ${servers.length ? servers.join(', ') : '(none configured)'}`,
          `tools: ${mcpTools.length}`,
        ];
        if (mcpTools.length) lines.push(...mcpTools.map(t => `- ${t.name}`));
        return lines.join('\n');
      }
      case '/tools':
        return `${tools.length} tools:\n${tools.map(t => `- ${t.name}`).join('\n')}`;
      case '/clear':
        agent.history.length = 0;
        return 'History cleared.';
      case '/thinking':
        if (arg) {
          CONFIG.AGENT_THINKING_LEVEL = arg;
          agent.thinkingLevel = arg;
          return `thinking level = ${arg}`;
        }
        return `thinking level = ${CONFIG.AGENT_THINKING_LEVEL || 'mid'}`;
      default:
        return (await agent.say(text)).content;
    }
  },
});
