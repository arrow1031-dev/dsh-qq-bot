# 贡献指南

欢迎参与 dsh-qq-bot。本项目自 0.8.0 起转入社区化维护：fork、issue、PR 都欢迎，
活跃贡献者会被邀请进协作者名单。

## 环境

- Node >= 22.6
- DSH >= 0.2.0-rc.2（0.2.1 系列 rc.2 / rc.3 已实测；见 README「DSH 0.2 兼容」）
- 协议端：NapCat / Lagrange（OneBot 11）、OneBot 12 实现端、Koishi（Satori）、Milky 协议端，或 QQ 开放平台机器人（见 README「三、协议与连接方式」）

## 本地开发

```bash
git clone https://github.com/arrow1031-dev/dsh-qq-bot.git
cd dsh-qq-bot
npm install
node test/run-all.mjs
```

所有测试都用本地假协议端，不需要真 QQ：OneBot 11 用 `test/mock-onebot.mjs`，其余协议各自的 `test/test-adapter-*.mjs` 自带假服务端。

## 分支与 PR

- `main` 保持可发布；功能与修复走 `feat/xxx`、`fix/xxx` 分支，PR 目标 `main`。
- PR 描述写清：改了什么、影响哪些路径、怎么验证的。
- 合并前 CI 与 `node test/run-all.mjs` 必须全绿。

## 提交信息

`type(scope): 一句话`，type 取 `feat` / `fix` / `docs` / `refactor` / `test` / `chore`。
示例：`feat(tools): 新增 qq_translate 工具`。

## 代码约定

1. **工具注册**：一律走 `lib/tools/index.js` 的 `registerTool(ctx, make)`。
   DSH 0.2 的 Cordis Guard 不允许直接读 `ctx.tools`，必须先 `ctx.get('tools')`，
   未就绪时用 `ctx.inject(['tools'], ...)` 动态挂载。绕过它会静默丢掉工具。
2. **配置**：新字段加到 `lib/config.js` 的 `DEFAULTS` 与 `Config`，可热改的标 `.volatile()`；
   设置页字段在 `lib/client/settings.js` 的 `FIELDS` 里加。
3. **测试**：新增行为在 `test/` 补用例，并挂到 `test/run-all.mjs`。
4. **新协议**：读 `lib/transport/bridge/CONTRACT.md`，在 `lib/transport/adapters/` 下加一个 stdin/stdout 适配器，再到 `lib/transport/index.js` 的 `ADAPTER_ENTRIES` 与 `lib/config.js` 的 `protocols` 登记；适配器必须零 npm 依赖，并自带上限为一条的协议端假服务端测试。
5. **文档**：面向用户的行为变化写进 `CHANGELOG.md`；结构变化同步 `ARCHITECTURE.md`；新协议写进 README 的协议表。

## 版本与发布

维护者合并后在 `main` 打 tag（`vX.Y.Z`）并发 Release。安装方式跟随 `main`，不再锁死某个 tag。
自动化：`.github/workflows/release.yml` 在 push 到 `main` 且改动包含 `package.json` 时跑全量测试并发布，Release 正文取「首次引入该版本号的提交信息」；`ci.yml` 对每次 push / PR 跑 `npm test`。

## 成为协作者

持续贡献（2 个以上被合并的 PR）后，维护者会邀请你成为 collaborator（write 权限：可在本仓库推分支、管 issue/PR；
个人仓库不提供 maintain 角色，改仓库设置仍只有维护者能做）。也可以在 Discussions 里自荐。
