/**
 * 每日自动签到 —— 纯判据 + 执行器。
 *
 * ## 它解决什么
 *
 * 本插件此前只有**手动**入口：Jet Hub 页头的「一键签到」按钮
 * （客户端串行调用 `credits.claimAll`）。于是「每天记得点一下」成了用户的
 * 责任 —— 而这件事的收益是**当天不领就作废**的额度，漏一天就是真损失。
 *
 * 现在：**打开 DSH 时自动跑一次**（用户 2026-10-13 定的时机），面板有开关
 * （默认开启）并显示上次结果。
 *
 * ## 为什么是「打开时」而不是「每天固定钟点」
 *
 * 定时器只在本进程存活期间有效，而 DSH 不是常驻服务：用户关机 / 关掉 GUI 的
 * 那段时间里没有任何进程能触发签到。若做成「每天 10:05 跑」，实际行为会退化成
 * 「恰好 10:05 那一刻 DSH 开着才签」—— 比「打开就签」**更不可靠**，却让用户
 * 以为它是准时的。
 *
 * ⚠️ 代价是**必须自己记住「今天签过了」**，否则一天开关十几次就会签十几次。
 * 闸门见 {@link decideAutoCheckin}。
 *
 * ## 闸门（用户 2026-10-13 定）
 *
 * | 情形 | 行为 |
 * |---|---|
 * | 开关关闭 | 不执行（`disabled`） |
 * | 当天已**成功签完** | 不执行（`done`） |
 * | 当天有失败 / 暂无活动项 | **下次打开 DSH 再试**，当天最多 {@link AUTO_CHECKIN_MAX_ATTEMPTS_PER_DAY} 次 |
 * | 当天已达次数上限 | 不执行（`exhausted`） |
 * | 跨到新的一天（UTC+8） | 计数归零，重新可签 |
 *
 * ⚠️ **「成功」的定义里包含 `inactive`（暂无活动）**，这是刻意的：多数活动
 * **每日 10:00（UTC+8）刷新**（Qoder 的活动原始文案即「每日 10:00（UTC+8）
 * 刷新」）。若用户在 09:30 打开 DSH，服务端此时回的就是 `inactive`；把它算作
 * 「已完成」，用户当天就**再也签不到**了 —— 而那正是本功能要消灭的漏签。
 */

import type { RpcCreditsClaimSummary } from './types.js'

/**
 * 服务端账期的时区偏移：**写死 UTC+8**，不取本机时区。
 *
 * ⚠️ 与 Qoder 额度标记（`QODER_BILLING_UTC_OFFSET_MS`）同一条理由：额度是
 * **服务端**按自己的账期结算的（Qoder 的活动文案直接写明 UTC+8）。取本机时区
 * 会在用户出差 / 改系统时区时算出**错的日界**：偏东则当天闸门过早失效（重复
 * 签到），偏西则白等几小时（该签的时候不签）。
 *
 * ⚠️ 时区**不可能对所有渠道都正确**（MiniMax 明确按**客户端上报的时区**结算，
 * 见 `src/minimax-credits.ts`）。这里的取舍是：本常量只用于**「今天要不要跑」
 * 这个本地闸门**，不参与任何请求参数 —— 判错的最坏后果是多跑或少跑一次，
 * 且服务端对重复领取一律幂等。真要做对，得给每家各配一个时区，那是另一件事。
 */
export const AUTO_CHECKIN_UTC_OFFSET_MS = 8 * 60 * 60 * 1000

/**
 * 同一自然日内最多自动尝试次数（用户 2026-10-13 定 3 次）。
 *
 * 存在的意义是给「永久性失败」兜底：凭据失效 / 账号被风控的渠道每次都失败，
 * 没有上限时用户每开一次 DSH 就会对它们发一轮必然失败的请求。
 */
export const AUTO_CHECKIN_MAX_ATTEMPTS_PER_DAY = 3

