/**
 * Step Code 认证服务（`ctx.stepcodeAuth`）。
 *
 * ## 与其余 auth 服务的三处差异
 *
 * 1. **登录是「浏览器授权 + 本地轮询」**，全自动 —— 既不需要本地监听端口
 *    （qoder / minimax 的设备码同型），也不需要用户粘贴回调 URL（teleagent 那条）。
 *    详见 `stepcode-oauth.ts` 模块头的完整流程图。
 * 2. **凭据是静态 api_key，没有续期端点** ⇒ `refresh()` 退化为「探测有效性」
 *    （Loomy / TeleAgent 同型）。官方 `refreshStepOAuth()` 不发任何请求，
 *    只校验一个哨兵字符串后原样返回（见 `stepcode.ts` 模块头的逐字摘录）。
 * 3. **有效性探测用 `GET /v1/models`** —— 这**不是**我挑的端点，而是官方行为：
 *    发行包内 `docs/step-integration.md` 原文
 *    *"…`step login status` validates the credential against that profile's
 *    `/v1/models` and reports `Step Plan` or `Step Plan Oversea`"*。
 *    ⇒ 与官方 CLI 的 `step login status` 判据完全一致。
 *
 * ## 模型目录是**账号级**的
 *
 * 官方文档明示「可用模型和额度取决于账户权限」（`step-code/configuration/models`），
 * 且 bundle 里 `fetchStepModels()` 是**带 Bearer 实拉**的（`STEP_MODELS = []`，
 * 没有本地种子表）。⇒ `fetchModels(pool)` 必须用**账号池当前可用账号**的凭据拉取，
 * 而不是随便挑一个 —— 不同订阅等级（Mini / Plus / Pro / Max）看到的目录不同。
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { AccountPool } from './account-pool.js'
import { syncAccountExpiry, type ExpiryAccessors } from './expiry-sync.js'
import {
  STEPCODE,
  STEPCODE_REQUEST_TIMEOUT_MS,
  stepcodeModelsUrl,
  type StepcodeProduct,
} from './stepcode-product.js'
import {
  isStepcodeRefreshable,
  parseStepcodeCredential,
  parseStepcodeModelsPayload,
  stepcodeAuthHeaders,
  stepcodeBearerToken,
  stepcodeCredentialExpiresAtMs,
  stepcodeFallbackEntries,
  type StepcodeCredential,
  type StepcodeModelEntry,
} from './stepcode.js'
import {
  startStepcodeLoginFlow,
  type StartedStepcodeLoginFlow,
  type StepcodeLoginFlowOptions,
  type StepcodeLoginFlowResult,
} from './stepcode-oauth.js'

/**
 * Step Code 凭据 → 账号池有效期的提取器。
 *
 * ⚠️ **刻意不提供 `refreshableOf`**（与 `TELEAGENT_EXPIRY_ACCESSORS` /
 * `LOOMY_EXPIRY_ACCESSORS` 同型）：`isStepcodeRefreshable` 恒 `false`
 * 是「诚实标记该产品没有续期端点」，不是凭据状态；让共享实现据此回写
 * `refreshable` 会把账号池改成与实际行为不符的状态。
 *
 * ⚠️ `expiresAtOf` 对正常凭据**恒返回 `undefined`**（静态凭据不写
 * `expires_at`）⇒ `syncAccountExpiry` **不覆盖**池内旧值，UI 显示「无有效期」。
 * 这正是想要的：官方给这类凭据的 `expires` 是 `Number.MAX_SAFE_INTEGER`，
 * 往池里塞一个 28 万年后的时间戳只会让卡片显示一串噪音。
 */
export const STEPCODE_EXPIRY_ACCESSORS: ExpiryAccessors<StepcodeCredential> = {
  expiresAtOf: (credential) => stepcodeCredentialExpiresAtMs(credential),
  identityOf: (credential) => credential.access_token ?? '',
}

