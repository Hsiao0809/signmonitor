import { quietDay, atrPctAt } from './quiet.mjs';
import zlib from 'node:zlib';

/* ============================================================
   觀察清單追蹤器（純邏輯，不碰網路，方便測試與回放）

   流程：
   1. 每日：用 signscanner 的「型態·爆量」找出昨日（UTC 日線）爆量的標的，
      放進觀察清單，記下爆量日的高點與低點。
   2. 每 4 小時（4H K 收盤後）：對清單內每檔看新收盤的 4H K：
      - 收盤站上爆量日高點 → 觸發做多；停損＝爆量日低點
      - 收盤跌破爆量日低點 → 觸發做空；停損＝爆量日高點
      - 爆量日後 expiryDays 天都沒觸發 → 移除
   3. 觸發後繼續追蹤：碰停損、碰 T2、或滿 holdDays 天就結算，累積成績。

   規則刻意不預測方向：爆量只代表「有人在動」，往哪邊突破才跟哪邊。
   ============================================================ */

export const CONFIG = {
  exchanges: ['okx', 'bitget'],   /* 回測用 OKX，GitHub Actions 也確定連得上；OKX 失敗才改 Bitget */
  /* 24h 成交額下限（USDT）。代幣化股票的永續合約量本來就小，但實際下單是用
     正股，所以門檻放低；加密貨幣沿用 signscanner 起漲分數的 300 萬 */
  liqFloor: { crypto: 3e6, stock: 1e5, comm: 1e6 },
  /* 爆量日成交量 ≥ 前 20 日均量幾倍。依 2026-09-17～11-06 OKX 248 檔回測：
     股票 2x／2.5x／3x 平均約 +0.24～0.31R，差異在雜訊內，取 2x 才抓得到
     APP 10/30（2.4x）這類；加密貨幣 3x 只有 +0.05R，4x 以上才有優勢 */
  candMinX: { crypto: 4, stock: 2, comm: 4 },
  expiryDays: 10,         // 爆量日後幾天沒觸發就移除
  holdDays: 15,           // 觸發後最多追蹤幾天
  t1R: 2,
  t2R: 3,
  chaseRange: 1,          // 觸發收盤超出觸發價達爆量日振幅 1 倍 → 標示「已遠離」
  maxRiskPct: { crypto: 15, stock: 10, comm: 6 },
  maxPending: 120,
  maxClosedKept: 500,
  dailyHourTPE: 9,        // 台灣時間 09:00 之後的第一輪跑每日掃描（UTC 日線 08:00 收盤；Bybit 成交檔約 09:12 公布）
  newListMax: 10,
  rallyTop: 5,
  /* 槓桿／反向 ETF 與波動率商品：大盤一動就集體爆量，不是個股訊號 */
  exclude: new Set([
    'SOXL', 'SOXS', 'TQQQ', 'SQQQ', 'UVXY', 'SVXY', 'VXX', 'SPXL', 'SPXS', 'SPXU',
    'UPRO', 'TNA', 'TZA', 'LABU', 'LABD', 'TSLL', 'TSLQ', 'NVDL', 'NVDQ', 'MSTU',
    'MSTZ', 'CONL', 'MUU', 'SNXX', 'FNGU', 'FNGD', 'TECL', 'TECS', 'YINN', 'YANG',
    'SKUU', 'INTW', 'NVDU', 'AMDL', 'PLTU', 'GGLL', 'METU', 'AMZU', 'AAPU',
    'SKDD', 'MSFU', 'KORU', 'TMF', 'TBT', 'MVLL', 'AGPU', 'CRML', 'SPXU'
  ]),
  /* 名稱以 2L／3L／2S／3S 結尾的槓桿商品（例如港股 CSOP 系列），以及外匯對 */
  excludePattern: /(?:[23][LS]$)|^(?:USD(?:JPY|BRL|CAD|CHF|CNH|KRW|TRY|MXN|TWD|HKD|SGD|INR)|(?:EUR|GBP|AUD|NZD)USD)$/
};

