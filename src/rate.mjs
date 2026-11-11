/* ============================================================
   借幣利率（Issue「借幣利率」）
   OKX 槓桿借幣的市場利率（finance/savings/lending-rate-summary，公開、不用 Key）：
     preRate＝這一小時已定的年化利率，estRate＝下一小時預估的年化利率（1＝100%/年）
   借幣利率由借幣需求決定：某個幣突然變貴，代表有人大量借它（多半是做空或槓桿），只當觀察。
   每小時判斷一次，基準＝前 7 天每小時利率的中位數：
     本小時（preRate 或 estRate 較高者）≥ 基準 3 倍、≥ 年化 50%、比基準多 ≥ 30 個百分點 → 推播
   只有預估值達標的標「預估」（下一小時才定案，可能沒成真）。
   同一幣 24 小時只通知一次；24 小時內利率又比上次通知再翻倍算「再升」，再通知。
   穩定幣不看。Bybit 的借幣利率 API 擋 GitHub Actions 與雲端 IP，所以只有 OKX。
   ============================================================ */
import zlib from 'node:zlib';
import { tpe, fmtP, link, tvUrl } from './tracker.mjs';

const H = 3600e3, D = 24 * H;
export const RATE = {
  baseHours: 168, minBase: 72,   // 至少要有 72 小時紀錄才判斷
  x: 3, minRate: 0.5, minAdd: 0.3,
  coolH: 24, reX: 2,
  keepDays: 7, topN: 40, maxLines: 15
};
/* 穩定幣、法幣、測試幣：不看 */
const STABLE = new Set(['USDT', 'USDC', 'DAI', 'FDUSD', 'TUSD', 'PYUSD', 'USDG', 'USDE', 'USDD', 'USDP', 'BUSD', 'RLUSD', 'USD1', 'EURC', 'EUR', 'EURT', 'USDS', 'GUSD', 'LUSD', 'FRAX', 'USTC', 'SUSDE', 'USDQ']);
export const isStable = c => STABLE.has(c) || /^XTEST/.test(c) || /^TEST/.test(c);

const median = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), n = s.length; return n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2; };

/** hist：{t: rate}；回傳 T 之前 baseHours 內的中位數，紀錄不足回 null */
export function baseline(hist, T, cfg = RATE) {
  const v = Object.keys(hist || {}).map(Number).filter(t => t < T && t >= T - cfg.baseHours * H).map(t => hist[t]);
  return v.length >= cfg.minBase ? median(v) : null;
}

/** 單一幣：{ v, by, x } 或 null（不達標）。by＝'pre'（已定）或 'est'（只有預估達標） */
export function spikeOf(pre, est, base, cfg = RATE) {
  if (base == null) return null;
  const ok = v => v != null && v >= cfg.minRate && v >= cfg.x * base && v - base >= cfg.minAdd;
  const a = ok(pre), b = ok(est);
  if (!a && !b) return null;
  const v = a && b ? Math.max(pre, est) : a ? pre : est;
  return { v, by: a ? 'pre' : 'est', x: v / Math.max(base, 1e-4) };
}

export function emptyRate() { return { version: 1, lastHour: null, events: [], notified: {}, top: [], n: 0 }; }

/**
 * rows：[{ ccy, pre, est }]（本小時 summary）、hist：{ccy: {t: rate}}、px：{ccy: { last, chg }}（OKX 現貨，可缺）
 * 回傳本小時要通知的事件；同時更新 state.top（網頁用：目前倍數最高的幾檔）
 */
export function pickSpikes(state, rows, hist, T, px = {}, cfg = RATE) {
  const out = [], top = [];
  let n = 0;
  for (const r of rows) {
    if (isStable(r.ccy)) continue;
    const base = baseline(hist[r.ccy], T, cfg);
    if (base == null) continue;
    n++;
    const hi = Math.max(r.pre ?? 0, r.est ?? 0);
    const p = px[r.ccy] || {};
    top.push({ ccy: r.ccy, pre: r.pre, est: r.est, base: +base.toPrecision(3), x: +(hi / Math.max(base, 1e-4)).toFixed(1), last: p.last ?? null, chg: p.chg ?? null });
    const s = spikeOf(r.pre, r.est, base, cfg);
    if (!s) continue;
    const prev = state.notified[r.ccy];
    const fresh = !prev || T - prev.t >= cfg.coolH * H;
    const re = !fresh && s.v >= prev.v * cfg.reX;
    if (!fresh && !re) continue;
    out.push({ t: T, ccy: r.ccy, pre: r.pre, est: r.est, base: +base.toPrecision(3), v: s.v, by: s.by, x: +s.x.toFixed(1), re, last: p.last ?? null, chg: p.chg ?? null });
    state.notified[r.ccy] = { t: T, v: s.v };
  }
  out.sort((a, b) => b.x - a.x);
  state.events = [...out, ...state.events].filter(e => T - e.t < cfg.keepDays * D);
  for (const k of Object.keys(state.notified)) if (T - state.notified[k].t > cfg.keepDays * D) delete state.notified[k];
  state.top = top.sort((a, b) => b.x - a.x).slice(0, cfg.topN);
  state.n = n;
  state.lastHour = T;
  return out;
}

