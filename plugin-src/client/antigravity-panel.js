/**
 * Jet Hub 的 Antigravity 面板（第 14 个面板·**非凭据型**）。
 *
 * ## 与其他 13 个面板的一致性（UI 深度对齐方案）
 *
 * 账号动作（列表 / 增删 / 启停 / 排序 / 改名 / 刷新 / 重测 / 重置 / 登录发起 /
 * 登录轮询 / 供应商开关 / 模型开关 / 订阅额度）与其他面板走**同一套标准
 * Jet Hub 动词与布局结构**：
 * - 顶部使用统一的标准面板头（`dim-jh-panelHead`、`dim-jh-panelTitle` 与 `dim-jh-headerActions`）；
 * - 统一的操作按钮组，包含「显示列表」、「订阅额度」、「刷新」、「重测所有」、「重置所有」、「登录主账号」与「+ 新建账号」；
 * - 统一的内联状态通知条（`dim-jh-probeNotice`，带 `data-tone="ok" | "warn" | "error"`）；
 * - 统一的空状态占位（`dim-jh-empty`）与拖拽排序提示（`dim-jh-orderHint`）；
 * - 账号卡片复用共享 `AccountCard`（以 prop 注入，通过 `extra` 承载配额窗口与身份，通过 `extraActions` 承载专属操作）；
 * - 登录采用统一标准的弹窗交互（`dim-jh-modalOverlay` / `dim-jh-modal`），不在主界面常驻零散文本框。
 *
 * ## 2026-10-04 UI 深度对齐（与本文件头部「一致性」承诺的收尾）
 *
 * - **间距体系**：外层 `.dim-jh-agy` 从 grid gap 改为普通块流（见 jet-hub-styles.js
 *   的说明）—— 区块间距交给共享 margin（panelHead 16px / probeNotice 12px /
 *   settingsCard 12px），消除与其他面板不同的双重间距；
 * - **弹窗规格**：登录弹窗不再内联 520px 宽度与 modalActions 的 marginTop，
 *   直接复用共享 `.dim-jh-modal`（560px）与 `.dim-jh-modalActions`（14px），
 *   关闭按钮包进 `.dim-jh-modelPanelActions`，与模型列表 / 订阅额度 / 备份弹窗同构；
 * - **补齐缺失样式**：`dim-jh-hint` / `dim-jh-btn-sm` 此前被本面板使用但从未定义
 *   （说明文字没有弱化色、关闭按钮不缩小），现已在样式表补上；
 *   健康徽标补上缺失的 `disabled` 档配色。
 */

import * as React from 'react';

import {
  accountHealthOf,
  createAntigravityApi,
  normalizeQuotaRows,
  quotaPercentText,
  sharedCardOf,
} from './antigravity-api.js';

const h = React.createElement;

/**
 * 轮询间隔。
 *
 * `antigravity.status` 是毫秒级内存快照（不 spawn 子进程），5 秒既够面板
 * 反应冷却倒计时，也不会成为敲 agy 子进程的来源（慢探针只在用户显式点
 * 「刷新」时走 `antigravity.probe`）。
 */
const POLL_MS = 5000;

const HEALTH_LABEL = {
  healthy: '正常',
  cooldown: '冷却中',
  auth_required: '需重新登录',
  disabled: '已停用',
  unknown: '未知',
};

const FAMILY_LABEL = { google: 'Gemini', anthropic: 'Claude', openai: 'GPT' };

/**
 * 思考档位的中文展示名。
 *
 * ⚠️ 档位**值**必须原样用 `agy --effort` 的白名单（`low|medium|high|max`），
 * 只有展示名走这张表 —— 把中文发给 agy 会被拒。未知档位回退显示原值，
 * 不吞掉（agy 将来新增档位时界面立刻能选，不必等插件发版）。
 */
const EFFORT_LABEL = { low: '低', medium: '中', high: '高', max: '最大' };

/** ISO 时刻 → "约 N 小时后重置"。缺失或不可解析时返回 null（由调用方省略该段）。 */
function resetText(iso) {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const left = at - Date.now();
  if (left <= 0) return '已到重置时刻';
  const hours = Math.floor(left / 3_600_000);
  if (hours >= 24) return `约 ${Math.floor(hours / 24)} 天后重置`;
  if (hours >= 1) return `约 ${hours} 小时后重置`;
  return `约 ${Math.max(1, Math.round(left / 60_000))} 分钟后重置`;
}