/**
 * 凭据被判定为终态失效（需重新登录）时抛出的错误。
 *
 * ⚠️ `name` **必须**是 `'RefreshTokenExpiredError'` —— `src/refresh.ts` 的终态
 * 判据是 `error.name === 'RefreshTokenExpiredError'`（字符串比较，跨模块有效）。
 * 写成 `StepcodeRefreshTokenExpiredError` 会让该分支恒不命中，只能靠文案正则
 * 兜底 —— 文案一改即静默退化（AGENTS.md 在 teleagent 上记过的真实缺陷）。
 */
export class StepcodeRefreshTokenExpiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RefreshTokenExpiredError'
  }
}

/** {@link StepcodeAuth} 的构造选项。 */
export interface StepcodeAuthOptions {
  /** 服务名；默认按 `product.id` 派生为 `stepcodeAuth`。 */
  serviceName?: string
  /** 产品配置；默认 {@link STEPCODE}。 */
  product?: StepcodeProduct
  /** fetch 实现注入（单测用）。 */
  fetcher?: typeof fetch
}

/** Step Code 认证服务。 */
export class StepcodeAuth extends Service {
  readonly product: StepcodeProduct
  readonly credentialRefName: string
  private readonly fetcher: typeof fetch | undefined

  constructor(ctx: Context, private readonly options: StepcodeAuthOptions = {}) {
    const product = options.product ?? STEPCODE
    // 服务名由 product.id 派生（`stepcodeAuth`），与其余 auth 服务同规则。
    super(ctx, options.serviceName ?? `${product.id}Auth`)
    this.product = product
    this.credentialRefName = product.defaultCredentialRef
    this.fetcher = options.fetcher
  }

  /**
   * 启动登录并**立即返回** loginUrl（Jet Hub 两步式登录）。
   *
   * ⚠️ 返回的 `result` 是**尚未落定**的 Promise：调用方（`account.create` 分支）
   * 必须先把 `loginUrl` 交回前端弹窗，再 `.then/.catch` 它回填凭据。
   * 绝不可 `await result` 后才返回 URL —— `window.open` 只在用户手势窗口内有效
   * （AGENTS.md 记过 CodeArts 早期「主页面被跳转」的同型缺陷）。
   */
  async startLogin(
    _accountId?: string,
    flowOptions: StepcodeLoginFlowOptions = {},
  ): Promise<StartedStepcodeLoginFlow> {
    return startStepcodeLoginFlow({
      product: this.product,
      ...this.fetcher === undefined ? {} : { fetcher: this.fetcher },
      ...flowOptions,
    })
  }

  /**
   * 把登录产物落盘到指定 ref（Jet Hub `account.create` 的后台回调用）。
   *
   * @param result - {@link startStepcodeLoginFlow} 落定后的流程结果
   *   （`result.access` 是**已序列化**的凭据 JSON）。
   * @param options.refName - 目标 ref 名；缺省用产品的默认单凭据 ref。
   * @returns 写入的 ref 名、服务端 `uid`（可能缺席）与建议展示名。
   *
   * ⚠️ 只写**传入的** ref，不碰默认单凭据 ref —— 否则多账号场景下
   * 第二个账号会把第一个的凭据覆盖掉（`docs/adding-a-new-provider.md`
   * 对 `refreshAccountCredential` 的同款硬性契约，写凭据同样适用）。
   */
  async persistLogin(
    result: StepcodeLoginFlowResult,
    options: { refName?: string } = {},
  ): Promise<{ refName: string; uid?: string; nickname?: string }> {
    const refName = options.refName ?? this.credentialRefName
    await this.ctx.credentials.set(credentialRef(refName), result.access)
    // 回读解析：uid 用于账号展示名与「同账号重复添加」的去重判据。
    const credential = parseStepcodeCredential(result.access)
    const uid = credential?.uid
    return {
      refName,
      ...uid === undefined ? {} : { uid, nickname: `Step ${uid.slice(0, 8)}` },
    }
  }

