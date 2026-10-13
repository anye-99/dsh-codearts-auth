import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Antigravity（第 14 个面板）的**接入一致性**回归（2026-10-02 对齐方案）。
 *
 * ## 这个文件锁的是什么
 *
 * antigravity 与其他 13 家的差别是**结构性**的（凭据归官方 `agy` 二进制、
 * 账号是隔离 HOME、池住 `~/.dsh/agy-accounts/pool.json`）—— 这些差别**保留**。
 * 但「接入方式」必须一致：产品配置单一真相源、`registerJetHubRpc` 位置参数、
 * 标准动词分派、刷新调度表、能力矩阵、订阅额度登记。
 * 本文件逐点锁死这条边界：**该一致的地方不一致 → 红；
 * 该保留的差别被"顺手统一"掉（比如把 ANTIGRAVITY 塞进凭据恢复表）→ 也红。**
 *
 * ⚠️ 全部是**源码级断言**（与 `qoder-wiring` / `raccoon-wiring` 同法）：
 * 宿主侧真实装配（spawn agy、读 Keychain）在本仓库的测试环境里做不到，
 * 而「接线漏一处」恰恰是这类多接线点集成最容易发生、也最难在运行期发现的
 * 缺陷形态（AGENTS.md：位置参数陷阱已复发七次）。
 */

const here = dirname(fileURLToPath(import.meta.url))
const read = (p: string): string => readFileSync(resolve(here, p), 'utf8')

/** 剔除注释行：注释里会**叙述被禁的反模式**（如"不要写 agy.loginBegin"），不剥会假阳性。 */
function codeOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
}

describe('宿主侧装配（src/index.ts）', () => {
  const index = read('../../src/index.ts')

  it('注册了 llm-antigravity settings namespace（与其余 provider 一致）', () => {
    expect(index).toContain("'llm-antigravity'")
  })

  it('服务与适配器都已构造并注册进 llm 路由', () => {
    expect(index).toContain('createAntigravityService(ctx)')
    expect(index).toContain('new AntigravityAdapter(')
    expect(index).toMatch(/registerAdapterIdempotent\(ctx\.llm, \['antigravity'\], agyAdapter\)/)
  })

  /**
   * ★ 对齐方案的核心一条：服务经**位置参数**传入 RPC（与其余 13 个 auth 实例
   * 同一契约），模块级 holder 已删除。
   * holder 的问题不是"不能用"，而是**签名不可见** —— 新增 provider 的人从
   * `registerJetHubRpc` 的参数表数不出第 14 家，占位错位的复发土壤。
   */
  it('agyService 作为 registerJetHubRpc 的实参传入（在 modelAdapters 之前）', () => {
    /**
     * ⚠️ 这条断言**不写死整串**（2026-10-09 改成顺序断言）：原文写的是
     * `registerJetHubRpc([\s\S]*?zcode, agyService, modelAdapters`，接入
     * stepcode 后调用变成 `…, zcode, stepcode, agyService, modelAdapters`，
     * 正则立刻失配 —— 而「第 15 个面板插在哪」跟 antigravity 的契约无关。
     * 改为断言**顺序关系**，对新增 provider 中立（AGENTS.md「位置参数陷阱」：
     * 加 provider 时不要把整串写死，否则每次接入都要回来改断言）。
     */
    const callLine = index.split('\n').find(line => line.trim().startsWith('registerJetHubRpc('))
    expect(callLine, 'registerJetHubRpc 调用必须单行').toBeDefined()
    // ⚠️ 先剥掉行尾右括号再 split —— 否则最后一个参数是 `modelAdapters)`，
    // `indexOf('modelAdapters')` 会返回 -1，`toBeLessThan(-1)` 恒失败
    //（首次改写这条断言时实测踩到）。
    const args = (callLine ?? '').replace(/\)\s*$/, '').split(',').map((s) => s.trim())
    expect(args.indexOf('agyService')).toBeGreaterThan(args.indexOf('zcode'))
    expect(args.indexOf('agyService')).toBeLessThan(args.indexOf('modelAdapters'))
  })

  it('antigravity 适配器登记进 modelAdapters（显示列表的全量目录来源）', () => {
    expect(index).toContain('antigravity: agyAdapter')
  })

  it('refreshTargets 调度表包含 antigravity（与其余面板同一批量入口）', () => {
    expect(index).toMatch(/\['antigravity', \(p\) => agyService\.refreshAll\(\)\]/)
  })

  it('清理钩子 dispose 服务（防孤儿 interval / spawn）', () => {
    expect(index).toContain('agyService.dispose()')
  })

  it('模块级 holder 已彻底移除（不留半截）', () => {
    expect(index).not.toContain('antigravity-registry')
    expect(index).not.toContain('setAntigravityService')
    expect(existsSync(resolve(here, '../../src/antigravity-registry.ts'))).toBe(false)
    // 只读池快照模块随宿主分派改走服务实例一起退役（它的 provider id 迁到产品表）。
    expect(existsSync(resolve(here, '../../src/antigravity-pool.ts'))).toBe(false)
  })
})

