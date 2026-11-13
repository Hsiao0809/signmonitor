import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as TT from '../src/telegram-topics.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/* 本機假 Telegram：記下每個請求，依 handler 回應 */
function fakeTelegram(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', d => { b += d; });
    req.on('end', () => {
      const body = JSON.parse(b || '{}');
      const method = req.url.split('/').pop();
      calls.push({ method, body });
      const r = handler(method, body, calls) || { ok: true, result: {} };
      res.writeHead(r.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.json || (r.ok === false ? { ok: false, description: r.desc } : { ok: true, result: r.result })));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}
function run(script, args, env) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(ROOT, script), ...args], { cwd: ROOT, env: { ...process.env, TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '-100123', ...env } });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    p.on('close', code => resolve({ code, out, err }));
  });
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tg-'));

test('檔名：新格式帶類型、舊格式沒有類型、其他檔不算', () => {
  assert.deepEqual(TT.parseFileName(TT.fileName(3, 'cross')), { n: 3, key: 'cross' });
  assert.deepEqual(TT.parseFileName('telegram-7.txt'), { n: 7, key: null });
  assert.equal(TT.parseFileName('telegram-x.txt'), null);
  assert.equal(TT.parseFileName('comment.md'), null);
  Object.keys(TT.TOPICS).forEach(k => assert.match(k, /^[a-z]+$/));
});

test('同類型合併成一則、類型順序照第一次出現、空訊息略過', () => {
  const g = TT.groupByTopic([{ k: 'quiet', text: 'a' }, { k: 'cross', text: 'b' }, { k: 'alert', text: '' }, { k: 'quiet', text: 'c' }]);
  assert.deepEqual(g, [{ k: 'quiet', text: 'a\n\nc' }, { k: 'cross', text: 'b' }]);
});

test('話題設定：環境變數優先、只收已知類型與正整數、壞掉就全送 General', () => {
  const d = tmp(), f = path.join(d, 't.json');
  fs.writeFileSync(f, JSON.stringify({ quiet: 5, cross: '7', crossd: 0, nope: 9, rate: -2, pre: 1.5 }));
  assert.deepEqual(TT.loadTopics(f, {}), { quiet: 5, cross: 7 });
  assert.deepEqual(TT.loadTopics(f, { TELEGRAM_TOPICS: '{"daily": 12}' }), { daily: 12 });
  fs.writeFileSync(f, '壞掉');
  assert.deepEqual(TT.loadTopics(f, {}), {});
  assert.deepEqual(TT.loadTopics(path.join(d, '不存在.json'), {}), {});
});

test('notify：依類型送進話題；沒設定的與舊格式送 General；話題不見就退回 General 不漏發', async () => {
  const { server, calls, url } = await fakeTelegram((m, b) => (b.message_thread_id === 99 ? { ok: false, status: 400, desc: 'Bad Request: message thread not found' } : { ok: true }));
  const out = tmp(), logs = tmp();
  fs.writeFileSync(path.join(out, 'telegram-1-cross.txt'), '金叉訊息');
  fs.writeFileSync(path.join(out, 'telegram-2-quiet.txt'), '量增價平訊息');
  fs.writeFileSync(path.join(out, 'telegram-3.txt'), '舊格式訊息');
  fs.writeFileSync(path.join(out, 'telegram-10-pre.txt'), '預警訊息');
  fs.writeFileSync(path.join(out, 'telegram-4-alert.txt'), '   ');                 /* 空白不發 */
  const r = await run('src/notify.mjs', [out], { TELEGRAM_API: url, TELEGRAM_TOPICS: JSON.stringify({ cross: 11, pre: 99 }), TELEGRAM_LOG_DIR: logs, GITHUB_RUN_ID: '42' });
  server.close();
  assert.equal(r.code, 0, r.err);
  const sent = calls.map(c => ({ text: c.body.text, thread: c.body.message_thread_id ?? null }));
  assert.deepEqual(sent, [
    { text: '金叉訊息', thread: 11 },
    { text: '量增價平訊息', thread: null },
    { text: '舊格式訊息', thread: null },
    { text: '預警訊息', thread: 99 },            /* 序號 10 排在最後；話題 99 被拒 */
    { text: '預警訊息', thread: null }            /* 退回 General */
  ]);
  assert.match(r.err, /話題「pre」找不到/);
  const lines = fs.readdirSync(logs).flatMap(f => fs.readFileSync(path.join(logs, f), 'utf8').trim().split('\n').map(l => JSON.parse(l)));
  assert.equal(lines.length, 4);
  assert.deepEqual(lines.map(l => l.topic ?? null), ['cross', 'quiet', null, 'pre']);
  assert.equal(lines[3].fellBack, true);
  assert.ok(lines.every(l => l.ok));
  const raw = JSON.stringify(lines);                                              /* 紀錄不含 chat id、token、話題代號 */
  assert.ok(!raw.includes('-100123') && !raw.includes('thread') && !/"T"/.test(raw));
});

