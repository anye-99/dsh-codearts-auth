import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  ClineAdapter,
  isClineRotatableFailure,
  recordsClineRateLimit,
  sanitizeClineToolParameters,
} from '../../src/cline-adapter.js'
import { CLINE } from '../../src/cline-product.js'
import { mergeClineModels, type ClineModel } from '../../src/cline-models.js'
import type { ClineCredential } from '../../src/cline.js'
import {
  readClineRequestHistory,
  resetClineRequestHistory,
} from '../../src/cline-request-log.js'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * 账号池里的账号 id。
 *
 * ⚠️ 它与 {@link cred} 里的 `account_id`（`usr-…`）是**两个 id 空间** ——
 * 「请求记录中数据空白」这个真实缺陷的根因就是两者被混用。
 */
const POOL_ACCOUNT_ID = 'cline-bb211a53'

/** 实测凭据形态（access_token 自带 workos: 前缀）。 */
const cred: ClineCredential = {
  access_token: 'workos:eyJhbGciOiJSUzI1NiIs',
  refresh_token: 'tmgEeM2rd9ybYoWpXl8JqUfvK',
  expire_time: Date.now() + 3_600_000,
  account_id: 'usr-01M3BCV4FYCGJKAWD3MJG3DBQM',
  email: 'ijetlee@163.com',
  nickname: 'ijetlee@163.com',
}

