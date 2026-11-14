/* 每個幣後面的標籤（訊息文字用）：
   - 「今日第 N 次」：run.mjs 產生訊息時就算好（見 tier.mjs 的 nthCounter）。
   - 「上次 HH:MM」：連到同一話題裡這個幣的上一則訊息。上一則的 message_id 要等 Telegram 發送後才知道，
     所以產生訊息時只放一個佔位記號 {{P:幣}}，notify.mjs 發送前才換成連結（查不到上一則就換成空字串），
     並用這些記號知道這則訊息含哪些幣，發送成功後把 message_id 記起來。
   f：呼叫端傳進文字函式的標籤產生器（原本的 nth）：f(base) 回傳今日第幾次；f.nth === false 表示不標次數；
   f.prev(base) 回傳佔位記號（沒有就不加）。不傳（null）就什麼都不加，文字與沒有這個功能時完全相同。 */

/* encodeURIComponent 留下的 ! ' ( ) * ~ 也編碼，避免被 HTML 跳脫改掉 */
const enc = s => encodeURIComponent(s).replace(/[!'()*~]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
export const prevMark = base => `{{P:${enc(String(base))}}}`;
export const PREV_RE = /\{\{P:([^}]*)\}\}/g;
const dec = s => { try { return decodeURIComponent(s); } catch { return s; } };

export function nthTag(f, base) {
  if (!f) return '';
  let s = '';
  if (f.nth !== false) s += `｜今日第 ${f(base)} 次`;
  if (f.prev) s += f.prev(base);
  return s;
}

/* 訊息裡出現的記號 → 幣（去重，依出現順序） */
export const marksOf = text => [...new Set([...String(text).matchAll(PREV_RE)].map(m => dec(m[1])))];
export const stripMarks = text => String(text).replace(PREV_RE, '');
export const replaceMarks = (text, fn) => String(text).replace(PREV_RE, (_, e) => fn(dec(e)));
