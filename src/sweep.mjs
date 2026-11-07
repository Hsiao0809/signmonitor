/* ============================================================
   掃流動性（純邏輯，不碰網路，方便測試與回放）

   只做標記，不推播、不影響任何觸發。每根 4H K 收盤後，對
   短線清單（等待觸發＋持倉中）、布局清單、自選標的檢查最近 72 小時的已收盤 4H K：
     掃上方：最高價越過關鍵價位，但收盤收回價位下方
     掃下方：最低價跌破關鍵價位，但收盤收回價位上方
   關鍵價位：
     spike  爆量日（UTC 日線）高低點
     pd     前一日（UTC）高低點
     swing  近 30 根 4H K（5 天）內的波段高低點：左右各 3 根都比它低（高）
   價位在被「收盤越過」之前都算有效；影線刺穿再收回不算失效，下次再掃仍會標記。
   量：該根成交額 ÷ 前 20 根平均，≥ 1.5 倍標「有量」，不足也照樣標記。
   股票、商品在現貨休市時段（週末）發生的照樣標記，另加「週末」。
   沒有回測，只是參考標記。
   ============================================================ */
import zlib from 'node:zlib';
import { tpe, fmtP } from './tracker.mjs';
import { weekendClosed } from './hourly.mjs';

export const SWEEP = {
  swingBars: 30,     // 波段高低點往回看幾根 4H K
  pivot: 3,          // 波段點左右各幾根
  volLen: 20,        // 量的比較基準：前幾根平均
  volX: 1.5,         // ≥ 幾倍算「有量」
  keepHours: 72,     // 紀錄保留幾小時
  barsShort: 120,    // 短線清單沿用追蹤時抓的根數
  barsOther: 200,    // 布局、自選另外抓的根數（約 33 天，夠找爆量日）
  maxEvents: 600
};

const H = 3600e3, H4 = 4 * H, D = 24 * H;
export const KIND = { spike: '爆量日', pd: '前日', swing: '波段' };
export const barOpen = nowMs => Math.floor(nowMs / H4) * H4 - H4;   /* 最近一根已收盤 4H K 的開始時間 */

export function emptySweep() { return { version: 1, lastBar: null, targets: 0, events: [] }; }

/* 爆量日高低：短線清單直接給 hi/lo；布局清單只有 dayT，從 4H K 算出當天（UTC）高低 */
export function spikeLevels(bars, spike) {
  if (!spike || spike.dayT == null) return null;
  if (spike.hi != null && spike.lo != null) return { hi: spike.hi, lo: spike.lo, from: spike.dayT + D };
  const day = bars.filter(b => b.t >= spike.dayT && b.t < spike.dayT + D);
  if (day.length < 6) return null;          /* 爆量日不在抓到的範圍內，或資料不完整 */
  return { hi: Math.max(...day.map(b => b.h)), lo: Math.min(...day.map(b => b.l)), from: spike.dayT + D };
}

/* 價位從 fromIdx 起到 i-1 都沒有被收盤越過 → 仍有效 */
function intact(bars, fromIdx, i, p, side) {
  for (let k = Math.max(0, fromIdx); k < i; k++) {
    if (side === 'hi' ? bars[k].c > p : bars[k].c < p) return false;
  }
  return true;
}
const idxFrom = (bars, t) => { const k = bars.findIndex(b => b.t >= t); return k < 0 ? bars.length : k; };

