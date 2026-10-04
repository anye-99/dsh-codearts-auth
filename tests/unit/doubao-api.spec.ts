import { describe, expect, it, vi } from 'vitest'
import { createDoubaoApi, PROVIDER } from '../../plugin-src/client/doubao-api.js'

function fakeRpc(handlers: Record<string, (payload: unknown) => unknown>) {
  const calls: Array<{ endpoint: string; payload: unknown }> = []
  const fn = vi.fn(async (endpoint: string, payload?: unknown) => {
    calls.push({ endpoint, payload })
    const h = handlers[endpoint]
    if (!h) throw new Error(`unknown endpoint: ${endpoint}`)
    return h(payload)
  })
  return Object.assign(fn, { calls })
}

describe('Doubao API 客户端控制面出口（plugin-src/client/doubao-api.js）', () => {
  it('PROVIDER 常量与规范一致', () => {
    expect(PROVIDER).toBe('doubao')
  })

  it('status() 调用 doubao.status 并解包', async () => {
    const rpc = fakeRpc({
      'doubao.status': () => ({
        installed: true,
        running: true,
        currentUser: { userId: '12345' },
      }),
    })
    const api = createDoubaoApi(rpc)
    const res = await api.status()
    expect(rpc.calls[0]!.endpoint).toBe('doubao.status')
    expect(res.ok).toBe(true)
    expect(res.status?.installed).toBe(true)
    expect(res.status?.currentUser?.userId).toBe('12345')
  })

  it('probe() 调用 doubao.probe 并返回最新状态', async () => {
    const rpc = fakeRpc({
      'doubao.probe': () => ({
        installed: true,
        running: false,
      }),
    })
    const api = createDoubaoApi(rpc)
    const res = await api.probe()
    expect(rpc.calls[0]!.endpoint).toBe('doubao.probe')
    expect(res.ok).toBe(true)
    expect(res.status?.installed).toBe(true)
    expect(res.status?.running).toBe(false)
  })

  it('launch(url) 传递唤醒 URL 至 doubao.launch', async () => {
    const rpc = fakeRpc({
      'doubao.launch': (payload) => ({
        message: 'ok',
        url: (payload as { url?: string })?.url,
      }),
    })
    const api = createDoubaoApi(rpc)
    const res = await api.launch('doubao://custom')
    expect(rpc.calls[0]!.endpoint).toBe('doubao.launch')
    expect(rpc.calls[0]!.payload).toEqual({ url: 'doubao://custom' })
    expect(res.ok).toBe(true)
  })

  it('accounts() 映射至标准动词 account.list { provider: "doubao" }', async () => {
    const rpc = fakeRpc({
      'account.list': (payload) => {
        expect((payload as { provider: string }).provider).toBe('doubao')
        return {
          accounts: [
            { id: 'doubao-123', provider: 'doubao', label: '123' },
          ],
        }
      },
    })
    const api = createDoubaoApi(rpc)
    const res = await api.accounts()
    expect(rpc.calls[0]!.endpoint).toBe('account.list')
    expect(res.ok).toBe(true)
    expect(res.accounts).toHaveLength(1)
  })

  it('refresh() 映射至标准动词 account.refresh', async () => {
    const rpc = fakeRpc({
      'account.refresh': (payload) => {
        expect(payload).toEqual({ accountId: 'doubao-local', provider: 'doubao' })
        return { status: 'healthy' }
      },
    })
    const api = createDoubaoApi(rpc)
    const res = await api.refresh()
    expect(rpc.calls[0]!.endpoint).toBe('account.refresh')
    expect(res.ok).toBe(true)
    expect(res.status).toBe('healthy')
  })

  it('RPC 异常时优雅降级返回 ok: false 与 error 说明', async () => {
    const rpc = fakeRpc({
      'doubao.status': () => {
        throw new Error('网络通信断开')
      },
    })
    const api = createDoubaoApi(rpc)
    const res = await api.status()
    expect(res.ok).toBe(false)
    expect(res.error).toContain('网络通信断开')
  })

  it('rpcCall 非函数时返回安全空兜底', async () => {
    // @ts-expect-error test invalid param
    const api = createDoubaoApi(null)
    const res = await api.status()
    expect(res.ok).toBe(false)
    expect(res.error).toBe('rpc unavailable')
  })
})
