import 'dotenv/config';
import http from 'http';
import { CONFIG, validate, readSettingsFile, applySettingsFile } from './config.js';
import { BitunixClient } from './bitunix/client.js';
import { BitunixWs } from './bitunix/ws.js';
import Scanner from './bitunix/scanner.js';
import { Trader } from './trader/trader.js';
import { setTraderInstances, setPositionManager } from './trader/agent-tools.js';
import { setBitunixClient } from './bitunix/futures-tools.js';
import { createTraderCommands } from './telegram-trader.js';
import { sendMessage, isOwner, setCommands, esc } from './telegram-bot.js';
import { PositionNotifier } from './trader/notifier.js';
import { createAgent } from './agent/loop.js';
import { buildSystemPrompt } from './prompt.js';
import { basicTools, setBasicMemory } from './agent/basic-tools.js';
import { traderTools } from './trader/agent-tools.js';
import { bitunixTools } from './bitunix/futures-tools.js';
import { Memory } from './agent/memory.js';
import { listSkills } from './agent/skills.js';
import { loadMcpTools, disposeMcpTools } from './agent/mcp.js';
import { loadStore, saveStore, closePersist, didLoadFail, storeStatus } from './store/persist.js';
import { loadSession, saveSession, deleteSession } from './session-store.js';
import { applyPersistedSettings, getPersistentSettings, getTraderSettings, validateSettings } from './trader/settings.js';

