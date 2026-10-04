/**
 * Antigravity 控制面的**唯一出口**（客户端侧）。
 *
 * ## 为什么单独一个文件
 *
 * Jet Hub 面板（`antigravity-panel.js`）**不得**直接写 `rpcCall('…')` 端点名，
 * 一律经过本模块。本模块是「面板 ↔ jet-hub RPC」的唯一翻译层：缺席判定、
 * 错误归类、参数形状全部在这一层做完（与 `docs/antigravity-jet-hub-integration-plan.md`
 * §2.3 的迁移约束同一条纪律 —— 面板只见方法名，不见端点）。
 *
 * ## 与其它 13 家的接入一致性（2026-10-02 对齐方案）
 *
 * 其余面板的全部动作都是**标准 Jet Hub 动词**（`account.*` / `login.poll` /
 * `model.*` / `provider.*`）。Antigravity 的账号动作同样走标准动词 —— 服务端
 * 在各 case 内按 provider 分派到 `antigravity` 服务（非凭据型：账号池住
 * `~/.dsh/agy-accounts/pool.json`，凭据归官方 `agy` 二进制）。
 * 只有**无标准对应物**的动作走 `antigravity.*` 扩展动词（文件内逐一注明理由）。
 *
 * ## 方法名 ↔ RPC 端点对照
 *
 * | 方法 | RPC 端点 | 性质 |
 * |---|---|---|
 * | status() | antigravity.status | 扩展（毫秒级内存快照，面板轮询驱动） |
 * | accounts() | account.list {provider:'antigravity'} | 标准 |
 * | probe() | antigravity.probe | 扩展（慢探针，用户显式点） |
 * | loginBegin(alias,proxy) | account.create {provider,alias,proxyUrl} | 标准（两步式，立即回 loginUrl+qrDataUrl） |
 * | loginPoll(accountId) | login.poll {provider,accountId} | 标准 |
 * | loginSubmitCode(code) | antigravity.loginSubmitCode | 扩展（agy 登录需人工粘码，无对应标准动词） |
 * | loginCancel() | antigravity.loginCancel | 扩展（同上） |
 * | loginBeginPrimary(proxy) | antigravity.loginBeginPrimary | 扩展（主账号=真实 HOME，非「新建账号」） |
 * | accountToggle(id,enabled) | account.update {patch:{enabled}} | 标准 |
 * | accountRename(id,alias) | account.update {patch:{alias}} | 标准 |
 * | accountRemove(id) | account.delete | 标准 |
 * | accountReorder(orderedIds) | account.reorder | 标准 |
 * | accountRefresh(id) | account.refresh | 标准（agy 语义=登录态真探+配额刷新） |
 * | refreshQuota(id) | account.retest / account.retestAll | 标准（agy 的「重测」=强制配额刷新） |
 * | clearCooldown(id) | account.reset / account.resetAll | 标准（agy 的「重置」=清限流冷却） |
 * | accountSetPrimary(id) | antigravity.setPrimary | 扩展（多账号池的 primary 概念，标准动词没有） |
 * | poolSetMode(mode) | antigravity.setMode | 扩展（sequential↔round-robin 选号策略） |
 * | accountSetProxy(id,url) | antigravity.setProxy | 扩展（每账号代理 URL） |
 * | openTerminal(id) | antigravity.openTerminal | 扩展（在隔离 HOME 开终端，独有能力） |
 * | models() | antigravity.models | 扩展（不受登录门控的目录快照，信息性列表） |
 */

/** provider id（与服务端 `ANTIGRAVITY_PROVIDER_ID` 逐字节一致）。 */
const PROVIDER = 'antigravity';

/**
 * 构造面板用的 API 对象。
 *
 * @param rpcCall Jet Hub 注入的 RPC 调用器（`rpcCall(endpoint, payload)`）。
 */
