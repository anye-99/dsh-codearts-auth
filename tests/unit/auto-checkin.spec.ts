import { describe, expect, it } from 'vitest'
import {
  AUTO_CHECKIN_MAX_ATTEMPTS_PER_DAY,
  AUTO_CHECKIN_PROVIDERS,
  channelNeedsRetry,
  decideAutoCheckin,
  defaultAutoCheckinState,
  runAutoCheckin,
  sanitizeAutoCheckinState,
  skipReasonText,
  summarizeChannels,
  utc8DayKey,
  type AutoCheckinChannelResult,
  type AutoCheckinClaimOutcome,
  type AutoCheckinState,
} from '../../src/auto-checkin.js'
import { checkinProviders } from '../../plugin-src/client/credits-capabilities.js'

/**
 * 每日自动签到的回归测试。
 *
 * 覆盖三层：
 * 1. **日界**（`utc8DayKey`）—— 全部用 `Date.UTC(...)` 构造，故与跑测试的机器
 *    时区无关（这正是它必须写死 UTC+8 的原因）；
 * 2. **闸门**（`decideAutoCheckin` + `runAutoCheckin`）—— 用户 2026-10-13 定的
 *    策略：当天已签完跳过、有失败则下次重试、每天最多 3 次；
 * 3. **能力表对账** —— host 侧渠道清单与客户端 `credits-capabilities.js` 的
 *    `checkinProviders()` **逐条含顺序**一致（两处各写一份必然漂移）。
 */

/** 一个「全是成功领取」的渠道结果。 */
function claimed(credit = 100): AutoCheckinClaimOutcome {
  return {
    ok: true,
    summary: { claimed: 1, totalCredit: credit, alreadyClaimed: 0, inactive: 0, failed: 0 },
  }
}

/** 构造一个已经跑过一次的状态。 */
function stateAfter(partial: Partial<AutoCheckinState>): AutoCheckinState {
  return { ...defaultAutoCheckinState(), ...partial }
}

describe('utc8DayKey：UTC+8 自然日键', () => {
  it('日界落在 UTC 16:00（不是本机时区的 00:00）', () => {
    // UTC+8 的 2026-10-13 00:00 == UTC 2026-10-12 16:00
    expect(utc8DayKey(Date.UTC(2026, 9, 12, 15, 59, 59))).toBe('2026-10-12')
    expect(utc8DayKey(Date.UTC(2026, 9, 12, 16, 0, 0))).toBe('2026-10-13')
    expect(utc8DayKey(Date.UTC(2026, 9, 12, 16, 0, 1))).toBe('2026-10-13')
  })

  it('UTC+8 当天的白天仍是同一天', () => {
    // UTC 2026-10-13 02:00 == UTC+8 10:00（Qoder 活动每日 10:00 刷新的时刻）
    expect(utc8DayKey(Date.UTC(2026, 9, 13, 2, 0, 0))).toBe('2026-10-13')
  })

  it('跨月 / 跨年都正确（月日补零）', () => {
    expect(utc8DayKey(Date.UTC(2026, 0, 31, 16, 0, 0))).toBe('2026-02-01')
    expect(utc8DayKey(Date.UTC(2026, 11, 31, 16, 0, 0))).toBe('2027-01-01')
    expect(utc8DayKey(Date.UTC(2026, 8, 30, 16, 0, 0))).toBe('2026-10-01')
  })

  it('同一天内的任意时刻得到同一个键（键不随时间漂移）', () => {
    const keys = new Set([
      utc8DayKey(Date.UTC(2026, 9, 12, 16, 0, 0)), // UTC+8 00:00
      utc8DayKey(Date.UTC(2026, 9, 13, 5, 30, 0)), // UTC+8 13:30
      utc8DayKey(Date.UTC(2026, 9, 13, 15, 59, 59)), // UTC+8 23:59:59
    ])
    expect([...keys]).toEqual(['2026-10-13'])
  })
})

