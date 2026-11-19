import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import * as SC from '../src/score.mjs';

const H = 3600e3;
const tw = s => Date.parse(`${s}:00+08:00`);
const part = (time, text, p = 'telegram-1.txt') => ({ time, run: 'r1', part: p, ok: true, text });

test('解析：盤中爆量（含標籤、多家、連續放量）、量增價平區塊不重複、跨日 00:00', () => {
  const text = [
    '【量增價平】11-10 00:00 台灣時間（1 檔）',
    '爆量但價格還沒大動：可能吸籌也可能出貨，方向未定',
    'IBIT［股票］盤中爆量 10.9x｜1H +0.4%（門檻 ±0.5%）｜價 42.69',
    '',
    '【盤中爆量】11-09 23:00–00:00 台灣時間（3 檔）',
    '【自選】BMNR［股票］Bitget＋OKX＋Bybit 同時 ★3.4x 同時段／3.6x 近48h',
    '  價格 19.42（1H +3.3%）｜成交額 Bitget 463K＋OKX 914K＋Bybit 273K',
    '  第 15 分已推算通知｜3 小時前已預警',
    '【量增價平】【連續放量】IBIT［股票］只有 Bybit ★10.9x 同時段／10x 近48h｜連續放量 5.1x',
    '  價格 42.69（1H +0.4%）｜成交額 436K',
    '【連續放量】HIMS［股票］OKX 連續 4 根放大，3 根累積 2.9x 近48h（同時段 3.6x）',
    '  價格 24.44（1H -2.0%）｜成交額 284K',
    'https://github.com/Hsiao0809/signmonitor/issues/10'
  ].join('\n');
  const s = SC.parseRun([part('2026-11-10T00:01:39+08:00', text)]);
  assert.equal(s.length, 3);
  const [a, b, c] = s;
  assert.equal(a.k, 'hourly'); assert.equal(a.b, 'BMNR'); assert.equal(a.t, tw('2026-11-10T00:00'));
  assert.deepEqual(a.v, ['bitget', 'okx', 'bybit']); assert.equal(a.x, 3.4); assert.equal(a.ch, 3.3); assert.equal(a.w, 1); assert.deepEqual(a.tg, ['自選']);
  assert.equal(b.o, true); assert.deepEqual(b.v, ['bybit']); assert.equal(b.rp, 5.1); assert.deepEqual(b.tg, ['量增價平', '連續放量']);
  assert.equal(c.x, undefined); assert.equal(c.rp, 2.9); assert.equal(c.xs, 3.6); assert.deepEqual(c.v, ['okx']); assert.equal(c.ch, -2);
  assert.equal(a.id, `hourly|BMNR|${tw('2026-11-10T00:00')}|bitget`);
});

test('解析：分段訊息接起來、預警、盤中推算、沉睡甦醒、借幣利率、金叉、做空候選', () => {
  const p1 = '【預警】11-09 18:00–19:00 台灣時間（2 檔，比前一根 ≥2x 或同時段 ≥2x，還沒到正式爆量）\n【自選】XRP［加密］Bitget 前一根 1.5x／同時段 4.2x｜1H -0.4%｜8.8M\nONE［加密］OKX 前一根 1x／同時段 24.5x｜1H -1.6%｜1.5M\n另有 32 檔，見網頁';
  const p2 = '【盤中推算】11-12 00:00–01:00 台灣時間，第 15 分（1 檔；依已成交量推算整根）\n【自選】NVDA［股票］OKX ★推算 4.1x 同時段／2.9x 近48h\n  價格 175.35（這根目前 -0.7%，前24h +4.5%／日ATR 7.1%）｜已成交 8.6M，推算整根 33.4M\n\n' +
    '【沉睡甦醒】11-11 16:00–17:00 台灣時間（1 檔；10 天窄幅後 OKX、Bitget 同時放量）\nACU OKX 167K（中位數 17.9x）／Bitget 117K（中位數 25x）\n  價格 0.1272｜這根 +2.8%｜距 10 天高點 -2.5%\n\n' +
    '【借幣利率飆高】11-11 15:00 台灣時間（OKX 槓桿借幣，1 檔）\nBARD 年化 130%（7 天中位數 27.6%，4.7x）\n\n' +
    '【日線金叉】11-11 08:00–11-12 08:00 台灣時間收盤（A 級 1 檔）\nNIGHT 收 0.04746｜量 2.51x｜距 SMA200 +56.6%\n\n' +
    '【做空候選・轉弱】11-13 07:00 台灣時間（1 檔）\n\nBARD 1H 轉弱｜24h +47.4%（Bitget +45.4%）｜成交額 57.1M｜今日第 1 次';
  const s = SC.parseRun([part('2026-11-12T00:16:00+08:00', p2, 'telegram-2.txt'), part('2026-11-12T00:16:00+08:00', p1, 'telegram-1.txt')]);
  const by = k => s.filter(x => x.k === k);
  assert.equal(by('pre').length, 2); assert.equal(by('pre')[1].x, 24.5); assert.equal(by('pre')[0].t, tw('2026-11-09T19:00'));
  const e = by('est')[0];
  assert.equal(e.t, tw('2026-11-12T00:15')); assert.equal(e.px, 175.35); assert.equal(e.p24, 4.5); assert.equal(e.atr, 7.1);
  assert.equal(by('dormant')[0].b, 'ACU'); assert.equal(by('dormant')[0].t, tw('2026-11-11T17:00'));
  assert.equal(by('rate')[0].b, 'BARD');
  assert.equal(by('crossd')[0].t, tw('2026-11-12T08:00')); assert.equal(by('crossd')[0].px, 0.04746);
  assert.equal(by('gainer').length, 1); assert.equal(by('gainer')[0].b, 'BARD'); assert.equal(by('gainer')[0].t, tw('2026-11-13T07:00'));
});

