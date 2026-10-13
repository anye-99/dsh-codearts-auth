import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  generateTeleagentDeviceId,
  isTeleagentExpired,
  isTeleagentRefreshable,
  normalizeTeleagentModel,
  parseTeleagentCallbackInput,
  parseTeleagentCredential,
  teleagentCredentialExpiresAtMs,
  teleagentFallbackEntries,
  teleagentHeaders,
  teleagentIdentityHeaders,
  teleagentInferHeaders,
  teleagentSignHeaders,
  type TeleagentCredential,
} from '../../src/teleagent.js'
// ⚠️ 这两个在 `teleagent-auth.ts`（它们要读凭据/构造昵称，属服务层而非纯协议层）
import { parseTeleagentUserInfo, teleagentDisplayNickname } from '../../src/teleagent-auth.js'
import { TELEAGENT } from '../../src/teleagent-product.js'

/**
 * TeleAgent 协议层的回归测试。
 *
 * ## 这里守的是什么
 *
 * 全部取证来自逆向官方安装包（2.5.3 本机 asar + 2.7.0-rc.1 官方包，
 * 两路交叉印证，见 docs/teleagent-protocol-notes.md）。
 * 其中**三件事最容易被后人改错**，且改错的症状都不是「立刻报错」
 * 而是「静默失效 / 看起来像服务端坏了」：
 *
 * 1. **两个凭据在两个不同的头上**（用户 token 走 `X-Token`，
 *    `Authorization: Bearer` 放内置渠道 apiKey）。合并成一个头 ⇒ 401，
 *    而 401 会被归成 AUTH 并触发一次无谓的「续期」（本 provider 根本没有续期）。
 * 2. **`X-SuperAgent-Timestamp` 是秒级**。写成毫秒会被判时间戳越界。
 * 3. **无过期时间 ⇒ 必须保守判「未过期」**。若把 `undefined` 当成已过期，
 *    每次发消息都会先触发一次必然无效的续期。
 */

const cred = (over: Partial<TeleagentCredential> = {}): TeleagentCredential => ({
  token: 'USER-TOKEN-abc',
  ...over,
})

describe('身份头：两个凭据在两个头上', () => {
  it('推理头 Authorization 放的是内置渠道 apiKey，**不是**用户 token', () => {
    const headers = teleagentInferHeaders(cred())
    expect(headers.get('Authorization')).toBe(`Bearer ${TELEAGENT.inferApiKey}`)
    // 反向：用户 token 绝不能出现在 Authorization 里（那样会 401）。
    expect(headers.get('Authorization')).not.toContain('USER-TOKEN-abc')
  })

  it('推理头 X-Token 放的才是用户 token', () => {
    expect(teleagentInferHeaders(cred()).get('X-Token')).toBe('USER-TOKEN-abc')
  })

  it('推理头声明 SSE（请求体带 stream:true）', () => {
    const headers = teleagentInferHeaders(cred())
    expect(headers.get('Accept')).toBe('text/event-stream')
    expect(headers.get('Content-Type')).toBe('application/json')
  })

  it('业务头**不带** Authorization（业务端点只认 X-Token）', () => {
    // 加一个 `Authorization: Bearer <用户 token>` 是猜测，
    // 且可能让网关按 Bearer 分支去校验一个根本不是 Bearer 凭据的值。
    expect(teleagentHeaders(cred()).get('Authorization')).toBeNull()
    expect(teleagentHeaders(cred()).get('X-Token')).toBe('USER-TOKEN-abc')
  })

  it('X-SuperAgent-Timestamp 是**秒级**（不是毫秒）', () => {
    const headers = teleagentIdentityHeaders(cred(), TELEAGENT, 1_700_000_000, 'nonce-1')
    expect(headers['X-SuperAgent-Timestamp']).toBe('1700000000')
    expect(headers['X-SuperAgent-Nonce']).toBe('nonce-1')
  })

  it('默认时间戳取当前秒（与毫秒量级区分）', () => {
    const before = Math.floor(Date.now() / 1000)
    const value = Number(teleagentIdentityHeaders(cred())['X-SuperAgent-Timestamp'])
    expect(value).toBeGreaterThanOrEqual(before)
    expect(value).toBeLessThan(Date.now()) // 若误写毫秒，这个断言必假
  })

  it('路由目标头恒发（缺了会被路由到错误网关）', () => {
    expect(teleagentIdentityHeaders(cred())['X-Route-Target']).toBe('ops-gateway')
  })

  it('device_id / install_id 缺失时**不产出该键**（不发明值）', () => {
    const headers = teleagentIdentityHeaders(cred())
    expect('X-SuperAgent-Device-Id' in headers).toBe(false)
    expect('X-SuperAgent-Install-Id' in headers).toBe(false)
    const withIds = teleagentIdentityHeaders(cred({ device_id: 'd1', install_id: 'i1' }))
    expect(withIds['X-SuperAgent-Device-Id']).toBe('d1')
    expect(withIds['X-SuperAgent-Install-Id']).toBe('i1')
  })
})

