/**
 * Step Code（阶跃星辰）协议层 + 登录流程 + 适配器的回归。
 *
 * 这些用例**按官方规格**写（判据取自发行包 `step-0.1.3-windows-x64.zip` 内
 * `step.exe` 的 bundle，以及同包 `docs/step-integration.md`），不是照着我们的
 * 实现复述 —— 否则「改坏实现」不会让它们变红，等于没有防线。
 *
 * | 守什么 | 坏了为什么**不报错** |
 * |---|---|
 * | 凭据字段必须叫 `access_token` | 改名 ⇒ 账号池判重失效，池里长出重复账号 |
 * | `isStepcodeRefreshable` 恒 false | 改 true ⇒ 定时器每 5 分钟发一轮必然失败的请求 |
 * | envelope 的 `status` **缺席**不算失败 | 改 `!== 0` ⇒ 正常响应全判失败，登录永远走不通 |
 * | 模型类型过滤是**条件式**的 | 改无条件 ⇒ 服务端不下发 `model_type` 时目录被清空 |
 * | `expires_at` 是**秒** | 当毫秒 ⇒ 登录在 1970 年就「已超时」，一次请求都不发 |
 * | `uid` 在 poll 响应**顶层** | 去 `credential.uid` 找 ⇒ 静默丢失，同账号永远去重不掉 |
 * | URL 归一**循环**剥 `/v1` | 一次 replace ⇒ `/v1/messages` 场景把版本段发两次 |
 * | 不声明 `defaultEffort` / `defaultMaxTokens` | 硬编 ⇒ 顶格烧思考 token / 给每个请求塞 1M 输出上限 |
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  STEPCODE,
  STEPCODE_MAX_ERROR_DETAIL_LENGTH,
  STEPCODE_USABLE_MODEL_TYPES,
  stepcodeAuthorizeUrl,
  stepcodeChatUrl,
  stepcodeLoginInitUrl,
  stepcodeLoginPollUrl,
  stepcodeModelsUrl,
  stepcodeOpenAiBase,
} from '../../src/stepcode-product.js'
import {
  STEPCODE_STATIC_REFRESH_TOKEN,
  filterStepcodeModels,
  isStepcodeEnvelopeError,
  isStepcodeExpired,
  isStepcodeRefreshable,
  isValidStepcodeFlowId,
  normalizeStepcodeModel,
  normalizeStepcodeUid,
  parseStepcodeCredential,
  parseStepcodeModelsPayload,
  stepcodeAuthHeaders,
  stepcodeEnvelopeDetail,
  type StepcodeCredential,
  type StepcodeModelEntry,
} from '../../src/stepcode.js'
import {
  initStepcodeLogin,
  isRetryableStepcodeLoginError,
  pollStepcodeLogin,
  startStepcodeLoginFlow,
  StepcodeLoginRequestError,
  waitForStepcodeLogin,
} from '../../src/stepcode-oauth.js'
import { StepcodeAdapter } from '../../src/stepcode-adapter.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

// ────────────────────────────── 凭据纯函数 ──────────────────────────────

describe('凭据结构（形状错了 ⇒ 判重/恢复静默失效）', () => {
  it('★ 字段名必须是 access_token（账号池判重依赖它，改名 = 坏判重）', () => {
    const parsed = parseStepcodeCredential(JSON.stringify({ access_token: 'sk-step-abc' }))
    expect(parsed).toBeDefined()
    expect(Object.keys(parsed ?? {})).toContain('access_token')
  })

  it('★ 空 / 缺失 access_token ⇒ undefined（不放行）', () => {
    expect(parseStepcodeCredential(JSON.stringify({ access_token: '   ' }))).toBeUndefined()
    expect(parseStepcodeCredential(JSON.stringify({ uid: 'x' }))).toBeUndefined()
    expect(parseStepcodeCredential('not-json-at-all')).toBeUndefined()
  })

  it('★ isStepcodeRefreshable 恒 false（官方 refresh 只校验哨兵串、不发请求）', () => {
    // 哨兵值与官方 bundle 的 STEP_STATIC_REFRESH_TOKEN 逐字一致。
    expect(STEPCODE_STATIC_REFRESH_TOKEN).toBe('step-static-credential')
    expect(isStepcodeRefreshable({ access_token: 'sk' })).toBe(false)
    expect(isStepcodeRefreshable({ access_token: 'sk', refresh: STEPCODE_STATIC_REFRESH_TOKEN })).toBe(false)
  })

  it('★ 读不到 expires_at ⇒ 判「未过期」（判成已过期会让每次发消息先撞一次必然失败的续期）', () => {
    expect(isStepcodeExpired({ access_token: 'sk' })).toBe(false)
    expect(isStepcodeExpired({ access_token: 'sk', expires_at: String(Date.now() + 60_000) })).toBe(false)
    expect(isStepcodeExpired({ access_token: 'sk', expires_at: String(Date.now() - 60_000) })).toBe(true)
    // 不可解析的值同样按「未知」处理（不是 1970 ⇒ 恒已过期）。
    expect(isStepcodeExpired({ access_token: 'sk', expires_at: 'garbage' })).toBe(false)
  })

  it('★ 请求头**只有** accept + authorization（没有别家的签名/归属头，也没缺 Bearer）', () => {
    const headers = stepcodeAuthHeaders({ access_token: ' sk-key ' })
    expect(Object.keys(headers).sort()).toEqual(['accept', 'authorization'])
    expect(headers.authorization).toBe('Bearer sk-key')
    expect(headers.accept).toBe('application/json')
  })
})

// ────────────────────────────── 端点拼接 ──────────────────────────────

describe('端点拼接（拼错 ⇒ 404，表象与「base 少了 /v1」一模一样）', () => {
  it('★ 规范 base 自动补 /v1', () => {
    expect(stepcodeOpenAiBase('https://api.stepfun.com/step_plan'))
      .toBe('https://api.stepfun.com/step_plan/v1')
    expect(stepcodeChatUrl()).toBe('https://api.stepfun.com/step_plan/v1/chat/completions')
    expect(stepcodeModelsUrl()).toBe('https://api.stepfun.com/step_plan/v1/models')
  })

  it('★ 结尾已带 /v1、/messages 时不得重复（官方 normalize 是**循环**剥离）', () => {
    expect(stepcodeOpenAiBase('https://api.stepfun.com/step_plan/v1'))
      .toBe('https://api.stepfun.com/step_plan/v1')
    expect(stepcodeOpenAiBase('https://api.stepfun.com/step_plan/v1/messages'))
      .toBe('https://api.stepfun.com/step_plan/v1')
    // 叠加形态一次 replace 处理不掉，必须循环 —— 这条用来钉死那个 `while`。
    expect(stepcodeOpenAiBase('https://api.stepfun.com/step_plan/v1/messages/v1'))
      .toBe('https://api.stepfun.com/step_plan/v1')
    // 大小写不敏感（官方比较的是 lowerPathname）。
    expect(stepcodeOpenAiBase('https://api.stepfun.com/step_plan/V1'))
      .toBe('https://api.stepfun.com/step_plan/v1')
  })

  it('登录 / 授权 URL 形态逐字对齐官方（前缀与参数名写死）', () => {
    expect(stepcodeLoginInitUrl())
      .toBe('https://platform.stepfun.com/api/stdhttp/v1/cli-login/init')
    expect(stepcodeLoginPollUrl('flow-123'))
      .toBe('https://platform.stepfun.com/api/stdhttp/v1/cli-login/poll/flow-123')
    // flow_id 会被拼进**路径**，必须 URL 编码。
    expect(stepcodeLoginPollUrl('a/b c')).toContain('poll/a%2Fb%20c')
    const authorize = new URL(stepcodeAuthorizeUrl('flow-123'))
    expect(authorize.origin).toBe('https://platform.stepfun.com')
    expect(authorize.pathname).toBe('/cli-login-remote')
    expect(authorize.searchParams.get('flow_id')).toBe('flow-123')
  })
})

// ────────────────────────────── 输入校验 ──────────────────────────────

describe('服务端返回值的输入校验（它们会被拼进路径 / 落进存储）', () => {
  it('flow_id 白名单：`^[A-Za-z0-9._-]{1,128}$`', () => {
    expect(isValidStepcodeFlowId('Abc._-123')).toBe(true)
    expect(isValidStepcodeFlowId('')).toBe(false)
    expect(isValidStepcodeFlowId('a/b')).toBe(false) // 会进路径 ⇒ 必须拦
    expect(isValidStepcodeFlowId('a b')).toBe(false)
    expect(isValidStepcodeFlowId('x'.repeat(129))).toBe(false)
    expect(isValidStepcodeFlowId(123)).toBe(false)
  })

  it('uid：≤64 且只允许 [\\w.@:-]，否则丢弃（不落进存储）', () => {
    expect(normalizeStepcodeUid('01a0df0a-4f2b-4c2e')).toBe('01a0df0a-4f2b-4c2e')
    expect(normalizeStepcodeUid('a@b.c:d')).toBe('a@b.c:d')
    expect(normalizeStepcodeUid('x'.repeat(65))).toBeUndefined()
    expect(normalizeStepcodeUid('has space')).toBeUndefined()
    expect(normalizeStepcodeUid('')).toBeUndefined()
    expect(normalizeStepcodeUid(undefined)).toBeUndefined()
  })

  it('★ envelope 失败判据：status **缺席**不算失败（否则正常响应全被判失败）', () => {
    expect(isStepcodeEnvelopeError({ status: 1 })).toBe(true)
    expect(isStepcodeEnvelopeError({ status: -1 })).toBe(true)
    expect(isStepcodeEnvelopeError({ status: 0 })).toBe(false)
    // 这两条是核心：poll 的成功响应可能压根没有 status 字段。
    expect(isStepcodeEnvelopeError({ state: 'ready', credential: {} })).toBe(false)
    expect(isStepcodeEnvelopeError({})).toBe(false)
    expect(isStepcodeEnvelopeError(null)).toBe(false)
    expect(isStepcodeEnvelopeError([1, 2])).toBe(false)
  })

  it('错误详情：剥控制字符后截断到 240（防终端转义序列进日志 / UI）', () => {
    expect(stepcodeEnvelopeDetail({ desc: '参数无效' })).toBe('参数无效')
    expect(stepcodeEnvelopeDetail({ desc: 'x'.repeat(500) })).toHaveLength(STEPCODE_MAX_ERROR_DETAIL_LENGTH)
    // 控制字符被剥掉（\p{Cc}），普通空格与汉字保留。
    expect(stepcodeEnvelopeDetail({ desc: 'a\u001bb\n正常' })).toBe('ab正常')
    expect(stepcodeEnvelopeDetail({})).toBe('')
    expect(stepcodeEnvelopeDetail('not-an-object')).toBe('')
  })
})

// ────────────────────────────── 模型目录 ──────────────────────────────

describe('远端目录归一与过滤', () => {
  it('★ 归一：字段逐字对应官方解析器', () => {
    const entry = normalizeStepcodeModel({
      id: 'step-5-preview',
      model_type: '大语言模型',
      max_input_tokens: 1_000_000,
      enable_reason: false,
      enable_vision_input: true,
      reasoning_effort_support_list: ['low', 'high'],
    })
    expect(entry).toMatchObject({
      id: 'step-5-preview',
      // 展示名 = id（远端不下发独立展示名，**不编造**好看的名字）。
      name: 'step-5-preview',
      contextWindow: 1_000_000,
      supportsImage: true,
      reasoning: false,
      modelType: '大语言模型',
    })
    expect(entry?.efforts).toEqual(['low', 'high'])
  })

  it('★ 无 id ⇒ undefined（不编造条目）', () => {
    expect(normalizeStepcodeModel({ model_type: '大语言模型' })).toBeUndefined()
    expect(normalizeStepcodeModel('str')).toBeUndefined()
    expect(normalizeStepcodeModel(null)).toBeUndefined()
    expect(normalizeStepcodeModel([1])).toBeUndefined()
  })

  it('★ 窗口缺失 / 非法 ⇒ 官方默认 256000', () => {
    expect(normalizeStepcodeModel({ id: 'm' })?.contextWindow).toBe(256_000)
    expect(normalizeStepcodeModel({ id: 'm', max_input_tokens: -5 })?.contextWindow).toBe(256_000)
    expect(normalizeStepcodeModel({ id: 'm', max_input_tokens: 0.5 })?.contextWindow).toBe(256_000)
  })

  it('★ reasoning 推论链：无 enable_reason 但**有档位** ⇒ 支持思考', () => {
    // 官方口径：reasoning = enable_reason ?? (hasEfforts ? true : false)
    expect(normalizeStepcodeModel({ id: 'm', reasoning_effort_support_list: ['high'] })?.reasoning).toBe(true)
    expect(normalizeStepcodeModel({ id: 'm' })?.reasoning).toBe(false)
    expect(normalizeStepcodeModel({ id: 'm', enable_reason: false, reasoning_effort_support_list: ['high'] })?.reasoning)
      .toBe(false) // 显式 false 优先
    // 档位数组全空 ⇒ 整个键不产出（调用方据此不声明 reasoning）
    expect(normalizeStepcodeModel({ id: 'm', reasoning_effort_support_list: ['  '] })?.efforts).toBeUndefined()
  })

  it('★ 类型过滤是**条件式**的：一个条目都没带 model_type 时不过滤', () => {
    const entry = (id: string, type?: string): StepcodeModelEntry => ({
      id, name: id, contextWindow: 100, supportsImage: false, reasoning: false,
      ...type === undefined ? {} : { modelType: type },
    })
    // 全无 model_type ⇒ 全部保留（否则服务端改个字段名目录就空了）
    expect(filterStepcodeModels([entry('a'), entry('b')]).map((e) => e.id)).toEqual(['a', 'b'])
    // 有 model_type ⇒ 只留白名单 {大语言模型, 路由模型}
    const mixed = [entry('a', '大语言模型'), entry('b', '视觉模型'), entry('c', '路由模型')]
    expect(filterStepcodeModels(mixed).map((e) => e.id)).toEqual(['a', 'c'])
    expect(STEPCODE_USABLE_MODEL_TYPES.has('大语言模型')).toBe(true)
    expect(STEPCODE_USABLE_MODEL_TYPES.has('路由模型')).toBe(true)
    expect(STEPCODE_USABLE_MODEL_TYPES.has('vision')).toBe(false)
  })

  it('去重：同 id 保留首次出现的条目', () => {
    const dup: StepcodeModelEntry = {
      id: 'm', name: 'm', contextWindow: 1, supportsImage: false, reasoning: false, modelType: '大语言模型',
    }
    const kept = filterStepcodeModels([dup, { ...dup, contextWindow: 999 }])
    expect(kept).toHaveLength(1)
    expect(kept[0].contextWindow).toBe(1)
  })

  it('响应体解析：只认 {data:[…]}；坏形状 ⇒ 空数组（不抛错）', () => {
    expect(parseStepcodeModelsPayload({ data: [{ id: 'a' }] })).toHaveLength(1)
    expect(parseStepcodeModelsPayload({})).toEqual([])
    expect(parseStepcodeModelsPayload({ data: 'x' })).toEqual([])
    expect(parseStepcodeModelsPayload(null)).toEqual([])
    // 非对象条目被跳过，不炸
    expect(parseStepcodeModelsPayload({ data: [{ id: 'a' }, 42, null] })).toHaveLength(1)
  })
})

// ────────────────────────────── 登录流程 ──────────────────────────────

/** 造一个 JSON `Response`。 */
function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** 记录每次 fetch 调用的桩。 */
function recorder(handler: (url: string) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    calls.push({ url: u, init: init ?? {} })
    return handler(u)
  }) as unknown as typeof fetch
  return { calls, fetcher }
}

