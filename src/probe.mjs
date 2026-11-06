#!/usr/bin/env node
/* 連線檢查：逐家測試合約清單與日線是否抓得到。
   node src/probe.mjs            → 印出每家狀態
   用於 GitHub Actions 環境確認哪些交易所可用（雲端位置不同，被擋的交易所也不同）。 */
import * as V from './venues.mjs';

const TEST = { okx: 'NVDA-USDT-SWAP', bitget: 'NVDAUSDT', bybit: 'NVDAUSDT' };

const ymd = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
const rows = await Promise.all(Object.keys(V.VENUES).map(async k => {
  const v = V.VENUES[k];
  const t = Date.now();
  let list = 0, daily = 0, err = '';
  try { list = (await v.list()).length; } catch (e) { err = e.message; }
  try {
    if (v.archive) daily = (await v.day(TEST[k], ymd)) ? 1 : 0;
    else daily = (await v.daily(TEST[k], 30)).length;
  } catch (e) { err = err || e.message; }
  return { k, ok: list > 0 && daily > 0, list, daily, ms: Date.now() - t, err };
}));
for (const r of rows) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.k.padEnd(12)} 合約 ${String(r.list).padStart(5)}  日線 ${String(r.daily).padStart(3)}  ${r.ms}ms ${r.err}`);
console.log(`可用 ${rows.filter(r => r.ok).length}/${rows.length}`);
