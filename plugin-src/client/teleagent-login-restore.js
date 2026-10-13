/**
 * TeleAgent「等待粘贴回调地址」入口的可恢复判定（纯逻辑）。
 *
 * ## 为什么只有 TeleAgent 需要这个
 *
 * TeleAgent 是十四个面板里**唯一**要用户手动粘贴回调 URL 的：它的回调地址是
 * 服务端常量（官方 asar 里 `LOGIN_PAGE` 写死，没有 `redirect_uri` 可配），
 * 插件既起不了本地监听、也注册不了 `teleai-cowork://` 协议 —— token 只出现在
 * 浏览器最终那一页的地址栏里，后端抓不到，只能请用户粘回来。
 *
 * ## 本模块修掉的真实缺陷
 *
 * 粘贴框原先只由 `ProviderPanel` 的内存 state `teleagentPending` 控制，
 * 而该组件在**切换 provider 时会被强制重新挂载**（`JetHubPage` 的 panelEpoch），
 * 重开设置页同理。于是：
 *
 * > 用户点「+ 新建账号」→ 粘贴框出现 → 只要切走一次或重开设置页，
 * > 粘贴框**永久消失**，而后端的占位条目还在。
 *
 * 用户看到的后果（2026-10-07 实测截图）：账号卡片显示绿色「已启用」，
 * 积分/签到一律报「凭据未配置」，顶部挂着「1 个失败」，
 * 而界面上**没有任何入口**能继续那次没走完的登录 —— 只能删号重来。
 *
 * 后端那条提交通路（`teleagent.loginSubmitCallback`）其实**一直可用**：
 * 它只查 `pool.findAccount(accountId)`，不依赖内存里的 `pendingLogins`，
 * 所以 DSH 重启过、10 分钟超时已过都还能粘贴成功。**缺的纯粹是入口。**
 *
 * ## 判据为什么必须是 `credentialPresent === false`
 *
 * 不能用「条目存在」或「`credentialRef` 有值」：`account.create` 对每个 provider
 * 都是**先建无凭据的占位条目**（ref 从一开始就写好了），凭据要等登录成功才落盘。
 * 二者并不等价。
 *
 * 也**不能写成 `!credentialPresent`**：非凭据型条目（antigravity 的
 * `credentialRef` 是空串）该字段是 `undefined`，取反会把它们当成「待登录」，
 * 于是给一个根本不需要登录的面板弹出粘贴框。必须严格 `=== false`。
 *
 * 与 `account-model-link.js` / `model-bulk.js` 同理单独成文件：本仓库单测环境里
 * react 不在依赖内，组件无法渲染，故把判定抽成纯函数才能用真实断言覆盖。
 */

/**
 * 选出本次应当显示粘贴框的账号 id。
 *
 * @param {Array<{ id: string, enabled?: boolean, credentialPresent?: boolean, createdAt?: number }>|null} accounts
 *   `account.list` 返回的该 provider 账号列表
 * @param {string|null} currentPending 当前已挂起的 accountId（null 表示没有）
 * @returns {string|null} 应显示粘贴框的 accountId；null 表示不显示
 */
export function pickTeleagentPendingAccountId(accounts, currentPending) {
  const list = Array.isArray(accounts) ? accounts : [];
  // 「启用 + 凭据确实没写」= 一次没走完的登录。
  // enabled 用严格 `=== true`：停用的无凭据条目是历史垃圾，不该为它弹登录框
  // （用户想续的话先启用，框自然出现）。
  const waiting = list.filter(
    (a) => a?.enabled === true && a?.credentialPresent === false,
  );

  if (typeof currentPending === 'string' && currentPending.length > 0) {
    // 已有进行中的粘贴流程：只要它仍未完成就**保持原样**，
    // 否则用户正在输入时一次刷新就会把框切走。
    // 若它已不在等待集合（凭据已写入 / 条目已删除），则收起 ——
    // 让框挂在一个已经不存在的账号上，用户点「完成登录」只会收到「账号不存在」。
    return waiting.some((a) => a?.id === currentPending) ? currentPending : null;
  }

  if (waiting.length === 0) return null;
  // 多条未完成时取**最新**一条：最新那次登录才是用户想续的。
  // `createdAt` 缺失时 `undefined > x` 恒 false，reduce 会保留先者，不会抛错。
  return waiting.reduce((a, b) => ((b?.createdAt ?? 0) > (a?.createdAt ?? 0) ? b : a)).id;
}
