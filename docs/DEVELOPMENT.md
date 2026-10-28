# 开发与维护

面向要**改代码、跑测试、发版**的人。只是想用起来请看 [README.md](../README.md)。

- 运行时：**Node 22+**（依赖内置 `WebSocket` / `fetch`），插件要求 **DSH ≥ 0.2.0-rc.2**。
- 运行时依赖只有 `@deepseek-ai/schemastery`（Config schema）；`@deepseek-ai/dsh-tools` 可选，缺失时自动降级（少几个模型工具，消息照常收发）。

## 1. 本地开发

```sh
git clone https://github.com/arrow1031-dev/dsh-qq-bot
cd dsh-qq-bot
npm install          # 只装 schemastery，用于跑测试
node test/run-all.mjs
```

裸克隆即可跑全部测试：需要 DSH 运行时才能成立的少数断言（动态工具注册、`qqgroup` 工具路径）会自动跳过而不是判失败；
想连那部分一起跑，把 `DSH_PROFILE_MODULES` 指向一个装了 DSH 运行时的 profile 的 `node_modules`。

## 2. 测试（37 个套件 / 1361 项）

```sh
node test/run-all.mjs      # 一键全量（套件失败会自动重试一次，重试通过会标注）
npm test                   # 同上
```

| 套件 | 项数 | 覆盖什么 |
| --- | --- | --- |
| `test-adapter.mjs` | 19 | OneBot 11 正向适配器 |
| `test-adapter-reverse.mjs` | 19 | OneBot 11 反向适配器（含半开连接回收） |
| `test-adapter-onebot12.mjs` | 30 | OneBot 12 适配器 |
| `test-adapter-satori.mjs` | 70 | Satori 适配器 |
| `test-adapter-milky.mjs` | 83 | Milky 适配器（含 WebHook 默认准入与读体上限） |
| `test-adapter-qq-official.mjs` | 109 | QQ 官方适配器（含回调重放防护） |
| `test-plugin.mjs` | 124 | Host 半边：假 ctx + 真适配器 + 真 `lib/index.js`（入口薄壳 → `lib/gateway/plugin.js`），含 Config 契约、热更新、9 个工具、适配器重启、默认准入 fail-closed 与入站限制（124 项含工具注册段落；解析不到 `@deepseek-ai/dsh-tools` 的裸克隆里为 98 项 + 6 项 `[SKIP]`） |
| `test-client.mjs` | 109 | 客户端设置页：模拟模块加载器 + 最小 React 渲染 + 四档标签 + 只写密钥护栏 |
| `test-admin.mjs` | 38 | 权限 · 群管理 · 访客工具闸 |
| `test-http.mjs` | 30 | HTTP / 代理隧道 / IP 归一与公网判定 |
| `test-config.mjs` | 24 | 配置合并、volatile 还原、废弃键清理 |
| `test-websearch.mjs` | 5 | 多引擎搜索结果解析 |
| `test-imagegen.mjs` | 16 | 生图重试 / 轮询 / 响应解析 |
| `test-session-id.mjs` | 5 | 会话 id 回退 |
| `test-compat.mjs` | 14 | 运行时兼容自检 |
| `test-history.mjs` | 20 | 聊天记录鉴权与定向 |
| `test-proactive.mjs` | 84 | 主动发言纯逻辑（时间窗、判据、去重、两段式） |
| `test-proactive-round.mjs` | 35 | 主动发言回合端到端（不动定时器） |
| `test-owner-settings.mjs` | 58 | 拥有者设置通道（白名单 / 确认码 / 限流 / 审计） |
| `test-totp.mjs` | 44 | TOTP / HOTP（RFC 4226 + 6238 官方向量） |
| `test-totp-cli.mjs` | 14 | 终端绑定（secret / otpauth URI / 二维码） |
| `test-qr.mjs` | 18 | 二维码编码器（固定矩阵守回归） |
| `test-flow-auth.mjs` | 35 | 授权状态机（授权 / 重放 / 锁定 / 过期 / 工具绑定） |
| `test-flow-store.mjs` | 17 | 流程脚本存取（路径穿越 / sha 校验 / 目录删不掉要报错） |
| `test-flow-commands.mjs` | 49 | `/auth` 与 `/flow` 解析（含不可见字符与控制符） |
| `test-flow-gate.mjs` | 16 | 流程授权闸门 |
| `test-flow-wiring.mjs` | 23 | 闸门接线：一次调用只吃一个授权 / 关着原样放行 / moli_fetch 进 gatedTools 后「没码被拦、拿码放行」 |
| `test-interim.mjs` | 14 | 中间发言：最后一条留给结论、锚点丢了不重播 |
| `test-security.mjs` | 55 | 安全回归：帧 id 净化 / 越界复核 / 跨群重算 / 撤回绑群 / 出站公网判定与 F1 / 识图下载源码断言 |
| `test-model-router.mjs` | 23 | 模型路由自动检测：agentDefaultModel 优先 / llm 只读 / 都没有不假装；偏好文件 fallback |
| `test-stream-bridge.mjs` | 18 | 官方 v2 私聊流式桥：增量合并、节流、done 收尾、失败停用、取消 |
| `test-msgid-cache.mjs` | 13 | 入站去重：首见/复见、TTL 过期、有界淘汰、空 id、重复不延 TTL |
| `test-valve-assembly.mjs` | 31 | 三道阀门的契约字段、装配顺序与依赖、网络判定口径（编码变体 / 云元数据 / 本机保留名 / 域名不误判）、**代理归属**（阀门接管传输层、工具不持有代理串）、工具阀一次性消费、消息组装顺序、传输层注册表 |
| `test-qq-bind.mjs` | 19 | 扫码绑定状态机：二维码等待 / 凭据只经回调一次 / 失败与刷新 / 异步工厂 / 路由不泄露 appSecret |
| `test-chunk.mjs` | 15 | 回复分条：短文本原样 / 长文本不超限且不丢行 / 代码块围栏成对 / 表格不切行 / 超长单行硬切 / 未闭合围栏兜底 |
| `test-gate-guard.mjs` | 18 | 闸门区改动判定：关着不需要码 / 没码·错码·无 secret 拒绝 / 对码接受 / ±1 窗口 / 开关本身变更也要码 / 名单没变时清码 |
| `test-guard-proxy.mjs` | 47 | 内网校验代理：CONNECT 与明文请求拒绝回环 / 元数据 / 私网 / IPv6 / 6to4 / Teredo / localhost；用「本地监听器 accept 计数 = 0」证明真的没有连过去（把判定改成一律放行必然变红），另覆盖上游代理链路与 403/502 语义分离、CONNECT 目标归一（尾点 / userinfo / 多冒号）、并发 start 去重、socks5 上游告警、拒绝后不崩、stop 后端口关闭 |