export function createAntigravityApi(rpcCall) {
  if (typeof rpcCall !== 'function') {
    // 单测 / 非 Web 环境：给一组返回「不可用」的桩，避免面板崩。
    const dead = async () => ({ ok: false, error: 'rpc unavailable' });
    return {
      status: dead, accounts: dead, probe: dead,
      loginBegin: dead, loginPoll: dead, loginBeginPrimary: dead,
      loginSubmitCode: dead, loginCancel: dead,
      accountToggle: dead, accountRename: dead, accountRemove: dead,
      accountReorder: dead, accountRefresh: dead,
      accountSetPrimary: dead, accountSetProxy: dead, poolSetMode: dead,
      refreshQuota: dead, clearCooldown: dead, openTerminal: dead, models: dead,
    };
  }

  // 统一解包：RPC 返回 value 或抛错。压成面板惯用的 {ok, ...}。
  const call = async (endpoint, payload) => {
    try {
      const value = await rpcCall(endpoint, payload ?? {});
      return { ok: true, value, data: value };
    } catch (caught) {
      return { ok: false, error: caught?.message || String(caught) };
    }
  };

  return {
    /** 整体状态：二进制/版本/休眠原因 + 登录态 + 账号池 + 目录来源（毫秒级快照）。 */
    async status() {
      const res = await call('antigravity.status');
      if (!res.ok) return res;
      const v = res.value ?? {};
      return {
        ok: true,
        // 面板读 res.status.* —— 把 RPC 的 value 原样放到 status 字段。
        status: v,
        pool: v.pool ?? null,
        // 休眠（二进制缺失/版本过旧）单独标记，面板据此显示休眠提示而非「未登录」。
        dormant: v.dormantReason ?? null,
      };
    },

    /** 账号列表（标准动词 `account.list`；服务端按 provider 分派到 agy 池）。 */
    async accounts() {
      const res = await call('account.list', { provider: PROVIDER });
      if (!res.ok) return res;
      return { ok: true, accounts: res.value?.accounts ?? [] };
    },

    /**
     * 慢探针：真探登录态（spawn `agy models`）+ 模型目录发现。
     *
     * ⚠️ 未登录时这个调用会**挂约 15 秒**（agy 不打印登录 URL，要等
     * watchdog 杀进程）——所以它只给「刷新」按钮和登录成功后的回填用，
     * **绝不**进轮询。轮询走 `status()`（毫秒级内存快照）。
     */
    async probe() {
      const res = await call('antigravity.probe');
      if (!res.ok) return res;
      const v = res.value ?? {};
      return { ok: true, value: v, data: v, auth: v.auth ?? null, pool: v.pool ?? null };
    },

    /**
     * 新增副账号（隔离 HOME）：**标准两步式** `account.create`。
     * 立即返回 loginUrl + qrDataUrl（宿主侧自动开浏览器；loopback 失败时
     * 降级为面板里人工粘码，走 loginSubmitCode）。
     *
     * ⚠️ 这里把标准响应形状（`accountId` / `loginUrl`）归一成面板的登录态形状
     * （`url` / `phase:'waiting'`），这样面板对 `account.create`（标准）与
     * `antigravity.loginBeginPrimary`（扩展，直接回流程状态）**用同一个视图**，
     * 不必在渲染处分支。翻译只在本模块发生（面板不见端点形状）。
     */
    async loginBegin(alias, proxyUrl) {
      const res = await call('account.create', { provider: PROVIDER, alias, proxyUrl });
      if (!res.ok) return res;
      const v = res.value ?? {};
      const seeded = {
        ok: true,
        accountId: v.accountId,
        url: v.loginUrl ?? '',
        qrDataUrl: v.qrDataUrl,
        phase: 'waiting',
        data: { url: v.loginUrl ?? '', qrDataUrl: v.qrDataUrl, phase: 'waiting' },
      };
      return seeded;
    },

    /** 登录轮询：**标准动词** `login.poll`（服务端把 agy 流程状态归一成 done/success）。 */
    async loginPoll(accountId) {
      return call('login.poll', { provider: PROVIDER, accountId });
    },

    /**
     * 登录**主账号**（真实系统 HOME）。扩展动词。
     *
     * 与 loginBegin 的区别：begin 建隔离副账号；beginPrimary 把 token 写进
     * 真实 HOME，官方 agy 直接认。池里只有主账号时这是唯一登录入口 ——
     * 缺它会出现「未登录 ⇒ 门控隐藏模型 ⇒ 找不到登录按钮」的死循环
     * （2026-10-02 用户报障「模型列表里没有」的根因之一）。
     *
     * 返回值同样归一成面板的登录态形状（见 `loginBegin`）。
     */
    async loginBeginPrimary(proxyUrl) {
      const res = await call('antigravity.loginBeginPrimary', { proxyUrl });
      if (!res.ok) return res;
      const v = res.value ?? {};
      return { ok: true, data: v, url: v.url ?? '', qrDataUrl: v.qrDataUrl, phase: v.phase ?? 'waiting' };
    },

    /** 提交授权码 / 授权回调 URL（loopback 失败时的手动兜底）。 */
    async loginSubmitCode(code) {
      return call('antigravity.loginSubmitCode', { code });
    },

    async loginCancel() {
      return call('antigravity.loginCancel', {});
    },

    /** 启用 / 停用账号：标准 `account.update`。 */
    async accountToggle(id, enabled) {
      return call('account.update', { accountId: id, patch: { enabled } });
    },

    /** 改别名：标准 `account.update`（patch.alias）。 */
    async accountRename(id, alias) {
      return call('account.update', { accountId: id, patch: { alias } });
    },

    async accountRemove(id) {
      return call('account.delete', { accountId: id });
    },

    /** 拖拽排序：标准 `account.reorder`（orderedIds 即选号优先级）。 */
    async accountReorder(orderedIds) {
      return call('account.reorder', { provider: PROVIDER, orderedIds });
    },

    /** 账号「刷新」：标准 `account.refresh`（agy 语义 = 登录态真探 + 配额刷新）。 */
    async accountRefresh(id) {
      return call('account.refresh', { accountId: id });
    },

    /** 重测 = 强制配额刷新；省略 id 即全部（标准 `account.retest*`）。 */
    async refreshQuota(id) {
      return id
        ? call('account.retest', { accountId: id })
        : call('account.retestAll', { provider: PROVIDER });
    },

    /** 重置 = 清限流冷却；省略 id 即全部（标准 `account.reset*`）。 */
    async clearCooldown(id) {
      return id
        ? call('account.reset', { accountId: id })
        : call('account.resetAll', { provider: PROVIDER });
    },

    /** 设为主账号（扩展：标准动词没有 primary 概念）。 */
    async accountSetPrimary(id) {
      return call('antigravity.setPrimary', { accountId: id });
    },

    /** 代理 URL（扩展：每账号代理，标准 patch 只有 enabled/alias）。 */
    async accountSetProxy(id, proxyUrl) {
      return call('antigravity.setProxy', { accountId: id, proxyUrl });
    },

    /** 选号模式（扩展：sequential ↔ round-robin）。 */
    async poolSetMode(mode) {
      return call('antigravity.setMode', { mode });
    },

    /** 在该账号的隔离 HOME 里开终端（扩展：独有能力）。 */
    async openTerminal(id) {
      return call('antigravity.openTerminal', { accountId: id });
    },

    /**
     * 设置默认思考档位（面板开关，2026-10-03；扩展动词）。
     *
     * 语义：只影响**模型目录未钉死档位**时的兜底值 —— 用户在 DSH 模型选择器里
     * 选的档位始终优先。传 `''` = 取消面板覆盖、跟随模型默认。
     */
    async setDefaultEffort(effort) {
      return call('antigravity.setDefaultEffort', { effort: effort ?? '' });
    },
  };
}

