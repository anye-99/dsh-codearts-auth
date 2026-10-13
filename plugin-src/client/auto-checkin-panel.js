/**
 * 「每日自动签到」状态条 —— **纯逻辑**（判定 + 文案），组件只做渲染。
 *
 * ## 为什么单独一个文件
 *
 * 本仓库的单测环境里**没有 react**（见 `tests/unit/provider-toggle.spec.ts`
 * 的说明）：组件只能做源码级断言，于是「该显示什么、什么颜色、失败该不该
 * 单列」这些**判定**必须住在可被真实调用的纯函数里。`jet-hub.js` 里那几行
 * 只负责把本文件的结果塞进 `React.createElement`，不承担任何判断。
 *
 * ## 与 host 的分工
 *
 * 数据来自 RPC `checkin.auto.get`（host 侧 `AutoCheckinStatusSnapshot`）。
 * 本文件**不**发起请求、也**不**决定要不要签到 —— 触发时机归 host
 * （「打开 DSH 时」，见 `src/auto-checkin.ts` 模块头），面板只读快照 + 写开关。
 *
 * ⚠️ 摘要里的四个计数直接用 host 下发的 `summary`，**不要**在这里把
 * `lastResults` 重算一遍：那会让「整渠道失败算几个失败」出现两份实现
 * （host 用 `summarizeChannels()`），迟早漂移成「面板说 0 失败、日志说 1 个」。
 */

/** 时间格式：`MM-DD HH:mm`（**本地时区**，与用户看时钟的习惯一致）。 */
export function formatAutoCheckinTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** provider id → 展示名；拿不到展示名时退回 id（而不是显示空白）。 */
function labelFor(labelOf, provider) {
  const label = typeof labelOf === 'function' ? labelOf(provider) : undefined;
  return typeof label === 'string' && label.length > 0 ? label : String(provider || '未知渠道');
}

/**
 * 生成状态条。
 *
 * @param {object|null|undefined} snapshot - `checkin.auto.get` 的返回。
 *   `null` / 非对象（尚未读回、读取失败、host 未装配）时返回 `null`
 *   —— 调用方据此**整条不渲染**：这是可选功能，读不到时不该在每次打开
 *   设置页都挂一条报错（与「对不支持的 provider 无条件发请求」那条历史教训
 *   同一取向）。
 * @param {(provider: string) => string} [labelOf] - provider id → 展示名。
 * @returns {{tone: string|undefined, text: string, notes: string[],
 *   toggleLabel: string, toggleTitle: string}|null}
 */
export function describeAutoCheckin(snapshot, labelOf) {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;

  const enabled = snapshot.enabled === true;
  const toggleLabel = enabled ? '关闭自动签到' : '开启自动签到';
  const toggleTitle = enabled
    ? '关闭后，打开 DSH 时不再自动签到（手动「一键签到」不受影响）。'
    : '开启后，每次打开 DSH 会自动签到全部支持签到的渠道（每天最多 3 次）。';

  if (!enabled) {
    return {
      // 关闭态用**中性**配色：它不是一个需要用户处理的问题。
      tone: undefined,
      text: '每日自动签到：已关闭 —— 打开 DSH 时不会自动签到（手动「一键签到」不受影响）。',
      notes: [],
      toggleLabel,
      toggleTitle,
    };
  }

  const runningText = snapshot.running === true ? '，正在签到…' : '';
  const at = formatAutoCheckinTime(snapshot.lastRunAt);
  if (at === '') {
    return {
      tone: undefined,
      text: `每日自动签到：已开启${runningText} —— 每次打开 DSH 会自动签到`
        + '全部支持签到的渠道。',
      notes: [],
      toggleLabel,
      toggleTitle,
    };
  }

  const summary = snapshot.summary && typeof snapshot.summary === 'object' ? snapshot.summary : {};
  const count = (key) => (typeof summary[key] === 'number' && Number.isFinite(summary[key])
    ? summary[key]
    : 0);
  const claimed = count('claimed');
  const totalCredit = count('totalCredit');
  const alreadyClaimed = count('alreadyClaimed');
  const inactive = count('inactive');
  const failed = count('failed');
  const succeeded = snapshot.succeeded === true;

  // 四个计数**全部**列出（不用 else-if 短路）：一个渠道可能同时有成功与失败
  // （多账号），只显示第一个非零项会让其余信息整条消失 —— 这正是既有
  // 「一键签到」提示曾经踩过的坑（用户只知道 A 已领，不知道 C 执行过）。
  const detail = `${claimed} 个新领取，${alreadyClaimed} 个今日已领，`
    + `${inactive} 个暂无活动，${failed} 个失败`;

  // 失败与「暂无活动」都必须**单列**：只给计数，用户与排查者都无从下手。
  const notes = [];
  const results = Array.isArray(snapshot.lastResults) ? snapshot.lastResults : [];
  for (const item of results) {
    if (item === null || typeof item !== 'object') continue;
    if (item.ok !== true) {
      notes.push(`${labelFor(labelOf, item.provider)}：${item.error || '执行失败'}`);
      continue;
    }
    const channel = item.summary;
    if (channel && channel.inactive > 0) {
      notes.push(
        `${labelFor(labelOf, item.provider)}：暂无活动`
        + '（多数活动每日 10:00（UTC+8）刷新，下次打开 DSH 会自动重试）',
      );
    }
  }

  // 当天次数用尽：必须说出来 —— 否则用户只会看到「今天怎么没签上」而无从解释。
  const attempts = typeof snapshot.attempts === 'number' ? snapshot.attempts : 0;
  const max = typeof snapshot.maxAttemptsPerDay === 'number' ? snapshot.maxAttemptsPerDay : 0;
  const exhausted = !succeeded && max > 0 && attempts >= max;
  const tail = exhausted
    ? `；今天已尝试 ${attempts}/${max} 次仍有失败，明天再自动重试`
    : succeeded
      ? '；当天已完成'
      : '；下次打开 DSH 会重试';

  // `storeKind === 'memory'` = 定位不到 DSH 数据目录（开关与记录重启即丢）。
  // 它必须显眼：用户会以为「设置好了」，而重启后一切归零。
  if (snapshot.storeKind === 'memory') {
    notes.unshift('⚠️ 无法定位 DSH 数据目录，开关与记录仅存于内存（重启后丢失）。');
  }

  return {
    tone: failed > 0 || exhausted ? 'warn' : succeeded ? 'ok' : undefined,
    text: `每日自动签到：已开启 · 上次 ${at} 共 +${totalCredit} 积分（${detail}）`
      + tail + runningText,
    notes,
    toggleLabel,
    toggleTitle,
  };
}
