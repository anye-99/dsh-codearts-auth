import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { AccountPoolManager } from '../../src/agy/pool.js'
import { ModelCatalog } from '../../src/agy/models.js'
import { DEFAULT_FALLBACK_MODELS, defaultConfig, type PluginConfig } from '../../src/agy/types.js'
import { AntigravityAdapter } from '../../src/antigravity-adapter.js'

/**
 * Antigravity 适配器的**流式输出**回归（2026-10-03 性能修复）。
 *
 * ## 修的是什么（真实缺陷）
 *
 * 原 `driveOnce` 写成 `const o = await outcome` —— **等 agy 整个进程结束**才把
 * `o.stdout` 一次性喂给 parser。后果：首字延迟 = 整段生成时间，用户盯着空屏
 * 等十几秒才看到全文**一次性出现**（UI 的打字机效果完全消失）。那段代码的
 * 注释自己都写着「那样失去流式……为保留流式，改用轮询 drain pending」，
 * 但轮询从未实现、`pending` 数组始终为空 —— 重构半途而废。
 *
 * ## 判据：chunk 必须在**进程还活着**时就到达
 *
 * 这一组用例用一个「先吐内容、再长时间静默、最后才结束」的假 agy：
 * - **流式正确** ⇒ 首个文本块在静默期内就到了（远早于进程退出）；
 * - **退回全量等待** ⇒ 首个文本块要等到进程退出之后。
 *
 * ⚠️ 所以断言的是**时序关系**（首块时刻 << 总耗时），不是"有没有输出" ——
 * 后者在全量等待下同样成立，是无效判据（写成那样这组用例就是同义反复）。
 * ⚠️ 已做**反向验证**：把实现改回 `await proc.outcome` 再跑，本组用例变红。
 */

const STALL_MS = 2_500

/**
 * 造一个假 agy：立刻吐 init + 一段文本，然后静默 STALL_MS，再吐一段文本与 result。
 * 静默期是关键 —— 它让"首块到达时刻"与"进程结束时刻"相差 2.5 秒，可判。
 */
function makeStreamingFakeAgy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-agy-stream-'))
  const file = join(dir, 'agy.mjs')
  const lines = [
    "const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
    "out({ event: 'init', conversation_id: 'conv-1', init: { model: 'gemini-3.5-flash' } });",
    "out({ event: 'step_update', step_update: { step_index: 0, step_type: 'text', text_delta: '前半段' } });",
    `setTimeout(() => {`,
    "  out({ event: 'step_update', step_update: { step_index: 1, step_type: 'text', text_delta: '后半段' } });",
    "  out({ event: 'result', result: { status: 'DONE', response: '前半段后半段', conversation_id: 'conv-1', usage: { input_tokens: 5, output_tokens: 6 } } });",
    "  process.exit(0);",
    `}, ${STALL_MS});`,
  ]
  writeFileSync(file, lines.join('\n') + '\n', 'utf8')
  return file
}

/** 造一个假 agy：只吐 garbage + 立即退出（没有 result 事件）。 */
function makeNoResultFakeAgy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-agy-noresult-'))
  const file = join(dir, 'agy.mjs')
  writeFileSync(file, "process.stdout.write('not json at all\\n');\nprocess.exit(0);\n", 'utf8')
  return file
}

function cfg(): PluginConfig {
  return { ...defaultConfig(), timeoutMs: 30_000 }
}

function makeCatalog(): ModelCatalog {
  return new ModelCatalog(async () => { throw new Error('discover disabled') }, DEFAULT_FALLBACK_MODELS, 60_000)
}

function makeAdapter(bin: string): AntigravityAdapter {
  return new AntigravityAdapter({
    getConfig: cfg,
    catalog: makeCatalog(),
    pool: new AccountPoolManager(mkdtempSync(join(tmpdir(), 'agy-stream-pool-'))),
    bin: () => bin,
    acquire: async () => () => {},
  })
}

const USER_MSG = {
  provider: 'antigravity',
  model: 'gemini-3.5-flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] as never,
}

/** 造一个假 agy：多步 step 各带 per-call usage，result 信封带会话累计 usage。 */
function makeCumulativeUsageFakeAgy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-agy-usage-'))
  const file = join(dir, 'agy.mjs')
  const lines = [
    "const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
    "out({ event: 'init', conversation_id: 'conv-u' });",
    // 逐步增长的 per-call 样本（= 真实当前上下文占用）
    "out({ event: 'step_update', step_update: { step_index: 0, step_type: 'text', text_delta: 'A', usage: { input_tokens: 15000, output_tokens: 100 } } });",
    "out({ event: 'step_update', step_update: { step_index: 1, step_type: 'text', text_delta: 'B', usage: { input_tokens: 16800, output_tokens: 160 } } });",
    // 会话累计信封：远大于任何单次（真实形态可达百万级）
    "out({ event: 'result', result: { status: 'DONE', response: 'AB', conversation_id: 'conv-u', usage: { input_tokens: 3800000, output_tokens: 260, cache_read_tokens: 72000000 } } });",
    'process.exit(0);',
  ]
  writeFileSync(file, lines.join('\n') + '\n', 'utf8')
  return file
}

