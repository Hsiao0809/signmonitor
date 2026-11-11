/* ============================================================
   沉睡甦醒（Issue「沉睡甦醒」）
   OKX、Bitget 都有上架的加密合約，不設流動性門檻，每小時用剛收盤的 1H K 判斷：
     沉睡：前 10 個 UTC 日的價格區間 ≤ 30%
     這根：成交額 ≥ 3 萬 USDT、收紅、收盤 ≤ 區間高點 +5%（還沒離開區間太遠）
     A 放量：≥ 前 10 天每小時成交額中位數 10 倍
     B 30 天新高量：≥ 前 30 天所有 1H 的最高成交額（含當天稍早幾根）
   兩家同一小時（或前後 1 小時）都符合同一種才通知；B 兩家都符合標【30天新高量】。
   同一檔 7 天內只通知一次（A 之後出現 B 會再通知一次「升級」）。
   2026-11 回測（OKX＋Bitget、110 天）：7 天內漲 ≥50% 的比例 A 7%、B 9%，隨機 3%；
   但照訊號直接進場的中位數為負，只當觀察，不是進場訊號。
   ============================================================ */
import zlib from 'node:zlib';
import { tpe, fmtP, link, tvUrl } from './tracker.mjs';

const H = 3600e3, D = 24 * H;
export const DORMANT = {
  rangeDays: 10, maxRange: 0.3,
  minQv: 3e4,                // 300U 部位 ≈ 這根成交額 1%
  maxAboveHigh: 0.05,
  medX: 10, medHours: 240,
  maxDays: 30, minMaxDays: 28,   // 30 天最高量至少要有 28 天的紀錄才判斷 B
  coolDays: 7, keepDays: 14, sigKeepHours: 3,
  maxLines: 15,
  backtest: { A: 7, B: 9, rnd: 3 }
};

const median = a => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y), n = s.length; return n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2; };
export const dayOf = t => Math.floor(t / D) * D;

/** 完整的 UTC 日：每天最高的 1H 成交額（bars 由舊到新；第一天、當天不算，因為可能不完整） */
export function dayMaxes(bars, nowT) {
  const by = new Map();
  for (const b of bars) { const d = dayOf(b.t); by.set(d, Math.max(by.get(d) ?? 0, b.qv)); }
  const first = bars.length ? dayOf(bars[0].t) : null, today = dayOf(nowT);
  const out = {};
  for (const [d, v] of by) if (d !== first && d < today) out[d] = v;
  return out;
}

/**
 * bars：由舊到新的 1H K（{t,o,h,l,c,qv}），T＝要判斷那根的開盤時間
 * dm：{UTC 日: 當天最高 1H 成交額}（快取，B 用）
 * 回傳 null（資料不足或不是沉睡）或 { kinds, qv, xA, xB, c, hi, range, pos, chg }
 */
export function wakeStats(bars, T, dm = {}, cfg = DORMANT) {
  const day = dayOf(T);
  const i = bars.findIndex(b => b.t === T);
  if (i < 0) return null;
  const b = bars[i];
  const prior = bars.filter(x => x.t < day && x.t >= day - cfg.rangeDays * D);
  if (prior.length < cfg.rangeDays * 24 * 0.8) return null;
  const hi = Math.max(...prior.map(x => x.h)), lo = Math.min(...prior.map(x => x.l));
  if (!(lo > 0) || hi / lo - 1 > cfg.maxRange) return null;
  const med = median(bars.filter(x => x.t < day).slice(-cfg.medHours).map(x => x.qv));
  const days = Object.keys(dm).map(Number).filter(d => d < day && d >= day - cfg.maxDays * D);
  const sameDay = bars.filter(x => x.t >= day && x.t < T).reduce((m, x) => Math.max(m, x.qv), 0);
  const max30 = days.length >= cfg.minMaxDays ? Math.max(sameDay, ...days.map(d => dm[d])) : null;
  const kinds = [];
  const ok = b.qv >= cfg.minQv && b.c > b.o && b.c <= hi * (1 + cfg.maxAboveHigh);
  if (ok && b.qv >= cfg.medX * Math.max(med, 1)) kinds.push('A');
  if (ok && max30 != null && b.qv >= max30) kinds.push('B');
  return {
    kinds, qv: b.qv, c: b.c, hi, range: hi / lo - 1, pos: b.c / hi - 1, chg: b.c / b.o - 1,
    xA: b.qv / Math.max(med, 1), xB: max30 != null ? b.qv / Math.max(max30, 1) : null
  };
}

