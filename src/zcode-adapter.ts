/**
 * ZCode（智谱 z.ai 免费额度）LLM 适配器。
 *
 * ## 与其它 provider 的共同点
 *
 * 「读凭据 → 直发远端」—— 这一点与 CodeArts / Buddy / Qoder 等**相同**。
 * 用户装好官方 ZCode 客户端并登录一次即可，不需要任何实例常驻。
 *
 * ## 与其它 provider 的差异（全部实测）
 *
 * | 维度 | ZCode | 对照 |
 * |---|---|---|
 * | 凭据来源 | 解密磁盘 `~/.zcode/v2/credentials.json`（AES-256-GCM） | 浏览器登录拿 token |
 * | 协议 | **Anthropic Messages**（非 OpenAI） | 其余多为 OpenAI 兼容 |
 * | 每请求前置 | **产出一个阿里云 captcha**（约 1.2 秒） | 无 |
 * | 请求体准入 | **必须带官方身份块 + 首轮日期块**（否则 3012） | 无 |
 * | 续期 | 无（静态凭据） | 多数有 refresh_token |
 *
 * ## 三个必须真的做到的点
 *
 * 1. **`system` 必须带官方身份块** —— 缺了上游回 `3012 unusual activity`
 *    （实测矩阵见 `zcode-identity.ts`）。且这是**请求体内容**层面的判据，
 *    与 HTTP 头、运行时无关。
 * 2. **首轮 user 消息要带 `<system-reminder>` 日期块** —— 桥侧源码称之为
 *    「3012 的最后一个开关」。
 * 3. **`tools` 必须真的下发**（转成 Anthropic 的扁平 `input_schema` 形态）——
 *    Qoder 与 TRAE 都因漏发而让模型在正文里臆造 XML 工具调用、harness
 *    认不出 → 任务终止。
 *
 * ## ⚠ captcha 是每请求一次，且**不能复用**
 *
 * 上游对缺失 captcha 的请求回 `3007`。而 captcha param **一次性**——
 * 复用同一个会再得 `3007`（实测：同一页面上重复 mint 必 `F001`）。
 * 故每次 `stream()` 都要产出一个新 param（约 1.2 秒）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { EMPTY_RESPONSE_CODE, LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { AccountPool, providerCatalogVisible } from './account-pool.js'
import { collectImages, serializeMessages } from './openai-compat.js'
import { projectRequestImage, type ImageRequestTarget } from './image-budget.js'
import type { ZcodeCredential } from './zcode.js'
import { ZCODE, type ZcodeFallbackModel, type ZcodeProduct, type ZcodeRemoteModelLike } from './zcode-product.js'
import {
  ZCODE_PLAN_MESSAGES_URL,
  buildZcodeHeaders,
} from './zcode-upstream.js'
import {
  buildZcodeSystemBlocks,
  withContextPrefix,
} from './zcode-identity.js'
import {
  consumeAnthropicSse,
  toAnthropicMessages,
  toAnthropicTools,
} from './zcode-anthropic.js'
import {
  ZcodeCaptchaBrowser,
  ZCODE_CAPTCHA_FALLBACK,
  type ZcodeCaptchaConfig,
} from './zcode-captcha.js'
import { GateAbortedError, ModelGate } from './model-gate.js'
import { nextUtc8DayStartMs } from './model-queue.js'
import {
  registerAdapterIdempotent,
} from './llm-register-compat.js'

/** 本适配器注册的 provider 路由名（等价于 `ZCODE.id`）。 */
export const PROVIDER = 'zcode'

/** 远端模型条目（已归一）。 */
export type ZcodeRemoteModel = ZcodeRemoteModelLike

/**
 * 思考档位的**展示名**。
 *
 * ⚠ **只用于展示** —— 发给上游的 `id` 必须保持小写（见 `resolveModel`）。
 * 两者混用会让上游认不出档次，是本仓库 qoder 那边记过的同型风险。
 *
 * 上游没提供档位的 i18n 名（`app.asar` 里搜不到，官方 IDE 也直接显示
 * `low`/`high`/`max`），故按用户要求用**首字母大写**：
 * 小写形态在 DSH 的选择器里看着像标识符而不像可选项。
 *
 * 未知档位原样返回（上游加了新档位时不至于显示成空白）。
 */
export function reasoningEffortLabel(id: string): string {
  if (id.length === 0) return id
  return id.charAt(0).toUpperCase() + id.slice(1)
}

/** 兜底表条目转远端形状。 */
function fallbackToRemote(model: ZcodeFallbackModel): ZcodeRemoteModel {
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    supportsImage: model.supportsImage,
    /**
     * ⚠ **档位必须一起搬** —— 漏了它，`resolveModel()` 就拿不到
     * `reasoningLevels`，思考档位选择器不会出现（用户报障的那个缺陷）。
     */
    ...model.reasoningLevels !== undefined ? { reasoningLevels: model.reasoningLevels } : {},
    ...model.defaultReasoningLevel !== undefined
      ? { defaultReasoningLevel: model.defaultReasoningLevel }
      : {},
  }
}

/**
 * 只放行**安全正整数**。
 *
 * ⚠ 远端是外部输入：`0` / 负数 / `NaN` 会让 DSH 在
 * `defaultMaxTokens` 的硬校验上抛 `INVALID_MODEL_MAX_TOKENS`，
 * **整轮对话起不来**（不是降级，是崩）。
 */
function positiveMaxTokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** `ZcodeAdapter` 的构造选项。 */
export interface ZcodeAdapterOptions {
  /** 单凭据回退 ref（无账号池时）。 */
  credentialRef: CredentialRef
  /** 解析当前可用凭据。 */
  resolveCredential: (modelId?: string) => Promise<ZcodeCredential | undefined>
  /**
   * 凭据失效时的处理。
   *
   * ⚠ ZCode **不可续期**（凭据是静态的）。这个回调存在只是为了让适配器
   * 与其它 provider 同形；实现应当**重读磁盘凭据**而不是去调 refresh 端点。
   */
  refresh: () => Promise<void>
  /**
   * 产出一个**新鲜**的 captcha param。
   *
   * 由 `index.ts` 注入（它持有 `ZcodeAuth`，能从服务端拉 captcha 配置并
   * 驱动浏览器）。缺省时适配器会自建一个常驻浏览器。
   *
   * ⚠ `options.signal` 必须被**透传**到浏览器侧（`ZcodeCaptchaBrowser.mint`）：
   * captcha 的取页等待与 WebSocket 建连历史上都没有超时，
   * 不透传就等于「用户点停止也停不下来」（真实缺陷，2026-09-29）。
   */
  mintCaptcha?: (options?: { signal?: AbortSignal }) => Promise<string>
  /** captcha 的区域（进 `x-aliyun-captcha-verify-region`）。 */
  captchaRegion?: string
  /** 拉取远端模型目录；缺省用兜底表。 */
  fetchRemoteModels?: () => Promise<ZcodeRemoteModel[]>
  /** 账号池（目录门控与黑名单）。 */
  accountPool?: AccountPool
  /** 产品配置；默认 {@link ZCODE}。 */
  product?: ZcodeProduct
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
  /**
   * 就绪探测（可注入）。返回 false 时 `listModels` 返回空数组，
   * 让整个 provider 分组隐藏 —— 而不是留一个点不动的条目。
   *
   * 缺省实现 = 「磁盘上有没有可解密的凭据」。
   */
  isReady?: () => Promise<boolean>
  /**
   * 读取图片附件的原始字节（内联为 data URL 用）。
   *
   * ⚠ **图片链路的必需依赖**：DSH 的图片块只带 `attachment:{attachmentId}`，
   * 真正拿字节要经附件服务。缺了它图片会在序列化层变成
   * `[image unavailable]` 占位符（实测：模型回「没有收到任何图片」）。
   */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /**
   * 读取图片附件的**请求版本**（按预算缩放后的字节）。
   *
   * ⚠ 与 {@link readImage} 的错误契约相反：**不可用时要返回 `undefined`**
   * 而不是抛错，适配器据此回退原图。理由与桥接实现见
   * `src/index.ts` 的 `makeReadImageRequest`、`src/image-budget.ts` 的
   * `projectRequestImage`。
   */
  readImageRequest?: (
    ref: unknown,
    target: ImageRequestTarget,
  ) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 图片像素预算（原图回退前的缩放目标）。 */
  imagePixelBudget?: number
  /** 图片字节上限（请求版本的目标）。 */
  imageMaxBytes?: number
  /**
   * **本次请求实际正在使用的**账号 id（额度受限时标记它）。
   *
   * ⚠ 与 `qoder-adapter.ts` 的同名选项**同因**：必须是「池实际返回的那个账号」，
   * 而不是「池当前的默认账号」—— 一旦切到下一个账号，后者不会跟着变，
   * 用它标记会**反复标记同一个账号**，而新账号从未被标记，
   * 下次取号又把新账号选中，于是两个账号之间来回空转
   * （`qoder-adapter.ts` 的 `switchAccountOnQuota` 注释里记了这条实测）。
   *
   * 由 `index.ts` 在 `resolveCredential` 里记录实际返回的账号并提供。
   */
  currentAccountId?: () => string | undefined
  /**
   * 上游发车闸门（串行 + 按模型间隔）。
   *
   * 缺省时适配器**自建一个**（单实例即可满足「同一时刻一个上游请求」）。
   * 允许注入是为了单测能替换 sleep / clock，让用例毫秒级完成。
   */
  gate?: ModelGate
  /** 等待实现（注入以便单测；仅用于并发限流重试的退避）。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** ZCode 模型适配器。 */
export class ZcodeAdapter extends LlmAdapter {
  private readonly product: ZcodeProduct
  private readonly fetchImpl: typeof fetch
  /** 兜底模型索引（id → 条目）。 */
  private readonly fallbackIndex: ReadonlyMap<string, ZcodeFallbackModel>
  private remoteModels: ZcodeRemoteModel[] | undefined
  /** 自建的常驻浏览器（仅当调用方没注入 `mintCaptcha` 时用）。 */
  private captchaBrowser: ZcodeCaptchaBrowser | undefined
  /** captcha 配置缓存（配置很少变，但与凭据一样**不长期缓存**）。 */
  private captchaConfig: ZcodeCaptchaConfig | undefined
  /**
   * 上游发车闸门（串行 + 按模型最小间隔）。
   *
   * ⚠ 必须是**实例字段**（而不是每次请求新建）：闸门靠「共享的尾巴指针」与
   * 「跨请求记住上次发车时刻」生效，每次新建等于没有闸门。
   */
  private readonly gate: ModelGate
  /** 退避等待实现（注入以便单测毫秒级完成）。 */
  private readonly sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void>

  constructor(private readonly options: ZcodeAdapterOptions) {
    super()
    this.product = options.product ?? ZCODE
    this.fetchImpl = options.fetchImpl ?? fetch
    this.fallbackIndex = new Map(this.product.fallbackModels.map((model) => [model.id, model]))
    this.gate = options.gate ?? new ModelGate({
      serialize: this.product.serializeUpstream,
      gaps: this.product.modelGapMs,
    })
    this.sleepImpl = options.sleep ?? defaultAdapterSleep
  }

  /**
   * 描述本适配器拥有的 provider 路由。
   *
   * 对入参做防御性归一化：DSH 会强制校验 `info.id === provider`，
   * 而模型设置页会用该 id 计算 `deriveKeyRef(provider)`
   * （内部调 `provider.toUpperCase()`）。一旦 provider 不是字符串，
   * 直接回退到本产品的 id。
   */
  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 完整目录（**不套黑名单**），带最终展示名。
   *
   * 设置页需要它渲染被关闭的模型 —— 否则那些条目只能凭 `disabledMap` 的 key
   * 补回，而那条路径拿不到展示名，会退化成裸 id
   * （`AGENTS.md` 记过 Raccoon 的同款用户报障）。
   */
  listAllModels(): readonly { id: string; name: string }[] {
    const source = this.remoteModels ?? this.product.fallbackModels.map(fallbackToRemote)
    return source.map((model) => ({ id: model.id, name: model.name }))
  }

  /** 取（并缓存）远端模型目录；失败时回退兜底表。 */
  private async loadModels(): Promise<ZcodeRemoteModel[]> {
    if (this.remoteModels !== undefined) return this.remoteModels
    if (this.options.fetchRemoteModels !== undefined) {
      try {
        const fetched = await this.options.fetchRemoteModels()
        if (fetched.length > 0) {
          this.remoteModels = fetched
          return fetched
        }
      } catch {
        // 远端失败静默回退兜底表：模型目录是展示信息，不该让整个 provider 报错。
      }
    }
    const fallback = this.product.fallbackModels.map(fallbackToRemote)
    this.remoteModels = fallback
    return fallback
  }

  private inputModalitiesFor(model: ZcodeRemoteModel | undefined): readonly ('text' | 'image')[] {
    return model?.supportsImage === true ? ['text', 'image'] : ['text']
  }

  /** 就绪判据：默认看磁盘上有没有可用凭据。 */
  private async ready(): Promise<boolean> {
    if (this.options.isReady !== undefined) {
      try {
        return await this.options.isReady()
      } catch {
        return false
      }
    }
    try {
      return (await this.options.resolveCredential()) !== undefined
    } catch {
      return false
    }
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // ⚠ 未就绪时返回 `[]` → DSH 的 buildModelCatalog 把整个 provider 分组隐藏。
    // **必须返回空数组而不能抛错**（抛错会被归入 catalog 的 failures，
    // 界面上反而多一条 provider 报错）。
    if (!await this.ready()) return []
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
    const fallback = this.fallbackIndex.get(model)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: entry?.name ?? fallback?.name ?? model,
      inputModalities: this.inputModalitiesFor(entry),
    }
    const contextWindow = entry?.contextWindow ?? fallback?.contextWindow
    // 未知模型不编造 context（宁可让 DSH 用默认值，也不报一个假窗口）。
    if (contextWindow !== undefined && contextWindow > 0) {
      resolved.context = { contextWindow }
    }
    const maxTokens = positiveMaxTokens(entry?.maxTokens ?? fallback?.maxTokens)
    if (maxTokens !== undefined) resolved.defaultMaxTokens = maxTokens
    /**
     * ★ **思考档位必须在这里声明** —— 否则 DSH 的选择器根本不出现。
     *
     * ⚠ **真实缺陷**（用户报障）：「使用 zcode 的 glm-5.3-flash 没法选中思考档位，
     * 而 ZCode 自己可以设置」。根因与本仓库 qoder 那次**完全同型**：
     * DSH 的档位选择器**只**从 `resolveModel().reasoning` 渲染
     * （`dsh-client-ui-model-selection`：`reasoning === undefined ? [] : …efforts`），
     * 只声明 `context` 是不够的。
     *
     * 档位来自上游 `client/configs` 的
     * `builtinModels[].reasoning.{levels, defaultLevel}`：
     *   - `levels` 的**键序**即展示顺序（实测 `low` / `high` / `max`）
     *   - `defaultLevel` 实测为 `max`
     *
     * ⚠ `defaultEffort` **必须落在 `efforts` 内**，否则不发 ——
     * 指向不存在的选项会让选择器显示空白（qoder 那边的既有约定）。
     */
    const levels = entry?.reasoningLevels ?? fallback?.reasoningLevels
    if (levels !== undefined && levels.length > 0) {
      const defaultLevel = entry?.defaultReasoningLevel ?? fallback?.defaultReasoningLevel
      resolved.reasoning = {
        /**
         * ⚠ **`id` 必须保持小写**（`low`/`high`/`max`）—— 它是要发给上游的
         * 协议值（`output_config.effort`），官方 `client/configs` 里就是小写。
         * 改成大写会让上游认不出档次（通常静默忽略整个字段）。
         *
         * **展示名**按用户要求用大写（`Low`/`High`/`Max`）：DSH 的选择器
         * 直接渲染 `efforts[].name`（不本地化、不查字典），故给什么显示什么。
         * 小写形态（`max`/`high`/`low`）在 UI 里看着像标识符而不像选项。
         *
         * ⚠ `ReasoningEffortId` 是 branded 类型，必须用构造函数（同 qoder 的写法）。
         */
        efforts: levels.map((id) => ({ id: ReasoningEffortId(id), name: reasoningEffortLabel(id) })),
        ...defaultLevel !== undefined && levels.includes(defaultLevel)
          ? { defaultEffort: ReasoningEffortId(defaultLevel) }
          : {},
      }
    }
    return resolved
  }

