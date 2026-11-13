/* ============================================================
   做空候選（各交易所漲幅榜）
   來源：OKX、Bitget 合約、Bybit 合約（WebSocket）、Binance 現貨的 24h 漲幅榜。
   名單條件（任一家達標就列入，其他家有掛牌的一併顯示）：
     該家 24h 漲幅排前 20、漲幅 ≥ 30%、24h 成交額 ≥ 50 萬 USDT
   只是漲幅高不是進場訊號：暴漲幣可以繼續漲好幾倍。所以另外判斷「轉弱」，轉弱才推播：
     已收盤的最後一根 K，收盤跌破「近期高點之後整段回檔的最低點」，而且它的最高點比近期高點低（高點沒有再創）；
     1H 看近 24 根、4H 看近 12 根。（2026-11-13 前是「跌破前一根最低點」，現在只並行記錄給訊號成績比較）
   標籤只標不過濾（跟爆量規則一致）：
     24h 內爆量／7 天內沉睡甦醒／布局清單追蹤中 → 可能是剛啟動的多方，標「勿空」；
     名單照列，但這類轉弱只記在網頁的轉弱紀錄（標「未推播」），不推播
     只有單一交易所大漲、停損過寬（以 24h 高點當停損，距離 > 10%）、無合約、沒有 OKX／Bitget K 線
   轉弱同一檔：1H 12 小時、4H 24 小時只通知一次，同一根 K 不重複。
   沒有回測，只當觀察。
   ============================================================ */
import zlib from 'node:zlib';
import { tpe, fmtP, link, tvUrl } from './tracker.mjs';

const H = 3600e3, D = 24 * H;
export const GAINER = {
  minChg: 30, topN: 20, minQv: 5e5,
  lookback: { '1h': 24, '4h': 12 },
  minBars: { '1h': 8, '4h': 5 },
  coolH: { '1h': 12, '4h': 24 },
  keepDays: 7, maxItems: 60, maxLines: 12, stopWide: 10,
  seenKeepH: 48, reentryH: 6
};
export const PERPS = ['okx', 'bitget', 'bybit'];
export const KLINE = ['okx', 'bitget'];   /* Bybit 的 K 線 API 擋雲端，判斷轉弱只用這兩家 */
const LABEL = { okx: 'OKX', bitget: 'Bitget', bybit: 'Bybit', binance: 'Binance 現貨' };
export const TAGS = {
  spike: '24 小時內爆量，可能剛啟動，勿空',
  wake: '7 天內沉睡甦醒，勿空',
  layout: '布局清單追蹤中，勿空',
  solo: '只有單一交易所大漲',
  wide: '停損過寬：降槓桿、縮倉或放棄',
  noperp: '沒有合約（Binance 現貨榜），不能做空',
  nok: '沒有 OKX／Bitget 合約，無法判斷轉弱'
};
const AVOID = ['spike', 'wake', 'layout'];
export const isAvoid = tags => (tags || []).some(t => AVOID.includes(t));

/* 1000PEPE、10000SATS 之類的合約名稱，跟現貨名稱對在一起 */
export function normBase(b) { return String(b || '').toUpperCase().replace(/^(?:1000000|100000|10000|1000)(?=[A-Z])/, ''); }

/**
 * boards：{ okx|bitget|bybit|binance: [{ base, id, last, chg(%), qv(USDT), cat }] }
 * excluded(base)：穩定幣、槓桿商品等不看的
 * 回傳名單（還沒有 K 線資料）：依最大漲幅由高到低
 */
