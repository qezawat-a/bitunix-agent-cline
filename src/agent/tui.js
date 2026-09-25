import { createAgent } from './loop.js';
import { CONFIG, readSettingsFile, applySettingsFile } from '../config.js';
import { basicTools } from './basic-tools.js';
import { buildSystemPrompt } from '../prompt.js';
import { formatSettings, formatStatus, startTui } from '../ui/tui.js';

try {
  applySettingsFile(CONFIG, await readSettingsFile());
} catch {}

const system = await buildSystemPrompt({ tools: basicTools });
const agent = createAgent({ system, tools: basicTools, thinkingLevel: CONFIG.AGENT_THINKING_LEVEL });

startTui({
  async handleInput(text) {
    if (text === '/help') return 'Send a message, or use /settings, /status, /quit.';
    if (text === '/settings' || text === '/tsettings') return formatSettings();
    if (text === '/status' || text === '/tstatus') return formatStatus();
    const reply = await agent.say(text);
    return reply.content;
  },
});
