import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as TR from '../src/tier.mjs';
import { groupByTopic } from '../src/telegram-topics.mjs';
import * as HR from '../src/hourly.mjs';
import * as E from '../src/early.mjs';
import * as Q from '../src/quiet.mjs';
import * as DM from '../src/dormant.mjs';
import * as RT from '../src/rate.mjs';
import * as G from '../src/gainer.mjs';
import * as C from '../src/cross.mjs';

const H = 3600e3;
/* 台灣時間 → UTC 毫秒 */
const tw = s => Date.parse(`${s}:00+08:00`);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tier-'));
const cfgOf = o => ({ ...TR.DEFAULTS, ...o });

test('分級：早期型與其他類型即時、金叉與做空候選進摘要，可用設定改回', () => {
  const c = cfgOf({});
  for (const k of ['quiet', 'hourly', 'pre', 'dormant', 'rate', 'daily', 'layout', 'events', 'alert']) assert.equal(TR.tierOf(k, c), 'A', k);
  for (const k of ['cross', 'crossd', 'gainer']) assert.equal(TR.tierOf(k, c), 'B', k);
  assert.equal(TR.tierOf('gainer', cfgOf({ tiers: { gainer: 'A' } })), 'A');
  assert.equal(TR.tierOf('gainer', cfgOf({ tiers: { gainer: 'X' } })), 'B');
});

test('設定：預設 legacy；環境變數可覆寫；亂填一律 legacy；壞檔退回 legacy', () => {
  const d = tmp(), f = path.join(d, 'tier.json');
  assert.equal(TR.loadConfig(f, {}).mode, 'legacy');
  fs.writeFileSync(f, JSON.stringify({ mode: 'tiered' }));
  assert.equal(TR.loadConfig(f, {}).mode, 'tiered');
  assert.equal(TR.loadConfig(f, { TIER_MODE: 'legacy' }).mode, 'legacy');
  fs.writeFileSync(f, JSON.stringify({ mode: 'whatever' }));
  assert.equal(TR.loadConfig(f, {}).mode, 'legacy');
  fs.writeFileSync(f, '{壞掉');
  assert.equal(TR.loadConfig(f, {}).mode, 'legacy');
});

test('標的名稱：1000PEPE 與 PEPE 視為同一檔', () => {
  assert.equal(TR.normBase('1000PEPE'), 'PEPE');
  assert.equal(TR.normBase('pepe'), 'PEPE');
  assert.equal(TR.normBase('BTCUSDT'), 'BTC');
  assert.equal(TR.normBase('1INCH'), '1INCH');
  assert.equal(TR.normBase('1M'), '1M');
});

test('plan：早期型單一命中即時；金叉不即時、存進待發；其餘原樣', () => {
  const st = TR.emptyState(), now = tw('2026-11-12 10:00');
  const msgs = [{ k: 'hourly', text: 'H' }, { k: 'dormant', text: 'D' }, { k: 'cross', text: 'C' }, { k: 'gainer', text: 'G' }, { k: 'alert', text: 'X' }];
  const { out, info } = TR.plan(msgs, [{ k: 'hourly', base: 'AAA' }, { k: 'cross', base: 'BBB' }], now, st, cfgOf({}));
  assert.deepEqual(out.map(m => m.k), ['hourly', 'dormant', 'alert']);
  assert.equal(st.pending.length, 2);
  assert.deepEqual(info.deferred.map(x => x.k), ['cross', 'gainer']);
  assert.equal(TR.missingImmediate(msgs, out, cfgOf({})).length, 0);
});

test('plan：沒有早期訊號被降級——即使同一輪出現很多訊號、沒有每日上限', () => {
  const st = TR.emptyState(), now = tw('2026-11-12 10:00');
  const msgs = [];
  for (let i = 0; i < 40; i++) msgs.push({ k: ['hourly', 'pre', 'dormant', 'rate', 'quiet'][i % 5], text: `m${i}` });
  const { out } = TR.plan(msgs, [], now, st, cfgOf({}));
  assert.equal(out.length, 40);
  assert.deepEqual(TR.missingImmediate(msgs, out, cfgOf({})), []);
  assert.deepEqual(TR.missingImmediate(msgs, out.slice(1), cfgOf({})).length, 1);
});

