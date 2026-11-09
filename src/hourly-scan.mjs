/* ============================================================
   盤中爆量的資料蒐集
   - OKX、Bitget：REST 1H K（含加密貨幣、股票、商品）
   - Bybit：股票／商品合約。整點收盤用 WebSocket 即時抓；
     「過去 7 天同一小時」的基準來自公開成交檔（每小時成交額）＋先前抓到的整點資料
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import * as core from './core.mjs';
import * as V from './venues.mjs';
import { CONFIG as TCFG, isExcluded } from './tracker.mjs';
import { hourStats } from './hourly.mjs';

const H = 3600e3, D = 24 * H;
const ymd = t => new Date(t).toISOString().slice(0, 10);
const BASE_DAYS = 8;                 /* Bybit 每小時基準需要幾天的成交檔 */
const KEEP_CAPTURED = 9 * D;

export function loadCache(file) {
  try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); c.hours ||= {}; c.days ||= {}; c.notStock ||= []; return c; }
  catch { return { v: 1, notStock: [], days: {}, hours: {} }; }
}
export function saveCache(file, c) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(c));
}

/** 整點前先做：三家合約清單、Bybit 股票／商品對照；watch＝自選代號（一律監控） */
export async function prepare(cache, warnings, watch = [], { bybit = true } = {}) {
  const W = new Set(watch);
  const lists = {}, refPrice = {}, refCat = {}, cryptoPrice = {};
  for (const ex of ['okx', 'bitget']) {
    try { lists[ex] = await core.EXCHANGES[ex].list(); }
    catch (e) { lists[ex] = []; warnings.push(`${core.EXCHANGES[ex].label} 合約清單失敗（${e.message}）`); }
    for (const m of lists[ex]) {
      const base = m.cat === 'stock' ? m.base.replace(/STOCK$/, '') : m.base;
      if (m.cat !== 'crypto' && refPrice[base] == null) { refPrice[base] = m.price; refCat[base] = m.cat; }
      if (m.cat === 'crypto' && cryptoPrice[base] == null) cryptoPrice[base] = m.price;
    }
  }
  const baseOf = m => (m.cat === 'stock' ? m.base.replace(/STOCK$/, '') : m.base);
  const pick = ex => lists[ex]
    .filter(m => W.has(baseOf(m)) || (!isExcluded(m.base, TCFG) && m.qv24h >= (TCFG.liqFloor[m.cat] ?? TCFG.liqFloor.crypto)))
    .map(m => ({ venue: ex, sym: m.id, base: baseOf(m), cat: m.cat, watch: W.has(baseOf(m)) }));
  const okx = pick('okx'), bitget = pick('bitget');
  if (!bybit) return { okx, bitget, bybit: [], refPrice };

  const notStock = new Set(cache.notStock);
  let bl = [];
  try { bl = await V.VENUES.bybit.list(); } catch { /* 下面記警告 */ }
  if (!bl.length) warnings.push('Bybit 公開成交檔清單取得失敗');
  const byBase = {};
  for (const x of bl) {
    if (notStock.has(x.sym)) continue;
    const base = V.stockBaseOf(x.base, refPrice);
    if (!base || isExcluded(base, TCFG)) continue;
    if (!byBase[base] || x.sym.endsWith('STOCKUSDT')) byBase[base] = { venue: 'bybit', sym: x.sym, base, cat: refCat[base], watch: W.has(base) };
  }
  /* 自選的加密貨幣：Bybit 用 BASEUSDT；價格之後跟 OKX／Bitget 比對，排除同名不同幣 */
  const bySym = new Set(bl.map(x => x.sym));
  for (const base of W) {
    if (byBase[base] || !bySym.has(`${base}USDT`) || cryptoPrice[base] == null) continue;
    byBase[base] = { venue: 'bybit', sym: `${base}USDT`, base, cat: 'crypto', watch: true, cryptoRef: cryptoPrice[base] };
  }
  for (const x of Object.values(byBase)) if (x.cryptoRef != null) refPrice[x.base] ??= x.cryptoRef;
  return { okx, bitget, bybit: Object.values(byBase), refPrice };
}

