import { describe, expect, it } from 'vitest'
import {
  claimTeleagentDailyCheckin,
  fetchTeleagentCheckinStatus,
  fetchTeleagentCreditBalance,
  parseTeleagentDayTask,
  teleagentPanelToCheckinStatus,
  TELEAGENT_CHECK_TASK_PATH,
  TELEAGENT_DAILY_LOGIN_TYPE,
  TELEAGENT_DAY_TASK_PATH,
  TELEAGENT_USER_CENTER_PATH,
} from '../../src/teleagent-credits.js'
import { TELEAGENT } from '../../src/teleagent-product.js'
import type { TeleagentCredential } from '../../src/teleagent.js'

/**
 * TeleAgent 积分/签到的回归测试。
 *
 * ⚠️ **本模块的存在本身就是一次结论修正**（见其模块头）：第一版把能力登记成
 * `{balance:false, dailyCheckin:false}`，被用户 2026-10-07 的客户端截图推翻。
 * 故这里的用例有双重职责：锁住**正确的字段名**，同时锁住**「曾判错过」这件事**
 * —— 例如「`current_points_balance` 取不到时必须是 null 而不是 0」。
 */

const cred = (): TeleagentCredential => ({ token: 'T', device_id: 'd' })

/** 构造一个最小可用的 fetch 替身。 */
function stubFetch(body: unknown, init: { status?: number } = {}) {
  const calls: Array<{ url: string; method: string; headers: Headers }> = []
  const fetcher = (async (input: never, options: never) => {
    const opts = (options ?? {}) as { method?: string; headers?: Headers }
    calls.push({
      url: String(input),
      method: opts.method ?? 'GET',
      headers: opts.headers as Headers,
    })
    return {
      ok: (init.status ?? 200) < 400,
      status: init.status ?? 200,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    }
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

describe('端点常量（asar renderer 的 ot 表原文）', () => {
  it('三个路径与领取类型逐字正确', () => {
    expect(TELEAGENT_USER_CENTER_PATH).toBe('/user/portal/companyStore/userCenter')
    expect(TELEAGENT_DAY_TASK_PATH).toBe('/user/portal/companyStore/v2/checkDayTask')
    expect(TELEAGENT_CHECK_TASK_PATH).toBe('/user/portal/companyStore/checkTask')
    expect(TELEAGENT_DAILY_LOGIN_TYPE).toBe('daily_login')
  })
})

describe('积分余额：字段名 current_points_balance', () => {
  it('★ 从截图对应的字段读取（6100.00）', async () => {
    const { fetcher, calls } = stubFetch({ current_points_balance: '6100.00' })
    const balance = await fetchTeleagentCreditBalance(cred(), fetcher)
    expect(balance?.total).toBe(6100)
    expect(calls[0]?.url).toBe(`${TELEAGENT.apiBase}${TELEAGENT_USER_CENTER_PATH}`)
    expect(calls[0]?.method).toBe('GET')
  })

  it('数字形态也接受（服务端两种都可能下发）', async () => {
    const { fetcher } = stubFetch({ current_points_balance: 42 })
    expect((await fetchTeleagentCreditBalance(cred(), fetcher))?.total).toBe(42)
  })

  it('★ 字段缺失 ⇒ **null（查询失败）而不是 0** —— 报 0 会让用户以为积分被清零', async () => {
    const { fetcher } = stubFetch({ something_else: 1 })
    expect(await fetchTeleagentCreditBalance(cred(), fetcher)).toBeNull()
  })

  it('空字符串不算 0（`Number("")` 是 0，必须挡掉）', async () => {
    const { fetcher } = stubFetch({ current_points_balance: '' })
    expect(await fetchTeleagentCreditBalance(cred(), fetcher)).toBeNull()
  })

  it('套 data 信封与平铺两种形状都认', async () => {
    const a = stubFetch({ code: 0, data: { current_points_balance: 7 } })
    expect((await fetchTeleagentCreditBalance(cred(), a.fetcher))?.total).toBe(7)
    const b = stubFetch({ current_points_balance: 8 })
    expect((await fetchTeleagentCreditBalance(cred(), b.fetcher))?.total).toBe(8)
  })

  it('HTTP 401 ⇒ null（不抛错，由 RPC 层转成可读错误）', async () => {
    const { fetcher } = stubFetch({ message: 'unauthorized' }, { status: 401 })
    expect(await fetchTeleagentCreditBalance(cred(), fetcher)).toBeNull()
  })

  it('非 JSON 响应 ⇒ null', async () => {
    const { fetcher } = stubFetch('<html>gateway error</html>')
    expect(await fetchTeleagentCreditBalance(cred(), fetcher)).toBeNull()
  })

  it('请求带 X-Token 身份头（不是 Authorization）', async () => {
    const { fetcher, calls } = stubFetch({ current_points_balance: 1 })
    await fetchTeleagentCreditBalance(cred(), fetcher)
    expect(calls[0]?.headers.get('X-Token')).toBe('T')
    expect(calls[0]?.headers.get('Authorization')).toBeNull()
  })
})

describe('签到面板解析（字段名全部来自 asar hxe 组件）', () => {
  const panel = {
    daily_task: {
      visible: true,
      claimed_today: false,
      daily_claimable_points: 100,
      total_claim_days: 2,
      total_claimed_points: 200,
      button_text: '立即领取',
    },
    activity: { visible: true, activity_title: '邀请共享积分' },
  }

  it('★ 逐字段对齐截图（每日 100 / 已领 2 天 / 累计 200）', () => {
    const parsed = parseTeleagentDayTask(panel)
    expect(parsed?.dailyClaimablePoints).toBe(100)
    expect(parsed?.totalClaimDays).toBe(2)
    expect(parsed?.totalClaimedPoints).toBe(200)
    expect(parsed?.claimedToday).toBe(false)
    expect(parsed?.activityTitle).toBe('邀请共享积分')
    expect(parsed?.buttonText).toBe('立即领取')
  })

  it('★ claimed_today=true（截图「今日已领」）', () => {
    const parsed = parseTeleagentDayTask({
      daily_task: { ...panel.daily_task, claimed_today: true },
    })
    expect(parsed?.claimedToday).toBe(true)
  })

  it('★ claimed_today 缺失 ⇒ 保守判**未领**（误报已领会错过当天积分）', () => {
    const parsed = parseTeleagentDayTask({
      daily_task: { daily_claimable_points: 100 },
    })
    expect(parsed?.claimedToday).toBe(false)
  })

  it('布尔/数字/字符串三种形态都认', () => {
    for (const [raw, expected] of [[true, true], [1, true], ['true', true], ['1', true],
      [false, false], [0, false], ['false', false], ['0', false]] as const) {
      const parsed = parseTeleagentDayTask({ daily_task: { claimed_today: raw } })
      expect(parsed?.claimedToday, String(raw)).toBe(expected)
    }
  })

  it('两个子对象都不存在 ⇒ undefined（不编造一个全 0 的面板）', () => {
    expect(parseTeleagentDayTask({})).toBeUndefined()
    expect(parseTeleagentDayTask(null)).toBeUndefined()
    expect(parseTeleagentDayTask([])).toBeUndefined()
  })

  it('只有 activity 时也能解析（每日任务区不可见的情形）', () => {
    const parsed = parseTeleagentDayTask({ activity: { visible: true, activity_title: 'A' } })
    expect(parsed?.activityTitle).toBe('A')
    expect(parsed?.dailyTaskVisible).toBe(true)
  })

  it('visible 缺失 ⇒ 视作可见（与 asar 的 `!== false` 判据一致）', () => {
    expect(parseTeleagentDayTask({ daily_task: {} })?.dailyTaskVisible).toBe(true)
  })
})

describe('面板 → CheckinStatus 映射', () => {
  it('★ active 恒 true（拿到响应即 true）—— 否则「今天已领」会被误报成「活动未开启」', () => {
    const status = teleagentPanelToCheckinStatus({
      dailyClaimablePoints: 100, totalClaimDays: 2, totalClaimedPoints: 200,
      claimedToday: true, dailyTaskVisible: true, activityVisible: false,
      activityTitle: '', buttonText: '',
    })
    expect(status.active).toBe(true)
    expect(status.todayCheckedIn).toBe(true)
    expect(status.dailyCredit).toBe(100)
    expect(status.todayCredit).toBe(100)
    expect(status.totalCredits).toBe(200)
  })

  it('★ streakDays 恒 0 —— 面板只给「累计天数」，拿它冒充「连续天数」是编造语义', () => {
    const status = teleagentPanelToCheckinStatus({
      dailyClaimablePoints: 100, totalClaimDays: 5, totalClaimedPoints: 500,
      claimedToday: false, dailyTaskVisible: true, activityVisible: false,
      activityTitle: '', buttonText: '',
    })
    expect(status.streakDays).toBe(0)
    // 累计值放在 totalCredits（DSH 的语义正是「累计已领积分」）
    expect(status.totalCredits).toBe(500)
  })

  it('未领时 todayCredit 为 0', () => {
    const status = teleagentPanelToCheckinStatus({
      dailyClaimablePoints: 100, totalClaimDays: 0, totalClaimedPoints: 0,
      claimedToday: false, dailyTaskVisible: true, activityVisible: false,
      activityTitle: '', buttonText: '',
    })
    expect(status.todayCredit).toBe(0)
  })
})

describe('签到状态查询', () => {
  it('正常响应 → CheckinStatus', async () => {
    const { fetcher, calls } = stubFetch({
      daily_task: { claimed_today: true, daily_claimable_points: 100, total_claimed_points: 300 },
    })
    const status = await fetchTeleagentCheckinStatus(cred(), fetcher)
    expect(status?.todayCheckedIn).toBe(true)
    expect(calls[0]?.url).toBe(`${TELEAGENT.apiBase}${TELEAGENT_DAY_TASK_PATH}`)
  })

  it('形状不对 ⇒ null（不抛错）', async () => {
    const { fetcher } = stubFetch({ nope: 1 })
    expect(await fetchTeleagentCheckinStatus(cred(), fetcher)).toBeNull()
  })
})

describe('每日领取', () => {
  it('★ 领取用 **GET**（asar 原文是 Rn，即 bM("GET", …)）—— 写成 POST 会 404/405', async () => {
    const { fetcher, calls } = stubFetch({
      daily_task: { claimed_today: true, daily_claimable_points: 100 },
    })
    await claimTeleagentDailyCheckin(cred(), fetcher)
    expect(calls[0]?.method).toBe('GET')
    expect(calls[0]?.url).toBe(
      `${TELEAGENT.apiBase}${TELEAGENT_CHECK_TASK_PATH}?type=${TELEAGENT_DAILY_LOGIN_TYPE}`,
    )
  })

  it('★ 领取后重查面板：claimed_today 为真 ⇒ claimed', async () => {
    const { fetcher } = stubFetch({
      daily_task: { claimed_today: true, daily_claimable_points: 100 },
    })
    const outcome = await claimTeleagentDailyCheckin(cred(), fetcher)
    expect(outcome.kind).toBe('claimed')
    if (outcome.kind === 'claimed') expect(outcome.credit).toBe(100)
  })

  it('★ 领取后仍未标记已领 ⇒ inactive（而不是谎报 claimed）', async () => {
    const { fetcher } = stubFetch({ daily_task: { claimed_today: false } })
    const outcome = await claimTeleagentDailyCheckin(cred(), fetcher)
    expect(outcome.kind).toBe('inactive')
  })

  it('领取请求 HTTP 失败 ⇒ failed（带状态码）', async () => {
    const { fetcher } = stubFetch({ message: 'nope' }, { status: 500 })
    const outcome = await claimTeleagentDailyCheckin(cred(), fetcher)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') expect(outcome.code).toBe(500)
  })

  it('★ 领取成功但面板查不回来 ⇒ failed（保守：谎报已领会错过当天积分）', async () => {
    let call = 0
    const fetcher = (async () => {
      call += 1
      // 第一次（领取）成功；第二次（重查面板）返回坏形状
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(call === 1 ? { ok: true } : { broken: true }),
      }
    }) as unknown as typeof fetch
    const outcome = await claimTeleagentDailyCheckin(cred(), fetcher)
    expect(outcome.kind).toBe('failed')
  })

  it('★ 本函数不抛错（批量领取不因单账号中断）', async () => {
    const throwing = (async () => { throw new Error('network down') }) as unknown as typeof fetch
    await expect(claimTeleagentDailyCheckin(cred(), throwing)).resolves.toMatchObject({ kind: 'failed' })
  })
})
