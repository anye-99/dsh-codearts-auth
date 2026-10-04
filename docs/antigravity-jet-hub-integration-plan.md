# 把 Antigravity 接入 Jet Hub：设计方案（**已自实现落地，不依赖 dsh-agy-link**）

> 状态：**自实现版已落地（见 §12）；§13 = 2026-10-02「与其他平台接入方式保持一致」的对齐改造（范围 A + 账号卡片复用共享组件），已落地**
> 仓库：`dsh-codearts-auth`（本仓库，Jet Hub）。**不再涉及 `dsh-agy-link`**——其协议层已移植进本仓库 `src/agy/`。
> 对应源码入口：`src/antigravity-product.ts`（产品配置单一真相源）· `src/agy/`（协议层）· `src/agy-service.ts`（装配，含 `refreshAccount`/`refreshAll`）· `src/antigravity-adapter.ts`（LlmAdapter）· `src/jet-hub-rpc.ts`（标准动词的 antigravity 分派 + `antigravity.*` 扩展端点 + `cline.*` 旧名归一）· `plugin-src/client/antigravity-panel.js` + `antigravity-api.js`（面板 + 唯一出口）
> 前置阅读：`docs/adding-a-new-provider.md`（其 §「路线 C」即本次沉淀出的第三条接入路径）

**变更记录**
- **v5（本文）**：**接入方式对齐**（用户指令「把 antigravity 接入 Jet Hub 插件与其他平台接入方式保持一致」，范围 A + 面板复用共享组件）：见 §13。要点 = ① 服务经 `registerJetHubRpc` **位置参数**传入（删模块级 holder `antigravity-registry.ts`）；② 账号动作全部收进**标准动词**（`account.create/refresh/retest*/reset*`、`login.poll`、`provider.setEnabled` 的 agy 分派），扩展端点改名 `agy.*`→`antigravity.*` 并删被吸收者；③ `subscriptionQuota.*` 泛化两家共用（§6.5 的 4 处同 commit 全部落地）；④ 产品配置表 `antigravity-product.ts`、`llm-antigravity` 命名空间、`refreshTargets` 表、e2e 探针、README/AGENTS 文档补齐；⑤ 面板账号卡片复用共享 `AccountCard`（prop 注入避免循环依赖），显示列表/订阅额度复用共享面板。
- **v4**：用户指令「不调用其他工具，自己重新实现」——把对面 `dsh-agy-link` 的协议层**移植进本仓库**并自实现接入，**彻底移除对该插件的依赖**。账号池（`src/agy/pool.ts`）、Google 登录（PKCE + loopback，`src/agy/oauth.ts`/`pool-auth.ts`/`auth.ts`）、配额（`src/agy/quota.ts`）、模型目录（`src/agy/models.ts`）、进程运行（`src/agy/runner.ts`）全部本仓库自管；`gateAntigravity` 假开关闸门**删除**（黑名单/启停现在真实生效）；面板数据源从 fetch 对面裸 HTTP 改为本插件 jet-hub RPC（`agy.*` 端点）。pool.json 格式与落点（`~/.dsh/agy-accounts/pool.json`）与对面**完全兼容**（同一 `defaultPoolDir` + `AccountPoolManager`），已有账号数据无损。
- v3：用户改选**路线 A**（"不走 dsh-agy-link"）并实施。新增 §2.1 最终架构 / §2.2 能力边界 / §2.3 迁移约束 / §11 实施记录。
- v2：用户选定路线 B；新增 §3 服务契约设计；§7 增补 B 独有的两条红线。
- v1：初版方案，推荐路线 A（HTTP 薄转发）。

---

## 13. 接入方式对齐（v5，2026-10-02）

### 13.1 为什么"已落地"还要再改一轮

v4 把对面插件的形态**原样搬了进来**：私有 `agy.*` 动词集、模块级 holder、
面板自带独立账号卡。功能在，但对照 `adding-a-new-provider.md` 的骨架，
antigravity 的**接入方式**与其他 13 家不一致——不一致的实际代价：

| 不一致点 | 代价 |
|---|---|
| 服务经 holder 传入（`antigravity-registry.ts`） | `registerJetHubRpc` 的参数表数不出第 14 家；「位置参数陷阱」的复发土壤 |
| 私有 `agy.*` 动词 + 面板独立组件 | 账号启停/排序/改名/刷新在其他面板都是 `account.*` + 共享卡片，这里却是另一套调用面——下一个人改共享组件时不会想到带它 |
| 缺席 `refreshTargets` / `registerProviderSettings` / e2e / 路由清单 / 文档 | 「它是不是本插件的成员」在各清单里没有一致答案 |
| `agy.*` 前缀（二进制名）与 provider id（antigravity）混用 | 阅读歧义 |

### 13.2 对齐后的动词边界（最终形态）

**标准动词**（服务端在各 case 内按 provider 分派到 `antigravity` 形参）：
`account.list / create / update / delete / reorder / refresh / retest / retestAll /
reset / resetAll`、`login.poll`、`model.list / setDisabled*`、`provider.status /
setEnabled`、`subscriptionQuota.get / requestLog`。

分派判据两种（按请求形状，不可混）：带 `provider` 的按 `ANTIGRAVITY_PROVIDER_ID`
等值判；只有 `accountId` 的按**账号 id 反查 agy 池**（`requireAgyService` +
`pool.getAccount`）——后者是这些契约里唯一可行的判据。

**扩展动词**（`antigravity.*`，只剩无标准对应物的 9 个）：
`loginBeginPrimary`（主账号=真实 HOME）· `loginSubmitCode` / `loginCancel`
（人工粘码流）· `status` / `probe`（面板状态快照 / 慢探针）·
`setPrimary` / `setMode` / `setProxy`（池的 primary/选号策略/代理）·
`openTerminal`（隔离 HOME 开终端）。
被吸收而删除的旧端点：`agy.loginBegin`→`account.create`、
`agy.refreshQuota`→`account.retest*`、`agy.clearCooldown`→`account.reset*`、
`agy.models`→`model.list`（共享显示列表走 `listAllModels()`，信息性列表不再
需要第二套表达）。旧客户端兼容：`handleMethod` 入口把 `cline.quota` /
`cline.requestLog` 归一到 `subscriptionQuota.*`。

### 13.3 §6.5 配额泛化的落地对照（当年的 4 处绑定全部解开）

| 绑定点 | 落地 |
|---|---|
| 后端分派 | `case 'subscriptionQuota.get'`：antigravity 读账号池缓存（**不发网络**），family 双窗按 `remaining→percentUsed=(1-r)×100` 换算成 `<family>:5h/weekly`；Cline 走网关实时查询 |
| 前端渲染 | `ClineQuotaPanel` → `SubscriptionQuotaPanel({ provider, rpcCall, onClose })`；`quotaWindowLabel` 认识 `<family>:5h/weekly` 形态 |
| 文案 | 按钮 title / 弹窗 hint 按 provider 分支——不给 agy 说「Cline」「月窗口」「逐笔记录」 |
| 用例 | `toEqual(['cline'])` → `toEqual(['cline','antigravity'])`（同一变更集内） |
| 不提供记录的诚实表达 | `subscriptionQuota.requestLog` 对 agy 回 `note` + 空表；面板显示原因不渲染假空表 |

### 13.4 面板复用共享组件的形状

- 账号卡片 = 共享 `AccountCard`（`antigravity-api.js` 的 `sharedCardOf()` 把
  agy 账号映射成共享形状：family cooldown → `modelRateLimits` 徽标 + 重测/重置
  禁用判据；`credentialRef` 为空 ⇒ 卡片自动不渲染凭据行；`deleteBlocked` 由面板
  按「主账号槽位不可删」填）。agy 专属区块（主账号/系统 HOME 徽标、email、代理、
  family 双窗配额、设主号/开终端按钮）经 `extra` prop 与卡下动作行**另挂**。
- 显示列表 = 共享 `ModelListPanel`（标准 `model.list`，黑名单真实生效）；
  订阅额度 = 共享 `SubscriptionQuotaPanel`。
- **共享组件经 prop 注入**（`jet-hub.js` 已 import 面板文件；反向 import 构成
  循环依赖，esbuild 会静默产出 undefined 绑定，运行期才炸）。