test('notify：HTML 被拒退純文字仍送進同一個話題；真的失敗會回傳失敗並留紀錄', async () => {
  let n = 0;
  const { server, calls, url } = await fakeTelegram((m, b) => { n++; return n === 1 ? { ok: false, status: 400, desc: "Bad Request: can't parse entities" } : { ok: true }; });
  const out = tmp(), logs = tmp();
  fs.writeFileSync(path.join(out, 'telegram-1-cross.txt'), '<a href="https://x">AAA</a> &lt;5');
  const r = await run('src/notify.mjs', [out], { TELEGRAM_API: url, TELEGRAM_TOPICS: '{"cross": 11}', TELEGRAM_LOG_DIR: logs });
  server.close();
  assert.equal(r.code, 0, r.err);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.message_thread_id, 11);
  assert.equal(calls[1].body.parse_mode, undefined);
  assert.equal(calls[1].body.text, 'AAA <5');

  const bad = await fakeTelegram(() => ({ ok: false, status: 403, desc: 'Forbidden: bot was kicked' }));
  const logs2 = tmp();
  const r2 = await run('src/notify.mjs', [out], { TELEGRAM_API: bad.url, TELEGRAM_TOPICS: '{}', TELEGRAM_LOG_DIR: logs2 });
  bad.server.close();
  assert.equal(r2.code, 1);
  const l = JSON.parse(fs.readFileSync(path.join(logs2, fs.readdirSync(logs2)[0]), 'utf8').trim());
  assert.equal(l.ok, false);
  assert.match(l.error, /403/);
});

/* 可以「斷線」「卡住」的假 Telegram：behave(text, n) 回傳 'ok'、'drop'（直接斷線）、'hang'（不回應）、{ status, json } */
function flakyTelegram(behave) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', d => { b += d; });
    req.on('end', () => {
      const body = JSON.parse(b || '{}');
      const n = calls.filter(c => c.text === body.text).length + 1;
      calls.push({ text: body.text });
      const act = behave(body.text, n);
      if (act === 'drop') return req.socket.destroy();
      if (act === 'hang') return;
      const a = act === 'ok' ? { status: 200, json: { ok: true, result: {} } } : act;
      res.writeHead(a.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(a.json));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}
const readLog = dir => fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8').trim().split('\n').map(JSON.parse);
const files3 = (out, texts) => texts.forEach((t, i) => fs.writeFileSync(path.join(out, `telegram-${i + 1}-quiet.txt`), t));
const FAST = { TELEGRAM_RETRY_MS: '10,10,10', TELEGRAM_TOPICS: '{}' };

test('notify：連線中斷會自動重試，重試成功就當作送出；紀錄留下重試次數', async () => {
  const { server, calls, url } = await flakyTelegram((t, n) => (n <= 2 ? 'drop' : 'ok'));
  const out = tmp(), logs = tmp();
  files3(out, ['AAA']);
  const r = await run('src/notify.mjs', [out], { ...FAST, TELEGRAM_API: url, TELEGRAM_LOG_DIR: logs });
  server.close();
  assert.equal(r.code, 0, r.err);
  assert.equal(calls.length, 3);
  assert.match(r.out, /重試 2 次後成功/);
  const l = readLog(logs);
  assert.equal(l.length, 1);
  assert.equal(l[0].ok, true);
  assert.equal(l[0].retries, 2);
});

test('notify：429 依 retry_after 重試；5xx 也重試', async () => {
  const a = await flakyTelegram((t, n) => (n === 1 ? { status: 429, json: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 0 } } } : 'ok'));
  const out = tmp(); files3(out, ['AAA']);
  let r = await run('src/notify.mjs', [out], { ...FAST, TELEGRAM_API: a.url, TELEGRAM_LOG_DIR: tmp() });
  a.server.close();
  assert.equal(r.code, 0, r.err);
  assert.equal(a.calls.length, 2);
  const b = await flakyTelegram((t, n) => (n === 1 ? { status: 502, json: { ok: false, description: 'Bad Gateway' } } : 'ok'));
  r = await run('src/notify.mjs', [out], { ...FAST, TELEGRAM_API: b.url, TELEGRAM_LOG_DIR: tmp() });
  b.server.close();
  assert.equal(r.code, 0, r.err);
  assert.equal(b.calls.length, 2);
});

