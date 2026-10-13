/**
 * Loomy（讯飞）产品配置。
 *
 * ## 为什么新建 `LoomyProduct` 而不复用既有类型
 *
 * `BuddyProduct` / `LobsteraiProduct` / `QoderProduct` 的字段全部围绕各自
 * 协议设计（归属头、refresh 载荷、WASM 签名参数…），对 Loomy 无一有意义。
 * Loomy 需要的是：两个 base URL（账号 vs 业务）、讯飞 AccessKey、
 * 以及一张兜底模型表。故定义**平行**的接口 —— 共用的是架构**模式**
 * （产品差异收敛到单一真相源），不是那个类型。
 *
 * ## 数据来源
 *
 * - base URL / AccessKey / appId：`C:\Program Files\Loomy\resources\.env.prod`
 *   Loomy 官方也只是「随客户端分发 + AES 混淆」，本质同样是公开的。
 * - 兜底模型表：2026-09-26 用本机登录态实测 `GET /api/v1/models` 取得
 *   （11 条中 `type==='chat'` 的 8 条）。
 *
 * ## ⚠️ AccessKey 的定位
 *
 * 它只用于**讯飞账号**端点（`account.xfinfr.com`）的 HMAC-SHA1 签名
 * （短信验证码登录）。业务与推理端点用的是用户登录后的 `session`，
 * 与 AccessKey 无关。故 AccessKey 泄露不涉及任何用户数据。
 */

import { LOOMY_ACCOUNT_BASE, LOOMY_API_BASE } from './loomy.js'

/** 兜底模型目录中的一个条目。 */
export interface LoomyFallbackModel {
  /** 模型 ID（传给 `POST /chat/completions` 的 `model`）。 */
  id: string
  /** **已规范化**的展示名（含倍率，` · x{n}` 分隔）。 */
  name: string
  /** 上下文窗口。 */
  contextWindow: number
  /**
   * 可选思考档位（远端 `reasoning_efforts` 的实测值）。
   *
   * ⚠️ 与远端**同名字段、同一口径**：远端可用时优先用它，兜底表只在远端整体
   * 失败时顶替。实测 8 个 chat 模型全部是
   * `['none','low','medium','high','xhigh']`、默认 `low`。
   */
  efforts?: string[]
  /** 远端声明的默认档位（`default_reasoning_effort`）。 */
  defaultEffort?: string
}

/**
 * Loomy 产品配置。
 */
export interface LoomyProduct {
  /** provider 标识：注册到 `ctx.llm` 的路由名，也是账号列表的 provider 字段值。 */
  id: 'loomy'
  /** 设置页 / 模型选择器展示名。 */
  displayName: string
  /** 业务基址（推理 / 模型列表 / 积分 / 新手任务）。 */
  apiBase: string
  /** 讯飞账号（CAccount）基址。 */
  accountBase: string
  /** 讯飞账号 AccessKeyId（HMAC-SHA1 签名的 `account {ak}:{sig}` 前半）。 */
  accessKeyId: string
  /** 讯飞账号 AccessKeySecret（HMAC-SHA1 的密钥）。 */
  accessKeySecret: string
  /** 讯飞 appId（账号请求体 `base.appid`）。 */
  appId: string
  /** 默认凭据 ref（无账号池时的单凭据回退）。 */
  defaultCredentialRef: string
  /** 远端模型列表不可用时的兜底模型目录（8 个 chat 模型）。 */
  fallbackModels: readonly LoomyFallbackModel[]
}

/**
 * 兜底模型目录（8 个 chat 模型）。
 *
 * 来源：2026-09-26 实测 `GET /api/v1/models`，取 `type === 'chat'` 的条目。
 * 顺序**照抄远端返回顺序**，不重排 —— 重排会让「与远端对比」这类排查失去可比性。
 *
 * ⚠️ `name` 已按 `loomyDisplayName` 规范化（远端原值是三种括号风格混用）。
 * ⚠️ `contextWindow` 用远端 `context_length`。`spark-x` 是**已知分歧**：
 * 远端声明 1048576，而 Loomy 客户端用本地表
 * `MODEL_CONTEXT_OVERRIDES = { 'spark-x': 262144 }` 强制降到 262144。
 * 本表**先采信远端**；若实测长上下文被拒，改为 262144（见设计文档 §11）。
 */
