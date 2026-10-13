import { describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LoomyAdapter, parseLoomyRemoteModels } from '../../src/loomy-adapter.js'
import type { LoomyCredential } from '../../src/loomy.js'

const CRED: LoomyCredential = {
  access_token: 'S'.repeat(32), userid: 'u1', phone: '13011112222',
}

/** 实测的远端模型条目（2026-09-26 GET /api/v1/models 的真实形状）。 */
function remoteEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'MiniMax-M3',
    name: 'MiniMax M3 （x4.0）',
    object: 'model',
    type: 'chat',
    protocol: 'openai_chat',
    context_length: 1_048_576,
    max_output_tokens: 512_000,
    capabilities: {
      reasoning: true, vision: true, function_calling: true,
      input_modalities: ['text', 'image', 'video'], output_modalities: ['text'],
    },
    ...over,
  }
}

function makeAdapter(over: Partial<ConstructorParameters<typeof LoomyAdapter>[0]> = {}) {
  return new LoomyAdapter({
    credentialRef: credentialRef('LOOMY_ACCOUNT_TEST'),
    resolveCredential: async () => CRED,
    refresh: async () => {},
    ...over,
  })
}

describe('parseLoomyRemoteModels', () => {
  it('只保留 type=chat，并把倍率规范化进 name', () => {
    const models = parseLoomyRemoteModels({
      object: 'list',
      data: [
        remoteEntry(),
        remoteEntry({ id: 'Hy-Image-3.5-preview', name: 'Hy image 3.5 preview', type: 'image' }),
      ],
    })
    expect(models).toHaveLength(1)
    expect(models[0]!.id).toBe('MiniMax-M3')
    expect(models[0]!.name).toBe('MiniMax M3 · x4.0')
    expect(models[0]!.contextWindow).toBe(1_048_576)
    expect(models[0]!.supportsImage).toBe(true)
    expect(models[0]!.supportsThinking).toBe(true)
  })

  it('接受裸数组与 {data:[]} 两种形态', () => {
    expect(parseLoomyRemoteModels([remoteEntry()])).toHaveLength(1)
    expect(parseLoomyRemoteModels({ data: [remoteEntry()] })).toHaveLength(1)
  })

  it('畸形输入返回空数组（不抛）', () => {
    expect(parseLoomyRemoteModels(null)).toEqual([])
    expect(parseLoomyRemoteModels('x')).toEqual([])
    expect(parseLoomyRemoteModels({ data: 'x' })).toEqual([])
  })

  it('input_modalities 不含 image 时 supportsImage 为 false', () => {
    const models = parseLoomyRemoteModels({
      data: [remoteEntry({
        id: 'deepseek-v4-flash-0731',
        name: 'DeepSeek V4 Flash 0731（x3.0）',
        capabilities: { reasoning: true, input_modalities: ['text'] },
      })],
    })
    expect(models[0]!.supportsImage).toBe(false)
  })
})

describe('LoomyAdapter.listModels', () => {
  it('远端可用时用远端（带倍率）', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => parseLoomyRemoteModels({
        data: [remoteEntry(), remoteEntry({ id: 'spark-x', name: 'Spark X2.5（x0.1）' })],
      }),
    })
    const models = await adapter.listModels('loomy')
    expect(models).toHaveLength(2)
    expect(models[0]!.provider).toBe('loomy')
    expect(models[0]!.name).toBe('MiniMax M3 · x4.0')
  })

  it('远端失败时回退兜底表（9 个，兜底表名已含倍率）', async () => {
    const adapter = makeAdapter({ fetchRemoteModels: async () => { throw new Error('boom') } })
    const models = await adapter.listModels('loomy')
    expect(models).toHaveLength(9)
    expect(models.map((m) => m.id)).toContain('qwen3.8-flash')
    // 2026-10-09 新增的默认模型也在兜底表里
    expect(models.map((m) => m.id)).toContain('DeepSeek-V4.1-Flash')
  })

  it('无账号池时目录可见（headless/单测保守放行）', async () => {
    const adapter = makeAdapter()
    expect((await adapter.listModels('loomy')).length).toBeGreaterThan(0)
  })

  it('有账号池但未登录时返回空数组（不抛错）', async () => {
    const adapter = makeAdapter({
      accountPool: {
        disabledModelsFor: () => new Set<string>(),
        hasLoggedInAccount: async () => false,
      } as never,
    })
    expect(await adapter.listModels('loomy')).toEqual([])
  })

  it('黑名单里的模型被过滤', async () => {
    const adapter = makeAdapter({
      accountPool: {
        disabledModelsFor: () => new Set(['spark-x']),
        hasLoggedInAccount: async () => true,
      } as never,
    })
    const ids = (await adapter.listModels('loomy')).map((m) => m.id)
    expect(ids).not.toContain('spark-x')
    expect(ids.length).toBe(8)
  })
})