/**
 * 参与自动签到的渠道（**顺序即执行顺序**）。
 *
 * ⚠️ **必须与客户端能力表 `plugin-src/client/credits-capabilities.js` 的
 * `checkinProviders()` 逐条一致** —— 那张表是「哪些渠道支持每日签到」的唯一
 * 真相源（`dailyCheckin: true`），漏一个的后果是「该渠道永远不被自动签到」，
 * 多一个的后果是「每天对它发必然失败的请求」（正是 CodeArts 早期
 * 「对不支持的 provider 无条件发请求」那一类缺陷）。
 *
 * host 侧**无法直接 import 那份表**：它在 `plugin-src/`（客户端纯 JS，独立
 * 打包，不参与 tsc 构建）。故这里列一份，并由
 * `tests/unit/auto-checkin.spec.ts` 的「能力表对账」用例**读取那个文件**逐条
 * 比对 —— 漂移会当场变红，而不是等到用户发现「某渠道没自动签」。
 *
 * 顺序说明：与能力表声明顺序一致（codearts → … → zcode）。刻意**不**把
 * zcode 排到最后之外做特殊处理 —— 它是唯一要拉起 chromium 过 captcha 的
 * 渠道，慢且重，但「跳过它」会让用户少领一份额度。
 */
export const AUTO_CHECKIN_PROVIDERS: readonly string[] = Object.freeze([
  'codearts',
  'buddy',
  'lobsterai',
  'qoder',
  'qodercn',
  'trae',
  'loomy',
  'minimax',
  'teleagent',
  'zcode',
])

/** 单个渠道在一次自动签到里的结果（**不含凭据内容**，可安全落盘 / 回传面板）。 */
export interface AutoCheckinChannelResult {
  provider: string
  /** 该渠道是否执行成功（拿到响应）。`false` 时看 {@link AutoCheckinChannelResult.error}。 */
  ok: boolean
  /** `ok === false` 时的原因（单行文案）。 */
  error?: string
  /** `ok === true` 时的领取汇总。 */
  summary?: RpcCreditsClaimSummary
}

/** 持久化的自动签到状态（结构变化时须同步 `auto-checkin-store.ts` 的 sanitize）。 */
export interface AutoCheckinState {
  /** 开关（默认 `true`，用户可在面板关闭）。 */
  enabled: boolean
  /**
   * 上次执行所属的 **UTC+8 自然日**（`YYYY-MM-DD`）。
   *
   * `null` 表示从未执行过。与「今天」比较即得「是否是新的一天」。
   */
  day: string | null
  /** {@link AutoCheckinState.day} 那一天已尝试的次数。 */
  attempts: number
  /**
   * {@link AutoCheckinState.day} 那一天是否**已成功签完**（判据见
   * {@link channelNeedsRetry}）。
   *
   * ⚠️ 只有它是「当天不必再签」的**唯一**依据 —— 不要用 `attempts > 0` 代替：
   * 那会让「09:30 打开时活动还没刷新」变成「今天再也不签」。
   */
  succeeded: boolean
  /** 最近一次执行的完成时刻（epoch ms）；`null` 表示从未执行过。 */
  lastRunAt: number | null
  /** 最近一次执行的**逐渠道**结果（面板据此渲染摘要）。 */
  lastResults: AutoCheckinChannelResult[]
}

/** 跳过原因（面向用户可读文案，见 README 的对应章节）。 */
export type AutoCheckinSkipReason =
  /** 开关关闭。 */
  | 'disabled'
  /** 当天已成功签完。 */
  | 'done'
  /** 当天尝试次数已达上限。 */
  | 'exhausted'
  /** 有渠道正在执行（重入保护）。 */
  | 'running'

/** 「要不要跑」的判据结果。 */
export type AutoCheckinDecision =
  | { run: true; day: string; attemptsToday: number }
  | { run: false; reason: AutoCheckinSkipReason; day: string }

/**
 * 取某时刻所属的 **UTC+8 自然日**键（`YYYY-MM-DD`）。
 *
 * ⚠️ **必须用「算术偏移 + `getUTC*`」**，不能用 `getFullYear()` / `toLocaleDateString()`
 * 之类：那些按**本机时区**运算，在非 UTC+8 的机器上会算出错的日界
 * （与 `nextUtc8DayStartMs` 同一条教训）。
 */
