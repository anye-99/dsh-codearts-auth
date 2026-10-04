import { describe, expect, it, vi } from 'vitest'

import {
  AGY_FAMILY_ORDER,
  accountHealthOf,
  cooldownText,
  createAntigravityApi,
  normalizeQuotaRows,
  quotaPercentText,
  sharedCardOf,
} from '../../plugin-src/client/antigravity-api.js'

/**
 * Antigravity 控制面出口（`plugin-src/client/antigravity-api.js`）回归。
 *
 * ## 接入形态（2026-10-02 对齐方案，范围 A）
 *
 * 与其余 13 家一致：账号动作全部走**标准 Jet Hub 动词**
 * （`account.list` / `create` / `update` / `delete` / `reorder` / `refresh` /
 * `retest` / `retestAll` / `reset` / `resetAll`、`login.poll`、`model.list`、
 * `subscriptionQuota.*`、`provider.*`），服务端在
 * 各 case 内按 provider 分派到 `antigravity` 服务；只有**无标准对应物**的
 * agy 专属动作走 `antigravity.*` 扩展动词（粘码/取消/主账号登录/慢探针/
 * 状态快照/设主号/取号模式/代理/开终端）。
 *
 * 本 spec 因此分三组：
 * 1. **端点映射** —— 每个 api 方法打到正确的端点、带对参数（标准 vs 扩展的
 *    边界就在这组锁死：任何人把 agy 动作改回私有端点、或把扩展动作硬塞进
 *    标准动词的 payload，都会在这里变红）；
 * 2. **形状归一** —— `account.create` 的标准响应（loginUrl）翻成面板登录态
 *    形状（url/phase）；`sharedCardOf` 的 family cooldown → modelRateLimits
 *    映射（共享卡片的「重测/重置」禁用判据与限额徽标都消费它）；
 * 3. **纯函数判据** —— 配额量纲（缺失=未知非 0）、健康顺序（auth_required
 *    先于 cooldown）、family 稳定序。
 */

/** 造一个假 rpcCall：记录调用，按 endpoint 返回预设值。 */
function fakeRpc(handlers: Record<string, (payload: unknown) => unknown>) {
  const calls: Array<{ endpoint: string; payload: unknown }> = []
  const fn = vi.fn(async (endpoint: string, payload?: unknown) => {
    calls.push({ endpoint, payload })
    const h = handlers[endpoint]
    if (!h) throw new Error(`unknown endpoint: ${endpoint}`)
    return h(payload)
  })
  return Object.assign(fn, { calls })
}

