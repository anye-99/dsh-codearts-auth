import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  groupProviders,
  providerSwitchRows,
  providerSwitchState,
  providerToggleSummary,
  summarizeProviderToggle,
} from '../../plugin-src/client/provider-toggle.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub.js'), 'utf8')
const styles = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub-styles.js'), 'utf8')

/** 最小供应商定义（只用到 id，与真实 PROVIDERS 的结构一致）。 */
const P = (id) => ({ id, label: id })

/**
 * 取 `ProviderSwitchPanel` 组件的整段源码（到 `JetHubPage` 之前）。
 *
 * 本仓库的单测环境里没有 react，组件无法渲染 —— 结构与类名只能做源码级断言，
 * 而**判定**（谁该禁用、为什么禁用、顺序怎么排）全部在 `provider-toggle.js` 里，
 * 由下面的真实用例覆盖。两者分工不同，不是拿字符串匹配凑数。
 */
function panelBody(): string {
  const start = source.indexOf('function ProviderSwitchPanel(')
  expect(start, '找不到 ProviderSwitchPanel 组件').toBeGreaterThan(-1)
  const end = source.indexOf('export function JetHubPage', start)
  return source.slice(start, end === -1 ? undefined : end)
}

describe('groupProviders（左侧分组）', () => {
  it('按 closed 分成两组，且保持传入顺序', () => {
    const providers = [P('a'), P('b'), P('c'), P('d')]
    const statuses = {
      a: { closed: false },
      b: { closed: true },
      c: { closed: false },
      d: { closed: true },
    }
    const { open, closed } = groupProviders(providers, statuses)
    expect(open.map(p => p.id)).toEqual(['a', 'c'])
    expect(closed.map(p => p.id)).toEqual(['b', 'd'])
  })

  it('组内顺序就是传入顺序，不重排（用户认知顺序必须稳定）', () => {
    const providers = [P('z'), P('a'), P('m')]
    const { open } = groupProviders(providers, {})
    expect(open.map(p => p.id)).toEqual(['z', 'a', 'm'])
  })

  it('状态缺失的供应商归入「已打开」（宁多勿少，避免一次失败看成全被关）', () => {
    const providers = [P('a'), P('b')]
    const { open, closed } = groupProviders(providers, { a: { closed: true } })
    expect(open.map(p => p.id)).toEqual(['b'])
    expect(closed.map(p => p.id)).toEqual(['a'])
  })

  it('closed 只认显式 true（与黑名单「非 true 即打开」的判据一致）', () => {
    const providers = [P('a'), P('b'), P('c')]
    const statuses = { a: { closed: 1 }, b: { closed: 'true' }, c: { closed: undefined } }
    expect(groupProviders(providers, statuses).open.map(p => p.id)).toEqual(['a', 'b', 'c'])
    expect(groupProviders(providers, statuses).closed).toEqual([])
  })

  it('statuses 为 null / 非对象时不抛错，全部归入已打开', () => {
    const providers = [P('a'), P('b')]
    expect(groupProviders(providers, null).open).toHaveLength(2)
    expect(groupProviders(providers, null).closed).toHaveLength(0)
    expect(groupProviders(providers, 'bogus').open).toHaveLength(2)
  })

  it('providers 非数组时返回两个空组（不抛错）', () => {
    const { open, closed } = groupProviders(null, {})
    expect(open).toEqual([])
    expect(closed).toEqual([])
  })
})

