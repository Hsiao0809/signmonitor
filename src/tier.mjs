/* 訊號分級層：只決定「Telegram 推不推、何時推」，不改任何偵測邏輯、不改訊號去重、不改網頁／Issue 內容。
   - 早期型（EARLY：量增價平、盤中爆量、預警、沉睡甦醒、借幣利率）：單一命中就即時推，不靠共振、不設每日上限。
   - 確認型（CONFIRM：4H／日線金叉、做空候選轉弱）：不即時推，累積成每日摘要，每個話題各一則。
   - 共振：同一個幣在 48 小時內「早期型」加「金叉」都出現，另外推一則升級通知（新話題「共振」）；只升級，不取代原本那則。
     做空候選方向相反，不參與共振。
   - 其他（每日掃描、布局清單、狀態變化、系統通知）原樣即時推。
   模式（config/tier.json 的 mode，或環境變數 TIER_MODE）：
     legacy：推播完全照舊；只在背景記錄「若分級會怎麼發」到 logs/tier/，供並行驗證。預設值。
     tiered：依上面規則推播。
   另有 nthCounter：每個幣後面標「今日第 N 次」，由 config 的 showNth 控制，與 mode 無關。
   任何錯誤一律退回原本的訊息清單，不影響推播。 */
import fs from 'node:fs';
import path from 'node:path';
import { TOPICS } from './telegram-topics.mjs';

const H = 3600e3;
export const EARLY = ['quiet', 'hourly', 'pre', 'dormant', 'rate'];
export const CONFIRM = ['cross', 'crossd', 'gainer'];
export const RESONANCE_CONFIRM = ['cross', 'crossd'];
export const CONFIG_FILE = 'config/tier.json';
export const DEFAULTS = {
  mode: 'legacy',
  digestAfter: '19:30',          /* 台灣時間；排程每小時整點才有一輪，所以實際是這個時間之後的第一輪 */
  resonanceHours: 48,
  resonanceCoolHours: 24,
  keepHours: 72,
  showNth: true,                 /* 每個幣後面標「今日第 N 次」（獨立於 mode，legacy 也有效）；false＝不標 */
  tiers: {}                      /* 例：{ "gainer": "A" } 把某個類型改回即時推 */
};

export function loadConfig(file = CONFIG_FILE, env = process.env) {
  let raw = {};
  try { if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.error(`分級設定讀取失敗，改用 legacy：${e.message}`); return { ...DEFAULTS }; }
  const cfg = { ...DEFAULTS, ...raw, tiers: { ...DEFAULTS.tiers, ...(raw.tiers || {}) } };
  const mode = env.TIER_MODE || cfg.mode;
  cfg.mode = mode === 'tiered' ? 'tiered' : 'legacy';
  return cfg;
}

export function tierOf(k, cfg = DEFAULTS) {
  const o = cfg.tiers?.[k];
  if (o === 'A' || o === 'B') return o;
  if (CONFIRM.includes(k)) return 'B';
  return 'A';                    /* 早期型與其他類型都即時推 */
}

/* 1000PEPE、PEPE 視為同一檔，金叉（Binance 現貨）與合約訊號才對得起來 */
export function normBase(b) {
  const s = String(b || '').toUpperCase().replace(/[-_/ ]?(USDT|USD)$/, '');
  const m = /^(1000000|10000|1000|1M)(.{2,})$/.exec(s);
  return m ? m[2] : s;
}

const tpeParts = ms => {
  const d = new Date(ms + 8 * H);
  return { day: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes(), hhmm: d.toISOString().slice(11, 16), md: d.toISOString().slice(5, 10) };
};
const afterMin = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ''); return m ? +m[1] * 60 + +m[2] : 19 * 60 + 30; };

export const emptyState = () => ({ version: 1, lastDigestDay: null, signals: [], pending: [], resonance: {} });

export function loadState(dir) {
  const f = path.join(dir, 'state.json');
  try {
    if (!fs.existsSync(f)) return emptyState();
    return { ...emptyState(), ...JSON.parse(fs.readFileSync(f, 'utf8')) };
  } catch (e) { console.error(`分級狀態讀取失敗，重新開始：${e.message}`); return emptyState(); }
}
export function saveState(dir, st) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(st));
}

