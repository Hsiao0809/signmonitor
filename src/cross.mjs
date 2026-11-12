/* ============================================================
   4H 金叉（Binance 現貨 USDT）：EMA20 由 ≤ SMA30 上穿至 > SMA30
   每根 4H K 收盤後判斷剛收盤的那根（GitHub 漏跑時最多補 3 根）。
     A 級（推播＋追蹤）：金叉當根收盤 > SMA200，且當根成交額 ≥ 前 20 根平均 1.5 倍
     B 級（只在網頁）：其他新金叉，保留 48 小時
   A 級追蹤 42 根 4H K（7 天）：仍成立／已死叉、報酬、最大漲跌；死叉不推播，只更新網頁。
   回測（2026-05～11，122 檔，進場金叉收盤、死叉收盤出場、扣 0.2%）：
     全部金叉 每筆 +0.76%、勝率 27%；A 級條件 每筆 +4.65%、勝率 39%，但利潤集中在少數大波段。
   ============================================================ */
import zlib from 'node:zlib';
import { tpe, fmtP, link } from './tracker.mjs';
import { weekendClosed } from './hourly.mjs';

const H4 = 4 * 3600e3, D1 = 24 * 3600e3;

export const CROSS = {
  tf: '4h', barMs: H4, label: '4H', tv: '240', tag: 'CROSS_STATE',   // 時間週期：Binance interval、一根多長、顯示名稱、TradingView interval、Issue 狀態標記
  fast: 20, slow: 30, trend: 200, volLen: 20,
  minVolX: 1.5,            // A 級：金叉當根成交額 ≥ 前 20 根平均幾倍
  minQv24h: 5e5,           // 24h 成交額下限（USDT）
  trackBars: 42,           // A 級追蹤幾根 4H K
  stopBars: 6,             // 參考停損：金叉當根往前（含）幾根的最低點
  keepBHours: 48,          // B 級在網頁保留幾小時
  maxCatchUp: 3,           // GitHub 漏跑時最多補判斷幾根
  bars: 300,               // 每檔抓幾根 4H K（EMA 暖身＋SMA200）
  keepClosed: 300,
  maxLines: 15,
  /* 不是一般幣：穩定幣、包裝幣、黃金代幣。另外用價格波動自動排除像穩定幣的標的 */
  exclude: ['USDC', 'FDUSD', 'TUSD', 'USDP', 'DAI', 'BUSD', 'USD1', 'RLUSD', 'RWUSD', 'U', 'XUSD', 'BFUSD', 'PYUSD',
    'USDE', 'USDEB', 'EUR', 'EURI', 'AEUR', 'EURC', 'WBTC', 'WBETH', 'BETH', 'PAXG', 'XAUT']
};

/* 日線金叉：同樣 EMA20／SMA30。日線 K 以 UTC 00:00 開收（台灣 08:00 收盤）。
   A 級條件沿用 4H（收盤 > SMA200 且量 ≥ 前 20 日平均 1.5 倍）；上市不足 200 日算不出 SMA200 → 歸 B 級。
   追蹤 30 根日線；B 級只在網頁保留 7 天。日線沒有回測，成績事後累積在 Issue「金叉清單（日線）」。 */
export const CROSS_D = { ...CROSS, tf: '1d', barMs: D1, label: '日線', tv: 'D', tag: 'CROSSD_STATE', trackBars: 30, keepBHours: 168 };

export const barOpen = (nowMs, cfg = CROSS) => Math.floor(nowMs / cfg.barMs) * cfg.barMs - cfg.barMs;   /* 最近一根已收盤 K 的開始時間 */

export function emptyCross() { return { version: 1, lastBar: null, failBar: null, universe: 0, active: [], recentB: [], closed: [] }; }

/* ---------------- 指標 ---------------- */
export function indicators(bars, cfg = CROSS) {
  const n = bars.length, ema = new Array(n), sma = new Array(n).fill(null), sma200 = new Array(n).fill(null), vavg = new Array(n).fill(null);
  const k = 2 / (cfg.fast + 1);
  let s30 = 0, s200 = 0, sv = 0;
  for (let i = 0; i < n; i++) {
    const c = bars[i].c;
    ema[i] = i === 0 ? c : c * k + ema[i - 1] * (1 - k);
    s30 += c; if (i >= cfg.slow) s30 -= bars[i - cfg.slow].c; if (i >= cfg.slow - 1) sma[i] = s30 / cfg.slow;
    s200 += c; if (i >= cfg.trend) s200 -= bars[i - cfg.trend].c; if (i >= cfg.trend - 1) sma200[i] = s200 / cfg.trend;
    if (i >= cfg.volLen) vavg[i] = sv / cfg.volLen;            /* 前 20 根平均（不含當根） */
    sv += bars[i].qv; if (i >= cfg.volLen) sv -= bars[i - cfg.volLen].qv;
  }
  return { ema, sma, sma200, vavg };
}
const up = (I, i) => i > 0 && I.sma[i] != null && I.sma[i - 1] != null && I.ema[i] > I.sma[i] && I.ema[i - 1] <= I.sma[i - 1];
const down = (I, i) => i > 0 && I.sma[i] != null && I.ema[i] < I.sma[i] && I.ema[i - 1] >= I.sma[i - 1];