**手动联调**（假 OneBot 端口正好是 NapCat 默认值，不用真 QQ 号）：

```sh
node test/mock-onebot.mjs --http-port 3000 --ws-port 3001
# 另开终端：伪造一条 @机器人的群消息
node -e "fetch('http://127.0.0.1:3000/__inject',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message_type:'group',group_id:33333,user_id:22222,nickname:'小明',message:[{type:'at',data:{qq:'10000'}},{type:'text',data:{text:'你好'}}]})}).then(r=>r.json()).then(console.log)"
# 看它回了什么
node -e "fetch('http://127.0.0.1:3000/__sent').then(r=>r.json()).then(j=>console.log(JSON.stringify(j.messages,null,2)))"
```

> **文档里的测试数必须自洽**：改测试就同步本表、README 的「37 套件 / 1361 项」与顶部 `tests` 徽章（`tests-1361%20passing`）、`AI-DISCLOSURE.md` 的验证情况。数字以裸克隆跑 `npm test` 的输出为准；能解析到 `@deepseek-ai/dsh-tools` 的环境里 `test-plugin` 与 `test-admin` 会多跑工具注册段落，总数随之更多。跳过项按 `[SKIP]` 单列，不计入通过数；设 `DSH_TOOLS_DISABLE=1` 可以在这台机器上模拟裸克隆（否则 `test/dsh-tools-link.mjs` 会把链接建回来，永远看不到跳过路径——CI 就是这么红的）。

<a id="完整配置参考"></a>
## 3. 完整配置参考

下面是全部字段与默认值（等价于「设置页什么都不改」的状态）。落点是 profile 的 `cordis.patch.yml`，**不要改包内的同名文件**。