export function isExcluded(base, cfg = CONFIG) {
  return cfg.exclude.has(base) || (cfg.excludePattern ? cfg.excludePattern.test(base) : false);
}

const H = 3600e3, D = 24 * H, H4 = 4 * H;

export function emptyState() {
  return { version: 1, lastDaily: null, pending: [], open: [], closed: [], counters: { expired: 0 } };
}

/* ---------------- 格式 ---------------- */
export function fmtP(v) {
  if (!isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(1);
  if (a >= 10) return v.toFixed(2);
  if (a >= 1) return v.toFixed(3);
  return v.toPrecision(4);
}
export function tpe(ms, withTime = true) {
  const p = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; });
  return withTime ? `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` : `${p.year}-${p.month}-${p.day}`;
}
export function tpeHour(ms) { return +tpe(ms).slice(11, 13); }
const md = ms => new Date(ms).toISOString().slice(5, 10);   /* 日線以 UTC 日期標示 */
const pct = (a, b) => (a / b - 1) * 100;
const sgn = v => (v >= 0 ? '+' : '') + v.toFixed(1);
const CAT = { crypto: '加密', stock: '股票', comm: '商品' };
const EXL = { okx: 'OKX', bitget: 'Bitget', bybit: 'Bybit', binance: 'Binance' };

/* ---------------- TradingView 連結 ----------------
   格式與網頁版訊號掃描台相同：EXCHANGE:BASEUSDT.P。
   文字先用 link() 嵌入標記，最後依輸出位置轉成 Telegram HTML 或 Markdown。 */
const TV = { okx: 'OKX', bitget: 'BITGET', bybit: 'BYBIT', binance: 'BINANCE' };
export function tvSymbol(ex, sym) {
  if (!ex || !sym) return null;
  const core = ex === 'okx' ? String(sym).split('-')[0] : String(sym).replace(/USDT$/, '');
  return `${TV[ex] || ex.toUpperCase()}:${core}USDT.P`;
}
export function tvUrl(ex, sym, interval = '240') {
  const s = tvSymbol(ex, sym);
  return s ? `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(s)}&interval=${interval}` : null;
}
export const link = (name, url) => (url ? `\u0001${name}\u0002${url}\u0003` : String(name));
const LINK_RE = /\u0001([^\u0002]*)\u0002([^\u0003]*)\u0003/g;
const escHtml = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** mode：'html'（Telegram）、'md'（GitHub）、'plain' */
export function render(text, mode = 'plain') {
  if (mode === 'html') {
    let out = '', last = 0;
    for (const m of text.matchAll(LINK_RE)) {
      out += escHtml(text.slice(last, m.index)) + `<a href="${escHtml(m[2])}">${escHtml(m[1])}</a>`;
      last = m.index + m[0].length;
    }
    return out + escHtml(text.slice(last));
  }
  if (mode === 'md') return text.replace(LINK_RE, (_, n, u) => `[${n}](${u})`);
  return text.replace(LINK_RE, '$1');
}
const tvItem = p => link(p.base, tvUrl(p.ex, p.id, '240'));

/* ---------------- 每日：找新候選 ---------------- */
/**
 * daily: [{t,o,h,l,c,qv}] 由舊到新，最後一根是進行中的今日
 * meta: {id, base, cat, qv24h}
 * 回傳候選或 null
 */
