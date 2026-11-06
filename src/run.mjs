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
import * as V from './venues.mjs';
import * as HR from './hourly.mjs';
import * as HS from './hourly-scan.mjs';

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
  const startMs = a.now ? Date.parse(a.now) : Date.now();
  const issueUrl = a['issue-url'] || '';
  const cachePath = a['bybit-cache'] || '.cache/bybit-daily.json';
  const cache = HS.loadCache(cachePath);

  /* ---------- 盤中爆量：整點前先準備、連上 Bybit WebSocket，等整點收盤 ---------- */
  const hourlyBody = a['hourly-body'] && fs.existsSync(a['hourly-body']) ? fs.readFileSync(a['hourly-body'], 'utf8') : '';
  const hstate = HR.extractHourly(hourlyBody);
  if (!hstate) throw new Error('盤中爆量 Issue 的狀態無法解析；為避免覆蓋，本輪停止');
  const HOUR = 3600e3;
  const preClose = new Date(startMs).getUTCMinutes() >= 40;        /* 排程在 :50 啟動；晚到整點後就評估上一小時 */
  const targetHour = preClose ? Math.floor(startMs / HOUR) * HOUR : Math.floor(startMs / HOUR) * HOUR - HOUR;
  const doHourly = !a.now && a.hourly !== 'skip' && hstate.lastHour !== targetHour;
  const hw = [];
  let prep = null, capP = Promise.resolve({});
  if (doHourly) {
    try { prep = await HS.prepare(cache, hw); } catch (e) { hw.push(`盤中爆量準備失敗：${e.message}`); }
    if (prep && preClose) capP = V.bybitCaptureHour(prep.bybit.map(x => x.sym), targetHour);
    if (prep) { try { await HS.ensureBybitBaseline(cache, prep.bybit, prep.refPrice, startMs); } catch (e) { hw.push(`Bybit 每小時基準更新失敗：${e.message}`); } }
    if (preClose) await new Promise(r => setTimeout(r, Math.max(0, targetHour + HOUR + 20e3 - Date.now())));
  }
  const captured = await capP;
  const nowMs = a.now ? startMs : Date.now();
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
      const r = await LS.collect(lstate, nowMs, cache);
      if (r.ready) {
        /* 舊的清單項目補上各交易所代號（TradingView 連結用） */
        lstate.active.forEach(it => { if (!it.syms || !Object.keys(it.syms).length) it.syms = r.symsOf(it.base) || {}; });
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
      Lay.embedLayout(T.render(Lay.layoutMarkdown(lstate, { nowMs, warnings: layout.warnings, note }), 'md'), lstate));
  }

  const fetch4h = item => core.EXCHANGES[item.ex].kl(item.id, '4h', 0, 120);
  const { events, warnings: w2 } = await T.advanceAll(state, fetch4h, nowMs, CFG);
  warnings.push(...w2);

  const note = daily
    ? `每日掃描：${T.tpe(nowMs)} 台灣時間，${daily.exLabel}，${daily.universe.total} 檔，新進 ${daily.added.length} 檔`
    : (state.lastDaily ? `最近一次每日掃描：${state.lastDaily}` : '');
  let rowsLimit = Infinity, out;
  for (;;) {
    out = T.embedState(T.render(T.issueMarkdown(state, { nowMs, warnings, lastDailyNote: note, pendingRows: rowsLimit }, CFG), 'md'), state);
    if (out.length <= T.BODY_LIMIT || rowsLimit === 0) break;
    rowsLimit = rowsLimit === Infinity ? 80 : Math.floor(rowsLimit / 2);
  }
  fs.writeFileSync(path.join(outDir, 'issue-body.md'), out);

  /* ---------- 盤中爆量：整點收盤後判斷 ---------- */
  let halerts = [];
  if (prep) {
    try {
      HS.rememberCaptured(cache, captured, nowMs);
      const entries = await HS.collectEntries(prep, cache, captured, targetHour, hw);
      halerts = HR.pickAlerts(hstate, entries, targetHour);
      const cnt = v => entries.filter(e => e.venue === v).length;
      const hnote = `最近一次檢查：${T.tpe(targetHour)}–${T.tpe(targetHour + HOUR).slice(11)} 台灣時間這根 1H K；OKX ${cnt('okx')} 檔、Bitget ${cnt('bitget')} 檔、Bybit ${cnt('bybit')} 檔，本小時 ${halerts.length} 檔`;
      fs.writeFileSync(path.join(outDir, 'hourly-body.md'), HR.embedHourly(T.render(HR.hourlyMarkdown(hstate, { nowMs, warnings: hw, note: hnote }), 'md'), hstate));
      if (halerts.length) fs.writeFileSync(path.join(outDir, 'hourly-comment.md'), T.render(HR.hourlyAlertText(halerts, targetHour, hw), 'md').replace(/\n/g, '  \n'));
    } catch (e) { hw.push(`盤中爆量判斷失敗：${e.message}`); }
  }
  HS.saveCache(cachePath, cache);

  const msgs = [];
  const hmsg = HR.hourlyAlertText(halerts, targetHour, [], a['hourly-url'] || '');
  if (hmsg) msgs.push(hmsg);
  const dailyMsg = daily ? T.dailyText({ nowMs, ...daily, state, issueUrl, warnings }, CFG) : '';
  if (dailyMsg) msgs.push(dailyMsg);
  if (layout) msgs.push(Lay.layoutDailyText(layout.added, layout.events, lstate) + (a['layout-url'] ? `\n${a['layout-url']}` : ''));
  else if (doDaily) msgs.push(`訊號掃描台｜每日掃描失敗 ${T.tpe(nowMs)} 台灣時間\n${warnings.filter(w => w.startsWith('每日')).join('\n')}`);
  const ev = T.hourlyText(events, daily ? '' : issueUrl, CFG);
  if (ev) msgs.push(ev);
  /* Telegram 以 HTML 格式發送，標的名稱可直接點開 TradingView；先切段再轉換，避免標籤被切斷 */
  splitMessages(msgs.join('\n\n'), 3500).forEach((m, i) => fs.writeFileSync(path.join(outDir, `telegram-${i + 1}.txt`), T.render(m, 'html')));

  const comment = [];
  const mdLines = t => T.render(t, 'md').replace(/\n/g, '  \n');
  if (daily) comment.push(`## 每日掃描 ${T.tpe(nowMs)} 台灣時間\n\n${mdLines(dailyMsg)}`);
  if (events.length) comment.push(`## 狀態變化 ${T.tpe(nowMs)} 台灣時間\n\n${events.map(e => '- ' + T.render(T.eventText(e, CFG), 'md').replace(/\n/g, '  \n  ')).join('\n')}`);
  if (comment.length) fs.writeFileSync(path.join(outDir, 'comment.md'), comment.join('\n\n'));
  if (layout) fs.writeFileSync(path.join(outDir, 'layout-comment.md'),
    `## 布局清單 ${T.tpe(nowMs)} 台灣時間\n\n${mdLines(Lay.layoutDailyText(layout.added, layout.events, lstate))}`);

  const summary = [
    `daily=${doDaily ? (daily ? 'ok' : 'failed') : 'skip'}`,
    `pending=${state.pending.length} open=${state.open.length} closed=${state.closed.length}`,
    `layout=${layout ? `ok active=${lstate.active.length} added=${layout.added.length}` : (doLayout ? 'deferred' : 'skip')}`,
    `events=${events.length} warnings=${warnings.length}`,
    `hourly=${prep ? `${T.tpe(targetHour)} alerts=${halerts.length} bybitCaptured=${Object.values(captured).filter(x => x.confirm).length}` : (doHourly ? 'failed' : 'skip')}`
  ].join(' ');
  console.log(summary);
  [...warnings, ...hw].forEach(w => console.log('warning:', w));
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