  /**
   * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调用
   * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
   * 基类尚未提供该方法。与其余适配器同款 shim。
   */
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

  /** 取得 captcha param（注入优先，否则自建常驻浏览器）。 */
  private async mintCaptcha(options: { signal?: AbortSignal } = {}): Promise<string> {
    if (this.options.mintCaptcha !== undefined) return await this.options.mintCaptcha(options)
    if (this.captchaBrowser === undefined) this.captchaBrowser = new ZcodeCaptchaBrowser()
    return await this.captchaBrowser.mint(
      this.captchaConfig ?? ZCODE_CAPTCHA_FALLBACK,
      options,
    )
  }

  /** 允许外部（`index.ts`）设置服务端下发的 captcha 配置。 */
  setCaptchaConfig(config: ZcodeCaptchaConfig | undefined): void {
    this.captchaConfig = config
  }

  /**
   * ★★ 超时与中断的**作用域**：必须覆盖整轮
   * （captcha 产出 → 请求 → **流式读取**）。
   *
   * ## 为什么必须搬到这一层（真实缺陷，2026-09-29）
   *
   * 旧实现把 `setTimeout(abort)` 与 `removeEventListener('abort')` 放在
   * **`fetch` 的 `finally`** 里 —— 那个 `finally` 在「响应头回来」时**就已执行**，
   * 于是：
   *
   * 1. **流式读取阶段完全没有超时**：`requestTimeoutMs`（180s）形同虚设；
   * 2. **用户中断的通道在流开始之前就被摘掉**：`options.signal` 的 abort
   *    不再转发给 `controller`，`response.body` 的读取永不中止。
   *
   * 两者叠加的后果正是用户报障（本机实测三次、含一次 1018.7 秒）：
   * UI 停在「深度求索中，用时 5分27秒…」不动，模型既不输出思考也不输出正文，
   * **「停止」按钮点了没反应，只能重启宿主**。
   *
   * ⚠ 会话日志里的收尾事件 `step/end` + `turn/end{kind:'interrupted'}` 与
   * `step/start` **同一毫秒** —— 那是 `dsh-session` 的 `openTurnClosers()`
   * 在 repair 时**合成**的（它「复用最后一个真实事件的时间戳」），
   * 真相是这个 turn **从未结束**。排查时别被它误导。
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const controller = new AbortController()
    const timeoutMs = this.product.requestTimeoutMs
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    // 把调用方的 signal（harness 的用户中断）串进来，作用于**整轮**。
    const onAbort = (): void => controller.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      yield* this.streamScoped(options, controller, timeoutMs)
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * `stream()` 的实际实现。
   *
   * ⚠ `controller` 由调用方传入（而不是在这里新建）：它的 signal 必须同时
   * 管住 **captcha 产出** 与 **SSE 读取**，见 `stream()` 的说明。
   */
  private async *streamScoped(
    options: GenerateOptions,
    controller: AbortController,
    timeoutMs: number,
  ): AsyncIterable<StreamChunk> {
    /**
     * ## 图片：**支持**（曾经误判为不支持，且实现里根本没有图片代码）
     *
     * ### 误判的经过
     *
     * 早期这里有一个「显式拒绝图片」的守卫，理由是「该通道图片链路未验证」。
     * **那是错的** —— 用户实测在 ZCode IDE 里用同一个 `GLM-5.3-Flash`
     * 发图片能**正确理解**（描述出了一张足球截图里的拉拽犯规、红色箭头、
     * bilibili 水印等细节）。
     *
     * ### 更深一层的问题（删掉守卫也不够）
     *
     * 删掉守卫后实测：模型回「我在当前对话中没有收到任何图片」。
     * 根因是**本适配器完全没有图片处理代码** ——
     * 缺了 `collectImages` / `readImage` / `imageUrls` 三件事：
     *
     * ```
     * DSH 的图片块 = { type:'image', attachment:{ attachmentId } }
     *   ├─ collectImages()  收集 attachmentId → ref        ← 我们没做
     *   ├─ readImage(ref)   读原始字节 → data URL          ← 我们没做
     *   └─ imageUrls.set(id, url) 交给 serializeMessages   ← 我们没做
     * ```
     * 缺了它们，`serializeMessages` 拿到的是**空映射**，
     * 于是只产出 `[image unavailable]` 占位符 —— 图片在序列化层就丢了。
     *
     * ### 上游形态（逆向官方 agent `resources/glm/zcode.cjs`）
     *
     * 官方 Anthropic 路径把图片序列化成：
     * ```js
     * { type:"image",
     *   source:{ type:"base64",
     *            media_type: mediaType === "image/*" ? "image/jpeg" : mediaType,
     *            data: <base64> } }
     * ```
     * 与 `zcode-anthropic.ts` 的 `toImageBlock()` 一致。
     */
    const imageRefs = new Map<string, unknown>()
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    let imageUrls: Map<string, string> | undefined
    if (imageRefs.size > 0) {
      /**
       * ⚠ 能力声明与行为必须一致：`inputModalities` 没报 `image` 的模型
       * 不该收到图片块（DSH 会按播报值决定是否投影成文本占位符）。
       */
      const all = await this.loadModels()
      const entry = all.find((item) => item.id === options.model)
      if (!this.inputModalitiesFor(entry).includes('image')) {
        throw new LlmError(
          `zcode: 模型 "${options.model}" 不支持图片输入`,
          'UNSUPPORTED_CONTENT',
        )
      }
      if (this.options.readImage === undefined) {
        throw new LlmError(
          'zcode: 图片输入需要附件服务（宿主未提供 attachments.readImage）',
          'UNSUPPORTED_CONTENT',
        )
      }
      /**
       * ⚠ 保留**空 Map**（而非降级为 undefined）：图片存在但全部读取失败时，
       * 空 Map 仍会让 `userContentParts` 产出 `[image unavailable]` 占位符 ——
       * 比静默丢图好（模型至少知道"本该有图"）。
       */
      imageUrls = new Map()
      const readImage = this.options.readImage
      for (const [id, ref] of imageRefs) {
        try {
          /**
           * ⚠ 优先用**请求版本**（按字节/像素预算缩放后的）。
           *
           * ZCode 免费通道的请求体没有实测的硬上限，但 base64 后的截图很大
           * （2560×1600 各约 3.9 MB），两张就接近常见网关的 10MB 门槛。
           * `projectRequestImage` 拿不到时**返回 undefined**（不抛错），
           * 此时回退原图 —— 与 raccoon 的同款约定。
           */
          const projected = await projectRequestImage(ref, {
            readImageRequest: this.options.readImageRequest,
            pixelBudget: this.options.imagePixelBudget,
            maxBytes: this.options.imageMaxBytes,
          })
          const image = projected ?? await readImage(ref)
          if (image === undefined) continue
          imageUrls.set(
            id,
            `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`,
          )
        } catch {
          // 单张图读取失败不影响其余 —— 它会在序列化层变成占位符。
        }
      }
    }

    /**
     * 1. 取凭据（ZCode 恒不「过期」，这个调用是形状对齐）。
     *
     * ⚠ 凭据在下面可能因「额度用尽」被**整体换掉**（切号），故它是 `let`。
     * 同时维护 `tried` 集合与「当前实际使用的账号」—— 两者的语义与必要性
     * 见 {@link ZcodeAdapter.switchAccountOnQuota}。
     */
    const tried = new Set<string>()
    let activeAccountId = this.options.currentAccountId?.()
    if (activeAccountId !== undefined && activeAccountId.length > 0) tried.add(activeAccountId)
    let credential = await this.resolveCredentialOrThrow(options)

    /**
     * 2. 构造请求体（**Anthropic Messages 格式**）。
     *
     * ⚠ 这一段**只依赖 messages / system / model**，与 captcha、凭据都无关 ——
     * 故提到重试循环**之外**只构建一次，重试与切号时复用同一份 body。
     * 「每轮必须新产」的只有 captcha 与依赖它的 headers（见下面的双层循环）。
     *
     * ⚠ 三个必须做对的点：
     *   - `system` 是顶层块数组，且第一块必须是官方 `cliPrefix`
     *     （缺了回 3012）
     *   - 首轮 user 消息要带 `<system-reminder>` 日期块
     *   - `tools` 是**扁平** `input_schema` 形态（不是 OpenAI 的嵌套 `function`）
     */
    const wire = serializeMessages(options.messages, imageUrls)
    const messages = withContextPrefix(toAnthropicMessages(wire))
    const system = buildZcodeSystemBlocks(options.system, {
      cwd: process.cwd(),
      provider: this.product.id,
      model: options.model,
    })

    const body: Record<string, unknown> = {
      model: options.model,
      max_tokens: options.maxTokens ?? 8192,
      system,
      messages,
      stream: true,
    }
    if (options.temperature !== undefined) body.temperature = options.temperature
    if (options.stop !== undefined && options.stop.length > 0) body.stop_sequences = options.stop
    // ⚠ tools 必须真的下发（Anthropic 扁平形态）。
    if (options.tools !== undefined && options.tools.length > 0) {
      const tools = toAnthropicTools(options.tools)
      /**
       * ★ 给**最后一个** tool 打 prompt caching 断点（前缀式缓存 ⇒ 覆盖
       * 「system + 全部 tools」整段）。详见 {@link withToolCacheBreakpoint}
       * 与 `dsh-free-glm` 的 P0-2 实测（24 个工具、19492 字节、零断点）。
       */
      body.tools = this.product.toolCacheBreakpoint === true
        ? withToolCacheBreakpoint(tools)
        : tools
    }
    /**
     * ★ **思考档位下发为 `output_config.effort`**。
     *
     * ⚠ 协议名**不是** `reasoning_effort`（那是我一开始的猜测）。权威依据是
     * 上游 `client/configs` 里每个档位自带的写法：
     *
     * ```json
     * { "path": ["output_config", "effort"], "value": "low" | "high" | "max" }
     * ```
     *
     * 即官方把「怎么表达这个档位」也下发了 —— 照抄即可，不要自己发明字段名。
     *
     * ⚠ 只在**模型确实声明了该档位**时才写：未知档位直接下发可能被上游拒，
     * 而请求体一旦被拒整个推理就失败了（档位只是锦上添花）。
     * 也不发默认值 —— 上游有自己的 `defaultLevel`，我们别去覆盖它。
     */
    const effort = options.reasoningEffort
    if (effort !== undefined && effort.length > 0) {
      const all = await this.loadModels()
      const entry = all.find((item) => item.id === options.model)
      const levels = entry?.reasoningLevels
      if (levels !== undefined && levels.includes(effort)) {
        body.output_config = { effort }
      }
    }

    /**
     * ⚠ **headers 不在这里构造** —— 它依赖 captcha param，而 captcha 必须
     * **每一轮重试都重新产出**（一次性）。故 headers 的构造在下面的
     * 双层循环内、内层循环的第一行之后（见那里的说明）。
     */

    /**
     * ⚠ 超时收尾必须报 `TIMEOUT`，不能退化成「空回复」之类的模糊错误。
     *
     * 触发路径：上游回 200 但**长时间不吐任何数据** → 上一层的 timer 到点
     * `controller.abort()` → `iterateSseFrames` 的 abort 监听 `reader.cancel()`
     * 唤醒挂起的 `read()` → 流以「一帧都没有」结束。若不在这里翻译，
     * 用户看到的就是 `EMPTY_RESPONSE`（说不清是超时还是模型抽风）。
     *
     * ⚠ 判据必须排除**用户中断**：那种情况该原样上抛，
     * 让 harness 归为 aborted（而不是当成可重试的失败）。
     */
    const timedOut = (): boolean =>
      controller.signal.aborted && options.signal?.aborted !== true
    const timeoutError = (cause?: unknown): LlmError =>
      new LlmError(
        `zcode: 请求超时（${timeoutMs}ms 内未完成）—— 上游可能长时间不返回数据`,
        'TIMEOUT',
        cause === undefined ? undefined : { cause: cause as Error },
      )

    /**
     * ===== 双层重试循环（吸收自 `dsh-free-glm`，2026-09-30）=====
     *
     * ## 为什么分两层（两种 429 的处置**完全不同**）
     *
     * 上游的 `429` 有两个语义（详见 {@link isZcodeConcurrencyLimited} /
     * {@link isZcodeQuotaExhausted}）：
     *
     * | 层 | 触发 | 动作 | 依据 |
     * |---|---|---|---|
     * | **内层** | `3009` 并发限流 | 退避后**重新 mint captcha** 再试 | 等一下就能过；旧 captcha 已消费 |
     * | **外层** | `1005`/`1113` 额度用尽 | **标记该账号 + 换下一个账号** | 确定性错误，重试无意义 |
     * | **外层** | 秒回空（`<3s` + 无内容） | 同上（无权益） | 那边的实测：秒回空 = 实例拿不到该模型的鉴权材料 |
     *
     * ⚠ **重试前必须重新 mint captcha** —— captcha param 是一次性的，
     * 沿用旧的必得 `3007`（那边的注释把这个记为「第二轮修正」的坑）。
     * 本实现把 mint 放在**内层循环的第一行**，天然满足。
     *
     * ⚠ **以 `emitted` 为闸**：一旦已经向调用方 yield 过内容，
     * 就**不许**再切号/重试 —— 那会让用户看到两份重复输出。
     * HTTP 层错误与「空响应」都发生在任何输出之前，故不受此限。
     */
    for (let quotaRound = 0; ; quotaRound += 1) {
      let response: Response | undefined
      /** 本轮是否因额度用尽而成功切号（决定 continue 外层）。 */
      let switchedAccount = false

      // ── 内层：并发限流重试（每轮都用一个**新的** captcha）──────────────
      for (let attempt = 0; ; attempt += 1) {
        // ⚠ 每轮重新产：captcha **一次性**，复用会让上游回 `3007`。
        //   也必须吃 signal：captcha 侧存在**无超时的等待**（见 `zcode-captcha.ts`），
        //   一旦命中就是无输出的永久挂起 —— 与流式读取那条通道同型。
        const captchaParam = await this.mintCaptcha({ signal: controller.signal })
        const headers = buildZcodeHeaders(credential, {
          authorization: `Bearer ${credential.zcode_jwt}`,
          captcha: {
            param: captchaParam,
            region: this.options.captchaRegion ?? 'cn',
          },
        })

        response = await this.sendUpstream({
          headers,
          body,
          signal: controller.signal,
          userSignal: options.signal,
          timeoutMs,
          model: options.model,
        })
        if (response.ok) break

        const text = await response.text().catch(() => '')

        // ① 额度用尽 / 无权益 → **换账号**（不是重试）
        if (isZcodeQuotaExhausted(response.status, text)) {
          if (quotaRound < this.product.quotaSwitchMax) {
            const switched = await this.switchAccountOnQuota(options, tried, activeAccountId)
            if (switched !== undefined) {
              credential = switched.credential
              activeAccountId = switched.accountId
              switchedAccount = true
              break
            }
          }
          /**
           * 无法再切（没有账号池 / 池里没有别的可用账号 / 已切够轮数）——
           * 如实报 `QUOTA_EXCEEDED`。
           *
           * ⚠ 必须是**不可重试**的码：`SERVER` 在 harness 的
           * `DEFAULT_RETRYABLE_CODES` 里，会让「额度已用尽」这种**确定性**
           * 错误被白退避重试 5 次（约 15.5 秒）—— qoder 那边记过同型缺陷。
           */
          throw new LlmError(
            `zcode: ${describeUpstreamError(response.status, text)}`,
            'QUOTA_EXCEEDED',
            { status: response.status },
          )
        }

        // ② 并发限流 → 退避 + 重新 mint 后再试（**不**换账号：换谁都一样撞）
        if (
          isZcodeConcurrencyLimited(response.status, text)
          && attempt < this.product.concurrencyRetryMax
        ) {
          const waitMs = zcodeConcurrencyRetryDelayMs(attempt, this.product.concurrencyRetryBaseMs)
          await this.sleepImpl(waitMs, controller.signal)
          continue
        }

        // ③ 其余错误：按既有映射如实抛出（3012 等不可重试类不变）
        throw new LlmError(
          `zcode: ${describeUpstreamError(response.status, text)}`,
          httpErrorCodeForZcode(response.status, text),
          { status: response.status },
        )
      }

      if (switchedAccount) continue
      if (response === undefined) {
        // 不可达：内层只可能 break（成功/切号）或 throw。
        throw new LlmError('zcode: 上游请求未发出（内部状态异常）', 'SERVER')
      }
      if (response.body === null) {
        /**
         * ★ 空 body **同样是「额度/权益」的形态之一**（真实缺陷，2026-10-01）。
         *
         * ## 为什么必须在这里也修（原先是个缺口）
         *
         * 「额度用尽」在 wire 上有**两种**表现，我们此前只处理了一种：
         *
         * | 形态 | 走到哪条分支 | 原行为 |
         * |---|---|---|
         * | HTTP 200 + **空 SSE 流**（0 帧） | `consumeAnthropicSse` 的 `!sawAny` | 已被修复覆盖 |
         * | HTTP 200 + **`body === null`** | **本行** | ❌ 抛裸 `EMPTY_RESPONSE`（缺口） |
         *
         * 后者在 `fetch` 的语义里是「响应没有 body 流」（某些网关形态、
         * 或 `Content-Length: 0`）。它**跳过了整个 SSE 消费**，于是
         * 上面那条修复**根本不会被触发** —— 用户仍会看到通用的
         * 「空响应」文案，且错误码仍在可重试集合里（白重试 5 次）。
         *
         * ⚠ 判据与 SSE 层保持一致：**先试换账号**（若还有可用账号），
         * 换不动就如实说「额度已用尽或没有可用权益」并抛 `QUOTA_EXCEEDED`。
         * 这里的空 body 是**立即**返回的（没有「慢回空 = 链路卡住」那种歧义），
         * 故无需耗时判断。
         */
        if (quotaRound < this.product.quotaSwitchMax) {
          const switched = await this.switchAccountOnQuota(options, tried, activeAccountId)
          if (switched !== undefined) {
            credential = switched.credential
            activeAccountId = switched.accountId
            continue
          }
        }
        throw new LlmError(
          zcodeEntitlementErrorMessage(options.model, tried.size),
          'QUOTA_EXCEEDED',
        )
      }

      /**
       * ── SSE 消费 ──────────────────────────────────────────────────────
       *
       * ⚠ signal 必须传进 SSE 消费：它是「读挂起」时唯一能唤醒读取的东西。
       */
      let emitted = false
      const consumeStartedAt = Date.now()
      try {
        for await (const chunk of consumeAnthropicSse(response.body, {
          label: 'zcode',
          model: options.model,
          signal: controller.signal,
        })) {
          emitted = true
          yield chunk
        }
      } catch (error) {
        if (timedOut()) throw timeoutError(error)
        /**
         * ★ **「秒回空」= 该账号对这个模型无权益 / 额度用尽** → 换账号重试。
         *
         * 判据是「**快速**（<3s）+ 内容为空」的**组合**，不是「空」本身 ——
         * 慢回且空说明链路卡住（有权益），换账号解决不了（见
         * {@link ZCODE_FAST_EMPTY_MS} 的实测表）。
         *
         * ⚠ 只在 `emitted === false` 时切：已吐过内容再重来会让用户看到两份输出。
         */
        if (!emitted && isFastEntitlementMiss(error, Date.now() - consumeStartedAt)) {
          // 还有账号可换 → 换号重发（`tried` 保证不会拿回刚失败的账号）。
          if (quotaRound < this.product.quotaSwitchMax) {
            const switched = await this.switchAccountOnQuota(options, tried, activeAccountId)
            if (switched !== undefined) {
              credential = switched.credential
              activeAccountId = switched.accountId
              continue
            }
          }
          /**
           * ★ 换不了账号了（没有池 / 池里没有别的可用账号 / 已切够轮数）——
           * 把**真实原因**如实说出来，而不是把 SSE 消费器那句通用的
           * 「模型返回了空响应」透传出去。
           *
           * ⚠ 同时把错误码从 `EMPTY_RESPONSE` 改成 `QUOTA_EXCEEDED`：
           * 前者**在** harness 的可重试集合里，会让「额度已用尽」这种
           * 确定性错误被白退避重试 5 次（用户截图里的「已重试 (5/5)」）。
           * 详见 {@link zcodeEntitlementErrorMessage} 的说明。
           */
          throw new LlmError(
            zcodeEntitlementErrorMessage(options.model, tried.size),
            'QUOTA_EXCEEDED',
            { cause: error as Error },
          )
        }
        throw error
      }
      if (timedOut()) throw timeoutError()
      break
    }
  }