export function mergeBoards(boards, cfg = GAINER, excluded = () => false) {
  const by = new Map(), qual = new Set();
  for (const [v, rows] of Object.entries(boards)) {
    const ok = (rows || []).filter(r => r && isFinite(r.chg) && r.last > 0 && isFinite(r.qv) && !excluded(r.base));
    ok.sort((a, b) => b.chg - a.chg);
    ok.forEach((r, i) => {
      const key = normBase(r.base);
      let it = by.get(key);
      if (!it) by.set(key, it = { key, base: r.base, cat: 'crypto', ex: {} });
      const hot = i < cfg.topN && r.chg >= cfg.minChg && r.qv >= cfg.minQv;
      it.ex[v] = { id: r.id, last: r.last, chg: +r.chg.toFixed(1), qv: Math.round(r.qv), rank: i + 1, ...(hot ? { hot: 1 } : {}) };
      if (r.cat && r.cat !== 'crypto' && PERPS.includes(v)) it.cat = r.cat;
      if (hot) qual.add(key);
    });
  }
  const items = [];
  for (const key of qual) {
    const it = by.get(key), ex = it.ex, vs = Object.keys(ex);
    const perps = PERPS.filter(v => ex[v]).sort((a, b) => ex[b].qv - ex[a].qv);
    const kl = KLINE.filter(v => ex[v]).sort((a, b) => ex[b].qv - ex[a].qv);
    it.chgMax = Math.max(...vs.map(v => ex[v].chg));
    it.sv = perps[0] || null; it.sid = it.sv ? ex[it.sv].id : null;
    it.kex = kl[0] || null; it.kid = it.kex ? ex[it.kex].id : null;
    const pv = it.kex || it.sv || vs[0];
    it.px = ex[pv].last;
    it.qv = ex[it.sv || vs.sort((a, b) => ex[b].qv - ex[a].qv)[0]].qv;
    /* 顯示用的代號：優先用有合約那家的寫法 */
    if (it.sv) it.base = String(ex[it.sv].id).split('-')[0].replace(/USDT$/, '') || it.base;
    items.push(it);
  }
  items.sort((a, b) => b.chgMax - a.chgMax);
  return items.slice(0, cfg.maxItems);
}

/* ---------------- 轉弱 ---------------- */
const closedOf = (bars, tf, now) => {
  const ms = tf === '4h' ? 4 * H : H;
  return (bars || []).filter(b => b && isFinite(b.c) && isFinite(b.h) && isFinite(b.l) && b.t + ms <= now).sort((a, b) => a.t - b.t);
};

/**
 * 轉弱（2026-11-13 起推播用）：已收盤的最後一根 K，收盤跌破「近期高點之後整段回檔的最低點」，且最高點沒有再創。
 * 高點那根之後至少要有一根已收盤的 K（高點那根本身不算），才有回檔區間可以跌破。
 * 為什麼改：單根跌破前一根低點，在日 ATR 50% 以上的暴漲幣只是雜訊（2026-11-13 AKE 兩次轉弱都被軋）。
 * bars：[{t,o,h,l,c}]。回傳 null（沒轉弱／資料不足）或 { tf, t, c, brk, peak, drop }，brk＝被跌破的回檔低點
 */
export function weakOf(bars, tf, now, cfg = GAINER) {
  const closed = closedOf(bars, tf, now), n = closed.length;
  if (n < (cfg.minBars[tf] || 5)) return null;
  const last = closed[n - 1];
  let peak = -Infinity, pi = -1;
  for (let i = Math.max(0, n - 1 - cfg.lookback[tf]); i < n - 1; i++) if (closed[i].h >= peak) { peak = closed[i].h; pi = i; }
  if (!(last.h < peak) || pi >= n - 2) return null;
  let low = Infinity;
  for (let i = pi + 1; i < n - 1; i++) low = Math.min(low, closed[i].l);
  if (!(last.c < low)) return null;
  return { tf, t: last.t, c: last.c, brk: low, peak, drop: +((peak - last.c) / peak * 100).toFixed(1) };
}

/** 舊規則（2026-11-13 前推播用，現在只並行記錄給訊號成績比較）：收盤跌破前一根最低點，且最高點沒有再創 */
export function weakPrev(bars, tf, now, cfg = GAINER) {
  const closed = closedOf(bars, tf, now), n = closed.length;
  if (n < (cfg.minBars[tf] || 5)) return null;
  const last = closed[n - 1], prev = closed[n - 2];
  let peak = -Infinity;
  for (let i = Math.max(0, n - 1 - cfg.lookback[tf]); i < n - 1; i++) peak = Math.max(peak, closed[i].h);
  if (!(last.c < prev.l && last.h < peak)) return null;
  return { tf, t: last.t, c: last.c, brk: prev.l, peak, drop: +((peak - last.c) / peak * 100).toFixed(1) };
}

/** 把 K 線結果補進名單項目：weak（新規則）、weakOld（舊規則）、24h 高點、停損距離 */
export function enrich(it, bars1h, bars4h, now, cfg = GAINER) {
  const weak = {}, weakOld = {};
  const w1 = weakOf(bars1h, '1h', now, cfg), w4 = weakOf(bars4h, '4h', now, cfg);
  if (w1) weak['1h'] = w1;
  if (w4) weak['4h'] = w4;
  const o1 = weakPrev(bars1h, '1h', now, cfg), o4 = weakPrev(bars4h, '4h', now, cfg);
  if (o1) weakOld['1h'] = o1;
  if (o4) weakOld['4h'] = o4;
  it.weak = weak;
  it.weakOld = weakOld;
  const day = (bars1h || []).filter(b => isFinite(b.h) && b.t >= now - D);
  it.hi24 = day.length ? Math.max(...day.map(b => b.h)) : null;
  it.stopPct = it.hi24 && it.px > 0 ? +((it.hi24 / it.px - 1) * 100).toFixed(1) : null;
  return it;
}

