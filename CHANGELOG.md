## 0.10.1 —— 主动发言不再对同一件事重复回复

一句话：修掉「主动发言时对一件已经聊完的事再回一次」的 bug，并给了可关的开关。

### 修复

- 新增**事件闸**（`proactive.eventGuard`，默认开）。原来只有「频率」和「和上一条文本一模一样」两道闸，
  所以一件早就有人接过的事，只要换个说法就会再回一遍。现在开跑前先判断这件事还该不该接：
  - 最新消息距今超过 `staleMinutes`（默认 15 分钟）→ 视为事件已过气，不接；
  - 最新一条是「行」「OK」这类短应答且不是提问 → 不插话（同一人 3 分钟内的补充说明不算应答）；
  - 最近 6 条只有两个人在来回说 → 视为两个人的对话，不硬插；
  - 同一话题在 `topicCooldownMinutes`（默认 120 分钟）内说过就不再重复，换说法（包含关系）也算同一件事。
- 去重记忆按群保存：最近 5 条发过的文本 + 最近 20 个话题 + 每条话题的时间，重启后重置。
- `lastSentAt` 改成发送时刻（原来是本轮开始时刻），最小间隔不再被上游延迟吃掉。

### 可选开关

- `proactive.eventGuard: false` 退回 0.10.0 的行为（只做频率与逐字去重）；设置页里是「事件去重（防重复回复）」。
- 阈值都可调：`staleMinutes`、`topicCooldownMinutes`。

### 测试

- `test/test-proactive.mjs` 从 28 项扩到 42 项（事件过气、短应答、两人对话、话题包含去重等）。
- 全套 18 个套件 / 628 项通过。
## 0.10.0 —— 多协议适配器（OneBot 11/12、Satori、Milky、QQ 官方）+ 拥有者设置通道

一句话：插件不再绑死 OneBot 11。同一套插件逻辑，换 `protocol` 就能接 OneBot 12、Satori（Koishi 生态）、
Milky 和 QQ 官方机器人开放平台；外加拥有者可以在 QQ 私聊里改自己的设置。

### 协议适配器（新）

- 适配器统一迁到 `lib/adapters/`，共享 `lib/bridge/`（手写 WebSocket、stdio 契约、消息段归一），
  仍然**零 npm 依赖**；`lib/onebot-adapter.mjs` 保留为兼容入口。
- 内部统一「中间表示」：一套消息段 + 一套 message 帧（见 `lib/bridge/CONTRACT.md`），
  各协议只做翻译，插件上层（会话、权限、历史、主动发言）完全协议无关。
- `protocol` 取值与传输：

  | 协议 | 适配器 | 传输 | 鉴权 |
  | --- | --- | --- | --- |
  | `onebot11`（默认） | adapters/onebot11.mjs | 正向/反向 WS + HTTP | access_token（Bearer / query） |
  | `onebot12` | adapters/onebot12.mjs | 正向/反向 WS + HTTP | access_token，反向 WS 需 Sec-WebSocket-Protocol |
  | `satori` | adapters/satori.mjs | WS /v1/events + HTTP RPC | Bearer + Satori-Platform / Satori-User-ID |
  | `milky` | adapters/milky.mjs | /event WS（或 SSE）+ /api | Bearer |
  | `qq-official` | adapters/qq-official.mjs | Webhook 或 WS 网关 | AppID/AppSecret → QQBot token，Webhook Ed25519 校验 |

- 新增 4 个适配器测试套件（onebot12 / milky / satori / qq-official），全部用本地假协议端，不连真实 QQ。

### 拥有者设置通道（qqconfig）

- 拥有者可以在 QQ 私聊里让机器人改自己的设置（不必手改 `cordis.patch.yml`）。
  防护分层：身份只取自当前会话发言人（必须命中 `auth.owners`）、只允许私聊、字段白名单
  （`auth.*` / `onebot.*` / 密钥 / 模型名硬拒绝）、值类型与范围校验、`propose`→`apply` 两步确认
  （token 300s、一次性、绑定拥有者+路径+值+配置修订号）、只走 DSH settings 服务落盘（不手改 YAML）、
  限流（每小时 6 / 每天 30）与审计日志 `QQ_msg/qqbot-config-audit.jsonl`。总开关 `auth.ownerSettings`。

