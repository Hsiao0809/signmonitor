/* ============================================================
   自選標的：存在 Issue「自選標的」本文的標記區塊裡，一行一個代號。
   網頁（Cloudflare Worker）負責新增、移除；也可以直接在 GitHub 編輯。
   ============================================================ */
export const WATCH_TITLE = '自選標的';
const A = '<!-- WATCHLIST -->', B = '<!-- /WATCHLIST -->';

/** 使用者輸入的各種寫法統一成代號：appusdt、APP-USDT-SWAP、APPSTOCKUSDT → APP */
export function normalizeSymbol(s) {
  let x = String(s || '').trim().toUpperCase().replace(/\.P$/, '');
  x = x.replace(/^(OKX|BITGET|BYBIT|BINANCE):/, '').replace(/-USDT-SWAP$/, '').replace(/[-_]?USDT$/, '').replace(/STOCK$/, '');
  return /^[A-Z0-9]{1,20}$/.test(x) ? x : null;
}

export function parseWatch(body) {
  if (!body) return [];
  const a = body.indexOf(A), b = body.indexOf(B);
  const block = a >= 0 && b > a ? body.slice(a + A.length, b) : '';
  const out = [];
  for (const line of block.split('\n')) {
    const s = normalizeSymbol(line.replace(/#.*/, ''));
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

export function formatWatch(symbols) {
  const list = [...new Set(symbols.map(normalizeSymbol).filter(Boolean))];
  return [
    `# ${WATCH_TITLE}`,
    '',
    '由 signmonitor 網頁管理；也可以直接編輯下面兩行標記之間的內容，一行一個代號（例如 APP、HYPE）。',
    '自選標的不受流動性下限限制，盤中爆量門檻放寬（同時段 3 倍、近 48 小時 2 倍），通知標【自選】。',
    '',
    A,
    ...list,
    B,
    ''
  ].join('\n');
}
