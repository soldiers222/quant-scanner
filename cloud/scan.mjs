// QUANT Terminal — 云端定时扫描 + 邮件推送 (v5.1)
//
// 做法:用无头浏览器打开仓库里的 index.html(就是手机上那个App),等它扫完,
// 从 window.__QS.snapshot() 取结果。判定逻辑只有 index.html 里那一份 ——
// 邮件里的每个数字和App里看到的是同一次计算,不存在"云端版"和"手机版"两套规则。
//
// 环境变量(都放在 GitHub Secrets,不要写进任何文件):
//   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS   发信邮箱的SMTP
//   MAIL_TO                                          收件人,多个用逗号分隔
//   MAIL_FROM        (可选) 发件人显示,默认 SMTP_USER
//   CG_DEMO_KEY      (可选) CoinGecko 免费 Demo Key,被限流时更稳
// 调试用:
//   QS_DRY_RUN=1     不发信,把邮件写到 out/email.html
//   QS_FORCE_EMAIL=1 不管有没有提醒都发一封
//   QS_MOCK=路径     用本地JSON代替CoinGecko(离线自测)
//   QS_CHROMIUM=路径 指定浏览器可执行文件
//   QS_NOW=ISO时间   覆盖"当前时间"(测试简报时段用)

import { chromium } from 'playwright';
import nodemailer from 'nodemailer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const env = process.env;
const DRY = env.QS_DRY_RUN === '1';
const FORCE = env.QS_FORCE_EMAIL === '1';
const now = env.QS_NOW ? new Date(env.QS_NOW) : new Date();