export function emptyDormant() { return { version: 1, lastHour: null, sig: [], events: [], notified: {} }; }

/**
 * sigs：本小時 [{ venue, sym, base, st }]（st.kinds 非空）
 * 跟上一小時（state.sig）合併判斷兩家同時；回傳本小時要通知的事件
 */
export function pickWake(state, sigs, T, cfg = DORMANT) {
  const all = [...sigs.map(s => ({ ...s, t: T })), ...state.sig.filter(s => s.t >= T - H && s.t < T)];
  const byBase = new Map();
  for (const s of all) { const a = byBase.get(s.base) || []; a.push(s); byBase.set(s.base, a); }
  const out = [];
  for (const [base, list] of byBase) {
    const now = list.filter(s => s.t === T);
    if (!now.length) continue;                                      /* 兩家都只在上一小時：上一輪已處理 */
    const okx = list.filter(s => s.venue === 'okx'), bg = list.filter(s => s.venue === 'bitget');
    if (!okx.length || !bg.length) continue;
    const has = (arr, k) => arr.some(s => s.st.kinds.includes(k));
    const kind = has(okx, 'B') && has(bg, 'B') ? 'B' : has(okx, 'A') && has(bg, 'A') ? 'A' : null;
    if (!kind) continue;
    const prev = state.notified[base];
    if (prev && T - prev.t < cfg.coolDays * D && !(prev.kind === 'A' && kind === 'B')) continue;
    const pickV = arr => arr.slice().sort((a, b) => b.t - a.t)[0];
    const leg = s => ({ sym: s.sym, t: s.t, qv: Math.round(s.st.qv), xA: +s.st.xA.toFixed(1), xB: s.st.xB == null ? null : +s.st.xB.toFixed(2), c: s.st.c, pos: +(s.st.pos * 100).toFixed(1), chg: +(s.st.chg * 100).toFixed(1), range: +(s.st.range * 100).toFixed(1), hi: s.st.hi });
    const o = leg(pickV(okx)), g = leg(pickV(bg));
    out.push({ t: T, base, kind, upgrade: !!(prev && prev.kind === 'A' && kind === 'B' && T - prev.t < cfg.coolDays * D), okx: o, bitget: g, price: o.c });
    state.notified[base] = { t: T, kind };
  }
  out.sort((a, b) => (b.kind === 'B') - (a.kind === 'B') || (b.okx.qv + b.bitget.qv) - (a.okx.qv + a.bitget.qv));
  state.sig = [...sigs.map(s => ({ venue: s.venue, sym: s.sym, base: s.base, t: T, st: { kinds: s.st.kinds, qv: s.st.qv, xA: s.st.xA, xB: s.st.xB, c: s.st.c, pos: s.st.pos, chg: s.st.chg, range: s.st.range, hi: s.st.hi } })),
    ...state.sig.filter(s => s.t < T && s.t >= T - cfg.sigKeepHours * H)];
  state.events = [...out, ...state.events].filter(e => T - e.t < cfg.keepDays * D);
  for (const k of Object.keys(state.notified)) if (T - state.notified[k].t > cfg.keepDays * D) delete state.notified[k];
  state.lastHour = T;
  return out;
}