/** 固定目录（离线；含免费与付费条目）。 */
const MODELS: ClineModel[] = mergeClineModels(CLINE, {
  freeIds: ['cline-free/deepseek-v4.1-flash', 'cline-free/gemini-3.8-flash'],
  remoteIds: ['deepseek/deepseek-v4.1-flash', 'openai/gpt-6-luna'],
  entries: [
    { id: 'cline-free/deepseek-v4.1-flash', name: 'Deepseek-v4.1-Flash' },
    { id: 'cline-free/gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
  ],
})

/** 构造适配器（默认注入凭据 + 固定目录，完全离线）。 */
function makeAdapter(overrides: Partial<ConstructorParameters<typeof ClineAdapter>[0]> = {}): ClineAdapter {
  return new ClineAdapter({
    credentialRef: { name: 'CLINE_ACCESS_TOKEN' } as never,
    resolveCredential: async () => cred,
    refresh: async () => {},
    product: CLINE,
    loadModels: async () => ({ models: MODELS, warnings: [] }),
    // ⚠️ models.dev 目录也必须注入：默认加载器会去拉真实网络。
    // 空表 = 「没读到」，各用例按需覆盖。
    loadModelsDev: async () => new Map(),
    ...overrides,
  })
}

/** 标准 OpenAI SSE 帧。 */
function sseResponse(frames: string[]): Response {
  return new Response(frames.map((f) => `data: ${f}\n\n`).join('') + 'data: [DONE]\n\n', {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

/**
 * **逐帧延迟**下发的 SSE —— 用来把 `ttft`（首块）与 `ttfc`（首个正文块）
 * 在时间上分开。`sseResponse` 一次性给完，两者会落在同一毫秒上，测不出区别。
 */
function slowSseResponse(frames: Array<{ delayMs: number; payload: string }>): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      for (const frame of frames) {
        await new Promise((resolve) => setTimeout(resolve, frame.delayMs))
        controller.enqueue(encoder.encode(`data: ${frame.payload}\n\n`))
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

/** 收集一次 stream 的全部 chunk。 */
async function collect(
  adapter: ClineAdapter,
  options: Record<string, unknown> = {},
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const chunk of adapter.stream({
    model: 'cline-free/deepseek-v4.1-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    ...options,
  } as never)) {
    out.push(chunk as unknown as Record<string, unknown>)
  }
  return out
}

describe('ClineAdapter 模型目录', () => {
  it('免费模型在 name 里标出（远端 free 集合驱动）', async () => {
    const adapter = makeAdapter()
    const models = await adapter.listModels('cline')
    const byId = new Map(models.map((m) => [m.id, m]))
    // 展示名优先取**兜底表**（内嵌目录的正式名，与 Cline IDE 显示一致，
    // 即用户截图里的 "DeepSeek V4.1 Flash (free)"），而非远端 slug
    //（"Deepseek-v4.1-Flash"）。标记统一由 clineDisplayName 拼。
    expect(byId.get('cline-free/deepseek-v4.1-flash')?.name).toBe('DeepSeek V4.1 Flash · 免费')
    expect(byId.get('cline-free/gemini-3.8-flash')?.name).toBe('Gemini 3.8 Flash · 免费')
  })

  it('付费模型不标免费（同名但不同命名空间）', async () => {
    const adapter = makeAdapter()
    const models = await adapter.listModels('cline')
    const byId = new Map(models.map((m) => [m.id, m]))
    // ⚠️ 核心不变式：`deepseek/deepseek-v4.1-flash` 是**另一个**计费实体
    expect(byId.get('deepseek/deepseek-v4.1-flash')?.name).not.toContain('免费')
    expect(byId.get('openai/gpt-6-luna')?.name).not.toContain('免费')
  })

  it('目录含远端全部模型（用户要求「全部列出」）', async () => {
    const adapter = makeAdapter()
    const models = await adapter.listModels('cline')
    const ids = models.map((m) => m.id)
    expect(ids).toContain('cline-free/deepseek-v4.1-flash')
    expect(ids).toContain('deepseek/deepseek-v4.1-flash')
    expect(ids).toContain('openai/gpt-6-luna')
  })

  it('listAllModels 也带免费标记（设置页能看到正确展示名）', () => {
    const adapter = makeAdapter()
    const models = adapter.listAllModels()
    const entry = models.find((m) => m.id === 'cline-free/deepseek-v4.1-flash')
    expect(entry?.name).toBe('DeepSeek V4.1 Flash · 免费')
  })

  it('未加载完成时 listAllModels 回退兜底表（仍含 5 个免费模型）', () => {
    const adapter = makeAdapter({ loadModels: async () => { throw new Error('offline') } })
    const models = adapter.listAllModels()
    expect(models.length).toBe(CLINE.fallbackModels.length)
    expect(models.filter((m) => m.name.includes('免费'))).toHaveLength(5)
  })

  it('远端目录两个端点都失败时仍返回兜底表', async () => {
    const adapter = makeAdapter({
      loadModels: async () => ({ models: [], warnings: ['recommended-models boom', 'models boom'] }),
    })
    const models = await adapter.listModels('cline')
    expect(models.length).toBe(CLINE.fallbackModels.length)
    expect(models.filter((m) => m.name.includes('免费'))).toHaveLength(5)
  })

  it('黑名单过滤只作用于 listModels，不影响 listAllModels', async () => {
    const disabled = new Set(['cline-free/deepseek-v4.1-flash'])
    const adapter = makeAdapter({
      accountPool: {
        disabledModelsFor: () => disabled,
        hasLoggedInAccount: async () => true,
      } as never,
    })
    const listed = await adapter.listModels('cline')
    expect(listed.map((m) => m.id)).not.toContain('cline-free/deepseek-v4.1-flash')
    // 设置页必须仍能看到它（否则无法重新打开）
    expect(adapter.listAllModels().map((m) => m.id)).toContain('cline-free/deepseek-v4.1-flash')
  })

  it('没有任何已登录账号时返回空数组（目录门控）', async () => {
    const adapter = makeAdapter({
      accountPool: {
        disabledModelsFor: () => new Set<string>(),
        hasLoggedInAccount: async () => false,
      } as never,
    })
    expect(await adapter.listModels('cline')).toEqual([])
  })

  it('目录门控不可用（替身未实现 hasLoggedInAccount）时保守放行', async () => {
    const adapter = makeAdapter({ accountPool: { disabledModelsFor: () => new Set<string>() } as never })
    expect((await adapter.listModels('cline')).length).toBeGreaterThan(0)
  })
})

describe('ClineAdapter resolveModel', () => {
  it('name 不带免费标记（标记只属于选择列表语境）', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('cline', 'cline-free/deepseek-v4.1-flash')
    expect(resolved.name).toBe('DeepSeek V4.1 Flash')
    expect(resolved.name).not.toContain('免费')
  })

  it('声明 defaultMaxTokens（否则上限永久退回网关默认值）', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('cline', 'cline-free/deepseek-v4.1-flash')
    expect(resolved.defaultMaxTokens).toBe(131_072)
  })

  it('声明 context（内嵌目录的 contextWindow）', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('cline', 'cline-free/deepseek-v4.1-flash')
    expect(resolved.context?.contextWindow).toBe(1_048_576)
  })

  it('未知模型不编造 context / defaultMaxTokens', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('cline', 'unknown/model-x')
    expect(resolved.context).toBeUndefined()
    expect(resolved.defaultMaxTokens).toBeUndefined()
    expect(resolved.name).toBe('unknown/model-x')
  })

  it('inputModalities 按模型判定（图片能力）', async () => {
    const adapter = makeAdapter()
    const withImage = await adapter.resolveModel('cline', 'cline-free/deepseek-v4.1-flash')
    expect(withImage.inputModalities).toContain('image')
    const unknown = await adapter.resolveModel('cline', 'unknown/model-x')
    expect(unknown.inputModalities).toEqual(['text'])
  })

  it('声明 5 档思考强度（顺序与展示名对齐 Cline IDE）', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('cline', 'cline-free/deepseek-v4.1-flash')
    // ⚠️ id 是发给上游的 wire 值，name 是 IDE 上的展示名，两者**刻意不同**：
    // 最高档 wire 是 `max`，展示是 `Extra`（xhigh 实测与 high 无差异，故跳过）。
    expect(resolved.reasoning?.efforts).toEqual([
      { id: 'none', name: 'None' },
      { id: 'low', name: 'Low' },
      { id: 'medium', name: 'Medium' },
      { id: 'high', name: 'High' },
      { id: 'max', name: 'Extra' },
    ])
  })

  it('默认档位是 high（对齐 IDE 截图的选中态）', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('cline', 'cline-free/deepseek-v4.1-flash')
    expect(resolved.reasoning?.defaultEffort).toBe('high')
  })

  it('未知模型同样有 5 档（覆盖范围决策：统一给，不按目录细分）', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('cline', 'unknown/model-x')
    expect(resolved.reasoning?.efforts).toHaveLength(5)
    expect(resolved.reasoning?.defaultEffort).toBe('high')
  })
})

