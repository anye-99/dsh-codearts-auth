/**
 * 每日自动签到的**装配层**：把「持久化状态」「逐渠道执行」「日志」拼成一个
 * 面板与启动路径共用的对象。
 *
 * ## 为什么单独一个文件（而不是塞进 `auto-checkin.ts`）
 *
 * `auto-checkin.ts` 是**纯判据 + 执行器**（不碰磁盘、不碰 `ctx`），
 * `auto-checkin-store.ts` 是**磁盘**。控制器要同时用到两者 —— 若把它放进
 * `auto-checkin.ts`，后者就要 import `AutoCheckinStore` 的类型，而 store 又要
 * import 执行器的 sanitize ⇒ **循环 import**。拆出来方向就是单向的：
 *
 * ```
 * auto-checkin.ts  ←  auto-checkin-store.ts
 *        ↑                    ↑
 *        └── auto-checkin-controller.ts ──┘
 * ```
 *
 * ## 重入保护
 *
 * 「打开 DSH 时触发」与「用户在面板上改开关」可能几乎同时发生，而逐个渠道的
 * 领取是**真实写请求**（含 zcode 每次拉起 chromium 过 captcha）。故 `trigger()`
 * 用一个 `running` 标志挡住重入，并让第二次调用**如实返回 `running`**，
 * 而不是排队 —— 排队意味着用户可能等到一次「上一个进程周期发起的签到」，
 * 那在 UI 上表现为「点了没反应，过一会儿突然多了一堆结果」。
 *
 * ⚠️ **已知取舍：不手动签到互斥**。面板页头那个既有的「一键签到」按钮走的是
 * `credits.claimAll` RPC，与本控制器**不共享队列**。两者理论上可并发（用户
 * 恰好在自动签到刚开始时点了按钮）。不做互斥的理由：签到接口全部幂等，
 * 最坏结果是多发几个请求；而做互斥要么把队列做成跨模块单例（单测互相污染），
 * 要么给 RPC 层再加一条参数通道（位置参数陷阱）。代价与收益不成比例。
 */

import {
  AUTO_CHECKIN_MAX_ATTEMPTS_PER_DAY,
  AUTO_CHECKIN_PROVIDERS,
  runAutoCheckin,
  summarizeChannels,
  type AutoCheckinChannelResult,
  type AutoCheckinClaimOutcome,
  type AutoCheckinRunOutcome,
  type AutoCheckinState,
} from './auto-checkin.js'
import type { AutoCheckinStore, AutoCheckinStoreKind } from './auto-checkin-store.js'
import type { RpcCreditsClaimSummary } from './types.js'

/** 面板读取的快照（**不含任何凭据内容**，可安全回传客户端）。 */
export interface AutoCheckinStatusSnapshot {
  /** 开关。 */
  enabled: boolean
  /** 当天（UTC+8）已尝试次数。 */
  attempts: number
  /** 当天是否已成功签完。 */
  succeeded: boolean
  /** 上次执行所属的 UTC+8 自然日（`YYYY-MM-DD`）；`null` = 从未执行。 */
  day: string | null
  /** 上次执行的完成时刻（epoch ms）；`null` = 从未执行。 */
  lastRunAt: number | null
  /** 上次执行的逐渠道结果。 */
  lastResults: AutoCheckinChannelResult[]
  /**
   * {@link AutoCheckinStatusSnapshot.lastResults} 的汇总。
   *
   * ⚠️ 由 host 用 `summarizeChannels()` **算好再下发**，而不是让面板自己把
   * `lastResults` 加一遍：那会让「整渠道失败算几个失败」这类判据出现两份实现，
   * 迟早漂移成「面板显示 0 失败、日志说 1 个失败」。
   */
  summary: RpcCreditsClaimSummary
  /** 此刻是否有一次执行在进行中。 */
  running: boolean
  /** 当天尝试上限（面板据此渲染「3 次」文案，避免与后端判据漂移）。 */
  maxAttemptsPerDay: number
  /** 状态后端的种类（`memory` 表示无法定位 dsh home，重启后会丢）。 */
  storeKind: AutoCheckinStoreKind
}

