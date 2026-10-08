// Tiered risk limit (the Bitunix liquidation mechanism).
//
// Bitunix runs every USDT-M perpetual on a tiered risk limit: each tier carries
// a nominal-value range, a maximum leverage and a maintenance margin rate.
//   https://support.bitunix.com/hc/en-us/articles/32152530856601-Bitunix-Futures-Liquidation-Mechanism-and-Tiered-Risk-Limit
//   https://www.bitunix.com/api-docs/futures/position/get_position_tiers.html
//
// The docs state the rule this module implements verbatim:
//   "The risk limit tier of the position is calculated by the leverage the user
//    selects. The value of orders and positions needs to be within the range of
//    the corresponding risk limit tiers."
// and, on the tiers endpoint:
//   "When the margin rate of a position is less than the maintenance margin
//    rate, it will trigger a forced partial liquidation or full liquidation."
//
// Everything here is pure: no client, no network, so the ladder maths is
// testable without an exchange.

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// `/position/get_position_tiers` answers with a bare ArrayList<PositionTiersResp>
// ({ level, startValue, endValue, leverage, maintenanceMarginRate }), which the
// docs sort ascending by startValue. Normalise and re-sort so a reordered
// payload cannot pick the wrong tier.
export function normalizeTiers(tiers) {
  if (!Array.isArray(tiers)) return [];
  return tiers
    .map(tier => ({
      symbol: tier?.symbol ?? null,
      level: num(tier?.level),
      startValue: num(tier?.startValue),
      endValue: num(tier?.endValue),
      leverage: num(tier?.leverage),
      maintenanceMarginRate: num(tier?.maintenanceMarginRate),
    }))
    .filter(tier => tier.startValue !== null && tier.endValue !== null && tier.endValue > tier.startValue)
    .sort((a, b) => a.startValue - b.startValue);
}

// The notional (nominal) value a tier is measured on: |qty| x price. Prefer the
// live mark, then the average open price from the position model.
export function positionNotionalValue(position) {
  const qty = num(position?.qty ?? position?.size);
  const price = num(position?.markPrice ?? position?.lastPrice ?? position?.avgOpenPrice ?? position?.avgPrice ?? position?.entryPrice);
  if (qty === null || price === null) return null;
  return Math.abs(qty * price);
}

// The tier whose nominal-value range contains `value`. A value past the last
// tier's endValue maps to the last (highest) tier.
export function tierForValue(tiers, value) {
  const list = normalizeTiers(tiers);
  const notional = num(value);
  if (!list.length || notional === null || notional < 0) return null;
  const last = list[list.length - 1];
  if (notional >= last.endValue) return last;
  return list.find(tier => notional >= tier.startValue && notional < tier.endValue) || list[0];
}

// The tier that governs a chosen leverage. The docs pick the tier from the
// leverage the user selects, and each tier advertises its maximum allowed
// leverage, so the governing tier is the tightest one whose maxLeverage still
// admits the chosen leverage (lowest maxLeverage >= leverage).
export function tierForLeverage(tiers, leverage) {
  const list = normalizeTiers(tiers);
  const chosen = num(leverage);
  if (!list.length || chosen === null || chosen <= 0) return null;
  const admissible = list.filter(tier => tier.leverage !== null && tier.leverage >= chosen);
  if (!admissible.length) return null;
  return admissible.reduce((tightest, tier) => (tier.leverage < tightest.leverage ? tier : tightest));
}

// The maximum notional the exchange will let this leverage carry: the governing
// tier's endValue. Returns null when the tiers cannot answer.
export function maxNotionalForLeverage(tiers, leverage) {
  return tierForLeverage(tiers, leverage)?.endValue ?? null;
}

// The documented forced-liquidation rule, stated as data rather than an action:
// a position is in breach of its tier when the current margin rate is below the
// tier's maintenance margin rate.
export function maintenanceMarginCheck(position, tiers) {
  const list = normalizeTiers(tiers);
  if (!list.length) return { checked: false, reason: 'no position tiers' };
  const notional = positionNotionalValue(position);
  if (notional === null) return { checked: false, reason: 'position has no qty/price to size' };
  const tier = tierForValue(list, notional);
  if (!tier || tier.maintenanceMarginRate === null) return { checked: false, reason: 'no tier for this position value' };
  const marginRate = num(position?.marginRate);
  if (marginRate === null) return { checked: false, reason: 'position carries no marginRate' };
  return {
    checked: true,
    tier,
    notional,
    marginRate,
    maintenanceMarginRate: tier.maintenanceMarginRate,
    breached: marginRate < tier.maintenanceMarginRate,
  };
}
