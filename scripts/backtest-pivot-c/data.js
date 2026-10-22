// data.js — bar/funding loading and as-of window access for the Pivot C
// backtest. Node stdlib only: the repo's runtime constraint (dotenv, pg, ws
// deps only) applies to the service; research tooling here uses zero extra
// deps as well, so nothing new lands in package.json.
//
// Data source caveat (documented): Binance UM futures public archive
// (data.binance.vision) monthly files for BTCUSDT, used as a venue proxy for
// Bitunix BTCUSDT-M. Cross-venue price/funding arbitrage keeps BTC perpetual
// prices within a few bps; results must be read with that error bar.
//
// Kline archive rows: open_time,open,high,low,close,volume(base),...
// (2020 files have no header row; 2025+ files do — both handled).
// Funding archive rows: calc_time,funding_interval_hours,last_funding_rate.
// Funding rates are normalized to the 8h basis the repo's thresholds assume
// (filters/funding strategy and the draft's per-8h veto are quoted on it).

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const SPAN_MS = { '5m': 300_000, '15m': 900_000, '1h': 3_600_000 };
export const TARGET_TFS = ['5m', '15m', '1h'];

function float(x) {
  return Number(x);
}

function isIntToken(x) {
  return /^\d+$/.test(String(x).trim());
}

export function loadKlinesDir(dir) {
  const files = listSortedCsv(dir);
  if (!files.length) throw new Error(`no CSVs in ${dir} — run fetch.sh first`);
  const times = [];
  const opens = [];
  const highs = [];
  const lows = [];
  const closes = [];
  const volumes = [];
  let lastT = -1;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      const parts = line.split(',');
      if (!isIntToken(parts[0])) continue; // header or malformed row
      const t = Number(parts[0]);
      if (t <= lastT) continue; // duplicate/unordered guard
      opens.push(float(parts[1]));
      highs.push(float(parts[2]));
      lows.push(float(parts[3]));
      closes.push(float(parts[4]));
      volumes.push(float(parts[5]));
      times.push(t);
      lastT = t;
    }
  }
  return { times, opens, highs, lows, closes, volumes };
}

export function loadFundingDir(dir) {
  const files = listSortedCsv(dir);
  const events = { times: [], rates: [] };
  let lastT = -1;
  let headerNote = null;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      const parts = line.split(',');
      if (!isIntToken(parts[0])) {
        if (headerNote === null) headerNote = parts.slice(0, 3).join(',');
        continue;
      }
      const t = Number(parts[0]);
      if (t <= lastT) continue;
      // normalize to per-8h: interval column present in current archive rows
      let rate;
      if (parts.length >= 3 && isIntToken(parts[1])) {
        const interval = Math.max(1, Math.min(8, Number(parts[1])));
        rate = float(parts[2]) * (8 / interval);
      } else {
        rate = float(parts[1]);
      }
      events.times.push(t);
      events.rates.push(rate);
      lastT = t;
    }
  }
  return { events, headerNote };
}

function listSortedCsv(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.csv'))
    .sort()
    .map((name) => path.join(dir, name));
}

export class Market {
  constructor(barsByTf, fundingEvents) {
    this.tf = barsByTf;
    this.fundingTimes = fundingEvents.times;
    this.fundingRates = fundingEvents.rates;
  }

  fundingAsof(t) {
    const i = bisectRight(this.fundingTimes, t) - 1;
    return i >= 0 ? this.fundingRates[i] : null;
  }

  windowAt(tfname, asofOpenExclusive) {
    /** Last <=200 bars with open time strictly before asofOpenExclusive.
     * Callers pass the first NOT-yet-usable open time: a TF bar is closed at
     * t_close iff open_time <= t_close - span. Returns null below 60 bars. */
    const series = this.tf[tfname];
    const idx = bisectRight(series.times, asofOpenExclusive - 1);
    if (idx < 60) return null;
    const start = Math.max(0, idx - 200);
    return seriesToWindow(series, start, idx);
  }
}

function seriesToWindow(series, start, end) {
  const klines = new Array(end - start);
  const volumes = new Array(end - start);
  for (let j = start; j < end; j++) {
    klines[j - start] = {
      open: series.opens[j],
      high: series.highs[j],
      low: series.lows[j],
      close: series.closes[j],
      baseVol: series.volumes[j],
    };
    volumes[j - start] = series.volumes[j];
  }
  return { klines, volumes };
}

export function bisectRight(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function bisectLeft(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
