/**
 * TeleAgent 认证服务（`ctx.teleagentAuth`）。
 *
 * ## 与其它 auth 服务的两处关键差异
 *
 * 1. **登录产物靠用户粘贴获取**（不是本地监听、也不是设备码轮询）。
 *    官方桌面端靠**自带 BrowserWindow 监听导航**抓 token
 *    （asar `eOe()`：命中 `/cowork/auth?code=…` 即取 `token`）；
 *    DSH 插件没有那个窗口，且 TeleAgent 的回调地址**不可配置**
 *    （`LOGIN_PAGE` 是服务端常量，没有 `redirect_uri` 参数），
 *    所以只能走「打开登录页 → 用户取回授权产物 → 面板粘贴」。
 *    ⚠️ 但**用户要取的不是地址栏那一串**（2026-10-07 实测，本注释此前写错）：
 *    授权完成后地址栏只有 `code`，token 装在唤起桌面端的
 *    `teleai-cowork://auth?token=…` deeplink 里、被拦截导航取走。
 *    权威判据见 `teleagent.ts` 的 `parseTeleagentCallbackInput`，
 *    面板文案必须与它一致（不一致会让用户反复粘贴失败）。
 *    这与 Antigravity 面板的「loopback 绑不上时降级为人工粘码」是同一处置思路。
 * 2. **没有续期端点** ⇒ `refresh()` 退化为「探测有效性」（Loomy 同型），
 *    凭据失效只能重新登录。UI 必须如实显示「需重新登录」而不是假装能刷。
 *
 * ## deviceId 是**设备级**、不是账号级
 *
 * asar 明示 deviceId 与 installId 一起持久化于**设备级**状态文件，
 * 故本服务把它存在独立的 `TELEAGENT_DEVICE_ID` ref 上、全设备共用一份，
 * 而不是每个账号各造一个 —— 后者会让服务端看到「同一台机器突然冒出 N 台设备」。
 */

import { randomBytes } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { AccountPool } from './account-pool.js'
import { launchAndCaptureToken } from './teleagent-cdp-login.js'
import { syncAccountExpiry, type ExpiryAccessors } from './expiry-sync.js'
import {
  TELEAGENT,
  TELEAGENT_LOGIN_TIMEOUT_MS,
  TELEAGENT_REQUEST_TIMEOUT_MS,
  TELEAGENT_USER_INFO_PATH,
  type TeleagentProduct,
} from './teleagent-product.js'
import {
  generateTeleagentDeviceId,
  isTeleagentRefreshable,
  parseTeleagentCallbackInput,
  parseTeleagentCredential,
  teleagentCredentialExpiresAtMs,
  teleagentFallbackEntries,
  teleagentHeaders,
  type TeleagentCredential,
  type TeleagentModelEntry,
} from './teleagent.js'

/** 设备级 deviceId 的存放 ref（与账号凭据分开）。 */
export const TELEAGENT_DEVICE_ID_REF = 'TELEAGENT_DEVICE_ID'

/**
 * 设备级**签名密钥**的存放 ref。
 *
 * ⚠️ 与 deviceId 同策略（设备级、全账号共用）：客户端 `ensureSession()` 每进程
 * 新建一个随机 `sessionKey`，而服务端**不校验其内容**（它没有可比密钥，
 * 只能校验「头存在 + 版本合法 + 时间戳新鲜」），故我们生成一次并复用即可。
 */
export const TELEAGENT_SIGN_KEY_REF = 'TELEAGENT_SIGN_KEY'

/**
 * TeleAgent 凭据 → 账号池有效期的提取器。
 *
 * ⚠️ **刻意不提供 `refreshableOf`**（与 `LOOMY_EXPIRY_ACCESSORS` 同型）：
 * `isTeleagentRefreshable` 恒为 `false`（服务端没有任何 refresh 端点，
 * 这是「诚实标记」而非凭据状态），若让共享实现据此回写 `refreshable`，
 * 会把账号池改成与该产品实际行为不符的状态。这里只需要同步 `expiresAt`。
 *
 * ⚠️ `expiresAtOf` 对真实凭据**能取到值**（2026-10-07 实测修正：token **是**
 * 标准 JWT，payload 带 `exp`，约 30 天）—— 本注释此前写「恒返回 undefined、
 * token 不是 JWT」，那是**没去解它**造成的误判。取不到时 `syncAccountExpiry`
 * **不覆盖**池内旧值（保留旧信息比抹掉它更有价值）。
 * 另注意：有效期只作**展示**用，本 provider 无续期端点，过期只能重新登录。
 */