describe('decideAutoCheckin：闸门判定', () => {
  const noon = Date.UTC(2026, 9, 13, 4, 0, 0) // UTC+8 12:00

  it('开关关闭 ⇒ disabled（优先级高于一切，含当天未签）', () => {
    const decision = decideAutoCheckin(stateAfter({ enabled: false }), noon)
    expect(decision).toEqual({ run: false, reason: 'disabled', day: '2026-10-13' })
  })

  it('从未执行过 ⇒ 执行，当天计数从 0 起', () => {
    const decision = decideAutoCheckin(defaultAutoCheckinState(), noon)
    expect(decision).toEqual({ run: true, day: '2026-10-13', attemptsToday: 0 })
  })

  it('当天已成功签完 ⇒ done（不重复发请求）', () => {
    const decision = decideAutoCheckin(
      stateAfter({ day: '2026-10-13', attempts: 1, succeeded: true }),
      noon,
    )
    expect(decision).toEqual({ run: false, reason: 'done', day: '2026-10-13' })
  })

  it('当天有失败且未达上限 ⇒ 再试（attemptsToday 续接）', () => {
    const decision = decideAutoCheckin(
      stateAfter({ day: '2026-10-13', attempts: 1, succeeded: false }),
      noon,
    )
    expect(decision).toEqual({ run: true, day: '2026-10-13', attemptsToday: 1 })
  })

  it('当天已达上限 ⇒ exhausted', () => {
    const decision = decideAutoCheckin(
      stateAfter({ day: '2026-10-13', attempts: AUTO_CHECKIN_MAX_ATTEMPTS_PER_DAY }),
      noon,
    )
    expect(decision).toEqual({ run: false, reason: 'exhausted', day: '2026-10-13' })
  })

  it('跨到新的一天（UTC+8）⇒ 计数归零、重新可签（哪怕昨天已签完）', () => {
    const decision = decideAutoCheckin(
      stateAfter({
        day: '2026-10-12',
        attempts: AUTO_CHECKIN_MAX_ATTEMPTS_PER_DAY,
        succeeded: true,
      }),
      noon,
    )
    expect(decision).toEqual({ run: true, day: '2026-10-13', attemptsToday: 0 })
  })

  it('⚠️ 恰好跨过 UTC+8 午夜 ⇒ 判定为「新的一天」', () => {
    const state = stateAfter({ day: '2026-10-13', attempts: 3, succeeded: true })
    // UTC 15:59 = UTC+8 10-13 23:59 ⇒ 仍是旧的一天
    expect(decideAutoCheckin(state, Date.UTC(2026, 9, 13, 15, 59, 0)).run).toBe(false)
    // UTC 16:00 = UTC+8 10-14 00:00 ⇒ 新的一天
    expect(decideAutoCheckin(state, Date.UTC(2026, 9, 13, 16, 0, 0))).toEqual({
      run: true, day: '2026-10-14', attemptsToday: 0,
    })
  })
})

describe('sanitizeAutoCheckinState：脏数据归一', () => {
  it('undefined / 非对象 ⇒ 默认状态（enabled 为 true）', () => {
    for (const raw of [undefined, null, [], 'x', 42]) {
      expect(sanitizeAutoCheckinState(raw)).toEqual(defaultAutoCheckinState())
    }
  })

  it('只有显式 false 才判关闭（字符串 "false" 不算）', () => {
    expect(sanitizeAutoCheckinState({ enabled: false }).enabled).toBe(false)
    expect(sanitizeAutoCheckinState({ enabled: 'false' }).enabled).toBe(true)
    expect(sanitizeAutoCheckinState({ enabled: 0 }).enabled).toBe(true)
  })

  it('⚠️ 非法日期（月份 / 日越界）⇒ null，不能放过', () => {
    // 放过它会让 `state.day !== day` 恒为真 ⇒ 每次启动都当成新的一天
    // ⇒ attempts 归零 ⇒ 上限被绕过。这正是 `DAY_KEY_PATTERN` 收紧的原因。
    expect(sanitizeAutoCheckinState({ day: '2026-13-99' }).day).toBeNull()
    expect(sanitizeAutoCheckinState({ day: '2026-00-10' }).day).toBeNull()
    expect(sanitizeAutoCheckinState({ day: '2026-10-32' }).day).toBeNull()
    expect(sanitizeAutoCheckinState({ day: '2026-10-13' }).day).toBe('2026-10-13')
    expect(sanitizeAutoCheckinState({ day: 20261013 }).day).toBeNull()
  })

  it('attempts / lastRunAt 的非数值与负值回落到默认', () => {
    expect(sanitizeAutoCheckinState({ attempts: -1 }).attempts).toBe(0)
    expect(sanitizeAutoCheckinState({ attempts: '2' }).attempts).toBe(0)
    expect(sanitizeAutoCheckinState({ attempts: 2.7 }).attempts).toBe(2)
    expect(sanitizeAutoCheckinState({ lastRunAt: 0 }).lastRunAt).toBeNull()
    expect(sanitizeAutoCheckinState({ lastRunAt: -5 }).lastRunAt).toBeNull()
    expect(sanitizeAutoCheckinState({ lastRunAt: 'now' }).lastRunAt).toBeNull()
    expect(sanitizeAutoCheckinState({ lastRunAt: 1700000000000 }).lastRunAt).toBe(1700000000000)
  })

  it('lastResults：合法项保留、非法项丢弃、summary 缺字段补 0', () => {
    const state = sanitizeAutoCheckinState({
      lastResults: [
        { provider: 'qoder', ok: true, summary: { claimed: 2, totalCredit: 900 } },
        { provider: '', ok: true },
        null,
        'x',
        { ok: true },
        { provider: 'zcode', ok: false, error: '没有可用浏览器' },
      ],
    })
    expect(state.lastResults).toHaveLength(2)
    expect(state.lastResults[0]).toEqual({
      provider: 'qoder',
      ok: true,
      summary: { claimed: 2, totalCredit: 900, alreadyClaimed: 0, inactive: 0, failed: 0 },
    })
    expect(state.lastResults[1]).toEqual({
      provider: 'zcode', ok: false, error: '没有可用浏览器',
    })
  })

  it('succeeded 只有显式 true 才算', () => {
    expect(sanitizeAutoCheckinState({ succeeded: true }).succeeded).toBe(true)
    expect(sanitizeAutoCheckinState({ succeeded: 'yes' }).succeeded).toBe(false)
  })
})

