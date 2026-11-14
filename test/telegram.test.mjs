import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as TT from '../src/telegram-topics.mjs';
import { prevMark as M } from '../src/tag.mjs';

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

/* ---- 上一則引用 ---- */
const idsFor = (d, obj) => { const f = path.join(d, 'msgids.json'); fs.writeFileSync(f, JSON.stringify(obj)); return f; };
const withIds = () => { let n = 100; return fakeTelegram((m, b) => (m === 'sendMessage' ? { ok: true, result: { message_id: ++n } } : { ok: true })); };
const hourlyOut = (out, texts) => texts.forEach((t, i) => fs.writeFileSync(path.join(out, `telegram-${i + 1}-hourly.txt`), t));
const H = 3600e3;
const closeAll = (...xs) => xs.forEach(x => x && x.server.close());

test('notify 上一則：發送後記下每個幣的 message_id；下一輪同話題同幣換成「上次」連結，整則同一個上一則就另外回覆', async () => {
  const { server, calls, url } = await withIds();
  try {
    const d = tmp(), idf = path.join(d, 'msgids.json'), logs = tmp();
    const env = { ...FAST, TELEGRAM_API: url, TELEGRAM_LOG_DIR: logs, TELEGRAM_MSGIDS_FILE: idf, TELEGRAM_TOPICS: JSON.stringify({ hourly: 7, cross: 9 }) };
    /* 第 1 輪：沒有上一則 → 沒有連結、沒有回覆、記號不外洩；記下 id */
    const o1 = tmp(); hourlyOut(o1, [`PEPE 爆量${M('PEPE')}\nBTC 爆量${M('BTC')}\nETH${M('ETH')}`, `XRP${M('XRP')}`]);
    let r = await run('src/notify.mjs', [o1], env);
    assert.equal(r.code, 0, r.err);
    assert.equal(calls[0].body.text, 'PEPE 爆量\nBTC 爆量\nETH');
    assert.equal(calls[0].body.reply_parameters, undefined);
    const ids = JSON.parse(fs.readFileSync(idf, 'utf8'));
    assert.equal(ids['hourly|PEPE'].id, 101);
    assert.equal(ids['hourly|PEPE'].th, 7);
    assert.equal(ids['hourly|ETH'].id, 101);
    assert.equal(ids['hourly|XRP'].id, 102);
    assert.equal(readLog(logs)[0].msgId, 101);
    /* 第 2 輪：各種組合（每則用不同的幣，避免同一輪內互相成為上一則） */
    calls.length = 0;
    const o2 = tmp(); hourlyOut(o2, [
      `PEPE 又爆量${M('PEPE')}`,                                     /* 單幣、有上一則 → 連結＋回覆 */
      `BTC${M('BTC')}\nETH${M('ETH')}`,                              /* 兩個幣上一則是同一則 → 連結＋回覆 */
      `XRP${M('XRP')}\nNEW${M('NEW')}`,                              /* 有個幣沒有上一則 → 只有連結、不回覆 */
      `沒有記號的訊息`
    ]);
    r = await run('src/notify.mjs', [o2], env);
    assert.equal(r.code, 0, r.err);
    const hm = ms => new Date(ms + 8 * H).toISOString().slice(11, 16);
    const lk = (id, t) => `<a href="https://t.me/c/123/7/${id}">${hm(t)}</a>`;
    assert.equal(calls[0].body.text, `PEPE 又爆量｜上次 ${lk(101, ids['hourly|PEPE'].t)}`);
    assert.deepEqual(calls[0].body.reply_parameters, { message_id: 101, allow_sending_without_reply: true });
    assert.equal(calls[1].body.text, `BTC｜上次 ${lk(101, ids['hourly|BTC'].t)}\nETH｜上次 ${lk(101, ids['hourly|ETH'].t)}`);
    assert.equal(calls[1].body.reply_parameters.message_id, 101);
    assert.equal(calls[2].body.text, `XRP｜上次 ${lk(102, ids['hourly|XRP'].t)}\nNEW`);
    assert.equal(calls[2].body.reply_parameters, undefined);
    assert.equal(calls[3].body.text, '沒有記號的訊息');
    /* 發送紀錄是實際送出的文字（純文字，連結只剩「上次 HH:MM」），並記回覆對象 */
    const l = readLog(logs).slice(-4);
    assert.match(l[0].text, /^PEPE 又爆量｜上次 \d\d:\d\d$/);
    assert.equal(l[0].replyTo, 101);
    assert.equal(l[2].replyTo, undefined);
    /* 最新的 id 取代舊的 */
    const ids2 = JSON.parse(fs.readFileSync(idf, 'utf8'));
    assert.equal(ids2['hourly|PEPE'].id, 103);
    assert.equal(ids2['hourly|BTC'].id, 104);
    assert.equal(ids2['hourly|NEW'].id, 105);
  } finally { server.close(); }
});

