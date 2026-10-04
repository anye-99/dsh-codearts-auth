import { exec, execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import {
  DOUBAO_PROTOCOL_SCHEME,
  DOUBAO_REG_PROTOCOL_KEY,
  DOUBAO_REG_UNINSTALL_KEY,
} from './doubao-product.js'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

/** 豆包客户端感知到的用户信息。 */
export interface DoubaoUser {
  userId: string
  modifyVersion?: string
  userActionTime?: string
  enable?: boolean
}

/** 豆包客户端窗口与运行状态。 */
export interface DoubaoAppState {
  hasBrowserWindow?: boolean
  chatVisible?: boolean
  lastActive?: boolean
}

/** 豆包客户端探测总状态。 */
export interface DoubaoStatus {
  installed: boolean
  version?: string
  displayName?: string
  installPath?: string
  exePath?: string
  iconPath?: string
  protocolRegistered: boolean
  protocolCommand?: string
  running: boolean
  runningPids: number[]
  currentUser?: DoubaoUser
  allUsers?: DoubaoUser[]
  appState?: DoubaoAppState
  lastProbedAt: number
}

/**
 * 豆包本地桌面客户端探测与联动服务。
 *
 * 遵循路线 C：只作本地状态探测、当前 UID 感知与协议一键唤醒，
 * 不持有用户凭据、不发网络请求。
 */
export class DoubaoService {
  private cachedStatus: DoubaoStatus | null = null
  private probePromise: Promise<DoubaoStatus> | null = null

  /** 获取当前内存状态快照（毫秒级）。 */
  getStatus(): DoubaoStatus {
    if (this.cachedStatus) return this.cachedStatus
    return {
      installed: false,
      protocolRegistered: false,
      running: false,
      runningPids: [],
      lastProbedAt: 0,
    }
  }

  /**
   * 探测本地豆包客户端状态。
   * @param force 是否强制重新读取本地文件与系统状态
   */
  async probe(force = false): Promise<DoubaoStatus> {
    if (!force && this.cachedStatus && Date.now() - this.cachedStatus.lastProbedAt < 3000) {
      return this.cachedStatus
    }
    if (this.probePromise) return this.probePromise

    this.probePromise = this.doProbe().finally(() => {
      this.probePromise = null
    })
    return this.probePromise
  }

  private async doProbe(): Promise<DoubaoStatus> {
    const regInfo = await this.probeRegistry()
    const userInfo = this.probePublicConfig()
    const appState = this.probeAppState()
    const processInfo = await this.probeRunningProcesses()

    const installPath = regInfo.installPath ?? this.detectFallbackInstallPath()
    let exePath = regInfo.exePath
    if (!exePath && installPath) {
      const candidate = join(installPath, 'Doubao.exe')
      if (existsSync(candidate)) exePath = candidate
    }

    const installed = Boolean(regInfo.installed || (exePath && existsSync(exePath)))

    const status: DoubaoStatus = {
      installed,
      version: regInfo.version,
      displayName: regInfo.displayName ?? '豆包',
      installPath,
      exePath,
      iconPath: regInfo.iconPath,
      protocolRegistered: regInfo.protocolRegistered,
      protocolCommand: regInfo.protocolCommand,
      running: processInfo.running,
      runningPids: processInfo.pids,
      currentUser: userInfo.currentUser,
      allUsers: userInfo.users,
      appState,
      lastProbedAt: Date.now(),
    }

    this.cachedStatus = status
    return status
  }

  /** 探测注册表中的安装与协议信息。 */
  private async probeRegistry(): Promise<{
    installed: boolean
    version?: string
    displayName?: string
    installPath?: string
    exePath?: string
    iconPath?: string
    protocolRegistered: boolean
    protocolCommand?: string
  }> {
    // 允许通过环境变量注入 mock 注册表数据供单元测试使用
    if (process.env.DSH_DOUBAO_MOCK_REGISTRY) {
      try {
        return JSON.parse(process.env.DSH_DOUBAO_MOCK_REGISTRY)
      } catch {
        // ignore parse error
      }
    }

    if (process.platform !== 'win32') {
      return { installed: false, protocolRegistered: false }
    }

    let installed = false
    let version: string | undefined
    let displayName: string | undefined
    let installPath: string | undefined
    let exePath: string | undefined
    let iconPath: string | undefined
    let protocolRegistered = false
    let protocolCommand: string | undefined

    try {
      const { stdout } = await execFileAsync('reg.exe', ['query', `HKCU\\${DOUBAO_REG_UNINSTALL_KEY}`], {
        encoding: 'utf8',
        timeout: 3000,
      })
      installed = true
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.startsWith('DisplayVersion')) {
          version = trimmed.split(/\s+REG_SZ\s+/i)[1]?.trim()
        } else if (trimmed.startsWith('DisplayName')) {
          displayName = trimmed.split(/\s+REG_SZ\s+/i)[1]?.trim()
        } else if (trimmed.startsWith('DisplayIcon')) {
          const raw = trimmed.split(/\s+REG_SZ\s+/i)[1]?.trim().replace(/^"|"$/g, '')
          if (raw) iconPath = raw
        } else if (trimmed.startsWith('UninstallString')) {
          const raw = trimmed.split(/\s+REG_SZ\s+/i)[1]?.trim().replace(/^"|"$/g, '')
          if (raw) {
            installPath = dirname(raw)
            const doubaoExe = join(installPath, 'Doubao.exe')
            if (existsSync(doubaoExe)) exePath = doubaoExe
          }
        }
      }
    } catch {
      // 未在 HKCU 中查到
    }

    try {
      const { stdout } = await execFileAsync('reg.exe', ['query', `HKCU\\${DOUBAO_REG_PROTOCOL_KEY}`], {
        encoding: 'utf8',
        timeout: 3000,
      })
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.includes('REG_SZ')) {
          protocolRegistered = true
          protocolCommand = trimmed.split(/\s+REG_SZ\s+/i)[1]?.trim()
          break
        }
      }
    } catch {
      // 未注册协议
    }

    return {
      installed,
      version,
      displayName,
      installPath,
      exePath,
      iconPath,
      protocolRegistered,
      protocolCommand,
    }
  }

  /** 获取豆包 AppData 目录。 */
  private getAppDataDir(): string {
    if (process.env.DSH_DOUBAO_APPDATA_DIR) return process.env.DSH_DOUBAO_APPDATA_DIR
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    return join(appData, 'Doubao')
  }

  /** 获取豆包 LocalAppData 目录。 */
  private getLocalAppDataDir(): string {
    if (process.env.DSH_DOUBAO_LOCALAPPDATA_DIR) return process.env.DSH_DOUBAO_LOCALAPPDATA_DIR
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    return join(localAppData, 'Doubao')
  }

  /** 读取 `%APPDATA%\Doubao\public_config.json` 获取登录用户信息。 */
  private probePublicConfig(): { currentUser?: DoubaoUser; users?: DoubaoUser[] } {
    const configPath = join(this.getAppDataDir(), 'public_config.json')
    if (!existsSync(configPath)) return {}

    try {
      const content = readFileSync(configPath, 'utf8')
      const data = JSON.parse(content)
      const textPicker = data?.text_picker
      const rawUser = textPicker?.current_user
      let currentUser: DoubaoUser | undefined
      if (rawUser && rawUser.user_id) {
        currentUser = {
          userId: String(rawUser.user_id),
          modifyVersion: rawUser.modify_version ? String(rawUser.modify_version) : undefined,
          userActionTime: rawUser.user_action_time ? String(rawUser.user_action_time) : undefined,
          enable: rawUser.enable !== false,
        }
      }

      let users: DoubaoUser[] | undefined
      if (Array.isArray(textPicker?.users)) {
        users = textPicker.users
          .filter((u: Record<string, unknown>) => u && u.user_id)
          .map((u: Record<string, unknown>) => ({
            userId: String(u.user_id),
            modifyVersion: u.modify_version ? String(u.modify_version) : undefined,
            userActionTime: u.user_action_time ? String(u.user_action_time) : undefined,
            enable: u.enable !== false,
          }))
      }

      return { currentUser, users }
    } catch {
      return {}
    }
  }

  /** 读取 `%LOCALAPPDATA%\Doubao\User Data\saman_app_state` 获取应用前台/显隐状态。 */
  private probeAppState(): DoubaoAppState | undefined {
    const statePath = join(this.getLocalAppDataDir(), 'User Data', 'saman_app_state')
    if (!existsSync(statePath)) return undefined

    try {
      const content = readFileSync(statePath, 'utf8')
      const data = JSON.parse(content)
      return {
        hasBrowserWindow: Boolean(data?.browser_app_state?.has_browser_window),
        chatVisible: Boolean(data?.chat_app_state?.visible),
        lastActive: Boolean(data?.last_app_active),
      }
    } catch {
      return undefined
    }
  }

  /** 探测 Doubao 进程是否正在运行。 */
  private async probeRunningProcesses(): Promise<{ running: boolean; pids: number[] }> {
    if (process.env.DSH_DOUBAO_MOCK_PROCESSES) {
      try {
        const parsed = JSON.parse(process.env.DSH_DOUBAO_MOCK_PROCESSES)
        return { running: Boolean(parsed.running), pids: parsed.pids ?? [] }
      } catch {
        // ignore
      }
    }

    if (process.platform !== 'win32') {
      return { running: false, pids: [] }
    }

    try {
      const { stdout } = await execFileAsync(
        'tasklist',
        ['/FI', 'IMAGENAME eq Doubao.exe', '/FO', 'CSV', '/NH'],
        { encoding: 'utf8', timeout: 3000 },
      )
      const pids: number[] = []
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('INFO:')) continue
        const parts = trimmed.split('","').map((s) => s.replace(/^"|"$/g, ''))
        if (parts[0]?.toLowerCase() === 'doubao.exe' && parts[1]) {
          const pid = parseInt(parts[1], 10)
          if (!isNaN(pid)) pids.push(pid)
        }
      }
      return { running: pids.length > 0, pids }
    } catch {
      return { running: false, pids: [] }
    }
  }

  /** 常见默认安装路径回退检测。 */
  private detectFallbackInstallPath(): string | undefined {
    if (process.env.DSH_DOUBAO_INSTALL_DIR) {
      return process.env.DSH_DOUBAO_INSTALL_DIR
    }
    const candidates = [
      'D:\\Doubao',
      'C:\\Program Files\\Doubao',
      'C:\\Program Files (x86)\\Doubao',
      join(homedir(), 'AppData', 'Local', 'Doubao'),
    ]
    for (const dir of candidates) {
      if (existsSync(join(dir, 'Doubao.exe'))) return dir
    }
    return undefined
  }

  /**
   * 调起 / 唤醒豆包客户端。
   *
   * @param targetUrl 可选的唤醒协议 URL（必须以 `doubao://` 开头），缺省为 `doubao://`
   */
  async launchClient(targetUrl?: string): Promise<{ ok: boolean; message: string }> {
    const url = targetUrl?.trim() || DOUBAO_PROTOCOL_SCHEME
    if (!url.startsWith(DOUBAO_PROTOCOL_SCHEME)) {
      throw new Error(`非法唤醒协议：必须以 ${DOUBAO_PROTOCOL_SCHEME} 开头`)
    }

    // 防命令注入：仅允许白名单字符（协议、路径、query 参数）
    if (!/^[a-zA-Z0-9_:\/?&=%.\-]+$/.test(url)) {
      throw new Error('唤醒参数包含不安全字符')
    }

    if (process.platform === 'win32') {
      try {
        // 使用 Windows shell 执行 start 打开协议链接
        await execAsync(`start "" "${url}"`)
        return { ok: true, message: `已成功触发 ${url} 协议唤醒` }
      } catch (err) {
        // 若协议调起失败且存在本地 exe，尝试直接启动可执行文件
        const status = await this.probe()
        if (status.exePath && existsSync(status.exePath)) {
          await execAsync(`start "" "${status.exePath}"`)
          return { ok: true, message: `协议唤醒失败，已直接启动本地客户端：${status.exePath}` }
        }
        throw new Error(`唤醒豆包失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }

    return { ok: false, message: '当前平台暂不支持 Windows 协议唤醒' }
  }

  dispose(): void {
    this.cachedStatus = null
  }
}
