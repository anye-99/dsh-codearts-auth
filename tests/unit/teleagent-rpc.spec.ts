import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { claimAllImplementation } from './jet-hub-rpc-source.js'

/**
 * TeleAgent 的**接线源码断言**。
 *
 * ## 为什么需要这一份（而不是只靠行为测试）
 *
 * 接线类改动有一个**类型检查抓不到**的失效模式：接线点**漏接**或**串接**。
 * 本仓库在 `registerJetHubRpc` 的位置参数上已踩**八次** —— git 认为「无冲突」
 * （改动分散在不同段落），但插入一个 provider 会让后面的实参整体错位一格，
 * `modelAdapters` 落到最后一个 auth 形参上，症状是「显示列表」的 total 恒为 0。
 *
 * ⇒ 这里用**源码级断言**把六处接线点钉死。它们不是形式主义：
 * 每一条都对应一个真实踩过的坑。
 */

describe('TeleAgent 接线点完整性（源码断言）', () => {
  const indexSource = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8')
  const rpcSource = readFileSync(new URL('../../src/jet-hub-rpc.ts', import.meta.url), 'utf8')
  const storeSource = readFileSync(new URL('../../src/jet-hub-store.ts', import.meta.url), 'utf8')
  const clientSource = readFileSync(
    new URL('../../plugin-src/client/jet-hub.js', import.meta.url), 'utf8',
  )
  const capsSource = readFileSync(
    new URL('../../plugin-src/client/credits-capabilities.js', import.meta.url), 'utf8',
  )

  /**
   * 剥掉注释后再断言。
   *
   * ⚠️ **必须剥**：本仓库注释里经常**逐字写出反模式**（例如
   * 「不能写成 `available.id`」），不剥离会让 `not.toMatch` 命中注释本身而
   * 恒假失败（写 minimax 那组用例时实测踩到）。
   */
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

  it('★ index.ts 六处接线点齐全', () => {
    // 1. import
    expect(indexSource).toContain("from './teleagent-auth.js'")
    expect(indexSource).toContain("from './teleagent-adapter.js'")
    expect(indexSource).toContain("from './teleagent-product.js'")
    // 2. registerProviderSettings 的 namespace
    expect(indexSource).toContain("'llm-teleagent'")
    // 3. 服务实例 + 适配器注册
    expect(indexSource).toContain('new TeleagentAuth(ctx)')
    expect(indexSource).toContain('registerTeleagentLlm(ctx, {')
    // 4. refreshTargets 表
    expect(indexSource).toContain("['teleagent', (p) => teleagent.refreshAll(p)]")
    // 5. modelAdapters 登记
    expect(indexSource).toContain('teleagent: teleagentAdapter')
    // 6. registerJetHubRpc 实参 —— 这条正则的本意就是「数占位」：
    //    新增面板时必须同步在这里补一个名字，否则 modelAdapters 会错位
    //    落到最后一个 auth 形参上（本仓库已踩八次）。
    //    ⚠️ 2026-10-09 接入 stepcode（插在 zcode 与 agyService 之间）→ 已补。
    expect(indexSource).toMatch(/loomy, raccoon, minimax, teleagent, zcode, stepcode, agyService, modelAdapters/)
  })

  it('★ index.ts 的 refresh 回调必须用两层结构（available.entry.*）', () => {
    // 真实缺陷形态：写成 available.id / available.credentialRef 会得到
    // undefined ⇒ 回填**静默不生效**，UI 永远显示「已过期」。
    const code = stripComments(indexSource)
    const block = code.slice(code.indexOf('const teleagent = new TeleagentAuth(ctx)'))
    const refreshPart = block.slice(0, block.indexOf('fetchRemoteModels'))
    expect(refreshPart).toContain('available.entry.credentialRef')
    expect(refreshPart).toContain('available.entry.id')
    // 反向：不得出现裸字段取法（注释已剥离，故命中即真问题）
    expect(refreshPart).not.toMatch(/available\.credentialRef\b/)
    expect(refreshPart).not.toMatch(/available\.id\b/)
  })

  it('★ resolveCredential 用 TELEAGENT.id 而非字面量（改名会静默查不到账号）', () => {
    const code = stripComments(indexSource)
    const block = code.slice(code.indexOf('const teleagent = new TeleagentAuth(ctx)'))
    const resolvePart = block.slice(0, block.indexOf('refresh: async'))
    expect(resolvePart).toContain('pool.getAvailableAccount(TELEAGENT.id')
    expect(resolvePart).not.toMatch(/getAvailableAccount\(\s*['"]teleagent['"]/)
  })

  it('★ jet-hub-rpc.ts 三处分支齐全，且都用 TELEAGENT.id 分派', () => {
    expect(rpcSource).toContain('provider === TELEAGENT.id') // account.create
    expect(rpcSource).toContain('case TELEAGENT.id:') // account.refresh
    expect(rpcSource).toContain("case 'teleagent.loginSubmitCallback'") // 扩展动词
  })

  it('★ 不得把 teleagent 的刷新分支串到别家实例上', () => {
    // 真实缺陷形态：CN 那次「中国版账号的刷新去续了国际版凭据」。
    const code = stripComments(rpcSource)
    // ⚠️ 锚点限定在 `account.refresh` 之内（真实事故，2026-10-13）：
    // `case TELEAGENT.id:` 在 `claimAllForProvider()`（`credits.claimAll` 的
    // 实现，每日自动签到与 RPC 共用）里也有一处，从全文开头找会命中那一个。
    const refreshAt = code.indexOf("case 'account.refresh'")
    expect(refreshAt).toBeGreaterThan(-1)
    const idx = code.indexOf('case TELEAGENT.id:', refreshAt)
    expect(idx).toBeGreaterThan(-1)
    // ⚠️ 只截到**下一个 case 之前** —— 截固定长度会把 `case ZCODE.id:` 的
    // body 一起包进来，于是「不得含 zcode.refreshAccountCredential」恒假失败。
    const nextCase = code.indexOf('case ', idx + 'case TELEAGENT.id:'.length)
    const caseBody = code.slice(idx, nextCase === -1 ? idx + 500 : nextCase)
    expect(caseBody).toContain('teleagent.refreshAccountCredential')
    for (const other of ['minimax.', 'raccoon.', 'zcode.', 'loomy.', 'trae.']) {
      expect(caseBody, other).not.toContain(`${other}refreshAccountCredential`)
    }
  })

  it('★ account.refresh 必须传 pool + entry.id（否则回填静默不生效）', () => {
    const code = stripComments(rpcSource)
    // 同上：锚在 `account.refresh` 之内。
    const idx = code.indexOf('case TELEAGENT.id:', code.indexOf("case 'account.refresh'"))
    expect(idx).toBeGreaterThan(-1)
    const caseBody = code.slice(idx, idx + 500)
    expect(caseBody).toContain('teleagent.refreshAccountCredential(entry.credentialRef, pool, entry.id)')
  })

  it('★ 占位条目 refreshable 必须恒 false（无 refresh 端点）', () => {
    // 写成 true 会让定时器每 30 分钟对一个不可能成功的操作发一轮请求。
    const code = stripComments(rpcSource)
    const block = code.slice(
      code.indexOf('provider === TELEAGENT.id'),
      code.indexOf('provider === ZCODE.id'),
    )
    expect(block).toContain('addAccount({')
    expect(block).toMatch(/refreshable:\s*false/)
    // 且提交走的是扩展动词，登录入口两步式（先返回 loginUrl）
    expect(block).toContain('teleagent.startLogin(id)')
    expect(block).toContain('loginUrl: teleagentStarted.loginUrl')
  })

  it('★ REF_PREFIX_TO_PROVIDER 必须含 teleagent（漏加 ⇒ 账号静默消失）', () => {
    // 同型缺陷已发生 2 次（第二次就是 minimax 合并时漏加）。
    expect(storeSource).toMatch(/\['TELEAGENT',\s*'teleagent'\]/)
  })

  it('★ 三处 provider 顺序对齐（客户端 PROVIDERS / store 表 / RPC 形参）', () => {
    // store 表注释明确要求「顺序与客户端 PROVIDERS 对齐」，
    // RPC 形参顺序又由 index.ts 的实参顺序决定。三处错位会让人逐项核对时对不上。
    const clientIds = [
      ...clientSource.matchAll(/^  \{ id: '([^']+)'/gm),
    ].map((m) => m[1])
    const storeIds = [
      ...storeSource.matchAll(/^\s*\['[A-Z]+',\s*'([a-z]+)'\],/gm),
    ].map((m) => m[1])
    expect(clientIds).toContain('teleagent')
    expect(storeIds).toContain('teleagent')
    // teleagent 在三处都排在 minimax 之后、zcode 之前
    const ci = clientIds.indexOf('teleagent')
    expect(clientIds[ci - 1]).toBe('minimax')
    expect(clientIds[ci + 1]).toBe('zcode')
    const si = storeIds.indexOf('teleagent')
    expect(storeIds[si - 1]).toBe('minimax')
    expect(storeIds[si + 1]).toBe('zcode')
  })

  it('★ 客户端 PROVIDERS 的 label 与产品 displayName 一致（避免两处漂移）', () => {
    const entry = /id: 'teleagent', label: '([^']+)'/.exec(clientSource)
    expect(entry?.[1]).toBe('TeleAgent (电信)')
  })

  it('★ 能力矩阵登记为「余额与签到都有」（用户截图推翻过 false 的结论）', () => {
    // ⚠️ **这里曾是 `false`，是错的** —— 用户 2026-10-07 的客户端截图
    //（积分余额 6100.00 / 每日可领 100 / 已领 2 天 / 累计 200 / 今日已领）
    // 推翻了「asar 里没有可自动调用的领取端点」这个结论。
    // 真端点：`GET /user/portal/companyStore/{userCenter,v2/checkDayTask}`
    // 与 `GET …/checkTask?type=daily_login`（**领取是 GET**）。
    expect(capsSource).toMatch(/teleagent:\s*Object\.freeze\(\{\s*balance:\s*true,\s*dailyCheckin:\s*true\s*\}\)/)
  })

  it('★ 三个积分 RPC 分支齐全，且都用 TELEAGENT.id 分派', () => {
    expect(rpcSource).toContain('fetchTeleagentCheckinStatus(credential)')
    expect(rpcSource).toContain('claimTeleagentDailyCheckin(credential)')
    expect(rpcSource).toContain('fetchTeleagentCreditBalance(credential)')
    // 三处积分 case 内都要有 TELEAGENT.id 判据（account.create / refresh 另有两处）
    const idChecks = rpcSource.match(/req\.provider === TELEAGENT\.id/g) ?? []
    expect(idChecks.length).toBeGreaterThanOrEqual(3)
  })

  it('★ 领取分支必须**开启状态预检**（TeleAgent 的 claim 不返回幂等码）', () => {
    // 与 TRAE 那条教训同因：claim 幂等且无法与「真领取」区分时，
    // 只能靠 status 端点的 `claimed_today` 判「今天已领」。
    //
    // ⚠️ 实现自 2026-10-13 起**不在** `case 'credits.claimAll'` 里：它被抽成
    // 模块级 `claimAllForProvider()`（每日自动签到与 RPC 共用同一份），
    // 故锚点随之搬到那个函数体（见 `jet-hub-rpc-source.ts` 的说明）。
    const code = stripComments(rpcSource)
    const branch = claimAllImplementation(code)
    const telIdx = branch.indexOf('case TELEAGENT.id:')
    expect(telIdx).toBeGreaterThan(-1)
    const telBlock = branch.slice(telIdx, telIdx + 1200)
    expect(telBlock).toContain('fetchStatus')
    expect(telBlock).not.toContain('precheckStatus: false')
  })

  it('★ 客户端有粘贴回调的提交入口（该面板唯一的非全自动登录路径）', () => {
    expect(clientSource).toContain("rpcCall('teleagent.loginSubmitCallback'")
    expect(clientSource).toContain("const TELEAGENT_PANEL_ID = 'teleagent'")
  })

  it('★ 粘贴框指引必须指向 Network（地址栏与 Console 都已被实测证伪）', () => {
    // 这条指引**改过两次、两次都被用户截图证伪**，故正反两向都要钉：
    // ① 「复制地址栏最终那串（…code=…&token=…）」—— 地址栏只有 code（2026-10-07）；
    // ② 「F12 → Console 复制 teleai-cowork:// 那条」—— Console 里也没有：
    //    浏览器不打印跨协议导航，桌面端日志只记 `route: 'auth'` 不记 URL（2026-10-08）。
    // ⇒ 唯一可见处是 Network 面板（Location 响应头 或 换 token 请求的响应体）。
    //
    // ⚠️ 这里**不用** stripComments：那个朴素正则会把字符串字面量里的 `://`
    // 当成行注释起点（`'teleai-cowork://auth?…'` 会被删到行尾）。
    // 改为断言 **createElement 的代码形状** —— 注释里不会出现它，
    // 故既不会被 strip 破坏，也不会被注释假绿。
    const start = clientSource.indexOf('teleagentPending !== null')
    const box = clientSource.slice(start, start + 4000)
    // 必须指向 Network，且带上「保留日志」：授权后页面会跳转，
    // 不勾选就会把那条请求冲掉，指引等于白给。
    expect(box).toContain("React.createElement('strong', null, 'Network')")
    expect(box).toContain('保留日志')
    // 反向：两种已被证伪的旧载体都不得回来
    expect(box).not.toContain("'…/cowork/auth?code=…&token=…'")
    expect(box).not.toContain('Console（或 Network）')
  })

  it('★ 前后端对「只有 code」的指引必须同源一致（避免一处改回另一处仍错）', () => {
    // 后端 reason 与前端提示若各说各话，用户就会在两处拿到矛盾指示 ——
    // 2026-10-08 那次正是「后端已改对、前端还按地址栏写」。
    const parserSource = readFileSync(
      new URL('../../src/teleagent.ts', import.meta.url), 'utf8',
    )
    const start = clientSource.indexOf('teleagentPending !== null')
    const box = clientSource.slice(start, start + 4000)
    const anchor = parserSource.indexOf("url.searchParams.get('code') !== null")
    const reasonBlock = parserSource.slice(anchor, anchor + 1400)
    // 两处都指向 Network、都要求保留日志
    for (const [label, text] of [['后端 reason', reasonBlock], ['前端提示', box]] as const) {
      expect(text, label).toContain('Network')
      expect(text, label).toContain('保留日志')
    }
    // 两处都**不**把 Console 当作取 token 的地方
    expect(reasonBlock).not.toContain('复制控制台里')
  })

  it('★ 不得把「用户粘 code、插件去换 token」当成方案（code 是一次性的）', () => {
    // 2026-10-08 实测：用户浏览器消费过的 code 再打一次，返回与假 code
    // **逐字节相同**的 `{"error":"get token error"}` ⇒ 不存在对我们开放的交换端点。
    // 这条断言锁住该结论，防止将来有人「顺手」去实现 code 交换。
    const parserSource = readFileSync(
      new URL('../../src/teleagent.ts', import.meta.url), 'utf8',
    )
    expect(parserSource).toContain('code 是一次性的')
    // 且解析器**没有**任何拿 code 发请求的分支（只认 token）
    expect(parserSource).not.toMatch(/code2token|exchangeCode|code_to_token/i)
  })

  it('★ 浏览器自动登录：两个动词齐全且**不阻塞 RPC**', () => {
    // 用户要在弹出的窗口里输手机号 + 验证码（几十秒到几分钟）。
    // 阻塞这个 RPC 会撞上传输层超时，前端显示「请求失败」而后台仍在跑。
    const code = stripComments(rpcSource)
    expect(code).toContain("case 'teleagent.loginWithBrowser'")
    expect(code).toContain("case 'teleagent.loginBrowserStatus'")
    const start = code.indexOf("case 'teleagent.loginWithBrowser'")
    const body = code.slice(start, code.indexOf("case 'teleagent.loginBrowserStatus'", start))
    // fire-and-forget：`void` 起后台任务 + 立刻返回 started
    expect(body).toMatch(/void teleagent\.loginWithBrowser\(/)
    expect(body).toContain('started: true')
  })

  it('★ 自动登录失败**不得**删占位条目（粘贴是退路）', () => {
    // 自动登录可能因为「没装浏览器 / 窗口被关 / 安全软件拦调试端口」失败。
    // 删掉条目等于把用户唯一的退路也拿走 —— 那正是 2026-10-07 记过的老缺陷。
    const code = stripComments(rpcSource)
    const start = code.indexOf("case 'teleagent.loginWithBrowser'")
    const body = code.slice(start, code.indexOf("case 'teleagent.loginBrowserStatus'", start))
    expect(body).not.toContain('removeAccount')
    // 且失败原因要按分类落到状态表里，供前端给不同提示
    expect(body).toContain('TeleagentBrowserLoginError')
    expect(body).toMatch(/phase:\s*'failed'/)
  })

  it('★ 自动登录必须复用 submitLogin 落盘（两条路径的凭据形状不能漂移）', () => {
    // submitLogin 已承载「验证 user_info → 落盘 → 回填昵称/有效期 →
    // 拆超时定时器」整条链（2026-10-08 刚修）。自动登录另写一份，
    // 就会有两套凭据形状 —— 那是最贵的一类缺陷。
    const authSource = readFileSync(
      new URL('../../src/teleagent-auth.ts', import.meta.url), 'utf8',
    )
    const code = stripComments(authSource)
    const start = code.indexOf('async loginWithBrowser(')
    const body = code.slice(start, start + 1800)
    expect(body).toContain('launchAndCaptureToken(')
    expect(body).toContain('this.submitLogin(')
    // 反向：不得绕过 submitLogin 自己写凭据
    expect(body).not.toContain('credentials.set')
  })

  it('★ 自动登录的 token 取舍交给服务端，不靠形态猜测', () => {
    // 探针实测登录链路上有两个合法 JWT（UPMS refreshToken 与 superCowork token），
    // 按「第一个」选会选错 ⇒ verify 必须真打 user_info。
    const authSource = readFileSync(
      new URL('../../src/teleagent-auth.ts', import.meta.url), 'utf8',
    )
    const code = stripComments(authSource)
    const body = code.slice(code.indexOf('async loginWithBrowser('), code.indexOf('async loginWithBrowser(') + 1800)
    expect(body).toContain('this.fetchUserInfo(')
  })

  it('★ 前端有自动登录入口，且失败时不收起粘贴框', () => {
    const code = stripComments(clientSource)
    expect(code).toContain("rpcCall('teleagent.loginWithBrowser'")
    expect(code).toContain("rpcCall('teleagent.loginBrowserStatus'")
    const start = code.indexOf('const startTeleagentBrowserLogin')
    const body = code.slice(start, code.indexOf('const cancelTeleagentLogin', start))
    // 失败分支只记提示，**不**调 setTeleagentPending(null)（那是收框）
    const failedAt = body.indexOf("status.phase === 'failed'")
    expect(failedAt).toBeGreaterThan(-1)
    expect(body.slice(failedAt, failedAt + 600)).not.toContain('setTeleagentPending(null)')
    // 成功分支才收框
    const doneAt = body.indexOf("status.phase === 'done'")
    expect(body.slice(doneAt, failedAt)).toContain('setTeleagentPending(null)')
  })
})
