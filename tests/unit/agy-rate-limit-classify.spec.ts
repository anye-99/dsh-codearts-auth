import { describe, expect, it } from 'vitest'

import { looksLikeHardRateLimit, looksLikeRateLimit } from '../../src/agy/types.js'

/**
 * 限流判据回归（移植自 `dsh-agy-link/test/rate-limit-classify.test.ts`）。
 *
 * `looksLikeHardRateLimit` 是适配器**唯一允许给账号打冷却**的判据，刻意收窄：
 * 裸 `429` / `rate limit` 会匹配到 hash/UUID 片段、模型正文里的额度讨论等，
 * 产生「幽灵冷却」冻住健康账号。对面用真实事故文本锁死这个判据，这里原样保留。
 */

// 真实事故原文：cortex 工具/权限错误，旧的宽松判据（裸 429 / rate limit）曾把它
// 连同 stdout 里的额度词误判为限流，给健康账号打了幽灵冷却。
const REAL_TOOL_ERROR =
  'declaring permissions: cortex tool write_to_file: convert tool call for permissions: model output error: invalid tool call error (invalid_args) /Users/zqy/Developer/academic-agent/frontend/src/components/landing/LandingNavbar.tsx is not a valid artifact path; artifacts must be in /Users/zqy/.dsh/agy-accounts/acc_1787217298501_cul90/.gemini/antigravity-cli/brain/f94449b8-3395-4b85-bdc1-cba6deeeee94/'

describe('looksLikeHardRateLimit', () => {
  it('匹配真实服务端下发的额度签名', () => {
    expect(looksLikeHardRateLimit('RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 21m25s.')).toBe(true)
    expect(looksLikeHardRateLimit('Rate limit or quota reached')).toBe(true)
    expect(looksLikeHardRateLimit('retry: attempt 2 failed (429: Too Many Requests)')).toBe(true)
    expect(looksLikeHardRateLimit('You exceeded your quota. Try again after 2026-08-25T09:00:00Z.')).toBe(true)
  })

  it('拒绝偶然子串与无关错误（真实事故文本 / UUID 片段 / 模型正文）', () => {
    expect(looksLikeHardRateLimit(REAL_TOOL_ERROR)).toBe(false)
    expect(looksLikeHardRateLimit('conversation f94449b8-3395-4b85-bdc1-cba6deeeee94 not found')).toBe(false)
    expect(looksLikeHardRateLimit('the API docs say rate limits may apply during peak hours')).toBe(false)
    expect(looksLikeHardRateLimit(undefined)).toBe(false)
    expect(looksLikeHardRateLimit('')).toBe(false)
  })
})

describe('looksLikeRateLimit（软启发式）', () => {
  it('容量信号只进软集合，不进硬集合（ shaping 可，冷却不可）', () => {
    expect(looksLikeRateLimit('model overloaded')).toBe(true)
    expect(looksLikeHardRateLimit('model overloaded')).toBe(false)
    expect(looksLikeRateLimit('server experiencing high traffic, retry later')).toBe(true)
    expect(looksLikeHardRateLimit('server experiencing high traffic, retry later')).toBe(false)
  })

  it('软集合包含全部硬集合，且对事故文本保持沉默', () => {
    expect(looksLikeRateLimit('RESOURCE_EXHAUSTED (code 429)')).toBe(true)
    expect(looksLikeRateLimit(REAL_TOOL_ERROR)).toBe(false)
  })
})
