# QUANT Terminal v6.0

手机 App（可装到桌面）＋ 云端定时扫描 ＋ 邮件推送。判定逻辑与 v5.0 完全相同，一行没动。

| 部分 | 在哪运行 | 做什么 |
|---|---|---|
| App（`index.html`） | 你的手机浏览器 | 实时扫描、模式标记、报告；打开期间按 5/15/30/60 分钟定时刷新 |
| 定时任务（`cloud/scan.mjs`） | GitHub 的服务器 | 每小时扫一次；每天 08:00、20:00（北京）发简报，其余时段只在触发提醒时发邮件（含 1 小时涨跌超过 3% 的币） |

手机网页在后台或锁屏时不会自己运行，也发不了邮件，所以“定时＋邮件”放在云端。云端用无头浏览器打开同一个 `index.html` 来扫描，邮件里的数字和 App 里看到的是同一套计算。

## 部署（一次性，约 10 分钟）

**1. 建仓库并上传**
GitHub 新建一个 **Public** 仓库（例如 `quant-scanner`），把本文件夹里的全部内容传上去（包括 `.github` 文件夹）。

**2. 开启网页**
仓库 Settings → Pages → Source 选 **Deploy from a branch** → Branch 选 `main`、目录 `/ (root)` → Save。
一两分钟后 App 地址是 `https://<你的用户名>.github.io/<仓库名>/`

**3. 填邮箱密钥**
仓库 Settings → Secrets and variables → Actions → New repository secret，逐个添加：

| 名称 | 填什么 | QQ 邮箱示例 |
|---|---|---|
| `SMTP_HOST` | 发信服务器 | `smtp.qq.com` |
| `SMTP_PORT` | 端口 | `465` |
| `SMTP_USER` | 发信邮箱地址 | 你的 QQ 邮箱 |
| `SMTP_PASS` | **授权码**（不是登录密码） | QQ 邮箱 → 设置 → 账号 → 开启 SMTP 服务后生成 |
| `MAIL_TO` | 收件邮箱，多个用英文逗号分隔 | 可以和发信邮箱相同 |

其他邮箱：163 用 `smtp.163.com` / `465` / 授权码；Gmail 用 `smtp.gmail.com` / `465` / 应用专用密码。
密钥只填在这个页面里。不要写进任何文件，也不要发到聊天里。

**4. 测试**
仓库 Actions → 左侧 `quant-scan` → Run workflow → 保持 `force_email` 勾选 → Run。
约 2 分钟后应收到一封邮件。没收到就点进这次运行看日志，“邮件发送失败”后面是原因。

**5. 装到手机**
用 Edge 打开第 2 步的地址 → 菜单 → “添加到手机 / 添加到主屏幕”。之后从桌面图标打开。

## v6.0 新增的三块

**信号账本（战绩页）**
云端每次扫描，把“某个币新出现某个标记”记一笔：当时价格、BTC 价格、成交量排名、总闸状态、资金费率。1、3、7、14 天后自动回填价格，按标记统计相对 BTC 的超额收益。多头标记跑赢 BTC 算对，回避和偏空标记跑输 BTC 算对。

- 这是往前记的账，不是回测。第一批 1 天期结果在首次运行后一天出现，要两到四周才有像样的样本。
- 首次运行时市场上已有的标记也会建档，单独计数。
- 掉出扫描池的币会单独查价回填，避免只统计“还活着的”。
- 文件在 `data/ledger/`，按天一个；`summary.json` 是汇总。

**盯盘（盯盘页）**
写在 `cloud/config.json` 里，云端和 App 共用：

- `levels`：关键价位。价格穿过时推送一次，回去再穿会再推。
- `positions`：持仓。触及止损或目标、持仓币出现急跌 / 跑输大盘 / 顶部被拒等不利标记时推送。默认空。
- `majors`：主流币。它们和设了价位的币、持仓币创 7 日新高或新低时自动提醒，每币每天最多各一次。

预设的价位是 2026-11-16 按公开数据定的参考位，行情走远后需要更新。

**衍生品（报告、盯盘页、邮件）**
资金费率、持仓量、多空比。数据来自 Hyperliquid 和 OKX 的公开接口，不需要密钥；币安和 Bybit 的接口从 GitHub 的服务器访问会被拒绝，代码里保留但目前拿不到。

- 资金费率统一折算成每 8 小时，取各家中位数；持仓量各家相加。
- 持仓量 24 小时变化用自己存的历史算，首次运行后一天才有。
- 只陈列、不参与任何标记的判定；同时记进账本，攒够样本后再看它们有没有用。

**云端自检**
代码或 `cloud/` 下的配置一改动，会自动用真实行情跑一遍完整流程（不发邮件、不动正式数据），结果在 `data/selftest.json`。

## 消息与通知

- **消息列表**：App 右上角的铃铛。云端每次提醒、每次简报，以及本机扫描发现的提醒都记在这里，带未读数。
- **App 内弹窗**：有新消息时在顶部弹出，点一下进消息列表。
- **系统通知**：在消息列表里点“开启”并允许。App 开着或刚切到后台时会在通知栏弹出。
- **App 被系统关掉后收不到网页通知**：网页的后台推送依赖谷歌的推送服务，华为手机没有、国内也连不上。这种时候靠邮件——给邮箱 App 开通知，效果等同后台推送。

