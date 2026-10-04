import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { AccountPoolManager } from '../../src/agy/pool.js'
import { ModelCatalog } from '../../src/agy/models.js'
import { DEFAULT_FALLBACK_MODELS, type PluginConfig } from '../../src/agy/types.js'
import { defaultConfig } from '../../src/agy/types.js'
import { AntigravityAdapter } from '../../src/antigravity-adapter.js'

/**
 * Antigravity 适配器的**登录门控**与**未登录友好错误**回归。
 *
 * 两条都是用户报障/要求直接催生的：
 * - 门控：未登录时选择器里不该出现一排"点了必失败"的模型（2026-10-02 要求）；
 * - 友好错误：未登录推理时不能只给 "stream ended without a result event"
 *   这种含糊终止（2026-10-02 要求）。
 *
 * ⚠️ 门控用例里有一条**时序断言**（listModels 不得 await 探针）：
 * 那是 2026-10-02 永久 loading 故障的同型回归防线 —— 探针未登录时要挂
 * ~15s，await 它就把目录构建卡死。
 */

function tmpPool(): AccountPoolManager {
  return new AccountPoolManager(mkdtempSync(join(tmpdir(), 'agy-gate-')))
}

function makeCatalog(): ModelCatalog {
  return new ModelCatalog(async () => { throw new Error('discover disabled in gate tests') }, DEFAULT_FALLBACK_MODELS, 60_000)
}

function cfg(): PluginConfig {
  return { ...defaultConfig(), timeoutMs: 5_000 }
}

