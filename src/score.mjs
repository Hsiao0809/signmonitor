/* ============================================================
   訊號成績單：把 Telegram 發送紀錄（logs/telegram/）裡的每一筆訊號，補上之後 4／24／72 小時的實際走勢，
   彙整成「哪一種訊號真的會賺錢」的統計。
   - 完全獨立：只讀發送紀錄、只寫 data/score/ 與 Issue「訊號成績」，不改任何偵測、推播、去重。
   - 關閉：config/score.json 的 enabled 改成 false（或環境變數 SCORE_ENABLED=0），整個步驟直接略過。
   - 進場價＝訊號那根 1H K 的收盤價（盤中推算用訊息裡的價格，從下一根開始算）。
   - 報酬一律以「做多」計算；做空候選轉弱以「做空」計算（跌＝賺）。
   - 超額＝報酬減掉同一段時間 BTC（加密）或 QQQ（股票）的報酬，用來分辨「訊號本身有效」還是「只是大盤在漲跌」。
   - 勝率扣 0.2% 來回成本。
   ============================================================ */
import zlib from 'node:zlib';

export const H = 3600e3;
export const HZ = [4, 24, 72];
export const COST = 0.002;
export const MIN_N = 30;                 /* 樣本少於這個數，網頁灰字顯示 */
export const FADE_STOP = 0.10;           /* 反向做空試算的停損 */
export const KINDS = {
  hourly: { l: '盤中爆量', dir: 1 },
  est: { l: '盤中推算', dir: 1 },
  pre: { l: '預警', dir: 1 },
  dormant: { l: '沉睡甦醒', dir: 1 },
  rate: { l: '借幣利率', dir: 1 },
  cross: { l: '4H 金叉', dir: 1 },
  crossd: { l: '日線金叉', dir: 1 },
  gainer: { l: '做空候選轉弱', dir: -1 }
};
export const CLS = { '加密': 'crypto', '股票': 'stock', '商品': 'comm' };

/* ---------------- 解析發送紀錄 ---------------- */
const TPE = 8 * H;
/* 'MM-DD' 'HH:MM'（台灣時間）→ UTC 毫秒；年份取發送時間，跨年時往前一年 */
function tw(md, hm, sentMs) {
  const y = new Date(sentMs + TPE).getUTCFullYear();
  let t = Date.UTC(y, +md.slice(0, 2) - 1, +md.slice(3, 5), +hm.slice(0, 2), +hm.slice(3, 5)) - TPE;
  if (t - sentMs > 30 * 864e5) t = Date.UTC(y - 1, +md.slice(0, 2) - 1, +md.slice(3, 5), +hm.slice(0, 2), +hm.slice(3, 5)) - TPE;
  return t;
}
const num = s => Number(String(s).replace(/,/g, ''));
const tagsOf = s => [...String(s || '').matchAll(/【([^】]+)】/g)].map(m => m[1]);
const VEN = { OKX: 'okx', Bitget: 'bitget', Bybit: 'bybit' };
const vens = s => String(s || '').split('＋').map(x => VEN[x]).filter(Boolean);
const ENTRY = /^((?:【[^】]+】)*)([A-Z0-9][A-Z0-9.\-]*)［(加密|股票|商品)］(.*)$/;
const HEAD = /^【([^】]+)】(\d\d-\d\d) (\d\d:\d\d)(?:–(?:(\d\d-\d\d) )?(\d\d:\d\d))?/;