/* 價格幾乎不動（穩定幣類）：最近 60 根高低差 < 2% 且價格在 1 附近 */
export function stableLike(bars) {
  const w = bars.slice(-60);
  if (w.length < 20) return false;
  const hi = Math.max(...w.map(b => b.h)), lo = Math.min(...w.map(b => b.l));
  return hi / lo < 1.02 && Math.abs(w[w.length - 1].c - 1) < 0.05;
}
export function isExcludedBase(base, cfg = CROSS) { return cfg.exclude.includes(base); }

/**
 * meta：{ sym, base, stock, qv24h }，bars：已收盤 4H K（由舊到新，{t,o,h,l,c,qv}）
 * 回傳 bars 中開始時間 = T 那根的金叉資訊，沒有金叉回傳 null
 */
export function crossAt(meta, bars, T, cfg = CROSS) {
  const i = bars.findIndex(b => b.t === T);
  if (i < 1) return null;
  const I = indicators(bars, cfg);
  if (!up(I, i)) return null;
  const b = bars[i];
  const volx = I.vavg[i] ? b.qv / I.vavg[i] : null;
  const s200 = I.sma200[i];
  const lowN = Math.min(...bars.slice(Math.max(0, i - cfg.stopBars + 1), i + 1).map(x => x.l));
  const reasons = [];
  if (s200 == null) reasons.push('上市不足 200 根');
  else if (!(b.c > s200)) reasons.push('收盤在 SMA200 下方');
  if (!(volx >= cfg.minVolX)) reasons.push(`量 ${volx == null ? '—' : volx.toFixed(1)}x 未達 ${cfg.minVolX}x`);
  return {
    key: `${meta.sym}:${T}`, sym: meta.sym, base: meta.base, stock: !!meta.stock, t: T,
    grade: reasons.length ? 'B' : 'A', reasons,
    close: b.c, ema: I.ema[i], sma: I.sma[i], sma200: s200,
    spread: (I.ema[i] / I.sma[i] - 1) * 100,
    px200: s200 ? (b.c / s200 - 1) * 100 : null,
    volx: volx == null ? null : +volx.toFixed(2),
    stopPx: lowN, stopPct: (1 - lowN / b.c) * 100,
    qv24h: meta.qv24h
  };
}

/* A 級追蹤：用金叉之後已收盤的 4H K 重新計算現況 */
export function trackItem(it, bars, cfg = CROSS) {
  const i = bars.findIndex(b => b.t === it.t);
  if (i < 0) return it;
  const I = indicators(bars, cfg);
  const post = bars.slice(i + 1, i + 1 + cfg.trackBars);
  const lastIdx = i + post.length;
  const last = bars[lastIdx];
  let dead = null;
  for (let j = i + 1; j <= lastIdx; j++) if (down(I, j)) { dead = j; break; }
  const hi = post.length ? Math.max(...post.map(b => b.h)) : it.close;
  const lo = post.length ? Math.min(...post.map(b => b.l)) : it.close;
  return {
    ...it,
    bars: post.length, last: last.c, lastT: last.t,
    ret: (last.c / it.close - 1) * 100,
    mfe: Math.max(0, (hi / it.close - 1) * 100), mae: Math.min(0, (lo / it.close - 1) * 100),
    still: I.ema[lastIdx] > I.sma[lastIdx],
    deadT: dead != null ? bars[dead].t : null,
    deadRet: dead != null ? (bars[dead].c / it.close - 1) * 100 : null
  };
}

/**
 * 每輪：targets＝要判斷的 4H K 開始時間（由舊到新），found＝這幾根找到的金叉
 * 更新 state，回傳 { newA, newB, closed }
 */
