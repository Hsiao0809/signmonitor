import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../src/gainer.mjs';
import * as GS from '../src/gainer-scan.mjs';

const H = 3600e3;
const T = Date.UTC(2026, 10, 12, 4);   /* 4 的倍數：4H K 剛收盤 */
const row = (base, chg, qv = 2e6, last = 1, id = null, cat = 'crypto') => ({ base, id: id || `${base}USDT`, chg, qv, last, cat });

test('名稱：1000 倍合約與現貨對在一起', () => {
  assert.equal(G.normBase('1000PEPE'), 'PEPE');
  assert.equal(G.normBase('pepe'), 'PEPE');
  assert.equal(G.normBase('1INCH'), '1INCH');
  assert.equal(G.normBase('10000SATS'), 'SATS');
});

test('名單：任一家前 20、≥30%、成交額夠才列入；其他家有掛牌的一併顯示', () => {
  const boards = {
    okx: [row('AAA', 85, 5e6, 2, 'AAA-USDT-SWAP'), row('BBB', 25, 5e6), row('CCC', 40, 1e5), row('BTC', 1, 9e9)],
    bitget: [row('AAA', 80, 3e6), row('DDD', 33, 9e5)],
    binance: [row('EEE', 120, 8e6)]
  };
  const items = G.mergeBoards(boards);
  assert.deepEqual(items.map(i => i.key), ['EEE', 'AAA', 'DDD']);        /* BBB 漲幅不夠、CCC 量不夠 */
  const a = items.find(i => i.key === 'AAA');
  assert.equal(a.chgMax, 85);
  assert.equal(a.sv, 'okx');                                              /* 成交額較大的合約 */
  assert.equal(a.kex, 'okx'); assert.equal(a.kid, 'AAA-USDT-SWAP');
  assert.equal(a.base, 'AAA');
  assert.deepEqual(Object.keys(a.ex).sort(), ['bitget', 'okx']);
  assert.ok(a.ex.okx.hot && a.ex.bitget.hot);
  const e = items.find(i => i.key === 'EEE');
  assert.equal(e.sv, null); assert.equal(e.kex, null);                    /* 只有現貨 */
});

test('名單：每家只算榜上前 N 檔；排除清單不列', () => {
  const rows = Array.from({ length: 30 }, (_, i) => row(`C${i}`, 100 - i));
  const items = G.mergeBoards({ okx: rows }, { ...G.GAINER, topN: 5 });
  assert.equal(items.length, 5);
  const ex = G.mergeBoards({ okx: [row('USDX', 90), row('REAL', 50)] }, G.GAINER, b => b === 'USDX');
  assert.deepEqual(ex.map(i => i.key), ['REAL']);
});

test('名單：Bybit 單獨有合約時沒有 K 線來源；Bybit 與 OKX 同時有時 K 線用 OKX', () => {
  const only = G.mergeBoards({ bybit: [row('ZZZ', 60, 4e6)] })[0];
  assert.equal(only.sv, 'bybit'); assert.equal(only.kex, null);
  const both = G.mergeBoards({ bybit: [row('ZZZ', 60, 9e6)], okx: [row('ZZZ', 58, 1e6, 1, 'ZZZ-USDT-SWAP')] })[0];
  assert.equal(both.sv, 'bybit'); assert.equal(both.kex, 'okx');
});

/* 1H 的 K：多根上漲、最高點在中間，最後一根跌破前一根低點 */
const mk1h = (arr, end = T) => arr.map(([o, h, l, c], i) => ({ t: end - (arr.length - i) * H, o, h, l, c }));
const RUN = [[1, 1.1, 0.98, 1.08], [1.08, 1.2, 1.05, 1.18], [1.18, 1.4, 1.15, 1.35], [1.35, 1.6, 1.3, 1.5], [1.5, 1.55, 1.42, 1.45], [1.45, 1.5, 1.4, 1.46], [1.46, 1.5, 1.41, 1.47], [1.47, 1.52, 1.43, 1.48]];

test('轉弱：收盤跌破前一根低點、且最高點沒有再創高', () => {
  assert.equal(G.weakOf(mk1h(RUN), '1h', T), null);                      /* 最後一根沒跌破 */
  const weak = [...RUN, [1.48, 1.49, 1.3, 1.32]];
  const w = G.weakOf(mk1h(weak), '1h', T);
  assert.equal(w.tf, '1h'); assert.equal(w.brk, 1.43); assert.equal(w.peak, 1.6);
  assert.equal(w.c, 1.32); assert.equal(w.drop, 17.5);
  /* 破低但同時創新高（外包 K）不算 */
  const outside = [...RUN, [1.48, 1.7, 1.3, 1.32]];
  assert.equal(G.weakOf(mk1h(outside), '1h', T), null);
});

