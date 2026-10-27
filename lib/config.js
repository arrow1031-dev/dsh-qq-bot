// 配置契约模块：DEFAULTS 默认值 + Config schema（volatile 设置契约）+ 配置合并工具。
// 被 index.js 用作插件配置来源；设置页(client.js)按 volatile 字段渲染表单。
// Config 契约与 DSH ≥0.1.7 的设置契约：可编辑字段必须标 .volatile()，
// volatile 字段运行时是引用（config.xxx.get()），由 plainConfig 还原成普通对象。
import Schema from '@deepseek-ai/schemastery';

const DEFAULTS = {
  // 留空 = 用包内自带的 lib/onebot-adapter.mjs
  adapterPath: '',
  // 留空 = 启动时用 subprocess.resolveExecutable('node') 解析
  nodePath: '',

  // 协议适配器：同一套插件逻辑，换底层聊天协议只换这个。
  //   onebot11    —— NapCat / go-cqhttp / Lagrange（默认，兼容 0.9 及更早的配置）
  //   onebot12    —— OneBot 12 标准的实现端
  //   satori      —— Satori 协议（Koishi 生态）
  //   milky       —— Milky 协议（NapCat / Yogurt / Lagrange.Milky）
  //   qq-official —— QQ 开放平台官方机器人 API v2（Webhook / WS 网关）
  protocol: 'onebot11',

  // 'forward'：我们连 NapCat（同机/同容器最简单）
  // 'reverse'：NapCat 连我们（跨容器/跨网络更好用）
  mode: 'forward',
  onebot: {
    wsUrl: 'ws://127.0.0.1:3001',      // mode=forward
    listen: '0.0.0.0:6199',            // mode=reverse
    httpUrl: 'http://127.0.0.1:3000',  // 留空则改用 WS action 发消息
    accessToken: '',
  },
  // 非 OneBot 11 协议的连接参数（protocol=onebot11 时全部忽略）
  protocols: {
    onebot12: { wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000', listen: '0.0.0.0:6199', accessToken: '', mode: 'forward' },
    satori: { wsUrl: 'ws://127.0.0.1:5140', httpUrl: 'http://127.0.0.1:5140', token: '', platform: 'qq', selfId: '' },
    milky: { wsUrl: 'ws://127.0.0.1:3010/event', httpUrl: 'http://127.0.0.1:3010', accessToken: '' },
    qqOfficial: { mode: 'webhook', appId: '', appSecret: '', botSecret: '', listen: '0.0.0.0:8443', path: '/qqbot' },
  },

  // 群聊：默认只在被 @ 时响应；allow 为空数组 = 所有群
  group: { enabled: true, allow: [], requireAt: true },
  // 私聊：allow 为空数组 = 所有人
  private: { enabled: true, allow: [] },

  // 例如 '/ai'；空字符串 = 不限制
  commandPrefix: '',

  reply: {
    maxChars: 1200,
    ackAfterMs: 8000,
    ackText: '正在处理，请稍候…',
    firstTurnHint: '（提示：这是一次 QQ 聊天。请用简体中文、简洁自然的口语作答；'
      + '不要输出 Markdown 表格，代码块保持简短。'
      + '群聊里被 @ 或需要结合群内近期消息/图片作答时，主动调 qq_history 工具拉取聊天记录与图片。）',
    contextHeader: true,
    // 群聊：被回复（引用）了机器人消息时，视同 @ 处理并响应；
    // 且会拉取最近相关发言（该用户与 bot）作为上下文。
    botReply: true,
    // 中间发言：回合里模型先说的那几句（「我先查一下」）单独发出去，不引用、不 @；
    // 最终结论仍走正常回复（含引用）。默认开着，嫌吵就在设置页关掉。
    interim: true,
    interimMaxPerTurn: 4,
    interimMinGapMs: 2500,
  },

  // 入站限制（#22）：一条消息 = 一个完整 LLM 回合，所以频率与队列都得有上限。
  limits: {
    perMinute: 20,    // 每个（会话, 用户）每分钟最多驱动几个回合；超了只回一句提示
    queueMax: 5,      // 同一会话最多排几个待处理回合；超了直接拒收（不排队）
    maxChars: 4000,   // 单条消息正文上限（超出截断，避免把几十 KB 贴进提示词）
  },

  // 群管理。方案 A = Agent 工具（qqgroup），方案 B = QQ 侧管理员指令。
  // 安全默认：operators 为空 => 谁都不能做管理操作，必须显式授权。
  // 权限：三路并行取并集（静态名单 / 动态授权 / 本群身份），另加拥有者的路由特权。
  auth: {
    // 拥有者 QQ 号：全部权限 + 永久授权 + 可走独立的拥有者会话。
    // **留空 = fail-closed**：插件不驱动任何会话（#27），必须先在设置里填上自己的 QQ 号。
    owners: [],
    superAdmins: [],          // 后台设定的高级管理员：群管理权限（不可永久授权）
    ownerPreset: '',          // 拥有者会话用的 agent preset（留空则不分流）
    guestPreset: '',          // 非拥有者会话用的 agent preset（留空则与拥有者共用）
    grantTtlMinutes: 60,      // 群管理员动态授权的默认时长（分钟）
    grantMaxTtlMinutes: 1440, // 群管理员单次可授的最长时长（分钟）
    // 非拥有者的工具闸：默认禁止访客使用 DSH 内部工具（bash/读写/子代理/…）。
    // 用白名单而不是黑名单——例如 run_code（PTC 保留传输）不在名单里就自动被挡。
    guestToolAllow: ['qqgroup', 'qq_websearch', 'qq_webfetch', 'qq_imgsearch', 'qq_history', 'moli_fetch'],  // 访客仍可用工具（qqbot/qqgroup 自带鉴权；qq_websearch 联网搜索、qq_webfetch 抓原文、moli_fetch 渲染抓取，均经 webSearch.proxy）
    guestDshTools: false,     // 若确实想让访客也能用 DSH 工具，改成 true
    // 拥有者设置通道（qqconfig 工具）：只有拥有者本人在私聊里能把一部分设置改回 profile 配置。
    // 落盘走 DSH settings 服务；权限校验在 lib/owner-settings.js，白名单 + 两步确认 + 限流 + 审计。
    ownerSettings: true,      // 总开关：关掉后 qqconfig 一律拒绝
    ownerSettingsMaxPerHour: 6,
    ownerSettingsMaxPerDay: 30,
  },
  admin: {
    enabled: true,
    manageGroups: [],        // 可管理的群号；空 = 回退用 group.allow（再空 = 不限制到群）
    requireGroupAdmin: true, // 是否承认「本群管理员」这一路权限
    prefix: '/',            // QQ 侧指令前缀（必须位于消息首位）
    dryRun: false,           // true = 只回复「将执行什么」，不真执行
    allowConsole: false,     // 是否允许非 QQ 来源（如 Web UI 会话）调用管理工具
  },

  // Moli 无头浏览器引擎（qq_webfetch 的渲染抓取路径；未安装则开关无效）
  moli: { enabled: false, proxy: '', exePath: '' },
  // 流程授权（私聊二次验证）：高危工具（子代理 / 队友 / 工作流）开跑前，先要主人在
  // 私聊里回一次 6 位动态码。动态码是标准 TOTP（RFC 6238，HMAC-SHA1 / 30 秒 / 6 位），
  // 密钥只在本机配置里，用任意认证器 App 就能算——插件不内置「万能码」，也没有测试后门。
  flowAuth: {
    enabled: false,
    totpSecret: '',        // base32 密钥；在服务器上 node lib/totp-cli.mjs enroll 生成后粘到设置页（不经 QQ）
    enrolledAt: 0,         // 0 = 未确认绑定；>0 = 确认绑定的时间（确认后设置页不再展示二维码）
    grantTtlSeconds: 30,   // 一次授权多久内有效：只给 30 秒（一次性码的意义就在窗口短）
    maxAttempts: 5,        // 连续错几次锁定
    lockoutMinutes: 15,    // 锁定多久
    gatedTools: ['subagent', 'subagent_fork', 'spawn_teammate', 'workflow'],
    recoveryHashes: [],    // 可选：恢复码的 scrypt 哈希（hex，盐单独填 recoverySalt），一次性
    recoverySalt: '',
  },
  // 产物投递：被授权的流程跑完这一轮后，把会话工作区里本轮新增/改动的文件打包送出。
  flow: {
    deliver: 'private',    // private | group:<群号> | none
    maxBytes: 20971520,    // 打包上限（字节，默认 20 MiB）
    maxFiles: 40,          // 最多打包几个文件
    skipHidden: true,      // 跳过以 . 开头的文件/目录
  },
  // 会话命名
  session: { fixedName: true },

  perChatSession: true,
  agentPreset: '',
  restart: { baseMs: 1000, maxMs: 30000 },
  logAdapterFrames: false,

  // 图片视觉：QQ 收到图片时，下载图片并用 DSH 已配置的视觉模型做图片理解，
  // 把识别结果并入 Agent 的输入。不新增 baseURL/apiKeyEnv——模型、协议、
  // baseURL、API key 全部沿用 DSH 里原本填写的自定义 providers（如你的自定义 provider）。
  // provider/model 都留空 = 用会话当前模型；模型不支持图片时给出可读报错，
  // 引导用户到插件设置里切换支持视觉的模型（如 deepseek-v4-flash-vision-exp）。
  // 注意：deepseek-v4-flash-0731 实测不真正支持图片（返回空/假装看图），
  // 请在 DSH 的 llm-pi-ai providers 里把视觉模型声明为 input: [text, image]。
  vision: {
    enabled: true,            // 关闭则图片保持 [图片] 占位符
    provider: '',             // 视觉 provider 路由（留空 = 会话模型）
    model: '',                // 视觉模型 id（留空 = 会话模型）
    maxImages: 3,             // 单条消息最多送入的图片数
    downloadTimeoutMs: 10000, // 图片下载超时（毫秒）
  },

  // 联网搜索（qq_websearch 工具）：复用 DSH 的 DeepSeek web search（Anthropic Messages 格式）。
  // proxy 只作用于搜索请求（默认直连）；留空 = 直连官方端点。
  webSearch: {
    baseUrl: '',   // 搜索 API 端点（留空 = https://api.deepseek.com/anthropic/v1）
    apiKeyEnv: '', // API key 环境变量名（留空 = DEEPSEEK_BALANCE_API_KEY）
    proxy: '',     // 自定义 HTTP 代理 http://host:port（留空 = 直连；仅用于搜索请求）
    maxUses: 5,    // 每次搜索最多触发次数
    // 多引擎组合搜索（默认开）：Tavily（配 TAVILY_API_KEY 才启用）→ DuckDuckGo →
    // Yandex / Bing / Wikipedia 兜底，全部请求受上方 proxy 管控；关闭则落回官方
    // DeepSeek web_search（deepseek-official）。本插件独立实现，不依赖任何其它插件。
    multiEngine: true,
  },
  // 图片反搜（qq_imgsearch 工具）：TraceMoe + IQDB，全部请求受上方 webSearch.proxy 管控。
  imgSearch: {
    enabled: true,  // 设置页开关；关闭后 qq_imgsearch 返回「已关闭」
    maxResults: 5, // 每次最多返回结果数
    saucenaoKey: '', // SauceNAO API key（saucenao.com 注册可得）；留空则不启用 SauceNAO
    weightedShuffle: false, // 有代理时按体量权重随机重排引擎顺序（避免固定引擎一直打头）
  },

  // qq_history 工具（AI 自取聊天记录与图片）：识别窗口锚定「最新提及」那条消息，
  // 往前 scopeMessages 条内的图片才识别（更早的 @ 不锚定、不重复识图）；
  // 单次最多 imageLimit 张（最近的优先）。
  history: {
    scopeMessages: 5,  // 识图往回找几条消息
    imageLimit: 3,     // 这个范围内最多识别几张图（最新优先）
  },
  // 主动发言：按间隔看群里的最近消息，由模型自己决定要不要接一句（默认关）。
  // 只有 enabled + groups 都配了才跑；免打扰、频率上限、最小间隔都在这里控。
  proactive: {
    enabled: false,
    groups: [],               // 生效群号；必须显式列，留空 = 不启用
    intervalMinutes: 60,      // 检查间隔（分钟，最小 5）
    windowMessages: 30,       // 每次拉最近多少条
    minNewMessages: 6,        // 至少多少条新消息才考虑接话
    quietHours: ['23:00-08:00'],
    maxPerHour: 2,
    maxPerDay: 8,
    minGapMinutes: 15,
    eventGuard: true,          // 事件/话题去重总开关（关掉 = 退回 0.10.0 的行为）
    staleMinutes: 15,          // 最新消息超过这么久就当事件已过气，不接话
    topicCooldownMinutes: 120, // 同一话题在这么久内不再重复
    provider: '',             // DSH provider（留空 = 跟随群会话模型，和识图一致）
    model: '',                // 模型 id（留空 = 跟随群会话模型）
    speakProvider: '',        // 发言阶段 provider（留空 = 同判断阶段）
    speakModel: '',           // 发言阶段模型（留空 = 单段模式：判断输出里直接带正文）
    speakFallback: true,      // 两段式下发言阶段没有产出时，回退用判断模型给的那句
    requireCjk: false,        // 发送前兜底：整句无 CJK 且长于 12 字判为不可用（默认关；只建议中文群开）
    timeoutMs: 60000,
    maxChars: 120,
    interests: '',            // 话题偏好（可空；接什么仍由模型决定）
    persona: '',              // 主动发言人设（留空 = 用 persona.text）
    dryRun: false,
    verbose: false,
  },
  // 生图（qq_draw）：调用你自己填的 OpenAI 兼容图片接口，插件不内置任何 key。
  // 失败会按 retryIntervalMs 重试 maxAttempts 次（429 / 5xx / 网络错 / 空结果）；
  // 供应商返回 task_id 时会继续轮询 pollIntervalMs，最多 maxPolls 次。
  imageGen: {
    enabled: false,
    baseUrl: '',
    apiKeyEnv: 'IMAGE_API_KEY',
    apiKey: '',
    model: 'seedream-5.0-lite',
    size: '1024x1024',
    timeoutMs: 180000,
    maxAttempts: 4,
    retryIntervalMs: 5000,
    poll: true,
    pollIntervalMs: 5000,
    maxPolls: 30,
  },

  // 人格（人设）：enabled 时，每个新会话第一轮末尾附一次身份设定。
  // 想用 DSH preset 那种「整套人格 + 工具面」就用 agentPreset / agentPresetCustom。
  persona: {
    enabled: false,
    name: '',
    text: '',
  },

  // 自定义 preset id（设置页下拉只列内置四个）；非空时优先于 agentPreset。
  agentPresetCustom: '',

};

// -------------------------------------------------------------- 配置契约
// 只有 volatile 字段能被「设置」页改（settings 服务会校验 isVolatilePath），
// 所以凡是出现在设置界面里的字段都必须标 .volatile()。adapterPath / nodePath /
// restart / reply.firstTurnHint 不在界面上，故意保持普通字段：改它们会走
// 「整体重挂插件」这条更稳的路径。
export const Config = Schema.object({
  adapterPath: Schema.string().default('').description('OneBot 适配器脚本路径（留空 = 用包内自带）'),
  nodePath: Schema.string().default('').description('node 可执行文件（留空 = 自动解析）'),

  protocol: Schema.union([
    Schema.const('onebot11'), Schema.const('onebot12'), Schema.const('satori'),
    Schema.const('milky'), Schema.const('qq-official'),
  ]).default('onebot11').volatile()
    .description('协议适配器：onebot11 / onebot12 / satori / milky / qq-official（切换后适配器自动重启）'),
  mode: Schema.union([Schema.const('forward'), Schema.const('reverse')]).default('forward').volatile()
    .description('连接方式：forward = DSH 连协议端；reverse = 协议端连 DSH（qq-official 用它选择超时？不，它看 protocols.qqOfficial.mode）'),
  onebot: Schema.object({
    wsUrl: Schema.string().default('ws://127.0.0.1:3001').volatile().description('正向 WebSocket 地址'),
    listen: Schema.string().default('0.0.0.0:6199').volatile().description('反向 WebSocket 监听地址'),
    httpUrl: Schema.string().default('http://127.0.0.1:3000').volatile().description('HTTP API 地址（留空 = 改用 WS action 发送）'),
    accessToken: Schema.string().default('').role('secret').volatile().description('NapCat 的 access_token（只写字段）'),
  }),
  protocols: Schema.object({
    onebot12: Schema.object({
      mode: Schema.union([Schema.const('forward'), Schema.const('reverse')]).default('forward').volatile().description('OneBot 12 接入方式'),
      wsUrl: Schema.string().default('ws://127.0.0.1:3001').volatile().description('OneBot 12 正向 WS'),
      listen: Schema.string().default('0.0.0.0:6199').volatile().description('OneBot 12 反向 WS 监听'),
      httpUrl: Schema.string().default('http://127.0.0.1:3000').volatile().description('OneBot 12 HTTP API'),
      accessToken: Schema.string().default('').role('secret').volatile().description('OneBot 12 access_token'),
    }),
    satori: Schema.object({
      wsUrl: Schema.string().default('ws://127.0.0.1:5140').volatile().description('Satori WS 地址（Koishi 默认 5140）'),
      httpUrl: Schema.string().default('http://127.0.0.1:5140').volatile().description('Satori HTTP API'),
      token: Schema.string().default('').role('secret').volatile().description('Satori access token'),
      platform: Schema.string().default('qq').volatile().description('Satori 平台标识（qq / onebot / discord…）'),
      selfId: Schema.string().default('').volatile().description('机器人自身 id（留空 = 首条事件里取）'),
    }),
    milky: Schema.object({
      wsUrl: Schema.string().default('ws://127.0.0.1:3010/event').volatile().description('Milky 事件 WS（/event）'),
      httpUrl: Schema.string().default('http://127.0.0.1:3010').volatile().description('Milky API 基址（/api/:api）'),
      accessToken: Schema.string().default('').role('secret').volatile().description('Milky access_token'),
    }),
    qqOfficial: Schema.object({
      mode: Schema.union([Schema.const('webhook'), Schema.const('ws')]).default('webhook').volatile().description('QQ 官方机器人接入方式'),
      appId: Schema.string().default('').volatile().description('AppID'),
      appSecret: Schema.string().default('').role('secret').volatile().description('AppSecret'),
      botSecret: Schema.string().default('').role('secret').volatile().description('Webhook 回调校验用 secret'),
      listen: Schema.string().default('0.0.0.0:8443').volatile().description('Webhook 监听地址（端口只能 80/443/8080/8443）'),
      path: Schema.string().default('/qqbot').volatile().description('Webhook 回调路径'),
    }),
  }),

  group: Schema.object({
    enabled: Schema.boolean().default(true).volatile().description('启用群聊'),
    allow: Schema.array(Schema.string()).default([]).volatile().description('群号白名单（空 = 所有群）'),
    requireAt: Schema.boolean().default(true).volatile().description('群里必须 @ 机器人才回复'),
  }),
  private: Schema.object({
    enabled: Schema.boolean().default(true).volatile().description('启用私聊'),
    allow: Schema.array(Schema.string()).default([]).volatile().description('私聊白名单（空 = 所有人）'),
  }),

  commandPrefix: Schema.string().default('').volatile().description('命令前缀（空 = 不限制）'),

  reply: Schema.object({
    maxChars: Schema.number().default(1200).volatile().description('单条消息最大字数'),
    ackAfterMs: Schema.number().default(8000).volatile().description('慢回复提示阈值（毫秒，0 = 关闭）'),
    ackText: Schema.string().default('正在处理，请稍候…').volatile().description('慢回复提示文案'),
    firstTurnHint: Schema.string().default(DEFAULTS.reply.firstTurnHint).description('首轮提示词'),
    contextHeader: Schema.boolean().default(true).volatile().description('消息附带来源前缀'),
    botReply: Schema.boolean().default(true).volatile()
      .description('被回复（引用）机器人消息时视同 @ 处理并响应（含最近相关发言上下文）'),
    interim: Schema.boolean().default(true).volatile()
      .description('中间发言：长回合里模型先说的那几句话单独发一条（不引用、不 @），最终结论照常回复'),
    interimMaxPerTurn: Schema.number().default(4).volatile()
      .description('中间发言：每个回合最多几条（0 = 关闭）'),
    interimMinGapMs: Schema.number().default(2500).volatile()
      .description('中间发言：两条之间最短间隔（毫秒）'),
  }),

  limits: Schema.object({
    perMinute: Schema.number().default(20).volatile()
      .description('入站限流：每个（会话, 用户）每分钟最多驱动几个回合'),
    queueMax: Schema.number().default(5).volatile()
      .description('同一会话最多排几个待处理回合（超了直接拒收）'),
    maxChars: Schema.number().default(4000).volatile()
      .description('单条消息正文上限（超出截断）'),
  }),

  auth: Schema.object({
    owners: Schema.array(Schema.string()).default([]).volatile().description('拥有者 QQ 号（留空则不驱动任何会话，必填）'),
    superAdmins: Schema.array(Schema.string()).default([]).volatile().description('高级管理员 QQ 号'),
    ownerPreset: Schema.string().default('').volatile().description('拥有者会话的 agent preset（空 = 不分流）'),
    guestPreset: Schema.string().default('').volatile().description('非拥有者会话的 agent preset（空 = 与拥有者共用）'),
    grantTtlMinutes: Schema.number().default(60).volatile().description('动态授权默认时长（分钟）'),
    grantMaxTtlMinutes: Schema.number().default(1440).volatile().description('群管理员单次可授最长时长（分钟）'),
    guestToolAllow: Schema.array(Schema.string()).default(['qqgroup', 'qq_websearch', 'qq_webfetch', 'qq_imgsearch', 'qq_history', 'moli_fetch']).volatile().description('访客仍可用的工具白名单（默认 qqgroup/qq_websearch/qq_webfetch/qq_imgsearch/qq_history/moli_fetch；qqbot 与 qqconfig 只给拥有者）'),
    guestDshTools: Schema.boolean().default(false).volatile().description('允许非拥有者使用 DSH 内部工具'),
    ownerSettings: Schema.boolean().default(true).volatile()
      .description('允许拥有者在 QQ 私聊里通过 qqconfig 改一部分设置（白名单字段，走 DSH 设置服务，两步确认 + 限流 + 审计）'),
    ownerSettingsMaxPerHour: Schema.number().default(6).volatile().description('拥有者改设置每小时上限'),
    ownerSettingsMaxPerDay: Schema.number().default(30).volatile().description('拥有者改设置每天上限'),
  }),

  moli: Schema.object({
    enabled: Schema.boolean().default(false).volatile()
      .description('启用 Moli 渲染抓取：qq_websearch 的 url 抓取改用 Moli 无头浏览器渲染（可抓 SPA/JS 渲染页；需已安装 moli，否则本开关无效）'),
    proxy: Schema.string().default('').volatile()
      .description('HTTP 代理（留空 = 自动透传 webSearch.proxy）'),
    exePath: Schema.string().default('').volatile()
      .description('moli 可执行文件路径（留空 = 自动探测 ~/.local/bin/moli 与 PATH）'),
  }),

  admin: Schema.object({
    enabled: Schema.boolean().default(true).volatile().description('启用群管理（指令 + qqgroup 工具）'),
    manageGroups: Schema.array(Schema.string()).default([]).volatile().description('可管理的群号（空 = 回退群号白名单）'),
    requireGroupAdmin: Schema.boolean().default(true).volatile().description('承认「本群管理员」这一路权限'),
    prefix: Schema.string().default('/').volatile().description('指令前缀（必须在消息首位）'),
    dryRun: Schema.boolean().default(false).volatile().description('演练模式：只回复将执行什么'),
    allowConsole: Schema.boolean().default(false).volatile().description('允许非 QQ 来源调用管理工具'),
  }),

  perChatSession: Schema.boolean().default(true).volatile().description('每个 QQ 会话一个独立 DSH 会话'),
  agentPreset: Schema.string().default('').volatile().description('Agent preset（空 = 部署默认）'),
  logAdapterFrames: Schema.boolean().default(false).volatile().description('日志打印适配器每一帧（排错）'),

  vision: Schema.object({
    enabled: Schema.boolean().default(true).volatile().description('图片视觉：QQ 收到图片时用视觉模型识别并并入回复'),
    provider: Schema.string().default('').volatile().description('视觉 provider 路由（留空 = 会话模型；复用 DSH 自定义 providers）'),
    model: Schema.string().default('').volatile().description('视觉模型 id（留空 = 会话模型；如 deepseek-v4-flash-vision-exp）'),
    maxImages: Schema.number().default(3).volatile().description('单条消息最多送入的图片数'),
    downloadTimeoutMs: Schema.number().default(10000).volatile().description('图片下载超时（毫秒）'),
  }),

  webSearch: Schema.object({
    baseUrl: Schema.string().default('').volatile().description('搜索 API 端点（留空 = https://api.deepseek.com/anthropic/v1）'),
    apiKeyEnv: Schema.string().default('').volatile().description('搜索 API key 的环境变量名（留空 = DEEPSEEK_BALANCE_API_KEY）'),
    proxy: Schema.string().default('').volatile().description('自定义 HTTP 代理 http://host:port（留空 = 直连；仅作用于搜索请求）'),
    maxUses: Schema.number().default(5).volatile().description('每次搜索最多触发次数'),
    multiEngine: Schema.boolean().default(true).volatile().description('多引擎组合搜索（Tavily → DuckDuckGo → Yandex/Bing/Wikipedia，全部走 webSearch.proxy）；关闭则落回官方 DeepSeek web_search'),
  }),

  imgSearch: Schema.object({
    enabled: Schema.boolean().default(true).volatile().description('图片反搜（qq_imgsearch：TraceMoe/IQDB/Yandex/Copyseeker/Tineye/SauceNAO，请求受 webSearch.proxy 管控）；关闭后工具返回「已关闭」'),
    maxResults: Schema.number().default(5).volatile().description('每次图片反搜最多返回结果数'),
    saucenaoKey: Schema.string().default('').volatile().description('SauceNAO API key（saucenao.com 注册可得）；留空不启用 SauceNAO'),
    weightedShuffle: Schema.boolean().default(false).volatile().description('有代理时按体量权重随机重排引擎顺序（Yandex/Tineye/Copyseeker 权重高）'),
  }).description('图片反搜'),

  imageGen: Schema.object({
    enabled: Schema.boolean().default(false).volatile().description('生图（qq_draw）：关闭后工具直接返回「未启用」'),
    baseUrl: Schema.string().default('').volatile().description('生图 API 地址（OpenAI 兼容；会请求 <地址>/images/generations）'),
    apiKeyEnv: Schema.string().default('IMAGE_API_KEY').volatile().description('API key 环境变量名（apiKey 留空时才读它）'),
    apiKey: Schema.string().default('').role('secret').volatile().description('生图 API key（只写字段；留空 = 读环境变量）'),
    model: Schema.string().default('seedream-5.0-lite').volatile().description('默认生图模型（如 seedream-5.0-lite / gpt-image-2 / glm-image-1）'),
    size: Schema.string().default('1024x1024').volatile().description('默认尺寸（如 1024x1024 / 1024x1536）'),
    timeoutMs: Schema.number().default(180000).volatile().description('单次请求超时（毫秒）'),
    maxAttempts: Schema.number().default(4).volatile().description('失败重试次数（含首次）'),
    retryIntervalMs: Schema.number().default(5000).volatile().description('失败重试间隔（毫秒）'),
    poll: Schema.boolean().default(true).volatile().description('供应商返回 task_id 时继续轮询结果'),
    pollIntervalMs: Schema.number().default(5000).volatile().description('轮询间隔（毫秒）'),
    maxPolls: Schema.number().default(30).volatile().description('最多轮询次数'),
  }).description('生图（qq_draw）'),

  persona: Schema.object({
    enabled: Schema.boolean().default(false).volatile().description('启用自定义人格：每个新会话第一轮附带身份设定'),
    name: Schema.string().default('').volatile().description('人格名字'),
    text: Schema.string().default('').volatile().description('人格设定（性格 / 说话风格 / 禁忌）'),
  }).description('人格（人设）'),

  agentPresetCustom: Schema.string().default('').volatile()
    .description('自定义 agent preset id（如 qq）；非空时优先于上面的下拉'),

  history: Schema.object({
    scopeMessages: Schema.number().default(5).volatile().description('识图往回找几条消息：从触发消息往前，这么多条消息内的图片才会识别（默认 5）'),
    imageLimit: Schema.number().default(3).volatile().description('上面那个范围里最多识别几张图，从最新的开始数（默认 3）'),
  }).description('聊天记录工具（qq_history）'),

  proactive: Schema.object({
    enabled: Schema.boolean().default(false).volatile().description('启用主动发言：按间隔看群里的最近消息，由模型判断是否接话（默认关）'),
    groups: Schema.array(Schema.string()).default([]).volatile().description('生效群号（必须显式列；留空 = 不启用）'),
    intervalMinutes: Schema.number().default(60).volatile().description('检查间隔（分钟，最小 5）'),
    windowMessages: Schema.number().default(30).volatile().description('每次拉取最近多少条消息'),
    minNewMessages: Schema.number().default(6).volatile().description('至少有多少条新消息才考虑接话'),
    quietHours: Schema.array(Schema.string()).default(['23:00-08:00']).volatile().description('免打扰时段，如 23:00-08:00（可多段）'),
    maxPerHour: Schema.number().default(2).volatile().description('每小时最多主动发言次数'),
    maxPerDay: Schema.number().default(8).volatile().description('每天最多主动发言次数'),
    minGapMinutes: Schema.number().default(15).volatile().description('两次主动发言最小间隔（分钟）'),
    eventGuard: Schema.boolean().default(true).volatile().description('事件去重：跳过过气的事件、只应答一句的插话和刚聊过的话题（关掉 = 退回旧行为，照旧可能重复回复）'),
    staleMinutes: Schema.number().default(15).volatile().description('最新消息超过这么多分钟就视为事件已过气，不接话（避免对已经聊完的事重复回复）'),
    topicCooldownMinutes: Schema.number().default(120).volatile().description('同一话题在这么多分钟内不再重复接话'),
    provider: Schema.string().default('').volatile().description('DSH provider（留空 = 跟随该群会话的模型，和识图一致）'),
    model: Schema.string().default('').volatile().description('模型 id（留空 = 跟随该群会话的模型）'),
    speakProvider: Schema.string().default('').volatile().description('发言阶段 provider（留空 = 与判断阶段相同）'),
    speakModel: Schema.string().default('').volatile().description('发言阶段模型：填了它才启用两段式——判断只出 JSON，正文由这个模型单独写（留空 = 单段模式）'),
    speakFallback: Schema.boolean().default(true).volatile().description('两段式下发言阶段没写出可用正文时，回退用判断模型在同一次输出里给的那句'),
    requireCjk: Schema.boolean().default(false).volatile().description('发送前兜底：正文一个 CJK 字符都没有（且长度 > 12）就判为不可用（默认关；中文群建议开，英文群别开）'),
    timeoutMs: Schema.number().default(60000).volatile().description('单次判断请求超时（毫秒）'),
    maxChars: Schema.number().default(120).volatile().description('单条主动发言最大字数'),
    interests: Schema.string().default('').volatile().description('话题偏好（可空；接什么仍由模型决定）'),
    persona: Schema.string().default('').volatile().description('主动发言用的人设（留空 = 用 persona.text）'),
    dryRun: Schema.boolean().default(false).volatile().description('演练：只记日志不发送'),
    verbose: Schema.boolean().default(false).volatile().description('日志打印每次判断结果'),
  }).description('主动发言（让 bot 自己找话题接话）'),

  session: Schema.object({
    fixedName: Schema.boolean().default(true).volatile().description('固定新建会话名为 私聊_<QQ号> / 群聊_<群号>（替代 LLM 自动起标题）'),
  }).description('会话命名'),

  flowAuth: Schema.object({
    enabled: Schema.boolean().default(false).volatile()
      .description('流程授权：子代理 / 队友 / 工作流开跑前，主人在私聊里回 6 位动态码（标准 TOTP，无万能码）'),
    totpSecret: Schema.string().default('').role('secret').volatile()
      .description('TOTP 密钥（base32；在服务器上 node lib/totp-cli.mjs enroll 生成后粘到这里，密钥不经 QQ）'),
    enrolledAt: Schema.number().default(0).volatile()
      .description('确认绑定的时间戳（0 = 未确认；确认后设置页不再展示二维码与明文）'),
    grantTtlSeconds: Schema.number().default(30).volatile().description('一次授权的有效期（秒，默认 30；小于 30 按 30 处理）'),
    maxAttempts: Schema.number().default(5).volatile().description('连续输错几次锁定'),
    lockoutMinutes: Schema.number().default(15).volatile().description('锁定时长（分钟）'),
    gatedTools: Schema.array(Schema.string()).default(['subagent', 'subagent_fork', 'spawn_teammate', 'workflow']).volatile()
      .description('要授权才能用的工具名（逗号分隔）'),
    recoveryHashes: Schema.array(Schema.string()).default([]).volatile()
      .description('恢复码的 scrypt 哈希（hex，盐填 recoverySalt；一次性；留空 = 不支持恢复码）'),
    recoverySalt: Schema.string().default('').role('secret').volatile().description('恢复码哈希用的盐'),
  }).description('流程授权（私聊二次验证）'),
  flow: Schema.object({
    deliver: Schema.string().default('private').volatile().description('产物投递：private / group:<群号> / none'),
    maxBytes: Schema.number().default(20971520).volatile().description('产物打包上限（字节）'),
    maxFiles: Schema.number().default(40).volatile().description('最多打包文件数'),
    skipHidden: Schema.boolean().default(true).volatile().description('跳过以 . 开头的文件与目录'),
  }).description('流程产物投递'),
  restart: Schema.object({
    baseMs: Schema.number().default(1000),
    maxMs: Schema.number().default(30000),
  }),
}).description('把 QQ 接到 DSH Agent（NapCat / OneBot 11）');

// cordis 的配置引用标记（cosmokit 的共享 symbol），用于把 volatile 字段还原成普通值。
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');
const isVolatileRef = (value) => typeof value === 'object' && value !== null && VOLATILE_WRITE in value;

/** 把（可能含 volatile 引用的）已解析配置还原成普通对象。 */
function plainConfig(value) {
  if (isVolatileRef(value)) return plainConfig(value.get());
  if (Array.isArray(value)) return value.map(plainConfig);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = plainConfig(value[key]);
    return out;
  }
  return value;
}

