/* ============================================================
   布局清單（中長線）：OKX／Bitget／Bybit 三家分開算量
   任何一家的代幣化股票／商品合約日成交額 ≥ 前 20 日均量 minX 倍，
   而且當天成交額 ≥ floorQv，就進清單；記下三家各自的量倍數，
   特別標出「只有一家爆量」。之後每天更新現價、報酬、相對大盤與最大回撤，
   滿 holdDays 天結算。不用 4H 觸發、不設緊停損，和短線清單是兩套邏輯。
   ============================================================ */
import zlib from 'node:zlib';
import { tpe, fmtP } from './tracker.mjs';

export const LAYOUT = {
  venues: ['okx', 'bitget', 'bybit'],
  cats: ['stock', 'comm'],
  minX: 5,               // 任一家量倍數門檻
  floorQv: 5e5,          // 爆量那一家當天成交額下限（USDT），濾掉冷門合約的雜訊
  otherQuietX: 2,        // 其他家都低於這個倍數才算「只有一家爆量」
  holdDays: 60,          // 追蹤天數
  checkpoints: [30],     // 中途回報
  sizePct: 25,           // 部位建議：以能承受 -25% 計算
  maxClosedKept: 400,
  marketKeepDays: 150
};

const D = 864e5;
const VL = { okx: 'OKX', bitget: 'Bitget', bybit: 'Bybit' };
const CAT = { stock: '股票', comm: '商品' };
export const ymdOf = t => new Date(t).toISOString().slice(0, 10);

export function emptyLayout() {
  return { version: 1, lastDay: null, active: [], closed: [], market: {} };
}

/** 量倍數：最後一根「已收盤」日線 / 前 20 日均量。bars 由舊到新，day 為要評估的 UTC 日期 */
export function volX(bars, day) {
  if (!bars || !bars.length) return null;
  const i = bars.findIndex(b => ymdOf(b.t) === day);
  if (i < 0) return null;
  const prev = bars.filter(b => b.t < bars[i].t && b.t >= bars[i].t - 20 * D);
  if (prev.length < 15) return null;
  const m = prev.reduce((s, b) => s + b.qv, 0) / 20;
  return m > 0 ? { x: bars[i].qv / m, qv: bars[i].qv, bar: bars[i] } : null;
}

/**
 * series: { okx: bars|null, bitget: bars|null, bybit: bars|null }
 * meta: { base, cat, ref: 'okx'|'bitget'|'bybit' }
 */
export function layoutCandidate(meta, series, day, nowMs, cfg = LAYOUT) {
  const per = {};
  for (const v of cfg.venues) per[v] = volX(series[v], day);
  const spiked = cfg.venues.filter(v => per[v] && per[v].x >= cfg.minX && per[v].qv >= cfg.floorQv);
  if (!spiked.length) return null;
  const others = cfg.venues.filter(v => !spiked.includes(v) && per[v]);
  const single = spiked.length === 1 && others.length >= 1 && others.every(v => per[v].x < cfg.otherQuietX);
  const refBar = per[meta.ref]?.bar || per[spiked[0]].bar;
  return {
    base: meta.base, cat: meta.cat, ref: per[meta.ref] ? meta.ref : spiked[0],
    day, dayT: refBar.t, entry: refBar.c, hi: refBar.h, lo: refBar.l, chgDay: +((refBar.c / refBar.o - 1) * 100).toFixed(2),
    venues: Object.fromEntries(cfg.venues.map(v => [v, per[v] ? { x: +per[v].x.toFixed(2), qv: Math.round(per[v].qv) } : null])),
    spiked, single, addedAt: nowMs, status: 'active',
    last: refBar.c, lastT: refBar.t, low: refBar.c, high: refBar.c, ret: 0, mae: 0, mfe: 0, ex: 0, age: 0,
    respikes: 0, notified: []
  };
}

/** 同一檔在追蹤期間再次爆量：不另開，記一次「再爆量」 */
export function mergeLayout(state, cands) {
  const act = new Map(state.active.map(x => [x.base, x]));
  const added = [];
  for (const c of cands) {
    const old = act.get(c.base);
    if (old) { if (c.day > old.day) { old.respikes++; old.lastSpike = c.day; old.lastSpikeVenues = c.spiked; } continue; }
    act.set(c.base, c); added.push(c);
  }
  state.active = [...act.values()];
  return added;
}