test('每日摘要：19:30 前不發；之後第一輪每個話題各一則，發完清空、當天不重發', () => {
  const st = TR.emptyState(), c = cfgOf({});
  TR.plan([{ k: 'cross', text: 'C1' }, { k: 'gainer', text: 'G1' }], [], tw('2026-11-12 08:00'), st, c);
  TR.plan([{ k: 'cross', text: 'C2' }], [], tw('2026-11-12 16:00'), st, c);
  const early = TR.plan([], [], tw('2026-11-12 19:00'), st, c);
  assert.equal(early.out.length, 0);
  const r = TR.plan([{ k: 'crossd', text: 'D1' }], [], tw('2026-11-12 20:00'), st, c);
  assert.deepEqual(r.out.map(m => m.k), ['cross', 'crossd', 'gainer']);
  const cross = r.out.find(m => m.k === 'cross');
  assert.match(cross.text, /每日摘要・4H 金叉/);
  assert.match(cross.text, /累計 2 則/);
  assert.ok(cross.text.includes('C1') && cross.text.includes('C2'));
  assert.equal(st.pending.length, 0);
  assert.equal(st.lastDigestDay, '2026-11-12');
  const again = TR.plan([], [], tw('2026-11-12 21:00'), st, c);
  assert.equal(again.out.length, 0);
  TR.plan([{ k: 'cross', text: 'C3' }], [], tw('2026-11-13 08:00'), st, c);
  const next = TR.plan([], [], tw('2026-11-13 20:00'), st, c);
  assert.equal(next.out.length, 1);
  assert.ok(next.out[0].text.includes('C3') && !next.out[0].text.includes('C1'));
});

test('共振：早期訊號＋金叉 48 小時內同一檔才升級；只升級不取代；做空候選不算；24 小時內不重複', () => {
  const st = TR.emptyState(), c = cfgOf({});
  const a = TR.plan([{ k: 'hourly', text: 'H' }], [{ k: 'hourly', base: '1000PEPE' }], tw('2026-11-12 10:00'), st, c);
  assert.deepEqual(a.out.map(m => m.k), ['hourly']);
  const g = TR.plan([{ k: 'gainer', text: 'G' }], [{ k: 'gainer', base: 'PEPE' }], tw('2026-11-12 11:00'), st, c);
  assert.deepEqual(g.out.map(m => m.k), []);
  const x = TR.plan([{ k: 'cross', text: 'C' }], [{ k: 'cross', base: 'PEPE' }], tw('2026-11-12 12:00'), st, c);
  assert.deepEqual(x.out.map(m => m.k), ['resonance']);
  assert.match(x.out[0].text, /【共振】/);
  assert.match(x.out[0].text, /PEPE/);
  assert.match(x.out[0].text, /盤中爆量/);
  assert.match(x.out[0].text, /4H 金叉/);
  const dup = TR.plan([{ k: 'crossd', text: 'D' }], [{ k: 'crossd', base: 'PEPE' }], tw('2026-11-12 14:00'), st, c);
  assert.deepEqual(dup.out.map(m => m.k), []);
  const none = TR.plan([{ k: 'cross', text: 'C' }], [{ k: 'cross', base: 'OTHER' }], tw('2026-11-12 15:00'), st, c);
  assert.deepEqual(none.out.map(m => m.k), []);
});

test('共振：早期訊號超過 48 小時就不算；金叉先到、早期訊號後到也算', () => {
  const st = TR.emptyState(), c = cfgOf({});
  TR.plan([], [{ k: 'dormant', base: 'AAA' }], tw('2026-11-10 08:00'), st, c);
  const old = TR.plan([{ k: 'cross', text: 'C' }], [{ k: 'cross', base: 'AAA' }], tw('2026-11-12 10:00'), st, c);
  assert.deepEqual(old.out.map(m => m.k), []);
  TR.plan([{ k: 'crossd', text: 'D' }], [{ k: 'crossd', base: 'BBB' }], tw('2026-11-12 08:00'), st, c);
  const late = TR.plan([{ k: 'rate', text: 'R' }], [{ k: 'rate', base: 'BBB' }], tw('2026-11-12 09:00'), st, c);
  assert.deepEqual(late.out.map(m => m.k), ['rate', 'resonance']);
});

