import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/cross.mjs';
import { render } from '../src/tracker.mjs';

const H4 = 4 * 3600e3;
const T0 = Date.UTC(2026, 9, 1);
/* closes：收盤序列；qvs：成交額（預設 1e6） */
function mk(closes, qvs = []) {
  return closes.map((c, i) => ({ t: T0 + i * H4, o: c, h: c * 1.01, l: c * 0.99, c, qv: qvs[i] ?? 1e6 }));
}
/* 220 根緩漲（在 SMA200 上方）→ 40 根回落（EMA20 跌破 SMA30）→ 最後一根大漲上穿 */
function uptrendDip(lastQv = 3e6) {
  const c = [];
  for (let i = 0; i < 220; i++) c.push(100 + i * 0.5);
  for (let i = 0; i < 40; i++) c.push(c[c.length - 1] - 0.4);
  const bars = mk(c);
  return { bars, T: bars[bars.length - 1].t, lastQv };
}
function withCross(bars, jump, qv) {
  /* 一直往上加，直到出現金叉 */
  let c = bars[bars.length - 1].c;
  for (let k = 0; k < 30; k++) {
    c += jump;
    bars.push({ t: bars[bars.length - 1].t + H4, o: c, h: c * 1.01, l: c * 0.99, c, qv });
    const I = C.indicators(bars);
    const i = bars.length - 1;
    if (I.ema[i] > I.sma[i] && I.ema[i - 1] <= I.sma[i - 1]) return bars[i].t;
  }
  throw new Error('沒有產生金叉');
}
const meta = { sym: 'TESTUSDT', base: 'TEST', stock: false, qv24h: 5e6 };

test('指標：SMA30、SMA200 與前 20 根均量', () => {
  const bars = mk(Array.from({ length: 250 }, (_, i) => i + 1), Array.from({ length: 250 }, (_, i) => i));
  const I = C.indicators(bars);
  assert.equal(I.sma[29], 15.5);
  assert.equal(I.sma200[249], (51 + 250) / 2);
  assert.equal(I.vavg[20], (0 + 19) / 2);               /* 不含當根 */
  assert.equal(I.sma[28], null);
});

test('多頭回檔後放量金叉 → A 級；量不夠 → B 級', () => {
  const a = uptrendDip(); const Ta = withCross(a.bars, 1.5, 4e6);
  const ca = C.crossAt(meta, a.bars, Ta);
  assert.equal(ca.grade, 'A', ca.reasons.join());
  assert.ok(ca.px200 > 0 && ca.volx >= 1.5 && ca.stopPct > 0);
  const b = uptrendDip(); const Tb = withCross(b.bars, 1.5, 1e6);
  const cb = C.crossAt(meta, b.bars, Tb);
  assert.equal(cb.grade, 'B');
  assert.match(cb.reasons.join(), /量/);
  assert.equal(C.crossAt(meta, b.bars, Tb - H4), null); /* 前一根不是金叉 */
});

test('空頭裡的金叉 → B 級（收盤在 SMA200 下方）', () => {
  const c = [];
  for (let i = 0; i < 220; i++) c.push(300 - i * 0.5);
  for (let i = 0; i < 20; i++) c.push(c[c.length - 1] - 0.3);
  const bars = mk(c); const T = withCross(bars, 0.8, 5e6);
  const x = C.crossAt(meta, bars, T);
  assert.equal(x.grade, 'B');
  assert.match(x.reasons.join(), /SMA200/);
});

test('上市不足 200 根 → B 級', () => {
  const c = [];
  for (let i = 0; i < 60; i++) c.push(100 - i * 0.3);
  const bars = mk(c); const T = withCross(bars, 1, 5e6);
  const x = C.crossAt(meta, bars, T);
  assert.equal(x.grade, 'B');
  assert.match(x.reasons.join(), /200/);
});

test('A 級：推播一次、追蹤到死叉、42 根後結算', () => {
  const a = uptrendDip(); const T = withCross(a.bars, 1.5, 4e6);
  const st = C.emptyCross();
  const x = C.crossAt(meta, a.bars, T);
  let r = C.applyScan(st, [x], T, T + H4);
  assert.equal(r.newA.length, 1);
  assert.equal(st.active.length, 1);
  r = C.applyScan(st, [x], T, T + H4);                    /* 同一個金叉不重複推播 */
  assert.equal(r.newA.length, 0);
  /* 再漲 5 根後一路跌，產生死叉 */
  let c = a.bars[a.bars.length - 1].c;
  for (let k = 0; k < 45; k++) { c += k < 5 ? 1 : -1.2; a.bars.push({ t: a.bars[a.bars.length - 1].t + H4, o: c, h: c * 1.01, l: c * 0.99, c, qv: 1e6 }); }
  st.active = st.active.map(it => C.trackItem(it, a.bars));
  const it = st.active[0];
  assert.equal(it.bars, 42);
  assert.equal(it.still, false);
  assert.ok(it.deadT > T && it.deadRet != null && it.mfe > 0);
  r = C.applyScan(st, [], it.lastT, it.lastT + H4);
  assert.equal(r.closed.length, 1);
  assert.equal(st.active.length, 0);
  assert.equal(st.closed[0].exitRet, it.deadRet);       /* 死叉收盤出場 */
  assert.equal(C.crossStats(st.closed).n, 1);
});

test('B 級只保留 48 小時', () => {
  const st = C.emptyCross();
  const b = { key: 'X:1', sym: 'XUSDT', base: 'X', grade: 'B', reasons: ['r'], t: T0, close: 1, stock: false };
  C.applyScan(st, [b], T0, T0 + H4);
  assert.equal(st.recentB.length, 1);
  C.applyScan(st, [], T0 + 13 * H4, T0 + 14 * H4);
  assert.equal(st.recentB.length, 0);
});

test('穩定幣類自動排除', () => {
  const stable = Array.from({ length: 80 }, (_, i) => { const c = 1 + (i % 2) * 0.001; return { t: T0 + i * H4, o: c, h: c * 1.002, l: c * 0.998, c, qv: 1e6 }; });
  assert.equal(C.stableLike(stable), true);
  assert.equal(C.stableLike(mk(Array.from({ length: 80 }, (_, i) => 50 + i))), false);
  assert.equal(C.isExcludedBase('WBTC'), true);
  assert.equal(C.isExcludedBase('BTC'), false);
});

test('狀態存取與推播文字', () => {
  const a = uptrendDip(); const T = withCross(a.bars, 1.5, 4e6);
  const st = C.emptyCross();
  const r = C.applyScan(st, [C.crossAt({ ...meta, stock: true }, a.bars, T)], T, T + H4);
  const md = C.embedCross(render(C.crossMarkdown(st, { nowMs: T + H4 }), 'md'), st);
  assert.deepEqual(C.extractCross(md).active.length, 1);
  assert.equal(C.extractCross('壞掉 <!-- CROSS_STATE\nxx\nCROSS_STATE -->'), null);
  const txt = render(C.crossAlertText(r.newA, [], T, 'https://x'), 'html');
  assert.match(txt, /4H 金叉/);
  assert.match(txt, /BINANCE%3ATESTUSDT/);
  assert.match(txt, /代幣化股/);
  assert.equal(C.crossAlertText([], [], T), '');          /* 沒有 A 級不推播 */
});

test('barOpen：最近一根已收盤 4H K', () => {
  assert.equal(C.barOpen(Date.UTC(2026, 10, 7, 16, 0, 20)), Date.UTC(2026, 10, 7, 12));
  assert.equal(C.barOpen(Date.UTC(2026, 10, 7, 15, 59)), Date.UTC(2026, 10, 7, 8));
});
