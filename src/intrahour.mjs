#!/usr/bin/env node
/* ============================================================
   盤中推算：每小時第 15、30、45 分執行（Cloudflare Worker 觸發 Monitor workflow，mode=intrahour）
     node src/intrahour.mjs --hourly-body hourly-body.md --pre-body pre-body.md --watch-body watch-body.md --out out
   OKX、Bitget 進行中的 1H K：已成交量換算整根量，達正式爆量門檻就推播。
   只寫「盤中預警」Issue；「盤中爆量」Issue 只讀（取正式爆量的去重紀錄）。
   ============================================================ */
import { fileName } from './telegram-topics.mjs';
import fs from 'node:fs';
import path from 'node:path';
import * as V from './venues.mjs';
import * as HR from './hourly.mjs';
import * as HS from './hourly-scan.mjs';
import * as E from './early.mjs';
import { parseWatch } from './watch.mjs';
import { tpe, render } from './tracker.mjs';

function args(argv) {
  const o = {};
  for (let i = 2; i < argv.length; i++) { o[argv[i].replace(/^--/, '')] = argv[i + 1]; i++; }
  return o;
}
const read = f => (f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
const H = 3600e3;

async function main() {
  const a = args(process.argv);
  const outDir = a.out || 'out';
  fs.mkdirSync(outDir, { recursive: true });
  const nowMs = a.now ? Date.parse(a.now) : Date.now();
  const minute = a.minute ? +a.minute : E.slotOf(nowMs);
  if (!minute) { console.log(`intrahour: 第 ${Math.floor((nowMs % H) / 60e3)} 分，不在推算時段，略過`); return; }
  const T = Math.floor(nowMs / H) * H;

  const pstate = E.extractPre(read(a['pre-body']));
  if (!pstate) throw new Error('盤中預警 Issue 的狀態無法解析；為避免覆蓋，本輪停止');
  if (pstate.lastSlot === `${T}:${minute}`) { console.log(`intrahour: ${tpe(T)} 第 ${minute} 分已推算過，略過`); return; }
  const hstate = HR.extractHourly(read(a['hourly-body'])) || HR.emptyHourly();
  const watch = parseWatch(read(a['watch-body']));

  const warnings = [];
  const prep = await HS.prepare({ notStock: [], days: {}, hours: {} }, warnings, watch, { bybit: false });
  const entries = [];
  for (const ex of ['okx', 'bitget']) {
    let fail = 0;
    await V.poolMap(prep[ex], 8, async x => {
      const r = await V.VENUES[ex].hourlyLive(x.sym);
      if (!r || !r.bars.length) { fail++; return; }
      if (!r.live || r.live.t !== T) return;
      const st = E.earlyStats(r.bars, r.live, r.at, x.cat);
      if (st) entries.push({ ...x, stats: st });
    });
    if (fail > prep[ex].length * 0.3) warnings.push(`${V.VENUES[ex].label} 有 ${fail}/${prep[ex].length} 檔 1H K 取得失敗`);
  }
  const alerts = E.pickEarly(pstate, hstate, entries, T, minute);
  const cnt = v => entries.filter(e => e.venue === v).length;
  const note = `最近一次盤中推算：${tpe(T)}–${tpe(T + H).slice(11)} 台灣時間這根 1H K 第 ${minute} 分；OKX ${cnt('okx')} 檔、Bitget ${cnt('bitget')} 檔，本輪 ${alerts.length} 檔`;
  fs.writeFileSync(path.join(outDir, 'pre-body.md'), E.preBody(pstate, { nowMs, warnings, note }, t => render(t, 'md')));
  const pushed = alerts.filter(x => !x.moved);
  const msg = E.earlyAlertText([...HR.mergeByBase(pushed), ...alerts.filter(x => x.moved)], T, minute, a['pre-url'] || '');
  if (msg) fs.writeFileSync(path.join(outDir, fileName(1, 'pre')), render(msg, 'html'));
  console.log(`intrahour=${tpe(T)}+${minute}m entries=${entries.length} alerts=${alerts.length} pushed=${pushed.length}`);
  warnings.forEach(w => console.log('warning:', w));
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
