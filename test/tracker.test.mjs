import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.mjs';
import * as T from '../src/tracker.mjs';

T.setPatternScan(core.patternScan);
const H = 3600e3, D = 24 * H, H4 = 4 * H;
const DAY0 = Date.UTC(2026, 9, 30);                 /* 爆量日 2026-10-30 UTC */

function cand(over = {}) {
  return {
    key: 'okx:APP-USDT-SWAP', ex: 'okx', id: 'APP-USDT-SWAP', base: 'APP', cat: 'stock',
    dayT: DAY0, hi: 254, lo: 225.6, open: 250, close: 229.5, vx: 2.4, pattern: 'base', chgDay: -8,
    addedAt: DAY0 + D, lastBarT: DAY0 + D - H4, status: 'pending', ...over
  };
}
/* 由收盤價序列產生 4H K，從爆量日隔天 00:00 UTC 開始 */
function bars(closes, start = DAY0 + D, wick = 1) {
  return closes.map((c, i) => ({ t: start + i * H4, o: c, h: c + wick, l: c - wick, c, qv: 1 }));
}
const endOf = bs => bs[bs.length - 1].t + H4;

test('收盤站上爆量日高點觸發做多，停損放在爆量日低點', () => {
  const bs = bars([240, 250, 258]);
  const { item, events } = T.advance(cand(), bs, endOf(bs));
  assert.equal(item.status, 'open');
  assert.equal(item.side, 'long');
  assert.equal(item.entry, 258);
  assert.equal(item.stop, 225.6);
  assert.ok(Math.abs(item.t2 - (258 + 3 * (258 - 225.6))) < 1e-9);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'trigger');
});

test('收盤跌破爆量日低點觸發做空', () => {
  const bs = bars([230, 224]);
  const { item } = T.advance(cand(), bs, endOf(bs));
  assert.equal(item.side, 'short');
  assert.equal(item.stop, 254);
});

test('只用已收盤的 4H K，進行中的 K 不觸發', () => {
  const bs = bars([240, 260]);
  const now = bs[1].t + 2 * H;                     /* 第二根還沒收 */
  const { item } = T.advance(cand(), bs, now);
  assert.equal(item.status, 'pending');
});

test('觸發後碰 T2 結算 +3R', () => {
  const entry = 258, risk = entry - 225.6;
  const bs = bars([258, 270, entry + 3 * risk + 5]);
  const { item, events } = T.advance(cand(), bs, endOf(bs));
  assert.equal(item.status, 'closed');
  assert.equal(item.outcome, 't2');
  assert.equal(item.r, 3);
  assert.equal(events[0].type, 'trigger');
  assert.equal(events.at(-1).type, 'close');
});

test('同一根 K 同時碰停損與目標時算停損', () => {
  const trig = bars([258]);
  const big = { t: trig[0].t + H4, o: 258, h: 400, l: 200, c: 300, qv: 1 };
  const bs = [...trig, big];
  const { item } = T.advance(cand(), bs, endOf(bs));
  assert.equal(item.outcome, 'stop');
  assert.equal(item.r, -1);
});

test('爆量日後 10 天沒觸發就到期', () => {
  const bs = bars(Array(60).fill(240));
  const { item } = T.advance(cand(), bs, DAY0 + D + 10 * D + H);
  assert.equal(item.status, 'expired');
});

test('持倉滿 15 天以收盤結算', () => {
  const closes = [258, ...Array(15 * 6 + 2).fill(262)];
  const bs = bars(closes);
  const { item } = T.advance(cand(), bs, endOf(bs));
  assert.equal(item.outcome, 'timeout');
  assert.ok(item.r > 0 && item.r < 1);
});

test('停損太寬或已遠離觸發價會標示警告', () => {
  const bs = bars([300]);
  const { item } = T.advance(cand(), bs, endOf(bs));
  assert.equal(item.flags.length, 2);
});

test('同一標的持倉中不重複加入；等待中換成較新的爆量日', () => {
  const s = T.emptyState();
  s.pending = [cand()];
  const newer = cand({ dayT: DAY0 + D, hi: 260 });
  const added = T.mergeCandidates(s, [newer]);
  assert.equal(added.length, 1);
  assert.equal(s.pending[0].hi, 260);
  s.open = [{ ...cand(), status: 'open' }];
  s.pending = [];
  assert.equal(T.mergeCandidates(s, [cand({ dayT: DAY0 + 2 * D })]).length, 0);
});

test('狀態寫進 Issue 本文後可以完整讀回', () => {
  const s = T.emptyState();
  s.pending = [cand()];
  s.lastDaily = '2026-11-06';
  const body = T.embedState('# 觀察清單', s);
  const back = T.extractState(body);
  assert.equal(back.lastDaily, '2026-11-06');
  assert.equal(back.pending[0].hi, 254);
  assert.deepEqual(T.extractState('沒有狀態的本文'), T.emptyState());
  assert.equal(T.extractState('<!-- WATCHLIST_STATE\n壞掉的資料\nWATCHLIST_STATE -->'), null);
});

test('槓桿與反向商品不進清單', () => {
  assert.ok(T.isExcluded('SOXS'));
  assert.ok(T.isExcluded('CSOPSKHYNIX2L'));
  assert.ok(!T.isExcluded('APP'));
  assert.ok(!T.isExcluded('BTC'));
});

test('候選只看已收盤日線：昨日爆量才進清單', () => {
  const days = [];
  for (let i = 0; i < 100; i++) days.push({ t: DAY0 - (98 - i) * D, o: 100, h: 101, l: 99, c: 100, qv: 1e6 });
  days[98].qv = 5e6;                               /* 最後一根已收盤日線爆量 5x */
  const meta = { id: 'X-USDT-SWAP', base: 'X', cat: 'stock', qv24h: 5e6 };
  const c = T.candidateFrom(meta, days, 'okx', days[99].t + H);
  assert.ok(c);
  assert.equal(c.dayT, days[98].t);
  assert.equal(c.hi, 101);
  days[98].qv = 1.5e6;
  assert.equal(T.candidateFrom(meta, days, 'okx', days[99].t + H), null);
});

test('Telegram 訊息包含進場、停損與目標', () => {
  const bs = bars([258]);
  const { events } = T.advance(cand(), bs, endOf(bs));
  const txt = T.eventText(events[0]);
  assert.match(txt, /觸發 做多/);
  assert.match(txt, /停損：225\.60/);
  assert.match(txt, /T2/);
});
