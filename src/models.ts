import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { signRequestHuawei } from './sign.js'
import type { CodeArtsCredential } from './types.js'

/**
 * opengw 网关配置端点 — 返回 benefit（免费额度）模型列表（glm-5.3-flash 等）。
 * 逆向自 CodeArts Agent IDE mitmproxy 抓包（2026-08）。
 */
export const OPENGW_GATEWAY_CONFIG_URL = 'https://opengw.developer.huaweicloud.com/api/v1/gateway/config'

/**
 * snap-access 内置模型列表端点 — 返回常规模型（GLM-5.2、openpangu、glm-5.2-sft-harmony 等）。
 * 响应结构：{ count, builtinModels: [{ model_id, model_name, ... }] }。
 * 用 AK/SK 签名 + Agent-Type: PromptCenter header。
 * 替代旧 SNAP_STATISTICS_URL（statistics/plugin 已不再返回 model_metrics）。
 */
export const SNAP_MODEL_BUILTIN_URL = 'https://snap-access.cn-north-4.myhuaweicloud.com/v1/model/builtin'

/** 远端动态模型列表缓存文件名（~/.cache/deveco/codearts_models.json）。 */
const CODEARTS_MODELS_CACHE_FILENAME = 'codearts_models.json'

/**
 * benefit（免费额度）模型 id 集合的缓存文件名
 * （~/.cache/deveco/codearts_benefit_models.json）。
 *
 * 与模型列表分开缓存：判定 `maas_type` 只关心 id 集合，且 chat 请求在每次
 * 签名前都要查它，独立文件可避免解析整份模型元数据。
 */
const CODEARTS_BENEFIT_CACHE_FILENAME = 'codearts_benefit_models.json'

/**
 * 已**退役**（服务端不再注册）的模型 id —— 从目录与缓存中过滤掉，避免
 * 模型菜单里留一个必然报错的选项。
 *
 * ⚠️ `glm-5.3-flash` 于 2026-10-09 实测退役（用户报障「codearts 的模型用不了」）：
 * - 服务端模型目录 `snap-manager/v1/statistics/plugin` 的 `model_metrics`
 *   只剩 6 条，**不含**它（也不含 `deepseek-v4.1-flash`）；
 * - 不带 `maas_type` → `InferHub.002002009.404 The model is not registered`；
 * - 带 `maas_type: benefit` → `InferHub.4004.200 benefit not found`。
 *   两种形态都失败 ⇒ 该模型在该账号上已彻底不可用，**不是**本插件的判定缺陷。
 *   换大小写（`GLM-5.3-Flash`）、加日期后缀、换 `maas_type` 取值均无效。
 *
 * ⚠️ **`opengw gateway/config` 至今仍把它列在 `result.models` 里** —— 这正是
 * 「远端清单即 benefit 集合」这一旧结论失效的证据：gateway 清单是**客户端
 * 该展示什么**的目录，不等于**该账号能用什么**。故 benefit 判定已改为
 * 自适应（见 {@link isCodeArtsBenefitModel}），不再采信任何远端/静态清单。
 */
const RETIRED_MODEL_IDS: readonly string[] = ['glm-5.3-flash']

/** 动态模型拉取超时（ms）。 */
const FETCH_TIMEOUT_MS = 10_000

/** 定时刷新远端模型列表的间隔（2 小时）。 */
export const MODEL_REFRESH_INTERVAL_MS = 2 * 3_600_000

export interface RemoteModel {
  id: string
  name: string
}

/** 模块级内存缓存：远端拉取或磁盘加载后填充；availableCodeArtsModels 优先读取。 */
let memoryCache: RemoteModel[] | undefined

/** benefit 模型 id 集合的内存缓存：远端拉取或磁盘加载后填充。 */
let benefitMemoryCache: string[] | undefined

/**
 * 去掉模型 id 末尾的日期版本后缀：deepseek-v4-flash-0731 → deepseek-v4-flash。
 * 远端 gateway/config 返回带日期后缀的 model_id（-0731 = 7月31日版本），
 * 但 chat 端点只认不带后缀的 id（InferHub.002002009.404 "model is not registered"）。
 * 仅匹配末尾 -NNNN（4 位数字），避免误去 glm-5.3-flash 等无后缀 id。
 */