/** 第 i 根 K 開盤前，有效的關鍵價位 */
export function levelsAt(bars, i, sp, cfg = SWEEP) {
  const hi = [], lo = [];
  const t = bars[i].t;
  /* 爆量日：爆量日結束後才算 */
  if (sp && t >= sp.from) {
    const f = idxFrom(bars, sp.from);
    if (intact(bars, f, i, sp.hi, 'hi')) hi.push({ k: 'spike', p: sp.hi });
    if (intact(bars, f, i, sp.lo, 'lo')) lo.push({ k: 'spike', p: sp.lo });
  }
  /* 前一日（UTC） */
  const d0 = Math.floor(t / D) * D;
  const prev = bars.filter(b => b.t >= d0 - D && b.t < d0);
  if (prev.length >= 4) {
    const f = idxFrom(bars, d0);
    const ph = Math.max(...prev.map(b => b.h)), pl = Math.min(...prev.map(b => b.l));
    if (intact(bars, f, i, ph, 'hi')) hi.push({ k: 'pd', p: ph });
    if (intact(bars, f, i, pl, 'lo')) lo.push({ k: 'pd', p: pl });
  }
  /* 波段：只用 i 之前已確認（右邊 pivot 根都已收盤）的點 */
  const P = cfg.pivot;
  for (let j = Math.max(P, i - cfg.swingBars); j <= i - 1 - P; j++) {
    let isH = true, isL = true;
    for (let k = j - P; k <= j + P; k++) {
      if (k === j) continue;
      if (bars[k].h >= bars[j].h) isH = false;
      if (bars[k].l <= bars[j].l) isL = false;
    }
    if (isH && intact(bars, j + 1, i, bars[j].h, 'hi')) hi.push({ k: 'swing', p: bars[j].h });
    if (isL && intact(bars, j + 1, i, bars[j].l, 'lo')) lo.push({ k: 'swing', p: bars[j].l });
  }
  return { hi, lo };
}

/* 同一種價位只留掃得最深的那個：上方取最高、下方取最低 */
function deepest(list, up) {
  const by = {};
  for (const x of list) if (!by[x.k] || (up ? x.p > by[x.k].p : x.p < by[x.k].p)) by[x.k] = x;
  return ['spike', 'pd', 'swing'].filter(k => by[k]).map(k => by[k]);
}

/**
 * 找出最近 keepHours 內已收盤 4H K 的掃流動性。bars 由舊到新。
 * spike：{dayT, hi?, lo?}（可省略）
 * 回傳 [{t, side:'up'|'dn', lv:[{k,p}], x（最高或最低價）, c, volx}]
 */
export function detect(bars, nowMs, spike = null, cfg = SWEEP) {
  const closed = bars.filter(b => b.t + H4 <= nowMs);
  const sp = spikeLevels(closed, spike);
  const out = [];
  const since = nowMs - cfg.keepHours * H;
  for (let i = cfg.volLen; i < closed.length; i++) {
    const b = closed[i];
    if (b.t + H4 <= since) continue;
    const L = levelsAt(closed, i, sp, cfg);
    let s = 0;
    for (let k = i - cfg.volLen; k < i; k++) s += closed[k].qv || 0;
    const avg = s / cfg.volLen;
    const volx = avg > 0 && b.qv > 0 ? +(b.qv / avg).toFixed(1) : null;
    const up = deepest(L.hi.filter(x => b.h > x.p && b.c < x.p), true);
    const dn = deepest(L.lo.filter(x => b.l < x.p && b.c > x.p), false);
    if (up.length) out.push({ t: b.t, side: 'up', lv: up, x: b.h, c: b.c, volx });
    if (dn.length) out.push({ t: b.t, side: 'dn', lv: dn, x: b.l, c: b.c, volx });
  }
  return out;
}

/**
 * 併入新結果。results：[{target:{base,cat,ex,id,src,spike}, bars|null}]
 * 抓不到 K 線的沿用舊紀錄；已不在任何清單的標的移除。
 */
export function apply(state, results, lastBar, nowMs, cfg = SWEEP) {
  const live = new Set(results.map(r => r.target.base));
  const failed = new Set(results.filter(r => !r.bars).map(r => r.target.base));
  const keep = state.events.filter(e => live.has(e.base) && failed.has(e.base));
  const fresh = [];
  for (const r of results) {
    if (!r.bars) continue;
    const g = r.target;
    for (const e of detect(r.bars, nowMs, g.spike, cfg)) {
      const wk = weekendClosed(e.t, g.cat) || weekendClosed(e.t + H4 - 1, g.cat);
      fresh.push({ base: g.base, cat: g.cat, ex: g.ex, id: g.id, src: g.src, ...e, ...(wk ? { wk: 1 } : {}) });
    }
  }
  /* 記下第一次看到的時間（網頁顯示用，也留給之後若要推播時判斷是不是新的） */
  const key = e => `${e.base}|${e.t}|${e.side}`;
  const seen = new Map(state.events.map(e => [key(e), e.firstSeen ?? nowMs]));
  fresh.forEach(e => { e.firstSeen = seen.get(key(e)) ?? nowMs; });
  const since = nowMs - cfg.keepHours * H;
  state.events = [...keep, ...fresh].filter(e => e.t + H4 > since)
    .sort((a, b) => b.t - a.t || a.base.localeCompare(b.base)).slice(0, cfg.maxEvents);
  state.lastBar = lastBar;
  state.targets = results.length;
  return state;
}