  /**
   * 取一份可用凭据；两次都拿不到就报明确的「去登录」错误。
   *
   * 抽成方法是因为它现在出现在**切号循环之外**（凭据由循环内的切号逻辑更新），
   * 而「拿不到 → refresh → 再拿」这套顺序必须与既有实现逐字一致。
   */
  private async resolveCredentialOrThrow(options: GenerateOptions): Promise<ZcodeCredential> {
    let credential = await this.options.resolveCredential(options.model)
    if (credential === undefined) {
      await this.options.refresh()
      credential = await this.options.resolveCredential(options.model)
    }
    if (credential === undefined) {
      throw new LlmError(
        'zcode: 没有可用的凭据 —— 请在 Jet Hub 的 ZCode 面板点「添加账号」完成登录' +
        '（若已装官方 ZCode 客户端并登录过，本插件也会自动读取它的凭据）',
        'MISSING_CREDENTIAL',
      )
    }
    return credential
  }

  /**
   * 把**一次**上游请求经过闸门发出去，并把传输层异常翻译成 harness 的错误类别。
   *
   * ## 为什么必须经过闸门（`this.gate`）
   *
   * 上游 `429 code:3009` 是**并发配额** —— 同一时刻两个请求在飞，必有一个白撞。
   * 闸门还给「同一模型」加最小发车间隔（串行只保证不重叠，不保证有间隔）。
   * 依据与参数见 `model-gate.ts` 与 `zcode-product.ts` 的字段注释。
   *
   * ## ⚠ 闸门**只包这一下 fetch**，不包 captcha
   *
   * captcha 产出（几百毫秒到几秒）必须在闸门外 —— 否则会变成
   * 「排在 N 个请求后面再 mint」，那边的实测是 `mintMs` 从 200-500ms
   * 暴涨到 2500-3100ms。
   */
  private async sendUpstream(input: {
    headers: Record<string, string>
    body: Record<string, unknown>
    signal: AbortSignal
    userSignal: AbortSignal | undefined
    timeoutMs: number
    model: string
  }): Promise<Response> {
    const { headers, body, signal, userSignal, timeoutMs, model } = input
    try {
      return await this.gate.run(
        model,
        async () => await this.fetchImpl(ZCODE_PLAN_MESSAGES_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        }),
        { signal },
      )
    } catch (error) {
      /**
       * ⚠ 用户中断（无论是等待闸门还是 fetch 本身）**必须原样上抛** ——
       * 让 harness 归为 aborted；把它翻译成 TIMEOUT/TRANSPORT 会让
       * 「用户主动取消」变成「一次可重试的失败」（AGENTS.md 记过这条）。
       */
      if (error instanceof GateAbortedError) throw error
      if (userSignal?.aborted === true) throw error
      /**
       * ⚠ 超时必须归 `TIMEOUT`（它在 harness 的可重试集合里），不能混进
       * `TRANSPORT`：两者语义不同，文案也不该说「传输错误」。
       *
       * ⚠ 这里**不做** `clearTimeout` / `removeEventListener` —— 清理在
       * `stream()` 的 finally（覆盖整轮）。旧实现在 fetch 脚下就清理，
       * 于是流式读取阶段既无超时、也失了中断通道（见 `stream()` 的说明）。
       */
      if (signal.aborted) {
        throw new LlmError(
          `zcode: 请求超时（${timeoutMs}ms 内未完成）—— 上游可能长时间不返回数据`,
          'TIMEOUT',
          { cause: error as Error },
        )
      }
      throw new LlmError(
        `zcode: 请求失败：${error instanceof Error ? error.message : String(error)}`,
        'TRANSPORT',
        { cause: error as Error },
      )
    }
  }

  /**
   * 额度用尽 / 无权益时的**标记 + 换账号**。
   *
   * ## 与 `qoder-adapter.ts` 的同名方法同因同形（差异只在「标记到什么时候」）
   *
   * ⚠ **标记用的「当前账号」必须是调用方传入的 `activeAccountId`**，
   * 不能每次问 `this.options.currentAccountId()` —— 后者是「池当前的默认账号」，
   * 一旦切到下一个账号它**不会跟着变**：用它标记会**再标记一次旧账号**，
   * 而新账号从未被标记，下次取号又把新账号选中，于是在两个账号之间反复空转
   * （qoder 写单测时实测到了这一点：标记记录是 `['acct-A','acct-A']`）。
   *
   * ⚠ **必须把 `tried` 传给 `getAvailableAccount`**：池按用户手动顺序返回候选，
   * 刚失败的那个账号**可能仍排第一**，不排除就会拿回同一个、命中 `tried.has`
   * 而立即放弃切换（换号形同虚设）。
   *
   * ## 标记到什么时候
   *
   * ZCode 的免费额度是**按自然日**结算的（`billing/balance` 的桶带
   * `expires_at`，活动说明为「每日刷新」）。故与 qoder 一致取
   * **UTC+8 当日 24:00** —— 复用 `nextUtc8DayStartMs()`，**不**用
   * `parseRateLimitError` 的「1 小时后」兜底（那会让标记过早失效，
   * 用户 1 小时后再撞一次同样的墙）。
   *
   * ⚠ 只标记**该账号 + 该模型**（`updateModelRateLimit` 的既有语义）：
   * 额度是「账号 + 模型」维度的，同一账号在别的模型上仍可能可用。
   *
   * ⚠ **本条的「按模型」与 qoder 的「按账号」不冲突，别为了统一而改动**：
   * qoder 已改为标整账号，因为它有**跨模型实测证据**（同一账号换三个模型全被
   * code 110 拒，见 `qoder-adapter.ts`）。ZCode 目前**只有同模型下的证据**，
   * 没有跨模型证据 —— 无证据就扩大到整账号会误伤「该账号在本模型受限、
   * 别的模型仍可用」的场景。若哪天对 ZCode 取得跨模型证据，再照 qoder 改。
   */
  private async switchAccountOnQuota(
    options: GenerateOptions,
    tried: Set<string>,
    activeAccountId: string | undefined,
  ): Promise<{ credential: ZcodeCredential; accountId: string } | undefined> {
    const pool = this.options.accountPool
    if (pool === undefined) return undefined

    if (activeAccountId !== undefined && activeAccountId.length > 0) {
      await pool.updateModelRateLimit(activeAccountId, options.model, nextUtc8DayStartMs())
      tried.add(activeAccountId)
    }

    const next = await pool.getAvailableAccount(this.product.id, options.model, tried)
    if (next === null || next === undefined || tried.has(next.entry.id)) return undefined
    tried.add(next.entry.id)
    return {
      // 池的凭据类型是历史遗留的联合类型；运行时安全性由 provider 过滤保证
      // （查询用 `this.product.id`，取到的必是 zcode 凭据）。
      credential: next.credential as unknown as ZcodeCredential,
      accountId: next.entry.id,
    }
  }

  /** 释放自建的浏览器（由 `index.ts` 的 cleanup 调用）。 */
  stop(): void {
    this.captchaBrowser?.dispose()
    this.captchaBrowser = undefined
  }
}

