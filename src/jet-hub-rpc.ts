/**
 * Jet Hub 多账号管理的 RPC 端点注册。
 *
 * 使用 DSH 的 connection.fetch.register() 模式注册 HTTP API 端点，
 * 与 dsh-im 的 registerManagementRpc 一致。
 * 通道名 jet-hub → 路径 /api/jet-hub
 * 端点方法：account.list / account.create / account.update / account.delete /
 *           account.reorder / account.refresh / account.retest / account.retestAll /
 *           account.reset / account.resetAll / login.poll /
 *           credits.status / credits.claimAll / credits.balances /
 *           model.list / model.setDisabled /
 *           backup.export / backup.import / backup.status
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { AccountPool } from './account-pool.js'
import type { CodeArtsAuth } from './service.js'
import type { CodeArtsCredential } from './types.js'
import type { BuddyAuth } from './buddy-auth.js'
import type { LobsteraiAuth } from './lobsterai-auth.js'
import type { QoderAuth } from './qoder-auth.js'
import type { TraeAuth } from './trae-auth.js'
import type { ClineAuth } from './cline-auth.js'
import { LOOMY } from './loomy-product.js'
import { buddyExpiringWindowDays } from './buddy-balance-rank.js'
import type { LoomyAuth } from './loomy-auth.js'
import type { LoomyCredential } from './loomy.js'
import { RACCOON } from './raccoon-product.js'
import type { RaccoonAuth } from './raccoon-auth.js'
import type { ZcodeAuth } from './zcode-auth.js'
import { ZCODE } from './zcode-product.js'
import type { ZcodeCredential } from './zcode.js'
// ===== Antigravity（Google `agy` CLI，第 14 个面板·**非凭据型**）=====
// 与其余 12 家的**结构性差异**：凭据由官方 `agy` 二进制持有
// （macOS Keychain / Windows Credential Manager），一个账号 = 一个隔离 HOME 目录，
// 账号池住 `~/.dsh/agy-accounts/pool.json`（协议层 `src/agy/`，装配 `agy-service.ts`）。
// 因此它**不进** `ctx.credentials` / 本插件 `AccountPool`，也**刻意不在**
// `REF_PREFIX_TO_PROVIDER`（恢复逻辑造不出指向空气的账号）。
// RPC 与其余面板**同走标准动词**（`account.*` / `login.poll` / `model.*` /
// `provider.*`），分派在各 case 内按 provider 分支到 `antigravity` 服务形参；
// 只有无标准对应物的动作走 `antigravity.*` 扩展动词（开终端 / 设主号 / 选号模式 /
// 代理 / 面板状态驱动 / 主账号登录 / 粘授权码）。服务**不再**经模块级 holder，
// 而是与另外 13 个 auth 实例一样作 `registerJetHubRpc` 的位置参数传入。
import { ANTIGRAVITY_FAMILY_ORDER, ANTIGRAVITY_PROVIDER_ID } from './antigravity-product.js'
import type { AntigravityService } from './agy-service.js'
import { DOUBAO_PROVIDER_ID } from './doubao-product.js'
import type { DoubaoService } from './doubao-service.js'
import type { ManagedAccount } from './agy/pool-types.js'
import { modelFamilyOf, type ModelFamily } from './agy/pool-types.js'
import type { RaccoonCredential } from './raccoon.js'
import type { StartedRaccoonLoginFlow } from './raccoon-login-page.js'
import { MINIMAX } from './minimax-product.js'
import type { MinimaxAuth, StartedMinimaxLoginFlow } from './minimax-auth.js'
import { isMinimaxRefreshable, minimaxCredentialExpiresAtMs } from './minimax.js'
import type { MinimaxCredential } from './minimax.js'
import {
  claimMinimaxDailyCheckin,
  fetchMinimaxCreditBalance,
  fetchMinimaxSigninStatus,
} from './minimax-credits.js'
import { LOOMY_TASK_POINTS, LOOMY_TASK_TITLES } from './loomy-onboarding.js'
import { LOBSTERAI } from './lobsterai-product.js'
import { QODER, QODER_CN, type QoderProduct } from './qoder-product.js'
import { TRAE } from './trae-product.js'
import { CLINE } from './cline-product.js'
import {
  isLobsteraiRefreshable,
  lobsteraiCredentialExpiresAtMs,
  lobsteraiDisplayNickname,
} from './lobsterai.js'
import type { LobsteraiCredential } from './lobsterai.js'
import {
  fetchQoderUserNickname,
  isQoderRefreshable,
  qoderCredentialExpiresAtMs,
  withQoderNickname,
} from './qoder.js'
import type { QoderCredential } from './qoder.js'
import { claimQoderDailyCheckin, fetchQoderCreditBalance } from './qoder-credits.js'
import { isTraeRefreshable, traeCredentialExpiresAtMs, traeDisplayNickname } from './trae.js'
import type { TraeCredential } from './trae.js'
import { fetchClineCreditBalance } from './cline-credits.js'
import { fetchClineUsageLimits } from './cline-quota.js'
import { clineUpstreamOf, readClineRequestHistory } from './cline-request-log.js'
import {
  clineCredentialExpiresAtMs,
  isClineRefreshable,
  type ClineCredential,
} from './cline.js'
import { decorateLoginUrl, fetchAuthState, runBuddyLoginFlow } from './buddy-oauth.js'
import { credentialExpiresAtMs } from './buddy.js'
import type { BuddyCredential } from './buddy.js'
import {
  claimDailyCheckin,
  fetchCheckinStatus,
  fetchCreditBalance,
  type CheckinStatus,
  type ClaimOutcome,
  type CreditBalance,
} from './credits.js'
import { CODEBUDDY, WORKBUDDY, productById, type BuddyProduct } from './product.js'
import {
  claimLobsteraiDailyCheckin,
  fetchLobsteraiCreditBalance,
} from './lobsterai-credits.js'
import {
  claimCodeArtsDailyCheckin,
  fetchCodeArtsAccountInfoDetailed,
} from './codearts-credits.js'
import {
  claimTraeDailyCheckin,
  fetchTraeCheckinStatus,
  fetchTraeCreditBalance,
} from './trae-credits.js'
import {
  resetAccount,
  resetAllAccounts,
  retestAccount,
  retestAllAccounts,
} from './account-probe.js'
import { exportBackup, importBackup } from './backup.js'
import type {
  ProviderAccountEntry,
  RpcBackupExportResponse,
  RpcBackupImportRequest,
  RpcBackupImportResponse,
  RpcBackupStatusResponse,
  RpcListAccountsRequest,
  RpcListAccountsResponse,
  RpcCreateAccountRequest,
  RpcCreateAccountResponse,
  RpcPollLoginRequest,
  RpcPollLoginResponse,
  RpcUpdateAccountRequest,
  RpcDeleteAccountRequest,
  RpcReorderAccountsRequest,
  RpcRefreshAccountRequest,
  RpcRefreshAccountResponse,
  RpcRetestAccountRequest,
  RpcRetestAllRequest,
  RpcRetestResponse,
  RpcResetAccountRequest,
  RpcResetAllRequest,
  RpcResetResponse,
  RpcCreditsStatusRequest,
  RpcCreditsStatusResponse,
  RpcCreditsClaimAllRequest,
  RpcCreditsClaimAllResponse,
  RpcCreditsClaimSummary,
  RpcCreditsBalancesRequest,
  RpcCreditsBalancesResponse,
  RpcClineQuotaRequest,
  RpcClineQuotaResponse,
  RpcClineRequestLogRequest,
  RpcClineRequestLogResponse,
  RpcCreditsClaimAccountResult,
  RpcSendSmsRequest,
  RpcSendSmsResponse,
  RpcSubmitSmsRequest,
  RpcSubmitSmsResponse,
  RpcOnboardingStatusRequest,
  RpcOnboardingStatusResponse,
  RpcOnboardingClaimRequest,
  RpcOnboardingClaimResponse,
  RpcLoomyPermanentLockRequest,
  RpcPermanentLockRequest,
  RpcPermanentLockResponse,
  RpcModelListRequest,
  RpcModelListResponse,
  RpcModelSetDisabledRequest,
  RpcModelSetDisabledResponse,
  RpcModelSetAllDisabledRequest,
  RpcModelSetAllDisabledResponse,
  RpcModelSetDisabledManyRequest,
  RpcModelSetDisabledManyResponse,
  RpcProviderStatusRequest,
  RpcProviderStatusResponse,
  RpcProviderSetEnabledRequest,
  RpcProviderSetEnabledResponse,
  ProviderStatus,
} from './types.js'

/** Jet Hub RPC API 路径 */
export const JET_HUB_API_PATH = '/api/jet-hub'
/** Gateway RPC 端点名（connection.rpc.call 的 endpoint 参数） */
const JET_HUB_ENDPOINT = 'jet-hub'

