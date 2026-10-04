/**
 * Antigravity（agy CLI）精简 LlmAdapter。
 *
 * 与对面 `dsh-agy-link` 的 `AgyAdapter` 同源但**大幅裁剪**：
 * 保留「一次 DSH 调用 → 一个短生命周期 `agy -p` 子进程 → NDJSON 事件流
 * → StreamChunk」的流式主干，以及**多账号池调度**（粘性耗尽 / 轮询、
 * family 冷却、限流自动切号）。
 *
 * 刻意**去掉**对面的增值机制（不是 Jet Hub 账号池/登录/配额/模型目录的
 * 必需品，且各自拖入私有依赖）：
 * - **会话绑定**（sessions/discovery/agy-db）：不靠 agy 侧会话续聊，
 *   每次调用把可见历史摘要 + 尾部 user 消息直接喂进 `-p`，无跨调用状态；
 * - **工具镜像**（mirror-tool/recording/agy_tool）：模型调工具的过程不进
 *   DSH 工具循环，只把工具结果文本当作下一步 user 输入回灌（单轮代理）；
 * - **媒体暂存**（media）：多模态先不支持，只透传文本。
 *
 * ⚠️ 设计取向：让「多账号 + 配额/限流自动切换」这个**核心生产力**可用，
 * 牺牲「跨轮工具调用连续性」。后者若将来需要，再按对面 ADR-4/7 补回。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type Message,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { looksLikeAuthFailure, looksLikeHardRateLimit } from './agy/types.js'
import { modelFamilyOf, type ModelFamily } from './agy/pool-types.js'
import type { AccountPoolManager } from './agy/pool.js'
import { EventMapper } from './agy/mapper.js'
import { defaultEffortFor, findEntry, resolveModelSlug, type ModelCatalog } from './agy/models.js'
import { StreamJsonParser } from './agy/parser.js'
import { isolatedHomeEnv, startAgyProcess, buildStreamInputLine, shouldUsePromptStdin, type RunOutcome } from './agy/runner.js'
import type { PluginConfig, RawUsage } from './agy/types.js'
import type { AccountPool } from './account-pool.js'
import { ANTIGRAVITY_PROVIDER_ID } from './antigravity-product.js'

/**
 * provider id（单一真相源在 `antigravity-product.ts`，与 llm 路由名 /
 * `src/agy/types.ts` 的 `PROVIDER_ID` 逐字节一致）。
 */
export const PROVIDER: typeof ANTIGRAVITY_PROVIDER_ID = ANTIGRAVITY_PROVIDER_ID

export interface AntigravityAdapterOptions {
  getConfig: () => PluginConfig
  catalog: ModelCatalog
  pool?: AccountPoolManager
  bin: () => string | null
  acquire: () => Promise<() => void>
  log?: (msg: string) => void
  /**
   * Jet Hub 的凭据型账号池：antigravity 的账号**不在**里面，但它的
   * `disabledModelsFor('antigravity')` 黑名单由 Jet Hub 模型开关写入，
   * listModels 必须套用，关闭的模型才会从选择器消失（显示列表仍用
   * `listAllModels()` 的全量目录回显展示名）。
   */
  accountPool?: AccountPool
  /**
   * 登录态探针（`AuthHelper.probeSignedIn`，自带 60s 缓存与在途合并）。
   * 用于 listModels 的登录门控：未登录时返回空目录，让模型选择器把
   * 整个 antigravity 分组隐藏 —— 否则未登录用户会看到一排"点了必失败"的模型。
   */
  probeSignedIn?: () => Promise<boolean | null>
  /** 桥是否休眠（二进制缺失/版本过旧，同步判据）。休眠时目录直接为空。 */
  isDormant?: () => boolean
  /**
   * 登录态判定结果**发生变化**时通知目录消费者重读（广播
   * `llm/adapters-updated`）。没有它，门控从"显示"翻到"隐藏"（或反向）
   * 要等用户重启才生效 —— 与 jet-hub 黑名单广播是同一条教训。
   */
  notifyCatalogChanged?: () => void
}

function textOf(m: Message): string {
  const parts: string[] = []
  for (const b of m.content) {
    if (b.type === 'text') parts.push(b.text)
  }
  return parts.filter((s) => s !== '').join('\n')
}

/** 尾部最后一条 user 文本 = agy `-p` 的提示词；更早历史由调用方回灌进 messages。 */
function lastUserText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m !== undefined && m.role === 'user') {
      const t = textOf(m)
      if (t !== '') return t
    }
  }
  return ''
}

