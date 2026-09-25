import readline from 'readline';
import { CONFIG } from '../config.js';
import { getTraderSettings } from '../trader/settings.js';

export function startTui({ input = process.stdin, output = process.stdout, handleInput } = {}) {
  const rl = readline.createInterface({ input, output, prompt: 'j-rock> ' });
  output.write(`J-ROCK TUI — agent=${CONFIG.AGENT_NAME} mode=LIVE\n`);
  output.write('Commands: /help /settings /status /quit\n');
  rl.prompt();
  rl.on('line', async line => {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      return;
    }
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
    rl.prompt();
  });
  rl.on('close', () => output.write('bye\n'));
  return rl;
}

export function formatStatus() {
  return `symbol=${CONFIG.symbol} lev=${CONFIG.leverage} mode=LIVE auto=${CONFIG.auto_trade ? 'on' : 'off'}`;
}

export function formatSettings() {
  return Object.entries(getTraderSettings(CONFIG)).map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : value}`).join('\n');
}
