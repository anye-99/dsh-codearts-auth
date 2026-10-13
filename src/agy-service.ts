/**
 * Antigravity 服务封装（宿主侧单例）。
 *
 * 把 `src/agy/` 下那套从 `dsh-agy-link` 移植过来的模块装配成一个服务：
 * - `AccountPoolManager`（账号池，读 `~/.dsh/agy-accounts/pool.json`）
 * - `AuthHelper`（主账号登录）+ `PoolAuthFlow`（副账号登录）
 * - `QuotaService`（配额轮询）
 * - `ModelCatalog`（`agy models` 解析 + fallback）
 * - 进程运行参数（`resolveAgyBin` / `MIN_AGY_VERSION`）
 *
 * ⚠️ 与对面 `dsh-agy-link` 的差异：
 * 对面是**独立插件**（自带 4 个 ctx 分区、自己的 client UI、commands、
 * mcp-bridge、media staging），而本服务**只保留协议层**——Jet Hub 的
 * `antigravity-panel.js` 已经覆盖了 UI，RPC 走 `jet-hub-rpc.ts` 的既有
 * 端点，不需要对面那套 `/plugins/agy-link/*` 控制面。
 *
 * ⚠️ 生命周期：`dispose()` 必须停掉配额轮询与所有未完成的登录探测，
 * 否则 profile 卸载时留下孤儿 interval / spawn。
 */

import type { Context } from '@deepseek-ai/cordis'
import { AuthHelper, type AuthStatus } from './agy/auth.js'
import { ModelCatalog, type Catalog } from './agy/models.js'
import { AccountPoolManager } from './agy/pool.js'
import { PoolAuthFlow, type PoolAuthStatus } from './agy/pool-auth.js'
import { QuotaService } from './agy/quota.js'
import { defaultPoolDir } from './agy/pool.js'
import { compareVersions, MIN_AGY_VERSION, parseVersion, probeProcess, resolveAgyBin } from './agy/runner.js'
import { AGY_MODELS_SPAWN_TIMEOUT_MS, AGY_TOKEN_HEAL_COOLDOWN_MS, type PluginConfig } from './agy/types.js'
import { defaultConfig } from './agy/types.js'
import { AGY_EFFORTS, readAgySettings, writeAgySettings } from './agy/settings.js'

export class AntigravityService {
  private cfg: PluginConfig
  private bin: string | null = null
  private version: string | null = null
  private dormantReason: string | null = null
  /** 上次「探针判未登录 ⇒ 主动续期」的时刻（冷却用，见 `healPrimaryToken`）。 */
  private lastHealAt = 0

  readonly pool: AccountPoolManager
  readonly auth: AuthHelper
  readonly poolAuth: PoolAuthFlow
  readonly quota: QuotaService
  readonly catalog: ModelCatalog

  constructor(private readonly ctx: Context, cfgOverride?: Partial<PluginConfig>) {
    this.cfg = { ...defaultConfig(), ...(cfgOverride ?? {}) }
    // 面板级设置（独立文档，落在 agy 自有目录）覆盖硬编码默认值。
    // ⚠️ 只覆盖**未被显式传入**的字段：调用方（测试、将来的 profile 配置）
    // 传了就不该被磁盘上的旧值盖掉。
    const stored = readAgySettings()
    if (stored.defaultEffort !== '' && (cfgOverride?.defaultEffort ?? '') === '') {
      this.cfg.defaultEffort = stored.defaultEffort
    }

    // 1. 解析二进制与版本
    this.bin = resolveAgyBin(this.cfg)
    if (this.bin) {
      // probe 版本，失败不算致命（agy --version 可能慢）
      probeProcess(this.bin, ['--version'], 5000, undefined, process.env)
        .then(out => {
          this.version = parseVersion(out.stdout + out.stderrTail)
          if (this.version && compareVersions(this.version, MIN_AGY_VERSION) < 0) {
            this.dormantReason = `agy ${this.version} 低于最低支持版本 ${MIN_AGY_VERSION}`
            ctx.logger.warn(`[antigravity] ${this.dormantReason}`)
          }
        })
        .catch(() => {
          this.dormantReason = 'agy --version 探测失败'
        })
    } else {
      this.dormantReason = '未找到 agy 二进制'
    }

    // 2. 账号池（构造即加载 ~/.dsh/agy-accounts/pool.json）
    this.pool = new AccountPoolManager(defaultPoolDir())
    // 自愈：pool.json 可能在运行期被清空（实测 2026-10-02：面板删除主账号卡片后
    // bootstrap 不会重跑），服务装配时再兜一次，保证主账号条目必然存在。
    this.pool.ensurePrimaryAccount()

    // 3. 配额服务（先于 poolAuth 创建，后者依赖它）
    this.quota = new QuotaService(this.pool)

    // 4. 登录辅助（主账号 + 副账号）
    this.auth = new AuthHelper(() => this.bin)
    this.poolAuth = new PoolAuthFlow(this.pool, this.quota, (msg) => ctx.logger.info(`[antigravity] ${msg}`))

    // 5. 模型目录（惰性：首次 catalog() 时才 spawn `agy models`）
    this.catalog = new ModelCatalog(
      async (signal) => {
        if (!this.bin) return { stdout: '', stderr: 'agy binary not found' }
        const out = await probeProcess(this.bin, ['models'], AGY_MODELS_SPAWN_TIMEOUT_MS, signal, process.env)
        return { stdout: out.stdout, stderr: out.stderrTail }
      },
      this.cfg.fallbackModels,
      this.cfg.modelsCacheTtlMs,
    )
  }

