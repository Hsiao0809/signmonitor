import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeFeat, shapeTag, shapeLabel, shapeNotes, regimeOf } from '../src/shape.mjs';
import { hourStats, pickAlerts, emptyHourly, hourlyAlertText } from '../src/hourly.mjs';
import { pickPre, emptyPre, preAlertText } from '../src/early.mjs';
import * as SC from '../src/score.mjs';

const H = 3600e3;
const T = Date.UTC(2026, 10, 13, 6);
const ON = { on: true };
/* 200 根 1H：price(i) 給第 i 根（0＝最舊）的收盤，高低各加減 spread；cur 是這一根 */
function series({ price = () => 1, spread = 0.01, qv = 4e5, cur }) {
  const bars = [];
  for (let k = 200; k >= 1; k--) { const c = price(200 - k); bars.push({ t: T - k * H, o: c, h: c * (1 + spread), l: c * (1 - spread), c, qv }); }
  bars.push({ t: T, ...cur });
  return bars;
}
const feat = (o) => shapeFeat(new Map(series(o).map(b => [b.t, b])), T);
const tagOf = (o, opt = ON) => shapeTag(feat(o), opt);

test('特徵：前 7 天高低、振幅、影線；歷史不足或沒有高低價不算', () => {
  const bars = series({ cur: { o: 1, h: 1.05, l: 0.95, c: 1.04, qv: 1e7 } });
  const f = shapeFeat(new Map(bars.map(b => [b.t, b])), T);
  assert.ok(Math.abs(f.hi - 1.01) < 1e-9 && Math.abs(f.lo - 0.99) < 1e-9);
  assert.ok(Math.abs(f.wid - (1.01 / 0.99 - 1)) < 1e-9);
  assert.ok(Math.abs(f.uw - 0.1) < 1e-9 && Math.abs(f.lw - 0.5) < 1e-9);
  assert.ok(Math.abs(f.sl) < 1e-9, '走平斜率為 0');
  assert.equal(shapeFeat(new Map(bars.slice(-50).map(b => [b.t, b])), T), null);
  assert.equal(shapeFeat(new Map([[T, { t: T, o: 0, h: 0, l: 0, c: 0, qv: 1 }]]), T), null);
});

test('八種結構；收在區間內依位置分下緣／中段／上緣', () => {
  /* 走平、振幅 2%：收上高點 → 窄幅突破 */
  assert.equal(tagOf({ cur: { o: 1, h: 1.04, l: 1, c: 1.03, qv: 1e7 } }), 'nb');
  /* 前 7 天振幅大（來回 20%）、沒有趨勢 → 突破前高 */
  const wide = i => 1 + 0.1 * Math.sin(i / 12);
  assert.equal(tagOf({ price: wide, cur: { o: 1.1, h: 1.16, l: 1.1, c: 1.15, qv: 1e7 } }), 'wb');
  /* 穩定上升 30% → 續創高 */
  const up = i => 1 + 0.3 * i / 200;
  assert.equal(tagOf({ price: up, cur: { o: 1.3, h: 1.36, l: 1.3, c: 1.35, qv: 1e7 } }), 'tr');
  /* 前 3 天已漲 ≥25% → 漲多再噴 */
  const ran = i => (i < 150 ? 1 : 1 + 0.4 * (i - 150) / 50);
  assert.equal(tagOf({ price: ran, cur: { o: 1.4, h: 1.5, l: 1.4, c: 1.48, qv: 1e7 } }), 'cl');
  /* 刺破低點收回、長下影 → 下掃收回 */
  assert.equal(tagOf({ cur: { o: 1, h: 1.005, l: 0.95, c: 1, qv: 1e7 } }), 'sl');
  /* 刺破高點收回、長上影 → 上掃回落 */
  assert.equal(tagOf({ cur: { o: 1, h: 1.06, l: 0.995, c: 1, qv: 1e7 } }), 'sh');
  /* 收在低點之下 → 爆量跌破 */
  assert.equal(tagOf({ cur: { o: 1, h: 1, l: 0.95, c: 0.96, qv: 1e7 } }), 'bd');
  /* 前 3 天已跌 ≥25% 再破低 → 跌深再殺 */
  const fell = i => (i < 150 ? 1 : 1 - 0.3 * (i - 150) / 50);
  assert.equal(tagOf({ price: fell, cur: { o: 0.7, h: 0.7, l: 0.62, c: 0.63, qv: 1e7 } }), 'pn');
  /* 收在高低點之間（前 7 天 0.99～1.01）→ 依位置 */
  assert.equal(tagOf({ cur: { o: 1, h: 1.005, l: 0.995, c: 1.002, qv: 1e7 } }), 'rm');
  assert.equal(tagOf({ cur: { o: 1, h: 1.009, l: 0.995, c: 1.008, qv: 1e7 } }), 'rh');
  assert.equal(tagOf({ cur: { o: 1, h: 1.005, l: 0.991, c: 0.993, qv: 1e7 } }), 'rl');
  /* 刺破低點但下影不夠長、收盤仍在區間內 → 區間下緣 */
  assert.equal(tagOf({ cur: { o: 1.005, h: 1.008, l: 0.985, c: 0.991, qv: 1e7 } }), 'rl');
});