/** 一个账号的配额区：每 family 一行，行内并排 5 小时窗口与本周窗口。 */
function AgyQuotaRows({ quotas }) {
  const rows = normalizeQuotaRows(quotas);
  if (rows.length === 0) {
    return h('div', { className: 'dim-jh-agy-quota dim-jh-agy-quota-empty' }, '配额未查询');
  }
  return h('div', { className: 'dim-jh-agy-quota' },
    rows.map(row => h('div', { key: row.family, className: 'dim-jh-agy-quotaRow' },
      h('span', { className: 'dim-jh-agy-quotaFamily' }, FAMILY_LABEL[row.family] ?? row.family),
      // ⚠️ 两个窗口是各自独立的量，不能合并成"取较小的那个"
      h('span', { className: 'dim-jh-agy-quotaItem', title: '5 小时滚动窗口剩余' },
        '5h ',
        h('span', { className: 'dim-jh-agy-quotaVal' }, quotaPercentText(row.remaining)),
        h('span', { className: 'dim-jh-hint' }, ` (${resetText(row.resetAt) ?? '—'})`),
      ),
      h('span', { className: 'dim-jh-agy-quotaItem', title: '本周窗口剩余' },
        '周 ',
        h('span', { className: 'dim-jh-agy-quotaVal' }, quotaPercentText(row.weekly)),
        h('span', { className: 'dim-jh-hint' }, ` (${resetText(row.weeklyResetAt) ?? '—'})`),
      ),
    )),
  );
}

/**
 * 共享卡片内部的 agy 专属区块（`AccountCard` 的 `extra` prop）。
 *
 * 包含健康徽标、email、代理以及家庭双窗口配额明细。
 */
function AgyCardExtra({ account, health }) {
  const isPrimary = account.isPrimary === true;
  const systemHome = account.systemHome === true;
  return h('div', { className: 'dim-jh-agy-extra' },
    h('div', { className: 'dim-jh-agy-cardHead' },
      isPrimary ? h('span', { className: 'dim-jh-tag dim-jh-tag-primary' }, '主账号') : null,
      systemHome ? h('span', {
        className: 'dim-jh-tag',
        title: '它用真实系统 HOME（凭据在系统钥匙串 / 凭据管理器里，不是隔离目录）',
      }, '系统 HOME') : null,
      h('span', { className: `dim-jh-agy-health dim-jh-agy-health-${health.status}` },
        HEALTH_LABEL[health.status] ?? health.status),
      health.message ? h('span', { className: 'dim-jh-hint' }, health.message) : null),
    account.email ? h('div', { className: 'dim-jh-hint' }, `账号邮箱：${account.email}`) : null,
    account.proxyUrl ? h('div', { className: 'dim-jh-hint', title: '换码 / 取 email / 配额查询走该代理' }, `代理配置：${account.proxyUrl}`) : null,
    h(AgyQuotaRows, { quotas: account.quotas }),
  );
}

/**
 * 授权与新建账号弹窗（规范标准模态窗）。
 */