describe('ClineAdapter 请求构造', () => {
  it('POST 到 OpenAI 兼容端点，鉴权头保留 workos: 前缀', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const adapter = makeAdapter({
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
      }) as unknown as typeof fetch,
    })
    await collect(adapter)
    expect(calls[0]!.url).toBe('https://api.cline.bot/api/v1/chat/completions')
    expect(calls[0]!.init.method).toBe('POST')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer workos:eyJhbGciOiJSUzI1NiIs')
    expect(headers['X-CLIENT-TYPE']).toBe('cline-sdk')
    expect(headers.Accept).toBe('text/event-stream')
  })

  it('请求体是标准 OpenAI 形状（model / messages / stream）', async () => {
    const bodies: string[] = []
    const adapter = makeAdapter({
      fetchImpl: (async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body))
        return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
      }) as unknown as typeof fetch,
    })
    await collect(adapter)
    const body = JSON.parse(bodies[0]!) as Record<string, unknown>
    expect(body.model).toBe('cline-free/deepseek-v4.1-flash')
    expect(body.stream).toBe(true)
    expect(Array.isArray(body.messages)).toBe(true)
  })

  it('system 提示并入 messages 顶部', async () => {
    const bodies: string[] = []
    const adapter = makeAdapter({
      fetchImpl: (async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body))
        return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
      }) as unknown as typeof fetch,
    })
    await collect(adapter, { system: 'be terse' })
    const body = JSON.parse(bodies[0]!) as { messages: Array<{ role: string }> }
    expect(body.messages[0]!.role).toBe('system')
  })

  it('工具定义真的下发（顶层 tools，OpenAI 风格）', async () => {
    const bodies: string[] = []
    const adapter = makeAdapter({
      fetchImpl: (async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body))
        return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
      }) as unknown as typeof fetch,
    })
    await collect(adapter, {
      tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } }],
    })
    const body = JSON.parse(bodies[0]!) as { tools: Array<{ type: string; function: { name: string } }> }
    expect(body.tools).toHaveLength(1)
    expect(body.tools[0]!.type).toBe('function')
    expect(body.tools[0]!.function.name).toBe('read_file')
  })

  it('工具 schema 的空串 enum 被清洗（否则 Gemini 系 400）', async () => {
    const bodies: string[] = []
    const adapter = makeAdapter({
      fetchImpl: (async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body))
        return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
      }) as unknown as typeof fetch,
    })
    // 复刻真实报障：harness 下发的 permission 参数 enum 含空串成员（第 4 项）。
    // 上游原话：GenerateContentRequest.tools[0].function_declarations[34]
    //           .parameters.properties[permission].enum[3]: cannot be empty
    await collect(adapter, {
      tools: [{
        name: 'set_permission',
        description: 'switch preset',
        parameters: {
          type: 'object',
          properties: {
            permission: { type: 'string', enum: ['read', 'write', 'execute', ''] },
          },
        },
      }],
    })
    const body = JSON.parse(bodies[0]!) as {
      tools: Array<{ function: { parameters: { properties: { permission: { enum: string[] } } } } }>
    }
    expect(body.tools[0]!.function.parameters.properties.permission.enum)
      .toEqual(['read', 'write', 'execute'])
  })

  it('enum 清洗的三条边界（只删空串 / 保留数值 / 全空则丢弃键 / 递归下钻）', () => {
    // ① 数值枚举不能被「只留字符串」的过滤整段丢掉
    expect(sanitizeClineToolParameters({
      properties: { level: { enum: [1, 2, 3] } },
    })).toEqual({ properties: { level: { enum: [1, 2, 3] } } })
    // ② 纯空白同样算空；③ 过滤后为空则整个 enum 键消失（空 enum 同样非法）
    expect(sanitizeClineToolParameters({ mode: { enum: ['   ', 'ok'] } }))
      .toEqual({ mode: { enum: ['ok'] } })
    expect(sanitizeClineToolParameters({ mode: { enum: ['', '  '] } }))
      .toEqual({ mode: {} })
    // ④ 嵌套层（properties / items）里的 enum 同罪
    expect(sanitizeClineToolParameters({
      properties: { nested: { items: { enum: ['a', ''] } } },
    })).toEqual({ properties: { nested: { items: { enum: ['a'] } } } })
    // ⑤ 非对象原样透传
    expect(sanitizeClineToolParameters('plain')).toBe('plain')
    expect(sanitizeClineToolParameters(null)).toBe(null)
  })

  it('max_tokens 收敛到安全上限（不编造、不超界）', async () => {
    const bodies: string[] = []
    const adapter = makeAdapter({
      fetchImpl: (async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body))
        return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
      }) as unknown as typeof fetch,
    })
    await collect(adapter, { maxTokens: 9_999_999 })
    const body = JSON.parse(bodies[0]!) as { max_tokens: number }
    expect(body.max_tokens).toBe(943_718)
  })

  it('reasoningEffort 透传为 reasoning_effort', async () => {
    const bodies: string[] = []
    const adapter = makeAdapter({
      fetchImpl: (async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body))
        return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
      }) as unknown as typeof fetch,
    })
    await collect(adapter, { reasoningEffort: 'high' })
    expect((JSON.parse(bodies[0]!) as { reasoning_effort: string }).reasoning_effort).toBe('high')
  })

  it('不在请求构造处过滤档位（上游新增档位不能被静默丢弃）', async () => {
    const bodies: string[] = []
    const adapter = makeAdapter({
      fetchImpl: (async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body))
        return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
      }) as unknown as typeof fetch,
    })
    // `xhigh` 是内嵌目录里有、但本插件档位表未收录的 wire 值（实测与 high 无差异）。
    // 即便如此也必须原样发出：白名单校验会把上游未来新增的档位变成静默丢弃。
    await collect(adapter, { reasoningEffort: 'xhigh' })
    expect((JSON.parse(bodies[0]!) as { reasoning_effort: string }).reasoning_effort).toBe('xhigh')
  })

  it('无凭据时报 MISSING_CREDENTIAL', async () => {
    const adapter = makeAdapter({ resolveCredential: async () => undefined })
    await expect(collect(adapter)).rejects.toThrow(/no usable credential/)
  })

  it('凭据过期时先续期再取新凭据', async () => {
    let refreshed = false
    const adapter = makeAdapter({
      resolveCredential: async () => (refreshed
        ? { ...cred, access_token: 'workos:new-token' }
        : { ...cred, expire_time: 1 }),
      refresh: async () => { refreshed = true },
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const headers = init.headers as Record<string, string>
        expect(headers.Authorization).toBe('Bearer workos:new-token')
        return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
      }) as unknown as typeof fetch,
    })
    await collect(adapter)
    expect(refreshed).toBe(true)
  })
})

