// QUANT Terminal — 衍生品数据(资金费率 / 持仓量 / 多空比)
//
// 四个公开接口各试一遍,哪个通用哪个,互相补位;全都不用密钥。
// GitHub 的服务器在美国,个别交易所会按地区拒绝(币安合约通常如此),所以不能只押一家。
// 每个数据源的成败都记在返回值的 sources 里,写进 data/derivs.json,出了问题看得见。
//
// 单独运行: node cloud/derivs.mjs        → 打印各数据源探测结果
import { pathToFileURL } from 'node:url';

const TIMEOUT_MS = 15_000;
const UA = { 'User-Agent': 'quant-scanner/6.0 (+https://github.com)', Accept: 'application/json' };

async function getJson(url, init = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, headers: { ...UA, ...(init.headers || {}) }, signal: ctl.signal });
    if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
    return await res.json();
  } finally { clearTimeout(timer); }
}
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
// 合约名 → 币种:BTCUSDT→BTC, 1000PEPEUSDT→PEPE, kPEPE→PEPE, BTC-USDT-SWAP→BTC
function baseSym(raw) {
  let s = String(raw || '');
  if (s.includes('-')) s = s.split('-')[0];
  s = s.replace(/USDT$|USDC$|USD$/, '');
  s = s.replace(/^(1000000|100000|10000|1000)/, '');
  if (/^k[A-Z]/.test(s)) s = s.slice(1);
  return s.toUpperCase();
}
// 各家结算周期不同(1h/4h/8h),统一折算成"每8小时"的费率
const to8h = (rate, hours) => (rate == null ? null : rate * (8 / (hours || 8)));

/* ---------- 各数据源:返回 { SYM: { fr(8h小数), oi(美元) } } ---------- */
async function hyperliquid() {
  const d = await getJson('https://api.hyperliquid.xyz/info', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
  });
  const uni = d?.[0]?.universe, ctx = d?.[1];
  if (!Array.isArray(uni) || !Array.isArray(ctx)) throw new Error('返回结构不符 ' + JSON.stringify(d).slice(0, 100));
  const out = {};
  uni.forEach((u, i) => {
    const c = ctx[i]; if (!c || u.isDelisted) return;
    const px = num(c.markPx) ?? num(c.oraclePx), oiCoins = num(c.openInterest);
    out[baseSym(u.name)] = { fr: to8h(num(c.funding), 1), oi: px != null && oiCoins != null ? px * oiCoins : null };
  });
  return out;
}
async function bybit() {
  const d = await getJson('https://api.bybit.com/v5/market/tickers?category=linear');
  const list = d?.result?.list;
  if (!Array.isArray(list)) throw new Error('返回结构不符 ' + JSON.stringify(d).slice(0, 100));
  const out = {};
  for (const t of list) {
    if (!/USDT$/.test(t.symbol)) continue;
    const hours = num(t.fundingIntervalHour) || 8;
    out[baseSym(t.symbol)] = { fr: to8h(num(t.fundingRate), hours), oi: num(t.openInterestValue) };
  }
  return out;
}
async function okx(majors) {
  const [tk, oi] = await Promise.all([
    getJson('https://www.okx.com/api/v5/market/tickers?instType=SWAP'),
    getJson('https://www.okx.com/api/v5/public/open-interest?instType=SWAP'),
  ]);
  if (!Array.isArray(tk?.data) || !Array.isArray(oi?.data)) throw new Error('返回结构不符 ' + JSON.stringify(tk).slice(0, 60) + JSON.stringify(oi).slice(0, 60));
  const last = {};
  for (const t of tk.data) if (/-USDT-SWAP$/.test(t.instId)) last[t.instId] = num(t.last);
  const out = {};
  for (const o of oi.data) {
    if (!/-USDT-SWAP$/.test(o.instId)) continue;
    const usd = num(o.oiUsd) ?? (num(o.oiCcy) != null && last[o.instId] != null ? num(o.oiCcy) * last[o.instId] : null);
    out[baseSym(o.instId)] = { fr: null, oi: usd };
  }
  // 资金费率:先试一次取全部;不支持就只取主流币(逐个请求)
  const putFr = (r) => {
    const s = baseSym(r.instId); if (!out[s]) out[s] = { fr: null, oi: null };
    const span = (num(r.nextFundingTime) - num(r.fundingTime)) / 3600_000;
    out[s].fr = to8h(num(r.fundingRate), span > 0 && span <= 24 ? span : 8);
  };
  try {
    const all = await getJson('https://www.okx.com/api/v5/public/funding-rate?instId=ANY');
    if (!Array.isArray(all?.data) || !all.data.length) throw new Error('ANY 不支持');
    all.data.filter((r) => /-USDT-SWAP$/.test(r.instId)).forEach(putFr);
  } catch {
    for (const s of majors) {
      try { const r = await getJson(`https://www.okx.com/api/v5/public/funding-rate?instId=${s}-USDT-SWAP`); if (r?.data?.[0]) putFr(r.data[0]); } catch {}
    }
  }
  return out;
}
async function binance(majors) {
  const idx = await getJson('https://fapi.binance.com/fapi/v1/premiumIndex');
  if (!Array.isArray(idx)) throw new Error('返回结构不符 ' + JSON.stringify(idx).slice(0, 100));
  const out = {}, mark = {};
  for (const r of idx) {
    if (!/USDT$/.test(r.symbol)) continue;
    const s = baseSym(r.symbol); mark[s] = num(r.markPrice);
    out[s] = { fr: to8h(num(r.lastFundingRate), 8), oi: null };
  }
  for (const s of majors) {   // 币安没有"全部持仓量"的批量接口,只取主流币
    try { const r = await getJson(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${s}USDT`); if (out[s] && mark[s] != null) out[s].oi = num(r.openInterest) * mark[s]; } catch {}
  }
  return out;
}

/* ---------- 多空比(账户数口径,只取主流币):按顺序用第一个能通的 ---------- */
const LS_SOURCES = {
  binance: async (s) => num((await getJson(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${s}USDT&period=1h&limit=1`))?.[0]?.longShortRatio),
  bybit: async (s) => {
    const r = (await getJson(`https://api.bybit.com/v5/market/account-ratio?category=linear&symbol=${s}USDT&period=1h&limit=1`))?.result?.list?.[0];
    const b = num(r?.buyRatio), sl = num(r?.sellRatio); return b != null && sl ? b / sl : null;
  },
  okx: async (s) => num((await getJson(`https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${s}&period=1H`))?.data?.[0]?.[1]),
};