test('轉弱：未收盤的 K 不算、資料太少不判斷', () => {
  const bars = mk1h([...RUN, [1.48, 1.49, 1.3, 1.32]], T + H);           /* 最後一根還沒收盤 */
  assert.equal(G.weakOf(bars, '1h', T), null);
  assert.equal(G.weakOf(mk1h(RUN.slice(0, 5)), '1h', T), null);
  assert.equal(G.weakOf(null, '1h', T), null);
});

test('轉弱：4H 用 4 小時的收盤時間', () => {
  const bars = RUN.slice(0, 6).concat([[1.45, 1.46, 1.3, 1.31]]).map(([o, h, l, c], i, a) => ({ t: T - (a.length - i) * 4 * H, o, h, l, c }));
  assert.equal(G.weakOf(bars, '4h', T).tf, '4h');
  assert.equal(G.weakOf(bars, '4h', T - 1), null);                       /* 最後一根還差 1 毫秒才收盤 */
});

test('補資料：24h 高點與停損距離', () => {
  const it = { key: 'A', px: 1.32, ex: { okx: { chg: 80 } } };
  G.enrich(it, mk1h([...RUN, [1.48, 1.49, 1.3, 1.32]]), [], T);
  assert.equal(it.hi24, 1.6); assert.equal(it.stopPct, 21.2);
  assert.ok(it.weak['1h']);
  const none = G.enrich({ key: 'B', px: 1, ex: {} }, [], [], T);
  assert.equal(none.hi24, null); assert.equal(none.stopPct, null); assert.deepEqual(none.weak, {});
});

test('標籤：勿空、單家、停損過寬、無合約、無 K 線', () => {
  const ctx = G.contextOf({
    hstate: { recent: [{ t: T - 5 * H, base: '1000PEPE' }, { t: T - 30 * H, base: 'OLD' }] },
    pstate: { early: [{ t: T - 2 * H, base: 'ERLY' }], pre: [] },
    dstate: { events: [{ t: T - 3 * 24 * H, base: 'WAKE' }, { t: T - 9 * 24 * H, base: 'WOLD' }] },
    lstate: { active: [{ base: 'LAY' }] }
  }, T);
  for (const k of ['PEPE', 'ERLY']) assert.ok(ctx.spike.has(k));
  assert.ok(!ctx.spike.has('OLD')); assert.ok(ctx.wake.has('WAKE')); assert.ok(!ctx.wake.has('WOLD')); assert.ok(ctx.layout.has('LAY'));
  const base = { ex: { okx: { chg: 90 }, bitget: { chg: 88 } }, chgMax: 90, sv: 'okx', kex: 'okx', stopPct: 5 };
  assert.deepEqual(G.tagsOf({ ...base, key: 'PEPE' }, ctx), ['spike']);
  assert.deepEqual(G.tagsOf({ ...base, key: 'WAKE' }, ctx), ['wake']);
  assert.deepEqual(G.tagsOf({ ...base, key: 'LAY' }, ctx), ['layout']);
  assert.deepEqual(G.tagsOf({ ...base, key: 'X', ex: { okx: { chg: 90 }, bitget: { chg: 10 } } }, ctx), ['solo']);
  assert.deepEqual(G.tagsOf({ ...base, key: 'X', stopPct: 14.9 }, ctx), ['wide']);
  assert.deepEqual(G.tagsOf({ ...base, key: 'X', stopPct: 10 }, ctx), []);          /* 剛好 10% 不算過寬 */
  assert.deepEqual(G.tagsOf({ ...base, key: 'X', sv: null, kex: null }, ctx), ['noperp']);
  assert.deepEqual(G.tagsOf({ ...base, key: 'X', sv: 'bybit', kex: null }, ctx), ['nok']);
  assert.ok(G.isAvoid(['solo', 'wake'])); assert.ok(!G.isAvoid(['solo', 'wide']));
});

function weakItem(key, tfs, bar = T - H) {
  const weak = {};
  tfs.forEach(tf => { weak[tf] = { tf, t: bar, c: 1.3, brk: 1.4, peak: 1.6, drop: 18.8 }; });
  return { key, base: key, ex: { okx: { chg: 80, qv: 3e6, last: 1.3, id: `${key}-USDT-SWAP`, rank: 1 } }, chgMax: 80, sv: 'okx', sid: `${key}-USDT-SWAP`, kex: 'okx', kid: `${key}-USDT-SWAP`, px: 1.3, qv: 3e6, hi24: 1.6, stopPct: 23.1, weak, tags: [] };
}

