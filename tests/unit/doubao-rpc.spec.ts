import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { DOUBAO, DOUBAO_PROTOCOL_SCHEME, DOUBAO_PROVIDER_ID, doubaoProductById } from '../../src/doubao-product.js'
import { CREDITS_CAPABILITIES, supportsCreditBalance, supportsDailyCheckin, supportsRateLimit } from '../../plugin-src/client/credits-capabilities.js'

describe('Doubao (豆包) 产品配置与规范单一真相源', () => {
  it('DOUBAO 常量与 provider id 一致', () => {
    expect(DOUBAO.id).toBe('doubao')
    expect(DOUBAO_PROVIDER_ID).toBe('doubao')
    expect(DOUBAO.displayName).toBe('Doubao (豆包)')
    expect(DOUBAO_PROTOCOL_SCHEME).toBe('doubao://')
  })

  it('doubaoProductById 查找机制', () => {
    expect(doubaoProductById('doubao')).toEqual(DOUBAO)
    expect(doubaoProductById('other')).toBeUndefined()
  })

  it('路线 C 能力矩阵：非凭据型本地客户端面板，无远程积分/限流', () => {
    expect(CREDITS_CAPABILITIES.doubao).toEqual({
      balance: false,
      dailyCheckin: false,
      subscriptionQuota: false,
    })
    expect(supportsCreditBalance('doubao')).toBe(false)
    expect(supportsDailyCheckin('doubao')).toBe(false)
    expect(supportsRateLimit('doubao')).toBe(false)
  })
})

describe('Doubao 接线点完整性与分派规范（源码级防线）', () => {
  const indexSource = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8')
  const rpcSource = readFileSync(new URL('../../src/jet-hub-rpc.ts', import.meta.url), 'utf8')
  const clientSource = readFileSync(new URL('../../plugin-src/client/jet-hub.js', import.meta.url), 'utf8')

  it('index.ts 接线点齐全', () => {
    // 1. import DoubaoService
    expect(indexSource).toContain("from './doubao-service.js'")
    // 2. 服务实例与生命周期释放
    expect(indexSource).toContain('const doubaoService = new DoubaoService()')
    expect(indexSource).toContain('doubaoService.dispose()')
    // 3. refreshTargets 表
    expect(indexSource).toContain("['doubao', () => doubaoService.probe(true).then(() => undefined)]")
    // 4. registerJetHubRpc 实参最后传入 doubaoService
    expect(indexSource).toMatch(/registerJetHubRpc\([\s\S]*?doubaoService\)/)
  })

  it('jet-hub-rpc.ts 动词分派与边界齐全', () => {
    // 1. 扩展动词（本地客户端专属）
    expect(rpcSource).toContain("case 'doubao.status':")
    expect(rpcSource).toContain("case 'doubao.probe':")
    expect(rpcSource).toContain("case 'doubao.launch':")

    // 2. 标准动词适配
    expect(rpcSource).toContain('req.provider === DOUBAO_PROVIDER_ID')
    expect(rpcSource).toContain("req.accountId === 'doubao-local'")
    expect(rpcSource).toContain('provider === DOUBAO_PROVIDER_ID')
  })

  it('jet-hub.js 客户端面板接入与组件渲染规范', () => {
    // 1. 独立组件 import
    expect(clientSource).toContain("import { DoubaoPanel } from './doubao-panel.js'")
    // 2. PROVIDERS 登记
    expect(clientSource).toMatch(/\{\s*id:\s*'doubao',\s*label:\s*'Doubao \(豆包\)',\s*icon:\s*DOUBAO_ICON,\s*logoClass:\s*'doubao'\s*\}/)
    // 3. 面板独立挂载分支（不进 ProviderPanel，防虚假未登录提示）
    expect(clientSource).toContain("p.id === 'doubao'")
    expect(clientSource).toContain('React.createElement(DoubaoPanel,')
  })
})
