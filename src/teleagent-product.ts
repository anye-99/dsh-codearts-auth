/**
 * TeleAgent（**星辰超级智能体**，中国电信天翼 AI / 中电信人工智能公司）产品配置。
 *
 * ## 为什么新建 `TeleagentProduct` 而不复用既有类型
 *
 * `BuddyProduct` / `QoderProduct` / `LoomyProduct` / `RaccoonProduct` /
 * `MinimaxProduct` 的字段全部围绕各自协议设计（归属头、WASM 签名参数、
 * 手机号加密密钥、倍率、OAuth client_id/scope…），对 TeleAgent 无一有意义。
 * TeleAgent 需要的是：**一个 API base + 一组身份头 + 兜底模型表**。
 * 故定义**平行**接口 —— 共用的是架构**模式**（产品差异收敛到单一真相源），
 * 不是那个类型。
 *
 * ## 数据来源（全部逆向官方桌面端安装包，见 docs/teleagent-protocol-notes.md）
 *
 * 取证两路**交叉印证**（同一结论、互不依赖）：
 * - 本机安装 `E:\teleagent\resources\app.asar`（**2.5.3**，dist-electron + renderer）；
 * - 官方最新包 `TeleAgent-2.7.0-rc.1-x64.exe`（签名：China Telecom AI）解出的 app.asar。
 *
 * 关键常量（asar 直读，2.5.3）：
 * - API base：`const go = "https://agent.teleai.com.cn/superCowork/sapi"`
 * - 登录页：`https://agent.teleai.com.cn/meter/teleagent-login/login`
 *   ⚠️⚠️ **但我们不用它** —— 实测那是官方客户端 **iframe 专用的空壳页**
 *   （511 字节、只有 `<div id="root"></div>` + 一个 JS，**直接打开白屏**，
 *   2026-10-07 用户报障「卡在这里了」正是此因）。真正的入口是 **UPMS 授权 URL**，
 *   见 `TELEAGENT.loginPage` 的注释。
 * - 登录回调页：`${go}/cowork/auth`（授权后导航到 `…/cowork/auth?code=…&token=…`）
 * - 推理：`POST {base}/api/v1/chat/completions`（**OpenAI 兼容**，无加密/WASM）
 * - 用户信息：`GET {base}/cowork/user_info`
 * - 内置 NewApi apiKey（引擎 `OUt.NewApi.options.apiKey`）：`sk-qvp4m6h9g20uM6PgYP7E`
 * - 兜底模型种子（`KG`）：`chat-nano`(轻速) / `chat-lite`(轻量)，均 `context:1e5, output:16384`
 *
 * ⚠️ **协议族 = OpenAI 兼容**（与 qoder 同族，但**无加密**）—— 适配器的 SSE 消费
 * 复用 `src/openai-compat.ts`，**不**新建 messages 层。这是与 minimax（Anthropic）、
 * trae（SOLO）最大的差异，也是本 provider 工作量最小的原因。
 */

/**
 * 兜底模型目录中的一个条目。
 *
 * ⚠️ **必须镜像 asar 实测值** —— 两处不一致会让「远端失败降级到兜底表」时
 * 窗口/输出**凭空变化**，且极难排查（与 minimax 同型教训）。
 */
export interface TeleagentFallbackModel {
  /** 模型 ID（传给推理端点的 `model`，即 opencode 引擎的 `NewApi/<id>` 里的 `<id>`）。 */
  id: string
  /** 展示名（照抄 asar `KG[id].name`，不加倍率/后缀）。 */
  name: string
  /**
   * 上下文窗口（asar `KG[id].limit.context`）。
   *
   * ⚠️ 种子两档都是 `1e5`（100000）。TeleAgent 的「预置档位共享一份 preset-context」
   * （asar 注释：`预置模型上下文长度（预置档位共享一份配置）`），故三个档位
   * 沿用同一窗口值。
   */
  contextWindow: number
  /** 单次输出上限（asar `KG[id].limit.output`，实测 16384）。 */
  maxTokens: number
  /**
   * 是否支持图片输入。
   *
   * ⚠️ **恒 `false` —— 这是「未实测」的保守取值，不是「实测不支持」**。
   * asar 的 `KG` 种子条目没有下发 `modalities`，无法据此判定；声明支持就必须
   * 真支持（DSH 按适配器播报的 `inputModalities` 决定是否投影图片），
   * 拿不准时**不猜**（与 minimax 的 `supportsImage` 判据同因）。
   * 实测带图请求通过后，再逐模型改这里。
   */
  supportsImage: boolean
}