test('notify：一則一直送不出去，後面的訊息照樣發；最後以失敗結束，失敗那則寫進紀錄', async () => {
  const { server, calls, url } = await flakyTelegram(t => (t === 'BAD' ? 'drop' : 'ok'));
  const out = tmp(), logs = tmp();
  files3(out, ['FIRST', 'BAD', 'LAST']);
  const r = await run('src/notify.mjs', [out], { ...FAST, TELEGRAM_API: url, TELEGRAM_LOG_DIR: logs });
  server.close();
  assert.equal(r.code, 1);
  assert.deepEqual(calls.map(c => c.text), ['FIRST', 'BAD', 'BAD', 'BAD', 'BAD', 'LAST']);   /* BAD 試 4 次（1＋重試 3） */
  assert.match(r.err, /1 則沒發出去/);
  const l = readLog(logs);
  assert.deepEqual(l.map(x => x.ok), [true, false, true]);
  assert.match(l[1].error, /^network:/);
  assert.equal(l[1].retries, 3);
  assert.equal(l[1].text, 'BAD');
});

test('notify：400／403 這類重試也沒用的錯誤不重試', async () => {
  const { server, calls, url } = await flakyTelegram(() => ({ status: 403, json: { ok: false, description: 'Forbidden: bot was kicked' } }));
  const out = tmp(); files3(out, ['AAA']);
  const r = await run('src/notify.mjs', [out], { ...FAST, TELEGRAM_API: url, TELEGRAM_LOG_DIR: tmp() });
  server.close();
  assert.equal(r.code, 1);
  assert.equal(calls.length, 1);
});

test('notify：伺服器卡住不回應會逾時並重試，不會讓整輪卡死', async () => {
  const { server, calls, url } = await flakyTelegram(() => 'hang');
  const out = tmp(), logs = tmp(); files3(out, ['AAA']);
  const r = await run('src/notify.mjs', [out], { ...FAST, TELEGRAM_RETRY_MS: '10', TELEGRAM_TIMEOUT_MS: '150', TELEGRAM_API: url, TELEGRAM_LOG_DIR: logs });
  server.closeAllConnections(); server.close();
  assert.equal(r.code, 1);
  assert.equal(calls.length, 2);
  assert.match(readLog(logs)[0].error, /^network:/);
});

test('notify：沒設定 token 或 chat id 就略過', async () => {
  const r = await run('src/notify.mjs', [tmp()], { TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' });
  assert.equal(r.code, 0);
  assert.match(r.out, /略過通知/);
});

test('setup-topics：為每種通知建立話題、寫進設定檔；再跑一次不重複建立；補建缺的', async () => {
  let id = 100;
  const { server, calls, url } = await fakeTelegram(m => (m === 'getChat' ? { ok: true, result: { is_forum: true } } : { ok: true, result: { message_thread_id: ++id } }));
  const f = path.join(tmp(), 'config', 'telegram-topics.json');
  let r = await run('src/setup-topics.mjs', [f], { TELEGRAM_API: url });
  assert.equal(r.code, 0, r.err);
  const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepEqual(Object.keys(cfg), Object.keys(TT.TOPICS));
  assert.equal(new Set(Object.values(cfg)).size, Object.keys(TT.TOPICS).length);
  assert.deepEqual(calls.filter(c => c.method === 'createForumTopic').map(c => c.body.name), Object.values(TT.TOPICS));
  const before = calls.length;
  r = await run('src/setup-topics.mjs', [f], { TELEGRAM_API: url });
  assert.equal(r.code, 0);
  assert.equal(calls.slice(before).filter(c => c.method === 'createForumTopic').length, 0);
  delete cfg.rate; fs.writeFileSync(f, JSON.stringify(cfg));
  r = await run('src/setup-topics.mjs', [f], { TELEGRAM_API: url });
  assert.equal(calls.slice(before).filter(c => c.method === 'createForumTopic').map(c => c.body.name).join(), '借幣利率');
  assert.ok(JSON.parse(fs.readFileSync(f, 'utf8')).rate > 0);
  server.close();
});

test('setup-topics：群組沒開話題、或沒有建立權限時，清楚失敗且不會寫壞設定檔', async () => {
  const a = await fakeTelegram(m => (m === 'getChat' ? { ok: true, result: { is_forum: false } } : { ok: true }));
  const f = path.join(tmp(), 't.json');
  let r = await run('src/setup-topics.mjs', [f], { TELEGRAM_API: a.url });
  a.server.close();
  assert.equal(r.code, 1);
  assert.match(r.err, /還沒開啟「話題」/);
  assert.ok(!fs.existsSync(f));
  let k = 0;
  const b = await fakeTelegram(m => (m === 'getChat' ? { ok: true, result: { is_forum: true } } : (++k <= 2 ? { ok: true, result: { message_thread_id: 500 + k } } : { ok: false, status: 400, desc: 'Bad Request: not enough rights to create a topic' })));
  r = await run('src/setup-topics.mjs', [f], { TELEGRAM_API: b.url });
  b.server.close();
  assert.equal(r.code, 1);
  assert.match(r.err, /管理話題/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { quiet: 501, hourly: 502 });   /* 已建立的保留，下次補建 */
});
