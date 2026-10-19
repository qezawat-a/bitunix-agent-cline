import fs from 'node:fs';

function patch(file, steps) {
  let s = fs.readFileSync(file, 'utf8');
  let changed = false;
  for (const { marker, anchor, insert, before } of steps) {
    if (s.includes(marker)) continue;
    const i = s.indexOf(anchor);
    if (i < 0) throw new Error(file + ': anchor not found: ' + anchor.slice(0, 60));
    const at = before ? i : i + anchor.length;
    s = s.slice(0, at) + insert.join('\n') + s.slice(at);
    changed = true;
  }
  if (changed) fs.writeFileSync(file, s);
  console.log(file + (changed ? ': updated' : ': already applied'));
}

patch('src/trader/trader.js', [
  {
    marker: 'reportErrors(kind, errors)',
    anchor: '  async guard() {',
    before: true,
    insert: [
      '  alert = null;',
      '  errorSeen = new Map();',
      '',
      '  reportErrors(kind, errors) {',
      '    if (!Array.isArray(errors) || !errors.length) return;',
      '    const now = Date.now();',
      '    const html = v => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");',
      '    if (this.errorSeen.size > 200) this.errorSeen.clear();',
      '    for (const err of errors) {',
      '      const id = err?.positionId ?? "-";',
      '      const message = err?.message ?? String(err);',
      '      console.error(`[${kind}] ${id}: ${message}`);',
      '      const key = `${kind}|${id}|${message}`;',
      '      if (now - (this.errorSeen.get(key) || 0) < 600000) continue;',
      '      this.errorSeen.set(key, now);',
      '      if (typeof this.alert === "function") {',
      '        const text = `⚠️ <b>${html(kind)}</b> <code>${html(id)}</code>\\n<code>${html(message)}</code>`;',
      '        Promise.resolve(this.alert(text)).catch(() => {});',
      '      }',
      '    }',
      '  }',
      '',
    ],
  },
  {
    marker: "this.reportErrors('guard', errors);",
    anchor: '      this.state.positions = positions.map(position => ({ positionId: position.positionId, symbol: position.symbol, side: position.side }));\n      return errors;',
    before: true,
    insert: ["      this.reportErrors('guard', errors);", ''],
  },
  {
    marker: "this.reportErrors('manage', errors);",
    anchor: '      const errors = await this.manageInFlight;\n',
    insert: ["      this.reportErrors('manage', errors);", ''],
  },
]);

patch('src/trader/position-manager.js', [
  {
    marker: 'async forceBreakeven(position)',
    anchor: '  async moveSLToEntry(positionId, entryPrice',
    before: true,
    insert: [
      '  async forceBreakeven(position) {',
      '    const entry = Number(position.avgPrice);',
      '    const mark = Number(position.markPrice);',
      '    if (!finitePositive(entry) || !finitePositive(mark)) throw new Error("position entry/mark price missing");',
      '    const inProfit = position.side === "BUY" ? mark > entry : mark < entry;',
      '    if (!inProfit) return { skipped: "position is not in profit; a stop at the entry would fire immediately" };',
      '    if (!this.liqDistanceOk(position, entry)) return { skipped: "stop at the entry would sit inside the liquidation distance" };',
      '    const result = await this.moveSLToEntry(position.positionId, entry, positionMagnitude(position), position.side);',
      '    const precision = await this.getQuotePrecision();',
      '    this.breakEvenApplied.set(String(position.positionId), { slPrice: entry, precision });',
      '    this.reportStopMove?.(position, "breakeven", entry);',
      '    return { ...result, slPrice: formatPrice(entry, precision) };',
      '  }',
      '',
    ],
  },
]);

patch('src/telegram-trader.js', [
  {
    marker: "case 'breakeven':",
    anchor: "        case 'close_all': {",
    before: true,
    insert: [
      "        case 'breakeven': {",
      '          const pm = trader?.positionManager;',
      "          if (!pm) return usage(chatId, 'Position manager is not ready.');",
      '          pm.resetTpslCache();',
      '          const open = await pm.fetchPositions();',
      "          if (!open.length) { await sendMessage(chatId, 'No open positions.'); return true; }",
      '          const lines = [];',
      '          for (const position of open) {',
      '            const label = `${esc(position.side)} <code>${esc(position.symbol)}</code> <code>${esc(position.positionId)}</code>`;',
      '            try {',
      '              pm.resetTpslCache();',
      '              const res = await pm.forceBreakeven(position);',
      '              lines.push(res.skipped',
      '                ? `${label}: skipped, ${esc(res.skipped)}`',
      '                : `${label}: SL moved to <code>${esc(res.slPrice)}</code> (${esc(res.via || "ok")})`);',
      '            } catch (error) {',
      '              lines.push(`${label}: FAILED, <code>${esc(error.message)}</code>`);',
      '            }',
      '          }',
      "          await sendMessage(chatId, `<b>Break-even</b>\\n${lines.join('\\n')}`);",
      '          return true;',
      '        }',
      '',
    ],
  },
  {
    marker: '/breakeven /close_all',
    anchor: '/close_all &lt;symbol&gt; confirm',
    before: true,
    insert: ['/breakeven '],
  },
]);

patch('src/telegram-bot.js', [
  {
    marker: "command: 'breakeven'",
    anchor: "    { command: 'close_all', description: 'Close all with confirmation' },",
    before: true,
    insert: ["    { command: 'breakeven', description: 'Move SL to entry on open positions now' },", ''],
  },
]);

patch('src/main.js', [
  {
    marker: 'trader.alert =',
    anchor: '  const trader = new Trader(client);\n',
    insert: [
      '  trader.alert = text => (CONFIG.ALLOWED_USER_ID ? sendMessage(CONFIG.ALLOWED_USER_ID, text) : null);',
      '',
    ],
  },
]);
console.log('done');