export function utc8DayKey(ms: number): string {
  const shifted = new Date(ms + AUTO_CHECKIN_UTC_OFFSET_MS)
  const year = shifted.getUTCFullYear()
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 该渠道是否「还需要重试」。
 *
 * ⚠️ 三种情形都算需要重试，缺一不可：
 * - `ok === false`：整渠道执行失败（凭据未配置、不支持、抛异常）；
 * - `failed > 0`：有账号失败（凭据过期、网络异常）；
 * - `inactive > 0`：**暂无活动** —— 见模块头「为什么它算未完成」。
 *
 * `claimed` / `alreadyClaimed` 都不需要重试（一个刚领到、一个今天已领）。
 * 渠道**没有账号**时三项全为 0 ⇒ 不需要重试（不该每天对一个空渠道空转）。
 */
export function channelNeedsRetry(result: AutoCheckinChannelResult): boolean {
  if (!result.ok) return true
  const summary = result.summary
  if (summary === undefined) return true
  return summary.failed > 0 || summary.inactive > 0
}

/**
 * 判定本次启动要不要自动签到（纯函数，便于单测覆盖每个日界）。
 *
 * @param state - 持久化状态。
 * @param now - 当前时刻（epoch ms）。
 * @param maxAttempts - 当天尝试上限（默认 {@link AUTO_CHECKIN_MAX_ATTEMPTS_PER_DAY}）。
 */
export function decideAutoCheckin(
  state: AutoCheckinState,
  now: number,
  maxAttempts: number = AUTO_CHECKIN_MAX_ATTEMPTS_PER_DAY,
): AutoCheckinDecision {
  const day = utc8DayKey(now)
  if (!state.enabled) return { run: false, reason: 'disabled', day }
  // 新的一天：计数归零（`state.attempts` / `state.succeeded` 都属于旧的那天）。
  if (state.day !== day) return { run: true, day, attemptsToday: 0 }
  if (state.succeeded) return { run: false, reason: 'done', day }
  if (state.attempts >= maxAttempts) return { run: false, reason: 'exhausted', day }
  return { run: true, day, attemptsToday: state.attempts }
}

/**
 * 归一化从磁盘读到的状态。
 *
 * 逐字段保守校验（文档可能被手工编辑过、或残留旧版本格式）：
 * - `enabled`：**只有显式 `false` 才判关闭**，其余（缺省 / 脏值）取默认开启 ——
 *   与 {@link defaultAutoCheckinState} 一致；
 * - `day`：必须匹配 {@link DAY_KEY_PATTERN}，否则 `null`；
 * - `attempts`：非负整数，否则 0（宁可多签一次，不可因为脏数据卡死当天）；
 * - `lastResults`：逐条校验 `provider` 为非空字符串，`summary` 的五个计数
 *   逐个取非负整数（缺省 0）。
 */
export function sanitizeAutoCheckinState(raw: unknown): AutoCheckinState {
  const fallback = defaultAutoCheckinState()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fallback
  const record = raw as Record<string, unknown>
  return {
    enabled: record.enabled !== false,
    day: typeof record.day === 'string' && DAY_KEY_PATTERN.test(record.day) ? record.day : null,
    attempts: readNonNegativeInt(record.attempts, 0),
    succeeded: record.succeeded === true,
    lastRunAt: readPositiveNumber(record.lastRunAt),
    lastResults: sanitizeChannelResults(record.lastResults),
  }
}

/**
 * 合法的日键形态：`YYYY-MM-DD`，且**月 / 日必须在真实范围内**。
 *
 * ⚠️ 不能只写 `\d{4}-\d{2}-\d{2}`：`2026-13-99` 那样的脏数据虽然匹配，却
 * 与「今天」永不相等 ⇒ `state.day !== day` 恒为真 ⇒ **每次打开 DSH 都当成
 * 新的一天**，而新的一天会把 `attempts` 归零 —— 于是 `AUTO_CHECKIN_MAX_ATTEMPTS_PER_DAY`
 * 这道上限被**完全绕过**，永久失效的账号每次启动都被重试一遍。
 */
const DAY_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

/**
 * 新装用户的默认状态（`auto-checkin-store.ts` 从这里取，**单一真相源**）。
 *
 * ⚠️ `enabled` 默认 **`true`**（用户 2026-10-13 定）：本功能的整个意义就是
 * 「装上即自动领」，默认关闭等于要求用户先去面板找一次开关。
 */
export function defaultAutoCheckinState(): AutoCheckinState {
  return {
    enabled: true,
    day: null,
    attempts: 0,
    succeeded: false,
    lastRunAt: null,
    lastResults: [],
  }
}

function readNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback
  return Math.floor(value)
}

function readPositiveNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return value
}

function sanitizeChannelResults(raw: unknown): AutoCheckinChannelResult[] {
  if (!Array.isArray(raw)) return []
  const results: AutoCheckinChannelResult[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    if (typeof record.provider !== 'string' || record.provider.length === 0) continue
    const entry: AutoCheckinChannelResult = { provider: record.provider, ok: record.ok === true }
    if (typeof record.error === 'string' && record.error.length > 0) entry.error = record.error
    const summary = sanitizeSummary(record.summary)
    if (summary !== undefined) entry.summary = summary
    results.push(entry)
  }
  return results
}

