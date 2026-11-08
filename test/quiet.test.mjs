import test from 'node:test';
import assert from 'node:assert/strict';
import * as Q from '../src/quiet.mjs';
import { hourStats, pickAlerts, emptyHourly } from '../src/hourly.mjs';
import { render } from '../src/tracker.mjs';

const H = 3600e3, D = 24 * H;
const T0 = Date.UTC(2026, 10, 1);

test('平均 1H 振幅與 ATR%', () => {
  const bars = Array.from({ length: 100 }, (_, i) => ({ t: T0 + i * H, o: 100, h: 102, l: 100, c: 101, qv: 1 }));
  assert.equal(Q.avgRangePct(bars, T0 + 100 * H), 2);
  assert.equal(Q.avgRangePct(bars.slice(0, 10), T0 + 10 * H), null);   /* 樣本太少 */
  const d = Array.from({ length: 20 }, (_, i) => ({ t: T0 + i * D, o: 100, h: 104, l: 100, c: 100 }));
  assert.equal(Q.atrPctAt(d, 19), 4);
  assert.equal(Q.atrPctAt(d, 5), null);
});

test('量增價平門檻：相對振幅＋上限；Bybit 用固定上限', () => {
  assert.deepEqual(Q.quietHour(0.5, 2, 'crypto'), { quiet: true, lim: 1, rng: 2 });
  assert.equal(Q.quietHour(1.2, 2, 'crypto').quiet, false);
  assert.equal(Q.quietHour(1.9, 10, 'crypto').lim, 2);                 /* 上限 2% */
  assert.equal(Q.quietHour(0.6, null, 'stock').quiet, false);           /* 股票固定 0.5% */
  assert.equal(Q.quietHour(0.9, null, 'crypto').quiet, true);           /* 加密固定 1% */
  assert.equal(Q.quietDay(-1.5, 4).quiet, true);
  assert.equal(Q.quietDay(2.5, 4).quiet, false);
  assert.equal(Q.quietDay(2.9, 20).lim, 3);
});

test('盤中爆量帶出量增價平標記，排在前面', () => {
  const T = T0 + 8 * D;
  const mk = (chg) => {
    const bars = [];
    for (let t = T - 8 * D; t < T; t += H) bars.push({ t, o: 100, h: 102, l: 100, c: 101, qv: 1e6 });
    bars.push({ t: T, o: 100, h: 101, l: 99.5, c: 100 * (1 + chg / 100), qv: 2e7 });
    return bars;
  };
  const e = (base, chg) => ({ venue: 'okx', sym: `${base}-USDT-SWAP`, base, cat: 'crypto', stats: hourStats(mk(chg), T, 'crypto') });
  const st = emptyHourly();
  const al = pickAlerts(st, [e('LOUD', 5), e('CALM', 0.3)], T);
  assert.equal(al.length, 2);
  assert.equal(al[0].base, 'CALM');
  assert.equal(al[0].quiet, true);
  assert.equal(al[1].quiet, false);
  const items = Q.fromHourly(al);
  assert.equal(items.length, 1);
  assert.equal(items[0].t, T + H);
});

test('追蹤 24h／72h 漲跌、抓不到價格逾時放棄、統計', () => {
  const s = Q.emptyQuiet();
  const it = { key: 'h:A:1', src: 'hourly', base: 'A', cat: 'crypto', venue: 'okx', id: 'A-USDT-SWAP', t: T0, price: 100, chg: 0.2, lim: 1, ref: 2, x: 9, r: {} };
  assert.equal(Q.addItems(s, [it, { ...it }]).length, 1);
  Q.updateItems(s, () => 110, T0 + 10 * H);
  assert.equal(s.items[0].r[24], undefined);
  Q.updateItems(s, () => 110, T0 + 25 * H);
  assert.equal(s.items[0].r[24], 10);
  Q.updateItems(s, () => null, T0 + 73 * H);                            /* 還在寬限期 */
  assert.equal(s.items.length, 1);
  Q.updateItems(s, () => null, T0 + 85 * H);                            /* 逾時放棄 */
  assert.equal(s.items.length, 0);
  assert.equal(s.done[0].r[72], null);
  const st = Q.quietStats(s);
  assert.equal(st.all[24].n, 1);
  assert.equal(st.all[72], null);
  assert.equal(Q.addItems(s, [it]).length, 0);                           /* 結算過的不再加入 */
});

test('通知文字與狀態存取', () => {
  const s = Q.emptyQuiet();
  const items = [{ key: 's:B:1', src: 'short', base: 'B', cat: 'stock', venue: 'okx', id: 'B-USDT-SWAP', t: T0, price: 20, chg: -0.8, lim: 1.5, ref: 3, x: 4.2, r: {} }];
  Q.addItems(s, items);
  const txt = render(Q.quietAlertText(items, T0), 'plain');
  assert.match(txt, /【量增價平】/);
  assert.match(txt, /每日爆量（短線） 4.2x｜當日 -0.8%（ATR 3%）/);
  assert.equal(Q.quietAlertText([], T0), '');
  const md = Q.embedQuiet(Q.quietMarkdown(s, { nowMs: T0 }), s);
  assert.equal(Q.extractQuiet(md).items.length, 1);
  assert.equal(Q.extractQuiet('x <!-- QUIET_STATE\nbad\nQUIET_STATE -->'), null);
});