```yaml
- id: dsh-qq-bot
  name: '@sputnikzaychik/dsh-qq-bot'
  config:
    adapterPath: ''
    nodePath: ''
    protocol: "onebot11"   # onebot11 | onebot12 | satori | milky | qq-official
    mode: "forward"   # forward | reverse（仅 onebot11/12）
    onebot:
      wsUrl: "ws://127.0.0.1:3001"   # mode=forward 用
      listen: "0.0.0.0:6199"   # mode=reverse 用
      httpUrl: "http://127.0.0.1:3000"   # 留空则改用 WS action 发消息
      accessToken: ''
    protocols:
      onebot12:
        wsUrl: "ws://127.0.0.1:3001"
        httpUrl: "http://127.0.0.1:3000"
        listen: "0.0.0.0:6199"
        accessToken: ''
        mode: "forward"
      satori:
        wsUrl: "ws://127.0.0.1:5140"
        httpUrl: "http://127.0.0.1:5140"
        token: ''
        platform: "qq"
        selfId: ''
      milky:
        wsUrl: "ws://127.0.0.1:3010/event"
        httpUrl: "http://127.0.0.1:3010"
        accessToken: ''
      qqOfficial:
        mode: "webhook"
        appId: ''
        appSecret: ''
        botSecret: ''
        listen: "0.0.0.0:8443"
        path: "/qqbot"
    group:
      enabled: true
      allow: []   # 群号白名单，空数组 = 所有群
      requireAt: true
    private:
      enabled: true
      allow: []   # 用户号白名单，空数组 = 所有人
    commandPrefix: ''   # 例如 '/ai'，空串 = 不限制
    reply:
      maxChars: 1200
      ackAfterMs: 8000   # 慢回合先回 ackText；0 关闭
      ackText: "正在处理，请稍候…"
      firstTurnHint: "（提示：这是一次 QQ 聊天。请用简体中文、简洁自然的口语作答；不要输出 Markdown 表格，代码块保持简短。群聊里被 @ 或需要结合群内近期消息/图片作答时，主动调 qq_history 工具拉取聊天记录与图片。）"
      contextHeader: true   # 给消息加 "[QQ群 123 · 小明(22222)]" 前缀
      botReply: true   # 回复（引用）bot 的消息也算 @
      interim: true   # 中间发言：长回合里先说的那几句单独发（不引用、不 @）
      interimMaxPerTurn: 4   # 每回合最多几条（0 = 关）
      interimMinGapMs: 2500   # 两条之间最短间隔
    limits:
      perMinute: 20   # 每个（会话, 用户）每分钟最多驱动几个回合（防刷额度；超了回一句提示）
      queueMax: 5   # 同一会话最多排几个待处理回合（超了直接拒收，不排队）
      maxChars: 4000   # 单条消息正文上限（超出截断，避免几十 KB 整段进提示词）
    auth:
      owners: []   # 拥有者：全权限 + 永久授权
      superAdmins: []   # 高级管理员：群管理权限，不能永久授权
      ownerPreset: ''   # 填了才把拥有者/非拥有者分成两条会话（仅人格分离）
      guestPreset: ''   # 非拥有者用的 preset（仅人格分离，不是安全边界）
      grantTtlMinutes: 60
      grantMaxTtlMinutes: 1440
      guestToolAllow: ["qqgroup", "qq_websearch", "qq_webfetch", "qq_imgsearch", "qq_history"]   # 访客仍可用的工具白名单（qqbot / qqconfig / qq_draw 只给拥有者；不放 moli_fetch）
      guestDshTools: false   # 是否允许访客用 DSH 内部工具（默认否）
      ownerSettings: true
      ownerSettingsMaxPerHour: 6
      ownerSettingsMaxPerDay: 30
    admin:
      enabled: true
      manageGroups: []   # 可管理的群；空 = 回退用 group.allow
      requireGroupAdmin: true
      prefix: "/"
      dryRun: false   # true = 只回复将执行什么
      allowConsole: false   # 允许 Web UI 会话直接调用管理工具
    moli:
      enabled: false   # qq_webfetch 改用 Moli 引擎渲染；需引擎就绪（设置页卡片检测，dsh-moli 只负责装引擎）
      exePath: ''      # 留空 = 自动探测 ~/.local/bin/moli 与 PATH
      proxy: ''        # 留空 = 透传 webSearch.proxy
      defaultTimeoutMs: 30000   # 对应 moli 的 -t
      maxChars: 200000          # 单次输出上限（超出按头尾省略）
      insecureTls: true         # 跳过 TLS 证书校验（默认开）：关掉后自签名证书 / 网关 TLS 拦截 / CRL 取不到都会让渲染失败
      guardProxy: true          # 内网防护：moli 全部流量（重定向 / 子资源 / 页面 JS）先过本地校验代理；确定是内网才拒（403），
                                # 本机解析不了的域名交给上游代理解析，连接类失败回 502
      allowGuest: true          # 允许访客（群聊 / 别人的私聊）触发渲染；关掉后只有拥有者私聊可用，访客退回普通抓取
      rateLimitPerMin: 5        # 每个会话每分钟最多渲染几次（0 = 不限；普通抓取不受限）
      maxConcurrentRenders: 2   # 全局同时最多几个渲染在跑（跨会话，0 = 不限；超出的直接返回忙，不排队）
    flowAuth:
      enabled: false   # 流程授权总开关（子代理/队友/工作流需私聊动态码）
      totpSecret: ''   # base32；node lib/valve/security/totp-cli.mjs enroll 生成后粘过来（不经 QQ）
      enrolledAt: 0   # 0 = 未确认绑定；>0 后设置页不再展示二维码
      grantTtlSeconds: 30
      maxAttempts: 5
      lockoutMinutes: 15
      gatedTools: ["subagent", "subagent_fork", "spawn_teammate", "workflow", "moli_fetch"]   # 要过闸门的工具名
      gateEditCode: ""   # 改上面这份名单时一次性填的 6 位码（GUI「闸门区」填；校验后插件清空，不落盘）
      recoveryHashes: []
      recoverySalt: ''
    flow:
      deliver: "private"   # 产物流向：private | group:<群号> | none
      maxBytes: 20971520
      maxFiles: 40
      skipHidden: true
    session:
      fixedName: true   # 新会话名固定为 群聊_<群号> / 私聊_<QQ号>
    perChatSession: true   # true = 每个 QQ 会话一条 DSH 会话
    agentPreset: ''   # '' = 部署默认 preset；可填 standard / ptc / minimal / cordis 或自定义 id
    restart:
      baseMs: 1000
      maxMs: 30000
    logAdapterFrames: false
    vision:
      enabled: true
      provider: ''   # 视觉 provider（留空 = 会话模型）
      model: ''   # 视觉模型 id（留空 = 会话模型；须声明 input: [text, image]）
      maxImages: 3   # 单条消息最多送入几张图
      downloadTimeoutMs: 10000
    webSearch:
      baseUrl: ''
      apiKeyEnv: ''
      proxy: ''   # http://host:port；留空直连；搜索与抓取都走它
      maxUses: 5
      multiEngine: true   # 多引擎组合搜索（关则落回官方 DeepSeek web_search）
    imgSearch:
      enabled: true
      maxResults: 5
      saucenaoKey: ''   # SauceNAO API key；留空不启用该引擎
      weightedShuffle: false   # 有代理时按体量权重随机重排引擎顺序
    history:
      scopeMessages: 5   # 识图窗口：触发消息往前多少条
      imageLimit: 3   # 窗口内最多识别几张图
    proactive:
      enabled: false
      groups: []   # 生效群号；留空 = 不启用
      intervalMinutes: 60
      windowMessages: 30
      minNewMessages: 6
      quietHours: ["23:00-08:00"]
      maxPerHour: 2
      maxPerDay: 8
      minGapMinutes: 15
      eventGuard: true
      staleMinutes: 15
      topicCooldownMinutes: 120
      provider: ''   # 留空 = 跟随群会话模型（零密钥）
      model: ''
      speakProvider: ''
      speakModel: ''   # 填了才启用两段式（判断 / 发言分用两个模型）
      speakFallback: true
      requireCjk: false   # 发送前兜底：没有中文且长于 12 字就丢掉
      timeoutMs: 60000
      maxChars: 120
      interests: ''
      persona: ''
      dryRun: false   # 演练：只记日志不发送
      verbose: false
    imageGen:
      enabled: false
      baseUrl: ''   # OpenAI 兼容，例 https://api.example.com/v1
      apiKeyEnv: "IMAGE_API_KEY"
      apiKey: ''   # 只写字段；留空则读 apiKeyEnv
      model: "seedream-5.0-lite"
      size: "1024x1024"
      timeoutMs: 180000
      maxAttempts: 4
      retryIntervalMs: 5000
      poll: true
      pollIntervalMs: 5000
      maxPolls: 30
    persona:
      enabled: false   # 自定义人格：每个新会话第一轮附一次
      name: ''
      text: ''
    agentPresetCustom: ''   # 非空时优先于 agentPreset
```