test('盤中推算不判斷影線類；關閉就不標', () => {
  const sweep = { cur: { o: 1, h: 1.005, l: 0.95, c: 1, qv: 1e7 } };
  assert.equal(tagOf(sweep, { partial: true, on: true }), 'rm', '推算不判斷下掃，收在區間內就標區間位置');
  assert.equal(tagOf({ cur: { o: 1, h: 1.04, l: 1, c: 1.03, qv: 1e7 } }, { partial: true, on: true }), 'nb');
  assert.equal(tagOf(sweep, { on: false }), null);
  assert.equal(shapeTag(null, ON), null);
  assert.equal(shapeLabel({ shape: 'sl' }), '【下掃收回】');
  assert.equal(shapeLabel({}), '');
  assert.equal(shapeLabel({ shape: 'rl', spos: 22 }), '【區間下緣 22%】');
  assert.equal(shapeLabel({ shape: 'rh' }), '【區間上緣】');
  assert.equal(shapeNotes([{ cat: 'crypto', shape: 'rl', chg: 1 }, { cat: 'crypto', shape: 'rm', chg: 12 }], 'down').length, 0, '區間內不放回測說明');
});

test('說明：只看加密；下掃／上掃依大盤才出現；突破且已漲 ≥10% 加不追', () => {
  const a = (shape, extra = {}) => ({ cat: 'crypto', shape, chg: 1, ...extra });
  assert.equal(shapeNotes([{ cat: 'stock', shape: 'nb', chg: 1 }]).length, 0);
  assert.equal(shapeNotes([a('sl')], 'up').length, 0);
  assert.match(shapeNotes([a('sl')], 'down')[0], /下掃收回/);
  assert.equal(shapeNotes([a('sh')], 'down').length, 0);
  assert.match(shapeNotes([a('sh')], 'up')[0], /上掃回落/);
  const n = shapeNotes([a('wb', { chg: 12 }), a('tr')], null);
  assert.equal(n.length, 2); assert.match(n[1], /不追/);
  assert.equal(shapeNotes([a('nb'), a('nb')]).length, 1, '同一種只寫一行');
  assert.equal(shapeNotes([{ cat: 'crypto', chg: 1 }]).length, 0);
});

test('大盤狀態取自 BTC 的 7 天漲跌', () => {
  const e = r => [{ base: 'BTC', cat: 'crypto', stats: { bf: { r7d: r } } }];
  assert.equal(regimeOf(e(0.05)), 'up'); assert.equal(regimeOf(e(-0.05)), 'down'); assert.equal(regimeOf(e(0.01)), 'flat');
  assert.equal(regimeOf([{ base: 'ETH', cat: 'crypto', stats: { bf: { r7d: 0.1 } } }]), null);
  assert.equal(regimeOf([]), null);
});

