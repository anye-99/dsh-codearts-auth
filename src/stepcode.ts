/**
 * Step Code（阶跃星辰）协议层：常量、凭据结构与**纯函数**。
 *
 * 本文件**不发任何网络请求**（登录流程在 `stepcode-oauth.ts`，
 * 服务编排在 `stepcode-auth.ts`），因此可完整单测。
 *
 * ## 凭据形态：静态 api_key，**没有真实续期**
 *
 * 官方 `loginStepOAuth()` 在轮询到 `state:"ready"` 后返回：
 * ```js
 * { access: ready.apiKey,
 *   refresh: STEP_STATIC_REFRESH_TOKEN,   // "step-static-credential"
 *   expires: Number.MAX_SAFE_INTEGER,
 *   ...ready.uid ? { uid: ready.uid } : {} }
 * ```
 * 而 `refreshStepOAuth()` 的全部实现是：
 * ```js
 * if (credentials.refresh !== STEP_STATIC_REFRESH_TOKEN)
 *   throw new Error("This Step credential cannot be refreshed. Run `step login` again.")
 * return { ...credentials, expires: Number.MAX_SAFE_INTEGER }
 * ```
 *
 * ⇒ 三个结论，**都不要凭直觉改**：
 * 1. 订阅登录换来的**就是一个 API Key**（不是 access/refresh token 对）；
 * 2. 那个 `refresh` 字段是**哨兵字符串**，只用于「判断这份凭据是不是 Step 的」，
 *    **不能**拿去请求任何续期端点（不存在这样的端点）；
 * 3. `expires` 恒为 `Number.MAX_SAFE_INTEGER` ⇒ **永不过期**。
 *
 * 故本 provider 与 `teleagent` / `loomy` / `zcode` 同类：
 * {@link isStepcodeRefreshable} 恒 `false`，`refresh()` 退化为「探测有效性」。
 * ⚠️ 把账号池占位条目的 `refreshable` 写成 `true` 会让定时器每 30 分钟
 * 对一个不可能成功的操作发一轮请求（AGENTS.md 在 teleagent 上记过这条）。
 */

import { randomBytes } from 'node:crypto'
import {
  STEPCODE,
  STEPCODE_DEFAULT_CONTEXT_WINDOW,
  STEPCODE_MAX_ERROR_DETAIL_LENGTH,
  STEPCODE_USABLE_MODEL_TYPES,
  type StepcodeFallbackModel,
  type StepcodeProduct,
} from './stepcode-product.js'

/**
 * 官方哨兵 refresh 值（bundle `STEP_STATIC_REFRESH_TOKEN`）。
 *
 * ⚠️ **它不是令牌**，只是一个「这份凭据来自 Step 订阅登录」的标记。
 * 持久化它是为了与官方 `auth.json` 的形状对齐（官方 `type:"oauth"` 条目
 * 里就存着这个值），且将来若官方真的加了续期端点，判据现成。
 */
export const STEPCODE_STATIC_REFRESH_TOKEN = 'step-static-credential'

/** Step Code 凭据（存进 `ctx.credentials` 的 JSON 形状）。 */
export interface StepcodeCredential {
  /**
   * 订阅 API Key（官方 `credential.api_key`）。
   *
   * ⚠️ **字段名必须是 `access_token`** —— `AccountPool.findAccountIdByCredential`
   * 对非 `codearts` 的 provider 统一取这个字段作账号身份标识
   * （`docs/adding-a-new-provider.md`「凭据结构」硬性契约）。
   * 换个名字会让「同 key 重复登录」判重失效，池里长出重复账号。
   */
  access_token: string
  /**
   * 账号标识（官方 `readBoundedUid(readString(payload, "uid"))`）。
   *
   * ⚠️ `uid` 在 poll 响应的**顶层**，不在 `credential` 里 —— 别去
   * `credential.uid` 找（那里没有，会静默丢失账号名）。
   */
  uid?: string
  /** 登录时上报的 profile（决定区域；见 {@link StepcodeProduct.authBase}）。 */
  profile?: string
  /**
   * 过期时间（毫秒时间戳字符串）。
   *
   * ⚠️ 静态凭据**永不过期** ⇒ 正常路径下**不写这个字段**。
   * 保留它是为了兼容「用户手写的凭据」与将来的服务端变更；
   * {@link isStepcodeExpired} 在两者都读不到时**保守判未过期**
   * （判成已过期会让每次发消息都先触发一次必然无效的续期探测 ——
   * 与 teleagent 的同款取舍一致）。
   */
  expires_at?: string
  /** 展示用昵称（当前无来源端点，留空即用 uid）。 */
  nickname?: string
  /** 官方哨兵 refresh 标记（见 {@link STEPCODE_STATIC_REFRESH_TOKEN}）。 */
  refresh?: string
}