/* ---------------- 文字 ---------------- */
const money = v => v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${(v / 1e3).toFixed(0)}K`;
const pcs = v => `${v >= 0 ? '+' : ''}${(+v).toFixed(1)}%`;
const hhmm = t => tpe(t).slice(11, 16);
const legTxt = (name, l, kind) => `${name} ${money(l.qv)}（${kind === 'B' ? `30天最高 ${l.xB}x` : `中位數 ${l.xA}x`}）`;
export const KIND = { A: '放量', B: '30天新高量' };

export function wakeAlertText(events, T, url = '', cfg = DORMANT) {
  if (!events.length) return '';
  const L = [`【沉睡甦醒】${tpe(T).slice(5, 10)} ${hhmm(T)}–${hhmm(T + H)} 台灣時間（${events.length} 檔；10 天窄幅後 OKX、Bitget 同時放量）`];
  events.slice(0, cfg.maxLines).forEach(e => {
    L.push(`${e.kind === 'B' ? '【30天新高量】' : ''}${e.upgrade ? '【升級】' : ''}${link(e.base, tvUrl('okx', e.okx.sym, '60'))} ${legTxt('OKX', e.okx, e.kind)}／${legTxt('Bitget', e.bitget, e.kind)}`);
    L.push(`  價格 ${fmtP(e.price)}｜這根 ${pcs(e.okx.chg)}｜距 10 天高點 ${pcs(e.okx.pos)}｜10 天區間 ${e.okx.range}%`);
  });
  if (events.length > cfg.maxLines) L.push(`另有 ${events.length - cfg.maxLines} 檔，見網頁`);
  L.push(`回測：7 天內漲 ≥50% 約 ${cfg.backtest.A}%（30天新高量 ${cfg.backtest.B}%），隨機 ${cfg.backtest.rnd}%；直接進場的中位數為負，看圖判斷，不是進場訊號`);
  if (url) L.push(url);
  return L.join('\n');
}

export function dormantMarkdown(state, { nowMs, warnings = [], note = '', rows = 150 }, cfg = DORMANT) {
  const L = [`# 沉睡甦醒｜更新 ${tpe(nowMs)} 台灣時間`, ''];
  L.push(`OKX、Bitget 都有上架的加密合約（不設流動性門檻）。前 ${cfg.rangeDays} 天價格區間 ≤ ${cfg.maxRange * 100}%，剛收盤的 1H K 成交額 ≥ ${cfg.minQv / 1e4} 萬 USDT、收紅、收盤 ≤ 區間高點 +${cfg.maxAboveHigh * 100}%，且兩家同一小時（前後 1 小時）都符合：`);
  L.push(`- **放量**：≥ 前 10 天每小時成交額中位數 ${cfg.medX} 倍`);
  L.push(`- **30天新高量**：≥ 前 30 天所有 1H 的最高成交額`);
  L.push(`同一檔 ${cfg.coolDays} 天內只通知一次（放量之後出現 30天新高量會再通知）。回測 7 天內漲 ≥50%：放量 ${cfg.backtest.A}%、30天新高量 ${cfg.backtest.B}%、隨機 ${cfg.backtest.rnd}%；直接進場中位數為負，只當觀察。`);
  if (note) { L.push(''); L.push(note); }
  L.push('', `## 最近 ${cfg.keepDays} 天（${state.events.length} 筆）`);
  if (state.events.length) {
    L.push('| 時間 | 標的 | 類型 | OKX 成交額 | Bitget 成交額 | 價格 | 這根 | 距高點 | 10天區間 |', '|---|---|---|---|---|---|---|---|---|');
    state.events.slice(0, rows).forEach(e => L.push(`| ${tpe(e.t).slice(5, 16)} | ${link(e.base, tvUrl('okx', e.okx.sym, '60'))} | ${KIND[e.kind]}${e.upgrade ? '（升級）' : ''} | ${money(e.okx.qv)} | ${money(e.bitget.qv)} | ${fmtP(e.price)} | ${pcs(e.okx.chg)} | ${pcs(e.okx.pos)} | ${e.okx.range}% |`));
    if (state.events.length > rows) L.push('', `（只列最近 ${rows} 筆，完整紀錄在網頁）`);
  } else L.push('無');
  if (warnings.length) { L.push(''); L.push(`## 資料警告（${warnings.length}）`); warnings.slice(0, 20).forEach(w => L.push(`- ${w}`)); }
  L.push('', '> 規則式篩選，不是投資建議。');
  return L.join('\n');
}

const MA = '<!-- DORMANT_STATE', MB = 'DORMANT_STATE -->';
export function embedDormant(md, state) {
  return `${md}\n\n${MA}\n${zlib.gzipSync(Buffer.from(JSON.stringify(state))).toString('base64')}\n${MB}\n`;
}
export function extractDormant(body) {
  if (!body) return emptyDormant();
  const a = body.indexOf(MA), b = body.indexOf(MB);
  if (a < 0 || b < 0) return emptyDormant();
  try { return { ...emptyDormant(), ...JSON.parse(zlib.gunzipSync(Buffer.from(body.slice(a + MA.length, b).trim(), 'base64')).toString('utf8')) }; }
  catch { return null; }
}
export function dormantBody(state, opts, render = x => x, cfg = DORMANT, limit = 60000) {
  let rows = 150, out;
  for (;;) {
    out = embedDormant(render(dormantMarkdown(state, { ...opts, rows }, cfg)), state);
    if (out.length <= limit || rows === 0) return out;
    rows = rows > 30 ? rows - 30 : 0;
  }
}
