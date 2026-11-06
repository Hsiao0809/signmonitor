/* ============================================================
   signscanner 掃描核心（原樣複製自 https://signscanner.siaosiao1016.workers.dev/）
   複製日期：2026-11-06 台灣時間。只取純計算部分（交易所轉接器、指標、
   起漲分數、型態·爆量），不含畫面程式。
   之後若在網頁版改了偵測邏輯，要同步更新這個檔案，追蹤器才會用到新邏輯。
   ============================================================ */

/* ============================================================
   多交易所掃描核心
   統一輸出：
     list()  -> [{id, base, price, chg24h, qv24h}]
     kl(id, tf, dayStart) -> [{t,o,h,l,c,qv}, ...] 由舊到新
   ============================================================ */

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function jget(url, tries) {
  tries = tries === undefined ? 3 : tries;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
      /* 451 才是地區封鎖；403 在高併發下多半是限流，退避重試即可 */
      if (r.status === 451) throw new Error('GEO_BLOCK');
      else if (r.status === 429 || r.status === 418 || r.status === 403) await sleep(1500 * (i + 1));
      else await sleep(350 * (i + 1));
    } catch (e) {
      if (e.message === 'GEO_BLOCK') throw e;
      await sleep(400 * (i + 1));
    }
  }
  return null;
}

const num = v => +v;

/* 各家 API 都把貴金屬/原油歸在 RWA 或商品類，這裡統一辨識 */
const COMMODITY = new Set(['XAU', 'XAG', 'XPT', 'XPD', 'XCU', 'COPPER', 'CL', 'BZ', 'NG', 'PAXG', 'XAUT']);

/* 類別：crypto 加密貨幣 / stock 代幣化股票 / comm 商品貴金屬 */
const CAT_LABEL = { crypto: '加密貨幣', stock: '代幣化股票', comm: '商品·貴金屬' };

