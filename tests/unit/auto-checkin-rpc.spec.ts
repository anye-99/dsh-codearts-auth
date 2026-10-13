import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerJetHubRpc } from '../../src/jet-hub-rpc.js'
import { createAutoCheckinController } from '../../src/auto-checkin-controller.js'
import { defaultAutoCheckinState } from '../../src/auto-checkin.js'
import type { AutoCheckinState } from '../../src/auto-checkin.js'
import type { AutoCheckinStore } from '../../src/auto-checkin-store.js'

/**
 * `checkin.auto.get` / `checkin.auto.set` 两个 RPC 动词的回归测试。
 *
 * 守住三件事：
 * 1. **装配层缺席时回规范错误**（`jet-hub/auto-checkin-unavailable`），而不是
 *    伪造一份 `enabled: false` —— 后者会让面板显示「已关闭」，用户点开关却报
 *    `bad-request`，一个无法解释的组合；
 * 2. **`enabled` 必须严格是布尔**（真值强转会造出「字符串 `'false'` 也把开关
 *    打开」，而这个开关控制的是十路真实写请求）；
 * 3. **触发不在 RPC 里**：这两个动词只读写状态，绝不发起签到 —— 面板渲染一次
 *    就产生十路写请求是不可接受的。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const rpcSource = readFileSync(resolve(HERE, '../../src/jet-hub-rpc.ts'), 'utf8')
const indexSource = readFileSync(resolve(HERE, '../../src/index.ts'), 'utf8')

type Handler = (request: Request) => Promise<Response>

/** 内存状态后端（避免碰真实磁盘）。 */
function memoryStore(initial: AutoCheckinState): AutoCheckinStore & { saved: AutoCheckinState[] } {
  let current = initial
  const saved: AutoCheckinState[] = []
  return {
    kind: 'memory',
    saved,
    load: () => ({ exists: true, state: current }),
    save: async (next) => { saved.push(next); current = next },
  }
}

/**
 * 注册 Jet Hub 端点并返回「调用方法」的函数。
 *
 * ⚠️ `registerJetHubRpc` 是**位置参数**（19 个槽位，AGENTS.md「位置参数陷阱」）：
 * 下面按槽位顺序显式列出，`autoCheckin` 恒为**最后一个**。
 */
function setup(autoCheckin?: unknown) {
  let handler: Handler | undefined
  const ctx: Record<string, unknown> = {
    get: (key: string) => key === 'connection'
      ? { fetch: { register: (config: { fetch: Handler }) => { handler = config.fetch } } }
      : undefined,
    // 生产代码用惰性注入挂载 connection 端点（见 registerJetHubRpc 的说明）：
    // 替身必须提供 inject，否则会以 `ctx.inject is not a function` 抛错。
    inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
    logger: { warn: () => {}, info: () => {} },
    credentials: { resolve: async () => undefined },
  }
  const pool = { listAccounts: async () => [] }

  registerJetHubRpc(
    ctx as never,
    pool as never,
    {} as never, // 3  codearts
    {} as never, // 4  buddy
    {} as never, // 5  workbuddy
    {} as never, // 6  lobsterai
    {} as never, // 7  qoder
    {} as never, // 8  qoderCn
    {} as never, // 9  trae
    {} as never, // 10 cline
    {} as never, // 11 loomy
    {} as never, // 12 raccoon
    {} as never, // 13 minimax
    {} as never, // 14 teleagent
    {} as never, // 15 zcode
    {} as never, // 16 stepcode
    {} as never, // 17 antigravity
    {} as never, // 18 modelAdapters
    autoCheckin as never, // 19 autoCheckin（追加在末尾，不动前面任何槽位）
  )
  if (handler === undefined) throw new Error('endpoint handler was not registered')

  return async (method: string, payload: unknown) => {
    const response = await handler!(new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'rpc-1',
        method: 'jet-hub',
        payload: { method, payload },
      }),
    }))
    const body = await response.json() as {
      result: { ok: boolean; value?: unknown; error?: { code?: string; message: string } }
    }
    return body.result
  }
}

describe('checkin.auto.*：装配层缺席', () => {
  it('get / set 都回结构化的 unavailable（不是 handler-failed、也不伪造快照）', async () => {
    for (const [method, payload] of [
      ['checkin.auto.get', {}],
      ['checkin.auto.set', { enabled: true }],
    ] as const) {
      const call = setup()
      const result = await call(method, payload)
      expect(result.ok, method).toBe(false)
      expect(result.error?.code, method).toBe('jet-hub/auto-checkin-unavailable')
      expect(result.error?.message, method).toContain('未装配调度器')
    }
  })
})

