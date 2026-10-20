// Usage (from the repo root):  node apply-fixes.mjs
// Applies each edit by exact text match (not by line number), so it works even
// when your files differ slightly from the copy I patched. Idempotent: an edit
// that is already applied is skipped. Every edit is reported.
import fs from 'node:fs';

const E = [];
const edit = (file, old, neu) => E.push({ file, old, neu });

// ---- 1. Ichimoku: Chikou span compared a candle's close with its own high ----
edit('src/bitunix/indicators.js',
`  const chikouIdx = closes.length - 1 - 26;
  const chikou = chikouIdx >= 0 ? closes[chikouIdx] : close;
  const chikouPastHigh = chikouIdx >= 0 ? highs[chikouIdx] : close;
`,
`  // Chikou Span is TODAY's close plotted 26 bars back, so it is judged against
  // the candle that sits there. The old code compared that candle's own close
  // with its own high (close <= high always), so Chikou voted bearish on almost
  // every bar and the whole indicator leaned short.
  const chikouIdx = closes.length - 1 - 26;
`);
edit('src/bitunix/indicators.js',
`  if (chikou > chikouPastHigh) bullish++;
  else if (chikou < chikouPastHigh) bearish++;
`,
`  if (chikouIdx >= 0) {
    if (close > highs[chikouIdx]) bullish++;
    else if (close < lows[chikouIdx]) bearish++;
  }
`);

// ---- 2. Position-level TP/SL instead of order-level "Partial TP/SL" ----
const T = 'src/trader/trader.js';
edit(T,
`      effect: 'GTC',
      ...levels,
      tpOrderType: 'MARKET',
      slOrderType: 'MARKET',
      reduceOnly: false,`,
`      effect: 'GTC',
      // No tpPrice/slPrice here on purpose: Bitunix turns TP/SL sent on
      // place_order into two ORDER-level "Partial TP/SL" rows. The levels are
      // returned below and armed as ONE position-level pair by ensureProtection.
      reduceOnly: false,`);
edit(T,
`    const { body } = this.buildProtectedOrderBody({
      symbol,
      side: direction === 'bullish' ? 'BUY' : 'SELL',`,
`    const entryAtr = atr ?? await this.computeAtr(symbol);
    const openBefore = this.positionManager.state.positions.length;
    const { body, slPrice: plannedSl } = this.buildProtectedOrderBody({
      symbol,
      side: direction === 'bullish' ? 'BUY' : 'SELL',`);
edit(T, `      atr: atr ?? await this.computeAtr(symbol),\n`, `      atr: entryAtr,\n`);
edit(T, `Math.abs(entryPrice - Number(body.slPrice))`, `Math.abs(entryPrice - plannedSl)`);
edit(T,
`    const positions = await this.reconcilePositions();
    try {
      for (const position of positions) await this.positionManager.ensureProtection(position);`,
`    const positions = await this.awaitFilledPositions(openBefore);
    try {
      for (const position of positions) {
        await this.positionManager.ensureProtection({ ...position, atr: entryAtr, signalConfidence });
      }`);
edit(T,
`    const positions = await this.reconcilePositions();
    // Belt and braces`,
`    const positions = await this.awaitFilledPositions(open.length);
    // Belt and braces`);
edit(T,
`      protection.push(await this.positionManager.ensureProtection(position));`,
`      protection.push(await this.positionManager.ensureProtection({ ...position, atr, signalConfidence: confidence ?? undefined }));`);
edit(T,
`  async reconcileOrder(symbol, clientId) {`,
`  // After a market order the new position can take a moment to be listed.
  // Returns the NORMALISED positions (avgPrice/markPrice set) that
  // ensureProtection needs; reconcilePositions() trims them to entryPrice only.
  async awaitFilledPositions(before = 0, attempts = 6, delayMs = 500) {
    for (let i = 0; i < attempts; i += 1) {
      await this.reconcilePositions();
      if (this.positionManager.state.positions.length > before) break;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    return this.positionManager.state.positions;
  }

  async reconcileOrder(symbol, clientId) {`);

// ---- 3. Break-even / trailing triggers ----
const P = 'src/trader/position-manager.js';
edit(P,
`  static CLOSE_DEDUPE_MS = 60000;`,
`  static CLOSE_DEDUPE_MS = 60000;
  // Break-even locks entry + this much (percent of PRICE) so the exit covers the
  // round-trip taker fees instead of closing at a small net loss.
  static BREAKEVEN_FEE_BUFFER_PCT = 0.12;
  atrCache = new Map();`);
