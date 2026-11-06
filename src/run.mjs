#!/usr/bin/env node
/* ============================================================
   signmonitor：每 4 小時執行一次（GitHub Actions 排程，獨立於其他系統）
     node src/run.mjs --body issue-body.md --layout-body layout-body.md \
       --bybit-cache .cache/bybit-daily.json --out out/ [--daily auto|force|skip]
   短線清單：讀取 Issue 狀態 →（每日一次）OKX 全市場爆量 → 每 4 小時用 4H 收盤推進
   布局清單：每日一次，OKX／Bitget／Bybit 三家分開算量 → 追蹤 60 天
   寫出兩個 Issue 本文、留言與 Telegram 訊息檔。
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import * as core from './core.mjs';
import * as T from './tracker.mjs';
import * as Lay from './layout.mjs';
import * as LS from './layout-scan.mjs';

T.setPatternScan(core.patternScan);
const CFG = T.CONFIG;

function args(argv) {
  const o = { daily: 'auto' };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    o[k] = argv[i + 1]; i++;
  }
  return o;
}

async function listWithFallback(warnings) {
  for (const ex of CFG.exchanges) {
    try {
      const list = await core.EXCHANGES[ex].list();
      if (list.length) return { ex, list };
      warnings.push(`${core.EXCHANGES[ex].label} 合約清單為空`);
    } catch (e) {
      warnings.push(`${core.EXCHANGES[ex].label} 無法取得合約清單（${e.message}）`);
    }
  }
  throw new Error('所有交易所都無法取得合約清單');
}

async function dailyScan(state, nowMs, warnings) {
  const { ex, list } = await listWithFallback(warnings);
  const E = core.EXCHANGES[ex];
  const syms = list.filter(m => !T.isExcluded(m.base, CFG) && m.qv24h >= (CFG.liqFloor[m.cat] ?? CFG.liqFloor.crypto));
  const cands = [], scanned = [];
  let fail = 0, error = 0;
  await core.pool(syms, E.conc, async m => {
    const k = await E.kl(m.id, '1d', 0, 120);
    if (!k) { fail++; error++; return; }
    if (k.length < 70) { fail++; return; }          /* 新上市，日線不足 */
    scanned.push(m);
    const c = T.candidateFrom(m, k, ex, nowMs, CFG);
    if (c) cands.push(c);
  });
  if (error / Math.max(1, syms.length) > 0.3) {
    throw new Error(`${E.label} 日線取得失敗率過高（${error}/${syms.length}），今天不更新清單`);
  }
  const universe = {
    total: scanned.length,
    crypto: scanned.filter(x => x.cat === 'crypto').length,
    stock: scanned.filter(x => x.cat === 'stock').length,
    comm: scanned.filter(x => x.cat === 'comm').length
  };
  const added = T.mergeCandidates(state, cands, CFG);

  let rally = [];
  try {
    const r = await core.scanRally(ex, () => {});
    rally = r.rows.filter(x => !T.isExcluded(x.base, CFG)).slice(0, CFG.rallyTop);
  } catch (e) {
    warnings.push(`起漲分數掃描失敗（${e.message}）`);
  }
  return { ex, exLabel: E.label, universe, added, rally };
}

function splitMessages(text, limit = 3900) {
  if (!text) return [];
  const out = [];
  let cur = '';
  for (const block of text.split('\n\n')) {
    const add = cur ? `${cur}\n\n${block}` : block;
    if (add.length <= limit) { cur = add; continue; }
    if (cur) out.push(cur);
    cur = block.length <= limit ? block : block.slice(0, limit);
  }
  if (cur) out.push(cur);
  return out;
}

