/**
 * ZCode 的 Jet Hub 接入回归。
 *
 * 这些用例守的是**上一轮评审指出的六处接线缺口** —— 它们全都属于
 * 「不报错、只是功能静默不可用」那一类，故必须有回归防线：
 *
 * | 缺口 | 症状 | 本文件的对应用例 |
 * |---|---|---|
 * | `ZcodeAuth` 未继承 `Service` | `ctx.zcodeAuth` 恒为 undefined | 「注册 ctx.zcodeAuth」 |
 * | RPC 无 zcode 分支 | `account.create` 报 `unknown provider` | 「account.create 支持 zcode」 |
 * | 客户端 `PROVIDERS` 无 zcode | Jet Hub 里根本看不到面板 | 「客户端面板已登记」 |
 * | 能力矩阵未登记 | 不渲染余额 / 签到按钮 | 「能力矩阵已登记」 |
 * | 前端对空 loginUrl 报错 | 「添加账号」必然失败 | 「前端不再把空 loginUrl 当错误」 |
 * | 无单测 | 回归无防线 | 本文件 |
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { ZcodeAuth } from '../../src/zcode-auth.js'
import { ZCODE } from '../../src/zcode-product.js'
import { claimAllImplementation } from './jet-hub-rpc-source.js'
import { AccountPool } from '../../src/account-pool.js'
import { CREDITS_CAPABILITIES } from '../../plugin-src/client/credits-capabilities.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const readClient = (name: string): string =>
  readFileSync(resolve(HERE, '../../plugin-src/client', name), 'utf8')

/** 一个只满足 `ZcodeAuth` 构造需求的最小 ctx。 */
function makeCtx(): Context {
  const ctx = new Context()
  const store = new Map<string, string>()
  ctx.provide('credentials', {
    resolve: async (ref: string) => {
      const value = store.get(ref)
      return value === undefined ? undefined : { value, source: 'test' }
    },
    describe: async (ref: string) => ({ configured: store.has(ref), writable: true }),
    set: async (ref: string, value: string) => { store.set(ref, value) },
    unset: async (ref: string) => { store.delete(ref) },
  } as never)
  return ctx
}

describe('ZCode 服务注册（缺口 1：必须 extends Service）', () => {
  it('★ 构造后 ctx.zcodeAuth 立即可用（由 Service 基类完成 provide）', () => {
    const ctx = makeCtx()
    const auth = new ZcodeAuth(ctx)
    /**
     * ⚠ 不能断言**引用相等** —— cordis 的 `Service` 用代理包装实例
     * （为了 `ctx.reflect` 的拦截配置），故 `ctx.zcodeAuth !== instance`。
     * 这与 `raccoonAuth` / `loomyAuth` 的行为**完全一致**（实测）。
     *
     * 真正要守的性质是「**已注册**」：初版是裸 class，那时
     * `ctx.zcodeAuth` 恒为 `undefined`。
     */
    const registered = (ctx as unknown as Record<string, unknown>).zcodeAuth as
      | { name?: string; constructor?: { name?: string } }
      | undefined
    expect(registered).toBeDefined()
    expect(registered?.name).toBe('zcodeAuth')
    expect(registered?.constructor?.name).toBe('ZcodeAuth')
    // 实例本身仍是构造出来的那个（供 index.ts 持有引用）。
    expect(auth.name).toBe('zcodeAuth')
  })

  it('★ 注册行为与既有 auth 服务**逐项一致**（zcode 不是特例）', async () => {
    const { RaccoonAuth } = await import('../../src/raccoon-auth.js')
    const { ZcodeAuth: Z } = await import('../../src/zcode-auth.js')
    const ctx = makeCtx()
    const raccoon = new RaccoonAuth(ctx)
    const zcode = new Z(ctx)
    const ra = (ctx as unknown as Record<string, unknown>).raccoonAuth as { name?: string }
    const zc = (ctx as unknown as Record<string, unknown>).zcodeAuth as { name?: string }
    expect(zc).toBeDefined()
    expect(ra).toBeDefined()
    // 两者都「有 name」且都被代理解包（不是各自的 raw 实例）。
    expect(zc?.name).toBe('zcodeAuth')
    expect(ra?.name).toBe('raccoonAuth')
    expect(zc).not.toBe(zcode)
    expect(ra).not.toBe(raccoon)
  })

  it('服务名是 zcodeAuth，且与其余 auth 服务不冲突', () => {
    const ctx = makeCtx()
    const auth = new ZcodeAuth(ctx)
    expect(auth.name).toBe('zcodeAuth')
  })

  it('服务名可由 options 覆盖（与 RaccoonAuth 同款能力）', () => {
    const ctx = makeCtx()
    const auth = new ZcodeAuth(ctx, { serviceName: 'customZcode' })
    expect(auth.name).toBe('customZcode')
  })

  it('凭据 ref 名与产品配置一致', () => {
    const ctx = makeCtx()
    const auth = new ZcodeAuth(ctx)
    expect(auth.credentialRefName).toBe(ZCODE.defaultCredentialRef)
  })

  it('契约要求的方法都在（index.ts 会无条件调用 stop）', () => {
    const ctx = makeCtx()
    const auth = new ZcodeAuth(ctx)
    for (const method of ['login', 'startLogin', 'stop', 'status', 'refreshAll', 'refreshAccountCredential', 'fetchModels']) {
      expect(typeof (auth as unknown as Record<string, unknown>)[method], method).toBe('function')
    }
    expect(() => auth.stop()).not.toThrow()
  })
})