export function candidateFrom(meta, daily, ex, nowMs, cfg = CONFIG) {
  if (isExcluded(meta.base, cfg)) return null;
  const floor = cfg.liqFloor[meta.cat] ?? cfg.liqFloor.crypto;
  if (!(meta.qv24h >= floor)) return null;
  const p = patternScanSafe(daily, nowMs);
  const minX = typeof cfg.candMinX === 'number' ? cfg.candMinX : (cfg.candMinX[meta.cat] ?? cfg.candMinX.crypto);
  if (!p || !(p.vx >= minX)) return null;
  const bar = daily[daily.length - 2];            /* 最後一根已收盤日線 = 爆量日 */
  if (!(bar.h > bar.l)) return null;
  const q = quietDay(pct(bar.c, bar.o), atrPctAt(daily, daily.length - 2));
  return {
    key: `${ex}:${meta.id}`, ex, id: meta.id, base: meta.base, cat: meta.cat,
    dayT: bar.t, hi: bar.h, lo: bar.l, open: bar.o, close: bar.c,
    vx: +p.vx.toFixed(2), pattern: p.pattern,
    chgDay: +pct(bar.c, bar.o).toFixed(2),
    quiet: q.quiet, qlim: q.lim, atrp: q.atr,       /* 量增價平 */
    addedAt: nowMs, lastBarT: bar.t + D - H4, status: 'pending'
  };
}

let _patternScan = null;
export function setPatternScan(fn) { _patternScan = fn; }
function patternScanSafe(daily, nowMs) {
  try { return _patternScan ? _patternScan(daily, nowMs) : null; } catch { return null; }
}

/** 把新候選併進清單；持倉中的標的不重複加入，等待中的換成較新的爆量日 */
export function mergeCandidates(state, cands, cfg = CONFIG) {
  const openKeys = new Set(state.open.map(x => x.key));
  const byKey = new Map(state.pending.map(x => [x.key, x]));
  const added = [];
  for (const c of cands) {
    if (openKeys.has(c.key)) continue;
    const old = byKey.get(c.key);
    if (old && old.dayT >= c.dayT) continue;
    byKey.set(c.key, c);
    added.push(c);
  }
  let pending = [...byKey.values()];
  if (pending.length > cfg.maxPending) {
    pending.sort((a, b) => b.dayT - a.dayT || b.vx - a.vx);
    pending = pending.slice(0, cfg.maxPending);
  }
  state.pending = pending;
  const kept = new Set(pending.map(x => x.key));
  return added.filter(c => kept.has(c.key));
}

/* ---------------- 每輪：推進狀態 ---------------- */
function makePlan(c, side, bar, cfg) {
  const entry = bar.c;
  const stop = side === 'long' ? c.lo : c.hi;
  const risk = Math.abs(entry - stop);
  const dir = side === 'long' ? 1 : -1;
  const range = c.hi - c.lo;
  const level = side === 'long' ? c.hi : c.lo;
  const riskPct = risk / entry * 100;
  const flags = [];
  const maxR = cfg.maxRiskPct[c.cat] ?? cfg.maxRiskPct.crypto;
  if (riskPct > maxR) flags.push(`停損距離 ${riskPct.toFixed(1)}% 超過 ${maxR}%：降倉或放棄`);
  if (Math.abs(entry - level) > range * cfg.chaseRange) flags.push('收盤已遠離觸發價：不追，等回測觸發價再進');
  return {
    ...c, status: 'open', side, level,
    entry, stop, risk, riskPct: +riskPct.toFixed(2),
    t1: entry + dir * cfg.t1R * risk, t2: entry + dir * cfg.t2R * risk,
    trigT: bar.t + H4, trigBarT: bar.t, t1Hit: false, mfeR: 0, maeR: 0, flags
  };
}

function closeTrade(p, outcome, exitPrice, exitT) {
  const dir = p.side === 'long' ? 1 : -1;
  const r = dir * (exitPrice - p.entry) / p.risk;
  return { ...p, status: 'closed', outcome, exit: exitPrice, exitT, r: +r.toFixed(2) };
}

/**
 * 依序吃進「已收盤」4H K，推進單一標的狀態。
 * 回傳 {item, events}；item.status 可能是 pending / open / closed / expired
 */