edit(P,
`  async checkBreakeven(position) {`,
`  async cachedAtr(position) {
    const key = String(position.positionId);
    const hit = this.atrCache.get(key);
    if (hit && Date.now() - hit.at < 60000) return hit.value;
    const value = await this.getAtrForPosition(position);
    this.atrCache.set(key, { value, at: Date.now() });
    return value;
  }

  // The ROI triggers are leverage-multiplied, so the SAME number means a very
  // different price move per leverage: 20% ROI is 0.67% of price at 30x (inside
  // one 15m ATR of noise, so the stop jumps to entry and is tagged by a normal
  // pullback) but 2% at 10x (often beyond the take-profit, so it never fires).
  // Clamp the configured value to [floorAtr x ATR, ceilTp x take-profit
  // distance] expressed as ROI, so it is always outside noise and reachable.
  async effectiveTriggerRoi(position, configuredPct, { floorAtr = 1, ceilTp = 0.6 } = {}) {
    const configured = Number(configuredPct);
    try {
      const entry = Number(position.avgPrice);
      const leverage = finitePositive(position.leverage) ? Number(position.leverage) : (Number(this.settings.leverage) || 1);
      const atr = await this.cachedAtr(position);
      if (!finitePositive(entry) || !finitePositive(atr)) return configured;
      const atrRoi = (atr / entry) * 100 * leverage;
      const { targetMultiple } = atrMultiples(position.signalConfidence ?? this.settings.min_confidence);
      const floor = atrRoi * floorAtr;
      const ceil = Math.max(floor, atrRoi * targetMultiple * ceilTp);
      return Math.min(Math.max(configured, floor), ceil);
    } catch {
      return configured;
    }
  }

  async checkBreakeven(position) {`);
edit(P,
`    const applied = this.breakEvenApplied.get(key);
    if (applied && samePrice(applied.slPrice, entry, applied.precision)) {`,
`    const buffer = PositionManager.BREAKEVEN_FEE_BUFFER_PCT / 100;
    const lockPrice = position.side === 'SELL' ? entry * (1 - buffer) : entry * (1 + buffer);
    const applied = this.breakEvenApplied.get(key);
    if (applied && samePrice(applied.slPrice, lockPrice, applied.precision)) {`);
edit(P,
`if (this.favorableRoiPct(position) >= Number(this.settings.breakeven_threshold_pct)) {`,
`if (this.favorableRoiPct(position) >= await this.effectiveTriggerRoi(position, this.settings.breakeven_threshold_pct)) {`);
edit(P, `position.side === 'BUY' && entry <= current)`, `position.side === 'BUY' && lockPrice <= current)`);
edit(P, `position.side === 'SELL' && entry >= current)`, `position.side === 'SELL' && lockPrice >= current)`);
edit(P, `await this.moveSLToEntry(position.positionId, entry, positionMagnitude(position), position.side);`, `await this.moveSLToEntry(position.positionId, lockPrice, positionMagnitude(position), position.side);`);
edit(P, `this.breakEvenApplied.set(key, { slPrice: entry, precision`, `this.breakEvenApplied.set(key, { slPrice: lockPrice, precision`);
edit(P,
`this.reportStopMove?.(position, 'breakeven', entry);
      return { ...result, slPrice: formatPrice(entry) };`,
`this.reportStopMove?.(position, 'breakeven', lockPrice);
      return { ...result, slPrice: formatPrice(lockPrice) };`);
edit(P,
`if (this.favorableRoiPct(position) >= Number(this.settings.trailing_trigger_roi_pct)) {
      const atr = await this.getAtrForPosition(position);`,
`if (this.favorableRoiPct(position) >= await this.effectiveTriggerRoi(position, this.settings.trailing_trigger_roi_pct, { floorAtr: 1.3, ceilTp: 0.8 })) {
      const atr = await this.cachedAtr(position);`);
edit(P,
`      for (const key of this.breakEvenApplied.keys()) {`,
`      for (const key of this.atrCache.keys()) {
        if (!live.has(key)) this.atrCache.delete(key);
      }
      for (const key of this.breakEvenApplied.keys()) {`);

// ---------------------------------------------------------------------------
const root = process.argv[2] || '.';
const files = [...new Set(E.map(e => e.file))];
let failed = 0;
for (const file of files) {
  const path = `${root}/${file}`;
  if (!fs.existsSync(path)) { console.log(`MISSING  ${file}`); failed += E.filter(e => e.file === file).length; continue; }
  const raw = fs.readFileSync(path, 'utf8');
  const crlf = raw.includes('\r\n');
  let text = crlf ? raw.replace(/\r\n/g, '\n') : raw;
  let changed = false;
  for (const e of E.filter(x => x.file === file)) {
    const label = e.old.split('\n').find(l => l.trim()).trim().slice(0, 60);
    if (text.includes(e.neu)) { console.log(`already  ${file}: ${label}`); continue; }
    const n = text.split(e.old).length - 1;
    if (n !== 1) { console.log(`FAILED   ${file}: ${label}  (matches: ${n})`); failed += 1; continue; }
    text = text.replace(e.old, () => e.neu);
    changed = true;
    console.log(`applied  ${file}: ${label}`);
  }
  if (changed) fs.writeFileSync(path, crlf ? text.replace(/\n/g, '\r\n') : text);
}
console.log(failed ? `\n${failed} edit(s) did not apply - send me that output.` : '\nAll edits applied. Run: node --check on the 3 files, then npm test.');
process.exit(failed ? 1 : 0);
