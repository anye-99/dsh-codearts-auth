/**
 * 豆包客户端控制面的唯一出口（客户端侧）。
 *
 * 面板不得直写 `rpcCall('...')` 端点名，一律经由本模块。
 * 映射标准动词（`account.list` / `account.refresh`）与
 * 扩展动词（`doubao.status` / `doubao.probe` / `doubao.launch`）。
 */

/** provider id（与服务端 DOUBAO_PROVIDER_ID 一致）。 */
export const PROVIDER = 'doubao';

/**
 * 构造豆包面板使用的 API 实例。
 * @param {Function} rpcCall Jet Hub 注入的 RPC 调用函数
 */
export function createDoubaoApi(rpcCall) {
  if (typeof rpcCall !== 'function') {
    const dead = async () => ({ ok: false, error: 'rpc unavailable' });
    return {
      status: dead,
      probe: dead,
      launch: dead,
      accounts: dead,
      refresh: dead,
    };
  }

  const call = async (endpoint, payload) => {
    try {
      const value = await rpcCall(endpoint, payload ?? {});
      return { ok: true, value, data: value };
    } catch (caught) {
      return { ok: false, error: caught?.message || String(caught) };
    }
  };

  return {
    /** 毫秒级内存状态快照。 */
    async status() {
      const res = await call('doubao.status');
      if (!res.ok) return res;
      return { ok: true, status: res.value ?? {} };
    },

    /** 强制深度探测本地安装、文件与进程。 */
    async probe() {
      const res = await call('doubao.probe');
      if (!res.ok) return res;
      return { ok: true, status: res.value ?? {} };
    },

    /** 一键唤醒豆包客户端（可传特定 doubao:// 协议地址）。 */
    async launch(url) {
      const res = await call('doubao.launch', { url });
      if (!res.ok) return res;
      return { ok: true, result: res.value ?? {} };
    },

    /** 账号列表（标准动词 account.list）。 */
    async accounts() {
      const res = await call('account.list', { provider: PROVIDER });
      if (!res.ok) return res;
      return { ok: true, accounts: res.value?.accounts ?? [] };
    },

    /** 刷新状态与账号（标准动词 account.refresh）。 */
    async refresh() {
      const res = await call('account.refresh', { accountId: 'doubao-local', provider: PROVIDER });
      if (!res.ok) return res;
      return { ok: true, status: res.value?.status };
    },
  };
}
