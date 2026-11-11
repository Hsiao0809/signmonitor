/* ============================================================
   沉睡甦醒的資料：OKX、Bitget 都有的加密合約，每小時抓 300 根 1H K。
   30 天最高量需要 12 天以外的資料：每天的最高 1H 成交額存在快取
   （.cache/dormant.json，GitHub Actions cache）；缺的用歷史 K 線補，每輪最多補 backfillPerRun 檔。
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import * as core from './core.mjs';
import * as V from './venues.mjs';
import { CONFIG as TCFG, isExcluded } from './tracker.mjs';
import { DORMANT, dayMaxes, wakeStats, dayOf } from './dormant.mjs';

const H = 3600e3, D = 24 * H;
export const SCAN = { backfillPerRun: 180, conc: 8 };

export function loadCache(file) {
  try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); return { dm: c.dm || {} }; } catch { return { dm: {} }; }
}
export function saveCache(file, c) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(c));
}

const bar = (t, o, h, l, c, qv) => ({ t: +t, o: +o, h: +h, l: +l, c: +c, qv: +qv });
async function recent(ex, sym) {
  if (ex === 'okx') {
    const j = await V.getJSON(`https://www.okx.com/api/v5/market/candles?instId=${sym}&bar=1H&limit=300`);
    return (j?.data || []).filter(k => k[8] === '1').map(k => bar(k[0], k[1], k[2], k[3], k[4], k[7])).sort((a, b) => a.t - b.t);
  }
  const j = await V.getJSON(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${sym}&productType=USDT-FUTURES&granularity=1H&limit=300`);
  const now = Date.now();
  return (j?.data || []).map(k => bar(k[0], k[1], k[2], k[3], k[4], k[6])).filter(b => b.t + H <= now).sort((a, b) => a.t - b.t);
}
/** 補 endMs 之前約 days 天的 1H K（只用來算每天最高量） */
async function history(ex, sym, endMs, days) {
  const out = [];
  if (ex === 'okx') {
    let after = endMs;
    for (let k = 0; k < Math.ceil(days * 24 / 100); k++) {
      const j = await V.getJSON(`https://www.okx.com/api/v5/market/history-candles?instId=${sym}&bar=1H&limit=100&after=${after}`);
      const d = j?.data || [];
      if (!d.length) break;
      out.push(...d.map(k => bar(k[0], k[1], k[2], k[3], k[4], k[7])));
      after = +d[d.length - 1][0];
      if (d.length < 100) break;
    }
  } else {
    let end = endMs;
    for (let k = 0; k < Math.ceil(days * 24 / 200); k++) {
      const j = await V.getJSON(`https://api.bitget.com/api/v2/mix/market/history-candles?symbol=${sym}&productType=USDT-FUTURES&granularity=1H&limit=200&endTime=${end}`);
      const d = j?.data || [];
      if (!d.length) break;
      out.push(...d.map(k => bar(k[0], k[1], k[2], k[3], k[4], k[6])));
      end = Math.min(...d.map(k => +k[0])) - 1;
      if (d.length < 200) break;
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** OKX、Bitget 都有上架的加密合約 */
export async function universe(warnings) {
  const [o, b] = await Promise.all([core.EXCHANGES.okx.list(), core.EXCHANGES.bitget.list()]);
  if (!o.length || !b.length) warnings.push(`沉睡甦醒：合約清單取得失敗（OKX ${o.length}、Bitget ${b.length}）`);
  const ok = o.filter(m => m.cat === 'crypto' && !isExcluded(m.base, TCFG));
  const bg = b.filter(m => m.cat === 'crypto' && !isExcluded(m.base, TCFG));
  const ob = new Map(ok.map(m => [m.base, m.id]));
  const pairs = bg.filter(m => ob.has(m.base)).map(m => ({ base: m.base, okx: ob.get(m.base), bitget: m.id }));
  return pairs;
}

/**
 * 回傳 T 這根的訊號 [{ venue, sym, base, st }]，並更新快取
 * stats：{ scanned, backfilled, dormant }
 */
export async function scanWake(cache, T, warnings, cfg = DORMANT) {
  const pairs = await universe(warnings);
  const jobs = pairs.flatMap(p => [{ venue: 'okx', sym: p.okx, base: p.base }, { venue: 'bitget', sym: p.bitget, base: p.base }]);
  const day = dayOf(T);
  const sigs = [], stats = { pairs: pairs.length, scanned: 0, dormant: 0, backfilled: 0, needBackfill: 0, fail: { okx: 0, bitget: 0 } };
  const keep = day - (cfg.maxDays + 2) * D;
  let budget = SCAN.backfillPerRun;
  await V.poolMap(jobs, SCAN.conc, async j => {
    const bars = await recent(j.venue, j.sym);
    if (!bars.length) { stats.fail[j.venue]++; return; }
    if (!bars.some(b => b.t === T)) return;
    stats.scanned++;
    const key = `${j.venue}:${j.sym}`;
    const dm = cache.dm[key] ||= {};
    Object.assign(dm, dayMaxes(bars, T));
    /* 缺 30 天的每日最高量：從最早那天往前補 */
    const have = Object.keys(dm).map(Number).filter(d => d < day && d >= day - cfg.maxDays * D);
    /* 補過但還是不足 30 天（上架不久或 API 失敗）：一天後再試 */
    if (have.length < cfg.minMaxDays && !(dm._try && T - dm._try < D)) {
      stats.needBackfill++;
      if (budget > 0) {
        budget--;
        dm._try = T;
        const hist = await history(j.venue, j.sym, bars[0].t, cfg.maxDays - 10);
        if (hist.length) { Object.assign(dm, dayMaxes(hist, T)); stats.backfilled++; }
      }
    }
    for (const d of Object.keys(dm)) if (d !== '_try' && +d < keep) delete dm[d];
    const st = wakeStats(bars, T, dm, cfg);
    if (!st) return;
    stats.dormant++;
    if (st.kinds.length) sigs.push({ venue: j.venue, sym: j.sym, base: j.base, st });
  });
  const live = new Set(jobs.map(j => `${j.venue}:${j.sym}`));
  for (const k of Object.keys(cache.dm)) if (!live.has(k)) delete cache.dm[k];
  if (stats.fail.okx > jobs.length / 4 || stats.fail.bitget > jobs.length / 4) warnings.push(`沉睡甦醒：1H K 取得失敗 OKX ${stats.fail.okx}、Bitget ${stats.fail.bitget}`);
  return { sigs, stats, pairs };
}