describe('channelNeedsRetry：什么算「没签完」', () => {
  const withSummary = (summary: Partial<AutoCheckinChannelResult['summary']>): AutoCheckinChannelResult => ({
    provider: 'qoder',
    ok: true,
    summary: { claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0, ...summary },
  })

  it('整渠道失败 ⇒ 需要重试', () => {
    expect(channelNeedsRetry({ provider: 'zcode', ok: false, error: 'x' })).toBe(true)
  })

  it('ok 但没有 summary ⇒ 需要重试（宁可多试一次）', () => {
    expect(channelNeedsRetry({ provider: 'qoder', ok: true })).toBe(true)
  })

  it('⚠️ inactive（暂无活动）⇒ 需要重试 —— 这是「10:00 前启动签不到」的自愈路径', () => {
    expect(channelNeedsRetry(withSummary({ inactive: 1 }))).toBe(true)
  })

  it('failed ⇒ 需要重试', () => {
    expect(channelNeedsRetry(withSummary({ failed: 2 }))).toBe(true)
  })

  it('已领取 / 纯无账号（全 0）⇒ 不需要重试', () => {
    expect(channelNeedsRetry(withSummary({ alreadyClaimed: 3 }))).toBe(false)
    expect(channelNeedsRetry(withSummary({ claimed: 1, totalCredit: 100 }))).toBe(false)
    // 渠道没有账号：一个请求都不会发，不该每天空转
    expect(channelNeedsRetry(withSummary({}))).toBe(false)
  })
})

describe('summarizeChannels：逐渠道汇总', () => {
  it('整渠道失败按 1 个失败计（它没有逐账号明细）', () => {
    expect(summarizeChannels([
      { provider: 'a', ok: false, error: 'boom' },
      { provider: 'b', ok: true, summary: { claimed: 1, totalCredit: 50, alreadyClaimed: 1, inactive: 0, failed: 1 } },
    ])).toEqual({ claimed: 1, totalCredit: 50, alreadyClaimed: 1, inactive: 0, failed: 2 })
  })

  it('ok 但无 summary 时不计入任何一栏（不虚报失败）', () => {
    expect(summarizeChannels([{ provider: 'a', ok: true }])).toEqual({
      claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0,
    })
  })
})

