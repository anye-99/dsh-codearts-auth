// Shared vocabulary for dsh-agy-link: plugin config, provider-route ids,
// stable error codes, and the normalized event stream produced by the
// stream-json parser and consumed by the StreamChunk mapper.

export const PROVIDER_ID = 'antigravity'
export const PLUGIN_ID = 'agy-link'
export const PKG_NAME = 'dsh-agy-link'

export type PermissionMode = 'skip' | 'plan' | 'accept-edits'

/**
 * 一次 `agy models` spawn 的总预算（登录探针与模型目录发现**共用同一值**）。
 *
 * ⚠️ 为什么是 30s 而不是原来的 15s（真实故障，2026-10-10 用户报障
 * 「模型列表没有 antigravity 的模型」，本机 agy **1.3.2** 实测）：
 *
 * | token 状态 | `agy models` 实际耗时 | 结果 |
 * |---|---|---|
 * | **已过期** | **21.2s** 才打印 `Please sign in…` 并非零退出 | 15s 预算下被 watchdog 杀掉 |
 * | 新鲜（冷启动） | 12.2s 返回 14 条 | 15s 预算只剩 2.8s 余量 |
 * | 新鲜（热） | 6.3s 返回 14 条 | 正常 |
 *
 * 旧值 15s 正卡在「失败路径」中间 ⇒ 超时时 `code=null` 且 stdout 里**还没有**
 * 那句 sign-in 错误 ⇒ `looksLikeAuthFailure` 不命中 ⇒ 探针返回 **null（unknown）**
 * ⇒ 适配器的登录门控永远停在 unknown ⇒ `listModels` 恒返回空目录 ⇒
 * **整个 antigravity 分组被隐藏**。失败判不出、成功又贴着上限，所以现象是
 * 「一直看不到 / 偶尔看得到」。
 *
 * ⇒ 预算必须 **> 失败路径的 21s**，且给成功路径留足余量，取 30s。
 * ⚠️ 两处（`auth.ts` 探针、`agy-service.ts` 目录发现）与 `models.ts` 的
 * AbortController **必须用同一个常量**：原先分别是 15s / 15s / 30s，
 * 内层先到期使外层那道 30s 形同虚设，且两处判据不同步。
 */
export const AGY_MODELS_SPAWN_TIMEOUT_MS = 30_000

/**
 * 探针结果为 **null（判不出）** 时的缓存时长。
 *
 * ⚠️ 比确定性结论（true/false）的 60s 短得多：null 往往是「预算耗尽」或
 * 「agy 正被资格校验/网络抖动拖慢」，属于**可能很快自愈**的中间态
 * （配额轮询续期成功后下一次就能判出 true）。沿用 60s 会让登录门控
 * 在 unknown 上多卡一分钟 —— 用户视角就是「模型列表迟迟不出现」。
 */
export const AGY_PROBE_UNKNOWN_TTL_MS = 15_000

/** 探针给出确定性结论（true/false）时的缓存时长。 */
export const AGY_PROBE_KNOWN_TTL_MS = 60_000

/**
 * 「探针判未登录 ⇒ 试着续期」的冷却（见 `AntigravityService.gateProbe`）。
 *
 * ⚠️ 为什么需要冷却：探针结果为 false 时有 **60s** 缓存，若不加限流，
 * 隐藏期间每分钟就会向 Google 的 token 端点发一次续期请求。凭据**确实**
 * 被吊销（`invalid_grant`）时账号会被标 `authRequired`、本方法随即跳过；
 * 但「网络抖动导致续期失败」不会打标，故必须靠这个下限兜住骚扰。
 */
export const AGY_TOKEN_HEAL_COOLDOWN_MS = 5 * 60_000

export interface FallbackModelDef {
  id: string
  name: string
  /** Selectable reasoning efforts; omit for fixed-thinking models. */
  efforts?: readonly string[]
}

