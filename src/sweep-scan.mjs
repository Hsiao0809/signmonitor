/* ============================================================
   掃流動性：整理要檢查的標的、抓 4H K（網路部分）
   短線清單的 K 線沿用追蹤時已抓的，不另外呼叫；布局、自選用 OKX，沒有才用 Bitget。
   warnings：真的失敗（會在網頁系統狀態亮紅燈）；skipped：本來就做不到的（只有 Bybit、上市不久），只記在說明裡。
   ============================================================ */
import * as core from './core.mjs';
import { SWEEP } from './sweep.mjs';

const baseOf = m => (m.cat === 'stock' ? m.base.replace(/STOCK$/, '') : m.base);

/**
 * short：短線狀態；layout：布局狀態；watch：自選代號
 * lists：{okx, bitget} 合約清單（只有自選需要；給 null 會自己抓）
 * 回傳 [{base, cat, ex, id, src[], spike, lim}]，同一檔只留一筆
 */
export async function targets({ short, layout, watch = [] }, warnings, lists = null, skipped = []) {
  const by = new Map();
  const add = (base, o, src) => {
    const cur = by.get(base);
    if (!cur) { by.set(base, { base, ...o, src: [src] }); return; }
    if (!cur.src.includes(src)) cur.src.push(src);
    if (!cur.spike && o.spike) cur.spike = o.spike;
  };
  for (const c of [...(short?.open || []), ...(short?.pending || [])]) {
    add(c.base, { cat: c.cat, ex: c.ex, id: c.id, spike: { dayT: c.dayT, hi: c.hi, lo: c.lo }, lim: SWEEP.barsShort, item: c }, 'short');
  }
  for (const it of layout?.active || []) {
    const sy = it.syms || {};
    const ex = ['okx', 'bitget'].find(v => sy[v]);
    if (!ex) { if (!by.has(it.base)) skipped.push(`${it.base}（只有 Bybit）`); continue; }
    add(it.base, { cat: it.cat, ex, id: sy[ex], spike: it.dayT != null ? { dayT: it.dayT } : null, lim: SWEEP.barsOther }, 'layout');
  }
  const need = watch.filter(b => !by.has(b));
  if (need.length) {
    const L = lists || {};
    for (const ex of ['okx', 'bitget']) {
      if (L[ex]) continue;
      try { L[ex] = await core.EXCHANGES[ex].list(); } catch (e) { L[ex] = []; warnings.push(`${core.EXCHANGES[ex].label} 合約清單失敗（${e.message}）`); }
    }
    for (const b of need) {
      let m = null, ex = null;
      for (const v of ['okx', 'bitget']) {
        /* 同名時股票合約優先（自選多半是股票代號） */
        const hits = (L[v] || []).filter(x => baseOf(x) === b);
        m = hits.find(x => x.cat !== 'crypto') || hits[0];
        if (m) { ex = v; break; }
      }
      if (!m) { skipped.push(`${b}（OKX、Bitget 都沒有合約）`); continue; }
      add(b, { cat: m.cat, ex, id: m.id, spike: null, lim: SWEEP.barsOther }, 'watch');
    }
  }
  for (const b of watch) { const t = by.get(b); if (t && !t.src.includes('watch')) t.src.push('watch'); }
  return [...by.values()];
}

/**
 * 抓每檔的 4H K。cached(ex,id) 有短線追蹤抓過的就直接用。
 * 回傳 [{target, bars|null}]
 */
export async function collect(list, cached, warnings, skipped = []) {
  const out = [];
  const groups = { okx: [], bitget: [] };
  for (const t of list) {
    const c = t.lim === SWEEP.barsShort ? cached(t.ex, t.id) : null;
    if (c) { out.push({ target: t, bars: c }); continue; }
    (groups[t.ex] || (groups[t.ex] = [])).push(t);
  }
  for (const ex of Object.keys(groups)) {
    const E = core.EXCHANGES[ex];
    await core.pool(groups[ex], E.conc, async t => {
      let bars = null;
      try { bars = await E.kl(t.id, '4h', 0, t.lim); } catch { bars = null; }
      if (!bars) warnings.push(`${t.base}（${E.label}）4H K 線取得失敗`);
      else if (bars.length < SWEEP.volLen + 10) { skipped.push(`${t.base}（上市不久，4H K 只有 ${bars.length} 根）`); bars = null; }
      out.push({ target: t, bars });
    });
  }
  /* 狀態只存需要的欄位 */
  return out.map(r => ({ target: { base: r.target.base, cat: r.target.cat, ex: r.target.ex, id: r.target.id, src: r.target.src, spike: r.target.spike }, bars: r.bars }));
}
