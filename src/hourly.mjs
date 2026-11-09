/* ============================================================
   盤中爆量（1H）：OKX／Bitget／Bybit 三家分開算
   某一根剛收盤的 1H K 成交額同時滿足：
     - ≥ 過去 7 天「同一個小時」中位數的 minSameHourX 倍（避開美股開盤等固定時段的放量）
     - ≥ 最近 48 小時平均的 minRecentX 倍
     - ≥ 每小時成交額下限
   就推播。同一家同一檔 dedupHours 小時內只通知一次，除非量再翻 reAlertMult 倍。
   另外兩種：
     - 連續放量：連續 4 根逐根放大，最近 3 根合計 ≥ 近 48 小時平均 3 根量的 ramp.cumX 倍 → 照常推播
     - 預警：比前一根 ≥ pre.prevX 倍，或同時段 ≥ pre.sameX 倍（還沒到正式爆量）→ 每小時一則摘要（early.mjs）
   ============================================================ */
import { avgRangePct, quietHour } from './quiet.mjs';
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
  /* 連續放量：2026-11 OKX 5 天實測，沒升級成正式爆量的這類，之後 12h 波動中位數 4.7%（隨機 3.1%、正式爆量 5.3%） */
  ramp: { cumX: 2, floorMult: 1.5 },
  /* 預警：約 3 成正式爆量的前 1 小時已達這個門檻（隨機時點約 1 成）；沒升級的資訊量接近隨機 */
  pre: { prevX: 2, sameX: 2 },
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

/* 量增價平標記：quiet、門檻 qlim（%）、平常振幅 rng（%） */
function quietOf(chgPct, rng, cat) { const q = quietHour(chgPct, rng ?? null, cat); return { quiet: q.quiet, qlim: q.lim, rng: q.rng }; }

export function emptyHourly() { return { version: 1, last: {}, recent: [], lastHour: null }; }

/**
 * bars：該交易所該合約的 1H K（已收盤，任意順序），T：要評估的那一小時開始時間
 * 回傳 { x1, x2, qv, chg } 或 null（資料不足）
 */
/* 過去 7 天同一小時的成交額（股票合約週末幾乎沒量，平日要跟平日比） */
function sameHour(m, T, cat, cfg) {
  let same = [];
  for (let k = 1; k <= cfg.sameHourDays; k++) { const b = m.get(T - k * D); if (b) same.push({ t: b.t, qv: b.qv }); }
  if (cat === 'stock') {
    const typed = same.filter(x => isWeekend(x.t) === isWeekend(T));
    if (typed.length >= cfg.minSameSamples) same = typed;
  }
  return same;
}

export function hourStats(bars, T, cat, cfg = HOURLY) {
  const m = new Map(bars.map(b => [b.t, b]));
  const cur = m.get(T);
  if (!cur) return null;
  const same = sameHour(m, T, cat, cfg);
  if (same.length < cfg.minSameSamples) return null;
  const recent = bars.filter(b => b.t >= T - cfg.recentHours * H && b.t < T);
  if (recent.length < cfg.minRecentSamples) return null;
  const med = median(same.map(x => x.qv));
  const mean = recent.reduce((s, b) => s + b.qv, 0) / recent.length;
  /* 冷門時段（例如股票合約在亞洲時段）基準量趨近 0，倍數會失真到上千倍；設基準下限 */
  const floor = Math.max(1, (cfg.floorQvHour[cat] ?? cfg.floorQvHour.crypto) * cfg.minBaseRatio);
  /* 比前一根；連續放量（4 根逐根放大）時算最近 3 根合計對近 48h 平均的倍數 */
  const b1 = m.get(T - H), b2 = m.get(T - 2 * H), b3 = m.get(T - 3 * H);
  const xp = b1 ? cur.qv / Math.max(b1.qv, floor) : null;
  let cx = null, cum = null, cxs = null;
  if (b1 && b2 && b3 && cur.qv > b1.qv && b1.qv > b2.qv && b2.qv > b3.qv) {
    cum = cur.qv + b1.qv + b2.qv;
    cx = cum / Math.max(3 * mean, 3 * floor);
    /* 跟這 3 個小時「平常」的量比：低於 2 倍代表這個時段每天都會放量（時段性） */
    const meds = [T, T - H, T - 2 * H].map(t => { const s = sameHour(m, t, cat, cfg); return s.length >= cfg.minSameSamples ? median(s.map(x => x.qv)) : null; });
    if (meds.every(x => x != null)) cxs = cum / meds.reduce((p, x) => p + Math.max(x, floor), 0);
  }
  return {
    xp, cx, cum, cxs,
    x1: cur.qv / Math.max(med, floor), x2: cur.qv / Math.max(mean, floor),
    qv: cur.qv, chg: cur.o > 0 ? cur.c / cur.o - 1 : 0, price: cur.c,
    rng: avgRangePct(bars, T)          /* 近 7 天平均 1H 振幅 %（量增價平用；Bybit 沒有歷史高低為 null） */
  };
}

