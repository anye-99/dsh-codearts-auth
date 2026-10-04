import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { AccountPoolManager } from '../../src/agy/pool.js'
import { ModelCatalog } from '../../src/agy/models.js'
import { DEFAULT_FALLBACK_MODELS, defaultConfig, type PluginConfig } from '../../src/agy/types.js'
import { AntigravityAdapter } from '../../src/antigravity-adapter.js'

/**
 * 默认思考档位**真的进了 agy 命令行**（2026-10-03 用户要求暴露成开关）。
 *
 * ## 为什么必须有这条行为级用例
 *
 * 档位是「界面能点但不一定生效」的典型：它要穿过
 * 面板 → RPC → 服务 cfg → 适配器 `driveOnce` → `agy --effort` 五跳。
 * 只锁前四跳的源码断言**证明不了它最后真的被发出去** —— 这正是仓库里反复
 * 出现的「假开关」形态（早期 `gateAntigravity`、关不掉的模型开关）。
 * 故这里用假 agy **捕获真实 argv**。
 *
 * ⚠️ 判据是 `--effort` **后面那个值**，不是「有没有 `--effort`」——
 * 后者在默认阶梯下同样成立（会发 `high`），写成那样就是同义反复。
 * ⚠️ 已做**反向验证**：把 `defaultEffort` 从 cfg 里摘掉（恒走阶梯）后，
 * 「medium」「low」两条变红，第三条（high）仍绿 —— 说明判据确实指向该字段。
 */

/**
 * 造一个假 agy：把收到的 argv 落盘成 `argv.json`，再吐一个最小合法事件流。
 *
 * 为什么落盘而不是打到 stdout：stdout 是 NDJSON 事件通道，往里混非事件行
 * 会被 parser 记成 garbage；argv 也不该伪装成协议事件。
 */
function makeArgvEchoFakeAgy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-agy-argv-'))
  const file = join(dir, 'agy.mjs')
  const body = [
    "import { writeFileSync } from 'node:fs';",
    'const argv = process.argv.slice(2);',
    `writeFileSync(${JSON.stringify(join(dir, 'argv.json'))}, JSON.stringify(argv));`,
    "process.stdout.write(JSON.stringify({ event: 'init', conversation_id: 'c1' }) + '\\n');",
    "process.stdout.write(JSON.stringify({ event: 'result', result: { status: 'DONE', response: 'ok', conversation_id: 'c1', usage: {} } }) + '\\n');",
    'process.exit(0);',
  ]
  writeFileSync(file, body.join('\n') + '\n', 'utf8')
  return file
}

/** 假 agy 把 argv 写在自己旁边（注意：是 `agy.mjs` 所在目录，不是它本身）。 */
function argvFileOf(bin: string): string {
  return join(bin, '..', 'argv.json')
}

function cfgWith(defaultEffort: string): PluginConfig {
  return { ...defaultConfig(), timeoutMs: 20_000, defaultEffort }
}

function makeAdapter(bin: string, config: PluginConfig): AntigravityAdapter {
  return new AntigravityAdapter({
    getConfig: () => config,
    catalog: new ModelCatalog(async () => { throw new Error('no discover in wire tests') }, DEFAULT_FALLBACK_MODELS, 60_000),
    pool: new AccountPoolManager(mkdtempSync(join(tmpdir(), 'agy-effort-pool-'))),
    bin: () => bin,
    acquire: async () => () => {},
  })
}

/** 跑一轮并把 argv 读回来。 */
async function argvFor(config: PluginConfig, opts: { model?: string; effort?: string } = {}): Promise<string[]> {
  const bin = makeArgvEchoFakeAgy()
  const adapter = makeAdapter(bin, config)
  for await (const _chunk of adapter.stream({
    provider: 'antigravity',
    model: opts.model ?? 'gemini-3.8-flash',
    ...(opts.effort !== undefined ? { reasoningEffort: opts.effort } : {}),
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] as never,
  })) { void _chunk }
  return JSON.parse(readFileSync(argvFileOf(bin), 'utf8')) as string[]
}

function effortOf(argv: string[]): string | undefined {
  const idx = argv.indexOf('--effort')
  return idx === -1 ? undefined : argv[idx + 1]
}

describe('默认思考档位进入 agy 命令行', () => {
  it('★ defaultEffort=low ⇒ 发的就是 low', async () => {
    const argv = await argvFor(cfgWith('low'))
    expect(effortOf(argv), `argv: ${argv.join(' ')}`).toBe('low')
  }, 30_000)

  it('★ defaultEffort=medium ⇒ 压过「阶梯默认 high」', async () => {
    const argv = await argvFor(cfgWith('medium'))
    expect(effortOf(argv)).toBe('medium')
  }, 30_000)

  it('★ 未设 defaultEffort ⇒ 阶梯选出 high（证明上面两条不是碰巧）', async () => {
    const argv = await argvFor(cfgWith(''))
    // flash 目录的 efforts 是 [low, medium, high]，阶梯偏好 high。
    expect(effortOf(argv)).toBe('high')
  }, 30_000)

  it('★ 用户在模型选择器里选的档位优先于面板默认值', async () => {
    const argv = await argvFor(cfgWith('low'), { effort: 'max' })
    expect(effortOf(argv)).toBe('max')
  }, 30_000)

  it('模型 id 与档位一起下发（面板换档不改变模型选择）', async () => {
    const argv = await argvFor(cfgWith('low'), { model: 'gemini-3.8-flash' })
    const mi = argv.indexOf('--model')
    expect(mi).toBeGreaterThanOrEqual(0)
    expect(argv[mi + 1]).toBeTruthy()
    // 两个参数各出现一次（重复下发会让 agy 取到哪个不确定）。
    expect(argv.filter(a => a === '--effort')).toHaveLength(1)
    expect(argv.filter(a => a === '--model')).toHaveLength(1)
  }, 30_000)
})