export const TELEAGENT_EXPIRY_ACCESSORS: ExpiryAccessors<TeleagentCredential> = {
  expiresAtOf: (credential) => teleagentCredentialExpiresAtMs(credential),
  identityOf: (credential) => credential.token ?? '',
}

/**
 * 续期被判定为终态（token 失效，需重新登录）时抛出的错误。
 *
 * ⚠️ `name` **必须**是 `'RefreshTokenExpiredError'` —— `src/refresh.ts:23` 的
 * 终态判据是 `error.name === 'RefreshTokenExpiredError'`（字符串比较，跨模块有效）。
 * 写成 `TeleagentRefreshTokenExpiredError` 会让该分支恒不命中，
 * 只能靠文案正则兜底 —— 文案一改即静默退化（AGENTS.md 记过的真实缺陷）。
 */
export class TeleagentRefreshTokenExpiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RefreshTokenExpiredError'
  }
}

/** 一次登录提交的结果。 */
export interface TeleagentLoginResult {
  /** 已持久化的凭据 JSON。 */
  access: string
  /**
   * 过期毫秒时间戳；**恒 0** —— 本字段承载的是「登录响应下发的剩余秒数」
   * 那一族语义，而 TeleAgent 的登录响应里**没有**这个数字。
   *
   * ⚠️ 但**别据此以为「有效期未知」**：有效期在凭据的 JWT `exp` 里（实测约 30 天），
   * 由 `teleagentCredentialExpiresAtMs` 解出，回填池条目用的是那个值。
   */
  expires: number
  /** 登录页 URL（回填给调用方，与 `account.create` 返回的一致）。 */
  loginUrl: string
  /** 恒 false（无 refresh 端点）。 */
  refreshable: boolean
  /** 服务端账号标识（user_info 下发，用于多账号去重）。 */
  accountId?: string
  /** 展示名。 */
  nickname?: string
}

/** `TeleagentAuth` 的构造选项。 */
export interface TeleagentAuthOptions {
  /** 产品配置；默认 {@link TELEAGENT}。 */
  product?: TeleagentProduct
  /** 服务名覆盖（默认由产品 id 派生为 `teleagentAuth`）。 */
  serviceName?: string
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
}

/** 登录流程句柄（与其余 provider 的 `startLogin` 形状对齐）。 */
export interface StartedTeleagentLoginFlow {
  loginUrl: string
  /**
   * 等待用户提交回调内容。
   *
   * ⚠️ 与设备码轮询不同：这个 Promise **不自己发请求**，
   * 由 `submitLogin()`（RPC 的粘贴入口）落定 —— 所以 `close()` 必须能
   * 把它 reject 掉，否则调用方 `await` 会永久挂起。
   */
  result: Promise<TeleagentLoginResult>
  close: () => void
}

/** user_info 解出的账号信息。 */
export interface TeleagentUserInfo {
  accountId: string
  accountName: string
  phone: string
  avatar: string
}

/** 读非空字符串。 */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * 解析 `user_info` 响应。
 *
 * 客户端信封约定（renderer `bM()`）：`code === 0 || code === 200 || success === true`
 * 时取 `data`，否则视为业务错误。字段名取 asar `fetchUser` 实际读的四个：
 * `accountId` / `accountName` / `avatar` / `phone`。
 *
 * ⚠️ 拿不到 `accountId` ⇒ 返回 undefined（**不编造**）—— 它是多账号去重的
 * 唯一稳定判据（与 zcode 那条「判据必须是服务端下发的稳定标识」的教训同因）。
 */