test('通知：同一檔 1H、4H 同時轉弱合成一筆；同一根 K 不重複；冷卻期內不重複', () => {
  const st = G.emptyGainer();
  const e1 = G.applyScan(st, [weakItem('AAA', ['1h', '4h'])], T);
  assert.equal(e1.length, 1); assert.deepEqual(e1[0].tfs, ['4h', '1h']);
  assert.equal(st.items.length, 1); assert.equal(st.lastHour, T);
  /* 下一小時：同一根 4H（沒換）、1H 換了新的一根但還在 12 小時冷卻內 → 不通知 */
  const e2 = G.applyScan(st, [weakItem('AAA', ['1h', '4h'], T)], T + H);
  assert.equal(e2.length, 0);
  assert.equal(st.events.length, 1);
  /* 13 小時後 1H 又轉弱（新的一根），4H 仍在 24 小時冷卻 → 只通知 1H */
  const e3 = G.applyScan(st, [weakItem('AAA', ['1h', '4h'], T + 12 * H)], T + 13 * H);
  assert.equal(e3.length, 1); assert.deepEqual(e3[0].tfs, ['1h']);
  /* 25 小時後兩個都過冷卻 */
  const e4 = G.applyScan(st, [weakItem('AAA', ['1h', '4h'], T + 24 * H)], T + 25 * H);
  assert.deepEqual(e4[0].tfs, ['4h', '1h']);
});

test('通知：標籤帶「勿空」照樣通知（只標記）；沒轉弱的不通知；按漲幅排序', () => {
  const st = G.emptyGainer();
  const a = weakItem('AAA', ['1h']); a.tags = ['spike']; a.chgMax = 50;
  const b = weakItem('BBB', ['4h']); b.chgMax = 150;
  const c = weakItem('CCC', []);
  const ev = G.applyScan(st, [a, b, c], T);
  assert.deepEqual(ev.map(e => e.base), ['BBB', 'AAA']);
  assert.ok(G.isAvoid(ev[1].tags));
});

test('上榜時間：連續在榜保留、離開超過 6 小時再上榜重算、48 小時沒出現清掉', () => {
  const st = G.emptyGainer();
  G.applyScan(st, [weakItem('AAA', [])], T);
  G.applyScan(st, [weakItem('AAA', [])], T + 3 * H);
  assert.equal(st.items[0].since, T);
  G.applyScan(st, [weakItem('AAA', [])], T + 12 * H);                 /* 中間 9 小時沒上榜 */
  assert.equal(st.items[0].since, T + 12 * H);
  G.applyScan(st, [], T + 70 * H);
  assert.deepEqual(st.seen, {});
});

test('通知：紀錄與冷卻記錄只留 7 天', () => {
  const st = G.emptyGainer();
  G.applyScan(st, [weakItem('AAA', ['1h'])], T);
  G.applyScan(st, [], T + 8 * 24 * H);
  assert.equal(st.events.length, 0); assert.deepEqual(st.notified, {});
});

test('文字：通知訊息含標籤、勿空標示、停損；沒有事件回空字串', () => {
  assert.equal(G.gainerAlertText([], T), '');
  const st = G.emptyGainer();
  const it = weakItem('AAA', ['4h', '1h']); it.tags = ['wake', 'wide'];
  const ev = G.applyScan(st, [it], T);
  const t = G.gainerAlertText(ev, T, 'https://example.com/issues/1');
  assert.match(t, /【做空候選・轉弱】11-12 12:00/);
  assert.match(t, /4H＋1H 轉弱/);
  assert.match(t, /24h \+80\.0%/);
  assert.match(t, /⚠ .*勿空.*停損過寬/);
  assert.match(t, /停損（24h 高）1\.600（距現價 23\.1%）/);
  assert.match(t, /example\.com\/issues\/1/);
});

test('文字：超過 12 檔只列前 12', () => {
  const st = G.emptyGainer();
  const ev = G.applyScan(st, Array.from({ length: 15 }, (_, i) => weakItem(`K${i}`, ['1h'])), T);
  const t = G.gainerAlertText(ev, T);
  assert.equal((t.match(/ 轉弱｜/g) || []).length, 12);
  assert.match(t, /另有 3 檔/);
});

test('Issue 內嵌狀態：來回一致、壞掉回 null、空的回新狀態、本文不超過上限', () => {
  const st = G.emptyGainer();
  G.applyScan(st, Array.from({ length: 60 }, (_, i) => weakItem(`K${i}`, ['1h', '4h'])), T);
  const body = G.gainerBody(st, { nowMs: T, note: 'x' }, t => t);
  assert.ok(body.length <= 60000);
  const back = G.extractGainer(body);
  assert.equal(back.items.length, 60); assert.equal(back.lastHour, T); assert.equal(back.events.length, 60);
  assert.equal(G.extractGainer('').items.length, 0);
  assert.equal(G.extractGainer('<!-- GAINER_STATE\nnot-base64\nGAINER_STATE -->'), null);
});