## 日常设置

云端的设置都在 `cloud/config.json`（在 GitHub 网页上直接点铅笔图标编辑、提交即可）：

- `monetaryTight`：货币闸。**和手机 App 里的“货币环境”开关互不同步，需要两边各改一次。**
- `poolSize`：云端扫描池，50 / 100 / 250（默认 250）。和 App 里的“扫描池”互不同步。
- `watchlist`：自选标的，邮件里单列并按阈值提醒。App 里的自选存在手机本地，云端读不到。
- `digestHoursBeijing`：每天发简报的北京时间。
- `alerts`：提醒规则与阈值。`hourlyMovePct` 是 1 小时异动阈值（默认 3，填 0 关闭，行情剧烈时邮件太多可调到 5）。`hourlyMinMcapUsd` 是异动推送的市值下限（现为 5000 万美元）。“市场状态变化”只在进入或离开 Risk-Off 时提醒。其余提醒同一条只在刚触发时发一次。

扫描频率在 `.github/workflows/scan.yml` 的 `cron` 一行。

## 需要知道的限制

- **扫描池大于 50 的代价**：此前所有验证（SRR 4/4、回避信号）都是在成交量前 50 上做的。排名 50 以后的标的上的多头信号没有回测依据；小市值的会带 NANO / MICRO 警告。想回到原口径就把 `poolSize` 和 App 里的扫描池都设回 50。
- **1 小时异动的范围**：覆盖扫描池里的标的（默认 CoinGecko 24h 成交量前 250），仍不是全市场。“1 小时”是扫描那一刻往前的滚动 1 小时。池子大了以后小币异动很多，邮件太吵可以把 `hourlyMovePct` 调高，或用 `hourlyMinMcapUsd` 设一个市值下限。
- **邮件多久一封**：计划是每小时扫一次；每天 08:00、20:00（北京）固定发简报，其余时间只在有新提醒时发。每封邮件顶部写着这条规则和“本次距上次扫描多久”。
- **怎么做到每小时一次**：GitHub 自带的定时触发不可靠（实测 4–8 小时才来一次，有时近 8 小时不来）。现在用“接力”：每次扫描结束后等 55 分钟，自己触发下一次，不依赖 GitHub 的定时。自带定时保留作保险，接力万一断了由它重新接上；手动 Run workflow 一次也能立刻重启接力。简报按“该发的时点是否发过”判断，晚到会补发，不会漏、不会重复。
- **接力的等待方式**：默认是占用一台 GitHub 的机器空等 55 分钟，公开仓库不计费。想让它不占机器：仓库 Settings → Environments → `hourly-tick` → 勾选 Wait timer 填 `55` → 保存，之后等待由 GitHub 代管。仓库改回私有时接力会自动停用（私有仓库的分钟数有限）。
- **CoinGecko 限流**：GitHub 服务器的 IP 是共享的，偶尔会被限流；脚本会自动等待重试 3 次。经常失败的话，到 CoinGecko 申请免费 Demo Key，添加为 secret `CG_DEMO_KEY`。
- **公开仓库里别人能看到**：代码、`cloud/config.json`（含自选、价位、持仓）、`data/` 下的扫描结果和账本。看不到：邮箱和密钥。
- **私有仓库的代价**：免费账户的私有仓库不能开网页托管，App 的网址打不开，消息、盯盘、战绩这些依赖云端数据的页面也就看不了（邮件不受影响）；另外 Actions 每月只有 2000 分钟免费额度，全账户共用，现在每小时一次约用 720 分钟。
- **价格是扫描时刻的快照**：邮件到手时可能已过去几分钟到几十分钟，下单前以交易所 App 为准。
- **App 的定时刷新只在 App 开着时有效**：切到后台会暂停，切回来若已过点会立即补扫。

## 用外部定时服务触发（备选，一般不需要）

现在已经用“接力”做到每小时一次，下面这套是备选方案：用外部定时服务按时调用 GitHub 的接口。

1. GitHub 右上角头像 → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token。
   Repository access 选 Only select repositories → `quant-scanner`；Permissions → Repository permissions → **Actions: Read and write**；其余不动。生成后复制令牌。
2. 在 cron-job.org 注册（免费），新建一个 cronjob：
   - URL：`https://api.github.com/repos/<你的用户名>/quant-scanner/actions/workflows/scan.yml/dispatches`
   - 时间：每小时一次（例如每小时第 5 分钟）
   - Advanced → Request method：`POST`
   - Headers：`Authorization: Bearer <令牌>`、`Accept: application/vnd.github+json`、`Content-Type: application/json`
   - Request body：`{"ref":"main","inputs":{"force_email":"false"}}`
3. 保存后点一次 Test run，返回 204 即成功，仓库 Actions 里会出现一次新的运行。

令牌只填在 cron-job.org 里，不要写进仓库或发到聊天里。它只能触发这一个仓库的 Actions。

## 本地自测（可选）

```bash
npm ci
QS_DRY_RUN=1 QS_FORCE_EMAIL=1 QS_MOCK=cloud/fixtures/sample-markets.json node cloud/scan.mjs
# 不发信，邮件写到 out/email.html。样例行情是合成数据，仅用于测试流程。
```
