/**
 * Step Code 登录流程（**浏览器授权 + 轮询**，无需本地回调端口）。
 *
 * ## 为什么这条路径比 teleagent / antigravity 都简单
 *
 * 官方 CLI 的订阅登录**不是** OAuth 授权码 + loopback 回调，而是
 * 「服务端签发 flow_id → 用户在**任意**浏览器里打开授权页 → 本地轮询取凭据」。
 * ⇒ 插件既不需要起本地 HTTP 监听（没有端口可泄漏、也没有防火墙问题），
 * 也不需要用户手工粘贴回调 URL（teleagent 那条路）。
 * 与 `qoder` / `minimax` 的设备码轮询同型，故接线方式也照它们
 * （`startLogin()` 立即返回 `loginUrl`，后台异步落定）。
 *
 * ## 全流程（逐字复刻官方 bundle，模块见括号）
 *
 * ```
 * 1. pollToken = randomBytes(32).hex                     (step-provider/index.js)
 * 2. POST {authBase}/api/stdhttp/v1/cli-login/init        (login-client.js)
 *      headers: accept: application/json
 *               authorization: Bearer <pollToken>          ← ⚠️ pollToken 走 Bearer
 *               content-type: application/json
 *      body:    { profile, origin, client:{name,version,platform} }
 *      resp:    { flow_id, poll_interval_sec, expires_at }  ← expires_at 是**秒**
 * 3. 浏览器打开 {authBase}/cli-login-remote?flow_id=<flow_id>
 * 4. 轮询 GET {authBase}/api/stdhttp/v1/cli-login/poll/{flow_id}
 *      resp: { state:"pending" }                          → 继续等
 *            { state:"failed", reason:"denied"|… }        → 抛错（denied 有专门文案）
 *            { state:"ready", credential:{api_key}, uid? }→ 成功
 * ```
 *
 * ⚠️ **`pollToken` 是本地随机值，且当作 Bearer 发送**（不是 query、不是自定义头）。
 * 它把「本地这次轮询」与「浏览器里那次授权」绑在一起 —— 服务端据此决定
 * 把谁的 `api_key` 交给谁。搞错传递方式会得到一个语焉不详的 401。
 *
 * ⚠️ **响应带信封**：HTTP 200 也可能是失败（`{status:<非0>, desc:"…"}`）。
 * 官方判据是 `payload.status !== undefined && payload.status !== 0`
 * ——`status` **缺席不算失败**（poll 的成功响应就可能没有它）。
 * 见 `stepcode.ts` 的 {@link isStepcodeEnvelopeError}。
 *
 * ⚠️ **`expires_at` 是秒级 Unix 时间戳**（官方 `init.expiresAt * 1000 - Date.now()`）。
 * 当成毫秒会让登录在 1970 年就「已超时」。
 */

import {
  STEPCODE,
  STEPCODE_LOGIN_REQUEST_TIMEOUT_MS,
  STEPCODE_LOGIN_TIMEOUT_MS,
  STEPCODE_MAX_POLL_INTERVAL_SEC,
  STEPCODE_MAX_RESPONSE_BYTES,
  STEPCODE_MIN_POLL_INTERVAL_MS,
  stepcodeAuthorizeUrl,
  stepcodeLoginInitUrl,
  stepcodeLoginPollUrl,
  trimTrailingSlash,
  type StepcodeProduct,
} from './stepcode-product.js'
import {
  generateStepcodePollToken,
  isStepcodeEnvelopeError,
  isValidStepcodeFlowId,
  normalizeStepcodeUid,
  parseStepcodeCredential,
  stepcodeEnvelopeDetail,
  type StepcodeCredential,
} from './stepcode.js'

/** 在浏览器中打开 URL；永不抛出（与 `qoder-oauth.ts` 的同名类型一致）。 */
export type OpenBrowser = (url: string) => void | Promise<void>

/** 登录请求错误的三类成因（bundle `StepCliLoginRequestError.kind`）。 */
export type StepcodeLoginErrorKind = 'protocol' | 'http' | 'transport'

/**
 * 登录请求错误。
 *
 * ⚠️ `kind` 决定**能否重试**（见 {@link isRetryableStepcodeLoginError}）：
 * `protocol`（响应形状不对）**永不重试** —— 重试只会得到同样形状；
 * `transport`（网络层）与 `http`（408/429/5xx）才值得重试。
 */
