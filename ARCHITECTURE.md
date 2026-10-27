# 架构（0.12.2）

把 QQ 消息桥给 DSH Agent：五种聊天协议各有一个**独立子进程适配器**，插件内核只认一套 stdio 帧和一套统一消息段（OneBot 11 风格）。帧的权威定义只有一处：[lib/bridge/CONTRACT.md](lib/bridge/CONTRACT.md)。

## 1. 分层

```
QQ 用户
   │
   ▼
QQ 客户端 / 平台（QQ NT、QQ 开放平台、Discord/飞书…）
   │ 各家原生协议
   ▼
协议端（不在本仓库，qq-official 例外：适配器直连腾讯 API v2）：NapCat · OneBot 12 实现端 · Koishi(Satori) · Milky 协议端
   │ 5 种协议之一：onebot11 / onebot12 / satori / milky / qq-official
   ▼
lib/adapters/*.mjs        独立子进程，零 npm 依赖 —— 只懂协议（共用 lib/bridge/ 的 WS/stdio/段工具）
   │ stdin/stdout，换行分隔 JSON
   ▼
lib/index.js              Cordis 插件，Host 侧 —— 只懂业务
   ├─ admin.js 权限 + 群管理指令      ├─ session.js 会话/路由/访客工具闸
   ├─ tools.js 9 个 Agent 工具        ├─ owner-settings.js 拥有者改设置
   ├─ workspace.js QQ_msg 工作区根
   └─ 联网与媒体：http.js · websearch.js · imgsearch.js · moli.js · imagegen.js
   │ ctx.sessionController（官方组装路径）
   ▼
DSH Agent（默认每个 QQ 会话一个）
```