- **volatile 字段**（设置页可编辑的那些）改动即时生效，会触发 `loader/volatile-update`；连接类字段（`protocol` / `mode` / 各协议连接参数）改动会重启适配器。
- `onebot.accessToken` / `flowAuth.totpSecret` / `flowAuth.recoverySalt` / `imageGen.apiKey` / `imgSearch.saucenaoKey` 是 `role('secret')`：**只写**，不下发到浏览器，空值不会覆盖已有值。
- 本插件只认自己那一行：改配置形成的残留键会被自动清理（见 ARCHITECTURE.md「废弃配置自动清理」）。

<a id="工具细节"></a>
## 4. 工具细节

插件注册 9 个工具，访客只能看到 `auth.guestToolAllow` 里的。工具之间共用同一套权限判定（见 README「权限与指令」）。

### qqbot

- `{action:'status'}` —— 连接状态、模式、适配器 pid/端口、各会话回合数、统计计数、当前 DSH 运行时版本。
- `{action:'send', message_type:'group'|'private', target_id:'123', text, image?}` —— 主动发一条消息；`image` 是本地绝对路径（**只允许 `<QQ_msg>/qq-images` 目录内**），插件转 base64 与文本一起发。
- `{action:'interrupt', conversation:'group-123'|'all'}` —— 中断正在跑的回合。

### qq_websearch

`{query, max_uses?}` → `{ok, count, sources, text}`。默认多引擎组合：Tavily（配 `TAVILY_API_KEY` 才启用）→ DuckDuckGo（html→lite，串行 + 限流记忆）→ Yandex / Bing / Wikipedia 并发兜底，聚合去重；`multiEngine: false` 落回官方 DeepSeek web_search。请求都走 `webSearch.proxy`（非空时 HTTP CONNECT 隧道 + TLS）。

### qq_webfetch

`{url, max_chars?}` → 抓公网网页原文；抓取前校验目标为公网 IP，内网 / 回环 / 私有地址一律拒绝（防经代理扫内网）。`moli.enabled` 时改用无头浏览器渲染（可抓 SPA），未检测到引擎时返回 `moliUnavailable` 明确报错，**不回退**普通抓取（要普通抓取请自己再调一次）；渲染失败会区分「被内网防护拦下 / 上游代理不可达 / 目标 4xx-5xx / 没拿到内容」四种文案。

### qq_imgsearch

`{url | file, max_results?, kind?}` → `{ok, count, sources, via, text}`。