export class StepcodeLoginRequestError extends Error {
  constructor(
    readonly kind: StepcodeLoginErrorKind,
    message: string,
    readonly httpStatus?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'StepcodeLoginRequestError'
  }
}

/**
 * 是否可重试（bundle `isRetryableStepCliLoginError` 逐字复刻）。
 *
 * ```js
 * if (!(e instanceof StepCliLoginRequestError) || e.kind === "protocol") return false
 * const status = e.httpStatus
 * if (status === undefined) return e.kind === "transport"
 * return status === 408 || status === 429 || status >= 500
 * ```
 *
 * ⚠️ **401/403 不在可重试集合里** —— 那是 pollToken 或 profile 不对，
 * 重试一万次也不会变对（且会把服务端打出限流）。
 */
export function isRetryableStepcodeLoginError(error: unknown): boolean {
  if (!(error instanceof StepcodeLoginRequestError) || error.kind === 'protocol') return false
  const status = error.httpStatus
  if (status === undefined) return error.kind === 'transport'
  return status === 408 || status === 429 || status >= 500
}

/** `init` 的成功产物。 */
export interface StepcodeLoginInit {
  /** 服务端签发的流程 ID（已按 `FLOW_ID_PATTERN` 校验）。 */
  flowId: string
  /** 给用户打开的授权页完整 URL。 */
  authorizeUrl: string
  /** 轮询间隔（**秒**，已 clamp 到 ≤ {@link STEPCODE_MAX_POLL_INTERVAL_SEC}）。 */
  pollIntervalSec: number
  /** 流程过期时刻（**秒级** Unix 时间戳）。 */
  expiresAt: number
}

/** `poll` 的三态结果。 */
export type StepcodeLoginPollResult =
  | { state: 'pending' }
  | { state: 'failed'; reason: 'denied' | 'unknown' }
  | { state: 'ready'; apiKey: string; uid?: string }

/** 一次登录流程的结果（形状对齐 `QoderLoginFlowResult`，便于 RPC 分支复用）。 */
export interface StepcodeLoginFlowResult {
  /** 已序列化的 {@link StepcodeCredential} JSON 字符串（直接存入 `ctx.credentials`）。 */
  access: string
  /**
   * 凭据过期的毫秒时间戳。
   *
   * ⚠️ 恒 `0`（「未知/不过期」哨兵，与 qoder 的「无法解析时为 0」同口径）：
   * 官方给静态凭据的 `expires` 是 `Number.MAX_SAFE_INTEGER`，
   * 而账号池/UI 把 `0` 当「无有效期」显示，比塞一个 28 万年后的时间戳更诚实。
   */
  expires: number
  /** 展示给用户的登录 URL。 */
  loginUrl: string
  /** 恒 `false` —— Step Code **没有**续期端点（见 `stepcode.ts` 模块头）。 */
  refreshable: boolean
  /** 服务端回传的账号标识（可能缺席）。 */
  uid?: string
}

/** {@link startStepcodeLoginFlow} 接受的选项。 */
export interface StepcodeLoginFlowOptions {
  /** 使用的 fetch 实现；默认全局 fetch（单测注入桩用）。 */
  fetcher?: typeof fetch
  /** 打开登录 URL 的方式；默认平台打开器。 */
  openBrowser?: OpenBrowser
  /** 登录等待总超时（毫秒）；默认 {@link STEPCODE_LOGIN_TIMEOUT_MS}（10 分钟）。 */
  timeoutMs?: number
  /** 外部取消信号。 */
  signal?: AbortSignal
  /** 产品配置；默认 {@link STEPCODE}。 */
  product?: StepcodeProduct
  /** `client.version`；默认取产品配置里的 `clientVersion`。 */
  clientVersion?: string
  /** `client.platform`；默认 `<process.platform>-<process.arch>`（官方同款）。 */
  clientPlatform?: string
  /** pollToken 注入点（单测用；默认随机生成）。 */
  pollToken?: string
}

/** 已启动但尚未完成的登录流程（两步式登录用）。 */
export interface StartedStepcodeLoginFlow {
  /** 展示给用户的登录 URL。 */
  loginUrl: string
  /** 用户完成授权（或超时/失败）后落定的结果。 */
  result: Promise<StepcodeLoginFlowResult>
  /** 取消登录（中止轮询）；**幂等**。 */
  close: () => Promise<void>
}