- 面板渲染处不得直写端点名，一律经 `antigravity-api.js` 唯一出口。

### 13.5 其余清单项与测试

- 新增 `src/antigravity-product.ts`（provider id / 展示名 / family 序 /
  `antigravityProductById`）；删除 `src/antigravity-registry.ts`（holder）与
  `src/antigravity-pool.ts`（只读池快照，宿主分派改走服务后成死配置）。
- `index.ts`：`registerProviderSettings` 追加 `'llm-antigravity'`；
  `refreshTargets` 追加 `['antigravity', …agyService.refreshAll()]`
  （保守闸门配额刷新）；`registerJetHubRpc(..., vibex, agyService, modelAdapters)`。
- 测试：`plugin.spec.ts` 路由清单 12→**13 条**（含 antigravity；vibex 缺席单独
  一条反向用例钉死）；`jet-hub-rpc.spec.ts` 订阅额度组补 agy 路径 5 条行为用例
  （量纲换算 / 不发网络 / 缺席错误 / note / 旧名归一）；新增
  `antigravity-wiring.spec.ts`（27 条接线锁，含「case 边界切体」判据写法）；
  `antigravity-api.spec.ts` 重写为「标准/扩展边界 + 形状归一 + 纯函数判据」三组。
- e2e：`tests/e2e/antigravity-probe.e2e.spec.ts`（`DSH_ANTIGRAVITY_E2E=1`，
  `pnpm test:e2e:antigravity`，只读）。
- 测试隔离：`DSH_STATE_DIR` 指向每文件临时目录（agy 池解析链的第一级，
  取代原 `DSH_ANTIGRAVITY_POOL_FILE` 的读文件隔离）。

### 13.6 刻意保留的不一致（结构差别的如实表达）

`REF_PREFIX_TO_PROVIDER` 仍无 `ANTIGRAVITY`；不进备份；卡片无凭据/有效期行；
登录有「粘授权码」兜底输入框；配额走 `subscriptionQuota` 而非 `credits.*`；
模型目录带登录门控。这些不是"没对齐"，而是**非凭据型面板**的真实形态——
用例双向钉死（加了会红、删了也会红）。

---


## 12. 自实现落地记录（v4，2026-10-02）

### 12.1 架构

```
plugin-src/client/antigravity-panel.js   Jet Hub 面板（React，无 JSX）
        │  createAntigravityApi(rpcCall)
        ▼  jet-hub RPC（agy.* 端点，走 DSH connection 通道）
src/jet-hub-rpc.ts  ── handleMethod ──  antigravity 分派
        │  getAntigravityService()（antigravity-registry.ts 模块级 holder）
        ▼
src/agy-service.ts  AntigravityService（装配单例）
        ├─ src/agy/pool.ts        AccountPoolManager（pool.json 读写 + 粘性耗尽/轮询选号 + 冷却）
        ├─ src/agy/auth.ts        AuthHelper（主账号登录探针）
        ├─ src/agy/pool-auth.ts   PoolAuthFlow（副账号 PKCE + loopback 自动捕获）
        ├─ src/agy/oauth.ts       PKCE / token 交换 / 落盘 agy 格式
        ├─ src/agy/quota.ts       QuotaService（5h + weekly 双窗配额）
        ├─ src/agy/models.ts      ModelCatalog（agy models 解析 + fallback）
        └─ src/agy/runner.ts      resolveAgyBin / spawn / isolatedHomeEnv
src/antigravity-adapter.ts  LlmAdapter（spawn agy 进程 → StreamChunk；限流自动切号）
```

### 12.2 移植来源

`src/agy/` 下 15 个文件移植自 `dsh-agy-link@0.4.42` 的 `src/host/` + `src/common/`，**原样保留对面架构**（只改 import 后缀 `.ts`→`.js`、按本仓库命名）。这使 pool.json 格式、选号算法、限流判据、配额解析与对面**逐字节一致**，已有账号与冷却状态无损迁移。

**移植了**：runner / auth / oauth / pool / pool-auth / quota / models / oneshot / parser / mapper / net / recording / mirror-tool + common 的 types / pool-types。

**刻意没移植**（对面插件独有、非 Jet Hub 账号池/登录/配额/模型目录的必需品，且各自拖入私有依赖）：对面整套 client UI（61K，本仓库有自己的面板）、commands、mcp-bridge、media staging、sessions/discovery/agy-db 会话绑定。精简版适配器因此是**单轮代理**（每调用喂历史摘要 + 尾部 user），放弃跨轮工具调用连续性——多账号 + 配额/限流自动切换这个核心生产力保留，工具连续性若需要再按对面 ADR-4/7 补回。

### 12.3 新增依赖

`package.json` 增加：`qrcode` + `@types/qrcode`（后端生成授权 QR data URL）、`undici`（代理感知 fetch）、`@deepseek-ai/dsh-tools`（peer，mirror-tool 用）。

### 12.4 与对面 dsh-agy-link 的能力对照

| 能力 | 对面 | 本仓库自实现 |
|---|---|---|
| 账号池（多账号/主号/代理/模式/冷却） | ✅ | ✅ `src/agy/pool.ts` |
| Google 登录（PKCE + loopback 自动捕获授权码） | ✅ | ✅ `src/agy/oauth.ts` + `pool-auth.ts` |
| QR 码 | ✅ 对面 `/qr` 裸端点 | ✅ 后端在 `agy.loginBegin` 生成 data URL |
| 配额（5h + weekly 双窗） | ✅ | ✅ `src/agy/quota.ts` |
| 模型目录 | ✅ | ✅ `src/agy/models.ts` |
| 模型黑名单 | ✅ | ✅ 适配器 `listModels` 套 `disabledModelsFor` |
| 账号启停 / 排序 / 改别名 | ✅ | ✅ `account.update`/`reorder` 分派到 agy pool |
| 供应商级开关 | ✅ | ✅ `provider.setEnabled` 真实生效 |
| LLM 推理（进程桥接） | ✅ 会话绑定 + 工具镜像 | ✅ 精简版（单轮代理，无跨轮工具连续性） |
| 媒体/多模态 | ✅ | ❌ 先只透传文本 |
| MCP 桥 / 斜杠命令 | ✅ | ❌ 不需要（入口在 Jet Hub 面板） |

### 12.5 测试

- 重写 `antigravity-api.spec.ts`（21 条）：api 方法 → `agy.*` 端点映射 + 休眠标记 + 配额量纲/健康判据纯函数。
- 删除 `antigravity-gate.spec.ts`（5 条）：`gateAntigravity` 已删，假开关前提消失。
- 移植 `agy-rate-limit-classify.spec.ts`（4 条）：`looksLikeHardRateLimit` 判据（对面用真实事故文本锁死）。
- 保留 `antigravity-pool.spec.ts`（10 条）：`ANTIGRAVITY_PROVIDER_ID` 常量值 + pool.json 格式容错（历史只读层，数据通道虽已走 agyService，常量与格式判据仍有价值）。
- 全量 **3934 passed**；唯一失败为既有的 loomy-docs（缺不入库的本地文件，与本次无关）。
- `tsc -p tsconfig.json` exit 0（宿主 lib 15 个 agy 产物 + 适配器 + 服务 + holder 全产出）；`build:client` 客户端 bundle 正常。

### 12.6 真实 GUI 验证发现并修掉的首个缺陷：面板永久「正在读取状态」

**用户报障（2026-10-02 截图）**：Jet Hub 出现 Antigravity 条目但右侧一直停在
「正在读取 Antigravity 状态…」。

**取证**：机器上无残留 agy 进程（子进程没挂死）；独立复现脚本测得
`authStatus()` / `modelCatalog()` 各 **15.7s** —— 未登录时 `agy models` 不打印
授权 URL，spawn 要等 watchdog 杀进程才返回。两个叠加缺陷：

1. `agy.status` 端点 **await** 了登录探针与目录发现 ⇒ 首帧必卡 15s+；
2. `ModelCatalog` 失败不落缓存（`refreshIfNeeded` 的跳过条件要求
   `source === 'discovered'`，失败后 source 仍是 fallback）⇒ 面板 5s 轮询
   **每次都重新 spawn** 一个挂 15s 的子进程，请求永远在途。

