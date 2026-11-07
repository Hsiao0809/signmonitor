import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../src/sweep.mjs';

const H4 = 4 * 3600e3, D = 24 * 3600e3;
const T0 = Date.UTC(2026, 9, 1);
/* 平盤 n 根：收 100、高 101、低 99、量 1e6 */
function flat(n, start = T0) {
  return Array.from({ length: n }, (_, i) => ({ t: start + i * H4, o: 100, h: 101, l: 99, c: 100, qv: 1e6 }));
}
const after = bars => bars[bars.length - 1].t + H4 + 60e3;   /* 最後一根剛收盤 */

test('掃上方：影線越過前日高、收盤收回 → 標記；收盤站上則不算', () => {
  const bars = flat(36);                      /* 6 天，每天 6 根 */
  const last = bars[bars.length - 1];
  last.h = 103; last.c = 100.5; last.qv = 2e6;
  let ev = S.detect(bars, after(bars));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].side, 'up');
  assert.deepEqual(ev[0].lv.map(x => x.k), ['pd']);
  assert.equal(ev[0].lv[0].p, 101);
  assert.equal(ev[0].volx, 2);
  assert.match(S.label(ev[0]), /掃上・前日高・有量/);

  last.c = 102;                                /* 收盤站上 → 是突破不是掃 */
  ev = S.detect(bars, after(bars));
  assert.equal(ev.length, 0);
});

test('掃下方＋無量；未收盤的 K 不算', () => {
  const bars = flat(36);
  const last = bars[bars.length - 1];
  last.l = 97; last.c = 99.5;
  const ev = S.detect(bars, after(bars));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].side, 'dn');
  assert.equal(ev[0].volx, 1);
  assert.doesNotMatch(S.label(ev[0]), /有量/);
  assert.equal(S.detect(bars, last.t + 3600e3).length, 0);
});

test('波段高點：左右各 3 根都比它低才算；被收盤越過後失效', () => {
  const bars = flat(36);
  bars[28].h = 105;                            /* 今天第 5 根，前日高仍是 101 */
  const last = bars[35];
  last.h = 106; last.c = 100;
  const at = () => S.detect(bars, after(bars)).filter(e => e.t === last.t);   /* 第 28 根本身也掃了前日高，只看最後一根 */
  let ev = at();
  assert.equal(ev.length, 1);
  const kinds = ev[0].lv.map(x => x.k);
  assert.ok(kinds.includes('swing'));
  assert.equal(ev[0].lv.find(x => x.k === 'swing').p, 105);

  bars[31].c = 105.5; bars[31].h = 105.6;      /* 之後有一根收盤站上 105 → 這個波段點失效 */
  ev = at();
  assert.ok(!ev.some(e => e.lv.some(x => x.k === 'swing' && x.p === 105)));
});

test('爆量日高低：短線給 hi/lo；布局只給 dayT 時從 4H K 算', () => {
  const bars = flat(42);
  const dayT = T0 + 5 * D;                     /* 第 30～35 根 */
  bars[32].h = 110; bars[33].l = 90;
  const last = bars[41];
  last.h = 111; last.c = 104;                 /* 越過 110、收回；110 同時是前日高與波段高 */
  const at = sp => S.detect(bars, after(bars), sp).filter(e => e.t === last.t);
  let ev = at({ dayT });
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].lv.map(x => x.k), ['spike', 'pd', 'swing']);
  assert.equal(ev[0].lv[0].p, 110);

  ev = at({ dayT, hi: 108, lo: 92 });
  assert.equal(ev[0].lv.find(x => x.k === 'spike').p, 108);

  /* 爆量日不在資料範圍內 → 不用這個價位 */
  ev = at({ dayT: T0 - 30 * D });
  assert.ok(!ev[0].lv.some(x => x.k === 'spike'));
});

test('只保留最近 72 小時', () => {
  const bars = flat(60);
  bars[30].h = 103; bars[30].c = 100;          /* 很早之前的掃 */
  assert.equal(S.detect(bars, after(bars)).length, 0);
});

test('apply：抓不到的沿用舊紀錄、不在清單的移除、firstSeen 保留', () => {
  const bars = flat(36);
  bars[35].h = 103; bars[35].c = 100.5;
  const now = after(bars);
  const tg = base => ({ base, cat: 'crypto', ex: 'okx', id: base + '-USDT-SWAP', src: ['short'] });
  const st = S.emptySweep();
  S.apply(st, [{ target: tg('AAA'), bars }, { target: tg('BBB'), bars }], bars[35].t, now);
  assert.equal(st.events.length, 2);
  const first = st.events[0].firstSeen;

  S.apply(st, [{ target: tg('AAA'), bars: null }, { target: tg('BBB'), bars }], bars[35].t, now + H4);
  assert.equal(st.events.length, 2);           /* AAA 沿用舊的 */
  assert.equal(st.events.find(e => e.base === 'BBB').firstSeen, first);

  S.apply(st, [{ target: tg('BBB'), bars }], bars[35].t, now + H4);
  assert.deepEqual(st.events.map(e => e.base), ['BBB']);
});

test('Issue 本文可以存回讀出', () => {
  const st = S.emptySweep();
  st.events.push({ base: 'X', cat: 'crypto', ex: 'okx', id: 'X', src: ['watch'], t: T0, side: 'up', lv: [{ k: 'pd', p: 1.2345678 }], x: 1.3, c: 1.2, volx: 1.6 });
  const body = S.embedSweep(S.sweepMarkdown(st, { nowMs: T0 }), st);
  const back = S.extractSweep(body);
  assert.equal(back.events[0].base, 'X');
  assert.deepEqual(S.extractSweep(''), S.emptySweep());
  assert.equal(S.extractSweep(body.replace(/SWEEP_STATE\n.*\n/, 'SWEEP_STATE\nxx\n')), null);
});

test('股票在週末發生的加「週末」標記', () => {
  const sat = Date.UTC(2026, 10, 7, 8);       /* 2026-11-07（六）UTC 08:00 */
  const bars = flat(36, sat - 35 * H4);
  bars[35].h = 103; bars[35].c = 100.5;
  const st = S.emptySweep();
  S.apply(st, [{ target: { base: 'AAPL', cat: 'stock', ex: 'okx', id: 'x', src: ['layout'] }, bars },
    { target: { base: 'BTC', cat: 'crypto', ex: 'okx', id: 'y', src: ['watch'] }, bars }], bars[35].t, after(bars));
  const a = st.events.find(e => e.base === 'AAPL' && e.t === bars[35].t), b = st.events.find(e => e.base === 'BTC' && e.t === bars[35].t);
  assert.match(S.label(a), /週末/);
  assert.doesNotMatch(S.label(b), /週末/);
});
