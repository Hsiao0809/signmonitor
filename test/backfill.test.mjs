import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as B from '../src/telegram-backfill.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bf-'));

function fakeTelegram(handler = () => ({})) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', d => { b += d; });
    req.on('end', () => {
      const body = JSON.parse(b || '{}');
      calls.push(body);
      const r = handler(body, calls) || {};
      res.writeHead(r.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.json || { ok: true, result: {} }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}
function run(args, env) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(ROOT, 'src/telegram-backfill.mjs'), ...args], { cwd: ROOT, env: { ...process.env, TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '-100123', TELEGRAM_BACKFILL_DELAY_MS: '0', ...env } });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    p.on('close', code => resolve({ code, out, err }));
  });
}
const rec = (time, part, text, extra = {}) => ({ time, run: '1', part, ok: true, text, ...extra });
const TOPIC_IDS = { quiet: 1, hourly: 2, pre: 3, dormant: 4, rate: 5, cross: 6, crossd: 7, daily: 8, layout: 9, events: 10, alert: 11 };

test('分類：依區塊標題；沒有標題的子區塊承接前一類；各類通知都認得', () => {
  const c = B.classifyBlock;
  assert.equal(c('【盤中推算】11-11 07:15 台灣時間\nSECZ'), 'pre');
  assert.equal(c('【預警】11-11 10:00'), 'pre');
  assert.equal(c('【盤中爆量】11-11 10:00'), 'hourly');
  assert.equal(c('【量增價平】11-11 23:00'), 'quiet');
  assert.equal(c('【沉睡甦醒】x'), 'dormant');
  assert.equal(c('【借幣利率飆高】x'), 'rate');
  assert.equal(c('【4H 金叉】x'), 'cross');
  assert.equal(c('【日線金叉】x'), 'crossd');
  assert.equal(c('訊號掃描台｜每日報告 11-11'), 'daily');
  assert.equal(c('新進觀察清單 8 檔（爆量 ≥ 2）'), 'daily');
  assert.equal(c('觀察清單：等待觸發 81｜持倉中 3'), 'daily');
  assert.equal(c('布局清單新進 13 檔'), 'layout');
  assert.equal(c('布局清單：今天沒有新的爆量'), 'layout');
  assert.equal(c('【觸發 做多】X'), 'events');
  assert.equal(c('【結算】X'), 'events');
  assert.equal(c('訊號掃描台｜每日掃描失敗 11-11'), 'alert');
  assert.equal(c('訊號掃描台｜日線金叉掃描失敗'), 'alert');
  assert.equal(c('【連續放量】【時段性】MRVL'), null);
  const r = B.splitRecord({ text: '【盤中爆量】a\n\n【連續放量】b\n\nhttps://x\n\n【量增價平】c\n\n子區塊' });
  assert.deepEqual(r.groups.map(g => g.k), ['hourly', 'quiet']);
  assert.equal(r.groups[0].text, '【盤中爆量】a\n\n【連續放量】b\n\nhttps://x');
  assert.equal(r.last, 'quiet');
});

test('分類：被切成多則的長訊息，後一則開頭承接同一輪前一則的類型；有 topic 欄位的直接用', () => {
  const recs = [
    rec('2026-11-11T10:00:00+08:00', 'telegram-1.txt', '【盤中爆量】a\n\n【連續放量】b'),
    rec('2026-11-11T10:00:01+08:00', 'telegram-2.txt', '後半段 c\n\n【預警】d'),
    rec('2026-11-11T11:00:00+08:00', 'telegram-1.txt', '沒有標題的開頭', { run: '2' }),
    rec('2026-11-11T12:00:00+08:00', 'telegram-1-cross.txt', '不看標題', { run: '3', topic: 'crossd' })
  ];
  const s = B.plan(recs, { sinceMs: 0 });
  assert.deepEqual(s.map(x => x.k), ['hourly', 'hourly', 'pre', null, 'crossd']);
  assert.match(s[0].text, /^【補發 11-11 10:00 台灣時間】\n【盤中爆量】a/);
  assert.match(s[1].text, /後半段 c/);
});

test('計畫：依原時間排序、只取範圍內與成功的、cutoff 之後的略過、過長會切開', () => {
  const recs = [
    rec('2026-11-11T12:00:00+08:00', 'telegram-1.txt', '【量增價平】晚', { run: 'b' }),
    rec('2026-11-11T09:00:00+08:00', 'telegram-1.txt', '【盤中爆量】早', { run: 'a' }),
    rec('2026-11-10T01:00:00+08:00', 'telegram-1.txt', '【盤中爆量】太舊', { run: 'c' }),
    rec('2026-11-11T10:00:00+08:00', 'telegram-1.txt', '【預警】失敗的', { run: 'd', ok: false }),
    rec('2026-11-11T13:00:00+08:00', 'telegram-1.txt', '【預警】cutoff 之後', { run: 'e' })
  ];
  const s = B.plan(recs, { sinceMs: Date.parse('2026-11-11T00:00:00+08:00'), cutoffMs: Date.parse('2026-11-11T13:00:00+08:00') });
  assert.deepEqual(s.map(x => x.text.split('\n')[1]), ['【盤中爆量】早', '【量增價平】晚']);
  const long = '【盤中爆量】' + Array.from({ length: 30 }, (_, i) => `標的${i} ` + 'x'.repeat(300)).join('\n\n');
  const s2 = B.plan([rec('2026-11-11T09:00:00+08:00', 'telegram-1.txt', long)], { sinceMs: 0 });
  assert.ok(s2.length > 1 && s2.every(x => x.text.length <= 4096));
});