describe('checkin.auto.get：读快照', () => {
  it('返回 host 的快照（含摘要与上限，面板据此渲染）', async () => {
    const store = memoryStore({
      ...defaultAutoCheckinState(),
      day: '2026-10-13',
      attempts: 1,
      succeeded: true,
      lastRunAt: 1760000000000,
      lastResults: [
        {
          provider: 'qoder',
          ok: true,
          summary: { claimed: 2, totalCredit: 900, alreadyClaimed: 0, inactive: 0, failed: 0 },
        },
        { provider: 'zcode', ok: false, error: '没有可用浏览器' },
      ],
    })
    const controller = createAutoCheckinController({
      store,
      claim: async () => ({ ok: true }),
      log: () => {},
    })
    const call = setup(controller)

    const result = await call('checkin.auto.get', {})
    expect(result.ok).toBe(true)
    const value = result.value as Record<string, unknown>
    expect(value.enabled).toBe(true)
    expect(value.lastRunAt).toBe(1760000000000)
    expect(value.maxAttemptsPerDay).toBe(3)
    expect(value.storeKind).toBe('memory')
    // 汇总由 host 算好下发（面板不重算，避免两份判据漂移）
    expect(value.summary).toEqual({
      claimed: 2, totalCredit: 900, alreadyClaimed: 0, inactive: 0, failed: 1,
    })
  })
})

describe('checkin.auto.set：写开关', () => {
  it('写入并回传新快照（以服务端为准，不做乐观更新）', async () => {
    const store = memoryStore(defaultAutoCheckinState())
    const controller = createAutoCheckinController({
      store,
      claim: async () => ({ ok: true }),
      log: () => {},
    })
    const call = setup(controller)

    const off = await call('checkin.auto.set', { enabled: false })
    expect(off.ok).toBe(true)
    expect((off.value as { enabled: boolean }).enabled).toBe(false)
    // 真的落到了状态后端（而非只改内存返回值）
    expect(store.load().state.enabled).toBe(false)
    expect(store.saved).toHaveLength(1)

    // 再读一次确认持久
    const read = await call('checkin.auto.get', {})
    expect((read.value as { enabled: boolean }).enabled).toBe(false)

    const on = await call('checkin.auto.set', { enabled: true })
    expect((on.value as { enabled: boolean }).enabled).toBe(true)
  })

  it('⚠️ enabled 必须是布尔：字符串 / 数字 / 缺失一律 bad-request，且**不调用** setEnabled', async () => {
    const calls: unknown[] = []
    const controller = {
      read: () => ({}),
      setEnabled: async (enabled: boolean) => { calls.push(enabled); return { enabled } },
      trigger: async () => ({ ran: false }),
    }
    const call = setup(controller)

    for (const payload of [{ enabled: 'false' }, { enabled: 1 }, { enabled: 0 }, {}, { enabled: null }]) {
      const result = await call('checkin.auto.set', payload)
      expect(result.ok, JSON.stringify(payload)).toBe(false)
      expect(result.error?.message).toContain('布尔')
    }
    // 一次都不能落下去 —— 字符串 'false' 若被强转成 true，会**打开**开关并
    // 让每次启动都发出十路真实写请求。
    expect(calls).toEqual([])
  })

  it('setEnabled 抛错时如实回 handler-failed（不谎报成功）', async () => {
    const controller = {
      read: () => ({}),
      setEnabled: async () => { throw new Error('磁盘只读') },
      trigger: async () => ({ ran: false }),
    }
    const call = setup(controller)

    const result = await call('checkin.auto.set', { enabled: false })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('磁盘只读')
  })
})

describe('触发时机不在 RPC 里', () => {
  it('两个动词都只读 / 写状态，**不调用** trigger（面板渲染不得产生写请求）', async () => {
    let triggered = 0
    const controller = {
      read: () => ({ enabled: true }),
      setEnabled: async (enabled: boolean) => ({ enabled }),
      trigger: async () => { triggered += 1; return { ran: true } },
    }
    const call = setup(controller)

    await call('checkin.auto.get', {})
    await call('checkin.auto.set', { enabled: false })
    expect(triggered).toBe(0)
  })
})

describe('与既有实现共用（防重复实现漂移）', () => {
  it('RPC 的 credits.claimAll 调 claimAllForProvider（而不是保留第二份实现）', () => {
    const start = rpcSource.indexOf("case 'credits.claimAll'")
    expect(start).toBeGreaterThan(-1)
    const block = rpcSource.slice(start, rpcSource.indexOf("case 'checkin.auto.get'"))
    expect(block).toContain('await claimAllForProvider(req.provider')
    expect(block).toContain('UnsupportedClaimProviderError')
    // 旧实现在 case 里内联了各 provider 的分支；搬走后不应留下痕迹。
    expect(block).not.toContain('claimQoderDailyCheckin')
    expect(block).not.toContain('claimCodeArtsDailyCheckin')
  })

  it('index.ts 的自动签到 claim 也调 claimAllForProvider（同一条实现）', () => {
    expect(indexSource).toContain('await claimAllForProvider(provider, {')
  })

  it('启动路径在**首轮续期之后**触发（凭据未刷新就签会白白消耗当天次数）', () => {
    const boot = indexSource.indexOf('void refreshAllCredentials()')
    expect(boot).toBeGreaterThan(-1)
    const block = indexSource.slice(boot, boot + 1200)
    expect(block).toContain('.then(() => autoCheckin.trigger())')
  })
})