export function isAnomaly(st, cat, cfg = HOURLY, watch = false) {
  if (!st) return false;
  if (watch) return st.x1 >= cfg.watch.minSameHourX && st.x2 >= cfg.watch.minRecentX && st.qv >= cfg.watch.floorQvHour;
  return st.x1 >= cfg.minSameHourX && st.x2 >= cfg.minRecentX && st.qv >= (cfg.floorQvHour[cat] ?? cfg.floorQvHour.crypto);
}

const floorOf = (cat, cfg, watch) => watch ? cfg.watch.floorQvHour : (cfg.floorQvHour[cat] ?? cfg.floorQvHour.crypto);
export function isRamp(st, cat, cfg = HOURLY, watch = false) {
  return !!st && st.cx != null && st.cx >= cfg.ramp.cumX && st.cum >= floorOf(cat, cfg, watch) * cfg.ramp.floorMult;
}
/** 預警條件：A＝比前一根、B＝同時段；回傳 'A'／'B'／'AB'，不成立回傳 '' */
export function preKind(st, cat, cfg = HOURLY, watch = false) {
  if (!st || !(st.qv >= floorOf(cat, cfg, watch))) return '';
  return ((st.xp ?? 0) >= cfg.pre.prevX ? 'A' : '') + (st.x1 >= cfg.pre.sameX ? 'B' : '');
}

/** 同一檔其他交易所的倍數、是否只有一家爆量 */
export function crossVenue(e, byBase, cfg = HOURLY) {
  const others = (byBase.get(e.base) || []).filter(o => o.venue !== e.venue);
  return {
    others: Object.fromEntries(others.map(o => [o.venue, +o.stats.x1.toFixed(1)])),
    spikedOthers: others.filter(o => isAnomaly(o.stats, o.cat, cfg, !!o.watch)).map(o => o.venue),
    single: others.length > 0 && others.every(o => o.stats.x1 < cfg.quietX)
  };
}
export const groupByBase = entries => {
  const m = new Map();
  for (const e of entries) { const a = m.get(e.base) || []; a.push(e); m.set(e.base, a); }
  return m;
};

/**
 * entries：[{ venue, sym, base, cat, stats }]（同一小時、三家所有算得出 stats 的合約）
 * ctx（選填）：earlyOf(key) → 同一小時盤中推算已通知的 { min }；preOf(key) → 12 小時內最早一次預警的時間
 * 回傳本輪要通知的事件（正式爆量＋連續放量），並更新 state.last／state.recent
 */