/** 一个尚未过期的 init 产物（`expiresAt` 是**秒**）。 */
function goodInit() {
  return {
    flowId: 'flow-1',
    authorizeUrl: 'https://platform.stepfun.com/cli-login-remote?flow_id=flow-1',
    pollIntervalSec: 1,
    expiresAt: Math.floor(Date.now() / 1000) + 600,
  }
}

describe('登录 init（浏览器授权前的唯一一次往返）', () => {
  it('★ 请求形态逐字复刻官方：POST + pollToken 走 Bearer + profile/origin/client', async () => {
    const { calls, fetcher } = recorder(() => jsonResponse({
      flow_id: 'flow-abc', poll_interval_sec: 3, expires_at: Math.floor(Date.now() / 1000) + 600,
    }))
    const init = await initStepcodeLogin({
      pollToken: 'p'.repeat(64), fetcher, clientVersion: '0.1.3', clientPlatform: 'win32-x64',
    })

    expect(calls[0].url).toBe('https://platform.stepfun.com/api/stdhttp/v1/cli-login/init')
    expect(calls[0].init.method).toBe('POST')
    const headers = calls[0].init.headers as Record<string, string>
    // pollToken **必须**放在 authorization（官方 request() 原文）——
    // 放成 query 或自定义头会让服务端不知道「是谁在轮询」。
    expect(headers.authorization).toBe(`Bearer ${'p'.repeat(64)}`)
    expect(headers.accept).toBe('application/json')
    expect(headers['content-type']).toBe('application/json')

    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>
    expect(body.profile).toBe('step_plan')
    expect(body.origin).toBe('https://platform.stepfun.com')
    expect(body.client).toEqual({ name: 'stepcode', version: '0.1.3', platform: 'win32-x64' })

    expect(init.flowId).toBe('flow-abc')
    expect(init.pollIntervalSec).toBe(3)
    expect(init.authorizeUrl).toContain('/cli-login-remote?flow_id=flow-abc')
  })

  it('★ poll_interval_sec 被 clamp 到 ≤60 秒（服务端给多大都不全听）', async () => {
    const { fetcher } = recorder(() => jsonResponse({
      flow_id: 'f', poll_interval_sec: 999, expires_at: Math.floor(Date.now() / 1000) + 60,
    }))
    expect((await initStepcodeLogin({ pollToken: 't', fetcher })).pollIntervalSec).toBe(60)
  })

  it('缺 flow_id / 间隔 < 1 / 缺 expires_at 各自抛**协议**错误', async () => {
    const t = Math.floor(Date.now() / 1000) + 60
    const cases: Array<Record<string, unknown>> = [
      { poll_interval_sec: 3, expires_at: t },
      { flow_id: 'bad flow id', poll_interval_sec: 3, expires_at: t },
      { flow_id: 'f', poll_interval_sec: 0, expires_at: t },
      { flow_id: 'f', poll_interval_sec: 3 },
      { flow_id: 'f', poll_interval_sec: 3, expires_at: 0 },
    ]
    for (const payload of cases) {
      const { fetcher } = recorder(() => jsonResponse(payload))
      await expect(initStepcodeLogin({ pollToken: 't', fetcher })).rejects.toThrow(/Step 登录协议异常/)
    }
  })

  it('信封失败（HTTP 200 + status 非 0）也要抛错，且 desc 进错误文案', async () => {
    const { fetcher } = recorder(() => jsonResponse({ status: 7, desc: 'not allowed' }))
    await expect(initStepcodeLogin({ pollToken: 't', fetcher })).rejects.toThrow(/not allowed/)
  })
})

