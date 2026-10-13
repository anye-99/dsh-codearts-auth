import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 多账号续期调度的**接线**回归（Gitee issue !IKIRTT）。
 *
 * `src/expiry-sync.spec.ts` 测的是共享实现的语义；本文件锁的是「九个 provider
 * 是不是**都真的接上了**」—— 这正是该缺陷的形态：raccoon 接好了，其余七个
 * 各漏一环，于是「点刷新没反应」只出现在部分面板。逐条源码级断言是这里
 * 最划算的防线：新增 provider 时漏接会**立刻**变红，而不是等用户报障。
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(here, '../..')
const read = (rel: string): string => readFileSync(resolve(root, rel), 'utf8')

/** 剥掉注释：接线断言不该因为「注释里提到了某个符号」而通过。 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const indexSource = codeOnly(read('src/index.ts'))
const rpcSource = codeOnly(read('src/jet-hub-rpc.ts'))

/** auth 文件清单（`buddy-auth.ts` 一份实现同时服务 buddy 与 workbuddy）。 */
const AUTH_FILES = [
  'src/service.ts',
  'src/buddy-auth.ts',
  'src/lobsterai-auth.ts',
  'src/qoder-auth.ts',
  'src/trae-auth.ts',
  'src/cline-auth.ts',
  'src/loomy-auth.ts',
  'src/raccoon-auth.ts',
  // ⚠️ MiniMax 是第 9 个 auth 文件（buddy-auth 一份服务两个 provider）。
  // 加它之前本清单**漏了 minimax** —— 于是「续期必须带 pool/accountId 且调
  // `syncAccountExpiry`」这条契约对 minimax **不被强制**（Spec 盲区）。
  // 该契约正是「账号卡片刷新按钮按下去没反应」那个缺陷的回归防线，
  // 新增 provider 时必须同步加进来。
  'src/minimax-auth.ts',
  // ⚠️ TeleAgent（星辰超级智能体）：同样**不可续期**（无 refresh 端点），
  // 语义与 Loomy 同型 —— 只借用共享的对账回写，故下方 lead-time 用例把它
  // 与 loomy / raccoon 一起排除，并由专门的例外用例锁死它的独有语义。
  'src/teleagent-auth.ts',
]

/** 取出某个方法从签名到结束花括号的整段（CRLF 安全）。 */
function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature)
  expect(start, `源码里找不到 ${signature}`).toBeGreaterThan(-1)
  const end = source.slice(start).search(/\r?\n  \}\r?\n/)
  return end === -1 ? source.slice(start) : source.slice(start, start + end)
}

