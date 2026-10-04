import { describe, expect, it, vi } from 'vitest'

import { ModelCatalog } from '../../src/agy/models.js'
import { DEFAULT_FALLBACK_MODELS } from '../../src/agy/types.js'

/**
 * ModelCatalog 的**负缓存**回归。
 *
 * ## 真实故障（用户报障 2026-10-02：Jet Hub 面板一直停在「正在读取状态」）
 *
 * 原实现（移植自 dsh-agy-link）在 discovery 失败时只写 `lastError`、
 * `discoveredAt` 保持 0。而 `refreshIfNeeded()` 的跳过条件是
 * `source === 'discovered' && age < ttl` —— 失败后 source 仍是 fallback，
 * 于是**每次调用都重新 spawn 一次 `agy models`**。
 *
 * 未登录时该 spawn 会挂到 watchdog 才被杀（实测 15.7s）。面板 5s 轮询
 * `agy.status`（旧版 await 了目录发现）⇒ 请求永远在途、界面永久 loading、
 * 机器上常驻挂起子进程。
 *
 * 修法两处（都已落地）：
 * 1. 失败也落 `discoveredAt`（本用例锁的就是这条）——按 TTL 退避；
 * 2. `agy.status` 改毫秒级快照、慢探针移到 `agy.probe`（见 jet-hub-rpc）。
 */
describe('ModelCatalog 负缓存', () => {
  it('discovery 失败后在 TTL 内不再 spawn（负缓存生效）', async () => {
    const discover = vi.fn(async () => { throw new Error('agy is not signed in') })
    const catalog = new ModelCatalog(discover, DEFAULT_FALLBACK_MODELS, 60_000)

    await catalog.refreshIfNeeded()
    expect(discover).toHaveBeenCalledTimes(1)

    // 第二次：失败已落 discoveredAt ⇒ 命中负缓存，不再 spawn。
    await catalog.refreshIfNeeded()
    expect(discover).toHaveBeenCalledTimes(1)

    // 目录回退到 fallback 且带 lastError（面板可显示原因）。
    const cat = catalog.get()
    expect(cat.source).toBe('fallback')
    expect(cat.lastError).toContain('not signed in')
    expect(cat.models.length).toBeGreaterThan(0)
  })

  it('forceRefresh 能破负缓存（登录成功后的回填路径）', async () => {
    let signedIn = false
    const discover = vi.fn(async () => {
      if (!signedIn) throw new Error('not signed in')
      return { stdout: 'gemini-3.5-flash\tGemini 3.5 Flash\n', stderr: '' }
    })
    const catalog = new ModelCatalog(discover, DEFAULT_FALLBACK_MODELS, 60_000)

    await catalog.refreshIfNeeded()
    expect(catalog.get().source).toBe('fallback')

    signedIn = true
    await catalog.forceRefresh()
    expect(discover).toHaveBeenCalledTimes(2)
    expect(catalog.get().source).toBe('discovered')
  })

  it('空输出也算一次失败（落负缓存），不反复 spawn', async () => {
    const discover = vi.fn(async () => ({ stdout: '', stderr: '' }))
    const catalog = new ModelCatalog(discover, DEFAULT_FALLBACK_MODELS, 60_000)
    await catalog.refreshIfNeeded()
    await catalog.refreshIfNeeded()
    expect(discover).toHaveBeenCalledTimes(1)
    expect(catalog.get().lastError).toContain('no entries')
  })
})
