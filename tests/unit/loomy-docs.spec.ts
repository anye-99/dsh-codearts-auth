import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8')

/**
 * 文档回归：Loomy 的**特有差异**必须写进 README/AGENTS.md，
 * 否则后来者会按其余 7 个 provider 的直觉改坏它。
 */
describe('Loomy 文档覆盖', () => {
  const readme = read('../../README.md')
  const agents = read('../../AGENTS.md')

  it('README 提到 Loomy provider', () => {
    expect(readme).toMatch(/[Ll]oomy/)
  })

  it('README 写明「不能续期」这一独有差异', () => {
    expect(readme).toMatch(/Loomy[\s\S]{0,4000}?(不能|无法|没有).{0,12}续期/)
  })

  it('README 写明两套认证头（chat 用 Bearer、业务用 token）', () => {
    expect(readme).toMatch(/Bearer[\s\S]{0,600}?token/)
  })

  it('README 写明新手任务 10000 积分与「纯 API 直领」', () => {
    expect(readme).toMatch(/10000/)
    expect(readme).toMatch(/纯 API 直领/)
  })

  it('README 写明积分两池（永久 + 每日）', () => {
    expect(readme).toMatch(/永久积分/)
    expect(readme).toMatch(/每日赠送/)
  })

  it('README 写明生产域名（不再解释测试域名的来历）', () => {
    expect(readme).toContain('loomyad.xunfei.cn')
    expect(readme).toContain('account.xfinfr.com')
  })

  it('README 记录 e2e 探针命令', () => {
    expect(readme).toContain('pnpm test:e2e:loomy')
    expect(readme).toContain('pnpm test:e2e:loomy-chat')
  })

  /**
   * ⚠️ **用户要求**：以下四类内容**不得**出现在 README / AGENTS.md 的
   * **Loomy 章节**，只能放在**不入库**的 `docs/loomy-protocol-notes.md`：
   *
   * ① 排查脚本清单（`scripts/loomy-*`）
   * ② AccessKey 说明（具体值 / `accessKeyId` / `accessKeySecret`）
   * ③ 加密细节（`.env.prod`、解密口令、`env-file-crypto`、AES）
   * ④ `app.asar` 提取方式
   *
   * ⚠️ **必须限定在 Loomy 章节内**：AGENTS.md 的 **Qoder 章节**也提到
   * `app.asar`（既有内容，不在本次要求范围）。全文匹配会误伤它。
   */
  it('Loomy 章节不含脚本清单 / AccessKey / 加密细节（用户要求）', () => {
    // 截取 Loomy 章节（从标题到**下一个二级标题**为止）。
    // ⚠️ 两个文件的标题写法不同：README 是「## Loomy provider（讯飞办公助手）」，
    // AGENTS.md 是「## ⚠️ Loomy（讯飞）provider：…」。故用共同的锚点
    // `Loomy` + 各自标题行的特征，这里取**最后一个**含 `Loomy` 的二级标题。
    //
    // ⚠️ **必须以「下一个二级标题」为界，不能截到文件末尾** ——
    // 后续追加的 provider 章节（如 Raccoon）会落在同一文件的后半部分，
    // 截到末尾会把它们的正文一并纳入本用例的禁用词扫描，
    // 造成「Loomy 章节含 app.asar」这类**误报**
    // （Raccoon 章节合法地提到 `app.asar`，那是它自己的逆向取证方式）。
    const loomySectionOf = (text: string): string => {
      const matches = [...text.matchAll(/^## .*Loomy.*$/gm)]
      const last = matches.at(-1)
      if (last?.index === undefined) return ''
      const rest = text.slice(last.index + last[0].length)
      const next = /^## /m.exec(rest)
      return next?.index === undefined ? rest : rest.slice(0, next.index)
    }
    const readmeLoomy = loomySectionOf(readme)
    const agentsLoomy = loomySectionOf(agents)
    expect(readmeLoomy.length, 'README 未找到 Loomy 章节').toBeGreaterThan(0)
    expect(agentsLoomy.length, 'AGENTS.md 未找到 Loomy 章节').toBeGreaterThan(0)

    const forbidden: [string, RegExp][] = [
      ['脚本清单', /scripts\/loomy/],
      ['AccessKey 字段名', /accessKey(Id|Secret)/],
      ['加密细节 .env.prod', /\.env\.prod/],
      ['解密实现文件', /env-file-crypto/],
      ['AES 混淆细节', /AES[- ]?256|AES 混淆/],
      ['app.asar 提取', /app\.asar/],
      ['测试域名来历', /ossptest/],
    ]
    for (const [label, pattern] of forbidden) {
      expect(readmeLoomy, `README 的 Loomy 章节不应含「${label}」`).not.toMatch(pattern)
      expect(agentsLoomy, `AGENTS.md 的 Loomy 章节不应含「${label}」`).not.toMatch(pattern)
    }
  })

  it('不入库的协议文档确实存在且含这些细节', () => {
    // 细节被移到这里（该文件在 .gitignore 里，故用 readFileSync 直读磁盘）
    const notes = read('../../docs/loomy-protocol-notes.md')
    expect(notes).toContain('AccessKey')
    expect(notes).toContain('env-file-crypto')
    expect(notes).toContain('scripts/loomy')
  })

  it('AGENTS.md 记录 Loomy 的协议要点', () => {
    expect(agents).toMatch(/[Ll]oomy/)
    // 新手任务是纯 API 直领（与 workbuddy 的模拟真实行为相反）
    expect(agents).toMatch(/新手任务/)
  })

  it('AGENTS.md 写明两套头与不可续期', () => {
    expect(agents).toMatch(/两套认证头|两套头/)
    // 措辞可能微调，只要求「isLoomyRefreshable」与「false」同段出现
    expect(agents).toMatch(/isLoomyRefreshable[\s\S]{0,80}?false/)
    expect(agents).toMatch(/没有 refresh 端点/)
  })

  it('AGENTS.md 记录位置参数陷阱（避免下次再加 provider 时重犯）', () => {
    expect(agents).toMatch(/位置参数/)
    expect(agents).toContain('registerJetHubRpc')
  })

  it('AGENTS.md 概述行的 provider 数量与它自己列出的 id 一致', () => {
    // ⚠️ 原实现把「七个」这个字面量写死在断言里，于是**每加一个 provider 都要
    // 回来改这条用例** —— 与 `registerJetHubRpc` 的位置参数是同一类脆弱点。
    // 改成自校验：数出概述行里反引号包裹的 provider id 个数，与句中声称的
    // 中文数量词比对。这样它既能抓住「改了列表忘了改数字」，也能抓住
    // 「改了数字忘了改列表」，且新增 provider 时**无需修改本用例**。
    const line = agents.split('\n').find((l) => l.includes('LLM provider 路由'))
    expect(line, '找不到 AGENTS.md 的 provider 概述行').toBeDefined()
    // ⚠️ 数字与「个」之间**没有**空格（「九个」），空格在「个」之后。
    const stated = /([一二三四五六七八九十]+)个\s*LLM provider 路由/.exec(line!)
    expect(stated, '概述行未声明 provider 数量').not.toBeNull()
    /**
     * ⚠️ **只在「N 个 LLM provider 路由」这一句之内数 id**。
     *
     * 概述行句末可能出现**不计入 LLM 路由**的面板条目（历史上 `doubao` 曾一度
     * 如此登记），若整行计数就会把它们顶进数量词，得到与文档对错无关的假失败。
     * 截断到数量词之前，判别力不变：LLM 路由增删仍会让本用例红。
     */
    const llmClause = line!.slice(0, stated!.index)
    const ids = [...llmClause.matchAll(/`([a-z]+)`（/g)].map((m) => m[1])
    expect(ids.length, '概述行列出的 provider id 数量异常').toBeGreaterThan(0)
    /**
     * 中文数字 → 阿拉伯数字（支持 一..九十九）。
     *
     * ⚠️ **这里原来是一张 `一`..`十` 的平表**，于是从**第 11 个** provider 起
     * （zcode 之后），「十二」查表得 `undefined`，断言变成
     * `expected undefined to be 12` —— 一个与文档对错**无关**的假失败，
     * 而且它恰好在本文件自称「新增 provider 时无需修改本用例」的那条用例里。
     * 补成真正的解析器，而不是把表加到「十二」了事 —— 后者到 13 又会坏。
     * 判别力保持不变：写「十三」而列表只有 12 个时，本用例照样红。
     */
    const cnToNumber = (text: string): number | undefined => {
      const digits: Record<string, number> = {
        零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
      }
      if (!text.includes('十')) return digits[text]
      const [head, tail = ''] = text.split('十')
      const tens = head === '' ? 1 : digits[head]
      const ones = tail === '' ? 0 : digits[tail]
      if (tens === undefined || ones === undefined) return undefined
      return tens * 10 + ones
    }
    expect(
      cnToNumber(stated![1]!),
      `概述行声称 ${stated![1]} 个 provider，但实际列出了 ${ids.length} 个`,
    ).toBe(ids.length)
    // 中国版必须在列（它是本次新增的 provider）
    expect(ids).toContain('qodercn')
  })

  /**
   * ⚠️ **负载均衡策略必须写进文档**。
   *
   * 真实缺陷：Loomy **不会因积分耗尽而报错**（静默降级为扣永久积分），
   * 故既有「限流 → 换号」对它无效，会一直烧同一个号。
   */
  it('README 写明按余额优先选号的负载均衡策略', () => {
    expect(readme).toMatch(/负载均衡/)
    expect(readme).toMatch(/dailyBalance > 0/)
    expect(readme).toMatch(/permanentBalance > 0/)
    // 三个关键约定
    expect(readme).toMatch(/手动顺序/)
    expect(readme).toMatch(/60 秒/)
  })

  it('AGENTS.md 写明「Loomy 不会因积分耗尽报错」与三条不可改的约定', () => {
    expect(agents).toMatch(/静默降级/)
    expect(agents).toMatch(/getAvailableAccount/)
    // 档内保序 / 查询失败归最后一档 / 先过滤再分档
    expect(agents).toMatch(/档内保持手动拖拽顺序/)
    expect(agents).toMatch(/查询失败归最后一档/)
    expect(agents).toMatch(/未停用 \+ 该模型未受限/)
    // modelId 必须透传（原实现疏漏）
    expect(agents).toMatch(/modelId/)
  })
})
