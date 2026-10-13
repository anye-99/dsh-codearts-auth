import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { credentialIsPresent } from '../../src/jet-hub-rpc.js'
import { pickTeleagentPendingAccountId } from '../../plugin-src/client/teleagent-login-restore.js'

/**
 * 「凭据到底在不在」这一事实的贯通测试（后端判据 + 前端消费）。
 *
 * ## 对应的真实缺陷（2026-10-07 用户截图）
 *
 * TeleAgent 面板里一条账号显示绿色「已启用」、凭据行写着
 * `TELEAGENT_ACCOUNT_DF47FE74`，而积分/签到一律报「凭据未配置」，
 * 顶部还挂着「1 个失败」。核对本地存储：账号池里**确实**有这条占位条目
 * （`account.create` 先建条目、凭据要等登录成功才写），但 `.credentials.yaml`
 * 里**根本没有** `TELEAGENT_ACCOUNT_DF47FE74`。
 *
 * 根因不是数据坏了，而是**入口丢了**：TeleAgent 是唯一需要用户手动粘贴
 * 回调 URL 的面板，而那个粘贴框只由组件内存 state 控制，面板在切换 provider
 * 时会被强制重新挂载 —— 用户一离开就再也回不到「粘贴」那一步，
 * 只能对着一个假「已启用」的账号干瞪眼。
 *
 * ## 为什么这两半放在一起测
 *
 * 修复是「后端如实回答凭据在不在 + 前端据此恢复入口」。任一半单独看都对、
 * 拼起来却失效的形态很具体：后端字段名改了、前端判据写成 `!x`、
 * 或者前端压根没调用 —— 所以这里既测两个纯函数，也钉死两处接线。
 */

/** 造一个 resolve 桩：按 ref 名查表，查不到返回 undefined。 */
function resolver(table: Record<string, string | undefined>) {
  return async (ref: ReturnType<typeof credentialRef>) => {
    const raw = ref as unknown as string
    const value = table[raw]
    return value === undefined ? undefined : { value }
  }
}

describe('credentialIsPresent：凭据存在性判据', () => {
  it('解析到有内容的凭据 ⇒ true', async () => {
    const got = await credentialIsPresent(
      resolver({ TELEAGENT_ACCOUNT_A1: '{"token":"x"}' }),
      'TELEAGENT_ACCOUNT_A1',
    )
    expect(got).toBe(true)
  })

  it('解析不到（undefined / null）⇒ false —— 这就是占位条目的形态', async () => {
    expect(await credentialIsPresent(resolver({}), 'TELEAGENT_ACCOUNT_A1')).toBe(false)
    expect(
      await credentialIsPresent(
        async () => null as unknown as undefined,
        'TELEAGENT_ACCOUNT_A1',
      ),
    ).toBe(false)
  })

  it('⚠️ 解析到值但值是空串 / 纯空白 ⇒ false', async () => {
    // 这是**必须**的严格性：空串凭据在下游（各 *-auth.ts 的 resolveCredential）
    // 一律抛「凭据未配置」。若这里判 true，前端就不会恢复粘贴入口，
    // 等于把缺陷原样留在下游。
    expect(await credentialIsPresent(resolver({ A: '' }), 'A')).toBe(false)
    expect(await credentialIsPresent(resolver({ A: '   ' }), 'A')).toBe(false)
    expect(await credentialIsPresent(resolver({ A: '\n\t ' }), 'A')).toBe(false)
    // 对照：有内容的值才 true（证明不是「一律 false」的同义反复）
    expect(await credentialIsPresent(resolver({ A: 'x' }), 'A')).toBe(true)
  })

  it('resolve 抛错 ⇒ false 且不冒泡（一个账号不能拖垮整个列表接口）', async () => {
    const boom = async () => {
      throw new Error('keychain unavailable')
    }
    await expect(credentialIsPresent(boom, 'A')).resolves.toBe(false)
  })

  it('ref 名不合法（credentialRef 会抛 TypeError）⇒ false', async () => {
    // 池里可能残留被手工改坏的 ref；语义上就是「读不到」，不该让列表失败。
    await expect(
      credentialIsPresent(resolver({}), 'not a valid ref!'),
    ).resolves.toBe(false)
  })

  it('★ 传给 resolve 的是 credentialRef() 包装后的 ref（漏包装会读不到）', async () => {
    const seen: unknown[] = []
    await credentialIsPresent(async (ref) => {
      seen.push(ref)
      return { value: 'x' }
    }, 'TELEAGENT_ACCOUNT_A1')
    expect(seen).toHaveLength(1)
    // 品牌字符串的**值**必须就是 ref 名；断言它没被传成裸 string 之外的别的形状。
    expect(seen[0]).toBe('TELEAGENT_ACCOUNT_A1')
  })
})

