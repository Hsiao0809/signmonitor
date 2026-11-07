/* signmonitor Worker（Cloudflare）
   1. 定時觸發：每小時第 50 分呼叫 GitHub 啟動 monitor.yml（GitHub 自己的排程常延遲或不跑）
   2. 網頁：總覽（大盤、需要處理、多模組重疊、系統狀態）與盤中爆量、短線清單、布局清單、4H 金叉的最新資料，
      開網頁時另抓 OKX／Bitget／Bybit／Binance 即時價；新增、移除自選標的（存進 GitHub Issue「自選標的」）
   只動 Hsiao0809/signmonitor，不碰其他 repo。

   設定（Worker → Settings → Variables and Secrets，Type 選 Secret）：
   - GITHUB_TOKEN：GitHub fine-grained token，只授權 signmonitor；Actions、Issues 都要 Read and write
   - ADMIN_PASSWORD：網頁上新增、移除標的時要輸入的密碼（自己訂）
   Cron Trigger：50 * * * *
*/
const REPO = 'Hsiao0809/signmonitor';
const WORKFLOW = 'monitor.yml';
const LABEL = 'signmonitor';
const WATCH_TITLE = '自選標的';
const A = '<!-- WATCHLIST -->', B = '<!-- /WATCHLIST -->';

/* ---------- 與 src/watch.mjs 相同的格式 ---------- */
function normalizeSymbol(s) {
  let x = String(s || '').trim().toUpperCase().replace(/\.P$/, '');
  x = x.replace(/^(OKX|BITGET|BYBIT|BINANCE):/, '').replace(/-USDT-SWAP$/, '').replace(/[-_]?USDT$/, '').replace(/STOCK$/, '');
  return /^[A-Z0-9]{1,20}$/.test(x) ? x : null;
}
function parseWatch(body) {
  const a = (body || '').indexOf(A), b = (body || '').indexOf(B);
  const block = a >= 0 && b > a ? body.slice(a + A.length, b) : '';
  const out = [];
  for (const line of block.split('\n')) { const s = normalizeSymbol(line.replace(/#.*/, '')); if (s && !out.includes(s)) out.push(s); }
  return out;
}
function formatWatch(symbols) {
  return [`# ${WATCH_TITLE}`, '',
    '由 signmonitor 網頁管理；也可以直接編輯下面兩行標記之間的內容，一行一個代號（例如 APP、HYPE）。',
    '自選標的不受流動性下限限制，盤中爆量門檻放寬（同時段 3 倍、近 48 小時 2 倍），通知標【自選】。',
    '', A, ...symbols, B, ''].join('\n');
}

/* ---------- GitHub ---------- */
async function gh(env, path, init = {}) {
  const r = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}), Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'signmonitor-worker',
      ...(init.body ? { 'Content-Type': 'application/json' } : {})
    }
  });
  if (!r.ok && r.status !== 204) throw new Error(`GitHub ${r.status}：${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
}
async function dispatch(env) {
  await gh(env, `/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: 'main', inputs: { daily: 'auto' } }) });
}
async function watchIssue(env) {
  const list = await gh(env, `/repos/${REPO}/issues?labels=${LABEL}&state=all&per_page=50`);
  let issue = list.find(i => i.title === WATCH_TITLE);
  if (!issue) issue = await gh(env, `/repos/${REPO}/issues`, { method: 'POST', body: JSON.stringify({ title: WATCH_TITLE, labels: [LABEL], body: formatWatch([]) }) });
  return issue;
}

/* ---------- 讀取三份清單的狀態（存在 Issue 本文最後的 gzip＋base64 區塊） ---------- */
async function gunzipB64(b64) {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}
async function stateOf(body, mark) {
  const a = (body || '').indexOf(`<!-- ${mark}`), b = (body || '').indexOf(`${mark} -->`);
  if (a < 0 || b < 0) return null;
  const raw = body.slice(a + mark.length + 5, b).trim();
  try { return JSON.parse(raw.startsWith('{') ? raw : await gunzipB64(raw)); } catch { return null; }
}
const pick = (o, ks) => Object.fromEntries(ks.filter(k => o[k] !== undefined).map(k => [k, o[k]]));

