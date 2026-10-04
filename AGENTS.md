# 项目指令：dsh-codearts-auth

## 语言约束

- **推理输出**（thinking / reasoning）一律使用中文。
- **正文输出**（正文回复、代码注释说明、总结、文档）一律使用中文。
- 代码标识符、关键字、类型名称、变量名等保持英文不变。

## 项目概述

本项目是 DeepSeek Harness 的一个插件（`dsh-codearts-auth`），提供华为云 CodeArts 浏览器登录与凭据管理功能。插件还附带 `buddy`（腾讯 CodeBuddy 中国版）、`workbuddy`（腾讯 WorkBuddy **国际版** / WorkBuddy AI）、`lobsterai`（有道 **LobsterAI** / 龙虾）、`qoder`（阿里系 **Qoder**）、`qodercn`（**Qoder 中国版**，与 `qoder` 同协议族、共用同一份 WASM）、`trae`（字节跳动 **TRAE**）、`cline`（**Cline** 桌面端 / Cline API）、`loomy`（讯飞 **Loomy** 办公助手）、`raccoon`（商汤 **Raccoon Work** / 小浣熊）、`minimax`（**MiniMax Code 中国版**，首个 **Anthropic Messages** 协议族）、`zcode`（智谱 **Z.Code** 免费额度通道）、`antigravity`（Google **Antigravity** / 官方 `agy` CLI 进程桥接，**非凭据型**）十二个 LLM provider 路由，另有 `doubao`（字节 **豆包** 桌面客户端联动，**非凭据型、非 LLM 路由**）。
<!-- 计数口径（2026-10-04 终态）：14 个面板 = codearts + 12 个 LLM 路由 + doubao（本地客户端面板）。
⚠️ 曾接入的 `vibex`（非 LLM 面板）与 `mimocode` 均已移除 —— 面板增删时必须回来改这一句，
且 `zcode-wiring.spec.ts` 的 `PROVIDERS` 计数断言（当前 14）与 `REF_PREFIX_TO_PROVIDER`
要成对核对。antigravity **是** LLM 路由（`registerAdapterIdempotent(ctx.llm, ['antigravity'])`），
故计入「十二个」，但它的**账号形态**与其余 11 家不同（非凭据型），见下文 Antigravity 维护要点。
⚠️ `antigravity` 与 `doubao` 是**仅有的两个不进** `REF_PREFIX_TO_PROVIDER` 的面板（都非凭据型，
补进去会在 `state.json` 丢失时造出指向空气的账号）；`jet-hub-store.spec.ts` 各有独立用例钉死。 -->

`buddy` 与 `workbuddy` 同源：共用同一 CLI 内核与同一认证协议，差异全部收敛在 `src/product.ts` 的产品配置中。关键差异是 **`endpoint`**：中国版为 `copilot.tencent.com`，国际版为 `www.workbuddy.ai`，两者返回不同模型池，因此 endpoint 必须随产品切换、不可当作全局常量。此外 `platform` 分别为 `ide` 与 `workbuddy-ai`，国际版登录 URL 还追加 `version` / `loginSessionId`。

`lobsterai` 与上述两者**完全不同源**：登录方式、请求头、续期载荷、签到流程、版本号来源都不一样，因此实现是独立一套 `src/lobsterai*.ts`。它只**共用架构模式**（产品配置驱动、账号池、限流切换、模型黑名单），**不共用 `BuddyProduct` 类型** —— 那里面 `apiDomain` / `productCode` / `attributionName` / `userAgentByModelFamily` / `appendSessionParams` 等字段对 LobsterAI 全部无意义。详见 README 的「LobsterAI provider」章节与 `docs/lobsterai-integration-plan.md`。

`qoder` 是**第五个、也是与其余四者都不同源**的协议族：**PKCE 设备码轮询**登录（不起本地监听端口）、续期请求体需带 **`machine_id`**、推理走**加密端点**（请求体由客户端内嵌 WASM 加密，响应套一层信封）。实现为独立一套 `src/qoder*.ts`（含 `qoder-wasm.ts` / `qoder-envelope.ts`），同样只共用架构模式。五个必须记住的点：

1. **两条推理路径认两套模型名，且 host 不同（最容易踩的坑）**：
   - **加密（本插件使用）**：`POST api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation`，请求体与签名头由 WASM 生成，**认模型目录 key**（`qfmodel` / `dmodel`）。
   - **公开**：`POST api2-v2.qoder.sh/model/v1/chat/completions`，**认通用名**（`qwen-flash` / `qwen-plus`），目录 key 一律 `Unsupported model`。
   ⚠️ `api2.qoder.sh` 与 `api2-v2.qoder.sh` **不是同一个 host**，混用 404。配置项见 `QoderProduct.inferBase` / `encryptedInferBase`。
   **真实缺陷**（用户报障）：「向 qwen3.8-flash 发消息后没收到回复就终止」—— 把目录 key 发给了公开端点；随后又误判为「目录 key 不可用」而把表换成通用名，结果拿到 Qwen3.5/2.5 而非 3.8 系列。
2. **加密推理用 `src/qoder-wasm.ts`**（复用客户端内嵌 WASM 生成加密体与签名头）。**不是「破解密码学」** —— WASM 自己导出了成对编解码函数，我们只是调用它。响应**无需解密**，只在每帧外套一层信封，由 `src/qoder-envelope.ts` 剥离。
   ⚠️ **签名头必须原样透传**，用普通 `Bearer <token>` 覆盖会被判签名无效。
   ⚠️ 改这个文件前先读 **不入库**的 `docs/qoder-encryption-notes.md`：里面有 glue 约定、请求体字段结构与三个已踩过的坑（写错会得到 Rust panic 或 `null pointer passed to rust`），重新实现代价很高。
3. **模型列表恒用静态表**（`src/qoder-product.ts` 的 `fallbackModels`）：远端 `GET /algo/api/v2/model/list` 需 **WASM 签名**，故 `listModels` **不发网络请求**。
   表里是**17 个目录 key**（全部可用），取自客户端下发的模型目录。
   ⚠️ **请求体必须带 `business` 字段**（`business: { type: 'agent' }`）—— 缺了服务端会把请求路由到**故障节点** `oa_qwen-plus-2025-04-28` 并返回 `[FAIL]node:... msg:Execution failed`。
   **真实缺陷**（2026-09-20 定位，极隐蔽）：`qfmodel`（Qwen3.8-Flash）因此「看起来不可用」，而**同一模型在 Qoder IDE 里完全正常**。
   ⚠️ **判据是「IDE 能否用同一模型」**：IDE 能用 → 是我们的请求缺东西，不是服务端故障。当时我错误地排除了 8 类假设（host / query / 明文体 / 模型配置字段 / 客户端版本 / 设备标识 / 会话类型 / 凭据字段），逐条记录见 `docs/qoder-encryption-notes.md` —— 别重复这条路。
   ⚠️ **其余模型恰好不受影响**，所以现象像「只有这一个模型坏」，极易误判为服务端故障。
   ⚠️ **展示名必须含模型名与版本，不能只写厂商**（用户报障：「看到的是 GLM、DeepSeek、MiniMax，只有厂商名字没有模型名字和版本」）。
   ⚠️ **改表必须逐个实发验证可推理**，不能只照抄目录 key。免费额度模型：`qmodel_38max` / `qfmodel`（e2e 探针默认用前者）。
   ⚠️ **错误帧必须能抛错**：Qoder 用独立 `event: error` 行 + 顶层 `{code,message,type}`，**不是** OpenAI 的 `{error:{message}}`。早期解析器只认后者 → 错误被静默当成「正常结束、无内容」，UI 表现为「干净地停止、无任何报错」。见 `src/openai-compat.ts` 的 `consumeOpenAiSse`。
4. **轮询的 `404` 表示「用户尚未完成授权」，必须继续轮询，不是错误**。实测依据：该端点返回 404 而任意不存在的路径返回 401，说明它被网关豁免认证、由业务层报「会话未就绪」。轮询 host 是 **`openapi.qoder.sh`**（`qoder.com` 的同名路径返回 401）。
5. **prod 的 `client_id` 是 `J_a`（`e883ade2-…`），不是 `G_a`**。源码 `client_id: i ? J_a : G_a`，而调用点 `loginWithDeviceFlow` 传的第 4 参是 **`isProd()`**（`$Oa(){return "prod"===db()}`）—— prod 为 `true` 故用 `J_a`；`G_a`（`e93fe488-…`）只在 daily/test 用。
   ⚠️ **真实缺陷**（用户报障）：初版把第 4 参误读成「useIdeClientId」，于是 prod 用了 `G_a`，GitHub 授权点击后页面报「**参数无效 / 你可以稍后前往 IDE 客户端并登录Qoder**」。根因是服务端在**授权回调阶段**才校验 client_id。
   ⚠️ **只靠入口 302 检查发现不了该错误**：`GET /device/selectAccounts` 对**任一** client_id（含全零 UUID）都返回 302。必须在源码层面核对第 4 参语义。见 `src/qoder-product.ts` 的 `clientId` / `testClientId` 字段注释。
6. **`options.tools` 必须真的下发到请求体顶层 `tools`，且工具历史要保留 `tool_calls` / `tool_call_id`**（**OpenAI 风格，不是 Anthropic 风格**）。
   客户端源码依据：`$Hc(A)` 把工具序列化成
   `{type:'function', function:{name, description?, parameters?}}`，写入请求体**顶层**
   `tools`（`A6e()`：`tools: o?.tools ?? []`）；assistant 的工具调用由 `t2c()` 转成
   `tool_calls:[{id, type:'function', index, function:{name, arguments}}]`；
   工具结果由 `A2c()` 产出 `{role:'tool', content, tool_call_id}`。
   ⚠️ **另有一条 Anthropic 风格分支**（`IOc()` 的 `input_schema` + `tool_use_id`），
   那是给 **Anthropic BYOK** 用的，加密端点**不吃那套** —— 别照它实现。
   ⚠️ **真实缺陷**（用户报障）：「使用本插件的 qoder 的 qwen3.8-flash，执行任务出现
   任务调用 xml 泄露任务终止」。两处根因：① `src/qoder-adapter.ts` **从不消费
   `options.tools`**（其余四个适配器都消费），`qoder-wasm.ts` 又把请求体的 `tools`
   **硬编码为 `[]`** → 模型在 wire 上拿不到任何函数 schema，只能用**正文里的 XML 文本**
   臆造工具调用，harness 认不出 → 任务终止；② 适配器的 history 过滤器写成
   「只留 `content` 为字符串的消息」，而 assistant 带工具调用时 `content` 是 **`null`**
   （OpenAI 规范）→ 整条被丢，且 `role:'tool'` 的 `tool_call_id` 也被丢 → 模型看不到
   自己调用过什么，反复重调同一工具或凭空编造结果（与 TRAE 那条同型缺陷一致）。
   ⚠️ **加密端点的请求体本地不可解**，无法靠抓包验证 —— 故把 payload 构造抽成纯函数
   `buildQoderInferPayload()`（`src/qoder-wasm.ts`），再由 `buildQoderTools()` /
   `buildQoderHistory()`（`src/qoder-adapter.ts`）单测锁死。
   排查脚本 `scripts/probe-qoder-tools.mjs`（只读，打印上述三个客户端函数的定义；
   ⚠️ 解码函数名与 XOR 密钥**随版本会变**，脚本会自行探测）。回归用例
   `tests/unit/qoder-tools.spec.ts`。

7. **图片必须走 `messages[].content` 的多模态数组，`chat_context.imageUrls` 是死的**
   —— **真实缺陷**（用户报障：「给 qodercn 的 qwen3.8-flash 发送图片，说没读到图片」）。
   ⚠️ 这不是配置问题，也不是「`imageUrls` 忘了填」：

   - 客户端官方实现 `Hyc()` **就把 `chat_context.imageUrls` 恒置 `null`**。
     obf 产物原文（`qoder-worker-runtime.obf.mjs`，明文可搜）：
     `function Hyc(A,e,t){return{text:A,features:[],extra:{…},chatPrompt:"",imageUrls:null}}`
     —— 我们 `src/qoder-wasm.ts` 里那行 `imageUrls: null` 是**忠实复刻，不是缺陷**。
     排查时**别再盯着这个字段**（我第一轮就盯错过）。
   - 图片的**正确通道是 `messages[].content` 的多模态数组**：客户端 `eQc()` 把
     `{type:'base64',media_type,data}` 转成
     `{type:'image_url',image_url:{url:'data:<media_type>;base64,<data>'}}`，
     `bJc()` 再转成 `{type:'input_image',…}`。
   - 真正的丢失点在 `buildQoderHistory`（`src/qoder-adapter.ts`）：它原先用
     `qoderContentText()` 把 content **压成纯文本**，而**上游
     `serializeMessages` 早已正确产出多模态数组** —— 图片是在这一跳被吃掉的。
   - 修法（`qoderContentParts()`）：**含图消息保留 content 数组**（逐字段只搬
     `type` / `text` / `image_url.url`（+ 可选 `detail`）），**纯文本仍输出字符串**
     （上游对字符串兼容性最好，且既有用例锁死了该形态）；
     判空必须把图片算作内容，否则「只发图不带字」的消息会被整条丢弃。
     ⚠️ 同时别忘了 `userText`（写进 `chat_context.text` / `originalContent`）：
     带图时 content 是数组，只判 `typeof === 'string'` 会让配文退化成空串。
   - ⚠️ **这是本文件第三个同型缺陷**（前两个：`tools` 不下发、工具历史丢
     `tool_calls`）—— 都是**序列化层没保留多模态结构**。改 Qoder 序列化时，
     把「tools / tool_calls / 图片」三者一起过一遍。
   - ⚠️ **两站同时受影响**：`qoder` 与 `qodercn` 共用同一个 `QoderAdapter` 类与
     同一个 `buildQoderHistory`，故国际版的图片此前同样是坏的（本次一并修好）。
   - 排查脚本 `scripts/probe-qoder-image-loss.mjs`（只读、离线、零额度：按
     `serializeMessages → buildQoderHistory → buildQoderInferPayload` 真实路径
     逐步打印，直接指出丢失点）。回归用例在 `tests/unit/qoder-tools.spec.ts`
     （5 条，含「纯图片消息不被丢弃」「纯文本仍输出字符串」「未知字段被剔除」）。
     ⚠️ 已做**反向验证**：让 `qoderContentParts` 恒返回 undefined（= 修复前行为）
     时其中 4 条会失败，故不是同义反复。

8. **排队错误（业务码 `10605`）必须识别、按服务端延迟等待，且与认证失败分开**
   —— **真实缺陷**（用户报障，2026-09-27）：国际版「排队 30 秒、5 次重试都没过」；
   中国版「一次重试就能成功却被当失败」。

   **四种 403 的语义互不相同，绝不能合并**（客户端 `rJc()` 就是分开映射的）：

   | 形态 | 判据 | 处理 |
   |---|---|---|
   | **排队** | 业务码 `10605`（客户端 `mRA`）→ `model_queued` | **内部按服务端延迟等待后重试**，不刷新凭据、不换账号 |
   | 认证失败 | 业务码 `105`（客户端 `MF`）→ `auth_error`，或 401 | 续期凭据后重试（**唯一**该走 refresh 的情形） |
   | 重复请求 | 客户端 `_TA="duplicate_request"` | 直接重发，**不**续期 |
   | 签名无效 | `Signature invalid (101)` | 见上文第 2 条（签名头被覆盖） |

   ⚠️ **排队信息藏在 `message` 里，且 `message` 是「一个 JSON 字符串」**：
   ```json
   {"code":"10605","message":"{\"isQueued\":true,…,\"retryAfterSeconds\":30,…}"}
   ```

   ⚠️⚠️ **排队有 TWO 种下发通道，第一版只修了一种（第二次回归，2026-09-27）**：

   | 通道 | 形态 | 识别位置 |
   |---|---|---|
   | **① HTTP 状态层** | HTTP **403** + 排队 JSON 体 | `qoder-adapter.ts` 的 `!response.ok && 401/403` 分支 |
   | **② SSE 流内** | HTTP **200** + 内嵌 `{code:"10605",…}` **帧** | `openai-compat.ts` 的 `consumeOpenAiSse` |

   用户第二次报障的症状（`重试延迟 7967ms` + `code=SERVER`）暴露了 ② 未被覆盖：
   `httpErrorCode(403)='AUTH'` 而日志里是 **`SERVER`** —— 后者**只能**来自 SSE
   消费器的三处 throw。**判据：错误码与状态码不一致时，去 SSE 层找。**
   会话证据：`~/.dsh/sessions/--D-jet-code-go-lilishop-go--/…/session.v4.jsonl.zstd`
   （用 `scripts/probe-qoder-queue-session.mjs` 解压检索，Node 内置
   `zstdDecompressSync`，Windows 无需装 zstd）。

   ⚠️ **修 SSE 通道时踩到的两个更深一层的坑**（都写进单测锁住了）：

   - **`unwrapQoderEnvelopeStream` 会「降级重组」错误帧**：它把内层
     `{code, message}` 转成 `{error:{message:"… (10605)"}}` —— **丢掉 `code`
     字段**并把后缀拼进 `message`。两个后果都极隐蔽：
     ① 下游排队识别（依赖顶层 `code === '10605'`）**永远不命中**；
     ② 后缀污染了 `message` 里那段**内层 JSON 字符串**，使二次解析失败 →
        拿不到 `retryAfterSeconds`，只能退回 1 秒兜底（写单测时实测到：
        期望 2000ms 实际 1000ms）。
     现在改为**保真转发** `{code?, message, type:'model_error'}`。
   - **`parseQueueError` 必须同时支持两种入参**：外层整体
     （`{code, message}`）**与内层消息**（`{isQueued:…}`，**没有 `code`**）。
     第一版要求「必须命中 `code`」，于是 SSE 路径传内层消息时被判 undefined
     —— 修复**静默失效**（探针显示 `sleep 次数 = 0`）。
     判据改为「命中 `code` **或**含排队标志」。
   - ⚠️ **瞬时排队是 `isQueued:false`**（`serviceAvailable:true, waitTime:0`）——
     用户报告「一次重试就能成功」正是这一形态。判据**不能要求
     `isQueued === true`**，否则它会落到 1 秒兜底而非服务端要求的 2 秒。
   - ⚠️ **网关形态（无 `code`，只有 `message` + `type`）也要认**：信封剥离后
     `statusCodeValue` 被吃掉，若只判 `statusCodeValue >= 400`，整帧会被
     **静默丢弃**（既识别不出排队、连报错都没有）。

   ⚠️ **两处等待逻辑必须共用同一实现**（`QoderAdapter.waitForQueue`）——
   否则会再次出现「只修了一条通道」的缺陷。

   ⚠️⚠️ **第三次回归（2026-09-27 13:15）：判据**不能**用顶层 `code` 当门禁**。
   用户贴出的后缀是 **`(403/model_error)`**，它由
   `[String(data.code), data.type].join('/')` 产出，据此反推消费器收到的帧：

   ```json
   { "code": 403,
     "message": "{\"code\":\"10605\",\"message\":\"{\\\"isQueued\\\":…}\"}",
     "type": "model_error" }
   ```

   **业务码嵌了两层**：顶层 `code` 是 **403**，`10605` 在 `message` 里。
   上一版写成 `if (isQueueBusinessCode(data.code))` —— 拿 403 比 10605
   **必然不命中**，于是又落到 `SERVER`（这就是「修了两次仍失败」的原因）。

   ✅ **正确判据：直接尝试 `parseQueueError(data.message)`**，用它是否返回
   信息来决定 —— 该函数递归遍历 `data`/`result`/`message`/`body` 并解析字符串，
   **嵌套几层都能穿透**，且不会误判（要求命中 `10605` 或出现排队标志）。
   ⚠️ 这个坑的教训具有普遍性：**外部错误体的嵌套深度不可假设**。
   用「先按某字段判门禁、再解析」的写法，一旦真实结构比预期深一层就静默失效；
   应让解析函数自己判定。

   ⚠️ **读用户给的后缀能直接定位抛错点**：本仓库错误消息的后缀是各分支自己拼的
   （`(10605)` = SSE 顶层 code 分支、`(403/model_error)` = 该分支的 `code/type`
   拼接、`(status=…)` = 网关分支）。**排障时先看后缀**，能省掉大量猜测 ——
   这次正是靠它一步定位到「顶层 `code` 是 403」。

   ⚠️ **延迟的取值优先序**（客户端 `kJa()`/`EV()`/`IRA()`）：
   `retry_after_ms` → `retryAfterMs` → `retryAfterSeconds × 1000`
   → 兜底 `Retry-After` 响应头（纯数字当**秒**，否则 HTTP 日期）。

   ⚠️ **用户定下的等待规则**（`qoderQueueDelayMs()`，**不要擅自改**）：
   - 服务端给的排队时间 **< 10 秒 → 按它的值**（如 2s → 等 2s，重试即成功）；
   - **≥ 10 秒 → 封顶 10 秒**（`QODER_QUEUE_MAX_DELAY_MS`）—— 避免一次阻塞
     30 秒让 UI 长期停在「运行中」且无法区分「排队」与「卡死」；
   - **最多 180 次**（`QODER_QUEUE_MAX_ATTEMPTS`，与 CodeArts 惯例一致）
     → 10s × 180 = 最长 30 分钟；总时长可用 `DSH_QODER_QUEUE_TIMEOUT_MS` 覆盖。
   - ⚠️ **超时判定必须先于次数判定**：反过来写会让「180 次空转」在绝大多数情况下
     先生效，使 `DSH_QODER_QUEUE_TIMEOUT_MS` **形同虚设**（写用例时实测到了）。
   - ⚠️ **该环境变量不能写成 `parseInt(…) || 默认值`**：`0` 是合法值（表示「不等」，
     单测靠它验证开关），而 `0` 是 falsy 会被 `||` 静默换成 30 分钟。

   ⚠️ **为什么不用 harness 的 `retryPolicy`**：它的 `DEFAULT_RETRYABLE_CODES` 是
   `[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]` **不含 `QUEUE`/`AUTH`**，
   且它的退避是**固定参数**（`initialDelayMs=500`、`maxDelayMs=10_000`、
   `maxRetries=5`），**没有 per-error「服务端指定延迟」的通道** ——
   500/1000/2000/4000/8000 共约 15.5 秒，永远等不到服务端要的 30 秒。
   故排队必须在**适配器内部**自己等（与 CodeArts 的 `QUEUE_RETRY_DELAY_MS` 同思路，
   但延迟**来自服务端**而非固定 10 秒）。

   ⚠️ **两站同时受益**：`qoder` 与 `qodercn` 共用同一个 `QoderAdapter`。

   排查脚本 `scripts/probe-qoder-queue-error.mjs`（只读、离线：按客户端算法
   解析两种真实错误并打印该等多久）。回归用例在 `tests/unit/qoder-adapter.spec.ts`
   的「排队错误（10605 model_queued）」段（16 条：纯函数解析/换算 + stream 行为，
   含「瞬时排队等 2s 即成功且**不刷新凭据**」「30s 压到 10s」「超上限抛错」
   「认证失败不误判为排队」）。sleep 可注入，全部毫秒级完成。
   ⚠️ 已做**反向验证**：把封顶改回 30s → 3 条失败；去掉二次解析 → 6 条失败。

9. **额度用尽（业务码 `110` `Billing daily count exceeded`）必须归为**
   **不可重试**，不能落在 `SERVER` —— **真实缺陷**（用户报障 2026-09-27，
   排队修好后继续自动执行目标时出现）：

   ```
   重试延迟：7220毫秒
   失败原因：qoder: Billing daily count exceeded (110/model_error)
   ```

   ⚠️ 后缀 **`(110/model_error)`** 与排队那次那个 `(403/model_error)` **同源**
   （都由「顶层 code + message」分支的 `[code, type].join('/')` 产出），
   即帧是 `{code:110, message:"Billing daily count exceeded", type:'model_error'}`。
   它原先归 **`SERVER`**，而 `SERVER` **在** harness 的 `DEFAULT_RETRYABLE_CODES`
   （`[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]`）里 ——
   于是「**今日额度已用尽**」这种**确定性**错误被**白重试 5 次**
   （500/1000/2000/4000/8000 ≈ 15.5 秒；用户看到的 `7220毫秒` 就是其中一步）。

   ⚠️ **这与排队是同一个病根**：**用错误码的默认归类代替了对业务语义的判断**。

   **客户端权威依据**（obf 产物原文，`scripts/probe-qoder-code-110b.mjs` 可复现）：
   ```js
   function vpt(e){
     let t = e === "authentication_failed" || e === "billing_error" ? "permission"
           : e === "rate_limit"      ? "rate_limited"
           : e === "invalid_request" ? "invalid_request"
           : "unavailable";
     return new Tt(t, `Qoder assistant failed: ${e}`)
   }
   ```
   **`billing_error` → `permission`（不可重试）**，与 **`rate_limit` →
   `rate_limited`（可重试）明确分开**。

   ⚠️ **语义差异是本质的**（两者的处理**必须不同**）：
   | | 排队 `10605` | 额度 `110` |
   |---|---|---|
   | 语义 | **暂时**受阻（等待可通过） | **当天耗尽**（等到明天） |
   | 客户端归类 | `rate_limited`（可重试） | `permission`（**不重试**） |
   | 我们的处理 | 内部按服务端延迟等待 | **立即失败**（抛 `QUOTA_EXCEEDED`） |

   ⇒ 实现：两条错误分支（顶层 `code` / 网关形态）都判
   `isBillingBusinessCode(data.code) || looksLikeBillingError(data.message)`
   → 抛 **`QUOTA_EXCEEDED`**。

   ⚠️ **必须带文案兜底**（`looksLikeBillingError`）：`110` 这个**码值在本地产物里
   没有硬编码**（探针搜 `X="110"` 与 `daily count exceeded` 均未命中），
   说明它由**服务端**下发 —— 若上游改用别的码值表达同一语义，只认码会漏判。
   ⚠️ 兜底关键词必须**窄**（只认 `billing daily count exceeded` /
   `daily count exceeded` / `billing_error`）：`balance` / `quota` 之类泛词会
   误伤正常内容（模型正文里恰好讨论「余额」就会被误判为额度错误）。

   ⚠️ **`QUOTA_EXCEEDED` 是既有惯例**（`buddy-adapter.ts` / `cline-adapter.ts` 同用），
   且**不在** harness 的可重试集合里 —— 这正是我们要的「立即失败」。
   验证脚本 `scripts/probe-dsh-retry-codes.mjs`（只读 harness 策略文件，断言
   `SERVER` 在集合中、`QUOTA_EXCEEDED` 与 `QUEUE` 不在）。

   回归用例在 `tests/unit/qoder-adapter.spec.ts` 的
   「额度用尽（110 billing）归为不可重试」段（3 条：SSE 帧的 110 抛
   `QUOTA_EXCEEDED` 且**不等待**、字符串 `"110"` 同样识别、
   客户端映射 `billing→permission ≠ rate_limit` 被锁死防被改回 `SERVER`）。
   ⚠️ 已做**反向验证**：移除该识别 → 2 条变红；还原后全绿。

   ⚠️⚠️ **额度受限还要「标记 + 切账号」**（用户要求，2026-09-27）：
   > qoder 碰到当日额度受限应该像 workbuddy/codebuddy 一样，设置一个模型受限时间
   > （他们是返回错误中带时间，qoder 和 qodercn **需要自己设置当日 24:00 受限**）
   > 然后切换账号池中的下一个可用模型

   **与 buddy/CodeArts 的关键差异**：它们的错误文案里**带重置时间**
   （`parseRateLimitError` 从中解析）；Qoder **不带** —— 故用
   `nextUtc8DayStartMs()` **自己算「UTC+8 当日 24:00」**。
   ⚠️ **不能复用 `parseRateLimitError`**：它解析不到时间时会退回「1 小时后」
   （`Date.now() + 3_600_000`），那对**按自然日**结算的额度是错的 ——
   标记会过早失效，用户 1 小时后再撞一次同样的墙。

   ⚠️ **时区必须写死 UTC+8**（`QODER_BILLING_UTC_OFFSET_MS`），**不取本机时区**：
   额度是**服务端**按自己的账期结算的。服务端其他每日语义已实测为 UTC+8
   （每日领取活动原文即「每日 10:00（UTC+8）刷新」）。取本机时区会在用户出差/
   改系统时区时算出**错的解禁时刻**：偏东则标记过早失效，偏西则白等几小时。
   ⚠️ 用**算术**而非 `Date.setHours`：后者按**本机时区**运算，在非 UTC+8 的机器上
   会得到错的时间。

   ⚠️ **只标记该模型**（`modelRateLimits[modelId]`），不标记账号全部模型：
   额度是「模型 + 账号」维度的，该账号在别的模型上仍可能可用。

   ⚠️⚠️ **切号时必须传 `tried` 集合给 `getAvailableAccount`**：池按「限流重置
   时间最早到期」排序，**刚失败的账号可能仍排第一**，不排除就会拿回同一个账号、
   命中 `tried.has` 而**立即放弃切换**（与 `buddy-adapter.ts` 的同款注释同因）。
   ⚠️ `tried` 必须**跨重试保留**（不能在每次迭代里新建），否则会在两个账号之间
   **无限来回**。

   ⚠️⚠️ **标记用的「当前账号」必须是局部可变状态，不能每次问
   `options.currentAccountId()` 回调**：那个回调返回「池当前的默认账号」，
   一旦切到下一个账号它**不会跟着变** —— 若用它标记，切到 B 后失败时会
   **再标记一次 A**，而 B 从未被标记，下次取号又把 B 选中，于是在 A/B 之间
   **反复空转**。写单测时实测到了这一点（标记记录是 `['acct-A','acct-A']`
   而非 `['acct-A','acct-B']`）。
   ⇒ 实现上 `activeAccountId` 是 `stream()` 里的局部变量，切号后与 `credential`
   一同更新；`options.currentAccountId` 只用于**首次**确定起点。
   ⚠️ 回调本身由 `index.ts` 的 `activeQoderAccountId`（`Map<providerId, accountId>`）
   提供 —— 在 `resolveCredential` 里记录**实际返回的那个账号**，因为池的选号是
   即时决策，与适配器本次拿到的凭据可能是两个账号（标错会误伤无辜账号）。

   ⚠️ **两处都要接**（HTTP 层 + SSE 层），且调用**同一个**
   `switchAccountOnQuota()`：Qoder 的额度错误实测走 SSE（HTTP 200），
   但若哪天改成 HTTP 状态码下发，只处理一条就会漏。

   回归用例在 `tests/unit/qoder-adapter.spec.ts` 的
   「额度受限：标记当日 24:00 + 切换账号」段（8 条：4 条日界纯函数 + 4 条行为，
   后者用桩账号池断言「标记了哪个账号/哪个模型/什么时间」「取号时传了 tried」
   「切到新账号后重发」「全部受限时如实抛错不无限切」）。
   ⚠️ 已做**反向验证**：日界改用非 UTC+8 → 4 条变红；不传 `tried` → 2 条变红。


⚠️ **`src/qoder-auth-wasm.wasm`（298 KB）随插件分发**，构建时由 `scripts/copy-assets.mjs` 复制到 `lib/`（`tsc` 不搬 `.wasm`）。`build:all` 已含该步骤。

⚠️ **WASM 提取自 Qoder `0.3.4`**（runtime `1.1.57`）。升级方式：

```
pnpm qoder:wasm            # 自动取 .qoder-versions 下版本号最高的
pnpm qoder:wasm 0.3.5      # 指定版本
pnpm build:assets          # 同步到 lib/
```

取 `.qoder-versions/<v>` 而非 `resources/` —— 后者可能是与 IDE **实际运行**不同的版本
（实测 IDE 跑 0.3.4）。刷新后**必须实测一次对话**（`qfmodel` / `qmodel_38max`）确认签名仍被接受。

它**积分余额与每日领取都有**（能力矩阵登记为 `{balance:true, dailyCheckin:true}`），并复用 `src/openai-compat.ts` 的 OpenAI 协议层共享实现（消息序列化 / SSE 消费 / 错误归类）。详见 README 的「Qoder provider」章节与 `docs/superpowers/specs/2026-09-19-qoder-provider-design.md`。

### ⚠️ Qoder **中国版**（`qodercn`）：同协议、异配置，五个必须记住的点

中国版与国际版**共用同一套 `src/qoder*.ts` 实现**（含**同一份 WASM**），差异全在
`src/qoder-product.ts` 的 `QODER_CN`；服务端 `src/jet-hub-rpc.ts` 里四处 Qoder 分支
通过 `qoderFamily` 注册表分派，两个产品共用同一组回调。
新增同族产品时**不要复制实现文件** —— 那会让上面记着的每一处缺陷修两遍。
取证见 `docs/superpowers/specs/2026-09-27-qodercn-provider-design.md`（证据编号 E1–E13）。

1. **`client_id` 与国际版不同，且不能靠探测验证**：CN 是
   `732aef47-9cf2-46a2-95fe-4cebb5d0d1fa`（取自 CN asar 的 `Vpe.authClientIds.prod`），
   国际版两个 id 在 CN asar 里**命中 0 次**。CN 的 `prod` 与 `test` **同值**，
   所以不存在国际版 `J_a`/`G_a` 读反的那类风险 —— 但**入口 302 依然不能证明
   id 正确**（对任一 client_id 都回 302），必须真实登录闭环。
   ✅ 已实测通过（2026-09-27，`scripts/verify-qodercn-live.mjs`）：授权成功，
   拿到 uid `01a0df0a-…`（与本机 `~/.qoder-cn/.models/` 目录名一致，交叉印证）。
2. **模型表不能沿用国际版**：CN 是 **14 条**，独有 `q37fmodel`(Qwen3.7-Flash) /
   `gm51model`(GLM-5.2)，**没有** `ultimate` / `performance` / `efficient` /
   `smodel` / `cmodel` 五条（沿用会让菜单出现 5 个 CN 端点根本不认的模型）；
   另有 5 条 `max_input_tokens` 不同、4 条思考标记不同、
   `mmodel` 在 CN 是 **MiniMax-M2.7** 不是 M3 且 `is_vl` 为 false。
   ⚠️ **但那 5 条「上下文窗口不同」是假差异 —— 已推翻**（2026-09-27 实测）。
   见下方第 2.1 条：`contextWindow` 要取 `context_config` 档位表的最大档，
   两个版本的档位表**几乎相同**（除 `mmodel` 外都是 `{200K, 400K, 1M}`）。
   ⚠️ 改表同样必须逐个实发验证，且 `qoder-product.spec.ts` 对 CN 有**逐条数值断言**。
   ⚠️ CN 目录条目的标识字段名是 **`key`**，国际版是 `model_key` —— 重新采集时
   两个名字都要认（`scripts/probe-qodercn-catalog.mjs` 已如此实现），
   否则会得到「0 个模型」的**假阴性**（首跑真踩过）。

### 2.1 ⚠️ 上下文窗口必须取 `context_config` 档位表，**不要**取 `max_input_tokens`

**用户报障**：Qoder 的上下文窗口「显示得比官方小很多」（CN `dmodel` 只有 96K）。

**根因**：目录里两个字段会自相矛盾 —— CN `dmodel` 的 `max_input_tokens` 是 **96000**，
但 `context_config` 档位表是 `{200K, 400K, 1M}`。旧表照抄了前者。

**官方客户端只认后者**（asar 证据，`qoder-worker-runtime.obf.mjs`）：

```js
function zX(A,e){let t=jiA(e);if(void 0===t)return!1;
  let i=Yai(A);if(i)return i.includes(t);          // ← 档位表存在就只查成员资格
  let n=jiA(A?.max_input_tokens??A?.maxInputTokens);return void 0===n||t<=n}  // ← 兜底分支
```

`isContextWindowSupportedByModel()` → `zX()`：**只要档位表存在，`max_input_tokens`
那条分支根本不执行**。`max_input_tokens` 仅在「模型没有档位表」时才作兜底
（`Mz()` 的默认值还是 1048576）。故它**不是**「这个模型只能吃这么多」的声明。

**实测**（2026-09-27，CN 加密端点，`scripts/probe-qoder-context-needle.mjs`；
针埋在提示**正中间**，命中即证明未被截断）：

| 事实 | 证据 |
|---|---|
| `max_input_tokens` **不构成**服务端约束 | 声明 96K 的 `dmodel` 完整收下 **852,951** |
| `parameters.context_length` **也不构成**约束 | 同一 400K 提示，声明 180K / 200K / 1M / **不发该字段** —— 四种都完整送达（`prompt_tokens` 一致） |
| ⚠️ 真实上限**因模型而异**，**不是**网关统一值 | `dfmodel` 通过到 **999,991**；`qfmodel` 通过到 **983,490**、990,000 越界且**服务端明确回** `Range of input length should be [1, 983616]` |
| `983,616`（`1M − 16K`）**只对报了它的模型成立** | `dfmodel` 实测 999,991 > 983,616，已证伪「全局上限」。引用时必须说明适用范围 |

**逐模型实测记录**（用户 2026-09-27 据此定表）：

| 模型 | 实测通过（目标 tokens） | 服务端实际计入 | 越界点 | 越界错误形态 | 表里填 |
|---|---|---|---|---|---|
| `dfmodel` | 938,000 | **999,991** | 939,000 起 | `Internal Server Error` | **1M** |
| `qfmodel` | 984,000 | **983,490** | 990,000 | 参数错误 + `Range … [1, 983616]` | **1M** |
| `dmodel` | 800,000 | **852,951** | 985,000 | `Internal Server Error`（**无区间**） | **1M** |

⚠️ **`dmodel` 的实测只到 852,951，却仍填 1M —— 这是有意的**，别当成笔误：
口径是「**档位表有 1M 档就填 1M**」（用户 2026-09-27 定）。它的天花板确实未探明
（985,000 越界后只回 `Internal Server Error`，**不像 `qfmodel` 那样给出区间**，
无法反推真限），但 1M × 0.8 = **800K** 的压缩阈值**低于 852,951 这个已证安全点**，
故 1M 在 DSH 侧安全。⚠️ **不要因为"实测没到 1M"就把它改小**（改小会让 DSH
远早于官方能力触发压缩，正是本次要修的缺陷）。
⚠️ 其余 CN 模型（`qmodel` / `gmodel` / `kmodel` 等 9 条）**未逐个探顶**，
沿用档位表最大档 1M。

**所以取值口径（用户 2026-09-27 定）**：**档位表有 1M 档就填 1M**。

- `qfmodel` / `dfmodel` / `dmodel` 等档位表含 1M 档者 → **1M**
  （前两条实测逼近 1M；`dmodel` 依据档位表 + 800K 阈值安全）；
- **其余未逐个探顶**者（`qmodel` / `gmodel` / `kmodel` 等 9 条）沿用档位表最大档 **1M**；
- `mmodel` 档位表**只有 200K 一档** → **200K**；`auto` 无档位表 → **200K**。

**取证脚本**（均可离线跑）：`scripts/probe-qoder-windows.mjs` 打印每个模型的
档位表与 `max_input_tokens` 对照；`scripts/probe-qoder-context-limits.mjs`
用一次越界请求逼出服务端硬上限（⚠️ 只对**回区间**的模型有效，回
`Internal Server Error` 的探不出来）；`scripts/verify-qoder-context-fix.mjs`
把兜底表与目录档位表逐条对账。

⚠️ **改了本表必须重跑**这些脚本对照，不要凭印象填。

### 2.2 ⚠️ 思考档位：此前**根本没声明**，现已按远端目录给出

**用户报障**：「qoder中国版可以设置思考档位，我们应该按照他的设置给出可设置的
档位选择」。根因是 `QoderAdapter.resolveModel()` **只声明 `context`，从不声明
`reasoning`** —— DSH 的思考强度选择器**只会**从 `resolveModel().reasoning` 渲染
（`dsh-client-ui-model-selection`：`reasoning === undefined ? [] : …reasoning.efforts`），
所以两个站点的档位选择器**从来没有出现过**，尽管目录早就下发了 `thinking_config`。

**远端确实给了**（三个站的截图与 5 个账号的 catalog 逐条吻合）。**取值口径四条**：

| 项 | 来源 | 规则 |
|---|---|---|
| `efforts` | 目录 `thinking_config.enabled.efforts` 的**键** | 按目录原序（客户端也按键序渲染） |
| `defaultEffort` | 该对象里 `is_default: true` 的键 | **必须落在 `efforts` 内**，否则不发 |
| `supportsDisable` | 目录存在 `thinking_config.disabled` 分支 | 为真时**追加** `none`（复刻客户端 `gU()`） |
| `contextWindow` | `context_config` 最大档 | 见 2.1 节 |

⚠️ **「关闭思考」不在 `efforts` 数组里，靠 `supportsDisable` 表达**。客户端是在
`gU()` 里追加的：`… || e.includes("none") ? e : [...e,"none"]`。两者是**独立维度** ——
实测 `gfmodel`/`gmodel`/`kmodel`/`smodel`/`cmodel` **有档位但不能关闭**（无 `disabled`
分支），而 CN 的 `qmodel`/`qmodel_latest` **没有档位但能关闭**。**不要**用一个标志表达两件事。

⚠️ **展示名必须用官方中文**（否则与 IDE 不一致）。权威来源是 **IDE 自己的 i18n**
（asar `settings.efforts`，`scripts/probe-qoder-effort-i18n2.mjs` 可取）：
```
none:关闭思考  minimal:最小  low:低  medium:中  high:高  xhigh:极高  max:最大
```
DSH 的档位选择器**直接渲染 `efforts[].name`**（不本地化、不查字典），故给中文即中文界面。

⚠️ **档位值必须在白名单内**，否则会被客户端**静默丢弃**。asar 常量：
- 白名单 `Qj = ['none','low','medium','high','xhigh','max']`；
- 别名 `_lc = { disabled: 'none', off: 'none' }`；
- 归一化器 `ao()`：先查别名，再看白名单，都不在则丢弃。

⚠️⚠️ **`qmodel` / `qmodel_latest` 只有「关闭思考」一项 —— 这是远端事实，不是遗漏**。
它们的 `thinking_config.enabled` **没有 `efforts` 键**，只有 `description` + `is_default`：
```json
{"disabled":{"description":"Disable thinking"},
 "enabled":{"description":"Enable thinking","is_default":true}}
```
用户 2026-09-28 明确：「上面两个没有思考档位就是关闭的意思」。
**不要**给它们补默认档位（我曾按截图猜「关/低/中/极高+默认中」，那是错的）。
同理 `auto` / `q37fmodel` / `mmodel` **连 `thinking_config` 都没有** → 不声明
`reasoning`，UI 显示「当前模型未提供推理等级」（对应 IDE 的「不支持」）。

⚠️ **两个站的档位表必须分别采集，不能互相套用**：同一个 key 的默认档可能不同 ——
`qmodel_38max` 在 **CN 是 `medium`、国际版是 `xhigh`**；国际版 `ultimate` 是
`xhigh/high/low/max/medium`（默认 high），CN 无此模型。

**取证脚本**（均离线、零额度）：
- `scripts/probe-qoder-effort-matrix.mjs`：逐模型打印档位/窗口/可关闭/默认；
- `scripts/probe-qoder-effort-fields.mjs`：按客户端 `$lc` + `Qj` **完整复刻**算法；
- `scripts/probe-qoder-effort-i18n2.mjs`：从 asar 取官方中文名；
- `scripts/verify-qoder-model-meta.mjs`：**兜底表 vs 目录实值逐条对账**
  （档位/默认档/可关闭/窗口 四项，当前 31 条全绿）——**改表后必须重跑**。

回归用例在 `tests/unit/qoder-adapter.spec.ts` 的「resolveModel 的思考档位」段
（7 条，含「官方中文名」「只有关闭思考的两个模型」「不提供关闭的模型不追加 none」
「无 thinking_config 的不声明 reasoning」「defaultEffort 必须落在 efforts 内」）。
⚠️ 已做**反向验证**：去掉 `dmodel.supportsDisable` → 1 条变红；给 `qmodel_latest`
补上猜测档位 → 1 条变红；`defaultEffort` 改成 `max`（不在 efforts 内）→ 1 条变红。
⚠️ **写用例时注意 `makeAdapter()` 默认用国际版表**（`QODER`）——测 CN 必须显式传
`product: QODER_CN`，否则会拿错默认档（我第一版就这么错过）。

⚠️ **端到端字段已验**（`scripts/verify-qoder-effort-wire.mjs`，离线）：
`reasoningEffort: 'max'` → `parameters.reasoning_effort='max'` + `enable_thinking=true`；
`'none'` → `enable_thinking=false`（真正关闭）；不发档位时两个字段都不写。

3. **CN 没有公开的 OpenAI 兼容端点**：`gateway.qoder.com.cn` 与
   `openapi.qoder.com.cn` 上的 `/model/v1/chat/completions` 实测都回 **503**。
   故 `QODER_CN.inferBase` 填成与 `encryptedInferBase` 同值，仅表示「无独立公开端点」，
   **不要**据此发请求。（`inferBase` 与 `QODER_CHAT_PATH` 在整个代码库里本就
   **无任何调用方** —— 是公开端点方案被加密端点取代后留下的死配置，
   删除属于越界重构故保留，但新增代码不得再依赖它。）
4. **machine 身份与产品无关，但目录要遍历两个**：实测两站 `runtime-info.exe`
   （**SHA256 相同**）在同一 `environment`（仍为 `'3'`）下返回**逐字节相同**的
   `machineType` / `machineCode`（`env=0` 则两站同为另一套值）—— 身份由
   「设备 + environment」决定，**与产品无关**。
   所以**不需要**按产品分别缓存（那只会多一次 3.8 秒的无意义 spawn），
   也**不要**把目录列表放进 `QoderProduct`（没人读它 = 死配置，且会让人误以为
   「一产品认一目录」）；它落在 `src/qoder-machine.ts` 的模块常量
   `QODER_DATA_DIR_NAMES = ['.qoder', '.qoder-cn']`。
   ⚠️ 原实现把 `~/.qoder/.bin` 写死，**只装了中国版**的用户因而找不到 exe →
   退到陈旧磁盘缓存 → 拿不到 machine 头 → 积分误报「今天已领」 ——
   这正是 2026-09-25 那次修复的**复发路径**（已修，反向验证过用例会红）。
5. **加密推理可共用那份 WASM，已实证**：用国际版（从 0.3.4 / runtime 1.1.57 提取）
   那份 `src/qoder-auth-wasm.wasm` ① 成功解密 CN（runtime 1.1.64）下发的
   `catalog-v6`；② 签出的推理请求被 `gateway.qoder.com.cn` 接受
   （**HTTP 200 + 15 个 SSE 帧**）。故**不分发第二份产物**，
   `scripts/copy-assets.mjs` 与 `scripts/extract-qoder-wasm.mjs` 均无需 CN 变体。
   ⚠️ 顺带纠正 `qoder-wasm.ts` 里「`session_type` 国内版是 `qoder_work`」那条注释：
   它**不适用于推理载荷** —— CN 实测接受默认值 `qodercli`；
   CN asar 里 `qoder_work` 的唯一命中属于 `integrationMode → --ide-type`，另一回事。
   ⚠️ `clientMetadata` 沿用国际版的 **CLI** 身份（`client_type:'5'`）在 CN 也可用，
   不必换成 CN 桌面端的 `Fh` 那组 —— 但仍**不要**把 `sashClientType`（`'10'`）
   与它合并，那仍是两个不同身份（见上文）。

积分链路（`/sash/`）在 CN **整套复用成立**，实测：余额 `total=400`
（套餐额度 300 + 资源包 100，多包累加口径与国际版一致）、
`active=true / todayCheckedIn=false / dailyCredit=100`、
真实领取 `claimed +100` 且余额 `400 → 500`。
CN asar 里同样是 `Fh = Object.freeze({ clientType: 10, … })`，
且 sash 请求头 UA 恒为 `"Qoder"`。

排查脚本（均只读、零额度）：`scripts/probe-qodercn-clientid.mjs`（asar 里的
`authClientIds` 与授权 URL 构造 `Sft()`）、`scripts/probe-qodercn-catalog.mjs`
（用**国际版** WASM 解 CN 目录并输出可粘贴的 TS 兜底表条目）、
`scripts/verify-qodercn-live.mjs`（一次性「登录→推理→积分」，**token 不落盘**）。
e2e：`pnpm test:e2e:qodercn`（只读）/ `:qodercn-chat` / `:qodercn-credits`。

### ⚠️ `scripts/` 里哪些入库、哪些**不入库**（容易误判）

`.gitignore` 有 `scripts` 一行，但**它只对未跟踪文件生效** —— 已被跟踪的文件
不会因该行而移出仓库。故现状是「部分入库、部分不入库」，**新增脚本前先看清**：

| 类别 | 入库 | 说明 |
|---|---|---|
| **构建必需** | ✅ | `copy-assets.mjs`（`pnpm build:assets` 用它把 `.wasm` 复制到 `lib/`）、`extract-qoder-wasm.mjs`（`pnpm qoder:wasm`）。**删了构建会坏** |
| **图标/产物提取** | ❌ | `extract-qodercn-icon.mjs` 等 —— 产物是提取自客户端安装目录的二进制，不入库 |
| **只读排查/取证** | ❌ | `probe-*.mjs` / `verify-*.mjs` —— 本文件大量引用它们作为「怎么复核这个结论」的指针，但**它们不在仓库里** |

⚠️ **因此 AGENTS.md 里 `scripts/xxx.mjs` 的引用是「本地指针」而非仓库文件**：
新克隆的仓库里**没有**这些脚本，需要时按本文件描述的思路自行重写
（多数脚本只做「解压/解析/打印」，几十行即可复现）。
⚠️ 引用它们**不代表它们存在** —— 别照着路径去 `import`（没有任何 `src/` 代码
依赖它们；注释里的提及仅作文档指针）。

⚠️ **不要把只读排查脚本 `git add -f` 进去**：`.gitignore` 的 `scripts` 行是
**有意为之**（研究工具仅本地保留）。`git add -f` 会绕过它，让仓库里出现
「本不该入库」的文件 —— 2026-09-27 真踩过（`probe-qoder-queue-error.mjs` 等
被强加进去，事后又得撤出）。


### ⚠️ Qoder 积分余额：路径在 `/sash/` 下，且只需 Bearer

`GET {openApiBase}/sash/api/v2/me/usage`（实现见 `src/qoder-credits.ts`），
请求头 `Authorization: Bearer` + **`Cosy-ClientType`**，**不需要** WASM 签名。

两个**真实踩过的坑**：

1. **只按 `/api/` 前缀搜端点会漏掉它** —— 它挂在 `/sash/` 下。早期据此误判
   「Qoder 无积分端点」并把能力登记成 `balance:false`（用户报障：
   「登录成功了，没有获取积分吗？现在应该是一个资源包 100 积分」）。
2. **余额不只在 `userQuota` 里** —— 实测 `userQuota.remaining=0` 而
   `addOnQuota.remaining=100`（资源包）。只读 `userQuota` 会显示 0。
   另有 `dedicatedResourcePackages` 需一并累加。

企业版（`displayMode:"enterprise"`）不下发额度数字、只给外部链接 →
返回 `null`（UI 显示「查询失败」）而非 `0`。

### ⚠️ Qoder 每日领取：端点由 **keylog 解密抓包** 解出（2026-09-21）

```
GET  {openApiBase}/sash/api/v1/me/campaigns
POST {openApiBase}/sash/api/v1/me/campaigns/{campaignId}/claim   ← body **空**
```

**请求头（`/sash/` 端点必需四项）**：`Authorization: Bearer` + `Cosy-ClientType: '10'`
+ **`Cosy-MachineToken` + `Cosy-MachineType`（成对）**，**无需签名**。

⚠️ **两个条件缺一不可，且是「必要但不充分」的叠加关系**（真实缺陷，
2026-09-25 定位并**端到端修复验证**：插件领取成功、余额 0→100）：

| 请求头 | `/sash/api/v1/me/campaigns` 响应 |
|---|---|
| `Cosy-ClientType: '5'`（CLI 身份） | `{"showCampaign":false,"claimable":false,"campaignUrl":"","campaigns":[]}` |
| `Cosy-ClientType: '10'` + 无 machine 头 | `showCampaign:true, claimable:false`，**1 条 `VIEW_DETAILS`** |
| `Cosy-ClientType: '10'` + MachineToken + MachineType | `claimable:true`，**2 条**，含 `CLAIM_BENEFIT/CLAIMABLE/amount:100` |
| ＋MachineToken/MachineType **去掉任一个** | ❌ 退回 1 条（**必须成对**） |
| 单独加 `Cosy-MachineId`/`Version`/`OS`/`Hostname`/`Code` | ❌ 均无效（**都不是必需项**） |

⚠️ **`'10'` 单独不够** —— 这是被 PR !11 的错误结论误导过的地方。它只让服务端
回一条 `VIEW_DETAILS`（`claimable:false`），**没有** `CLAIM_BENEFIT`，于是插件
筛出 0 个可领活动并误报「今天已领」。**真正决定下发可领活动的是成对的
machine 头**。实现见 `src/qoder-machine.ts`。

⚠️ **值的来源可自给自足，不需要抓包**：`%APPDATA%\Qoder\SharedClientCache\
cache\machine_token.json` 的 `token` → `Cosy-MachineToken`、`type` →
`Cosy-MachineType`。实测该文件即使 `updateAt` 很旧（179 天前）token 仍有效。
读不到时**保守降级**（不带这两个头，回到修复前行为）——纯插件登录、未装
Qoder 桌面端的用户没有该文件，不能让积分功能整体失败。

⚠️ **`'10'` 的来源是官方常量**，不是猜的：Qoder 桌面端 `app.asar` 里有
`Mh = Object.freeze({ clientType: 10, businessProduct: 'app', sessionType: 'app' })`，
native 另有 `rl = Object.freeze({ clientType: 10, businessProduct: 'app' })`。

⚠️ **不要合并两处 client_type**：`clientMetadata.client_type`（`'5'` + `cli`）
是**推理请求体**加密信封 `metadata` 用的（源码 `Fp()` 的 CLI 默认值），
与 `/sash/` 的 HTTP 头**是两个不同身份**。改动前先在 `qoder-adapter.ts`
确认用途，别把推理那条链路一起改掉。

⚠️ **用户症状是「插件报今日已领取、但官方能领」**：`campaigns:[]` 或只有
`VIEW_DETAILS` 会让 `claimableCampaigns()` 筛出 0 个 →
`claimQoderDailyCheckin` 返回 `already-claimed`，**把「服务端没下发数据」
误报成「今天已领」**。排查时**不要只看这个文案**，先确认上述四个头是否齐全。

⚠️ **「今天已领」的正确判据不是「列表为空」**（2026-09-21 抓包实测的
**领取前后对照**，这是该判据可靠性的直接证据）：

| 时刻 | `claimable` | 那条 `CLAIM_BENEFIT` 的 `claimStatus` | 列表 |
|---|---|---|---|
| 领取前 | `true` | `CLAIMABLE` | 非空 |
| 领取后 | `false` | `CLAIMED` | **仍非空** |

即**领取成功后服务端并不清空列表**，只是把该条改成 `CLAIMED`。故判据必须是
「存在 `CLAIM_BENEFIT` 且 `CLAIMED`」，而「列表为空 / 只有 `VIEW_DETAILS`」
应判**未领**。方向取保守：误报未领最多让用户多点一次（服务端幂等，回
`replayed:true`，无害）；误报已领会让其**真的错过当天积分**。

⚠️ **幂等判据是响应体的 `replayed`，不是 HTTP 状态码**：重复领取同样返回
**200**，但 `replayed:true`、**不含 `benefit`**，且 `claimedAt` 是**上一次
领取的旧时间**（实测请求发生在 09-21、而 `claimedAt` 是 09-18）。
只看状态码会把「今天已领」误报成「领取成功 +100」。

⚠️ **请求体必须是空串**（抓包实测 `content-length: 0`）。

⚠️ **只领 `actionType === 'CLAIM_BENEFIT' && claimStatus === 'CLAIMABLE'`** ——
实测还有 `VIEW_DETAILS` 型活动（如「Pro 首月翻倍」），对它发 claim 是错的。

⚠️ **为什么曾经误判「Qoder 无签到」**：`/sash/api/v1/me/campaigns` 当时返回
`{"showCampaign":false,"claimable":false,"campaigns":[]}`，据此下了结论。
真相是**那天已领** —— 活动**每日 10:00（UTC+8）刷新**（响应里
`description: "每日 10:00（UTC+8）刷新，领取后 30 天有效"`）。
**教训：「某次实测没看到」不能推广成「不存在」**，这与 TRAE「带 code 的
回调」那次是同一类错误。

⚠️ **`CheckinStatus.active` 必须恒为 `true`**（拿到响应即 true，不按
「列表非空」判）：服务端在活动不同阶段都可能回空列表（如请求头不全时），
若据此判 `active:false`，`collectClaimResults` 会先命中「活动未开启」分支，
把「今天已领」误报成「签到活动未开启」。

⚠️ **但「今天已领」不可反推成「列表为空」** —— 2026-09-21 抓包实测领取前后
对照显示：**领取成功后列表仍非空**，只是那条 `CLAIM_BENEFIT` 的
`claimStatus` 由 `CLAIMABLE` 变 `CLAIMED`、顶层 `claimable` 变 `false`。
正确判据见上「Qoder 每日领取」章节。

⚠️ **RPC 分支须传 `precheckStatus: false`** —— `claimQoderDailyCheckin`
自带活动列表查询，否则会重复发一次 GET（与 LobsterAI 传 false 同理）。

### ⚠️ `openai-compat.ts` 只服务 qoder，不要顺手重构既有适配器

`src/openai-compat.ts` 把「消息序列化 + SSE 消费」抽成共享实现给 **qoder 适配器**用。`buddy-adapter.ts` / `lobsterai-adapter.ts` **刻意不改用它** —— 那两份实现已被大量单测与线上流量验证，重构它们属于与本任务无关的高风险改动。若将来要统一，应作为独立任务并配以逐条对拍测试。

它承载的教训（改它时必须保留）：`delta.content` / `delta.reasoning_content` 会显式返回 **`null`**（必须 `typeof === 'string'` 判定）；孤儿工具调用须剔除（否则后端 400 且坏历史被反复重放）；`function.name` 只允许非空覆盖；残缺参数**不补 `{}`**（补了会让 harness 报 schema 错误而非重试）。

`trae` 同样**完全独立**（第五个脉系，独立一套 `src/trae*.ts`），且差异点与其他四者都不一样：认证用 **ExchangeToken 轮换 refreshToken**（不是轮询、也不是 authCode 交换）；鉴权头是 `Cloud-IDE-JWT <token>` 加十余个 `X-*` 身份头；**请求体需要从 OpenAI 格式转换为 SOLO 格式**（`function` / `config_name` / `tools.parameters` 序列化等）；**响应是 SOLO 自定义 SSE 事件**（`output` / `token_usage` / `done` / `error`），必须自行解析并转成 OpenAI chunk；凭据还必须持久化 `machine_id` 与 `device_id`（均为 **32 位 hex**，分别用作设备指纹与签到设备号，后者账号间必须互异）。**登录回调默认直接回传 token**（`auth_callback_url` 参数，老流程没有 `code`；但也并存 PKCE 新流程，两套都要认），详见下「TRAE 协议要点」。实现见 `docs/trae-integration-plan.md`。

Jet Hub 设置页（`plugin-src/client/jet-hub.js`）提供多账号管理与限流自动切换；「一键领取积分」按钮（每日签到）**CodeBuddy、LobsterAI、CodeArts、Qoder、Qoder 中国版与 TRAE 六个面板提供** —— 国际版 WorkBuddy 与 Cline 不提供（两者的后端都没有签到接口）。各面板是**互不相同的协议**（见下「积分领取」）。

⚠️ Qoder 国际版与中国版**共用同一组领取实现**（`src/qoder-credits.ts` 的函数一律
接收 `product` 参数），RPC 侧通过 `jet-hub-rpc.ts` 的 `qoderFamily` 注册表分派。
新增同族产品**不要**在四处分支各加一条平行 case —— 平行 case 越多，漏接概率越高
（`workbuddy` 的「刷新」按钮就是这么一直坏着的）。

- **包名**：`dsh-codearts-auth`
- **入口**：`lib/index.js`（宿主侧）、`lib/client/jet-hub.js`（客户端 bundle）
- **构建**：`pnpm build:all`（`tsc` 编译宿主侧 + `esbuild` 打包客户端）
- **语言**：TypeScript
- **许可**：MIT

## ⚠️ 安装（git 插件）的 allowBuilds 键在 pnpm 10 / 11 语义**互不兼容**（Issue IKJCOC）

**用户报障**（2026-09-30，Gitee issue IKJCOC）：「DSH Desktop 内置 pnpm 下
`dsh plugin add` 安装失败：allowBuilds 的 git URL 键触发
`ERR_PNPM_INVALID_VERSION_UNION`」。报错里 `Found:` 的那个键，正是当时 README
「方式一」与本仓库 `pnpm-workspace.yaml` 里那行
`dsh-codearts-auth@git+https://gitee.com/iJetLi/deepseek-harness-codearts.git`。

**实测结论：这不是"换个键写法"就能了事，而是两代 pnpm 的键语义互不兼容** ——
同一个键在一代上"非法"、在另一代上"合法但永不匹配"。本机实测（Windows 11，
2026-09-30；依赖侧统一用**本地 git 仓库**里的同名包，带 `prepare` 脚本，
⚠️ **每个变体都换一个新 commit**，因为 pnpm 的 side-effect cache 命中时会跳过
allowBuilds 判定，不换 commit 会得到假的"成功"）：

| `allowBuilds` 键 | pnpm 10.28.0 | pnpm 11.7.0 |
|---|---|---|
| `dsh-codearts-auth@git+<url>`（旧 README / 旧仓库写法） | ❌ `ERR_PNPM_INVALID_VERSION_UNION` | ❌ `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`（缺 `#commit`，永不匹配） |
| `dsh-codearts-auth@git+<url>#<当前commit>`（**pnpm 自己打印的键**） | ❌ `ERR_PNPM_INVALID_VERSION_UNION` | ✅ 放行成功 |
| `dsh-codearts-auth@git+<url>#<旧commit>` | — | ❌ `NOT_ALLOWED`（换 commit 即失效） |
| `dsh-codearts-auth`（纯包名；**issue 建议的"已验证修复"**） | ✅ 放行成功 | ❌ `NOT_ALLOWED` |
| `dsh-codearts-auth@0.1.0`（精确版本） | — | ❌ `NOT_ALLOWED` |
| `dangerouslyAllowAllBuilds: true`（顶层） | ✅ | ✅ |
| `add --allow-build=dsh-codearts-auth`（CLI） | — | ❌（它只写入纯包名键，本次仍不放行） |

- pnpm 11.7.0 取自本机安装的 DSH Desktop：
  `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\pnpm`
  （`DeepSeek Harness.exe` 的 FileVersion `0.2.0-rc.2`）；pnpm 10.28.0 用
  `npx pnpm@10.28.0`（issue 报告的内置版本是「10.28.0 定制构建」，与本机这版**不同**，
  故两代都必须覆盖）。
- ⚠️ **issue 建议的纯包名键不能直接采纳**：它只在 pnpm 10 上有效。pnpm 11 的
  `createAllowBuildFunction` 里
  `trustPackageIdentity = name && version && !nonSemverVersion` —— git 包的
  `nonSemverVersion` 非空 ⇒ 直接 `return undefined`，**纯包名/精确版本键一律不参与匹配**，
  只有 `allowedDepPathBuilds` 里的 `name@git+...#sha` 能命中。
- ⚠️ **pnpm 10 的坑更深：它连自己打印的键都拒绝**。11.7.0 有 `isDepPathAllowBuildKey()`
  把含 `:` / `/` / `#` 的键当 depPath 键，从而**绕开**版本并集解析；10.28.0 没有这层保护，
  所有键都走 `parseVersionPolicyRule()` → `semver.valid('git+https://…')` 为 `null` →
  抛 `INVALID_VERSION_UNION`。⇒ pnpm 10 上「复制 pnpm 打印的键」这条官方提示**走不通**，
  只能写纯包名键或 `dangerouslyAllowAllBuilds: true`。
- ⚠️ **失败表现的版本差异**（排查时先看这个）：本机 desktop（11.7.0）**不复现**
  `ERR_PNPM_INVALID_VERSION_UNION`，而是报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`；
  两者根因同为"那个键不可用"。**不要**因为报错文案与 issue 不一致就判定"desktop 下没问题"。
- ⚠️ **pnpm 只对 git 托管包打印提示、不写占位符**（实测 `pnpm-workspace.yaml` 未被改动），
  所以 DSH 的「允许这些脚本并重试」按钮覆盖不到 git 插件安装 ——
  `readPendingBuilds`（`packages/boot/plugin-manager/src/build-approval.ts`）只认值为
  `set this to true or false` 的条目。用户只能手写键。这属 DSH 侧可改进项，不在本仓库范围。

**端到端复现与修复验证**（本机、离线、不动工作区；`git clone` 到临时目录后按场景改写
并 **commit** —— ⚠️ pnpm 取的是**提交内容**，只在工作区覆盖文件是无效的，第一次就这么白跑了一遍）：

| 场景 | 结果 |
|---|---|
| 修复前（仓库保留那行 git 键）+ pnpm 10.28.0，profile 已按 issue 写纯包名键 | ❌ 插件自己的 `pnpm install` 阶段：`ERR_PNPM_INVALID_VERSION_UNION … Found: "dsh-codearts-auth@git+https://…"` → `ERR_PNPM_PREPARE_PACKAGE … Exit status 1`（issue 描述的第二个失败点，原样复现） |
| 修复后（删掉那行键）+ pnpm 10.28.0 + profile 纯包名键 | ✅ install + `prepare`（tsc / copy-assets / client 打包）跑通，`lib/index.js` 产出 |
| 修复后 + DSH Desktop 内置 pnpm 11.7.0 + profile 精确键（`…#<commit>`） | ✅ 85 个依赖装好、`esbuild` postinstall 执行、`prepare` 全跑通（`lib/qoder-auth-wasm.wasm`、`lib/client/jet-hub.js` 均产出） |

⇒ **两条不要改回去的红线**：

1. **本仓库 `pnpm-workspace.yaml` 里不得出现 `包名@git+URL` 键**。本包不依赖
   `dsh-codearts-auth`，该键永远匹配不上；而在 pnpm 10.x 下它会**毒化整个 clone**：
   从 git 安装时 pnpm 要在 clone 里跑 `pnpm install`，读到这行即抛
   `ERR_PNPM_INVALID_VERSION_UNION`，`prepare`（`pnpm build:all`）根本起不来。
   （`esbuild: true` 必须保留 —— registry 包的版本是 semver，纯名键在两代都生效。）
2. **README「方式一」的放行键必须按 pnpm 大版本分别给出**，不能把某一代的写法写成通用解。
   唯一跨版本可用的是 `dangerouslyAllowAllBuilds: true`（代价：放行该 profile 里所有依赖的
   构建脚本）。改完请照上表重跑一遍验证 —— 尤其**要换新 commit**，否则缓存会骗你。

## 技术栈与约束

- **Node.js**：`^22.19.0 || >=24.0.0`
- **构建系统**：宿主侧用 TypeScript `tsc` 编译到 `lib/`；客户端 bundle 用
  `esbuild`（`plugin-src/client/build.mjs`）打包到 `lib/client/jet-hub.js`。
  两者都产出到已 gitignore 的 `lib/`，`prepare` 执行 `pnpm build:all` 保证
  git 安装时两侧产物齐全。
  ⚠️ **`tsc` 不清理「源文件已删除」的产物**：改名/删文件后 `lib/` 会留着旧的
  `.js` / `.d.ts` / `.map`（2026-10-01 把 `cline-modalities.ts` 换成
  `cline-models-dev.ts` 时实测到，`lib/cline-modalities.*` 四个文件仍在，
  并随文件拷贝式安装一起进了 profile）。**删改源文件后手动清一次 `lib/`**
  （或整目录重建），否则残留模块虽无人 import 却会一直跟着发布。
  ⚠️ **`plugin-src/client/jet-hub-styles.js` 里的 `STYLES` 是模板字符串 ——
  CSS 注释内绝不能出现反引号**。用它给属性名加强调（`` `min-width: 0` ``）会
  **提前闭合模板**，esbuild 报 `Expected ";" but found "min"` 并把指针指到注释那一行，
  看起来像 CSS 写错了，实际是 JS 语法问题（2026-10-01 改页头样式时踩过，
  一次引入 6 对）。注释里要强调就直接裸写 `min-width: 0`。
  改完这个文件**必须跑一次 `pnpm build:client`** —— 单测只读源码文本，不会因此失败。
- **测试**：Vitest（单元测试 + E2E 端到端测试）
  - `pnpm test` — 单元测试（快速，无网络，全部 mock）
  - `pnpm test:e2e:*` — 端到端测试，按 provider 分列（如 `test:e2e:codearts`、`test:e2e:buddy`、`test:e2e:workbuddy-claim`）；**均有闸门，默认全部跳过**，详见 `tests/e2e/README.md`
- **依赖管理**：pnpm workspace（作为 DSH 插件安装）
- **代码风格**：与 `@deepseek-ai/dsh` 主仓库保持一致

## 项目结构

| 路径 | 说明 |
|-------|------|
| `src/` | TypeScript 源码目录（宿主侧） |
| `plugin-src/client/` | Jet Hub 客户端源码（esbuild 打包） |
| `lib/` | 编译产物（已 gitignore；含 `lib/client/jet-hub.js`） |
| `tests/unit/` | 单元测试 |
| `cordis.patch.yml` | DSH bundle 补丁 |
| `tsconfig.json` | TypeScript 配置 |
| `vitest.config.ts` | Vitest 配置 |

## ⚠️ dsh peer 范围必须**枚举并集**，不能用 `^0.1.2-rc.1` 或 `<0.3.0-0`（Issue IKIZ36）

**真实缺陷**（用户报障，Gitee issue !IKIZ36「peer 声明问题，建议版本要求改为左闭右开，
不会因为声明问题而无法在新版本安装」）：dsh 升到 `0.2.0-rc.1` 后插件装不上。

**根因是 semver 对 `0.x` 的 `^` 语义**：`^0.1.2-rc.1` 等价于 `>=0.1.2-rc.1 <0.2.0`
（0.x 的 `^` **只锁次版本**），所以 `0.2.0-rc.1` 判定为 **false**。

⚠️ **但「改成左闭右开」并不够 —— 有两个陷阱，只改一半仍会装不上或过度放行**：

**陷阱 1：dsh 门禁与 npm 默认语义不同，必须让两边都通过。**
dsh 的安装门禁 `evaluatePluginCompatibility`
（`packages/boot/app-boot/src/plugin-compatibility.ts`）用
`semver.satisfies(runtimeVersion, range, { includePrerelease: true })` —— **开了
`includePrerelease`**，故 prerelease 一律参与匹配；而 **npm/pnpm 默认语义更严**
（range 里必须出现**同 tuple** 的 prerelease 才允许匹配该 tuple）。实测：

| range | dsh 门禁（inclPre）对 `0.1.7-rc.2` | npm 默认对 `0.1.7-rc.2` |
|---|---|---|
| `^0.1.2-rc.1` | ✅ | ❌ |
| `>=0.1.2-rc.1 <0.3.0-0` | ✅ | ❌（`0.2.0-rc.1` 同样 ❌） |
| `^0.1.2-rc.1 \|\| ^0.1.7-rc.2 \|\| ^0.2.0-rc.1` | ✅ | ✅ |

⇒ 纯区间写法（`>=x <y`）在 npm 默认语义下**仍然装不上 prerelease**。**必须枚举出
每个要支持的 prerelease tuple**。

⚠️ **已用 `npm pack` 打的 tarball 实测证实**（`file:` 目录依赖会绕过 npm 的 peer
校验，**必须用 tarball 才测得出来** —— 我第一次用 `file:` 探针得到了假的「都通过」）：

| 插件 peer 声明 | `npm install` 装 `dsh-llm@0.2.0-rc.1` |
|---|---|
| `^0.1.2-rc.1`（旧，issue 报障形态） | ❌ `ERESOLVE` |
| `>=0.1.2-rc.1 <0.3.0-0`（**纯左闭右开**，即 issue 的建议） | ❌ `ERESOLVE` |
| `^0.1.2-rc.1 \|\| ^0.1.7-rc.2 \|\| ^0.2.0-rc.1`（**本次采用**） | ✅ 装上 |

⚠️ **所以 issue 里「改为左闭右开」的建议单独并不充分** —— 在 npm 下仍会
`ERESOLVE`。必须枚举 prerelease tuple。

**陷阱 2：`<0.3.0-0` 里的 `-0` 是必需的**（若要写区间）。`<0.3.0` 在
`includePrerelease` 下会**放进 `0.3.0-rc.1`** —— 那正是下一个不兼容的破坏性版本。
`-0` 后缀表示「低于该版本的任何 prerelease」，把 prerelease 挡在门外。

**当前采用的写法**（`package.json` 的 `peerDependencies` 与 `devDependencies`
**必须一致**，这是 dsh 的 package 不变式）：

```
"@deepseek-ai/dsh-llm": "^0.1.2-rc.1 || ^0.1.7-rc.2 || ^0.2.0-rc.1"
```

`@deepseek-ai/dsh-commands` / `@deepseek-ai/dsh-credentials` / `@deepseek-ai/dsh-llm`
三个 dsh 包同款。⚠️ `@deepseek-ai/cordis`（`^4.0.2`）与 `@deepseek-ai/schemastery`
（`^3.18.4`）**不参与该门禁**（门禁只校验 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`
前缀），且它们本就在 0.2.0 里仍是 4.0.4 / 3.18.4，故维持 `^` 即可。

⚠️ **加新支持的 dsh 版本时，往并集里追加一条 `|| ^<新版本>`** ——
不要图省事换成 `*` 或 `>=0.1.2-rc.1`（后者会放行未来所有破坏性版本）。

**验证方式**（离线，别只靠肉眼看 range）：

```js
const s = require('semver')
const R = '^0.1.2-rc.1 || ^0.1.7-rc.2 || ^0.2.0-rc.1'
for (const v of ['0.1.2-rc.1', '0.1.7-rc.2', '0.2.0-rc.1']) {
  // dsh 门禁语义与 npm 默认语义都必须通过
  console.log(v, s.satisfies(v, R, { includePrerelease: true }), s.satisfies(v, R))
}
// 且不得放行下一破坏性版本
console.log('0.3.0-rc.1 must be false:', s.satisfies('0.3.0-rc.1', R, { includePrerelease: true }))
```

**0.2.0 的 API 兼容性已核对**（不只是改版本号）：0.2.0 把
`PreparedAdapterCall` 改名为 `AdapterPreparedCall`，但本仓库**从未引用**该类型
（八个适配器各自实现了 `prepareCall` 兼容层），故不受影响。
`registerConfigurableProviders` / `registerAdapter` / `credentialRef` /
`LlmAdapter` / `LlmError` / `ToolCallId` / `ReasoningEffortId` /
`EMPTY_RESPONSE_CODE` 在 0.2.0 中**均存在**。

## DSH 插件契约

- 插件使用 `@deepseek-ai/dsh` 的 `credentials`、`commands`、`llm` 服务注入
- 凭据存储使用 `ctx.credentials` 模块，ref 格式遵循 POSIX 标识符（如 `CODEARTS_ACCESS_TOKEN`）
- LLM provider 通过 `ctx.llm.registerProvider()` 注册
- 命令通过 `ctx.commands.register()` 注册
- 插件配置通过 `ctx.schema` 在 profile layer 栈中声明

## 工作方式

### ⚠️ 子任务优先用 **inline** 执行，不要新开 subagent

处理多任务计划（如 `docs/superpowers/plans/*.md` 的 Task 1..N）时，**新子任务直接在
当前会话 inline 做**，不要为每个子任务再新开 subagent。用户 2026-09-29 明确要求。

理由（本项目实测的代价）：
- **同一工作区无法安全并行**：subagent 做「反向验证」时会在源码里注入**临时变异**
  （未提交状态）。此时若另一个 subagent 跑全量测试，会看到 2~3 条**不属于它的**失败，
  容易误判为自身缺陷；更糟的是若它执行 `git stash` / `git checkout -- .` /
  `git restore` / `git add -A`，会**毁掉**前者的变异验证（丢未提交的变异体与还原基线）。
- **subagent 会长时间空转**：本项目已有两次复审 subagent 跑到超时仍无产出
  （Task 2 的复审者被 `interrupt_agent` 中止、Task 4 的复审者未输出即结束）。
- **context 更可控**：inline 做时前面已建立的实测事实（协议细节、坑点、
  既有范例行号）都在手边，不必每次重新交代，也不会因为表述遗漏而让子代理
  重新踩已知的坑。

若确实要用 subagent（例如任务之间**没有文件重叠**且**都不做变异验证**），必须：
1. 预先告知它「工作区可能有他人未提交改动，**只 `git add` 自己的文件**」；
2. **明令禁止** `git stash` / `git checkout -- .` / `git restore` / `git add -A`；
3. 告诉它判断成败要用**自己的**测试文件，全量测试只作参考。

### `ctx.xxxAuth` 服务统一接口

本插件定义的所有 `ctx.xxxAuth` 服务（`codeartsAuth`、`buddyAuth`、`workbuddyAuth`、`lobsteraiAuth`、`qoderAuth`、`qoderCnAuth`、`traeAuth`、`clineAuth`）均遵循统一接口：

- `login(options?)` — 执行浏览器登录流程
- `startLogin(options?)` — 两步式登录（先返回 loginUrl，Jet Hub 据此弹窗）
- `refreshAccountCredential(refName, pool?, accountId?)` — 按凭据 ref 续期**指定账号**（账号卡片「刷新」按钮）。⚠️ 后两个参数**必须传**：只有拿到池与账号 id，续期后的新 `expiresAt` 才能回写账号池（见下）
- `refreshAll(pool)` — 批量续期全部账号（定时调度器）

⚠️ **不注册任何斜杠命令**：十个 provider 的登录/状态/续期**全部**在 Jet Hub 设置页完成。

⚠️ **CodeArts 只支持账号池，单凭据模式已移除**（用户要求）：

- 凭据一律存 `CODEARTS_ACCOUNT_XXX`；固定的 `CODEARTS_ACCESS_TOKEN`
  **不再被写入或读取**（常量保留仅为兼容 `login`/`startLogin` 的 `refName` 缺省值）。
- 只服务于单凭据路径的方法**已删除**：`status()` / `refresh()` / `logout()` /
  `scheduleRefresh()` / `scheduleModelRefresh()`（后两者当时就没有调用方）。
  `refreshModels()` **签名改为接收 `pool`** —— 它原先直接读固定 ref，
  移除单凭据后会恒返回空列表。
- `codearts-login` / `codearts-status` / `codearts-refresh` 三个命令**已删除**
  （注意代码里**从来没有** `codearts-logout` 命令，logout 只是服务方法）。
- 十个 provider 的门控判据因此**完全一致**：都只看账号池，
  `providerCatalogVisible` 的 `extraCredentialRefs` 参数已随之删除。
- 老用户影响：若此前只用固定 ref 登录过，模型列表会变空，需在 Jet Hub 重新登录一次
  （用户已确认接受该行为，不做自动迁移）。

### ⚠️ 续期不得按 `enabled` 过滤

`refreshAll()` 与 `src/index.ts` 的续期调度器**只按 `refreshable` 过滤，不看 `enabled`**。

⚠️ **「不看 `enabled`」这条仍然有效；「按 `refreshable` 过滤」这条已被推翻**
（2026-10-02，见下文「账号池的 `refreshable` 只是凭据材料的镜像」）：
那个布尔当过滤条件用会把一次瞬时失败固化成单向门，账号从此永不自愈。

停用只应影响「账号池的自动选号」，与「凭据是否需要保持新鲜」无关 ——
停用账号同样会出现在 Jet Hub 里并参与积分领取。

**真实缺陷**（用户报障）：两个**曾停用**的 CodeBuddy 账号显示「凭证过期」，
点「一键领取积分」报 `Unexpected token '<', "<html> <h"... is not valid JSON`。
根因是两处都按 `enabled` 过滤：

- `refreshAll()` 里的 `if (!entry.enabled || !entry.refreshable) continue`
  → 停用期间 refresh_token 一路放到失效；
- `src/index.ts` 的 `accounts.some(a => a.refreshable && a.enabled)`
  → **所有账号都停用时续期定时器根本不启动**。

用户重新启用后拿到的是死凭据，只能重新登录。十个 provider 的
`refreshAll`（`buddy-auth.ts` / `service.ts` / `lobsterai-auth.ts` / `qoder-auth.ts` / `trae-auth.ts`）与调度器
**都必须保持只看 `refreshable`**。

⚠️ Qoder 中国版**复用同一个 `QoderAuth` 类**（`src/qoder-auth.ts`），故它的
`refreshAll` 判据**天然与国际版一致** —— 不存在「CN 那份实现忘了改」的可能，
这正是「差异收敛到产品配置」这个模式的价值。

### ⚠️ 续期三件事缺一不可：启动先跑一轮、lead-time 判据、回写账号池

**真实缺陷**（Gitee issue !IKIRTT，用户报障）：重启后 cline / codearts / raccoon
的账号卡片**最长 30 分钟**显示红色「有效期：已过期 · 自动续期」，积分行报
`账户信息查询失败：HTTP 401`，而凭据其实是好的（`refresh_token` 到 10 月）。
点「刷新」按钮凭据续成功了、**界面纹丝不动**，点「重测」也不救急
（`src/account-probe.ts` 的 `refresh` 是**刻意**的 no-op，探测不该触发全局续期）。

根因是多账号改造丢了三条语义，三者**必须同时在**（缺任何一条都还会看到症状）：

1. **启动首轮**：`src/index.ts` 的调度器原先只有 `setInterval`，第一次处理要等满
   一个周期。短寿命令牌（cline 1h / codearts 约 2h / raccoon 3h，对照 buddy 系 720h）
   在宿主关闭期间早已到期 → 只有这三个 provider 会暴露出来。
   现在 `pool.listAllAccounts()` 门控通过后**立刻** `void refreshAllCredentials()`。
   ⚠️ 那条链原本**没有 `.catch()`**：`listAllAccounts()` 一 reject，定时器永不武装
   且日志零字 —— 「30 分钟」会恶化成「永不自愈」。
2. **lead-time 判据**：`shouldRefreshNow()`（`src/expiry-sync.ts`）复用单凭据时代
   `REFRESH_LEAD_MS`（1 小时）—— 距过期不足 1 小时才发续期请求。
   这既让启动首轮只打 0~3 个请求（39 账号的池不会在启动时突发几十个请求），
   也终结了「八个 provider 的 `refreshAll` 没有任何过期判据、每 30 分钟全量轮换」。
   ⚠️ **判据必须用凭据自己的 `exp`，不能用账号池的 `expiresAt`** ——
   池值正是本缺陷里可能陈旧的那份数据，拿它当尺子会漏刷真正快过期的账号
   （读凭据只是本地存储访问，不花网络也不花模型额度）。
   ⚠️ **raccoon 保留更严的「已过期才刷」**（`isRaccoonExpired`，lead=0）：
   它 3 小时寿命 + 30 分钟定时器已足够，提前 1 小时刷只会多打请求 ——
   lead-time 的目的是**减少**请求，不是增加。别「为统一」把它改成 1 小时。
3. **回写账号池**：UI 读的**只**是池里的 `expiresAt`
   （`plugin-src/client/jet-hub.js` 的 `account.expiresAt <= Date.now()`）。
   原先十个 provider 里只有 raccoon 回写，其余八个（含 `createPoolRefresh` ——
   CodeBuddy 系**发消息途中**按需续期的路径，触发频率远高于点按钮）
   只 `credentials.set` → 「数据源分叉」，功能完全正常但界面永远错。
   现统一走 `src/expiry-sync.ts` 的 `syncAccountExpiry` / `refreshAccountWithReconcile`。

⚠️ **`refreshAll` 里「本轮不刷」的分支绝不能直接 `continue`** —— 必须仍做一次
有效期对账。只修「续期时回写」是不够的：**存量账号**的凭据早已在别处（IDE /
上一轮）续好，判据必然为「不用刷」，池里的旧值就**永远无人更正**。
判据用「与凭据不一致」（不是「池值已过期」），否则漏掉「池值偏小但尚未过期」。
一致时不写盘（账号列表是整体落盘的），容差 1 秒（JWT 的 `exp` 是秒级）。

四个必须记住的实现约束：

- ⚠️ **`isLoomyRefreshable` 恒为 `false`**（Loomy 没有 refresh 端点，是诚实标记）。
  故 `ExpiryAccessors.refreshableOf` 是**可选**的，Loomy 那份不提供 ——
  否则共享实现会把池里的 `refreshable` 写成 false，与该产品的设计自相矛盾。
- ⚠️ `findAccountIdByCredential` 的第二参是**凭据内容**不是 ref 名（传 ref 名会
  恒匹配失败且**静默**）；且 codearts 比对的字段是 **`access_key_id`**（它的凭据里
  根本没有 `access_token`）；它还**跳过 `enabled === false`** 的账号。
  ⇒ 调用方已知 `entry.id` 时**必须显式传**，反查只是兜底。
- ⚠️ 回写失败**只记日志、不上抛**：凭据已经续期成功了，因写索引失败而报错会让
  用户以为续期失败、甚至触发无谓的重新登录。
- ⚠️ 凭据里读不到过期时间时**不覆盖**池内旧值：`updateAccount` 做的是
  `{ ...entry, ...patch }`，写 `undefined` 落盘会被 `JSON.stringify` 整个丢弃，
  UI 于是从「已过期」变成「未知」—— 保留旧信息更有价值。

⚠️ 边界（别夸大这类缺陷）：**功能一直是好的** —— 适配器发现凭据过期会按需
`refresh()` 再发请求；定时器跑过一轮后 UI 也会自愈。受影响的是「启动到首轮之间」
的界面与积分行，以及窗口内点「刷新」看不到变化。

可观测性（同一 issue 的第 5.4 条）：`src/index.ts` 原先有**十个**
`catch { /* 静默 */ }`，把 provider 内部告警与异常一起吞掉。现收成
`refreshTargets` 表驱动 + 一处 `ctx.logger.warn`。
⚠️ `src/service.ts`（codearts）此前**整份文件零 logger**，而它的令牌最短命 ——
续期失败将完全无痕，现已补 `refreshAll` 两个分支的日志。

测试：`tests/unit/expiry-sync.spec.ts`（19 条：lead 边界含 `<=`、一致不写盘、
1 秒容差、不传 refreshableOf、反查传凭据内容、回写失败不反噬、
「有效期内仍须对账」、续期返回 undefined 时绝不落盘）+
`tests/unit/refresh-bootstrap-wiring.spec.ts`（19 条：启动首轮排在定时器前、
十个 provider 都在表里、九个 auth 的 `refreshAccountCredential` 都带
pool/accountId 且真调共享回写、RPC 与 `createPoolRefresh` 都传 id）。

### ⚠️ 账号池的 `refreshable` 只是**凭据材料的镜像**，绝不能当续期门禁

**真实缺陷**（用户报障 2026-10-02）：「我们插件的 codearts 账号池出现 2 个 401 未认证，
自动续期没有工作吗？重启也还是 401」。

本机取证（只读 `~/.dsh/jet-hub/state.json` + `~/.dsh/.credentials.yaml`）：

| 事实 | 值 |
|---|---|
| 两个 codearts 账号在池里 | `refreshable: **false**`（9-25 的快照里同两条还是 `true`）|
| 凭据本体 | **完好**：`refresh_token` 还剩 18 天寿命（到 10-18）、`code_verifier` 64 位、`dpop_private_key_jwk` 都在 |
| 凭据的 `expires_at` | 停在 12 小时前那次成功续期上，此后**再没被写过** |
| 整个池 | 36 条里 **33 条** `refreshable:false`（loomy 4 + zcode 2 是诚实的 false）|

⇒ 旧实现 `refreshAll()` 第一行 `if (!entry.refreshable) continue` 把这个布尔变成了
**单向门**：任何一次把它写成 false 的事件之后，该账号**永不进入续期循环** ——
定时那轮跳过它、启动首轮也跳过它，于是「自动续期没工作、重启也没用」，
而凭据明明还能用。**这正是上一节「只按 `refreshable` 过滤」那条约定的代价**，
该约定已被本节修订，见下文。

**三条已落地的规则**（`src/service.ts` 的 `CodeArtsAuth.refreshAll`）：

1. **调度判据读凭据，不读池值**。`isCodeArtsRefreshable(credential)`
   （`refresh_token` + `code_verifier` + `dpop_private_key_jwk` 三样齐全）
   才是「能不能续」的权威；池里的 `refreshable` 是**每轮由凭据对账出来的结果**，
   不是「曾被服务端拒绝过」的案底。误标会在下一轮自动改回 true（自愈）。
   只有**凭据确实缺材料 / ref 下没有凭据**才写 `false`，且写前先比现值
   （`if (entry.refreshable)`）—— 定时器每 30 分钟一轮，别重复整体落盘。
   ⚠️ 读凭据只是**本地存储访问**，不花网络也不花模型额度 ——
   拿它当门禁来「省请求」是**错省**，省下的是自愈能力。
2. **判终态前先重读凭据**：续期被拒（`invalid_grant`）时，先看磁盘上那份
   `refresh_token` 是否**已经不等于**本次用来续期的那一份。并发下服务端烧掉的是
   **旧的**一份，而磁盘上此刻躺着一份**新的、可用的**凭据 —— 那是「他处已续成功」，
   不是「本账号不可续期」。少了这层判据，一次交错就把好账号永久标死。
   命中时改用**最新凭据**对账（`syncAccountExpiry`），不发终态标记。
3. **`InvalidDPoPHeader` 不算 refresh_token 失效**（`src/oauth.ts` 的 `requestToken`）。
   旧判据把它与 `invalid_grant` 并列为终态，注释写的理由是「避免每 10 分钟无限重试」，
   实际代价是一个**材料完好**的账号被标死、用户只能重新登录。DPoP proof 没过校验
   说的是「**这一次**证明不合格」（时钟偏差让 `iat` 落在窗口外 / proof 被判重放 /
   网关抖动），与「refresh_token 还能不能用」无关；归为可重试的代价只是 10 分钟后再发
   一个 HTTP 请求。终态只留 `invalid_grant` 与 `ExpiredRefreshToken`。

4. **调度器的武装门也不能读 `refreshable`**（`src/index.ts`）：原先是
   `accounts.some(a => a.refreshable)` 才武装定时器 —— 用**可能被误标的字段**
   决定「要不要启动修误标的机制」是循环依赖。本次事故实测 36 条账号只剩
   3 条 `true`（raccoon / minimax / cline 各一），再少三条，
   **codearts 的自愈与启动首轮会一起消失且日志零字**。现改为「池里有账号就武装」；
   各家 `refreshAll` 内部本就按凭据材料 / 是否过期过滤，放宽这里最多多一次本地遍历，
   不会白发请求。⚠️ 仍然**不看 `enabled`**（上一条铁律未变）。

**为什么会被标死：三条续期入口并发消费同一份 `refresh_token`。**

① `src/index.ts` 每 30 分钟（含启动首轮）的 `refreshAll`；
② 推理路径的按需续期（`llm-adapter.ts` 的「过期预判」与「401 兜底」，
   而 DSH 本身会**并发**发多条请求：主回复 + 标题生成 + 上下文压缩）；
③ Jet Hub 账号卡片的「刷新」按钮（`account.refresh`）。
华为 STS 在签发新凭据时**旧的那一份 refresh_token 即失效**，
并发下必然「1 个成功、其余 `invalid_grant`」，而失败方把它读成「账号不能续期」。

⇒ 已加 **per-`credentialRef` 的 `SerialQueue`**（`CodeArtsAuth.refreshQueues`）：
三条入口在同一进程内必然串行，且**锁内重读**凭据 —— 仍在有效期内就直接对账返回，
不再发第二次请求（少烧一次 token）。
⚠️ **该锁只在单进程内有效**：同一台机器上 dsh web 与 desktop 两个实例各自持锁，
跨进程互踩只能靠上面第 2 条兜 —— **两处都得有，少一个就会复发**。
（用户环境实测就是 web + desktop 两个 profile 都装了本插件。）

**可观测性**：真终态时日志带上**服务端原文**（`…；服务端原文：CodeArts token request failed: 400 {…}`），
且同一 ref 同一原因**只告警一次**（`terminalWarned`）—— 真失效时用户要做的是重新登录，
每 30 分钟重复同一行只会把有用信息埋掉。

⚠️ **本条修订「续期不得按 `enabled` 过滤」一节里的说法**：那句
「`refreshAll()` 只按 `refreshable` 过滤」现已不成立 —— `refreshable` **不再是过滤条件**，
而是被对账的字段。「不看 `enabled`」这条**仍然有效**（停用账号照旧要续）。

⚠️ **其余八个 provider 仍有同一个单向门**：buddy / workbuddy / lobsterai / qoder /
qodercn / trae / cline / minimax 的 `refreshAll` 第一行都还是
`if (!entry.refreshable) continue`，而取证时它们的账号**同样**大面积被标 false
（buddy 4/4、lobsterai 4/4、trae 4/4、qoder 5/5、qodercn 3/3、workbuddy 5/5 ——
凭据里 `refresh_token` 全都在）。本次只修了用户报障的 codearts；
推广时**三条规则要一起带**（读凭据对账、判终态前重读、per-ref 串行），
只搬第一条会继续误标。

测试：`tests/unit/service.spec.ts` 的「CodeArtsAuth refreshAll：以凭据为准的自愈」
（7 条：误标后自愈且**只回写一次**、缺材料才标 false、已 false 不重复写盘、
并发重放不误标且用最新凭据对账、真终态照标 false 且不损坏凭据、
单账号失败不中断其余、同一 ref 并发续期只发一次请求）+
`tests/unit/oauth.spec.ts`（`InvalidDPoPHeader` 归可重试、`ExpiredRefreshToken` 仍终态）。
⚠️ 已做**反向验证**：加回 `if (!entry.refreshable) continue` → 自愈用例变红；
队列改 `new SerialQueue({ enabled: false })` → 并发串行用例变红（实测 2 次请求）；
去掉「判终态前重读」→ 并发重放用例变红；把 `InvalidDPoPHeader` 加回终态判据 →
oauth 用例变红。四条各自独立锁死，**别把它们当同义反复删掉**。
⚠️ 已做**反向验证**：去掉 lead 过滤 + 去掉「一致不写盘」→ 7 条变红；
去掉启动首轮 + 去掉 cline 回写 → 3 条变红（含行为用例「刷新后池内
`expiresAt` 指向未来」，非同义反复）。
⚠️ 接线类断言一律用 `(pool|p)` / `[^)]*` 容忍重构与签名扩展 ——
写死整串会让每加一个 provider 或每补一个参数都假失败（该教训已记在
`cline-adapter.spec.ts` 的注释里）。


服务名由产品 id 派生（`${product.id}Auth`）：两个 `BuddyAuth` 实例分别注册为 `buddyAuth` 与 `workbuddyAuth`，`LobsteraiAuth` 注册为 `lobsteraiAuth`，两个 `QoderAuth` 实例（同一类、不同 `product`）分别注册为 `qoderAuth` 与 `qoderCnAuth`，`TraeAuth` 注册为 `traeAuth`，`ClineAuth` 注册为 `clineAuth`，互不覆盖。

⚠️ 服务名撞车会**在构造时抛** `service "..." has been registered`，故新增同族产品时
**provider id 必须互不相同** —— 这也是 `qodercn` 这个 id 不带连字符的原因
（`qoder-cnAuth` 不符合 camelCase 惯例）。

各 provider 的登录/续期机制不同（详见 README.md），但均通过 `ctx.credentials` 统一管理凭据生命周期。

## 账号池与多账号

`AccountPool`（`src/account-pool.ts`）在 `jet-hub` settings 命名空间下保存账号索引，凭据本体存于 `ctx.credentials`。要点：

- 账号条目以 `provider` 字段区分归属，`getAvailableAccount` / `listAccounts` 均按该字段过滤
- 适配器必须以 `this.product.id` 作为 provider 实参查询账号池（写死 `'buddy'` 会让 WorkBuddy 永远匹配不到账号）
- 限流后按池中「已启用且不在重置时间内」的下一个账号自动重试；全部耗尽才抛 `QUOTA_EXCEEDED`

### 账号顺序 = 选号优先级（Jet Hub 拖拽排序）

**数组顺序本身就是 `getAvailableAccount` 的候选优先级**，即自动选号与限流换号的实际取号顺序。

- ⚠️ **不要重新引入「按限流重置时间重排候选」的 sort**。早期实现有
  `candidates.sort((a,b) => resetAtA - resetAtB)`，它会让手动顺序形同虚设 ——
  用户把某账号拖到首位，只要另一个账号的重置时间更早，实际选中的仍是后者。
  现语义是「**手动顺序优先，限流豁免**」：顺序完全由用户决定，而正处于限流期的
  账号已被 `filter` 排除，不会选到
- `reorderAccounts(provider, orderedIds)`：**只动本 provider 占用的下标**，
  其他 provider 账号位置不变（账号存在一个全局数组里，设置页按 provider 分组渲染）
- `orderedIds` 必须是该 provider 全部账号 id 的一个**排列**，否则抛错。
  少了 id 若静默忽略，该账号会莫名掉到末尾（用户看到「顺序自己变了」）；
  多了未知 id 说明前后端状态不一致
- RPC：`account.reorder`；前端 `plugin-src/client/jet-hub.js` + 纯逻辑
  `plugin-src/client/account-order.js`
- ⚠️ **落点必须区分 before / after**（`dropPositionFromPointer` 按指针落在目标卡片
  上半/下半判定）。只支持「插入到目标之前」时，把卡片**往下拖一格是空操作**，
  用户会以为拖拽坏了。插入线指示（`data-dropBefore` / `data-dropAfter`）必须与
  实际落点一致
- ⚠️ **移除源元素后目标下标会前移**，必须用 `indexOf` 重算而不能复用原下标，
  否则会插到目标之后。`tests/unit/account-order.spec.ts` 覆盖了这一点

### ⚠️ 安全策略拦截（11140）：三条通道都要换号 / 标冷却，错误码**绝不能**取 `AUTH`

腾讯侧业务码 `11140`（`request illegal`，文案写「内容未通过安全审核」）**服务端嘴上说是
内容问题，实测是账号级拦截**：同一份请求体发往池里 7 个账号得到「2 通 / 4 拦 / 1 限流」，
连「你好」都被拦，换新会话照样拦（排除上下文累积）。因此它的正确出路是**换号**，
不是让用户改内容。该结论由 !15（认证路径）与 !16（限流路径）先后确立，本次补齐剩下两处。

- ⚠️ **错误码不能取 `AUTH`，也不能取 `QUOTA` / `ACCOUNT_QUOTA`**（通用教训，不限本 provider）。
  DSH 聊天 UI 的判据是（取证：`@deepseek-ai/dsh-client-ui-chat/lib/client.js:1229-1234`）：
  ```js
  if (code === "QUOTA" || code === "ACCOUNT_QUOTA") return t("message.failure.quota");
  return code === "AUTH" ? t("message.failure.auth") : message;
  ```
  即 `AUTH` 会**把整条 message 换成「API 密钥无效」**（`displayFailure()` 那里甚至强制
  `message: ""`）。!15 精心写的「全部账号均被服务端安全策略拦截…」在 UI 上**一个字都看不到**，
  还把用户引向检查密钥（实测 7 个 token 全有效、2027-09 才过期）。
  ⇒ **凡是要把自定义文案送到用户眼前，码必须避开这三个**。
  现取 `PERMISSION_DENIED`：与本仓库 `cline-adapter.ts` 的地域限制分支同码（见下文惯例），
  且**不在** `DEFAULT_RETRYABLE_CODES`（`EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`）
  里 → 确定性结论不会被 harness 白退避 5 次。
  ⚠️ 也别顺手改回 `AUTH`「与其余 401/403 口径一致」：口径一致不该以吞掉文案为代价。
- ⚠️ **被拦账号必须打冷却标记**（`markPolicyBlockedAccount`，`src/buddy-adapter.ts`）。
  !15 / !16 让「有可用账号就一定能用上」成立，但**每轮都要重撞坏账号**：候选顺序是用户拖拽定的
  （见上文「账号顺序」），实测那池前 4 个被拦 → 每次请求固定先发 4 次失败。
  复用账号池的 `modelRateLimits` 载体（它是**唯一**的「账号×模型暂时不可用」映射，没有 reason 字段），
  代价是账号卡片显示「限额重置 · 模型 · 30 分钟后」而非「安全策略拦截」；
  收益是 `getAvailableAccount` 的过滤、UI 的「重测 / 重置」两条人工解禁路径**全都现成生效**。
  ⚠️ **时长是自己定的 30 分钟（`BUDDY_POLICY_BLOCK_COOLDOWN_MS`），不要复用
  `parseRateLimitError` 解析不到时那个 1 小时兜底** —— 11140 报文里根本没有时间字段，
  走那条兜底等于把「策略拦截」冒充成「服务端限流」。也别与 cline / lobsterai / trae 的
  `*_RATE_LIMIT_FALLBACK_MS` 合并成一个常量（语义不同，调一个不该动另一个）。
  ⚠️ 标记**只随时间到期失效**：`sweepExpiredRateLimits` 在生产代码里**没有任何调用方**，
  别指望它来清过期项（判据是 `account-pool.ts:578` 的 `Date.now() >= resetAt`）。
  ⚠️ **只标该模型**（同 qoder 额度那条口径）：跨模型无实测依据，标全部模型会误伤本可用的组合。
  ⚠️ 写标记失败**只记日志、不上抛**（与 `src/expiry-sync.ts` 惯例一致）：本次的准确错误才是主线。
- ⚠️ **流内（HTTP 200 + SSE 帧）那条通道原先整帧被静默丢掉**：buddy 的帧类型里**没有**
  `code` / `msg` 字段，而 11140 恰好是顶层 `{code,msg,displayMsg}`、无 `error` 无 `choices`
  → 一路走到循环末尾，既没内容也没报错，UI 表现成「干净地停止、无任何失败」
  （与 qoder 的 10605、TRAE 的流内错误同型）。
  ⚠️ **判据必须带「这一帧没有 `choices`」这层门禁**：正文里出现「安全审核」
  /`request illegal`/字面 `11140` 是常态（模型在讨论审核策略就会说），只看 payload 字样
  会把一个合法回答判成拦截并连带标冷却。
  ⚠️ 判据与 HTTP 层**共用** `isContentRejection()`，别在流内另写一套 —— trae 那次缺陷的成因
  就是流内分支当年自己写了一套判据。
  ⚠️ 本通道按定下的口径是「**标记 + 如实报错**」，本轮不重发（重发需要「尚未产出内容」判据
  + 外层循环，那是 `3823133 fix(trae)` 那种结构改造，不在本次范围）；下一轮选号会自动绕开。
  故报错文案取「当前账号…」而非「已逐个换号重试」——**文案必须与是否真换过号一致**。
- ⚠️ **单账号池 + 续期失败**时，`credential expired and refresh failed` 那条早退分支
  **也必须先排 11140**：单账号池必然满足「没换到号」，修复前真实原因是拦截时报的却是
  `AUTH` + 一句与凭据有关的话（写用例时实测到）。
- ⚠️ 文案里的 HTTP 状态取**最后一次拦截**的，不是首发的：「首发 401 + 途中 403/11140」
  若沿用首发状态会报出一个对不上的「HTTP 401」，把人引向「token 过期」。
- 测试：`tests/unit/buddy-adapter.spec.ts` 的
  「安全策略拦截（11140）：账号冷却 + 流内错误帧」段（7 条）。
  ⚠️ 已做**反向验证**：错误码退回 `AUTH` → **7 条**变红；禁用冷却标记 → **5 条**变红
  （含认证 / 限流 / 流内三条通道各自那条）；禁用流内识别 → **2 条**变红。

## ⚠️ 图片必须按像素预算发**请求版本**，不能恒发原图（Issue !IKITT9）

**真实缺陷**（用户报障）：带截图的会话攒到 **36 张**后**每轮都失败且不可恢复**，
自动压缩试 3 次全灭，只能新建会话：

```
buddy: 内容过长，请精简或新建任务 prompt is too long: 100001 tokens > 100000 maximum
```

⚠️ **这个 `100000` 不是上下文窗口**（`src/product.ts` 给 `deepseek-v4.1-flash`
声明的是 **1,000,000**）。报障者同一会话**纯文本 prompt 到 345,687 仍被正常接受**，
且本机 11,351 次成功请求的图片 token **无一越过 10 万**（最大 96,537 = 35 张，
36 张正好顶穿）。它是网关对**单次请求图片视觉 token 总量**的另一道限制，
计价 ≈ **617 px / token**（1721×997 ≈ 2,781 token/张）。

⇒ **排查这类"内容过长"先看数字对不对得上上下文窗口**：对不上就是别的预算，
别去改 `contextWindow`（那只会让 DSH 更早触发压缩，反而更糟）。

### 三条修复与其理由

1. **按预算缩放**（`src/image-budget.ts`）：每张固定 **640,000 px**（≈1,037 token，
   约 96 张才撞墙，且 1051×608 上 UI 小字仍可辨认 —— **不要调更小**）。
   ⚠️ **为什么是"每张固定"而不是"按本次张数分摊"**：附件服务的请求版本
   **按目标尺寸缓存**（`readImageRequest` 的缓存身份含附件 id、变换版本、
   目标尺寸、字节目标）。尺寸若随"这条会话现在有几张图"浮动，
   同一附件每次派生不同 `variantId` → 缓存反复击穿、每轮重编码，
   而且用户无法预测一张图被缩成多大。
2. **桥接 `ctx.attachments.readImageRequest(ref, target)`**（`src/index.ts` 的
   `makeReadImageRequest`）：缩放/编码交给附件服务（alpha→WebP、不透明→JPEG、
   85/75/60 质量阶梯），插件只选目标。
   ⚠️ **不可用一律返回 `undefined` 而不是抛错**，适配器据此**回退原图**：
   服务没装、老宿主没有该方法、后端拒绝投影
   （`ATTACHMENT_PROJECTION_UNSUPPORTED`）、附件引用缺 `width`/`height` ——
   四种都必须发原图。缩放是优化，**绝不能变成新的故障源**。
   ⚠️ **两层都要兜异常**：写用例时实测到"只靠桥接层吞异常"不够
   （桥接是运行时约定、类型系统不保证），适配器的 `projectRequestImage`
   自己也 `try/catch` 返回 `undefined`。
   ⚠️ 但**不得削弱原有护栏**：`readImage` 读不到字节仍必须抛
   `UNSUPPORTED_CONTENT`（那是"静默丢图"回归防线）。
3. **11115 的分类不得依赖 `extError` 是否存在**：harness 的
   `isContextWindowExceededError` 五个分支都要求出现 `context` / `for this model`
   之类字样，实测对以下三种形态**全部返回 false**（只有带
   `extError.code=context_length_exceeded` 的那份才命中）：
   `prompt is too long: N tokens > M maximum`／拼上中文文案的整行／
   `{code,msg,displayMsg}` 三件套。于是报障者同一会话里逐字相同的错误
   一会儿 `CONTEXT_WINDOW_EXCEEDED`、一会儿 `INVALID_REQUEST`。

   ⚠️ **漏判的代价是不对称的**，所以方向取"宁可多判一次溢出"：
   `INVALID_REQUEST` **不在** `DEFAULT_RETRYABLE_CODES`
   （`[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]`）→ 不重试；
   更关键的是 `dsh-compaction-basic` 的 request-error listener
   **第一行就是** `if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE) return next()`
   → 连"试一次压缩"的机会都没有，会话每轮直接报废。归成溢出的最坏结果
   只是一次无效的压缩尝试。
   ⚠️ 补的判据必须**窄**：同时要求「prompt is too long」与「N tokens > M」，
   只认前者会把别的内容类 400 误判成溢出（有用例锁着）。

### 范围与**有意未做**项（别当成漏改）

**实测过的九家**（2026-09-28，用 `tests/fixtures/test.png` 2560×1600 = 4.10M px/张
≈6,639 token/张，逐级加张数、每次只加图片、文本固定）：

| provider | 边界 | 失败形态 | 撞的是什么 |
|---|---|---|---|
| **buddy / workbuddy** | **15 张** | `prompt is too long: 100001 tokens > 100000 maximum` | **图片视觉 token 预算** |
| **raccoon** | **4 张** | `HTTP_413: request body exceeds 10MB` | **请求体字节**（10 MB 硬限）→ 缩放后 **24 张全过** ✅ |
| **qoder** | 8 张过 / **15 张** | `TRANSPORT: fetch failed`（≈57 MiB） | **请求体体积** → 缩放后 **24 张全过** ✅ |
| **lobsterai** | 12 张过 / **13 张** | `SERVER code=500`（≈50 MiB） | **请求体体积**（不是预算 —— 500 不是准入报文）→ 缩放后 **24 张全过** ✅ |
| **cline** | 24 张（≈159K token）全过 / **32 张** | `TRANSPORT` | **请求体体积** → 缩放后 **32 张全过** ✅ |
| **loomy** | **24 张全过** | — | 未撞墙（本 fixture 下），故未接缩放 |
| **trae** | **未探到边界**（本轮只测了 1 张，通过） | — | ⚠️ **上一轮的「1 张即 4001 仅可见但不可调用」已被推翻**，见下 |
| codearts | 未测 | — | 其 `deepseek-v4` 系是华为云免费福利额度，非用户候选模型 |

⚠️ **trae 那格是本轮最该记住的教训**：上一轮同一账号对
`deepseek-v4.1-flash` 与 `glm-5.3-flash` 都回 `4001 param is invalid`
（适配器诊断「仅可见但不可调用」），据此登记成「探测无效、拿不到阈值就不定值」。
**本轮同一账号、同一模型，1 张直接成功，缩放后 24 张也全过** ——
说明那是**账号/服务端的临时状态**，不是模型的固有属性。
⇒ 与 Qoder「无签到」（!IKIRTT 之前的误判）同型：**「某次实测没看到」不能推广成
「不存在」**。引用一条否定性结论时，必须带上「何时、哪个账号、什么形态」，
并在下次探测时**先重验这条否定结论本身**，而不是把它当前提。
⚠️ 但**也不要因此就给 trae 定预算值**：它的原图边界仍未探（本轮只测 1 张原图），
**拿不到阈值就不定值**这条规矩不变。

⇒ **只有腾讯系真有「图片 token 预算」这道约束**，其余各家撞的都是
**请求体体积**（各家阈值不同：raccoon 10 MB、lobsterai ≈50 MiB、
qoder ≈57 MiB、cline ≈122 MiB）。两种约束**只有缩放图片这一个共同解法**，
但**旋钮不同**：token 预算看**像素**，体积限制看**编码字节**。所以：

- **已接缩放的七处**：buddy / workbuddy（像素 640,000，字节默认 2 MiB）、
  raccoon（像素 + **字节 512 KB**，因它硬限 10 MB）、
  qoder 与 qodercn（**同一个 `QoderAdapter` 类**，像素 + 字节 1 MiB —— 改一处两站同时受益）、
  lobsterai、cline（各 像素 + 1 MiB）。
- ⚠️ **字节目标各不相同是有意的**：raccoon 512 KB（10 MB 配额要撑到 14 张）、
  qoder / lobsterai / cline 1 MiB、buddy 2 MiB。**别合并成一个常量**，
  也别把 buddy 的 640,000 当全局像素预算推给别家 ——
  这正是本仓库 `endpoint` 那条教训的形状。
- **未接的两家**：loomy（实测 24 张全过，无证据说明它有约束）、
  trae（⚠️ **理由已变**：原来说「探测被『仅可见但不可调用』挡住」，
  而本轮该账号同一模型已能正常收图 —— 旧理由失效，但**新理由仍然成立**：
  它的**原图边界从未探过**（本轮只测了 1 张原图就通过），
  **拿不到阈值就不定值**这条规矩不变）。
  ⚠️ 别"为了统一"给它们塞一个猜出来的预算。
- ⚠️ **接线漏改的教训**：本轮先改了适配器**却没在宿主桥接**，
  结果 qoder / qodercn / lobsterai / cline 四家的修复**静默不生效**
  （适配器有 `readImageRequest` 选项但 `index.ts` 没传 = 永远走原图路径）。
  是 `tests/unit/image-budget.spec.ts` 里那条「宿主侧桥接计数」断言抓出来的。
  ⇒ 接新 provider 时**适配器 + 宿主桥接两处都要改**，用例两处都锁。
- ⚠️ **探针自身的接线错误会被「回退原图」掩盖**（本轮真踩到，代价是一轮 90 秒的
  真机探测得出**错误结论**）：e2e 里把 `makeScaleBridge(fixture)`（一个
  `{bridge, stats}` 包装对象）误当函数注入 `readImageRequest`，适配器调用它必然抛错，
  而 `projectRequestImage` 的 `try/catch` 把异常兜成「**回退原图**」——
  症状于是是「**缩放后照样 413**」，看起来像字节目标定小了，实际是根本没缩放。
  ⇒ 因此 `makeScaleBridge` 返回 `stats` 记录每次派生，
  **用例必须先断言 `stats.length > 0` 再断言结果**。
  推而广之：**任何"回退到旧行为"的兜底都会把接线错误伪装成产品缺陷**，
  这类兜底旁边必须有一条「兜底是否被触发」的可观测证据。

⚠️ **探测方法论**（这轮踩出来的，重测时必须保持）：
- **必须先跑 0 张基线**。第一版探针直接上 15 张，qoder 报 `TRANSPORT`、
  raccoon 报 `AUTH 200003` —— 两个都不是图片问题（raccoon 那个账号缺
  `office_identity`，qoder 是凭据过期），却被读成「撞墙了」。
- **只有 `prompt is too long: N tokens > M maximum` 这种报文才算图片预算**；
  `413` / `TRANSPORT` / `500` 都是体积或稳定性问题（`classifyFailure` 已分类）。
- **要逐个账号验号**：实测本机 8 个 qoder 账号里 4 个 refresh_token 已失效、
  3 个当日额度耗尽，只有 1 个可用 —— 拿 `[0]` 就用会得到假的「探测失败」。
- **0 张基线的结论必须驱动「跳过」而不是「失败」**（`assertBaselineUsable`）。
  本轮为省额度把几个用例改造成「只测缩放后」，**顺手把 0 张基线删了** ——
  于是 cline 的当日免费额度耗尽（`429 Daily free limit reached … 19h 55m`）
  被记成「缩放后仍被拒」，看起来像产品缺陷。基线一条请求几乎不花额度，
  却能把「账号不可用」与「图片链路有问题」彻底分开。
  ⚠️ 判据**只看基线**：基线通过后任何失败都算真失败，不许「一失败就跳过」
  （那就成了静默空测，比误报更糟）。
- ⚠️ **「失败就回退到旧行为」的兜底会把接线错误伪装成产品缺陷**（本轮真踩到）：
  e2e 里把 `makeScaleBridge(fixture)`（`{bridge, stats}` 包装对象）误当函数注入
  `readImageRequest`，适配器一调用就抛错，`projectRequestImage` 的 `try/catch`
  把异常兜成「回退原图」→ 症状是「**缩放后照样 413**」，看着像字节目标定小了，
  实际是**根本没缩放**，白跑一轮 90 秒真机探测并得出错误结论。
  ⇒ 探针必须先断言 `stats.length > 0`（缩放真被调用），再断言结果。

### ⚠️ 待观察：`cline-auth.spec.ts` 的一次无法复现的失败（别忽略，也别当成已修）

本轮某次 `pnpm test` 出现过 2 条失败，都在
`tests/unit/cline-auth.spec.ts > ClineAuth refreshAll`：

- 「只按 refreshable 过滤，**不看 enabled**」
- 「按需续期（账号卡片「刷新」）成功后把新 expiresAt 写回账号池」

**当时的现场**：同一轮我正在并发跑真机图片 e2e（长跑、重负载）。
**之后的验证**：单独跑该文件 26 条全过；全量连跑 3 次均 2833 全过；
`--no-file-parallelism` 连跑 5 次全过。**未能复现**。

**已排除的解释**（都查过，不成立）：
- 不是本轮改动引起 —— `git status` 显示未触碰 `cline-auth.ts` 及其 spec；
- 不是「5 分钟凭据到期」—— `shouldRefreshNow` 对 `now+300_000` 恒为「该刷」，
  该值不会随墙钟翻转；且 `isClineRefreshable` 只看 `refresh_token` 存在性；
- 不是文件系统/环境依赖 —— 该用例用全内存 `Context` + `FakeCredentials`
  + `AccountPool`（`store.kind === 'memory'`）；
- 不是 `services` 数组泄漏 —— 已有 `afterEach` 的 `splice(0)` 清理。

**下次复现时要看的东西**（别再从零猜）：
① 失败时 `fetcher` 的**实际调用次数**（期望 2，推测会得到 0）；
② 两条失败是否**同时**出现（若是，指向 `refreshAll` 早退而非断言问题）；
③ `pool.listAccounts('cline')` 返回的条目数；
④ 当时是否在并发跑 e2e —— 若只在重负载下出现，方向是**测试的时序假设**
   而非产品逻辑（该 spec 的 `AccountPool` 用 `void credentials.set(...)`
   预热，见 `makeCtx`，这是目前唯一可疑但未证实的点）。

⚠️ **不要因为"跑几次都过"就删掉这条记录**，也不要假装修好了 ——
它可能是重负载下才暴露的真实竞态，记着现场比假装干净更有价值。
  ⚠️ 且**不能强制续期才肯用**（第一版的 bug）：刚登录的新号续期反被拒，
  于是被跳过，最后落到一个签名有效但额度耗尽的旧号上。判据是
  「**先看是否过期**，未过期直接用；再用一次无图请求验号」。
- **张数必须互不相同的 `attachmentId`**：`collectImages` 按 id 去重，
  复用同一 id 会把 15 张压成 1 张，探针「顺利跑完」却一点压力没造出来。

⚠️ **未实现 `imageRequestPricing`**（issue 建议的第 4 步，仍然不做）：
它需要「网关每张图的视觉 token 计价公式」，而我们**只有从失败点反推的
≈617 px/token**（buddy 15 张撞 100,000 时估算 99,579，差 0.4% —— 已足够
用来定预算，但**不足以**用来喂压缩器：猜错方向会让压缩过早或过晚触发）。
缩放已让 15 张从 100,038 降到约 46,903，触发条件本身消失了。
⚠️ 顺带记一条已核实的机制：不实现它时 `dsh-token-meter` 对图片走
`estimateStructuralBlock`（**只按引用 JSON 的字符数**计价，一张大图 ≈56 token），
而压缩阈值是 `min(contextWindow×0.8, …)` = 800,000 —— 所以「图片压力」
在 token meter 眼里几乎不可见，**指望自动压缩兜底是不成立的**
（这正是报障会话里"压缩试了 3 次全失败"的机制解释）。

测试：`tests/unit/image-budget.spec.ts`（29 条：几何含"小图不放大/细长图/非法输入"、
四种回退路径、产品级预算、三条分类护栏、`projectRequestImage` 共用投影、
raccoon 用**自己的** 512 KB 而非 buddy 的 2 MiB、**七处接线断言**）。
⚠️ 已做**反向验证**：去掉 cline 缩放 → 接线断言变红（报「未走共享投影」）；
去掉新增分类判据 → 1 条变红（报 `expected 'INVALID_REQUEST' to be
'CONTEXT_WINDOW_EXCEEDED'`，非同义反复）。
e2e：`tests/e2e/image-burst-cross-provider.e2e.spec.ts`（跨家探测 + 腾讯两站的
复现/修复/可辨认性验证），**消耗真实积分**；闸门与 fixture 说明见
`tests/e2e/README.md`。
⚠️ 曾有一个 `image-request-probe.e2e.spec.ts` 专测腾讯系，已**并入**上面那个文件 ——
它的 fixture 加载、YAML 凭据解析、缩放桥接与张数序列与后者**完全重复**
（两份实现必然漂移，是本仓库反复告诫的形状），而它两条独特断言
（buddy 的 `CONTEXT_WINDOW_EXCEEDED` 归类、缩放后仍可辨认）都已搬过去，
且现在两站都覆盖（原来只测 buddy，**workbuddy 从未被端到端验证过**）。

## 单次输出上限（`maxOutputTokens`）必须下发，不能只用来过滤

腾讯系两个端点（scoped `/console/enterprises/personal/models` 与 `/v3/config`）
**都下发 `data.models[].maxOutputTokens`**。它是权威的单次请求输出额度，适配器
**必须消费并写进请求体的 `max_tokens`**，同时在 `resolveModel` 里声明为
`defaultMaxTokens`（DSH 只在调用方未显式给值时用声明的默认值兜底）。

**真实缺陷**（用户报障）：`deepseek-v4.1-flash` 的回答在 **32000 token** 处被
截断，`turn/end` 为 `{kind:'max-tokens'}`，UI 报「已达到输出 token 上限」。
根因不是「网关固定上限」，而是适配器早期**只把 `maxOutputTokens` 当作
`isChatModel` 的过滤判据**（≤256 视为补全模型），从不下发 → 上限永久退回网关
默认值，而网关默认恰好就是 **32000**（远端 `auto` / `glm-4.6` 等声明的即为此值）。
远端对 `deepseek-v4.1-flash` 实际声明的是 **128000**。

要点：

- 取值优先级：`options.maxTokens`（DSH 注入）→ 远端 → 产品兜底表；
  **三者皆无则不发该字段**，不编造数值（编大被上游拒、编小无谓截断）
- ⚠️ **远端是外部输入，非法值必须过滤**：`positiveMaxTokens` 只放行安全正整数。
  DSH 对 `defaultMaxTokens` 有硬校验，`0` / 负数 / `NaN` 会直接抛
  `INVALID_MODEL_MAX_TOKENS`，**整轮对话起不来**（不是降级，是崩）
- 实测（2026-09-19）各端点值不完全一致：`deepseek-v4.1-flash` 在 scoped 端点
  为 128000、`/v3/config` 为 131072。与 `maxInputTokens` 同策略 —— 采信实际
  命中的那个端点，**不做跨端点取大**
- 网关**确实接受且精确生效**：`max_tokens: 64` 会精确截断在 64
  （`finish_reason=length`、`completion_tokens=64`）。验证脚本
  `scripts/verify-max-tokens.mjs`（用国际版限免的 v4.1-flash，`credit: 0`）
- `reasoning_tokens` **计入** `completion_tokens`：思考内容与正文共享同一额度，
  故思考开到 `max` 时正文更早撞上限。「单次请求」≠「单轮」——每 step 独立预算，
  超长文件仍需拆多步写
- 排查脚本（均为**只读 GET**，零模型额度）：`scripts/dump-max-output.mjs`
  导出全模型 `id → maxOutputTokens`；`scripts/probe-max-output.mjs` 打印原始条目

## 模型计费倍率与同名模型（必须写进 `name`，不是 `description`）

**倍率必须拼进 `name`。** 这是被用户报障纠正过的结论：

- composer 的**模型切换菜单只渲染 `name`** —— `dsh-client-ui-model-selection`
  的 ModelSelect 里只有 `title: model.name` 与 `children: model.name`，
  **完全不读 `description`**。
- `description` 只在 **`/model` 弹窗**里用（`optionsOf` 的 `detail`，渲染成
  `提供方 · description`）。

**真实缺陷**（用户报障）：「消耗倍率没有显示在切换模型列表的后面」——
早期版本把倍率放进 `description`（因为误以为那是"唯一的展示位"），
结果在切换菜单里根本不可见。

安全性：`name` **纯属展示**，DSH 的选择与持久化只用 `id`
（`selectionOf` 返回 `model: model.id`），故附加价格不会污染会话历史。

展示形态：`Deepseek-V4.1-Flash · x0.03`；有促销时 `GLM-5.3 · x0.79→x0.50`
（箭头比「（促销 …）」短，适合窄菜单）。

三套远端的倍率字段**形态互不相同**，绝不可共用解析：

| provider | 字段 | 真实形态 | 归一化 |
|---|---|---|---|
| `buddy` / `workbuddy` | `data.models[].credits` | **字符串 `"x0.29"`**（x 在前），早期带 `"x0.03 credits"` 后缀，可为空串 | `normalizeCreditsRate` |
| `buddy` / `workbuddy` | `modelPromotions[].discount.discountedCredits` | **字符串 `"0.50x"`（x 在后！）**，已结束占位为 `"0x"` | `normalizeDiscountedRate` |
| `lobsterai` | `data[].costMultiplier` | **裸数字 `0.05`** | `displayNameFor` 里拼 `x${n}` |
| `qoder` | 目录 `chat[].price_factor` | **裸数字**，`0` = **免费**，另有 `original_price_factor` + `promotion` | `qoderDisplayName` |
| `trae` | `display_contact_config.consumption_rate.data.rate`（**该字段本身是 JSON 字符串，须二次 `JSON.parse`**） | **裸数字** `0.08`；`0` = 免费；`enable:false` = 无倍率 | `traeDisplayName`（活动期拼 `x原价→x折后价`） |
| `codearts` | 无 | 两个目录端点都不含计费字段 | — |

要点与坑：

- ⚠️ **`credits` 与 `discountedCredits` 的 x 位置相反**（`"x0.29"` vs `"0.50x"`）。
  早期版本只认前缀写法，导致**促销价全部静默丢失** —— 单测直接暴露了它。
  两个 `normalize*` 函数各自接受两种写法（对上游格式变更更鲁棒）
- ⚠️ **两个端点下发的模型 id 集合不同，必须取并集**（实测 2026-09-21，
  账号 `3C656A62`）：
  ```
  scoped     → hy4-preview, hy4-preview-x   （30 个模型）
  /v3/config → hy4-preview-f                （22 个模型）
  促销 modelIds → ["hy4-preview-f"]         ← 只挂在 v3/config 独有的那个 id 上
  ```
  而 `hy4-preview-f`（新用户限时免费变体）**被 craft/ask/plan 三个 agent 引用**
  —— 服务端明确说它可选。早期只返回 scoped，于是该促销永远对不上，
  界面显示 `x0.29` 而 IDE 显示免费（用户报障「hy4 preview 现在 ide 是免费
  我们还是 0.29」）。**不同账号下发的变体 id 也不同**（另一账号两端都是
  `hy4-preview`，所以它没暴露这个问题）—— 排查时**必须多账号对照**
- ⚠️ **`reconcileWithFallback` 是白名单式重建，会丢弃不在兜底表的 id** ——
  上面那个 `hy4-preview-f` 正因此被丢掉。判据用 **`agentReferenced`**
  （服务端自己的「可选」信号，由 `parseModelsFromConfig` 收集**全部** agent
  的引用），**不要猜 id 后缀**：`-f` / `-x` / `-sg` / `-ioa` 含义各异，
  猜错会放进不可用的模型。追加时放在**末尾**，不打乱兜底表顺序。
  ⚠️ `auto` 与 **`default`** 是同类内部别名（都不被 agent 引用），
  由 `isAutoSelectAlias` 过滤；但**不要前缀匹配** —— 会误伤国际版
  被 craft 引用的 `default-model` / `fast-model` 等抽象别名
- ⚠️ **促销只由 `/v3/config` 下发，企业模型端点（scoped）没有**（实测 2026-09-21：
  scoped 的 25948 字符响应里 `discount` / `promo` / `0.50x` 出现 **0 次**）。
  而 scoped 被**优先返回** → 早期实现直接 `return scoped`，于是**促销永远不显示**
  （用户报障「codebuddy 的倍率显示也是没折扣的，GLM-5.2 是 0.5，现在显示 0.79」）。
  现补一次 `/v3/config` 并**同时取它的模型与促销表**（失败不影响列表）
- ⚠️ **必须按 `schedule` 本地推算此刻是否生效，不能只看 `enabled`**：
  实测 `glm-5.2` 有两条**互补**活动（夜间 `23:00–7:50` 带 `0.50x`、
  白天 `7:50–23:00` 只带角标）。不看时段就按 priority 恒定取夜间那条 →
  **白天也显示折扣价**，用户按折扣价预期却被按原价计费。
  时段字段是 `schedule.daily[].{start,end}`（`HH:MM`，**小时可能不补零**如 `7:50`）
  + `schedule.timezone`（用 `Intl` 换算，别硬编码 +8）+ `validFrom`/`validUntil`。
  时区不可解析时**不误杀**（宁可多显示一次折扣）
- ⚠️ **`factor: 0` 是「免费」，不是「活动已结束」**：实测 `hy4-preview` 的夜间活动
  是 `{discountedCredits: "0x", displayMode: "replace", factor: 0}` —— 它**真的免费**。
  早期把 `0x` 一律当哨兵丢弃，于是「夜间免费」永远不显示
  （用户报障「hy4 preview 夜间 0，现在显示 0.29」）。**「已结束」由有效期表达**。
  防御：**无任何时间窗口**的 `factor: 0` 仍按占位跳过（免费额度必然限时）
- ⚠️ `modelPromotions` 是**数组**（不是对象），且用 `modelIds[]` **按模型关联**
  （不是全局折扣）；同模型命中多个活动时取 `priority` 最高者
- ⚠️ **`/v3/config` 有 UA 校验**：UA 不对返回 `{"code":12403,"msg":"check ua,
  get coding copilot version error"}`（**HTTP 200**，极易误判为「该端点没有促销」）。
  必须带产品的 `userAgent`（CodeBuddy 实测 `CodeBuddyIDE/1.106.1`）
- ⚠️ **LobsterAI 的 `description` 可能已自带倍率文案**（实测 DeepSeek-V4.1-Flash
  写着「分时计价：当前空闲时段 x0.05…」）。前置倍率前必须 `includes` 判重，
  否则出现「x0.05 · …x0.05…」重复
- `reconcileWithFallback` 是**白名单式重建**：新增的远端字段不在此显式搬运就会
  被静默丢弃（`creditsRate` / `discountedCreditsRate` 已加）

### ⚠️ TRAE 思考档位：多通道合并**不得**用空档位条目覆盖有档位的条目（Issue IKI7WT/IKILR7）

**真实缺陷**（用户报障「模型缺少思考强度」）：`parseTraeBatchModelList` 用
**无条件「后面的覆盖前面的」**合并同名模型，其注释假设「后面的条目带着更完整的
配置」——**该假设与真实数据正好相反**。上游把**空档位**的 `solo_work_lite` /
`solo_design_remote` 等条目排在**最后**，于是信息更全的条目被覆盖成了更空的条目。
UI 表现为 `TraeAdapter.reasoningFor` 返回 `undefined` → 不声明 `reasoning` →
「当前模型未提供推理等级」。

实测（2026-09-26，`scripts/probe-trae-reasoning-order.ts`）：**13 个模型**丢掉档位
（`deepseek-v4.1-flash` / `glm-5.2` / `glm-5.3` / `kimi-k3` / `qwen3.8-max` /
`DeepSeek-V4-Flash-Official` / `DeepSeek-V4-Pro-Official` …）。修复后目录里
**有档位的模型从 5 个恢复到 15 个**。

同一模型在不同通道的档位**不一致**（这正是「后覆盖前」出事的原因）：

| 通道 | `deepseek-v4.1-flash` 的 `reasoning_effort_config` | 顺序 |
|---|---|---|
| `chat_v3` | `{default:high, options:[light,high,extra_high], support_thinking:true}` | 早 |
| `solo_agent` | 同上，且 `max_tokens` 32000 / `context_window.max` 1000000 / `max_mode:true` | 中 |
| `solo_agent_remote` / `solo_agent_lite` | 同上 | 中 |
| `solo_work_remote` / **`solo_work_lite`** | `{options:[], support_thinking:false}` | **最后** |

修正后的合并规则（三条，见 `parseTraeBatchModelList` 注释）：

1. **空档位不得覆盖有档位**（已选有档位 + 候选无档位 → 保留已选）；
2. **两侧都有档位时按 `channelPriority` 取更靠前者**（默认 `TRAE_CHANNELS`，
   「顺序即优先级」，故通常落到 `solo_agent`）；
3. **其余情形（含两侧都无档位）保持既有「后覆盖前」**，避免与本缺陷无关的
   通道迁移 —— 这条保证 `glm-5.1` / `qwen-3.5` 等无档位模型行为**逐字节不变**。

四个必须记住的点：

- ⚠️ **档位必须与 `function` 同源，整条择优**：发档位的通道必须正是声明支持它的
  通道。**不要**只把 `reasoningConfig` 单独搬运到另一条条目上（例如保留
  `solo_work_lite` 的 `function` 却声明档位）——那是在一个自称
  `support_thinking:false` 的通道上宣布档位。
- ⚠️ **判据必须与 `TraeAdapter.reasoningFor` 完全一致**：配置存在 **且**
  `support_thinking !== false` **且** `options` 非空（`declaresReasoningOptions`）。
  只判「配置存在」会选中 `{support_thinking:false, options:['high']}` 这种
  适配器里仍返回 `undefined` 的条目，**等于没修**。两处改动必须同步。
- ⚠️ **可调用性不受影响**：候选始终只来自**列出了该模型的通道**，故无论选中哪条
  都不会路由到「未列出该模型」的通道（那才会回流内 4001）。已实测：
  `deepseek-v4.1-flash` 通道从 `solo_work_lite` 迁到 `solo_agent` 后，
  不带档位与 `reasoning_effort=extra_high` **各发一次均 HTTP 200、正常返回**。
- ⚠️ **`DeepSeek-V4-Flash` / `DeepSeek-V4-Pro`（无后缀）修好后仍然无档位** ——
  它们**所有**带档位的通道条目都被 `is_invisible_to_user=true` 剔除（官方隐藏），
  只剩 `solo_coder` / `chat` 的可见条目。这是官方可见性，**不是**合并缺陷；
  带 `-Official` 后缀的那两个已正常恢复。

排查/回归：

- `scripts/probe-trae-reasoning-order.ts` —— 按上游顺序回放「后覆盖前」，列出被吃掉的
  模型与修复后的目录（只读，零额度）
- `scripts/probe-trae-merge-replay.ts <模型 id…>` —— 打印指定模型在**全部通道**的条目
  （含三条硬过滤的 DROP 原因、`max_tokens` / `context_window` / `max_mode` 差异）
  与最终合并结果
- `tests/unit/trae.spec.ts` 的「档位不被空档位条目覆盖」段（7 条）—— ⚠️ 已做**反向
  验证**：临时退回「无条件后覆盖前」时其中 4 条会失败，故不是同义反复
- `tests/e2e/trae-reasoning-probe.e2e.spec.ts`（`pnpm test:e2e:trae-reasoning`，**消耗
  额度**，双闸门 `DSH_TRAE_REASONING_E2E=1` + `…_CONFIRM=yes`）—— 真实目录档位断言
  + `resolveModel` 真声明出 `efforts` + 新通道真实收发两次

### ⚠️ TRAE 账号展示名：`ScreenName` 是自动生成的默认名，必须用脱敏手机号

**真实缺陷**（用户报障 2026-09-27）：「用 trae provider 登录后用户名字显示无法区分
各个用户，有其他名字昵称或者手机尾号之类的信息可以区分吗？」

根因：`GetUserInfo` 的 **`ScreenName` 是字节 passport 按 uid 自动生成的默认名**
（`用户` + uid 片段）。实测四个账号：

形态完全雷同，一屏列出来认不出谁是谁 —— 与 Raccoon 的 `RaccoonAva`
（`buildRaccoonNickname`）是**同一类问题**。

实测可用字段（2026-09-27，四个真实账号逐个调 `GetUserInfo` 核对）：

| 字段 | 值 | 可区分性 |
|---|---|---|
| `ScreenName` | `用户<uid片段>` 等 | ❌ 自动生成、形态雷同 |
| **`NonPlainTextMobile`** | `130******00` | ✅ **末两位互异** |
| `NonPlainTextEmail` | 四个**全为空**（`LastLoginType` 均为 `sms`） | ⚠️ 仅邮箱登录有值 |
| `Description` | 全为空 | ❌ |
| `AvatarUrl` | 每人独立 hash | ⚠️ 可区分但不可读 |
| `RegisterTime` | `2026-03-28` / `2026-09-27` / `2026-08-19` ×2 | ⚠️ 有两个撞车 |
| `UserID` | `4051111222220009` 等 | ⚠️ 可区分但过长不可读 |

要点：

- ⚠️ **字段名是 `NonPlainTextMobile`**（不是 `Mobile` / `Phone`），且是**脱敏**形态
  （中间 6 位打码）。展示就照原样用，**不要试图还原或截取后四位** ——
  `130******00` 整体已足够短且可辨认
- ⚠️ **`NonPlainTextEmail` 实测为空**，别因为「有手机号就以为邮箱也有」而写死依赖；
  它只是邮箱登录账号的兜底
- 取值顺序（`traeDisplayNickname`）：**手机号 → 脱敏邮箱 → `ScreenName` → 账号 id**
- ⚠️ **手机号必须写回凭据**（不只写账号条目）：账号条目会随 Jet Hub 的账号操作
  整体重写，凭据里存一份才能在续期后稳定拿到。`applyTraeRefresh` 用 `...previous`
  展开，故自动保留 `phone` / `email` —— 改它时别把这两个字段丢掉
- ⚠️ **回调的 `userInfo` 参数不含手机号 / 邮箱**（实测只有 `UserID` / `ScreenName` /
  `TenantID`），**只在 `GetUserInfo` 响应里** —— 故 `exchangeTraeCallback` 必须真发
  那次 `GetUserInfo` 才能拿到，不能只依赖回调
- ⚠️ **老账号必须主动回填**：光改代码只影响新登录的账号。`TraeAuth.repairAccountNicknames`
  （`src/index.ts` 启动时调用，仿 `RaccoonAuth.repairAccountNicknames`）在启动时补一次
- ⚠️ **拿不到真实标识时不得改写昵称**：`Jet Hub` 允许用户手动改昵称
  （`account.update`），若退回去用凭据里的 `ScreenName` 重算，会把用户改过的名字
  覆盖成服务端默认名 —— 属无谓且有害的写入。故 `fetchUserContact` 在两者皆空时
  返回 `undefined`，调用方**直接 `continue`**
- ⚠️ **只在昵称确实变化时落盘**：`updateAccount` 是整体 replace，每次启动都写会
  平白触发一次文档写

排查 / 验证：

- `scripts/probe-trae-userinfo.mjs` —— 打印每个 TRAE 账号 `GetUserInfo` 的
  **完整响应**（只读，零模型额度）
- `scripts/verify-trae-nickname.mjs` —— 用真实账号跑一遍 `repairAccountNicknames`
  并打印修复前后昵称（⚠️ **会写真实账号池昵称**，这正是修复效果本身）
- `tests/unit/trae.spec.ts` 的「TRAE 账号展示名」段（6 条，含四个真实手机号
  互不相同的断言）、`tests/unit/trae-auth.spec.ts` 的「repairAccountNicknames
  老账号回填」段（7 条，含「无标识不改写昵称」「幂等不重复请求」）

### ⚠️ LobsterAI 账号展示名：服务端把**手机号本身**当昵称下发（露 4 位）

**用户要求**（2026-09-27）：「lobsterai 的用户名字显示的手机号尾号漏出 4 位，
现在也改为只漏出 2 位」。

⚠️ **关键事实：`130****1100` 是服务端下发的 `user.nickname` 原值，不是本插件
截取的**。`buildLobsteraiCredential` 只做 `nickname: payload.nickname ?? ''` 照抄。
实测四个真实账号的登录响应即为此形态：

故修法是**归一化掩码**（`maskLobsteraiPhoneTail`，`src/lobsterai.ts`）而非改
某个 `slice(-4)` —— 那会是个找不到的假想目标。

要点：

- ⚠️ **两种输入都收敛到同一形态，因此幂等**：完整 11 位（`13011111100`，
  `profile-summary` 返回的就是完整号码）与已脱敏的露 4 位形态，输出都是
  `130******00`。幂等意味着老账号无需重新登录、重复运行不产生新写入
- ⚠️ **判据只认「像手机号」的形态**：`/^1\d{10}$/`（完整）或
  `/^\d{3}\*+\d+$/`（已脱敏）。**绝不能泛化到任意字符串** —— 那会把真实昵称
  （`用户<uid片段>` / `<自定义昵称>` / 邮箱形态）一起打掉。单测有专门一条守这个
- ⚠️ **星号个数按原串总长推算**（`总长 - 3 - 2`），长度保持不变；
  故对非 11 位的号码也自洽
- ⚠️ **末 2 位必须仍可区分**：四个真实账号掩码后为
  掩码把区分度也抹掉就失去意义了（单测断言 `Set.size === 4`）
- ⚠️ **老账号必须主动回填**：`LobsteraiAuth.repairAccountNicknames`
  （`src/index.ts` 启动时调用，与 `RaccoonAuth` / `TraeAuth` 同名方法同一模式）
- ⚠️ **纯本地、零网络**：掩码只依赖凭据里的昵称（与 TRAE 那条需要发
  `GetUserInfo` 不同）。单测断言 `fetcher` 未被调用
- ⚠️ **只在昵称确实变化时落盘**：`updateAccount` 是整体 replace

排查 / 验证：

- `scripts/probe-lobsterai-profile.mjs` —— 打印 `profile-summary` 的完整响应
  （**发现 `nickname` 在这里是完整号码 `13011111100`**，与登录响应的脱敏形态不同）
- `scripts/verify-lobsterai-nickname.mjs` —— 用真实账号跑一遍
  `repairAccountNicknames` 并打印修复前后昵称（⚠️ **会写真实账号池昵称**）
- `tests/unit/lobsterai.spec.ts` 的「手机号掩码（只露末 2 位）」段（8 条，
  含「非手机号形态原样返回」「末两位仍可区分」）、
  `tests/unit/lobsterai-auth.spec.ts` 的「老账号展示名回填」段（7 条，
  含「纯本地不发请求」「幂等」）

### ⚠️ 改昵称类修复必须**重启宿主**才生效，且旧进程会覆盖你的写入

**这是本轮实操踩到的坑**（2026-09-27）：用脚本把 `state.json` 的昵称改对之后，
**几分钟内又变回了旧值**（TRAE 的 `用户<uid片段>` 复活）。

根因：**当时有一个 1 小时前启动的 DSH 宿主进程仍在运行**（PID 9616，监听 3080）。
它加载的是**旧代码**（没有 `repairAccountNicknames`），内存里的账号池是旧昵称；
而 `AccountPool` 的写入是**整体 replace**（限流标记、续期回写等都会触发落盘），
于是它的下一次写盘就把脚本的修改**原样盖回去**。

两条必须记住的推论：

- ⚠️ **`repairAccountNicknames` 是「启动时」逻辑**：改完代码必须**重启 DSH**
  才会执行。不重启的话，无论脚本改多少次，旧进程都会覆盖
- ⚠️ **手工改 `state.json` 前先确认没有宿主在跑**（`Get-NetTCPConnection -LocalPort 3080`
  或看 node 进程），否则改动会被静默回滚 —— 症状是「明明改对了，过一会儿又变回去」，
  极易误判为「修复没生效 / 代码写错了」
- ⚠️ 验证修复是否真的生效，**唯一可靠方式是重启宿主**，然后看启动日志里有没有
  `[jet-hub] 已修正 N 个 … 账号的显示名`。脚本验证只能证明「逻辑正确」，
  不能证明「线上已生效」

### TRAE 倍率（藏在 `display_contact_config` 里，且该字段是** JSON 字符串**）

⚠️ **最大的坑**：`display_contact_config` 的值是**一个字符串**，里面才是 JSON。
直接读 `entry.display_contact_config.consumption_rate` 永远得到 `undefined` ——
必须 `JSON.parse` 两次（外层响应一次、这个字段再一次）。解析函数
`readConsumptionRate` / `readActivityDiscount`（`src/trae.ts`）。

```json
{ "consumption_rate": { "enable": true, "data": { "rate": 0.08 } },
  "activity_discount": { "enable": true, "subKey": "limited_discount",
    "data": { "current": { "discount_type": "limited",
                          "before_consumption_rate": 0.8,
                          "consumption_rate": 0.08, "discount": 10 },
              "limited": { "end_at": 1790265540 } } } }
```

- 倍率是 **裸数字**（`0.08`），既不是 buddy 的字符串 `"x0.29"`，也不是
  LobsterAI 的 `costMultiplier`
- ⚠️ **`rate: 0` 是「免费」，是合法值** —— 与 Qoder 的 `price_factor: 0` 同类，
  用 `> 0` 过滤会恰好漏掉免费模型；展示为「免费」而非 `x0`
- ⚠️ **`consumption_rate.enable === false` 视为「无倍率」**，不是「倍率 0」

#### ⚠️ `activity_discount.enable === true` **不等于**当前有折扣

**实测陷阱**（2026-09-20，与 Qoder 的 `promotion` 同类：**标志为真不等于当前生效**）：
`off_peak` 型条目形如

```json
{ "type": "none", "before_consumption_rate": 0.13,
  "after_consumption_rate": 0.13, "discount": 100 }
```

`enable` 是 `true`，但 `discount_type` 为 **`"none"`**、`before === after`
（`discount: 100` 是百分比制下的「无折扣」）。**照显会得到 `x0.13→x0.13`**，
让用户以为有活动。三条判据缺一不可（`readActivityDiscount`）：

1. `enable !== false`；
2. `data.current.discount_type` 存在且**不是 `"none"`**；
3. `before_consumption_rate` 为正，且**严格大于** `consumption_rate`。

另外 ⚠️ **`end_at`（Unix 秒）仅 `limited` 型带**（`subsidy` / `off_peak` 没有）。
**已过期必须整个不展示折扣** —— 否则用户按折扣价预期、实际被按原价计费。

展示形态由 `traeDisplayName`（`src/trae-adapter.ts`）拼装：
常态 `Qwen3.8-Flash · x0.08`；活动期 `Seed-2.1-Pro · x0.8→x0.08`。
`resolveModel` 的 `name` **不带**倍率（与 Qoder 一致）。兜底表路径**不显示倍率**
（兜底表无该字段，不猜价格）。

实测参考值（2026-09-20，`solo_agent` 可见集）：`glm-5.3-flash` x0.06、
`qwen3.8-flash` x0.08、`deepseek-v4.1-flash` x0.13、`glm-5.2` x0.78、
`qwen3.8-max` x1.5、`kimi-k3` x1.83；同一模型在三个通道的 `rate` **一致**。

### Qoder 倍率（`price_factor`，与腾讯系语义不同）

模型目录来自本机加密缓存 `~/.qoder/.models/{uid}/catalog-v6`
（`chat` 场景 17 个模型），倍率字段是 **`price_factor`**：

- ⚠️ **不是 `cost_multiplier`** —— 那是 LobsterAI 的字段名，两者易混
- ⚠️ **`price_factor: 0` 是「免费」**（实测 `qfmodel` / Qwen3.8-Flash），
  **0 是合法值**，不能用 `> 0` 过滤，否则恰好漏掉用户最关心的免费模型。
  展示为「免费」而非 `x0`
- 另有 `original_price_factor`（如 `qfmodel` 的 0.1 = 免费前的原价）
- ⚠️ **`price_factor` 是「采集时刻的生效价」，不是恒定原价** ——
  错峰窗口内它是折后价、窗口外是原价。故展示时**必须结合窗口本地推算**，
  不能直接照搬（照搬的后果：窗口一切换，界面价格就与真实计费不符）
- ⚠️ **错峰判据用 `windowStart`/`windowEnd` 本地推算（`promotionActiveNow`），
  *不*采信 `promotion.active`** —— 后者是目录下发那一刻的快照，
  客户端长时间不重启就会与真实时段脱节。窗口字段缺失时才回退到 `active`。
  生效价 = `beforePromotionPriceFactor × discountFactor`（实测三条全部吻合），
  窗口外则用原价。窗口统一 22:00–08:00（UTC+8），支持跨零点
- ⚠️ **折扣形态三个 provider 必须统一为「原价→折后价」**（TRAE `x0.4→x0.2`、
  buddy `x0.79→x0.50`、Qoder `x0.5→x0.2`）。Qoder 早期是「只有折后价 +
  中文角标」（`x0.2 错峰 4 折`），两个问题：① 看不出原价与折扣幅度；
  ② 角标与数字**冗余**（0.2/0.5 本就是 4 折）。用户要求对齐 TRAE。
  `promotion.badgeZh` 因此**不再参与展示**（字段保留，目录原始数据仍可对照）
- ⚠️ **本表的倍率数值必须逐条对照 catalog，不要凭印象填**：
  早期版本多处是手工估值，与真实值大范围不符（**14 个模型有偏差**：
  `smodel` 写 3.2 实际 8、`qmodel_38max` 写 0.5 实际 0.2、`auto` 写 1 实际 0.5 …），
  用户报障「qwen3.8-max 是 0.5 打折到 0.2，界面显示的是 0.5」。
  ⚠️ 而当时的单测**只断言了 id 列表**，所以价格漂移长期未被发现 ——
  改这张表时必须同步更新数值断言（`qoder-product.spec.ts`）
- `resolveModel` 的 `name` **不带**倍率后缀（价格只属于选择列表语境）

**解密该缓存**（`decryptModelCatalog`，`src/qoder-wasm.ts`）：

⚠️ **第二个参数是 `uid`，不是 `machine_id`**。两个官方调用点容易读反：
目录缓存的 `readSharedCacheSnapshot(A)` 传 uid，BYOK 的
`model_cache_decrypt(i, n)` 传 machineId。传错会得到
`AES-GCM decrypt failed: aead::Error` —— 看着像密文损坏，实为参数错。
调试脚本：`scripts/probe-qoder-catalog-debug.mjs`（两个候选都试）、
`scripts/probe-qoder-pricing.mjs`（打印 17 个模型的计费字段全貌）

### 同名模型必须消歧（`buildDisplayNames`）

远端会给**不同 id 配同一个 `name`**，而 DSH 按 `name` 展示 → 列表里出现
两个完全一样的条目。实测三组：

| 组 | 远端 name | 区别 |
|---|---|---|
| `deepseek-v4.1-flash` / `-sg` | 都是 `Deepseek-V4.1-Flash` | 新加坡区，`credits` x0.00 vs x0.03 |
| `hy3` / `hy3-x` | 都是 `Hy3` | — |
| `hy4-preview-f` / `hy4-preview` | 都是 `Hy4 preview` | — |

**用户报障**：「workbuddy 国际版同时显示 2 个 ds v4.1 flash，IDE 只有一个」。
IDE 按 name 归并，我们按 id 列出。二者是**不同区域的独立计费实体**，
不能靠丢弃其一来回避。

- 算法：对每组同名 id 求**公共前缀**，剩余段作为变体标记追加
  （`Deepseek-V4.1-Flash · x0.03 SG`、`Hy3 · x0.05 X`），空剩余段者不加标记
- ⚠️ **不要硬编码 `-sg`**：撞车组随服务端上新变化，本次实测三组里只有一组是
  `-sg`；也不要「取 id 最后一段」（会把 `gpt-5.6-sol` 的 `sol` 当变体）。
  公共前缀只在**确实撞车时**才切分
- ⚠️ **倍率与变体标记都只在 `name` 里出现一次**：初版两处都写，
  端到端实测出现重复文案与「计费 x0.00 · 」这种孤立分隔符
- LobsterAI **实测无同名**（28 个模型，0 组重名），故它不做消歧；
  兜底表路径也**不显示倍率**（兜底表无该字段，不猜价格）

排查脚本（全部只读 GET，零模型额度）：`scripts/probe-pricing.mjs`（各 provider
计费字段）、`scripts/probe-promotions.mjs`（`credits` 全量与促销结构）、
`scripts/probe-lobsterai-cost.mjs`（LobsterAI 倍率归属）、
`scripts/probe-lobsterai-dupes.mjs`（LobsterAI 同名检查）、
`scripts/probe-codearts-benefit.mjs`（CodeArts benefit 集合与判定）、
`scripts/verify-description.mjs`（端到端打印**切换菜单实际渲染的 name**）

## ⚠️ CodeArts benefit（免费额度）模型：集合必须动态判定，不能硬编码模型名

CodeArts 的 `snap-access/api/v2/chat/completions` 上有**两套模型注册**：benefit
（免费额度）与非 benefit。**benefit 模型的 chat 请求必须带 `maas_type: benefit`
请求头，且该头必须参与 SDK-HMAC-SHA256 签名**，否则后端返回
`InferHub.002002009.404 The model is not registered`（HTTP 200 + SSE 内嵌错误）。
反过来，给**非** benefit 模型带该头会被拒（`unsupported model`）。

**真实缺陷**（用户报障，2026-09-23）：用 `deepseek-v4.1-flash` 发消息后失败
（`Insufficient Balance` / `QUOTA`）。根因是 `src/llm-adapter.ts` 早期把 benefit
集合**硬编码**为 `new Set(['glm-5.3-flash'])` —— `deepseek-v4.1-flash` 是
2026-09 新增的 benefit 模型，因此从不带该头，后端按非 benefit 通道处理它。

实证矩阵（2026-09-23，对齐 deveco-code-rust `fb1b4a2`）：

| 模型 id | 来源 | 不带 maas_type | 带 maas_type |
|---|---|---|---|
| `glm-5.3-flash` | gateway/config | 404 未注册 | ✓ 成功 |
| `deepseek-v4.1-flash` | gateway/config | 404 未注册 | ✓ 成功 |
| `deepseek-v4-flash-0731` | gateway/config | 404 未注册 | ✓ 成功 |
| `deepseek-v4-pro-0813` | gateway/config | 404 未注册 | ✓ 成功 |
| `deepseek-v4-flash`（无后缀） | 静态表 / 归一化结果 | ✓ 成功 | ✗ unsupported |
| `deepseek-v4-pro`（无后缀） | 静态表 / 归一化结果 | ✓ 成功 | ✗ unsupported |
| `GLM-5.2` | model/builtin | ✓ 成功 | ✗ unsupported |

结论：**`gateway/config` 返回的模型即 benefit 集合**，无需靠模型名硬编码。

要点：

- 判定 `isCodeArtsBenefitModel`（`src/models.ts`）：远端拉取并缓存的集合
  （`~/.cache/deveco/codearts_benefit_models.json`）∪ 静态兜底
  `CODEARTS_BENEFIT_FALLBACK`（`glm-5.3-flash` / `deepseek-v4.1-flash`）。
  远端集合优先，后端新增 benefit 模型**无需改代码**
- ⚠️ **只记录「归一化未改写」的 id**：gateway 下发的是
  `deepseek-v4-flash-0731`，而 `normalizeModelId` 会把它改写成
  `deepseek-v4-flash` —— 两者在后端是**不同模型、benefit 属性相反**，
  记录改写后的 id 会让无后缀模型多带 `maas_type` 而失败
- ⚠️ **判定必须在 `stream()` 的重试循环外算一次**（要读缓存文件，不宜每轮 IO）
- ⚠️ **缓存读写必须用顶层 `import { … } from 'node:fs'`，不能用 `require`** ——
  本包是 ESM（`package.json` 的 `"type": "module"`），`require` 未定义、抛
  ReferenceError 后被 `catch` 静默吞掉，表现为「写不进也读不回」（`loadModelsCache`
  的模型列表磁盘缓存曾因此长期失效）
- `deepseek-v4.1-flash` 的上下文窗口按 IDE 下发的 inferhub-provider 配置声明为
  **1000000**（与无后缀 v4-flash/pro 的 1048576 不同）
- 回归用例：`tests/unit/models.spec.ts`（集合判定 / 落盘不含改写 id / 缓存往返）、
  `tests/unit/llm-adapter.spec.ts`（v4.1 带 `maas_type` 且参与签名、无后缀
  v4-flash 不带）、`tests/e2e/v4-models.e2e.spec.ts`（真实收发，需闸门）

## ⚠️ DSH 0.1.7 把工具结果改为一等 `role:'tool'` 消息（消息形状双兼容）

**真实缺陷**（用户报障）：升级到 DSH **0.1.7** 后，带工具调用的会话出现
「**没有工具调用就认为对话结束**而提前停止」或「**模型陷入循环思考**」。

### 根因：`tool-result` 包裹块被删除，工具调用被整体剔除

0.1.7 重构了消息模型：

| | ≤0.1.6 | 0.1.7 |
|---|---|---|
| 工具结果承载 | `role:'user'` 内嵌 `{type:'tool-result',toolCallId,content,isError}` | **一等 `role:'tool'` 消息**，`toolCallId`/`isError` 在**顶层** |
| `ContentBlockMap` | 含 `'tool-result'` | **删除 `'tool-result'`**，新增 `'tool-addition'`/`'tool-removal'` |
| 角色 | system / user / assistant | 新增 **`tool`**、**`developer`** |
| `StreamChunk`（插件产出） | — | **逐字节未变** |

⚠️ **`StreamChunk` 没变，所以产出侧（`stream()`）完全不用改** —— 坏的只是
**消费**方向（harness 传给适配器的 `options.messages`）。

各适配器都按 `type === 'tool-result'` 识别工具结果，该判据在 0.1.7 下**恒不命中**：

1. 工具输出被当成普通 user 消息下发，`tool_call_id` 关联丢失；
2. `resolveToolPairing` 的 `allResultIds` 恒为**空集**
   → `usable.every(block => allResultIds.has(...))` 恒 false
   → **assistant 的 `tool_calls` 被整体剔除**。

wire 上于是完全没有工具调用记录，模型看到的是「我说了段话，用户回了段工具输出」。

**实测**（真实 session `session-54cbd95c`，2492 行 v3 日志经 0.1.7 解析器迁移）：
修复前保留 **0** 条工具调用，修复后 **512** 条，与 0.1.5 形状对照完全一致。

⚠️ **0.1.7 没有任何协议协商机制**：`packages/llm` 里 `LlmAdapter` / `GenerateOptions`
都没有版本协商字段（搜到的 `protocolVersion` 全属 ACP，与 LLM 适配器无关）。
所以**不能靠协商规避**，必须让代码同时认两种形状。

### 修法：形状归一化层，不改五个序列化实现

新增 **`src/message-shape.ts`**，把 0.1.7 形状**降级**为既有代码已理解的 0.1.5
形状，各入口只插一次调用：

- `normalizeHarnessMessages(messages)` —— 一等 `tool` 消息 → 包回
  `{role:'user', content:[{type:'tool-result',...}]}`；`developer` 消息**丢弃**
  （它只承载工具增删元数据，不是对话内容）；其余原样透传。
- `detectMessageShape(messages)` —— 判据用**形状**而非版本号（沿用
  `settings-compat.ts` 的能力探测先例），且**同时出现两种形态时以 `tool-role` 为准**
  （升级期会话可能混合；判成 legacy 会让新形态结果被漏掉，等于没修）。

⚠️ **`content` 数组必须整体保留、不压平** —— 既有实现依赖内嵌 `image` 块做图片
提升（工具结果内嵌图片须挂到其后的独立 user 消息），压平会让图片静默丢失。

⚠️ **`developer` 的剥离与形状探测相互独立**：`detectMessageShape` 只回答「工具
结果长什么样」，而 `developer` 是 0.1.7 专有角色，**无论有没有工具结果都要剥离**。
两者必须分别求值，否则「无工具结果的会话」会把 `developer` 当普通 user 消息下发。

⚠️ **无需改动时返回原数组引用**（`===`），保证 0.1.5 路径**逐字节**不受影响。

落点（6 处）：`sse.ts` 的 `resolveToolPairing`（共享防线，须自身独立正确）、
`llm-adapter.ts` / `openai-compat.ts` / `buddy-adapter.ts` /
`lobsterai-adapter.ts` / `trae-adapter.ts` 的 `serializeMessages`。
`qoder-adapter.ts` 复用 `openai-compat.serializeMessages`，自动受益。

⚠️ **`resolveToolPairing` 的 `content` 参数放宽为可选**（归一化层产出的类型允许
缺 content；函数内部本就按「非数组即视为空」处理）。这是**纯放宽**，不改变行为。

### 回归用例

- `tests/unit/message-shape.spec.ts` —— 探测/归一化/幂等/身份返回/真实字段布局
  （含 `source.callId` 回退：顶层 `toolCallId` 缺失时不能丢 id）。
- `tests/unit/message-shape-adapters.spec.ts` —— **核心不变式**：同一份语义数据按
  两种形状喂入，`serializeMessages` 输出**逐字节等价**。比逐个断言字段更强，
  且对实现方式中立。
- `tests/unit/session-replay.spec.ts` —— **真实会话回放**（离线只读，无网络）。
  自造 fixture 可能在真实数据上失效，故用真实会话锁死。需 `DSH_SESSION_FIXTURE`
  指向导出文件，未设则**干净 skip**（⚠️ 文件必须**惰性读取** —— `describe.skipIf`
  仍会执行回调体收集用例，顶层 `readFileSync(undefined)` 会让整份套件变成
  Failed Suite 而非 skip）。
- `scripts/export-session-messages.mjs` —— 只读导出真实会话消息。
  ⚠️ 必须用 `createSessionFormatCatalogWithChildren([])`（**不是**默认 catalog）：
  V3→V4 迁移要求显式提供子会话事实，无子会话时传**空数组**，否则 `createStage`
  抛 `SessionFormatUnsupportedMigrationError`。

⚠️ **验证「修复有效」必须做反向验证**：临时让 `normalizeHarnessMessages` 恒返回
原数组（= 修复前行为），确认用例**会失败**。否则可能写出一组恒真的同义反复。

## ⚠️ 持久化：DSH 0.1.7 移除 `settings.register()` 之后（Issue IKI7WT）

**真实缺陷**：升级到 DSH **0.1.7-rc.1** 后，Jet Hub 的**账号列表与模型黑名单
无法持久化**（重启即回到空列表，等于所有 provider 都"未登录"，模型目录也因
门控被隐藏）。

**根因**：0.1.7 把 `ctx.settings` 从 `SettingsProvider` 换成 **`SettingsForms`**：

| | ≤0.1.6 | 0.1.7-rc.1 |
|---|---|---|
| 注册方式 | `settings.register(ns, schema)` → owner scope（`get`/`replace`） | **没有 `register`**；命名空间 = **profile 条目 id** |
| 可见字段 | 该 namespace 的全部字段 | 只投影本条目 Config 中标了 **`.volatile()`** 的字段 |
| 写入路径 | provider 文档（旧 `settings.yaml`） | `update/replace/mutate` → profile 的 `cordis.patch.yml` |

因此 `if (typeof settings.register !== 'function')` 这条**看似安全的降级分支**
恒成立：账号池退化为纯内存。启动日志实证
`[jet-hub] settings 服务不可用，账号列表仅存在于内存中`（旧文案有误导性，
实际是"API 没了"而不是"服务没挂"）。

**修法**（`src/jet-hub-store.ts` + `src/settings-compat.ts`）：

- 持久化后端按**能力探测**：`settings.register` 可用 → 沿用老契约（数据仍在
  settings 文档，行为与 ≤0.1.6 完全一致）；否则 → 插件自有文档
  **`$DSH_HOME/jet-hub/state.json`**（同步读 + 原子写 tmp+rename）。
- ⚠️ **不要把这类运行时状态塞进插件 Config 的 volatile 字段**：限流每命中一次
  就要写一次，而写 Config 会改写 profile 的 `cordis.patch.yml` 并触发 Loader
  协调 —— 把易变数据混进用户手写的配置层，代价与风险都不划算。
- **`settingsNs` 必须跟着改**：0.1.7 起它只能是 profile 条目 id，故
  `settingsNamespaceFor(ctx, 'llm-<id>')` 解析为**本插件条目 id**
  （官方适配器同做法：`ctx.fiber.entry?.options.id`）。拿不到条目 id 时退回旧名，
  此时该 provider 在模型设置页显示为「未配置」，**不影响路由与收发**。
- **必须导出带 `.volatile()` 字段的 `Config`**：`SettingsForms.describe()` 只收录
  「有 volatile 字段」的条目，否则模型设置页把本插件的 provider 判为既非
  "已配置"也非"可添加"。本插件自带 Jet Hub 页面，故同时调
  `settings.configure({ auto: false }, ctx.fiber)` 关掉自动生成的表单。
- ⚠️ **`.volatile()` 需要 schemastery ≥ 3.18.4**（本地曾是 3.18.2，只有
  3.18.4 才有该方法）；且 `volatile()` 会把 cosmokit 的 `Volatile<T>` 带进
  `Config` 的公开类型，故 `@deepseek-ai/cosmokit` 必须是本包依赖，否则
  `tsc` 报 TS2742。

**老数据恢复**（0.1.7 把 `$DSH_HOME/settings.yaml` 改名为 `.imported`，并按
「section id = 条目 id」导入；`jet-hub` 不对应任何条目 → 该段**导入失败、成为
孤儿**）：

- 插件在状态文档**缺失**时，会从 `.credentials.yaml` 的 `refs:` 反推账号
  （只读键名，不引 YAML 依赖 —— 运行时不保证能解析 `yaml`/`js-yaml`）。
  这是**保底**：能还原"有哪些账号/用哪个 credentialRef"，
  但**拿不回昵称、顺序、enabled 与限流标记**。
- 精确还原用一次性脚本 `scripts/import-jet-hub-legacy-settings.mjs`
  （默认**预演**，`--write` 才落盘）：直接解析旧文档的 `jet-hub` 段，
  保留昵称/顺序/enabled/限流与黑名单；有任何条目缺
  `id`/`provider`/`credentialRef` 就整体拒绝写入（不导入半截数据）。
  ⚠️ 模型 id 含 `.` 与 `-`（如 `deepseek-v4.1-flash`），字段正则必须放行，
  早期写成 `[\w]*` 会让限流标记**静默全丢**。
- 排查脚本：`scripts/verify-jet-hub-persistence.mjs`（用**已构建 lib/** 以 0.1.7
  契约验证落盘与跨实例读回）、`scripts/preview-jet-hub-recovery.mjs`
  （只读预演凭据反推）。回归用例：`tests/unit/jet-hub-store.spec.ts`、
  `tests/unit/account-pool.spec.ts`（「0.1.7 契约」段）。
- ⚠️ 单测必须隔离状态目录：`vitest.config.ts` 把 `DSH_JET_HUB_STATE_DIR`
  指向一次性临时目录，否则文件后端会污染真实 `~/.dsh`。

## 模型黑名单（Jet Hub「显示列表」开关）

同一 `jet-hub` 命名空间的 `disabledModels` 字段保存「被关闭的模型」，形如 `{ buddy: { 'glm-5.2': true } }`。要点：

- **黑名单制**：只有键存在且为 `true` 才隐藏，未记录的模型默认打开（新模型上线自动可见）
- 过滤点在适配器的 `listModels`，每次调用实时读 `pool.disabledModelsFor(provider)`，改开关后无需重建适配器
- **只影响模型目录播报，不影响路由**：被关闭的模型仍可 `resolveModel` / 正常收发请求（DSH 约定：`listModels` 结果仅供参考）
- `AccountPool` 的 `writeAccounts` / `writeModels` 都是**整体 replace**，两者必须互相携带对方的字段，否则一次账号操作会把模型开关清空（反之亦然）
- `CodeArtsAdapter.listModels` 必须 `await this.ensureRemoteModels()`：早期用 `void` 丢弃 Promise，冷缓存时会误用静态兜底表
- RPC：`model.list` / `model.setDisabled`（`src/jet-hub-rpc.ts`），前端在 `plugin-src/client/jet-hub.js` 的 `ModelListPanel`

### ⚠️ 改完开关必须广播 `llm/adapters-updated`，否则界面要重启才更新

**真实缺陷**（用户报障）：在 Jet Hub 关掉 LobsterAI 的若干模型后，**模型选择器里
仍然看得到它们**；**重启 DSH 后**才正确消失。落盘侧一切正常
（`state.json` 的 `disabledModels.lobsterai` 有 28 条），适配器侧也正常
（`listModels` 每次实时读 `disabledModelsFor()`）。

**根因在客户端缓存，不在本插件的适配器**：`dsh-client-ui-model-selection` 的
`ModelCatalogDirectory` 把 `modelCatalog` 响应存进一个
**`status === 'ready'` 即短路返回缓存**的 store（`lib/client.js` 的 `load()`：
`if (state.status === 'ready' && state.value !== null) return Promise.resolve(state.value)`）。
它只在三个**转发的宿主事件**上 `refresh()`：

```js
ctx.remote.$on('llm/adapters-updated',        () => this.catalog.refresh())
ctx.remote.$on('settings/document-updated',   () => this.catalog.refresh())
ctx.remote.$on('credentials/reference-updated', () => this.catalog.refresh())
```

⚠️ **0.1.7 起黑名单不再走 settings 文档**（改落插件自有文档
`$DSH_HOME/jet-hub/state.json`，见上「持久化」章节），因此写开关**不触发上述
任何一个事件** → 客户端长期复用旧目录，**直到重启**（`connection/reset` →
`resetGeneration()`）才重拉。这正是「不重启不生效、重启就好」的成因。

**修法**：`model.setDisabled` 写完黑名单后显式广播一次
`ctx.emit('llm/adapters-updated')`（`src/jet-hub-rpc.ts`）。选它的理由：

- 按契约它是**无载荷**的「目录可能变了，请重新读 `listModels`」通知
  （dsh-llm README：*consumers re-read the registries*），语义完全吻合；
- 它在 `API_REMOTE_FORWARDED_EVENTS` 白名单里（`dsh-api-remotes`），故会真的送达浏览器；
- **不改变拓扑**，故 dsh-llm 的 invariant 监听（对每个 provider 读一次
  `retryPolicy`）必然通过，不会误报 `INVARIANT`。

⚠️ **广播必须包 try/catch**：通知失败不能反噬**已经落盘**的开关 —— 否则用户看到
「切换失败」而实际已生效，再点一次又因幂等而看似「无效」，比不提示更难排查。

⚠️ **`ctx.emit(name)` 不传 `thisArg`**，故 cordis 的 `dispatch` 里 `filter` 为
`undefined`，所有监听器（含 api-remotes 的转发监听）都会命中 —— 这是该修法成立的
前提（`EventsService.dispatch`：`hook.global || !filter || filter.call(...)`）。

⚠️ **新增任何「只写插件自有文档、却影响模型目录」的端点时，都要照此广播**。
判据是「这次写入会不会改变 `listModels` 的结果」，而不是「是否写了 settings」。

回归用例：`tests/unit/jet-hub-rpc.spec.ts` 的三条 —— 关闭/打开都广播、校验失败
不广播、广播抛错仍算成功（替身必须真的实现 `ctx.emit`，否则生产代码的广播会以
`ctx.emit is not a function` 被 try/catch 静默吞掉，用例形同虚设）。

### ⚠️ 设置页目录必须走 `listAllModels`，不能复用 `listModels`

**真实缺陷**（用户报障「打开的显示了倍率，关闭的就没有显示倍率」）：

`listModels` 会**按黑名单过滤**，于是被关闭的模型**不在其返回值里**。设置页必须
把它们渲染出来（否则用户无法重新打开），端点只能凭 `disabledMap` 的 key（裸 id）
补回 —— 那条路径拿不到展示名，只能退化成裸 id，**倍率与模型名随之丢失**。

故每个适配器都额外提供 **`listAllModels()`**：返回**不套黑名单**的完整目录，
且带**最终展示名**（含倍率、同名消歧）。`model.list` 优先用它，再自行回填
`disabled`；`listAllModels` 缺失时才退化为「listModels + 裸 id 补回」的历史行为。

⚠️ **`ctx.llm` 不透传自定义方法**（DSH 只保证 `listModels`），所以适配器实例必须
由 `index.ts` 显式收集成 `modelAdapters` 传给 `registerJetHubRpc`。五个
`register*Llm` 因此都**返回适配器实例**（而非 `void`）。加新 provider 时别忘两处：
`listAllModels()` + 在 `index.ts` 的 `modelAdapters` 里登记。

⚠️ **同名消歧必须基于未过滤的全量集合**（`displayNameFor(model, source)` 而非
`listed`）：用过滤后的集合会让「关掉其中一个同名模型」改变另一个的变体标记，
名字随开关跳变。

## ⚠️ 「锁定永久积分」三家**共用一张表与一个端点**，但判据必须各算

**用户需求**：为 codebuddy 与 workbuddy 加入永久积分锁定，类似 loomy 的锁定/解锁
永久积分；差别是 loomy 的到期积分是**当日**到期，两个 buddy 的到期是**一个月或更久**，
且「区分永久积分的方法可能稍有差异」。

**用户 2026-09-29 定下的四条口径**（不要擅自改）：

| 项 | 规则 |
|---|---|
| 判据 | 距**扣费截止**不足 **15 天** ⇒ 临时（优先烧）；≥ 15 天 ⇒ 永久 |
| 余额口径 | `CycleCapacityRemain`（本计费周期剩余，= IDE 顶部 `Credits Balance` 口径） |
| 开关粒度 | **provider 级**（CodeBuddy 与 WorkBuddy 各一份，互不影响） |
| 选号策略 | 与 loomy 同构：有临时积分的号优先 → 只剩永久 → 无/查不到；**档内保持手动顺序** |

### 区分永久积分**只能看 `DeductionEndTime`**（实测 2026-09-29，两站真实账号）

| 包 | `ExpiredTime` | `CycleEndTime` | **`DeductionEndTime`** | 归入 |
|---|---|---|---|---|
| WorkBuddy「Bonus Pack」 | `''` | 9 天后 | **9 天后** | 临时 |
| WorkBuddy「Free Plan Subscription」 | `''` | **2 天后** | **3008 天后** | 永久 |
| CodeBuddy「个人体验版」 | `''` | 已过期 | 3008 天后 | 永久（本周期已无余额） |
| CodeBuddy「拉新权益包 / 国内运营裂变包」 | `''` | 同下 | **17～208 天后** | ≥15 天者永久 |

⚠️ **三个看着像判据、其实都不能用的字段**（每一条都足以让功能静默失效）：

- **`ExpiredTime` 没有区分力**：有效包**一律是空串** —— 它是包**真正失效之后**
  由服务端回填的动作时间（此时 `Status` 已变 3、余额已归零），不是「预定失效时间」。
  既有的 `parseCreditPackage` 本来就把它用于失效判定，但**不能**反过来用它分池。
- **`CycleEndTime` 会把套餐误判成「马上作废」**：订阅包的计量周期是月度的
  （WorkBuddy Free Plan：周期 9-01→9-30，只剩 2 天），而扣费截止在 8 年后。
  用它 ⇒ 套餐被划进临时桶 ⇒ 锁定**形同虚设**（该保的照烧）。
- **终身口径 `CapacityRemain` 会虚增可用额度**：实测体验版**终身**剩 500 而
  **本周期**剩 0，那 500 实际扣不到（`TotalCycles=1 / RemainCycles=0`，周期不刷新）。
  用它 ⇒ 账号「看起来有钱却用不了」，锁定期间的可用判定也会错。

⇒ 实现：`CreditPackage` 新增**可选** `deductionEndTime?: number`（由
`parseCreditPackage` 从 `DeductionEndTime` 带出；`> 0` 才写，缺失 = 未知），
`splitBuddyCreditsByExpiry()` 据此现算两桶。顺带把「扣费截止已过」并入 `active`
失效判定（实测有效包的该字段都在未来，故这条只会捞出真正作废的包）。

⚠️ **到期时间未知（缺失 / 0 / NaN）归入永久桶**：保守方向 —— 最坏是少用一个号，
而不是把长期积分当快到期烧掉（不可逆损失）。

### 为什么不复用 loomy 那份（`loomy-balance-rank.ts`）

loomy 的两个池是**服务端直接给的字段**（`dailyBalance` / `balance`），buddy 要
**从包列表按到期时间现算**。压成一份代码得把「什么叫临时」参数化成回调，
那会让本文件最有价值的东西（**15 天这条线怎么来的**）从注释里消失。
⇒ 新增 `src/buddy-balance-rank.ts` + `src/buddy-balance-selector.ts`，
**同构但独立**；两站各持一个 selector 实例（余额缓存不串味）。

### ⚠️ 锁定表必须住**独立文档**，不能住 `state.json`（同机多 profile 会抹掉它）

**用户 2026-09-29 定案**（我先放错位置，被这条真实约束纠正）。

关键事实：`$DSH_HOME/jet-hub/state.json` 是 **dsh home 级、同机多 profile 共享**的
（`resolveJetHubHome` 只看 home，不看 profile），而本机现状是两个工作区并存 ——
`desktop` profile link 到 `dsh-codearts`（本仓库，带锁定功能），
`web` / `tui` / `headless` profile link 到 `deepseek-harness-codearts`
（另一条 minimax 工作区，**不认识锁定表**）。用户刻意让它们互不影响。

于是把 `permanentLocks` 放进 state.json 会这样失效：

| 步骤 | 发生什么 |
|---|---|
| 1 | desktop 写入 `permanentLocks: { buddy: true }` |
| 2 | 用户在 web 侧触发**任意一次**整体写入（加删账号 / 改模型开关 / 命中限流标记） |
| 3 | 旧代码 `store.save(全量 state)` 只带它认识的三个键 ⇒ `permanentLocks` **被抹掉** |
| 4 | desktop 读回 ⇒ CodeBuddy / WorkBuddy **静默解锁** ⇒ 继续消耗永久积分（**不可撤回**） |

⇒ 表落在 **`$DSH_HOME/jet-hub/permanent-locks.json`**（`src/permanent-lock-store.ts`），
旧代码从不读写它。**新增任何"跨版本共存"的字段时都要过一遍这个判断**：
共享文档 + 整体替换语义 ⇒ 只有对方也认识的字段才安全。

- ⚠️ `state.json` 里仍写 `loomyPermanentLocked`，但它是**镜像**不是权威：
  旧代码读它、也原样写回它，保持一致才能让另一侧的 Loomy 面板不显示错值，
  且回退版本时不会"锁定悄悄失效"。由 `AccountPool.lockFields()` 同源写出。
- ⚠️ **迁移判据必须是「独立文档不存在」**（`load()` 返回 `exists: false`），
  不能是「表里缺该键」。缺键的语义是**用户明确解锁了**；此时若回看镜像里那个
  陈旧的 `true`，就会出现**解不掉的开关**（比丢状态更难排查）。
  迁移出的内容要**立即固化**，否则每次冷启动都重新读那个会被改动的镜像。
- ⚠️ 文档损坏时按「存在但空表」处理，**不**回落到镜像 —— 同上理由。
- ⚠️ 写入顺序：**先权威、再镜像**；镜像失败只 warn 不上抛（否则一次 settings
  后端抖动会让面板按钮报错，而开关其实已生效）。
- ⚠️ 解锁是**删键**而不是写 `false`（与黑名单同款约定：只认显式 `true`）。
- ⚠️ **备份**：表不在 `getStateSnapshot()` 里了，导出必须走
  `permanentLocksSnapshot()`（漏改 = 备份里的锁定永远是空表）。导入侧
  `locksFromPayload()` 三态仍需分清：有表 = 整体替换；只有老字段 = 恢复/解锁
  Loomy 那一项（`false` 是**明确的**不锁，传 `{}`）；两者都没有 = 传
  `undefined` 让池**保持当前值**（否则导入老备份会静默解锁）。
- ⚠️ **测试必须隔离 home**：`vitest.config.ts` 已全局设
  `DSH_JET_HUB_STATE_DIR` 到临时目录，但**用例间的清理钩子要注册在模块顶层** ——
  本文件有多个**平级**的顶层 `describe`，钩子挂在某个 describe 内部时其余
  describe 拿不到，于是 `permanent-locks.json` 在用例间残留，"默认未锁定"
  会被前一条用例写入的值污染（实测踩过：9 条莫名失败）。

**怎么复核这条风险是真的**（不是推演）：`scripts/probe-cross-profile-overwrite.mjs`
（本地、零网络）用**另一条工作区的真实编译产物**当"旧代码"跑一次 `addAccount`，
实测：塞在 `state.json` 里的表**被抹掉**，而 `permanent-locks.json` 里的
`buddy` / `workbuddy` / `loomy` 三把锁全部健在。自动触发条件也不是"用户主动加账号"：
旧代码有 **每 30 分钟的续期定时器**（`REFRESH_INTERVAL_MS`）与 8 处
`updateModelRateLimit` 调用（一次对话命中限流即写）；且覆盖是**整份文档级、不分
provider** —— web 侧 qoder / trae / loomy 等账号被写一次，同样会抹掉 desktop 侧
给 CodeBuddy 上的锁。

### ⚠️ 分类是时间的函数：**缓存原料，绝不缓存分类结果**

**用户 2026-09-29 提出**：dsh 宿主长期开着，时间向前流动 —— 现在不是临时积分的包，
过一阵（距扣费截止跌破 15 天）就变成临时积分。所以分类**不能算一次就固定**。

⇒ 两处都按「只缓存原料」实现：

| 位置 | 缓存什么 | 每次做什么 |
|---|---|---|
| `BuddyBalanceSelector`（选号） | `get-user-resource` 的**原始 `CreditBalance`**，TTL 60 秒 | 命中缓存也调 `classify()` 重新分桶 + 定档，并**重读窗口 env** |
| `CreditBalanceRow`（面板） | 不缓存分类 | 每次渲染传 `Date.now()` 现算（`splitCreditsByExpiry` 是纯函数） |

⚠️ **TTL 的唯一职责是抑制网络请求**，绝不能顺手把 `split` / `tier` 一起缓存住。
一笔距到期 15 天 + 30 秒的余额，在 60 秒 TTL 内就越过了线 —— 冻结分类会让选号
继续按「永久」处理一笔其实马上作废的积分（锁定时更糟：本该可用的号被判成不可用）。
⇒ `balanceOf` 拆成 `fetchSource()`（网络，缓存）+ `classify()`（纯计算，每次做）。

⚠️ **Loomy 那份（`loomy-balance-selector.ts`）缓存的是服务端给的两个数字**
（`dailyBalance` / `balance`），里面不含「按 now 现算」的成分，所以它没有这个问题
—— **不是漏改，不要"顺手统一"**。

⚠️ 前端**不需要常驻定时器**：渲染节拍由「挂载 / 切 provider / 点刷新积分」提供，
而数字本身也正是这些时刻才重拉。分类只是渲染时现算的派生值，页面活着就自动跟上。

### ⚠️ 展示与选号的判据必须**逐条一致**（用对账用例锁，不是靠"看起来一样"）

前端 `plugin-src/client/credit-expiry.js` 是后端 `src/buddy-balance-rank.ts`
`splitBuddyCreditsByExpiry()` 的**展示侧复刻**。两者一旦漂移，用户就会看到
「面板说还有 250 临时积分，选号却说没号可用」——**任何单侧用例都发现不了**。

⇒ `tests/unit/credit-expiry.spec.ts` 用同一组 fixture（含恰好 15 天的边界、
失效包、到期未知、脏值、浮点尾数、时间前进 40 秒越线）喂两侧并断言结果相同。
⚠️ 已做**反向验证**：把前端边界从 `<` 改成 `<=` → 2 条变红（其中 1 条正是对账）。

⚠️ 窗口天数只能**由后端回传**（`credits.balances` 与 `credits.permanentLock` 都带
`windowDays`，前端存进同一个 state），不能在前端写死 15 —— 否则用户设了
`DSH_BUDDY_EXPIRING_WINDOW_DAYS=31` 后，面板说「只烧 15 天内的」而实际按 31 天筛号。

⚠️ 前端归一化窗口要显式挡 `null`/`undefined`：`Number(null) === 0`，而**非 buddy
provider 后端不带该字段**，不挡住就会在它们的卡片上凭空渲染一行假的
「临时 0 · 永久 N」。窗口实际恒为 15（或经 env 放宽），不存在"设成 0"的用法。

⚠️ tooltip 的到期天数取 `deductionEndTime`，**不是 `cycleEndTime`**：套餐的计量
周期是月度的（月底清零），拿它显示会让用户以为"永久积分只剩 2 天"。

### RPC：一条实现 + 一个历史别名

`credits.permanentLock { provider, locked? }`（`locked` 省略 = 只读）。
`loomy.permanentLock` 保留为**别名**（老客户端 bundle 仍调它，删了会让 Loomy
面板按钮静默失效），且该别名**忽略载荷里的 provider**（固定 loomy，否则老前端
能借它越权改别的 provider）。白名单 `PERMANENT_LOCK_PROVIDERS`
= `{loomy, buddy, workbuddy}`，与前端 `supportsPermanentLock` **必须一致** ——
单测 `credits-capabilities.spec.ts` 逐个 provider 对账两边。

⚠️ **不要**为每个 provider 各加一条 case：本仓库已经因此坏过
（「WorkBuddy 的刷新按钮一直坏着」就是漏接平行分支）。

### ⚠️ 文案必须按 provider 取，且**天数由后端回传**

- `permanentLockCopy(provider, windowDays)`：loomy 说「每日赠送额度」，
  两个 buddy 说「N 天内到期的积分包」。把 loomy 那句套到 buddy 上是**实质性误导**
  —— buddy 没有每天刷新的额度池（签到得来的也是 14/30 天后到期的包）。
- ⚠️ 窗口可被 `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 覆盖，故响应带 `windowDays`
  回传、前端据此渲染。写死 15 会出现「提示说只烧 15 天、实际按 31 天筛号」。
- ⚠️ 前端归一化要区分 `null/undefined`（回落默认，**不能**当 0 ——
  `Number(null) === 0`）与数字 `0`（合法，语义是「没有临时积分」）。
  写 `|| 默认值` 会吞掉 0，与 Qoder 排队超时那条同一个坑。

### ⚠️ 中国版在默认窗口下的必然结果（**不是缺陷**，但要说清）

实测 CodeBuddy 中国版账号的赠送包**按 30 天发放**，「距到期」天然落在 17～30 天
⇒ 默认 15 天下**整池 10064 积分全算永久** ⇒ 锁上立刻「无可用账号」。
这是用户定的判据的直接推论。逃生门：`DSH_BUDDY_EXPIRING_WINDOW_DAYS=31`
（实测改后 6264.61 划为临时、3799.99 仍永久，锁定可正常选号）。
报错文案用 `buddyExpiringWindowDays()` **运行时解析**，不写死常量。

### ⚠️ 锁定时绝不可落到 `getAvailableAccount` 兜底

`pickBuddyAccount()` 返回 `kind:'locked'` 时 `index.ts` 必须**抛明确错误**
（告诉用户去哪个面板解锁）。落到既有的池兜底会绕过锁定、照样消耗永久积分，
使锁定形同虚设 —— loomy 当初就是这条，单测里也专门钉住「编排函数体内不出现
`getAvailableAccount`」。未锁定时的 `exhausted`（凭据都坏了）才允许兜底，
且必须把 `tried` 传给 `getAvailableAccount` 的排除集合，否则会原地打转。

### 回归用例

- `tests/unit/buddy-balance-rank.spec.ts`（37 条）：窗口边界（14d / 恰好 15d /
  差 1ms）、失效包跳过、到期未知归永久、本周期口径、锁定降档、稳定排序、
  环境变量解析（含 **0 合法**）、脏值。
- `tests/unit/buddy-balance-selector.spec.ts`（25 条）：TTL 缓存与 invalidate、
  凭据失败/异常/null 三种失败形态、锁定不被选中、解锁保持既有行为、
  编排换号循环、`locked` vs `exhausted`、env 窗口生效。
- `tests/unit/credits.spec.ts` 的「DeductionEndTime 解析」段（5 条）：带出毫秒、
  缺失不编造、过期判 `active:false`、脏值。
- `tests/unit/jet-hub-store.spec.ts` / `account-pool.spec.ts`：表与老字段同源、
  三处整体写入不互相抹掉、跨实例读回、脏表按空、replaceAll 三态。
- `tests/unit/buddy-permanent-lock.spec.ts`（12 条）：`index.ts` **接线**源码断言
  （两个 selector 各绑自己的 product、候选先过滤再分档、锁定分支不兜底、
  兜底传 `tried`）+ 行为级「两站不串味」。
- `tests/unit/loomy-client.spec.ts` / `loomy-rpc-dispatch.spec.ts` /
  `credits-capabilities.spec.ts`：通用端点 + 别名、provider 白名单两边对账、
  文案带 windowDays。
- ⚠️ 已做**反向验证**：阈值改 7 天 ⇒ 9 条变红；去掉锁定降档那一行 ⇒ 6 条变红；
  把 `locked` 的 throw 改成兜底 ⇒ 接线用例变红。
- 排查脚本（只读、零额度、**不入库**）：`scripts/probe-buddy-resource-raw.mts`
  （打印两站资源包原始形状与到期分布，判据的取证来源）、
  `scripts/probe-buddy-permanent-lock.mts`（用真实凭据跑一遍拆分与选号，
  可加 `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 看放宽窗口的效果）。

## 目录门控：没有已登录账号就隐藏整个 provider

**需求**：「如果某供应商没有已登录的账号，就不显示该供应商的所有模型，这样对
大多数用户来说模型选择选项卡臃肿的问题能改善很多。」

### 机制：DSH 原生支持「空目录即隐藏」，无需前端改动

`dsh-api-session-controller` 的 `buildModelCatalog` 显式做了

```js
groups: catalog.flatMap(...).filter(group => group.models.length > 0)
```

（注释：*"successful non-empty provider groups"*）。所以适配器 `listModels`
返回 `[]` 就能让整个 provider 分组从模型选择器消失。

两点**必须遵守**：

1. ⚠️ **返回空数组，绝不抛错** —— 抛错会被 `catch` 归入 `failures`，界面上
   反而多出一条 provider 报错，比「不显示」更糟；
2. ⚠️ **不影响路由** —— `routableProviders` 由 `listProviders()` 单独生成
   （不经该 filter），且 DSH 明确约定 *"Catalog membership is advisory and
   never changes routing"*。隐藏目录 ≠ 拒绝请求，已持久化的模型仍可
   `resolveModel` / 正常收发（与黑名单同一契约）。

### 判据：凭据能否解析（**不是**「有没有账号条目」）

`AccountPool.hasLoggedInAccount(provider)`，由
`providerCatalogVisible()`（同文件）包装。两条语义都容易被改错：

| 语义 | 原因 |
|---|---|
| 判据是**凭据可解析** | 服务层的 `logout()` **只 unset 凭据、保留账号条目**（删条目是另一条路径 `removeAccount`）。若只看「有条目」，用户登出后模型仍然显示，门控形同虚设 |
| **不看 `enabled`** | 停用只影响「自动选号」，与「是否已登录」无关。若过滤 `enabled`，把所有账号停用的用户会发现整个 provider 的模型凭空消失。与「续期只看 `refreshable`、不看 `enabled`」是同一条既有约定 |

⚠️ **十个 provider 判据完全一致，没有例外**：早期 CodeArts 曾额外接受固定单凭据
ref（`CODEARTS_ACCESS_TOKEN`），该模式**已移除**，`extraCredentialRefs` 参数一并
删除。老用户若只用固定 ref 登录过，模型列表会变空 —— 需在 Jet Hub 重新登录一次
（用户已确认接受，不做自动迁移）。

### 保守放行的三种情形（门控是**展示优化**，不是安全边界）

1. `accountPool === undefined`（headless / CLI / 单测）；
2. 替身未实现 `hasLoggedInAccount`（**能力检测** —— 大量既有单测只 mock 了
   `disabledModelsFor`）；
3. 读凭据抛异常（存储损坏等）。

三种都返回「可见」：判定不可用时**宁多勿少**，否则会让用户看到「所有模型凭空
消失」且无从排查。

### 开关与落点

- `DSH_HIDE_MODELS_WITHOUT_ACCOUNT` —— **默认开启**，只有显式假值
  （`0`/`false`/`no`/`off`）才关闭。与 `DSH_TRAE_MAX_MODE` 同为「默认开」语义，
  故用**独立的** `resolveHideWithoutAccountFlag`，不要与 `isTruthyFlag`
  （「默认关」）混用。
- 门控放在各 `listModels` 的 **`ensureRemoteModels()` 之前**：无账号时连远端
  目录都不必拉（省一次无谓 HTTP）。
- ⚠️ **门控只加在 `listModels`，`listAllModels`（设置页）不受影响** ——
  否则用户关掉模型后连开关都看不到，更无法重新打开（这是此前修过的真实缺陷）。
- 六个适配器的 `listModels` 都要加（`llm-adapter` / `buddy` / `lobsterai` /
  `qoder` / `trae`）。`buddy` 与 `workbuddy` 共用同一个适配器类，但
  `this.product.id` 不同 → 两者按各自 provider 独立判定，互不影响。

## ⚠️ 模型行布局：长 id 会把开关挤出可视区（真实缺陷）

**用户报障**：「cline 功能是具备的，不过针对某一个模型的开关在最后，需要横向滑动，
我没有看到」。

### 根因：CSS 让行横向溢出，开关被推出弹窗

**不是功能缺失** —— 开关一直在渲染，只是**看不见**。三处收缩约束缺失叠加：

| 位置 | 错误写法 | 后果 |
|---|---|---|
| `.dim-jh-modelList` | 单列 grid 未写 `grid-template-columns` | 列宽默认 `auto`，按**最宽内容**撑开 |
| `.dim-jh-modelRow` | 无 `min-width: 0` | grid 项的 `min-width` 默认 `auto`，**拒绝收缩** |
| `.dim-jh-modelId` | `flex: none` | 保持内容宽度，**直接把开关顶出去** |

三者叠加 → 整行溢出弹窗 → 排在 id 之后的开关被推到可视区外。
Cline 有 **300 个 id 超过 20 字符**（最长 56），所以几乎每行都中招。

**这正是该 provider 在 `state.json` 的 `disabledModels` 里长期为空的原因** ——
不是用户不想关，是**根本看不到开关**。（与「缺搜索/筛选」是两个独立问题：
搜索解决"找不到某个模型"，本缺陷解决"连开关都看不见"。）

### 修法：三处收缩约束，缺一不可

```css
.dim-jh-modelList { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; }
.dim-jh-modelRow { display: flex; align-items: center; gap: 12px; min-width: 0; ... }
.dim-jh-modelId { flex: 0 1 auto; min-width: 0; max-width: 46%; ... }
.dim-jh-modelName { flex: 0 1 auto; min-width: 0; ... }
/* 兜底：任何一行偶然溢出都不该让整个弹窗横向滚动 */
.dim-jh-modalBody { ...; overflow-x: hidden; }
```

⚠️ **开关自身必须保持 `flex: none`** —— 它是目标控件，绝不能参与收缩。

### 验证方式（可复用）

`verify-layout.mjs`（工作区根目录）：**从真实源码模块提取 STYLES** 渲染
`repro-real-source.html`，再用无头 Edge 截图 + 在页面内测量开关右边缘是否超出
body 可视区。用真实源码而非 CSS 副本，避免「复现页改好了、源码没改」的假阳性。

实测结果（8 行，含最长 id）：

```
弹窗内容宽 = 560px
列表横向溢出 = 否
body 横向滚动 = 否
开关被挤出可视区 = 0 / 8 行
```

修复前同法实测：**8 / 8 行的开关全部不可见**。

⚠️ **这类缺陷单测抓不到**（react 不在依赖内，无法渲染），故用
`tests/unit/model-filter.spec.ts` 的「模型行布局」段做**源码级**断言，
逐条锁住上面四处约束。反向验证：把 `flex: 0 1 auto` 改回 `flex: none`、
去掉 `minmax(0, 1fr)`、去掉 `overflow-x: hidden` —— 三次都各触发 1 条失败。

### ⚠️ 改 `jet-hub-styles.js` 时：注释里不能出现反引号

该文件整体是 **JS 模板字符串**（`const STYLES = \`...\``），注释里的反引号会
**提前终止字符串**、导致 esbuild 报 `Expected ";" but found "..."`。
本次就因此构建失败过一次 —— 说明 CSS 属性时一律不加反引号。

## 模型面板的搜索与筛选（**不含多选、不含渲染上限**）

**用户需求**：Cline 的远端目录实测约 **478 条**（`/api/v1/models` 458 条 +
`recommended-models` 的 free/recommended/clinePass 6/4/14 的并集），需要一个
搜索框与状态筛选来定位模型。**搜索与筛选确实有用，已保留。**

纯逻辑在 **`plugin-src/client/model-filter.js`**（`filterModels` / `isFilterActive` /
`matchesModelQuery` / `normalizeStatusFilter`），与 `model-bulk.js` /
`account-order.js` 同理单独成文件：本仓库单测环境里 react 不在依赖内，组件无法
渲染，抽成纯函数才能用真实断言覆盖。

### ⚠️ 四条不能改错的语义

1. **未知筛选值必须退化为「不筛」**（`normalizeStatusFilter`）。若实现成「非 all 即
   按 enabled 筛」，一次拼错的取值（`'Disabled'`）会让列表只剩已打开的模型，
   用户看到「模型少了一大半」而没有任何错误提示。`isFilterActive` 必须与它
   **保持一致**，否则会出现「判定说有筛选、实际一条都没筛」的错位。
2. **空搜索词命中全部**（那是"未搜索"，不是"搜索空串"）。
3. **`disabled` 判定用 `=== true`**：与适配器黑名单的「只有显式 true 才算关闭」
   同一语义。用 `!== false` 会把未声明该字段的条目误判为已关闭。
4. **筛选无结果必须与「该 Provider 没有模型」分开提示**。合并成一句会让用户以为
   模型全丢了，而实际只是搜索词没命中。

### ⚠️⚠️ 两个曾被错误引入、已回退的设计（**不要重新引入**）

#### 1. 多选勾选框 —— 破坏了既有点击交互

**背景（我的误判）**：我曾把「Cline 模型列表关不过来」归因为"缺搜索/筛选/多选"，
并据此给每行加了多选勾选框 + 「全选筛选结果 / 打开选中 / 关闭选中」+ 新端点
`model.setDisabledBulk`。**但用户明确指出问题 2 原本没有问题** —— 真正的缺陷是
**问题 1 的布局溢出**（见上一节），修好布局后开关本就可见可用。

**多选造成的真实行为倒退**（无头 Edge 实测确认）：

`ModelToggle` 的根元素是 **`<label>`**。原先 label 内只有 1 个 checkbox，
点行内任意位置（含模型名）都会激活它 —— 即「点模型名切换可见性」，这是既有交互。
一旦插入第二个 checkbox（多选勾选框），浏览器把点击激活到**第一个**可标记控件：

| 操作 | 单 checkbox（正确） | 双 checkbox（倒退） |
|---|---|---|
| 点行内**文字**（模型名） | 切换可见性开关 ✅ | **切换了多选勾选框，可见性开关纹丝不动** ❌ |
| 点开关本身 | 正常 ✅ | 正常 ✅ |

**结论**：⚠️ **`ModelToggle` 内必须保持只有 1 个 checkbox**。若将来确需多选，
**必须先把行容器从 `<label>` 改成 `<div>`**（并自行处理点击切换），否则必然重踩。
回归用例见 `tests/unit/model-filter.spec.ts` 的「ModelToggle 内只有 1 个 checkbox」。

#### 2. 渲染上限 200 条 + 「显示更多」 —— 属于功能收缩

改动前 478 条本来就是**一次性全渲染、工作正常**。加渲染上限后，超出的条目需要
额外点一次「显示更多」才能看到 —— 这是**凭空多一次点击**，属于功能收缩，已移除。
**不要再加回来**，除非有实测证明渲染确实卡顿（届时也应按 `filtered` 而非
`visible` 计算批量操作范围）。

### ⚠️ 搜索框自身的两处真实缺陷（用户报障，已修）

> 「搜索框在深色模式下输入的文字是白色的和底色一样看不见文字」
> 「输入文字后整个弹框的位置会发生改变，有点突兀」

两条都是**新增搜索框时引入**的，都已在本地复现确认并修复：

#### 1. 深色模式白字白底 —— 引用了**不存在**的主题 token

`.dim-jh-input` 的背景原写作 `var(--dsw-alias-bg-input, #fff)`，而主题里
**根本没有** `bg-input` 这个 token（真实的是 `bg-base` / `bg-layer-1/2/3`）。
`var()` 遇不存在的 token **不报错**，静默取 fallback `#fff` → 深色模式下
浅色文字配白底，文字完全看不见。

修法：改用官方 `Input` 原语同款的 `--dsw-alias-bg-layer-1`，并**去掉浅色
fallback**（宁可取不到值时背景异常、能一眼看出，也不要一个看起来正常却在深色
模式下毁掉可读性的 fallback）。placeholder 另用 `--dsw-alias-label-dimmed`。

⚠️ **审计工具**：`audit-tokens.mjs`（工作区根目录）会扫描插件样式里所有
`var(--dsw-*)` 引用，比对主题真实定义的 395 个 token，列出**不存在**的那些。
新增/修改样式后应跑一次 —— 这类缺陷单测抓不到（CSS 变量解析不在测试环境里）。
（该脚本同时报出既有的 `--dsw-alias-border-default`，属登录弹窗的历史问题，
与本次改动无关，未一并处理。）

#### 2. 输入文字后弹窗位置跳动 —— `align-items: center` + 高度随内容变化

弹窗高度随列表长度变化，而遮罩用的是 `align-items: center`，于是**高度变化直接
变成整体位移**。实测输入搜索词后弹窗 `top` 从 4px 跳到 **187px**（结果变少 →
弹窗变矮 → 居中的位置跟着上移），观感突兀。

修法：模型列表弹窗改为**顶部锚定**（`.dim-jh-modalOverlay--top`，
`align-items: flex-start` + `padding-top: max(24px, 8vh)`），上边缘固定、
只在下方伸缩。实测三种状态 top **恒为 38px、位移 0px**。

⚠️ 顶锚后 `max-height` 必须按 **padding box** 计算（`100%`），不能再用
`100vh - 48px` 这类视口算式 —— 否则 `8vh` 大于 `24px` 时会溢出视口。

⚠️ 该修饰类**只作用于模型列表**，账号备份弹窗仍用垂直居中。

### 验证方式（可复用）

`verify-searchbox.mjs`（工作区根目录）：从**真实源码模块提取 STYLES**，在模拟
深色 token 的页面里渲染，然后用无头 Edge 测量：

- 搜索框背景/文字色的**对比度**（实测 13.54:1，WCAG AA 要求 4.5:1）；
- 三种搜索状态下弹窗 `top` 的**位移**（实测 0px）；
- 回归断言问题 1 的布局（开关被挤出 **0 / 8 行**）。

⚠️ 单测抓不到布局与 CSS 变量解析，故用源码级断言 + 该脚本双重锁住。

## ⚠️ 停用账号时可选「同时停用该 provider 的模型」

**真实需求**（用户报障）：「我关闭了 qoder，模型列表中没有关闭，在对话中还是可以
选择到它的模型」。

### 根因：门控判据**刻意**不看 `enabled`

见上「目录门控」章节 —— 这是**整体设计**（停用只影响自动选号），不是缺陷。但它带来
一个用户可感知的落差：停用某 provider 的**最后一个**启用账号后，该 provider 在账号池
里已不可用，可它的模型**仍留在模型选择器里**（凭据还在，门控判为可见）。用户只能再
去「显示列表」里把几十上百个模型逐个关掉 —— 这正是 `state.json` 里 qoder 的 17 个
模型被手工全关、trae 的 41 个同样全关的由来。

### 修法：变成一次**显式选择**，而不是改门控语义

用户明确要求保持原设计。故在 `ProviderPanel.toggleAccount` 里加联动询问，
纯逻辑在 **`plugin-src/client/account-model-link.js`**：

- `disablingLeavesNoEnabledAccount(accounts, accountId, provider)` —— 停用后该
  provider 是否**不再有任何启用账号**；
- `allModelsDisabled(models)` —— 该 provider 的模型是否**全部已关闭**（且非空）。

| 方向 | 触发条件 | 询问 |
|---|---|---|
| 停用 | 停用后该 provider 再无启用账号 | 是否同时**关闭**它的全部模型 |
| 启用 | 此前无启用账号，且模型恰好全关 | 是否同时**打开**它们 |

### ⚠️ 五条不能改错的语义

1. **判定必须在 `account.update` 提交之前取**。提交后列表已刷新，「是否还有启用账号」
   的答案就变成变更后的状态了 —— 多账号场景下会误判。
2. **只在「最后一个启用账号」时提示**。该 provider 还有别的启用账号时，它的模型依然
   可用，关掉全部模型纯属**误伤**。
3. **只看同一 provider**。别的 provider 有启用账号与本 provider 的模型是否可用毫无
   关系 —— 若实现成「全表还有启用账号就不提示」，多 provider 用户永远不会收到提示。
4. **两个方向都必须由用户决定，不做静默联动**。静默关闭会让「停用账号」这个看似与
   模型无关的操作产生意外副作用；静默打开则可能把用户特意关掉的模型放出来。
5. **联动失败只提示、不回滚账号状态**。账号停用/启用已经落盘，此时把整次操作报成
   失败会让用户以为账号状态没变，再点一次又因幂等而看似「无效」。故只提示、让用户
   可去「显示列表」手动处理。

另外两点性能考虑：

- 启用方向**只在「此前一个启用账号都没有」时**才读模型目录（`isFirstEnabled`）。
  否则每次启用账号都会多发一次 `model.list` —— Cline 那次的目录有近 500 条。
- 目录读不出来时**静默跳过联动**：账号启用本身已经成功，不该因目录故障而报错。

### 与门控的边界

⚠️ **本联动不改变 `hasLoggedInAccount` 的判据**。「停用账号」与「是否已登录」仍是
两件事；联动只是替用户把「模型可见性」这件事**顺手做掉**，且必须经用户确认。
若将来有人想把 `enabled` 直接并入门控判据，先回看「目录门控」章节里那条
「若过滤 `enabled`，把所有账号停用的用户会发现整个 provider 的模型凭空消失」——
那正是本联动选择「询问」而不是「静默」的原因。

回归用例：`tests/unit/model-filter.spec.ts`（27 条）、
`tests/unit/account-model-link.spec.ts`（18 条）、
`tests/unit/jet-hub-rpc.spec.ts` 的 `model.setDisabledBulk` 段（14 条）、
`tests/unit/account-pool.spec.ts` 的 `setModelsDisabledState` 段（8 条）。

## ⚠️ Cline provider：`workos:` 前缀不可剥、免费集合动态下发

`cline` 是**第六个脉系**（独立一套 `src/cline*.ts`）。协议全部由本机 Cline 桌面端
产物逆向 + 实测得出（2026-09-25）：

- 二进制 `C:\Users\Jet\AppData\Local\Cline\code-sidecar.exe`（bun 单文件，144 MB）
- 真实凭据 `C:\Users\Jet\.cline\data\settings\providers.json`
- 排查脚本（只读）：`scripts/probe-cline-endpoints.mjs`（按关键词提取二进制字符串
  窗口）、`probe-cline-models.mjs`、`probe-cline-recommended.mjs`、
  `probe-cline-balance.mjs`、`probe-cline-chat.mjs`
- 设计文档：`docs/superpowers/specs/2026-09-25-cline-provider-design.md`

### ⚠️ 坑 1：`Authorization` 必须原样带 `workos:` 前缀（剥掉即 401）

源码 `resolveApiKey` **原样使用存储值**，而 Cline 磁盘上存的就是
`workos:eyJ…`。该前缀只在**解码 JWT** 时被剥掉
（`decodeJwtPayload(token.replace(/^workos:/, ""))`），**从不出现在请求头构造里**。

实测（`tests/e2e/cline-probe.e2e.spec.ts` 会现场复验，同一凭据）：

| Authorization | `/api/v1/users/me` |
|---|---|
| `Bearer workos:eyJ…`（**原样**） | **200** |
| `Bearer eyJ…`（剥掉前缀） | **401** |

⚠️ 401 文案是 *"make sure you're using the latest version of Cline and
re-authenticate your Cline account."* —— 与真实原因**毫不相干**，会让人误判成
「客户端版本过旧」。实现见 `clineBearerValue`（幂等补齐，两种形态都接受）。

### ⚠️ 坑 2：免费模型是**独立 id**，且只由 `recommended-models` 下发

`cline-free/deepseek-v4.1-flash`（免费）与 `deepseek/deepseek-v4.1-flash`
（按量计费）是**两个不同条目**。绝不可用「名字含 deepseek」之类模糊匹配判免费 ——
那会让用户按免费预期使用却被计费。

两个端点**必须都打**，理由各有实测依据：

| 端点 | 内容 | 认证 |
|---|---|---|
| `GET /api/v1/ai/cline/recommended-models` | `{recommended[], free[], clinePass[]}`，**唯一权威的 free 集合** | **不需要** |
| `GET /api/v1/models` | 460 个 `{id, object, created, owned_by}` —— **只有 id**，无 name/上下文 | 需要 |

⚠️ 实测 `/models` 的 460 个 id 里 **`cline-free/*` 零命中** —— 免费模型**只**由
`recommended-models` 下发。这就是「只调 `/models` 会看不到任何免费模型」的原因。
`tests/e2e/cline-probe.e2e.spec.ts` 用断言锁死了这一事实（若某天 `/models` 也开始
下发它们，该用例会失败并提示可简化实现）。

判定规则（`isClineFreeModel`，**不硬编码模型名**）：
远端 `free` 集合 ∪ `:free` 后缀 ∪ `cline-free/` 前缀 ∪ 兜底表 `isFree`。
与 CodeArts benefit 集合同一约定。

⚠️ **兜底表不足以覆盖免费集合**：sidecar 内嵌目录缺
`cline-free/gemini-3.8-flash`（远端 `free` 有），故 `cline-product.ts` 的兜底表
手工补上了它 —— 否则离线时用户看不到截图里的那个模型。

⚠️ **`clinePass` 不是免费集合**：它是 Cline Pass 订阅制模型（`cline-pass/*`），
按订阅额度计费。实测 14 个，误判为免费会误导用户。

### ⚠️ 坑 3：思考字段是 `delta.reasoning`，不是 `reasoning_content`

实测 Cline SSE 形如
`{"delta":{"reasoning":"The","reasoning_details":[…]}}`，而
`reasoning_content` 是 Qoder / buddy 的形态。`src/openai-compat.ts` 的
`consumeOpenAiSse` 因此**同时认两者**（`delta?.reasoning_content ?? delta?.reasoning`）。
只认前者会让 Cline 的思考内容被静默丢弃（表现为「模型不思考」，且 reasoning
档位切换看似无效）。e2e 探针实测已确认思考内容真的产出。

### ⚠️ 坑 4：思考档位**远端不下发**，只能来自客户端内嵌目录

IDE 的模型选择器旁有思考强度菜单（`None / Low / Medium / High / Extra`），
但**远端两个模型端点都不下发档位**：`/api/v1/models` 只有
`{id, object, created, owned_by}`，`recommended-models` 只有
`{id, name, description, tags}`。sidecar 内 `/api/v1/` 的 21 个路径中也没有
任何模型详情端点（`/api/v1/users/me/remote-config` 返回 `{"data":null}`）。

档位只存在于 `code-sidecar.exe` 内嵌的 `BUILTIN_MODEL_CATALOG` 的
`reasoningOptions`，而那张表覆盖不了远端 460 个 id。故 `CLINE_REASONING_EFFORTS`
对**所有**模型统一给 5 档。

⚠️ **`id`（wire 值）与 `name`（展示名）不是同一个概念**。最高档的对应关系
（`Extra` → `max`）是**行为实测**出来的，不是反推的：

| effort | reasoning 字符数（`stealth/space-bunny-alpha`，同题 3 次采样均值） |
|---|---|
| 不传 / `none` | 0（**不传 = 不思考**） |
| `low` | 67 |
| `medium` | 379 |
| `high` | 294 |
| `xhigh` | **259（与 high 无可辨差异 → 伪档位）** |
| `max` | **1192（high 的 4 倍 → 最高档）** |

若只按名字对齐（`xhigh` → 显示成 XHigh），会给用户一个**实测无差异的档位**，
而真正的最高档 `max` 反被跳过。旁证：sidecar 权重表
`{ max:1, xhigh:0.95, high:0.8, ... }` 同样确认 `max` 在 `xhigh` 之上。

⚠️ **上游对不认识的档位静默忽略而非报错**（实测 `reasoning_effort: 'banana'`
返回 HTTP 200、思考量为 0）—— 故 `stream()` 里**绝不能加白名单校验**：
校验既无必要，又会把上游未来新增的档位变成静默丢弃。

⚠️ **声明 `defaultEffort` 会改变默认行为**：实测不传档位时模型完全不思考，
而 DSH 在用户未选择时自动采用 `model.reasoning.defaultEffort`。本插件默认
`high`（对齐 IDE 截图的选中态），代价是思考 token 计入 `completion_tokens`。

⚠️ 统一给档位的**已知局限**：对不在内嵌目录里的模型，档位是猜的 ——
最坏情况是「开关无效」（上游静默忽略），不会是「请求失败」。

排查脚本：`scripts/probe-cline-reasoning.mjs`（纯本地，只读）、
`scripts/probe-cline-effort-compare.mjs`（**消耗免费额度**，多次采样对比档位）。
设计文档：`docs/superpowers/specs/2026-09-25-cline-reasoning-effort-design.md`。

### ⚠️ 坑 5：Gemini 系有两个**独立**的 400，且各自只在部分 provider 上暴露

用户报障（2026-09-25）：给 `cline-free/gemini-3.8-flash` 发消息即失败。错误体里
一次请求有**两个 provider 尝试、两个不同的错误**：

| provider | 错误 |
|---|---|
| `vertex` | `maxOutputTokens value of 131072 but the supported range is from 1 to 65537` |
| `google` | `tools[0].function_declarations[34].parameters.properties[permission].enum[3]: cannot be empty` |

⚠️ **不要只修一个** —— 上游会依次 fallback，命中哪个 provider 就暴露哪个错误，
路由一漂移就复发。

**根因 1（我们的错）：兜底表数值凭印象填。** `cline-free/gemini-3.8-flash` 不在
sidecar 内嵌目录里，当初手工补表时照抄了其它免费模型的 `131072`；而同名
`google/gemini-3.8-flash` 的实测值是 **65536**，上游上限即 65536。
这与 Qoder 那条「本表数值必须逐条对照，不要凭印象填」是**同类错误**。

**根因 2（必现）：工具 schema 的 `enum` 含空串。** harness 下发的工具集里某些
参数的 `enum` 带空字符串成员，Gemini 系严格校验直接 400。
⚠️ 本适配器**从不自己造 enum**（`stream()` 原样透传 `tool.parameters`），
脏数据来自上游 harness —— 但请求是我们发的，只能在我们这侧拦住。
`sanitizeClineToolParameters()` 递归清洗，三条边界：只删空串（保留数值枚举）、
全空则丢弃 `enum` 键（空 `enum` 同样非法）、递归下钻 `properties` / `items`。

⚠️ **排障时注意：这两个 400 都不是必现的。** 实测同一 `max_tokens=131072`
连发 3 次都返回 200（那几轮没命中 vertex）。判定依据是错误体里的
`providerMetadata.gateway.routing.modelAttempts[].providerAttempts[]`，
不是重试次数 —— 别因为「重发一次就通了」而误判为偶发。

⚠️ 顺带：本机 `~/.cline/data/settings/providers.json` 里的 `accessToken` **常常过期**
（实测过期 1 小时，直接请求得到 401），排查前先续期；续期返回的是**裸** JWT，
必须补 `workos:` 前缀才能用（坑 1）。

排查 / 验证脚本：`scripts/probe-cline-gemini-400b.mjs`（对照复现两个根因）、
`scripts/verify-cline-gemini-fix.mjs`（走已编译 `lib/` 的端到端验证，三个场景）。
均**消耗免费额度**。

### ⚠️ 坑 6：403 不都是凭据问题 —— 地域限制会被误报成「API 密钥无效」

用户报障（2026-09-25）：`cline-free/muse-spark-1.3-contributor` 提示
「**API 密钥无效**」，但凭据是好的。

该中文文案**不是本插件抛的** —— 它来自 DSH 客户端 `failureMessage()`：

```js
return code === "AUTH" ? t("message.failure.auth") : message
```

即**只要错误码是 `AUTH`，真实原因就被替换成「API 密钥无效」**；非 `AUTH` 则
原样显示 message。而 `httpErrorCode()` 把 401/403 **一律**映射成 `AUTH`。

⚠️ Cline 对「该地区不可用」的模型也返回 **403**：

```
403 {"error":"access forbidden: cline-free/muse-spark-1.3-contributor
     is not available in your region","success":false}
```

于是故障链是：403 → 当作凭据过期 → **白跑一次续期**（续期还会成功，所以不提前
报错）→ 重试仍 403 → 归成 `AUTH` → UI 显示「API 密钥无效」。真实原因彻底丢失，
用户以为要去重新登录。

修法：`isClineRegionForbidden()` 按**响应体文案**识别（不能按状态码一刀切 ——
同一批 403 里既有真凭据问题也有地域限制），命中时**跳过续期**并抛
`PERMISSION_DENIED`（该码不在 DSH 默认可重试集合内，不会反复重试）。

⚠️ 顺带修了 `errorDetail()`：Cline 的错误体是 `{error: "<文案>", success:false}`，
而该函数原本只认 `code` / `message` / `msg` → 整个 JSON 原样返回，用户看到一坨
裸 JSON。现已补 `error`（字符串与嵌套对象两种形态都认）。这是**共享函数**，
Qoder 同样受益，改动已由全量单测覆盖。

排查 / 验证脚本：`scripts/probe-cline-muse-403.mjs`（直接看真实状态码）、
`scripts/verify-cline-region-fix.mjs`（走 `lib/` 验证错误码与续期次数）。
均**消耗免费额度**。

### 登录：WorkOS 设备码（与 Qoder 同为轮询式，但判据形态不同）

```
POST {workOsBase}/user_management/authorize/device   → device_code / user_code / verification_uri
轮询 POST {workOsBase}/user_management/authenticate  → 200 {access_token, refresh_token}
     grant_type=urn:ietf:params:oauth:grant-type:device_code
POST {apiBase}/api/v1/auth/register  body {accessToken, refreshToken}
  → {success:true, data:{accessToken, refreshToken, expiresAt, userInfo:{clineUserId, email}}}
```

⚠️ **`authorization_pending` 不是错误**，必须继续轮询 —— 它是「用户还没在浏览器里
点授权」。与 Qoder 的「404 表示尚未授权」是同一类语义，但**判据形态完全不同**
（Qoder 看 HTTP 状态码，Cline 看响应体的 `error` 字段）。`slow_down` 必须**累积
退避**（源码 `intervalSeconds += 1`）。

⚠️ **响应套 `{success, data}` 信封，字段名是驼峰** `accessToken`（不是
`access_token`）。判据是 `success && data.accessToken`（源码
`requireClineTokenResponse`），只看裸字段会把失败信封当成功。

### 续期：字段名是驼峰 `refreshToken` + `grantType`

```
POST {apiBase}/api/v1/auth/refresh
body: { "refreshToken": <refresh>, "grantType": "refresh_token" }
```

⚠️ **不是 OAuth 标准的 `refresh_token` / `grant_type`**（源码 `refreshClineToken`）。
两者都必填；写错字段名服务端不会明确报「缺字段」，而是回一个泛化的认证失败。

### 积分余额：只有余额，**没有签到**

```
GET {apiBase}/api/v1/users/{accountId}/balance
  → { data: { userId, balance: 500000 }, success: true }
```

⚠️ **`userId` 用凭据里的 `account_id`（`usr-…`），不是 JWT 的 `sub`（`user_…`）**：
实测传 `sub` 返回 `400 {"error":"Invalid request format"}`。

⚠️ **401 的响应体是 `{error:"…"}`，没有 `success` 字段** —— 解析器必须两种失败形态
都认，否则 401 会落到误导性的「响应缺少 data 字段」，把服务端给的唯一有用线索丢掉
（真实缺陷，已由 `tests/unit/cline-credits.spec.ts` 锁死）。

⚠️ **余额单位**：实测 `balance: 500000`。按 1e-5 USD 解释为 **$5.00**，与 Cline
公开的新账号赠额一致 —— 这是选取 `CLINE_BALANCE_SCALE = 100000` 的独立锚点。
⚠️ **不要用 `/usages` 的 `costUsd` 反推该系数**：实测单次记录
`{creditsUsed:0, costUsd:1320, totalTokens:49}`，按 1e-5 解释会是 $269/1M token
（flash 档不可能），说明两者**口径不同**。只读 e2e 探针会打印原始值供核对。

**签到不存在**：对整个 sidecar 做字符串扫描，`checkin` / `check-in` / `daily` /
`campaign` 均无任何 Cline 业务端点命中（`campaign` 的命中是 PostHog 的 UTM 参数与
feature-flag 事件属性；`daily` 是 YAML cron 别名与 Blob 导出频率枚举）。故能力矩阵
登记为 `{balance:true, dailyCheckin:false}`（与 WorkBuddy 国际版同例）。
⚠️ 这比「某次调用没看到」强，但仍不等于「永远不存在」—— 若将来增加签到，需按
Qoder 那次教训重新采集。

### e2e 闸门（付费保护，**请勿削弱**）

```
DSH_CLINE_E2E=1                          只读探针（凭据/前缀证据/余额/免费集合）
DSH_CLINE_CHAT_E2E=1 + ..._CONFIRM=yes   默认**只**请求 cline-free/deepseek-v4.1-flash
DSH_CLINE_CHAT_E2E_ALL_FREE=1            才遍历其余 4 个免费模型
```

理由：免费资格是**服务端随时可撤销**的营销状态。无条件遍历「远端此刻说免费」的
那批模型，某天某个转为计费后，一次 e2e 就会**按付费价刷 token**。

`assertFreeModel()` 是安全边界：任何 `isFree === false` 的模型（无论来自
`DSH_CLINE_MODEL` 还是远端列表）都**直接抛错、不发请求**；遍历分支还做逐个二次确认
（已不在**当前** free 集合中即跳过）。

### ⚠️ 面板图标必须从官方资源提取，**不得凭印象手绘**

**真实缺陷**（用户报障）：「我们用的图标和 cline 的好像不一样」。

初版 `CLINE_ICON` 是**凭印象手绘**的内联 SVG（「深色圆角方块 + 白色 C 形弧线」），
与 Cline 真实标志完全不符 —— 真实标志是**顶部带凸起的圆角方块 + 中间两条竖线 +
左右两侧尖角**，品牌紫底。

**教训：品牌图标必须从官方资源提取。** 修法与工具：

- 官方图标**就在安装目录里**，不必从 exe 抠 PE 资源：
  ```
  %LOCALAPPDATA%\Cline\icons\app\{classic,chip,hologram,midnight}.png   148×148
  %LOCALAPPDATA%\Cline\icons\app\macos\*.png                            1024×1024  ← 用这个
  ```
  （`cline-app.exe` 内嵌的主图标只有 **32×32** 且是 **midnight** 主题，不适合。）
- 提取脚本 **`scripts/extract-cline-icon.mjs`**（纯 Node，**零第三方依赖**：
  PNG 解码/编码用内置 `zlib` 手写，只支持官方图标的
  bit depth 8 + color type 6/2 + 非隔行）：
  ```
  node scripts/extract-cline-icon.mjs                    # classic，48×48，写入 jet-hub.js
  node scripts/extract-cline-icon.mjs --dry-run
  node scripts/extract-cline-icon.mjs --theme=midnight --size=64
  node scripts/extract-cline-icon.mjs --out=icon.png     # 另存供目视
  ```
- **主题选 classic（品牌紫 `#7271E5`）**，理由：`midnight`（exe 内嵌的默认主题）
  是近黑底，与 **Qoder 图标的深蓝黑 `#1f2a3f`** 在容器实际尺寸 **20×20** 下
  几乎无法区分，列表里会混淆；`chip`（绿色电路板）缩到 20×20 后纹理退化成噪点；
  `hologram` 在白底容器里对比度不足。另：紫色在当前 7 个 provider 图标里**未被占用**。
- ⚠️ **缩放必须做 alpha 加权（预乘）平均**：图标边缘是抗锯齿的半透明像素，
  直接对未预乘 RGB 平均会混入透明区的黑色，产出**发黑的描边**。
- ⚠️ 脚本的替换逻辑用**全局匹配、只保留一行**：单次 `String.replace` 一旦
  文件里出现重复的 `const CLINE_ICON` 声明就会残留 → esbuild 直接报
  `The symbol "CLINE_ICON" has already been declared`（开发期踩过一次），
  现在重复运行幂等且能自愈重复行。
- **回归测试 `tests/unit/cline-icon.spec.ts`**：锁定 ① 必须是结构完整的 **PNG**
  （防退回手绘 SVG）、② 尺寸 48×48、③ 与「从官方 `classic.png` 重新提取」
  **逐字节一致**（无 Cline 安装时该条干净跳过）。
  已做**反向验证**：把前缀改回 `data:image/svg+xml` 后 4 条用例失败。

### 其它

- 推理端点是**标准 OpenAI 兼容**（`POST {apiBase}/api/v1/chat/completions`），
  故复用 `src/openai-compat.ts` 全套（消息序列化 / SSE 消费 / 错误归类），与 Qoder 同做法。
- 客户端标识头（推理与账号端点都带）：`HTTP-Referer: https://cline.bot`、
  `X-Title: Cline`、`X-IS-MULTIROOT: false`、`X-CLIENT-TYPE: cline-sdk`。
- `max_tokens` 上界收敛到 **943718**（内嵌目录最大 `maxTokens`，取自
  `muse-spark-1.3-contributor`），不自行编造更大值。
- 单元测试 7 个文件：`cline.spec.ts` / `cline-models.spec.ts` / `cline-oauth.spec.ts` /
  `cline-credits.spec.ts` / `cline-quota.spec.ts` / `cline-auth.spec.ts` / `cline-adapter.spec.ts`。

### ⚠️ Cline「订阅额度」：官方额度窗口 + 请求记录（2026-09-29 新增）

Cline 面板的账号管理区有一个**订阅额度**按钮（只在 Cline 出现），点开是弹窗：
上半部是**官方额度窗口**（5 小时 / 周 / 月各用掉百分之几 + 重置时刻），
下半部是**请求记录**（逐笔：时间、模型、token、积分）。

与账号卡片上的「积分」是**多份不同的读数，不能互相替代**：

| | 积分（既有） | 订阅额度（本次） | 请求记录（本地流水） |
|---|---|---|---|
| 回答的问题 | 还剩多少钱 | 各时间窗用掉百分之几 | **本插件发出的**每笔请求：多久、多少 token |
| 来源 | `/api/v1/users/{id}/balance` | `/api/v1/users/me/plan/usage-limits` | `src/cline-request-log.ts`（进程内存） |

参考实现：`github.com/codeOct/dsh-cline-pass` 的额度管理与请求记录部分。

### ⚠️ 请求记录是**本地流水**，不是网关账单（2026-09-30 按用户反馈改造）

**用户反馈**：「请求记录展示的字段和我给你的参考也不一样」——首版把请求记录
对齐到了网关 `/users/{id}/usages`（字段 `createdAt / aiModelName / aiModelTypeName
/ totalTokens / creditsUsed / costUsd`）。**那是错的**：网关记录的是该账号在
**官方所有渠道**的消费账单，没有延迟、没有首块时间，字段也对不齐参考实现。

**改法**（对齐参考实现的请求记录部分）：

- 新增 `src/cline-request-log.ts`：适配器发出的每笔推理请求记录
  `{ ts, model, accountId, usageReported, inputTokens, outputTokens,
  cacheReadTokens?, reasoningTokens?, effort, ttftMs, totalMs, error? }`。
- `src/cline-adapter.ts` 的 stream() 有**两个**消费出口（换号成功后的 consume
  与正常路径的 consume），**都**走 `consumeWithLog()`（内部再调 `this.consume`）
  —— 接线由 `cline-adapter.spec.ts` 的源码断言锁死（`yield* this.consume(`
  不得再出现）。
- 记录的**取舍**（与参考实现的差异及理由）：
  - 不记 `ttfb`：单一网关、无 upstream 选路，响应头与首块之间没有独立阶段。
    表格的延迟列仍按参考实现给**三行**（首字 / 总耗时 / 输出速率）。
  - 换号过程**不逐笔记**：只记**最终结果**一笔 —— 参考实现会把每次
    AUTH/QUOTA attempt 都记成失败行，本适配器的 429 换号风暴（最多 3 轮）
    会把 100 条上限刷满；「所有账号均不可用」这行已包含换号语义。
  - usage 帧在**经过时捕获**：流中途 abort / 上游提前断开时 usage 没被消费到，
    此时记 `usageReported: false`（**不是记 0**）—— 表格据此显示 `—`；
    记 0 会被读成「瞬间完成、没花 token」（参考实现同约定）。
  - **记录绝不抛错**：它在推理关键路径上，记账失败不得反噬推理
    （record 内部全部 try/catch + 钳制 + 截断）。
- 存储：**进程内存，100 条，重启即丢**（刻意，与参考一致；高频写不适合持久化）。

### ⚠️⚠️ 请求记录的「账号」必须用**账号池 id**，不能用凭据里的 `account_id`（真实缺陷，2026-09-30）

**用户报障**：「请求记录中数据空白，没有记录下来」。

**根因是两个 id 空间被混用** —— 字段名叫 `accountId` 的有**两套值**：

| 位置 | 值 | 形如 |
|---|---|---|
| 面板的过滤条件 `cline.requestLog.accountId` | **账号池 id**（取自 `cline.quota` 的 `accounts[].accountId`，即 `account.id`） | `cline-bb211a53` |
| 适配器原先在**成功路径**记的 | 凭据里的 `account_id`（Cline 的**用户 id**） | `usr-01M3BCV4FY…` |

两者不相等 ⇒ `readClineRequestHistory({ accountId })` 恒返回空 ⇒ 表格**永远空白**。
（换号路径当时记的却是池 id —— 同一缺陷的两半，两条出口口径不一致。）

**修法**：`ClineAdapterOptions` 新增 `currentAccountId?: () => string | undefined`，
由 `src/index.ts` 在 `resolveCredential` 里记录**实际选中的池账号**
（`activeClineAccountId`，与 `activeQoderAccountId` 同因、同写法）；
适配器在 stream() 开头用它做**局部变量**的起点（只在首次取值，
换号后自行跟进），两个出口都用「池 id 优先、无池账号才退回 `usr-…`」。

⚠️ **反向验证已做**（本仓库要求）：把正常路径改回 `credential.account_id ?? …`
→ `cline-adapter.spec.ts` 的「请求记录归属『账号池 id』」**变红**，报错为
`expected 'usr-01M3BCV4FYCGJKAWD3MJG3DBQM' to be 'cline-bb211a53'`；还原后全绿。

⚠️ **做这次反向验证时连踩两个工具坑**（都会让验证**假绿**，务必避开）：
1. **同一表达式在文件里出现两次**（换号路径 + 正常路径，文本完全相同）——
   用字符串 `replace` 命中的是**第一处（换号路径）**，而用例走的是正常路径，
   于是「回退了却仍全绿」。必须按**上下文/最后一次出现**定位。
2. **本仓库源文件是 CRLF**：脚本里写 `\n` 的**多行**锚点永远匹配不上
   （单行锚点没事，所以第一次只替换成功的假象更难发现）。按行处理即可。
   ⚠️ 另：**Windows 下别用内联 `node -e`**，PowerShell 会吃掉
   `\``/`$`/引号（本次两次静默跑错），写成 `.mjs` 文件再跑。

### ⚠️⚠️ 请求记录的三处**展示语义**缺陷（2026-09-30 用户复核，一次报三个）

用户报障原文：「**上游显示的不正确**」「支持图片的模型**发送不了图片**」
「请求记录中：输出速率 `11814.8 t/s` 这个是不是也有问题」。
三者**根因各不相同**，但都属于「字段取错了口径」，逐个记下：

#### ① 「上游」列取的是**模型命名空间**，不是 serving channel

- 原实现：`clineUpstreamOf(model)` = 模型 id 的 `/` 前缀（`cline-pass` /
  `cline-free`），**甚至是厂商名**（`deepseek/deepseek-v4.1-flash` → `deepseek`）。
  那是「订阅通道/厂商」，不是「谁服务了这笔请求」。
- 参考实现同一列显示的是 **`alibaba` / `baseten`** 这类真实渠道，取自网关
  下发的路由元数据（其 `parseRouting()`）。
- **落点**（三种实测形态，`src/cline-routing.ts`）：

  | 形态 | 路径 |
  |---|---|
  | **流式（真实链路）** | `choices[0].delta.provider_metadata.gateway.routing.finalProvider` |
  | 非流式 / planner | `choices[0].message.provider_metadata.gateway.routing.finalProvider` |
  | 帧顶层 | `provider_metadata.gateway.routing.finalProvider` |
  | direct | `delta.provider` / 顶层 `provider`（如 `GMICloud`，原样保留） |

  ⚠️ **大小写两种拼写都要认**：本仓库另一处实测（Gemini-400 段）记的是
  **camelCase** `providerMetadata`，参考样例是 snake_case；只认一种会在另一种
  形态下静默读不到。
  ⚠️ 参考注释：*"in a stream it appears on whichever frame carries it, so every
  frame is inspected and the last non-null reading wins"* ⇒ **逐帧**观测、
  最后一次非空为准。
- **实现**：`consumeOpenAiSse` 新增**可选旁路** `onFrame`（回调抛错被吞掉 ——
  观测绝不能打死一次正常推理）；适配器在 `consumeWithLog` 里累积，写进
  `ClineRequestEntry.upstream`。**空串 = 网关没报**，RPC 侧才回落到模型命名空间。
- 反向验证：停掉逐帧观测 → 用例红（`expected '' to be 'deepseek'`）。

⚠️⚠️ **第一版读漏了 `delta` 这一层，整处修复在真实链路上完全没生效**
（用户 2026-10-01 第二次报障：「**上游**和**请求速率**为什么显示的还是错误的」；
进程核对过 —— 00:30 启动的进程**已含** 00:09 那次安装，不是「没加载」）。
当时按「非流式挂 `message`、**流式挂帧顶层**」实现，而**实测的流式帧把它挂在
`choices[0].delta` 上** ⇒ 每帧都读不到、`upstream` 恒为空串、展示层回落到
`cline-pass`，用户看到的与修复前**一模一样**。

**两条教训（都比这一处 bug 值钱）**：

1. ⚠️ **外部载荷的确切层级只能实测，不能按参考实现的只言片语推断**。参考实现
   只说了「出现在携带它的那一帧上」，**没有说挂在 `delta` 还是帧顶层**，我按
   猜测填了帧顶层。一次性探针
   （`scripts/probe-cline-routing-live.mjs`：用凭据库里的 token 发一次极小流式
   请求，**逐帧打印命中的 JSON 路径**）当场就能定案 —— 这类「形状假设」必须
   在写实现时就用探针钉死，或至少在注释里标成**未验证假设**。
2. ⚠️⚠️ **fixture 写错等于没有测试**：适配器那条 `upstream` 用例当时用的是
   **帧顶层**的 fixture（即我的猜测），于是**用例绿、功能坏**，直到用户第二次
   报障才暴露。凡涉及外部响应形状的 fixture，必须照实测量到的报文写，
   并把「实测来源 + 日期 + 探针名」写进注释（现已如此）。

   ⚠️ 探针本身也踩了一个坑：仓库里的 `access_token` **已含 `workos:` 前缀**
   （`buildClineCredential` 写入时就加了），再拼一次 ⇒ `Bearer workos:workos:…`
   ⇒ **401**。第一版探针因此误判「两个账号的 token 都失效」。

**顺带核清的 `finalProvider` 语义**：它既可能是**基础设施商**（参考实现抓到的
`alibaba` / `baseten`），也可能是**模型厂商自己的 API** —— 本机实测
`cline-pass/deepseek-v4.1-flash` → `finalProvider = "deepseek"`。两者都是
「网关最终决定由谁服务」，故**原样展示**、不要试图归类。

**同时给「输出速率」补了 `—` 的原因提示**（`latencyParts` 新增 `rateTitle`，
挂在那一行的 `title` 上）：不可测有两种情形，各自给话 ——
`本次没有正文块（只输出思考，或流在正文之前结束）` /
`正文阶段只有 Nms（不足 250ms）—— 响应几乎一次性到达`。
用户第二次报障时正是怀疑「速率还是错的」，而实际是**不可测**；
一个横杠不解释，就会被读成「坏了」。

#### ② 图片能力只查本地兜底表 + **`cline-pass` 目录不全**（同一处修复）

用户后来又报了同一条链上的第二个症状：「**当前 cline 供应商的模型列表中关于
cline-pass 部分模型为什么不全**，例如当前这个模型就看不到了」。两者同源：
**models.dev 这份目录此前完全没被当作目录来源**。

- 原实现：`inputModalitiesFor()` 只看 `product.fallbackModels[].supportsImage`
  —— **全表只有 5 条、且全是 `cline-free/*`**；而远端两个目录端点
  **都不下发能力字段**（实测 `recommended-models` 只有
  `{id,name,description,tags}`，`/models` 只有裸 id）。
  ⇒ DSH 按适配器播报的 `inputModalities` 决定要不要把图片投影成占位符，
  于是**图片根本送不进适配器** —— 用户看到的就是「支持图片的模型发不了图」。
- **目录也不全（实测对账，2026-09-30）**：

  | 来源 | `cline-pass/*` 条数 |
  |---|---|
  | 网关 `recommended-models` 的 `clinePass` 数组 | **14** |
  | models.dev 的 `cline-pass` provider 块 | **18** |

  差的 4 条 —— `kimi-k2.6` / `glm-5.2` / `kimi-k2.7-code` / `deepseek-v4-flash`
  —— 在本插件里**根本不存在**，用户既看不到也选不到。
  另外网关给 `cline-pass/*` 的 `name` **就是 id 本身**
  （`name === 'cline-pass/mimo-v2.6-flash'`），列表里全是裸 id 也让人无从辨认；
  models.dev 给的是可读名（`DeepSeek V4.1 Flash`）。
- **权威来源：`https://models.dev/api.json` 的 `cline-pass` provider 块**
  （实测 18 条，逐条带 `modalities.input` 与 `limit`）：
  `cline-pass/deepseek-v4.1-flash` → `["text","image"]`、
  `cline-pass/minimax-m3` → `["text","image","video"]`、
  `cline-pass/glm-5.3` → `["text"]`。参考实现用的**正是同一来源**
  （其 `MODELS_DEV_URL`；面板里「Rescan the official subscription list and
  **adopt newly published models**」就是这一步 —— 注释原文：
  *"Without it a model newer than this release resolves to the `text` fallback
  and the harness refuses every image for it, silently."* 两处报障同型）。
- **实现口径**（`src/cline-models-dev.ts`，替代原先只管模态的
  `cline-modalities.ts`）：models.dev 是**目录的第三个来源**，
  在 `ensureRemoteModels()` 里用 `applyModelsDevCatalog()` 并入：
  1. **补缺**：目录里没有的 id **追加在该前缀最后一条之后**
     （不能挂第一条后 —— 那会插到同族中间；更不能追加到列表末尾 ——
     那里沉在 460 条远端 id 之后，等于没人看得到）；
  2. **补名字**：仅当 `name === id`（网关把 id 当名字下发）时用可读名替换；
  3. **补窗口**：`contextWindow` 缺失时才用 models.dev 的 `limit.context`；
  4. ⚠️ **不取 `limit.output`**：那是要**真的写进请求体 `max_tokens`** 的值，
     本仓库有过「据印象填大值 → vertex/google 400」的真实缺陷
     （见本文件 Gemini-400 段），故只补展示名与窗口，不碰输出上限。
  ⚠️ **一律不覆盖已有值**：策展的本地兜底表与网关数据优先于社区目录
  （显式 `supportsImage: false` 也照样赢）。
  ⚠️ **只认 `image`**（夹取掉 audio/video/pdf —— DSH 词表只有 text/image）。
  ⚠️ **失败向上抛、不缓存**（`TtlCache` 只在成功时写入 ⇒ 下次可重试），
  适配器侧吞掉并保持「这一层没有补充」。TTL **6 小时**（发布节奏的数据）。
- ⚠️ **「没读到」≠「不支持」**：读不到时目录照常工作、图片能力退回本地兜底表；
  把前者当后者正是本次缺陷的形态。
- 反向验证：停用 `applyModelsDevCatalog` 那一行 → **两条**用例同时变红：
  `图片能力取自 models.dev：cline-pass/* 也能发图`（报错
  `cline: 模型 "cline-pass/deepseek-v4.1-flash" 不支持图片输入`）
  与 `models.dev 补全 cline-pass 目录`。

⚠️ **排障提示（本次顺带查明的第三种「看不到」）**：目录里有 14 条 `cline-pass`，
但**用户的黑名单关掉了 10 条**（`~/.dsh/jet-hub/state.json` 的
`disabledModels.cline`，实测 474 条 cline 模型被关），模型选择器里因此只剩
4 条 —— 那是**用户自己的模型开关**，不是目录缺失。Jet Hub 的模型列表会渲染
被关闭的模型（`listAllModels()` 就是为此存在），所以能在那里重新打开。
**两种「看不到」的判据不同，别混**：黑名单造成的在 Jet Hub 里能看到（带开关）、
目录缺失的在任何地方都没有。

#### ③ 「输出速度（TPS）」= **DeepSeek 官方口径**（用户 2026-10-01 定案）

> 用户原话：「**按照官方速率显示规则来**」（此前明确「我说的 deep seek」）。
> ⚠️ **这一节取代了我 2026-09-30 那版「正文阶段」口径 —— 那版被用户否掉了。**

**官方规则**（只读核对，出处是本机 DSH 自己的聊天 UI：
`@deepseek-ai/dsh-client-ui-chat/lib/client.js`，可在
`D:\Program Files\DeepSeek Harness\resources\app.asar` 里直接读到）：

```js
// assistantStepReading(node)：一「步」的读数
ttftMs   = firstTokenTime - stepStartTime      // 首个 token（任意块，含推理块）
decodeMs = completedTime  - firstTokenTime     // 首 token 之后 → 结束
outputTokens = usage.outputTokens              // 该步全部输出 token

// TimePill()：显示（decodeMs > 0 才显示，否则整项不渲染）
tps = formatTokensPerSecond(outputTokens / (decodeMs / 1e3))

// formatTokensPerSecond()：取整规则（先 clamp 负值）
x >= 10 ? String(Math.round(x)) : String(Math.round(x * 10) / 10)
```

官方 i18n：`message.tokensPerSecond = "{tps} tok/s"`、
`stats.dialog.speed = "输出速度（TPS）"`。

**本插件据此落地**（`plugin-src/client/tokens-per-second.js`，纯函数可逐值单测；
`jet-hub.js` 只负责组装三行）：

| 项 | 取值 |
|---|---|
| 分子 | **全部输出 token（含推理 token）** —— ⚠️ **不减** `reasoningTokens` |
| 分母 | `总耗时 − 首字`（`decodeMs`），**不含**首字之前那段 |
| 门禁 | 只有 `decodeMs > 0`；⚠️ **没有**最小窗口下限 |
| 单位/标签 | `tok/s` / 「输出速度（TPS）」（单元格里用短版「输出速度」） |

⚠️⚠️ **三处曾经的错误做法，别再改回去**（每条都有反向验证过的用例守着）：

1. **`11814.8 t/s` 那次不是"公式错"**：官方口径在**短窗口**下本来就会给出很大的数
   （响应几乎一次性到达时 `首字 ≈ 总耗时`，`142 token ÷ 12ms ≈ 11833 tok/s`）。
   我 09-30 的反应是改分子分母 + 加 250ms 下限 —— **那是过度纠正**，官方没有下限，
   改了反而与本 app 自己的读数不一致。
2. **不要减推理 token**：`reasoning_tokens` 计入 `completion_tokens`（本仓库多处实测），
   官方就是这么算的。减了会让同一笔请求的 TPS 与 DSH 显示的不同。
3. **不要退回 `toFixed(1)`**：官方的精度是**两段式**（`≥10` 整数、`<10` 一位小数），
   不是统一小数位。反向验证：把取整换成 `toFixed(1)` → **7 条**用例变红
   （`expected '273.9 tok/s' to be '274 tok/s'` 等）；把分子改成「减推理」→ 1 条变红。

⚠️ **`ttfcMs`（首个正文块耗时）现在只是诊断字段**，**不参与**速率计算：
官方口径只用 `首字`（首个任意块）。字段仍照常记录（适配器 → 请求记录 → RPC），
将来若要显示「首正文」可直接用；但**不要**拿它当速率分母。

⚠️ **`ttftMs === 0` 在我们的数据模型里是「没有任何块到达」= 未知**（官方用 `null`），
故 `formatRowTokensPerSecond` 把 `0` 显式映射成**不可测**（显示 `—`）——
照字面算 `total - 0` 会把「首字时刻未知」当成「首字在 0ms」，报出假速率。
这条映射有专门用例（`缺首字时刻（ttft=0 = 未知）→ —`）。

⚠️ **旧断言又锁死了一次旧实现**：`cline-quota-panel.spec.ts` 里原先那条
「输出速率按正文阶段算」的用例（断言 `MIN_RATE_WINDOW_MS` / `contentTokens`）
正是锁 09-30 那版口径的，本次已改写为「接线到 `tokens-per-second.js`」。
**改口径必须同步改用例** —— 这在本仓库已是第三次同型情况
（账号池 id、平铺渲染、此处）。

⚠️ **反向验证脚本自身的坑（第 4 次同型）**：`swap-tps-official.mjs` 打补丁时
**第一版打到了文档注释里那行官方代码**（我在模块头注释里引用了
`x >= 10 ? … : …`），于是「取消官方取整」的反向验证**假绿**（13 条全过）。
判据：**要改的是函数体，必须取最后一次出现**（`lastIdx`）。
这与本文件记过的「同一表达式出现两次、替换打到第一处」是同一条教训 ——
**换行数/取最后出现**，并在反向验证后**确认它真的变红**（假绿比不验证更危险）。

⚠️ **另记一处未修的小缺口**（不属本次报障，留给后续）：
`recommended-models` 实测还有第 4 个数组 **`clineCloud`**（3 条，如
`cline-cloud/glm-5.3`），而 `parseClineRecommendedModels` 只读
`free`/`recommended`/`clinePass` ⇒ 这批模型拿不到 `name`/`description`
（只能靠 `/models` 的裸 id 出现）。改动会影响模型列表内容，故未顺手做。

### ⚠️ 模型列表的**「计费/来源」分组**（用户要求，2026-10-01）

用户问「模型列表能够分组显示吗」→ 选定口径 **B：按计费/来源分 4 组**（而不是
按 67 个命名空间），并要求**每组一个「全开 / 全关」**。实测目录规模 **488 条**
（`openai` 104 / `qwen` 54 / `google` 41 / `anthropic` 29 …），平铺确实没法看。

**只有 Jet Hub 的「显示列表」能分组**；⚠️ **对话框里的模型选择器不能** ——
那是 harness 自己的 UI（`dsh-client-ui-model-selection`），它只按 **provider**
分组，`cline` 在里面必然是一个大组；我们能影响的只有每个模型的 id/name。

#### 分组口径（`plugin-src/client/model-groups.js`，纯函数）

| 组 | 判据 | 实测规模 |
|---|---|---|
| 订阅额度 | `cline-pass/*` | 18 |
| 免费额度 | **目录下发的 `isFree === true`** | 7（5 `cline-free/*` + 2 `stealth/*`） |
| Cline Cloud | `cline-cloud/*` | 有则显示；**空组不渲染** |
| 按量计费 | 其余全部（走账户余额结算） | 460+ |

⚠️⚠️ **免费必须用 `isFree`，不能在前端按前缀猜**：免费集合是远端
`recommended-models` 的 `free` 数组 + `:free` 后缀 + `cline-free/` 前缀的
**并集**（见 `cline-models.ts`），而 **`stealth/pixel-canary` /
`stealth/space-bunny-alpha` 在 `free` 数组里却不在 `cline-free/` 命名空间下**
—— 按前缀判会把这两条**免费模型错归进「按量计费」**，用户以为要花钱而不敢用。
⚠️ `isFree` **缺失**（老/外部适配器不报）时保守归入「按量计费」：那是兜底桶，
「没说免费」比「谎称免费」安全（与全仓「未知不编造」一致）。

#### 展开策略（`groupExpanded`）

优先级：**用户点过 > 有筛选 > 默认**。默认**「按量计费」折叠、其余展开**
（前者是兜底大桶、多数是关的，默认展开等于把列表撑到没法用）；**有搜索/筛选时
一律展开**（否则搜到的结果藏在折叠组里，看起来像「没搜到」）。
⚠️ **不要把默认值烘焙进 state**：只存「用户点过的组」，否则「清空筛选后恢复
默认」就做不到了。

#### ⚠️ 新增端点 `model.setDisabledMany`（按子集），**不能**复用 `setAllDisabled`

分组的「本组全开/全关」必须只动本组的 id。若图省事复用
`model.setAllDisabled`：**它的打开方向是「清空整张黑名单」** ⇒
「只打开订阅额度这一组」会把用户特意关着的**按量计费 460 多条一起打开**。

- 池新增 `AccountPool.clearModelsDisabled(provider, modelIds)`：**只删传入的 id**
  （与 `clearDisabledModels` 的「清空全部、并顺带清掉已下线死键」是**两个语义**，
  别混）；**无实际变更不落盘**（该组本就全开时不该产生一次文档重写 + 目录广播）。
- 端点：校验 `provider` / `modelIds` 数组 / `disabled` 布尔（**不猜默认值**，
  与另两个开关端点同约定），**去重 + 剔脏值后为空则拒**，只落盘一次、只广播一次。
- 反向验证：把打开方向改回 `clearDisabledModels` → 用例红
  （`expected {} to deeply equal { Object (buddy) }`，即「其它组的关闭项被一起清掉了」）。

#### `model.list` 新增 `isFree`（缺失不编造）

`ModelCatalogSource.listAllModels()` 的返回类型扩展为
`{ id, name, isFree?: boolean }`，`ClineAdapter` 填上（它来自目录合并的
`isFree`，与模型选择器里的「· 免费」标签**同源**）。RPC 层**照原样透传、缺失
就不写这个字段** —— 不编造 `false`（类型上是 `isFree?: boolean`）。

#### ⚠️⚠️ 验证盲区：客户端改动**单测全绿也不代表 bundle 能构建**

`plugin-src/client/*.js` 的改动在本仓库**只被两种方式验证**：纯函数单测 + 把
`jet-hub.js` 当**文本**读的源码级断言。二者都**不做语法解析** ⇒
**必须另跑 `pnpm build:client`（或 `build:all`）**。
本次真踩到：分组渲染用**块体箭头函数**（`group => { ... return ... }`），收尾括号
比原来的**表达式体**少一层，我多打了一个 `)` —— 3809 条单测全绿、esbuild 报
`Expected ";" but found ")"`。**改完客户端一律跑一次构建**。

回归用例 `tests/unit/model-groups.spec.ts`（21 条：归组 / 并集不丢模型 /
组内筛选与计数 / 展开策略 / 组内批量可用性 + 4 条源码级接线断言），
端点用例在 `tests/unit/jet-hub-rpc.spec.ts` 的 `model.setDisabledMany` 段（10 条）。
⚠️ 同时更新了 `model-filter.spec.ts` 里锁**旧平铺渲染**的那条断言
（`filtered.map(...)` → `group.models.map(...)`）—— 与以往同型：**旧断言可能锁死
被有意改掉的实现**。

### ⚠️ 额度窗口与请求记录**共享同一个翻页索引**（用户要求）

「订阅额度」弹窗改为：**一次只显示一个账号**，用左右箭头 `‹ ›` 翻页；
**额度窗口与请求记录一起切**（用户明确要求「统一切换」）。参考实现同款。

要点（多数是参考实现踩过的坑）：

- 索引是**纯本地状态**，**不要用 useEffect 播种**（列表一到就 set(0)）——
  那会让「浏览位置」与「显示的是谁」短暂分叉。当前账号在**渲染期纯计算**
  （`quota[Math.min(viewIndex, quota.length - 1)]`），越界钳制但**不回写**，
  账号恢复后还能回到原位。
- 翻页是**纯本地**（额度数据一次性取回），切账号时只有请求记录需要重新拉取。
- **环绕**：末个账号的右箭头回第一个（单向尽头会让用户以为「后面没了」）。
- 单账号**整行名字都不渲染**（参考实现同款：箭头无处可去，账号名也不构成
  区分信息）。「这是谁的额度」改由**弹窗副标题**给出（多账号 = `Cline · {n} 个账号`，
  单账号 = `Cline · 账号 {名}`）—— 否则单账号用户看不到是谁的额度。
- **竞态**：切账号会丢弃未完成的旧请求记录响应（按请求序号「最新获胜」），
  否则旧响应后到会覆盖新账号的数据。

### ⚠️ 与参考实现的**逐项对齐**（2026-09-30 用户报障「没有 1:1 还原」后重做）

**用户判据**：额度窗口与请求记录要么**逐项**与
`github.com/codeOct/dsh-cline-pass`（main @ `abab1dd`）一致，要么说明为什么不一致。
首版是按「精神」做的**子集**，故这次逐条对照后重做。已对齐项与**被推翻的旧实现**：

| 项 | 参考实现（main） | 首版（错） | 现状 |
|---|---|---|---|
| 记录表列 | **5 列含状态点**（绿/红点，title 给错误） | 4 列、无状态点 | ✅ 5 列 |
| 延迟列 | **三行**：首字 / 总耗时 / **输出速率 t/s** | 单行「首块 X · 共 Y」 | ✅ 三行 |
| TOKEN 列 | `↓入 ↑出 ⚡缓存 🧠推理`（图标 + k/M 有界缩写） | `123 + 456`，丢缓存 | ✅ 图标格式 |
| 未收 usage 帧 | 显示 **`—`**（≠ 花 0） | `0 + 0` ← **语义错误** | ✅ `usageReported:false` → `—` |
| 未知耗时 | **破折号 `—`**（`stamp`/`rate`） | 半角 `-` | ✅ `—` |
| TOKEN tooltip | 精确数字 + **图例**（`—` 的含义） | 只有一句替代文案 | ✅ `TOKEN_LEGEND` |
| 行 tooltip | 汇总 5 行事实（含**推理强度**） | 无 | ✅ 含 `effort` |
| 额度窗口布局 | **grid 卡片**（auto-fit / 170px）+ **18px** 大字百分比 | 纵向列表 + 13px | ✅ grid + 18px |
| 百分比 | `Math.max(0, Math.min(100, x))` + **取整** | 保留一位小数、**故意不夹** | ✅ 夹取+取整 |
| 进度条配色 | ≥90 红 / ≥70 黄 / 其余**绿**（`usageColor`） | ≥100 红 / ≥80 黄 / 其余**蓝** | ✅ 三档绿底 |
| 窗口顺序 | 已知窗口**固定顺序在前**、未知**追加在后** | 纯按网关原序 | ✅ `QUOTA_WINDOWS` |
| 账号块 key | 按账号 id → **重挂载**（进度条不跨账号动画） | 无 key | ✅ `key: entry.accountId` |
| 模型名 | 去 `cline-pass/` 前缀 + 上游 tag | 原样 | ✅ 去前缀 |
| 失败行 | 空 2 格 + **`colSpan 3`**（消息从模型列起） | `colSpan 4` | ✅ `colSpan: 3` |
| 表格 | 自带 **280px 滚动** + **sticky 表头** + 全列居中 | 靠弹窗滚动、左对齐 | ✅ 同款 |
| 列宽 | `colgroup` 提示（状态点 16px / 时间 82px） | 无 | ✅ `colgroup` |

⚠️ **被参考实现自己删除、我们也不补**：额度卡曾经有「token 用量 / 已用金额 /
折算剩余 token」——参考 `client.js` 的 `UsageCard` 注释明确写了那些数字是
*derived, unverifiable*，**作者已主动删除**，卡片只留「百分比 + 重置时刻」。
排查时不要再去参考的 README（不同 commit 的描述）里找这三项。

⚠️ **刻意保留的措辞差异**（不是漏改）：jet-hub 沿用本插件自己的命名
「**订阅额度**」/「**请求记录**」（参考叫「官方额度」/「最近请求」）——
按钮名是用户在前一轮明确指定的，改掉会让同一功能在两个入口有两套叫法。
除措辞外，布局、字段、格式化与配色全部对齐。

⚠️ **数据层随之扩了三件事**（缺任何一件都会让上面某行显示不出来）：
`usageReported`（`—` 的判据）、`cacheReadTokens`（`⚡` 那一项）、
`effort`（行 tooltip 的推理强度行）。三者都已接线
`cline-adapter → cline-request-log → jet-hub-rpc → types`，
并由 `cline-request-log.spec.ts` / `jet-hub-rpc.spec.ts` 锁死。

回归用例 `tests/unit/cline-quota-panel.spec.ts` **在 2026-09-30 被整体重写**：
旧断言锁的是首版自创形态（「百分比不夹取」「单行延迟」等），与用户给的判据
直接冲突，故换判据而非删断言。**不要照着旧断言改回去。**

### ⚠️ 五个实测坑（沿用参考实现已核实的结论，**不要重新踩**）

1. **分页参数只认 `cursor`**，值取自响应 `data.nextToken`。
   `nextToken` / `next_token` / `page` / `offset` / `skip` 作为**请求参数**会被网关
   **静默忽略** —— 永远返回同一页。早期据此连翻会**重复计数**，得出
   「已用 28 亿 token、超限 120%」这种荒谬结果。
2. **`data.total` 恒为 0**，不能用来算页数或总量。
3. **`/usages` 忽略 `startDate` / `endDate`**：只按时间**倒序**返回，
   要按窗口截断只能读每行的 `createdAt`。
4. **`resetsAt` 是 ISO 字符串**，不是数字时间戳 —— ⚠️ 故**不能**复用客户端的
   `formatTime()`（它按毫秒运算，传字符串会一律显示「已过期」，
   把 6 小时后重置的窗口说成已重置）。现由 `quotaCountdown` / `quotaResetsIn`
   负责（`Date.parse` + 粗粒度倒计时），记录表的「时间」列另用 `formatStamp`。
5. **`userId` 用凭据里的 `account_id`（`usr-…`）**，不是 JWT 的 `sub`（`user_…`）：
   后者实测 `400 Invalid request format`。而**额度端点用字面量 `users/me`**，
   不依赖 `account_id`（两者口径不同，别顺手统一）。

#### 设计要点（改这个功能前先读）

- **能力表两侧必须同时改**：客户端 `CREDITS_CAPABILITIES.cline.subscriptionQuota`
  决定按钮是否渲染；服务端 `cline.quota` / `cline.requestLog` 对非 Cline 一律
  `bad-request`。只改一边就是「按钮在、点了报错」或「功能存在却点不出来」。
  `credits-capabilities.spec.ts` 用**全表推导**守住「只有 cline 登记」。
- **`subscriptionQuota` 与 `balance` / `dailyCheckin` 语义独立，不能互相推断**：
  Cline 是「有余额、有订阅额度、无签到」，Loomy 是「有余额、有签到、无订阅额度」。
  合并成一个标志会让某个面板冒出不该有的按钮。
- **额度逐账号隔离**：一个账号凭据坏掉只让**那一张卡片**显示原因，其余照常。
  多账号用户不该因为一个号没配凭据就完全看不到额度。
- **「查询失败」与「没有额度窗口」必须分开渲染**：前者是错误（显示原因），
  后者是事实。合并成一句会让用户以为额度没了。
- **失败不得显示成 0%**：0% 是「这个窗口没用过」的合法语义；
  查询失败一律 `ok:false` + 原因（与其余 provider「查不到不显示成 0」同约定）。
- **请求记录的失败是载荷（`ok:false`）而不是 RPC 级错误**：
  面板要**保留已加载的行**、只把原因显示在表格下方；回成 RPC 错误会让整块换成错误页，
  翻页途中失败就把用户已看到的记录清空了。
- **百分比**：数值**夹取到 0–100 后取整**（参考实现），文案与进度条宽度共用
  `quotaPercentValue` 这**一个**值 —— 两处各算一次是「进度条 100%、文案 120%」
  这类不一致的来源。⚠️ 这条在 2026-09-30 **推翻了旧实现**（旧版故意不夹取）。
- **窗口顺序**：已知窗口（`five_hour` / `weekly` / `monthly`）按 `QUOTA_WINDOWS`
  固定顺序在前，网关下发的**未知窗口追加在后** —— 纯按网关原序会让新窗口插到中间，
  同一账号两次读数的排列都可能不同。未知类型的标签回落到 `type` 原值（不丢弃）。
- 按钮放在**面板级**而不是账号卡片的按钮行：那一行已有 5 个按钮且
  `flex-wrap: nowrap`，再塞一个必然溢出（「领取新手任务」当时就是这么被挤出去的）。
  且额度是**跨账号**读数，放面板级与语义一致。

#### ✅ 验证状态（哪些已实证、哪些还没有）

**已实发核对（2026-09-29，本机真实 Cline 账号，只读 GET、未触发续期）**：
端点与响应形状与解析层**完全一致** ——

- `/users/me/plan/usage-limits` → `data.limits[]`，`type` ∈
  `five_hour` / `weekly` / `monthly`，带 `percentUsed` 与 `resetsAt`；
- `/users/{account_id}/usages` → `data.items[]` + `data.nextToken`，行含
  `createdAt` / `aiModelName` / `aiModelTypeName` / `totalTokens` /
  `creditsUsed` / `costUsd`。**用 `account_id`（`usr-…`）实测可用**。

两个实测形态已写进用例：

- `resetsAt` 是**纳秒**精度（9 位小数），如 `2026-09-29T15:41:02.244817775Z`
  —— 解析层**原样保留**（不截断、不归一化），`Date.parse` 可解析；
- 用量为 0 的窗口 `resetsAt` 是**空串** —— 客户端因此**不渲染**那一行
  （渲染一个空的「重置」会让人以为读取失败）。

⚠️ 探针**没有入库**（`tests/e2e/tmp-*.ts` 用完即删）。需要复核时：照
`tests/e2e/cline-credential.ts` 读凭据，再调 `fetchClineUsageLimits` /
`fetchClineRequestLog` 即可（**只读、不要续期**）。

⚠️ 顺带发现（**与本功能无关，刻意未改**）：`readClineCredentialsFromDshStore()`
对本机当前的 `.credentials.yaml` 读出 **0 个账号** —— `extractYamlScalar` 取出的
标量**尾部多 2 个杂字符**，`JSON.parse` 抛错后被该助手的 `catch` **静默跳过**。
探针是靠「只取第一个完整 JSON 值」绕过的。若哪天别的 Cline e2e 报
「0 个账号」，根因多半在这里，而不一定是凭据真的不存在。

**已做**：`pnpm typecheck`、`pnpm test`（新增 54 条：`cline-quota` 32、
能力表 3、RPC 端点 9、客户端接线 10）、`pnpm build:all`，并已安装到本机 profile
（`lib/` 330 个文件**全量哈希一致**）。全量测试
**1 failed | 3155 passed**，那 1 项是既有失败（`loomy-docs` 缺被 gitignore 的文档；
另有 `cline-icon` 缺不入库脚本，属套件级加载失败）。

**未做**：GUI 点击级实测（`/api/jet-hub` 需浏览器登录态，直接调用返回 401，
与既有记录一致）。

⚠️ **改了宿主侧（`src/`）必须重启 DSH 才生效**：客户端 bundle
（`lib/client/jet-hub.js`）会被 `dsh-client-hmr` 热加载（刷新页面即可，无需重启），
但 `cline.quota` / `cline.requestLog` 是**宿主侧**端点 —— 不重启只会看到
「按钮出来了、点了报 unknown method」。

### ⚠️ 修复记录：首版弹窗漏了 `.dim-jh-modalBody` + 数字列右对齐被压过
（2026-09-29 用户报障：「弹窗位置不正确。内容显示不正确」）

**根因一（位置）**：弹窗内容直接铺在 `.dim-jh-modal` 里，没包 `.dim-jh-modalBody`。

`.dim-jh-modal` 是 `max-height: min(640px, calc(100vh - 48px))` 的 flex **列**容器，
子项默认不可收缩（没有 `min-height: 0` / `overflow`），内容一多就
**画出弹窗边界之外** —— 额度卡 + 请求表叠加，视觉上就是「弹窗错位、内容错乱」。

**修法**：内容包进 `.dim-jh-modalBody`（`flex: 1 1 auto; min-height: 0;
overflow-y: auto`，见样式）。模型列表弹窗同款 —— 它的 error / loading /
empty / 列表四个分支**全部**在 modalBody 里，只有 modalHead / modalHint /
筛选条 / 批量工具条在外面。

**根因二（内容）**：`.dim-jh-quotaNumCol { text-align: right }` 的优先级
**(0,1,0)**，压不过 `.dim-jh-quotaTable th/td { text-align: left }` 的
**(0,1,1)** —— 右对齐**静默失效**：表头左对齐、数据右对齐，列错位。

**修法**：复合选择器
`.dim-jh-quotaTable td.dim-jh-quotaNumCol, .dim-jh-quotaTable th.dim-jh-quotaNumCol`。
这正是参考实现 README 里「429 错误行撑宽请求记录表格」的**同一个选择器强度
问题**（那边是 `(0,1,1)` 的 `td{white-space:nowrap}` 压过 `(0,1,0)` 的
`.cp-history-error`，解法同样是复合选择器）。

⚠️ 两条都已有**反向验证**（注入缺陷 → 对应断言变红，其余 8 条不受影响），
用例在 `tests/unit/cline-quota-panel.spec.ts` 的
「弹窗内容在 .dim-jh-modalBody 滚动区里」与「数字列右对齐用复合选择器」。

顺带吸收参考实现的既有经验：时间列**定宽 82px**（防时间戳被截断）、
模型名 `word-break: break-word`（长模型名不撑宽表格）。

## 常见开发任务

### 新增功能

1. 确定所属模块（auth 服务 / 命令 / provider）
2. 在 `src/` 对应文件中实现逻辑（客户端 UI 改 `plugin-src/client/`）
3. 添加单元测试覆盖
4. 执行 `pnpm build:all` 编译（host + client 两侧）
5. 执行 `pnpm test` 验证
6. 更新文档

### 调试

- 使用 `pnpm typecheck` 快速验证类型
- E2E 测试需要设置环境变量 `DSH_CODEARTS_E2E=1`（测试在打开的浏览器中需要人工点击授权）
- 构建错误检查 `lib/` 目录是否存在以及 `tsconfig.json` 的 include/exclude 配置
- ⚠️ **改完插件必须重建 `lib/` 并重启 DSH 才生效**：宿主侧代码在 DSH 启动时从
  `lib/index.js` 载入，不热重载（只有 `plugin-src/client/` 的客户端 bundle 有 HMR）。
  **排查「改了没效果」时先看这两个时间**：`lib/index.js` 的 mtime 与 DSH 进程的启动时间 ——
  进程早于产物就说明跑的是旧代码。

#### ⚠️ 「没有任何报错就中断」怎么查

这类现象**无法靠读代码推断**，必须回到会话记录。DSH 把每次请求的**原始 chunk 流**
也记进了 `assistant/message` 事件（`data.stream`），据此可还原真相：

```bash
node scripts/inspect-session.mjs list zed                      # 找会话（工作区关键字）
node scripts/inspect-session.mjs turns <会话文件>               # 每轮结束原因（先定位可疑轮次）
node scripts/inspect-session.mjs brief <会话文件> assistant/message 700
node scripts/inspect-session.mjs stream <会话文件> <seq>        # 该步的原始 chunk 流（关键证据）
```

会话日志位于 `~/.dsh/sessions/<工作区转义名>/<session-id>/session.v3.jsonl.zstd`
（**zstd 压缩的 JSONL**；工作区名把 `\` `/` `:` 换成 `-`，如
`D:\jet\code\rust\zed` → `--D-jet-code-rust-zed--`）。

判据（真实案例，2026-09-23，`qoder`/`qfmodel`）：同轮相邻两步对照 ——

| 步骤 | chunk 流 | finish |
|---|---|---|
| 正常步 | `block-start(text) → text → block-start(tool-call) → tool-call-chunks → block-end×2` | `tool-calls` |
| 中断步 | `block-start(text) → text →`（**无任何 tool-call**）`→ usage → block-end` | `stop` |

即：模型写完「让我检查 X：」后流就结束了。**`turn/end` 是 `completed`**，
UI 上完全看不到错误。

⚠️ 两个可能成因，**不要凭猜认定**：
1. **连接被掐断**（没有 `finish_reason`、也没有 `[DONE]`）→ 已由
   `consumeOpenAiSse` 的 `truncatedStream` 判定改为报 `max-tokens`（可重试）；
2. **模型确实输出了 `finish_reason: stop`** 却没产出工具调用（模型抖动）→
   本层无从强制，但此时**行为可与 (1) 区分**：修复后 (1) 会重试、(2) 仍是 `stop`。
   若重启后再现且仍不重试，说明是 (2)，需换思路（如减少单步工具数量）。

**其它已修的同族缺陷**（都表现为「无报错中断」，改 `openai-compat.ts` 时务必保留）：

- **网关形态错误帧被整帧丢弃**：帧形如
  `{"stackTrace":[...],"message":"...","statusCodeValue":400}` ——
  **既没有 `code` 也没有 `error`、也没有 `choices`**，早期解析器所有条件都不命中。
  现按 `statusCodeValue >= 400` 或带 `stackTrace` 判为错误并抛出。
- **响应根本不是 SSE**（网关直接回了 JSON，没有任何 `data:` 帧）：
  早期同样静默空结束。现抛错并**带上原文片段**，否则用户只能看到一个没有原因的失败。

回归用例：`tests/unit/qoder-silent-stop.spec.ts`。

#### ⚠️ 名称为空的 `tool_call` 会**跨 provider 传染**，让整条会话报废

**真实缺陷**（用户报障，2026-09-23）：在 zed 会话里给
`workbuddy/deepseek-v4.1-flash` 发一条**带图片**的任务，**每次都**报：

```json
{"code":11133,"msg":"the request parameters were rejected by the model provider",
 "extError":{"code":"model_param_invalid","param":"","StatusCode":400}}
```

⚠️ 该文案**不指出是哪个字段**，且与图片、工具、思考档位全都无关 —— 极易误判成
「这个模型不支持图片」。**逐项排除法**（`scripts/probe-workbuddy-image.mjs`
与 `scripts/confirm-empty-tool-name.ts` 已固化）：

| 被排除的假设 | 实测反证 |
|---|---|
| 图片 wire 形态（`{type:'image'}` / 裸 base64 / `image_url`） | 正确形态一律 200；错误形态报 **11101**（parse failed），不是 11133 |
| 33 个工具的 schema（逐个单测 + 全量） | 全部 200 |
| `thinking` / `reasoning_effort` / `max_tokens` | 单独去掉后**仍** 400 |
| input + `max_tokens` 超上下文 | `max_tokens` 降到 **64** 仍 400；短历史 + `max_tokens: 900000` 反而 200 |
| 重复 `tool_call_id`、中段 system 消息 | 变换后仍 400 |

**真凶**：会话历史里有一条 **`name:''` 的 `tool_call`**：

```json
{"type":"tool-call","id":"call_25e97a78849f449da444fc72","name":"","arguments":"{}"}
```

**实测最小复现**（wire 上的 `function.name` → 上游结果）：

| `function.name` | 结果 |
|---|---|
| `"read"` | 200 |
| `"unknown_tool"`（**不存在的**工具名） | 200 ← 上游**只校验非空，不校验存在性** |
| `""` / `null` / 缺失 | **400 code 11133** |

**来源是 qoder**（所以叫「跨 provider 传染」）：其 SSE 偶发一个**完全没有 `name`
字段**的 tool-call 分片（实测 seq=693：`{index:2, id:'call_25e9…', args:[""]}`），
早期 `openai-compat.ts` 在 `block-end` 处 `name: block.name ?? ''` 把它落成空串块 →
harness 执行得到 `unknown tool ""` → 该坏块被**持久化进会话** → 用户切到 workbuddy
后每次请求原样重放 → 400。

**两处修复，缺一不可**：

1. **消费侧（源头，`src/openai-compat.ts`）**：名字可用**之前不发射任何 chunk**
   （连 `block-start` 都不发）。
   ⚠️ **只跳过收尾的 `block-end` 是不够的** —— 上游 `BlockAssembler.assemble()`
   对没有 `block-end` 的 partial 同样会组装出 `name: partial.toolCallName ?? ''`。
   必须让该块**一个 chunk 都不产出**。名字稍后到达时，把**已累积的参数一次性补发**，
   故正常形态（首片即带 name）行为不变。
   同一修法已施加到 `buddy-adapter.ts` / `llm-adapter.ts`（含两条 DSML 分支）/
   `lobsterai-adapter.ts` / `trae-adapter.ts`。
2. **序列化侧（存量会话自愈，`src/sse.ts` 的 `resolveToolPairing`）**：
   发请求前剔除**名称不可用**的 tool_call 及其结果，让**已经坏掉的会话**无需重开即可恢复。
   - 判据用 `hasUsableToolName()`，**不能写成 `String(name).length > 0`** ——
     `undefined` / `null` 经 `String()` 会变成 `"undefined"` / `"null"` 这类**非空**
     字符串，「缺名字」会被误判成「有名字」。
   - **不得连累同批的合法调用**：实测线上形态正是「一个无名 + 一个合法 `pwsh`」，
     整批丢弃会白白损失一次有效调用。结果按 id 匹配，剔一个不破坏另一个的配对。
3. 丢弃了无名调用且**没有**留下任何可用调用时，`finish` 报 `max-tokens`（可重试）
   而非 `stop` —— 否则又是一次「模型本意调工具、harness 却认为正常答完」的无报错中断。

回归用例：`tests/unit/sse.spec.ts`（`resolveToolPairing` / `hasUsableToolName`）、
`tests/unit/qoder-silent-stop.spec.ts`（消费侧不产出空名字块）。
验收脚本：`scripts/verify-workbuddy-image-fix-e2e.ts`（**用线上那条报废会话的真实历史**
重放，判据是修复后 HTTP 200）。

#### ⚠️ 思考死循环会烧满输出额度（Reasoning Loop Guard）

**真实缺陷**（用户报障，2026-09-23）：`workbuddy/deepseek-v4.1-flash` 报
「已达到输出 token 上限，回答被截断」。

⚠️ **先排除一个错误假设**：用户最初怀疑「切换模型后沿用了旧模型的参数」。
**实测否定** —— DSH 的 `prepareCall` → `resolveCallWithInfo` 按**当前**模型解析
`maxTokens`（`dsh-llm/lib/index.js:2111`）；且同一会话 turn 1 **未做任何切换**
就爆额度，切到 lobsterai 后连续两轮正常 `completed`。问题跟着**模型**走。

**真因**：模型思考陷入病态重复：

```
Let me write. / Writing. / Go. / OK. / Producing. / Let me output. / Final.
```

`reasoning_tokens` **计入** `completion_tokens`，故思考停不下来 = 正文零产出。
实测三步全部 `reasoningTokens == outputTokens == 128000`、**无 text 块、无工具调用**。

**判据**（`createReasoningLoopDetector`，`src/sse.ts`）：尾部 3000 字符窗口内
「非空行 ≥40 且去重行比例 <0.35」判为局部循环，且**循环状态须持续 ≥2000 字符**。

⚠️ **「持续体量」这一层不可省**：实测 seq=401 在 14848/15795（94%）处被判局部
循环，但它随即**自愈并产出了工具调用** —— 其持续体量仅 1024，被 2000 正确排除；
三个真死循环的持续体量是 435,968 ~ 509,184。正常样本窗口去重率最低 0.149、
死循环 0.017~0.031（**5 倍余量**），实测**零误报**。

判据选型（正常 109 条 / 死循环 6 条真实样本）：

| 判据 | 正常误报 | 死循环命中 |
|---|---|---|
| n-gram 重复占比 | 0/109 | 2/3 |
| **窗口去重行比例 + 持续体量** | **0/109** | **3/3** |
| 尾部行周期 | 0/109 | 1/3 |

**中断动作**：丢弃后续思考增量 → **`reader.cancel()` 中止上游**（真正止损，见下）
→ 收尾发**截断后的 reasoning block**（保留 `cutAt` 前的干净前缀）
→ `finish` 报 **`error` + `REASONING_LOOP`**（**有分辨力**，见下节；2026-09-29 改判）。

⚠️ **「止损」这一步不可省**（终审 C1，已实测）：只跳过**下行**累积/发射、却把流读到底，
则上游继续生成、**128000 token 照烧**（实测上游 200 帧被读 **200 帧**；守卫在 ~2304
字符即命中，即 99.5% 额度仍被消耗）。

四个必须保留的实现要点：

1. **`block-end` 是权威覆盖**（实测 `scripts/verify-blockend-override.ts`）：
   即便前面已 yield 全部重复 delta，收尾发截断后的 block 即可，**无需撤回**。
2. **命中后 `reader.cancel()` + `break` 出 SSE 读取循环**（止损）。
   ⚠️ **`break` 必须放在内层行循环之后、外层读取循环的末尾** —— 这样同一 chunk 里
   已到达的 `usage` / `[DONE]` 仍会被处理。放进内层 `while` 会整块跳过本 chunk
   剩余行（**实测踩过**：五处首次插入全部误落内层，typecheck 与多数用例都不报错，
   只有「同帧 usage」用例抓到）。
   ⚠️ **绝不能 abort `options.signal`** —— 那是**调用方**信号，abort 会被上层报成
   「用户取消」（`aborted`）而非我们想要的 `error`。只 cancel reader。
   ⚠️ `reader.cancel()` 必须 `.catch(() => {})`：连接已断时会抛错，不吞掉会把
   「正常止损」变成一次失败。
   ⚠️ **不得用 `continue`**（Task 2 审查发现、已实测复现）：`continue` 跳过本帧
   **剩余全部**处理，而 `usage` 与 `tool_calls` 都在 reasoning 分支**之后** ——
   「reasoning + usage 同帧」时 usage 被静默丢弃（实测：混合帧收到 **0 个** usage
   chunk，对照组 **1 个**）。正确写法是 `if (!loopDetected) { … }` 只包住累积与发射。
3. **`loopDetected` 的 finish 优先级高于 `tool_calls`** —— 循环中生成的工具
   调用参数不可信；且若无任何可用调用，落到 `stop` 会让任务**静默中断**
   （与「无报错中断」同族）。
4. **思考判据只喂 `reasoning`** —— 正文里的重复（代码块、列表）在思考通道是正常输出。
   ⚠️ 但**正文有自己的独立守卫**，见下节（2026-09-25 补充）。

开关 `DSH_REASONING_LOOP_GUARD` —— **默认开启**，仅显式假值关闭（与
`DSH_HIDE_MODELS_WITHOUT_ACCOUNT` 同为「默认开」语义，用独立的
`resolveReasoningLoopGuardFlag`，不要与 `isTruthyFlag` 混用）。

六个适配器全部接入（含 codearts 的 `reasoning` 与 `<thought>` **两条**出口）。
回归用例：`tests/unit/reasoning-loop.spec.ts`（判据）、
`tests/unit/reasoning-loop-adapter.spec.ts`（各适配器中断行为）；
fixture 为**真实会话文本**（`tests/fixtures/reasoning-*.txt`）。

#### ⚠️⚠️ 死循环中断**不得复用 `max-tokens`**：必须给有分辨力的错误（Gitee !IKIZNK）

**真实缺陷**（用户报障，2026-09-29）：

> 会话异常问题：**已达到输出 token 上限**回答被截断，已有输出保留在对话中。
> 发送"继续"可让模型接着输出。

用户的原话点明了性质：

> 如果只是陷入思考循环的出错，就要给出**有分辨力**的错误提示，
> 现在用「达到输出 token 上限」是**不对**的。

**根因：DSH 客户端对 `max-tokens` 只有一句固定 i18n 文案，且不读适配器的 message。**
`dsh-client-ui-chat/lib/client.js` 的 `message.maxTokens` / `.hint`：

```
已达到输出 token 上限 / 回答被截断，已有输出保留在对话中。发送"继续"可让模型接着输出。
```

⇒ 于是「**检测到死循环并主动止损**」被显示成「**token 用满了**」，
而那句「发送继续可让模型接着输出」对死循环**恰好是错的建议**。

**全库取证**（219 会话；脚本 `scripts/probe-max-tokens-provenance.mjs`）——
`finish=max-tokens` 的 35 步里：

| 归因 | 步数 | 占比 |
|---|---|---|
| **循环守卫截断**（**不是** token 上限）| **25** | **71%** |
| 真·烧满额度（`output=32000/64000/128000`）| 5 | 14% |
| 上游 `length` / 其他折叠 | 5 | 14% |

⚠️ **判据（决定性，不依赖 usage）**：守卫命中时 `block-end` 只发**截断后的前缀**，
而已流出的 delta 无法撤回 ⇒ **「流出思考总量 − 落块思考量」＝ 被截掉的量**。
这 25 例的截掉量**恒为 1994~1999 字符**（= `minLoopChars` 默认 2000），
被截段行去重率 **0.0114~0.0831**（阈值 `<0.35`），内容形如
`OK. / Hmm. / Hmm. / …`（233× `Hmm.`）、`好。/ 执行。/（写。）/（结束。）`。

⚠️ **这 25 例全部是真循环、零误报** —— 问题**不在判据，在上报方式**
（脚本 `scripts/probe-loop-truncation-content.mjs` 逐例打印被截原文可复核）。

**更严重的副作用：文案里的建议对死循环无效**（脚本
`scripts/probe-continue-after-loop.mjs`）：25/25 例守卫命中之后，用户**都**被迫手动介入：

```
11×  "继续"
 9×  "继续上面未完成的任务"
 1×  "你陷入思考循环了，醒醒。继续上面未完成的任务"   ← 用户自己诊断出来了
 1×  "你的思考陷入死循环了，继续调查上面的问题"       ← 同上
```

且有会话**反复命中同一守卫**（`session-fa` 4 次、`session-8c` 4 次、`session-27` 3 次）。

##### 修法：改报 `error` + `REASONING_LOOP`，**并带「无可见产出」门禁**

为什么 `error` 能把文案送到用户眼前（两条都是实测/源码依据）：

1. UI 的 `failureMessage()` 只对 `AUTH` / `QUOTA` / `ACCOUNT_QUOTA` /
   `ACCOUNT_SIGNED_OUT` / `ACCOUNT_SIGN_IN_REQUIRED` 做**文案替换**，
   **其余码一律原样显示我们的 message**（`dsh-client-ui-chat/lib/client.js`
   的 `failureMessage`）。这正是用户说的「出错5次重试那里会显示失败原因」那条通道。
2. UI 读的是 `reason.error`（`client.js` 的 `failureFrom`），而
   `dsh-llm` 的 `LlmFailure` 形状是 `{message, code, …}` ⇒ **适配器给什么就显示什么**。

⚠️ **但 `error` 路径会丢内容，故必须加门禁**（`dsh-agent-loop/lib/index.js`）：

```js
if (finish.kind === "error" || finish.kind === "aborted") {
  live.settle("assistant/attempt", …)   // ← 只落 attempt（UI 不可见）
  if (action?.kind !== "retry") throw new LlmError(finish.failure.message, …)
}
live.settle("assistant/message", …)     // ← error 走不到这里
```

即 **error 不落 `assistant/message`**，该步已产出内容不进会话历史。
实测（`scripts/probe-error-finish-content-loss.mjs`）：**351 次 `finish=error` 里
222 次该步没有 `assistant/message`** ⇒ 内容确实会丢。

⇒ 故判据必须是「**只是**思考循环」（用户原话里的「只是」正是这层门禁）：

| 命中时的产出 | 报什么 | 理由 |
|---|---|---|
| **只有思考**（实测 25/25 例都是）| `error` + `REASONING_LOOP` | 可见内容为零，报 error 不丢东西，文案有分辨力 |
| 还有正文或工具调用 | `max-tokens`（保持原行为）| 报 error 会把可见内容整块丢掉，更糟 |

实现：各适配器算 `reasoningLoopIsSoleOutput = loopDetected && emittedProse === '' && toolOrder.length === 0`。
⚠️ **codearts（`llm-adapter.ts`）还有一层额外陷阱**：它有「正文为空且无工具调用时
用**推理文本回填正文**」的 `visible` 回退 —— 回退一生效 `visible !== ''`，
判据**恒为假**、永远落回误导性的 `max-tokens`（**静默失效**）。
故该回退必须加 `!loopDetected` 门禁（顺带也修掉了「把循环垃圾回填进正文并持久化」）。

##### 文案三要素（用户明确要求）

用户原话：

> 提示中要加上**当前窗口还有多少可用**，没有真的占满可以尝试继续任务

故 `reasoningLoopFailure()`（`src/sse.ts`）产出：

1. **真实原因**：`模型思考陷入病态重复，已中止本轮（**不是**输出 token 上限）。`
2. **判据数值**：尾部 N 行里只有 M 行不重复（去重率 x.xxx，阈值 <0.35）、连续循环体量。
3. **额度实况 + 建议**：`本次思考仅产出约 N 字符（约 K token），额度 L token 中**还剩约 R**（估算值）——额度没有占满，可以直接继续任务。`
   并附「若继续后再次陷入同一循环，建议降低思考档位或更换模型」。

⚠️ **额度是估算，必须如实标注**：`observedChars` 是**字符数**不是 token 数；
守卫命中时 `reader.cancel()` 已中止上游，`usage` 帧**往往根本没到达**
（实测 25 例中 **0 例**带 usage）。故用「约 1 token ≈ 3.5 字符」估算并写明「估算值」。
系数 3.5 取中文（约 1:1.5~1:2）与英文短句（`OK.`/`Hmm.`，约 1:4~1:5）之间的**保守中值**
—— 宁可低估剩余额度，也不要让用户以为还有很多而反复撞墙。
⚠️ **拿不到 `maxTokens` 时不得编造数字**（与 `maxOutputTokens` 那条口径一致）：
文案退化成「额度没有占满，可以直接继续任务」而不给具体数值。
故 `ConsumeOpenAiSseOptions` 新增可选的 `maxTokens`，由四个调用方（cline / loomy /
raccoon / qoder）透传 `options.maxTokens`。

##### `REASONING_LOOP` **刻意不在**可重试集合里

死循环是**确定性**病理（同上下文会稳定复现），若可重试则白退避 5 次
（500/1000/2000/4000/8000 ≈ 15.5 秒）并**再烧一轮额度**，而每轮可能烧掉几十万 token。
与 `QUOTA_EXCEEDED` / `PERMISSION_DENIED` 的既有口径一致。
验证脚本 `scripts/probe-reasoning-loop-retry-codes.mjs`（只读 `dsh-llm` 产物，
断言 `REASONING_LOOP`/`QUOTA_EXCEEDED`/`PERMISSION_DENIED` **不在**集合里，
而 `SERVER`/`EMPTY_RESPONSE` **在** —— 后者是对照组，防止「不在」只是解析失败）。

##### 回归与验证

- 回归用例 `tests/unit/reasoning-loop-adapter.spec.ts`（30 条）：其中 4 条新增 ——
  「文案有分辨力（含否定 token 上限、判据数值、剩余额度）」「拿不到 maxTokens 时不编造数字」
  「另有工具调用时仍报 max-tokens（不丢内容）」「另有正文时仍报 max-tokens（不丢内容）」。
- ⚠️ **已做反向验证**（三处变异，各自变红，证明非同义反复）：
  ① `reasoningLoopIsSoleOutput → false`（退回 max-tokens）→ **6 条**变红；
  ② 去掉「只是思考循环」门禁（恒为 true）→ **2 条**变红（正是内容保全那两条）；
  ③ 去掉 codearts `visible` 回退的 `!loopDetected` 门禁 → **5 条**变红。
- 端到端回放 `scripts/verify-reasoning-loop-error.mjs`：用**真实会话的 wire 分片**
  （seq=1963，流出思考 57073 / 落块 55084 / 正文块 0 / 工具调用 0）重放，确认产出
  `error` + `REASONING_LOOP`，文案含「不是 token 上限」「还剩约 111693」。
- 取证脚本（均只读、离线、零额度）：`probe-max-tokens-provenance.mjs`（归因）、
  `probe-loop-truncation-content.mjs`（被截原文）、`probe-continue-after-loop.mjs`
  （用户后续消息）、`probe-guard-hit-block-mix.mjs`（命中时的落块构成）、
  `probe-error-finish-content-loss.mjs`（error 路径丢内容）。

⚠️ **排查这类问题的两个通用教训**（本缺陷踩过）：

1. **会话日志里的 `data.stream` 是「合并形态」，不是原始 chunk 数组**：
   形如 `{type:'reasoning-chunks', texts:[…]}` / `{type:'chunk', chunk:{…}}` 混排。
   按 `item.chunk.type` 统计会**静默得到 0**（合并项没有 `.chunk`）——
   我第一版探针据此得出「reasoning 帧 = 0」的**假象**。
   文本量必须从 `texts[]` / `args[]` 累加（见 `probe-stream-shape.mjs`）。
2. **按 `turn` 聚合会掩盖失败步**：一轮有几十步，前面正常步的 `assistant/message`
   会让「本轮有内容」恒为真 ⇒ 得到「error 不丢内容」的**假阴性**。
   必须按 **(turn, step)** 聚合，或直接看 `assistant/attempt` 里那个 `finish` chunk
   （attempt **只在失败路径落盘**，本身就是「这步曾失败」的指纹）。


#### ⚠️ 思考标签泄漏与「引用 `</think>` 导致对话中断」

**真实缺陷**（用户报障，2026-09-27，**在本会话实时复现**）：

> 思考带着 `</think>` 原样输出到正文了，然后正文碰到 think 标签直接没输出就中断了

**根因：上游把 `</think>` 当停止串（stop string）。** 两个症状同一根因，但**性质不同**：

| # | 形态 | 机制 | 处理 |
|---|---|---|---|
| ① | 标签**单独**成块（`\n</think>\n\n`） | 服务端把停止串**含在**输出里 | **解析**切走标签（`splitThinkTaggedContent`）；另有过虑兜底（**默认关**）|
| ② | 标签**跟在正文后** | 服务端在停止串处**掐断**，但仍报 `finish_reason:"stop"` | 改判 `max-tokens`（`isProseTruncatedByStopString`）|

##### ⚠️⚠️ 首要原则：**先把解析做对，过滤只是兜底**

用户明确纠正过设计优先级（2026-09-27）：

> 我们应该正确处理这种**配对格式**的标签优先保证它正确解析，而不只是解析失败
> 再从泄露的文本中过滤，**过滤只是兜底手段，更要强化做对**

**分工（必须分清，别混）**：

| 层 | 函数 | 开关 | 职责 |
|---|---|---|---|
| **解析** | `splitThinkTaggedContent` | **恒开**（不可关）| 认全形态，把标签**切**出去 |
| **截断识别** | `isProseTruncatedByStopString` | 恒开 | 识别「上游掐断」→ 改判 `max-tokens` |
| **过滤（兜底）** | `stripBareThinkCloseTag` | **默认关**（`DSH_THINK_LEAK_STRIP=1`）| 删切分没处理的**纯标签块** |

⚠️ **过滤默认关闭是用户决定**（2026-09-27）：

> 我们现在暂时不需要泄露过滤，代码可以保留，文档和注释记明白，后续再实际
> 使用中看是否还有泄露问题，**加了过滤可能有思考解析失败但是被过滤我们发现不了**

即：**兜底会掩盖解析层的失败**。当前阶段要让泄漏**如实呈现**（观测解析成功率），
故默认不剥；确需应急再打开。代码保留，接线在（`stripBareThinkCloseTagIfEnabled`）。

⚠️ **该开关语义与另两个开关相反**：`DSH_COURSE_LEAK_STRIP` /
`DSH_REASONING_LOOP_GUARD` 是「默认开、显式假值才关」；
`DSH_THINK_LEAK_STRIP` 是「**默认关、显式真值才开**」（`1`/`true`/`yes`/`on`）。
故用独立的 `resolveThinkLeakStripFlag`，**绝不能与 `resolveCourseLeakStripFlag` 混用**
（混了会让它默认开，正好与意图相反）。

##### 解析器必须认全形态（旧判据漏 91%）

旧判据只认 `</think:hex>`。普查 41 会话（`scripts/probe-think-forms.mjs`）：

| 形态 | 块数 | 旧判据 | 现判据 |
|---|---|---|---|
| `close-only-bare`（裸闭标签）| **38** | ❌ | ✅ |
| `close-only-hex` | 4 | ✅ | ✅ |
| `mixed-hex-and-bare` | 2 | ❌ | ✅ |
| **`paired`（开+闭）** | 2 | ❌ | ✅ |

⇒ 旧判据漏 **42/46（91%）**。这正是「只靠事后过滤」的代价：这 42 处全都会
把标签泄漏给用户。

⚠️ **配对形态无需单独分支**：定界用**最后一个闭标签**，开标签由
`THINK_ANY_TAG_RE` 作为「思考段内标签」剔除 ⇒
`<think>思考</think>正文` → 思考=`思考`、正文=`正文`。
故正则放宽为 `/<\/think(?::[0-9a-f]+)?>/g`（hex 后缀可选）。

⚠️ **引用语境必须排除**（`isQuotedThinkTag`，四条件）：全库 46 处标签里
**39 处处于引用语境**（反引号紧邻 / 反引号 span 内 / 单双引号内 / 代码围栏内），
只有 7 处裸露。若不排除，模型**讨论**标签的正文会被拦腰切断
（`'</think>无 hex</think>'` 这类）。判据 4（同行引号奇数）**故意偏保守**：
误判只导致「该切分未切分」（标签留在正文，由兜底处理），
而不是「把正文当思考移走」（不可逆的内容错位）。

##### ⚠️⚠️ 绝不能用「逐帧探测」当解析门禁（跨帧必然漏判）

**这是本次审计发现的真实缺陷**，我一度写过、后删除：

```ts
// ❌ 错误写法：逐帧探测，命中才在收尾切分
if (!proseHasThinkTag && textDelta.includes('</think>')) proseHasThinkTag = true
// ... 收尾
if (proseHasThinkTag) { splitThinkTaggedContent(textBlock.text) }
```

**标签必然跨帧**（上游按 token 切分），该判据要求**完整** 8 字符标签。
枚举全部分帧方式（`scripts/probe-think-flag-split.mjs`）：

| 文本 | 分 2 帧时漏判 |
|---|---|
| `思考</think>正文` | **7/11** |
| `<think>思考</think>正文` | 7/18 |
| `思考</think:6124c78e>正文` | 5/20 |

漏判 ⇒ 收尾不切分 ⇒ 标签原样落盘。这与该变量自己的注释
（「标签可能跨帧到达，必须缓冲到收尾」）**自相矛盾** —— 门禁本身就是那个
不该存在的逐帧判定。

✅ **正确写法：收尾无条件解析**（现实现）：

```ts
let textOut = textBlock.text
{
  const split = splitThinkTaggedContent(textBlock.text)  // 无标签返回 undefined
  if (split !== undefined) { /* 思考段并入 reasoning 块，textOut = split.text */ }
}
textOut = stripBareThinkCloseTagIfEnabled(textOut)       // 兜底，默认关
```

⚠️ **为什么不是「先组装再发给 DSH」**：DSH 协议**已经**提供该能力 ——
`block-end` 的 `block.text` 是**权威覆盖**（`BlockAssembler`：`if (partial.block) return partial.block`；
客户端 `case "block-end": blocks[i] = toAssistantBlock(chunk.block)`）。
故**流式照发 delta**（保住首 token 延迟），**收尾用完整文本解析一次**，
再靠 `block-end` 覆盖 UI。无需（也不应）在流式层攒文本。
普通响应无标签时返回 `undefined` ⇒ **逐字节不变**（实测单次 1.5µs）。

⚠️ **② 的判据是「反引号奇数 **且** 以反引号收尾」**，两条缺一不可：

- 只有「奇数」不够 —— 未闭合的开引号可能在中间，无法证明是**末尾**被切断；
- 只用「以反引号结尾」不够 —— 正常的 `` 运行 `pnpm test` `` 也以反引号结尾。
  实测该粗判据命中 **9** 处（6 处假阳性），本判据命中 **3** 处**全部**为真截断。

**三条实测证据**（`qoder/qfmodel`，正文尾部 + `outputTokens`）：

| 行 | 正文尾部 | outTok | 正要写 |
|---|---|---|---|
| 5378 | ``…清洗器只认 ` `` | 369 | `` `</think:hex>` `` |
| 5412 | ``…多吐了一个孤立的裸 ` `` | 643 | `` `</think>` `` |
| 5600 | `` 找到了，`trae-adapter.ts` 还没补 ` `` | **37** | `` `</think>` `` |

⚠️ **改判还必须要求「本步无可用工具调用」**：有工具调用说明模型是「写完就去调
工具」，正文以反引号收尾只是碰巧（判据 B 的 3 个命中全是无工具调用的收尾步）。
⚠️ 报 `max-tokens` 而非 `tool-calls`：本步没有工具调用，报后者会让 harness 空执行。

⚠️ **停止串是服务端模板内置的，只能防御、不能协商**。注意区分两个层面：
- **我们从不主动下发它**：`options.stop` 只有**调用方（DSH）**可能传；本仓库
  6 个适配器（`buddy` / `lobsterai` / `cline` / `loomy` / `raccoon` / `trae`）
  只是**有则透传**（`if (options.stop !== undefined && options.stop.length > 0)`），
  **没有一处主动构造** `</think>`；
- ⚠️ `openai-compat.ts`（qoder / qodercn 路径）**根本不消费 `options.stop`** ——
  即便如此仍会观察到停止串截断 ⇒ **它来自服务端会话模板，与我们的请求体无关**。

⚠️ **不要在流式层逐帧剥离标签**：标签会**跨帧**到达（`` `<` `` / `` `/thi` `` / `` `nk>` ``），
逐帧匹配不到完整标签；正确位置是**收尾**的 `block-end`（它是**权威覆盖**）。

**接入范围（两处修复各自覆盖哪些 provider，别记混）**：

| 修复落点 | 文件 | 覆盖的 provider |
|---|---|---|
| 共享协议层 | `openai-compat.ts` | **qoder / qodercn**（同类）+ **cline / loomy / raccoon**（各自 import 它） |
| 独立实现 | `buddy-adapter.ts` | buddy / workbuddy（同产品配置） |
| 独立实现 | `lobsterai-adapter.ts` | lobsterai |
| 独立实现 | `trae-adapter.ts` | trae |

⚠️ `src/llm-adapter.ts`（CodeArts）**不使用这两处判据**（它走 DSML / `<thought>`
提取器，标签语义不同）—— 不要误以为「六份适配器都接了」。
回归用例：`tests/unit/strip-bare-think.spec.ts`（8 条，剥离判据）、
`tests/unit/think-stop-string.spec.ts`（12 条，截断判据 + 四类误报边界）。

⚠️ **排查本缺陷时警惕「自己造成的假阳性」**：本会话排查期间我**一直在讨论这个
标签**，正文里合法地写过 `` `</think>` ``、`'</think>'`、裸 `</think>`（为说明形态）。
按「裸露 = 泄漏」的粗判据会数出 42 处，其中 **70 处是语法引用、4 处是排查自我指涉**，
真正的模型泄漏只有 **1 处**（`lilishop-go` 行 21908 的纯标签块）。
**判据必须排除反引号/单双引号/围栏三种引用语境**，否则会把自己的分析当成模型缺陷。

⚠️ **上游在两个通道各发一遍同一段文字**（本会话实测行 5298：`reasoning-chunks`
与 `text-chunks` 相隔 348ms、逐字相同、`outputTokens` 两者都计入）。
**这是上游行为，不是我们的重复发射**（帧是独立的两条，非同一帧二次发射），
**不需要处理**。

#### ⚠️ 正文（text 通道）死循环：必须**独立实例**且**绝不 `cancel()`**

**真实缺陷**（用户报障，2026-09-25）：唯一活动 session（`lilishop-go` /
`workbuddy/hy4-preview-f`）出现**正文**循环，用户问「是只能处理思考不能处理
正文吗？还是这个循环还不够长？」

**答案：两者都不是 —— 是通道没接。** 旧实现六个落点**全部只喂 reasoning
增量**，正文分支从不调 `observe`。用**真实检测器**回放该会话正文，三段
**全部命中**（远超阈值，不是「不够长」）：

| seq | 正文长度 | 非空行 | 去重行 | 去重率 | 检测器 |
|---|---|---|---|---|---|
| 34752 | 4,641 | 486 | 20 | 0.0412 | HIT，cutAt=752 |
| 34768 | 8,875 | 416 | 39 | 0.0938 | HIT，cutAt=880 |
| 34823 | 34,406 | 2,711 | 473 | 0.1745 | HIT，cutAt=3256 |
| 35069 | 138,852 | — | — | — | HIT，撞满 `maxTokens: 64000` |

判据（去重率 < 0.35 且持续 ≥ 2000 字符）与思考侧**完全相同**，直接复用
`createReasoningLoopDetector`。

⚠️ **必须与思考守卫分成两个实例**：判据看**尾部 3000 字符窗口**的行去重率，
两条通道混进同一窗口会互相稀释，使守卫**双双失效**；共用一个 `cutAt` 也会
让一条通道的截断点错切另一条。

⚠️ **与思考守卫的语义差异（最关键，别照抄）**：思考死循环时模型**不产出工具
调用**，故命中即可 `reader.cancel()` 止损。但正文循环**不一样** —— 实测三段的
wire 帧顺序恒为

```
block-start(text) → text-chunks(循环正文) → block-start(tool-call)
  → tool-call-chunks → usage → block-end(tool-call) → block-end(text) → finish: tool-calls
```

**工具调用在循环正文之后才到达**，且调用有效、任务能继续。故正文守卫：
**只截断文本，绝不 `reader.cancel()`、绝不改 `finish` reason**。若照搬
`cancel()`，会把这些有效调用**整块丢掉**，把「能继续的任务」变成「什么都不做
就结束」—— 比循环本身更糟。

⚠️ **误报余量比思考侧更宽**（全语料 155 会话 / **32,725 步**实测）：

| 量 | 正常正文 | 命中样本 | 余量 |
|---|---|---|---|
| 窗口最低去重率 | **0.7667** | 最高 0.0387 | **19.8 倍** |
| 最长连续 looping 体量 | **0** | 3,937 ~ 8,064 | — |

正文命中 **4 次，全部是真循环**；其余 32,721 步零误报。
排查脚本 `scripts/measure-prose-loop-margin.mjs`、
`scripts/analyze-prose-loop-false-positive.mjs`；
回归用例 `tests/unit/prose-loop-guard.spec.ts`。

#### ⚠️ `</think:hex>` 闭标签：思考被上游塞进 `content` 通道

**同一缺陷的另一半。** `hy4-preview-f` 把**思考**写进 `content`（正文），只在
思考段末尾留一个 `</think:6124c78e>` **闭标签**。实测该会话 93 步里只有 **9 步**
的 reasoning 通道非空 —— 思考 9,563 字符 vs 正文 64,043 字符。

全语料普查（155 会话）：含标签 **28 步**，**开标签 0 个**、闭标签 28 个，
hex 恒为 `6124c78e`（会话级）；只出现在 `workbuddy/hy4-preview-f`（25）
与 `workbuddy/deepseek-v4.1-flash`（3）。

**判据**（`splitThinkTaggedContent`，`src/sse.ts`）：
- 以**最后一个**闭标签为界，标签**前** → reasoning 块、标签**后** → text 块；
- ⚠️ **只认闭标签，不猜开标签**：开标签恒缺失，仅见开标签时无法确定「思考到哪
  结束」，**不切分**（保持原样比猜错安全）；
- ⚠️ **无标签返回 `undefined`**，保证 99.6% 的普通响应**逐字节不变**；
- ⚠️ **必须在收尾做，不能逐帧**：标签会跨帧到达（`</think:61` + `24c78e>`）；
- ⚠️ **归位时必须同时喂 `suppressor`**：收尾以 `suppressor.text()` 为 reasoning
  块的**权威**，只改 `blocks` 条目不生效（测试直接暴露过这个坑）；
- ⚠️ **归位后正文可能为空串**（实测 seq=34768 形态）—— 空块会污染会话且违反
  DSH 的 `EMPTY_RESPONSE` 契约，故**不发空 text 块**（思考段已归位，仍有产出）。

⚠️ **引用判据不可省（否则误伤正常正文）**：标签可能只是被模型**讨论/复述**。
实测 28 处里 **3 处是反引号包裹的行内引用**（含排查本缺陷时复述该标签字面量的
正文）。判据「标签是否被反引号/围栏代码块包裹」分离度 **3/3 与 25/25，零交叉**。

回归用例 `tests/unit/think-tag-split.spec.ts`；真实会话端到端回放
`scripts/verify-prose-loop-replay.ts`（用会话里保存的**真实 wire 分片**重建 SSE，
喂真实 `BuddyAdapter`，断言**工具零丢失**）。

#### ⚠️ 行首 `course` / `课` 泄漏 token 会污染提示词

**真实缺陷**（用户报障，2026-09-23）：`deepseek-v4.1-flash` 的输出与思考中
「经常一行开头带一个中文『课』或英文『course』」。

实测形态（全库核实 295 会话 / 307 万行）：

| 事实 | 数据 |
|---|---|
| `course` 片段长度 | **1381/1381 全部恰好 6 字符**，全文即 `"course"` |
| `课` 片段长度 | **3362/3366 恰好 1 字符**，全文即 `"课"` |
| 位置分布 | 行首 **2347**、行中仅 28（后者全是排查期间的会话文字） |
| 前接上下文 | 只有 `\n\n`(2395) / 块首(261) / `\n`(69) 三种，**无例外** |

100% 规整 → **不是**模型生成的自然语言，而是某个「段落起始」类**特殊 token
被解码成了字面量**（中文侧 `课`、英文侧 `course`，同源）。

⚠️ **`课查` / `课修` 是「泄漏 + 模型循环」两个问题叠加**（用户补充，已证实）：
泄漏 token 后面直接跟模型正文/循环短句（`课查。` 895 次、`课跑。` 308、
`课修。` 307…）。这也解释了为何量极大 —— 模型一旦进入循环，每轮迭代都带一个泄漏前缀。

**判据**（`stripCourseLeak`，`src/sse.ts`）：

```
行首（块首 或 前一字符是 \n，允许前置空白）的 `course`
  且后接 ∈ {空格, \t, \n, \r, 块尾}   → 删
行首（同上）的 `课`                     → 删
```

⚠️ **判据刻意不用白名单** —— 实测反证：泄漏就是**单个 `课` 字**，后面接任意正文，
故「`课` + 某字」永远可能是「泄漏 + 正文」的偶然组合：

| 曾以为要保护的词 | 数据真相 |
|---|---|
| `课改`(12) | 行首 **10 次全是泄漏**（`课改测试。`、`课改 handler.go。`） |
| `课时`(3) | 行首 3 次全是泄漏（`课时间轴逻辑…`） |
| `课程`(23) | **全在中部**，且全是排查期间的会话文字，非模型输出 |

`course` 后接**不接字母**是为保守（避免误删 `courseware`）；实测行首
`course` 后接非空白出现 **0 次**，故不影响覆盖率。

**两处落点，缺一不可**：

1. **消费侧（新输出）**：各适配器 `block-end` 处调 `stripCourseLeakIfEnabled` ——
   清洗已组装的块。放这里而非流式增量，是因为判据需要「行首」上下文，
   而增量里 `course` 可能跨 chunk 到达（`cou` + `rse`）。
   实测 `block-end` 是**权威覆盖**，改文本即生效（与死循环截断同机制）。
2. **序列化侧（存量自愈）**：`stripCourseLeakFromHistoryContent` 在
   `serializeMessages` 里清洗**已持久化**的历史。⚠️ **只清 `role === 'assistant'`**
   —— 判据只对模型自己的输出成立，**清洗用户输入等于篡改用户的话**；
   `tool-call` 的 `arguments` 也不清（是 JSON，改了破坏解析）。

**开关注入**：`DSH_COURSE_LEAK_STRIP` —— **默认开启**，仅显式假值
（`0`/`false`/`no`/`off`）关闭。用独立的 `resolveCourseLeakStripFlag`，
不要与 `isTruthyFlag`（默认关）混用。

⚠️ **已知边界（非零风险，故必须带开关）**：若模型真的以「课程设计已完成。」
这样的句子开头，会变成「程设计已完成。」。实测 **0/2346**，但原理上非零。
若将来实测出现真实误删，应改为「行首 课 + 白名单词」的保护式判据
（但那时需先证明白名单不会被「泄漏 + 正文」的偶然组合绕过）。
⚠️ 判据**不解析 markdown 围栏**：围栏内若出现行首 `course` 同样会被删
（实测泄漏都出现在自然语言段落，围栏内无此形态，故接受该简化）。

**实测效果**：全库 **2771 行泄漏 → 0 残留**；正常用法零误伤
（`of course` / ` recourse` / `研讨课` / `重要的一课` / `课程设计` 均保留）。
回归用例 `tests/unit/course-leak-strip.spec.ts`（33 条）；
端到端脚本 `scripts/verify-course-leak-e2e.ts`。

#### ⚠️ 纯空白思考会画出「空 Think 块」；零内容块响应必须报 `EMPTY_RESPONSE`

**真实缺陷**（用户报障，2026-09-23）：UI 上出现**空的思考（Think）块**。

实测：`deepseek-v4.1-flash` 偶发只输出**一个空格**当思考 —— 全库 **2233 个**
`trim()` 为空的 reasoning 块，`block.text` **全部是 `" "`**，且 wire 上
`reasoning-chunks.texts` 就是 `[" "]`；**上游为它计了 1 个 token**
（`usage.reasoningTokens=1`，2232/2232）⇒ **空格是模型真实生成的**，非适配器伪造。
分布：`buddy/deepseek-v4.1-flash` 1398 + `workbuddy/deepseek-v4.1-flash` 835。
（脚本 `scripts/trace-empty-reasoning.ts`、`scripts/analyze-reasoning-tokens.ts`。）

⚠️ **两个必须记住的机理**：

**① 「只改出口判据」不够 —— `BlockAssembler` 会用 `partial.text` 组装出残缺块。**
```js
assemble(partial, index) {
  if (partial.block) return partial.block                              // 有 block-end → 用它
  case "reasoning": return { type: "reasoning", text: partial.text }   // 无 → 用累积文本
```
⇒ 只要发过 `block-start`，即便**一个 `block-end` 都不发**，收尾仍会组装出块
（这正是「空 Think 块」的成因）。故必须**从一开始就不发任何 chunk**
（连 `block-start` 都不发）—— 与「空名字 `tool_call`」的修法**完全同型**。
实测脚本 `scripts/verify-empty-reasoning-fix.ts`。

**② 零内容块响应必须报 `EMPTY_RESPONSE`，不能报 `stop`。**
压制空块会引出**新退化形态**：若某响应本来只有那个空白 reasoning 块
（无 text、无 tool-call），就会产出「零块 + `finish: stop`」—— DSH 契约明令禁止：
> Providers occasionally emit a degenerate completion (a terminal stop with zero
> output); adapters classify it as this failure instead of yielding an empty
> assistant message, because **an empty message silently ends the turn with
> nothing for the user or the loop to act on**.

官方范本 `dsh-llm-deepseek`（`lib/index.js` 的 `translate()`）：
```js
reason.kind === "stop" && order.length === 0
  ? { kind: "error", failure: { message: "…no content", code: EMPTY_RESPONSE_CODE } }
  : reason
```
实测频率 **1/30404**（`scripts/quantify-empty-response-risk.ts`）。
这与本项目已两次踩过的同族坑（空名 `tool_call`、死循环）完全同型。

**判据与落点**：

| 位置 | 作用 |
|---|---|
| `src/sse.ts` 的 `createBlankReasoningSuppressor()` | 纯空白思考**一个 chunk 都不发**；转正那次**补发已累积全部文本**（含前导空格）。判据在**整块**（`["a"," "]` → `'a '` 保留），非单片 |
| `src/sse.ts` 的 `resolveEmptyResponseReason(reason, blockCount)` | 零块且原为 `stop` ⇒ `error`/`EMPTY_RESPONSE`；**只在 `kind === 'stop'` 时改写**（故 `loopDetected`/`length`/无名 tool_call/`tool-calls` 优先级全保留） |
| 5 个适配器的 reasoning 发射点（**6 处**，codearts 有两条出口） | 用 helper 的产出替代「无条件建块 + 发 chunk」 |
| 5 个适配器的 `finish` 出口 | `blockCount` = **实际发出的 `block-end` 数**，**不是 `blocks.length`** |

⚠️ **`blockCount` 必须数「实发块」。** 反例：`reasoning_content: '课'`
（本项目已知的真实泄漏 token）会让 helper **建块**，但收尾被
`stripCourseLeakIfEnabled` 洗成空串 ⇒ **实发 0 块而 `blocks.length === 1`**。
用 `blocks.length` 会把这种响应误判成「有 1 块」而报 `stop`（静默结束）。
审查据此实测：把 5 处换成 `blocks.length` 后 34/34 仍通过 —— **曾是测试盲区**，
`tests/unit/empty-response.spec.ts` 已补用例钉住它。

⚠️ **codearts 有两条 reasoning 出口**（`src/llm-adapter.ts:1113-1123` 自称
「漏一条就等于漏一条路径」）：① `delta.content` → `DsmlContentExtractor` 解析
`<thought>` → `emitDsmlFeed`；② `delta.reasoning_content` → `thinking`。
**两条共用同一个 helper 实例**（否则各自累积会错乱）。
回归测试必须**两条都覆盖** —— 审查发现只覆盖出口② 时，出口① 若回归
会**静默**放回空 Think 块（`tests/unit/blank-reasoning-adapter.spec.ts` 的
`A'/B'/C'/D'` 专组负责出口①）。

⚠️ **不得改动发送侧**：`buddy-adapter.ts` 的 `reasoning_content: reasoning` 是
**无条件写入**的（注释：推理模型缺失该字段会 400）。删掉存储侧空块后
`reasoning === ''` 但**字段依然存在** ⇒ 不会 400。**绝不可**改成条件写入。

**开关**：无独立开关（正确性修复，非可选项）。

回归用例：`tests/unit/blank-reasoning.spec.ts`（helper 语义）、
`tests/unit/blank-reasoning-adapter.spec.ts`（块层面「零 chunk」+ 出口①）、
`tests/unit/empty-response.spec.ts`（`finish` 归类 + `blockCount` 判据）。

★ **测试写法教训**（本任务反复踩到，值得单列）：

- **只断言 `finish` 不够**：空块回归时 `finish` 可能仍是 `EMPTY_RESPONSE`
  （因为 `blockCount` 仍为 0），必须**同时断言「没发任何 chunk」**。
- **测试注释里的论证必须有实测支撑**。本项目连续三次凭推理写下断言
  （「没有 D 则 A/B/C 全绿」等），**全部被自己的变异实验证伪**：
  C 与 D 都经过 `feed` 的「转正」分支，故**无法构造只打 D 的变异**。
  注释应**只写实测事实**（附「曾写进注释 / 变异 / 实测 / 结论」表格）。
- **变异测试是唯一能证明断言有判别力的手段**。用「恒真断言」或「只看测试通过」
  都会漏掉盲区 —— 本项目两次靠变异测试发现缺口（`blockCount` 盲区、
  出口① 无覆盖）。
- ⚠️ 变异实验脚本必须 `try/finally` 恢复，并在结束时用
  `git diff --quiet -- <file>` **确认无残留**（否则污染后续提交）。

### ⚠️ `tests/` 不在 `pnpm typecheck` 覆盖内

`tsconfig.json` 的 `include` **只有 `["src"]`** ⇒ `tests/` 的类型错误**不会**被
`pnpm typecheck` 发现。实测把 `tests/` 一并纳入后有 **108 个既有类型错误**
（`HeadersInit` 未定义、`ContentBlock[]` 赋值不兼容、`plugin-src/*.js` 缺声明等），
属独立工程。

⚠️ **新增/修改测试文件后，务必单独跑一次类型检查**（否则 `tests/` 里的类型错误
会被静默放过 —— 本任务已发生过一次：收紧 `src/` 的类型签名后 `pnpm typecheck`
仍 exit 0，但测试文件里有一处 TS2345）：

```
npx tsc --noEmit --strict --target ES2023 --module NodeNext --moduleResolution NodeNext \
  --skipLibCheck --esModuleInterop --types node --lib ES2023 --rootDir . <你的测试文件>
```

#### ⚠️ 测试 fixture 必须保持 LF（`core.autocrlf` 会造成假失败）

本机 `git config core.autocrlf=true`，checkout 时会把仓库里的 LF 转成 CRLF。
而 `tests/fixtures/reasoning-*.txt` 是**真实会话文本提取**，其**字符偏移被测试精确断言**
（`reasoning-loop.spec.ts` 的 `cutAt === 1536/1600`）—— 凭空多出的 3082 个 `\r`
会把偏移推到 **1792** ⇒ **两个断言失败**，且**在纯基线上同样失败**，
极易误判成「刚改的代码坏了」。

根治：`.gitattributes` 的 **`tests/fixtures/** text eol=lf`**。

⚠️ **必须是 `text eol=lf`，不能写成 `-text`**（初版写错，经审查实测纠正）：
- `-text`（不规范化）只挡**检出**期转换，**挡不住入库污染** —— 实测工作区是 CRLF 时
  `git add` 会把 48338 字节（含 617 个 `\r`）写进索引（HEAD 本为 47721），
  此后 `checkout` 把这些 `\r` 发给所有人，**偏移断言对全仓库永久失败**；
- `text eol=lf` 同时具备两项能力：检出写 LF，**入库时把 CRLF 规范化回 LF**。

用 `**` 而非 `*`：gitattributes 的单星**不跨目录**（实测子目录为 `unspecified`）。

**自查**：`git ls-files --eol -- tests/fixtures/` 应全是 `i/lf w/lf`。

### 测试

- 单元测试覆盖核心逻辑（签名、续期、参数构造、账号池），不依赖网络
- E2E 测试按 provider 分为独立脚本（`pnpm test:e2e:*`），**均带闸门且默认跳过**；哪些会消耗模型积分见 `tests/e2e/README.md`
- 测试文件按约定放在 `tests/unit/` 与 `tests/e2e/` 目录

## LLM Provider 约定

- provider 名称：`codearts` / `buddy` / `workbuddy` / `lobsterai` / `qoder` / `trae`
- 端点格式为 OpenAI 兼容
- 请求签名/鉴权方式因 provider 而异：
  - `codearts`：华为云 `SDK-HMAC-SHA256` 签名方案
  - `buddy` / `workbuddy`：Bearer access_token + 额外自定义头（`X-Product-Code` 随产品切换）
  - `lobsterai`：Bearer access_token + `X-LobsterAI-Client-*` 头（**无签名**，也**不带**腾讯系归属头）
  - `qoder`：推理请求头**由 WASM 生成**（含签名），**必须原样透传**，不能自行构造；请求体加密。积分余额端点另走纯 `Bearer`。
  - `trae`：`Cloud-IDE-JWT <token>` + `X-Cloudide-Token` / `X-Ide-Token` / `X-Uid` / `X-Machine-Id` / `X-Device-Id` / `X-Ide-Version` 等十余个身份头（**无签名**，**不带** JSON-RPC 包装）
- provider 在 `ctx.llm` 上注册，配置在 profile 中可选
- `buddy` 与 `workbuddy` 共用 `BuddyAdapter`，行为差异全部由 `src/product.ts` 的 `BuddyProduct` 配置驱动；新增同源产品只需加一份配置并注册实例
- `lobsterai` 用独立的 `LobsteraiAdapter`（协议不同源，见项目概述）；它的产品配置是 `src/lobsterai-product.ts` 的 `LobsteraiProduct`，与 `BuddyProduct` **平行而非继承**
- `qoder` 用独立的 `QoderAdapter`（协议不同源，见项目概述）；产品配置是 `src/qoder-product.ts` 的 `QoderProduct`，同样**平行而非继承**。它的 OpenAI 协议层逻辑复用 `src/openai-compat.ts`
- `trae` 用独立的 `TraeAdapter`（协议不同源）；它的产品配置是 `src/trae-product.ts` 的 `TraeProduct`，同样**平行而非继承**。与其它三个 provider 最根本的差异是**载荷与响应都要转换**：请求体经 `transformToSOLOBody` 转成 SOLO 格式，响应经 `parseTraeSSELine` 从 SOLO 自定义 SSE 转成 OpenAI chunk

## TRAE（字节跳动）协议要点（五个易踩的坑）

`trae` 的 chat 链路与其它 provider **全程不同构**，以下是实测/逆向确认的关键约束：

0. **⭐ 必须先做「消息序列化」，再做载荷转换**（`serializeTraeMessages`）：
   DSH 交给适配器的 `options.messages` 是**原生块结构**
   （`content:[{type:'tool-call'}]` / `[{type:'tool-result'}]` / `[{type:'reasoning'}]`），
   **不是** OpenAI wire 格式。必须先转成 `tool_calls` + 独立 `role:'tool'` 消息，
   **再**交给 `transformToSOLOBody`（后者只认识 `type:'text'`）。

   **真实缺陷**：早期实现把原生块**原样**透传，后果是**每一轮多步对话都坏掉**：
   `tool-call` 不是 SOLO 认识的字段 → **模型看不到自己调用过什么**；
   `tool-result` 同样不被识别 → **模型永远看不到工具返回值**，于是反复请求
   同一个工具或凭空编造结果。全程**没有任何报错**，极难排查。
   三个兄弟适配器（`llm-adapter.ts` / `buddy-adapter.ts` / `lobsterai-adapter.ts`）
   都有这一步，只有 TRAE 漏了 —— 本文件甚至早已 `import` 了
   `resolveToolPairing` 却从未使用，说明当初打算写但没接上。
   已由 `tests/unit/trae-adapter.spec.ts` 的「消息序列化（真实缺陷回归）」锁死。
1. **请求体必须转换，不能透传**（`transformToSOLOBody`）：
   - `stream` 强制 `true`；注入 `function: "solo_work_lite"`（实测 `work` / `solo` / `work_lite` 均无效）
   - `model` 同时写入 `config_name` 与 `model` 两个字段；内部名后缀 `__dev` 需去除
   - `messages[].content` 字符串 → `[{type:"text",text:...}]`
   - assistant 的 `tool_calls[].function` → **`function_call`**（SOLO 字段名），无 `name` 的条目须剔除（上游 `FunctionCall.Name` 必填）
   - ⚠️ **`tools[].function.parameters` 必须序列化为 JSON 字符串**（SOLO 上游要求 string，OpenAI 标准是 object）。因此 **tools 必须放进源的 OpenAI 对象里再交给转换函数** —— 若在转换**之后**再补 `bodyObj.tools`，`normalizeTools` 已执行完毕，parameters 会保持对象形态发给上游被拒（真实缺陷，已由 `tests/unit/trae-adapter.spec.ts` 锁死）
2. **响应是 SOLO 自定义 SSE，不是 OpenAI 格式**（`parseTraeSSELine` / `aggregateTraeSSE`）：事件为 `metadata` / `timing_cost` / `output` / `extra_info` / `token_usage` / `done` / `error`；正文在 `output.response`、思考在 `output.reasoning_content`；`tool_calls` 内层同样用 `function_call` 字段且带 SOLO 专属的 `namespace` / `partial_arguments`（须清理掉，只留标准 `function.{name,arguments}`）。解析须兼容 `data: {...}` 与 `data:{...}`（实测无空格）
3. **凭据必须持久化两个机器指纹**（`buildTraeCredential` / `applyTraeRefresh`）：
   - `machine_id`：**32 位 hex** 设备指纹。**续期时绝不可重新生成** —— 服务端按它标识设备，换了可能要求重新登录
   - `device_id`：**32 位 hex** 签到设备号（`login.sh:34` 的 `openssl rand -hex 16`，与 machine_id 同格式）。**账号间必须互异**，同一天两账号共用会被「该设备已签到」拦截；为空则签到报 9004
4. **`4001 param is invalid` 有三个独立成因**（见下「TRAE 的『通道（`function`）』」）：
   最普遍的是**发错了通道**（模型只在列出它的通道里可调用）；其次是模型本身是
   `is_custom_model` 条目；再次是**请求头被叠成重复值**（`content-type` 大小写各写一次）。
   早期把 `4001` 归因于 `X-Ide-Version` 过低（`0.1.43` 请求 `glm-5.3` 报错、
   `0.1.52` 正常）—— **本次复测未能重现该结论**：`glm-5.3` 在 `0.1.52` 与 `0.1.43`
   下**都**正常返回，故该归因**不足以作为 `4001` 的解释**，已降级为「未复现的旧观察」。

其它要点：`exchange` 的 `refresh_token` 会**轮换**（续期后必须回写）；错误分类见 `src/trae-errors.ts`，其中 `4008`（配额耗尽）与 `1005`（plan 权益不足）是 TRAE 最主要的失败模式。

### ⚠️ TRAE 的「通道（`function`）」：模型只在列出它的通道里可调用

**真实缺陷**（用户报障「使用模型时报 `trae: We're sorry, the param is invalid.
Please try with a valid param. (code=4001)`」）。

#### 症状定位

该文案**只**在 `src/trae-adapter.ts` 的 `consumeSse` 流内 `event:error` 分支拼出 ——
说明 **HTTP 是 200**（请求已被接受），上游在**参数校验阶段**才拒绝。

#### 三个独立成因（都实测过，别混为一谈）

| 成因 | 判据 | 实测 |
|---|---|---|
| ① 模型是「需自行配置的自定义模型」 | `display_config.is_custom_model === true` | **5/5 命中、0 误报** |
| ② **发错了通道** | 该模型不在所发 `function` 的目录里 | 见下路由矩阵 |
| ③ 请求头 `content-type` 被叠成重复值 | 实际发出 `"application/json, application/json"` | HTTP 400 + `code=4001 binding: … missing required parameter` |

**①** 的 5 个条目（2026-09-19 快照）：`deepseek-v4-flash` / `glm-5.3-flash` /
`qwen3.8-flash` / `agnes-2.5-flash` / `silk-gpt-5.6-luna`。

> ⚠️ **该名单已过期，不要再据此删模型**（复测 2026-09-20）：`deepseek-v4-flash` /
> `agnes-2.5-flash` / `silk-gpt-5.6-luna` 已**下架**；`glm-5.3-flash` /
> `qwen3.8-flash` 已转为 `is_custom_model: false`，**是正常可调用的合法模型**；
> 全目录 custom 条目数为 **0**。判据是**标志的值**，不是模型名 —— 曾把
> `qwen3.8-flash` 误记为「应被剔除」，差点误删一个可用模型。

**② 是本节重点**。实测路由矩阵（2026-09-19，逐模型 × 逐通道）：

| model | `solo_agent_remote` | `solo_work_lite` |
|---|---|---|
| `glm-5.2` / `kimi-k3` | OK | OK |
| `glm-5.1` / `qwen-3.5` / `Doubao-Seed-Code` | **OK** | 流内 `4001` |
| `glm-5-turbo` / `sagitta` / `seed-code-pro-0430` | 流内 `4001` | **OK** |

即**「模型属于哪个通道，就只能在那个通道里调用」**。旧实现把 `function` 写死
`solo_work_lite`，于是 agent 专有模型一用就报 `4001`。

**③ 是排查时最容易自伤的**：`{ ...headers, 'content-type': 'application/json' }`
与已有的 `Content-Type` 大小写不同，`Headers` 按 `append` 语义**合并**成非法值。
**写探针/代码时务必用 `new Headers(base).set(...)`，不要用对象展开叠同名头。**

#### 通道目录怎么拿：`batch_get_detail_param`（**不是** `get_detail_param`）

真实 CN IDE 用的是**批量**端点，一次传多个 `functions`，响应 `function_configs[]`
为**每个通道各自一套** `config_info_list`：

```
POST {agentHost}/api/ide/v1/batch_get_detail_param
{ "functions": ["solo_work_lite","solo_agent_remote"], "show_custom_model": true,
  "agent_type": "", "current_config_info": {"config_name":"","is_custom_model":false},
  "mode_type": 0, "access_type": 0, "ab_force_vids": "", "ab_autotest_advanced_mode": 0 }
```

单 function 的 `get_detail_param` 只能拿一个通道的目录，**不要**再用它。

#### 「可调用」与「官方可见」是两个独立维度

| 标志 | 含义 | 本插件处理 |
|---|---|---|
| `display_config.is_custom_model` | 需在 IDE 内自行绑定供应商 | **必须剔除**（必然 4001） |
| `config_switch === false` | 上游已停用 | **必须剔除** |
| `is_invisible_to_user` | **官方 picker 不展示** | **必须剔除**（硬性，使目录与官方 Auto Mode 一致） |
| `usage !== 'chat_completion'` | 非对话用途（summary / fast_apply / multimodal…） | **必须剔除** |

> **历史修正**：早期实现把 `is_invisible_to_user` 当作「两个独立维度」而默认保留
> （理由是实测 `glm-5.1` 被官方隐藏却**可调用**）。后来用户要求目录与官方
> **Auto Mode 选择器完全一致**，该标志遂改为**硬性过滤** —— 代价是
> `glm-5.1` / `qwen-3.5` 等「可调用但官方不展示」的模型不再出现在目录里
> （目录 47 → 29）。这是**有意的取舍**（对齐官方 UI），不是回归；
> 被过滤的模型若已被持久化为会话模型，`resolveModel` 仍能解析。
> 需要临时放宽时改 `parseTraeBatchModelList` 的过滤条件，不要动
> `isTraeModelCallable`（那里管的是「必然调不通」）。

#### 远端参数必须消费（这一条曾被整段漏掉）

- `context_window_tokens.dev` → `contextWindow`。⚠️ 常规会话用 `dev`
  （条目形如 `{dev:200000, max:1000000}`）；`max` 只在**开启 Max 模式**时才声明
  （见下「TRAE 的 Max 模式」），无脑采信 `max` 会让 DSH 以为有 1M 窗口而实际请求被拒。
- `model_detail_list[].max_tokens` → `maxOutputTokens`。实测**主流模型是 32000**
  （旧兜底表写的 131072 / 128000 是估值，**已被推翻**）；多条明细优先取 `__dev` 那条，
  Max 模式那条（`__max`）另存为 `maxModeOutputTokens`。
- `reasoning_effort_config` → `reasoningConfig`（见下「TRAE 的推理强度档位」）。

**真实缺陷**：接口 `TraeRemoteModel` 早已声明这两个字段、`contextWindowFor` /
`maxOutputTokensFor` 也在读，但解析器**从未填充** → 远端值被静默忽略、恒回退兜底表
估值。现由 `parseTraeBatchModelList` 填充，兜底表数值同步修正为 200000 / 32000。

#### TRAE 的推理强度档位（`reasoning_effort_config`）

真实条目：

```json
"reasoning_effort_config": {
  "default_level": "high",
  "options": ["light", "high", "extra_high"],
  "support_thinking": true
}
```

要点：

- **`options` 是单值字符串**，既是产品侧档位名、也是发给上游 `reasoning_effort` 的
  wire 值。⚠️ 这与 LobsterAI 的 `level` / `openclawLevel` **双字段**形态不同 ——
  不要照搬那张映射表；TRAE 的展示名表（`TRAE_EFFORT_NAMES`）**只用于美化**，
  不参与 wire 取值。
- 不声明 `reasoning` 的两种情形：**远端没有该配置**（UI 显示「当前模型未提供
  推理等级」）与 **`support_thinking === false`**（远端明确说不支持思考）。
  后者若照旧声明档位，会让用户选一个发了也没用的值。
- ⚠️ **默认档优先采信远端 `default_level`**（2026-09-26 变更，此前是「一律取最强档」）：
  用户报障「为什么默认是最高档位的思考？按说应该用次高档做默认吧？」。旧行为
  （AGENTS.md 更早版本记的「用户要求所有模型默认用 max」）代价是每次请求都顶格
  思考，而思考 token **计入 `completion_tokens`**、与正文共享额度。
  现规则见 `defaultTraeEffort()`：`default_level` **存在且在 `options` 内**就用它，
  否则退 `strongestTraeEffort`。实测 6 个模型的新旧对照：

  | 模型 | options | 上游 `default_level` | 旧默认 | 新默认 |
  |---|---|---|---|---|
  | `deepseek-v4.1-flash` | light,high,extra_high | `high` | extra_high | **high** |
  | `glm-5.2` | high,extra_high | `high` | extra_high | **high** |
  | `qwen3.8-max` | light,high,extra_high | `high` | extra_high | **high** |
  | `Doubao-Seed-2.1-Pro` | light,high | `high` | high | high |
  | `glm-5.3` | light,high,extra_high | `extra_high` | extra_high | extra_high |
  | `kimi-k3` | light,high,extra_high | `extra_high` | extra_high | extra_high |

  ⚠️ **不要改成「固定取次高档」**：后两行说明上游**自己**在 `glm-5.3` / `kimi-k3`
  上选了最高档，机械取次高会把它们无谓降下来。以**上游的判断**为准。
- ⚠️ **`default_level` 是外部输入，必须校验它在 `options` 内**：DSH 会拿
  `defaultEffort` 直接发请求，给不存在的档位抛 `UNSUPPORTED_REASONING_EFFORT`
  （`dsh-llm` 的 `resolveCallWithInfo`）。实测上游确实会下发
  `default_level: 'max'` 而 `options` 里没有 `max` —— 此时必须退到最强**可用**档。
- ⚠️ **UI 里没有「Default（跟随上游默认）」这一档**：`dsh-client-ui-model-selection`
  只在 `reasoning.defaultEffort === undefined` 时才注入该选项
  （`client.js` 的 `effortChoices`）。我们总是声明 `defaultEffort`，故用户可选项
  只有 `Light / High / Extra High`。
- ⚠️ **DSH 不按模型记忆档位**：切换模型时走 `client.js` 的
  `state.current?.provider === group.id && state.current.model === model.id ? … :
  model.reasoning?.defaultEffort` —— 切到别的模型再切回来取的是**新模型的
  `defaultEffort`**，不是上次手选的档位。故「切走再切回仍是最高档」在旧行为下
  是必然结果（默认档就是最高档），不是"记住了"。**区分方法**：先选次高档
  `high`、切走、再切回，若回到 `extra_high` 即为该机制而非记忆。
- ⚠️ **`extra_high` 下正文可能为空，这是模型行为、不是档位被拒**：实测
  `maxTokens` 给到 4096，同一档位重复调用仍**随机地**有时返回「好的」、有时
  只回思考不吐正文（`outputTokens` 仅 41~113、几乎全是 `reasoningTokens`，
  `finish.reason` 均为 `stop`）。故 e2e **不要断言「正文非空」**（会随机失败），
  判据用 `finish.reason.kind === 'stop'`。排查脚本
  `scripts/probe-trae-effort-stream.ts <model> <effort|''> <maxTokens>`（打印
  每个 chunk 类型、usage 与 finish 原因；**消耗额度**）。
- `defaultEffort` 必须落在 `efforts` 内 —— DSH 会拿它直接发请求，给一个不存在的
  档位会抛 `UNSUPPORTED_REASONING_EFFORT`。因为取值来自 `options` 本身，天然满足。
  实测 DSH 侧物化逻辑：`dsh-llm` 的 `LlmRuntime` 在 `requested ?? reasoning.defaultEffort`
  处把默认档写进 `config.reasoningEffort`（调用方不传时），并校验成员关系 ——
  所以**只声明 `defaultEffort` 即可**，适配器不必自己补发 `reasoning_effort`。
- 下发：`stream()` 把 `options.reasoningEffort` 原样写进 `reasoning_effort`，
  **不做白名单校验**（校验只会把「远端新增档位」变成静默丢弃）。
- ⚠️ `options` 为**对象数组**（`{level, openclawLevel}`）时取 `openclawLevel`、
  回退 `level` —— 这是防御性兼容：上游若改成双字段形态，解析不会退化成空数组。

#### TRAE 的 Max 模式（1M 上下文，**默认开启**）

`display_config.max_mode === true` 的模型支持 **Max 模式**（1M 窗口）。协议逆向自
`Trae2api-cn/src/trae_remote_client.py:249-397`（`_max_mode_requested` /
`_max_mode_fields`），要点：

- **不能只把 `max_tokens` 调大**：上游按 `strategy=max` +
  `model_auto_selection.strategy=max` 判定「这是 Max 会话」，缺了它们只会被当成
  常规会话、按 200K 校验，然后拒绝 1M 的输入。三件套
  （`context_window_size` / `prompt_max_tokens` / `max_tokens`）必须**成套**下发。
- 常量：1M 窗口 / **936K** 提示词预算 / **64K** 输出上限 / `mode_type: 1`
  （`TRAE_MAX_CONTEXT_TOKENS` 等）。936K < 1M 是刻意的 —— 给输出留位。
- ⚠️ **默认开启**（用户要求「上下文用最大的那一档」）：`resolveMaxModeFlag` 只有
  见到显式假值（`DSH_TRAE_MAX_MODE=0`/`false`/`no`/`off`）才关闭。**不要**改回
  `isTruthyFlag`（那是「默认关」语义，混用会让开关静默失效）。
- ⚠️ **三个条件缺一不可**（`TraeAdapter.maxModeFor`）：
  1. 产品级 `DSH_TRAE_MAX_MODE` **未关**（默认开；Max 会话计费倍率不同，要省额度时设 `0`）；
  2. 远端 `display_config.max_mode === true` —— **绝不**给未标记的模型硬套 Max 参数，
     CN 项目原注释明写 *"Never fabricate max limits for a model the account config
     does not mark"*，上游会拒；
  3. `DSH_TRAE_MAX_MODELS` 白名单（留空/含 `*` = 全部）。
- 未标 `max_mode` 的模型即便开关为开也**仍走 `dev`(200K)** —— 开启不会让任何模型失败，
  这部分「最大的那一档」就是它自己能用的最大档。
- **注入点在 `clampTraeMaxTokens` 之后**：Max 会话的输出上限由 `__max` 明细声明
  （实测 `custom_model_1M__max` 384000 vs `__dev` 64000），被 64K clamp 覆盖会让
  Max 请求与常规请求的输出预算相同、失去意义。
- `resolveModel` 同步切换：Max 生效时 `contextWindow` 用 `max`（1M）、
  `defaultMaxTokens` 用 `maxModeOutputTokens`；未生效时仍用 `dev`（200K）。
  **两者绝不能混用** —— 未开 Max 却声明 1M 会让 DSH 把超长上下文直接发出去，
  上游按 200K 校验后拒绝。

#### ⚠️ TRAE **支持图片**，但必须逐模型判定（Issue #IKHDKC）

**真实缺陷**（用户报障「TRAE字节 模型不支持图片」）：早期 `inputModalitiesFor`
恒返回 `['text']`（参数名是 `_model`，即**刻意忽略模型**），理由写的是
「SOLO 通道未见图片能力」。后果不只是「少个功能」——`inputModalities` 是
**DSH 的准入闸门**，图片在**附件入库阶段**就被拒
（`session/attachment-invalid`），用户看到「当前模型不支持图片，请切换支持
图片的模型」，而报错把原因指向**模型**，真实原因是**插件**。

**实测证伪**（2026-09-21，真实凭据）：

1. 远端目录**一直**在 `display_config.multimodal` 里声明该能力 —— 它与
   `max_mode` / `is_custom_model` 是**同一层级的相邻字段**，当初读了一个漏了另一个
   （52 个可调用条目中 27 个为 `true`；本插件可见集 19 个中 15 个为 `true`）；
2. **直发图片，模型真的看得见**：纯红图答「红色」、纯蓝图答「蓝色」、
   不带图答「无法确定」—— 三次答案不同，且无图时思考链明说「并没有提供图片」。
   ⚠️ 只验「不报错」不够：**静默丢图同样不报错**，必须做这种三连对照；
3. **反向对照定死判据**：`multimodal: false` 的模型（`DeepSeek-V4-Pro-Official`）
   收到图后答「无法确定」、思考链说「但没有图片」，**与不带图的回答一致**
   → 该标志是**权威准入判据**，不能按 provider 一刀切。

⚠️ **两个字段是两种独立能力，不可合并**：`multimodal`（用户贴图）与
`tool_response_multimodal`（工具结果图能否回传）。实测 `deepseek-v4.1-flash`
前者 `true`、后者 `false`；Doubao / Kimi 系列两者皆 `true`。
本插件**只消费 `multimodal`**，另一个仅保留信息。

⚠️ **请求形态无需协议逆向**：`transformToSOLOBody` 对**数组形态的 content
原样透传**，所以 OpenAI 的 `{type:'image_url',image_url:{url}}`（data URL）
直发即被接受 —— 与 buddy / lobsterai 适配器**完全同款**，没有 TRAE 专属转换。

落点（四处）：

1. `src/trae.ts`：`TraeRemoteModel` 加 `multimodal` / `toolResponseMultimodal`，
   `parseTraeConfigEntry` 与 `maxMode` 相邻处读取（含 PascalCase 回退）；
2. `inputModalitiesFor(model)` 改为 `remoteMeta.get(model)?.multimodal === true
   ? ['text','image'] : ['text']`（**未声明按不支持**，不臆造能力）；
3. `listModels` / `resolveModel` **两个出口**都改用它（漏一个闸门仍会拦图）；
4. `stream()`：按模型判定 —— 声明支持则读 `readImage` 字节转 data URL
   （`collectImages` 递归收集 + `userContentParts` 递归序列化，
   **两侧必须对称**）；不支持则明确报错且**不发请求**。

⚠️ `readImage` 必须由 `index.ts` 桥接（`makeReadImage(ctx)`）。缺失时收到图片
报「需要附件服务」而**不是**静默丢图；字节读取失败时留 `[image unavailable]`
占位符（空 Map 不能降级为 undefined，否则占位符也被跳过）。

#### 修法落点（四处）

1. `parseTraeBatchModelList`（`src/trae.ts`）按通道合并目录，每条记上 `function`
   与三个标志；同一 `config_name` 出现在多个 function 时**后面的覆盖前面的**
   （后面的条目带更完整的 `reasoning_effort_config` / `model_detail_list`）。
   同时执行三条硬性过滤：`usage !== 'chat_completion'` / `config_switch === false` /
   `is_invisible_to_user === true` 全部剔除。
2. `TraeAdapter.listModels` 过滤掉 `is_custom_model === true` 与 `isHidden === true`
   （`remoteMeta` 保留全量，已持久化的模型 id 仍可解析）。
3. `TraeAdapter.channelFor(model)` → `transformToSOLOBody(body, undefined, channel)`：
   **发送时按该模型所属通道下发 `function`**，查不到才回退 `product.function`。
4. `traeStreamErrorMessage` 给 `4001` 追加「模型不被上游接受」，同时**保留**上游原文
   与错误码。其余错误码保持原文，**不做无依据的解释**。

> ⚠️ `hideInternalModels`（`DSH_TRAE_HIDE_INTERNAL`）与 `isTraeModelUsable` 的
> `hideInternal` 参数**已废弃**：`is_invisible_to_user` 现在是**硬性过滤**，因为
> 目录要与官方 Auto Mode 选择器一致。字段保留仅为兼容既有 profile。
> `channels` 默认已改为 `['solo_agent', 'solo_work_lite', 'solo_agent_remote']`，
> 首位 `solo_agent` 对应截图 Auto Mode 的模型列表。

#### 真实 CN IDE 的其它情报（Reqable 抓包，`Trae CN.exe 3.3.94`）

- 头：`x-ide-version: 3.3.94` / `20260820`、`x-app-version: default`、
  `package-type: stable_cn`、`x-lgw-req-sdk-type: 3`、UA `TraeClient/TTNet`；
  `x-machine-id` 是 **64 hex**、`x-device-id` 是 **16 位数字** —— 与本插件的
  32hex/32hex **不同**（本插件走的是旧 SOLO 协议，勿照搬）。
- `llm_utils_chat` / `create_agent_task` 的**请求体是加密的**（配 `x-helios` /
  `x-medusa` / `x-neptune` / `x-request-pin` / `x-requested-at`）。实测**仅换版本头
  解不开**加密的那批模型（`deepseek-v4-flash` 等仍失败）→ 门槛是加密信封本身，
  属独立工作量，**尚未实现**。
- 另有 22 个 function（`chat_v3` 58 / `builder_v3` 51 / `solo_coder` 46 / `solo_agent`
  66 …）与非对话通道（`multimodal` / `system_diagnosis`）；本插件只默认启用实测过的
  `solo_work_lite` + `solo_agent_remote`（`DSH_TRAE_CHANNELS` 可覆盖）。

> **排除性证据**（都做过，别重复走）：消息序列化 / `tools.parameters` / 多轮
> `tool_calls`+`tool` 结果、`max_tokens`（64000 与 128000）**全部通过**；
> 兜底表 id 也都真实存在；`X-Ide-Version` 的旧归因**未复现**（`glm-5.3` 在
> `0.1.43` 与 `0.1.52` 下都通过）。
> ⚠️ 曾经把上面的 ③ 误判为「突发限流」和「host 不匹配」——两次都是错的。
> **全 4001 时先检查自己发的头**，再怀疑上游。

### ⚠️ 登录回调**没有** `code`：直接回传 token，参数名是 `auth_callback_url`

**真实缺陷**（用户报障「网页一直停在认证中的界面」）：早期实现按 OAuth 惯例
把 TRAE 当成标准的授权码流程，于是：

1. 登录 URL 只发了 5 个参数，且回调地址用了 `callback_url` / `redirect_uri` ——
   **真实参数名是 `auth_callback_url`**。名字错了 TRAE 拿不到回调地址，
   登录页既不跳转也不回传任何东西；
2. 回调解析去找 `?code=` —— 而真实回调**根本没有该参数**，它直接回传
   `refreshToken` / `userInfo` / `userJwt`。于是 `parseTraeCallback` 恒判失败
   → 回调服务器回 400 → `result` Promise **永不落定**
   → 前端 `login.poll` 永远拿不到 `done:true` → **一直显示「认证中」**。

正确的登录 URL 是 **18 个参数**（唯一权威：`login.sh:47-72` /
Go 端 `BuildLoginURL`）：`login_version=1`、`auth_from=solo`、
`login_channel=native_ide`、`plugin_version=2.3.62834`、`auth_type=local`、
`client_id`、`redirect=0`、`login_trace_id`（hex16，回调据此反查 pending）、
`auth_callback_url`、`machine_id`、`device_id` 与 `x_machine_id` / `x_device_id`
/ `x_device_brand=PC` / `x_device_type=PC` / `x_os_version=1.0` /
`x_app_version` / `x_app_type=stable`。

真实回调形态：

```
http://127.0.0.1:18080/authorize?refreshToken=...&userInfo={...}&userJwt={...}
```

要点：

- `plugin_version`（`2.3.62834`）与 `ideVersion`（`0.1.52`）是**两个独立字段**：
  前者给登录门户，后者是 chat 端点的模型准入版本，不可混用
- 解析容错对齐 `login.sh:153-166`：`refreshToken` 缺失时回退
  `userJwt.RefreshToken`；两者都缺才用 `userJwt.Token` 兜底
- ⚠️ 回调的 `userInfo` 字段名是 **`TenantID`**（不是 `EnterpriseID`），
  且中文昵称存在**双重编码**乱码（实测 `Óû§8847309959`），
  须按 `fixNicknameMojibake` 回转，修不好则回退「用户+uid末4位」
- `device_id` 是 **hex32**（`login.sh:34` 的 `openssl rand -hex 16`），
  早期误用「16 位纯数字」（那是 CodeBuddy 的签到格式）

#### ⚠️ 但「带 `code` 的回调」**不是**无效回调（第二次修正，避免过度断言）

上面那条结论只说明「token 直传」是**当时实测的**流程，**不能**推广成
「带 `code` 即非法」。`Trae2api-cn/src/main.py:478-484` 的注释写明了真相：

```
1. 新流程 (code_challenge): callback 会带 authCodeInfo / code 等参数
2. 老流程 (refreshToken):    callback 直接带 refreshToken=xxx
```

**两套流程并存**。若把带 `code` 的回调一律判为「无效」，一旦上游把登录门户
切到 PKCE 新流程，**合法回调会被误判为失败**，症状与「一直认证中」一模一样，
而报错文案（「缺少 refreshToken」）会把排查方向带偏。

正确做法：`parseTraeCallbackDetailed` 对两种形态**都返回结果**，用
`authCodeFlow: true` 区分，并给出「上游返回了 PKCE 授权码，本实现暂不支持该
流程」这种**指向真实原因**的文案。注意 `authCodeInfo` 可能是 JSON
（`{code:...}`）也可能是**纯 code 字符串**，两种都要认。

> 教训：把「某次实测没见到 X」写成「X 一定不存在」是很危险的断言 ——
> 它会把未来的正常情况判成故障，且错误信息指向错误的方向。

#### ⚠️ 无效回调**必须落定结果 Promise**（第二个「一直认证中」根因）

`startTraeLoginFlow` 与 `startCallbackServer`（`src/trae-oauth.ts`）**两个**
回调处理器里，解析失败的分支早期都只写了：

```ts
res.writeHead(400, ...); res.end(...); return   // ← 没有 resolve 也没有 reject
```

结果 Promise 悬空 → 前端 `login.poll` 永远拿不到 `done:true` →
**界面永久停在「认证中」**，只能等 10 分钟超时。

这与「参数名写错」是**两个独立根因、同一个症状**：修好协议解析并不能顺带
修掉它，必须单独保证「**任何**回调路径都落定 Promise」。
`startCallbackServer` 是 `TraeAuth` / RPC 实际走的路径，漏改它同样致命 ——
两处都要有 `reject(...)`。

回归用例：`tests/unit/trae-oauth.spec.ts` 的「无任何可用参数的回调也必须落定
结果」。注意用例必须**先挂拒绝处理器再触发回调**，否则窗口期内它是未处理拒绝。

### ⚠️ 本地回调服务器：listen 失败必须先注册 `error`，否则崩掉整个宿主

`startTraeLoginFlow` / `startCallbackServer`（`src/trae-oauth.ts`）里，
`server.listen()` 的失败（最典型 `EADDRINUSE`：端口被占用）是**通过
`'error'` 事件异步抛出**的，**不属于 Promise 链** —— `await` 一个内部调用
`listen()` 的 Promise **捕获不到**它。

**真实缺陷**（用户报障，进程级崩溃）：早期实现直接 `server.listen(18080)`，
没给 `'error'` 注册处理器。于是 18080 被占用时：

- 该错误逃过 RPC 层的 `try/catch`；
- 成为**进程级 unhandled error**，把**整个 DSH 宿主**打挂；
- 用户看到的不是可读文案，而是一整堆
  `Error: listen EADDRINUSE: address already in use :::18080` + 堆栈 + 进程退出。

修法（`listenOrReject`，三处缺一不可）：

1. **在 `listen()` 之前**注册 `'error'`，把首个错误转成 Promise reject，
   让 RPC 层能照常返回规范错误响应；
2. 启动成功后把一次性处理器**降级为常驻监听** —— 运行期也可能出现 `'error'`
   （如 EMFILE），没有监听者会再次变成进程级崩溃；
3. 绑定 **`127.0.0.1`** 而非 `::`/`0.0.0.0`：这是本地 OAuth 回调，绑定所有
   网卡会让同局域网的机器也能投递伪造的 `?code=`，把攻击者的授权码写进用户
   凭据（`src/login.ts` 与 `src/lobsterai-oauth.ts` 同样只绑回环）。

配套：端口被占用时**回退到系统分配的随机端口**（`listenWithFallback`），
而不是直接失败。TRAE 的 `redirect_uri` 是我们自己构造并随登录 URL 下发的，
服务端原样回跳 —— 因此端口不固定也能工作。**注意顺序**：必须先 `listen`
拿到实际端口，**再**构造 `redirect_uri`（否则回调会打到没人监听的地址）。
这与 CodeArts 的 `listenOnCallbackPort` 同思路。

> 排查提示：Windows 上 `::` 与 `127.0.0.1` 是**两套可共存的栈**。写「端口占用」
> 的测试时，占位方必须绑与服务端**相同的地址族**，否则产品侧仍能绑定成功，
> 用例变成假阳性（本模块的 `tests/unit/trae-oauth.spec.ts` 踩过这个坑）。

### ⚠️ 错误分类必须先判更严重的类别

`classifyTraeError` 的判定顺序里，**`quota-exceeded`（4008）必须排在 `soft-rate`（4011）之前**。

两者可能同时出现在一个响应体里（网关把多个错误码拼在 msg 中）。`quota-exceeded` 需长冷却，`soft-rate` 只需短冷却 —— 让较轻的类别抢先命中，会让一个已耗尽额度的账号在 60 秒后被反复重试，用户看到的却是「稍后再试」。**真实缺陷**：早期实现把 4011 放在前面，`tests/unit/trae-errors.spec.ts` 已锁死该顺序。

### ⚠️ 续期的终态判定要看三种依据

`TraeAuth.refreshCredential` 判定「需重新登录」有三种独立依据，缺任一种都会让用户卡在无解的重试里：

1. HTTP 401 / 403（状态码最权威）
2. 分类结果为 `session-dead`
3. **拿到了 2xx、响应体也是 JSON，却没有 `accessToken`** —— 对齐 Go 的 `refresh_failed: no token in response — re-login required` 与 `LobsteraiAuth` 的同款处理。这不是瞬时故障，重试一万次也不会有 token

反之，**传输层失败（网络抖动）与 5xx 必须是可重试的普通 Error**，否则一次瞬时故障就让用户重新登录。另外响应体要**先取文本再解析**（不要直接 `response.json()`）：凭据失效时网关返回 HTML，`json()` 抛出的 `Unexpected token '<'` 对用户毫无意义。

### ⚠️ TRAE 签到：请求头与设备身份必须对齐真实客户端（`trae-mate` 实证）

**真实缺陷**（用户报障「模型没问题了，但签到有问题」）。参考实现
`E:\Workplace\APP\Tauri\trae-mate\src-tauri\src\checkin.rs` 是**能正确签到**的版本，
与旧实现有三处根本差异（旧实现在此之前只有 6 个精简头 + `{"req_source":2}`）：

| 维度 | 旧实现（失败） | trae-mate（成功） |
|---|---|---|
| 请求头 | 6 个（`Content-Type` / `Accept` / UA / `Authorization` / `X-User-Region` / `X-Device-Id`） | **约 20 个**客户端头 |
| 设备号 | `deriveCheckinDeviceId(credential.device_id, gen)`（32 hex） | **基于 `user_id` 确定性派生的 15 位数字** |
| claim body | `{"req_source":2}` | **`{}`** |

要点（`traeCheckinHeaders` 已全部落地）：

- **设备身份是「每账号一套、稳定派生」**，不是从凭据的 `device_id` 取。三件套
  （对齐 `device_map.rs`，salt 各不同）：
  - `X-Device-Id`：15 位数字（`seededDigits(15, uid, 'devid')`）
  - `X-Market-User-Id`：UUID v4（`seededStream(uid,'market',16)`，置 version/variant 位）
  - `Vscode-Sessionid`：64 hex（`seededStream(uid,'sess',32)`）
  同一 `uid` 永远得到同一套值 → 多账号天然互异，规避「每设备每天一次」配额。
- 新增头：`X-Market-Client-Id` / `X-Lgw-Req-Sdk-Type: 3` / `Package-Type: stable_cn` /
  `X-Lscbd-Aid: 787976` / `X-Lscbd-Platform` / `App-Version` / `X-Tt-Trace-Id` /
  `X-Request-Id`（**每请求刷新**）/ `Sec-Fetch-*`。
- **签到与余额都要用完整头**（`postJson` 统一走 `traeCheckinHeaders`）；
  `traeUgHeaders` 保留给其它 Ug 场景。
- **积分余额 body 改为 `{"require_usage": true, "req_source": 2}`**（不是 `{}`）——
  不带它拿不到 `usage`，余额会恒等于额度。
- **9074 不再换设备号重试**：设备身份已由 `uid` 确定性决定、每账号独立，
  「换个派生 id 立刻成功」的旧前提不成立。命中 9074 时归为 `BusinessError`（300s 冷却）
  并如实上报。
- ⚠️ **claim 响应不含积分数，必须补查 status**：`checkin_credits/claim` 的完整响应
  就是 `{"code":0,"message":"success"}`。**真实用户报障**：「领取积分显示成功但是加
  0 积分」—— 早期实现读 claim 响应的 `credits`，而该字段根本不存在，故**恒为 0**。
  所得数值只在 **status 端点**的 `credits` 字段里（实测 `150`，与积分余额中
  「签到奖励」包的 `credits_limit:150` 吻合）。现在 `claimTraeDailyCheckin` 在
  `code === 0` 后补查一次 status；补查失败时 `credit` 为 0 但**仍是 claimed**
  （不因补查失败而把成功判成失败）。
- ⚠️ **claim 对「今天已签到」是幂等的**：实测重复领取同样返回
  `{code:0, message:"success"}`，与真正成功**无法区分**。因此 `credits.claimAll`
  的 TRAE 分支**必须开启状态预检**（`collectClaimResults` 的 `precheckStatus` 保持
  默认 true 并注入 `fetchStatus`）—— 早期照抄 LobsterAI 传了 `precheckStatus: false`
  （那是「LobsterAI 领取流程内部已做 slot/context 预检」的理由，TRAE 没有这回事），
  于是已签到的账号被报成「领取成功」。判据只能是 status 的 `checked_in`。
  已有源码级守卫（`tests/unit/jet-hub-rpc.spec.ts` 的「TRAE 的 claim 分支开启状态预检」）。
- **错误分类**（`classifyTraeCheckinError`，对齐 `cooldown.rs`）：
  `200+1005 → PlanLimit(12h)` / `429 → SoftRate(60s)` / `401 → SessionDead(永久)` /
  `404 → NotFound(60s)` / `5xx → Server(600s)` / `4xx → Client(600s)` /
  `业务码非0 → BusinessError(300s)`。
- ⚠️ **网络异常与业务失败必须分开**：`postJson` 区分 `httpStatus === 0`（传输层失败，
  可重试）与有状态码（业务失败，**不**重试）。重试只针对前者。

> 旧实现里 `deriveCheckinDeviceId` / `AccountPool.traeCheckinDeviceGeneration*` /
> `TRAE_CHECKIN_BUSY_CODE` 的轮换链路**保留但不再被调用**，仅为兼容既有账号条目；
> 新语义下设备号由 `uid` 派生，无需持久化代次。

### ⚠️ 历史超过约 500K 字符时上游会**静默断流**

上游在请求体过大时会**不发错误码、直接结束事件流** —— 日志里看到的只是「模型
没有回复」，不是任何 4xx/5xx。CN 项目为此设了两道闸门
（`TRAE_REMOTE_MAX_HISTORY_CHARS=480000` 与 `TRAE_REMOTE_QUERY_MAX_CHARS=480000`）。

`trimTraeHistory`（`src/trae-adapter.ts`）取其下沿作默认预算
（`DSH_TRAE_MAX_HISTORY_CHARS` 可覆盖），三条约束：

1. **从最早的非系统消息开始丢**，最近历史（尤其本轮工具结果）必须保住；
2. ⚠️ **以「轮」为单位裁剪，绝不切断 tool_call / tool 配对** —— 带 `tool_calls`
   的 assistant 必须连同其后的 `role:'tool'` 结果一起丢，丢一半会被上游 400 拒绝；
3. **system 消息永不裁剪**（不假设它都在开头，用逐条标记而非下标切片）。

⚠️ **裁剪必须在 `serializeTraeMessages` 之后**做 —— 裁的是 OpenAI wire 消息，
不是 DSH 原生块。

### ⚠️ 空响应（静默 EOF）只允许在**首个事件之前**重试一次

上游有时会「HTTP 200、会话创建成功、一个事件都不发就结束流」。`consumeSse`
用 `sawAnyUpstreamEvent` 标记是否收到过**任何**可解析事件，并在**一个都没有**时
抛 `TRANSPORT`（可重试），由 `stream()` 重试**一次**。

- ⚠️ **一旦已有 output / usage / tool_calls 事件就绝不重放**：重放会让上游
  **重复计费**，并可能**重复执行工具**（对齐 CN 项目的
  `TRAE_REMOTE_WORK_FALLBACK` 语义）
- ⚠️ **不能把空响应当成正常的空 finish**：那会让用户看到「模型回复为空」这种
  毫无线索的结果，且不触发任何重试

### 单次输出上限收敛到 64K（`clampTraeMaxTokens`）

CN 项目实测：SOLO CN 的 agent-remote 模型单次响应上限 **64000 tokens**，并明确
警告「客户端索要 131072 会把上游打成 4xx」（`model_limits.py:9-23`）。

故 `clampTraeMaxTokens` 默认把 `max_tokens` 收敛到 **64000**
（`DSH_TRAE_MAX_COMPLETION_TOKENS` 可覆盖，设 `0` 表示关闭收敛）。

> **后续实测补正（2026-09-19）**：远端 `model_detail_list[].max_tokens` 对**主流
> 模型声明的就是 32000**（不是 64000，也不是兜底表旧值的 128000）。现在该值被
> 真正消费并写进 `resolveModel` 的 `defaultMaxTokens`，所以这个 64000 收敛在实际
> 请求里通常**不会生效**（32K 已低于阈值）—— 它保留为「上游没声明时」的最后一道
> 保险。若某模型远端声明偏大，调大 `DSH_TRAE_MAX_COMPLETION_TOKENS` 即可。

### 机器指纹轮换默认**关闭**（`DSH_TRAE_ROTATE_MACHINE_ID`）

CN 项目每 3~5 次请求主动换 `machine_id` 以「降低 IDE 端点风控」
（`trae_client.py:211-224`）。但这与本地既定约束
「`machine_id` 登录后**绝不重新生成**」冲突 —— 它换来抗风控，代价是设备身份漂移，
而上游按 `machine_id` 标识设备，换值可能要求重新登录。

故该能力**默认关闭**，仅在显式设 `DSH_TRAE_ROTATE_MACHINE_ID=1` 时按每 4 次
请求递增一代（`deriveRotatingMachineId`）。它是出现**集中 401/风控**时的第一个
可尝试开关。

## LobsterAI 模型列表（三个易踩的坑）

`GET /api/models/available` 有三个**各自独立、叠加生效**的坑，任一个都会让远端已上线的模型在面板里看不到或参数不对：

1. **响应是单层 `data` 数组**：真实形态是 `{code:0, message:'success', data:[{modelId,...}]}` —— `data` **直接是数组**（实测 2026-09-17，26 个模型）。**不能**复用 `parseLobsteraiEnvelope`：那个信封要求 `data` 必须是对象（用于把「凭据失效返回 `data:null`」判成失败），复用会让本端点恒判失败 → 空数组 → 适配器静默回退静态兜底表。解析走 `readLobsteraiModelArray`，**同时兼容**单层与双层（`data.data`）两种形状。
2. **必须带 `X-LobsterAI-Client-Capabilities` 头**：服务端按该头声明的能力**过滤模型集合**。不带时只返回 25 个且**没有 `kimi-k3`**；带 `kimi-k3-agentic-v1` 才返回 26 个。所以模型列表用 `lobsteraiModelsHeaders`（含两个 `X-LobsterAI-Client-*` 头，`Accept` 为 JSON），**不是**只有 4 个基础头的 `lobsteraiAuthHeaders`。
3. **能力声明还必须含 `thinking-level-control-v1`**：`reasoning_effort: "off"`（关闭思考）在**不带**该能力时服务端直接 HTTP 500；low/high/max/xhigh 不受影响。故 `LOBSTERAI_CLIENT_CAPABILITIES` 是**逗号分隔的两个值**，缺一不可 —— 这是「用户把档位调到 off 才炸」的隐蔽故障。

静态兜底表（`LOBSTERAI_FALLBACK_MODELS`，19 个）是 2026-08-06 抄的快照，**只在远端整体失败时顶替**；远端可用时完全采信远端（不做 buddy 那样的「以兜底表为准」裁剪）。它天然会逐渐过时（实测已缺 8 个新模型、多了 1 个已下架模型），排查「模型看不到」时**先确认远端到底返回了什么**，别直接看兜底表。

### 远端模型参数必须消费（不能只看 id/name）

远端每个模型还下发 `contextWindow`（实测多为 **1000000**，兜底表却统一写 131072）、`supportsImage`（26 个里 19 个为 true）、`supportsThinking`、`thinkingConfig`、`maxTokens`、`description`。这些是权威值，**兜底表只是估值**：

- `resolveModel` 的 `context` 取**远端优先、兜底表次之**；采信 131072 估值会让 DSH 远未用满 1M 窗口就触发压缩
- `inputModalities` 由远端 `supportsImage` 驱动（未声明时保守报 `text`）
- 可选字段缺失一律留 `undefined`，**绝不填 0/false**：「远端说不支持」与「远端没说」是两回事

### 思考档位的 wire 值是 `openclawLevel`，不是 `level`

`thinkingConfig.options[]` 每项有 `level`（**产品侧档位名**，含 `max`）与 `openclawLevel`（**发给服务端的 `reasoning_effort` 取值**，无 `max`）。远端把 `level: 'max'` 映射到 `openclawLevel: 'xhigh'`。

实测反证：直接发 `reasoning_effort: 'max'` 与不带参数**无差异**（走服务端默认），发 `'xhigh'` 才真正触发最高档。因此 `reasoningFor()` 用 `openclawLevel` 作 effort id，`defaultEffort` 也经 `options` 映射后再声明（必须落在 efforts 内，否则 DSH 会拿不存在的档位去请求）。

#### ⚠️ 但**展示名**必须用 `level`（Issue #IKHCZF）

**`id` 与 `name` 的来源不同，不能都取 `openclawLevel`**：

| 字段 | 来源 | 理由 |
|---|---|---|
| `efforts[].id` | **`openclawLevel`** | DSH 把它原样写进 `reasoning_effort`，必须是服务端认的取值（无 `max`） |
| `efforts[].name` | **`level`** | 纯展示；产品侧（IDE）显示的就是 `Max` |

**真实缺陷**（用户报障 / Issue #IKHCZF「最强思考档显示为 XHigh，与产品侧命名 Max
不一致」）：早期两处都用 `openclawLevel`，于是最强档显示 **XHigh** —— 用户按 IDE 里的
「Max」找，界面上却只有「XHigh」，以为缺了最高档。根因是把「wire 值」与「展示名」
当成同一个概念。

⚠️ `EFFORT_NAMES` 因此**必须同时登记 `max` 与 `xhigh`**（前者给 `level` 查，
后者给 `openclawLevel` 回退查）。对照 `buddy-adapter.ts` 的同类表：它同样两者都登记
—— buddy 无双字段（id 即 wire 值），故不存在这个坑。

实测（2026-09-20，真实凭据，28 个模型）：`level` 取值 `{off, high, max}`、
`openclawLevel` 取值 `{off, high, xhigh}`，8 个模型含 `max→xhigh`。
修复后 `id=xhigh / name=Max` —— **wire 行为不变，仅展示名纠正**。

### SSE 的 `delta.content` / `delta.reasoning_content` 会显式返回 `null`

真实形态（实测 335 帧）：一个模型要么走 content、要么走 reasoning_content，**另一侧恒为 `null`**（227 帧 `content=null`）。解析必须用 `typeof x === 'string'` 而非 `!== undefined` —— 只判 undefined 会让 `.length` 在 null 上崩溃，表现为**每轮对话第一帧就报 `Cannot read properties of null`**。

### 图片输入

远端声明 `supportsImage` 的模型**真的**接受图片：服务端收 OpenAI 兼容的 `{type:'image_url', image_url:{url}}` data URL（实测模型能正确识别图片内容）。**唯一**接受的形态就是它 —— `{type:'image'}` 与裸 base64 字符串都返回 HTTP 500。

- 能力按**模型**判定（`inputModalitiesFor`），不是按 provider 一刀切
- `stream()` 里 `ensureRemoteModels()` 必须在图片判定**之前**调用，否则 `remoteMeta` 尚空、会把支持图片的模型误判为不支持
- 工具结果内嵌图片（`read_image`）不能留在 `role:'tool'` 消息里（该角色 content 只能是字符串），须提升为**其后的独立 user 消息**；`userContentParts` 与 `collectImages` 必须**对称递归**，否则深层图片会被静默吞掉
- 只声明 `inputModalities` 而不实现比不声明**更糟**：DSH 在 `LlmRuntime` 里按它决定是否把图片投影成文本占位符，声明支持就必须真支持

## 「+ 新建账号」必须两步式返回 loginUrl（七个 provider 一致）

`account.create` 对**全部七个 provider** 都必须在**用户完成授权之前**返回
`loginUrl`，由前端立即 `window.open`，后台再异步等回调。

这不是风格偏好，而是浏览器硬约束：`window.open` 只在用户点击后的
**transient activation** 窗口（约 5 秒）内被允许。若 `account.create` 阻塞到
用户授权完成（数十秒），返回时手势已过期 → 弹窗被拦截返回 `null` → 前端若
兜底 `window.location.href = loginUrl` 就会把**整个设置页**导航走。
**真实缺陷**（用户报障）：「codearts 新建账号应该弹出新的页面，现在主页面直接
跳转过去了」正是此因。

- `buddy` / `workbuddy`：`runBuddyLoginFlow` 不 await，立即返回 URL
- `codearts`：`CodeArtsAuth.startLogin()`（`src/service.ts`），底层 `startOAuthFlow`（`src/login.ts`）
- `lobsterai`：`LobsteraiAuth.startLogin()`（`src/lobsterai-auth.ts`），底层 `startLobsteraiLoginFlow`（`src/lobsterai-oauth.ts`）
- `qoder`：`QoderAuth.startLogin()`（`src/qoder-auth.ts`），底层 `startQoderLoginFlow`（`src/qoder-oauth.ts`）—— 它是**设备码轮询**，不起本地回调服务器，故没有端口/超时收尾问题
- `qodercn`：**同一个 `QoderAuth.startLogin()`**，只是实例带 `product: QODER_CN`。
  RPC 侧由 `jet-hub-rpc.ts` 的 `qoderFamily` 注册表分派，`isQoderFamily(provider)`
  命中即走这一条 —— 故**不存在「中国版忘了接」的可能**（这正是改用注册表的目的：
  `workbuddy` 的「刷新」按钮当年就是因为漏接一条平行 case 而一直坏着）
- `trae`：`TraeAuth.startLogin()`（`src/trae-auth.ts`），底层 `startTraeLoginFlow`（`src/trae-oauth.ts`）。默认回调 `http://127.0.0.1:18080/authorize`；该端口被占用时**自动回退到随机端口**（`redirect_uri` 随之重算，服务端原样回跳，故功能不受影响）。登录 URL 需带 `client_id` / `machine_id` / `device_id`

要点：

- 阻塞式 `runOAuthFlow` / `runLobsteraiLoginFlow` / `runTraeLoginFlow` **保留**（CLI、e2e 仍用），
  但它们现在由 `start*` 实现，两条路径的落库逻辑共用 `persistLogin()` ——
  否则两步式会静默缺少续期武装或账号登记
- 两步式路径**没有外层 `try/finally`**，故超时与「结果落定即关闭回调服务器」
  都收在 `start*` 内部，避免泄漏监听端口
- 两步式下 `account.create` 返回时凭据还不存在，**必须**先登记占位账号条目，
  否则前端 `login.poll` 查不到该账号、永远 `done:false`
- 前端**不得**再出现 `window.location.href = loginUrl`：弹窗被拦截时改为展示
  可点击链接（`loginUrlForManual`）。`tests/unit/jet-hub-rpc.spec.ts` 有源码级
  断言锁死这条（剔除注释行后匹配，因注释里保留了该缺陷的叙述）

## 积分领取（每日签到）

### ⚠️ 默认实现的签名必须**显式适配**，不能用 `as unknown as` 硬转

**真实缺陷**（用户报障）：CodeBuddy 一键领取 4 个账号**全部失败**，错误是
**`fetcher is not a function`**。

根因：`claimDailyCheckin` / `fetchCheckinStatus` / `fetchCreditBalance` 的真实
签名是 **`(credential, product, fetcher)`**，而 `CreditsEndpointDeps` 把 `claim`
声明为 `(credential, product, entry)`（TRAE 需要 `entry.id` 取签到设备代次）。
`collectClaimResults` 里历史写法是

```ts
const claim = deps.claim ?? (claimDailyCheckin as unknown as NonNullable<…>)
```

那个 `as unknown as` 把签名不匹配**压了过去** —— TypeScript 不再报错，但调用点
`claim(credential, product, entry)` 的第三个实参是 `entry`，它落进 **`fetcher`
的位置**，运行时 `fetcher(...)` 就抛 `TypeError: fetcher is not a function`。

修法：**显式包装**默认实现，把 `deps.fetcher`（或全局 `fetch`）送进第三参
（`CreditsEndpointDeps.fetcher`）。**加新的默认实现时必须照此办理** ——
一旦用 `as unknown as` 掩盖签名差异，就会重演这个 bug。

⚠️ **为什么长期没被发现**：`makeDeps()` **总是注入 `claim` / `fetchStatus`**，
于是真实的默认实现路径**从未被任何用例覆盖**。回归用例
（`jet-hub-rpc.spec.ts` 的「第三参必须是 fetcher」）刻意**不注入** deps，
走真实默认实现并断言请求真的发出去了。

⚠️ 只有 **buddy / workbuddy** 走这条默认路径（其余三个 provider 都在自己的分支里
显式注入 `claim`），所以故障面恰好是 CodeBuddy 系。

**五套协议完全不同**的实现，各自独立：

**Qoder** —— `src/qoder-credits.ts`（2026-09-21 由 keylog 解密抓包解出）：

- 状态查询：`GET /sash/api/v1/me/campaigns`
  （**必需 Bearer + `Cosy-ClientType:'10'` + `Cosy-MachineToken`/`Cosy-MachineType` 成对**；
  ⚠️ 少了 machine 头只会拿到 1 条 `VIEW_DETAILS`，**看不到可领活动** —— 见上「Qoder 每日领取」）
- 领取：`POST /sash/api/v1/me/campaigns/{campaignId}/claim`（**body 空**）
- 幂等：重复领取返回 **HTTP 200 + `replayed:true`**（且不含 `benefit`、
  `claimedAt` 是旧时间）—— 判定**以响应体 `replayed` 为准**，不能只看 HTTP 状态
- 只领 `actionType === 'CLAIM_BENEFIT' && claimStatus === 'CLAIMABLE'`
- 活动每日 10:00（UTC+8）刷新，领取后 30 天有效

**CodeBuddy** —— `src/credits.ts`（国际版 WorkBuddy 后端无签到接口）：

- 状态查询：`POST /v2/billing/meter/checkin-activity-status`（**不是** `checkin-status`，后者返回全空占位数据）
- 领取：`POST /v2/billing/meter/daily-checkin`
- 幂等：重复领取返回 HTTP 400 + `code:10001`（「今天已签到」），判定**以响应体 code 为准**，不能只看 HTTP 状态
- **不需要** `X-Device-Token`（图灵盾）：实测服务端未强制校验，故不引入 native SDK 依赖

**LobsterAI** —— `src/lobsterai-credits.ts`（三步，见 `lobsterai2api/sigin.py`）：

- 槽位 `GET /api/client-activities/slot` → 上下文 `GET /api/client-activities/{code}/context` → 领取 `POST /api/client-activities/{code}/actions/check_in`
- 幂等是**客户端**保证的：请求带 `idempotencyKey`（UUID4）+ 先读 `claimedToday` / `actions`
- `clientVersion` 是**必填** query 参数，动态拉取（缓存 12h），失败回退 `product.fallbackClientVersion`
- `platform=win32` 等参数是**客户端形态伪装**，非 Windows 上也照发

**CodeArts** —— `src/codearts-credits.ts`（四步，华为云「每日签到得积分」）：

- 账户类型 `GET /snap-manager/v1/statistics/plugin` → 活动列表 `GET /v1/ops/delivery?channel=IDE` → 领取 `POST /v1/ops/claim` `{campaignId, channel:'IDE'}` →（响应 `id !== null` 时）确认 `POST /v1/ops/confirm` `{campaignId}`
- **认证是 `SDK-HMAC-SHA256` 签名**（复用 `src/sign.ts`），base = `https://snap-access.cn-north-4.myhuaweicloud.com`（与 `src/models.ts` 的 `SNAP_MODEL_BUILTIN_URL` **同域**）
- ⚠️ **`Agent-Type` / `X-Language` 必须在签名之后追加，绝不能参与签名**。实测把它们作为 `signRequestHuawei` 的 `extraHeaders` 传入（进入 canonical request 与 SignedHeaders）会得到 `401 APIG.0301 verify ak sk signature fail`；签名后追加则 200 并返回真实数据。正确做法与 `src/models.ts` 的 `fetchSignedGet` 一致（其参数注释写明「签名后追加的头（不参与签名计算）」）。**真实缺陷**：本模块早期误当作签名头，界面显示「积分：账户信息查询失败」。⚠️ 注意 `src/llm-adapter.ts` 的 `maas_type: benefit` 是**反例**——那个头确实需要参与签名，不要据此推断
- ⚠️ **非 2xx 必须带出服务端 `error_code` / `error_msg`**（`describeHttpFailure`）：只报 `HTTP 401` 会让「签名头位置错」「AK 限流（`AK access failed to reach the limit`）」「凭据过期」这些处置方式完全不同的问题看起来一模一样
- ⚠️ **官方文档给的 portal 路径不可用**：`codearts.huaweicloud.com/portal/...` 是 BFF 接口、依赖浏览器 Cookie，实测带 AK/SK 签名也只会返回 IAM 登录跳转 HTML。协议逆向自本机码道 IDE（`out/main.js` 的 `PackageInfoService`、workbench 的 `ActivityWelfarePane`）
- **账户类型检测**：`package.is_credit_package === true` 即积分账户（文档要求「已升级到积分计费模式」）。领取第一步就判它，非积分账户回 `inactive` 而非 `failed`
- **幂等**：本协议无幂等键、无「今天已签到」业务码，唯一保护是活动列表的 `claimable` / `status` 预检（`status` ∈ {CLAIMED, CONFIRMED, CONSUMED} → `already-claimed`）
- ⚠️ **`refresh_token` 一次性轮换**：用一次即作废（`STS5.1806 the refresh token has been used`）。任何刷新都必须**立刻回写**新凭据；E2E 凭据读取（`tests/e2e/codearts-credential.ts`）**只读不刷新**
- `statistics/plugin` 是**裸对象**响应（无 `{code,data}` 包装），而 `ops/*` 有 —— 解析必须兼容两种信封
- ⚠️ **`/v1/ops/delivery` 的字段类型/名字与直觉不符**（实测 2026-09-18，两个坑叠加导致「1 个失败」）：
  - **`campaignId` 是数字**（`1`），不是字符串 → 必须用 `readIdentifier`（兼容数字/字符串），用只收字符串的 `readString` 会得到空串并判 `failed`「活动缺少 campaignId」
  - **可领积分字段是 `benefitAmount`**（`1000`），不是 `amount` → 读错会恒为 0
  - 不可领取的活动 `status` 是 **`null`**（不是字符串），`readString` 要能容忍
  - 完整真实 item 字段：`campaignId` / `title` / `type` / `benefitAmount` / `benefitUnit` / `displayConfig` / `pageUrl` / `claimable` / `hooks` / `extra` / `description` / `status` / `pendingCount` / `pendingTotalAmount`
- ⚠️ **单测必须用真实响应形状**：早期用例喂的是**编造的** `campaignId: 'c-1'` 与 `amount: 1000`，因此完全没抓到上面那个 bug。新用例直接用实测字段集合

**TRAE** —— `src/trae-credits.ts`（两步，字节 TRAE；详见上「TRAE 签到」小节）：

- 状态查询 `POST /trae/api/v2/ug/checkin_credits/status`（body `{}`，读 `checked_in` / `credits` / `enable`）
- 领取 `POST /trae/api/v2/ug/checkin_credits/claim`（body **`{}`**）
- 认证走 **`traeCheckinHeaders`**（`Cloud-IDE-JWT` + 约 20 个客户端头 + **基于 `uid` 派生**的
  `X-Device-Id` / `X-Market-User-Id` / `Vscode-Sessionid`），**不带** SOLO 专属头
  （`X-Ide-Version` / `X-Machine-Id` 等）
- ⚠️ 设备身份**每个账号必须互异**（由 `uid` 确定性派生保证）：同一天两账号共用会被
  「该设备已签到」拦截；为空则报 9004
- 幂等：重复领取返回非零业务码（实测 `9074` 为「签到人数过多」），判定以响应体 `code` 为准
- 失败时经 `classifyTraeCheckinError` 带上 `errorType` / `cooldownSecs`（见上小节的分类表）

四套都遵守的共同约定：

- `credits.claimAll` / `credits.status` **处理该 provider 下的全部账号，含已停用**：停用只影响账号池的自动选择与限流切换，与「该账号今天领了没」无关
- 逐账号**顺序执行**（并发易触发风控），单个账号失败不中断整批
- 返回同一个 `ClaimOutcome` 判别联合，使 `computeClaimSummary` 与前端摘要 UI 两套协议共用

**积分余额（Credits Balance）** 也是**四套端点**，但语义一致（「查不到」与「余额为 0」严格区分）：

**CodeBuddy 系（buddy / workbuddy）** —— `POST /v2/billing/meter/get-user-resource`：

- body `{}`；响应**双层嵌套**：`data.Response.Data.Accounts[]`（签到是单层 `data`，此处最易解析错）
- 总额用各包 `CapacityRemainPrecise` 相加（实测 247.87+100=347.87），**不用**截断过的 `TotalDosage`（347）
- 包名回退链：`PackageName` → `SubProductName` → `PackageCode`
- 该接口**不在 CLI 内核**里（内核只有 `get-dosage-notify`），静态搜索找不到，靠真实凭据实测发现

**LobsterAI** —— `GET /api/user/profile-summary`：

- 取 `data.totalCreditsRemaining`
- **不要**用 `/api/user/quota`：它只有 `freeCreditsTotal=300`，不含活动积分

**CodeArts** —— `GET /snap-manager/v1/statistics/plugin`（与账户类型检测**同一响应**）：

- 取 `metrics[]` 中 `usageTotalPackageCredit` 的 `package_credit_remain`；**不累加**基础/按需/赠送分类明细（它们是总额的构成项，相加会重复计算）
- 非积分账户的文案是「Token 计费账户，无积分余额」而非「查询失败」——账户类型差异不是故障。实现走 `CreditsEndpointDeps.fetchBalanceDetailed` 钩子带回精确原因

**TRAE** —— `POST /trae/api/v2/pay/ide_user_ent_usage`（body **`{"require_usage": true, "req_source": 2}`**）：

- 响应 `user_entitlement_pack_list[]`，每项 `entitlement_base_info.quota.credits_limit` 为额度、`usage.credits_amount` 为已用
- 余额 = `∑(credits_limit - credits_amount)`；`credits_limit <= 0` 的条目跳过（与 Go 端 `EntUsage` 同口径）
- ⚠️ **必须带 `require_usage: true`**：不带时上游不返回 `usage` 明细，`credits_amount` 恒缺省为 0，余额会等于额度总额（虚高）。头同样走 `traeCheckinHeaders`

四者共同的约定：

- 累加后 `roundCredits` 规整两位小数（多包浮点噪声会放大成 655.67000031）
- 失败时 `balance` 为 `null` + `error`，卡片显示原因而非 0
- RPC：`credits.balances`；前端 `AccountCard` 的 `CreditBalanceRow`，面板有「刷新积分」按钮

## 积分能力必须在请求前判定（`credits-capabilities.js`）

`plugin-src/client/credits-capabilities.js` 是「哪个 provider 有哪项积分能力」的**唯一真相源**，两项能力彼此独立、不可互相推断：

| provider | `balance` | `dailyCheckin` |
|---|---|---|
| `codearts` | ✓ | ✓（华为云签名四步流程） |
| `buddy` | ✓ | ✓ |
| `workbuddy` | ✓ | ✗（国际版后端无签到接口） |
| `lobsterai` | ✓ | ✓（`client-activities` 三步流程） |
| `qoder` | ✓（`sash/api/v2/me/usage`，只需 Bearer） | ✓（`sash/api/v1/me/campaigns` → `POST …/{campaignId}/claim`） |
| `trae` | ✓ | ✓（`checkin_credits` 两步流程） |

> ⚠️ `qoder` **必须显式登记**，不能省略：上面那条「能力矩阵与 `PROVIDERS` 条目集合相等」的断言要求两者同步，而 qoder 必然要进 `PROVIDERS`（否则面板不渲染）。
>
> ⚠️ **早期把 qoder 误判为两项皆无**（登记成 `balance:false`），根因有二，都值得记住：
> 1. **只按 `/api/` 前缀搜端点**，而余额挂在 **`/sash/`** 下 → 漏检；
> 2. **误以为用量端点也需要 WASM 签名** —— 实测只需 `Bearer` + `Cosy-ClientType`
>    （**活动端点还额外需要成对的 machine 头**，用量端点则不需要：
>    实测它对这两个头不敏感）。
>
> **余额与签到彼此独立**：不能因为「没有签到接口」就推断「也查不到余额」。

要点：

- **默认关闭**：未登记的 provider 视为两项全无。新增 provider 忘登记时，最坏结果是暂时看不到积分，而不是每次打开面板都发一个必然失败的请求
- **门控在发请求之前**，不是在 UI 上吞错误：`loadCredits` / `claimCredits` 函数内部各有一道守卫（按钮不渲染只是 UI 便利，不是安全边界），`AccountCard` 的积分行与「刷新积分」按钮也按能力渲染
- **历史缺陷**（用户报障）：客户端在面板挂载时对所有 provider 无条件调用 `credits.balances`，当时 CodeArts 无积分能力，面板每次打开都在控制台报 `unsupported provider: codearts`，并把账号卡片的「积分」渲染成「查询失败」。后端 `productById()` 的拒绝是正确契约，不该被当成运行时故障。**门控机制保留至今**，用于挡住真正未登记的 provider
- 改动能力矩阵后必须同步 `PROVIDERS` 列表：`tests/unit/credits-capabilities.spec.ts` 有一条断言锁死两者条目集合相等

## X-Domain 必须跟随产品，而非凭据

`checkinHeaders`（`src/credits.ts`）用 `product.apiDomain` 构造 `X-Domain`，**不优先用 `credential.domain`**。凭据里的 domain 是登录时的快照，跨产品迁移后会留下旧值（早期 workbuddy 指向中国版），跟着它走会让请求的 baseURL 与身份标识自相矛盾。

⚠️ **一律用 `||` 而非 `??`**：domain 经 `readStringField`（`src/buddy.ts`）读取，
字段缺失/类型不符时它返回的是**空串而不是 `undefined`**，`??` 对空串不生效 →
`X-Domain` 以**空值**发出（服务端视作身份缺失，且日志里看不出原因）。
这是 PR!19 定位的共同根因（2026-09-30）。

**四处发 `X-Domain`，判据一致（空串必回退），但「兜底值取谁」按语境分工**：

| 位置 | 表达式 | 为什么 |
|---|---|---|
| `src/credits.ts` `checkinHeaders` | `product.apiDomain \|\| credential.domain \|\| ''` | 凭据 domain 是登录时快照 → **产品优先** |
| `src/buddy-adapter.ts` `send()`（chat 头） | `this.product.apiDomain \|\| credential.domain \|\| ''` | 同上：baseURL 取 `product.endpoint`，两者必须一致 |
| `src/buddy.ts` `credentialRequestHeaders` | `credential.domain \|\| API_DOMAIN` | **凭据级**基础头，调用方 `buddy-oauth.ts`（`refreshToken` / `fetchModels`）随后按产品覆盖 domain 与 UA，此处只需把空串兜回默认域 |
| `src/buddy-oauth.ts` `getAccount`（登录轮询） | `token.domain \|\| product.apiDomain` | 登录流程中该值是服务端**本次刚下发**的权威值（非历史快照）→ 非空时**不被产品覆盖**，只兜空串 |

⚠️ 四处**不是同一判据的四种写法，而是两种语境**（「凭据是历史快照」→ 产品优先；
「登录即时值权威」→ 服务端优先）。改其中任何一处前，先确认它属于哪种语境。
⚠️ 反向验证：把某处的 `||` 改回 `??`（`getAccount` 处改回裸 `token.domain`），
`tests/unit/buddy.spec.ts` / `buddy-adapter.spec.ts` / `buddy-oauth.spec.ts` 里
对应那条「空串」用例立刻变红 —— 故那些用例不是同义反复。

LobsterAI **不适用本条**（它根本不发 `X-Domain`）；其对应约束是「`apiBase` 与 `portalBase` 都是编译期常量，不从凭据推断」。

## ⚠️ Loomy（讯飞）provider：五个不能凭直觉改的点

`loomy` 是第 8 个 provider，与其余七者**都不同源**。实现是独立一套
`src/loomy*.ts`（`loomy-product` / `loomy` / `loomy-sign` / `loomy-oauth` /
`loomy-onboarding` / `loomy-credits` / `loomy-auth` / `loomy-adapter`），
适配器复用 `src/openai-compat.ts`（实测是标准 OpenAI 兼容 + 标准 SSE，与 qoder 同形）。

**真实依据**：2026-09-26 用本机登录态对生产端点逐项实测。
以下五条都有实测证据，**不要按其余 provider 的直觉改**：

1. **两套认证头（最容易踩）**：`/chat/completions` 只认
   `Authorization: Bearer <session>`；`/models`、`/points/*`、
   `/onboarding/*` 只认 `token: <session>`。带错的会得到 HTTP 200 +
   `{"code":"100002","desc":"缺少 token"}` —— 看着像「登录失效」，
   实为头用错了。实测交叉矩阵：

   ```
   GET /points/records  + token  → code=000000
   GET /points/records  + Bearer → code=100002 (缺少 token)
   ```

   `loomyChatHeaders()` 两个都发（官方 `llm-completion.js:149-151` 也如此）。
   ⚠️ `Bearer ` 前缀**必需**：无前缀同样回 `100002`。

2. **没有 refresh 端点，`isLoomyRefreshable()` 恒 `false`**。
   `session` 是登录时声明 `expire: 1209600`（14 天）得来的，凭据里**没有**
   `refresh_token`。故 `refresh()` / `refreshAccountCredential()` 是**有效性探测**
   而非续期（探测走 `GET /points/records?pageSize=1`，只读零消耗），
   `refreshAll()` 只探测**已过期**的账号（避免每 30 分钟白发请求）。
   ⚠️ **不要**为了让 `refreshAll` 有活干而把 `refreshable` 改成 true ——
   那会让 UI 假装能续期，实际每次探测都失败。
   ⚠️ `scheduleRefresh()` / `stop()` 是**有意为之的空实现**：`RefreshScheduler`
   的意义是「过期前 1 小时自动续期」，Loomy 无法续期，武装它只会得到
   「触发 → 探测 → 必然抛错 → 停止」的空转。保留空实现是**契约要求**
   （`index.ts` 对全部 provider 统一调用）。

3. **新手任务服务端不校验前置行为**：直接 `POST /onboarding/tasks/complete`
   （body 仅 `{"key":...}`）即可拿满 10000 分，**零 token 消耗**。
   8 个任务：`first_message` 500 / `pick_skill` 1000 / `generate_ppt` 1500 /
   `set_schedule` 1000 / `install_skill` 1500 / `configure_remote` 1000 /
   `create_soul` 1500 / `share_soul` 2000。
   这与 workbuddy2api-panel 的做法**相反**（那边要模拟真实行为、
   上报埋点事件链）。**不要**「照 workbuddy 那样」去发对话/建定时任务 ——
   那是白花积分。若将来服务端加了校验，再走「用 `qwen3.8-flash`
   （x0.8，全表最便宜）模拟真实动作」的降级路径。
   ⚠️ 幂等判据是响应体的 `alreadyCompleted`，**不是** HTTP 码、**不是** `code`。
   ⚠️ **不采信服务端 `earned`**，按本地 `LOOMY_TASK_POINTS` 现算
   （官方 `onboarding-service.js:177-183` 明说不信任）。

4. **倍率在 `name` 字符串里**，没有独立字段，且三种括号风格混用
   （`MiniMax M3 （x4.0）` 全角带空格 / `Qwen 3.8 Max (x12.0)` 半角 /
   `GLM 5.3 Flash(x0.8)` 半角无空格）。故用 `loomyDisplayName()` 规范化。
   ⚠️ `splitLoomyRate()` **必须同时认两种形态**：远端原值（末尾括号）
   **和**已规范化的 `{name} · x{n}` —— 兜底表（`loomy-product.ts`）存的就是后者。
   早期只认括号形态，于是 `resolveModel` 无法从兜底表名去掉倍率，
   返回 `Spark X2.5 · x0.1` 而非 `Spark X2.5`（实现时暴露的真实缺陷）。
   该函数**幂等**，单测锁死。
   ⚠️ chat 模型过滤判据是 **`type === 'chat'`**，不能看 `input_modalities`
   —— 5 个 chat 模型的输入模态含 `image`（能看图），不是生图模型。

5. **积分是两个池**：永久（`balance`）与每日赠送（`dailyBalance`）分开计算。
   每日额度由 `POST /points/first-login` 触发（官方登录后立即调用），
   语义是**触发额度重置**而非「+5000 积分」：
   实测 `dailyBalance = dailyQuota - dailyConsumed`（4992 = 5000 - 8），
   消耗后不回补。故「一键签到」用 `alreadyProcessed` 判幂等并映射成
   `already-claimed`，**不是** `claimed`。
   ⚠️ **余额查询必须走只读的 `GET /points/records`**，不能用 `first-login`
   —— 后者是**写**端点，在「打开面板」这种高频路径上调用会意外触发签到。
   ⚠️ `dailyQuota` **只在 `first-login` 响应里**，`points/records` 不返回它，
   故未签到时该字段缺省 —— **不要硬编码 5000**（额度可能随活动变化）。

### 短信登录：唯一没有 loginUrl 的 provider

其余 7 个都是「`account.create` 返回 `loginUrl` → 前端 `window.open` →
轮询 `login.poll`」。短信登录**没有 URL 可打开**，故扩展了登录契约：

- `RpcCreateAccountRequest` 加可选 `phone`
- `RpcCreateAccountResponse` 加可选 `loginMode: 'url' | 'sms'`
  ⚠️ **缺省必须视为 `'url'`** —— 既有 7 个 provider 不传该字段，
  行为必须逐字节不变
- 新增 `login.sendSms` / `login.submitSms` 两个端点

⚠️ **msgid 用内存暂存表**（`pendingSmsMsgid`），**不写进 `ctx.credentials`**
—— 它是一次性中间态（5 分钟有效），写凭据会污染命名空间，且它不含任何秘密。

⚠️ **短信登录失败不删占位账号条目**：用户多半只是验证码输错，保留条目让他能重试。

⚠️ **前端短信分支绝不能回退到 `window.location.href`** —— 那会把整个设置页
导航走（与 `createAccount` 的既有约定同因，见「+ 新建账号」章节）。

### 能力矩阵第三项：`onboardingTasks`

```js
loomy: { balance: true, dailyCheckin: true, onboardingTasks: true }
```

⚠️ `onboardingTasks` 与 `dailyCheckin` **语义独立，不能互相推断**：
前者**一次性**（每号只能领一次 10000 分），后者**每天**有收益。
故新手任务有独立按钮与独立端点（`onboarding.status` / `onboarding.claim`），
**不参与**页头「一键签到」遍历 —— 否则每天会对已领完的账号
发 8 个必然 `alreadyCompleted` 的请求。

⚠️ 客户端**不调用** `onboarding.status`：`onboarding.claim` 的响应已带回
`earned`/`total`/逐任务明细，足以渲染进度，再发一次只读查询纯属多余请求。

### 账号卡片：两个积分池分开显示

`CreditBalanceRow` 对「恰好两个包且名字为 `永久积分` / `每日赠送`」的形态
显示 `永久 15000 · 每日 4992`；其余 provider 的多个同类资源包仍显示
「N/M 个资源包有效」。两种形态互斥（`isLoomyTwoPools`）。

### ⚠️ 多账号负载均衡：Loomy **不会**因积分耗尽报错，既有换号机制对它无效

**真实缺陷**（用户报障）：Loomy 会**一直消耗同一个号**，从不触发限流换号。

**根因**（实测 2026-09-26）：今日赠送额度（每天 5000）耗尽后，服务端
**继续扣永久积分且照常返回** —— 「耗尽」是**静默降级**，不是错误。
而本插件既有的换号机制（`getAvailableAccount` 按 `modelRateLimits` 排除账号）
**只在服务端返回限流错误时触发**，故对 Loomy 完全无效。

**修法**：Loomy 用**独立的按余额优先选号**（`src/loomy-balance-rank.ts`
纯函数 + `src/loomy-balance-selector.ts` 带缓存的选择器）：

| 优先级 | 判据 |
|---|---|
| 1 | `dailyBalance > 0`（今日额度每天刷新、不用会浪费） |
| 2 | `permanentBalance > 0` |
| 3 | 其余（含**查询失败**） |

三条**不能改**的约定：

1. **档内保持手动拖拽顺序**，不按余额大小重排（用户明确要求，
   与 `getAvailableAccount` 的既有语义一致）。
2. **查询失败归最后一档**（不是第一档）—— 用户明确要求：
   宁可先用能确认余额的号。
3. **候选先按「未停用 + 该模型未受限」过滤，再按余额分档** ——
   用户明确要求「策略建立在模型没有受限且账户没有被设置为停用的基础上」。
   ⚠️ 故 `resolveCredential` **必须接住并透传 `modelId`**（限流是**按模型**记的）：
   适配器侧 `resolveCredential(modelId?)` → 宿主侧用它过滤
   `a.modelRateLimits[key]`。早期实现传空串 `''`，等于不按模型过滤。

余额查询**带 60 秒 TTL 缓存**（`LOOMY_BALANCE_CACHE_TTL_MS`）：每次选号都实时查
所有账号会显著变慢（N 个账号 = N 次网络往返）。

⚠️ **不要**把 Loomy 塞回 `getAvailableAccount` 的通用逻辑里 —— 那个函数服务
全部 8 个 provider，而「按余额分档」是 Loomy 独有的需求（其他 provider 的
积分模型不同，且多数会返回限流错误）。Loomy 的 `resolveCredential` 自己
`listAccountsByProvider` + 过滤 + 调选择器。

### ⚠️ 锁定永久积分（Loomy 全局开关，**必须持久化**）

**用户需求**：面板上一个开关，锁定后**只允许消耗今日赠送额度**，永久积分不参与
选号 —— 只剩永久积分的账号在锁定期间**等同于不可用**。用户原话：
「锁定永久积分后没有临时积分后找可用账号就是没有可用账号，解锁以后才能再没有
临时积分的时候找到有永久积分的账号」。

实现分三层，**每层都有非显然的约束**：

| 层 | 落点 | 关键约束 |
|---|---|---|
| 纯函数 | `loomy-balance-rank.ts` 的 `LoomyTierOptions.allowPermanent` | 锁定时只剩永久积分的账号落 **`none` 档**（不是降到 permanent 档） |
| 选号 | `loomy-balance-selector.ts` 的 `select(candidates, options)` | ⚠️ 只在**锁定**时把「全部不可用」判成 `undefined`；解锁时**保持既有行为**（全 0 也返回第一个，让上游报余额不足） |
| 宿主 | `index.ts` 的 `resolveCredential` | ⚠️ 锁定时**绝不可落到单凭据兜底** —— 那会绕过锁定照样烧永久积分 |

⚠️ **持久化是本改动最容易出错的地方**：`JetHubState` 由「两字段」变「三字段」，
而**所有写入点都是整体替换**（`writeAccounts` / `writeModels` /
`setLoomyPermanentLocked` / `replaceAll` / `store.save`）。漏带一处，用户的锁就会
被下一次「新增账号」「改模型开关」静默解开 —— 与 `disabledModels` 当年踩过的坑
**完全同型**。`tests/unit/account-pool.spec.ts` 的「Loomy 永久积分锁定」段专门
守着它，且已做**反向验证**（注入「新增账号漏带锁定」时用例会失败）。

⚠️ **缺省必须为「解锁」**：老文档/老备份没有该字段，读到时按 `false` 处理
（与既有行为一致），**不要**因为字段缺失就报错或让整次载入失败。
`replaceAll` 对 `undefined` 的处理是**保持当前值**而不是重置为 false ——
否则导入一份老备份会静默解锁用户的永久积分。

⚠️ **写锁定后要广播 `llm/adapters-updated`**（包 try/catch）：它改变**选号结果**，
与 `model.setDisabled` 同一判据（「这次写入会不会改变 `listModels` 的结果」→
这里换成「会不会改变选号结果」）。通知失败不能反噬已落盘的开关。

### ⚠️ Loomy 没有「模型限流」，故不渲染「重测 / 重置」

**用户报障**：「这个 provider 好像没发现模型限流，把重置所有按钮删掉」。

根因就是上一条：Loomy 积分耗尽时**静默降级**（继续扣永久积分），从不返回限流
错误，故那组按钮对它毫无意义 —— 重测永远测不出限流、还会**白烧积分**。

实现用**独立的能力矩阵** `RATE_LIMIT_CAPABILITIES`
（`plugin-src/client/credits-capabilities.js`），Loomy 显式登记 `rateLimit: false`。

⚠️ **它的默认值与积分能力矩阵相反**：积分能力是「未登记 = 不支持」（避免必然
失败的请求），而限流这里必须是「未登记 = **支持**」—— 那组按钮是**既有 UI**，
若默认关闭，将来新增 provider 忘记登记会让老用户**凭空失去**按钮（可见的功能
回退）。故判据写成 `rateLimit !== false`。

⚠️ 面板级（「重测所有 / 重置所有」）与卡片级（「重测 / 重置」）**都要门控**：
只改面板级会让卡片上仍留着两个永远无效的按钮。

### ⚠️ 思考档位：`resolveModel` **必须声明 `reasoning`**，否则选择器根本不出现

**用户报障**：「loomy ide 中可以设置思考档位，我们现在没法设置」。

**根因与 Qoder 那次完全同型**（见本文件 Qoder 的 2.2 节）：`LoomyAdapter.resolveModel()`
**只声明 `context`，从不声明 `reasoning`**。而 DSH 的思考强度选择器**只会**从
`resolveModel().reasoning` 渲染 —— 故档位选择器**从来没有出现过**，
尽管远端 `GET /models` 早就下发了 `reasoning_efforts`。

⚠️ **判据是「DSH 从哪读档位」，不是「远端有没有给」**：远端给了不等于界面有，
中间少一次声明就全丢。**加任何 provider 时都要检查 `resolveModel` 是否声明了
`reasoning`**（同理还有 `context` / `inputModalities`）。

**用户要求「如果能从远端得到配置中直接生成是最好的」—— 已照此实现**：

| 项 | 来源 | 规则 |
|---|---|---|
| `efforts` | 远端 `reasoning_efforts` | **原样取用**（服务端下发的就是展示顺序） |
| `defaultEffort` | ⚠️ **本插件自己的 `high`** | **不采信远端的 `low`**（见下） |
| 中文展示名 | 本文件 `LOOMY_EFFORT_NAMES` | `none:关闭思考 low:低 medium:中 high:高 xhigh:极高` |

实测 8 个 chat 模型**完全一致**：`['none','low','medium','high','xhigh']`。
远端还带 `reasoning_catalog_version`（catalog 哈希），故档位随服务端更新、**无需改代码**。
兜底表（`loomy-product.ts`）存同一份实测值，只在远端整体失败时顶替 ——
⚠️ **抽成 `LOOMY_EFFORTS` 常量而不是逐条写 8 遍**，避免上游变更时漏改其中几条。

⚠️⚠️ **默认档用本插件自己的 `high`，有意不采信远端的 `low`**（用户要求，2026-09-28）：
> 我们档位默认用远端的几档，默认值用自己的高

**依据是 DSH 的取值逻辑**（`dsh-client-ui-model-selection/lib/client.js:512`）：
```js
const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
```
即「用户没选时发哪个档」**完全由适配器声明的 `defaultEffort` 决定**，
沿用远端的 `low` 会让默认思考偏浅。
常量在 `loomy-adapter.ts` 的 `LOOMY_PREFERRED_DEFAULT_EFFORT`，
兜底表的 `LOOMY_DEFAULT_EFFORT` **必须与它一致** ——
否则「远端可用 / 远端失败」两条路径的默认档会不同。

⚠️ **仍必须做 `efforts.includes(high)` 校验**：DSH 会拿 `defaultEffort`
**直接发请求**，某模型若不提供 `high`（远端目录变化时真会发生），
必须**不下发默认档**（退回 DSH 的「服务商默认」语义），而不是发一个非法值
（会抛 `UNSUPPORTED_REASONING_EFFORT`）。

⚠️ **`defaultEffort` 不落在 `efforts` 内时不能下发**：DSH 会拿它**直接发请求**，
给一个不存在的档位会抛 `UNSUPPORTED_REASONING_EFFORT`，比不给更糟。

⚠️ **请求体字段名是 `reasoning_effort`**（与远端声明的复数形式同源，也与 OpenAI 标准
及本插件其余适配器一致）。⚠️ **不能靠 HTTP 状态码判断字段是否生效**：实测传
`reasoning_effort` / `reasoningEffort` / `thinking` **三种都返回 200** —— 服务端对
未知字段**静默忽略**（与「无效模型名回退默认模型」同一模式）。故字段名的依据是
**远端自己的命名**，而非「试出来能通」。

⚠️ **下发前必须校验档位在该模型的 `efforts` 内**（DSH 会把用户选的值直接透传）：
越界时**静默不下发**（退回服务端默认档），而不是发一个可能被拒的值。

⚠️ **实测「关闭思考」并不会真的消除思考内容**（`reasoning_effort:'none'` 仍返回
`reasoning_content`，`reasoning_tokens` 与基准相当）。**这是服务端行为，不是我们的
bug** —— 用户已明确接受（「设置关闭思考实际思考了可以接受」）。
同理 `xhigh` 也**不会**显著增加思考量，但**它是安全的**：实测 HTTP 200、
无流内错误帧、`finish_reason=stop` 未截断（用户关注点：「设置 xhigh 最大思考
如果出问题就不好了」）。

⚠️ **验证这类字段必须用流式**：第一版用**非流式 + 难题**，结果**连基准都 504**
（非流式长思考撞网关超时）—— 那是超时，不是档位问题。DSH 走流式，故探针也须流式。
且**不能用「思考字数」当唯一判据**：简单题目的思考量本来就小，各档差异淹没在噪声里。

排查脚本与取证命令**见不入库的 `docs/loomy-protocol-notes.md`**
（本文档不放脚本清单）。回归用例在 `tests/unit/loomy-adapter.spec.ts` 的
「LoomyAdapter 思考档位」段（9 条）与「请求体里的 reasoning_effort」段（4 条）。
⚠️ 已做**反向验证**：去掉 `resolveModel` 里那两行声明 → **5 条变红**。

### ⚠️ AccessKey 明文入库（用户明确同意）

`src/loomy-product.ts` 内含从 Loomy 客户端解密得到的讯飞账号 AccessKey。
它**只用于讯飞账号端点**（`account.xfinfr.com` 的登录签名），与业务/推理端点无关
（后者用用户登录后的 `session`），故泄露不涉及任何用户数据。

⚠️ **具体值、解密算法与口令、脚本清单见不入库的
`docs/loomy-protocol-notes.md`** —— 不要把它们写进 README / AGENTS.md。

### 新增 provider 时的位置参数陷阱（本次踩过）

`registerJetHubRpc` 与 `registerJetHubEndpoints` 的 auth 实例是**位置参数**。
新增 Loomy 时，三个既有测试因把参数列表写死而假失败：

- `tests/unit/qoder-wiring.spec.ts`（正则只允许一个 provider 插在 trae 后）
- `tests/unit/cline-adapter.spec.ts`（`toContain` 写死整串）
- `tests/unit/jet-hub-rpc.spec.ts`（9 个 `{}` 占位，新签名要 10 个 →
  `modelAdapters` 错位落到 `loomy` 形参上）

三处已改为**对 provider 数量中立**的断言（`[\w, ]*` / 显式补占位并注明原因）。
**再加 provider 时请沿用这种写法**，不要写死整串。

⚠️ 加 Raccoon（第 9 个）时**又踩了一次**：`tests/unit/jet-hub-rpc.spec.ts` 里
三处 `registerJetHubRpc(...)` 调用只补到 `loomy`，于是 `raccoon` 形参收到
`undefined`、`modelAdapters` **错位**落到 `raccoon` 上 → `model.list` 的
「关闭的模型仍显示倍率」用例假失败（表现为「展示名退化成裸 id」）。
`tests/unit/loomy-wiring.spec.ts` 的正则也因写死 `cline, loomy, modelAdapters`
而假失败。两处都已改为对 provider 数量中立的写法。
**教训**：新增 provider 后，`grep -n 'registerJetHubRpc(' tests/` 把**每一处**
调用点都补上占位，别只改报错的那一处。

---

## ⚠️ Raccoon Work（商汤小浣熊）provider：不能凭直觉改的点

`raccoon` 是第 9 个 provider。实现是独立一套 `src/raccoon*.ts`
（`raccoon-product` / `raccoon` / `raccoon-oauth` / `raccoon-qr` /
`raccoon-login-page` / `raccoon-credits` / `raccoon-auth` / `raccoon-adapter`），
适配器复用 `src/openai-compat.ts`（与 qoder / loomy 同形）。

**真实依据**：2026-09-26 对生产端点逐项实测 + 客户端 `app.asar` 逆向
（工具 `scripts/raccoon-asar.mjs`）。

### 1. 官方登录链路**不可复用**，微信扫码才是可行路径

官方桌面端（`build/electron/main/desktopLogin.js`）走
「网页授权 → `office-raccoon://auth/callback?code=` →
`POST /login_with_authorization_code`」。

⚠️ **本插件收不到那个自定义协议回调**（宿主侧 Node 进程），
且 `/code/authorize` 页面的回调地址**写死在 Web bundle 里**
（`hl()` 直接 `new URL("office-raccoon://auth/callback")`），改不成 localhost。

**可行路径**：二维码的 `code` 由**客户端本地随机生成**
（`CryptoJS.lib.WordArray.random(16)` → 32 位 hex），服务端只做轮询查询。
⚠️ **实测任意自造 code 都被接受**并进入 `pending`：

```
POST /api/web/auth/v1/login_with_qrcode_code  {"qrcode_code":"1790405291292abcdef123456"}
→ 200 {"code":0,"message":"success","data":{"status":"pending"}}
```

状态机：`pending` → `logging`（带 `expired_at`）→ `success`（带
`access_token`/`refresh_token`）/ `canceled`。轮询间隔 **2000ms**。

### 2. 手机号必须 AES-128-CFB 加密；短信强制阿里云滑块

算法（渲染层模块 68284 的 `yv()`）：

```
key   = UTF8("senseraccoon2023")  → 16 字节 ⇒ AES-128
iv    = 随机 16 字节
mode  = CFB, padding = NoPadding
输出  = Base64(iv ‖ ciphertext)
```

⚠️ 必须**显式**写 `aes-128-cfb`：密钥 16 字节，写成 `aes-256-cfb` 会因长度
不足而抛错（不会自动补齐）。
⚠️ 填充语义已实测：CFB 是流密码，`setAutoPadding(true/false)` 输出**完全一致**
（11 字节手机号两种设置下密文都是 11 字节）—— 不必纠结。
⚠️ 错误码区分：明文/加密错 → `100003 params_encryted_error`；
加密格式对但号码非法 → `100002 params_invalid_error`。
⚠️ **`send_sms` 强制阿里云滑块**（`100006 captcha_verify_error`，
`SceneId=1pkmy0x3`、`prefix=hk1r5l`，脚本
`https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js`）。
已核实该脚本**无域名白名单校验**（扫 `document.domain`/`referer`/`origin`/
`whitelist` 均无命中，唯一 `document.domain` 命中是 core-js 的 iframe polyfill），
故本地页可以真实加载它。

### 2.5 ⚠️ **1 倍倍率也必须显示**（不要省略成无后缀）

**真实缺陷**（用户报障）：「为什么 Kimi-K3 没有倍率，ide 是 1 倍，1 倍也要显示倍率」。

`raccoonDisplayName` 早期有一条 `if (effective === 1) return name` ——
按「1 倍是默认，显示属噪声」省略了它。后果是**用户无法区分两种情形**：

- 该模型**本来就是 1 倍**（`billing_effective_multiplier === 1`）；
- 我们**没取到它的倍率**（字段缺失 → `Number.NaN` → 不加后缀）。

两者在列表里看起来一模一样（都只有模型名）。IDE 的模型选择器对 `Kimi-K3`
显示「1 倍」，故本插件对齐：**一律显示 `x生效价`**。

⚠️ **`NaN` / 负数仍然不加后缀**（那才是真正「取不到」的情形）——
不要把这两条合并成一条「1 倍或缺失都不显示」。

⚠️ 同理适用于**兜底表**：`raccoon-product.ts` 里 `sn-kimi-k3` 的
`name` 必须写 `'Kimi-K3 · x1'`，不能写 `'Kimi-K3'`
（兜底表与 `raccoonDisplayName` 的输出形态必须一致，否则远端/回退两条路径
显示不同）。

回归用例：`tests/unit/raccoon.spec.ts` 的「倍率恒为 1 时也要显示」、
`tests/unit/raccoon-product.spec.ts` 的兜底表断言、
`tests/e2e/raccoon-probe.e2e.spec.ts` 的远端实测断言。

### 3. ⚠️ 每日 300 积分**没有端点**，不要实现签到按钮

实测「每日积分发放」是**服务端按日自动发放**的（账单
`biz_type: 'daily_grant'`；该账号 13:30 注册、13:31 即到账）。
**不存在可调用的签到接口**。

故能力矩阵是 `{ balance: true, onboardingTasks: true }`，
**不登记 `dailyCheckin`** —— 登记了会让「一键签到」按钮每次点击都必然失败
（与 CodeArts 早期「对不支持的 provider 无条件发请求」同类）。

⚠️ 同时**不要**把 `login/points/grant` 当作每日签到：它是**幂等一次性**的
（已领过返回 `granted:false`，账单里能看到上一次记录），
第二天再点只会继续拿到 `granted:false`，与「签到」文案不符。

⚠️ 三个来源必须分清：

| 来源 | 金额 | 触发 |
|---|---|---|
| 新人注册礼包 | 3000 | 注册时服务端自动发放（`biz_type: reward_grant`） |
| **桌面端登录奖励** | 3000 | `POST /api/web/desktop/v1/login/points/grant` |
| 每日积分发放 | 300 | **服务端按日自动发放** |

⚠️ 判定「登录奖励是否已领」**不能只按 `biz_type === 'reward_grant'`**
（注册礼包也是它），必须同时匹配 `event_name === '桌面端登录奖励'`。
服务端**没有单独的奖励状态端点**，只能查 `GET /points/v1/bills` 明细
（`fetchRaccoonOnboardingStatus`）。

### 4. 零客户端依赖（硬约束，有测试守住）

⚠️ **运行时绝不读客户端数据**。理由（均为实测）：

1. 客户端**退出时删除** `~/.box-agent/config/auth.json`；
2. 客户端**每次重启都轮换整组凭据** —— 实测从
   `%APPDATA%\office-raccoon\Local Storage\leveldb` 提取的 `access_token`
   在 `exp` **尚未到期**（剩余 5859s）时就被 `401 200003` 拒绝，
   对照进程启动时间可确认是重启导致的轮换；
3. 用户可能**根本没装客户端**。

由 `tests/unit/raccoon-client-independence.spec.ts`（**源码扫描式**回归防线）
守住：禁止 `src/raccoon*.ts` 出现客户端路径（`raccoon-ai` / `office-raccoon` /
`box-agent`）、环境变量（`APPDATA`/`LOCALAPPDATA`）、文件读取
（`readFileSync`/`node:fs`）、以及 `leveldb`/`sqlite` 引用。

⚠️ **为什么用源码扫描而不是 mock**：这类约束的失效方式恰恰是
「某次改动悄悄加了一个 `readFileSync` 兜底」，mock 测不出来。

⚠️ 注释里解释「为何不这么做」是允许且鼓励的（扫描前会剥掉注释行）。

客户端安装目录仅用于**逆向取证**与**构建期图标提取**，都不是运行时依赖：

- `scripts/raccoon-asar.mjs`（只读探查，协议升级时用它重新核对）
- `scripts/extract-raccoon-icon.mjs`（**不入库**，见下）

### 5. 二维码是自己实现的，且**必须编码成真 PNG**

仓库**没有任何 QR 依赖**（已核实 `node_modules` 与 DSH 的 `node_modules`），
故 `src/raccoon-qr.ts` 自行实现（byte 模式 + 纠错等级 M + 版本 1–10，
约 550 行，含 GF(256) RS 纠错、zigzag 放置、8 掩码评分）。

⚠️ **两条真实教训**：

1. **结构测试全过 ≠ 二维码可用**。早期 14 个用例（finder 位置、尺寸、
   确定性）全部通过，但实际扫不出来。**判据必须是「与独立实现交叉验证」
   或「真实解码器能解出」** —— 本次用 Python `qrcode` + `segno` 双实现
   交叉确认，再用 **OpenCV `QRCodeDetector` 真实解码**验证
   （4 个用例含 144 字节登录 URL 全部还原正确）。
2. **登录页内联 SVG 时绝不能转义引号**。`renderRaccoonLoginPage` 早期把
   SVG 的 `"` 转成 `&quot;` 再注入 HTML，浏览器把它当**文本节点**而不渲染
   —— 用户报障「弹出页面二维码没显示出来」。
   ⚠️ 而当时的断言 `toContain('viewBox')` 在**有 bug 时也通过**
   （`viewBox=&quot;0 0 …&quot;` 同样含子串 `viewBox`），故缺陷从未被抓住。
   现断言要求「无 `&quot;`」+「合法 `<svg …>` 标签」+「path 段数 > 100」。

⚠️ `buildQrMatrix` 的 `options.mask` 参数**仅用于诊断与交叉验证**
（生产路径不传，走自动评分）—— 但它必须真的生效，
`tests/unit/raccoon-qr.spec.ts` 锁死了「8 个掩码产出各不相同」。

### 6. 过期判定必须回退解析 JWT（修过的真实缺陷）

`raccoonCredentialExpiresAtMs` 取值优先级是
**`expires_at` → JWT 的 `exp`**。

⚠️ 早期只读 `expires_at`，而它是**可选字段**（老凭据/手工导入可能没有）
→ 过期判定**恒为 false** → `refreshAll` 永远跳过这些账号
→ 表现为「凭据悄悄过期、续期从不触发」，与「续期按 `enabled` 过滤」
那次缺陷是同一类（**静默失效，无任何报错**）。
`tests/unit/raccoon.spec.ts` 有针对性回归。

### 7. 图标：从官方 1024×1024 提取，且**必须编码成 PNG**

来源 `C:\Program Files\raccoon-ai\resources\assets\icon.png`（1024×1024）。

⚠️ **不用 exe 内嵌图标**：实测 `ExtractAssociatedIcon` 与
`new Icon(exe, 64, 64)` 都只拿到 **32×32**（资源组里没有更大尺寸），
缩到 20×20 会糊。

⚠️ **真实缺陷**：`scripts/extract-raccoon-icon.mjs` 起初把**裸 RGBA 缓冲**
直接 base64 当 PNG 用 —— 产出字符串长度正常（12310 字符）、
`toContain('data:image/png;base64')` 也通过，但**不是合法 PNG**，
浏览器渲染不出来（图标位置一片空白）。改用 `encodePng()` 编码
（base64 从 12310 降到 2978）。
判据见 `tests/unit/raccoon-client-panel.spec.ts`：
**PNG 签名 `89504e470d0a1a0a` + IHDR 尺寸 + 非全透明**。
⚠️ 注意：该图标的 base64 **以大片 `AAAA` 开头**（顶部透明行全 0 字节），
目视很像空图但**数据正常** —— 故判据不能靠目视。

### 8. Raccoon-Auto 不是远端模型，**不要暴露**

它是客户端 i18n 条目（`modelPicker.auto` = `"Raccoon-Auto"`，
`modelPicker.autoMultiplier` = `"1 倍"`）渲染的**「自动选模」入口**，
**不在 `model_catalog` 里** —— 直接发给 `chat/completions` 会 404。

其真实语义由客户端 `resolveAutoCatalogModel()` 实现：按消息内容正则打标
（`TASK_TAG_PATTERNS` 识别 vision/code/analysis/office…）后按
`ability_level` 与 `context_window` 从候选池选真实模型；
候选池判据 `isTemporaryAutoRoutingModel()` 认 `raccoon-*` 前缀
或**含 `deepseek`**，故 `sn-deepseek-v4-1-flash` 也在其中。

**不实现的三条理由**：① DSH 的模型选择是**会话级固定**的，而 IDE 是
**按每条消息动态**选模，语义不匹配；② 复现需移植整张正则表，且选出的模型
**不可预测**、难排查；③ `ability_level`/`tags` 是客户端 UI 偏好，
不构成服务端契约，随时可能变。

**替代**：用户可直接选 `sn-deepseek-v4-1-flash`（`ability_level: 3`、
带 `auto` 标签，即复杂任务下自动选模最可能选中的那个）。

### 9. 工具调用：`tools` 必须真下发（Qoder/TRAE 的同型坑）

⚠️ 适配器把 `options.tools` 映射成 OpenAI 的
`{type:'function', function:{name, description?, parameters?}}`
写入请求体**顶层 `tools`**。

⚠️ **判据是「响应里有结构化 `tool_calls`」**，不是「模型在正文里说它想调用
工具」—— 后者正是 Qoder（WASM 把 `tools` 硬编码 `[]`）与 TRAE 踩过的形态：
模型拿不到函数 schema，只能用**正文里的 XML 文本**臆造，harness 认不出 → 任务终止。

⚠️ **间接证据（不是直接验证）**：桌面端 `model-profiles.json` 指向本端点，
且其背后的 agent 运行时 `box-agent-acp.exe` 内含 `tool_choice`（37 次命中）与
`function_call`（15 次命中）及完整 `openai.types.*` 类型表
—— 说明它构造的是带 tools 的 OpenAI 请求体。

⚠️ **本项的正式判据在 `pnpm test:e2e:raccoon-tools`**（双重闸门，
发真实请求验证）。实现期因客户端凭据被轮换而**未能完成真机实测**
（见设计文档 §12）—— 若该探针报「未返回 tool_calls」，
**不要**改用「system prompt 注入 + 正文 XML 解析」的回退方案。

### 10. 短信登录的 `nation_code` 初版只做 86

客户端下拉有 86/852/853/81。插件初版**只做 86（大陆）**，
因为 `100002 params_invalid_error: param phone invalid` **无法区分**
「号码格式错」与「该区号不支持」，不做未验证的猜测。

### e2e 探针

```
pnpm test:e2e:raccoon        # 只读：凭据/模型目录/倍率/积分余额/账单，零消耗
pnpm test:e2e:raccoon-chat   # ⚠️ 发推理：标准 OpenAI SSE + reasoning_content 形态
pnpm test:e2e:raccoon-tools  # ⚠️ 发推理：**tools 是否被接受**（第 9 条的正式判据）
```

### ⚠️ 报错文案：`400` 与 `401` 的语义

- `401 200003 authorization_verify_error` —— 凭据失效。
  ⚠️ 排查时**先确认客户端是否刚重启过**：那会轮换 leveldb 里的凭据，
  让人误以为是端点或协议问题。
- `400 100006 captcha_verify_error` —— 滑块过期，需重新过验证。
- `400 100002 params_invalid_error` —— 手机号格式或验证码错。
- `400 100003 params_encryted_error` —— 手机号**未加密**或加密格式不对。

---

## ⚠️ MiniMax Code（中国版）provider：不能凭直觉改的点

`minimax` 是**第 10 个、也是首个 `Anthropic Messages` 协议族**的 provider
（其余九个都是 OpenAI 兼容族或各自的自定义协议）。生产环境
`https://agent.minimax.cn`。实现是独立一套 `src/minimax*.ts`。

### 1. ⚠️ `pending` 是 **HTTP 200**，不是 OAuth 标准的 400

设备码轮询里，服务端用 **HTTP 200 + `status: "pending"`** 表达「用户还没完成授权」；
而标准 OAuth 是「非 200 + `error=authorization_pending`」。**两种形态都要认**。

⚠️ **只看 HTTP 状态码会把「还在等你点授权」误判成「拿到 token 了」** ——
实测表现为 `令牌响应缺少 access_token`。这与 Qoder「404 表示尚未授权、
必须继续轮询」是同类坑（**别把非标准形态当错误**）。

### 2. ⚠️ 模型目录**必须走远端**，不能照抄客户端内置表

客户端 `config.js` 的内置表**只有 3 个**（`MiniMax-M3` /
`MiniMax-M2.7-highspeed` / `MiniMax-M2.7`），而远端
`GET /mavis/api/v1/models?region=cn&buildEnv=prod` 有 **4 个** ——
**照抄内置表会漏掉 `MiniMax-M3.1-Flash-Preview`**，而它正是客户端界面上
被选中的那个（用户截图证据）。

**判据**：目录走远端；远端失败时才回退兜底表（`minimaxFallbackEntries`）。

### 3. ⚠️ 只有 `MiniMax-M3.1-Flash-Preview` 有思考档位

其余三个远端条目**没有 `effort_options` 字段** —— 这是**远端事实，不是我们漏解析**。
故 `resolveModel` 对它们**不声明 `reasoning`**（`minimaxReasoningInfo` 返回
`undefined`）。与 Qoder 的 `qmodel`「只有关闭思考」是同一类事实：
**远端没给就是没有，不要补猜测的默认值。**

⚠️ 档位展示名直接用**远端原文**（`name === id`），不做本地化。
⚠️ 窗口口径是**档位表最大档**（M3.1 / M3 → 1M；M2.7 系 → 200K），
**不是**目录里的 `max_input_tokens`（Qoder 那条已证伪的口径，别再犯）。

### 4. ⚠️ `timezone_id` 是 **query 参数**，且放错位置**也是 HTTP 200**

签到端点：
```
GET  /minimax-cloud/api/v1/signin/status?timezone_id=<IANA>
POST /minimax-cloud/api/v1/signin/claim?timezone_id=<IANA>   # body {}
```
⚠️ 放到**请求头**会回 `1406010011 invalid timezone_id` —— 而且**那也是 HTTP 200**。
故「HTTP 200 = 成功」在这里**不成立**，必须查业务码
（`base_resp.status_code`，**不是** `code`）。

### 5. ⚠️ `points` 是**总数**，`bonus_points` **含在其中**，**不得相加**

实测第 1 天 `points: 800` / `bonus_points: 400`：客户端按钮显示「签到得 **800**」、
右上角另有「额外 400」角标 —— 即 `bonus_points` 是 `points` 的**子集**，
不是额外加量。

⇒ `dailyCredit === points`（**800**），**不是** `points + bonus_points`（1200）。
相加会让展示金额**虚高一倍**（用户 2026-09-28 亲自纠正）。

### 6. ⚠️ 幂等判据是 `claim_result`，**不是 HTTP 状态码**

`claim_result`：`1` = 真领取、`2` = 已领过。**重复领取同样返回 200**。
故 `claim_result` 缺失 / `null` / 越界 / 字符串时一律判 `failed`，
**绝不虚报成功**（虚报会让用户以为 +了积分，实际 +0 ——
与 TRAE「显示成功但 +0」是同一类报障）。

⚠️ 另：**今日已领的判据是 `is_today && status === 3`**，**不是**「没有 Claimable」
—— 后者会把「服务端没下发数据」误报成「今天已领」（Qoder 踩过同款）。

### 7. ⚠️ 积分余额端点是**平铺响应**，且 `details` 会整个缺失

`GET /minimax-cloud/api/v1/credit/details` 的 `total_count` 与 `base_resp` **同级、
没有 `data` 键** —— 与签到端点的信封结构**不同**。实现用 `unwrapEnvelopeData`
兼容两种形状（否则会撞上「缺 `data` 即判失败」的守卫，把**「余额为 0」
报成「查询失败」**）。

⚠️ **空明细时 `details` 字段整个缺失**；解析必须容忍。本机实测
`total_count: 0` 且无 `details` —— 那是**有效结果**（「真的为 0」），
与「查询失败」（`null`）是两回事，**不要合并**。

### 7.1 ⚠️⚠️ 余额取 `details[].remaining_amount`，**`total_count` 是记录条数**（2026-09-29 修复的真实缺陷）

初版写成 `total = total_count` —— **错的**。`total_count` 是 `details[]` 的
**记录条数**，真实余额是各包 `remaining_amount` 之和。

实测原始响应（本机领取 800 积分后，2026-09-29）：
```json
{"details":[{"remaining_amount":"800.00","consumed_amount":"0.00",
             "granted_amount":"800.00","credit_type":2,
             "granted_at_ms":1790645562328,"expire_at_ms":1793203200000}],
 "total_count":1,"base_resp":{"status_code":0,"status_msg":"ok"}}
```
余额是 **800**，`total_count` 是 **1** —— 用户界面会显示「1 积分」。

⚠️⚠️ **为什么初版与单测都没发现（这个坑的形态值得记住）**：
账号余额为 0 时 `details` **整个缺失**、`total_count` 恰好也是 **0**
—— 「条数 0」与「余额 0」在数值上**偶然重合**。于是
「`total_count: 0` → `total: 0`」那条单测是**同义反复**，
它**只能证明「0 还是 0」**，无法区分两个语义。
⇒ **领取积分后才分叉**（条数 1 / 余额 800），缺陷才暴露。

**教训具有普遍性**：当「错误的字段」与「正确的字段」在**已知样本上取值相同**时，
任何断言都是同义反复。⇒ **必须构造让两者分叉的样本**
（本例：一条 800 的记录 ⇒ 期望 800 而非 1）。这正是 Task 8「反向验证」要解决的
问题，但反向验证**只能证明既有用例有判别力**，证明不了「用例覆盖了正确的语义」
—— 后者需要**让错误实现产生不同数值**的样本。

⚠️ **`remaining_amount` 是字符串**（`"800.00"`），而 `finiteNumber` 只认 number
⇒ 必须用宽容解析（数字与字符串都接受，见 `looseAmount`）。
⚠️ `Number('')` **是 0** ⇒ 空串必须**先挡掉**，否则「缺字段」会被误读成
「0 积分」（与「不编造 0」的既有铁律冲突）。
⚠️ `expiredTotal` 仍为 0、`packages` 留空：`details[]` 没有区分「本周期有效」的
标志（`credit_type` 语义**未实测**），**不凭猜测分类**。

### 8. 推理：**Anthropic Messages** 协议（已实测启用，2026-09-29）

`POST {apiHost}/mavis/api/v1/llm/v1/messages`（`stream: true`）。
实现分两块：`src/minimax-messages.ts`（请求体构造 + SSE 消费）与
`src/minimax-adapter.ts` 的 `stream()`。

⚠️ **不要复用 `openai-compat.ts`**：那是 OpenAI 形状，硬套会把
`tools` / `tool_calls` / `input_json_delta` 全部翻译错。
⚠️ 也**不做**「通用 Anthropic 层」抽象 —— 只有一个消费者，
抽象是凭空多一层间接（Qoder 的教训是「同族第二个产品出现时再抽」）。

#### 8.1 ⚠️⚠️ 思考档位：**两种能力**，M3.1 与 M3 完全不同

远端 `thinking_config.mode` 有三种值（**不是**只看 `effort_options`）：

| 模型 | mode | effort_options | 实测行为 | 我方声明 |
|---|---|---|---|---|
| M3.1-Flash-Preview | `forced_on` | ✅ `default/low/medium/high/xhigh/max` | 传 disabled ⇒ **硬 400** | 6 档（默认 `default`） |
| **M3** | **`switchable`** | ❌ 无 | **不发 ⇒ 不思考**；adaptive ⇒ 2785+ 字符 | `on` + `none` |
| M2.7 / M2.7-highspeed | `forced_on` | ❌ 无 | 传 disabled ⇒ **静默忽略** | 不声明 |

**M3.1 必须 adaptive**（服务端原话，实测 HTTP 400）：
```
{"type":"error","error":{"type":"invalid_request_error",
 "message":"invalid params, model \"MiniMax-M3.1-Flash-Preview\" requires
  adaptive thinking; thinking.type=\"disabled\" (including
  reasoning.effort=none) is not allowed (2013)"}}
```

⚠️⚠️ **M3 必须给「开启」档，不能只给「关闭」**（真实功能缺口，2026-09-29 修复）：
实测 M3 **不发 `thinking` 时默认「不思考」**（两轮各 0 字符），
而 `adaptive` 有 **2785 / 2797** 字符。初版只看了 `effort_options`（M3 没有）
⇒ 声明成「无推理等级」⇒ 用户**既不能开也不能关**；
我第二版只加 `none` ⇒ **只能关、无法开**（把模型强项藏起来了）。

⇒ 取客户端**权威词汇**（`thinking.js` 的 `isMiniMaxM3ThinkingMode`：
`value === 'on' || value === 'off'`）声明 **`['on','none']`**
（`on`→`adaptive`、`none`→`disabled`；`off` 在 DSH 侧的惯用名是 `none`）。
⚠️ **不设 `defaultEffort`**（M3 无 `default_effort`）⇒ 保持服务端默认（=不思考），
**不擅自**设成 `on`（那会改变用户既有行为）。

⚠️ **`forced_on` 的模型绝不追加开关**：M3.1 会硬 400、M2.7 被静默忽略
—— 「给了选项却空转」比「不给」更糟（用户以为关掉了、实际没关）。

⚠️ **展示名**：远端档位用原文（官方 IDE 就是 `default`/`low`/…），
但 `on`/`none` 是**我们追加**的，给中文「开启思考」/「关闭思考」。

⚠️ **档位真的生效**（实测同一难题）：M3.1 `low`=572 / `medium`=1181 /
`max`=1297 字符 ⇒ **不是空转**。故断言必须比较**不同档位的思考量**，
不能只断言「HTTP 200」。

⚠️ **测档位要用需要推理的问题**：问「只回复两个字：收到」时
adaptive 与 none **都是 0 思考字符**（模型根本不思考）⇒ 断言退化成同义反复
（我第一版探针就这么假红过）。

⚠️ **`readImage` / contextWindow 与用户 IDE 截图的对应**：
IDE 的「上下文窗口 512K / 1M」是 **IDE 自己的**多档选择；
DSH 的 `LlmModelContext` **只有单一 `contextWindow` 字段**，本身不支持多档
⇒ 按用户 2026-09-29 的指示「不用档位直接用最大的」取 **1M**。
⚠️ 用户「看不到档位」的**真实原因**是**插件未登录**（凭据里无 `MINIMAX_*`
⇒ `providerCatalogVisible` 为假 ⇒ `listModels` 返回空 ⇒ DSH 隐藏整个 provider），
**不是档位没实现**。排障时先查登录态。

#### 8.2 ⚠️ 图片：**必须** Anthropic 形状（真机实测）

```json
{ "type":"image", "source":{"type":"base64","media_type":"image/png","data":"<裸base64>"} }
```
- ⚠️ OpenAI 的 `image_url` 被服务端**明确拒绝**：
  `400 ... messages.0.content.0: unsupported content type 'image_url' (2013)`
- ⚠️ `data` 是**裸 base64**（无 `data:` 前缀）
- ⚠️ 实测：**1×1 的 PNG 会被拒**（`400 invalid params`，**无细节**）；
  40×40 起正常。真实截图远大于此，不影响使用 ——
  但**排障时别用 1×1 图**（会得到一个毫无线索的 400）
- ⚠️ 可与 `thinking:{type:'adaptive'}` 共存、`text` 在 `image` 前后均可
- 实测：M3.1 / M3 都能识图（自造纯红 PNG ⇒ 答「红色」）

⚠️ **判据是「模型真的看到了图」，不是「HTTP 200」**（后者在静默丢图时也通过）。
⚠️ **但不要断言精确颜色**：实测同一张纯色图 M3.1 答过「灰色和暗红色」、
M3 答过「绿色」/「红色」—— 那是**模型自身识图质量**，与序列化无关；
硬匹配会让探针随机假红。断言应取「**不是**拒答」+「含颜色词」。
⚠️ **消息体的图读不到 ⇒ 抛错**（用户显式意图）；**工具结果里的图读不到 ⇒ 跳过**
（工具结果本身仍有价值）—— 有意区别对待。
⚠️ 声明不支持图片的模型收到图片 ⇒ **报错**，不能发出去让服务端 400。

#### 8.3 SSE 帧形状与三个必须保留的细节

`message_start` → `ping` → `content_block_start` → `content_block_delta` →
`content_block_stop` → `message_delta` → `message_stop`。

- ⚠️ **`signature_delta` 必须忽略**（thinking 块的签名）。当正文处理会往回答里
  注入一串十六进制。
- ⚠️ **`thinking` 块映射成 `reasoning` 块**，否则思考内容污染正文。
- ⚠️ **`thinking_tokens` 是 `output_tokens` 的「子集」**（实测两者都可能是 64），
  映射到 `reasoningTokens`，**不累加**到 outputTokens。
- ⚠️ **错误走 `event: error`**（`{type:'error', error:{type,message}}`），
  不是 OpenAI 的 `{error:{message}}` —— **必须抛错**，否则重演 Qoder
  「干净地停止、无任何报错」。

#### 8.3 ⚠️ 工具调用是 Anthropic 形状，**没有 `role:'tool'`**

- assistant 的 `tool-call` → `tool_use`（**`input` 是对象**，不是 JSON 字符串）；
- 工具结果 → **user 消息**里的 `tool_result` 块（`tool_use_id`）。
- ⚠️ 参数是残缺 JSON 时退化 `{}`，但**块必须保留** —— 丢了会让后续
  `tool_result` 变孤儿块、服务端 400。
- ⚠️ 历史里的 `reasoning` 块**不回传**：Anthropic 要求 thinking 带签名，
  我们不持久化签名 ⇒ 回传会被拒。丢弃思考历史是安全的。
- ⚠️ **判据是「结构化 `tool-call` 块」**，不是「模型在正文里说它想调工具」
  —— 后者正是 Qoder/TRAE 踩过的缺陷形态（插件没发 `tools`，
  模型只能用正文 XML 臆造，harness 认不出 → 任务终止）。

#### 8.4 ⚠️ 402 必须归 `QUOTA_EXCEEDED`，不能归 `SERVER`/`AUTH`

余额不足是最常见的真实失败，归错会让用户看不到「去充值」这个**唯一有效动作**。

#### 8.5 ⚠️ 未实现：图片（**显式抛错**，不静默丢弃）

`M3.1` / `M3` 目录条目声明 `supportsImage`（用于 `inputModalities` 播报），
但**带图请求未实测**，故序列化遇到 image 块**显式抛错**。
静默丢弃会让用户以为图片被模型看到了。

#### 8.6 ⚠️ 单测抓到的真实缺陷：截断流丢失最后一帧

原 `consumeMinimaxSse` 只在 `while (!done)` 里按行处理，`split('\n')` 后
`pop()` 的尾巴留在 `buffer` 等下一轮 —— 但**流结束时没有下一轮**，
于是最后一条事件（正是携带 `stop_reason` 与 `usage` 的 `message_delta`）
**永远被丢弃**。

真实 SSE 大多以空行结尾，恰好掩盖了它；**截断的流**才暴露，且症状极隐蔽：
`max_tokens` 被误报成 `stop`、`usage` 永远是 0 —— **不报错、不中断，只是数字错**。

⇒ 修法：把行处理抽成嵌套生成器 `processLine`，收尾时先 `decoder.decode()`
刷出残留多字节，再把 `buffer` 余量**按整行**走一遍同一套逻辑。
⚠️ 同时**空行要重置 `eventName`**（它是 SSE 的事件终止符；提到循环外后
不重置会让上一条事件的 `event:` 名残留到下一条 `data:` 上）。
回归用例 4 条，反向验证过（去掉收尾冲刷 ⇒ 4 条变红）。

### 9. 能力矩阵与 e2e

```js
minimax: { balance: true, dailyCheckin: true }
```
余额与每日签到**都有**（与 raccoon 只有 `onboardingTasks` 不同）。

```
pnpm test:e2e:minimax        # 只读：目录/签到状态/余额；**绝不领取**
pnpm test:e2e:minimax-claim  # ⚠️ **真实领取**当日积分（消耗当天唯一一次机会）
pnpm test:e2e:minimax-chat   # ⚠️ 发推理（真实适配器；默认 M2.7，会消耗额度）
```

⚠️ `minimax-chat` 的断言是「**取到非空文本 + finish 正确**」与
「工具调用返回**结构化** `tool-call` 块」—— 不是「请求返回 200」。
后者在「模型什么都没说」时也会通过（那正是要防的形态）。
⚠️ 默认只测 **M2.7**（用户 2026-09-29 指定：每天有免费额度）；
`DSH_MINIMAX_CHAT_E2E_ALL=1` 才测全部四个模型。

⚠️ 只读/领取探针读的是 **MiniMax Code 客户端自己的登录态**
（`~/.minimax/auth/prod/cn/mcode-public/auth.json`），**不是**本插件的凭据存储
—— 该 provider 尚未在任何机器上完成过插件登录。

⚠️ **token 过期时探针自动 skip，绝不代客户端续期**：MiniMax 的 refresh
可能轮换 `refresh_token`，若我们刷一次却不写回客户端文件，用户的客户端登录态
就会被弄坏。实测过期 token 打只读端点返回 **HTTP 401 `invalid access token`**。

### 10. ⚠️ `registerJetHubRpc` 的位置参数陷阱（**第 5 次复发**）

`registerJetHubRpc` 是长**位置**参数列表（**12 个 auth** + `modelAdapters`，
顺序：`codearts, buddy, workbuddy, lobsterai, qoder, qoderCn, trae, cline,
loomy, raccoon, minimax, zcode`）。
新增 provider 时**必须**在 `tests/unit/jet-hub-rpc.spec.ts` 的调用点补占位，
否则 `modelAdapters` 会**错位**落到最后一个 auth 形参上。

**已复发五次**：加 Loomy、加 Raccoon、加 QoderCN、加 MiniMax、**加 ZCode
（2026-09-30 合并上游时一次插了两个 provider，第 5 次）**。
测试注释里逐字预言过这个坑。

⚠️⚠️ **第 5 次的关键差别：这是「合并」引发的，`git` 全程不报冲突。**
上游把 `minimax` / `zcode` 插在 `raccoon` 之后，`jet-hub-rpc.spec.ts` 的
`provider.status` 那处调用点没跟上 → `modelAdapters` 落到 `minimax` 形参上、
真正的位置收到 `undefined` → 实现退化成套黑名单的 `ctx.llm.listModels()`。
症状与第 4 次**同型但报错位置不同**：三条用例断言
`{ total, disabled }` 时实际拿到 **`{ total: 0, disabled: 0 }`**
（不是渲染问题，是**目录读不到**）。
⇒ **合并任何新增 provider 的上游改动后，必须重跑 `jet-hub-rpc.spec.ts` 的
`provider.status` 组，不能以「git 没报冲突」判定合并没有语义问题。**
排查脚本可离线复查全部调用点的实参对齐（剥注释后逐个数形参，
本机实践：Windows 下别用内联 `node -e`，PowerShell 会吃掉引号/反引号，
写成 `.mjs` 文件再跑）。

⚠️ **另一个格式陷阱**：`registerJetHubRpc` 的**调用**必须保持**单行**
（`... raccoon, minimax, zcode, modelAdapters)`）。拆成多行（哪怕只加尾随逗号）
会让 `qoder-wiring.spec.ts` / `raccoon-wiring.spec.ts` 的正则失配而失败。

⚠️ **根治方向**（尚未做）：把它改成**具名参数对象**（`{ auth: {...}, modelAdapters }`）。
已复发五次说明「靠注释提醒补占位」不足以防住 —— 但那是独立重构，
需要同时改 `src/index.ts` 与全部测试调用点，不要顺手做。

## ⚠️ ZCode（智谱）provider：「卡住 + 停止按钮无效」的两个根因（真实缺陷，2026-09-29）

**用户报障原文**：

> zcode 执行任务会卡住……显示「**深度求索中，用时 5分27秒...**」，
> 还没有继续输出推理或者思考……此时**停止按钮点击都没反应**，
> 我重启后才能让这个任务停止。

### 一、先记住这条判据：日志里的收尾事件可能是**伪造的**

排查时**不要**看到 `turn/end{kind:'interrupted'}` 就以为「turn 正常结束过」。
`dsh-session` 的 `openTurnClosers()`（`lib/types/repair.js`）会在加载会话时给
**打开的 turn** 补一份合成收尾，并且**复用最后一个真实事件的时间戳**
（原文：*"The last real event supplies the seq base and the timestamp for the
synthetic closers"*）。

⇒ **判据：`step/end` 与 `step/start` 同一毫秒 + `turn/end{kind:'interrupted'}`**
= 那不是真收尾，**这个 turn 从未结束**（适配器的 generator 挂在某个 `await` 上）。

本机实测三次（全是 `zcode/GLM-5.3-Flash`）：

| 会话 | `step/start` | 最后一个真实事件 | 无输出时长 |
|---|---|---|---|
| `session-a77ed457` | 17:20:57.353 | 17:38:14.442 | **1018.7 秒**（用户看到的「5分27秒」正在其中） |
| `session-fe7a9979` | 20:00:25.179 | 20:00:25.179（即 start 本身） | 直到重启宿主 |
| `session-2271311d` | 20:10:59.738 | 20:10:59.738 | 直到切换模型 |

### 二、根因 A（本次直接原因）：流式读取阶段**既无超时、也失了中断通道**

`src/zcode-adapter.ts` 旧实现把清理放在 **`fetch` 的 `finally`** 里 ——
那个 `finally` 在「响应头一到」就执行：

```ts
try { response = await this.fetchImpl(..., { signal: controller.signal }) }
finally {
  clearTimeout(timer)                                    // ← 流还没读，超时就被清了
  options.signal?.removeEventListener('abort', onAbort)  // ← 中断通道也被摘了
}
yield* consumeAnthropicSse(response.body, ...)           // ← 这一段无超时、无中断
```

而 `src/zcode-anthropic.ts` 的 `iterateSseFrames` 里是裸的
`await reader.read()`，且 `finally` 只有 `releaseLock()`。

⇒ 上游（免费通道首字节实测有 20 秒以上长尾，也会整段静默）一旦不吐数据：
`read()` 永远挂着、**`abort` 唤不醒它**、180 秒的 `requestTimeoutMs` 形同虚设、
用户点「停止」也到不了 controller —— **只能重启宿主**。

**修法**（三处，缺一不可）：

1. `iterateSseFrames(body, { signal })`：abort 时**主动 `reader.cancel()`**
   （取消底层流会让挂起的 `read()` 立刻以 `{done:true}` 收尾，这是**唯一**能唤醒
   它的手段）；循环顶部再判一次 `aborted` 兜底。
2. `finally` 里**先 `await reader.cancel()` 再 `releaseLock()`** ——
   `releaseLock()` **不关闭底层流**，上游连接会继续生成并**白扣额度**。
3. `zcode-adapter.ts`：把超时/中断的作用域提升到**整轮**
   （`stream()` 负责建 `AbortController` + 计时器，`streamScoped()` 干活），
   并把 `controller.signal` 一路传进 SSE 消费；超时收尾抛 **`TIMEOUT`**
   （可重试），**但用户中断必须原样上抛**（否则用户主动取消会被白重试）。

⚠️ 可作对照的实现：`D:\jet\code\js\dsh-free-glm\src\adapter.ts` 早已修过同型三处
（[L1897-1900](file:///D:/jet/code/js/dsh-free-glm/src/adapter.ts) 清理覆盖全流程、
[L712-729](file:///D:/jet/code/js/dsh-free-glm/src/adapter.ts) 把超时 signal 传进 SSE、
[L921-948](file:///D:/jet/code/js/dsh-free-glm/src/adapter.ts) `cancel()` 再 `releaseLock()`），
注释原文就是「**`abort` 不会唤醒 `reader.read()`**」「超时失去全部作用，请求可无限挂起」。

### 三、根因 B（同型的第二颗雷）：captcha 侧有无超时的等待，且失败后**把闸门焊死**

`src/zcode-captcha.ts`：

| 位置 | 旧行为 | 后果 |
|---|---|---|
| `acquirePage` 取页 | `while (this.pageBusy) await sleep(50)` —— **无上限、不看 signal** | 一旦标志没被复位就**永久自旋** |
| `acquirePage` 建连 | `await new Promise(... ws 'open' ...)` —— **无超时** | Chromium 僵死时 `open`/`error` 都不来 ⇒ 永久挂起 |
| `acquirePage` 建页 | `await browser.send('Target.createTarget')` 在 try **之外** | CDP 抛错后 `pageBusy` 不复位 |
| `mint()` 的 `finally` | `if (this.reusablePage === page) this.releasePage(page)` | catch 里已 `discardPage()` 把 `reusablePage` 置空 ⇒ 条件**恒为假** ⇒ `pageBusy` **永不复位** |

最后一条是**致命**的：它让「一次 captcha 失败」升级成「此后每次 mint 都死锁」——
adapter 的 `await this.mintCaptcha()` 永不返回，请求根本不发出，UI 永远「深度求索中」。

**修法**：取页自旋加 `pageWaitTimeoutMs`（默认 30s）+ 判 signal；建连加
`connectTimeoutMs`（默认 10s）；`createTarget` 包进 try；`mint()` 的 `finally`
改成 **`else this.pageBusy = false`**（无条件复位）；`mint(config, { signal })`
与 `ZcodeAuth.mintCaptcha` / `index.ts` 的注入点**逐层透传 signal**。

⚠️ 超时**不**复位别人的 `pageBusy`（此刻它属于另一个持有者，越权复位会让两个
mint 共用同一页面 —— captcha 是一次性的，必串状态）。

### 四、回归用例与**反向验证**

`tests/unit/zcode-stream-hang.spec.ts`（8 条，全部毫秒级、零网络、零额度）：

| 用例 | 反向验证（改回旧行为 ⇒ 变红） |
|---|---|
| abort 唤醒挂起的 read | 去掉 abort→`cancel` 注册 ⇒ **红**（挂到用例超时） |
| 中断必须真的 cancel 底层流 | 同上 ⇒ 红 |
| 消费方 `break` 时必须取消底层流 | 去掉 `finally` 的 `reader.cancel()` ⇒ 红（仅此条红） |
| 200 + 整段静默 ⇒ `TIMEOUT` | 不把 signal 传进 SSE 消费 ⇒ **红（挂 5s 超时）** |
| 用户中断**不得**翻译成 `TIMEOUT` | 同上 ⇒ 红 |
| 取页等待有上限 | 去掉 deadline 判定 ⇒ **红（挂 5s 超时）** |
| `mintOnPage` 失败后 `pageBusy` 必须复位 | `finally` 改回条件式 ⇒ 红 |

⚠️ 写这类用例时**判据是「在有限时间内结束」**：唤醒/超时/复位任一失效，
用例呈**挂起直到 vitest 超时**，而不是干脆的断言失败 —— 那正是线上那条路径的形状。

### 五、其它必须记住的点

- **两次 checkout 都要改**：`D:\jet\code\js\dsh-codearts` 与
  `D:\jet\code\js\deepseek-harness-codearts` 是同一插件的两份链接目录，而
  `~/.dsh/profiles/web/pnpm-lock.yaml` link 的是**后者**（GUI 加载它）、
  `desktop` 用前者。改完两份 `src/` 都要 `pnpm build:all`，且**必须重启宿主**才生效。
- `requestTimeoutMs`（`zcode-product.ts`，180s）现在**覆盖整轮**（含 captcha 与流读取），
  不再是「只到响应头」。
- captcha 每请求现 mint（约 1.2 秒）**不是**本次卡住的原因：卡住前后的请求都正常，
  且 17:20 那次卡死后 19:59 的 zcode 请求又成功了 —— 若是 `pageBusy` 死锁，
  后续请求会**全部**一起卡。⇒ 别把 `imageUrls`/captcha 配额当成第一嫌疑人。

---

## ⚠️ ZCode 上游节流三件套（吸收自 `dsh-free-glm`，2026-09-30）

**起因**：`dsh-free-glm` 的作者指出我们的瓶颈是「每请求 +1.2s captcha」。
核对后确认：**这不仅对，而且还有第二处更大的漏算**（见第 4 条）。
本次把那边已验证的三套机制搬了过来，并顺手补上了 prompt caching 断点。

### 一、captcha **预取池**（`src/captcha-pool.ts`）

**要解决的问题**：`zcode-captcha.ts` 实测「页面空闲 <8s 复用约 0.5 秒，
更久（实测 15s 必 `F001`）要**新建页面约 3.7 秒**」，而 agent 多步循环的
两步间隔**通常大于 8 秒** ⇒ 现产路径几乎每步都付建页面的钱。

**关键依据（那边的实测，决定了「能提前产」这件事成立）**：

| 生成后经过 | 使用结果 |
|---|---|
| 0 / 10 / 30 / 60 秒 | ✅ 可用 |
| 120 秒 | ❌ 3007 |

⇒ 「一次性」只指**用一次就作废**，**不指必须立刻用**。

**实现要点（三条都是那边记过的坑）**：

1. **现产之后也要补池**。少了它，首次请求现产后池永远空，优化形同虚设。
2. **取走即补下一个**（不 await，不阻塞本次请求）。
3. **预取要 inflight 去重**，否则每轮请求都叠一个预取，白耗 captcha 配额。
4. ⚠ **`hasFresh()` 必须只读**（本次写单测时实测到的缺陷）：初版实现成
   「调一次 `takeFresh()` 看结果」，而 `takeFresh()` 会清空池 ——
   于是**看一眼就把预取好的 param 丢掉了**，池在诊断代码路过时静默失效。
   修法：拆出 `peekFresh()`（只判不删）+ `takeFresh()`（删）。

**开关**：`DSH_ZCODE_CAPTCHA_POOL=0` 关闭（关闭后与引入池之前逐字一致）；
`DSH_ZCODE_CAPTCHA_POOL_TTL_MS` 调 TTL（默认 **30 秒** —— 比那边的 45 秒保守，
因为**我们没有复测过**这个窗口，且两边的产出路径不同：它走壳内 renderer，
我们走普通 Chromium CDP。若实测无 3007 可放宽）。

**回归**：`tests/unit/captcha-pool.spec.ts`（9 条）。
反向验证：删掉 `take()` 里现产后的 `prefetch()` ⇒ 第 1 条变红。

### 二、上游**发车闸门**（`src/model-gate.ts`）

**依据（那边分模型实测）**：`429` 里的 `3009 model concurrency limit exceeded`
是**并发配额**（撞它时 token 还剩 299.4 万），且两个模型窗口明显不同：

```
GLM-5.3-Flash  605 次 200    0 次限流      ← 从未撞过
GLM-5.3         74 次 200   21 次重试     6 次最终 429
```

⇒ **串行**（不重叠）+ **按模型最小间隔**（不挨太近）。加了之后 `3009` 21 → 1 次。
参数落在 `zcode-product.ts`（`serializeUpstream` / `modelGapMs`：
`glm-5.3` 350ms、`glm-5.3-flash` 0），**不要在适配器里写死**。

⚠ **闸门只包 fetch，不包 captcha**：那边第一版把 mint 一起放进闸门，
`mintMs` 从 200-500ms 暴涨到 **2500-3100ms**（变成「排在 N 个人后面再 mint」）。

⚠ 与 `model-queue.ts` 分工不同：那个管**服务端指定的**排队时长（`10605`），
这个管**客户端自保**的发车节流。

**回归**：`tests/unit/model-gate.spec.ts`（8 条，含「等待期间中断必须生效」——
否则前面某个请求挂住会把后面全部拖死）。

### 三、额度用尽 / 无权益 → **标记 + 切号**

**两种 429 的处置必须分开**（`isZcodeConcurrencyLimited` / `isZcodeQuotaExhausted`）：

| 形态 | 判据 | 处置 |
|---|---|---|
| 并发限流 | `3009` | **退避重试**（`ZCODE.concurrencyRetryMax`=2，1500ms 线性退避），**不换号、不标记** |
| 额度用尽 | `1005 exceed quota limit` / `1113 余额不足` | **标记该账号+该模型到 UTC+8 当日 24:00**，换下一个账号重发 |
| 无权益 | **秒回空**（`EMPTY_RESPONSE` 且耗时 < `ZCODE_FAST_EMPTY_MS`=3 秒） | 同上（换号） |
| 链路卡住 | 慢回空（≈180s） | 重试 / 排查，**不换号**（换号解决不了） |

⚠ **`isZcodeQuotaExhausted` 必须先排除 `3009`** —— 否则会把一个完全可用的账号
误标成「当日用尽」（与 qoder 那次「把 rate_limit 当 billing」同型）。

⚠ **重试前必须重新 mint captcha**（一次性，沿用旧的必 `3007`）：
实现上把 `mintCaptcha()` 放在**内层循环第一行**，天然满足。

⚠ **`emitted` 闸**：一旦已向调用方 yield 过内容，就不许再切号/重试
（否则用户看到两份输出）。HTTP 层错误与空响应都发生在输出之前，不受此限。

⚠ **切号三件事**（与 `qoder-adapter.ts` 同因，缺一即空转）：
① 标记用的是**局部可变**的 `activeAccountId`（不是回调，回调切号后不跟着变）；
② 取号必须传 `tried`（池按手动顺序返回，刚失败的账号可能仍排第一）；
③ `tried` 跨重试保留。回调由 `index.ts` 的 `activeZcodeAccountId` 提供，
在 `resolveCredential` 里记录**实际返回的那个账号**。

⚠ 无法再切时抛 **`QUOTA_EXCEEDED`**（**不在** harness 的
`DEFAULT_RETRYABLE_CODES` 里）—— 不能落 `SERVER`，否则「今日额度已用尽」
这种确定性错误会被白退避重试 5 次（约 15.5 秒）。

**回归**：`tests/unit/zcode-throttle.spec.ts`（13 条：5 条纯函数 + 8 条行为，
含「3009 不标记账号」「秒回空切号」「已产出内容后不切号」「tried 传下去」）。

### 四、**prompt caching 断点**（本次额外发现的更大瓶颈）

**用户反馈**：`dsh-free-glm` 的作者说我们「每请求 +1.2s」。
captcha 只解释**一部分**；下面这条解释**每一步**的开销：

`toAnthropicTools()` **从不产出 `cache_control`**，而 `system` 此前**每块都打**
（3-4 块）—— 正好用满 Anthropic「单请求最多 4 个断点」的预算，
于是 `tools` 再也打不了点。而 DSH 每步带 24 个工具、约 19KB schema
（那边 P0-2 的实测原文），**每步全量重算这段 prefill**。

**修法（两处）**：

1. `zcode-identity.ts`：system **只在最后一块**打断点。前缀式缓存语义下，
   一个位于末块的断点**覆盖面等于（不小于）**每块各打一个；
   且「调用方 system（DSH 的 AGENTS.md，本仓库数十 KB）必须落在断点内」——
   只打末块天然满足。
2. `zcode-adapter.ts` 的 `withToolCacheBreakpoint()`：给**最后一个** tool 打断点
   （前缀式 ⇒ 覆盖「system + 全部 tools」整段）。总断点数 = 2 ≤ 4。

⚠ **不影响准入**：3012 的判据是身份块的**内容与结构**存在，
`cache_control` 只是缓存提示。用例断言了「断点总数 ≤ 4」。

**回归**：`tests/unit/zcode.spec.ts` 的「只在最后一块打 cache_control」等 3 条 +
`zcode-throttle.spec.ts` 的「tools 断点真的进了请求体」。

### 五、额度用尽时**必须说出真实原因**（用户报障，2026-10-01）

**用户看到的原文**：

> 本轮运行失败　`zcode: 模型返回了空响应（无任何 text / thinking / tool 内容）`
> `EMPTY_RESPONSE`　（并伴随「已重试模型请求 (5/5)」）

**两处都不对**：

| 项 | 问题 |
|---|---|
| **文案** | 说的是**现象**（没收到内容），没说**原因**（额度用尽）—— 用户无从判断该等额度、换模型还是加账号 |
| **错误码** | `EMPTY_RESPONSE` **在** harness 的 `DEFAULT_RETRYABLE_CODES` 里 ⇒ 这种**确定性**错误被白退避重试 5 次（约 15.5 秒，即截图里的 5/5） |

⚠ **这与 qoder「110 额度错误落 `SERVER`」是同型缺陷**：
**用错误码的默认归类代替了对业务语义的判断**（本文件 qoder 章节记过该教训）。

**上游为什么回「空」而不是报错**：额度耗尽时请求**根本没送达模型**
（对照那边的实测：`provider runtime headers` 请求从未出现），网关直接回
**HTTP 200 + 空内容** —— 所以它**看起来**像空响应，实际是权益问题。

**最可惜的地方：判据本来就是现成的**。`isFastEntitlementMiss()` 早就实现了
「**秒回空**（<3s）= 该账号对该模型无权益」（依据：150-200ms 空响应
vs 卡住形态的 ≈180000ms），但它此前**只用于决定「要不要切号」**，
判据本身从未进入文案 —— 于是「无法再切号」那一步抛出的还是通用裸错误。

**修法（`zcode-adapter.ts`）**：「秒回空」且**无法再切号**时 → 抛
`zcodeEntitlementErrorMessage()` 的文案 + **`QUOTA_EXCEEDED`**
（不在可重试集合里 ⇒ 立即失败）。

⚠ **文案措辞必须诚实**：不断言是「额度用尽」还是「无权益」—— 两者在 wire 上
**表现完全相同**（都是秒回空），我们**无法区分**。故写
「额度已用尽或没有可用权益」并给出两种都能解决的建议。

⚠ **不得在 `zcode-anthropic.ts` 的 SSE 层做这个分类**：那一层**拿不到耗时上下文**
（它不知道自己跑了多久），若在那里武断报「额度用尽」，**慢回空**那条路径
（链路故障，该重试）就会被误报成「换账号」。故该层保留通用文案与可重试的
`EMPTY_RESPONSE`，**分类交给适配器**（它持有 `consumeStartedAt`）。

**回归**：`tests/unit/zcode-throttle.spec.ts` 的
「额度用尽：文案必须说出真实原因、错误码必须不可重试」段（3 条：
无账号池时抛 `QUOTA_EXCEEDED` + 文案含真实原因且**不含**那句通用文案 +
慢回空不得被误判 + 多账号时才提账号数）。
反向验证：把错误码改回 `EMPTY_RESPONSE` ⇒ 第 1 条变红。

### ⚠ 改完这些要做的两件事（同 zcode 其它改动）

1. **两份 checkout 都要同步**（`D:\jet\code\js\dsh-codearts` 与
   `D:\jet\code\js\deepseek-harness-codearts`），并各自 `pnpm build:all`。
2. **必须重启宿主**才生效（插件模块在进程启动时读进内存）。

### 六、会话实证：额度耗尽 + **两个插件抢同一份 captcha 信誉**（2026-10-01）

**用户报障**：zcode 赠送额度用完后，界面报通用的「空响应」；并追问
「我们哪里设置 zcode 保活频率的？用我们的 zcode 执行任务后用 dsh-free-glm
执行会碰到错误，似乎我们保活频率太高了」。

#### 6.1 先纠正一个归属：那条 `503 降级冷却` **不是我们抛的**

用户贴的截图里的文案是 **`zcode-bridge:`** 开头 + 「降级冷却 / 连续 5 次失败 /
约 233 秒后可重试」。两处都对得上 **dsh-free-glm 的桥**：

- 前缀：我们的 provider 报错一律是 `zcode: `；`zcode-bridge:` 是它的 `PROVIDER` 名。
- 逻辑：`mintBackoffUntilMs` + `noteMintFailure()` + 指数冷却、出口在
  `dsh-free-glm/patches/zcodeBridgeServer.ts:3151`。

⚠ **顺带回答「滑块要在哪做」**：必须在**开源版实例窗口**里做。
dsh-free-glm 的桥只认源码检出的 `packages/desktop`（`appDirCandidates()`），
官方闭源版起不来桥 ⇒ 闭源版窗口**永远不会弹**它那个验证。
且**冷却期内桥直接返回 503、连 mint 都不发起**（`mintBackoffRemainingMs() > 0`），
所以要在**冷却结束后**主动发一次对话才会弹滑块。

#### 6.2 但用户的方向**成立**：确实在抢同一份设备信誉

**关键证据（两个 session，同一台机器，时间相差约 1 分钟）**：

| session | provider | 现象 |
|---|---|---|
| `session-eced01ed` | **`zcode`（我方）** | 14:26:53 起连续 **12 次**空响应失败（6 请求 × 2 turn），每次重试**都重新 mint 一个 captcha** |
| `session-b0e4eb3f` | **`zcode-bridge`（dsh-free-glm）** | 开局第 1 步就报 **`502 Failed to mint auth material`** |

⇒ captcha 信誉是**设备级**的（不是按插件算），我们多产的每个 captcha
都在消耗它的额度。**两个都开着就是在互相抢。**

⚠ **排查可复现**：会话内容在 `~/.dsh/sessions/<工作目录编码>/<session>/session.v4.jsonl.zstd`，
用 Node 内置 `zlib.zstdDecompressSync` 解压（**无需装 zstd**）。
字段是 `e.type` / `e.time` / `e.data`，**不是** `kind`/`timestamp` —— 我第一版按
猜的字段名取时间线，全部取到空值。

#### 6.3 修了什么（三处）

**① 空响应必须说出真实原因**（见上一节）：秒回空 → `QUOTA_EXCEEDED`
+ 「额度已用尽或没有可用权益」。

⚠ **判据用耗时是可行的，但要看对指标**：会话实测**单次请求耗时仅 125ms**
（`step/start 14:26:53.069` → `attempt .194`），命中 3 秒阈值。
⚠ 我一度把「重试间隔 6.858s」误当成「单次耗时」而以为修复失效 ——
**重试间隔 ≠ 单次请求耗时**，两者在日志里长得像（都是相邻 attempt 的时间差）。
`step/start → assistant/attempt` 的差才是单次耗时。

**② HTTP `body === null` 分支也是同一缺口**（本轮新发现）：

| 形态 | 分支 | 原先 |
|---|---|---|
| 200 + 空 SSE 流（0 帧） | `consumeAnthropicSse` 的 `!sawAny` | ① 已覆盖 |
| 200 + **`body === null`** | `zcode-adapter.ts` 的 `response.body === null` | ❌ 抛裸 `EMPTY_RESPONSE` |

后者**跳过整个 SSE 消费** ⇒ 哪怕 ① 修好，走这条路的用户仍看到通用文案
且白重试。现已同样改为「先换账号，换不动就 `QUOTA_EXCEEDED` + 真实文案」。

**③ captcha 产出失败退避**（`src/captcha-backoff.ts`，**本轮最重要**）：

此前我们**完全没有**这个机制 —— 额度耗尽时连 mint 12 个 captcha。
现按那边的做法（阈值 3、首次 1 分钟、指数翻倍、上限 30 分钟）加闸门：
连续产出失败达阈值后**直接抛错、不再发起 mint**。
那边的原话：「**继续请求不会让信誉恢复，只会更糟**」。

- ⚠ **`steps` 必须用 `streak - threshold`**：用 `streak` 会让第 3 次失败
  直接等到 `base × 8`（8 分钟），与「起步 1 分钟」的语义相反（用例守住了）。
- ⚠ 冷却到点**只清冷却、不清 `streak`**：否则退避重新从 1 分钟起步，
  达不到「指数」效果。
- ⚠ **只对「产出失败」计数**（`mintOnPage` 抛错），不对「上游回 `3007`」计数 ——
  后者归因不清（可能是服务端抖动），记成我们的信誉问题会误伤。
- ⚠ 闸门放在 `mintCaptcha` 的**取池之前**：这样池的 `prefetch()` 后台路径
  天然也被挡住，**不需要池自己判断退避**。
- 关闭：`DSH_ZCODE_CAPTCHA_BACKOFF=0`。

**回归**：`tests/unit/captcha-backoff.spec.ts`（7 条）+
`zcode-throttle.spec.ts` 新增 2 条（HTTP 空 body 的文案与换账号）。
反向验证：去掉 `remainingMs()` 的到点清零 ⇒ 「冷却到点后恢复」变红。

#### 6.4 仍未做的两件事（需要用户拍板）

1. **captcha 预取池默认值**：它让 mint 次数**翻倍**（每请求 1 次 + 后台预取 1 次），
   是**唯一主动加倍**信誉消耗的改动。在信誉紧张的设备上是净负面。
   建议把 `enabled` 默认值反转为 `false`（保留实现与开关）。
   ⚠ **已实测存在跨插件干扰，但未实测「预取池是否是压垮信誉的那一下」** ——
   不要把它当成已证结论。
2. **持久化 captcha profile**：我们每次 `mkdtempSync` 新建临时 profile
   （`zcode-captcha.ts:547`），而 dsh-free-glm 用 ZCode 实例的长期 profile
   ⇒ 它的信誉能跨会话累积，我们不能。**但阿里云的信誉究竟按 IP、
   按指纹还是两者加权，没有实测过** —— 若是按指纹，独立 profile 反而
   保护了对方的信誉（各算各的）；若是按 IP，我们就是在直接抢。**结论未定，勿凭推断动手。**

### 七、官方 ZCode 的 captcha 护栏（逆向 `app.asar` 实证，2026-10-01）

**起因**：用户追问「zcode 如果每一步都认证一样也会碰到上限吧，是否它不是
每步都用一个 captcha」。⇒ 去逆向**官方闭源版**安装目录核实。

#### 7.1 怎么读的（可复现）

官方安装版是 Electron 打包产物，源码在 `app.asar`（312 MB）：

```
C:\Users\Jet\AppData\Local\Programs\ZCode\resources\app.asar
```

⚠ **两个读取要点**（都踩过）：
1. asar 头是 `[u32=4][u32 headerSize][u32 jsonSize][u32 jsonStrSize]`，
   JSON 表从 **offset 16** 开始、长度 `headerSize - 8`。
2. ⚠ **JSON 表尾部有填充字节**，直接 `JSON.parse` 会报
   `Unexpected non-whitespace character after JSON` —— 必须
   `s.slice(0, s.lastIndexOf('}') + 1)` 再 parse。
3. 数据区起点 = `16 + jsonLen`；每个文件的 `offset` 是**相对数据区**的。

captcha 代码在 `/out/renderer/assets/styles-*.js`（5.8 MB）——
与 dsh-free-glm 记录的 `styles-S9_69L9k.js` 同一类产物。

#### 7.2 官方**确实是每请求一个 captcha**——但有三层我们没有的护栏

先回答用户的疑问：**不是复用**。证据：
- 每个 model request 都走 `Fnn()` → `Mnn()` 重新产出，再经 `lnn()` 注入
  `X-Aliyun-Captcha-Verify-Param` / `-Region` 两个头。
- `Snn`（param 表）**只有 `set` / `delete`，没有 `get`** ——
  它是**诊断记录表**，不是复用缓存。

但官方有三层护栏，**我们此前一条都没有**：

| 机制 | 官方实现（产物里的符号） | 我们此前 |
|---|---|---|
| **全局串行队列** | `wnn` promise 链 + `jnn()`，日志 `zcode-plan verification queue slot acquired`。同一刻只产一个 | ❌ 无（DSH 会并发发请求，每个都独立 mint） |
| **配置 TTL 缓存** | `f3()`：`expiresAt: t + 6e4`（**60 秒**）+ 在飞去重 `d3` | ❌ `index.ts` 用 `??=` 做**永久缓存** |
| **结果观测** | `mnn({result: 'traceless_passed' \| 'interactive_displayed'})` 上报 ARMS，并维护两个计数 | ❌ 完全没有 |

另有：**超时 120 秒**（`Htn = 12e4`，我们是 75 秒）；
**重复提交检测**（`Pnn()` 记住上轮 `certifyId`，相同就警告
`请求可能触发 F008 重复提交` —— 这正是 dsh-free-glm 里 `F008` 的来源）。

#### 7.3 阿里云的限流是**双维度**且有**默认阈值**（官方文档）

用户提供的文档
（[功能相关问题](https://www.alibabacloud.com/help/zh/captcha/captcha2-0/user-guide/function-related-issues)
与 [自定义策略](https://www.alibabacloud.com/help/zh/captcha/captcha2-0/user-guide/custom-policy)）：

| 维度 | 默认限制 |
|---|---|
| **同设备每小时** | **150 次** ← **最紧的一条** |
| 同设备每日 | 400 次 |
| 同 IP 每小时 | 4000 次 |
| 同 IP 每日 | 10000 次 |

⇒ 文档明确「**基于 IP 或者设备维度**的安全策略阈值」是**两个独立维度、
共同作用**。**设备维度 150/小时**才是我们真正的约束：
一次多步任务每步 1 次，**加上我此前默认开启的预取池就是 2 次/步**。

⚠ **这解释了实盘现象**：`session-eced01ed` 那种 246 步的长任务，
加上 dsh-free-glm 同期在跑，撞穿「设备每小时 150」是**大概率**而非偶然。

#### 7.4 本轮改了什么（四项，全部对齐官方）

1. **预取池默认关闭**（`captcha-pool.ts` 的 `CAPTCHA_POOL_DEFAULT_ENABLED`）。
   依据：① 官方根本没有预取；② dsh-free-glm 的池默认也是关的
   （`=1` 才启用，注释「先观察稳定性」）；③ 它让消耗**翻倍**。
   ⚠ **归因强度**：跨插件干扰有实证，但「预取池是压垮信誉的那一下」**未证实**——
   翻转的理由是①②，不是把③当结论。
2. **captcha 产出走全局串行队列**（新增 `serial-queue.ts`，接在
   `ZcodeAuth.mintCaptcha` 的**取池之前**，故池的 prefetch 后台路径也被挡）。
3. **captcha 配置改 60 秒 TTL 缓存**（新增 `ttl-cache.ts`，替换
   `index.ts` 的 `??=` 永久缓存）。⚠ 旧写法还有第二个缺陷：
   **首次失败会被永久固化**（`??=` 把回退兜底值也记住）。
4. **观测**（`ZcodeAuth.captchaObservability()`）：计数
   `tracelessPassed` / `interactiveDisplayed` / `failed`，
   并在**被要求交互式验证时显式告警**。
   ⚠ `interactive` 的判据是**轮询 DOM**（`#aliyunCaptcha-window-popup` 等
   四个 id，取自 dsh-free-glm 的实测记录）——因为官方文档 Q9 明说
   「该安全策略逻辑**不支持自定义，不对外透出**」，没有回调可用。
   用「**曾经出现**」而非「此刻存在」：交互元素在验证完成后会被移除，
   只在 success 那一刻查 DOM 会**漏报**（而那正是最需要知道的场景）。

**回归**：`serial-queue.spec.ts`（13）+ `captcha-backoff.spec.ts`（9）+
`captcha-pool.spec.ts`（9）+ **`zcode-captcha-guard.spec.ts`（6，接线验证）**。
⚠ 最后一类**不能省**：本仓库历史上多次栽在「原语写好了但没接上」
（`zcode-upstream.ts` 的 `fetchImpl` 曾是**死参数**）。
反向验证：把 `CAPTCHA_POOL_DEFAULT_ENABLED` 改回 `true` ⇒ 池用例变红；
去掉 `mintCaptcha` 的队列包装 ⇒ 接线用例的 `maxInFlight` 变 3（期望 1）。

⚠ **写这类用例的两个坑**（都踩过）：
- `ZcodeAuth extends Service`，构造时会调 `ctx.provide(...)` ⇒
  **必须用真实的 `new Context()`**，手写对象桩会在构造期抛
  `Cannot read properties of undefined (reading 'provide')`。
- 测队列时**必须先排除预取池的干扰**（池命中不调底层 mint）——
  默认已关闭，故天然走现产路径。

#### 7.5 仍未做

- **captcha 超时 75 秒 → 120 秒**（对齐官方 `Htn`）：官方值更长是给了
  交互式验证（真人拖动）留时间；我们是无感验证，75 秒对**无感**够用。
  若要支持「降级后让用户手动拖」，才需要调到 120 秒 —— 那是另一个功能。
- **持久化 profile**：见上一节，结论仍未定。
- **captcha 配置 TTL 的实盘验证**：60 秒取自官方同值，但我们**没有实测过**
  服务端配置的实际变化频率。若发现 `sceneId` 变更后仍有延迟，
  可下调 `CAPTCHA_CONFIG_TTL_MS`。

### 八、⚠️⚠️ 多账号凭据被**跨账号覆盖**（真实数据破坏缺陷，2026-10-02）

**这是本文件记录过的「构造全新对象抹掉字段」同型坑的第四次**，且这次
**破坏了用户数据**（不是显示错误）。

#### 8.1 用户报障

> 登录了 2 个账号（**两个不同微信各自收到 bigmodel 登录通知**）。
> 第二个账号有余额，但**插件里刷新积分显示 0**、发消息报
> 「额度已用尽或没有可用权益」；而 **IDE 里同一个账号发消息能收到回复**。

#### 8.2 根因（实测证据）

`refreshAll()` 与 `refreshAccountCredential()` 都拿 `this.current()` 的结果
**无条件写回目标 ref** —— 而 `current()` → `readCredentialFromPool()` 只取
**池里第一个凭据可用的账号**。于是 30 分钟一轮的续期定时器（或面板「刷新」）
把**账号 A 的凭据铺满了整个池**，抹掉账号 B 的真实凭据。

**实测证据**（用户机器 `~/.dsh/.credentials.yaml`，两个 `ZCODE_ACCOUNT_*`
逐字段比对，**ref 名与值均已脱敏**）：

| 字段 | 账号条目 #1 | 账号条目 #2 |
|---|---|---|
| 凭据 ref 名 | `ZCODE_ACCOUNT_<A>` | `ZCODE_ACCOUNT_<B>` |
| `zcode_jwt` 的 sha256 | `aa20f5d1…`（前 8 位） | **`aa20f5d1…`（相同）** |
| `device_mid` | `be4c6392…`（前 8 位） | **`be4c6392…`（相同）** |
| `account_label` | `<同一昵称>` | **`<同一昵称>`** |
| `bigmodel_access_token` 指纹 | `fe31a108…`（前 8 位） | **`fe31a108…`（相同）** |

⚠ **本文档刻意不写真实值**（ref 名会暴露账号编号、昵称是用户的微信账号名、
`device_mid` 是设备标识）。需要复核时按下方方法自行从本机取。

⇒ 两个条目**逐字节相同**，是**同一个账号占了两条**。
用户确认「是两个不同微信账号」，故**只能是覆盖所致**。

**症状为何极像服务端问题**：IDE 用它自己那份真实凭据（B）→ 正常；
插件池里两条都是 A → A 已耗尽 → 报额度用尽。
⚠ **排查要点：每当「IDE 能用而插件说没额度」，先怀疑凭据被覆盖，而不是配额。**

#### 8.3 修法：**绝不跨账号写**

ZCode **不可续期**（凭据是静态的、没有 refresh 端点），所以「刷新」唯一
正确的语义是「**逐账号重新解析自己的 ref，再写回自己**」——
与 `BuddyAuth.refreshAll` 的做法一致（那边也是逐账号读自己的 ref）。

⚠ **`refreshAll` 不再使用 `current()`**；每个账号 `readCredentialFromRef(自己的 ref)`，
解不出就**跳过并告警**，**绝不**用别的账号（或磁盘凭据）去填它。

⚠ **为什么不用磁盘 `~/.zcode/v2/credentials.json` 兜底**（听起来合理，实际不可实施）：
它是**单账号**格式，而池是**多账号**的 —— 我们**无法判断**那份磁盘凭据属于
池里**哪一个**账号。拿它去补任意一条，等于重犯同一个错误（换成「单体覆盖」）。

⚠ **旧注释的本意是错的**：「把磁盘上的最新凭据回写到每个账号的 ref，
这样用户在官方客户端重新登录后新凭据能铺开到所有条目」——
那个前提在**多账号池**下**不成立**：磁盘凭据只对应一个账号。

#### 8.4 回归与**反向验证**

`tests/unit/zcode-account-isolation.spec.ts`（6 条）：
「A 绝不写进 B」「池顺序颠倒时同样不串」「某账号凭据不可用时跳过而不填别的」
「`refreshAccountCredential` 只动目标 ref」「目标损坏时如实报错」
「单账号失败不影响其余」。

⚠ **已做反向验证**：把 `refreshAll` 改回「`current()` 一次然后写全部」⇒
**3 条变红**，其中一条直接复现用户症状（`expected 'account-A' to be 'account-B'`）。

⚠⚠ **反向验证本身踩了一次「假绿」**：第一次替换脚本因 **CRLF** 未匹配到方法结尾、
**静默失败**，测试全绿 —— 差点据此认为「用例抓不住旧实现」。
⇒ **改完代码做反向验证时，必须确认替换真的生效**（打印替换后的代码片段），
否则「全绿」可能是「什么都没改」。

#### 8.5 ⚠️ 两条既有测试此前**断言的是缺陷行为**（已改写）

`zcode-wiring.spec.ts` 里：

| 旧测试 | 问题 |
|---|---|
| `refreshAll 是「回写磁盘凭据」而不是续期，且逐账号隔离失败` | 测试名自称「隔离失败」，却断言 `REF_1` 与 `REF_2` **都被写入同一份磁盘凭据** —— 把 bug 固化成预期 |
| `refreshAccountCredential 无凭据时如实抛错` | 断言的文案要求用户「去官方客户端重新登录」，而多账号下那**解决不了**该账号的问题 |

⇒ 已改写为断言**正确语义**（逐账号各写各的；两个空 ref 保持空）。

⚠ **教训**：测试名里出现「…失败」「…不隔离」这类**消极措辞**时，要停下来问
「我是在断言**预期行为**，还是在记录**已知缺陷**？」后者应当写成 TODO
或直接修掉，不该固化成绿色。

#### 8.6 用户需要做的事（数据已被破坏，代码修复救不回来）

⚠ **B 的原始凭据在那次覆盖中已被抹掉，无法从残留数据恢复**。
用户需在 Jet Hub 里**重新登录**第二个微信账号。修复后的代码不会再覆盖它。

### 九、重复添加同一账号的去重（2026-10-02）

#### 9.1 ⚠⚠ 先纠正我写错过的判据：**`device_mid` 不能用来认账号**

我最初告诉用户「判据可用 `device_mid` 或 JWT 的 `user_id`」——**前半句是错的**，
写进文档会误导后来者。真相：

| 字段 | 来源 | 同一账号重新登录 |
|---|---|---|
| `device_mid` | **我们随机生成**（`generateDeviceMid()`） | **会变** ⇒ **不可作标识** |
| `user_id` | **服务端下发**（`user.data.user_id`） | **不变** ⇒ 正确判据 |

依据（`zcode-login.ts` 的实测注释）：「同一 JWT 换任意随机 UUID 都返回 200」
—— `device_mid` 的**值不被服务端绑定校验**，插件每次登录都会生成一个新的。

⚠ 若照错判据实现，**同一账号重新登录一次就会被判成新账号**，
去重功能**反向失效**（比不做还糟：用户以为去重了，实际每次登录都多一条）。
`tests/unit/zcode-dedup.spec.ts` 里有一条**专门的反例**把它钉住。

#### 9.2 `user_id` 此前**根本没被存进凭据**（去重的前提缺失）

`startLogin` 组装 `ZcodeCredential` 时**丢掉了 `loginResult.userId`** ——
登录响应里明明有（官方断言它是必需字段），但从未被搬进凭据。
故修去重必须**先补这个字段**（`src/zcode.ts` 的 `ZcodeCredential.user_id`）。

⚠ 该字段**可选**：2026-10-02 之前登录的凭据没有它。
`isUsableZcodeCredential` **不得**因缺它而拒绝（否则老用户突然无法用）——
已有用例锁住这点。

#### 9.3 判据查询：新增 `findAccountIdByIdentityField`

与既有的 `findAccountIdByCredential` **有意不同**（别合并）：

| | `findAccountIdByCredential` | `findAccountIdByIdentityField` |
|---|---|---|
| 用途 | **限流记录归属** | **通用去重** |
| 字段 | 写死两套（`access_key_id` / `access_token`） | 调用方指定 |
| `enabled` | **只看已启用** | **不看**（停用账号同样占位置） |

⚠ **必须容忍字段缺失**：读不到该字段的条目**跳过**（= 无法判断），
而不是当成「不匹配」或报错 —— 前者漏判，后者让老用户添加不了账号。

#### 9.4 时机与处置

- **时机必须在登录成功之后**：登录前只有占位条目（无凭据、无 `user_id`），
  无从判断。故去重在 `jet-hub-rpc.ts` 的 `started.result.then(...)` 里。
- **处置是「停用 + 改名」，不是删除**：
  前端 `login.poll` 靠「条目还在 + 凭据已写入」判断登录成功，
  **删掉条目会显示成「登录失败」**（事实恰恰相反），
  会误导用户反复重试。现在：`enabled: false`（⇒ 不参与选号，这就是去重的
  实际效果）+ 昵称标「（重复，已停用）」+ 日志。
- **保留原来那条不动**：它可能已被排序、改名或承载限流记录。

#### 9.5 回归与反向验证

- `tests/unit/zcode-dedup.spec.ts`（7 条）：`user_id` 能匹配 /
  **`device_mid` 不能匹配**（反例）/ 缺字段时跳过 / 空 identity /
  跨 provider 不误判 / 停用账号参与判重 / 老凭据仍可用
- `tests/unit/zcode-rpc-login.spec.ts` 新增 2 条**接线验证**：
  「同一账号添加两次 ⇒ 第二条被停用」「凭据里带上 user_id」

⚠ **已做两次反向验证**（这次特别注意确认替换**真的生效** ——
上一次因 CRLF 静默失败过）：
- 删掉 `user_id` 的搬运 ⇒ **2 条变红**（含「添加两次」那条）
- 短路 `findAccountIdByIdentityField` 调用（保留 user_id 存储）⇒
  **1 条变红**（「添加两次」那条）
⇒ 证明两类用例分别覆盖「字段没存」与「没做去重」两种失效。

⚠ **写这类用例的脚手架坑**：`AccountPool` 是**真实**实现、会读写磁盘，
必须 ① `mkdtempSync` + `DSH_JET_HUB_STATE_DIR` 隔离；
② 用 `ctx.provide('credentials', fake)`（**不是**属性赋值 ——
`AccountPool` 经 `ctx.credentials` 取服务）；
③ **不要**用 `replaceAll`（那是 Jet Hub 的导入路径，语义不同；
我第一版用它导致 3 条用例假失败）。

## 供应商级一键开关（左侧 rail 分组 + 页头弹窗开关）

**需求**：「因该提供左侧供应商的一键开关，开关逻辑和账号的开关逻辑一致（但是如果不关闭
模型就不关闭供应商），应该分组显示打开和关闭的供应商」。

### 语义（用户逐项确认）

| 决策 | 取值 |
|---|---|
| 关闭某供应商 | **关闭它的全部模型** + **停用它的全部账号** |
| 「已关闭」判据 | **该供应商的全部模型都已关闭**（不新增持久化字段，由模型黑名单推导） |
| 重新打开 | 清空该供应商的模型黑名单 + **启用它的全部账号** |
| 右侧账号面板 | **保持既有逻辑不变**；仅在其后重新加载一次列表（见下） |

⚠️ **没有新增任何持久化字段**：`state.json` 仍只有 `accounts` 与 `disabledModels`。
供应商的开关状态是**推导值**（`closed = total > 0 && disabled === total`），故无迁移、
无一致性维护成本。代价是「手动单独打开某个模型」会让该供应商回到「已打开」——
这正是判据的字面含义。

### 端点：`provider.status`（读）+ `provider.setEnabled`（写）

- `provider.status` 一次返回**全部**供应商的状态。⚠️ 全程只用**同步内存副本**：
  目录取 `modelAdapters[id].listAllModels()`（同步；不触发远端拉取），账号取
  `pool.listAccountsByProvider()`（同步读内存）。
  **不得**改用 `pool.listAccounts()` —— 它逐账号调 `credentials.describe()`（异步 IO），
  8 个供应商会把设置页首屏拖慢，而我们**只需要计数**。
- ⚠️ `listAllModels()` **不带 `disabled` 字段**，必须另取 `pool.listDisabledModels(id)`
  按 id 计数。
- ⚠️ 适配器缺失（外部/旧适配器）时 `total = 0`、`closed = false`：保守判为「未关闭」，
  让用户可以尝试操作，而不是误报成已关闭。

### ⚠️ 关闭方向的顺序不可颠倒：先关模型，再停账号

「是否已关闭」的判据是**模型是否全关**。先关模型可保证即使随后停账号失败，状态判定
依然自洽（该供应商确实已关闭），用户重试一次即可补齐账号。反过来先停账号、再关模型，
中途失败会留下「账号全停用但模型仍可见」的中间态 —— 用户在对话框里还能选到它的模型，
却没有任何可用账号。`tests/unit/jet-hub-rpc.spec.ts` 有专项用例锁死写入顺序。

### ⚠️「不关闭模型就不关闭供应商」

关闭方向必须拿到模型目录；**读失败**或**目录为空**时**整个操作失败、不落盘、不广播**。
绝不能「关不掉模型就只停账号」—— 那会让供应商显示成已关闭而模型其实还在，
用户按「已关闭」的预期却仍能选到它。前端把这种情形表现为**开关禁用**并给出原因
（`providerSwitchState` 的 `reason`），而不是让用户点下去只得到一句错误提示。

### ⚠️ 开关**不在**左侧行尾（2026-10-01 用户要求搬到页头弹窗）

!25 最初的形态是把开关挂在左侧每个供应商行的右侧。用户随后要求改：
「提供商开关是直接显示在 provider 右侧的，把它单独抽出来到 Jet Hub 上面的一个按钮里，
点开始列表和开关，可以选择关闭，**和模型列表中那套打开/关闭按钮的显示逻辑一样**」。

现在的形态：页头 `dim-jh-headerActions` 里的**「供应商开关」按钮** → 点开
`ProviderSwitchPanel` 弹窗（一个供应商一行、行尾一个开关）。

**为什么这个改法是对的**：关闭一个供应商是**破坏性批量操作**（一次改动几十个模型 +
全部账号），把它挂在承担导航的窄栏行尾，等于让误点代价最高的控件离高频无害动作
（选要看哪个供应商）最近。搬进弹窗后必须"点进去 → 看清影响面 → 再决定"。

⚠️ **搬走的是控件，不是判据**：`providerSwitchState`（三形态）与
`groupProviders`（分组）原样复用，新增的 `providerSwitchRows` /
`providerToggleSummary`（`plugin-src/client/provider-toggle.js`）只是把
「定义 × 状态表」拼成行数据与计数 —— **判定仍然只在纯逻辑层一处**。
弹窗与左侧 rail 读的是同一份 `provider.status`，故不可能出现
「左侧说它关了、弹窗里它还是开的」。

⚠️ **弹窗行的约束换了一套**：行容器是 `<label>` 且**内部只能有 1 个 checkbox**
（与 `ModelToggle` 同因：插入第二个 checkbox 会让「点行内文字」激活第一个可标记控件）。
原先那条「开关必须是 `<button role="tab">` 的兄弟节点」随开关一起失效 ——
现在左侧行里**只有一个 button**，`provider-toggle.spec.ts` 改为断言这一点
（行内不得出现 `React.createElement('input'`）。

⚠️ **rail 宽度 243px 是当时的遗留**：那张实测表里 243px 是为了**容纳行尾开关**
（无开关时 200px 就够）。开关搬走后左侧已有约 40px 富余，收窄回 200px 属独立的
视觉决策，本次**没做**（样式断言 `.dim-jh-rail { width: 243px; }` 仍在，
改宽度时要一起改）。

### 弹窗与模型列表弹窗共用同一套结构与类名（用户明确要求）

`ProviderSwitchPanel` 复用 `dim-jh-modalOverlay--top` / `dim-jh-modalHead`
（标题 + 计数 + 刷新 + 完成）/ `dim-jh-modalHint` / `dim-jh-modalBody` /
`dim-jh-modelList` / `dim-jh-modelRow` / `dim-jh-modelInfo` / `dim-jh-modelName` /
`dim-jh-modelId` / `dim-jh-switch`，并沿用 ESC 与点遮罩关闭、
**关闭即不挂载**（避免常驻一份开关列表）。**没有为它新写一条样式规则**。

两个容易做错的细节：

- `data-disabled` 在模型列表里的语义是「**这一项已被关闭**」（整行淡出），
  这里保持一致：`row.checked ? 'false' : 'true'`。「这行点不动」由 `input` 的
  `disabled` 表达，**两件事不能混成一个属性**。
- **busy 只锁被点的那一行**，不锁整表（与 `ModelListPanel` 的 `busyIds` 同取向）。
- ⚠️ 状态没读回来时**不显示计数**：`providerToggleSummary` 的 `known: false`
  让界面显示「正在读取状态…」/「状态读取失败」，而不是「已打开 0、已关闭 0」——
  后者会被读成「一个供应商都没有」。为此 `JetHubPage` 新增了 `providerStatusFailed`，
  用来区分「还没回来」与「回来是失败」（`providerStatuses === null` 一个值担不起两义）。

### ⚠️ `.dim-jh-providerLabel` 曾是「已定义但从未被应用」的死样式

真实代码渲染的是 `<span><strong>{label}</strong></span>`（span **没有** className），
于是长供应商名一直在**折行**（用户最初的截图里「WorkBuddy (国际 / 版)」就是两行）。
该类（含 `min-width: 0` 与 `strong` 的 `nowrap + ellipsis`）在样式表里早已存在却无人使用。

本次**启用**它，把折行改为单行省略号。这是左侧的一处**可见变化**，故用实测数据定了
rail 宽度：实测（无头 Edge + 真实源码 STYLES，rail 高 446px、纵向滚动条出现时）

| 方案 | rail 宽 | 标签可用 | 结果 | 列表总高 |
|---|---|---|---|---|
| 现状（无开关、真实标记） | 200px | 119px | 4 行折成 2 行，无截断 | 384px |
| 行尾开关 + 省略号类 | 200px | 77px | **6/8 行超宽**（最多 -64px） | 384px |
| 行尾开关 + 省略号类 | 236px | 113px | 3/8 行超宽 | 384px |
| **行尾开关 + 省略号类** | **243px** | **120px** | **3/8 行超宽（-3 / -4 / -21px）** | 384px |
| 行尾开关，**不启用**省略号类 | 243px | 120px | 4 行折成 2 行 | **424px**（行高 48→58px） |

故取 243px：与现状几乎逐像素持平，且列表总高不变。

⚠️ **测量方法上的两个坑（都踩过）**：
- **inline 元素的 `clientWidth` 恒为 0**，用 `scrollWidth - clientWidth` 判截断会得到
  「没有截断」的**假阴性**。要用 `Range.getBoundingClientRect().width` 取文本真实宽度，
  与父容器 `clientWidth` 比较。
- **不能靠行高判断折行**：2 行 × 20px = 40px 仍小于 `.dim-jh-provider` 的 `min-height: 48px`，
  行高恒为 48px，折行被完全掩盖。要用 `Range.getClientRects().length`。
- **纵向滚动条会再吃掉约 15px** 标签宽度（Windows 经典滚动条），是否出现取决于 rail 高度
  （即用户窗口高度）。测量必须同时报告「纵向滚动条 = 有/无」，否则同一宽度两次测得不同
  标签宽度会被误读成测量错误。

### 状态读取失败时退化为不分组（不阻断主功能）

`provider.status` 失败时把状态置为 `null`，rail **按 `PROVIDERS` 原顺序平铺、不分组**，
并在页头提示一句。⚠️ 此时**弹窗里的**所有开关都被 `providerSwitchState(undefined)`
判为**禁用**（`reason: '状态尚未读取'`）—— 状态未知时让用户点一个状态不明的开关比
禁用更糟。**绝不**因为左侧这个装饰性功能而让整个设置页白屏。
⚠️ 但「`null` 一个值」担不起「加载中」与「读取失败」两义 —— 弹窗计数需要分开显示，
故另有 `providerStatusFailed`（见上一节末条）。

### 右侧账号面板：只重新加载，不改逻辑

供应商开关会改掉账号的 `enabled`，故提交成功后递增 `version` 让 `ProviderPanel` 重挂载
并重新拉一次账号列表（用户已确认接受这一处刷新）。**除此外右侧一律不动**：不新增字段、
不改按钮、不改积分行、不改拖拽排序、不改账号级 `toggleAccount` 联动。

### 回归用例

- `tests/unit/provider-toggle.spec.ts` —— 纯逻辑（分组 / 三形态 / 结果文案 /
  **弹窗行数据 `providerSwitchRows`** / **计数 `providerToggleSummary`**）+ 源码级守卫
  （⚠️ **左侧行内不得出现 `input`**、页头按钮点开弹窗且关闭即不挂载、
  弹窗行是 `<label>` + **恰好一个** checkbox、弹窗与模型列表共用同一套类名、
  `data-disabled` 只表达「已关闭」、状态没读回来不显示计数、分组标题带计数、样式约束）。
  ⚠️ 源码级断言**不能跨行**：本仓库源文件是 CRLF，`'a\nb'` 形式的字面量匹配不上。
- `tests/unit/jet-hub-rpc.spec.ts` —— `provider.status` 的 `closed` 判据（含「只关一部分」
  与「空目录」两条边界）、`provider.setEnabled` 的写入顺序 / 不落盘 / 广播 / 参数校验。
- `tests/unit/account-pool.spec.ts` —— `setAccountsEnabled` 的 provider 隔离、幂等不落盘、
  不破坏黑名单、写前 `ensureLoaded`、跨实例读回。
- ⚠️ **反向验证 5 组**（证明用例非同义反复）：`closed` 改判据 → 1 条失败；空目录仍落盘 →
  1 条失败；写入顺序颠倒 → **4 条失败**；去掉「无模型即禁用」→ 3 条失败；去掉分组计数 →
  1 条失败。
- ⚠️ **测试替身必须补齐 `credentialRef`**：`sanitizeAccounts` 会把缺该字段的账号**整条丢弃**，
  于是「停用全部账号」返回 0、用例假失败（本次踩过）。
- ⚠️ **追加测试段时要确认落在哪个 `describe` 作用域**：本次一度把新段落追加进
  `TRAE 签到设备轮换代次` 的 describe 内，引用了该作用域不存在的工厂，8 条用例全部
  ReferenceError。新增段落应显式写明它所属的顶层 describe。

### 安装闸门（用户要求：确保不影响客户端启动才安装）

`verify-client-boot.mjs`（工作区根目录）是安装前的**强制闸门**，任一失败即拒绝安装：

1. **语法层**：`node --check` 每个产物 js。
2. **加载层（冒烟）**：无头 Edge 注入 `window.__ModuleLoader__`，捕获
   `load({id, factory})` → 断言 id；以 stub react 执行 `factory` → 断言导出
   `apply` / `inject`；再调 `apply(fakeCtx)` → 断言注册了 `settings.section` 且未抛错。
   这一步直接验证「插件能加载并注册设置页」，是 tsc 与单测都覆盖不到的一层。
3. **产物层**：新能力在、旧能力未被破坏、源码与部署产物哈希一致。

### ⚠️ VibeX（曾接入的面板，2026-10-02 **已整块移除**）

**现状：代码、面板、测试全部删除，不要照着下面去"修复"一个不存在的东西。**
用户 2026-10-02 要求「把这个部分从插件中移除」，整块下线。已删除物：
`src/vibex*.ts`（product / oauth / auth / mcp / 归一）、4 个 `tests/unit/vibex-*.spec.ts`、
客户端 `PROVIDERS` 条目 + 图标 + 样式 + 钥匙按钮 + 能力位、RPC 的 `account.create` /
`account.refresh` / `credits.balances` / `vibex.sso.import` / `model.list` 五处分支、
`REF_PREFIX_TO_PROVIDER` 的 `['VIBEX', 'vibex']`、`types.ts` 的两个 RPC 接口。

**为什么记下来**：它是本仓库**唯一一个非 LLM 面板**，下面四条结论对将来任何
「接入一个没有补全端点的服务」都有复用价值（重新评估时的起点，不是待办）：

1. **「非 LLM ⇒ 不算 provider」是直觉陷阱**。占位数组按**实参位**计数，不按语义：
   `registerJetHubRpc` 的实参、客户端 `PROVIDERS`、`zcode-rpc-login.spec` 的
   `args.length` 全都要有它；而 `plugin.spec.ts` 的「adapter 路由」清单**不能**加
   （它没注册 `ctx.llm` 路由）。增删面板时这几处必须一起动。
2. **两条凭据通道可能互不通用**：MCP OAuth token 只保证能开 `/mcp/vibex`；控制面
   （余额）只认浏览器登录态（`Rh-Accesstoken`）。判据来自实测 —— 假 Bearer 回
   `412 TOKEN_INVALID`。`TOKEN_MISSION` 是**服务端原文拼写**，别"顺手修正"成 MISSING。
3. **OAuth 发现必须走 RFC 9728 链（资源→AS），不能信站点根 well-known**。
   真机两连坑：根 well-known 当时指向**面向 Codex CLI 的另一个 AS**（`/vc/api/codex/oauth`），
   拿它的端点注册 4 项 scope 能过、但 authorize 因 `/mcp/vibex` 不属于它而回
   `INVALID_RESOURCE`。一个站点可以有**多个 AS 各管各的资源**，资源→AS 的绑定只写在
   `/.well-known/oauth-protected-resource/<path>` 里。
4. **分钟级寿命的凭据会暴露调度周期的死区**（**这条结论仍然生效**，见
   `src/index.ts` 的 `REFRESH_INTERVAL_MS`）：15 分钟 token + 到期前 120s 续期窗口
   ⇒ 30 分钟粒度的检查点必然错过，中间是「已过期未续」的 401 死区。周期下界由
   **最短寿命**决定，不是由多数派（小时级）决定 —— 现为 5 分钟，别改回 30。

回归防线（当时）：`tests/unit/vibex-panel.spec.ts`（客户端门控）+ `jet-hub-rpc.spec.ts`
的对照组用例（同一必然抛错的 llm 桩：buddy 报错证明路径经过 llm、vibex 拿空目录
证明短路在前）。两者**随面板一并删除** —— 事实变了，用例就该走，不是漏删。

### ⚠️ Antigravity（第 14 个面板·非凭据型）接入维护要点（2026-10-02 对齐）

Antigravity（Google 官方 `agy` CLI）是**唯一一个不由本插件持有凭据的面板**：
token 在系统钥匙串 / 凭据管理器里由官方二进制自管，一个账号 = 一个隔离 HOME
目录（`~/.dsh/agy-accounts/pool.json`）。将来维护时最容易犯的五件事：

1. **它出现在所有「位置契约」里，但不在 `ctx.credentials` 里**。`registerJetHubRpc`
   的实参占位（第 14 位 `agyService`）、客户端 `PROVIDERS`（第 14 条）、
   能力矩阵、`zcode-rpc-login.spec` 的 `args.length===17`、`plugin.spec` 的
   「十三条 adapter 路由」清单**都要**有它；但 `REF_PREFIX_TO_PROVIDER`
   **刻意没有** `['ANTIGRAVITY','antigravity']` —— 加进去 = `state.json` 丢失时
   凭空造出指向空气的账号条目（同 vibex 那条「非 LLM ⇒ 不算 provider」的直觉陷阱，
   方向相反但成因同类）。由 `jet-hub-store.spec.ts` 的两条用例双向钉死。
2. **动词边界：该走标准动词的绝不留在扩展命名空间**。账号增删改查/排序/刷新/
   重测/重置/登录发起/登录轮询/模型开关/供应商开关 = 标准 `account.*` /
   `login.poll` / `model.*` / `provider.*`（服务端在各 case 内按 provider
   分派到 `antigravity` 形参）；`antigravity.*` 只剩**无标准对应物**的九个
   （粘码 / 取消 / 主账号登录 / 慢探针 / 状态快照 / 设主号 / 取号模式 / 代理 /
   开终端）。旧名 `agy.*` 是移植自对面插件的二进制名前缀，已全部改名 ——
   「agy 是二进制名、antigravity 才是 provider id」的阅读歧义不要再引进来。
   被标准动词吸收的旧端点（`agy.loginBegin`/`agy.refreshQuota`/`agy.clearCooldown`/
   `agy.models`）**不得复活**：同一件事两套表达必然漂移（对面 HTTP 面的教训）。
   回归防线：`antigravity-wiring.spec.ts`（按 case 边界切体断言，不用距离式正则）。
3. **分派判据分两种**：payload 带 `provider` 的（list/create/reorder/retestAll/
   resetAll/login.poll/provider.*）按 `ANTIGRAVITY_PROVIDER_ID` 等值判；
   只有 `accountId` 的（update/delete/refresh/retest/reset）按**账号 id 反查
   agy 池**（`requireAgyService` + `pool.getAccount`）—— 后者是这些请求契约里
   唯一可行的判据，写死 provider 反而要前端多传字段。两种判据混用会静默错对象
   （WorkBuddy 刷新按钮、qoder 刷错凭据的同族缺陷）。
4. **面板不得反向 import `jet-hub.js`**：共享 `AccountCard` / `ModelListPanel` /
   `SubscriptionQuotaPanel` 一律**以 prop 注入**（`jet-hub.js` 已 import 面板
   文件，反向 import = 循环依赖，esbuild 静默产出 undefined 绑定，运行期才炸）。
   面板渲染处**不得**直写端点名，一律经 `antigravity-api.js`（唯一出口）。
5. **两条真实耗时别当卡死**：`antigravity.status` 是毫秒级内存快照（轮询只走它）；
   慢探针 `antigravity.probe`（登录态真探 + 目录发现）未登录时要挂约 15 秒
   （`agy models` 不打印授权 URL，等 watchdog 杀进程）—— 只有用户显式点「刷新」
   才允许慢。`ModelCatalog` 的失败负缓存（TTL 内不再 spawn）是防「5s 轮询叠出
   常驻挂起子进程」的（2026-10-02 永久 loading 故障的根因，用例锁死）。

其它不可回退的细节：主账号（systemHome）槽位**不可删**（删掉后授权成功也无处
回填 email/配额，面板显示「还没有账号」的实测链路）；`poolAuth.beginPrimary`
必须能带代理（换码/取 email 直连 Google 必超时）；登录成功（phase=done）要
**同时**破目录负缓存 + 登录态 60s 缓存 + 广播 `llm/adapters-updated`，缺任何
一条都会「登录成功了但界面一分钟不变」；family cooldown → 共享卡
`modelRateLimits` 的映射只算未过期项；`subscriptionQuota.requestLog` 对 agy
如实回 `note` + 空表（官方网关无逐笔流水），不得渲染假支持；额度量纲换算
方向是 remaining(0–1) → percentUsed=(1-r)*100，写反就是「用掉 70%」显示成
「还剩 70%」。

### ⚠️ Antigravity 的**响应速度**：两个已查明的瓶颈（2026-10-03）

用户要求「提高 Gemini 的响应速度」。实测拆解后，慢的原因**不在网络也不在
模型**，而是两处与 agy 进程打交道的实现细节。维护时别把它们改回去。

**瓶颈 1（已修）：流式被写成全量等待 ⇒ 首字延迟 = 整段生成时间。**
原 `driveOnce` 写成 `const o = await outcome` —— 等 agy 进程**结束**才把
`o.stdout` 一次性喂给 parser。那段代码自己的注释就写着「那样失去流式……
为保留流式，改用轮询 drain pending」，但轮询从未实现、`pending` 始终为空
（重构半途而废）。修复 = `onLine` → `parser.feed` → `mapper.map` → 队列
（数组 + 唤醒回调，**不轮询**）→ generator 边到边 `yield`；收尾再 `await`。

- 实测（agy 登录态正常时）：首字 **18.9s → 9.5s**，总耗时不变（本来就是 18.9s）。
- ⚠️ **`parser.feed(line + '\n')` 必须补回换行**：`onLine` 已把 `\n` 剥掉，
  而 `feed` 是按行累积缓冲的 —— 不补就永远攒着不解析，表现为「整个流一个字都不出」。
- ⚠️ **必须保留收尾处的 `emitFailure('PROCESS_EXIT')`**：流式路径下事件边走边发，
  没有 `result` 事件时 mapper **从未 finish**，漏了它 harness 等不到 finish 块、
  UI 永远停在「运行中」（旧实现因为结束时统一 flush 全量事件反而不会漏）。
- 回归防线 `tests/unit/antigravity-streaming.spec.ts`：假 agy「先吐内容→静默
  2.5s→再收尾」，断言**首块早于静默期结束**到达。⚠️ 判据必须是**时序关系**，
  不是「有没有输出」（后者在全量等待下同样成立 = 同义反复）。已反向验证：
  改回 `await outcome` 后该条变红（首块 2567ms ≈ 总 2568ms）。

**瓶颈 2（未修，待登录态实测）：每次调用都冷启动 agy，8–10 秒固定开销。**
实测（登录态正常时）：`agy --version` 仅 130ms，但 `agy -p "hi"` 要 **15s**
（首字节 7.4s）—— 开销全在 agy 自身启动（加载目录/认证/会话初始化）。
`--input-format stream-json` 支持**一条进程跑多轮**（help 原文 "runs a turn for
each"），实测同进程第 2/3 轮首字节降到 **0.66s（13 倍）**。
⚠️ **但常驻会改变会话语义**：实测 agy 侧**累积上下文**（让它记 7391，下一轮
答得出；问它第几轮，答「3」）。而本插件当前是**单轮代理**（每轮喂历史摘要 +
尾部 user），直接复用进程会让摘要层层叠加。真要做必须同时解决：
① 靠 `sessionId` + 历史前缀校验判断"是否为干净续轮"，不确定就重建进程；
② `purpose: 'compaction' | 'session-title'` 的辅助调用**共享同一 sessionId**，
   必须走独立进程，否则会污染主对话上下文；
③ 账号切换（不同隔离 HOME）/ 模型或档位变更 / 空闲回收 / 崩溃重建 / dispose 清理。
⇒ 这是一次架构级改动，**需在 agy 登录态下实测验证**再做（用户 2026-10-03 决定）。

**默认思考档位**：`defaultEffortFor` 的阶梯是 `high → medium → low`，即**默认
最慢档**。面板已暴露成开关（`antigravity.setDefaultEffort`，空串 = 跟随模型
默认）；设置落 `~/.dsh/agy-accounts/settings.json`（**独立文档**，不进共享的
`jet-hub/state.json` —— 为一家偏好改它的 schema + 三个后端不划算）。
⚠️ 档位只有**模型目录未钉死时**才生效，用户在模型选择器里选的档位优先；
⚠️ 改档位必须 `broadcastCatalogChanged`，否则模型选择器一直显示旧默认档；
⚠️ 白名单是 `low|medium|high|max`（`agy --help` 原文），越界值在落盘前净化成
空串 —— 绝不把 agy 不认的档位写进磁盘再发出去。
回归防线 `tests/unit/agy-settings.spec.ts`（持久化/净化/降级）、
`tests/unit/antigravity-effort-wire.spec.ts`（**捕获真实 argv** 断言
`--effort` 后面的值；已反向验证：摘掉该字段后 medium/low 两条变红）。