describe('登录 poll 与等待', () => {
  it('★ ready：api_key 在 credential 里、uid 在**顶层**（写错位置会静默丢 uid）', async () => {
    const { fetcher } = recorder(() => jsonResponse({
      state: 'ready', uid: 'uid-42', credential: { api_key: 'sk-step-1' },
    }))
    expect(await pollStepcodeLogin({ flowId: 'flow-1', pollToken: 't', fetcher }))
      .toEqual({ state: 'ready', apiKey: 'sk-step-1', uid: 'uid-42' })
  })

  it('ready 但缺 api_key ⇒ 协议错误（不产出半个凭据）', async () => {
    const { fetcher } = recorder(() => jsonResponse({ state: 'ready', credential: {} }))
    await expect(pollStepcodeLogin({ flowId: 'flow-1', pollToken: 't', fetcher })).rejects.toThrow(/api_key/)
  })

  it('pending / failed 三态映射（denied 单独可辨；未知 state 抛协议错误）', async () => {
    const pending = recorder(() => jsonResponse({ state: 'pending' }))
    expect(await pollStepcodeLogin({ flowId: 'flow-1', pollToken: 't', fetcher: pending.fetcher }))
      .toEqual({ state: 'pending' })

    const denied = recorder(() => jsonResponse({ state: 'failed', reason: 'denied' }))
    expect(await pollStepcodeLogin({ flowId: 'flow-1', pollToken: 't', fetcher: denied.fetcher }))
      .toEqual({ state: 'failed', reason: 'denied' })

    const other = recorder(() => jsonResponse({ state: 'failed', reason: 'timeout' }))
    expect(await pollStepcodeLogin({ flowId: 'flow-1', pollToken: 't', fetcher: other.fetcher }))
      .toEqual({ state: 'failed', reason: 'unknown' })

    const bogus = recorder(() => jsonResponse({ state: 'nonsense' }))
    await expect(pollStepcodeLogin({ flowId: 'flow-1', pollToken: 't', fetcher: bogus.fetcher }))
      .rejects.toThrow(/未知的 state/)
  })

  it('★ waitFor：轮询到 ready 即返回；用户拒绝与其它失败给**不同文案**', async () => {
    const sequence = [
      jsonResponse({ state: 'pending' }),
      jsonResponse({ state: 'ready', credential: { api_key: 'sk' } }),
    ]
    const { fetcher } = recorder(() => sequence.shift() ?? jsonResponse({ state: 'pending' }))
    expect(await waitForStepcodeLogin({ init: goodInit(), pollToken: 't', fetcher }))
      .toEqual({ state: 'ready', apiKey: 'sk' })

    const denied = recorder(() => jsonResponse({ state: 'failed', reason: 'denied' }))
    await expect(waitForStepcodeLogin({ init: goodInit(), pollToken: 't', fetcher: denied.fetcher }))
      .rejects.toThrow(/被拒绝/)
    const failed = recorder(() => jsonResponse({ state: 'failed', reason: 'oops' }))
    await expect(waitForStepcodeLogin({ init: goodInit(), pollToken: 't', fetcher: failed.fetcher }))
      .rejects.toThrow(/登录在浏览器中失败/)
  })

  it('★ expires_at 是**秒**级：给一个过去的时间 ⇒ 立即超时，一次请求都不发', async () => {
    const { calls, fetcher } = recorder(() => jsonResponse({ state: 'pending' }))
    await expect(waitForStepcodeLogin({
      init: { ...goodInit(), expiresAt: Math.floor(Date.now() / 1000) - 60 },
      pollToken: 't',
      fetcher,
    })).rejects.toThrow(/超时/)
    // 关键判据：若实现把秒当毫秒，这里会算出「还没过期」并真的发请求。
    expect(calls).toHaveLength(0)
  })
})