const barsOf = (t0, closes) => new Map(closes.map((c, i) => [t0 + i * H, [t0 + i * H, c, c * 1.01, c * 0.99, c]]));

test('補走勢：進場＝訊號那根收盤，4h 報酬、最高、最低與大盤超額', () => {
  const t = tw('2026-11-10T10:00');
  /* 訊號那根（09:00 開）收 100，之後 4 根 101、102、103、110 */
  const bars = barsOf(t - H, [100, 101, 102, 103, 110]);
  const bench = barsOf(t - H, [50, 50, 50, 50, 51]);
  const rec = { k: 'hourly', b: 'X', c: '加密', t };
  assert.equal(SC.fill(rec, bars, bench, t + 5 * H), true);
  assert.equal(rec.e, 100);
  const [r, up, dn, bx] = rec.m[4];
  assert.equal(r, 0.1); assert.equal(up, 0.111); assert.equal(dn, -0.0001); assert.equal(bx, 0.02);
  assert.equal(rec.m[24], undefined, '還沒滿 24 小時不算');
  assert.equal(SC.isDone(rec, t + 5 * H), false);
  assert.equal(SC.isDone(rec, t + 85 * H), true, '過 84 小時就結案');
});

test('補走勢：盤中推算用推播價格，從下一根開始；價差過大不算', () => {
  const bar = tw('2026-11-10T10:00');
  const bars = barsOf(bar, [100, 104, 104, 104, 104]);
  const rec = { k: 'est', b: 'X', c: '股票', t: bar + 15 * 60e3, px: 98 };
  SC.fill(rec, bars, null, bar + 6 * H);
  assert.equal(rec.st, bar + H); assert.equal(rec.e, 98);
  assert.ok(Math.abs(rec.m[4][0] - (104 / 98 - 1)) < 1e-4); assert.equal(rec.m[4][3], null);
  const bad = { k: 'est', b: 'Y', c: '股票', t: bar + 15 * 60e3, px: 50 };
  assert.equal(SC.fill(bad, bars, null, bar + 6 * H), false);
});

test('統計：做空候選以做空計算、勝率扣成本、前後一致', () => {
  const mk = (k, r, bx, t) => ({ k, c: '加密', t, e: 1, m: { 24: [r, Math.max(r, 0), Math.min(r, 0), bx] } });
  const g = [mk('gainer', -0.10, 0, 1), mk('gainer', 0.05, 0, 2)];
  const s = SC.stat(g, 24);
  assert.equal(s.n, 2); assert.equal(s.avg, 2.5); assert.equal(s.win, 50); assert.equal(s.ex, 2.5);
  assert.equal(s.up, 5); assert.equal(s.dn, -2.5);
  assert.equal(SC.stat([mk('hourly', 0.001, 0, 1)], 24).win, 0, '0.1% 扣掉 0.2% 成本算輸');
  const many = Array.from({ length: 40 }, (_, i) => mk('hourly', i < 20 ? 0.02 : -0.01, 0, i));
  assert.equal(SC.consistency(many, 24), 0);
  assert.equal(SC.consistency(many.map(r => ({ ...r, m: { 24: [0.01, 0, 0, 0] } })), 24), 1);
  assert.equal(SC.consistency(many.slice(0, 20), 24), null, '少於 30 筆不判斷');
});