/** 一輪（同一個 run）的所有訊息 → 訊號清單。parts：[{time, part, text}] */
export function parseRun(parts) {
  const ps = [...parts].sort((a, b) => (+(/\d+/.exec(a.part || '') || [0])[0]) - (+(/\d+/.exec(b.part || '') || [0])[0]));
  const sent = Date.parse(ps[0].time);
  const text = ps.map(p => p.text || '').join('\n');
  const blocks = text.split(/\n+(?=【[^】]+】\d\d-\d\d )/);
  const out = [];
  /* 區間結束時間（訊號那根收盤）；跨日 00:00 用發送時間校正 */
  const endOf = (md, md2, hm1, hm2) => {
    const t = tw(md2 || md, hm2, sent);
    return !md2 && hm2 < hm1 ? t + 24 * H : t;      /* 「23:00–00:00」結束在隔天 */
  };
  for (const blk of blocks) {
    const lines = blk.split('\n');
    const h = HEAD.exec(lines[0]);
    if (!h) continue;
    const [, kind, md, hm1, md2, hm2] = h;
    if (kind === '盤中爆量' || kind === '預警') {
      if (!hm2) continue;
      const t = endOf(md, md2, hm1, hm2);
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) break;
        const m = ENTRY.exec(lines[i]);
        if (!m) continue;
        const [, tg, b, c, rest] = m;
        const s = { k: kind === '盤中爆量' ? 'hourly' : 'pre', b, c, t, tg: tagsOf(tg) };
        if (s.k === 'hourly') {
          let mm = /^(只有 )?([A-Za-z＋]+?)(?: 同時)? ★([\d.]+)x 同時段／([\d.]+)x 近48h(?:｜(.*))?/.exec(rest);
          if (mm) {
            s.o = !!mm[1]; s.v = vens(mm[2]); s.x = +mm[3]; s.x48 = +mm[4];
            const r = /連續放量 ([\d.]+)x/.exec(mm[5] || ''); if (r) s.rp = +r[1];
          } else if ((mm = /^(只有 )?([A-Za-z＋]+?)(?: 同時)? 連續 4 根放大，3 根累積 ([\d.]+)x 近48h（同時段 ([\d.]+)x）/.exec(rest))) {
            s.o = !!mm[1]; s.v = vens(mm[2]); s.rp = +mm[3]; s.xs = +mm[4];
          } else s.v = vens((/(OKX|Bitget|Bybit)/.exec(rest) || [])[1]);
          for (let j = i + 1; j < lines.length && lines[j].startsWith('  '); j++, i++) {
            const L = lines[j];
            const p = /價格 ([\d.,]+)（1H ([+\-][\d.]+)%）/.exec(L);
            if (p) { s.px = num(p[1]); s.ch = +p[2]; }
            if (/已推算通知|小時前已預警/.test(L)) s.w = 1;
          }
        } else {
          const mm = /^(OKX|Bitget|Bybit) 前一根 ([\d.]+)x／同時段 ([\d.]+)x｜1H ([+\-][\d.]+)%/.exec(rest);
          if (!mm) continue;
          s.v = [VEN[mm[1]]]; s.xp = +mm[2]; s.x = +mm[3]; s.ch = +mm[4];
        }
        out.push(s);
      }
    } else if (kind === '盤中推算') {
      const mi = /第 (\d+) 分/.exec(lines[0]);
      if (!mi) continue;
      const bar = tw(md, hm1, sent);
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) break;
        const m = ENTRY.exec(lines[i]);
        if (!m) continue;
        const [, tg, b, c, rest] = m;
        const s = { k: 'est', b, c, t: bar + +mi[1] * 60e3, tg: tagsOf(tg), mi: +mi[1] };
        const mm = /^(只有 )?([A-Za-z＋]+?)(?: 同時)? ★推算 ([\d.]+)x 同時段／([\d.]+)x 近48h/.exec(rest);
        if (mm) { s.o = !!mm[1]; s.v = vens(mm[2]); s.x = +mm[3]; s.x48 = +mm[4]; }
        for (let j = i + 1; j < lines.length && lines[j].startsWith('  '); j++, i++) {
          const p = /價格 ([\d.,]+)（這根目前 ([+\-][\d.]+)%(?:，前24h ([+\-][\d.]+)%／日ATR ([\d.]+)%)?/.exec(lines[j]);
          if (p) { s.px = num(p[1]); s.ch = +p[2]; if (p[3]) { s.p24 = +p[3]; s.atr = +p[4]; } }
        }
        if (s.px) out.push(s);
      }
    } else if (kind === '沉睡甦醒') {
      if (!hm2) continue;
      const t = endOf(md, md2, hm1, hm2);
      lines.forEach((L, i) => {
        const m = /^((?:【[^】]+】)*)([A-Z0-9]+) OKX /.exec(L);
        if (!m) return;
        const s = { k: 'dormant', b: m[2], c: '加密', t, tg: tagsOf(m[1]), v: ['okx', 'bitget'] };
        const p = /價格 ([\d.,]+)｜這根 ([+\-][\d.]+)%/.exec(lines[i + 1] || '');
        if (p) { s.px = num(p[1]); s.ch = +p[2]; }
        out.push(s);
      });
    } else if (kind === '借幣利率飆高') {
      const t = tw(md, hm1, sent);
      for (const L of lines) {
        const m = /^((?:【[^】]+】)*)([A-Z0-9]+) 年化 ([\d.]+)%/.exec(L);
        if (m) out.push({ k: 'rate', b: m[2], c: '加密', t, tg: tagsOf(m[1]), v: ['okx'] });
      }
    } else if (kind === '4H 金叉' || kind === '日線金叉') {
      if (!hm2) continue;
      const t = endOf(md, md2, hm1, hm2);
      for (const L of lines) {
        const m = /^((?:【[^】]+】)*)([A-Z0-9]+) 收 ([\d.,]+)｜量 ([\d.]+)x/.exec(L);
        if (m) out.push({ k: kind === '4H 金叉' ? 'cross' : 'crossd', b: m[2], c: '加密', t, tg: tagsOf(m[1]), v: ['binance'], px: num(m[3]), x: +m[4] });
      }
    } else if (kind === '做空候選・轉弱') {
      const t = tw(md, hm1, sent);
      for (const L of lines) {
        const m = /^((?:【[^】]+】)*)([A-Z0-9]+) (1H|4H)(?:＋4H)? 轉弱/.exec(L);
        if (m) out.push({ k: 'gainer', b: m[2], c: '加密', t, tg: tagsOf(m[1]), v: ['okx', 'bitget'] });
      }
    }
  }
  for (const s of out) s.id = `${s.k}|${s.b}|${s.t}|${(s.v || [])[0] || ''}`;
  return out;
}

