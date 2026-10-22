// votes.worker.js — one shard of the vote precompute.
//
// The vote is memoryless per event (it is computed from closed bars only),
// so contiguous 5m event-index shards need no overlap. Each worker loads the
// market data itself (sub-second CSV parse) and posts a packed table:
//   { first, pass: Uint8Array, dir: Uint8Array, conf: Float32Array }
// Indexed by event index; event index i = the 5m BAR index whose close time
// (times5[i] + 5m) is the decision instant.
//
// Usage (from run.js): new Worker(new URL('./votes.worker.js', import.meta.url),
//   { workerData: { dataDir, startIdx, total } })

import { workerData, parentPort } from 'node:worker_threads';
import { loadKlinesDir, loadFundingDir, Market, SPAN_MS } from './data.js';
import { voteAt } from './votes.js';

const { dataDir, startIdx, total } = workerData;

const bars = {};
for (const tf of ['5m', '15m', '1h']) {
  bars[tf] = loadKlinesDir(`${dataDir}/${tf}`);
}
const { events } = loadFundingDir(`${dataDir}/funding`);
const market = new Market(bars, events);

const times5 = market.tf['5m'].times;
const pass = new Uint8Array(total);
const dir = new Uint8Array(total);
const conf = new Float32Array(total);

for (let k = 0; k < total; k++) {
  const i = startIdx + k;
  const tClose = times5[i] + SPAN_MS['5m'];
  const vote = voteAt(market, tClose);
  if (!vote) continue;
  if (vote.passes) {
    pass[k] = 1;
    dir[k] = vote.direction === 'bullish' ? 1 : 2;
    conf[k] = vote.avg_confidence;
  }
}

parentPort.postMessage({ first: startIdx, pass, dir, conf }, [pass.buffer, dir.buffer, conf.buffer]);
