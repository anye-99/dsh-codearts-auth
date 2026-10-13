/**
 * TeleAgent 只读 E2E 探针：token 有效性 + 推理 + **模型目录取证**。
 *
 * ## 三条用例各解决一个已知缺口
 *
 * 1. `user_info` —— 验证「身份头组合」真的被服务端接受
 *    （`X-Token` + 秒级 timestamp + nonce + `X-Route-Target`）。
 *    这是最便宜的验证，且**不消耗模型额度**。
 * 2. `chat/completions` —— 验证「两个凭据在两个头上」的推断
 *    （`Authorization: Bearer <内置渠道 apiKey>` + `X-Token: <用户 token>`）。
 *    ⚠️ 会消耗账号积分，故额外需要 `DSH_TELEAGENT_CHAT_CONFIRM=yes` 双闸门。
 * 3. **读官方客户端的 `model-catalog` 缓存文件** —— 这是 `docs/teleagent-protocol-notes.md`
 *    未决项 1 的**替代取证路径**：既然拉取端点没定位到，就直接读客户端已经落盘的
 *    目录缓存。跑一次就能拿到真实模型表（id / limit / 是否有 thinking_config），
 *    从而决定要不要给兜底表补档位、以及 `fetchModels` 该不该接远端。
 *    ⚠️ 纯本地文件读取，**不发任何网络请求**。
 *
 * ## 凭据来源
 *
 * TeleAgent 的 token 由官方客户端用 Electron safeStorage 加密存在
 * `app-auth/token.json`（asar 注释明言「safeStorage 只做混淆」），
 * **本探针不去解密它** —— 请从面板登录一次后，用
 * `DSH_TELEAGENT_TOKEN=<token>` 显式传入（与 minimax 探针「读客户端凭据」不同，
 * 这里刻意要求显式提供，避免误碰用户客户端的加密存储）。
 *
 * ⚠️ 闸门默认关闭：需 `DSH_TELEAGENT_E2E=1`（用 `pnpm test:e2e:teleagent`）。
 * 未设环境变量时**全部 skipped，不发任何网络请求**。
 * ⚠️ token 不落盘、不打印；日志只出现账号信息与余额/模型名。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { TELEAGENT } from '../../src/teleagent-product.js'
import {
  generateTeleagentDeviceId,
  teleagentHeaders,
  teleagentInferHeaders,
  type TeleagentCredential,
} from '../../src/teleagent.js'

const enabled = process.env.DSH_TELEAGENT_E2E === '1'
const chatEnabled = process.env.DSH_TELEAGENT_CHAT_E2E === '1'
  && process.env.DSH_TELEAGENT_CHAT_CONFIRM === 'yes'
const describeIf = enabled ? describe : describe.skip

/** 构造探针凭据（deviceId 每次新生成 —— 探针不该写任何持久状态）。 */
function probeCredential(): TeleagentCredential {
  return {
    token: process.env.DSH_TELEAGENT_TOKEN ?? '',
    device_id: generateTeleagentDeviceId(),
  }
}

/**
 * 递归找官方客户端落盘的 `model-catalog` 缓存文件。
 *
 * ⚠️ **数据根是 `~/.local/share/TeleAgent`（XDG 约定），不是 `%APPDATA%`** ——
 * 这是 2026-10-07 实测确认的（用户登录后 `%APPDATA%\TeleAgent` 仍是空的，
 * 而 `~/.local/share/TeleAgent` 下出现了 `users/<accountId>/` 完整账号目录）。
 * 与 asar 的注释一致：「引擎的账号数据根用 XDG 这两个名字，引擎把值原样当作根」。
 *
 * ⚠️ 账号目录名形如 `v1_public_2097338932289392640`，**尾号即 user_info 的 accountId**
 *（实测：`js-log` 里 `userId: 2097338932289392640` 与之吻合）。
 */
function teleagentDataRoots(): string[] {
  const home = homedir()
  return [
    join(home, '.local', 'share', 'TeleAgent'),
    join(home, '.config', 'TeleAgent'),
    // 兼容旧版本/非 XDG 环境（实测为空，但留着不亏）。
    join(home, 'AppData', 'Roaming', 'TeleAgent'),
  ]
}

function findModelCatalogFiles(root: string, depth = 0, out: string[] = []): string[] {
  if (depth > 6 || out.length > 8 || !existsSync(root)) return out
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return out
  }
  for (const name of entries) {
    const full = join(root, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) findModelCatalogFiles(full, depth + 1, out)
    else if (/^model-catalog/i.test(name)) out.push(full)
  }
  return out
}

