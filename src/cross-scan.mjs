/* 金叉（4H、日線）的資料抓取：Binance 現貨公開行情（data-api.binance.vision）。
   api.binance.com 會擋美國 IP（GitHub Actions 在美國），data-api.binance.vision 是 Binance 官方的公開行情備援網址。 */
import { getJSON } from './venues.mjs';
import { pool } from './core.mjs';
import * as C from './cross.mjs';

const BASE = 'https://data-api.binance.vision/api/v3';

/* 代幣化股票：代號結尾是 B，且交易權限沒有 TRD_GRP_016（2026-11 實測可區分 BNB、ARB、SHIB 等一般幣） */
const isStock = s => /B$/.test(s.baseAsset) && !(s.permissionSets?.[0] || []).includes('TRD_GRP_016');

export async function universe(cfg = C.CROSS) {
  const [info, tick] = await Promise.all([getJSON(`${BASE}/exchangeInfo?permissions=SPOT`), getJSON(`${BASE}/ticker/24hr`)]);
  if (!info?.symbols || !Array.isArray(tick)) throw new Error('Binance 現貨清單或 24h 行情取得失敗（data-api.binance.vision）');
  const qv = new Map(tick.map(t => [t.symbol, +t.quoteVolume]));
  const all = info.symbols
    .filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING' && s.isSpotTradingAllowed !== false)
    .map(s => ({ sym: s.symbol, base: s.baseAsset, stock: isStock(s), qv24h: qv.get(s.symbol) || 0 }));
  return { all, list: all.filter(m => m.qv24h >= cfg.minQv24h && !C.isExcludedBase(m.base, cfg)) };
}

export async function klines(sym, limit, tf = '4h') {
  const d = await getJSON(`${BASE}/klines?symbol=${encodeURIComponent(sym)}&interval=${tf}&limit=${limit}`);
  if (!Array.isArray(d)) return null;
  return d.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], qv: +k[7], ct: +k[6] }));
}

/**
 * 判斷最近已收盤的 K（cfg.tf＝4h 或 1d；漏跑時補到 maxCatchUp 根），並更新 A 級追蹤。
 * 回傳 { ran, latestT, found, universe, warnings }；這一根已經處理過時 ran=false。
 */
export async function scan(state, nowMs, cfg = C.CROSS) {
  const latestT = C.barOpen(nowMs, cfg), BAR = cfg.barMs;
  if (state.lastBar === latestT) return { ran: false, latestT };
  const warnings = [];
  const from = state.lastBar == null ? latestT : Math.max(state.lastBar + BAR, latestT - (cfg.maxCatchUp - 1) * BAR);
  const targets = [];
  for (let t = from; t <= latestT; t += BAR) targets.push(t);

  const u = await universe(cfg);
  const meta = new Map(u.all.map(m => [m.sym, m]));
  const syms = [...new Set([...u.list.map(m => m.sym), ...state.active.map(x => x.sym)])];
  const found = [];
  let fail = 0;
  const trackBars = new Map();
  await pool(syms, 8, async sym => {
    const k = await klines(sym, cfg.bars, cfg.tf);
    if (!k) { fail++; return; }
    const bars = k.filter(b => b.ct < nowMs);          /* 只用已收盤的 K */
    trackBars.set(sym, bars);
    const m = meta.get(sym);
    if (!m || !u.list.includes(m)) return;             /* 只為追蹤而抓（成交額掉到下限以下） */
    if (C.stableLike(bars)) return;
    for (const T of targets) { const c = C.crossAt(m, bars, T, cfg); if (c) found.push(c); }
  });
  if (fail / Math.max(1, syms.length) > 0.3) throw new Error(`Binance ${cfg.label} K 取得失敗率過高（${fail}/${syms.length}）`);
  if (fail) warnings.push(`${fail} 檔 ${cfg.label} K 取得失敗`);

  state.active = state.active.map(it => {
    const bars = trackBars.get(it.sym);
    if (!bars) { warnings.push(`${it.base} 追蹤資料取得失敗，沿用上一輪`); return it; }
    return C.trackItem(it, bars, cfg);
  });
  state.universe = u.list.length;
  return { ran: true, latestT, targets, found, universe: u.list.length, warnings, barsOf: sym => trackBars.get(sym) };
}
