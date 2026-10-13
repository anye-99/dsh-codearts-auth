/**
 * Step Code（阶跃星辰）Jet Hub 接入的**接线点完整性**回归。
 *
 * 与 `stepcode.spec.ts`（协议/登录/适配器行为）分工不同：本文件只做
 * **源码级断言** —— 守那些「不报错、只是功能静默不可用」的接线缺口。
 * 这类缺陷在本仓库已反复发生（见 AGENTS.md 的「位置参数陷阱」章节）：
 *
 * | 缺口 | 症状 |
 * |---|---|
 * | `index.ts` 少一处接线 | 面板可见但点「添加账号」报 unknown provider |
 * | `REF_PREFIX_TO_PROVIDER` 漏加 | `state.json` 丢失后账号**静默消失** |
 * | `registerJetHubRpc` 占位错位 | `modelAdapters` 落到 auth 形参上 ⇒ 展示名退化成裸 id |
 * | 能力矩阵漏登记 | 面板上没有余额/签到按钮（本 provider 两项**如实为 false**） |
 * | 三处 provider 顺序不一致 | 逐项核对时无从对齐，新增面板必错位 |
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { STEPCODE } from '../../src/stepcode-product.js'
import { CREDITS_CAPABILITIES } from '../../plugin-src/client/credits-capabilities.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(resolve(HERE, rel), 'utf8')
const readClient = (name: string): string => read(`../../plugin-src/client/${name}`)

/** 剥掉注释（本仓库注释里常**逐字写出反模式**，不剥会让 `not.toMatch` 恒假失败）。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

describe('宿主侧装配（src/index.ts）', () => {
  const index = read('../../src/index.ts')
  const code = stripComments(index)

  it('★ 六处接线点齐全', () => {
    // 1. import
    expect(index).toContain("from './stepcode-auth.js'")
    expect(index).toContain("from './stepcode-adapter.js'")
    expect(index).toContain("from './stepcode-product.js'")
    // 2. registerProviderSettings 的 namespace
    expect(index).toContain("'llm-stepcode'")
    // 3. 服务实例 + 适配器注册
    expect(index).toContain('new StepcodeAuth(ctx)')
    expect(index).toContain('registerStepcodeLlm(ctx, {')
    // 4. refreshTargets 调度表
    expect(index).toContain("['stepcode', (p) => stepcode.refreshAll(p)]")
    // 5. modelAdapters 登记
    expect(index).toContain('stepcode: stepcodeAdapter')
    // 6. registerJetHubRpc 实参（位置必须与另两处对齐：zcode 之后、agyService 之前）
    expect(index).toMatch(/teleagent, zcode, stepcode, agyService, modelAdapters/)
  })

  it('★ refresh 回调必须用两层结构（available.entry.*），否则回填静默不生效', () => {
    const block = code.slice(code.indexOf('const stepcode = new StepcodeAuth(ctx)'))
    const refreshPart = block.slice(0, block.indexOf('fetchRemoteModels'))
    expect(refreshPart).toContain('available.entry.credentialRef')
    expect(refreshPart).toContain('available.entry.id')
    // 反向：不得出现裸字段取法（注释已剥离，命中即真问题）
    expect(refreshPart).not.toMatch(/available\.credentialRef\b/)
    expect(refreshPart).not.toMatch(/available\.id\b/)
  })

  it('★ resolveCredential 用 STEPCODE.id 而非字面量（改名会静默查不到账号）', () => {
    const block = code.slice(code.indexOf('const stepcode = new StepcodeAuth(ctx)'))
    expect(block).toContain('pool.getAvailableAccount(STEPCODE.id')
    expect(block).not.toMatch(/getAvailableAccount\('stepcode'/)
  })

  it('★ fetchRemoteModels 必须把账号池传进去（目录是**账号级**的）', () => {
    // 官方文档明示「可用模型和额度取决于账户权限」⇒ 拉目录要带当前账号的 Bearer。
    expect(code).toContain('stepcode.fetchModels(pool)')
  })
})

describe('RPC 分派（src/jet-hub-rpc.ts）', () => {
  const rpc = read('../../src/jet-hub-rpc.ts')
  const code = stripComments(rpc)

  it('★ registerJetHubRpc / registerJetHubEndpoints 都有 stepcode 形参', () => {
    expect(rpc).toContain('stepcode: StepcodeAuth')
    // 两处转调链都要带上它（漏一处 = 形参收到 undefined 的静默错位）。
    expect(rpc).toMatch(/zcode, stepcode, antigravity, modelAdapters/)
  })

  it('★ account.create 有 stepcode 分支，且走标准两步式（先占位、后回填）', () => {
    expect(code).toContain('provider === STEPCODE.id')
    const start = code.indexOf('} else if (provider === STEPCODE.id)')
    expect(start, 'account.create 缺 stepcode 分支').toBeGreaterThanOrEqual(0)
    const body = code.slice(start, code.indexOf('} else if (provider === ANTIGRAVITY_PROVIDER_ID)'))
    // 占位条目必须先建（否则前端 login.poll 看不到该账号）
    expect(body).toContain('pool.addAccount({')
    expect(body).toContain('refreshable: false')
    // 两步式：startLogin 的 result 在后台落定，**不得** await 完才返回 URL
    expect(body).toContain('stepcode.startLogin(id)')
    expect(body).toContain('stepcodeStarted.result.then')
    expect(body).not.toContain('await stepcodeStarted.result')
    // 登录失败要删占位条目（不留幽灵账号）
    expect(body).toContain('pool.removeAccount(id)')
    // 去重判据是服务端 uid（不是会变的 api_key）
    expect(body).toContain("findAccountIdByIdentityField(")
    expect(body).toContain("'uid'")
  })

  it('★ account.refresh 的 switch 有 stepcode case（用实例方法，不串别家）', () => {
    expect(code).toContain('case STEPCODE.id:')
    expect(code).toContain('await stepcode.refreshAccountCredential(entry.credentialRef, pool, entry.id)')
  })

  it('★ 不引入 stepcode.* 扩展动词（标准两步式足够，多一个动词就是多余的接口面）', () => {
    expect(code).not.toMatch(/case 'stepcode\./)
  })

  /**
   * ★★ 真实缺陷回归（2026-10-09 用户报障「模型列表里没有这个」）。
   *
   * 登录成功后**必须**做两件事，缺任一件症状都是「模型列表里始终没有该 provider」：
   *
   * ① **失效服务端适配器缓存**（`invalidateModelCache`）—— 未登录时
   *    `listModels` 走目录门控返回 `[]`，若适配器缓存了这个空数组，
   *    登录后它再也不会重新拉取；
   * ② **广播 `llm/adapters-updated`** —— 客户端 `ModelCatalogDirectory`
   *    在 `status === 'ready'` 时**短路返回缓存**，只有该事件能让它重拉。
   *
   * ⚠️ 这里断言**全文范围内的相对顺序**，不再复刻「按行切分支体」的切片逻辑：
   * 那个切片受文件换行符（`\r\n`）与注释剥离顺序影响，在 vitest 的转换管线里
   * 与独立 Node 进程读到的结果**不一致**（写这组用例时实测踩到：Node 复刻
   * 通过、vitest 里恒失败）。断言相对顺序同样能钉死这两条契约，且不依赖切片。
   */
  it('★★ stepcode 分支：登录成功必须失效两层缓存并广播目录变更', () => {
    // ① 服务端适配器缓存失效（登录回调里显式失效）
    expect(code).toMatch(/modelAdapters\?\.stepcode\?\.invalidateModelCache\?\.\(\)/)
    // ② 客户端目录缓存失效（广播）
    expect(code).toMatch(/broadcastCatalogChanged\(ctx\)/)
    // ③ 接口声明了该可选方法（否则 `?.()` 会静默不执行）
    expect(rpc).toMatch(/invalidateModelCache\?\(\): void/)

    // ⚠️ 顺序：先失效**服务端**缓存，再广播让客户端重读。
    // 反了则客户端重读时服务端仍返回缓存的空目录（白跑一趟，症状不变）。
    const invalidateAt = code.indexOf('modelAdapters?.stepcode?.invalidateModelCache?.()')
    const broadcastAt = code.indexOf('broadcastCatalogChanged(ctx)', invalidateAt)
    expect(invalidateAt).toBeGreaterThanOrEqual(0)
    expect(broadcastAt).toBeGreaterThan(invalidateAt)
    // ④ 两者都必须排在**池条目回填之后**（否则客户端读到「无凭据」状态）
    const updateAt = code.indexOf('await pool.updateAccount(id, {', invalidateAt - 2000)
    expect(updateAt).toBeGreaterThanOrEqual(0)
    expect(updateAt).toBeLessThan(invalidateAt)
  })

  it('★ ModelCatalogSource 声明了可选 invalidateModelCache（否则调用会静默失效）', () => {
    // ⚠️ 漏声明会让 TS 报错；若靠 `as never` 绕过，运行时 `?.()` 会静默不执行。
    expect(rpc).toMatch(/interface ModelCatalogSource\s*\{[\s\S]*?invalidateModelCache\?\(\): void/)
  })
})