/** TeleAgent 产品配置。 */
export interface TeleagentProduct {
  /** provider 标识：注册到 `ctx.llm` 的路由名，也是账号列表的 provider 字段值。 */
  id: 'teleagent'
  /** 设置页 / 模型选择器展示名（与客户端 `PROVIDERS` 的 label 保持一致）。 */
  displayName: string
  /** API base（推理 + 业务端点共用）。 */
  apiBase: string
  /** 登录页（浏览器打开它完成天翼账号授权）。 */
  loginPage: string
  /** 授权回调页前缀（用户从浏览器地址栏复制这条带 `token=` 的 URL）。 */
  authCallbackBase: string
  /** 内置 NewApi apiKey（推理 `Authorization: Bearer` 用，asar 硬编码）。 */
  inferApiKey: string
  /** 默认凭据 ref（无账号池时的单凭据回退）。 */
  defaultCredentialRef: string
  /** 远端模型列表不可用时的兜底目录。 */
  fallbackModels: readonly TeleagentFallbackModel[]
  /** 客户端展示版本号（进 `X-App-Version` 头；服务端不强校验，取安装包版本）。 */
  appVersion: string
  /** 签名版本常量（`local-v1`；进两组 `*-Sign-Version` 头）。 */
  signVersion: string
  /** `X-SA-*` 签名头名（renderer 侧）。 */
  signHeaders: Readonly<Record<'version' | 'timestamp' | 'nonce' | 'signature', string>>
  /** `X-SuperAgent-*` 头名（Go 引擎侧）。 */
  superAgentHeaders: Readonly<Record<
    'timestamp' | 'nonce' | 'deviceId' | 'installId' | 'signVersion' | 'signature', string
  >>
}

/**
 * 兜底模型目录（3 条）。
 *
 * ⚠️ `chat-nano` / `chat-lite` 取自 asar `KG`（权威种子）；
 * `chat-pro` 取自 Go 引擎示例会话里的真实 `modelID`（`providerID:"NewApi","modelID":"chat-pro"`），
 * 但它的 `limit` **未从 `KG` 取到**（`KG` 只种了 nano/lite 两档，pro 由服务端目录下发）。
 * 故 pro 的窗口/输出**沿用 preset-context 共享口径**（100K / 16384）—— 这是
 * 「档位共享一份配置」这一 asar 明示事实的直接推论，**不是**凭空编造，
 * 但也**未经 pro 逐个探顶实测**（与 Qoder `dmodel` 填 1M 同型：口径成立、上限未探明）。
 */
const TELEAGENT_FALLBACK_MODELS: readonly TeleagentFallbackModel[] = [
  { id: 'chat-nano', name: '轻速', contextWindow: 100_000, maxTokens: 16_384, supportsImage: false },
  { id: 'chat-lite', name: '轻量', contextWindow: 100_000, maxTokens: 16_384, supportsImage: false },
  { id: 'chat-pro', name: '专业', contextWindow: 100_000, maxTokens: 16_384, supportsImage: false },
]

// ===== 推理端点的**签名**（2026-10-07 实测发现；业务端点**不需要**）=====

