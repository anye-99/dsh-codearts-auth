import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeAutoCheckin, formatAutoCheckinTime } from '../../plugin-src/client/auto-checkin-panel.js'

/**
 * 「每日自动签到」状态条的回归测试。
 *
 * 本仓库的单测环境里**没有 react**（见 `provider-toggle.spec.ts` 的说明），
 * 故分工是：**判定与文案**全部落在 `auto-checkin-panel.js` 的纯函数里，由下面
 * 的真实用例覆盖；组件侧的**结构与调用**（动词名、样式类、定义顺序）只能做
 * 源码级断言。两者覆盖的是不同的东西，不是拿字符串匹配凑数。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const jetHubSource = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub.js'), 'utf8')

/** host 侧 `AutoCheckinStatusSnapshot` 的最小替身。 */
function snapshot(overrides = {}) {
  return {
    enabled: true,
    attempts: 1,
    succeeded: true,
    day: '2026-10-13',
    lastRunAt: new Date(2026, 9, 13, 9, 12).getTime(),
    lastResults: [],
    summary: { claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0 },
    running: false,
    maxAttemptsPerDay: 3,
    storeKind: 'file',
    ...overrides,
  }
}

const LABELS = { qoder: 'Qoder', zcode: 'ZCode', codearts: 'CodeArts' }
const labelOf = (id) => LABELS[id]

describe('formatAutoCheckinTime', () => {
  it('格式为 MM-DD HH:mm（补零）', () => {
    expect(formatAutoCheckinTime(new Date(2026, 0, 5, 7, 3).getTime())).toBe('01-05 07:03')
    expect(formatAutoCheckinTime(new Date(2026, 11, 31, 23, 59).getTime())).toBe('12-31 23:59')
  })

  it('非法输入返回空串（调用方据此判「从未执行过」）', () => {
    for (const bad of [null, undefined, 0, -1, NaN, 'x', {}]) {
      expect(formatAutoCheckinTime(bad)).toBe('')
    }
  })
})

describe('describeAutoCheckin：读不到时整条不渲染', () => {
  it('null / undefined / 非对象 ⇒ null', () => {
    expect(describeAutoCheckin(null)).toBeNull()
    expect(describeAutoCheckin(undefined)).toBeNull()
    expect(describeAutoCheckin('x')).toBeNull()
    expect(describeAutoCheckin([])).toBeNull()
  })
})

describe('describeAutoCheckin：关闭态', () => {
  const view = describeAutoCheckin(snapshot({ enabled: false }))

  it('文案说明「手动一键签到不受影响」，且用中性配色（不是故障）', () => {
    expect(view.text).toContain('已关闭')
    expect(view.text).toContain('手动「一键签到」不受影响')
    expect(view.tone).toBeUndefined()
  })

  it('开关按钮变成「开启自动签到」', () => {
    expect(view.toggleLabel).toBe('开启自动签到')
    expect(view.toggleTitle).toContain('每次打开 DSH')
  })
})

