# TeleAgent（星辰超级智能体）协议取证记录

> 目的：记录 `teleagent` provider 的全部协议事实**从哪里来、怎么复核**。
> 本文件是「为什么代码长这样」的唯一权威出处；改代码前先读这里。

## 产品身份

| 项 | 值 |
|---|---|
| 名称 | TeleAgent / 星辰超级智能体（桌面版） |
| 厂商 | 中电信人工智能科技（北京）有限公司（中国电信天翼 AI） |
| 官网 | https://www.teleai.com.cn/product/teleagent |
| 形态 | Electron 桌面端（Windows / macOS），定位「AI 办公搭子」，与 WorkBuddy / QoderWork / Trae Work 同赛道 |
| 内部代号 | `ct-xinghai`（星海，asar 常量 `qZe`）；引擎是 opencode 分支（`super-agent-code`，Go 二进制） |

## 取证方法（两路独立交叉印证）

| 路 | 来源 | 版本 |
|---|---|---|
| **A（本机）** | `E:\teleagent\resources\app.asar`（注册表卸载项 `DisplayIcon` 定位安装目录） | **2.5.3** |
| **B（官方包）** | 官网下载直链 `…/superCowork/sapi/api/download/redirect/win-x64` → 302 → `cdn01.teleai.com.cn/packages/2.7.0-rc.1/TeleAgent-2.7.0-rc.1-x64.exe`（签名：China Telecom AI，有效）→ 解 NSIS 内嵌 7z → app.asar | **2.7.0-rc.1** |

两路结论**逐条吻合**（API base、OpenAI 兼容、`X-Token`、token 回传、无签到端点）。

### 怎么复核（A 路，本机）

asar 头部是 chromium pickle，直接按「4 字节 size + 4 字节 header 长度 + header」读会失败（对齐算不对）。**用官方工具最省事**：

```powershell
# 注意：PowerShell 执行策略可能挡 npx.ps1，必须经 cmd 调
cmd /c "npx --yes @electron/asar extract E:\teleagent\resources\app.asar C:\temp\teleagent-asar"
```

解出后关键文件：

| 文件 | 内容 |
|---|---|
| `dist-electron/main-loader.cjs` | 入口，只 `require("bytenode"); require("./main.jsc")` |
| `dist-electron/main.jsc` | **主进程逻辑（bytenode V8 字节码，不可读）** |
| `dist-electron/main-runtime-*.js` | 22 份**可读**的 runtime bundle（各 ~4 MB，内容近乎相同，取任一即可） |
| `dist/assets/index-*.js` | renderer bundle（**端点表 `ot` 在这里**，最有价值） |
| `resources/app-update.yml` | 更新服务器 → 直接暴露 API base |
| `resources/super-agent-code-win32-x64.tar.gz` | Go 引擎二进制（47 MB，可 `strings` 提取模型 id 与头名） |

⚠️ **`main.jsc` 不可读不是障碍** —— 它的可读部分全在 `main-runtime-*.js` 与 renderer 里，
本次取证的所有结论都出自后者。

## 已确认事实（附 asar 原文）

### 1. API base 与页面常量

`main-runtime-BNQL7JGL.js`（renderer 的 `index-*.js` 里有同一份）：

```js
const go = "https://agent.teleai.com.cn/superCowork/sapi".trim(),
      VZe = "https://agent.teleai.com.cn/meter/teleagent-login/login".trim() || "",
      PM = {
        APP_PAGE:   VZe,                              // 独立部署的登录 Web App（iframe 壳）
        LOGIN_PAGE: `${go}/cowork/auth`,              // 登录页
        PROFILE_PAGE: "https://console.teleai.com.cn/accountInfo",
        TIANYI_YUN_API_KEY: "86b63fbbaef125c1fa49b018e289ab8c"   // 天翼云自动登录用，本插件不涉及
      }
```

推理 base 由 `CBe()` 拼：`function CBe(t){ return `${t || go}/api/v1` }`
⇒ **`POST {base}/api/v1/chat/completions`**。

预发环境：`agent-pre.teleai.com.cn` / `ai-pre.teleai.com.cn` / `*.teleagi.cn`。

### 2. 登录流程 = 浏览器授权 → 回调 URL 带 token

⚠️⚠️ **登录入口是 UPMS 统一认证，不是 `meter/teleagent-login/login`**
（2026-10-07 用户报障「卡在这里了」+ 白屏截图后定位）：

| URL | 实测结果 |
|---|---|
| `agent.teleai.com.cn/meter/teleagent-login/login` | **511 字节空 SPA 壳**（`<div id="root"></div>` + 一个 JS）⇒ **直接打开白屏**。它需要 `?tokenCode=` 之类的内部参数才渲染，是官方客户端 **iframe 专用**地址。**初版用的就是它，这是白屏的根因** |
| `www.teleai.com.cn/teleai-api/upms/public/auth/authorize?client_id=…&redirect_uri=…` | **302 → `/master-auth`**，返回 **1508 字节真实登录页**（标题「天翼AI开放平台-中国电信」、加载 CDN 的 `main.js`）✅ **这才是给用户开的入口** |