export function advance(item, bars4h, nowMs, cfg = CONFIG) {
  const events = [];
  let it = item;
  const closedBars = bars4h.filter(b => b.t + H4 <= nowMs && b.t > it.lastBarT && b.t >= it.dayT + D);
  for (const b of closedBars) {
    if (it.status === 'pending') {
      if (b.c > it.hi) { it = makePlan(it, 'long', b, cfg); events.push({ type: 'trigger', item: it }); }
      else if (b.c < it.lo) { it = makePlan(it, 'short', b, cfg); events.push({ type: 'trigger', item: it }); }
      it.lastBarT = b.t;
      continue;
    }
    if (it.status !== 'open') break;
    if (b.t === it.trigBarT) { it.lastBarT = b.t; continue; }
    const L = it.side === 'long';
    const fav = L ? (b.h - it.entry) / it.risk : (it.entry - b.l) / it.risk;
    const adv = L ? (b.l - it.entry) / it.risk : (it.entry - b.h) / it.risk;
    it.mfeR = Math.max(it.mfeR, +fav.toFixed(2));
    it.maeR = Math.min(it.maeR, +adv.toFixed(2));
    const hitStop = L ? b.l <= it.stop : b.h >= it.stop;
    const hitT2 = L ? b.h >= it.t2 : b.l <= it.t2;
    const hitT1 = L ? b.h >= it.t1 : b.l <= it.t1;
    it.lastBarT = b.t;
    /* 同一根 K 同時碰到停損與目標時，保守算停損 */
    if (hitStop) { it = closeTrade(it, 'stop', it.stop, b.t + H4); events.push({ type: 'close', item: it }); break; }
    if (hitT2) { it = closeTrade(it, 't2', it.t2, b.t + H4); events.push({ type: 'close', item: it }); break; }
    if (hitT1 && !it.t1Hit) { it = { ...it, t1Hit: true }; events.push({ type: 't1', item: it }); }
    if (b.t + H4 >= it.trigT + cfg.holdDays * D) {
      it = closeTrade(it, 'timeout', b.c, b.t + H4); events.push({ type: 'close', item: it }); break;
    }
  }
  if (it.status === 'pending' && nowMs >= it.dayT + D + cfg.expiryDays * D) {
    it = { ...it, status: 'expired' };
  }
  /* 通知當下的現價＝最近一根已收盤 4H K 的收盤價 */
  const px = closedBars.length ? closedBars[closedBars.length - 1].c : null;
  for (const e of events) e.px = px;
  return { item: it, events };
}

/** 一次推進整份清單。fetch4h(item) → bars 或 null（抓不到就原樣保留） */
export async function advanceAll(state, fetch4h, nowMs, cfg = CONFIG) {
  const events = [], warnings = [];
  const pending = [], open = [];
  for (const item of [...state.open, ...state.pending]) {
    let bars = null;
    try { bars = await fetch4h(item); } catch { bars = null; }
    if (!bars) {
      warnings.push(`${item.base}（${item.ex}）4H K 線取得失敗，本輪沿用舊狀態`);
      (item.status === 'open' ? open : pending).push(item);
      continue;
    }
    const r = advance(item, bars, nowMs, cfg);
    events.push(...r.events);
    if (r.item.status === 'open') open.push(r.item);
    else if (r.item.status === 'pending') pending.push(r.item);
    else if (r.item.status === 'closed') state.closed.push(slimClosed(r.item));
    else if (r.item.status === 'expired') state.counters.expired++;
  }
  state.open = open;
  state.pending = pending;
  if (state.closed.length > cfg.maxClosedKept) state.closed = state.closed.slice(-cfg.maxClosedKept);
  state.closed.sort((a, b) => a.exitT - b.exitT);
  return { events, warnings };
}

/* 結算後只留統計與列表需要的欄位，控制 Issue 本文大小 */
export function slimClosed(p) {
  const k = ['base', 'cat', 'ex', 'id', 'side', 'dayT', 'vx', 'entry', 'stop', 'exit', 'exitT', 'trigT', 'outcome', 'r', 'mfeR', 'maeR', 'riskPct'];
  const o = {}; k.forEach(x => { o[x] = p[x]; }); o.flagged = !!(p.flags && p.flags.length);
  return o;
}