describe('runAutoCheckin：执行编排', () => {
  /** 构造一个可观测的执行环境。 */
  function harness(options: {
    state?: AutoCheckinState
    results?: Record<string, AutoCheckinClaimOutcome | Error>
    now?: number
  } = {}) {
    const order: string[] = []
    const saved: AutoCheckinState[] = []
    const logs: string[] = []
    let current = options.state ?? defaultAutoCheckinState()
    const providers = Object.keys(options.results ?? { qoder: claimed(), zcode: claimed() })
    const run = (extra: { force?: boolean } = {}) => runAutoCheckin({
      providers,
      claim: async (provider) => {
        order.push(provider)
        const result = options.results?.[provider]
        if (result instanceof Error) throw result
        return result ?? claimed()
      },
      load: () => current,
      save: async (next) => { saved.push(next); current = next },
      log: (message) => logs.push(message),
      now: () => options.now ?? Date.UTC(2026, 9, 13, 4, 0, 0),
      ...extra,
    })
    return { run, order, saved, logs, state: () => current, providers }
  }

  it('逐渠道**串行**执行（并发会触发风控，用户当天就领不到）', async () => {
    const h = harness({ results: { codearts: claimed(), buddy: claimed(), qoder: claimed() } })
    await h.run()
    expect(h.order).toEqual(['codearts', 'buddy', 'qoder'])
  })

  it('单渠道抛错不中断整体，且该渠道记为 ok:false', async () => {
    const h = harness({
      results: {
        codearts: claimed(300),
        buddy: new Error('凭据未配置'),
        qoder: claimed(100),
      },
    })
    const outcome = await h.run()
    expect(h.order).toEqual(['codearts', 'buddy', 'qoder'])
    expect(outcome.ran).toBe(true)
    const results = h.state().lastResults
    expect(results.find((r) => r.provider === 'buddy')).toEqual({
      provider: 'buddy', ok: false, error: '凭据未配置',
    })
    // ⚠️ 整渠道失败的账号数无从得知，按 1 个失败计（不虚报 0）
    expect(outcome.ran && outcome.failed).toBe(1)
    expect(outcome.ran && outcome.totalCredit).toBe(400)
  })

  it('全部渠道达成 ⇒ succeeded=true（当天不再重签）', async () => {
    const h = harness({ results: { codearts: claimed(500), qoder: claimed(100) } })
    const outcome = await h.run()
    expect(outcome.ran).toBe(true)
    expect(h.state().succeeded).toBe(true)
    expect(h.state().day).toBe('2026-10-13')
    expect(h.state().attempts).toBe(1)
    expect(h.saved).toHaveLength(1)
    expect(h.logs.some((line) => line.includes('当天已完成'))).toBe(true)
  })

  it('⚠️ 存在 inactive ⇒ succeeded=false（否则「10:00 前启动」会变成「今天再也不签」）', async () => {
    const h = harness({
      results: {
        qoder: { ok: true, summary: { claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 1, failed: 0 } },
      },
    })
    await h.run()
    expect(h.state().succeeded).toBe(false)
    expect(h.logs.some((line) => line.includes('下次打开 DSH 会重试'))).toBe(true)
  })

  it('存在 failed 账号 ⇒ succeeded=false', async () => {
    const h = harness({
      results: {
        trae: { ok: true, summary: { claimed: 1, totalCredit: 10, alreadyClaimed: 0, inactive: 0, failed: 2 } },
      },
    })
    await h.run()
    expect(h.state().succeeded).toBe(false)
  })

  it('当天已签完后再触发 ⇒ 跳过、不执行任何渠道、不写盘', async () => {
    const h = harness({
      state: stateAfter({ day: '2026-10-13', attempts: 1, succeeded: true }),
    })
    const outcome = await h.run()
    expect(outcome).toEqual({
      ran: false,
      reason: 'done',
      state: expect.objectContaining({ succeeded: true }),
    })
    expect(h.order).toEqual([])
    expect(h.saved).toEqual([])
  })

  it('当天第 3 次失败后第 4 次触发 ⇒ exhausted，不再重试', async () => {
    const h = harness({
      state: stateAfter({ day: '2026-10-13', attempts: AUTO_CHECKIN_MAX_ATTEMPTS_PER_DAY }),
      results: { qoder: new Error('boom') },
    })
    const outcome = await h.run()
    expect(outcome.ran).toBe(false)
    expect(outcome.ran === false && outcome.reason).toBe('exhausted')
    expect(h.order).toEqual([])
  })

  it('失败后再次触发 ⇒ 计数续接（1 → 2），不是从头开始', async () => {
    const h = harness({
      state: stateAfter({ day: '2026-10-13', attempts: 1, succeeded: false }),
      results: { qoder: new Error('boom') },
    })
    await h.run()
    expect(h.state().attempts).toBe(2)
  })

  it('跨日触发 ⇒ 计数归零后 +1（昨天用满 3 次也不影响今天）', async () => {
    const h = harness({
      state: stateAfter({
        day: '2026-10-12', attempts: AUTO_CHECKIN_MAX_ATTEMPTS_PER_DAY, succeeded: false,
      }),
    })
    await h.run()
    expect(h.state().day).toBe('2026-10-13')
    expect(h.state().attempts).toBe(1)
  })

  it('开关关闭 ⇒ 不执行、不写盘、且**不刷日志**（避免每次启动都刷一条噪音）', async () => {
    const h = harness({ state: stateAfter({ enabled: false }) })
    const outcome = await h.run()
    expect(outcome).toEqual({ ran: false, reason: 'disabled', state: expect.anything() })
    expect(h.order).toEqual([])
    expect(h.saved).toEqual([])
    expect(h.logs).toEqual([])
  })

  it('force 越过「当天已签完」，但**不越过开关**', async () => {
    const done = harness({
      state: stateAfter({ day: '2026-10-13', attempts: 1, succeeded: true }),
      results: { qoder: claimed() },
    })
    const forced = await done.run({ force: true })
    expect(forced.ran).toBe(true)
    expect(done.order).toEqual(['qoder'])

    const off = harness({ state: stateAfter({ enabled: false }), results: { qoder: claimed() } })
    const stillOff = await off.run({ force: true })
    expect(stillOff.ran).toBe(false)
    expect(off.order).toEqual([])
  })

  it('日志：开始、逐渠道、完成三行俱全（用户与排查者据此判断发生了什么）', async () => {
    const h = harness({ results: { codearts: claimed(1800), qoder: claimed(100) } })
    await h.run()
    expect(h.logs[0]).toContain('开始（2 个渠道，2026-10-13 第 1 次）')
    expect(h.logs.some((line) => line.includes('codearts 领取 1 个，+1800 积分'))).toBe(true)
    expect(h.logs[h.logs.length - 1]).toContain('共 +1900 积分')
  })

  it('skipReasonText 覆盖全部四种原因（穷尽性：新增原因时此处编译报错）', () => {
    const state = stateAfter({ attempts: 2 })
    expect(skipReasonText('disabled', state)).toContain('开关')
    expect(skipReasonText('done', state)).toContain('今天已签完')
    expect(skipReasonText('running', state)).toContain('尚未结束')
    expect(skipReasonText('exhausted', state)).toContain('已尝试 2 次')
  })
})