/** 只递归合并普通对象；数组/标量直接覆盖 */
function mergeConfig(base, override) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (override === null || typeof override !== 'object' || Array.isArray(override)) return override === undefined ? out : override;
  for (const key of Object.keys(override)) {
    const value = override[key];
    if (value === undefined) continue;
    const current = out[key];
    if (current !== null && typeof current === 'object' && !Array.isArray(current)
      && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = mergeConfig(current, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const describeError = (error) => (error === null || error === undefined) ? String(error)
  : (typeof error === 'string' ? error : (typeof error.message === 'string' ? error.message : String(error)));
const describeErrorStatic = describeError;

/**
 * 找出配置里 schema 不认识的键——版本升级删字段后，旧值会一直留在 cordis.patch.yml 里。
 *
 * 只报最浅的一层：整段不认识的子树报一次就够，删掉父键下面自然全没了。
 * 数组、以及没有 dict 的 schema 节点都算叶子——里面的内容由用户决定，不检查。
 *
 * @param {object} raw 配置文件里的那份显式配置（不是合并过默认值的）
 * @param {object} [schema] 插件的 Config schema，默认用本模块导出的
 * @returns {string[]} 形如 ['proactive.judgeProvider', 'onebot.oldUrl'] 的点号路径
 */
/**
 * 找出 patch 层里 schema 不认识的键（版本升级删掉的旧字段就长这样）。
 *
 * 返回「路径数组」而不是点号字符串：配置键名本身可能带点（如 'a.b'），
 * 用点号拼路径再拆回来会删错键——字面键 'a.b' 会被当成 a 下面的 b。
 *
 * @param {object} raw patch 层里的显式配置
 * @param {object} [schema] 默认用本插件的 Config
 * @returns {string[][]} 每个元素是一条键路径，例如 ['proactive', 'judgeProvider']
 */
export function staleConfigPaths(raw, schema) {
  const root = schema === undefined || schema === null ? Config : schema;
  const out = [];
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return out;
  // !!js 表达式（DSH 配置里允许的 js-yaml 标签）解析出来是类实例，不是配置子树。
  // 不跳过的话 cleanup 会把它当成「未知子键」整段删掉，用户的表达式被静默换回默认值。
  const isOpaque = (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return true;
    if (Object.getOwnPropertySymbols(value).length > 0) return true;
    return Object.prototype.hasOwnProperty.call(value, '__jsExpr');
  };
  const walk = (value, node, trail) => {
    // 未知键：哪怕值是 null 也算残留（以前 null/undefined 直接 return，这类脏键永远清不掉）。
    if (node === undefined || node === null) { out.push(trail); return; }
    if (value === null || value === undefined) return;
    if (isOpaque(value) === true) return;
    if (node.dict === undefined || node.dict === null) return;
    if (typeof value !== 'object' || Array.isArray(value)) return;
    for (const key of Object.keys(value)) {
      // DSH 把 !!js 表达式存成 { __jsExpr: ... } 这种带下划线前缀的包装键，不是配置子键。
      if (key.startsWith('__') === true) continue;
      const child = Object.prototype.hasOwnProperty.call(node.dict, key) ? node.dict[key] : undefined;
      walk(value[key], child, trail.concat(key));
    }
  };
  walk(raw, root, []);
  return out;
}

export { DEFAULTS, plainConfig, mergeConfig, describeError };
