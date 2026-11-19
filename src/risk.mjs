/* ============================================================
   下單卡：把「可下單訊號」（4H／日線金叉 A 級、做空候選轉弱）換算成可以直接照著掛的單。
   設定在 config/risk.json：capital＝交易本金（USDT），riskPct＝單筆最多虧本金的幾 %。
   名目倉位＝本金 × riskPct ÷ 停損距離；2R＝獲利是停損距離兩倍的價位（到了先平一半、停損移到成本）。
   只加在 Telegram 訊息的縮排行，不改偵測、不改成績解析（成績只比對每個幣的第一行）。
   ============================================================ */
import fs from 'node:fs';
import { fmtP } from './tracker.mjs';

export const RISK_FILE = 'config/risk.json';
export const RISK_DEFAULTS = { capital: 300, riskPct: 1 };

export function loadRisk(file = RISK_FILE) {
  try {
    const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    const r = { ...RISK_DEFAULTS, ...raw };
    return r.capital > 0 && r.riskPct > 0 ? r : null;
  } catch (e) { console.error(`下單卡設定讀取失敗，本輪不加下單卡：${e.message}`); return null; }
}

const usd = v => v >= 100 ? v.toFixed(0) : v.toFixed(1);

/**
 * dir：1 做多、-1 做空；entry：進場價；stop：停損價。回傳 { stopPct, notional, lev, t2 } 或 null（停損方向不對）
 */
export function sizing(dir, entry, stop, risk) {
  if (!risk || !(entry > 0) || !(stop > 0)) return null;
  const dist = dir > 0 ? entry - stop : stop - entry;
  if (!(dist > 0)) return null;
  const stopPct = dist / entry * 100;
  const riskUsd = risk.capital * risk.riskPct / 100;
  const notional = riskUsd / (stopPct / 100);
  return { stopPct, riskUsd, notional, lev: notional / risk.capital, t2: entry + dir * 2 * dist };
}

/** 一行下單卡文字（前面兩個空白，維持訊息原本的縮排格式）；算不出來回傳 '' */
export function cardLine(dir, entry, stop, risk, extra = '', opts = {}) {
  const s = sizing(dir, entry, stop, risk);
  if (!s) return '';
  const lev = s.lev > 1 ? `，需 ≥ ${Math.ceil(s.lev)} 倍，強平距離要 ≥ ${(s.stopPct * 2).toFixed(0)}%` : '，不需槓桿';
  return `  下單卡｜停損 ${fmtP(stop)}（${s.stopPct.toFixed(1)}%）｜虧 ${usd(s.riskUsd)}U → 名目 ${usd(s.notional)}U${lev}${opts.noT2 ? '' : `｜2R ${fmtP(s.t2)} 平一半`}${extra}`;
}