/* ---------------- 各家轉接器 ---------------- */
const EXCHANGES = {
  binance: {
    label: 'Binance', conc: 8, tv: 'BINANCE',
    tf: { '4h': '4h', '15m': '15m', '1h': '1h', '1d': '1d' },
    async list() {
      const [info, t24] = await Promise.all([
        jget('https://fapi.binance.com/fapi/v1/exchangeInfo'),
        jget('https://fapi.binance.com/fapi/v1/ticker/24hr')
      ]);
      if (!info || !t24) throw new Error('清單取得失敗');
      const tk = {}; t24.forEach(x => tk[x.symbol] = x);
      return info.symbols
        .filter(x => x.status === 'TRADING' && x.contractType === 'PERPETUAL' && x.quoteAsset === 'USDT' && tk[x.symbol])
        .map(x => ({
          id: x.symbol, base: x.baseAsset,
          cat: COMMODITY.has(x.baseAsset) ? 'comm' : 'crypto',
          price: num(tk[x.symbol].lastPrice),
          chg24h: num(tk[x.symbol].priceChangePercent),
          qv24h: num(tk[x.symbol].quoteVolume)
        }));
    },
    async oiHist(id) {
      const j = await jget(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${id}&period=1h&limit=48`, 2);
      if (!Array.isArray(j)) return null;
      const m = {}; j.forEach(x => m[+x.timestamp] = +x.sumOpenInterest);
      return m;
    },
    async kl(id, tf, ds, lim) {
      let u = `https://fapi.binance.com/fapi/v1/klines?symbol=${id}&interval=${this.tf[tf]}`;
      u += ds ? `&startTime=${ds}&limit=200` : `&limit=${lim || 60}`;
      const j = await jget(u);
      if (!Array.isArray(j)) return null;
      return j.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], qv: +k[7] }));
    }
  },

  bybit: {
    label: 'Bybit', conc: 8, tv: 'BYBIT',
    tf: { '4h': '240', '15m': '15', '1h': '60', '1d': 'D' },
    async list() {
      /* symbolType: 'stock' | 'commodity' | 'innovation' | '' */
      const meta = {};
      let cursor = null;
      for (let p = 0; p < 4; p++) {
        const u = 'https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000'
          + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
        const r = await jget(u);
        if (!r || r.retCode !== 0) break;
        r.result.list.forEach(x => meta[x.symbol] = x.symbolType || '');
        cursor = r.result.nextPageCursor;
        if (!cursor) break;
      }
      const j = await jget('https://api.bybit.com/v5/market/tickers?category=linear');
      if (!j || j.retCode !== 0) throw new Error('清單取得失敗');
      return j.result.list
        .filter(x => x.symbol.endsWith('USDT') && !x.symbol.includes('-'))
        .map(x => {
          const base = x.symbol.slice(0, -4), t = meta[x.symbol];
          return {
            id: x.symbol, base,
            cat: t === 'stock' ? 'stock'
              : (t === 'commodity' || COMMODITY.has(base)) ? 'comm' : 'crypto',
            price: num(x.lastPrice), chg24h: num(x.price24hPcnt) * 100, qv24h: num(x.turnover24h)
          };
        });
    },
    async oiHist(id) {
      const j = await jget(`https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${id}&intervalTime=1h&limit=48`, 2);
      if (!j || j.retCode !== 0 || !j.result?.list) return null;
      const m = {}; j.result.list.forEach(x => m[+x.timestamp] = +x.openInterest);
      return m;
    },
    async kl(id, tf, ds, lim) {
      let u = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${id}&interval=${this.tf[tf]}`;
      u += ds ? `&start=${ds}&limit=200` : `&limit=${lim || 60}`;
      const j = await jget(u);
      if (!j || j.retCode !== 0 || !j.result?.list) return null;
      return j.result.list.slice().reverse()
        .map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], qv: +k[6] }));
    }
  },

  okx: {
    label: 'OKX', conc: 6, tv: 'OKX',
    tf: { '4h': '4H', '15m': '15m', '1h': '1H', '1d': '1Dutc' },
    async list() {
      /* instCategory: '1' 加密 / '3' 代幣化股票 / '4' 商品 */
      const [inst, j] = await Promise.all([
        jget('https://www.okx.com/api/v5/public/instruments?instType=SWAP'),
        jget('https://www.okx.com/api/v5/market/tickers?instType=SWAP')
      ]);
      if (!j || j.code !== '0') throw new Error('清單取得失敗');
      const meta = {};
      if (inst && inst.code === '0') inst.data.forEach(x => meta[x.instId] = x.instCategory);
      return j.data
        .filter(x => x.instId.endsWith('-USDT-SWAP'))
        .map(x => {
          const last = num(x.last), o = num(x.open24h), base = x.instId.split('-')[0];
          const c = meta[x.instId];
          return {
            id: x.instId, base,
            cat: c === '3' ? 'stock' : (c === '4' || COMMODITY.has(base)) ? 'comm' : 'crypto',
            price: last, chg24h: o ? (last - o) / o * 100 : 0,
            qv24h: num(x.volCcy24h) * last
          };
        });
    },
    async oiHist() { return null; },   /* 此交易所無逐時 OI 公開端點，偵測器以中性值代入 */
    async kl(id, tf, ds, lim) {
      let u = `https://www.okx.com/api/v5/market/candles?instId=${id}&bar=${this.tf[tf]}`;
      u += ds ? `&before=${ds - 1}&limit=300` : `&limit=${lim || 60}`;
      const j = await jget(u);
      if (!j || j.code !== '0' || !Array.isArray(j.data)) return null;
      return j.data.slice().reverse()
        .map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], qv: +k[7] }));
    }
  },

  bitget: {
    label: 'Bitget', conc: 6, tv: 'BITGET',
    tf: { '4h': '4H', '15m': '15m', '1h': '1H', '1d': '1Dutc' },
    async list() {
      /* isRwa: 'YES' 代表真實世界資產（股票、商品、貴金屬） */
      const [ct, j] = await Promise.all([
        jget('https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES'),
        jget('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES')
      ]);
      if (!j || j.code !== '00000') throw new Error('清單取得失敗');
      const meta = {};
      if (ct && ct.code === '00000') ct.data.forEach(x => meta[x.symbol] = x.isRwa === 'YES');
      return j.data
        .filter(x => x.symbol.endsWith('USDT'))
        .map(x => {
          const base = x.symbol.slice(0, -4);
          return {
            id: x.symbol, base,
            cat: COMMODITY.has(base) ? 'comm' : meta[x.symbol] ? 'stock' : 'crypto',
            price: num(x.lastPr), chg24h: num(x.change24h) * 100,
            qv24h: num(x.usdtVolume || x.quoteVolume)
          };
        });
    },
    async oiHist() { return null; },   /* 此交易所無逐時 OI 公開端點，偵測器以中性值代入 */
    async kl(id, tf, ds, lim) {
      let u = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${id}&productType=USDT-FUTURES&granularity=${this.tf[tf]}`;
      u += ds ? `&startTime=${ds}&limit=200` : `&limit=${lim || 60}`;
      const j = await jget(u);
      if (!j || j.code !== '00000' || !Array.isArray(j.data)) return null;
      return j.data.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], qv: +k[6] }));
    }
  }
};

/* 自動順序：Bybit 優先，因為它同時涵蓋加密貨幣與代幣化股票；
   Binance 永續沒有股票標的，排最後只當最終備援 */
const EX_ORDER = ['bybit', 'bitget', 'okx', 'binance'];

/* ---------------- 併發池 ---------------- */
async function pool(items, limit, fn, onTick) {
  let idx = 0, done = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      await fn(items[i]);
      done++;
      if (onTick) onTick(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
}

/* ---------------- 指標 ---------------- */
function mean(a) { let s = 0; for (const x of a) s += x; return s / a.length; }
function pstd(a, m) { let s = 0; for (const x of a) s += (x - m) * (x - m); return Math.sqrt(s / a.length); }
const PERIOD = 20, KBB = 2.0;

function calcBB(meta, rows) {
  if (!rows || rows.length < PERIOD + 1) return null;
  const closes = rows.map(r => r.c), vols = rows.map(r => r.qv), n = closes.length;
  const band = end => {
    const w = closes.slice(end - PERIOD, end);
    const m = mean(w), s = pstd(w, m);
    return { ma: m, up: m + KBB * s, lo: m - KBB * s };
  };
  const bC = band(n - 1), bL = band(n);
  const closeC = closes[n - 2], closeL = closes[n - 1];
  const brokeClosed = closeC > bC.up, brokeLive = closeL > bL.up;
  if (!brokeClosed && !brokeLive) return null;
  let streak = 0;
  for (let i = n - 1; i >= PERIOD; i--) {
    const w = closes.slice(i - PERIOD, i), m = mean(w);
    if (closes[i] > m + KBB * pstd(w, m)) streak++; else break;
  }
  const pm = mean(vols.slice(n - 21, n - 1));
  return {
    id: meta.id, base: meta.base, cat: meta.cat,
    price: closeL, upper: bL.up, mid: bL.ma, lower: bL.lo,
    pct_over_upper: (closeL - bL.up) / bL.up * 100,
    bandwidth: (bL.up - bL.lo) / bL.ma * 100,
    pct_b: bL.up !== bL.lo ? (closeL - bL.lo) / (bL.up - bL.lo) : 0,
    streak, broke_closed: brokeClosed, broke_live: brokeLive,
    chg24h: meta.chg24h, quote_vol_24h: meta.qv24h,
    vol_ratio: pm > 0 ? vols[n - 1] / pm : 0
  };
}

function zoneOf(z) { return z >= 2 ? 'above2' : z >= 1 ? 'above1' : z > -1 ? 'inside' : z > -2 ? 'below1' : 'below2'; }

function calcVWAP(meta, rows) {
  if (!rows || rows.length < 4) return null;
  let V = 0; for (const r of rows) V += r.qv;
  if (!(V > 0)) return null;
  const tp = rows.map(r => (r.h + r.l + r.c) / 3);
  let s = 0; for (let i = 0; i < rows.length; i++) s += tp[i] * rows[i].qv;
  const vwap = s / V;
  let vr = 0; for (let i = 0; i < rows.length; i++) vr += rows[i].qv * (tp[i] - vwap) ** 2;
  const sd = Math.sqrt(vr / V);
  if (!(sd > 0)) return null;
  const price = rows[rows.length - 1].c, z = (price - vwap) / sd;
  const side = rows.map(r => Math.sign(r.c - vwap));
  let crosses = 0, since = 0;
  for (let i = 1; i < side.length; i++) if (side[i] * side[i - 1] < 0) crosses++;
  for (let i = side.length - 1; i > 0; i--) { if (side[i] * side[i - 1] < 0) break; since++; }
  const flat = rows.filter(r => r.qv === 0).length;
  const dev = (price - vwap) / vwap * 100;
  return {
    id: meta.id, base: meta.base, cat: meta.cat,
    thin: flat / rows.length > 0.25,          /* 逾四分之一 K 棒零成交，指標可信度低 */
    narrow: Math.abs(z) >= 2 && Math.abs(dev) < 1,  /* σ 極端但實際偏離不到 1%：今日盤整過窄，σ 被放大 */
    price, vwap,
    u1: vwap + sd, u2: vwap + 2 * sd, d1: vwap - sd, d2: vwap - 2 * sd,
    sigma: sd, z, dev_pct: dev, zone: zoneOf(z),
    crosses, bars_since_cross: since, bars: rows.length,
    chg24h: meta.chg24h, quote_vol_24h: meta.qv24h
  };
}

/* ---------------- 掃描 ---------------- */
function utcDayStart() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/* 美股常規盤：週一~五 09:30–16:00 America/New_York（自動處理夏令時；不含國定假日） */
function usMarketState(now) {
  now = now || new Date();
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const p = {}; f.formatToParts(now).forEach(x => p[x.type] = x.value);
  const wd = p.weekday, mins = (+p.hour % 24) * 60 + (+p.minute);
  if (wd === 'Sat' || wd === 'Sun') return { open: false, label: '美股週末休市' };
  if (mins >= 570 && mins < 960) return { open: true, label: '美股盤中' };
  if (mins >= 240 && mins < 570) return { open: false, label: '美股盤前' };
  if (mins >= 960 && mins < 1200) return { open: false, label: '美股盤後' };
  return { open: false, label: '美股休市' };
}

async function scanWith(exKey, scope, onProgress) {
  const ex = EXCHANGES[exKey];
  onProgress({ phase: 'meta', text: `${ex.label}：取得合約清單…` });
  let syms = await ex.list();
  if (!syms.length) throw new Error('清單為空');
  if (scope > 0) {
    /* 依成交額取前 N 檔，但代幣化股票與商品一律保留，避免被量能門檻洗掉 */
    const rank = syms.slice().sort((a, b) => b.qv24h - a.qv24h).slice(0, scope);
    const keep = new Set(rank.map(x => x.id));
    syms.forEach(x => { if (x.cat !== 'crypto') keep.add(x.id); });
    syms = syms.filter(x => keep.has(x.id));
  }
  syms.sort((a, b) => a.base.localeCompare(b.base));

  const ds = utcDayStart();
  const bbRows = [], vwRows = [];
  let fail = 0, done = 0;
  const total = syms.length * 2;
  const tick = () => onProgress({ phase: 'scan', done: ++done, total, ex: ex.label });

  await pool(syms, ex.conc, async m => {
    const k4 = await ex.kl(m.id, '4h', 0); tick();
    const k15 = await ex.kl(m.id, '15m', ds); tick();
    if (!k4 && !k15) { fail++; return; }
    if (k4) { const b = calcBB(m, k4); if (b) bbRows.push(b); }
    if (k15) { const v = calcVWAP(m, k15); if (v) vwRows.push(v); }
  });

  if (fail / syms.length > 0.5) throw new Error(`${ex.label} 失敗率過高 (${fail}/${syms.length})`);

  bbRows.sort((a, b) => b.pct_over_upper - a.pct_over_upper);
  vwRows.sort((a, b) => b.z - a.z);
  const bbSet = new Set(bbRows.map(r => r.id));
  const vwUp = new Set(vwRows.filter(r => r.zone === 'above1' || r.zone === 'above2').map(r => r.id));
  vwRows.forEach(r => r.bb_hit = bbSet.has(r.id));
  bbRows.forEach(r => r.vw_up = vwUp.has(r.id));

  const cnt = z => vwRows.filter(r => r.zone === z).length;
  const catCnt = c => syms.filter(x => x.cat === c).length;
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  return {
    exchange: exKey, exchangeLabel: ex.label, failed: fail,
    us: usMarketState(),
    cats: { crypto: catCnt('crypto'), stock: catCnt('stock'), comm: catCnt('comm') },
    bb: { meta: { generated_utc: stamp, total_scanned: syms.length - fail, hits: bbRows.length }, rows: bbRows },
    vwap: {
      meta: {
        generated_utc: stamp,
        anchor_utc: new Date(ds).toISOString().slice(0, 16).replace('T', ' '),
        bars_elapsed: vwRows.length ? Math.max(...vwRows.map(r => r.bars)) : 0,
        total: vwRows.length,
        above2: cnt('above2'), above1: cnt('above1'), inside: cnt('inside'),
        below1: cnt('below1'), below2: cnt('below2')
      }, rows: vwRows
    }
  };
}

/** prefer: 'auto' 或交易所 key */
async function fullScan(prefer, scope, onProgress) {
  const order = prefer === 'auto' ? EX_ORDER : [prefer];
  const errs = [];
  for (let i = 0; i < order.length; i++) {
    const k = order[i];
    try {
      if (i > 0) onProgress({ phase: 'meta', text: `切換備援：${EXCHANGES[k].label}…` });
      const r = await scanWith(k, scope, onProgress);
      r.fellBack = i > 0; r.tried = errs;
      return r;
    } catch (e) {
      const msg = e.message === 'GEO_BLOCK'
        ? `${EXCHANGES[k].label} 在你的地區/網路被封鎖`
        : `${EXCHANGES[k].label}：${e.message}`;
      errs.push(msg);
      if (prefer !== 'auto') throw new Error(msg);
    }
  }
  throw new Error('四家交易所皆無法連線 —\n' + errs.join('\n'));
}


/* ============================================================
   起漲點偵測器
   特徵與權重來自 1H 歷史回測（見 model.stats），非人工設定
   ============================================================ */
const RALLY_MODEL = {"F": ["d_hi24", "oi24", "vlead", "ret24", "bw_pct", "atr_pct", "ema_d", "vnow"], "w": [-1.3191, -1.8201, 0.1515, 0.0666, 0.1764, -0.3365, -0.1692, 1.1738, 0.1675, 0.3871], "q": {"d_hi24": [-89.361798, -13.226186, -8.95163, -6.794309, -5.623869, -4.882652, -4.29481, -3.811659, -3.42497, -3.063957, -2.742814, -2.429444, -2.150007, -1.88432, -1.611609, -1.360281, -1.119532, -0.888299, -0.633734, -0.365277, 0.0], "oi24": [-44.756023, -10.253278, -6.393511, -4.560054, -3.465676, -2.585679, -1.839319, -1.236005, -0.691719, -0.197483, 0.0, 0.44692, 0.957948, 1.547695, 2.298998, 3.250849, 4.570801, 6.557388, 10.902669, 21.167678, 565.888748], "vlead": [0.028367, 0.465823, 0.579856, 0.651714, 0.717033, 0.771621, 0.824816, 0.871955, 0.918822, 0.970827, 1.023416, 1.076209, 1.138149, 1.212204, 1.306802, 1.415906, 1.568063, 1.811344, 2.246716, 3.677276, 525.027528], "ret24": [-87.850635, -8.535051, -5.38004, -3.953465, -2.984881, -2.397631, -1.883443, -1.423531, -0.99561, -0.595782, -0.258739, 0.066774, 0.436724, 0.815712, 1.276929, 1.838341, 2.578798, 3.597488, 5.165082, 9.51073, 278.579003], "bw_pct": [0.0, 0.025, 0.075, 0.135135, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.763158, 0.8, 0.85, 0.925, 0.975, 1.0], "atr_pct": [0.0, 0.02381, 0.071429, 0.125, 0.178571, 0.232143, 0.279762, 0.333333, 0.380952, 0.434524, 0.482143, 0.529762, 0.583333, 0.630952, 0.684524, 0.738095, 0.791667, 0.845238, 0.904762, 0.964286, 0.994048], "ema_d": [-7.698933, -2.130051, -1.672893, -1.39755, -1.149567, -0.954067, -0.776214, -0.615259, -0.456378, -0.301125, -0.157353, -0.002056, 0.166268, 0.329609, 0.490678, 0.665973, 0.864249, 1.121556, 1.457553, 1.955687, 8.619265], "vnow": [0.002432, 0.211862, 0.296946, 0.363497, 0.420469, 0.475011, 0.526206, 0.576758, 0.634612, 0.692404, 0.754383, 0.82447, 0.901199, 0.998358, 1.109721, 1.242218, 1.431359, 1.663742, 2.032986, 2.858786, 20.679257]}, "stats": {"base": 20.5, "oos": {"top10": {"hit": 34.0, "mean": 1.45, "med": -2.25, "win": 41.1, "n": 941}, "top5": {"hit": 35.9, "mean": 2.48, "med": -2.96, "win": 41.0, "n": 471}, "top2": {"hit": 47.6, "mean": 8.52, "med": 0.33, "win": 50.8, "n": 189}}, "period": "2026-06-26 → 2026-08-06", "symbols": 132, "samples": 23521, "oos_from": "2026-07-24"}};

function emaArr(x, n) {
  const k = 2 / (n + 1), out = [x[0]];
  for (let i = 1; i < x.length; i++) out.push(x[i] * k + out[i - 1] * (1 - k));
  return out;
}
/* 用訓練期的百分位斷點把原始特徵值轉成 0~1（與回測同一套斷點） */
function pctRank(f, v) {
  const q = RALLY_MODEL.q[f];
  if (!q) return 0.5;
  let lo = 0, hi = q.length - 1;
  if (v <= q[0]) return 0;
  if (v >= q[hi]) return 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (q[mid] <= v) lo = mid; else hi = mid; }
  return lo / (q.length - 1);
}

/* rows: 1H K 線（由舊到新，>=200 根）; oi: {ts:openInterest} 或 null */
function rallyFeatures(rows, oi) {
  const n = rows.length;
  if (n < 180) return null;
  const c = rows.map(r => r.c), h = rows.map(r => r.h), l = rows.map(r => r.l), v = rows.map(r => r.qv);
  const i = n - 1;
  const e20 = emaArr(c, 20);
  const tr = c.map((_, j) => j === 0 ? h[0] - l[0]
    : Math.max(h[j] - l[j], Math.abs(h[j] - c[j - 1]), Math.abs(l[j] - c[j - 1])));
  const atr14 = tr.slice(i - 13, i + 1).reduce((s, x) => s + x, 0) / 14;
  if (!(atr14 > 0) || !(c[i] > 0)) return null;
  const atrp = atr14 / c[i] * 100;

  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
  const w20 = c.slice(i - 19, i + 1);
  const bw = 4 * sd(w20) / mean(w20) * 100;
  const hb = [];
  for (let j = i - 159; j <= i; j += 5) { const ww = c.slice(j - 19, j + 1); if (ww.length === 20) hb.push(4 * sd(ww) / mean(ww) * 100); }
  const bw_pct = hb.length ? hb.filter(x => x < bw).length / hb.length : .5;
  const atrHist = [];
  for (let j = i - 159; j <= i; j += 5) {
    const t2 = tr.slice(j - 13, j + 1); if (t2.length === 14) atrHist.push(mean(t2) / c[j]);
  }
  const atr_pct = atrHist.length ? atrHist.filter(x => x < atr14 / c[i]).length / atrHist.length : .5;

  const v24 = mean(v.slice(i - 23, i + 1)), v48 = mean(v.slice(i - 47, i - 23));
  const hi24 = Math.max(...h.slice(i - 23, i + 1)), lo24 = Math.min(...l.slice(i - 23, i + 1));
  let oi24 = 0;
  if (oi) {
    const ks = Object.keys(oi).map(Number).sort((a, b) => a - b);
    if (ks.length > 24) {
      const now = oi[ks[ks.length - 1]], then = oi[ks[Math.max(0, ks.length - 25)]];
      if (then > 0) oi24 = (now / then - 1) * 100;
    }
  }
  return {
    d_hi24: (c[i] - hi24) / hi24 * 100,
    oi24,
    vlead: v48 > 0 ? v24 / v48 : 1,
    ret24: (c[i] / c[i - 24] - 1) * 100,
    ret4: (c[i] / c[i - 4] - 1) * 100,
    ret1: (c[i] / c[i - 1] - 1) * 100,
    bw_pct, atr_pct, atrp,
    ema_d: (c[i] - e20[i]) / atr14,
    vnow: v24 > 0 ? v[i] / v24 : 1,
    rpos24: hi24 > lo24 ? (c[i] - lo24) / (hi24 - lo24) : .5,
    hasOI: !!oi
  };
}

function rallyScore(f) {
  const F = RALLY_MODEL.F, w = RALLY_MODEL.w;
  let z = w[0];
  F.forEach((k, j) => { z += w[j + 1] * pctRank(k, f[k]); });
  z += w[F.length + 1] * Math.abs(pctRank('ret24', f.ret24) - .5) * 2;
  return 1 / (1 + Math.exp(-z));
}

/* 觸發原因：只列出對分數實際有貢獻的項目 */
function rallyReasons(f) {
  const r = [];
  if (f.d_hi24 < -12) r.push(['自 24H 高點回落 ' + f.d_hi24.toFixed(0) + '%', 'main']);
  if (f.ema_d > 1.5) r.push(['高於 EMA20 ' + f.ema_d.toFixed(1) + ' 個 ATR', 'main']);
  if (f.oi24 > 8) r.push(['24H 未平倉 +' + f.oi24.toFixed(0) + '%', 'oi']);
  if (f.vlead > 1.6) r.push(['均量放大 ' + f.vlead.toFixed(1) + 'x', 'vol']);
  if (f.vnow > 2.5) r.push(['當根爆量 ' + f.vnow.toFixed(1) + 'x', 'vol']);
  if (Math.abs(f.ret24) > 12) r.push(['24H ' + (f.ret24 > 0 ? '+' : '') + f.ret24.toFixed(0) + '%', 'mom']);
  if (f.bw_pct > .8) r.push(['帶寬擴張', 'vol']);
  if (f.bw_pct < .2) r.push(['帶寬壓縮', 'vol']);
  return r;
}

/* ---------- 漲幅榜 + 起漲點掃描（共用同一批 1H K 線） ---------- */
const LIQ_MIN = 3e6;   /* 24h 成交額下限，與回測一致 */

async function scanRally(exKey, onProgress) {
  const ex = EXCHANGES[exKey];
  onProgress({ phase: 'meta', text: `${ex.label}：取得合約清單…` });
  const all = await ex.list();
  const syms = all.filter(x => x.qv24h >= LIQ_MIN);
  if (!syms.length) throw new Error('無標的通過流動性門檻');

  const rows = [];
  let fail = 0, done = 0;
  const total = syms.length * 2;
  const tick = () => onProgress({ phase: 'scan', done: ++done, total, ex: ex.label });

  await pool(syms, ex.conc, async m => {
    const k = await ex.kl(m.id, '1h', 0, 200); tick();
    const oi = await ex.oiHist(m.id); tick();
    if (!k || k.length < 180) { fail++; return; }
    const f = rallyFeatures(k, oi);
    if (!f) { fail++; return; }
    rows.push({
      id: m.id, base: m.base, cat: m.cat, price: m.price,
      chg24h: m.chg24h, qv24h: m.qv24h,
      chg1h: f.ret1, chg4h: f.ret4, chg24k: f.ret24,
      score: rallyScore(f) * 100,
      reasons: rallyReasons(f),
      d_hi24: f.d_hi24, oi24: f.oi24, vlead: f.vlead, vnow: f.vnow,
      ema_d: f.ema_d, atrp: f.atrp, bw_pct: f.bw_pct, rpos24: f.rpos24,
      hasOI: f.hasOI
    });
  });

  if (fail / syms.length > 0.5) throw new Error(`${ex.label} 失敗率過高 (${fail}/${syms.length})`);
  rows.sort((a, b) => b.score - a.score);
  const n = rows.length;
  rows.forEach((r, i) => r.pct = (1 - i / n) * 100);   /* 分數百分位 */
  return {
    exchange: exKey, exchangeLabel: ex.label, failed: fail,
    hasOI: rows.length ? rows[0].hasOI : false,
    meta: {
      generated_utc: new Date().toISOString().slice(0, 19).replace('T', ' '),
      total: n, liq_min: LIQ_MIN,
      cats: { crypto: rows.filter(r => r.cat === 'crypto').length,
              stock: rows.filter(r => r.cat === 'stock').length,
              comm: rows.filter(r => r.cat === 'comm').length }
    },
    rows
  };
}

/* ============================================================
   型態掃描器 — 客觀描述目前狀態，不預測方向、不給分數
   全部指標都是可驗證的統計量，沒有任何擬合出來的權重
   ============================================================ */

/* ============================================================
   型態掃描器 — 客觀描述目前狀態，不預測方向、不給分數
   全部指標都是可驗證的統計量，沒有任何擬合出來的權重
   ============================================================ */

const PAT_LABEL = {
  breakout: '突破區間',
  breakdown: '跌破區間',
  squeeze: '壓縮打底',
  base: '區間整理',
  trend_up: '上升趨勢',
  trend_dn: '下降趨勢',
  none: '—'
};

function _mean(a) { let s = 0; for (const x of a) s += x; return a.length ? s / a.length : 0; }
function _std(a) { const m = _mean(a); return Math.sqrt(_mean(a.map(x => (x - m) ** 2))); }
function _pctRankOf(arr, v) { return arr.length ? arr.filter(x => x < v).length / arr.length : 0.5; }

/**
 * rows: 日線（由舊到新），最後一根是進行中的今日
 * 回傳 null 表示資料不足
 */
function patternScan(rows, nowMs) {
  const n = rows.length;
  if (n < 70) return null;

  const cur = rows[n - 1];                 // 進行中的今日
  const i = n - 2;                         // 最後一根「已收盤」日線
  const h = rows.map(r => r.h), l = rows.map(r => r.l),
        c = rows.map(r => r.c), v = rows.map(r => r.qv);

  /* ---------- 成交量異常 ---------- */
  const v20 = _mean(v.slice(i - 20, i));           // 前 20 個完整交易日均量
  const v60 = v.slice(Math.max(0, i - 60), i);
  const m60 = _mean(v60), s60 = _std(v60);

  const vx = v20 > 0 ? v[i] / v20 : 0;             // 最後收盤日的量倍數
  const vz = s60 > 0 ? (v[i] - m60) / s60 : 0;     // 幾個標準差
  const vpct = _pctRankOf(v60, v[i]);              // 在過去 60 日中的百分位

  /* 連續放量天數（> 1.5 倍均量） */
  let vstreak = 0;
  for (let j = i; j >= i - 30 && j >= 20; j--) {
    const mm = _mean(v.slice(j - 20, j));
    if (mm > 0 && v[j] > 1.5 * mm) vstreak++; else break;
  }

  /* ---------- 近一個月內最大的一次爆量 ---------- */
  let mx = null;
  for (let j = Math.max(21, i - 29); j <= i; j++) {
    const mm = _mean(v.slice(j - 20, j));
    if (mm <= 0) continue;
    const x = v[j] / mm;
    if (!mx || x > mx.x) {
      const w = v.slice(Math.max(0, j - 60), j);
      const ws = _std(w);
      mx = {
        x, t: rows[j].t, ago: i - j,
        z: ws > 0 ? (v[j] - _mean(w)) / ws : 0,
        close: c[j],
        dayChg: rows[j].o > 0 ? (c[j] / rows[j].o - 1) * 100 : 0,
        since: c[j] > 0 ? (cur.c / c[j] - 1) * 100 : 0   /* 爆量那天收盤到現在的漲跌 */
      };
    }
  }

  /* 今日進行中：依已過時間換算全日量 */
  const dayMs = 86400000;
  const elapsed = Math.min(1, Math.max(0.02, ((nowMs || Date.now()) - cur.t) / dayMs));
  const paceX = v20 > 0 ? (cur.qv / elapsed) / v20 : 0;   // 換算成全日的倍數
  const todayX = v20 > 0 ? cur.qv / v20 : 0;              // 目前已累積的倍數

  /* ---------- 型態 ---------- */
  const win = (arr, a, b) => arr.slice(Math.max(0, a), b);
  const hi60 = Math.max(...win(h, i - 60, i));
  const lo60 = Math.min(...win(l, i - 60, i));
  const width60 = lo60 > 0 ? (hi60 - lo60) / lo60 : 9;
  const pos = hi60 > lo60 ? (c[i] - lo60) / (hi60 - lo60) : .5;

  /* 20 日區間寬度，以及它在過去 180 天的百分位（越低越壓縮） */
  const w20 = (j) => {
    const hh = Math.max(...win(h, j - 20, j)), ll = Math.min(...win(l, j - 20, j));
    return ll > 0 ? (hh - ll) / ll : 9;
  };
  const curW = w20(i);
  const hist = [];
  for (let j = Math.max(25, i - 180); j <= i; j += 3) hist.push(w20(j));
  const squeezePct = _pctRankOf(hist, curW);

  /* 已經幾天沒有創 60 日新高 / 新低 */
  let daysNoHigh = 0, daysNoLow = 0;
  for (let j = i; j > i - 90 && j > 60; j--) {
    if (h[j] >= Math.max(...win(h, j - 60, j))) break; daysNoHigh++;
  }
  for (let j = i; j > i - 90 && j > 60; j--) {
    if (l[j] <= Math.min(...win(l, j - 60, j))) break; daysNoLow++;
  }

  const prevHi = Math.max(...win(h, i - 60, i));
  const prevLo = Math.min(...win(l, i - 60, i));
  const brokeUp = c[i] > prevHi || cur.c > prevHi;
  const brokeDn = c[i] < prevLo || cur.c < prevLo;

  let pat;
  if (brokeUp) pat = 'breakout';
  else if (brokeDn) pat = 'breakdown';
  else if (squeezePct <= 0.25 && width60 <= 0.80) pat = 'squeeze';
  else if (pos >= 0.75) pat = 'trend_up';
  else if (pos <= 0.25) pat = 'trend_dn';
  else pat = 'base';

  /* 突破前是不是一段窄幅打底（描述用，非預測） */
  const preBase = (() => {
    const j = i - 1;
    if (j < 80) return null;
    const hh = Math.max(...win(h, j - 60, j)), ll = Math.min(...win(l, j - 60, j));
    return ll > 0 ? (hh - ll) / ll : null;
  })();

  const chg = (k) => (i - k >= 0 && c[i - k] > 0) ? (cur.c / c[i - k] - 1) * 100 : 0;

  return {
    pattern: pat,
    price: cur.c,
    chg1d: chg(0), chg7d: chg(6), chg30d: chg(29),
    vx, vz, vpct, vstreak,
    todayX, paceX, elapsed, mx,
    squeezePct, width60, pos,
    daysNoHigh, daysNoLow,
    preBaseWidth: preBase,
    rangeHi: prevHi, rangeLo: prevLo,
    volUsd: v20
  };
}

/* 爆量分級：純粹描述量的極端程度，與後續漲跌無關 */
function volTier(r) {
  const x = Math.max(r.vx, r.paceX);
  if (x >= 10) return { k: 'x3', t: '極端爆量', x };
  if (x >= 5) return { k: 'x2', t: '大幅爆量', x };
  if (x >= 2.5) return { k: 'x1', t: '明顯放量', x };
  if (x >= 1.5) return { k: 'x0', t: '溫和放量', x };
  return null;
}


/* ---------- 型態掃描（日線，每檔 1 個請求） ---------- */
async function scanPattern(exKey, onProgress) {
  const ex = EXCHANGES[exKey];
  onProgress({ phase: 'meta', text: `${ex.label}：取得合約清單…` });
  const all = await ex.list();
  const syms = all.filter(x => x.qv24h >= 1e6);
  if (!syms.length) throw new Error('無標的通過流動性門檻');
  const now = Date.now();
  const rows = [];
  let fail = 0, done = 0;
  const tick = () => onProgress({ phase: 'scan', done: ++done, total: syms.length, ex: ex.label });

  await pool(syms, ex.conc, async m => {
    const k = await ex.kl(m.id, '1d', 0, 120); tick();
    if (!k || k.length < 70) { fail++; return; }
    const p = patternScan(k, now);
    if (!p) { fail++; return; }
    rows.push(Object.assign({ id: m.id, base: m.base, cat: m.cat, qv24h: m.qv24h, chg24h: m.chg24h }, p,
      { vt: volTier(p) }));
  });
  if (fail / syms.length > 0.5) throw new Error(`${ex.label} 失敗率過高 (${fail}/${syms.length})`);
  rows.sort((a, b) => Math.max(b.vx, b.paceX) - Math.max(a.vx, a.paceX));
  const cnt = p => rows.filter(r => r.pattern === p).length;
  return {
    exchange: exKey, exchangeLabel: ex.label, failed: fail,
    meta: {
      generated_utc: new Date().toISOString().slice(0, 19).replace('T', ' '),
      total: rows.length,
      breakout: cnt('breakout'), breakdown: cnt('breakdown'), squeeze: cnt('squeeze'),
      vol_extreme: rows.filter(r => r.vt && r.vt.k === 'x3').length,
      vol_big: rows.filter(r => r.vt && r.vt.k === 'x2').length,
      cats: { crypto: rows.filter(r => r.cat === 'crypto').length,
              stock: rows.filter(r => r.cat === 'stock').length,
              comm: rows.filter(r => r.cat === 'comm').length }
    },
    rows
  };
}

export {
  EXCHANGES, EX_ORDER, CAT_LABEL, COMMODITY, PAT_LABEL, RALLY_MODEL, LIQ_MIN,
  jget, pool, sleep, usMarketState,
  patternScan, volTier, scanPattern,
  rallyFeatures, rallyScore, rallyReasons, scanRally
};
