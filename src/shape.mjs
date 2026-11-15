/* ============================================================
   結構標記（只加標記與說明，不改任何偵測門檻、排序、去重，也不刪任何通知）
   用在盤中爆量、預警、盤中推算：這根 1H 相對於「前 7 天（168 根 1H）高低點」的位置。

   | 標記 | 條件 |
   |【下掃收回】| 最低跌破前 7 天低點、收盤收回低點之上，下影 ≥ 這根高低差的 30% |
   |【上掃回落】| 最高突破前 7 天高點、收盤回到高點之下，上影 ≥ 40% |
   |【漲多再噴】| 收盤站上前 7 天高點，且前一根收盤比前 3 天最低已漲 ≥ 25% |
   |【續創高】  | 收盤站上前 7 天高點，前 7 天是上升趨勢（斜率 ≥ +10%、R² ≥ 0.4） |
   |【窄幅突破】| 收盤站上前 7 天高點，前 7 天高低差 ≤ 15% |
   |【突破前高】| 收盤站上前 7 天高點，其他情況 |
   |【跌深再殺】| 收盤跌破前 7 天低點，且前一根收盤比前 3 天最高已跌 ≥ 25% |
   |【爆量跌破】| 收盤跌破前 7 天低點，其他情況 |
   |【區間下緣 N%】| 收盤在前 7 天高低點之間，位置 ≤ 25%（N＝位置，0＝低點、100＝高點） |
   |【區間中段 N%】| 位置 25%～75% |
   |【區間上緣 N%】| 位置 ≥ 75% |
   區間內這三種在回測裡沒有方向優勢，不放回測說明。

   回測（2026-07-23～11-12，Binance 現貨 177 檔 1H，成交額 ≥ 前 48h 中位數 5 倍的 5,215 筆，看之後 72 小時）：
   專案文件「行情分類-爆量訊號後72小時-2026-11-15」。回測的爆量定義與現貨資料跟這裡的訊號不完全相同，
   說明文字裡的數字只當參考，實際成績看網頁「成績」分頁的「結構標記」。
   說明文字只放在「加密、已收盤的盤中爆量」；股票、商品、預警、盤中推算只標結構。
   盤中推算那根還沒收盤，影線還會變，所以不標【下掃收回】【上掃回落】。
   關閉：config/shape.json 的 enabled 改 false，或環境變數 SHAPE_ENABLED=0。
   ============================================================ */
import fs from 'node:fs';

const H = 3600e3;
export const SHAPE = {
  lookback: 168,          /* 前 7 天的 1H K */
  run: 72,                /* 「已漲多／已跌深」看前 3 天 */
  cover: 0.9,             /* 至少要有這個比例的 K 才判斷 */
  narrow: 0.15,
  slope: 0.10, r2: 0.4,
  ran: 0.25,
  lowWick: 0.3, upWick: 0.4,
  edge: 0.25,             /* 區間內：位置 ≤ 25% 算下緣、≥ 75% 算上緣 */
  hot: 10,                /* 這根 1H 漲幅 ≥ 這個 %：說明加「不追」 */
  regime: 0.03            /* BTC 7 天漲跌超過這個比例才算大盤偏強／偏弱（只用來決定要不要顯示某些說明） */
};

export function shapeEnabled(file = new URL('../config/shape.json', import.meta.url)) {
  if (process.env.SHAPE_ENABLED === '0') return false;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).enabled !== false; } catch { return true; }
}
const ON = shapeEnabled();

/**
 * m：Map(開盤時間 → bar{t,o,h,l,c})，T：這根的開盤時間
 * 回傳特徵，沒有高低價（Bybit 成交檔）或歷史不足回傳 null
 */
export function shapeFeat(m, T, cfg = SHAPE) {
  const cur = m.get(T);
  if (!cur || !(cur.h > 0) || !(cur.l > 0) || !(cur.c > 0) || !(cur.o > 0)) return null;
  let hi = -Infinity, lo = Infinity, n = 0, hi3 = -Infinity, lo3 = Infinity;
  const xs = [], ys = [];
  for (let k = 1; k <= cfg.lookback; k++) {
    const b = m.get(T - k * H);
    if (!b || !(b.h > 0) || !(b.l > 0) || !(b.c > 0)) continue;
    n++; if (b.h > hi) hi = b.h; if (b.l < lo) lo = b.l;
    if (k <= cfg.run) { if (b.h > hi3) hi3 = b.h; if (b.l < lo3) lo3 = b.l; }
    xs.push(-k); ys.push(Math.log(b.c));
  }
  const prev = m.get(T - H);
  if (n < cfg.lookback * cfg.cover || !prev || !(prev.c > 0) || !(lo3 > 0) || !(hi3 > 0)) return null;
  /* 前 7 天收盤的對數線性回歸：斜率換算成 7 天漲跌、R² */
  const mx = xs.reduce((p, v) => p + v, 0) / n, my = ys.reduce((p, v) => p + v, 0) / n;
  let sxx = 0, sxy = 0, sst = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); sst += (ys[i] - my) ** 2; }
  const b = sxx ? sxy / sxx : 0;
  let sse = 0;
  for (let i = 0; i < n; i++) sse += (ys[i] - (my + b * (xs[i] - mx))) ** 2;
  const rng = cur.h - cur.l;
  return {
    hi, lo, wid: hi / lo - 1,
    sl: Math.exp(b * cfg.lookback) - 1, r2: sst ? 1 - sse / sst : 0,
    run3: prev.c / lo3 - 1, drop3: prev.c / hi3 - 1,
    uw: rng > 0 ? (cur.h - Math.max(cur.o, cur.c)) / rng : 0,
    lw: rng > 0 ? (Math.min(cur.o, cur.c) - cur.l) / rng : 0,
    h: cur.h, l: cur.l, c: cur.c
  };
}

