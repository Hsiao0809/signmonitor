/* ============================================================
   盤中爆量（1H）：OKX／Bitget／Bybit 三家分開算
   某一根剛收盤的 1H K 成交額同時滿足：
     - ≥ 過去 7 天「同一個小時」中位數的 minSameHourX 倍（避開美股開盤等固定時段的放量）
     - ≥ 最近 48 小時平均的 minRecentX 倍
     - ≥ 每小時成交額下限
   就推播。同一家同一檔 dedupHours 小時內只通知一次，除非量再翻 reAlertMult 倍。
   ============================================================ */
import zlib from 'node:zlib';
import { tpe, fmtP, link, tvUrl } from './tracker.mjs';

export const HOURLY = {
  minSameHourX: 5,
  minRecentX: 3,
  floorQvHour: { crypto: 3e5, stock: 2e5, comm: 2e5 },
  minBaseRatio: 0.2,      // 基準量至少當作「下限 × 0.2」，避免冷門時段基準接近 0 時倍數失真
  sameHourDays: 7,
  minSameSamples: 3,
  recentHours: 48,
  minRecentSamples: 24,
  quietX: 2,              // 其他家同時段倍數都低於這個才算「只有一家」
  dedupHours: 12,
  reAlertMult: 2,
  keepHours: 72,          // Issue 上保留幾小時內的紀錄
  maxLines: 15,
  /* 自選標的：不受流動性下限限制、門檻放寬 */
  watch: { minSameHourX: 3, minRecentX: 2, floorQvHour: 2e4 }
};

