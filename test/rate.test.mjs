import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as R from '../src/rate.mjs';
import { appendRates } from '../src/rate-scan.mjs';

const H = 3600e3;
const T = Date.UTC(2026, 10, 11, 6);
/* 前 n 小時固定利率 */
const flat = (v, n = 168) => { const h = {}; for (let i = 1; i <= n; i++) h[T - i * H] = v; return h; };

test('基準：前 7 天中位數；不足 72 小時回 null；不含本小時', () => {
  assert.equal(R.baseline(flat(0.2), T), 0.2);
  assert.equal(R.baseline(flat(0.2, 71), T), null);
  const h = { ...flat(0.2), [T]: 9 };
  assert.equal(R.baseline(h, T), 0.2);
});

test('飆高：3 倍、年化 ≥50%、多 ≥30 個百分點；只有預估達標標 est', () => {
  assert.deepEqual(R.spikeOf(0.9, 0.9, 0.2).by, 'pre');
  assert.equal(R.spikeOf(0.9, 0.3, 0.2).v, 0.9);
  const e = R.spikeOf(0.25, 1.2, 0.2);
  assert.equal(e.by, 'est'); assert.equal(e.v, 1.2); assert.ok(Math.abs(e.x - 6) < 1e-9);
  assert.equal(R.spikeOf(0.06, 0.06, 0.01), null);          /* 6 倍但年化太低 */
  assert.equal(R.spikeOf(0.55, 0.55, 0.2), null);           /* 年化夠但不到 3 倍 */
  assert.equal(R.spikeOf(3.65, 3.65, 3.65), null);          /* 一直都很高 */
  assert.equal(R.spikeOf(0.9, 0.9, null), null);
});

test('24 小時只通知一次，翻倍算再升；穩定幣不看', () => {
  const st = R.emptyRate();
  const hist = { ABC: flat(0.2), USDC: flat(0.01), NEW: flat(0.2, 10) };
  const rows = v => [{ ccy: 'ABC', pre: v, est: v }, { ccy: 'USDC', pre: 0.9, est: 0.9 }, { ccy: 'NEW', pre: 5, est: 5 }];
  let ev = R.pickSpikes(st, rows(0.8), hist, T, { ABC: { last: 1.5, chg: 0.1 } });
  assert.deepEqual(ev.map(e => e.ccy), ['ABC']);
  assert.equal(ev[0].last, 1.5);
  assert.equal(st.n, 1); assert.equal(st.top[0].ccy, 'ABC');            /* NEW 紀錄不足、USDC 是穩定幣 */
  ev = R.pickSpikes(st, rows(1.2), hist, T + H);
  assert.equal(ev.length, 0);
  ev = R.pickSpikes(st, rows(1.7), hist, T + 2 * H);
  assert.equal(ev.length, 1); assert.ok(ev[0].re);
  ev = R.pickSpikes(st, rows(0.8), hist, T + 27 * H);
  assert.equal(ev.length, 1); assert.ok(!ev[0].re);
  assert.equal(st.events.length, 3);
});

test('文字與 Issue 本文（狀態可還原）', () => {
  const st = R.emptyRate();
  const ev = R.pickSpikes(st, [{ ccy: 'ABC', pre: 0.25, est: 1.2 }], { ABC: flat(0.2) }, T, { ABC: { last: 0.0123, chg: -0.052 } });
  const txt = R.rateAlertText(ev, T, 'https://x');
  assert.match(txt, /【預估】/);
  assert.match(txt, /年化 120%/);
  assert.match(txt, /24h -5\.2%/);
  assert.equal(R.rateAlertText([], T), '');
  /* 沒有價格（現貨、永續都沒有）也要有價格欄，顯示 — */
  const ev2 = R.pickSpikes(R.emptyRate(), [{ ccy: 'NOPX', pre: 0.25, est: 1.2 }], { NOPX: flat(0.2) }, T, {});
  assert.match(R.rateAlertText(ev2, T), /價格 —/);
  const body = R.rateBody(st, { nowMs: T });
  assert.deepEqual(R.extractRate(body), JSON.parse(JSON.stringify(st)));
  assert.deepEqual(R.extractRate(''), R.emptyRate());
  assert.equal(R.extractRate('<!-- RATE_STATE\nxx\nRATE_STATE -->'), null);
});

test('每小時紀錄：同一小時不重寫、不存穩定幣', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rate-'));
  assert.ok(appendRates(dir, T, [{ ccy: 'BTC', pre: 0.005, est: 0.006 }, { ccy: 'USDT', pre: 0.1, est: 0.1 }]));
  assert.ok(!appendRates(dir, T, [{ ccy: 'BTC', pre: 0.005, est: 0.006 }]));
  const line = JSON.parse(fs.readFileSync(path.join(dir, '2026-11-11.jsonl'), 'utf8').trim());
  assert.deepEqual(line, { t: T, r: { BTC: [0.005, 0.006] } });
});

test('通知註明自動加入自選', () => {
  const st = R.emptyRate();
  const ev = R.pickSpikes(st, [{ ccy: 'ABC', pre: 0.9, est: 0.9 }], { ABC: flat(0.2) }, T);
  const txt = R.rateAlertText(ev, T, '', R.RATE, { added: ['ABC'], renewed: [], manual: ['XYZ'], noSwap: ['QQQ'] }, 7);
  assert.match(txt, /已加入自選 ABC（7 天後自動移出）/);
  assert.match(txt, /原本就在自選：XYZ/);
  assert.match(txt, /OKX 沒有永續合約、未加入自選：QQQ/);
  assert.doesNotMatch(R.rateAlertText(ev, T), /自選/);
});
