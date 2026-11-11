#!/usr/bin/env node
/* 一次性：在 Telegram 論壇群組（開啟「話題」的超級群組）裡，替每種通知建立自己的話題，
   並把話題代號寫進 config/telegram-topics.json（已經有代號的類型不會重複建立）。
   需要 TELEGRAM_BOT_TOKEN、TELEGRAM_CHAT_ID，且 bot 要是群組管理員並有「管理話題」權限。
   由 .github/workflows/telegram-topics.yml 手動觸發；話題代號不是機密，可以存在公開 repo。 */
import fs from 'node:fs';
import path from 'node:path';
import { TOPICS, TOPICS_FILE, loadTopics } from './telegram-topics.mjs';

const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
const api = process.env.TELEGRAM_API || 'https://api.telegram.org';
const file = process.argv[2] || TOPICS_FILE;
if (!token || !chat) { console.error('需要環境變數 TELEGRAM_BOT_TOKEN、TELEGRAM_CHAT_ID'); process.exit(1); }

async function call(method, body) {
  const r = await fetch(`${api}/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, ...body }) });
  const j = await r.json().catch(() => ({}));
  return { ok: !!j.ok, result: j.result, desc: j.description || `HTTP ${r.status}` };
}

const info = await call('getChat', {});
if (!info.ok) { console.error(`讀不到這個聊天室：${info.desc}。確認 TELEGRAM_CHAT_ID 是群組的 id，且 bot 已加入群組`); process.exit(1); }
if (!info.result?.is_forum) { console.error('這個群組還沒開啟「話題」。到群組設定 → 話題（Topics）打開後再執行一次'); process.exit(1); }

const topics = loadTopics(file, {});          /* 只讀設定檔，不看環境變數覆寫 */
const failed = [];
for (const [key, name] of Object.entries(TOPICS)) {
  if (topics[key]) { console.log(`${name}：已有話題，略過`); continue; }
  const r = await call('createForumTopic', { name });
  const id = r.result?.message_thread_id;
  if (!r.ok || !id) { failed.push(`${name}（${r.desc}）`); console.error(`${name}：建立失敗 ${r.desc}`); continue; }
  topics[key] = id;
  console.log(`${name}：已建立`);
}

fs.mkdirSync(path.dirname(file), { recursive: true });
const ordered = Object.fromEntries(Object.keys(TOPICS).filter(k => topics[k]).map(k => [k, topics[k]]));
fs.writeFileSync(file, JSON.stringify(ordered, null, 2) + '\n');
if (failed.length) {
  console.error(`有 ${failed.length} 個話題建立失敗：${failed.join('、')}。確認 bot 是管理員且有「管理話題」權限，再執行一次（已建立的不會重複）`);
  process.exit(1);
}