  /** 读默认单凭据 ref（无账号池时的回退）。 */
  private async resolveDefaultCredential(): Promise<StepcodeCredential | undefined> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName))
    if (!resolved) return undefined
    return parseStepcodeCredential(resolved.value)
  }

  /**
   * 探测凭据有效性：`GET {apiBase}/v1/models`。
   *
   * @returns `true` = 服务端接受了这把 key；`false` = 明确的认证失败。
   *
   * ⚠️ **网络错误/5xx 不等于凭据失效** —— 那种情况返回 `undefined`
   * （「未知」），调用方**不应**据此把账号标记为需重新登录
   * （否则一次网络抖动就会让用户白白重登，且池里的账号被误标）。
   * 三态而非布尔，是本方法与 Loomy/TeleAgent 探测的关键差别。
   */
  async probeCredential(
    credential: StepcodeCredential,
    signal?: AbortSignal,
  ): Promise<boolean | undefined> {
    const token = stepcodeBearerToken(credential)
    if (token === undefined) return false
    const fetchFn = this.fetcher ?? globalThis.fetch.bind(globalThis)
    let response: Response
    try {
      response = await fetchFn(stepcodeModelsUrl(this.product), {
        method: 'GET',
        headers: stepcodeAuthHeaders(credential),
        signal: signal ?? AbortSignal.timeout(STEPCODE_REQUEST_TIMEOUT_MS),
      })
    } catch {
      // 传输层失败（断网、DNS、超时）：无法判定凭据好坏。
      return undefined
    }
    if (response.status === 401 || response.status === 403) return false
    if (!response.ok) return undefined
    return true
  }

  /**
   * 「续期」= 探测有效性（Step Code **没有** refresh 端点）。
   *
   * ⚠️ 只有**明确**的认证失败才抛终态错误；「未知」（网络问题）静默返回 ——
   * 让调度器下一轮再试，而不是把一次抖动升级成「请重新登录」。
   */
  async refresh(): Promise<void> {
    const credential = await this.resolveDefaultCredential()
    if (credential === undefined) {
      throw new StepcodeRefreshTokenExpiredError('凭据未配置，请先登录')
    }
    const valid = await this.probeCredential(credential)
    if (valid === false) {
      throw new StepcodeRefreshTokenExpiredError('Step Code 凭据已失效，请重新登录')
    }
  }

  /**
   * 按凭据 ref 探测指定账号（账号卡片「刷新」按钮）。
   *
   * ⚠️ **必须传 `pool` + `accountId`** 才能把结果写回账号池；
   * 只读写传入的 ref，**不碰**默认单凭据 ref（否则 Jet Hub 的刷新按钮
   * 会刷错凭据 —— `docs/adding-a-new-provider.md` 的硬性契约）。
   */
  async refreshAccountCredential(
    refName: string,
    pool?: AccountPool,
    accountId?: string,
  ): Promise<void> {
    const ref = credentialRef(refName)
    const resolved = await this.ctx.credentials.resolve(ref)
    if (!resolved) throw new StepcodeRefreshTokenExpiredError('凭据未配置')
    const credential = parseStepcodeCredential(resolved.value)
    if (credential === undefined) throw new Error('凭据解析失败')

    const valid = await this.probeCredential(credential)
    if (valid === false) {
      if (pool !== undefined && accountId !== undefined) {
        await pool.updateAccount(accountId, { refreshable: false }).catch(() => {})
      }
      throw new StepcodeRefreshTokenExpiredError('Step Code 凭据已失效，请重新登录')
    }
    // ⚠️ 有效期对账必须走共享实现 `syncAccountExpiry`（AGENTS.md 的契约，
    // 由 `refresh-bootstrap-wiring.spec.ts` 强制），**不要**手写 `updateAccount`。
    await syncAccountExpiry({
      pool,
      provider: this.product.id,
      credential,
      accessors: STEPCODE_EXPIRY_ACCESSORS,
      accountId,
      tag: `[${this.product.id}]`,
      warn: (message) => this.ctx.logger?.warn?.(message),
    })
  }

  /**
   * 批量探测账号池。
   *
   * ⚠️ **只按 `refreshable` 过滤，不看 `enabled`**（AGENTS.md 的既定红线：
   * 停用只影响「自动选号」，与「凭据是否需要保持新鲜」无关）。
   * 本 provider 的 `refreshable` 恒 false ⇒ 循环体**不发任何请求**，
   * 这正是我们要的：不给一个不可能续期的 provider 每 30 分钟发一轮探测。
   * 保留方法本身是为了让 `refreshTargets` 的分派形状与其余 14 家统一。
   */
  async refreshAll(pool: AccountPool): Promise<void> {
    const accounts = await pool.listAccounts(this.product.id)
    for (const entry of accounts) {
      if (!entry.refreshable) continue
      // ⚠️ `isStepcodeRefreshable` 恒 false，故此分支实际不可达；
      // 保留它是为了「将来官方真加了续期端点」时只需改那个纯函数。
      if (!isStepcodeRefreshable(entry as unknown as StepcodeCredential)) continue
      try {
        await this.refreshAccountCredential(entry.credentialRef, pool, entry.id)
      } catch (error) {
        this.ctx.logger?.warn?.(
          `[${this.product.id}] 账号 ${entry.id} 探测失败：`
          + `${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  /**
   * 拉取远端模型目录：`GET {apiBase}/v1/models`（只需 Bearer，无签名）。
   *
   * ⚠️ **必须带账号凭据** —— 目录是账号级的（订阅等级决定可见模型）。
   * 取号顺序：账号池当前可用账号 → 默认单凭据 ref。
   *
   * ⚠️ **失败一律返回兜底表（当前为空），不抛错**：模型目录是展示信息，
   * 不该让整个 provider 报错（与官方 `fetchStepModels` 的
   * `catch { return baseline() }` / `if (!response.ok) return baseline()` 一致）。
   */
  async fetchModels(pool?: AccountPool): Promise<readonly StepcodeModelEntry[]> {
    const baseline = (): readonly StepcodeModelEntry[] => stepcodeFallbackEntries(this.product)

    const credential = await this.resolveCredentialForCatalog(pool)
    if (credential === undefined) return baseline()

    const fetchFn = this.fetcher ?? globalThis.fetch.bind(globalThis)
    let response: Response
    try {
      response = await fetchFn(stepcodeModelsUrl(this.product), {
        method: 'GET',
        headers: stepcodeAuthHeaders(credential),
        signal: AbortSignal.timeout(STEPCODE_REQUEST_TIMEOUT_MS),
      })
    } catch {
      return baseline()
    }
    if (!response.ok) return baseline()

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      return baseline()
    }
    const entries = parseStepcodeModelsPayload(payload)
    // ⚠️ 空目录也回退兜底表（官方 `models.length > 0 ? models : baseline()`）：
    // 服务端偶发返回 `{data:[]}` 时，与其让面板空白，不如给出既有信息。
    return entries.length > 0 ? entries : baseline()
  }

  /** 目录拉取用的凭据：先账号池，后单凭据 ref。 */
  private async resolveCredentialForCatalog(
    pool?: AccountPool,
  ): Promise<StepcodeCredential | undefined> {
    if (pool !== undefined) {
      const available = await pool.getAvailableAccount(this.product.id, '').catch(() => undefined)
      if (available) return available.credential as unknown as StepcodeCredential
    }
    return this.resolveDefaultCredential()
  }

  /** 登出：清掉默认单凭据 ref（账号级删除由 `pool.removeAccount` 负责）。 */
  async logout(): Promise<void> {
    await this.ctx.credentials.unset(credentialRef(this.credentialRefName)).catch(() => {})
  }
}