/* ---------------- 統計 ---------------- */
export function stats(closed) {
  const n = closed.length;
  if (!n) return { n: 0 };
  const wins = closed.filter(x => x.r > 0).length;
  const sumR = closed.reduce((s, x) => s + x.r, 0);
  const by = k => {
    const o = {};
    closed.forEach(x => { const g = o[x[k]] ||= { n: 0, w: 0, r: 0 }; g.n++; g.r += x.r; if (x.r > 0) g.w++; });
    return o;
  };
  return { n, winRate: wins / n * 100, avgR: sumR / n, sumR, bySide: by('side'), byCat: by('cat') };
}

/* ---------------- 文字輸出 ---------------- */
const SIDE = { long: '做多', short: '做空' };
const OUT = { stop: '停損出場', t2: '達 T2 出場', timeout: '逾時以收盤結算' };

export function triggerText(p, cfg = CONFIG) {
  const L = p.side === 'long';
  const lines = [
    `【觸發 ${SIDE[p.side]}】${tvItem(p)}（${CAT[p.cat] || p.cat}，${EXL[p.ex] || p.ex}）`,
    `4H 收盤 ${fmtP(p.entry)} ${L ? '站上' : '跌破'}爆量日（${md(p.dayT)}，${p.vx}x）${L ? '高點' : '低點'} ${fmtP(p.level)}`,
    `進場：${fmtP(p.entry)}，或回測 ${fmtP(p.level)} 附近`,
    `停損：${fmtP(p.stop)}（爆量日${L ? '低點' : '高點'}，距離 ${p.riskPct.toFixed(1)}%）`,
    `T1 ${fmtP(p.t1)}（${cfg.t1R}R）｜T2 ${fmtP(p.t2)}（${cfg.t2R}R）`
  ];
  p.flags.forEach(f => lines.push(`注意：${f}`));
  if (p.cat === 'stock') lines.push('訊號來自代幣化股票永續合約；下正股前先確認近期有沒有財報');
  lines.push(`追蹤到 ${tpe(p.trigT + cfg.holdDays * D, false)}，碰停損或 T2 會再通知`);
  return lines.join('\n');
}

export function eventText(e, cfg = CONFIG) {
  const p = e.item;
  if (e.type === 'trigger') return triggerText(p, cfg);
  if (e.type === 't1') return `【T1】${tvItem(p)} ${SIDE[p.side]} 已達 T1 ${fmtP(p.t1)}（+${cfg.t1R}R），停損 ${fmtP(p.stop)} 不變｜現價 ${e.px ? fmtP(e.px) : '—'}`;
  return `【結算】${tvItem(p)} ${SIDE[p.side]}：${OUT[p.outcome]} ${fmtP(p.exit)}，${p.r >= 0 ? '+' : ''}${p.r.toFixed(2)}R（進場 ${fmtP(p.entry)}）｜現價 ${e.px ? fmtP(e.px) : '—'}`;
}

function statLine(s) {
  if (!s.n) return '已結算 0 筆';
  return `已結算 ${s.n} 筆｜勝率 ${s.winRate.toFixed(0)}%｜平均 ${s.avgR >= 0 ? '+' : ''}${s.avgR.toFixed(2)}R`;
}