describe('过期与续期：无过期信息必须保守判未过期', () => {
  it('无 expires_at ⇒ undefined（token 不是 JWT，解不出过期时间）', () => {
    expect(teleagentCredentialExpiresAtMs(cred())).toBeUndefined()
  })

  it('无过期信息 ⇒ **不判过期**（否则会触发必然无效的续期）', () => {
    expect(isTeleagentExpired(cred())).toBe(false)
  })

  it('已过期 ⇒ true', () => {
    expect(isTeleagentExpired(cred({ expires_at: String(Date.now() - 1000) }))).toBe(true)
  })

  it('秒级与毫秒级都接受（> 1e12 视为毫秒）', () => {
    const futureSec = Math.floor(Date.now() / 1000) + 3600
    expect(teleagentCredentialExpiresAtMs(cred({ expires_at: String(futureSec) })))
      .toBe(futureSec * 1000)
    const futureMs = Date.now() + 3_600_000
    expect(teleagentCredentialExpiresAtMs(cred({ expires_at: String(futureMs) })))
      .toBe(futureMs)
  })

  it('非纯数字串一律视为非法（`Number(" 123 ")` 会静默变 123、`""` 会变 0）', () => {
    for (const bad of ['', ' 123 ', '1e12', '123abc', '-5', '0']) {
      expect(teleagentCredentialExpiresAtMs(cred({ expires_at: bad })), bad).toBeUndefined()
    }
  })

  it('★ isTeleagentRefreshable 恒 false（asar 无 refresh_token / ExchangeToken）', () => {
    // 改成 true 会让定时器每 30 分钟对一个不可能成功的操作发一轮请求。
    expect(isTeleagentRefreshable(cred())).toBe(false)
    expect(isTeleagentRefreshable(cred({ expires_at: '99999999999999' } as Partial<TeleagentCredential>)))
      .toBe(false)
  })
})