test('盤中爆量與預警：文字有結構標記、狀態有 shape；偵測與排序不變', () => {
  const mk = (base, bars, cat = 'crypto') => ({ venue: 'okx', sym: `${base}-USDT-SWAP`, base, cat, stats: hourStats(bars, T, cat) });
  const brk = mk('AAA', series({ spread: 0.1, cur: { o: 1, h: 1.3, l: 1, c: 1.28, qv: 4e6 } }));
  const flat = mk('BBB', series({ spread: 0.1, cur: { o: 1, h: 1.08, l: 1, c: 1.06, qv: 4e6 } }));
  const stk = mk('CCC', series({ spread: 0.1, cur: { o: 1, h: 1, l: 0.7, c: 0.72, qv: 4e6 } }), 'stock');
  const al = pickAlerts(emptyHourly(), [flat, brk, stk], T);
  assert.equal(al.length, 3);
  const by = Object.fromEntries(al.map(a => [a.base, a]));
  assert.equal(by.AAA.shape, 'wb'); assert.equal(by.BBB.shape, 'rh'); assert.equal(by.BBB.spos, 80); assert.equal(by.CCC.shape, 'bd');
  assert.equal(typeof by.AAA.shi, 'number');
  const txt = hourlyAlertText(al, T);
  assert.match(txt, /【突破前高】\u0001AAA\u0002/);
  assert.match(txt, /【爆量跌破】\u0001CCC\u0002/);
  assert.match(txt, /【區間上緣 80%】\u0001BBB\u0002/);
  assert.match(txt, /\n【突破前高】【續創高】回測/);
  assert.match(txt, /這根 1H 已漲 ≥10%/);
  assert.doesNotMatch(txt, /\n【爆量跌破】回測/, '股票只標結構，不放回測數字');
  /* 預警：量只到 2 倍多，結構一樣標 */
  const pre = mk('DDD', series({ spread: 0.1, cur: { o: 1, h: 1.3, l: 1, c: 1.28, qv: 1e6 } }));
  const added = pickPre(emptyPre(), [pre], T);
  assert.equal(added.length, 1); assert.equal(added[0].shape, 'wb');
  assert.match(preAlertText(added, T), /【突破前高】\u0001DDD\u0002/);
});

test('成績：發送紀錄的結構標記會進 tg，並依標記分組', () => {
  const now = Date.UTC(2026, 10, 20);
  const mk = (tg, r, i, c = '加密') => ({ k: 'hourly', c, b: 'X' + i, t: Date.UTC(2026, 10, 16, 12) + i * 3600e3, tg, e: 1, m: { 72: [r, 0.2, -0.05, 0] } });
  const recs = [mk(['下掃收回'], 0.1, 1), mk(['下掃收回', '自選'], 0.02, 2), mk(['爆量跌破'], -0.03, 3), mk([], 0.01, 4), mk(['窄幅突破'], 0.05, 5, '股票'), mk(['可略過', '區間下緣 22%'], 0.03, 6), mk(['區間下緣 5%'], 0.03, 7), mk(['區間上緣 90%'], 0.03, 8)];
  const w = SC.summarize(recs, now).win.all;
  const g = (m, c) => w.shapes.find(x => x.m === m && x.c === c)?.h[72];
  assert.equal(g('sl', '加密').n, 2); assert.equal(g('bd', '加密').n, 1); assert.equal(g('none', '加密').n, 1);
  assert.equal(g('rl', '加密').n, 2); assert.equal(g('rh', '加密').n, 1); assert.equal(g('rm', '加密'), undefined);
  assert.equal(g('nb', '股票').n, 1); assert.equal(g('nb', '加密'), undefined);
  assert.match(SC.renderMd(SC.summarize(recs, now)), /結構標記/);
});
