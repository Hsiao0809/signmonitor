#!/usr/bin/env node
/* ============================================================
   signmonitor：每小時執行一次（GitHub Actions 排程，獨立於其他系統）
     node src/run.mjs --body issue-body.md --layout-body layout-body.md \
       --bybit-cache .cache/bybit-daily.json --out out/ [--daily auto|force|skip]
   短線清單：讀取 Issue 狀態 →（每日一次）OKX 全市場爆量 → 每 4 小時用 4H 收盤推進
   布局清單：每日一次，OKX／Bitget／Bybit 三家分開算量 → 追蹤 60 天
   4H 金叉：每根 4H K 收盤後，Binance 現貨 EMA20 上穿 SMA30（A 級推播、追蹤 42 根）
   掃流動性：每根 4H K 收盤後，短線／布局／自選標的的影線掃價位再收回（只標記，不推播）
   寫出各 Issue 本文、留言與 Telegram 訊息檔。
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
import * as EA from './early.mjs';
import * as DM from './dormant.mjs';
import * as DS from './dormant-scan.mjs';
import * as OI from './oi.mjs';
import { parseWatch } from './watch.mjs';
import * as CR from './cross.mjs';
import * as CS from './cross-scan.mjs';
import * as SN from './snapshot.mjs';
import * as Q from './quiet.mjs';
import { getJSON } from './venues.mjs';
import * as SW from './sweep.mjs';
import * as SWS from './sweep-scan.mjs';

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
  const watch = parseWatch(a['watch-body'] && fs.existsSync(a['watch-body']) ? fs.readFileSync(a['watch-body'], 'utf8') : '');
  if (doHourly) {
    if (watch.length) console.log(`watch: ${watch.join(',')}`);
    try { prep = await HS.prepare(cache, hw, watch); } catch (e) { hw.push(`盤中爆量準備失敗：${e.message}`); }
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

  /* 抓過的 4H K 留著，掃流動性直接沿用 */
  const bars4h = new Map();
  const fetch4h = async item => {
    const b = await core.EXCHANGES[item.ex].kl(item.id, '4h', 0, SW.SWEEP.barsShort);
    if (b) bars4h.set(`${item.ex}:${item.id}`, b);
    return b;
  };
  const { events, warnings: w2 } = await T.advanceAll(state, fetch4h, nowMs, CFG);
  warnings.push(...w2);

  /* ---------- 掃流動性：每根 4H K 收盤後一次；只標記、不推播，失敗只影響這一塊 ---------- */
  let sweep = null;
  const sweepBody = a['sweep-body'] && fs.existsSync(a['sweep-body']) ? fs.readFileSync(a['sweep-body'], 'utf8') : '';
  const swstate = a.sweep === 'skip' ? null : SW.extractSweep(sweepBody);
  if (a.sweep !== 'skip' && !swstate) console.log('sweep warning: 掃流動性 Issue 的狀態無法解析；為避免覆蓋，本輪略過');
  const swBar = SW.barOpen(nowMs);
  if (swstate && (swstate.lastBar !== swBar || a.sweep === 'force')) {
    const sww = [], skipped = [];
    try {
      const list = await SWS.targets({ short: state, layout: lstate, watch }, sww, null, skipped);
      const results = await SWS.collect(list, (ex, id) => bars4h.get(`${ex}:${id}`) || null, sww, skipped);
      const before = new Set(swstate.events.map(e => `${e.base}|${e.t}|${e.side}`));
      SW.apply(swstate, results, swBar, nowMs);
      const added = swstate.events.filter(e => !before.has(`${e.base}|${e.t}|${e.side}`)).length;
      const snote = `最近一次檢查：${T.tpe(swBar)}–${T.tpe(swBar + 4 * HOUR).slice(11)} 台灣時間這根 4H K；${results.length} 檔（K 線失敗 ${sww.filter(w => w.includes("K 線取得失敗")).length}），本輪新增 ${added} 筆${skipped.length ? `。略過：${skipped.join('、')}` : ''}`;
      fs.writeFileSync(path.join(outDir, 'sweep-body.md'), SW.embedSweep(SW.sweepMarkdown(swstate, { nowMs, warnings: sww, note: snote }), swstate));
      sweep = { n: results.length, events: swstate.events.length, added };
    } catch (e) { sww.push(`掃流動性失敗：${e.message}`); }
    sww.forEach(w => console.log('sweep warning:', w));
  }

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

  /* ---------- 4H 金叉（Binance 現貨）：每根 4H K 收盤後一次；失敗只影響這一塊 ---------- */
  let cross = null;
  const crossBody = a['cross-body'] && fs.existsSync(a['cross-body']) ? fs.readFileSync(a['cross-body'], 'utf8') : '';
  const cstate = a.cross === 'skip' ? null : CR.extractCross(crossBody);
  if (a.cross !== 'skip' && !cstate) warnings.push('金叉清單 Issue 的狀態無法解析；為避免覆蓋，本輪略過金叉');
  if (cstate) {
    const cw = [];
    try {
      const r = await CS.scan(cstate, nowMs);
      if (r.ran) {
        cw.push(...r.warnings);
        const res = CR.applyScan(cstate, r.found, r.latestT, nowMs);
        cstate.active = cstate.active.map(it => (it.bars === 0 && r.barsOf(it.sym) ? CR.trackItem(it, r.barsOf(it.sym)) : it));
        CR.sortActive(cstate);
        cstate.failBar = null;
        cross = { ...res, latestT: r.latestT, universe: r.universe };
      }
    } catch (e) {
      cw.push(`金叉掃描失敗：${e.message}`);
      const bar = CR.barOpen(nowMs);
      if (cstate.failBar !== bar) { cstate.failBar = bar; cross = { failed: e.message, latestT: bar }; }
    }
    if (cross) {
      const cnote = cross.failed
        ? `本輪掃描失敗（${cross.failed}），下一個整點重試`
        : `最近一次檢查：${T.tpe(cross.latestT)}–${T.tpe(cross.latestT + 4 * HOUR).slice(11)} 台灣時間這根 4H K；${cross.universe} 檔，A 級 ${cross.newA.length}、B 級 ${cross.newB.length}`;
      fs.writeFileSync(path.join(outDir, 'cross-body.md'), CR.embedCross(T.render(CR.crossMarkdown(cstate, { nowMs, warnings: cw, note: cnote }), 'md'), cstate));
      const cm = [];
      if (cross.newA?.length) cm.push(T.render(CR.crossAlertText(cross.newA, cross.newB, cross.latestT), 'md').replace(/\n/g, '  \n'));
      if (cross.closed?.length) cm.push(`結算 ${cross.closed.length} 筆：${cross.closed.map(x => `${x.base} ${x.exitRet >= 0 ? '+' : ''}${x.exitRet.toFixed(1)}%`).join('、')}`);
      if (cm.length) fs.writeFileSync(path.join(outDir, 'cross-comment.md'), `## 4H 金叉 ${T.tpe(nowMs)} 台灣時間\n\n${cm.join('\n\n')}`);
    }
    cw.forEach(w => console.log('cross warning:', w));
  }

  /* ---------- 盤中爆量：整點收盤後判斷（正式爆量＋連續放量；預警寫「盤中預警」Issue） ---------- */
  let halerts = [], hpre = [];
  const preBodyIn = a['pre-body'] && fs.existsSync(a['pre-body']) ? fs.readFileSync(a['pre-body'], 'utf8') : '';
  const pstate = a['pre-body'] ? EA.extractPre(preBodyIn) : null;
  if (a['pre-body'] && !pstate) hw.push('盤中預警 Issue 的狀態無法解析；為避免覆蓋，本輪略過預警');
  if (prep) {
    try {
      HS.rememberCaptured(cache, captured, nowMs);
      const entries = await HS.collectEntries(prep, cache, captured, targetHour, hw);
      halerts = HR.pickAlerts(hstate, entries, targetHour, HR.HOURLY, pstate ? EA.preContext(pstate, targetHour) : {});
      if (pstate) hpre = EA.pickPre(pstate, entries, targetHour);
      const cnt = v => entries.filter(e => e.venue === v).length;
      const hnote = `最近一次檢查：${T.tpe(targetHour)}–${T.tpe(targetHour + HOUR).slice(11)} 台灣時間這根 1H K；OKX ${cnt('okx')} 檔、Bitget ${cnt('bitget')} 檔、Bybit ${cnt('bybit')} 檔，本小時 ${halerts.length} 檔`;
      fs.writeFileSync(path.join(outDir, 'hourly-body.md'), HR.hourlyBody(hstate, { nowMs, warnings: hw, note: hnote }, t => T.render(t, 'md')));
      if (halerts.length) fs.writeFileSync(path.join(outDir, 'hourly-comment.md'), T.render(HR.hourlyAlertText(halerts, targetHour, hw), 'md').replace(/\n/g, '  \n'));
      if (pstate) {
        const pnote = `最近一次預警：${T.tpe(targetHour)}–${T.tpe(targetHour + HOUR).slice(11)} 台灣時間這根 1H K，新增 ${hpre.length} 檔`;
        fs.writeFileSync(path.join(outDir, 'pre-body.md'), EA.preBody(pstate, { nowMs, note: pnote }, t => T.render(t, 'md')));
      }
    } catch (e) { hw.push(`盤中爆量判斷失敗：${e.message}`); }
  }
  HS.saveCache(cachePath, cache);

  /* ---------- 沉睡甦醒（OKX＋Bitget 全部加密合約）＋ OI 紀錄：每小時一次，失敗只影響這一塊 ---------- */
  let dwake = [], dstats = null, dpairs = null;
  const dBody = a['dormant-body'] && fs.existsSync(a['dormant-body']) ? fs.readFileSync(a['dormant-body'], 'utf8') : '';
  const dstate = a['dormant-body'] ? DM.extractDormant(dBody) : null;
  if (a['dormant-body'] && !dstate) hw.push('沉睡甦醒 Issue 的狀態無法解析；為避免覆蓋，本輪略過');
  if (doHourly && dstate && dstate.lastHour !== targetHour) {
    const dw = [];
    try {
      const dcPath = a['dormant-cache'] || '.cache/dormant.json';
      const dcache = DS.loadCache(dcPath);
      const r = await DS.scanWake(dcache, targetHour, dw);
      DS.saveCache(dcPath, dcache);
      dstats = r.stats; dpairs = r.pairs;
      dwake = DM.pickWake(dstate, r.sigs, targetHour);
      const st = r.stats;
      const dnote = `最近一次檢查：${T.tpe(targetHour)}–${T.tpe(targetHour + HOUR).slice(11)} 台灣時間這根 1H K；兩家都有的 ${st.pairs} 檔中 ${st.dormant} 個合約在沉睡、${r.sigs.length} 個單邊訊號，本小時通知 ${dwake.length} 檔。30 天最高量資料：本輪補 ${st.backfilled} 檔，尚缺 ${Math.max(0, st.needBackfill - st.backfilled)} 檔（缺的只判斷「放量」）。`;
      fs.writeFileSync(path.join(outDir, 'dormant-body.md'), DM.dormantBody(dstate, { nowMs, warnings: dw, note: dnote }, t => T.render(t, 'md')));
    } catch (e) { hw.push(`沉睡甦醒判斷失敗：${e.message}`); }
  }
  if (doHourly && a['oi-dir'] && dpairs?.length) {
    try { OI.appendOI(a['oi-dir'], Math.floor(Date.now() / HOUR) * HOUR, await OI.snapshotOI(dpairs)); }
    catch (e) { console.log(`oi warning: ${e.message}`); }
  }

  /* ---------- 量增價平：新紀錄＋到期的 24h／72h 漲跌；失敗只影響這一塊 ---------- */
  let qadded = [];
  const qBody = a['quiet-body'] && fs.existsSync(a['quiet-body']) ? fs.readFileSync(a['quiet-body'], 'utf8') : '';
  const qstate = a.quiet === 'skip' ? null : Q.extractQuiet(qBody);
  if (a.quiet !== 'skip' && !qstate) console.log('quiet warning: 量增價平 Issue 的狀態無法解析；為避免覆蓋，本輪略過');
  if (qstate) {
    try {
      qadded = Q.addItems(qstate, [...Q.fromHourly(halerts), ...Q.fromShort(daily?.added || []), ...Q.fromLayout(layout?.added || [])]);
      const before = JSON.stringify(qstate.items.map(x => x.r));
      const due = qstate.items.some(it => Q.QUIET.checks.some(h => it.r[h] === undefined && nowMs >= it.t + h * HOUR));
      if (due) {
        const [ok, bg] = await Promise.all([getJSON('https://www.okx.com/api/v5/market/tickers?instType=SWAP'), getJSON('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES')]);
        const okx = new Map((ok?.data || []).map(t => [t.instId, +t.last])), bgt = new Map((bg?.data || []).map(t => [t.symbol, +t.lastPr]));
        /* Bybit 從 GitHub 連不到：改用同名的 OKX／Bitget 合約價格 */
        const priceOf = it => (it.venue === 'okx' && okx.get(it.id)) || (it.venue === 'bitget' && bgt.get(it.id))
          || okx.get(`${it.base}-USDT-SWAP`) || bgt.get(`${it.base}USDT`) || null;
        Q.updateItems(qstate, priceOf, nowMs);
      }
      if (qadded.length || due || JSON.stringify(qstate.items.map(x => x.r)) !== before || !qBody.includes('QUIET_STATE')) {
        fs.writeFileSync(path.join(outDir, 'quiet-body.md'), Q.embedQuiet(T.render(Q.quietMarkdown(qstate, { nowMs }), 'md'), qstate));
      }
      if (qadded.length) fs.writeFileSync(path.join(outDir, 'quiet-comment.md'), T.render(Q.quietAlertText(qadded, nowMs), 'md').replace(/\n/g, '  \n'));
    } catch (e) { console.log('quiet warning:', e.message); }
  }

  /* ---------- 行情快照（給網頁）：BTC／ETH 4H 狀態＋網頁抓不到的 Binance、Bitget 價格；失敗不影響其他 ---------- */
  let snap = null;
  if (a['snapshot'] !== 'skip') {
    try {
      snap = await SN.take(SN.needOf({ short: state, layout: lstate, hourly: hstate, cross: cstate }), Date.now());
      fs.writeFileSync(path.join(outDir, 'snapshot-body.md'), SN.embedSnapshot(SN.snapshotMarkdown(snap), snap));
      snap.warnings.forEach(w => console.log('snapshot warning:', w));
    } catch (e) { console.log('snapshot warning:', e.message); }
  }

  const msgs = [];
  /* 量增價平另發一則，排在最前面 */
  if (qadded.length) msgs.push(Q.quietAlertText(qadded, nowMs, a['quiet-url'] || ''));
  const hmsg = HR.hourlyAlertText(halerts, targetHour, [], a['hourly-url'] || '');
  if (hmsg) msgs.push(hmsg);
  const pmsg = EA.preAlertText(hpre, targetHour, a['pre-url'] || '');
  if (pmsg) msgs.push(pmsg);
  const dmsg = DM.wakeAlertText(dwake, targetHour, a['dormant-url'] || '');
  if (dmsg) msgs.push(dmsg);
  if (cross?.newA?.length) msgs.push(CR.crossAlertText(cross.newA, cross.newB, cross.latestT, a['cross-url'] || ''));
  if (cross?.failed) msgs.push(`訊號掃描台｜金叉掃描失敗 ${T.tpe(nowMs)} 台灣時間\n${cross.failed}\n下一個整點自動重試；同一根 4H K 只通知一次`);
  const dailyMsg = daily ? T.dailyText({ nowMs, ...daily, state, issueUrl, warnings }, CFG) : '';
  if (dailyMsg) msgs.push(dailyMsg);
  if (layout) msgs.push(Lay.layoutDailyText(layout.added, layout.events, lstate) + (a['layout-url'] ? `\n${a['layout-url']}` : ''));
  /* 只有真的失敗才發失敗通知；布局清單等 Bybit 成交檔是延後，不是失敗 */
  const failed = warnings.filter(w => w.startsWith('每日掃描失敗') || w.startsWith('布局清單掃描失敗'));
  if (failed.length) msgs.push(`訊號掃描台｜掃描失敗 ${T.tpe(nowMs)} 台灣時間\n${failed.join('\n')}`);
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
    `quiet=${qstate ? `added=${qadded.length} tracking=${qstate.items.length} done=${qstate.done.length}` : 'skip'}`,
    `snapshot=${snap ? `market=${snap.market.length} bitget=${Object.keys(snap.px.bitget).length} binance=${Object.keys(snap.px.binance).length}` : 'skip'}`,
    `sweep=${sweep ? `targets=${sweep.n} events=${sweep.events} added=${sweep.added}` : 'skip'}`,
    `cross=${cross ? (cross.failed ? 'failed' : `${T.tpe(cross.latestT)} A=${cross.newA.length} B=${cross.newB.length} active=${cstate.active.length}`) : 'skip'}`,
    `hourly=${prep ? `${T.tpe(targetHour)} alerts=${halerts.length} ramp=${halerts.filter(x => x.rampOnly).length} pre=${hpre.length} dormant=${dstats ? `${dwake.length}/${dstats.dormant}/${dstats.scanned} bf=${dstats.backfilled}` : 'skip'} bybitCaptured=${Object.values(captured).filter(x => x.confirm).length}` : (doHourly ? 'failed' : 'skip')}`
  ].join(' ');
  console.log(summary);
  [...warnings, ...hw].forEach(w => console.log('warning:', w));
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
