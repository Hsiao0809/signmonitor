/* Telegram 群組「話題」分流：每種通知各進自己的話題（message_thread_id）。
   run.mjs／intrahour.mjs 依類型分檔（telegram-<序號>-<類型>.txt），notify.mjs 依類型查話題代號發送。
   話題代號存在 config/telegram-topics.json（只是話題編號，不是機密；chat id 仍只放 Secrets），
   沒設定的類型送到群組預設的 General。想把幾種併進同一個話題，就在設定檔填同一個代號。 */
import fs from 'node:fs';

/* 類型 → 話題名稱（建立話題時用）。key 只能是小寫英文字母（檔名用） */
export const TOPICS = {
  quiet: '量增價平',
  hourly: '盤中爆量',
  pre: '盤中預警',
  dormant: '沉睡甦醒',
  rate: '借幣利率',
  gainer: '做空候選',
  cross: '4H 金叉',
  crossd: '日線金叉',
  daily: '每日掃描',
  layout: '布局清單',
  events: '狀態變化',
  alert: '系統通知'
};
export const TOPICS_FILE = 'config/telegram-topics.json';

export const fileName = (n, key) => `telegram-${n}-${key}.txt`;
/* telegram-3-cross.txt → { n: 3, key: 'cross' }；舊格式 telegram-3.txt → key 為 null（送 General） */
export function parseFileName(f) {
  const m = /^telegram-(\d+)(?:-([a-z]+))?\.txt$/.exec(f);
  return m ? { n: +m[1], key: m[2] || null } : null;
}

/* items：[{ k: 類型, text }]（依發出順序）→ 同類型合併成一則，類型順序照第一次出現 */
export function groupByTopic(items) {
  const order = [], by = new Map();
  for (const { k, text } of items) {
    if (!text) continue;
    if (!by.has(k)) { by.set(k, []); order.push(k); }
    by.get(k).push(text);
  }
  return order.map(k => ({ k, text: by.get(k).join('\n\n') }));
}

/* 讀話題代號：環境變數 TELEGRAM_TOPICS（JSON）優先，其次設定檔；只收已知類型、正整數 */
export function loadTopics(file = TOPICS_FILE, env = process.env) {
  let raw = {};
  try {
    if (env.TELEGRAM_TOPICS) raw = JSON.parse(env.TELEGRAM_TOPICS);
    else if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { console.error(`話題設定讀取失敗，全部送到 General：${e.message}`); return {}; }
  const out = {};
  for (const k of Object.keys(TOPICS)) { const v = Number(raw?.[k]); if (Number.isInteger(v) && v > 0) out[k] = v; }
  return out;
}