/** 發送紀錄的行（已 JSON.parse）→ 依 run 分組；只收發送成功的 */
export function groupRuns(lines) {
  const runs = new Map();
  for (const d of lines) {
    if (!d || d.ok === false || !d.run || !d.text) continue;
    if (!runs.has(d.run)) runs.set(d.run, []);
    runs.get(d.run).push(d);
  }
  return runs;
}

/* ---------------- 補上之後的走勢 ---------------- */
/** 找 K 線來源：先用訊號那家（OKX／Bitget），沒有就用同名的 OKX → Bitget；金叉用 Binance 現貨 */
export function pickSrc(rec, okx, bitget) {
  if (rec.k === 'cross' || rec.k === 'crossd') return ['binance', `${rec.b}USDT`];
  const order = [...(rec.v || []).filter(v => v === 'okx' || v === 'bitget'), 'okx', 'bitget'];
  for (const v of order) {
    if (v === 'okx' && okx[rec.b]) return ['okx', okx[rec.b]];
    if (v === 'bitget' && bitget[rec.b]) return ['bitget', bitget[rec.b]];
  }
  return null;
}
export const benchOf = c => c === '加密' ? 'BTC' : c === '股票' ? 'QQQ' : null;

/** 路徑起點（第一根計入的 K 開盤時間）與進場價。bars：Map(開盤時間 → [t,o,h,l,c]) */
export function entryOf(rec, bars) {
  if (rec.k === 'est') {
    const start = Math.floor(rec.t / H) * H + H;
    const cur = bars.get(start - H);
    if (!cur || !(rec.px > 0) || Math.abs(cur[4] / rec.px - 1) > 0.15) return null;
    return { start, e: rec.px };
  }
  const start = Math.floor(rec.t / H) * H;
  const prev = bars.get(start - H);
  return prev ? { start, e: prev[4] } : null;
}

