import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  AGY_EFFORTS,
  agySettingsFile,
  readAgySettings,
  sanitizeAgySettings,
  writeAgySettings,
} from '../../src/agy/settings.js'

/**
 * Antigravity 面板级设置（默认思考档位）的持久化回归（2026-10-03）。
 *
 * 这组用例守的是**「界面上显示的值 == 实际发给 agy 的值」**这条不变式：
 * 档位会经 `--effort` 直接进命令行，所以任何"存了但没生效"或
 * "存了个 agy 不认的值"都会变成静默的错误参数，而不是一个可读的报错。
 */

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'agy-settings-')), 'settings.json')
}

describe('设置文档的读写', () => {
  it('文件不存在 ⇒ 默认值（空串 = 跟随模型默认）', () => {
    expect(readAgySettings(tmpFile())).toEqual({ defaultEffort: '' })
  })

  it('写入后可读回（原子落盘）', () => {
    const f = tmpFile()
    expect(writeAgySettings({ defaultEffort: 'low' }, f)).toEqual({ defaultEffort: 'low' })
    expect(readAgySettings(f)).toEqual({ defaultEffort: 'low' })
    // 落盘的是 JSON（不是空文件），且没有留下 .tmp 残骸。
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ defaultEffort: 'low' })
  })

  it('白名单外的值被净化成空串（绝不把 agy 不认的档位写进磁盘）', () => {
    const f = tmpFile()
    expect(writeAgySettings({ defaultEffort: 'ULTRA' }, f)).toEqual({ defaultEffort: '' })
    expect(writeAgySettings({ defaultEffort: '高' }, f)).toEqual({ defaultEffort: '' })
    expect(writeAgySettings({ defaultEffort: 'medium' }, f)).toEqual({ defaultEffort: 'medium' })
  })

  it('损坏的 JSON / 错类型 ⇒ 降级为默认值，不抛（服务构造期不能炸）', () => {
    const f = tmpFile()
    writeFileSync(f, '{ this is not json', 'utf8')
    expect(readAgySettings(f)).toEqual({ defaultEffort: '' })
    writeFileSync(f, '[1,2,3]', 'utf8')
    expect(readAgySettings(f)).toEqual({ defaultEffort: '' })
    writeFileSync(f, JSON.stringify({ defaultEffort: 42 }), 'utf8')
    expect(readAgySettings(f)).toEqual({ defaultEffort: '' })
  })

  it('合并语义：写一个字段不会抹掉其它字段', () => {
    const f = tmpFile()
    writeAgySettings({ defaultEffort: 'high' }, f)
    // 传空串是**显式**选择"跟随模型默认"，不是"别动这个字段"。
    writeAgySettings({ defaultEffort: '' }, f)
    expect(readAgySettings(f)).toEqual({ defaultEffort: '' })
  })

  it('sanitize 只认白名单里的档位', () => {
    expect(sanitizeAgySettings({ defaultEffort: 'max' })).toEqual({ defaultEffort: 'max' })
    expect(sanitizeAgySettings({ defaultEffort: 'bogus' })).toEqual({ defaultEffort: '' })
    expect(sanitizeAgySettings(null)).toEqual({ defaultEffort: '' })
    expect(sanitizeAgySettings('low')).toEqual({ defaultEffort: '' })
  })

  it('文档落在 agy 自有目录（与 pool.json 同目录，不进 jet-hub/state.json）', () => {
    // ⚠️ 用 pool 目录而非共享 state.json 是刻意选择：state.json 的 schema 与
    // 三个后端都要跟着改，而这是 agy 自己的偏好。这条断言防止有人"顺手"
    // 把它挪到共享文档（那会波及另外 12 家 provider 的存储契约）。
    const p = agySettingsFile('C:/tmp/agy-accounts')
    expect(p.replace(/\\/g, '/')).toBe('C:/tmp/agy-accounts/settings.json')
  })

  it('白名单与 agy --effort 的取值一致（low|medium|high|max）', () => {
    expect([...AGY_EFFORTS]).toEqual(['low', 'medium', 'high', 'max'])
  })
})