/** 已有 K 線之後的標籤；ctx 見 contextOf */
export function tagsOf(it, ctx, cfg = GAINER) {
  const t = [];
  if (ctx?.spike?.has(it.key)) t.push('spike');
  if (ctx?.wake?.has(it.key)) t.push('wake');
  if (ctx?.layout?.has(it.key)) t.push('layout');
  const vs = Object.values(it.ex);
  if (vs.length >= 2 && vs.filter(x => x.chg >= it.chgMax * 0.5).length === 1) t.push('solo');
  if (it.stopPct != null && it.stopPct > cfg.stopWide) t.push('wide');
  if (!it.sv) t.push('noperp');
  else if (!it.kex) t.push('nok');
  return t;
}

/** 其他模組目前在追蹤的標的（做空要避開的） */
export function contextOf({ hstate, pstate, dstate, lstate } = {}, T) {
  const spike = new Set(), wake = new Set(), layout = new Set();
  for (const a of hstate?.recent || []) if (T - a.t < D) spike.add(normBase(a.base));
  for (const a of [...(pstate?.early || []), ...(pstate?.pre || [])]) if (T - a.t < 12 * H) spike.add(normBase(a.base));
  for (const e of dstate?.events || []) if (T - e.t < 7 * D) wake.add(normBase(e.base));
  for (const it of lstate?.active || []) layout.add(normBase(it.base));
  return { spike, wake, layout };
}

export function emptyGainer() { return { version: 1, lastHour: null, items: [], events: [], notified: {}, seen: {}, counts: {} }; }

/**
 * items：已 enrich＋tagsOf 的名單。更新 state（名單、上榜時間、轉弱紀錄），回傳本小時要通知的轉弱事件。
 * 同一檔 1H 與 4H 同時轉弱合成一筆（tfs）。
 */
export function applyScan(state, items, T, counts = {}, cfg = GAINER) {
  const out = [];
  for (const it of items) {
    const sn = state.seen[it.key];
    it.since = sn && T - sn.last <= cfg.reentryH * H ? sn.since : T;
    state.seen[it.key] = { since: it.since, last: T };
    const tfs = [];
    for (const tf of ['4h', '1h']) {
      const w = it.weak?.[tf];
      if (!w) continue;
      const k = `${it.key}|${tf}`, prev = state.notified[k];
      if (prev && (prev.bar === w.t || T - prev.at < cfg.coolH[tf] * H)) continue;
      tfs.push(tf);
      state.notified[k] = { bar: w.t, at: T };
    }
    if (!tfs.length) continue;
    const w = it.weak[tfs[0]];
    out.push({
      t: T, key: it.key, base: it.base, tfs, c: w.c, brk: w.brk, peak: w.peak, drop: w.drop,
      chg: it.chgMax, qv: it.qv, stop: it.stopPct, hi24: it.hi24, price: it.px, tags: it.tags,
      sv: it.sv, sid: it.sid, ex: Object.fromEntries(Object.entries(it.ex).map(([v, x]) => [v, x.chg])),
      rule: 'range', ...(isAvoid(it.tags) ? { muted: 1 } : {})
    });
  }
  out.sort((a, b) => b.chg - a.chg);
  state.events = [...out, ...state.events].filter(e => T - e.t < cfg.keepDays * D);
  for (const k of Object.keys(state.notified)) if (T - state.notified[k].at > cfg.keepDays * D) delete state.notified[k];
  for (const k of Object.keys(state.seen)) if (T - state.seen[k].last > cfg.seenKeepH * H) delete state.seen[k];
  state.items = items;
  state.counts = counts;
  state.lastHour = T;
  /* 有「勿空」標籤的轉弱只記在網頁（轉弱紀錄標「未推播」），不推播 */
  return out.filter(e => !e.muted);
}

