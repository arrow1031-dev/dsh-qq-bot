# 适配器契约

插件只认这一套 stdio 帧，与底层协议无关。适配器是独立进程（`#!/usr/bin/env node`、ESM、Node ≥ 22、零 npm 依赖），
由插件 `subprocess.spawn` 拉起，用 stdin/stdout 换行分隔 JSON 通信；**stdout 只能出帧**，日志走 `log`/`error` 帧或 stderr。
现有实现 `lib/adapters/{onebot11,onebot12,satori,milky,qq-official}.mjs`，共用工具 `lib/bridge/{stdio,ws,segments}.mjs`。

## 1. 出帧（适配器 → 插件）

| type | 必填 | 可选 / 扩展 |
| --- | --- | --- |
| `hello` | `adapter`(协议 id), `mode`, `pid` | `mode` 取值 `forward`/`reverse`/`webhook`/`ws`（按协议）；传输摘要 `wsUrl` `httpUrl` `listen` `hasToken` `platform` `selfId` `protocolVersion` `appId` `intents` `path` `apiBase` |
| `status` | `connected`:bool, `links`:number | `reason`:string\|null；扩展 `mode` `platform` `selfId` |
| `message` | 见 §2 | — |
| `send_result` | `ok`, `echo`, `message_id`, `error` | `retcode`（`createSendQueue` 统一补，失败时 `message_id` 为 null） |
| `action_result` | `action`, `echo`, `ok`, `data`, `error` | `retcode`（只有 onebot11/onebot12/milky 给） |
| `listening` | `host`, `port` | `path`（qq-official webhook） |
| `notice` | `notice_type`, `raw` | `sub_type` `user_id` `group_id` `operator_id` `message_id`；扩展 `channel_id`(satori) `event_id`(qq-official) `milky_event_type` |
| `request` | `request_type`, `flag`, `raw` | `sub_type` `user_id` `group_id` `comment` |
| `heartbeat` | `status` | 只有 onebot11 / onebot12 发 |
| `log` / `error` | `text` | `log` 另有 `level`(`info`\|`warn`)；`pong` 需 `at` |

插件实际消费（`lib/index.js` 分支）：hello / listening / status / message / send_result / action_result / notice / log / error；
其中 `notice` 只计数。`request` / `heartbeat` / `pong` 允许发但当前不被使用（`pong` 由 `ping` 命令触发，供测试与诊断）。

## 2. message 帧

| 字段 | 类型 | 可空 | 规则 |
| --- | --- | --- | --- |
| `message_type` | `'group'\|'private'` | 否 | 临时会话（milky temp）归 private |
| `sub_type` | string\|null | 是 | 多数协议填 null；onebot11 透传平台值；milky 临时会话为 `temp` |
| `message_id` | string\|number\|null | 是 | 插件引用回复时 `Number()` 它（null 则不引用）；非数字 id 要适配器自己转 |
| `group_id` | string\|number\|null | 是 | 私聊必须 `null`（不能用 0 或空串兜底） |
| `user_id` | string\|number\|null | 是 | 发送者 id；QQ 官方是 openid 字符串（拿不到填 null） |
| `self_id` | string\|number\|null | 是 | 机器人 id；qq-official 靠 `--self-id` 或 READY/事件补 |
| `time` | number | 否 | Unix **秒** |
| `text` | string | 否 | 统一段渲染的纯文本（多数适配器直接 `summarizeSegments()`），图片为 `[图片]` |
| `images` | number | 否 | 图片段数量 |
| `image_urls` | string[] | 否 | 给视觉模型下载的地址，尽量是 http(s) |
| `reply_to` | string\|number\|null | 是 | 被引用消息 id，值域随协议（见 §3 `reply_to` 行） |
| `raw_message` | string\|null | 是 | 平台原始文本 / CQ 码 / content |
| `sender` | object\|null | 是 | `{ user_id, nickname, card, role }`；平台没这概念填 `null`（satori/qq-official 无 card）；整体 null 时插件显示「未知用户」 |
| `message` | array\|null | 是 | 统一段数组（见下）；onebot11 只有 CQ 串时为 null。插件当前不读它（只读下面的汇总字段与 `get_msg` 的 `data.message`） |
| `channel_id` | string | 是 | 仅 satori：回发通道 id（`group:123` / `private:456`） |

插件实际读取：`message_type` `group_id` `user_id` `self_id` `text` `images` `image_urls` `reply_to` `sender` `message_id`，其余字段不参与逻辑。

**按钮点击**（官方 v2 的 `INTERACTION_CREATE`）适配器会额外产出一条 `message` 帧（`sub_type: 'interaction'`，`text` 取按钮 `button_data`），原 `notice` 帧保留；插件靠 `message_id` 去重，同一次点击只起一个回合。

### 统一段（`lib/bridge/segments.mjs`）

`{ type, data }`：text(`text`) / at(`qq`，`all` 为全体) / image(`url` 或 `file`) / reply(`id`) / face / record / video / file / json / xml / forward / poke / mface。
未知段**降级为 text**，禁止抛错；`summarizeSegments(segments)` 一次产出 `{ text, images, imageUrls, replyTo }`。

## 3. 入帧（插件 → 适配器）