describe('登录产物解析：三种粘贴形态都要认', () => {
  it('形态一：回调页 URL（带 code 与 token）⇒ 取 token', () => {
    const r = parseTeleagentCallbackInput(
      'https://agent.teleai.com.cn/superCowork/sapi/cowork/auth?code=C123&token=T456',
    )
    expect(r).toEqual({ token: 'T456' })
  })

  it('形态二：deeplink（2.7.0 的 teleai-cowork://）⇒ 取 token', () => {
    expect(parseTeleagentCallbackInput('teleai-cowork://auth?token=T789'))
      .toEqual({ token: 'T789' })
  })

  it('形态三：裸 token ⇒ 整串当 token', () => {
    expect(parseTeleagentCallbackInput('eyJhbGciOi.raw-token')).toEqual({ token: 'eyJhbGciOi.raw-token' })
  })

  it('★ 只有 code 没有 token ⇒ 报**走得通**的原因（指向 Network，不是地址栏也不是 Console）', () => {
    const r = parseTeleagentCallbackInput('https://x/cowork/auth?code=ONLY')
    expect('reason' in r).toBe(true)
    if ('reason' in r) {
      // 必须给出可操作的指向：**只有 Network 面板**能看到那一跳里的 token。
      expect(r.reason).toContain('Network')
      // 且必须要求「保留日志」：授权后页面会跳转，不勾选会把那条请求冲掉。
      expect(r.reason).toContain('保留日志')
      // ⚠️ 反向锁死**两代**错误指示 —— 它们都被用户截图证伪过，不得改回：
      // ① 2026-10-07「去地址栏复制含 token= 的完整 URL」—— 那一跳只有 code，
      //    地址栏永远没有 token=，正是它让用户反复粘贴失败；
      // ② 2026-10-08「F12 → Console 复制 teleai-cowork:// 那条」—— Console 里
      //    也没有：浏览器不打印跨协议导航，桌面端日志只记 `route: 'auth'` 不记 URL。
      expect(r.reason).not.toMatch(/地址栏.*(应含|包含).*token=/)
      expect(r.reason).not.toContain('复制控制台里')
    }
  })

  it('hash 片段里的 token 也认（部分部署用 #/callback?token=）', () => {
    expect(parseTeleagentCallbackInput('https://x/page#/callback?token=HASH1'))
      .toEqual({ token: 'HASH1' })
  })

  it('带空白的非 URL 文本判为误粘（裸 token 判据是「不含空白」）', () => {
    const r = parseTeleagentCallbackInput('这是我的 token 是 abc')
    expect('reason' in r).toBe(true)
  })

  it('空输入 / 纯空白 ⇒ 有原因而非抛错', () => {
    for (const bad of ['', '   ']) {
      const r = parseTeleagentCallbackInput(bad)
      expect('reason' in r, JSON.stringify(bad)).toBe(true)
    }
  })

  it('URL 解析失败不抛错，回原因', () => {
    const r = parseTeleagentCallbackInput('https://[bad url')
    expect('reason' in r).toBe(true)
  })
})

describe('user_info 解析与展示名', () => {
  it('套信封（data 下）与平铺两种形状都认', () => {
    const flat = { accountId: 'A1', accountName: '张三', phone: '13800001111' }
    expect(parseTeleagentUserInfo(flat)?.accountId).toBe('A1')
    expect(parseTeleagentUserInfo({ code: 0, data: flat })?.accountId).toBe('A1')
  })

  it('★ 拿不到 accountId ⇒ undefined（不编造）——它是多账号去重的唯一稳定判据', () => {
    expect(parseTeleagentUserInfo({ accountName: 'x' })).toBeUndefined()
    expect(parseTeleagentUserInfo(null)).toBeUndefined()
    expect(parseTeleagentUserInfo([])).toBeUndefined()
  })

  it('昵称优先级：手机号尾号 > accountName > accountId 尾 6 位', () => {
    expect(teleagentDisplayNickname({ phone: '13800001111', accountName: '张三', accountId: 'A1' }))
      .toBe('TeleAgent 1111')
    expect(teleagentDisplayNickname({ accountName: '张三', accountId: 'A1' })).toBe('TeleAgent 张三')
    // 'abcdef123456' 共 12 字符，尾 6 位是 '123456'
    expect(teleagentDisplayNickname({ accountId: 'abcdef123456' })).toBe('TeleAgent 123456')
  })

  it('手机号过短（不足 4 位）不拿来当昵称', () => {
    expect(teleagentDisplayNickname({ phone: '12', accountName: '李四', accountId: 'A1' }))
      .toBe('TeleAgent 李四')
  })
})

describe('凭据 JSON 解析', () => {
  it('要求 token 非空（空串/缺失/非字符串都判无效）', () => {
    expect(parseTeleagentCredential('{"token":"x"}')?.token).toBe('x')
    for (const bad of ['{}', '{"token":""}', '{"token":"   "}', '{"token":123}', 'not json', '[]', 'null']) {
      expect(parseTeleagentCredential(bad), bad).toBeUndefined()
    }
  })
})

