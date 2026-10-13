/**
 * Cline 产品配置。
 *
 * ## 为什么是**第七套**独立配置
 *
 * Cline 与既有六个 provider **都不同源**，且差异点与任何一个都不重合：
 *
 * | 维度 | codearts | buddy/workbuddy | lobsterai | qoder | trae | **cline** |
 * |------|----------|-----------------|-----------|-------|------|-----------|
 * | 登录 | OAuth 回调 | external-link 轮询 | 本地回调 + authCode | PKCE 设备码 | ExchangeToken | **WorkOS 设备码** |
 * | 续期 | refresh_token | refresh_token | + 身份字段 | + machine_id | refreshToken 轮换 | **`{refreshToken, grantType}`** |
 * | 鉴权头 | SDK-HMAC | Bearer | Bearer | Bearer（WASM 签名头） | Cloud-IDE-JWT | **`Bearer workos:<jwt>`** |
 * | 推理体 | 华为自有 | 腾讯自有 | 有道自有 | WASM 加密 | SOLO 格式 | **标准 OpenAI** |
 *
 * 共用的是架构**模式**（产品差异收敛到单一真相源、账号池、限流切换），
 * 不是任何一个既有 Product 类型 —— 与 Qoder / TRAE 的处理方式一致。
 *
 * ## 数据来源
 *
 * 全部来自本机 Cline 桌面端产物逆向 + 实测（2026-09-25）：
 * - 二进制：`C:\Users\Jet\AppData\Local\Cline\code-sidecar.exe`（bun 单文件，144 MB）
 * - 真实凭据：`C:\Users\Jet\.cline\data\settings\providers.json`
 *
 * 排查脚本（均为只读）：`scripts/probe-cline-endpoints.mjs`（按关键词提取
 * 二进制字符串窗口）、`probe-cline-models.mjs`、`probe-cline-recommended.mjs`、
 * `probe-cline-balance.mjs`、`probe-cline-chat.mjs`。
 *
 * 详细取证见 `docs/superpowers/specs/2026-09-25-cline-provider-design.md` §2。
 */

/**
 * 兜底模型目录中的一个条目。
 *
 * ⚠️ **本表只是兜底**：真实免费集合由远端
 * `GET /api/v1/ai/cline/recommended-models` 的 `free` 数组下发，
 * 且**内嵌目录缺 `cline-free/gemini-3.8-flash`**（远端有）。
 * 故本表不足以覆盖免费集合 —— 见 `src/cline-models.ts` 的合并逻辑。
 */
export interface ClineFallbackModel {
  /** 模型 id（远端原样，如 `cline-free/deepseek-v4.1-flash`）。 */
  id: string
  /** 展示名（不含 `· 免费` 后缀，后缀由展示函数统一拼）。 */
  name: string
  /** 上下文窗口（内嵌目录 `contextWindow`）。 */
  contextWindow: number
  /** 单次输出上限（内嵌目录 `maxTokens`）。 */
  maxTokens?: number
  /** 是否接受图片输入（内嵌目录 `capabilities` 含 `images`）。 */
  supportsImage?: boolean
  /**
   * 是否免费额度模型。
   *
   * 判据见 `src/cline-models.ts`：远端 `free` 数组 ∪ `:free` 后缀
   * ∪ `cline-free/` 前缀 ∪ 本字段。
   */
  isFree?: boolean
  /** 简介（内嵌目录 `description`，用于 /model 弹窗）。 */
  description?: string
}

