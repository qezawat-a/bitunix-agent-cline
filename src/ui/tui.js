import readline from 'readline';
import { CONFIG } from '../config.js';
import { getTraderSettings, applySettings, parseSettingValue, resolveSettingKey } from '../trader/settings.js';

const COMMANDS = [
  '/help', '/quit', '/status', '/settings', '/get <key>', '/set <key> <value>',
  '/skills', '/skill <id>', '/mcp', '/tools', '/models', '/thinking <level>',
  '/memory [key]', '/clear',
];

export function startTui({ input = process.stdin, output = process.stdout, handleInput } = {}) {
  const rl = readline.createInterface({ input, output, prompt: 'j-rock> ' });
  // Prompting a closed interface throws ERR_USE_AFTER_CLOSE, which happens when
  // a command (or a signal) closes the readline while an async handler is running.
  const safePrompt = () => { if (!rl.closed) rl.prompt(); };
  output.write(`J-ROCK TUI — agent=${CONFIG.AGENT_NAME} auto=${CONFIG.auto_trade ? 'on' : 'off'}\n`);
  output.write(`Commands: ${COMMANDS.join('  ')}\n`);
  output.write('Anything else goes to the agent.\n\n');
  safePrompt();
  // Piped input emits every line in one tick, so handlers must run strictly in
  // order. Queue them instead of dropping work when the interface closes early.
  let queue = Promise.resolve();
  rl.on('line', line => {
    queue = queue.then(async () => {
      const text = line.trim();
      if (!text) return;
      if (text === '/quit' || text === '/exit') {
        rl.close();
        return;
      }
      try {
        const response = await handleInput(text);
        if (response !== undefined && response !== null) output.write(`${response}\n`);
      } catch (error) {
        output.write(`Error: ${error.message}\n`);
      }
    });
    // Re-prompt only while the interface is still open; prompting a closed
    // interface throws ERR_USE_AFTER_CLOSE.
    safePrompt();
  });
  rl.on('close', () => output.write('bye\n'));
  return rl;
}

export function formatStatus() {
  return [
    `agent=${CONFIG.AGENT_NAME}`,
    `symbol=${CONFIG.symbol}`,
    `leverage=${CONFIG.leverage}`,
    `auto_trade=${CONFIG.auto_trade ? 'on' : 'off'}`,
    `autonomous=${CONFIG.AGENT_AUTONOMOUS ? 'on' : 'off'}`,
    `thinking=${CONFIG.AGENT_THINKING_ENABLED ? 'on' : 'off'} (${CONFIG.AGENT_THINKING_LEVEL || 'mid'})`,
  ].join('\n');
}

export function formatSettings() {
  return Object.entries(getTraderSettings(CONFIG))
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : value}`)
    .join('\n');
}

// getSetting(key) — read one validated trader setting
export function getSetting(key) {
  const all = getTraderSettings(CONFIG);
  const wanted = resolveSettingKey(key);
  if (!wanted) return formatSettings();
  if (!(wanted in all)) return `Unknown setting "${wanted}". Try /settings for the full list.`;
  const value = all[wanted];
  return `${wanted}=${Array.isArray(value) ? value.join(',') : value}`;
}

// setSetting(key, raw) — applySettings normalises first and only commits after
// validateSettings passes, so a bad value never reaches the live CONFIG.
export function setSetting(key, raw) {
  const wanted = String(key || '').trim();
  if (!wanted) return 'Usage: /set <key> <value>';
  try {
    const value = parseSettingValue(wanted, raw);
    const applied = applySettings(CONFIG, { [wanted]: value });
    const canonical = resolveSettingKey(wanted);
    const result = canonical in applied ? applied[canonical] : value;
    return `OK ${wanted}=${Array.isArray(result) ? result.join(',') : result}`;
  } catch (error) {
    return `Rejected: ${error.message}`;
  }
}