describe('模型目录', () => {
  it('兜底表三条（chat-nano / chat-lite / chat-pro），窗口取 asar KG 的 1e5', () => {
    const entries = teleagentFallbackEntries()
    expect(entries.map((e) => e.id)).toEqual(['chat-nano', 'chat-lite', 'chat-pro'])
    for (const entry of entries) {
      expect(entry.contextWindow).toBe(100_000)
      expect(entry.maxTokens).toBe(16_384)
      // ⚠️ 恒 false 是「未实测」的保守取值，不是「实测不支持」。
      expect(entry.supportsImage).toBe(false)
    }
  })

  it('归一远端条目：limit.context / contextWindow 两种形态都认', () => {
    expect(normalizeTeleagentModel({ id: 'm1', limit: { context: 200_000, output: 8000 } }))
      .toEqual({ id: 'm1', name: 'm1', contextWindow: 200_000, maxTokens: 8000, supportsImage: false })
    expect(normalizeTeleagentModel({ id: 'm2', contextWindow: 50_000 })?.contextWindow).toBe(50_000)
  })

  it('非法窗口/输出不产出（0 是「未知」哨兵；maxTokens 非法时整个键不发）', () => {
    const entry = normalizeTeleagentModel({ id: 'm3', limit: { context: 0, output: -1 } })
    expect(entry?.contextWindow).toBe(0)
    expect('maxTokens' in (entry ?? {})).toBe(false)
  })

  it('无 id ⇒ undefined（不编造 id）', () => {
    expect(normalizeTeleagentModel({ name: 'x' })).toBeUndefined()
    expect(normalizeTeleagentModel(null)).toBeUndefined()
    expect(normalizeTeleagentModel('str')).toBeUndefined()
  })

  it('modalities.input 含 image 才声明支持图片', () => {
    expect(normalizeTeleagentModel({ id: 'v', modalities: { input: ['text', 'image'] } })?.supportsImage)
      .toBe(true)
    expect(normalizeTeleagentModel({ id: 'v', modalities: { input: ['text'] } })?.supportsImage)
      .toBe(false)
  })
})

describe('过期时间：优先 expires_at，回退解 JWT exp', () => {
  /** 造一个带 tenant 前缀的真实形态 token（实测：`Em9xR4:eyJ….<sig>`）。 */
  const makeToken = (exp: number, tenant = 'Em9xR4'): string => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({
      exp, nbf: exp - 2_500_000, iat: exp - 2_500_000,
      accountId: '2097338932289392640', accountName: 'qhoUW1', tenant, certType: '0',
    })).toString('base64url')
    return `${tenant}:${header}.${payload}.fakesignature`
  }

  it('★ JWT 的 exp 可解 —— 且必须**先剥掉 tenant 前缀**（`Em9xR4:eyJ…`）', () => {
    // ⚠️ 实测 token 形如 `Em9xR4:eyJhbGci….fakesig`：首段是 tenant + 冒号。
    // 直接 `split('.')` 取第 2 段会**取错**（首段含冒号仍能 split 出 3 段，
    // 但 payload 位置对；真正的坑是若 token 里冒号前缀含点号就会全错）。
    // 故实现里显式剥前缀，这里锁住该行为。
    const exp = Math.floor(Date.now() / 1000) + 86_400
    const ms = teleagentCredentialExpiresAtMs({ token: makeToken(exp) })
    expect(ms).toBe(exp * 1000)
  })

  it('★ 无前缀的纯 JWT 也能解（兼容上游去掉 tenant 前缀）', () => {
    const exp = Math.floor(Date.now() / 1000) + 86_400
    const header = Buffer.from('{}').toString('base64url')
    const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url')
    expect(teleagentCredentialExpiresAtMs({ token: `${header}.${payload}.sig` })).toBe(exp * 1000)
  })

  it('★ expires_at 优先于 JWT（显式写入的值更权威）', () => {
    const exp = Math.floor(Date.now() / 1000) + 86_400
    const explicit = Date.now() + 3_600_000
    expect(teleagentCredentialExpiresAtMs({
      token: makeToken(exp), expires_at: String(explicit),
    })).toBe(explicit)
  })

  it('非 JWT 且无 expires_at ⇒ undefined（保守：不编造有效期）', () => {
    expect(teleagentCredentialExpiresAtMs({ token: 'not-a-jwt' })).toBeUndefined()
    expect(teleagentCredentialExpiresAtMs({ token: 'a.b' })).toBeUndefined()
  })

  it('JWT 解出的过期时间能正确判过期', () => {
    const past = Math.floor(Date.now() / 1000) - 60
    expect(isTeleagentExpired({ token: makeToken(past) })).toBe(true)
    const future = Math.floor(Date.now() / 1000) + 60
    expect(isTeleagentExpired({ token: makeToken(future) })).toBe(false)
  })

  it('base64url 段损坏 ⇒ undefined（不抛错）', () => {
    expect(teleagentCredentialExpiresAtMs({ token: 'Em9xR4:aaa.!!!.ccc' })).toBeUndefined()
  })
})

