import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 源码级断言的**共享语义锚点**。
 *
 * ## 为什么需要它（真实事故，2026-10-13）
 *
 * 本仓库多份 spec 用「先 `indexOf(某段文本)` 取起点、再切片断言」的方式做
 * 源码级回归。这种写法在**某段文本第一次出现的位置发生变化**时会**静默错位**：
 * 每日自动签到把 `credits.claimAll` 的实现抽成模块级 `claimAllForProvider()`
 * 之后，新函数里出现了 `case TELEAGENT.id:` / `case RACCOON.id:` 这些**与
 * `account.refresh` 分支同形**的文本 ⇒ 那些断言跑去新函数里找「账号刷新逻辑」，
 * 以「切片里找不到某段文本」的形式失败 —— 而根因与它们要守的行为毫无关系。
 *
 * ⇒ 起点必须是**语义锚点**（函数名 / case 名），不能是「某文本第一次出现的
 * 位置」。本文件把跨 spec 复用的锚点收成一处（与 `src/` 的分层同理：
 * 同一份定位逻辑写三遍，下次重构就要改三处）。
 *
 * ⚠️ 本文件**不是** spec（没有 `.spec.ts` 后缀），故不会被 vitest 收集为用例
 *（`vitest.config.ts` 的 `include` 只匹配 `*.spec.ts`）。
 *
 * ⚠️ 写注释时别在块注释里逐字写出带 `*` 的 glob（如 `tests/unit/` 后接
 * `**` 再接 `/*.spec.ts`）：其中的 `*` + `/` 会**提前闭合块注释**，症状是
 * esbuild 报 `Unexpected "*"` —— 本文件第一版就这么写坏过。
 */

const HERE = dirname(fileURLToPath(import.meta.url))

/** `src/jet-hub-rpc.ts` 的源码文本（多个 spec 共用同一份读取）。 */
export const JET_HUB_RPC_SOURCE: string = readFileSync(
  resolve(HERE, '../../src/jet-hub-rpc.ts'),
  'utf8',
)

/**
 * 取 `claimAllForProvider()` 的实现体 —— 即原 `case 'credits.claimAll'` 里的
 * 全部渠道分支。
 *
 * ⚠️ 2026-10-13 起该实现**不在** `case 'credits.claimAll'` 里：它被抽成模块级
 * 函数，供 RPC 与**每日自动签到**（`src/index.ts` 的启动触发）共用同一份
 * ——「哪个 provider 要不要预检状态」这类分支知识只能有一份。
 * 断言「领取分支做了 X」的用例必须锚定这里，锚 `case 'credits.claimAll'`
 * 切片只会得到一个 25 行的转发块。
 *
 * 结束锚点用紧随其后的 `autoCheckinUnavailable()`：它是本文件里
 * `claimAllForProvider` 之后的第一个顶层函数声明，且**只出现在这里**
 *（用它而不是「按字符数截取」，后者在注释变动时会静默截多或截少）。
 *
 * @throws 找不到起点或终点时抛错 —— 宁可让用例以「锚点失效」失败，
 *   也不要返回一个空串让后续 `toContain` 变成必然失败却看起来像业务缺陷。
 */
export function claimAllImplementation(source: string): string {
  const start = source.indexOf('export async function claimAllForProvider(')
  if (start === -1) {
    throw new Error('未找到 claimAllForProvider（被重命名 / 删除了？请同步本锚点）')
  }
  const end = source.indexOf('function autoCheckinUnavailable', start)
  return source.slice(start, end === -1 ? source.length : end)
}