/**
 * 新舊規則並行紀錄（給訊號成績比較）：每一輪把兩種規則各自的轉弱寫成一筆，不管有沒有推播。
 * 去重跟推播一樣：同一檔同一規則，1H 12 小時、4H 24 小時一次，同一根 K 不重複；1H 與 4H 同時成立合成一筆。
 * 回傳 [{ t, k: 'gnew'|'gold', b, key, tfs, c, brk, peak, avoid, src }]；去重狀態存在 state.shadow
 */
export function shadowOf(state, items, T, cfg = GAINER) {
  const sh = state.shadow || (state.shadow = {});
  const out = [];
  for (const it of items) {
    if (!it.kex || !it.kid) continue;
    for (const [k, field] of [['gnew', 'weak'], ['gold', 'weakOld']]) {
      const tfs = [];
      for (const tf of ['4h', '1h']) {
        const w = it[field]?.[tf];
        if (!w) continue;
        const key = `${it.key}|${k}|${tf}`, prev = sh[key];
        if (prev && (prev.bar === w.t || T - prev.at < cfg.coolH[tf] * H)) continue;
        tfs.push(tf);
        sh[key] = { bar: w.t, at: T };
      }
      if (!tfs.length) continue;
      const w = it[field][tfs[0]];
      out.push({ t: T, k, b: it.base, key: it.key, tfs, c: w.c, brk: w.brk, peak: w.peak, avoid: isAvoid(it.tags) ? 1 : 0, tags: it.tags || [], src: [it.kex, it.kid] });
    }
  }
  for (const k of Object.keys(sh)) if (T - sh[k].at > cfg.keepDays * D) delete sh[k];
  return out;
}