describe('凭据恢复表（src/jet-hub-store.ts）', () => {
  const store = read('../../src/jet-hub-store.ts')

  it('★ REF_PREFIX_TO_PROVIDER 必须含 stepcode（漏加 ⇒ 账号静默消失）', () => {
    expect(store).toMatch(/\['STEPCODE', 'stepcode'\]/)
  })
})

describe('客户端（plugin-src/client/）', () => {
  it('★ PROVIDERS 里已登记 stepcode（否则 Jet Hub 根本没这个面板）', () => {
    const source = readClient('jet-hub.js')
    const ids = [...source.matchAll(/\{ id: '([a-z-]+)', label:/g)].map((m) => m[1])
    expect(ids).toContain('stepcode')
    // 计数口径：15 个面板（14 → 15，2026-10-09 接入 stepcode）。
    expect(ids).toHaveLength(15)
  })

  it('★ 展示名与产品配置逐字一致（避免两处漂移）', () => {
    const entry = /id: 'stepcode', label: '([^']+)'/.exec(readClient('jet-hub.js'))
    expect(entry?.[1]).toBe(STEPCODE.displayName)
  })

  it('有内联图标且已注册 CSS 类', () => {
    expect(readClient('jet-hub.js')).toMatch(/const STEPCODE_ICON = 'data:image\/svg\+xml;base64,/)
    expect(readClient('jet-hub-styles.js')).toMatch(/\.dim-jh-providerIcon\.stepcode/)
  })

  it('★ 能力矩阵**显式**登记（未登记 = 两项全无，是「未探明」而非「实测没有」）', () => {
    expect(CREDITS_CAPABILITIES.stepcode).toEqual({ balance: false, dailyCheckin: false })
  })
})

