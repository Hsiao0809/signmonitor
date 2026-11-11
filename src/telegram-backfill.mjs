#!/usr/bin/env node
/* 一次性補發：用 logs/telegram/ 的發送紀錄，把最近一段時間（預設 24 小時）的通知依類型重發到群組對應的話題。
   Telegram 沒辦法搬動已發出的訊息，所以是「重發一份」：靜音發送（不會震動）、每則前面標原本的台灣時間、
   紀錄是純文字所以沒有 TradingView 連結。由 .github/workflows/telegram-backfill.yml 手動觸發。
     node src/telegram-backfill.mjs [--hours 24] [--cutoff ISO] [--dry-run] [--force]
   --cutoff：這個時間（含）之後的紀錄略過，因為話題建好後新發的通知已經直接進話題（workflow 用話題設定檔的 commit 時間）。
   紀錄裡有 topic 欄位的（話題分流上線後才有）直接用該類型；舊紀錄依區塊標題判斷類型。
   每次補發完寫 config/telegram-backfill.json；已經補發過就拒絕再跑（--force 才重跑），避免重複洗版。 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TOPICS, TOPICS_FILE, loadTopics } from './telegram-topics.mjs';

/* 區塊第一行 → 類型。標題對應 run.mjs／intrahour.mjs 各通知的開頭 */
const RULES = [
  [/^【盤中推算】/, 'pre'], [/^【預警】/, 'pre'], [/^【盤中爆量】/, 'hourly'], [/^【量增價平】/, 'quiet'],
  [/^【沉睡甦醒】/, 'dormant'], [/^【借幣利率/, 'rate'], [/^【日線金叉】/, 'crossd'], [/^【4H 金叉】/, 'cross'],
  [/^訊號掃描台｜.*失敗/, 'alert'], [/^訊號掃描台｜每日報告/, 'daily'], [/^(新進觀察清單|觀察清單：|起漲分數前)/, 'daily'],
  [/^布局清單/, 'layout'], [/^【(觸發|T1|結算)/, 'events']
];
export const classifyBlock = b => { const first = b.split('\n')[0]; for (const [re, k] of RULES) if (re.test(first)) return k; return null; };

/* 一則紀錄 → [{ k, text }]：連續同類型的區塊合併；沒有標題的區塊（被切段的後半、【連續放量】等子區塊）承接前一個類型。
   prev：同一輪前一則紀錄最後的類型（長訊息被切成多則時，後一則的開頭沒有標題）；回傳也帶最後類型。 */
export function splitRecord(rec, prev = null) {
  if (rec.topic && TOPICS[rec.topic]) return { groups: [{ k: rec.topic, text: rec.text }], last: rec.topic };
  const groups = [];
  let cur = prev;
  for (const block of rec.text.split('\n\n')) {
    if (!block.trim()) continue;
    cur = classifyBlock(block) || cur;
    const g = groups[groups.length - 1];
    if (g && g.k === cur) g.text += `\n\n${block}`; else groups.push({ k: cur, text: block });
  }
  return { groups, last: cur };
}

const tw = iso => iso.slice(5, 16).replace('T', ' ');
/* 超過 Telegram 單則上限就依區塊切開 */
function chunk(text, limit) {
  if (text.length <= limit) return [text];
  const out = []; let cur = '';
  for (const b of text.split('\n\n')) {
    const add = cur ? `${cur}\n\n${b}` : b;
    if (add.length <= limit) { cur = add; continue; }
    if (cur) out.push(cur);
    cur = b.length <= limit ? b : b.slice(0, limit);
  }
  if (cur) out.push(cur);
  return out;
}

/* 紀錄 → 要發的訊息（依原本發送時間排序）。records：logs 的每一行（已解析）。 */
export function plan(records, { sinceMs, cutoffMs = Infinity }) {
  const rs = records.filter(r => r.ok && r.text && Date.parse(r.time) >= sinceMs && Date.parse(r.time) < cutoffMs)
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time) || String(a.part).localeCompare(String(b.part), 'en', { numeric: true }));
  const sends = []; let prevRun = null, prevLast = null;
  for (const r of rs) {
    const { groups, last } = splitRecord(r, r.run && r.run === prevRun ? prevLast : null);
    prevRun = r.run; prevLast = last;
    for (const g of groups) {
      const head = `【補發 ${tw(r.time)} 台灣時間】\n`;
      chunk(g.text, 4096 - head.length).forEach(t => sends.push({ time: r.time, k: g.k, text: head + t }));
    }
  }
  return sends;
}