- 本地文件：先上传图床（zixiaoyun / scdn / uguu 按质量加权随机，依次试到成功）拿公网 URL 再反搜；上传失败直接文件传 TraceMoe。`file` 限 `qq-images` 目录内。
- 引擎顺序：无代理按可用性（TraceMoe → IQDB → SauceNAO（有 key）→ Soutubot）；有代理放开全部按体量（Yandex → Tineye → Copyseeker → SauceNAO → Soutubot → IQDB → TraceMoe），`weightedShuffle` 时按权重随机重排。
- `kind=comic`：漫画截图优先 Soutubot → SauceNAO → IQDB → TraceMoe；配合 `file` 时不上图床。

实测（2026-10）：直连可用 TraceMoe / IQDB / Soutubot；代理可用 Copyseeker / Yandex / Tineye（新图未收录时为 0 条）；SauceNAO 需 key；ascii2d / anime_trace / bing / google_lens / ehentai 不可用。

### qq_history

`{group_id?, peer_id?, user_id?, count?, before_seq?, with_images?}` → 聊天记录（时间 / 说话人 / 文本 / 图片）。

- 当前群或当前私聊直读；**跨群**要「拥有者 / 高级管理员」，或「本人是该群管理员且该群在可管理范围」；别人的私聊只有拥有者 / 高级管理员能读。
- 分页：`before_seq` 传上一页最旧的 `message_id`，返回的 `next_before` 是下一页游标。
- 识图窗口锚定「触发本条回复的那条消息」往前 `history.scopeMessages` 条、最多 `history.imageLimit` 张。

### qq_draw

`{prompt, model?, size?, reference?, caption?, send?}`：`send` 默认 true，直接画成 QQ 图片段发到当前会话。失败策略：429 / 5xx / 网络错 / 空结果按 `retryIntervalMs` 重试到 `maxAttempts`；4xx 直接报错不重试。响应是 `task_id` 时按 `pollIntervalMs` 轮询（依次试 `/images/generations/<id>`、`/images/tasks/<id>`、`/tasks/<id>`），最多 `maxPolls` 次。图片落盘 `<QQ_msg>/qq-images/gen/`。

接口约定：OpenAI 兼容 `POST <baseUrl>/images/generations`，请求体 `{model, prompt, n:1, size?, image?}`，返回 `data[0].url` 或 `data[0].b64_json`。

### qqauth

只在拥有者私聊可用（`flowAuth.enabled` 关着时直接拒绝）：`{action:'request', purpose?}` 申请一次授权、`{action:'status'}` 看开关 / 绑定状态 / 待授权与未用授权（不打印密钥）。

### qqgroup

见 README 的权限表。工具路径的授权依据是「当前会话最近一条消息是否来自管理员白名单」——群里普通成员没法靠一句话驱动管理动作，这是提示注入的主要防线。

### qqconfig

拥有者私聊里改设置：`show` / `propose` / `apply` / `cancel`。`propose` 只校验不写盘并返回一次性确认码（TTL 5 分钟，绑定 owner + path + value + revision）；`apply` 前复核 revision，走 `ctx.settings.update`（schema 校验 + 原子写 + 热重载），本模块不手改 YAML。限流每小时 6 次 / 每天 30 次，审计写 `QQ_msg/qqbot-config-audit.jsonl`。总开关 `auth.ownerSettings`。

### web_fetch（DSH 自带）

仍然注册，但**已从访客默认白名单移除**：访客抓网页请用 `qq_webfetch`。拥有者不受白名单限制。

### 人格

两条路互不冲突：**自定义人格**（`persona.*`，每个新会话第一轮附一次设定，零额外 token）与**整档 preset**（`agentPreset` / `agentPresetCustom`，换的不只是人格还有工具面）。

三个 preset 字段（`agentPresetCustom` / `auth.ownerPreset` / `auth.guestPreset`）都在设置页「高级 → 会话与排错」，标了「如果你不知道你在做什么，最好别动这个」：它们只决定人格与工具面偏好，**不是安全边界**（边界是访客工具白名单与流程授权）。用户加装了不影响安全的第三方扩展插件、又没进任何 preset 时，正确的用法是在 DSH 里自建一个 preset、把这些插件行加进它的 `plugins`，再把 id 填到 `agentPresetCustom`（或分流的两个字段）——而不是去放宽白名单。

## 5. 主动发言（细节）

默认关闭，只有 `enabled: true` **且** `groups` 显式列了群号才生效。流程：按 `intervalMinutes` 看一次群里最近 `windowMessages` 条 → 频率 / 时段 / 新消息量闸门 → 模型判断要不要接、接什么 → 文本校验（长度、链接、@、重复）→ 发送或安静待着。

- **两段式（可选）**：填了 `speakModel` / `speakProvider` 才启用；判断阶段只出 `{speak, topic}`，正文交给发言模型写。判断阶段仍在写回退正文，精简 judge 提示词时别把它删了，否则 `speakFallback` 会静默失效。最坏 5 次模型调用（判断 3 + 发言 2）。
- **`requireCjk`（默认关）**：正文没有 CJK 且长度 > 12 判为不可用。治的是「中文群里整句英文拒答模板」；长度按**码点**算（`Array.from(text).length`），阈值是代码常量 `CJK_MIN_LENGTH`。
- **`eventGuard`（默认开）**：最新消息超过 `staleMinutes` 视为过错窗口；最新一条只是应答不插话；两个人来回说时视为他们的对话；同话题 `topicCooldownMinutes` 内不重复。
- 提示词有两道防编造约束（`topic` 只能来自聊天记录、发言阶段只用记录里的信息），但模型编造是概率性的，只能压低不能消除。
- `dryRun: true` 只记日志，先观察再开。