/** 面板与启动路径共用的控制器。 */
export interface AutoCheckinController {
  /** 读快照（不发网络请求）。 */
  read(): AutoCheckinStatusSnapshot
  /** 写开关并返回新快照。 */
  setEnabled(enabled: boolean): Promise<AutoCheckinStatusSnapshot>
  /**
   * 执行一次（含闸门）。
   *
   * @param options.force - 越过「今天已签完 / 次数上限」闸门。
   *   ⚠️ **不越过开关**（关掉后不该还在自动发请求）。
   */
  trigger(options?: { force?: boolean }): Promise<AutoCheckinRunOutcome>
}

/** 构造参数。 */
export interface CreateAutoCheckinControllerOptions {
  store: AutoCheckinStore
  /** 执行单个渠道的签到（实现方可以是 `claimAllForProvider` 的包装）。 */
  claim: (provider: string) => Promise<AutoCheckinClaimOutcome>
  /** 日志出口。 */
  log: (message: string) => void
  /** 渠道清单（默认 {@link AUTO_CHECKIN_PROVIDERS}）。 */
  providers?: readonly string[]
  /** 取当前时刻（注入以便单测）。 */
  now?: () => number
}

/**
 * 创建控制器。
 *
 * 状态**惰性读取**（每次 `read()` / `trigger()` 都重新读盘）：多 profile 同机
 * 共享同一份文档时（`desktop` 与 `web`），另一侧改开关后本侧不必重启就能看到。
 * 文档很小（几 KB），读盘成本远低于「读到陈旧开关却毫无察觉」的代价。
 */
export function createAutoCheckinController(
  options: CreateAutoCheckinControllerOptions,
): AutoCheckinController {
  const { store, claim, log } = options
  const providers = options.providers ?? AUTO_CHECKIN_PROVIDERS
  const now = options.now ?? ((): number => Date.now())

  /** 是否有一次执行在进行中（重入保护，见模块头）。 */
  let running = false

  const snapshot = (state: AutoCheckinState): AutoCheckinStatusSnapshot => ({
    enabled: state.enabled,
    attempts: state.attempts,
    succeeded: state.succeeded,
    day: state.day,
    lastRunAt: state.lastRunAt,
    lastResults: state.lastResults,
    summary: summarizeChannels(state.lastResults),
    running,
    maxAttemptsPerDay: AUTO_CHECKIN_MAX_ATTEMPTS_PER_DAY,
    storeKind: store.kind,
  })

  /** 读盘（损坏 / 缺失时由 store 给默认值）。 */
  const readState = (): AutoCheckinState => store.load().state

  return {
    read(): AutoCheckinStatusSnapshot {
      return snapshot(readState())
    },

    async setEnabled(enabled: boolean): Promise<AutoCheckinStatusSnapshot> {
      const current = readState()
      const next: AutoCheckinState = { ...current, enabled }
      await store.save(next)
      log(`[jet-hub] 每日自动签到：开关已${enabled ? '开启' : '关闭'}`)
      // ⚠️ 打开开关后**不立即补签**：本功能的时机是「打开 DSH 时」，
      // 而此刻 DSH 早就开着 —— 用户若想马上领一次，页头就有「一键签到」。
      // 在这里补签会让「打开开关」这个动作产生十路写请求，且用户无从预期。
      return snapshot(next)
    },

    async trigger(triggerOptions?: { force?: boolean }): Promise<AutoCheckinRunOutcome> {
      const state = readState()
      if (running) {
        // 如实返回本次「跳过」：调用方据 reason 决定怎么提示，不要假装已跑完。
        return { ran: false, reason: 'running', state }
      }
      running = true
      try {
        return await runAutoCheckin({
          providers,
          claim,
          load: readState,
          save: (next) => store.save(next),
          log,
          now,
          force: triggerOptions?.force === true,
        })
      } finally {
        // ⚠️ `finally` 而非成功路径：执行器抛错时也要放行下一次触发，
        // 否则一次异常会让自动签到**永久停摆**（本仓库在 captcha 队列上
        // 踩过同型的 `pageBusy` 死锁）。
        running = false
      }
    },
  }
}