describe('api 方法 → jet-hub RPC 端点映射（标准/扩展的边界）', () => {
  it('status() 打扩展端点 antigravity.status，并把 value 摊到 status 字段', async () => {
    const rpc = fakeRpc({
      'antigravity.status': () => ({ bin: '/usr/bin/agy', version: '1.1.15', dormantReason: null, pool: { accounts: [] } }),
    })
    const api = createAntigravityApi(rpc)
    const res = await api.status()
    expect(rpc.calls[0]!.endpoint).toBe('antigravity.status')
    expect(res.ok).toBe(true)
    // 面板读 res.status.*：value 必须原样挂到 status 字段。
    expect((res as { status?: { bin?: string } }).status?.bin).toBe('/usr/bin/agy')
    expect((res as { pool?: { accounts?: unknown[] } }).pool?.accounts).toEqual([])
  })

  it('status() 把 dormantReason 抬到顶层 dormant 字段（面板据此显示休眠而非未登录）', async () => {
    const rpc = fakeRpc({
      'antigravity.status': () => ({ dormantReason: '未找到 agy 二进制', pool: {} }),
    })
    const res = await createAntigravityApi(rpc).status()
    expect((res as { dormant?: string | null }).dormant).toBe('未找到 agy 二进制')
  })

  it('accounts() 走标准 account.list（provider=antigravity，服务端分派 agy 池）', async () => {
    const rpc = fakeRpc({
      'account.list': () => ({ accounts: [{ id: 'acc_1', provider: 'antigravity' }] }),
    })
    const res = await createAntigravityApi(rpc).accounts()
    expect(rpc.calls[0]!.endpoint).toBe('account.list')
    expect(rpc.calls[0]!.payload).toEqual({ provider: 'antigravity' })
    expect(res.accounts).toHaveLength(1)
  })

  /**
   * ★ 两步式登录必须走**标准** `account.create`（其余 13 家同一条路径）：
   * 立即返回 loginUrl + qrDataUrl；api 层把它归一成面板的登录态形状。
   */
  it('loginBegin 走标准 account.create 并归一 loginUrl→url/phase=waiting', async () => {
    const rpc = fakeRpc({
      'account.create': () => ({ accountId: 'stg_1', loginUrl: 'https://accounts.google.com/x', qrDataUrl: 'data:image/png;base64,x' }),
    })
    const res = await createAntigravityApi(rpc).loginBegin('work', 'socks5://127.0.0.1:7890')
    expect(rpc.calls[0]!.endpoint).toBe('account.create')
    expect(rpc.calls[0]!.payload).toEqual({ provider: 'antigravity', alias: 'work', proxyUrl: 'socks5://127.0.0.1:7890' })
    expect((res as { url?: string }).url).toContain('accounts.google.com')
    expect((res as { phase?: string }).phase).toBe('waiting')
    expect((res as { qrDataUrl?: string }).qrDataUrl).toContain('data:image/png')
  })

  it('loginPoll 走标准 login.poll 且带 provider', async () => {
    const rpc = fakeRpc({
      'login.poll': () => ({ done: false, phase: 'waiting' }),
    })
    await createAntigravityApi(rpc).loginPoll('stg_1')
    expect(rpc.calls[0]!.endpoint).toBe('login.poll')
    expect(rpc.calls[0]!.payload).toEqual({ provider: 'antigravity', accountId: 'stg_1' })
  })

  /**
   * 主账号登录 / 粘码 / 取消是 **agy 独有交互**（无标准对应物），走扩展动词。
   * 死循环防线（2026-10-02 报障「模型列表里没有」）：池里只有 primary 时，
   * loginBeginPrimary 是唯一登录入口 —— 端点必须在、参数必须透传。
   */
  it('loginBeginPrimary / loginSubmitCode / loginCancel 走 antigravity.* 扩展动词', async () => {
    const rpc = fakeRpc({
      'antigravity.loginBeginPrimary': () => ({ phase: 'waiting', url: 'https://accounts.google.com/p', qrDataUrl: 'data:image/png;base64,p' }),
      'antigravity.loginSubmitCode': () => ({ phase: 'done', code: 'account_activated' }),
      'antigravity.loginCancel': () => ({ phase: 'idle' }),
    })
    const api = createAntigravityApi(rpc)
    const begin = await api.loginBeginPrimary('socks5://127.0.0.1:7890')
    expect(rpc.calls[0]!.endpoint).toBe('antigravity.loginBeginPrimary')
    expect(rpc.calls[0]!.payload).toEqual({ proxyUrl: 'socks5://127.0.0.1:7890' })
    expect((begin as { url?: string }).url).toContain('accounts.google.com')
    await api.loginSubmitCode('4/1Afabc')
    expect(rpc.calls[1]!.endpoint).toBe('antigravity.loginSubmitCode')
    expect(rpc.calls[1]!.payload).toEqual({ code: '4/1Afabc' })
    await api.loginCancel()
    expect(rpc.calls[2]!.endpoint).toBe('antigravity.loginCancel')
  })

  /**
   * ★ 启停 / 改名 / 删除 / 排序 / 刷新全部走**标准动词**（此前它们是
   * agy 专属 UI 或缺席；对齐后与其余 13 家的调用面逐一对应）。
   */
  it('accountToggle / accountRename 走标准 account.update（patch 形状）', async () => {
    const rpc = fakeRpc({ 'account.update': () => undefined })
    const api = createAntigravityApi(rpc)
    await api.accountToggle('acc_1', false)
    expect(rpc.calls[0]!.payload).toEqual({ accountId: 'acc_1', patch: { enabled: false } })
    await api.accountRename('acc_1', 'work')
    expect(rpc.calls[1]!.payload).toEqual({ accountId: 'acc_1', patch: { alias: 'work' } })
    expect(rpc.calls.map(c => c.endpoint)).toEqual(['account.update', 'account.update'])
  })

  it('accountRemove / accountReorder / accountRefresh 走标准动词', async () => {
    const rpc = fakeRpc({
      'account.delete': () => undefined,
      'account.reorder': () => undefined,
      'account.refresh': () => ({ success: true }),
    })
    const api = createAntigravityApi(rpc)
    await api.accountRemove('acc_1')
    await api.accountReorder(['acc_2', 'acc_1'])
    await api.accountRefresh('acc_1')
    expect(rpc.calls.map(c => c.endpoint)).toEqual(['account.delete', 'account.reorder', 'account.refresh'])
    expect(rpc.calls[0]!.payload).toEqual({ accountId: 'acc_1' })
    expect(rpc.calls[1]!.payload).toEqual({ provider: 'antigravity', orderedIds: ['acc_2', 'acc_1'] })
    expect(rpc.calls[2]!.payload).toEqual({ accountId: 'acc_1' })
  })

  /**
   * ★ 重测/重置语义映射（服务端分派）：
   * 重测 = account.retest（单）/ account.retestAll（全）→ agy 强制配额刷新；
   * 重置 = account.reset（单）/ account.resetAll（全）→ 清 family 冷却。
   */
  it('refreshQuota / clearCooldown 走标准 account.retest* / account.reset*', async () => {
    const rpc = fakeRpc({
      'account.retest': () => ({}),
      'account.retestAll': () => ({}),
      'account.reset': () => ({}),
      'account.resetAll': () => ({}),
    })
    const api = createAntigravityApi(rpc)
    await api.refreshQuota('acc_2')     // 单账号
    await api.refreshQuota()            // 省略 id = 全部
    await api.clearCooldown('acc_3')    // 单账号
    await api.clearCooldown()           // 全部
    expect(rpc.calls.map(c => c.endpoint)).toEqual([
      'account.retest', 'account.retestAll', 'account.reset', 'account.resetAll',
    ])
    expect(rpc.calls[0]!.payload).toEqual({ accountId: 'acc_2' })
    expect(rpc.calls[1]!.payload).toEqual({ provider: 'antigravity' })
    expect(rpc.calls[2]!.payload).toEqual({ accountId: 'acc_3' })
    expect(rpc.calls[3]!.payload).toEqual({ provider: 'antigravity' })
  })

  it('setPrimary / setProxy / setMode / openTerminal / probe 走 antigravity.* 扩展动词', async () => {
    const rpc = fakeRpc({
      'antigravity.setPrimary': () => ({}),
      'antigravity.setProxy': () => ({}),
      'antigravity.setMode': () => ({}),
      'antigravity.openTerminal': () => ({}),
      'antigravity.probe': () => ({ auth: { phase: 'ok' }, pool: {} }),
    })
    const api = createAntigravityApi(rpc)
    await api.accountSetPrimary('acc_1')
    await api.accountSetProxy('acc_1', 'http://127.0.0.1:8080')
    await api.poolSetMode('round-robin')
    await api.openTerminal('acc_4')
    await api.probe()
    expect(rpc.calls.map(c => c.endpoint)).toEqual([
      'antigravity.setPrimary', 'antigravity.setProxy', 'antigravity.setMode',
      'antigravity.openTerminal', 'antigravity.probe',
    ])
    expect(rpc.calls[1]!.payload).toEqual({ accountId: 'acc_1', proxyUrl: 'http://127.0.0.1:8080' })
  })

  /**
   * ★ 默认思考档位开关（2026-10-03 用户要求暴露成面板开关）。
   *
   * 它走扩展动词 `antigravity.setDefaultEffort` —— 标准动词里没有"默认档位"
   * 这个概念（其余 12 家的档位完全由服务端目录决定）。空串是**显式**的
   * 「跟随模型默认」，不是"不传"：两者的 `--effort` 行为不同。
   */
  it('setDefaultEffort 走 antigravity.* 扩展动词，空串如实透传', async () => {
    const rpc = fakeRpc({ 'antigravity.setDefaultEffort': () => ({ defaultEffort: 'low' }) })
    const api = createAntigravityApi(rpc)
    await api.setDefaultEffort('low')
    expect(rpc.calls[0]!.endpoint).toBe('antigravity.setDefaultEffort')
    expect(rpc.calls[0]!.payload).toEqual({ effort: 'low' })
    // 空串/undefined 都归一成空串（取消覆盖），不能变成 "undefined" 字符串。
    await api.setDefaultEffort('')
    expect(rpc.calls[1]!.payload).toEqual({ effort: '' })
    await api.setDefaultEffort(undefined)
    expect(rpc.calls[2]!.payload).toEqual({ effort: '' })
  })

  it('rpcCall 抛错时压成 {ok:false}，不向上抛（面板 catch 不到会崩）', async () => {
    const rpc = fakeRpc({ 'antigravity.status': () => { throw new Error('connection lost') } })
    const res = await createAntigravityApi(rpc).status()
    expect(res.ok).toBe(false)
    expect((res as { error?: string }).error).toBe('connection lost')
  })

  it('rpcCall 不是函数时给一组返回不可用的桩（SSR / 单测环境不崩）', async () => {
    const api = createAntigravityApi(undefined as never)
    const res = await api.status()
    expect(res.ok).toBe(false)
  })
})

