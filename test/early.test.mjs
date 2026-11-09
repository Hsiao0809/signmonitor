import test from 'node:test';
import assert from 'node:assert/strict';
import * as HR from '../src/hourly.mjs';
import * as E from '../src/early.mjs';

const H = 3600e3, D = 24 * H;
const T = Date.UTC(2026, 10, 4, 14);                 /* 週三 14:00 UTC */
/* 10 天每小時資料，平常 1e5；last 可以指定最後幾根的量 */
function bars(tail = {}) {
  const out = [];
  for (let t = T - 10 * D; t <= T; t += H) out.push({ t, o: 10, h: 10.3, l: 9.9, c: 10.1, qv: tail[(T - t) / H] ?? 1e5 });
  return out;
}

test('比前一根、連續放量的倍數', () => {
  const st = HR.hourStats(bars({ 0: 4e5, 1: 3e5, 2: 2e5, 3: 1.5e5 }), T, 'crypto');
  assert.ok(Math.abs(st.xp - 4e5 / 3e5) < 1e-9);
  assert.ok(Math.abs(st.cum - 9e5) < 1e-9);
  assert.ok(st.cx > 2.5 && st.cx < 3.1);              /* 9e5 ÷ (3 × 近 48h 平均) */
  assert.equal(HR.isAnomaly(st, 'crypto'), false);
  assert.equal(HR.isRamp(st, 'crypto'), true);
  /* 中間有一根沒放大就不算 */
  const st2 = HR.hourStats(bars({ 0: 4e5, 1: 3e5, 2: 3.5e5, 3: 1.5e5 }), T, 'crypto');
  assert.equal(st2.cx, null);
  assert.equal(HR.isRamp(st2, 'crypto'), false);
});

test('連續放量也推播，標【連續放量】；12 小時內累積倍數沒翻倍不重複', () => {
  const s = HR.emptyHourly();
  const st = HR.hourStats(bars({ 0: 4e5, 1: 3e5, 2: 2e5, 3: 1.5e5 }), T, 'crypto');
  const e = [{ venue: 'okx', sym: 'X-USDT-SWAP', base: 'X', cat: 'crypto', stats: st }];
  const a = HR.pickAlerts(s, e, T);
  assert.equal(a.length, 1);
  assert.equal(a[0].rampOnly, true);
  assert.match(HR.hourlyAlertText(a, T), /【連續放量】\x01X/);
  assert.match(HR.hourlyAlertText(a, T), /連續 4 根放大/);
  assert.equal(HR.pickAlerts(s, e, T + H).length, 0);
});

test('預警：比前一根 2 倍或同時段 2 倍，正式爆量不列預警；6 小時內不重複', () => {
  const ps = E.emptyPre();
  const pre = { x1: 1.5, x2: 1.4, xp: 2.4, cx: null, qv: 5e5, chg: 0.01, price: 1 };
  const spike = { x1: 9, x2: 5, xp: 6, cx: null, qv: 5e6, chg: 0.01, price: 1 };
  const small = { x1: 3, x2: 3, xp: 3, cx: null, qv: 1e4, chg: 0, price: 1 };
  const entries = [
    { venue: 'okx', sym: 'A-USDT-SWAP', base: 'A', cat: 'crypto', stats: pre },
    { venue: 'okx', sym: 'B-USDT-SWAP', base: 'B', cat: 'crypto', stats: spike },
    { venue: 'okx', sym: 'C-USDT-SWAP', base: 'C', cat: 'crypto', stats: small }      /* 成交額太小 */
  ];
  const got = E.pickPre(ps, entries, T);
  assert.deepEqual(got.map(p => [p.base, p.c]), [['A', 'A']]);
  assert.equal(E.pickPre(ps, entries, T + H).length, 0);
  assert.equal(E.pickPre(ps, [{ ...entries[0], stats: { ...pre, xp: 5 } }], T + 2 * H).length, 1);   /* 倍數翻倍 */
  const txt = E.preAlertText(got, T);
  assert.match(txt, /【預警】/);
  assert.match(txt, /前一根 2\.4x／同時段 1\.5x/);
});

