// A symbol is only accepted if the exchange lists it, is trading it normally and
// allows API trading on it. Without this /symbol took any string and the scanner
// then failed on every cycle.
export async function assertSymbolTradable(client, symbol) {
  const wanted = String(symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{5,32}$/.test(wanted)) throw new Error(`invalid symbol ${JSON.stringify(symbol)}`);
  const pairs = await client.getTradingPairs(wanted);
  const pair = (Array.isArray(pairs) ? pairs : []).find(item => String(item?.symbol || '').toUpperCase() === wanted);
  if (!pair) throw new Error(`${wanted} is not listed on Bitunix futures`);
  const status = String(pair.symbolStatus ?? '').trim().toUpperCase();
  if (status && status !== 'OPEN') throw new Error(`${wanted} is ${status}, so it cannot be traded`);
  if (pair.isApiSupported === false) throw new Error(`${wanted} has API trading disabled`);
  return pair;
}
