/* 訊號成績單的執行入口（見 src/score.mjs）。
   node src/score-scan.mjs --log-dir logs/telegram --dir data/score --out out
   另讀 logs/gainer/（做空候選轉弱的新舊規則並行紀錄，含沒推播的勿空；--gainer-log 可改路徑）
   - data/score/open.jsonl：還在等 72 小時結果的紀錄（一行一筆）
   - data/score/done/YYYY-MM.jsonl：已結案的紀錄（只追加）
   - data/score/state.json：已處理過的發送批次（run）
   - out/score-body.md：Issue「訊號成績」本文（含網頁用的隱藏狀態）
   任何錯誤只印出、不丟例外，不影響監控其他部分（workflow 也設了 continue-on-error）。 */
import fs from 'node:fs';
import path from 'node:path';
import { getJSON } from './venues.mjs';
import * as SC from './score.mjs';

const H = SC.H;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function args(argv) { const o = {}; for (let i = 2; i < argv.length; i += 2) o[argv[i].replace(/^--/, '')] = argv[i + 1]; return o; }
const A = args(process.argv);
const LOG = A['log-dir'] || 'logs/telegram', GLOG = A['gainer-log'] || 'logs/gainer', DIR = A.dir || 'data/score', OUT = A.out || 'out';
const CFG = A.config || 'config/score.json';
const readJsonl = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];

function enabled() {
  if (process.env.SCORE_ENABLED === '0') return false;
  try { return fs.existsSync(CFG) ? JSON.parse(fs.readFileSync(CFG, 'utf8')).enabled !== false : true; } catch { return true; }
}

/* ---- K 線（只用公開端點） ---- */
const n = Number;
async function okxBars(inst) {
  const j = await getJSON(`https://www.okx.com/api/v5/market/candles?instId=${inst}&bar=1H&limit=300`);
  return new Map((j?.data || []).filter(k => k[8] === '1').map(k => [n(k[0]), [n(k[0]), n(k[1]), n(k[2]), n(k[3]), n(k[4])]]));
}
async function bitgetBars(sym) {
  const j = await getJSON(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${sym}&productType=USDT-FUTURES&granularity=1H&limit=200`);
  const now = Date.now();
  return new Map((j?.data || []).filter(k => n(k[0]) + H <= now).map(k => [n(k[0]), [n(k[0]), n(k[1]), n(k[2]), n(k[3]), n(k[4])]]));
}
async function binanceBars(sym) {
  const j = await getJSON(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=1h&limit=1000`);
  const now = Date.now();
  return new Map((Array.isArray(j) ? j : []).filter(k => k[0] + H <= now).map(k => [k[0], [k[0], n(k[1]), n(k[2]), n(k[3]), n(k[4])]]));
}
const FETCH = { okx: okxBars, bitget: bitgetBars, binance: binanceBars };

