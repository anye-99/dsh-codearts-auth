/**
 * TeleAgent 的 **CDP 自动登录**（受控浏览器 + 网络层取 token）。
 *
 * ## 为什么只有这条路能自动化
 *
 * TeleAgent 的 token 既不在地址栏、也不在 Console、桌面端日志也不记 URL
 * （三条都在 2026-10-08 被实测证伪，见 docs/teleagent-protocol-notes.md §3）。
 * 而 `redirect_uri` 换成本地端口也不行 —— UPMS 只给官方回调地址签发
 * `loginFlowId` + `state`，换了就白屏。
 * 也不能「让用户粘 code、插件去换」：浏览器**导航本身就消费 code**，
 * 用户能复制到的必然已废（同一 code 再打返回与假 code 逐字节相同的 400）。
 *
 * ⇒ 唯一出路：插件自己起一个受控浏览器，让用户在里面登录，
 * 然后从**网络层**读那一跳的响应。
 *
 * ## token 到底在哪（2026-10-08 CDP 探针实测）
 *
 * 登录链路会经过两个带 JWT 的响应，**只有第二个是我们要的**：
 *
 * | 响应 | JWT 长度 | 开头 | 是什么 |
 * |---|---|---|---|
 * | `upms/public/auth/chooseUserAccountLogin` (XHR) | 240 | `eyJ0eXAiOiJK` | UPMS 统一认证的 `refreshToken`，payload 明写 `"tokenType":"login.v3…"` |
 * | `agent.teleai.com.cn/…/cowork/auth?code=…` (Document) | **493** | **`eyJhbGciOiJI`** | ✅ superCowork 的 token |
 *
 * ⚠️ 探针第一版按「第一个命中」报了 UPMS 那个 —— **错的**。
 * 所以这里**不靠形态猜**：每个候选都真打一次 `user_info`，
 * **谁被服务端认下来谁才是 token**（见 `verifyCandidate`）。
 *
 * ⚠️ 还有一类必须排除的假阳性：埋点上报
 * `track-babel.teleai.com.cn/receiver/api/report?…&token=b48e575c…`
 * （32 位 hex 的匿名标识，**不是**凭据）。它出现在**请求 URL** 里，
 * 所以判据只看响应正文 + 排除 `Ping` 等类型。
 *
 * ## 为什么不复用 zcode 的 CdpConnection
 *
 * `src/zcode-captcha.ts` 里那个只支持「命令 → 响应」配对，
 * 消息处理器对**无 id 的事件直接 return** —— 而本模块的核心正是
 * `Network.responseReceived` / `loadingFinished` **事件**。
 * 加上它与验证码业务的生命周期（`pageBusy`、信号、换页重试）耦合在一起，
 * 硬套会把两边都改复杂。故这里自带一个支持事件分发的精简实现，
 * 但**浏览器发现复用 `findBrowserExecutable`**（它已导出，
 * 且处理过「空环境变量产生相对路径」「USERPROFILE ≠ 家目录」两个实测坑）——
 * 那份逻辑复制出去才是真的会「缺陷修两遍」。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { findBrowserExecutable } from './zcode-captcha.js'

/** 一个候选 token 及其出处（诊断与日志用）。 */
export interface TeleagentTokenCandidate {
  value: string
  /** 命中的响应 URL。 */
  url: string
  /** CDP 报的资源类型（Document / XHR / Fetch / …）。 */
  type: string
}

/** 自动登录的结果。 */
export interface TeleagentBrowserLoginOutcome {
  token: string
  /** token 来自哪个响应（写进日志，便于协议变更时定位）。 */
  source: string
  /** 一并观察到、但未被服务端认下的候选（排障用）。 */
  rejected: TeleagentTokenCandidate[]
}

/** 失败原因：让用户界面能给出**不同**的提示，而不是笼统一句「登录失败」。 */
export type TeleagentBrowserLoginFailure =
  | 'no-browser'      // 机器上没有 Chrome/Chromium/Edge
  | 'devtools-timeout' // 浏览器起来了但调试端口没就绪
  | 'closed'          // 用户中途关了窗口
  | 'timeout'         // 超时仍没拿到可用 token
  | 'error'

export class TeleagentBrowserLoginError extends Error {
  constructor(readonly reason: TeleagentBrowserLoginFailure, message: string) {
    super(message)
    this.name = 'TeleagentBrowserLoginError'
  }
}

/**
 * 不该扫正文的响应类型。
 *
 * ⚠️ `Script` 必须在内：登录页的 `main.*.js` **源码里就有 `token=` 字面量**，
 * 探针第一版把它当成命中，几秒就「成功」退出，用户根本没来得及登录。
 * `Ping` 也要排除（埋点上报的 URL 带匿名 token）。
 */