/* ---------------- 大盤基準：所有股票合約的等權平均日報酬，累積成指數 ---------------- */
export function updateMarket(state, refSeries, cfg = LAYOUT) {
  const byDay = new Map();
  for (const bars of refSeries) {
    for (let i = 1; i < bars.length; i++) {
      const d = ymdOf(bars[i].t);
      if (bars[i].t - bars[i - 1].t > 1.5 * D || !(bars[i - 1].c > 0)) continue;
      const r = bars[i].c / bars[i - 1].c - 1;
      if (!isFinite(r) || Math.abs(r) > 0.5) continue;
      const a = byDay.get(d) || []; a.push(r); byDay.set(d, a);
    }
  }
  const days = [...byDay.keys()].sort();
  const mk = state.market;
  /* 第一次建立指數：把第一個報酬日的前一天定為 100，讓當天爆量的標的也有比較基準 */
  if (!Object.keys(mk).length && days.length) mk[ymdOf(Date.parse(days[0] + 'T00:00:00Z') - D)] = 100;
  for (const d of days) {
    if (mk[d] != null) continue;
    const prevDays = Object.keys(mk).filter(x => x < d).sort();
    const prev = prevDays.length ? mk[prevDays[prevDays.length - 1]] : 100;
    const rs = byDay.get(d);
    if (rs.length < 20) continue;
    mk[d] = +(prev * (1 + rs.reduce((s, x) => s + x, 0) / rs.length)).toFixed(6);
  }
  const keep = Object.keys(mk).sort().slice(-cfg.marketKeepDays);
  state.market = Object.fromEntries(keep.map(k => [k, mk[k]]));
}
export function marketRet(state, fromDay, toDay) {
  const mk = state.market;
  const at = d => { const ks = Object.keys(mk).filter(x => x <= d).sort(); return ks.length ? mk[ks[ks.length - 1]] : null; };
  const a = at(fromDay), b = at(toDay);
  return a && b ? b / a - 1 : null;
}

/* ---------------- 每日推進 ---------------- */
/** refBars：該檔參考交易所的日線（由舊到新，只用已收盤） */
export function advanceLayout(state, refBarsOf, nowMs, cfg = LAYOUT) {
  const events = [];
  const still = [];
  for (const it of state.active) {
    const bars = (refBarsOf(it) || []).filter(b => b.t > it.dayT && b.t + D <= nowMs);
    for (const b of bars) {
      if (b.t <= it.lastT) continue;
      it.last = b.c; it.lastT = b.t;
      it.low = Math.min(it.low, b.l); it.high = Math.max(it.high, b.h);
    }
    const age = Math.floor((it.lastT - it.dayT) / D);
    it.ret = it.last / it.entry - 1;
    it.mae = it.low / it.entry - 1;
    it.mfe = it.high / it.entry - 1;
    const mr = marketRet(state, it.day, ymdOf(it.lastT));
    it.ex = mr == null ? null : it.ret - mr;
    for (const cp of cfg.checkpoints) {
      if (age >= cp && !it.notified.includes(cp)) { it.notified.push(cp); events.push({ type: 'checkpoint', days: cp, item: { ...it } }); }
    }
    /* 合約下市或資料中斷：超過追蹤天數 5 天仍沒有新 K 線，就以最後價格結算 */
    if (age >= cfg.holdDays || (nowMs - it.dayT) / D >= cfg.holdDays + 5) {
      const done = slimLayout({ ...it, status: 'closed', closedT: it.lastT, age });
      state.closed.push(done);
      events.push({ type: 'settle', item: done });
    } else {
      it.age = age;
      still.push(it);
    }
  }
  state.active = still;
  if (state.closed.length > cfg.maxClosedKept) state.closed = state.closed.slice(-cfg.maxClosedKept);
  return events;
}

function slimLayout(p) {
  const k = ['base', 'cat', 'day', 'entry', 'last', 'ret', 'ex', 'mae', 'mfe', 'spiked', 'single', 'venues', 'respikes', 'closedT', 'age'];
  return Object.fromEntries(k.map(x => [x, p[x]]));
}

export function layoutStats(closed) {
  const g = xs => {
    if (!xs.length) return null;
    const ex = xs.map(x => x.ex).filter(v => v != null).sort((a, b) => a - b);
    const med = a => a.length ? a[a.length >> 1] : null;
    return { n: xs.length, exMed: med(ex), beat: ex.length ? ex.filter(v => v > 0).length / ex.length : null,
      retMed: med(xs.map(x => x.ret).sort((a, b) => a - b)), maeMed: med(xs.map(x => x.mae).sort((a, b) => a - b)) };
  };
  return { all: g(closed), single: g(closed.filter(x => x.single)), multi: g(closed.filter(x => !x.single)) };
}

/* ---------------- 文字 ---------------- */
export function kindOf(it) {
  if (it.single) return `只有 ${VL[it.spiked[0]]} 爆量`;
  if (it.spiked.length > 1) return `${it.spiked.map(v => VL[v]).join('＋')} 同時爆量`;
  return `${VL[it.spiked[0]]} 爆量（其他家也放量或無資料）`;
}
const pc = v => v == null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
function venueLine(it, cfg = LAYOUT) {
  return cfg.venues.map(v => {
    const s = it.venues[v];
    if (!s) return `${VL[v]} —`;
    const mark = it.spiked.includes(v) ? '★' : '';
    return `${VL[v]} ${mark}${s.x.toFixed(1)}x`;
  }).join('｜');
}