**修法（四处，均已落地 + 用例锁死）**：

| 改动 | 位置 |
|---|---|
| `agy.status` 改毫秒级内存快照（不 await 任何 spawn） | `src/jet-hub-rpc.ts` |
| 慢探针独立成 `agy.probe`（面板「刷新」按钮；未登录约 15s 属真实耗时，按钮显示「探测中…」） | 同上 + `antigravity-api.js` `probe()` + 面板 `probeNow` |
| `ModelCatalog` 负缓存：失败落 `failedAt`，TTL 内不再 spawn；`forceRefresh` 破缓存 | `src/agy/models.ts`（用例 `agy-model-catalog.spec.ts` 3 条） |
| 登录成功（`agy.loginSubmitCode` phase=done）后 `forceRefresh` 破负缓存；`probeAuthStatus` 绕 60s 缓存真探 | `src/jet-hub-rpc.ts` + `src/agy-service.ts` |

**修复后实测**：status 0ms；modelCatalog 首次 16s（一次性）、二次 0ms。

### 12.7 待真实 GUI 验证 / 后续

1. 真实 GUI 点一遍（桥现在自实现，不再有"对面插件缺席"的 404——`agy.status` 直接反映本仓库 agyService 的休眠原因）。
2. 适配器的推理链路（spawn agy → 流式）只能真机验：登录一个 agy 账号后发一条消息。
3. 若要跨轮工具调用连续性，按对面 ADR-4/7 补 sessions/discovery/agy-db 移植。
4. 对面更多纯函数测试（pool/models/parser/quota，共约 70KB）可继续移植增强防回归。
5. 背景配额轮询未接（对面有 15min 间隔的 quota poller）——可加，但注意风控暴露。

---

## 1. 结论

**可以接，但不是 `adding-a-new-provider.md` 里的任何一条路径。**

那份文档的两条路径共同前提是：**本插件自己实现该 provider 的 HTTP 协议，凭据是一串可序列化的 token**。Antigravity 两个前提都不成立：

| 既有路径的硬契约 | Antigravity 的事实 |
|---|---|
| 凭据存 `ctx.credentials`，结构必须含 `access_token`（`AccountPool.findAccountIdByCredential` 的匹配依据） | 凭据由**官方 `agy` 二进制**持有。`src/host/auth.ts` 模块头明文写着 *"We never read, write, copy, or move the OAuth token file itself — the official binary owns credentials"*；macOS 上它在 Keychain（`Antigravity Safe Storage`），不落 `~/.gemini` |
| 一个账号 = 一份凭据 | 一个账号 = **一个隔离 HOME 目录** + alias + proxyUrl（`src/common/pool-types.ts` 的 `ManagedAccount.dir`），且 **primary 账号必须走真实系统 HOME** 才能保持登录态 |
| 登录 = 拿 `loginUrl` 后后台**轮询**回调（`login.poll`） | 登录 = 宿主侧 spawn 探针 → 抓 consent URL → **人工把 authorization code 粘回探针 stdin**（`AuthHelper.submitCode`），没有可轮询的服务端状态 |
| 静默续期由本插件发起（`RefreshScheduler` / `refreshAll`） | 刷新由官方二进制自己完成，本插件只在配额轮询时**读** token 换一次 HTTPS 配额查询 |
| 有积分余额 / 每日签到（`credits.*`） | 两样都没有；有的是 **family 配额**：5 小时滚动 + weekly，两个独立窗口（`FamilyQuotaInfo`） |

⇒ 需要的是一条**路径 C：跨插件代理型 provider（delegated panel）**——Jet Hub 负责"面板 + 分派"，真值来源与全部业务逻辑留在 `dsh-agy-link`。

`dsh-agy-link` 已具备完整的账号池 / 配额 / 登录 / 目录能力（`src/host/pool.ts`、`quota.ts`、`pool-auth.ts`、`auth.ts`、`models.ts`），**约 85% 的能力已在对面实现好**，本方案的实质工作量在"把对面能力暴露成 cordis 服务"和"在本仓库加分派"。

---

## 2. 路线选型（**已定：A 先落地，B 为后续阶段**）

> 2026-10-02 用户定："不走 dsh-agy-link" → **实施路线 A**（对面零改动、零发版）。
> B 的全部设计（§3 / §5 / §6.5 的连带项）保留为**下一阶段**，且 A 阶段的代码形状已按 B 预留（§2.3）。

### 路线 B：cordis 服务化（下一阶段，本轮不做）

`dsh-agy-link` 用 `ctx.provide(<name>, service)` 把账号池 / 登录 / 配额 / 模型目录暴露成 cordis 服务；本仓库按 `XxxServiceLike` 最小结构接口消费。

- ✅ 类型化、进程内直调、无 HTTP 往返，不受对面 `webServer` 是否启动影响（headless / CLI profile 下对面照样 provide，面板数据通道一致）
- ✅ 生命周期由 cordis scope 管理：对面卸载 → 服务消失 → 本仓库下一次 `readService` 拿到 `undefined`，天然降级，无需清理钩子
- ✅ **本仓库已有完全对口的成熟范式**（§3.1），实现路径清晰
- ⚠️ 对面是**独立公开发布的包**，要走它自己的门禁与"禁止自动发布"规矩 → **这是路线 B 的硬前提**（§8 决策点 1）
- ⚠️ 两边要共同维护一个服务契约 + 版本号（§3.3）

### 路线 A：HTTP 薄转发 ← **✅ 已选定实施（2026-10-02 用户定"A"）**

对面**零改动、零发版**，用现有 18 个端点 + 现有持久化文件即可覆盖大部分能力。最终架构与能力边界见 §2.1 / §2.2。

### 2.1 路线 A 的最终架构（定稿）

关键发现改变了实现形状：**宿主侧不需要任何端口发现**。

| 层 | 通道 | 依据 |
|---|---|---|
| **浏览器 → 对面动作/读** | 同源 `fetch(win.location.origin + '/plugins/agy-link/*')` | 对面自己的面板就是这个写法：`dsh-agy-link/src/client/index.ts:96` 的 `const base = win.location?.origin ?? ''`、`:103` 的 fetch。同 GUI 同源 ⇒ 无 CORS、无端口 |
| **宿主 → 账号数/配额快照** | **只读** `${DSH_STATE_DIR \|\| ~/.dsh}/agy-accounts/pool.json`（`AccountPoolData` 形状） | `defaultPoolDir()` 在 `dsh-agy-link/src/host/pool.ts:17-20`，该文件即对面 `save()` 的产物 |
| **宿主 → 模型目录** | `ctx.llm.listModels('antigravity')` —— 对面适配器已注册进 llm 路由 | `dsh-agy-link/src/index.ts:263` |

⇒ 宿主侧新增代码**只有一个** `provider.status` 的 antigravity 分支 + 一个容错的 `pool.json` 读函数；账号与配额的全部交互落在客户端面板。

⚠️ **缺席判据必须稳健**：对面未装时 `GET /plugins/agy-link/status` 可能回 404、也可能 200 + HTML，`res.json()` 会抛。必须 try/catch，并校验响应里**确有 `plugin === 'dsh-agy-link'` 字段**才算"对面在场"；否则一律降级为"未安装 Antigravity 桥"。（该字段见 `dsh-agy-link/src/index.ts:393`。）

### 2.2 路线 A 的能力边界（**如实放弃，绝不做假开关**）

| 能力 | A 下状态 | 原因 |
|---|---|---|
| 账号列表 / 登录 / 新增副账号 / 删除 / 开终端 / 代理 / 主号 / `sequential`↔`round-robin` | ✅ 完整 | 对面端点现成 |
| 5h + weekly 配额展示、重测（`refresh-quota`）、重置（`clear-cooldown`） | ✅ 完整 | 同上，且重测/重置语义天然吻合 |
| 模型列表**只读**显示 | ✅ | `ctx.llm.listModels` 或面板 fetch |
| **模型显示列表开关** | ❌ 降级为只读 | 黑名单须由对面 `AgyAdapter.listModels()` 套用；本仓库自己套 = UI 关了照样能推理 = **假开关** |
| **单账号启用/停用** | ❌ | 对面 `setAccountEnabled()` 方法在（`pool.ts:317`）但无端点 |
| **供应商级开关**（`provider.setEnabled`） | ❌ **须禁用按钮** | 其语义 = "关全部模型 + 停用全部账号"，两半在 A 下都缺。留着会显示"已关闭"而模型实际还在——正是 `jet-hub-rpc.ts:3190-3202` 那段注释要消除的落差 |
| 拖拽排序 / 改别名 | ❌ | 方法在（`:385` / `:308`）无端点 |
| 备份导出/导入 | ❌ 且**应当**排除 | 隔离 HOME 目录不是凭据，导不出可迁移之物 |