describe('续期调度器：启动必须先跑一轮', () => {
  /**
   * ⚠️ 主缺陷（issue 第三节）：早先这里**只有** `setInterval`，
   * 第一次处理要等满一个周期。cline（1 小时）/ codearts（约 2 小时）/
   * raccoon（3 小时）的凭据在宿主关闭期间早已到期，于是重启后
   * **最长 30 分钟**一直显示「已过期」、积分行一直 401。
   */
  it('setInterval 之前存在一次直接的 refreshAllCredentials() 调用', () => {
    const bootstrap = indexSource.indexOf('void refreshAllCredentials()')
    const timer = indexSource.indexOf('setInterval(() => void refreshAllCredentials()')
    expect(bootstrap, '启动时没有任何一轮续期 → 短寿命账号会挂「已过期」最长 30 分钟').toBeGreaterThan(-1)
    expect(timer).toBeGreaterThan(-1)
    expect(bootstrap, '启动首轮必须排在武装定时器之前').toBeLessThan(timer)
  })

  it('启动判据既不看 `enabled`，也不看 `refreshable`（被误标的布尔不能决定调度器是否武装）', () => {
    // `indexSource` 已经过 `codeOnly` 处理（见文件头），注释里的字面量不参与断言。
    const gate = indexSource.slice(
      indexSource.indexOf('listAllAccounts()'),
      indexSource.indexOf('setInterval(() => void refreshAllCredentials()'),
    )
    // 2026-10-02 修订：原先这里是 `accounts.some(a => a.refreshable)`。
    // 本次事故实测 36 条账号只剩 3 条 `true`（raccoon / minimax / cline 各一）——
    // 再少三条，整个续期调度器（含 codearts 的自愈与启动首轮）就**永不武装**，
    // 而且日志里一个字都不会有。「用可能被误标的字段决定要不要修误标」是循环依赖。
    expect(gate).not.toMatch(/\.refreshable/)
    expect(gate).not.toMatch(/enabled/)
    expect(gate).toMatch(/accounts\.length\s*===\s*0/)
  })

  it('listAllAccounts 的链上有 .catch（否则存储异常会让定时器永不武装且无痕）', () => {
    const start = indexSource.indexOf('pool.listAllAccounts()')
    expect(start).toBeGreaterThan(-1)
    expect(indexSource.slice(start, start + 1200)).toContain('.catch(')
  })

  it('全部 provider 实例都在批量续期清单里（新增 provider 不得漏接）', () => {
    const expected = [
      'service', 'buddy', 'workbuddy', 'lobsterai', 'qoder',
      'qoderCn', 'trae', 'cline', 'loomy', 'raccoon',
      // ⚠️ 新增 provider 必须同时加进 `src/index.ts` 的 refreshTargets
      // **与本清单** —— 只加前者不会被这条用例发现（它会静默不续期）。
      'minimax',
      // teleagent 不可续期，但**仍要在清单里**：它的 `refreshAll` 只按
      // `refreshable` 过滤（恒 false ⇒ 不发请求），保留这一条是为了让
      // 「批量入口的形状」与其余 provider 一致，且漏接不会被发现。
      'teleagent',
    ]
    for (const name of expected) {
      expect(
        indexSource,
        `${name}.refreshAll 未接入多账号续期调度`,
      ).toMatch(new RegExp(`\\(?p\\)?\\s*=>\\s*${name}\\.refreshAll\\(p\\)`))
    }
  })

  it('每个 provider 的失败都走同一条日志路径（不再有十个静默 catch）', () => {
    // 旧写法是十个 `try { … } catch { /* 静默 */ }`，把 provider 内部的告警
    // 与异常一起吞掉（issue 第 5.4 条）。现在收敛成一个循环 + 一处 warn。
    const start = indexSource.indexOf('async function refreshAllCredentials')
    expect(start).toBeGreaterThan(-1)
    // 取到函数体结束（CRLF 安全：用正则找第一个「缩进两格的花括号」）
    const body = indexSource.slice(start, start + 800).split(/\r?\n  \}\r?\n/)[0] ?? ''
    expect(body).toMatch(/for \(const \[tag, refreshAll\] of refreshTargets\)/)
    expect(body).toContain('批量续期失败')
    expect(body).not.toMatch(/catch\s*\{\s*\}/)
  })
})

