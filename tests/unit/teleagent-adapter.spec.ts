import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { TeleagentAdapter, registerTeleagentLlm } from '../../src/teleagent-adapter.js'
import { teleagentFallbackEntries, type TeleagentCredential } from '../../src/teleagent.js'
import { TELEAGENT } from '../../src/teleagent-product.js'

/**
 * TeleagentAdapter 的回归测试。
 *
 * 守三件事：
 * 1. **无账号时 listModels 返回 []（不抛错）** —— 抛错会让 DSH 多报一条
 *    provider 错误，而「没登录」不是错误；
 * 2. **未知模型不编造 context / reasoning** —— 假窗口会让 DSH 过早压缩，
 *    编的档位会被服务端拒；
 * 3. **图片在未实测支持时必须报错而非静默丢图** —— 静默会让用户以为模型看到了图。
 */

const [NANO, LITE, PRO] = teleagentFallbackEntries()

function makeAdapter(over: Partial<ConstructorParameters<typeof TeleagentAdapter>[0]> = {}) {
  return new TeleagentAdapter({
    credentialRef: 'TELEAGENT_ACCESS_TOKEN' as never,
    resolveCredential: async () => undefined,
    refresh: async () => {},
    fetchRemoteModels: async () => [NANO, LITE, PRO],
    product: TELEAGENT,
    ...over,
  })
}

describe('listModels / listAllModels', () => {
  it('★ 无已登录账号 ⇒ 返回空数组（不是抛错）', async () => {
    const adapter = makeAdapter({
      accountPool: { hasLoggedInAccount: async () => false } as never,
    })
    await expect(adapter.listModels('teleagent')).resolves.toEqual([])
  })

  it('★ listAllModels 必须**同步**返回数组（返回 Promise 会让「显示列表」崩）', () => {
    const adapter = makeAdapter()
    const all = adapter.listAllModels()
    expect(Array.isArray(all)).toBe(true)
    expect(all).not.toBeInstanceOf(Promise)
    expect(all.map((m) => m.id)).toEqual(['chat-nano', 'chat-lite', 'chat-pro'])
  })

  it('listAllModels 不套黑名单（那是「显示列表」的全量来源）', async () => {
    const adapter = makeAdapter({
      accountPool: {
        hasLoggedInAccount: async () => true,
        disabledModelsFor: () => new Set(['chat-lite']),
      } as never,
    })
    const listed = await adapter.listModels('teleagent')
    expect(listed.map((m) => m.id)).toEqual(['chat-nano', 'chat-pro'])
    // 全量目录仍含被关闭的那个
    expect(adapter.listAllModels().map((m) => m.id)).toContain('chat-lite')
  })

  it('远端返回空数组 ⇒ 回退兜底表（不能让 provider 消失）', async () => {
    const adapter = makeAdapter({ fetchRemoteModels: async () => [] })
    const listed = await adapter.listModels('teleagent')
    expect(listed.length).toBe(3)
  })

  it('远端抛错 ⇒ 静默回退兜底表（目录是展示信息，不该让整个 provider 报错）', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => { throw new Error('network down') },
    })
    await expect(adapter.listModels('teleagent')).resolves.toHaveLength(3)
  })
})