export function layoutDailyText(added, events, state, cfg = LAYOUT) {
  const L = [];
  if (added.length) {
    const top = added.slice().sort((a, b) => (b.single - a.single) || (Math.max(...b.spiked.map(v => b.venues[v].x)) - Math.max(...a.spiked.map(v => a.venues[v].x)))).slice(0, 12);
    L.push(`布局清單新進 ${added.length} 檔（任一家量 ≥${cfg.minX}x，列前 ${top.length}；★＝爆量的交易所）`);
    top.forEach(c => {
      L.push(`${c.base}［${CAT[c.cat] || c.cat}］${kindOf(c)}｜收 ${fmtP(c.entry)}（${c.chgDay >= 0 ? '+' : ''}${c.chgDay.toFixed(1)}%）`);
      L.push(`  ${venueLine(c, cfg)}`);
    });
    L.push(`布局單以能承受 -${cfg.sizePct}% 回撤計算部位，追蹤 ${cfg.holdDays} 天`);
  } else {
    L.push('布局清單：今天沒有新的爆量');
  }
  for (const e of events) L.push(layoutEventText(e, cfg));
  L.push(`布局清單追蹤中 ${state.active.length} 檔`);
  return L.join('\n');
}

export function layoutEventText(e, cfg = LAYOUT) {
  const p = e.item;
  const head = e.type === 'settle' ? `【布局結算 ${cfg.holdDays} 天】` : `【布局 ${e.days} 天】`;
  return `${head}${p.base}（${kindOf(p)}，${p.day}）${pc(p.ret)}，相對大盤 ${pc(p.ex)}，期間最大回撤 ${pc(p.mae)}`;
}

export function layoutMarkdown(state, { nowMs, warnings = [], note = '' }, cfg = LAYOUT) {
  const L = [];
  L.push(`# 布局清單｜更新 ${tpe(nowMs)} 台灣時間`);
  L.push('');
  L.push(`OKX、Bitget、Bybit 三家分開算量。任一家代幣化股票／商品合約日成交額 ≥ 前 20 日均量 ${cfg.minX} 倍（當天 ≥ ${(cfg.floorQv / 1e4).toFixed(0)} 萬 USDT）就進清單，追蹤 ${cfg.holdDays} 天。`);
  L.push(`★ 是爆量的交易所；「只有一家」＝其他家都低於 ${cfg.otherQuietX}x。報酬以爆量日收盤計，相對大盤＝扣掉所有股票合約等權平均。部位以能承受 -${cfg.sizePct}% 回撤計算。`);
  if (note) { L.push(''); L.push(note); }
  L.push('');
  L.push(`## 追蹤中（${state.active.length}）`);
  if (state.active.length) {
    L.push('| 標的 | 爆量日 | 三家量倍數 | 類型 | 爆量日收盤 | 現價 | 報酬 | 相對大盤 | 最大回撤 | 天數 | 再爆量 |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|');
    state.active.slice().sort((a, b) => b.day.localeCompare(a.day) || (b.single - a.single)).slice(0, 150).forEach(it => L.push(
      `| ${it.base}［${CAT[it.cat] || it.cat}］ | ${it.day.slice(5)} | ${venueLine(it, cfg)} | ${kindOf(it)} | ${fmtP(it.entry)} | ${fmtP(it.last)} | ${pc(it.ret)} | ${pc(it.ex)} | ${pc(it.mae)} | ${it.age ?? 0} | ${it.respikes || ''} |`));
    if (state.active.length > 150) L.push(`\n另有 ${state.active.length - 150} 檔未列出，仍在追蹤。`);
  } else L.push('無');
  L.push('');
  const s = layoutStats(state.closed);
  L.push(`## 成績（已結算 ${state.closed.length} 檔）`);
  if (s.all) {
    L.push('| 分組 | 檔數 | 相對大盤中位數 | 贏大盤比例 | 報酬中位數 | 最大回撤中位數 |');
    L.push('|---|---|---|---|---|---|');
    [['全部', s.all], ['只有一家爆量', s.single], ['多家同時爆量', s.multi]].filter(x => x[1]).forEach(([n, g]) => L.push(
      `| ${n} | ${g.n} | ${pc(g.exMed)} | ${g.beat == null ? '—' : (g.beat * 100).toFixed(0) + '%'} | ${pc(g.retMed)} | ${pc(g.maeMed)} |`));
  } else L.push('尚無');
  if (warnings.length) { L.push(''); L.push(`## 資料警告（${warnings.length}）`); warnings.slice(0, 30).forEach(w => L.push(`- ${w}`)); }
  L.push('');
  L.push('> 規則式篩選，不是投資建議。');
  return L.join('\n');
}

const MA = '<!-- LAYOUT_STATE', MB = 'LAYOUT_STATE -->';
export function embedLayout(md, state) {
  const packed = zlib.gzipSync(Buffer.from(JSON.stringify(state))).toString('base64');
  return `${md}\n\n${MA}\n${packed}\n${MB}\n`;
}
export function extractLayout(body) {
  if (!body) return emptyLayout();
  const a = body.indexOf(MA), b = body.indexOf(MB);
  if (a < 0 || b < 0) return emptyLayout();
  try {
    return { ...emptyLayout(), ...JSON.parse(zlib.gunzipSync(Buffer.from(body.slice(a + MA.length, b).trim(), 'base64')).toString('utf8')) };
  } catch { return null; }
}