/** 把可见历史（除最后一条 user）压成一段摘要前缀，弥补无会话绑定丢失的上下文。 */
function buildHistoryPrefix(messages: readonly Message[], maxChars: number): string {
  const parts: string[] = []
  let budget = maxChars
  for (let i = messages.length - 2; i >= 0; i--) {
    const m = messages[i]
    if (m === undefined || m.role === 'system') continue
    const t = textOf(m)
    if (t === '') continue
    const line = (m.role === 'user' ? 'User: ' : 'Assistant: ') + t
    if (line.length > budget) {
      parts.unshift(line.slice(0, Math.max(0, budget)))
      break
    }
    budget -= line.length
    parts.unshift(line)
  }
  if (parts.length === 0) return ''
  return '[conversation so far]\n' + parts.join('\n\n') + '\n[end of conversation so far]\n\n'
}

export class AntigravityAdapter extends LlmAdapter {
  constructor(private readonly options: AntigravityAdapterOptions) {
    super()
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : PROVIDER
    return { id, name: 'Antigravity' }
  }

  /** 完整目录（不套黑名单）——供 Jet Hub「显示列表」回显被关闭模型的展示名。 */
  listAllModels(): readonly { id: string; name: string }[] {
    return this.options.catalog.get().models.map((m) => ({ id: m.id, name: m.name }))
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // 休眠（二进制缺失/版本过旧）：空目录，让选择器隐藏整组。
    if (this.options.isDormant?.()) return []
    // 登录门控：后台探针（AuthHelper 自带 60s 缓存与在途合并，故每次调用廉价）。
    // ⚠️ 探针**绝不 await**：未登录时它要挂到 watchdog（~15s），await 它
    // 就等于把目录构建卡死（2026-10-02 那个永久 loading 故障的同型回归）。
    this.kickLoginProbe()
    // 门控判据 = 主账号探针 **或** 任一可用副账号（隔离 HOME 里有 token 文件）。
    // 只探主账号会误伤「主账号没登录、但池里有已登录副账号」的真实形态 ——
    // 那种情况下推理完全可用（spawn 用副账号的 HOME），隐藏整组是错的。
    if (this.loginState !== 'yes' && !this.hasUsableSecondary()) return []
    const cat = this.options.catalog.get()
    // 套 Jet Hub 模型黑名单（`disabledModelsFor` 返回 Set，空集 = 无关闭）。
    // 只影响对外播报，不改变 stream 的路由能力（与 DSH 对 listModels 的约定一致）。
    const disabled = this.options.accountPool?.disabledModelsFor(PROVIDER)
    const models = disabled !== undefined && disabled.size > 0
      ? cat.models.filter((m) => !disabled.has(m.id))
      : cat.models
    return models.map((m) => ({ provider: PROVIDER, id: m.id, name: m.name, inputModalities: ['text'] as const }))
  }

