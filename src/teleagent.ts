/**
 * TeleAgent 凭据结构、身份头构造、签名与回调解析（纯函数，可单测）。
 *
 * ## 四条必须记住的实测事实
 *
 * 1. **鉴权头是 `X-Token`，不是 `Authorization: Bearer <token>`**
 *    （asar `j8t()` 与 renderer `bM()` 两处独立证据一致）。
 *    推理请求的 `Authorization: Bearer` 放的是**内置 NewApi apiKey**
 *    （`OUt.NewApi.options.apiKey`），用户身份走 `X-Token` —— 两个凭据
 *    在**两个不同的头**上，混用会 401（实测：把用户 token 塞进 Bearer 打
 *    `user_info` 回 401 `4001 当前令牌是否存在`）。
 * 2. ⚠️⚠️ **推理端点需要签名，业务端点不需要**（2026-10-07 实测发现）。
 *    推理缺签名会被拒为 `40301`（文案写「客户端版本过低」，**与版本号无关**）
 *    或 `40104 unsupported sign version`。
 *    两组头都要发，且**时间戳单位不同** —— 见 {@link teleagentSignHeaders}。
 * 3. **token 是标准 JWT，`exp` 可解**（实测 `exp` = 2026-11-05，约 30 天）。
 *    ⚠️ 第一版误判为「不是 JWT、没有过期时间」—— 当时只是没去解它。
 *    现 `teleagentCredentialExpiresAtMs` **优先** `expires_at`、**回退**解 JWT。
 *    ⚠️ 但 `exp` 只作**展示**用（本 provider 无续期端点）。
 * 4. **没有 refresh 端点**（asar 全文无 refresh_token / ExchangeToken /
 *    token 刷新调用）。故 `isTeleagentRefreshable` 恒 `false`，
 *    `refresh()` 退化为「探测有效性」（与 Loomy 同型），
 *    过期时**只能重新登录**，UI 必须如实显示。
 */

import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import {
  TELEAGENT,
  TELEAGENT_ROUTE_TARGET_HEADER,
  type TeleagentFallbackModel,
  type TeleagentProduct,
} from './teleagent-product.js'

/** 凭据结构（存 `ctx.credentials`）。 */
export interface TeleagentCredential {
  /**
   * 用户 token（登录回调 `?token=` 回传，进 `X-Token` 头）。
   *
   * ⚠️ 这是**唯一**的用户身份凭据 —— TeleAgent 没有 refresh_token。
   */
  token: string
  /**
   * 设备标识（进 `X-SuperAgent-Device-Id`）。
   *
   * ⚠️ 客户端用的是它自己持久化的 deviceId（回退 MAC 地址）。
   * 我们**没有**那个值，故由本插件自行生成一次并随凭据持久化 ——
   * 见 `generateTeleagentDeviceId()`。留空时该头**不下发**（不发明值）。
   */
  device_id?: string
  /** 安装标识（进 `X-SuperAgent-Install-Id`，可选）。 */
  install_id?: string
  /**
   * **签名密钥**（本地会话密钥，进 HMAC）。
   *
   * ⚠️ 客户端的 `sessionKey` 是 `randomBytes(32).toString('base64url')`，
   * **每次进程启动新建、不经服务端注册** —— 故服务端不可能校验其内容，
   * 只能校验「头存在 + 版本合法 + 时间戳新鲜」。我们因此自己生成一个并持久化
   *（与 `device_id` 同策略）。
   *
   * ⚠️ 缺失时**不发签名头**（让服务端如实报错，而不是发一组必然无效的头）。
   */
  sign_key?: string
  /** 账号标识（登录后由 `cowork/user_info` 回填，用于多账号去重与展示）。 */
  account_id?: string
  /** 展示名（`accountName` / 手机号尾号，登录后回填）。 */
  nickname?: string
  /**
   * 毫秒时间戳字符串（**仅当**服务端将来下发过期时间时由我们写入）。
   *
   * ⚠️ 当前登录路径拿不到过期时间，故**恒不写入**本字段；
   * 保留它是为了「上游哪天补上 expires_in」时无需改形状。
   */
  expires_at?: string
}

