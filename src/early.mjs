/* ============================================================
   盤中預警（Issue「盤中預警」）
   1. 預警：整點收盤後，還沒到正式爆量、但「比前一根 ≥ 2 倍」或「同時段 ≥ 2 倍」的標的。
      每小時一則 Telegram 摘要（列前 maxLines 檔），完整清單在網頁與 Issue。
   2. 盤中推算：每小時第 15、30、45 分，用進行中那根 1H K 的已成交量推算整根量，
      套用正式爆量的門檻（自選用自選門檻）。只有 OKX、Bitget（Bybit 只能在整點用 WebSocket 抓）。
   正式爆量通知會註明「第 N 分已推算通知」「N 小時前已預警」。
   ============================================================ */
import zlib from 'node:zlib';
import { tpe, fmtP } from './tracker.mjs';
import {
  HOURLY, isAnomaly, isRamp, preKind, crossVenue, groupByBase, weekendClosed, hourStats, order,
  money, hhmm, alink, kind, othersLine, VL, CAT
} from './hourly.mjs';

const H = 3600e3;
export const EARLY = {
  preKeepHours: 12,        // 預警保留幾小時（也是「N 小時前已預警」往回找的範圍）
  preDedupHours: 6,        // 同一家同一檔幾小時內只列一次預警，除非倍數再翻 preReMult 倍
  preReMult: 2,
  preMaxLines: 10,         // Telegram 摘要列幾檔
  earlyKeepHours: 24,      // 盤中推算保留幾小時
  minMinutes: 10,          // 進行中的 K 至少走了幾分鐘才推算
  lastMinute: 48,          // 第 48 分之後不跑（整點的正式判斷馬上要開始）
  /* 已經漲過／跌過：這根之前 24 小時的漲跌幅 ≥ 日 ATR × moveAtr 就不推播（網頁照列並標記）；這根自己在拉的不算 */
  moveAtr: 1,
  atrDays: 7,              // 日 ATR 用近幾天（以 1H K 合成 24 小時區間）
  /* 2026-11 OKX 3 天實測：推算達正式門檻後，整根真的成為正式爆量的比例 */
  precision: { 15: 47, 30: 67, 45: 83 }
};

export function emptyPre() { return { version: 1, pre: [], preLast: {}, early: [], earlyLast: {}, lastSlot: null, lastPreHour: null }; }

/** 第幾分的推算（15／30／45）；太早或太晚回傳 null */
export function slotOf(nowMs, cfg = EARLY) {
  const min = Math.floor((nowMs % H) / 60e3);
  if (min < cfg.minMinutes || min >= cfg.lastMinute) return null;
  return min >= 40 ? 45 : min >= 25 ? 30 : 15;
}

/** 把進行中的 1H K 換算成整根量，接在已收盤的 K 後面 */
export function projectBars(bars, live, atMs, cfg = EARLY) {
  if (!live || !(live.qv > 0)) return null;
  const frac = (atMs - live.t) / H;
  if (!(frac >= cfg.minMinutes / 60)) return null;            /* 太早推算，倍數會失真 */
  const f = Math.min(1, frac);
  return { bars: [...bars.filter(b => b.t < live.t), { t: live.t, o: live.o, h: live.h, l: live.l, c: live.c, qv: live.qv / f }], frac: f };
}

/** 預警與盤中推算的查詢：給正式爆量加註用 */
export function preContext(pstate, T, cfg = EARLY) {
  return {
    earlyOf: key => { const e = pstate.earlyLast[key]; return e && e.t === T && !e.moved ? e : null; },
    /* 12 小時內最早一次預警：{ t, price }（price＝預警那根 1H 收盤價） */
    preOf: key => {
      const ps = pstate.pre.filter(p => `${p.venue}:${p.sym}` === key && p.t < T && p.t >= T - cfg.preKeepHours * H);
      if (!ps.length) return null;
      const p = ps.reduce((a, b) => (b.t < a.t ? b : a));
      return { t: p.t, price: p.price ?? null };
    }
  };
}

const preScore = p => Math.max(p.xp ?? 0, p.x1);
const preOrder = (a, b) => (b.watch - a.watch) || (a.closed - b.closed) || preScore(b) - preScore(a);

/**
 * 整點收盤後：還沒到正式爆量／連續放量的標的，達預警門檻就列入
 * entries 同 pickAlerts；回傳本小時新增的預警
 */