/**
 * 兜底模型目录（**10 个 chat 模型**，2026-10-09 按远端实测重采）。
 *
 * 来源：2026-10-09 用真实凭据实测 `GET /api/v1/models`（远端共 13 条，
 * 按 `type === 'chat'` 过滤得 **10 条**；其余 3 条是 `type === 'image'` 的生图模型）。
 * 顺序**照抄远端返回顺序**，不重排 —— 重排会让「与远端对比」这类排查失去可比性。
 *
 * ## 2026-10-09 更新内容
 *
 * - **新增 `DeepSeek-V4.1-Flash`（x2.0）**：远端 index 0 且 `is_default_model: true`，
 *   是默认模型，旧表完全没有它；
 * - **`spark-x` 展示名改为 `Spark X2.5（限时免费）`**：远端把倍率位改成了
 *   **状态文案**（`name = "Spark X2.5（限时免费）"`），不再下发 `x0.1`。
 *   ⚠️ 这是**上游事实**，不是我们丢了倍率 —— 「倍率必须显示」这条口径在此处
 *   无法由我们满足（上游没给）。⚠️ 该值是**易腐的**：限免结束上游会改回
 *   `（x0.1）`，届时需重采。
 * - **0 条下线**：旧表 8 条 id 全部仍在远端。
 *
 * ⚠️ `name` 已按 `loomyDisplayName` 规范化（远端原值是三种括号风格混用）。
 * ⚠️ `contextWindow` 用远端 `context_length`。`spark-x` 是**已知分歧**：
 * 远端声明 1048576，而 Loomy 客户端用本地表
 * `MODEL_CONTEXT_OVERRIDES = { 'spark-x': 262144 }` 强制降到 262144。
 * 本表**先采信远端**；若实测长上下文被拒，改为 262144（见设计文档 §11）。
 *
 * ⚠️ **不含 `auto`（`自动 · 均衡`）**：它是远端下发的**聚合/自动选模入口**，
 * 不是真实模型。判据三条：① name 字面就是「自动 · 均衡」；
 * ② 它**缺全部能力元数据**（无 `context_length` / `capabilities` /
 * `reasoning_efforts` / 倍率），正是「聚合入口」而非真实模型的形态；
 * ③ 与 `src/buddy.ts` 的 `isAutoSelectAlias`（过滤 `auto`/`default`）同型。
 * ⚠️ 但 `parseLoomyRemoteModels` **当前仍会把远端下发的 `auto` 放进来**
 * （它只按 `type === 'chat'` 过滤），故「远端可用」与「远端失败」两条路径
 * 的条目数暂不一致（10 vs 9）—— 这属于解析层的取舍，本次只更新模型数据，
 * 未改过滤逻辑。
 */
/**
 * 实测的思考档位（9 个带档位的 chat 模型**完全一致**，2026-10-09 用真实凭据采集）。
 *
 * ⚠️ 抽成常量而不是逐条写 9 遍：远端对全部 chat 模型下发同一份档位，
 * 逐条重复只会让将来上游变更时漏改其中几条。
 * ⚠️ 远端可用时**优先用远端的 `reasoning_efforts`**，本常量只在远端整体失败时
 * 顶替（与 `contextWindow` 同策略）。
 */
const LOOMY_EFFORTS: readonly string[] = ['none', 'low', 'medium', 'high', 'xhigh']

/**
 * 本插件选用的默认档位（**用户要求 `high`**）。
 *
 * ⚠️ 远端 `default_reasoning_effort` 声明的是 **`low`**，这里**有意不沿用** ——
 * DSH 的「用户没选时发哪个档」完全取适配器声明的 `defaultEffort`
 * （见 `loomy-adapter.ts` 的 `LOOMY_PREFERRED_DEFAULT_EFFORT` 说明）。
 * 兜底表与适配器常量必须一致，否则「远端可用」与「远端失败」两条路径默认档不同。
 */