/* ---------- 汇总 ---------- */
const median = (a) => { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export async function fetchDerivs({ majors = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP'], log = () => {} } = {}) {
  majors = majors.map((s) => String(s).toUpperCase());
  const venues = { hl: hyperliquid, okx: () => okx(majors), bybit, binance: () => binance(majors) };
  const sources = {}, per = {};
  await Promise.all(Object.entries(venues).map(async ([name, fn]) => {
    try {
      per[name] = await fn();
      const v = Object.values(per[name]);
      sources[name] = { ok: true, n: v.length, fr: v.filter((x) => x.fr != null).length, oi: v.filter((x) => x.oi != null).length };
    } catch (e) { sources[name] = { ok: false, err: String(e.message || e).slice(0, 120) }; }
    log(`  ${name}: ${JSON.stringify(sources[name])}`);
  }));

  const coins = {};
  const syms = new Set(Object.values(per).flatMap((m) => Object.keys(m)));
  for (const s of syms) {
    const frs = [], used = [], byVenue = {}; let oi = 0, hasOi = false;
    for (const [name, m] of Object.entries(per)) {
      const x = m[s]; if (!x) continue;
      if (x.fr != null) frs.push(x.fr);
      if (x.oi != null && x.oi > 0) { oi += x.oi; hasOi = true; byVenue[name] = Math.round(x.oi); }
      used.push(name);
    }
    if (!frs.length && !hasOi) continue;
    // 资金费率取各家中位数(单家异常值不带偏);持仓量各家相加
    coins[s] = { fr: frs.length ? median(frs) : null, oi: hasOi ? Math.round(oi) : null, v: used, oiBy: byVenue };
  }

  // 多空比:找第一个能通的来源,给主流币各取一次
  let lsFrom = null;
  for (const [name, fn] of Object.entries(LS_SOURCES)) {
    try {
      const first = await fn(majors[0]);
      if (first == null) throw new Error('空');
      lsFrom = name; if (coins[majors[0]]) coins[majors[0]].ls = first;
      for (const s of majors.slice(1)) { try { const r = await fn(s); if (r != null && coins[s]) coins[s].ls = r; } catch {} }
      break;
    } catch (e) { sources[`ls_${name}`] = { ok: false, err: String(e.message || e).slice(0, 80) }; }
  }
  if (lsFrom) sources[`ls_${lsFrom}`] = { ok: true };
  log(`  多空比来源: ${lsFrom || '无'}`);

  return { time: new Date().toISOString(), sources, lsFrom, majors, coins };
}

// 用自己存的历史快照算持仓量变化。只比较"同一批数据源"的数,避免某家这次没连上被误读成持仓骤降。
// hist: [{ t, oi: { SYM: { venue: usd } } }]  —— 只存持仓量最大的 topN 个币,控制文件体积
export function withOiChange(derivs, hist, { topN = 60, keepHours = 26 } = {}) {
  const now = new Date(derivs.time).getTime();
  const change = (s, hoursAgo, tolHours) => {
    const cur = derivs.coins[s]?.oiBy; if (!cur) return null;
    let best = null;
    for (const h of hist) {
      const age = (now - new Date(h.t).getTime()) / 3600_000;
      if (Math.abs(age - hoursAgo) > tolHours || !h.oi[s]) continue;
      if (!best || Math.abs(age - hoursAgo) < Math.abs(best.age - hoursAgo)) best = { age, oi: h.oi[s] };
    }
    if (!best) return null;
    const common = Object.keys(cur).filter((v) => best.oi[v] > 0);
    if (!common.length) return null;
    const a = common.reduce((x, v) => x + cur[v], 0), b = common.reduce((x, v) => x + best.oi[v], 0);
    return b > 0 ? (a / b - 1) * 100 : null;
  };
  for (const s of Object.keys(derivs.coins)) {
    const d24 = change(s, 24, 4), d1 = change(s, 1, 0.75);
    if (d24 != null) derivs.coins[s].dOi24 = +d24.toFixed(1);
    if (d1 != null) derivs.coins[s].dOi1 = +d1.toFixed(1);
  }
  const top = Object.entries(derivs.coins).filter(([, c]) => c.oi).sort((a, b) => b[1].oi - a[1].oi).slice(0, topN);
  const snap = { t: derivs.time, oi: Object.fromEntries(top.map(([s, c]) => [s, c.oiBy])) };
  const kept = hist.filter((h) => (now - new Date(h.t).getTime()) / 3600_000 <= keepHours);
  // 每小时最多留一份
  if (!kept.length || (now - new Date(kept[kept.length - 1].t).getTime()) / 60_000 >= 50) kept.push(snap);
  return kept;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  console.log('探测衍生品数据源…');
  const d = await fetchDerivs({ log: console.log });
  for (const s of d.majors) console.log(' ', s, JSON.stringify(d.coins[s] || null));
  console.log(`共 ${Object.keys(d.coins).length} 个币有数据`);
}