test('正式爆量註明幾小時前預警、第幾分已推算', () => {
  const ps = E.emptyPre();
  const k = { venue: 'okx', sym: 'A-USDT-SWAP', base: 'A', cat: 'crypto' };
  E.pickPre(ps, [{ ...k, stats: { x1: 2.5, x2: 2, xp: 2.1, cx: null, qv: 5e5, chg: 0, price: 1 } }], T - 2 * H);
  E.pickEarly(ps, HR.emptyHourly(), [{ ...k, stats: { x1: 6, x2: 4, qv: 3e6, qvNow: 7.5e5, chg: 0, price: 1 } }], T, 15);
  const a = HR.pickAlerts(HR.emptyHourly(), [{ ...k, stats: { x1: 8, x2: 5, xp: 3, cx: null, qv: 4e6, chg: 0, price: 1 } }], T, HR.HOURLY, E.preContext(ps, T));
  assert.equal(a[0].preH, 2);
  assert.equal(a[0].earlyMin, 15);
  assert.match(HR.hourlyAlertText(a, T), /第 15 分已推算通知｜2 小時前已預警/);
});

test('盤中推算：用已成交量換算整根，達正式門檻才通知；同一小時不重複', () => {
  const b = bars();
  const live = { t: T, o: 10, h: 10.2, l: 10, c: 10.1, qv: 2.5e5 };   /* 24h 只漲 1%，不算已漲過 */          /* 15 分鐘就 2.5e5 → 整根 1e6 */
  const st = E.earlyStats(b.filter(x => x.t < T), live, T + 15 * 60e3, 'crypto');
  assert.ok(Math.abs(st.qv - 1e6) < 1);
  assert.ok(st.x1 >= 9.9 && st.x2 >= 9.9);
  const ps = E.emptyPre(), hs = HR.emptyHourly();
  const e = [{ venue: 'okx', sym: 'X-USDT-SWAP', base: 'X', cat: 'crypto', stats: st }];
  const a = E.pickEarly(ps, hs, e, T, 15);
  assert.equal(a.length, 1);
  assert.equal(a[0].qvNow, 2.5e5);
  assert.equal(E.pickEarly(ps, hs, e, T, 30).length, 0);
  assert.equal(ps.lastSlot, `${T}:30`);
  const txt = E.earlyAlertText(a, T, 15);
  assert.match(txt, /【盤中推算】/);
  assert.match(txt, /第 15 分/);
  assert.match(txt, /約 47%/);
  /* 正式爆量 12 小時內通知過，量沒翻倍就不推算通知 */
  hs.last['okx:Y-USDT-SWAP'] = { t: T - 2 * H, x1: 8 };
  assert.equal(E.pickEarly(E.emptyPre(), hs, [{ ...e[0], sym: 'Y-USDT-SWAP', base: 'Y' }], T, 15).length, 0);
});

test('推算時段：第 10–47 分', () => {
  assert.equal(E.slotOf(T + 5 * 60e3), null);
  assert.equal(E.slotOf(T + 16 * 60e3), 15);
  assert.equal(E.slotOf(T + 31 * 60e3), 30);
  assert.equal(E.slotOf(T + 46 * 60e3), 45);
  assert.equal(E.slotOf(T + 50 * 60e3), null);
});

test('狀態存取與本文上限', () => {
  const ps = E.emptyPre();
  for (let i = 0; i < 3000; i++) ps.pre.push({ t: T, venue: 'okx', sym: `S${i}-USDT-SWAP`, base: `S${i}`, cat: 'crypto', c: 'A', xp: 2, x1: 1, x2: 1, qv: 5e5, chg: 0, price: 1, watch: false, closed: false });
  const body = E.preBody(ps, { nowMs: T });
  assert.ok(body.length <= 60000);
  assert.equal(E.extractPre(body).pre.length, 3000);
  assert.equal(E.extractPre('').pre.length, 0);
});

test('連續放量發生在每天固定放量的時段 → 加【時段性】', () => {
  /* 每天 11–14 點都是 4e5→3e5→2e5→1.5e5 的放量節奏 */
  const out = [];
  for (let t = T - 10 * D; t <= T; t += H) {
    const k = ((T - t) / H) % 24;
    out.push({ t, o: 10, h: 10.3, l: 9.9, c: 10.1, qv: k === 0 ? 4e5 : k === 1 ? 3e5 : k === 2 ? 2e5 : k === 3 ? 1.5e5 : 1e5 });
  }
  const st = HR.hourStats(out, T, 'crypto');
  assert.ok(st.cxs < 1.1);
  const a = HR.pickAlerts(HR.emptyHourly(), [{ venue: 'okx', sym: 'X-USDT-SWAP', base: 'X', cat: 'crypto', stats: st }], T);
  assert.equal(a[0].season, true);
  assert.match(HR.hourlyAlertText(a, T), /【時段性】/);
});