| type | 字段 | 说明 |
| --- | --- | --- |
| `send` | `message_type`, `target_id`, `text`, `message?`, `reply_to?`, `echo?`, `channel_id?`, `markdown?`, `keyboard?`, `typing?` | `message` 段数组优先，无则发 `text`；`markdown` 走官方 v2 的 msg_type=2（可带 `keyboard` 按钮）；`typing` 只尽力而为；必须回 `send_result`（`echo` 原样回传） |
| `action` | `action`, `params`, `echo` | OneBot 11 风格动作名；插件 12s 超时即判失败 |
| `ping` / `shutdown` | — | 回 `pong` / 退出码 0 |

`send` 的协议差异（**写适配器必须逐项处理**）：

| 字段 | 各协议 |
| --- | --- |
| `target_id` | 插件总是发字符串；onebot11/milky 转数字，onebot12/satori/qq-official 保持字符串 |
| `text` | 只在没有 `message` 段时使用 |
| `message` | 插件会发 `{type:'image',data:{file:'base64://...'}}`（qq_draw / qq_send 存图后回传），适配器必须同时接受 `url` 与 `file` |
| `reply_to` | 插件在群聊引用时传 `Number(frame.message_id)`。语义：onebot11=`message_id` / onebot12=`message_id`(字符串) / satori=`<quote id>` / qq-official=被动回复 `msg_id`(入站 `d.id`) / milky=`message_seq`（并须置于段数组首位） |
| `channel_id` | 只有 satori 读（覆盖由 group/private 推导的通道），其余协议忽略 |
| `echo` | 任意值，原样回传 |

动作约定：

- 能映射到本协议 API 就映射；不支持必须回 `ok=false`，`error` 写清「本协议不支持 xxx」，**不得假成功**。现有文案举例：milky `本协议不支持` / satori `该平台不支持` / onebot12 `实现端不支持该动作` / qq-official `QQ 官方 API 不支持`。
- `ok=true` 时 `data` 要给插件真正读取的字段：`get_group_info`→`group_name`/`group_id`/`member_count`/`max_member_count`；`get_group_member_info`→`role`；`get_group_member_list`→数组（`user_id`/`nickname`/`card`/`role`）；`get_login_info`→`user_id`；`get_msg`→`message`(统一段，图片段带 `data.url`)+`sender.user_id`；`*_msg_history`→`messages`（默认新→旧，`reverseOrder:true` 时升序，插件会再反转）。

## 4. 传输与鉴权（每个协议一行）

| 协议 | 事件面 | 控制面 | 鉴权 | 反向 / 回调 |
| --- | --- | --- | --- | --- |
| onebot11 | 正向 WS `--ws` | `--http` POST `/{action}`；无 `--http` 退回 WS action | `Authorization: Bearer` / `?access_token=` | `--listen` 反向 WS |
| onebot12 | 正向 WS `--ws` | `--http` POST `/` `{action,params,echo}`，或 WS action | 同上 | `--listen` 反向 WS |
| satori | 连 `<sdk>/v1/events`，10s 内 IDENTIFY{op:3}，之后 PING/10s | POST `<sdk>/v1/{resource}.{method}` | token 在 IDENTIFY body + `Authorization: Bearer`；另带头 `Satori-Platform` / `Satori-User-ID` | 只正向（SDK 是服务端） |
| milky | 正向 WS `/event`（SSE 同端点未实现） | POST `/api/:api`（与 `/event` 同端口） | `Authorization: Bearer` / `?access_token=` | `--listen` WebHook |
| qq-official | `--mode ws`：`/gateway` + identify/心跳/resume | HTTPS `api.bot.qq.com` | `Authorization: QQBot <token>`（appid+secret 换 2h token） | `--mode webhook --listen --path`，Ed25519 验签 + op13 验证 + `{"op":12}` ACK |

约定：JSON 一律 `content-type: application/json`；业务成败看平台自己的字段（OneBot `retcode`、Milky `retcode`、Satori 直接结果、QQ 官方 `code`），HTTP 200 不代表成功。

## 5. 骨架

```js
#!/usr/bin/env node
import { createEmitter, createSendQueue, installStdin, installCrashHandlers, postJson } from '../bridge/stdio.mjs';
import { createLinkSet, connectForward, startReverseServer, bearerOrQueryToken } from '../bridge/ws.mjs';
import { summarizeSegments } from '../bridge/segments.mjs';

const { emit, log, fail } = createEmitter();
const links = createLinkSet({ onStatus: (info) => emit({ type: 'status', connected: info.size > 0, links: info.size }) });
const queue = createSendQueue({ gapMs: 350, send: callApi, emit });   // 队列负责节流 + send_result
installStdin({ onCommand: handleCommand, onShutdown, onError: (t) => emit({ type: 'error', text: t }), onPing: () => emit({ type: 'pong', at: Date.now() }) });
installCrashHandlers({ onShutdown, onError: fail });
```

## 6. 测试要求

每个协议至少一个 `test/test-adapter-*.mjs`（onebot11 是 `test-adapter.mjs` + `test-adapter-reverse.mjs`，其余为
`test-adapter-<协议>.mjs`），文件名加进 `test/run-all.mjs` 的 `suites`；用**本地假协议端**（随机端口、HTTP + WS，
参考 `test/mock-onebot.mjs`），不连真实 QQ、不联网。至少覆盖：

1. 事件 → message 帧：字段齐全、`images`/`image_urls`、`reply_to`、`self_id`、群/私聊分支；
2. `send` → 平台 payload：群/私聊、`text` 与 `message` 段两条路径、`reply_to` 转换、`file:'base64://'` 图片；
3. 鉴权/握手与失败路径（token 错误、签名缺失等必须回失败帧而非静默成功）；
4. 不支持的动作返回 `ok=false`，且 `error` 含协议不支持字样。