export function dailyText({ nowMs, ex: exKey, exLabel, universe, added, rally, state, issueUrl, warnings }, cfg = CONFIG) {
  const lines = [`訊號掃描台｜每日報告 ${tpe(nowMs)} 台灣時間（${exLabel}）`];
  lines.push(`掃描 ${universe.total} 檔（加密 ${universe.crypto}／股票 ${universe.stock}／商品 ${universe.comm}）`);
  lines.push('');
  const top = added.slice().sort((a, b) => b.vx - a.vx).slice(0, cfg.newListMax);
  if (top.length) {
    const mx = typeof cfg.candMinX === 'number' ? `${cfg.candMinX}x` : `股票 ${cfg.candMinX.stock}x／加密 ${cfg.candMinX.crypto}x`;
    lines.push(`新進觀察清單 ${added.length} 檔（爆量 ≥ ${mx}，列前 ${top.length}）`);
    top.forEach(c => {
      lines.push(`${c.quiet ? '【量增價平】' : ''}${tvItem(c)}［${CAT[c.cat]}］${c.vx}x 收 ${fmtP(c.close)}（${sgn(c.chgDay)}%）`);
      lines.push(`  多：4H 收盤 >${fmtP(c.hi)}｜空：4H 收盤 <${fmtP(c.lo)}`);
    });
  } else {
    lines.push('今天沒有新的爆量標的');
  }
  if (rally && rally.length) {
    lines.push('');
    lines.push(`起漲分數前 ${rally.length}（1H 模型，只供參考，不進清單）`);
    rally.forEach(r => lines.push(`${link(r.base, tvUrl(exKey, r.id, '60'))}［${CAT[r.cat]}］${r.score.toFixed(0)} 分｜24h ${sgn(r.chg24h)}%${r.reasons.length ? '｜' + r.reasons.map(x => x[0]).join('、') : ''}`));
  }
  lines.push('');
  lines.push(`觀察清單：等待觸發 ${state.pending.length}｜持倉中 ${state.open.length}`);
  lines.push(statLine(stats(state.closed)));
  if (warnings && warnings.length) lines.push(`資料警告 ${warnings.length} 則，見清單頁`);
  if (issueUrl) lines.push(issueUrl);
  return lines.join('\n');
}

export function hourlyText(events, issueUrl, cfg = CONFIG) {
  if (!events.length) return '';
  const parts = events.map(e => eventText(e, cfg));
  if (issueUrl) parts.push(issueUrl);
  return parts.join('\n\n');
}

