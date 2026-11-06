#!/usr/bin/env node
/* 把 out/telegram-*.txt 依序發到 Telegram（純文字，不需要第三方套件）。
   需要環境變數 TELEGRAM_BOT_TOKEN、TELEGRAM_CHAT_ID；只放在 GitHub Actions Secrets。 */
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || 'out';
const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
if (!token || !chat) { console.log('未設定 TELEGRAM_BOT_TOKEN／TELEGRAM_CHAT_ID，略過通知'); process.exit(0); }

const files = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter(f => /^telegram-\d+\.txt$/.test(f)).sort((a, b) => parseInt(a.slice(9)) - parseInt(b.slice(9)))
  : [];
for (const f of files) {
  const text = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 4096);
  if (!text.trim()) continue;
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, link_preview_options: { is_disabled: true } })
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) { console.error(`Telegram 發送失敗（HTTP ${r.status}）：${j.description || ''}`); process.exit(1); }
  console.log(`已發送 ${f}`);
}