/** 读非空字符串。 */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * 生成插件侧的 deviceId。
 *
 * ⚠️⚠️ **格式是 12 位 hex，不是 32 位** —— 实测官方客户端
 * `~/.local/share/TeleAgent/app-auth/device-meta.json` 里是
 * `"deviceId": "e88088715b6f"`（**12 个 hex 字符**）。
 * 第一版我按 TRAE 的 `generateMachineId()` 惯性写成 32 位 hex，
 * **那是错的**（虽然服务端未因此报错，但形态与真实客户端不符）。
 *
 * 与 TRAE 同策略：客户端要求一个稳定的设备标识，但它**不校验**该值来自何处，
 * 故我们自己造一个并**随设备持久化**，保证同一设备每次请求同值。
 */
export function generateTeleagentDeviceId(): string {
  return randomBytes(6).toString('hex')
}

/**
 * 凭据过期时间（毫秒）。
 *
 * ⚠️ **优先显式 `expires_at`，回退解 JWT `exp`** —— 本注释此前写「只认显式的
 * `expires_at`，token 不是 JWT」，那是**没去解它**的误判（2026-10-07 实测：
 * token 形如 `<tenant>:<jwt>`，payload 带 `exp`，约 30 天）。
 * 返回 `undefined` 表示「未知」，调用方**必须**把
 * 未知当作「未过期」处理（否则每次使用都触发一次必然无效的续期）。
 *
 * ⚠️ 解出来的值只作**展示**用：本 provider 没有续期端点，过期只能重新登录。
 *
 * ⚠️ **单位兼容**：`> 1e12` 视为毫秒，否则视为秒 —— 与 `src/buddy.ts` /
 * `src/minimax.ts` 的 `credentialExpiresAtMs` 同一约定。
 */
export function teleagentCredentialExpiresAtMs(
  credential: TeleagentCredential,
): number | undefined {
  const raw = credential.expires_at
  if (raw !== undefined) {
    // ⚠️ 只认**纯数字**串：`Number(' 123 ')` 会静默变 123、`Number('')` 会变 0，
    // 两者都不该放行（0 会被当成「1970 年过期」⇒ 恒判已过期）。
    if (/^\d+$/u.test(raw)) {
      const value = Number(raw)
      const parsed = value > 1_000_000_000_000 ? value : value * 1000
      if (Number.isFinite(parsed) && parsed > 0) return parsed
    }
  }
  // ⚠️ **回退解 JWT `exp`**（2026-10-07 实测修正）：
  // token **是**标准 JWT，payload 含 `exp`（实测 2026-11-05，约 30 天）。
  // 第一版以为「不是 JWT、没有可解析的过期时间」——**那是错的**，
  // 当时只是没去解它。故这里补上 JWT 回退（与 minimax 的 `decodeJwtExpMs` 同法）。
  // ⚠️ 只作**展示**用：本 provider 无续期端点，过期只能重新登录。
  return decodeJwtExpMs(credential.token)
}

/**
 * 从 JWT 解出 `exp`（毫秒）。
 *
 * ⚠️ 与 `src/minimax.ts` 的同名函数同法（那边也保留它兼容上游改发 JWT）。
 * 实测 TeleAgent 的 token **确实是**三段式 JWT（`Em9xR4:eyJ…`，首段是 tenant 前缀），
 * 故本函数对真实凭据**命中**（与 minimax 那边「恒不命中」相反）。
 */
export function decodeJwtExpMs(token: string): number | undefined {
  // ⚠️ token 形如 `Em9xR4:eyJhbGci….<sig>`（首段是 tenant 前缀 + 冒号），
  // 故**不能**直接 `split('.')` 取第 2 段 —— 要先剥掉冒号前缀。
  const body = token.includes(':') ? token.slice(token.indexOf(':') + 1) : token
  const segments = body.split('.')
  if (segments.length !== 3 || segments[1] === undefined) return undefined
  try {
    const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8')) as {
      exp?: unknown
    }
    // ⚠️ 乘 1000 后仍须有限：`exp` 极大时会溢出成 `Infinity`，
    // 而 `Infinity` 会被下游当成「永不过期」——宁可返回 undefined。
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp)
      ? (Number.isFinite(payload.exp * 1000) ? payload.exp * 1000 : undefined)
      : undefined
  } catch {
    return undefined
  }
}

/** 凭据是否已过期（**无过期信息时保守视为未过期**，见上）。 */
export function isTeleagentExpired(
  credential: TeleagentCredential,
  nowMs = Date.now(),
): boolean {
  const expiresAt = teleagentCredentialExpiresAtMs(credential)
  return expiresAt !== undefined && nowMs >= expiresAt
}