⇒ 四个 ❌ 是 A 的**能力上限**而非实现偷懒；它们恰好全部落在"需要对面动手"的集合里 ⇒ 构成 §9 的 B 阶段清单。

### 2.3 A→B 无痛迁移的硬约束（现在就按此写）

A 阶段必须把对面通道收敛成**单一出口**：浏览器侧一个 `plugin-src/client/antigravity-api.js`，宿主侧一个读函数。切 B 时**只换实现、不换调用点**：

- 面板组件只调 `antigravityApi.accounts()` / `.loginBegin()` / …，**任何地方都不得**直接出现 `fetch('/plugins/agy-link/…')`
- 这些方法的**形状**按 §3 的服务方法表定义（即 B 阶段对面要 provide 的形状）
- 缺席判定、错误归类、"404 → 未安装"的映射全部在这一层做完

这条约束是 A 不变成技术债的**唯一**保障。

### 路线 C：聚合入口卡片（不采纳）

不满足"账号列表 / 配额 / 模型开关 / 模式与主号"四项能力要求。

---

## 3. 路线 B 的服务契约设计

### 3.1 复用的既有范式（本仓库已经这么做了）

| 需要的东西 | 现成依据 |
|---|---|
| 对外暴露服务 | `src/index.ts:1497` 的 `ctx.provide('accountPool', pool)` |
| Service 子类自动注册 | cordis `Service` 基类构造函数走 `ctx.reflect.provide(name, self, this[Service.check])`，**自带可用性谓词**（见 `zcode-auth.ts` 的提醒：裸 class 不会自动注册） |
| 消费方安全读取 | `src/settings-compat.ts:44-48` 的 `readService(ctx, key)` —— 注释明确覆盖"测试替身 ctx 可能连 `get` 都没有"的形态 |
| 最小结构接口 + 逐方法探测 | `settings-compat.ts:22-35` 的 `SettingsServiceLike`，其模块注释就是本场景的准则：*"刻意全部可选：两个版本各自只实现其中一部分，调用方必须按能力探测，不能假定任一方法存在"* |

⇒ **不引入包依赖**：两边各自声明一份结构化类型，不 `import` 对面类型，不做 workspace 依赖。这与 `openai-compat.ts` / `settings-compat.ts` 的既有取向一致，也避免把对面变成 peerDependency 后撞上 AGENTS.md 记载的 dsh peer 枚举地狱。

### 3.2 服务名与提供者（**已定稿：`antigravity`**）

- **服务名 = `antigravity`**（用户 2026-10-02 定），与 llm provider id 同名。
  ✅ **已验证不冲突**：provider 路由走 `ctx.llm.registerAdapter(providers: string[], adapter)`（`@deepseek-ai/dsh-llm` 的 `lib/types/index.d.ts:244`），providers 只是该 llm 服务方法的**入参数组**，注册进 llm 内部路由表并返回 `AdapterRegistrationHandle`，**不会** `ctx.provide(providerName)` —— cordis 服务名空间不被占用，`ctx.get('antigravity')` 取到的就是我们自己的服务。
  ⚠️ 代价是**阅读歧义**：排障时看到 `'antigravity'` 要分清是服务还是 provider 路由。约定：**所有引用处加一行注释标明是"控制面服务"而非 provider id**（`antigravityControlOf(ctx)` 这个函数名仍保留，它读起来比 `getAntigravity(ctx)` 清楚）。
- 对面新增一个聚合服务类（暂名 `AntigravityControlService`），把已有的 `AccountPoolManager` / `PoolAuthFlow` / `AuthHelper` / `QuotaService` / `ModelCatalog` 包在里面统一 provide，**不要**拆成五个服务名（消费方要处理五种缺席组合，纯浪费）。
- 对面现有对象都是裸 class，故需在 `apply()` 内**显式** `ctx.provide('antigravity', ...)`；若改继承 `Service` 则自动注册但会引入 `Service.check` 语义，二选一并写进注释。

### 3.3 契约版本

服务上挂 `readonly contractVersion: 1`（常量导出）。本仓库每次拿到句柄先判：

- `undefined` → 面板显示"未安装 dsh-agy-link"，**保留 PROVIDERS 条目**（不要让左侧列表跳动）
- 有句柄但 `contractVersion` 缺失或低于要求 → 显示"需要 dsh-agy-link ≥ x.y.z"（避免"装了但方法对不上"表现为一片 undefined）
- 逐个方法可选：缺失的方法在面板上**禁用对应按钮**并给原因，而不是整面板报错

---

## 4. `dsh-agy-link` 侧改动

### 4.1 服务方法（映射到已有实现）

| 服务方法 | 已有实现 | 状态 |
|---|---|---|
| `status()` | `dormantReason` + `bin()` + `versionCache` + `catalog.get()` + `auth.status()` + `poolAuth.status()` + `pool.getPoolData()`（现已全部在 `/plugins/agy-link/status` 里聚合，`src/index.ts:388-411`） | ✅ 现成 |
| `accounts()` / `accountHealth(id)` | `pool.getPoolData()`；`getAccountHealth()`（`pool-types.ts:108`） | ✅ 现成 |
| `loginBegin/SubmitCode/Cancel` | `auth.begin/submitCode/cancelAuth` | ✅ 现成 |
| `addAccountBegin/Complete/Cancel` | `poolAuth.begin/submitCode/cancel` | ✅ 现成 |
| `refreshQuota(id?)` / `clearCooldown(id?, family?)` | `quota.refreshAccountQuota/refreshAllQuotas` + `pool.clearCooldown` | ✅ 现成 |
| `setProxy / setPrimary / setMode` | `pool.setAccountProxy/setPrimaryAccount/setMode` | ✅ 现成 |
| `removeAccount(id)` / `openTerminal(id)` | `pool.deleteAccount` + `src/index.ts:535-560` 的三平台终端 spawn | ✅ 现成（spawn 逻辑需从路由里提出来，别在路由和服务里各存一份） |
| `listModels()` / `setModelDisabled()` | `catalog` | ⚠️ 见 §5 |
| **`setAccountEnabled(id, enabled)`** | `pool.setAccountEnabled()` 已在 `src/host/pool.ts:317` 写好（且会同步清 `activeAccountIds`），`selectAccount()` 在 `:495` 已按 `!acc.enabled \|\| acc.authRequired` 过滤 ⇒ **停用真实生效** | ⚠️ 缺暴露 |
| **`reorderAccounts(ids)`** | `pool.reorderAccounts()` 已在 `:385` | ⚠️ 缺暴露 |
| **`setAccountAlias(id, alias)`** | `pool.setAccountAlias()` 已在 `:308` | ⚠️ 缺暴露 |

⇒ **对面只需要"新增一个聚合服务壳 + 把 3 个已有方法接出来 + 黑名单一块新逻辑"**，没有算法要重写。

### 4.2 保留还是撤掉 HTTP 面

`/plugins/agy-link/*` 是现有自有面板的数据通道。**保留**（撤掉会砍掉对面的独立面板入口，属越界改动）。但要在对面注明"服务面是 Jet Hub 的正道，HTTP 面为自有面板服务"，避免下一个人在两处各改一份逻辑。

---

## 5. 模型黑名单归属

服务化后这一条的答案变得比 HTTP 路线更清楚：**黑名单归 agy 自持**。