/** 生成 8 字符随机短 ID（小写 hex） */
function shortId(): string {
  const buf = new Uint8Array(4)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 解析 Buddy 凭据 JSON；解析失败返回 undefined。 */
function parseBuddyCredential(raw: string): BuddyCredential | undefined {
  try {
    const parsed = JSON.parse(raw) as BuddyCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/** 解析 CodeArts 凭据 JSON；解析失败返回 undefined。 */
function parseCodeArtsCredential(raw: string): CodeArtsCredential | undefined {
  try {
    const parsed = JSON.parse(raw) as CodeArtsCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_key_id === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/** 解析 LobsterAI 凭据 JSON；解析失败返回 undefined。 */
function parseLobsteraiCredential(raw: string): LobsteraiCredential | undefined {
  try {
    const parsed = JSON.parse(raw) as LobsteraiCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/** 解析 Qoder 凭据 JSON；解析失败返回 undefined。 */
function parseQoderCredential(raw: string): QoderCredential | undefined {
  try {
    const parsed = JSON.parse(raw) as QoderCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/** 解析 TRAE 凭据 JSON；解析失败返回 undefined。 */
function parseTraeCredential(raw: string): TraeCredential | undefined {
  try {
    const parsed = JSON.parse(raw) as TraeCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/** 解析 Cline 凭据 JSON；解析失败返回 undefined。 */
function parseClineCredential(raw: string): ClineCredential | undefined {
  try {
    const parsed = JSON.parse(raw) as ClineCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/**
 * 构造 Raccoon 账号的**展示名**：`RaccoonAva (1100)`。
 *
 * ## 为什么要追加手机号尾号
 *
 * 服务端的 `name` 是**自动生成的默认名**（实测本机账号为 `RaccoonAva`，
 * 即「Raccoon」+ 随机串）。实证：
 *
 * - `GET /user_info` 的 `data.name = "RaccoonAva"`；
 * - JWT payload 里同样带 `name: "RaccoonAva"`（官方客户端就是读这个：
 *   `M = () => { ... userName: t.name, id: t.sid }`）；
 * - `wechat_bindings` 只有 `[{id, bound_at}]` —— **没有微信昵称/头像**。
 *   微信扫码走 `snsapi_login`（只给 openid），要昵称需额外申请
 *   `snsapi_userinfo`，这里显然没申请。
 *
 * 所以「显示 `RaccoonAva`」本身与官方一致、**不是取错字段**；但它是默认名，
 * 注册第二个账号时服务端很可能又给一个相近的名字 → 多账号重名、无法区分。
 *
 * 修法参考 Loomy（`Loomy 2222`）：这边有真实名字可用，故**保留原名再挂尾号**，
 * 兼顾「看得出服务端原名字」与「多账号可区分」。
 *
 * 退化顺序：昵称 + 手机号尾号 → 昵称 + 用户 id → 昵称 → 账号 id。
 * ⚠️ 手机号取**后 4 位**（够区分且不完整暴露号码）。
 */
export function buildRaccoonNickname(
  credential: Pick<RaccoonCredential, 'nickname' | 'phone' | 'user_id'>,
  fallbackId: string,
): string {
  const nickname = typeof credential.nickname === 'string' ? credential.nickname.trim() : ''
  const phone = typeof credential.phone === 'string' ? credential.phone.trim() : ''
  const userId = typeof credential.user_id === 'string' ? credential.user_id.trim() : ''

  // 消歧后缀：优先手机号尾号（更利于用户辨认是哪个号），否则用户 id
  const suffix = phone.length >= 4
    ? phone.slice(-4)
    : userId.length > 0 ? userId : ''

  if (nickname.length > 0) {
    // 已有该后缀时不重复追加（例如服务端名字里本就带手机号尾号）
    return suffix.length > 0 && !nickname.includes(suffix) ? `${nickname} (${suffix})` : nickname
  }
  if (suffix.length > 0) return `Raccoon ${suffix}`
  return fallbackId
}

/**
 * 支持「锁定永久积分」的 provider 白名单。
 *
 * ⚠️ **必须与前端 `credits-capabilities.js` 的 `supportsPermanentLock` 一致**：
 * 前端拿它决定要不要渲染按钮、要不要发读取请求；后端拿它拒绝越权写入。
 * 两边不一致的后果是「按钮出现但点了报错」或「功能存在却点不出来」。
 *
 * 只有这三家有两个可分的积分池：
 * - Loomy：服务端直接给 `dailyBalance`（当日到期）与 `balance`（永久）；
 * - CodeBuddy / WorkBuddy：要从资源包列表按**扣费截止距今是否满 15 天**现算
 *   （判据见 `buddy-balance-rank.ts`，实测两站形状不同但都成立）。
 * 其余渠道（CodeArts / LobsterAI / Qoder / TRAE / Cline / Raccoon）的积分
 * 模型里没有「会不会作废」这一层区分，登记进来只会多一个无效开关。
 */
export const PERMANENT_LOCK_PROVIDERS: ReadonlySet<string> = new Set([
  LOOMY.id,
  CODEBUDDY.id,
  WORKBUDDY.id,
])

/**
 * 汇总一次批量领取的结果。
 * 纯函数，便于单测；inactive（无资格/活动结束）与 failed 分开计数，
 * 因为前者是正常的业务状态、后者才是需要用户关注的问题。
 */
export function computeClaimSummary(outcomes: readonly ClaimOutcome[]): RpcCreditsClaimSummary {
  const summary: RpcCreditsClaimSummary = {
    claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0,
  }
  for (const outcome of outcomes) {
    switch (outcome.kind) {
      case 'claimed':
        summary.claimed += 1
        summary.totalCredit += outcome.credit
        break
      case 'already-claimed':
        summary.alreadyClaimed += 1
        break
      case 'inactive':
        summary.inactive += 1
        break
      case 'failed':
        summary.failed += 1
        break
      default: {
        // 编译期穷尽性检查：ClaimOutcome 未来新增 kind 时此处会报错，
        // 迫使作者显式决定它该计入哪一栏，而不是被静默漏计。
        const exhaustive: never = outcome
        void exhaustive
        // 运行期兜底：类型声明与运行时不符（未知 kind）时按 failed 计入，
        // 宁可多报一个失败，也不让结果凭空消失。
        summary.failed += 1
        break
      }
    }
  }
  return summary
}

/**
 * 积分端点的可注入依赖。
 *
 * 抽出这一层是为了让「逐账号处理」能脱离 `ctx.connection.fetch` 注册流程
 * 单独单测：端点内不做任何业务判断，只负责取账号列表并转交下面的纯函数。
 *
 * **对凭据/产品类型做泛型化**（而非写死 Buddy 系类型）：LobsterAI 的协议
 * 完全不同（无签名、三步签到、身份字段是 keyfrom），但「逐账号顺序执行、
 * 单个失败不中断、凭据解析在 try 之内」这套编排逻辑是**通用**的。
 * 泛型化让 `collect*` 三兄弟只写一遍，两套协议各自注入自己的下钻函数。
 * 默认类型参数保持 Buddy 系，故既有调用点与测试一行都不用改。
 */
export interface CreditsEndpointDeps<
  TCredential = BuddyCredential,
  TProduct = BuddyProduct,
> {
  /**
   * 解析凭据引用。
   * 按设计该接口**不可信**（凭据可能已被外部删除、provider 后端异常），
   * 实现允许抛错，调用方必须把异常算在单个账号头上。
   */
  resolve(ref: CredentialRef): Promise<{ value: string } | undefined>
  /** 查询签到状态；默认使用真实的 fetchCheckinStatus。 */
  fetchStatus?: (credential: TCredential, product: TProduct) => Promise<CheckinStatus | null>
  /** 执行签到领取；默认使用真实的 claimDailyCheckin。 */
  claim?: (credential: TCredential, product: TProduct, entry: ProviderAccountEntry) => Promise<ClaimOutcome>
  /** 查询积分余额；默认使用真实的 fetchCreditBalance。 */
  fetchBalance?: (credential: TCredential, product: TProduct) => Promise<CreditBalance | null>
  /**
   * 余额查询的**带原因**版本（优先于 {@link fetchBalance}）。
   *
   * 为什么需要它：`fetchBalance` 只用 `null` 表达「查不到」，调用方统一回
   * 「余额查询失败」。但 CodeArts 还有第三种情形 —— **非积分计费账户**
   * （Token 计费）：它不是故障，如实显示「余额查询失败」会把用户引向错误的
   * 排查方向。该钩子让实现能带回精确文案，同时仍复用本函数的逐账号编排
   * （顺序执行、单账号失败不中断、凭据解析在 try 之内）。
   */
  fetchBalanceDetailed?: (
    credential: TCredential,
    product: TProduct,
  ) => Promise<{ balance: CreditBalance | null; error?: string }>
  /** 单账号异常时的告警出口（不参与控制流）。 */
  warn?: (message: string) => void
  /**
   * 领取前是否先查一次签到状态（默认 `true`）。
   *
   * CodeBuddy 系拆成「查状态 + 领取」两个独立端点，先查可以省掉一次无效的
   * 领取请求（活动未开 / 今天已领时直接短路）。
   *
   * LobsterAI 的领取流程**自身就是多步的**（slot → context → check_in），
   * `claimedToday` / `actions` 判断已在内部完成并会返回对应的
   * `already-claimed` / `inactive`，外部再查一次纯属重复请求 ——
   * 故它传 `false` 跳过预检，直接交给 `claim`。
   */
  precheckStatus?: boolean
  /**
   * 默认实现（`fetchCheckinStatus` / `claimDailyCheckin` / `fetchCreditBalance`）
   * 使用的 fetch。
   *
   * ⚠️ **必须经此注入，不要在调用点直接 `fetch(...)`**：这些默认实现的真实签名是
   * `(credential, product, fetcher)`，而本模块的历史写法是
   * `deps.claim ?? (claimDailyCheckin as unknown as …)`，把三参函数硬转成
   * 「只传两个参数」的类型 —— 于是调用点写 `claim(credential, product, entry)`
   * 时，`entry` 落进了 `fetcher` 位置，运行时抛
   * **`TypeError: fetcher is not a function`**（真实缺陷：用户一键领取 4 个
   * CodeBuddy 账号全部失败）。
   *
   * 现改为**显式包装**默认实现（见下面的 `resolveClaim` 等），既保留 `entry`
   * 给需要它的 provider（TRAE 用 `entry.id` 取签到设备代次），又把 fetcher
   * 正确送进第三参。未提供时用全局 `fetch`。
   */
  fetcher?: typeof fetch
}

/**
 * 逐账号收集签到状态（顺序执行，避免并发触发风控）。
 *
 * **包含已停用账号**：停用只影响账号池的自动选择与限流切换，不改变账号本身
 * 是否已签到。用户要看到的是「这个账号今天领了没」，因此这里不过滤 enabled。
 *
 * 关键约束：**凭据解析也在 try 之内**。`credentialRef()` 会对名称做正则校验
 * （非法名称抛 TypeError），`deps.resolve()` 也可能抛错。若把它们留在 try
 * 之外，任一账号的异常都会冒泡到 handleMethod 外层 catch，使整批请求以
 * `jet-hub/handler-failed` 失败——违背「单个账号失败不中断整体」的设计。
 */
export async function collectCreditsStatus<TCredential = BuddyCredential, TProduct = BuddyProduct>(
  accounts: readonly ProviderAccountEntry[],
  product: TProduct,
  deps: CreditsEndpointDeps<TCredential, TProduct>,
): Promise<RpcCreditsStatusResponse['accounts']> {
  // 与 collectClaimResults 同款：显式包装默认实现把 fetcher 送进第三参，
  // 不用 `as unknown as` 掩盖签名差异（见 CreditsEndpointDeps.fetcher 的说明）。
  const fetcher = deps.fetcher ?? fetch
  const fetchStatus = deps.fetchStatus
    ?? (async (credential: TCredential, product: TProduct): Promise<CheckinStatus | null> =>
      fetchCheckinStatus(
        credential as unknown as BuddyCredential,
        product as unknown as BuddyProduct,
        fetcher,
      ))
  const results: RpcCreditsStatusResponse['accounts'] = []
  // 顺序查询，避免并发触发风控
  for (const entry of accounts) {
    let status: CheckinStatus | null = null
    try {
      const resolved = await deps.resolve(credentialRef(entry.credentialRef))
      if (resolved !== undefined) {
        const credential = JSON.parse(resolved.value) as TCredential
        status = await fetchStatus(credential, product)
      }
    } catch (error) {
      // 单个账号的凭据缺失 / JSON 损坏 / 名称非法 / 网络失败都不影响其余账号
      deps.warn?.(`[jet-hub] credits.status 账号 ${entry.id} 失败: ${String(error)}`)
      status = null
    }
    results.push({ accountId: entry.id, nickname: entry.nickname, status })
  }
  return results
}

/**
 * 逐账号执行一键领取（顺序执行，单个账号失败不中断整体）。
 *
 * **包含已停用账号**：签到领取与「是否参与账号池自动选择」无关 —— 停用的
 * 账号同样有当日积分可领，用户点「一键领取」时期望所有账号都尝试一遍。
 * 停用只影响限流切换时的候选集合，不影响这里。
 *
 * 与 collectCreditsStatus 同理：凭据解析位于每个账号自己的 try 之内，
 * 异常只让该账号记为 failed。
 */
export async function collectClaimResults<TCredential = BuddyCredential, TProduct = BuddyProduct>(
  accounts: readonly ProviderAccountEntry[],
  product: TProduct,
  deps: CreditsEndpointDeps<TCredential, TProduct>,
): Promise<RpcCreditsClaimAllResponse> {
  // ⚠️ **默认实现必须显式适配，不能 `as unknown as` 硬转。**
  //
  // 真实签名是 `(credential, product, fetcher)`，而本接口把 `claim` 声明为
  // `(credential, product, entry)`（TRAE 需要 `entry.id` 取签到设备代次）。
  // 历史写法用 `as unknown as` 把这个不匹配「压」过去 —— TypeScript 于是不再
  // 报错，但调用点传的第三个实参是 `entry`，它落进 `fetcher` 位置，运行时抛
  // **`TypeError: fetcher is not a function`**。
  // **真实缺陷**：用户一键领取 4 个 CodeBuddy 账号全部失败，报错就是这句。
  //
  // 修法：显式包装 —— 把 `deps.fetcher`（或全局 `fetch`）送进第三参，
  // `entry` 只交给真正需要它的 provider（它们在自己的分支里注入 `claim`）。
  const fetcher = deps.fetcher ?? fetch
  const fetchStatus = deps.fetchStatus
    ?? (async (credential: TCredential, product: TProduct): Promise<CheckinStatus | null> =>
      fetchCheckinStatus(
        credential as unknown as BuddyCredential,
        product as unknown as BuddyProduct,
        fetcher,
      ))
  const claim = deps.claim
    ?? (async (credential: TCredential, product: TProduct): Promise<ClaimOutcome> =>
      claimDailyCheckin(
        credential as unknown as BuddyCredential,
        product as unknown as BuddyProduct,
        fetcher,
      ))
  // 默认保留预检（CodeBuddy 系需要）；LobsterAI 显式传 false 跳过。
  const precheck = deps.precheckStatus !== false
  const results: RpcCreditsClaimAllResponse['results'] = []
  const outcomes: ClaimOutcome[] = []
  for (const entry of accounts) {
    let outcome: ClaimOutcome
    try {
      const resolved = await deps.resolve(credentialRef(entry.credentialRef))
      if (resolved === undefined) {
        outcome = { kind: 'failed', code: -1, message: '凭据未配置' }
      } else {
        const credential = JSON.parse(resolved.value) as TCredential
        if (!precheck) {
          // 领取流程自带状态判断（LobsterAI 的 slot/context 检查在 claim 内部）。
          outcome = await claim(credential, product, entry)
        } else {
          // 先查状态：活动未开启或今日已领则跳过领取请求，减少无效调用
          const status = await fetchStatus(credential, product)
          if (status !== null && !status.active) {
            outcome = { kind: 'inactive', message: '签到活动未开启' }
          } else if (status !== null && status.todayCheckedIn) {
            outcome = { kind: 'already-claimed', message: '今天已签到' }
          } else {
            // 状态查询失败（status 为 null）时仍然尝试领取：
            // 无法确认不代表不能领，交给领取接口以响应体 code 定夺。
            outcome = await claim(credential, product, entry)
          }
        }
      }
    } catch (error) {
      deps.warn?.(`[jet-hub] credits.claimAll 账号 ${entry.id} 失败: ${String(error)}`)
      outcome = {
        kind: 'failed', code: -1,
        message: error instanceof Error ? error.message : String(error),
      }
    }
    outcomes.push(outcome)
    results.push({ accountId: entry.id, nickname: entry.nickname, outcome })
  }
  return { results, summary: computeClaimSummary(outcomes) }
}

/**
 * 逐账号收集积分余额（顺序执行，避免并发触发风控）。
 *
 * 与 {@link collectCreditsStatus} 的关键差异：**这里保留失败原因**。
 * 余额查不到时用户最需要知道"为什么"（凭据过期？网络不通？），把它降级成
 * 一个 null 会让账号卡片显示成空白或 0 分，反而误导。因此失败时带上 error 文案。
 *
 * **包含已停用账号**：停用只影响账号池的自动选择，与"这个账号还剩多少积分"
 * 无关——用户就是想在同一个列表里看全部账号的余额。
 *
 * 凭据解析同样位于每个账号自己的 try 之内：单个账号的凭据缺失/损坏/名称非法
 * 都不会冒泡中断整批。
 */
export async function collectCreditBalances<TCredential = BuddyCredential, TProduct = BuddyProduct>(
  accounts: readonly ProviderAccountEntry[],
  product: TProduct,
  deps: CreditsEndpointDeps<TCredential, TProduct>,
): Promise<RpcCreditsBalancesResponse['accounts']> {
  // 同 collectClaimResults：显式包装，避免 `as unknown as` 掩盖签名差异。
  const fetcher = deps.fetcher ?? fetch
  const fetchBalance = deps.fetchBalance
    ?? (async (credential: TCredential, product: TProduct): Promise<CreditBalance | null> =>
      fetchCreditBalance(
        credential as unknown as BuddyCredential,
        product as unknown as BuddyProduct,
        fetcher,
      ))
  const fetchDetailed = deps.fetchBalanceDetailed
  const results: RpcCreditsBalancesResponse['accounts'] = []
  // 顺序查询，避免并发触发风控
  for (const entry of accounts) {
    let balance: CreditBalance | null = null
    let error: string | undefined
    try {
      const resolved = await deps.resolve(credentialRef(entry.credentialRef))
      if (resolved === undefined) {
        error = '凭据未配置'
      } else {
        const credential = JSON.parse(resolved.value) as TCredential
        if (fetchDetailed !== undefined) {
          // 带原因的查询：实现自己决定「非积分账户」等业务状态的文案。
          const detailed = await fetchDetailed(credential, product)
          balance = detailed.balance
          error = detailed.error
          if (balance === null && error === undefined) error = '余额查询失败'
        } else {
          balance = await fetchBalance(credential, product)
          // 查询函数以 null 表示"查不到"（网络/业务码异常），与"余额为 0"不同
          if (balance === null) error = '余额查询失败'
        }
      }
    } catch (caught) {
      deps.warn?.(`[jet-hub] credits.balances 账号 ${entry.id} 失败: ${String(caught)}`)
      error = caught instanceof Error ? caught.message : String(caught)
      balance = null
    }
    results.push({
      accountId: entry.id,
      nickname: entry.nickname,
      balance,
      ...error === undefined ? {} : { error },
    })
  }
  return results
}

/**
 * 读取 `ctx.llm` 用于枚举 provider 的模型目录。
 *
 * 用 `ctx.get` 而不是 `inject`：Jet Hub 的账号管理是主要职责，模型开关只是
 * 附加能力；llm 服务缺失时账号面板仍应可用，只是「显示列表」按钮报错。
 *
 * `listAllModels` 是本插件适配器额外提供的**不受用户黑名单影响**的完整目录
 * （见各适配器的同名方法）。DSH 的 `llm` 服务只保证 `listModels`，故这里把它
 * 声明为可选：缺失时退化为「用 listModels 的结果 + 黑名单补回裸 id」。
 */
function llmServiceOf(ctx: Context): {
  listModels(provider: string): Promise<Array<{ id: string; name: string }>>
  listAllModels?(provider: string): readonly { id: string; name: string }[]
} | undefined {
  return ctx.get('llm') as
    | {
      listModels(provider: string): Promise<Array<{ id: string; name: string }>>
      listAllModels?(provider: string): readonly { id: string; name: string }[]
    }
    | undefined
}

/**
 * 注册 Jet Hub 管理 API 端点。
 *
 * `connection` 服务只存在于 Web bundle；这里用**惰性注入**而非插件级静态
 * `inject`，因此在 headless / CLI profile 下本模块正常加载、只是不注册端点，
 * 而不是把整个插件树卡在 pending（那会让 profile 启动直接失败）。
 */
export function registerJetHubRpc(
  ctx: Context,
  pool: AccountPool,
  codearts: CodeArtsAuth,
  buddy: BuddyAuth,
  workbuddy: BuddyAuth,
  lobsterai: LobsteraiAuth,
  qoder: QoderAuth,
  /** Qoder **中国版**实例（与 `qoder` 同协议、不同 product；RPC 分支按注册表分派）。 */
  qoderCn: QoderAuth,
  trae: TraeAuth,
  cline: ClineAuth,
  loomy: LoomyAuth,
  raccoon: RaccoonAuth,
  /** MiniMax Code **中国版**实例（OAuth 设备码 + PKCE，与 Qoder 同型但协议不同）。 */
  minimax: MinimaxAuth,
  zcode: ZcodeAuth,
  /**
   * Antigravity（Google `agy` CLI）服务实例。
   *
   * ⚠️ 第 14 个面板、**非凭据型**：凭据归官方 agy 二进制、账号是隔离 HOME 目录，
   * 故没有 `AntigravityAuth` 凭据服务，而是装配层 `AntigravityService`（账号池 /
   * 登录 / 配额 / 模型目录）。与其余 auth 实例同列位置参数（AGENTS.md
   * 「位置参数陷阱」：新增占位必须 `grep -n 'registerJetHubRpc(' tests/` 全补齐）。
   *
   * 可选（`?`）：headless profile 与单测替身可省略 —— 等价于 agy 服务缺席，
   * 各 antigravity 分支返回 `jet-hub/antigravity-unavailable` 规范错误，而不是抛错。
   */
  antigravity?: AntigravityService,
  /**
   * provider → 适配器实例（可选）。
   *
   * 用于「显示列表」拿到**不受用户黑名单影响**的全量目录（`listAllModels`），
   * 使被关闭的模型也能显示正确的展示名（含倍率），而不是退化成裸 id。
   * 省略时退化为只用 `ctx.llm.listModels()` 的历史行为。
   */
  modelAdapters?: Readonly<Record<string, ModelCatalogSource>>,
  doubao?: DoubaoService,
): void {
  ctx.inject(['connection'], (connectionCtx) => {
    registerJetHubEndpoints(
      connectionCtx as Context, pool, codearts, buddy, workbuddy, lobsterai,
      qoder, qoderCn, trae, cline, loomy, raccoon, minimax, zcode, antigravity, modelAdapters,
      doubao,
    )
  })
}

/**
 * 「显示列表」所需的最小适配器接口：能给出**不套用户黑名单**的完整目录。
 *
 * 只声明用到的方法（结构化类型），避免让本模块依赖五个具体适配器类。
 */
export interface ModelCatalogSource {
  listAllModels(): readonly { id: string; name: string; isFree?: boolean }[]
}

// ────────────────────────────────────────────────────────────────────────────
// Antigravity（非凭据型面板，自实现版）
//
// 账号/登录/配额/模型端点与其余 13 家一样走**标准动词**，在各 case 内按
// provider 分派到 `registerJetHubEndpoints` 的 `antigravity` 形参
// （`AntigravityService`，与另外 13 个 auth 实例同一位置参数契约）。
// 账号池、凭据、模型目录全部由本仓库自实现：账号在
// `~/.dsh/agy-accounts/pool.json`，凭据由官方 `agy` 二进制持有，模型黑名单
// 由本插件的 `account-pool` 承载并被 `AntigravityAdapter.listModels` 真实
// 套用 —— 早期「model/provider 开关对 antigravity 是假开关」的 gate 已删除，
// 黑名单与启停现在**真实生效**。产品配置单一真相源：`antigravity-product.ts`。
// ────────────────────────────────────────────────────────────────────────────

/**
 * 把 `ManagedAccount`（agy 池条目）映射成 Jet Hub 账号卡片的通用形状。
 *
 * antigravity 的账号**不是**凭据型（没有 `credentialRef`/`access_token`），
 * 而是「隔离 HOME 目录 + agy 二进制持有的登录态」。映射时填 Jet Hub 卡片
 * 渲染真正消费的字段；凭据相关字段留空串，避免卡片上的「复制凭据」之类
 * 动作误触发。
 */
function mapAgyAccount(a: ManagedAccount): Record<string, unknown> {
  return {
    id: a.id,
    provider: ANTIGRAVITY_PROVIDER_ID,
    alias: a.alias,
    email: a.email ?? '',
    credentialRef: '',
    enabled: a.enabled,
    createdAt: a.createdAt,
    // 面板用这两个字段决定是否渲染「开终端」「隔离目录」动作。
    accountDir: a.dir,
    systemHome: a.systemHome === true,
    proxyUrl: a.proxyUrl ?? '',
    authRequired: a.authRequired === true,
    authError: a.authError ?? '',
    cooldowns: a.cooldowns,
    quotas: a.quotas,
    lastUsedAt: a.lastUsedAt ?? 0,
    isPrimary: false, // 由调用方按 primaryAccountId 覆盖
  }
}

/** antigravity 端点分派共用的「服务不可用」错误。 */
function agyUnavailable(): { ok: false; error: { code: string; message: string } } {
  return {
    ok: false,
    error: {
      code: 'jet-hub/antigravity-unavailable',
      message: 'Antigravity 服务未就绪（agy 二进制缺失或插件未加载）。请确认本机已安装 agy CLI。',
    },
  }
}

/**
 * 取 antigravity 服务；缺失（undefined，headless / 单测替身未注入）时返回规范错误
 * （由调用方直接 return）。服务实例由 `registerJetHubEndpoints` 的 `antigravity`
 * 形参传入 —— 与其它 13 家 auth 实例同一位置参数契约，不用模块级 holder。
 */
function requireAgyService(svc: AntigravityService | undefined):
  | { ok: true; svc: AntigravityService }
  | { ok: false; error: { code: string; message: string } } {
  if (!svc) return { ok: false, error: agyUnavailable().error }
  return { ok: true, svc }
}

function doubaoUnavailable(): { ok: false; error: { code: string; message: string } } {
  return {
    ok: false,
    error: {
      code: 'jet-hub/doubao-unavailable',
      message: 'Doubao 本地客户端探测服务未就绪。请确认在 Windows 环境下运行。',
    },
  }
}

function requireDoubaoService(svc: DoubaoService | undefined):
  | { ok: true; svc: DoubaoService }
  | { ok: false; error: { code: string; message: string } } {
  if (!svc) return { ok: false, error: doubaoUnavailable().error }
  return { ok: true, svc }
}

/**
 * 广播「模型目录可能已变化」。
 *
 * ⚠️ **改黑名单后必须调用**，否则「关闭后选择器里仍能看到该模型，重启后才消失」
 * （真实缺陷，用户报障）。根因在客户端而非适配器：
 * `dsh-client-ui-model-selection` 的 `ModelCatalogDirectory` 把 `modelCatalog`
 * 响应存进一个 `status === 'ready'` 即**短路返回缓存**的 store，只在三个转发的
 * 宿主事件上 `refresh()`：`llm/adapters-updated` / `settings/document-updated`
 * / `credentials/reference-updated`。
 *
 * 0.1.7 起黑名单落在插件自有文档 `$DSH_HOME/jet-hub/state.json`（不再经 settings
 * 文档，见 jet-hub-store.ts），因此写开关**不会**触发上述任何一个事件 → 客户端
 * 一直复用旧目录，直到重启（`connection/reset` → `resetGeneration()`）才重拉。
 *
 * 三者中 `llm/adapters-updated` 最贴合：按契约它是**无载荷**的「目录可能变了，
 * 请重新读 listModels」通知（dsh-llm README：*consumers re-read the registries*），
 * 正是这里要表达的语义。它也在 `API_REMOTE_FORWARDED_EVENTS` 白名单里，故会真的
 * 送达浏览器。不改变拓扑，故 dsh-llm 的 invariant 监听（对每个 provider 读一次
 * `retryPolicy`）必然通过，不会误报 INVARIANT。
 *
 * ⚠️ **通知失败不能反噬已经落盘的开关**：否则用户看到「切换失败」而实际已生效，
 * 再点一次又因幂等而看似「无效」，比不提示更难排查。故这里自行吞掉异常只记日志。
 */
function broadcastCatalogChanged(ctx: Context): void {
  try {
    ctx.emit('llm/adapters-updated')
  } catch (error) {
    ctx.logger.warn(`[jet-hub] 广播模型目录变更事件失败：${String(error)}`)
  }
}

/**
 * 取某 provider 的**全量模型 id**（不套黑名单），供「关闭全部」与「关闭供应商」共用。
 *
 * 两条路径的优先级（与 `model.list` 保持一致的取舍，但**不需要展示名**：
 * 这里只要 id 来写黑名单，故不走 `model.list` 那套回填 disabled 的复杂逻辑）：
 * 1. 优先 `modelAdapters[provider].listAllModels()` —— **同步**，不触发远端拉取；
 * 2. 缺失时退化 `llm.listModels(provider)` —— 异步，且**结果已被黑名单过滤**。
 *
 * ⚠️ 第 2 条路径拿不到「已关闭」的模型（它们不在 `listModels` 返回值里），
 * 故它写出的黑名单是**不完整**的。这对「关闭全部」无影响（已关闭的本就无需再关），
 * 但意味着**不能用它判断「是否全部已关闭」** —— 状态判定必须用
 * `listAllModels()` 的全量目录（见 `provider.status`）。
 *
 * @returns `{ ids }` 成功；`{ error }` 失败原因（调用方据此拒绝且**不落盘**）。
 */
async function fullCatalogIds(
  ctx: Context,
  modelAdapters: Readonly<Record<string, ModelCatalogSource>> | undefined,
  provider: string,
): Promise<{ ids: string[] } | { error: string }> {
  const all = modelAdapters?.[provider]?.listAllModels()
  if (all !== undefined) return { ids: all.map((model) => model.id) }
  const llm = llmServiceOf(ctx)
  if (llm === undefined) return { error: 'llm 服务不可用' }
  try {
    return { ids: (await llm.listModels(provider)).map((model) => model.id) }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { error: `读取模型列表失败：${reason}` }
  }
}

/** 注册 Jet Hub 管理 API 端点。使用 ctx.connection.fetch.register() 注册 HTTP POST 端点。 */
function registerJetHubEndpoints(
  ctx: Context,
  pool: AccountPool,
  codearts: CodeArtsAuth,
  buddy: BuddyAuth,
  workbuddy: BuddyAuth,
  lobsterai: LobsteraiAuth,
  qoder: QoderAuth,
  qoderCn: QoderAuth,
  trae: TraeAuth,
  cline: ClineAuth,
  loomy: LoomyAuth,
  raccoon: RaccoonAuth,
  minimax: MinimaxAuth,
  zcode: ZcodeAuth,
  /**
   * Antigravity 装配服务（非凭据型面板：账号池/登录/配额/模型目录）。
   * 可选：缺席时各 antigravity 分支回规范「不可用」错误。
   */
  antigravity?: AntigravityService,
  modelAdapters?: Readonly<Record<string, ModelCatalogSource>>,
  doubao?: DoubaoService,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const connection = (ctx as any).connection ?? ctx.get('connection')
  if (!connection || typeof connection.fetch?.register !== 'function') {
    ctx.logger.warn('[jet-hub] connection.fetch not available, RPC endpoints not registered')
    return
  }

  /**
   * Qoder **同协议族**成员：国际版与中国版共用同一组 RPC 实现，只换 `product`
   * 与 `auth` 实例。
   *
   * 为什么用注册表而不是给每个 provider 各加一条 `|| provider === X.id`：
   * 本文件里 Qoder 相关分支有**四处**（登录 / 单账号续期 / 余额 / 领取）。
   * 平行 case 的数量与「漏接一处」的概率同向增长 —— 本插件在 `workbuddy` 上
   * 就真漏过一次（账号卡片的「刷新」按钮一直报 `Unknown provider`）。
   * 注册表把「同族」这件事表达成数据结构，加第 N 个同族产品只改这一处。
   */
  interface QoderFamilyMember {
    readonly product: QoderProduct
    readonly auth: QoderAuth
  }
  const qoderFamily: readonly QoderFamilyMember[] = [
    { product: QODER, auth: qoder },
    { product: QODER_CN, auth: qoderCn },
  ]
  /** 该 provider 是否属于 Qoder 同族（国际版或中国版）。 */
  const isQoderFamily = (provider: string): boolean =>
    qoderFamily.some((member) => member.product.id === provider)
  /**
   * 取同族成员；不存在时抛错。
   *
   * ⚠️ 调用方**必须**先用 `isQoderFamily()` 判定。这里抛错而不是返回
   * `undefined`，是为了让分支内部不必写 `!` 或 `as` —— 那两类断言会在
   * 将来有人把判定改成别的条件时静默失效。
   */
  const requireQoderFamily = (provider: string): QoderFamilyMember => {
    const member = qoderFamily.find((item) => item.product.id === provider)
    if (member === undefined) throw new Error(`Unknown Qoder family provider: ${provider}`)
    return member
  }

  /**
   * Loomy 短信登录的中间状态（账号 id → { phone, msgid }）。
   *
   * 为什么放内存而不是凭据存储：msgid 是**一次性的中间态**（5 分钟有效），
   * 登录完成后即无意义；写进 `ctx.credentials` 会污染凭据命名空间，
   * 且它不含任何秘密（不能用于认证）。
   */
  const pendingSmsMsgid = new Map<string, { phone: string; msgid: string }>()

  connection.fetch.register({
    path: JET_HUB_API_PATH,
    methods: ['POST'],
    requestBody: 'buffered' as const,
    async fetch(request: Request): Promise<Response> {
      if (request.method !== 'POST') {
        return new Response('method not allowed', { status: 405 })
      }
      const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
      if (contentType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }

      let message: Record<string, unknown>
      try {
        message = await request.json() as Record<string, unknown>
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }

      const rpcId = typeof message.rpcId === 'string' ? message.rpcId : 'invalid-request'
      const call = message.payload as Record<string, unknown> | undefined
      if (
        message.type !== 'client-request' || typeof message.rpcId !== 'string'
        || message.method !== JET_HUB_ENDPOINT
        || !call || typeof call.method !== 'string'
        || !Object.prototype.hasOwnProperty.call(call, 'payload')
      ) {
        return reply(rpcId, { ok: false, error: { code: 'gateway/bad-request', message: 'Invalid Jet Hub management request.' } })
      }

      try {
        const result = await handleMethod(call.method as string, call.payload, request.signal)
        return reply(rpcId, result)
      } catch (error) {
        // 必须返回规范的 RPC 错误响应（而不是裸 500 文本），
        // 否则客户端 unwrapRpcResult 无法识别错误，表现为"点击无反应"。
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`[jet-hub] ${String(call.method)} failed: ${message}`)
        return reply(rpcId, {
          ok: false,
          error: { code: 'jet-hub/handler-failed', message },
        })
      }
    },
  })

  /**
   * 分发端点方法到对应的处理器。
   *
   * antigravity 的账号/登录/配额/模型端点在各 case 内按 provider 分派到
   * `getAntigravityService()`（见文件头 Antigravity 注释块）。
   */
  async function handleMethod(method: string, payload: unknown, _signal: AbortSignal): Promise<unknown> {
    // ── 端点名归一（兼容旧客户端）──────────────────────────────────────────
    // `cline.quota` / `cline.requestLog` 是 2026-10-02 泛化前的旧名 —— 当时
    // 这两个端点**只认 Cline**；泛化为按 provider 分派后改名 `subscriptionQuota.*`
    // （登记了 `subscriptionQuota` 能力位的 Cline / Antigravity 共用一条路径，
    // 与 `qoderFamily` 注册表同一取向：平行 case 的数量与「漏接一处」的概率同向增长）。
    // 旧客户端 bundle 的缓存/未刷新流量仍会打旧名，故这里映射而不是让它落
    // `unknown method` —— 那会表现成「点了订阅额度按钮、弹窗报未知方法」。
    if (method === 'cline.quota') return handleMethod('subscriptionQuota.get', payload, _signal)
    if (method === 'cline.requestLog') return handleMethod('subscriptionQuota.requestLog', payload, _signal)
    switch (method) {
      case 'account.list': {
        const req = payload as RpcListAccountsRequest
        if (req.provider === ANTIGRAVITY_PROVIDER_ID) {
          const got = requireAgyService(antigravity)
          if (!got.ok) return { ok: false, error: got.error }
          const primaryId = got.svc.pool.getPoolData().primaryAccountId
          const accounts = got.svc.pool.getAccounts().map((a) => ({
            ...mapAgyAccount(a),
            isPrimary: a.id === primaryId,
          }))
          return { ok: true, value: { accounts } }
        }
        if (req.provider === DOUBAO_PROVIDER_ID) {
          const got = requireDoubaoService(doubao)
          if (!got.ok) return { ok: false, error: got.error }
          const status = await got.svc.probe()
          const accounts: Record<string, unknown>[] = []
          if (status.allUsers && status.allUsers.length > 0) {
            for (const u of status.allUsers) {
              const isCurrent = status.currentUser?.userId === u.userId
              accounts.push({
                id: `doubao-${u.userId}`,
                provider: DOUBAO_PROVIDER_ID,
                alias: `UID: ${u.userId}${isCurrent ? ' (当前)' : ''}`,
                email: '',
                credentialRef: '',
                enabled: u.enable !== false,
                createdAt: u.userActionTime ? Number(u.userActionTime) : Date.now(),
                isPrimary: isCurrent,
                doubaoStatus: status,
              })
            }
          } else if (status.currentUser) {
            accounts.push({
              id: 'doubao-local',
              provider: DOUBAO_PROVIDER_ID,
              alias: `UID: ${status.currentUser.userId}`,
              email: '',
              credentialRef: '',
              enabled: status.currentUser.enable !== false,
              createdAt: status.currentUser.userActionTime ? Number(status.currentUser.userActionTime) : Date.now(),
              isPrimary: true,
              doubaoStatus: status,
            })
          } else if (status.installed) {
            accounts.push({
              id: 'doubao-local',
              provider: DOUBAO_PROVIDER_ID,
              alias: '本地桌面端 (未登录)',
              email: '',
              credentialRef: '',
              enabled: false,
              createdAt: Date.now(),
              isPrimary: true,
              doubaoStatus: status,
            })
          }
          return { ok: true, value: { accounts } }
        }
        const accounts = await pool.listAccounts(req.provider)
        return { ok: true, value: { accounts } }
      }

      case 'account.create': {
        const req = payload as RpcCreateAccountRequest
        const { provider } = req
        const id = `${provider}-${shortId()}`
        const suffix = shortId().toUpperCase()
        const refName = `${provider.toUpperCase()}_ACCOUNT_${suffix}`

        // CodeBuddy 系（buddy / workbuddy）共用两步登录流程：
        // 只获取 loginUrl 和 state 立即返回，后台用同一个 state 异步执行
        // 完整登录流程。两者的差异只在产品配置（platform、登录 URL 附加
        // 参数、X-Product-Code、User-Agent），全部由 product 承载。
        const product = productById(provider)
        if (product !== undefined) {
          let state: string
          let authUrl: string
          try {
            const authState = await fetchAuthState(undefined, undefined, product)
            state = authState.state
            // WorkBuddy 的登录 URL 需要追加 version 与 loginSessionId
            authUrl = decorateLoginUrl(authState.authUrl, product)
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            throw new Error(`无法获取 ${product.displayName} 登录地址（Host 网络请求失败）：${reason}`)
          }
          const ref = credentialRef(refName)
          // 先在 pool 中添加启用的占位条目（无凭据），方便客户端 login.poll 检测到
          await pool.addAccount({
            id,
            provider: product.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now(),
          })
          // 后台异步执行完整登录流程，使用同一个 state
          runBuddyLoginFlow({ openBrowser: () => {}, state, product }).then(async (flow) => {
            await ctx.credentials.set(ref, flow.access)
            // 续期定时器归属该产品自己的服务实例
            ;(product.id === CODEBUDDY.id ? buddy : workbuddy).scheduleRefresh()
            const credential = parseBuddyCredential(flow.access)
            await pool.updateAccount(id, {
              nickname: credential?.nickname ?? id,
              // Buddy 的 expires_at 是字符串形式的毫秒时间戳，
              // 必须用 credentialExpiresAtMs 解析（Date.parse 对纯数字串会得到 NaN）。
              expiresAt: credential ? credentialExpiresAtMs(credential) : undefined,
              refreshable: Boolean(credential?.refresh_token),
            })
          }).catch((err) => {
            ctx.logger.warn(`[jet-hub] background ${product.id} login failed for ${id}: ${err}`)
            // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
            void pool.removeAccount(id).catch(() => {})
          })
          return { ok: true, value: { accountId: id, loginUrl: authUrl } }
        } else if (provider === 'codearts') {
          // CodeArts 也是**回调式**登录（本地回调服务器收授权码），但同样必须
          // 走两步式：先返回 loginUrl 让前端立刻 window.open，后台再等回调。
          //
          // 为什么不能像早期那样 await 整个流程（真实缺陷）：浏览器只在用户
          // 点击后的短暂窗口（transient activation，约 5 秒）内允许 window.open。
          // 阻塞数十秒后才返回 URL，弹窗必被拦截并返回 null，前端兜底逻辑
          // 便执行 `window.location.href = loginUrl`，把整个设置页跳走
          // ——用户报的「主页面直接跳转过去了」正是此因。
          const started = await codearts.startLogin({ refName })
          // 先登记启用的占位条目（无凭据），使前端 login.poll 能立即看到该账号；
          // 登录成功后再回填昵称/有效期等真实字段。
          await pool.addAccount({
            id,
            provider: 'codearts',
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now(),
          })
          started.result.then(async (loginResult) => {
            const credential = parseCodeArtsCredential(loginResult.access)
            await pool.updateAccount(id, {
              nickname: credential?.user_name !== undefined && credential.user_name.length > 0
                ? credential.user_name
                : id,
              expiresAt: credential?.expires_at !== undefined
                ? (Number.isNaN(Date.parse(credential.expires_at)) ? undefined : Date.parse(credential.expires_at))
                : undefined,
              refreshable: Boolean(credential?.refresh_token),
            })
          }).catch((error: unknown) => {
            ctx.logger.warn(`[jet-hub] background codearts login failed for ${id}: ${String(error)}`)
            // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
            void pool.removeAccount(id).catch(() => {})
          })
          return { ok: true, value: { accountId: id, loginUrl: started.loginUrl } }
        } else if (provider === LOBSTERAI.id) {
          // LobsterAI 与 codearts 同款：回调式登录 + 两步式返回，
          // 理由见上面的 codearts 分支（弹窗拦截导致主页面被跳转）。
          const started = await lobsterai.startLogin({ refName })
          await pool.addAccount({
            id,
            provider: LOBSTERAI.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now(),
          })
          started.result.then(async (loginResult) => {
            const credential = parseLobsteraiCredential(loginResult.access)
            await pool.updateAccount(id, {
              // ⚠️ 用 `lobsteraiDisplayNickname`：服务端把**手机号本身**当昵称
              // 下发且只脱敏到「露末 4 位」，需归一化为末 2 位（用户要求）。
              nickname: lobsteraiDisplayNickname(credential, id),
              expiresAt: credential !== undefined ? lobsteraiCredentialExpiresAtMs(credential) : undefined,
              refreshable: credential !== undefined && isLobsteraiRefreshable(credential),
            })
          }).catch((error: unknown) => {
            ctx.logger.warn(`[jet-hub] background ${LOBSTERAI.id} login failed for ${id}: ${String(error)}`)
            void pool.removeAccount(id).catch(() => {})
          })
          return { ok: true, value: { accountId: id, loginUrl: started.loginUrl } }
        } else if (isQoderFamily(provider)) {
          // Qoder 同族（国际版 / 中国版）与 codearts / lobsterai 同款两步式，
          // 但登录机制不同：它是**设备码轮询**（不开本地回调服务器，见 src/qoder-oauth.ts），
          // 同样必须在用户授权前返回 loginUrl，理由见上面的 codearts 分支。
          //
          // ⚠️ 分支内一律用 `product` / `auth`，**不要**出现 `QODER` 字面量 ——
          // 否则中国版会拿国际版的域名与 client_id 发请求。
          const { product, auth } = requireQoderFamily(provider)
          const started = await auth.startLogin({ refName })
          // 先登记启用的占位条目（无凭据），使前端 login.poll 能立即看到该账号；
          // 登录成功后再回填昵称/有效期等真实字段。
          await pool.addAccount({
            id,
            provider: product.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now(),
          })
          started.result.then(async (loginResult) => {
            const credential = parseQoderCredential(loginResult.access)
            // ⚠️ 设备码轮询响应**不带 `user_name`**，故 `credential.nickname` 恒为空
            // —— 必须补一次 userinfo 才能拿到真实名字，否则账号卡片只能显示
            // `qodercn-xxxx`（多账号无法区分）。见 `fetchQoderUserNickname` 的说明。
            //
            // ⚠️ **失败不阻塞登录**：昵称只是展示信息，拿不到就退回账号 id
            //（与 `toLoginFlowResult` 对过期时间的处理同原则）。
            let nickname = credential?.nickname
            if ((nickname === undefined || nickname.length === 0) && credential !== undefined) {
              nickname = await fetchQoderUserNickname(credential, product)
              // 写回**凭据**（不只账号条目）：账号条目会随 Jet Hub 的账号操作
              // 整体重写，而凭据里存一份才能在续期后与其它面板都稳定拿到。
              if (nickname !== undefined && loginResult.access.length > 0) {
                const updated = withQoderNickname(credential, nickname)
                await ctx.credentials.set(credentialRef(refName), JSON.stringify(updated))
              }
            }
            await pool.updateAccount(id, {
              nickname: nickname !== undefined && nickname.length > 0 ? nickname : id,
              expiresAt: credential !== undefined ? qoderCredentialExpiresAtMs(credential) : undefined,
              refreshable: credential !== undefined && isQoderRefreshable(credential),
            })
          }).catch((error: unknown) => {
            ctx.logger.warn(`[jet-hub] background ${product.id} login failed for ${id}: ${String(error)}`)
            // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
            void pool.removeAccount(id).catch(() => {})
          })
          return { ok: true, value: { accountId: id, loginUrl: started.loginUrl } }
        } else if (provider === TRAE.id) {
          // TRAE 回调式登录 + 两步式返回（与 LobsterAI / codearts 同因）。
          const started = await trae.startLogin({ refName })
          // 先登记启用的占位条目（无凭据），使前端 login.poll 能立即看到该账号；
          // 登录成功后再回填昵称/有效期等真实字段。
          await pool.addAccount({
            id,
            provider: TRAE.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now(),
          })
          started.result.then(async (loginResult) => {
            const credential = parseTraeCredential(loginResult.access)
            await pool.updateAccount(id, {
              // ⚠️ 用 `traeDisplayNickname`（手机号优先）而非直接取 `nickname`：
              // 服务端 ScreenName 是**按 uid 自动生成的默认名**，多账号无法区分
              // （用户报障 2026-09-27）。见该函数的说明。
              nickname: traeDisplayNickname(credential, id),
              expiresAt: credential !== undefined ? traeCredentialExpiresAtMs(credential) : undefined,
              refreshable: credential !== undefined && isTraeRefreshable(credential),
            })
          }).catch((error: unknown) => {
            ctx.logger.warn(`[jet-hub] background ${TRAE.id} login failed for ${id}: ${String(error)}`)
            // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
            void pool.removeAccount(id).catch(() => {})
          })
          return { ok: true, value: { accountId: id, loginUrl: started.loginUrl } }
        } else if (provider === CLINE.id) {
          // Cline 是 **WorkOS 设备码轮询**登录（见 src/cline-oauth.ts）：
          // 与 Qoder 同为「不开本地回调服务器」的轮询式，但判据形态不同 ——
          // Qoder 看 HTTP 404，Cline 看响应体的 `error: authorization_pending`。
          //
          // ⚠️ 与 Qoder 的另一处差异：`startLogin` 内部要先发一次
          // `POST {workOsBase}/user_management/authorize/device` 拿到设备码，
          // 才能返回 loginUrl（Qoder 的 URL 是纯本地构造的）。那只是一次
          // 快速 POST，仍远快于浏览器手势窗口，故两步式的理由与 Qoder 一致。
          const started = await cline.startLogin({ refName })
          // 先登记启用的占位条目（无凭据），使前端 login.poll 能立即看到该账号；
          // 登录成功后再回填昵称/有效期等真实字段。
          await pool.addAccount({
            id,
            provider: CLINE.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now(),
          })
          started.result.then(async (loginResult) => {
            const credential = parseClineCredential(loginResult.access)
            await pool.updateAccount(id, {
              nickname: credential?.nickname !== undefined && credential.nickname.length > 0
                ? credential.nickname
                : id,
              expiresAt: credential !== undefined ? clineCredentialExpiresAtMs(credential) : undefined,
              refreshable: credential !== undefined && isClineRefreshable(credential),
            })
          }).catch((error: unknown) => {
            ctx.logger.warn(`[jet-hub] background ${CLINE.id} login failed for ${id}: ${String(error)}`)
            // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
            void pool.removeAccount(id).catch(() => {})
          })
          return { ok: true, value: { accountId: id, loginUrl: started.loginUrl } }
        } else if (provider === LOOMY.id) {
          // Loomy 走**微信扫码**登录（与其余 provider 同为「两步式」）：
          // 起本地服务器承载弹窗页（内联二维码 + 轮询 + 首次绑手机号表单），
          // 立即返回 `loginUrl` 让前端 `window.open`。
          //
          // ⚠️ **真实缺陷**（用户报障「新建账号失败：Loomy 短信登录需要手机号」）：
          // 早期实现要求 `account.create` **必须带 phone**，但表单要等它返回
          // `loginMode:'sms'` 才渲染 —— 用户根本没机会输入手机号，直接报错，
          // 表单永远出不来。**顺序死锁**。改用微信扫码后此矛盾消失：
          // 手机号只在「首次扫码」时由弹窗页自己收集。
          //
          // ⚠️ 先登记**占位条目**（无凭据），使前端 `login.poll` 能立即看到该账号；
          // 登录成功后再回填昵称/有效期。
          await pool.addAccount({
            id,
            provider: LOOMY.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now(),
          })

          let started
          try {
            started = await loomy.startWechatLogin()
          } catch (error) {
            // 取二维码 uuid 失败（网络/页面结构变化）：删掉占位条目，不留幽灵账号。
            void pool.removeAccount(id).catch(() => {})
            const reason = error instanceof Error ? error.message : String(error)
            throw new Error(`无法启动 Loomy 微信登录（获取二维码失败）：${reason}`)
          }

          started.result.then(async (login) => {
            const result = await loomy.persistWechatLogin(login, { refName })
            const credential = JSON.parse(result.access) as LoomyCredential
            await pool.updateAccount(id, {
              // 用手机号尾号让多账号可区分（Loomy 无独立昵称接口；
              // 微信昵称可能有，优先用它）。
              nickname: login.nickname !== undefined && login.nickname.length > 0
                ? login.nickname
                : credential.phone.length >= 4
                  ? `Loomy ${credential.phone.slice(-4)}`
                  : id,
              expiresAt: result.expires > 0 ? result.expires : undefined,
              // ⚠️ 恒 false：Loomy 无续期端点。
              refreshable: false,
            })
          }).catch((error: unknown) => {
            ctx.logger.warn(`[jet-hub] background ${LOOMY.id} wechat login failed for ${id}: ${String(error)}`)
            // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
            void pool.removeAccount(id).catch(() => {})
          })

          return { ok: true, value: { accountId: id, loginUrl: started.loginUrl } }
        } else if (provider === RACCOON.id) {
          // raccoon 走**本地页承载**的微信扫码 / 短信双路径登录（与 Loomy 同型）：
          // `startLogin` 立即返回指向 127.0.0.1 的 `loginUrl`，后台 await 结果。
          //
          // ⚠️ 绝不能在用户授权完成后才返回 loginUrl —— `window.open` 只在
          //    用户手势窗口内有效，那时手势早已过期、弹窗必被拦截。
          //
          // ⚠️ 先登记**占位条目**（无凭据），使前端 `login.poll` 能立即看到该账号；
          //    登录成功后再回填昵称与 refreshable。失败则删除占位条目。
          await pool.addAccount({
            id,
            provider: RACCOON.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now(),
          })

          let raccoonStarted: StartedRaccoonLoginFlow
          try {
            raccoonStarted = await raccoon.startLogin()
          } catch (error) {
            // 起本地服务器失败：删掉占位条目，不留幽灵账号。
            void pool.removeAccount(id).catch(() => {})
            const reason = error instanceof Error ? error.message : String(error)
            throw new Error(`无法启动 Raccoon 登录（本地登录页启动失败）：${reason}`)
          }

          raccoonStarted.result.then(async (credential) => {
            const result = await raccoon.persistLogin(credential, { refName })
            const saved = JSON.parse(result.access) as RaccoonCredential
            await pool.updateAccount(id, {
              // ⚠️ 服务端的 `name` 是**自动生成的默认名**（本机账号是
              // `RaccoonAva`，即「Raccoon」+ 随机串），微信扫码**不回传微信昵称**
              //（`wechat_bindings` 只有绑定 id 与时间，无昵称/头像）。
              // 它是账号的**正式名字**（JWT payload 里也有 `name`，官方客户端
              // 就显示它），故**保留**；但若注册第二个账号，服务端很可能又给一个
              // 相近的默认名 → 多账号重名、无法区分。
              //
              // 故追加**手机号尾号**消歧：`RaccoonAva (1100)`。
              // 与 Loomy 的 `Loomy 2222` 同策略（那边没有真实名字可用，
              // 这边有，所以保留原名再挂尾号）。
              nickname: buildRaccoonNickname(saved, id),
              expiresAt: result.expires > 0 ? result.expires : undefined,
              // ⚠️ raccoon **有** refresh 端点，与 Loomy（恒 false）不同。
              refreshable: result.refreshable,
            })
          }).catch((error: unknown) => {
            ctx.logger.warn(`[jet-hub] background ${RACCOON.id} login failed for ${id}: ${String(error)}`)
            // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
            void pool.removeAccount(id).catch(() => {})
          })

          return { ok: true, value: { accountId: id, loginUrl: raccoonStarted.loginUrl } }
        } else if (provider === MINIMAX.id) {
          // MiniMax Code（中国版）走 **OAuth 设备码 + PKCE**（与 Qoder 同型：
          // 不起本地监听端口，`startLogin` 立即返回指向 `agent.minimax.cn` 的
          // `verification_uri_complete`，后台轮询换 token）。
          //
          // ⚠️ 绝不能在用户授权完成后才返回 loginUrl —— `window.open` 只在
          //    用户手势窗口内有效，那时手势早已过期、弹窗必被拦截。
          //
          // ⚠️ 先登记**占位条目**（无凭据），使前端 `login.poll` 能立即看到该账号；
          //    登录成功后再回填昵称与 `expiresAt`。失败则删除占位条目。
          //    写法照 `RACCOON.id` 分支（那是已验证的形态）。
          await pool.addAccount({
            id,
            provider: MINIMAX.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now(),
          })

          let minimaxStarted: StartedMinimaxLoginFlow
          try {
            minimaxStarted = await minimax.startLogin()
          } catch (error) {
            // 设备码申请失败：删掉占位条目，不留幽灵账号。
            void pool.removeAccount(id).catch(() => {})
            const reason = error instanceof Error ? error.message : String(error)
            throw new Error(`无法启动 MiniMax 登录（设备码申请失败）：${reason}`)
          }

          minimaxStarted.result.then(async (credential) => {
            const result = await minimax.persistLogin(credential, { refName })
            await pool.updateAccount(id, {
              // ⚠️ `persistLogin` 的 `accountId` 对真实凭据**恒为 `undefined`** ——
              // MiniMax 的 `access_token` **不是 JWT**（`mmoat_` 前缀、60 字符、
              // 0 个点），故 `decodeJwtSub` 恒不命中、`account_id` 不会被写入。
              // 这是**预期行为**（账号 id 由本层生成），不是缺陷：此时退化为 `id`。
              // 一旦上游改发 JWT，这里会自动用上服务端的 account_id。
              nickname: result.accountId === undefined ? id : `MiniMax ${result.accountId.slice(0, 8)}`,
              // ⚠️ **必须用 `minimaxCredentialExpiresAtMs`**（优先 `expires_at`，
              // 它由 OAuth 响应的 `expires_in` 自算）—— 不能指望从 token 解 JWT，
              // 那样会得到 `undefined`，UI 永远显示「未知」。
              expiresAt: minimaxCredentialExpiresAtMs(credential),
              // ⚠️ MiniMax **有** refresh 端点（与 Loomy 恒 false 不同）。
              refreshable: isMinimaxRefreshable(credential),
            })
          }).catch((error: unknown) => {
            ctx.logger.warn(`[jet-hub] background ${MINIMAX.id} login failed for ${id}: ${String(error)}`)
            // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
            void pool.removeAccount(id).catch(() => {})
          })

          return { ok: true, value: { accountId: id, loginUrl: minimaxStarted.loginUrl } }
        } else if (provider === ZCODE.id) {
          /**
           * zcode 走**两步式**（与 codearts / qoder 等同型）：
           * 立刻返回官方授权 URL 让前端弹窗，后台轮询等服务端回调完成。
           *
           * ⚠ 必须**先返回 URL 再等结果** —— `window.open` 只在用户手势
           * 窗口内有效（`AGENTS.md` 记过 CodeArts 早期「主页面被跳转」的
           * 缺陷就是等授权完才返回 URL 导致的）。
           *
           * ## 与「读官方客户端凭据」的关系
           *
           * 早期实现是「确认磁盘上有一份官方客户端写的凭据」，
           * 那要求用户先装并登录官方 ZCode —— 与「装完即用」冲突。
           * 现在改为**插件自己走 OAuth**（实测 `/oauth/cli/init` →
           * 浏览器授权 → `/oauth/cli/poll/{flow_id}` 完全跑通，
           * 纯 HTTP、不经 `zcode://` 回调）。
           *
           * 若用户**已经**装并登录了官方客户端，则不必点这个按钮 ——
           * `refreshAll` / 首次加载时会自动把官方凭据固化进来。
           */
          const started = await zcode.startLogin({ refName })
          // 先登记占位条目（无凭据），使前端 `login.poll` 能立即看到该账号；
          // 登录成功后再回填昵称。失败则删除占位条目。
          await pool.addAccount({
            id,
            provider: ZCODE.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            // ⚠ 静态凭据（JWT 无 exp），没有 refresh 端点 —— 恒 false。
            refreshable: false,
            createdAt: Date.now(),
          })
          started.result.then(async (saved) => {
            /**
             * ★★ **重复账号去重**（真实缺陷，2026-10-02）。
             *
             * ## 为什么必须做
             *
             * 同一账号点两次「添加账号」会得到**两条独立条目** ——
             * 它们各自参与选号、各自消耗额度，而 UI 上看起来像两个账号
             * （昵称也一样，无从分辨）。此前 `user_id` 甚至**没有被存进
             * 凭据**，连判据都没有。
             *
             * ## 判据必须是 `user_id`，不能用 `device_mid`
             *
             * `device_mid` 在插件登录路径下由我们**随机生成**
             * （`generateDeviceMid()`，实测其值不被服务端绑定校验）——
             * **同一账号每次重新登录都会变**。拿它判重会把同一账号
             * 判成不同账号，反而**永远去重不掉**。
             * `user_id` 是**服务端下发**的稳定标识，才正确。
             *
             * ## 时机：必须在**登录成功之后**
             *
             * 登录前只有占位条目（无凭据、无 `user_id`），无从判断 ——
             * 故去重放在这个回调里，不在 `addAccount` 之前。
             *
             * ## ⚠ 处置：**不删条目**，而是把它标成**停用**并改名
             *
             * 为什么不直接 `removeAccount(id)`：前端 `login.poll` 是靠
             * 「条目还在 + 凭据已写入」判断登录成功的。
             * **删掉条目会让它显示成「登录失败」**，而事实恰恰相反
             * （登录成功了，只是这个账号已存在）—— 那会误导用户去反复重试。
             *
             * 停止则该条目：① 仍在列表里（`login.poll` 如实报告成功）；
             * ② `enabled: false` ⇒ **不参与自动选号**（这是去重的实际效果）；
             * ③ 昵称写明「重复」⇒ 用户一眼能看出发生了什么、可自行删除。
             *
             * ⚠ 保留**原来那条**（`existingId`）继续可用，不动它：它可能
             * 已被排序、改名或承载限流记录，删它损失更大。
             */
            const userId = saved.credential.user_id
            const label = saved.credential.account_label ?? id
            if (typeof userId === 'string' && userId.length > 0) {
              const existingId = await pool.findAccountIdByIdentityField(
                ZCODE.id,
                'user_id',
                userId,
              )
              if (existingId.length > 0 && existingId !== id) {
                ctx.logger.warn(
                  `[jet-hub] zcode 该账号（user_id=${userId}）已存在于 ${existingId}，`
                  + `新条目 ${id} 已自动停用（不参与选号）`,
                )
                await pool.updateAccount(id, {
                  nickname: `ZCode ${label}（重复，已停用）`,
                  enabled: false,
                })
                return
              }
            }
            await pool.updateAccount(id, { nickname: `ZCode ${label}` })
          }).catch((error: unknown) => {
            ctx.logger.warn(`[jet-hub] background ${ZCODE.id} login failed for ${id}: ${String(error)}`)
            // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
            void pool.removeAccount(id).catch(() => {})
          })
          return { ok: true, value: { accountId: id, loginUrl: started.loginUrl } }
        } else if (provider === ANTIGRAVITY_PROVIDER_ID) {
          /**
           * Antigravity（**非凭据型**面板）与其余 provider 同为「两步式」，
           * 但登录产物**不是可轮询的服务端凭据**，而是「PKCE + loopback 自动
           * 捕获授权码」（宿主侧自动开浏览器；loopback 绑不上时降级为面板里
           * **人工粘授权码 / 回调 URL**，走扩展动词 `antigravity.loginSubmitCode`）。
           * `begin()` 一返回即给出 Google consent URL，收敛状态由前端经
           * `login.poll` 观察 `poolAuth.status()`。
           *
           * ⚠️ **账号 id 用 `begin()` 返回的 stagingId**：agy 的账号条目要等
           * 授权码换 token 成功后才 commit 进池（`commitStagingAccount`），
           * 此前只有 staging 槽位 —— 故这里**不登记本插件账号池占位**（它不是
           * 凭据型账号）。`accountId` 仅供 `login.poll` 关联本次流程。
           *
           * ⚠️ **主账号**（真实系统 HOME）登录**不走这里**（无 staging 槽位、
           * 产物写进真实 HOME），走扩展动词 `antigravity.loginBeginPrimary`。
           *
           * ⚠️ 关闭方向同理走 `account.delete`（agy 池反查分派已接入）。
           */
          const got = requireAgyService(antigravity)
          if (!got.ok) return { ok: false, error: got.error }
          const alias = typeof (req as { alias?: unknown }).alias === 'string'
            ? (req as { alias?: string }).alias
            : undefined
          const proxyUrl = typeof (req as { proxyUrl?: unknown }).proxyUrl === 'string'
            ? (req as { proxyUrl?: string }).proxyUrl
            : undefined
          const started = await got.svc.poolAuth.begin(alias, proxyUrl)
          // 后端生成 QR data URL（宿主侧有 qrcode 依赖，客户端 bundle 没有）。
          let qrDataUrl: string | undefined
          if (started.url) {
            try {
              const qrcode = (await import('qrcode')) as unknown as { toDataURL: (t: string, o?: { width?: number; margin?: number }) => Promise<string> }
              qrDataUrl = await qrcode.toDataURL(started.url, { width: 220, margin: 1 })
            } catch {
              // QR 生成失败不阻塞登录（链接仍可点）
            }
          }
          return {
            ok: true,
            value: {
              // stagingId 在 commit 后会被真实账号 id 接替（poolAuth.status 可见）。
              accountId: started.stagingId ?? id,
              loginUrl: started.url ?? '',
              qrDataUrl,
            },
          }
        } else if (provider === DOUBAO_PROVIDER_ID) {
          const got = requireDoubaoService(doubao)
          if (!got.ok) return { ok: false, error: got.error }
          await got.svc.launchClient()
          return {
            ok: true,
            value: {
              accountId: 'doubao-local',
              loginUrl: '',
            },
          }
        } else {
          return { ok: false, error: { code: 'bad-request', message: `unknown provider: ${provider}` } }
        }
      }

      case 'account.update': {
        const req = payload as RpcUpdateAccountRequest
        if (req.accountId === 'doubao-local' || req.accountId.startsWith('doubao-')) {
          return { ok: true, value: undefined }
        }
        // antigravity 账号不在本池：按 provider 分派到 agyService.pool。
        // 反查 provider：agy 账号 id 形如 acc_*（无 provider- 前缀）。
        const agyGot = requireAgyService(antigravity)
        if (agyGot.ok && agyGot.svc.pool.getAccount(req.accountId)) {
          const patch = req.patch as { enabled?: boolean; alias?: string } | undefined
          if (patch && typeof patch.enabled === 'boolean') {
            agyGot.svc.pool.setAccountEnabled(req.accountId, patch.enabled)
          }
          if (patch && typeof patch.alias === 'string' && patch.alias.trim() !== '') {
            agyGot.svc.pool.setAccountAlias(req.accountId, patch.alias.trim())
          }
          return { ok: true, value: undefined }
        }
        await pool.updateAccount(req.accountId, req.patch)
        return { ok: true, value: undefined }
      }

      case 'account.delete': {
        const req = payload as RpcDeleteAccountRequest
        if (req.accountId === 'doubao-local' || req.accountId.startsWith('doubao-')) {
          return { ok: true, value: undefined }
        }
        const agyGot2 = requireAgyService(antigravity)
        if (agyGot2.ok && agyGot2.svc.pool.getAccount(req.accountId)) {
          // 删除会连带清掉隔离 HOME 目录与其中的 agy 登录态（不可撤销）。
          agyGot2.svc.pool.deleteAccount(req.accountId)
          return { ok: true, value: undefined }
        }
        await pool.removeAccount(req.accountId)
        return { ok: true, value: undefined }
      }

      // 拖拽排序：重写该 provider 账号在池中的顺序。
      // 该顺序是自动选号与限流换号的候选优先级，因此不是纯 UI 操作。
      case 'account.reorder': {
        const req = payload as RpcReorderAccountsRequest
        if (typeof req.provider !== 'string' || req.provider.length === 0) {
          return { ok: false, error: { code: 'bad-request', message: 'provider 必填' } }
        }
        if (!Array.isArray(req.orderedIds) || req.orderedIds.some(id => typeof id !== 'string')) {
          return { ok: false, error: { code: 'bad-request', message: 'orderedIds 必须是字符串数组' } }
        }
        if (req.provider === DOUBAO_PROVIDER_ID) {
          return { ok: true, value: undefined }
        }
        // antigravity：分派到 agyService.pool（它管 agy 账号的顺序）。
        if (req.provider === ANTIGRAVITY_PROVIDER_ID) {
          const got = requireAgyService(antigravity)
          if (!got.ok) return { ok: false, error: got.error }
          try {
            got.svc.pool.reorderAccounts(req.orderedIds)
          } catch (error) {
            return { ok: false, error: { code: 'bad-request', message: error instanceof Error ? error.message : String(error) } }
          }
          return { ok: true, value: undefined }
        }
        try {
          await pool.reorderAccounts(req.provider, req.orderedIds)
        } catch (error) {
          // 集合不一致（前端列表过期）是可预期的并发情况，回可读错误让用户
          // 刷新重试，而不是抛成 jet-hub/handler-failed 那种「未知故障」。
          return {
            ok: false,
            error: {
              code: 'bad-request',
              message: error instanceof Error ? error.message : String(error),
            },
          }
        }
        return { ok: true, value: undefined }
      }

      case 'account.refresh': {
        const req = payload as RpcRefreshAccountRequest
        try {
          // doubao：非凭据型本地客户端，探测刷新状态与 UID
          const doubaoGot = requireDoubaoService(doubao)
          if (doubaoGot.ok && (req.accountId === 'doubao-local' || req.accountId.startsWith('doubao-') || (req as { provider?: string }).provider === DOUBAO_PROVIDER_ID)) {
            await doubaoGot.svc.probe(true)
            return { ok: true, value: { success: true } satisfies RpcRefreshAccountResponse }
          }
          // antigravity：账号不在本插件池（非凭据型：凭据归官方 agy 二进制、
          // 账号是隔离 HOME），先反查 agy 池分派。判据与 account.update/delete
          // 一致（按 id 反查，不写死字面量 provider 分支）。
          const agyGot = requireAgyService(antigravity)
          if (agyGot.ok && agyGot.svc.pool.getAccount(req.accountId)) {
            // ⚠️ 「刷新」语义重定义：其余 provider 是**续期凭据**，agy 的凭据
            // 由官方二进制自续期 —— 这里做**登录态真探 + 配额刷新**
            // （语义与对面 plan §7 坑 5 一致）。
            await agyGot.svc.refreshAccount(req.accountId)
            return { ok: true, value: { success: true } satisfies RpcRefreshAccountResponse }
          }
          const accounts = await pool.listAllAccounts()
          const entry = accounts.find((a) => a.id === req.accountId)
          if (!entry) throw new Error(`Account ${req.accountId} not found`)

          // 按 **entry.provider** 分派到对应服务，并调用**按凭据 ref 的**
          // 续期入口 —— 三处都是修复既有缺陷的关键：
          //
          // 1. 原实现只处理 codearts / buddy，`workbuddy` 会落到 else 抛
          //    `Unknown provider`，即 WorkBuddy 账号卡片的「刷新」按钮一直是坏的；
          // 2. 原实现调的是 `service.refresh()`，它读写的是该 provider 的
          //    **默认单凭据 ref**（如 BUDDY_ACCESS_TOKEN），而账号卡片对应的是
          //    BUDDY_ACCOUNT_XXX —— 于是「刷新这个账号」实际刷的是另一个凭据，
          //    结果要么报错要么静默改了错的对象。
          // 3. ⚠️ **每个分支都必须传 `pool` + `entry.id`**（issue !IKIRTT）：
          //    续期成功后要把新的 `expiresAt` 写回账号池，UI 才不再显示
          //    「已过期」。早先只有 raccoon 分支传了，其余七个「刷新」下去
          //    凭据续好了、界面纹丝不动，用户没有任何自救手段。
          switch (entry.provider) {
            case 'codearts':
              await codearts.refreshAccountCredential(entry.credentialRef, pool, entry.id)
              break
            case 'buddy':
              await buddy.refreshAccountCredential(entry.credentialRef, pool, entry.id)
              break
            case 'workbuddy':
              await workbuddy.refreshAccountCredential(entry.credentialRef, pool, entry.id)
              break
            case LOBSTERAI.id:
              await lobsterai.refreshAccountCredential(entry.credentialRef, pool, entry.id)
              break
            case QODER.id:
            case QODER_CN.id:
              // 同协议族：按 provider 找到对应实例。
              // ⚠️ 只刷传入的这个 ref，不碰默认单凭据 ref（历史缺陷同因）。
              // ⚠️ **不要**图省事写 `qoder.refreshAccountCredential(...)` ——
              // 那会让中国版账号的「刷新」去续国际版的凭据（两站 token 不通用，
              // CN 永远续不动而国际版被无谓刷一次）。该串用由
              // `lobsterai-rpc-dispatch.spec.ts` 的行为级用例锁死（已做反向验证）。
              await requireQoderFamily(entry.provider).auth.refreshAccountCredential(entry.credentialRef, pool, entry.id)
              break
            case TRAE.id:
              await trae.refreshAccountCredential(entry.credentialRef, pool, entry.id)
              break
            case CLINE.id:
              await cline.refreshAccountCredential(entry.credentialRef, pool, entry.id)
              break
            case LOOMY.id:
              // ⚠️ Loomy **没有 refresh 端点**：这里只能做**有效性探测**，
              // 失效时抛「请重新登录」。见 LoomyAuth.refreshAccountCredential。
              await loomy.refreshAccountCredential(entry.credentialRef, pool, entry.id)
              break
            case RACCOON.id:
              // raccoon **有** refresh 端点（refresh_token 轮换），这里是真续期。
              // ⚠️ 只读写传入的 ref，不碰默认单凭据 ref。
              // ⚠️ **必须传 pool + entry.id**：续期后要把新的 `expiresAt` 写回
              // 账号池，否则 UI 一直显示「已过期」（真实缺陷：JWT 已续到 15:09、
              // 账号池仍是 12:02，相差 3.1 小时，但功能完全正常）。
              await raccoon.refreshAccountCredential(entry.credentialRef, pool, entry.id)
              break
            case MINIMAX.id:
              // MiniMax **有** refresh 端点（`/oauth2/token` 的 refresh_token 授权），
              // 这里是真续期。⚠️ 必须传 pool + entry.id —— 续期后要把新的
              // `expiresAt` 写回账号池，否则 UI 一直显示「已过期」。
              await minimax.refreshAccountCredential(entry.credentialRef, pool, entry.id)
              break
            case ZCODE.id:
              /**
               * zcode **没有 refresh 端点**（凭据是静态的，与 Loomy 同类）。
               *
               * 但这个方法仍做实事：**重读磁盘凭据并回写** —— 使用户在
               * 官方 ZCode 客户端重新登录后，点「刷新」即可生效而无需
               * 重启 DSH。凭据不可用时如实抛错（让用户知道要去官方客户端登录）。
               */
              await zcode.refreshAccountCredential(entry.credentialRef, pool, entry.id)
              break
            default:
              throw new Error(`Unknown provider: ${entry.provider}`)
          }
          return { ok: true, value: { success: true } }
        } catch (error) {
          return {
            ok: true,
            value: {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            },
          }
        }
      }

      case 'login.poll': {
        const req = payload as RpcPollLoginRequest
        // antigravity：登录产物**不是凭据**（非凭据型面板），而是 poolAuth
        // 流程状态（PKCE + loopback 自动捕获 / 手动粘码）。把它的状态机
        // 归一成标准 `done/success/error` 形状，另附 agy 专属字段（phase/url）。
        if (req.provider === ANTIGRAVITY_PROVIDER_ID) {
          const agyGot = requireAgyService(antigravity)
          if (!agyGot.ok) return { ok: true, value: { done: false } }
          const st = agyGot.svc.poolAuthStatus()
          // 无活动流程（或轮询的是别的账号）：如实返回未完成。
          if (st.phase === 'idle') {
            return { ok: true, value: { done: false, phase: 'idle' } satisfies RpcPollLoginResponse }
          }
          return {
            ok: true,
            value: {
              done: st.phase === 'done',
              success: st.phase === 'done',
              error: st.phase === 'failed' ? (st.code ?? 'login failed') : undefined,
              phase: st.phase,
              url: st.url,
              code: st.code,
            } satisfies RpcPollLoginResponse,
          }
        }
        if (req.provider === DOUBAO_PROVIDER_ID) {
          const got = requireDoubaoService(doubao)
          if (!got.ok) return { ok: true, value: { done: false } satisfies RpcPollLoginResponse }
          const status = await got.svc.probe(true)
          if (status.currentUser) {
            return {
              ok: true,
              value: {
                done: true,
                success: true,
              } satisfies RpcPollLoginResponse,
            }
          }
          return {
            ok: true,
            value: {
              done: false,
              success: false,
            } satisfies RpcPollLoginResponse,
          }
        }
        const accounts = await pool.listAllAccounts()
        const entry = accounts.find((a) => a.id === req.accountId)
        if (!entry) return { ok: true, value: { done: false } }
        // 检查凭据是否已实际写入（占位条目没有凭据）
        const ref = credentialRef(entry.credentialRef)
        const resolved = await ctx.credentials.resolve(ref)
        if (!resolved) return { ok: true, value: { done: false } }
        return { ok: true, value: { done: true, success: true } }
      }

      /**
       * 下发短信验证码（**仅 Loomy，备用登录路径**）。
       *
       * ⚠️ 主路径是**微信扫码**（`account.create` 返回本地弹窗页）。
       * 本端点与 `login.submitSms` 保留为**可独立调用的备用路径** ——
       * 不依赖 `account.create` 的中间态（早期版本从内存表取手机号，
       * 改微信登录后那张表不再被填充，会退化成坏死的死代码）。
       *
       * 手机号由**本端点自己接收**，故可脱离 `account.create` 单独使用。
       */
      case 'login.sendSms': {
        const req = payload as RpcSendSmsRequest
        if (req.provider !== LOOMY.id) {
          return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } }
        }
        const phone = typeof req.phone === 'string' ? req.phone.trim() : ''
        if (!/^1[3-9]\d{9}$/.test(phone)) {
          return { ok: false, error: { code: 'bad-request', message: '需要 11 位有效手机号（phone）' } }
        }
        const msgid = await loomy.sendSmsCode(phone)
        // 暂存在内存，供 submitSms 取用（一次性中间态，不写凭据存储）。
        pendingSmsMsgid.set(req.accountId, { phone, msgid })
        return { ok: true, value: { msgid } satisfies RpcSendSmsResponse }
      }

      /**
       * 提交短信验证码完成登录（**仅 Loomy，备用登录路径**）。
       *
       * 成功后：写凭据 → 回填账号昵称/有效期 → 清理中间态。
       */
      case 'login.submitSms': {
        const req = payload as RpcSubmitSmsRequest
        if (req.provider !== LOOMY.id) {
          return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } }
        }
        const pending = pendingSmsMsgid.get(req.accountId)
        if (pending === undefined || pending.msgid.length === 0) {
          return {
            ok: true,
            value: { done: false, error: '请先发送验证码' } satisfies RpcSubmitSmsResponse,
          }
        }
        const account = pool.findAccount(req.accountId)
        if (account === undefined) {
          return {
            ok: true,
            value: { done: false, error: '账号不存在（可能已被删除）' } satisfies RpcSubmitSmsResponse,
          }
        }
        try {
          const result = await loomy.loginWithSmsCode(pending.phone, req.code, pending.msgid, {
            refName: account.credentialRef,
          })
          const credential = JSON.parse(result.access) as LoomyCredential
          await pool.updateAccount(req.accountId, {
            // Loomy 无昵称接口，用手机号尾号让多账号可区分（比 `loomy-xxxx` 有用）。
            nickname: credential.phone.length >= 4
              ? `Loomy ${credential.phone.slice(-4)}`
              : req.accountId,
            expiresAt: result.expires > 0 ? result.expires : undefined,
            // ⚠️ 恒 false：Loomy 无续期端点。
            refreshable: false,
          })
          pendingSmsMsgid.delete(req.accountId)
          return { ok: true, value: { done: true } satisfies RpcSubmitSmsResponse }
        } catch (error) {
          // ⚠️ 登录失败**不删除占位条目**：用户可能只是验证码输错，
          // 保留条目让他能重试（`login.sendSms` 会重新发码）。
          return {
            ok: true,
            value: {
              done: false,
              error: error instanceof Error ? error.message : String(error),
            } satisfies RpcSubmitSmsResponse,
          }
        }
      }

      // ── Antigravity 扩展动词（`antigravity.*`）───────────────────────────
      // 与标准动词的边界：其余 13 家也有的能力（账号增删改查 / 排序 / 刷新 /
      // 重测 / 重置 / 登录发起 / 登录轮询 / 模型开关 / 供应商开关）一律走
      // **标准动词**（分派在各 case 内按 provider 分支到 `antigravity` 形参）；
      // 本命名空间只保留**无标准对应物**的 agy 专属动作。
      //
      // 演进记录：原 `agy.loginBegin` 已吸收进 `account.create` 的 antigravity
      // 分支；原 `agy.refreshQuota` / `agy.clearCooldown` 已分别吸收进
      // `account.retest*` / `account.reset*`。改名 `agy.*` → `antigravity.*`
      // 与 provider id / 服务名一致，消除「agy 是二进制名、antigravity 才是
      // provider id」的阅读歧义。
      //
      // 主账号（系统 HOME）登录。⚠️ 2026-10-02 用户报障「模型列表里没有」的
      // 根因之一：池里只有 primary 时，面板原先只有「+ 新增账号」（走 begin()
      // 建隔离副账号），**没有入口登录主账号** —— 未登录 ⇒ 登录门控隐藏模型
      // 分组 ⇒ 用户既看不到模型也找不到登录按钮，死循环。beginPrimary 把
      // token 写进真实 HOME（pool-auth.ts:175），官方 agy 直接认。
      case 'antigravity.loginBeginPrimary': {
        const got = requireAgyService(antigravity)
        if (!got.ok) return { ok: false, error: got.error }
        const body = (payload ?? {}) as { proxyUrl?: unknown }
        // 代理回落到主账号已存的 proxyUrl：换码 / 取 email 都要直连 Google，
        // 无代理环境必然超时（见 pool-auth.beginPrimary 注释）。
        const primaryAcc = got.svc.pool.getAccounts().find((a) => a.systemHome) ?? got.svc.pool.getAccounts()[0]
        const proxyUrl = typeof body.proxyUrl === 'string' && body.proxyUrl !== ''
          ? body.proxyUrl
          : primaryAcc?.proxyUrl
        const status = await got.svc.poolAuth.beginPrimary(proxyUrl)
        let qrDataUrl: string | undefined
        if (status.url) {
          try {
            const qrcode = (await import('qrcode')) as unknown as { toDataURL: (t: string, o?: { width?: number; margin?: number }) => Promise<string> }
            qrDataUrl = await qrcode.toDataURL(status.url, { width: 220, margin: 1 })
          } catch {
            // QR 生成失败不阻塞登录（链接仍可点）
          }
        }
        const { ok: _ok, dir: _dir, ...rest } = status
        void _ok; void _dir
        return { ok: true, value: { ...rest, qrDataUrl } }
      }

      // 模型目录**快照**端点（原 `antigravity.models`）已于 2026-10-02 对齐时
      // **删除**：面板的模型列表改用共享 `ModelListPanel`（标准 `model.list`）。
      // 那条路径的目录取 `modelAdapters.antigravity.listAllModels()`（不套门控、
      // 不套黑名单），门控只影响对话框选择器 —— 信息性列表在 `model.list` 里
      // 本来就是全量，再留一个端点就是同一件事的两套表达（死配置）。
      case 'antigravity.loginSubmitCode': {
        const got = requireAgyService(antigravity)
        if (!got.ok) return { ok: false, error: got.error }
        const body = (payload ?? {}) as { code?: unknown }
        if (typeof body.code !== 'string' || body.code.trim() === '') {
          return { ok: false, error: { code: 'bad-request', message: 'code 必填' } }
        }
        const status = await got.svc.poolAuth.submitCode(body.code)
        // 登录成功 ⇒ 三件事一起破缓存，否则用户要等最长一分钟才看到变化：
        // 1. 模型目录负缓存（未登录期间 refresh 失败落了 failedAt）；
        // 2. 登录态 60s 缓存（force 真探，把 signed-out 翻成 ok）；
        // 3. 广播目录变更 —— 适配器的登录门控翻转靠它触发选择器重读，
        //    不广播的话"登录成功了但模型列表还是空的"会持续到下次手动刷新。
        if (status.phase === 'done') {
          void got.svc.catalog.forceRefresh().catch(() => undefined)
          void got.svc.probeAuthStatus().catch(() => undefined)
          broadcastCatalogChanged(ctx)
        }
        const { ok: _ok, ...rest } = status
        void _ok
        return { ok: true, value: rest }
      }

      case 'antigravity.loginCancel': {
        const got = requireAgyService(antigravity)
        if (!got.ok) return { ok: false, error: got.error }
        const status = await got.svc.poolAuth.cancel()
        const { ok: _ok, ...rest } = status
        void _ok
        return { ok: true, value: rest }
      }

      // 设置主账号 / 取号模式 / 单账号代理。
      case 'antigravity.setPrimary': {
        const got = requireAgyService(antigravity)
        if (!got.ok) return { ok: false, error: got.error }
        const body = (payload ?? {}) as { accountId?: unknown }
        if (typeof body.accountId !== 'string') {
          return { ok: false, error: { code: 'bad-request', message: 'accountId 必填' } }
        }
        got.svc.pool.setPrimaryAccount(body.accountId)
        return { ok: true, value: { pool: got.svc.pool.getPoolData() } }
      }

      case 'antigravity.setMode': {
        const got = requireAgyService(antigravity)
        if (!got.ok) return { ok: false, error: got.error }
        const body = (payload ?? {}) as { mode?: unknown }
        if (body.mode !== 'sequential' && body.mode !== 'round-robin') {
          return { ok: false, error: { code: 'bad-request', message: 'mode 必须是 sequential 或 round-robin' } }
        }
        got.svc.pool.setMode(body.mode)
        return { ok: true, value: { pool: got.svc.pool.getPoolData() } }
      }

      case 'antigravity.setProxy': {
        const got = requireAgyService(antigravity)
        if (!got.ok) return { ok: false, error: got.error }
        const body = (payload ?? {}) as { accountId?: unknown; proxyUrl?: unknown }
        if (typeof body.accountId !== 'string') {
          return { ok: false, error: { code: 'bad-request', message: 'accountId 必填' } }
        }
        got.svc.pool.setAccountProxy(body.accountId, typeof body.proxyUrl === 'string' ? body.proxyUrl : undefined)
        return { ok: true, value: { pool: got.svc.pool.getPoolData() } }
      }

      // antigravity 整体状态：**只读内存快照，毫秒级返回**。
      //
      // ⚠️ 这里**不 await** 登录探针与模型目录发现：未登录时 `agy models`
      // 会挂到 watchdog（实测 ~15.7s）才被杀，若 status 等它们，面板首帧
      // 必然卡 15s+，且 5s 轮询会叠出常驻挂起子进程（用户报障：界面一直
      // 停在「正在读取 Antigravity 状态…」）。慢探针走独立端点
      // `antigravity.probe`（面板「刷新」按钮），轮询只拿快字段。
      case 'antigravity.status': {
        const got = requireAgyService(antigravity)
        if (!got.ok) return { ok: false, error: got.error }
        const cat = got.svc.catalog.get()
        return {
          ok: true,
          value: {
            bin: got.svc.agyBin,
            version: got.svc.agyVersion,
            dormantReason: got.svc.dormant,
            enabled: got.svc.dormant === null,
            // 同步的内存登录态（idle/pending/ok/…）；真实探针结果由 agy.probe 回填。
            auth: got.svc.auth.status(),
            poolAuth: got.svc.poolAuthStatus(),
            pool: got.svc.pool.getPoolData(),
            catalog: { source: cat.source, count: cat.models.length, lastError: cat.lastError ?? null },
            // 面板级设置：默认思考档位（空串 = 跟随适配器阶梯）与合法档位列表。
            defaultEffort: got.svc.config.defaultEffort,
            efforts: [...got.svc.efforts],
          },
        }
      }

      /**
       * 设置默认思考档位（面板开关，2026-10-03 用户要求）。
       *
       * 只影响**模型目录未钉死档位**时的兜底值；用户在模型选择器里选的档位
       * （`options.reasoningEffort`）始终优先。空串 = 取消覆盖、跟随模型默认。
       */
      case 'antigravity.setDefaultEffort': {
        const got = requireAgyService(antigravity)
        if (!got.ok) return { ok: false, error: got.error }
        const body = (payload ?? {}) as { effort?: unknown }
        if (typeof body.effort !== 'string') {
          return { ok: false, error: { code: 'bad-request', message: 'effort 必须是字符串（空串表示跟随模型默认）' } }
        }
        // 白名单在服务里校验并落盘；越界值被净化成空串，绝不会发给 agy。
        const value = got.svc.setDefaultEffort(body.effort)
        // 档位进入模型目录播报（`resolveModel().reasoning.defaultEffort`）⇒
        // 广播让模型选择器重读，否则改了界面上还显示旧默认档（与黑名单变更
        // 必须广播是同一条理由，见 broadcastCatalogChanged）。
        broadcastCatalogChanged(ctx)
        return { ok: true, value }
      }

      // 慢探针：登录态真探（spawn `agy models`）+ 模型目录发现。
      // 面板「刷新」按钮与登录成功后调用；轮询**不**走这里。
      case 'antigravity.probe': {
        const got = requireAgyService(antigravity)
        if (!got.ok) return { ok: false, error: got.error }
        const [auth, catalog] = await Promise.all([
          got.svc.probeAuthStatus().catch(() => null),
          got.svc.modelCatalog().catch(() => null),
        ])
        return {
          ok: true,
          value: {
            auth,
            catalog: catalog
              ? { source: catalog.source, count: catalog.models.length, lastError: catalog.lastError ?? null }
              : null,
            pool: got.svc.pool.getPoolData(),
          },
        }
      }

      case 'antigravity.openTerminal': {
        const got = requireAgyService(antigravity)
        if (!got.ok) return { ok: false, error: got.error }
        const body = (payload ?? {}) as { accountId?: unknown }
        if (typeof body.accountId !== 'string') {
          return { ok: false, error: { code: 'bad-request', message: 'accountId 必填' } }
        }
        const acc = got.svc.pool.getAccount(body.accountId)
        if (!acc || !acc.dir) {
          return { ok: false, error: { code: 'bad-request', message: '该账号没有隔离目录（主账号用真实系统 HOME）' } }
        }
        // 复用对面的跨平台终端拉起（agoscript / cmd / x-terminal）。
        const { spawn } = await import('node:child_process')
        const { isolatedHomeEnv } = await import('./agy/runner.js')
        const dir = acc.dir
        if (process.platform === 'darwin') {
          const script = `tell application "Terminal" to activate\ntell application "Terminal" to do script "export HOME='${dir}'; agy"`
          spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref()
        } else if (process.platform === 'win32') {
          spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', `set "HOME=${dir}" && set "USERPROFILE=${dir}" && agy`], { windowsHide: true, detached: true, stdio: 'ignore' }).unref()
        } else {
          spawn('x-terminal-emulator', ['-e', `sh -c "export HOME='${dir}'; agy; exec sh"`], { detached: true, stdio: 'ignore' }).unref()
        }
        void isolatedHomeEnv
        return { ok: true, value: { ok: true } }
      }

      // ===== 豆包客户端控制面（方案 1 · 路线 C：非凭据型本地客户端探测与唤醒） =====
      case 'doubao.status': {
        const got = requireDoubaoService(doubao)
        if (!got.ok) return { ok: false, error: got.error }
        const status = got.svc.getStatus()
        return { ok: true, value: status }
      }

      case 'doubao.probe': {
        const got = requireDoubaoService(doubao)
        if (!got.ok) return { ok: false, error: got.error }
        const status = await got.svc.probe(true)
        return { ok: true, value: status }
      }

      case 'doubao.launch': {
        const got = requireDoubaoService(doubao)
        if (!got.ok) return { ok: false, error: got.error }
        const body = (payload ?? {}) as { url?: unknown }
        const targetUrl = typeof body.url === 'string' && body.url.trim() ? body.url.trim() : undefined
        try {
          const res = await got.svc.launchClient(targetUrl)
          return { ok: true, value: res }
        } catch (err) {
          return {
            ok: false,
            error: {
              code: 'jet-hub/doubao-launch-failed',
              message: err instanceof Error ? err.message : String(err),
            },
          }
        }
      }

      /**
       * 查询新手任务 / 一次性奖励状态（**Loomy** 的新手任务、**raccoon** 的登录奖励，只读）。
       *
       * ⚠️ 只读：**不得**在此触发任何 `complete`/`claim`（面板挂载时会调用它）。
       * ⚠️ 两个 provider 共用本端点，故判据是「属于其中之一」而非只认 Loomy。
       */
      case 'onboarding.status': {
        const req = payload as RpcOnboardingStatusRequest
        if (req.provider !== LOOMY.id && req.provider !== RACCOON.id) {
          return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } }
        }
        const account = pool.findAccount(req.accountId)
        if (account === undefined) {
          return { ok: false, error: { code: 'bad-request', message: '账号不存在' } }
        }
        const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef))
        if (!resolved) {
          return { ok: false, error: { code: 'bad-request', message: '凭据未配置' } }
        }
        if (req.provider === RACCOON.id) {
          // raccoon 只有**一项**一次性奖励（桌面端登录奖励 3000 分），
          // 把它映射成 Loomy 那套「任务」形状的一项，复用同一个 RPC 与 UI。
          // ⚠️ 已领状态靠**账单反查**（服务端没有单独的状态端点）。
          const credential = JSON.parse(resolved.value) as RaccoonCredential
          const status = await raccoon.fetchOnboardingStatus(credential)
          return {
            ok: true,
            value: {
              // ⚠️ `tasks` 是 `Record<key, boolean>`（完成状态），不是数组。
              tasks: { desktop_login_reward: status.claimed },
              earned: status.claimed ? status.points : 0,
              total: status.points,
              titles: { desktop_login_reward: '桌面端登录奖励（每号一次）' },
              points: { desktop_login_reward: status.points },
            } satisfies RpcOnboardingStatusResponse,
          }
        }
        const credential = JSON.parse(resolved.value) as LoomyCredential
        const state = await loomy.fetchOnboardingTasks(credential)
        return {
          ok: true,
          value: {
            tasks: state.tasks,
            earned: state.earned,
            total: state.total,
            titles: { ...LOOMY_TASK_TITLES },
            points: { ...LOOMY_TASK_POINTS },
          } satisfies RpcOnboardingStatusResponse,
        }
      }

      /**
       * 「锁定永久积分」开关（读 / 写，**provider 维度**）。
       *
       * **用户需求**：锁定后选号只允许消耗**会近期作废**的积分，永久积分不参与 ——
       * 只剩永久积分的账号在锁定期间等同于不可用（「锁定后没有临时积分后找
       * 可用账号就是没有可用账号」）。解锁后恢复「没临时积分就用永久积分」。
       *
       * 三个 provider 都有这件事，但「什么算永久积分」不同（Loomy 看服务端的每日
       * 池字段；两个 buddy 看资源包扣费截止距今是否满 15 天，判据见
       * `buddy-balance-rank.ts`）。**语义相同、判据不同**，故共用一个端点与一张
       * 持久化表，而不是各加一条 case —— 平行分支越多，漏接概率越高。
       *
       * ⚠️ 开关是 **provider 级**（不分账号），持久化在
       * `$DSH_HOME/jet-hub/permanent-locks.json` 的 `locks` 表里（**不放 state.json**：
        * 那份文档同机多 profile 共享，另一条工作区的旧版本整体重写它时不会带上
        * 自己不认识的键 —— 理由见 `src/permanent-lock-store.ts` 文件头）
       * （`loomyPermanentLocked` 是同一值的兼容副本，见 `jet-hub-store.ts`）。
       *
       * ⚠️ `locked` 省略时**只读**（供面板初始化），给出布尔值才写入。
       */
      case 'credits.permanentLock':
      /**
       * Loomy 的历史端点名 —— 与上面**同一实现**，只是 provider 固定为 loomy
       * （老客户端 bundle 仍在调它，直接删会让 Loomy 面板的按钮静默失效）。
       */
      case 'loomy.permanentLock': {
        const req = payload as RpcPermanentLockRequest & RpcLoomyPermanentLockRequest
        // 老端点不认 provider 参数：即便载荷里带了也别照着执行。
        const provider = method === 'loomy.permanentLock'
          ? LOOMY.id
          : (typeof req.provider === 'string' ? req.provider.trim() : '')
        if (!PERMANENT_LOCK_PROVIDERS.has(provider)) {
          return {
            ok: false,
            error: { code: 'bad-request', message: `该 provider 不支持锁定永久积分：${provider || '(空)'}` },
          }
        }
        /**
         * 组装响应。
         *
         * ⚠️ 两个 buddy 必须**回传当前生效的窗口天数**：窗口可被
         * `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 覆盖，前端文案若继续写死 15 就会
         * 与真实判据不一致（用户看到「只烧 15 天内的」而实际按 31 天筛号）。
         * Loomy 没有窗口概念 → 不带该字段。
         */
        const lockResponse = (): RpcPermanentLockResponse => ({
          provider,
          locked: pool.permanentLocked(provider),
          ...(provider === CODEBUDDY.id || provider === WORKBUDDY.id
            ? { windowDays: buddyExpiringWindowDays() }
            : {}),
        })
        if (req.locked === undefined) {
          return { ok: true, value: lockResponse() }
        }
        if (typeof req.locked !== 'boolean') {
          return { ok: false, error: { code: 'bad-request', message: 'locked 必须是布尔值' } }
        }
        await pool.setPermanentLocked(provider, req.locked)
        // ⚠️ 与 `model.setDisabled` 同理：本次写入会改变**选号结果**
        // （进而改变哪些账号会被使用），故广播一次让界面重新读取状态。
        // 包 try/catch：通知失败不能反噬已经落盘的开关。
        try {
          ctx.emit('llm/adapters-updated')
        } catch (error) {
          ctx.logger?.warn?.(`[jet-hub] 广播 llm/adapters-updated 失败（不影响已保存的开关）: ${String(error)}`)
        }
        return { ok: true, value: lockResponse() }
      }

      /**
       * 领取新手任务 / 一次性奖励（**Loomy** 的新手任务、**raccoon** 的登录奖励，一次性）。
       *
       * ⚠️ 这是**写**操作，且**每号只能领一次** —— 与 `credits.claimAll`
       *（每日签到）语义完全不同，故独立端点。
       */
      case 'onboarding.claim': {
        const req = payload as RpcOnboardingClaimRequest
        // ⚠️ 两个 provider 共用本端点（Loomy 的新手任务 / raccoon 的登录奖励）。
        if (req.provider !== LOOMY.id && req.provider !== RACCOON.id) {
          return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } }
        }
        const account = pool.findAccount(req.accountId)
        if (account === undefined) {
          return { ok: false, error: { code: 'bad-request', message: '账号不存在' } }
        }
        const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef))
        if (!resolved) {
          return { ok: false, error: { code: 'bad-request', message: '凭据未配置' } }
        }
        if (req.provider === RACCOON.id) {
          // raccoon 的领取端点是**幂等**的：已领过返回 `granted:false`，
          // 此时 claimed 为空数组、skipped 含该项。
          //
          // ⚠️ **已领时 `earned` 必须报满分，不是 0**（真实缺陷，用户报障）。
          // `earned` 回答的是「该项目**累计**领到多少」，与「本次请求是否新增」
          // 无关。早期在 `already-claimed` 分支写 `earned: 0`，于是 UI 显示
          // 「✅ 1 个此前已完成 / 累计已领 0 / 3000」—— **自相矛盾**：
          // 既然「此前已完成」，那 3000 分显然已经拿到手了。
          const credential = JSON.parse(resolved.value) as RaccoonCredential
          const outcome = await raccoon.claimLoginReward(credential)
          if (outcome.kind === 'failed') {
            return { ok: false, error: { code: 'bad-request', message: outcome.message } }
          }
          const claimed = outcome.kind === 'claimed'
            ? [{ key: 'desktop_login_reward', title: '桌面端登录奖励', points: outcome.credit }]
            : []
          // 已领时的金额从**账单反查**取得（领取响应体里没有它），
          // 与 `onboarding.status` 同一数据源 —— 否则两处会显示不同的数字
          //（例如活动金额变化后，一处 3000、一处 3500）。
          // 只读 GET，且仅在「点按钮时已领」这一低频路径上发生。
          const points = outcome.kind === 'claimed'
            ? outcome.credit
            : (await raccoon.fetchOnboardingStatus(credential)).points
          return {
            ok: true,
            value: {
              claimed,
              skipped: outcome.kind === 'already-claimed' ? ['desktop_login_reward'] : [],
              // 该项目累计已领 = 满分（无论本次是否新增）。
              earned: points,
              total: points,
            } satisfies RpcOnboardingClaimResponse,
          }
        }
        const credential = JSON.parse(resolved.value) as LoomyCredential
        const result = await loomy.claimOnboardingTasks(credential)
        return {
          ok: true,
          value: {
            claimed: result.claimed.map((item) => ({
              key: item.key,
              title: LOOMY_TASK_TITLES[item.key] ?? item.key,
              points: item.points,
            })),
            skipped: result.skipped,
            earned: result.earned,
            total: result.total,
          } satisfies RpcOnboardingClaimResponse,
        }
      }

      // ── 限流标记：重测（发真实请求验证）──
      // 标记只反映"上一次 429 时的快照"，服务端常在重置时间前提前放行。
      // 重测发一次最小对话请求：正常返回才清除标记，仍受限则保留并回报原因。
      case 'account.retest': {
        const req = payload as RpcRetestAccountRequest
        if (req.accountId === 'doubao-local' || req.accountId.startsWith('doubao-')) {
          const doubaoGot = requireDoubaoService(doubao)
          if (doubaoGot.ok) {
            await doubaoGot.svc.probe(true)
          }
          return {
            ok: true,
            value: {
              accounts: [{ accountId: req.accountId, tested: 0, cleared: [], stillLimited: [] }],
              clearedCount: 0,
            } satisfies RpcRetestResponse,
          }
        }
        // antigravity：账号在 agy 池（非凭据型）。「重测」= 对该账号发一次真实
        // 的强制配额刷新（HTTPS 配额查询验证账号仍可用），语义与其余 provider
        // 「发探测消息验证限流标记」同族；ProbeAccountResult 形状对齐。
        const agyGot = requireAgyService(antigravity)
        if (agyGot.ok && agyGot.svc.pool.getAccount(req.accountId)) {
          const acc = agyGot.svc.pool.getAccount(req.accountId)!
          await agyGot.svc.quota.refreshAccountQuota(acc, true)
          return {
            ok: true,
            value: {
              accounts: [{ accountId: req.accountId, tested: 0, cleared: [], stillLimited: [] }],
              clearedCount: 0,
            } satisfies RpcRetestResponse,
          }
        }
        const account = await retestAccount(pool, req.accountId)
        return {
          ok: true,
          value: { accounts: [account], clearedCount: account.cleared.length },
        }
      }

      // 重测该 provider 下的全部账号。**包含已停用账号**——用户明确要求
      // 停用账号也能重测（停用只影响自动选择，不影响手动排查）。
      case 'account.retestAll': {
        const req = payload as RpcRetestAllRequest
        if (req.provider === DOUBAO_PROVIDER_ID) {
          const doubaoGot = requireDoubaoService(doubao)
          if (doubaoGot.ok) {
            await doubaoGot.svc.probe(true)
          }
          return {
            ok: true,
            value: {
              accounts: [{ accountId: 'doubao-local', tested: 0, cleared: [], stillLimited: [] }],
              clearedCount: 0,
            } satisfies RpcRetestResponse,
          }
        }
        // antigravity：对全部账号（**含已停用**，与其余 provider 同约定）做强制配额刷新。
        if (req.provider === ANTIGRAVITY_PROVIDER_ID) {
          const got = requireAgyService(antigravity)
          if (!got.ok) return { ok: false, error: got.error }
          await got.svc.quota.refreshAllQuotas(true)
          const accounts = got.svc.pool.getAccounts().map((a) => ({
            accountId: a.id, tested: 0, cleared: [], stillLimited: [],
          }))
          return {
            ok: true,
            value: { accounts, clearedCount: 0 } satisfies RpcRetestResponse,
          }
        }
        const value = await retestAllAccounts(pool, req.provider)
        return { ok: true, value }
      }

      // ── 限流标记：重置（不发请求，直接清除）──
      case 'account.reset': {
        const req = payload as RpcResetAccountRequest
        if (req.accountId === 'doubao-local' || req.accountId.startsWith('doubao-')) {
          return {
            ok: true,
            value: { clearedCount: 0, accountCount: 1 } satisfies RpcResetResponse,
          }
        }
        // antigravity：清该账号的限流冷却（agy 池按 family 记 cooldown）。
        const agyGot = requireAgyService(antigravity)
        if (agyGot.ok && agyGot.svc.pool.getAccount(req.accountId)) {
          const acc = agyGot.svc.pool.getAccount(req.accountId)!
          const cleared = acc.cooldowns ? Object.keys(acc.cooldowns).length : 0
          agyGot.svc.pool.clearCooldown(req.accountId, undefined)
          return {
            ok: true,
            value: { clearedCount: cleared, accountCount: 1 } satisfies RpcResetResponse,
          }
        }
        const value = await resetAccount(pool, req.accountId)
        return { ok: true, value }
      }

      case 'account.resetAll': {
        const req = payload as RpcResetAllRequest
        if (req.provider === DOUBAO_PROVIDER_ID) {
          return {
            ok: true,
            value: { clearedCount: 0, accountCount: 1 } satisfies RpcResetResponse,
          }
        }
        // antigravity：清全部账号的限流冷却。
        if (req.provider === ANTIGRAVITY_PROVIDER_ID) {
          const got = requireAgyService(antigravity)
          if (!got.ok) return { ok: false, error: got.error }
          let cleared = 0
          for (const acc of got.svc.pool.getAccounts()) {
            cleared += acc.cooldowns ? Object.keys(acc.cooldowns).length : 0
          }
          got.svc.pool.clearCooldown(undefined, undefined)
          return {
            ok: true,
            value: { clearedCount: cleared, accountCount: got.svc.pool.getAccounts().length } satisfies RpcResetResponse,
          }
        }
        const value = await resetAllAccounts(pool, req.provider)
        return { ok: true, value }
      }

      // ── 每日签到（积分领取）──
      // 查询某 provider 下全部启用账号的签到状态。
      //
      // 四个 provider 分属**三套互不相同的协议**，各自在自己的分支里处理：
      //   - CodeBuddy 系（buddy / workbuddy）：`productById()` 取 BuddyProduct，
      //     走 `collectCreditsStatus` 的默认实现；
      //   - `lobsterai`：slot → context 三步，无独立状态端点；
      //   - `codearts`：华为云 SDK-HMAC-SHA256 签名，无独立状态端点。
      //
      // ⚠️ 只有 CodeBuddy 系能经 `productById()` 解析出产品配置；后两者
      // **必须各自提前分支**，否则会落到下面的 bad-request。历史上 CodeArts
      // 就是因此恒回 `unsupported provider: codearts`（客户端在面板挂载时
      // 无条件调用 credits.balances，于是每打开一次设置页都在控制台报错并把
      // 账号卡片标成查询失败）。现在 CodeArts 已有真实实现，该 bad-request
      // 只对**未知** provider 生效。
      case 'credits.status': {
        const req = payload as RpcCreditsStatusRequest
        if (req.provider === 'codearts') {
          // CodeArts 没有独立的「签到状态」端点：可领状态要经
          // `statistics/plugin`（账户类型）+ `/v1/ops/delivery`（活动列表）
          // 两步才能得到，且语义与 CodeBuddy 的 CheckinStatus 不同构
          //（无 streak_days / daily_credit 等概念）。
          // 故与 LobsterAI 同样如实返回 null，而不是臆造一份状态对象。
          const accounts = await pool.listAccounts(req.provider)
          return {
            ok: true,
            value: {
              accounts: accounts.map((entry) => ({ accountId: entry.id, nickname: entry.nickname, status: null })),
            } satisfies RpcCreditsStatusResponse,
          }
        }
        if (req.provider === LOBSTERAI.id) {
          // LobsterAI 没有独立的「签到状态」端点：活动状态要经
          // slot → context 两步才能得到，且语义与 CodeBuddy 的
          // CheckinStatus 不同构（无 streak/dailyCredit 等概念）。
          // 故这里如实返回 null，而不是臆造一份状态对象。
          const accounts = await pool.listAccounts(req.provider)
          return {
            ok: true,
            value: {
              accounts: accounts.map((entry) => ({ accountId: entry.id, nickname: entry.nickname, status: null })),
            } satisfies RpcCreditsStatusResponse,
          }
        }
        if (req.provider === TRAE.id) {
          // TRAE 有签到状态端点，但需要发起 Ug 请求获取（见 claim 内部的多步流程）。
          // 与 LobsterAI/CodeArts 一样如实返回 null，由 claimAll 自行处理预检。
          const accounts = await pool.listAccounts(req.provider)
          return {
            ok: true,
            value: {
              accounts: accounts.map((entry) => ({ accountId: entry.id, nickname: entry.nickname, status: null })),
            } satisfies RpcCreditsStatusResponse,
          }
        }
        if (req.provider === CLINE.id) {
          // Cline **没有签到端点**（对整个 sidecar 二进制做字符串扫描，
          // checkin / check-in / daily / campaign 均无任何 Cline 业务端点命中；
          // 见 src/cline-credits.ts 的模块注释）。故与 WorkBuddy 国际版一致，
          // 如实返回 null，而不是臆造一份状态对象。
          const accounts = await pool.listAccounts(req.provider)
          return {
            ok: true,
            value: {
              accounts: accounts.map((entry) => ({ accountId: entry.id, nickname: entry.nickname, status: null })),
            } satisfies RpcCreditsStatusResponse,
          }
        }
        if (req.provider === LOOMY.id) {
          // Loomy 没有独立的「签到状态」端点：每日额度由 `POST /points/first-login`
          // 触发，其响应自带 `alreadyProcessed`。故与 LobsterAI/CodeArts 同样
          // 如实返回 null，由 claimAll 内部处理幂等。
          const accounts = await pool.listAccounts(req.provider)
          return {
            ok: true,
            value: {
              accounts: accounts.map((entry) => ({ accountId: entry.id, nickname: entry.nickname, status: null })),
            } satisfies RpcCreditsStatusResponse,
          }
        }
        if (req.provider === MINIMAX.id) {
          // ⚠️ MiniMax **有**独立的签到状态端点（`/minimax-cloud/api/v1/signin/status`），
          // 与 LobsterAI/TRAE/Cline 那几个「如实返回 null」的 provider 不同 ——
          // 故走共享 helper 真查（`fetchMinimaxSigninStatus` 失败时返回 null，
          // 由 helper 逐账号 try/catch 兜住，单账号失败不中断整体）。
          //
          // ⚠️ **判据是 `is_today && status===3`**（见 `minimaxPanelToCheckinStatus`），
          // 不是「没有 Claimable」。`active` 恒 true（拿到响应即 true）。
          const minimaxStatusAccounts = await pool.listAccounts(req.provider)
          const value = await collectCreditsStatus<MinimaxCredential, undefined>(
            minimaxStatusAccounts, undefined, {
              resolve: (ref) => ctx.credentials.resolve(ref),
              fetchStatus: (credential) => fetchMinimaxSigninStatus(credential),
              warn: (msg) => ctx.logger?.warn?.(msg),
            },
          )
          return { ok: true, value: { accounts: value } satisfies RpcCreditsStatusResponse }
        }
        const product = productById(req.provider)
        if (product === undefined) {
          return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } }
        }
        const accounts = await pool.listAccounts(req.provider)
        const results = await collectCreditsStatus(accounts, product, {
          resolve: (ref) => ctx.credentials.resolve(ref),
          warn: (msg) => ctx.logger?.warn?.(msg),
        })
        return { ok: true, value: { accounts: results } satisfies RpcCreditsStatusResponse }
      }

      // 一键领取：逐账号顺序执行（并发易触发风控），单个账号失败不中断整体。
      case 'credits.claimAll': {
        const req = payload as RpcCreditsClaimAllRequest
        const accounts = await pool.listAccounts(req.provider)
        if (isQoderFamily(req.provider)) {
          const { product } = requireQoderFamily(req.provider)
          // Qoder 的领取流程**自带活动列表查询**（loadCampaigns → 逐个 claim），
          // 故 precheckStatus: false 跳过外部那次检查 —— 否则会重复发一次 GET
          // （与 LobsterAI 传 false 的理由同类）。
          //
          // ⚠️ Qoder 的幂等判据是响应体的 `replayed:true`（重复领取同样返回
          // HTTP 200），已在 claimQoderCampaign 内部处理。
          const value = await collectClaimResults<QoderCredential, undefined>(accounts, undefined, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            claim: (credential) => claimQoderDailyCheckin(credential, product),
            precheckStatus: false,
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: value satisfies RpcCreditsClaimAllResponse }
        }
        if (req.provider === 'codearts') {
          // CodeArts（华为云）走**签名**协议，与两个腾讯系 provider 都不同源：
          // 领取流程自带「账户类型 + 活动列表」预检（见 claimCodeArtsDailyCheckin），
          // 故 precheckStatus: false 跳过外部那次 CodeBuddy 式的状态查询 ——
          // 用 fetchCheckinStatus 打华为端点既发错请求又必然失败。
          const value = await collectClaimResults<CodeArtsCredential, undefined>(accounts, undefined, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            claim: (credential) => claimCodeArtsDailyCheckin(credential),
            precheckStatus: false,
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: value satisfies RpcCreditsClaimAllResponse }
        }
        if (req.provider === LOBSTERAI.id) {
          // LobsterAI 的 clientVersion 是签到必填参数，需动态解析
          //（带缓存，通常无额外网络开销）。
          const clientVersion = await lobsterai.resolveClientVersion()
          const value = await collectClaimResults(accounts, LOBSTERAI, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            claim: (credential, product) =>
              claimLobsteraiDailyCheckin(credential, product, clientVersion),
            // 领取流程内部已做 slot/context 预检，不需要外部再查一次状态。
            precheckStatus: false,
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: value satisfies RpcCreditsClaimAllResponse }
        }
        if (req.provider === TRAE.id) {
          const value = await collectClaimResults<TraeCredential, undefined>(accounts, undefined, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            // ⚠️ **必须开启状态预检**（`precheckStatus` 默认为 true，不要传 false）。
            //
            // TRAE 的 claim 对「今天已签到」是**幂等**的：实测重复领取同样返回
            // `{code:0, message:"success"}`，与真正领取成功**无法区分**。
            // 早期照抄 LobsterAI 传了 `precheckStatus: false`（那是「领取流程内部
            // 已做 slot/context 预检」的理由，TRAE 没有这回事），于是已签到的账号
            // 被报成「领取成功」（用户报障：显示成功但 +0 积分）。
            // 判据只能是 status 端点的 `checked_in`。
            fetchStatus: (credential) =>
              fetchTraeCheckinStatus(credential as TraeCredential, TRAE, fetch),
            claim: (credential, _product, entry) =>
              claimTraeDailyCheckin(
                credential as TraeCredential,
                TRAE,
                fetch,
                pool.traeCheckinDeviceGenerationFor(entry.id),
                (next) => pool.updateTraeCheckinDeviceGeneration(entry.id, next),
              ),
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: value satisfies RpcCreditsClaimAllResponse }
        }
        if (req.provider === LOOMY.id) {
          // Loomy 的「签到」= `POST /points/first-login`（触发每日赠送额度）。
          // ⚠️ 语义**不是**「+5000 积分」：`dailyBalance = dailyQuota - dailyConsumed`，
          // 消耗后不回补。文案由 claimLoomyDailyQuota 的 already-claimed 表达。
          // 领取流程自带幂等判据（`alreadyProcessed`），故不做额外预检。
          const values: RpcCreditsClaimAccountResult[] = []
          for (const account of accounts) {
            const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef))
            if (!resolved) {
              values.push({
                accountId: account.id, nickname: account.nickname,
                outcome: { kind: 'failed', code: -1, message: '凭据未配置' },
              })
              continue
            }
            let credential: LoomyCredential
            try {
              credential = JSON.parse(resolved.value) as LoomyCredential
            } catch {
              values.push({
                accountId: account.id, nickname: account.nickname,
                outcome: { kind: 'failed', code: -1, message: '凭据解析失败' },
              })
              continue
            }
            const outcome = await loomy.claimDailyQuota(credential)
            values.push({ accountId: account.id, nickname: account.nickname, outcome })
          }
          return {
            ok: true,
            value: {
              summary: computeClaimSummary(values.map((v) => v.outcome)),
              results: values,
            } satisfies RpcCreditsClaimAllResponse,
          }
        }
        if (req.provider === CLINE.id) {
          // Cline **没有签到端点**（见 src/cline-credits.ts 的模块注释：
          // 对整个 sidecar 做字符串扫描，无任何 checkin/campaign 业务端点）。
          // 客户端按能力矩阵（`credits-capabilities.js` 的
          // `cline: { balance: true, dailyCheckin: false }`）根本不会渲染
          // 「一键领取积分」按钮、也不会发起本调用；这里显式返回可读错误，
          // 而不是落到下面 `productById` 的 `unsupported provider` 泛化文案
          // —— 后者会让排查者以为是「provider 没注册」，而真相是「该产品无此能力」。
          return {
            ok: false,
            error: {
              code: 'bad-request',
              message: 'Cline 不支持每日签到（其后端没有签到接口）',
            },
          }
        }
        if (req.provider === RACCOON.id) {
          // raccoon **没有签到端点**：每日 300 积分由服务端按日自动发放
          //（账单里的 `daily_grant`，实测注册后 1 分钟即到账），
          // 客户端按能力矩阵（`raccoon: { balance: true, onboardingTasks: true }`，
          // **无** `dailyCheckin`）根本不会渲染「一键领取积分」按钮、也不会发起本调用。
          // 这里显式返回可读错误，而不是落到下面 `productById` 的
          // `unsupported provider` 泛化文案 —— 后者会让排查者以为是
          //「provider 没注册」，而真相是「该产品无此能力」。
          return {
            ok: false,
            error: {
              code: 'bad-request',
              message: 'Raccoon Work 不支持每日签到（每日积分由服务端自动发放；登录奖励请在「新手任务」中领取）',
            },
          }
        }
        if (req.provider === MINIMAX.id) {
          // ⚠️ **必须开启状态预检**（`precheckStatus` 默认为 true，不要传 false）。
          //
          // 理由与 TRAE 那条同型（见上方 TRAE 分支的详细注释）：MiniMax 的
          // `claimMinimaxDailyCheckin` 靠响应体的 `claim_result` 判幂等
          //（`1`=真领取、`2`=已领过），这在 **HTTP 层**是可靠的；但状态预检是
          // 第二道防线 —— 若某天服务端对已领账号也回 `claim_result: 1`，
          // 预检能靠 `todayCheckedIn` 先挡住，避免把「今天已领」报成「+积分」。
          // 反之传 false 会让已签到账号走到 claim 请求（多发一次 POST）。
          const value = await collectClaimResults<MinimaxCredential, undefined>(accounts, undefined, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            fetchStatus: (credential) => fetchMinimaxSigninStatus(credential),
            claim: (credential) => claimMinimaxDailyCheckin(credential),
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: value satisfies RpcCreditsClaimAllResponse }
        }
        if (req.provider === ZCODE.id) {
          /**
           * ZCode 的「一键领取」= 补激活上报 → preview → 逐个 claim。
           *
           * ⚠ **每个 plan 都要重新产一个 captcha**（captcha 一次性，
           * 复用会得 `3007`）—— 故不能复用 `collectClaimResults`
           * 那套「一个凭据一次 claim」的形状（它假设 `claim()` 内部
           * 自己处理幂等），这里自己遍历账号与 plan。
           *
           * ⚠ ZCode **没有**独立的「今日是否已领」端点，故不调
           * `precheckStatus`（`claimDailyWith` **自带**激活上报与
           * preview 查询，重复调用只会多发一次无谓请求）。
           */
          const results: RpcCreditsClaimAllResponse['results'] = []
          const outcomes: ClaimOutcome[] = []
          for (const account of accounts) {
            const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef))
            let accountOutcomes: ClaimOutcome[]
            if (!resolved) {
              accountOutcomes = [{ kind: 'failed', code: -1, message: '凭据未配置' }]
            } else {
              let credential: ZcodeCredential | undefined
              try {
                credential = JSON.parse(resolved.value) as ZcodeCredential
              } catch {
                credential = undefined
              }
              if (credential === undefined) {
                accountOutcomes = [{ kind: 'failed', code: -1, message: '凭据解析失败' }]
              } else {
                /**
                 * captcha 回调：每次都现产一个新 param。
                 * 缺浏览器时抛错由 `claimDailyFor` 内部转成可读的
                 * failed outcome（不让整个端点失败）。
                 */
                accountOutcomes = await zcode.claimDailyFor(credential, async () => {
                  const config = await zcode.fetchCaptchaConfig().catch(() => undefined)
                  return await zcode.mintCaptcha(config)
                })
              }
            }
            // ⚠ 一个账号可能有多条 outcome（多个 plan）——
            // `RpcCreditsClaimAccountResult` 只装一条，故逐条展开。
            for (const outcome of accountOutcomes) {
              results.push({ accountId: account.id, nickname: account.nickname, outcome })
              outcomes.push(outcome)
            }
          }
          return {
            ok: true,
            value: { results, summary: computeClaimSummary(outcomes) } satisfies RpcCreditsClaimAllResponse,
          }
        }
        const product = productById(req.provider)
        if (product === undefined) {
          return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } }
        }
        const value = await collectClaimResults(accounts, product, {
          resolve: (ref) => ctx.credentials.resolve(ref),
          warn: (msg) => ctx.logger?.warn?.(msg),
        })
        return { ok: true, value: value satisfies RpcCreditsClaimAllResponse }
      }

      // 积分余额（Credits Balance）：逐账号顺序查询。
      //
      // 独立于 account.list 的原因：余额要为每个账号发一次网络请求，而
      // account.list 是打开面板就会调的轻量操作。混在一起会让账号列表被
      // 网络耗时拖慢，且一次查询失败会让整份列表都取不到。
      case 'credits.balances': {
        const req = payload as RpcCreditsBalancesRequest
        const accounts = await pool.listAccounts(req.provider)
        if (req.provider === 'codearts') {
          // 余额来自 `statistics/plugin`（与账户类型检测同一个响应），
          // 故用带原因的钩子：非积分账户要显示「Token 计费账户」而不是
          // 误导性的「余额查询失败」。
          const values = await collectCreditBalances<CodeArtsCredential, undefined>(accounts, undefined, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            fetchBalanceDetailed: async (credential) => {
              // 用带原因的版本：`fetchCodeArtsAccountInfo` 只回 null，会把
              // 「AK 限流」「签名失败」「凭据过期」压成同一句笼统文案，
              // 用户与排查者都拿不到线索（本端点就因此把一次 401 显示成了
              // 无信息量的「账户信息查询失败」）。
              const result = await fetchCodeArtsAccountInfoDetailed(credential)
              if (!result.ok) return { balance: null, error: `账户信息查询失败：${result.message}` }
              const info = result.info
              if (!info.isCreditPackage) {
                return {
                  balance: null,
                  error: info.isTokenPackage
                    ? 'Token 计费账户，无积分余额'
                    : '非积分计费账户，无积分余额',
                }
              }
              // 积分账户但没有 credit metric：如实报「无积分数据」，
              // 不显示成 0 —— 0 会让用户以为自己把积分用光了。
              if (info.credit === undefined) return { balance: null, error: '未返回积分数据' }
              return { balance: info.credit }
            },
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
        }
        if (req.provider === LOBSTERAI.id) {
          const values = await collectCreditBalances(accounts, LOBSTERAI, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            fetchBalance: (credential, product) => fetchLobsteraiCreditBalance(credential, product),
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          // ⚠️ LobsterAI 也回传窗口天数（用户报障「账号的积分没按长期、临时方式
          // 显示」）：它的每个资源包都带 `expiresAt`（已归一化到
          // `deductionEndTime`），面板要按到期远近分「长期 / 临时」。
          // 窗口语义与 buddy / TRAE 一致，共用同一个环境变量。
          return {
            ok: true,
            value: {
              accounts: values,
              windowDays: buddyExpiringWindowDays(),
            } satisfies RpcCreditsBalancesResponse,
          }
        }
        if (isQoderFamily(req.provider)) {
          const { product } = requireQoderFamily(req.provider)
          // 余额来自 `GET {product.openApiBase}/sash/api/v2/me/usage`（实测只需
          // Bearer + Cosy-ClientType，**不需要**模型列表那样的 WASM 签名）。
          // `fetchQoderCreditBalance` 只吃 QoderCredential，故这里不用
          // collectCreditBalances 的泛型（它会把产品配置转发给 fetchBalance）。
          const values: RpcCreditsBalancesResponse['accounts'] = []
          for (const account of accounts) {
            const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef))
            if (!resolved) {
              values.push({
                accountId: account.id, nickname: account.nickname,
                balance: null, error: '凭据未配置',
              })
              continue
            }
            let credential: QoderCredential
            try {
              credential = JSON.parse(resolved.value) as QoderCredential
            } catch {
              values.push({
                accountId: account.id, nickname: account.nickname,
                balance: null, error: '凭据解析失败',
              })
              continue
            }
            const balance = await fetchQoderCreditBalance(credential, product)
            values.push({
              accountId: account.id,
              nickname: account.nickname,
              balance,
              // 查不到时带上原因，卡片显示原因而非 0（与其它 provider 同约定）。
              ...balance === null ? { error: '积分查询失败（凭据失效或响应异常）' } : {},
            })
          }
          return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
        }
        if (req.provider === TRAE.id) {
          const values = await collectCreditBalances(accounts, TRAE, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            fetchBalance: (credential, product) => fetchTraeCreditBalance(credential as TraeCredential, product),
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          // ⚠️ TRAE 也回传窗口天数：它的资源包现在带 `deductionEndTime`
          // （条目级 `expire_time`，秒→毫秒），面板要按「长期 / 临时」分桶显示。
          // 没有窗口天数前端会拒绝渲染分类行（见 credit-expiry.js 的
          // normalizeWindowDays —— 非 buddy provider 不带该字段被视为
          // "没有作废维度"，这是防止凭空渲染假分类行的门禁）。
          // 窗口语义与 buddy 系一致：距到期不足 windowDays 的算「临时」。
          return {
            ok: true,
            value: {
              accounts: values,
              windowDays: buddyExpiringWindowDays(),
            } satisfies RpcCreditsBalancesResponse,
          }
        }
        if (req.provider === MINIMAX.id) {
          // 余额来自 `GET /minimax-cloud/api/v1/credit/details`。
          //
          // ⚠️ **该端点是平铺响应**（`total_count` 与 `base_resp` 同级、**没有
          // `data` 键**）—— 与签到端点不同。`fetchMinimaxCreditBalance` 内部已
          // 用 `unwrapEnvelopeData` 兼容两种形状。
          // ⚠️ 查不到时（null）由 helper 统一补「余额查询失败」文案，卡片显示
          // 原因而非 0 —— 这与「余额为 0」是**两回事**，不能混为一谈
          //（本机实测 `total_count: 0` 且 `details` 缺失正是「真的为 0」）。
          const values = await collectCreditBalances<MinimaxCredential, undefined>(accounts, undefined, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            fetchBalance: (credential) => fetchMinimaxCreditBalance(credential),
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
        }
        if (req.provider === CLINE.id) {
          // 余额来自 `GET /api/v1/users/{accountId}/balance`（实测
          // `{data:{userId, balance}, success:true}`）。与 Qoder 分支同因：
          // `fetchClineCreditBalance` 只吃 ClineCredential，故不用
          // collectCreditBalances 的泛型（它会把产品配置转发给 fetchBalance）。
          //
          // ⚠️ 账号 id 必须用凭据里的 `account_id`（`usr-…`），**不是** JWT 的
          // `sub`（`user_…`）—— 传后者实测返回 `400 Invalid request format`。
          const values: RpcCreditsBalancesResponse['accounts'] = []
          for (const account of accounts) {
            const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef))
            if (!resolved) {
              values.push({
                accountId: account.id, nickname: account.nickname,
                balance: null, error: '凭据未配置',
              })
              continue
            }
            let credential: ClineCredential
            try {
              credential = JSON.parse(resolved.value) as ClineCredential
            } catch {
              values.push({
                accountId: account.id, nickname: account.nickname,
                balance: null, error: '凭据解析失败',
              })
              continue
            }
            const result = await fetchClineCreditBalance(credential, CLINE)
            values.push({
              accountId: account.id,
              nickname: account.nickname,
              balance: result.balance,
              // 查不到时带上**具体原因**（含 HTTP 状态码与错误体摘要），
              // 而不是笼统一句「查询失败」—— 卡片显示原因而非 0
              //（0 是「已用光」的语义，会误导用户）。
              ...result.balance === null
                ? { error: result.error ?? '积分查询失败（凭据失效或响应异常）' }
                : {},
            })
          }
          return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
        }
        if (req.provider === LOOMY.id) {
          // 余额来自 `GET /points/records`（**只读**，无副作用）。
          // ⚠️ 刻意不用 `first-login`：那是**写**端点，在「打开面板」这种
          // 高频路径上调用会意外触发签到。
          const values: RpcCreditsBalancesResponse['accounts'] = []
          for (const account of accounts) {
            const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef))
            if (!resolved) {
              values.push({
                accountId: account.id, nickname: account.nickname,
                balance: null, error: '凭据未配置',
              })
              continue
            }
            let credential: LoomyCredential
            try {
              credential = JSON.parse(resolved.value) as LoomyCredential
            } catch {
              values.push({
                accountId: account.id, nickname: account.nickname,
                balance: null, error: '凭据解析失败',
              })
              continue
            }
            const balance = await loomy.fetchCreditBalance(credential)
            values.push({
              accountId: account.id,
              nickname: account.nickname,
              balance,
              // 查不到时带原因（不显示成 0，0 是「已用光」的语义）。
              ...balance === null ? { error: '积分查询失败（凭据失效或响应异常）' } : {},
            })
          }
          return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
        }
        if (req.provider === RACCOON.id) {
          // 余额来自 `GET /points/v1/balance`（**只读**，无副作用）。
          const values: RpcCreditsBalancesResponse['accounts'] = []
          for (const account of accounts) {
            const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef))
            if (!resolved) {
              values.push({
                accountId: account.id, nickname: account.nickname,
                balance: null, error: '凭据未配置',
              })
              continue
            }
            let credential: RaccoonCredential
            try {
              credential = JSON.parse(resolved.value) as RaccoonCredential
            } catch {
              values.push({
                accountId: account.id, nickname: account.nickname,
                balance: null, error: '凭据解析失败',
              })
              continue
            }
            const balance = await raccoon.fetchCreditBalance(credential)
            values.push({
              accountId: account.id,
              nickname: account.nickname,
              balance,
              // ⚠️ 查不到时带原因（**不显示成 0** —— 0 是「已用光」的语义，
              // 把「查询失败」显示成 0 会让用户以为自己积分没了）。
              ...balance === null ? { error: '积分查询失败（凭据失效或响应异常）' } : {},
            })
          }
          return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
        }
        if (req.provider === ZCODE.id) {
          /**
           * 余额来自 `GET /zcode-plan/billing/balance`（**只读**，无副作用）。
           *
           * ⚠ ZCode 的额度单位是 **token**，而 Jet Hub 这个字段的语义是
           * 「积分」。两者量纲不同 —— 但都要展示，故这里如实返回数值
           * 并在错误文案里说明来源。`balance: null` 表示**查不到**
           * （不显示成 0，0 是「已用光」的语义）。
           */
          const values: RpcCreditsBalancesResponse['accounts'] = []
          for (const account of accounts) {
            const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef))
            if (!resolved) {
              values.push({
                accountId: account.id, nickname: account.nickname,
                balance: null, error: '凭据未配置',
              })
              continue
            }
            let credential: ZcodeCredential
            try {
              credential = JSON.parse(resolved.value) as ZcodeCredential
            } catch {
              values.push({
                accountId: account.id, nickname: account.nickname,
                balance: null, error: '凭据解析失败',
              })
              continue
            }
            const result = await zcode.fetchBalanceFor(credential)
            if (result === undefined) {
              values.push({
                accountId: account.id, nickname: account.nickname,
                balance: null, error: '额度查询失败（凭据失效或网络异常）',
              })
              continue
            }
            if (result.enterprise === true) {
              // 企业版不下发额度数字、只给外部链接 —— 如实说明，不显示 0。
              values.push({
                accountId: account.id, nickname: account.nickname,
                balance: null, error: '企业版账号不下发额度数字，请在 ZCode 内查看',
              })
              continue
            }
            values.push({
              accountId: account.id,
              nickname: account.nickname,
              /**
               * ⚠ `CreditBalance` 的形状是 `{total, packages[], expiredTotal?}`
               * 这类**积分包**结构，而 ZCode 是「按日的 token 额度池」。
               * 两者结构不同，故这里用**一个包**如实映射：
               * `total` 填剩余额度、包名用上游的 `show_name`（模型名）。
               * 这样 UI 能显示数值与来源，且不伪装成多包积分账户。
               */
              balance: {
                total: result.remaining,
                // ZCode 不在同一响应里区分「已失效包」，故为 0。
                expiredTotal: 0,
                packages: [{
                  name: result.planName ?? 'ZCode 免费额度',
                  // ⚠ 单位是 **token**（不是 credit）—— 如实标注，
                  // 避免用户以为 ZCode 有 1 亿积分。
                  unit: 'token',
                  remaining: result.remaining,
                  total: result.total,
                  used: Math.max(0, result.total - result.remaining),
                  active: true,
                  // ZCode 的额度按日刷新（`period: 'one_time'` 的活动包到点失效），
                  // 故周期起止都留空，只用 `expiredTime` 给到期时刻。
                  cycleStartTime: '',
                  cycleEndTime: '',
                  expiredTime: result.expiresAt !== undefined
                    ? new Date(result.expiresAt * 1000).toISOString()
                    : '',
                }],
              },
            })
          }
          return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
        }
        const product = productById(req.provider)
        if (product === undefined) {
          return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } }
        }
        const values = await collectCreditBalances(accounts, product, {
          resolve: (ref) => ctx.credentials.resolve(ref),
          warn: (msg) => ctx.logger?.warn?.(msg),
        })
        // ⚠️ 只有 buddy 系会走到这里（`productById` 只认 CodeBuddy / WorkBuddy），
        // 而它们正是唯一需要「窗口天数」的 provider：面板要把资源包分成
        // 临时 / 永久两桶显示，窗口必须**由后端给出**（可被
        // DSH_BUDDY_EXPIRING_WINDOW_DAYS 覆盖），前端写死就会与选号判据分叉。
        return {
          ok: true,
          value: {
            accounts: values,
            windowDays: buddyExpiringWindowDays(),
          } satisfies RpcCreditsBalancesResponse,
        }
      }

      // ── 订阅额度（`subscriptionQuota.*`）：官方额度窗口 + 请求记录 ──
      //
      // 语义（答「各时间窗用掉百分之几」，与「余额」「请求记录」是三份互不
      // 相同的读数）。两个登记了 `subscriptionQuota` 能力位的 provider：
      //
      // - **cline**：Cline 网关自己的端点（`/users/me/plan/usage-limits`，
      //   参考实现 `github.com/codeOct/dsh-cline-pass`），窗口形状由网关下发；
      // - **antigravity**（非凭据型）：family 配额数据**已随 agy 账号条目缓存**
      //   （`ManagedAccount.quotas`，5h 滚动 + weekly 双窗，按 google/anthropic/
      //   openai 分组），这里只做形状映射、不发网络请求。
      //
      // ⚠️ 别的 provider 一律 `bad-request` —— 这正是「不要在 UI 上吞掉错误，
      // 而是不发起这个请求」那条既有约定的服务端一半（客户端另由
      // `supportsSubscriptionQuota` 门控）。
      case 'subscriptionQuota.get': {
        const req = payload as RpcClineQuotaRequest
        if (typeof req.provider !== 'string') {
          return { ok: false, error: { code: 'bad-request', message: 'provider 必填' } }
        }
        // ── antigravity：family 双窗 → 标准窗口形状 ──
        if (req.provider === ANTIGRAVITY_PROVIDER_ID) {
          const got = requireAgyService(antigravity)
          if (!got.ok) return { ok: false, error: got.error }
          const values: RpcClineQuotaResponse['accounts'] = []
          for (const account of got.svc.pool.getAccounts()) {
            const windows: Array<{ type: string; percentUsed: number; resetsAt: string }> = []
            for (const family of ANTIGRAVITY_FAMILY_ORDER) {
              // 能力矩阵登记三家 family（`antigravity-product.ts`）；agy 的 quotas
              // 按 ModelFamily 键控（含 unknown，不在展示序里）。
              const q = account.quotas?.[family as ModelFamily]
              if (!q) continue
              // ⚠️ 量纲换算：agy 给的是**剩余**比例（remainingFraction），
              // 标准窗口是**已用**百分比（percentUsed）。缺失（未查询过）的窗口
              // **如实跳过**，绝不显示 0%（那会误读成「额度已满」）。
              if (typeof q.remainingFraction === 'number') {
                windows.push({
                  type: `${family}:5h`,
                  percentUsed: Math.round((1 - q.remainingFraction) * 100),
                  // 无重置时刻给空串 —— 与 Cline 网关的既有约定一致（面板
                  // `quotaResetsIn` 对空串显示「—」）。
                  resetsAt: q.resetTime ?? '',
                })
              }
              if (typeof q.weeklyFraction === 'number') {
                windows.push({
                  type: `${family}:weekly`,
                  percentUsed: Math.round((1 - q.weeklyFraction) * 100),
                  resetsAt: q.weeklyResetTime ?? '',
                })
              }
            }
            values.push({
              accountId: account.id,
              nickname: account.email ?? account.alias,
              ok: true,
              windows,
            })
          }
          return { ok: true, value: { accounts: values } satisfies RpcClineQuotaResponse }
        }
        // ── cline：网关实时查询 ──
        if (req.provider !== CLINE.id) {
          return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${String(req.provider)}` } }
        }
        const accounts = await pool.listAccounts(req.provider)
        const values: RpcClineQuotaResponse['accounts'] = []
        for (const account of accounts) {
          const resolved = await ctx.credentials.resolve(credentialRef(account.credentialRef))
          if (!resolved) {
            values.push({
              accountId: account.id, nickname: account.nickname,
              ok: false, windows: [], error: '凭据未配置',
            })
            continue
          }
          let credential: ClineCredential
          try {
            credential = JSON.parse(resolved.value) as ClineCredential
          } catch {
            values.push({
              accountId: account.id, nickname: account.nickname,
              ok: false, windows: [], error: '凭据解析失败',
            })
            continue
          }
          const result = await fetchClineUsageLimits(credential, CLINE)
          values.push({
            accountId: account.id,
            nickname: account.nickname,
            ok: result.ok,
            windows: result.windows,
            // ⚠️ 失败时带上**具体原因**（含 HTTP 状态与网关文案），
            // 而不是笼统一句「查询失败」—— 面板要显示原因而非 0%。
            ...result.error === undefined ? {} : { error: result.error },
          })
        }
        return { ok: true, value: { accounts: values } satisfies RpcClineQuotaResponse }
      }

      case 'subscriptionQuota.requestLog': {
        const req = payload as RpcClineRequestLogRequest
        if (typeof req.provider !== 'string') {
          return { ok: false, error: { code: 'bad-request', message: 'provider 必填' } }
        }
        // antigravity **不提供逐笔请求记录**（官方网关无此数据）——如实返回
        // 空表 + 说明，而不是渲染一个「永远加载中」的假列表（与 credits.status
        // 对无签到渠道「如实返回 null」同一准则）。
        if (req.provider === ANTIGRAVITY_PROVIDER_ID) {
          return {
            ok: true,
            value: {
              rows: [],
              note: 'Antigravity 官方网关不提供逐笔请求记录；上方额度窗口为该账号的实时配额读数。',
            } satisfies RpcClineRequestLogResponse,
          }
        }
        if (req.provider !== CLINE.id) {
          return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${String(req.provider)}` } }
        }
        if (typeof req.accountId !== 'string' || req.accountId.trim().length === 0) {
          return { ok: false, error: { code: 'bad-request', message: 'accountId 不能为空' } }
        }
        // 记录是**本插件自己发出的请求流水**(进程内存,重启即丢,见
        // src/cline-request-log.ts),不是网关的 /usages —— 后者记的是该账号
        // 在官方所有渠道的消费:没有延迟/首块时间,表格字段也对不齐参考实现。
        //
        // ⚠️ `accountId` 必传(按账号过滤)——「订阅额度」面板用**同一个**
        // 翻页索引同时切额度窗口与请求记录,两个区域必须看同一个账号。
        // ⚠️ 记录可能是**失败**行(error 有值):失败的请求是排查
        // 「为什么没回复」的第一线索,与成功行同表展示、错误消息随行给出。
        return {
          ok: true,
          value: {
            rows: readClineRequestHistory({ accountId: req.accountId, limit: req.limit }).map((row) => ({
              ts: row.ts,
              model: row.model,
              // ⚠️ **优先用网关报的真实上游渠道**（`alibaba` 等，见
              // `src/cline-routing.ts`）；它没报时才回落到模型命名空间
              // （`cline-pass` / `cline-free`）—— 后者是**订阅通道**
              // （甚至可能是厂商名），不是 serving channel，用户报障点正在于此。
              upstream: row.upstream.length > 0 ? row.upstream : clineUpstreamOf(row.model),
              // ⚠️ 必须透传「是否收到 usage」：表格据此把未知显示成 `—`,
              // 而不是 0（0 会被读成「瞬间完成、没花 token」）。
              usageReported: row.usageReported,
              inputTokens: row.inputTokens,
              outputTokens: row.outputTokens,
              ...row.cacheReadTokens !== undefined ? { cacheReadTokens: row.cacheReadTokens } : {},
              ...row.reasoningTokens !== undefined ? { reasoningTokens: row.reasoningTokens } : {},
              // 推理强度：空串也照传（展示层据「空串 ⇒ 不渲染那一行」判断，
              // 若在这里省略字段，前端就得同时处理 undefined 与 '' 两种缺省）。
              effort: row.effort,
              ttftMs: row.ttftMs,
              // ⚠️ 首个**正文**块耗时必须透传：展示层的「输出速率」拿它当分母
              // 起点（分子是正文 token 数）。缺了它速率会虚高到物理不可能的值
              // —— 用户报障的 `11814.8 t/s` 就是分子分母跨阶段的产物。
              ttfcMs: row.ttfcMs,
              totalMs: row.totalMs,
              ...row.error !== undefined ? { error: row.error } : {},
            })),
          } satisfies RpcClineRequestLogResponse,
        }
      }

      // ── 模型列表可见性（黑名单开关）──
      //
      // 列表来自 `ctx.llm.listModels()`——**适配器播报的权威目录**，正是
      // 对话框模型选择器读的同一份数据（会话控制器的 buildModelCatalog）。
      // 这样设置页展示的模型集合与实际可选集合永远一致，不会出现
      // 「设置在某个模型上，选择器里却找不到它」。
      case 'model.list': {
        const req = payload as RpcModelListRequest
        const llm = llmServiceOf(ctx)
        if (llm === undefined) {
          return { ok: false, error: { code: 'bad-request', message: 'llm 服务不可用' } }
        }
        let models: Array<{ id: string; name: string }>
        try {
          models = await llm.listModels(req.provider)
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          return { ok: false, error: { code: 'bad-request', message: `读取模型列表失败：${reason}` } }
        }
        // 黑名单直接读账号池的进程内副本：开关写入后无需重建适配器，
        // 下一次 listModels 就会应用新的过滤结果。
        const disabledMap = pool.listDisabledModels(req.provider)
        // ⚠️ `llm.listModels()` 返回的目录**已被适配器过滤掉黑名单**：所有适配器
        // 的 listModels 内部都会实时 `filter(m => !disabledModelsFor(provider).has(m.id))`。
        // 若直接对这个结果回填 disabled，就形成闭环矛盾——`disabledMap` 里的键恰好是
        // `models` 中已被移除的那些元素，`.map()` 永远匹配不到它们，被关闭的
        // 模型连同它的开关一起从设置页消失，用户**再也无法重新打开**（只能手工
        // 编辑 settings.yaml）。这正是「关掉后彻底找不到该模型」的根因。
        //
        // 因此设置页的目录必须以**未过滤**的全量为准：
        // - 优先用适配器提供的 `listAllModels()`（不套黑名单，且带**最终展示名**，
        //   含倍率与同名消歧）；
        // - 它不存在时（外部/旧适配器）退化为「listModels 结果 + 黑名单补回裸 id」，
        //   此时关闭项只能显示 id（历史行为）。
        //
        // ⚠️ 展示名必须来自**不套黑名单**的全量目录而非裸 id：用户报障
        // 「关闭的就没有显示倍率，关闭的应该也显示倍率」—— 根因正是补回时只有
        // id 可用。适配器实例由 `registerJetHubRpc` 的 `modelAdapters` 传入
        // （DSH 的 `ctx.llm` 只保证 `listModels`，不透传自定义方法）。
        // 对话框模型选择器读的仍是过滤后的 `listModels`，可见性行为完全不变。
        const catalogSource = modelAdapters?.[req.provider]
        const all = catalogSource?.listAllModels()
        let catalog: Array<{ id: string; name: string; isFree?: boolean }>
        if (all !== undefined) {
          catalog = [...all]
          // 全量目录里若仍有黑名单命中却缺失者，一并补上（保底，正常不会发生）。
          const known = new Set(catalog.map((model) => model.id))
          for (const id of Object.keys(disabledMap)) {
            if (disabledMap[id] === true && !known.has(id)) catalog.push({ id, name: id })
          }
        } else {
          const listedIds = new Set(models.map((model) => model.id))
          const filteredOut = Object.keys(disabledMap)
            .filter((id) => disabledMap[id] === true && !listedIds.has(id))
          catalog = [
            ...models.map((model) => ({ id: model.id, name: model.name })),
            // 这些模型已被适配器过滤掉，拿不到原始 name，回退为 id。
            ...filteredOut.map((id) => ({ id, name: id })),
          ]
        }
        const value: RpcModelListResponse = {
          models: catalog.map((model) => ({
            id: model.id,
            name: model.name,
            disabled: disabledMap[model.id] === true,
            // ⚠️ 免费标记**照原样透传，缺失就不写**（不编造 `false`）：Jet Hub 的
            // 模型列表按「计费/来源」分组，把「适配器没报」当成「按量计费」是
            // 保守归组，但字段本身仍保持「未知」语义（与全仓约定一致）。
            ...model.isFree === undefined ? {} : { isFree: model.isFree },
          })),
        }
        return { ok: true, value }
      }

      // 打开/关闭某个模型。写入后**不重建适配器**：适配器的 listModels 每次
      // 都直接读账号池的黑名单，因此下一次调用即返回新目录。
      //
      // ⚠️ 但「适配器立刻返回新目录」**不等于**「界面立刻更新」—— 客户端把
      // `modelCatalog` 的响应缓存在带 `status === 'ready'` 短路的 store 里，
      // 只在转发事件上失效（详见下方 emit 的注释）。不广播就等于开关只写进了
      // 磁盘、界面一直显示旧目录。
      case 'model.setDisabled': {
        const req = payload as RpcModelSetDisabledRequest
        if (typeof req.provider !== 'string' || typeof req.modelId !== 'string' || req.modelId.length === 0) {
          return { ok: false, error: { code: 'bad-request', message: 'provider 与 modelId 必填' } }
        }
        await pool.setModelDisabled(req.provider, req.modelId, req.disabled === true)
        ctx.logger.info(
          `[jet-hub] ${req.disabled === true ? '关闭' : '打开'}模型 ${req.provider}/${req.modelId}`,
        )
        // 必须广播：否则开关只写进磁盘、界面一直显示旧目录（成因见该函数注释）。
        broadcastCatalogChanged(ctx)
        const value: RpcModelSetDisabledResponse = {
          provider: req.provider,
          disabledModels: pool.listDisabledModels(req.provider),
        }
        return { ok: true, value }
      }

      /**
       * 批量打开/关闭**指定的一批**模型（Jet Hub 模型列表里「按分组」的
       * 本组全开 / 本组全关）。
       *
       * ⚠️ **不能复用 `model.setAllDisabled`**：那个的范围是「该 provider 的
       * 全部模型」，且打开方向会清空整张黑名单（含用户特意关着的其它组）。
       * 分组开关只动本组的 id，故服务端需要一个「按子集清除」的路径
       * （`AccountPool.clearModelsDisabled`）。
       *
       * 与另外两个开关端点同约定：`disabled` 不做默认值猜测、只落盘一次、
       * 只广播一次（逐条调用会写 N 次文档、广播 N 次）。
       */
      case 'model.setDisabledMany': {
        const req = payload as RpcModelSetDisabledManyRequest
        if (
          typeof req.provider !== 'string' || req.provider.length === 0
          || !Array.isArray(req.modelIds)
          || typeof req.disabled !== 'boolean'
        ) {
          return {
            ok: false,
            error: { code: 'bad-request', message: 'provider、modelIds（数组）与 disabled（布尔）必填' },
          }
        }
        // 去重 + 剔除非字符串/空串：前端按组传 id，重复项或脏值只会白写一次文档。
        const ids = [...new Set(req.modelIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
        if (ids.length === 0) {
          return { ok: false, error: { code: 'bad-request', message: 'modelIds 不能为空' } }
        }
        if (req.disabled) await pool.setModelsDisabled(req.provider, ids)
        else await pool.clearModelsDisabled(req.provider, ids)
        ctx.logger.info(
          `[jet-hub] ${req.disabled ? '关闭' : '打开'} ${req.provider} 的 ${ids.length} 个模型（按分组）`,
        )
        // 与其它开关端点一致：必须广播，否则界面一直显示旧目录。
        broadcastCatalogChanged(ctx)
        const value: RpcModelSetDisabledManyResponse = {
          provider: req.provider,
          disabledModels: pool.listDisabledModels(req.provider),
        }
        return { ok: true, value }
      }

      /**
       * 批量打开/关闭某 provider 的全部模型（Jet Hub 模型列表的
       * 「打开全部 / 关闭全部」）。
       *
       * 两个方向的语义**刻意不对称**（需求明确规定）：
       *
       * - `disabled: true`（关闭全部）：按**当前目录**逐项加入黑名单，故需要读
       *   模型目录。目录优先取适配器的 `listAllModels()`（不套黑名单的全量目录，
       *   与 `model.list` 同源），缺失时退化为 `llm.listModels()`。
       * - `disabled: false`（打开全部）：直接清空该 provider 的黑名单条目，
       *   **不读目录** —— 这样「曾被关闭、后来从服务端目录里下线」的历史遗留键
       *   才能被清掉（按目录删的话它们永远留在配置里）。
       *
       * 为什么不做成前端循环调用 `model.setDisabled`：那会发 N 次请求、写 N 次
       * 完整文档、广播 N 次 `llm/adapters-updated`，且中途失败会留下「关了一半」
       * 的黑名单。批量端点只落盘一次、只广播一次。
       */
      case 'model.setAllDisabled': {
        const req = payload as RpcModelSetAllDisabledRequest
        // ⚠️ `disabled` **不做默认值猜测**：缺失或非布尔一律拒绝。默认成 true 会
        // 让一次字段名写错的前端改动静默关闭用户全部模型；默认成 false 则反向
        // 静默打开 —— 两个方向都是灾难性且难察觉的。
        if (typeof req.provider !== 'string' || typeof req.disabled !== 'boolean') {
          return {
            ok: false,
            error: { code: 'bad-request', message: 'provider 与 disabled（布尔）必填' },
          }
        }
        if (req.disabled) {
          // 关闭全部：先取全量目录，再一次性写入黑名单。
          // 目录读取的三条分支（适配器 → llm → 失败即拒绝）与「关闭供应商」
          // 完全一致，故共用 fullCatalogIds；⚠️ 失败时**不落盘** ——
          // 否则会写入一个不完整的黑名单，用户看到「关了一半」且无从判断原因。
          const catalog = await fullCatalogIds(ctx, modelAdapters, req.provider)
          if ('error' in catalog) {
            return { ok: false, error: { code: 'bad-request', message: catalog.error } }
          }
          await pool.setModelsDisabled(req.provider, catalog.ids)
          ctx.logger.info(`[jet-hub] 关闭 ${req.provider} 的全部 ${catalog.ids.length} 个模型`)
        } else {
          // 打开全部：纯本地操作，不读目录 —— 目录故障时用户仍应能把开关全打开。
          await pool.clearDisabledModels(req.provider)
          ctx.logger.info(`[jet-hub] 打开 ${req.provider} 的全部模型`)
        }
        // 只广播一次：批量不等于逐条广播。
        broadcastCatalogChanged(ctx)
        const value: RpcModelSetAllDisabledResponse = {
          provider: req.provider,
          disabledModels: pool.listDisabledModels(req.provider),
        }
        return { ok: true, value }
      }

      /**
       * 读取多个供应商的汇总状态（Jet Hub 左侧导航分组 + 一键开关据此渲染）。
       *
       * 为什么一次取全部：8 个供应商若逐个查，就是 16 次往返，且每次都要走
       * 异步凭据解析。这里**全程只用同步的内存副本**，不产生任何网络请求：
       * - 模型目录用 `modelAdapters[provider].listAllModels()`（同步；它内部
       *   在冷缓存时会**后台**补拉，但不阻塞本次返回）；
       * - 账号用 `pool.listAccountsByProvider()`（同步读内存）。
       *
       * ⚠️ **不得**改用 `pool.listAccounts()` —— 那个方法会对每个账号调
       * `credentials.describe()`（异步 IO），8 个供应商逐个解析凭据会明显
       * 拖慢设置页首屏，而我们**只需要计数**，不需要凭据状态。
       *
       * 适配器缺失（外部/旧适配器）时 `total = 0`、`closed = false`：
       * 保守判为「未关闭」，让用户可以尝试操作，而不是误报成已关闭。
       */
      case 'provider.status': {
        const req = payload as RpcProviderStatusRequest
        if (!Array.isArray(req.providers) || req.providers.some((id) => typeof id !== 'string')) {
          return { ok: false, error: { code: 'bad-request', message: 'providers 必须是字符串数组' } }
        }
        const statuses: Record<string, ProviderStatus> = {}
        for (const provider of req.providers) {
          // 空 id 不进结果：它不可能对应任何 provider，留着只会让前端多一个
          // 无意义的键（前端按 PROVIDERS 取，多出来的键会被忽略，但脏数据不该产生）。
          if (provider.length === 0) continue
          const catalog = modelAdapters?.[provider]?.listAllModels()
          const total = catalog?.length ?? 0
          // ⚠️ `listAllModels()` **不带 disabled 字段**，故必须另取黑名单再按 id 计数。
          const disabledMap = pool.listDisabledModels(provider)
          let disabled = 0
          if (catalog !== undefined) {
            for (const model of catalog) {
              // 与 `disabledModelsFor` 的判定对齐：只有显式 true 才算已关闭。
              if (disabledMap[model.id] === true) disabled++
            }
          }
          /**
           * 账号计数。
           *
           * Antigravity **不在本插件的账号池里**（本池是凭据型 ref 账号），
           * 它的账号是隔离 HOME 目录、由本仓库自实现的 `AntigravityService`
           * 管理（`~/.dsh/agy-accounts/pool.json`）。直接读该服务的 pool。
           */
          let accountStats: { total: number; enabled: number }
          if (provider === ANTIGRAVITY_PROVIDER_ID) {
            const got = requireAgyService(antigravity)
            if (got.ok) {
              const accs = got.svc.pool.getAccounts()
              accountStats = {
                total: accs.length,
                enabled: accs.filter((a) => a.enabled).length,
              }
            } else {
              accountStats = { total: 0, enabled: 0 }
            }
          } else if (provider === DOUBAO_PROVIDER_ID) {
            const got = requireDoubaoService(doubao)
            if (got.ok) {
              const status = got.svc.getStatus()
              const count = status.allUsers?.length || (status.currentUser ? 1 : (status.installed ? 1 : 0))
              accountStats = {
                total: count,
                enabled: count > 0 && status.currentUser?.enable !== false ? count : 0,
              }
            } else {
              accountStats = { total: 0, enabled: 0 }
            }
          } else {
            const entries = pool.listAccountsByProvider(provider)
            accountStats = {
              total: entries.length,
              // 与适配器一致的判据：`enabled !== false` 视为启用
              //（老文档可能缺该字段，缺省语义等同启用）。
              enabled: entries.filter((entry) => entry.enabled !== false).length,
            }
          }
          statuses[provider] = {
            // antigravity 的模型目录来自 `modelAdapters.antigravity.listAllModels()`
            // （本仓库 `AntigravityAdapter`，不受黑名单影响的全量目录）。
            // 与账号数一样，黑名单/启停现在都真实生效 —— 早期「故意 total=0
            // 以禁用供应商开关」的做法随自实现移除（开关已真）。
            models: { total, disabled },
            accounts: accountStats,
            closed: total > 0 && disabled === total,
          }
        }
        const value: RpcProviderStatusResponse = { statuses }
        return { ok: true, value }
      }

      /**
       * 供应商级一键开关（Jet Hub 左侧每个供应商行尾的开关）。
       *
       * ## 语义（用户已确认）
       *
       * - `enabled: false`（关闭）= **关闭它的全部模型** + **停用它的全部账号**；
       * - `enabled: true`（打开）= 清空它的模型黑名单 + 启用它的全部账号。
       *
       * ## ⚠️ 关闭方向的顺序不可颠倒：先关模型，再停账号
       *
       * 「是否已关闭」的判据是**模型是否全关**（见 `provider.status` 的 `closed`）。
       * 先关模型可保证：即使随后停账号失败，状态判定依然自洽（该供应商确实已关闭），
       * 用户重试一次即可补齐账号。反过来先停账号、再关模型，中途失败会留下
       * 「账号全停用但模型仍可见」的中间态 —— 用户在对话框里还能选到它的模型，
       * 却没有任何可用账号，这正是本次要消除的落差。
       *
       * ## ⚠️ 「不关闭模型就不关闭供应商」
       *
       * 关闭方向必须拿到模型目录：读失败、或目录**为空**时**整个操作失败**，
       * 既不落盘也不广播。绝不能「关不掉模型就只停账号」—— 那会让供应商
       * 显示成已关闭而模型其实还在，用户按关闭的预期却仍能选到它。
       *
       * ## 打开方向不读目录
       *
       * 与 `model.setAllDisabled` 的「打开全部」同理：直接清空黑名单，这样
       * 「曾被关闭、后来从服务端目录下线」的历史遗留键才能被清掉；且目录故障时
       * 用户仍应能把开关全打开。
       */
      case 'provider.setEnabled': {
        const req = payload as RpcProviderSetEnabledRequest
        // ⚠️ `enabled` 不做默认值猜测：缺失或非布尔一律拒绝。默认成 true 会静默
        // 打开用户特意关闭的供应商；默认成 false 则反向静默关闭 —— 两个方向都是
        // 灾难性且难察觉的（与 model.setAllDisabled 同约定）。
        if (typeof req.provider !== 'string' || req.provider.length === 0 || typeof req.enabled !== 'boolean') {
          return {
            ok: false,
            error: { code: 'bad-request', message: 'provider 与非空布尔 enabled 必填' },
          }
        }
        let modelCount = 0
        if (req.enabled) {
          // 打开：清空黑名单（返回被清掉的条目数，供提示）。null 表示本就无关闭项。
          const cleared = pool.listDisabledModels(req.provider)
          await pool.clearDisabledModels(req.provider)
          modelCount = Object.keys(cleared).length
        } else {
          const catalog = await fullCatalogIds(ctx, modelAdapters, req.provider)
          if ('error' in catalog) {
            // 目录读不出来 → 整个关闭操作失败，**不落盘、不广播**。
            return { ok: false, error: { code: 'bad-request', message: catalog.error } }
          }
          if (catalog.ids.length === 0) {
            // 「不关闭模型就不关闭供应商」的落点。
            return {
              ok: false,
              error: { code: 'bad-request', message: '该供应商没有可关闭的模型，未做任何变更' },
            }
          }
          await pool.setModelsDisabled(req.provider, catalog.ids)
          modelCount = catalog.ids.length
        }
        // 账号状态**在模型之后**处理（顺序理由见上）。返回实际变更数，
        // 已是目标状态的账号不计入，避免提示夸大成「已停用 N 个」。
        // antigravity：账号不在本插件池（非凭据型：在 agy 池），同步启停写它。
        let accountCount: number
        if (req.provider === ANTIGRAVITY_PROVIDER_ID) {
          const agyGot = requireAgyService(antigravity)
          if (!agyGot.ok) return { ok: false, error: agyGot.error }
          accountCount = 0
          for (const acc of agyGot.svc.pool.getAccounts()) {
            if (agyGot.svc.pool.setAccountEnabled(acc.id, req.enabled)) accountCount++
          }
        } else if (req.provider === DOUBAO_PROVIDER_ID) {
          accountCount = 0
        } else {
          accountCount = await pool.setAccountsEnabled(req.provider, req.enabled)
        }
        // 两个方向都改变 listModels 的结果（关/开黑名单），**必须广播**，
        // 否则对话框的模型选择器要重启才更新（成因见 broadcastCatalogChanged）。
        broadcastCatalogChanged(ctx)
        ctx.logger.info(
          `[jet-hub] ${req.enabled ? '打开' : '关闭'}供应商 ${req.provider}：`
          + `${req.enabled ? '清空' : '写入'} ${modelCount} 个模型、`
          + `${req.enabled ? '启用' : '停用'} ${accountCount} 个账号`,
        )
        const value: RpcProviderSetEnabledResponse = {
          provider: req.provider,
          enabled: req.enabled,
          models: modelCount,
          accounts: accountCount,
        }
        return { ok: true, value }
      }

      // ── 账号备份（导出 / 导入）──
      //
      // 目的：更换 DSH 版本时迁移账号凭据。备份文件是**自包含**的 JSON
      // （账号索引 + 凭据原文 + 模型黑名单，见 src/backup.ts），与 DSH 版本
      // 无关 —— 导入时按**当前版本**的存储契约重建，天然跨版本。
      //
      // 安全约定：加密在浏览器侧完成（PBKDF2 + AES-GCM），RPC 只接收/返回
      // 明文载荷；明文 JSON 不经过本层持久化与日志。
      case 'backup.export': {
        const result = await exportBackup(pool, ctx.credentials)
        const value: RpcBackupExportResponse = {
          payload: result.payload,
          warnings: result.warnings,
        }
        return { ok: true, value }
      }

      // 导入 = 整体替换（还原快照，不是合并）。写入顺序刻意「先凭据、后账号池」：
      // 账号池整体替换成功后，门控（hasLoggedInAccount）与黑名单立即反映新状态；
      // 若凭据写入中途失败（非法 ref 等），只跳过该条、不中断整体。
      case 'backup.import': {
        const req = payload as RpcBackupImportRequest
        const result = await importBackup(ctx.credentials, pool, req.payload)
        // 导入会改变账号集合（门控依赖 hasLoggedInAccount）与模型黑名单，
        // 必须广播目录变更，否则界面仍显示旧目录。
        broadcastCatalogChanged(ctx)
        const value: RpcBackupImportResponse = {
          credentialsImported: result.credentialsImported,
          accountsImported: result.accountsImported,
          skipped: result.skipped,
          expiredAccounts: result.expiredAccounts,
          missingCredentials: result.missingCredentials,
        }
        return { ok: true, value }
      }

      // 账号池统计（导入前的覆盖提示用）：缺 expiresAt 的条目疑似 DSH 版本
      // 切换后自动恢复的产物（反推不读凭据值，故无有效期）。前端据此在
      // 确认导入前提示用户「有 N 个自动恢复的账号将被整体覆盖」。
      case 'backup.status': {
        const state = pool.getStateSnapshot()
        const value: RpcBackupStatusResponse = {
          accounts: state.accounts.length,
          withoutExpiry: state.accounts.filter((entry) => entry.expiresAt === undefined).length,
        }
        return { ok: true, value }
      }

      default:
        return { ok: false, error: { code: 'bad-request', message: `unknown method: ${method}` } }
    }
  }
}

/** 构造带 rpcId 的响应 JSON */
function reply(rpcId: string, result: unknown): Response {
  const value = typeof result === 'object' && result !== null && (result as Record<string, unknown>).ok === false
    ? { ...result as Record<string, unknown>, error: { ...(result as Record<string, unknown>).error as Record<string, unknown>, details: {} } }
    : result
  return Response.json({ type: 'server-response', rpcId, result: value })
}