describe('providerSwitchState（开关三形态）', () => {
  it('有模型且未全关 → 已打开（checked=true），可点击', () => {
    const s = providerSwitchState({ models: { total: 30, disabled: 13 }, closed: false })
    expect(s).toEqual({ checked: true, disabled: false, reason: null })
  })

  it('全部模型已关闭 → checked=false（开关呈关闭态），仍可点击以重新打开', () => {
    const s = providerSwitchState({ models: { total: 17, disabled: 17 }, closed: true })
    expect(s.checked).toBe(false)
    expect(s.disabled).toBe(false)
  })

  /**
   * ⚠️ 真实缺陷（用户报障 2026-10-18）：零模型供应商原先被禁用，于是
   * 「Step Code（阶跃）」既显示已打开、又点不动 —— 永远关不掉。
   */
  it('① 没有任何模型 → **不再禁用**（服务端已支持无模型时关闭）', () => {
    const s = providerSwitchState({ models: { total: 0, disabled: 0 }, closed: false })
    expect(s.disabled).toBe(false)
    expect(s.checked).toBe(true)
    expect(s.reason).toBeNull()
  })

  it('② 状态未知（undefined）→ 禁用并说明原因', () => {
    const s = providerSwitchState(undefined)
    expect(s.disabled).toBe(true)
    expect(s.reason).toBeTruthy()
  })

  it('③ 状态非对象（异常输入）→ 禁用而不是抛错', () => {
    expect(providerSwitchState(null).disabled).toBe(true)
    expect(providerSwitchState('bogus').disabled).toBe(true)
  })

  it('models 字段缺失 → 按无模型处理（可点击）', () => {
    expect(providerSwitchState({ accounts: { total: 1 } }).disabled).toBe(false)
  })

  it('total 为负数等非法值 → 按无模型处理（可点击）', () => {
    expect(providerSwitchState({ models: { total: -5 } }).disabled).toBe(false)
  })
})

describe('summarizeProviderToggle（结果文案）', () => {
  it('关闭：报告实际关闭的模型与停用的账号数', () => {
    expect(summarizeProviderToggle(false, { models: 17, accounts: 1 }))
      .toBe('已关闭 17 个模型，已停用 1 个账号')
  })

  it('打开：报告实际打开的模型与启用的账号数', () => {
    expect(summarizeProviderToggle(true, { models: 17, accounts: 2 }))
      .toBe('已打开 17 个模型，已启用 2 个账号')
  })

  it('⚠️ 变更数为 0 时不得谎报「已停用 N 个」（幂等操作要照实说）', () => {
    expect(summarizeProviderToggle(false, { models: 5, accounts: 0 }))
      .toBe('已关闭 5 个模型，没有账号需要停用')
  })

  it('两侧都为 0 时如实说明无事可做', () => {
    expect(summarizeProviderToggle(true, { models: 0, accounts: 0 }))
      .toBe('模型本就全部打开，账号本就全部启用')
  })

  it('res 缺失 / 字段非数字时不抛错，按 0 处理', () => {
    expect(summarizeProviderToggle(false, null)).toBe('没有模型需要关闭，没有账号需要停用')
    expect(summarizeProviderToggle(false, { models: 'x', accounts: null }))
      .toBe('没有模型需要关闭，没有账号需要停用')
  })
})

/**
 * 「供应商开关」弹窗的行数据。
 *
 * 弹窗要渲染的是「供应商定义 × 状态表」的拼接结果（顺序、勾选态、禁用态与原因、
 * 影响面计数），这些判定必须在纯逻辑层，不能留在渲染层 —— 否则左侧分组与弹窗
 * 两处各写一遍，迟早出现「左侧说它关了、弹窗里它还是开的」。
 */