/** h 根之後：[報酬, 期間最高漲幅, 期間最大跌幅]；中間缺 K 就回傳 null */
export function pathRet(bars, start, e, h) {
  let hi = -Infinity, lo = Infinity, last = null;
  for (let i = 0; i < h; i++) {
    const b = bars.get(start + i * H);
    if (!b) return null;
    if (b[2] > hi) hi = b[2];
    if (b[3] < lo) lo = b[3];
    last = b[4];
  }
  return [last / e - 1, hi / e - 1, lo / e - 1];
}

/** 補一筆紀錄：回傳是否有更新。bench：Map(開盤時間 → bar) 或 null */
export function fill(rec, bars, bench, now) {
  let changed = false;
  if (!rec.m) rec.m = {};
  if (rec.e == null) {
    const en = bars && entryOf(rec, bars);
    if (!en) return false;
    rec.e = en.e; rec.st = en.start; changed = true;
  }
  for (const h of HZ) {
    if (rec.m[h] || now < rec.st + h * H) continue;
    const r = pathRet(bars, rec.st, rec.e, h);
    if (!r) continue;
    let bx = null;
    if (bench) {
      const b0 = bench.get(rec.st - H);
      const br = b0 ? pathRet(bench, rec.st, b0[4], h) : null;
      if (br) bx = br[0];
    }
    rec.m[h] = [r[0], r[1], r[2], bx].map(v => v == null ? null : Math.round(v * 1e5) / 1e5);
    changed = true;
  }
  return changed;
}
/** 72h 補完，或過了 84 小時（資料缺口）就結案 */
export const isDone = (rec, now) => !!(rec.m && rec.m[72]) || now - rec.t > 84 * H;

