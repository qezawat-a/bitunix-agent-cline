import { CONFIG } from '../config.js';

let sharedMemory = null;

export function setBasicMemory(memory) {
  sharedMemory = memory;
}

export const basicTools = [
  {
    name: 'agent_help',
    description: 'Show list of available agent commands',
    parameters: { type: 'object', properties: {} },
    async handler() {
      return {
        commands: ['/help', '/thinking', '/models', '/ask <text>', '/soul', '/skills', '/memory [key]', '/resume', '/start', '/stop', '/settings', '/autotrade', '/scan', '/trades', '/balance', '/pnl', '/close', '/diag'],
        tools: ['trader_xxxx', 'bitunix_xxxx', 'agent_xxxx'],
      };
    },
  },
  {
    name: 'agent_say',
    description: 'Respond in agent style',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    async handler({ text }) {
      return { ok: true, text };
    },
  },
  {
    name: 'agent_settings',
    description: 'Get agent settings',
    parameters: { type: 'object', properties: {} },
    async handler() {
      return {
        name: CONFIG.AGENT_NAME,
        autonomous: CONFIG.AGENT_AUTONOMOUS,
        thinking: CONFIG.AGENT_THINKING_ENABLED,
        maxStep: CONFIG.AGENT_MAX_STEP,
        thinkingBudget: CONFIG.AGENT_THINKING_BUDGET,
        thinkingLevel: CONFIG.AGENT_THINKING_LEVEL,
        autonomous: CONFIG.AGENT_AUTONOMOUS,
        autonomousIntervalSec: CONFIG.AGENT_AUTONOMOUS_INTERVAL_SEC,
        autoCompact: CONFIG.AGENT_AUTO_COMPACT,
      };
    },
  },
  {
    name: 'agent_start',
    description: 'Start agent with new task',
    parameters: { type: 'object', properties: { task: { type: 'string' } } },
    async handler({ task }) {
      return { ok: true, task, started: new Date().toISOString() };
    },
  },
  {
    name: 'agent_stop',
    description: 'Stop agent execution',
    parameters: { type: 'object', properties: {} },
    async handler() {
      CONFIG.auto_trade = false;
      return { ok: true, stopped: new Date().toISOString(), auto_trade: false };
    },
  },
  {
    name: 'agent_soul',
    description: 'Load soul prompt',
    parameters: { type: 'object', properties: {} },
    async handler() {
      try {
        const fs = await import('fs/promises');
        const soul = await fs.readFile('soul/SOUL.md', 'utf8');
        return { soul };
      } catch { return { soul: 'SOUL.md not found' }; }
    },
  },
  {
    name: 'agent_skills',
    description: 'List skills',
    parameters: { type: 'object', properties: {} },
    async handler() {
      try {
        const fs = await import('fs/promises');
        const entries = await fs.readdir('skills');
        const skills = entries.filter(e => e.endsWith('.md'));
        return { skills };
      } catch { return { skills: [] }; }
    },
  },
  {
    name: 'agent_memory',
    description: 'Get/set memory',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        value: { type: ['string', 'object', 'boolean', 'number'] },
      },
    },
    async handler({ key, value }) {
      if (!sharedMemory) return { ok: false, message: 'memory is not ready' };
      if (value !== undefined) {
        await sharedMemory.remember(key, value);
        return { ok: true, key, value };
      }
      return { ok: true, key, value: await sharedMemory.recall(key) };
    },
  },
  {
    name: 'agent_models',
    description: 'List available models',
    parameters: { type: 'object', properties: {} },
    async handler() {
      return {
        models: {
          openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4'],
          anthropic: ['claude-3-5-sonnet', 'claude-3-haiku'],
          google: ['gemini-1.5-pro', 'gemini-1.5-flash'],
        },
      };
    },
  },
];

export default basicTools;