中间层 **lib/bridge/** 被五个适配器 import，不含业务：WS 传输（正向/反向、帧编解码、重连）、stdio 帧工具（发射器、发送队列、stdin 循环）、统一消息段。

浏览器侧是另一条独立的边：`lib/client.js` 是插件详情页里的配置区（`plugins.bundle.config` 插槽），只经 DSH 设置服务读写配置，不参与消息链路。

### 身份契约（改包名时别踩）

同一个插件在 DSH 里有**三个身份**，各按各的 key 派发，混用会出现"面板打不开 / 配置区空白"：

| 身份 | 由谁决定 | 当前值 | 用错的表现 |
| --- | --- | --- | --- |
| 客户端模块 id（`__ModuleLoader__.load({ id })`） | **npm 包名** | `@sputnikzaychik/dsh-qq-bot` | 整个客户端插件不加载：`loaded without registering …` |
| 配置区插槽 key（`slots.register({ key })`） | **npm 包名**（插件页按 `pkg.name` 派发） | 同上 | 插件在、配置区空白 |
| 设置命名空间 `ns`（读写配置） | **profile 条目 id** | `dsh-qq-bot` | 读不到 / 写不进配置（改了这个，老配置也会丢） |

包名以 `package.json` 的 `name` 为准，`cordis.patch.yml` 的 `name` 必须与之一致（`id` 保持不变）。0.12.1 就是只改了包名、前两个 key 还写死旧名字，所以整版客户端不可用——0.12.2 修的就是这三者的关系。

两条贯穿全局的约束：

1. **适配器只管协议，插件只管业务。** 换协议 = 加一个 `lib/adapters/<协议>.mjs`；插件内核零改动。
2. **越权 fail-closed。** 权限判不出来就按低权限；访客工具闸装不上就拒绝驱动非拥有者，没有「默认放行」分支。

## 2. 模块清单

| 文件 | 职责 | 关键导出 | 使用方 |
| --- | --- | --- | --- |
| `lib/index.js` | 装配与监管：适配器生命周期、帧分发、回合/回复/视觉、主动发言、配置热更新 | `Config` `apply` `inject` | DSH（`cordis.patch.yml` 挂载） |
| `lib/config.js` | 配置契约：默认值 + schemastery schema + 合并/还原 + 废弃键识别 | `Config` `DEFAULTS` `plainConfig` `mergeConfig` `staleConfigPaths` | `index.js`、`client.js`（按 schema 渲染） |
| `lib/client.js` | 浏览器侧设置区（手写 `__ModuleLoader__` bundle，只依赖 react）。**模块 id 与插槽 key 都必须是 npm 包名**，设置命名空间 `NS` 仍是条目 id `dsh-qq-bot`（见「身份契约」） | —（浏览器模块） | DSH 插件详情页 |
| `lib/admin.js` | 三路权限判定（静态名单/动态授权/本群身份）+ 群管理指令 | `createAdmin` → `resolveAuthority` `hasPerm` `handleAdminCommand` `TIER_LABEL` | `index.js`、`tools.js`（qqgroup 鉴权） |
| `lib/session.js` | 会话条目与路由、访客工具闸、被回复图片收集 | `createSession` → `sessionRoute` `getEntry` `entryForAgent` `collectReplyImageUrls` | `index.js` |
| `lib/tools.js` | 9 个 Agent 工具：`qqbot` `qqconfig` `qqgroup` `qq_websearch` `qq_webfetch` `qq_imgsearch` `qq_history` `qq_draw` `qqauth` | `createTools` → `registerTools` | `index.js`（动态 import `@deepseek-ai/dsh-tools`） |
| `lib/owner-settings.js` | 拥有者设置通道：白名单、确认码、限流、审计 | `createOwnerSettings` → `show` `propose` `apply` `cancel`，`SPECS` `checkCaller` | `tools.js`（qqconfig）、`index.js`（审计落盘） |
| `lib/workspace.js` | QQ_msg 工作区根解析（Documents 解析，与 DSH 默认工作区同级） | `qqMsgRootSync` `sessionWorkdir` | `index.js`、`imgsearch.js` |
| `lib/http.js` | 通用 HTTP + CONNECT 代理隧道 + 响应文本工具。**出站只允许公网**：地址先经 `canonicalHost`（WHATWG URL 归一）再判段，`publicFetch` 用 `node:http(s)` 直连并把 `pinnedLookup` 钉在已校验地址上（防 DNS rebinding） | `multiEngineRequest` `fetchUrlViaProxy` `webSearchPost` `publicFetch` `assertPublicHost` `canonicalHost` `resolvePublicAddresses` `pinnedLookup` | `websearch.js`、`imgsearch.js`、`moli.js`、`tools.js`（qq_draw）、`index.js`（qq_webfetch / 识图下载） |
| `lib/websearch.js` | 联网搜索：DeepSeek 官方 web search + 多引擎组合 | `runWebSearch` | `index.js`（qq_websearch） |
| `lib/imgsearch.js` | 图片反搜：TraceMoe / IQDB 等 + 图床上传 | `runImageSearch` `uploadToHost` | `index.js`（qq_imgsearch） |
| `lib/moli.js` | Moli 无头浏览器渲染抓取 | `meFindMoli` `meMoliFetchText` | `index.js`（qq_webfetch 的 moli 分支） |
| `lib/imagegen.js` | 生图：OpenAI 兼容 `/images/generations`，含重试与任务轮询 | `generateImage` `parseImagePayload` | `index.js`（qq_draw） |
| `lib/proactive.js` | 主动发言纯逻辑：时间窗、消息清洗、提示词、决策解析、频率闸、模型解析（含可选两段式） | `parseClock` `buildPrompt` `parseDecision` `allowSend` `resolveModel` `resolveStageModels` `buildSpeakPrompt` `runSpeakStage` | `index.js`（模型请求走 `ctx.llm.stream()`，经 DSH 已配置渠道，0.11 起） |
| `lib/history-auth.js` | 历史消息的会话定向与鉴权（纯逻辑） | `resolveHistoryTarget` `judgeHistoryAccess` `buildHistoryRequest` | `tools.js`（qq_history） |
| `lib/totp.js` | 零依赖 TOTP/HOTP 与恢复码（RFC 4226 / 6238、base32 容错、scrypt 哈希、弱密钥拒绝） | `generateSecret` `hotp` `totp` `totpVerify` `generateBackupCodes` `hashBackupCode` `verifyBackupCode` `otpauthUri` | `flow-auth.js`、`totp-cli.mjs`、`index.js`（/auth） |
| `lib/totp-cli.mjs` | 终端绑定：打印 base32 secret / otpauth URI / 终端二维码 / 恢复码（密钥不经 QQ） | —（命令行入口） | 运维手动执行 |
| `lib/qr.js` | 自研二维码编码器（字节模式、纠错等级 M、版本 1..9），零依赖 | `encode` `chooseVersion` `toTerminal` `MAX_VERSION` | `totp-cli.mjs`、`lib/client.js`（浏览器版同算法副本） |
| `lib/flow-auth.js` | 授权状态机 + 闸门：申请 / 验码 / grant / 一次性消费 / 连错锁定 / 审计 | `createFlowAuth` `createFlowGate` | `index.js`、`session.js` |
| `lib/flow-store.js` | 流程脚本存取：名字白名单、sha256、路径穿越与覆盖防护 | `createFlowStore` `isValidFlowName` `sha256` | `index.js`（/flow 指令） |
| `lib/flow-commands.js` | `/auth` `/flow` 文本解析、拦截判定、打包输入归一化、帮助文案 | `parseAuthCommand` `parseFlowCommand` `flowInterceptKind` `artifactInputLines` `FLOW_HELP` | `index.js`、`session.js` |
| `lib/compat.js` | DSH 版本兼容自检（范围只维护两个常量） | `SUPPORT_FLOOR` `SUPPORT_CEILING` `compatibilityInfo` | `index.js` |
| `lib/bridge/ws.mjs` | 手写 RFC 6455：帧编解码、正向/反向 WS、链路集合、指数退避重连 | `connectForward` `startReverseServer` `createLinkSet` `decodeFrames` | 五个适配器 |
| `lib/bridge/stdio.mjs` | stdio 帧工具：发射器、发送队列（限速）、stdin 命令循环、`postJson` | `createEmitter` `createSendQueue` `installStdin` `postJson` | 五个适配器 |
| `lib/bridge/segments.mjs` | 统一消息段（text/at/image/reply/face/…）与摘要 | `segmentsToText` `countImages` `imageUrlsOf` `summarizeSegments` `seg` | 五个适配器 + `index.js` |
| `lib/adapters/onebot11.mjs` | OneBot 11（NapCat 等）：正向/反向 WS + HTTP API | 脚本本体（默认协议） | `index.js` 拉起 |
| `lib/adapters/onebot12.mjs` | OneBot 12：WS + `POST /`；字符串 id，`mention`/`reply` 段，图片只有 `file_id` | 脚本本体 | 同上 |
| `lib/adapters/satori.mjs` | Satori：应用连 SDK（`WS /v1/events` + `POST /v1/{resource}.{method}`），`content` 是类 XHTML 元素串 | 脚本本体；编解码函数可单测 import | 同上 |
| `lib/adapters/milky.mjs` | Milky 1.3：`WS /event` + `POST /api/:api`，事件信封 `{event_type, data}`，`message_seq` | 脚本本体 | 同上 |
| `lib/adapters/qq-official.mjs` | QQ 开放平台 API v2：WS 网关或 Webhook（Ed25519 签名） | 脚本本体 | 同上 |
| `lib/onebot-adapter.mjs` | 兼容入口，仅一行 `import './adapters/onebot11.mjs'` | — | `package.json` 的 `exports["./adapter"]` |

**扩展点**（其余文件基本不用动）：加协议 → 新写 `lib/adapters/<协议>.mjs` + 在 `lib/index.js` 的 `ADAPTER_FILES` 与 `lib/config.js` 加一项；加协议动作 → 改对应适配器的映射表；加 Agent 工具 → 只改 `lib/tools.js`。

**测试与发布**：`test/run-all.mjs` 汇总 **28 个套件 / 1018 项**（5 个协议各一套，其余为插件/权限/设置/搜索/生图/历史/授权链路等），每个协议都自带零依赖假协议端（OneBot 11 的是 `test/mock-onebot.mjs`，其余在各自 `test-adapter-*.mjs` 内）；`npm test` 即跑全部。进 npm 包的只有 `lib/`、`cordis.patch.yml` 与根目录文档（见 `package.json` 的 `files`），`test/`、`examples/` 只在仓库里。

## 3. 关键数据流

### 3.1 入站消息（以群消息为例）

| # | 位置 | 做什么 |
| --- | --- | --- |
| 1 | `lib/adapters/*` | 收协议事件，归一成 CONTRACT 的 `message` 帧写 stdout（文本、图片数/URL、`reply_to`、段数组、`self_id`） |
| 2 | `index.js onAdapterFrame` | 按行切 JSON，`message` 交给 `acceptMessage` |
| 3 | `acceptMessage` | 自过滤（`user_id === self_id`）→ **群管理指令优先**（`handleAdminCommand`，命中即结束，不进模型）→ 白名单 → `commandPrefix` → 是否点名（@bot / 回复 bot / 前缀）→ 收集被回复消息里的图片 |
| 4 | `session.js sessionRoute/getEntry` | 按拥有者/访客取或建会话（`sessionController.create` + `resolveAgent`，只建一次）；记 `entry.speaker`（鉴权依据）与 `entry.currentFrame`（qq_history 的识图锚点） |
| 5 | `entry.queue`（串行） | `runTurn`：设 `entry.dshAllowed` → `describeImages`（下载 → `attachments.saveImage` → `llm` 视觉）→ `agent.followup` → `agent.whenIdle` |
| 6 | `extractReply / sendReply / chunkText` | 只取本条用户消息之后的新 assistant 文本，按 `reply.maxChars` 分片，写 `send` 帧 |

回合必须走 `entry.queue`：同会话并发会让 `whenIdle` 等错回合、`dshAllowed` 互相覆盖。

### 3.2 出站发送

| 步骤 | 位置 | 形态 |
| --- | --- | --- |
| 1 | 插件 | `{type:'send', message_type, target_id, text}` 或带 `message:[段]`；段数组优先，其次 `text`。可选 `reply_to`、`echo` |
| 2 | 适配器 | 进 `createSendQueue`（`gapMs` 节流，默认 350ms；Milky 规范频控默认 900ms） |
| 3 | 适配器 | 翻译成协议 API：`send_group_msg` / `message.create` / `send_message` / `send_group_message` / QQ 官方 msg_type |
| 4 | 适配器 | 回 `send_result{ok, echo, message_id, error}`；发送失败也回帧，不抛到顶层 |

引用回复只在群聊且 bot 被点名时附加（`reply_to`），分片每片都带。

### 3.3 动作调用（群管理、查历史、查被回复消息）

`callAdapterAction(action, params, timeoutMs)`（默认 12s）写一行 `{type:'action', action, params, echo}` → 适配器**映射成该协议的 API**（映射不了就回 `ok:false`）→ `action_result{action, echo, ok, data, error}` 按 `echo` 兑现 `state.pending` 里的 Promise；超时 resolve 成 `ok:false` 而不是挂死。

调用方：`qqgroup` 工具、`qq_history` 工具、主动发言取历史、`isReplyToSelf` 查 `get_msg`。

### 3.4 拥有者改设置（qqconfig 工具）

1. `checkCaller`：身份只取自当前会话的 `entry.speaker`，**只允许拥有者私聊**；工具参数里的 QQ 号一律不作数。
2. `show / propose / apply / cancel`：`propose` 只校验不写盘，返回一次性确认码（TTL 5 分钟，绑定 owner + path + value + revision）。
3. 白名单 `SPECS`（群/私聊开关、白名单、回复长度、主动发言…）；密钥、连接参数、`auth.owners` 等按 `DENY_PATHS` 硬拒。
4. `apply` 前复核 `revision`（期间被别人改过就作废），再 `ctx.settings.update(ns, patch, revision)` —— schema 校验 + 原子写 + 热重载，本模块不写任何 YAML。
5. 限流（每小时 6 次 / 每天 30 次）+ 审计行追加到 `<QQ_msg>/qqbot-config-audit.jsonl`。

### 3.5 废弃配置自动清理（升级删字段之后）

1. 起点：DSH 写设置是**合并**语义（`settings.write()` 最后一步 `mergeLayers(strip(raw, form), next)`）——只替换 schema 认识的字段。
   版本升级删掉的键不会进入 `next`，于是永远留在 `cordis.patch.yml` 里；Schemastery 对未知键也不报错，它们既不生效也不会自己消失。
2. 触发：插件启动后（延时 1.2 秒）与每次保存设置（`loader/volatile-update`，延时 0.3 秒）各跑一次 `cleanupStaleConfig()`。
3. 识别：`configEditor.configuration()` 里按 id / name **精确匹配**本插件那一行，取 `override`（profile 层）交给
   `staleConfigPaths()`；它沿 schema 的 `dict` 下钻，schema 里没有的键按**最浅的一层**报出来（整段未知只报父键）。
   路径用键名数组表示，键名本身带点（`a.b`）也不会被拆成嵌套路径。
4. 写回：`configEditor.edit()` 是唯一能真正删键的入口（`settings.update / mutate` 都是合并，删不掉）。
   基座用 profile 层的 `override`，不用回调给的 `current`——`current` 是各层同 id 后行整段替换后的最终配置，
   拿它当基座会把上层 patch 抄进 profile 行。
5. 收尾：没有废弃键时一次盘都不写；删掉的键连同旧值打进日志。写回对 loader 属于非 volatile 变更，
   会重挂一次插件（适配器断连重连），一次性，不会自激。


### 3.6 编排工具闸门与产物投递（`flowAuth`，默认关）

| # | 位置 | 做什么 |
| --- | --- | --- |
| 1 | `session.js` 接管块 | 开关打开时，在**本 agent 的 tools 作用域**里给 `subagent` / `subagent_fork` / `spawn_teammate` / `workflow` 各注册一个同名遮蔽层：先问闸门，放行才把参数原样转给被遮蔽的实现；单个工具注册失败就退回 `tools.restrict({deny})` 收掉它 |
| 2 | `flow-auth.js` | `requestAuth` 记一条待授权；私聊里 `/auth <6位码>` 命中即 `consumeToken`（30 秒窗口、同窗口不可重放、连错 5 次锁 15 分钟），落成一条 **grant** |
| 3 | `session.js` guard | 工具真正执行前查闸门：一次 grant 只够一次消费；放行时记一笔账，同一回合里遮蔽层不再二次消费 |
| 4 | `entry.turnSpeaker` | 身份按**回合快照**固化——排队期间别人插话，不会把访客的调用判成拥有者的 |
| 5 | `workspace.js sessionWorkdir` | 开关打开时给会话独占 `QQ_msg/<会话id>`；这一轮跑完只扫这个目录里新增/改动的文件（隐藏文件跳过、符号链接不跟、`flow.maxBytes` / `flow.maxFiles` 截断） |
| 6 | `index.js deliverFlowArtifacts` | 按 `flow.deliver` 回传（默认私聊，`group:<群号>` 丢群，`none` 只回文字）；打包输入经 `artifactInputLines` 归一化，防 `zip -@` 把文件名当参数 |

中间发言（interim）走同一条发送队列：先发一条无引用的短句，本轮结束后的结论才带 `reply_to`，用户不必等整轮跑完才收到第一声。

## 4. 设计取舍

| 决策 | 为什么 |
| --- | --- |
| 适配器跑独立子进程 | DSH 动态插件沙箱不提供 `fetch`/`WebSocket`；子进程能用完整 `node:*`，适配器崩溃也不带垮插件（由 `scheduleRestart` 退避重启） |
| 零依赖手写 WS | 插件以单文件/包分发，不引 `ws`；`lib/bridge/ws.mjs` 一处实现，五个适配器与测试共用 |
| 中间表示沿用 OneBot 11 风格段 | 0.9 及以前的插件内核已按它写；新协议只做双向翻译，内核零改动即可接五种协议 |
| 段数组优先、`text` 兜底 | 保留 `at`/`image`/`reply` 结构（引用回复、识图、群指令都要）；`text` 只给模型看，图片用 `[图片]` 占位 |
| 适配器与插件走 stdio 换行 JSON | 跨平台、不占端口、可以单独手跑适配器调试（手打一行 JSON）、`echo` 天然关联请求与响应 |
| 适配器只回结果不回异常 | 发送/动作失败统一回 `ok:false` + 可读 `error`，插件不感知协议细节 |
| 权限三路并行取并集 + fail-closed | 静态名单、群维度动态授权、本群身份互补；查不到就按最低权限 |
| 访客工具闸用白名单 + 每次执行求值 | 黑名单易漏（如 PTC 的 `run_code`）；按消息增删工具会让工具面抖动、多耗 token，故用可变标志位 |
| 发送走队列限速 | 平台有频控；每适配器自带 `--send-gap-ms`，默认 350ms（Milky 900ms） |
| `reply` 段不写进正文 | 写 `[回复]` 会让「引用 + `/mute`」的正文以 `[回复]` 开头，斜杠不在首位，群指令永远匹配不上 |
| 同名接管而非替换 | 高危工具本来就不该展示给一般对话 bot；在本 agent 的 tools 作用域里同名覆盖，DSH 正常会话的工具面完全不受影响，插件卸载后原样恢复 |
| 授权一次性消费 + 30 秒窗口 | 动态码会被截图/转发，所以只放行一次调用、只认当前 30 秒窗口（要求 NTP 对齐）；代价是每轮都要有人在私聊里回一条 |
| 回合身份快照 | 守卫读的是回合开始时的发言人；若读实时发言人，排队期间插话的访客就能被当成拥有者 |
| 产物只扫会话自己的目录 | 共用 `QQ_msg` 根时「谁写的新文件」分不出来，共用必然串会话，所以开关打开就独占一个会话目录 |
| 中间发言先出声、结论再引用 | 长任务里用户先收到「在做」，最终答案才带引用；两者走同一发送队列，顺序不会乱 |

## 5. 已知边界

### 5.1 协议差异

| 协议 | 技术形态 | 消息体 | 主要缺口 |
| --- | --- | --- | --- |
| onebot11 | 正向/反向 WS + HTTP；`Bearer` / `?access_token=` | CQ 码字符串或段数组 | 动作集取决于实现端（NapCat 最全，其他实现参差） |
| onebot12 | WS + `POST /`（永远 HTTP 200，看 `retcode`）；`Bearer` + `Sec-WebSocket-Protocol` | 段数组（`mention`/`reply`，图片只有 `file_id`） | 段类型少，未映射段降级成 `[暂不支持的消息段]` |
| satori | **应用连 SDK**（SDK 是服务端，与 OneBot 相反）：`WS /v1/events`（opcode 握手 + 心跳）+ `POST /v1/{resource}.{method}`；`Bearer` + `Satori-Platform`/`Satori-User-ID` | `content` 元素串（如 `hi<at id="1"/>`） | 无群名片/管理员/戳一戳；`channel_id` 靠事件缓存或约定重建；`upload.create`（multipart）未实现 |
| milky | `WS /event` + `POST /api/:api`；`Bearer` 或 `?access_token=` | 段数组（`mention`/`mention_all`） | 响应没有 `echo`，只能看 `retcode`；临时会话撤回受限 |
| qq-official | WS 网关或 Webhook 回调（Ed25519 签名）；`QQBot` token 2 小时刷新 | 上行 `content` + `attachments` + `ark` | 无 `at` 段、无 ARK 发送；ID 是 OpenID 不能反查；发图要先换 `file_info`；主动消息强频控 |

### 5.2 插件实际消费的帧

插件只处理 `hello`、`listening`、`status`、`message`、`action_result`、`notice`（仅计数，无业务分支）、`send_result`、`log`、`error`。适配器还可以发 `request`、`heartbeat`、`pong`（CONTRACT 允许），但插件当前不消费——要加消费方，两边一起改。

### 5.3 不支持的能力怎么回答

- 动作：`action_result{ok:false, error:'…不支持…（原因）'}`，绝不静默成功；插件把 `error` 原样交给模型/用户。
- 消息段：目标协议表达不了的段（合并转发、卡片、`at` 等）降级成可读文本占位，不丢整条消息。
- 信息：拿不到就填 `null`（群名片、群角色、昵称），不编造。

### 5.4 其他

- 本仓库不含协议端（NapCat / Koishi / Milky 服务端 / QQ 开放平台）和 QQ 客户端。
- 一个适配器进程对应一份连接配置（OneBot 11 反向模式可接多条链路，取第一条就绪的）；多账号未内建。
- 消息帧与发送帧的形状是插件与适配器的唯一耦合点，改动必须同步五个适配器与 `test/`。
- 配置改动分两类：连接方式（`protocol`/`mode`/各协议连接参数）变化会重启适配器；其余 volatile 字段就地生效，下一轮消息即生效。
