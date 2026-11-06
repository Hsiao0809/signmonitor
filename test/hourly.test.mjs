import test from 'node:test';
import assert from 'node:assert/strict';
import * as HR from '../src/hourly.mjs';

const H = 3600e3, D = 24 * H;
const T = Date.UTC(2026, 10, 4, 14);                 /* 週三 14:00 UTC（美股盤中） */
/* 10 天每小時資料：平常 100；每天 14:00 固定 400（模擬美股開盤） */
function bars(curQv, { usOpen = 400, base = 100 } = {}) {
  const out = [];
  for (let t = T - 10 * D; t <= T; t += H) {
    const hour = new Date(t).getUTCHours();
    out.push({ t, o: 10, c: 10.2, qv: t === T ? curQv : (hour === 14 ? usOpen : base) });
  }
  return out;
}

test('跟同一小時比：每天固定的開盤量不會被當成爆量', () => {
  const st = HR.hourStats(bars(4.2e6, { usOpen: 4e6, base: 1e6 }), T, 'crypto');
  assert.ok(st.x1 < 1.2);
  assert.ok(st.x2 > 3);                              /* 只跟近 48h 平均比會誤判 */
  assert.equal(HR.isAnomaly(st, 'crypto'), false);
});

test('同時段 5 倍、近 48h 3 倍、成交額達標才算爆量', () => {
  const st = HR.hourStats(bars(4e6, { usOpen: 4e5, base: 1e5 }), T, 'crypto');
  assert.equal(st.price, 10.2);
  assert.ok(st.x1 >= 5 && st.x2 >= 3);
  assert.equal(HR.isAnomaly(st, 'crypto'), true);
  const small = HR.hourStats(bars(2500, { usOpen: 400, base: 100 }), T, 'crypto');
  assert.equal(HR.isAnomaly(small, 'crypto'), false); /* 倍數夠但成交額太小 */
});

test('股票合約平日只跟平日比', () => {
  const b = bars(1e6, { usOpen: 1e5, base: 1e5 });
  /* 把週末同一小時的量設成 0，若混進來中位數會被拉低 */
  b.forEach(x => { const d = new Date(x.t).getUTCDay(); if ((d === 0 || d === 6) && new Date(x.t).getUTCHours() === 14) x.qv = 0; });
  const st = HR.hourStats(b, T, 'stock');
  assert.ok(Math.abs(st.x1 - 10) < 1e-9);
});

test('冷門時段基準接近 0 時，倍數不會失真', () => {
  const st = HR.hourStats(bars(2e5, { usOpen: 10, base: 10 }), T, 'stock');
  assert.ok(st.x1 <= 5 + 1e-9);                     /* 基準至少當作 4 萬（20 萬 × 0.2） */
});

test('資料不足就不判斷', () => {
  assert.equal(HR.hourStats(bars(1e6).slice(-30), T, 'crypto'), null);
  assert.equal(HR.hourStats(bars(1e6), T + H, 'crypto'), null);
});

test('只有一家爆量的標示、12 小時內不重複通知', () => {
  const s = HR.emptyHourly();
  const big = { x1: 12, x2: 6, qv: 2e6, chg: 0.02 };
  const calm = { x1: 1.1, x2: 1, qv: 1e5, chg: 0 };
  const entries = [
    { venue: 'bybit', sym: 'APPSTOCKUSDT', base: 'APP', cat: 'stock', stats: big },
    { venue: 'okx', sym: 'APP-USDT-SWAP', base: 'APP', cat: 'stock', stats: calm },
    { venue: 'bitget', sym: 'APPUSDT', base: 'APP', cat: 'stock', stats: calm }
  ];
  const a1 = HR.pickAlerts(s, entries, T);
  assert.equal(a1.length, 1);
  assert.equal(a1[0].single, true);
  assert.deepEqual(a1[0].others, { okx: 1.1, bitget: 1.1 });
  assert.equal(HR.pickAlerts(s, entries, T + H).length, 0);                         /* 1 小時後同量不再通知 */
  entries[0].stats = { ...big, x1: 30 };
  assert.equal(HR.pickAlerts(s, entries, T + 2 * H).length, 1);                     /* 量再翻倍會通知 */
  assert.equal(HR.pickAlerts(s, [{ ...entries[0], stats: big }], T + 14 * H).length, 1); /* 超過 12 小時 */
});

test('通知文字含 TradingView 1H 連結與其他家倍數', () => {
  const s = HR.emptyHourly();
  const a = HR.pickAlerts(s, [
    { venue: 'bybit', sym: 'APPSTOCKUSDT', base: 'APP', cat: 'stock', stats: { x1: 12, x2: 6, qv: 2e6, chg: 0.02, price: 351.49 } },
    { venue: 'okx', sym: 'APP-USDT-SWAP', base: 'APP', cat: 'stock', stats: { x1: 1.1, x2: 1, qv: 1e5, chg: 0, price: 351.2 } }
  ], T);
  const txt = HR.hourlyAlertText(a, T);
  assert.match(txt, /盤中爆量/);
  assert.match(txt, /BYBIT%3AAPPSTOCKUSDT\.P&interval=60/);
  assert.match(txt, /只有 Bybit/);
  assert.match(txt, /OKX 1\.1x/);
  assert.match(txt, /價格 351\.49（1H \+2\.0%）/);
  assert.match(HR.hourlyMarkdown(s, { nowMs: T }), /\| 351\.49 \|/);
});

test('狀態可寫進 Issue 並讀回', () => {
  const s = HR.emptyHourly(); s.lastHour = T;
  assert.equal(HR.extractHourly(HR.embedHourly('# x', s)).lastHour, T);
  assert.equal(HR.extractHourly('<!-- HOURLY_STATE\n壞\nHOURLY_STATE -->'), null);
});
