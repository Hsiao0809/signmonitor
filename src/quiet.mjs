/* ============================================================
   量增價平：已判定爆量、但價格還沒大幅波動的標的
   - 盤中爆量（1H）：|該小時漲跌| ≤ 這檔近 7 天平均 1H 振幅 × 0.5，且 ≤ 2%
     （Bybit 只有成交額沒有歷史振幅：改用固定上限 加密 1%、股票／商品 0.5%）
   - 每日爆量（短線、布局）：|爆量日漲跌| ≤ 14 日 ATR% × 0.5，且 ≤ 3%
   只加標記與另發通知，不改原本的爆量判斷。
   每筆記錄之後 24h、72h 的漲跌（每輪抓價，最多晚 1 小時），累積成績判斷有沒有交易價值。
   量增價平只代表「有量、價格還沒反應」，可能吸籌也可能出貨，方向未定。
   ============================================================ */
import zlib from 'node:zlib';
import { tpe, fmtP, link, tvUrl } from './tracker.mjs';

export const QUIET = {
  hourMult: 0.5, hourCap: 2,
  hourFallback: { crypto: 1, stock: 0.5, comm: 0.5 },
  hourRangeBars: 168, minRangeBars: 48,
  dayMult: 0.5, dayCap: 3, atrLen: 14,
  checks: [24, 72],
  giveUpHours: 12,         // 過了檢查點這麼久還抓不到價格就放棄那一格
  keepDone: 400,
  maxLines: 15
};
const H = 3600e3, D = 24 * H;
const CAT = { crypto: '加密', stock: '股票', comm: '商品' };

/* 近 n 根（T 之前）1H K 的平均振幅 %（高低差／開盤）；沒有高低資料的 K 不算 */
export function avgRangePct(bars, T, cfg = QUIET) {
  const r = bars.filter(b => b.t < T && b.t >= T - cfg.hourRangeBars * H && b.o > 0 && b.h > b.l).map(b => (b.h - b.l) / b.o * 100);
  return r.length >= cfg.minRangeBars ? r.reduce((s, x) => s + x, 0) / r.length : null;
}
/* 日線第 i 根（含）往前 len 根的 ATR %（以第 i 根收盤計） */
export function atrPctAt(bars, i, cfg = QUIET) {
  if (i < cfg.atrLen || !(bars[i]?.c > 0)) return null;
  let s = 0;
  for (let j = i - cfg.atrLen + 1; j <= i; j++) {
    const b = bars[j], pc = bars[j - 1].c;
    s += Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
  }
  return s / cfg.atrLen / bars[i].c * 100;
}
export function quietHour(chgPct, rngPct, cat, cfg = QUIET) {
  const lim = rngPct != null ? Math.min(rngPct * cfg.hourMult, cfg.hourCap) : (cfg.hourFallback[cat] ?? cfg.hourFallback.crypto);
  return { quiet: Math.abs(chgPct) <= lim, lim: +lim.toFixed(2), rng: rngPct == null ? null : +rngPct.toFixed(2) };
}
export function quietDay(chgPct, atrPct, cfg = QUIET) {
  const lim = atrPct != null ? Math.min(atrPct * cfg.dayMult, cfg.dayCap) : cfg.dayCap * cfg.dayMult;
  return { quiet: Math.abs(chgPct) <= lim, lim: +lim.toFixed(2), atr: atrPct == null ? null : +atrPct.toFixed(2) };
}

/* ---------------- 追蹤紀錄 ---------------- */
export function emptyQuiet() { return { version: 1, items: [], done: [] }; }

/* 盤中爆量的量增價平 → 紀錄（同一檔多家同時爆量只記倍數最高那家） */
export function fromHourly(alerts) {
  const best = new Map();
  for (const a of alerts) if (a.quiet && (!best.has(a.base) || a.x1 > best.get(a.base).x1)) best.set(a.base, a);
  return [...best.values()].map(a => ({
    key: `h:${a.base}:${a.t}`, src: 'hourly', base: a.base, cat: a.cat, venue: a.venue, id: a.sym,
    t: a.t + H, price: a.price, chg: a.chg, lim: a.qlim, ref: a.rng, x: a.x1, r: {}
  }));
}
export function fromShort(cands) {
  return cands.filter(c => c.quiet).map(c => ({
    key: `s:${c.base}:${c.dayT}`, src: 'short', base: c.base, cat: c.cat, venue: c.ex, id: c.id,
    t: c.dayT + D, price: c.close, chg: c.chgDay, lim: c.qlim, ref: c.atrp, x: c.vx, r: {}
  }));
}
export function fromLayout(cands) {
  return cands.filter(c => c.quiet).map(c => {
    const v = ['okx', 'bitget', 'bybit'].find(k => c.syms?.[k]) || c.ref;
    return {
      key: `l:${c.base}:${c.dayT}`, src: 'layout', base: c.base, cat: c.cat, venue: v, id: c.syms?.[v] || null,
      t: c.dayT + D, price: c.entry, chg: c.chgDay, lim: c.qlim, ref: c.atrp, x: Math.max(...c.spiked.map(s => c.venues[s]?.x || 0)), r: {}
    };
  });
}
export function addItems(state, items) {
  const known = new Set([...state.items, ...state.done].map(x => x.key));
  const added = items.filter(x => !known.has(x.key) && known.add(x.key));
  state.items.push(...added);
  return added;
}
/** 到期的檢查點用 priceOf(item) 填上漲跌；全部填完（或放棄）就移到 done */
export function updateItems(state, priceOf, nowMs, cfg = QUIET) {
  const still = [];
  for (const it of state.items) {
    for (const h of cfg.checks) {
      if (it.r[h] !== undefined || nowMs < it.t + h * H) continue;
      const p = priceOf(it);
      if (p > 0 && it.price > 0) it.r[h] = +((p / it.price - 1) * 100).toFixed(2);
      else if (nowMs > it.t + (h + cfg.giveUpHours) * H) it.r[h] = null;
    }
    if (cfg.checks.every(h => it.r[h] !== undefined)) state.done.push(it); else still.push(it);
  }
  state.items = still;
  state.done = state.done.slice(-cfg.keepDone);
}
/* 成績：每個檢查點的筆數、平均、上漲比例、平均絕對漲跌（依來源分開） */
export function quietStats(state, cfg = QUIET) {
  const all = [...state.done, ...state.items];
  const out = {};
  for (const src of ['all', 'hourly', 'short', 'layout']) {
    const rows = all.filter(x => src === 'all' || x.src === src);
    out[src] = Object.fromEntries(cfg.checks.map(h => {
      const v = rows.map(x => x.r[h]).filter(x => typeof x === 'number');
      if (!v.length) return [h, null];
      return [h, { n: v.length, avg: v.reduce((s, x) => s + x, 0) / v.length, up: v.filter(x => x > 0).length / v.length, abs: v.reduce((s, x) => s + Math.abs(x), 0) / v.length }];
    }));
  }
  return out;
}

