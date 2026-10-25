# 适配器契约（Adapter Contract）

插件本体（lib/index.js）**只认一种帧格式**，与底层协议无关。新增一个聊天平台/协议 = 写一个适配器脚本，
把该协议的事件翻译成下面的帧、把插件下发的发送请求翻译回该协议的 API 调用。

适配器是**独立进程**（插件用 child_process 拉起），通过 stdin/stdout 换行分隔 JSON 通信。
共用工具在 lib/bridge/（ws.mjs / stdio.mjs / segments.mjs），禁止引入 npm 依赖。

## 1. 适配器 -> 插件

| type | 何时发 | 字段 |
| --- | --- | --- |
| `hello` | 启动后立即 | `adapter`(协议 id), `mode`, 连接参数摘要, `pid` |
| `status` | 连接状态变化 | `connected`: bool, `reason`, `links` |
| `message` | 收到一条消息 | 见下 |
| `notice` | 群成员变动/撤回/戳一戳等 | `notice_type`, `sub_type`, `user_id`, `group_id`, `operator_id`, `raw` |
| `request` | 加群/加好友请求 | `request_type`, `flag`, `comment`, `raw` |
| `heartbeat` | 可选心跳 | `status` |
| `listening` | 反向/回调模式开始监听 | `host`, `port` |
| `send_result` | 发送完成 | `ok`, `echo`, `message_id`, `error` |
| `action_result` | 通用动作完成 | `action`, `echo`, `ok`, `data`, `error` |
| `log` / `error` / `pong` | 日志 / 错误 / 心跳回答 | `text` / `at` |

### message 帧（唯一必须精确实现的结构）

`````````json
{
  "type": "message",
  "message_type": "group" | "private",
  "sub_type": null,
  "message_id": "平台消息 id（字符串或数字都可以）",
  "group_id": "群 id 或 null",
  "user_id": "发送者 id",
  "self_id": "机器人自己的 id（能拿到就填）",
  "time": 1700000000,
  "text": "纯文本（已把图片/表情转成占位符）",
  "images": 0,
  "image_urls": ["https://..."],
  "reply_to": null,
  "raw_message": "原始文本（可选）",
  "sender": { "user_id": "...", "nickname": "...", "card": null, "role": null },
  "message": [ 消息段数组，见 lib/bridge/segments.mjs ]
}
`````````

要点：

- `text` 用于给模型看，图片用 `[图片]` 占位；`images` 是数量，`image_urls` 给视觉模型下载。
- `message` 用统一段（text/at/image/reply/face/...），插件会读取它做历史/引用判断。
- 平台没有的概念（群名片、群角色）填 `null`，不要编。
- 机器人自己发的消息也要上报（插件靠它区分自身消息），`self_id` 尽量填。

## 2. 插件 -> 适配器

| type | 含义 | 字段 |
| --- | --- | --- |
| `send` | 发一条消息 | `message_type`, `target_id`, `text`, 可选 `message`(段数组), 可选 `reply_to`, 可选 `echo` |
| `action` | 透传平台动作（群管理/查询） | `action`, `params`, `echo` |
| `ping` / `shutdown` | 心跳 / 退出 | — |

`send` 的实现要求：`message` 段数组优先，没有就发 `text`；完成后必须回一条
`send_result`（带 `echo` 原样回传，方便插件对账）。

`action` 不在本协议支持范围内时，回 `action_result` 且 `ok=false`，
error 写清「本协议不支持 xxx」，不要静默成功。

## 3. 适配器骨架

`````````js
#!/usr/bin/env node
import { createEmitter, createSendQueue, installStdin, installCrashHandlers, postJson } from '../bridge/stdio.mjs';
import { createLinkSet, connectForward, startReverseServer, bearerOrQueryToken } from '../bridge/ws.mjs';
import { summarizeSegments } from '../bridge/segments.mjs';

const args = parseArgs(process.argv.slice(2));
const { emit, log, fail } = createEmitter();
const links = createLinkSet({ onStatus: (info) => emit({ type: 'status', connected: info.size > 0, links: info.size }) });
const queue = createSendQueue({ gapMs: 350, send: callSend, emit });

// 1) 收事件 -> emit({ type: 'message', ... })
// 2) 收命令 -> queue.enqueue({ action, params, echo })
// 3) 发送/动作失败要回 результат，不要 throw 到顶层
`````````

## 4. 测试要求

每个协议至少覆盖：

1. 事件 -> message 帧的翻译（字段齐全、图片计数、引用 id、self_id 区分）；
2. 发送请求 -> 平台 payload 的翻译（群/私聊、文本/段数组、引用回复）；
3. 鉴权/握手（token、header、签名）与失败路径；
4. 不支持的动作返回 `ok=false`。

测试用假的平台服务端（参考 test/mock-onebot.mjs 与 test/test-adapter.mjs 的写法），
不要连真实 QQ。
