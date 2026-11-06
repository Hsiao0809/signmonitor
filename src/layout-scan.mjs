/* ============================================================
   布局清單的每日資料蒐集：OKX、Bitget 走 API，Bybit 讀公開成交檔並快取
   ============================================================ */
import * as core from './core.mjs';
import * as V from './venues.mjs';
import * as Lay from './layout.mjs';
import { isExcluded, CONFIG as TCFG, tpeHour } from './tracker.mjs';

const D = 864e5;
const CACHE_DAYS = 30;          // Bybit 快取保留天數（量倍數需要前 20 日）
const NEED_DAYS = 22;           // 每檔至少要有幾天 Bybit 資料
const BYBIT_WAIT_UNTIL_TPE = 13; // 台灣時間 13:00 前若 Bybit 昨天的檔案還沒公布，就等下一輪

const ymd = t => new Date(t).toISOString().slice(0, 10);

/**
 * 回傳 { ready, day, candidates, refBarsOf, warnings, counts }
 * ready=false 代表 Bybit 昨日檔案還沒公布，這輪先不處理
 */
export async function collect(lstate, nowMs, cache, cfg = Lay.LAYOUT) {
  const warnings = [];
  const day = ymd(nowMs - D);                       /* 最後一根已收盤的 UTC 日線 */

  /* 1. 股票／商品對照表：以 OKX、Bitget 標成股票或商品的合約為準 */
  const ref = {}, refPrice = {};
  for (const ex of ['okx', 'bitget']) {
    let list = [];
    try { list = await core.EXCHANGES[ex].list(); } catch (e) { warnings.push(`${core.EXCHANGES[ex].label} 合約清單失敗（${e.message}）`); }
    for (const m of list) {
      if (!cfg.cats.includes(m.cat)) continue;
      const base = m.base.replace(/STOCK$/, '');
      if (isExcluded(base, TCFG)) continue;
      const r = ref[base] ||= { base, cat: m.cat, okx: null, bitget: null, bybit: null };
      r[ex] = m.id;
      if (refPrice[base] == null) refPrice[base] = m.price;
    }
  }

  /* 2. Bybit：公開成交檔清單 → 對到同一檔股票 */
  const notStock = new Set(cache.notStock || []);
  let bybitList = [];
  try { bybitList = await V.VENUES.bybit.list(); } catch { /* 下面會記警告 */ }
  if (!bybitList.length) warnings.push('Bybit 公開成交檔清單取得失敗，本輪只用 OKX、Bitget');
  for (const x of bybitList) {
    if (notStock.has(x.sym)) continue;
    const base = V.stockBaseOf(x.base, refPrice);
    if (!base || !ref[base]) continue;
    /* 同一檔有 XXXSTOCKUSDT 與 XXXUSDT 時，優先 STOCK 後綴（另一個通常是同名加密貨幣） */
    if (!ref[base].bybit || x.sym.endsWith('STOCKUSDT')) ref[base].bybit = x.sym;
  }

  /* 3. 補齊 Bybit 每日資料（只抓快取沒有的日子） */
  const want = [];
  for (let k = NEED_DAYS - 1; k >= 0; k--) want.push(ymd(nowMs - (k + 1) * D));
  const bySyms = Object.values(ref).map(r => r.bybit).filter(Boolean);
  const jobs = [];
  for (const s of bySyms) {
    const have = cache.days[s] ||= {};
    for (const d of want) if (!(d in have)) jobs.push([s, d]);
  }
  await V.poolMap(jobs, 12, async ([s, d]) => {
    const b = await V.VENUES.bybit.day(s, d);
    cache.days[s][d] = b ? [b.o, b.h, b.l, b.c, Math.round(b.qv), b.h24] : (d < ymd(nowMs - 2 * D) ? 0 : undefined);
  });
  /* 價格檢查：Bybit 同名合約若其實是加密貨幣（價格差太多），記下來以後跳過 */
  for (const r of Object.values(ref)) {
    if (!r.bybit) continue;
    const ds = Object.keys(cache.days[r.bybit] || {}).filter(d => cache.days[r.bybit][d]).sort();
    if (!ds.length) continue;
    const last = cache.days[r.bybit][ds[ds.length - 1]];
    if (!V.priceMatches(last[3], refPrice[r.base], 0.2)) { notStock.add(r.bybit); delete cache.days[r.bybit]; r.bybit = null; }
  }
  /* 清掉太舊的日子 */
  const oldest = ymd(nowMs - CACHE_DAYS * D);
  for (const s of Object.keys(cache.days)) for (const d of Object.keys(cache.days[s])) if (d < oldest) delete cache.days[s][d];
  cache.notStock = [...notStock];

  const bybitYesterday = bySyms.filter(s => cache.days[s]?.[day]).length;
  const bybitReady = bySyms.length > 0 && bybitYesterday / bySyms.length > 0.5;
  if (!bybitReady && tpeHour(nowMs) < BYBIT_WAIT_UNTIL_TPE && bybitList.length) {
    return { ready: false, day, warnings };
  }
  if (!bybitReady) warnings.push(`Bybit ${day} 的成交檔只取得 ${bybitYesterday}/${bySyms.length} 檔，本日 Bybit 量倍數不完整`);

  /* 4. OKX、Bitget 日線 */
  const series = {};
  const items = Object.values(ref);
  await V.poolMap(items, 8, async r => {
    const s = series[r.base] = { okx: null, bitget: null, bybit: null };
    if (r.okx) s.okx = await V.VENUES.okx.daily(r.okx, 40);
    if (r.bitget) s.bitget = await V.VENUES.bitget.daily(r.bitget, 40);
    if (r.bybit) {
      const dd = cache.days[r.bybit] || {};
      s.bybit = Object.keys(dd).filter(d => dd[d]).sort().map(d => {
        const [o, h, l, c, qv] = dd[d];
        return { t: Date.parse(d + 'T00:00:00Z'), o, h, l, c, qv };
      });
    }
  });

  /* 5. 候選與參考價格 */
  const candidates = [];
  for (const r of items) {
    const s = series[r.base];
    const refEx = s.okx?.length ? 'okx' : s.bitget?.length ? 'bitget' : 'bybit';
    const c = Lay.layoutCandidate({ base: r.base, cat: r.cat, ref: refEx, syms: { okx: r.okx, bitget: r.bitget, bybit: r.bybit } }, s, day, nowMs, cfg);
    if (c) candidates.push(c);
  }
  const refSeries = items.filter(r => r.cat === 'stock').map(r => series[r.base].okx || series[r.base].bitget).filter(b => b && b.length > 5);
  const refBarsOf = it => (series[it.base] || {})[it.ref] || [];
  const counts = {
    total: items.length,
    okx: items.filter(r => series[r.base].okx?.length).length,
    bitget: items.filter(r => series[r.base].bitget?.length).length,
    bybit: items.filter(r => series[r.base].bybit?.length).length
  };
  const symsOf = base => ref[base] ? { okx: ref[base].okx, bitget: ref[base].bitget, bybit: ref[base].bybit } : null;
  return { ready: true, day, candidates, refSeries, refBarsOf, symsOf, warnings, counts };
}