/**
 * 「**秒回空**」= 该账号对这个模型**没有权益**（不是链路故障）。
 *
 * ## 判据（两条同时成立，缺一不可）
 *
 * 1. 错误是 `EMPTY_RESPONSE`（上游 200 但一个内容块都没有）
 * 2. **耗时 < {@link ZCODE_FAST_EMPTY_MS}**（3 秒）
 *
 * ## 依据（`dsh-free-glm` 的实测，2026-09-29）
 *
 * 空回复有两种**成因完全不同**的形态，旧代码混为一谈，于是把用户引向
 * 「重启实例」这个**无效方向**：
 *
 * | 成因 | 耗时 | 壳日志特征 | 正确处置 |
 * |---|---|---|---|
 * | **模型无权益** | **150-200ms** | 从未出现 provider runtime headers 请求 | **换账号 / 换模型** |
 * | 链路卡住 | ≈ 180000ms | `durationMs≈180000, textLength:0` | 重试 / 重启 |
 *
 * 那边实测的原文：`GLM-5.3` 的请求**从未出现**「收到 provider runtime headers
 * 请求」，而 Flash 每次都完整走 —— 即实例拿不到该模型的鉴权材料，
 * **根本没发往上游**，于是立刻回一个空 content。
 *
 * @param error - `consumeAnthropicSse` 抛出的错误。
 * @param elapsedMs - 从开始消费到抛错的耗时。
 */