export function parseTeleagentUserInfo(payload: unknown): TeleagentUserInfo | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const record = payload as Record<string, unknown>
  // 兼容两种形态：已剥信封（直接是字段）与未剥（套在 data 下）。
  const data = typeof record.data === 'object' && record.data !== null && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : record
  const accountId = nonEmptyString(data.accountId) ?? nonEmptyString(data.account_id) ?? nonEmptyString(data.uid)
  if (accountId === undefined) return undefined
  return {
    accountId,
    accountName: nonEmptyString(data.accountName) ?? nonEmptyString(data.account_name) ?? '',
    phone: nonEmptyString(data.phone) ?? nonEmptyString(data.mobile) ?? '',
    avatar: nonEmptyString(data.avatar) ?? '',
  }
}

/**
 * 构造展示昵称（多账号可区分）。
 *
 * 优先手机号尾号（与 TRAE / Loomy 同思路：服务端默认名往往是自动生成的、
 * 无法区分），退 `accountName`，再退 accountId 尾 6 位。
 */
export function teleagentDisplayNickname(info: {
  phone?: string
  accountName?: string
  accountId: string
}): string {
  const phone = nonEmptyString(info.phone)
  if (phone !== undefined && phone.length >= 4) return `TeleAgent ${phone.slice(-4)}`
  const name = nonEmptyString(info.accountName)
  if (name !== undefined) return `TeleAgent ${name}`
  return `TeleAgent ${info.accountId.slice(-6)}`
}

/** TeleAgent 认证服务。 */
export class TeleagentAuth extends Service {
  /** 本实例所属的产品配置。 */
  readonly product: TeleagentProduct
  /** 本实例默认读写的凭据 ref 名称。 */
  readonly credentialRefName: string