/**
 * 凭据是否可续期。
 *
 * ⚠️ **恒 `false`** —— TeleAgent 没有 refresh 端点（模块头第 3 点）。
 * 保留这个函数（而不是内联 false）是为了与其余 provider 的形状对齐，
 * 也让账号池的 `refreshable` 字段有一个**显式的、可测的**来源。
 */
export function isTeleagentRefreshable(_credential: TeleagentCredential): boolean {
  return false
}

/**
 * 身份头集合（`X-Token` + 时间戳 + nonce + 设备标识 + 路由目标）。
 *
 * 复刻 asar `j8t()`（main 侧）与 renderer `bM()` 的头集合，两处一致：
 * ```
 * X-Token / X-SuperAgent-Timestamp / X-SuperAgent-Nonce
 * X-SuperAgent-Device-Id / X-SuperAgent-Install-Id / X-Route-Target
 * ```
 *
 * ⚠️ **`X-SuperAgent-Timestamp` 是秒级**（`Math.floor(Date.now()/1e3)`），
 * 写成毫秒会被服务端判为「时间戳越界」而拒绝（与签名类端点的常见形态一致）。
 * ⚠️ **Timestamp / Nonce 每次请求都要重算**（nonce 顾名思义是一次性的），
 * 故本函数**每次调用生成新值**，不能缓存结果对象。
 *
 * @param nowSec 可注入的当前秒级时间戳（测试用）
 * @param nonce  可注入的 nonce（测试用）
 */
export function teleagentIdentityHeaders(
  credential: TeleagentCredential,
  product: TeleagentProduct = TELEAGENT,
  nowSec: number = Math.floor(Date.now() / 1000),
  nonce: string = randomUUID(),
): Record<string, string> {
  return {
    'X-Token': credential.token,
    'X-SuperAgent-Timestamp': String(nowSec),
    'X-SuperAgent-Nonce': nonce,
    'X-Route-Target': TELEAGENT_ROUTE_TARGET_HEADER,
    ...nonEmptyString(credential.device_id) === undefined
      ? {}
      : { 'X-SuperAgent-Device-Id': credential.device_id },
    ...nonEmptyString(credential.install_id) === undefined
      ? {}
      : { 'X-SuperAgent-Install-Id': credential.install_id },
    // 客户端另有 X-App-Version / X-OS-Type（renderer `bM()`），
    // 但那是**遥测向**字段、非鉴权必需；这里带上以贴近真实客户端形态。
    'X-App-Version': product.appVersion,
    'X-OS-Type': process.platform,
  }
}

/**
 * 业务请求头（user_info / logout 等 GET 端点）。
 *
 * ⚠️ **不设 `Authorization`** —— 业务端点只认 `X-Token`。
 * 加一个假的 `Authorization: Bearer <用户 token>` 是**猜测**，
 * 且可能让网关按 Bearer 分支去校验那个根本不是 Bearer 凭据的值。
 */
export function teleagentHeaders(
  credential: TeleagentCredential,
  product: TeleagentProduct = TELEAGENT,
): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(teleagentIdentityHeaders(credential, product))) {
    headers.set(key, value)
  }
  headers.set('Accept', 'application/json')
  return headers
}

/**
 * 推理端点的**签名头**（`X-SA-*` + `X-SuperAgent-*` 两组）。
 *
 * ## 算法（asar `LocalAuthService.signRequest` **原文**）
 *
 * ```js
 * const hZ = "local-v1"
 * signRequest(e) {
 *   const n = new URL(e.url), i = `${n.pathname}${n.search}`
 *   const s = String(Date.now())                    // ⚠️ 毫秒
 *   const o = Lr.randomBytes(12).toString("hex")
 *   const a = [hZ, e.method.toUpperCase(), i, s, o].join("\n")
 *   const c = Lr.createHmac("sha256", sessionKey).update(a).digest("base64url")
 *   return { "X-SA-Sign-Version": hZ, "X-SA-Timestamp": s, "X-SA-Nonce": o, "X-SA-Signature": c }
 * }
 * ```
 *
 * ## ⚠️ 三个容易踩的点
 *
 * 1. **`sessionKey` 是本地随机的**（客户端 `ensureSession()`：`randomBytes(32)`
 *    转 base64url，每次进程启动新建）—— **不经任何服务端注册**。
 *    ⇒ 服务端**不可能**校验签名内容（没有可比密钥），它只能校验
 *    「头存在 + 版本合法 + 时间戳新鲜」。故本插件自己生成一个即可
 *    （用凭据里的 `sign_key`，缺失时生成并持久化 —— 与 deviceId 同策略）。
 *    ⚠️ 但这**仍是待端到端确认的假设**：见 `scripts/probe-teleagent-infer-sign.mjs`。
 * 2. **`X-SA-Timestamp` 是毫秒**（`Date.now()`），而
 *    `X-SuperAgent-Timestamp` 是**秒**（`Math.floor(Date.now()/1e3)`）——
 *    两组头的单位**不同**，写混会被判时间戳越界。
 * 3. **两套头都要发**：`X-SA-*`（renderer 侧）与 `X-SuperAgent-*`（Go 引擎侧）。
 *    实测单发任一组都过不了；且 `X-SuperAgent-Signature` /
 *    `X-SuperAgent-Sign-Version` **不在 renderer 代码里**（只在 Go 二进制的头名
 *    常量里），只读 renderer 必然漏掉（我第一版就漏了 → `40101`）。
 */
