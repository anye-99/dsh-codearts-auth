import { describe, expect, it } from 'vitest'
import { ALL_LOOMY_PRODUCTS, LOOMY, loomyProductById } from '../../src/loomy-product.js'

describe('Loomy 产品配置', () => {
  it('provider id 与展示名', () => {
    expect(LOOMY.id).toBe('loomy')
    expect(LOOMY.displayName).toBe('Loomy (讯飞)')
  })

  /**
   * ⚠️ 生产域名是 `loomyad.xunfei.cn`，**不是** `ossptest.voicecloud.cn`。
   * 后者只是 `points-config.js:16` 的代码兜底默认值（本机 points-config.json
   * 里存的正是这个误导值），实际被 `.env.prod` 覆盖。
   * 依据：`share/share-env.js:4-25` 把生产与集成两者并列写明。
   */
  it('base URL 用生产域名（不是 ossptest 测试域名）', () => {
    expect(LOOMY.apiBase).toBe('https://loomyad.xunfei.cn/api/v1')
    expect(LOOMY.accountBase).toBe('https://account.xfinfr.com')
    expect(LOOMY.apiBase).not.toContain('ossptest')
  })

  it('内置讯飞账号 AccessKey 与 appId 非空', () => {
    expect(LOOMY.accessKeyId.length).toBeGreaterThan(0)
    expect(LOOMY.accessKeySecret.length).toBeGreaterThan(0)
    expect(LOOMY.appId).toBe('GM3LOOMY')
  })

  it('默认凭据 ref 与其它 provider 隔离', () => {
    expect(LOOMY.defaultCredentialRef).toBe('LOOMY_ACCESS_TOKEN')
  })

  it('兜底模型表覆盖 9 个 chat 模型、id 唯一', () => {
    // ⚠️ 2026-10-09：远端共 13 条（chat 10，含聚合入口 `auto`），
    // 兜底表收录其中的 9 个真实模型（`auto` 是聚合入口，不收录）。
    const ids = LOOMY.fallbackModels.map((m) => m.id)
    expect(ids).toHaveLength(9)
    expect(new Set(ids).size).toBe(9)
    // 与实测远端 chat 集合逐一对齐（不含 `auto`）
    expect([...ids].sort()).toEqual([
      'DeepSeek-V4.1-Flash', 'GLM-5.3-Flash', 'Kimi-k2.6', 'MiniMax-M3',
      'deepseek-v4-flash-0731', 'mimo-v2.5', 'qwen-3.8-max', 'qwen3.8-flash', 'spark-x',
    ].sort())
  })

  it('2026-10-09 新增 DeepSeek-V4.1-Flash（远端 is_default_model）', () => {
    const byId = new Map(LOOMY.fallbackModels.map((m) => [m.id, m]))
    const added = byId.get('DeepSeek-V4.1-Flash')
    expect(added).toBeDefined()
    expect(added!.name).toBe('DeepSeek V4.1 Flash · x2.0')
    expect(added!.contextWindow).toBe(1_048_576)
  })

  it('不含聚合入口 auto（与 buddy 的 isAutoSelectAlias 同型）', () => {
    // `auto`（`自动 · 均衡`）缺全部能力元数据，是自动选模入口而非真实模型。
    expect(LOOMY.fallbackModels.map((m) => m.id)).not.toContain('auto')
  })

  it('兜底模型名已含规范化倍率（用 · 分隔）', () => {
    const byId = new Map(LOOMY.fallbackModels.map((m) => [m.id, m.name]))
    expect(byId.get('MiniMax-M3')).toBe('MiniMax M3 · x4.0')
    expect(byId.get('qwen-3.8-max')).toBe('Qwen 3.8 Max · x12.0')
    // ⚠️ spark-x 的倍率位已被上游改成**状态文案**「限时免费」（上游不再下发 x0.1），
    // 故这里与远端保持一致 —— 「倍率必须显示」在此处无法由我们满足。
    expect(byId.get('spark-x')).toBe('Spark X2.5（限时免费）')
  })

  it('loomyProductById 能查到，未知 id 返回 undefined', () => {
    expect(loomyProductById('loomy')).toBe(LOOMY)
    expect(loomyProductById('nope')).toBeUndefined()
  })

  it('ALL_LOOMY_PRODUCTS 含且仅含 LOOMY', () => {
    expect(ALL_LOOMY_PRODUCTS).toEqual([LOOMY])
  })
})