export function isFastEntitlementMiss(error: unknown, elapsedMs: number): boolean {
  if (!(error instanceof LlmError)) return false
  if (error.code !== EMPTY_RESPONSE_CODE) return false
  return elapsedMs < ZCODE_FAST_EMPTY_MS
}

/**
 * 「秒回空」被判为**权益/额度**问题时的错误文案。
 *
 * ## 为什么必须有这一段（真实缺陷，2026-10-01）
 *
 * **用户报障**：zcode 赠送额度用完之后，界面显示的是
 *
 * > 本轮运行失败　zcode: 模型返回了空响应（无任何 text / thinking / tool 内容）
 * > `EMPTY_RESPONSE`
 *
 * —— 这是 SSE 消费器的**通用**文案，它描述的只是「我们没收到内容」这个现象，
 * **完全没说出真实原因**（额度用尽），用户无从判断该等额度、换模型还是加账号。
 *
 * ## 判据本来就是现成的（这才是最可惜的地方）
 *
 * 「**秒回空** = 该账号对这个模型没有权益（请求根本没送达模型）」
 * 这条判据早就在 {@link isFastEntitlementMiss} 里，依据是那边的实测
 * （150-200ms 空响应 vs 卡住形态的 ≈180000ms）。
 * 但它此前**只用于决定「要不要切号」**，判据本身从未进入文案 ——
 * 于是走到「无法再切号」这一步时，抛出的还是那个通用的裸错误。
 *
 * ## 连带修掉的第二个缺陷：错误码
 *
 * 原先抛 `EMPTY_RESPONSE`，而它**在** harness 的 `DEFAULT_RETRYABLE_CODES`
 * 里 —— 于是「额度已用尽」这种**确定性**错误被白退避重试 5 次
 * （用户截图里的「已重试模型请求 (5/5)」就是它，约 15.5 秒）。
 * 现在抛 `QUOTA_EXCEEDED`（**不在**该集合里）→ 立即失败并给出真实原因。
 *
 * ⚠ 与 `qoder` 那次「110 额度错误落在 `SERVER`」是**同型缺陷**：
 * 用错误码的默认归类代替了对业务语义的判断（`AGENTS.md` 记过该教训）。
 *
 * ## ⚠ 措辞必须诚实：不断言是「额度用尽」还是「无权益」
 *
 * 这两种成因在 wire 上**表现完全相同**（都是秒回空），我们**无法区分**：
 * - 赠送额度用尽（`billing/balance` 的桶为 0）
 * - 该账号对这个模型没有权益（对照那边实测的 `GLM-5.3` 从未拿到鉴权材料）
 *
 * 故文案写「额度已用尽或该模型无可用权益」，并给出**两种都能解决**的建议 ——
 * 不编造一个我们其实没验证过的结论。
 *
 * @param model - 请求的模型 id（用户据此决定换哪个）。
 * @param attemptedAccounts - 本次已尝试过的账号数（>1 时才提，否则误导）。
 */