describe('可重试判定（决定轮询要不要硬扛）', () => {
  const of = (kind: 'http' | 'transport' | 'protocol', status?: number) =>
    new StepcodeLoginRequestError(kind, 'x', status)

  it('408/429/5xx/传输错误可重试；401/403/协议错误不重试', () => {
    expect(isRetryableStepcodeLoginError(of('http', 408))).toBe(true)
    expect(isRetryableStepcodeLoginError(of('http', 429))).toBe(true)
    expect(isRetryableStepcodeLoginError(of('http', 500))).toBe(true)
    expect(isRetryableStepcodeLoginError(of('transport'))).toBe(true)
    // 401/403 是 pollToken / profile 不对，重试一万次也不会变对。
    expect(isRetryableStepcodeLoginError(of('http', 401))).toBe(false)
    expect(isRetryableStepcodeLoginError(of('http', 403))).toBe(false)
    // 响应形状不对 ⇒ 重试只会得到同样形状。
    expect(isRetryableStepcodeLoginError(of('protocol'))).toBe(false)
    expect(isRetryableStepcodeLoginError(new Error('x'))).toBe(false)
  })
})

describe('startStepcodeLoginFlow（两步式：立即回 URL、后台落定）', () => {
  it('★ 返回 loginUrl 即可（不等用户授权），result 随后产出合法凭据 JSON', async () => {
    const { fetcher } = recorder((url) => url.endsWith('/init')
      ? jsonResponse({ flow_id: 'f1', poll_interval_sec: 1, expires_at: Math.floor(Date.now() / 1000) + 600 })
      : jsonResponse({ state: 'ready', uid: 'uid-9', credential: { api_key: 'sk-step' } }))

    const started = await startStepcodeLoginFlow({ fetcher, pollToken: 'tok' })
    // 两步式硬约束：先拿到 URL（前端要在用户手势窗口内弹窗）。
    expect(started.loginUrl).toContain('flow_id=f1')

    const result = await started.result
    const credential = JSON.parse(result.access) as StepcodeCredential
    expect(credential.access_token).toBe('sk-step')
    expect(credential.uid).toBe('uid-9')
    expect(credential.profile).toBe('step_plan')
    // 静态凭据：refreshable 恒 false、expires=0（「无有效期」哨兵）。
    expect(result.refreshable).toBe(false)
    expect(result.expires).toBe(0)
    expect(result.loginUrl).toBe(started.loginUrl)
    await started.close()
  })

  it('★ close() 幂等，且会中止等待中的轮询', async () => {
    /**
     * ⚠️ 桩必须**先满足 init**（返回 flow_id 等），只有 poll 才一直 pending ——
     * 否则 `startStepcodeLoginFlow` 在 init 阶段就抛协议错误，
     * 这条用例测的就不是「close 中止轮询」了（首版写成恒定 pending 时实测踩到）。
     */
    const { fetcher } = recorder((url) => url.endsWith('/init')
      ? jsonResponse({ flow_id: 'f1', poll_interval_sec: 1, expires_at: Math.floor(Date.now() / 1000) + 600 })
      : jsonResponse({ state: 'pending' }))
    const started = await startStepcodeLoginFlow({ fetcher, pollToken: 'tok' })
    expect(started.loginUrl).toContain('flow_id=f1')
    await started.close()
    await started.close() // 第二次无害（幂等）
    // 中止后 result 必须以拒绝落定（不能永远挂起，否则调用方的 .catch 永不执行）
    await expect(started.result).rejects.toThrow()
  })

  it('授权站非 https / 内嵌凭据 ⇒ 直接拒绝（防止 pollToken 落到明文端点）', async () => {
    await expect(startStepcodeLoginFlow({
      product: { ...STEPCODE, authBase: 'http://platform.stepfun.com' },
    })).rejects.toThrow(/https/)
    await expect(startStepcodeLoginFlow({
      product: { ...STEPCODE, authBase: 'https://user:pass@platform.stepfun.com' },
    })).rejects.toThrow(/用户名或密码/)
  })
})