function AgyLoginModal({ mode, api, auth, busy, act, onClose, onDone }) {
  const [alias, setAlias] = React.useState('');
  const [proxy, setProxy] = React.useState('');
  const [code, setCode] = React.useState('');
  const isPending = auth?.phase === 'waiting' || auth?.phase === 'exchanging' || auth?.phase === 'pending' || auth?.phase === 'submitting';
  const submitting = auth?.phase === 'exchanging' || auth?.phase === 'submitting';

  return h('div', {
    className: 'dim-jh-modalOverlay',
    role: 'dialog',
    'aria-modal': 'true',
    onClick: (e) => { if (e.target === e.currentTarget && !submitting) onClose(); },
  },
    // ⚠️ 不再内联 width —— 共享 .dim-jh-modal 已定义 min(560px, 100%)，
    // 与「模型列表 / 订阅额度 / 账号备份」等全部弹窗同宽（2026-10-04 对齐）。
    h('div', { className: 'dim-jh-modal' },
      h('div', { className: 'dim-jh-modalHead' },
        h('div', { className: 'dim-jh-modalTitle' },
          h('strong', null, isPending ? 'Google 账号授权中' : (mode === 'primary' ? '登录主账号' : '新建副账号')),
          h('span', { className: 'dim-jh-modalSubtitle' }, 'Antigravity (Google)'),
        ),
        // 头部动作包进共享容器 dim-jh-modelPanelActions（其他弹窗同款）。
        h('div', { className: 'dim-jh-modelPanelActions' },
          h('button', {
            className: 'dim-jh-btn dim-jh-btn-sm',
            disabled: submitting,
            onClick: onClose,
          }, '关闭'),
        ),
      ),
      h('div', { className: 'dim-jh-modalBody' },
        isPending
          ? h('div', { className: 'dim-jh-agy-login' },
              h('h4', null, submitting ? '正在用授权码完成登录…' : '请在浏览器里完成 Google 授权'),
              auth?.url
                ? h('p', null,
                    '浏览器应已自动打开授权页；若未自动打开，请',
                    h('a', { href: auth.url, target: '_blank', rel: 'noreferrer' }, '点此打开授权链接'),
                    '。授权完成后，若页面停在回调错误上，请将 URL 中的 ', h('code', null, 'code'), ' 参数值粘贴到下方。')
                : h('p', null, '正在等待授权链接…'),
              auth?.qrDataUrl ? h('img', { className: 'dim-jh-agy-qr', src: auth.qrDataUrl, alt: 'Antigravity 授权二维码' }) : null,
              h('div', { className: 'dim-jh-agy-loginRow' },
                h('input', {
                  className: 'dim-jh-agy-formInput',
                  value: code,
                  placeholder: '粘贴授权码（loopback 自动捕获成功时无需手动粘贴）',
                  disabled: submitting,
                  onChange: e => setCode(e.target.value),
                }),
                h('button', {
                  className: 'dim-jh-btn',
                  'data-kind': 'primary',
                  disabled: busy !== null || code.trim().length === 0,
                  onClick: () => void act('code', async () => {
                    const res = await api.loginSubmitCode(code.trim());
                    if (res.ok && res.data?.phase === 'done') onDone();
                    return res;
                  }, '登录完成'),
                }, busy === 'code' ? '提交中…' : '提交授权码'),
                h('button', {
                  className: 'dim-jh-btn',
                  disabled: busy !== null,
                  onClick: () => void act('cancel', () => api.loginCancel(), '已取消授权'),
                }, '取消'),
              ),
              h('p', { className: 'dim-jh-hint' }, '授权链接约 2 分钟后失效；若失效可取消后重新发起。'))
          : h('div', { className: 'dim-jh-agy-loginModal' },
              h('p', { className: 'dim-jh-hint' }, mode === 'primary'
                ? '在真实系统 HOME 登录 Google 账号。官方 agy 直接读取系统凭据管理器中的授权凭据。'
                : '新建一个隔离 HOME 的副账号并发起 Google 授权（用于账号轮转与耗尽自动切换）。'),
              mode === 'secondary'
                ? h('div', { className: 'dim-jh-agy-formGroup' },
                    h('label', { className: 'dim-jh-agy-formLabel' }, '账号别名（可选）'),
                    h('input', {
                      className: 'dim-jh-agy-formInput',
                      value: alias,
                      placeholder: '如 work、personal',
                      disabled: busy !== null,
                      onChange: e => setAlias(e.target.value),
                    }))
                : null,
              h('div', { className: 'dim-jh-agy-formGroup' },
                h('label', { className: 'dim-jh-agy-formLabel' }, '代理 URL（可选）'),
                h('input', {
                  className: 'dim-jh-agy-formInput',
                  value: proxy,
                  placeholder: '如 socks5://127.0.0.1:7890 或 http://127.0.0.1:7890',
                  disabled: busy !== null,
                  onChange: e => setProxy(e.target.value),
                })),
              h('div', { className: 'dim-jh-modalActions' },
                h('button', {
                  className: 'dim-jh-btn',
                  disabled: busy !== null,
                  onClick: onClose,
                }, '取消'),
                h('button', {
                  className: 'dim-jh-btn',
                  'data-kind': 'primary',
                  disabled: busy !== null,
                  onClick: () => void act(mode === 'primary' ? 'beginPrimary' : 'begin', async () => {
                    const res = mode === 'primary'
                      ? await api.loginBeginPrimary(proxy.trim() || undefined)
                      : await api.loginBegin(alias.trim() || undefined, proxy.trim() || undefined);
                    return res;
                  }, '已发起 Google 授权'),
                }, busy ? '正在发起…' : '开始 Google 授权'),
              ),
            ),
      ),
    ),
  );
}

