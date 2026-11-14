import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../cloudflare/trigger-worker.js';

/* 以假的 fetch 模擬三家交易所；handlers 依網址決定回應 */
async function check(sym, handler) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(String(url), init || {});
  try {
    const r = await worker.fetch(new Request(`https://x.test/api/check?s=${sym}`), {}, { waitUntil() {} });
    return await r.json();
  } finally { globalThis.fetch = real; }
}
const ok = body => new Response(JSON.stringify(body), { status: 200 });
const st = code => new Response('', { status: code });
const bitgetHas = u => u.includes('api.bitget.com') && u.includes('symbol=UNITASUSDT');

test('只有 Bitget 有合約：OKX 空、Bybit 404 → 只列 Bitget，沒有失敗', async () => {
  const j = await check('UNITAS', u => {
    if (u.includes('okx.com')) return ok({ code: '51001', data: [] });
    if (u.includes('api.bitget.com')) return bitgetHas(u) ? ok({ data: [{ symbol: 'UNITASUSDT' }] }) : st(400);
    return st(404);
  });
  assert.deepEqual(j.venues, { bitget: 'UNITASUSDT' });
  assert.deepEqual(j.failed, []);
});

test('Bitget 查詢失敗（403）→ 不算找不到，回報 failed 讓頁面顯示重試', async () => {
  const j = await check('UNITAS', u => {
    if (u.includes('okx.com')) return ok({ code: '51001', data: [] });
    if (u.includes('api.bitget.com')) return st(403);
    return st(404);
  });
  assert.deepEqual(j.venues, {});
  assert.deepEqual(j.failed, ['Bitget']);
});

test('第一次失敗、重試成功 → 正常列出', async () => {
  let n = 0;
  const j = await check('UNITAS', u => {
    if (u.includes('okx.com')) return ok({ code: '51001', data: [] });
    if (bitgetHas(u)) { n++; return n === 1 ? st(429) : ok({ data: [{ symbol: 'UNITASUSDT' }] }); }
    if (u.includes('api.bitget.com')) return st(400);
    return st(404);
  });
  assert.deepEqual(j.venues, { bitget: 'UNITASUSDT' });
  assert.deepEqual(j.failed, []);
});

test('三家都確定沒有 → venues 空、failed 空（才是真的找不到合約）', async () => {
  const j = await check('NOSUCH', u => {
    if (u.includes('okx.com')) return ok({ code: '51001', data: [] });
    if (u.includes('api.bitget.com')) return st(400);
    return st(404);
  });
  assert.deepEqual(j.venues, {});
  assert.deepEqual(j.failed, []);
});

test('網路錯誤也算失敗，不是找不到', async () => {
  const j = await check('UNITAS', u => { if (u.includes('okx.com')) return ok({ data: [{}] }); throw new Error('boom'); });
  assert.equal(j.venues.okx, 'UNITAS-USDT-SWAP');
  assert.deepEqual(j.failed.sort(), ['Bitget', 'Bybit']);
});
