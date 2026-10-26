# 安全策略

本插件把 QQ 消息转给 DSH Agent，涉及工具权限与凭据。支持的版本：最新 `main` 与最近一个 tag。

## 报告渠道

- **不要**在公开 issue 里贴 access_token、QQ 号、服务器地址、Agent 工具输出。
- 发现权限绕过、命令注入、凭据泄漏一类问题，走私信：开一个只写「安全问题，请私聊」的 issue（不写细节），或直接联系维护者 [@arrow1031](https://github.com/arrow1031)。
- 目标响应时间：48 小时内首次回复；确认后 7 天内给出修复计划。

## 拥有者设置通道（qqconfig）的威胁模型

0.10 起拥有者可以在 QQ 私聊里让机器人改一部分设置。这条通道按「能被社工、也能被自己手滑」设计：

- **身份不可伪造**：判定依据是当前 QQ 会话最近一条消息的发言人，不是工具参数里的字符串；插件重启后待确认的 token 全部失效（只存在内存里）。
- **场域限制**：只在拥有者私聊里可用；群里调用直接拒绝。
- **字段白名单**：`auth.*` / `onebot.*` / `imageGen.*` / `webSearch.*` / `proactive.model` / `proactive.speakProvider` / `proactive.speakModel` / `mode` / `adapterPath` 等硬拒绝，即使有人误加进白名单也会被 `DENY_PREFIXES` 二次挡下——机器人无法通过这条通道给自己扩权。
- **两步确认 + 修订号**：`propose` 不落盘；`apply` 时若配置已被设置页改过（revision 变化）则作废。
- **落盘不经手 YAML**：只调 DSH settings 服务（schema 校验、原子写、热重载）；服务不可用时拒绝，不退化成手写 `cordis.patch.yml`。
- **限流与审计**：默认每小时 6 次 / 每天 30 次；每次结果追加到 `QQ_msg/qqbot-config-audit.jsonl`。
- 总开关 `auth.ownerSettings`，关掉即彻底禁用。

发现任何绕过（非拥有者触发写入、白名单外的字段被改、审计缺失）请按上面的渠道私信。