`client_id` 与 `redirect_uri` **不是我猜的** —— 它们从 401 响应的 `data` 字段里
**原样泄露**出来（`user_info` 不带 `X-Token` 时服务端会回一个带授权 URL 的错误）：
```json
{"code":"4001","message":"当前令牌是否存在",
 "data":"https://www.teleai.com.cn/teleai-api/upms/public/auth/authorize?client_id=Z2veLLEHhZfq3hb5hWIwqJuPajIuasYi&redirect_uri=https://agent.teleai.com.cn/superCowork/sapi/cowork/auth?source=4%26state%3D…"}
```
⇒ `client_id` = **`Z2veLLEHhZfq3hb5hWIwqJuPajIuasYi`**。
⚠️ `redirect_uri` 在 URL 里必须**预编码**（`%3A%2F%2F`…），否则 302 会截断参数。

**⚠️ 排查技巧**：**401 响应的 `data` 字段常带授权 URL** —— 想找登录入口时，
先拿一个无效/缺失的凭据去打一个业务端点，比在 asar 里翻要快得多。

`main-runtime-*.js` 的 `eOe()`（登录窗口的导航监听）：

```js
const a = new URL(o), c = a.pathname, l = a.searchParams.get("code");
if (c.includes("/cowork/auth") && l) {
  const u = a.searchParams.get("token") || void 0, f = { code: l, token: u, url: o };
  Hf = !0, i(), e(f);            // ← 拿到 {code, token, url}
}
```

renderer 的登录完成路径（`index-*.js`）：

```js
window.electronAPI.login.open({...}).then(a => {
  a?.success && a.token && t().completeLogin(a.token, "login-window")
})
```

`completeLogin(n)` 内部：`t().setToken(n); const v = await t().fetchUser()`
—— **token 直接可用，没有 code→token 的交换步骤**。

⚠️ **`code` 没有可交换的端点**：全文搜 `/oauth/token`、`exchange`、
`AUTH_SESSION_CODE` 的调用点，均无「用 code 换 token」的实现。
**不要**凭空发明一个交换端点。

自定义协议（B 路 2.7.0 补充）：`teleai-cowork://auth?token=…`（asar 常量 `p9 = "teleai-cowork"`）。
A 路 2.5.3 里对应的是 `const K9 = "teleai-cowork"`。

### 3. 为什么插件必须走「用户粘贴」

官方桌面端靠**自带 BrowserWindow 监听导航**抓 token。DSH 插件没有那个窗口，且：

- 回调地址是**服务端常量**（`LOGIN_PAGE` 写死），**没有** `redirect_uri` /
  `auth_callback_url` 参数可配 ⇒ **起本地监听没用**（服务端不会往 127.0.0.1 回跳）；
- `teleai-cowork://` 是**系统协议注册**，插件无法注册 ⇒ 也接不到。

⇒ 唯一可行：打开登录页 → 用户授权 → **用户自行取回 token** → 面板粘贴
（扩展动词 `teleagent.loginSubmitCallback`）。
这与 Antigravity「loopback 绑不上时降级为人工粘码」是同一处置思路。

⚠️⚠️ **但「取回」不是「复制地址栏」**（2026-10-07 实测，用户截图为证 ——
本笔记此前写的是「浏览器停在 `…/cowork/auth?code=…&token=…` → 复制地址栏」，
**那条路不存在**）：授权完成后地址栏实际落在

```
https://agent.teleai.com.cn/superCowork/sapi/cowork/auth?code=ucc.XXXXXX
                                       ↑ **只有 code，没有 token**
```

页面显示「登录成功 / 已完成账号校验，正在进入…」，同时 Chrome 弹出
「此站点正在尝试打开 TeleAgent」。桌面端日志给出机制：

```
[LoginWindow] Intercepted deeplink navigation from login window
[Deeplink]    Intercepted in-app deeplink navigation { route: 'auth' }
```

⇒ token 装在 **`teleai-cowork://auth?token=…`** 那条 deeplink URL 里、
靠**拦截导航**取走，**从不出现在地址栏**。

⚠️️ **但「去 Console 找它」也是错的**（2026-10-08 被用户截图证伪）：
本笔记此前写「F12 → Console 复制 `teleai-cowork://` 开头的整条链接」——
实测 Console 里**只有页面自己的脚本日志**（`SideBar.*.js`）与无关的统计拦截错误
（`rumt-zh.com` 被广告插件 block、favicon 404），**没有任何 deeplink**。
原因有两条，都已在用户机器上核实：

1. 浏览器**不会**把跨协议导航打印进 Console；
2. 桌面端日志只记「拦截发生了」，**不记 URL**：
   ```
   [Deeplink] Intercepted in-app deeplink navigation { route: 'auth' }
                                              ↑ 到此为止，没有 token
   ```
   （`%USERPROFILE%\.local\share\TeleAgent\logs\main-2.5.3.log` 全文检索证实）

**唯一能在浏览器侧看到 token 的地方是 Network 面板**，两种形态都要看：

| # | 若真实机制是 | 去 Network 面板看 |
|---|---|---|
| ① | 服务端对有效 code 直接 302 到 deeplink | 那条 `cowork/auth?code=…` 请求的 **`Location` 响应头** |
| ② | 服务端回 HTML，页面 JS 再调接口换 token | 页面发出的那个**换 token 请求的响应体** |

