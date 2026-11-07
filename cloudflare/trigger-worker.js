/* signmonitor Worker（Cloudflare）
   1. 定時觸發：每小時第 50 分呼叫 GitHub 啟動 monitor.yml（GitHub 自己的排程常延遲或不跑）
   2. 網頁：盤中爆量、短線清單、布局清單、4H 金叉的最新資料；新增、移除自選標的（存進 GitHub Issue「自選標的」）
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
  return {
    urls, updated,
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
:root{--bg:#f4f5f7;--card:#fff;--fg:#16181d;--mut:#6b7280;--line:#e5e7eb;--acc:#2563eb;--up:#059669;--dn:#dc2626;--warn:#b45309;--chip:#eef2ff;--tag:#fef3c7;--tagfg:#92400e}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a20;--fg:#e8eaed;--mut:#9aa0a6;--line:#262b34;--acc:#60a5fa;--up:#34d399;--dn:#f87171;--warn:#fbbf24;--chip:#1d2433;--tag:#3a2e12;--tagfg:#fcd34d}}
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
summary{cursor:pointer;list-style:none}summary::-webkit-details-marker{display:none}summary h2:before{content:'▸ '}details[open] summary h2:before{content:'▾ '}
</style></head><body>
<header><div class="top"><h1>signmonitor</h1><span class="upd" id="upd"></span><button class="btn sec" id="reload">重新整理</button></div>
<nav id="tabs"><button data-t="hourly" class="on">盤中爆量</button><button data-t="short">短線</button><button data-t="layout">布局</button><button data-t="cross">金叉</button><button data-t="watch">自選</button></nav></header>
<main id="main"><div class="empty">讀取中…</div></main>
<script>
var D=null,TAB='hourly',PW='';try{PW=localStorage.getItem('sm_pw')||''}catch(e){}
var F={h:{only:'all',venue:'all',cat:'all'},l:{sort:'day',only:'all'}};
var VL={okx:'OKX',bitget:'Bitget',bybit:'Bybit'},TVX={okx:'OKX',bitget:'BITGET',bybit:'BYBIT'},CAT={crypto:'加密',stock:'股票',comm:'商品'};
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

function kindH(a){if(a.single)return '只有 '+VL[a.venue];if(a.spikedOthers&&a.spikedOthers.length)return [a.venue].concat(a.spikedOthers).map(function(v){return VL[v]}).join('＋')+' 同時';return VL[a.venue]}
function hourly(){
  var h=D.hourly;if(!h)return '<div class="empty">還沒有盤中爆量資料</div>';
  var f=F.h,list=h.recent.filter(function(a){
    if(f.only==='watch'&&!(a.watch||inWatch(a.base)))return false;
    if(f.only==='single'&&!a.single)return false;
    if(f.venue!=='all'&&a.venue!==f.venue)return false;
    if(f.cat!=='all'&&a.cat!==f.cat)return false;return true});
  var s='<div class="bar">'+pills('h','only',[['all','全部'],['watch','只看自選'],['single','只有一家']])+'</div>';
  s+='<div class="bar">'+pills('h','venue',[['all','全部交易所'],['okx','OKX'],['bitget','Bitget'],['bybit','Bybit']])+pills('h','cat',[['all','全部類別'],['crypto','加密'],['stock','股票'],['comm','商品']])+'</div>';
  s+='<div class="sub" style="margin-bottom:8px">最近檢查：'+tpe(h.lastHour)+' 那根 1H K　共 '+list.length+' 筆（72 小時內）</div>';
  if(!list.length)return s+'<div class="empty">沒有符合的紀錄</div>';
  var last=null;
  list.forEach(function(a){
    if(a.t!==last){last=a.t;s+='<h2>'+tpe(a.t)+'–'+tpe(a.t+3600e3).slice(6)+'</h2>'}
    var o=Object.keys(a.others||{}).map(function(v){return VL[v]+' '+a.others[v]+'x'}).join('｜')||'其他家無此合約或資料不足';
    s+='<div class="card"><div class="l1">'+((a.watch||inWatch(a.base))?'<span class="tag">自選</span>':'')+link(a.base,tv(a.venue,a.sym,'60'))+'<span class="cat">'+(CAT[a.cat]||a.cat)+'</span><span class="badge">'+kindH(a)+'</span></div>'+
      '<div class="kv"><div><span>同時段</span><b class="big">'+a.x1+'x</b></div><div><span>近48h</span>'+a.x2+'x</div><div><span>價格</span>'+fp(a.price)+'</div><div><span>1H</span>'+pc100(a.chg)+'</div><div><span>成交額</span>'+money(a.qv)+'</div></div>'+
      '<div class="sub">'+esc(o)+'</div></div>'});
  return s}

function short(){
  var x=D.short;if(!x)return '<div class="empty">還沒有短線清單資料</div>';
  var s='<div class="sub">最近每日掃描：'+esc(x.lastDaily||'—')+'</div>';
  s+='<h2>持倉中（'+x.open.length+'）</h2>';
  if(!x.open.length)s+='<div class="empty">無</div>';
  x.open.slice().sort(function(a,b){return b.trigT-a.trigT}).forEach(function(p){
    s+='<div class="card"><div class="l1">'+(inWatch(p.base)?'<span class="tag">自選</span>':'')+link(p.base,tv(p.ex,p.id,'240'))+'<span class="cat">'+(CAT[p.cat]||'')+'</span><span class="badge">'+SIDE[p.side]+'</span>'+(p.t1Hit?'<span class="badge">T1 ✓</span>':'')+'</div>'+
    '<div class="kv"><div><span>進場</span>'+fp(p.entry)+'</div><div><span>停損</span>'+fp(p.stop)+' ('+(p.riskPct||0).toFixed(1)+'%)</div><div><span>T1</span>'+fp(p.t1)+'</div><div><span>T2</span>'+fp(p.t2)+'</div><div><span>最大有利</span>+'+(p.mfeR||0).toFixed(1)+'R</div><div><span>觸發</span>'+tpe(p.trigT)+'</div></div>'+
    ((p.flags||[]).map(function(f){return '<div class="warn">'+esc(f)+'</div>'}).join(''))+'</div>'});
  s+='<h2>等待觸發（'+x.pending.length+'）</h2>';
  if(!x.pending.length)s+='<div class="empty">無</div>';
  x.pending.slice().sort(function(a,b){return (inWatch(b.base)-inWatch(a.base))||(b.dayT-a.dayT)||(b.vx-a.vx)}).forEach(function(c){
    s+='<div class="card"><div class="l1">'+(inWatch(c.base)?'<span class="tag">自選</span>':'')+link(c.base,tv(c.ex,c.id,'240'))+'<span class="cat">'+(CAT[c.cat]||'')+'</span><span class="badge">'+c.vx+'x</span><span class="cat">'+(PAT[c.pattern]||'')+'</span></div>'+
    '<div class="kv"><div><span>爆量日</span>'+md(c.dayT)+' '+pc100(c.chgDay)+'</div><div><span>收</span>'+fp(c.close)+'</div><div><span>做多</span>4H 收 &gt; '+fp(c.hi)+'</div><div><span>做空</span>4H 收 &lt; '+fp(c.lo)+'</div></div></div>'});
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
    s+='<div class="card"><div class="l1">'+(inWatch(it.base)?'<span class="tag">自選</span>':'')+lLink(it)+'<span class="cat">'+(CAT[it.cat]||'')+'</span><span class="badge">'+kindL(it)+'</span>'+(it.respikes?'<span class="cat">再爆量 '+it.respikes+'</span>':'')+'</div>'+
    '<div class="kv"><div><span>爆量日</span>'+it.day.slice(5)+'</div><div><span>天數</span>'+(it.age||0)+'</div><div><span>爆量日收</span>'+fp(it.entry)+'</div><div><span>現價</span>'+fp(it.last)+'</div><div><span>報酬</span>'+pc(it.ret)+'</div><div><span>相對大盤</span>'+pc(it.ex)+'</div><div><span>最大回撤</span>'+pc(it.mae)+'</div></div>'+
    '<div class="sub">'+vv+'</div></div>'});
  return s}

function bn(sym){return 'https://www.tradingview.com/chart/?symbol='+encodeURIComponent('BINANCE:'+sym)+'&interval=240'}
function stk(x){return x.stock?'<span class="tag">代幣化股</span>':''}
function cross(){
  var x=D.cross;if(!x)return '<div class="empty">還沒有金叉資料（第一次會在下一根 4H K 收盤後出現）</div>';
  var s='<div class="sub" style="margin-bottom:8px">Binance 現貨 4H，EMA20 上穿 SMA30。最近檢查：'+(x.lastBar?tpe(x.lastBar)+'–'+tpe(x.lastBar+144e5).slice(6):'—')+' 那根 K　範圍 '+(x.universe||0)+' 檔</div>';
  s+='<h2>A 級追蹤中（'+x.active.length+'）</h2><div class="sub" style="margin:-4px 0 8px">收盤 &gt; SMA200 且量 ≥ 1.5 倍；追蹤 42 根（7 天），死叉＝出場參考</div>';
  if(!x.active.length)s+='<div class="empty">無</div>';
  x.active.forEach(function(it){
    var stt=it.deadT?'<span class="badge" style="color:var(--dn)">已死叉 '+pc100(it.deadRet)+'</span>':'<span class="badge" style="color:var(--up)">仍成立</span>';
    s+='<div class="card"><div class="l1">'+link(it.base,bn(it.sym))+stk(it)+stt+'<span class="cat">'+tpe(it.t)+' 金叉</span></div>'+
    '<div class="kv"><div><span>金叉收</span>'+fp(it.close)+'</div><div><span>現價</span>'+fp(it.last)+'</div><div><span>報酬</span><b class="big">'+pc100(it.ret)+'</b></div><div><span>最大漲</span>'+pc100(it.mfe)+'</div><div><span>最大跌</span>'+pc100(it.mae)+'</div><div><span>量</span>'+it.volx+'x</div><div><span>距SMA200</span>'+pc100(it.px200)+'</div><div><span>近6根低</span>'+fp(it.stopPx)+' (-'+(it.stopPct||0).toFixed(1)+'%)</div><div><span>根數</span>'+(it.bars||0)+'/42</div></div></div>'});
  s+='<details'+(x.active.length?'':' open')+'><summary><h2 style="display:inline">B 級（48 小時內 '+x.recentB.length+'，不推播）</h2></summary>';
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
function draw(){if(!D)return;$('main').innerHTML=({hourly:hourly,short:short,layout:layout,cross:cross,watch:watch})[TAB]();bind()}
function load(){
  $('reload').disabled=true;
  fetch('/api/data').then(function(r){return r.json()}).then(function(j){if(j.error)throw new Error(j.error);D=j;
    var u=Object.keys(j.updated||{}).map(function(k){return Date.parse(j.updated[k])||0});$('upd').textContent=u.length?'更新 '+tpe(Math.max.apply(null,u)):'';draw()})
  .catch(function(e){$('main').innerHTML='<div class="empty">讀取失敗：'+esc(e.message)+'</div>'}).then(function(){$('reload').disabled=false})}
document.querySelectorAll('#tabs button').forEach(function(b){b.onclick=function(){TAB=b.dataset.t;document.querySelectorAll('#tabs button').forEach(function(x){x.classList.toggle('on',x===b)});try{localStorage.setItem('sm_tab',TAB)}catch(e){}draw()}});
try{var t=localStorage.getItem('sm_tab');if(t){TAB=t;document.querySelectorAll('#tabs button').forEach(function(x){x.classList.toggle('on',x.dataset.t===t)})}}catch(e){}
$('reload').onclick=load;load();
</script></body></html>`;