/* ---------------- 文字 ---------------- */
const pcs = v => (v == null || !isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(v >= 100 ? 0 : 1)}%`);
const money = v => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${Math.round(v / 1e3)}K`);
const hhmm = t => tpe(t).slice(11, 16);
const tfText = tfs => (tfs || []).map(t => t.toUpperCase()).join('＋');
export function tvOf(x) {
  if (x.sv && x.sid) return tvUrl(x.sv, x.sid, '60');
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(`BINANCE:${x.base}USDT`)}&interval=60`;
}
const exText = ex => Object.entries(ex || {}).map(([v, c]) => `${LABEL[v] || v} ${pcs(typeof c === 'object' ? c.chg : c)}`).join('／');
const tagText = tags => (tags || []).map(t => TAGS[t]).filter(Boolean);

export function gainerAlertText(events, T, url = '', cfg = GAINER, nth = null) {
  if (!events.length) return '';
  /* 每檔一個段落（空行隔開）：run.mjs 依空行切段，過長時從段落之間切開，不會把連結標記切斷 */
  const blocks = [`【做空候選・轉弱】${tpe(T).slice(5, 10)} ${hhmm(T)} 台灣時間（${events.length} 檔）`];
  events.slice(0, cfg.maxLines).forEach(e => {
    const L = [`${link(e.base, tvOf(e))} ${tfText(e.tfs)} 轉弱｜24h ${pcs(e.chg)}（${exText(e.ex)}）｜成交額 ${money(e.qv)}${nth ? `｜今日第 ${nth(e.base)} 次` : ''}`];
    L.push(`  收 ${fmtP(e.c)} 跌破${e.rule === 'range' ? '高點後回檔低點' : '前一根低'} ${fmtP(e.brk)}｜自高點回落 ${e.drop}%｜停損（24h 高）${e.hi24 ? fmtP(e.hi24) : '—'}${e.stop != null ? `（距現價 ${e.stop}%）` : ''}`);
    const tg = tagText(e.tags);
    if (tg.length) L.push(`  ${isAvoid(e.tags) ? '⚠ ' : ''}${tg.join('；')}`);
    blocks.push(L.join('\n'));
  });
  const foot = [];
  if (events.length > cfg.maxLines) foot.push(`另有 ${events.length - cfg.maxLines} 檔，見網頁`);
  foot.push('只標記、沒有回測；放空虧損沒有上限，進場前先設好停損。');
  if (url) foot.push(url);
  blocks.push(foot.join('\n'));
  return blocks.join('\n\n');
}

export function gainerMarkdown(state, { nowMs, warnings = [], note = '', rows = 80 }, cfg = GAINER) {
  const L = [`# 做空候選｜更新 ${tpe(nowMs)} 台灣時間`, ''];
  L.push(`各交易所 24h 漲幅榜（OKX、Bitget、Bybit 合約，Binance 現貨）。任一家漲幅排前 ${cfg.topN}、≥ ${cfg.minChg}%、24h 成交額 ≥ ${money(cfg.minQv)} USDT 就列入；漲幅高只是名單，不是進場訊號。`);
  L.push(`- **轉弱**才推播：已收盤的最後一根 K 收盤跌破「近期高點之後整段回檔的最低點」，且最高點沒有再創（1H 看近 ${cfg.lookback['1h']} 根、4H 看近 ${cfg.lookback['4h']} 根；高點之後至少要有一根已收盤的 K）。同一檔 1H ${cfg.coolH['1h']} 小時、4H ${cfg.coolH['4h']} 小時只通知一次`);
  L.push(`- 舊規則（跌破前一根最低點）2026-11-13 起停用推播，跟新規則一起並行記錄到訊號成績比較`);
  L.push(`- **勿空**標籤：24 小時內爆量、7 天內沉睡甦醒、布局清單追蹤中，可能是剛啟動的多方。名單照列；這類轉弱只記在轉弱紀錄（標「未推播」），不推播`);
  L.push(`- 停損距離＝24h 高點相對現價；超過 ${cfg.stopWide}% 標「停損過寬」（5 倍逐倉約反向 17–19% 強平，貼著強平線，要降槓桿或縮倉）`);
  L.push(`- 判斷轉弱只用 OKX、Bitget 的 K 線（Bybit 的 K 線 API 擋雲端）。沒有回測，只當觀察。`);
  if (note) { L.push(''); L.push(note); }
  L.push('', `## 轉弱紀錄（最近 ${cfg.keepDays} 天，${state.events.length} 筆）`);
  if (state.events.length) {
    L.push('| 時間 | 代號 | 週期 | 24h 漲幅 | 收盤 | 跌破 | 自高點 | 停損距離 | 標籤 |', '|---|---|---|---|---|---|---|---|---|');
    state.events.slice(0, rows).forEach(e => L.push(`| ${tpe(e.t).slice(5, 16)} | ${link(e.base, tvOf(e))} | ${tfText(e.tfs)}${e.rule === 'range' ? '' : '（舊規則）'} | ${pcs(e.chg)} | ${fmtP(e.c)} | ${fmtP(e.brk)} | -${e.drop}% | ${e.stop == null ? '—' : `${e.stop}%`} | ${[...(e.muted ? ['未推播（勿空）'] : []), ...tagText(e.tags)].join('；') || '—'} |`));
  } else L.push('無');
  L.push('', `## 目前名單（${state.items.length} 檔）`);
  if (state.items.length) {
    L.push('| 代號 | 24h 漲幅 | 各家 | 成交額 | 轉弱 | 停損距離 | 標籤 |', '|---|---|---|---|---|---|---|');
    state.items.slice(0, rows).forEach(it => L.push(`| ${link(it.base, tvOf(it))} | ${pcs(it.chgMax)} | ${exText(it.ex)} | ${money(it.qv)} | ${Object.keys(it.weak || {}).map(t => t.toUpperCase()).join('＋') || '—'} | ${it.stopPct == null ? '—' : `${it.stopPct}%`} | ${tagText(it.tags).join('；') || '—'} |`));
  } else L.push('無');
  if (warnings.length) { L.push('', `## 資料警告（${warnings.length}）`); warnings.slice(0, 20).forEach(w => L.push(`- ${w}`)); }
  L.push('', '> 規則式篩選，不是投資建議。');
  return L.join('\n');
}

const MA = '<!-- GAINER_STATE', MB = 'GAINER_STATE -->';
export function embedGainer(md, state) {
  return `${md}\n\n${MA}\n${zlib.gzipSync(Buffer.from(JSON.stringify(state))).toString('base64')}\n${MB}\n`;
}
export function extractGainer(body) {
  if (!body) return emptyGainer();
  const a = body.indexOf(MA), b = body.indexOf(MB);
  if (a < 0 || b < 0) return emptyGainer();
  try { return { ...emptyGainer(), ...JSON.parse(zlib.gunzipSync(Buffer.from(body.slice(a + MA.length, b).trim(), 'base64')).toString('utf8')) }; }
  catch { return null; }
}
export function gainerBody(state, opts, render = x => x, cfg = GAINER, limit = 60000) {
  let rows = 80, out;
  for (;;) {
    out = embedGainer(render(gainerMarkdown(state, { ...opts, rows }, cfg)), state);
    if (out.length <= limit || rows === 0) return out;
    rows = rows > 20 ? rows - 20 : 0;
  }
}