export interface PluginConfig {
  enabled: boolean
  /** Absolute path to the agy binary; empty string = resolve from PATH. */
  agyBin: string
  /** Extra argv appended to every spawn (escape hatch). */
  extraArgs: readonly string[]
  permissionMode: PermissionMode
  defaultModel: string
  defaultEffort: string
  /** Watchdog for one full agy -p run. */
  timeoutMs: number
  maxConcurrent: number
  contextWindowDefault: number
  maxTokensDefault: number
  forwardSystemPrompt: boolean
  digestMaxChars: number
  modelsCacheTtlMs: number
  /** Allow compaction / session-title auxiliary calls to spawn agy. */
  allowAuxiliary: boolean
  /** Hard character cap for compaction prompts built from history. */
  compactionMaxChars: number
  /** Lock the working directory for agy spawns; empty string = process.cwd(). */
  workspaceRoot: string
  fallbackModels: readonly FallbackModelDef[]
  askTool: boolean
  /** Directory where inbound images are staged for agy (path-based multimodal). */
  mediaDir: string
  /** Images older than this are swept from mediaDir. */
  mediaTtlMs: number
  /** Per-image byte cap for staging; larger images are skipped with a note. */
  mediaMaxBytes: number
  /** Max images staged per model call. */
  mediaMaxImages: number
  /** Experimental: expose DSH tools to agy over a local MCP bridge. */
  mcpBridge: boolean
  /** Comma-separated tool-name allowlist for the MCP bridge (empty = all non-internal). */
  mcpToolAllowlist: string
  /** Maximum requests allowed per minute across all sessions (0 = disabled). */
  rateLimitPerMinute: number
  /** Automatically fallback to available lower-tier model if active model is exhausted. */
  autoFallbackModel: boolean
  /** Days to retain historical agy CLI log files before automatic sweep (default: 7). */
  logRetentionDays: number
  /** Opt-out and suppress Google Cloud Code / Antigravity telemetry tracking. */
  disableTelemetry: boolean
  /** Background quota polling interval in ms (default 15 min; clamped >= 60s). Lower = more risk-control exposure. */
  quotaPollIntervalMs: number
}

// Full fallback line-up, mined from the agy 1.1.13 binary. Serves the
// picker when agy models cannot run (signed out / offline); the live list
// always comes from `agy models` once signed in.
//
// ⚠️ 2026-10-09 实测复核（agy **1.3.2**，`agy models` 实时返回 14 条原始条目
// → `foldEfforts` 折叠后 **7 条**）：
//
// | 兜底表 id | `agy models` 是否下发 | 处理 |
// |---|---|---|
// | `gemini-3.8-flash` / `3.7` / `3.6` | ✅ | 一致（efforts 也一致） |
// | `gemini-3.1-pro` | ✅ | 一致 |
// | `claude-sonnet-4-6` / `claude-opus-4-6-thinking` / `gpt-oss-120b-medium` | ✅ | 一致 |
// | **`gemini-3.5-flash`** | ❌ **未下发** | **保留，见下** |
//
// ⚠️⚠️ **`gemini-3.5-flash` 保留是刻意的 —— 它是「未下发」而非「已下线」**，
// 判据三条（复核脚本 `scripts/probe-antigravity-catalog.mjs` /
// `probe-antigravity-spawn.mjs`）：
// 1. **agy 1.3.2 二进制里仍完整枚举它**（`gemini-3.5-flash` / `-low` /
//    `-lite` / `-extra-low` 共 4 处命中），且与 `gemini-3.6/3.7/3.8-flash`
//    出现在**同一批模型常量**里 —— 客户端没有移除它；
// 2. 该二进制含 **`Ineligible tier: %+v`** 与 **`entitlement.userTier`**
//    字样，紧邻 `fetchAvailableModels` —— 即 `agy models` 的返回是
//    **服务端按账号资格（tier）过滤后**的结果；
// 3. ✅ **决定性现场证据**：`agy models` 失败时的 stderr 原文是
//    `Error: Eligibility check failed: Post
//    "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"` ——
//    它**每次拉取前都要先向 Google 做一次资格校验**，校验不通过就一条都不返回
//    （实测本机网络受限时 `agy models` 回 `code=1` + 0 条，而网络通畅时同一
//    命令秒回 14 条）。这直接证明「返回哪些模型」是**服务端按账号判定**的。
//
// ⇒ 按红线**「某次实测没看到」不能推广成「不存在」**，故不删除。
// 代价可接受：它只在 `agy models` **失败**（未登录/离线/资格校验不过）时
// 才出现在选择器里。
// ⚠️ 若将来确认它真已退役，应像 CodeArts 的 `RETIRED_MODEL_IDS` 那样**显式**删除
// 并同步 `antigravity-adapter.spec.ts` / `antigravity-streaming.spec.ts`
// （两处用例都用 `gemini-3.5-flash` 作 fixture 模型名）。
export const DEFAULT_FALLBACK_MODELS: readonly FallbackModelDef[] = [
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'] },
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', efforts: ['low', 'medium', 'high'] },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', efforts: ['low', 'medium', 'high'] },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', efforts: ['low', 'medium', 'high'] },
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', efforts: ['low', 'high'] },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
  { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)' },
  { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
]