describe('pickTeleagentPendingAccountId：粘贴入口的可恢复判定', () => {
  const waiting = { id: 'teleagent-aaa', enabled: true, credentialPresent: false, createdAt: 100 }

  it('有一条「启用但凭据没写」的账号 ⇒ 恢复粘贴框（本缺陷的正解）', () => {
    expect(pickTeleagentPendingAccountId([waiting], null)).toBe('teleagent-aaa')
  })

  it('凭据齐备的账号 ⇒ 不弹框', () => {
    expect(
      pickTeleagentPendingAccountId(
        [{ ...waiting, credentialPresent: true }],
        null,
      ),
    ).toBeNull()
  })

  it('⚠️ credentialPresent 为 undefined（非凭据型条目）⇒ 不弹框', () => {
    // 判据必须是严格 `=== false`。写成 `!credentialPresent` 会让 antigravity
    // 那种「压根不需要登录」的面板也弹出粘贴框 —— 那是新造的缺陷。
    expect(
      pickTeleagentPendingAccountId(
        [{ id: 'agy-1', enabled: true, createdAt: 1 }],
        null,
      ),
    ).toBeNull()
  })

  it('已停用的无凭据条目 ⇒ 不弹框（历史垃圾不该要用户去登录）', () => {
    expect(
      pickTeleagentPendingAccountId([{ ...waiting, enabled: false }], null),
    ).toBeNull()
  })

  it('多条未完成 ⇒ 取 createdAt 最新的那条', () => {
    const list = [
      { id: 'teleagent-old', enabled: true, credentialPresent: false, createdAt: 100 },
      { id: 'teleagent-new', enabled: true, credentialPresent: false, createdAt: 900 },
      { id: 'teleagent-mid', enabled: true, credentialPresent: false, createdAt: 500 },
    ]
    expect(pickTeleagentPendingAccountId(list, null)).toBe('teleagent-new')
  })

  it('已有挂起的账号且仍未完成 ⇒ 保持不变（不打断正在输入的用户）', () => {
    expect(pickTeleagentPendingAccountId([waiting], 'teleagent-aaa')).toBe('teleagent-aaa')
    // 挂起的不是最新那条，也要保持原样，不能被"更新的一条"抢走
    const list = [waiting, { ...waiting, id: 'teleagent-bbb', createdAt: 999 }]
    expect(pickTeleagentPendingAccountId(list, 'teleagent-aaa')).toBe('teleagent-aaa')
  })

  it('挂起的账号已完成或被删除 ⇒ 收起（否则提交只会收到「账号不存在」）', () => {
    expect(pickTeleagentPendingAccountId([{ ...waiting, credentialPresent: true }], 'teleagent-aaa')).toBeNull()
    expect(pickTeleagentPendingAccountId([], 'teleagent-aaa')).toBeNull()
    // 收起后仍能挑出别的未完成账号吗？不能 —— 保持"要么原样要么空"的语义，
    // 避免用户眼前的框在一次刷新里悄悄换成另一个账号。
    expect(pickTeleagentPendingAccountId([{ ...waiting, id: 'teleagent-bbb' }], 'teleagent-aaa')).toBeNull()
  })

  it('入参不是数组 / 为空 ⇒ null（不抛错）', () => {
    expect(pickTeleagentPendingAccountId(null, null)).toBeNull()
    expect(pickTeleagentPendingAccountId(undefined as unknown as [], null)).toBeNull()
    expect(pickTeleagentPendingAccountId([], null)).toBeNull()
  })

  it('空串 currentPending 视为「没有挂起」，正常挑账号', () => {
    expect(pickTeleagentPendingAccountId([waiting], '')).toBe('teleagent-aaa')
  })
})

