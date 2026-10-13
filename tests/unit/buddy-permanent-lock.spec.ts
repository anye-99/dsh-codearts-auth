/**
 * CodeBuddy / WorkBuddy 的「锁定永久积分」**接线**回归（`src/index.ts`）。
 *
 * ## 为什么单独守这个
 *
 * 判据与选号都是纯函数（已由 `buddy-balance-rank.spec.ts` /
 * `buddy-balance-selector.spec.ts` 锁死）。但历史上反复出问题的从来不是
 * 算法，而是**没接上**：
 *
 * - WorkBuddy 的「刷新」按钮一直坏着，因为新增分支时漏接了一处 case；
 * - Qoder 的 `modelId` 曾传空串，于是模型级限流过滤整体短路；
 * - Loomy 的锁定制过「绕过」的坑：锁定后绝不可落到单凭据兜底。
 *
 * 所以这里逐条钉住接线本身。UI 无法在单测里渲染（react 不在本仓库依赖内），
 * 故与 `loomy-wiring.spec.ts` 同款：**源码级断言 + 可执行部分用行为级验证**。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { BuddyBalanceSelector, pickBuddyAccount } from '../../src/buddy-balance-selector.js'
import { BUDDY_EXPIRING_WINDOW_DAYS } from '../../src/buddy-balance-rank.js'
import { CODEBUDDY, WORKBUDDY } from '../../src/product.js'
import type { BuddyCredential } from '../../src/buddy.js'
import type { CreditBalance } from '../../src/credits.js'

const here = dirname(fileURLToPath(import.meta.url))
const indexSource = readFileSync(resolve(here, '../../src/index.ts'), 'utf8').replace(/\r\n/g, '\n')

/**
 * 剥掉注释后的源码。
 *
 * ⚠️ 接线断言**不能**因为「注释里提到了某个符号」就通过或失败：
 * 本仓库的注释大量解释「为什么绝不能走某条兜底路径」，于是对兜底的
 * **否定**断言必须只看代码（与 `refresh-bootstrap-wiring.spec.ts` 同一约定）。
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const indexCode = codeOnly(indexSource)

/** 取编排函数的**函数体**（以下一个 provider 注册语句为界，避免窗口溢出到调用方）。 */
function pickHelperBody(): string {
  const start = indexCode.indexOf('const pickBuddyCredential =')
  expect(start, 'index.ts 里找不到 pickBuddyCredential').toBeGreaterThan(-1)
  const end = indexCode.indexOf('const buddy = new BuddyAuth(ctx)', start)
  expect(end, 'index.ts 里找不到 BuddyAuth 注册（分界标记变了要同步改本用例）').toBeGreaterThan(start)
  return indexCode.slice(start, end)
}