export function readLogs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort().flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
}

/* ---------------- 主程式 ---------------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  const argv = process.argv.slice(2);
  const flag = n => argv.includes(`--${n}`), val = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const hours = Number(val('hours', 24)), dry = flag('dry-run'), force = flag('force');
  const nowMs = process.env.BACKFILL_NOW ? Date.parse(process.env.BACKFILL_NOW) : Date.now();
  const cutoffMs = val('cutoff') ? Date.parse(val('cutoff')) : Infinity;
  const logDir = val('log-dir', 'logs/telegram'), marker = val('marker', 'config/telegram-backfill.json'), topicsFile = val('topics', TOPICS_FILE);
  const delay = Number(process.env.TELEGRAM_BACKFILL_DELAY_MS ?? 3300);   /* 群組每分鐘約 20 則 */
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID, api = process.env.TELEGRAM_API || 'https://api.telegram.org';
  if (!Number.isFinite(hours) || hours <= 0) { console.error('--hours 要是正數'); process.exit(1); }
  if (val('cutoff') && Number.isNaN(cutoffMs)) { console.error('--cutoff 不是有效時間'); process.exit(1); }

  const sinceMs = nowMs - hours * 3600e3;
  const sends = plan(readLogs(logDir), { sinceMs, cutoffMs });
  const count = {};
  sends.forEach(s => { const n = s.k ? TOPICS[s.k] : '未分類（General）'; count[n] = (count[n] || 0) + 1; });
  console.log(`補發範圍：${new Date(sinceMs).toISOString()} ～ ${cutoffMs === Infinity ? '現在' : new Date(cutoffMs).toISOString()}；共 ${sends.length} 則`);
  Object.entries(count).forEach(([n, c]) => console.log(`  ${n}：${c}`));
  if (dry) { console.log('（dry-run：不發送）'); return; }
  if (!sends.length) { console.log('沒有要補發的訊息'); return; }
  if (!token || !chat) { console.error('需要環境變數 TELEGRAM_BOT_TOKEN、TELEGRAM_CHAT_ID'); process.exit(1); }
  if (fs.existsSync(marker) && !force) { console.error(`已經補發過了（${marker}）。真的要再補發一次請用 --force`); process.exit(1); }

  const topics = loadTopics(topicsFile, {});
  const missing = [...new Set(sends.map(s => s.k).filter(k => k && !topics[k]))];
  if (missing.length) { console.error(`這些類型還沒有話題代號：${missing.map(k => TOPICS[k]).join('、')}。先執行 Telegram topics，避免全部倒進 General`); process.exit(1); }

  async function post(s) {
    for (let attempt = 1; attempt <= 5; attempt++) {
      let r, j;
      try {
        r = await fetch(`${api}/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chat, ...(s.k ? { message_thread_id: topics[s.k] } : {}), text: s.text, disable_notification: true, link_preview_options: { is_disabled: true } }) });
        j = await r.json().catch(() => ({}));
      } catch (e) {                                       /* 連線階段失敗：還沒送出，可以重試 */
        const codes = [e.cause?.code, ...(e.cause?.errors || []).map(x => x.code)];
        if (codes.some(c => ['ETIMEDOUT', 'ENETUNREACH', 'EAI_AGAIN', 'ECONNREFUSED'].includes(c)) && attempt < 5) { await sleep(Math.min(2000 * attempt, 10000)); continue; }
        throw e;
      }
      if (j.ok) return;
      if (r.status === 429 && attempt < 5) { await sleep(((j.parameters?.retry_after || 5) + 1) * 1000); continue; }
      throw new Error(`HTTP ${r.status} ${j.description || ''}`.trim());
    }
    throw new Error('重試次數用完');
  }
  let n = 0;
  for (const s of sends) {
    try { await post(s); } catch (e) { console.error(`第 ${n + 1}/${sends.length} 則補發失敗（${s.time}）：${e.message}。已補發 ${n} 則；修好後可用 --force 重跑（會從頭再發）`); process.exit(1); }
    n++;
    if (n % 20 === 0) console.log(`已補發 ${n}/${sends.length}`);
    if (delay) await sleep(delay);
  }
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ at: new Date(nowMs).toISOString(), since: new Date(sinceMs).toISOString(), until: cutoffMs === Infinity ? null : new Date(cutoffMs).toISOString(), sent: n, byTopic: count }, null, 2) + '\n');
  console.log(`補發完成：${n} 則`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
