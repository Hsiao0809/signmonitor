/* ============================================================
   多交易所日線轉接器（只用公開端點，不需要 API key）
   每家輸出統一格式：
     list()            -> [{ sym, base }]       base 已去掉交易所自己的前後綴
     daily(sym, days)  -> [{ t, o, h, l, c, qv }] 由舊到新；t＝該日 K 開始時間（ms），qv＝USDT 成交額
   監控 OKX、Bitget、Bybit 三家。Bybit 的 API 擋美國雲端（含 GitHub Actions），
   改讀它公開的逐筆成交檔（每天約 09:12 台灣時間公布前一天的檔案）。
   ============================================================ */
import zlib from 'node:zlib';

const UA = { 'User-Agent': 'Mozilla/5.0 (signscanner-watchlist)' };
const DAY = 864e5;
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function getJSON(url, opt = {}, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { ...UA, ...(opt.headers || {}) }, method: opt.method, body: opt.body, signal: AbortSignal.timeout(20000) });
      if (r.ok) return await r.json();
      if (r.status === 451 || r.status === 403 && i > 0) return null;
    } catch { /* 重試 */ }
    await sleep(500 * (i + 1));
  }
  return null;
}
async function getBuf(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(120000) });
      if (r.status === 404) return null;
      if (r.ok) return Buffer.from(await r.arrayBuffer());
    } catch { /* 重試 */ }
    await sleep(800 * (i + 1));
  }
  return null;
}
async function getText(url) { const b = await getBuf(url); return b ? b.toString('utf8') : null; }

const n = Number;
const dayStart = t => Math.floor(t / DAY) * DAY;
const bar = (t, o, h, l, c, qv) => ({ t: n(t), o: n(o), h: n(h), l: n(l), c: n(c), qv: n(qv) });
const nowS = () => Math.floor(Date.now() / 1000);
const tail = (a, days) => a.filter(b => isFinite(b.c) && b.c > 0).sort((x, y) => x.t - y.t).slice(-days);

/* ---------------- 各交易所 ---------------- */
export const VENUES = {
  okx: {
    label: 'OKX',
    async list() {
      const j = await getJSON('https://www.okx.com/api/v5/public/instruments?instType=SWAP');
      return (j?.data || []).filter(x => x.instId.endsWith('-USDT-SWAP')).map(x => ({ sym: x.instId, base: x.instId.split('-')[0] }));
    },
    async daily(sym, days) {
      const j = await getJSON(`https://www.okx.com/api/v5/market/history-candles?instId=${sym}&bar=1Dutc&limit=100`);
      let rows = j?.data || [];
      if (days > 100 && rows.length) {
        const j2 = await getJSON(`https://www.okx.com/api/v5/market/history-candles?instId=${sym}&bar=1Dutc&limit=100&after=${rows[rows.length - 1][0]}`);
        rows = rows.concat(j2?.data || []);
      }
      return tail(rows.map(k => bar(k[0], k[1], k[2], k[3], k[4], k[7])), days);
    }
  },
  bitget: {
    label: 'Bitget',
    async list() {
      const j = await getJSON('https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES');
      return (j?.data || []).map(x => ({ sym: x.symbol, base: x.baseCoin }));
    },
    async daily(sym, days) {
      const end = Date.now();
      const j = await getJSON(`https://api.bitget.com/api/v2/mix/market/history-candles?symbol=${sym}&productType=USDT-FUTURES&granularity=1Dutc&endTime=${end}&limit=200`);
      return tail((j?.data || []).map(k => bar(k[0], k[1], k[2], k[3], k[4], k[6])), days);
    }
  },
  /* ---- Bybit API 擋美國雲端，改讀它公開的逐筆成交檔；需要外部快取（見 run.mjs） ---- */
  bybit: {
    label: 'Bybit', archive: true,
    async list() {
      const html = await getText('https://public.bybit.com/trading/');
      return [...(html || '').matchAll(/href="([A-Z0-9]+USDT)\/"/g)].map(m => ({ sym: m[1], base: m[1].replace(/USDT$/, '').replace(/STOCK$/, '') }));
    },
    /* 單日：下載當天逐筆成交，彙整成日線 */
    async day(sym, ymd) {
      const buf = await getBuf(`https://public.bybit.com/trading/${sym}/${sym}${ymd}.csv.gz`);
      if (!buf) return null;
      const text = zlib.gunzipSync(buf).toString('latin1');
      let o, h = -Infinity, l = Infinity, c, qv = 0, t0 = Infinity, t1 = -Infinity;
      /* 欄位：timestamp,symbol,side,size,price,tickDirection,trdMatchID,grossValue,homeNotional,foreignNotional,RPI
         逐字掃描逗號，比整行 split 快很多（大檔一天可達數十 MB） */
      let pos = text.indexOf('\n') + 1;
      while (pos > 0 && pos < text.length) {
        const end = text.indexOf('\n', pos);
        const stop = end < 0 ? text.length : end;
        let f = 0, a = pos, ts = 0, p = 0;
        for (let i = pos; i <= stop; i++) {
          if (i === stop || text.charCodeAt(i) === 44) {
            if (f === 0) ts = +text.slice(a, i);
            else if (f === 4) p = +text.slice(a, i);
            else if (f === 9) { qv += +text.slice(a, i); break; }
            f++; a = i + 1;
          }
        }
        if (p > 0) {
          if (p > h) h = p; if (p < l) l = p;
          if (ts < t0) { t0 = ts; o = p; }
          if (ts >= t1) { t1 = ts; c = p; }
        }
        pos = end < 0 ? -1 : end + 1;
      }
      return isFinite(h) ? bar(Date.parse(ymd + 'T00:00:00Z'), o, h, l, c, qv) : null;
    }
  }
};

export const LIVE_VENUES = Object.keys(VENUES).filter(k => !VENUES[k].archive);
export const ARCHIVE_VENUES = Object.keys(VENUES).filter(k => VENUES[k].archive);

/* ---------------- 股票對照 ----------------
   reference: { BASE: 參考價 }（來自 OKX/Bitget 標成股票的合約）
   各家合約名稱去掉常見前後綴後比對，再用價格（差 15% 內）排除同名的加密貨幣 */
const SUFFIXES = ['', 'STOCK', 'X', 'ON', 'B', 'USD1', 'USD'];
export function stockBaseOf(base, reference) {
  const b = String(base).toUpperCase();
  for (const s of SUFFIXES) {
    if (s && !b.endsWith(s)) continue;
    const core = s ? b.slice(0, -s.length) : b;
    if (core && reference[core] != null) return core;
  }
  return null;
}
export function priceMatches(price, ref, tol = 0.15) {
  return isFinite(price) && isFinite(ref) && ref > 0 && Math.abs(price / ref - 1) <= tol;
}

export async function poolMap(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch { out[k] = null; } }
  }));
  return out;
}