export function teleagentSignHeaders(
  method: string,
  pathWithQuery: string,
  credential: TeleagentCredential,
  product: TeleagentProduct = TELEAGENT,
  nowMs: number = Date.now(),
): Record<string, string> {
  const signKey = credential.sign_key ?? ''
  // 无密钥时不发签名头（让服务端如实报错，而不是发一组必然无效的头）。
  if (signKey.length === 0) return {}

  const path = pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`
  // ── X-SA-*（renderer 侧：毫秒 + base64url）──
  const saTs = String(nowMs)
  const saNonce = randomBytes(12).toString('hex')
  const saMsg = [product.signVersion, method.toUpperCase(), path, saTs, saNonce].join('\n')
  const saSig = createHmac('sha256', signKey).update(saMsg).digest('base64url')

  // ── X-SuperAgent-*（Go 引擎侧：秒 + UUID nonce）──
  const sa2Ts = String(Math.floor(nowMs / 1000))
  const sa2Nonce = randomUUID()
  const sa2Sig = createHmac('sha256', signKey).update([sa2Ts, sa2Nonce].join('\n')).digest('base64url')

  return {
    [product.signHeaders.version]: product.signVersion,
    [product.signHeaders.timestamp]: saTs,
    [product.signHeaders.nonce]: saNonce,
    [product.signHeaders.signature]: saSig,
    [product.superAgentHeaders.signVersion]: product.signVersion,
    [product.superAgentHeaders.timestamp]: sa2Ts,
    [product.superAgentHeaders.nonce]: sa2Nonce,
    [product.superAgentHeaders.signature]: sa2Sig,
  }
}

/**
 * 推理请求头。
 *
 * ⚠️⚠️ **两个凭据在两个不同的头上**（模块头第 1 点）：
 * - `Authorization: Bearer <内置 NewApi apiKey>` —— 渠道身份（asar 硬编码）；
 * - `X-Token: <用户 token>` —— 用户身份（决定谁的额度、谁的账号）。
 * 把用户 token 塞进 Bearer 会 401（Bearer 校验不过 apiKey 形状）。
 *
 * ⚠️⚠️ **推理端点还必须带两组签名头**（2026-10-07 实测发现；业务端点不需要）：
 * 见 {@link teleagentSignHeaders}。缺了会被拒为 `40301`（文案是
 * 「客户端版本过低」，**误导性极强** —— 与版本号无关）或
 * `40104 unsupported sign version`。
 *
 * ⚠️ `Accept: text/event-stream`：请求体带 `stream: true`，响应是 SSE。
 */
export function teleagentInferHeaders(
  credential: TeleagentCredential,
  product: TeleagentProduct = TELEAGENT,
  options: { method?: string; pathWithQuery?: string } = {},
): Headers {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${product.inferApiKey}`)
  headers.set('Content-Type', 'application/json')
  headers.set('Accept', 'text/event-stream')
  for (const [key, value] of Object.entries(teleagentIdentityHeaders(credential, product))) {
    headers.set(key, value)
  }
  // ⚠️ 签名头只在这里加（业务头**不加** —— 业务端点实测不需要，多发是噪音）。
  for (const [key, value] of Object.entries(teleagentSignHeaders(
    options.method ?? 'POST',
    options.pathWithQuery ?? '/api/v1/chat/completions',
    credential,
    product,
  ))) {
    headers.set(key, value)
  }
  return headers
}