describe('usage 记账：上报 per-call 而非会话累计', () => {
  /**
   * ⚠️ 这条用例锁死 2026-10-04 修掉的「上下文很快就满」根因。
   *
   * agy 的 `result` 信封 usage 是**会话累计**（实测 input 3.8M / cacheRead 72M），
   * 而 `step_update` 的是 **per-call**（当前上下文）。DSH 的 token meter 把最后
   * 收到的样本当作当前占用，透传信封会把占用放大上百倍（实测 226 倍），
   * 于是每轮都越过压缩阈值。
   *
   * ⚠️ 已做**反向验证**：去掉适配器里传给 EventMapper 的 usage 追踪器，
   * 本用例即变红（上报 3,800,000）。故它不是同义反复。
   */
  it('★ result 时上报最后一个 step 的 per-call 值，而非累计信封', async () => {
    const adapter = makeAdapter(makeCumulativeUsageFakeAgy())
    const usages: Array<{ inputTokens?: number; cacheReadTokens?: number }> = []
    for await (const chunk of adapter.stream(USER_MSG)) {
      const c = chunk as { type?: string; usage?: { inputTokens?: number; cacheReadTokens?: number } }
      if (c.type === 'usage' && c.usage) usages.push(c.usage)
    }
    expect(usages.length, '应产出 usage 块').toBeGreaterThan(0)
    const last = usages[usages.length - 1]!
    // 最后一个 per-call 样本是 16,800 —— 不是累计的 3,800,000
    expect(
      last.inputTokens,
      '上报的必须是 per-call 当前上下文，透传累计信封会让 DSH 每轮都触发压缩',
    ).toBe(16_800)
    // 累计信封里的 cacheRead 72M 绝不能漏到 token meter
    expect(last.cacheReadTokens).toBeUndefined()
  }, 30_000)
})

describe('流式输出：chunk 在进程结束前到达', () => {
  it('★ 首个文本块远早于进程退出（全量等待会变红）', async () => {
    const adapter = makeAdapter(makeStreamingFakeAgy())
    const t0 = Date.now()
    let firstTextAt: number | null = null
    let eventCount = 0

    for await (const chunk of adapter.stream(USER_MSG)) {
      eventCount++
      const c = chunk as { type?: string; block?: { text?: string } }
      if (firstTextAt === null && (c.type === 'block-end' || c.type === 'block-start')) {
        firstTextAt = Date.now() - t0
      }
    }
    const total = Date.now() - t0

    expect(eventCount).toBeGreaterThan(0)
    expect(firstTextAt, '应产出内容块').not.toBeNull()

    // 判据：首块必须落在静默期内到达（即进程还活着）。
    // 全量等待实现下首块 ≈ total（≥ STALL_MS），必然超出这个上限。
    expect(
      firstTextAt!,
      `首块 ${firstTextAt}ms / 总 ${total}ms —— 首块必须早于静默期结束（${STALL_MS}ms），`
      + '否则说明又退回「等 outcome 再全量解析」',
    ).toBeLessThan(STALL_MS)
    // 总耗时必然 ≥ 静默期（证明静默真的发生了，用例不是空跑）。
    expect(total).toBeGreaterThanOrEqual(STALL_MS)
  }, 30_000)

  it('★ 两段文本都到达（流式不丢块）', async () => {
    const adapter = makeAdapter(makeStreamingFakeAgy())
    const texts: string[] = []
    for await (const chunk of adapter.stream(USER_MSG)) {
      const c = chunk as { type?: string; block?: { text?: string } }
      if (c.type === 'block-end' && typeof c.block?.text === 'string') texts.push(c.block.text)
    }
    const joined = texts.join('')
    expect(joined).toContain('前半段')
    expect(joined).toContain('后半段')
  }, 30_000)

  it('★ 收到 result ⇒ 产出 finish 块（流式路径也要正确收尾）', async () => {
    const adapter = makeAdapter(makeStreamingFakeAgy())
    const finishes: Array<{ reason?: { kind?: string } }> = []
    for await (const chunk of adapter.stream(USER_MSG)) {
      const c = chunk as { type?: string; reason?: { kind?: string } }
      if (c.type === 'finish') finishes.push(c)
    }
    expect(finishes).toHaveLength(1)
    expect(finishes[0]!.reason?.kind).toBe('stop')
  }, 30_000)

  it('★ 没有 result 事件 ⇒ 仍产出 error 收尾块（否则 UI 永远停在「运行中」）', async () => {
    // ⚠️ 这条是流式改造引入的新风险点：事件由 onLine 边走边发，
    // 没有 result 时 mapper 从未 finish —— 必须在收尾处补 emitFailure。
    // 漏掉它的话 harness 等不到 finish 块，UI 永远转圈（旧实现因为
    // 结束时统一 flush 全量事件，反而不会漏）。
    const adapter = makeAdapter(makeNoResultFakeAgy())
    const finishes: Array<{ reason?: { kind?: string; failure?: { code?: string } } }> = []
    for await (const chunk of adapter.stream(USER_MSG)) {
      const c = chunk as { type?: string; reason?: { kind?: string; failure?: { code?: string } } }
      if (c.type === 'finish') finishes.push(c)
    }
    expect(finishes, '必须有一个收尾块').toHaveLength(1)
    expect(finishes[0]!.reason?.kind).toBe('error')
    expect(finishes[0]!.reason?.failure?.code).toBe('PROCESS_EXIT')
  }, 30_000)
})