describe('sharedCardOf：agy 账号 → 共享 AccountCard 形状', () => {
  it('基本字段映射 + 无凭据（credentialRef 空 ⇒ 卡片不渲染凭据行）', () => {
    const card = sharedCardOf(
      { id: 'acc_1', alias: 'work', email: 'a@b.c', enabled: true, quotas: {}, cooldowns: {} },
      'a@b.c',
    )
    expect(card.id).toBe('acc_1')
    expect(card.provider).toBe('antigravity')
    expect(card.nickname).toBe('a@b.c')
    expect(card.enabled).toBe(true)
    expect(card.credentialRef).toBe('')
    // 有效期留空是**如实**：agy 凭归官方二进制，没有本插件视角的过期时刻。
    expect(card.expiresAt).toBeUndefined()
    expect(card.refreshable).toBe(false)
  })

  it('enabled 缺省按启用解释（与账号池 entry.enabled!==false 的既有判据一致）', () => {
    expect(sharedCardOf({ id: 'x', alias: '', quotas: {}, cooldowns: {} }, 'x').enabled).toBe(true)
    expect(sharedCardOf({ id: 'x', alias: '', enabled: false, quotas: {}, cooldowns: {} }, 'x').enabled).toBe(false)
  })

  /**
   * family cooldown → modelRateLimits：共享卡片「限额重置」徽标与
   * 「重测/重置」按钮禁用判据（hasAnyLimit）消费的载体。
   * 过期的冷却不映射（与卡片 `v > Date.now()` 的显示判据一致）。
   */
  it('family cooldown 映射成 modelRateLimits，未过期的才计入', () => {
    const now = Date.now()
    const mapped = sharedCardOf({
      id: 'a', alias: '', quotas: {},
      cooldowns: { google: { cooldownUntil: now + 60_000, reason: '429', consecutiveFailures: 1 }, anthropic: { cooldownUntil: now - 1, reason: 'old', consecutiveFailures: 3 } },
    }, 'a')
    expect(Object.keys(mapped.modelRateLimits ?? {})).toEqual(['google'])

    const none = sharedCardOf({ id: 'a', alias: '', quotas: {}, cooldowns: {} }, 'a')
    expect(none.modelRateLimits).toBeUndefined()
  })

  it('agy 专属维度原样带过（systemHome/accountDir/isPrimary 等）', () => {
    const card = sharedCardOf({
      id: 'acc_p', alias: 'primary', systemHome: true, dir: '', isPrimary: true,
      proxyUrl: 'socks5://x', quotas: { google: { remainingFraction: 0.5 } }, cooldowns: {},
    }, 'primary')
    expect(card.systemHome).toBe(true)
    expect(card.accountDir).toBe('')
    expect(card.isPrimary).toBe(true)
    expect(card.proxyUrl).toBe('socks5://x')
    expect(card.quotas.google).toMatchObject({ remainingFraction: 0.5 })
  })
})