// ────────────────────────────── 适配器 ──────────────────────────────

const model = (over: Partial<StepcodeModelEntry> & { id: string }): StepcodeModelEntry => ({
  name: over.id,
  contextWindow: 128_000,
  supportsImage: false,
  reasoning: false,
  ...over,
})

/** 造一个带远端目录的适配器。 */
function makeAdapter(models: readonly StepcodeModelEntry[], options: Record<string, unknown> = {}) {
  const credential: StepcodeCredential = { access_token: 'sk-step' }
  const adapter = new StepcodeAdapter({
    credentialRef: 'STEPCODE_ACCESS_TOKEN' as never,
    resolveCredential: async () => credential,
    refresh: async () => {},
    fetchRemoteModels: async () => models,
    product: STEPCODE,
    ...options,
  })
  return { adapter, credential }
}

describe('resolveModel（声明错了 ⇒ UI 出不来档位 / 或直接崩）', () => {
  it('★ 有档位 ⇒ 声明 reasoning，efforts 用**官方中文**展示名', async () => {
    const { adapter } = makeAdapter([model({ id: 'm1', reasoning: true, efforts: ['low', 'high', 'max'] })])
    const resolved = await adapter.resolveModel('stepcode', 'm1')
    expect(resolved.reasoning?.efforts.map((e) => String(e.id))).toEqual(['low', 'high', 'max'])
    expect(resolved.reasoning?.efforts.map((e) => e.name)).toEqual(['低', '高', '最大'])
  })

  it('★ **不声明 defaultEffort**（远端不下发默认档 ⇒ 跟随上游；硬编会顶格烧思考 token）', async () => {
    const { adapter } = makeAdapter([model({ id: 'm1', reasoning: true, efforts: ['high'] })])
    const resolved = await adapter.resolveModel('stepcode', 'm1')
    expect(resolved.reasoning?.efforts).toHaveLength(1)
    expect(resolved.reasoning).not.toHaveProperty('defaultEffort')
  })

  it('★ 无档位 ⇒ 整个 reasoning 键不产出（UI 显示「未提供推理等级」）', async () => {
    const { adapter } = makeAdapter([model({ id: 'm1' })])
    const resolved = await adapter.resolveModel('stepcode', 'm1')
    expect(resolved.reasoning).toBeUndefined()
    expect(resolved).not.toHaveProperty('reasoning')
  })

  it('★ **不声明 defaultMaxTokens**（官方那个 maxTokens=contextWindow 是 pi 的 clamp 值，不是发送值）', async () => {
    const { adapter } = makeAdapter([model({ id: 'm1', contextWindow: 1_000_000 })])
    const resolved = await adapter.resolveModel('stepcode', 'm1')
    expect(resolved.context?.contextWindow).toBe(1_000_000)
    expect(resolved).not.toHaveProperty('defaultMaxTokens')
  })

  it('未知模型不编造 context；窗口为 0 视作未知', async () => {
    const { adapter } = makeAdapter([model({ id: 'm1', contextWindow: 0 })])
    expect((await adapter.resolveModel('stepcode', 'm1')).context).toBeUndefined()
    expect((await adapter.resolveModel('stepcode', 'nope')).context).toBeUndefined()
  })

  it('图片支持按模型的 enable_vision_input 声明', async () => {
    const { adapter } = makeAdapter([model({ id: 'v', supportsImage: true }), model({ id: 't' })])
    expect((await adapter.resolveModel('stepcode', 'v')).inputModalities).toEqual(['text', 'image'])
    expect((await adapter.resolveModel('stepcode', 't')).inputModalities).toEqual(['text'])
  })

  it('listAllModels 必须**同步**返回（RPC 不 await，返回 Promise 会让「显示列表」崩）', async () => {
    const { adapter } = makeAdapter([model({ id: 'a' })])
    /**
     * ⚠️ `listAllModels()` 读的是**缓存**（`remoteModels`），必须先有一次
     * `listModels` / `resolveModel` 把它填上 —— 这正是 RPC 的真实调用序列
     * （它先 `await llm.listModels(provider)` 再取实例的 `listAllModels()`）。
     * 缓存未填充时它回退兜底表，而 Step Code 的兜底表**刻意为空**
     * （官方 `STEP_MODELS = []`），故这里必须先预热。
     */
    await adapter.listModels('stepcode')
    const all = adapter.listAllModels()
    expect(Array.isArray(all)).toBe(true)
    expect(all).toHaveLength(1)
    expect(all[0]).toEqual({ id: 'a', name: 'a' })
  })

  it('★ 缓存未预热时 listAllModels 回退**空**兜底表（官方 STEP_MODELS = []，不编造条目）', () => {
    const { adapter } = makeAdapter([model({ id: 'a' })])
    // 同步、不抛错，只是空 —— 这比返回一张假目录安全。
    expect(adapter.listAllModels()).toEqual([])
  })

  /**
   * ★★ 真实缺陷回归（2026-10-09 用户报障「模型列表里没有这个」）。
   *
   * ## 缺陷形态
   *
   * ① 用户首次打开模型设置时还没登录 ⇒ `fetchRemoteModels()` 返回空
   *（无凭据 ⇒ 取兜底表，而此 provider 兜底表**刻意为空**）；
   * ② 旧实现把这个 `[]` 写进 `remoteModels` 缓存；
   * ③ 用户随后登录成功，但 `loadModels` 的
   *    `if (this.remoteModels !== undefined) return` 会**永远**短路
   *    ⇒ 再也不拉目录 ⇒ 模型列表始终为空，直到重启 DSH。
   *
   * ## 判据（两条都要，缺任一条该缺陷都会复现）
   *
   * 「空目录**不得**落缓存」+「登录后 `invalidateModelCache()` 能强制重拉」。
   */
  it('★★ 空目录**不得**落缓存（否则登录成功后永远拉不到目录）', async () => {
    let calls = 0
    // 第一次（未登录）返回空，之后返回真目录 —— 模拟「用户随后完成登录」。
    const { adapter } = makeAdapter([], {
      fetchRemoteModels: async () => {
        calls += 1
        return calls === 1 ? [] : [model({ id: 'late', contextWindow: 262_144 })]
      },
    })

    // ① 未登录：目录为空
    expect(await adapter.listModels('stepcode')).toHaveLength(0)

    // ② 登录后：必须能拿到目录（旧实现这里恒为 0，因为空数组被缓存了）
    const after = await adapter.listModels('stepcode')
    expect(after.map((m) => m.id)).toEqual(['late'])
    // 且确实**重新拉取过**（不是碰巧命中缓存）
    expect(calls).toBeGreaterThanOrEqual(2)
    // 非空结果此后正常缓存（再读不再触发拉取）
    const settled = calls
    await adapter.listModels('stepcode')
    expect(calls).toBe(settled)
  })

  it('★ invalidateModelCache() 能强制重拉（登录回调据此让目录立刻可用）', async () => {
    let models: readonly StepcodeModelEntry[] = []
    const { adapter } = makeAdapter([], { fetchRemoteModels: async () => models })

    expect(await adapter.listModels('stepcode')).toHaveLength(0)
    // 模拟登录成功：目录源变了，并显式失效缓存
    models = [model({ id: 'm-after-login' })]
    adapter.invalidateModelCache()
    expect((await adapter.listModels('stepcode')).map((m) => m.id)).toEqual(['m-after-login'])
    // 幂等：重复调用无害
    adapter.invalidateModelCache()
    adapter.invalidateModelCache()
    expect((await adapter.listModels('stepcode')).map((m) => m.id)).toEqual(['m-after-login'])
  })

  it('★ 兜底表非空时仍应缓存（别把「空不缓存」误改成「一律不缓存」）', () => {
    // 本 provider 兜底表为空 ⇒ 预热不落缓存；但若产品配了非空兜底表，
    // 它必须落缓存，否则每次读都回退并丢掉远端结果。
    const product = {
      ...STEPCODE,
      fallbackModels: [{ id: 'fb', name: 'fb', contextWindow: 1000, supportsImage: false }],
    }
    const adapter = new StepcodeAdapter({
      credentialRef: 'STEPCODE_ACCESS_TOKEN' as never,
      resolveCredential: async () => undefined,
      refresh: async () => {},
      product,
    })
    // 无 fetchRemoteModels ⇒ 走兜底表，且应被缓存下来（第二次读不再重新构造）
    expect(adapter.listAllModels().map((m) => m.id)).toEqual(['fb'])
  })
})