/** Cline 产品配置。 */
export interface ClineProduct {
  /** provider 标识：注册到 `ctx.llm` 的路由名，也是账号列表的 provider 字段值。 */
  id: 'cline'
  /** 设置页 / 模型选择器展示名。 */
  displayName: string
  /**
   * API 基址（`CLINE_ENVIRONMENTS.production.apiBaseUrl`）。
   *
   * 推理、模型目录、账号端点、`auth/register`、`auth/refresh` 全部挂在它下面。
   */
  apiBase: string
  /** Web 应用基址（`appBaseUrl`）；登录引导页用。 */
  appBase: string
  /**
   * WorkOS 基址（`DEFAULT_WORKOS_API_BASE_URL`）。
   *
   * 设备码授权与 token 轮询走它，**不是** `apiBase`。
   */
  workOsBase: string
  /**
   * WorkOS client id（`workOsClientId`）。
   *
   * ⚠️ 这个值同时出现在 `CLINE_ENVIRONMENTS.production` 与凭据 JWT 的
   * `client_id` claim 里，两处一致（实测）。staging / local 环境各有自己的
   * client id，本插件只支持 prod。
   */
  workOsClientId: string
  /**
   * 客户端标识请求头。
   *
   * 源码 `DEFAULT_CLINE_REQUEST_HEADERS`。⚠️ **推理与账号端点都需要**：
   * 只带 Authorization 时实测虽可通（`/api/v1/users/me` 200），但这些头是
   * 官方客户端的身份声明，缺失可能在某些网关策略下被拒或降级，
   * 故照官方原样下发。
   */
  clientHeaders: Readonly<Record<string, string>>
  /**
   * 访问令牌的前缀。
   *
   * ⚠️ **必须保留**：源码 `resolveApiKey` 原样使用存储值，而 Cline 磁盘上
   * 存的就是 `workos:eyJ…`。该前缀只在**解码 JWT** 时被剥掉
   * （`decodeJwtPayload(token.replace(/^workos:/, ""))`），
   * **从不出现在请求头构造里**。
   *
   * 实测（同一凭据）：
   * - `Authorization: Bearer workos:eyJ…` → `/api/v1/users/me` **200**
   * - `Authorization: Bearer eyJ…`（剥掉前缀）→ **401**
   *
   * 401 文案是 "make sure you're using the latest version of Cline"，
   * 与真实原因毫不相干 —— 剥前缀会让人误判成「版本过旧」。
   */
  tokenPrefix: string
  /** 默认凭据 ref（无账号池时的单凭据回退）。 */
  defaultCredentialRef: string
  /**
   * 单张请求图片的像素预算（issue !IKITT9）。
   *
   * ⚠️ Cline **没有**腾讯那道「图片视觉 token 预算」—— 实测 24 张
   * 2560×1600 原图（≈159K 图片 token，远超 100,000）全部成功，
   * 直到 32 张（≈122 MiB）才因**请求体体积** `TRANSPORT` 失败。
   * 所以这里的预算是为体积兜底，不是为了 token 配额；取值比其他家宽松。
   * 未配置时适配器用 `DEFAULT_IMAGE_PIXEL_BUDGET`。
   */
  imagePixelBudget?: number
  /** 单张请求图片的编码字节目标（未配置用 1 MiB，见 `src/image-budget.ts`）。 */
  imageMaxBytes?: number
  /** 模型列表不可用时的兜底目录。 */
  fallbackModels: readonly ClineFallbackModel[]
}

/**
 * 兜底模型目录（远端 `free` 数组实测）。
 *
 * ⚠️ **免费模型是独立 id**：`cline-free/mimo-v2.6-flash`（免费）与
 * `xiaomi/mimo-v2.6-flash`（按量计费）是**两个不同条目**。
 * 绝不可用「名字包含 mimo」之类的模糊匹配判免费。
 *
 * ⚠️ 远端 `/api/v1/models` 的 469 个 id 里**根本没有 `cline-free/*`**
 * （实测 `cline-free/` 前缀零命中）—— 免费模型**只**由
 * `recommended-models` 下发。这是「只调 `/models` 会看不到任何免费模型」的原因。
 *
 * ## 2026-10-09 全表更新（免费集合已实质变化）
 *
 * 远端 `recommended-models` 的 `free` 数组**换了三个成员**（匿名与已登录
 * 两种认证态下完全一致，见 `scripts/probe-cline-free-auth.mjs`）：
 *
 * | id | 旧表 | 远端 `free` | 真实调用 |
 * |---|---|---|---|
 * | `cline-free/mimo-v2.6-flash` | 有 | **有** | 保留 |
 * | `cline-free/muse-spark-1.3-contributor` | 有 | **有** | 保留 |
 * | `cline-free/step-5-preview` | 无 | **有** | **新增** |
 * | `cline-free/solar-mini4` | 无 | **有** | **新增** |
 * | `stealth/space-bunny-alpha` | 有 | 无 | **404（上游无端点）** |
 * | `cline-free/deepseek-v4.1-flash` | 有 | 无 | **404 model not found** |
 * | `cline-free/gemini-3.8-flash` | 有 | 无 | **404 model not found** |
 *
 * ⚠️ **三个旧条目的删除是实测结论，不是「没在清单里就删」**：它们既不在
 * `free` 数组、也不在 `/api/v1/models` 的 469 条里，仅凭这点只能说明
 * 「未被列出」。故逐个发了一次最小请求（`max_tokens: 1`）验证 ——
 * 两个回 `404 {"error":"model not found"}`，`stealth/space-bunny-alpha`
 * 回 `500`，其上游 OpenRouter 报文是
 * `No endpoints found for stealth/space-bunny-alpha`（**上游已无该模型的任何端点**）。
 * 对照组 `cline-free/mimo-v2.6-flash` 同参数回 `500 empty response content`
 * （模型存在，只是 `max_tokens: 1` 产不出内容），证明该判据能区分两者。
 * 复核脚本：`scripts/probe-cline-availability.mjs`。
 *
 * ⚠️ **保留它们会有实际危害**：`isClineFreeModel` 有
 * `id.startsWith('cline-free/')` 的命名约定兜底，故即使远端不再下发，
 * 这些 id 仍会被播报为「免费」并出现在选择器里 —— 用户选中后必然 404。
 *
 * ⚠️ 新增两条的 `contextWindow` / `maxTokens` 取自 models.dev 的**官方 provider
 * 块**（`stepfun` / `upstage`），非估算：
 * - `step-5-preview`：`limit = {context: 1000000, output: 65536}`、
 *   `modalities.input = ["text","image","video"]` → 支持图片；
 * - `solar-mini4`：`limit = {context: 524288, output: 131072}`、
 *   `modalities.input = ["text"]` → **不支持**图片。
 *
 * ⚠️ 顺带记录一处**未修**的缺陷：该响应现在还有第四个数组 `clineCloud`
 * （`cline-cloud/deepseek-v4.1-flash`），而 `parseClineRecommendedModels`
 * 只解析 `free` / `recommended` / `clinePass` ⇒ 该条目整个丢失。本次只做
 * 「模型列表数据更新」，未改解析器；且实测该 id 当前回
 * `403 {"message":"Error 403: This request is not supported."}`（不可用），
 * 故暂不收录。详见 `src/cline-models.ts` 的对应说明。
 */