export function pickAlerts(state, entries, T, cfg = HOURLY, ctx = {}) {
  const byBase = groupByBase(entries);
  const alerts = [];
  for (const e of entries) {
    const spike = isAnomaly(e.stats, e.cat, cfg, !!e.watch);
    const ramp = isRamp(e.stats, e.cat, cfg, !!e.watch);
    if (!spike && !ramp) continue;
    const key = `${e.venue}:${e.sym}`;
    const prev = state.last[key];
    if (prev && T - prev.t < cfg.dedupHours * H) {
      /* 已通知過：正式爆量要量再翻倍；只有連續放量時，累積倍數要再翻倍 */
      const again = spike ? e.stats.x1 >= prev.x1 * cfg.reAlertMult : (prev.cx != null && e.stats.cx >= prev.cx * cfg.reAlertMult);
      if (!again) continue;
    }
    const early = ctx.earlyOf ? ctx.earlyOf(key) : null;
    const preT = ctx.preOf ? ctx.preOf(key) : null;
    alerts.push({
      t: T, venue: e.venue, sym: e.sym, base: e.base, cat: e.cat,
      x1: +e.stats.x1.toFixed(1), x2: +e.stats.x2.toFixed(1), qv: Math.round(e.stats.qv), chg: +(e.stats.chg * 100).toFixed(2),
      price: e.stats.price, watch: !!e.watch, closed: weekendClosed(T, e.cat),
      ...crossVenue(e, byBase, cfg),
      ...(ramp ? { ramp: true, cx: +e.stats.cx.toFixed(1), ...(e.stats.cxs != null && e.stats.cxs < cfg.ramp.cumX && e.stats.x1 < cfg.pre.sameX ? { season: true } : {}) } : {}),
      ...(spike ? {} : { rampOnly: true }),
      ...(early ? { earlyMin: early.min } : {}),
      ...(preT != null && preT < T ? { preH: Math.round((T - preT) / H) } : {}),
      ...quietOf(e.stats.chg * 100, e.stats.rng, e.cat)
    });
    state.last[key] = { t: T, x1: e.stats.x1, ...(ramp ? { cx: e.stats.cx } : {}) };
  }
  alerts.sort(order);
  state.recent = [...alerts, ...state.recent].filter(a => T - a.t < cfg.keepHours * H);
  for (const k of Object.keys(state.last)) if (T - state.last[k].t > cfg.keepHours * H) delete state.last[k];
  state.lastHour = T;
  return alerts;
}