describe('resolveModel', () => {
  it('已知模型：窗口与 defaultMaxTokens 都来自兜底表', async () => {
    const resolved = await makeAdapter().resolveModel('teleagent', 'chat-nano')
    expect(resolved.context).toEqual({ contextWindow: 100_000 })
    expect(resolved.defaultMaxTokens).toBe(16_384)
    expect(resolved.name).toBe('轻速')
  })

  it('★ 未知模型 ⇒ 不编造 context（宁可让 DSH 用默认值）', async () => {
    const resolved = await makeAdapter().resolveModel('teleagent', 'nope')
    expect(resolved.context).toBeUndefined()
    expect(resolved.defaultMaxTokens).toBeUndefined()
    expect(resolved.name).toBe('nope')
  })

  it('★ 不声明 reasoning（asar 种子表没有 thinking_config，编档位就是猜）', async () => {
    for (const id of ['chat-nano', 'chat-lite', 'chat-pro']) {
      const resolved = await makeAdapter().resolveModel('teleagent', id)
      expect(resolved.reasoning, id).toBeUndefined()
    }
  })

  it('窗口为 0（远端未知哨兵）⇒ 不声明 context', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => [{ ...NANO, contextWindow: 0 }],
    })
    const resolved = await adapter.resolveModel('teleagent', 'chat-nano')
    expect(resolved.context).toBeUndefined()
  })

  it('非法 maxTokens（0/负数）⇒ 不发该字段（否则 DSH 抛 INVALID_MODEL_MAX_TOKENS）', async () => {
    for (const bad of [0, -1, Number.NaN]) {
      const adapter = makeAdapter({
        fetchRemoteModels: async () => [{ ...NANO, maxTokens: bad }],
      })
      const resolved = await adapter.resolveModel('teleagent', 'chat-nano')
      expect(resolved.defaultMaxTokens, String(bad)).toBeUndefined()
    }
  })

  it('prepareCall 可用（0.1.1 shim，缺失会让每轮请求开头崩）', async () => {
    const prepared = await makeAdapter().prepareCall('teleagent', 'chat-lite')
    expect(prepared.model.id).toBe('chat-lite')
    expect(typeof prepared.stream).toBe('function')
  })
})

describe('stream 的前置校验', () => {
  const baseOptions = {
    model: 'chat-nano',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  } as never

  it('★ 无凭据 ⇒ MISSING_CREDENTIAL（不静默返回空流）', async () => {
    const adapter = makeAdapter({ resolveCredential: async () => undefined })
    const run = async () => { for await (const _ of adapter.stream(baseOptions)) void _ }
    await expect(run()).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('空 token 同样判无凭据', async () => {
    const adapter = makeAdapter({
      resolveCredential: async () => ({ token: '' } as TeleagentCredential),
    })
    const run = async () => { for await (const _ of adapter.stream(baseOptions)) void _ }
    await expect(run()).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('★ 收到图片而模型未声明支持 ⇒ 报错，绝不静默丢图', async () => {
    const adapter = makeAdapter({
      resolveCredential: async () => ({ token: 't' } as TeleagentCredential),
      readImage: async () => ({ data: new Uint8Array([1]), mediaType: 'image/png' }),
    })
    const options = {
      model: 'chat-nano',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '看这张图' },
          { type: 'image', attachment: { attachmentId: 'a1' } },
        ],
      }],
    } as never
    const run = async () => { for await (const _ of adapter.stream(options)) void _ }
    const error = await run().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe('UNSUPPORTED_CONTENT')
  })

  it('声明支持图片但没给 readImage ⇒ 也报错（不静默降级成纯文本）', async () => {
    const adapter = makeAdapter({
      resolveCredential: async () => ({ token: 't' } as TeleagentCredential),
      fetchRemoteModels: async () => [{ ...NANO, supportsImage: true }],
    })
    const options = {
      model: 'chat-nano',
      messages: [{
        role: 'user',
        content: [{ type: 'image', attachment: { attachmentId: 'a1' } }],
      }],
    } as never
    const run = async () => { for await (const _ of adapter.stream(options)) void _ }
    await expect(run()).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })
})

describe('注册', () => {
  it('★ registerTeleagentLlm 注册到 [teleagent] 且返回适配器实例', () => {
    const calls: Array<readonly string[]> = []
    const ctx = {
      llm: {
        registerAdapter: (providers: readonly string[]) => { calls.push(providers); return {} },
      },
    } as never
    const adapter = registerTeleagentLlm(ctx, {
      credentialRef: 'TELEAGENT_ACCESS_TOKEN' as never,
      resolveCredential: async () => undefined,
      refresh: async () => {},
    })
    expect(adapter).toBeInstanceOf(TeleagentAdapter)
    expect(calls).toEqual([['teleagent']])
  })

  it('providerInfo 用产品 displayName', () => {
    expect(makeAdapter().providerInfo('teleagent').name).toBe(TELEAGENT.displayName)
  })
})