  /** 当前桥是否可用（休眠原因）。 */
  get dormant(): string | null { return this.dormantReason }
  get agyBin(): string | null { return this.bin }
  get agyVersion(): string | null { return this.version }
  get config(): PluginConfig { return this.cfg }

  /**
   * 登录门控用的探针：**判未登录时先试着续期一次，再重探**。
   *
   * ⚠️ 为什么必须自愈（2026-10-10 用户报障「模型列表没有 antigravity 的模型」，
   * 本机 agy 1.3.2 实测）：**agy 二进制在 `models` 这条路径上不自己续期** ——
   * 凭据管理器里的 access token 一过期，`agy models` 就直接报 `Please sign in`
   * （实测过期态 21s 失败；把 token 续新后同一条命令 6–12s 返回 14 条）。
   * 而本插件**有**续期能力（`QuotaService.getValidAccessToken`，用 refresh_token
   * 打 Google token 端点，并写回凭据管理器 + 磁盘）。
   *
   * 原先两件事不同步：后台配额轮询每 15 分钟才续一次，探针却据「未登录」把
   * 整个模型分组隐藏最长 15 分钟 —— 用户视角就是「明明登录过、模型列表却是空的」。
   * 现在探针判 false 时立刻补一次续期并**强制重探**，把隐藏时长压到秒级。
   *
   * ⚠️ 续期成功 ≠ 一定翻 true：凭据真被吊销时 `getValidAccessToken` 会把账号标
   * `authRequired`、重探仍 false，行为保持正确（不会把未登录谎报成已登录）。
   */
  async gateProbe(): Promise<boolean | null> {
    const first = await this.auth.probeSignedIn()
    if (first !== false) return first
    const healed = await this.healPrimaryToken().catch(() => false)
    if (!healed) return first
    return this.auth.probeSignedIn(true)
  }

  /**
   * 主动续期主账号的 agy access token（带冷却，见 `AGY_TOKEN_HEAL_COOLDOWN_MS`）。
   *
   * ⚠️ 判据是「凭据**确实变新了**」，不是「拿到了 token」：
   * `QuotaService.getValidAccessToken` 在续期失败时**返回过期的旧 token**
   * 而不是 null（它末尾是 `return tok.accessToken || null`）。若按「非 null」
   * 就算 healed，网络抖动那次会白续一次、白重探一次（每次重探 = 一次
   * 最长 30s 的 `agy models` spawn）。
   * ⇒ 这里比较续期前后的 `expiryMs`，只有真的往后走了才值得重探。
   */
  async healPrimaryToken(): Promise<boolean> {
    const now = Date.now()
    if (now - this.lastHealAt < AGY_TOKEN_HEAL_COOLDOWN_MS) return false
    this.lastHealAt = now
    // ensurePrimaryAccount：主账号条目可能在运行期被外部写空（2026-10-02 实测），
    // 这里自愈取回，别让续期因为「找不到 acc_primary」而静默失败。
    const acc = this.pool.ensurePrimaryAccount()
    const before = this.quota.getStoredToken(acc)?.expiryMs ?? 0
    await this.quota.getValidAccessToken(acc).catch(() => null)
    const after = this.quota.getStoredToken(acc)?.expiryMs ?? 0
    return after > before && after > now
  }

