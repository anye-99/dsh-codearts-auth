/**
 * Step Code（**阶跃星辰 StepFun** 官方终端 Agent CLI）产品配置。
 *
 * ## 为什么新建 `StepcodeProduct` 而不复用既有类型
 *
 * `BuddyProduct` / `QoderProduct` / `TraeProduct` / `TeleagentProduct` 的字段
 * 全部围绕各自协议设计（归属头、WASM 签名参数、SOLO 通道名、双凭据头…），
 * 对 Step Code 无一有意义。Step Code 需要的是：
 * **一个 API base + 一个授权站 base + 一组登录常量**。
 * 故定义**平行**接口 —— 共用的是架构**模式**（产品差异收敛到单一真相源），
 * 不是那个类型。
 *
 * ## 数据来源（全部逆向官方发行包，逐字读取，非推测）
 *
 * 取证物：官方安装脚本 `https://static-openapi.stepfun.com/stepcode/install.ps1`
 * 指向的发行清单 `latest.json` → **0.1.3**（`generatedAt: 2026-10-08`）→
 * `step-0.1.3-windows-x64.zip`（SHA256 `43f6d0f4…3d93411e`，**已校验一致**）。
 *
 * 包内 `step.exe` 是 **Bun 单文件可执行**（126 MB），内嵌的 JS bundle
 * **未混淆、保留全部标识符与模块注释**，故下列常量均为**逐字摘录**：
 *
 * | 常量 | bundle 模块 | 原文 |
 * |---|---|---|
 * | `STEP_PROVIDER_ID = "step"` | `providers/dist/step-provider/index.js` | provider 内部标识 |
 * | `STEP_PROVIDER_DEFAULTS.apiBaseUrl` | 同上 | `https://api.stepfun.com/step_plan` |
 * | `STEP_PROVIDER_DEFAULTS.authBaseUrl` | 同上 | `https://platform.stepfun.com` |
 * | `STEP_CLI_LOGIN_PATH_PREFIX` | `step-provider/login-client.js` | `/api/stdhttp/v1/cli-login` |
 * | `STEP_CLI_LOGIN_AUTHORIZE_PATH` | 同上 | `/cli-login-remote` |
 * | `STEP_USABLE_MODEL_TYPES` | `step-provider/index.js` | `{"大语言模型","路由模型"}` |
 * | `STEP_MODEL_DEFAULTS.contextWindow` | 同上 | `256000` |
 * | `STEP_EFFORT_LEVELS` | 同上 | `minimal/low/medium/high/xhigh/max` |
 * | `DEFAULT_STEP_CLI_LOGIN_TIMEOUT_MS` | 同上 | `10 * 60 * 1000` |
 * | `REQUEST_TIMEOUT_MS` / `MAX_RESPONSE_BYTES` | `login-client.js` | `15000` / `64 * 1024` |
 *
 * 交叉印证（**独立第二来源**）：官方文档
 * `https://platform.stepfun.com/docs/zh/guides/developer/integrations/deepseek-harness.md`
 * 给出的 DSH 自定义 Provider 配置为
 * `api: openai-completions` + `baseURL: https://api.stepfun.com/step_plan/v1`
 * + `Authorization: Bearer <key>`，与 bundle 里的
 * `STEP_MODEL_API = "openai-completions"` 和 `stepOpenAiBaseUrl()`（base + `/v1`）
 * **完全一致**。
 *
 * ## ⚠️ 一处「文档 vs 代码」的冲突，已判定以代码为准
 *
 * 同一发行包内的 `docs/step-integration.md` 写道：
 * *"The built-in Step provider uses pi's `anthropic-messages` adapter.
 * Pi appends `/v1/messages` …"*，并提到启动时由
 * `step/models-endpoint-repair.ts` 把旧投影「修回 `anthropic-messages`」。
 *
 * **该说法在 0.1.3 里已不成立**，两条独立证据：
 * 1. `STEP_MODEL_API = "openai-completions"` 是**唯一**取值，全 bundle 仅
 *    4 处引用且全部在 `step-provider/index.js`（`stepModelConfig` /
 *    `normalizeStepModelConfig` / `normalizeStepModel` / 常量声明）；
 * 2. 文档点名的修复模块 `models-endpoint-repair` 在 `step.exe` 里
 *    **0 命中**（该模块已不存在）。
 *
 * ⇒ 推理走 **OpenAI Chat Completions**：
 * `POST https://api.stepfun.com/step_plan/v1/chat/completions`。
 * ⚠️ 改这里之前请先复核上述两条判据 —— 选错协议族会整条链路 404，
 * 而 404 的表象与「base URL 少了 `/v1`」一模一样，极易误判。
 *
 * ## 协议族 = OpenAI 兼容（无加密、无签名）
 *
 * 与 `teleagent` / `qoder` 同族但**更薄**：只有一个
 * `Authorization: Bearer <api_key>` 头，没有渠道密钥、没有 WASM 签名、
 * 没有归属头。⇒ 消息序列化与 SSE 消费**复用** `src/openai-compat.ts`。
 */