describe('ZCode 无实例依赖（核心架构声明）', () => {
  /**
   * ⚠️ 这一组用例在「插件内登录」落地后**被重写过**。
   *
   * 早期实现是「读官方客户端的凭据文件」，那时 zcode **没有 loginUrl**
   * （没有浏览器授权步骤）。现在改为走官方 CLI 设备授权流
   * （`/oauth/cli/init` → 浏览器授权 → `/oauth/cli/poll`），
   * 所以 `startLogin` 会返回**真实的授权 URL**。
   *
   * 断言随之改为「URL 是 https 且指向授权域」——
   * 这比原来的 `toBeUndefined()` 更有价值。
   */
  it('★ startLogin 返回真实的官方授权 URL（两步式，立刻可弹窗）', async () => {
    const ctx = makeCtx()
    const auth = new ZcodeAuth(ctx, {
      fetchImpl: (async (url: string | URL | Request) => {
        if (String(url).endsWith('/oauth/cli/init')) {
          return new Response(JSON.stringify({
            code: 0,
            data: {
              flow_id: 'flow-1',
              authorize_url: 'https://bigmodel.cn/login?appId=zcode&state=abc',
              expires_at: Math.floor(Date.now() / 1000) + 300,
              poll_interval_sec: 2,
            },
          }), { status: 200 })
        }
        // 轮询一直 pending，让 result 不 settle（本用例只验 URL）。
        return new Response(JSON.stringify({ code: 0, data: { status: 'pending' } }), { status: 200 })
      }) as unknown as typeof fetch,
    })
    const started = await auth.startLogin()
    expect(typeof started.loginUrl).toBe('string')
    expect(started.loginUrl).toMatch(/^https:\/\//)
    expect(started.loginUrl).toContain('bigmodel.cn')
    // ⚠️ 立刻返回（不等授权完成）—— 否则 window.open 会被弹窗拦截。
    expect(started.result).toBeInstanceOf(Promise)
    // 避免未处理的 rejection（本用例不 await 它）。
    void started.result.catch(() => {})
  })

  it('★ login 把**插件自建**凭据写进 ctx.credentials（含自生成 device_mid）', async () => {
    const ctx = makeCtx()
    let pollCount = 0
    const auth = new ZcodeAuth(ctx, {
      fetchImpl: (async (url: string | URL | Request) => {
        if (String(url).endsWith('/oauth/cli/init')) {
          return new Response(JSON.stringify({
            code: 0,
            data: {
              flow_id: 'flow-2',
              authorize_url: 'https://bigmodel.cn/login?appId=zcode&state=xyz',
              expires_at: Math.floor(Date.now() / 1000) + 300,
              poll_interval_sec: 1,
            },
          }), { status: 200 })
        }
        pollCount += 1
        if (pollCount < 2) {
          return new Response(JSON.stringify({ code: 0, data: { status: 'pending' } }), { status: 200 })
        }
        return new Response(JSON.stringify({
          code: 0,
          data: {
            status: 'ready',
            token: 'plugin-jwt',
            user: { user_id: 'u-1', name: '插件登录用户' },
            bigmodel: { access_token: 'bm-token' },
          },
        }), { status: 200 })
      }) as unknown as typeof fetch,
    })

    const saved = await auth.login({ refName: 'MY_REF' })
    expect(saved.refName).toBe('MY_REF')
    expect(saved.credential.zcode_jwt).toBe('plugin-jwt')
    expect(saved.credential.account_label).toBe('插件登录用户')
    expect(saved.credential.source).toBe('plugin')
    /**
     * ★ 关键：`device_mid` 是**插件自己生成**的 UUID，
     * 不再读官方客户端的 `telemetry-state.json` —— 这是「脱离 IDE」的核心。
     */
    expect(saved.credential.device_mid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    // 且已持久化（JSON 字符串，不是对象）。
    const stored = await ctx.credentials.resolve('MY_REF' as never)
    expect(stored?.value).toBe(JSON.stringify(saved.credential))
  })

  it('★ 两个来源：插件自存优先于官方客户端凭据文件', async () => {
    const ctx = makeCtx()
    // 预置一份「插件自存」凭据。
    await ctx.credentials.set('ZCODE_CREDENTIAL' as never, JSON.stringify({
      zcode_jwt: 'from-plugin',
      device_mid: 'plugin-mid',
      source: 'plugin',
    }))
    const auth = new ZcodeAuth(ctx, {
      // 磁盘上有一份**不同**的官方凭据 —— 它不该被采用。
      readCredential: () => ({ zcode_jwt: 'from-ide', device_mid: 'ide-mid', source: 'ide' }),
    })
    const current = await auth.current()
    expect(current?.zcode_jwt).toBe('from-plugin')
    expect(current?.device_mid).toBe('plugin-mid')
  })

  it('插件自存缺失时回退到官方客户端凭据文件', async () => {
    const ctx = makeCtx()
    const auth = new ZcodeAuth(ctx, {
      readCredential: () => ({ zcode_jwt: 'from-ide', device_mid: 'ide-mid', source: 'ide' }),
    })
    const current = await auth.current()
    expect(current?.zcode_jwt).toBe('from-ide')
  })

  it('★ 持久化里的残留垃圾不会被当凭据用（形状校验）', async () => {
    const ctx = makeCtx()
    await ctx.credentials.set('ZCODE_CREDENTIAL' as never, 'not-json-at-all')
    const auth = new ZcodeAuth(ctx, {
      readCredential: () => ({ zcode_jwt: 'from-ide', device_mid: 'ide-mid' }),
    })
    // 坏 JSON → 视为「没有自存凭据」→ 回退官方文件。
    expect((await auth.current())?.zcode_jwt).toBe('from-ide')
  })

  it('model 目录是静态白名单（不发网络请求）—— 且含 GLM-5.3-Flash', async () => {
    const ctx = makeCtx()
    const auth = new ZcodeAuth(ctx)
    const models = await auth.fetchModels()
    expect(models.map((m) => m.id)).toContain('GLM-5.3-Flash')
    // 只暴露实测可用的两个（GLM-5-Turbo / GLM-5.2 实测返回空响应）。
    expect(models).toHaveLength(2)
  })

  it('probe 在无凭据时返回 available:false，且原因**指向插件内登录**', async () => {
    const ctx = makeCtx()
    const auth = new ZcodeAuth(ctx, { readCredential: () => undefined })
    const result = await auth.probe()
    expect(result.available).toBe(false)
    // ⚠️ 文案必须同时提到「插件内登录」与「官方客户端回退」——
    // 因为现在两条路都通了，只提一条会让用户以为另一条不存在。
    expect(result.reason).toMatch(/添加账号/)
    expect(result.reason).toMatch(/官方 ZCode 客户端/)
  })

  it('refreshAccountCredential 无凭据时如实抛错（不静默成功）', async () => {
    const ctx = makeCtx()
    const auth = new ZcodeAuth(ctx, { readCredential: () => undefined })
    /**
     * ⚠ 文案已随修复调整（2026-10-02）：现在报的是**该账号自己的凭据**不可用，
     * 而不是「请去官方客户端重新登录」——因为后者会诱导用户去做一件
     * **无法解决该问题**的事（多账号场景下磁盘凭据只对应一个账号）。
     */
    await expect(auth.refreshAccountCredential('R')).rejects.toThrow(/不可用或已损坏/)
  })

  /**
   * ★ 本条在 2026-10-02 被**改写**，因为它此前断言的是**缺陷行为**。
   *
   * ## 旧断言（错的）
   *
   * ```ts
   * await auth.refreshAll(pool)   // pool 有两个空 ref 的账号
   * expect(REF_1).toBe(磁盘凭据)   // ← 断言「都被写入同一份」
   * expect(REF_2).toBe(磁盘凭据)   // ← 同上
   * ```
   *
   * 测试名写着「逐账号隔离失败」，说明**作者当时就意识到这不隔离**，
   * 却把它固化成预期。而它正是用户 2026-10-02 报障的根因：
   * 单账号的磁盘凭据被铺进**每一个**账号条目，抹掉了其余账号的真实凭据。
   *
   * ## 新语义（正确）
   *
   * ZCode **不可续期**，故 `refreshAll` 做的是**逐账号对账**：
   * 每个账号读**自己的** ref，能解出就写回自己，解不出就**跳过**。
   * 它**绝不**使用磁盘凭据去填任意账号 —— 磁盘格式是单账号的，
   * 无法判断它属于池里哪一个。
   */
  it('★ refreshAll 逐账号各写各的：不把磁盘凭据铺进（也不会覆盖）任何账号', async () => {
    const ctx = makeCtx()
    const credential = { zcode_jwt: 'a.b.c', device_mid: 'm' }
    // 磁盘上有凭据（`readCredential` 是「官方客户端凭据」的读取入口）。
    const auth = new ZcodeAuth(ctx, { readCredential: () => credential })
    const pool = {
      listAccountsByProvider: () => [
        { id: 'z1', credentialRef: 'REF_1' },
        { id: 'z2', credentialRef: 'REF_2' },
      ],
    } as unknown as AccountPool

    await auth.refreshAll(pool)

    /**
     * ★ 两个 ref 都是空的 ⇒ 都必须**保持空**（跳过），
     * 绝不能被磁盘凭据填上（那是旧行为，也是数据破坏的来源）。
     */
    expect(await ctx.credentials.resolve('REF_1' as never)).toBeUndefined()
    expect(await ctx.credentials.resolve('REF_2' as never)).toBeUndefined()
  })

  it('★ refreshAll 对「有自己凭据」的账号原样写回自己（不串号）', async () => {
    const ctx = makeCtx()
    const credA = { zcode_jwt: 'jwt-A', device_mid: 'mid-A', account_label: 'A' }
    const credB = { zcode_jwt: 'jwt-B', device_mid: 'mid-B', account_label: 'B' }
    await ctx.credentials.set('REF_A' as never, JSON.stringify(credA))
    await ctx.credentials.set('REF_B' as never, JSON.stringify(credB))

    // ⚠ 刻意让「磁盘凭据」是 A —— 旧实现会把它写进 B。
    const auth = new ZcodeAuth(ctx, { readCredential: () => credA as never })
    const pool = {
      listAccountsByProvider: () => [
        { id: 'a', credentialRef: 'REF_A' },
        { id: 'b', credentialRef: 'REF_B' },
      ],
    } as unknown as AccountPool

    await auth.refreshAll(pool)

    // ★ B 必须仍是 B 自己（旧实现这里会变成 A）。
    const gotB = JSON.parse((await ctx.credentials.resolve('REF_B' as never))?.value ?? '{}')
    expect(gotB.zcode_jwt).toBe('jwt-B')
    expect(gotB.account_label).toBe('B')
    const gotA = JSON.parse((await ctx.credentials.resolve('REF_A' as never))?.value ?? '{}')
    expect(gotA.zcode_jwt).toBe('jwt-A')
  })
})

describe('ZCode 客户端接入（缺口 3 / 4 / 5）', () => {
  it('★ PROVIDERS 里已登记 zcode（否则 Jet Hub 根本没这个面板）', () => {
    const source = readClient('jet-hub.js')
    const block = /const PROVIDERS = Object\.freeze\(\[([\s\S]*?)\n\]\);/.exec(source)
    const ids = [...(block?.[1] ?? '').matchAll(/id: '([^']+)'/g)].map((m) => m[1])
    expect(ids).toContain('zcode')
    // 也确认没把既有的挤掉。
    expect(ids).toContain('codearts')
    expect(ids).toContain('raccoon')
    // ⚠️ 2026-09-30 合并 master 后 minimax 也接入了 —— 11 → 12。
    // ⚠️ 2026-10-01 接入 vibex（非 LLM 面板）—— 12 → 13。
    // ⚠️ 2026-10-02 接入 antigravity（Google，第 14 个面板）—— 13 → 14。
    //    它与前 13 家的差别是**结构性**的：账号与凭据都在另一个插件
    //    （`dsh-agy-link`）里、凭据归官方 agy 二进制所有，因此它**不进**
    //    `REF_PREFIX_TO_PROVIDER`（见该表末的说明），面板也不走 account.* 端点。
    //    这正是本条计数断言想逼着确认的那件事：「这个面板该不该出现在左侧导航、
    //    该不该按常规账号池恢复」——答案是「出现在导航，但不按账号池恢复」。
    // ⚠️ 2026-10-02 晚些时候**移除 vibex** —— 14 → 13（用户要求整面板下线）。
    // ⚠️ 2026-10-04 接入 doubao（豆包，非凭据型本地客户端面板）—— 13 → 14。
    // ⚠️ 2026-10-05 **移除 doubao**（用户要求整面板下线）—— 14 → 13。
    //    它曾与 antigravity 同属「出现在导航、但不按账号池恢复」那一类；
    //    移除后**唯一**剩下的那类面板是 antigravity。
    // ⚠️ 2026-10-07 接入 teleagent（星辰超级智能体，中国电信天翼 AI，
    //    **凭据型**）—— 13 → 14。它与 minimax/zcode 一样进 `REF_PREFIX_TO_PROVIDER`
    //    （凭据由本插件持有、可按账号池恢复），且三处顺序对齐：
    //    客户端 PROVIDERS = store 表 = `registerJetHubRpc` 形参，
    //    都排在 minimax 之后、zcode 之前。
    // ⚠️ 2026-10-09 接入 stepcode（阶跃星辰，**凭据型**）—— 14 → 15。
    //    它与 minimax/zcode/teleagent 同类：凭据由本插件持有（静态 api_key）、
    //    进 `REF_PREFIX_TO_PROVIDER`、走 account.* 标准端点，三处顺序对齐为
    //    「排在 zcode 之后、antigravity 之前」（antigravity 恒为最后一个）。
    //    这条计数断言是**故意**的：面板增删都必须同时改它，逼着改的人回来确认
    //    「这个面板到底该不该出现在左侧导航」——与 `REF_PREFIX_TO_PROVIDER` 成对。
    expect(ids).toHaveLength(15)
    expect(ids).toContain('antigravity')
  })

  it('展示名与产品配置一致（避免两处漂移）', () => {
    const source = readClient('jet-hub.js')
    const entry = /id: 'zcode', label: '([^']+)'/.exec(source)
    expect(entry?.[1]).toBe(ZCODE.displayName)
  })

  it('zcode 有内联图标且已注册 CSS 类', () => {
    expect(readClient('jet-hub.js')).toMatch(/const ZCODE_ICON = 'data:image\/png;base64,/)
    expect(readClient('jet-hub-styles.js')).toMatch(/\.dim-jh-providerIcon\.zcode/)
  })

  it('★ 能力矩阵登记为「余额 + 每日签到」都有', () => {
    expect(CREDITS_CAPABILITIES.zcode).toEqual({ balance: true, dailyCheckin: true })
  })

  /**
   * ⚠️ 这条断言在「插件内登录」落地后**被替换**。
   *
   * 早期实现里 zcode 是唯一没有 `loginUrl` 的 provider，前端为它加了
   * 一个「空 loginUrl 不算错误」的特例分支。现在 zcode 走**标准两步式**
   * （返回官方授权 URL），那个特例已被删除 —— 故旧断言不再适用。
   *
   * 新断言守的是**更有价值**的性质：前端**没有**为 zcode 留下任何
   * 特殊分支（有特例就意味着某条通用路径对它不成立）。
   */
  it('★ 前端没有为 zcode 留特殊分支（它走通用两步式登录）', () => {
    const source = readClient('jet-hub.js')
    // 提交流程里不应有 zcode 专属分支。
    expect(source).not.toMatch(/else if \(provider === 'zcode'\)/)
    // 通用路径仍在：拿到 loginUrl 就弹窗。
    expect(source).toMatch(/const loginWindow = window\.open\(loginUrl/)
    // 空 loginUrl 的通用错误分支也要保留（它是所有 provider 的兜底）。
    expect(source).toMatch(/后端未返回登录地址/)
  })

  it('★ 登录轮询对所有 provider 统一（含 zcode）', () => {
    const source = readClient('jet-hub.js')
    // 轮询调用不应按 provider 分叉。
    expect(source).toMatch(/rpcCall\('login\.poll', \{ accountId, provider \}\)/)
  })
})

describe('ZCode RPC 分派（缺口 2：接线）', () => {
  const readRpc = (): string =>
    readFileSync(resolve(HERE, '../../src/jet-hub-rpc.ts'), 'utf8')

  it('★ account.create 有 zcode 分支（否则报 unknown provider）', () => {
    const source = readRpc()
    expect(source).toMatch(/else if \(provider === ZCODE\.id\) \{/)
  })

  it('★ account.refresh 的 switch 有 zcode case（否则「刷新」按钮报 Unknown provider）', () => {
    expect(readRpc()).toMatch(/case ZCODE\.id:/)
  })

  it('★ credits.balances 与 credits.claimAll 都接了 zcode', () => {
    const source = readRpc()
    // credits.balances 仍按 `req.provider === ZCODE.id` 分派。
    expect(source).toMatch(/req\.provider === ZCODE\.id/)
    // ⚠️ credits.claimAll 的实现自 2026-10-13 起抽到模块级
    // `claimAllForProvider()`（每日自动签到与 RPC 共用同一份），
    // 故断言锚定那个函数体而不是 case 切片（见 `jet-hub-rpc-source.ts`）。
    const impl = claimAllImplementation(source)
    expect(impl).toMatch(/case ZCODE\.id:/)
    expect(impl).toMatch(/claimDailyFor/)
  })

  it('★ 签到路径为**每个 plan 单独 mint** captcha（captcha 一次性）', () => {
    const source = readRpc()
    // claimAll 的 zcode 分支应在循环内调用 claimDailyFor（它内部每个 plan 都调 mint）。
    expect(source).toMatch(/claimDailyFor/)
  })

  it('index.ts 把 zcode 接进 registerJetHubRpc 与 modelAdapters', () => {
    const source = readFileSync(resolve(HERE, '../../src/index.ts'), 'utf8')
    // ⚠️ 2026-09-30 合并后 minimax 排在 zcode 之前 —— 用 .* 容忍中间插队者。
    // ⚠️ 2026-10-02 插入 agyService（antigravity），同日移除 vibex —— 同样用 .* 容忍。
    // ⚠️ 结尾用 `[,)]` 而非 `\)`：`modelAdapters` **之后**还可能再跟实参
    //（2026-10-04 的 doubaoService 尾参就让写死 `\)` 的版本假失败过）。
    expect(source).toMatch(/registerJetHubRpc\(ctx, pool, service, .*raccoon,.*zcode,.* modelAdapters[,)]/)
    expect(source).toMatch(/zcode: zcodeAdapter/)
  })

  it('★ index.ts 的清理块会 dispose captcha 浏览器（否则留孤儿 chromium）', () => {
    const source = readFileSync(resolve(HERE, '../../src/index.ts'), 'utf8')
    const disposals = [...source.matchAll(/zcodeAdapter\.stop\(\)/g)]
    // 两个 ctx.effect 清理块都要有。
    expect(disposals.length).toBeGreaterThanOrEqual(2)
  })

  it('index.ts 把 llm-zcode 加入 registerProviderSettings（老契约需要）', () => {
    const source = readFileSync(resolve(HERE, '../../src/index.ts'), 'utf8')
    expect(source).toMatch(/'llm-zcode'/)
  })
})

describe('ZCode 与既有 provider 的约定一致性', () => {
  it('所有 auth 服务都 extends Service（zcode 不能是例外）', () => {
    const files = [
      'zcode-auth.ts', 'raccoon-auth.ts', 'loomy-auth.ts',
      'qoder-auth.ts', 'trae-auth.ts', 'cline-auth.ts',
    ]
    for (const file of files) {
      const source = readFileSync(resolve(HERE, '../../src', file), 'utf8')
      expect(source, file).toMatch(/extends Service/)
    }
  })

  it('refreshable 恒为 false（ZCode 没有 refresh 端点）', async () => {
    const { ZCODE_REFRESHABLE } = await import('../../src/zcode.js')
    expect(ZCODE_REFRESHABLE).toBe(false)
  })

  it('isZcodeExpired 恒为 false（JWT 无 exp，真失效由上游 401 反映）', async () => {
    const { isZcodeExpired } = await import('../../src/zcode.js')
    expect(isZcodeExpired({ zcode_jwt: 'x', device_mid: 'm' })).toBe(false)
  })

  /**
   * ⚠️ 这条用例**被反转了**，因为原结论是错的。
   *
   * 原断言守的是「适配器显式拒绝图片（该通道未验证）」。
   * 真相：用户实测 ZCode IDE 里同一模型能**正确理解图片**，
   * 而我们的实现**根本没有图片代码** —— 所谓「通道未验证」是误判。
   *
   * 现在守的是**正向能力**：图片存在且给了 `readImage` 时，
   * 适配器**必须真的把图片转发出去**（而不是丢弃或报错）。
   */
  it('★ 适配器支持图片（把 attachment 读成 data URL 并下发）', async () => {
    const { ZcodeAdapter } = await import('../../src/zcode-adapter.js')
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
    let sentBody = ''
    const adapter = new ZcodeAdapter({
      credentialRef: 'R' as never,
      resolveCredential: async () => ({ zcode_jwt: 'a.b.c', device_mid: 'm' }),
      refresh: async () => {},
      mintCaptcha: async () => 'p',
      // ⚠ 模拟附件服务：把 attachmentId 读成字节。
      readImage: async () => ({ data: jpegBytes, mediaType: 'image/jpeg' }),
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        sentBody = String(init?.body ?? '')
        // 空的 SSE 会让消费器抛 EMPTY_RESPONSE —— 但我们只关心**已发出的请求体**。
        return new Response(
          'event: message_start\ndata: {"type":"message_start"}\n\n' +
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n' +
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }) as never,
    })
    for await (const _chunk of adapter.stream({
      provider: 'zcode',
      model: 'GLM-5.3-Flash',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '描述这张图' },
          // ⚠ DSH 的真实形态：只带 attachment 引用。
          { type: 'image', attachment: { attachmentId: 'att-1' } },
        ],
      }],
    } as never)) { /* 消费掉 */ }

    // ★ 请求体里必须出现 Anthropic 形态的图片块。
    expect(sentBody).toContain('"type":"image"')
    expect(sentBody).toContain('"type":"base64"')
    expect(sentBody).toContain('"media_type":"image/jpeg"')
    // 且必须是真实的 base64 字节（/9j/ 是 JPEG 的 base64 开头）。
    expect(sentBody).toContain('/9j/')
    // 不能退化成占位符。
    expect(sentBody).not.toContain('image unavailable')
  })

  it('★ 有图片但宿主没给 readImage 时 → 明确报错（不静默丢图）', async () => {
    const { ZcodeAdapter } = await import('../../src/zcode-adapter.js')
    const adapter = new ZcodeAdapter({
      credentialRef: 'R' as never,
      resolveCredential: async () => ({ zcode_jwt: 'a.b.c', device_mid: 'm' }),
      refresh: async () => {},
      mintCaptcha: async () => 'p',
      fetchImpl: (async () => new Response('', { status: 200 })) as never,
    })
    const iterate = async (): Promise<void> => {
      for await (const _chunk of adapter.stream({
        provider: 'zcode',
        model: 'GLM-5.3-Flash',
        messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a' } }] }],
      } as never)) { /* 不应有任何产出 */ }
    }
    // ⚠️ 明确报错比静默丢图好 —— 这条设计在排查图片链路时省了时间
    //（它把「没接」和「接了但坏了」分开了）。
    await expect(iterate()).rejects.toThrow(/附件服务/)
  })
})
