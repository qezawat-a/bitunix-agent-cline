import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertSymbolTradable } from '../src/bitunix/symbols.js';

const client = pairs => ({ getTradingPairs: async () => pairs });

describe('symbol must be tradable on Bitunix', () => {
  it('accepts an open, API-enabled pair', async () => {
    const pair = await assertSymbolTradable(client([{ symbol: 'ETHUSDT', symbolStatus: 'OPEN', isApiSupported: true }]), 'ethusdt');
    assert.equal(pair.symbol, 'ETHUSDT');
  });
  it('rejects a symbol the exchange does not list', async () => {
    await assert.rejects(assertSymbolTradable(client([]), 'FAKEUSDT'), /not listed/);
  });
  it('rejects CANCEL_ONLY / STOP pairs and pairs with API trading disabled', async () => {
    await assert.rejects(assertSymbolTradable(client([{ symbol: 'AAAUSDT', symbolStatus: 'CANCEL_ONLY' }]), 'AAAUSDT'), /CANCEL_ONLY/);
    await assert.rejects(assertSymbolTradable(client([{ symbol: 'AAAUSDT', symbolStatus: 'OPEN', isApiSupported: false }]), 'AAAUSDT'), /API trading disabled/);
  });
});
