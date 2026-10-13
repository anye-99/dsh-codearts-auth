/**
 * TeleAgent 积分余额与每日签到。
 *
 * ## ⚠️ 本模块的存在本身就是一次**结论修正**
 *
 * 第一版实现把能力矩阵登记成 `{ balance: false, dailyCheckin: false }`，
 * 依据是「asar 里没找到可自动调用的领取端点」。**那个结论是错的**，
 * 由用户 2026-10-07 的客户端截图 + 随后的取证推翻：
 *
 * | 截图事实 | 对应端点与字段 |
 * |---|---|
 * | 积分余额 **6100.00** | `GET /user/portal/companyStore/userCenter` → **`current_points_balance`** |
 * | 每日可领 **100** 积分 | `GET …/companyStore/v2/checkDayTask` → `daily_task.daily_claimable_points` |
 * | 已领 **2** 天 / 累计 **200** | 同上 → `total_claim_days` / `total_claimed_points` |
 * | 按钮显示**今日已领**且禁用 | 同上 → `daily_task.claimed_today` |
 * | 「邀请共享积分」活动标题 | 同上 → `activity.activity_title` |
 *
 * **领取是 GET**：`GET /user/portal/companyStore/checkTask?type=daily_login`
 * （asar `C = async A => { await Rn(ot.ACTIVE_CHECK_DAILY_TASK + "?type=daily_login"); … }`
 * —— `Rn` 就是 `bM("GET", …)`，**不是 POST**）。
 *
 * ## 我第一版为什么会漏掉（教训）
 *
 * 我当时按 `/api/` 与 `credit|point|signin|checkin` 等**英文关键词**在 asar 里搜，
 * 而这两个端点的路径是 `user/portal/companyStore/…`（**既不含 api、也不含
 * credit/point/signin 任何一词**），字段名又全是 `daily_claimable_points`
 * 这种**业务自定义**命名。⇒ **关键词搜索对「业务域词汇」必然漏检**。
 * 正确的复核方式是「**从 UI 组件反向追数据来源**」：先在 renderer 里搜
 * 界面文案的 i18n key（如 `settings.benefit.pointBalance`），
 * 再顺藤找到它消费的字段名与产出该字段的 `Rn(ot.XXX)` 调用 —— 本次正是这么解出的。
 *
 * ## ⚠️ 与其余 provider 的三处差异
 *
 * 1. **余额与签到是两个不同端点**（其余 provider 多为同一个）。
 * 2. **响应不套统一信封**：`bM()` 的判据是 `code===0 || code===200 || success===true`
 *    才取 `data`，而这两个端点的实际形状需实测确认 —— 故本模块**同时容忍
 *    「套 data」与「平铺」两种**（与 minimax 的 `unwrapEnvelopeData` 同因）。
 * 3. **签到按自然日**（「每日可领 100 积分」），但**时区依据未实测** ——
 *    客户端未下发 `timezone_id`（与 MiniMax 必须带时区参数**不同**），
 *    故我们也不带，由服务端按自己的账期判定。
 */

import {
  TELEAGENT,
  TELEAGENT_REQUEST_TIMEOUT_MS,
  type TeleagentProduct,
} from './teleagent-product.js'
import { teleagentHeaders, type TeleagentCredential } from './teleagent.js'
import { roundCredits, type CheckinStatus, type ClaimOutcome, type CreditBalance } from './credits.js'

/** 端点路径（相对 `apiBase`；asar renderer 的 `ot` 表原文）。 */
export const TELEAGENT_USER_CENTER_PATH = '/user/portal/companyStore/userCenter'
export const TELEAGENT_DAY_TASK_PATH = '/user/portal/companyStore/v2/checkDayTask'
export const TELEAGENT_CHECK_TASK_PATH = '/user/portal/companyStore/checkTask'

/** 签到类型参数（asar 原文 `ot.ACTIVE_CHECK_DAILY_TASK + "?type=daily_login"`）。 */
export const TELEAGENT_DAILY_LOGIN_TYPE = 'daily_login'