describe('ClineAdapter SSE 消费', () => {
  /**
   * ⚠️ **Cline 的思考字段是 `delta.reasoning`**，不是 `reasoning_content`。
   * 实测形态：`{"delta":{"reasoning":"The","reasoning_details":[…]}}`。
   * 只认后者会让思考内容被静默丢弃（用户看到「模型不思考」）。
   */
  it('消费 delta.reasoning 为 reasoning 块（Cline 特有字段名）', async () => {
    const adapter = makeAdapter({
      fetchImpl: (async () => sseResponse([
        JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] }),
        JSON.stringify({ choices: [{ delta: { reasoning: 'Let me think', reasoning_details: [{ type: 'reasoning.text', text: 'Let me think' }] } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'PONG' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ])) as unknown as typeof fetch,
    })
    const chunks = await collect(adapter)
    const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
    expect(reasoning).toBe('Let me think')
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
    expect(text).toBe('PONG')
  })

  it('仍然消费 reasoning_content（Qoder / buddy 形态不回归）', async () => {
    const adapter = makeAdapter({
      fetchImpl: (async () => sseResponse([
        JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ])) as unknown as typeof fetch,
    })
    const chunks = await collect(adapter)
    expect(chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')).toBe('thinking')
  })

  it('工具调用按 index 合并', async () => {
    const adapter = makeAdapter({
      fetchImpl: (async () => sseResponse([
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '' } }] } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a"}' } }] } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      ])) as unknown as typeof fetch,
    })
    const chunks = await collect(adapter)
    const end = chunks.find((c) => c.type === 'block-end' && (c.block as { type?: string })?.type === 'tool-call')
    expect(end).toBeDefined()
    expect((end!.block as { name: string }).name).toBe('read_file')
  })
})

describe('ClineAdapter 限流与换号判定', () => {
  it('429 / 402 可换号', () => {
    expect(isClineRotatableFailure(429, '')).toBe(true)
    expect(isClineRotatableFailure(402, '')).toBe(true)
  })

  it('额度文案命中可换号（中英双通道）', () => {
    expect(isClineRotatableFailure(400, 'insufficient credit')).toBe(true)
    expect(isClineRotatableFailure(400, '积分不足')).toBe(true)
  })

  it('400 请求格式错 / 5xx 服务端故障不换号（换号无用）', () => {
    expect(isClineRotatableFailure(400, 'invalid request format')).toBe(false)
    expect(isClineRotatableFailure(500, 'internal error')).toBe(false)
  })

  it('只有 429 / 402 记限流徽章（徽章含义必须是「受限」而非「出过错」）', () => {
    expect(recordsClineRateLimit(429, '')).toBe(true)
    expect(recordsClineRateLimit(402, '')).toBe(true)
    expect(recordsClineRateLimit(400, 'insufficient credit')).toBe(false)
  })

  it('地域限制（403 not available in your region）不被误判为凭据问题，且不白跑续期', async () => {
    let refreshed = 0
    const adapter = makeAdapter({
      refresh: async () => { refreshed += 1 },
      fetchImpl: (async () => new Response(
        JSON.stringify({ error: 'access forbidden: cline-free/muse-spark-1.3-contributor is not available in your region', success: false }),
        { status: 403 },
      )) as unknown as typeof fetch,
    })
    await expect(collect(adapter)).rejects.toThrow(/region|不可用/)
    // ⚠️ 该 403 与凭据无关，续期一次都是浪费 —— 修复前会白跑一次
    expect(refreshed).toBe(0)
  })

  it('地域限制的错误码不是 AUTH（否则 UI 会显示「API 密钥无效」掩盖真实原因）', async () => {
    // ⚠️ 客户端的 failureMessage() 是 `code === "AUTH" ? "API 密钥无效" : message`
    // —— 只要被归成 AUTH，真实原因就彻底丢失。故这里断言**错误码**，
    // 只断言 message 是恒真的（旧代码原样透传错误体，文案也匹配）。
    const adapter = makeAdapter({
      fetchImpl: (async () => new Response(
        JSON.stringify({ error: 'access forbidden: x is not available in your region' }),
        { status: 403 },
      )) as unknown as typeof fetch,
    })
    let code = ''
    try {
      await collect(adapter)
    } catch (error) {
      code = String((error as { code?: string }).code ?? '')
    }
    expect(code).not.toBe('AUTH')
    expect(code).toBe('PERMISSION_DENIED')
  })

  it('真正的 401 仍然会续期重试（地域判定不能误伤认证路径）', async () => {
    let refreshed = 0
    let call = 0
    const adapter = makeAdapter({
      resolveCredential: async () => (refreshed > 0
        ? { ...cred, access_token: 'workos:new-token' }
        : cred),
      refresh: async () => { refreshed += 1 },
      fetchImpl: (async (_url: string, init: RequestInit) => {
        call += 1
        // 第一次 401（凭据问题），第二次用新凭据成功
        if (call === 1) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
        return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
      }) as unknown as typeof fetch,
    })
    const chunks = await collect(adapter)
    expect(refreshed).toBe(1)
    expect(chunks.length).toBeGreaterThan(0)
  })

  it('限流时换到下一个账号并成功', async () => {
    let call = 0
    const adapter = makeAdapter({
      resolveCredential: async () => cred,
      accountPool: {
        disabledModelsFor: () => new Set<string>(),
        hasLoggedInAccount: async () => true,
        updateModelRateLimit: async () => {},
        getAvailableAccount: async () => ({
          entry: { id: 'acc-2', credentialRef: 'CLINE_ACCOUNT_2' },
          credential: { ...cred, access_token: 'workos:second' },
        }),
      } as never,
      fetchImpl: (async () => {
        call += 1
        if (call === 1) return new Response(JSON.stringify({ error: 'rate limit' }), { status: 429 })
        return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
      }) as unknown as typeof fetch,
    })
    const chunks = await collect(adapter)
    expect(call).toBe(2)
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')).toBe('ok')
  })
})

describe('Cline 接线（源码级回归）', () => {
  const root = resolve(here, '../..')
  const read = (rel: string): string => readFileSync(resolve(root, rel), 'utf8')

  it('index.ts 注册 cline 服务、适配器与续期', () => {
    const source = read('src/index.ts')
    expect(source).toContain('registerClineLlm')
    expect(source).toContain('new ClineAuth(ctx)')
    // 只断言「cline 在续期调度里、且真的被传了池」—— 用 `(pool|p)` 同时接受
    // 逐个 await 与表驱动两种写法，避免每次重构调度器都假失败。
    expect(source).toMatch(/cline\.refreshAll\((?:pool|p)\)/)
    expect(source).toContain('cline.stop()')
    // Jet Hub「显示列表」需要适配器实例
    expect(source).toContain('cline: clineAdapter')
    // ⚠️ 形参是**位置参数**，新增 provider 会插在 cline 与 modelAdapters 之间。
    // 只断言「cline 在 modelAdapters 之前」，**不要**写死整串前缀
    // —— 那会让每加一个 provider 都假失败（加 Loomy、Raccoon、QoderCN 时各踩一次）。
    // 之前的正则把 `…lobsterai, qoder, trae, cline,` 整段写死了，与这条注释矛盾，
    // 故改为只检查「cline 出现在 modelAdapters 之前」这一不变式。
    expect(source).toMatch(
      // ⚠️ 2026-10-04：`modelAdapters` **之后**还可跟实参（doubaoService 追加到
      // 末尾），故结尾用 `[,)]` 而非 `\)` —— 否则每加一个尾参都假失败。
      /registerJetHubRpc\([\s\S]*?cline,[\s\S]*?modelAdapters[,)]/,
    )
    // 老契约下的 settings namespace
    expect(source).toContain("'llm-cline'")
  })

  it('jet-hub-rpc.ts 为 cline 接上登录、续期与余额三个分派点', () => {
    const source = read('src/jet-hub-rpc.ts')
    expect(source).toContain('cline.startLogin({ refName })')
    // `[^)]*` 容忍签名扩展：续期成功后要把新 `expiresAt` 写回账号池，
    // 故调用点带着 `pool, entry.id`（issue !IKIRTT）—— 写死整串会一改签名就假失败。
    expect(source).toMatch(/cline\.refreshAccountCredential\(entry\.credentialRef[^)]*\)/)
    expect(source).toContain('fetchClineCreditBalance(credential, CLINE)')
    // 签到必须显式拒绝（而不是落到 unsupported provider 的泛化文案）
    expect(source).toContain('Cline 不支持每日签到')
  })

  it('客户端 PROVIDERS 含 cline 且有图标', () => {
    const source = read('plugin-src/client/jet-hub.js')
    expect(source).toMatch(/\{\s*id:\s*'cline',\s*label:\s*'Cline'/)
    expect(source).toContain('const CLINE_ICON')
  })

  /**
   * ⚠️ 这条原先断言**整段字面量** `{ balance: true, dailyCheckin: false }`，
   * 于是任何新增能力字段（如 `subscriptionQuota`）都会让它假失败 ——
   * 与上面那条「不要写死整串前缀」是同一类脆断言。
   * 改为逐字段断言，容忍新增字段与格式变化；而「订阅额度**只**给 cline」
   * 这条真正的不变式由 `credits-capabilities.spec.ts` 的行为级用例守住。
   */
  /**
   * ⚠️ 请求记录的**接线完整性**：stream() 有**两个**消费出口
   * （换号成功后的 consume 与正常路径的 consume），漏掉任何一个，
   * 那条路径上的请求就不会出现在「订阅额度 → 请求记录」里。
   * 两个出口都必须走 consumeWithLog（它内部再调 this.consume）。
   */
  it('推理流在两个消费出口都记录请求流水', () => {
    const source = read('src/cline-adapter.ts')
    expect(source.match(/yield\* this\.consumeWithLog\(/g)).toHaveLength(2)
    // 不得有绕过记录的消费出口（记录失败不反噬推理，但漏记会丢数据）
    expect(source).not.toMatch(/yield\* this\.consume\(/)
  })

  /**
   * ⚠️⚠️ **真实缺陷**（用户报障「请求记录中数据空白，没有记录下来」）：
   * 请求记录的「账号」必须是**账号池 id**（`cline-bb211a53`），
   * **不是**凭据里的 `account_id`（`usr-…`）。
   *
   * 面板用 `cline.quota` 下发的**池 id** 去过滤记录（`cline.requestLog` 的
   * `accountId`），而成功路径原先记的是 `credential.account_id` ——
   * 两个 id 空间不一致 ⇒ `readClineRequestHistory({ accountId })` 恒返回空
   * ⇒ **表格永远空白**（换号路径记的却是池 id，两条路径口径还不一致，
   * 属同一缺陷的两半）。
   *
   * ⚠️ **反向验证**：把适配器改回 `credential.account_id ?? …` → 本用例变红。
   */
  it('请求记录归属「账号池 id」（不是凭据里的 usr- 用户 id）', async () => {
    resetClineRequestHistory()
    const adapter = makeAdapter({
      currentAccountId: () => POOL_ACCOUNT_ID,
      fetchImpl: (async () => sseResponse([
        JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ])) as unknown as typeof fetch,
    })
    await collect(adapter)

    const rows = readClineRequestHistory()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.accountId).toBe(POOL_ACCOUNT_ID)
    // 关键：**不能**是凭据里的 `usr-…` —— 那正是空白的原因
    expect(rows[0]!.accountId).not.toBe(cred.account_id)
    // 面板用的过滤条件（池 id）必须能查到这一行，且用 usr-… 查不到
    expect(readClineRequestHistory({ accountId: POOL_ACCOUNT_ID })).toHaveLength(1)
    expect(readClineRequestHistory({ accountId: cred.account_id! })).toHaveLength(0)
  })

  /**
   * 没有池账号（回退到单凭据 `CLINE_ACCESS_TOKEN` 模式）时仍要记一行，
   * 只是退回凭据里的 `account_id` —— 那种模式下 `cline.quota` 同样没有账号
   * 可翻页，记录查不到但至少不丢数据、也不会张冠李戴。
   */
  it('无池账号时退回记凭据的 account_id（单凭据模式不丢记录）', async () => {
    resetClineRequestHistory()
    const adapter = makeAdapter({
      fetchImpl: (async () => sseResponse([
        JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ])) as unknown as typeof fetch,
    })
    await collect(adapter)
    expect(readClineRequestHistory()[0]!.accountId).toBe(cred.account_id)
  })

  /**
   * ⚠️⚠️ **真实缺陷**（用户报障 2026-09-30）：「这个插件中支持图片的模型
   * 发送不了图片」。
   *
   * 根因：图片能力原先**只看本地兜底表**（全表只有 5 条 `cline-free/*`），
   * 于是 `cline-pass/*` 一律被播报成纯文本 ⇒ DSH 根本不把图片送进来。
   * 修复后补上 models.dev 这一级（见 `src/cline-modalities.ts`）。
   *
   * ⚠️ **反向验证**：注释掉 `inputModalitiesFor` 里 `remoteModalities` 那一行
   * → 本用例变红（抛 `不支持图片输入`）。
   */
  it('图片能力取自 models.dev：cline-pass/* 也能发图（不再被误判纯文本）', async () => {
    const bodies: string[] = []
    const adapter = makeAdapter({
      loadModelsDev: async () => new Map([
        ['cline-pass/deepseek-v4.1-flash', { id: 'cline-pass/deepseek-v4.1-flash', supportsImage: true }],
      ]),
      readImage: async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }),
      fetchImpl: (async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body))
        return sseResponse([
          JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }),
          JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        ])
      }) as unknown as typeof fetch,
    })

    await collect(adapter, {
      model: 'cline-pass/deepseek-v4.1-flash',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '看看这张图' },
          { type: 'image', attachment: { attachmentId: 'att-1' } },
        ],
      }],
    })

    expect(bodies).toHaveLength(1)
    // 图片真的被内联成 data URL 发出去了
    expect(bodies[0]).toContain('"image_url"')
    expect(bodies[0]).toContain('data:image/png;base64,')
    expect(bodies[0]).not.toContain('[image unavailable]')
  })

  /** 模态表说「不支持」时照旧拒绝（不能为了修缺陷就无条件放行）。 */
  it('模态表明确不支持时仍拒绝图片（保守方向未失守）', async () => {
    const adapter = makeAdapter({
      loadModelsDev: async () => new Map([
        ['cline-pass/glm-5.3', { id: 'cline-pass/glm-5.3', supportsImage: false }],
      ]),
      readImage: async () => ({ data: new Uint8Array([1]), mediaType: 'image/png' }),
      fetchImpl: (async () => sseResponse([])) as unknown as typeof fetch,
    })
    await expect(collect(adapter, {
      model: 'cline-pass/glm-5.3',
      messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a' } }] }],
    })).rejects.toThrow(/不支持图片输入/)
  })

  /**
   * ⚠️⚠️ **真实缺陷**（用户两次报障：「上游显示的不正确」/「上游显示的还是错误的」）。
   *
   * 「上游」原先取模型 id 的 `/` 前缀（`cline-pass`），那是**订阅通道**、
   * 甚至可能是厂商名，不是 serving channel。修复后取网关下发的路由元数据
   * （`provider_metadata.gateway.routing.finalProvider`，参考实现同源）。
   *
   * ⚠️ **本用例的 fixture 必须用实测的真实形状**：第一版把路由写成**帧顶层**，
   * 而真实流式响应挂在 **`choices[0].delta`** 上 —— 于是用例绿、功能坏，
   * 用户第二次报障才暴露。**这就是「fixture 写错等于没有测试」的活例**：
   * 凡外部载荷的层级，只能照实测写（探针 `probe-cline-routing-live.mjs`）。
   */
  it('请求记录记下网关报的真实上游渠道（而不是模型前缀）', async () => {
    resetClineRequestHistory()
    const adapter = makeAdapter({
      fetchImpl: (async () => sseResponse([
        JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
        // 实测量到的位置：`choices[0].delta.provider_metadata.gateway.routing.finalProvider`
        // （modelAttempts 是真实帧里同时存在的嵌套字段，防止解析器误取嵌套 provider）
        JSON.stringify({
          choices: [{
            index: 0,
            delta: {
              provider_metadata: {
                gateway: {
                  routing: {
                    finalProvider: 'deepseek',
                    modelAttempts: [{ providerAttempts: [{ provider: 'deepseek' }] }],
                  },
                },
              },
            },
          }],
        }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ])) as unknown as typeof fetch,
    })
    await collect(adapter, { model: 'cline-pass/deepseek-v4.1-flash' })

    const row = readClineRequestHistory()[0]!
    expect(row.upstream).toBe('deepseek')
    // 关键：**不能**是模型命名空间
    expect(row.upstream).not.toBe('cline-pass')
  })

  /** 另一种形态（帧顶层）保留兼容 —— 参考实现抓到过它，但**不是**主流式链路。 */
  it('路由挂在帧顶层时同样读得到（兼容形态）', async () => {
    resetClineRequestHistory()
    const adapter = makeAdapter({
      fetchImpl: (async () => sseResponse([
        JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
        JSON.stringify({ provider_metadata: { gateway: { routing: { finalProvider: 'baseten' } } } }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ])) as unknown as typeof fetch,
    })
    await collect(adapter, { model: 'cline-pass/deepseek-v4.1-flash' })
    expect(readClineRequestHistory()[0]!.upstream).toBe('baseten')
  })

  /** 网关没报路由时留空串 —— 由 RPC 侧回落到模型命名空间，**不在适配器里编造**。 */
  it('网关未报路由时 upstream 留空串（不编造渠道名）', async () => {
    resetClineRequestHistory()
    const adapter = makeAdapter({
      fetchImpl: (async () => sseResponse([
        JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ])) as unknown as typeof fetch,
    })
    await collect(adapter, { model: 'cline-pass/deepseek-v4.1-flash' })
    expect(readClineRequestHistory()[0]!.upstream).toBe('')
  })

  /**
   * ⚠️⚠️ **真实缺陷**（用户报障 2026-09-30）：「输出速率 11814.8 t/s」。
   *
   * 速率必须让**分子分母落在同一段时间**：`outputTokens` 含思考 token
   * （本仓库已实测 `reasoning_tokens` 计入 `completion_tokens`），而思考
   * 产生于首字之前 ⇒ 适配器必须**单独**记「首个**正文**块耗时」。
   *
   * ⚠️ **反向验证**：把 `ttfcMs` 的赋值改成与 `ttftMs` 相同（即任何块都算）
   * → 本用例的 `ttfcMs > ttftMs` 断言变红。
   */
  it('分开记录「首块」与「首个正文块」（思考块不算正文）', async () => {
    resetClineRequestHistory()
    const adapter = makeAdapter({
      fetchImpl: (async () => slowSseResponse([
        { delayMs: 40, payload: JSON.stringify({ choices: [{ delta: { reasoning: '想一会儿…' } }] }) },
        { delayMs: 60, payload: JSON.stringify({ choices: [{ delta: { content: '答' } }] }) },
        { delayMs: 10, payload: JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) },
      ])) as unknown as typeof fetch,
    })
    await collect(adapter, { model: 'cline-pass/deepseek-v4.1-flash' })

    const row = readClineRequestHistory()[0]!
    expect(row.ttftMs).toBeGreaterThan(0)
    expect(row.ttfcMs).toBeGreaterThan(0)
    // 关键：正文块**晚于**首块（首块是思考增量）—— 这条断言就是本次修复的判据
    expect(row.ttfcMs).toBeGreaterThan(row.ttftMs)
  })

  /** 只有思考、没有正文时 `ttfcMs` 为 0 ⇒ 展示层把速率显示成 `—` 而不是编一个值。 */
  it('纯思考响应没有正文块：ttfcMs 为 0', async () => {
    resetClineRequestHistory()
    const adapter = makeAdapter({
      fetchImpl: (async () => sseResponse([
        JSON.stringify({ choices: [{ delta: { reasoning: '只想不说' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ])) as unknown as typeof fetch,
    })
    await collect(adapter, { model: 'cline-pass/deepseek-v4.1-flash' })
    expect(readClineRequestHistory()[0]!.ttfcMs).toBe(0)
  })

  /**
   * ⚠️⚠️ **真实缺陷**（用户报障 2026-09-30）：「cline-pass 部分模型列表不全」。
   *
   * 实测对账：网关 `recommended-models` 的 `clinePass` **只下发 14 条**，
   * 而 models.dev 的 `cline-pass` 块有 **18 条** —— 差的 4 条
   * （`kimi-k2.6` / `glm-5.2` / `kimi-k2.7-code` / `deepseek-v4-flash`）
   * 在本插件里**根本不存在**，用户既看不到也选不到。
   * 另外网关给 `cline-pass/*` 的 `name` 就是 id 本身，列表里全是裸 id。
   *
   * ⚠️ **反向验证**：把 `ensureRemoteModels` 里的 `applyModelsDevCatalog(...)`
   * 换回 `models` → 本用例「补进来的模型在目录里」断言变红。
   */
  it('models.dev 补全 cline-pass 目录（网关没下发的模型 + 可读名）', async () => {
    const adapter = makeAdapter({
      loadModelsDev: async () => new Map([
        ['cline-pass/kimi-k2.7-code', {
          id: 'cline-pass/kimi-k2.7-code', name: 'Kimi K2.7 Code', supportsImage: true,
        }],
        ['cline-pass/deepseek-v4.1-flash', {
          id: 'cline-pass/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', supportsImage: true,
        }],
      ]),
    })
    const models = await adapter.listModels('cline')
    const byId = new Map(models.map((m) => [m.id, m]))

    // ① 网关目录里没有的模型被补进来（这是「列表不全」的修复点）
    expect(byId.has('cline-pass/kimi-k2.7-code')).toBe(true)
    // ② 名字是可读的，不是裸 id
    expect(byId.get('cline-pass/kimi-k2.7-code')?.name).toBe('Kimi K2.7 Code')
    expect(byId.get('cline-pass/deepseek-v4.1-flash')?.name).toBe('DeepSeek V4.1 Flash')
    // ③ 图片能力随之播报 —— DSH 据此才会把图片送进适配器
    expect(byId.get('cline-pass/kimi-k2.7-code')?.inputModalities).toEqual(['text', 'image'])
    // ④ 本地兜底表的策展条目不受影响
    expect(byId.get('cline-free/gemini-3.8-flash')?.inputModalities).toEqual(['text', 'image'])
  })

  it('能力矩阵登记 cline 为「有余额、无签到、有订阅额度」', () => {
    const source = read('plugin-src/client/credits-capabilities.js')
    const entry = /cline:\s*Object\.freeze\(\{([^}]*)\}\)/.exec(source)
    expect(entry, '未找到 cline 的能力登记').not.toBeNull()
    const body = entry![1]!
    expect(body).toMatch(/balance:\s*true/)
    expect(body).toMatch(/dailyCheckin:\s*false/)
    expect(body).toMatch(/subscriptionQuota:\s*true/)
  })
})