export function defaultConfig(): PluginConfig {
  return {
    enabled: true,
    agyBin: '',
    extraArgs: [],
    permissionMode: 'skip',
    defaultModel: '',
    defaultEffort: '',
    timeoutMs: 600_000,
    maxConcurrent: 3,
    contextWindowDefault: 1_048_576,
    maxTokensDefault: 65_536,
    forwardSystemPrompt: false,
    digestMaxChars: 8_000,
    modelsCacheTtlMs: 300_000,
    allowAuxiliary: true,
    compactionMaxChars: 800_000,
    workspaceRoot: '',
    fallbackModels: DEFAULT_FALLBACK_MODELS,
    askTool: false,
    mediaDir: '',
    mediaTtlMs: 86_400_000,
    mediaMaxBytes: 10 * 1024 * 1024,
    mediaMaxImages: 8,
    mcpBridge: false,
    mcpToolAllowlist: '',
    rateLimitPerMinute: 0,
    autoFallbackModel: false,
    logRetentionDays: 7,
    disableTelemetry: true,
    quotaPollIntervalMs: 15 * 60_000,
  }
}

// Stable LlmError codes surfaced by the adapter (spec error table).
export const Err = {
  AUTH: 'AUTH',
  AGY_NOT_INSTALLED: 'AGY_NOT_INSTALLED',
  AGY_VERSION_UNSUPPORTED: 'AGY_VERSION_UNSUPPORTED',
  AGY_ERROR: 'AGY_ERROR',
  TIMEOUT: 'TIMEOUT',
  PROCESS_EXIT: 'PROCESS_EXIT',
  INVALID_OUTPUT: 'INVALID_OUTPUT',
  UNKNOWN_MODEL: 'UNKNOWN_MODEL',
  UNSUPPORTED_REASONING_EFFORT: 'UNSUPPORTED_REASONING_EFFORT',
  AUX_DISABLED: 'AUX_DISABLED',
  BUSY: 'BUSY',
} as const

// Raw usage object as emitted by agy stream-json (snake_case).
export interface RawUsage {
  input_tokens?: number
  output_tokens?: number
  thinking_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  total_tokens?: number
}

export type AgyStepKind =
  | 'text'
  | 'thinking'
  | 'tool'
  | 'title'
  | 'subagent'
  | 'user-input'
  | 'unknown'

export interface AgyToolInfo {
  name: string
  /** Raw arguments: JSON string when agy serializes them, else object. */
  args?: unknown
  output?: unknown
  /** Tool-side failure text (agy 1.1.15: tool_info.error.message on state=ERROR). */
  error?: string
}

export type AgyEvent =
  | { kind: 'init'; conversationId?: string; model?: string; raw: unknown }
  | {
      kind: 'step'
      stepKey: string
      stepKind: AgyStepKind
      text: string
      /** text is a sequential fragment to append, not a cumulative snapshot (agy ≥1.1.15 text_delta). */
      fragment?: boolean
      tool?: AgyToolInfo
      /** Step lifecycle as reported by agy: ACTIVE / DONE / ERROR. */
      state?: string
      /** Per-step usage (agy ≥1.1.15 reports usage on agent_response steps). */
      usage?: RawUsage
      raw: unknown
    }
  | {
      kind: 'result'
      conversationId: string
      ok: boolean
      response: string
      error?: string
      usage: RawUsage
      raw: unknown
    }
  | { kind: 'garbage'; line: string }

