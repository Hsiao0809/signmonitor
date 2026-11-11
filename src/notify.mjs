#!/usr/bin/env node
/* 把 out/telegram-*.txt 依序發到 Telegram（純文字，不需要第三方套件）。
   需要環境變數 TELEGRAM_BOT_TOKEN、TELEGRAM_CHAT_ID；只放在 GitHub Actions Secrets。
   檔名 telegram-<序號>-<類型>.txt：依類型送進群組對應的話題（config/telegram-topics.json，見 telegram-topics.mjs）；
   沒設定話題代號的類型、舊格式檔名送到群組預設的 General。話題不存在或已被刪除時退回 General，不漏發。
   每則發送結果另存一行到 logs/telegram/YYYY-MM-DD.jsonl（台灣日期），由 workflow commit 回 repo，
   方便事後回顧發過哪些訊號。紀錄只存訊息內容與類型，不含 token、chat id 與話題代號。 */
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
async function send(text, html, thread) {
  const r = await fetch(`${api}/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, ...(thread ? { message_thread_id: thread } : {}), text, ...(html ? { parse_mode: 'HTML' } : {}), link_preview_options: { is_disabled: true } })
  });
  const j = await r.json().catch(() => ({}));
  return { ok: !!j.ok, status: r.status, desc: j.description || '' };
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
    ...(r.ok ? {} : { error: `HTTP ${r.status} ${r.desc}`.trim() }), text: toPlain(text)
  });
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, `${tw.slice(0, 10)}.jsonl`), line + '\n');
  } catch (e) { console.error(`寫入發送紀錄失敗：${e.message}`); }
}
for (const { f, key } of files) {
  const text = fs.readFileSync(path.join(dir, f), 'utf8');
  if (!text.trim()) continue;
  const r = await deliver(text, key ? topics[key] : undefined);
  record(f, key, text, r);
  if (r.fellBack && r.ok) console.error(`話題「${key}」找不到，已改送到 General；請檢查 config/telegram-topics.json`);
  if (!r.ok) { console.error(`Telegram 發送失敗（HTTP ${r.status}）：${r.desc}`); process.exit(1); }
  console.log(`已發送 ${f}`);
}