export function applyScan(state, found, latestT, nowMs, cfg = CROSS) {
  const known = new Set([...state.active, ...state.closed].map(x => x.key));
  const newA = [], newB = [];
  for (const c of found) {
    if (known.has(c.key)) continue;
    const item = { ...c, late: Math.round((latestT - c.t) / cfg.barMs), closedMkt: c.stock && weekendClosed(c.t + cfg.barMs, 'stock') };
    if (c.grade === 'A') { newA.push(item); state.active.push({ ...item, bars: 0, last: c.close, lastT: c.t, ret: 0, mfe: 0, mae: 0, still: true, deadT: null, deadRet: null }); }
    else newB.push(item);
  }
  const bKeys = new Set(state.recentB.map(x => x.key));
  state.recentB = [...newB.filter(x => !bKeys.has(x.key)), ...state.recentB]
    .filter(x => nowMs - (x.t + cfg.barMs) < cfg.keepBHours * 3600e3).slice(0, 300);
  const closed = [];
  state.active = state.active.filter(it => {
    if ((it.bars || 0) < cfg.trackBars) return true;
    const exitRet = it.deadRet != null ? it.deadRet : it.ret;
    const done = { ...pickClosed(it), exitRet, endT: it.lastT };
    closed.push(done);
    return false;
  });
  state.closed = [...state.closed, ...closed].slice(-cfg.keepClosed);
  state.lastBar = latestT;
  sortActive(state);
  return { newA: sortItems(newA), newB, closed };
}
function pickClosed(it) {
  const k = ['key', 'sym', 'base', 'stock', 't', 'close', 'volx', 'px200', 'spread', 'ret', 'mfe', 'mae', 'deadT', 'deadRet'];
  return Object.fromEntries(k.map(x => [x, it[x]]));
}
const sortItems = a => a.sort((x, y) => (x.stock - y.stock) || (y.volx || 0) - (x.volx || 0));
export function sortActive(state) { state.active.sort((a, b) => (b.t - a.t) || (a.stock - b.stock) || (b.volx || 0) - (a.volx || 0)); }

/* 已結算成績：死叉出場（沒死叉就用 42 根後收盤） */
export function crossStats(closed) {
  if (!closed.length) return null;
  const r = closed.map(x => x.exitRet);
  const wins = r.filter(v => v > 0), loss = r.filter(v => v < 0);
  return {
    n: r.length, win: wins.length / r.length,
    avg: r.reduce((s, v) => s + v, 0) / r.length,
    pf: loss.length ? wins.reduce((s, v) => s + v, 0) / -loss.reduce((s, v) => s + v, 0) : null
  };
}

