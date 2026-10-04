import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DoubaoService } from '../../src/doubao-service.js'
import { DOUBAO_PROTOCOL_SCHEME } from '../../src/doubao-product.js'

describe('DoubaoService 本地探测与联动服务（方案 1 · 路线 C）', () => {
  let tempDir: string
  let service: DoubaoService

  beforeEach(() => {
    tempDir = join(tmpdir(), `dsh-doubao-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tempDir, { recursive: true })
    service = new DoubaoService()
  })

  afterEach(() => {
    service.dispose()
    delete process.env.DSH_DOUBAO_MOCK_REGISTRY
    delete process.env.DSH_DOUBAO_APPDATA_DIR
    delete process.env.DSH_DOUBAO_LOCALAPPDATA_DIR
    delete process.env.DSH_DOUBAO_MOCK_PROCESSES
    delete process.env.DSH_DOUBAO_INSTALL_DIR
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('初始 getStatus() 返回未就绪的默认骨架（毫秒级快照）', () => {
    const status = service.getStatus()
    expect(status.installed).toBe(false)
    expect(status.protocolRegistered).toBe(false)
    expect(status.running).toBe(false)
    expect(status.runningPids).toEqual([])
    expect(status.lastProbedAt).toBe(0)
  })

  it('探测注册表 Mock 数据、版本与协议登记', async () => {
    process.env.DSH_DOUBAO_MOCK_REGISTRY = JSON.stringify({
      installed: true,
      version: '2.31.2',
      displayName: '豆包',
      installPath: 'C:\\Program Files\\Doubao',
      exePath: 'C:\\Program Files\\Doubao\\Doubao.exe',
      iconPath: 'C:\\Program Files\\Doubao\\icon.ico',
      protocolRegistered: true,
      protocolCommand: '"C:\\Program Files\\Doubao\\Doubao.exe" --open-url "%1"',
    })

    const status = await service.probe(true)
    expect(status.installed).toBe(true)
    expect(status.version).toBe('2.31.2')
    expect(status.displayName).toBe('豆包')
    expect(status.installPath).toBe('C:\\Program Files\\Doubao')
    expect(status.exePath).toBe('C:\\Program Files\\Doubao\\Doubao.exe')
    expect(status.protocolRegistered).toBe(true)
    expect(status.lastProbedAt).toBeGreaterThan(0)
  })

  it('感知 public_config.json 中的当前用户 UID 与多用户列表', async () => {
    const appData = join(tempDir, 'AppData', 'Roaming', 'Doubao')
    mkdirSync(appData, { recursive: true })
    process.env.DSH_DOUBAO_APPDATA_DIR = appData

    const mockConfig = {
      text_picker: {
        current_user: {
          user_id: '88889999123',
          modify_version: '2.31.0',
          user_action_time: '1728000000',
          enable: true,
        },
        users: [
          { user_id: '88889999123', enable: true },
          { user_id: '77776666555', enable: false },
        ],
      },
    }
    writeFileSync(join(appData, 'public_config.json'), JSON.stringify(mockConfig), 'utf8')

    const status = await service.probe(true)
    expect(status.currentUser?.userId).toBe('88889999123')
    expect(status.currentUser?.enable).toBe(true)
    expect(status.allUsers).toHaveLength(2)
    expect(status.allUsers?.[0]?.userId).toBe('88889999123')
    expect(status.allUsers?.[1]?.userId).toBe('77776666555')
  })

  it('感知 saman_app_state 窗口与前后台活跃度', async () => {
    const localAppData = join(tempDir, 'AppData', 'Local', 'Doubao')
    const userData = join(localAppData, 'User Data')
    mkdirSync(userData, { recursive: true })
    process.env.DSH_DOUBAO_LOCALAPPDATA_DIR = localAppData

    const mockAppState = {
      browser_app_state: { has_browser_window: true },
      chat_app_state: { visible: true },
      last_app_active: true,
    }
    writeFileSync(join(userData, 'saman_app_state'), JSON.stringify(mockAppState), 'utf8')

    const status = await service.probe(true)
    expect(status.appState).toBeDefined()
    expect(status.appState?.hasBrowserWindow).toBe(true)
    expect(status.appState?.chatVisible).toBe(true)
    expect(status.appState?.lastActive).toBe(true)
  })

  it('探测运行中进程（Mock 进程注入）', async () => {
    process.env.DSH_DOUBAO_MOCK_PROCESSES = JSON.stringify({
      running: true,
      pids: [1024, 2048, 4096],
    })

    const status = await service.probe(true)
    expect(status.running).toBe(true)
    expect(status.runningPids).toEqual([1024, 2048, 4096])
  })

  it('非 force 模式在 3 秒窗口内复用内存缓存', async () => {
    process.env.DSH_DOUBAO_MOCK_PROCESSES = JSON.stringify({ running: true, pids: [100] })
    const first = await service.probe(true)
    expect(first.runningPids).toEqual([100])

    process.env.DSH_DOUBAO_MOCK_PROCESSES = JSON.stringify({ running: true, pids: [200] })
    const cached = await service.probe(false)
    expect(cached.runningPids).toEqual([100]) // 复用缓存

    const forced = await service.probe(true)
    expect(forced.runningPids).toEqual([200]) // 强制刷新
  })

  it('launchClient 校验协议前缀与非法注入字符', async () => {
    await expect(service.launchClient('http://malicious.com')).rejects.toThrow('非法唤醒协议')
    await expect(service.launchClient('doubao://open|calc.exe')).rejects.toThrow('唤醒参数包含不安全字符')
    await expect(service.launchClient('doubao://open;calc.exe')).rejects.toThrow('唤醒参数包含不安全字符')
    await expect(service.launchClient('doubao://open"&calc.exe')).rejects.toThrow('唤醒参数包含不安全字符')
  })

  it('dispose 释放内存缓存', async () => {
    process.env.DSH_DOUBAO_MOCK_PROCESSES = JSON.stringify({ running: true, pids: [123] })
    await service.probe(true)
    expect(service.getStatus().running).toBe(true)

    service.dispose()
    expect(service.getStatus().running).toBe(false)
  })
})