describe('产品配置单一真相源（src/antigravity-product.ts）', () => {
  const product = read('../../src/antigravity-product.ts')
  const rpc = codeOnly(read('../../src/jet-hub-rpc.ts'))

  it('provider id 与 llm 路由名逐字节一致（不一致 = 目录/分派双断）', () => {
    expect(product).toContain("id: 'antigravity'")
    expect(product).toContain("export const ANTIGRAVITY_PROVIDER_ID: 'antigravity' = ANTIGRAVITY.id")
    // 协议层（从对面移植，不可改）的同名常量必须一致。
    const types = read('../../src/agy/types.ts')
    expect(types).toContain("export const PROVIDER_ID = 'antigravity'")
  })

  it('jet-hub-rpc 的 provider id 来自产品表而不是别处', () => {
    expect(rpc).toContain("from './antigravity-product.js'")
    expect(rpc).not.toContain("from './antigravity-pool.js'")
  })

  it('适配器的 PROVIDER 走产品表', () => {
    const adapter = read('../../src/antigravity-adapter.ts')
    expect(adapter).toContain("import { ANTIGRAVITY_PROVIDER_ID } from './antigravity-product.js'")
    expect(adapter).not.toMatch(/^export const PROVIDER = 'antigravity'$/m)
  })
})