/** 非空字符串归一（trim 后为空则 undefined）。 */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** 只放行**安全正整数**。 */
function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined
}

/** 只放行布尔（官方 `readBoolean`：非布尔一律 undefined，不做真值转换）。 */
function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/**
 * 解析凭据 JSON；形状不对返回 `undefined`（**不抛错**）。
 *
 * ⚠️ 判据是 `access_token` 非空 —— 它是唯一必需字段。
 * 官方 `readStepBearerToken()` 对 `type:"oauth"` 取 `access`、
 * 对 `type:"api_key"` 取 `key`；我们统一存成 `access_token`
 * （见该字段的注释：账号池判重依赖这个名字）。
 */
export function parseStepcodeCredential(value: string): StepcodeCredential | undefined {
  try {
    const parsed = JSON.parse(value) as StepcodeCredential
    return typeof parsed === 'object' && parsed !== null
      && nonEmptyString(parsed.access_token) !== undefined
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/**
 * 凭据过期时刻（毫秒）；读不到返回 `undefined`。
 *
 * ⚠️ 静态凭据正常没有 `expires_at` ⇒ 返回 `undefined`（「未知」），
 * **不是** `0`（那会被当成 1970 年、恒判已过期）。
 */
export function stepcodeCredentialExpiresAtMs(
  credential: StepcodeCredential,
): number | undefined {
  const raw = nonEmptyString(credential.expires_at)
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * 是否已过期。
 *
 * ⚠️ **读不到过期时间时保守判「未过期」** —— 官方给这类凭据的
 * `expires` 就是 `Number.MAX_SAFE_INTEGER`。判成已过期会让每次发消息
 * 都先触发一次必然失败的续期探测（本 provider 没有续期端点）。
 */
export function isStepcodeExpired(credential: StepcodeCredential): boolean {
  const expiresAt = stepcodeCredentialExpiresAtMs(credential)
  if (expiresAt === undefined) return false
  return expiresAt <= Date.now()
}

/**
 * 是否可续期 —— **恒 `false`**。
 *
 * ⚠️ 不要「优化」成 `true`：官方 `refreshStepOAuth()` 不发任何请求，
 * 只是校验哨兵值后原样返回。详见模块头。
 */
export function isStepcodeRefreshable(_credential: StepcodeCredential): boolean {
  return false
}

/**
 * 推理/目录请求头。
 *
 * 只有一个 `Authorization: Bearer <api_key>`。
 *
 * ⚠️ **没有**渠道密钥、**没有**签名、**没有**归属头 —— 这是 Step Code
 * 与 teleagent（双凭据头 + HMAC 签名）、qoder（WASM 签名）最大的差异，
 * 也是它最不容易出错的地方。**不要**照抄别家的头集合
 * （多发的头可能被网关拒，AGENTS.md 在 TRAE 那条记过
 * 「`content-type` 被叠成重复值 → 400」的教训）。
 */
export function stepcodeAuthHeaders(credential: StepcodeCredential): Record<string, string> {
  return {
    accept: 'application/json',
    authorization: `Bearer ${credential.access_token.trim()}`,
  }
}

/** 生成登录用的 poll token（官方 `randomBytes(32).toString("hex")` → 64 位 hex）。 */
export function generateStepcodePollToken(): string {
  return randomBytes(32).toString('hex')
}

/**
 * `flow_id` 合法性判据（bundle `FLOW_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u`）。
 *
 * ⚠️ 必须校验：官方在 init 与 poll **两处**都校，因为它会被拼进 URL 路径
 * （`/poll/{flow_id}`）—— 不校验就等于把服务端返回值直接注入自己的请求路径。
 */
export const STEPCODE_FLOW_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u

/** `flow_id` 是否合法。 */
export function isValidStepcodeFlowId(value: unknown): value is string {
  return typeof value === 'string' && STEPCODE_FLOW_ID_PATTERN.test(value)
}

/**
 * `uid` 归一（bundle `readBoundedUid`：≤64 字符且 `/^[\w.@:-]+$/u`，否则丢弃）。
 *
 * ⚠️ 同样是「服务端返回值会进本地存储/展示」的输入校验，不要放宽。
 */
export function normalizeStepcodeUid(value: unknown): string | undefined {
  const raw = nonEmptyString(value)
  if (raw === undefined) return undefined
  if (raw.length > 64) return undefined
  return /^[\w.@:-]+$/u.test(raw) ? raw : undefined
}

/**
 * 从服务端信封里提取错误详情（bundle `envelopeDetail`：取 `desc` 字段，
 * 剥掉控制字符后截断到 {@link STEPCODE_MAX_ERROR_DETAIL_LENGTH}）。
 *
 * ⚠️ Step 的业务错误**不放在 HTTP 状态码里**，而是 HTTP 200 +
 * `{ status: <非 0>, desc: "..." }`。只看 `response.ok` 会把这类失败
 * 当成成功（与 Qoder「错误帧必须能抛错」是同型缺陷）。
 */
export function stepcodeEnvelopeDetail(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return ''
  const desc = nonEmptyString((payload as Record<string, unknown>).desc)
  if (desc === undefined) return ''
  // \p{Cc} 控制字符 + \p{Cf} 格式字符（官方同款），防止把终端转义序列带进日志/UI。
  return desc.replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, STEPCODE_MAX_ERROR_DETAIL_LENGTH)
}

/**
 * 信封是否表示失败（官方判据：`payload.status !== undefined && payload.status !== 0`）。
 *
 * ⚠️ **`status` 缺席不算失败** —— 官方就是这么写的：poll 的成功响应
 * 可能根本没有 `status` 字段。写成 `status !== 0` 会把正常响应全判成失败。
 */
export function isStepcodeEnvelopeError(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false
  const status = (payload as Record<string, unknown>).status
  return status !== undefined && status !== 0
}

/** 归一后的模型条目（远端与兜底**共用**的形状）。 */
export interface StepcodeModelEntry {
  id: string
  /**
   * 展示名。
   *
   * ⚠️ 官方 `stepModelConfig(entry.id, entry.id, …)` 把 **id 同时当 name**
   * （远端 `/v1/models` 不下发独立展示名）。我们照此办理 ——
   * **不编造**「Step 5 Preview」这类好看的中文名，因为拿不到权威来源
   * （AGENTS.md 在 Qoder 上记过「展示名不能只写厂商」的教训，
   * 但那条的前提是**目录里有真实展示名**；这里没有）。
   */
  name: string
  /**
   * 上下文窗口（远端 `max_input_tokens`）。
   *
   * **`0` 是「未知」哨兵**，不是合法窗口 —— `resolveModel` 必须判 `> 0`
   * 才声明（与 teleagent / minimax 同口径）。
   */
  contextWindow: number
  /** 是否支持图片输入（远端 `enable_vision_input`）。 */
  supportsImage: boolean
  /** 是否支持思考（远端 `enable_reason`）。 */
  reasoning: boolean
  /**
   * 支持的思考档位（远端 `reasoning_effort_support_list`）。
   *
   * ⚠️ 空/缺失时**整个键不产出**（`undefined`），而不是给空数组 ——
   * 调用方据「有没有这个键」决定是否声明 `reasoning`。
   */
  efforts?: readonly string[]
  /** 服务端下发的模型类型（用于白名单过滤，展示不用）。 */
  modelType?: string
}

/**
 * 把**远端**目录条目归一。
 *
 * 字段名逐字对应官方 `fetchStepModels` 的解析：
 * `id` / `model_type` / `max_input_tokens` / `enable_reason` /
 * `enable_vision_input` / `reasoning_effort_support_list`。
 *
 * ⚠️ 解析不出 `id` ⇒ `undefined`（**不编造**，由调用方过滤）。
 * ⚠️ `reasoning_effort_support_list` 只保留**非空字符串**项
 * （官方 `readStringArray` 的 `filter(v => typeof v === "string" && v.trim())`），
 * 且过滤后为空 ⇒ 整个键不产出。
 */
export function normalizeStepcodeModel(raw: unknown): StepcodeModelEntry | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const id = nonEmptyString(record.id)
  if (id === undefined) return undefined

  const efforts = Array.isArray(record.reasoning_effort_support_list)
    ? record.reasoning_effort_support_list.filter(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    ).map((value) => value.trim())
    : undefined

  const reasoning = optionalBoolean(record.enable_reason)
  return {
    id,
    name: id,
    // 远端没给窗口时用官方默认值（`STEP_MODEL_DEFAULTS.contextWindow = 256000`）。
    contextWindow: positiveInt(record.max_input_tokens) ?? STEPCODE_DEFAULT_CONTEXT_WINDOW,
    supportsImage: optionalBoolean(record.enable_vision_input) === true,
    // ⚠️ 官方口径：`reasoning: meta?.reasoning ?? (hasEfforts ? true : STEP_MODEL_DEFAULTS.reasoning)`
    // —— 有档位就认为支持思考，否则用默认 false。照抄这条推论链，
    // 不要简化成 `record.enable_reason === true`（会在服务端只下发档位
    // 而漏发 enable_reason 时把思考能力判没）。
    reasoning: reasoning ?? (efforts !== undefined && efforts.length > 0 ? true : false),
    ...efforts !== undefined && efforts.length > 0 ? { efforts: Object.freeze(efforts) } : {},
    ...nonEmptyString(record.model_type) === undefined ? {} : { modelType: nonEmptyString(record.model_type) },
  }
}

/**
 * 按官方口径过滤 + 去重远端目录。
 *
 * 复刻 `fetchStepModels` 的两步：
 * 1. **条件式**类型过滤（只有当**至少一个**条目带 `model_type` 时才启用白名单）；
 * 2. 按 `id` 去重，保留首次出现。
 *
 * ⚠️ 第 1 步的「条件式」是关键，见 {@link STEPCODE_USABLE_MODEL_TYPES} 的注释。
 */
export function filterStepcodeModels(
  entries: readonly StepcodeModelEntry[],
): readonly StepcodeModelEntry[] {
  const typed = entries.some((entry) => entry.modelType !== undefined)
  const usable = typed
    ? entries.filter(
      (entry) => entry.modelType !== undefined && STEPCODE_USABLE_MODEL_TYPES.has(entry.modelType),
    )
    : entries
  const seen = new Set<string>()
  const result: StepcodeModelEntry[] = []
  for (const entry of usable) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    result.push(entry)
  }
  return result
}

