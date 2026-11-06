/* signmonitor Worker（Cloudflare）
   1. 定時觸發：每小時第 50 分呼叫 GitHub 啟動 monitor.yml（GitHub 自己的排程常延遲或不跑）
   2. 自選標的網頁：開啟 Worker 網址即可新增、移除自選標的，存進 GitHub Issue「自選標的」
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
      Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json',
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

async function api(req, env, url) {
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
    return json({ symbols: list, venues });
  }
  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, env, url);
      return new Response(PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatch(env));
  }
};

/* ---------- 網頁 ---------- */
const PAGE = `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>signmonitor 自選標的</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#1b1f24;--mut:#6b7280;--line:#e5e7eb;--acc:#2563eb;--bad:#dc2626;--ok:#059669;--chip:#eef2ff}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#181b21;--fg:#e8eaed;--mut:#9aa0a6;--line:#2a2f38;--acc:#60a5fa;--bad:#f87171;--ok:#34d399;--chip:#1e2533}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Noto Sans TC","PingFang TC",sans-serif}
main{max-width:560px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:20px;margin:4px 0 2px}p.sub{margin:0 0 16px;color:var(--mut);font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:12px}
.row{display:flex;gap:8px}input{flex:1;min-width:0;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
button{font:inherit;padding:10px 14px;border:0;border-radius:8px;background:var(--acc);color:#fff;cursor:pointer;white-space:nowrap}
button.ghost{background:transparent;color:var(--bad);border:1px solid var(--line);padding:6px 10px;font-size:14px}
button:disabled{opacity:.5}
ul{list-style:none;margin:0;padding:0}li{display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--line)}li:first-child{border-top:0}
.sym{font-weight:700;min-width:64px}.chips{flex:1;display:flex;flex-wrap:wrap;gap:6px}
.chip{font-size:13px;padding:2px 8px;border-radius:999px;background:var(--chip);color:var(--acc);text-decoration:none}
.msg{font-size:14px;margin-top:8px;min-height:20px}.msg.err{color:var(--bad)}.msg.ok{color:var(--ok)}
.links a{color:var(--acc);font-size:14px;margin-right:12px}.mut{color:var(--mut);font-size:14px}
</style></head><body><main>
<h1>自選標的</h1>
<p class="sub">一律監控、盤中爆量門檻放寬（同時段 3 倍、近 48 小時 2 倍），通知標【自選】。加入後下一個整點生效。</p>
<div class="card" id="pwcard"><div class="row"><input id="pw" type="password" placeholder="密碼（只需輸入一次）" autocomplete="current-password"><button id="pwsave">確定</button></div></div>
<div class="card"><div class="row"><input id="sym" placeholder="代號，例如 APP、HYPE" autocapitalize="characters" autocomplete="off"><button id="add">加入</button></div><div class="msg" id="msg"></div></div>
<div class="card"><ul id="list"><li class="mut">讀取中…</li></ul></div>
<div class="links"><a href="https://github.com/${REPO}/issues?q=label%3A${LABEL}" target="_blank" rel="noopener">GitHub 清單</a></div>
</main><script>
const $=id=>document.getElementById(id);
const TV={okx:'OKX',bitget:'BITGET',bybit:'BYBIT'},VL={okx:'OKX',bitget:'Bitget',bybit:'Bybit'};
let pw='';try{pw=localStorage.getItem('sm_pw')||''}catch(e){}
function showPw(){$('pwcard').style.display=pw?'none':'block'}
showPw();
$('pwsave').onclick=()=>{pw=$('pw').value.trim();try{localStorage.setItem('sm_pw',pw)}catch(e){}showPw()};
function msg(t,c){const m=$('msg');m.textContent=t;m.className='msg '+(c||'')}
function tv(v,s){const core=v==='okx'?s.split('-')[0]:s.replace(/USDT$/,'');return 'https://www.tradingview.com/chart/?symbol='+encodeURIComponent(TV[v]+':'+core+'USDT.P')+'&interval=60'}
const cache={};
async function venues(s){if(cache[s])return cache[s];const r=await fetch('/api/check?s='+encodeURIComponent(s));const j=await r.json();return cache[s]=j.venues||{}}
async function render(symbols){
  const ul=$('list');
  if(!symbols.length){ul.innerHTML='<li class="mut">還沒有自選標的</li>';return}
  ul.innerHTML='';
  for(const s of symbols){
    const li=document.createElement('li');
    li.innerHTML='<span class="sym"></span><span class="chips mut">檢查中…</span><button class="ghost">移除</button>';
    li.querySelector('.sym').textContent=s;
    li.querySelector('button').onclick=()=>change('remove',s);
    ul.appendChild(li);
    venues(s).then(v=>{const c=li.querySelector('.chips');c.className='chips';c.innerHTML='';
      const ks=Object.keys(v);if(!ks.length){c.className='chips mut';c.textContent='三家都找不到合約';return}
      ks.forEach(k=>{const a=document.createElement('a');a.className='chip';a.href=tv(k,v[k]);a.target='_blank';a.rel='noopener';a.textContent=VL[k];c.appendChild(a)})}).catch(()=>{});
  }
}
async function load(){try{const r=await fetch('/api/watch');const j=await r.json();if(j.error)throw new Error(j.error);render(j.symbols)}catch(e){$('list').innerHTML='<li class="mut">讀取失敗：'+e.message+'</li>'}}
async function change(action,symbol){
  if(!pw){msg('請先輸入密碼','err');showPw();return}
  $('add').disabled=true;msg(action==='add'?'檢查三家交易所中…':'移除中…');
  try{
    const r=await fetch('/api/watch',{method:'POST',headers:{'Content-Type':'application/json','x-password':pw},body:JSON.stringify({action,symbol})});
    const j=await r.json();
    if(r.status===401){pw='';try{localStorage.removeItem('sm_pw')}catch(e){}showPw()}
    if(!r.ok)throw new Error(j.error||r.status);
    if(action==='add'){const k=Object.keys(j.venues||{}).map(x=>VL[x]);msg(symbol.toUpperCase()+' 已加入（'+k.join('、')+'），下一個整點生效','ok');$('sym').value=''}
    else msg(symbol+' 已移除','ok');
    render(j.symbols);
  }catch(e){msg(e.message,'err')}finally{$('add').disabled=false}
}
$('add').onclick=()=>{const s=$('sym').value.trim();if(s)change('add',s)};
$('sym').addEventListener('keydown',e=>{if(e.key==='Enter')$('add').click()});
load();
</script></body></html>`;