describe('登录入口：必须用 UPMS 授权 URL（不能是那个空壳页）', () => {
  it('★ loginPage 是 UPMS authorize（带 client_id 与预编码 redirect_uri）', () => {
    // ⚠️⚠️ **真实缺陷**（2026-10-07 用户报障「卡在这里了」+ 白屏截图）：
    // 初版用 `https://agent.teleai.com.cn/meter/teleagent-login/login`，
    // 实测那是 **511 字节的空 SPA 壳**（`<div id="root"></div>` + 一个 JS），
    // 直接打开**白屏** —— 它需要 `?tokenCode=` 之类的内部参数才渲染，
    // 是官方客户端 iframe 专用地址。
    // 真正的入口是 UPMS 统一认证（302 → `/master-auth`，1508 字节真实登录页）。
    expect(TELEAGENT.loginPage).toContain('www.teleai.com.cn/teleai-api/upms/public/auth/authorize')
    expect(TELEAGENT.loginPage).toContain('client_id=Z2veLLEHhZfq3hb5hWIwqJuPajIuasYi')
    // ⚠️ redirect_uri 必须**预编码**，否则 302 会把参数截断
    expect(TELEAGENT.loginPage).toContain('redirect_uri=https%3A%2F%2F')
    // 反向：绝不能是那个白屏空壳
    expect(TELEAGENT.loginPage).not.toContain('meter/teleagent-login/login')
  })
})

describe('deviceId 生成', () => {
  it('★ **12 位 hex**（实测客户端 device-meta.json 的形态），且每次不同', () => {
    // ⚠️ 第一版按 TRAE 的惯性写成 32 位 hex —— **那是错的**：
    // 官方客户端 `~/.local/share/TeleAgent/app-auth/device-meta.json` 里是
    // `"deviceId": "e88088715b6f"`，**12 个 hex 字符**。
    const a = generateTeleagentDeviceId()
    const b = generateTeleagentDeviceId()
    expect(a).toMatch(/^[0-9a-f]{12}$/)
    expect(b).toMatch(/^[0-9a-f]{12}$/)
    expect(a).not.toBe(b)
  })
})

