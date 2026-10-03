import { CONFIG, parseBoolean } from './config.js';
import { sendMessage, isOwner, esc, formatSignalReport } from './telegram-bot.js';
import { applySettings, getTraderSettings, parseSettingValue, validateSettings } from './trader/settings.js';
import { formatPositions } from './trader/notifier.js';
import { parseThinkingLevel } from './agent/thinking.js';
import { detectProviders } from './agent/config.js';
import { listOpenAiModels } from './agent/brain.js';
import { storeStatus } from './store/persist.js';

function usage(chatId, text) {
  return sendMessage(chatId, text).then(() => true);
}

function markCooldown(trader) {
  if (trader?.state) trader.state.cooldownUntil = Date.now() + Number(CONFIG.cooldown_minutes) * 60000;
}

export function createTraderCommands({ client, scanner, trader, agent, tools = [], loadSession = null, saveSession = null, deleteSession = null, persistSettings = null, notifier = null }) {
  const scanState = { scanOn: true };
  const reportState = { reportOn: true };
  // Settings live in CONFIG in memory; without an explicit write after every
  // change they are lost whenever the process restarts or is redeployed.
  const save = async () => {
    if (persistSettings) await persistSettings();
  };

  async function handleCommand(msg, text) {
    const chatId = msg.chat.id;
    if (!isOwner(msg)) {
      await sendMessage(chatId, 'Not authorized.');
      return true;
    }
    const [cmdRaw, ...rest] = text.trim().split(/\s+/);
    const cmd = cmdRaw.replace(/^\//, '').split('@')[0];
    const arg = rest.join(' ');

    try {
      switch (cmd) {
        case 'start': {
          await sendMessage(chatId, `<b>${esc(CONFIG.AGENT_NAME)}</b> started. LIVE mode; AUTO_TRADE=<code>${CONFIG.auto_trade ? 'on' : 'off'}</code>. Use /autotrade on only when ready.`);
          return true;
        }
        case 'stop': {
          CONFIG.auto_trade = false;
          scanState.scanOn = false;
          // Persist the stop so a restart does not bring auto-trade back.
          await save();
          await sendMessage(chatId, 'Auto-trade and autonomous scans stopped.');
          return true;
        }
        case 'help': {
          await sendMessage(chatId, '<b>Commands</b>\n/start /stop /status /help /settings /set /get /signal /balance /positions /trades /pnl /close &lt;symbol&gt; &lt;positionId&gt; /close_all &lt;symbol&gt; confirm /autotrade /scan /report /leverage /symbol /margin_mode /position_mode /order_unit /position_sizing /models /thinking /memory /resume /reset /ask /skills /skill /mcp /tools /diag');
          return true;
        }
        case 'status': {
          await sendMessage(chatId, `<b>Status</b>\nsymbol <code>${esc(CONFIG.symbol)}</code>\nlev <code>${CONFIG.leverage}</code> ${esc(CONFIG.position_type)}/${esc(CONFIG.position_mode)}\nLIVE <code>enabled</code> auto_trade <code>${CONFIG.auto_trade ? 'on' : 'off'}</code>\nscan <code>${scanState.scanOn ? 'on' : 'off'}</code> report <code>${reportState.reportOn ? 'on' : 'off'}</code>\nopen <code>${trader?.state?.positions?.length ?? 0}</code>`);
          return true;
        }
        case 'settings': {
          const settings = getTraderSettings(CONFIG);
          const rows = Object.entries(settings).map(([k, v]) => `${esc(k)}: <code>${esc(Array.isArray(v) ? v.join(',') : String(v))}</code>`).join('\n');
          await sendMessage(chatId, `<b>Settings</b>\n${rows}`);
          return true;
        }
        case 'set': {
          const [key, ...parts] = rest;
          if (!key || !parts.length) return usage(chatId, 'Usage: /set key value');
          const value = parseSettingValue(key, parts.join(' '));
          if (key === 'symbol' && String(value).toUpperCase() !== CONFIG.symbol) {
            const positions = await client.getPendingPositions(CONFIG.symbol);
            if (!Array.isArray(positions) || positions.length) return usage(chatId, 'Cannot change symbol while positions are open.');
          }
          applySettings(CONFIG, { [key]: value });
          await save();
          await sendMessage(chatId, `Set <code>${esc(key)}</code> = <code>${esc(String(value))}</code>`);
          return true;
        }
        case 'get': {
          const settings = getTraderSettings(CONFIG);
          const key = rest[0];
          if (!key || !Object.hasOwn(settings, key)) return usage(chatId, 'Unknown setting.');
          await sendMessage(chatId, `<code>${esc(key)}</code> = <code>${esc(String(settings[key]))}</code>`);
          return true;
        }
        case 'signal': {
          const sym = arg || CONFIG.symbol;
          const res = await scanner.scan(sym);
          await sendMessage(chatId, formatSignalReport(res));
          return true;
        }
        case 'balance': {
          const acc = await client.getAccount('USDT');
          await sendMessage(chatId, `<b>Balance</b>\n<code>${esc(JSON.stringify(acc, null, 1))}</code>`);
          return true;
        }
        case 'positions': {
          const [positions, tpsl] = await Promise.all([
            client.getPendingPositions(CONFIG.symbol).catch(() => []),
            client.getPendingTPSL(CONFIG.symbol).catch(() => []),
          ]);
          await sendMessage(chatId, `<b>Positions</b>\n${formatPositions(positions, tpsl)}`);
          return true;
        }
        case 'trades': {
          const [o, p] = await Promise.all([client.getHistoryOrders(CONFIG.symbol), client.getHistoryPositions(CONFIG.symbol)]);
          await sendMessage(chatId, `<b>Orders</b>\n<code>${esc(JSON.stringify(o, null, 1).slice(0, 2000))}</code>\n<b>Positions</b>\n<code>${esc(JSON.stringify(p, null, 1).slice(0, 1500))}</code>`);
          return true;
        }
        case 'pnl': {
          const [positions, tpsl] = await Promise.all([
            client.getPendingPositions(CONFIG.symbol).catch(() => []),
            client.getPendingTPSL(CONFIG.symbol).catch(() => []),
          ]);
          await sendMessage(chatId, `<b>PnL</b>\n${formatPositions(positions, tpsl)}`);
          return true;
        }
        case 'close': {
          const [symbol, positionId] = rest;
          if (!symbol || !positionId) return usage(chatId, 'Usage: /close SYMBOL POSITION_ID');
          const res = await client.closePosition(symbol.toUpperCase(), positionId);
          markCooldown(trader);
          await sendMessage(chatId, `Closed position: <code>${esc(JSON.stringify(res))}</code>`);
          // Label the exit as manual so the lifecycle notification does not
          // report it as an unexplained exchange-side close.
          notifier?.noteClose(positionId, 'manual');
          await notifier?.sync().catch(() => {});
          return true;
        }
        case 'close_all': {
          const [symbol, confirmation] = rest;
          if (!symbol || confirmation?.toLowerCase() !== 'confirm') return usage(chatId, 'Usage: /close_all SYMBOL confirm');
          // Label every open position before the close-all so each exit message
          // carries a reason.
          const open = await client.getPendingPositions(symbol.toUpperCase()).catch(() => []);
          for (const position of Array.isArray(open) ? open : []) {
            notifier?.noteClose(position.positionId, 'manual');
          }
          const res = await client.closeAllPosition(symbol.toUpperCase());
          markCooldown(trader);
          await sendMessage(chatId, `Closed all positions: <code>${esc(JSON.stringify(res))}</code>`);
          await notifier?.sync().catch(() => {});
          return true;
        }
        case 'autotrade': {
          const next = parseBoolean(arg, !CONFIG.auto_trade, 'autotrade');
          if (next) {
            // Align the exchange with the configured leverage/margin/position
            // mode before granting trading authority. verifyAccountSettings()
            // throws on a mismatch, so a silent mismatch can never be reported
            // back to the user as a successful enable.
            if (trader?.syncAccountSettings) {
              try {
                await trader.syncAccountSettings({ apply: true });
              } catch (error) {
                return usage(chatId, `Cannot enable: ${esc(error.message)}`);
              }
            }
            scanState.scanOn = true;
          }
          CONFIG.auto_trade = next;
          // Persist the new authority state when the operator opted in.
          await save();
          await sendMessage(chatId, `AUTO_TRADE=<code>${CONFIG.auto_trade ? 'on' : 'off'}</code>`);
          return true;
        }
        case 'scan': {
          scanState.scanOn = parseBoolean(arg, !scanState.scanOn, 'scan');
          await sendMessage(chatId, `scan <code>${scanState.scanOn ? 'on' : 'off'}</code>`);
          return true;
        }
        case 'report': {
          reportState.reportOn = parseBoolean(arg, !reportState.reportOn, 'report');
          await sendMessage(chatId, `report <code>${reportState.reportOn ? 'on' : 'off'}</code>`);
          return true;
        }
        case 'leverage': {
          const lev = Number(arg);
          if (!Number.isInteger(lev)) return usage(chatId, 'Usage: /leverage 10');
          const next = { ...getTraderSettings(CONFIG), leverage: lev };
          const errors = validateSettings(next);
          if (errors.length) return usage(chatId, `Invalid leverage: ${esc(errors[0])}`);
          // The accepted band is published per symbol on trading_pairs and is
          // different for every contract, so ask the exchange rather than
          // assuming one. This is a read-only public call, and a failure here
          // must not block a legitimate change — changeLeverage is still the
          // authority and will reject an out-of-band value.
          let band = null;
          try {
            const pairs = await client.getTradingPairs(CONFIG.symbol);
            const pair = (Array.isArray(pairs) ? pairs : [])
              .find(item => String(item?.symbol || '').toUpperCase() === String(CONFIG.symbol).toUpperCase());
            if (pair && Number.isFinite(Number(pair.maxLeverage))) {
              band = { min: Number(pair.minLeverage) || 1, max: Number(pair.maxLeverage) };
            }
          } catch { /* fall through: no band to show, still try the change */ }
          if (band && (lev < band.min || lev > band.max)) {
            return usage(chatId, `${CONFIG.symbol} allows leverage ${band.min}-${band.max}`);
          }
          await client.changeLeverage(CONFIG.symbol, lev);
          applySettings(CONFIG, { leverage: lev });
          await save();
          await sendMessage(chatId, `leverage <code>${lev}</code>`);
          return true;
        }
        case 'symbol': {
          if (!arg) return usage(chatId, 'Usage: /symbol BTCUSDT');
          const symbol = arg.toUpperCase();
          if (!/^[A-Z0-9]{5,32}$/.test(symbol)) return usage(chatId, 'Invalid symbol.');
          const positions = await client.getPendingPositions(CONFIG.symbol);
          if (!Array.isArray(positions) || positions.length) return usage(chatId, 'Cannot change symbol while positions are open.');
          applySettings(CONFIG, { symbol });
          await save();
          await sendMessage(chatId, `symbol <code>${esc(CONFIG.symbol)}</code>`);
          return true;
        }
        case 'models': {
          const provider = detectProviders();
          if (provider === 'openai') {
            const models = await listOpenAiModels();
            const configured = String(CONFIG.AI_MODEL || '').toUpperCase() === 'AUTO' || !CONFIG.AI_MODEL
              ? 'auto-detect'
              : models.includes(CONFIG.AI_MODEL) ? 'configured' : 'not found';
            await sendMessage(chatId, `<b>OpenAI-compatible models</b>\nconfigured: <code>${esc(CONFIG.AI_MODEL)}</code> (${configured})\n${models.slice(0, 40).map(model => `<code>${esc(model)}</code>`).join('\n')}`);
          } else {
            await sendMessage(chatId, `anthropic: <code>${esc(CONFIG.ANTHROPIC_MODEL)}</code>\ngoogle: <code>${esc(CONFIG.GEMINI_MODEL)}</code>`);
          }
          return true;
        }
        case 'thinking': {
          const level = parseThinkingLevel(arg);
          if (!arg || level === 'mid' && arg.toLowerCase() !== 'mid') return usage(chatId, 'Usage: /thinking off|low|mid|high|max');
          CONFIG.AGENT_THINKING_ENABLED = level !== 'off';
          if (agent) agent.thinkingLevel = level;
          await sendMessage(chatId, `thinking <code>${esc(level)}</code>`);
          return true;
        }
        case 'memory': {
          await sendMessage(chatId, `memory keys: <code>${esc(Object.keys(agent?.memory?.all?.() || {}).join(', ') || '-')}</code>`);
          return true;
        }
        case 'resume': {
          if (!loadSession) {
            await sendMessage(chatId, 'Session resume is not available in this runtime.');
            return true;
          }
          const sessionId = arg || String(chatId);
          const session = await loadSession(sessionId);
          if (!session || !Array.isArray(session.history) || !agent?.replaceHistory) {
            await sendMessage(chatId, `No saved session found for <code>${esc(sessionId)}</code>.`);
            return true;
          }
          agent.replaceHistory(session.history);
          await sendMessage(chatId, `Session resumed: <code>${esc(sessionId)}</code> (${session.history.length} messages).`);
          return true;
        }
        case 'reset': {
          if (!agent?.replaceHistory) {
            await sendMessage(chatId, 'No agent session in this runtime.');
            return true;
          }
          agent.replaceHistory([]);
          let cleared = 'in-memory only';
          if (deleteSession) {
            try {
              cleared = (await deleteSession(String(chatId))) ? 'saved session deleted' : 'no saved session';
            } catch (error) { cleared = `saved session kept (${error.message})`; }
          }
          await sendMessage(chatId, `Agent conversation cleared — <code>${esc(cleared)}</code>. The trader, scanner and open positions are untouched.`);
          return true;
        }
        case 'ask': {
          const reply = await agent.say(arg || 'status?');
          await sendMessage(chatId, esc(reply?.content || 'ok'));
          if (saveSession) await saveSession(String(chatId), { history: agent.history });
          return true;
        }
        case 'diag': {
          const store = storeStatus();
          const dbLine = store.backend === 'postgres'
            ? (store.lastLoadFailed ? `postgres BROKEN (${store.lastError || 'unknown'}) — settings are NOT persisting` : 'postgres OK')
            : 'file only — set DATABASE_URL to survive redeploys';
          await sendMessage(chatId, `<b>Diag</b>\napi <code>${client ? 'ready' : 'missing'}</code>\ndb <code>${esc(dbLine)}</code>\nws <code>configured</code>`);
          return true;
        }
        // Agent-layer commands (/skills /skill /mcp /harness /tools /check_ai).
        // They live in agent-commands.js and return handled:false for anything
        // they do not own, so this falls through to the agent chat below.
        case 'skills': case 'skill': case 'mcp': case 'harness': case 'tools': case 'check_ai': {
          const { handleAgentCommand } = await import('./agent-commands.js');
          const result = await handleAgentCommand(text, { agent, tools, say: t => agent.say(t) });
          if (result.handled) {
            await sendMessage(chatId, esc(result.reply));
            return true;
          }
          return false;
        }
        default:
          return false;
      }
    } catch (error) {
      await sendMessage(chatId, `Error: ${esc(error.message)}`);
      return true;
    }
  }

  return { handleCommand, scanState, reportState };
}
