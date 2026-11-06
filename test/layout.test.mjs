import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../src/layout.mjs';

const D = 864e5;
const T0 = Date.UTC(2026, 9, 1);
const ymd = t => new Date(t).toISOString().slice(0, 10);
/* 30 天日線，最後一天量 = mult 倍、成交額 = baseQv * mult */
function series(mult, baseQv = 2e5, price = 100) {
  return Array.from({ length: 30 }, (_, i) => ({
    t: T0 + i * D, o: price, h: price * 1.02, l: price * 0.98, c: price, qv: i === 29 ? baseQv * mult : baseQv
  }));
}
const DAY = ymd(T0 + 29 * D);
const meta = { base: 'APP', cat: 'stock', ref: 'okx' };

test('量倍數用前 20 日均量', () => {
  const x = L.volX(series(5), DAY);
  assert.ok(Math.abs(x.x - 5) < 1e-9);
  assert.equal(L.volX(series(5), '2020-01-01'), null);
});

test('只有 Bybit 爆量：標成只有一家', () => {
  const c = L.layoutCandidate(meta, { okx: series(1.1), bitget: series(1.5), bybit: series(8, 1e6) }, DAY, Date.now());
  assert.deepEqual(c.spiked, ['bybit']);
  assert.equal(c.single, true);
  assert.equal(L.kindOf(c), '只有 Bybit 爆量');
});

test('多家同時爆量不算只有一家', () => {
  const c = L.layoutCandidate(meta, { okx: series(6, 1e6), bitget: series(7, 1e6), bybit: series(1) }, DAY, Date.now());
  assert.equal(c.single, false);
  assert.deepEqual(c.spiked.sort(), ['bitget', 'okx']);
});

test('成交額太小或倍數不夠不進清單', () => {
  assert.equal(L.layoutCandidate(meta, { okx: series(8, 1e4) }, DAY, Date.now()), null);
  assert.equal(L.layoutCandidate(meta, { okx: series(3, 1e6) }, DAY, Date.now()), null);
});

test('追蹤中再爆量只記次數，不重複加入', () => {
  const s = L.emptyLayout();
  const c = L.layoutCandidate(meta, { okx: series(6, 1e6) }, DAY, Date.now());
  assert.equal(L.mergeLayout(s, [c]).length, 1);
  assert.equal(L.mergeLayout(s, [{ ...c, day: '2026-12-01' }]).length, 0);
  assert.equal(s.active[0].respikes, 1);
});

test('每日更新報酬、回撤，滿 60 天結算並扣大盤', () => {
  const s = L.emptyLayout();
  const c = L.layoutCandidate(meta, { okx: series(6, 1e6) }, DAY, Date.now());
  L.mergeLayout(s, [c]);
  const after = Array.from({ length: 61 }, (_, i) => {
    const p = i < 10 ? 80 : 130;                       /* 先跌 20% 再漲到 +30% */
    return { t: c.dayT + (i + 1) * D, o: p, h: p, l: p, c: p, qv: 1 };
  });
  /* 大盤：每天 0%，等權指數持平 */
  const flat = [c.dayT, ...after.map(b => b.t)].map(t => ({ t, c: 50 }));
  L.updateMarket(s, Array.from({ length: 25 }, () => flat));
  const ev = L.advanceLayout(s, () => after, c.dayT + 70 * D);
  assert.equal(s.active.length, 0);
  assert.equal(s.closed.length, 1);
  const done = s.closed[0];
  assert.ok(Math.abs(done.ret - 0.3) < 1e-9);
  assert.ok(Math.abs(done.mae + 0.2) < 1e-9);
  assert.ok(Math.abs(done.ex - 0.3) < 1e-9);
  assert.deepEqual(ev.map(e => e.type), ['checkpoint', 'settle']);
});

test('狀態寫進 Issue 後可讀回；壞資料回傳 null', () => {
  const s = L.emptyLayout(); s.lastDay = DAY;
  assert.equal(L.extractLayout(L.embedLayout('# x', s)).lastDay, DAY);
  assert.deepEqual(L.extractLayout('無狀態'), L.emptyLayout());
  assert.equal(L.extractLayout('<!-- LAYOUT_STATE\n壞\nLAYOUT_STATE -->'), null);
});