export function pickPre(pstate, entries, T, cfg = HOURLY, ecfg = EARLY) {
  const added = [];
  for (const e of entries) {
    const w = !!e.watch;
    if (isAnomaly(e.stats, e.cat, cfg, w) || isRamp(e.stats, e.cat, cfg, w)) continue;
    const c = preKind(e.stats, e.cat, cfg, w);
    if (!c) continue;
    const key = `${e.venue}:${e.sym}`;
    const s = Math.max(e.stats.xp ?? 0, e.stats.x1);
    const pl = pstate.preLast[key];
    if (pl && T - pl.t < ecfg.preDedupHours * H && s < pl.s * ecfg.preReMult) continue;
    added.push({
      t: T, venue: e.venue, sym: e.sym, base: e.base, cat: e.cat, c,
      xp: e.stats.xp == null ? null : +e.stats.xp.toFixed(1), x1: +e.stats.x1.toFixed(1), x2: +e.stats.x2.toFixed(1),
      qv: Math.round(e.stats.qv), chg: +(e.stats.chg * 100).toFixed(2), price: e.stats.price,
      watch: w, closed: weekendClosed(T, e.cat)
    });
    pstate.preLast[key] = { t: T, s };
  }
  added.sort(preOrder);
  pstate.pre = [...added, ...pstate.pre].filter(p => T - p.t < ecfg.preKeepHours * H);
  for (const k of Object.keys(pstate.preLast)) if (T - pstate.preLast[k].t > ecfg.preKeepHours * H) delete pstate.preLast[k];
  pstate.lastPreHour = T;
  return added;
}

/**
 * 盤中推算：entries 的 stats 用推算後的整根量算（qvNow＝目前已成交）
 * hstate.last：正式爆量的去重（12 小時內通知過就要量再翻倍）
 */
export function pickEarly(pstate, hstate, entries, T, minute, cfg = HOURLY, ecfg = EARLY) {
  const byBase = groupByBase(entries);
  const alerts = [];
  for (const e of entries) {
    if (!isAnomaly(e.stats, e.cat, cfg, !!e.watch)) continue;
    const key = `${e.venue}:${e.sym}`;
    const f = hstate.last[key];
    if (f && T - f.t < cfg.dedupHours * H && e.stats.x1 < f.x1 * cfg.reAlertMult) continue;
    const moved = movedOf(e.stats.move, ecfg);
    const el = pstate.earlyLast[key];
    /* 同一小時已列過：量沒翻倍就不重複；之前是「已漲過／跌過」、現在回到剛開始動的照常推播 */
    if (el && el.t === T && e.stats.x1 < el.x1 * cfg.reAlertMult && (!el.moved || moved)) continue;
    const mv = e.stats.move;
    alerts.push({
      t: T, min: minute, venue: e.venue, sym: e.sym, base: e.base, cat: e.cat,
      x1: +e.stats.x1.toFixed(1), x2: +e.stats.x2.toFixed(1), qv: Math.round(e.stats.qv), qvNow: Math.round(e.stats.qvNow ?? 0),
      chg: +(e.stats.chg * 100).toFixed(2), price: e.stats.price, watch: !!e.watch, closed: weekendClosed(T, e.cat),
      ...(mv ? { chg24: +mv.chg24.toFixed(1), atrp: +mv.atrp.toFixed(1) } : {}),
      ...(moved ? { moved } : {}),
      ...crossVenue(e, byBase, cfg)
    });
    const pushedBefore = el && el.t === T && !el.moved;
    pstate.earlyLast[key] = { t: T, x1: e.stats.x1, min: pushedBefore ? el.min : minute, ...(moved && !pushedBefore ? { moved } : {}) };
  }
  alerts.sort(order);
  pstate.early = [...alerts, ...pstate.early].filter(a => T - a.t < ecfg.earlyKeepHours * H);
  for (const k of Object.keys(pstate.earlyLast)) if (T - pstate.earlyLast[k].t > ecfg.earlyKeepHours * H) delete pstate.earlyLast[k];
  pstate.lastSlot = `${T}:${minute}`;
  return alerts;
}

/**
 * 這根之前 24 小時的漲跌幅與日 ATR%：
 * 漲跌幅＝這根 1H K 開盤 ÷ 24 小時前那根開盤（這根正在拉的不算，照樣通知）；
 * 日 ATR 用 1H K 合成近 atrDays 個 24 小時區間的真實波幅平均
 */
