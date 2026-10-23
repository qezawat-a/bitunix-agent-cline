// Usage (repo root): node fix-order-units.mjs
// Repairs src/bitunix/order-units.js whatever state the manual edits left it in.
import fs from 'fs';
const p = 'src/bitunix/order-units.js';
let s = fs.readFileSync(p, 'utf8');

const startFn = s.indexOf('export function positionSizeFromUnit');
const endMark = s.indexOf('  const roundedTo', startFn);
if (startFn < 0 || endMark < 0) throw new Error('positionSizeFromUnit / roundedTo not found');

// start of the sizing block: right after the orderType validation line
const typeLine = s.indexOf("if (!['LIMIT', 'MARKET'].includes(type))", startFn);
const afterType = s.indexOf('\n', typeLine) + 1;
if (typeLine < 0 || afterType <= 0 || afterType > endMark) throw new Error('orderType validation anchor not found');

const block = `
  // All three units are anchored on the same margin budget, so the unit only changes
  // how the caller reads the number, not the size that ends up on the wire.
  // total outlay = margin + fee(open) + fee(close reserve) = budget * (1 + 2 * lev * fee)
  // and it must fit inside the balance, otherwise the exchange answers 20003.
  const requested = balance * pct / 100;
  const maxBudget = balance * BALANCE_SAFETY / (1 + 2 * lev * TAKER_FEE_RATE);
  const budget = Math.min(requested, maxBudget);
  const rawQty = budget * lev / mark;   // nominal = cost * leverage; qty = nominal / price
`;
s = s.slice(0, afterType) + block + s.slice(endMark);

// constants: remove any existing copies, add exactly one
s = s.replace(/^const TAKER_FEE_RATE.*\n/gm, '').replace(/^const BALANCE_SAFETY.*\n/gm, '');
s = s.replace('const MONEY_DECIMALS = 8;\n',
  'const MONEY_DECIMALS = 8;\n// Bitunix taker fee 0.06%: opening fee comes out of the same balance as the margin.\nconst TAKER_FEE_RATE = 0.0006;\nconst BALANCE_SAFETY = 0.99; // 1% headroom for rounding / market slippage\n');

// warning: exactly one
s = s.replace(/^ *if \(budget < requested\) warnings\.push.*\n/gm, '');
s = s.replace('  const warnings = [];\n',
  '  const warnings = [];\n  if (budget < requested) warnings.push(`margin capped from ${requested} to ${budget} USDT to leave room for fees`);\n');

// min-volume affordability must include fees too
if (!s.includes('outlayOfMin')) {
  s = s.replace('    if (Number.isFinite(costOfMin) && costOfMin <= balance) {',
    '    const outlayOfMin = costOfMin * (1 + 2 * lev * TAKER_FEE_RATE);\n    if (Number.isFinite(outlayOfMin) && outlayOfMin <= balance * BALANCE_SAFETY) {');
}
fs.writeFileSync(p, s);
console.log('order-units.js rewritten');
