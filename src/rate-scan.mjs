/* ============================================================
   借幣利率的資料：OKX finance/savings（公開、不用 Key）
   - 本小時：lending-rate-summary（全部幣種一次抓）
   - 基準：每小時的已定利率存在快取（.cache/rates.json，GitHub Actions cache），保留 8 天；
     紀錄不足的幣用 lending-rate-history（每頁 100 小時）補，第一次就能判斷，不用等。
   - 紀錄：每小時一行寫到 data/rates/YYYY-MM-DD.jsonl（UTC 日），之後回測用：
     {"t":整點,"r":{"BTC":[本小時, 下一小時預估],...}}
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import * as V from './venues.mjs';
import { RATE, isStable } from './rate.mjs';

const H = 3600e3;
export const SCAN = { keepHours: 192, backfillPerRun: 200, pages: 2, conc: 3 };
const API = 'https://www.okx.com/api/v5/finance/savings';

export function loadCache(file) {
  try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); return { h: c.h || {}, bf: c.bf || {} }; } catch { return { h: {}, bf: {} }; }
}
export function saveCache(file, c) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(c));
}
const num = v => (v === '' || v == null || !isFinite(+v) ? null : +v);

/** 本小時全部幣種：[{ ccy, pre, est }] */
export async function summary() {
  const j = await V.getJSON(`${API}/lending-rate-summary`);
  if (!j || j.code !== '0') throw new Error('OKX 借幣利率取得失敗');
  return (j.data || []).map(r => ({ ccy: r.ccy, pre: num(r.preRate), est: num(r.estRate) })).filter(r => r.ccy && r.pre != null);
}

/** 單一幣近 pages×100 小時的已定利率 {t: rate} */
export async function history(ccy, pages = SCAN.pages) {
  const out = {};
  let after = '';
  for (let k = 0; k < pages; k++) {
    const j = await V.getJSON(`${API}/lending-rate-history?ccy=${encodeURIComponent(ccy)}&limit=100${after ? `&after=${after}` : ''}`);
    const d = j?.code === '0' ? j.data || [] : [];
    for (const r of d) if (num(r.rate) != null) out[+r.ts] = +r.rate;
    if (d.length < 100) break;
    after = d[d.length - 1].ts;
  }
  return out;
}

/** OKX 現貨 USDT 對的現價與 24h 漲跌（現貨沒有的用永續價補）：{ccy: { last, chg }} */
export async function spot() {
  const j = await V.getJSON('https://www.okx.com/api/v5/market/tickers?instType=SPOT');
  const px = {};
  for (const t of j?.data || []) {
    if (!t.instId.endsWith('-USDT')) continue;
    const last = num(t.last), open = num(t.open24h);
    if (last) px[t.instId.slice(0, -5)] = { last, chg: open ? +(last / open - 1).toFixed(4) : null };
  }
  /* 沒有現貨 USDT 對的幣，改用永續合約價，通知才不會沒有價格；永續也失敗不影響現貨結果 */
  try {
    const sj = await V.getJSON('https://www.okx.com/api/v5/market/tickers?instType=SWAP');
    for (const t of sj?.data || []) {
      if (!t.instId.endsWith('-USDT-SWAP')) continue;
      const ccy = t.instId.slice(0, -10);
      if (px[ccy]) continue;
      const last = num(t.last), open = num(t.open24h);
      if (last) px[ccy] = { last, chg: open ? +(last / open - 1).toFixed(4) : null };
    }
  } catch { /* 沒有永續價就維持原樣 */ }
  return px;
}

/**
 * 更新快取並回傳判斷用的資料。T＝本小時整點。
 * 回傳 { rows, px, stats: { coins, backfilled, short } }
 */
export async function collect(cache, T, warnings) {
  const rows = await summary();
  /* 本小時的已定利率記進快取 */
  for (const r of rows) (cache.h[r.ccy] ||= {})[T] = r.pre;
  /* 紀錄不足的幣補歷史（同一幣 24 小時內補過就不再補，避免新上架的幣每輪都抓） */
  const need = rows.filter(r => !isStable(r.ccy)).map(r => r.ccy).filter(c => {
    const n = Object.keys(cache.h[c] || {}).filter(t => +t < T && +t >= T - RATE.baseHours * H).length;
    return n < RATE.minBase && !(cache.bf[c] && T - cache.bf[c] < 24 * H);
  }).slice(0, SCAN.backfillPerRun);
  let backfilled = 0, failed = 0;
  for (let i = 0; i < need.length; i += SCAN.conc) {
    await Promise.all(need.slice(i, i + SCAN.conc).map(async c => {
      const h = await history(c);
      if (!Object.keys(h).length) { failed++; return; }
      cache.h[c] = { ...h, ...cache.h[c] };
      cache.bf[c] = T;
      backfilled++;
    }));
  }
  if (failed > need.length * 0.5 && failed > 5) warnings.push(`借幣利率歷史回補失敗 ${failed}/${need.length} 檔`);
  /* 只留 8 天；已下架的幣整個刪掉 */
  const live = new Set(rows.map(r => r.ccy));
  for (const c of Object.keys(cache.h)) {
    if (!live.has(c)) { delete cache.h[c]; continue; }
    for (const t of Object.keys(cache.h[c])) if (+t < T - SCAN.keepHours * H) delete cache.h[c][t];
  }
  for (const c of Object.keys(cache.bf)) if (T - cache.bf[c] > 48 * H) delete cache.bf[c];
  let px = {};
  try { px = await spot(); } catch { warnings.push('OKX 現貨價格取得失敗（不影響判斷）'); }
  /* OKX 有 USDT 永續合約的幣（自動加入自選只加這些）；抓不到時回 null＝不限制 */
  const sw = await V.getJSON('https://www.okx.com/api/v5/public/instruments?instType=SWAP');
  const swaps = sw?.data?.length ? new Set(sw.data.filter(i => i.instId.endsWith('-USDT-SWAP')).map(i => i.instId.slice(0, -10))) : null;
  return { rows, px, swaps, stats: { coins: rows.length, backfilled, need: need.length } };
}

/** 同一小時已經寫過就不重寫 */
export function appendRates(dir, T, rows) {
  if (!rows.length) return false;
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${new Date(T).toISOString().slice(0, 10)}.jsonl`);
  if (fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes(`{"t":${T},`)) return false;
  const r = {};
  for (const x of rows) if (!isStable(x.ccy)) r[x.ccy] = [x.pre, x.est];
  fs.appendFileSync(f, JSON.stringify({ t: T, r }) + '\n');
  return true;
}