/** Step Code 的登录 profile（官方 CLI 有四个，本插件只接国内订阅那个）。 */
export type StepcodeLoginProfile =
  | 'step_plan'
  | 'step_plan_oversea'
  | 'platform_cn'
  | 'platform_oversea'

/** Step Code 产品配置。 */
export interface StepcodeProduct {
  /** provider 标识：注册到 `ctx.llm` 的路由名，也是账号列表的 provider 字段值。 */
  id: 'stepcode'
  /** 设置页 / 模型选择器展示名（与客户端 `PROVIDERS` 的 label 保持一致）。 */
  displayName: string
  /**
   * 模型 API base（**不含** `/v1`）。
   *
   * ⚠️ 官方 CLI 的 `normalizeStepApiBaseUrl()` 会**主动剥掉**结尾的
   * `/v1`、`/messages`、`/v1/messages`，再由 `stepOpenAiBaseUrl()` 统一补回
   * `/v1` —— 目的是让「用户手填带版本的地址」也能工作。
   * 本插件只存**规范形态**（不带 `/v1`），拼接统一走 {@link stepcodeOpenAiBase}。
   */
  apiBase: string
  /**
   * 授权站 base（登录 init / poll 与浏览器授权页都在这个 origin 上）。
   *
   * ⚠️ 它同时是 **profile 的判据**：官方
   * `loginProfile = authBaseUrl.hostname.endsWith(".ai") ? "step_plan_oversea" : "step_plan"`。
   * 故改这个域名会连带改变上报给服务端的 profile。
   */
  authBase: string
  /** 上报给 init 端点的 profile 值。 */
  loginProfile: StepcodeLoginProfile
  /** 浏览器里打开的授权页路径（拼 `?flow_id=`）。 */
  authorizePath: string
  /** 登录 API 的路径前缀（`/init` 与 `/poll/{flow_id}` 挂在它下面）。 */
  loginPathPrefix: string
  /** init 请求体里的 `client.name`（官方 CLI 恒为 `stepcode`）。 */
  clientName: string
  /** init 请求体里的 `client.version`（取发行包版本）。 */
  clientVersion: string
  /** 默认凭据 ref（无账号池时的单凭据回退）。 */
  defaultCredentialRef: string
  /**
   * 远端模型目录不可用时的兜底表。
   *
   * ⚠️ **刻意为空** —— 官方 CLI 的 `STEP_MODELS = []` 也是空表，
   * 模型目录**完全**依赖 `GET /v1/models` 实时拉取。
   *
   * 不编造兜底条目的理由（AGENTS.md 红线「不凭猜测填表」）：
   * 目录里的 `enable_vision_input` / `reasoning_effort_support_list` /
   * `max_input_tokens` 都是**服务端下发的账号级事实**，本地写死会在
   * 「远端失败降级」时凭空改变图片支持与思考档位，且极难排查
   * （与 teleagent 兜底表 `supportsImage` 恒 false 的保守取值同因）。
   * ⇒ 远端失败时如实返回空目录（用户看到「无可用模型」），
   * 而不是给一张可能对不上账号权限的假表。
   */
  fallbackModels: readonly StepcodeFallbackModel[]
}