describeIf('TeleAgent 只读探针（不领取、不写任何状态）', () => {
  const credential = enabled ? probeCredential() : undefined

  it('登录入口可达（**纯网络、无需 token**，验证不是白屏空壳）', async () => {
    // ⚠️⚠️ 2026-10-07 用户报障「卡在这里了」+ 白屏截图：
    // 初版用的 `meter/teleagent-login/login` 是 **511 字节空 SPA 壳**（白屏）。
    // 正确入口是 UPMS 授权 URL（302 → `/master-auth`，1508 字节真实登录页）。
    // 本用例**不需要 token**，可随时跑，防止将来有人把 URL 改回空壳。
    const entry = await fetch(TELEAGENT.loginPage, { redirect: 'manual' })
    expect(
      entry.status,
      `登录入口应 302 到 /master-auth，实际 ${entry.status} —— 若为 200 且内容极短，`
      + '说明填的是那个白屏空壳页（见 docs/teleagent-protocol-notes.md §2）',
    ).toBe(302)
    const location = entry.headers.get('location') ?? ''
    expect(location).toContain('/master-auth')

    // 跟随一步，确认落地页真有内容
    const masterUrl = location.startsWith('http')
      ? location
      : `https://www.teleai.com.cn${location}`
    const master = await fetch(masterUrl)
    const html = await master.text()
    console.log(`[teleagent] 登录页：status=${master.status} len=${html.length}`
      + ` title="${/<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? '?'}"`)
    // 511 字节是那个空壳的特征长度；真实登录页 > 1000 字节
    expect(html.length, '登录页内容过短，疑似空壳').toBeGreaterThan(1000)
  })

  it('环境变量里提供了 token', () => {
    expect(
      credential && credential.token.length > 0,
      '请设置 DSH_TELEAGENT_TOKEN=<粘贴面板里登录拿到的 token>',
    ).toBe(true)
  })

  it('user_info 可读（验证身份头组合被服务端接受）', async () => {
    const response = await fetch(`${TELEAGENT.apiBase}/cowork/user_info`, {
      method: 'GET',
      headers: teleagentHeaders(credential!),
    })
    expect(response.ok, `user_info HTTP ${response.status}`).toBe(true)
    const body = await response.json() as Record<string, unknown>
    const data = (typeof body.data === 'object' && body.data !== null
      ? body.data
      : body) as Record<string, unknown>
    // ⚠️ 只打印**非敏感**字段，绝不打印 token。
    console.log('[teleagent] user_info 形状：', JSON.stringify({
      code: body.code,
      success: body.success,
      accountId: data.accountId ?? data.account_id ?? null,
      hasPhone: typeof data.phone === 'string' && data.phone.length > 0,
      keys: Object.keys(data).slice(0, 20),
    }))
    expect(data.accountId ?? data.account_id ?? data.uid, 'user_info 没返回 accountId').toBeTruthy()
  })

  it('推理 chat/completions 可用（**会消耗积分**，需双闸门）', async (ctx) => {
    if (!chatEnabled) {
      console.log('[teleagent] 推理探针未开启（需 DSH_TELEAGENT_CHAT_E2E=1 且 '
        + 'DSH_TELEAGENT_CHAT_CONFIRM=yes）—— 它会真实消耗账号积分，故默认跳过。')
      ctx.skip()
    }
    const model = process.env.DSH_TELEAGENT_MODEL ?? 'chat-lite'
    const response = await fetch(`${TELEAGENT.apiBase}/api/v1/chat/completions`, {
      method: 'POST',
      headers: teleagentInferHeaders(credential!),
      body: JSON.stringify({
        model,
        stream: true,
        messages: [{ role: 'user', content: '只回复两个字：收到' }],
      }),
    })
    const text = await response.text()
    expect(response.ok, `${model} HTTP ${response.status} — ${text.slice(0, 400)}`).toBe(true)
    // 只要流里出现过 content 增量就算通（不断言具体文案）。
    const gotContent = /"content"\s*:\s*"[^"]/.test(text)
    const gotErrorFrame = /"error"\s*:|statusCodeValue|"type"\s*:\s*"model_error"/.test(text)
    console.log(`[teleagent] ${model}: 响应 ${text.length} 字符，`
      + `有正文=${gotContent}，含错误帧=${gotErrorFrame}`)
    if (gotErrorFrame) {
      console.log('[teleagent] 错误帧原文（用于归类判据取证）：', text.slice(0, 800))
    }
    expect(gotContent || !gotErrorFrame, `${model} 返回了错误帧`).toBe(true)
  })

  it('读官方客户端的 model-catalog 缓存（**模型目录取证**，纯本地）', () => {
    const roots = teleagentDataRoots().filter((root) => existsSync(root))
    if (roots.length === 0) {
      console.log('[teleagent] 未找到官方客户端数据根（未装/未登录）—— 跳过目录取证。')
      return
    }
    console.log('[teleagent] 数据根：', roots.join(' | '))
    const files = roots.flatMap((root) => findModelCatalogFiles(root))
    if (files.length === 0) {
      console.log('[teleagent] 数据根下没有 model-catalog 缓存文件。'
        + '⚠️ 2026-10-07 实测：用户已登录并跑过任务，仍未落盘该文件 ——'
        + '它可能是纯内存态（asar 注释说主进程读侧用它做「缓存优先 spawn」）。'
        + '此时请改用下面的 provider 清单用例。')
      return
    }
    for (const file of files) {
      let raw: string
      try {
        raw = readFileSync(file, 'utf8')
      } catch (error) {
        console.log(`[teleagent] 读 ${file} 失败：${String(error)}`)
        continue
      }
      console.log(`[teleagent] ===== ${file}（${raw.length} 字符）=====`)
      // 打印**全部模型条目**的关键字段，用于校正兜底表与档位。
      try {
        const parsed = JSON.parse(raw) as unknown
        console.log('[teleagent] model-catalog 摘要：', JSON.stringify(summarizeCatalog(parsed), null, 1))
      } catch {
        console.log('[teleagent] 非 JSON，前 400 字符：', raw.slice(0, 400))
      }
    }
  })

  it('读引擎日志里的 provider 清单（**权威模型目录**，纯本地）', () => {
    // ⚠️ 这是 2026-10-07 实测**真正有效**的取证路径（model-catalog 文件不存在）：
    // 引擎日志 `log/super-agent-server-<date>.log` 里有一行
    //   [provider/list] registry=[…] result_all=[…] connected=[…]
    // 它就是模型目录的权威来源，比读缓存文件可靠得多。
    const roots = teleagentDataRoots().filter((root) => existsSync(root))
    let printed = 0
    for (const root of roots) {
      const usersDir = join(root, 'users')
      if (!existsSync(usersDir)) continue
      for (const account of readdirSync(usersDir)) {
        const logDir = join(usersDir, account, 'log')
        if (!existsSync(logDir)) continue
        for (const name of readdirSync(logDir)) {
          if (!/^super-agent-server-.*\.log$/.test(name)) continue
          const text = readFileSync(join(logDir, name), 'utf8')
          // provider 清单
          for (const match of text.matchAll(/\[provider\/list\][^\n]*/g)) {
            console.log(`[teleagent] ${account}:`, match[0])
            printed += 1
          }
          // 模型能力（含 Reasoning / Image / ToolCall —— 决定我们要不要声明档位与图片）
          const caps = new Set<string>()
          for (const match of text.matchAll(/GetModelCapabilities provider="([^"]+)" model="([^"]+)" capabilities=\{([^}]*)\}/g)) {
            caps.add(`${match[1]}/${match[2]} → ${match[3]}`)
          }
          for (const line of caps) console.log('[teleagent] capabilities:', line)
          // 实际用过的模型（印证模型 id 形态 NewApi/<id>）
          const used = new Set<string>()
          for (const match of text.matchAll(/NewApi\/[a-z0-9-]+/g)) used.add(match[0])
          for (const line of used) console.log('[teleagent] 实际使用的模型：', line)
        }
      }
    }
    if (printed === 0) {
      console.log('[teleagent] 未找到引擎日志 —— 请先用官方客户端跑一次任务。')
    }
  })
})