test('Bybit tickers：只收完整 snapshot', () => {
  const snap = { topic: 'tickers.AAAUSDT', type: 'snapshot', data: { symbol: 'AAAUSDT', lastPrice: '1.25', price24hPcnt: '0.4321', turnover24h: '8000000' } };
  assert.deepEqual(GS.parseBybitTicker(snap), { sym: 'AAAUSDT', last: 1.25, chg: 43.21, qv: 8e6 });
  assert.equal(GS.parseBybitTicker({ ...snap, type: 'delta' }), null);
  assert.equal(GS.parseBybitTicker({ ...snap, data: { symbol: 'AAAUSDT', lastPrice: '1.25' } }), null);
  assert.equal(GS.parseBybitTicker({ topic: 'kline.60.X', type: 'snapshot', data: {} }), null);
  assert.equal(GS.parseBybitTicker(null), null);
});

test('整合：榜單合併、K 線判斷、標籤（用假資料，不連網）', async () => {
  const boards = {
    okx: [row('AAA', 90, 6e6, 1.32, 'AAA-USDT-SWAP'), row('USDC', 50, 9e6)],
    bitget: [row('AAA', 88, 4e6, 1.32), row('BBB', 45, 2e6, 2, 'BBBUSDT')],
    bybit: [row('CCC', 70, 5e6)],
    binance: [row('DDD', 200, 1e7)]
  };
  const calls = [];
  const bars = async (ex, id, tf) => {
    calls.push(`${ex}:${id}:${tf}`);
    if (id === 'AAA-USDT-SWAP' && tf === '1h') return mk1h([...RUN, [1.48, 1.49, 1.3, 1.32]]);
    if (id === 'BBBUSDT' && tf === '1h') return null;
    return [];
  };
  const w = [];
  const r = await GS.collect(T, w, { boards, bars });
  assert.deepEqual(r.items.map(i => i.key), ['DDD', 'AAA', 'CCC', 'BBB']);          /* USDC 是穩定幣 */
  const aaa = r.items.find(i => i.key === 'AAA');
  assert.ok(aaa.weak['1h']); assert.equal(aaa.hi24, 1.6);
  assert.equal(r.items.find(i => i.key === 'CCC').kex, null);
  assert.ok(!calls.some(c => c.includes('CCC') || c.includes('DDD')));              /* 沒有 OKX／Bitget 合約的不抓 K 線 */
  assert.deepEqual(r.counts, { okx: 2, bitget: 2, bybit: 1, binance: 1, qual: 4 });
  assert.deepEqual(w, []);
});

test('整合：OKX、Bitget 都失敗就丟錯；只有一家失敗只加警告', async () => {
  const w = [];
  await assert.rejects(() => GS.collect(T, w, { boards: { okx: [], bitget: null, bybit: [row('A', 50)], binance: [row('B', 50)] } }), /合約行情都取得失敗/);
  const w2 = [];
  const r = await GS.collect(T, w2, { boards: { okx: [row('A', 50, 2e6, 1, 'A-USDT-SWAP')], bitget: [], bybit: [], binance: [] }, bars: async () => [] });
  assert.equal(r.items.length, 1);
  assert.equal(w2.length, 3);
  assert.match(w2[0], /漲幅榜取得失敗/);
});

test('整合：K 線大多失敗要警告', async () => {
  const w = [];
  const boards = { okx: ['A', 'B', 'C', 'D'].map(b => row(b, 60, 2e6, 1, `${b}-USDT-SWAP`)) };
  await GS.collect(T, w, { boards: { ...boards, bitget: [row('Z', 1)] }, bars: async () => null });
  assert.ok(w.some(x => /K 線取得失敗 4\/4/.test(x)));
});

test('文字：每檔一個段落，12 檔也能依空行切成不超過上限的幾則（連結標記不被切斷）', async () => {
  const st = G.emptyGainer();
  const items = Array.from({ length: 12 }, (_, i) => { const it = weakItem(`LONGNAME${i}`, ['4h', '1h']); it.tags = ['spike', 'wake', 'layout', 'solo', 'wide']; return it; });
  const t = G.gainerAlertText(G.applyScan(st, items, T), T, 'https://example.com/issues/1');
  const blocks = t.split('\n\n');
  assert.equal(blocks.length, 14);                       /* 標題＋12 檔＋結尾 */
  assert.ok(blocks.every(b => b.length < 3500));
  assert.ok(blocks.slice(1, 13).every(b => (b.match(/\u0001/g) || []).length === 1 && (b.match(/\u0003/g) || []).length === 1));
  assert.match(blocks[13], /example\.com/);
});
