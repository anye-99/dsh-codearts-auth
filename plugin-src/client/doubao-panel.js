/**
 * Jet Hub 的 Doubao (豆包) 桌面客户端控制面板。
 *
 * ## 方案 1 · 路线 C：纯客户端联动面板
 *
 * 遵循路线 C 设计规范：
 * 1. 本地豆包桌面端状态探测（注册表安装信息、版本号、执行路径、进程与窗口可见性）；
 * 2. 当前登录 UID 感知（读取 `%APPDATA%\Doubao\public_config.json` 用户信息）；
 * 3. 协议一键唤醒（调用 `doubao://` URL Scheme 唤醒官方客户端或启动可执行文件）。
 *
 * - 纯本地控制面，不持有用户 Token / Cookie 凭据；
 * - 面板所有 RPC 均经由 `./doubao-api.js`，绝不直写端点名；
 * - 独立模块，不得反向 import `./jet-hub.js`（防循环依赖）。
 */

import * as React from 'react';
import { createDoubaoApi } from './doubao-api.js';

const h = React.createElement;

export function DoubaoPanel({ rpcCall }) {
  const api = React.useMemo(() => createDoubaoApi(rpcCall), [rpcCall]);

  const [status, setStatus] = React.useState({
    installed: false,
    protocolRegistered: false,
    running: false,
    runningPids: [],
    lastProbedAt: 0,
  });
  const [loading, setLoading] = React.useState(false);
  const [launching, setLaunching] = React.useState(false);
  const [notice, setNotice] = React.useState(null);
  const [customUrl, setCustomUrl] = React.useState('doubao://');
  const [showAdvanced, setShowAdvanced] = React.useState(false);

  // 刷新状态
  const refreshStatus = React.useCallback(async (force = false) => {
    setLoading(true);
    try {
      const res = force ? await api.probe() : await api.status();
      if (res.ok && res.status) {
        setStatus(res.status);
      } else if (!res.ok) {
        setNotice({ type: 'error', message: `状态探测失败：${res.error || '未知错误'}` });
      }
    } catch (err) {
      setNotice({ type: 'error', message: `状态探测异常：${err?.message || String(err)}` });
    } finally {
      setLoading(false);
    }
  }, [api]);

  React.useEffect(() => {
    void refreshStatus(true);
  }, [refreshStatus]);

  // 一键唤醒客户端
  const handleLaunch = React.useCallback(async (urlToLaunch) => {
    setLaunching(true);
    setNotice(null);
    try {
      const res = await api.launch(urlToLaunch);
      if (res.ok) {
        setNotice({ type: 'success', message: res.result?.message || '已成功唤醒豆包客户端' });
        // 唤醒后 2 秒探测一次进程状态更新
        setTimeout(() => {
          void refreshStatus(true);
        }, 2000);
      } else {
        setNotice({ type: 'error', message: `唤醒失败：${res.error || '未知错误'}` });
      }
    } catch (err) {
      setNotice({ type: 'error', message: `唤醒异常：${err?.message || String(err)}` });
    } finally {
      setLaunching(false);
    }
  }, [api, refreshStatus]);

  const currentUser = status.currentUser;
  const allUsers = status.allUsers || [];
  const appState = status.appState;

  return h('div', { className: 'dim-jh-doubao-panel' },
    // 顶部架构路线说明条
    h('div', { className: 'dim-jh-doubao-banner' },
      h('div', { className: 'dim-jh-doubao-bannerTitle' },
        h('strong', null, '方案 1 · 路线 C：非凭据型本地客户端联动面板'),
        h('span', { className: 'dim-jh-doubao-tag' }, '纯客户端联动')
      ),
      h('p', { className: 'dim-jh-doubao-bannerDesc' },
        '当前面板仅作本地豆包桌面端状态探测、当前 UID 感知与协议一键唤醒。'
        + '本插件不提取、不持有任何 Token/Cookie 空中凭据，完全尊重并复用官方客户端自带的账号状态。'
      )
    ),

    // 消息提示区
    notice ? h('div', { className: `dim-jh-doubao-notice dim-jh-doubao-notice-${notice.type}` },
      h('span', { className: 'dim-jh-doubao-noticeText' }, notice.message),
      h('button', {
        className: 'dim-jh-doubao-noticeClose',
        onClick: () => setNotice(null),
      }, '✕')
    ) : null,

    // 状态卡片网格
    h('div', { className: 'dim-jh-doubao-grid' },
      // 1. 安装状态卡片
      h('div', { className: 'dim-jh-doubao-card' },
        h('div', { className: 'dim-jh-doubao-cardHeader' },
          h('span', { className: 'dim-jh-doubao-cardTitle' }, '安装状态'),
          h('span', {
            className: `dim-jh-doubao-badge ${status.installed ? 'dim-jh-doubao-badge-green' : 'dim-jh-doubao-badge-gray'}`,
          }, status.installed ? '已安装' : '未检测到')
        ),
        h('div', { className: 'dim-jh-doubao-cardBody' },
          h('div', { className: 'dim-jh-doubao-row' },
            h('span', { className: 'dim-jh-doubao-label' }, '客户端版本：'),
            h('span', { className: 'dim-jh-doubao-value' }, status.version || (status.installed ? '已检测到可执行文件' : '—'))
          ),
          h('div', { className: 'dim-jh-doubao-row' },
            h('span', { className: 'dim-jh-doubao-label' }, '可执行文件：'),
            h('span', {
              className: 'dim-jh-doubao-value dim-jh-doubao-path',
              title: status.exePath || '',
            }, status.exePath || (status.installPath ? `${status.installPath}\\Doubao.exe` : '—'))
          ),
          h('div', { className: 'dim-jh-doubao-row' },
            h('span', { className: 'dim-jh-doubao-label' }, '安装根目录：'),
            h('span', {
              className: 'dim-jh-doubao-value dim-jh-doubao-path',
              title: status.installPath || '',
            }, status.installPath || '—')
          )
        )
      ),

      // 2. 进程与协议状态卡片
      h('div', { className: 'dim-jh-doubao-card' },
        h('div', { className: 'dim-jh-doubao-cardHeader' },
          h('span', { className: 'dim-jh-doubao-cardTitle' }, '运行与协议状态'),
          h('span', {
            className: `dim-jh-doubao-badge ${status.running ? 'dim-jh-doubao-badge-green' : 'dim-jh-doubao-badge-orange'}`,
          }, status.running ? '运行中' : '未运行')
        ),
        h('div', { className: 'dim-jh-doubao-cardBody' },
          h('div', { className: 'dim-jh-doubao-row' },
            h('span', { className: 'dim-jh-doubao-label' }, 'Doubao.exe 进程：'),
            h('span', { className: 'dim-jh-doubao-value' },
              status.running
                ? `${status.runningPids.length} 个实例 (PID: ${status.runningPids.join(', ')})`
                : '无运行进程'
            )
          ),
          h('div', { className: 'dim-jh-doubao-row' },
            h('span', { className: 'dim-jh-doubao-label' }, '唤醒协议 (Scheme)：'),
            h('span', { className: 'dim-jh-doubao-value' },
              status.protocolRegistered ? 'doubao:// 已注册' : '未在系统注册表注册'
            )
          ),
          h('div', { className: 'dim-jh-doubao-row' },
            h('span', { className: 'dim-jh-doubao-label' }, '窗口活跃度：'),
            h('span', { className: 'dim-jh-doubao-value' },
              appState
                ? (appState.chatVisible ? 'Chat 窗口可见' : (appState.hasBrowserWindow ? '主窗口已创建' : '后台运行中'))
                : (status.running ? '已启动' : '未启动')
            )
          )
        )
      ),

      // 3. 用户身份感知卡片
      h('div', { className: 'dim-jh-doubao-card dim-jh-doubao-card-wide' },
        h('div', { className: 'dim-jh-doubao-cardHeader' },
          h('span', { className: 'dim-jh-doubao-cardTitle' }, '当前登录 UID 感知'),
          h('span', {
            className: `dim-jh-doubao-badge ${currentUser?.userId ? 'dim-jh-doubao-badge-blue' : 'dim-jh-doubao-badge-gray'}`,
          }, currentUser?.userId ? '已感知 UID' : '未登录 / 未探测到')
        ),
        h('div', { className: 'dim-jh-doubao-cardBody' },
          currentUser?.userId
            ? h('div', { className: 'dim-jh-doubao-uidBox' },
                h('div', { className: 'dim-jh-doubao-uidHero' },
                  h('span', { className: 'dim-jh-doubao-uidLabel' }, '当前登录 UID:'),
                  h('strong', { className: 'dim-jh-doubao-uidValue' }, currentUser.userId),
                  currentUser.enable !== false
                    ? h('span', { className: 'dim-jh-doubao-uidStatus dim-jh-doubao-badge-green' }, '有效')
                    : h('span', { className: 'dim-jh-doubao-uidStatus dim-jh-doubao-badge-gray' }, '已禁用')
                ),
                h('div', { className: 'dim-jh-doubao-uidMeta' },
                  currentUser.userActionTime
                    ? h('span', { className: 'dim-jh-hint' }, `最近活动版本 / 时间戳: ${currentUser.modifyVersion || '—'}`)
                    : null
                )
              )
            : h('div', { className: 'dim-jh-doubao-emptyUid' },
                h('p', null, status.installed
                  ? '本地客户端已安装，但当前尚未检测到有效登录 UID。'
                  : '未在系统中检测到豆包桌面客户端。'),
                h('p', { className: 'dim-jh-hint' }, '可点击下方「一键唤醒豆包客户端」登录账号，登录后点击「重新探测」即可感知。')
              ),

          // 多用户历史（若存在）
          allUsers.length > 1 ? h('div', { className: 'dim-jh-doubao-usersHistory' },
            h('span', { className: 'dim-jh-doubao-label' }, `历史/多账号列表 (${allUsers.length}): `),
            h('div', { className: 'dim-jh-doubao-usersTags' },
              allUsers.map((u) => h('span', {
                key: u.userId,
                className: `dim-jh-doubao-userTag ${u.userId === currentUser?.userId ? 'dim-jh-doubao-userTag-active' : ''}`,
                title: `UID: ${u.userId}${u.userId === currentUser?.userId ? ' (当前)' : ''}`,
              }, `${u.userId}${u.userId === currentUser?.userId ? ' ★' : ''}`))
            )
          ) : null
        )
      )
    ),

    // 控制操作区
    h('div', { className: 'dim-jh-doubao-actions' },
      h('button', {
        className: 'dim-jh-btn dim-jh-btn-primary dim-jh-doubao-launchBtn',
        disabled: launching,
        onClick: () => handleLaunch(),
      }, launching ? '正在唤醒...' : '一键唤醒豆包客户端'),

      h('button', {
        className: 'dim-jh-btn',
        disabled: loading,
        onClick: () => refreshStatus(true),
      }, loading ? '探测中...' : '重新探测状态'),

      h('button', {
        className: 'dim-jh-btn dim-jh-btn-text',
        onClick: () => setShowAdvanced(!showAdvanced),
      }, showAdvanced ? '收起高级设置' : '自定义唤醒协议')
    ),

    // 高级协议输入区
    showAdvanced ? h('div', { className: 'dim-jh-doubao-advanced' },
      h('div', { className: 'dim-jh-doubao-inputGroup' },
        h('label', { className: 'dim-jh-doubao-label' }, '唤醒 URL (需以 doubao:// 开头)：'),
        h('div', { className: 'dim-jh-doubao-inputRow' },
          h('input', {
            type: 'text',
            className: 'dim-jh-input dim-jh-doubao-urlInput',
            value: customUrl,
            onChange: (e) => setCustomUrl(e.target.value),
            placeholder: 'doubao://',
          }),
          h('button', {
            className: 'dim-jh-btn',
            disabled: launching || !customUrl.startsWith('doubao://'),
            onClick: () => handleLaunch(customUrl),
          }, '触发唤醒')
        )
      )
    ) : null
  );
}
