// QUANT Terminal — 信号账本与自动复盘
//
// 每次云端扫描:
//   1) 记账 —— 某个币"新出现"某个模式标记时,记下当时的价格、BTC价格、成交量排名、总闸状态;
//   2) 回填 —— 账本里到期的记录(1/3/7/14天后)填上到期时的价格;
//   3) 汇总 —— 按模式统计"相对BTC的超额收益",写进 summary.json 给 App 的战绩页和简报邮件用。
//
// 这是往前记的账,不是回测:没有任何事后挑选,记下时不知道结果。
// 文件按天分开(data/ledger/2026-11-16.json),这样每次运行只改动少数几个小文件。
import fs from 'node:fs/promises';
import path from 'node:path';

export const HORIZONS = [1, 3, 7, 14];          // 天
const HOUR = 3600_000, DAY = 24 * HOUR;
const REENTRY_HOURS = 24;                        // 同一标记消失不足24小时又出现,算同一次,不重复记
const KEEP_DAYS = 90;                            // 汇总只看最近90天
// 回填容差:到期后这么久之内扫到才算数(定时任务会晚到);再晚就不是"N天后的价格"了,记为错过
const tolerance = (h) => Math.max(6, h * 24 * 0.25) * HOUR;
const bjDate = (ms) => new Date(ms + 8 * HOUR).toISOString().slice(0, 10);

const readJson = async (p, fallback) => { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return fallback; } };
const writeJson = (p, v) => fs.writeFile(p, JSON.stringify(v));

async function listDayFiles(dir, sinceMs) {
  let names = [];
  try { names = await fs.readdir(dir); } catch {}
  return names.filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n) && n.slice(0, 10) >= bjDate(sinceMs)).sort();
}