/** 補齊 Bybit 近 8 天每小時成交額（只抓快取裡沒有每小時資料的日子） */
export async function ensureBybitBaseline(cache, bybit, refPrice, nowMs) {
  const days = [];
  for (let k = 1; k <= BASE_DAYS; k++) days.push(ymd(nowMs - k * D));
  const jobs = [];
  cache.big ||= [];
  const big = new Set(cache.big);
  /* 自選的加密貨幣若成交檔太大（BTC 一天約 90 MB），不下載，改用每小時即時記錄累積基準 */
  for (const x of bybit.filter(x => x.cat === 'crypto' && !big.has(x.sym) && !(cache.days[x.sym] && Object.keys(cache.days[x.sym]).length))) {
    const size = await V.bybitFileSize(x.sym, days[0]);
    if (size > 40e6) { big.add(x.sym); }
  }
  cache.big = [...big];
  for (const x of bybit) {
    if (big.has(x.sym)) continue;
    const dd = cache.days[x.sym] ||= {};
    for (const d of days) {
      const v = dd[d];
      if (v === 0) continue;                                   /* 當天沒上市 */
      if (!v || !Array.isArray(v[5])) jobs.push([x.sym, d]);
    }
  }
  await V.poolMap(jobs, 12, async ([s, d]) => {
    const b = await V.VENUES.bybit.day(s, d);
    if (b) cache.days[s][d] = [b.o, b.h, b.l, b.c, Math.round(b.qv), b.h24];
    else if (d < ymd(nowMs - 2 * D)) cache.days[s][d] = 0;     /* 舊日子沒有檔案＝當時還沒上市 */
  });
  /* 同名的加密貨幣合約（價格差太多）以後跳過 */
  const notStock = new Set(cache.notStock);
  for (const x of bybit) {
    const dd = cache.days[x.sym] || {};
    const last = Object.keys(dd).filter(d => dd[d]).sort().pop();
    if (last && !V.priceMatches(dd[last][3], refPrice[x.base], 0.2)) { notStock.add(x.sym); delete cache.days[x.sym]; x.bad = true; }
  }
  cache.notStock = [...notStock];
  return jobs.length;
}

/** Bybit 某合約的 1H 成交額序列：成交檔（每小時）＋先前即時抓到的整點 */
export function bybitHourBars(cache, sym, extra = null) {
  const m = new Map();
  const dd = cache.days[sym] || {};
  for (const d of Object.keys(dd)) {
    const v = dd[d];
    if (!v || !Array.isArray(v[5])) continue;
    const t0 = Date.parse(d + 'T00:00:00Z');
    v[5].forEach((qv, h) => m.set(t0 + h * H, { t: t0 + h * H, qv, o: 0, c: 0 }));
  }
  for (const [t, qv] of Object.entries(cache.hours[sym] || {})) if (!m.has(+t)) m.set(+t, { t: +t, qv, o: 0, c: 0 });
  if (extra) m.set(extra.t, extra);
  return [...m.values()];
}

export function rememberCaptured(cache, captured, nowMs) {
  for (const [sym, b] of Object.entries(captured)) {
    if (!b.confirm) continue;
    (cache.hours[sym] ||= {})[b.t] = Math.round(b.qv);
  }
  for (const s of Object.keys(cache.hours)) {
    for (const t of Object.keys(cache.hours[s])) if (nowMs - +t > KEEP_CAPTURED) delete cache.hours[s][t];
    if (!Object.keys(cache.hours[s]).length) delete cache.hours[s];
  }
}

/** 整點收盤後：算出三家每個合約該小時的倍數 */
export async function collectEntries(prep, cache, captured, T, warnings) {
  const entries = [];
  for (const ex of ['okx', 'bitget']) {
    let fail = 0;
    await V.poolMap(prep[ex], 8, async x => {
      const bars = await V.VENUES[ex].hourly(x.sym);
      if (!bars || !bars.length) { fail++; return; }
      const st = hourStats(bars, T, x.cat);
      if (st) entries.push({ ...x, stats: st });
    });
    if (fail > prep[ex].length * 0.3) warnings.push(`${V.VENUES[ex].label} 有 ${fail}/${prep[ex].length} 檔 1H K 取得失敗`);
  }
  let got = 0;
  for (const x of prep.bybit) {
    if (x.bad) continue;
    const cur = captured[x.sym];
    if (!cur || !cur.confirm) continue;
    got++;
    const st = hourStats(bybitHourBars(cache, x.sym, cur), T, x.cat);
    if (st) entries.push({ ...x, stats: st });
  }
  if (prep.bybit.length && got < prep.bybit.filter(x => !x.bad).length * 0.5) {
    warnings.push(`Bybit 這一小時只即時抓到 ${got} 檔收盤資料（排程晚於整點時，Bybit 該小時會缺）`);
  }
  return entries;
}