describe('providerSwitchRows（弹窗行数据）', () => {
  it('⚠️ 已打开在前、已关闭在后，与左侧分组同一判据', () => {
    const providers = [P('a'), P('b'), P('c'), P('d')]
    const statuses = {
      a: { closed: false, models: { total: 3, disabled: 0 } },
      b: { closed: true, models: { total: 2, disabled: 2 } },
      c: { closed: false, models: { total: 1, disabled: 0 } },
      d: { closed: true, models: { total: 4, disabled: 4 } },
    }
    const rows = providerSwitchRows(providers, statuses)
    expect(rows.map(r => r.id)).toEqual(['a', 'c', 'b', 'd'])
    expect(rows.map(r => r.checked)).toEqual([true, true, false, false])
  })

  it('每行带出影响面计数，供界面显示「模型 N（已关 M）· 账号 X（启用 Y）」', () => {
    const rows = providerSwitchRows([P('a')], {
      a: { closed: false, models: { total: 12, disabled: 3 }, accounts: { total: 5, enabled: 2 } },
    })
    expect(rows[0].models).toEqual({ total: 12, disabled: 3 })
    expect(rows[0].accounts).toEqual({ total: 5, enabled: 2 })
  })

  it('⚠️ 状态缺失时计数是 null 而不是 0（「不知道」与「确实是 0」必须能区分）', () => {
    const rows = providerSwitchRows([P('a')], {})
    expect(rows[0].models).toBeNull()
    expect(rows[0].accounts).toBeNull()
    expect(rows[0].disabled).toBe(true)
    expect(rows[0].reason).toBe('状态尚未读取')
  })

  it('没有可关闭模型的供应商不再被禁用（服务端已支持无模型时关闭）', () => {
    const rows = providerSwitchRows([P('a')], { a: { models: { total: 0, disabled: 0 } } })
    expect(rows[0].disabled).toBe(false)
    expect(rows[0].reason).toBeNull()
    // 未被标记关闭的仍显示为「打开」。
    expect(rows[0].checked).toBe(true)
  })

  it('label 缺失时回退到 id（界面上不会出现空行）', () => {
    const rows = providerSwitchRows([{ id: 'codearts' }], { codearts: { models: { total: 1 } } })
    expect(rows[0].label).toBe('codearts')
  })

  it('statuses 为 null / 非对象、providers 非数组时都不抛错', () => {
    expect(providerSwitchRows([P('a')], null).map(r => r.disabled)).toEqual([true])
    expect(providerSwitchRows([P('a')], 'bogus')[0].reason).toBe('状态尚未读取')
    expect(providerSwitchRows(null, {})).toEqual([])
  })

  it('⚠️ 与 groupProviders 的结论必须一致（两处判据不能漂移）', () => {
    const providers = [P('a'), P('b'), P('c')]
    const statuses = { a: { closed: true, models: { total: 2 } }, b: { models: { total: 2 } } }
    const { open, closed } = groupProviders(providers, statuses)
    const rows = providerSwitchRows(providers, statuses)
    expect(rows.filter(r => r.checked).map(r => r.id)).toEqual(open.map(p => p.id))
    expect(rows.filter(r => !r.checked).map(r => r.id)).toEqual(closed.map(p => p.id))
  })
})

describe('providerToggleSummary（页头与弹窗的计数）', () => {
  it('给出 open / closed / total 与 known', () => {
    const providers = [P('a'), P('b'), P('c')]
    const statuses = { a: { closed: true }, b: { closed: false }, c: { closed: true } }
    expect(providerToggleSummary(providers, statuses))
      .toEqual({ open: 1, closed: 2, total: 3, known: true })
  })

  it('⚠️ 状态没读回来时 known=false 且计数为 0 —— 界面据此**不显示**计数', () => {
    // 「已打开 0、已关闭 0」会被读成「一个供应商都没有」，而真实原因只是
    // provider.status 还没回来（或失败了）。
    expect(providerToggleSummary([P('a'), P('b')], null)).toEqual({
      open: 2, closed: 0, total: 2, known: false,
    })
    expect(providerToggleSummary([P('a')], undefined).known).toBe(false)
  })

  it('closed 只认显式 true（与分组、行数据三处同一口径）', () => {
    const providers = [P('a'), P('b')]
    const statuses = { a: { closed: 'true' }, b: { closed: 1 } }
    expect(providerToggleSummary(providers, statuses)).toMatchObject({ open: 2, closed: 0 })
  })

  it('providers 非数组时 total 为 0 且不抛错', () => {
    expect(providerToggleSummary(null, {})).toEqual({ open: 0, closed: 0, total: 0, known: true })
  })
})

