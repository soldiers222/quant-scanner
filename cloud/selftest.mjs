// QUANT Terminal — 云端自检
// 代码或配置一改动就自动跑:用真实行情把完整流程走一遍,但不发邮件、不改 data/ 里的正式文件,
// 只把结果写进 data/selftest.json。目的:改动有没有把云端弄坏,不用等下一次定时运行才知道。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-selftest-'));
fs.cpSync(path.join(ROOT, 'data'), tmp, { recursive: true });

const r = spawnSync(process.execPath, ['cloud/scan.mjs'], {
  cwd: ROOT, encoding: 'utf8', timeout: 12 * 60_000,
  env: { ...process.env, QS_DRY_RUN: '1', QS_FORCE_EMAIL: '1', QS_DATA_DIR: tmp },
});
const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(tmp, f), 'utf8')); } catch { return null; } };
const latest = read('latest.json'), derivs = read('derivs.json'), summary = read('ledger/summary.json');
let subject = null;
try { subject = fs.readFileSync(path.join(ROOT, 'out', 'email.html'), 'utf8').split('\n')[0].replace(/^<!-- | -->$/g, ''); } catch {}

const fresh = latest && Date.now() - new Date(latest.time).getTime() < 15 * 60_000;
const result = {
  time: new Date().toISOString(),
  ok: r.status === 0 && !!fresh,
  exitCode: r.status,
  scan: fresh ? {
    version: latest.version, time: latest.time, regime: latest.regime, pool: latest.pool, covered: latest.covered,
    dropped: latest.dropped && Object.fromEntries(Object.entries(latest.dropped).map(([k, v]) => [k, v.length])),
    btc: latest.btc, gate: latest.gate && { closed: latest.gate.closed, priceDowntrend: latest.gate.priceDowntrend, monetaryTight: latest.gate.monetaryTight },
    srr: latest.srr?.map((x) => x.s), longs: latest.longs?.length, avoid: latest.avoid?.length, shorts: latest.shorts?.length,
    alerts: (latest.alerts || []).slice(0, 25),
  } : null,
  derivs: derivs ? {
    time: derivs.time, sources: derivs.sources, lsFrom: derivs.lsFrom, coins: Object.keys(derivs.coins || {}).length,
    majors: Object.fromEntries((derivs.majors || []).map((s) => [s, derivs.coins?.[s] || null])),
  } : null,
  ledger: summary ? { entries: summary.entries, init: summary.init, since: summary.since, pending: summary.pending } : null,
  emailSubject: subject,
  log: `${r.stdout || ''}\n${r.stderr || ''}`.split('\n').filter(Boolean).slice(-60),
};
fs.writeFileSync(path.join(ROOT, 'data', 'selftest.json'), JSON.stringify(result, null, 1));
console.log(JSON.stringify({ ...result, log: undefined }, null, 1));
console.log(result.log.join('\n'));