⚠️ **code 是一次性的**（2026-10-08 实测）：用户浏览器消费过的 code 再打一次，
返回与**假 code 逐字节相同**的响应 ⇒
**不存在「把 code 交给插件、插件去换 token」这条自动化路**，
`{"error":"get token error"}` 对真（已废）code 和假 code 一视同仁。
所以必须**勾选 Network 的「保留日志」后重新完成一次授权**，当场取 token。

⚠️ 这也**印证**了模块头那条红线：不要凭空发明 code→token 交换端点。
它确实存在（假 code 会被拒），但**不对我们开放**。

⚠️ **面板文案必须与本节一致**（`plugin-src/client/jet-hub.js` 的 `teleagentPending`
渲染块）。2026-10-08 用户报「粘贴后报错 / 点了没反应」，根因就是后端 reason
早已按实测改对、**前端首屏引导却还按地址栏写** ⇒ 用户粘回来的永远是只有 code 的 URL。
由 `tests/unit/teleagent-rpc.spec.ts` 的两条文案用例钉死。

`src/teleagent.ts` 的 `parseTeleagentCallbackInput()` 因此宽容到三种输入：
回调 URL、deeplink URL、裸 token（**并排除含空白的文本**，因为地址栏复制必带换行、
粘贴时前端已 trim，仍含空白说明用户粘的是一句话而非凭据）。

### 4. 身份头（两处独立证据一致）

main 侧 `j8t()`：

```js
function j8t() {
  const t = Rn.getState(); if (!t.token) return {};
  const e = Math.floor(Date.now() / 1e3).toString(), r = hr.randomUUID();
  return {
    "X-Token": t.token,
    "X-SuperAgent-Timestamp": e,        // ← 秒级
    "X-SuperAgent-Nonce": r,
    ...t.deviceId ? { "X-SuperAgent-Device-Id": t.deviceId } : {},
    ...t.installId ? { "X-SuperAgent-Install-Id": t.installId } : {}
  };
}
```

renderer 侧 `bM()` 的头集合（`await jC()` 取版本/OS、`appAuth.getDeviceId()`）：
`X-Timestamp` / `X-Nonce` / `X-App-Version` / `X-OS-Type` /
`X-SuperAgent-Device-Id` / `X-Token` / `X-Channel-Id` / `X-Runtime-Env`。

NewApi provider 的固定头 `TBe`：

```js
TBe = { "X-Route-Target": "ops-gateway", ...BUt }   // BUt 是 runtime-env 头，可空
```

⚠️ **`X-SuperAgent-Timestamp` 是秒级**（`Math.floor(Date.now()/1e3)`）。写成毫秒会被判越界。

⚠️ **Go 二进制里有 `X-SuperAgent-Signature` 字符串，但推理端点不需要它** ——
判据：`j8t()`（用于 chat/completions 的那组头）**不含** signature，只含
token/timestamp/nonce/device/install。二进制里的签名属其它通道（工具/沙箱），
**不要**据此给推理加签名。

### 5. 两个凭据在两个头上（最容易踩）

```js
const JFt = { newApi: { apiKey: "sk-uvptyXtdMUmf1iuokBw7" } };   // 图像读通道用的 key
...
$(`${Cy.NewApi.baseURL}/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json",
             Authorization: `Bearer ${JFt.newApi.apiKey}`,
             ...Cy.NewApi.headers, ...j8t() }                     // ← X-Token 在这里
})
```

默认 provider 模板 `OUt.NewApi.options`：

```js
{ baseURL: _Be, apiKey: "sk-qvp4m6h9g20uM6PgYP7E", headers: TBe,
  useSuperAgentAuth: !0, timeout: 20*60*1e3, chunkTimeout: 15*60*1e3 }