### 其它

- `qqbot` 的 `send` 支持可选 `image`（本地图片绝对路径，只允许 `<QQ_msg>/qq-images` 内）。
- 修 `qq_imgsearch` 的本地文件白名单 bug：0.9.5 的 `meIsAllowedImageFile` 调用了未导入的
  `qqMsgRootSync`，ReferenceError 被吞掉后永远返回 false。工作区根解析抽到 `lib/workspace.js`。
- 新增 `lib/owner-settings.js`、`lib/workspace.js`、`lib/bridge/*`、`lib/adapters/*`；
  测试套件 14 → 18。

## 0.9.5 —— 主动发言（可选，默认关）

- 新增可选能力：按间隔看群里最近的消息，由模型自己判断要不要接话、接什么话题；默认关闭，且必须显式列群号才生效。
- 可控点：检查间隔、新消息门槛、免打扰时段、每小时 / 每天上限、两次发言最小间隔、最大字数、话题偏好、人设、演练模式、逐次判断日志。
- 安全阀：模型返回 speak=false 就不说话；发言前校验长度 / 链接 / ` / 重复；只有 verbose 才打印判断细节。
- 判断走 OpenAI 兼容接口（baseUrl / model / apiKey，留空复用生图配置），不依赖 DSH 会话模型。
- 新增 `test/test-proactive.mjs`（28 项），全套件 13/13、290 项。
- 修一处内部命名冲突：主动发言用的 buildPrompt 与插件原有回合提示词构造同名，改为显式别名。

## 0.9.4 —— qq_history：私聊历史 + 分页 + 按权限跨会话

- **私聊也能取历史**：之前 qq_history 只支持群聊（私聊直接报错）。现在当前私聊会用触发消息当锚点调 `get_friend_msg_history`，私聊里也能主动翻记录；`peer_id` 可指定别的私聊（需权限）。
- **分页**：新增 `before_seq`（上一页最旧的 message_id），返回里带 `next_before` 作为下一页游标；群聊用 `message_seq + reverseOrder`，私聊同样按锚点往前翻。
- **跨会话按权限取**（`lib/history-auth.js`）：当前会话随意读；拥有者 / 高级管理员可读任意群和私聊；群管理员只能读「自己是管理员（或已授权）且群在可管理范围」的群；别人的私聊只有拥有者/高级管理员可读。越权返回明确原因，不静默给空。
- 消息统一归一化成「新→旧」并按 message_id 去重；返回增加 `target` / `access` 字段说明读的是谁、凭什么权限。
- 新增 `test/test-history.mjs`（23 项：会话定向 / 越权判定 / 请求构造 / 归一化），全套件 12/12、262 项。
- 已在真实 NapCat 4.18.19 上验证：`get_group_msg_history`（带 message_seq 翻页）与 `get_friend_msg_history`（锚点）均 retcode 0。

## 0.9.3 —— 运行时兼容自检（不写死 DSH 版本）

- 新增 `lib/compat.js`：读取当前实际加载的 DSH 版本（`DSH_VERSION` 环境变量 → 从 `process.argv[1]` 向上找
  `@deepseek-ai/dsh/package.json` → 模块解析兜底），与声明支持范围比较后给出结论。
- 启动日志多一行：`运行于 DSH x.y.z（在声明支持范围内 / 超出支持范围 / 未能识别）`；
  `qqbot` 工具 `action="status"` 的 `runtime` 字段返回 `{dsh, supportingRange, compatible, note}`。
- 支持范围只维护两个常量（`SUPPORT_FLOOR = 0.1.7-0`、`SUPPORT_CEILING = 0.3.0-0`），
  不再逐版本维护兼容表；识别失败或超范围只提示，不影响收发消息。
- 已在 DSH 0.2.1-rc.2（线上）与 0.2.1-rc.3（隔离 profile）实测：七条工具注册齐全、启动无报错；
  新增 `test/test-compat.mjs`（14 项），全套件 11/11。
- 消息链路零改动：升级只多一行日志与一个状态字段。

## 0.9.2 —— 跨对话检索 + 旧会话向前兼容

- **不再清理旧会话**：当持久化的会话绑在别的工作区（例如 0.7 时代 workspace=/root 建的会话，
  升级后工作区变成 QQ_msg）时，DSH 会拒绝跨工作区复用同一 id。现在改为**保留旧会话**、
  用一个「工作区限定」的新 id（如 qqbot-group-123-ws1a2b3c）重开，历史一条不删。
- **跨对话信息调用**：配合 DSH 的 `@deepseek-ai/dsh-tool-session-query` 使用，Agent 可以
  session_search / session_event_search / session_trace / session_event_read 检索同工作区下的其他会话
  （QQ 的每个群/私聊都是一条会话，cwd 相同即互相可查）。
- **qq_history 支持跨群**：传别的 group_id 就能读其它群的消息（只读）。
- 新增 test/test-session-id.mjs（5 项）校验 id 回退稳定性；全套件 10/10。

## 0.9.1

- 生图（`qq_draw`）与人格设置正式发布；接口地址 / key / 模型 / 重试与轮询、人格开关 / 名字 / 设定、
  自定义 preset id 全部在「设置 → QQ 机器人」里。
- **撤回并重发 0.9.0**：0.9.0 的文档示例里带了维护者个人的中转站地址、设置占位带了个人人格名，
  已从历史中移除该版本并重发为 0.9.1（功能一致，无任何个人痕迹）。
- 人格默认留空：默认不注入任何身份设定，只有自己填了才会生效（自己用的配置属于部署侧，不进仓库）。
- 贡献者：[@arrow1031](https://github.com/arrow1031)（0.9.x 生图与人格）、[@nd002723](https://github.com/nd002723)（0.8.0 并入的模块化重构与 qq_history / qq_websearch / qq_webfetch / qq_imgsearch）。
- 修合并遗留的 `qqbot` send 分支未注入 `writeToAdapter` 的问题。
- 新增 `lib/imagegen.js` 与 `test/test-imagegen.mjs`（16 项）；全套件 9/9、220 项。

## 0.9.0 —— 生图（qq_draw）与人格都进设置

- 新增工具 `qq_draw`：按描述画图并直接发到当前 QQ 会话；接口地址 / key / 模型 / 尺寸 / 重试与轮询全在「设置 → QQ 机器人」里填，插件不内置任何 key。
- 生图容错：`429 / 5xx / 网络错 / 空结果` 自动重试（`maxAttempts` / `retryIntervalMs`）；`4xx` 直接报错；供应商返回 `task_id` 时继续轮询（`pollIntervalMs` / `maxPolls`，依次尝试三种轮询路径）。
- 参考图：`reference` 支持公网 URL 或 `qq-images` 下的本地图，用来保持同一人物形象（做「自拍」）。
- 人格进设置：新增 `persona`（开关 / 名字 / 设定），每个新会话第一轮附一次身份设定；新增 `agentPresetCustom`，自建 preset id 直接接管整档人格与工具面。
- 修掉合并时留下的隐患：`qqbot` 工具 `send` 分支引用了未注入的 `writeToAdapter`（发送必然失败），现已正式注入工具层。
- 新增 `lib/imagegen.js`（不依赖 Cordis，可单测）与 `test/test-imagegen.mjs`（16 项：URL 拼接、响应解析、重试、轮询）；全套件 9/9、220 项。

## 0.8.2

文档纠正到当前状态（无代码改动）：

- README 头部改为「本仓库即维护主干、已解除封版、0.8.x 要求 DSH >= 0.1.7」
- 架构图与文件清单更新为 0.8 的模块化结构（config / session / tools / admin / http / websearch / imgsearch / moli）
- 已验证表格与自测章节换成实测条数：8 个套件、204 项（adapter 19 / reverse 12 / plugin 76 / client 32 / admin 32 / http 17 / config 11 / websearch 5）
- 「维护状态」由「fork 自上游的继续维护版 / 原版已封版」改为「社区化维护中、不封版、跟随 main」
- 修复 CONTRIBUTING / SECURITY / PR 模板里的占位符残留，社区段补上 Discussions / 行为准则链接

## 0.8.1

- 修复：设置页「列表类字段」（群号白名单、私聊白名单、拥有者、可管理的群等）输入框吞掉逗号，
  只能填一个值。改为本地 draft 文本编辑，支持逗号 / 中文逗号 / 顿号 / 分号 / 空白分隔，失焦归一化。

## 0.8.0 — 合并下游分支（模块化 + qq_history / qq_websearch / qq_webfetch / qq_img）

首次把下游开发者分支（nd002723/dsh-qq-bot，0.6.3 → 0.6.11）并入主干，并把 0.7.0 的
DSH 0.2 服务访问契约移植到模块化代码上。

- 结构：单体 lib/index.js 拆分为 lib/{config,http,websearch,imgsearch,moli,admin,session,tools}.js
- 工具：新增 qq_websearch（多引擎组合搜索）、qq_webfetch（独立抓取）、qq_img（图片搜索/上传）、qq_history（AI 自取聊天记录）
- 工作区：QQ_msg 工作区自动创建，会话自动归入分组；群聊回复/引用机器人视同 @；被回复的图片识图
- 健壮性：本轮运行失败不再重发上一轮回复；失败提示总是作为回复发出（只输出状态码）
- 兼容：工具注册与访客工具闸改为 ctx.get('tools') / ctx.inject(['tools'])（DSH 0.2 契约），
  并保留 0.1.x 属性形态兜底
- 测试：node test/run-all.mjs（含 config/http/websearch/plugin 套件）
- 社区化：完全解除封版（安装跟随 main，不再锁 tag）；启用 Discussions；
  新增 CONTRIBUTING / CODE_OF_CONDUCT / SECURITY / issue 与 PR 模板 / CODEOWNERS；
  邀请下游开发者 @nd002723 为协作者

# 更新日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## 0.6.8

模块化重构 + qq_history：聊天上下文改为 AI 主动自取（不再硬塞），业务代码按模块拆分。

- **模块化重构**：`lib/index.js`（原 3346 行单文件）拆成模块——保留 napcat 通信与子进程监管（`lib/onebot-adapter.mjs`），抽出网络查询通道（`lib/http.js` 通用 HTTP 传输 / `lib/websearch.js` 联网搜索 / `lib/imgsearch.js` 图片反搜）、dsh-moli 联动（`lib/moli.js`）、配置契约（`lib/config.js`：`DEFAULTS` + `Config` + `plainConfig`/`mergeConfig`）；业务再拆三块——`lib/admin.js`（权限三路鉴权 + 群管理指令 `handleAdminCommand`/`planAdminCommand`/`runGroupAction`）、`lib/session.js`（会话条目与路由 `getEntry`/`sessionRoute`/`entryForAgent` + 被回复图片收集）、`lib/tools.js`（6 工具动态注册）；`lib/index.js` 只留 napcat 通信 + 装配与生命周期（1906 → 845 行）。所有外部请求仍走 `webSearch.proxy` 管控（留空直连、非空走 CONNECT 隧道、非公网 IP 拒绝）。
- **qq_history（新工具，AI 自取聊天记录）**：不再自动把群内「最近相关发言」硬塞进会话——`acceptMessage` 里的 `fetchReplyContext`/`replyTargetQQs` 已删除，需要历史上下文时由 Agent **主动调 `qq_history`** 拉取（prompt 有引导）。
  - 返回结构化消息列表：`{ok, group_id, messages:[{time, user_id, nickname, text, images:[{url, description}]}]}`，参数 `group_id`（默认当前群）/ `user_id`（可选筛人）/ `count`（默认 20，上限 50）/ `with_images`（默认开）。
  - **识别窗口锚定「最新提及」**：只对触发本条回复的那条消息（@ bot / 回复 bot / 命令前缀）**往前 `scopeMessages` 条**内的图片做识别（默认 5），最多 `imageLimit` 张（默认 3，最近的优先）；更早的 @ 不锚定、其附近图片不因「也是被提及」而识别，避免重复拉取/重复识图。
  - 窗口内图片用现有视觉链路（下载 + `askVision`）识别，返回 URL + 描述；识别失败只给 URL 不阻塞。修复：工具 execute 不再闭包未定义的 `entry`（原会 ReferenceError），改由执行上下文 `exec.agent` 经 `entryForAgent` 反查当前会话。
- **被回复消息的图片仍走视觉识别**：`collectReplyImageUrls` 保留「用 `get_msg` 拉被回复消息、收集图片并入识图」的能力（回复引用流程不受影响），但不再把被回复消息文本塞进上下文。
- **访客白名单**：默认加入 `qq_history`。
- **新配置段 `history`**：`scopeMessages`（识别窗口条数，默认 5）/ `imageLimit`（窗口内最多识图张数，默认 3），设置页可改。
- **测试**：`npm test` 全绿（adapter 12 / plugin 88 / client 32 / admin 36）；新增 4f 段（工具注册 / 白名单 / 结构化拉取 / 窗口锚定 / 限张），旧「自动塞上下文」断言全部翻转为「不再自动携带」。

## 0.6.7

继续维护版：qq_websearch 的 url 抓取拆成独立工具 qq_webfetch，新增 dsh-moli 接管。

- **qq_webfetch（新独立工具）**：从 qq_websearch 拆出 url 抓取，平级注册；受 `webSearch.proxy` 管控（留空直连、非空走 HTTP CONNECT 隧道 + TLS），抓取前校验目标为公网 IP（内网/回环/私有地址一律拒绝）。
- **dsh-moli 接管（qq_webfetch）**：设置页新增 `moli` 段（默认关）——开启后 qq_webfetch 改用 Moli 无头浏览器渲染抓取（可抓 SPA/JS 渲染页）；HTTP 代理自动透传 `webSearch.proxy`（可被 `moli.proxy` 覆盖）；未检测到 moli 引擎时开关无效，工具返回 `moliUnavailable` 明确报错。
- **访客白名单**：默认加入 `qq_webfetch`。

## 0.6.6

继续维护版：群聊「回复机器人」视同 @ 处理，bot 被点名时改用 QQ 引用回复，命令前缀视同点名；点名但无正文也处理。

- **回复（引用）bot 消息视同 @ 处理**：群聊里没 @ 机器人、但回复（引用）了 bot 的消息，照常进入 Agent 旅程；开关 `reply.botReply`（设置页「回复」区，默认开启）。判定方式：调 NapCat `get_msg` 查被引用消息的发送者是否为 bot 自己。
- **追加最近相关发言上下文**：回复 bot 触发时，调 NapCat `get_group_msg_history` 筛出**该对话者 + bot** 的最近最多 **5 条**发言，按时间正序并入 Agent 输入（`【HH:MM】对话者/bot：内容`）。
- **「回复别人 + 正文 @bot」**：同样触发（引用回复 + 拉上下文）；上下文把**被回复者 / 被 @ 对象**的发言也并入，扩充到 **8 条**。
- **「回复 bot + 正文 @别人」**：这条可能不是对 bot 说的——消息照常进模型，但**不强制引用回复**，交给 bot 自行判断是否继续回复。
- **QQ 引用回复（回复消息流程）**：bot 被点名（@ bot / 回复 bot / 命令前缀 / 管理指令）时的响应，统一**引用触发消息**发送（CQ `reply` 段）；`requireAt` 关闭后的普通闲聊不引用，避免每条群消息都变引用回复。
- **命令前缀视同点名**：设置了 `commandPrefix`（如 `/ai`）时，命中前缀的消息豁免 requireAt（不需要 @），并走引用回复——与群管理指令同理。
- **点名但无正文也响应**：bot 被点名（@ bot / 回复 bot / 命令前缀）时，即使消息没有正文（纯回复、纯 @、回复别人 + @bot 但没打字），照常进入 Agent 旅程——给 Agent 占位正文「（本条消息无正文，仅点名了 bot）」，结合上下文主动回应；普通空消息（未点名）仍跳过。
- **被回复消息始终并入上下文**：被回复（引用）的那条消息用 `get_msg` 按 id 单独拉取，不受最近历史窗口限制；上下文**最低保证 2 条**（被回复消息 + 发言人本条），不硬补其它群友。
- **被回复消息的图片也走视觉识别**：`get_msg` 拉被回复消息时一并收集里面的图片 URL，与本条消息的图合并交给插件原有的识图功能（`describeImages`）识别，识别文本并入 Agent 输入。
- **修复**：`requireAt` 关闭（群=全部）时，回复 bot 的消息此前不识别（不引用、不拉上下文）——现已修复，只要 `reply.botReply` 开启且消息带了被引用消息就查。
- **多引擎组合搜索（qq_websearch）**：`webSearch.multiEngine`（默认开，设置页有开关）——Tavily（配 `TAVILY_API_KEY` 才启用）→ DuckDuckGo（html→lite）→ Yandex / Bing / Wikipedia 并发兜底，全部请求受 `webSearch.proxy` 管控（留空直连、非空走 CONNECT 隧道）；关闭则落回官方 DeepSeek web_search。完全独立实现，不依赖任何其它插件。
- **测试**：`npm test` **161 项全绿**（test-plugin 81 项，新增无正文 / 窗口外被回复消息 / 最低 2 条兜底 / 被回复图片识别 / 多引擎搜索五组用例；admin 36 项）。

## 0.6.5

继续维护版：联网抓取走代理、固定会话名、访客白名单瘦身、设置页重排。

- **`qq_websearch` 新增 url 抓取模式**：`{url}` 直接抓指定网页原文（http/https，仅公网），返回 `{ok, url, status, text}`；与搜索共用 `webSearch.proxy`——非空时经 HTTP CONNECT 隧道 + TLS（含境内/境外分流），留空直连。抓取前校验目标为公网 IP，内网/回环/私有地址一律拒绝（防经代理扫内网）。
- **固定新建会话名**：`session.fixedName`（默认开启），新会话显示名钉死为 `群聊_<群号>` / `私聊_<QQ号>`，替代 LLM 自动起标题（用 DSH `sessionTitle.rename` 的 user 源标题，自动生成不会覆盖）；已建会话保持原名。
- **访客默认白名单瘦身**：移除 `web_fetch`，访客联网统一走 `qq_websearch`（搜索 + url 抓取，都经代理）；DSH 自带的 `web_fetch` 仅拥有者可用。
- **设置页重排**：字段按功能分 7 块（接入与范围 → 身份与权限 → 群管理 → 会话 → 回复 → 图片视觉 → 联网搜索），QQ 号类字段集中；`cordis.patch.yml` 键序同步排版（纯排版，值不变）。
- **测试**：`npm test` **144 项全绿**（test-plugin 45 项）。

## 0.6.4

继续维护版：访客联网搜索，工具面设置更顺手。

- **联网搜索工具 `qq_websearch`**：访客白名单搜索（DeepSeek web_search），`webSearch` 配置段可选代理 / 端点 / key 环境变量名 / 触发上限；key 自动走 DSH 凭据服务，`process.env` 兜底。
- **访客默认白名单**：扩为 `qqbot, qqgroup, qq_websearch, web_fetch`（`web_fetch` 只抓公网，内网 IP 由 DSH 拒绝）。
- **Agent preset 下拉**：设置页改为下拉选择（部署默认 / standard / ptc / minimal / cordis），只影响新会话；人格分离字段空位自动回落 `agentPreset`。
- **修复**：`inject` 补 `'tools'`，解决生产环境工具注册失败（`cannot get property "tools" without inject`）。
- **测试**：`npm test` **147 项全绿**。

## 0.6.3

继续维护版（fork 自 [arrow1031/dsh-qq-bot](https://github.com/arrow1031/dsh-qq-bot)）：工作区自动管理，会话自动归入分组。

- **工作区自动管理**：移除 `workspace` 配置项；自动读取 DSH 官方默认 Workspace 位置（`<系统 Documents>/deepseek-harness`），在其同级目录创建 `QQ_msg` 并注册为 DSH workspace——Web UI 侧栏的「QQ 消息」分组，**新会话自动归入该分组**（通过 Cordis `ctx.reflect.get('workspaceRegistry')` 免注入读服务，缺失时自动回退）。
- **图片缓存结算清理**：带图消息的原图缓存到 `QQ_msg/qq-images/<会话id>/`，会话结算后自动删除，会话与工作区保留。
- **测试**：`npm test` **133 项全绿**（test-plugin 38 项，含分组断言）。

## 0.6.2

继续维护版：图片视觉增强、图片缓存导出。

- **图片视觉**：`vision` 配置新增 provider / model 下拉选择（从 DSH 自定义 providers 选，协议 / baseURL / apiKey 沿用）；模型不支持图片时给可读报错并引导切换。
- **图片缓存导出**：带图消息的原图缓存到 `<QQ_msg>/qq-images/<会话id>/`，会话结算后自动删除；消息附上识图结果与图片路径，并提示 Agent 结合用户发言作答、需确认身份时提炼关键词联网查证，勿凭空猜测。
- **插件标准**：package.json 补 `engines.dsh` 版本范围与 `dsh.runtime: host`。
- **测试**：`npm test` **133 项全绿**（test-plugin 38 项）。

## 0.6.1

**适配 DSH 0.1.7：设置契约重做**。0.1.7 移除了 `ctx.settings.register()`，0.6.0 在 0.1.7 上会
注册失败（设置页整个消失）。除设置相关外，收发消息的链路没有变化。

- **根因**：0.1.7 删掉了 `packages/settings/settings-file`（独立的 `settings.yaml` 文档），
  并把 `settings` 服务重写成「直接读 profile 里每个插件条目的 Config schema」。因此
  **`ctx.settings.register(ns, schema, { base })` 不再存在**：设置表单改由**插件自己导出的
  Cordis `Config` schema** 承载，界面上的改动写回 profile 的 `cordis.patch.yml`。
- **Host**：新增 `export const Config`（schemastery）；所有出现在设置页里的字段标 `.volatile()`
  （`settings` 只允许 volatile 字段被编辑）；删掉 `settings.register` 调用；配置改从 Cordis
  求值后的 `config` 参数读取 —— volatile 字段是引用，要 `.get()`。
- **热更新语义变了**：0.1.7 里 volatile 字段变化**不会重挂插件**，`cordis-plugin-loader`
  只就地更新运行中 fiber 的引用并发 `loader/volatile-update`。所以改为监听该事件刷新配置；
  连接方式（模式 / 地址 / token）变化时才重启适配器，与旧行为一致。
- **客户端**：设置命名空间从自定义的 `qq-bot` 改为 **profile 条目 id `dsh-qq-bot`**
  （条目被改名时回退到「以 qq-bot 结尾」的唯一匹配）；按 0.1.7 的要求在 `inject` 里声明
  `remote` 与 `remote.settings`。
- **设置页归属**：用 `settings.configure({ auto: false }, ctx.fiber)` 声明「本插件的设置页由
  自带的『QQ 机器人』选项卡负责」，避免 DSH 再按 schema 自动生成一个重复页面。
- **依赖**：新增运行时依赖 `@deepseek-ai/schemastery@^3.18.4`（`Config` 必需；
  3.18.2 及更早没有 `.volatile()`）。
- **Windows 修复**（0.6.0 只在 Linux 验证过）：
  - 测试里 `import(path.join(...))` 在 Windows 上报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`，
    改用 `pathToFileURL()`；
  - `PROFILE_MODULES` 不再写死 `/home/dsh/.dsh/profiles/node_modules`，可用
    `DSH_PROFILE_MODULES` 覆盖；
  - 测试清理临时软链时不再对 junction 用 `fs.rmSync(recursive)`（会把目标目录删空），
    改用 `rmdirSync` / `unlinkSync`。