| 方案 | 评价 |
|---|---|
| ① agy 直接读 `$DSH_HOME/jet-hub/state.json` 的 `disabledModels.antigravity` | ❌ 反向依赖，把本仓库的存储格式变成公开契约。该文档格式变过（0.1.7 起才从 settings 迁到文件），且 AGENTS.md 记载它是"同机多 profile 共享" |
| **② agy 自持黑名单 + 提供 `setModelDisabled()` 服务方法** | ✅ **采纳**。`AgyAdapter.listModels()`（`src/host/adapter.ts:183`，目前**完全不套黑名单**）改为套用；写入方就在同进程同插件，广播自己发 |
| ③ 不做模型开关 | ❌ 用户明确要这项能力 |

配套要求：
- `listAllModels()` 必须能给出**不套黑名单**的全量目录 —— 本仓库 `model.list` 的"显示列表"要显示被关闭模型的正确展示名（含倍率），否则退化成裸 id（`jet-hub-rpc.ts:717-724` 的 `ModelCatalogSource` 就是这个动机）。
- agy 侧写黑名单后**自行** `ctx.emit('llm/adapters-updated')`，客户端才不会复用旧目录（`jet-hub-rpc.ts:726-755` 把这条成因写得很透：黑名单落插件自有文档 ⇒ 不触发任何宿主事件 ⇒ 「关闭后选择器仍能看到，重启才消失」）。本仓库这条路径**不能代劳**。

---

## 6. 本仓库（Jet Hub）侧改动清单

### 6.1 服务端

| 文件 | 改动 |
|---|---|
| `src/antigravity-service.ts` **（新增）** | `AntigravityServiceLike` 最小结构接口（方法**全部可选**）+ `antigravityControlOf(ctx)` 探测函数 + `contractVersion` 判定。**逐方法探测**，不假定任一方法存在。参照 `settings-compat.ts` 写 |
| `src/jet-hub-rpc.ts` | `handleMethod` 内按 `provider === 'antigravity'` 加分派：`account.list/create/update/delete/reorder/refresh/retest/retestAll/reset/resetAll`、`login.*`、`model.list/setDisabled/setDisabledMany/setAllDisabled`、`provider.status` / `provider.setEnabled` 的目录与账号来源。**不新增 `registerJetHubRpc` 形参**（服务句柄在 `handleMethod` 内按需 `antigravityControlOf(ctx)` 现取），从而不动那 16 个位置参数与全部测试调用点 |
| `src/index.ts` | 无改动（不静态 inject 该服务，见 §7 红线 1） |
| — | `credits.*` / `onboarding.*` / `cline.*` / `loomy.permanentLock` **一律不加 agy 分支**，且要验证批量端点会因能力位 `false` 跳过它 |

### 6.2 客户端

| 文件 | 改动 |
|---|---|
| `plugin-src/client/jet-hub.js` | `PROVIDERS` 加 `{ id: 'antigravity', label: 'Antigravity (Google)', icon: AGY_ICON, logoClass: 'antigravity' }`（成为**第 14 个面板**，计数口径见 AGENTS.md）；`AGY_ICON` 内联常量，可直接取对面 `src/client/brand-icons.ts` 的 `BRAND_PATHS`/`BRAND_COLORS`；面板 agy 分支渲染：QR + code 输入 + 开终端按钮 + 5h/weekly 双配额条 + dormant 提示 + 服务缺席提示 |
| `plugin-src/client/jet-hub-styles.js` | `.dim-jh-providerIcon.antigravity` 与配额条样式。⚠️ 该文件 `STYLES` 是模板字符串，**CSS 注释内绝不能出现反引号**（AGENTS.md：一次引入 6 对，esbuild 报 `Expected ";" but found "min"`，指针还指向注释行）。改完**必须跑 `pnpm build:client`**——单测只读源码文本不会失败 |
| `plugin-src/client/credits-capabilities.js` | `CREDITS_CAPABILITIES.antigravity = Object.freeze({ balance: false, dailyCheckin: false })` —— **显式写 false 而非省略**（仿 `vibex` 那条），让"为什么没有积分行"留痕。`RATE_LIMIT_CAPABILITIES` **不登记**：默认 `true` 正合语义（agy 确实限流进 cooldown，重测/重置有实际意义）。配额能力位见下方 **§6.5**（已定登记，但**不能只登记**） |

### 6.3 provider id 一致性（硬要求）

- 面板 id 必须叫 **`antigravity`**，与对面 `PROVIDER_ID`（`src/common/types.ts:5`）和 `ctx.llm.registerAdapter(['antigravity'])`（`src/index.ts:263`）严格一致，否则 `model.list` / `provider.status` 拿不到目录。
- ⚠️ **不要**用 `agy-bridge`——那是对面给 DSH 的**自定义协议哨兵**（`api: 'agy-bridge'`、`baseUrl: agy-bridge://antigravity`），不是 provider id。
- 对面**故意不调用** `registerConfigurableProviders`（`src/index.ts:269-272` 有注释：否则会在"添加提供商"列表留下一个永远未配置的 antigravity、搞乱 UI）。接入后这条**继续成立**——Jet Hub 面板就是它的配置入口，**不要**顺手补上。

### 6.4 面板形态（四项能力全选）

| 区块 | 内容 |
|---|---|
| 账号列表 | alias / email / `systemHome` / enabled / `authRequired` 徽标 / cooldown 倒计时 |
| 新增副账号 | 两步：`addAccountBegin(alias, proxyUrl)` → 展示 URL + QR → 用户粘 code → `addAccountComplete(code)`；支持取消 |
| 登录 / 重登 | 单账号授权；**宿主侧自动开浏览器**，面板同时给可点链接与 QR |
| 在该账号终端里登录 | 独有动作：`HOME=<dir> agy`（macOS osascript / Windows `cmd /k set USERPROFILE=` / Linux x-terminal） |
| 配额 | 每 family（google / anthropic / openai）两行：**5h 滚动** + **weekly**，各自百分比条 + `resetTime` 倒计时；可展开模型级 breakdown |
| 重测 / 重置 | 语义天然吻合：重测 = `refreshQuota`；重置 = `clearCooldown`；均支持"全部"批量 |
| 模式与主号 | `sequential` ↔ `round-robin`、设 primary、拖拽排序 |
| 模型显示列表 | 单模型 / 按组 / 全部批量开关（§5） |
| 供应商级开关 | `provider.setEnabled` 落到 agy pool 的全员启停 + 全量黑名单 |

另需显示两个**别的 14 个面板都没有**的维度：

1. **休眠原因**：二进制缺失或版本低于 `MIN_AGY_VERSION` → 提示"安装 / `agy update`"，**不能**显示成"未登录"（那会诱导用户点一个必然失败的登录）。
2. **primary 与副账号的差异**：primary `systemHome: true`、`dir` 为空（Keychain 场景），"开终端""隔离 HOME"对它无意义，删除逻辑也不同，卡片必须分支渲染。

---

### 6.5 配额能力位：登记，但**不能只登记**（本方案唯一带硬约束的一条）

用户 2026-10-02 定："能力位要登记"。要展示的形态正是 `subscriptionQuota` 那个位的语义（官方网关的滚动额度窗口）。**但照字面只加一行登记会被现有测试直接拦住**：

```ts
// tests/unit/credits-capabilities.spec.ts:148-154
it('订阅额度只登记给 cline（其余渠道不得渲染该按钮）', () => {
  const withQuota = Object.keys(CREDITS_CAPABILITIES).filter(supportsSubscriptionQuota)
  expect(withQuota).toEqual(['cline'])   // ← 全表推导，多登记一家立刻变红
})
```

该用例上方的注释写明了这是**与后端的硬约定**，并且"用全表推导而不是逐个列举"是**刻意的**——目的就是让顺手登记的人被迫同时改后端分派，否则前端冒出一个"点了必然报错的死按钮"（与 CodeArts 早期 `credits.balances` 那次同类缺陷）。三处绑定都要一起解：

