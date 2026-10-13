import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  fetchCodeArtsRemoteModels, forgetBenefitModel, isCodeArtsBenefitModel, loadBenefitCache,
  loadModelsCache, OPENGW_GATEWAY_CONFIG_URL, rememberBenefitModel, saveModelsCache,
  setBenefitMemoryCache, setMemoryCache, SNAP_MODEL_BUILTIN_URL,
} from '../../src/models.js'
import type { CodeArtsCredential } from '../../src/types.js'

/**
 * ⚠️ **全局**缓存目录隔离（不是只包住某一个 describe）。
 *
 * `rememberBenefitModel` / `saveModelsCache` 都会**写盘**，而缓存路径由
 * `DSH_CODEARTS_CACHE_DIR` 决定。若不隔离，跑一次单测就会把测试用的假模型
 * （如 `always-fails`、`brand-new-benefit`）写进**用户真实缓存**
 * （`~/.cache/deveco/`）—— 实测踩到过：真实 `codearts_benefit_models.json`
 * 被写成 `["always-fails"]`。这类污染很隐蔽（测试全绿，但线上行为被改）。
 */
let globalCacheDir: string
const originalCacheDir = process.env.DSH_CODEARTS_CACHE_DIR

beforeAll(() => {
  globalCacheDir = mkdtempSync(join(tmpdir(), 'codearts-models-'))
  process.env.DSH_CODEARTS_CACHE_DIR = globalCacheDir
})

afterAll(() => {
  if (originalCacheDir === undefined) delete process.env.DSH_CODEARTS_CACHE_DIR
  else process.env.DSH_CODEARTS_CACHE_DIR = originalCacheDir
  rmSync(globalCacheDir, { recursive: true, force: true })
})

/** 构造一份最小可用凭据。 */
function makeCredential(): CodeArtsCredential {
  return {
    access_key_id: 'AKTEST',
    secret_access_key: 'SKTEST',
    security_token: 'STTEST',
    expires_at: '2026-12-31T00:00:00Z',
    refresh_token: 'rt',
    code_verifier: 'cv',
    dpop_private_key_jwk: 'jwk',
  } as CodeArtsCredential
}

/** 按 URL 路由返回不同响应的 mock fetch；记录每次请求的 URL 与头。 */
function makeFetcher(routes: Record<string, { status?: number; body: string }>) {
  const calls: Array<{ url: string; headers: Headers }> = []
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, headers: new Headers(init?.headers) })
    const route = routes[url]
    if (route === undefined) return new Response('', { status: 404 })
    return new Response(route.body, { status: route.status ?? 200 })
  }
  return { fetcher: fetcher as unknown as typeof fetch, calls }
}