const readJson = async (p, fallback = null) => {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return fallback; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 1. 跑扫描 ---------- */
async function runScan(cfg, prev) {
  const browser = await chromium.launch(env.QS_CHROMIUM ? { executablePath: env.QS_CHROMIUM } : {});
  try {
    const ctx = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
    // 把云端设置灌进页面的 localStorage(页面本来就从那里读货币闸和自选)
    const anchor = cfg.monetaryTight ? (cfg.monetaryAnchor || prev?.gate?.anchor || null) : null;
    await ctx.addInitScript(({ tight, anchor, watch }) => {
      localStorage.setItem('qs_monetary_tight', JSON.stringify(tight));
      if (anchor) localStorage.setItem('qs_monetary_anchor', JSON.stringify(anchor));
      else localStorage.removeItem('qs_monetary_anchor');
      localStorage.setItem('qs_watchlist', JSON.stringify(watch));
    }, { tight: !!cfg.monetaryTight, anchor, watch: (cfg.watchlist || []).map((s) => String(s).toLowerCase()) });

    const page = await ctx.newPage();
    if (env.QS_MOCK) {
      const body = await fs.readFile(env.QS_MOCK, 'utf8');
      await page.route('**/api.coingecko.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body }));
    } else if (env.CG_DEMO_KEY) {
      await page.route('**/api.coingecko.com/**', (r) =>
        r.continue({ headers: { ...r.request().headers(), 'x-cg-demo-api-key': env.CG_DEMO_KEY } }));
    }

    await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href + '?cloud=1', { waitUntil: 'domcontentloaded' });

    // 页面加载即自动扫一次;失败(多半是CoinGecko限流)就等一会儿重扫,最多4次
    const waits = [0, 70_000, 120_000, 180_000];
    let status;
    for (let i = 0; i < waits.length; i++) {
      if (i > 0) {
        console.log(`第${i}次扫描失败: ${status?.error}。${waits[i] / 1000}秒后重试…`);
        await sleep(env.QS_MOCK ? 500 : waits[i]);
        await page.evaluate(() => window.performScan());
      }
      await page.waitForFunction(() => { const s = window.__QS?.status(); return s && !s.loading && (s.lastScan || s.error); }, null, { timeout: 90_000 });
      status = await page.evaluate(() => window.__QS.status());
      if (status.lastScan && !status.error) break;
    }
    if (!status?.lastScan || status.error) throw new Error(`扫描失败: ${status?.error || '未知原因'}`);
    return await page.evaluate(() => window.__QS.snapshot());
  } finally {
    await browser.close();
  }
}

/* ---------- 2. 提醒规则 ---------- */
// 返回当前"处于触发状态"的提醒。是否发邮件由下面的边沿检测决定(只在刚触发时发一次)。
function computeAlerts(snap, prev, cfg) {
  const a = cfg.alerts || {};
  const out = [];
  const pct = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;

  if (a.regimeChange && prev && prev.regime !== snap.regime)
    out.push({ key: `regime:${snap.regime}`, text: `市场状态变化:${prev.regime} → ${snap.regime}` });

  if (a.gateFlip && prev && !!prev.gate?.closed !== !!snap.gate.closed)
    out.push({ key: `gate:${snap.gate.closed}`, text: `总闸${snap.gate.closed ? '关闭(多头信号被否决)' : '打开(多头信号放行)'} —— 价格因子:${snap.gate.priceDowntrend ? '下跌' : '正常'},货币因子:${snap.gate.monetaryTight ? '紧缩' : '中性/宽松'}` });

  if (a.gateStale && snap.gate.stale)
    out.push({ key: 'stale', text: `货币闸需人工复核:已关闭${snap.gate.stale.days}天,期间BTC ${pct(snap.gate.stale.btcGain)}。请确认货币环境是否仍然紧缩(工具不会自动开闸)` });

  if (a.newSRR) {
    const before = new Set((prev?.srr || []).map((x) => x.s));
    snap.srr.filter((x) => !before.has(x.s)).forEach((x) =>
      out.push({ key: `srr:${x.s}`, text: `新的SRR 4/4:${x.s} $${fmtPrice(x.p)} —— ${x.reason}` }));
    // 仍在榜上的SRR保持"激活",避免掉榜又上榜时漏报、常驻时重复报
    snap.srr.filter((x) => before.has(x.s)).forEach((x) => out.push({ key: `srr:${x.s}`, text: null }));
  }

  if (a.btcMove24hPct && snap.btc && Math.abs(snap.btc.c24) >= a.btcMove24hPct)
    out.push({ key: `btc24:${snap.btc.c24 > 0 ? 'up' : 'down'}`, text: `BTC 24h ${pct(snap.btc.c24)},现价 $${fmtPrice(snap.btc.p)}` });

  if (a.watchMove24hPct)
    (snap.watch || []).filter((w) => Math.abs(w.c24) >= a.watchMove24hPct).forEach((w) =>
      out.push({ key: `watch:${w.s}:${w.c24 > 0 ? 'up' : 'down'}`, text: `自选 ${w.s} 24h ${pct(w.c24)},现价 $${fmtPrice(w.p)}` }));

  return out;
}

/* ---------- 3. 简报时段 ---------- */
// 不用"当前小时==8"来判断:GitHub的定时任务经常延迟十几分钟到一小时。
// 改成"最近一个应发时点是否已发过":晚到也会补发,但不会重复发。
function dueDigestSlot(cfg, state) {
  const hours = (cfg.digestHoursBeijing || []).slice().sort((x, y) => x - y);
  if (!hours.length) return null;
  const bj = new Date(now.getTime() + 8 * 3600_000);              // 把北京时间装进UTC字段里算
  const dayStart = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate());
  const slots = [];
  for (const d of [-1, 0]) for (const h of hours) slots.push(dayStart + d * 86400_000 + h * 3600_000 - 8 * 3600_000);
  const past = slots.filter((t) => t <= now.getTime());
  if (!past.length) return null;
  const slot = Math.max(...past);
  if (now.getTime() - slot > 6 * 3600_000) return null;           // 过期太久就不补了
  const iso = new Date(slot).toISOString();
  return state.lastDigestSlot === iso ? null : iso;
}

/* ---------- 4. 邮件 ---------- */
function fmtPrice(p) {
  if (p == null) return '—';
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (p >= 1) return p.toFixed(2);
  if (p >= 0.01) return p.toFixed(4);
  return p.toPrecision(3);
}
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const pctHtml = (v) => `<span style="color:${v >= 0 ? '#0a7d4b' : '#c0392b'}">${v >= 0 ? '+' : ''}${(v ?? 0).toFixed(1)}%</span>`;
const bjTime = (iso) => new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