describe('LoomyAdapter.listAllModels', () => {
  it('不套黑名单，且带最终展示名', () => {
    const adapter = makeAdapter({
      accountPool: {
        disabledModelsFor: () => new Set(['spark-x']),
        hasLoggedInAccount: async () => true,
      } as never,
    })
    const all = adapter.listAllModels()
    // 被关闭的 spark-x 也必须出现（否则用户无法重新打开）
    expect(all.map((m) => m.id)).toContain('spark-x')
    // ⚠️ 上游已把 spark-x 的倍率位改成状态文案「限时免费」，兜底表随之对齐。
    expect(all.find((m) => m.id === 'spark-x')!.name).toBe('Spark X2.5（限时免费）')
  })
})

describe('LoomyAdapter.resolveModel', () => {
  it('name 不带倍率（价格只属于选择列表语境）', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('loomy', 'spark-x')
    // ⚠️ spark-x 的展示名里已**没有可剥离的倍率**（上游改成「限时免费」文案），
    // 故 resolveModel 原样返回它 —— 这与远端路径的行为一致。
    expect(resolved.name).toBe('Spark X2.5（限时免费）')
    expect(resolved.context?.contextWindow).toBe(1_048_576)
  })

  it('带倍率的模型在 resolveModel 里剥掉倍率', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('loomy', 'MiniMax-M3')
    expect(resolved.name).toBe('MiniMax M3')
  })

  it('未知模型不编造 context', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('loomy', 'nope')
    expect(resolved.context).toBeUndefined()
  })
})

/**
 * ⚠️ **思考档位**（用户报障：「loomy ide 中可以设置思考档位，我们现在没法设置」）。
 *
 * 根因与 Qoder 那次**完全同型**（见 AGENTS.md 2.2 节）：`resolveModel`
 * **只声明 `context`，从不声明 `reasoning`** —— 而 DSH 的思考强度选择器
 * **只会**从 `resolveModel().reasoning` 渲染，故档位选择器从来没出现过，
 * 尽管远端早就下发了 `reasoning_efforts`。
 *
 * 用户要求「如果能从远端得到配置中直接生成是最好的」—— 正是本实现的做法。
 */