describe('RPC 分派（src/jet-hub-rpc.ts）：标准动词承载 agy', () => {
  const rpc = read('../../src/jet-hub-rpc.ts')
  const code = codeOnly(rpc)

  /**
   * 截取某个 `case 'X'` 的**语句体**（从 case 头到下一个同缩进 case 头 /
   * default 为止），供"这个端点分支里必须/不得出现 X"类断言。
   *
   * ⚠️ 为什么不用 `case 'X'[\s\S]{0,N}?needle` 的距离式正则：case 体长度随
   * 无关改动增长（注释、字段），距离窗口要么写小漏判、要么写大**越过 case 边界
   * 匹配到下一个分支**得到假绿。按边界切体是唯一确定性的做法。
   */
  function caseBody(method: string): string {
    const start = code.indexOf(`case '${method}'`)
    expect(start, `端点 ${method} 的 case 不存在`).toBeGreaterThanOrEqual(0)
    const rest = code.slice(start + method.length + 10)
    const next = rest.search(/\n {6}(case|default):/)
    return next === -1 ? rest : rest.slice(0, next)
  }

  it('registerJetHubRpc / registerJetHubEndpoints 都有 antigravity 形参', () => {
    expect(rpc).toContain('antigravity?: AntigravityService')
    /**
     * 两处转调链都要带上它（漏一处 = 形参收到 undefined 的静默错位）。
     *
     * ⚠️ **断言改成顺序关系，不写死整串**（2026-10-09）：原文写的是
     * `…zcode, antigravity, modelAdapters,`，接入 stepcode 后变成
     * `…zcode, stepcode, antigravity, modelAdapters,` ⇒ 正则失配。
     * 「第 15 个面板插在哪」与 antigravity 的契约无关，故只钉死
     * 「antigravity 排在 zcode 之后、modelAdapters 之前」这两个真关系 ——
     * 对将来新增 provider 中立（AGENTS.md「位置参数陷阱」要求的写法）。
     */
    const fwd = /registerJetHubEndpoints\(\s*\n?\s*connectionCtx as Context, pool, codearts,([\s\S]*?)\)/.exec(rpc)
    expect(fwd, 'registerJetHubEndpoints 转调未找到').not.toBeNull()
    const args = (fwd?.[1] ?? '').split(',').map((s) => s.trim())
    expect(args.indexOf('antigravity')).toBeGreaterThan(args.indexOf('zcode'))
    expect(args.indexOf('antigravity')).toBeLessThan(args.indexOf('modelAdapters'))
  })

  /**
   * ★ 标准端点的 antigravity 分派。判据分两种，各自对应 payload 的形状：
   *
   * - 带 `provider` 的（list/create/reorder/retestAll/resetAll/login.poll/
   *   provider.*）⇒ 按 `ANTIGRAVITY_PROVIDER_ID` 等值判定；
   * - 只有 `accountId` 的（update/delete/refresh/retest/reset）⇒ 按**账号 id
   *   反查 agy 池**（`requireAgyService` + `pool.getAccount`），这是
   *   `RpcUpdateAccountRequest` 等契约里唯一可行的判据 —— 写死 provider
   *   反而需要前端多传一个字段，且与旧客户端不兼容。
   *
   * 少任何一处，动作会落到「凭据型账号池」的分支上（表现成「账号不存在」或
   * "改了一个不存在的 ref"—— 静默错对象，与 WorkBuddy 刷新按钮、qoder 刷错
   * 凭据是同族缺陷）。
   */
  it('account.* / login.poll / provider.* 都有 antigravity 分支', () => {
    expect(caseBody('account.list')).toMatch(/ANTIGRAVITY_PROVIDER_ID[\s\S]*pool\.getAccounts\(\)/)
    expect(caseBody('account.create')).toMatch(/provider === ANTIGRAVITY_PROVIDER_ID[\s\S]*poolAuth\.begin\(/)
    expect(caseBody('account.update')).toMatch(/requireAgyService\(antigravity\)[\s\S]*pool\.getAccount\(req\.accountId\)[\s\S]*setAccountEnabled\(/)
    expect(caseBody('account.delete')).toMatch(/requireAgyService\(antigravity\)[\s\S]*deleteAccount\(req\.accountId\)/)
    expect(caseBody('account.reorder')).toMatch(/ANTIGRAVITY_PROVIDER_ID[\s\S]*reorderAccounts\(/)
    expect(caseBody('account.refresh')).toMatch(/requireAgyService\(antigravity\)[\s\S]*refreshAccount\(req\.accountId\)/)
    expect(caseBody('login.poll')).toMatch(/req\.provider === ANTIGRAVITY_PROVIDER_ID[\s\S]*poolAuthStatus\(\)/)
    // 供应商开关：agy 账号启停走它自己的池，且整体顺序仍是"模型在前、账号在后"。
    const setEnabled = caseBody('provider.setEnabled')
    expect(setEnabled).toMatch(/ANTIGRAVITY_PROVIDER_ID[\s\S]*setAccountEnabled\(/)
    expect(setEnabled).toMatch(/pool\.setModelsDisabled[\s\S]*accountCount = await pool\.setAccountsEnabled|const accountCount: number[\s\S]*setAccountsEnabled/)
  })

  it('account.retest* / account.reset* 分派到配额刷新与清冷却', () => {
    expect(caseBody('account.retest')).toMatch(/requireAgyService\(antigravity\)[\s\S]*refreshAccountQuota\(acc, true\)/)
    expect(caseBody('account.retestAll')).toMatch(/ANTIGRAVITY_PROVIDER_ID[\s\S]*refreshAllQuotas\(true\)/)
    expect(caseBody('account.reset')).toMatch(/requireAgyService\(antigravity\)[\s\S]*clearCooldown\(req\.accountId/)
    expect(caseBody('account.resetAll')).toMatch(/ANTIGRAVITY_PROVIDER_ID[\s\S]*clearCooldown\(undefined/)
  })

  /**
   * ★ 「重测」的 agy 语义必须回报**标准形状**（`RpcRetestResponse` 的
   * accounts/clearedCount），否则共享卡片的汇总文案会读成 undefined。
   * 逐笔记录该渠道不提供时如实回 note（不渲染假空表）。
   */
  /**
   * ★ 默认思考档位开关（2026-10-03 用户要求「在面板里暴露、自己调」）。
   *
   * 三处必须同时存在，缺一就是"界面能点但不生效"或"存了但界面不显示"：
   * ① RPC 端点；② `status` 回传当前值（界面据此高亮）；③ 落盘后广播
   *   （档位进入 `resolveModel().reasoning.defaultEffort`，不广播则模型
   *   选择器一直显示旧默认档）。
   */
  it('默认思考档位：端点 + status 回传 + 广播齐全', () => {
    const setter = caseBody('antigravity.setDefaultEffort')
    expect(setter).toMatch(/setDefaultEffort\(body\.effort\)/)
    expect(setter).toContain('broadcastCatalogChanged(ctx)')
    const status = caseBody('antigravity.status')
    expect(status).toContain('defaultEffort: got.svc.config.defaultEffort')
    expect(status).toMatch(/efforts: \[\.\.\.got\.svc\.efforts\]/)
  })

  it('agy 的重测/重置回标准响应形状；不提供记录时回 note', () => {
    expect(caseBody('account.retest')).toMatch(/accounts: \[\{ accountId: req\.accountId[\s\S]*clearedCount/)
    expect(caseBody('subscriptionQuota.requestLog')).toMatch(/ANTIGRAVITY_PROVIDER_ID[\s\S]*note: 'Antigravity/)
    expect(caseBody('subscriptionQuota.get')).toMatch(/ANTIGRAVITY_PROVIDER_ID[\s\S]*percentUsed/)
  })

  /**
   * ★ 订阅额度的两家分派（P3 的核心：端点不再只认 Cline）。
   * antigravity 分支必须**不发网络**（数据来自账号池缓存）且量纲换算正确方向
   * （剩余→已用）；行为级细节见 `jet-hub-rpc.spec.ts` 的 agy 路径用例，
   * 这里只锁接线 + 旧名兼容。
   */
  it('subscriptionQuota.get / requestLog 是新端点名，cline.* 旧名走 handleMethod 归一', () => {
    expect(code).toContain("case 'subscriptionQuota.get'")
    expect(code).toContain("case 'subscriptionQuota.requestLog'")
    // 兼容层：旧名归一（旧客户端缓存打 `cline.quota` 不能落 unknown method）。
    expect(rpc).toMatch(/if \(method === 'cline\.quota'\) return handleMethod\('subscriptionQuota\.get'/)
    expect(rpc).toMatch(/if \(method === 'cline\.requestLog'\) return handleMethod\('subscriptionQuota\.requestLog'/)
    // 面板不再有写死 provider 的旧 Cline 端点调用。
    expect(code).not.toMatch(/rpcCall\('cline\.quota'/)
  })

  it('旧扩展动词 agy.* 已全部改名（不留半个 agy. 前缀端点）', () => {
    expect(code).not.toMatch(/case 'agy\./)
    for (const name of [
      'antigravity.loginBeginPrimary', 'antigravity.loginSubmitCode', 'antigravity.loginCancel',
      'antigravity.setPrimary', 'antigravity.setMode', 'antigravity.setProxy',
      'antigravity.status', 'antigravity.probe', 'antigravity.openTerminal',
    ]) {
      expect(code, `扩展动词 ${name} 必须存在`).toContain(`case '${name}'`)
    }
  })

  /**
   * ★ 被**吸收**进标准动词的旧扩展动词不得复活（它们已无用例/无调用方）：
   * `agy.loginBegin`→account.create、`agy.refreshQuota`→account.retest*、
   * `agy.clearCooldown`→account.reset*、`agy.models`→model.list（共享面板）。
   * 留着的坏处不是冗余，而是**同一件事两套表达**会漂移（对面 HTTP 面的教训）。
   */
  it('被吸收的扩展动词已删除', () => {
    for (const name of [
      'agy.loginBegin', 'agy.refreshQuota', 'agy.clearCooldown', 'agy.models',
      'antigravity.models',
    ]) {
      expect(code, `${name} 应已被标准动词吸收`).not.toContain(`case '${name}'`)
    }
  })

  it('provider.status 的账号计数走服务（不再读独立池文件）', () => {
    const body = caseBody('provider.status')
    expect(body).toMatch(/ANTIGRAVITY_PROVIDER_ID[\s\S]*svc\.pool\.getAccounts\(\)/)
    expect(body).not.toContain('readAntigravityPool')
  })

  it('缺席判据是结构化错误码（不是抛异常被包成 handler-failed）', () => {
    expect(rpc).toContain("code: 'jet-hub/antigravity-unavailable'")
  })
})

describe('凭据恢复的刻意缺席（src/jet-hub-store.ts）', () => {
  const store = codeOnly(read('../../src/jet-hub-store.ts'))

  /**
   * ⚠️ `ANTIGRAVITY` **不得**出现在恢复表里（行为级钉死见
   * `jet-hub-store.spec.ts` 的两条用例）。这里锁的是"别在源码里悄悄加回去"——
   * 加回去的后果：state.json 丢失时凭空造出指向空气的账号条目。
   */
  it("REF_PREFIX_TO_PROVIDER 没有 ['ANTIGRAVITY', 'antigravity']", () => {
    expect(store).not.toMatch(/\['ANTIGRAVITY',\s*'antigravity'\]/)
    // 其余 12 家的前缀都在（防止我这条断言因整表被误删而"假绿"）。
    expect(store).toMatch(/\['ZCODE',\s*'zcode'\]/)
    expect(store).toMatch(/\['MINIMAX',\s*'minimax'\]/)
  })
})

describe('客户端（plugin-src/client/）', () => {
  const client = read('../../plugin-src/client/jet-hub.js')
  const panel = read('../../plugin-src/client/antigravity-panel.js')
  const api = codeOnly(read('../../plugin-src/client/antigravity-api.js'))
  const caps = read('../../plugin-src/client/credits-capabilities.js')

  /**
   * ★ 共享化三件套：面板的账号卡片 / 显示列表 / 订阅额度都复用共享组件。
   * 传递方式是 **prop 注入**而不是 import —— `jet-hub.js` 已 import 面板文件，
   * 反向 import 构成循环依赖（esbuild 会静默产出 undefined 绑定，
   * 表现成运行期「Element type is invalid」，比编译报错更难查）。
   */
  it('面板用注入的共享组件渲染账号卡 / 显示列表 / 订阅额度', () => {
    expect(panel).toMatch(/export function AntigravityPanel\(\{ rpcCall, AccountCard, ModelListPanel, SubscriptionQuotaPanel \}\)/)
    expect(panel).toMatch(/h\(AccountCard, \{/)
    expect(panel).toMatch(/h\(ModelListPanel, \{/)
    expect(panel).toMatch(/h\(SubscriptionQuotaPanel, \{/)
    // 注入侧齐全（漏一个 = 运行期 undefined 组件）。
    expect(client).toMatch(/AccountCard,\s*\n\s*ModelListPanel,\s*\n\s*SubscriptionQuotaPanel,/)
  })

  it('面板不得反向 import jet-hub.js（循环依赖）', () => {
    expect(panel).not.toMatch(/from '\.\/jet-hub\.js'/)
  })

  /**
   * ★ 面板的账号动作一律经 `antigravity-api.js`，不得在渲染处直写端点名
   * （§2.3 迁移约束在自实现形态下的延续：面板只见方法名）。
   */
  it('面板源码里没有任何 rpcCall 端点字面量', () => {
    const panelCode = codeOnly(panel)
    expect(panelCode).not.toMatch(/rpcCall\('/)
    expect(panelCode).toContain('api.accountToggle(')
    expect(panelCode).toContain('api.accountReorder(')
    expect(panelCode).toContain('api.refreshQuota(')
  })

  it('api 层的标准动词映射齐全（account.* / login.poll）', () => {
    for (const endpoint of [
      'account.list', 'account.create', 'account.update', 'account.delete',
      'account.reorder', 'account.refresh', 'account.retest', 'account.retestAll',
      'account.reset', 'account.resetAll', 'login.poll',
    ]) {
      expect(api, `api 应打 ${endpoint}`).toContain(`'${endpoint}'`)
    }
    // 已删除的死配置不得回来。
    expect(api).not.toContain("call('antigravity.models'")
  })

  /**
   * ★ 默认思考档位开关的客户端接线：面板经 api 层调用、选项来自服务端、
   * 档位值与展示名分离。
   */
  it('面板有默认档位选择器，且选项来自服务端（不硬编码档位表）', () => {
    const panelCode = codeOnly(panel)
    expect(panelCode).toContain('api.setDefaultEffort(')
    // 选项来自 status.efforts（与 --effort 白名单同源）；硬编码会让 agy
    // 新增档位时界面缺项。
    expect(panelCode).toMatch(/status\.efforts \?\? \[\]/)
    expect(panelCode).toContain('跟随模型默认')
    // 展示名与档位**值**分离：值必须原样是 low|medium|high|max。
    expect(panel).toMatch(/const EFFORT_LABEL = \{ low: '低', medium: '中', high: '高', max: '最大' \}/)
    expect(api).toContain("call('antigravity.setDefaultEffort'")
  })

  it('能力矩阵显式登记 antigravity（balance/checkin false、subscriptionQuota true）', () => {
    expect(caps).toMatch(/antigravity: Object\.freeze\(\{ balance: false, dailyCheckin: false, subscriptionQuota: true \}\)/)
  })

  it('订阅额度面板不再写死 cline（provider 形参化）', () => {
    expect(client).toMatch(/function SubscriptionQuotaPanel\(\{ provider, rpcCall, onClose \}\)/)
    expect(client).not.toMatch(/function ClineQuotaPanel\(/)
    expect(client).not.toMatch(/rpcCall\('cline\.quota'/)
    expect(client).not.toMatch(/rpcCall\('cline\.requestLog'/)
  })

  it('PROVIDERS 末条仍是 antigravity（对齐不动面板归属）', () => {
    // ⚠️ 标题原先写「第 13 条」—— 2026-10-07 接入 teleagent 后它仍是**末条**，
    // 但序号已变（14）。本用例的判据从来是「这条目存在且形状未变」，
    // 不是下标，故改成「末条」表述，避免序号漂移让标题说谎。
    expect(client).toMatch(/\{ id: 'antigravity', label: 'Antigravity \(Google\)'/)
  })
})
