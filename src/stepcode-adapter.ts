/**
 * Step Code 模型适配器。
 *
 * ## 协议族 = OpenAI 兼容（无加密、无签名、单 Bearer 头）
 *
 * `POST https://api.stepfun.com/step_plan/v1/chat/completions`，
 * 请求体是标准 OpenAI 形状，响应是标准 SSE。
 * ⇒ 消息序列化与 SSE 消费**复用** `src/openai-compat.ts`
 * （`serializeMessages` / `consumeOpenAiSse` / 错误归类），
 * **不**新建 messages 层。这是本仓库**最薄**的一个适配器
 * （比 teleagent 还薄：那边要双凭据头 + HMAC 签名）。
 *
 * ⚠️ 协议族的判定依据与「文档 vs 代码」冲突的裁决见
 * `stepcode-product.ts` 模块头（结论：**openai-completions**，
 * 由 bundle 的 `STEP_MODEL_API` 与官方 DSH 集成文档双源印证）。
 *
 * ## 思考档位：远端下发 `reasoning_effort_support_list`
 *
 * 官方 `fetchStepModels()` 逐模型读取该字段，`stepModelConfig()` 再把它转成
 * pi 的 `thinkingLevelMap`；请求侧由 pi 的 openai-completions 适配器在
 * `compat.supportsReasoningEffort` 为真时写入 **`reasoning_effort`**。
 *
 * 我们的三条口径（照官方，不发挥）：
 * 1. **只声明远端真有的档位** —— 空/缺失 ⇒ 整个 `reasoning` 键不产出，
 *    UI 显示「当前模型未提供推理等级」。⚠️ **不要**按截图或直觉补档位
 *    （AGENTS.md 在 Qoder `qmodel` 上记过「没有档位就是没有」的教训）。
 * 2. **不声明 `defaultEffort`** —— 远端**没有**下发默认档
 *    （`reasoning_effort_support_list` 是个纯数组，没有 `is_default`）。
 *    DSH 的类型注释明示：*"`defaultEffort` … Absence preserves the
 *    provider's own default"*，即缺席就是「跟随上游默认」，这正是我们要的。
 *    ⚠️ 硬编一个默认档（比如 `high`）会**顶格消耗思考 token**，
 *    而思考 token 计入 `completion_tokens`、与正文共享额度
 *    （AGENTS.md 在 TRAE 那条记过这个代价）。
 * 3. **档位值原样下发**，不做白名单校验 —— 校验只会把「服务端新增档位」
 *    变成静默丢弃（与 TRAE 的 `reasoning_effort` 处理同口径）。
 *
 * ## 图片：按模型的 `enable_vision_input` 判定，不支持就**报错**
 *
 * ⚠️ 收到图片但模型不支持时抛 `UNSUPPORTED_CONTENT`，**绝不静默丢图**
 * （静默会让用户以为模型看到了图片 —— 与 cline / lobsterai / minimax /
 * teleagent 的既有契约一致）。
 *
 * ## `defaultMaxTokens`：**刻意不声明**
 *
 * 官方 `stepModelConfig()` 写的是 `maxTokens: contextWindow`（输出上限 = 上下文窗口），
 * 但那是 pi 内部用于 **clamp** 的上限，不是要发给服务端的值。
 * DSH 的 `defaultMaxTokens` 会被**物化进请求**（类型注释：*"materialized when
 * callers omit one"*）—— 照搬就会给每个请求塞一个 1M 的 `max_tokens`。
 * 远端目录**没有**独立的输出上限字段 ⇒ 保守不声明，让调用方/DSH 决定。
 */

import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
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
  STEPCODE,
  STEPCODE_EFFORT_NAMES,
  STEPCODE_REQUEST_TIMEOUT_MS,
  stepcodeChatUrl,
  type StepcodeProduct,
} from './stepcode-product.js'
import {
  isStepcodeExpired,
  stepcodeAuthHeaders,
  stepcodeBearerToken,
  stepcodeFallbackEntries,
  type StepcodeCredential,
  type StepcodeModelEntry,
} from './stepcode.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'

/** {@link StepcodeAdapter} 的构造选项。 */
export interface StepcodeAdapterOptions {
  /** 单凭据回退 ref（无账号池时）。 */
  credentialRef: CredentialRef
  /** 解析当前可用凭据。 */
  resolveCredential: (modelId?: string) => Promise<StepcodeCredential | undefined>
  /** 凭据失效时的处理（本 provider 是「探测有效性」）。 */
  refresh: () => Promise<void>
  /** 拉取远端模型目录；失败/缺省时适配器回退兜底表。 */
  fetchRemoteModels?: () => Promise<readonly StepcodeModelEntry[]>
  /** 账号池（目录门控与黑名单）。 */
  accountPool?: AccountPool
  /** 内联一张图片（`ctx.attachments.readImage` 桥接）。 */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 产品配置；默认 {@link STEPCODE}。 */
  product?: StepcodeProduct
}

/** Step Code 模型适配器。 */
export class StepcodeAdapter extends LlmAdapter {
  private readonly product: StepcodeProduct
  private remoteModels: readonly StepcodeModelEntry[] | undefined