```

⇒ **`Authorization: Bearer <内置渠道 apiKey>` + `X-Token: <用户 token>`**。
两处 apiKey 值不同（`sk-uvpty…` 用于图像读小通道，`sk-qvp4m…` 是主 NewApi 模板）；
本插件用主模板那个（`sk-qvp4m6h9g20uM6PgYP7E`）。

### 6. 模型目录

`OUt.NewApi.models = KG`，原文注释：

```js
// 只保留内部系统模型种子（Unit 2 / D9）：档位/前沿模型来自下发目录缓存，
// 主进程在构造 ServerManagerMix 前用 model-catalog-spawn-config 组装覆盖这里。
```

种子表：

```js
const Wee = ["chat-nano", "chat-lite"], XG = "chat-nano", Gh = "chat-lite";
const KG = {
  "chat-nano": { id:"chat-nano", name:"轻速", limit:{ context:1e5, output:16384 }, options:{ tool_stream:!0 } },
  "chat-lite": { id:"chat-lite", name:"轻量", limit:{ context:1e5, output:16384 }, options:{ tool_stream:!0 } }
}
```

第三个档位 `chat-pro` 出自 **Go 引擎的示例会话数据**（二进制内嵌）：
`"model":{"providerID":"NewApi","modelID":"chat-pro"}` —— 真实存在，但
`KG` 里没有它的 limit（由服务端目录下发）。

⇒ 兜底表三条：`chat-nano` / `chat-lite` / `chat-pro`，窗口统一 100K、输出 16384
（「预置模型上下文长度：**预置档位共享一份配置**」是 asar 原文，故沿用种子口径）。

⚠️ **`chat-pro` 的窗口是「共享口径」推论，不是逐个实测**（与 Qoder `dmodel`
填 1M 同型：口径成立、上限未探明）。实测后要校正。

### 7. 无续期端点

asar 全文检索 `refresh_token` / `ExchangeToken` / token 刷新调用 ⇒ **0 命中**。
脱敏字段集合里有 `"refreshtoken"` 但那是**日志脱敏名单**，不是端点。

⇒ `isTeleagentRefreshable()` 恒 `false`；`refresh()` 退化为「探测有效性」
（调 `user_info`），失败抛 `RefreshTokenExpiredError`（**name 必须精确**，
`src/refresh.ts:23` 按 name 判终态）。

### 8. 过期时间：登录响应不给，但**藏在 token 里**（本节结论 2026-10-07 修正过）

登录回调只带 `code` / `token`，**没有** `expires_in` —— 这一点仍然成立。
但本节此前还写着「token 也不是 JWT」，**那是错的**：

```
Em9xR4.eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE3OTM4…,…,"accountId":"…","tenant":"…"}…
└─ tenant 前缀 ─┘ ──────────── 标准三段式 JWT ────────────┘
```

payload 含 `exp` / `nbf` / `iat` / `accountId` / `accountName` / `attr` / `tenant` /
`certType`，实测 `exp` ≈ **30 天后**。
⇒ `teleagentCredentialExpiresAtMs()` 现**优先**显式 `expires_at`、**回退**解 JWT `exp`
（⚠️ 解之前必须**剥掉 `:` 前的 tenant 前缀**，否则 `split('.')` 取不到 payload 段）。
拿不到才返回 `undefined`，`isTeleagentExpired()` 据此**保守判未过期**。

⚠️ 若把 `undefined` 当已过期，每次发消息都会先触发一次必然无效的「续期」。

⚠️⚠️ **`exp` 只作展示用**：本 provider **没有续期端点**（见第 3 节），
过期只能重新登录。别因为「能解出 exp」就以为能自动续。

⚠️ **教训：「我按我以为的格式看它不像 JWT」≠「它不是 JWT」。**
第一版看到首段是 `Em9xR4` 而非 `eyJhbGci…` 就断定不是 JWT ——
**只是没注意到前面多了个 `tenant:` 前缀**。当时只是**没去解它**。

### 9. user_info / logout

renderer 端点表 `ot`：

```js
USERINFO: `${Zt}/cowork/user_info`,
LOGOUT:   `${Zt}/cowork/logout`,
AUTH_STR: `${Zt}/cowork/auth_str`,
USAGE_QUOTA_OVERVIEW: `${Zt}/user/portal/usage/stats/overview`,
ACTIVE_USERCENTER:    `${Zt}/user/portal/companyStore/userCenter`,
NEW_ACTIVE_DAYTASK:   `${Zt}/user/portal/companyStore/v2/checkDayTask`,
ACTIVE_CHECK_DAILY_TASK: `${Zt}/user/portal/companyStore/checkTask`,
```

`fetchUser()` 读的字段：`accountId` / `accountName` / `avatar` / `phone`。

**响应信封约定**（`bM()`）：`code === 0 || code === 200 || success === true`
⇒ 取 `data`；否则业务错误。

### 10. 积分与签到：**余额与每日签到都有**（本节是一次结论修正）

> ⚠️⚠️ **本节的初版结论是错的，已被推翻。** 初版登记为
> `{ balance: false, dailyCheckin: false }`，理由是「asar 里找不到可自动调用的
> 领取端点」。**用户 2026-10-07 的客户端截图直接证伪了它**：
> 积分余额 **6100.00**、每日可领 **100** 积分、已领 **2** 天、累计 **200**、
> 按钮显示**今日已领**且禁用、「邀请共享积分」活动、夜间福利 22:00–08:00 五折。
> 保留这段错误结论与下面的修正过程，是因为**踩坑的方式本身值得记住**（见「教训」）。

#### 权威字段与端点（由 asar `hxe` 组件逐字读出）

| 截图事实 | 端点 | 字段 |
|---|---|---|
| 积分余额 **6100.00** | `GET /user/portal/companyStore/userCenter` | **`current_points_balance`** |
| 每日可领 **100 积分** | `GET /user/portal/companyStore/v2/checkDayTask` | `daily_task.daily_claimable_points` |
| 已领 **2** 天 | 同上 | `daily_task.total_claim_days` |
| 累计 **200 积分** | 同上 | `daily_task.total_claimed_points` |
| 按钮「今日已领」+ 禁用 | 同上 | `daily_task.claimed_today` |
| 按钮文案 | 同上 | `daily_task.button_text` |
| 「邀请共享积分」 | 同上 | `activity.activity_title` / `activity.action_text` |
| **领取动作** | **`GET`** `/user/portal/companyStore/checkTask?type=daily_login` | （响应形状未实测） |

asar 原文（`hxe` 组件，福利社卡片）：

```js
const C = async A => { A.stopPropagation(), g(!0)
  try { await Rn(ot.ACTIVE_CHECK_DAILY_TASK + "?type=daily_login")   // ← Rn 即 bM("GET", …)
        v(!0); const I = await Rn(ot.NEW_ACTIVE_DAYTASK); u(I ?? null); n?.() }
  catch (I) { console.log("今日领取error", I) } finally { g(!1) } }