const NON_BODY_TYPES = new Set(['Script', 'Stylesheet', 'Font', 'Image', 'Media', 'Ping'])

/** 埋点/统计域：它们的 token 是匿名标识，不是凭据。 */
const ANALYTICS_RE = /track-babel|cnzz|umeng|googletagmanager|sentry|log\.[a-z]/i

/**
 * 只认「三段 JWT」形态；允许 `<tenant>:` 前缀（实测真 token 是 `Em9xR4:eyJ…`）。
 *
 * ⚠️ **必须带 `g`** —— 它被 `matchAll` 消费，漏了标志会在**运行时**抛
 * `String.prototype.matchAll called with a non-global RegExp argument`。
 * 写用例时实测炸过一次（探针用的是 `match`，改写成 `matchAll` 时丢了标志）。
 */
const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g
const TOKEN_PARAM_RE = /[?&#]token=([A-Za-z0-9:_\-.]{20,})/g

/** 支持事件分发的精简 CDP 连接。 */
class CdpConnection {
  private nextId = 0
  private readonly pending = new Map<number, {
    resolve: (v: unknown) => void
    reject: (e: Error) => void
  }>()
  private readonly listeners: Array<(method: string, params: Record<string, unknown>) => void> = []

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (event: MessageEvent) => {
      let msg: { id?: number; error?: unknown; result?: unknown; method?: unknown; params?: unknown }
      try {
        msg = JSON.parse(String(event.data)) as typeof msg
      } catch {
        return
      }
      if (msg.id !== undefined) {
        const slot = this.pending.get(msg.id)
        if (slot === undefined) return
        this.pending.delete(msg.id)
        if (msg.error !== undefined) slot.reject(new Error(JSON.stringify(msg.error)))
        else slot.resolve(msg.result)
        return
      }
      // 无 id 的是**事件** —— 本模块的核心就在这里，zcode 那份把它丢了。
      if (typeof msg.method === 'string') {
        const params = (typeof msg.params === 'object' && msg.params !== null
          ? msg.params
          : {}) as Record<string, unknown>
        for (const fn of this.listeners) {
          try {
            fn(msg.method, params)
          } catch { /* 单个监听器出错不能拖垮连接 */ }
        }
      }
    })
  }

  on(handler: (method: string, params: Record<string, unknown>) => void): void {
    this.listeners.push(handler)
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<unknown> {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP ${method} 超时（${timeoutMs}ms）`))
        }
      }, timeoutMs)
      timer.unref?.()
    })
  }

  close(): void {
    try {
      this.ws.close()
    } catch { /* 尽力 */ }
  }

  static async open(url: string, timeoutMs = 15_000): Promise<CdpConnection> {
    const ws = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      // ⚠ 必须有超时：Chromium 僵死时 open / error **两个事件都不来**
      //（zcode 那边记过同型缺陷，会导致永久挂起）。
      const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), timeoutMs)
      const done = (fn: () => void): void => {
        clearTimeout(timer)
        fn()
      }
      ws.addEventListener('open', () => done(resolve))
      ws.addEventListener('error', () => done(() => reject(new Error('CDP WebSocket 连接失败'))))
    })
    return new CdpConnection(ws)
  }
}

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    import('node:net').then(({ default: net }) => {
      const server = net.createServer()
      server.unref()
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        const port = typeof address === 'object' && address !== null ? address.port : 0
        server.close(() => (port > 0 ? resolve(port) : reject(new Error('拿不到空闲端口'))))
      })
    })
  })
}

async function fetchJson(url: string, timeoutMs = 3_000): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  return await response.json()
}

/**
 * 从 `/json/list` 取 page 的调试地址。
 *
 * ⚠️ **不要用 `Target.getTargets`** —— 实测 Edge 154 返回的条目里
 * **没有 `webSocketDebuggerUrl`**，探针第一版就是这么挂的
 * （`new WebSocket(undefined)` → 一个语焉不详的 `Invalid URL`）。
 */
async function pageDebuggerUrl(port: number, deadlineMs: number): Promise<string | undefined> {
  const started = Date.now()
  while (Date.now() - started < deadlineMs) {
    try {
      const list = await fetchJson(`http://127.0.0.1:${port}/json/list`)
      const pages = (Array.isArray(list) ? list : []).filter(
        (item): item is { webSocketDebuggerUrl?: unknown; type?: unknown } =>
          typeof item === 'object' && item !== null && (item as { type?: unknown }).type === 'page',
      )
      const picked = pages.find((t) => typeof t.webSocketDebuggerUrl === 'string')
      if (typeof picked?.webSocketDebuggerUrl === 'string') return picked.webSocketDebuggerUrl
    } catch { /* 还没就绪 */ }
    await sleep(250)
  }
  return undefined
}

