import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { TeleagentAuth } from '../../src/teleagent-auth.js'
import { TELEAGENT_LOGIN_TIMEOUT_MS } from '../../src/teleagent-product.js'

/**
 * TeleAgent 登录提交（`submitLogin`）的行为回归。
 *
 * ## 对应的真实缺陷（2026-10-08 用户截图 + 追问）
 *
 * 面板显示绿色「已启用」、凭据行 `TELEAGENT_ACCOUNT_F9B0EF1B`、
 * 积分「凭据未配置」、有效期「未知」，粘贴框挂着但「点了没反应」。
 * 顺着查下去，`credentialPresent` 那套「粘贴框可恢复」机制上线后，
 * **没有和 `startLogin` 的旧生命周期对齐**，留下两个缺陷：
 *
 * 1. **恢复路径粘贴成功后，昵称与有效期永远不回填。**
 *    回填原先只挂在 `account.create` 里 `startLogin().result.then()` 上，
 *    而 `submitLogin` 只在 `pendingLogins` 命中时才 `resolve`。
 *    走恢复路径时（DSH 重启过、Map 是空的）`result` **永不落定** ⇒
 *    凭据有效、能正常推理，卡片却永远停在 `teleagent-xxxx` + 「有效期 未知」。
 *    佐证：`submitLogin` 的 `options.pool` 形参 JSDoc 写着「回填昵称/有效期用」，
 *    函数体却**从头到尾没读它** —— 一个死参数。
 *    ⇒ 修法：回填收敛到 `submitLogin`（它同时握着 pool / accountId / 验证过的凭据，
 *    且**不依赖**内存里的 pendingLogins）。
 *
 * 2. **超时与提交有竞态，会造出孤儿凭据或让登录白做。**
 *    `startLogin` 的 10 分钟定时器一到就 `reject`，`account.create` 挂的
 *    `.catch()` 随即 `removeAccount(id)` —— 而 `removeAccount` **连带
 *    `credentials.unset`**（见 account-pool.ts）。若定时器恰好在 `submitLogin`
 *    跑 `ensureDeviceId` / `ensureSignKey`（磁盘）与 `fetchUserInfo`（网络）
 *    的中途引爆：凭据先写后被 unset（登录白做，可 RPC 已回 `done:true`），
 *    或凭据在条目删完后才落盘（密钥库里留下**永久孤儿凭据**）。
 *    ⇒ 修法：**在任何 await 之前**拆掉定时器（保留落定器）。用户既然已提交，
 *    超时就不该再介入。
 *
 * ## 为什么用假定时器而不是 spy clearTimeout
 *
 * 「拆定时器」这件事的正确性**全在顺序**上：写在第一个 `await` 之后等于没写。
 * spy 只能证明「调用过」，证明不了「赶在超时之前」，故这里让提交真的与
 * 超时赛跑 —— 反向验证：把 `clearTimeout` 挪到 `await` 之后，
 * 「提交中途越过超时仍不 reject」那条会变红。
 */