- 测试：**124 项全绿**。新增契约断言：`client.js` 里每个表单字段都必须是 volatile、
  `volatileForm(Config)` 非空、`accessToken` 是 secret、内部字段不进设置页；
  以及热更新断言（volatile 就地更新 → 重启适配器；非连接类改动不重启）。

## 0.6.0

- **访客工具闸**：非拥有者的消息驱动 Agent 时，禁用 DSH 内部工具（bash / 读写 / 子代理 / …）。
  实现为 `tools.guard`，只在建会话时注册一次，判据是可变标志位——因此不注入提示词、
  不改工具表、不记 `request/header`，**0 额外 token**，且保持单会话单历史。
- 采用**白名单**而非黑名单（`auth.guestToolAllow`，默认 `qqbot,qqgroup`），
  使 `run_code` 这类"不在全局层"的 PTC 保留传输也自动被挡。
- 会话分流（`ownerPreset` / `guestPreset`）**降级为可选的人格分离**，默认关闭；
  文档与设置页明确标注它不再是安全边界。
- 设置页新增「允许非拥有者使用 DSH 内部工具」「访客仍可用的工具白名单」。

## 0.5.0

- **权限模型重做**，改为三路并行取并集：
  1. 静态名单：`auth.owners`（拥有者，含永久授权）、`auth.superAdmins`（后台设定的高级管理员）
  2. 动态授权：群维度、可带时限，由拥有者或本群管理员授予，**不可跨群生效**
  3. 本群身份：`get_group_member_info` 查到 admin / owner