/**
 * 签名版本常量（asar `LocalAuthService` 原文 `const hZ = "local-v1"`）。
 *
 * ⚠️⚠️ **推理端点有签名校验，业务端点没有** —— 2026-10-07 实测的关键发现：
 *
 * | 端点 | 只带 `X-Token` | 结论 |
 * |---|---|---|
 * | `cowork/user_info` / 余额 / 签到 | **HTTP 200** | 业务端点**不需要**签名 |
 * | `api/v1/chat/completions` | **403** `40301` | 推理端点**必须**签名 |
 *
 * ⚠️⚠️ **`40301` 的文案会把人带偏**：它写「检测到客户端版本过低，
 * 请检查新版本并升级」，但**与版本号完全无关** —— 实测把 `X-App-Version`
 * 从 `2.5.3` 一路扫到 `3.0.0`，错误**一模一样**；而一旦带上
 * `X-App-Version`（任意值）**却不带签名**，错误立刻变成
 * `40104 unsupported sign version`。
 * ⇒ **判据：见到 `40301`/`40104` 就去查签名，不要先去改版本号。**
 */
export const TELEAGENT_SIGN_VERSION = 'local-v1'

/**
 * `X-SA-*` 签名头名（asar `LocalAuthService.signRequest` 原文）。
 *
 * 算法（**已完整解出**）：
 * ```js
 * sessionKey = randomBytes(32).toString("base64url")   // 本地随机，见下
 * path  = `${url.pathname}${url.search}`
 * ts    = String(Date.now())                            // ⚠️ 毫秒（不是秒）
 * nonce = randomBytes(12).toString("hex")
 * msg   = ["local-v1", METHOD, path, ts, nonce].join("\n")
 * sig   = HMAC-SHA256(sessionKey, msg).digest("base64url")
 * ```
 *
 * ⚠️ **`sessionKey` 是本地随机生成的**（客户端 `ensureSession()` 每次进程启动
 * 新建一个，**不经任何服务端注册**）—— 这强烈暗示服务端只校验
 * 「头存在 + 格式合法 + 时间戳新鲜」，**不校验签名本身**（它没有可比的密钥）。
 * 故本插件**自己生成**一个即可（见 `teleagentSignHeaders`）。
 * ⚠️ 但这**仍是待端到端确认的假设**（见 `scripts/probe-teleagent-infer-sign.mjs`）。
 */
export const TELEAGENT_SIGN_HEADERS = Object.freeze({
  version: 'X-SA-Sign-Version',
  timestamp: 'X-SA-Timestamp',
  nonce: 'X-SA-Nonce',
  signature: 'X-SA-Signature',
})

/**
 * Go 引擎侧的头名集（`internal/shared/rununit.HeaderNames`，从 Go 二进制提取）。
 *
 * ⚠️ 这组与 `X-SA-*` **不是同一个东西**，两套**都要发**。
 * ⚠️ `X-SuperAgent-Signature` 与 `X-SuperAgent-Sign-Version` 是**最容易漏的两个**：
 * 它们**不在** asar 的 renderer 代码里（renderer 只有 `sYt()` 的
 * Timestamp/Nonce/Device-Id/Install-Id），只出现在 Go 二进制的头名常量串里：
 * ```
 * X-SuperAgent-Timestamp X-SuperAgent-Device-Id X-SuperAgent-Signature X-TeleAI-Run-Unit-Type
 * ```
 * ⇒ 只读 renderer 会漏掉它们（我第一版就漏了，症状是 `40101 missing super agent
 * security headers`）。
 */
export const TELEAGENT_SUPERAGENT_HEADERS = Object.freeze({
  timestamp: 'X-SuperAgent-Timestamp',
  nonce: 'X-SuperAgent-Nonce',
  deviceId: 'X-SuperAgent-Device-Id',
  installId: 'X-SuperAgent-Install-Id',
  signVersion: 'X-SuperAgent-Sign-Version',
  signature: 'X-SuperAgent-Signature',
})