  constructor(private readonly options: StepcodeAdapterOptions) {
    super()
    this.product = options.product ?? STEPCODE
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 取（并缓存）模型目录；远端失败回退兜底表。
   *
   * ⚠️⚠️ **空目录**绝不能**落缓存**（真实缺陷，2026-10-09 用户报障
   * 「模型列表里没有这个」）。
   *
   * ## 为什么这条对 Step Code 尤其致命
   *
   * `fetchRemoteModels()` 在**未登录**时必然返回空（`fetchModels` 取不到凭据
   * ⇒ 返回兜底表，而 Step Code 的兜底表**刻意为空** —— 官方 `STEP_MODELS = []`）。
   * 若把这个 `[]` 写进 `remoteModels`，那么第 123 行的
   * `if (this.remoteModels !== undefined) return this.remoteModels` 会**永远**
   * 短路 —— 用户随后完成登录、凭据已落盘，适配器也**再不会**去拉一次目录，
   * 表现为「登录成功了，但模型列表里始终没有这个 provider」，直到重启 DSH。
   *
   * ## 判据：缓存「成功的结果」，不缓存「失败/未就绪」
   *
   * `[]` 在本 provider 里**只有一种来源**：拉取失败或没有凭据。两种都是
   * **暂时**状态，不具备缓存价值 —— 故只在**非空**时才落缓存。
   * 代价是未登录期间每次 `listModels` 都会尝试一次拉取（那时它会在
   * 取凭据阶段就返回，不发网络请求），可接受。
   *
   * ⚠️ 这与 teleagent 的同名方法**刻意不同**：那边兜底表非空，
   * `fallback` 本身就是有效内容，落缓存是对的。改这里时别照抄。
   */
  private async loadModels(): Promise<readonly StepcodeModelEntry[]> {
    if (this.remoteModels !== undefined) return this.remoteModels
    if (this.options.fetchRemoteModels !== undefined) {
      try {
        const fetched = await this.options.fetchRemoteModels()
        // ⚠️ 只在**非空**时落缓存（见方法头：空目录是暂时状态）。
        if (fetched.length > 0) {
          this.remoteModels = fetched
          return fetched
        }
        return fetched
      } catch {
        // 远端失败静默回退：模型目录是展示信息，不该让整个 provider 报错。
      }
    }
    // ⚠️ **兜底表也不落缓存**：Step Code 的兜底表恒为空，落缓存等于永久锁死
    // 空目录（同上）。非空的兜底表（如 teleagent）才需要缓存它。
    const fallback = stepcodeFallbackEntries(this.product)
    if (fallback.length > 0) this.remoteModels = fallback
    return fallback
  }

  /**
   * 丢弃目录缓存，使下一次 `listModels` / `resolveModel` 重新拉取。
   *
   * 供「登录成功后目录变可用」这类场景显式失效（RPC 侧亦可广播
   * `llm/adapters-updated` 让客户端重读）。**幂等**，可重复调用。
   */
  invalidateModelCache(): void {
    this.remoteModels = undefined
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
    const source = this.remoteModels ?? stepcodeFallbackEntries(this.product)
    return source.map((model) => ({ id: model.id, name: model.name }))
  }

  private inputModalitiesFor(entry: StepcodeModelEntry | undefined): readonly ('text' | 'image')[] {
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
    // ⚠️ **不声明 `defaultMaxTokens`**，理由见模块头（官方那个
    // `maxTokens: contextWindow` 是 pi 的 clamp 上限，不是发送值）。

    // 思考档位：只声明远端真有的；无档位 ⇒ 不产出 `reasoning` 键。
    const efforts = entry?.efforts
    if (efforts !== undefined && efforts.length > 0) {
      resolved.reasoning = {
        efforts: efforts.map((id) => ({
          id: ReasoningEffortId(id),
          // DSH 直接渲染 `name`（不本地化）⇒ 给中文即中文界面。
          name: STEPCODE_EFFORT_NAMES[id] ?? id,
        })),
        // ⚠️ 刻意不给 `defaultEffort`（远端未下发默认档，缺席即「跟随上游」）。
      }
    }
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
    if (credential === undefined || isStepcodeExpired(credential)) {
      await this.options.refresh()
      credential = await this.options.resolveCredential(options.model)
    }
    if (credential === undefined || stepcodeBearerToken(credential) === undefined) {
      throw new LlmError('stepcode: no usable credential; log in first', 'MISSING_CREDENTIAL')
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
          `stepcode: 模型 "${options.model}" 不支持图片输入`,
          'UNSUPPORTED_CONTENT',
        )
      }
      if (this.options.readImage === undefined) {
        throw new LlmError('stepcode: 图片输入需要附件服务（readImage 未提供）', 'UNSUPPORTED_CONTENT')
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
    // ⚠️ 思考档位原样下发（不做白名单校验，理由见模块头第 3 条）。
    // 官方 pi 侧写的就是这个字段名（`params.reasoning_effort = effort`）。
    if (options.reasoningEffort !== undefined) {
      body.reasoning_effort = String(options.reasoningEffort)
    }

    const response = await fetch(stepcodeChatUrl(this.product), {
      method: 'POST',
      headers: stepcodeAuthHeaders(credential),
      body: JSON.stringify(body),
      signal: options.signal ?? AbortSignal.timeout(STEPCODE_REQUEST_TIMEOUT_MS),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new LlmError(
        `stepcode: HTTP ${response.status}`
        + `${text === '' ? '' : ` — ${errorDetail(text).slice(0, 500)}`}`,
        httpErrorCode(response.status),
        { status: response.status },
      )
    }
    if (response.body === null) {
      throw new LlmError('stepcode: 响应缺少 body', 'EMPTY_RESPONSE')
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

/** 在 `ctx.llm` 上注册 stepcode provider 路由与适配器。 */
export function registerStepcodeLlm(
  ctx: Context,
  options: StepcodeAdapterOptions,
): StepcodeAdapter {
  const product = options.product ?? STEPCODE
  const adapter = new StepcodeAdapter(options)
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  return adapter
}