describe('★ 接线：两端都真的接上了', () => {
  const rpcSource = readFileSync(new URL('../../src/jet-hub-rpc.ts', import.meta.url), 'utf8')
  const clientSource = readFileSync(
    new URL('../../plugin-src/client/jet-hub.js', import.meta.url), 'utf8',
  )
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

  it('后端 account.list 用 credentialIsPresent 补字段（不是只返回池条目）', () => {
    const code = stripComments(rpcSource)
    const start = code.indexOf("case 'account.list'")
    const body = code.slice(start, code.indexOf("case 'account.create'", start))
    // ⚠️ 只看**凭据型**那条路径：antigravity 分支原样返回 accounts 是**正确的**
    // （非凭据型面板没有「存在性」可判，硬塞字段反而会让前端误判成待登录）。
    // 第一版把反向断言打在整段上，被 agy 分支正常命中而误报失败。
    const credentialed = body.slice(body.indexOf('pool.listAccounts('))
    expect(credentialed).toContain('credentialIsPresent')
    expect(credentialed).toContain('credentialPresent')
    // 反向：不得再把池条目原样返回（那等于字段没接）
    expect(credentialed).not.toMatch(/value:\s*\{\s*accounts\s*\}/)
    // 且 agy 分支**不带**该字段
    const agyBranch = body.slice(0, body.indexOf('pool.listAccounts('))
    expect(agyBranch).not.toContain('credentialPresent')
  })

  it('前端 loadAccounts 调用纯函数且只在 teleagent 面板调用', () => {
    const code = stripComments(clientSource)
    expect(code).toContain("from './teleagent-login-restore.js'")
    const start = code.indexOf('const loadAccounts =')
    const body = code.slice(start, code.indexOf('/**', start + 60))
    expect(body).toContain('pickTeleagentPendingAccountId')
    expect(body).toContain('provider === TELEAGENT_PANEL_ID')
  })

  it('★ 取消登录必须真的删除占位条目（只收框会被下次刷新再弹出来）', () => {
    // 这是本次修复**自己会引入**的新缺陷：粘贴框现在会从「无凭据条目」自动恢复，
    // 若「取消」只把 state 置 null，下一次 loadAccounts 就又弹出来，永远关不掉。
    const code = stripComments(clientSource)
    const start = code.indexOf('const cancelTeleagentLogin')
    const body = code.slice(start, code.indexOf('};', start))
    expect(body).toContain("rpcCall('account.delete'")
  })

  it('粘贴框渲染仍受 teleagentPending 控制（恢复逻辑的落点没被改坏）', () => {
    const code = stripComments(clientSource)
    expect(code).toMatch(/teleagentPending\s*!==\s*null/)
    expect(code).toContain('teleagent.loginSubmitCallback')
  })

  it('★ 后端给 TeleAgent 的**待登录**条目带 loginUrl（否则提示指向空气）', () => {
    // 粘贴框能从「条目在、凭据不在」的账号自动恢复，而那一刻登录窗口早关了；
    // 框里叫用户「重新走一次授权」却没有任何链接可点 —— 登录页地址此前只在
    // account.create 的一次性响应里给过。故随列表下发（它是产品常量，不含凭据）。
    const code = stripComments(rpcSource)
    const start = code.indexOf("case 'account.list'")
    const body = code.slice(start, code.indexOf("case 'account.create'", start))
    const credentialed = body.slice(body.indexOf('pool.listAccounts('))
    expect(credentialed).toContain('loginUrl: teleagent.loginPageUrl()')
    // 且**只**给待登录那条（已登录的账号不需要登录页，带上会让前端误判）
    expect(credentialed).toContain('req.provider === TELEAGENT.id')
    expect(credentialed).toMatch(/present\s*===\s*false/)
  })

  it('★ 前端从列表条目取 loginUrl（不复用只在弹窗被拦截时赋值的 loginUrlForManual）', () => {
    const code = stripComments(clientSource)
    expect(code).toContain('teleagentLoginPage')
    // 取值必须按 accountId 从 accounts 里找，而不是读 loginUrlForManual
    const start = code.indexOf('const teleagentLoginPage')
    const body = code.slice(start, start + 300)
    expect(body).toContain('.loginUrl')
    expect(body).not.toContain('loginUrlForManual')
  })

  it('★ 提交失败也要刷新列表（否则框永久挂在被超时删掉的账号上）', () => {
    // 真实症状：用户「点了没反应」。条目已被 startLogin 的超时器删掉
    //（account.create 的 .catch() 会 removeAccount），而粘贴框只由内存 state
    // 控制、不知道条目没了 ⇒ 每次提交都只得到「账号不存在」，框永不消失，
    // 只能重开设置页。刷新后 pickTeleagentPendingAccountId 会发现它不在
    // 等待集合 ⇒ 自动收框；条目若还在（只是 token 无效）则保持原样可继续重试。
    const code = stripComments(clientSource)
    const start = code.indexOf('const submitTeleagentCallback')
    const body = code.slice(start, code.indexOf('const cancelTeleagentLogin', start))
    const elseBranch = body.slice(body.indexOf('} else {'))
    expect(elseBranch).toContain('setTeleagentError(message)')
    expect(elseBranch).toMatch(/setTeleagentError\(message\)[\s\S]{0,300}await loadAccounts\(\)/)
    // 收框后错误没了渲染位置 ⇒ 必须冒泡到面板顶部
    expect(elseBranch).toMatch(/setError\(message\)/)
  })
})

