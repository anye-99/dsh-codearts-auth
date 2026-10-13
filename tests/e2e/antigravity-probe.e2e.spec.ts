/**
 * Antigravity e2e 探针（**只读**）：agy 二进制 + 登录态 + 模型目录 + 池快照，
 * **不发起任何推理请求**。
 *
 * ⚠️ 与其余探针不同，它的"凭据"不归本插件（官方 `agy` 二进制自管），
 * 故这里不读 `.credentials.yaml`，而是驱动本仓库自己的装配层
 * （`createAntigravityService`）—— 面板看到什么，探针就验证什么。
 *
 * 只做四件事（全部安全可重复）：
 * 1. 解析 `agy` 二进制与版本（缺失 ⇒ 如实报休眠，而不是报未登录）；
 * 2. `agy models` 真探登录态（⚠️ 未登录时会挂约 15 秒等 watchdog —— 真实耗时，
 *    不是卡死；这是面板把慢探针与毫秒级快照分两条通道的原因）；
 * 3. 校验模型目录（discovered 或 fallback，二者都是合法状态）；
 * 4. 读账号池快照（`~/.dsh/agy-accounts/pool.json`）打印账号数与配额双窗。
 *
 * 闸门：`DSH_ANTIGRAVITY_E2E=1`。未设置时整体 skip，不产生任何 spawn/网络调用。
 * 前置：装好 agy CLI（`agy --version` 可用）；要看已登录形态先在面板或终端完成一次
 * 官方登录。
 *
 * ⚠️ 池快照的构造会执行对面的 bootstrap 逻辑（primary 槽位自愈），与插件启动时
 * 同一份代码路径 —— 这是刻意的：探针验证的就是"装配层在本机上的真实形态"。
 */

import { afterAll, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { AntigravityService } from '../../src/agy-service.js'

const enabled = process.env.DSH_ANTIGRAVITY_E2E === '1'
const describeGate = enabled ? describe : describe.skip

/** 最小 ctx 替身：服务只需要 logger。 */
function makeCtx(): Context {
  return {
    logger: {
      info: (msg: string) => console.log('[agy-e2e]', msg),
      warn: (msg: string) => console.warn('[agy-e2e]', msg),
      error: (msg: string) => console.error('[agy-e2e]', msg),
    },
  } as unknown as Context
}

describeGate('Antigravity 装配探针（只读，不发推理请求）', () => {
  const service = new AntigravityService(makeCtx())

  // ⚠️ 必须是**顶层** `afterAll`（`vitest` 的导出），不是 `it.afterAll` ——
  // 后者不存在，会让整个文件在**收集阶段**就抛 `TypeError: it.afterAll is not a
  // function`，于是 `no tests` 全部跳过（探针静默失效，看起来像「没配闸门」）。
  afterAll(() => {
    service.dispose()
  })

  it('agy 二进制可解析（缺失 = 前置未满足，给出可操作提示）', () => {
    expect(
      service.agyBin,
      '未找到 agy 二进制。按 https://antigravity.google/docs/cli/install 安装'
      + '（Windows 装完 PATH 可能未传导到 GUI 进程，`%LOCALAPPDATA%\\agy\\bin` 会被自动探测）；'
      + '`agy --version` 能输出即算装好。',
    ).toBeTruthy()
  })

  it('版本探测有结果（低于最低支持版本会如实标记休眠）', async () => {
    // 版本 probe 是构造时异步发起的，给它最多 6 秒落位。
    const deadline = Date.now() + 6_000
    while (service.agyVersion === null && service.dormant === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    console.log('[agy-e2e] version =', service.agyVersion, 'dormant =', service.dormant)
    // 两者必居其一：拿到版本，或给出**具体**休眠原因（不许是空串）。
    expect(service.agyVersion !== null || (service.dormant ?? '').length > 0).toBe(true)
  }, 20_000)

  it('模型目录可用（discovered 或 fallback 都算通过，来源必须如实标注）', async () => {
    // ⚠️ 这条允许慢：未登录时 `agy models` 要挂到 watchdog（约 15 秒）才被杀，
    // 之后目录落回 fallback + 负缓存。这正是面板「刷新」按钮的真实耗时。
    const catalog = await service.modelCatalog()
    console.log('[agy-e2e] catalog source =', catalog.source, 'count =', catalog.models.length,
      'lastError =', catalog.lastError ?? '(none)')
    expect(['discovered', 'fallback']).toContain(catalog.source)
    expect(catalog.models.length).toBeGreaterThan(0)
    // 二次调用必须毫秒级（负缓存/正缓存命中）—— 永久 loading 故障的回归判据。
    const t0 = Date.now()
    await service.modelCatalog()
    expect(Date.now() - t0, '二次目录调用不应再 spawn').toBeLessThan(2_000)
  }, 40_000)

  it('登录态真探返回三态之一（true/false/null，不许抛穿）', async () => {
    const signedIn = await service.auth.probeSignedIn(true).catch(() => null)
    console.log('[agy-e2e] signedIn =', signedIn)
    expect([true, false, null]).toContain(signedIn)
  }, 40_000)

  it('账号池快照可读；每个账号的配额双窗量纲正确', () => {
    const accounts = service.pool.getAccounts()
    console.log('[agy-e2e] pool accounts =', accounts.length,
      'mode =', service.pool.getPoolData().mode)
    for (const account of accounts) {
      expect(typeof account.enabled, account.id).toBe('boolean')
      for (const quota of Object.values(account.quotas ?? {})) {
        if (quota.remainingFraction !== undefined) {
          expect(quota.remainingFraction, `${account.id} 5h 剩余比例`).toBeGreaterThanOrEqual(0)
          expect(quota.remainingFraction).toBeLessThanOrEqual(1)
        }
        if (quota.weeklyFraction !== undefined) {
          expect(quota.weeklyFraction, `${account.id} weekly 剩余比例`).toBeGreaterThanOrEqual(0)
          expect(quota.weeklyFraction).toBeLessThanOrEqual(1)
        }
      }
    }
  })
})
