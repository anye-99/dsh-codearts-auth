import { describe, expect, it, vi } from 'vitest'

import {
  AGY_MODELS_SPAWN_TIMEOUT_MS,
  AGY_PROBE_KNOWN_TTL_MS,
  AGY_PROBE_UNKNOWN_TTL_MS,
  AGY_TOKEN_HEAL_COOLDOWN_MS,
} from '../../src/agy/types.js'
import { AntigravityService } from '../../src/agy-service.js'

/**
 * Antigravity 登录门控的超时与自愈回归。
 *
 * ## 真实故障（用户报障 2026-10-10：「模型列表没有 antigravity 的模型」）
 *
 * 本机 agy **1.3.2** 实测（`scripts/probe-agy-gate-chain.mjs` 可复现）：
 *
 * | token 状态 | `agy models` 行为 |
 * |---|---|
 * | **过期** | **21.2s** 才打印 `Please sign in…` 并非零退出 |
 * | 新鲜（冷启动） | 12.2s 返回 14 条 |
 * | 新鲜（热） | 5–6s 返回 14 条 |
 *
 * 旧实现把探针预算写成 **15s**，正卡在失败路径中间 ⇒ 超时被 watchdog 杀掉时
 * `code=null` 且 stdout 里**还没有**那句 sign-in 错误 ⇒ `looksLikeAuthFailure`
 * 不命中 ⇒ 探针返回 **null（unknown）** ⇒ 适配器的 `loginState` 永远停在 unknown
 * ⇒ `listModels` 恒返回空目录 ⇒ **整个 antigravity 分组在选择器里消失**。
 * 失败判不出、成功又贴着上限（冷启动 12s vs 15s），所以现象是「一直看不到」。
 *
 * 而 agy 二进制在 `models` 这条路径上**不自己续期**：access token 一过期就报
 * Please sign in。本插件**有**续期能力（`QuotaService.getValidAccessToken`，
 * 写回凭据管理器 + 磁盘），但后台配额轮询最长 15 分钟才跑一次 —— 门控不干等它，
 * 判 false 时自己补一次续期再重探（`gateProbe` / `healPrimaryToken`）。
 */

/** 绕开构造器的真实 spawn，只测门控逻辑本身。 */
function makeService(opts: {
  probeResults: Array<boolean | null>
  tokenExpiryMs?: number
  afterRefreshMs?: number
}) {
  const svc = Object.create(AntigravityService.prototype) as any
  const probeSignedIn = vi.fn(async () => opts.probeResults.shift() ?? null)
  const getStoredToken = vi.fn(() => ({
    accessToken: 'a', refreshToken: 'r',
    expiryMs: opts.afterRefreshMs !== undefined && getStoredToken.mock.calls.length > 1
      ? opts.afterRefreshMs
      : (opts.tokenExpiryMs ?? 0),
  }))
  const getValidAccessToken = vi.fn(async () => 'new-access-token')
  svc.lastHealAt = 0
  svc.auth = { probeSignedIn }
  svc.pool = { ensurePrimaryAccount: vi.fn(() => ({ id: 'acc_primary', systemHome: true })) }
  svc.quota = { getStoredToken, getValidAccessToken }
  return { svc, probeSignedIn, getStoredToken, getValidAccessToken }
}

describe('门控超时常量（钉死取值依据，防止改回 15s）', () => {
  it('spawn 预算必须大于「过期态失败路径」的实测 21s', () => {
    // 反向验证：把 AGY_MODELS_SPAWN_TIMEOUT_MS 改回 15_000 ⇒ 本用例变红。
    expect(AGY_MODELS_SPAWN_TIMEOUT_MS).toBeGreaterThan(21_000)
    expect(AGY_MODELS_SPAWN_TIMEOUT_MS).toBe(30_000)
  })

  it('判不出（null）的缓存必须短于确定性结论', () => {
    // null 多半是「预算耗尽 / 被资格校验拖慢」这类会自愈的中间态，
    // 沿用 60s 会把门控在 unknown 上多卡一分钟。
    expect(AGY_PROBE_UNKNOWN_TTL_MS).toBeLessThan(AGY_PROBE_KNOWN_TTL_MS)
  })
})

describe('gateProbe：判未登录时先续期再重探', () => {
  it('探针判 false ⇒ 续期后重探，翻成 true', async () => {
    const { svc, probeSignedIn, getValidAccessToken } = makeService({
      probeResults: [false, true],
      tokenExpiryMs: Date.now() - 60_000,      // 已过期
      afterRefreshMs: Date.now() + 3_600_000,  // 续期后变新
    })
    expect(await svc.gateProbe()).toBe(true)
    expect(getValidAccessToken).toHaveBeenCalledTimes(1)
    // 重探必须 force=true：否则命中 60s 缓存、拿回旧的 false。
    expect(probeSignedIn).toHaveBeenLastCalledWith(true)
  })

  it('续期没让凭据变新 ⇒ 不重探（每次重探 = 最长 30s 的 spawn）', async () => {
    // 反向验证：若 healPrimaryToken 用「拿到 token 非 null」当判据，
    // getValidAccessToken 失败时**返回的仍是过期旧 token**（非 null），
    // 这条会错误地重探 ⇒ 本用例变红。
    const past = Date.now() - 60_000
    const { svc, probeSignedIn } = makeService({
      probeResults: [false, true],
      tokenExpiryMs: past,
      afterRefreshMs: past, // 续期失败：expiry 原地不动
    })
    expect(await svc.gateProbe()).toBe(false)
    expect(probeSignedIn).toHaveBeenCalledTimes(1)
  })

  it('探针判 true / null 都不触发续期（保守：不把未登录谎报成已登录）', async () => {
    for (const first of [true, null]) {
      const { svc, getValidAccessToken } = makeService({ probeResults: [first] })
      expect(await svc.gateProbe()).toBe(first)
      expect(getValidAccessToken).not.toHaveBeenCalled()
    }
  })

  it('冷却期内不重复向 Google 发续期请求', async () => {
    const { svc, getValidAccessToken } = makeService({
      probeResults: [false, false, false, false],
      tokenExpiryMs: Date.now() - 60_000,
    })
    await svc.gateProbe()
    expect(getValidAccessToken).toHaveBeenCalledTimes(1)
    await svc.gateProbe()
    // 第二次落在 AGY_TOKEN_HEAL_COOLDOWN_MS 内 ⇒ 直接跳过续期。
    expect(getValidAccessToken).toHaveBeenCalledTimes(1)
    expect(AGY_TOKEN_HEAL_COOLDOWN_MS).toBeGreaterThanOrEqual(60_000)
  })

  it('账号条目被外部写空时自愈取回（ensurePrimaryAccount，2026-10-02 同型缺陷）', async () => {
    const { svc } = makeService({
      probeResults: [false, true],
      tokenExpiryMs: Date.now() - 60_000,
      afterRefreshMs: Date.now() + 3_600_000,
    })
    await svc.gateProbe()
    expect(svc.pool.ensurePrimaryAccount).toHaveBeenCalled()
  })
})