describe('配额量纲（缺失必须是未知，不能是 0）', () => {
  it('remainingFraction 缺失 ⇒ null，且 quotaPercentText 显示"未查询"', () => {
    const [row] = normalizeQuotaRows({ google: {} })
    expect(row!.remaining).toBeNull()
    expect(row!.weekly).toBeNull()
    expect(quotaPercentText(row!.remaining)).toBe('未查询')
  })

  it('remainingFraction 为 0 ⇒ 0%（已用光），与未知可区分', () => {
    const [row] = normalizeQuotaRows({ google: { remainingFraction: 0 } })
    expect(row!.remaining).toBe(0)
    expect(quotaPercentText(0)).toBe('0%')
  })

  it('family 顺序稳定：已知三家在前，未知在后按字典序', () => {
    const rows = normalizeQuotaRows({
      openai: { remainingFraction: 1 },
      customx: {},
      anthropic: {},
    })
    expect(rows.map(r => r.family)).toEqual(['anthropic', 'openai', 'customx'])
  })

  it('非有限数（NaN / 字符串 / undefined）一律未知，不落成 0% 或看似合法的值', () => {
    expect(quotaPercentText(NaN)).toBe('未查询')
    expect(quotaPercentText(undefined as unknown as number)).toBe('未查询')
    expect(quotaPercentText(Infinity)).toBe('未查询')
    expect(quotaPercentText('0.4' as unknown as number)).toBe('未查询')
  })

  it('normalizeQuotaRows 同样拒绝非数字的 remainingFraction（外部 JSON 不保证类型）', () => {
    const [row] = normalizeQuotaRows({ google: { remainingFraction: '0.4' } })
    expect(row!.remaining).toBeNull()
    const [ok] = normalizeQuotaRows({ google: { remainingFraction: 0.4 } })
    expect(ok!.remaining).toBe(0.4)
  })

  it('quotas 为空/非对象 ⇒ 空数组而不是抛错', () => {
    expect(normalizeQuotaRows(undefined)).toEqual([])
    expect(normalizeQuotaRows(null)).toEqual([])
    expect(normalizeQuotaRows('x')).toEqual([])
  })

  it('百分比钳制在 0~100（上游偶发 >1 的浮点不外溢）', () => {
    expect(quotaPercentText(1.4)).toBe('100%')
    expect(quotaPercentText(-0.2)).toBe('0%')
    expect(quotaPercentText(0.1234)).toBe('12%')
  })

  it('AGY_FAMILY_ORDER 常量稳定（与服务端一致：google/anthropic/openai）', () => {
    expect([...AGY_FAMILY_ORDER]).toEqual(['google', 'anthropic', 'openai'])
  })
})