/** 本模块自身抛出的确定性错误前缀（用于与网络错误区分）。 */
const PROTOCOL_ERROR_PREFIX = 'Step 登录协议异常'

// ===== 内部工具 =====

/** 睡眠（可被 signal 中断）。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('登录已取消'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('登录已取消'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 合并外部 signal 与超时 signal（官方 `combineAbortSignals` 的等价实现）。 */
function combinedSignal(
  controller: AbortController,
  external?: AbortSignal,
): AbortSignal {
  return external === undefined
    ? controller.signal
    : AbortSignal.any([controller.signal, external])
}

/** 在超时内运行；超时则 abort 并抛出 `timeoutError()`。 */
async function withTimeout<T>(
  timeoutMs: number,
  timeoutError: () => Error,
  external: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const signal = combinedSignal(controller, external)
  const timer = setTimeout(() => controller.abort(timeoutError()), Math.max(0, timeoutMs))
  try {
    return await run(signal)
  } catch (error) {
    // abort 抛出的是 DOMException；换成语义明确的错误，便于 UI 直接展示。
    if (signal.aborted && !controller.signal.aborted) throw error
    if (controller.signal.aborted) throw timeoutError()
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 校验授权站 base（bundle `parseAuthBaseUrl`）。
 *
 * ⚠️ 三条硬约束都是官方原文：**必须 https**、**必须可解析**、
 * **不得内嵌用户名/密码**。少了它们，一个被篡改的配置就能把
 * pollToken（当作 Bearer 发送）送到明文端点上去。
 */
function parseAuthBase(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Step 授权站地址必须是合法 URL')
  }
  if (url.protocol !== 'https:') {
    throw new Error('Step 授权站地址必须使用 https')
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('Step 授权站地址不得包含用户名或密码')
  }
  return url
}

function protocolError(phase: string, detail: string, cause?: unknown): StepcodeLoginRequestError {
  return new StepcodeLoginRequestError(
    'protocol',
    `${PROTOCOL_ERROR_PREFIX}（${phase}）：${detail}`,
    undefined,
    cause === undefined ? undefined : { cause },
  )
}

function readString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function readNumber(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 读响应体，**硬上限 64 KB**（bundle `readBoundedText`）。
 *
 * 两道闸门都要：先看 `content-length` 提前拒绝（省流量），
 * 再在流式读取时累计字节数（防止服务端谎报长度）。
 */
async function readBoundedText(response: Response, phase: string): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > STEPCODE_MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {})
    throw protocolError(phase, '响应体超过大小上限')
  }
  const body = response.body
  if (body === null || body === undefined) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined || value === null) continue
      total += value.byteLength
      if (total > STEPCODE_MAX_RESPONSE_BYTES) {
        throw protocolError(phase, '响应体超过大小上限')
      }
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 单个登录请求（init / poll 共用；复刻 bundle 的 `request()`）。 */
async function loginRequest(input: {
  phase: 'init' | 'poll'
  url: string
  method: 'GET' | 'POST'
  pollToken: string
  body?: Record<string, unknown>
  signal?: AbortSignal
  fetcher?: typeof fetch
}): Promise<Record<string, unknown>> {
  const pollToken = input.pollToken.trim()
  if (pollToken.length === 0) {
    throw new Error('Step 登录 poll token 不得为空')
  }
  const fetchFn = input.fetcher ?? globalThis.fetch.bind(globalThis)

  return withTimeout(
    STEPCODE_LOGIN_REQUEST_TIMEOUT_MS,
    () => new StepcodeLoginRequestError('transport', `Step 登录 ${input.phase} 请求超时`),
    input.signal,
    async (signal) => {
      let response: Response
      try {
        response = await fetchFn(input.url, {
          method: input.method,
          // ⚠️ `redirect:"error"` 是官方原文：授权站若把 API 请求重定向到登录页，
          // 必须**报错**而不是跟过去（跟过去会拿到一个 HTML 页面，
          // 然后被下面的 JSON 解析判成 protocol 错误，掩盖真正的原因）。
          redirect: 'error',
          credentials: 'omit',
          signal,
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${pollToken}`,
            ...input.body === undefined ? {} : { 'content-type': 'application/json' },
          },
          ...input.body === undefined ? {} : { body: JSON.stringify(input.body) },
        })
      } catch (error) {
        signal.throwIfAborted()
        throw new StepcodeLoginRequestError(
          'transport',
          `Step 登录 ${input.phase} 请求失败：${error instanceof Error ? error.message : String(error)}`,
          undefined,
          { cause: error },
        )
      }

      let text = ''
      try {
        text = await readBoundedText(response, input.phase)
      } catch (error) {
        signal.throwIfAborted()
        // ⚠️ 官方这里的取舍：响应**已经是错误状态**时，读体失败就不再叠加
        // protocol 错误（让下面的 `!response.ok` 分支报出真实状态码）。
        if (response.ok) {
          if (error instanceof StepcodeLoginRequestError) throw error
          throw new StepcodeLoginRequestError(
            'transport', 'Step 登录响应被中断', undefined, { cause: error },
          )
        }
      }

      let parsed: unknown
      try {
        parsed = text.trim().length > 0 ? JSON.parse(text) : undefined
      } catch (error) {
        if (response.ok) throw protocolError(input.phase, '响应不是合法 JSON', error)
      }

      if (!response.ok) {
        throw new StepcodeLoginRequestError(
          'http',
          `Step 登录请求失败（HTTP ${response.status}）${envelopeSuffix(parsed)}`,
          response.status,
        )
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw protocolError(input.phase, '响应不是 JSON 对象')
      }
      const payload = parsed as Record<string, unknown>
      // ⚠️ 信封失败：HTTP 200 也可能是业务错误（见模块头）。
      if (isStepcodeEnvelopeError(payload)) {
        throw new StepcodeLoginRequestError(
          'http',
          `Step 登录被拒绝${envelopeSuffix(payload)}`,
          response.status,
        )
      }
      return payload
    },
  )
}

/** 把信封里的 `desc` 拼成错误后缀（无则空串）。 */
function envelopeSuffix(payload: unknown): string {
  const detail = stepcodeEnvelopeDetail(payload)
  return detail === '' ? '' : `：${detail}`
}

// ===== 协议三步 =====

/**
 * 第 1 步：初始化登录流程。
 *
 * @throws {StepcodeLoginRequestError} 传输/HTTP/协议错误
 */
export async function initStepcodeLogin(input: {
  pollToken: string
  signal?: AbortSignal
  fetcher?: typeof fetch
  product?: StepcodeProduct
  clientVersion?: string
  clientPlatform?: string
}): Promise<StepcodeLoginInit> {
  const product = input.product ?? STEPCODE
  const base = parseAuthBase(product.authBase)
  const payload = await loginRequest({
    phase: 'init',
    url: stepcodeLoginInitUrl(product),
    method: 'POST',
    pollToken: input.pollToken,
    signal: input.signal,
    fetcher: input.fetcher,
    body: {
      profile: product.loginProfile,
      // ⚠️ `origin` 是官方原文要求的字段（服务端据此校验请求来自哪个站点）。
      // 用 `base.origin`（不带路径），不要用完整 authBase。
      origin: base.origin,
      client: {
        name: product.clientName,
        version: input.clientVersion ?? product.clientVersion,
        platform: input.clientPlatform ?? `${process.platform}-${process.arch}`,
      },
    },
  })

  const flowId = readString(payload, 'flow_id')
  if (flowId === undefined || !isValidStepcodeFlowId(flowId)) {
    throw protocolError('init', '响应未包含可用的 flow_id')
  }
  const pollIntervalSec = readNumber(payload, 'poll_interval_sec')
  if (pollIntervalSec === undefined || pollIntervalSec < 1) {
    throw protocolError('init', '响应未包含至少 1 秒的 poll_interval_sec')
  }
  const expiresAt = readNumber(payload, 'expires_at')
  if (expiresAt === undefined || expiresAt <= 0) {
    throw protocolError('init', '响应未包含 expires_at 时间戳')
  }
  return {
    flowId,
    authorizeUrl: stepcodeAuthorizeUrl(flowId, product),
    pollIntervalSec: Math.min(pollIntervalSec, STEPCODE_MAX_POLL_INTERVAL_SEC),
    expiresAt,
  }
}

/** 第 2 步：查询一次授权状态。 */
export async function pollStepcodeLogin(input: {
  flowId: string
  pollToken: string
  signal?: AbortSignal
  fetcher?: typeof fetch
  product?: StepcodeProduct
}): Promise<StepcodeLoginPollResult> {
  const product = input.product ?? STEPCODE
  // ⚠️ 轮询前再校一次：flowId 会被拼进 URL **路径**（不只是 query）。
  if (!isValidStepcodeFlowId(input.flowId)) {
    throw protocolError('poll', 'flow_id 格式异常')
  }
  const payload = await loginRequest({
    phase: 'poll',
    url: stepcodeLoginPollUrl(input.flowId, product),
    method: 'GET',
    pollToken: input.pollToken,
    signal: input.signal,
    fetcher: input.fetcher,
  })

  const state = readString(payload, 'state')
  if (state === 'pending') return { state: 'pending' }
  if (state === 'failed') {
    const reason = readString(payload, 'reason')
    return { state: 'failed', reason: reason === 'denied' ? 'denied' : 'unknown' }
  }
  if (state !== 'ready') throw protocolError('poll', '响应包含未知的 state')

  const credential = payload.credential
  if (typeof credential !== 'object' || credential === null || Array.isArray(credential)) {
    throw protocolError('poll', 'ready 响应未包含 credential 对象')
  }
  const apiKey = readString(credential as Record<string, unknown>, 'api_key')
  if (apiKey === undefined) {
    throw protocolError('poll', 'ready 响应未包含 api_key')
  }
  // ⚠️ `uid` 在**顶层**，不在 credential 里（见 StepcodeCredential.uid 注释）。
  const uid = normalizeStepcodeUid(readString(payload, 'uid'))
  return { state: 'ready', apiKey, ...uid === undefined ? {} : { uid } }
}

/** 第 3 步：轮询直到 ready / failed / 超时。 */
export async function waitForStepcodeLogin(input: {
  init: StepcodeLoginInit
  pollToken: string
  signal?: AbortSignal
  fetcher?: typeof fetch
  product?: StepcodeProduct
}): Promise<Extract<StepcodeLoginPollResult, { state: 'ready' }>> {
  const timeoutError = (): Error => new Error('Step 登录超时：在浏览器中完成授权前流程已过期')
  // ⚠️ `expiresAt` 是**秒**级时间戳（官方 `* 1000`）。
  const remaining = input.init.expiresAt * 1000 - Date.now()
  if (remaining <= 0) throw timeoutError()

  // 官方口径：`min(60s, max(1s, pollIntervalSec * 1000))`。
  const interval = Math.min(
    STEPCODE_MAX_POLL_INTERVAL_SEC * 1000,
    Math.max(STEPCODE_MIN_POLL_INTERVAL_MS, input.init.pollIntervalSec * 1000),
  )

  return withTimeout(remaining, timeoutError, input.signal, async (signal) => {
    for (;;) {
      try {
        const result = await pollStepcodeLogin({
          flowId: input.init.flowId,
          pollToken: input.pollToken,
          signal,
          fetcher: input.fetcher,
          product: input.product,
        })
        signal.throwIfAborted()
        if (result.state === 'ready') return result
        if (result.state === 'failed') {
          // ⚠️ 「用户拒绝」与「其它失败」文案必须分开：前者告诉用户
          // 是他自己点了拒绝（重试即可），后者暗示服务端异常。
          throw new Error(
            result.reason === 'denied'
              ? 'Step 登录已在浏览器中被拒绝'
              : 'Step 登录在浏览器中失败',
          )
        }
      } catch (error) {
        // 取消优先于一切：用户主动关闭时不要把它报成「登录失败」。
        signal.throwIfAborted()
        if (!isRetryableStepcodeLoginError(error)) throw error
        // 可重试错误（408/429/5xx/传输）静默继续轮询 —— 与官方一致。
      }
      await sleep(interval, signal)
    }
  })
}

/** 把 poll 成功结果组装成凭据与流程结果。 */
function toLoginFlowResult(
  ready: Extract<StepcodeLoginPollResult, { state: 'ready' }>,
  loginUrl: string,
  product: StepcodeProduct,
): StepcodeLoginFlowResult {
  const credential: StepcodeCredential = {
    access_token: ready.apiKey,
    profile: product.loginProfile,
    ...ready.uid === undefined ? {} : { uid: ready.uid, nickname: ready.uid },
  }
  // 回读一次自己刚组装的 JSON：确保**存进去的一定能解析出来**
  // （形状写错时在这里就炸，而不是等到用户发消息时才报「无可用凭据」）。
  const serialized = JSON.stringify(credential)
  if (parseStepcodeCredential(serialized) === undefined) {
    throw new Error('Step 登录产物无法通过凭据形状校验')
  }
  return {
    access: serialized,
    expires: 0,
    loginUrl,
    refreshable: false,
    ...ready.uid === undefined ? {} : { uid: ready.uid },
  }
}

/**
 * 启动登录流程并**立即返回**登录 URL（不打开浏览器、不等用户）。
 *
 * ⚠️ 这是 Jet Hub「两步式登录」的硬约束：`window.open` 只在用户手势窗口内
 * 有效，故必须先把 URL 交回前端弹窗，再在后台轮询
 * （AGENTS.md 记过 CodeArts 早期「主页面被跳转」的同型缺陷）。
 *
 * `close()` 通过 abort 取消轮询，**幂等**。
 */
export async function startStepcodeLoginFlow(
  options: StepcodeLoginFlowOptions = {},
): Promise<StartedStepcodeLoginFlow> {
  const product = options.product ?? STEPCODE
  const pollToken = options.pollToken ?? generateStepcodePollToken()
  const controller = new AbortController()
  const signal = combinedSignal(controller, options.signal)

  // ⚠️ init 必须**在这里 await**（拿到 flow_id 才能构造 loginUrl），
  // 但它很快（单个 HTTP 往返，15s 上限），不会破坏「立即返回 URL」的语义。
  const init = await initStepcodeLogin({
    pollToken,
    signal,
    fetcher: options.fetcher,
    product,
    clientVersion: options.clientVersion,
    clientPlatform: options.clientPlatform,
  })
  const loginUrl = init.authorizeUrl

  const result = (async (): Promise<StepcodeLoginFlowResult> => {
    const timeoutMs = options.timeoutMs ?? STEPCODE_LOGIN_TIMEOUT_MS
    // 整体超时取「本地配置」与「服务端 expires_at」的**较小值**：
    // 服务端说流程 5 分钟后作废时，本地等 10 分钟没有意义。
    const serverRemaining = init.expiresAt * 1000 - Date.now()
    const effectiveTimeout = Math.min(timeoutMs, Math.max(0, serverRemaining))
    return withTimeout(
      effectiveTimeout,
      () => new Error('Step 登录超时。请重新点击「+ 新建账号」。'),
      signal,
      async (innerSignal) => {
        const ready = await waitForStepcodeLogin({
          init,
          pollToken,
          signal: innerSignal,
          fetcher: options.fetcher,
          product,
        })
        return toLoginFlowResult(ready, loginUrl, product)
      },
    )
  })()
  // 这个 Promise 是手工创建的、要过一会儿才交给调用方消费，期间可能已被
  // reject（如用户立刻关闭面板）。先挂空处理器避免 Node 报「未处理的拒绝」。
  result.catch(() => {})

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    controller.abort()
  }

  return { loginUrl, result, close }
}

/** 平台默认打开器（延迟 import，避免在 headless 环境加载）。 */
async function defaultOpenBrowser(url: string): Promise<void> {
  const { openBrowser } = await import('./login.js')
  openBrowser(url)
}

/**
 * 运行完整登录流程：拿 URL → 打开浏览器 → 轮询 → 返回凭据。
 *
 * 阻塞语义：等用户完成授权后才返回。需要「立即拿到 URL」的场景
 * （Jet Hub 两步式登录）请用 {@link startStepcodeLoginFlow}。
 */
export async function runStepcodeLoginFlow(
  options: StepcodeLoginFlowOptions = {},
): Promise<StepcodeLoginFlowResult> {
  const open = options.openBrowser ?? defaultOpenBrowser
  const started = await startStepcodeLoginFlow(options)
  try {
    await open(started.loginUrl)
    return await started.result
  } finally {
    await started.close()
  }
}

/** 授权站 base（去掉结尾斜杠；给「打开登录页」这类只需要站点根的场景用）。 */
export function stepcodeAuthSiteUrl(product: StepcodeProduct = STEPCODE): string {
  return trimTrailingSlash(product.authBase)
}