```

以及余额渲染处（`benefit.pointBalance` 的消费点）：
`children: e?.current_points_balance`。

⚠️ **领取是 GET 而不是 POST** —— `Rn` 就是 `bM("GET", …)`。写成 POST 会 404/405。
⚠️ **领取响应不被客户端解析**（只 `await`，随后**重查面板**刷新 UI）⇒ 形状未知。
本插件的实现因此**也不解析领取响应**，而是领取后重查 `checkDayTask` 拿权威状态
（见 `src/teleagent-credits.ts` 的 `claimTeleagentDailyCheckin`）。

#### ⚠️ 教训：**关键词搜索对「业务域词汇」必然漏检**

初版为什么漏掉这两个端点？我当时在 asar 里搜的关键词是
`/api/`、`credit`、`point`、`signin`、`checkin`、`balance`、`campaign` —— 而：

- 端点路径是 `user/portal/companyStore/…`，**不含上述任何一个词**
  （既没有 `api`，也没有 `credit`/`point`/`signin`）；
- 字段名是 `daily_claimable_points` / `total_claim_days` / `current_points_balance`
  这种**业务自定义**命名，同样不含通用词。

⇒ 两轮关键词搜索都是**空结果**，于是我得出了一个**看起来很确定**的否定结论。
**「搜不到」≠「不存在」**，尤其当搜索词是「我以为它该叫什么」而不是
「它实际叫什么」的时候。

✅ **正确的复核姿势（本次正是这么解出来的）**：
**先在 renderer 里搜「界面文案的 i18n key」**（如 `settings.benefit.pointBalance`、
`settings.welfare.dailyClaim`、`settings.welfare.claimedToday`），
再顺藤找到**渲染该文案的组件**，读出它消费的**字段名**，
以及产出该字段的 `Rn(ot.XXX)` 调用 —— 一路都是**实证的名字**，不靠猜词。

⚠️ 附带确认：`window.open(...star-welfare)` 那个分支**确实存在**，
但它是**「更多/详情」入口**（`T = () => { … o("welfclub") … }` 挂在 `detail` 按钮上），
**不是**领取按钮 —— 初版把「有个网页入口」误读成了「只能去网页领」。
**同一个组件里可以既有自动领取、又有网页详情入口**，别看到后者就否定前者。

⚠️ **另一种已证伪的验证思路**（别重复）：
想借 Qoder 那条「404 = 路径不存在、401 = 认证层」的判据，用**无效 token**
打这些路径来判断端点是否存在 —— **在本站不成立**：实测该 base 下
**任意路径**（含故意拼错的 `companyStroe` 与完全不存在的 `/definitely/not/...`）
未认证时**一律返回 200 + SPA 落地页 HTML**。故端点存在性**只能靠真实凭据验证**，
或靠上述「从 UI 反向追」的源码证据。

⚠️ **`usage/stats/overview` 仍然不是余额** —— 它是 **token 用量报表**
（`HX()` 拼 `startDate`/`endDate`/`modelLevel`/`toolName` 分页参数）。
初版把它当成「没有余额形状」的论据，这条判断本身没错，但**不影响余额另有其端点**。


## 12. ⚠️ 推理端点**需要签名**（2026-10-07 实测发现；业务端点不需要）

> 这是本节最重要的一条 —— 它**推翻了第 4 节「推理端点不需要签名」**的结论。

### 现象与两个**误导性**错误码

| 请求 | 响应 |
|---|---|
| `chat/completions`，只带 `X-Token`（业务端点那套） | **403** `{"code":40301,"message":"检测到客户端版本过低，请检查新版本并升级以继续使用"}` |
| 同上 + 带 `X-App-Version`（任意值） | **401** `{"code":40104,"message":"unsupported sign version"}` |
| `cowork/user_info` / 余额 / 签到，只带 `X-Token` | **200**（业务端点**确实不需要**签名） |

⚠️⚠️ **`40301` 的文案会把人带偏**：它写「客户端版本过低」，
但**与版本号完全无关** —— 实测把 `X-App-Version` 从 `2.5.3` 一路扫到 `3.0.0`，
错误**一模一样**。真正缺的是**签名头**。
⇒ **判据：见到 `40301` / `40104` 就去查签名，不要先去改版本号。**
（适配器已把这条提示拼进错误文案，见 `looksLikeSigningError`。）

### 签名算法（asar `LocalAuthService.signRequest` **原文**）

```js
const hZ = "local-v1"                        // ← 签名版本常量
class LocalAuthService {
  ensureSession() {
    return this.sessionKey ||= Lr.randomBytes(32).toString("base64url")   // ← 本地随机！
  }
  signRequest(e) {
    const n = new URL(e.url), i = `${n.pathname}${n.search}`
    const s = String(Date.now())                       // ⚠️ 毫秒
    const o = Lr.randomBytes(12).toString("hex")
    const a = [hZ, e.method.toUpperCase(), i, s, o].join("\n")
    const c = Lr.createHmac("sha256", this.sessionKey).update(a).digest("base64url")
    return { "X-SA-Sign-Version": hZ, "X-SA-Timestamp": s, "X-SA-Nonce": o, "X-SA-Signature": c }
  }
}
```

**关键推论**：`sessionKey` 是 `randomBytes(32)`、**每次进程启动新建、
不经任何服务端注册** ⇒ 服务端**不可能**校验签名内容（它没有可比密钥），
只能校验「头存在 + 版本合法 + 时间戳新鲜」。
⇒ 本插件**自己生成**一个并持久化（`TELEAGENT_SIGN_KEY_REF`，与 deviceId 同策略）。
⚠️ **这仍是待端到端确认的假设**（`scripts/probe-teleagent-infer-sign.mjs` 可验）。

### ⚠️ 头有**两套**，且都必须发

| 组 | 头名 | 来源 | 时间戳单位 |
|---|---|---|---|
| `X-SA-*` | `Sign-Version` / `Timestamp` / `Nonce` / `Signature` | asar renderer 的 `LocalAuthService` | **毫秒** |
| `X-SuperAgent-*` | `Sign-Version` / `Timestamp` / `Nonce` / `Signature` / `Device-Id` / `Install-Id` | **Go 二进制**的 `rununit.HeaderNames` | **秒** |

⚠️⚠️ **两组的时间戳单位不同**（毫秒 vs 秒）—— 写混会被判越界。
⚠️⚠️ **`X-SuperAgent-Signature` / `X-SuperAgent-Sign-Version` 只存在于 Go 二进制里**，
**不在** renderer 代码里（renderer 的 `sYt()` 只有
Timestamp/Nonce/Device-Id/Install-Id）⇒ **只读 renderer 必然漏掉它们**
（我第一版就漏了，症状是 `40101 missing super agent security headers`）。
Go 二进制里的原文（头名连续拼接）：
```
X-SuperAgent-Timestamp X-SuperAgent-Device-Id X-SuperAgent-Signature X-TeleAI-Run-Unit-Type
```
（`X-SuperAgent-Sign-Version` 在字符串池另一处，是独立常量。）

### 签名链路（Go 侧符号表原文）

```
SuperAgentTransport.RoundTrip
  → readAuthState          （读 SUPER_AGENT_AUTH_STATE 环境变量）
  → AKSKSigner.Sign / GatewaySigner.Sign
      → jwtThirdSegment → sha256Hex → hmacHex