function buildEmail(snap, alerts, isDigest) {
  const gate = snap.gate;
  const kind = isDigest ? (alerts.length ? '定时简报+提醒' : '定时简报') : (alerts.length ? '提醒' : '测试');
  const subject = `${alerts.length ? '⚠️ ' : ''}QUANT ${kind}｜BTC $${fmtPrice(snap.btc?.p)} (24h ${snap.btc?.c24 >= 0 ? '+' : ''}${snap.btc?.c24?.toFixed(1)}%)｜${snap.regime}｜总闸${gate.closed ? '关' : '开'}｜SRR ${snap.srr.length}`;

  const th = 'padding:6px 8px;border-bottom:2px solid #ddd;text-align:left;font-size:12px;color:#666;white-space:nowrap';
  const td = 'padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;vertical-align:top';
  const table = (head, rows) => `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;margin:6px 0 14px">
    <tr>${head.map((h) => `<th style="${th}">${h}</th>`).join('')}</tr>
    ${rows.map((r) => `<tr>${r.map((c) => `<td style="${td}">${c}</td>`).join('')}</tr>`).join('')}</table>`;
  const h2 = (t) => `<h3 style="margin:18px 0 4px;font-size:14px;color:#111">${t}</h3>`;
  const patRows = (list, n) => list.slice(0, n).map((x) => [
    `<b>${esc(x.s)}</b>`, `$${fmtPrice(x.p)}`, pctHtml(x.c24), pctHtml(x.c7),
    `${esc(x.tag)} ${x.score}/10${x.vetoed ? ` <span style="color:#b26a00">${x.softened ? '降3分·SRR例外' : '已否决·降5分'}</span>` : ''}`,
    `<span style="color:#555;font-size:12px">${esc(x.reason)}</span>`,
  ]);
  const patHead = ['标的', '价格', '24h', '7d', '信号', '依据'];

  let html = `<div style="font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;max-width:680px;margin:0 auto;color:#222;line-height:1.55">`;
  html += `<div style="font-size:12px;color:#888">QUANT Terminal v${esc(snap.version)} · 扫描时间 ${esc(bjTime(snap.time))} (北京)</div>`;
  html += `<div style="font-size:20px;font-weight:700;margin:4px 0 2px">${esc(snap.regime)} · 总闸${gate.closed ? '关闭' : '打开'}</div>`;
  html += `<div style="font-size:13px;color:#555">价格因子:${gate.priceDowntrend ? '下跌趋势' : '正常'} ｜ 货币因子:${gate.monetaryTight ? '紧缩(手动设定)' : '中性/宽松(手动设定)'}${gate.closed ? ' ｜ 多头信号已降分,最多试探仓' : ''}</div>`;

  if (alerts.length) {
    html += `<div style="margin:14px 0;padding:10px 12px;background:#fff7e6;border-left:4px solid #f0a020;font-size:13px">
      <b>本次触发的提醒</b><ul style="margin:6px 0 0;padding-left:18px">${alerts.map((a) => `<li>${esc(a.text)}</li>`).join('')}</ul></div>`;
  }

  html += h2('宏观');
  html += table(['', '价格', '24h', '7d', '30d', 'RSI'], [snap.btc, snap.eth].filter(Boolean).map((x) =>
    [`<b>${esc(x.s)}</b>`, `$${fmtPrice(x.p)}`, pctHtml(x.c24), pctHtml(x.c7), pctHtml(x.c30), x.rsi]));

  html += h2(`SRR 4/4 结构性重估(${snap.srr.length})`);
  html += snap.srr.length ? table(patHead, patRows(snap.srr, 10))
    : `<div style="font-size:13px;color:#777;margin-bottom:12px">本次无。SRR是总闸关闭期间唯一的放行通道,为空说明没有标的同时满足四项。</div>`;

  html += h2(`多头候选 Top ${Math.min(6, snap.longs.length)}(共${snap.longs.length})`);
  html += snap.longs.length ? table(patHead, patRows(snap.longs, 6)) : `<div style="font-size:13px;color:#777;margin-bottom:12px">本次无。</div>`;

  const risk = [...snap.avoid, ...snap.shorts].sort((a, b) => b.score - a.score);
  html += h2(`回避 / 偏空 Top ${Math.min(8, risk.length)}(共${risk.length})`);
  html += risk.length ? table(patHead, patRows(risk, 8)) : `<div style="font-size:13px;color:#777;margin-bottom:12px">本次无。</div>`;

  if (snap.watch?.length) {
    html += h2('自选');
    html += table(['标的', '价格', '24h', '7d', 'RSI', '标记'], snap.watch.map((w) =>
      [`<b>${esc(w.s)}</b>`, `$${fmtPrice(w.p)}`, pctHtml(w.c24), pctHtml(w.c7), w.rsi, esc(w.tags.join(' ') || '—')]));
  }

  html += h2('完整扫描报告');
  html += `<pre style="white-space:pre-wrap;word-break:break-word;font-size:12px;background:#f6f6f6;padding:12px;border-radius:4px;font-family:Menlo,Consolas,monospace">${esc(snap.report)}</pre>`;
  html += `<div style="font-size:11px;color:#999;margin-top:14px;border-top:1px solid #eee;padding-top:8px">
    云端定时任务自动生成,判定逻辑与App为同一份代码。价格是 CoinGecko 在扫描时刻的快照,下单前以交易所App为准。
    货币闸和自选在仓库的 cloud/config.json 里设置,与手机App里的开关互不同步。</div></div>`;

  const text = `${subject}\n\n${alerts.map((a) => '⚠ ' + a.text).join('\n')}${alerts.length ? '\n\n' : ''}${snap.report}`;
  return { subject, html, text };
}