  /**
   * 池里是否存在「可用且已登录」的副账号。
   *
   * 判据与 QuotaService.getTokenFilePath 同源：隔离 HOME 下
   * `.gemini/antigravity-cli/antigravity-oauth-token` 存在即视为该账号有凭据。
   * 同步 existsSync，无 spawn、无网络 —— 可以安全地放进 listModels。
   * 主账号（systemHome）不算：它的凭据在系统钥匙串/凭据管理器，
   * 只能靠探针判断，走 loginState 那条路。
   */
  private hasUsableSecondary(): boolean {
    const pool = this.options.pool
    if (!pool) return false
    return pool.getAccounts().some((a) => {
      if (a.systemHome || !a.dir) return false
      if (!a.enabled || a.authRequired) return false
      return existsSync(join(a.dir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'))
    })
  }

  /** 登录门控状态：只有探针确认为已登录才播报目录。 */
  private loginState: 'unknown' | 'yes' | 'no' = 'unknown'
  private loginProbeInFlight: Promise<void> | null = null

  /**
   * 后台刷新登录门控；状态翻转时广播目录变更。
   *
   * 翻转必须广播，否则门控从"隐藏"翻到"显示"（登录成功后）或反向
   * （登录态过期后）要等用户重启才生效 —— 与 jet-hub 黑名单广播同一条教训。
   */
  private kickLoginProbe(): void {
    const probe = this.options.probeSignedIn
    if (!probe || this.loginProbeInFlight) return
    // ⚠️ in-flight 标记必须在**结算回调的第一步**清掉，不能放 `.finally`：
    // `.then → .catch → .finally` 是三个微任务，而调用方可能在第一个微任务
    // （notify 翻转）返回后就同步地再次调用 listModels —— 那时 finally 还没跑，
    // 标记仍非空，第二次探针被守卫吞掉，门控就停在旧值（本轮用例实测到的
    // 假失败根因，生产上表现为"登录状态变了但目录不翻"）。
    // 守卫只需覆盖探针的**执行期**，结算即视为可再探。
    const p = probe().then(
      (v) => {
        this.loginProbeInFlight = null
        const next = v === true ? 'yes' : v === false ? 'no' : 'unknown'
        if (next !== this.loginState) {
          this.loginState = next
          this.options.notifyCatalogChanged?.()
        }
      },
      () => {
        this.loginProbeInFlight = null
        // 探针异常保留旧状态：宁可短暂显示旧目录，不要因一次 spawn 失败
        // 就把整组模型藏掉。
      },
    )
    this.loginProbeInFlight = p
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const cfg = this.options.getConfig()
    const cat = this.options.catalog.get()
    const entry = findEntry(cat, model)
    const resolvedId = entry?.id ?? resolveModelSlug(model)
    const name = entry?.name ?? model
    const resolved: LlmResolvedModelInfo = { provider, id: model, name }
    resolved.context = { contextWindow: cfg.contextWindowDefault }
    const efforts = entry?.efforts ?? []
    if (efforts.length > 0) {
      const def = defaultEffortFor(entry!, cfg) ?? efforts[efforts.length - 1]!
      resolved.reasoning = {
        efforts: efforts.map((e) => ({ id: ReasoningEffortId(e), name: e })),
        defaultEffort: ReasoningEffortId(def),
      }
    }
    return resolved
  }

  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ model: LlmResolvedModelInfo; stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> }> {
    return {
      model: { ...await this.resolveModel(provider, model, signal), inputModalities: ['text'] as const },
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  /** 内部：选号 + spawn + 流式映射；限流自动换号重试。 */
  private async *driveOnce(
    options: GenerateOptions,
    tried: Set<string>,
  ): AsyncIterable<StreamChunk> {
    const cfg = this.options.getConfig()
    const bin = this.options.bin()
    const pool = this.options.pool
    const family: ModelFamily = modelFamilyOf(options.model)
    if (!bin) throw new Error('agy binary not found')

    // 1. 选号（跳过已试过的，避免刚失败又选回同一个）
    let account = pool?.selectAccount(family) ?? null
    if (account && tried.has(account.id)) account = null
    if (!account && pool) {
      // 全被冷却/禁用：如实报错，不空转
      throw new Error(`antigravity: no available account for family ${family} (all cooldown/disabled/authRequired)`)
    }
    const accountId = account?.id ?? 'acc_primary'
    const accountDir = account?.dir ?? ''
    const proxyUrl = account?.proxyUrl

    // 2. 构造提示词 = 历史摘要 + system + 尾部 user
    const historyPrefix = buildHistoryPrefix(options.messages, cfg.digestMaxChars)
    const sysText = options.system ?? ''
    const prompt =
      (historyPrefix !== '' ? historyPrefix : '') +
      (sysText !== '' ? '[system instructions]\n' + sysText + '\n[end system instructions]\n\n' : '') +
      lastUserText(options.messages)

    // 3. spawn `agy -p prompt --output-format stream-json`
    const args: string[] = [
      '--output-format', 'stream-json',
      '--print-timeout', Math.max(1, Math.ceil(cfg.timeoutMs / 60_000)) + 'm',
    ]
    const mode = cfg.permissionMode
    if (mode === 'skip') args.push('--dangerously-skip-permissions')
    else args.push('--mode', mode)
    const entry = findEntry(this.options.catalog.get(), options.model)
    const eff = options.reasoningEffort ? String(options.reasoningEffort) : (entry ? defaultEffortFor(entry, cfg) : undefined)
    args.push('--model', resolveModelSlug(options.model))
    if (eff) args.push('--effort', eff)
    args.push('-p', prompt)

    // 长提示词超 Windows argv 上限 → 改走 stdin（runner 已知方案）
    let stdinPayload: string | undefined
    if (shouldUsePromptStdin(args)) {
      args.splice(args.length - 2, 2)
      args.push('--input-format', 'stream-json')
      stdinPayload = buildStreamInputLine(prompt)
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(accountDir ? isolatedHomeEnv(accountDir) : {}),
      ...(proxyUrl ? {
        ALL_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl,
        all_proxy: proxyUrl, https_proxy: proxyUrl, http_proxy: proxyUrl,
      } : {}),
    }

    const release = await this.options.acquire()
    try {
      const parser = new StreamJsonParser()
      /**
       * ⚠️ usage 记账（2026-10-04 修复「上下文很快就满」的根因）。
       *
       * agy 的两种 usage 语义完全不同（已对 1.1.16 实测，并与姊妹项目
       * `dsh-agy-link` 的 CHANGELOG 0.4.6 结论一致）：
       * - `step_update` 的 usage 是 **per-call**：该次内部 LLM 调用的
       *   当前上下文大小（= 真实占用）；
       * - `result` 信封的 usage 是 **会话累计**：整个 agy 会话所有调用的
       *   累加（实测可达 input 3.8M / cacheRead 72M）。
       *
       * DSH 的 token meter 把「最后收到的那个样本」当作当前上下文占用，
       * 所以直接透传 result 信封会把占用报成几十倍、上百倍的真实值
       * （实测放大 226 倍），于是**每一轮都越过压缩阈值**，表现为
       * 「上下文很容易就满了」。
       *
       * 故：记住最后一个 step 的 per-call 样本，在 result 时上报它；
       * 仅当整轮没有任何 step 带 usage 时才回退到信封。
       *
       * ⚠️ 不要因为「信封数字看起来更完整」就改回去 —— 那正是本缺陷。
       */
      let lastStepUsageRaw: RawUsage | null = null
      const usageTracker = {
        noteStepUsage(raw: RawUsage) { lastStepUsageRaw = raw },
        finalUsage(resultRaw: RawUsage) { return lastStepUsageRaw ?? resultRaw },
      }
      const mapper = new EventMapper({ runId: accountId, cutOnTool: false, usage: usageTracker })

      /**
       * 流式主干（2026-10-02 性能修复）。
       *
       * ## 修的是什么（真实缺陷）
       *
       * 原实现写成 `const o = await outcome` —— **等 agy 整个进程结束**才把
       * `o.stdout` 一次性喂给 parser。后果：首字延迟 = 整段生成时间，
       * 用户盯着空屏等十几秒才看到全文**一次性出现**（UI 的"打字机"效果完全消失）。
       * 那段代码自己的注释就写着「那样失去流式……为保留流式，改用轮询 drain
       * pending」，但轮询没实现、`pending` 数组始终是空的 —— 重构半途而废。
       *
       * ## 现在的形状
       *
       * `startAgyProcess` 本来就提供 `onLine` 逐行回调（stdout `data` 事件里
       * 按 `\n` 切好），故：**onLine → parser.feed → mapper.map → 推入队列**，
       * generator 侧 `await` 队列 drain 并 `yield`。数据一到就出块，
       * 端到端延迟只剩「一行 NDJSON 的到达间隔」。
       *
       * ⚠️ 队列用「数组 + 唤醒回调」而不是 setInterval 轮询：轮询会引入固定
       * 延迟（几十毫秒 × 每块）并空转 CPU；回调唤醒是零延迟且无空转。
       * ⚠️ `parser.feed(line + '\n')` 必须补回换行：`onLine` 已把 `\n` 剥掉，
       * 而 `StreamJsonParser.feed` 是**按行**累积缓冲的（不补换行会永远攒着
       * 不解析，表现为"整个流一个字都不出"）。
       */
      const queue: StreamChunk[] = []
      let wake: (() => void) | null = null
      let done = false
      const push = (chunk: StreamChunk): void => {
        queue.push(chunk)
        const w = wake
        wake = null
        w?.()
      }

      let i = 0
      let resultOk = false
      let resultError = ''

      const proc = startAgyProcess({
        bin,
        args,
        cwd: cfg.workspaceRoot !== '' ? cfg.workspaceRoot : undefined,
        timeoutMs: cfg.timeoutMs,
        signal: options.signal,
        stdinPayload,
        env,
        // 逐行流式解析：这是首字延迟的关键，别改回「等 outcome 再全量解析」。
        onLine: (line: string) => {
          if (mapper.isFinished) return
          for (const ev of parser.feed(line + '\n')) {
            // result 事件要在这里捕获：它决定成败与限流切号（旧实现从
            // outcome.stdout 全量解析取回，现在流式路径上只有这一处能看到）。
            if (ev.kind === 'result') {
              resultOk = ev.ok
              resultError = ev.error ?? ''
            }
            for (const ch of mapper.map(ev, i++)) push(ch)
          }
        },
      })

      let hardRateLimited = false
      let serverReset: string | undefined

      const outcome = proc.outcome
      void outcome.then((o) => {
        if (looksLikeHardRateLimit(o.stderrTail) || looksLikeHardRateLimit(o.stdout.slice(-2000))) {
          hardRateLimited = true
        }
        const reset = o.stderrTail.match(/resets?\s+in\s+[^\n]+/i)?.[0] ?? o.stdout.match(/resets?\s+in\s+[^\n]+/i)?.[0]
        if (reset) serverReset = reset
      })

      // 收尾：等进程结束 → flush 尾部残行（agy 被 kill 时最后一行可能无换行）
      // → 关闭队列并唤醒等待者。
      const settle = (async (): Promise<RunOutcome> => {
        const o = await outcome
        for (const ev of parser.flush()) {
          if (ev.kind === 'result') {
            resultOk = ev.ok
            resultError = ev.error ?? ''
          }
          for (const ch of mapper.map(ev, i++)) push(ch)
        }
        return o
      })().finally(() => {
        done = true
        const w = wake
        wake = null
        w?.()
      })

      // 边到边 yield：队列有货就吐，没货就等唤醒（不轮询、不空转）。
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!
          continue
        }
        if (done) break
        // 等「有货」或「收尾完成」——两者都通过 wake 唤醒。
        await new Promise<void>((resolve) => { wake = resolve })
      }

      const o = await settle

      // ⚠️ 未登录的**友好错误**（用户要求，2026-10-02）。agy 未登录时打印
      // "Please sign in / You are not logged into Antigravity" 并非零退出；
      // 若不识别，用户只会看到一句含糊的 "stream ended without a result
      // event"。这里：隔离该账号（authRequired，选号跳过）→ 发 AUTH 终止块
      // → 有下一个可用账号则切号重试（多账号池的意义就在于此）。
      const authText = o.stderrTail + '\n' + o.stdout.slice(0, 4000)
      if (looksLikeAuthFailure(authText)) {
        pool?.markAuthRequired(accountId, 'agy reported not signed in')
        tried.add(accountId)
        for (const ch of mapper.emitFailure(
          'error',
          'AUTH',
          'agy 未登录：请在 Jet Hub 的 Antigravity 面板登录，或在该账号的隔离终端里完成 agy 登录后重试。',
        )) yield ch
        const next = pool?.selectAccount(family)
        if (next && !tried.has(next.id)) {
          this.options.log?.(`[antigravity] ${accountId} 未登录，切号 ${next.id} 重试`)
          yield* this.driveOnce(options, tried)
        }
        return
      }

      // 5. 成败记账 + 限流切号
      //
      // ⚠️ 流式路径下必须在这里补「未收到 result 事件」的收尾块：旧实现把
      // 全量解析放在进程结束后，flush 出来的事件自然覆盖了这条；现在事件
      // 由 onLine 边走边发，**没有 result 事件时 mapper 从未 finish** ——
      // 不补的话 UI 会永远停在「运行中」（harness 等不到 finish 块）。
      if (!mapper.isFinished) {
        for (const ch of mapper.emitFailure('error', 'PROCESS_EXIT', 'agy stream ended without a result event')) yield ch
      }
      if (resultOk) {
        pool?.recordSuccess(accountId, family)
        return
      }
      const tail = resultError || o.stderrTail
      if (looksLikeHardRateLimit(tail) || hardRateLimited) {
        pool?.recordFailure(accountId, family, tail.slice(0, 200), serverReset)
        tried.add(accountId)
        // 换号重试（有候选才重试，避免无限）
        const next = pool?.selectAccount(family)
        if (next && !tried.has(next.id) && pool) {
          this.options.log?.(`[antigravity] family ${family} 限流，切号 ${next.id} 重试`)
          yield* this.driveOnce(options, tried)
          return
        }
      }
      // 非限流失败 or 无可换账号：把错误透出
      if (!resultOk && tail !== '') {
        // mapper 已 emitFailure；此处仅记账
        if (!looksLikeHardRateLimit(tail)) pool?.recordFailure(accountId, family, tail.slice(0, 200))
      }
    } finally {
      release()
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* this.driveOnce(options, new Set<string>())
  }
}