/** 读非空字符串。 */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * 读数字，**同时接受数字与字符串**。
 *
 * ⚠️ 截图上的余额是 `6100.00`（带两位小数）—— 这类「金额」字段在 JSON 里
 * 常以**字符串**下发以规避浮点（MiniMax 的 `remaining_amount` 就是这样，
 * 见 `src/minimax-credits.ts` 的 `looseAmount`）。故两种都要认。
 *
 * ⚠️ `Number('')` 是 0，会把「空字符串」误读成「0 积分」—— 先挡掉空串。
 */
function looseNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** 读布尔；同时认 `true/false` 与 `1/0`（服务端两种都可能下发）。 */
function looseBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : undefined
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase()
    if (lowered === 'true' || lowered === '1') return true
    if (lowered === 'false' || lowered === '0') return false
  }
  return undefined
}

/**
 * 取出业务载荷。
 *
 * ⚠️ `bM()` 的信封判据是 `code === 0 || code === 200 || success === true`
 * 时取 `data`；但**实测形状未确认**，故这里「有 `data` 对象就用它，否则用顶层」
 * —— 与 minimax 的 `unwrapEnvelopeData` 同因（强行只认 `data` 会把合法响应
 * 判成「缺少 data」）。`data` 是**数组**时不认（那是列表，不是对象载荷）。
 */
function unwrapData(payload: Record<string, unknown>): Record<string, unknown> {
  const nested = payload.data
  return typeof nested === 'object' && nested !== null && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : payload
}

/** 一次请求的结果（不抛错，由调用方分支）。 */
type ProbeResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; code: number; message: string }

/**
 * 发一次请求并做**最小**信封判定。
 *
 * ⚠️ 刻意**不做**严格的 `code === 0` 校验：本 provider 的信封约定尚未实测，
 * 而「业务码非 0 但数据仍可用」是常见形态。真正的失败判据交给调用方按
 * **字段是否存在**决定（拿不到字段 ⇒ `null`，而不是编造 0）。
 * 只有 HTTP 层失败与「非 JSON」才在这里判死。
 */