function setup(records, topics = TOPIC_IDS) {
  const d = tmp(), logs = path.join(d, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, '2026-11-11.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const tf = path.join(d, 'topics.json'); fs.writeFileSync(tf, JSON.stringify(topics));
  return { d, args: ['--hours', '24', '--log-dir', logs, '--topics', tf, '--marker', path.join(d, 'marker.json')], marker: path.join(d, 'marker.json') };
}
const NOW = '2026-11-11T15:00:00+08:00';
const RECS = [
  rec('2026-11-11T07:15:00+08:00', 'telegram-1.txt', '【盤中推算】第 15 分\nSECZ［股票］只有 Bitget ★推算 10.4x'),
  rec('2026-11-11T08:01:00+08:00', 'telegram-1.txt', '【量增價平】08:00\n\n【盤中爆量】08:00\n\nSECZ［股票］Bitget ★7.1x', { run: '2' }),
  rec('2026-11-11T09:01:00+08:00', 'telegram-1.txt', '【4H 金叉】x', { run: '3' })
];

test('補發：依類型送進話題、靜音、標原時間、依序發送，完成後寫標記並拒絕重複補發', async () => {
  const { server, calls, url } = await fakeTelegram();
  const s = setup(RECS);
  let r = await run(s.args, { TELEGRAM_API: url, BACKFILL_NOW: NOW });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(calls.map(c => [c.message_thread_id, c.text.split('\n')[1].split('】')[0] + '】']), [[3, '【盤中推算】'], [1, '【量增價平】'], [2, '【盤中爆量】'], [6, '【4H 金叉】']]);
  assert.ok(calls.every(c => c.disable_notification === true && c.chat_id === '-100123' && c.parse_mode === undefined));
  assert.match(calls[0].text, /^【補發 11-11 07:15 台灣時間】/);
  const m = JSON.parse(fs.readFileSync(s.marker, 'utf8'));
  assert.equal(m.sent, 4);
  const before = calls.length;
  r = await run(s.args, { TELEGRAM_API: url, BACKFILL_NOW: NOW });
  assert.equal(r.code, 1);
  assert.match(r.err, /已經補發過/);
  assert.equal(calls.length, before);
  r = await run([...s.args, '--force'], { TELEGRAM_API: url, BACKFILL_NOW: NOW });
  assert.equal(r.code, 0);
  assert.equal(calls.length, before + 4);
  server.close();
});

test('補發：dry-run 不發送也不寫標記；cutoff 之後的略過；缺話題代號就中止不發', async () => {
  const { server, calls, url } = await fakeTelegram();
  const s = setup(RECS);
  let r = await run([...s.args, '--dry-run'], { TELEGRAM_API: url, BACKFILL_NOW: NOW });
  assert.equal(r.code, 0);
  assert.match(r.out, /共 4 則/);
  assert.equal(calls.length, 0);
  assert.ok(!fs.existsSync(s.marker));
  r = await run([...s.args, '--dry-run', '--cutoff', '2026-11-11T08:30:00+08:00'], { TELEGRAM_API: url, BACKFILL_NOW: NOW });
  assert.match(r.out, /共 3 則/);
  const noPre = setup(RECS, { ...TOPIC_IDS, pre: undefined });
  r = await run(noPre.args, { TELEGRAM_API: url, BACKFILL_NOW: NOW });
  assert.equal(r.code, 1);
  assert.match(r.err, /盤中預警/);
  assert.equal(calls.length, 0);
  server.close();
});

test('補發：429 會等 retry_after 後重試；其他錯誤中止並說明已補發幾則', async () => {
  let n = 0;
  const a = await fakeTelegram(() => (++n === 2 ? { status: 429, json: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 0 } } } : {}));
  const s = setup(RECS);
  let r = await run(s.args, { TELEGRAM_API: a.url, BACKFILL_NOW: NOW });
  a.server.close();
  assert.equal(r.code, 0, r.err);
  assert.equal(a.calls.length, 5);                                  /* 4 則 + 1 次重試 */
  let k = 0;
  const b = await fakeTelegram(() => (++k === 3 ? { status: 400, json: { ok: false, description: 'Bad Request: message thread not found' } } : {}));
  const s2 = setup(RECS);
  r = await run(s2.args, { TELEGRAM_API: b.url, BACKFILL_NOW: NOW });
  b.server.close();
  assert.equal(r.code, 1);
  assert.match(r.err, /第 3\/4 則補發失敗.*thread not found.*已補發 2 則/);
  assert.ok(!fs.existsSync(s2.marker));                             /* 沒補完不寫標記 */
});