const H = 3600e3, D = 24 * H;
const VL = { okx: 'OKX', bitget: 'Bitget', bybit: 'Bybit' };
const CAT = { crypto: '加密', stock: '股票', comm: '商品' };
const median = a => { const s = a.slice().sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const isWeekend = t => { const d = new Date(t).getUTCDay(); return d === 0 || d === 6; };

/* 標的現貨市場週末休市（紐約時間）：股票 週五 20:00（盤後結束）～週一 04:00（盤前開始）；
   商品期貨 週五 17:00～週日 18:00。休市時段的爆量照常通知，只加【週末休市】標記並排在後面。 */
const NYF = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', hour12: false });
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
export function weekendClosed(t, cat) {
  const p = Object.fromEntries(NYF.formatToParts(new Date(t)).map(x => [x.type, x.value]));
  const d = DOW[p.weekday], h = +p.hour % 24;
  if (cat === 'stock') return (d === 5 && h >= 20) || d === 6 || d === 0 || (d === 1 && h < 4);
  if (cat === 'comm') return (d === 5 && h >= 17) || d === 6 || (d === 0 && h < 18);
  return false;
}

export function emptyHourly() { return { version: 1, last: {}, recent: [], lastHour: null }; }

/**
 * bars：該交易所該合約的 1H K（已收盤，任意順序），T：要評估的那一小時開始時間
 * 回傳 { x1, x2, qv, chg } 或 null（資料不足）
 */
export function hourStats(bars, T, cat, cfg = HOURLY) {
  const m = new Map(bars.map(b => [b.t, b]));
  const cur = m.get(T);
  if (!cur) return null;
  let same = [];
  for (let k = 1; k <= cfg.sameHourDays; k++) { const b = m.get(T - k * D); if (b) same.push({ t: b.t, qv: b.qv }); }
  /* 股票合約週末幾乎沒量，平日要跟平日比 */
  if (cat === 'stock') {
    const typed = same.filter(x => isWeekend(x.t) === isWeekend(T));
    if (typed.length >= cfg.minSameSamples) same = typed;
  }
  if (same.length < cfg.minSameSamples) return null;
  const recent = bars.filter(b => b.t >= T - cfg.recentHours * H && b.t < T);
  if (recent.length < cfg.minRecentSamples) return null;
  const med = median(same.map(x => x.qv));
  const mean = recent.reduce((s, b) => s + b.qv, 0) / recent.length;
  /* 冷門時段（例如股票合約在亞洲時段）基準量趨近 0，倍數會失真到上千倍；設基準下限 */
  const floor = Math.max(1, (cfg.floorQvHour[cat] ?? cfg.floorQvHour.crypto) * cfg.minBaseRatio);
  return {
    x1: cur.qv / Math.max(med, floor), x2: cur.qv / Math.max(mean, floor),
    qv: cur.qv, chg: cur.o > 0 ? cur.c / cur.o - 1 : 0, price: cur.c
  };
}

export function isAnomaly(st, cat, cfg = HOURLY, watch = false) {
  if (!st) return false;
  if (watch) return st.x1 >= cfg.watch.minSameHourX && st.x2 >= cfg.watch.minRecentX && st.qv >= cfg.watch.floorQvHour;
  return st.x1 >= cfg.minSameHourX && st.x2 >= cfg.minRecentX && st.qv >= (cfg.floorQvHour[cat] ?? cfg.floorQvHour.crypto);
}

/**
 * entries：[{ venue, sym, base, cat, stats }]（同一小時、三家所有算得出 stats 的合約）
 * 回傳本輪要通知的事件，並更新 state.last／state.recent
 */
export function pickAlerts(state, entries, T, cfg = HOURLY) {
  const byBase = new Map();
  for (const e of entries) { const a = byBase.get(e.base) || []; a.push(e); byBase.set(e.base, a); }
  const alerts = [];
  for (const e of entries) {
    if (!isAnomaly(e.stats, e.cat, cfg, !!e.watch)) continue;
    const key = `${e.venue}:${e.sym}`;
    const prev = state.last[key];
    if (prev && T - prev.t < cfg.dedupHours * H && e.stats.x1 < prev.x1 * cfg.reAlertMult) continue;
    const others = (byBase.get(e.base) || []).filter(o => o.venue !== e.venue);
    const othersX = Object.fromEntries(others.map(o => [o.venue, +o.stats.x1.toFixed(1)]));
    const spikedOthers = others.filter(o => isAnomaly(o.stats, o.cat, cfg, !!o.watch)).map(o => o.venue);
    const single = others.length > 0 && others.every(o => o.stats.x1 < cfg.quietX);
    alerts.push({
      t: T, venue: e.venue, sym: e.sym, base: e.base, cat: e.cat,
      x1: +e.stats.x1.toFixed(1), x2: +e.stats.x2.toFixed(1), qv: Math.round(e.stats.qv), chg: +(e.stats.chg * 100).toFixed(2),
      price: e.stats.price, watch: !!e.watch, closed: weekendClosed(T, e.cat),
      others: othersX, spikedOthers, single
    });
    state.last[key] = { t: T, x1: e.stats.x1 };
  }
  alerts.sort(order);
  state.recent = [...alerts, ...state.recent].filter(a => T - a.t < cfg.keepHours * H);
  for (const k of Object.keys(state.last)) if (T - state.last[k].t > cfg.keepHours * H) delete state.last[k];
  state.lastHour = T;
  return alerts;
}

const order = (a, b) => (b.watch - a.watch) || (a.closed - b.closed) || (b.single - a.single) || b.x1 - a.x1;

/* 同一檔在多家同時爆量時，推播合併成一則：以倍數最高的那家為主，其他家的成交額附在後面 */
export function mergeByBase(alerts) {
  const groups = new Map();
  for (const a of alerts) { const g = groups.get(a.base) || []; g.push(a); groups.set(a.base, g); }
  return [...groups.values()].map(g => {
    if (g.length === 1) return g[0];
    const [main, ...rest] = g.slice().sort((a, b) => b.x1 - a.x1);
    const venues = new Set([main.venue, ...main.spikedOthers, ...rest.map(r => r.venue)]);
    return { ...main, watch: g.some(a => a.watch), single: false, spikedOthers: [...venues].filter(v => v !== main.venue), also: rest };
  }).sort(order);
}

/* ---------------- 文字 ---------------- */
const money = v => v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${(v / 1e3).toFixed(0)}K`;
const hhmm = t => tpe(t).slice(11, 16);
const alink = a => link(a.base, tvUrl(a.venue, a.sym, '60'));
function kind(a) {
  if (a.single) return `只有 ${VL[a.venue]}`;
  if (a.spikedOthers.length) return `${[a.venue, ...a.spikedOthers].map(v => VL[v]).join('＋')} 同時`;
  return VL[a.venue];
}
function othersLine(a) {
  const ks = Object.keys(a.others);
  return ks.length ? ks.map(v => `${VL[v]} ${a.others[v]}x`).join('｜') : '其他家無此合約或資料不足';
}

export function hourlyAlertText(alerts, T, warnings = [], url = '', cfg = HOURLY) {
  if (!alerts.length) return '';
  alerts = mergeByBase(alerts);
  const L = [`【盤中爆量】${tpe(T).slice(5, 10)} ${hhmm(T)}–${hhmm(T + H)} 台灣時間（${alerts.length} 檔）`];
  alerts.slice(0, cfg.maxLines).forEach(a => {
    L.push(`${a.watch ? '【自選】' : ''}${a.closed ? '【週末休市】' : ''}${alink(a)}［${CAT[a.cat] || a.cat}］${kind(a)} ★${a.x1}x 同時段／${a.x2}x 近48h`);
    const qv = a.also ? [a, ...a.also].map(x => `${VL[x.venue]} ${money(x.qv)}`).join('＋') : money(a.qv);
    L.push(`  價格 ${a.price ? fmtP(a.price) : '—'}（1H ${a.chg >= 0 ? '+' : ''}${a.chg.toFixed(1)}%）｜成交額 ${qv}`);
    L.push(`  ${othersLine(a)}`);
  });
  if (alerts.some(a => a.closed)) L.push('【週末休市】＝標的現貨市場休市中，成交多半集中在少數交易所，訊號可靠度較低');
  if (alerts.length > cfg.maxLines) L.push(`另有 ${alerts.length - cfg.maxLines} 檔，見清單頁`);
  if (warnings.length) L.push(`資料警告：${warnings.join('；')}`);
  if (url) L.push(url);
  return L.join('\n');
}

export function hourlyMarkdown(state, { nowMs, warnings = [], note = '' }, cfg = HOURLY) {
  const L = [`# 盤中爆量｜更新 ${tpe(nowMs)} 台灣時間`, ''];
  L.push(`OKX、Bitget、Bybit 三家分開算。剛收盤的 1H K 成交額 ≥ 過去 7 天同一小時中位數 ${cfg.minSameHourX} 倍、≥ 近 48 小時平均 ${cfg.minRecentX} 倍，且達每小時成交額下限（加密 ${cfg.floorQvHour.crypto / 1e4} 萬、股票 ${cfg.floorQvHour.stock / 1e4} 萬、商品 ${cfg.floorQvHour.comm / 1e4} 萬 USDT）就列出。`);
  L.push(`同一家同一檔 ${cfg.dedupHours} 小時內只通知一次，除非量再翻 ${cfg.reAlertMult} 倍。股票合約平日只跟平日比。`);
  L.push(`【自選】標的不受成交額下限限制，門檻放寬為同時段 ${cfg.watch.minSameHourX} 倍、近 48 小時 ${cfg.watch.minRecentX} 倍。`);
  if (note) { L.push(''); L.push(note); }
  L.push('');
  L.push(`## 最近 ${cfg.keepHours} 小時（${state.recent.length}）`);
  if (state.recent.length) {
    L.push('| 時間 | 標的 | 交易所 | 同時段倍數 | 近48h倍數 | 收盤價 | 1H 漲跌 | 成交額 | 其他家同時段 |');
    L.push('|---|---|---|---|---|---|---|---|---|');
    state.recent.slice(0, 200).forEach(a => L.push(
      `| ${tpe(a.t).slice(5, 16)} | ${a.watch ? '【自選】' : ''}${a.closed ? '【週末休市】' : ''}${alink(a)}［${CAT[a.cat] || a.cat}］ | ${kind(a)} | ${a.x1}x | ${a.x2}x | ${a.price ? fmtP(a.price) : '—'} | ${a.chg >= 0 ? '+' : ''}${a.chg.toFixed(1)}% | ${money(a.qv)} | ${othersLine(a)} |`));
  } else L.push('無');
  if (warnings.length) { L.push(''); L.push(`## 資料警告（${warnings.length}）`); warnings.slice(0, 20).forEach(w => L.push(`- ${w}`)); }
  L.push('');
  L.push('> 規則式篩選，不是投資建議。');
  return L.join('\n');
}

const MA = '<!-- HOURLY_STATE', MB = 'HOURLY_STATE -->';
export function embedHourly(md, state) {
  return `${md}\n\n${MA}\n${zlib.gzipSync(Buffer.from(JSON.stringify(state))).toString('base64')}\n${MB}\n`;
}
export function extractHourly(body) {
  if (!body) return emptyHourly();
  const a = body.indexOf(MA), b = body.indexOf(MB);
  if (a < 0 || b < 0) return emptyHourly();
  try { return { ...emptyHourly(), ...JSON.parse(zlib.gunzipSync(Buffer.from(body.slice(a + MA.length, b).trim(), 'base64')).toString('utf8')) }; }
  catch { return null; }
}