test('notify 上一則：話題各算各的、超過 24 小時不引用、上一則不同則時只放連結不回覆、不同話題代號不回覆', async () => {
  const { server, calls, url } = await withIds();
  const d = tmp(), now = Date.now();
  const idf = idsFor(d, {
    'hourly|OLD': { t: now - 25 * H, id: 50, th: 7 },
    'hourly|A': { t: now - 3 * H, id: 60, th: 7 },
    'hourly|B': { t: now - 2 * H, id: 61, th: 7 },
    'hourly|MOVED': { t: now - 2 * H, id: 62, th: 5 },
    'cross|PEPE': { t: now - 1 * H, id: 70, th: 9 },
    'general|X': { t: now - 1 * H, id: 71, th: 0 }
  });
  const env = { ...FAST, TELEGRAM_API: url, TELEGRAM_LOG_DIR: tmp(), TELEGRAM_MSGIDS_FILE: idf, TELEGRAM_TOPICS: JSON.stringify({ hourly: 7, cross: 9 }) };
  const o = tmp(); hourlyOut(o, [
    `OLD${M('OLD')}`,                          /* 25 小時前 → 當作第一次 */
    `A${M('A')}\nB${M('B')}`,                  /* 上一則不同則 → 兩個連結、不回覆 */
    `MOVED${M('MOVED')}`,                      /* 話題代號變了 → 連結照給，不回覆 */
    `PEPE${M('PEPE')}`                         /* PEPE 只在 cross 話題發過，hourly 話題沒有 */
  ]);
  const r = await run('src/notify.mjs', [o], env);
  assert.equal(r.code, 0, r.err);
  assert.equal(calls[0].body.text, 'OLD');
  assert.match(calls[1].body.text, /^A｜上次 <a href="https:\/\/t\.me\/c\/123\/7\/60">.*<\/a>\nB｜上次 <a href="https:\/\/t\.me\/c\/123\/7\/61">/);
  assert.equal(calls[1].body.reply_parameters, undefined);
  assert.match(calls[2].body.text, /^MOVED｜上次 <a href="https:\/\/t\.me\/c\/123\/5\/62">/);
  assert.equal(calls[2].body.reply_parameters, undefined);
  assert.equal(calls[3].body.text, 'PEPE');
  server.close();
});

test('notify 上一則：回覆被 Telegram 拒絕就不引用再送一次；紀錄壞掉或群組編號格式不符照常發送、記號不外洩', async () => {
  /* 回覆被拒 */
  const a = await fakeTelegram((m, b) => (b.reply_parameters ? { ok: false, status: 400, desc: 'Bad Request: message to be replied not found' } : { ok: true, result: { message_id: 200 } }));
  const d = tmp(), now = Date.now();
  const idf = idsFor(d, { 'hourly|A': { t: now - H, id: 60, th: 7 } });
  const o = tmp(); hourlyOut(o, [`A${M('A')}`]);
  let r = await run('src/notify.mjs', [o], { ...FAST, TELEGRAM_API: a.url, TELEGRAM_LOG_DIR: tmp(), TELEGRAM_MSGIDS_FILE: idf, TELEGRAM_TOPICS: '{"hourly":7}' });
  a.server.close();
  assert.equal(r.code, 0, r.err);
  assert.equal(a.calls.length, 2);
  assert.ok(a.calls[0].body.reply_parameters);
  assert.equal(a.calls[1].body.reply_parameters, undefined);
  assert.match(a.calls[1].body.text, /^A｜上次 <a href=/);
  /* 紀錄檔壞掉 */
  const b = await withIds();
  const bad = path.join(tmp(), 'msgids.json'); fs.writeFileSync(bad, '壞掉{');
  const o2 = tmp(); hourlyOut(o2, [`A${M('A')}`]);
  r = await run('src/notify.mjs', [o2], { ...FAST, TELEGRAM_API: b.url, TELEGRAM_LOG_DIR: tmp(), TELEGRAM_MSGIDS_FILE: bad });
  assert.equal(r.code, 0, r.err);
  assert.equal(b.calls[0].body.text, 'A');
  assert.equal(JSON.parse(fs.readFileSync(bad, 'utf8'))['hourly|A'].id, 101);   /* 壞掉的紀錄檔被重新寫成正確的 */
  /* 群組不是 -100 開頭：只放文字不放連結，仍可回覆 */
  const o3 = tmp(); hourlyOut(o3, [`A${M('A')}`]);
  r = await run('src/notify.mjs', [o3], { ...FAST, TELEGRAM_API: b.url, TELEGRAM_LOG_DIR: tmp(), TELEGRAM_MSGIDS_FILE: bad, TELEGRAM_CHAT_ID: '-555' });
  b.server.close();
  assert.match(b.calls[1].body.text, /^A｜上次 \d\d:\d\d$/);
  assert.equal(b.calls[1].body.text.includes('<a'), false);
  assert.equal(b.calls[1].body.reply_parameters.message_id, 101);
});

test('notify 上一則：發送失敗的訊息不記 id；跨日的上一則帶日期', async () => {
  const f = await flakyTelegram(() => ({ status: 403, json: { ok: false, description: 'Forbidden' } }));
  const d = tmp(), idf = path.join(d, 'msgids.json');
  const o = tmp(); hourlyOut(o, [`A${M('A')}`]);
  let r = await run('src/notify.mjs', [o], { ...FAST, TELEGRAM_API: f.url, TELEGRAM_LOG_DIR: tmp(), TELEGRAM_MSGIDS_FILE: idf });
  f.server.close();
  assert.equal(r.code, 1);
  assert.equal(fs.existsSync(idf), false);
  const g = await withIds();
  const now = Date.now();
  fs.writeFileSync(idf, JSON.stringify({ '|A': { t: now - 23 * H, id: 60, th: 0 } }));
  const o2 = tmp(); fs.writeFileSync(path.join(o2, 'telegram-1.txt'), `A${M('A')}`);
  r = await run('src/notify.mjs', [o2], { ...FAST, TELEGRAM_API: g.url, TELEGRAM_LOG_DIR: tmp(), TELEGRAM_MSGIDS_FILE: idf });
  g.server.close();
  const td = ms => new Date(ms + 8 * H).toISOString();
  const t = now - 23 * H, same = td(t).slice(0, 10) === td(Date.now()).slice(0, 10);
  assert.match(g.calls[0].body.text, same ? /上次 <a href="https:\/\/t\.me\/c\/123\/60">\d\d:\d\d<\/a>$/ : /上次 <a href="https:\/\/t\.me\/c\/123\/60">\d\d-\d\d \d\d:\d\d<\/a>$/);
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