/* ---------- 即時價格、大盤、執行狀態（開網頁時抓，跟清單一起快取 60 秒） ---------- */
async function tj(url) {
  try { const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) }); return r.ok ? await r.json() : null; } catch { return null; }
}
/* need：{ okx:Set(instId), bitget:Set(symbol), bybit:Set(symbol), binance:Set(symbol) } → { okx:{id:價}, ..., ok:{venue:true/false} } */
async function livePrices(need) {
  const px = { okx: {}, bitget: {}, bybit: {}, binance: {} }, ok = {};
  const few = (set, n) => set.size > 0 && set.size <= n;
  const jobs = [];
  if (need.okx.size) jobs.push(tj('https://www.okx.com/api/v5/market/tickers?instType=SWAP').then(j => {
    ok.okx = !!j?.data; (j?.data || []).forEach(t => { if (need.okx.has(t.instId)) px.okx[t.instId] = +t.last; });
  }));
  /* Bitget、Bybit 只是備援來源，檔數少時逐檔抓，避免下載整份行情 */
  if (few(need.bitget, 15)) jobs.push(Promise.all([...need.bitget].map(s => tj(`https://api.bitget.com/api/v2/mix/market/ticker?symbol=${s}&productType=USDT-FUTURES`).then(j => {
    const t = j?.data?.[0]; if (t) { px.bitget[s] = +t.lastPr; ok.bitget = true; } else if (ok.bitget === undefined) ok.bitget = false;
  }))));
  else if (need.bitget.size) jobs.push(tj('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES').then(j => {
    ok.bitget = !!j?.data; (j?.data || []).forEach(t => { if (need.bitget.has(t.symbol)) px.bitget[t.symbol] = +t.lastPr; });
  }));
  if (few(need.bybit, 10)) jobs.push(Promise.all([...need.bybit].map(s => tj(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${s}`).then(j => {
    const t = j?.result?.list?.[0]; if (t) { px.bybit[s] = +t.lastPrice; ok.bybit = true; } else if (ok.bybit === undefined) ok.bybit = false;
  }))));
  else if (need.bybit.size) jobs.push(tj('https://api.bybit.com/v5/market/tickers?category=linear').then(j => {
    ok.bybit = !!j?.result?.list; (j?.result?.list || []).forEach(t => { if (need.bybit.has(t.symbol)) px.bybit[t.symbol] = +t.lastPrice; });
  }));
  if (need.binance.size) jobs.push(tj(`https://data-api.binance.vision/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify([...need.binance]))}`).then(j => {
    ok.binance = Array.isArray(j); (Array.isArray(j) ? j : []).forEach(t => { px.binance[t.symbol] = +t.price; });
  }));
  await Promise.all(jobs);
  return { px, ok };
}
/* BTC、ETH 的 4H 趨勢：EMA20／SMA30 狀態、上次交叉、距 SMA200、24h 漲跌（只用已收盤 K 判斷） */
async function trendOf(base) {
  let bars = null, src = 'Binance';
  const b = await tj(`https://data-api.binance.vision/api/v3/klines?symbol=${base}USDT&interval=4h&limit=300`);
  if (Array.isArray(b) && b.length > 230) bars = b.map(k => ({ t: +k[0], c: +k[4], ct: +k[6] }));
  else {
    const o = await tj(`https://www.okx.com/api/v5/market/candles?instId=${base}-USDT&bar=4H&limit=300`);
    if (o?.data?.length > 230) { src = 'OKX'; bars = o.data.slice().reverse().map(k => ({ t: +k[0], c: +k[4], ct: +k[0] + 144e5 - 1 })); }
  }
  if (!bars) return null;
  const now = Date.now(), last = bars[bars.length - 1].c;
  const cl = bars.filter(x => x.ct < now), n = cl.length, k = 2 / 21;
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
  const ago = bars.find(x => x.t >= now - 864e5);
  return { base, src, price: last, chg24: ago ? last / ago.c - 1 : null, up, since, px200: last / s200 - 1 };
}
async function lastRuns(env) {
  try {
    const j = await gh(env, `/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=10`);
    const runs = j.workflow_runs || [];
    const done = runs.find(r => r.status === 'completed');
    const fail = runs.filter(r => r.status === 'completed' && r.conclusion !== 'success').length;
    return { last: done ? { ok: done.conclusion === 'success', at: done.updated_at } : null, running: runs.some(r => r.status !== 'completed'), recentFail: fail, checked: runs.filter(r => r.status === 'completed').length };
  } catch { return null; }
}
/* Issue 本文的「資料警告」段落，直接顯示在網頁上 */
function warningsOf(body) {
  const i = (body || '').indexOf('## 資料警告');
  if (i < 0) return [];
  return body.slice(i).split('\n').slice(1).filter(l => l.startsWith('- ')).map(l => l.slice(2)).slice(0, 10);
}
function needOf(d) {
  const need = { okx: new Set(), bitget: new Set(), bybit: new Set(), binance: new Set() };
  const add = (v, id) => { if (v && id && need[v]) need[v].add(id); };
  if (d.short) [...d.short.pending, ...d.short.open].forEach(c => add(c.ex, c.id));
  if (d.layout) d.layout.active.forEach(it => { const v = layoutVenue(it); if (v) add(v, it.syms[v]); });
  if (d.cross) [...d.cross.active, ...d.cross.recentB].forEach(c => add('binance', c.sym));
  if (d.hourly) d.hourly.recent.forEach(a => add(a.venue, a.sym));
  return need;
}
/* 布局清單用哪一家報價：OKX → Bitget → Bybit */
function layoutVenue(it) { const s = it.syms || {}; return ['okx', 'bitget', 'bybit'].find(v => s[v]) || null; }

async function dashboard(env) {
  const list = await gh(env, `/repos/${REPO}/issues?labels=${LABEL}&state=all&per_page=50`);
  const by = t => list.find(i => i.title === t);
  const [hs, ss, ls, cs] = await Promise.all([
    stateOf(by('盤中爆量')?.body, 'HOURLY_STATE'),
    stateOf(by('短線清單')?.body, 'WATCHLIST_STATE'),
    stateOf(by('布局清單')?.body, 'LAYOUT_STATE'),
    stateOf(by('金叉清單')?.body, 'CROSS_STATE')
  ]);
  const urls = Object.fromEntries(['盤中爆量', '短線清單', '布局清單', '金叉清單', WATCH_TITLE].map(t => [t, by(t)?.html_url || null]));
  const updated = Object.fromEntries(['盤中爆量', '短線清單', '布局清單', '金叉清單'].map(t => [t, by(t)?.updated_at || null]));
  const d = {
    urls, updated,
    warnings: Object.fromEntries(['盤中爆量', '短線清單', '布局清單', '金叉清單'].map(t => [t, warningsOf(by(t)?.body)])),
    watch: parseWatch(by(WATCH_TITLE)?.body),
    hourly: hs ? { lastHour: hs.lastHour, recent: hs.recent || [] } : null,
    short: ss ? {
      lastDaily: ss.lastDaily,
      pending: (ss.pending || []).map(c => pick(c, ['base', 'cat', 'ex', 'id', 'dayT', 'hi', 'lo', 'close', 'vx', 'chgDay', 'pattern'])),
      open: (ss.open || []).map(c => pick(c, ['base', 'cat', 'ex', 'id', 'dayT', 'vx', 'side', 'entry', 'stop', 't1', 't2', 'trigT', 'riskPct', 'mfeR', 'maeR', 't1Hit', 'flags'])),
      closed: (ss.closed || []).slice(-100)
    } : null,
    layout: ls ? {
      lastDay: ls.lastDay,
      active: (ls.active || []).map(c => pick(c, ['base', 'cat', 'day', 'dayT', 'entry', 'last', 'ret', 'ex', 'mae', 'mfe', 'age', 'spiked', 'single', 'venues', 'syms', 'ref', 'respikes'])),
      closed: (ls.closed || []).slice(-100)
    } : null,
    cross: cs ? {
      lastBar: cs.lastBar, universe: cs.universe,
      active: (cs.active || []).map(c => pick(c, ['sym', 'base', 'stock', 't', 'close', 'last', 'ret', 'mfe', 'mae', 'still', 'deadT', 'deadRet', 'volx', 'px200', 'spread', 'stopPx', 'stopPct', 'bars', 'qv24h'])),
      recentB: (cs.recentB || []).slice(0, 150).map(c => pick(c, ['sym', 'base', 'stock', 't', 'close', 'volx', 'px200', 'reasons'])),
      closed: (cs.closed || []).slice(-100)
    } : null
  };
  const [live, btc, eth, runs] = await Promise.all([livePrices(needOf(d)), trendOf('BTC'), trendOf('ETH'), lastRuns(env)]);
  d.live = { ...live, at: Date.now() };
  d.market = [btc, eth].filter(Boolean);
  d.runs = runs;
  return d;
}

/* ---------- 交易所檢查（顯示用；監控程式會自己再比對一次） ---------- */
async function okJson(url) { try { const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }); return r.ok ? r.json() : null; } catch { return null; } }
async function exists(url) { try { const r = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' } }); return r.ok; } catch { return false; } }
async function venuesOf(sym) {
  const [okx, bitget, bitgetStock] = await Promise.all([
    okJson(`https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=${sym}-USDT-SWAP`),
    okJson(`https://api.bitget.com/api/v2/mix/market/ticker?symbol=${sym}USDT&productType=USDT-FUTURES`),
    okJson(`https://api.bitget.com/api/v2/mix/market/ticker?symbol=${sym}STOCKUSDT&productType=USDT-FUTURES`)
  ]);
  const out = {};
  if (okx?.data?.length) out.okx = `${sym}-USDT-SWAP`;
  if (bitget?.data?.length) out.bitget = `${sym}USDT`; else if (bitgetStock?.data?.length) out.bitget = `${sym}STOCKUSDT`;
  for (const s of [`${sym}STOCKUSDT`, `${sym}USDT`]) {
    if (await exists(`https://public.bybit.com/trading/${s}/`)) { out.bybit = s; break; }
  }
  return out;
}

/* ---------- API ---------- */
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
function authorized(req, env) {
  const p = req.headers.get('x-password') || '';
  if (!env.ADMIN_PASSWORD || p.length !== env.ADMIN_PASSWORD.length) return false;
  let d = 0; for (let i = 0; i < p.length; i++) d |= p.charCodeAt(i) ^ env.ADMIN_PASSWORD.charCodeAt(i);
  return d === 0;
}

async function api(req, env, url, ctx) {
  if (url.pathname === '/api/data' && req.method === 'GET') {
    /* 快取 60 秒，避免每次開網頁都打 GitHub */
    const cache = caches.default, key = new Request(url.origin + '/api/data');
    const hit = await cache.match(key);
    if (hit) return hit;
    const res = new Response(JSON.stringify(await dashboard(env)), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60' } });
    ctx.waitUntil(cache.put(key, res.clone()));
    return res;
  }
  if (url.pathname === '/api/watch' && req.method === 'GET') {
    const issue = await watchIssue(env);
    return json({ symbols: parseWatch(issue.body), issueUrl: issue.html_url });
  }
  if (url.pathname === '/api/check' && req.method === 'GET') {
    const sym = normalizeSymbol(url.searchParams.get('s'));
    if (!sym) return json({ error: '代號格式不對' }, 400);
    return json({ symbol: sym, venues: await venuesOf(sym) });
  }
  if (url.pathname === '/api/watch' && req.method === 'POST') {
    if (!env.ADMIN_PASSWORD) return json({ error: 'Worker 還沒設定 ADMIN_PASSWORD' }, 500);
    if (!authorized(req, env)) return json({ error: '密碼錯誤' }, 401);
    const { action, symbol } = await req.json().catch(() => ({}));
    const sym = normalizeSymbol(symbol);
    if (!sym || !['add', 'remove'].includes(action)) return json({ error: '代號或動作不對' }, 400);
    const issue = await watchIssue(env);
    let list = parseWatch(issue.body);
    let venues = null;
    if (action === 'add') {
      venues = await venuesOf(sym);
      if (!Object.keys(venues).length) return json({ error: `${sym} 在 OKX、Bitget、Bybit 都找不到永續合約` }, 404);
      if (!list.includes(sym)) list.push(sym);
    } else list = list.filter(s => s !== sym);
    await gh(env, `/repos/${REPO}/issues/${issue.number}`, { method: 'PATCH', body: JSON.stringify({ body: formatWatch(list), state: 'open' }) });
    await caches.default.delete(new Request(url.origin + '/api/data'));
    return json({ symbols: list, venues });
  }
  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, env, url, ctx);
      return new Response(PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatch(env));
  }
};


/* ---------- 網頁（單檔，手機優先） ---------- */
const PAGE = `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0f1115">
<title>signmonitor</title>
<style>
/* 固定深色模式（不跟著手機／電腦的淺色設定） */
:root{color-scheme:dark;--bg:#0f1115;--card:#171a20;--fg:#e8eaed;--mut:#9aa0a6;--line:#262b34;--acc:#60a5fa;--up:#34d399;--dn:#f87171;--warn:#fbbf24;--chip:#1d2433;--tag:#3a2e12;--tagfg:#fcd34d}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg)}
body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Noto Sans TC","PingFang TC",sans-serif;-webkit-text-size-adjust:100%}
header{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 16px 0}
.top{display:flex;align-items:center;gap:8px;max-width:720px;margin:0 auto}
.top h1{font-size:17px;margin:0;flex:1}.top .upd{font-size:12px;color:var(--mut)}
.btn{font:inherit;font-size:14px;padding:8px 12px;border:0;border-radius:8px;background:var(--acc);color:#fff;cursor:pointer;white-space:nowrap}
.btn.sec{background:var(--card);color:var(--fg);border:1px solid var(--line)}.btn.del{background:transparent;color:var(--dn);border:1px solid var(--line);padding:5px 10px;font-size:13px}
.btn:disabled{opacity:.5}
nav{display:flex;gap:4px;max-width:720px;margin:8px auto 0;overflow-x:auto}
nav button{flex:1;font:inherit;font-size:14px;padding:8px 6px;border:0;background:transparent;color:var(--mut);border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap}
nav button.on{color:var(--fg);border-bottom-color:var(--acc);font-weight:600}
main{max-width:720px;margin:0 auto;padding:12px 16px 48px}
.bar{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.bar select,.bar input{font:inherit;font-size:14px;padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg)}
.pill{font:inherit;font-size:13px;padding:5px 10px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--mut);cursor:pointer}
.pill.on{background:var(--chip);color:var(--acc);border-color:transparent}
h2{font-size:14px;color:var(--mut);margin:16px 0 8px;font-weight:600}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:8px}
.l1{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.sym{font-weight:700;font-size:16px;color:var(--fg);text-decoration:none}.sym:active{opacity:.6}
.badge{font-size:12px;padding:1px 7px;border-radius:999px;background:var(--chip);color:var(--acc)}
.tag{font-size:12px;padding:1px 7px;border-radius:4px;background:var(--tag);color:var(--tagfg);font-weight:600}
.cat{font-size:12px;color:var(--mut)}
.kv{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:2px 12px;margin-top:6px;font-size:14px}
.kv span{color:var(--mut);margin-right:4px}
.sub{font-size:13px;color:var(--mut);margin-top:4px}
.up{color:var(--up)}.dn{color:var(--dn)}.warn{color:var(--warn);font-size:13px;margin-top:4px}
.big{font-weight:700}
.row{display:flex;gap:8px}.row input{flex:1;min-width:0;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);text-transform:uppercase}
.row input::placeholder{text-transform:none}
.msg{font-size:14px;margin-top:8px;min-height:20px}.msg.err{color:var(--dn)}.msg.ok{color:var(--up)}
.empty{color:var(--mut);text-align:center;padding:24px 0}
.wl{display:flex;align-items:center;gap:8px;padding:10px 0;border-top:1px solid var(--line)}.wl:first-child{border-top:0}
.wl .chips{flex:1;display:flex;flex-wrap:wrap;gap:6px}
.stat{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;text-align:center}.stat b{display:block;font-size:18px}.stat small{color:var(--mut)}
a{color:var(--acc)}
.ct{font-size:11px;font-weight:600;letter-spacing:.06em;padding:1px 7px;border-radius:999px;border:1px solid;line-height:16px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.ct-crypto{color:#c4b5fd;border-color:rgba(196,181,253,.35);background:rgba(196,181,253,.08)}
.ct-stock{color:#5eead4;border-color:rgba(94,234,212,.35);background:rgba(94,234,212,.08)}
.ct-comm{color:#fcd34d;border-color:rgba(252,211,77,.35);background:rgba(252,211,77,.08)}
.mk{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;padding:6px 0;border-bottom:1px solid var(--line)}.mk:last-of-type{border-bottom:0}
.rs{font-size:12px;font-weight:700;padding:2px 8px;border-radius:4px;background:var(--chip);color:var(--acc)}.rs.bad{background:var(--dn);color:#fff}.rs.good{background:var(--up);color:#fff}.rs.w{background:var(--tag);color:var(--tagfg)}
.ov{padding:8px 0;border-top:1px solid var(--line)}.ov:first-child{border-top:0}.chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.st{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:4px 0}.dot{width:9px;height:9px;border-radius:50%;display:inline-block}.dot.good{background:var(--up)}.dot.bad{background:var(--dn)}
summary{cursor:pointer;list-style:none}summary::-webkit-details-marker{display:none}summary h2:before{content:'▸ '}details[open] summary h2:before{content:'▾ '}
</style></head><body>
<header><div class="top"><h1>signmonitor</h1><span class="upd" id="upd"></span><button class="btn sec" id="reload">重新整理</button></div>
<nav id="tabs"><button data-t="home" class="on">總覽</button><button data-t="hourly">盤中爆量</button><button data-t="short">短線</button><button data-t="layout">布局</button><button data-t="cross">金叉</button><button data-t="watch">自選</button></nav></header>
<main id="main"><div class="empty">讀取中…</div></main>
<script>
var D=null,TAB='home',PW='';try{PW=localStorage.getItem('sm_pw')||''}catch(e){}
var F={h:{only:'all',venue:'all',cat:'all'},l:{sort:'day',only:'all'}};
var VL={okx:'OKX',bitget:'Bitget',bybit:'Bybit'},TVX={okx:'OKX',bitget:'BITGET',bybit:'BYBIT'},CAT={crypto:'crypto',stock:'stock',comm:'commodity'};
function CT(c){return c&&CAT[c]?'<span class="ct ct-'+c+'">'+CAT[c]+'</span>':''}
var SIDE={long:'做多',short:'做空'},OUT={stop:'停損',t2:'達 T2',timeout:'逾時'};
var PAT={breakout:'突破區間',breakdown:'跌破區間',squeeze:'壓縮打底',base:'區間整理',trend_up:'上升趨勢',trend_dn:'下降趨勢'};
function $(id){return document.getElementById(id)}
function esc(t){return String(t==null?'':t).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function tv(v,sym,iv){if(!v||!sym)return null;var c=v==='okx'?String(sym).split('-')[0]:String(sym).replace(/USDT$/,'');return 'https://www.tradingview.com/chart/?symbol='+encodeURIComponent(TVX[v]+':'+c+'USDT.P')+'&interval='+iv}
function link(name,url){return url?'<a class="sym" target="_blank" rel="noopener" href="'+esc(url)+'">'+esc(name)+'</a>':'<span class="sym">'+esc(name)+'</span>'}
function fp(v){if(v==null||!isFinite(v))return '—';var a=Math.abs(v);return a>=1000?v.toFixed(1):a>=10?v.toFixed(2):a>=1?v.toFixed(3):Number(v.toPrecision(4)).toString()}
function pc(r){if(r==null||!isFinite(r))return '—';var v=r*100;return '<span class="'+(v>=0?'up':'dn')+'">'+(v>=0?'+':'')+v.toFixed(1)+'%</span>'}
function pc100(v){if(v==null)return '—';return '<span class="'+(v>=0?'up':'dn')+'">'+(v>=0?'+':'')+Number(v).toFixed(1)+'%</span>'}
function money(v){return v>=1e6?(v/1e6).toFixed(1)+'M':(v/1e3).toFixed(0)+'K'}
var TF=new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
function tpe(ms){if(!ms)return '—';var p={};TF.formatToParts(new Date(ms)).forEach(function(x){p[x.type]=x.value});return p.month+'-'+p.day+' '+p.hour+':'+p.minute}
function md(ms){return new Date(ms).toISOString().slice(5,10)}
function inWatch(b){return D&&D.watch&&D.watch.indexOf(b)>=0}
function pills(group,key,opts){return opts.map(function(o){return '<button class="pill'+(F[group][key]===o[0]?' on':'')+'" data-g="'+group+'" data-k="'+key+'" data-v="'+o[0]+'">'+o[1]+'</button>'}).join('')}

/* ---------- 即時價格 ---------- */
function LP(v,id){var L=D&&D.live&&D.live.px;var x=L&&L[v]&&L[v][id];return x&&isFinite(x)?x:null}
function lpLayout(it){var sy=it.syms||{},v=['okx','bitget','bybit'].filter(function(k){return sy[k]})[0];return v?LP(v,sy[v]):null}
function rNow(p,px){if(px==null)return null;var risk=Math.abs(p.entry-p.stop);if(!risk)return null;return (p.side==='long'?px-p.entry:p.entry-px)/risk}
function toStop(p,px){if(px==null)return null;return (p.side==='long'?(px-p.stop)/px:(p.stop-px)/px)*100}
function rr(v){if(v==null)return '—';return '<span class="'+(v>=0?'up':'dn')+'">'+(v>=0?'+':'')+v.toFixed(2)+'R</span>'}
function ago(ms){var m=Math.round((Date.now()-ms)/6e4);return m<60?m+' 分鐘前':m<1440?Math.round(m/60)+' 小時前':Math.round(m/1440)+' 天前'}
var H8=8*3600e3;

/* ---------- 總覽 ---------- */
function normBase(b,stock){b=String(b||'').toUpperCase();return stock&&/B$/.test(b)?b.slice(0,-1):b}
function marketCard(){
  var m=D.market||[];if(!m.length)return '<div class="card sub">大盤資料暫時抓不到</div>';
  return '<div class="card">'+m.map(function(t){
    return '<div class="mk"><b class="sym">'+t.base+'</b><span>'+fp(t.price)+'</span><span>24h '+pc(t.chg24)+'</span>'+
    '<span class="badge" style="color:var('+(t.up?'--up':'--dn')+')">4H '+(t.up?'金叉中':'死叉中')+(t.since?'（自 '+tpe(t.since)+'）':'')+'</span>'+
    '<span>距 SMA200 '+pc(t.px200)+'</span></div>'}).join('')+
    '<div class="sub">4H EMA20／SMA30。價格在 SMA200 下方時，金叉類做多訊號的回測表現偏弱。</div></div>'}
function item(reason,cls,name,url,extra,tags,notes){
  return '<div class="card it"><div class="l1"><span class="rs '+cls+'">'+reason+'</span>'+link(name,url)+(tags||'')+'</div>'+(extra?'<div class="kv">'+extra+'</div>':'')+
    (notes||[]).map(function(f){return '<div class="warn">'+esc(f)+'</div>'}).join('')+'</div>'}
function layoutUrl(it){var sy=it.syms||{},v=['okx','bitget','bybit'].filter(function(k){return sy[k]})[0];return v?tv(v,sy[v],'D'):null}
function kvs(o){return o.map(function(x){return '<div><span>'+x[0]+'</span>'+x[1]+'</div>'}).join('')}
function todo(){
  var now=Date.now(),out=[];
  var sh=D.short,lay=D.layout,cr=D.cross,hr=D.hourly;
  if(sh){
    sh.open.forEach(function(p){
      var px=LP(p.ex,p.id),r=rNow(p,px),why=null,cls='w';
      if(r!=null&&r<=-0.7){why='接近停損';cls='bad'}else if(r!=null&&r>=2.7){why='接近 T2';cls='good'}else if(r!=null&&r>=1.7&&!p.t1Hit){why='接近 T1';cls='good'}
      else if(p.trigT>=now-H8){why='新觸發'}
      if(!why)return;
      out.push({k:0,h:item(why,cls,p.base,tv(p.ex,p.id,'240'),kvs([['方向',SIDE[p.side]],['現價',fp(px)],['目前',rr(r)],['距停損',px==null?'—':toStop(p,px).toFixed(1)+'%'],['停損',fp(p.stop)],['T1／T2',fp(p.t1)+'／'+fp(p.t2)]]),CT(p.cat)+'<span class=\"cat\">短線持倉</span>',p.flags)})});
    sh.pending.forEach(function(c){
      var px=LP(c.ex,c.id);if(px==null)return;
      var side=px>c.hi?'long':px<c.lo?'short':null;if(!side)return;
      out.push({k:1,h:item('越過觸發價','w',c.base,tv(c.ex,c.id,'240'),kvs([['方向',SIDE[side]],['現價',fp(px)],['觸發價',fp(side==='long'?c.hi:c.lo)],['爆量',c.vx+'x']]),'<span class="cat">短線等待・待 4H 收盤確認</span>')})});
  }
  if(cr){
    cr.active.forEach(function(it){
      var px=LP('binance',it.sym);
      if(it.deadT&&it.deadT+144e5>=now-H8)out.push({k:2,h:item('金叉已死叉','bad',it.base,bn(it.sym),kvs([['死叉出場',pc100(it.deadRet)],['現價',fp(px||it.last)]]),stk(it)+'<span class="cat">出場參考</span>')});
      else if(it.t+144e5>=now-H8)out.push({k:2,h:item('新 A 級金叉','good',it.base,bn(it.sym),kvs([['金叉收',fp(it.close)],['現價',fp(px||it.last)],['量',it.volx+'x'],['距SMA200',pc100(it.px200)],['近6根低',fp(it.stopPx)+' (-'+(it.stopPct||0).toFixed(1)+'%)']]),stk(it))});
    })}
  if(hr){
    var rec=hr.recent.filter(function(a){return a.t>=now-5*3600e3});
    /* 同一檔多家同時爆量只列一次（取倍數最高那家） */
    var best={};rec.forEach(function(a){if(!best[a.base]||a.x1>best[a.base].x1)best[a.base]=a});
    var uniq=Object.keys(best).map(function(k){return best[k]}).sort(function(a,b){return b.x1-a.x1});
    var top=uniq.slice(0,5);
    uniq.forEach(function(a){if((a.watch||inWatch(a.base))&&top.indexOf(a)<0)top.push(a)});
    top.forEach(function(a){var px=LP(a.venue,a.sym);
      out.push({k:3,h:item((a.watch||inWatch(a.base))?'自選爆量':'盤中爆量','w',a.base,tv(a.venue,a.sym,'60'),kvs([['倍數',a.x1+'x'],['時間',tpe(a.t)],['爆量收',fp(a.price)],['現價',fp(px)],['之後',px&&a.price?pc(px/a.price-1):'—']]),CT(a.cat)+'<span class=\"cat\">'+kindH(a)+'</span>')})});
  }
  if(lay&&lay.lastDay){
    lay.active.filter(function(it){return it.day===lay.lastDay}).forEach(function(it){var px=lpLayout(it);
      out.push({k:4,h:item('新進布局','w',it.base,layoutUrl(it),kvs([['爆量日收',fp(it.entry)],['現價',fp(px||it.last)],['報酬',px?pc(px/it.entry-1):pc(it.ret)]]),CT(it.cat)+'<span class=\"cat\">'+kindL(it)+'</span>')})});
  }
  out.sort(function(a,b){return a.k-b.k});
  return out}
var MODS=[['hourly','盤中爆量'],['pend','短線等待'],['open','短線持倉'],['layout','布局'],['crossA','金叉 A'],['crossB','金叉 B']];
function overlap(){
  var m={};function add(b,k,txt){if(!b)return;m[b]=m[b]||{};if(!m[b][k])m[b][k]=txt}
  if(D.hourly)D.hourly.recent.forEach(function(a){add(normBase(a.base),'hourly',a.x1+'x '+tpe(a.t))});
  if(D.short){D.short.pending.forEach(function(c){add(normBase(c.base),'pend',c.vx+'x')});
    D.short.open.forEach(function(p){var r=rNow(p,LP(p.ex,p.id));add(normBase(p.base),'open',SIDE[p.side]+(r==null?'':' '+(r>=0?'+':'')+r.toFixed(1)+'R'))})}
  if(D.layout)D.layout.active.forEach(function(it){var px=lpLayout(it);add(normBase(it.base),'layout',((px?px/it.entry-1:it.ret)*100).toFixed(1)+'%')});
  if(D.cross){D.cross.active.forEach(function(it){add(normBase(it.base,it.stock),'crossA',it.deadT?'已死叉':'仍成立')});
    D.cross.recentB.forEach(function(it){add(normBase(it.base,it.stock),'crossB',tpe(it.t))})}
  return Object.keys(m).map(function(b){return {b:b,n:Object.keys(m[b]).length,m:m[b]}}).filter(function(x){return x.n>=2})
    .sort(function(a,b){return (b.n-a.n)||(inWatch(b.b)-inWatch(a.b))||a.b.localeCompare(b.b)})}
var MODEXP={'盤中爆量':3,'短線清單':3,'布局清單':30,'金叉清單':6};
function status(){
  var s='<div class="card">';
  Object.keys(MODEXP).forEach(function(t){
    var u=D.updated&&D.updated[t]?Date.parse(D.updated[t]):0,late=!u||Date.now()-u>MODEXP[t]*3600e3,w=(D.warnings&&D.warnings[t])||[];
    s+='<div class="st"><span class="dot '+(late||w.length?'bad':'good')+'"></span><b>'+t.replace('清單','')+'</b><span class="cat">'+(u?tpe(u)+'（'+ago(u)+'）':'尚無資料')+(late&&u?'　超過 '+MODEXP[t]+' 小時沒更新':'')+'</span></div>'+
      w.map(function(x){return '<div class="warn">'+esc(x)+'</div>'}).join('')});
  var R=D.runs;
  if(R&&R.last)s+='<div class="st"><span class="dot '+(R.last.ok?'good':'bad')+'"></span><b>最近一次執行</b><span class="cat">'+(R.last.ok?'成功':'失敗')+'　'+tpe(Date.parse(R.last.at))+(R.running?'　目前有一輪正在跑':'')+(R.recentFail?'　最近 '+R.checked+' 輪失敗 '+R.recentFail+' 次':'')+'</span></div>';
  var ok=(D.live&&D.live.ok)||{},names={okx:'OKX',bitget:'Bitget',bybit:'Bybit',binance:'Binance'};
  var ks=Object.keys(ok);
  /* Bybit 會擋部分地區，抓不到只註記，不算異常 */
  if(ks.length)s+='<div class="st"><span class="dot '+(liveBad()?'bad':'good')+'"></span><b>即時價格</b><span class="cat">'+ks.map(function(k){return names[k]+(ok[k]?' ✓':' 抓不到')}).join('　')+'</span></div>'+
    (ok.bybit===false?'<div class="sub">Bybit 在你目前的連線地區抓不到報價，只在 Bybit 有的標的現價會顯示「—」</div>':'');
  return s+'</div>'}
function liveBad(){var ok=(D.live&&D.live.ok)||{};return ['okx','bitget','binance'].some(function(k){return ok[k]===false})}
function sysBad(){
  var bad=Object.keys(MODEXP).some(function(t){var u=D.updated&&D.updated[t]?Date.parse(D.updated[t]):0;return (u&&Date.now()-u>MODEXP[t]*3600e3)||((D.warnings&&D.warnings[t])||[]).length});
  return bad||(D.runs&&D.runs.last&&!D.runs.last.ok)||liveBad()}
function home(){
  var s=sysBad()?'<div class="card warn" style="margin-top:12px">系統有異常（更新延遲、執行失敗或資料警告），詳見最下方「系統狀態」</div>':'';
  s+='<h2>大盤</h2>'+marketCard();
  var t=todo();
  s+='<h2>需要處理（'+t.length+'）</h2>';
  s+=t.length?t.map(function(x){return x.h}).join(''):'<div class="card empty">目前沒有需要處理的項目</div>';
  var o=overlap();
  s+='<h2>多模組重疊（'+o.length+'）</h2><div class="sub" style="margin:-4px 0 8px">同一檔同時出現在 2 個以上模組</div>';
  if(!o.length)s+='<div class="card empty">無</div>';
  else s+='<div class="card">'+o.map(function(x){
    return '<div class="ov"><div class="l1">'+(inWatch(x.b)?'<span class="tag">自選</span>':'')+'<span class="sym">'+esc(x.b)+'</span><span class="cat">'+x.n+' 個模組</span></div><div class="chips">'+
      MODS.filter(function(k){return x.m[k[0]]}).map(function(k){return '<span class="badge">'+k[1]+' '+esc(x.m[k[0]])+'</span>'}).join('')+'</div></div>'}).join('')+'</div>';
  s+='<h2>系統狀態</h2>'+status();
  return s}

function kindH(a){if(a.single)return '只有 '+VL[a.venue];if(a.spikedOthers&&a.spikedOthers.length)return [a.venue].concat(a.spikedOthers).map(function(v){return VL[v]}).join('＋')+' 同時';return VL[a.venue]}
function hourly(){
  var h=D.hourly;if(!h)return '<div class="empty">還沒有盤中爆量資料</div>';
  var f=F.h,list=h.recent.filter(function(a){
    if(f.only==='watch'&&!(a.watch||inWatch(a.base)))return false;
    if(f.only==='single'&&!a.single)return false;
    if(f.venue!=='all'&&a.venue!==f.venue)return false;
    if(f.cat!=='all'&&a.cat!==f.cat)return false;return true});
  var s='<div class="bar">'+pills('h','only',[['all','全部'],['watch','只看自選'],['single','只有一家']])+'</div>';
  s+='<div class="bar">'+pills('h','venue',[['all','全部交易所'],['okx','OKX'],['bitget','Bitget'],['bybit','Bybit']])+pills('h','cat',[['all','全部類別'],['crypto','crypto'],['stock','stock'],['comm','commodity']])+'</div>';
  s+='<div class="sub" style="margin-bottom:8px">最近檢查：'+tpe(h.lastHour)+' 那根 1H K　共 '+list.length+' 筆（72 小時內）</div>';
  if(!list.length)return s+'<div class="empty">沒有符合的紀錄</div>';
  var last=null;
  list.forEach(function(a){
    if(a.t!==last){last=a.t;s+='<h2>'+tpe(a.t)+'–'+tpe(a.t+3600e3).slice(6)+'</h2>'}
    var o=Object.keys(a.others||{}).map(function(v){return VL[v]+' '+a.others[v]+'x'}).join('｜')||'其他家無此合約或資料不足';
    s+='<div class="card"><div class="l1">'+((a.watch||inWatch(a.base))?'<span class="tag">自選</span>':'')+link(a.base,tv(a.venue,a.sym,'60'))+CT(a.cat)+'<span class="badge">'+kindH(a)+'</span></div>'+
      '<div class="kv"><div><span>同時段</span><b class="big">'+a.x1+'x</b></div><div><span>近48h</span>'+a.x2+'x</div><div><span>爆量收</span>'+fp(a.price)+'</div><div><span>1H</span>'+pc100(a.chg)+'</div><div><span>成交額</span>'+money(a.qv)+'</div>'+(function(){var px=LP(a.venue,a.sym);return px?'<div><span>現價</span>'+fp(px)+'</div><div><span>之後</span>'+(a.price?pc(px/a.price-1):'—')+'</div>':''})()+'</div>'+
      '<div class="sub">'+esc(o)+'</div></div>'});
  return s}

function short(){
  var x=D.short;if(!x)return '<div class="empty">還沒有短線清單資料</div>';
  var s='<div class="sub">最近每日掃描：'+esc(x.lastDaily||'—')+'</div>';
  s+='<h2>持倉中（'+x.open.length+'）</h2>';
  if(!x.open.length)s+='<div class="empty">無</div>';
  x.open.slice().sort(function(a,b){return b.trigT-a.trigT}).forEach(function(p){
    s+='<div class="card"><div class="l1">'+(inWatch(p.base)?'<span class="tag">自選</span>':'')+link(p.base,tv(p.ex,p.id,'240'))+CT(p.cat)+'<span class="badge">'+SIDE[p.side]+'</span>'+(p.t1Hit?'<span class="badge">T1 ✓</span>':'')+'</div>'+
    (function(){var px=LP(p.ex,p.id),r=rNow(p,px);return '<div class="kv"><div><span>現價</span><b class="big">'+fp(px)+'</b></div><div><span>目前</span><b class="big">'+rr(r)+'</b></div><div><span>距停損</span>'+(px==null?'—':toStop(p,px).toFixed(1)+'%')+'</div></div>'})()+
    '<div class="kv"><div><span>進場</span>'+fp(p.entry)+'</div><div><span>停損</span>'+fp(p.stop)+' ('+(p.riskPct||0).toFixed(1)+'%)</div><div><span>T1</span>'+fp(p.t1)+'</div><div><span>T2</span>'+fp(p.t2)+'</div><div><span>最大有利</span>+'+(p.mfeR||0).toFixed(1)+'R</div><div><span>觸發</span>'+tpe(p.trigT)+'</div></div>'+
    ((p.flags||[]).map(function(f){return '<div class="warn">'+esc(f)+'</div>'}).join(''))+'</div>'});
  s+='<h2>等待觸發（'+x.pending.length+'）</h2>';
  if(!x.pending.length)s+='<div class="empty">無</div>';
  x.pending.slice().sort(function(a,b){return (inWatch(b.base)-inWatch(a.base))||(b.dayT-a.dayT)||(b.vx-a.vx)}).forEach(function(c){
    s+='<div class="card"><div class="l1">'+(inWatch(c.base)?'<span class="tag">自選</span>':'')+link(c.base,tv(c.ex,c.id,'240'))+CT(c.cat)+'<span class="badge">'+c.vx+'x</span><span class="cat">'+(PAT[c.pattern]||'')+'</span></div>'+
    '<div class="kv"><div><span>爆量日</span>'+md(c.dayT)+' '+pc100(c.chgDay)+'</div><div><span>收</span>'+fp(c.close)+'</div><div><span>做多</span>4H 收 &gt; '+fp(c.hi)+'</div><div><span>做空</span>4H 收 &lt; '+fp(c.lo)+'</div>'+(function(){var px=LP(c.ex,c.id);if(px==null)return '';
      var st=px>c.hi?'<b class="up">已越過做多價</b>':px<c.lo?'<b class="dn">已跌破做空價</b>':'距做多 '+((c.hi/px-1)*100).toFixed(1)+'%／距做空 '+((1-c.lo/px)*100).toFixed(1)+'%';
      return '<div><span>現價</span>'+fp(px)+'</div><div>'+st+'</div>'})()+'</div></div>'});
  var cl=x.closed||[];
  s+='<h2>成績（已結算 '+cl.length+'）</h2>';
  if(cl.length){var w=cl.filter(function(p){return p.r>0}).length,sum=cl.reduce(function(a,p){return a+p.r},0);
    s+='<div class="card stat"><div><b>'+cl.length+'</b><small>筆數</small></div><div><b>'+(w/cl.length*100).toFixed(0)+'%</b><small>勝率</small></div><div><b>'+(sum/cl.length>=0?'+':'')+(sum/cl.length).toFixed(2)+'R</b><small>平均</small></div></div>';
    cl.slice(-20).reverse().forEach(function(p){s+='<div class="card"><div class="l1">'+link(p.base,tv(p.ex,p.id,'240'))+'<span class="badge">'+SIDE[p.side]+'</span><span class="cat">'+(OUT[p.outcome]||'')+'</span><span class="'+(p.r>=0?'up':'dn')+' big">'+(p.r>=0?'+':'')+p.r.toFixed(2)+'R</span></div><div class="sub">'+fp(p.entry)+' → '+fp(p.exit)+'　'+tpe(p.exitT)+'</div></div>'})}
  else s+='<div class="empty">尚無</div>';
  return s}

function kindL(it){if(it.single)return '只有 '+VL[it.spiked[0]];if(it.spiked.length>1)return it.spiked.map(function(v){return VL[v]}).join('＋')+' 同時';return VL[it.spiked[0]]}
function lLink(it){var sy=it.syms||{},v=(it.spiked||[]).filter(function(x){return sy[x]})[0]||(sy[it.ref]?it.ref:Object.keys(sy).filter(function(x){return sy[x]})[0]);return link(it.base,v?tv(v,sy[v],'D'):null)}
function layout(){
  var x=D.layout;if(!x)return '<div class="empty">還沒有布局清單資料</div>';
  var f=F.l,list=x.active.filter(function(it){return f.only==='all'||(f.only==='single'?it.single:inWatch(it.base))});
  var key={day:function(a,b){return b.day.localeCompare(a.day)},ret:function(a,b){return (b.ret||0)-(a.ret||0)},ex:function(a,b){return (b.ex||0)-(a.ex||0)},mae:function(a,b){return (a.mae||0)-(b.mae||0)}}[f.sort];
  list.sort(key);
  var s='<div class="bar">'+pills('l','sort',[['day','最新'],['ret','報酬'],['ex','相對大盤'],['mae','回撤最深']])+'</div><div class="bar">'+pills('l','only',[['all','全部'],['single','只有一家爆量'],['watch','只看自選']])+'</div>';
  s+='<div class="sub" style="margin-bottom:8px">資料日 '+esc(x.lastDay||'—')+'（UTC 日線）　追蹤中 '+list.length+' 檔</div>';
  if(!list.length)s+='<div class="empty">沒有符合的標的</div>';
  list.forEach(function(it){
    var vv=['okx','bitget','bybit'].map(function(v){var q=it.venues&&it.venues[v];return q?(it.spiked.indexOf(v)>=0?'<b>'+VL[v]+' '+q.x+'x</b>':VL[v]+' '+q.x+'x'):VL[v]+' —'}).join('｜');
    s+='<div class="card"><div class="l1">'+(inWatch(it.base)?'<span class="tag">自選</span>':'')+lLink(it)+CT(it.cat)+'<span class="badge">'+kindL(it)+'</span>'+(it.respikes?'<span class="cat">再爆量 '+it.respikes+'</span>':'')+'</div>'+
    '<div class="kv"><div><span>爆量日</span>'+it.day.slice(5)+'</div><div><span>天數</span>'+(it.age||0)+'</div><div><span>爆量日收</span>'+fp(it.entry)+'</div>'+(function(){var px=lpLayout(it);return px?'<div><span>現價</span>'+fp(px)+'</div><div><span>報酬</span><b>'+pc(px/it.entry-1)+'</b></div>':'<div><span>現價</span>'+fp(it.last)+'</div><div><span>報酬</span>'+pc(it.ret)+'</div>'})()+'<div><span>相對大盤</span>'+pc(it.ex)+'</div><div><span>最大回撤</span>'+pc(it.mae)+'</div></div>'+
    '<div class="sub">'+vv+'</div></div>'});
  return s}

function bn(sym){return 'https://www.tradingview.com/chart/?symbol='+encodeURIComponent('BINANCE:'+sym)+'&interval=240'}
function stk(x){return CT(x.stock?'stock':'crypto')}
function cross(){
  var x=D.cross;if(!x)return '<div class="empty">還沒有金叉資料（第一次會在下一根 4H K 收盤後出現）</div>';
  var s='<div class="sub" style="margin-bottom:8px">Binance 現貨 4H，EMA20 上穿 SMA30。最近檢查：'+(x.lastBar?tpe(x.lastBar)+'–'+tpe(x.lastBar+144e5).slice(6):'—')+' 那根 K　範圍 '+(x.universe||0)+' 檔</div>';
  s+='<h2>A 級追蹤中（'+x.active.length+'）</h2><div class="sub" style="margin:-4px 0 8px">收盤 &gt; SMA200 且量 ≥ 1.5 倍；追蹤 42 根（7 天），死叉＝出場參考</div>';
  if(!x.active.length)s+='<div class="empty">無</div>';
  x.active.forEach(function(it){
    var stt=it.deadT?'<span class="badge" style="color:var(--dn)">已死叉 '+pc100(it.deadRet)+'</span>':'<span class="badge" style="color:var(--up)">仍成立</span>';
    s+='<div class="card"><div class="l1">'+link(it.base,bn(it.sym))+stk(it)+stt+'<span class="cat">'+tpe(it.t)+' 金叉</span></div>'+
    '<div class="kv"><div><span>金叉收</span>'+fp(it.close)+'</div>'+(function(){var px=LP('binance',it.sym)||it.last;return '<div><span>現價</span>'+fp(px)+'</div><div><span>報酬</span><b class="big">'+pc(px/it.close-1)+'</b></div>'})()+'<div><span>最大漲</span>'+pc100(it.mfe)+'</div><div><span>最大跌</span>'+pc100(it.mae)+'</div><div><span>量</span>'+it.volx+'x</div><div><span>距SMA200</span>'+pc100(it.px200)+'</div><div><span>近6根低</span>'+fp(it.stopPx)+' (-'+(it.stopPct||0).toFixed(1)+'%)</div><div><span>根數</span>'+(it.bars||0)+'/42</div></div></div>'});
  s+='<details open><summary><h2 style="display:inline">B 級（48 小時內 '+x.recentB.length+'，不推播）</h2></summary>';
  if(!x.recentB.length)s+='<div class="empty">無</div>';
  x.recentB.forEach(function(it){
    s+='<div class="card"><div class="l1">'+link(it.base,bn(it.sym))+stk(it)+'<span class="cat">'+tpe(it.t)+'</span></div>'+
    '<div class="kv"><div><span>收</span>'+fp(it.close)+'</div><div><span>量</span>'+(it.volx==null?'—':it.volx+'x')+'</div><div><span>距SMA200</span>'+pc100(it.px200)+'</div></div><div class="sub">'+esc((it.reasons||[]).join('、'))+'</div></div>'});
  s+='</details>';
  var cl=x.closed||[];
  s+='<h2>成績（已結算 '+cl.length+'）</h2>';
  if(cl.length){var w=cl.filter(function(p){return p.exitRet>0}).length,sum=cl.reduce(function(a,p){return a+p.exitRet},0);
    s+='<div class="card stat"><div><b>'+cl.length+'</b><small>筆數</small></div><div><b>'+(w/cl.length*100).toFixed(0)+'%</b><small>勝率</small></div><div><b>'+pc100(sum/cl.length)+'</b><small>平均（死叉出場）</small></div></div>';
    cl.slice(-20).reverse().forEach(function(p){s+='<div class="card"><div class="l1">'+link(p.base,bn(p.sym))+stk(p)+'<span class="big">'+pc100(p.exitRet)+'</span><span class="cat">'+(p.deadT?'死叉出場':'滿 42 根')+'</span></div><div class="sub">'+tpe(p.t)+' 金叉　最大漲 '+pc100(p.mfe)+'／最大跌 '+pc100(p.mae)+'</div></div>'})}
  else s+='<div class="empty">尚無（A 級追蹤滿 42 根後結算）</div>';
  return s}

var VC={};
function watch(){
  var s='<div class="card" id="pwcard" style="display:'+(PW?'none':'block')+'"><div class="row"><input id="pw" type="password" placeholder="密碼（只需輸入一次）" style="text-transform:none"><button class="btn" id="pwsave">確定</button></div></div>';
  s+='<div class="card"><div class="row"><input id="sym" placeholder="代號，例如 APP、HYPE" autocapitalize="characters" autocomplete="off" spellcheck="false"><button class="btn" id="add">加入</button></div><div class="msg" id="msg"></div>'+
     '<div class="sub">一律監控；盤中爆量門檻放寬為同時段 3 倍、近 48 小時 2 倍。加入後下一個整點生效。</div></div>';
  s+='<div class="card" id="wl">'+(D.watch.length?'':'<div class="empty">還沒有自選標的</div>')+'</div>';
  var rec=(D.hourly?D.hourly.recent:[]).filter(function(a){return a.watch||inWatch(a.base)});
  s+='<h2>自選標的的盤中爆量（72 小時內 '+rec.length+' 筆）</h2>';
  if(!rec.length)s+='<div class="empty">尚無</div>';
  rec.forEach(function(a){s+='<div class="card"><div class="l1">'+link(a.base,tv(a.venue,a.sym,'60'))+'<span class="badge">'+kindH(a)+'</span><span class="cat">'+tpe(a.t)+'</span></div><div class="kv"><div><span>同時段</span><b>'+a.x1+'x</b></div><div><span>近48h</span>'+a.x2+'x</div><div><span>價格</span>'+fp(a.price)+'</div><div><span>1H</span>'+pc100(a.chg)+'</div></div></div>'});
  return s}
function drawWatch(){
  var box=$('wl');if(!box)return;
  if(!D.watch.length){box.innerHTML='<div class="empty">還沒有自選標的</div>';return}
  box.innerHTML='';
  D.watch.forEach(function(sym){
    var d=document.createElement('div');d.className='wl';
    d.innerHTML='<span class="sym" style="min-width:64px"></span><span class="chips cat">檢查中…</span><button class="btn del">移除</button>';
    d.querySelector('.sym').textContent=sym;d.querySelector('button').onclick=function(){change('remove',sym)};box.appendChild(d);
    var put=function(v){var c=d.querySelector('.chips');c.className='chips';var ks=Object.keys(v);if(!ks.length){c.className='chips cat';c.textContent='三家都找不到合約';return}
      c.innerHTML=ks.map(function(k){return '<a class="badge" target="_blank" rel="noopener" href="'+esc(tv(k,v[k],'60'))+'">'+VL[k]+'</a>'}).join('')};
    if(VC[sym])put(VC[sym]);else fetch('/api/check?s='+encodeURIComponent(sym)).then(function(r){return r.json()}).then(function(j){VC[sym]=j.venues||{};put(VC[sym])}).catch(function(){});
  })}
function msg(t,c){var m=$('msg');if(m){m.textContent=t;m.className='msg '+(c||'')}}
function change(action,symbol){
  if(!PW){msg('請先輸入密碼','err');$('pwcard').style.display='block';return}
  var b=$('add');if(b)b.disabled=true;msg(action==='add'?'檢查三家交易所中…':'移除中…');
  fetch('/api/watch',{method:'POST',headers:{'Content-Type':'application/json','x-password':PW},body:JSON.stringify({action:action,symbol:symbol})})
  .then(function(r){return r.json().then(function(j){return {r:r,j:j}})}).then(function(o){
    if(o.r.status===401){PW='';try{localStorage.removeItem('sm_pw')}catch(e){}$('pwcard').style.display='block'}
    if(!o.r.ok)throw new Error(o.j.error||o.r.status);
    D.watch=o.j.symbols;
    if(action==='add'){VC[symbol]=o.j.venues||VC[symbol];msg(symbol+' 已加入（'+Object.keys(o.j.venues||{}).map(function(x){return VL[x]}).join('、')+'），下一個整點生效','ok');$('sym').value=''}
    else msg(symbol+' 已移除','ok');
    drawWatch()}).catch(function(e){msg(e.message,'err')}).then(function(){if(b)b.disabled=false})}

function bind(){
  document.querySelectorAll('.pill').forEach(function(p){p.onclick=function(){F[p.dataset.g][p.dataset.k]=p.dataset.v;draw()}});
  if(TAB==='watch'){
    drawWatch();
    var inp=$('sym');
    inp.addEventListener('input',function(){var st=inp.selectionStart,en=inp.selectionEnd;inp.value=inp.value.toUpperCase().replace(/\\s+/g,'');try{inp.setSelectionRange(st,en)}catch(e){}});
    inp.addEventListener('keydown',function(e){if(e.key==='Enter')$('add').click()});
    $('add').onclick=function(){var v=inp.value.trim().toUpperCase();if(v)change('add',v)};
    $('pwsave').onclick=function(){PW=$('pw').value.trim();try{localStorage.setItem('sm_pw',PW)}catch(e){}$('pwcard').style.display=PW?'none':'block'};
  }}
function draw(){if(!D)return;$('main').innerHTML=({home:home,hourly:hourly,short:short,layout:layout,cross:cross,watch:watch})[TAB]();bind()}
function load(){
  $('reload').disabled=true;
  fetch('/api/data').then(function(r){return r.json()}).then(function(j){if(j.error)throw new Error(j.error);D=j;
    var u=Object.keys(j.updated||{}).map(function(k){return Date.parse(j.updated[k])||0});$('upd').textContent=u.length?'更新 '+tpe(Math.max.apply(null,u)):'';draw()})
  .catch(function(e){$('main').innerHTML='<div class="empty">讀取失敗：'+esc(e.message)+'</div>'}).then(function(){$('reload').disabled=false})}
document.querySelectorAll('#tabs button').forEach(function(b){b.onclick=function(){TAB=b.dataset.t;document.querySelectorAll('#tabs button').forEach(function(x){x.classList.toggle('on',x===b)});try{localStorage.setItem('sm_tab',TAB)}catch(e){}draw()}});
$('reload').onclick=load;load();
</script></body></html>`;
