import test from 'node:test';
import assert from 'node:assert/strict';
import { simRule, ruleStats } from '../src/rule.mjs';
import { sizing, cardLine } from '../src/risk.mjs';
import * as TR from '../src/tier.mjs';
import * as CR from '../src/cross.mjs';
import * as SC from '../src/score.mjs';

const B = (h, l, c) => ({ h, l, c });
const costR = (e, risk) => 0.002 * e / risk;
const near = (a, b) => assert.ok(Math.abs(a - b) < 0.011, `${a} ≈ ${b}`);

test('照規則：直接打到停損＝ -1R（扣成本）', () => {
  const r = simRule(1, 100, 95, [B(101, 94, 96)]);
  assert.equal(r.why, '停損'); assert.equal(r.open, false);
  near(r.r, -1 - costR(100, 5));
});

test('照規則：先到 2R 平一半，之後回到成本＝ +1R；同一根同時碰停損與 2R 算停損', () => {
  const a = simRule(1, 100, 95, [B(111, 99, 108), B(109, 99.5, 101), B(102, 99, 100)]);
  assert.equal(a.why, '保本'); assert.equal(a.half, true);
  near(a.r, 1 - costR(100, 5));
  const b = simRule(1, 100, 95, [B(111, 94, 100)]);
  assert.equal(b.why, '停損'); near(b.r, -1 - costR(100, 5));
});

test('照規則：剩下的收盤跌破 EMA20 出場；沒傳 EMA 抱到資料結束＝持有中', () => {
  const a = simRule(1, 100, 95, [B(111, 101, 110), B(112, 106, 107)], [100, 108]);
  assert.equal(a.why, 'EMA20');
  near(a.r, 1 + 0.5 * 7 / 5 - costR(100, 5));
  const b = simRule(1, 100, 95, [B(103, 99, 102)]);
  assert.equal(b.open, true); near(b.r, 0.4 - costR(100, 5));
});

test('照規則：做空鏡像；停損在錯的一邊回傳 null', () => {
  const s = simRule(-1, 100, 105, [B(101, 89, 92), B(99.5, 91, 95)]);
  assert.equal(s.half, true); assert.equal(s.open, true);
  near(s.r, 1 + 0.5 * 1 - costR(100, 5));
  assert.equal(simRule(1, 100, 101, [B(101, 99, 100)]), null);
  assert.equal(simRule(-1, 100, 99, [B(101, 99, 100)]), null);
});

test('照規則統計：平均、中位數、勝率', () => {
  assert.deepEqual(ruleStats([1, -1, 2, null]), { n: 3, avg: 0.67, win: 66.7, med: 1 });
  assert.deepEqual(ruleStats([]), { n: 0 });
});

test('下單卡：本金 300U、1% 風險，停損 3% → 名目 100U、不需槓桿；停損太近要槓桿時提醒強平距離', () => {
  const risk = { capital: 300, riskPct: 1 };
  const s = sizing(1, 100, 97, risk);
  near(s.notional, 100); near(s.t2, 106);
  const c = cardLine(1, 100, 97, risk);
  assert.match(c, /^  下單卡｜停損 97\.0+（3\.0%）｜虧 3\.0U → 名目 100U，不需槓桿｜2R 106/);
  assert.match(cardLine(1, 100, 99.5, risk), /需 ≥ 2 倍，強平距離要 ≥ 1%/);
  assert.match(cardLine(-1, 0.1, 0.11, risk), /停損 0\.11.*（10\.0%）.*名目 30\.0U/);
  assert.equal(cardLine(1, 100, 101, risk), '');
  assert.equal(cardLine(1, 100, 97, null), '');
});

test('分級 C：不推、但訊號照記（共振仍算）；B 類早期型也會進每日摘要，不會卡在 pending', () => {
  const cfg = { ...TR.DEFAULTS, mode: 'tiered', tiers: { pre: 'C', hourly: 'B', cross: 'A' } };
  const st = TR.emptyState();
  const t0 = Date.UTC(2026, 10, 19, 4);   /* 台灣 12:00 */
  const msgs = [{ k: 'pre', text: 'P' }, { k: 'hourly', text: 'H' }, { k: 'cross', text: 'C' }];
  const r = TR.plan(msgs, [{ k: 'pre', base: 'MEGA' }, { k: 'cross', base: 'MEGA' }], t0, st, cfg);
  assert.deepEqual(r.out.map(m => m.k), ['cross', 'resonance']);
  assert.deepEqual(r.muted.map(m => m.k), ['pre']);
  assert.equal(st.pending.length, 1);
  const r2 = TR.plan([], [], Date.UTC(2026, 10, 19, 12), st, cfg);   /* 台灣 20:00 */
  assert.deepEqual(r2.out.map(m => m.k), ['hourly']);
  assert.equal(st.pending.length, 0);
  assert.deepEqual(TR.missingImmediate(msgs, r.out, cfg), []);
});

