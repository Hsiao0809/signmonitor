/* ============================================================
   行情快照（每小時）：給網頁用
   - BTC、ETH 的 4H EMA20／SMA30 狀態、上次交叉、距 SMA200、24h 漲跌
   - Binance、Bitget 的價格：這兩家擋 Cloudflare Worker 的連線，網頁抓不到即時價，
     改由 GitHub Actions 每小時存一份（網頁上標「1 小時內」）
   存在 Issue「行情快照」本文最後的隱藏區塊。
   ============================================================ */
import zlib from 'node:zlib';
import { getJSON } from './venues.mjs';
import { tpe, fmtP } from './tracker.mjs';

const H4 = 4 * 3600e3;

export function trend(base, bars, price, nowMs) {
  const cl = bars.filter(x => x.t + H4 <= nowMs), n = cl.length, k = 2 / 21;
  if (n < 230) return null;
  const ema = [], sma = [];
  let s30 = 0;
  cl.forEach((x, i) => {
    ema[i] = i ? x.c * k + ema[i - 1] * (1 - k) : x.c;
    s30 += x.c; if (i >= 30) s30 -= cl[i - 30].c; sma[i] = i >= 29 ? s30 / 30 : null;
  });
  const s200 = cl.slice(-200).reduce((a, x) => a + x.c, 0) / 200;
  const up = ema[n - 1] > sma[n - 1];
  let since = null;
  for (let i = n - 1; i > 30; i--) if ((ema[i] > sma[i]) !== (ema[i - 1] > sma[i - 1])) { since = cl[i].t; break; }
  const last = price ?? cl[n - 1].c;
  const ago = bars.find(x => x.t >= nowMs - 864e5);
  return { base, price: last, chg24: ago ? last / ago.o - 1 : null, up, since, px200: last / s200 - 1 };
}

async function bars4h(base) {
  const b = await getJSON(`https://data-api.binance.vision/api/v3/klines?symbol=${base}USDT&interval=4h&limit=300`);
  if (Array.isArray(b) && b.length > 230) return b.map(k => ({ t: +k[0], o: +k[1], c: +k[4] }));
  const o = await getJSON(`https://www.okx.com/api/v5/market/candles?instId=${base}-USDT&bar=4H&limit=300`);
  if (o?.data?.length > 230) return o.data.slice().reverse().map(k => ({ t: +k[0], o: +k[1], c: +k[4] }));
  return null;
}

/** need：{ bitget:Set(symbol), binance:Set(symbol) } */
export async function take(need, nowMs) {
  const warnings = [];
  const px = { bitget: {}, binance: {} };
  const [bg, bn] = await Promise.all([
    need.bitget.size ? getJSON('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES') : null,
    getJSON(`https://data-api.binance.vision/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(['BTCUSDT', 'ETHUSDT', ...need.binance]))}`)
  ]);
  if (need.bitget.size) {
    if (bg?.data) bg.data.forEach(t => { if (need.bitget.has(t.symbol)) px.bitget[t.symbol] = +t.lastPr; });
    else warnings.push('Bitget 價格取得失敗');
  }
  if (Array.isArray(bn)) bn.forEach(t => { px.binance[t.symbol] = +t.price; });
  else warnings.push('Binance 價格取得失敗');
  const market = [];
  for (const base of ['BTC', 'ETH']) {
    const b = await bars4h(base);
    const tr = b && trend(base, b, px.binance[`${base}USDT`], nowMs);
    if (tr) market.push(tr); else warnings.push(`${base} 4H 資料取得失敗`);
  }
  return { t: nowMs, px, market, warnings };
}

/* 網頁要哪些 Bitget／Binance 價格：從各清單狀態收集 */
export function needOf({ short, layout, hourly, cross, crossD }) {
  const need = { bitget: new Set(), binance: new Set() };
  if (short) [...short.pending, ...short.open].forEach(c => { if (c.ex === 'bitget') need.bitget.add(c.id); });
  if (layout) layout.active.forEach(it => { const s = it.syms || {}; if (!s.okx && s.bitget) need.bitget.add(s.bitget); });
  if (hourly) hourly.recent.forEach(a => { if (a.venue === 'bitget') need.bitget.add(a.sym); });
  if (cross) [...cross.active, ...cross.recentB].forEach(c => need.binance.add(c.sym));
  if (crossD) [...crossD.active, ...crossD.recentB].forEach(c => need.binance.add(c.sym));
  return need;
}

export function snapshotMarkdown(s) {
  const L = [`# 行情快照｜${tpe(s.t)} 台灣時間`, '', '給 signmonitor 網頁用：BTC、ETH 的 4H 狀態，以及網頁抓不到即時價的 Binance、Bitget 價格（每小時更新）。', ''];
  s.market.forEach(m => L.push(`- ${m.base} ${fmtP(m.price)}，4H ${m.up ? '金叉中' : '死叉中'}${m.since ? `（自 ${tpe(m.since)}）` : ''}，距 SMA200 ${(m.px200 * 100).toFixed(1)}%`));
  L.push('', `Bitget ${Object.keys(s.px.bitget).length} 檔、Binance ${Object.keys(s.px.binance).length} 檔價格`);
  if (s.warnings.length) { L.push('', `## 資料警告（${s.warnings.length}）`); s.warnings.forEach(w => L.push(`- ${w}`)); }
  return L.join('\n');
}
const MA = '<!-- SNAPSHOT_STATE', MB = 'SNAPSHOT_STATE -->';
export function embedSnapshot(md, s) {
  return `${md}\n\n${MA}\n${zlib.gzipSync(Buffer.from(JSON.stringify(s))).toString('base64')}\n${MB}\n`;
}