describe('describeAutoCheckin：开启态', () => {
  it('尚未执行过 ⇒ 说明下次打开会签到（不显示「上次 …」）', () => {
    const view = describeAutoCheckin(snapshot({ lastRunAt: null }))
    expect(view.text).toContain('已开启')
    expect(view.text).toContain('每次打开 DSH 会自动签到')
    expect(view.text).not.toContain('上次')
    expect(view.toggleLabel).toBe('关闭自动签到')
  })

  it('正在执行时附「正在签到…」', () => {
    const view = describeAutoCheckin(snapshot({ lastRunAt: null, running: true }))
    expect(view.text).toContain('正在签到…')
  })

  it('有结果 ⇒ 时间 + 汇总积分 + **四个计数全列**（不用 else-if 短路）', () => {
    const view = describeAutoCheckin(snapshot({
      summary: { claimed: 3, totalCredit: 1800, alreadyClaimed: 5, inactive: 1, failed: 0 },
      succeeded: true,
    }))
    expect(view.text).toContain('上次 10-13 09:12')
    expect(view.text).toContain('+1800 积分')
    // ⚠️ 四个计数必须同时出现 —— 只显示第一个非零项会让其余信息整条消失
    //（既有「一键签到」提示踩过这个坑：用户只知道 A 已领，不知道 C 执行过）。
    expect(view.text).toContain('3 个新领取')
    expect(view.text).toContain('5 个今日已领')
    expect(view.text).toContain('1 个暂无活动')
    expect(view.text).toContain('0 个失败')
    expect(view.text).toContain('当天已完成')
    expect(view.tone).toBe('ok')
  })

  it('失败 ⇒ tone 为 warn，且失败渠道**单列**（带展示名与原因）', () => {
    const view = describeAutoCheckin(snapshot({
      succeeded: false,
      summary: { claimed: 0, totalCredit: 0, alreadyClaimed: 1, inactive: 0, failed: 1 },
      lastResults: [
        { provider: 'qoder', ok: true, summary: { claimed: 0, totalCredit: 0, alreadyClaimed: 1, inactive: 0, failed: 0 } },
        { provider: 'zcode', ok: false, error: '没有可用浏览器' },
      ],
    }), labelOf)
    expect(view.tone).toBe('warn')
    expect(view.notes).toEqual(['ZCode：没有可用浏览器'])
    expect(view.text).toContain('下次打开 DSH 会重试')
  })

  it('「暂无活动」也单列，并说明多数活动 10:00（UTC+8）刷新', () => {
    const view = describeAutoCheckin(snapshot({
      succeeded: false,
      summary: { claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 1, failed: 0 },
      lastResults: [
        { provider: 'qoder', ok: true, summary: { claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 1, failed: 0 } },
      ],
    }), labelOf)
    expect(view.notes).toHaveLength(1)
    expect(view.notes[0]).toContain('Qoder：暂无活动')
    expect(view.notes[0]).toContain('10:00（UTC+8）')
  })

  it('拿不到展示名时退回 provider id（不显示空白）', () => {
    const view = describeAutoCheckin(snapshot({
      succeeded: false,
      lastResults: [{ provider: 'unknownprovider', ok: false, error: 'x' }],
    }))
    expect(view.notes[0]).toContain('unknownprovider：x')
  })

  it('当天次数用尽 ⇒ 明说「今天已尝试 N/3 次」，tone 为 warn', () => {
    const view = describeAutoCheckin(snapshot({ succeeded: false, attempts: 3, maxAttemptsPerDay: 3 }))
    expect(view.tone).toBe('warn')
    expect(view.text).toContain('今天已尝试 3/3 次仍有失败，明天再自动重试')
  })

  it('跨日后（attempts 归零、succeeded false）仍显示「下次打开会重试」，不误报用尽', () => {
    const view = describeAutoCheckin(snapshot({ succeeded: false, attempts: 1, maxAttemptsPerDay: 3 }))
    expect(view.text).toContain('下次打开 DSH 会重试')
    expect(view.text).not.toContain('明天再自动重试')
  })

  it('⚠️ storeKind 为 memory ⇒ 警告排在首位（重启即丢，用户必须知道）', () => {
    const view = describeAutoCheckin(snapshot({
      storeKind: 'memory',
      succeeded: false,
      lastResults: [{ provider: 'zcode', ok: false, error: 'x' }],
    }), labelOf)
    expect(view.notes[0]).toContain('仅存于内存')
    expect(view.notes[1]).toContain('ZCode：x')
  })

  it('summary 缺失 / 字段非法都不抛错（按 0 渲染）', () => {
    const view = describeAutoCheckin(snapshot({ summary: undefined, lastResults: 'x' }))
    expect(view.text).toContain('0 个新领取')
    expect(view.notes).toEqual([])
  })
})

describe('面板与 host 的契约（源码级）', () => {
  it('面板用 checkin.auto.get / checkin.auto.set 两个动词（与 host 的 case 同名）', () => {
    expect(jetHubSource).toContain("rpcCall('checkin.auto.get'")
    expect(jetHubSource).toContain("rpcCall('checkin.auto.set'")
  })

  it('⚠️ loadAutoCheckin 必须定义在依赖它的 useEffect **之前**（否则 TDZ 白屏）', () => {
    const defined = jetHubSource.indexOf('const loadAutoCheckin = React.useCallback')
    const used = jetHubSource.indexOf('void loadAutoCheckin();')
    expect(defined).toBeGreaterThan(-1)
    expect(used).toBeGreaterThan(-1)
    // 依赖数组在渲染时立即求值 ⇒ 定义在后会命中 `const` 的 TDZ
    //（`Cannot access 'loadAutoCheckin' before initialization`），整页白屏。
    expect(defined).toBeLessThan(used)
  })

  it('状态条复用既有提示样式（不引入新样式类）', () => {
    // 以「状态条的 data-tone」为锚点取一小段窗口：类名与它同在一个
    // `React.createElement` 调用里，故窗口内必然命中（比全局 contains 更能
    // 证明「这两个类名确实用在这条状态条上」）。
    const anchor = jetHubSource.indexOf("'data-tone': autoCheckinView.tone")
    expect(anchor).toBeGreaterThan(-1)
    const block = jetHubSource.slice(anchor - 400, anchor + 1200)
    expect(block).toContain("className: 'dim-jh-probeNotice'")
    expect(block).toContain('dim-jh-probeDetails')
  })

  it('渲染依赖 describeAutoCheckin 的结果（判定不在组件里）', () => {
    expect(jetHubSource).toContain('const autoCheckinView = describeAutoCheckin(')
  })
})