/**
 * 「今日第 N 次」：同一個幣、同一類訊號，台灣時間當天從 0 點起第幾次被推（含這一次）。
 * 數的是 state.json 裡前幾輪的紀錄（每輪每個幣每類只算一次），所以只算主排程這一條，
 * 第 15／30／45 分盤中推算不計入；上線前（分級層 2026-11-12 11:26 合併）的通知也不在紀錄內。
 * 回傳 k => (base => N)；showNth 關閉或狀態讀不到就回傳 null（呼叫端不標）。
 */
export function nthCounter(nowMs, opts = {}) {
  try {
    const cfg = opts.cfg || loadConfig(opts.configFile);
    if (!cfg.showNth) return null;
    const st = loadState(opts.dir || 'data/tier');
    const day = tpeParts(nowMs).day, runs = new Map();
    for (const s of st.signals) {
      if (!(s.t < nowMs) || tpeParts(s.t).day !== day) continue;
      const key = `${s.k}|${s.base}`;
      if (!runs.has(key)) runs.set(key, new Set());
      runs.get(key).add(s.t);
    }
    return k => base => (runs.get(`${k}|${normBase(base)}`)?.size || 0) + 1;
  } catch (e) {
    console.error(`tier nth error: ${e.message}，本輪不標次數`);
    return null;
  }
}

/* 這一輪的每個訊號 → 近 resonanceHours 小時內「早期型」與「金叉」都出現的幣 */
function resonanceOf(st, newSigs, nowMs, cfg) {
  const since = nowMs - cfg.resonanceHours * H;
  const bases = [...new Set(newSigs.map(s => s.base))];
  const out = [];
  for (const base of bases) {
    const list = st.signals.filter(s => s.base === base && s.t >= since);
    const early = list.filter(s => EARLY.includes(s.k)), conf = list.filter(s => RESONANCE_CONFIRM.includes(s.k));
    if (!early.length || !conf.length) continue;
    const last = st.resonance[base];
    if (last && nowMs - last < cfg.resonanceCoolHours * H) continue;
    out.push({ base, early, conf });
    st.resonance[base] = nowMs;
  }
  return out;
}

const labelOf = k => TOPICS[k] || k;
function resonanceText(events, nowMs, hours) {
  const p = tpeParts(nowMs);
  const L = [`【共振】${p.md} ${p.hhmm} 台灣時間（${events.length} 檔：早期訊號＋金叉 ${hours} 小時內同時出現）`];
  const part = list => [...new Map(list.map(s => [s.k, s])).values()].map(s => `${labelOf(s.k)} ${tpeParts(s.t).md} ${tpeParts(s.t).hhmm}`).join('、');
  for (const e of events) L.push(`${e.base}｜早期：${part(e.early)}｜確認：${part(e.conf)}`);
  L.push('原本的訊號通知照常發送；這則只是把同一檔的早期訊號與金叉串起來');
  return L.join('\n');
}

function digestMessages(st, nowMs, cfg) {
  const p = tpeParts(nowMs), out = [];
  for (const k of CONFIRM) {
    if (tierOf(k, cfg) !== 'B') continue;
    const items = st.pending.filter(x => x.k === k);
    if (!items.length) continue;
    const body = items.map(x => `—— ${tpeParts(x.t).md} ${tpeParts(x.t).hhmm}\n${x.text}`).join('\n\n');
    out.push({ k, text: `【每日摘要・${labelOf(k)}】${p.md} ${p.hhmm} 台灣時間（累計 ${items.length} 則）\n\n${body}`, digest: items.length });
  }
  return out;
}

/**
 * msgs：[{ k, text }]（依發出順序）；sigs：[{ k, base }]（這一輪每個訊號的類型與標的）
 * 回傳 { out, info }：out＝要發的訊息（legacy 時就是原本那個陣列）；st 會被更新（呼叫端負責存檔）
 */