export async function updateLedger({ dir, snap, fetchPrices = async () => ({}), log = () => {} }) {
  const now = new Date(snap.time).getTime();
  await fs.mkdir(dir, { recursive: true });
  const btc = snap.btc?.p;
  if (!btc) return null;

  /* ---- 1) 记账:新出现的标记 ---- */
  const activePath = path.join(dir, 'active.json');
  const active = await readJson(activePath, null);
  const isInit = !active;                       // 第一次运行:市场上已有的标记一并建档,但打上 i:1
  const seen = active?.keys || {};
  const added = [];
  for (const t of snap.all || []) {
    for (const p of t.pats || []) {
      const k = `${t.s}:${p.c}`;
      const last = seen[k] ? new Date(seen[k]).getTime() : 0;
      seen[k] = snap.time;
      if (now - last < REENTRY_HOURS * HOUR) continue;
      const e = { s: t.s, id: t.id, c: p.c, sc: p.sc, v: p.v ? 1 : 0, t: snap.time, p: sig(t.p), b: sig(btc), rk: t.rk, mc: Math.round(t.mc || 0), g: snap.gate?.closed ? 1 : 0, f: {} };
      if (isInit) e.i = 1;
      const dv = snap.dv?.[t.s];                // 当时的资金费率/持仓变化,留着以后检验它们有没有用
      if (dv?.fr != null) e.fr = +(dv.fr * 100).toFixed(4);
      if (dv?.dOi24 != null) e.oi24 = dv.dOi24;
      added.push(e);
    }
  }
  for (const k of Object.keys(seen)) if (now - new Date(seen[k]).getTime() > 2 * DAY) delete seen[k];

  /* ---- 2) 回填:到期的记录 ---- */
  const files = await listDayFiles(dir, now - (HORIZONS[HORIZONS.length - 1] + 5) * DAY);
  const today = `${bjDate(now)}.json`;
  if (!files.includes(today)) files.push(today);
  const days = {};
  for (const f of files) days[f] = await readJson(path.join(dir, f), []);
  days[today].push(...added);

  const price = {};
  for (const t of snap.all || []) price[t.id] = t.p;
  const due = [];                                // [entry, horizon, file]
  const dirty = new Set(added.length ? [today] : []);
  for (const [f, list] of Object.entries(days)) {
    for (const e of list) {
      const t0 = new Date(e.t).getTime();
      for (const h of HORIZONS) {
        if (e.f[h] !== undefined || now < t0 + h * DAY) continue;
        if (now - (t0 + h * DAY) > tolerance(h)) { e.f[h] = 0; dirty.add(f); continue; }   // 错过
        due.push([e, h, f]);
      }
    }
  }
  // 掉出扫描池的币单独查价 —— 否则账本里只剩"还活跃"的币,结果会偏好看(幸存者偏差)
  const missing = [...new Set(due.filter(([e]) => price[e.id] == null).map(([e]) => e.id))];
  if (missing.length) {
    try { Object.assign(price, await fetchPrices(missing)); }
    catch (err) { log(`账本:补查 ${missing.length} 个掉出扫描池的币价失败(${err.message}),下次运行再试`); }
  }
  let filled = 0;
  for (const [e, h, f] of due) {
    const p = price[e.id];
    if (!(p > 0)) continue;                      // 这次没查到价,容差内下次再试
    e.f[h] = [sig(p), sig(btc)]; dirty.add(f); filled++;
  }
  for (const f of dirty) await writeJson(path.join(dir, f), days[f]);
  await writeJson(activePath, { keys: seen });

  /* ---- 3) 汇总 ---- */
  const allFiles = await listDayFiles(dir, now - KEEP_DAYS * DAY);
  const entries = [];
  for (const f of allFiles) entries.push(...(days[f] || await readJson(path.join(dir, f), [])));
  const summary = summarize(entries, snap);
  await writeJson(path.join(dir, 'summary.json'), summary);
  log(`账本:新记 ${added.length} 条${isInit ? '(首次建档)' : ''},回填 ${filled} 条,累计 ${entries.length} 条`);
  return summary;
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const median = (a) => { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r1 = (x) => +x.toFixed(1);
const sig = (x) => +Number(x).toPrecision(6);   // 价格留6位有效数字就够算涨跌幅,省体积

// "对"的定义统一用相对BTC的超额收益:多头标记 → 跑赢BTC算对;回避/偏空标记 → 跑输BTC算对。
// 用超额而不用绝对涨跌,是因为大盘一起涨一起跌时,绝对涨跌说明不了标记本身有没有用。
export function summarize(entries, snap) {
  const types = snap.patTypes || {};
  const segOf = { all: () => true, top50: (e) => e.rk > 0 && e.rk <= 50, rest: (e) => !(e.rk > 0 && e.rk <= 50) };
  const seg = {};
  for (const [name, test] of Object.entries(segOf)) {
    seg[name] = {};
    for (const h of HORIZONS) {
      const groups = {};
      for (const e of entries) {
        const f = e.f?.[h];
        if (!Array.isArray(f) || !test(e) || !(e.p > 0) || !(e.b > 0)) continue;
        const ret = (f[0] / e.p - 1) * 100, ex = ret - (f[1] / e.b - 1) * 100;
        const type = types[e.c]?.type || 'long';
        for (const key of [e.c, `_${type}`]) (groups[key] ||= { type, ret: [], ex: [] }).ret.push(ret), groups[key].ex.push(ex);
      }
      seg[name][h] = Object.fromEntries(Object.entries(groups).map(([k, g]) => [k, {
        n: g.ex.length,
        win: Math.round(g.ex.filter((x) => (g.type === 'long' ? x > 0 : x < 0)).length / g.ex.length * 100),
        avg: r1(mean(g.ret)), ex: r1(mean(g.ex)), med: r1(median(g.ex)),
      }]));
    }
  }
  const done1 = entries.filter((e) => Array.isArray(e.f?.[1])).sort((a, b) => (a.t < b.t ? 1 : -1)).slice(0, 40).map((e) => {
    const ret = (e.f[1][0] / e.p - 1) * 100;
    return { s: e.s, c: e.c, t: e.t, p: e.p, ret: r1(ret), ex: r1(ret - (e.f[1][1] / e.b - 1) * 100) };
  });
  const lastT = new Date(snap.time).getTime();
  return {
    time: snap.time,
    since: entries.reduce((m, e) => (!m || e.t < m ? e.t : m), null),
    entries: entries.length,
    init: entries.filter((e) => e.i).length,
    pending: entries.filter((e) => HORIZONS.some((h) => e.f?.[h] === undefined && lastT < new Date(e.t).getTime() + h * DAY)).length,
    horizons: HORIZONS,
    types: Object.fromEntries(Object.entries(types).map(([c, t]) => [c, t])),
    seg, recent: done1,
  };
}