/* ---------------- 文字 ---------------- */
const SRC = { short: '短線', layout: '布局', watch: '自選' };
export function label(e, cfg = SWEEP) {
  const s = e.side === 'up' ? '掃上' : '掃下', hl = e.side === 'up' ? '高' : '低';
  return `${s}・${e.lv.map(x => KIND[x.k] + hl).join('＋')}${e.volx != null && e.volx >= cfg.volX ? '・有量' : ''}${e.wk ? '・週末' : ''}`;
}
export function detail(e, cfg = SWEEP) {
  const hl = e.side === 'up' ? '高' : '低';
  const far = Math.max(...e.lv.map(x => Math.abs(e.x / x.p - 1) * 100));
  return `${tpe(e.t)} 那根 4H：${e.side === 'up' ? '最高' : '最低'} ${fmtP(e.x)}，越過 ${e.lv.map(x => `${KIND[x.k]}${hl} ${fmtP(x.p)}`).join('、')}（最多 ${far.toFixed(2)}%），收盤 ${fmtP(e.c)} 收回；量 ${e.volx == null ? '—' : e.volx + 'x'}${e.volx != null && e.volx >= cfg.volX ? '（有量）' : '（無量）'}${e.wk ? '；現貨休市時段' : ''}`;
}

export function sweepMarkdown(state, { nowMs, warnings = [], note = '' }, cfg = SWEEP) {
  const L = [`# 掃流動性｜更新 ${tpe(nowMs)} 台灣時間`, ''];
  L.push(`範圍：短線清單（等待觸發＋持倉中）、布局清單、自選標的。每根 4H K 收盤後檢查最近 ${cfg.keepHours} 小時。`);
  L.push('- **掃上**：最高價越過關鍵價位，收盤收回下方；**掃下**：最低價跌破關鍵價位，收盤收回上方');
  L.push(`- 價位：爆量日高低、前一日（UTC）高低、近 ${cfg.swingBars} 根 4H 波段高低（左右各 ${cfg.pivot} 根）；被收盤越過就失效`);
  L.push(`- 量 ≥ 前 ${cfg.volLen} 根平均 ${cfg.volX} 倍標「有量」。只在網頁標記，不推播；沒有回測，僅供參考`);
  if (note) { L.push(''); L.push(note); }
  L.push('');
  L.push(`## 最近 ${cfg.keepHours} 小時（${state.events.length}）`);
  if (state.events.length) {
    L.push('| 4H K | 標的 | 清單 | 標記 | 價位 | 極值 | 收盤 | 量 |');
    L.push('|---|---|---|---|---|---|---|---|');
    state.events.forEach(e => L.push(`| ${tpe(e.t).slice(5, 16)} | ${e.base} | ${(e.src || []).map(s => SRC[s]).join('、')} | ${label(e, cfg)} | ${e.lv.map(x => `${KIND[x.k]} ${fmtP(x.p)}`).join('、')} | ${fmtP(e.x)} | ${fmtP(e.c)} | ${e.volx == null ? '—' : e.volx + 'x'} |`));
  } else L.push('無');
  if (warnings.length) { L.push(''); L.push(`## 資料警告（${warnings.length}）`); warnings.slice(0, 20).forEach(w => L.push(`- ${w}`)); }
  return L.join('\n');
}

const MA = '<!-- SWEEP_STATE', MB = 'SWEEP_STATE -->';
const compact = s => JSON.parse(JSON.stringify(s, (k, v) => typeof v === 'number' && !Number.isInteger(v) ? +v.toPrecision(7) : v));
export function embedSweep(md, state) {
  return `${md}\n\n${MA}\n${zlib.gzipSync(Buffer.from(JSON.stringify(compact(state)))).toString('base64')}\n${MB}\n`;
}
export function extractSweep(body) {
  if (!body) return emptySweep();
  const a = body.indexOf(MA), b = body.indexOf(MB);
  if (a < 0 || b < 0) return emptySweep();
  try { return { ...emptySweep(), ...JSON.parse(zlib.gunzipSync(Buffer.from(body.slice(a + MA.length, b).trim(), 'base64')).toString('utf8')) }; }
  catch { return null; }
}