- 新增 `/whoami`、`/perms`、`/grant`、`/revoke`、`/grants`；权限来源会如实列出。
- **指令严格匹配**：前缀必须在消息首位；动词必须完全匹配；token 数必须落在
  该指令声明的 `[min,max]` 内，多余内容判为用法错误且不执行——防止聊天内容夹带
  指令样内容被误执行。
- Agent 工具 `qqgroup` 改用同一套鉴权，"说话人"取自本会话最近一条消息。
- **reply 透传**：适配器解析 `[CQ:reply,id=…]` 并输出 `reply_to`，
  `/recall` 因此支持"回复某条消息即可撤回"；同时 reply 段不再污染正文
  （否则正文以 `[回复]` 开头，斜杠就不在首位了）。

## 0.4.0

- 新增群管理：QQ 侧指令（`/mute`、`/kick`、`/banall`、`/card`、`/admin`、`/recall`、
  `/rename`、`/members`、`/info`、`/help`）+ Agent 工具 `qqgroup`。
- 适配器新增**通用 action 通道**，任意 OneBot 11 动作都可透传，无需为每个动作改代码。
- `notice` / `request` 事件改为**全字段透传**（此前丢了 `operator_id`、`duration`、
  `target_id`、`card` 等群管理必需字段）。
- 引入「演练模式」`admin.dryRun`：只回复将执行什么，不真执行。

