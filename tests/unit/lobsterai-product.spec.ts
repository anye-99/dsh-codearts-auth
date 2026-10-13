import { describe, expect, it } from 'vitest'
import {
  ALL_LOBSTERAI_PRODUCTS,
  LOBSTERAI,
  LOBSTERAI_API_BASE,
  LOBSTERAI_CLIENT_CAPABILITIES,
  LOBSTERAI_FALLBACK_CLIENT_VERSION,
  LOBSTERAI_PORTAL_BASE,
  LOBSTERAI_USER_AGENT,
  lobsteraiProductById,
} from '../../src/lobsterai-product.js'

describe('LobsterAI 产品配置', () => {
  it('基础字段与实测值一致', () => {
    expect(LOBSTERAI).toMatchObject({
      id: 'lobsterai',
      displayName: 'LobsterAI (有道)',
      defaultCredentialRef: 'LOBSTERAI_ACCESS_TOKEN',
    })
  })

  it('API 基址来自 sigin.py:10 的实测值', () => {
    expect(LOBSTERAI.apiBase).toBe('https://lobsterai-server.youdao.com')
    expect(LOBSTERAI_API_BASE).toBe(LOBSTERAI.apiBase)
  })

  it('portal 基址来自实测（与 API 同 IP、同 CNAME）', () => {
    // 两个域名解析到同一 IP 与同一 CNAME 目标，但仍是两个独立字段：
    // Go 侧本就是两个 env，且不排除未来门户与 API 分离部署。
    expect(LOBSTERAI.portalBase).toBe('https://lobsterai.youdao.com')
    expect(LOBSTERAI_PORTAL_BASE).toBe(LOBSTERAI.portalBase)
  })

  it('portal 与 api 是**不同**的域名（这是与腾讯系最大的配置差异）', () => {
    // CodeBuddy / WorkBuddy 的登录与 API 共用一个 endpoint，
    // LobsterAI 则是同域不同路径的两个 host。
    expect(new URL(LOBSTERAI.portalBase).hostname).not.toBe(new URL(LOBSTERAI.apiBase).hostname)
  })

  it('两个基址都是 HTTPS 且无尾斜杠', () => {
    for (const base of [LOBSTERAI.portalBase, LOBSTERAI.apiBase]) {
      expect(base.startsWith('https://')).toBe(true)
      expect(base.endsWith('/')).toBe(false)
    }
  })

  it('版本号接口是第三方域名（与业务域名不同服务）', () => {
    expect(LOBSTERAI.clientVersionApi)
      .toBe('https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update')
    expect(new URL(LOBSTERAI.clientVersionApi).hostname).toBe('api-overmind.youdao.com')
  })

  it('兜底版本号是日期式形态（非语义化版本）', () => {
    // 实测真值形如 2026.9.4；Go 侧硬编码的 0.1.0 是假值。
    expect(LOBSTERAI.fallbackClientVersion).toBe(LOBSTERAI_FALLBACK_CLIENT_VERSION)
    expect(LOBSTERAI.fallbackClientVersion).toMatch(/^\d+(\.\d+)+$/)
    expect(LOBSTERAI.fallbackClientVersion).not.toBe('0.1.0')
  })

  it('UA 与 Capabilities 与实测实现一致', () => {
    expect(LOBSTERAI.userAgent).toBe(LOBSTERAI_USER_AGENT)
    expect(LOBSTERAI.userAgent).toBe('LobsterAI/0.1.0')
    expect(LOBSTERAI.clientCapabilities).toBe(LOBSTERAI_CLIENT_CAPABILITIES)
    // 能力值本身的语义断言见下方「LobsterAI 客户端能力声明」。
  })

  it('**不**含 CodeBuddy 系专有字段（避免被误当成 BuddyProduct 使用）', () => {
    for (const banned of ['apiDomain', 'productCode', 'attributionName', 'platform',
      'appendSessionParams', 'pluginVersion', 'userAgentByModelFamily', 'cliVersion', 'endpoint']) {
      expect(LOBSTERAI, banned).not.toHaveProperty(banned)
    }
  })
})

