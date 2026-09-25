// agent-commands.js — agent-layer Telegram commands.
// ----------------------------------------------------------------
// These are the commands that belong to the agent itself (skills, MCP,
// diagnostics, AI check) rather than to the trader. The trader's own commands
// stay in telegram-trader.js.
//
// Every handler returns { handled, reply }. Returning handled:false lets the
// caller fall through to the trader commands, and finally to the agent chat —
// which is what CRAG does, so an unrecognised /command or a plain message is
// answered by the agent instead of "Unknown command".
import { CONFIG } from './config.js';
import { listSkills, loadSkill } from './agent/skills.js';
import { mcpServerNames, listMcpTools } from './agent/mcp.js';

export const AGENT_COMMANDS = [
  { command: 'skills', description: 'List agent skills' },
  { command: 'skill', description: 'Read a skill: /skill <id>' },
  { command: 'mcp', description: 'Show MCP servers and their tools' },
  { command: 'harness', description: 'How to drive the agent from outside' },
  { command: 'check_ai', description: 'Test the AI connection' },
  { command: 'tools', description: 'List every tool the agent can call' },
];

export function agentHelpText(agentName = CONFIG.AGENT_NAME) {
  return [
    `<b>${agentName}</b> agent commands:`,
    '/skills - list skills',
    '/skill <id> - read one skill in full',
    '/mcp - MCP servers and their tools',
    '/tools - every tool the agent can call',
    '/check_ai - test the AI connection',
    '/harness - headless agent usage',
    '',
    'Anything else is sent to the agent as a normal message.',
  ].join('\n');
}

function escHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// handleAgentCommand(text, ctx) -> { handled: boolean, reply?: string }
// ctx: { agent, tools, say }
export async function handleAgentCommand(text, ctx = {}) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('/')) return { handled: false };

  const [cmdRaw, ...rest] = raw.slice(1).split(/\s+/);
  const cmd = (cmdRaw || '').toLowerCase().split('@')[0];
  const arg = rest.join(' ').trim();

  try {
    switch (cmd) {
      case 'skills': {
        const skills = listSkills('skills');
        if (!skills.length) return { handled: true, reply: 'No skills loaded (skills/ is empty).' };
        const lines = skills.map(s => `• <b>${escHtml(s.id)}</b>${s.description ? ` — ${escHtml(s.description)}` : ''}`);
        return { handled: true, reply: `<b>Skills (${skills.length})</b>\n${lines.join('\n')}\n\nRead one: /skill <id>` };
      }
      case 'skill': {
        if (!arg) return { handled: true, reply: 'Usage: /skill <id>  (see /skills)' };
        const skill = loadSkill(arg, 'skills');
        if (!skill) {
          const available = listSkills('skills').map(s => s.id);
          return { handled: true, reply: `Skill "${arg}" not found. Available: ${available.join(', ') || 'none'}` };
        }
        return { handled: true, reply: `<b>${escHtml(skill.name)}</b>\n\n${escHtml(skill.body)}` };
      }
      case 'mcp': {
        const servers = mcpServerNames();
        const tools = listMcpTools();
        const lines = [
          `<b>MCP</b>`,
          `Servers: ${servers.length ? servers.join(', ') : '(none configured)'}`,
          `Tools exposed: ${tools.length}`,
        ];
        if (tools.length) lines.push(...tools.map(t => `• ${escHtml(t.name)}`));
        lines.push('', 'Configure in settings.json: mcp.servers = [{ name, command, args }]');
        return { handled: true, reply: lines.join('\n') };
      }
      case 'tools': {
        const tools = ctx.tools || [];
        const lines = tools.map(t => `• ${t.name}`);
        return { handled: true, reply: `<b>Tools (${tools.length})</b>\n${lines.join('\n')}` };
      }
      case 'harness': {
        return {
          handled: true,
          reply: [
            '<b>Harness</b> — drive the agent headlessly over JSONL:',
            'npm run harness',
            '',
            '{"id":1,"message":"what is my balance?"}',
            '→ {"id":1,"ok":true,"reply":"...","provider":"openai"}',
            '',
            'The harness owns stdin, so run it separately from the interactive TUI.',
          ].join('\n'),
        };
      }
      case 'check_ai': {
        if (typeof ctx.say !== 'function') return { handled: true, reply: 'Agent is not ready yet.' };
        const out = await ctx.say('Reply with a one-line confirmation that you are online.');
        const reply = out?.content ?? String(out);
        return { handled: true, reply: `<b>AI check</b>\n${escHtml(reply)}` };
      }
      default:
        return { handled: false };
    }
  } catch (error) {
    return { handled: true, reply: `Error: ${error.message}` };
  }
}