## 0.3.2

- **修复** `registration.schema.toJSON is not a function`：设置命名空间的 schema
  必须同时是可调用的解析函数和可 JSON 化的对象。
- `access_token` 改为**只写字段**：不上发到浏览器，留空即不修改（避免保存时被清空）。
- **修复**保存成功后按钮卡在「保存中…」（`setSaving(false)` 漏在成功分支）。

## 0.3.1

- 文档补充升级注意事项：`dsh plugin add` 走 pnpm，按 tarball 完整性缓存，
  改代码必须打成**新版本号文件名**再装，否则会被判成 lockfile 最新而跳过。

## 0.3.0

- 新增**客户端半边**：在 DSH「设置」里贡献「QQ 机器人」选项卡，配置项全部可视化修改。
- 手写客户端 bundle（`window.__ModuleLoader__.load`），只 `require('react')`，无需打包器。
- 配置分两层：composition 行配置是 base 层，设置面板改的是用户层。

## 0.2.0

- 首个可安装的插件包：`dsh plugin --profile web add` 即自动注册为 profile 层。
- OneBot 11 适配器（零 npm 依赖，用 Node 22 内置 `WebSocket` / `fetch`）：
  正向 WebSocket 收事件 + HTTP API 发消息，自带指数退避重连与发送限速。
- 每个 QQ 会话对应一个 DSH Agent，会话落盘并出现在 Web UI。
- 群聊默认要求 @机器人，私聊直接回，长回复按换行分片。

## 0.1.0

- 未发布的原型：以「动态 Cordis Package」形式在运行的 DSH 进程里验证了完整链路
  （`examples/dynamic-package-host.js` 保留了这一形态）。