export function normalizeModelId(id: string): string {
  if (id.length > 5) {
    const suffix = id.slice(-5)
    if (suffix.startsWith('-') && /^\d{4}$/.test(suffix.slice(1))) {
      return id.slice(0, -5)
    }
  }
  return id
}

function parseModelInfo(m: Record<string, unknown>, seen: Set<string>): RemoteModel | undefined {
  const rawId = m['model_id']
  if (typeof rawId !== 'string' || rawId.length === 0) return undefined
  const id = normalizeModelId(rawId)
  // 已退役模型直接丢弃：服务端目录里可能仍留着（gateway/config 至今还列
  // glm-5.3-flash），但发请求必然失败，放进菜单只会误导用户。
  if (RETIRED_MODEL_IDS.includes(id)) return undefined
  // 过滤视觉（VL）多模态模型
  // id 含 -VL- 或以 -VL 结尾（如 Qwen3-VL-235B），上下文小、不支持工具调用，
  // 不适合当 agent 主模型，从列表隐藏；只通过 analyzeImage 等工具间接调用。
  //
  // ⚠️ **必须大小写不敏感**（真实缺陷，2026-10-09 实测）：原判据对大小写敏感，
  // 而远端下发的 id 并不统一 —— `Qwen3-VL-235B` 是大写（会被过滤），
  // 而 **`kimi-k2.6-vl` 是全小写**（`-vl` 结尾），原判据**不命中**，
  // 于是它出现在模型选择器里。远端自己对它的标注是
  // `display_enabled: false` + `model_category: "图片理解"` —— 与 `Qwen3-VL-235B`
  // **完全同类**，可见「不该展示」是服务端的明确意图。
  //
  // 复核脚本：`scripts/probe-codearts-vl.mjs`（打印两个端点的原始条目与
  // 大小写敏感性对照）。回归用例见 `tests/unit/models.spec.ts`。
  const lowered = id.toLowerCase()
  if (lowered.includes('-vl-') || lowered.endsWith('-vl')) return undefined
  const rawName = m['model_name']
  const name = typeof rawName === 'string' && rawName.length > 0 ? normalizeModelId(rawName) : id
  if (seen.has(id)) return undefined
  seen.add(id)
  return { id, name }
}