describe('推理端点签名（2026-10-07 实测发现；业务端点**不需要**）', () => {
  const credWithKey = (over: Partial<TeleagentCredential> = {}): TeleagentCredential => ({
    token: 'T', sign_key: 'S'.repeat(43), ...over,
  })

  it('★ 无 sign_key ⇒ **不发签名头**（让服务端如实报错，而不是发一组必然无效的头）', () => {
    expect(Object.keys(teleagentSignHeaders('POST', '/api/v1/chat/completions', cred()))).toHaveLength(0)
  })

  it('★ 两套签名头都要发（X-SA-* 与 X-SuperAgent-*）—— 单发任一组都过不了', () => {
    const headers = teleagentSignHeaders('POST', '/api/v1/chat/completions', credWithKey())
    for (const key of [
      'X-SA-Sign-Version', 'X-SA-Timestamp', 'X-SA-Nonce', 'X-SA-Signature',
      'X-SuperAgent-Sign-Version', 'X-SuperAgent-Timestamp',
      'X-SuperAgent-Nonce', 'X-SuperAgent-Signature',
    ]) {
      expect(headers[key], key).toBeTruthy()
    }
  })

  it('★ 签名版本常量是 local-v1（asar LocalAuthService 原文 hZ）', () => {
    const headers = teleagentSignHeaders('POST', '/x', credWithKey())
    expect(headers['X-SA-Sign-Version']).toBe('local-v1')
    expect(headers['X-SuperAgent-Sign-Version']).toBe('local-v1')
  })

  it('★ X-SA-Timestamp 是**毫秒**、X-SuperAgent-Timestamp 是**秒**（两组单位不同）', () => {
    const now = 1_700_000_000_123
    const headers = teleagentSignHeaders('POST', '/x', credWithKey(), TELEAGENT, now)
    expect(headers['X-SA-Timestamp']).toBe('1700000000123')
    expect(headers['X-SuperAgent-Timestamp']).toBe('1700000000')
  })

  it('★ X-SA-Signature = HMAC-SHA256(key, "local-v1\\nMETHOD\\npath\\nts\\nnonce") 的 base64url', () => {
    const now = 1_700_000_000_000
    const headers = teleagentSignHeaders('POST', '/api/v1/chat/completions', credWithKey(), TELEAGENT, now)
    const expected = createHmac('sha256', 'S'.repeat(43))
      .update(['local-v1', 'POST', '/api/v1/chat/completions',
        headers['X-SA-Timestamp']!, headers['X-SA-Nonce']!].join('\n'))
      .digest('base64url')
    expect(headers['X-SA-Signature']).toBe(expected)
  })

  it('★ 签名覆盖**真实方法（大写）与 path+query**', () => {
    const headers = teleagentSignHeaders('GET', '/a?b=1', credWithKey())
    const expected = createHmac('sha256', 'S'.repeat(43))
      .update(['local-v1', 'GET', '/a?b=1', headers['X-SA-Timestamp']!, headers['X-SA-Nonce']!].join('\n'))
      .digest('base64url')
    expect(headers['X-SA-Signature']).toBe(expected)
  })

  it('★ nonce 每次不同（X-SA 用 24 位 hex、X-SuperAgent 用 UUID）', () => {
    const a = teleagentSignHeaders('POST', '/x', credWithKey())
    const b = teleagentSignHeaders('POST', '/x', credWithKey())
    expect(a['X-SA-Nonce']).not.toBe(b['X-SA-Nonce'])
    expect(a['X-SA-Nonce']).toMatch(/^[0-9a-f]{24}$/)
    expect(a['X-SuperAgent-Nonce']).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('★ 推理头带两组签名，**业务头不带**（业务端点实测不需要，多发是噪音）', () => {
    const infer = teleagentInferHeaders(credWithKey())
    expect(infer.get('X-SA-Signature')).toBeTruthy()
    expect(infer.get('X-SuperAgent-Signature')).toBeTruthy()
    const biz = teleagentHeaders(credWithKey())
    expect(biz.get('X-SA-Signature')).toBeNull()
    expect(biz.get('X-SuperAgent-Signature')).toBeNull()
  })

  it('★ 推理头仍保持「两个凭据在两个头上」', () => {
    const infer = teleagentInferHeaders(credWithKey())
    expect(infer.get('Authorization')).toBe(`Bearer ${TELEAGENT.inferApiKey}`)
    expect(infer.get('X-Token')).toBe('T')
  })
})