/** 归一后的模型条目（远端与兜底**共用**的形状）。 */
export interface TeleagentModelEntry {
  id: string
  name: string
  /**
   * 上下文窗口。**`0` 是「未知」哨兵**，不是合法窗口 ——
   * `resolveModel` 必须判 `> 0` 才声明（与 minimax 同口径）。
   */
  contextWindow: number
  /** 单次输出上限；非法/缺失时**整个键不产出**（否则 DSH 抛 INVALID_MODEL_MAX_TOKENS）。 */
  maxTokens?: number
  supportsImage: boolean
}

/** 只放行**安全正整数**。 */
function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined
}

/**
 * 把**远端**目录条目归一（形状对齐 opencode 引擎的 provider model）。
 *
 * 认两种字段形态（`limit.context` / `contextWindow`），因为服务端目录
 * 由引擎侧消费、字段名与我们看到的一致但版本会变。
 * ⚠️ 解析不出 `id` ⇒ `undefined`（**不编造**，由调用方过滤）。
 */
export function normalizeTeleagentModel(raw: unknown): TeleagentModelEntry | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const id = nonEmptyString(record.id) ?? nonEmptyString(record.model_id) ?? nonEmptyString(record.modelId)
  if (id === undefined) return undefined
  const name = nonEmptyString(record.name) ?? nonEmptyString(record.display_name) ?? id
  const limit = typeof record.limit === 'object' && record.limit !== null
    ? record.limit as Record<string, unknown>
    : {}
  const contextWindow = positiveInt(limit.context)
    ?? positiveInt(record.contextWindow)
    ?? positiveInt(record.context_window)
    ?? 0
  const maxTokens = positiveInt(limit.output) ?? positiveInt(record.maxTokens)
  const modalities = typeof record.modalities === 'object' && record.modalities !== null
    ? record.modalities as Record<string, unknown>
    : undefined
  const inputs = Array.isArray(modalities?.input)
    ? (modalities as { input: unknown[] }).input.filter((v): v is string => typeof v === 'string')
    : []
  return {
    id,
    name,
    contextWindow,
    ...maxTokens === undefined ? {} : { maxTokens },
    supportsImage: inputs.includes('image'),
  }
}

/**
 * 兜底表条目转归一形状。
 *
 * ⚠️ **直接搬运字面量**，不调用 `normalizeTeleagentModel` ——
 * 两条路径只共用**输出形状**，不共用归一规则（与 minimax 同口径）。
 * ⇒ 改归一规则时必须同步核对兜底表。
 */
export function teleagentFallbackToEntry(model: TeleagentFallbackModel): TeleagentModelEntry {
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    supportsImage: model.supportsImage,
  }
}

/** 默认产品下的兜底条目。 */
export function teleagentFallbackEntries(
  product: TeleagentProduct = TELEAGENT,
): readonly TeleagentModelEntry[] {
  return product.fallbackModels.map(teleagentFallbackToEntry)
}