describe('listModels 登录门控', () => {
  it('休眠（二进制缺失）⇒ 空目录，且不触发探针', async () => {
    const probe = vi.fn(async () => true)
    const adapter = new AntigravityAdapter({
      getConfig: cfg, catalog: makeCatalog(), pool: tmpPool(), bin: () => null,
      acquire: async () => () => {}, probeSignedIn: probe, isDormant: () => true,
    })
    expect(await adapter.listModels('antigravity')).toEqual([])
    expect(probe).not.toHaveBeenCalled()
  })

  it('未登录（探针 no）⇒ 空目录；已登录 ⇒ 全量目录', async () => {
    const pool = tmpPool()
    const notifyNo = vi.fn()
    const adapterNo = new AntigravityAdapter({
      getConfig: cfg, catalog: makeCatalog(), pool, bin: () => 'x',
      acquire: async () => () => {}, probeSignedIn: async () => false, notifyCatalogChanged: notifyNo,
    })
    // 首次调用时门控还是 unknown（探针后台跑）⇒ 先空。
    expect(await adapterNo.listModels('antigravity')).toEqual([])
    // 等探针落定（notify 翻转一次）后**仍**是空 —— 门控真的生效，而不是
    // 碰巧在探针回来前取到了空值。
    await vi.waitFor(() => expect(notifyNo).toHaveBeenCalled())
    expect(await adapterNo.listModels('antigravity')).toEqual([])

    const notifyYes = vi.fn()
    const adapterYes = new AntigravityAdapter({
      getConfig: cfg, catalog: makeCatalog(), pool, bin: () => 'x',
      acquire: async () => () => {}, probeSignedIn: async () => true, notifyCatalogChanged: notifyYes,
    })
    // ⚠️ 探针只在 listModels 里被 kick —— 必须先调一次，否则 waitFor 等的是
    // 一个根本没开始的探针（本轮真踩过：漏了这一行，用例假失败）。
    await adapterYes.listModels('antigravity')
    await vi.waitFor(() => expect(notifyYes).toHaveBeenCalled())
    const models = await adapterYes.listModels('antigravity')
    expect(models.length).toBeGreaterThan(0)
    expect(models.every(m => m.provider === 'antigravity')).toBe(true)
  })

  it('门控翻转时广播目录变更（否则登录成功后选择器不重读）', async () => {
    const notify = vi.fn()
    let signedIn = false
    const adapter = new AntigravityAdapter({
      getConfig: cfg, catalog: makeCatalog(), pool: tmpPool(), bin: () => 'x',
      acquire: async () => () => {}, probeSignedIn: async () => signedIn, notifyCatalogChanged: notify,
    })
    await adapter.listModels('antigravity')          // kick：unknown -> no
    await vi.waitFor(() => expect(notify).toHaveBeenCalled())
    const first = notify.mock.calls.length
    signedIn = true
    await adapter.listModels('antigravity')          // kick：no -> yes
    await vi.waitFor(() => expect(notify.mock.calls.length).toBeGreaterThan(first))
  })

  it('listModels **不 await** 探针（永久 loading 故障的同型回归防线）', async () => {
    // 探针 800ms 后才落定；listModels 必须立刻返回（空目录），不能等它。
    const slowProbe = () => new Promise<boolean | null>((resolve) => setTimeout(() => resolve(true), 800))
    const adapter = new AntigravityAdapter({
      getConfig: cfg, catalog: makeCatalog(), pool: tmpPool(), bin: () => 'x',
      acquire: async () => () => {}, probeSignedIn: slowProbe,
    })
    const t0 = Date.now()
    const models = await adapter.listModels('antigravity')
    const elapsed = Date.now() - t0
    expect(models).toEqual([])
    expect(elapsed).toBeLessThan(200)
  })

  it('主账号探针说未登录、但池里有已登录副账号 ⇒ 仍显示目录（门控不能误伤）', async () => {
    // 真实形态：用户在隔离 HOME 里登录了副账号，主账号（系统 HOME）没登录。
    // 探针只探主账号 ⇒ loginState=no；但推理完全可用（spawn 用副账号 HOME）。
    // 判据 = 隔离目录下存在 agy 的 token 文件（与 QuotaService 同源）。
    const pool = tmpPool()
    const slot = pool.createAccountSlot('work')
    writeFileSync(
      join(slot.dir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
      JSON.stringify({ token: { access_token: 'x', expiry: '2030-01-01T00:00:00+08:00' }, auth_method: 'consumer' }),
      'utf8',
    )
    const adapter = new AntigravityAdapter({
      getConfig: cfg, catalog: makeCatalog(), pool, bin: () => 'x',
      acquire: async () => () => {}, probeSignedIn: async () => false,
    })
    await adapter.listModels('antigravity')   // kick 探针（no）
    await vi.waitFor(async () => {
      expect((await adapter.listModels('antigravity')).length).toBeGreaterThan(0)
    })
  })

  it('副账号被停用或隔离（authRequired）⇒ 不算可用，门控仍隐藏', async () => {
    const pool = tmpPool()
    const slot = pool.createAccountSlot('work')
    writeFileSync(
      join(slot.dir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
      JSON.stringify({ token: { access_token: 'x' }, auth_method: 'consumer' }),
      'utf8',
    )
    pool.markAuthRequired(slot.id, 'invalid_grant')
    const adapter = new AntigravityAdapter({
      getConfig: cfg, catalog: makeCatalog(), pool, bin: () => 'x',
      acquire: async () => () => {}, probeSignedIn: async () => false,
    })
    await adapter.listModels('antigravity')
    await vi.waitFor(async () => expect(adapter.listModels('antigravity')).resolves.toEqual([]))
  })
})

describe('未登录推理的友好错误', () => {
  it('agy 报 not signed in ⇒ AUTH 终止块 + 账号被隔离（authRequired）', async () => {
    // 假 agy：打印登录提示并非零退出 —— 复刻未登录时真实 agy 的行为。
    const fake = join(mkdtempSync(join(tmpdir(), 'fake-agy-')), 'agy.mjs')
    writeFileSync(fake, "console.error('Error: Please sign in to continue');\nprocess.exit(1);\n", 'utf8')

    const pool = tmpPool()
    const primary = pool.getAccounts()[0]!
    const adapter = new AntigravityAdapter({
      getConfig: cfg, catalog: makeCatalog(), pool, bin: () => fake,
      acquire: async () => () => {},
    })

    const chunks = []
    for await (const ch of adapter.stream({
      provider: 'antigravity',
      model: 'gemini-3.5-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] as never,
    })) {
      chunks.push(ch)
    }

    const finish = chunks.find((c) => (c as { type?: string }).type === 'finish') as
      | { type: 'finish'; reason: { kind: string; failure?: { code?: string; message?: string } } }
      | undefined
    expect(finish, '应产出 finish 终止块').toBeDefined()
    expect(finish!.reason.kind).toBe('error')
    expect(finish!.reason.failure?.code).toBe('AUTH')
    expect(finish!.reason.failure?.message).toContain('未登录')

    // 账号被隔离：选号会跳过它（避免反复拿同一个未登录账号撞墙）。
    expect(pool.getAccount(primary.id)?.authRequired).toBe(true)
  }, 30_000)
})