/** 从 JSON 响应中沿路径指针取数组。 */
function extractJsonArray(text: string, path: string[]): unknown[] | undefined {
  try {
    let value: unknown = JSON.parse(text)
    for (const key of path) {
      if (typeof value !== 'object' || value === null) return undefined
      value = (value as Record<string, unknown>)[key]
    }
    return Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * 签名 GET 请求远端端点并读取文本；网络失败或非 200 时返回 undefined
 * （不阻断调用方）。
 */
async function fetchSignedGet(
  fetcher: typeof fetch,
  url: string,
  ak: string,
  sk: string,
  st: string,
  /** 签名后追加的头（不参与 SDK-HMAC-SHA256 签名计算）。 */
  extraUnsignedHeaders?: Readonly<Record<string, string>>,
): Promise<string | undefined> {
  const signed = await signRequestHuawei(ak, sk, st, 'GET', url, new Uint8Array())
  const headers = new Headers()
  signed.forEach((v, k) => {
    if (k !== 'host') headers.set(k, v)
  })
  if (extraUnsignedHeaders !== undefined) {
    for (const [k, v] of Object.entries(extraUnsignedHeaders)) headers.set(k, v)
  }
  try {
    const response = await fetcher(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    return await response.text()
  } catch {
    return undefined
  }
}

/**
 * 从两个远端端点拉取模型列表并合并去重：
 * 1. opengw gateway/config → result.models（DeepSeek V4 系列）
 * 2. snap-access /v1/model/builtin → builtinModels（常规模型）
 * 失败或空凭据时返回空数组（不阻断）。
 *
 * ⚠️ 本函数**只负责「有哪些模型」**，不再推断 benefit 属性（2026-10-09 起）：
 * gateway/config 的清单是「该展示什么」，与「该不该带 `maas_type: benefit`」
 * 无关 —— 详见 {@link isCodeArtsBenefitModel} 的历史表格。
 *
 * 已退役的 id（见 `RETIRED_MODEL_IDS`）在 {@link parseModelInfo} 中即被丢弃。
 */
export async function fetchCodeArtsRemoteModels(
  credential: CodeArtsCredential,
  fetcher: typeof fetch = fetch,
): Promise<RemoteModel[]> {
  const { access_key_id: ak, secret_access_key: sk, security_token: st } = credential
  if (!ak || !sk) return []

  const models: RemoteModel[] = []
  const seen = new Set<string>()

  // 1. opengw gateway/config — DeepSeek V4 系列（含带日期后缀的 benefit 形态）
  const gatewayText = await fetchSignedGet(fetcher, OPENGW_GATEWAY_CONFIG_URL, ak, sk, st)
  if (gatewayText !== undefined) {
    const arr = extractJsonArray(gatewayText, ['result', 'models'])
    if (arr !== undefined) {
      for (const item of arr) {
        if (typeof item === 'object' && item !== null) {
          const mi = parseModelInfo(item as Record<string, unknown>, seen)
          if (mi) models.push(mi)
        }
      }
    }
  }

  // 2. snap-access /v1/model/builtin — 常规模型（GLM-5.2、openpangu、glm-5.2-sft-harmony 等）
  //    Agent-Type: PromptCenter + X-Language: zh-cn（不参与签名）。
  //    替代旧 statistics/plugin（已不再返回 model_metrics）。
  const snapText = await fetchSignedGet(fetcher, SNAP_MODEL_BUILTIN_URL, ak, sk, st, {
    'Content-Type': 'application/json',
    'Agent-Type': 'PromptCenter',
    'X-Language': 'zh-cn',
  })
  if (snapText !== undefined) {
    const arr = extractJsonArray(snapText, ['builtinModels'])
    if (arr !== undefined) {
      for (const item of arr) {
        if (typeof item === 'object' && item !== null) {
          const mi = parseModelInfo(item as Record<string, unknown>, seen)
          if (mi) models.push(mi)
        }
      }
    }
  }

  // ⚠️ 这里**不再**从 gateway/config 推断 benefit 集合（2026-10-09）：
  // 实测该清单仍列着已失效的 glm-5.3-flash、且把 deepseek-v4.1-flash 列为
  // benefit（而它现在恰恰**不能**带该头）。清单是「该展示什么」，不是
  // 「该怎么调」。benefit 属性改由 `llm-adapter.ts` 按响应自适应学习
  // （见 `isCodeArtsBenefitModel` / `rememberBenefitModel`）。

  return models
}

/**
 * 缓存目录：默认 `~/.cache/deveco`，可用 `DSH_CODEARTS_CACHE_DIR` 覆盖
 * （单测借此隔离，避免污染真实用户缓存）。
 */
function cacheDir(): string | undefined {
  const override = process.env.DSH_CODEARTS_CACHE_DIR
  if (override !== undefined && override.length > 0) return override
  const home = process.env.USERPROFILE ?? process.env.HOME
  if (!home) return undefined
  return `${home}/.cache/deveco`
}

/** 动态模型列表缓存路径：~/.cache/deveco/codearts_models.json。 */
function modelsCachePath(): string | undefined {
  const dir = cacheDir()
  return dir === undefined ? undefined : `${dir}/${CODEARTS_MODELS_CACHE_FILENAME}`
}

/** benefit 模型集合缓存路径：~/.cache/deveco/codearts_benefit_models.json。 */
function benefitCachePath(): string | undefined {
  const dir = cacheDir()
  return dir === undefined ? undefined : `${dir}/${CODEARTS_BENEFIT_CACHE_FILENAME}`
}

/**
 * 保存动态模型列表到缓存文件（原子写入 tmp+rename）。
 *
 * ⚠️ 必须用**顶层静态导入**的 `node:fs`（见文件头），**不能**用
 * `require('node:fs')`：本包是 ESM（package.json `"type": "module"`），
 * `require` 在 ESM 下未定义，调用会抛 ReferenceError —— 被下面的 catch
 * 静默吞掉，表现为「写入/读取永远无效」。真实缺陷（2026-09-23）：磁盘缓存
 * 的读取路径曾因 `require` 恒返回 undefined，于是模型列表与 benefit 集合
 * 每次都要回退静态兜底。
 */
export function saveModelsCache(models: RemoteModel[]): void {
  const path = modelsCachePath()
  if (!path) return
  const dir = path.slice(0, path.lastIndexOf('/'))
  try {
    mkdirSync(dir, { recursive: true })
    const tmp = path + '.tmp'
    writeFileSync(tmp, JSON.stringify(models), 'utf-8')
    renameSync(tmp, path)
  } catch {
    // 写入失败静默忽略
  }
}

/** 加载缓存文件中的动态模型列表; 文件不存在或解析失败时返回 undefined。 */
export function loadModelsCache(): RemoteModel[] | undefined {
  const path = modelsCachePath()
  if (!path) return undefined
  try {
    if (!existsSync(path)) return undefined
    const text = readFileSync(path, 'utf-8')
    const models: RemoteModel[] = JSON.parse(text)
    if (!Array.isArray(models) || models.length === 0) return undefined
    // ⚠️ 必须在**读取时**也过滤退役模型：旧缓存里可能还留着它们
    // （glm-5.3-flash 曾长期在列），而远端拉取失败时 `availableCodeArtsModels`
    // 会直接采信磁盘缓存 —— 只过滤远端结果的话，菜单里仍会冒出死模型。
    const alive = models.filter((m) => m !== null && typeof m?.id === 'string' && !RETIRED_MODEL_IDS.includes(m.id))
    return alive.length > 0 ? alive : undefined
  } catch {
    return undefined
  }
}

/**
 * 取出可用模型列表，优先级：内存缓存 → 磁盘缓存 → 空。
 * 由 adapter 的 listModels 调用；无远端模型时仍回退到 adapter 的静态默认列表。
 */
export function availableCodeArtsModels(): RemoteModel[] | undefined {
  if (memoryCache !== undefined) return memoryCache
  const disk = loadModelsCache()
  if (disk !== undefined) {
    memoryCache = disk
    return disk
  }
  return undefined
}

/** 设置内存缓存（由 service 拉取成功后调用）。 */
export function setMemoryCache(models: RemoteModel[] | undefined): void {
  memoryCache = models
}

/**
 * 保存 benefit 模型 id 集合到缓存文件（原子写入 tmp+rename）。
 * 文件不存在或写入失败时静默忽略。
 *
 * 同步写入（与 {@link loadBenefitCache} 一致）：chat 请求签名前要读它，
 * 异步写入会让「刚拉取完就发消息」的窗口期内读到旧值/空值。
 */
export function saveBenefitCache(ids: readonly string[]): void {
  const path = benefitCachePath()
  if (!path) return
  const dir = path.slice(0, path.lastIndexOf('/'))
  try {
    mkdirSync(dir, { recursive: true })
    const tmp = path + '.tmp'
    writeFileSync(tmp, JSON.stringify(ids), 'utf-8')
    renameSync(tmp, path)
  } catch {
    // 写入失败静默忽略
  }
}

/** 加载缓存文件中的 benefit 模型 id 集合；文件不存在或解析失败时返回 undefined。 */
export function loadBenefitCache(): string[] | undefined {
  const path = benefitCachePath()
  if (!path) return undefined
  try {
    if (!existsSync(path)) return undefined
    const text = readFileSync(path, 'utf-8')
    const ids: unknown = JSON.parse(text)
    if (!Array.isArray(ids) || ids.length === 0) return undefined
    return ids.filter((id): id is string => typeof id === 'string')
  } catch {
    return undefined
  }
}

/** 设置 benefit 集合内存缓存（由远端拉取成功后调用；undefined 表示清除）。 */
export function setBenefitMemoryCache(ids: string[] | undefined): void {
  benefitMemoryCache = ids
}

/**
 * 判断某模型是否为 benefit（免费额度）模型 —— 决定 chat 请求是否必须带
 * `maas_type: benefit`。
 *
 * ## ⚠️ 为什么不再采信任何「清单」（2026-10-09 第二次推翻）
 *
 * 本函数历史上换过三套判据，每一套都在服务端变更后失效，值得完整记录：
 *
 * | 时期 | 判据 | 失效方式 |
 * |---|---|---|
 * | 初版 | 硬编码 `Set(['glm-5.3-flash'])` | 新增 `deepseek-v4.1-flash` 时漏判（用户报障） |
 * | 2026-09-23 | `gateway/config` 清单 ∪ 静态兜底表 | **2026-10-09 整体失效**（见下） |
 * | 现在 | **自适应：按响应学习，无任何清单** | —— |
 *
 * **2026-10-09 实测（用户报障「codearts 的模型用不了」）**：
 * `deepseek-v4.1-flash` **不带** `maas_type` 时**成功**返回正常 SSE delta
 * （实测 1/1 成功 + 1 次 TPM 限流），**带上**时 3/3 稳定回
 * `InferHub.4004.200 benefit not found` —— 与上表第二套判据的前提
 * **完全相反**。同时 `glm-5.3-flash` 两种形态都失败（已退役）。
 *
 * 更要紧的是：`gateway/config` 至今仍把这两个模型列在 `result.models` 里，
 * 说明**该清单是「客户端该展示什么」的目录，不是「该账号能用什么」的凭据**。
 * 任何「从某个远端清单推断 benefit 属性」的写法都会再次踩同一个坑。
 *
 * ⇒ 因此判定改为**完全自适应**：默认**不带** `maas_type`；只有当服务端以
 * `InferHub.002002009.404 The model is not registered` 明确拒绝时，才带上
 * 该头重试一次，并把结果**学习**进本缓存（进程内 + 磁盘），供后续请求直接命中。
 *
 * ⚠️ **默认值必须是「不带」**：实测当前服务端对所有模型带上该头都会
 * `benefit not found`（连 `GLM-5.2`、`kimi-k2.6-vl` 这些非 benefit 模型也是），
 * 而默认不带时它们全部可用。把默认值取反会让整个 provider 全线不可用。
 *
 * ⚠️ **学习结果只是「提示」，不是门禁**：命中也仍会走一次实发（见
 * `llm-adapter.ts` 的自适应重试），服务端改回旧语义时能自行纠偏。
 */
export function isCodeArtsBenefitModel(model: string): boolean {
  if (benefitMemoryCache === undefined) benefitMemoryCache = loadBenefitCache()
  return benefitMemoryCache !== undefined && benefitMemoryCache.includes(model)
}

/**
 * 学习「该模型需要 `maas_type: benefit`」，并落盘。
 *
 * 由 `llm-adapter.ts` 在服务端回 `not registered`、带该头重试成功时调用。
 * 仅在该模型尚未被记录时写入（避免每轮请求都做一次磁盘 IO）。
 */
export function rememberBenefitModel(model: string): void {
  if (benefitMemoryCache === undefined) benefitMemoryCache = loadBenefitCache() ?? []
  if (benefitMemoryCache.includes(model)) return
  benefitMemoryCache = [...benefitMemoryCache, model]
  saveBenefitCache(benefitMemoryCache)
}

/**
 * 忘记「该模型需要 `maas_type: benefit`」—— 服务端改回旧语义时纠偏。
 *
 * 由 `llm-adapter.ts` 在带该头却回 `benefit not found`（或其它非
 * `not registered` 的失败）时调用：说明这条学习记录已过时，继续带着该头
 * 只会让该模型永久不可用。
 */
export function forgetBenefitModel(model: string): void {
  if (benefitMemoryCache === undefined) benefitMemoryCache = loadBenefitCache() ?? []
  if (!benefitMemoryCache.includes(model)) return
  benefitMemoryCache = benefitMemoryCache.filter((id) => id !== model)
  saveBenefitCache(benefitMemoryCache)
}
