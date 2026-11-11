import test from 'node:test';
import assert from 'node:assert/strict';
import * as W from '../src/watch.mjs';
import * as HR from '../src/hourly.mjs';

test('代號正規化：各種寫法都變成 APP', () => {
  for (const s of ['APP', 'app', 'APPUSDT', 'APP-USDT-SWAP', 'APPSTOCKUSDT', 'BYBIT:APPSTOCKUSDT.P', ' app_usdt ']) assert.equal(W.normalizeSymbol(s), 'APP');
  assert.equal(W.normalizeSymbol('壞!'), null);
});

test('自選清單寫進 Issue 本文後可讀回，重複與註解會被忽略', () => {
  const body = W.formatWatch(['APP', 'hype', 'APP']);
  assert.deepEqual(W.parseWatch(body), ['APP', 'HYPE']);
  assert.deepEqual(W.parseWatch(body.replace('\nHYPE\n', '\nHYPE # 觀察\nBTCUSDT\n')), ['APP', 'HYPE', 'BTC']);
  assert.deepEqual(W.parseWatch('沒有區塊'), []);
});

test('自選標的門檻放寬、通知標【自選】並排在最前面', () => {
  const T = Date.UTC(2026, 10, 4, 14);
  const mid = { x1: 3.5, x2: 2.2, qv: 5e4, chg: 0.01, price: 10 };
  const s = HR.emptyHourly();
  const a = HR.pickAlerts(s, [
    { venue: 'okx', sym: 'AAA-USDT-SWAP', base: 'AAA', cat: 'crypto', stats: mid },                 /* 一般：門檻不到 */
    { venue: 'okx', sym: 'BBB-USDT-SWAP', base: 'BBB', cat: 'crypto', stats: mid, watch: true },    /* 自選：放寬後達標 */
    { venue: 'okx', sym: 'CCC-USDT-SWAP', base: 'CCC', cat: 'crypto', stats: { x1: 20, x2: 9, qv: 5e6, chg: 0, price: 1 } }
  ], T);
  assert.deepEqual(a.map(x => x.base), ['BBB', 'CCC']);
  assert.match(HR.hourlyAlertText(a, T), /【自選】<?.*BBB/s);
});

test('借幣利率自動加入：新增、延長、到期移出；手動的（含註解）不動', () => {
  const D = 864e5, now = Date.UTC(2026, 10, 11, 6);
  const base = W.formatWatch(['APP', 'HYPE']).replace('\nHYPE\n', '\nHYPE # 觀察\n');
  let r = W.applyAuto(base, [{ sym: 'RSR', until: now + 7 * D }, { sym: 'APP', until: now + 7 * D }], now);
  assert.deepEqual([r.added, r.manual, r.changed], [['RSR'], ['APP'], true]);
  assert.deepEqual(W.parseWatch(r.body), ['APP', 'HYPE', 'RSR']);
  assert.match(r.body, /HYPE # 觀察\n/);
  assert.deepEqual(W.autoOf(r.body), { RSR: now + 7 * D });
  r = W.applyAuto(r.body, [{ sym: 'rsr', until: now + 9 * D }], now + D);
  assert.deepEqual(r.renewed, ['RSR']);
  assert.equal(W.autoOf(r.body).RSR, now + 9 * D);
  assert.equal(W.applyAuto(r.body, [{ sym: 'RSR', until: now + 8 * D }], now + D).changed, false);   /* 較早的到期不縮短 */
  r = W.applyAuto(r.body, [], now + 9 * D);
  assert.deepEqual([r.removed, W.parseWatch(r.body)], [['RSR'], ['APP', 'HYPE']]);
  assert.equal(W.applyAuto(r.body, [], now + 20 * D).changed, false);
  /* Issue 沒有標記區塊時補上 */
  assert.deepEqual(W.parseWatch(W.applyAuto('', [{ sym: 'ZIL', until: now + D }], now).body), ['ZIL']);
});
