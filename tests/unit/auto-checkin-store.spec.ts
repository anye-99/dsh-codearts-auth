import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AUTO_CHECKIN_FILE,
  createAutoCheckinStore,
} from '../../src/auto-checkin-store.js'
import { defaultAutoCheckinState } from '../../src/auto-checkin.js'

/**
 * 「每日自动签到」状态文档的回归测试。
 *
 * 重点守三件事：
 * 1. **文档不存在 ≠ 文档损坏**：前者是新装用户（给默认状态，`enabled: true`），
 *    后者仍要给出可用状态且**不抛错**（损坏是罕见路径，但不能让签到功能整体崩）；
 * 2. **原子写**：`tmp + rename`，写完不留 `.tmp` 残留；
 * 3. 落盘内容**不含凭据**（本文件会被用户直接翻看 / 随备份带走）。
 */

/** 一个临时的状态目录（`resolveJetHubHome` 的第一优先级变量）。 */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-auto-checkin-'))
}

/** 最小 ctx 替身：store 只用到 `logger`（`profileContext` 缺失即走环境变量）。 */
function fakeCtx(): { logger: { warn(message: string): void }; get(): undefined } {
  return { logger: { warn: () => {} }, get: () => undefined }
}

describe('createAutoCheckinStore：文件后端', () => {
  let dir: string
  const previousDir = process.env.DSH_JET_HUB_STATE_DIR
  const previousHome = process.env.DSH_HOME

  beforeEach(() => {
    dir = tempDir()
    // ⚠️ 用 `DSH_JET_HUB_STATE_DIR`（单测隔离的专用变量，优先级最高）而不是
    // `DSH_HOME`：后者若被开发机真的设过，本用例就会写到真实 home 里去。
    process.env.DSH_JET_HUB_STATE_DIR = dir
    delete process.env.DSH_HOME
  })

  afterEach(() => {
    if (previousDir === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
    else process.env.DSH_JET_HUB_STATE_DIR = previousDir
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(dir, { recursive: true, force: true })
  })

  const statePath = (): string => join(dir, 'jet-hub', AUTO_CHECKIN_FILE)

  it('文档不存在 ⇒ exists:false + 默认状态（默认开启）', () => {
    const store = createAutoCheckinStore(fakeCtx() as never)
    expect(store.kind).toBe('file')
    const read = store.load()
    expect(read.exists).toBe(false)
    expect(read.state).toEqual(defaultAutoCheckinState())
    expect(read.state.enabled).toBe(true)
  })

  it('写入后能被读回（含 lastResults 与逐渠道汇总的往返一致）', async () => {
    const store = createAutoCheckinStore(fakeCtx() as never)
    const state = {
      enabled: false,
      day: '2026-10-13',
      attempts: 2,
      succeeded: false,
      lastRunAt: 1760000000000,
      lastResults: [
        {
          provider: 'qoder',
          ok: true,
          summary: { claimed: 2, totalCredit: 900, alreadyClaimed: 1, inactive: 0, failed: 0 },
        },
        { provider: 'zcode', ok: false, error: '没有可用浏览器' },
      ],
    }
    await store.save(state)

    const read = store.load()
    expect(read.exists).toBe(true)
    expect(read.state).toEqual(state)

    const raw = readFileSync(statePath(), 'utf-8')
    expect(raw).toContain('dsh-codearts-auth/auto-checkin/v1')
    // ⚠️ 只落「渠道 + 计数 + 失败文案」，**不落凭据**。
    expect(raw).toContain('"provider": "qoder"')
    expect(raw).not.toMatch(/access_token|refresh_token|apiKey|authorization/i)
  })

  it('⚠️ 文件损坏 ⇒ 仍给出可用状态且不抛错（day/attempts 被清空）', () => {
    const store = createAutoCheckinStore(fakeCtx() as never)
    mkdirSync(join(dir, 'jet-hub'), { recursive: true })
    writeFileSync(statePath(), '{ 这不是 JSON', 'utf-8')

    const read = store.load()
    // 「存在但内容不可信」：**不**回 exists:false —— 那会让调用方把默认状态
    // 再写一遍，而默认状态里 `enabled: true`（用户的关闭设置会被一起抹掉）。
    expect(read.exists).toBe(true)
    expect(read.state.day).toBeNull()
    expect(read.state.attempts).toBe(0)
  })

  it('裸状态文档（顶层直接是状态对象）也能读（手工编辑过的文档）', () => {
    const store = createAutoCheckinStore(fakeCtx() as never)
    mkdirSync(join(dir, 'jet-hub'), { recursive: true })
    writeFileSync(statePath(), JSON.stringify({ enabled: false, attempts: 1 }), 'utf-8')

    const read = store.load()
    expect(read.state.enabled).toBe(false)
    expect(read.state.attempts).toBe(1)
  })

  it('写入是原子替换（写完不留 .tmp 残留）', async () => {
    const store = createAutoCheckinStore(fakeCtx() as never)
    await store.save(defaultAutoCheckinState())
    expect(existsSync(`${statePath()}.tmp`)).toBe(false)
    expect(existsSync(statePath())).toBe(true)
  })

  it('连续写入取最后一次（整体替换语义，不追加）', async () => {
    const store = createAutoCheckinStore(fakeCtx() as never)
    await store.save({ ...defaultAutoCheckinState(), attempts: 1 })
    await store.save({ ...defaultAutoCheckinState(), attempts: 2 })
    expect(store.load().state.attempts).toBe(2)
  })
})

describe('createAutoCheckinStore：状态目录与账号池同源', () => {
  /**
   * ⚠️ 三份文档（`state.json` / `permanent-locks.json` / `auto-checkin.json`）
   * 必须落在**同一目录** —— 否则会出现「账号池在 A 处、签到状态在 B 处」的分裂，
   * 而用户从界面上完全看不出这件事。这里断言目录推导走的是同一个函数。
   */
  it('DSH_JET_HUB_STATE_DIR 覆盖 DSH_HOME（单测隔离与多工作区都依赖它）', async () => {
    const dir = tempDir()
    const other = tempDir()
    const previousDir = process.env.DSH_JET_HUB_STATE_DIR
    const previousHome = process.env.DSH_HOME
    process.env.DSH_JET_HUB_STATE_DIR = dir
    process.env.DSH_HOME = other
    try {
      const store = createAutoCheckinStore(fakeCtx() as never)
      await store.save({ ...defaultAutoCheckinState(), attempts: 7 })
      expect(existsSync(join(dir, 'jet-hub', AUTO_CHECKIN_FILE))).toBe(true)
      expect(existsSync(join(other, 'jet-hub', AUTO_CHECKIN_FILE))).toBe(false)
    } finally {
      if (previousDir === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
      else process.env.DSH_JET_HUB_STATE_DIR = previousDir
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      rmSync(dir, { recursive: true, force: true })
      rmSync(other, { recursive: true, force: true })
    }
  })
})