async function main() {
  const a = args(process.argv);
  const outDir = a.out || 'out';
  fs.mkdirSync(outDir, { recursive: true });
  const nowMs = a.now ? Date.parse(a.now) : Date.now();
  const issueUrl = a['issue-url'] || '';
  const body = a.body && fs.existsSync(a.body) ? fs.readFileSync(a.body, 'utf8') : '';
  const state = T.extractState(body);
  if (!state) throw new Error('Issue 本文裡的狀態無法解析；為避免覆蓋清單，本輪停止');
  const warnings = [];

  const today = T.tpe(nowMs, false);
  const doDaily = a.daily === 'force'
    || (a.daily === 'auto' && state.lastDaily !== today && T.tpeHour(nowMs) >= CFG.dailyHourTPE);

  let daily = null;
  if (doDaily) {
    try {
      daily = await dailyScan(state, nowMs, warnings);
      state.lastDaily = today;
    } catch (e) {
      warnings.push(`每日掃描失敗：${e.message}`);
    }
  }

  /* ---------- 布局清單（三家，每日一次） ---------- */
  let layout = null;
  const layoutBody = a['layout-body'] && fs.existsSync(a['layout-body']) ? fs.readFileSync(a['layout-body'], 'utf8') : '';
  const lstate = Lay.extractLayout(layoutBody);
  if (!lstate) throw new Error('布局清單 Issue 的狀態無法解析；為避免覆蓋，本輪停止');
  const lday = new Date(nowMs - 864e5).toISOString().slice(0, 10);
  const doLayout = a.daily === 'force'
    || (a.daily === 'auto' && lstate.lastDay !== lday && T.tpeHour(nowMs) >= CFG.dailyHourTPE);
  if (doLayout) {
    try {
      const r = await LS.collect(lstate, nowMs, a['bybit-cache'] || '.cache/bybit-daily.json');
      if (r.ready) {
        Lay.updateMarket(lstate, r.refSeries);
        const levents = Lay.advanceLayout(lstate, r.refBarsOf, nowMs);
        const added = Lay.mergeLayout(lstate, r.candidates);
        lstate.lastDay = r.day;
        layout = { added, events: levents, warnings: r.warnings, counts: r.counts, day: r.day };
      } else {
        console.log(`layout: Bybit ${r.day} 成交檔尚未公布，下一輪再試`);
      }
    } catch (e) {
      warnings.push(`布局清單掃描失敗：${e.message}`);
    }
  }
  if (layout) {
    const note = `資料日 ${layout.day}（UTC 日線）：OKX ${layout.counts.okx} 檔、Bitget ${layout.counts.bitget} 檔、Bybit ${layout.counts.bybit} 檔，新進 ${layout.added.length} 檔`;
    fs.writeFileSync(path.join(outDir, 'layout-body.md'),
      Lay.embedLayout(Lay.layoutMarkdown(lstate, { nowMs, warnings: layout.warnings, note }), lstate));
  }

  const fetch4h = item => core.EXCHANGES[item.ex].kl(item.id, '4h', 0, 120);
  const { events, warnings: w2 } = await T.advanceAll(state, fetch4h, nowMs, CFG);
  warnings.push(...w2);

  const note = daily
    ? `每日掃描：${T.tpe(nowMs)} 台灣時間，${daily.exLabel}，${daily.universe.total} 檔，新進 ${daily.added.length} 檔`
    : (state.lastDaily ? `最近一次每日掃描：${state.lastDaily}` : '');
  let rowsLimit = Infinity, out;
  for (;;) {
    out = T.embedState(T.issueMarkdown(state, { nowMs, warnings, lastDailyNote: note, pendingRows: rowsLimit }, CFG), state);
    if (out.length <= T.BODY_LIMIT || rowsLimit === 0) break;
    rowsLimit = rowsLimit === Infinity ? 80 : Math.floor(rowsLimit / 2);
  }
  fs.writeFileSync(path.join(outDir, 'issue-body.md'), out);

  const msgs = [];
  if (daily) msgs.push(T.dailyText({ nowMs, ...daily, state, issueUrl, warnings }, CFG));
  if (layout) msgs.push(Lay.layoutDailyText(layout.added, layout.events, lstate) + (a['layout-url'] ? `\n${a['layout-url']}` : ''));
  else if (doDaily) msgs.push(`訊號掃描台｜每日掃描失敗 ${T.tpe(nowMs)} 台灣時間\n${warnings.filter(w => w.startsWith('每日')).join('\n')}`);
  const ev = T.hourlyText(events, daily ? '' : issueUrl, CFG);
  if (ev) msgs.push(ev);
  splitMessages(msgs.join('\n\n')).forEach((m, i) => fs.writeFileSync(path.join(outDir, `telegram-${i + 1}.txt`), m));

  const comment = [];
  if (daily) comment.push(`## 每日掃描 ${T.tpe(nowMs)} 台灣時間\n\n${'```'}\n${msgs[0]}\n${'```'}`);
  if (events.length) comment.push(`## 狀態變化 ${T.tpe(nowMs)} 台灣時間\n\n${events.map(e => '- ' + T.eventText(e, CFG).replace(/\n/g, '\n  ')).join('\n')}`);
  if (comment.length) fs.writeFileSync(path.join(outDir, 'comment.md'), comment.join('\n\n'));
  if (layout) fs.writeFileSync(path.join(outDir, 'layout-comment.md'),
    `## 布局清單 ${T.tpe(nowMs)} 台灣時間\n\n${'```'}\n${Lay.layoutDailyText(layout.added, layout.events, lstate)}\n${'```'}`);

  const summary = [
    `daily=${doDaily ? (daily ? 'ok' : 'failed') : 'skip'}`,
    `pending=${state.pending.length} open=${state.open.length} closed=${state.closed.length}`,
    `layout=${layout ? `ok active=${lstate.active.length} added=${layout.added.length}` : (doLayout ? 'deferred' : 'skip')}`,
    `events=${events.length} warnings=${warnings.length}`
  ].join(' ');
  console.log(summary);
  warnings.forEach(w => console.log('warning:', w));
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