## 6. 流程授权（细节）

`flowAuth.enabled` 打开后，QQ 会话里的原生编排工具（`subagent` / `subagent_fork` / `spawn_teammate` / `workflow`）与第三方抓取工具（`moli_fetch`）被同名遮蔽接管：拥有者私聊要过一次 6 位动态码，其它会话直接拿到「只能在拥有者私聊里驱动」的拒绝。DSH 里正常建的会话不受影响。

- 密钥导入**不走 QQ**：设置页「高级 → 流程授权 → 绑定二维码」就地生成 base32 密钥并画二维码，认证器扫码绑定；也可以用 `node lib/valve/security/totp-cli.mjs enroll` 在服务器上生成后粘贴。密钥只存 seed，不写日志。
- 授权窗口 `grantTtlSeconds`（默认 30 秒，最小 30）内 **1 次有效**，用掉即弃；连续错 `maxAttempts` 次锁 `lockoutMinutes` 分钟。
- 这一轮跑完把会话工作区里**本轮新增/改动**的文件打包回传（`flow.deliver`：`private` / `group:<群号>` / `none`），数量与体积受 `flow.maxFiles` / `flow.maxBytes` 限制；产物上传依赖协议端支持 `upload_private_file` / `upload_group_file`。
- **手机丢了**：`node lib/valve/security/totp-cli.mjs recovery` 打印盐、8 条一次性恢复码与哈希；把哈希与盐填进设置页，明文抄纸上。之后私聊发 `/auth XXXXX-XXXXX`（字母+数字，靠格式与 6 位动态码区分）。

`/flow` 指令（只认拥有者私聊）：

| 指令 | 作用 |
| --- | --- |
| `/flow ls` | 列出 `<QQ_msg>/flows/` 里的流程脚本（名字 / 标题 / 脚本 sha 前 8 位） |
| `/flow use <名字>` | 设为活动流程（下次授权带上这个名字） |
| `/flow off` | 取消活动流程 |
| `/flow rm <名字>` | 删除流程脚本与元数据 |
| `/flow auth [用途]` | 手动发起一次授权请求 |
| `/flow reset` | 清空待授权请求与未用授权 |
| `/flow unbind <6位动态码>` | 解绑（必须交一码，光发 `/flow unbind` 不解绑） |

流程脚本是"下次跑什么"的任务书，**插件不执行它**：执行仍由模型用 `workflow` / `spawn_teammate` 完成。

## 7. 跨对话检索

- **QQ 层：`qq_history`** —— 只读，权限见工具细节。
- **会话层：DSH 的 `session_search` 系列**（`@deepseek-ai/dsh-tool-session-query` 的 5 个只读工具）。授权规则是「目标会话的 cwd 与调用方完全一致」，QQ 的每个会话都落在同一个 `QQ_msg` 工作区，所以彼此可检索。在专属 preset 里挂一行即可：

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

  不挂就没有这 5 个工具，`qq_history` 的跨群读取不受影响。

## 8. 文件清单