/**
 * 兜底模型条目（当前**无条目**，仅为将来远端不可用时留形状）。
 *
 * 字段与 {@link StepcodeModelEntry} 的差别：兜底表是**人工填写的字面量**，
 * 归一形状是**远端解析结果**；两条路径只共用输出形状，不共用归一规则
 * （与 `teleagentFallbackToEntry` 的口径一致）。
 */
export interface StepcodeFallbackModel {
  /** 模型 ID（传给推理端点的 `model`）。 */
  id: string
  /** 展示名。 */
  name: string
  /** 上下文窗口（远端字段 `max_input_tokens`）。 */
  contextWindow: number
  /** 是否支持图片输入（远端字段 `enable_vision_input`）。 */
  supportsImage: boolean
  /** 支持的思考档位（远端字段 `reasoning_effort_support_list`）。 */
  efforts?: readonly string[]
}

// ===== 端点路径常量 =====

/**
 * OpenAI 兼容端点的 `/v1` 段。
 *
 * 官方 `stepOpenAiBaseUrl(apiBaseUrl)` = `normalizeStepApiBaseUrl(apiBaseUrl) + "/v1"`，
 * 模型目录与推理都挂在这个 base 下。
 */
export const STEPCODE_V1_SEGMENT = '/v1'

/** 推理路径（相对 {@link stepcodeOpenAiBase}，OpenAI 兼容，POST）。 */
export const STEPCODE_CHAT_PATH = '/chat/completions'

/** 模型目录路径（GET，只需 Bearer）。 */
export const STEPCODE_MODELS_PATH = '/models'

/** 登录 init 路径（相对 {@link StepcodeProduct.authBase}，POST）。 */
export const STEPCODE_LOGIN_INIT_PATH = '/init'

/**
 * 登录轮询路径前缀（相对 {@link StepcodeProduct.authBase}，GET）。
 *
 * 完整形态是 `{prefix}/poll/{encodeURIComponent(flow_id)}`。
 */
export const STEPCODE_LOGIN_POLL_PATH = '/poll'

// ===== 超时常量（逐字取自 bundle）=====

/** 登录单请求超时（bundle `REQUEST_TIMEOUT_MS = 15000`）。 */
export const STEPCODE_LOGIN_REQUEST_TIMEOUT_MS = 15_000

/** 整个登录流程超时（bundle `DEFAULT_STEP_CLI_LOGIN_TIMEOUT_MS = 10 * 60 * 1000`）。 */
export const STEPCODE_LOGIN_TIMEOUT_MS = 10 * 60_000

/** 推理/目录请求超时（本仓库惯例，与 teleagent 一致）。 */
export const STEPCODE_REQUEST_TIMEOUT_MS = 30_000

/** 登录响应体上限（bundle `MAX_RESPONSE_BYTES = 64 * 1024`）。 */
export const STEPCODE_MAX_RESPONSE_BYTES = 64 * 1024

/** 轮询间隔上限（bundle `MAX_POLL_INTERVAL_SEC = 60`，单位**秒**）。 */
export const STEPCODE_MAX_POLL_INTERVAL_SEC = 60

/** 轮询间隔下限（bundle `MIN_STEP_POLL_INTERVAL_MS = 1000`，单位毫秒）。 */
export const STEPCODE_MIN_POLL_INTERVAL_MS = 1_000

/** 错误详情截断长度（bundle `MAX_ERROR_DETAIL_LENGTH = 240`）。 */
export const STEPCODE_MAX_ERROR_DETAIL_LENGTH = 240

// ===== 模型目录口径（逐字取自 bundle）=====