describe('stream（错误必须抛，且 tools 必须真下发）', () => {
  const userText = (t: string) => ({ role: 'user', content: t })

  /** 捕获请求体、返回极简 SSE 的桩。 */
  function spyFetch(bodyOut: { value?: unknown }) {
    const sse = [
      'data: {"choices":[{"delta":{"role":"assistant","content":"hi"},"index":0}]}',
      '',
      'data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      bodyOut.value = JSON.parse(String(init?.body)) as unknown
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as unknown as typeof fetch
    return { fetcher, calls }
  }

  it('★ 无凭据 ⇒ 抛 MISSING_CREDENTIAL（不静默返回空流）', async () => {
    const { adapter } = makeAdapter([model({ id: 'm1' })], { resolveCredential: async () => undefined })
    const gen = adapter.stream({ model: 'm1', messages: [userText('hi')] } as never)
    await expect(gen.next()).rejects.toThrow(/log in first/)
  })

  it('★ 带图但模型不支持 ⇒ 抛 UNSUPPORTED_CONTENT（绝不静默丢图）', async () => {
    const { adapter } = makeAdapter([model({ id: 'm1', supportsImage: false })])
    const gen = adapter.stream({
      model: 'm1',
      // 图片块的判据是 attachment.attachmentId（见 openai-compat 的 collectImages）。
      messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a1' } }] }],
    } as never)
    await expect(gen.next()).rejects.toThrow(/不支持图片输入/)
  })

  it('★ 模型支持图片但未提供 readImage ⇒ 同样抛错（不静默丢图）', async () => {
    const { adapter } = makeAdapter([model({ id: 'm1', supportsImage: true })])
    const gen = adapter.stream({
      model: 'm1',
      messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a1' } }] }],
    } as never)
    await expect(gen.next()).rejects.toThrow(/readImage/)
  })

  it('★ tools 真的下发到请求体顶层 tools（不下发 ⇒ 模型正文臆造调用 ⇒ 任务终止）', async () => {
    const captured: { value?: unknown } = {}
    const { fetcher, calls } = spyFetch(captured)
    vi.stubGlobal('fetch', fetcher)

    const { adapter } = makeAdapter([model({ id: 'm1' })])
    const gen = adapter.stream({
      model: 'm1',
      messages: [userText('hi')],
      system: 'sys',
      maxTokens: 512,
      reasoningEffort: 'high',
      tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }],
    } as never)
    for await (const _chunk of gen) { /* 消费完 */ }

    const body = captured.value as Record<string, any>
    expect(body.model).toBe('m1')
    expect(body.stream).toBe(true)
    expect(body.max_tokens).toBe(512)
    expect(body.tools).toHaveLength(1)
    expect(body.tools[0]).toEqual({
      type: 'function',
      function: { name: 'read_file', description: 'read', parameters: { type: 'object' } },
    })
    // system 被 unshift 成首条 system 消息
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' })
    // 思考档位的 wire 字段名是 reasoning_effort（官方 pi 侧 params.reasoning_effort）
    expect(body.reasoning_effort).toBe('high')
    // 端点必须是 /step_plan/v1/chat/completions（不是 /v1、也不是 /messages）
    expect(calls[0].url).toBe('https://api.stepfun.com/step_plan/v1/chat/completions')
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-step')
  })

  it('不给 reasoningEffort ⇒ 请求体里**没有**该字段（不擅自发明默认档）', async () => {
    const captured: { value?: unknown } = {}
    vi.stubGlobal('fetch', spyFetch(captured).fetcher)
    const { adapter } = makeAdapter([model({ id: 'm1' })])
    for await (const _chunk of adapter.stream({ model: 'm1', messages: [userText('hi')] } as never)) { /* 消费 */ }
    expect(captured.value as Record<string, unknown>).not.toHaveProperty('reasoning_effort')
  })

  it('★ HTTP 500 ⇒ 抛错（不静默结束）；HTTP 401 ⇒ 归 AUTH（不当服务器错白重试）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })) as never)
    const { adapter } = makeAdapter([model({ id: 'm1' })])
    await expect(
      adapter.stream({ model: 'm1', messages: [userText('hi')] } as never).next(),
    ).rejects.toThrow(/HTTP 500/)

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"bad key"}', { status: 401 })) as never)
    const { adapter: adapter2 } = makeAdapter([model({ id: 'm1' })])
    try {
      await adapter2.stream({ model: 'm1', messages: [userText('hi')] } as never).next()
      expect.unreachable('应当抛错')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('AUTH')
    }
  })
})