describe('LobsterAI 兜底模型目录', () => {
  it('含 30 个模型（2026-10-09 按远端 /api/models/available 实测重采）', () => {
    // ⚠️ 旧表是 19 条的编译期快照，实测远端已返回 30 条（漏 12、多 1）。
    expect(LOBSTERAI.fallbackModels).toHaveLength(30)
  })

  it('每个条目的 id / name / contextWindow 均完整有效', () => {
    for (const model of LOBSTERAI.fallbackModels) {
      expect(typeof model.id).toBe('string')
      expect(model.id.length).toBeGreaterThan(0)
      expect(typeof model.name).toBe('string')
      expect(model.name.length).toBeGreaterThan(0)
      expect(model.contextWindow).toBeGreaterThan(0)
    }
  })

  it('模型 id 唯一（重复会让选择器出现两个同名条目）', () => {
    const ids = LOBSTERAI.fallbackModels.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('覆盖四家厂商的实测模型', () => {
    const ids = new Set(LOBSTERAI.fallbackModels.map((m) => m.id))
    for (const id of ['deepseek-flash', 'deepseek-v4-pro', 'MiniMax-M3', 'qwen3.8-max',
      'kimi-k3', 'glm-5.2', 'doubao-seed-2-1-pro-260915']) {
      expect(ids.has(id), id).toBe(true)
    }
  })

  it('含 2026-10-09 新增的 12 条（旧表完全没有）', () => {
    const ids = new Set(LOBSTERAI.fallbackModels.map((m) => m.id))
    for (const id of [
      'deepseek-flash', 'glm-5.3-flashx', 'glm-5.3-flash', 'glm-5.3',
      'MiniMax-M3.1-Flash-Preview', 'qwen3.8-max', 'qwen3.8-flash',
      'qwen3.8-omni-flash', 'kimi-k3', 'kimi-k2.8-preview',
      'doubao-seed-2-1-pro-260915', 'deepseek-v4-flash-vision-exp',
    ]) {
      expect(ids.has(id), id).toBe(true)
    }
  })

  it('已撤下的 doubao-seed-2-1-pro-260628 不再收录', () => {
    // 远端已换成 -260915；留着会让用户选中一个上游不认的 id。
    const ids = new Set(LOBSTERAI.fallbackModels.map((m) => m.id))
    expect(ids.has('doubao-seed-2-1-pro-260628')).toBe(false)
  })

  it('顺序照抄远端原序（保持与上游对比时的可比性）', () => {
    expect(LOBSTERAI.fallbackModels[0]!.id).toBe('deepseek-flash')
    expect(LOBSTERAI.fallbackModels[1]!.id).toBe('deepseek-v4-pro')
    expect(LOBSTERAI.fallbackModels[29]!.id).toBe('doubao-seed-2-0-code-preview-260215')
  })

  it('contextWindow 以远端权威值为准，未下发的 9 条才用 131072 估值', () => {
    // ⚠️ 旧表**全部**填 131072（桥接层估值），会让 DSH 远早于真实能力触发压缩。
    // 远端实测 30 条里 21 条下发窗口（多数 1000000）。
    const withRemote = LOBSTERAI.fallbackModels.filter((m) => m.contextWindow !== 131_072)
    expect(withRemote).toHaveLength(21)
    expect(LOBSTERAI.fallbackModels.filter((m) => m.contextWindow === 131_072)).toHaveLength(9)
    // 抽查几个远端权威值（与 probe 采集一致）
    const byId = new Map(LOBSTERAI.fallbackModels.map((m) => [m.id, m]))
    expect(byId.get('deepseek-v4-flash')?.contextWindow).toBe(1_000_000)
    expect(byId.get('kimi-k3')?.contextWindow).toBe(1_048_576)
    expect(byId.get('kimi-k2.8-preview')?.contextWindow).toBe(262_144)
    expect(byId.get('doubao-seed-2-1-pro-260915')?.contextWindow).toBe(256_000)
  })

  it('展示名用远端 modelName（不再是裸 id）', () => {
    const byId = new Map(LOBSTERAI.fallbackModels.map((m) => [m.id, m]))
    // 旧表 19 条里有 16 条 name 就是 id 本身，列表里全是裸 id 无从辨认。
    expect(byId.get('deepseek-v4-flash')?.name).toBe('DeepSeek-V4-Flash')
    expect(byId.get('qwen3.5-plus-2026-04-20')?.name).toBe('Qwen3.5-plus')
    expect(byId.get('deepseek-flash')?.name).toBe('DeepSeek-V4.1-Flash')
  })
})

describe('lobsteraiProductById', () => {
  it('能按 id 查到配置', () => {
    expect(lobsteraiProductById('lobsterai')).toBe(LOBSTERAI)
  })

  it('对未知 id 返回 undefined（含 CodeBuddy 系的 id）', () => {
    // 两个 productById 刻意分开：返回类型不同，合并会让调用方不得不做类型收窄。
    expect(lobsteraiProductById('buddy')).toBeUndefined()
    expect(lobsteraiProductById('workbuddy')).toBeUndefined()
    expect(lobsteraiProductById('codearts')).toBeUndefined()
    expect(lobsteraiProductById('')).toBeUndefined()
  })

  it('ALL_LOBSTERAI_PRODUCTS 含且仅含 LobsterAI', () => {
    expect(ALL_LOBSTERAI_PRODUCTS).toEqual([LOBSTERAI])
  })
})

/**
 * 客户端能力声明必须与「可选思考档位」配套。
 *
 * 实测（2026-09-17，真实凭据）：`reasoning_effort: "off"` 只在
 * `X-LobsterAI-Client-Capabilities` **包含 `thinking-level-control-v1`** 时
 * 返回 200；只发 `kimi-k3-agentic-v1`（Go 桥接层的硬编码值）时服务端直接
 * HTTP 500。即「关掉思考」这条协议需要客户端先声明支持它。
 *
 * 注意其他档位（low/high/max/xhigh）不受此约束 —— 所以这是一个只在
 * 「用户把档位调到 off」时才暴露的隐蔽故障，必须在配置层锁死。
 */
describe('LobsterAI 客户端能力声明', () => {
  it('包含 thinking-level-control-v1（否则 off 档会 500）', () => {
    expect(LOBSTERAI.clientCapabilities).toContain('thinking-level-control-v1')
  })

  it('保留 kimi-k3-agentic-v1（kimi-k3 上线的前提）', () => {
    // 实测：不带该能力时模型列表少一个 kimi-k3（25 vs 26）。
    expect(LOBSTERAI.clientCapabilities).toContain('kimi-k3-agentic-v1')
  })

  it('以逗号分隔的多值形态下发（服务端按逗号拆分）', () => {
    expect(LOBSTERAI.clientCapabilities).toBe(
      'kimi-k3-agentic-v1,thinking-level-control-v1',
    )
  })
})