| 绑定点 | 现状 | 必须改成 |
|---|---|---|
| 后端分派 | `jet-hub-rpc.ts:2845` 的 `case 'cline.quota'` / `:2885` `cline.requestLog`，对非 Cline 一律回 `bad-request` | 泛化为按 provider 分派（`subscriptionQuota.get({ provider })`）。antigravity 的配额数据**已随 `accounts()` 带回**（`ManagedAccount.quotas`，对面现成，无需新增读端点），只是渲染要按 family 分组展开 |
| 前端渲染 | `jet-hub.js:2712-2719` 直接 `React.createElement(ClineQuotaPanel, { rpcCall, onClose })`——**不带 provider 形参**，注释写明"面板内部固定传 'cline'" | 参数化成 `SubscriptionQuotaPanel({ provider, rpcCall })`，端点随 provider 走 |
| 文案 | 按钮 title 硬编码 *"查看 **Cline** 官方订阅额度窗口（5 小时 / 周 / 月…）与逐笔请求记录"* | 按 provider 取文案，且**不得给 agy 说"Cline"和"月窗口"** |
| 用例 | `toEqual(['cline'])` | `toEqual(['cline', 'antigravity'])`——**必须与上三处同一个 commit**，否则用例红就是 intended 的拦截 |

⚠️ **两家的数据形状不同，不能复用同一个渲染结构**：

| | Cline | Antigravity |
|---|---|---|
| 窗口 | **单套 3 个**：5h / 周 / 月 | **按 family 分组**（google / anthropic / openai），每组 **2 个**：5h 滚动 + weekly |
| 明细 | 逐笔请求记录（模型、token、积分） | 仅逐模型 `remainingFraction` + 重置时刻，**没有逐笔请求记录** |

⇒ "逐笔请求记录"那一 tab 对 antigravity **要么隐藏、要么如实显示"该渠道不提供"**——不能渲染一个空列表假装支持（这与 `credits.status` 对无签到渠道"如实返回 `null` 而不是造假状态对象"是同一条准则）。

**为什么选"泛化 `subscriptionQuota`"而不是新造一个 `familyQuota` 位**：两者语义同族（都是官方网关的滚动额度窗口），造第二个位会让"额度窗口"在代码里有两套并行表达。本仓库在 `jet-hub-rpc.ts:818-850` 的 `qoderFamily` 注册表注释里已经把这条经验写透了——*"平行 case 的数量与「漏接一处」的概率同向增长"*，应当用数据结构表达"同族"。



---

## 7. 路线 B 的两条红线

### 红线 1：绝不能静态 inject 该服务

```ts
// ❌ 禁止：对面缺席时该 fiber 永久 pending，会让 profile 启动直接失败
export const inject = ['llm', 'commands', 'antigravity']
```

本仓库对 `connection` 已经踩过并写下教训（`jet-hub-rpc.ts:760-765`：*"用惰性注入而非插件级静态 inject，因此在 headless / CLI profile 下本插件正常加载、只是不注册端点，而不是把整个插件树卡在 pending"*）。对面服务是**可选**的，缺席是常态（用户没装 agy 插件），所以必须走 `readService(ctx, 'antigravity')` 按需现取。

### 红线 2：消费方每次现取句柄，不要缓存

这与对面自身的教训方向**相反**，别搞混：

- 对面是**提供方**（注册工具/路由），一次性 `ctx.get('tools')` 会因**加载顺序**静默丢掉注册 → 它改用 `ctx.inject(['tools'], …)` 子 fiber 反应式挂载（`dsh-agy-link/src/index.ts:302-308` 记载过 `unknown tool "agy_tool"` 的事故）。
- 本仓库是**消费方**（读服务）。在 `handleMethod` 里（用户点开面板时）现取，天然晚于对面的 `apply()`，**没有加载顺序问题**；缓存句柄反而会留一个已卸载的死对象。
- ⚠️ 但**不要在插件 `apply()` 顶层取一次并存进闭包变量** —— 那等于把对面加载顺序问题重新引进来。

⇒ 纪律：**每次 RPC 处理现取；取不到就返回结构化缺席错误**，由面板渲染缺席提示。

### 其余 6 条通用坑（v1 保留）

1. **`window.open` 拿不到 transient activation。** 本仓库两步式登录契约要求 `account.create` 立即返回 `loginUrl`；而 `AuthHelper.begin()` 要**等最长 20 秒**（`URL_WAIT_MS = 20_000`）才能从子进程输出抓到 consent URL——届时浏览器早已失去用户手势窗口。
   ⇒ 沿用对面既有做法：宿主侧 `openBrowser(url)` 自动打开（`auth.ts:169-179`）+ 面板展示**可点击链接与 QR**；**不加** `window.location.href` 兜底。

2. **登录没有可轮询的服务端状态。** `login.poll` 语义是"服务端收到回调没"；agy 是"用户粘 code"。
   ⇒ 把 `poolAuth.status()` / `auth.status()` 的 `phase`（`idle/pending/submitting/ok/failed`）映射成 `login.poll` 的等待/就绪形状，前端照常轮询，但**必须由用户提交 code 才收敛**。`expiresAt`（120 秒）超时后 URL 会重发——面板要说明这点，否则用户以为卡死。

3. **配额刷新会真发 HTTPS 请求。** 对面后台每 15 分钟（`quotaPollIntervalMs`）`refreshAllQuotas()`，读本地 token + 一次 HTTPS/账号（`src/index.ts:715-732`）。受限账号已由 `shouldPollAccount()`（`src/common/pool-types.ts:97-105`）拦住，但**手动"重测"是明确绕过该闸门的路径**（对面注释写着 *"Manual force refresh from the UI bypasses this gate"*）——面板要提示：**别把风控暴露面当便利功能**。

4. **`provider.status` 对模型目录是同步调用。** `jet-hub-rpc.ts:3155` 用 `modelAdapters?.[provider]?.listAllModels()`，签名返回**数组不是 Promise**；agy 目录来自 `agy models` 子进程（30 秒超时、TTL 300 秒），不可能同步给出。
   ⇒ 服务侧提供**同步的内存快照**（对面 `ModelCatalog.get()` 已是同步读 `this.current`，天然满足；首次刷新前返回 fallback 目录）。
   ⚠️ 连带后果：`provider.setEnabled(false)` 走 `fullCatalogIds()`，目录为空时**整个关闭操作失败、不落盘不广播**（`:3233-3239`，刻意的"不关闭模型就不关闭供应商"）。所以 agy 休眠/未登录时"关闭供应商"会如实失败——**面板要把这条显示成"拿不到模型目录"，而不是笼统"未知故障"**。

5. **`account.refresh` 语义要重定义。** 其他 14 个面板的"刷新"= 续期凭据；agy 的凭据不由我们续期。
   ⇒ 对 antigravity 定义为**登录态探针**（`agy models` 成功即已登录，`looksLikeAuthFailure` 判未登录，`probeSignedIn(force=true)` 现成）+ 配额刷新。⚠️ 探针是一次子进程 spawn（15 秒超时），别接到批量"刷新全部"上做成 N 次并发 spawn——对面的 `signedInFlight` 合并在 `homeDir` 场景是关闭的。

6. **对面卸载时的降级。** 服务消失 ⇒ `readService` 返回 `undefined`，面板显示"未安装 dsh-agy-link（Antigravity 桥）"并**保留 PROVIDERS 条目**，不要让左侧列表跳动；供应商级开关在该状态下应禁用而非报错。

---

## 8. 决策记录与唯一剩余待答项

用户 2026-10-02 已定的四项：

| # | 决策 | 落点 |
|---|---|---|
| 1 | **路线 = B（cordis 服务化）** | 全文 |
| 2 | **服务名 = `antigravity`**（已验证不占 llm 路由空间，代价是阅读歧义，靠注释消解） | §3.2 |
| 3 | **label = `Antigravity (Google)`** | §6.2 |
| 4 | **对面 HTTP 面保留** | §4.2 + 下方附加纪律 |
| 5 | **配额能力位要登记** | §6.5（**含 4 处必须同 commit 的连带改动**，只加一行会被用例拦下） |

### 唯一还阻塞开工的问题：对面发版许可

`dsh-agy-link` 是**独立公开发布的包**，路线 B 要求它新增服务面（`ctx.provide('antigravity', …)` + `contractVersion` + §4.1 那 3 个补暴露的方法 + §5 的黑名单逻辑）。按它 AGENTS.md 的强制规矩：改完要过 `pnpm run check` → `pnpm build` → `pnpm test`，更新 `CHANGELOG.md` 并 bump 版本，然后**必须等用户明确说"发布"才能 publish / 建 Release**。

⇒ 请回答：**要我现在就动对面代码（跑门禁 + 改 CHANGELOG/版本号，但不发布），还是连发布一起点头？** 在你答复前我不碰 `dsh-agy-link/`。