test('盤中推算：近 24h 已漲過或跌過 1 倍日 ATR 的不推播，只標記', () => {
  /* 平常每小時高低 ±1%（日 ATR 約 2% 多），最近 24 小時從 10 漲到 11 */
  const out = [];
  for (let t = T - 10 * D; t < T; t += H) {
    const c = t >= T - D ? 10 + (t - (T - D)) / D : 10;
    out.push({ t, o: c, h: c * 1.01, l: c * 0.99, c, qv: 1e5 });
  }
  const live = { t: T, o: 11, h: 11, l: 11, c: 11, qv: 2.5e5 };
  const st = E.earlyStats(out, live, T + 15 * 60e3, 'crypto');
  assert.ok(st.move.chg24 > 9 && st.move.atrp > 1.5 && st.move.atrp < 8);
  assert.equal(E.movedOf(st.move), 'up');
  assert.equal(E.movedOf({ chg24: -6, atrp: 5 }), 'down');
  assert.equal(E.movedOf({ chg24: 3, atrp: 5 }), null);
  assert.equal(E.movedOf(null), null);                                     /* 資料不足照常推播 */
  const ps = E.emptyPre(), hs = HR.emptyHourly();
  const e = [{ venue: 'okx', sym: 'X-USDT-SWAP', base: 'X', cat: 'crypto', stats: st }];
  const a = E.pickEarly(ps, hs, e, T, 15);
  assert.equal(a[0].moved, 'up');
  assert.equal(E.earlyAlertText(a, T, 15), '');                            /* 全部已漲過 → 不發 */
  assert.equal(E.preContext(ps, T).earlyOf('okx:X-USDT-SWAP'), null);      /* 正式爆量不註明已推算 */
  /* 第 30 分價格回到原點（剛開始動）→ 照常推播 */
  const st2 = { ...st, move: { chg24: 0.5, atrp: 3 } };
  const a2 = E.pickEarly(ps, hs, [{ ...e[0], stats: st2 }], T, 30);
  assert.equal(a2.length, 1);
  assert.equal(a2[0].moved, undefined);
  assert.match(E.earlyAlertText([...a2, ...a], T, 30), /另有 1 檔這根之前 24h 已漲過或跌過/);
  assert.equal(E.preContext(ps, T).earlyOf('okx:X-USDT-SWAP').min, 30);
  /* 第 45 分又是已漲過且量沒翻倍 → 不重複列 */
  assert.equal(E.pickEarly(ps, hs, e, T, 45).length, 0);
});

test('這根自己正在急拉的不算已漲過，照樣推播', () => {
  const out = [];
  for (let t = T - 10 * D; t < T; t += H) out.push({ t, o: 10, h: 10.1, l: 9.9, c: 10, qv: 1e5 });
  const mv = E.moveOf(out, { t: T, o: 10, h: 12, l: 10, c: 12, qv: 3e5 });   /* 這根已經 +20% */
  assert.ok(Math.abs(mv.chg24) < 1e-9);
  assert.equal(E.movedOf(mv), null);
});

test('預警訊息附價格；正式爆量附預警價與至今漲跌', () => {
  const ps = E.emptyPre();
  const k = { venue: 'okx', sym: 'A-USDT-SWAP', base: 'A', cat: 'crypto' };
  const got = E.pickPre(ps, [{ ...k, stats: { x1: 2.5, x2: 2, xp: 2.1, cx: null, qv: 5e5, chg: 0, price: 0.3712 } }], T - 3 * H);
  assert.match(E.preAlertText(got, T - 3 * H), /｜價 0\.3712/);
  /* 更晚又預警一次：仍以最早那次為準 */
  E.pickPre(ps, [{ ...k, stats: { x1: 6, x2: 3, xp: 2.5, cx: null, qv: 9e5, chg: 0, price: 0.38 } }], T - H);
  const a = HR.pickAlerts(HR.emptyHourly(), [{ ...k, stats: { x1: 8, x2: 5, xp: 3, cx: null, qv: 4e6, chg: 0, price: 0.3864 } }], T, HR.HOURLY, E.preContext(ps, T));
  assert.equal(a[0].preH, 3);
  assert.equal(a[0].prePx, 0.3712);
  assert.match(HR.hourlyAlertText(a, T), /3 小時前已預警（預警價 0\.3712，至今 \+4\.1%）/);
});

test('preOf 舊版回傳時間數字仍可用', () => {
  const k = { venue: 'okx', sym: 'B-USDT-SWAP', base: 'B', cat: 'crypto' };
  const a = HR.pickAlerts(HR.emptyHourly(), [{ ...k, stats: { x1: 8, x2: 5, xp: 3, cx: null, qv: 4e6, chg: 0, price: 1 } }], T, HR.HOURLY, { preOf: () => T - 2 * H });
  assert.equal(a[0].preH, 2);
  assert.equal(a[0].prePx, undefined);
});