const LOOMY_DEFAULT_EFFORT = 'high'

const LOOMY_FALLBACK_MODELS: readonly LoomyFallbackModel[] = [
  { id: 'DeepSeek-V4.1-Flash', name: 'DeepSeek V4.1 Flash · x2.0', contextWindow: 1_048_576, efforts: [...LOOMY_EFFORTS], defaultEffort: LOOMY_DEFAULT_EFFORT },
  { id: 'deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash 0731 · x3.0', contextWindow: 1_048_576, efforts: [...LOOMY_EFFORTS], defaultEffort: LOOMY_DEFAULT_EFFORT },
  { id: 'MiniMax-M3', name: 'MiniMax M3 · x4.0', contextWindow: 1_048_576, efforts: [...LOOMY_EFFORTS], defaultEffort: LOOMY_DEFAULT_EFFORT },
  { id: 'Kimi-k2.6', name: 'Kimi k2.6 · x6.5', contextWindow: 262_144, efforts: [...LOOMY_EFFORTS], defaultEffort: LOOMY_DEFAULT_EFFORT },
  { id: 'qwen-3.8-max', name: 'Qwen 3.8 Max · x12.0', contextWindow: 1_000_000, efforts: [...LOOMY_EFFORTS], defaultEffort: LOOMY_DEFAULT_EFFORT },
  { id: 'GLM-5.3-Flash', name: 'GLM 5.3 Flash · x0.8', contextWindow: 1_048_576, efforts: [...LOOMY_EFFORTS], defaultEffort: LOOMY_DEFAULT_EFFORT },
  { id: 'qwen3.8-flash', name: 'qwen 3.8 flash · x0.8', contextWindow: 1_000_000, efforts: [...LOOMY_EFFORTS], defaultEffort: LOOMY_DEFAULT_EFFORT },
  // ⚠️ 远端倍率位已被状态文案「限时免费」取代（见上方说明），此处与远端保持一致。
  { id: 'spark-x', name: 'Spark X2.5（限时免费）', contextWindow: 1_048_576, efforts: [...LOOMY_EFFORTS], defaultEffort: LOOMY_DEFAULT_EFFORT },
  { id: 'mimo-v2.5', name: 'MiMo V2.5 · x3.3', contextWindow: 1_048_576, efforts: [...LOOMY_EFFORTS], defaultEffort: LOOMY_DEFAULT_EFFORT },
]

/**
 * Loomy provider 配置。
 */
export const LOOMY: LoomyProduct = {
  id: 'loomy',
  displayName: 'Loomy (讯飞)',
  apiBase: LOOMY_API_BASE,
  accountBase: LOOMY_ACCOUNT_BASE,
  // 取自 `.env.prod`（VITE_XFYUN_ACCESS_KEY_ID / _SECRET / _APP_ID）。
  accessKeyId: '2thryby66wxi53sk',
  accessKeySecret: 'zsak6eadrbawz683wf5r3m2snrwj868r',
  appId: 'GM3LOOMY',
  defaultCredentialRef: 'LOOMY_ACCESS_TOKEN',
  fallbackModels: LOOMY_FALLBACK_MODELS,
}

/** 全部 Loomy 产品配置（当前只有一个，保留数组以便将来扩展）。 */
export const ALL_LOOMY_PRODUCTS: readonly LoomyProduct[] = [LOOMY]

/**
 * 按 provider id 取 Loomy 产品配置；未知 id 返回 undefined。
 *
 * 与 `productById`（CodeBuddy 系）/ `lobsteraiProductById` 等分开：
 * 各自返回**不同类型**，合并会让调用方拿到联合类型后再也不得不做类型收窄。
 */
export function loomyProductById(id: string): LoomyProduct | undefined {
  return ALL_LOOMY_PRODUCTS.find((product) => product.id === id)
}