/**
 * 可用模型类型白名单（bundle `STEP_USABLE_MODEL_TYPES`）。
 *
 * 原文是 `new Set(["\u5927\u8BED\u8A00\u6A21\u578B", "\u8DEF\u7531\u6A21\u578B"])`，
 * 即 **`{"大语言模型", "路由模型"}`** —— 服务端下发的是**中文类型名**。
 *
 * ⚠️ 过滤规则有个**容易漏的前提**（bundle `fetchStepModels` 原文）：
 * ```js
 * const typed = entries.some((e) => e.modelType !== undefined)
 * const usable = typed ? entries.filter((e) => e.modelType !== undefined
 *                                           && STEP_USABLE_MODEL_TYPES.has(e.modelType))
 *                      : entries
 * ```
 * 即**只有当至少一个条目带 `model_type` 时才启用过滤**；
 * 服务端一个都没下发时**全部保留**。
 * ⇒ 照抄「无条件过滤」会在服务端改字段名时把目录清空（静默变成「无可用模型」）。
 */
export const STEPCODE_USABLE_MODEL_TYPES: ReadonlySet<string> = new Set([
  '大语言模型',
  '路由模型',
])

/** 远端未给 `max_input_tokens` 时的默认窗口（bundle `STEP_MODEL_DEFAULTS.contextWindow`）。 */
export const STEPCODE_DEFAULT_CONTEXT_WINDOW = 256_000

/**
 * 思考档位全集（bundle `STEP_EFFORT_LEVELS` 与 `STEP_THINKING_LEVELS`）。
 *
 * ```js
 * STEP_EFFORT_LEVELS   = ["minimal","low","medium","high","xhigh","max"]
 * STEP_THINKING_LEVELS = ["off", ...STEP_EFFORT_LEVELS]
 * ```
 *
 * ⚠️ `off`（关闭思考）**不在** `STEP_EFFORT_LEVELS` 里，而是
 * `STEP_THINKING_LEVELS` 的首项 —— 官方用
 * `stepThinkingLevelMap(efforts)` 把「模型不支持的档位」映射为 `null`，
 * 再由 pi 的 `getSupportedThinkingLevels()` 过滤掉。
 * ⇒ 我们同样**只声明远端 `reasoning_effort_support_list` 里真有的档位**。
 */
export const STEPCODE_EFFORT_LEVELS: readonly string[] = Object.freeze([
  'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
])

/** 含「关闭思考」的完整档位表（顺序与官方一致：`off` 在最前）。 */
export const STEPCODE_THINKING_LEVELS: readonly string[] = Object.freeze([
  'off', ...STEPCODE_EFFORT_LEVELS,
])

/**
 * 档位展示名（中文）。
 *
 * ⚠️ DSH 的档位选择器**直接渲染 `efforts[].name`**（不本地化、不查字典），
 * 故给中文即中文界面 —— 与 Qoder 从官方 i18n 取中文名的口径一致
 * （AGENTS.md「展示名必须用官方中文」）。
 *
 * ⚠️ 阶跃官方文档未给这六个档位的中文名（CLI 的 TUI 直接显示英文档位名），
 * 故这里用与 Qoder 官方 i18n **一致**的译名，保证同一份 DSH 界面里
 * 两家 provider 的档位用词统一（`off` 一律「关闭思考」）。
 */
export const STEPCODE_EFFORT_NAMES: Readonly<Record<string, string>> = Object.freeze({
  off: '关闭思考',
  minimal: '最小',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
})

/** Step Code provider 配置（国内 Step Plan 订阅）。 */
export const STEPCODE: StepcodeProduct = {
  id: 'stepcode',
  displayName: 'Step Code (阶跃)',
  apiBase: 'https://api.stepfun.com/step_plan',
  authBase: 'https://platform.stepfun.com',
  loginProfile: 'step_plan',
  authorizePath: '/cli-login-remote',
  loginPathPrefix: '/api/stdhttp/v1/cli-login',
  clientName: 'stepcode',
  // 取自发行的 `latest.json` 的 `version`（安装脚本按它选包）。
  // ⚠️ 升级发行包时同步改这里 —— 它进 init 请求体的 `client.version`。
  clientVersion: '0.1.3',
  defaultCredentialRef: 'STEPCODE_ACCESS_TOKEN',
  fallbackModels: [],
}

/** 产品注册表（供 `productById` 风格查找；本轮只有一个）。 */
export const ALL_STEPCODE_PRODUCTS: readonly StepcodeProduct[] = [STEPCODE]

