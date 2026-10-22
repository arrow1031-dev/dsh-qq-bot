# 贡献指南

欢迎参与 dsh-qq-bot。本项目自 0.8.0 起转入社区化维护：fork、issue、PR 都欢迎，
活跃贡献者会被邀请进协作者名单。

## 环境

- Node >= 22.6
- DSH >= 0.1.7；0.2.x 已适配（见 README「DSH 0.2 兼容」）
- NapCat 或任意 OneBot 11 实现（正向 / 反向 WebSocket 均可）

## 本地开发

FENCEbash
git clone https://github.com/arrow1031/dsh-qq-bot.git
cd dsh-qq-bot
npm install
node test/run-all.mjs
FENCE

单元测试用假的 OneBot 服务端（test/mock-onebot.mjs），不需要真 QQ。

## 分支与 PR

- BTmainBT 保持可发布；功能与修复走 BTfeat/xxxBT、BTfix/xxxBT 分支，PR 目标 BTmainBT。
- PR 描述写清：改了什么、影响哪些路径、怎么验证的。
- 合并前 CI 与 BTnode test/run-all.mjsBT 必须全绿。

## 提交信息

BTtype(scope): 一句话BT，type 取 BTfeatBT / BTfixBT / BTdocsBT / BTrefactorBT / BTtestBT / BTchoreBT。
示例：BTfeat(tools): 新增 qq_translate 工具BT。

## 代码约定

1. **工具注册**：一律走 BTlib/tools.jsBT 的 BTregisterTool(ctx, make)BT。
   DSH 0.2 的 Cordis Guard 不允许直接读 BTctx.toolsBT，必须先 BTctx.get(tools)BT，
   未就绪时用 BTctx.inject([tools], ...)BT 动态挂载。绕过它会静默丢掉工具。
2. **配置**：新字段加到 BTlib/config.jsBT 的 BTDEFAULTSBT 与 BTConfigBT，可热改的标 BT.volatile()BT；
   设置页字段在 BTlib/client.jsBT 的 BTFIELDSBT 里加。
3. **测试**：新增行为在 BTtest/BT 补用例，并挂到 BTtest/run-all.mjsBT。
4. **文档**：面向用户的行为变化写进 BTCHANGELOG.mdBT；结构变化同步 BTARCHITECTURE.mdBT。

## 版本与发布

维护者合并后在 BTmainBT 打 tag（BTvX.Y.ZBT）并发 Release。安装方式跟随 BTmainBT，不再锁死某个 tag。

## 成为协作者

持续贡献（2 个以上被合并的 PR）后，维护者会邀请你成为 collaborator（maintain 权限：
可推分支、管 issue/PR，不能改仓库设置或删仓库）。也可以在 Discussions 里自荐。