describe('供应商开关的接线（源码级回归）', () => {
  it('引用了纯逻辑模块，而不是在本文件里另写一份判定', () => {
    expect(source).toContain("from './provider-toggle.js'")
    expect(source).toContain('groupProviders(')
    expect(source).toContain('providerSwitchRows(')
    expect(source).toContain('providerToggleSummary(')
  })

  it('rail 渲染出两个分组标题并带计数', () => {
    expect(source).toContain('dim-jh-railGroup')
    expect(source).toContain('dim-jh-railGroupTitle')
    expect(source).toContain('`已打开 (${open.length})`')
    expect(source).toContain('`已关闭 (${closed.length})`')
  })

  /**
   * ⚠️ 这条锁的是本次改动的**核心要求**：开关不得再挂在左侧供应商行尾。
   * 它曾与「选择要看哪个供应商」这个高频无害动作挤在同一行 —— 一个破坏性批量
   * 操作挂在导航栏上，既容易误点，也让窄栏长出了控件。
   */
  it('⚠️ 左侧供应商行里不再有开关（只剩一个 tab 按钮）', () => {
    const start = source.indexOf('const renderProviderRow = (p) => {')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('const renderRail = () =>'))
    expect(body).not.toContain("React.createElement('input'")
    expect(body).not.toContain("type: 'checkbox'")
    expect(body).toContain("role: 'tab'")
    // 行容器仍不挂 onClick：点击只属于 tab 按钮。
    expect(body).toContain("className: 'dim-jh-providerRow'")
    expect(body).not.toMatch(/dim-jh-providerRow'[^}]*onClick/)
  })

  it('开关搬进弹窗：页头按钮点开，关闭即不挂载', () => {
    // ⚠️ 按钮文字是「供应商」而不是「供应商开关」：页头要排成一排，
    // 5 个字会把「关闭」挤到第二行。完整语义由 tooltip 与弹窗标题承担。
    expect(source).toContain("}, '供应商')")
    expect(source).toContain('title: (providerSummary.known')
    expect(source).toContain('onClick: () => setShowProviderSwitches(true)')
    // ⚠️ 不跨行断言：源文件是 CRLF，含 `\n` 的字面量匹配不上。
    expect(source).toContain('? React.createElement(ProviderSwitchPanel')
    expect(source).toContain('onClose: () => setShowProviderSwitches(false)')
  })

  it('弹窗行是 <label> + **恰好一个** checkbox（第二个会让「点行名」激活错控件）', () => {
    const body = panelBody()
    expect(body.match(/React\.createElement\('label'/g) ?? []).toHaveLength(1)
    expect(body.match(/type: 'checkbox'/g) ?? []).toHaveLength(1)
    expect(body).toContain("role: 'switch'")
    expect(body).toContain('checked: row.checked')
    expect(body).toContain('disabled: row.disabled || busy')
  })

  it('弹窗复用模型列表那套结构与类名，不另起一套', () => {
    const body = panelBody()
    for (const cls of [
      'dim-jh-modalOverlay', 'dim-jh-modalHead', 'dim-jh-modalHint',
      'dim-jh-modalBody', 'dim-jh-modelList', 'dim-jh-modelRow',
      'dim-jh-modelInfo', 'dim-jh-modelName', 'dim-jh-modelId', 'dim-jh-switch',
    ]) {
      expect(body, `弹窗缺少与模型列表共用的类名 ${cls}`).toContain(cls)
    }
    // ESC 关闭挂在 document 上：焦点可能落在任意一个开关上。
    expect(body).toContain("document.addEventListener('keydown', onKeyDown)")
  })

  it('已关闭的行整行淡出（data-disabled 表达「已关闭」，点不动才用 input disabled）', () => {
    expect(panelBody()).toContain("'data-disabled': row.checked ? 'false' : 'true'")
  })

  it('状态没读回来时不显示计数，也不谎报「已打开 0」', () => {
    expect(source).toContain('providerSummary.known')
    const body = panelBody()
    expect(body).toContain('summary.known')
    expect(body).toContain('statusFailed ?')
  })

  it('状态未就绪时退化为不分组平铺（不阻断账号管理）', () => {
    expect(source).toContain('if (providerStatuses === null)')
  })

  it('关闭前必须确认，且文案给出影响面', () => {
    expect(source).toContain('确认关闭「${label}」？')
    expect(source).toContain('取消则不做任何变更')
  })
})

describe('供应商开关的样式约束（源码级回归）', () => {
  /**
   * ⚠️ 这条锁的是用户报障「去掉开关后右边有片空白」。
   *
   * !25 时代这里是 `minmax(0, 1fr) auto` 两列（第二列放行尾开关）。开关搬到弹窗后，
   * 那列虽然 0 宽，**8px 的列间距却照样计入** —— 卡片右侧就多出一条看着像
   * 「rail 没铺满」的空白。所以这里断言「只有一列」，而不是「首列是 1fr」。
   * 首列仍必须是 `minmax(0, 1fr)`（不能是裸 `1fr`）：grid 项 min-width 默认 auto，
   * 长供应商名会把行撑宽、撑出 rail。
   */
  it('⚠️ .dim-jh-providerRow 只有**一列**（开关搬走后不得留下空列与列间距）', () => {
    expect(styles).toMatch(/\.dim-jh-providerRow \{[^}]*grid-template-columns: minmax\(0, 1fr\);/)
    expect(styles).not.toMatch(/\.dim-jh-providerRow \{[^}]*grid-template-columns:[^;]*auto/)
  })

  it('.dim-jh-providerRow 内的 .dim-jh-provider 允许收缩（min-width: 0）', () => {
    expect(styles).toMatch(/\.dim-jh-providerRow \.dim-jh-provider \{[^}]*min-width: 0/)
  })

  /**
   * 228px 是「给右侧让位」与「最长行不出省略号」的交点（用户先要收窄、
   * 随后报障「workbuddy国际版有省略号」—— 两个诉求在这条宽度上才同时成立）：
   * 可用文字宽 = 228 − 12(rail padding) − 2(边框) − 20(按钮 padding) − 30(图标)
   *                  − 8(图标间距) − 15(滚动条) = **143px**
   * 最长行 WorkBuddy (国际版) 实测要 141px（!25 实测表：200px + 开关时标签剩 77px、
   * 该行超宽 64px ⇒ 77 + 64 = 141）。
   * ⚠️ 再往回收就会截断；要更窄只能改短 label，而那会与 RaccoonProduct 等
   * displayName 的跨文件一致性断言冲突（见 raccoon-client-panel.spec.ts）。
   */
  it('rail 228px：省出开关那 8px 空列后，仍刚好不截断最长行', () => {
    expect(styles).toMatch(/\.dim-jh-rail \{ width: 228px;/)
    // 图标间距与按钮 padding 各收窄 2px 是「用开销换文字宽度」的一部分，别改回去。
    expect(styles).toMatch(/\.dim-jh-provider \{[^}]*gap: 8px; padding: 8px 10px/)
  })

  it('弹窗里的开关保持 flex: none（目标控件不参与收缩）', () => {
    expect(styles).toMatch(/\.dim-jh-switch \{[^}]*flex: none/)
  })

  /**
   * ⚠️ 页头按钮必须排成一排（用户报障：加了开关入口之后「关闭」掉到第二行）。
   * 三处配合缺一不可：brand 让出宽度、副标题单行省略、按钮组不参与收缩。
   */
  it('页头按钮排成一排：brand 可收缩 + 副标题单行省略 + 按钮组不收缩', () => {
    expect(styles).toMatch(/\.dim-jh-brand \{[^}]*min-width: 0/)
    expect(styles).toMatch(/\.dim-jh-brandDesc \{[^}]*white-space: nowrap[^}]*text-overflow: ellipsis/)
    expect(styles).toMatch(/\.dim-jh-headerActions \{[^}]*flex: none/)
    // 极窄窗口的兜底仍在：换行好过溢出到窗口外点不到。
    expect(styles).toMatch(/\.dim-jh-headerActions \{[^}]*flex-wrap: wrap/)
  })
})