test('金叉下單卡：離 EMA20 超過 1 倍日 ATR 改掛回踩價；附 BTC 4H 狀態；沒設定就維持原格式', () => {
  const T = Date.UTC(2026, 10, 15, 8);
  const x = { key: 'k', sym: 'MEGAUSDT', base: 'MEGA', t: T, close: 0.05036, ema: 0.0498, stopPx: 0.04228, stopPct: 16, atr: 0.003, volx: 3.36, px200: 9.2, spread: 0.16, qv24h: 7.4e6 };
  const risk = { capital: 300, riskPct: 1 };
  const a = CR.crossAlertText([x], [], T, '', CR.CROSS, null, { risk, btc: { up: false, since: T - 864e5 } });
  assert.match(a, /大盤：BTC 4H 死叉中/);
  assert.match(a, /下單卡｜停損 0\.04228/);
  assert.doesNotMatch(a, /不追/);
  assert.match(a, /2R 先平一半/);
  const far = CR.crossAlertText([{ ...x, close: 0.056 }], [], T, '', CR.CROSS, null, { risk });
  assert.match(far, /不追，掛 0\.0498\d* 等回踩/);
  const old = CR.crossAlertText([x], [], T);
  assert.doesNotMatch(old, /下單卡|大盤/);
  assert.match(old, /出場參考：4H 死叉/);
  /* 成績解析只認每個幣的第一行，新增的行不能被當成訊號 */
  const recs = SC.parseRun([{ run: '1', time: '2026-11-15T16:01:00+08:00', ok: true, text: a.replace(/\x01([^\x02]*)\x02[^\x03]*\x03/g, '$1') }]);
  assert.deepEqual(recs.map(r => [r.k, r.b]), [['cross', 'MEGA']]);
});

test('日 ATR：4H 每 6 根一組取最近 14 天；資料不足回傳 null', () => {
  const bars = Array.from({ length: 84 }, (_, i) => ({ h: 11, l: i % 6 === 0 ? 9 : 10 }));
  assert.equal(CR.dayAtr(bars, 83), 2);
  assert.equal(CR.dayAtr(bars, 50), null);
});

test('追蹤：照規則結果跟著 K 線更新，結算時「持有中」改成「到期」', () => {
  const bars = [];
  for (let i = 0; i < 300; i++) bars.push({ t: i * 4 * 3600e3, o: 1, h: 1.01, l: 0.99, c: 1 + i * 0.0001, qv: 1 });
  const it = { key: 'k', sym: 'XUSDT', base: 'X', t: bars[200].t, close: bars[200].c, stopPx: 0.95 };
  const tr = CR.trackItem(it, bars);
  assert.ok(tr.rule && tr.rule.open);
  const st = CR.emptyCross();
  st.active.push({ ...tr, bars: CR.CROSS.trackBars });
  const r = CR.applyScan(st, [], bars[299].t, bars[299].t);
  assert.equal(r.closed[0].rule.why, '到期');
  assert.equal(r.closed[0].rule.open, false);
});

test('大盤狀態：BTC 1H 合成 4H，看訊號前最後一根已收盤 4H 的 EMA20／SMA30', () => {
  const H = 3600e3, m = new Map();
  for (let i = 0; i < 4 * 120; i++) {
    const c = i < 4 * 80 ? 100 + i * 0.1 : 132 - (i - 320) * 0.5;   /* 先漲後急跌 */
    m.set(i * H, [i * H, c, c, c, c]);
  }
  const rg = SC.regimeFn(m);
  assert.equal(rg(70 * 4 * H + 1), 'bull');
  assert.equal(rg(119 * 4 * H + 1), 'bear');
  assert.equal(rg(10 * 4 * H), null);
});

test('成績：做空轉弱有停損價時，72 小時資料齊了算一次照規則 R', () => {
  const H = 3600e3, t = Date.UTC(2026, 10, 18, 0);
  const rec = SC.parseShadow({ t, k: 'gnew', b: 'X', tfs: ['1h'], peak: 1.1, src: ['okx', 'X-USDT-SWAP'] });
  assert.equal(rec.pk, 1.1);
  const bars = new Map();
  for (let i = -1; i < 80; i++) { const c = i < 10 ? 1 : 0.75; bars.set(t + i * H, [t + i * H, c, c * 1.001, c * 0.999, c]); }
  SC.fill(rec, bars, null, t + 80 * H);
  assert.ok(rec.m[72]);
  assert.equal(rec.rr[1], '持有中');
  assert.ok(rec.rr[0] > 2);
});