async function main() {
  let fileSettings = {};
  try {
    fileSettings = await readSettingsFile();
    applySettingsFile(CONFIG, fileSettings);
  } catch (error) {
    console.warn('[warn] ignoring settings.json:', error.message);
  }
  const missing = validate();
  if (missing.length) console.warn('[warn] missing env:', missing.join(', '));
  const configErrors = validateSettings(getTraderSettings(CONFIG));
  if (configErrors.length) throw new Error(`invalid configuration: ${configErrors.join('; ')}`);

  const stored = await loadStore();
  if (stored.settings) {
    try {
      applyPersistedSettings(CONFIG, stored.settings);
    } catch (error) {
      console.warn('[warn] ignoring invalid persisted settings:', error.message);
    }
  }
  // Only write the store back when the read actually succeeded. If the database
  // was unreachable, loadStore() fell back to an empty local file, and saving
  // here would persist the defaults over the settings that are really stored.
  if (didLoadFail()) {
    console.error('[persistence] store read failed — skipping write-back so stored settings are not overwritten with defaults');
  } else {
    await saveStore({ settings: getPersistentSettings(CONFIG) });
  }
  const bootStore = storeStatus();
  console.log(`[persistence] backend=${bootStore.backend} loadFailed=${bootStore.lastLoadFailed}${bootStore.lastError ? ` (${bootStore.lastError})` : ''}`);

  // Telegram /set, /leverage and /symbol mutate CONFIG in memory. Without an
  // explicit save after each one, every change is lost on the next deploy.
  const persistSettings = async () => {
    try {
      await saveStore({ settings: getPersistentSettings(CONFIG) });
    } catch (error) {
      console.error('settings save error:', error.message);
    }
  };

  const client = new BitunixClient();
  const scanner = new Scanner(client);
  const trader = new Trader(client);
  setTraderInstances(trader, client);
  setPositionManager(trader.positionManager);
  setBitunixClient(client);

  // Position-lifecycle notifications. Without this the bot reported signals
  // only, so entries and exits were completely silent. The notifier diffs the
  // exchange's position list each tick, so it catches every exit — including
  // ones the operator performs directly in the Bitunix app.
  const notifier = new PositionNotifier({ client, settings: CONFIG, send: sendMessage });
  trader.positionManager.notifier = notifier;

  const memory = new Memory();
  await memory.load();
  const skills = await listSkills();
  const mcpServers = Array.isArray(fileSettings.mcp?.servers) ? fileSettings.mcp.servers : [];
  const mcpTools = await loadMcpTools(mcpServers);
  setBasicMemory(memory);
  const tools = [...basicTools, ...traderTools, ...bitunixTools, ...mcpTools];
  const getSystem = () => buildSystemPrompt({ skills, tools, memory: memory.all() });
  const agent = createAgent({ system: getSystem, tools, memory, maxRounds: CONFIG.AGENT_MAX_STEP, history: [], autoCompact: true, thinkingLevel: CONFIG.AGENT_THINKING_LEVEL });

  const { handleCommand, scanState, reportState } = createTraderCommands({
    client,
    scanner,
    trader,
    agent,
    tools,
    loadSession,
    saveSession,
    deleteSession,
    persistSettings,
    notifier,
  });

  if (CONFIG.BITUNIX_API_KEY) {
    try {
      await trader.syncAccountSettings({ apply: CONFIG.auto_trade });
    } catch (error) {
      CONFIG.auto_trade = false;
      scanState.scanOn = false;
      console.error('[safety] account settings verification failed:', error.message);
    }
  }

  const ws = new BitunixWs({
    onPublic: () => {},
    onPrivate: event => { trader.handlePrivateEvent(event).catch(error => console.error('private state refresh error:', error.message)); },
    onError: error => console.error('bitunix websocket error:', error?.message || error),
  });
  try { ws.connectPublic([{ ch: 'tickers', symbol: CONFIG.symbol }]); } catch (error) { console.error('public websocket not started:', error.message); }
  if (CONFIG.BITUNIX_API_KEY) {
    // `tpsl` is the documented private channel name (the server ignores tp_sl).
    try { ws.connectPrivate(['balance', 'order', 'position', 'tpsl']); } catch (error) { console.error('private websocket not started:', error.message); }
  }

  await setCommands().catch(() => {});

  let offset = 0;
  let pollTimer = null;
  async function persistAgentSession(chatId) {
    try { await saveSession(String(chatId), { history: agent.history }); } catch (error) { console.error('session save error:', error.message); }
  }
  async function poll() {
    if (!CONFIG.TELEGRAM_BOT_TOKEN) return;
    try {
      const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/getUpdates?timeout=30&offset=${offset}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(35000) });
      if (!res.ok) throw new Error(`Telegram poll ${res.status}`);
      const data = await res.json();
      for (const upd of data.result || []) {
        const msg = upd.message;
        try {
          if (msg?.text) {
            const text = msg.text.trim();
            if (isOwner(msg)) {
              if (text.startsWith('/')) {
                const handled = await handleCommand(msg, text);
                if (!handled) {
                  const reply = await agent.say(text);
                  await sendMessage(msg.chat.id, esc(reply?.content || 'ok'));
                  await persistAgentSession(msg.chat.id);
                }
              } else {
                const reply = await agent.say(text);
                await sendMessage(msg.chat.id, esc(reply?.content || 'ok'));
                await persistAgentSession(msg.chat.id);
              }
            }
          }
        } catch (error) {
          console.error('telegram update error:', error.message);
        } finally {
          offset = Math.max(offset, upd.update_id + 1);
        }
      }
    } catch (error) {
      console.error('poll error:', error.message);
    }
    if (!stopping) pollTimer = setTimeout(poll, 1000);
  }

  let stopping = false;
  let scanTimer = null;
  async function runScanCycle() {
    if (stopping) return;
    try {
      if (scanState.scanOn) {
        const signal = await trader.scanCycle();
        // Diff the position list before acting on a new signal, so an entry is
        // reported as soon as it appears on the exchange.
        await notifier.sync().catch(() => {});
        if (signal) {
          // scanCycle() only *produces* a signal. Turning it into a live order is
          // a separate step, and it has to happen here: without this call the
          // autonomous loop reports signals to Telegram but never trades, so
          // /autotrade on appears to do nothing.
          if (CONFIG.auto_trade && ['bullish', 'bearish'].includes(signal.signal)) {
            const result = await trader.executeSignal(signal);
            if (result?.executed) {
              console.log(`[trade] ${CONFIG.symbol} ${signal.signal} @ ${result.price}`);
            } else if (result?.reason) {
              console.log(`[trade] skipped: ${result.reason}`);
            }
          }
          if (reportState.reportOn && CONFIG.ALLOWED_USER_ID) {
            await sendMessage(CONFIG.ALLOWED_USER_ID, `<b>${esc(CONFIG.AGENT_NAME)}</b> signal <b>${esc(signal.signal)}</b> <code>${esc(signal.symbol)}</code> @ <code>${esc(String(signal.price ?? signal.lastPrice ?? '-'))}</code>`);
          }
        }
      } else {
        await Promise.allSettled([trader.guard(), trader.midManage(), trader.report()]);
        // Exits still need reporting when scanning is off, e.g. a stop or a
        // liquidation guard closing a position.
        await notifier.sync().catch(() => {});
      }
    } catch (error) {
      console.error('loop error:', error.message);
    } finally {
      if (!stopping) scanTimer = setTimeout(runScanCycle, Math.max(1000, CONFIG.scan_interval_sec * 1000));
    }
  }

  if (CONFIG.TELEGRAM_BOT_TOKEN) poll();
  else console.warn('[warn] TELEGRAM_BOT_TOKEN missing — telegram disabled');
  runScanCycle();

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: CONFIG.AGENT_NAME, live: true, auto_trade: CONFIG.auto_trade }));
  });
  const port = process.env.PORT || 3000;
  server.listen(port, () => console.log(`[health] :${port}`));

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    if (pollTimer) clearTimeout(pollTimer);
    if (scanTimer) clearTimeout(scanTimer);
    try { await saveStore({ settings: getPersistentSettings(CONFIG) }); } catch (error) { console.error('shutdown save error:', error.message); }
    try { ws.close(); } catch {}
    try { disposeMcpTools(); } catch {}
    try { await closePersist(); } catch {}
    try { server.close(); } catch {}
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log(`[${CONFIG.AGENT_NAME}] started. LIVE=true AUTO_TRADE=${CONFIG.auto_trade ? 'on' : 'off'}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