/** 回傳結構代號或 null。partial：這根還沒收盤（盤中推算），不判斷影線類 */
export function shapeTag(sf, { partial = false, cfg = SHAPE, on = ON } = {}) {
  if (!on || !sf) return null;
  if (!partial) {
    if (sf.l < sf.lo && sf.c > sf.lo && sf.lw >= cfg.lowWick) return 'sl';
    if (sf.h > sf.hi && sf.c < sf.hi && sf.uw >= cfg.upWick) return 'sh';
  }
  if (sf.c > sf.hi) {
    if (sf.run3 >= cfg.ran) return 'cl';
    if (sf.sl >= cfg.slope && sf.r2 >= cfg.r2) return 'tr';
    return sf.wid <= cfg.narrow ? 'nb' : 'wb';
  }
  if (sf.c < sf.lo) return sf.drop3 <= -cfg.ran ? 'pn' : 'bd';
  /* 收在前 7 天高低點之間：依位置分下緣／中段／上緣 */
  const p = posOf(sf);
  if (p == null) return null;
  return p <= cfg.edge ? 'rl' : p >= 1 - cfg.edge ? 'rh' : 'rm';
}
/** 收盤在前 7 天高低點之間的位置（0＝低點、1＝高點）；高低點相同回傳 null */
export const posOf = sf => (sf && sf.hi > sf.lo ? Math.min(1, Math.max(0, (sf.c - sf.lo) / (sf.hi - sf.lo))) : null);
const RANGE = new Set(['rl', 'rm', 'rh']);

export const SHAPE_NAME = { sl: '下掃收回', sh: '上掃回落', cl: '漲多再噴', tr: '續創高', nb: '窄幅突破', wb: '突破前高', pn: '跌深再殺', bd: '爆量跌破', rl: '區間下緣', rm: '區間中段', rh: '區間上緣' };
/* 區間內的三種後面接位置百分比，例如【區間下緣 22%】 */
export const shapeLabel = a => (a.shape && SHAPE_NAME[a.shape] ? `【${SHAPE_NAME[a.shape]}${RANGE.has(a.shape) && a.spos != null ? ` ${a.spos}%` : ''}】` : '');
/** 存進狀態用：前 7 天高、低、收盤在區間的位置 %（訊息與網頁用） */
export const sfOut = sf => { if (!sf) return {}; const p = posOf(sf); return { shi: sf.hi, slo: sf.lo, ...(p == null ? {} : { spos: Math.round(p * 100) }) }; };

/** 大盤狀態：BTC 收盤比 7 天前（取 entries 裡 BTC 的爆發特徵）。只用來決定說明要不要出現，不顯示在訊息裡 */
export function regimeOf(entries, cfg = SHAPE) {
  const e = (entries || []).find(x => x.base === 'BTC' && x.cat === 'crypto' && x.stats && x.stats.bf && x.stats.bf.r7d != null);
  if (!e) return null;
  const r = e.stats.bf.r7d;
  return r > cfg.regime ? 'up' : r < -cfg.regime ? 'down' : 'flat';
}

const BREAK = new Set(['nb', 'wb', 'tr']);
/**
 * 訊息最後的說明：只看加密，同一種結構只寫一行；沒有優勢也沒有風險的不寫
 * alerts：這則訊息實際列出的那幾檔；regime：regimeOf 的結果
 */
export function shapeNotes(alerts, regime = null, cfg = SHAPE) {
  const cr = alerts.filter(a => a.cat === 'crypto' && a.shape);
  const has = k => cr.some(a => a.shape === k);
  const L = [];
  if (has('nb')) L.push('【窄幅突破】回測：72h 內 21% 曾漲 ≥20%、1% 曾跌 ≥20%，多半不是當天發動；42% 是假突破，等回踩突破位再進');
  if (has('wb') || has('tr')) L.push('【突破前高】【續創高】回測：43–47% 是假突破，直接延續約 2 成，等回踩突破位再進');
  if (cr.some(a => BREAK.has(a.shape) && a.chg >= cfg.hot)) L.push(`突破且這根 1H 已漲 ≥${cfg.hot}%：回測 37% 先跌 10%，不追`);
  if (has('cl')) L.push('【漲多再噴】回測：40% 再漲 ≥20%、18% 跌 ≥20%，雙向大波動，不開新倉');
  if (has('sl') && regime === 'down') L.push('【下掃收回】大盤偏弱時回測：51% 先漲 10%、10% 先跌 10%；停損放這根低點下');
  if (has('sh') && regime === 'up') L.push('【上掃回落】大盤偏強時回測：55% 先漲 10%、16% 先跌 10%，上影多半不是出貨');
  if (has('bd')) L.push('【爆量跌破】回測：約 5 成是假跌破、直接續跌約 1 成，不追空；收回跌破位才考慮做多');
  if (has('pn')) L.push('【跌深再殺】回測只有 7 筆：43% 再跌 ≥20%，不接');
  return L;
}
