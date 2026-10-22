# 贡献指南

欢迎参与 dsh-qq-bot。本项目自 0.8.0 起转入社区化维护：fork、issue、PR 都欢迎，
活跃贡献者会被邀请进协作者名单。

## 环境

- Node >= 22.6
- DSH >= 0.1.7；0.2.x 已适配（见 README「DSH 0.2 兼容」）
- NapCat 或任意 OneBot 11 实现（正向 / 反向 WebSocket 均可）

## 本地开发

```bash
git clone https://github.com/arrow1031-dev/dsh-qq-bot.git
cd dsh-qq-bot
npm install
node test/run-all.mjs
```

单元测试用假的 OneBot 服务端（test/mock-onebot.mjs），不需要真 QQ。

## 分支与 PR

- `main` 保持可发布；功能与修复走 `feat/xxx`、`fix/xxx` 分支，PR 目标 `main`。
- PR 描述写清：改了什么、影响哪些路径、怎么验证的。
- 合并前 CI 与 `node test/run-all.mjs` 必须全绿。

## 提交信息

`type(scope): 一句话`，type 取 `feat` / `fix` / `docs` / `refactor` / `test` / `chore`。
示例：`feat(tools): 新增 qq_translate 工具`。

## 代码约定

1. **工具注册**：一律走 `lib/tools.js` 的 `registerTool(ctx, make)`。
   DSH 0.2 的 Cordis Guard 不允许直接读 `ctx.tools`，必须先 `ctx.get('tools')`，
   未就绪时用 `ctx.inject(['tools'], ...)` 动态挂载。绕过它会静默丢掉工具。
2. **配置**：新字段加到 `lib/config.js` 的 `DEFAULTS` 与 `Config`，可热改的标 `.volatile()`；
   设置页字段在 `lib/client.js` 的 `FIELDS` 里加。
3. **测试**：新增行为在 `test/` 补用例，并挂到 `test/run-all.mjs`。
4. **文档**：面向用户的行为变化写进 `CHANGELOG.md`；结构变化同步 `ARCHITECTURE.md`。

## 版本与发布

维护者合并后在 `main` 打 tag（`vX.Y.Z`）并发 Release。安装方式跟随 `main`，不再锁死某个 tag。

## 成为协作者

持续贡献（2 个以上被合并的 PR）后，维护者会邀请你成为 collaborator（write 权限：可在本仓库推分支、管 issue/PR；
个人仓库不提供 maintain 角色，改仓库设置仍只有维护者能做）。也可以在 Discussions 里自荐。
