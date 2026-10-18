/**
 * 左侧供应商导航的分组与「一键开关」状态判定（纯逻辑）。
 *
 * ## 为什么单独成文件
 *
 * 与 `model-bulk.js` / `model-filter.js` / `account-model-link.js` 同理：本仓库
 * 的单测环境里 react 不在依赖内，组件无法渲染。把判定抽成纯函数才能用真实断言
 * 覆盖，而不是靠源码级字符串匹配间接验证。
 *
 * ## 「已关闭」的判据不在前端重算
 *
 * 判据是「该供应商的**全部模型都已关闭**」，由宿主侧 `provider.status` 端点的
 * `closed` 字段直接给出，本模块**只读不判**。
 *
 * 这是刻意的：宿主侧要按 id 逐个比对全量目录与黑名单才能算准，前端若再实现一遍
 * （比如拿 `disabled` 计数自行比较），两处判据迟早会漂移 —— 典型症状是
 * 「左侧说已关闭、账号联动却说模型没全关」这种自相矛盾。
 *
 * ⚠️ 宿主侧 `closed` 与 `account-model-link.js` 的 `allModelsDisabled(models)`
 * 是**语义同源、形态不同**的一对（一个看计数、一个看条目数组），它们的边界条件
 * 必须一起改：都要求「至少有一个模型」才算全部关闭 —— 没有任何模型时不算已关闭
 * （没有模型可关，就不该说它被关闭了）。
 */

/**
 * 按「已打开 / 已关闭」把供应商分成两组。
 *
 * - 组内**保持传入顺序**（即 `PROVIDERS` 的声明顺序），不做任何重排：用户对
 *   供应商的认知顺序是稳定的，每次刷新都按别的方式排序会让人找不到它。
 * - 状态缺失（`provider.status` 尚未返回、或该 provider 不在响应里）一律归入
 *   **已打开**：宁多勿少。若归入已关闭，一次请求失败就会让整列供应商看起来
 *   被关掉了，用户会以为数据丢了。
 * - `closed` 只认**显式 `true`**：与适配器黑名单「只有显式 true 才算关闭」
 *   的判据保持一致。
 *
 * @param {Array<{ id: string }>} providers 供应商定义列表（顺序即展示顺序）
 * @param {Record<string, { closed?: boolean }> | null} statuses provider id → 状态
 * @returns {{ open: Array<object>, closed: Array<object> }}
 */
export function groupProviders(providers, statuses) {
  const list = Array.isArray(providers) ? providers : [];
  const map = statuses && typeof statuses === 'object' ? statuses : {};
  const open = [];
  const closed = [];
  for (const provider of list) {
    // ⚠️ 局部变量**不能**叫 `closed`：那会遮蔽上面要收集结果的 `closed` 数组，
    // 于是 `closed.push` 变成在布尔值上调用方法、抛 `closed.push is not a function`
    // （真实缺陷，已由单测捕获）。命名为 `isClosed` 以明确它是判定而非容器。
    const isClosed = map[provider?.id]?.closed === true;
    if (isClosed) closed.push(provider);
    else open.push(provider);
  }
  return { open, closed };
}

/**
 * 计算某个供应商开关的呈现状态。
 *
 * 三种形态（对应原型的「已打开 / 已关闭 / 禁用」）：
 * - **已打开**：`checked = true`，可点击 → 点击即关闭它；
 * - **已关闭**：`checked = false`，可点击 → 点击即打开它；
 * - **禁用**：`disabled = true` 且附 `reason`，不可点击。
 *
 * 禁用的判据是 `models.total === 0`（没有任何可用模型）。这直接落实
 * 「不关闭模型就不关闭供应商」：没有模型可关时，关闭动作在服务端会被拒绝
 * （见 `provider.setEnabled`），故开关**不该让用户点得动** —— 否则点击后
 * 只得到一句错误提示，属于把服务端的约束暴露成用户的操作挫折。
 *
 * ⚠️ **没有模型的供应商不再禁用**（真实缺陷修复，用户报障 2026-10-18）：
 * 原判据与「服务端拒绝关闭」是一体两面，结果「Step Code（阶跃）」这类零模型
 * 供应商**永远关不掉** —— 既被算作已打开（没有模型可关 ⇒ 不算已关闭），又被
 * 禁用（点不动）。现服务端已支持无模型时关闭（停用账号 + 记下关闭意图），
 * 故这里同步放开；`checked` 照常读后端给的 `closed`。
 *
 * 状态未知（undefined / 字段缺失）同样禁用：此时既不知道它开没开，也不知道
 * 有几个模型，让用户点一个状态不明的开关更糟。分组那边则仍把它显示在「已打开」
 * 组（宁多勿少），两处取舍不同是有意的 —— 显示可以保守，操作必须明确。
 *
 * @param {{ models?: { total?: number }, accounts?: { total?: number }, closed?: boolean } | undefined} status
 * @returns {{ checked: boolean, disabled: boolean, reason: string | null }}
 */
