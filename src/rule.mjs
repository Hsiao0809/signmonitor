/* ============================================================
   照規則交易模擬：回答「照交易系統的規則進出，這個訊號平均賺幾 R」。
   R＝進場價到停損的距離；+2R＝賺了停損距離的兩倍。
   規則（交易系統 v2）：
     1. 停損＝訊號給的結構位（金叉：近 6 根低點；轉弱做空：24h 高點）。
     2. 到 2R 先平一半，剩下的停損移到成本價。
     3. 剩下的：有傳 EMA 時，收盤跌破（做空：站上）EMA20 就以收盤價出場；沒傳就抱到資料結束。
     4. 資料結束還沒出場＝持有中，用最後一根收盤估算。
   同一根 K 同時碰到停損與 2R 時算停損（保守）。成本 0.2% 換算成 R 扣掉。
   ============================================================ */
export const RULE = { target: 2, cost: 0.002 };

/**
 * dir：1 做多、-1 做空；entry、stop：價格；bars：進場之後的 K（由舊到新，{h,l,c}）；
 * ema：與 bars 對齊的 EMA20（null＝不用 EMA 出場）。
 * 回傳 { r, why, open, half, n } 或 null（停損方向不對、沒有 K 線）
 */
export function simRule(dir, entry, stop, bars, ema = null, cfg = RULE) {
  if (!(entry > 0) || !(stop > 0) || !bars || !bars.length) return null;
  const risk = dir > 0 ? entry - stop : stop - entry;
  if (!(risk > 0)) return null;
  const R = px => dir * (px - entry) / risk;
  const tgt = entry + dir * cfg.target * risk;
  const costR = cfg.cost * entry / risk;
  let half = false, s = stop, r = 0;
  const done = (why, n) => ({ r: round(r - costR), why, open: false, half, n });
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const part = half ? 0.5 : 1;
    if (dir > 0 ? b.l <= s : b.h >= s) { r += part * R(s); return done(half ? '保本' : '停損', i + 1); }
    if (!half && (dir > 0 ? b.h >= tgt : b.l <= tgt)) { half = true; r += 0.5 * cfg.target; s = entry; }
    const e = ema ? ema[i] : null;
    if (e != null && (dir > 0 ? b.c < e : b.c > e)) { r += (half ? 0.5 : 1) * R(b.c); return done('EMA20', i + 1); }
  }
  const last = bars[bars.length - 1].c;
  return { r: round(r + (half ? 0.5 : 1) * R(last) - costR), why: '持有中', open: true, half, n: bars.length };
}
const round = v => Math.round(v * 100) / 100;

/** 一組結果的統計：{ n, avg, win, med } */
export function ruleStats(list) {
  const r = list.filter(v => v != null && isFinite(v));
  if (!r.length) return { n: 0 };
  const s = [...r].sort((a, b) => a - b), m = s.length;
  return {
    n: m, avg: round(r.reduce((a, b) => a + b, 0) / m),
    win: Math.round(r.filter(v => v > 0).length / m * 1000) / 10,
    med: round(m % 2 ? s[(m - 1) / 2] : (s[m / 2 - 1] + s[m / 2]) / 2)
  };
}