/**
 * family 的稳定展示顺序（quota 渲染用，与服务端 `ANTIGRAVITY_FAMILY_ORDER` 一致）。
 */
export const AGY_FAMILY_ORDER = Object.freeze(['google', 'anthropic', 'openai']);

/**
 * 把 `ManagedAccount.quotas` 摊成面板可渲染的定序数组。
 * 缺失的 remainingFraction 必须表达为未知（null）而非 0 —— 把「还没查过」
 * 渲染成「已用光」会让用户误删账号。
 */
export function normalizeQuotaRows(quotas) {
  if (!quotas || typeof quotas !== 'object') return [];
  const known = AGY_FAMILY_ORDER.filter((family) => quotas[family]);
  const extra = Object.keys(quotas)
    .filter((family) => !AGY_FAMILY_ORDER.includes(family) && quotas[family])
    .sort();
  return [...known, ...extra].map((family) => {
    const q = quotas[family] || {};
    return {
      family,
      remaining: Number.isFinite(q.remainingFraction) ? q.remainingFraction : null,
      resetAt: q.resetTime ?? null,
      weekly: Number.isFinite(q.weeklyFraction) ? q.weeklyFraction : null,
      weeklyResetAt: q.weeklyResetTime ?? null,
      models: Array.isArray(q.models) ? q.models : [],
      updatedAt: q.updatedAt ?? null,
    };
  });
}