async function main() {
  if (!enabled()) { console.log('訊號成績：已關閉（config/score.json enabled=false）'); return; }
  const now = Date.now();
  fs.mkdirSync(path.join(DIR, 'done'), { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  const stFile = path.join(DIR, 'state.json');
  let st = { version: 1, runs: {} };
  try { if (fs.existsSync(stFile)) st = { ...st, ...JSON.parse(fs.readFileSync(stFile, 'utf8')) }; } catch { /* 重來 */ }
  const fresh = !st.init;          /* 第一次跑：讀全部發送紀錄補回測 */
  const open = new Map(readJsonl(path.join(DIR, 'open.jsonl')).map(r => [r.id, r]));

  /* 1. 新的發送紀錄 → 新紀錄。第一次跑讀全部檔案（補回測），之後只讀近 6 天 */
  const files = fs.existsSync(LOG) ? fs.readdirSync(LOG).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort() : [];
  const cutoff = new Date(now + 8 * H - 6 * 864e5).toISOString().slice(0, 10);
  const lines = files.filter(f => fresh || f.slice(0, 10) >= cutoff).flatMap(f => readJsonl(path.join(LOG, f)));
  let added = 0, runsNew = 0;
  for (const [run, parts] of SC.groupRuns(lines)) {
    if (st.runs[run]) continue;
    st.runs[run] = Date.parse(parts[0].time) || now; runsNew++;
    for (const s of SC.parseRun(parts)) {
      if (open.has(s.id) || now - s.t > 84 * H && !fresh) continue;
      open.set(s.id, s); added++;
    }
  }
  /* 1b. 轉弱新舊規則並行紀錄（logs/gainer/）：每行一筆，用 id 記住處理過的，避免結案後又被讀回來 */
  st.g = st.g || {};
  const gfiles = fs.existsSync(GLOG) ? fs.readdirSync(GLOG).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(0, 10) >= cutoff).sort() : [];
  for (const d of gfiles.flatMap(f => readJsonl(path.join(GLOG, f)))) {
    const s = SC.parseShadow(d);
    if (!s || st.g[s.id] || open.has(s.id) || now - s.t > 84 * H) continue;
    st.g[s.id] = s.t; open.set(s.id, s); added++;
  }
  for (const [k, t] of Object.entries(st.g)) if (now - t > 8 * 864e5) delete st.g[k];
  for (const [k, t] of Object.entries(st.runs)) if (now - t > 8 * 864e5) delete st.runs[k];
  st.init = true;

  /* 2. 找 K 線來源 */
  const need = [...open.values()].filter(r => r.src === undefined);
  if (need.length) {
    const [o, b] = await Promise.all([
      getJSON('https://www.okx.com/api/v5/public/instruments?instType=SWAP'),
      getJSON('https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES')
    ]);
    const okx = Object.fromEntries((o?.data || []).filter(x => x.instId.endsWith('-USDT-SWAP')).map(x => [x.instId.split('-')[0], x.instId]));
    const bg = Object.fromEntries((b?.data || []).map(x => [x.baseCoin, x.symbol]));
    if (Object.keys(okx).length && Object.keys(bg).length) for (const r of need) r.src = SC.pickSrc(r, okx, bg);
  }

  /* 3. 到期的才抓 K 線：進場價還沒有，或某個持有時間剛滿 */
  const due = [...open.values()].filter(r => r.src && (r.e == null || SC.HZ.some(h => !(r.m && r.m[h]) && now >= (r.st ?? r.t) + h * H + 2 * 60e3)));
  const keys = [...new Set(due.map(r => r.src.join(':')))];
  const bars = new Map();
  const queue = [...keys, 'okx:BTC-USDT-SWAP', 'okx:QQQ-USDT-SWAP'];
  let failed = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const k = queue.shift();
      if (bars.has(k)) continue;
      const [v, sym] = k.split(':');
      try { const m = await FETCH[v](sym); bars.set(k, m); if (!m.size) failed++; } catch { failed++; bars.set(k, new Map()); }
      await sleep(120);
    }
  }));
  const bench = { BTC: bars.get('okx:BTC-USDT-SWAP'), QQQ: bars.get('okx:QQQ-USDT-SWAP') };
  let filled = 0;
  for (const r of due) {
    const b = bars.get(r.src.join(':'));
    if (!b || !b.size) continue;
    const bn = SC.benchOf(r.c);
    if (SC.fill(r, b, bn ? bench[bn] : null, now)) filled++;
  }

  /* 4. 結案的搬到 done/ */
  let closed = 0;
  for (const [id, r] of open) {
    if (!SC.isDone(r, now) && !(r.src === null && now - r.t > 6 * H)) continue;
    if (r.e != null) {
      const f = path.join(DIR, 'done', `${new Date(r.t).toISOString().slice(0, 7)}.jsonl`);
      fs.appendFileSync(f, JSON.stringify(r) + '\n');
      closed++;
    }
    open.delete(id);
  }
  const openArr = [...open.values()].sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
  fs.writeFileSync(path.join(DIR, 'open.jsonl'), openArr.map(r => JSON.stringify(r)).join('\n') + (openArr.length ? '\n' : ''));
  fs.writeFileSync(stFile, JSON.stringify(st));

  /* 5. 統計 → Issue 本文 */
  const done = fs.readdirSync(path.join(DIR, 'done')).filter(f => f.endsWith('.jsonl')).flatMap(f => readJsonl(path.join(DIR, 'done', f)));
  const sum = SC.summarize([...done, ...openArr], now);
  fs.writeFileSync(path.join(OUT, 'score-body.md'), SC.embedScore(SC.renderMd(sum), sum));
  console.log(`訊號成績：新批次 ${runsNew}、新紀錄 ${added}、補上 ${filled}、結案 ${closed}、追蹤中 ${openArr.length}、已結案 ${done.length}；抓 K 線 ${keys.length} 檔（失敗 ${failed}）`);
}

main().catch(e => { console.error(`訊號成績失敗（不影響其他監控）：${e.stack || e.message}`); process.exitCode = 0; });