async function sendEmail(mail, snap) {
  if (DRY) {
    await fs.mkdir(path.join(ROOT, 'out'), { recursive: true });
    await fs.writeFile(path.join(ROOT, 'out', 'email.html'), `<!-- ${mail.subject} -->\n${mail.html}`);
    await fs.writeFile(path.join(ROOT, 'out', 'email.txt'), mail.text);
    console.log(`[DRY RUN] 未发信。主题:${mail.subject}\n          邮件已写入 out/email.html`);
    return true;
  }
  const missing = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'MAIL_TO'].filter((k) => !env[k]);
  if (missing.length) {
    console.log(`::warning::邮件未配置(缺 ${missing.join(', ')}),本次跳过发信。扫描结果仍会保存。`);
    return false;
  }
  const port = Number(env.SMTP_PORT || 465);
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST, port, secure: port === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
  const stamp = snap.time.slice(0, 16).replace(/[:T]/g, '-');
  await transport.sendMail({
    from: env.MAIL_FROM || `"QUANT Terminal" <${env.SMTP_USER}>`,
    to: env.MAIL_TO,
    subject: mail.subject, text: mail.text, html: mail.html,
    attachments: [{ filename: `quant-scan-${stamp}.md`, content: snap.report, contentType: 'text/markdown; charset=utf-8' }],
  });
  console.log(`邮件已发送。主题:${mail.subject}`);
  return true;
}

/* ---------- 主流程 ---------- */
const cfg = await readJson(path.join(ROOT, 'cloud', 'config.json'), {});
const prev = await readJson(path.join(DATA, 'latest.json'));
const state = await readJson(path.join(DATA, 'state.json'), {});

const snap = await runScan(cfg, prev);
console.log(`扫描完成:${snap.regime} · BTC $${fmtPrice(snap.btc?.p)} · 覆盖${snap.covered} · SRR ${snap.srr.length} · 多头${snap.longs.length} · 回避/偏空${snap.avoid.length + snap.shorts.length}`);

const active = computeAlerts(snap, prev, cfg);
const prevKeys = new Set(state.activeAlertKeys || []);
const fresh = active.filter((a) => a.text && !prevKeys.has(a.key));   // 边沿触发:只报新出现的
const slot = dueDigestSlot(cfg, state);
const shouldSend = FORCE || fresh.length > 0 || !!slot;
console.log(`提醒:${fresh.length}条新触发 / ${active.length}条处于触发状态;简报时段:${slot ? '到点' : '未到'};${shouldSend ? '发邮件' : '不发邮件'}`);

let sent = false, sendError = null;
if (shouldSend) {
  // 发信失败(密码错、SMTP被拒等)不能连扫描结果一起丢:先记下错误,结果照常保存,最后再让任务标红
  try { sent = await sendEmail(buildEmail(snap, fresh, !!slot), snap); }
  catch (e) { sendError = e; console.log(`::error::邮件发送失败: ${e.message}`); }
}

await fs.mkdir(path.join(DATA, 'reports'), { recursive: true });
await fs.writeFile(path.join(DATA, 'latest.json'), JSON.stringify({ ...snap, alerts: fresh.map((a) => a.text), emailed: sent }, null, 1));
await fs.writeFile(path.join(DATA, 'state.json'), JSON.stringify({
  // 邮件没发出去(未配置/失败)就不记账,下次还会补发
  lastDigestSlot: slot && (sent || DRY) ? slot : (state.lastDigestSlot || null),
  activeAlertKeys: active.map((a) => a.key),
  lastRun: now.toISOString(),
}, null, 1));
if (slot) {   // 简报时段的完整报告留档,文件名和App里"下载.md"一致,方便日后复盘
  const stamp = snap.time.slice(0, 16).replace(/[:T]/g, '-');
  await fs.writeFile(path.join(DATA, 'reports', `quant-scan-${stamp}.md`), snap.report);
}
if (sendError) process.exitCode = 1;
