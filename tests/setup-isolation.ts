/**
 * 单测隔离：**每个测试文件一个独立的 Jet Hub 状态目录**。
 *
 * ## 为什么需要它（实测到的既有竞态）
 *
 * Jet Hub 的持久化后端解析顺序（`src/jet-hub-store.ts`）：
 *
 * ```
 * ① settings 老契约命名空间
 * ② DSH_JET_HUB_STATE_DIR     ← 测试环境在这里拦
 * ③ profileContext.home
 * ④ DSH_HOME
 * ⑤ homedir()/.dsh            ← 兜底：真实用户目录！
 * ```
 *
 * 而绝大多数 spec 只 `provide('credentials')`、不 provide `settings`，
 * 于是 `createJetHubStore` 一路落到第 ② 条（测试环境设了该变量）。
 *
 * ⚠️ **但原来那个变量是在 `vitest.config.ts` 顶层 `mkdtempSync` 出来的
 * ——config 求值只发生一次，所有 worker 共享同一个目录。**
 * 后果：并行跑的多个 spec 同时读写**同一个** `state.json`，
 * 后写的覆盖先写的，于是 `AccountPool.listAccounts()` 可能拿到
 * *另一个 spec 的*账号列表。
 *
 * 观测到的形态（符合文件竞态的一切特征）：
 * - 全套跑时偶发 `cline-auth.spec.ts` 的 `addAccount` 断言失败；
 * - 该 spec **单独跑必然通过**；
 * - 连续复跑 3 次又全绿（约 1/5 的复现率）。
 *
 * ## 修法
 *
 * 在 `setupFiles` 里**按测试文件**重新生成目录 —— setup 文件对每个
 * 测试文件各执行一次，故每个文件拿到自己的目录，互不干扰。
 * 同时它仍然拦住了第 ⑤ 条兜底，**不会污染真实的 `~/.dsh`**。
 *
 * ⚠️ QODER_RUNTIME_INFO 不需要每文件独立（它只是一个「不存在的路径」），
 * 但必须与状态目录分开 —— 否则一个名为 `no-such-runtime-info` 的目录
 * 可能被 `mkdtemp` 意外创建出来。
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 每个测试文件独享的状态目录。 */
const stateDir = mkdtempSync(join(tmpdir(), 'dsh-jet-hub-'))

process.env.DSH_JET_HUB_STATE_DIR = stateDir

/**
 * Qoder 设备身份：**测试里绝不能真的 spawn `runtime-info.exe`**
 * （单次约 3.8 秒，且结果随开发机是否装了桌面端而变）。
 * 指向不存在的路径即等价于「未安装」。
 */
if (process.env.QODER_RUNTIME_INFO === undefined) {
  process.env.QODER_RUNTIME_INFO = join(stateDir, 'no-such-runtime-info')
}

/**
 * Antigravity（Google）的账号池：agy 池（`agy-service.ts` → `src/agy/pool.ts`
 * 的 `defaultPoolDir()`）解析 `${DSH_STATE_DIR:-~/.dsh}/agy-accounts/`，
 * 而上面的 `DSH_JET_HUB_STATE_DIR` 管不到它（那条变量只作用于本插件自己的
 * `jet-hub/state.json`）。不设这个覆盖，单测就会读到开发机真实的 agy 账号池、
 * 甚至 `bootstrapDefaultAccount` 会往真目录写 primary 槽位 —— `account.list` /
 * `provider.status` 的结果于是取决于"这台机器装没装 antigravity、登了几个号"。
 * 指向每个测试文件自己的临时目录即等价于"空池"，正是绝大多数用例要的形态。
 *
 * ⚠️ 全仓库只有 `src/agy/pool.ts` 读这个变量（grep 可证），测试里覆盖无副作用。
 */
process.env.DSH_STATE_DIR = stateDir