/** 凭据存储桩（与 loomy-auth.spec.ts 同型，够小）。 */
class FakeCredentials {
  private readonly store = new Map<string, string>()
  /** 记录副作用顺序，供「必须赶在任何 await 之前」那类断言使用。 */
  readonly events: string[] = []
  async resolve(ref: string) {
    this.events.push('credentials.resolve')
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async set(ref: string, value: string) {
    this.events.push('credentials.set')
    this.store.set(ref, value)
  }
  async unset(ref: string) {
    this.events.push('credentials.unset')
    this.store.delete(ref)
  }
  raw(ref: string): string | undefined {
    return this.store.get(ref)
  }
}

/** 造一个 TeleAgent 形态的 token：`<tenant前缀>:<jwt>`（实测首段是 tenant）。 */
function makeToken(expSeconds: number): string {
  const encode = (obj: unknown): string =>
    Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `Em9xR4:${encode({ alg: 'HS256' })}.${encode({ exp: expSeconds, accountId: 'u-1' })}.fakesig`
}

const REF = 'TELEAGENT_ACCOUNT_A1'
const ACCOUNT_ID = 'teleagent-aaa'

interface Harness {
  auth: TeleagentAuth
  credentials: FakeCredentials
  /** 池收到的 updateAccount 调用。 */
  updates: Array<{ id: string; patch: Record<string, unknown> }>
  /** 池里当前存在的条目 id（清空即模拟条目已被删除）。 */
  entries: Set<string>
  /** 凭据读写的副作用顺序（与 fetch 桩一起构成交错断言）。 */
  events: string[]
}

/** 造一个 user_info 响应。 */
function userInfoResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const OK_USER_INFO = async (): Promise<Response> =>
  userInfoResponse({ data: { accountId: 'u-1', phone: '13800001111' } })

function newHarness(fetchImpl?: typeof fetch): Harness {
  const ctx = new Context()
  const credentials = new FakeCredentials()
  ctx.provide('credentials', credentials as never)
  const updates: Harness['updates'] = []
  const entries = new Set<string>([ACCOUNT_ID])
  const pool = {
    updateAccount: async (id: string, patch: Record<string, unknown>) => {
      // 与真实 AccountPool.updateAccount 对齐：条目不存在时抛错。
      if (!entries.has(id)) throw new Error(`Account ${id} not found`)
      updates.push({ id, patch })
    },
  }
  const auth = new TeleagentAuth(ctx, { fetchImpl: fetchImpl ?? OK_USER_INFO })
  // 桩池只需 updateAccount，其余成员本组用例不触碰。
  ;(auth as unknown as { __pool?: unknown }).__pool = pool
  return { auth, credentials, updates, entries, events: credentials.events }
}

/** 取回桩池（保持用例里的调用形状与真实 RPC 一致）。 */
function poolOf(h: Harness): never {
  return (h.auth as unknown as { __pool: never }).__pool
}

afterEach(() => {
  vi.useRealTimers()
})

describe('TeleAgent submitLogin：回填账号池展示字段（缺陷①）', () => {
  it('★ 没有挂起的 startLogin 流程（恢复路径）时**仍然**回填昵称与有效期', async () => {
    // 这正是缺陷本体：DSH 重启后 pendingLogins 是空的，`result` 永不落定，
    // 挂在 `.then()` 上的回填永远不执行 —— 于是凭据有效、能推理，
    // 卡片却永远显示账号 id 和「有效期 未知」。
    const h = newHarness()
    const exp = Math.floor(Date.now() / 1000) + 30 * 86_400
    await h.auth.submitLogin(makeToken(exp), {
      refName: REF,
      accountId: ACCOUNT_ID,
      pool: poolOf(h),
    })

    expect(h.updates).toHaveLength(1)
    const patch = h.updates[0]!.patch
    // 昵称来自 user_info 的手机号尾号（`teleagentDisplayNickname`）
    expect(patch.nickname).toBe('TeleAgent 1111')
    // 有效期来自 JWT `exp`，**不是** result.expires 那个恒 0
    expect(patch.expiresAt).toBe(exp * 1000)
    expect(patch.refreshable).toBe(false)
  })

  it('★ 凭据确实落盘在**该账号自己的** ref 上（多账号不能都写到默认 ref）', async () => {
    const h = newHarness()
    await h.auth.submitLogin(makeToken(2_000_000_000), {
      refName: REF,
      accountId: ACCOUNT_ID,
      pool: poolOf(h),
    })
    expect(h.credentials.raw(REF)).toContain('"account_id":"u-1"')
    expect(h.credentials.raw('TELEAGENT_DEFAULT')).toBeUndefined()
  })

  it('不传 pool 时不回填，但登录本身照样成功（调用方没池就不该报错）', async () => {
    const h = newHarness()
    const result = await h.auth.submitLogin(makeToken(2_000_000_000), { refName: REF })
    expect(h.updates).toHaveLength(0)
    expect(result.accountId).toBe('u-1')
    expect(h.credentials.raw(REF)).toBeDefined()
  })

  it('★ 条目已被删除时回填失败**不**让一次已成功的登录变成失败', async () => {
    // `updateAccount` 在条目不存在时抛 `Account ... not found`
    //（见 account-pool.ts）。此时凭据已验证并落盘，回填只是锦上添花。
    const h = newHarness()
    h.entries.clear()
    await expect(
      h.auth.submitLogin(makeToken(2_000_000_000), {
        refName: REF,
        accountId: ACCOUNT_ID,
        pool: poolOf(h),
      }),
    ).resolves.toMatchObject({ accountId: 'u-1' })
  })

  it('token 校验不过时**不**落盘、**不**回填（先把无效凭据写进去是最贵的错）', async () => {
    const h = newHarness(async () => userInfoResponse({ data: {} }))
    await expect(
      h.auth.submitLogin(makeToken(2_000_000_000), {
        refName: REF,
        accountId: ACCOUNT_ID,
        pool: poolOf(h),
      }),
    ).rejects.toThrow(/user_info/)
    expect(h.credentials.raw(REF)).toBeUndefined()
    expect(h.updates).toHaveLength(0)
  })
})

describe('TeleAgent submitLogin：拆掉超时定时器（缺陷②）', () => {
  it('★ 提交中途越过超时 ⇒ 登录结果**不**被落定为失败', async () => {
    // 竞态本体：定时器若在 submitLogin 的磁盘/网络 await 中途引爆，
    // `result` 会 reject，上游 `.catch()` 随即 removeAccount —— 而 removeAccount
    // 连带 unset 凭据 ⇒ 要么登录白做，要么留下指向已删条目的孤儿凭据。
    //
    // ⚠️ 本条只证明「定时器最终被拆了」，**证明不了顺序**（见下一条）。
    vi.useFakeTimers()
    const h = newHarness()
    const started = await h.auth.startLogin(ACCOUNT_ID)

    let outcome = 'pending'
    started.result.then(
      () => {
        outcome = 'resolved'
      },
      () => {
        outcome = 'rejected'
      },
    )

    const submitting = h.auth.submitLogin(makeToken(2_000_000_000), {
      refName: REF,
      accountId: ACCOUNT_ID,
      pool: poolOf(h),
    })
    // 让提交跑到 await 链里，然后把时钟推过超时点。
    await vi.advanceTimersByTimeAsync(TELEAGENT_LOGIN_TIMEOUT_MS + 10_000)
    await submitting

    expect(outcome).toBe('resolved')
    expect(h.credentials.raw(REF)).toBeDefined()
  })

  it('★ 拆定时器必须赶在**任何 await 之前**（写在后面等于没写）', async () => {
    // 上一条区分不了 `clearTimeout` 位于第一个 await 前还是后：
    // fake timers 的 advanceTimersByTimeAsync 会先把 microtask 队列跑完，
    // 于是整条 await 链在定时器引爆前早已结束。**实测**把 clearTimeout
    // 挪到 `ensureDeviceId()` 之后，上一条依然全绿 —— 即同义反复。
    // 而竞态窗口恰恰就是那几个 await，故这里直接断言**副作用顺序**：
    // clearTimeout 必须是 submitLogin 触发的第一个副作用。
    const h = newHarness()
    await h.auth.startLogin(ACCOUNT_ID)

    const realClear = globalThis.clearTimeout
    const spy = vi
      .spyOn(globalThis, 'clearTimeout')
      .mockImplementation(((handle: Parameters<typeof clearTimeout>[0]) => {
        h.events.push('clearTimeout')
        return realClear(handle)
      }) as typeof clearTimeout)
    h.events.length = 0
    try {
      await h.auth.submitLogin(makeToken(2_000_000_000), {
        refName: REF,
        accountId: ACCOUNT_ID,
        pool: poolOf(h),
      })
    } finally {
      spy.mockRestore()
    }

    expect(h.events[0]).toBe('clearTimeout')
    // 对照：流程确实跑完了（不是提前 return 造成的假绿）
    expect(h.events).toContain('credentials.resolve')
    expect(h.credentials.raw(REF)).toBeDefined()
  })

  it('★ 反向保险：用户始终没提交时，超时**仍然**引爆（孤儿条目要能自愈）', async () => {
    vi.useFakeTimers()
    const h = newHarness()
    const started = await h.auth.startLogin(ACCOUNT_ID)

    let outcome = 'pending'
    started.result.then(
      () => {
        outcome = 'resolved'
      },
      () => {
        outcome = 'rejected'
      },
    )

    await vi.advanceTimersByTimeAsync(TELEAGENT_LOGIN_TIMEOUT_MS + 1)
    expect(outcome).toBe('rejected')
  })

  it('close() 仍会拆定时器并落定为取消', async () => {
    vi.useFakeTimers()
    const h = newHarness()
    const started = await h.auth.startLogin(ACCOUNT_ID)
    let outcome = 'pending'
    started.result.then(
      () => {
        outcome = 'resolved'
      },
      () => {
        outcome = 'rejected'
      },
    )
    started.close()
    await vi.advanceTimersByTimeAsync(TELEAGENT_LOGIN_TIMEOUT_MS + 1)
    expect(outcome).toBe('rejected')
  })
})

describe('TeleAgent：ref 名与凭据存储的对应', () => {
  it('credentialRef() 包装后的值就是 ref 名（下游按它查表）', async () => {
    expect(credentialRef(REF)).toBe(REF)
  })
})
