/**
 * Antigravity（Google `agy` CLI）产品配置。
 *
 * ## 为什么是「路径 C」——非凭据型面板
 *
 * 与其余 12 个面板不同，Antigravity 的凭据**不归本插件
 * 持有**：由官方 `agy` 二进制自管（macOS 在 Keychain `gemini:antigravity`，
 * Windows 在 Credential Manager，磁盘上只有隔离 HOME 目录里的登录态）。
 * 因此：
 *
 * - **没有 `ctx.credentials` 条目、没有 `ANTIGRAVITY_ACCOUNT_*` 这种 ref** ——
 *   账号列表/配额/登录状态全部住 `~/.dsh/agy-accounts/pool.json`（协议层在
 *   `src/agy/`，装配在 `agy-service.ts`），本插件账号池（`AccountPool`）里
 *   只有它的**模型黑名单**一项（Jet Hub 模型开关真实生效的载体）。
 * - `REF_PREFIX_TO_PROVIDER` **刻意不含** `ANTIGRAVITY`（恢复逻辑造不出
 *   指向空气的账号，见该表末注释与 `jet-hub-store.spec.ts` 的钉死用例）。
 * - RPC 动词走标准 Jet Hub 集（`account.*` / `login.poll` / `model.*` /
 *   `provider.*`），少数无标准对应物的动作走 `antigravity.*` 扩展动词
 *   （开终端 / 设主号 / 切换选号模式 / 代理 / 面板状态驱动 / 主账号登录）。
 *
 * 本文件是它的**产品配置单一真相源**：provider id、展示名、family 配额顺序、
 * 服务端「这是 antigravity 面板」的判别函数。协议常量（超时、最低版本、
 * fallback 模型表）在 `src/agy/types.ts` 的 `PluginConfig` / `DEFAULT_FALLBACK_MODELS`，
 * 那是从对面插件逐字节移植的协议层，不动。
 */

/** Antigravity 产品配置。 */
export interface AntigravityProduct {
  /** provider 标识：llm 路由名、账号条目 provider 字段、面板 id 全部用它。 */
  id: 'antigravity'
  /** 面板展示名（与客户端 `PROVIDERS` 的 label 一致）。 */
  displayName: string
}

/** Antigravity 唯一产品配置。 */
export const ANTIGRAVITY: AntigravityProduct = Object.freeze({
  id: 'antigravity',
  displayName: 'Antigravity (Google)',
})

/**
 * provider id 常量（其余模块 import 这个，而不是各处写字面量）。
 *
 * ⚠️ 必须严格等于 `src/agy/types.ts` 的 `PROVIDER_ID`（协议层从对面
 * `dsh-agy-link` 移植、不可改）与它注册给 llm 的路由名，否则
 * `model.list` / `provider.status` 找不到目录。
 */
export const ANTIGRAVITY_PROVIDER_ID: 'antigravity' = ANTIGRAVITY.id

/** family 配额的稳定展示顺序（google / anthropic / openai，与对面一致）。 */
export const ANTIGRAVITY_FAMILY_ORDER = Object.freeze(['google', 'anthropic', 'openai'])

/** 按 provider id 取 Antigravity 产品；非 antigravity 返回 undefined。 */
export function antigravityProductById(provider: string): AntigravityProduct | undefined {
  return provider === ANTIGRAVITY.id ? ANTIGRAVITY : undefined
}