describe('fetchCodeArtsRemoteModels', () => {
  it('requests the /v1/model/builtin endpoint (not the old statistics/plugin)', async () => {
    const { fetcher, calls } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: {
        body: JSON.stringify({
          count: 2,
          builtinModels: [
            { model_id: 'GLM-5.2', model_name: 'GLM-5.2' },
            { model_id: 'openpangu-2.0-flash', model_name: 'openpangu-2.0-flash' },
          ],
        }),
      },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const snapCall = calls.find((c) => c.url === SNAP_MODEL_BUILTIN_URL)
    expect(snapCall).toBeDefined()
    expect(models).toContainEqual({ id: 'GLM-5.2', name: 'GLM-5.2' })
    expect(models).toContainEqual({ id: 'openpangu-2.0-flash', name: 'openpangu-2.0-flash' })
  })

  it('sends Agent-Type: PromptCenter and X-Language: zh-cn on the builtin request (unsigned headers)', async () => {
    const { fetcher, calls } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: { body: JSON.stringify({ builtinModels: [] }) },
    })
    await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const snapCall = calls.find((c) => c.url === SNAP_MODEL_BUILTIN_URL)
    expect(snapCall?.headers.get('Agent-Type')).toBe('PromptCenter')
    expect(snapCall?.headers.get('X-Language')).toBe('zh-cn')
    expect(snapCall?.headers.get('Content-Type')).toBe('application/json')
  })

  it('parses builtinModels[] (not the old model_metrics field)', async () => {
    const { fetcher } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: {
        body: JSON.stringify({
          // 旧字段已废弃，不应被解析
          model_metrics: [{ model_id: 'OLD-SHOULD-NOT-APPEAR', model_name: 'old' }],
          builtinModels: [
            { model_id: 'GLM-5.2-ArkTS-SPARK', model_name: 'GLM-5.2 ArkTS SPARK' },
          ],
        }),
      },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    expect(models).toContainEqual({ id: 'GLM-5.2-ArkTS-SPARK', name: 'GLM-5.2 ArkTS SPARK' })
    expect(models.find((m) => m.id === 'OLD-SHOULD-NOT-APPEAR')).toBeUndefined()
  })

  it('filters out VL (vision) multimodal models from the builtin list', async () => {
    const { fetcher } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: {
        body: JSON.stringify({
          builtinModels: [
            { model_id: 'GLM-5.2', model_name: 'GLM-5.2' },
            { model_id: 'Qwen3-VL-235B', model_name: 'Qwen3-VL-235B' },
            { model_id: 'something-VL', model_name: 'something-VL' },
            { model_id: 'glm-5.2-sft-harmony', model_name: 'glm-5.2-sft-harmony' },
          ],
        }),
      },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const ids = models.map((m) => m.id)
    expect(ids).toContain('GLM-5.2')
    expect(ids).toContain('glm-5.2-sft-harmony')
    expect(ids).not.toContain('Qwen3-VL-235B')
    expect(ids).not.toContain('something-VL')
  })

  /**
   * ⚠️ **真实缺陷回归**（2026-10-09 实测）：
   * VL 过滤判据原先是**大小写敏感**的（`id.includes('-VL-') || id.endsWith('-VL')`），
   * 而远端下发的 id 大小写并不统一 —— 实测 `snap /v1/model/builtin` 同时下发
   * `Qwen3-VL-235B`（大写，被过滤）与 **`kimi-k2.6-vl`（全小写，漏网）**，
   * 于是后者出现在模型选择器里。
   *
   * 远端自己对两者的标注**完全同类**（都是 `display_enabled: false` +
   * `model_category: "图片理解"`），可见「不该展示」是服务端的明确意图。
   * 复核脚本：`scripts/probe-codearts-vl.mjs`。
   */
  it('VL 过滤必须大小写不敏感（kimi-k2.6-vl 曾漏网）', async () => {
    const { fetcher } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: {
        body: JSON.stringify({
          builtinModels: [
            { model_id: 'GLM-5.2', model_name: 'GLM-5.2' },
            { model_id: 'Qwen3-VL-235B', model_name: 'Qwen3-VL-235B' },
            { model_id: 'kimi-k2.6-vl', model_name: 'Kimi-K2.6-VL' },
            { model_id: 'lower-vl', model_name: 'lower-vl' },
            { model_id: 'mid-vl-x', model_name: 'mid-vl-x' },
          ],
        }),
      },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const ids = models.map((m) => m.id)
    expect(ids).toContain('GLM-5.2')
    // 各种大小写形态的 VL 模型都必须被过滤
    for (const vl of ['Qwen3-VL-235B', 'kimi-k2.6-vl', 'lower-vl', 'mid-vl-x']) {
      expect(ids, `${vl} 应被 VL 过滤剔除`).not.toContain(vl)
    }
  })

  it('merges opengw gateway/config models with builtin models, deduped', async () => {
    const { fetcher } = makeFetcher({
      [OPENGW_GATEWAY_CONFIG_URL]: {
        body: JSON.stringify({
          result: {
            models: [
              { model_id: 'deepseek-v4.1-flash', model_name: 'deepseek-v4.1-flash' },
              { model_id: 'deepseek-v4-flash-0731', model_name: 'deepseek-v4-flash' },
            ],
          },
        }),
      },
      [SNAP_MODEL_BUILTIN_URL]: {
        body: JSON.stringify({
          builtinModels: [
            { model_id: 'GLM-5.2', model_name: 'GLM-5.2' },
            { model_id: 'deepseek-v4.1-flash', model_name: 'deepseek-v4.1-flash' },
          ],
        }),
      },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const ids = models.map((m) => m.id)
    // 日期后缀被 normalizeModelId 去掉
    expect(ids).toContain('deepseek-v4-flash')
    expect(ids).not.toContain('deepseek-v4-flash-0731')
    // 常规模型
    expect(ids).toContain('GLM-5.2')
    // 去重：deepseek-v4.1-flash 只出现一次
    expect(ids.filter((id) => id === 'deepseek-v4.1-flash')).toHaveLength(1)
  })

  it('丢弃已退役的 glm-5.3-flash（gateway 至今仍在下发它）', async () => {
    // 2026-10-09 实测：glm-5.3-flash 已从服务端目录下线（不带 maas_type →
    // 404 not registered；带上 → 4004.200 benefit not found），但
    // opengw gateway/config **仍把它列在 result.models 里** —— 必须主动过滤，
    // 否则模型菜单里会出现一个必然报错的死模型。
    const { fetcher } = makeFetcher({
      [OPENGW_GATEWAY_CONFIG_URL]: {
        body: JSON.stringify({
          result: {
            models: [
              { model_id: 'glm-5.3-flash', model_name: 'glm-5.3-flash' },
              { model_id: 'deepseek-v4.1-flash', model_name: 'deepseek-v4.1-flash' },
            ],
          },
        }),
      },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const ids = models.map((m) => m.id)
    expect(ids).not.toContain('glm-5.3-flash')
    expect(ids).toContain('deepseek-v4.1-flash')
  })

  it('读取磁盘缓存时同样过滤退役模型（旧缓存里可能还留着）', () => {
    // 只过滤远端结果不够：远端拉取失败时 availableCodeArtsModels 直接采信
    // 磁盘缓存，而旧缓存（本次修复前写入的）里就含 glm-5.3-flash。
    saveModelsCache([
      { id: 'glm-5.3-flash', name: 'glm-5.3-flash' },
      { id: 'GLM-5.2', name: 'GLM-5.2' },
    ])
    setMemoryCache(undefined)
    const loaded = loadModelsCache()
    expect(loaded?.map((m) => m.id)).toEqual(['GLM-5.2'])
  })

  it('returns empty array when credential lacks AK/SK', async () => {
    const { fetcher, calls } = makeFetcher({})
    const cred = makeCredential()
    cred.access_key_id = ''
    const models = await fetchCodeArtsRemoteModels(cred, fetcher)
    expect(models).toEqual([])
    expect(calls).toHaveLength(0)
  })
})

/**
 * benefit 模型判定与缓存。
 *
 * ⚠️ 判据在 2026-10-09 **第二次推翻**：本函数曾用「硬编码集合」→「gateway
 * 清单 ∪ 静态兜底」，而实测证明**任何清单都不可采信**（gateway 至今仍把已
 * 退役的 glm-5.3-flash 列在 result.models 里，且把 deepseek-v4.1-flash 列为
 * benefit —— 而后者带上该头反而稳定失败）。现在改为**完全自适应**：默认不带，
 * 由 llm-adapter 按服务端响应学习。故本段只测「学习记录的存取语义」。
 */
describe('isCodeArtsBenefitModel（自适应学习记录）', () => {
  let cacheDir: string
  const originalDir = process.env.DSH_CODEARTS_CACHE_DIR

  beforeEach(() => {
    // 隔离磁盘缓存：否则会读到真实用户缓存（~/.cache/deveco），断言不稳定
    cacheDir = mkdtempSync(join(tmpdir(), 'codearts-benefit-'))
    process.env.DSH_CODEARTS_CACHE_DIR = cacheDir
    setBenefitMemoryCache(undefined)
  })

  afterEach(() => {
    setBenefitMemoryCache(undefined)
    if (originalDir === undefined) delete process.env.DSH_CODEARTS_CACHE_DIR
    else process.env.DSH_CODEARTS_CACHE_DIR = originalDir
    rmSync(cacheDir, { recursive: true, force: true })
  })

  it('默认判定为「不带 benefit 头」—— 空记录时恒为 false', () => {
    // ⚠️ 默认值必须是 false：实测当前服务端对**所有**模型带上该头都回
    // benefit not found，默认取反会让整个 provider 全线不可用。
    for (const model of ['deepseek-v4.1-flash', 'GLM-5.2', 'deepseek-v4-flash', 'kimi-k2.6-vl']) {
      expect(isCodeArtsBenefitModel(model), `${model} 默认不应判为 benefit`).toBe(false)
    }
  })

  it('learn / forget 往返：学习后命中，撤销后不再命中', () => {
    expect(isCodeArtsBenefitModel('some-model')).toBe(false)
    rememberBenefitModel('some-model')
    expect(isCodeArtsBenefitModel('some-model')).toBe(true)
    forgetBenefitModel('some-model')
    expect(isCodeArtsBenefitModel('some-model')).toBe(false)
  })

  it('学习记录落盘，重启后仍生效（避免每次都多一次探测请求）', () => {
    rememberBenefitModel('some-model')
    // 清掉内存缓存，模拟进程重启后从磁盘加载
    setBenefitMemoryCache(undefined)
    expect(loadBenefitCache()).toContain('some-model')
    expect(isCodeArtsBenefitModel('some-model')).toBe(true)
  })

  it('forget 后落盘同步更新 —— 否则过时记录会在重启后复活', () => {
    rememberBenefitModel('stale-model')
    forgetBenefitModel('stale-model')
    setBenefitMemoryCache(undefined)
    expect(loadBenefitCache() ?? []).not.toContain('stale-model')
  })

  it('重复 learn 不产生重复条目（幂等，且不做多余 IO）', () => {
    rememberBenefitModel('dup-model')
    rememberBenefitModel('dup-model')
    expect(loadBenefitCache()?.filter((id) => id === 'dup-model')).toHaveLength(1)
  })

  it('forget 一个未记录过的模型是安全的空操作', () => {
    rememberBenefitModel('kept-model')
    forgetBenefitModel('never-seen')
    expect(isCodeArtsBenefitModel('kept-model')).toBe(true)
  })

  it('模型列表缓存读写往返（同一 require 缺陷）', () => {
    saveModelsCache([{ id: 'GLM-5.2', name: 'GLM-5.2' }])
    expect(loadModelsCache()).toEqual([{ id: 'GLM-5.2', name: 'GLM-5.2' }])
  })
})