export function providerSwitchState(status) {
  if (status === undefined || status === null || typeof status !== 'object') {
    return { checked: true, disabled: true, reason: '状态尚未读取' };
  }
  // ⚠️ 这里**不再按 models.total 分流**：无论有没有模型，「已关闭」都由后端
  // 的 `closed` 决定（无模型时它来自整供应商标记），且都可点击。
  // 旧实现在 total === 0 时返回禁用，导致零模型供应商永远关不掉。
  return { checked: status.closed !== true, disabled: false, reason: null };
}

/**
 * 把一次供应商开关操作的结果汇总成一行可读文案。
 *
 * 要点：**实际变更数可能与预期不同**。例如两个账号本就已停用，关闭供应商时
 * `accounts` 会返回 0 —— 提示必须照实说「无需变更」，而不是恒定报「已停用 2 个」，
 * 后者会让用户以为自己没看到的改动发生了。
 *
 * @param {boolean} enabled 目标状态
 * @param {{ models?: number, accounts?: number } | null} res 端点返回的变更数
 * @returns {string}
 */
export function summarizeProviderToggle(enabled, res) {
  const models = typeof res?.models === 'number' ? res.models : 0;
  const accounts = typeof res?.accounts === 'number' ? res.accounts : 0;
  if (enabled) {
    const parts = [];
    parts.push(models > 0 ? `已打开 ${models} 个模型` : '模型本就全部打开');
    parts.push(accounts > 0 ? `已启用 ${accounts} 个账号` : '账号本就全部启用');
    return parts.join('，');
  }
  const parts = [];
  parts.push(models > 0 ? `已关闭 ${models} 个模型` : '没有模型需要关闭');
  parts.push(accounts > 0 ? `已停用 ${accounts} 个账号` : '没有账号需要停用');
  return parts.join('，');
}

/**
 * 「供应商开关」弹窗的行数据：已打开在前、已关闭在后，每行自带开关呈现状态。
 *
 * ## 为什么单独抽出来
 *
 * 弹窗要渲染的既不是「供应商定义」也不是「状态表」，而是两者的**拼接结果**：
 * 顺序（分组）、勾选态、禁用态与原因、影响面计数。留在组件里就等于把判定
 * 写回 UI —— 本模块的存在前提正是「判定不落在渲染层」（见文件头）。
 *
 * ## 三条必须保住的口径
 *
 * - **顺序与分组直接复用 {@link groupProviders}**：与左侧 rail 用的是同一份
 *   判据，两处不可能出现「左侧说它关了、弹窗里它还是开的」。
 * - **勾选态与禁用态直接复用 {@link providerSwitchState}**：包括那条容易漏的
 *   「`models.total === 0` ⇒ 禁用并给出原因」—— 没有模型可关时服务端会拒绝
 *   关闭动作，让用户点得动只会得到一句错误提示。
 * - **计数原样带出，不在这里格式化**：文案属于渲染层，判据属于本模块。
 *   拿不到状态时给 `null` 而不是 `{total:0}` —— 二者含义不同：
 *   「不知道」与「确实是 0 个」在界面上必须区别对待（前者显示 `—`）。
 *
 * @param {Array<{ id: string, label?: string }>} providers 供应商定义（顺序即组内顺序）
 * @param {Record<string, object> | null} statuses provider id → `provider.status` 条目
 * @returns {Array<{ id: string, label: string, checked: boolean, disabled: boolean,
 *   reason: string | null, models: {total?: number, disabled?: number} | null,
 *   accounts: {total?: number, enabled?: number} | null }>}
 */
export function providerSwitchRows(providers, statuses) {
  const { open, closed } = groupProviders(providers, statuses);
  /** @param {{ id: string, label?: string }} provider */
  const toRow = (provider) => {
    const id = provider?.id;
    const status = statuses && typeof statuses === 'object' ? statuses[id] : undefined;
    const sw = providerSwitchState(status);
    return {
      id,
      label: provider?.label || id,
      checked: sw.checked,
      disabled: sw.disabled,
      reason: sw.reason,
      models: status?.models ?? null,
      accounts: status?.accounts ?? null,
    };
  };
  // 已打开在前：与 rail 的分组顺序一致，用户在两处看到的是同一个排列。
  return [...open.map(toRow), ...closed.map(toRow)];
}

/**
 * 供应商开关的计数摘要（页头按钮的 tooltip 与弹窗副标题共用）。
 *
 * `statuses` 为 null（尚未读到 / 读取失败）时三个计数都是 0 —— 调用方据此
 * **不显示计数**，而不是显示「0 / 0」让用户以为一个供应商都没有。
 *
 * @param {Array<{ id: string }>} providers
 * @param {Record<string, object> | null} statuses
 * @returns {{ open: number, closed: number, total: number, known: boolean }}
 */
export function providerToggleSummary(providers, statuses) {
  const list = Array.isArray(providers) ? providers : [];
  const { open, closed } = groupProviders(list, statuses);
  return {
    open: open.length,
    closed: closed.length,
    total: list.length,
    known: statuses !== null && statuses !== undefined && typeof statuses === 'object',
  };
}