```

`SUPER_AGENT_AUTH_STATE` 由 main 进程注入，内容是**AES-256-GCM 加密的 auth state**：
```js
function Vle(t, e) {                       // t = authState, e = sessionKey
  const r = randomBytes(12), n = sha256(e)
  const i = createCipheriv("aes-256-gcm", n, r)
  return { version: "v1", iv, tag, ciphertext }   // 全部 base64url
}
```
⚠️ 即**引擎侧**还有它自己的一层签名（用 auth state 里的凭据）。
**我们走的是 renderer 那条（`X-SA-*`）** —— 两条路径，别混。

### ⚠️ 另外两个已修正的错误认知

1. **`deviceId` 是 12 位 hex，不是 32 位** —— 实测
   `app-auth/device-meta.json` 的 `"deviceId": "e88088715b6f"`。
   第一版按 TRAE 的惯性写成 32 位 hex，形态与真实客户端不符。
   （同文件 `installId: "3dd337f8-0e74-491e-afd6-0c0edf6df3d8"`，UUID 形态。）
2. **token **有**明确过期时间** —— 它是标准 JWT，payload 含
   `exp` / `nbf` / `iat` / `accountId` / `accountName` / `attr` / `tenant` / `certType`。
   实测 `exp` = 2026-11-05（约 30 天）。
   ⇒ 第 3 节「token 没有可解析的过期时间」**对 JWT 本身不成立**；
   准确说法是「登录回调不带 `expires_in`，且我们此前**没去解 JWT**」。
   ⚠️ 但 `exp` 只作**展示**用：本 provider 无续期端点，过期只能重新登录。
   已在 `teleagentCredentialExpiresAtMs` 里**优先解 JWT `exp`**（回退 `expires_at`）。

### ✅ 已验证可用（用真实 token 实测，2026-10-07）

| 端点 | 结果 |
|---|---|
| `GET /cowork/user_info` | **200**，返回 `accountId` / `accountName` / `phone` |
| `GET /user/portal/companyStore/userCenter` | **200**，`current_points_balance: "6100.00"`（与截图逐字吻合） |
| `GET /user/portal/companyStore/v2/checkDayTask` | **200**，`daily_claimable_points:100` / `total_claim_days:2` / `total_claimed_points:200` / `claimed_today:true` / `button_text:"今日已领"`（与截图**完全一致**） |
| 去掉 `X-Token` 打 `user_info` | **401** `4001 当前令牌是否存在`（证明 `X-Token` 是唯一鉴权头） |
| 用 `Authorization: Bearer <用户token>` 打 `user_info` | **401**（同样证明「两个凭据在两个头上」） |

⚠️ **一个已证伪的验证思路**（别重复）：想用**无效 token** 判断端点是否存在
（借 Qoder 那条「404=路径不存在 / 401=认证层」的判据）—— **在本站不成立**：
该 base 下**任意路径**（含故意拼错的路径）未认证时**一律 200 + SPA 落地页 HTML**。


## 未决项（**已知未知**，不要当成已解决）

> 2026-10-07 更新：用户登录官方客户端后，我们拿到了**引擎日志**这条新的取证渠道
>（见下 §11），它把第 2、3 项的**证据强度**从「未实测」提升到「引擎自己声明的能力」，
> 但**没有**解决第 1 项（拉取端点仍未知）。

| # | 项 | 现状 | 影响 |
|---|---|---|---|
| 1 | **模型目录的拉取端点** | 目录由服务端下发后缓存进**账号级** `model-catalog`（asar 原文），由 Go 引擎 spawn 时消费。我在 main / renderer / `@teleai-agent/*` / Go 二进制里**都没定位到**拉取它的 HTTP 路径（`/api/v1/general/config/{key}?config_type=` 的 key 未解出）。⚠️ 2026-10-07 实测：**该缓存文件根本不落盘**（`~/.local/share/TeleAgent` 下没有 `model-catalog*`），可能是纯内存态 | `fetchModels()` 目前**只返回兜底表、不发请求**。⇒ 服务端新增档位时用户看不到。**不凭猜测发可能 404 的请求**。✅ **替代取证**：引擎日志的 `[provider/list]` 已给出**provider 级**清单（见 §11），但**模型级**清单（`NewApi` 下有哪些档位）仍需从日志里「实际用过哪些模型」反推，或抓到真正的拉取请求 |
| 2 | **思考档位** | `KG` 种子没有 `thinking_config` / `effort_options`。✅ **但引擎日志已给出权威能力**：`GetModelCapabilities provider="NewApi" model="chat-lite"` → **`Reasoning:false`**（见 §11） | `resolveModel` **不声明** `reasoning`（UI 显示「未提供推理等级」）—— **日志证明这是对的**，不是偷懒。⚠️ 但只覆盖 `chat-lite`；`chat-nano` / `chat-pro` 的 `Reasoning` 未实测，**不要**据 `chat-lite` 外推 |
| 3 | **图片输入** | 同上：日志给 `chat-lite` 的 **`Image:false`** | `supportsImage` 恒 false ⇒ 收到图片**报错而非静默丢图**。**日志证明 `chat-lite` 确实不支持**；其余两条未实测，实测通过后再逐模型改 |
| 4 | **token 有效期** | 回调不带、token 非 JWT | 显示「有效期未知」；失效表现为 AUTH |
| 5 | **`X-Channel-Id` / `X-Runtime-Env` 的取值** | renderer 从 `channel.getChannelId()` 取，未追到实现 | 未下发（可选头）。若服务端将来强校验需补 |

## 11. 引擎日志：登录后新增的**权威取证渠道**（2026-10-07）

用户登录官方客户端后，`~/.local/share/TeleAgent/users/<accountId>/log/super-agent-server-<date>.log`
（本次 37 KB）里直接记录了引擎的**内部状态**，比猜端点可靠得多。三个最有价值的行：

```
[provider/list] registry=[openrouter groq ollama NewApi anthropic openai ark]
  result_all=[NewApi alibaba-cn deepseek kimi-for-coding minimax-cn modelscope moonshotai-cn
              siliconflow-cn stepfun tencent-coding-plan tianyi-token-plan xiaomi
              xiaomi-token-plan zhipuai zhipuai-coding-plan]
  custom_in_result=false connected=[NewApi] hasEnabled=true disabled=map[]

resolveModel, return direct model: NewApi/chat-lite

GetModelCapabilities provider="NewApi" model="chat-lite"
  capabilities={Temperature:false Reasoning:false Attachment:false ToolCall:true
                Input:{Text:true Audio:false Image:false Video:false PDF:false}
                Output:{Text:true Audio:false Image:false Video:false PDF:false} Interleaved:false}

[cost] provider=NewApi tokens(in=2534 out=793 cacheRead=256) cost=$0.000000
```

**读出来的四件事**：

1. **模型目录的 provider 级清单**：`NewApi` 是**唯一已连接**的内置渠道
   （`connected=[NewApi]`）；其余 15 个（`alibaba-cn` / `deepseek` / `zhipuai` /
   `minimax-cn` / `modelscope` / `stepfun` / `xiaomi` / `siliconflow-cn` …）
   是**需用户自带 API key 的 preset** —— 与本插件无关（我们只走内置渠道）。
2. **模型命名是 `NewApi/<id>`**（`resolveModel, return direct model: NewApi/chat-lite`），
   印证 asar 的 `providerID:"NewApi"` 与 `smallModelRef: "NewApi/chat-lite"`。
   ⇒ 我们传给 `chat/completions` 的 `model` 字段应只是 `<id>`（如 `chat-lite`），
   因为 `NewApi/` 前缀是**引擎内部的 provider 限定符**，不是 wire 上的模型名。
3. **能力矩阵是引擎自己声明的**：`chat-lite` 的 `Reasoning:false` / `Image:false` /
   `ToolCall:true`。⇒ **第 4 点里「不声明思考档位、`supportsImage:false`」的保守取舍
   被证实是对的**（不是「没做」），且**工具调用是支持的**（我们确实下发了 `tools`）。
4. **该账号真的用 `chat-lite` 跑通过真实任务**（2534 in / 793 out，cost=$0）。

⚠️ **日志是「本地文件 + 只读」的取证渠道，探针已实现自动提取**
（`tests/e2e/teleagent-probe.e2e.spec.ts` 的两条纯本地用例）——
**优先用它，别再去猜 HTTP 路径**。

⚠️ **`token.json` 是 Electron safeStorage 加密**（`v10` 前缀 + DPAPI，
**不是**裸 DPAPI blob —— 直接 `ProtectedData.Unprotect` 会报「数据无效」）。
**不要尝试解密**：那是用户的凭据存储。要端到端验证就用**本插件自己的登录**。

## 实测清单（需要真实账号，用户配合）

> ✅ **已完成（2026-10-07，用户登录官方客户端后）**：积分与签到端点
>（客户端截图 + asar `hxe` 组件双重确认，§10）、`chat-lite` 能力矩阵
>（引擎日志，§11）、数据根位置。见文末汇总表。
> ⬇️ 以下仍需**本插件自己的登录**（`DSH_TELEAGENT_TOKEN`）才能跑。

1. **登录闭环**：面板「+ 新建账号」→ 浏览器完成天翼账号登录 →
   **复制最终 URL** → 粘贴 → 应显示账号并回填昵称。
   ⚠️ 若最终页 URL 里**没有** `token=`（例如停在别的域名），说明该部署走的是
   deeplink 或纯 webview 内提交 ⇒ 需改 `parseTeleagentCallbackInput` 的判据。
2. **推理**：选 `chat-lite` 发一句话 → 应有流式回复。
   失败时**先看错误后缀**（`(status=…)` / `code=`）判断是 AUTH、QUOTA 还是路由问题。
   ⚠️ 另需确认 `user_info` 是否接受我们这套身份头
   （`X-Token` + **秒级** `X-SuperAgent-Timestamp` + nonce + `X-Route-Target`）——
   **这是本实现最核心的未验证假设**。用**无效 token** 试过：一律 200 + SPA HTML，
   **无法据此判断**（见 §10 末尾），必须用真实 token。
3. **工具调用**：跑一个需要工具的任务 → 确认不出现「正文里 XML 臆造调用」
   （本仓库已犯过 3 次，见 AGENTS.md）。日志已确认 `ToolCall:true`，但仍要验 wire。
4. **额度耗尽**：把积分用光 → 应报 `QUOTA_EXCEEDED`（402 已映射），
   **不应**被 harness 白重试 5 次。
5. **积分与签到闭环**：面板应显示余额（当前 **6100.00**）与「今日已领」。
   ⚠️ **重点验证响应形状**：我们**同时容忍**「套 `data`」与「平铺」两种
   （见 `unwrapData`），实测后应把**不需要的那一支删掉**，避免留下猜测性代码。
   ⚠️ 另需确认领取端点（`GET …/checkTask?type=daily_login`）在**已领**时返回什么 ——
   我们的实现**不解析**它、而是重查面板，故功能上不受影响，但值得记录。
6. **模型目录**：抓一次官方客户端的目录拉取请求（DevTools / mitm），
   拿到路径与 config key ⇒ 补 `fetchModels()`（未决项 1）。
   ⚠️ **优先用引擎日志**（`pnpm test:e2e:teleagent` 的纯本地用例自动提取），
   别再猜 HTTP 路径。
7. **图片**：带图请求 `chat-pro` / `chat-nano` ⇒ 日志只证明了 `chat-lite` 是
   `Image:false`，另两条未实测；通过则把该模型 `supportsImage` 改 true。

---

## ✅ 2026-10-07 已完成的部分（用户登录官方客户端后）

| 项 | 结论 | 证据 |
|---|---|---|
| 积分与签到端点 | **都存在，可自动调用** | 用户截图（余额 6100 / 每日 100 / 已领 2 天 / 累计 200）+ asar `hxe` 组件字段名（§10） |
| 领取方法 | **GET**（非 POST） | asar `Rn(ot.ACTIVE_CHECK_DAILY_TASK + "?type=daily_login")`，`Rn` = `bM("GET", …)` |
| `chat-lite` 能力 | `Reasoning:false` / `Image:false` / `ToolCall:true` | 引擎日志 `GetModelCapabilities`（§11） |
| 内置渠道 | 只有 `NewApi` 已连接 | 引擎日志 `[provider/list] connected=[NewApi]`（§11） |
| 数据根位置 | `~/.local/share/TeleAgent`（XDG） | 实测文件系统 + asar 注释（§11） |
| 版本一致性 | 客户端 v2.5.3 = 我们逆向的 asar 版本 | 客户端标题栏显示 v2.5.3 |