// Auth-failure sniffing shared by the runner tail, parser output and the
// result envelope (observed on agy 1.1.13: an authentication-required
// banner plus result.error text).
export function looksLikeAuthFailure(text: string): boolean {
  return /authentication required|authentication failed|please sign in|not signed in|timed out waiting for authentication/i.test(
    text,
  )
}

// Google OAuth consent URL pattern; trailing punctuation is trimmed.
export function extractAuthUrl(text: string): string | undefined {
  const m = text.match(/https:\/\/accounts\.google\.com\/\S+/)
  if (!m) return undefined
  return m[0].replace(/[)\]>.,;\x27\x22]+$/, '')
}

/**
 * HARD, server-issued rate-limit signatures — the ONLY patterns allowed to
 * put an account into cooldown. Deliberately narrow: bare `429` or
 * `rate limit` matched incidental substrings in the wild (hash/UUID
 * fragments, model prose mentioning quotas, unrelated tool/permission
 * errors quoting such words) and produced ghost cooldowns that froze
 * healthy accounts out of rotation.
 */
export function looksLikeHardRateLimit(text?: string): boolean {
  if (!text) return false
  return /RESOURCE_EXHAUSTED|code[ :]?429\b|status[ :]?429\b|HTTP[ :]?429\b|too many requests|individual quota reached|quota (?:exceeded|reached|exhausted)|rate[ -]?limit(?:ed)? (?:exceeded|reached|hit)|exceeded (?:your |the )?quota/i.test(
    text,
  )
}

/**
 * Soft heuristic adds capacity signals (model overloaded / high traffic).
 * Shapes the user-facing error message only — NEVER cools an account down.
 */
export function looksLikeRateLimit(text?: string): boolean {
  if (!text) return false
  return (
    looksLikeHardRateLimit(text) || /model overloaded|experiencing high traffic/i.test(text)
  )
}

/**
 * Parse reset duration in milliseconds from rate-limit / quota-exhausted error strings.
 * Supports compact formats ("Resets in 21m25s", "Resets in 2h26m6s", "Resets in 45s"),
 * verbose formats ("Resets in 15 minutes", "retry after 30 seconds"), and ISO timestamps.
 */
export function parseResetDurationMs(text?: string): number | undefined {
  if (!text) return undefined

  // 1. Compact: "Resets in 2h26m6s", "resets in 21m25s", "resets in 45s"
  const compactMatch = text.match(/resets?\s+in\s+((?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?)/i)
  if (compactMatch && compactMatch[1]?.trim()) {
    const hours = parseInt(compactMatch[2] || '0', 10)
    const minutes = parseInt(compactMatch[3] || '0', 10)
    const seconds = parseInt(compactMatch[4] || '0', 10)
    const totalMs = (hours * 3600 + minutes * 60 + seconds) * 1000
    if (totalMs > 0) return totalMs
  }

  // 2. Word-based: "Resets in 15 minutes", "resets in 2 hours", "retry after 30 seconds"
  const wordMatch = text.match(/(?:resets?|retry)\s+(?:in|after)\s+(\d+)\s*(hour|hr|minute|min|second|sec)s?/i)
  if (wordMatch) {
    const num = parseInt(wordMatch[1]!, 10)
    const unit = wordMatch[2]!.toLowerCase()
    if (unit.startsWith('h')) return num * 3600 * 1000
    if (unit.startsWith('m')) return num * 60 * 1000
    if (unit.startsWith('s')) return num * 1000
  }

  // 3. ISO timestamp or future date string
  const isoMatch = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/)
  if (isoMatch) {
    const parsed = Date.parse(isoMatch[0])
    if (!Number.isNaN(parsed) && parsed > Date.now()) {
      return parsed - Date.now()
    }
  }

  return undefined
}

