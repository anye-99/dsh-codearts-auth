/**
 * TeleAgent 模型适配器。
 *
 * ## 协议族 = OpenAI 兼容（**无加密**）
 *
 * `POST {apiBase}/api/v1/chat/completions`，请求体是标准 OpenAI 形状，
 * 响应是标准 SSE。⇒ 消息序列化与 SSE 消费**复用** `src/openai-compat.ts`
 * （`serializeMessages` / `consumeOpenAiSse` / 错误归类），
 * **不**新建 messages 层 —— 与 minimax（Anthropic Messages）、
 * trae（SOLO 自定义事件）是本质差异，也是本 provider 最薄的一层。
 *
 * ## 两个凭据在两个头上（最容易踩的坑）
 *
 * - `Authorization: Bearer <内置 NewApi apiKey>` —— **渠道**身份（asar 硬编码）；
 * - `X-Token: <用户 token>` —— **用户**身份（决定谁的额度、谁的账号）。
 *
 * ⚠️ 把用户 token 塞进 Bearer 会 401。见 {@link teleagentInferHeaders}。
 *
 * ## 思考档位：**当前不声明**
 *
 * asar 的 `KG` 种子表（`chat-nano` / `chat-lite`）**没有**下发
 * `thinking_config` / `effort_options`，档位/前沿模型的参数来自服务端目录缓存
 * （我们尚未定位到其拉取端点）。⇒ `resolveModel` **不产出** `reasoning`，
 * DSH 显示「当前模型未提供推理等级」。
 *
 * ⚠️ **不要**按截图或直觉给它们编档位 —— 与 Qoder「`qmodel` 没有档位就是没有，
 * 不要猜」是同一条教训。拿到真实目录后一并补齐。
 *
 * ## 图片：**声明不支持即报错，不静默丢图**
 *
 * 兜底表 `supportsImage` 恒 false（未实测），故收到图片时抛
 * `UNSUPPORTED_CONTENT`。静默丢图会让用户以为模型看到了图片
 * （与 cline / lobsterai / minimax 的既有契约一致）。
 */

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { providerCatalogVisible } from './account-pool.js'
import type { AccountPool } from './account-pool.js'
import {
  collectImages,
  consumeOpenAiSse,
  errorDetail,
  httpErrorCode,
  serializeMessages,
} from './openai-compat.js'
import {
  TELEAGENT,
  TELEAGENT_INFER_PATH,
  TELEAGENT_REQUEST_TIMEOUT_MS,
  type TeleagentProduct,
} from './teleagent-product.js'
import {
  isTeleagentExpired,
  teleagentFallbackEntries,
  teleagentInferHeaders,
  type TeleagentCredential,
  type TeleagentModelEntry,
} from './teleagent.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'

/**
 * 判断错误体是否为**签名类**失败（2026-10-07 实测的两个业务码）。
 *
 * | 码 | 服务端文案 | 真实含义 |
 * |---|---|---|
 * | `40301` | 检测到客户端版本过低，请检查新版本并升级以继续使用 | **缺签名头**（与版本号无关！） |
 * | `40104` | unsupported sign version | 签名版本头缺失/不被接受 |
 *
 * ⚠️ 判据必须**同时**认码与文案：`40301` 的文案完全没提签名，而
 * `40104` 是英文且不说哪组头 —— 只认其一会漏。
 * ⚠️ 关键词必须**窄**（只认这两个码与 `unsupported sign version`）：
 * 泛词如 `version` 会误伤「模型版本不支持」这类真实错误。
 */
function looksLikeSigningError(body: string): boolean {
  if (/"?code"?\s*:\s*"?(40301|40104)"?/.test(body)) return true
  return /unsupported sign version/i.test(body)
}

/** {@link TeleagentAdapter} 的构造选项。 */
export interface TeleagentAdapterOptions {
  /** 单凭据回退 ref（无账号池时）。 */
  credentialRef: CredentialRef
  /** 解析当前可用凭据。 */
  resolveCredential: (modelId?: string) => Promise<TeleagentCredential | undefined>
  /** 凭据失效时的处理（本 provider 是「探测有效性」）。 */
  refresh: () => Promise<void>
  /** 拉取远端模型目录；失败/缺省时适配器回退兜底表。 */
  fetchRemoteModels?: () => Promise<readonly TeleagentModelEntry[]>
  /** 账号池（目录门控与黑名单）。 */
  accountPool?: AccountPool
  /**
   * 内联一张图片（`ctx.attachments.readImage` 桥接）。
   *
   * ⚠️ 当前兜底表 `supportsImage` 恒 false，故本字段**实际不会被用到**；
   * 保留它是为了「实测带图通过后只需改兜底表」，不必再动接线。
   */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 产品配置；默认 {@link TELEAGENT}。 */
  product?: TeleagentProduct
}