### 附带纪律（源于决策 4"保留 HTTP 面"）

保留是对的，两个入口各有受众（对面自有面板 / Jet Hub 面板）。但**必须**加一条约束，否则两个入口会漂移：

> **HTTP 路由改为转调服务实现**，即 `registerRoutes()` 里的 handler 全部变成"`antigravity` 服务方法的薄封装"，**不得**与路由各存一份业务逻辑。
> 现状是逻辑住在 `pool` / `quota` / `auth` / `poolAuth` 这些对象里、路由只是它们的调用点，所以这一步近乎零成本；真正的风险是**将来往路由里直接塞逻辑**（例如 §4.1 表尾那条 `openTerminal(id)` 的三平台 spawn，现在长在 `src/index.ts:535-560` 的路由里）—— 那 spawn 必须先提到服务里，两个入口共用。

这条要在对面的服务壳注释里写明"服务面是正道，HTTP 面为自有面板服务且只做转调"，否则下一个改的人在两处各改一遍。

---

## 9. 分期与工作量（按路线 B）

| 期 | 内容 | 触及仓库 | 粗估 |
|---|---|---|---|
| P0 | 对面：聚合服务壳 + `ctx.provide` + `contractVersion`；本仓库：`AntigravityServiceLike` + `antigravityControlOf()` + `account.list` 一条分支打通 | 两边 | 0.5 天 |
| P1 | 登录流（URL+QR+粘 code+取消）、新增副账号、开终端 | 本仓库为主 | 1 天 |
| P2 | 对面补 `setAccountEnabled` / `reorderAccounts` / `setAccountAlias` 三个暴露 + 接线 | 两边 | 0.5 天 |
| P3 | 配额展示（5h/weekly 双条 + 模型 breakdown + cooldown 倒计时）、重测/重置映射，**含 §6.5 那 4 处同 commit 的泛化**（`ClineQuotaPanel` 参数化会动到既有 Cline 面板，属回归风险区，需 `cline-quota-panel.spec.ts` / `credits-capabilities.spec.ts` 一起过） | 本仓库 | **1 天**（原估 0.5 天不含泛化，已上调） |
| P4 | 模型黑名单（§5 方案 ②）+ `listAllModels` 同步快照 + `provider.status`/`setEnabled` 正确性 | 两边 | 1 天 |
| P5 | 能力矩阵登记 + 回归用例同步 + README/AGENTS.md 记录 + 两侧质量门禁 | 两边 | 0.5 天 |

合计约 **4.5 人日**。最大不确定性在 P3 的 Cline 面板泛化（碰既有功能）与 P4 黑名单。

---

## 10. 附：RPC ↔ 服务方法对照（实现时照此接线）

| Jet Hub 端点 | 服务方法 | 缺口 |
|---|---|---|
| `account.list` | `accounts()` | — |
| `account.create` | `addAccountBegin(alias, proxyUrl)` → `addAccountComplete(code)` / `addAccountCancel()` | 语义需适配（§7 坑 2） |
| `account.update {enabled}` | `setAccountEnabled(id, enabled)` | ⚠️ 对面缺暴露 |
| `account.update {alias}` | `setAccountAlias(id, alias)` | ⚠️ 对面缺暴露 |
| `account.delete` | `removeAccount(id)` | — |
| `account.reorder` | `reorderAccounts(ids)` | ⚠️ 对面缺暴露 |
| `account.refresh` | `probeSignedIn(force)` + `refreshQuota(id)` | 语义重定义（§7 坑 5） |
| `account.retest` / `retestAll` | `refreshQuota(id?)`（id 缺省 = 全部） | — |
| `account.reset` / `resetAll` | `clearCooldown(id?, family?)` | — |
| `login.poll` | `loginStatus()`（`poolAuth.status()` / `auth.status()` 归一） | 需映射层 |
| — | `openTerminal(id)` | 需新增 RPC `agy.openTerminal` |
| — | `setProxy` / `setPrimary` / `setMode` | 需新增 RPC `agy.proxy` / `agy.primary` / `agy.mode` |
| `model.list` | `listAllModels()`（**同步快照**）+ `listDisabledModels()` | ⚠️ 见 §7 坑 4 |
| `model.setDisabled*` | `setModelDisabled(id, disabled)` / `setModelsDisabled(ids)` / `clearDisabledModels()` | ⚠️ §5 方案 ② 新增 |
| `provider.status` | `listAllModels()` + `accounts()` | 见 §7 坑 4 |
| `provider.setEnabled` | `setAccountEnabled` × N + 黑名单全清/全关 | 见 §5 |
| `credits.*` | 不适用 | 显式登记 `false`，不发请求 |
| `backup.export/import` | 不适用（凭据不可搬运，隔离目录不是凭据） | 面板要说明 antigravity **不参与备份导出** |
| 任意方法 | 服务缺席 | 返回结构化缺席错误，面板给安装指引 |

---

## 11. 实施记录（路线 A，2026-10-02）

### 11.1 已落地

| 文件 | 内容 |
|---|---|
| `plugin-src/client/antigravity-api.js` **新增** | 对面 18 端点的**唯一出口**。缺席三态判定（`absent` / `failed` / `ok`）、响应解包、配额量纲归一（`normalizeQuotaRows` / `quotaPercentText`）、账号健康判据（`accountHealthOf`）。§2.3 的迁移约束就落在这里：面板只见方法名，不见 URL |
| `plugin-src/client/antigravity-panel.js` **新增** | `AntigravityPanel` + 四个小组件（`AgyQuotaRows` / `AgyAccountCard` / `AgyModelList` / `AgyLoginFlow`） |
| `src/antigravity-pool.ts` **新增** | 只读对面 `agy-accounts/pool.json` 快照 + `ANTIGRAVITY_PROVIDER_ID` 常量 + 计数口径 |
| `src/jet-hub-rpc.ts` | `provider.status` 的 antigravity 分支（读池快照）；`gateAntigravity` 服务层闸门（见 11.3） |
| `src/jet-hub-store.ts` | 恢复表**刻意不加** antigravity，并在表末写清"这不是第四次漏加"的理由 |
| `plugin-src/client/jet-hub.js` | `PROVIDERS` 第 15 条 + `ANTIGRAVITY_ICON`（内联 SVG base64）+ 按 id 分派到 `AntigravityPanel` |
| `plugin-src/client/credits-capabilities.js` | `antigravity: {balance:false, dailyCheckin:false}` 显式登记（含理由），使 `checkinProviders()` 自动跳过它 |
| `plugin-src/client/jet-hub-styles.js` | 图标透明底 + `.dim-jh-agy-*` 一组面板样式（**已核过注释内无反引号**） |
| `tests/setup-isolation.ts` | 新增 `DSH_ANTIGRAVITY_POOL_FILE` 指向不存在路径（见 11.2） |

用例：新增 43 条（`antigravity-api` 28 / `antigravity-pool` 10 / `antigravity-gate` 5）。
全套 **4129 passed**，唯二失败为**先前既有**：`loomy-docs`（缺不入库的 `docs/loomy-protocol-notes.md`）与 `cline-icon`（缺不入库的 `scripts/extract-cline-icon.mjs`）。
门禁：`tsc -p tsconfig.json --noEmit` exit 0、`tsc -p tsconfig.json` 产出 `lib/` 正常、`node plugin-src/client/build.mjs` 客户端 bundle 正常。

### 11.2 实施中发现并修掉的四个真问题