const CLINE_FALLBACK_MODELS: readonly ClineFallbackModel[] = [
  // ── 免费模型（远端 `free` 数组实测 2026-10-09，共 4 个）──
  {
    id: 'cline-free/mimo-v2.6-flash',
    name: 'MiMo-V2.6-Flash',
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    supportsImage: true,
    isFree: true,
    description: 'Mixture-of-Experts architecture with 309B total parameters',
  },
  {
    id: 'cline-free/muse-spark-1.3-contributor',
    name: 'Muse Spark 1.3 Contributor',
    contextWindow: 1_048_576,
    // ⚠️ 943718 取自 models.dev 的 `nano-gpt`/`bothub`/`kilo`/`openrouter`
    // 四处一致的实测值（`cline-pass` 块另报 131072，两说并存）。
    // 保留既有取值不动 —— 它不是本次更新的目标，且改动会影响真实请求的
    // `max_tokens`，需单独实测确认后才可调整。
    maxTokens: 943_718,
    supportsImage: true,
    isFree: true,
    description:
      'Meta\u2019s multimodal reasoning model for experimentation, learning, '
      + 'and early-stage agentic, multi-agent, and coding workflows.',
  },
  {
    id: 'cline-free/step-5-preview',
    name: 'Step 5 Preview',
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    supportsImage: true,
    isFree: true,
    description: "StepFun's flagship model for agentic work, built on a sparse Mixture-of-Experts",
  },
  {
    // ⚠️ 纯文本模型（models.dev `modalities.input = ["text"]`）——
    // 不要照抄其它免费条目的 `supportsImage: true`。
    id: 'cline-free/solar-mini4',
    name: 'Solar Mini 4',
    contextWindow: 524_288,
    maxTokens: 131_072,
    supportsImage: false,
    isFree: true,
    description: 'Compact 35-billion parameter mixture-of-experts',
  },
]

/**
 * Cline 全 provider 统一的思考档位（**顺序即 UI 展示顺序**）。
 *
 * ## 为什么所有模型共用一张表
 *
 * 远端**不下发**档位：`/api/v1/models` 只有 `{id, object, created, owned_by}`，
 * `recommended-models` 只有 `{id, name, description, tags}`；sidecar 里
 * `/api/v1/` 的 21 个路径中也没有任何模型详情端点。档位只存在于客户端
 * 内嵌 `BUILTIN_MODEL_CATALOG`，而那张表覆盖不了远端 460 个 id。
 *
 * 故按产品决策对**所有**模型统一给这 5 档。已知局限：对不在内嵌目录里的
 * 模型，档位是猜的 —— 但上游对不认识的档位**静默忽略而不报错**
 * （实测 `reasoning_effort: 'banana'` 返回 HTTP 200 且思考量为 0），
 * 所以最坏情况是「开关无效」，不会是「请求失败」。
 *
 * ## `id` 与 `name` 刻意不同（wire 值 ≠ 展示名）
 *
 * Cline IDE 的档位菜单是 None/Low/Medium/High/**Extra**（用户截图实测），
 * 而上游认的 wire 值是 `none/low/medium/high/max`。最高档的对应关系是
 * **行为实测**出来的，不是从二进制反推的：
 *
 * | effort | reasoning 字符数（`stealth/space-bunny-alpha`，同题 3 次采样均值） |
 * |---|---|
 * | 不传 / `none` | 0（**不传 = 不思考**） |
 * | `low` | 67 |
 * | `medium` | 379 |
 * | `high` | 294 |
 * | `xhigh` | **259（与 high 无可辨差异 → 伪档位，跳过）** |
 * | `max` | **1192（high 的 4 倍 → 最高档）** |
 *
 * 旁证：sidecar 权重表 `{ max:1, xhigh:0.95, high:0.8, medium:0.5, low:0.2, ... }`
 * 同样确认 `max` 在 `xhigh` 之上。
 *
 * ⚠️ **把 `id` 与 `name` 当成同一个概念会让用户找不到档位** —— 与本项目
 * LobsterAI 那条「wire 值 ≠ 展示名」的教训同源。
 */