function sanitizeSummary(raw: unknown): RpcCreditsClaimSummary | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  return {
    claimed: readNonNegativeInt(record.claimed, 0),
    totalCredit: readNonNegativeInt(record.totalCredit, 0),
    alreadyClaimed: readNonNegativeInt(record.alreadyClaimed, 0),
    inactive: readNonNegativeInt(record.inactive, 0),
    failed: readNonNegativeInt(record.failed, 0),
  }
}

/** 单渠道的执行结果（由调用方注入的 `claim` 产出）。 */
export interface AutoCheckinClaimOutcome {
  ok: boolean
  /** `ok === true` 时的领取汇总。 */
  summary?: RpcCreditsClaimSummary
  /** `ok === false` 时的原因文案（单行）。 */
  message?: string
}

/**
 * 执行器的注入依赖。
 *
 * 全部经注入而非直接 import：这样执行器**不依赖 `ctx` / 账号池 / 任何 auth
 * 实例**，单测可以用桩在毫秒级跑完全部分支（含「今天已签完」这类日期相关
 * 分支）。
 */
export interface AutoCheckinDeps {
  /** 渠道清单（默认 {@link AUTO_CHECKIN_PROVIDERS}）。 */
  providers?: readonly string[]
  /** 执行单个渠道的签到（**串行**调用，实现方不得并发）。 */
  claim: (provider: string) => Promise<AutoCheckinClaimOutcome>
  /** 读当前状态。 */
  load: () => AutoCheckinState
  /** 写回状态。 */
  save: (state: AutoCheckinState) => Promise<void>
  /** 日志出口（host 侧传 `ctx.logger.info`）。 */
  log: (message: string) => void
  /** 取当前时刻（注入以便单测）。 */
  now?: () => number
  /**
   * 跳过闸门强制执行一次（面板「立即签到一次」用）。
   *
   * ⚠️ **不越过开关**：用户明确关掉自动签到后，手动按钮仍应可用，但那走的是
   * 既有的 `credits.claimAll`，与本执行器无关 —— 这里保持「开关关闭就不跑」，
   * 免得出现「关掉了却还在自动发请求」这种无法解释的行为。
   */
  force?: boolean
}

/** 一次执行的结果。 */
export type AutoCheckinRunOutcome =
  | { ran: false; reason: AutoCheckinSkipReason; state: AutoCheckinState }
  | {
    ran: true
    state: AutoCheckinState
    /** 本次真领取的账号数。 */
    claimed: number
    /** 本次真领取的积分总量。 */
    totalCredit: number
    /** 本次失败的账号数。 */
    failed: number
  }

/**
 * 执行一次自动签到（含闸门）。
 *
 * 编排与 `credits.claimAll` 的「逐账号顺序执行」同一条原则，只是粒度提高一层：
 * **逐渠道串行**。跨渠道并发会同时打出多路领取请求（含 zcode 的 captcha），
 * 触发风控的代价是用户当天领不到 —— 那正是本功能最不该造成的结果。
 *
 * ⚠️ **单渠道异常不中断整体**：与后端「单账号失败不中断整体」同型，记为该渠道
 * `ok: false` 后继续下一个。
 */