1. **测试会读用户真实的 agy 账号池**。`tests/setup-isolation.ts` 设的是 `DSH_JET_HUB_STATE_DIR`，管不到对面池文件的 `DSH_STATE_DIR`；不设覆盖，`provider.status` 的用例结果就取决于"这台机器装没装 antigravity、登了几个号" —— 典型"我机器上过、CI 上红"。⇒ 加 `DSH_ANTIGRAVITY_POOL_FILE`，手法与既有的 `QODER_RUNTIME_INFO` 完全一致。
2. **`provider.setEnabled` 能拿到真实模型目录**。§2.2 原本只假设"目录为空所以关不掉"，但 `fullCatalogIds()` 的第二条路径是 `llm.listModels(provider)`，而 antigravity 的适配器**已注册进 llm 路由** —— 于是它会写下一份对面永不读取的死黑名单并广播"已关闭"。⇒ 前端禁用不足以自证，另加 `gateAntigravity` 在服务层拒（11.3）。
3. **面板初版 6 层 `createElement` 嵌套连续两轮括号错** ⇒ 拆成四个小组件，每处最多 3 层；顺带暴露出一个 `? h(...)` 漏写 `: null` 的真错（不是括号数错，是三元不完整）。
4. **三处"看起来能跑、实际恒假/恒真"的缺陷**，都靠反向验证与复盘抓出：
   - `toast` 清除写 `prev?.id === Date.now()`（6 秒后的 now 不可能等于当初 id ⇒ 提示永不消失）；
   - `act` 里 `if (busy === key) await refresh()`（`busy` 是渲染闭包旧值 ⇒ 条件恒假，失败时界面停在旧状态）；
   - `mounted.current` 只在 cleanup 里置 false、不在 effect 里置回 true（被 `key` 重挂载一次后面板永久空白）。

### 11.3 能力闸门：一处"宁可拒绝也不假成功"的设计

前端因 `provider.status` 返回 `models.total === 0` 会**禁用**供应商开关，但那只挡得住 UI 路径。`gateAntigravity` 在 `handleMethod` 入口对 `model.setDisabled` / `setDisabledMany` / `setAllDisabled` / `provider.setEnabled` 四个端点、且 `provider === 'antigravity'` 时，返回稳定错误码 `jet-hub/provider-delegated` 与点明"假开关"的文案（而不是抛异常被包成 `handler-failed`）。

理由与既有惯例一致：**静默接受一个不起眼的写操作，比如实拒绝更难排查**。用例同时钉住"读端点不得被误拦"（`model.list` / `provider.status` / `account.list`），因为误拦会表现成"账号列表空白且无报错"。

### 11.4 尚未做（B 阶段清单，与 §2.2 的四个 ❌ 一一对应）

| 缺口 | 需要对面提供 | 本仓库改动量 |
|---|---|---|
| 模型显示列表开关 | 黑名单持久化 + `listAllModels()` 同步快照 + `AgyAdapter.listModels()` 套用 + 自广播 `llm/adapters-updated`（§5 方案 ②） | 撤掉 `gateAntigravity` 里的三个 `model.*` 拒绝项 + 面板加开关 |
| 单账号启停 | `setAccountEnabled` 暴露（方法已在 `pool.ts:317`） | 卡片加开关 + 解除 `provider.setEnabled` 拒绝 |
| 拖拽排序 / 改别名 | `reorderAccounts`（`:385`）/ `setAccountAlias`（`:308`）暴露 | 卡片加两个入口 |
| 配额能力位泛化 | — | §6.5 那 4 处同 commit（A 下面板自渲染配额，**未**登记 `subscriptionQuota`，故 `toEqual(['cline'])` 那条用例仍绿） |

### 11.5 验证结果（2026-10-02）

#### ① 已用**真实数据**当场验证的（比肉眼看 UI 更硬）

用本机 `~/.dsh/agy-accounts/pool.json`（对面 desktop profile 写的真账号池）驱动编译产物
`lib/antigravity-pool.js` 与前端纯函数，逐条符合设计：

| 判据 | 真实结果 | 结论 |
|---|---|---|
| 路径解析 | `C:\Users\…\.dsh\agy-accounts\pool.json` | ✅ 与对面 `defaultPoolDir()` 一致 |
| `present` / `mode` | `true` / `sequential` | ✅ |
| 缺 `enabled` 字段的账号 | 解析为启用 | ✅ 与 `entry.enabled !== false` 既有口径一致 |
| primary 账号 `dir` 为空 | `hasIsolatedDir=false` ⇒ 打「系统 HOME」标、「开终端」**禁用** | ✅ 正是避免撞对面 400 的设计 |
| 健康徽标 | `healthy` | ✅ |
| 配额双窗口 | google `5h 97% / 周 61%`、anthropic `100%/61%`、openai `100%/61%`，带更新时间 | ✅ 三 family、两独立窗口；缺失显示「未查询」而非 0% |
| 供应商开关 | `models.total=0` ⇒ 禁用，reason「该供应商没有可关闭的模型」 | ✅ 与 `provider-toggle.js:64` 判据吻合 |

测试：`antigravity-api` 28 + `antigravity-pool` 10 + `antigravity-gate` 5 全绿；受影响的
`jet-hub-store` / `zcode-wiring` / `credits-capabilities` / `provider-toggle` 合计 **172 条全绿**。

#### ② 发现并修掉的一个**真实缺陷**（不是环境问题）：缺席文案会自相矛盾

账号池落在 **dsh home 级**（`~/.dsh/agy-accounts/pool.json`），宿主侧 `provider.status`
是**直接读这个文件**计数、不经过桥；而面板取数据靠桥注册的 HTTP 端点。
⇒ 桥不在场时，"导航显示 N 个账号、面板缺席"是**必然**出现的落差，与装没装无关。

初版缺席文案写「Antigravity 未接入 / 安装 dsh-agy-link」，与导航上的账号数**直接矛盾**，
用户只会觉得界面在骗他。⇒ 现改为「Antigravity 桥当前未运行」，并说明两条通道的
在场性不同（读文件 vs 调服务）。

> 普遍教训：**宿主侧读 home 级文件、面板读 profile 级服务**时，两者的"在场性"不是同一件事。
> 以后任何跨插件读盘的设计，先问"这条数据是 home 级还是 profile 级"。

⚠️ **更正（2026-10-02 11:50）**：昨晚本节把缺席的真实情形写成"桥装在 desktop profile、
当前是 web profile"——这是**误判**。今天实测 19387 的命令行参数与 `DSH_PROFILE`
都指向 **desktop profile**，桥与 Jet Hub 在同一个 profile 里；真正的原因是
`cordis.patch.yml` 里有 `- id: agy-link / disabled: true`（与 `llm-agy` 一起被显式禁用）。
文案已随之改为同时覆盖"未安装 / 被禁用"两种情形（网络层同为 404，无法区分）。
面板注释里保留了这次误判的记录，防止下一个人再踩。

#### ③ GUI 人工验证在本会话环境里做不到（原因修正后如实记录）

1. 19387 **就是** desktop profile（进程命令行第三参数 + `DSH_PROFILE=desktop`）——
   昨晚"它是 web profile"的判断错了；
2. 该 profile 里 `dsh-agy-link@0.4.42` 已安装、注册了全部 18 条路由，但 patch 里
   `disabled: true` ⇒ 端点不注册，故 `/plugins/agy-link/status` 实测 404
   （对照：`/api/jet-hub` 是 401——Jet Hub 自己在跑）；
3. 安装版插件与工作区产物**逐字节一致**（SHA256 比对，已确认同步机制存在），
   所以"产物没同步"不构成阻塞。

1. 左侧导航出现「Antigravity (Google)」，图标为蓝紫渐变上升体、容器无白边；
2. 顶栏显示 `agy <版本>`；若二进制缺失，应显示「休眠：…」而**不是**「未登录」；
3. 「+ 新增账号」点击后按钮文案变「正在获取授权链接（约 20 秒）…」，随后出现可点链接 + 二维码；浏览器未自动打开时点链接仍可用；
4. 授权后粘贴 code → 提交 → 账号邮箱/登录态更新（对面 `markAuthRequired` 清除）；
5. 「重测所有」后各 family 百分比刷新（⚠️ 这会绕过对面的保守闸门，见 §7 坑 3）；
6. 「重置所有」清掉冷却徽标；
7. 「模型列表」出名称 + id，且**没有**任何开关控件；
4. 「+ 新增账号」点击后按钮文案变「正在获取授权链接（约 20 秒）…」，随后出现可点链接 + 二维码；浏览器未自动打开时点链接仍可用；
8. 页头「供应商」弹窗里 antigravity 一行**禁用**，tooltip 为「该供应商没有可关闭的模型」；
9. 在**没装桥**的 profile 里打开本页，应显示「当前 profile 未加载 Antigravity 桥」并说明池是 home 级共享（而非"还没有账号"）。