/* ---------------- 文字 ---------------- */
export const apr = v => (v == null || !isFinite(v) ? '—' : `${(v * 100).toFixed(v >= 1 ? 0 : 1)}%`);
const pcs = v => (v == null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);
const hhmm = t => tpe(t).slice(11, 16);
const tvOf = ccy => tvUrl('okx', `${ccy}-USDT-SWAP`, '60');

export function rateAlertText(events, T, url = '', cfg = RATE) {
  if (!events.length) return '';
  const L = [`【借幣利率飆高】${tpe(T).slice(5, 10)} ${hhmm(T)} 台灣時間（OKX 槓桿借幣，${events.length} 檔）`];
  events.slice(0, cfg.maxLines).forEach(e => {
    L.push(`${e.by === 'est' ? '【預估】' : ''}${e.re ? '【再升】' : ''}${link(e.ccy, tvOf(e.ccy))} 年化 ${apr(e.v)}（7 天中位數 ${apr(e.base)}，${e.x}x）`);
    L.push(`  本小時 ${apr(e.pre)}｜下一小時預估 ${apr(e.est)}${e.last ? `｜價格 ${fmtP(e.last)}（24h ${pcs(e.chg)}）` : ''}`);
  });
  if (events.length > cfg.maxLines) L.push(`另有 ${events.length - cfg.maxLines} 檔，見網頁`);
  L.push('借幣需求暴增（多半是借來做空或槓桿），方向要看圖判斷；沒有回測，只當觀察');
  if (url) L.push(url);
  return L.join('\n');
}

export function rateMarkdown(state, { nowMs, warnings = [], note = '', rows = 150 }, cfg = RATE) {
  const L = [`# 借幣利率｜更新 ${tpe(nowMs)} 台灣時間`, ''];
  L.push(`OKX 槓桿借幣的市場利率（年化），穩定幣不看。每小時比較「本小時已定利率」與「下一小時預估利率」較高者，跟前 7 天每小時利率的中位數比：`);
  L.push(`- ≥ 中位數 ${cfg.x} 倍、≥ 年化 ${cfg.minRate * 100}%、且比中位數多 ≥ ${cfg.minAdd * 100} 個百分點 → 推播`);
  L.push(`- 只有預估值達標的標「預估」；同一幣 ${cfg.coolH} 小時只通知一次，期間利率再翻倍標「再升」再通知`);
  L.push(`- 紀錄不到 ${cfg.minBase} 小時的幣先不判斷。沒有回測，只當觀察。Bybit 的借幣利率 API 擋雲端 IP，所以只有 OKX。`);
  if (note) { L.push(''); L.push(note); }
  L.push('', `## 最近 ${cfg.keepDays} 天通知（${state.events.length} 筆）`);
  if (state.events.length) {
    L.push('| 時間 | 幣 | 年化 | 7天中位數 | 倍數 | 本小時 | 下一小時預估 | 價格 | 24h |', '|---|---|---|---|---|---|---|---|---|');
    state.events.slice(0, rows).forEach(e => L.push(`| ${tpe(e.t).slice(5, 16)} | ${link(e.ccy, tvOf(e.ccy))}${e.by === 'est' ? '（預估）' : ''}${e.re ? '（再升）' : ''} | ${apr(e.v)} | ${apr(e.base)} | ${e.x}x | ${apr(e.pre)} | ${apr(e.est)} | ${e.last ? fmtP(e.last) : '—'} | ${pcs(e.chg)} |`));
  } else L.push('無');
  L.push('', `## 目前倍數最高（${state.top.length}／${state.n} 檔）`);
  if (state.top.length) {
    L.push('| 幣 | 本小時 | 下一小時預估 | 7天中位數 | 倍數 |', '|---|---|---|---|---|');
    state.top.slice(0, 20).forEach(r => L.push(`| ${r.ccy} | ${apr(r.pre)} | ${apr(r.est)} | ${apr(r.base)} | ${r.x}x |`));
  } else L.push('無');
  if (warnings.length) { L.push(''); L.push(`## 資料警告（${warnings.length}）`); warnings.slice(0, 20).forEach(w => L.push(`- ${w}`)); }
  L.push('', '> 規則式篩選，不是投資建議。');
  return L.join('\n');
}

const MA = '<!-- RATE_STATE', MB = 'RATE_STATE -->';
export function embedRate(md, state) {
  return `${md}\n\n${MA}\n${zlib.gzipSync(Buffer.from(JSON.stringify(state))).toString('base64')}\n${MB}\n`;
}
export function extractRate(body) {
  if (!body) return emptyRate();
  const a = body.indexOf(MA), b = body.indexOf(MB);
  if (a < 0 || b < 0) return emptyRate();
  try { return { ...emptyRate(), ...JSON.parse(zlib.gunzipSync(Buffer.from(body.slice(a + MA.length, b).trim(), 'base64')).toString('utf8')) }; }
  catch { return null; }
}
export function rateBody(state, opts, render = x => x, cfg = RATE, limit = 60000) {
  let rows = 150, out;
  for (;;) {
    out = embedRate(render(rateMarkdown(state, { ...opts, rows }, cfg)), state);
    if (out.length <= limit || rows === 0) return out;
    rows = rows > 30 ? rows - 30 : 0;
  }
}