describe('★ 接线：登录成功后必须连积分行一起刷新', () => {
  const clientSource = readFileSync(
    new URL('../../plugin-src/client/jet-hub.js', import.meta.url), 'utf8',
  )
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const code = stripComments(clientSource)

  /**
   * 「登录成功」共有三条落定路径，它们都只调 `loadAccounts()` 就会复现
   * 用户 2026-10-09 的截图：昵称与有效期当场变对（来自 account.list），
   * 积分那一行却还停在「凭据未配置」—— 那是面板**挂载时**那次
   * `credits.balances` 留下的答案，而那一刻凭据还没写进去。
   *
   * 逐条列出来而不是只测一条：漏掉任意一条，那条路径上的用户就会继续
   * 看到假「未配置」（这正是本仓库记过的「修了一半」形态）。
   */
  const sites: Array<[string, string, string]> = [
    ['login.poll（全部 provider 共用）', 'if (pollRes.done)', '}, 1000);'],
    ['teleagent 粘贴提交', "rpcCall('teleagent.loginSubmitCallback'", '} else {'],
    ['teleagent 受控浏览器自动登录', "if (status.phase === 'done')", "if (status.phase === 'failed')"],
  ]

  for (const [label, open, close] of sites) {
    it(`${label}：成功分支里 loadAccounts 之后必须再调 loadCredits`, () => {
      const start = code.indexOf(open)
      expect(start, `找不到代码片段：${open}`).toBeGreaterThan(-1)
      const end = code.indexOf(close, start)
      expect(end, `找不到片段结束锚点：${close}`).toBeGreaterThan(start)
      const body = code.slice(start, end)

      expect(body).toContain('await loadAccounts()')
      // 顺序也要钉：反过来写会先查一次「还没有凭据」的余额，等于没修。
      expect(body).toMatch(/await loadAccounts\(\)[\s\S]{0,400}loadCredits\(\)/)
    })
  }

  it('loadCredits 自带能力门控（不支持余额的 provider 不会因此多发请求）', () => {
    const start = code.indexOf('const loadCredits =')
    const body = code.slice(start, code.indexOf('}, [provider, rpcCall', start))
    expect(body).toMatch(/if \(!canLoadCredits\) return/)
  })
})