export function zcodeEntitlementErrorMessage(model: string, attemptedAccounts: number): string {
  const tried = attemptedAccounts > 1 ? `；已尝试 ${attemptedAccounts} 个账号` : ''
  return (
    `zcode: 账号在模型 "${model}" 上的额度已用尽或没有可用权益` +
    `（上游返回 200 但没有任何内容，请求未送达模型）${tried}。` +
    '请等待免费额度重置（按自然日结算）、改用其它模型，' +
    '或在 Jet Hub 的 ZCode 面板添加账号。'
  )
}

/** 适配器默认的退避等待（可被 signal 中断）。 */
async function defaultAdapterSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new LlmError('zcode: 退避等待期间请求已取消', 'TRANSPORT'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    if (signal?.aborted === true) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 上游「并发限流」的业务码。
 *
 * 实测形态（`dsh-free-glm` 抓到，`bench/CAPABILITY-REPORT.md` 有原始拒绝体）：
 * ```json
 * HTTP 429 {"code":3009,"msg":"model concurrency limit exceeded"}
 * ```
 *
 * ⚠ 它与 `1005` 都走 HTTP 429，**只看状态码分不清**（那边的注释原话：
 * 「429 的语义藏在 `{"code":1005}` 里」）。
 */
export const ZCODE_CONCURRENCY_CODE = '3009'

/**
 * 「秒回空」的耗时阈值（毫秒）—— 判据是「**快速**返回 + 内容为空」的组合。
 *
 * 依据（`dsh-free-glm/src/adapter.ts` 的 `EMPTY_REPLY_FAST_MS` 家族，
 * 实测 2026-09-29）：空回复有**两种成因完全不同**的形态：
 *
 * | 成因 | 耗时 | 处置 |
 * |---|---|---|
 * | **模型/账号无权益**（实例拿不到该模型的鉴权材料，根本没发上游） | **150-200ms** | 换账号 / 换模型 |
 * | 链路卡住（上游静默直到超时） | ≈ 超时上限（180s） | 重试 / 排查链路 |
 *
 * 取 3000ms：远高于实测的 200ms，又远低于卡住形态 —— 两者不会混淆。
 */
export const ZCODE_FAST_EMPTY_MS = 3_000

/**
 * 判断是否是**并发限流**（`3009`）—— 「等一下就能过」，故**重试**，
 * 且**不切账号**（换账号也一样撞，白白标记掉一个可用账号）。
 */
export function isZcodeConcurrencyLimited(status: number, body: string): boolean {
  if (status !== 429) {
    // 少数情况下上游用 200/403 包裹限流体，故正文命中同样认。
    if (!body.includes(ZCODE_CONCURRENCY_CODE)) return false
  }
  return body.includes(ZCODE_CONCURRENCY_CODE) || /concurrency\s+limit/i.test(body)
}

/**
 * 判断是否是**额度用尽**（确定性错误：等到账期重置才可能恢复）。
 *
 * 两个码都要认：
 * - `1005` `exceed quota limit` —— 免费额度通道的**额度用尽**
 * - `1113` `余额不足或无可用资源包` —— ultra/coding-plan 侧的余额不足
 *
 * ⚠ **必须排除 `3009`**：并发限流同样返回 429，但它「等一下就能过」，
 * 若被归到这里就会把账号错标成「当日用尽」（误伤一个完全可用的账号，
 * 与 `qoder` 那次「把 rate_limit 当成 billing」是同一类错误）。
 */
export function isZcodeQuotaExhausted(status: number, body: string): boolean {
  if (isZcodeConcurrencyLimited(status, body)) return false
  if (body.includes('1113') || body.includes('余额不足')) return true
  if (body.includes('1005')) return true
  // 文案兜底：`1005` 这个码值由服务端下发，若上游改用别的码值表达同一语义，
  // 只认码会漏判。关键词**必须窄** —— `quota`/`balance` 之类泛词会误伤
  // 模型正文里恰好讨论「额度」的内容（与 qoder 的 `looksLikeBillingError` 同因）。
  return /exceed\s+quota\s+limit|quota\s+(?:has\s+been\s+)?exhausted/i.test(body)
}

/**
 * 并发限流重试的退避时长（**线性**：base、2×base、…）。
 *
 * 参数依据（`dsh-free-glm` 的实测）：退避起点从 900ms 提到 **1500ms** ——
 * 实测 900ms 的重试**仍然撞 429**，说明并发窗口比 900ms 长。
 * 重试 2 次，最坏总等待 ≈ 1500 + 3000 = 4.5 秒（用户可接受）。
 *
 * @param attempt - 已失败次数（0 表示第一次失败后的等待）。
 */
export function zcodeConcurrencyRetryDelayMs(attempt: number, baseMs: number): number {
  const base = baseMs > 0 ? baseMs : 1_500
  return base * (Math.max(0, Math.floor(attempt)) + 1)
}

/**
 * 给工具表的**最后一个**工具打 prompt caching 断点。
 *
 * ## 为什么只打一个（这是 Anthropic 缓存的语义，不是省事）
 *
 * Anthropic 的 prompt caching 是**前缀式**的：某个位置上的
 * `cache_control` 断点覆盖「**该断点之前的所有内容**」（system + 它之前的全部 tools）。
 * 故只在最后一个 tool 上打一个点，就等于把「system + 全部 tools」整段纳入缓存，
 * **不必逐个打**（而逐个打会撞上「最多 4 个断点」的上限，见下）。
 *
 * ## 真实缺陷（本仓库此前缺失，证据来自 dsh-free-glm 的 P0-2）
 *
 * 那边 dump 出的实际请求里：
 * ```
 * system blocks:  len=42 cc=True / len=2856 cc=True / len=2836 cc=True
 * tools[0] keys:  name, description, input_schema   ← 无 cache_control
 * ```
 * **24 个工具、19492 字节，一个断点都没有** —— 每步请求全量重算这段 prefill。
 *
 * 本仓库同样缺（`toAnthropicTools` 从不产出 `cache_control`），且我们还有个
 * 放大器：`system` 里含调用方（DSH）的完整规范。⇒ 这条对**每一步**都有效，
 * 是端到端耗时的主要可优化项之一。
 *
 * ## ⚠ 断点预算
 *
 * Anthropic 单请求最多 **4 个** `cache_control` 断点。`zcode-identity.ts` 的
 * system 块当前是「每块都打」（3-4 个）—— 已贴近上限。若上游因超限报错，
 * 把 system 收敛成「只在最后一块打断点」（那样仍覆盖全部 system 块），
 * 再把预算留给这里的 tools 断点。
 *
 * @param tools - 转换后的 Anthropic 工具数组（**不修改入参**）。
 */
export function withToolCacheBreakpoint<T extends object>(
  tools: readonly T[],
): (T | (T & { cache_control: { type: 'ephemeral' } }))[] {
  if (tools.length === 0) return []
  return tools.map((tool, index) =>
    index === tools.length - 1
      ? { ...tool, cache_control: { type: 'ephemeral' as const } }
      : tool,
  )
}

/**
 * 把上游错误翻成人能看懂的一句话。
 *
 * ⚠ 两个业务码要单独说清，因为它们的**处理方式完全不同**：
 * - `3007` = captcha 校验失败（**可重试**：换个新 param 即可）
 * - `3012` = 风控拦截（**不要重试**：有账号冷却惩罚，重复触发会升级封禁）
 */
export function describeUpstreamError(status: number, body: string): string {
  const trimmed = body.trim()
  let code: unknown
  let message: unknown
  try {
    const parsed = JSON.parse(trimmed) as { code?: unknown; msg?: unknown; message?: unknown }
    code = parsed.code
    message = parsed.msg ?? parsed.message
  } catch {
    // 非 JSON：原样截断。
  }
  const suffix = typeof message === 'string' && message.length > 0 ? message : trimmed.slice(0, 200)

  /**
   * ⚠ 两个**限流/额度**码要单独说清，因为用户该做的事完全不同：
   * - `3009` 并发限流：**等一下再试**（我们已经退避重试过，仍失败说明窗口更长）
   * - `1005` 额度用尽：等额度重置或**换账号**（重试无意义）
   */
  if (code === 3009 || trimmed.includes('3009')) {
    return (
      `上游并发限流（3009 model concurrency limit exceeded）——` +
      `已按退避重试仍未通过，请稍后重试。原始响应：${suffix}`
    )
  }
  if (code === 1005 || trimmed.includes('1005')) {
    return (
      `额度用尽（1005 exceed quota limit）——` +
      `该账号在这个模型上的免费额度已用完，请等待额度重置或更换账号。原始响应：${suffix}`
    )
  }
  if (code === 3007 || trimmed.includes('3007')) {
    return `阿里云 captcha 校验失败（3007）。请重试；若持续失败，检查浏览器是否可用。`
  }
  if (code === 3012 || trimmed.includes('3012')) {
    return (
      `上游风控拦截（3012 unusual activity）。` +
      `⚠ 该错误有账号冷却惩罚（30 分钟，反复触发会升级到 24 小时乃至停用），` +
      `请勿连续重试。原始响应：${suffix}`
    )
  }
  if (code === 1002 || status === 401) {
    return `凭据失效（${status}）。请重新在官方 ZCode 客户端登录。${suffix}`
  }
  return `HTTP ${status}：${suffix}`
}

/**
 * 把上游错误码映射到 harness 的错误类别。
 *
 * ⚠ 映射决定了**会不会被自动重试**（harness 的 `DEFAULT_RETRYABLE_CODES`
 * 是 `[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]`）：
 *
 * | 上游 | 映射 | 会被重试吗 | 理由 |
 * |---|---|---|---|
 * | `3007` captcha | `RATE_LIMIT` | **是** | 换新 param 就能过，值得重试 |
 * | `3012` 风控 | `PERMISSION` | **否** | 有账号冷却惩罚，重试会加重 |
 * | `1002`/401 | `AUTH` | 否 | 需用户重新登录 |
 * | `1113` 余额 | `QUOTA_EXCEEDED` | **否** | 确定性错误（要充值） |
 * | 其余 5xx | `SERVER` | 是 | 暂时性 |
 */
export function httpErrorCodeForZcode(status: number, body: string): string {
  const trimmed = body.trim()
  if (trimmed.includes('3007')) return 'RATE_LIMIT'
  if (trimmed.includes('3012')) return 'PERMISSION'
  if (trimmed.includes('1113') || trimmed.includes('余额不足')) return 'QUOTA_EXCEEDED'
  if (status === 401 || trimmed.includes('1002')) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status >= 500) return 'SERVER'
  if (status === 400) return 'INVALID_REQUEST'
  return 'SERVER'
}

/**
 * 在 `ctx.llm` 上注册 zcode provider 路由与适配器。
 *
 * 返回适配器实例：Jet Hub「显示列表」需要 `listAllModels()`
 * （不受黑名单影响、带最终展示名）。`ctx.llm` 不透传自定义方法，
 * 故须由调用方持有引用并在 `index.ts` 的 `modelAdapters` 里登记。
 */
export function registerZcodeLlm(ctx: Context, options: ZcodeAdapterOptions): ZcodeAdapter {
  const product = options.product ?? ZCODE
  const adapter = new ZcodeAdapter(options)
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  return adapter
}