/** 从一段文本里抽出所有「像 JWT」的候选（去重、保持出现顺序）。 */
export function extractJwtCandidates(text: string): string[] {
  const out: string[] = []
  for (const match of text.matchAll(JWT_RE)) {
    if (typeof match[0] === 'string' && !out.includes(match[0])) out.push(match[0])
  }
  return out
}

/**
 * 从响应里取候选 token。
 *
 * ⚠️ 只看 **Location 头**与**响应正文**，**不看请求 URL** ——
 * 埋点上报的 URL 里就有 `token=<32 位 hex>`，看了必假阳性。
 */
export function collectCandidatesFromText(text: string): string[] {
  const candidates = extractJwtCandidates(text)
  for (const match of text.matchAll(TOKEN_PARAM_RE)) {
    const raw = match[1]
    if (typeof raw !== 'string') continue
    // 带前缀的形态（`Em9xR4:eyJ…`）单独捞一次：JWT_RE 只会命中冒号后面那段，
    // 而服务端认的可能是**整串**。两种都交给调用方去试。
    if (raw.includes(':') && raw.includes('eyJ')) {
      if (!candidates.includes(raw)) candidates.unshift(raw)
    }
    for (const jwt of extractJwtCandidates(raw)) {
      if (!candidates.includes(jwt)) candidates.push(jwt)
    }
  }
  return candidates
}

export interface LaunchAndCaptureOptions {
  /** 登录入口（`TELEAGENT.loginPage`）。 */
  loginUrl: string
  /** 总超时（毫秒）。用户要输手机号 + 验证码，默认给 5 分钟。 */
  timeoutMs?: number
  /**
   * 逐个验证候选 token：返回 `true` 表示服务端认它。
   *
   * ⚠️ **必须由调用方给真实实现**（打 `user_info`）—— 本模块刻意不猜
   * 「哪个 JWT 是凭据」。探针的教训是：形态上最像的两个 JWT
   * 一个是 UPMS refreshToken、一个才是 superCowork token。
   */
  verify: (candidate: string) => Promise<boolean>
  /** 进度回调（写日志用）。 */
  onProgress?: (message: string) => void
  /** 取消信号：用户点「停止」或面板卸载时中断。 */
  signal?: AbortSignal
}

/**
 * 起受控浏览器 → 用户登录 → 从网络层抓出**被服务端认下来**的那个 token。
 *
 * 无论成功失败，浏览器进程与临时 profile 都会被清理。
 */