  /**
   * 进行中的登录流程（accountId → 落定器）。
   *
   * ⚠️ 为什么需要它：`account.create` 与「粘贴提交」是**两次独立 RPC**，
   * 中间靠 `login.poll` 观察凭据是否写入。这里挂的是「提交入口 → 结果」的桥，
   * 让 `startLogin().result` 能被 `submitLogin()` 落定，
   * 形状与其余 provider 的 `startLogin()` 保持一致（调用方无需为 teleagent 特判）。
   */
  private readonly pendingLogins = new Map<string, {
    resolve: (r: TeleagentLoginResult) => void
    reject: (e: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()

  constructor(ctx: Context, private readonly options: TeleagentAuthOptions = {}) {
    const product = options.product ?? TELEAGENT
    super(ctx, options.serviceName ?? `${product.id}Auth`)
    this.product = product
    this.credentialRefName = product.defaultCredentialRef
  }

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch
  }

  /** 登录页 URL（用户在浏览器里打开它完成天翼账号授权）。 */
  loginPageUrl(): string {
    return this.product.loginPage
  }

  /**
   * 发起登录：立即返回 loginUrl，后台等用户粘贴。
   *
   * ⚠️ **两步式**是硬要求：前端 `window.open` 只在用户手势窗口内有效
   * （AGENTS.md 记过「主页面被跳转」的缺陷就是等完才返回 URL 导致的）。
   *
   * @param accountId 本次登录的账号 id（占位条目 id，`submitLogin` 用它配对）
   */
  async startLogin(accountId: string): Promise<StartedTeleagentLoginFlow> {
    const loginUrl = this.loginPageUrl()
    let settle: { resolve: (r: TeleagentLoginResult) => void; reject: (e: Error) => void } | undefined
    const result = new Promise<TeleagentLoginResult>((resolve, reject) => {
      settle = { resolve, reject }
    })
    // 与 `minimax-auth.ts` 同理：结果可能早于调用方 await 而落定，
    // 先挂空处理器避免「未处理的拒绝」告警（错误仍会传给真正的消费者）。
    result.catch(() => {})
    const timer = setTimeout(() => {
      this.pendingLogins.delete(accountId)
      settle?.reject(new Error('TeleAgent 登录超时（未在有效期内提交回调地址）'))
    }, TELEAGENT_LOGIN_TIMEOUT_MS)
    // 兜底超时不该独占事件循环（与 src/refresh.ts 的 `timer.unref?.()` 同款）。
    timer.unref?.()
    this.pendingLogins.set(accountId, { ...settle!, timer })
    return {
      loginUrl,
      result,
      close: () => {
        const pending = this.pendingLogins.get(accountId)
        if (pending === undefined) return
        clearTimeout(pending.timer)
        this.pendingLogins.delete(accountId)
        pending.reject(new Error('用户取消了 TeleAgent 登录'))
      },
    }
  }

  /**
   * 设备级 deviceId（读缓存，无则生成并落盘）。
   *
   * ⚠️ 失败时返回 `undefined` 而**不抛错**：deviceId 是身份头、不是登录必需项，
   * 不该因为「存不下这个值」而让一次本来能成功的登录失败。
   *
   * ⚠️ **格式是 12 位 hex**（实测客户端 `device-meta.json` 的
   * `deviceId: "e88088715b6f"`），不是 32 位 —— 见 `generateTeleagentDeviceId`。
   */
  private async ensureDeviceId(): Promise<string | undefined> {
    return this.ensureDeviceScopedValue(
      TELEAGENT_DEVICE_ID_REF,
      () => generateTeleagentDeviceId(),
      '设备标识',
    )
  }

  /**
   * 设备级**签名密钥**（读缓存，无则生成并落盘）。
   *
   * ⚠️ 为什么可以自己生成：客户端 `ensureSession()` 的 sessionKey 就是
   * `randomBytes(32).toString('base64url')`，**每次进程启动新建、不经服务端注册**
   * ⇒ 服务端无法校验其内容（没有可比密钥），只能校验「头存在 + 版本合法 +
   * 时间戳新鲜」。故我们生成一次并复用。
   * ⚠️ 但**这是待端到端确认的假设**（见 `scripts/probe-teleagent-infer-sign.mjs`）。
   */
  private async ensureSignKey(): Promise<string | undefined> {
    return this.ensureDeviceScopedValue(
      TELEAGENT_SIGN_KEY_REF,
      () => randomBytes(32).toString('base64url'),
      '签名密钥',
    )
  }

  /**
   * 设备级值的「读缓存 → 生成 → 落盘」通用实现（deviceId / signKey 共用）。
   *
   * ⚠️ 失败一律返回 `undefined` 而**不抛错**：这两个值都是**可选**的请求头，
   * 不该因为「存不下」而让一次本来能成功的登录失败。
   */
  private async ensureDeviceScopedValue(
    refName: string,
    generate: () => string,
    label: string,
  ): Promise<string | undefined> {
    const ref = credentialRef(refName)
    try {
      const resolved = await this.ctx.credentials.resolve(ref)
      const cached = resolved === null || resolved === undefined
        ? undefined
        : nonEmptyString(resolved.value)
      if (cached !== undefined) return cached
      const generated = generate()
      await this.ctx.credentials.set(ref, generated)
      return generated
    } catch (error) {
      this.ctx.logger?.warn?.(
        `[teleagent] ${label}读写失败（不影响登录，仅少发一个请求头）：`
        + `${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
  }

  /**
   * 用户粘贴回调 URL / token → 校验 → 落盘凭据。
   *
   * @param input   粘贴内容（回调 URL、deeplink URL 或裸 token）
   * @param options.refName 凭据 ref（账号池条目自己的 ref）
   * @param options.accountId 账号 id（有则同时落定 `startLogin().result`）
   * @param options.pool    账号池（回填昵称/有效期用）
   */
  async submitLogin(
    input: string,
    options: { refName?: string; accountId?: string; pool?: AccountPool } = {},
  ): Promise<TeleagentLoginResult> {
    const parsed = parseTeleagentCallbackInput(input)
    if ('reason' in parsed) {
      throw new Error(`TeleAgent 登录提交无效：${parsed.reason}`)
    }

    /**
     * ⚠️ **必须在任何 `await` 之前**认领这次登录：拆掉 `startLogin()` 的超时炸弹，
     * 但**保留**落定器（`result` 之后仍会被 resolve，上游 `.then()` 才有意义）。
     *
     * 为什么这是缺陷而不是保险：`submitLogin` 要跑 `ensureDeviceId` + `ensureSignKey`
     * （磁盘）与 `fetchUserInfo`（网络）。若 `TELEAGENT_LOGIN_TIMEOUT_MS` 在这条链
     * 中途引爆，`result` 会 reject，`account.create` 挂的 `.catch()` 随即
     * `removeAccount(id)` —— 而 `removeAccount` **连带 `credentials.unset`**
     * （见 account-pool.ts 的 removeAccount）。两种结果都坏：
     * ① 凭据先写后被 unset ⇒ 登录白做，可 RPC 已回 `done:true`；
     * ② 凭据在条目删完后才落盘 ⇒ 密钥库里留下一条**永久孤儿凭据**。
     * 用户既然已经提交，超时就不该再介入。
     */
    const claimed = options.accountId === undefined
      ? undefined
      : this.pendingLogins.get(options.accountId)
    if (claimed !== undefined) clearTimeout(claimed.timer)

    const deviceId = await this.ensureDeviceId()
    const signKey = await this.ensureSignKey()
    const credential: TeleagentCredential = {
      token: parsed.token,
      ...deviceId === undefined ? {} : { device_id: deviceId },
      ...signKey === undefined ? {} : { sign_key: signKey },
    }

    // 先验证 token 真能用（user_info），再落盘 ——
    // ⚠️ 顺序很重要：把无效 token 写进凭据会让账号显示「已登录」，
    // 而用户要到第一次发消息时才看到 AUTH 错误，排查成本极高。
    const info = await this.fetchUserInfo(credential)
    if (info === undefined) {
      throw new Error('TeleAgent 凭据校验失败（user_info 未返回账号信息）：token 可能已失效或粘贴不完整')
    }
    const verified: TeleagentCredential = {
      ...credential,
      account_id: info.accountId,
      nickname: teleagentDisplayNickname(info),
    }

    const refName = options.refName ?? this.credentialRefName
    await this.ctx.credentials.set(credentialRef(refName), JSON.stringify(verified))
    const expiresAt = teleagentCredentialExpiresAtMs(verified)
    const result: TeleagentLoginResult = {
      access: JSON.stringify(verified),
      // ⚠️ 恒 0：本字段是「服务端下发的剩余秒数」那一族的形状对齐，
      // 而 TeleAgent **不在登录响应里**给过期时间。这**不等于**「有效期未知」——
      // 有效期要从凭据里的 JWT `exp` 解（见 `teleagentCredentialExpiresAtMs`，
      // 实测约 30 天），故下面回填池条目用的是 `expiresAt` 而不是这个 0。
      expires: 0,
      loginUrl: this.loginPageUrl(),
      refreshable: isTeleagentRefreshable(verified),
      accountId: info.accountId,
      nickname: verified.nickname,
    }

    /**
     * 回填账号池的展示字段。
     *
     * ⚠️ **必须在这里做，不能只挂在 `startLogin().result.then()` 上**：
     * 粘贴框现在会从「条目在、凭据不在」的账号自动恢复（动机见
     * `teleagent-login-restore.js`），而那条路径上 DSH 往往已经重启过、
     * `pendingLogins` 是空的 ⇒ `result` **永不落定**、`.then()` 永不执行
     * ⇒ 昵称永远停在账号 id、有效期永远显示「未知」，**尽管凭据有效、
     * 能正常推理**。用户看到的就是一条"登录没成功"的假象。
     *
     * ⚠️ 回填失败**不报错**：`updateAccount` 在条目不存在时抛
     * `Account ... not found`（见 account-pool.ts），而条目被删（用户取消 /
     * 超时竞态残余窗口）不该让一次**已成功**的登录变成失败。
     */
    if (options.pool !== undefined && options.accountId !== undefined) {
      await options.pool
        .updateAccount(options.accountId, {
          nickname: verified.nickname ?? options.accountId,
          expiresAt,
          refreshable: result.refreshable,
        })
        .catch(() => {})
    }

    // 落定 `startLogin()` 的结果（若该账号有挂起的流程）。
    if (options.accountId !== undefined) {
      const pending = this.pendingLogins.get(options.accountId)
      if (pending !== undefined) {
        clearTimeout(pending.timer)
        this.pendingLogins.delete(options.accountId)
        pending.resolve(result)
      }
    }
    return result
  }

  /**
   * **浏览器自动登录**：起受控浏览器让用户登录，从网络层取 token 后
   * 走**同一个** `submitLogin` 落盘。
   *
   * ## 为什么这样接
   *
   * `submitLogin` 已经承载了「验证 user_info → 落盘 → 回填昵称/有效期 →
   * 拆超时定时器」整条链（2026-10-08 刚修过）。自动登录**不该另写一份** ——
   * 否则两条路径的凭据形状会漂移，那是最贵的一类缺陷。
   * 所以这里只负责「把 token 弄到手」，拿到就交回去。
   *
   * ⚠️ 判据交给服务端而不是形态猜测：`verify` 逐个真打 `user_info`。
   * 探针实测登录链路会经过**两个** JWT（UPMS 的 refreshToken 与
   * superCowork 的 token），按「第一个」选会选错 ——
   * 见 `teleagent-cdp-login.ts` 模块头的对照表。
   *
   * ⚠️ 失败时调用方**不要**删占位条目：用户多半只是关了窗口或超时，
   * 粘贴那条路仍然走得通（面板会自己恢复入口）。
   */
  async loginWithBrowser(options: {
    refName: string
    accountId: string
    pool?: AccountPool
    onProgress?: (message: string) => void
    timeoutMs?: number
  }): Promise<TeleagentLoginResult> {
    const outcome = await launchAndCaptureToken({
      loginUrl: this.loginPageUrl(),
      timeoutMs: options.timeoutMs,
      onProgress: options.onProgress,
      verify: async (candidate) => {
        // 业务端点只需 `X-Token`（无需签名，见 teleagent.ts 模块头第 1 点），
        // 故只带 token 就足以判定「服务端认不认它」。
        const info = await this.fetchUserInfo({ token: candidate } as TeleagentCredential)
        return info !== undefined
      },
    })
    options.onProgress?.(`token 取自 ${outcome.source}，正在落盘…`)
    return this.submitLogin(outcome.token, {
      refName: options.refName,
      accountId: options.accountId,
      pool: options.pool,
    })
  }

  /** 调 `user_info` 取账号信息；失败返回 undefined（不抛错）。 */
  async fetchUserInfo(
    credential: TeleagentCredential,
  ): Promise<TeleagentUserInfo | undefined> {
    try {
      const response = await this.fetchImpl(
        `${this.product.apiBase}${TELEAGENT_USER_INFO_PATH}`,
        {
          method: 'GET',
          headers: teleagentHeaders(credential, this.product),
          signal: AbortSignal.timeout(TELEAGENT_REQUEST_TIMEOUT_MS),
        },
      )
      if (!response.ok) return undefined
      return parseTeleagentUserInfo(await response.json().catch(() => undefined))
    } catch (error) {
      this.ctx.logger?.warn?.(
        `[teleagent] user_info 请求失败：${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
  }

  /** 解析默认单凭据。 */
  private async resolveDefaultCredential(): Promise<TeleagentCredential | undefined> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName))
    if (!resolved) return undefined
    return parseTeleagentCredential(resolved.value)
  }

  /**
   * 「续期」= 探测有效性（TeleAgent **没有** refresh 端点）。
   *
   * ⚠️ 与 Loomy 同型：能拿到 user_info 就什么都不做；拿不到就抛
   * `RefreshTokenExpiredError`（name 必须精确，见类注释），让调度器**停下来**
   * 而不是无限重试一个不可能成功的操作。
   */
  async refresh(): Promise<void> {
    const credential = await this.resolveDefaultCredential()
    if (credential === undefined) {
      throw new TeleagentRefreshTokenExpiredError('凭据未配置，请先登录')
    }
    const info = await this.fetchUserInfo(credential)
    if (info === undefined) {
      throw new TeleagentRefreshTokenExpiredError('TeleAgent token 已失效，请重新登录')
    }
    // 探测成功：顺手回填昵称（老凭据可能没有 account_id / nickname）。
    if (credential.account_id !== info.accountId) {
      await this.ctx.credentials.set(
        credentialRef(this.credentialRefName),
        JSON.stringify({
          ...credential,
          account_id: info.accountId,
          nickname: teleagentDisplayNickname(info),
        }),
      )
    }
  }

  /**
   * 按凭据 ref 探测指定账号（账号卡片「刷新」按钮）。
   *
   * ⚠️ 必须走 `refreshAccountWithReconcile` 的**对账语义**吗？—— 不需要：
   * 本 provider 无续期，`expiresAt` 恒未知，对账没有可写回的值。
   * 故这里只做「探测 + 失败标不可续期」，与 Loomy 的处理一致。
   */
  async refreshAccountCredential(
    refName: string,
    pool?: AccountPool,
    accountId?: string,
  ): Promise<void> {
    const ref = credentialRef(refName)
    const resolved = await this.ctx.credentials.resolve(ref)
    if (!resolved) throw new TeleagentRefreshTokenExpiredError('凭据未配置')
    const credential = parseTeleagentCredential(resolved.value)
    if (credential === undefined) throw new Error('凭据解析失败')
    const info = await this.fetchUserInfo(credential)
    if (info === undefined) {
      if (pool !== undefined && accountId !== undefined) {
        await pool.updateAccount(accountId, { refreshable: false }).catch(() => {})
      }
      throw new TeleagentRefreshTokenExpiredError('TeleAgent token 已失效，请重新登录')
    }
    // 有效：回填昵称（只在确实变化时写，避免每次启动都落盘一次）。
    const nickname = teleagentDisplayNickname(info)
    if (credential.account_id !== info.accountId || credential.nickname !== nickname) {
      await this.ctx.credentials.set(
        ref,
        JSON.stringify({ ...credential, account_id: info.accountId, nickname }),
      )
      // ⚠️ 昵称也走池：`updateAccount` 是整体 replace，只在**确实变化**时写
      //（与 Loomy / Raccoon 的处理同因，避免每次探测都平白落盘一次）。
      if (pool !== undefined && accountId !== undefined) {
        await pool.updateAccount(accountId, { nickname }).catch(() => {})
      }
    }
    // ⚠️ **有效期对账必须走共享实现 `syncAccountExpiry`**（AGENTS.md 的契约，
    // 由 `refresh-bootstrap-wiring.spec.ts` 强制），**不要**手写 `updateAccount`。
    // 该缺陷的历史形态正是「raccoon 接好了、其余七个各漏一环」——
    // 于是账号卡片「刷新」按下去凭据续好了、UI 纹丝不动。
    // 传**探测前**的 credential 即可：`expiresAtOf` 读的是 `expires_at`，
    // 而本 provider 的该字段不随探测变化。
    await syncAccountExpiry({
      pool,
      provider: this.product.id,
      credential,
      accessors: TELEAGENT_EXPIRY_ACCESSORS,
      accountId,
      tag: `[${this.product.id}]`,
      warn: (message) => this.ctx.logger?.warn?.(message),
    })
  }

  /**
   * 批量探测账号池。
   *
   * ⚠️ **只按 `refreshable` 过滤，不看 `enabled`**（AGENTS.md 的既定红线）。
   * 本 provider 的 `refreshable` 恒 false ⇒ 循环体**不会执行任何请求**，
   * 这正是我们要的：不给一个不可能续期的 provider 每 30 分钟发一轮探测。
   * 保留方法本身是为了让 `refreshTargets` 的分派形状统一。
   */
  async refreshAll(pool: AccountPool): Promise<void> {
    const accounts = await pool.listAccounts(this.product.id)
    for (const entry of accounts) {
      if (!entry.refreshable) continue
      try {
        await this.refreshAccountCredential(entry.credentialRef, pool, entry.id)
      } catch (error) {
        this.ctx.logger?.warn?.(
          `[teleagent] 账号 ${entry.id} 探测失败：`
          + `${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  /**
   * 模型目录。
   *
   * ⚠️ **当前直接返回兜底表，不发网络请求** —— 这是**取证缺口**，不是遗漏：
   * TeleAgent 的模型列表由服务端下发后缓存进**账号级** `model-catalog`
   * （asar 注释：「模型选择下发配置（服务端目录清单）：账号级缓存」），
   * 由 Go 引擎（opencode 分支）在 spawn 时消费；
   * 我在 2.5.3 的 main / renderer / server-mix / Go 二进制里都**没有定位到**
   * 拉取它的 HTTP 路径（`/api/v1/general/config/{key}` 的 key 未解出）。
   * ⇒ **不凭猜测发一个可能 404 的请求**（AGENTS.md 反复强调的红线）。
   * 拿到真实目录端点后，只需在这里补一次远端拉取 + `normalizeTeleagentModel`
   * 归一即可，兜底表继续作为失败回退。
   */
  async fetchModels(): Promise<readonly TeleagentModelEntry[]> {
    return teleagentFallbackEntries(this.product)
  }
}