async function requestJson(
  url: string,
  credential: TeleagentCredential,
  fetcher: typeof fetch,
  init: { method: string } = { method: 'GET' },
): Promise<ProbeResult> {
  try {
    const response = await fetcher(url, {
      method: init.method,
      headers: teleagentHeaders(credential),
      signal: AbortSignal.timeout(TELEAGENT_REQUEST_TIMEOUT_MS),
    })
    const text = await response.text()
    if (!response.ok) {
      return {
        ok: false,
        code: response.status,
        message: response.status === 401 || response.status === 403
          ? `凭据已失效（HTTP ${response.status}），请重新登录该账号`
          : `服务端返回 HTTP ${response.status}`,
      }
    }
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      return { ok: false, code: response.status, message: `服务端返回了非 JSON 响应（HTTP ${response.status}）` }
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return { ok: false, code: -1, message: '响应无法解析为对象' }
    }
    return { ok: true, payload: payload as Record<string, unknown> }
  } catch (error) {
    return {
      ok: false,
      code: -1,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * 查询积分余额。
 *
 * 端点：`GET /user/portal/companyStore/userCenter`，字段：`current_points_balance`。
 *
 * ⚠️ **拿不到字段 ⇒ `null`（查询失败），不是 `0`** —— 两者语义完全不同：
 * 报 0 会让用户以为积分被清零（且若据此触发「余额不足」判断，会误伤正常账号）。
 * 与 minimax「`details` 缺失视为余额 0」**不同**，因为那边有 `total_count`
 * 作为「响应形状正确」的旁证，而这里没有任何旁证字段。
 */
export async function fetchTeleagentCreditBalance(
  credential: TeleagentCredential,
  fetcher: typeof fetch = fetch,
  product: TeleagentProduct = TELEAGENT,
): Promise<CreditBalance | null> {
  const result = await requestJson(
    `${product.apiBase}${TELEAGENT_USER_CENTER_PATH}`,
    credential,
    fetcher,
  )
  if (!result.ok) return null
  const data = unwrapData(result.payload)
  const balance = looseNumber(data.current_points_balance)
  if (balance === undefined) return null
  return { total: roundCredits(balance), packages: [], expiredTotal: 0 }
}

/** 每日签到面板（归一后）。 */
export interface TeleagentDayTask {
  /** 每日可领积分（截图「每日可领 100 积分」）。 */
  dailyClaimablePoints: number
  /** 已领取天数（截图「已领 2 天」）。 */
  totalClaimDays: number
  /** 累计已领积分（截图「累计 200 积分」）。 */
  totalClaimedPoints: number
  /** 今日是否已领（截图按钮「今日已领」+ 禁用）。 */
  claimedToday: boolean
  /** 每日任务区是否可见。 */
  dailyTaskVisible: boolean
  /** 活动区是否可见。 */
  activityVisible: boolean
  /** 活动标题（截图「邀请共享积分」）。 */
  activityTitle: string
  /** 按钮文案（服务端下发，空则用本地默认）。 */
  buttonText: string
}

/**
 * 解析每日签到面板。
 *
 * ⚠️ 字段名全部来自 asar `hxe` 组件的**逐字读取**（见模块头表格），
 * 不是猜的。`daily_task` 与 `activity` 是两个并列子对象。
 *
 * ⚠️ **`daily_claimable_points` 缺失时用 0**（而不是判失败）：它是**展示用**的
 * 「今天能领多少」，缺失时按钮文案会退化成默认值，不影响领取动作本身。
 * 但 `claimed_today` 缺失时**保守判 `false`**（未领）—— 方向取保守：
 * 误判「未领」最多让用户点一次（服务端幂等），误判「已领」会让其真的错过当天积分
 *（与 Qoder 那条「列表为空应判未领」同一取向）。
 */
export function parseTeleagentDayTask(payload: unknown): TeleagentDayTask | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const data = unwrapData(payload as Record<string, unknown>)
  const dailyTask = typeof data.daily_task === 'object' && data.daily_task !== null
    ? data.daily_task as Record<string, unknown>
    : undefined
  const activity = typeof data.activity === 'object' && data.activity !== null
    ? data.activity as Record<string, unknown>
    : undefined
  // ⚠️ 两个子对象都不存在 ⇒ 形状不对，返回 undefined（不编造一个全 0 的面板）。
  if (dailyTask === undefined && activity === undefined) return undefined
  return {
    dailyClaimablePoints: looseNumber(dailyTask?.daily_claimable_points) ?? 0,
    totalClaimDays: looseNumber(dailyTask?.total_claim_days) ?? 0,
    totalClaimedPoints: looseNumber(dailyTask?.total_claimed_points) ?? 0,
    // ⚠️ 缺失 ⇒ false（保守：宁可让用户多点一次，也不误报已领）
    claimedToday: looseBoolean(dailyTask?.claimed_today) ?? false,
    // ⚠️ `visible` 缺失 ⇒ true（与 asar 的 `!== false` 判据一致）
    dailyTaskVisible: looseBoolean(dailyTask?.visible) !== false,
    activityVisible: looseBoolean(activity?.visible) === true,
    activityTitle: nonEmptyString(activity?.activity_title) ?? '',
    buttonText: nonEmptyString(dailyTask?.button_text) ?? '',
  }
}

/**
 * 把面板映射成 DSH 的 {@link CheckinStatus}。
 *
 * ⚠️ **`active` 恒 `true`**（拿到响应即 true）：若按「有没有可领」判，
 * 会把「今天已领」误报成「签到活动未开启」（Qoder 同型缺陷，已记入 AGENTS.md）。
 */
export function teleagentPanelToCheckinStatus(panel: TeleagentDayTask): CheckinStatus {
  return {
    active: true,
    todayCheckedIn: panel.claimedToday,
    // ⚠️ TeleAgent 的面板**不提供连续天数**（只有累计天数）——
    // 用累计天数冒充连续天数是**编造语义**，故填 0（UI 不显示连续）。
    streakDays: 0,
    dailyCredit: panel.dailyClaimablePoints,
    todayCredit: panel.claimedToday ? panel.dailyClaimablePoints : 0,
    isStreakDay: false,
    // 「累计已领」与「连续签到」不同，放这里最贴切（DSH 的语义是「累计已领积分」）。
    totalCredits: panel.totalClaimedPoints,
    checkinDates: [],
    activityName: panel.activityTitle,
    themeName: '',
    endTime: '',
  }
}

/** 查询签到状态；失败返回 `null`（不抛错）。 */
export async function fetchTeleagentCheckinStatus(
  credential: TeleagentCredential,
  fetcher: typeof fetch = fetch,
  product: TeleagentProduct = TELEAGENT,
): Promise<CheckinStatus | null> {
  const result = await requestJson(
    `${product.apiBase}${TELEAGENT_DAY_TASK_PATH}`,
    credential,
    fetcher,
  )
  if (!result.ok) return null
  const panel = parseTeleagentDayTask(result.payload)
  return panel === undefined ? null : teleagentPanelToCheckinStatus(panel)
}

/**
 * 领取每日签到。
 *
 * ⚠️⚠️ **是 GET，不是 POST** —— asar 原文：
 * ```js
 * const C = async A => { … await Rn(ot.ACTIVE_CHECK_DAILY_TASK + "?type=daily_login"); … }
 * ```
 * `Rn` 即 `bM("GET", …)`。写成 POST 会 404/405。
 *
 * ⚠️ **幂等判据**：本端点**不返回**类似 minimax `claim_result` 的显式幂等码
 * （asar 里领取后是**重新 GET 一次面板**来刷新 UI）。故这里的「已领」判定
 * 采取**两次探测**：领取后重查面板，若 `claimed_today` 为真即成功。
 * 而「本来就已领」的情形由**调用方**先查状态避免（RPC 层先 `fetchStatus`）。
 *
 * ⚠️ 本函数**不抛错**（失败也返回 `failed`），保证批量领取不因单账号中断。
 */
export async function claimTeleagentDailyCheckin(
  credential: TeleagentCredential,
  fetcher: typeof fetch = fetch,
  product: TeleagentProduct = TELEAGENT,
): Promise<ClaimOutcome> {
  const url = `${product.apiBase}${TELEAGENT_CHECK_TASK_PATH}?type=${TELEAGENT_DAILY_LOGIN_TYPE}`
  const result = await requestJson(url, credential, fetcher, { method: 'GET' })
  if (!result.ok) {
    return { kind: 'failed', code: result.code, message: result.message }
  }

  // ⚠️ 领取响应形状**未实测**（asar 只 await 它、不看返回值，随后重查面板）。
  // 故这里**不解析领取响应**，而是重查面板拿权威状态 —— 这样无论领取接口
  // 回什么形状都能正确判定，也不会因形状猜错而误报失败。
  const after = await fetchTeleagentCheckinStatus(credential, fetcher, product)
  if (after === null) {
    // 领取请求本身成功了，但面板查不回来 —— 无法确认结果。
    // 取保守：报「已领取」会让用户错过当天积分，故报 failed 让其重试（服务端幂等）。
    return {
      kind: 'failed',
      code: -1,
      message: '领取请求已发送，但无法确认结果（签到面板查询失败），请稍后重试',
    }
  }
  if (!after.todayCheckedIn) {
    // 领取后仍未标记已领 —— 多半是「今天本来就没得领」或服务端未接受。
    return {
      kind: 'inactive',
      message: '领取后状态未变更（可能今日无可用签到或活动未开始）',
    }
  }
  return {
    kind: 'claimed',
    credit: after.dailyCredit,
    streakDays: after.streakDays,
    isStreakDay: after.isStreakDay,
  }
}
