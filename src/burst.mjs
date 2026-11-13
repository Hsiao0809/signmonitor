/* ============================================================
   爆發標記（只加標記、改排序，不改任何偵測門檻，也不刪任何通知）
   只用在加密貨幣的盤中爆量、盤中推算、預警。

   【爆發候選】同時段 ≥ 20x、這根 1H 高低振幅 ≥ 13%、收盤比 7 天前 ≥ +50%
     2026-09-14～11-12 Bitget 464 檔加密合約重建 6,315 次爆量：符合的約 6%，
     之後 24 小時內曾漲 ≥ 30% 的比例前半段 31%、後半段 32%（全部爆量 11%）；
     2026-11-07～11-13 實際推播 15 筆中 5 筆（全部推播 6.7%）。
     但多數會先跌：只有約 16% 是「先到 +30%、之前沒跌 8%」。
   【可略過】前 7 天最高 ÷ 最低 − 1 < 28%，或這根 1H 高低振幅 < 4%（自選不標）
     同一份回測：佔 44% 的爆量，只漏掉 6% 的爆發；這群爆發率約 1%。
     實際推播：佔 70%，46 筆爆發漏 8 筆（4 筆是自選，自選不標）。
   關閉：config/burst.json 的 enabled 改 false，或環境變數 BURST_ENABLED=0。
   ============================================================ */
import fs from 'node:fs';

const H = 3600e3;
export const BURST = {
  cand: { x1: 20, rng: 0.13, r7d: 0.5 },
  skip: { rg7: 0.28, rng: 0.04 },
  lookback: 168            /* 7 天的 1H K */
};

export function burstEnabled(file = new URL('../config/burst.json', import.meta.url)) {
  if (process.env.BURST_ENABLED === '0') return false;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).enabled !== false; } catch { return true; }
}
const ON = burstEnabled();

/**
 * m：Map(開盤時間 → bar{t,o,h,l,c})，T：這根的開盤時間
 * 回傳 { rng, r7d, rg7 }（比例），沒有高低價資料（Bybit 成交檔）或歷史不足就回傳 null
 */
export function burstFeat(m, T, cfg = BURST) {
  const cur = m.get(T);
  if (!cur || !(cur.h > 0) || !(cur.l > 0) || !(cur.c > 0)) return null;
  let hi = -Infinity, lo = Infinity, n = 0;
  for (let k = 1; k <= cfg.lookback; k++) {
    const b = m.get(T - k * H);
    if (!b || !(b.h > 0) || !(b.l > 0)) continue;
    n++; if (b.h > hi) hi = b.h; if (b.l < lo) lo = b.l;
  }
  if (n < cfg.lookback * 0.9) return null;
  const ref = m.get(T - cfg.lookback * H);
  return {
    rng: cur.h / cur.l - 1,
    r7d: ref && ref.c > 0 ? cur.c / ref.c - 1 : null,
    rg7: hi / lo - 1
  };
}

/**
 * 'cand'＝爆發候選、'skip'＝可略過、null＝不標
 * partial：這根還沒收盤（盤中推算），振幅還會變大，所以不用「振幅 < 4%」略過
 */
export function burstTag({ cat, watch, x1, bf }, { partial = false, cfg = BURST, on = ON } = {}) {
  if (!on || cat !== 'crypto' || !bf) return null;
  const c = cfg.cand, s = cfg.skip;
  if (x1 >= c.x1 && bf.rng >= c.rng && bf.r7d != null && bf.r7d >= c.r7d) return 'cand';
  if (watch) return null;
  if (bf.rg7 < s.rg7 || (!partial && bf.rng < s.rng)) return 'skip';
  return null;
}

/** 排序用：候選最前、可略過最後 */
export const burstRank = a => (a.burst === 'cand' ? 0 : a.burst === 'skip' ? 2 : 1);
export const burstLabel = a => (a.burst === 'cand' ? '【爆發候選】' : a.burst === 'skip' ? '【可略過】' : '');
/** 存進狀態用：特徵四捨五入成百分比 */
export const bfOut = bf => bf ? { bfr: +(bf.rng * 100).toFixed(1), bf7: bf.r7d == null ? null : +(bf.r7d * 100).toFixed(1), bfg: +(bf.rg7 * 100).toFixed(1) } : {};

export const BURST_NOTE = {
  cand: '【爆發候選】＝爆量 ≥20x、這根振幅 ≥13%、7 天已漲 ≥50%：回測約 3 成之後 24h 內漲 ≥30%，但多數會先跌 8% 以上',
  skip: '【可略過】＝前 7 天高低差 <28% 或這根振幅 <4%：回測這類幾乎不會爆發（約 1%）'
};