export function issueMarkdown(state, { nowMs, warnings = [], lastDailyNote = '', pendingRows = Infinity }, cfg = CONFIG) {
  const L = [];
  L.push(`# 短線清單｜更新 ${tpe(nowMs)} 台灣時間`);
  L.push('');
  L.push('爆量日之後，4H 收盤站上爆量日高點觸發做多、跌破低點觸發做空；停損放在爆量日另一端，T1／T2 為 2R／3R。');
  L.push(`爆量日後 ${cfg.expiryDays} 天沒觸發就移除；觸發後最多追蹤 ${cfg.holdDays} 天。`);
  if (lastDailyNote) { L.push(''); L.push(lastDailyNote); }
  L.push('');
  L.push(`## 持倉中（${state.open.length}）`);
  if (state.open.length) {
    L.push('| 標的 | 方向 | 進場 | 停損 | T1 | T2 | 觸發時間 | 最大有利 | 備註 |');
    L.push('|---|---|---|---|---|---|---|---|---|');
    state.open.slice().sort((a, b) => b.trigT - a.trigT).forEach(p => L.push(
      `| ${tvItem(p)}［${CAT[p.cat]}］ | ${SIDE[p.side]} | ${fmtP(p.entry)} | ${fmtP(p.stop)}（${p.riskPct.toFixed(1)}%） | ${fmtP(p.t1)}${p.t1Hit ? ' ✓' : ''} | ${fmtP(p.t2)} | ${tpe(p.trigT)} | +${p.mfeR.toFixed(1)}R | ${p.flags.join('；') || ''} |`));
  } else L.push('無');
  L.push('');
  L.push(`## 等待觸發（${state.pending.length}）`);
  if (state.pending.length) {
    L.push('| 標的 | 爆量日 | 量倍數 | 當日漲跌 | 型態 | 做多觸發（4H 收盤 >） | 做空觸發（4H 收盤 <） | 到期 |');
    L.push('|---|---|---|---|---|---|---|---|');
    const rows = state.pending.slice().sort((a, b) => b.dayT - a.dayT || b.vx - a.vx);
    rows.slice(0, pendingRows).forEach(c => L.push(
      `| ${tvItem(c)}［${CAT[c.cat]}］ | ${md(c.dayT)} | ${c.vx}x | ${sgn(c.chgDay)}% | ${PATTERN[c.pattern] || c.pattern} | ${fmtP(c.hi)} | ${fmtP(c.lo)} | ${tpe(c.dayT + D + cfg.expiryDays * D, false)} |`));
    if (rows.length > pendingRows) L.push(`\n另有 ${rows.length - pendingRows} 檔未列出（本文長度上限），仍在追蹤中。`);
  } else L.push('無');
  L.push('');
  const s = stats(state.closed);
  L.push(`## 成績（${statLine(s)}；到期未觸發 ${state.counters.expired} 檔）`);
  if (s.n) {
    const row = (name, g) => g ? `| ${name} | ${g.n} | ${(g.w / g.n * 100).toFixed(0)}% | ${(g.r / g.n >= 0 ? '+' : '') + (g.r / g.n).toFixed(2)}R |` : null;
    L.push('| 分組 | 筆數 | 勝率 | 平均 |');
    L.push('|---|---|---|---|');
    [row('做多', s.bySide.long), row('做空', s.bySide.short), row('加密', s.byCat.crypto),
     row('股票', s.byCat.stock), row('商品', s.byCat.comm)].filter(Boolean).forEach(x => L.push(x));
    L.push('');
    L.push('最近 15 筆：');
    L.push('| 標的 | 方向 | 進場 | 出場 | 結果 | R | 結算時間 |');
    L.push('|---|---|---|---|---|---|---|');
    state.closed.slice(-15).reverse().forEach(p => L.push(
      `| ${link(p.base, tvUrl(p.ex, p.id, '240'))} | ${SIDE[p.side]} | ${fmtP(p.entry)} | ${fmtP(p.exit)} | ${OUT[p.outcome]} | ${p.r >= 0 ? '+' : ''}${p.r.toFixed(2)} | ${tpe(p.exitT)} |`));
  }
  if (warnings.length) {
    L.push('');
    L.push(`## 資料警告（${warnings.length}）`);
    warnings.slice(0, 30).forEach(w => L.push(`- ${w}`));
  }
  L.push('');
  L.push('> 規則式篩選，不是投資建議。每筆先確認停損距離與部位大小再下單。');
  return L.join('\n');
}

const PATTERN = {
  breakout: '突破區間', breakdown: '跌破區間', squeeze: '壓縮打底', base: '區間整理',
  trend_up: '上升趨勢', trend_dn: '下降趨勢', none: '—'
};

/* 狀態以 gzip＋base64 存在 Issue 本文最後的 HTML 註解裡，GitHub 頁面上看不到 */
const MARK_A = '<!-- WATCHLIST_STATE', MARK_B = 'WATCHLIST_STATE -->';
export function embedState(markdown, state) {
  const packed = zlib.gzipSync(Buffer.from(JSON.stringify(compactState(state)))).toString('base64');
  return `${markdown}\n\n${MARK_A}\n${packed}\n${MARK_B}\n`;
}
export function extractState(body) {
  if (!body) return emptyState();
  const a = body.indexOf(MARK_A), b = body.indexOf(MARK_B);
  if (a < 0 || b < 0) return emptyState();
  const raw = body.slice(a + MARK_A.length, b).trim();
  try {
    const json = raw.startsWith('{') ? raw : zlib.gunzipSync(Buffer.from(raw, 'base64')).toString('utf8');
    const s = JSON.parse(json);
    return { ...emptyState(), ...s, counters: { expired: 0, ...(s.counters || {}) } };
  } catch { return null; }
}
function compactState(s) {
  return JSON.parse(JSON.stringify(s, (k, v) => typeof v === 'number' && !Number.isInteger(v) ? +v.toPrecision(8) : v));
}

/* Issue 本文上限 65536 字元；等待清單太長時只列前幾檔，狀態仍完整保存 */
export const BODY_LIMIT = 60000;