/** TeleAgent provider 配置。 */
export const TELEAGENT: TeleagentProduct = {
  id: 'teleagent',
  displayName: 'TeleAgent (电信)',
  apiBase: 'https://agent.teleai.com.cn/superCowork/sapi',
  // ⚠️⚠️ **登录入口必须用 UPMS 授权 URL，不能用 `meter/teleagent-login/login`**
  // （2026-10-07 实测：后者是 **511 字节的空 SPA 壳**，直接打开**白屏** ——
  // 它需要 `?tokenCode=` 之类的内部参数才渲染，那是官方客户端 iframe 专用的地址）。
  //
  // 真正的入口是 **UPMS 统一认证**，它从 401 响应的 `data` 字段里暴露出来：
  //   `https://www.teleai.com.cn/teleai-api/upms/public/auth/authorize`
  //   `  ?client_id=Z2veLLEHhZfq3hb5hWIwqJuPajIuasYi`
  //   `  &redirect_uri=<apiBase>/cowork/auth`
  // 实测：**302 → `/master-auth`**，返回 **1508 字节的真实登录页**
  //（标题「天翼AI开放平台-中国电信」、加载 CDN 上的 `main.js`）。
  //
  // ⚠️ `client_id` = `Z2veLLEHhZfq3hb5hWIwqJuPajIuasYi`（从上述 401 响应提取，
  // **不是猜的**）。它与 Qoder 的 `client_id` 是两回事。
  // ⚠️ `redirect_uri` 必须**预编码**（`%3A%2F%2F` 等），否则 302 会把参数截断。
  loginPage: 'https://www.teleai.com.cn/teleai-api/upms/public/auth/authorize'
    + '?client_id=Z2veLLEHhZfq3hb5hWIwqJuPajIuasYi'
    + '&redirect_uri=https%3A%2F%2Fagent.teleai.com.cn%2FsuperCowork%2Fsapi%2Fcowork%2Fauth',
  authCallbackBase: 'https://agent.teleai.com.cn/superCowork/sapi/cowork/auth',
  inferApiKey: 'sk-qvp4m6h9g20uM6PgYP7E',
  defaultCredentialRef: 'TELEAGENT_ACCESS_TOKEN',
  fallbackModels: TELEAGENT_FALLBACK_MODELS,
  appVersion: '2.5.3',
  signVersion: TELEAGENT_SIGN_VERSION,
  signHeaders: TELEAGENT_SIGN_HEADERS,
  superAgentHeaders: TELEAGENT_SUPERAGENT_HEADERS,
}

/** 产品注册表（供 `productById` 风格查找；本轮只有一个）。 */
export const ALL_TELEAGENT_PRODUCTS: readonly TeleagentProduct[] = [TELEAGENT]

/** 按 id 查产品配置。 */
export function teleagentProductById(id: string): TeleagentProduct | undefined {
  return ALL_TELEAGENT_PRODUCTS.find((product) => product.id === id)
}

// ===== 端点路径常量（相对 {@link TeleagentProduct.apiBase}）=====

/** 推理路径（OpenAI 兼容，POST）。 */
export const TELEAGENT_INFER_PATH = '/api/v1/chat/completions'
/** 用户信息路径（GET，登录后取 accountId / 昵称）。 */
export const TELEAGENT_USER_INFO_PATH = '/cowork/user_info'
/** 登出路径（GET，`{code:0}` 即成功）。 */
export const TELEAGENT_LOGOUT_PATH = '/cowork/logout'

// ===== 固定请求头（asar `TBe` / `j8t()` / renderer `bM` 头集合）=====

/**
 * 路由目标头（asar `TBe = { "X-Route-Target": "ops-gateway", … }`）。
 *
 * ⚠️ 这是 NewApi provider 的**固定头**，推理与业务都带 —— 缺了它服务端可能
 * 把请求路由到错误网关（与 Qoder 的 `business` 必填是同型「缺字段走异常分支」）。
 */
export const TELEAGENT_ROUTE_TARGET_HEADER = 'ops-gateway'

/** 请求超时（毫秒）。 */
export const TELEAGENT_REQUEST_TIMEOUT_MS = 30_000
/** 登录回调等待超时（毫秒）—— 用户粘贴回调 URL 的窗口，给足 10 分钟。 */
export const TELEAGENT_LOGIN_TIMEOUT_MS = 10 * 60_000