export function plan(msgs, sigs, nowMs, st, cfg = DEFAULTS) {
  const p = tpeParts(nowMs);
  const newSigs = sigs.filter(s => s.k && s.base).map(s => ({ k: s.k, base: normBase(s.base), t: nowMs }));
  const seen = new Set(st.signals.map(s => `${s.k}|${s.base}|${s.t}`));
  for (const s of newSigs) if (!seen.has(`${s.k}|${s.base}|${s.t}`)) st.signals.push(s);
  st.signals = st.signals.filter(s => nowMs - s.t < cfg.keepHours * H);
  for (const b of Object.keys(st.resonance)) if (nowMs - st.resonance[b] > cfg.keepHours * H) delete st.resonance[b];

  const immediate = [], deferred = [];
  for (const m of msgs) {
    if (!m.text) continue;
    if (tierOf(m.k, cfg) === 'B') { deferred.push(m); st.pending.push({ t: nowMs, k: m.k, text: m.text }); }
    else immediate.push(m);
  }
  const res = resonanceOf(st, newSigs, nowMs, cfg);
  const extra = [];
  if (res.length) extra.push({ k: 'resonance', text: resonanceText(res, nowMs, cfg.resonanceHours) });
  let digest = [];
  if (p.min >= afterMin(cfg.digestAfter) && st.lastDigestDay !== p.day) {
    digest = digestMessages(st, nowMs, cfg);
    st.pending = st.pending.filter(x => !digest.some(d => d.k === x.k));
    st.lastDigestDay = p.day;
  }
  const out = [...immediate, ...extra, ...digest.map(({ k, text }) => ({ k, text }))];
  return {
    out,
    info: {
      immediate: immediate.map(m => ({ k: m.k, chars: m.text.length })),
      deferred: deferred.map(m => ({ k: m.k, chars: m.text.length })),
      resonance: res.map(e => ({ base: e.base, early: e.early.map(s => s.k), confirm: e.conf.map(s => s.k) })),
      digest: digest.map(d => ({ k: d.k, n: d.digest, chars: d.text.length })),
      pending: st.pending.length
    }
  };
}

/* 安全檢查：依規則應該即時推的訊息，一則都不能少 */
export function missingImmediate(msgs, out, cfg = DEFAULTS) {
  const left = out.map(m => m.text);
  const missing = [];
  for (const m of msgs) {
    if (!m.text || tierOf(m.k, cfg) !== 'A') continue;
    const i = left.indexOf(m.text);
    if (i < 0) missing.push(m.k); else left.splice(i, 1);
  }
  return missing;
}

/**
 * run.mjs 的唯一入口。legacy：回傳原本的 msgs（同一個陣列），只記錄；tiered：回傳分級後的訊息。
 * 任何錯誤、或發現應即時推的訊息被漏掉，一律退回 msgs。
 */
export function applyTier(msgs, sigs, nowMs, opts = {}) {
  const cfg = opts.cfg || loadConfig(opts.configFile);
  const dir = opts.dir || 'data/tier', logDir = opts.logDir || 'logs/tier';
  try {
    const st = loadState(dir);
    const { out, info } = plan(msgs, sigs, nowMs, st, cfg);
    const bad = missingImmediate(msgs, out, cfg);
    const tiered = cfg.mode === 'tiered' && !bad.length;
    saveState(dir, st);
    const p = tpeParts(nowMs);
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, `${p.day}.jsonl`), JSON.stringify({
      time: `${p.day}T${p.hhmm}+08:00`, run: process.env.GITHUB_RUN_ID || null, mode: cfg.mode,
      sent: tiered ? 'tiered' : 'legacy', ...(bad.length ? { error: `即時訊息被漏掉：${bad.join(',')}` } : {}), ...info
    }) + '\n');
    if (bad.length) console.error(`tier error: 即時訊息被漏掉（${bad.join(',')}），本輪退回原本推播`);
    return tiered ? out : msgs;
  } catch (e) {
    console.error(`tier error: ${e.message}，本輪退回原本推播`);
    return msgs;
  }
}