describe('LoomyAdapter 思考档位', () => {
  /** 实测的档位（9 个带档位的 chat 模型完全一致）。 */
  const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh']

  it('parseLoomyRemoteModels 读出 reasoning_efforts 与默认档', () => {
    const models = parseLoomyRemoteModels({
      data: [remoteEntry({ reasoning_efforts: EFFORTS, default_reasoning_effort: 'low' })],
    })
    expect(models[0]!.efforts).toEqual(EFFORTS)
    expect(models[0]!.defaultEffort).toBe('low')
  })

  it('远端未下发档位时不写这两个键（而非写空数组）', () => {
    const models = parseLoomyRemoteModels({ data: [remoteEntry()] })
    expect(models[0]!.efforts).toBeUndefined()
    expect(models[0]!.defaultEffort).toBeUndefined()
  })

  it('非法档位项被丢弃，且去重', () => {
    const models = parseLoomyRemoteModels({
      data: [remoteEntry({ reasoning_efforts: ['low', 42, null, 'low', 'high', ''] })],
    })
    expect(models[0]!.efforts).toEqual(['low', 'high'])
  })

  it('resolveModel 声明 reasoning（远端档位直接生成，含官方中文名）', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => parseLoomyRemoteModels({
        data: [remoteEntry({ reasoning_efforts: EFFORTS, default_reasoning_effort: 'low' })],
      }),
    })
    const resolved = await adapter.resolveModel('loomy', 'MiniMax-M3')
    expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual(EFFORTS)
    // 中文名与官方 IDE 一致（DSH 直接渲染 name，不本地化）
    expect(resolved.reasoning?.efforts.map((e) => e.name))
      .toEqual(['关闭思考', '低', '中', '高', '极高'])
  })

  /**
   * ⚠️ **默认档用本插件自己的 `high`，不采信远端的 `low`**（用户要求）。
   *
   * 依据：DSH 的 `effectiveEffort = state.current?.reasoningEffort
   * ?? reasoning?.defaultEffort` —— 「用户没选时发哪个档」完全由适配器声明的
   * `defaultEffort` 决定，沿用远端的 `low` 会让默认思考偏浅。
   *
   * ⚠️ 反向断言：**绝不能**等于远端声明的 `low`（否则等于没改）。
   */
  it('默认档是 high，不是远端声明的 low（用户要求）', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => parseLoomyRemoteModels({
        data: [remoteEntry({ reasoning_efforts: EFFORTS, default_reasoning_effort: 'low' })],
      }),
    })
    const resolved = await adapter.resolveModel('loomy', 'MiniMax-M3')
    expect(resolved.reasoning?.defaultEffort).toBe('high')
    expect(resolved.reasoning?.defaultEffort).not.toBe('low')
  })

  /**
   * ⚠️ `defaultEffort` **必须落在 `efforts` 内** —— DSH 会拿它直接发请求，
   * 给一个不存在的档位会抛 `UNSUPPORTED_REASONING_EFFORT`，比不给更糟。
   *
   * 这里造一个**不含 `high`** 的模型（远端目录变化时真会发生），
   * 期望**不下发默认档**（退回 DSH 的「服务商默认」），而不是硬发 `high`。
   */
  it('模型不提供 high 档时不下发默认档（但档位照常给出）', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => parseLoomyRemoteModels({
        data: [remoteEntry({ reasoning_efforts: ['low', 'medium'], default_reasoning_effort: 'low' })],
      }),
    })
    const resolved = await adapter.resolveModel('loomy', 'MiniMax-M3')
    expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual(['low', 'medium'])
    expect(resolved.reasoning?.defaultEffort).toBeUndefined()
  })

  /**
   * ⚠️ 远端某模型**未下发**档位、但它在兜底表里有档位时，**仍给出档位**。
   *
   * 这是**有意为之**：`loadModels()` 在远端返回非空时采信远端，但
   * `reasoningFor` 会回退到兜底表 —— 因为「远端这一条没带档位」不等于
   * 「该模型不支持档位」（可能是上游某次下发的字段缺失）。
   * 而兜底表的档位是**实测值**，给出它比让选择器凭空消失更好。
   */
  it('远端该模型未带档位时回退兜底表档位（不凭空消失）', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => parseLoomyRemoteModels({ data: [remoteEntry()] }),
    })
    const resolved = await adapter.resolveModel('loomy', 'MiniMax-M3')
    expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual(EFFORTS)
  })

  /** 真正「不提供档位」的是**兜底表也没有**的模型（如远端新上线的模型）。 */
  it('远端与兜底表都没有档位时不声明 reasoning', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => parseLoomyRemoteModels({
        // 一个兜底表里没有的新模型，且未下发档位
        data: [remoteEntry({ id: 'brand-new-model', name: 'Brand New' })],
      }),
    })
    const resolved = await adapter.resolveModel('loomy', 'brand-new-model')
    expect(resolved.reasoning).toBeUndefined()
  })

  it('远端整体失败时用兜底表的档位', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => { throw new Error('network down') },
    })
    const resolved = await adapter.resolveModel('loomy', 'qwen3.8-flash')
    expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual(EFFORTS)
    // ⚠️ 兜底路径的默认档也必须与远端路径一致（都是 high），
    // 否则「远端可用/不可用」会让默认档悄悄变化。
    expect(resolved.reasoning?.defaultEffort).toBe('high')
  })

  it('未登记的中文名回退到 id 本身（新档位上线时不至于空白）', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => parseLoomyRemoteModels({
        data: [remoteEntry({ reasoning_efforts: ['low', 'ultra'] })],
      }),
    })
    const resolved = await adapter.resolveModel('loomy', 'MiniMax-M3')
    expect(resolved.reasoning?.efforts.map((e) => e.name)).toEqual(['低', 'ultra'])
  })
})

