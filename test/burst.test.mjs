import test from 'node:test';
import assert from 'node:assert/strict';
import { burstFeat, burstTag, burstRank } from '../src/burst.mjs';
import { hourStats, pickAlerts, emptyHourly, hourlyAlertText, mergeByBase } from '../src/hourly.mjs';
import { pickPre, emptyPre, preAlertText } from '../src/early.mjs';

const H = 3600e3;
const T = Date.UTC(2026, 10, 13, 6);
/* 7 天＋1 根 1H K：price(k) 給第 k 根之前的收盤；cur 是這一根 */
function series({ base = 1, spread = 0.01, drift = 0, qv = 4e5, cur }) {
  const bars = [];
  for (let k = 200; k >= 1; k--) {
    const c = base * (1 + drift * (200 - k) / 200);
    bars.push({ t: T - k * H, o: c, h: c * (1 + spread), l: c * (1 - spread), c, qv });
  }
  bars.push({ t: T, ...cur });
  return bars;
}
const ON = { on: true };

test('特徵：這根振幅、7 天漲幅、7 天高低差', () => {
  const bars = series({ cur: { o: 1, h: 1.2, l: 1, c: 1.1, qv: 1e7 } });
  const f = burstFeat(new Map(bars.map(b => [b.t, b])), T);
  assert.ok(Math.abs(f.rng - 0.2) < 1e-9);
  assert.ok(Math.abs(f.r7d - 0.1) < 1e-9);
  assert.ok(Math.abs(f.rg7 - (1.01 / 0.99 - 1)) < 1e-9);
  assert.equal(burstFeat(new Map(bars.slice(-50).map(b => [b.t, b])), T), null, '歷史不足不算');
  assert.equal(burstFeat(new Map([[T, { t: T, o: 0, h: 0, l: 0, c: 0, qv: 1 }]]), T), null, 'Bybit 成交檔沒有高低價');
});

test('標記：候選三條件、可略過、自選不略過、只用加密、推算中不用振幅略過', () => {
  const bf = { rng: 0.15, r7d: 0.6, rg7: 1.2 };
  assert.equal(burstTag({ cat: 'crypto', x1: 25, bf }, ON), 'cand');
  assert.equal(burstTag({ cat: 'crypto', x1: 19, bf }, ON), null, '倍數不夠');
  assert.equal(burstTag({ cat: 'crypto', x1: 25, bf: { ...bf, rng: 0.12 } }, ON), null);
  assert.equal(burstTag({ cat: 'crypto', x1: 25, bf: { ...bf, r7d: 0.49 } }, ON), null);
  assert.equal(burstTag({ cat: 'stock', x1: 25, bf }, ON), null, '股票不標');
  assert.equal(burstTag({ cat: 'crypto', x1: 6, bf: { rng: 0.02, r7d: 0, rg7: 0.5 } }, ON), 'skip', '振幅 <4%');
  assert.equal(burstTag({ cat: 'crypto', x1: 6, bf: { rng: 0.1, r7d: 0, rg7: 0.2 } }, ON), 'skip', '7 天高低差 <28%');
  assert.equal(burstTag({ cat: 'crypto', watch: true, x1: 6, bf: { rng: 0.02, r7d: 0, rg7: 0.2 } }, ON), null, '自選不略過');
  assert.equal(burstTag({ cat: 'crypto', x1: 6, bf: { rng: 0.02, r7d: 0, rg7: 0.5 } }, { partial: true, on: true }), null, '推算中振幅還會變大');
  assert.equal(burstTag({ cat: 'crypto', x1: 25, bf }, { on: false }), null, '關閉');
  assert.equal(burstTag({ cat: 'crypto', x1: 25, bf: null }, ON), null);
});

test('盤中爆量：候選排第一、可略過排最後，文字有標記與說明', () => {
  const mk = (base, bars) => ({ venue: 'okx', sym: `${base}-USDT-SWAP`, base, cat: 'crypto', stats: hourStats(bars, T, 'crypto') });
  /* 候選：7 天漲 60%、這根振幅 20%、量 30 倍 */
  const cand = mk('AAA', series({ spread: 0.05, drift: 0.6, cur: { o: 1.55, h: 1.9, l: 1.55, c: 1.85, qv: 1.2e7 } }));
  /* 可略過：7 天窄幅、這根振幅 2% */
  const skip = mk('BBB', series({ spread: 0.01, cur: { o: 1, h: 1.02, l: 1, c: 1.01, qv: 3e7 } }));
  /* 一般 */
  const mid = mk('CCC', series({ spread: 0.2, cur: { o: 1, h: 1.08, l: 1, c: 1.05, qv: 4e6 } }));
  assert.ok(cand.stats.x1 >= 20 && cand.stats.bf.r7d >= 0.5, JSON.stringify(cand.stats.bf));
  const al = pickAlerts(emptyHourly(), [skip, mid, cand], T);
  assert.deepEqual(al.map(a => a.base), ['AAA', 'CCC', 'BBB']);
  assert.equal(al[0].burst, 'cand'); assert.equal(al[2].burst, 'skip'); assert.equal(al[1].burst, undefined);
  assert.equal(typeof al[0].bf7, 'number');
  const txt = hourlyAlertText(al, T);
  assert.match(txt, /\n【爆發候選】\u0001AAA\u0002/);
  assert.match(txt, /\n【可略過】\u0001BBB\u0002/);
  assert.match(txt, /【爆發候選】＝/); assert.match(txt, /【可略過】＝/);
  assert.equal(burstRank(mergeByBase(al)[0]), 0);
});

test('預警：可略過也照列、排在最後', () => {
  const st = (spread, cur) => hourStats(series({ spread, cur }), T, 'crypto');
  const a = { venue: 'okx', sym: 'X', base: 'XXX', cat: 'crypto', stats: st(0.01, { o: 1, h: 1.01, l: 1, c: 1.005, qv: 1.2e6 }) };
  const b = { venue: 'okx', sym: 'Y', base: 'YYY', cat: 'crypto', stats: st(0.2, { o: 1, h: 1.06, l: 1, c: 1.05, qv: 1e6 }) };
  const added = pickPre(emptyPre(), [a, b], T);
  assert.deepEqual(added.map(p => [p.base, p.burst]), [['YYY', undefined], ['XXX', 'skip']]);
  assert.match(preAlertText(added, T), /【可略過】\u0001XXX\u0002/);
});