export async function runAutoCheckin(deps: AutoCheckinDeps): Promise<AutoCheckinRunOutcome> {
  const now = deps.now?.() ?? Date.now()
  const state = deps.load()
  const decision = decideAutoCheckin(
    state,
    now,
    AUTO_CHECKIN_MAX_ATTEMPTS_PER_DAY,
  )
  if (!decision.run && deps.force !== true) {
    // 「开关关闭」的跳过**不打日志**：用户关掉它之后，每次启动都刷一条
    // 「已跳过」属于噪音（与「今天已签完」不同，后者是用户想确认的事实）。
    if (decision.reason !== 'disabled') {
      deps.log(`[jet-hub] 每日自动签到：${skipReasonText(decision.reason, state)}（${decision.day}）`)
    }
    return { ran: false, reason: decision.reason, state }
  }
  // `force` 只越过「今天已签完 / 次数上限」，**不越过开关**。
  if (!state.enabled) return { ran: false, reason: 'disabled', state }

  const day = utc8DayKey(now)
  const providers = deps.providers ?? AUTO_CHECKIN_PROVIDERS
  // 同一天续接计数；新的一天从 0 开始（`decision.attemptsToday` 已算好）。
  const attemptsToday = (state.day === day ? state.attempts : 0) + 1
  deps.log(
    `[jet-hub] 每日自动签到：开始（${providers.length} 个渠道，${day} 第 ${attemptsToday} 次）`,
  )

  const results: AutoCheckinChannelResult[] = []
  for (const provider of providers) {
    try {
      const outcome = await deps.claim(provider)
      const entry: AutoCheckinChannelResult = { provider, ok: outcome.ok }
      if (outcome.summary !== undefined) entry.summary = outcome.summary
      if (!outcome.ok) entry.error = outcome.message ?? '执行失败'
      results.push(entry)
      deps.log(`[jet-hub] 每日自动签到：${provider} ${channelResultText(entry)}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      results.push({ provider, ok: false, error: message })
      deps.log(`[jet-hub] 每日自动签到：${provider} 失败（${message}）`)
    }
  }

  const summary = summarizeChannels(results)
  const next: AutoCheckinState = {
    enabled: state.enabled,
    day,
    attempts: attemptsToday,
    // ⚠️ 失败一次就**不**标记成功：下次打开 DSH 会重试（用户定的策略）。
    succeeded: !results.some(channelNeedsRetry),
    lastRunAt: now,
    lastResults: results,
  }
  await deps.save(next)
  deps.log(
    `[jet-hub] 每日自动签到：完成，共 +${summary.totalCredit} 积分`
    + `（${summary.claimed} 个新领取，${summary.alreadyClaimed} 个今日已领，`
    + `${summary.inactive} 个暂无活动，${summary.failed} 个失败）`
    + `${next.succeeded ? '；当天已完成' : `；下次打开 DSH 会重试（当天 ${attemptsToday}/${AUTO_CHECKIN_MAX_ATTEMPTS_PER_DAY} 次）`}`,
  )
  return {
    ran: true,
    state: next,
    claimed: summary.claimed,
    totalCredit: summary.totalCredit,
    // ⚠️ 只取 `summary.failed`，**不要**再加上「ok:false 的渠道数」——
    // `summarizeChannels()` 已经把整渠道失败计入 failed（它没有逐账号明细，
    // 按 1 个失败计）。两处相加会把同一个失败算两次（写单测时实测到：期望 1
    // 实得 2），而本字段是要显示给用户看的。
    failed: summary.failed,
  }
}

/** 汇总逐渠道结果的计数（纯函数）。 */
export function summarizeChannels(
  results: readonly AutoCheckinChannelResult[],
): RpcCreditsClaimSummary {
  const summary: RpcCreditsClaimSummary = {
    claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0,
  }
  for (const result of results) {
    if (!result.ok) {
      // 整渠道失败按 1 个失败计（它没有逐账号明细可加）。
      summary.failed += 1
      continue
    }
    const channel = result.summary
    if (channel === undefined) continue
    summary.claimed += channel.claimed
    summary.totalCredit += channel.totalCredit
    summary.alreadyClaimed += channel.alreadyClaimed
    summary.inactive += channel.inactive
    summary.failed += channel.failed
  }
  return summary
}

/** 跳过原因的用户可读文案（日志与面板共用同一份，避免两处措辞漂移）。 */
export function skipReasonText(
  reason: AutoCheckinSkipReason,
  state: AutoCheckinState,
): string {
  switch (reason) {
    case 'disabled':
      return '开关已关闭，跳过'
    case 'done':
      return '今天已签完，跳过'
    case 'running':
      return '上次执行尚未结束，跳过'
    case 'exhausted':
      return `今天已尝试 ${state.attempts} 次仍未全部成功，不再自动重试`
  }
}

/** 单渠道结果的一行文案（日志用）。 */
function channelResultText(result: AutoCheckinChannelResult): string {
  if (!result.ok) return `失败（${result.error ?? '未知原因'}）`
  const summary = result.summary
  if (summary === undefined) return '无结果'
  if (summary.claimed > 0) return `领取 ${summary.claimed} 个，+${summary.totalCredit} 积分`
  if (summary.alreadyClaimed > 0) return `${summary.alreadyClaimed} 个今日已领`
  if (summary.inactive > 0) return `${summary.inactive} 个暂无活动`
  if (summary.failed > 0) return `${summary.failed} 个失败`
  return '无账号'
}
