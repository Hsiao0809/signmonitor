import test from 'node:test';
import assert from 'node:assert/strict';
import * as DM from '../src/dormant.mjs';
import { appendOI } from '../src/oi.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const H = 3600e3, D = 24 * H;
const T = Date.UTC(2026, 9, 21, 6);                /* 台灣 14:00 */
/* 12 天窄幅、每小時 1000 USDT；最後一根放量 */
function bars(last = { o: 0.013, c: 0.0139, qv: 47000 }, extra = {}) {
  const out = [];
  for (let t = T - 12 * D; t < T; t += H) out.push({ t, o: 0.013, h: 0.0135, l: 0.0125, c: 0.013, qv: extra[t] ?? 1000 });
  out.push({ t: T, o: last.o, h: Math.max(last.o, last.c), l: Math.min(last.o, last.c), c: last.c, qv: last.qv });
  return out;
}
const dm30 = (v = 5000) => { const m = {}; for (let d = 1; d <= 30; d++) m[DM.dayOf(T) - d * D] = v; return m; };

test('沉睡：放量（中位數 10 倍）與 30 天新高量', () => {
  const st = DM.wakeStats(bars(), T, dm30());
  assert.deepEqual(st.kinds, ['A', 'B']);
  assert.ok(st.xA > 40 && st.range < 0.1);
  /* 30 天裡有更大的量 → 只有 A */
  assert.deepEqual(DM.wakeStats(bars(), T, dm30(1e5)).kinds, ['A']);
  /* 30 天最高量資料不足 28 天 → 不判斷 B */
  assert.deepEqual(DM.wakeStats(bars(), T, {}).kinds, ['A']);
});

test('不算：收黑、成交額 < 3 萬、已離區間太遠、區間太寬', () => {
  assert.deepEqual(DM.wakeStats(bars({ o: 0.0139, c: 0.013, qv: 47000 }), T, dm30()).kinds, []);
  assert.deepEqual(DM.wakeStats(bars({ o: 0.013, c: 0.0134, qv: 2e4 }), T, dm30()).kinds, []);
  assert.deepEqual(DM.wakeStats(bars({ o: 0.013, c: 0.0150, qv: 47000 }), T, dm30()).kinds, []);   /* 高點 0.0135 +11% */
  const wide = bars(); wide[10] = { ...wide[10], h: 0.03 };                                         /* 前 12 天：不在前 10 天內 → 仍算沉睡 */
  assert.ok(DM.wakeStats(wide, T, dm30()));
  const wide2 = bars(); wide2[100] = { ...wide2[100], h: 0.03 };
  assert.equal(DM.wakeStats(wide2, T, dm30()), null);
});

test('兩家同一小時或前後 1 小時才通知；7 天不重複；放量之後出現 30天新高量算升級', () => {
  const st = DM.wakeStats(bars(), T, dm30());
  const stA = DM.wakeStats(bars(), T, {});
  const s = DM.emptyDormant();
  /* 只有 OKX → 不通知，但記住 */
  assert.equal(DM.pickWake(s, [{ venue: 'okx', sym: 'IRYS-USDT-SWAP', base: 'IRYS', st: stA }], T).length, 0);
  /* 下一小時 Bitget 也放量 → 通知（A） */
  const e = DM.pickWake(s, [{ venue: 'bitget', sym: 'IRYSUSDT', base: 'IRYS', st: stA }], T + H);
  assert.equal(e.length, 1);
  assert.equal(e[0].kind, 'A');
  assert.match(DM.wakeAlertText(e, T + H), /【沉睡甦醒】/);
  /* 同一天再放量 → 不重複 */
  assert.equal(DM.pickWake(s, [{ venue: 'okx', sym: 'IRYS-USDT-SWAP', base: 'IRYS', st: stA }, { venue: 'bitget', sym: 'IRYSUSDT', base: 'IRYS', st: stA }], T + 2 * H).length, 0);
  /* 兩家都 30 天新高量 → 升級 */
  const up = DM.pickWake(s, [{ venue: 'okx', sym: 'IRYS-USDT-SWAP', base: 'IRYS', st }, { venue: 'bitget', sym: 'IRYSUSDT', base: 'IRYS', st }], T + 3 * H);
  assert.equal(up.length, 1);
  assert.equal(up[0].kind, 'B');
  assert.equal(up[0].upgrade, true);
  assert.match(DM.wakeAlertText(up, T + 3 * H), /【30天新高量】【升級】/);
  /* 隔 2 小時才另一家 → 不算同時 */
  const s2 = DM.emptyDormant();
  DM.pickWake(s2, [{ venue: 'okx', sym: 'X-USDT-SWAP', base: 'X', st: stA }], T);
  assert.equal(DM.pickWake(s2, [], T + H).length, 0);
  assert.equal(DM.pickWake(s2, [{ venue: 'bitget', sym: 'XUSDT', base: 'X', st: stA }], T + 2 * H).length, 0);
  /* 一家 A、一家只有 B → 不通知（沒回測過） */
  const s3 = DM.emptyDormant();
  assert.equal(DM.pickWake(s3, [{ venue: 'okx', sym: 'Y-USDT-SWAP', base: 'Y', st: { ...st, kinds: ['A'] } }, { venue: 'bitget', sym: 'YUSDT', base: 'Y', st: { ...st, kinds: ['B'] } }], T).length, 0);
});

test('每日最高量：不算第一天與當天', () => {
  const b = bars();
  const m = DM.dayMaxes(b, T);
  assert.equal(m[DM.dayOf(T)], undefined);
  assert.equal(m[DM.dayOf(b[0].t)], undefined);
  assert.equal(Object.keys(m).length, 11);
});

test('狀態存取與本文上限', () => {
  const s = DM.emptyDormant();
  const leg = { sym: 'A-USDT-SWAP', t: T, qv: 5e4, xA: 20, xB: 1.2, c: 1, pos: -1, chg: 2, range: 20, hi: 1 };
  for (let i = 0; i < 3000; i++) s.events.push({ t: T, base: `S${i}`, kind: 'A', okx: leg, bitget: { ...leg, sym: 'AUSDT' }, price: 1 });
  const body = DM.dormantBody(s, { nowMs: T });
  assert.ok(body.length <= 60000);
  assert.equal(DM.extractDormant(body).events.length, 3000);
});

test('OI 紀錄：同一小時不重寫', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oi-'));
  const snap = { okx: { BTC: 1e9 }, bitget: { BTC: [9e8, 0.0001] } };
  assert.equal(appendOI(dir, T, snap), true);
  assert.equal(appendOI(dir, T, snap), false);
  assert.equal(appendOI(dir, T + H, snap), true);
  const f = fs.readFileSync(path.join(dir, '2026-10-21.jsonl'), 'utf8').trim().split('\n');
  assert.equal(f.length, 2);
  assert.deepEqual(JSON.parse(f[0]).bitget.BTC, [9e8, 0.0001]);
});
