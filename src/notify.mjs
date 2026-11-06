#!/usr/bin/env node
/* 把 out/telegram-*.txt 依序發到 Telegram（純文字，不需要第三方套件）。
   需要環境變數 TELEGRAM_BOT_TOKEN、TELEGRAM_CHAT_ID；只放在 GitHub Actions Secrets。
   每則發送結果另存一行到 logs/telegram/YYYY-MM-DD.jsonl（台灣日期），由 workflow commit 回 repo，
   方便事後回顧發過哪些訊號。紀錄只存訊息內容，不含 token 與 chat id。 */
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || 'out';
const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
if (!token || !chat) { console.log('未設定 TELEGRAM_BOT_TOKEN／TELEGRAM_CHAT_ID，略過通知'); process.exit(0); }

const files = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter(f => /^telegram-\d+\.txt$/.test(f)).sort((a, b) => parseInt(a.slice(9)) - parseInt(b.slice(9)))
  : [];
async function send(text, html) {
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, ...(html ? { parse_mode: 'HTML' } : {}), link_preview_options: { is_disabled: true } })
  });
  const j = await r.json().catch(() => ({}));
  return { ok: !!j.ok, status: r.status, desc: j.description || '' };
}
/* 訊息是 HTML（標的名稱連到 TradingView）。萬一格式被 Telegram 拒絕，改用純文字再送一次 */
const toPlain = t => t.replace(/<a href="[^"]*">([^<]*)<\/a>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const logDir = process.env.TELEGRAM_LOG_DIR || 'logs/telegram';
function record(f, text, r) {
  const now = new Date();
  const tw = now.toLocaleString('sv-SE', { timeZone: 'Asia/Taipei', hour12: false });
  const line = JSON.stringify({
    time: tw.replace(' ', 'T') + '+08:00', run: process.env.GITHUB_RUN_ID || null,
    part: f, ok: r.ok, ...(r.ok ? {} : { error: `HTTP ${r.status} ${r.desc}`.trim() }), text: toPlain(text)
  });
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, `${tw.slice(0, 10)}.jsonl`), line + '\n');
  } catch (e) { console.error(`寫入發送紀錄失敗：${e.message}`); }
}
for (const f of files) {
  const text = fs.readFileSync(path.join(dir, f), 'utf8');
  if (!text.trim()) continue;
  let r = await send(text, true);
  if (!r.ok && r.status === 400) r = await send(toPlain(text).slice(0, 4096), false);
  record(f, text, r);
  if (!r.ok) { console.error(`Telegram 發送失敗（HTTP ${r.status}）：${r.desc}`); process.exit(1); }
  console.log(`已發送 ${f}`);
}
