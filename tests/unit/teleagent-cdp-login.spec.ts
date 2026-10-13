import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  collectCandidatesFromText,
  extractJwtCandidates,
  TeleagentBrowserLoginError,
} from '../../src/teleagent-cdp-login.js'

/**
 * TeleAgent 的 CDP 自动登录：token 提取判据。
 *
 * ## 为什么这份测试的重点是「别选错」而不是「能不能连上浏览器」
 *
 * 2026-10-08 的 CDP 探针实测出两件事：
 *
 * 1. **自动登录可行** —— token 确实经过浏览器网络层；
 * 2. **探针自己的结论是错的** —— 登录链路上有**两个** JWT，它按
 *    「第一个命中」报了 UPMS 的 `refreshToken`，而真正能用的
 *    是后面那条 `cowork/auth` 文档响应里的 superCowork token。
 *
 * | 响应 | JWT 长度 | 开头 | 是什么 |
 * |---|---|---|---|
 * | `upms/public/auth/chooseUserAccountLogin` (XHR) | 240 | `eyJ0eXAiOiJK` | UPMS refreshToken，payload 明写 `"tokenType":"login.v3…"` |
 * | `agent.teleai.com.cn/…/cowork/auth?code=…` (Document) | **493** | **`eyJhbGciOiJI`** | ✅ superCowork 的 token |
 *
 * 两个形态上都是合法 JWT，**没有任何静态判据能区分** ——
 * 所以实现的取舍权交给服务端（逐个真打 `user_info`）。
 * 本文件既测提取，也钉死「谁被认下谁胜出」这条结构。
 *
 * ## 还要防住的那类假阳性
 *
 * 探针第一版把 `cdn02.teleai.com.cn/js/main/main.*.js`（页面**自己的 JS 源码**）
 * 里出现的 `token=` 字面量当成命中，值还是埋点用的 32 位 hex
 * （`track-babel.teleai.com.cn/receiver/api/report?…&token=b48e575c…`），
 * 于是「几秒就成功退出」，用户根本没来得及登录。
 * ⇒ 判据必须：① 不扫 `Script` / `Ping` 等类型的正文；② 只认三段 JWT 形态；
 * ③ **不看请求 URL**。
 */

/** 造一个形态真实的 JWT（header.payload.signature，三段都是 base64url）。 */
function makeJwt(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: 'HS256' }): string {
  const enc = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url')
  return `${enc(header)}.${enc(payload)}.ZmFrZXNpZ25hdHVyZXZhbHVlMTIzNDU2`
}

const UPMS_REFRESH = makeJwt(
  { tokenType: 'login.v3.account', exp: 1_794_043_327 },
  { typ: 'JWT', alg: 'HS256' },
)
const SUPER_COWORK = makeJwt({ exp: 1_794_043_327, accountId: 'u-1', tenant: 'Em9xR4' })

describe('extractJwtCandidates：只认三段 JWT 形态', () => {
  it('从 HTML 正文里挑出 JWT（真实形态：cowork/auth 页面内嵌）', () => {
    const html = `<!doctype html><html><head><title>登录成功</title></head><body>`
      + `<script>window.__TOKEN__="${SUPER_COWORK}";</script></body></html>`
    expect(extractJwtCandidates(html)).toEqual([SUPER_COWORK])
  })

  it('★ 埋点用的 32 位 hex **不是** JWT ⇒ 不成为候选（探针第一版的假阳性）', () => {
    const analyticsUrl = 'https://track-babel.teleai.com.cn/receiver/api/report'
      + '?app=open-platform-web&token=b48e575c65d7454e8e733d717acd8db4'
    expect(extractJwtCandidates(analyticsUrl)).toEqual([])
    expect(collectCandidatesFromText(analyticsUrl)).toEqual([])
  })

  it('去重且保持出现顺序（同一 token 在页面里出现多次只留一份）', () => {
    const text = `${SUPER_COWORK} … ${SUPER_COWORK} … ${UPMS_REFRESH}`
    expect(extractJwtCandidates(text)).toEqual([SUPER_COWORK, UPMS_REFRESH])
  })

  it('两段式 / 过短的伪 JWT 不认（避免把普通 base64 当凭据）', () => {
    expect(extractJwtCandidates('eyJhbGciOiJI.eyJhbGciOiJI')).toEqual([])
    expect(extractJwtCandidates('eyJhbGci.eyJhbGci.sig')).toEqual([])
  })
})

