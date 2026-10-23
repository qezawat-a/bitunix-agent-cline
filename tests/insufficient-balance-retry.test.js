import test from 'node:test';
import assert from 'node:assert/strict';
import { Trader } from '../src/trader/trader.js';

const pair = { symbol: 'BTRUSDT', basePrecision: 0, minTradeVolume: '10' };
const make = (rejections) => {
  const sent = [];
  const t = Object.create(Trader.prototype);
  t.client = { async placeOrder(body) {
    sent.push(body);
    if (sent.length <= rejections) throw new Error('Bitunix POST /api/v1/futures/trade/place_order rejected: 20003 Insufficient balance');
    return { orderId: '1' };
  } };
  return { t, sent };
};

test('a 20003 rejection is retried with a smaller qty and a fresh clientId', async () => {
  const { t, sent } = make(2);
  const order = await t.placeOrderShrinking({ symbol: 'BTRUSDT', qty: '1000', clientId: 'c' }, pair);
  assert.equal(order.orderId, '1');
  assert.deepEqual(sent.map(b => b.qty), ['1000', '900', '810']);
  assert.deepEqual(sent.map(b => b.clientId), ['c', 'c-r1', 'c-r2']);
});

test('other rejections are not retried, and the retry stops at the minimum volume', async () => {
  const other = Object.create(Trader.prototype);
  let calls = 0;
  other.client = { async placeOrder() { calls += 1; throw new Error('rejected: 10002 Parameter error'); } };
  await assert.rejects(other.placeOrderShrinking({ qty: '100', clientId: 'x' }, pair), /10002/);
  assert.equal(calls, 1);
  const { t, sent } = make(99);
  await assert.rejects(t.placeOrderShrinking({ qty: '11', clientId: 'y' }, pair), /20003/);
  assert.equal(sent.length, 1); // 11 * 0.9 = 9 < minTradeVolume 10
});