/**
 * @param rpcCall jet-hub RPC 调用器。
 * @param AccountCard 共享账号卡片组件（由 `jet-hub.js` 注入 —— 该文件 import
 *   本文件，反向 import 会构成循环依赖）。
 * @param ModelListPanel 共享「显示列表」（模型黑名单开关，服务端已真实生效）。
 * @param SubscriptionQuotaPanel 共享「订阅额度」弹窗（agy 的 family 双窗走
 *   标准 `subscriptionQuota.get`）。
 */
export function AntigravityPanel({ rpcCall, AccountCard, ModelListPanel, SubscriptionQuotaPanel }) {
  // 一次创建即可：它只是 rpcCall 的薄封装，无内部状态。
  const api = React.useMemo(() => createAntigravityApi(rpcCall), [rpcCall]);

  const [status, setStatus] = React.useState(null);
  const [accounts, setAccounts] = React.useState([]);
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(null);
  const [probeNotice, setProbeNotice] = React.useState(null);
  const [auth, setAuth] = React.useState(null);
  const [loginModal, setLoginModal] = React.useState(null);
  const [showModels, setShowModels] = React.useState(false);
  const [showQuota, setShowQuota] = React.useState(false);
  const mounted = React.useRef(true);

  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  /**
   * 拉一次整体状态（毫秒级快照 + 账号列表）。
   */
  const refresh = React.useCallback(async () => {
    const [res, list] = await Promise.all([api.status(), api.accounts()]);
    if (!mounted.current) return;
    if (!res.ok) {
      setError(res.error || '读取 Antigravity 状态失败');
      return;
    }
    setError(null);
    setStatus(res.status);
    if (list.ok) setAccounts(list.accounts);
    const flow = res.status?.poolAuth;
    if (flow?.phase === 'waiting' || flow?.phase === 'exchanging') {
      setAuth(flow);
    } else if (flow?.phase === 'done' || flow?.phase === 'failed' || flow?.phase === 'idle') {
      setAuth(null);
    }
  }, [api]);

  React.useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  /**
   * 跑一个动作 → 设置标准通知 → 重读状态。
   */
  const act = React.useCallback(async (key, fn, okText) => {
    setBusy(key);
    setProbeNotice(null);
    try {
      const res = await fn();
      if (res?.ok === false) {
        setProbeNotice({
          tone: 'error',
          text: typeof res.error === 'string' ? res.error : (res?.error?.message || '操作未完成'),
          details: [],
        });
      } else if (okText) {
        setProbeNotice({ tone: 'ok', text: okText, details: [] });
      }
    } catch (caught) {
      setProbeNotice({ tone: 'error', text: caught?.message || String(caught), details: [] });
    } finally {
      setBusy(null);
      await refresh();
    }
  }, [refresh]);

  /**
   * 慢探针：真探登录态与模型目录。
   */
  const probeNow = React.useCallback(async () => {
    const res = await api.probe();
    if (!mounted.current) return res;
    if (res.ok) {
      const v = res.value ?? {};
      setStatus(prev => (prev ? {
        ...prev,
        auth: v.auth ?? prev.auth,
        catalog: v.catalog ?? prev.catalog,
        pool: v.pool ?? prev.pool,
      } : prev));
    }
    return res;
  }, [api]);

  /**
   * 拖拽排序（标准 `account.reorder`）。
   */
  const reorderTo = React.useCallback(async (draggedId, targetId, position) => {
    const ids = accounts.map(a => a.id);
    const from = ids.indexOf(draggedId);
    let to = ids.indexOf(targetId);
    if (from === -1 || to === -1 || from === to) return;
    const next = [...ids];
    next.splice(from, 1);
    to = next.indexOf(targetId);
    next.splice(position === 'after' ? to + 1 : to, 0, draggedId);
    await act('reorder', () => api.accountReorder(next), '已保存账号优先级顺序');
  }, [accounts, act, api]);

  const dragState = React.useRef({ dragging: null, target: null, position: 'before' });
  const [, setDragTick] = React.useState(0);
  const dragPropsFor = (account) => ({
    enabled: busy === null,
    isDragging: dragState.current.dragging === account.id,
    isDropTarget: dragState.current.target === account.id && dragState.current.dragging !== account.id,
    dropPosition: dragState.current.position,
    onDragStart: () => {
      dragState.current.dragging = account.id;
      setDragTick(t => t + 1);
    },
    onDragEnd: () => {
      dragState.current.dragging = null;
      dragState.current.target = null;
      setDragTick(t => t + 1);
    },
    onDragOver: (event) => {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      const position = event.clientY > rect.top + rect.height / 2 ? 'after' : 'before';
      if (dragState.current.target !== account.id || dragState.current.position !== position) {
        dragState.current.target = account.id;
        dragState.current.position = position;
        setDragTick(t => t + 1);
      }
    },
    onDrop: (event) => {
      event.preventDefault();
      const source = dragState.current.dragging;
      const position = dragState.current.position;
      dragState.current.dragging = null;
      dragState.current.target = null;
      setDragTick(t => t + 1);
      if (source && source !== account.id) void reorderTo(source, account.id, position);
    },
  });

  const pool = status?.pool ?? { accounts: [], mode: 'sequential' };
  const isPending = auth?.phase === 'waiting' || auth?.phase === 'exchanging' || auth?.phase === 'pending' || auth?.phase === 'submitting';

  // ── 首次读取中 / 失败态（保持统一的 panelHead + empty）──
  if (!status) {
    return h('section', { className: 'dim-jh-agy', 'aria-label': 'Antigravity (Google) 账号管理' },
      h('div', { className: 'dim-jh-panelHead' },
        h('h2', { className: 'dim-jh-panelTitle' }, 'Antigravity (Google) 账号管理'),
      ),
      h('div', { className: 'dim-jh-empty', role: error ? 'alert' : 'status' },
        h('p', null, error ? `读取失败：${error}` : '正在读取 Antigravity 状态…'),
        error ? h('button', { className: 'dim-jh-btn', onClick: refresh }, '重新读取') : null,
      ),
    );
  }

  return h('section', { className: 'dim-jh-agy', 'aria-label': 'Antigravity (Google) 账号管理' },
    // ── 1. 顶部标题与标准动作组（与其他 13 个模块完全一致）──
    h('div', { className: 'dim-jh-panelHead' },
      h('h2', { className: 'dim-jh-panelTitle' }, 'Antigravity (Google) 账号管理'),
      h('div', { className: 'dim-jh-headerActions' },
        h('button', {
          className: 'dim-jh-btn',
          title: '查看模型列表及开关状态',
          onClick: () => setShowModels(true),
        }, '显示列表'),
        h('button', {
          className: 'dim-jh-btn',
          title: '查看 Antigravity 官方配额窗口（google / anthropic / openai 各「5 小时滚动」与「本周」两个独立窗口，用掉百分之几）。数据来自账号池的最近一次配额查询。',
          onClick: () => setShowQuota(true),
        }, '订阅额度'),
        h('button', {
          className: 'dim-jh-btn',
          title: '真探登录态与模型目录（会 spawn 一次 agy；未登录时约需 15 秒）',
          disabled: busy !== null,
          onClick: () => void act('probe', probeNow, '已完成真实状态探测'),
        }, busy === 'probe' ? '探测中…' : '刷新'),
        h('button', {
          className: 'dim-jh-btn',
          title: '刷新全部账号的配额。⚠️ 这会绕过保守闸门：后台轮询自动跳过冷却中/待重登的账号，手动刷新不会 —— 请避免高频点击（风控暴露面）。',
          disabled: busy !== null || accounts.length === 0,
          onClick: () => void act('quotaAll', () => api.refreshQuota(), '已刷新全部账号配额'),
        }, busy === 'quotaAll' ? '刷新中…' : '重测所有'),
        h('button', {
          className: 'dim-jh-btn',
          title: '清除全部账号的限流冷却标记。用于「其实已经恢复但界面还在冷却」的情形。',
          disabled: busy !== null,
          onClick: () => void act('cdAll', () => api.clearCooldown(), '已清除全部冷却'),
        }, '重置所有'),
        h('button', {
          className: 'dim-jh-btn',
          title: '在真实系统 HOME 登录 Google 账号（官方 agy 直接认这份凭据）。浏览器会自动打开授权页；需要代理时可先配置代理。',
          disabled: busy !== null,
          onClick: () => setLoginModal('primary'),
        }, '登录主账号'),
        h('button', {
          className: 'dim-jh-btn',
          'data-kind': 'primary',
          title: '新建一个隔离 HOME 的副账号并发起 Google 授权（多账号轮转/耗尽切换用）。',
          disabled: busy !== null,
          onClick: () => setLoginModal('secondary'),
        }, '+ 新建账号'),
      ),
    ),

    // ── 2. 状态反馈与警示条（与 ProviderPanel 同款的 dim-jh-probeNotice）──
    probeNotice ? h('div', {
      className: 'dim-jh-probeNotice',
      'data-tone': probeNotice.tone,
      role: probeNotice.tone === 'error' ? 'alert' : 'status',
    },
      h('div', null, probeNotice.text),
      probeNotice.details?.length > 0
        ? h('ul', { className: 'dim-jh-probeDetails' },
            probeNotice.details.map((d, i) => h('li', { key: i }, d)))
        : null,
    ) : null,

    status.dormantReason ? h('div', {
      className: 'dim-jh-probeNotice',
      'data-tone': 'warn',
      role: 'alert',
    }, `⚠️ 服务休眠：${status.dormantReason}。修好它之前，登录与配额操作都会失败。`) : null,

    isPending && !loginModal ? h('div', {
      className: 'dim-jh-probeNotice',
      'data-tone': 'warn',
      role: 'alert',
    },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' } },
        h('span', null, auth?.phase === 'exchanging' ? '正在提交授权码完成登录…' : 'Google 账号授权正在进行中，请在浏览器中完成授权或粘贴授权码。'),
        h('div', { style: { display: 'flex', gap: '8px' } },
          h('button', { className: 'dim-jh-btn', 'data-kind': 'primary', onClick: () => setLoginModal('resume') }, '查看授权页 / 粘授权码'),
          h('button', { className: 'dim-jh-btn', onClick: () => void act('cancel', () => api.loginCancel(), '已取消授权') }, '取消'),
        ),
      ),
    ) : null,

    // ── 3. 系统运行时状态与池偏好设置卡片 ──
    h('div', { className: 'dim-jh-agy-settingsCard' },
      h('div', { className: 'dim-jh-agy-metaRow' },
        h('div', { className: 'dim-jh-agy-metaLeft' },
          h('span', { className: 'dim-jh-tag dim-jh-tag-primary' }, status.version ? `agy ${status.version}` : 'agy 版本未知'),
          status.bin ? h('span', { className: 'dim-jh-hint', title: status.bin }, `二进制 ${status.bin}`) : null,
          status.catalog?.count ? h('span', { className: 'dim-jh-hint' }, `模型目录 ${status.catalog.count} 个`) : null,
        ),
      ),
      h('div', { className: 'dim-jh-agy-controlsRow' },
        h('div', { className: 'dim-jh-agy-controlGroup' },
          h('span', { className: 'dim-jh-agy-controlLabel' }, '取号模式'),
          ['sequential', 'round-robin'].map(mode => h('button', {
            key: mode,
            className: 'dim-jh-btn',
            'data-active': pool.mode === mode ? 'true' : undefined,
            title: mode === 'sequential'
              ? '按 family 粘性用尽：一个账号把某家模型跑到受限，才换下一个'
              : '轮询：每次请求换下一个可用账号',
            disabled: busy !== null,
            onClick: () => void act(`mode-${mode}`, () => api.poolSetMode(mode),
              `已切换为${mode === 'sequential' ? '顺序耗尽' : '轮询'}`),
          }, mode === 'sequential' ? '顺序耗尽' : '轮询')),
        ),
        h('div', { className: 'dim-jh-agy-controlGroup' },
          h('span', { className: 'dim-jh-agy-controlLabel' }, '默认思考档位'),
          [{ id: '', label: '跟随模型默认' }].concat(
            (status.efforts ?? []).map(e => ({ id: e, label: EFFORT_LABEL[e] ?? e })),
          ).map(opt => h('button', {
            key: opt.id === '' ? '__auto' : opt.id,
            className: 'dim-jh-btn',
            'data-active': (status.defaultEffort ?? '') === opt.id ? 'true' : undefined,
            title: opt.id === ''
              ? '不覆盖：由适配器按 high → medium → low 的阶梯自动选（当前行为）'
              : `未在模型选择器里指定档位时，用 ${opt.label} 思考档发起请求。档位越高思考越久、通常越慢。`,
            disabled: busy !== null,
            onClick: () => void act(`effort-${opt.id || 'auto'}`,
              () => api.setDefaultEffort(opt.id),
              opt.id === '' ? '已改为跟随模型默认' : `默认档位已设为 ${opt.label}`),
          }, opt.label)),
        ),
      ),
    ),

    // ── 4. 账号列表（共享 AccountCard + extra 内联配额与专属操作）──
    accounts.length === 0
      ? h('div', { className: 'dim-jh-empty' },
          h('p', null, '尚未配置 Antigravity 账号'),
          h('p', null, '点击右上角「+ 新建账号」或「登录主账号」发起 Google 授权。'),
        )
      : h('div', null,
          accounts.length > 1
            ? h('p', { className: 'dim-jh-orderHint' },
                '拖动卡片可调整顺序（也可直接拖整张卡片）。顺序即自动选号与限流换号的优先级，排在前面的账号优先使用。')
            : null,
          h('div', { className: 'dim-jh-agy-cards' },
            accounts.map((account, index) => {
              const health = accountHealthOf(account);
              const hasIsolatedDir = typeof account.accountDir === 'string' && account.accountDir.length > 0;
              const shared = sharedCardOf(account, account.email || account.alias || account.id);
              shared.deleteBlocked = !hasIsolatedDir;
              shared.deleteBlockedTitle = '主账号槽位不可删除：它对应系统 HOME 的 agy 登录态。要退出登录请在终端跑 agy logout。';
              return h(AccountCard, {
                key: account.id,
                account: shared,
                index,
                order: index,
                provider: 'antigravity',
                busy: busy !== null,
                showCredits: false,
                showPackageList: false,
                windowDays: null,
                credits: null,
                creditsLoading: false,
                showRateLimitActions: true,
                onToggle: (id, enabled) => void act(`toggle-${id}`, () => api.accountToggle(id, enabled), enabled ? '已启用' : '已停用'),
                onDelete: (id) => {
                  const label = account.email || account.alias || account.id;
                  if (!window.confirm(`删除账号「${label}」？其隔离目录与其中的登录态会一并失效。`)) return;
                  void act(`del-${id}`, () => api.accountRemove(id), '已删除账号');
                },
                onRetest: (id) => void act(`retest-${id}`, () => api.refreshQuota(id), '已重测该账号配额'),
                onReset: (id) => void act(`reset-${id}`, () => api.clearCooldown(id), '已清除该账号冷却'),
                onRename: (id, current) => {
                  const next = window.prompt('新的显示名（别名）', current);
                  if (next === null || next.trim() === '') return;
                  void act(`rename-${id}`, () => api.accountRename(id, next.trim()), '已改名');
                },
                drag: dragPropsFor(account),
                extra: h(AgyCardExtra, { account, health }),
                extraActions: h(React.Fragment, null,
                  account.isPrimary ? null : h('button', {
                    className: 'dim-jh-btn',
                    disabled: busy !== null,
                    title: '设为主账号：主账号槽位骑在真实系统 HOME 上',
                    onClick: () => void act(`primary-${account.id}`, () => api.accountSetPrimary(account.id), '已设为主账号'),
                  }, '设为主账号'),
                  h('button', {
                    className: 'dim-jh-btn',
                    disabled: busy !== null || !hasIsolatedDir,
                    title: '在该账号的隔离 HOME 下开一个终端跑 agy（用于官方登录/切模型）',
                    onClick: () => void act(`term-${account.id}`, () => api.openTerminal(account.id), '已打开终端'),
                  }, '开终端'),
                ),
              });
            }),
          ),
        ),

    // ── 5. 模态窗口 ──
    loginModal ? h(AgyLoginModal, {
      mode: loginModal,
      api,
      auth,
      busy,
      act,
      onClose: () => setLoginModal(null),
      onDone: () => setLoginModal(null),
    }) : null,

    showModels ? h(ModelListPanel, {
      provider: 'antigravity',
      rpcCall,
      onClose: () => setShowModels(false),
    }) : null,

    showQuota ? h(SubscriptionQuotaPanel, {
      provider: 'antigravity',
      rpcCall,
      onClose: () => setShowQuota(false),
    }) : null,
  );
}