/** 按 id 查产品配置。 */
export function stepcodeProductById(id: string): StepcodeProduct | undefined {
  return ALL_STEPCODE_PRODUCTS.find((product) => product.id === id)
}

/**
 * 拼出 OpenAI 兼容 base（含 `/v1`）。
 *
 * 复刻官方 `stepOpenAiBaseUrl()`：先 `normalizeStepApiBaseUrl()` 剥掉结尾的
 * `/v1`、`/messages`、`/v1/messages`（**循环剥**，因为可能出现
 * `/v1/messages/v1` 这种叠加），再补回 `/v1`。
 *
 * ⚠️ 循环剥离是官方原文明确的行为（`while (pathname)`），不是防御性冗余：
 * 它保证「用户/配置里手填了带版本的地址」也不会把版本段发两次
 * （文档 `step-integration.md` 里那句 *"so the version segment is never sent
 * twice"* 说的就是这件事）。
 */
export function stepcodeOpenAiBase(apiBase: string = STEPCODE.apiBase): string {
  return `${normalizeStepcodeApiBase(apiBase)}${STEPCODE_V1_SEGMENT}`
}

/** 剥掉结尾的版本/消息段，返回规范形态的 API base。 */
export function normalizeStepcodeApiBase(value: string): string {
  try {
    const url = new URL(value)
    let pathname = url.pathname.replace(/\/+$/u, '')
    // ⚠️ 与官方同款 `while` 循环：一次 `replace` 处理不了 `/v1/messages/v1` 这类叠加。
    for (;;) {
      const lower = pathname.toLowerCase()
      const suffix = ['/v1/messages', '/messages', '/v1'].find((candidate) => lower.endsWith(candidate))
      if (suffix === undefined) break
      pathname = pathname.slice(0, -suffix.length).replace(/\/+$/u, '')
    }
    url.pathname = pathname === '' ? '/' : pathname
    return url.toString().replace(/\/$/u, '')
  } catch {
    // 非法 URL 原样返回（与官方 `catch { return value }` 一致）：
    // 让后续 fetch 报出真实错误，而不是在这里把它变成 `undefined`。
    return value
  }
}

/** 推理端点完整 URL。 */
export function stepcodeChatUrl(product: StepcodeProduct = STEPCODE): string {
  return `${stepcodeOpenAiBase(product.apiBase)}${STEPCODE_CHAT_PATH}`
}

/** 模型目录端点完整 URL。 */
export function stepcodeModelsUrl(product: StepcodeProduct = STEPCODE): string {
  return `${stepcodeOpenAiBase(product.apiBase)}${STEPCODE_MODELS_PATH}`
}

/** 登录 init 端点完整 URL。 */
export function stepcodeLoginInitUrl(product: StepcodeProduct = STEPCODE): string {
  return `${trimTrailingSlash(product.authBase)}${product.loginPathPrefix}${STEPCODE_LOGIN_INIT_PATH}`
}

/** 登录轮询端点完整 URL（`flow_id` 必须 URL 编码）。 */
export function stepcodeLoginPollUrl(
  flowId: string,
  product: StepcodeProduct = STEPCODE,
): string {
  return `${trimTrailingSlash(product.authBase)}${product.loginPathPrefix}`
    + `${STEPCODE_LOGIN_POLL_PATH}/${encodeURIComponent(flowId)}`
}

/** 浏览器授权页完整 URL（`flow_id` 作为 query）。 */
export function stepcodeAuthorizeUrl(
  flowId: string,
  product: StepcodeProduct = STEPCODE,
): string {
  // 官方用 `new URL(AUTHORIZE_PATH, `${base.origin}/`)` + `searchParams.set`，
  // 这里等价实现（URLSearchParams 会自动编码）。
  const url = new URL(product.authorizePath, `${trimTrailingSlash(product.authBase)}/`)
  url.searchParams.set('flow_id', flowId)
  return url.toString()
}

/** 去掉结尾斜杠（官方 `validateHttpEndpoint` 的 `.replace(/\/$/u, "")`）。 */
export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '')
}