describe('LoomyAdapter 请求体里的 reasoning_effort', () => {
  const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh']

  /** 造一个 SSE 响应并捕获请求体。 */
  function makeFetch(captured: { body?: Record<string, unknown> }) {
    return (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>
      const frames = [
        'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n',
        'data: [DONE]\n\n',
      ]
      return new Response(frames.join(''), {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      })
    }) as unknown as typeof fetch
  }

  async function drain(adapter: LoomyAdapter, effort?: string) {
    for await (const _chunk of adapter.stream({
      provider: 'loomy',
      model: 'MiniMax-M3',
      messages: [{ role: 'user', content: 'hi' }],
      ...effort !== undefined ? { reasoningEffort: effort as never } : {},
    })) {
      // 只为把请求发出去
    }
  }

  it('用户选了档位时下发 reasoning_effort', async () => {
    const captured: { body?: Record<string, unknown> } = {}
    const adapter = makeAdapter({
      fetchImpl: makeFetch(captured),
      fetchRemoteModels: async () => parseLoomyRemoteModels({
        data: [remoteEntry({ reasoning_efforts: EFFORTS, default_reasoning_effort: 'low' })],
      }),
    })
    await drain(adapter, 'high')
    expect(captured.body?.reasoning_effort).toBe('high')
  })

  it('未选档位时不下发该字段（让服务端用默认档）', async () => {
    const captured: { body?: Record<string, unknown> } = {}
    const adapter = makeAdapter({
      fetchImpl: makeFetch(captured),
      fetchRemoteModels: async () => parseLoomyRemoteModels({
        data: [remoteEntry({ reasoning_efforts: EFFORTS })],
      }),
    })
    await drain(adapter)
    expect(captured.body).not.toHaveProperty('reasoning_effort')
  })

  /**
   * ⚠️ **安全约束**：档位不在该模型声明的 `efforts` 内时**静默不下发**。
   *
   * 给一个远端不认的值比不给更糟（可能被拒，或行为未定义）。DSH 会把用户选的
   * 档位直接透传，故这里必须自己校验。
   */
  it('档位不在该模型的 efforts 内时不下发', async () => {
    const captured: { body?: Record<string, unknown> } = {}
    const adapter = makeAdapter({
      fetchImpl: makeFetch(captured),
      fetchRemoteModels: async () => parseLoomyRemoteModels({
        data: [remoteEntry({ reasoning_efforts: ['low', 'high'] })],
      }),
    })
    await drain(adapter, 'xhigh')
    expect(captured.body).not.toHaveProperty('reasoning_effort')
  })

  it('远端整体失败时用兜底表档位校验（xhigh 在表内 → 下发）', async () => {
    const captured: { body?: Record<string, unknown> } = {}
    const adapter = makeAdapter({
      fetchImpl: makeFetch(captured),
      fetchRemoteModels: async () => { throw new Error('network down') },
    })
    await drain(adapter, 'xhigh')
    expect(captured.body?.reasoning_effort).toBe('xhigh')
  })
})

describe('LoomyAdapter.providerInfo', () => {
  it('返回产品 id 与展示名', () => {
    expect(makeAdapter().providerInfo('loomy')).toEqual({ id: 'loomy', name: 'Loomy (讯飞)' })
  })

  it('provider 非法时回退到产品 id（避免 undefined.toUpperCase 崩）', () => {
    expect(makeAdapter().providerInfo(undefined as never).id).toBe('loomy')
  })
})