export async function launchAndCaptureToken(
  options: LaunchAndCaptureOptions,
): Promise<TeleagentBrowserLoginOutcome> {
  const timeoutMs = options.timeoutMs ?? 5 * 60_000
  const executable = findBrowserExecutable()
  if (executable === undefined) {
    throw new TeleagentBrowserLoginError(
      'no-browser',
      '本机没有可用的 Chrome / Chromium / Edge，无法自动登录（可改用粘贴方式）',
    )
  }

  const port = await pickFreePort()
  const profileDir = mkdtempSync(join(tmpdir(), 'teleagent-login-'))
  const rejected: TeleagentTokenCandidate[] = []
  const seen = new Set<string>()
  let child: ChildProcess | undefined
  let page: CdpConnection | undefined
  let browserWs: CdpConnection | undefined

  const cleanup = (): void => {
    page?.close()
    browserWs?.close()
    try {
      child?.kill()
    } catch { /* 尽力 */ }
    // Edge 退出后 profile 目录可能仍被短暂占用；删不掉就留给系统清理，
    // 绝不能因此让一次**已成功**的登录报错。
    void sleep(300).then(() => {
      try {
        rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch { /* 临时目录，忽略 */ }
    })
  }

  try {
    child = spawn(executable, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-features=Translate',
      '--lang=zh-CN',
      '--window-size=1100,900',
      // 直接把登录页作为**启动参数**：少一次 createTarget 的时序竞争，
      // 也保证窗口一出现就是用户要操作的那一页。
      options.loginUrl,
    ], {
      stdio: 'ignore',
      // ⚠ 必须 headful 且留在屏幕内 —— 用户要在里面输验证码。
      windowsHide: false,
    })

    let closedEarly = false
    child.on('exit', () => { closedEarly = true })

    const versionUrl = `http://127.0.0.1:${port}/json/version`
    const browserWsUrl = await (async (): Promise<string | undefined> => {
      const started = Date.now()
      while (Date.now() - started < 20_000) {
        try {
          const json = await fetchJson(versionUrl)
          const url = (json as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl
          if (typeof url === 'string') return url
        } catch { /* 还没起来 */ }
        await sleep(250)
      }
      return undefined
    })()
    if (typeof browserWsUrl !== 'string') {
      throw new TeleagentBrowserLoginError(
        'devtools-timeout',
        '浏览器已启动但调试端口未在 20 秒内就绪（可能被安全软件拦截）',
      )
    }
    browserWs = await CdpConnection.open(browserWsUrl)

    const wsUrl = await pageDebuggerUrl(port, 15_000)
    if (wsUrl === undefined) {
      throw new TeleagentBrowserLoginError(
        'devtools-timeout',
        '找不到登录页的调试地址（页面可能没起来）',
      )
    }
    page = await CdpConnection.open(wsUrl)

    /** 等正文就绪的响应：requestId → 出处。 */
    const awaitingBody = new Map<string, { url: string; type: string }>()
    /** 已确认可用的 token（异步验证完成后填入）。 */
    let resolved: { value: string; source: string } | undefined
    let verifying = 0

    const tryCandidate = (value: string, url: string, type: string): void => {
      if (seen.has(value)) return
      seen.add(value)
      verifying += 1
      void options.verify(value)
        .then((ok) => {
          if (ok && resolved === undefined) {
            resolved = { value, source: `${type} ${url}` }
            options.onProgress?.(`已在 ${type} 响应中确认 token`)
          } else if (!ok) {
            rejected.push({ value, url, type })
          }
        })
        .catch(() => {
          rejected.push({ value, url, type })
        })
        .finally(() => { verifying -= 1 })
    }

    page.on((method, params) => {
      if (method === 'Network.responseReceived') {
        const response = (params.response ?? {}) as {
          url?: unknown; status?: unknown; headers?: unknown
        }
        const url = String(response.url ?? '')
        const type = String(params.type ?? '')
        if (url.length === 0 || ANALYTICS_RE.test(url)) return

        const headers = (response.headers ?? {}) as Record<string, unknown>
        const location = String(headers.location ?? headers.Location ?? '')

        // ① Location 头里的 deeplink / token（若服务端直接 302 到 teleai-cowork://）
        for (const jwt of collectCandidatesFromText(location)) tryCandidate(jwt, `${url}#Location`, type)

        // ② 正文：等 loadingFinished 再取（提前取会拿到空体）
        const status = Number(response.status ?? 0)
        if (/teleai\.com\.cn/i.test(url) && status > 0 && status < 400 && !NON_BODY_TYPES.has(type)) {
          awaitingBody.set(String(params.requestId ?? ''), { url, type })
        }
      }

      if (method === 'Network.loadingFinished') {
        const requestId = String(params.requestId ?? '')
        const entry = awaitingBody.get(requestId)
        if (entry === undefined) return
        awaitingBody.delete(requestId)
        page?.send('Network.getResponseBody', { requestId }, 10_000)
          .then((result) => {
            const body = String((result as { body?: unknown }).body ?? '')
            if (body.length === 0) return
            for (const jwt of collectCandidatesFromText(body)) tryCandidate(jwt, entry.url, entry.type)
          })
          .catch(() => { /* 取不到体就跳过 */ })
      }
    })

    await page.send('Network.enable', { maxTotalBufferSize: 64 * 1024 * 1024 })
    options.onProgress?.('浏览器已打开，请在窗口里完成天翼登录…')

    const started = Date.now()
    while (resolved === undefined) {
      if (closedEarly) {
        throw new TeleagentBrowserLoginError('closed', '登录窗口被关闭了，自动登录未完成')
      }
      if (options.signal?.aborted === true) {
        throw new TeleagentBrowserLoginError('closed', '已取消自动登录')
      }
      if (Date.now() - started > timeoutMs) {
        throw new TeleagentBrowserLoginError(
          'timeout',
          `超时仍未取到可用 token（观察到 ${seen.size} 个候选，其中 ${rejected.length} 个被服务端拒绝）`,
        )
      }
      await sleep(400)
      // 登录完成但验证还在飞：等它落定再判，否则会误报超时。
      if (seen.size > 0 && verifying > 0) await sleep(1_200)
    }

    return { token: resolved.value, source: resolved.source, rejected }
  } finally {
    cleanup()
  }
}