export const CLINE_REASONING_EFFORTS: readonly { id: string; name: string }[] = [
  { id: 'none', name: 'None' },
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
  { id: 'max', name: 'Extra' },
]

/**
 * 默认思考档位。
 *
 * ⚠️ **声明它会改变默认行为**：实测「不传 `reasoning_effort` → 模型完全不思考」，
 * 而 `dsh-client-ui-model-selection` 在用户未手动选择时会自动采用
 * `model.reasoning.defaultEffort`（`state.current?.reasoningEffort ?? defaultEffort`）。
 * 即声明后 Cline 从「默认不思考」变成「默认 High 思考」，与 IDE 一致，
 * 代价是思考 token 计入 `completion_tokens`。这是**用户明确要求**的变更。
 */
export const CLINE_DEFAULT_REASONING_EFFORT = 'high'

/** Cline provider 配置（生产环境）。 */
export const CLINE: ClineProduct = {
  id: 'cline',
  displayName: 'Cline',
  apiBase: 'https://api.cline.bot',
  appBase: 'https://app.cline.bot',
  workOsBase: 'https://api.workos.com',
  workOsClientId: 'client_01K3A541FN8TA3EPPHTD2325AR',
  clientHeaders: {
    'HTTP-Referer': 'https://cline.bot',
    'X-Title': 'Cline',
    'X-IS-MULTIROOT': 'false',
    'X-CLIENT-TYPE': 'cline-sdk',
  },
  tokenPrefix: 'workos:',
  defaultCredentialRef: 'CLINE_ACCESS_TOKEN',
  fallbackModels: CLINE_FALLBACK_MODELS,
}

/** 全部 Cline 产品配置（当前只有一个，保留数组以便将来扩展 staging）。 */
export const ALL_CLINE_PRODUCTS: readonly ClineProduct[] = [CLINE]

/** 按 provider id 取 Cline 产品配置；未知 id 返回 undefined。 */
export function clineProductById(id: string): ClineProduct | undefined {
  return ALL_CLINE_PRODUCTS.find((product) => product.id === id)
}

// ── 端点路径常量 ──
// 抽成常量而非散落字面量：登录、续期、模型、余额四处都要用，
// 且它们**全部挂在 `apiBase` 下**（WorkOS 那两个例外，挂 `workOsBase`）。

/** 设备码授权（挂 `workOsBase`）。 */
export const CLINE_DEVICE_AUTHORIZATION_PATH = '/user_management/authorize/device'
/** 设备码 token 轮询（挂 `workOsBase`）。 */
export const CLINE_DEVICE_AUTHENTICATE_PATH = '/user_management/authenticate'
/** 注册 WorkOS token（换 Cline 自己的 token，挂 `apiBase`）。 */
export const CLINE_REGISTER_PATH = '/api/v1/auth/register'
/** 续期（挂 `apiBase`）。 */
export const CLINE_REFRESH_PATH = '/api/v1/auth/refresh'
/** 推理（OpenAI 兼容，挂 `apiBase`）。 */
export const CLINE_CHAT_PATH = '/api/v1/chat/completions'
/** 全量模型 id 列表（挂 `apiBase`）。 */
export const CLINE_MODELS_PATH = '/api/v1/models'
/** 推荐模型（含 **`free` 数组**，挂 `apiBase`，**无需认证**）。 */
export const CLINE_RECOMMENDED_MODELS_PATH = '/api/v1/ai/cline/recommended-models'
/** 账号信息（挂 `apiBase`）。 */
export const CLINE_ME_PATH = '/api/v1/users/me'