目录按关注点分层，阀门独立成模块、由组装根按优先级装起来（详见 `ARCHITECTURE.md`）。

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 包入口**薄壳**：只转发到 `lib/gateway/plugin.js`（导出 `name` / `inject` / `Config` / `apply`） |
| `lib/assemble.js` | **组装根**：按 `STAGE` 表把三道阀门依次成型；`describeAssembly()` 给启动日志 |
| `lib/config.js` | `Config` schema、`DEFAULTS`、深合并、volatile 还原、废弃键识别 |
| **阀门层** | |
| `lib/valve/index.js` | 阀门注册表：有哪几道阀门、成型顺序、依赖关系（**调优先级只改这里**） |
| `lib/valve/network/` | 网络阀门：`index.js` 门面（能不能出站 / 代理语义）、`policy.js` 纯判定（公网/内网/钉地址）、`guard-proxy.js` 本地校验代理 |
| `lib/valve/security/` | 安全阀：`index.js` 门面 + `totp.js` `flow-auth.js` `flow-store.js` `history-auth.js` `owner-settings.js` `totp-cli.mjs` |
| `lib/valve/tool/` | 工具阀：`index.js` 门面（名单 / 拦截 / 改闸门要码）+ `gate-guard.js` |
| **网关层** | |
| `lib/gateway/plugin.js` | Cordis 插件主体：适配器生命周期、帧分发、回合/回复/视觉、主动发言、配置热更新 |
| `lib/gateway/index.js` | HTTP 路由统一挂载（`ROUTE_MOUNTS` 表 + webServer 就绪 + 逆序注销） |
| `lib/gateway/routes-bind.js` | 扫码绑定的两条具名路由 |
| `lib/gateway/commands.js` | `/auth` `/flow` 解析、拦截判定、产物输入归一 |
| **消息组装层** | |
| `lib/message/index.js` | 组装入口：中间发言 → 正文分条 → 流式合并（`assembleReply` 纯函数） |
| `lib/message/` | `chunk.js` 分条、`stream.js` 流式桥、`interim.js` 中间发言、`segments.mjs` 统一段、`msgid-cache.js` 入站去重 |
| **工具层** | |
| `lib/tools/index.js` | 9 个模型工具（统一走 `registerTool`，DSH 0.2 契约） |
| `lib/tools/` | `websearch.js` 组合搜索、`imgsearch.js` 反搜 + 图床、`imagegen.js` 生图、`moli.js` 引擎封装、`qr.js` 二维码编码器 |
| **会话层** | |
| `lib/session/manager.js` | 会话创建 / 复用、固定命名、访客工具闸、编排工具闸门接管 |
| `lib/session/` | `model-router.js` 模型选择、`workspace.js` QQ_msg 工作区根、`proactive.js` 主动发言纯逻辑 |
| **平台接口层** | |
| `lib/api/group-admin.js` | 群管理指令、三路权限、动态授权 |
| `lib/api/qq-bind.js` | 官方 Bot 扫码绑定状态机 |
| **传输层** | |
| `lib/transport/index.js` | 协议名 -> 适配器路径注册表（新增协议只改这里） |
| `lib/transport/adapters/` | 协议适配器：onebot11 / onebot12 / satori / milky / qq-official |
| `lib/transport/bridge/` | 适配器共享层：手写 WebSocket、stdio 契约（`CONTRACT.md` 是写新适配器的入口） |
| `lib/transport/onebot-adapter.mjs` | 兼容入口（一行 import 到 `adapters/onebot11.mjs`） |
| **公共层** | |
| `lib/shared/http.js` | HTTP 传输机制：直连 / CONNECT 代理隧道 / 超时 / 体积上限（判定在 `valve/network/policy.js`） |
| `lib/shared/compat.js` | DSH 版本兼容自检（只维护两个常量） |
| **浏览器侧** | |
| `lib/client/settings.js` | 客户端半边（手写 bundle）：插件面板里的设置区。**模块 id 与插槽 key 必须等于 npm 包名**，设置命名空间仍是条目 id |
| **其他** | |
| `cordis.patch.yml` | bundle 补丁：把插件插入 profile 组合树（`id` 固定，`name` 跟包名走） |
| `test/` | 37 个测试套件 + `mock-onebot.mjs`（零依赖 OneBot 11 模拟器）+ `dsh-tools-link.mjs`（给宿主编译期服务建临时链接） |
| `examples/dynamic-package-host.js` | 动态 Cordis Package 版（不装包也能在当前进程里试） |

## 9. 设计说明（踩过的坑）

### 权限边界里刻意不收紧的两处（2026-10-27 复审结论）

- **拥有者全权，不受 `admin.manageGroups` 约束**：`manageGroups` 是给「群管理员 / 动态授权」
  划范围的，拥有者本来就该能管任何群。要收紧得先定义「拥有者也不能越界的群范围」，
  那属于产品决策，不是漏洞——所以这里只记录，不改代码。
- **`qqbot status` 会回 `wsUrl` / `workspace` / 会话列表**：这不是 QQ 路径上的越权——QQ 会话里
  status 要求拥有者，非 QQ 会话（Web UI / 任务板 / 子代理）只放行这个只读动作，而能看到它的
  本来就是能操作这台机器的人。脱敏会直接降低排障效率，因此保持原样；`send` / `interrupt`
  这类外发动作仍然单独要 `admin.allowConsole`。

- **为什么中间要子进程？** 动态插件沙箱没有 `fetch` / `WebSocket` / `require`；用 `ctx.subprocess` 拉真 Node 进程、换行分隔 JSON 通信，协议层可独立测试，换 QQ 框架不影响插件。
- **为什么用 `sessionController` 建会话？** 直接 `agentLoop.create()` 建的 Agent 没装模型路由（首次请求必败）；`sessionController.create()` + `resolveAgent()` 才是官方组装路径。
- **为什么用 `whenIdle()` + `deriveMessages()` 取回复？** 回合串行排队，回合后会话日志最新一条有文本的 assistant 消息就是回复，比订阅流式事件简单稳。
- **访客工具闸为什么用 guard？** 拆会话破坏对话一致性；`restrict` 是静态过滤器需反复增删（工具面抖动还会多记 `request/header`）。`tools.guard` 注册一次、每次执行才求值：0 额外 token、单会话单历史；标志位必须在**串行回合内部**设置。
- **设置契约为什么跟 DSH 0.1.7 改？** 0.1.7 删了 `settings.register()`，改为读插件导出的 schemastery `Config`（可编辑字段必须 `.volatile()`）；volatile 变更不重挂插件，需监听 `loader/volatile-update` 自己刷新配置。
- **为什么动态 `import('@deepseek-ai/dsh-tools')`？** 它是 peerDependency，由 DSH 提供；动态 import + try/catch，包不在时桥接照样工作。
- **客户端为什么有两个 id？** DSH 的 client-modules 按 **npm 包名**索引模块行、插件面板也按包名派发配置区，而设置命名空间是**条目 id**。0.12.1 改名后前两个没跟着改，就出现「整块插件加载失败 / 配置区空白」——0.12.2 修的就是这个，别再写死旧名字。

