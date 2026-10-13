/**
 * 「每日自动签到」的**独立**持久化文档。
 *
 * ## 为什么不与账号池同放一份 state.json
 *
 * 理由与 `src/permanent-lock-store.ts` 逐条同源，此处不重复展开，只记结论：
 * `$DSH_HOME/jet-hub/state.json` 是 **dsh home 级、全局共享**的，而同机上
 * 另一条工作区里的**旧版本代码**不认识本插件的任何新字段，却在每次账号增删 /
 * 模型开关 / 限流标记时**整体重写**该文档 ⇒ 新字段会被静默抹掉。
 *
 * 对自动签到而言，被抹掉的后果是：
 * - `enabled` 被抹掉 → 用户明确打开的开关**自己关掉**（或反过来，用户关掉的
 *   开关又自己打开 —— 那会在用户不知情时发写请求）；
 * - `day` / `attempts` 被抹掉 → 当天闸门失效，**每次打开 DSH 都重签一遍**，
 *   而 zcode 每次都要拉起 chromium 过阿里云 captcha（有配额代价）。
 *
 * ⇒ 状态住在本文件这份独立文档里，旧代码从不读写它。
 *
 * ## 与 `state.json` 的关系
 *
 * **没有关系**：本文件不镜像任何字段进 state.json。理由与锁定表不同 ——
 * 锁定表当初有过「住在 state.json」的历史（故需单向迁移），自动签到是新增
 * 能力，**不存在**任何需要迁移的老字段。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveJetHubHome } from './jet-hub-store.js'
import {
  AUTO_CHECKIN_MAX_ATTEMPTS_PER_DAY,
  defaultAutoCheckinState,
  sanitizeAutoCheckinState,
  type AutoCheckinState,
} from './auto-checkin.js'

/** 独立文档的文件名（与 state.json 同目录）。 */
export const AUTO_CHECKIN_FILE = 'auto-checkin.json'

/** 文档 schema 标记（与本仓库其它状态文档同惯例）。 */
const SCHEMA = 'dsh-codearts-auth/auto-checkin/v1'

/** 后端种类：文件（正常）或内存（无法定位 dsh home 时的显式降级）。 */
export type AutoCheckinStoreKind = 'file' | 'memory'

/** 读取结果：区分「文档不存在」与「存在但内容为空」—— 便于调用方决定是否落盘。 */
export type AutoCheckinRead =
  | { exists: false; state: AutoCheckinState }
  | { exists: true; state: AutoCheckinState }

/** 独立文档的读写接口（同步读、异步写，与 `JetHubStore` / `PermanentLockStore` 同款约定）。 */
export interface AutoCheckinStore {
  readonly kind: AutoCheckinStoreKind
  /** 载入状态；文档不存在时 `exists: false`。 */
  load(): AutoCheckinRead
  /** 整体写入状态（原子写：tmp + rename）。 */
  save(state: AutoCheckinState): Promise<void>
}

/**
 * 仅内存后端：无法定位 dsh home 时的显式降级（与 `MemoryLockStore` 同策）。
 */
class MemoryAutoCheckinStore implements AutoCheckinStore {
  readonly kind = 'memory' as const
  private state: AutoCheckinState | undefined

  load(): AutoCheckinRead {
    if (this.state === undefined) return { exists: false, state: defaultAutoCheckinState() }
    return { exists: true, state: sanitizeAutoCheckinState(this.state) }
  }

  async save(state: AutoCheckinState): Promise<void> {
    this.state = sanitizeAutoCheckinState(state)
  }
}

/** 文件后端：`$DSH_HOME/jet-hub/auto-checkin.json`（原子写：tmp + rename）。 */
class FileAutoCheckinStore implements AutoCheckinStore {
  readonly kind = 'file' as const

  constructor(
    private readonly path: string,
    private readonly logger: { warn(message: string): void } | undefined,
  ) {}

  load(): AutoCheckinRead {
    try {
      if (!existsSync(this.path)) return { exists: false, state: defaultAutoCheckinState() }
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as unknown
      return { exists: true, state: sanitizeAutoCheckinState(stateFieldOf(parsed)) }
    } catch (error) {
      /**
       * 损坏时按「文档存在、内容全默认」处理。
       *
       * ⚠️ 这里**不**回落到 `defaultAutoCheckinState()` 的 `exists: false` 分支：
       * 那会让调用方以为「新用户」，进而把整个默认状态（含 `enabled: true`）
       * 再写一遍 —— 而文档损坏的真实原因是磁盘 / 手工编辑，覆盖它只会
       * 把用户原有的 `enabled: false` 一起抹掉。按「存在但空」处理时，
       * `sanitizeAutoCheckinState(undefined)` 会保留 `enabled` 的默认值，
       * 同时把不可信的 `day` / `attempts` 清空（宁可多签一次，不可漏签）。
       */
      this.logger?.warn(`[jet-hub] 读取 ${this.path} 失败，自动签到状态按默认处理: ${String(error)}`)
      return { exists: true, state: sanitizeAutoCheckinState(undefined) }
    }
  }

  async save(state: AutoCheckinState): Promise<void> {
    mkdirSync(join(this.path, '..'), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify({ schema: SCHEMA, ...state }, null, 2), 'utf-8')
    renameSync(tmp, this.path)
  }
}

/**
 * 取出文档里的状态字段，同时兼容**裸状态**形态（顶层直接是状态对象）。
 *
 * 裸形态不是本实现写出的，但文档可能被手工编辑过；认它比把它当空对象更安全
 * （后者会让用户的开关设置凭空消失）。
 */
function stateFieldOf(parsed: unknown): unknown {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return parsed
  const record = parsed as Record<string, unknown>
  if (record.schema === undefined || record.schema === SCHEMA) return record
  // schema 标记不认识（将来版本演进）时不猜，交给 sanitize 逐字段校验。
  return record
}

/**
 * 创建自动签到状态后端。
 *
 * home 的解析与账号池**同一个函数**（`resolveJetHubHome`），保证三份文档
 * （state.json / permanent-locks.json / auto-checkin.json）永远落在同一目录。
 */
export function createAutoCheckinStore(ctx: Context): AutoCheckinStore {
  const home = resolveJetHubHome(ctx)
  if (home === undefined) {
    ctx.logger?.warn?.('[jet-hub] 无法定位 DSH home，每日自动签到的开关与记录仅存在于内存中')
    return new MemoryAutoCheckinStore()
  }
  return new FileAutoCheckinStore(join(home, 'jet-hub', AUTO_CHECKIN_FILE), ctx.logger)
}

/** 供面板展示的「每天最多尝试次数」（与执行判据同源，避免文案与行为漂移）。 */
export { AUTO_CHECKIN_MAX_ATTEMPTS_PER_DAY }