/**
 * 解析远端 `/v1/models` 响应体。
 *
 * 官方只认 `{ data: [...] }`（`Array.isArray(payload.data) ? payload.data : []`），
 * 非对象条目直接跳过。失败一律返回 `[]`（**不抛错**）——
 * 目录是展示信息，不该让整个 provider 报错。
 */
export function parseStepcodeModelsPayload(payload: unknown): readonly StepcodeModelEntry[] {
  if (typeof payload !== 'object' || payload === null) return []
  const data = (payload as Record<string, unknown>).data
  if (!Array.isArray(data)) return []
  const entries: StepcodeModelEntry[] = []
  for (const raw of data) {
    const entry = normalizeStepcodeModel(raw)
    if (entry !== undefined) entries.push(entry)
  }
  return filterStepcodeModels(entries)
}

/** 兜底表条目转归一形状（**直接搬运字面量**，不走远端归一规则）。 */
export function stepcodeFallbackToEntry(model: StepcodeFallbackModel): StepcodeModelEntry {
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    supportsImage: model.supportsImage,
    // 兜底表没有 enable_reason 字段：有档位即认为支持思考（与远端推论链一致）。
    reasoning: model.efforts !== undefined && model.efforts.length > 0,
    ...model.efforts === undefined || model.efforts.length === 0
      ? {}
      : { efforts: Object.freeze([...model.efforts]) },
  }
}

/** 默认产品下的兜底条目（当前为空表，见 {@link StepcodeProduct.fallbackModels}）。 */
export function stepcodeFallbackEntries(
  product: StepcodeProduct = STEPCODE,
): readonly StepcodeModelEntry[] {
  return product.fallbackModels.map(stepcodeFallbackToEntry)
}

/**
 * 官方 `readStepBearerToken()` 的等价实现：从凭据里取 Bearer 值。
 *
 * ⚠️ 空串必须归一成 `undefined`（官方 `.trim() || undefined`）——
 * 否则调用方会把 `Bearer ` 发出去，拿到一个语焉不详的 401。
 */
export function stepcodeBearerToken(credential: StepcodeCredential | undefined): string | undefined {
  if (credential === undefined) return undefined
  const token = credential.access_token?.trim()
  return token === undefined || token.length === 0 ? undefined : token
}