export const order = (a, b) => (b.watch - a.watch) || ((b.quiet || false) - (a.quiet || false)) || (a.closed - b.closed) || ((a.season || false) - (b.season || false)) || ((a.rampOnly || false) - (b.rampOnly || false)) || (b.single - a.single) || b.x1 - a.x1;

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
export const money = v => v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${(v / 1e3).toFixed(0)}K`;
export const hhmm = t => tpe(t).slice(11, 16);
export const alink = a => link(a.base, tvUrl(a.venue, a.sym, '60'));
export { VL, CAT };
/* 標籤：【連續放量】、盤中推算已通知、幾小時前預警 */
export function tagsOf(a) {
  return `${a.quiet ? '【量增價平】' : ''}${a.watch ? '【自選】' : ''}${a.ramp ? '【連續放量】' : ''}${a.season ? '【時段性】' : ''}${a.closed ? '【週末休市】' : ''}`;
}
export function noteOf(a) {
  const n = [];
  if (a.earlyMin) n.push(`第 ${a.earlyMin} 分已推算通知`);
  if (a.preH) n.push(`${a.preH} 小時前已預警`);
  return n.join('｜');
}
const xLine = a => a.rampOnly
  ? `連續 4 根放大，3 根累積 ${a.cx}x 近48h（同時段 ${a.x1}x）`
  : `★${a.x1}x 同時段／${a.x2}x 近48h${a.ramp ? `｜連續放量 ${a.cx}x` : ''}`;
export function kind(a) {
  if (a.single) return `只有 ${VL[a.venue]}`;
  if (a.spikedOthers.length) return `${[a.venue, ...a.spikedOthers].map(v => VL[v]).join('＋')} 同時`;
  return VL[a.venue];
}
export function othersLine(a) {
  const ks = Object.keys(a.others);
  return ks.length ? ks.map(v => `${VL[v]} ${a.others[v]}x`).join('｜') : '其他家無此合約或資料不足';
}

export function hourlyAlertText(alerts, T, warnings = [], url = '', cfg = HOURLY) {
  if (!alerts.length) return '';
  alerts = mergeByBase(alerts);
  const L = [`【盤中爆量】${tpe(T).slice(5, 10)} ${hhmm(T)}–${hhmm(T + H)} 台灣時間（${alerts.length} 檔）`];
  alerts.slice(0, cfg.maxLines).forEach(a => {
    L.push(`${tagsOf(a)}${alink(a)}［${CAT[a.cat] || a.cat}］${kind(a)} ${xLine(a)}`);
    const qv = a.also ? [a, ...a.also].map(x => `${VL[x.venue]} ${money(x.qv)}`).join('＋') : money(a.qv);
    L.push(`  價格 ${a.price ? fmtP(a.price) : '—'}（1H ${a.chg >= 0 ? '+' : ''}${a.chg.toFixed(1)}%）｜成交額 ${qv}`);
    L.push(`  ${othersLine(a)}`);
    const nt = noteOf(a);
    if (nt) L.push(`  ${nt}`);
  });
  if (alerts.some(a => a.closed)) L.push('【週末休市】＝標的現貨市場休市中，成交多半集中在少數交易所，訊號可靠度較低');
  if (alerts.some(a => a.rampOnly)) L.push('【連續放量】＝每根都沒到爆量門檻，但連續放大、累積量已大');
  if (alerts.some(a => a.season)) L.push('【時段性】＝這幾個小時平常每天也會放量（累積量、當根都未達同時段 2 倍），可靠度較低');
  if (alerts.length > cfg.maxLines) L.push(`另有 ${alerts.length - cfg.maxLines} 檔，見清單頁`);
  if (warnings.length) L.push(`資料警告：${warnings.join('；')}`);
  if (url) L.push(url);
  return L.join('\n');
}

export function hourlyMarkdown(state, { nowMs, warnings = [], note = '', rows = 200 }, cfg = HOURLY) {
  const L = [`# 盤中爆量｜更新 ${tpe(nowMs)} 台灣時間`, ''];
  L.push(`OKX、Bitget、Bybit 三家分開算。剛收盤的 1H K 成交額 ≥ 過去 7 天同一小時中位數 ${cfg.minSameHourX} 倍、≥ 近 48 小時平均 ${cfg.minRecentX} 倍，且達每小時成交額下限（加密 ${cfg.floorQvHour.crypto / 1e4} 萬、股票 ${cfg.floorQvHour.stock / 1e4} 萬、商品 ${cfg.floorQvHour.comm / 1e4} 萬 USDT）就列出。`);
  L.push(`同一家同一檔 ${cfg.dedupHours} 小時內只通知一次，除非量再翻 ${cfg.reAlertMult} 倍。股票合約平日只跟平日比。`);
  L.push(`【自選】標的不受成交額下限限制，門檻放寬為同時段 ${cfg.watch.minSameHourX} 倍、近 48 小時 ${cfg.watch.minRecentX} 倍。`);
  L.push(`【連續放量】＝連續 4 根逐根放大，最近 3 根合計 ≥ 近 48 小時平均的 ${cfg.ramp.cumX} 倍（每根不一定到爆量門檻）；累積量與當根都未達同時段 2 倍的加【時段性】。盤中推算與預警在「盤中預警」Issue。`);
  if (note) { L.push(''); L.push(note); }
  L.push('');
  L.push(`## 最近 ${cfg.keepHours} 小時（${state.recent.length}）`);
  if (state.recent.length) {
    L.push('| 時間 | 標的 | 交易所 | 同時段倍數 | 近48h倍數 | 收盤價 | 1H 漲跌 | 成交額 | 其他家同時段 |');
    L.push('|---|---|---|---|---|---|---|---|---|');
    state.recent.slice(0, rows).forEach(a => L.push(
      `| ${tpe(a.t).slice(5, 16)} | ${tagsOf(a).replace('【量增價平】', '')}${alink(a)}［${CAT[a.cat] || a.cat}］ | ${kind(a)} | ${a.x1}x | ${a.x2}x | ${a.price ? fmtP(a.price) : '—'} | ${a.chg >= 0 ? '+' : ''}${a.chg.toFixed(1)}% | ${money(a.qv)} | ${othersLine(a)} |`));
    if (state.recent.length > rows) L.push('', `（只列最近 ${rows} 筆，完整紀錄在網頁）`);
  } else L.push('無');
  if (warnings.length) { L.push(''); L.push(`## 資料警告（${warnings.length}）`); warnings.slice(0, 20).forEach(w => L.push(`- ${w}`)); }
  L.push('');
  L.push('> 規則式篩選，不是投資建議。');
  return L.join('\n');
}

/** Issue 本文上限 65536 字：超過就減少表格列數（狀態完整保留） */
export function hourlyBody(state, opts, render = x => x, cfg = HOURLY, limit = 60000) {
  let rows = 200, out;
  for (;;) {
    out = embedHourly(render(hourlyMarkdown(state, { ...opts, rows }, cfg)), state);
    if (out.length <= limit || rows === 0) return out;
    rows = rows > 40 ? rows - 40 : 0;
  }
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