/**
 * 把目录缓存压成「够用来改表」的摘要。
 *
 * 形状未知（我们没定位到拉取端点，也就没见过响应体），故这里**宽容遍历**：
 * 找出所有带 `id`/`key`/`modelId` 且带 `limit`/`context` 的对象并打印关键字段。
 */
function summarizeCatalog(node: unknown, depth = 0, acc: unknown[] = []): unknown {
  if (depth > 8) return acc
  if (Array.isArray(node)) {
    for (const item of node) summarizeCatalog(item, depth + 1, acc)
    return acc
  }
  if (typeof node !== 'object' || node === null) return acc
  const record = node as Record<string, unknown>
  const id = record.id ?? record.key ?? record.modelId ?? record.model_id
  const hasModelShape = typeof id === 'string'
    && (record.limit !== undefined || record.context !== undefined
      || record.contextWindow !== undefined || record.max_input_tokens !== undefined)
  if (hasModelShape) {
    acc.push({
      id,
      name: record.name ?? record.display_name ?? null,
      context: (record.limit as Record<string, unknown> | undefined)?.context
        ?? record.context ?? record.contextWindow ?? record.max_input_tokens ?? null,
      output: (record.limit as Record<string, unknown> | undefined)?.output ?? record.max_output_tokens ?? null,
      // 这三项决定「能不能声明思考档位 / 图片」—— 正是未决项 2、3 要的判据。
      thinking: record.thinking_config ?? record.effort_options ?? null,
      modalities: record.modalities ?? null,
    })
  }
  for (const value of Object.values(record)) summarizeCatalog(value, depth + 1, acc)
  return acc
}