/** 解析凭据 JSON；形状不对返回 undefined（不抛错）。 */
export function parseTeleagentCredential(value: string): TeleagentCredential | undefined {
  try {
    const parsed = JSON.parse(value) as TeleagentCredential
    return typeof parsed === 'object' && parsed !== null
      && typeof parsed.token === 'string' && parsed.token.trim().length > 0
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/**
 * 解析登录产物。
 *
 * ## 为什么必须宽容到三种输入（真实约束）
 *
 * 官方桌面端靠**自带 BrowserWindow 监听导航**拿 token（asar `eOe()`：
 * 命中 `pathname.includes('/cowork/auth') && searchParams.get('code')` 即取
 * `searchParams.get('token')`）。DSH 插件没有那个窗口，只能让用户把
 * 浏览器地址栏的**最终 URL** 粘回来 —— 而用户实际会粘到什么，
 * 取决于他停在哪一步：
 *
 * | 输入形态 | 来源 | 处理 |
 * |---|---|---|
 * | `teleai-cowork://auth?token=…` | **当前实际可用的那条**：官方回调页拿它唤起桌面端 | 取 `token` |
 * | `…/cowork/auth?code=…&token=…` | 早期形态，**2.5.3 实测已不产出**（见下） | 取 `token` |
 * | 裸 token 串 | 用户从开发者工具 / 复制按钮拿到的 | 整串当 token |
 *
 * ⚠️️ **2026-10-07 实测推翻了「地址栏会带 token」这个假设**（用户截图为证）：
 * 授权完成后浏览器落在 `…/superCowork/sapi/cowork/auth?code=ucc.XXXXXX` ——
 * **只有 `code`、没有 `token`**，页面显示「登录成功 / 已完成账号校验，正在进入…」，
 * 并触发 Chrome 的「此站点正在尝试打开 TeleAgent」弹窗。
 * 桌面端自己的日志（`~/.local/share/TeleAgent/logs/main-2.5.3.log`）给出机制：
 * ```
 * [LoginWindow] Intercepted deeplink navigation from login window
 * [Deeplink]    Intercepted in-app deeplink navigation { route: 'auth' }
 * ```
 * ⇒ token 装在 **`teleai-cowork://` 那条 deeplink URL** 里、靠**拦截导航**取走，
 * 它**从不**出现在地址栏。所以下面那条「只有 code」的提示**不能**再让用户
 * 去地址栏找 `token=`（那是条走不通的指示，实测让用户反复粘贴失败），
 * 必须指向 deeplink。
 *
 * ⚠️ 另：假 code 打 `/cowork/auth` 回 `400 {"error":"get token error"}`
 * ⇒ 服务端**确实**在那一步做 code→token。但这**仍不等于**存在一个我们可以
 * 调用的交换端点（真 code 的响应体给不给 token 尚未取证），
 * 故**还是不要**自行发明交换 —— 那条红线成立，只是理由变了。
 *
 * @returns token 字符串；无法解析时返回 undefined 并给出 `reason`
 */
export function parseTeleagentCallbackInput(
  input: string,
): { token: string } | { reason: string } {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (raw.length === 0) return { reason: '粘贴内容为空' }

  // 形态一/二：URL（http/https 或自定义 scheme）
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(raw)) {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return { reason: '无法解析为 URL' }
    }
    const token = url.searchParams.get('token')
    if (token !== null && token.trim().length > 0) return { token: token.trim() }
    // 少数部署把 token 放在 hash 片段里（`#/callback?token=…`）
    if (url.hash.includes('?')) {
      const hashToken = new URLSearchParams(url.hash.slice(url.hash.indexOf('?') + 1)).get('token')
      if (hashToken !== null && hashToken.trim().length > 0) return { token: hashToken.trim() }
    }
    // 只有 code：给出**走得通**的指示。
    // ⚠️ 这条指引已改过**两次**，两次都被实测证伪，别再改回去：
    // ① 「去地址栏复制含 token= 的完整 URL」—— 地址栏**只有 code**（2026-10-07 证伪）。
    // ② 「F12 → Console 复制 teleai-cowork:// 那条链接」—— Console 里**根本没有它**：
    //    浏览器不打印跨协议导航，桌面端日志也只记 `route: 'auth'`、不记 URL
    //   （2026-10-08 用户截图证伪：Console 里只有 `SideBar.*.js` 的页面日志与
    //     无关的统计拦截错误。完整机制见 docs/teleagent-protocol-notes.md §3）。
    // ⇒ 唯一能看到 token 的地方是 **Network 面板**。
    // ⚠️ 也**不要**改成「让用户只粘 code、由我们去换」：code 是**一次性**的，
    // 浏览器消费后再打同一 code，返回与假 code **逐字节相同**的
    // `{"error":"get token error"}`（2026-10-08 实测）⇒ 没有对我们开放的交换端点。
    if (url.searchParams.get('code') !== null) {
      return {
        reason: '这一跳只给了 code，而 code 是一次性的（刚才那次授权已经把它用掉了），'
          + '所以拿它换不到 token；地址栏和 Console 里也都没有 token。'
          + '请这样取：F12 → Network → 勾选「保留日志」→ 重新完成一次授权 → '
          + '点开那条 cowork/auth?code=… 请求，在它的 Location 响应头或响应体里'
          + '找到 token=，把那串 token 粘进来（整条含 token 的链接也可以）。',
      }
    }
    return { reason: 'URL 里没有 token 参数' }
  }

  // 形态三：裸 token —— 必须排除「带空格的整句话」这类误粘
  if (/\s/u.test(raw)) {
    return { reason: '无法识别：请粘贴完整回调 URL（含 token=）或直接粘贴 token' }
  }
  return { token: raw }
}
