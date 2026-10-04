/**
 * 豆包（字节跳动 Doubao 桌面客户端）产品配置单一真相源。
 *
 * ## 路线 C：非凭据型本地客户端联动面板
 *
 * 豆包桌面客户端（Doubao / 豆包办公）自带独立账号登录态、
 * 并在本地持久化用户信息与状态。本方案（方案 1）仅作：
 * 1. 本地豆包桌面端状态探测（安装状态、安装目录、版本号、运行中进程与窗口可见性）；
 * 2. 当前登录 UID 感知（读 `%APPDATA%\Doubao\public_config.json` 与状态）；
 * 3. 协议一键唤醒面板（调用 `doubao://` 协议或启动可执行文件唤醒官方客户端）。
 *
 * - 没有 `ctx.credentials` 条目，不产生空中凭据；
 * - `REF_PREFIX_TO_PROVIDER` 刻意不含 `DOUBAO`；
 * - 标准动词 `provider.status` / `account.list` / `account.refresh` 适配，
 *   配以 `doubao.status` / `doubao.probe` / `doubao.launch` 扩展动词。
 */

/** 豆包产品配置。 */
export interface DoubaoProduct {
  /** provider 标识：面板 id、账号 provider 字段统一使用。 */
  id: 'doubao'
  /** 面板展示名（与客户端 PROVIDERS 的 label 一致）。 */
  displayName: string
}

/** 豆包唯一产品配置。 */
export const DOUBAO: DoubaoProduct = Object.freeze({
  id: 'doubao',
  displayName: 'Doubao (豆包)',
})

/** provider id 常量（其余模块 import 这个，而不是各处写字面量）。 */
export const DOUBAO_PROVIDER_ID: 'doubao' = DOUBAO.id

/** URL Scheme 唤醒协议。 */
export const DOUBAO_PROTOCOL_SCHEME = 'doubao://'

/** Windows 注册表卸载信息键名。 */
export const DOUBAO_REG_UNINSTALL_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Doubao'

/** Windows 注册表 URL Scheme 注册键名。 */
export const DOUBAO_REG_PROTOCOL_KEY = 'Software\\Classes\\doubao\\shell\\open\\command'

/** 按 provider id 取 Doubao 产品；非 doubao 返回 undefined。 */
export function doubaoProductById(provider: string): DoubaoProduct | undefined {
  return provider === DOUBAO.id ? DOUBAO : undefined
}
