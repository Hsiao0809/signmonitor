#!/usr/bin/env node
/* 把 out/telegram-*.txt 依序發到 Telegram（純文字，不需要第三方套件）。
   需要環境變數 TELEGRAM_BOT_TOKEN、TELEGRAM_CHAT_ID；只放在 GitHub Actions Secrets。
   檔名 telegram-<序號>-<類型>.txt：依類型送進群組對應的話題（config/telegram-topics.json，見 telegram-topics.mjs）；
   沒設定話題代號的類型、舊格式檔名送到群組預設的 General。話題不存在或已被刪除時退回 General，不漏發。
   每則發送結果另存一行到 logs/telegram/YYYY-MM-DD.jsonl（台灣日期），由 workflow commit 回 repo，
   方便事後回顧發過哪些訊號。紀錄只存訊息內容與類型，不含 token、chat id 與話題代號。
   連線逾時、Telegram 暫時錯誤（HTTP 429／5xx）會自動重試；某一則最終還是失敗，仍會繼續發後面的訊息，
   最後才以失敗結束，失敗的那則也會留在發送紀錄（error 欄位）。 */
import fs from 'node:fs';
import path from 'node:path';
import { parseFileName, loadTopics } from './telegram-topics.mjs';

const dir = process.argv[2] || 'out';
const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
const api = process.env.TELEGRAM_API || 'https://api.telegram.org';   /* 測試用：可指到本機假伺服器 */
if (!token || !chat) { console.log('未設定 TELEGRAM_BOT_TOKEN／TELEGRAM_CHAT_ID，略過通知'); process.exit(0); }

const topics = loadTopics();
const files = fs.existsSync(dir)
  ? fs.readdirSync(dir).map(f => ({ f, ...parseFileName(f) })).filter(x => x.n != null).sort((a, b) => a.n - b.n)
  : [];
/* 重試：只重試「還沒送達」的錯誤＝連線失敗／逾時、HTTP 429、HTTP 5xx；其他（400、403 等）重試也沒用，立刻回報。
   預設最多重試 3 次，間隔 2、5、10 秒；429 依 Telegram 回的 retry_after（最多等 30 秒）。 */
const RETRY_DELAYS = (process.env.TELEGRAM_RETRY_MS || '2000,5000,10000').split(',').map(Number).filter(n => n >= 0);
const FETCH_TIMEOUT_MS = Number(process.env.TELEGRAM_TIMEOUT_MS) || 20000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const netDesc = e => `network: ${e?.cause?.code || e?.cause?.errors?.[0]?.code || e?.name || 'error'} ${e?.message || ''}`.trim();
async function sendOnce(text, html, thread) {
  let r;
  try {
    r = await fetch(`${api}/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      body: JSON.stringify({ chat_id: chat, ...(thread ? { message_thread_id: thread } : {}), text, ...(html ? { parse_mode: 'HTML' } : {}), link_preview_options: { is_disabled: true } })
    });
  } catch (e) { return { ok: false, status: 0, desc: netDesc(e), retry: true }; }
  const j = await r.json().catch(() => ({}));
  const retry = !j.ok && (r.status === 429 || r.status >= 500);
  const wait = r.status === 429 ? Math.min(30, Number(j.parameters?.retry_after) || 0) * 1000 : 0;
  return { ok: !!j.ok, status: r.status, desc: j.description || '', retry, wait };
}
async function send(text, html, thread) {
  let r = await sendOnce(text, html, thread), tries = 0;
  while (!r.ok && r.retry && tries < RETRY_DELAYS.length) {
    console.error(`Telegram 發送失敗（${r.status || r.desc}），${RETRY_DELAYS[tries] / 1000} 秒後重試（第 ${tries + 1}/${RETRY_DELAYS.length} 次）`);
    await sleep(Math.max(RETRY_DELAYS[tries], r.wait || 0));
    tries++;
    r = await sendOnce(text, html, thread);
  }
  return { ok: r.ok, status: r.status, desc: r.desc, ...(tries ? { tries } : {}) };
}
/* 訊息是 HTML（標的名稱連到 TradingView）。萬一格式被 Telegram 拒絕，改用純文字再送一次 */
const toPlain = t => t.replace(/<a href="[^"]*">([^<]*)<\/a>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
/* 先送進該類型的話題；話題找不到（被刪、代號填錯）就退回 General；HTML 被拒再退純文字 */
async function deliver(text, thread) {
  let th = thread, fellBack = false;
  let r = await send(text, true, th);
  if (!r.ok && r.status === 400 && th && /thread|topic/i.test(r.desc)) { th = null; fellBack = true; r = await send(text, true, null); }
  if (!r.ok && r.status === 400) r = await send(toPlain(text).slice(0, 4096), false, th);
  return { ...r, fellBack };
}
const logDir = process.env.TELEGRAM_LOG_DIR || 'logs/telegram';
function record(f, key, text, r) {
  const now = new Date();
  const tw = now.toLocaleString('sv-SE', { timeZone: 'Asia/Taipei', hour12: false });
  const line = JSON.stringify({
    time: tw.replace(' ', 'T') + '+08:00', run: process.env.GITHUB_RUN_ID || null,
    part: f, ...(key ? { topic: key } : {}), ok: r.ok, ...(r.fellBack ? { fellBack: true } : {}),
    ...(r.tries ? { retries: r.tries } : {}),
    ...(r.ok ? {} : { error: (r.status ? `HTTP ${r.status} ${r.desc}` : r.desc).trim() }), text: toPlain(text)
  });
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, `${tw.slice(0, 10)}.jsonl`), line + '\n');
  } catch (e) { console.error(`寫入發送紀錄失敗：${e.message}`); }
}
let failed = 0;
for (const { f, key } of files) {
  const text = fs.readFileSync(path.join(dir, f), 'utf8');
  if (!text.trim()) continue;
  const r = await deliver(text, key ? topics[key] : undefined);
  record(f, key, text, r);
  if (r.fellBack && r.ok) console.error(`話題「${key}」找不到，已改送到 General；請檢查 config/telegram-topics.json`);
  if (!r.ok) { failed++; console.error(`Telegram 發送失敗（${f}，${r.status ? `HTTP ${r.status}` : '連線'}）：${r.desc}`); continue; }
  console.log(`已發送 ${f}${r.tries ? `（重試 ${r.tries} 次後成功）` : ''}`);
}
if (failed) { console.error(`本輪有 ${failed} 則沒發出去，其餘已照常發送；失敗的內容在 logs/telegram 的發送紀錄（ok:false）`); process.exit(1); }
