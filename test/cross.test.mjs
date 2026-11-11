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

/* ---------------- 日線金叉（CROSS_D）：同樣 EMA20／SMA30，K 線一根 = 1 天 ---------------- */
const D1 = 24 * 3600e3;
function mkD(closes, qvs = []) {
  return closes.map((c, i) => ({ t: T0 + i * D1, o: c, h: c * 1.01, l: c * 0.99, c, qv: qvs[i] ?? 1e6 }));
}
function pushUntilCross(bars, jump, qv, cfg) {
  let c = bars[bars.length - 1].c;
  for (let k = 0; k < 30; k++) {
    c += jump;
    bars.push({ t: bars[bars.length - 1].t + D1, o: c, h: c * 1.01, l: c * 0.99, c, qv });
    const I = C.indicators(bars, cfg), i = bars.length - 1;
    if (I.ema[i] > I.sma[i] && I.ema[i - 1] <= I.sma[i - 1]) return bars[i].t;
  }
  throw new Error('沒有產生金叉');
}
function dailyDip() {
  const c = [];
  for (let i = 0; i < 220; i++) c.push(100 + i * 0.5);
  for (let i = 0; i < 40; i++) c.push(c[c.length - 1] - 0.4);
  return mkD(c);
}

test('日線設定：週期、追蹤 30 根、B 級 7 天，4H 設定不變', () => {
  assert.equal(C.CROSS_D.tf, '1d');
  assert.equal(C.CROSS_D.barMs, D1);
  assert.equal(C.CROSS_D.trackBars, 30);
  assert.equal(C.CROSS_D.keepBHours, 168);
  assert.equal(C.CROSS_D.fast, 20); assert.equal(C.CROSS_D.slow, 30);
  assert.equal(C.CROSS_D.trend, 200); assert.equal(C.CROSS_D.minVolX, 1.5);
  assert.equal(C.CROSS.tf, '4h'); assert.equal(C.CROSS.trackBars, 42); assert.equal(C.CROSS.keepBHours, 48);
});

test('barOpen（日線）：最近一根已收盤日線 K（UTC 00:00 開、台灣 08:00 收）', () => {
  assert.equal(C.barOpen(Date.UTC(2026, 10, 8, 0, 30), C.CROSS_D), Date.UTC(2026, 10, 7));
  assert.equal(C.barOpen(Date.UTC(2026, 10, 7, 23, 59), C.CROSS_D), Date.UTC(2026, 10, 6));
  assert.equal(C.barOpen(Date.UTC(2026, 10, 7, 16, 0, 20)), Date.UTC(2026, 10, 7, 12));   /* 沒給 cfg 仍是 4H */
});

test('日線金叉：多頭回檔後放量 → A 級；量不夠 → B 級；上市不足 200 日 → B 級', () => {
  const a = dailyDip(); const Ta = pushUntilCross(a, 1.5, 4e6, C.CROSS_D);
  const ca = C.crossAt(meta, a, Ta, C.CROSS_D);
  assert.equal(ca.grade, 'A', ca.reasons.join());
  assert.ok(ca.px200 > 0 && ca.volx >= 1.5);
  const b = dailyDip(); const Tb = pushUntilCross(b, 1.5, 1e6, C.CROSS_D);
  const cb = C.crossAt(meta, b, Tb, C.CROSS_D);
  assert.equal(cb.grade, 'B'); assert.match(cb.reasons.join(), /量/);
  const c = []; for (let i = 0; i < 60; i++) c.push(100 - i * 0.3);
  const n = mkD(c); const Tn = pushUntilCross(n, 1, 5e6, C.CROSS_D);
  const cn = C.crossAt(meta, n, Tn, C.CROSS_D);
  assert.equal(cn.grade, 'B'); assert.match(cn.reasons.join(), /200/);
});

test('日線金叉：延遲以天算、A 級追蹤 30 根後結算、B 級保留 7 天', () => {
  const a = dailyDip(); const T = pushUntilCross(a, 1.5, 4e6, C.CROSS_D);
  const st = C.emptyCross();
  const x = C.crossAt(meta, a, T, C.CROSS_D);
  let r = C.applyScan(st, [x], T + D1, T + 2 * D1, C.CROSS_D);   /* 漏跑一天：晚 1 根 */
  assert.equal(r.newA.length, 1);
  assert.equal(r.newA[0].late, 1);
  assert.equal(r.newA[0].closedMkt, false);
  /* 之後 35 日一路上漲不死叉 → 30 根後以第 30 根收盤結算 */
  let c = a[a.length - 1].c;
  for (let k = 0; k < 35; k++) { c += 1; a.push({ t: a[a.length - 1].t + D1, o: c, h: c * 1.01, l: c * 0.99, c, qv: 1e6 }); }
  st.active = st.active.map(it => C.trackItem(it, a, C.CROSS_D));
  assert.equal(st.active[0].bars, 30);
  r = C.applyScan(st, [], st.active[0].lastT, st.active[0].lastT + D1, C.CROSS_D);
  assert.equal(r.closed.length, 1);
  assert.equal(st.active.length, 0);
  assert.equal(st.closed[0].exitRet, st.closed[0].ret);   /* 沒死叉：第 30 根收盤 */
  /* B 級：第 6 天還在、第 8 天移出 */
  const sb = C.emptyCross();
  const bb = { key: 'X:1', sym: 'XUSDT', base: 'X', grade: 'B', reasons: ['r'], t: T0, close: 1, stock: false };
  C.applyScan(sb, [bb], T0, T0 + D1, C.CROSS_D);
  C.applyScan(sb, [], T0 + 5 * D1, T0 + 6 * D1, C.CROSS_D);
  assert.equal(sb.recentB.length, 1);
  C.applyScan(sb, [], T0 + 7 * D1, T0 + 8 * D1 + 1, C.CROSS_D);
  assert.equal(sb.recentB.length, 0);
});

test('日線金叉：狀態標記獨立（不會讀到 4H 的狀態）、推播文字標【日線金叉】', () => {
  const a = dailyDip(); const T = pushUntilCross(a, 1.5, 4e6, C.CROSS_D);
  const st = C.emptyCross();
  const r = C.applyScan(st, [C.crossAt(meta, a, T, C.CROSS_D)], T, T + D1, C.CROSS_D);
  const md = C.embedCross(render(C.crossMarkdown(st, { nowMs: T + D1 }, C.CROSS_D), 'md'), st, C.CROSS_D);
  assert.match(md, /CROSSD_STATE/);
  assert.equal(C.extractCross(md, C.CROSS_D).active.length, 1);
  assert.equal(C.extractCross(md).active.length, 0);          /* 4H 讀日線文字：沒有 4H 標記 → 空狀態，不是壞掉 */
  const md4 = C.embedCross('x', st);
  assert.equal(C.extractCross(md4, C.CROSS_D).active.length, 0);
  assert.equal(C.extractCross('壞掉 <!-- CROSSD_STATE\nxx\nCROSSD_STATE -->', C.CROSS_D), null);
  assert.match(md, /# 日線金叉/);
  const txt = render(C.crossAlertText(r.newA, [], T, 'https://x', C.CROSS_D), 'html');
  assert.match(txt, /【日線金叉】/);
  assert.match(txt, /interval=D/);
  assert.match(txt, /日線死叉/);
  assert.match(txt, /尚無回測/);
  assert.doesNotMatch(txt, /4H/);
  const t4 = render(C.crossAlertText(r.newA, [], T, 'https://x'), 'html');
  assert.match(t4, /【4H 金叉】/);
  assert.match(t4, /interval=240/);
});
