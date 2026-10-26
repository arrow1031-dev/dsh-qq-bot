# dsh-qq-bot —— 把 QQ 接到 DSH Agent

> **当前版本 0.11.x**：要求 **DSH 0.2.0-rc.2 或更新的 0.2.x 版本**（工具走 `ctx.get('tools')` 注入契约；DSH 0.2.1 系列 rc.2 / rc.3 已实测适配）。
>
> **⚠️ 设置页入口变了**：不再是「设置 → QQ 机器人」，改为在**首页侧边栏打开 插件 → 已安装 → dsh-qq-bot**。
> 配置项与落点（profile 的 `cordis.patch.yml`）都没变，**现有配置无需迁移**。
> 0.10 起**一套插件接五种协议**：OneBot 11（默认）/ OneBot 12 / Satori / Milky / QQ 官方机器人，见「三、协议与连接方式」。
> 本仓库就是维护主干 [arrow1031/dsh-qq-bot](https://github.com/arrow1031-dev/dsh-qq-bot)，**已解除封版**：
> 安装跟随 `main`、功能与修复走 PR。需要兼容 DSH 0.1.6 及更早的旧版本（0.6.x）请自行选择早期 tag 下载；
> 早期版本同时想用新功能，请自行处理。

**维护者** [@arrow1031](https://github.com/arrow1031) · **核心贡献者** [@nd002723](https://github.com/nd002723) · **许可** [MIT](LICENSE) · **AI 生成声明** [AI-DISCLOSURE.md](AI-DISCLOSURE.md) · **更新日志** [CHANGELOG.md](CHANGELOG.md)

> **⚠️ 行为约定（0.6.8 起沿用，0.8.x 不变）：bot 不自动附带聊天上下文**
>
> 被 @ / 回复 bot 时，不再自动把群内「最近相关发言」硬塞进会话上下文（省 token、上下文更精简）。
> 需要结合群内近期消息/图片作答时，Agent 会**主动调 `qq_history` 工具**拉取（见 [qq_history 小节](#qq_history聊天记录ai-自取)）。
> 可感知影响：bot 对群内前文的「记忆力」取决于模型是否自觉调工具；若群成员觉得 bot 变迟钝，这是**预期行为**而非故障。

一个可以装进 DSH profile 的插件：QQ 消息进来 → 交给 DSH Agent → 回复发回 QQ。

复用现成生态，不自造协议：

```
QQ 客户端 / Koishi / QQ 开放平台
   │ 各家协议（OneBot 11/12、Satori、Milky、官方 API v2）
   ▼
lib/adapters/*.mjs（协议翻译层，零 npm 依赖，独立进程）
   │ stdin/stdout 换行分隔 JSON（契约见 lib/bridge/CONTRACT.md）
   ▼
lib/bridge/（中间表示：一套消息段 + 一套 message 帧）
   ▼
lib/index.js（Cordis 插件入口）
   ├ lib/config.js         Config schema / 默认值 / 深合并
   ├ lib/session.js        建会话、固定命名、访客工具闸
   ├ lib/tools.js          qqbot / qqconfig / qqgroup / qq_websearch / qq_webfetch / qq_imgsearch / qq_draw / qq_history
   ├ lib/admin.js          指令解析与三路权限
   ├ lib/owner-settings.js 拥有者设置通道（白名单 + 两步确认 + 限流 + 审计）
   ├ lib/workspace.js      QQ_msg 工作区根解析
   ├ lib/http.js           fetch + 代理隧道 + 公网地址校验
   ├ lib/websearch.js      多引擎搜索
   ├ lib/imgsearch.js      图床 + 反搜引擎
   ├ lib/imagegen.js       生图（qq_draw）
   └ lib/moli.js           dsh-moli 渲染抓取（可选）
   ▲ 设置面板读写（lib/client.js）  ← 插件面板「插件 → 已安装 → dsh-qq-bot」
   │ sessionController → agent.followup → whenIdle
   ▼
DSH Agent（默认模型 + preset 人格 + 工具）
```

## 一、已验证的东西（不是设计稿）

全部在本机实跑：

| 测试 | 命令 | 结果 |
| --- | --- | --- |
| OneBot 11 正向适配器 | `node test/test-adapter.mjs` | 19/19 |
| OneBot 11 反向适配器 | `node test/test-adapter-reverse.mjs` | 12/12 |
| OneBot 12 适配器 | `node test/test-adapter-onebot12.mjs` | 30/30 |
| Satori 适配器 | `node test/test-adapter-satori.mjs` | 70/70 |
| Milky 适配器 | `node test/test-adapter-milky.mjs` | 79/79 |
| QQ 官方适配器 | `node test/test-adapter-qq-official.mjs` | 87/87 |
| 打包后插件端到端（Host） | `node test/test-plugin.mjs` | 76/76 |
| 客户端设置页 | `node test/test-client.mjs` | 82/82 |
| 权限 · 群管理 · 访客工具闸 | `node test/test-admin.mjs` | 32/32 |
| HTTP / 代理层 | `node test/test-http.mjs` | 17/17 |
| 配置合并与还原 | `node test/test-config.mjs` | 11/11 |
| 多引擎搜索结果解析 | `node test/test-websearch.mjs` | 5/5 |
| 生图引擎 | `node test/test-imagegen.mjs` | 16/16 |
| 会话 id 回退 | `node test/test-session-id.mjs` | 5/5 |
| 运行时兼容自检 | `node test/test-compat.mjs` | 14/14 |
| 历史消息鉴权与定向 | `node test/test-history.mjs` | 23/23 |
| 主动发言 | `node test/test-proactive.mjs` | 74/74 |
| 主动发言回合（端到端，不动定时器） | `node test/test-proactive-round.mjs` | 21/21 |
| 拥有者设置通道 | `node test/test-owner-settings.mjs` | 58/58 |
| 一键全量 | `node test/run-all.mjs` | **19/19 套件 · 731 项** |
`test-plugin.mjs` 用假 ctx 加载真正的 `lib/index.js` + 真适配器 + 零依赖 OneBot 模拟器，跑通完整链路（无需 DSH / QQ / 网络）。

## 二、快速开始

### 1. 起一个 OneBot 11 实现（推荐 NapCat）

NapCat 官方 Docker 镜像（**支持 amd64 与 arm64**）：

```sh
docker run -d --name napcat --restart=always \
  -e NAPCAT_GID=$(id -g) -e NAPCAT_UID=$(id -u) \
  -p 3000:3000 -p 3001:3001 -p 6099:6099 \
  mlikiowa/napcat-docker:latest
```

- WebUI：`http://<主机IP>:6099/webui`，用手机 QQ 扫码登录；登录 token 默认在 `docker logs napcat` 里。
- 容器内配置目录 `/app/napcat/config`，QQ 数据目录 `/app/.config/QQ`（想固化登录就挂这两个卷）。
- 在 NapCat 的「网络配置」里确认 **OneBot 11**：
  - **HTTP 服务器** `3000` —— 用来发消息
  - **正向 WebSocket** `3001` —— 用来收事件
  - 若设了 `access_token`，记下来填进插件配置
- 端口默认就是 3000/3001，和本插件默认值一致，**不用改代码**。

### 2. 安装插件

本插件**不在 npm 上**，从本仓库或 Release 附件装（维护仓库：<https://github.com/arrow1031-dev/dsh-qq-bot>）。

**方式一：在 DSH 界面里装（推荐）**

在**首页侧边栏打开 插件 → 添加插件**，输入框里填写下面这行包名，确认后等它装完：

```
github:arrow1031-dev/dsh-qq-bot
```

装完**重启 DSH**（桌面版重启应用 / CLI 重启 `dsh web`），
再到 **插件 → 已安装 → dsh-qq-bot** 打开配置面板。

**方式二：命令行装**

```sh
# 跟随 main（已解除封版：升级即最新，不锁 tag）
# 升级已有安装：dsh plugin --profile web update
dsh plugin --profile web add github:arrow1031-dev/dsh-qq-bot

# 本地 tarball（自己改了代码之后）
npm pack
dsh plugin --profile web add ./dsh-qq-bot-<版本号>.tgz
```

`--profile` 换成你实际在用的 profile：**桌面版是 `--profile desktop`**，`dsh web` 部署一般是 `--profile web`。

`dsh plugin` 本质是 pnpm 的前置封装：装完包后，它会**自动把声明了 `dsh.bundle.patch` 的依赖加入 profile 的层栈**（本包的 package.json 已声明），并连同唯一的运行时依赖 `@deepseek-ai/schemastery` 一起装上。装完**重启 DSH（桌面版重启应用 / CLI 重启 `dsh web`）**生效。

> **版本要求**：0.11.x 要求 DSH ≥ 0.2.0-rc.2；DSH 0.2.1-rc.3 已实测（见下文「DSH 0.2 兼容」）。

> **升级注意**：`dsh plugin add` 走 pnpm，按 tarball **完整性哈希**缓存——改了代码要打成**新版本号文件名**再装（0.8.0 → 0.8.1），沿用旧名会被判「已最新」跳过。
> `lib/client.js` 是浏览器侧代码，装完重启后还要**刷新浏览器页面**才加载新 bundle。

### 3. 在 QQ 里试

- **群聊**：默认要 **@机器人** 才有反应，`@` 会被去掉再交给 Agent。
  - **回复（引用）机器人的消息**也视同 @ 处理（`reply.botReply`，默认开启），带图照常走识图流程。
  - **需要结合群内近期消息/图片作答时，AI 会主动调 `qq_history` 工具自取**（不再自动硬塞上下文）——识别窗口锚定触发本条回复的那条消息往前 `scopeMessages` 条，最多 `imageLimit` 张图（默认 5/3，设置页可调）。
  - **回复别人 + 正文 @bot**：同样触发（引用回复），上下文同样交给 AI 自取。
  - **bot 被点名时（@ / 回复 bot / 命令前缀 / 管理指令）**：回复统一**引用你的消息**（QQ 引用回复）。
- **私聊**：默认直接回。
- 长回复按换行切成 ≤1200 字多条发送。
- 每个群/每个人是独立的 DSH 会话（id 形如 `qqbot-group-33333`），会落盘并出现在 Web UI 会话列表里，可以像普通会话一样打开继续聊。
- 新会话的**显示名固定为 `群聊_<群号>` / `私聊_<QQ号>`**（`session.fixedName`，默认开启），不再让 LLM 自动起标题；已建会话保持原名。

## 三、协议与连接方式

插件内核不感知协议。设置里选「协议」，适配器会自动切换并重启：

| protocol | 需要的协议端 | 传输 | 备注 |
| --- | --- | --- | --- |
| `onebot11`（默认） | NapCat / go-cqhttp / Lagrange | 正向/反向 WS + HTTP | 与 0.9 的配置完全兼容 |
| `onebot12` | OneBot 12 实现端 | 正向/反向 WS + HTTP | @ 是 `mention`、回复是 `reply`、图片只有 `file_id` |
| `satori` | Koishi（Satori 服务端） | WS `/v1/events` + HTTP RPC | 消息体是类 XHTML 元素字符串，适配器内置 parser |
| `milky` | NapCat / Yogurt / Lagrange.Milky | `/event` WS + `/api` HTTP | 无 echo；消息 id 是 `message_seq` |
| `qq-official` | QQ 开放平台机器人 | Webhook 或 WS 网关 | AppID/AppSecret 鉴权；群/单聊用 openid |

想加新协议：读 [lib/bridge/CONTRACT.md](lib/bridge/CONTRACT.md)，写一个 stdin/stdout 适配器脚本，
再到 `lib/index.js` 的 `ADAPTER_FILES` 里登记一行。

### OneBot 11/12 的两种连接模式

| 场景 | 用哪个 | 配置 |
| --- | --- | --- |
| 协议端和 DSH 在同一台机器/同一容器 | **正向 WS**（默认） | `mode: forward`，我们连 `ws://127.0.0.1:3001` |
| 协议端在别的容器/主机，或网络方向只允许它连出来 | **反向 WS** | `mode: reverse`，我们在 `0.0.0.0:6199` 监听，协议端填 `ws://<DSH主机IP>:6199/` |

反向 WS 的鉴权：请求头 `Authorization: Bearer <token>` 或 URL 上的 `?access_token=<token>` 都接受（后者是因为标准 WebSocket 客户端无法自定义请求头）。

### 其它协议的连接参数（插件设置页同名）

| 协议 | 参数 |
| --- | --- |
| `onebot12` | `protocols.onebot12.{mode,wsUrl,listen,httpUrl,accessToken}` |
| `satori` | `protocols.satori.{wsUrl,httpUrl,token,platform,selfId}` |
| `milky` | `protocols.milky.{wsUrl,httpUrl,accessToken}` |
| `qq-official` | `protocols.qqOfficial.{mode,appId,appSecret,botSecret,listen,path}`；`mode=webhook` 时端口只能 80/443/8080/8443 |

### 各协议的能力边界

- `qq-official`：官方 API **没有**踢人/禁言/改名片这些群管理动作，`qqgroup` 会明确回「不支持」；主动消息受平台配额与被动回复窗口约束。
- `onebot12`：图片段只有 `file_id`，要 URL 得再调 `get_file`；需要视觉识别的场景建议用 OneBot 11。
- `satori` / `milky`：协议层不定义限流，主动发言的节流仍由插件的 `proactive` 配置执行。
## 四、配置

### 方式一：在插件设置页里改（推荐）

> **入口**：在**首页侧边栏打开 插件 → 已安装 → dsh-qq-bot**。
> 这不是原来的「设置 → QQ 机器人」——设置页在 0.11.0 搬进了插件自己的面板。
> **本版要求 DSH 0.2.0-rc.2 或更新的 0.2.x 版本。现有配置无需迁移。**

重启 DSH 后面板分四档，字段按功能归位：

| 标签 | 二级标签 | 放什么 |
|---|---|---|
| **连接** | — | 连接方式（OneBot 11 正向 / 反向、OneBot 12、Satori、Milky、QQ 官方）、WS/HTTP 地址、`access_token`、各协议参数 |
| **基本** | 准入与名单 | 群聊 / 私聊开关、@ 要求、白名单、命令前缀、拥有者与高级管理员、访客工具白名单 |
| **基本** | 发言与管理 | 回复策略（分片长度、慢回复提示、来源前缀、@ 回复、上下文头）、群管理指令与可管理群 |
| **能力** | 识图与绘图 | 图片视觉（开关 / provider / model / 最多张数 / 下载超时）、生图（接口地址 / key / 模型 / 重试与轮询） |
| **能力** | 搜索与抓取 | 联网搜索（代理 / 端点 / key）、图片反搜、`qq_webfetch` 与 moli 渲染 |
| **能力** | 对话与人格 | 人格（开关 / 名字 / 设定 / 自定义 preset id）、主动发言（判断 / 发言两段式可选，provider / 模型都是下拉）、聊天记录读取 |
| **高级** | — | 会话（独立会话、固定命名、preset 与 owner/guest 分流 preset）、逐帧日志、重启退避 |

- 改完点「保存」；**连接方式那几项**（模式/地址/token）保存后会自动重启适配器，其它项下一条消息生效。
- 类型映射：布尔是勾选框；白名单是逗号分隔的文本框；连接方式是下拉框。
- **主动发言可以分用两个模型（可选）**：默认单段——判断模型在同一次 JSON 里把话也写出来。填了 `proactive.speakModel`
  才切成两段：判断沿用上面的 provider / model（只要稳出 `{speak, topic}`），正文交给发言模型单独写（判断挑便宜快的、发言挑文风合适的，
  不用逼一个模型既守 JSON 又要有文采）。不填就走原来的单段路径，日志里也不多打东西。
  两段式每次接话是 **2 次模型调用**（发言阶段重试的话最多 4 次），成本按两次算。详见下面「主动发言（可选）」。
- **配置落点（本插件要求 DSH 0.2.0-rc.2 起）**：插件把自己的 `Config` schema 交给 DSH 当设置表单，界面上的改动由 DSH
  写进 **profile 的 `cordis.patch.yml`**（也就是下面「方式二」里那个文件）；0.1.6 时代的独立
  `settings.yaml` 文档已经不存在了。
- 设置命名空间就是**条目 id**（默认 `dsh-qq-bot`）；条目被改名时，客户端会回退匹配「以 qq-bot 结尾」的那个命名空间。
- 连接状态不在插件面板里显示，在对话里让 Agent 调用 `qqbot` 工具（`action=status`）看。
- `access_token` 是**只写**字段：已设置时页面显示「已设置；留空则保持不变」，只有输入新值才会覆盖。
  Host 侧把它声明成 schema 的 secret，值不会下发到浏览器，保存时也不会被空值清掉。

### 工作区（自动管理，无需配置）

Agent 会话的工作目录**不需要任何配置**：插件读取 DSH 官方默认 Workspace 的位置
（`<系统 Documents>/deepseek-harness`），在它的同级目录自动创建 `QQ_msg` 作为工作区根，
并注册为 DSH workspace——**Web UI 会话侧栏的「QQ 消息」分组**，新 QQ 会话自动归入该分组：

- Windows：`C:\Users\<用户名>\Documents\deepseek-harness\QQ_msg`
- Linux / macOS：`~/Documents/deepseek-harness/QQ_msg`（系统没有 Documents 目录时退到 `~/deepseek-harness/QQ_msg`）

带图消息的原图缓存放在 `QQ_msg/qq-images/<会话id>/`，**会话结算后自动删除该缓存**，
会话与工作区本身保留。旧的 `workspace` 配置项已废弃移除。

### 方式二：改 composition 行配置（当 base 层用）

**不要改包内的 `cordis.patch.yml`**（升级会覆盖）。写进你自己的
`$DSH_HOME/profiles/web/cordis.patch.yml` —— 它在所有 bundle 之后应用，按 id 定向覆盖：

```yaml
- id: dsh-qq-bot
  config:
    protocol: onebot11            # onebot11 | onebot12 | satori | milky | qq-official（见「三、协议与连接方式」）
    mode: forward                 # forward | reverse（仅 onebot11/12）
    onebot:
      wsUrl: 'ws://127.0.0.1:3001'      # mode=forward 用
      listen: '0.0.0.0:6199'            # mode=reverse 用
      httpUrl: 'http://127.0.0.1:3000'  # 留空则改用 WS action 发消息
      accessToken: ''
    group:
      enabled: true
      requireAt: true             # 群里是否必须 @
      allow: []                   # 群号白名单，空数组 = 所有群
    private:
      enabled: true
      allow: []                   # 用户号白名单，空数组 = 所有人
    commandPrefix: ''             # 例如 '/ai'，空串 = 不限制
    reply:
      maxChars: 1200
      ackAfterMs: 8000            # 慢回合先回「正在处理」；0 关闭
      ackText: '正在处理，请稍候…'
      contextHeader: true         # 给消息加 "[QQ群 123 · 小明(22222)]" 前缀
      firstTurnHint: '（提示：这是一次 QQ 聊天。请用简体中文、简洁自然的口语作答；不要输出 Markdown 表格，代码块保持简短。）'
    auth:                         # 权限，见「五、权限与群管理」
      owners: []                  # 拥有者 QQ：全权限 + 永久授权 + 可走独立会话
      superAdmins: []             # 后台设定的高级管理员（不可永久授权）
      ownerPreset: ''             # 填了才把拥有者/非拥有者分成两条会话
      guestPreset: ''             # 非拥有者用的 preset（仅人格分离，非安全边界）
      guestDshTools: false        # 是否允许访客用 DSH 内部工具（默认否）
      guestToolAllow: ['qqbot', 'qqgroup', 'qq_websearch', 'qq_webfetch', 'qq_imgsearch', 'qq_history']   # 访客仍可用的工具白名单
      grantTtlMinutes: 60         # 群管理员动态授权默认时长
      grantMaxTtlMinutes: 1440    # 群管理员单次可授最长
    admin:
      enabled: true
      manageGroups: []            # 可管理的群；空 = 回退用 group.allow
      requireGroupAdmin: true     # 是否承认「本群管理员」这一路权限
      prefix: '/'                 # 指令前缀（必须在消息首位）
      dryRun: false               # true = 只回复将执行什么
      allowConsole: false         # 允许 Web UI 会话直接调用管理工具
    session:
      fixedName: true             # 固定新建会话名为 群聊_<群号> / 私聊_<QQ号>（不再 LLM 自动起标题）
    perChatSession: true          # true=每个 QQ 会话一个 DSH 会话
    agentPreset: ''               # ''=部署默认 preset；可填自定义 preset id 换人格/工具
    adapterPath: ''               # ''=用包内自带适配器
    nodePath: ''                  # ''=自动解析 node
    logAdapterFrames: false       # 排查时开，会打印每一帧 JSON
    vision:
      enabled: true               # 图片视觉：收到图片时用视觉模型识别并并入回复
      provider: ''                # 视觉 provider 路由（留空 = 会话模型；复用 DSH 自定义 providers）
      model: ''                   # 视觉模型 id（留空 = 会话模型；官方如 deepseek-flash）
      maxImages: 3                # 单条消息最多送入的图片数
      downloadTimeoutMs: 10000    # 图片下载超时（毫秒）
    webSearch:                    # qq_websearch 联网搜索
      proxy: ''                   # http://host:port；留空 = 直连；搜索与 url 抓取都走它
      baseUrl: ''                 # 留空 = https://api.deepseek.com/anthropic/v1（仅 multiEngine=false 用）
      apiKeyEnv: ''               # 留空 = DEEPSEEK_BALANCE_API_KEY（自动读 DSH 凭据服务）
      maxUses: 5                  # 每次搜索最多触发次数
      multiEngine: true           # 多引擎组合搜索（默认开）：Tavily → DuckDuckGo → Yandex/Bing/Wikipedia
                                  # 全部走上方 proxy；关闭则落回官方 DeepSeek web_search
    moli:                         # dsh-moli 接管（qq_webfetch 用 Moli 渲染）
      enabled: false              # 默认关；开启后 qq_webfetch 改用 Moli 无头浏览器渲染抓取（可抓 SPA/JS 页；需已安装 moli 引擎，否则无效）
      proxy: ''                   # http://host:port；留空自动透传 webSearch.proxy
      exePath: ''                 # moli 可执行文件路径；留空自动探测 ~/.local/bin/moli 与 PATH
    history:                      # qq_history 聊天记录（AI 自取）
      scopeMessages: 5              # 识别窗口：触发消息往前最多多少条
      imageLimit: 3                 # 窗口内最多识别多少张图（最近的优先）
    proactive:                    # 主动发言（可选，默认关）
      enabled: false              # 打开且下面列了群号才生效
      groups: []                  # 生效群号；留空 = 不启用
      intervalMinutes: 60         # 检查间隔（最小 5）
      minNewMessages: 6           # 至少多少条新消息才考虑接话
      quietHours: ['23:00-08:00'] # 免打扰时段，可多段
      maxPerHour: 2               # 每小时上限
      maxPerDay: 8                # 每天上限
      minGapMinutes: 15           # 两次发言最小间隔
      eventGuard: true            # 事件去重：跳过过气事件 / 只有应答的插话 / 刚聊过的话题
      staleMinutes: 15            # 最新消息超过这么久视为事件已过气，不接话
      topicCooldownMinutes: 120   # 同一话题在这么久内不再重复
      provider: ''                # 留空 = 跟随群会话模型（走 DSH 已配置的渠道，零密钥）
      model: ''                   # 留空 = 跟随群会话模型；设置页是下拉，同一份模型目录
      speakProvider: ''           # 发言阶段 provider（留空 = 与判断阶段相同）
      speakModel: ''              # 发言阶段模型（留空 = 单段模式；填了才启用两段式）
      speakFallback: true         # 两段式下发言失败时，回退用判断模型给的正文
      requireCjk: false           # 发送前兜底：没有中文（且长于 12 字）就丢掉（默认关；中文群建议开）
      maxChars: 120               # 单条最大字数
      interests: ''               # 话题偏好（可空；接什么仍由模型决定）
      dryRun: false               # 演练：只记日志不发送
      verbose: false              # 日志打印每次判断
    imageGen:                     # qq_draw 生图（自填接口，插件不带 key）
      enabled: false              # 打开后 AI 才能画图
      baseUrl: ''                 # OpenAI 兼容，例 https://api.example.com/v1（请求 地址/images/generations）
      apiKey: ''                  # 只写字段；留空则读下面那个环境变量
      apiKeyEnv: IMAGE_API_KEY
      model: seedream-5.0-lite
      size: 1024x1024
      timeoutMs: 180000          # 单次请求超时
      maxAttempts: 4             # 失败重试次数（含首次；429/5xx/网络/空结果）
      retryIntervalMs: 5000
      poll: true                 # 供应商返回 task_id 时继续轮询
      pollIntervalMs: 5000
      maxPolls: 30
    persona:                      # 自定义人格：每个新会话第一轮附一次
      enabled: false
      name: ''
      text: ''
    agentPresetCustom: ''         # 自定义 preset id（如 qq）；非空时优先于 agentPreset
    imgSearch:                    # qq_imgsearch 图片反搜
      enabled: true               # 默认开；关闭后工具返回「已关闭」
      maxResults: 5               # 每次反搜最多返回结果数
      saucenaoKey: ''             # SauceNAO API key（saucenao.com 注册可得）；留空不启用
      weightedShuffle: false      # 有代理时按体量权重随机重排引擎顺序（避免固定引擎一直打头）
                                  # 请求全走上方 webSearch.proxy：无代理 = 直连引擎按可用性优先
                                  # （TraceMoe → IQDB）；有代理 = 放开全部可用引擎按用户体量优先
                                  # （Yandex → Tineye → Copyseeker → SauceNAO → IQDB → TraceMoe）
```

`agentPreset` 是换人格的正规做法：给 QQ 机器人做一个专属 preset，把 id 填进来。

### 图片视觉（vision）

收到图片时用视觉模型识别并并入 Agent 输入（原图缓存到 `<QQ_msg>/qq-images/<会话id>/`，会话结算后删除）。
`provider` / `model` 留空 = 会话模型；也可以给视觉单独指定 provider / model。

**官方视觉模型（DeepSeek API）**：`deepseek-flash` 接受图片与文本（OpenAI 兼容，base64 data URL 或图片 URL 均可，支持 JPEG / PNG / GIF / WebP）。
旧的 `deepseek-v4-flash-vision-exp` 名字**已退役**，但请求仍被接受（由最新 Flash 服务）。见 [DeepSeek Vision 文档](https://api-docs.deepseek.com/guides/vision/)。

其它 OpenAI 兼容通道：选一个在 DSH providers 里声明了 `input: [text, image]` 的模型即可；
注意 `deepseek-v4-flash-0731` 这类默认模型实测**不真正支持图片**（图不进上下文、会编造解释），换视觉模型时务必确认声明了图片输入。

## 五、权限与群管理

权限是**三路并行取并集**（不是"先命中先返回"）：

| 路径 | 谁 | 能做什么 |
| --- | --- | --- |
| 静态名单 `auth.owners` | 拥有者 | 全部权限 + **永久授权** + 可走独立的拥有者会话 |
| 静态名单 `auth.superAdmins` | 后台设定的高级管理员 | 群管理权限（**不能**永久授权） |
| 动态授权 | 被临时授权的人 | 仅被授予的那几项，**仅限本群**、带时限 |
| 本群身份 | 该群的 admin / owner | 群管理权限（可用 `admin.requireGroupAdmin` 关掉这一路） |

任一路给到某项权限即拥有它；来源会在 `/whoami`、`/perms` 里如实列出，便于排查"他为什么有权"。

权限项：`query`（查询）、`mute`（禁言）、`kick`（踢人）、`recall`（撤回）、`settings`（群名/名片/管理员/全员禁言）、`grant`（给本群成员授权），拥有者另有 `permanent`（永久授权）。

### 动态授权（群维度，不可跨群）

- 拥有者或**本群管理员**可以给本群成员临时授权：`/grant @某人 mute 30`（30 分钟）
- 只有**拥有者**能永久授权：`/grant @某人 kick forever`（非拥有者发这条会被拒）
- 群管理员单次最长 `auth.grantMaxTtlMinutes`（默认 1440 分钟）
- 授权键是「群号 + QQ 号」：**在 A 群授的权，在 B 群一律无效**
- `/revoke @某人 [权限]` 撤销、`/grants` 列出本群全部授权

### 非拥有者不使用 DSH 内部功能：执行级工具闸

用一个 `tools.guard` 硬闸，**只在建会话时注册一次**，判据是闭包里的可变标志位：

- 注册在 `agent.ctx` 上 → 只作用于该会话的 agent
- 每次工具执行时才求值 → 拥有者/访客交替说话**不需要增删限制**
- 用**白名单**（`auth.guestToolAllow`，默认 `qqbot,qqgroup,qq_websearch,qq_webfetch,qq_imgsearch,qq_history`）→ `run_code`（PTC 保留传输）这类"不在全局层"的特殊工具也会被自动挡住；访客联网统一走 `qq_websearch`（搜索）与 `qq_webfetch`（抓网页），DSH 自带的 `web_fetch` 已从默认白名单移除
- 被拦时返回拒绝原因，模型会把它转达给用户（最多多一次"被拒绝的调用"往返）

因此它同时满足：**0 额外 token**（不注入提示词、不改工具表、不记 `request/header`）、**单会话单历史**、**不改 DSH 本身**。

想放开就设 `auth.guestDshTools: true`（不建议）。

> 为什么不用"每条消息增删 `tools.restrict`"：`restrict` 是静态过滤器，想按说话人变就得反复增删，工具面抖动会让 agent loop 多记 `request/header`，反而更费 token、代码也更多。guard 是每次执行才求值的函数，配一个可变标志位就够。

### 会话分流（可选，**仅供人格分离**）

`auth.ownerPreset` / `auth.guestPreset` 都留空时，拥有者与非拥有者**共用一条会话**（默认，也是推荐）。填了 preset id 才分成两条：

- 拥有者走 `qqbot-group-<群号>`，挂 `ownerPreset`
- 非拥有者走 `...-guest`，挂 `guestPreset`

**这只是换人格，不是安全边界**——工具隔离由上面的 `guard` 负责。分流要付代价：同一个群会有两条历史，拥有者看不到访客说了什么。除非确实要给访客不同的说话风格，否则别开。

全局 `agentPreset`（设置页下拉：部署默认 / standard / ptc / minimal / cordis）决定**新会话**用什么 preset，已建会话不变；分流时某方 preset 留空会自动回落 `agentPreset`。

上下文头会带身份，例如 `[QQ群 33333 · 小明(22222) · 身份:访客｜本群管理员+动态授权[mute 至 ...]]`，让 Agent 自己决定怎么对待这个请求。

### 指令的严格性（防"聊天内容夹带指令样内容"被误执行）

1. 前缀必须位于**消息首位**（前面只允许空白）——`你好 /mute @x` 不会被当成指令
2. 动词必须完全匹配已知指令，未知动词照常交给模型
3. token 数量必须落在该指令声明的 `[min,max]` 内，**多余内容判为用法错误、不执行**
4. 权限不足直接拒绝，且不做任何动作

指令**不需要 @ 机器人**（刻意放在 `requireAt` 之前），但上述规则一条都不放宽。

### 指令表

| 指令 | 权限 | 作用 |
| --- | --- | --- |
| `/help` | — | 列出全部指令 |
| `/whoami` | — | 看我在本群的身份与权限来源 |
| `/perms [@某人]` | query | 看某人在本群的权限来源（三路） |
| `/grants` | grant | 列出本群的动态授权 |
| `/grant @某人 权限[,权限] [分钟\|forever]` | grant | 临时授权（仅本群） |
| `/revoke @某人 [权限]` | grant | 撤销授权 |
| `/members` | query | 成员列表（最多列 30 条） |
| `/info` | query | 群信息 |
| `/mute @某人 [分钟=10]` | mute | 禁言（0 = 解禁） |
| `/unmute @某人` | mute | 解除禁言 |
| `/kick @某人` | kick | 移出本群 |
| `/recall [消息id]` | recall | 撤回；**回复某条消息再发 `/recall` 可省略 id** |
| `/banall on\|off` | settings | 全员禁言开关 |
| `/card @某人 新名片` | settings | 改群名片 |
| `/admin @某人 on\|off` | settings | 设/撤管理员 |
| `/rename 新群名` | settings | 改群名 |

### Agent 工具（与指令共用同一套鉴权）

`qqgroup` 的 `action`：只读 `group-list`/`group-info`/`member-list`/`member-info`，写操作 `mute`/`unmute`/`kick`/`whole-ban`/`set-card`/`set-admin`/`rename`/`recall`/`poke`。

工具的"说话人"取自**本会话最近一条消息**，所以群里普通成员没法靠一句话驱动管理动作——这一点是提示注入的主要防线。`group_id` 留空时默认用当前会话所在的群。

### 群事件

适配器会把完整事件字段透传上来（`operator_id` 谁操作的、`duration` 禁言时长、`target_id`、`card`，以及被引用消息的 `reply_to`）。当前版本只做透传与计数（`qqbot status` 里能看到），**自动治理尚未实现**。

### 建议的上线顺序

1. 在设置里填 `auth.owners`（至少填自己）
2. 打开 `admin.dryRun`，在群里发几条指令确认解析与回执
3. 关掉 dryRun，再按需加 `auth.superAdmins`
4. 非拥有者用 DSH 功能由**访客工具闸默认拦截**，无需额外配置；确实想放开再改 `auth.guestDshTools`

## 六、Agent 能用的工具

插件向 DSH 注册 8 个工具（访客只能看到 `auth.guestToolAllow` 里的那几个）。先看通用的 `qqbot`：

- `{action:'status'}` —— 连接状态、模式、适配器 pid/端口、各 QQ 会话的回合数、统计计数
- `{action:'send', message_type:'group'|'private', target_id:'123', text:'...', image?}` —— 主动发一条 QQ 消息；`image` 传本地图片绝对路径（**只允许 `<QQ_msg>/qq-images` 目录内**），插件转 base64 后与文本一起发出，用于「发自拍 / 自画像 / 刚生成的图」这类场景。
- `{action:'interrupt', conversation:'group-123'|'all'}` —— 中断正在跑的回合

### qq_websearch（联网搜索）

访客白名单内可直接调用：

- `{query, max_uses?}` —— 按关键词搜索，返回 `{ok, count, sources, text}`；后端走**多引擎组合搜索**（`multiEngine` 默认开）：Tavily（配 `TAVILY_API_KEY` 才启用，环境变量或 DSH 凭据 refs）→ DuckDuckGo（html→lite，串行 + 限流记忆）→ Yandex / Bing / Wikipedia 并发兜底、聚合去重（相关性闸门防无关链接）；关闭 `multiEngine` 则落回官方 DeepSeek web_search。抓取网页请用 `qq_webfetch`。

搜索请求都走 `webSearch.proxy`（非空时经 HTTP CONNECT 隧道 + TLS，含境内/境外分流；留空直连）。`webSearch` 配置段：代理 / 端点 / key 环境变量名（默认 `DEEPSEEK_BALANCE_API_KEY`，自动读 DSH 凭据服务）/ 每次最多触发次数 / 多引擎开关（默认开）。

### qq_webfetch（抓取网页）

访客白名单内可直接调用：

- `{url, max_chars?}` —— 抓取指定网页原文/渲染文本（http/https，仅公网），返回 `{ok, url, status|via, text}`；请求受 `webSearch.proxy` 管控（留空直连、非空走 HTTP CONNECT 隧道），抓取前校验目标为公网 IP，内网/回环/私有地址一律拒绝（防经代理扫内网）。
- 配置 `moli.enabled`（默认关）后改用 **Moli 无头浏览器渲染抓取**（可抓 SPA/JS 渲染页）；代理自动透传 `webSearch.proxy`（可被 `moli.proxy` 覆盖）；未检测到 moli 引擎时开关无效，工具返回 `moliUnavailable` 明确报错。

### qq_imgsearch（图片反搜）

访客白名单内可直接调用：

- `{url, max_results?}` 或 `{file, max_results?}` —— 给定**公网图片 URL** 或**本地图片文件路径**，返回 `{ok, count, sources, via, text}`；来源带 `url/title/snippet`。
- **本地文件流程**：先上传图床（`zixiaoyun/scdn/uguu` 三床按实测质量**加权随机**排优先度，依次试到第一个成功，一律走 `webSearch.proxy` 管控）拿公网 URL → 再反搜；**上传失败回退**：不经过图床、直接把文件发给 TraceMoe（文件直传搜图）。`file` 路径限 `qq-images` 目录内（访客不能读任意文件）。

引擎组合（全部请求走 `webSearch.proxy`，与 `qq_websearch` 同一套代理管控，本插件独立实现）：

- **无代理**（留空直连）：按**可用性优先** —— TraceMoe（动画截图识别，URL 模式 JSON，直连最快）→ IQDB（ACG 图库）→（有 key 时 SauceNAO）→ Soutubot
- **有代理**：**放开全部可用引擎按用户体量优先** —— Yandex（全球搜索引擎）→ Tineye（全球图片搜索）→ Copyseeker（聚合，结果最多）→（有 key 时 SauceNAO）→ Soutubot（搜图Bot酱，多库：pixiv/danbooru/gelbooru 等）→ IQDB → TraceMoe；聚合去重，cap 满即停，单引擎失败自动继续下一引擎。
- 开启 `imgSearch.weightedShuffle` 后，有代理时按**体量权重随机重排**（Yandex/Tineye/Copyseeker 权重 30/25/25，SauceNAO 15，Soutubot 8，IQDB/TraceMoe 5）：体量大引擎大概率先跑，但顺序每次不同，避免固定引擎一直打头。
- **Soutubot**（soutubot.moe，开源 imsearch）：API 只收文件 → 引擎先下载图片（二进制走代理）再上传 `/api/search` 拿 `result_id` → 查 `/api/results` 多库结果（pixiv 直链 / danbooru / gelbooru / zerochan 镜像 + 画师/角色标签）。
- **`kind=comic` 漫画模式**（`qq_imgsearch` 参数）：漫画/本子截图优先 **Soutubot → SauceNAO（有 key）→ IQDB → TraceMoe**（无代理同链），有代理时再 Yandex/Tineye/Copyseeker 兜底；`weightedShuffle` 开启时漫画权重 Soutubot 40 / SauceNAO 30 / IQDB 20 / TraceMoe 10 / 通用 5。**`kind=comic` + 本地文件（`file`）时不上图床**：Soutubot 直接传文件（soutubot API 只收文件），失败/无结果回退 TraceMoe 文件直传。

引擎实测（2026-10，PicImageSearch 图床 URL 全矩阵交叉验证）：直连可用 TraceMoe / IQDB / Soutubot；代理可用 Copyseeker（184 条）/ Yandex（15 条）/ Tineye（图床新图未收录时 0 条，收录后正常）；SauceNAO 需 `saucenaoKey`；其余（ascii2d / anime_trace / bing / google_lens / ehentai）不可用。`imgSearch` 配置段：`enabled`（默认开）/ `maxResults`（默认 5）/ `saucenaoKey` / `weightedShuffle`。

### qq_history（聊天记录，AI 自取）

访客白名单内可直接调用（群聊里被 @ 或需要结合群内近期消息/图片作答时，Agent 会主动调它）：

- `{group_id?, user_id?, count?, with_images?}` —— 拉取当前群最近消息，返回 `{ok, group_id, messages:[{time, user_id, nickname, text, images:[{url, description}]}]}`；`group_id` 默认当前群，`user_id` 可只筛某人的发言，`count` 默认 20、上限 50，`with_images` 默认开。
- **识别窗口锚定「最新提及」**：只对触发本条回复的那条消息（@ bot / 回复 bot / 命令前缀）**往前 `scopeMessages` 条**（默认 5）内的图片做识别，最多 `imageLimit` 张（默认 3，最近的优先）；更早的 @ 不锚定、其附近图片不因「也是被提及」而识别，避免重复拉取/重复识图。
- 窗口内图片用插件的视觉链路识别（下载 + `askVision`），返回 URL + 描述；识别失败只给 URL 不阻塞。配置见 `history` 段（`scopeMessages` / `imageLimit`）。

### qq_draw（生图，可直接发到 QQ）

在 插件 → 已安装 → dsh-qq-bot → 能力 → 识图与绘图 里填好接口后，AI 就能按描述画图：

- `{prompt, model?, size?, reference?, caption?, send?}` —— `prompt` 越具体越好；`reference` 可给公网 URL 或 `qq-images` 下的本地图（保持同一形象做「自拍」）；
  `send` 默认 true，直接把图画成 QQ 图片段发到当前会话，`caption` 是随图发的文字。
- 失败策略：`429 / 5xx / 网络错 / 空结果` 按 `retryIntervalMs` 重试到 `maxAttempts`；`4xx`（参数错、额度不足）直接报错、不重试。
- 异步供应商：响应里是 `task_id` 时按 `pollIntervalMs` 轮询（依次试 `.../images/generations/<id>`、`.../images/tasks/<id>`、`.../tasks/<id>`），最多 `maxPolls` 次；关掉 `poll` 就只尝试一次。
- 图片落盘：`<QQ_msg>/qq-images/gen/`；`qq_draw` 不在访客默认白名单（会花钱），要放开就自己加到 `auth.guestToolAllow`。
- 接口约定：OpenAI 兼容 `POST <baseUrl>/images/generations`，请求体 `{model, prompt, n:1, size?, image?}`，返回 `data[0].url` 或 `data[0].b64_json`（实测 `seedream-5.0-lite` 返回 url、约 40 秒）。

### 人格（人设）也在设置里换

两种做法，互不冲突：

- **自定义人格**：设置页「自定义人格」开关 + 名字 + 设定，开一次管所有新会话（第一轮末尾附一次身份设定，零额外 token）；已建会话不变，想立刻生效就删掉旧会话重开。
- **整档 preset**：`Agent preset` 下拉选内置 standard / ptc / minimal / cordis；自建 preset（例如 `qq`）填进「自定义 agent preset id」，非空时优先生效——这条路换的不只是人格，还有工具面。

### web_fetch（抓公网原文，仅拥有者）

DSH 自带的 `web_fetch` 工具仍然注册，但**已从访客默认白名单移除**——访客要抓原文请用 `qq_webfetch`（走 `webSearch.proxy` 代理、同样带公网 IP 过滤，`moli.enabled` 时可改用 Moli 渲染）。`web_fetch` 本身只允许公网 IP，内网/回环地址由 DSH 直接拒绝；拥有者不受访客白名单限制，照常可用。

### qqgroup（群管理）

见「五、权限与群管理」一节。工具路径的授权依据是「当前会话最近一条消息是否来自管理员白名单」。

### qqconfig（拥有者专用：在 QQ 里改设置）

0.10 起。让**拥有者本人在私聊里**直接改一部分插件设置，不用去翻 profile 的 `cordis.patch.yml`：

- `{action:'show'}` —— 列出可改项、当前值和配置修订号
- `{action:'propose', path:'group.allow', value:'[\"488136808\"]'}` —— **只校验不写盘**，返回改动预览与一次性 `token`
- `{action:'apply', token:'...'}` —— 凭 token 真正落盘
- `{action:'cancel', token:'...'}` —— 撤销预约

可改的是一组白名单字段：群/私聊开关与白名单、命令前缀、群管理开关、主动发言参数、图片识别、人设。
密钥、`onebot.*`、`auth.*`（拥有者名单）、模型名这类**改不了**——机器人无法借这条通道给自己扩权。

写盘要过三道：**只能是拥有者本人在私聊里**（身份取自当前会话发言人，不接受参数）→ `propose` 只生成 300 秒有效的一次性确认码 →
`apply` 时若配置已被别处改过就作废。落盘只走 DSH settings 服务（schema 校验 + 原子写 + 热重载），不手改 YAML；
另有每小时 6 次 / 每天 30 次的限流与 `QQ_msg/qqbot-config-audit.jsonl` 审计。完整威胁模型见 [SECURITY.md](SECURITY.md)。

总开关 `auth.ownerSettings`（默认开），关掉后全部动作拒绝。

## 七、排错

| 现象 | 检查 |
| --- | --- |
| 日志一直「OneBot 未连接」 | NapCat 的「正向 WebSocket」是否开在 `onebot.wsUrl`；reverse 模式下 NapCat 是否指向了 `ws://<DSH>:6199/`；防火墙；token 是否一致 |
| 能连上但收不到消息 | OneBot 版本要选 **v11**；不能只开 HTTP，必须开正向或反向 WS |
| 群里 @ 了也不回 | `group.enabled`；`group.allow` 白名单；`self_id` 与消息里的 `self_id` 是否一致（`logAdapterFrames: true` 能看到原始帧） |
| 回「（本轮没有产生文字回复：...）」 | 括号里是从会话日志读出的 `turn/end` 原因，据此定位（模型路由、额度、工具报错等） |
| 发送失败 | NapCat 的 HTTP 服务器（默认 3000）是否开着；`accessToken`；看日志里的「发送失败」 |
| 日志在哪 | 插件前缀 `[dsh-qq-bot]`，适配器前缀 `[dsh-qq-bot]/adapter`，都打到 DSH Host 的 stdout |

## 八、无 QQ 号自测


**先装依赖**（`Config` schema 需要 schemastery）：

```sh
npm install
```

装好之后裸克隆即可运行：需要 DSH 运行时才能成立的少数断言（动态工具注册、qqgroup 工具路径）
会自动跳过，而不是判失败；想看全，把 `DSH_PROFILE_MODULES` 指向一个装了 DSH 运行时的 profile 的
`node_modules`。
整套 **731 项**（19 个套件）：

```sh
npm test
```

或分开跑：

```sh
# 协议适配器回归（每家一个套件，全部用本地假协议端）
node test/test-adapter.mjs              # OneBot 11 正向（19 项）
node test/test-adapter-reverse.mjs      # OneBot 11 反向（12 项）
node test/test-adapter-onebot12.mjs     # OneBot 12（30 项）
node test/test-adapter-satori.mjs       # Satori（70 项）
node test/test-adapter-milky.mjs        # Milky（79 项）
node test/test-adapter-qq-official.mjs  # QQ 官方（87 项）

# 插件本体（假 ctx + 真适配器 + 假协议端）
node test/test-plugin.mjs     # Host 半边（76 项，含 Config 契约与热更新）
node test/test-client.mjs     # 客户端设置页（80 项）
node test/test-admin.mjs      # 权限·群管理·访客工具闸（32 项）
node test/test-http.mjs       # HTTP / 代理隧道（17 项）
node test/test-config.mjs     # 配置合并与还原（11 项）
node test/test-websearch.mjs  # 多引擎搜索结果解析（5 项）
node test/test-imagegen.mjs   # 生图引擎：重试 / 轮询 / 响应解析（16 项）
node test/test-session-id.mjs # 会话 id 回退（5 项）
node test/test-compat.mjs     # 运行时兼容自检（14 项）
node test/test-history.mjs    # 历史消息鉴权与定向（23 项）
node test/test-proactive.mjs  # 主动发言（74 项）
node test/test-proactive-round.mjs  # 主动发言回合端到端（21 项）
node test/run-all.mjs         # 一键全量（19 套件）
```

也可以手动拿假 OneBot 试（端口正好是 NapCat 默认值）：

```sh
node test/mock-onebot.mjs --http-port 3000 --ws-port 3001
# 另开一个终端，伪造一条 @机器人的群消息
node -e "fetch('http://127.0.0.1:3000/__inject',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message_type:'group',group_id:33333,user_id:22222,nickname:'小明',message:[{type:'at',data:{qq:'10000'}},{type:'text',data:{text:'你好'}}]})}).then(r=>r.json()).then(console.log)"
# 看机器人回了什么
node -e "fetch('http://127.0.0.1:3000/__sent').then(r=>r.json()).then(j=>console.log(JSON.stringify(j.messages,null,2)))"
```


## 九、关于 AstrBot

AstrBot 是 OneBot 的**消费方**（内置 aiocqhttp 反向 WS 服务端），和本插件角色重叠。
用 DSH 当大脑就别再接 AstrBot，否则同一条消息会被两个大脑各回一次。
对端只要是「OneBot 11 实现」（NapCat / OneDisc / Lagrange / LLOneBot 等）就行。

## 十、在手机容器里跑 NapCat 的注意事项

- NapCat 官方镜像有 **arm64** 版本，所以理论上能在 arm64 容器里跑；但容器里再跑 Docker 通常需要 privileged 权限，不一定允许。
- 备选：不用 Docker，直接在容器里跑 NapCat.Shell（需要对应的 Linux QQ + NapCat 版本）。
- 同容器时用 **forward 模式**连 `127.0.0.1:3001` 最省事；如果 NapCat 在别的容器，用 **reverse 模式**，让 NapCat 连到 `ws://<DSH主机IP>:6199/`。
- 端口 6099 是 NapCat 的 WebUI（扫码登录用），**不要暴露到公网**。

## 十一、文件清单

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | Cordis 插件入口（Host 侧）。导出 `name` / `inject` / `Config` / `apply`；组合导入下面各模块 |
| `lib/config.js` | `Config` schema、`DEFAULTS`、深合并 `mergeConfig`、volatile 还原 `plainConfig` |
| `lib/session.js` | 会话创建/复用、固定命名、访客工具闸（`ctx.get('tools')`） |
| `lib/bridge/` | 适配器共享层：手写 WebSocket、stdio 契约、消息段归一（`CONTRACT.md` 是写新适配器的入口） |
| `lib/adapters/` | 协议适配器：`onebot11` / `onebot12` / `satori` / `milky` / `qq-official`，各自可独立执行 |
| `lib/owner-settings.js` | 拥有者设置通道：白名单校验、`propose/apply` 两步确认、限流、审计 |
| `lib/workspace.js` | `QQ_msg` 工作区根解析（index 与 imgsearch 共用，避免 0.9.5 的 ReferenceError） |
| `lib/tools.js` | 8 个模型工具（qqbot/qqconfig/qqgroup/qq_websearch/qq_webfetch/qq_imgsearch/qq_draw/qq_history）；注册统一走 `registerTool(ctx, make)`（DSH 0.2 契约） |
| `lib/admin.js` | 群管理指令、三路权限、动态授权 |
| `lib/http.js` | fetch + HTTP CONNECT 代理隧道 + 公网地址校验 |
| `lib/websearch.js` | Tavily / DuckDuckGo / Yandex / Bing / Wikipedia 组合搜索 |
| `lib/imgsearch.js` | 图床（zixiaoyun / scdn / uguu）+ TraceMoe / IQDB / SauceNAO / Soutubot 等反搜 |
| `lib/moli.js` | dsh-moli 渲染抓取探测（可选） |
| `lib/client.js` | 客户端半边（手写 bundle）：在「设置」里加「QQ 机器人」选项卡（命名空间 = 条目 id `dsh-qq-bot`） |
| `lib/onebot-adapter.mjs` | OneBot 11 传输适配器。零依赖（Node 22 内置 `WebSocket`/`fetch`），正向/反向 WS + HTTP，自动重连、发送限速 |
| `cordis.patch.yml` | bundle 补丁：把插件插入 profile 组合树 |
| `test/mock-onebot.mjs` | 零依赖 OneBot 11 模拟器（手写 RFC 6455 帧编解码） |
| `test/test-adapter.mjs` | 正向 WS 适配器回归（19 项） |
| `test/test-adapter-reverse.mjs` | 反向 WS 适配器回归（12 项） |
| `test/test-plugin.mjs` | Host 插件端到端（76 项，假 ctx + 真适配器 + Config 契约 + 配置热更新） |
| `test/test-client.mjs` | 客户端设置页（80 项，模拟模块加载器 + 最小 React 渲染 + 四档标签/二级分类 + 只写密钥护栏 + 命名空间回退） |
| `test/test-admin.mjs` | 权限·群管理·访客工具闸专项（32 项；dsh-tools 可解析时另含工具路径断言） |
| `test/test-http.mjs` | HTTP / 代理隧道（17 项） |
| `test/test-config.mjs` | 配置合并与 volatile 还原（11 项） |
| `test/test-websearch.mjs` | 多引擎搜索结果解析（5 项） |
| `test/run-all.mjs` | 一键全量（8 套件） |
| `CONTRIBUTING.md` / `CODE_OF_CONDUCT.md` / `SECURITY.md` | 贡献流程、行为准则、安全报告 |
| `.github/` | issue / PR 模板、CODEOWNERS |
| `examples/dynamic-package-host.js` | 同一个桥接的「动态 Cordis Package」版本：不想装包、只想在当前 DSH 进程里临时跑时用 |
| `ARCHITECTURE.md` | **改动指南**（给要 fork 的人）：文件职责、数据流、设计决策原因、分步改动指南、调试手册、术语表 |
| `AI-DISCLOSURE.md` | AI 生成内容声明、验证情况、**尚未验证清单**、第三方归属、安全免责 |
| `CHANGELOG.md` | 版本演进（0.1.0 → 0.8.2，含 0.8.0 合并下游分支与 0.8.1 输入框修复） |
| `LICENSE` | MIT |

## 十二、设计说明（踩过的坑）

- **为什么中间要子进程？** 动态插件沙箱没有 `fetch`/`WebSocket`/`require`，用 `ctx.subprocess` 拉真 Node 进程、换行分隔 JSON 通信；协议层可独立测试，换 QQ 框架不影响插件。
- **为什么用 `sessionController` 建会话？** 直接 `agentLoop.create()` 建的 Agent 没装模型路由（首次请求必败）；`sessionController.create()` + `resolveAgent()` 才是官方组装路径（装 provider/model + preset）。
- **为什么用 `whenIdle()` + `deriveMessages()` 取回复？** 回合串行排队，回合后会话日志最新一条有文本的 assistant 消息就是回复，比订阅流式事件简单稳。
- **访客工具闸为什么用 guard？** 拆会话破坏对话一致性；`restrict` 是静态过滤器需反复增删。`tools.guard` 注册一次、每次执行才求值：0 额外 token、单会话单历史；标志位须在**串行回合内部**设置，否则排队消息互相覆盖权限。
- **设置契约为什么跟 DSH 0.1.7 改？** 0.1.7 删了 `settings.register()`，改为读插件导出的 schemastery `Config`（可编辑字段必须 `.volatile()`）；volatile 变更不重挂插件，需监听 `loader/volatile-update` 自己刷新配置。
- **为什么动态 `import('@deepseek-ai/dsh-tools')`？** peerDependency 由 DSH 提供；动态 import + try/catch，包不在时桥接照样工作，只是少一个 `qqbot` 工具。

## 十三、不想重启 DSH 也能先跑起来（动态 Cordis Package）

装包要重启 `dsh web`；想**在当前进程里立刻试**，用 `examples/dynamic-package-host.js` 作动态 Package：
交给 `cordis_define`（`code.host`）再 `cordis_run` 即可，与常驻插件**共用同一份磁盘源码**。
优点：立刻生效、不用重启；限制：**DSH 一重启就没了**，长期在线还得装包。
动态沙箱里没有 `require`/`fetch`/`setTimeout`，传输层必须靠 `ctx.subprocess` 拉子进程
（这也是 `lib/onebot-adapter.mjs` 存在的原因）。

## 十四、许可与维护

### 许可与作者

MIT，见 [LICENSE](LICENSE)。维护者与贡献者见顶部（维护 [@arrow1031](https://github.com/arrow1031)，核心贡献者 [@nd002723](https://github.com/nd002723)）。

### 维护状态：社区化维护中（不封版）

本仓库就是主干：0.8.0 把下游开发者 [@nd002723](https://github.com/nd002723) 的分支
（模块化重构 + `qq_websearch` / `qq_webfetch` / `qq_imgsearch` / `qq_history`）并入
`main`，同时保留 0.7.0 的 DSH 0.2 兼容改造；0.8.1 修掉设置页列表输入框吞逗号的问题；
0.10.0 把协议层拆成 `lib/bridge/` + `lib/adapters/`，一套插件接 OneBot 11/12、Satori、Milky、QQ 官方机器人。

- 安装跟随 `main`，不再锁 tag；每次合并后在 `main` 打 tag 发 Release
- 提 issue / PR / Discussions 都欢迎，活跃贡献者会被邀请为协作者（当前协作者：@arrow1031、@nd002723）
- 0.6.x 及更早（兼容 DSH ≤ 0.1.6）保留为历史 tag，需要旧版请显式指定 tag

### 联系

- 仓库：[arrow1031-dev/dsh-qq-bot](https://github.com/arrow1031-dev/dsh-qq-bot)（issue / PR / Discussions 都在这里）
- QQ 群：**[1091766276](https://qun.qq.com/universal-share/share?ac=1&authKey=z%2FlfWodgOvkDnUTzUZ3%2BNoYGInkfTKCyMfmxO8uyGa%2Bx%2BKmF4ILvUvzqSb6mEJoE&busi_data=eyJncm91cENvZGUiOiIxMDkxNzY2Mjc2IiwidG9rZW4iOiJuY0Z3eEkzeUJWUkROYUNwWnNhblY3VlQrWWh1NURVbDZlUDRZNHZKSFlGWEJnOFRhazB6VUVaV0ZoMzVZVjg2IiwidWluIjoiMzE5NTQzODg2In0%3D&data=qPi85PPH3R-8HaJ9_U2u0zi7KCjzwplsRb-xisY3XAiBsWzopanij924BvV0sfj_cspqyTWemKx0YnNIHTjjGQ&svctype=4&tempid=h5_group_info)**（加群自动审批；报错请带上 [dsh-qq-bot] 开头的日志和复现步骤）
- 个人网站：<https://sputnikzaychik.icu>
- 贡献流程与代码约定：[CONTRIBUTING.md](CONTRIBUTING.md)；行为准则：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- 提问与用法交流：[Discussions](https://github.com/arrow1031-dev/dsh-qq-bot/discussions)
- 安全问题：[SECURITY.md](SECURITY.md)（走私信，别在公开 issue 里贴细节）
- 维护者：[@arrow1031](https://github.com/arrow1031) · 核心贡献者：[@nd002723](https://github.com/nd002723)

为了让你改得快，这些文档是为你写的：

| 文档 | 内容 |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | **改动指南**：分层图、模块职责、关键数据流、设计取舍、已知边界 |
| [AI-DISCLOSURE.md](AI-DISCLOSURE.md) | AI 生成方式、人类决策点、验证到什么程度、**尚未验证的清单**、第三方归属、安全免责 |
| [CHANGELOG.md](CHANGELOG.md) | 0.1.0 → 0.10.0 的完整演进 |

### 致谢

- [**NapCat**](https://napneko.github.io/) —— 提供灵感、OneBot v11 接口与文档。
  没有它把 NTQQ 的能力按 OneBot 规范暴露出来，这个项目根本无从起步。
- [**梁圣**](https://www.deepseek.com/) —— 忠！橙！


AI 生成内容声明见 [AI-DISCLOSURE.md](AI-DISCLOSURE.md)，**使用前请务必读一遍**（尤其"已知限制"一节）。

**运行时依赖**：`@deepseek-ai/schemastery`（Config schema 用）；`@deepseek-ai/dsh-tools` 可选（仅用于注册动态工具，缺失时自动降级）。适配器只用 Node 22 内置的 `WebSocket` 与 `fetch`——**本插件本身保持零 npm 依赖**。**唯一的可选功能例外**：`qq_webfetch` 的 Moli 渲染模式（`moli.enabled`）需要另外安装 [dsh-moli](https://github.com/nd002723/dsh-moli) 插件 + moli 引擎（未装时开关无效、工具返回 `moliUnavailable` 并回退普通 http 抓取），不影响其它功能。

## 十五、附录

### 跨对话检索（跨群 / 跨会话）

两套互补的能力，都在设置里配、由 Agent 自己决定何时用：

- **QQ 层：qq_history**（只读，不改任何东西）
  - 默认读当前会话（群聊 / 私聊都行）；`before_seq` 翻更早的页，返回的 `next_before` 就是下一页游标。
  - 跨会话要权限：**拥有者 / 高级管理员**可读任意群和私聊；**群管理员**只能读「自己是该群管理员（或已授权）且该群在可管理范围」的群；别人的私聊只有拥有者/高级管理员能读。当前会话不受限，AI 回答群内问题照常读。
  - 私聊历史用 `peer_id` 指定对象；读别人的私聊要带 `before_seq`（NapCat 需要一条该会话里的消息当锚点）。
  - 拉不到时给明确原因（无权限 / 需要锚点），不会静默返回空。
- **会话层：session_search 系列**（DSH 的 `@deepseek-ai/dsh-tool-session-query`，5 个只读工具：
  `session_search` / `session_event_search` / `session_trace` /
  `session_event_trace` / `session_event_read`）。授权规则是「目标会话的 cwd 与调用方完全一致」——
  QQ 的每个群/私聊会话都落在同一个 QQ_msg 工作区，所以它们之间可以互相检索。在 `qq` preset 里挂一行即可：

```yaml
- id: preset-qq
  name: "@deepseek-ai/dsh-agent-preset"
  config:
    id: qq
    plugins:
      - id: tool-session-query
        name: "@deepseek-ai/dsh-tool-session-query"
        # 可选：maxSearchResults / searchTimeoutMs
```

  不挂这一行就没有这 5 个工具，但 qq_history 的跨群读取不受影响。

### 主动发言（可选）

默认关闭。打开后按 `proactive.intervalMinutes` 看一次群里最近的消息，由模型自己判断**要不要接、接什么话题**；判断标准写在提示词里（宁可不说话；不接刷屏 / 吵架 / 敏感话题 / 广告 / 看不懂的梗 / 只针对某人的没头没尾对话），发言前还会过一遍长度、链接、``、重复校验。频率、时段、群范围全部由配置控制。

- 只有 `enabled: true` **且** `groups` 显式列了群号才生效；留空 = 完全不跑。
- 免打扰时段 `quietHours`、每小时 / 每天上限、两次发言最小间隔会先拦一道；不足 `minNewMessages` 条新消息则不进入判断。
- **判断和发言可以分用两个模型（两段式，可选）**：默认单段——判断模型在同一次 JSON 里把话写出来，够用就别动。
  填了 `speakModel`（或 `speakProvider`）才切成两段：判断阶段只出 `{speak, topic}`，正文交给发言模型单独写——
  判断挑便宜快的、发言挑文风更合口味的，不用逼一个模型既守 JSON 又要有文采。发言阶段报错或写不出可用正文时，
  `speakFallback`（默认开）回退到判断模型给的句子，不会因为第二段挂了就不说话；两项都不填时行为与以前完全一致。
  注意**判断阶段仍在写正文**（那句 `message` 就是回退素材），精简 judge 提示词时别把它删了，否则回退会静默失效。
- **发送前兜底 `requireCjk`（默认关，单段 / 两段都生效）**：正文没有 CJK 字符、且长度超过 12 时判不可用。它治的不是「拒绝语」这个语义，而是「中文群里整句英文」这个结构性异常——模型偶尔会掉回英文拒答模板（形如「Sorry, it looks like I can not chat about this.」）。
  长度阈值 12 是代码里的常量（`CJK_MIN_LENGTH`）不是配置：正常 ASCII 短回应（666 / 233 / OK / lol / yyds）基本 ≤ 10，整句英文拒绝语基本 ≥ 20，12 是安全中点。CJK 判据用 Unicode 属性转义（Han / Hiragana / Katakana / Hangul），`々` 与扩展 B 区生僻字都算中文。
- 模型返回 `speak=false` 就安静待着；不会 `@` 人、不发链接；`dryRun: true` 只记日志，方便先观察。
- **提示词两道防编造约束**：判断阶段的 `topic` 只能来自聊天记录里出现过的事（没得接就 `false`），发言阶段只用记录里的信息、不编造具体事实。
  这条是生产上真发出去一条「自编经历」之后补的——模型编造是概率性的，约束只压概率，消不掉。
- **判断用哪个模型**：和识图完全一条路——都走 `ctx.llm.stream()`。`provider` / `model` 留空就**跟随该群会话的模型**，
  零密钥、不需要另配端点；设置页里两项都是**下拉**（provider 列出 DSH 的 provider，model 跟随 provider 列模型），
  想用便宜模型就显式选一个。群里还没有会话时按全局 agent preset 建同一条会话再取，不会因为「还没人说话」直接失败。
  启动日志会打出「模型来源=跟随群会话模型 / 指定模型 x/y」；配置不全时明确告警，不会静默不发言。
- **事件去重（`eventGuard`，默认开）**：模型很容易对一件早就聊完的事再回一次。开着的效果：
  - 最新消息超过 `staleMinutes` 分钟（默认 15）就当你已经错过接话窗口，不接；
  - 最新一条只是「行」「OK」这类应答（短、且不是提问）就不插话；
  - 最近几条只有两个人在来回说，视为他们的对话，不硬插；
  - 同一话题在 `topicCooldownMinutes`（默认 120）内说过一次就不再说，换说法也算同一件事。
  关掉（`eventGuard: false`）退回旧行为：只做频率与文本去重，可能重复回复。
- 关闭：设置页把「启用主动发言」关掉，或配置里 `enabled: false`。

### 向前兼容（旧会话不会被删）

旧版本建的 QQ 会话可能绑在别的工作区（0.7 时代是 `/root`，0.8 起是 `<Documents>/deepseek-harness/QQ_msg`）。
DSH 不允许跨工作区复用同一个会话 id，插件现在的处理是：

1. 检测到 `belongs to "..."` 时**不动旧会话**（历史完整保留在原工作区）；
2. 用工作区限定的 id（`qqbot-group-<群号>-ws<6位哈希>`）新建一条，重试一次即成功；
3. 日志里写明「改用 xxx；旧会话保留」，方便排查。

### DSH 0.2 兼容

0.8.0 起，工具注册与访客工具闸统一走 Cordis 的注入契约：

- 注册：先 ctx.get('tools')，未就绪时用 ctx.inject(['tools'], ...) 动态挂载；
- 闸门：agent.ctx.get('tools').guard(...)，取不到才回退 agent.ctx.tools（0.1.x 形态）。

tools 仍是可选服务：没有它时插件照常收发消息，只是少几个模型工具。
要求 DSH >= 0.2.0-rc.2；0.2.1-rc.2 与 0.2.1-rc.3 上都实测 8 个工具注册齐全（qqbot / qqconfig / qqgroup / qq_websearch / qq_webfetch / qq_imgsearch / qq_draw / qq_history）。

**版本支持不写死**：插件启动时读取当前实际加载的 DSH 版本并判定，日志形如
`[dsh-qq-bot] 运行于 DSH 0.2.1-rc.3（在声明支持范围 0.1.7-0 <= v < 0.3.0-0 内）`；
`qqbot` 工具 `action="status"` 返回的 `runtime` 字段给出同一结论。支持范围只维护
`lib/compat.js` 里的 `SUPPORT_FLOOR` / `SUPPORT_CEILING` 两个常量，DSH 出新版本不用改代码、也不用补版本表；
版本识别失败或超出范围只提示，不影响收发消息。