export function moveOf(bars, live, ecfg = EARLY) {
  const m = new Map(bars.map(b => [b.t, b]));
  const ref = m.get(live.t - 24 * H);
  if (!ref || !(ref.o > 0) || !(live.o > 0)) return null;
  const trs = [];
  for (let d = 0; d < ecfg.atrDays; d++) {
    const end = live.t - d * 24 * H, hs = [];
    for (let k = 1; k <= 24; k++) { const b = m.get(end - k * H); if (b) hs.push(b); }
    const prev = m.get(end - 25 * H);
    if (hs.length < 20 || !prev) continue;
    const hi = Math.max(prev.c, ...hs.map(b => b.h)), lo = Math.min(prev.c, ...hs.map(b => b.l)), c = hs[0].c;
    if (c > 0) trs.push((hi - lo) / c * 100);
  }
  if (trs.length < 3) return null;
  return { chg24: (live.o / ref.o - 1) * 100, atrp: trs.reduce((p, x) => p + x, 0) / trs.length };
}

/** 推算用：已收盤的 1H K＋進行中那根，算出推算後的倍數，以及近 24 小時漲跌與日 ATR */
export function earlyStats(bars, live, atMs, cat) {
  const p = projectBars(bars, live, atMs);
  if (!p) return null;
  const st = hourStats(p.bars, live.t, cat);
  return st ? { ...st, qvNow: live.qv, frac: p.frac, move: moveOf(bars, live) } : null;
}

/** 'up'＝已漲過、'down'＝已跌過、null＝剛開始動或資料不足（資料不足照常推播） */
export function movedOf(mv, ecfg = EARLY) {
  if (!mv || !(mv.atrp > 0)) return null;
  if (mv.chg24 >= mv.atrp * ecfg.moveAtr) return 'up';
  if (mv.chg24 <= -mv.atrp * ecfg.moveAtr) return 'down';
  return null;
}

/* ---------------- 文字 ---------------- */
const sx = v => (v == null ? '—' : `${v}x`);
const pcs = v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
const PRE_C = { A: '比前一根', B: '同時段', AB: '前一根＋同時段' };

export function preAlertText(added, T, url = '', ecfg = EARLY) {
  if (!added.length) return '';
  const L = [`【預警】${tpe(T).slice(5, 10)} ${hhmm(T)}–${hhmm(T + H)} 台灣時間（${added.length} 檔，比前一根 ≥2x 或同時段 ≥2x，還沒到正式爆量）`];
  added.slice(0, ecfg.preMaxLines).forEach(p => L.push(
    `${p.watch ? '【自選】' : ''}${p.closed ? '【週末休市】' : ''}${alink(p)}［${CAT[p.cat] || p.cat}］${VL[p.venue]} 前一根 ${sx(p.xp)}／同時段 ${sx(p.x1)}｜1H ${pcs(p.chg)}｜${money(p.qv)}｜價 ${p.price ? fmtP(p.price) : '—'}`));
  if (added.length > ecfg.preMaxLines) L.push(`另有 ${added.length - ecfg.preMaxLines} 檔，見網頁「盤中爆量」分頁`);
  L.push('約 3 成正式爆量在前 1 小時會先出現預警；沒升級的多半是雜訊');
  if (url) L.push(url);
  return L.join('\n');
}

const MOVED = { up: '已漲過', down: '已跌過' };
/** all 含已漲過／跌過的；那些不推播，只在最後註明幾檔 */
export function earlyAlertText(all, T, minute, url = '', ecfg = EARLY) {
  const alerts = all.filter(a => !a.moved), skipped = all.length - alerts.length;
  if (!alerts.length) return '';
  const L = [`【盤中推算】${tpe(T).slice(5, 10)} ${hhmm(T)}–${hhmm(T + H)} 台灣時間，第 ${minute} 分（${alerts.length} 檔；依已成交量推算整根）`];
  alerts.forEach(a => {
    L.push(`${a.watch ? '【自選】' : ''}${a.closed ? '【週末休市】' : ''}${alink(a)}［${CAT[a.cat] || a.cat}］${kind(a)} ★推算 ${a.x1}x 同時段／${a.x2}x 近48h`);
    L.push(`  價格 ${a.price ? fmtP(a.price) : '—'}（這根目前 ${pcs(a.chg)}${a.chg24 != null ? `，前24h ${pcs(a.chg24)}／日ATR ${a.atrp}%` : ''}）｜已成交 ${money(a.qvNow)}，推算整根 ${money(a.qv)}`);
    L.push(`  ${othersLine(a)}`);
  });
  const p = ecfg.precision[minute];
  if (p) L.push(`第 ${minute} 分推算達標的，實測約 ${p}% 收盤後真的成為正式爆量（只有 OKX、Bitget）`);
  if (skipped) L.push(`另有 ${skipped} 檔這根之前 24h 已漲過或跌過（≥ ${ecfg.moveAtr} 倍日 ATR），不推播，只列在網頁`);
  if (url) L.push(url);
  return L.join('\n');
}