/** TeleAgent 模型适配器。 */
export class TeleagentAdapter extends LlmAdapter {
  private readonly product: TeleagentProduct
  private remoteModels: readonly TeleagentModelEntry[] | undefined

  constructor(private readonly options: TeleagentAdapterOptions) {
    super()
    this.product = options.product ?? TELEAGENT
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /** 取（并缓存）模型目录；远端失败回退兜底表。 */
  private async loadModels(): Promise<readonly TeleagentModelEntry[]> {
    if (this.remoteModels !== undefined) return this.remoteModels
    if (this.options.fetchRemoteModels !== undefined) {
      try {
        const fetched = await this.options.fetchRemoteModels()
        if (fetched.length > 0) {
          this.remoteModels = fetched
          return fetched
        }
      } catch {
        // 远端失败静默回退：模型目录是展示信息，不该让整个 provider 报错。
      }
    }
    const fallback = teleagentFallbackEntries(this.product)
    this.remoteModels = fallback
    return fallback
  }

  /**
   * 完整目录（**不套黑名单**），供 Jet Hub「显示列表」用。
   *
   * ⚠️ **必须同步返回数组，不能是 `async`**（minimax 接线时踩过的真实缺陷）：
   * `jet-hub-rpc.ts` 的两处消费者都不 await，返回 Promise 会让
   * 「显示列表」与「关闭全部」同时崩（`all is not iterable`）。
   * 读缓存是安全的：RPC 在调用本方法前已先 `await llm.listModels(provider)`，
   * 而 `listModels` 内部会 `await loadModels()` 落缓存。
   */
  listAllModels(): readonly { id: string; name: string }[] {
    const source = this.remoteModels ?? teleagentFallbackEntries(this.product)
    return source.map((model) => ({ id: model.id, name: model.name }))
  }

  private inputModalitiesFor(entry: TeleagentModelEntry | undefined): readonly ('text' | 'image')[] {
    return entry?.supportsImage === true ? ['text', 'image'] : ['text']
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // ⚠️ 无已登录账号时返回 `[]` → DSH 把整个 provider 分组隐藏。
    // **必须返回空数组而不能抛错**（抛错会多一条 provider 报错）。
    if (!await providerCatalogVisible(this.options.accountPool, this.product.id)) return []

    const all = await this.loadModels()
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    const listed = disabled === undefined || disabled.size === 0
      ? all
      : all.filter((model) => !disabled.has(model.id))

    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      name: model.name,
      inputModalities: this.inputModalitiesFor(model),
    }))
  }

  async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const all = await this.loadModels()
    const entry = all.find((item) => item.id === model)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: entry?.name ?? model,
      inputModalities: this.inputModalitiesFor(entry),
    }
    // ⚠️ 未知模型不编造 context（宁可让 DSH 用默认值，也不报一个假窗口）。
    // `0` 是「未知」哨兵，故必须判 `> 0`。
    if (entry !== undefined && entry.contextWindow > 0) {
      resolved.context = { contextWindow: entry.contextWindow }
    }
    // ⚠️ 非法值必须过滤：0/负数/NaN 会让 DSH 抛 INVALID_MODEL_MAX_TOKENS，
    // **整轮对话起不来**（不是降级，是崩）。
    // 先取局部变量再判：`entry.maxTokens` 是可选属性，`Number.isSafeInteger`
    // 不做类型收窄，strict 下直接写两个条件会报 TS18048。
    const maxTokens = entry?.maxTokens
    if (maxTokens !== undefined && Number.isSafeInteger(maxTokens) && maxTokens > 0) {
      resolved.defaultMaxTokens = maxTokens
    }
    // ⚠️ **不声明 reasoning**（见模块头「思考档位」）。
    return resolved
  }

  /** 兼容 0.1.1-rc.2 的 `prepareCall` shim（与其余适配器同款）。 */
  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{
    model: LlmResolvedModelInfo
    stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  /**
   * 发一次 OpenAI 兼容的流式请求。
   *
   * ⚠️ 凭据过期先静默探测一次（本 provider 无续期，探测失败即抛终态错误）。
   * ⚠️ **错误必须抛错**，不静默返回空流（Qoder 早期的同型缺陷：
   * UI 表现为「干净地停止、无任何报错」）。
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    let credential = await this.options.resolveCredential(options.model)
    if (credential === undefined || isTeleagentExpired(credential)) {
      await this.options.refresh()
      credential = await this.options.resolveCredential(options.model)
    }
    if (credential === undefined || credential.token.trim().length === 0) {
      throw new LlmError('teleagent: no usable credential; log in first', 'MISSING_CREDENTIAL')
    }

    const entry = (await this.loadModels()).find((item) => item.id === options.model)

    // 图片：先判定模型是否支持，再内联。
    const imageRefs = new Map<string, unknown>()
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    let imageUrls: Map<string, string> | undefined
    if (imageRefs.size > 0) {
      if (this.inputModalitiesFor(entry).indexOf('image') < 0) {
        throw new LlmError(
          `teleagent: 模型 "${options.model}" 不支持图片输入`,
          'UNSUPPORTED_CONTENT',
        )
      }
      if (this.options.readImage === undefined) {
        throw new LlmError('teleagent: 图片输入需要附件服务（readImage 未提供）', 'UNSUPPORTED_CONTENT')
      }
      // 保留**空 Map**（而非降级 undefined）：图片存在但全部读取失败时，
      // 空 Map 仍会让 userContentParts 产出 [image unavailable] 占位符。
      imageUrls = new Map()
      const readImage = this.options.readImage
      for (const [id, ref] of imageRefs) {
        const image = await readImage(ref)
        if (image === undefined) continue
        imageUrls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`)
      }
    }

    const messages = serializeMessages(options.messages, imageUrls)
    if (options.system !== undefined && options.system.length > 0) {
      messages.unshift({ role: 'system', content: options.system })
    }
    // ⚠️ 工具必须真的下发到请求体顶层 `tools`（OpenAI 形状）。
    // 不下发时模型只能在正文里用文本臆造调用 → harness 认不出 → 任务终止
    //（Qoder 那条「xml 泄露任务终止」的同型缺陷，AGENTS.md 已记三次）。
    const tools = options.tools?.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }))

    const body: Record<string, unknown> = {
      model: options.model,
      messages,
      stream: true,
    }
    if (tools !== undefined && tools.length > 0) body.tools = tools
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
    if (options.temperature !== undefined) body.temperature = options.temperature
    if (options.stop !== undefined && options.stop.length > 0) body.stop = options.stop

    const inferUrl = `${this.product.apiBase}${TELEAGENT_INFER_PATH}`
    const response = await fetch(inferUrl, {
      method: 'POST',
      // ⚠️ 签名覆盖「方法 + pathname + search」，故必须把**真实**的方法与路径
      // 传进去（用默认值也能对上，但显式传入可防「将来改路径忘了改签名」）。
      headers: teleagentInferHeaders(credential, this.product, {
        method: 'POST',
        pathWithQuery: TELEAGENT_INFER_PATH,
      }),
      body: JSON.stringify(body),
      signal: options.signal ?? AbortSignal.timeout(TELEAGENT_REQUEST_TIMEOUT_MS),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      // ⚠️ 402 是**余额不足**（TeleAgent 有「积分余额不足」的确定性文案），
      // 必须原样透出 —— 归成 SERVER/AUTH 会让用户看不到「去充值」这个唯一有效动作。
      const code = response.status === 402 ? 'QUOTA_EXCEEDED' : httpErrorCode(response.status)
      // ⚠️⚠️ **签名类错误必须翻译成人话**（2026-10-07 实测）。
      // 服务端对「缺签名头」的两个文案**都具有误导性**：
      //   `40301` → 「检测到客户端版本过低，请检查新版本并升级以继续使用」
      //   `40104` → 「unsupported sign version」
      // 前者会让人去改 `X-App-Version`（**实测与版本号无关**：2.5.3→3.0.0 结果一致）；
      // 后者是英文、且不提「哪一组头」。⇒ 这里补一句指向真正原因的说明，
      // 否则下一个排查的人会重走我走过的弯路。
      const signingHint = looksLikeSigningError(text)
        ? '（该错误表示推理端点的**签名头**缺失或不被接受：'
        + '服务端文案「版本过低」与实际原因无关，请不要去改 X-App-Version；'
        + '见 src/teleagent.ts 的 teleagentSignHeaders）'
        : ''
      throw new LlmError(
        `teleagent: HTTP ${response.status}`
        + `${text === '' ? '' : ` — ${errorDetail(text).slice(0, 500)}`}${signingHint}`,
        code,
        { status: response.status },
      )
    }
    if (response.body === null) {
      throw new LlmError('teleagent: 响应缺少 body', 'EMPTY_RESPONSE')
    }

    yield* consumeOpenAiSse(
      response,
      { signal: options.signal },
      {
        label: this.product.id,
        firstTokenTimeoutMs: 120_000,
        chunkTimeoutMs: 120_000,
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
      },
    )
  }
}

/** 在 `ctx.llm` 上注册 teleagent provider 路由与适配器。 */
export function registerTeleagentLlm(
  ctx: Context,
  options: TeleagentAdapterOptions,
): TeleagentAdapter {
  const product = options.product ?? TELEAGENT
  const adapter = new TeleagentAdapter(options)
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  return adapter
}
