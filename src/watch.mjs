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

/* ---------------- 借幣利率自動加入 ----------------
   自動加入的行寫成「RSR # 借幣利率自動 到期 2026-11-18T06:00Z」，到期後自動移除；期間再次飆高就延長。
   只動自動加入的行：手動加入的（沒有這個標記，含自己寫的註解）一律原樣保留、不會被標成自動或移除。 */
export const AUTO_DAYS = 7;
const AUTO_RE = /#\s*借幣利率自動 到期 (\S+)/;
const isoMin = t => new Date(t).toISOString().slice(0, 16) + 'Z';
export const autoLine = (sym, until) => `${sym} # 借幣利率自動 到期 ${isoMin(until)}`;

/** 一行 → { sym, until }（until＝null 代表手動加入） */
export function lineInfo(line) {
  const sym = normalizeSymbol(line.replace(/#.*/, ''));
  if (!sym) return null;
  const m = line.match(AUTO_RE), t = m ? Date.parse(m[1]) : NaN;
  return { sym, until: m && isFinite(t) ? t : null };
}

/** {代號: 到期時間}，只含自動加入的（網頁顯示用） */
export function autoOf(body) {
  const a = (body || '').indexOf(A), b = (body || '').indexOf(B);
  const out = {};
  if (a < 0 || b <= a) return out;
  for (const l of body.slice(a + A.length, b).split('\n')) { const x = lineInfo(l); if (x && x.until != null) out[x.sym] = x.until; }
  return out;
}

/**
 * adds：[{ sym, until }]。回傳 { body, changed, added, renewed, manual, removed }
 * 到期的自動行刪掉；已有自動行就延長到較晚的到期時間；已是手動的不動。
 */
export function applyAuto(body, adds, nowMs) {
  let src = body || '';
  if (src.indexOf(A) < 0 || src.indexOf(B) < src.indexOf(A)) src = formatWatch(parseWatch(src));
  const a = src.indexOf(A) + A.length, b = src.indexOf(B);
  const want = new Map();
  for (const x of adds) { const s = normalizeSymbol(x.sym); if (s) want.set(s, Math.max(want.get(s) ?? 0, x.until)); }
  const res = { added: [], renewed: [], manual: [], removed: [] };
  const seen = new Set(), lines = [];
  for (const l of src.slice(a, b).split('\n')) {
    const x = lineInfo(l);
    if (!x) { lines.push(l); continue; }
    if (x.until == null) {                                      /* 手動：原樣保留 */
      if (want.has(x.sym) && !seen.has(x.sym)) res.manual.push(x.sym);
      seen.add(x.sym); lines.push(l); continue;
    }
    if (seen.has(x.sym)) continue;                              /* 重複的自動行 */
    seen.add(x.sym);
    const until = Math.max(x.until, want.get(x.sym) ?? 0);
    if (until <= nowMs) { res.removed.push(x.sym); continue; }
    if (until > x.until) { res.renewed.push(x.sym); lines.push(autoLine(x.sym, until)); } else lines.push(l);
  }
  /* 新加入的放在區塊最後（結尾空行之前） */
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  for (const [s, until] of want) if (!seen.has(s) && until > nowMs) { res.added.push(s); lines.push(autoLine(s, until)); }
  const out = `${src.slice(0, a)}\n${lines.filter((l, i) => i || l.trim()).join('\n')}\n${src.slice(b)}`;
  return { body: out, changed: out !== (body || ''), ...res };
}