export function preMarkdown(pstate, { nowMs, warnings = [], note = '', rows = 120 }, cfg = HOURLY, ecfg = EARLY) {
  const L = [`# 盤中預警｜更新 ${tpe(nowMs)} 台灣時間`, ''];
  L.push(`- **盤中推算**：每小時第 15、30、45 分，用進行中那根 1H K 的已成交量推算整根量，達正式爆量門檻（同時段 ${cfg.minSameHourX} 倍、近 48 小時 ${cfg.minRecentX} 倍、成交額下限）就推播。只有 OKX、Bitget。這根之前 24 小時已漲過或跌過（≥ ${ecfg.moveAtr} 倍日 ATR）的標【已漲過】【已跌過】，不推播只列在這裡；這根自己正在拉的照樣推播。`);
  L.push(`- **預警**：整點收盤後，比前一根 ≥ ${cfg.pre.prevX} 倍或同時段 ≥ ${cfg.pre.sameX} 倍、但還沒到正式爆量。每小時一則摘要；同一家同一檔 ${ecfg.preDedupHours} 小時內只列一次。`);
  if (note) { L.push(''); L.push(note); }
  const early = pstate.early.slice(0, rows), pre = pstate.pre.slice(0, rows);
  L.push('', `## 盤中推算（最近 ${ecfg.earlyKeepHours} 小時，${pstate.early.length} 筆）`);
  if (early.length) {
    L.push('| 時間 | 第幾分 | 標的 | 交易所 | 推算同時段 | 推算近48h | 已成交 | 推算整根 | 當時漲跌 |', '|---|---|---|---|---|---|---|---|---|');
    early.forEach(a => L.push(`| ${tpe(a.t).slice(5, 16)} | ${a.min} | ${a.moved ? `【${MOVED[a.moved]}】` : ''}${a.watch ? '【自選】' : ''}${alink(a)}［${CAT[a.cat] || a.cat}］ | ${kind(a)} | ${a.x1}x | ${a.x2}x | ${money(a.qvNow)} | ${money(a.qv)} | ${pcs(a.chg)} |`));
  } else L.push('無');
  L.push('', `## 預警（最近 ${ecfg.preKeepHours} 小時，${pstate.pre.length} 筆）`);
  if (pre.length) {
    L.push('| 時間 | 標的 | 交易所 | 條件 | 比前一根 | 同時段 | 近48h | 成交額 | 1H 漲跌 | 預警價 |', '|---|---|---|---|---|---|---|---|---|---|');
    pre.forEach(p => L.push(`| ${tpe(p.t).slice(5, 16)} | ${p.watch ? '【自選】' : ''}${p.closed ? '【週末休市】' : ''}${alink(p)}［${CAT[p.cat] || p.cat}］ | ${VL[p.venue]} | ${PRE_C[p.c] || p.c} | ${sx(p.xp)} | ${p.x1}x | ${p.x2}x | ${money(p.qv)} | ${pcs(p.chg)} | ${p.price ? fmtP(p.price) : '—'} |`));
  } else L.push('無');
  if (pstate.early.length > rows || pstate.pre.length > rows) L.push('', `（表格各只列最近 ${rows} 筆，完整紀錄在網頁）`);
  if (warnings.length) { L.push(''); L.push(`## 資料警告（${warnings.length}）`); warnings.slice(0, 20).forEach(w => L.push(`- ${w}`)); }
  L.push('', '> 規則式篩選，不是投資建議。');
  return L.join('\n');
}

const MA = '<!-- PRE_STATE', MB = 'PRE_STATE -->';
export function embedPre(md, state) {
  return `${md}\n\n${MA}\n${zlib.gzipSync(Buffer.from(JSON.stringify(state))).toString('base64')}\n${MB}\n`;
}
export function extractPre(body) {
  if (!body) return emptyPre();
  const a = body.indexOf(MA), b = body.indexOf(MB);
  if (a < 0 || b < 0) return emptyPre();
  try { return { ...emptyPre(), ...JSON.parse(zlib.gunzipSync(Buffer.from(body.slice(a + MA.length, b).trim(), 'base64')).toString('utf8')) }; }
  catch { return null; }
}
export function preBody(state, opts, render = x => x, cfg = HOURLY, ecfg = EARLY, limit = 60000) {
  let rows = 120, out;
  for (;;) {
    out = embedPre(render(preMarkdown(state, { ...opts, rows }, cfg, ecfg)), state);
    if (out.length <= limit || rows === 0) return out;
    rows = rows > 20 ? rows - 20 : 0;
  }
}
