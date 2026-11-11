/* ============================================================
   OI 紀錄：每小時一次，OKX、Bitget 都有上架的加密合約（沉睡甦醒的範圍）的未平倉量（USD）
   寫到 data/oi/YYYY-MM-DD.jsonl（UTC 日），一行一個小時，key 是代號：
     {"t":整點,"okx":{"BTC":OI_USD,...},"bitget":{"BTC":[OI_USD,資金費率],...}}
   只做紀錄，之後回測「沉睡甦醒」時用來判斷新倉進場還是軋空。失敗不影響其他功能。
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { getJSON } from './venues.mjs';

/* 4 位有效數字，檔案小一點 */
const sig4 = v => +(+v).toPrecision(4);

/** pairs：[{ base, okx, bitget }]（dormant-scan 的 universe） */
export async function snapshotOI(pairs) {
  const ob = new Map(pairs.map(p => [p.okx, p.base])), bb = new Map(pairs.map(p => [p.bitget, p.base]));
  const [o, b] = await Promise.all([
    getJSON('https://www.okx.com/api/v5/public/open-interest?instType=SWAP'),
    getJSON('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES')
  ]);
  const okx = {}, bitget = {};
  for (const r of o?.data || []) if (ob.has(r.instId) && +r.oiUsd > 0) okx[ob.get(r.instId)] = sig4(r.oiUsd);
  for (const r of b?.data || []) {
    if (!bb.has(r.symbol)) continue;
    const usd = +r.holdingAmount * +(r.markPrice || r.lastPr);
    if (usd > 0) bitget[bb.get(r.symbol)] = [sig4(usd), +(+r.fundingRate || 0).toPrecision(3)];
  }
  return { okx, bitget };
}

/** 同一小時已經寫過就不重寫 */
export function appendOI(dir, T, snap) {
  if (!Object.keys(snap.okx).length && !Object.keys(snap.bitget).length) return false;
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${new Date(T).toISOString().slice(0, 10)}.jsonl`);
  if (fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes(`{"t":${T},`)) return false;
  fs.appendFileSync(f, JSON.stringify({ t: T, ...snap }) + '\n');
  return true;
}