/* ---------------- 文字 ---------------- */
const SRC = { hourly: '盤中爆量', short: '每日爆量（短線）', layout: '每日爆量（布局）' };
const sg = (v, d = 1) => v == null ? '—' : `${v >= 0 ? '+' : ''}${(+v).toFixed(d)}%`;
const itLink = it => it.id ? link(it.base, tvUrl(it.venue, it.id, it.src === 'hourly' ? '60' : 'D')) : it.base;

export function quietAlertText(items, nowMs, url = '', cfg = QUIET, nth = null) {
  if (!items.length) return '';
  const L = [`【量增價平】${tpe(nowMs).slice(5, 16)} 台灣時間（${items.length} 檔）`, '爆量但價格還沒大動：可能吸籌也可能出貨，方向未定'];
  items.slice(0, cfg.maxLines).forEach(it => {
    const unit = it.src === 'hourly' ? '1H' : '當日';
    const ref = it.ref == null ? `門檻 ±${it.lim}%` : `${it.src === 'hourly' ? '平常 1H 振幅' : 'ATR'} ${it.ref}%`;
    L.push(`${itLink(it)}［${CAT[it.cat] || it.cat}］${SRC[it.src]} ${it.x}x｜${unit} ${sg(it.chg)}（${ref}）｜價 ${fmtP(it.price)}${nth ? `｜今日第 ${nth(it.base)} 次` : ''}`);
  });
  if (items.length > cfg.maxLines) L.push(`另有 ${items.length - cfg.maxLines} 檔，見網頁`);
  if (url) L.push(url);
  return L.join('\n');
}

export function quietMarkdown(state, { nowMs }, cfg = QUIET) {
  const L = [`# 量增價平｜更新 ${tpe(nowMs)} 台灣時間`, ''];
  L.push('已判定爆量、但價格還沒大幅波動的標的。盤中：|1H 漲跌| ≤ 近 7 天平均 1H 振幅 × 0.5 且 ≤ 2%（Bybit 用固定上限）；每日：|當日漲跌| ≤ ATR14 × 0.5 且 ≤ 3%。記錄之後 24h、72h 的漲跌。', '');
  const st = quietStats(state, cfg);
  L.push('## 成績', '| 來源 | 24h 筆數 | 24h 平均 | 24h 上漲比例 | 72h 筆數 | 72h 平均 | 72h 上漲比例 |', '|---|---|---|---|---|---|---|');
  for (const k of ['all', 'hourly', 'short', 'layout']) {
    const a = st[k][24], b = st[k][72];
    L.push(`| ${k === 'all' ? '全部' : SRC[k]} | ${a?.n ?? 0} | ${a ? sg(a.avg, 2) : '—'} | ${a ? (a.up * 100).toFixed(0) + '%' : '—'} | ${b?.n ?? 0} | ${b ? sg(b.avg, 2) : '—'} | ${b ? (b.up * 100).toFixed(0) + '%' : '—'} |`);
  }
  L.push('', `## 追蹤中（${state.items.length}）`);
  if (state.items.length) {
    L.push('| 時間 | 標的 | 來源 | 倍數 | 漲跌 | 價格 | 24h | 72h |', '|---|---|---|---|---|---|---|---|');
    state.items.slice().reverse().forEach(it => L.push(`| ${tpe(it.t).slice(5, 16)} | ${itLink(it)}［${CAT[it.cat] || it.cat}］ | ${SRC[it.src]} | ${it.x}x | ${sg(it.chg)} | ${fmtP(it.price)} | ${sg(it.r[24])} | ${sg(it.r[72])} |`));
  } else L.push('無');
  L.push('', '> 規則式標記，不是投資建議。');
  return L.join('\n');
}
const MA = '<!-- QUIET_STATE', MB = 'QUIET_STATE -->';
export function embedQuiet(md, s) { return `${md}\n\n${MA}\n${zlib.gzipSync(Buffer.from(JSON.stringify(s))).toString('base64')}\n${MB}\n`; }
export function extractQuiet(body) {
  if (!body) return emptyQuiet();
  const a = body.indexOf(MA), b = body.indexOf(MB);
  if (a < 0 || b < 0) return emptyQuiet();
  try { return { ...emptyQuiet(), ...JSON.parse(zlib.gunzipSync(Buffer.from(body.slice(a + MA.length, b).trim(), 'base64')).toString('utf8')) }; }
  catch { return null; }
}