describe('按需续期必须回写账号池的有效期', () => {
  /**
   * issue 第 5.3 条：`refreshAccountCredential` 过去只有 raccoon 回写，
   * 其余七个只 `credentials.set` —— 于是账号卡片的「刷新」按钮**按下去没反应**
   * （凭据续好了，UI 读的池值纹丝不动）。
   */
  it.each(AUTH_FILES)('%s 的 refreshAccountCredential 接受 pool + accountId', (rel) => {
    const signature = methodBody(codeOnly(read(rel)), 'async refreshAccountCredential')
    expect(signature, `${rel}: 签名缺 pool`).toContain('pool?: AccountPool')
    expect(signature, `${rel}: 签名缺 accountId`).toContain('accountId?: string')
    // Loomy 无续期端点，但仍要在探测成功后对账（见 LOOMY_EXPIRY_ACCESSORS）。
    //
    // ⚠️ **两种正确形态都接受**（补 minimax 时实测到该断言原先过窄）：
    // ① 直接调 `syncAccountExpiry(...)`（raccoon 的写法）；
    // ② 走包装 `refreshAccountWithReconcile(...)` —— 它**内部**两处调用
    //    `syncAccountExpiry`（见 `src/expiry-sync.ts`），是更规范的用法
    //    （自带回写失败不反噬、有效期内仍对账等既有不变量）。
    // 只认 ① 会把 ② 判为「未调用共享回写」—— 那是**假阴性**。
    expect(signature, `${rel}: 未调用共享回写`).toMatch(
      /syncAccountExpiry\(|refreshAccountWithReconcile\(/,
    )
  })

  it('九个 auth 都改用共享的有效期回写，不再各写一份', () => {
    // 本缺陷的形态正是「raccoon 接好了、其余七个各漏一环」，
    // 故这里锁的是「每个文件都真的引了 `src/expiry-sync.ts`」。
    for (const rel of AUTH_FILES) {
      const source = codeOnly(read(rel))
      expect(source, `${rel}: 未接入共享实现`).toContain("from './expiry-sync.js'")
      expect(source, `${rel}: 未调用共享实现`).toMatch(
        /syncAccountExpiry\(|refreshAccountWithReconcile\(|shouldRefreshNow\(/,
      )
    }
  })

  it('可续期 provider 的 refreshAll 走 lead-time + 对账', () => {
    // Loomy 不在内：它没有 refresh 端点，refreshAll 保留「只探测已过期账号」的
    // 独有语义。raccoon 也不在内：它保留自己更严的「已过期才刷」判据
    // （见 `raccoon-auth.ts` 的注释），只共用回写。
    // teleagent 同样不在内：与 Loomy 同型（无 refresh 端点），见下方例外用例。
    for (const rel of AUTH_FILES.filter((file) => !/loomy|raccoon|teleagent/.test(file))) {
      const source = codeOnly(read(rel))
      expect(
        source,
        `${rel}: refreshAll 未接入 refreshAccountWithReconcile`,
      ).toMatch(/refreshAccountWithReconcile\(/)
    }
  })

  /**
   * 例外说明：Loomy 不能续期（`isLoomyRefreshable` 恒 false），
   * 它的 refreshAll 保留「只探测已过期的账号」这一独有语义，
   * 因此不走 lead-time 过滤，只借用共享的对账回写。
   */
  it('loomy 只做有效期对账，且绝不回写 refreshable', () => {
    const source = codeOnly(read('src/loomy-auth.ts'))
    expect(source).toContain('LOOMY_EXPIRY_ACCESSORS')
    expect(source).toMatch(/syncAccountExpiry\(/)
    // 不提供 refreshableOf → 共享实现不会把池里的 `refreshable` 改掉。
    expect(source).not.toMatch(/refreshableOf/)
  })

  /**
   * 例外说明（与 Loomy 同型）：TeleAgent 不能续期
   * （`isTeleagentRefreshable` 恒 false，asar 全文无 refresh_token /
   * ExchangeToken / token 刷新调用），它的 `refreshAll` 保留
   * 「只按 refreshable 过滤 ⇒ 实际一个账号都不处理」这一独有语义
   * （对不可能成功的操作每 30 分钟发一轮请求是纯浪费），
   * 因此不走 lead-time 过滤，只借用共享的对账回写。
   */
  it('teleagent 只做有效期对账，且绝不回写 refreshable', () => {
    const source = codeOnly(read('src/teleagent-auth.ts'))
    expect(source).toContain('TELEAGENT_EXPIRY_ACCESSORS')
    expect(source).toMatch(/syncAccountExpiry\(/)
    // 不提供 refreshableOf → 共享实现不会把池里的 `refreshable` 改掉。
    expect(source).not.toMatch(/refreshableOf/)
    // ⚠️ 它的 refreshAll 必须**只按 refreshable 过滤**（不看 enabled）。
    const refreshAll = source.slice(source.indexOf('async refreshAll'))
    expect(refreshAll).toContain('if (!entry.refreshable) continue')
    expect(refreshAll).not.toMatch(/\.enabled/)
  })

  it('account.refresh 的每个 provider 分支都把 pool 与 entry.id 传下去', () => {
    const switchStart = rpcSource.indexOf('switch (entry.provider)')
    const switchBody = rpcSource.slice(switchStart, rpcSource.indexOf('default:', switchStart))
    const branches = switchBody.match(/case /g) ?? []
    expect(branches.length).toBeGreaterThanOrEqual(10)
    // qoder 与 qodercn **共用一个 case**（同族注册表），故调用数比分支数少一。
    const calls = switchBody.match(/refreshAccountCredential\([^)]*\)/g) ?? []
    expect(calls.length).toBeGreaterThanOrEqual(branches.length - 1)
    for (const call of calls) {
      expect(call, `RPC 分支漏传 pool/entry.id：${call}`).toMatch(/pool,\s*entry\.id/)
    }
  })

  it('index.ts 的适配器 refresh 回调同样传 pool 与账号 id（按需续期最常触发的路径）', () => {
    const calls = indexSource.match(/refreshAccountCredential\([^)]*\)/g) ?? []
    // 八个：codearts / lobsterai / qoder / qodercn / trae / cline / loomy / raccoon。
    // buddy 与 workbuddy 走 `createPoolRefresh`（下一条用例）。
    expect(calls.length).toBeGreaterThanOrEqual(8)
    for (const call of calls) {
      expect(call).toMatch(/pool,\s*available\.entry\.id/)
    }
  })

  it('createPoolRefresh（CodeBuddy 系发消息途中的按需续期）也回写账号池', () => {
    // 这条路径由 `buddy-adapter.ts` 的 401/403 分支调用，触发频率远高于
    // 账号卡片的「刷新」按钮；漏传 pool 就意味着 buddy/workbuddy 的
    // 「已过期」显示在实际续期成功后仍然挂着。
    const source = codeOnly(read('src/buddy-auth.ts'))
    const body = source.slice(source.indexOf('export function createPoolRefresh'))
    expect(body).toMatch(
      /refreshAccountCredential\(\s*available\.entry\.credentialRef,\s*pool,\s*available\.entry\.id/,
    )
  })
})