  /**
   * 设置「默认思考档位」（面板开关）。
   *
   * 语义：**只在模型目录没有钉死档位时生效**（`defaultEffortFor` 的兜底路径）。
   * 传空串 = 取消面板覆盖，回到适配器自己的阶梯（high → medium → low）。
   *
   * ⚠️ 改的是**同一份 cfg 对象**（`getConfig()` 每次返回它），所以适配器下一次
   * `stream()` 立即生效，无需重启或重建适配器。
   * ⚠️ 白名单校验在 `writeAgySettings` 里做，落盘的是**净化后**的值；
   * 这里用返回值回填，保证内存态与磁盘态永不背离（否则面板显示的和实际发出的
   * `--effort` 会是两个值）。
   */
  setDefaultEffort(effort: string): { defaultEffort: string } {
    const stored = writeAgySettings({ defaultEffort: effort === '' ? '' : String(effort) })
    this.cfg.defaultEffort = stored.defaultEffort
    return { defaultEffort: this.cfg.defaultEffort }
  }

  /** 合法档位（面板下拉用；与 `--effort` 白名单同源）。 */
  get efforts(): readonly string[] { return AGY_EFFORTS }


  /** 主账号登录状态（惰性探测，带 60s 缓存）。 */
  async authStatus(): Promise<AuthStatus> {
    return this.auth.resolvedStatus()
  }

  /**
   * 强制真探登录态（绕过 60s 缓存）。
   *
   * 给 `agy.probe`（面板「刷新」）用：刚登录完时缓存里可能还是
   * `signed-out`，不强制刷新会让用户看到"登录成功了但状态仍显示未登录"，
   * 最长持续一分钟 —— 正是会被报障成"状态不刷新"的那类落差。
   */
  async probeAuthStatus(): Promise<AuthStatus> {
    const st = this.auth.status()
    if (st.phase !== 'idle') return st
    const signedIn = await this.auth.probeSignedIn(true).catch(() => null)
    if (signedIn === true) return { phase: 'ok', message: 'signed in (probed via agy models)' }
    if (signedIn === false) return { phase: 'signed-out', message: 'agy is not signed in' }
    return st
  }

  /** 副账号登录状态（进行中的 add-account 流程）。 */
  poolAuthStatus(): PoolAuthStatus {
    return this.poolAuth.status()
  }

  /** 模型目录（首次调用时触发一次 `agy models`；失败保留 fallback）。 */
  async modelCatalog(): Promise<Catalog> {
    await this.catalog.refreshIfNeeded()
    return this.catalog.get()
  }

  /**
   * 单账号「刷新」入口（对齐 Jet Hub `account.refresh` 的契约）。
   *
   * ⚠️ 与其余 provider 的「续期凭据」**语义不同**：agy 凭据由官方二进制自续期，
   * 这里的「刷新」= **登录态真探**（绕过 60s 缓存，让刚重新登录立即可见）
   * + **强制配额刷新**（发真实 HTTPS 配额查询）。
   */
  async refreshAccount(id: string): Promise<void> {
    const acc = this.pool.getAccount(id)
    if (!acc) throw new Error(`账号 ${id} 不存在`)
    // 登录态真探失败不阻塞配额刷新（两者独立，各自报错各自可见）。
    await this.auth.probeSignedIn(true).catch(() => null)
    await this.quota.refreshAccountQuota(acc, true)
  }

  /**
   * 批量「续期」入口（对齐 `index.ts` 的 `refreshTargets` 调度表契约）。
   *
   * agy 无凭据可续：这里做**保守闸门的配额刷新**（`refreshAllQuotas` 非
   * force 路径经 `shouldPollAccount` 跳过 cooldown / 待重登账号，不会从后台
   * 骚扰已知受限的账号 —— 与 index.ts 里 antigravity-quota-poll 的取向一致）。
   */
  async refreshAll(): Promise<void> {
    await this.quota.refreshAllQuotas()
  }

  /** 释放：停掉配额轮询与所有未完成的登录探测。 */
  dispose(): void {
    this.auth.dispose()
    // PoolAuthFlow 没有显式 dispose；其内部 timer 由 doneResetTimer 管理，
    // 但那是登录完成后的自清理，不需要外部介入。
    // quota/catalog 没有需要停的 interval（它们的轮询由调用方驱动）。
  }
}

/** 单例（每个 profile 一个）。 */
export function createAntigravityService(ctx: Context, cfgOverride?: Partial<PluginConfig>): AntigravityService {
  return new AntigravityService(ctx, cfgOverride)
}