/** 百分比文本：未知如实显示「未查询」，绝不显示 0%。 */
export function quotaPercentText(fraction) {
  if (!Number.isFinite(fraction)) return '未查询';
  return `${Math.max(0, Math.min(100, Math.round(fraction * 100)))}%`;
}

/** 冷却剩余时间文本（面板轮询驱动，不自建计时器）。 */
export function cooldownText(cooldown, now = Date.now()) {
  if (!cooldown || !Number.isFinite(cooldown.cooldownUntil)) return null;
  const left = cooldown.cooldownUntil - now;
  if (left <= 0) return null;
  const minutes = Math.floor(left / 60_000);
  const unit = minutes >= 1 ? `${minutes} 分钟` : `${Math.ceil(left / 1000)} 秒`;
  return `${cooldown.reason || '限流冷却'} · 约 ${unit}后恢复`;
}

/**
 * 账号健康判据。
 * 顺序不能改：`auth_required` 必须先于 cooldown 判。
 */
export function accountHealthOf(account, now = Date.now()) {
  if (!account) return { status: 'unknown', message: '账号不存在' };
  if (account.enabled === false) return { status: 'disabled', message: '已停用' };
  if (account.authRequired) return { status: 'auth_required', message: account.authError || '需要重新登录' };
  const cooldowns = account.cooldowns ?? {};
  for (const family of Object.keys(cooldowns)) {
    const text = cooldownText(cooldowns[family], now);
    if (text) return { status: 'cooldown', message: text, family };
  }
  return { status: 'healthy', message: null };
}

/**
 * 把服务端 `account.list` 回的 agy 账号映射成共享 `AccountCard` 的形状。
 *
 * ⚠️ 只做共享卡片**真正消费**的字段；agy 专属维度（systemHome / dir /
 * cooldowns / quotas / proxyUrl / isPrimary）原样带上，由面板的 agy 专属区
 * 渲染。「重测/重置」按钮的禁用判据（`hasAnyLimit`）经 `modelRateLimits`
 * 表达：agy 的限流载体是 family cooldown（无逐模型标记），把每个 family 的
 * `cooldownUntil` 映射成一条「限额重置」记录 —— key 用 family 名，共享卡片
 * 的徽标行就显示「google · 10:32」这类**真语义**（而不是造假数据）。
 * `expiresAt` 留空 —— agy 的凭据由官方二进制持有、没有「本插件视角的
 * 有效期」，共享卡片显示「未知」，这是**如实**而不是缺数据。
 */
export function sharedCardOf(account, nickname) {
  const cooldowns = account.cooldowns ?? {};
  const now = Date.now();
  const rateLimits = {};
  for (const family of Object.keys(cooldowns)) {
    const until = cooldowns[family]?.cooldownUntil;
    if (Number.isFinite(until) && until > now) rateLimits[family] = until;
  }
  return {
    id: account.id,
    provider: PROVIDER,
    nickname,
    enabled: account.enabled !== false,
    credentialRef: '',
    expiresAt: undefined,
    refreshable: false,
    modelRateLimits: Object.keys(rateLimits).length > 0 ? rateLimits : undefined,
    // agy 专属（共享卡片不消费，面板的 agy 区块用）：
    systemHome: account.systemHome === true,
    accountDir: account.accountDir ?? account.dir ?? '',
    proxyUrl: account.proxyUrl ?? '',
    authRequired: account.authRequired === true,
    authError: account.authError ?? '',
    cooldowns,
    quotas: account.quotas ?? {},
    isPrimary: account.isPrimary === true,
  };
}