test('統計：反向做空（10% 停損、扣成本）與獨立時段', () => {
  const H = SC.H;
  const mk = (r, up, t) => ({ k: 'hourly', c: '加密', t, e: 1, m: { 24: [r, up, Math.min(r, 0), 0] } });
  /* 跌 8% 沒碰停損 → +8% − 0.2%；漲到 +12% 碰停損 → −10% − 0.2%；兩筆同一小時 */
  const s = SC.stat([mk(-0.08, 0.02, 0), mk(0.03, 0.12, 10 * 60e3)], 24);
  assert.equal(s.fd, -1.2);
  assert.equal(s.fdw, 50);
  assert.equal(s.nh, 1, '同一小時算一個時段');
  assert.equal(SC.stat([mk(-0.05, 0.02, 0), mk(-0.05, 0.02, 2 * H)], 24).nh, 2);
  const g = SC.stat([{ k: 'gainer', c: '加密', t: 0, e: 1, m: { 24: [-0.05, 0, -0.05, 0] } }], 24);
  assert.equal(g.fd, null, '做空候選本來就是做空，不算反向');
});

test('彙整與 Issue 本文：分期間、細分條件、隱藏狀態可還原', () => {
  const now = tw('2026-11-13T12:00');
  const recs = [
    { k: 'hourly', b: 'A', c: '加密', t: now - 2 * 864e5, e: 1, tg: ['連續放量'], x: 6, ch: 1, v: ['okx'], m: { 4: [0.01, 0.02, -0.01, 0], 24: [-0.05, 0.02, -0.06, -0.01] } },
    { k: 'hourly', b: 'B', c: '加密', t: now - 10 * 864e5, e: 1, tg: [], x: 25, ch: 9, v: ['okx', 'bitget'], m: { 4: [0.03, 0.05, -0.01, 0], 24: [0.04, 0.1, -0.02, 0.01] } },
    { k: 'pre', b: 'C', c: '股票', t: now - 3 * H, e: 1, tg: [], m: {} }
  ];
  const sum = SC.summarize(recs, now);
  assert.equal(sum.win['7'].kinds.find(r => r.k === 'hourly').h[24].n, 1);
  assert.equal(sum.win.all.kinds.find(r => r.k === 'hourly').h[24].n, 2);
  const hot = sum.win.all.feats.find(f => f.c === '加密' && f.f === 'hot');
  assert.equal(hot.yes[24].n, 2); assert.equal(hot.no[24].n, 0);
  assert.equal(sum.recent.length, 2);
  const md = SC.embedScore(SC.renderMd(sum), sum);
  assert.match(md, /# 訊號成績/); assert.match(md, /盤中爆量 \| 加密 \| 2 /);
  const raw = md.slice(md.indexOf('<!-- SCORE_STATE') + 16, md.indexOf('SCORE_STATE -->')).trim();
  assert.equal(JSON.parse(zlib.gunzipSync(Buffer.from(raw, 'base64')).toString()).total, 3);
});

test('K 線來源：先用訊號那家，沒有就換同名合約；金叉用 Binance', () => {
  const okx = { AAA: 'AAA-USDT-SWAP', BBB: 'BBB-USDT-SWAP' }, bg = { AAA: 'AAAUSDT', CCC: 'CCCUSDT' };
  assert.deepEqual(SC.pickSrc({ k: 'hourly', b: 'AAA', v: ['bitget'] }, okx, bg), ['bitget', 'AAAUSDT']);
  assert.deepEqual(SC.pickSrc({ k: 'hourly', b: 'BBB', v: ['bybit'] }, okx, bg), ['okx', 'BBB-USDT-SWAP']);
  assert.deepEqual(SC.pickSrc({ k: 'hourly', b: 'CCC', v: ['bybit'] }, okx, bg), ['bitget', 'CCCUSDT']);
  assert.equal(SC.pickSrc({ k: 'hourly', b: 'ZZZ', v: ['bybit'] }, okx, bg), null);
  assert.deepEqual(SC.pickSrc({ k: 'cross', b: 'NIGHT' }, okx, bg), ['binance', 'NIGHTUSDT']);
});

test('爆發標記成績：候選／可略過分組、爆發率', () => {
  const now = Date.UTC(2026, 10, 15);
  const mk = (tg, up, i) => ({ k: 'hourly', c: '加密', b: 'X' + i, t: Date.UTC(2026, 10, 13, 12) + i * 3600e3, tg, e: 1, m: { 24: [0, up, -0.1, 0] } });
  const recs = [mk(['爆發候選'], 0.4, 1), mk(['爆發候選'], 0.1, 2), mk(['可略過'], 0.05, 3), mk([], 0.35, 4)];
  const w = SC.summarize(recs, now).win.all;
  const by = Object.fromEntries(w.marks.map(x => [x.m, x.h[24]]));
  assert.equal(by.cand.n, 2); assert.equal(by.cand.b30, 50);
  assert.equal(by.skip.b30, 0); assert.equal(by.mid.n, 1);
  assert.match(SC.renderMd(SC.summarize(recs, now)), /爆發標記/);
});

test('轉弱新舊規則並行：解析 logs/gainer、勿空子集合、Issue 有比較表', () => {
  const t = tw('2026-11-13 20:00');
  assert.equal(SC.parseShadow({ k: 'x', b: 'A', t, src: ['okx', 'A'] }), null);
  assert.equal(SC.parseShadow({ k: 'gnew', b: 'A', t }), null);
  const n = SC.parseShadow({ t, k: 'gnew', b: 'AKE', tfs: ['1h'], avoid: 1, src: ['okx', 'AKE-USDT-SWAP'] });
  assert.deepEqual(n, { k: 'gnew', b: 'AKE', c: '加密', t, tg: ['勿空', '1H'], v: ['okx'], src: ['okx', 'AKE-USDT-SWAP'], id: `gnew|AKE|${t}|okx` });
  const o = SC.parseShadow({ t, k: 'gold', b: 'BBB', tfs: ['4h'], avoid: 0, src: ['bitget', 'BBBUSDT'] });
  /* 做空計算：跌＝賺 */
  const recs = [{ ...n, e: 1, st: t, m: { 4: [0.1, 0.2, -0.01, 0], 24: [0.2, 0.3, -0.01, 0] } },
    { ...o, e: 1, st: t, m: { 4: [-0.05, 0.01, -0.06, 0], 24: [-0.1, 0.01, -0.12, 0] } },
    { ...SC.parseShadow({ t, k: 'gold', b: 'AKE', tfs: ['1h'], avoid: 1, src: ['okx', 'AKE-USDT-SWAP'] }), e: 1, st: t, m: { 4: [0.1, 0.2, -0.01, 0] } }];
  const sum = SC.summarize(recs, t + 30 * H);
  const k = x => sum.win.all.kinds.find(r => r.k === x);
  assert.equal(k('gnew').h[4].n, 1); assert.equal(k('gnew').h[4].avg, -10);
  assert.equal(k('gnewp'), undefined);                                    /* 新規則只有勿空那筆 → 子集合為空 */
  assert.equal(k('gold').h[4].n, 2);
  assert.equal(k('goldp').h[4].n, 1); assert.equal(k('goldp').h[4].avg, 5);
  const md = SC.renderMd(sum);
  assert.match(md, /新舊規則並行/);
  assert.match(md, /\| 轉弱・舊規則（排除勿空） \| 1 \| \+5\.00% \|/);
});

/* 自訂 OHLC 的 1H K：rows＝[[o,h,l,c], ...]，第一根開盤時間 t0 */
const ohlc = (t0, rows) => new Map(rows.map(([o, h, l, c], i) => [t0 + i * H, [t0 + i * H, o, h, l, c]]));

test('掛單方案（gplan）：解析、成交判定、停損與到期、沒成交', () => {
  const t = tw('2026-11-20 08:00');
  assert.equal(SC.parseShadow({ t, k: 'gplan', b: 'A', src: ['okx', 'A'], lim: 1, sl: 0.9 }), null);   /* 停損不在掛單價之上 */
  const p = SC.parseShadow({ t, k: 'gplan', b: 'BREV', tfs: ['4h'], lim: 0.09224, sl: 0.1356, push: 1, avoid: 0, src: ['okx', 'BREV-USDT-SWAP'] });
  assert.deepEqual(p.tg, ['推播', '4H']); assert.equal(p.lim, 0.09224); assert.equal(p.sl, 0.1356);
  const flat = n => Array.from({ length: n }, () => [1, 1.01, 0.99, 1]);
  /* 第 3 根碰到 1.1 成交，之後 72 根收 1.0 → (1.1-1.0)/1.1 扣成本，除以停損距離 (1.32/1.1-1)=0.2 */
  const fillTime = ohlc(t, [...flat(2), [1, 1.12, 0.99, 1.05], ...flat(72)]);
  assert.deepEqual(SC.simPlan(1.1, 1.32, fillTime, t), [Math.round(((1.1 - 1) / 1.1 - 0.002) / 0.2 * 100) / 100, '到期']);
  /* 成交後碰停損；跳空開在停損上方用開盤價 */
  const stop = ohlc(t, [[1, 1.12, 0.99, 1.05], [1.2, 1.25, 1.1, 1.2], [1.4, 1.5, 1.35, 1.45], ...flat(72)]);
  assert.deepEqual(SC.simPlan(1.1, 1.32, stop, t), [Math.round(((1.1 - 1.4) / 1.1 - 0.002) / 0.2 * 100) / 100, '停損']);
  /* 12 根都沒碰到 → 未成交；成交前先碰停損 → 未成交 */
  assert.deepEqual(SC.simPlan(1.1, 1.32, ohlc(t, flat(84)), t), [0, '未成交']);
  assert.deepEqual(SC.simPlan(1.1, 1.32, ohlc(t, [[1, 1.4, 0.99, 1.3], ...flat(83)]), t), [0, '未成交']);
  /* K 線不夠 → null */
  assert.equal(SC.simPlan(1.1, 1.32, ohlc(t, [[1, 1.12, 0.99, 1.05], ...flat(10)]), t), null);
  /* fill()：84 小時後才算；結案要等 pr */
  const rec = { ...SC.parseShadow({ t, k: 'gplan', b: 'X', tfs: ['4h'], lim: 1.1, sl: 1.32, push: 1, src: ['okx', 'X'] }) };
  const bars = ohlc(t - H, [[1, 1, 1, 1], ...flat(2), [1, 1.12, 0.99, 1.05], ...flat(80)]);
  SC.fill(rec, bars, null, t + 80 * H);
  assert.equal(rec.pr, undefined); assert.ok(rec.m[72]); assert.equal(SC.isDone(rec, t + 80 * H), false);
  SC.fill(rec, bars, null, t + 85 * H);
  assert.equal(rec.pr[1], '到期'); assert.equal(SC.isDone(rec, t + 85 * H), true);
  /* 彙整：成交率、R；Issue 有方案表 */
  const miss = { ...rec, id: 'm', pr: [0, '未成交'] };
  const sum = SC.summarize([rec, miss], t + 90 * H);
  const pl = sum.win.all.plan.find(x => x.k === 'gplanp');
  assert.equal(pl.sig, 2); assert.equal(pl.fill, 50); assert.equal(pl.n, 1); assert.equal(pl.avg, rec.pr[0]);
  assert.match(SC.renderMd(sum), /4H 轉弱掛單方案（實際推播） \| 2 \| 50% \| 1 \|/);
  assert.ok(!sum.win.all.kinds.some(r => r.k === 'gplan') || !/\| 4H 轉弱掛單方案（全部） \| 加密 \|/.test(SC.renderMd(sum)));   /* 不混進各訊號表 */
});

test('解析：做空候選 4H＋1H 轉弱也認得', () => {
  const runs = SC.parseRun([part('2026-11-20T08:02:00+08:00', '【做空候選・轉弱】11-20 08:00 台灣時間（1 檔）\n\nBREV 4H＋1H 轉弱｜24h +47.4%（OKX +45.4%）｜成交額 57.1M')]);
  assert.deepEqual(runs.map(r => [r.k, r.b]), [['gainer', 'BREV']]);
});