/* ---------------- 文字 ---------------- */
export const binanceTv = (sym, cfg = CROSS) => `https://www.tradingview.com/chart/?symbol=${encodeURIComponent('BINANCE:' + sym)}&interval=${cfg.tv}`;
const money = v => v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${(v / 1e3).toFixed(0)}K`;
const sg = (v, d = 1) => v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;
const barLabel = (t, cfg = CROSS) => cfg.barMs >= D1 ? `${tpe(t).slice(5, 16)}–${tpe(t + cfg.barMs).slice(5, 16)}` : `${tpe(t).slice(5, 16)}–${tpe(t + cfg.barMs).slice(11, 16)}`;
const lab = cfg => cfg.tf === '4h' ? `${cfg.label} ` : cfg.label;   /* 4H 與中文之間留空格，日線不留 */
const tags = x => `${x.stock ? '［代幣化股］' : ''}${x.closedMkt ? '【週末休市】' : ''}${x.late ? `（延遲 ${x.late} 根）` : ''}`;

export function crossAlertText(newA, newB, latestT, url = '', cfg = CROSS, nth = null) {
  if (!newA.length) return '';
  const L = [`【${lab(cfg)}金叉】${barLabel(latestT, cfg)} 台灣時間收盤（A 級 ${newA.length} 檔）`];
  newA.slice(0, cfg.maxLines).forEach(x => {
    L.push(`${link(x.base, binanceTv(x.sym, cfg))}${tags(x)} 收 ${fmtP(x.close)}｜量 ${x.volx}x｜距 SMA200 ${sg(x.px200)}${nth ? `｜今日第 ${nth(x.base)} 次` : ''}`);
    L.push(`  上穿 ${sg(x.spread, 2)}｜近 ${cfg.stopBars} 根低點 ${fmtP(x.stopPx)}（-${x.stopPct.toFixed(1)}%）｜24h 成交額 ${money(x.qv24h)}`);
  });
  if (newA.length > cfg.maxLines) L.push(`另有 ${newA.length - cfg.maxLines} 檔，見清單頁`);
  if (newA.some(x => x.stock)) L.push('［代幣化股］回測表現為負，只供參考');
  if (cfg.tf === '1d') L.push('日線金叉尚無回測，成績上線後才累積，只供參考。');
  L.push(`出場參考：${lab(cfg)}死叉（EMA20 跌回 SMA30 下方）。${newB.length ? `另有 ${newB.length} 檔 B 級只在網頁顯示。` : ''}`);
  if (url) L.push(url);
  return L.join('\n');
}

export function crossMarkdown(state, { nowMs, warnings = [], note = '' }, cfg = CROSS) {
  const L = [`# ${lab(cfg)}金叉｜更新 ${tpe(nowMs)} 台灣時間`, ''];
  L.push(`Binance 現貨 USDT、24h 成交額 ≥ ${cfg.minQv24h / 1e4} 萬 USDT，排除穩定幣、包裝幣、黃金代幣。剛收盤的 ${cfg.label} K 出現 EMA${cfg.fast} 上穿 SMA${cfg.slow}：`);
  L.push(`- **A 級**（推播、追蹤 ${cfg.trackBars} 根${cfg.tf === '1d' ? '日線' : ''}）：收盤 > SMA${cfg.trend}，且成交額 ≥ 前 ${cfg.volLen} 根平均 ${cfg.minVolX} 倍`);
  L.push(`- **B 級**（只列出，保留 ${cfg.keepBHours} 小時）：其他新金叉`);
  if (note) { L.push(''); L.push(note); }
  L.push('');
  L.push(`## 追蹤中 A 級（${state.active.length}）`);
  if (state.active.length) {
    L.push('| 金叉 K | 標的 | 金叉收盤 | 現價 | 報酬 | 最大漲／跌 | 狀態 | 量 | 距SMA200 | 根數 |');
    L.push('|---|---|---|---|---|---|---|---|---|---|');
    state.active.forEach(x => L.push(`| ${tpe(x.t).slice(5, 16)} | ${link(x.base, binanceTv(x.sym, cfg))}${x.stock ? '［代幣化股］' : ''} | ${fmtP(x.close)} | ${fmtP(x.last)} | ${sg(x.ret)} | ${sg(x.mfe)}／${sg(x.mae)} | ${x.deadT ? `已死叉（${sg(x.deadRet)}）` : '仍成立'} | ${x.volx}x | ${sg(x.px200)} | ${x.bars}/${cfg.trackBars} |`));
  } else L.push('無');
  L.push('');
  L.push(`## B 級（最近 ${cfg.keepBHours} 小時，${state.recentB.length}）`);
  if (state.recentB.length) {
    L.push('| 金叉 K | 標的 | 收盤 | 量 | 距SMA200 | 原因 |');
    L.push('|---|---|---|---|---|---|');
    state.recentB.slice(0, 150).forEach(x => L.push(`| ${tpe(x.t).slice(5, 16)} | ${link(x.base, binanceTv(x.sym, cfg))}${x.stock ? '［代幣化股］' : ''} | ${fmtP(x.close)} | ${x.volx == null ? '—' : x.volx + 'x'} | ${sg(x.px200)} | ${x.reasons.join('、')} |`));
  } else L.push('無');
  L.push('');
  const st = crossStats(state.closed);
  L.push(`## 成績（已結算 ${state.closed.length}）`);
  if (st) {
    L.push(`死叉收盤出場（${cfg.trackBars} 根內沒死叉就用第 ${cfg.trackBars} 根收盤），未扣手續費：${st.n} 筆，勝率 ${(st.win * 100).toFixed(0)}%，每筆平均 ${sg(st.avg, 2)}${st.pf != null ? `，獲利因子 ${st.pf.toFixed(2)}` : ''}`);
    L.push('');
    L.push('| 金叉 K | 標的 | 出場報酬 | 最大漲／跌 |');
    L.push('|---|---|---|---|');
    state.closed.slice(-30).reverse().forEach(x => L.push(`| ${tpe(x.t).slice(5, 16)} | ${link(x.base, binanceTv(x.sym, cfg))} | ${sg(x.exitRet)}${x.deadT ? '（死叉）' : ''} | ${sg(x.mfe)}／${sg(x.mae)} |`));
  } else L.push('尚無');
  if (warnings.length) { L.push(''); L.push(`## 資料警告（${warnings.length}）`); warnings.slice(0, 20).forEach(w => L.push(`- ${w}`)); }
  L.push('');
  L.push('> 規則式篩選，不是投資建議。');
  return L.join('\n');
}

const compact = s => JSON.parse(JSON.stringify(s, (k, v) => typeof v === 'number' && !Number.isInteger(v) ? +v.toPrecision(7) : v));
export function embedCross(md, state, cfg = CROSS) {
  return `${md}\n\n<!-- ${cfg.tag}\n${zlib.gzipSync(Buffer.from(JSON.stringify(compact(state)))).toString('base64')}\n${cfg.tag} -->\n`;
}
export function extractCross(body, cfg = CROSS) {
  if (!body) return emptyCross();
  const MA = `<!-- ${cfg.tag}`, MB = `${cfg.tag} -->`;
  const a = body.indexOf(MA), b = body.indexOf(MB);
  if (a < 0 || b < 0) return emptyCross();
  try { return { ...emptyCross(), ...JSON.parse(zlib.gunzipSync(Buffer.from(body.slice(a + MA.length, b).trim(), 'base64')).toString('utf8')) }; }
  catch { return null; }
}