/* ---------------- 統計 ---------------- */
const r2 = v => v == null || !isFinite(v) ? null : Math.round(v * 1e4) / 100;   /* 比例 → 百分比 2 位 */
const median = a => { const s = [...a].sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

/** 一組紀錄在 h 小時的統計（報酬依訊號方向調整） */
export function stat(recs, h) {
  const rows = recs.filter(r => r.m && r.m[h]);
  if (!rows.length) return { n: 0 };
  const d = r => KINDS[r.k]?.dir || 1;
  const ret = rows.map(r => d(r) * r.m[h][0]);
  const ex = rows.filter(r => r.m[h][3] != null).map(r => d(r) * (r.m[h][0] - r.m[h][3]));
  /* 方向調整後的「最大有利／最大不利」：做多＝最高漲／最大跌，做空相反 */
  const fav = rows.map(r => d(r) > 0 ? r.m[h][1] : -r.m[h][2]);
  const adv = rows.map(r => d(r) > 0 ? r.m[h][2] : -r.m[h][1]);
  /* 反向做空：訊號價放空、停損 FADE_STOP、到期收盤平倉、扣成本。沒有停利，所以「期間最高漲 ≥ 停損」就是停損出場，順序不影響結果 */
  const fdRows = rows.filter(r => d(r) > 0);
  const fd = fdRows.map(r => (r.m[h][1] >= FADE_STOP ? -FADE_STOP : -r.m[h][0]) - COST);
  return {
    n: rows.length, nh: new Set(rows.map(r => Math.floor(r.t / H))).size,   /* 獨立時段數：同一小時一起爆量的多檔通常是同一個大盤事件 */
    avg: r2(mean(ret)), med: r2(median(ret)),
    win: Math.round(ret.filter(v => v - COST > 0).length / rows.length * 1000) / 10,
    ex: r2(mean(ex)), nx: ex.length, up: r2(mean(fav)), dn: r2(mean(adv)),
    b30: Math.round(rows.filter(r => (d(r) > 0 ? r.m[h][1] : -r.m[h][2]) >= 0.3).length / rows.length * 1000) / 10,   /* 爆發率：期間曾漲 ≥30% */
    fd: fd.length ? r2(mean(fd)) : null,
    fdw: fd.length ? Math.round(fd.filter(v => v > 0).length / fd.length * 1000) / 10 : null
  };
}
/** 前後兩半（依時間）超額報酬是否同方向；每半至少 15 筆才判斷：1＝都正、-1＝都負、0＝不一致 */
export function consistency(recs, h) {
  const rows = recs.filter(r => r.m && r.m[h] && r.m[h][3] != null).sort((a, b) => a.t - b.t);
  if (rows.length < 30) return null;
  const mid = Math.floor(rows.length / 2);
  const d = r => KINDS[r.k]?.dir || 1;
  const a = mean(rows.slice(0, mid).map(r => d(r) * (r.m[h][0] - r.m[h][3])));
  const b = mean(rows.slice(mid).map(r => d(r) * (r.m[h][0] - r.m[h][3])));
  return a > 0 && b > 0 ? 1 : a < 0 && b < 0 ? -1 : 0;
}

/* 盤中爆量細分：每個條件「有／沒有」各算一組 */
export const FEATS = [
  ['hot', '過熱（連續放量、≥20x 或 1H ≥+8% 任一）', r => (r.tg || []).includes('連續放量') || r.x >= 20 || r.ch >= 8],
  ['ramp', '連續放量', r => (r.tg || []).includes('連續放量')],
  ['big', '同時段 ≥20x', r => r.x >= 20],
  ['up2', '這根 1H ≥ +2%', r => r.ch >= 2],
  ['pump', '這根 1H ≥ +8%', r => r.ch >= 8],
  ['drop', '這根 1H ≤ −3%', r => r.ch <= -3],
  ['multi', '多家同時爆量', r => (r.v || []).length > 1],
  ['quiet', '量增價平', r => (r.tg || []).includes('量增價平')],
  ['warn', '之前已預警／已推算', r => !!r.w],
  ['watch', '自選', r => (r.tg || []).includes('自選')]
];

const tg = (r, t) => (r.tg || []).includes(t);
export const MARKS = [
  ['cand', '【爆發候選】', r => tg(r, '爆發候選')],
  ['mid', '沒有標記', r => r.t >= Date.UTC(2026, 10, 13, 11) && !tg(r, '爆發候選') && !tg(r, '可略過')],
  ['skip', '【可略過】', r => tg(r, '可略過')]
];

export function summarize(recs, now) {
  const W = { '7': 7, '30': 30, all: Infinity };
  const win = {};
  for (const [key, days] of Object.entries(W)) {
    const rs = recs.filter(r => r.e != null && now - r.t <= days * 864e5);
    const kinds = [];
    for (const k of Object.keys(KINDS)) for (const c of ['加密', '股票', '商品']) {
      const g = rs.filter(r => r.k === k && r.c === c);
      if (!g.length) continue;
      kinds.push({ k, c, h: Object.fromEntries(HZ.map(h => [h, stat(g, h)])), cons: Object.fromEntries(HZ.map(h => [h, consistency(g, h)])) });
    }
    const feats = [];
    for (const c of ['加密', '股票']) {
      const g = rs.filter(r => r.k === 'hourly' && r.c === c);
      if (!g.length) continue;
      for (const [f, label, fn] of FEATS) {
        const y = g.filter(fn), n = g.filter(r => !fn(r));
        if (!y.length) continue;
        feats.push({ c, f, label, yes: Object.fromEntries(HZ.map(h => [h, stat(y, h)])), no: Object.fromEntries(HZ.map(h => [h, stat(n, h)])), cons: Object.fromEntries(HZ.map(h => [h, consistency(y, h)])) });
      }
    }
    /* 爆發標記（src/burst.mjs，2026-11-13 起才有）：加密的盤中爆量／推算／預警 */
    const cr = rs.filter(r => r.c === '加密' && (r.k === 'hourly' || r.k === 'est' || r.k === 'pre'));
    const marks = MARKS.map(([m, label, fn]) => {
      const g = cr.filter(fn);
      return { m, label, h: Object.fromEntries(HZ.map(h => [h, stat(g, h)])) };
    }).filter(x => HZ.some(h => x.h[h].n));
    win[key] = { n: rs.length, kinds, feats, marks };
  }
  const recent = recs.filter(r => r.m && r.m[4]).sort((a, b) => b.t - a.t).slice(0, 120).map(r => ({
    k: r.k, b: r.b, c: r.c, t: r.t, v: (r.v || [])[0] || null, x: r.x ?? r.xs ?? null, ch: r.ch ?? null, tg: (r.tg || []).filter(x => x !== '自選').slice(0, 3), w: (r.tg || []).includes('自選') ? 1 : 0,
    r4: r.m[4]?.[0] ?? null, r24: r.m[24]?.[0] ?? null, r72: r.m[72]?.[0] ?? null, up24: r.m[24]?.[1] ?? null, dn24: r.m[24]?.[2] ?? null
  }));
  const first = recs.length ? Math.min(...recs.map(r => r.t)) : null;
  return { at: now, first, total: recs.length, filled: recs.filter(r => r.m && r.m[24]).length, win, recent };
}

/* ---------------- Issue 本文 ---------------- */
const pct = v => v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
const tpe = ms => new Date(ms + TPE).toISOString().slice(5, 16).replace('T', ' ');
export function renderMd(sum) {
  const L = [];
  L.push('# 訊號成績', '');
  L.push(`更新：${tpe(sum.at)} 台灣時間｜紀錄起點 ${sum.first ? tpe(sum.first) : '—'}｜共 ${sum.total} 筆，已有 24h 結果 ${sum.filled} 筆`, '');
  L.push('進場＝訊號那根 1H K 收盤價；報酬以做多計算（做空候選以做空計算）；超額＝減掉同時段 BTC（加密）／QQQ（股票）；勝率扣 0.2% 成本。樣本少於 30 筆僅供參考。完整表格在網頁「成績」分頁。', '');
  const w = sum.win.all;
  L.push('## 各訊號（全部期間，持有 24 小時）', '', '| 訊號 | 類別 | 筆數 | 獨立時段 | 平均 | 中位數 | 勝率 | 超額 | 反向做空 | 前後一致 |', '|---|---|---:|---:|---:|---:|---:|---:|---:|---|');
  for (const r of w.kinds) {
    const s = r.h[24];
    if (!s.n) continue;
    L.push(`| ${KINDS[r.k].l} | ${r.c} | ${s.n} | ${s.nh} | ${pct(s.avg)} | ${pct(s.med)} | ${s.win}% | ${pct(s.ex)} | ${pct(s.fd)} | ${r.cons[24] === 1 ? '都正' : r.cons[24] === -1 ? '都負' : r.cons[24] === 0 ? '不一致' : '樣本不足'} |`);
  }
  L.push('', '反向做空＝訊號價放空、10% 停損、到期平倉、扣成本的平均報酬。', '');
  if (w.marks && w.marks.length) {
    L.push('## 爆發標記（加密，持有 24 小時；2026-11-13 起）', '', '| 標記 | 筆數 | 爆發率（曾漲≥30%） | 平均 | 勝率 | 期間最大不利 |', '|---|---:|---:|---:|---:|---:|');
    for (const x of w.marks) { const t = x.h[24]; if (t.n) L.push(`| ${x.label} | ${t.n} | ${t.b30}% | ${pct(t.avg)} | ${t.win}% | ${pct(t.dn)} |`); }
    L.push('');
  }
  L.push('## 盤中爆量細分（全部期間，24 小時：有這個條件／沒有）', '', '| 類別 | 條件 | 有：筆數 | 有：超額 | 有：反向做空 | 沒有：筆數 | 沒有：超額 |', '|---|---|---:|---:|---:|---:|---:|');
  for (const f of w.feats) L.push(`| ${f.c} | ${f.label} | ${f.yes[24].n || 0} | ${pct(f.yes[24].ex)} | ${pct(f.yes[24].fd)} | ${f.no[24].n || 0} | ${pct(f.no[24].ex)} |`);
  L.push('', '> 只統計已發生的走勢，不是投資建議；一兩週的資料很容易只是那段行情的特性。');
  return L.join('\n');
}
const MA = '<!-- SCORE_STATE', MB = 'SCORE_STATE -->';
export function embedScore(md, state) {
  return `${md}\n\n${MA}\n${zlib.gzipSync(Buffer.from(JSON.stringify(state))).toString('base64')}\n${MB}\n`;
}