## 10. 不想重启 DSH 也能先跑起来

`examples/dynamic-package-host.js` 是同一套桥接的「动态 Cordis Package」版本：交给 `cordis_define`（`code.host`）再 `cordis_run`，与常驻插件共用同一份磁盘源码。
优点：立刻生效、不用重启；限制：**DSH 一重启就没了**，长期在线还得装包。动态沙箱里没有 `require` / `fetch` / `setTimeout`，传输层必须靠 `ctx.subprocess` 拉子进程。

## 11. 发布流程

1. 改 `package.json` 的 `version`（**不要手动打 tag**），同时更新 `CHANGELOG.md` 与文档里的版本号。
2. 推 `main`。`.github/workflows/release.yml`（Auto Release）在 push 触达 `package.json` 时启动：
   checkout → `actions/setup-node@v4`（node 24）→ 读版本 → 已存在同名 tag 就跳过 → `npm install && npm test` →
   `npm publish --provenance --access public` → 用「引入这个版本的第一个提交」的提交信息做正文建 GitHub Release。
3. 发布走 **Trusted Publishing（OIDC）**：`permissions: id-token: write`，runner 的 npm 必须 ≥ 11.5.1（所以有 setup-node 那一步；npm 10 会在 OIDC 之前就报 `ENEEDAUTH`）。
4. tag 与 Release 由工作流创建；版本号一经发布不可复用（unpublish 过的版本也不行）。
5. 发版后抽查一次 tarball（`npm pack` 或直接下载）确认关键文件在包里。

## 12. 兼容性

- **DSH 版本**：要求 `>= 0.2.0-rc.2 < 0.3.0`。插件启动时读实际版本并判定，日志形如
  `[dsh-qq-bot] 运行于 DSH 0.2.1-rc.3（在声明支持范围 0.2.0-rc.2-0 <= v < 0.3.0-0 内）`；`qqbot status` 的 `runtime` 字段给同一结论。
  支持范围只维护 `lib/shared/compat.js` 的 `SUPPORT_FLOOR` / `SUPPORT_CEILING`，DSH 出新版本不用改代码。识别失败或超范围只提示，不影响收发消息。
- **工具注册与闸门（0.8.0 起）**：注册先 `ctx.get('tools')`，未就绪用 `ctx.inject(['tools'], …)` 动态挂载；闸门走 `agent.ctx.get('tools').guard(…)`，取不到才回退 `agent.ctx.tools`。`tools` 仍是可选服务：没有它插件照常收发消息，只是少几个模型工具。
- **旧会话不会被删**：旧版本建的 QQ 会话可能绑在别的工作区。插件检测到 `belongs to "…"` 时**不动旧会话**（历史完整保留），改用工作区限定的 id（`qqbot-group-<群号>-ws<6位哈希>`）新建一条，重试一次即成功，日志写明。

## 13. 部署备注

- **ARM / 手机容器跑 NapCat**：官方镜像有 arm64 版，但容器里再跑 Docker 通常需要 privileged。备选是直接在容器里跑 NapCat.Shell（要对应的 Linux QQ 版本）。同容器用 `forward` 连 `127.0.0.1:3001` 最省事；跨容器用 `reverse`，让 NapCat 连 `ws://<DSH主机IP>:6199/`。**6099（WebUI）不要暴露到公网**。
- **重启 DSH**：插件是常驻 Cordis 插件，装/升级/改连接方式后都要重启 Host；桌面版重启应用，CLI 重启 `dsh web`。
- **日志**：插件前缀 `[dsh-qq-bot]`，适配器前缀 `[dsh-qq-bot]/adapter`，都打到 Host 的 stdout（systemd 部署看 `journalctl -u dsh-web`）。
- **与 AstrBot 互斥**：AstrBot 也是 OneBot 消费方，两边同时接会让同一条消息被回两次。

## 14. 维护状态

本仓库就是主干：0.8.0 并入下游分支（模块化重构 + 联网/抓取/反搜/历史工具），0.10.0 把协议层拆成 `lib/transport/bridge/` + `lib/transport/adapters/`（一套插件接五种协议），0.11.0 把设置面板搬进插件详情页，0.12 加入流程授权与中间发言。

- 安装跟随 `main`，不再锁 tag；每次合并后在 `main` 打 tag 发 Release。
- 提 issue / PR / Discussions 都欢迎，活跃贡献者会被邀请为协作者。
- 0.6.x 及更早（兼容 DSH ≤ 0.1.6）保留为历史 tag。

**联系**：仓库 [arrow1031-dev/dsh-qq-bot](https://github.com/arrow1031-dev/dsh-qq-bot) · QQ 群 1091766276 · 贡献流程 [CONTRIBUTING.md](CONTRIBUTING.md) · 行为准则 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) · 安全 [SECURITY.md](SECURITY.md)。