describe('index.ts 的接线', () => {
  it('导入选号器与编排函数（漏 import 就等于没接）', () => {
    expect(indexCode).toContain("from './buddy-balance-selector.js'")
    expect(indexCode).toContain('BuddyBalanceSelector')
    expect(indexCode).toContain('pickBuddyAccount')
    // 报错文案里的窗口天数必须**运行时解析**（可用环境变量覆盖），
    // 不能在文案里写死字面量 —— 否则用户改了窗口，报错还在说 15 天。
    expect(indexCode).toContain("from './buddy-balance-rank.js'")
    expect(indexCode).toContain('buddyExpiringWindowDays()')
  })

  /**
   * ⚠️ 两个 provider 必须各有一个 selector 实例。
   * 共用一份缓存会让 CodeBuddy 的余额结果被 WorkBuddy 读到（键是账号 id，
   * 两站账号 id 不同，看似不会撞 —— 但凭据解析与 endpoint 都跟着 product 走，
   * 共用实例等于把「两站同构」这一前提写死进运行时）。
   */
  it('CodeBuddy 与 WorkBuddy 各建一个选号器', () => {
    expect(indexCode).toMatch(/const buddyBalanceSelector = new BuddyBalanceSelector\(\{\s*\n\s*product: CODEBUDDY,/)
    expect(indexCode).toMatch(/const workbuddyBalanceSelector = new BuddyBalanceSelector\(\{\s*\n\s*product: WORKBUDDY,/)
    expect(indexCode.match(/new BuddyBalanceSelector\(/g)).toHaveLength(2)
  })

  it('凭据解析函数两站共用一份（同协议，差别只在 endpoint）', () => {
    expect(indexCode).toContain('const resolveBuddyCredentialByRef =')
    // 三处引用：两个 selector 的依赖 + 编排调用时的凭据解析器
    expect(indexCode.match(/resolveCredential: resolveBuddyCredentialByRef/g)).toHaveLength(3)
  })

  it('两个 provider 的 resolveCredential 都走选号编排', () => {
    expect(indexCode).toMatch(/const picked = await pickBuddyCredential\(\{\s*\n\s*product: CODEBUDDY,/)
    expect(indexCode).toMatch(/const picked = await pickBuddyCredential\(\{\s*\n\s*product: WORKBUDDY,/)
    expect(indexCode.match(/await pickBuddyCredential\(\{/g)).toHaveLength(2)
  })

  /**
   * ⚠️ 候选必须**先**按 enabled + 模型限流过滤，余额分档只在候选内进行 ——
   * 与 Loomy 同一约定（用户要求「策略建立在模型没有受限且账户没有被停用的基础上」）。
   * 顺序反了就会出现「被限流的号因为积分多而被选中」。
   *
   * ⚠️ 限流判据必须走**共享的** `rateLimitedUntil()`，不要退回内联
   * `modelRateLimits[key]`：共享函数同时认「按模型」与「整账号」（保留键 `'*'`）
   * 两种标记，内联写法只认前者 —— 会让被整账号标记的账号重新进入候选
   *（Qoder 日额度 code 110 实测按账号结算，见 AGENTS.md）。
   */
  it('候选过滤：provider id 取自产品配置、enabled、模型限流三项齐全', () => {
    const body = pickHelperBody()
    // provider 实参用 product.id 而非字面量（写死字面量在改名/多产品时会静默查不到账号）
    expect(body).toContain('listAccountsByProvider(options.product.id)')
    expect(body).toContain('filter(a => a.enabled)')
    // 限流判据走共享实现（与 `getAvailableAccount` 同源），且透传 modelId
    expect(body).toContain('rateLimitedUntil(a.modelRateLimits, options.modelId ?? \'\')')
    // 防退回内联写法：内联只认按模型键，会漏掉整账号标记
    expect(body).not.toContain('modelRateLimits[key]')
  })

  it('锁定状态按 provider 读，且判据是取反（permanentLocked=true ⇒ allowPermanent=false）', () => {
    expect(pickHelperBody()).toContain('const allowPermanent = !pool.permanentLocked(options.product.id)')
  })

  /**
   * ⚠️ **锁定时绝不可落到 `getAvailableAccount` 兜底** —— 那会绕过锁定、
   * 照样消耗永久积分，使锁定形同虚设（Loomy 那条同因，用户明确要求报错）。
   *
   * ⚠️ 且必须**分两种原因报**（与 Loomy 同型缺陷）：把"余额查不到"报成
   * "额度已用尽"，用户会去解锁或白等，而号其实有钱。
   */
  it('编排返回 locked 时直接抛错，函数体内不做任何兜底', () => {
    const body = pickHelperBody()
    expect(body).toMatch(/if \(picked\.kind === 'locked'\) \{/)
    // 整个编排函数里都不该出现兜底取号 —— 兜底只属于未锁定的调用方路径
    expect(body).not.toContain('getAvailableAccount')

    const throws = body.match(/throw new Error\(/g) ?? []
    expect(throws.length, '应有"查不到"与"确实用尽"两条报错').toBeGreaterThanOrEqual(2)
    expect(body).toMatch(/picked\.reason\?\.kind === 'unknown'/)
    // 两条文案各自说清
    expect(body).toContain('无法确认是否有可用账号')
    expect(body).toContain('没有可用账号')
    // 文案要告诉用户去哪个面板解锁，并按窗口说清「什么算临时积分」
    expect(body).toContain('options.displayName')
    expect(body).toContain('buddyExpiringWindowDays()')
    expect(body).toContain('解锁永久积分')
  })

  it('未锁定且编排没选到时，兜底必须带上 tried 排除集（否则原地打转）', () => {
    // buddy 与 workbuddy 两处兜底都要传
    const calls = indexCode.match(/pool\.getAvailableAccount\((?:CODEBUDDY|WORKBUDDY)\.id, modelId \?\? '', picked\.tried\)/g) ?? []
    expect(calls).toHaveLength(2)
  })

  it('两个 provider 各自的报错文案用其产品名', () => {
    expect(indexCode).toContain("displayName: 'CodeBuddy'")
    expect(indexCode).toContain("displayName: 'WorkBuddy'")
  })
})

/**
 * 行为级：**endpoint 必须随产品切换**。
 *
 * `product` 是选号器唯一的路由信息来源 —— 若两站共用一份 product，
 * 中国版账号会拿着国际版的余额（或反之），锁定判据就建立在错的数据上。
 * 这是本插件反复踩过的坑（endpoint 不可当全局常量）。
 */
describe('选号器按产品取 endpoint（两站不串味）', () => {
  const DAY = 24 * 60 * 60 * 1000
  const balance: CreditBalance = {
    total: 250,
    packages: [{
      name: 'Bonus Pack',
      unit: 'credits',
      remaining: 250,
      total: 250,
      used: 0,
      active: true,
      cycleStartTime: '',
      cycleEndTime: '',
      expiredTime: '',
      deductionEndTime: Date.now() + 9 * DAY,
    }],
    expiredTotal: 0,
  }

  function selectorFor(product: typeof CODEBUDDY, seen: string[]) {
    return new BuddyBalanceSelector({
      product,
      resolveCredential: async ref => ({ access_token: 'AT', domain: product.apiDomain } as BuddyCredential & { domain: string }) as unknown as BuddyCredential,
      fetchBalance: async (_credential, p) => {
        seen.push(`${p.endpoint}/v2/billing/meter/get-user-resource`)
        return balance
      },
    })
  }

  it('CodeBuddy 用 copilot.tencent.com，WorkBuddy 用 www.workbuddy.ai', async () => {
    const seen: string[] = []
    const buddy = selectorFor(CODEBUDDY, seen)
    const workbuddy = selectorFor(WORKBUDDY, seen)

    const pickedBuddy = await buddy.select([{ id: 'b1', credentialRef: 'BUDDY_ACCOUNT_B1' }], {})
    const pickedWorkbuddy = await workbuddy.select([{ id: 'w1', credentialRef: 'WORKBUDDY_ACCOUNT_W1' }], {})

    expect(seen).toEqual([
      `${CODEBUDDY.endpoint}/v2/billing/meter/get-user-resource`,
      `${WORKBUDDY.endpoint}/v2/billing/meter/get-user-resource`,
    ])
    // 两站都有「15 天内到期」的包 ⇒ 都落在 expiring 档、都被选中
    expect(pickedBuddy?.account.id).toBe('b1')
    expect(pickedWorkbuddy?.account.id).toBe('w1')
    expect(pickedBuddy?.balance.tier).toBe(0)
  })

  it('编排层拿到的凭据来自实际选中的那个账号', async () => {
    const seen: string[] = []
    const selector = selectorFor(CODEBUDDY, seen)
    const result = await pickBuddyAccount(selector, [
      { id: 'b1', credentialRef: 'BUDDY_ACCOUNT_B1' },
    ], {
      allowPermanent: false,
      resolveCredential: async ref => ({ access_token: `token-${ref}` }) as unknown as BuddyCredential,
    })
    expect(result.kind).toBe('account')
    if (result.kind !== 'account') return
    expect(result.credential.access_token).toBe('token-BUDDY_ACCOUNT_B1')
  })

  it('窗口边界在编排里同样生效（17 天的包在锁定时不可用）', async () => {
    const seen: string[] = []
    const selector = new BuddyBalanceSelector({
      product: CODEBUDDY,
      resolveCredential: async ref => ({ access_token: ref }) as unknown as BuddyCredential,
      fetchBalance: async () => ({
        total: 100,
        expiredTotal: 0,
        packages: [{
          name: 'CodeBuddy个人版国内运营裂变包',
          unit: 'credits',
          remaining: 100,
          total: 100,
          used: 0,
          active: true,
          cycleStartTime: '',
          cycleEndTime: '',
          expiredTime: '',
          // 实测中国版裂变包的到期分布密集落在 17～30 天
          deductionEndTime: Date.now() + 17 * DAY,
        }],
      }),
    })
    const result = await pickBuddyAccount(selector, [{ id: 'b1', credentialRef: 'R1' }], {
      allowPermanent: false,
      resolveCredential: async () => ({ access_token: 'x' }) as unknown as BuddyCredential,
    })
    // ⇒ 该账号在锁定期间「等同于不可用」：这正是用户要的语义，不是缺陷
    expect(result.kind).toBe('locked')
    expect(BUDDY_EXPIRING_WINDOW_DAYS).toBe(15)
  })
})