describe('collectCandidatesFromText：两种下发形态都要认', () => {
  it('★ 带 `<tenant>:` 前缀的整串也要成为候选（服务端认的可能是整串）', () => {
    const withPrefix = `Em9xR4:${SUPER_COWORK}`
    const candidates = collectCandidatesFromText(`?token=${withPrefix}`)
    expect(candidates).toContain(withPrefix)
    expect(candidates).toContain(SUPER_COWORK)
    // 整串排在前面 —— 它是更完整的形态
    expect(candidates.indexOf(withPrefix)).toBeLessThan(candidates.indexOf(SUPER_COWORK))
  })

  it('JSON 响应体里的 refreshToken 字段也能被认出（它随后会被 verify 否掉）', () => {
    const body = `{"code":"10980001","message":"操作成功","flag":1,"data":`
      + `{"expiresAt":1794043327,"refreshToken":"${UPMS_REFRESH}"}}`
    expect(collectCandidatesFromText(body)).toEqual([UPMS_REFRESH])
  })

  it('Location 头里的 deeplink 也能取到 token', () => {
    const location = `teleai-cowork://auth?token=${SUPER_COWORK}`
    expect(collectCandidatesFromText(location)).toContain(SUPER_COWORK)
  })
})

describe('★ 结构断言：选谁由服务端决定，不是由出现顺序决定', () => {
  const source = readFileSync(
    new URL('../../src/teleagent-cdp-login.ts', import.meta.url), 'utf8',
  )
  const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const code = strip(source)

  it('命中条件是「verify 通过」，不是「看到第一个候选」', () => {
    // 探针的错就在按第一个报。真实现的唯一写入路径必须是 ok 分支。
    expect(code).toMatch(/if\s*\(ok\s*&&\s*resolved\s*===\s*undefined\)/)
    // 反向：不得存在「拿到第一个候选就直接返回」的写法
    expect(code).not.toMatch(/resolved\s*=\s*\{\s*value:\s*candidate/)
  })

  it('★ 静态资源与埋点类型一律不扫正文', () => {
    // Script 必须在内：登录页 main.*.js 的源码里有 `token=` 字面量。
    for (const type of ['Script', 'Stylesheet', 'Font', 'Image', 'Media', 'Ping']) {
      expect(code, type).toContain(`'${type}'`)
    }
    expect(code).toContain('!NON_BODY_TYPES.has(type)')
  })

  it('★ 候选只从 Location 与响应正文取，**不看请求 URL**', () => {
    // 埋点上报的 token 就在请求 URL 里 —— 看了必假阳性。
    // ⚠ 只匹配「传一个简单标识符」的**调用**处；函数定义是 `(text: string)`，
    //    带类型标注故不会被这个正则捞进来。
    const calls = [...code.matchAll(/collectCandidatesFromText\(([a-zA-Z_$][\w$]*)\)/g)]
      .map((m) => m[1])
    expect(calls.length).toBeGreaterThanOrEqual(2)
    for (const arg of calls) {
      expect(arg, arg).not.toMatch(/^url$/)
      expect(arg, arg).toMatch(/location|body/i)
    }
  })

  it('埋点/统计域被整条跳过', () => {
    expect(code).toMatch(/ANALYTICS_RE\.test\(url\)/)
    expect(code).toContain('track-babel')
  })

  it('CDP 建连必须有超时（Chromium 僵死时 open/error 两个事件都不来）', () => {
    expect(code).toMatch(/CDP WebSocket 连接超时/)
  })

  it('临时 profile 删不掉**不能**让一次已成功的登录报错', () => {
    const cleanup = code.slice(code.indexOf('const cleanup = ()'))
    expect(cleanup).toContain('catch')
    // 且删除是延迟 + 重试的（Edge 退出后目录仍会被短暂占用）
    expect(cleanup).toMatch(/maxRetries:\s*5/)
  })
})

describe('TeleagentBrowserLoginError：失败要可分类', () => {
  it('reason 透传，供前端给不同提示（没浏览器 / 被关 / 超时…）', () => {
    const error = new TeleagentBrowserLoginError('no-browser', '本机没有可用的浏览器')
    expect(error.reason).toBe('no-browser')
    expect(error.name).toBe('TeleagentBrowserLoginError')
    expect(error.message).toBe('本机没有可用的浏览器')
  })
})
