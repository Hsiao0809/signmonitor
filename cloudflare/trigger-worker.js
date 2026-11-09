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
/* need：{ okx:Set(instId), bybit:Set(symbol) } → { px:{ okx:{id:價}, bybit:{...} }, ok:{venue:true/false} } */
async function livePrices(need) {
  const px = { okx: {}, bybit: {} }, ok = {};
  const few = (set, n) => set.size > 0 && set.size <= n;
  const jobs = [];
  if (need.okx.size) jobs.push(tj('https://www.okx.com/api/v5/market/tickers?instType=SWAP').then(j => {
    ok.okx = !!j?.data; (j?.data || []).forEach(t => { if (need.okx.has(t.instId)) px.okx[t.instId] = +t.last; });
  }));
  /* Bybit 只是備援來源，檔數少時逐檔抓，避免下載整份行情。Binance、Bitget 擋 Cloudflare，改用 GitHub 每小時的行情快照 */
  if (few(need.bybit, 10)) jobs.push(Promise.all([...need.bybit].map(s => tj(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${s}`).then(j => {
    const t = j?.result?.list?.[0]; if (t) { px.bybit[s] = +t.lastPrice; ok.bybit = true; } else if (ok.bybit === undefined) ok.bybit = false;
  }))));
  else if (need.bybit.size) jobs.push(tj('https://api.bybit.com/v5/market/tickers?category=linear').then(j => {
    ok.bybit = !!j?.result?.list; (j?.result?.list || []).forEach(t => { if (need.bybit.has(t.symbol)) px.bybit[t.symbol] = +t.lastPrice; });
  }));
  await Promise.all(jobs);
  return { px, ok };
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
  const need = { okx: new Set(), bybit: new Set() };
  const add = (v, id) => { if (v && id && need[v]) need[v].add(id); };
  if (d.short) [...d.short.pending, ...d.short.open].forEach(c => add(c.ex, c.id));
  if (d.layout) d.layout.active.forEach(it => { const v = layoutVenue(it); if (v) add(v, it.syms[v]); });
  if (d.hourly) d.hourly.recent.forEach(a => add(a.venue, a.sym));
  return need;
}
/* 布局清單用哪一家報價：OKX → Bitget（快照）→ Bybit */
function layoutVenue(it) { const s = it.syms || {}; return ['okx', 'bitget', 'bybit'].find(v => s[v]) || null; }

async function dashboard(env) {
  const list = await gh(env, `/repos/${REPO}/issues?labels=${LABEL}&state=all&per_page=50`);
  const by = t => list.find(i => i.title === t);
  const [hs, ss, ls, cs, sn, sw, qs] = await Promise.all([
    stateOf(by('盤中爆量')?.body, 'HOURLY_STATE'),
    stateOf(by('短線清單')?.body, 'WATCHLIST_STATE'),
    stateOf(by('布局清單')?.body, 'LAYOUT_STATE'),
    stateOf(by('金叉清單')?.body, 'CROSS_STATE'),
    stateOf(by('行情快照')?.body, 'SNAPSHOT_STATE'),
    stateOf(by('掃流動性')?.body, 'SWEEP_STATE'),
    stateOf(by('量增價平')?.body, 'QUIET_STATE')
  ]);
  const urls = Object.fromEntries(['盤中爆量', '短線清單', '布局清單', '金叉清單', '掃流動性', WATCH_TITLE].map(t => [t, by(t)?.html_url || null]));
  const updated = Object.fromEntries(['盤中爆量', '短線清單', '布局清單', '金叉清單', '掃流動性'].map(t => [t, by(t)?.updated_at || null]));
  const d = {
    urls, updated,
    warnings: Object.fromEntries(['盤中爆量', '短線清單', '布局清單', '金叉清單', '掃流動性'].map(t => [t, warningsOf(by(t)?.body)])),
    watch: parseWatch(by(WATCH_TITLE)?.body),
    hourly: hs ? { lastHour: hs.lastHour, recent: hs.recent || [] } : null,
    short: ss ? {
      lastDaily: ss.lastDaily,
      pending: (ss.pending || []).map(c => pick(c, ['base', 'cat', 'ex', 'id', 'dayT', 'hi', 'lo', 'close', 'vx', 'chgDay', 'pattern', 'quiet', 'qlim', 'atrp'])),
      open: (ss.open || []).map(c => pick(c, ['base', 'cat', 'ex', 'id', 'dayT', 'vx', 'side', 'entry', 'stop', 't1', 't2', 'trigT', 'riskPct', 'mfeR', 'maeR', 't1Hit', 'flags'])),
      closed: (ss.closed || []).slice(-100)
    } : null,
    layout: ls ? {
      lastDay: ls.lastDay,
      active: (ls.active || []).map(c => pick(c, ['base', 'cat', 'day', 'dayT', 'entry', 'last', 'ret', 'ex', 'mae', 'mfe', 'age', 'spiked', 'single', 'venues', 'syms', 'ref', 'respikes', 'quiet', 'qlim', 'atrp', 'chgDay'])),
      closed: (ls.closed || []).slice(-100)
    } : null,
    cross: cs ? {
      lastBar: cs.lastBar, universe: cs.universe,
      active: (cs.active || []).map(c => pick(c, ['sym', 'base', 'stock', 't', 'close', 'last', 'ret', 'mfe', 'mae', 'still', 'deadT', 'deadRet', 'volx', 'px200', 'spread', 'stopPx', 'stopPct', 'bars', 'qv24h'])),
      recentB: (cs.recentB || []).slice(0, 150).map(c => pick(c, ['sym', 'base', 'stock', 't', 'close', 'volx', 'px200', 'reasons'])),
      closed: (cs.closed || []).slice(-100)
    } : null,
    quiet: qs ? { items: qs.items || [], done: (qs.done || []).slice(-300) } : null,
    sweep: sw ? {
      lastBar: sw.lastBar, targets: sw.targets,
      events: (sw.events || []).map(e => pick(e, ['base', 'cat', 'ex', 'id', 'src', 't', 'side', 'lv', 'x', 'c', 'volx', 'wk', 'firstSeen']))
    } : null
  };
  const [live, runs] = await Promise.all([livePrices(needOf(d)), lastRuns(env)]);
  d.live = { ...live, at: Date.now() };
  /* Binance、Bitget 價格與大盤：GitHub 每小時存的快照 */
  d.snap = sn ? { t: sn.t, px: sn.px || {}, warnings: sn.warnings || [] } : null;
  d.market = sn?.market || [];
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


/* ---------- 網頁（單檔；電腦用表格、手機自動變精簡列，篩選列固定在上方） ---------- */
const PAGE = `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0f1115">
<title>signmonitor</title>
<style>
/* 固定深色模式（不跟著手機／電腦的淺色設定） */
:root{color-scheme:dark;--bg:#0f1115;--card:#171a20;--fg:#e8eaed;--mut:#9aa0a6;--line:#262b34;--acc:#60a5fa;--up:#34d399;--dn:#f87171;--warn:#fbbf24;--chip:#1d2433;--tag:#3a2e12;--tagfg:#fcd34d;--hov:#161a22}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg)}
/* 整頁不捲動：標題、分頁、篩選列固定，只有內容區捲動 */
html,body{height:100%;overflow:hidden}
body{display:flex;flex-direction:column;height:100vh;height:100dvh;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Noto Sans TC","PingFang TC",sans-serif;-webkit-text-size-adjust:100%}
header{flex:none;background:var(--bg);border-bottom:1px solid var(--line);padding:0 max(12px,calc((100% - 1600px)/2))}
.hd{display:flex;align-items:center;flex-wrap:wrap;column-gap:14px}
.hd h1{font-size:16px;margin:0;padding:12px 0}
nav{order:2;flex:1 1 auto;display:flex;gap:2px;overflow-x:auto;scrollbar-width:none}nav::-webkit-scrollbar{display:none}
nav button{font:inherit;font-size:14px;padding:12px 10px 10px;border:0;background:transparent;color:var(--mut);border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap}
nav button i{font-style:normal;font-size:11px;margin-left:4px;opacity:.75;font-variant-numeric:tabular-nums}
nav button.on{color:var(--fg);border-bottom-color:var(--acc);font-weight:600}
.hd .upd{order:3;font-size:12px;color:var(--mut);white-space:nowrap}
.hd .btn{order:4}
@media(max-width:900px){.hd h1{flex:1;padding:8px 0}nav{order:5;flex-basis:100%}nav button{flex:1;padding:8px 4px}}
.btn{font:inherit;font-size:13px;padding:6px 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer;white-space:nowrap}
.btn.pri{background:var(--acc);border-color:transparent;color:#fff}
.btn.del{background:transparent;color:var(--dn);padding:3px 10px;font-size:12px}
.btn:disabled{opacity:.5}
main{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:0 max(12px,calc((100% - 1600px)/2)) 40px}
/* 電腦：整個畫面固定一屏，每個區塊各自捲動。手機：螢幕太小，維持內容區整體捲動 */
.pnl-b{scrollbar-width:thin;scrollbar-color:#2c3340 transparent}
.pnl-b::-webkit-scrollbar{width:8px;height:8px}.pnl-b::-webkit-scrollbar-thumb{background:#2c3340;border-radius:4px}
@media(min-width:901px){
  main{display:flex;flex-direction:column;overflow:hidden;padding-bottom:10px}
  .fb{flex:none}
  #ct{flex:1;min-height:0;display:flex;flex-direction:column}
  .vs{flex:1;min-height:0;display:flex;flex-direction:column}
  .home,.wg{flex:1;min-height:0;grid-template-rows:minmax(0,1fr)}
  .pnl{display:flex;flex-direction:column;min-height:0;flex:0 1 auto}
  .pnl.grow{flex:1 1 auto}.pnl.fix{flex:none}
  .pnl>h2{flex:none}
  .pnl-b{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain}
  .meta{flex:none}}
/* 篩選列：固定在內容區頂端 */
.fb{position:sticky;top:0;z-index:4;background:var(--bg);display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px 0;border-bottom:1px solid var(--line)}
.fb input[type=search]{flex:0 1 220px;min-width:0;font:inherit;font-size:13px;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);text-transform:uppercase}
.fb input[type=search]::placeholder{text-transform:none}
.fc{display:flex;align-items:center;gap:6px;flex:1 1 auto;flex-wrap:wrap}
.fb select{font:inherit;font-size:13px;padding:5px 6px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg)}
.fb select.on{border-color:var(--acc);color:var(--acc)}
.tg{font:inherit;font-size:13px;padding:5px 10px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--mut);cursor:pointer;white-space:nowrap}
.tg.on{background:var(--chip);color:var(--acc);border-color:var(--acc)}
.cnt{margin-left:auto;font-size:12px;color:var(--mut);white-space:nowrap}
.lnk{font:inherit;font-size:12px;background:none;border:0;color:var(--acc);cursor:pointer;padding:4px;white-space:nowrap}
.so{display:none;gap:4px}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;flex:none}
.seg button{font:inherit;font-size:13px;padding:5px 10px;border:0;background:var(--card);color:var(--mut);cursor:pointer;white-space:nowrap}.seg button.on{background:var(--chip);color:var(--acc)}
@media(max-width:900px){.fb input[type=search]{flex:1 1 100%}.fc{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none}.fc::-webkit-scrollbar{display:none}.fc>*{flex:none}.so{display:inline-flex}}
/* 表格（電腦）；手機寬度自動變成兩三行的精簡列 */
.t{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.t th{position:sticky;top:0;z-index:2;background:var(--bg);font-size:12px;font-weight:500;color:var(--mut);text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
.t th.s{cursor:pointer;user-select:none}.t th.s:hover{color:var(--fg)}.t th.on{color:var(--acc)}
.t td{padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap;font-size:13px;vertical-align:top}
.t .n{text-align:right}
.t tbody tr:hover td{background:var(--hov)}
.t td.c0{white-space:normal;min-width:150px}.t td.wrap{white-space:normal;color:var(--mut);font-size:12px}
.t tr.hs td{border-bottom:0}.t tr.subr td{padding-top:0}.t tr.subr .warn{margin-top:0}
.c0w{display:flex;flex-wrap:wrap;align-items:center;gap:3px 6px}
@media(max-width:900px){.t thead{display:none}.t,.t tbody{display:block}
  .t tr{display:flex;flex-wrap:wrap;gap:2px 12px;padding:8px 0;border-bottom:1px solid var(--line)}
  .t td{padding:0;border:0;text-align:left!important}.t td.c0{flex-basis:100%}
  .t td[data-l]:before{content:attr(data-l);color:var(--mut);font-size:11px;margin-right:4px}
  .t td.mh{display:none}.t tbody tr:hover td{background:none}
  .t tr.hs{border-bottom:0;padding-bottom:2px}.t tr.subr{padding-top:0}.t td.c0{min-width:0}}
h2{font-size:13px;color:var(--mut);margin:14px 0 6px;font-weight:600;display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 8px}
h2 small{font-weight:400;font-size:12px}
.meta{font-size:12px;color:var(--mut);padding:8px 0 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.l1{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.sym{font-weight:700;color:var(--fg);text-decoration:none}.sym:hover{color:var(--acc)}
.badge{font-size:11px;padding:1px 7px;border-radius:999px;background:var(--chip);color:var(--acc);white-space:nowrap}
.badge.bl{color:var(--up)}.badge.bs{color:var(--dn)}
.tag{font-size:11px;padding:0 5px;border-radius:4px;border:1px solid var(--line);color:var(--mut);font-weight:600}
.fl{font-size:10px;padding:0 4px;border-radius:4px;border:1px solid rgba(251,191,36,.35);color:#d6b25e;margin-left:4px;cursor:help;vertical-align:1px;white-space:nowrap}.wtxt{color:#d6b25e}
.cat{font-size:12px;color:var(--mut)}
.kv{display:flex;flex-wrap:wrap;gap:2px 14px;margin-top:4px;font-size:13px;font-variant-numeric:tabular-nums}
.kv span{color:var(--mut);margin-right:4px;font-size:12px}
.sub{font-size:12px;color:var(--mut);margin-top:4px}
.up{color:var(--up)}.dn{color:var(--dn)}.warn{color:var(--warn);font-size:12px;margin-top:3px}
.big{font-weight:700}
.row{display:flex;gap:8px}.row input{flex:1;min-width:0;font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);text-transform:uppercase}
.row input::placeholder{text-transform:none}
.msg{font-size:13px;margin-top:6px;min-height:18px}.msg.err{color:var(--dn)}.msg.ok{color:var(--up)}
.empty{color:var(--mut);text-align:center;padding:16px 0;font-size:13px}
.wl{display:flex;align-items:center;gap:8px;padding:7px 0;border-top:1px solid var(--line)}
.wl .chips{flex:1;display:flex;flex-wrap:wrap;gap:4px}
a{color:var(--acc)}
.ct{font-size:10px;font-weight:600;letter-spacing:.04em;padding:0 6px;border-radius:999px;border:1px solid;line-height:15px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.ct-crypto{color:#c4b5fd;border-color:rgba(196,181,253,.35);background:rgba(196,181,253,.08)}
.ct-stock{color:#5eead4;border-color:rgba(94,234,212,.35);background:rgba(94,234,212,.08)}
.ct-comm{color:#fcd34d;border-color:rgba(252,211,77,.35);background:rgba(252,211,77,.08)}
.sw{font-size:10px;padding:0 5px;border-radius:4px;border:1px dashed #6b7280;color:#c4b5fd;cursor:help;white-space:nowrap;line-height:15px}.sw.v{border-style:solid;border-color:#a78bfa;font-weight:700}
#swpop{position:fixed;left:12px;right:12px;bottom:max(12px,env(safe-area-inset-bottom));z-index:9;background:var(--card);border:1px solid #a78bfa;border-radius:10px;padding:10px 12px;font-size:13px;white-space:pre-line;box-shadow:0 6px 24px rgba(0,0,0,.5);max-height:50vh;overflow:auto}
.age{font-size:10px;color:var(--mut);border:1px solid var(--line);border-radius:4px;padding:0 4px;margin-left:4px;vertical-align:1px}
.qt{font-size:11px;font-weight:700;padding:1px 7px;border-radius:999px;color:#0f1115;background:#f9a8d4;margin-left:2px}
.rs.q{background:#f9a8d4;color:#0f1115}
.mk{display:flex;flex-wrap:wrap;align-items:center;gap:2px 10px;padding:5px 0;border-bottom:1px solid var(--line);font-size:13px}.mk:last-of-type{border-bottom:0}
.rs{font-size:11px;font-weight:700;padding:1px 7px;border-radius:4px;background:var(--chip);color:var(--acc)}.rs.bad{background:var(--dn);color:#fff}.rs.good{background:var(--up);color:#0f1115}.rs.w{background:transparent;color:var(--mut);border:1px solid var(--line);font-weight:600}
.ov{padding:6px 0;border-top:1px solid var(--line)}.ov:first-child{border-top:0}.chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:3px}
.st{display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px;padding:3px 0;font-size:13px}.dot{width:8px;height:8px;border-radius:50%;display:inline-block}.dot.good{background:var(--up)}.dot.bad{background:var(--dn)}
.alert{margin-top:10px;border-color:var(--warn);color:var(--warn);font-size:13px}
/* 總覽、自選：電腦上分兩欄 */
.home,.wg{display:grid;gap:0 20px}
.home>.vs>.pnl:first-child>h2,.wg>.vs>.pnl:first-child>h2{margin-top:10px}
/* 多模組重疊：只顯示約 5 檔的高度，其餘在區塊內捲動（電腦、手機都一樣） */
.ovp>.pnl-b{max-height:290px;overflow-y:auto;overscroll-behavior:contain}
/* ＋（加入自選）與「自選」標籤同寬，代號才對得齊；底部提示列 */
.wa{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;padding:0;margin:0;flex:none;box-sizing:border-box;font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;border-radius:3px;border:1px solid var(--line);background:transparent;color:var(--mut);cursor:pointer}
.wa:hover{color:var(--acc);border-color:var(--acc)}.wa:disabled{cursor:wait;opacity:.7}
.star{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;font-size:13px;line-height:1;color:#d6b25e}
@media(max-width:900px){.wa,.star{width:20px;height:20px;font-size:13px}.star{font-size:15px}}
#toast{position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:50;display:none;align-items:center;flex-wrap:wrap;gap:8px;max-width:calc(100% - 24px);background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 12px;font-size:13px;box-shadow:0 6px 24px rgba(0,0,0,.5)}
#toast.on{display:flex}#toast.ok{color:var(--up)}#toast.err{color:var(--dn);border-color:var(--dn)}
#toast input{font:inherit;font-size:13px;padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);width:160px}
.gh{font-size:13px;font-weight:600;margin:12px 0 2px;color:var(--fg)}.gh:first-child{margin-top:2px}.gh small{font-weight:400;color:var(--mut);font-size:12px}
@media(max-width:1099px){.home>.todo{order:-1}}
@media(min-width:1100px){.home{grid-template-columns:420px minmax(0,1fr)}.wg{grid-template-columns:380px minmax(0,1fr)}}
.items{display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}
.it{padding:8px 10px}
</style></head><body>
<header><div class="hd"><h1>signmonitor</h1>
<nav id="tabs"><button data-t="home">總覽</button><button data-t="hourly">盤中爆量</button><button data-t="short">短線</button><button data-t="layout">布局</button><button data-t="cross">金叉</button><button data-t="watch">自選</button></nav>
<span class="upd" id="upd"></span><button class="btn" id="reload">重新整理</button></div></header>
<main id="main"><div class="empty">讀取中…</div></main>
<script>
var D=null,TAB='home',PW='',CNT=null;
try{PW=localStorage.getItem('sm_pw')||''}catch(e){}
try{var _t=localStorage.getItem('sm_tab');if(/^(home|hourly|short|layout|cross|watch)$/.test(_t||''))TAB=_t}catch(e){}
function lsg(k,d){try{var v=localStorage.getItem(k);return v?JSON.parse(v):d}catch(e){return d}}
function lss(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}
/* 篩選與排序：預設值；使用者改過的存在瀏覽器，重新整理後保留（搜尋字不保留） */
var FD={hourly:{q:'',cat:'all',ven:'all',win:'72',minx:'0',watch:0,single:0,quiet:0},short:{q:'',side:'all',cat:'all',ven:'all',sw:'0',watch:0,quiet:0,pane:'open'},layout:{q:'',cat:'all',ven:'all',sw:'0',watch:0,single:0,quiet:0},cross:{q:'',cat:'all',watch:0}};
var SD={hourly:{k:'t',d:-1},open:{k:'trigT',d:-1},pend:{k:'near',d:1},layout:{k:'day',d:-1},crossA:{k:'t',d:-1},crossB:{k:'t',d:-1},wh:{k:'t',d:-1},tq:{k:'t',d:-1},to:{k:'why',d:1},tx:{k:'over',d:1},tc:{k:'t',d:-1},th:{k:'x',d:-1},tl:{k:'aft',d:-1},ws:{k:'t',d:-1},shC:{k:'exitT',d:-1},crC:{k:'t',d:-1}};
function merge(def,sv){var o={};Object.keys(def).forEach(function(k){var a=def[k],b=(sv||{})[k]||{},x={};Object.keys(a).forEach(function(j){x[j]=(j in b)?b[j]:a[j]});o[k]=x});return o}
var F=merge(FD,lsg('sm_f',{})),S=merge(SD,lsg('sm_s',{}));
Object.keys(F).forEach(function(k){F[k].q=''});
function saveF(){lss('sm_f',F)}function saveS(){lss('sm_s',S)}

var VL={okx:'OKX',bitget:'Bitget',bybit:'Bybit'},TVX={okx:'OKX',bitget:'BITGET',bybit:'BYBIT'},CAT={crypto:'crypto',stock:'stock',comm:'commodity'};
function CT(c){return c&&CAT[c]?'<span class="ct ct-'+c+'">'+CAT[c]+'</span>':''}
/* 量增價平標籤 */
function QT(x){return x&&x.quiet?'<span class="qt" title="爆量但價格還沒大動（門檻 ±'+x.qlim+'%）">量增價平</span>':''}
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
/* 已在自選：顯示「自選」；不在：顯示＋（點一下加入） */
function WA(b){return '<button class="wa" data-wa="'+esc(b)+'" title="加入自選" aria-label="把 '+esc(b)+' 加入自選">+</button>'}
function WT(b){return inWatch(b)?'<span class="star" title="已在自選" aria-label="已在自選">★</span>':WA(b)}
/* ---------- 掃流動性標記（只標記，沒有回測） ---------- */
var SWK={spike:'爆量日',pd:'前日',swing:'波段'},SWX=1.5;
function swOf(b){return D&&D.sweep?D.sweep.events.filter(function(e){return e.base===b}):[]}
function swV(e){return e.volx!=null&&e.volx>=SWX}
function swLabel(e){var hl=e.side==='up'?'高':'低';return (e.side==='up'?'掃上':'掃下')+'・'+e.lv.map(function(x){return SWK[x.k]+hl}).join('＋')+(swV(e)?'・有量':'')+(e.wk?'・週末':'')}
function swDetail(e){var hl=e.side==='up'?'高':'低',far=Math.max.apply(null,e.lv.map(function(x){return Math.abs(e.x/x.p-1)*100}));
  return tpe(e.t)+' 那根 4H：'+(e.side==='up'?'最高 ':'最低 ')+fp(e.x)+'，越過 '+e.lv.map(function(x){return SWK[x.k]+hl+' '+fp(x.p)}).join('、')+'（最多 '+far.toFixed(2)+'%），收盤 '+fp(e.c)+' 收回；量 '+(e.volx==null?'—':e.volx+'x')+(swV(e)?'（有量）':'（無量）')+(e.wk?'；現貨休市時段':'')}
/* 0＝72 小時內沒有、1＝有、2＝有「有量」的 */
function swLvl(b){var l=swOf(b);return !l.length?0:l.some(swV)?2:1}
/* 代號旁顯示一筆：有「有量」的就取最近一筆有量的，否則取最近一筆；其他筆數用 +N，滑鼠停上去看全部 */
function SWT(b){var l=swOf(b);if(!l.length)return '';var e=l.filter(swV)[0]||l[0];
  return '<span class="sw'+(swV(e)?' v':'')+'" title="'+esc('掃流動性（最近 72 小時，'+l.length+' 筆；僅供參考，沒有回測）\\n'+l.map(swDetail).join('\\n'))+'">'+esc(swLabel(e))+(l.length>1?' +'+(l.length-1):'')+'</span>'}

/* ---------- 即時價格 ---------- */
/* 價格：OKX、Bybit 是開網頁時的即時價；Binance、Bitget 用 GitHub 每小時快照（標「1h」） */
function LP(v,id){var L=D&&D.live&&D.live.px,S2=D&&D.snap&&D.snap.px;var x=(L&&L[v]&&L[v][id])||(S2&&S2[v]&&S2[v][id]);return x&&isFinite(x)?x:null}
function isSnap(v){return v==='bitget'||v==='binance'}
function FP(v,px){return px==null?'—':fp(px)+(isSnap(v)?'<span class="age">1h</span>':'')}
function lvLayout(it){var sy=it.syms||{};return ['okx','bitget','bybit'].filter(function(k){return sy[k]})[0]||null}
function lpLayout(it){var sy=it.syms||{},v=lvLayout(it);return v?LP(v,sy[v]):null}
function rNow(p,px){if(px==null)return null;var risk=Math.abs(p.entry-p.stop);if(!risk)return null;return (p.side==='long'?px-p.entry:p.entry-px)/risk}
function toStop(p,px){if(px==null)return null;return (p.side==='long'?(px-p.stop)/px:(p.stop-px)/px)*100}
function rr(v){if(v==null)return '—';return '<span class="'+(v>=0?'up':'dn')+'">'+(v>=0?'+':'')+v.toFixed(2)+'R</span>'}
function ago(ms){var m=Math.round((Date.now()-ms)/6e4);return m<60?m+' 分鐘前':m<1440?Math.round(m/60)+' 小時前':Math.round(m/1440)+' 天前'}
var H8=8*3600e3;

/* ---------- 共用表格：點欄位標題排序 ---------- */
function th(id,c){var st=S[id],on=st&&st.k===c.k&&c.s;return '<th class="'+(c.n?'n ':'')+(c.s?'s':'')+(on?' on':'')+'"'+(c.s?' data-tb="'+id+'" data-sk="'+c.k+'" title="點一下排序"':'')+'>'+c.l+(on?(st.d>0?' ▴':' ▾'):'')+'</th>'}
function sortRows(id,rows,cols){var st=S[id];if(!st)return rows;var c=cols.filter(function(x){return x.k===st.k&&x.s})[0];if(!c)return rows;
  return rows.map(function(r,i){return {r:r,v:c.s(r),i:i}}).sort(function(a,b){if(a.v==null&&b.v==null)return a.i-b.i;if(a.v==null)return 1;if(b.v==null)return -1;var x=a.v<b.v?-1:a.v>b.v?1:0;return x?x*st.d:a.i-b.i}).map(function(o){return o.r})}
/* sub：每列下方可加一整行附註（例如短線持倉的警示），不擠在代號欄裡 */
function table(id,rows,cols,empty,sub){
  if(!rows.length)return '<div class="empty">'+(empty||'沒有符合的項目')+'</div>';
  rows=sortRows(id,rows,cols);
  return '<table class="t"><thead><tr>'+cols.map(function(c){return th(id,c)}).join('')+'</tr></thead><tbody>'+rows.map(function(r){
    var x=sub?sub(r):'';
    return '<tr'+(x?' class="hs"':'')+'>'+cols.map(function(c,i){return '<td class="'+(i?'':'c0 ')+(c.n?'n ':'')+(c.m?'mh ':'')+(c.w?'wrap':'')+'"'+(i?' data-l="'+(c.ml||c.l)+'"':'')+(c.tt?' title="'+esc(c.tt(r))+'"':'')+'>'+c.v(r)+'</td>'}).join('')+'</tr>'+
      (x?'<tr class="subr"><td colspan="'+cols.length+'">'+x+'</td></tr>':'')}).join('')+'</tbody></table>'}
/* 持倉提醒：停損過寬標在停損欄、遠離觸發價標在現價欄；完整句子滑鼠停上去看。其他種類的提醒標在代號旁 */
function flagOf(p,key){return (p.flags||[]).filter(function(f){return f.indexOf(key)>=0})[0]||null}
function flTag(f,txt){return f?'<span class="fl" title="'+esc(f)+'">'+txt+'</span>':''}
function stopCell(p){var f=flagOf(p,'停損距離');return fp(p.stop)+' <span class="'+(f?'wtxt':'cat')+'">'+(p.riskPct||0).toFixed(1)+'%</span>'+flTag(f,'過寬')}
function pxCell(p,px){return FP(p.ex,px)+flTag(flagOf(p,'遠離'),'遠離')}
function otherFlags(p){return (p.flags||[]).filter(function(f){return f.indexOf('停損距離')<0&&f.indexOf('遠離')<0}).map(function(f){return flTag(f,'提醒')}).join('')}
/* 總覽各組的欄位不在 COLS 裡，記在 TCOLS */
var TCOLS={};
function colOf(t,k){var cs=COLS[t]?COLS[t]():(TCOLS[t]||[]);return cs.filter(function(c){return c.k===k})[0]}

/* ---------- 各表格的欄位 ---------- */
function kindH(a){if(a.single)return '只有 '+VL[a.venue];if(a.spikedOthers&&a.spikedOthers.length)return [a.venue].concat(a.spikedOthers).map(function(v){return VL[v]}).join('＋')+' 同時';return VL[a.venue]}
function kindL(it){if(it.single)return '只有 '+VL[it.spiked[0]];if(it.spiked.length>1)return it.spiked.map(function(v){return VL[v]}).join('＋')+' 同時';return VL[it.spiked[0]]}
function lLink(it){var sy=it.syms||{},v=(it.spiked||[]).filter(function(x){return sy[x]})[0]||(sy[it.ref]?it.ref:Object.keys(sy).filter(function(x){return sy[x]})[0]);return link(it.base,v?tv(v,sy[v],'D'):null)}
function bn(sym){return 'https://www.tradingview.com/chart/?symbol='+encodeURIComponent('BINANCE:'+sym)+'&interval=240'}
function stk(x){return CT(x.stock?'stock':'crypto')}
function normBase(b,stock){b=String(b||'').toUpperCase();return stock&&/B$/.test(b)?b.slice(0,-1):b}
function hW(a){return a.watch||inWatch(a.base)}
function lRet(it){var px=lpLayout(it);return px?px/it.entry-1:it.ret}
/* 等待觸發的多空：每檔都同時有做多、做空兩個觸發價。選「做多」＝當做多候選看：排除已跌破做空價的，距觸發只算到做多價 */
function pendOk(c,sd){if(sd==='all')return true;var px=LP(c.ex,c.id);if(px==null)return true;return sd==='long'?!(px<c.lo):!(px>c.hi)}
function nearOf(c){var px=LP(c.ex,c.id),sd=F.short.side;if(px==null)return null;
  if(sd==='long')return px>c.hi?0:(c.hi/px-1)*100;if(sd==='short')return px<c.lo?0:(1-c.lo/px)*100;
  if(px>c.hi||px<c.lo)return 0;return Math.min((c.hi/px-1)*100,(1-c.lo/px)*100)}
var COLS={
  hourly:function(){return [
    {k:'base',l:'代號',dd:1,s:function(a){return a.base},v:function(a){return '<div class="c0w">'+link(a.base,tv(a.venue,a.sym,'60'))+CT(a.cat)+(hW(a)?'<span class="star" title="已在自選" aria-label="已在自選">★</span>':WA(a.base))+QT(a)+'</div>'}},
    {k:'t',l:'時間',s:function(a){return a.t},v:function(a){return tpe(a.t)}},
    {k:'x1',l:'同時段',n:1,s:function(a){return a.x1},v:function(a){return '<b>'+a.x1+'x</b>'}},
    {k:'x2',l:'近48h',n:1,s:function(a){return a.x2},v:function(a){return a.x2+'x'}},
    {k:'chg',l:'1H',n:1,s:function(a){return a.chg},v:function(a){return pc100(a.chg)}},
    {k:'qv',l:'成交額',n:1,s:function(a){return a.qv},v:function(a){return money(a.qv)}},
    {k:'price',l:'爆量收',n:1,m:1,v:function(a){return fp(a.price)}},
    {k:'px',l:'現價',n:1,v:function(a){return FP(a.venue,LP(a.venue,a.sym))}},
    {k:'aft',l:'之後',n:1,s:function(a){var p=LP(a.venue,a.sym);return p&&a.price?p/a.price-1:null},v:function(a){var p=LP(a.venue,a.sym);return p&&a.price?pc(p/a.price-1):'—'}},
    {k:'ven',l:'交易所',dd:1,s:function(a){return a.venue},v:function(a){return '<span class="badge">'+kindH(a)+'</span>'},
      tt:function(a){return Object.keys(a.others||{}).map(function(v){return VL[v]+' '+a.others[v]+'x'}).join('｜')||'其他家無此合約或資料不足'}}]},
  open:function(){return [
    {k:'base',l:'代號',dd:1,s:function(p){return p.base},v:function(p){return '<div class="c0w">'+link(p.base,tv(p.ex,p.id,'240'))+CT(p.cat)+WT(p.base)+'<span class="badge '+(p.side==='long'?'bl':'bs')+'">'+SIDE[p.side]+'</span>'+(p.t1Hit?'<span class="badge">T1 ✓</span>':'')+otherFlags(p)+SWT(p.base)+'</div>'}},
    {k:'px',l:'現價',n:1,v:function(p){return pxCell(p,LP(p.ex,p.id))}},
    {k:'r',l:'目前',n:1,s:function(p){return rNow(p,LP(p.ex,p.id))},v:function(p){return '<b>'+rr(rNow(p,LP(p.ex,p.id)))+'</b>'}},
    {k:'toStop',l:'距停損',n:1,dd:1,s:function(p){return toStop(p,LP(p.ex,p.id))},v:function(p){var d=toStop(p,LP(p.ex,p.id));return d==null?'—':'<span class="'+(d<2?'dn big':'')+'">'+d.toFixed(1)+'%</span>'}},
    {k:'entry',l:'進場',n:1,v:function(p){return fp(p.entry)}},
    {k:'stop',l:'停損',n:1,v:stopCell},
    {k:'t12',l:'T1／T2',n:1,v:function(p){return fp(p.t1)+'／'+fp(p.t2)}},
    {k:'mfe',l:'最大有利',n:1,m:1,s:function(p){return p.mfeR||0},v:function(p){return '+'+(p.mfeR||0).toFixed(1)+'R'}},
    {k:'trigT',l:'觸發',s:function(p){return p.trigT},v:function(p){return tpe(p.trigT)}}]},
  pend:function(){return [
    {k:'base',l:'代號',dd:1,s:function(c){return c.base},v:function(c){return '<div class="c0w">'+link(c.base,tv(c.ex,c.id,'240'))+CT(c.cat)+WT(c.base)+QT(c)+'<span class="cat">'+(PAT[c.pattern]||'')+'</span>'+SWT(c.base)+'</div>'}},
    {k:'vx',l:'爆量',n:1,s:function(c){return c.vx},v:function(c){return '<b>'+c.vx+'x</b>'}},
    {k:'dayT',l:'爆量日',s:function(c){return c.dayT},v:function(c){return md(c.dayT)+' '+pc100(c.chgDay)}},
    {k:'close',l:'日收',n:1,m:1,v:function(c){return fp(c.close)}},
    {k:'hi',l:'做多 4H收＞',ml:'做多＞',n:1,v:function(c){return fp(c.hi)}},
    {k:'lo',l:'做空 4H收＜',ml:'做空＜',n:1,v:function(c){return fp(c.lo)}},
    {k:'px',l:'現價',n:1,v:function(c){return FP(c.ex,LP(c.ex,c.id))}},
    {k:'near',l:'距觸發',dd:1,s:nearOf,v:function(c){var px=LP(c.ex,c.id);if(px==null)return '—';
      if(px>c.hi)return '<b class="up">已越過做多價</b>';if(px<c.lo)return '<b class="dn">已跌破做空價</b>';
      var a=(c.hi/px-1)*100,b=(1-c.lo/px)*100,sd=F.short.side;
      if(sd==='long')return '<b>多 '+a.toFixed(1)+'%</b>';if(sd==='short')return '<b>空 '+b.toFixed(1)+'%</b>';
      return '<span class="'+(a<=b?'big':'cat')+'">多 '+a.toFixed(1)+'%</span>　<span class="'+(b<a?'big':'cat')+'">空 '+b.toFixed(1)+'%</span>'}}]},
  layout:function(){return [
    {k:'base',l:'代號',dd:1,s:function(it){return it.base},v:function(it){return '<div class="c0w">'+lLink(it)+CT(it.cat)+WT(it.base)+QT(it)+'<span class="badge">'+kindL(it)+'</span>'+(it.respikes?'<span class="cat">再爆量 '+it.respikes+'</span>':'')+SWT(it.base)+'</div>'}},
    {k:'day',l:'爆量日',s:function(it){return it.day},v:function(it){return it.day.slice(5)}},
    {k:'age',l:'天數',n:1,s:function(it){return it.age||0},v:function(it){return it.age||0}},
    {k:'entry',l:'爆量日收',n:1,v:function(it){return fp(it.entry)}},
    {k:'px',l:'現價',n:1,v:function(it){var px=lpLayout(it);return px?FP(lvLayout(it),px):'—'}},
    {k:'ret',l:'報酬',n:1,s:lRet,v:function(it){var px=lpLayout(it);return '<b>'+pc(lRet(it))+'</b>'+(px?'':'<span class="age">日收</span>')}},
    {k:'ex',l:'相對大盤',n:1,s:function(it){return it.ex},v:function(it){return pc(it.ex)}},
    {k:'mfe',l:'最大漲',n:1,s:function(it){return it.mfe},v:function(it){return pc(it.mfe)}},
    {k:'mae',l:'最大回撤',n:1,dd:1,s:function(it){return it.mae},v:function(it){return pc(it.mae)}},
    {k:'vv',l:'各家倍數',w:1,m:1,v:function(it){return ['okx','bitget','bybit'].map(function(v){var q=it.venues&&it.venues[v];return q?(it.spiked.indexOf(v)>=0?'<b style="color:var(--fg)">'+VL[v]+' '+q.x+'x</b>':VL[v]+' '+q.x+'x'):VL[v]+' —'}).join('｜')}}]},
  crossA:function(){return [
    {k:'base',l:'代號',dd:1,s:function(it){return it.base},v:function(it){return '<div class="c0w">'+link(it.base,bn(it.sym))+stk(it)+WT(normBase(it.base,it.stock))+(it.deadT?'<span class="badge" style="color:var(--dn)">已死叉 '+pc100(it.deadRet)+'</span>':'<span class="badge" style="color:var(--up)">仍成立</span>')+'</div>'}},
    {k:'t',l:'金叉',s:function(it){return it.t},v:function(it){return tpe(it.t)}},
    {k:'close',l:'金叉收',n:1,v:function(it){return fp(it.close)}},
    {k:'px',l:'現價',n:1,v:function(it){return FP('binance',LP('binance',it.sym))}},
    {k:'ret',l:'報酬',n:1,s:function(it){var px=LP('binance',it.sym);return px?(px/it.close-1)*100:it.ret},v:function(it){var px=LP('binance',it.sym);return '<b>'+(px?pc(px/it.close-1):pc100(it.ret))+'</b>'}},
    {k:'mfe',l:'最大漲',n:1,s:function(it){return it.mfe},v:function(it){return pc100(it.mfe)}},
    {k:'mae',l:'最大跌',n:1,dd:1,s:function(it){return it.mae},v:function(it){return pc100(it.mae)}},
    {k:'volx',l:'量',n:1,s:function(it){return it.volx},v:function(it){return it.volx+'x'}},
    {k:'px200',l:'距SMA200',n:1,s:function(it){return it.px200},v:function(it){return pc100(it.px200)}},
    {k:'stop',l:'近6根低',n:1,v:function(it){return fp(it.stopPx)+' <span class="cat">-'+(it.stopPct||0).toFixed(1)+'%</span>'}},
    {k:'bars',l:'根數',n:1,s:function(it){return it.bars||0},v:function(it){return (it.bars||0)+'/42'}}]},
  crossB:function(){return [
    {k:'base',l:'代號',dd:1,s:function(it){return it.base},v:function(it){return '<div class="c0w">'+link(it.base,bn(it.sym))+stk(it)+WT(normBase(it.base,it.stock))+'</div>'}},
    {k:'t',l:'金叉',s:function(it){return it.t},v:function(it){return tpe(it.t)}},
    {k:'close',l:'收',n:1,v:function(it){return fp(it.close)}},
    {k:'volx',l:'量',n:1,s:function(it){return it.volx},v:function(it){return it.volx==null?'—':it.volx+'x'}},
    {k:'px200',l:'距SMA200',n:1,s:function(it){return it.px200},v:function(it){return pc100(it.px200)}},
    {k:'why',l:'未達 A 級原因',w:1,v:function(it){return esc((it.reasons||[]).join('、'))}}]},
  shC:function(){return [
    {k:'base',l:'代號',dd:1,s:function(p){return p.base},v:function(p){return '<div class="c0w">'+link(p.base,tv(p.ex,p.id,'240'))+CT(p.cat)+WT(p.base)+'<span class="badge '+(p.side==='long'?'bl':'bs')+'">'+SIDE[p.side]+'</span></div>'}},
    {k:'r',l:'結果',n:1,s:function(p){return p.r},v:function(p){return '<b>'+rr(p.r)+'</b>'}},
    {k:'out',l:'出場',v:function(p){return OUT[p.outcome]||''}},
    {k:'px',l:'進場 → 出場',n:1,v:function(p){return fp(p.entry)+' → '+fp(p.exit)}},
    {k:'exitT',l:'出場時間',s:function(p){return p.exitT},v:function(p){return tpe(p.exitT)}}]},
  crC:function(){return [
    {k:'base',l:'代號',dd:1,s:function(p){return p.base},v:function(p){return '<div class="c0w">'+link(p.base,bn(p.sym))+stk(p)+WT(normBase(p.base,p.stock))+'</div>'}},
    {k:'ret',l:'結果',n:1,s:function(p){return p.exitRet},v:function(p){return '<b>'+pc100(p.exitRet)+'</b>'}},
    {k:'out',l:'出場',v:function(p){return p.deadT?'死叉出場':'滿 42 根'}},
    {k:'t',l:'金叉',s:function(p){return p.t},v:function(p){return tpe(p.t)}},
    {k:'mfe',l:'最大漲',n:1,s:function(p){return p.mfe},v:function(p){return pc100(p.mfe)}},
    {k:'mae',l:'最大跌',n:1,s:function(p){return p.mae},v:function(p){return pc100(p.mae)}}]}
};
COLS.wh=COLS.hourly;
COLS.ws=function(){return [
  {k:'base',l:'代號',dd:1,s:function(e){return e.base},v:function(e){return '<div class="c0w">'+link(e.base,tv(e.ex,e.id,'240'))+CT(e.cat)+'</div>'}},
  {k:'t',l:'4H K',s:function(e){return e.t},v:function(e){return tpe(e.t)}},
  {k:'side',l:'標記',w:1,v:function(e){return '<span class="sw'+(swV(e)?' v':'')+'" title="'+esc(swDetail(e))+'">'+esc(swLabel(e))+'</span>'}},
  {k:'lv',l:'價位',n:1,v:function(e){return e.lv.map(function(x){return fp(x.p)}).join('／')}},
  {k:'x',l:'極值',n:1,m:1,v:function(e){return fp(e.x)}},
  {k:'c',l:'收盤',n:1,v:function(e){return fp(e.c)}},
  {k:'volx',l:'量',n:1,s:function(e){return e.volx},v:function(e){return e.volx==null?'—':e.volx+'x'}}]};
function swMeta(){var w=D.sweep;return w?'掃流動性標記：最近 72 小時'+(w.lastBar?'（最近檢查 '+tpe(w.lastBar)+' 那根 4H K）':'')+'，虛線＝無量、實線＝有量，滑鼠停上去（手機點一下）看細節；沒有回測，僅供參考。':'掃流動性標記：下一根 4H K 收盤後開始。'}

/* ---------- 篩選列 ---------- */
var CATS=[['all','全部類別'],['crypto','crypto'],['stock','stock'],['comm','commodity']],VENS=[['all','全部交易所'],['okx','OKX'],['bitget','Bitget'],['bybit','Bybit']];
function pass(f,o){
  if(f.q&&String(o.base||'').toUpperCase().indexOf(f.q.toUpperCase())<0)return false;
  if(f.cat&&f.cat!=='all'&&o.cat!==f.cat)return false;
  if(f.ven&&f.ven!=='all'&&(o.vens||[]).indexOf(f.ven)<0)return false;
  if(f.watch&&!o.watch)return false;
  if(f.sw&&+f.sw>0&&o.sw!=null&&o.sw<+f.sw)return false;
  if(f.single&&!o.single)return false;
  if(f.quiet&&!o.quiet)return false;return true}
function sel(k,opts){var v=String(F[TAB][k]);return '<select data-f="'+k+'" class="'+(v!==String(FD[TAB][k])?'on':'')+'">'+opts.map(function(o){return '<option value="'+o[0]+'"'+(String(o[0])===v?' selected':'')+'>'+o[1]+'</option>'}).join('')+'</select>'}
function tg(k,l){return '<button class="tg'+(F[TAB][k]?' on':'')+'" data-t="'+k+'">'+l+'</button>'}
function sortTarget(){return TAB==='short'?({pend:'pend',closed:'shC'}[F.short.pane]||'open'):TAB==='cross'?'crossA':TAB}
/* 區塊：標題固定，內容在區塊裡捲動（電腦） */
function panel(title,body,cls){return '<section class="pnl '+(cls||'')+'">'+(title?'<h2>'+title+'</h2>':'')+'<div class="pnl-b">'+body+'</div></section>'}
function fbar(){
  var f=F[TAB];if(!f)return '';
  var h='<input id="q" type="search" placeholder="搜尋代號（按 / 跳到這裡）" value="'+esc(f.q)+'" autocomplete="off" autocapitalize="characters" spellcheck="false"><div class="fc">';
  if(TAB==='short'&&D.short){h+='<span class="seg">'+[['open','持倉 '+D.short.open.length],['pend','等待觸發 '+D.short.pending.length],['closed','成績 '+(D.short.closed||[]).length]].map(function(o){return '<button data-pane="'+o[0]+'" class="'+(f.pane===o[0]?'on':'')+'">'+o[1]+'</button>'}).join('')+'</span>';
    h+=sel('side',[['all','多空都看'],['long','只看做多'],['short','只看做空']])}
  h+=sel('cat',TAB==='cross'?CATS.slice(0,3):CATS);
  if('ven' in f)h+=sel('ven',VENS);
  if(TAB==='hourly')h+=sel('win',[['72','72 小時'],['24','24 小時'],['6','6 小時']])+sel('minx',[['0','倍數不限'],['5','≥ 5x'],['10','≥ 10x'],['20','≥ 20x'],['50','≥ 50x']]);
  if('sw' in f)h+=sel('sw',[['0','掃單不限'],['1','72h 有掃單'],['2','72h 有量掃單']]);
  h+=tg('watch','只看自選');if('single' in f)h+=tg('single','只有一家爆量');if('quiet' in f)h+=tg('quiet','只看量增價平');
  var t=sortTarget(),cs=COLS[t]().filter(function(c){return c.s});
  h+='<span class="so"><select id="sk">'+cs.map(function(c){return '<option value="'+c.k+'"'+(S[t].k===c.k?' selected':'')+'>排序：'+c.l+'</option>'}).join('')+'</select><button class="tg" id="sd">'+(S[t].d>0?'↑ 小到大':'↓ 大到小')+'</button></span>';
  return h+'<span class="cnt" id="cnt"></span><button class="lnk" id="clr">清除篩選</button></div>'}
function isDef(){var f=F[TAB],d=FD[TAB];return !d||Object.keys(d).every(function(k){return k==='pane'||String(f[k])===String(d[k])})}
function updCnt(){var c=$('cnt');if(c)c.textContent=CNT?(CNT[0]===CNT[1]?'共 '+CNT[1]+' 筆':'符合 '+CNT[0]+'／'+CNT[1]):'';var cl=$('clr');if(cl)cl.style.visibility=isDef()?'hidden':'visible'}
function syncSort(){var sk=$('sk'),sd=$('sd');if(!sk)return;var t=sortTarget();sk.value=S[t].k;sd.textContent=S[t].d>0?'↑ 小到大':'↓ 大到小'}

/* ---------- 總覽 ---------- */
function marketCard(){
  var m=D.market||[];if(!m.length)return '<div class="card sub">大盤資料還沒產生（每個整點更新一次）</div>';
  return '<div class="card">'+m.map(function(t){
    return '<div class="mk"><b class="sym">'+t.base+'</b><span>'+fp(t.price)+'</span><span>24h '+pc(t.chg24)+'</span>'+
    '<span class="badge" style="color:var('+(t.up?'--up':'--dn')+')">4H '+(t.up?'金叉中':'死叉中')+(t.since?'（自 '+tpe(t.since)+'）':'')+'</span>'+
    '<span>距 SMA200 '+pc(t.px200)+'</span></div>'}).join('')+
    '<div class="sub">4H EMA20／SMA30，每小時更新'+(D.snap?'（'+tpe(D.snap.t)+'）':'')+'。價格在 SMA200 下方時，金叉類做多訊號的回測表現偏弱。</div></div>'}
function item(reason,cls,name,url,extra,tags,notes){
  return '<div class="card it"><div class="l1"><span class="rs '+cls+'">'+reason+'</span>'+link(name,url)+(tags||'')+'</div>'+(extra?'<div class="kv">'+extra+'</div>':'')+
    (notes||[]).map(function(f){return '<div class="warn">'+esc(f)+'</div>'}).join('')+'</div>'}
function layoutUrl(it){var sy=it.syms||{},v=['okx','bitget','bybit'].filter(function(k){return sy[k]})[0];return v?tv(v,sy[v],'D'):null}
function kvs(o){return o.map(function(x){return '<div><span>'+x[0]+'</span>'+x[1]+'</div>'}).join('')}
/* 需要處理：依類型分組，每組一張表、各自的欄位；沒有項目的組不顯示 */
function tdName(o){return '<div class="c0w">'+link(o.base,o.url)+(o.ct||'')+(o.w?'<span class="star" title="已在自選" aria-label="已在自選">★</span>':WA(o.wb||o.base))+(o.tags||'')+'</div>'}
var TC0={k:'base',l:'代號',dd:1,s:function(o){return o.base},v:tdName};
function sideB(s){return '<span class="badge '+(s==='long'?'bl':'bs')+'">'+SIDE[s]+'</span>'}
function aft(o){return o.px&&o.ref?o.px/o.ref-1:null}
var WHY={'接近停損':0,'接近 T2':1,'接近 T1':2,'新觸發':3};
function todoGroups(){
  var now=Date.now(),G=[],sh=D.short,lay=D.layout,cr=D.cross,hr=D.hourly;
  /* 量增價平：盤中 6 小時內（同一檔取倍數最高）、每日爆量取最新一天 */
  var q=[];
  if(hr){var qb={};hr.recent.forEach(function(a){if(a.quiet&&a.t>=now-6*3600e3&&(!qb[a.base]||a.x1>qb[a.base].x1))qb[a.base]=a});
    Object.keys(qb).forEach(function(k){var a=qb[k];q.push({base:a.base,url:tv(a.venue,a.sym,'60'),ct:CT(a.cat),tags:'',w:hW(a),src:'盤中・'+VL[a.venue],x:a.x1,t:a.t,tl:tpe(a.t),chg:a.chg,qlim:a.qlim,ref:a.price,ven:a.venue,px:LP(a.venue,a.sym)})})}
  if(sh&&sh.pending.length){var ld=Math.max.apply(null,sh.pending.map(function(c){return c.dayT}));
    sh.pending.filter(function(c){return c.quiet&&c.dayT===ld}).forEach(function(c){q.push({base:c.base,url:tv(c.ex,c.id,'240'),ct:CT(c.cat),tags:'',w:inWatch(c.base),src:'每日・短線',x:c.vx,t:c.dayT,tl:md(c.dayT),chg:c.chgDay,qlim:c.qlim,ref:c.close,ven:c.ex,px:LP(c.ex,c.id)})})}
  if(lay&&lay.lastDay)lay.active.filter(function(it){return it.quiet&&it.day===lay.lastDay}).forEach(function(it){
    q.push({base:it.base,url:layoutUrl(it),ct:CT(it.cat),tags:'',w:inWatch(it.base),src:'每日・布局',x:null,t:it.dayT,tl:it.day.slice(5),chg:it.chgDay,qlim:it.qlim,ref:it.entry,ven:lvLayout(it),px:lpLayout(it)})});
  G.push({id:'tq',title:'量增價平',note:'爆量但價格還沒大動；盤中取 6 小時內、每日取最新一天',rows:q,cols:[TC0,
    {k:'src',l:'來源',v:function(o){return o.src}},
    {k:'x',l:'倍數',n:1,s:function(o){return o.x},v:function(o){return o.x==null?'—':'<b>'+o.x+'x</b>'}},
    {k:'t',l:'時間',s:function(o){return o.t},v:function(o){return o.tl}},
    {k:'chg',l:'當時漲跌',n:1,v:function(o){return pc100(o.chg)+' <span class="cat">門檻 ±'+o.qlim+'%</span>'}},
    {k:'ref',l:'爆量收',n:1,v:function(o){return fp(o.ref)}},
    {k:'px',l:'現價',n:1,v:function(o){return o.px?FP(o.ven,o.px):'—'}},
    {k:'aft',l:'之後',n:1,s:aft,v:function(o){return pc(aft(o))}}]});
  /* 短線持倉：接近停損／T1／T2、8 小時內新觸發 */
  var op=[],xs=[];
  if(sh){
    sh.open.forEach(function(p){
      var px=LP(p.ex,p.id),r=rNow(p,px),why=null,cls='w';
      if(r!=null&&r<=-0.7){why='接近停損';cls='bad'}else if(r!=null&&r>=2.7){why='接近 T2';cls='good'}else if(r!=null&&r>=1.7&&!p.t1Hit){why='接近 T1';cls='good'}
      else if(p.trigT>=now-H8){why='新觸發'}
      if(why)op.push({base:p.base,url:tv(p.ex,p.id,'240'),ct:CT(p.cat),tags:sideB(p.side)+otherFlags(p),w:inWatch(p.base),p:p,px:px,r:r,why:why,cls:cls})});
    sh.pending.forEach(function(c){
      var px=LP(c.ex,c.id);if(px==null)return;
      var side=px>c.hi?'long':px<c.lo?'short':null;if(!side)return;
      var tg=side==='long'?c.hi:c.lo;
      xs.push({base:c.base,url:tv(c.ex,c.id,'240'),ct:CT(c.cat),tags:sideB(side),w:inWatch(c.base),c:c,px:px,tg:tg,over:Math.abs(px/tg-1)})})}
  G.push({id:'to',title:'短線持倉',rows:op,cols:[TC0,
    {k:'why',l:'原因',dd:1,s:function(o){return WHY[o.why]},v:function(o){return '<span class="rs '+o.cls+'">'+o.why+'</span>'}},
    {k:'px',l:'現價',n:1,v:function(o){return pxCell(o.p,o.px)}},
    {k:'r',l:'目前',n:1,s:function(o){return o.r},v:function(o){return '<b>'+rr(o.r)+'</b>'}},
    {k:'toStop',l:'距停損',n:1,dd:1,s:function(o){return toStop(o.p,o.px)},v:function(o){var d=toStop(o.p,o.px);return d==null?'—':'<span class="'+(d<2?'dn big':'')+'">'+d.toFixed(1)+'%</span>'}},
    {k:'stop',l:'停損',n:1,v:function(o){return stopCell(o.p)}},
    {k:'t12',l:'T1／T2',n:1,v:function(o){return fp(o.p.t1)+'／'+fp(o.p.t2)}}]});
  G.push({id:'tx',title:'越過觸發價',note:'短線等待清單；要等 4H 收盤確認才算進場',rows:xs,cols:[TC0,
    {k:'px',l:'現價',n:1,v:function(o){return FP(o.c.ex,o.px)}},
    {k:'tg',l:'觸發價',n:1,v:function(o){return fp(o.tg)}},
    {k:'over',l:'超出',n:1,s:function(o){return o.over},v:function(o){return (o.over*100).toFixed(1)+'%'}},
    {k:'x',l:'爆量',n:1,s:function(o){return o.c.vx},v:function(o){return o.c.vx+'x'}},
    {k:'day',l:'爆量日',v:function(o){return md(o.c.dayT)}}]});
  /* 金叉：8 小時內新 A 級、8 小時內死叉 */
  var cx=[];
  if(cr)cr.active.forEach(function(it){var px=LP('binance',it.sym),dead=it.deadT&&it.deadT+144e5>=now-H8;
    if(!dead&&!(it.t+144e5>=now-H8))return;
    cx.push({base:it.base,wb:normBase(it.base,it.stock),url:bn(it.sym),ct:stk(it),tags:'',w:inWatch(normBase(it.base,it.stock)),it:it,px:px,dead:dead,ret:dead?it.deadRet:(px?(px/it.close-1)*100:it.ret)})});
  G.push({id:'tc',title:'金叉',rows:cx,cols:[TC0,
    {k:'st',l:'狀態',v:function(o){return o.dead?'<span class="rs bad">已死叉</span>':'<span class="rs good">新 A 級</span>'}},
    {k:'t',l:'金叉',s:function(o){return o.it.t},v:function(o){return tpe(o.it.t)}},
    {k:'close',l:'金叉收',n:1,v:function(o){return fp(o.it.close)}},
    {k:'px',l:'現價',n:1,v:function(o){return FP('binance',o.px)}},
    {k:'ret',l:'報酬',n:1,s:function(o){return o.ret},v:function(o){return pc100(o.ret)+(o.dead?' <span class="cat">死叉出場</span>':'')}},
    {k:'volx',l:'量',n:1,s:function(o){return o.it.volx},v:function(o){return o.it.volx+'x'}},
    {k:'px200',l:'距SMA200',n:1,v:function(o){return pc100(o.it.px200)}},
    {k:'stop',l:'近6根低',n:1,v:function(o){return fp(o.it.stopPx)+' <span class="cat">-'+(o.it.stopPct||0).toFixed(1)+'%</span>'}}]});
  /* 盤中爆量：5 小時內倍數前 5 名，加上所有自選（同一檔多家同時爆量只列倍數最高那家） */
  var hx=[];
  if(hr){var best={};hr.recent.filter(function(a){return a.t>=now-5*3600e3}).forEach(function(a){if(!best[a.base]||a.x1>best[a.base].x1)best[a.base]=a});
    var uniq=Object.keys(best).map(function(k){return best[k]}).sort(function(a,b){return b.x1-a.x1}),top=uniq.slice(0,5);
    uniq.forEach(function(a){if(hW(a)&&top.indexOf(a)<0)top.push(a)});
    top.forEach(function(a){hx.push({base:a.base,url:tv(a.venue,a.sym,'60'),ct:CT(a.cat),tags:'',w:hW(a),a:a,ref:a.price,px:LP(a.venue,a.sym)})})}
  G.push({id:'th',title:'盤中爆量',note:'5 小時內倍數前 5 名＋自選',rows:hx,cols:[TC0,
    {k:'x',l:'倍數',n:1,s:function(o){return o.a.x1},v:function(o){return '<b>'+o.a.x1+'x</b>'}},
    {k:'t',l:'時間',s:function(o){return o.a.t},v:function(o){return tpe(o.a.t)}},
    {k:'ref',l:'爆量收',n:1,v:function(o){return fp(o.ref)}},
    {k:'px',l:'現價',n:1,v:function(o){return FP(o.a.venue,o.px)}},
    {k:'aft',l:'之後',n:1,s:aft,v:function(o){return pc(aft(o))}},
    {k:'ven',l:'交易所',v:function(o){return '<span class="badge">'+kindH(o.a)+'</span>'}}]});
  /* 新進布局：最新一天 */
  var lx=[];
  if(lay&&lay.lastDay)lay.active.filter(function(it){return it.day===lay.lastDay}).forEach(function(it){
    lx.push({base:it.base,url:layoutUrl(it),ct:CT(it.cat),tags:'',w:inWatch(it.base),it:it,ref:it.entry,px:lpLayout(it)})});
  G.push({id:'tl',title:'新進布局',note:lay&&lay.lastDay?'資料日 '+lay.lastDay:'',rows:lx,cols:[TC0,
    {k:'ven',l:'交易所',v:function(o){return '<span class="badge">'+kindL(o.it)+'</span>'}},
    {k:'ref',l:'爆量日收',n:1,v:function(o){return fp(o.ref)}},
    {k:'px',l:'現價',n:1,v:function(o){return o.px?FP(lvLayout(o.it),o.px):'—'}},
    {k:'aft',l:'報酬',n:1,s:aft,v:function(o){return pc(aft(o))}}]});
  G.forEach(function(g){TCOLS[g.id]=g.cols});
  return G.filter(function(g){return g.rows.length})}
function todo(){return [].concat.apply([],todoGroups().map(function(g){return g.rows}))}
function todoTables(){var G=todoGroups();if(!G.length)return '<div class="empty">目前沒有需要處理的項目</div>';
  return G.map(function(g){return '<h3 class="gh">'+g.title+' <small>'+g.rows.length+(g.note?'　'+g.note:'')+'</small></h3>'+table(g.id,g.rows,g.cols)}).join('')}
var MODS=[['hourly','盤中爆量'],['pend','短線等待'],['open','短線持倉'],['layout','布局'],['crossA','金叉 A'],['crossB','金叉 B']];
function overlap(){
  var m={};function add(b,k,txt){if(!b)return;m[b]=m[b]||{};if(!m[b][k])m[b][k]=txt}
  if(D.hourly)D.hourly.recent.forEach(function(a){add(normBase(a.base),'hourly',a.x1+'x '+tpe(a.t))});
  if(D.short){D.short.pending.forEach(function(c){add(normBase(c.base),'pend',c.vx+'x')});
    D.short.open.forEach(function(p){var r=rNow(p,LP(p.ex,p.id));add(normBase(p.base),'open',SIDE[p.side]+(r==null?'':' '+(r>=0?'+':'')+r.toFixed(1)+'R'))})}
  if(D.layout)D.layout.active.forEach(function(it){var px=lpLayout(it);add(normBase(it.base),'layout',px?((px/it.entry-1)*100).toFixed(1)+'%':'日收 '+((it.ret||0)*100).toFixed(1)+'%')});
  if(D.cross){D.cross.active.forEach(function(it){add(normBase(it.base,it.stock),'crossA',it.deadT?'已死叉':'仍成立')});
    D.cross.recentB.forEach(function(it){add(normBase(it.base,it.stock),'crossB',tpe(it.t))})}
  return Object.keys(m).map(function(b){return {b:b,n:Object.keys(m[b]).length,m:m[b]}}).filter(function(x){return x.n>=2})
    .sort(function(a,b){return (b.n-a.n)||(inWatch(b.b)-inWatch(a.b))||a.b.localeCompare(b.b)})}
var MODEXP={'盤中爆量':3,'短線清單':3,'布局清單':30,'金叉清單':6,'掃流動性':6};
function status(){
  var s='<div class="card">';
  Object.keys(MODEXP).forEach(function(t){
    var u=D.updated&&D.updated[t]?Date.parse(D.updated[t]):0,late=!u||Date.now()-u>MODEXP[t]*3600e3,w=(D.warnings&&D.warnings[t])||[];
    s+='<div class="st"><span class="dot '+(late||w.length?'bad':'good')+'"></span><b>'+t.replace('清單','')+'</b><span class="cat">'+(u?tpe(u)+'（'+ago(u)+'）':'尚無資料')+(late&&u?'　超過 '+MODEXP[t]+' 小時沒更新':'')+'</span></div>'+
      w.map(function(x){return '<div class="warn">'+esc(x)+'</div>'}).join('')});
  var R=D.runs;
  if(R&&R.last)s+='<div class="st"><span class="dot '+(R.last.ok?'good':'bad')+'"></span><b>最近一次執行</b><span class="cat">'+(R.last.ok?'成功':'失敗')+'　'+tpe(Date.parse(R.last.at))+(R.running?'　目前有一輪正在跑':'')+(R.recentFail?'　最近 '+R.checked+' 輪失敗 '+R.recentFail+' 次':'')+'</span></div>';
  var ok=(D.live&&D.live.ok)||{},names={okx:'OKX',bybit:'Bybit'};
  var ks=Object.keys(ok);
  /* OKX 抓不到才算異常；Bybit 會擋部分地區，只註記 */
  if(ks.length)s+='<div class="st"><span class="dot '+(ok.okx===false?'bad':'good')+'"></span><b>即時價格</b><span class="cat">'+ks.map(function(k){return names[k]+(ok[k]?' ✓':' 抓不到')}).join('　')+'</span></div>';
  var sn=D.snap;
  s+='<div class="st"><span class="dot '+(snapBad()?'bad':'good')+'"></span><b>每小時快照</b><span class="cat">'+(sn?'Binance、Bitget 價格與大盤　'+tpe(sn.t)+'（'+ago(sn.t)+'）':'尚無資料（下一個整點產生）')+'</span></div>'+
    (sn?(sn.warnings||[]).map(function(x){return '<div class="warn">'+esc(x)+'</div>'}).join(''):'');
  return s+'</div>'}
function snapBad(){var sn=D.snap;return !sn||Date.now()-sn.t>2.5*3600e3||(sn.warnings||[]).length>0}
function liveBad(){var ok=(D.live&&D.live.ok)||{};return ok.okx===false||snapBad()}
function sysBad(){
  var bad=Object.keys(MODEXP).some(function(t){var u=D.updated&&D.updated[t]?Date.parse(D.updated[t]):0;return (u&&Date.now()-u>MODEXP[t]*3600e3)||((D.warnings&&D.warnings[t])||[]).length});
  return bad||(D.runs&&D.runs.last&&!D.runs.last.ok)||liveBad()}
function quietCard(){
  var q=D.quiet;if(!q)return '<div class="card empty">還沒有資料（第一筆量增價平出現後開始記錄）</div>';
  var all=q.done.concat(q.items),src=[['all','全部'],['hourly','盤中'],['short','每日（短線）'],['layout','每日（布局）']];
  function st(rows,h){var v=rows.map(function(x){return x.r&&x.r[h]}).filter(function(x){return typeof x==='number'});
    if(!v.length)return '—';var avg=v.reduce(function(a,b){return a+b},0)/v.length,up=v.filter(function(x){return x>0}).length/v.length;
    return pc100(avg)+' <small>上漲 '+(up*100).toFixed(0)+'%・'+v.length+' 筆</small>'}
  return '<div class="card"><div class="sub" style="margin-bottom:6px">每筆記錄之後 24h、72h 的漲跌。追蹤中 '+q.items.length+' 筆、已結算 '+q.done.length+' 筆</div>'+
    src.map(function(x){var rows=all.filter(function(r){return x[0]==='all'||r.src===x[0]});
      return '<div class="st"><b>'+x[1]+'</b><span class="cat">24h '+st(rows,24)+'　72h '+st(rows,72)+'</span></div>'}).join('')+'</div>'}
function home(){
  CNT=null;
  var t=todo(),o=overlap();
  var left=panel('需要處理 <small>'+t.length+'</small>',todoTables(),'grow');
  var ov=o.length?'<div class="card">'+o.map(function(x){
    return '<div class="ov"><div class="l1"><span class="sym">'+esc(x.b)+'</span>'+WT(x.b)+'<span class="cat">'+x.n+' 個模組</span></div><div class="chips">'+
      MODS.filter(function(k){return x.m[k[0]]}).map(function(k){return '<span class="badge">'+k[1]+' '+esc(x.m[k[0]])+'</span>'}).join('')+'</div></div>'}).join('')+'</div>':'<div class="card empty">無</div>';
  var right=panel('大盤',marketCard(),'fix')+panel('量增價平成績',quietCard(),'fix')+panel('多模組重疊 <small>'+o.length+' 檔同時出現在 2 個以上模組</small>',ov,'ovp')+panel('系統狀態',status(),'fix');
  return (sysBad()?'<div class="card alert" style="flex:none">系統有異常（更新延遲、執行失敗或資料警告），詳見「系統狀態」</div>':'')+'<div class="home"><div class="vs">'+right+'</div><div class="vs todo">'+left+'</div></div>'}

/* ---------- 盤中爆量 ---------- */
function hourly(){
  var h=D.hourly;if(!h){CNT=null;return '<div class="empty">還沒有盤中爆量資料</div>'}
  var f=F.hourly,ref=(h.lastHour||Date.now())+3600e3,w=(+f.win)*3600e3,mx=+f.minx;
  var list=h.recent.filter(function(a){return a.t>=ref-w&&a.x1>=mx&&pass(f,{base:a.base,cat:a.cat,vens:[a.venue],watch:hW(a),single:a.single,quiet:a.quiet})});
  CNT=[list.length,h.recent.length];
  return '<div class="vs"><div class="meta">最近檢查：'+tpe(h.lastHour)+' 那根 1H K，保留 72 小時內紀錄。滑鼠停在交易所欄可看其他家倍數。</div>'+panel('',table('hourly',list,COLS.hourly()),'grow')+'</div>'}

/* ---------- 短線 ---------- */
function stat(cl,val,fmt){if(!cl.length)return '<small>0 筆</small>';var w=cl.filter(function(p){return val(p)>0}).length,sum=cl.reduce(function(a,p){return a+val(p)},0);
  return '<small>'+cl.length+' 筆　勝率 '+(w/cl.length*100).toFixed(0)+'%　平均 '+fmt(sum/cl.length)+'</small>'}
function short(){
  var x=D.short;if(!x){CNT=null;return '<div class="empty">還沒有短線清單資料</div>'}
  var f=F.short,sd=f.side,P=function(c){return pass(f,{base:c.base,cat:c.cat,vens:[c.ex],watch:inWatch(c.base),quiet:c.quiet,sw:c.status==='closed'||c.exitT?null:swLvl(c.base)})};
  var S1=function(p){return sd==='all'||p.side===sd};
  var s='<div class="vs"><div class="meta">最近每日掃描：'+esc(x.lastDaily||'—')+(sd!=='all'&&f.pane==='pend'?'。等待觸發每檔都有多空兩個觸發價；選「只看'+SIDE[sd]+'」時排除已越過另一邊的，距觸發只算'+SIDE[sd]+'那邊':'')+'。'+swMeta()+'</div>';
  if(f.pane==='pend'){
    var pe=x.pending.filter(function(c){return P(c)&&pendOk(c,sd)});CNT=[pe.length,x.pending.length];
    s+=panel('等待觸發 <small>'+pe.length+'　4H 收盤越過觸發價才算進場</small>',table('pend',pe,COLS.pend(),'無'),'grow');
  }else if(f.pane==='closed'){
    var all=x.closed||[],cl=all.filter(function(p){return P(p)&&S1(p)});CNT=[cl.length,all.length];
    s+=panel('成績 '+stat(cl,function(p){return p.r},function(v){return (v>=0?'+':'')+v.toFixed(2)+'R'})+'<small>　最近 100 筆</small>',table('shC',cl,COLS.shC(),'尚無已結算'),'grow');
  }else{
    var op=x.open.filter(function(p){return P(p)&&S1(p)});CNT=[op.length,x.open.length];
    s+=panel('持倉中 <small>'+op.length+'</small>',table('open',op,COLS.open(),'無'),'grow');
  }
  return s+'</div>'}

/* ---------- 布局 ---------- */
function layout(){
  var x=D.layout;if(!x){CNT=null;return '<div class="empty">還沒有布局清單資料</div>'}
  var f=F.layout,list=x.active.filter(function(it){return pass(f,{base:it.base,cat:it.cat,vens:it.spiked||[],watch:inWatch(it.base),single:it.single,quiet:it.quiet,sw:swLvl(it.base)})});
  CNT=[list.length,x.active.length];
  return '<div class="vs"><div class="meta">資料日 '+esc(x.lastDay||'—')+'（UTC 日線）。交易所篩選看「爆量的那家」。'+swMeta()+'</div>'+panel('',table('layout',list,COLS.layout()),'grow')+'</div>'}

/* ---------- 金叉 ---------- */
function cross(){
  var x=D.cross;if(!x){CNT=null;return '<div class="empty">還沒有金叉資料（第一次會在下一根 4H K 收盤後出現）</div>'}
  var f=F.cross,P=function(it){return pass(f,{base:it.base,cat:it.stock?'stock':'crypto',watch:inWatch(normBase(it.base,it.stock))})};
  var A=x.active.filter(P),B=x.recentB.filter(P),cl=(x.closed||[]).filter(P);
  CNT=[A.length+B.length,x.active.length+x.recentB.length];
  var s='<div class="vs"><div class="meta">Binance 現貨 4H，EMA20 上穿 SMA30。最近檢查：'+(x.lastBar?tpe(x.lastBar)+'–'+tpe(x.lastBar+144e5).slice(6):'—')+' 那根 K，範圍 '+(x.universe||0)+' 檔</div>';
  s+=panel('A 級追蹤中 <small>'+A.length+'　收盤＞SMA200 且量 ≥ 1.5 倍；追蹤 42 根（7 天），死叉＝出場參考</small>',table('crossA',A,COLS.crossA(),'無'));
  s+=panel('B 級 <small>48 小時內 '+B.length+'，不推播</small>',table('crossB',B,COLS.crossB(),'無'));
  s+=panel('成績 '+stat(cl,function(p){return p.exitRet},function(v){return (v>=0?'+':'')+v.toFixed(1)+'%（死叉出場）'}),table('crC',cl,COLS.crC(),'尚無（A 級追蹤滿 42 根後結算）'));
  return s+'</div>'}

/* ---------- 自選 ---------- */
var VC={};
function watch(){
  CNT=null;
  var rec=(D.hourly?D.hourly.recent:[]).filter(hW);
  var left=panel('自選標的 <small>'+D.watch.length+'</small>','<div class="card">'+
    '<div class="row" id="pwcard" style="margin-bottom:8px;display:'+(PW?'none':'flex')+'"><input id="pw" type="password" placeholder="密碼（只需輸入一次）" style="text-transform:none"><button class="btn pri" id="pwsave">確定</button></div>'+
    '<div class="row"><input id="sym" placeholder="代號，例如 APP、HYPE" autocapitalize="characters" autocomplete="off" spellcheck="false"><button class="btn pri" id="add">加入</button></div><div class="msg" id="msg"></div>'+
    '<div id="wl"></div><div class="sub">一律監控；盤中爆量門檻放寬為同時段 3 倍、近 48 小時 2 倍。加入後下一個整點生效。</div></div>');
  var sws=(D.sweep?D.sweep.events:[]).filter(function(e){return inWatch(e.base)});
  var right=panel('自選標的的盤中爆量 <small>72 小時內 '+rec.length+' 筆</small>',table('wh',rec,COLS.wh(),'尚無'),'grow')+
    panel('自選標的的掃流動性 <small>72 小時內 '+sws.length+' 筆　每根 4H K 收盤後更新；僅供參考，沒有回測</small>',table('ws',sws,COLS.ws(),D.sweep?'尚無':'還沒有資料（下一根 4H K 收盤後產生）'),'grow');
  return '<div class="wg"><div class="vs">'+left+'</div><div class="vs">'+right+'</div></div>'}
function drawWatch(){
  var box=$('wl');if(!box)return;
  if(!D.watch.length){box.innerHTML='<div class="empty">還沒有自選標的</div>';return}
  box.innerHTML='';
  D.watch.forEach(function(sym){
    var d=document.createElement('div');d.className='wl';
    d.innerHTML='<span class="sym" style="min-width:56px"></span><span class="chips cat">檢查中…</span><button class="btn del">移除</button>';
    d.querySelector('.sym').textContent=sym;d.querySelector('button').onclick=function(){change('remove',sym)};box.appendChild(d);
    var put=function(v){var c=d.querySelector('.chips');c.className='chips';var ks=Object.keys(v);if(!ks.length){c.className='chips cat';c.textContent='三家都找不到合約';return}
      c.innerHTML=ks.map(function(k){return '<a class="badge" target="_blank" rel="noopener" href="'+esc(tv(k,v[k],'60'))+'">'+VL[k]+'</a>'}).join('')};
    if(VC[sym])put(VC[sym]);else fetch('/api/check?s='+encodeURIComponent(sym)).then(function(r){return r.json()}).then(function(j){VC[sym]=j.venues||{};put(VC[sym])}).catch(function(){});
  })}
function msg(t,c){var m=$('msg');if(m){m.textContent=t;m.className='msg '+(c||'')}}
function change(action,symbol){
  if(!PW){msg('請先輸入密碼','err');$('pwcard').style.display='flex';return}
  var b=$('add');if(b)b.disabled=true;msg(action==='add'?'檢查三家交易所中…':'移除中…');
  fetch('/api/watch',{method:'POST',headers:{'Content-Type':'application/json','x-password':PW},body:JSON.stringify({action:action,symbol:symbol})})
  .then(function(r){return r.json().then(function(j){return {r:r,j:j}})}).then(function(o){
    if(o.r.status===401){PW='';try{localStorage.removeItem('sm_pw')}catch(e){}$('pwcard').style.display='flex'}
    if(!o.r.ok)throw new Error(o.j.error||o.r.status);
    D.watch=o.j.symbols;
    if(action==='add'){VC[symbol]=o.j.venues||VC[symbol];msg(symbol+' 已加入（'+Object.keys(o.j.venues||{}).map(function(x){return VL[x]}).join('、')+'），下一個整點生效','ok');$('sym').value=''}
    else msg(symbol+' 已移除','ok');
    drawWatch();tabs()}).catch(function(e){msg(e.message,'err')}).then(function(){if(b)b.disabled=false})}
function bindWatch(){
  drawWatch();
  var inp=$('sym');
  inp.addEventListener('input',function(){var st=inp.selectionStart,en=inp.selectionEnd;inp.value=inp.value.toUpperCase().replace(/\\s+/g,'');try{inp.setSelectionRange(st,en)}catch(e){}});
  inp.addEventListener('keydown',function(e){if(e.key==='Enter')$('add').click()});
  $('add').onclick=function(){var v=inp.value.trim().toUpperCase();if(v)change('add',v)};
  $('pwsave').onclick=function(){PW=$('pw').value.trim();try{localStorage.setItem('sm_pw',PW)}catch(e){}$('pwcard').style.display=PW?'none':'flex'}}

/* ---------- 畫面 ---------- */
var VIEWS={home:home,hourly:hourly,short:short,layout:layout,cross:cross,watch:watch};
function counts(){var h=D.hourly,x=D.short,l=D.layout,c=D.cross;return {home:todo().length,hourly:h?h.recent.length:0,short:x?x.open.length+x.pending.length:0,layout:l?l.active.length:0,cross:c?c.active.length+c.recentB.length:0,watch:(D.watch||[]).length}}
function tabs(){if(!D)return;var n=counts();document.querySelectorAll('#tabs button').forEach(function(b){var i=b.querySelector('i');if(!i){i=document.createElement('i');b.appendChild(i)}i.textContent=n[b.dataset.t]||''})}
function body(){var c=$('ct');if(!c)return;c.innerHTML=VIEWS[TAB]();updCnt();bindCt()}
function draw(){if(!D)return;var m=$('main');m.scrollTop=0;var fb=fbar();m.innerHTML=(fb?'<div class="fb" id="fb">'+fb+'</div>':'')+'<div id="ct"></div>';bindFb();body()}
function bindFb(){
  var fb=$('fb');if(!fb)return;var f=F[TAB];
  var q=$('q');q.oninput=function(){f.q=q.value.trim();body()};
  q.onkeydown=function(e){if(e.key==='Escape'){q.value='';f.q='';body();q.blur()}};
  fb.querySelectorAll('select[data-f]').forEach(function(s){s.onchange=function(){f[s.dataset.f]=s.value;s.classList.toggle('on',s.value!==String(FD[TAB][s.dataset.f]));saveF();body()}});
  fb.querySelectorAll('.tg[data-t]').forEach(function(b){b.onclick=function(){f[b.dataset.t]=f[b.dataset.t]?0:1;b.classList.toggle('on',!!f[b.dataset.t]);saveF();body()}});
  fb.querySelectorAll('[data-pane]').forEach(function(b){b.onclick=function(){f.pane=b.dataset.pane;saveF();draw()}});
  var sk=$('sk'),sd=$('sd');
  if(sk){sk.onchange=function(){var t=sortTarget(),c=colOf(t,sk.value);S[t]={k:sk.value,d:(c&&c.dd)||-1};saveS();syncSort();body()};
    sd.onclick=function(){var t=sortTarget();S[t].d*=-1;saveS();syncSort();body()}}
  $('clr').onclick=function(){var keep=f.pane;F[TAB]=JSON.parse(JSON.stringify(FD[TAB]));if(keep)F[TAB].pane=keep;saveF();draw()}}
function bindCt(){
  document.querySelectorAll('#ct th[data-sk]').forEach(function(h){h.onclick=function(){var t=h.dataset.tb,k=h.dataset.sk,c=colOf(t,k);
    if(S[t].k===k)S[t].d*=-1;else S[t]={k:k,d:(c&&c.dd)||-1};saveS();syncSort();body()}});
  if(TAB==='watch')bindWatch()}
function load(){
  $('reload').disabled=true;
  fetch('/api/data').then(function(r){return r.json()}).then(function(j){if(j.error)throw new Error(j.error);D=j;
    var u=Object.keys(j.updated||{}).map(function(k){return Date.parse(j.updated[k])||0});$('upd').textContent=u.length?'更新 '+tpe(Math.max.apply(null,u)):'';
    var keepQ=F[TAB]&&F[TAB].q,sc=$('main').scrollTop;tabs();draw();
    if(keepQ){F[TAB].q=keepQ;$('q').value=keepQ;body()}$('main').scrollTop=sc})
  .catch(function(e){$('main').innerHTML='<div class="empty">讀取失敗：'+esc(e.message)+'</div>'}).then(function(){$('reload').disabled=false})}
document.querySelectorAll('#tabs button').forEach(function(b){b.classList.toggle('on',b.dataset.t===TAB);b.onclick=function(){TAB=b.dataset.t;document.querySelectorAll('#tabs button').forEach(function(x){x.classList.toggle('on',x===b)});try{localStorage.setItem('sm_tab',TAB)}catch(e){}draw()}});
/* ---------- 代號旁的＋：直接加入自選（移除仍在自選分頁） ---------- */
var TT=null,QPEND=null;
function toast(html,cls,keep){var t=$('toast');if(!t){t=document.createElement('div');t.id='toast';document.body.appendChild(t)}
  clearTimeout(TT);t.className='on '+(cls||'');t.innerHTML=html;if(!keep)TT=setTimeout(function(){t.className=''},3000);return t}
function waBtns(sym){return [].slice.call(document.querySelectorAll('.wa')).filter(function(b){return b.dataset.wa===sym})}
function restoreWa(sym){waBtns(sym).forEach(function(b){b.disabled=false;b.textContent='+'})}
function askPw(sym,note){QPEND=sym;
  var t=toast('<span>'+(note?'<b class="dn">'+esc(note)+'</b>　':'')+'輸入密碼後加入 '+esc(sym)+'</span><input id="tpw" type="password" placeholder="密碼（只需一次）"><button class="btn pri" id="tpwok">確定</button><button class="lnk" id="tpwx">取消</button>','',true);
  var i=$('tpw');try{i.focus()}catch(e){}
  var close=function(){var s=QPEND;QPEND=null;t.className='';return s};
  var go=function(){var v=i.value.trim();if(!v)return;PW=v;try{localStorage.setItem('sm_pw',PW)}catch(e){}var pc=$('pwcard');if(pc)pc.style.display='none';quickAdd(close())};
  $('tpwok').onclick=go;
  i.onkeydown=function(e){if(e.key==='Enter')go();if(e.key==='Escape')restoreWa(close())};
  $('tpwx').onclick=function(){restoreWa(close())}}
function quickAdd(sym){
  if(!sym)return;
  if(inWatch(sym)){waBtns(sym).forEach(function(b){b.outerHTML='<span class="star" title="已在自選" aria-label="已在自選">★</span>'});return}
  waBtns(sym).forEach(function(b){b.disabled=true;b.textContent='…'});
  if(!PW){askPw(sym);return}
  fetch('/api/watch',{method:'POST',headers:{'Content-Type':'application/json','x-password':PW},body:JSON.stringify({action:'add',symbol:sym})})
  .then(function(r){return r.json().then(function(j){return {r:r,j:j}},function(){return {r:r,j:{}}})}).then(function(o){
    if(o.r.status===401){PW='';try{localStorage.removeItem('sm_pw')}catch(e){}askPw(sym,'密碼錯誤');return}
    if(!o.r.ok)throw new Error(o.j.error||('加入失敗（'+o.r.status+'）'));
    D.watch=o.j.symbols||D.watch;VC[sym]=o.j.venues||VC[sym]||{};
    waBtns(sym).forEach(function(b){b.outerHTML='<span class="star" title="已在自選" aria-label="已在自選">★</span>'});tabs();
    var vs=Object.keys(o.j.venues||{}).map(function(x){return VL[x]}).join('、');
    toast(esc(sym)+' 已加入自選'+(vs?'（'+vs+'）':'')+'，下一個整點生效','ok')})
  .catch(function(e){restoreWa(sym);toast(esc(e.message),'err')})}
document.addEventListener('click',function(e){var b=e.target&&e.target.closest?e.target.closest('.wa'):null;if(!b)return;e.preventDefault();e.stopPropagation();if(!b.disabled)quickAdd(b.dataset.wa)});
document.addEventListener('keydown',function(e){var a=document.activeElement,tn=a&&a.tagName||'';if(e.key==='/'&&!/^(INPUT|SELECT|TEXTAREA)$/.test(tn)){var q=$('q');if(q){e.preventDefault();q.focus();q.select()}}});
/* 手機沒有滑鼠停留：點掃流動性標記就在下方顯示細節，點其他地方關閉 */
document.addEventListener('click',function(e){var t=e.target.closest&&e.target.closest('.sw'),p=$('swpop');
  if(t&&t.title){e.preventDefault();if(!p){p=document.createElement('div');p.id='swpop';document.body.appendChild(p)}p.textContent=t.title;return}
  if(p)p.remove()});
$('reload').onclick=load;load();
</script></body></html>
`;