test('applyTier：legacy 回傳原本的訊息陣列（同一個），只寫紀錄；摘要與共振在紀錄裡可查', () => {
  const dir = tmp(), logDir = tmp();
  const msgs = [{ k: 'hourly', text: 'H' }, { k: 'cross', text: 'C' }];
  const r = TR.applyTier(msgs, [{ k: 'hourly', base: 'AAA' }, { k: 'cross', base: 'AAA' }], tw('2026-11-12 10:00'), { cfg: cfgOf({ mode: 'legacy' }), dir, logDir });
  assert.equal(r, msgs);
  const log = fs.readFileSync(path.join(logDir, '2026-11-12.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(log.length, 1);
  assert.equal(log[0].mode, 'legacy');
  assert.equal(log[0].sent, 'legacy');
  assert.deepEqual(log[0].deferred.map(x => x.k), ['cross']);
  assert.equal(log[0].resonance[0].base, 'AAA');
  assert.ok(fs.existsSync(path.join(dir, 'state.json')));
  const r2 = TR.applyTier(msgs, [], tw('2026-11-12 20:00'), { cfg: cfgOf({ mode: 'legacy' }), dir, logDir });
  assert.equal(r2, msgs);
  const log2 = fs.readFileSync(path.join(logDir, '2026-11-12.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(log2[1].digest.some(d => d.k === 'cross'));
});

test('applyTier：tiered 回傳分級結果，狀態跨輪保留', () => {
  const dir = tmp(), logDir = tmp(), c = cfgOf({ mode: 'tiered' });
  const a = TR.applyTier([{ k: 'hourly', text: 'H' }, { k: 'cross', text: 'C' }], [], tw('2026-11-12 10:00'), { cfg: c, dir, logDir });
  assert.deepEqual(a.map(m => m.k), ['hourly']);
  const b = TR.applyTier([], [], tw('2026-11-12 20:00'), { cfg: c, dir, logDir });
  assert.deepEqual(b.map(m => m.k), ['cross']);
  assert.match(b[0].text, /每日摘要/);
});

test('applyTier：出錯或狀態檔損壞都退回原本的推播', () => {
  const logDir = tmp(), dir = tmp(), msgs = [{ k: 'hourly', text: 'H' }, { k: 'cross', text: 'C' }];
  fs.writeFileSync(path.join(dir, 'state.json'), '{壞掉');
  const a = TR.applyTier(msgs, [], tw('2026-11-12 10:00'), { cfg: cfgOf({ mode: 'tiered' }), dir, logDir });
  assert.deepEqual(a.map(m => m.k), ['hourly']);   /* 狀態損壞只是重新開始，分級照常 */
  const blocker = path.join(tmp(), 'file');
  fs.writeFileSync(blocker, 'x');
  const b = TR.applyTier(msgs, [], tw('2026-11-12 10:00'), { cfg: cfgOf({ mode: 'tiered' }), dir: path.join(blocker, 'sub'), logDir });
  assert.equal(b, msgs);                            /* 目錄建不起來：退回 */
});

test('接在 groupByTopic 前：話題分流照舊，共振有自己的話題', () => {
  const st = TR.emptyState();
  const { out } = TR.plan([{ k: 'hourly', text: 'H' }, { k: 'cross', text: 'C' }], [{ k: 'hourly', base: 'AAA' }, { k: 'cross', base: 'AAA' }], tw('2026-11-12 10:00'), st, cfgOf({}));
  assert.deepEqual(groupByTopic(out).map(g => g.k), ['hourly', 'resonance']);
});

/* ---------------- 今日第 N 次 ---------------- */
const stOf = signals => ({ ...TR.emptyState(), signals });
const withState = signals => { const d = tmp(); TR.saveState(d, stOf(signals)); return d; };

test('今日第 N 次：同幣同類、台灣時間當天、前幾輪各算一次，含這一次', () => {
  const now = tw('2026-11-12 14:00');
  const dir = withState([
    { k: 'hourly', base: 'PEPE', t: tw('2026-11-12 09:00') },
    { k: 'hourly', base: 'PEPE', t: tw('2026-11-12 11:00') },
    { k: 'hourly', base: 'PEPE', t: tw('2026-11-12 11:00') },     /* 同一輪重複只算一次 */
    { k: 'hourly', base: 'PEPE', t: now },                         /* 這一輪自己不算 */
    { k: 'hourly', base: 'PEPE', t: tw('2026-11-11 23:00') },     /* 昨天不算 */
    { k: 'pre', base: 'PEPE', t: tw('2026-11-12 10:00') },        /* 別類不算 */
    { k: 'hourly', base: 'AAA', t: tw('2026-11-12 10:00') }
  ]);
  const nth = TR.nthCounter(now, { cfg: cfgOf({}), dir });
  assert.equal(nth('hourly')('1000PEPE'), 3);
  assert.equal(nth('hourly')('PEPE'), 3);
  assert.equal(nth('pre')('PEPE'), 2);
  assert.equal(nth('hourly')('AAA'), 2);
  assert.equal(nth('hourly')('NEW'), 1);
  assert.equal(nth('cross')('PEPE'), 1);
});

test('今日第 N 次：台灣時間 0 點重算；關閉或狀態讀不到就不標', () => {
  const dir = withState([{ k: 'hourly', base: 'AAA', t: tw('2026-11-12 23:00') }]);
  assert.equal(TR.nthCounter(tw('2026-11-13 00:00'), { cfg: cfgOf({}), dir })('hourly')('AAA'), 1);
  assert.equal(TR.nthCounter(tw('2026-11-12 23:30'), { cfg: cfgOf({ showNth: false }), dir }), null);
  const empty = TR.nthCounter(tw('2026-11-12 14:00'), { cfg: cfgOf({}), dir: tmp() });
  assert.equal(empty('hourly')('AAA'), 1);                         /* 沒有狀態檔＝第 1 次 */
  const bad = tmp(); fs.writeFileSync(path.join(bad, 'state.json'), '{壞掉');
  assert.equal(TR.nthCounter(tw('2026-11-12 14:00'), { cfg: cfgOf({}), dir: bad })('hourly')('AAA'), 1);
});

test('設定：showNth 預設開，可關', () => {
  assert.equal(TR.loadConfig(path.join(tmp(), 'none.json'), {}).showNth, true);
  const f = path.join(tmp(), 't.json'); fs.writeFileSync(f, JSON.stringify({ showNth: false }));
  assert.equal(TR.loadConfig(f, {}).showNth, false);
});

test('文字：每個幣的第一行後面加「｜今日第 N 次」，不傳就跟原本一模一樣', () => {
  const T = Date.UTC(2026, 10, 12, 3, 0), n3 = () => 3;
  const hour = HR.pickAlerts(HR.emptyHourly(), [{ venue: 'okx', sym: 'X-USDT-SWAP', base: 'X', cat: 'crypto', stats: { x1: 8, x2: 5, qv: 4e6, chg: 0, price: 1 } }], T);
  const pre = E.pickPre(E.emptyPre(), [{ venue: 'okx', sym: 'A-USDT-SWAP', base: 'A', cat: 'crypto', stats: { x1: 2.5, x2: 2, xp: 2.1, cx: null, qv: 5e5, chg: 0, price: 0.3712 } }], T);
  const quiet = [{ key: 's:B:1', src: 'short', base: 'B', cat: 'stock', venue: 'okx', id: 'B-USDT-SWAP', t: T, price: 20, chg: -0.8, lim: 1.5, ref: 3, x: 4.2, r: {} }];
  const wake = [{ base: 'IRYS', kind: 'A', okx: { sym: 'IRYS-USDT-SWAP', qv: 2e6, xA: 12, chg: 3, pos: -1, range: 20 }, bitget: { qv: 1e6, xA: 9 }, price: 0.5 }];
  const rate = [{ ccy: 'ABC', v: 1.2, base: 0.2, x: 6, pre: 0.25, est: 1.2, last: 0.0123, chg: -0.05, by: 'est' }];
  const gain = [{ base: 'AAA', tfs: ['1h'], chg: 50, ex: {}, qv: 1e6, c: 1, brk: 0.9, drop: 5, hi24: 1.2, stop: 3, tags: [] }];
  const cross = [{ base: 'TEST', sym: 'TESTUSDT', close: 1, volx: 2, px200: 3, spread: 0.5, stopPx: 0.9, stopPct: 10, qv24h: 1e6 }];
  const cases = [
    ['hourly', n => HR.hourlyAlertText(hour, T, [], '', undefined, n)],
    ['pre', n => E.preAlertText(pre, T, '', undefined, n)],
    ['quiet', n => Q.quietAlertText(quiet, T, '', undefined, n)],
    ['dormant', n => DM.wakeAlertText(wake, T, '', undefined, n)],
    ['rate', n => RT.rateAlertText(rate, T, '', undefined, null, 7, n)],
    ['gainer', n => G.gainerAlertText(gain, T, '', undefined, n)],
    ['cross', n => C.crossAlertText(cross, [], T, '', undefined, n)],
    ['crossd', n => C.crossAlertText(cross, [], T, '', C.CROSS_D, n)]
  ];
  for (const [name, f] of cases) {
    const base = f(null), withN = f(n3);
    assert.equal(f(undefined), base, `${name} 不傳時要和原本相同`);
    assert.equal(base.includes('今日第'), false, name);
    assert.equal(withN.split('今日第 3 次').length - 1, 1, `${name} 一個幣標一次`);
    assert.equal(withN.replace('｜今日第 3 次', ''), base, `${name} 除了這一段其餘完全相同`);
  }
});

test('文字：多檔各標各的次數', () => {
  const T = Date.UTC(2026, 10, 12, 3, 0);
  const gain = ['AAA', 'BBB'].map(b => ({ base: b, tfs: ['1h'], chg: 50, ex: {}, qv: 1e6, c: 1, brk: 0.9, drop: 5, hi24: 1.2, stop: 3, tags: [] }));
  const t = G.gainerAlertText(gain, T, '', undefined, b => (b === 'AAA' ? 1 : 4));
  assert.match(t, /AAA.*｜今日第 1 次/);
  assert.match(t, /BBB.*｜今日第 4 次/);
});
