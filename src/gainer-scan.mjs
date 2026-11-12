/* ============================================================
   做空候選的資料：四家漲幅榜＋名單標的的 1H／4H K 線
   - OKX、Bitget：合約 24h 行情（core.mjs 轉接器，含類別）
   - Binance：現貨 24h 行情（data-api.binance.vision，美國雲端連得上）；沒有合約，只當名單來源
   - Bybit：REST 擋雲端，改訂閱公開 WebSocket 的 tickers（每個合約的第一則 snapshot）
   K 線只抓名單內有 OKX／Bitget 合約的標的（KLINE），一檔 2 次請求
   ============================================================ */
import * as core from './core.mjs';
import * as V from './venues.mjs';
import { isExcluded } from './tracker.mjs';
import { isStable } from './rate.mjs';
import { GAINER, mergeBoards, enrich } from './gainer.mjs';

const num = v => (v === '' || v == null || !isFinite(+v) ? null : +v);
const asRows = list => list.map(m => ({ base: m.base, id: m.id, cat: m.cat, last: m.price, chg: m.chg24h, qv: m.qv24h }));

export async function okxBoard() { return asRows(await core.EXCHANGES.okx.list()); }
export async function bitgetBoard() { return asRows(await core.EXCHANGES.bitget.list()); }

export async function binanceBoard() {
  const j = await V.getJSON('https://data-api.binance.vision/api/v3/ticker/24hr');
  if (!Array.isArray(j)) throw new Error('Binance 現貨行情取得失敗');
  return j.filter(x => /USDT$/.test(x.symbol) && num(x.lastPrice) > 0)
    .map(x => ({ base: x.symbol.slice(0, -4), id: x.symbol, cat: 'crypto', last: +x.lastPrice, chg: +x.priceChangePercent, qv: +x.quoteVolume }));
}

/** Bybit tickers 訊息 → { sym, last, chg(%), qv }；只收完整的 snapshot（後續的 delta 欄位不齊） */
export function parseBybitTicker(m) {
  if (!m || typeof m.topic !== 'string' || !m.topic.startsWith('tickers.') || m.type !== 'snapshot') return null;
  const d = m.data || {};
  const last = num(d.lastPrice), pc = num(d.price24hPcnt), qv = num(d.turnover24h);
  if (!d.symbol || !(last > 0) || pc == null || qv == null) return null;
  return { sym: d.symbol, last, chg: pc * 100, qv };
}

export async function bybitBoard({ timeoutMs = 15000, perConn = 100 } = {}) {
  if (typeof WebSocket === 'undefined') throw new Error('此環境沒有 WebSocket');
  const list = (await V.VENUES.bybit.list()).filter(x => /USDT$/.test(x.sym));
  if (!list.length) throw new Error('Bybit 合約清單為空');
  const syms = list.map(x => x.sym), got = {};
  const chunks = [];
  for (let i = 0; i < syms.length; i += perConn) chunks.push(syms.slice(i, i + perConn));
  const deadline = Date.now() + timeoutMs;
  await Promise.all(chunks.map(chunk => new Promise(resolve => {
    let ws, done = false, ping;
    const finish = () => { if (done) return; done = true; clearInterval(ping); clearTimeout(timer); try { ws.close(); } catch {} resolve(); };
    const timer = setTimeout(finish, Math.max(1000, deadline - Date.now()));
    try { ws = new WebSocket('wss://stream.bybit.com/v5/public/linear'); } catch { return finish(); }
    ws.onopen = () => {
      for (let i = 0; i < chunk.length; i += 10) ws.send(JSON.stringify({ op: 'subscribe', args: chunk.slice(i, i + 10).map(s => `tickers.${s}`) }));
      ping = setInterval(() => { try { ws.send('{"op":"ping"}'); } catch {} }, 20000);
    };
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      const r = parseBybitTicker(m);
      if (r) got[r.sym] = r;
      if (chunk.every(s => got[s])) finish();
    };
    ws.onerror = () => {};
    ws.onclose = finish;
  })));
  const base = Object.fromEntries(list.map(x => [x.sym, x.base]));
  return Object.values(got).map(r => ({ base: base[r.sym] || r.sym.slice(0, -4), id: r.sym, cat: /STOCKUSDT$/.test(r.sym) ? 'stock' : 'crypto', last: r.last, chg: r.chg, qv: r.qv }));
}

const BOARDS = { okx: okxBoard, bitget: bitgetBoard, bybit: bybitBoard, binance: binanceBoard };
const NAMES = { okx: 'OKX', bitget: 'Bitget', bybit: 'Bybit', binance: 'Binance 現貨' };

/**
 * 回傳 { items, counts }；items 已有 K 線判斷（weak、hi24、stopPct），還沒有標籤（tagsOf 由呼叫端依其他模組補）。
 * OKX 與 Bitget 都失敗就丟錯（沒有合約行情無從判斷）；其他家失敗只加警告。
 */
export async function collect(T, warnings, { boards: inject, bars: injectBars } = {}) {
  const boards = {};
  await Promise.all(Object.keys(BOARDS).map(async k => {
    try {
      const rows = inject ? inject[k] : await BOARDS[k]();
      if (!rows?.length) throw new Error('沒有資料');
      boards[k] = rows;
    } catch (e) { warnings.push(`${NAMES[k]} 漲幅榜取得失敗（${e.message}）`); }
  }));
  if (!boards.okx && !boards.bitget) throw new Error('OKX、Bitget 合約行情都取得失敗');
  const items = mergeBoards(boards, GAINER, b => isExcluded(b) || isStable(b));
  const withK = items.filter(i => i.kex);
  let failed = 0;
  await core.pool(withK, 4, async it => {
    const get = injectBars || (async (ex, id, tf) => core.EXCHANGES[ex].kl(id, tf, 0, tf === '1h' ? 60 : 24));
    const [h1, h4] = await Promise.all([get(it.kex, it.kid, '1h'), get(it.kex, it.kid, '4h')]);
    if (!h1 && !h4) { failed++; it.klFail = 1; }
    enrich(it, h1 || [], h4 || [], T, GAINER);
  });
  items.filter(i => !i.kex).forEach(it => enrich(it, [], [], T, GAINER));
  if (failed > 0 && failed >= withK.length * 0.5) warnings.push(`K 線取得失敗 ${failed}/${withK.length} 檔，這一輪的轉弱判斷不完整`);
  const counts = Object.fromEntries(Object.keys(BOARDS).map(k => [k, boards[k]?.length ?? 0]));
  return { items, counts: { ...counts, qual: items.length } };
}