describe('渠道清单与客户端能力表对账', () => {
  /**
   * host 侧 `AUTO_CHECKIN_PROVIDERS` 与客户端 `checkinProviders()` 必须逐条一致。
   *
   * host **无法** import 那份表（它在 `plugin-src/`，客户端纯 JS、独立打包），
   * 故只能各写一份 + 由本用例守住。漂移的后果：
   * - 漏一个 ⇒ 该渠道**永远不被自动签到**（用户不会察觉，只是每天少领一份）；
   * - 多一个 ⇒ 每天对它发**必然失败**的请求（CodeArts 早期的同型缺陷）。
   *
   * 顺序也断言：它决定执行顺序，zcode（要拉起 chromium）排在最后是有意的。
   */
  it('AUTO_CHECKIN_PROVIDERS 与 checkinProviders() 逐条一致（含顺序）', () => {
    expect([...AUTO_CHECKIN_PROVIDERS]).toEqual(checkinProviders())
  })

  it('清单非空且无重复（脏清单会让同一渠道被签两次）', () => {
    expect(AUTO_CHECKIN_PROVIDERS.length).toBeGreaterThan(0)
    expect(new Set(AUTO_CHECKIN_PROVIDERS).size).toBe(AUTO_CHECKIN_PROVIDERS.length)
  })
})

describe('默认状态', () => {
  it('默认开启（用户 2026-10-13 定：装上即自动领）', () => {
    expect(defaultAutoCheckinState().enabled).toBe(true)
  })

  it('从未执行过 ⇒ day/lastRunAt 为 null、attempts 为 0', () => {
    expect(defaultAutoCheckinState()).toMatchObject({
      day: null, attempts: 0, succeeded: false, lastRunAt: null, lastResults: [],
    })
  })

  it('上限为 3 次/天（用户定值，改动前先确认）', () => {
    expect(AUTO_CHECKIN_MAX_ATTEMPTS_PER_DAY).toBe(3)
  })
})