describe('★ 三处 provider 顺序对齐（客户端 / 恢复表 / RPC 形参）', () => {
  /**
   * 这三处顺序必须一致，便于逐项核对；不一致时**不会**报错，
   * 只会在新增面板时让人数不清该插在哪（AGENTS.md 反复记过）。
   *
   * 本仓库的统一口径：`teleagent` 在 `minimax` 之后、`zcode` 之前；
   * `stepcode` 在 `zcode` 之后、`antigravity` 之前（antigravity 恒为最后）。
   */
  it('客户端 PROVIDERS：teleagent → zcode → stepcode → antigravity', () => {
    const ids = [...readClient('jet-hub.js').matchAll(/\{ id: '([a-z-]+)', label:/g)].map((m) => m[1])
    expect(ids.indexOf('teleagent')).toBeLessThan(ids.indexOf('zcode'))
    expect(ids.indexOf('zcode')).toBeLessThan(ids.indexOf('stepcode'))
    expect(ids.indexOf('stepcode')).toBeLessThan(ids.indexOf('antigravity'))
    expect(ids[ids.length - 1]).toBe('antigravity')
  })

  it('恢复表：teleagent → zcode → stepcode，且不含 antigravity', () => {
    /**
     * ⚠️ **必须剥注释**：该表末尾那段注释正**逐字解释**为什么
     * `['ANTIGRAVITY', 'antigravity']` 不该进表（引用原文是刻意的），
     * 不剥就会命中注释而恒假失败 —— 与 minimax / teleagent 那两组用例
     * 踩过的是同一个坑（见 `teleagent-rpc.spec.ts` 的 `stripComments`）。
     */
    const store = stripComments(read('../../src/jet-hub-store.ts'))
    const table = store.slice(store.indexOf('REF_PREFIX_TO_PROVIDER'))
    const order = ['TELEAGENT', 'ZCODE', 'STEPCODE'].map((p) => table.indexOf(`['${p}'`))
    expect(order[0]).toBeGreaterThanOrEqual(0)
    expect(order[0]).toBeLessThan(order[1])
    expect(order[1]).toBeLessThan(order[2])
    expect(table).not.toContain("['ANTIGRAVITY'")
  })

  it('RPC 形参：zcode → stepcode → antigravity → modelAdapters', () => {
    const line = read('../../src/jet-hub-rpc.ts')
      .split('\n').find((l) => l.trim().startsWith('qoder, qoderCn, trae,'))
    expect(line, 'registerJetHubEndpoints 转调行未找到').toBeDefined()
    const args = (line ?? '').split(',').map((s) => s.trim())
    expect(args.indexOf('stepcode')).toBeGreaterThan(args.indexOf('zcode'))
    expect(args.indexOf('stepcode')).toBeLessThan(args.indexOf('antigravity'))
    expect(args.indexOf('antigravity')).toBeLessThan(args.indexOf('modelAdapters'))
  })
})