describe('账号健康判据', () => {
  const NOW = 1_700_000_000_000

  it('auth_required 优先于 cooldown（等完仍不能用，要的是可行动提示）', () => {
    const acc = {
      enabled: true,
      authRequired: true,
      authError: 'invalid_grant',
      cooldowns: { google: { cooldownUntil: NOW + 60_000, reason: '429', consecutiveFailures: 2 } },
    }
    expect(accountHealthOf(acc, NOW)).toMatchObject({ status: 'auth_required', message: 'invalid_grant' })
  })

  it('enabled:false ⇒ disabled 且优先于一切', () => {
    expect(accountHealthOf({ enabled: false, authRequired: true }, NOW).status).toBe('disabled')
  })

  it('冷却已过期不算 cooldown', () => {
    const acc = { enabled: true, cooldowns: { google: { cooldownUntil: NOW - 1, reason: '429' } } }
    expect(accountHealthOf(acc, NOW).status).toBe('healthy')
    expect(cooldownText({ cooldownUntil: NOW - 1 }, NOW)).toBeNull()
  })

  it('cooldown 文案带原因与约剩余分钟', () => {
    const acc = { enabled: true, cooldowns: { anthropic: { cooldownUntil: NOW + 5 * 60_000, reason: 'Quota Exhausted' } } }
    const health = accountHealthOf(acc, NOW)
    expect(health.status).toBe('cooldown')
    expect(health.family).toBe('anthropic')
    expect(health.message).toContain('Quota Exhausted')
    expect(health.message).toContain('5 分钟')
  })

  it('reason 缺失时退回通用文案而不是显示 undefined', () => {
    expect(cooldownText({ cooldownUntil: NOW + 30_000 }, NOW)).toContain('限流冷却')
  })
})
