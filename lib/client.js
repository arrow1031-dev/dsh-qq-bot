/**
 * dsh-qq-bot —— 客户端半边（浏览器）。
 *
 * 这是一个手写的模块 bundle，格式由 DSH 的客户端模块加载器决定：
 *   window.__ModuleLoader__.load({ id, factory: (require) => module.exports })
 * 只有 `react` 是外部依赖（由运行时提供），其余能力都从 apply(ctx) 注入的服务拿。
 *
 * 作用：在「设置」面板里加一个「QQ 机器人」选项卡，直接改插件配置，
 * 读写走内置的设置 Remote（ctx.remote.settings），不需要自定义 RPC。
 */
// 这个 id 必须等于 **npm 包名**：DSH 的 client-modules 按包名索引模块行，不一致会报
// 「loaded without registering ...」，网页端整个插件加载失败（设置面板也就没了）。
// 注意它和下面 apply(ctx) 里的 NS 不是一回事——NS 是 profile 条目 id（= 设置命名空间），
// 一直是 'dsh-qq-bot'，不随包名变化。
window.__ModuleLoader__.load({
  id: '@sputnikzaychik/dsh-qq-bot',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require('react');
    var h = React.createElement;

    // DSH ≥ 0.1.7 的「设置命名空间」就是 profile 里的条目 id。本插件的 bundle 补丁
    // 插入的 id 是 'dsh-qq-bot'（0.1.6 时代用的是自定义命名空间 'qq-bot'，该 API 已移除）。
    // 插件详情页的配置区用「插槽 key」派发，而插件管理页拿的是 **npm 包名**
    // （renderSlot(..., { entryKey: pkg.name })）。所以 key 必须等于包名；
    // 而下面读写的设置命名空间 NS 仍是 profile 条目 id（'dsh-qq-bot'），两者别混。
    var PKG_NAME = '@sputnikzaychik/dsh-qq-bot';
    var NS = 'dsh-qq-bot';
    // 条目 id 可能被用户改名，所以再加一条「以 qq-bot 结尾且唯一」的回退匹配。
    var NS_FALLBACK = /(^|[-_])qq-bot$/;
    var PREFIX = 'dsh-qq-bot';
    // 「未安装」时卡片上的安装入口（取自 dsh-moli 包的 repository 字段）。
    var MOLI_REPO_URL = 'https://github.com/27painter/dsh-moli';

    // ---------------------------------------------------------------- 表单模型

    var FIELDS = [
      {
        path: ['protocol'], label: '协议', kind: 'select',
        hint: '底层聊天协议；切换后适配器自动重启。OneBot 11 兼容既有配置，QQ 官方机器人选 qq-official',
        options: [
          ['onebot11', 'OneBot 11（NapCat / go-cqhttp / Lagrange）'],
          ['onebot12', 'OneBot 12'],
          ['satori', 'Satori（Koishi 生态）'],
          ['milky', 'Milky（NapCat / Yogurt / Lagrange.Milky）'],
          ['qq-official', 'QQ 官方机器人开放平台 API v2'],
        ],
      },
      {
        path: ['mode'], label: '连接方式', kind: 'select',
        hint: '正向 = DSH 主动连 NapCat（同机/同容器最简单）；反向 = NapCat 连 DSH（跨容器/跨网络）',
        options: [['forward', '正向 WebSocket（DSH → NapCat）'], ['reverse', '反向 WebSocket（NapCat → DSH）']],
      },
      { path: ['onebot', 'wsUrl'], label: '正向 WS 地址', kind: 'text', placeholder: 'ws://127.0.0.1:3001', when: function (v) { return v.mode !== 'reverse'; } },
      { path: ['onebot', 'listen'], label: '反向 WS 监听地址', kind: 'text', placeholder: '0.0.0.0:6199', when: function (v) { return v.mode === 'reverse'; } },
      { path: ['onebot', 'httpUrl'], label: 'HTTP API 地址', kind: 'text', placeholder: 'http://127.0.0.1:3000', hint: '留着用来发消息；清空则退回用 WebSocket action' },
      { path: ['onebot', 'accessToken'], label: 'access_token', kind: 'password', hint: 'NapCat 里设了 token 就填这里' },

      // ---- 非 OneBot 11 协议（protocol 切换后生效，各自的连接参数）----
      { path: ['protocols', 'onebot12', 'mode'], label: 'OneBot 12 接入方式', kind: 'select', options: [['forward', '正向 WebSocket（DSH → 端）'], ['reverse', '反向 WebSocket（端 → DSH）']], when: function (v) { return v.protocol === 'onebot12'; }, hint: '决定下面填「正向 WS 地址」还是「反向 WS 监听」' },
      { path: ['protocols', 'onebot12', 'wsUrl'], label: 'OneBot 12 正向 WS', kind: 'text', placeholder: 'ws://127.0.0.1:3001', when: function (v) { return v.protocol === 'onebot12' && !(v.protocols && v.protocols.onebot12 && v.protocols.onebot12.mode === 'reverse'); } },
      { path: ['protocols', 'onebot12', 'listen'], label: 'OneBot 12 反向 WS 监听', kind: 'text', placeholder: '0.0.0.0:6199', when: function (v) { return v.protocol === 'onebot12' && v.protocols && v.protocols.onebot12 && v.protocols.onebot12.mode === 'reverse'; } },
      { path: ['protocols', 'onebot12', 'httpUrl'], label: 'OneBot 12 HTTP API', kind: 'text', placeholder: 'http://127.0.0.1:3000', when: function (v) { return v.protocol === 'onebot12'; } },
      { path: ['protocols', 'onebot12', 'accessToken'], label: 'OneBot 12 access_token', kind: 'password', when: function (v) { return v.protocol === 'onebot12'; } },
      { path: ['protocols', 'satori', 'wsUrl'], label: 'Satori WS 地址', kind: 'text', placeholder: 'ws://127.0.0.1:5140', when: function (v) { return v.protocol === 'satori'; } },
      { path: ['protocols', 'satori', 'httpUrl'], label: 'Satori HTTP API', kind: 'text', placeholder: 'http://127.0.0.1:5140', when: function (v) { return v.protocol === 'satori'; } },
      { path: ['protocols', 'satori', 'token'], label: 'Satori access token', kind: 'password', when: function (v) { return v.protocol === 'satori'; } },
      { path: ['protocols', 'satori', 'platform'], label: 'Satori 平台标识', kind: 'text', placeholder: 'qq', when: function (v) { return v.protocol === 'satori'; } },
      { path: ['protocols', 'satori', 'selfId'], label: 'Satori bot 自身 id', kind: 'text', placeholder: '（留空 = 首条事件取）', when: function (v) { return v.protocol === 'satori'; } },
      { path: ['protocols', 'milky', 'wsUrl'], label: 'Milky 事件 WS', kind: 'text', placeholder: 'ws://127.0.0.1:3010/event', when: function (v) { return v.protocol === 'milky'; } },
      { path: ['protocols', 'milky', 'httpUrl'], label: 'Milky API 基址', kind: 'text', placeholder: 'http://127.0.0.1:3010', when: function (v) { return v.protocol === 'milky'; } },
      { path: ['protocols', 'milky', 'accessToken'], label: 'Milky access_token', kind: 'password', when: function (v) { return v.protocol === 'milky'; } },
      {
        path: ['protocols', 'qqOfficial', 'mode'], label: 'QQ 官方接入方式', kind: 'select',
        when: function (v) { return v.protocol === 'qq-official'; },
        options: [['webhook', 'Webhook 回调'], ['ws', 'WebSocket 网关']],
      },
      { path: ['protocols', 'qqOfficial', 'appId'], label: 'AppID', kind: 'text', when: function (v) { return v.protocol === 'qq-official'; } },
      { path: ['protocols', 'qqOfficial', 'appSecret'], label: 'AppSecret', kind: 'password', when: function (v) { return v.protocol === 'qq-official'; } },
      { path: ['protocols', 'qqOfficial', 'botSecret'], label: 'Webhook 校验 secret', kind: 'password', when: function (v) { return v.protocol === 'qq-official' && v.protocols.qqOfficial.mode === 'webhook'; } },
      { path: ['protocols', 'qqOfficial', 'selfId'], label: '机器人 QQ 号（self_id）', kind: 'text', placeholder: '例如 123456789', when: function (v) { return v.protocol === 'qq-official'; }, hint: 'webhook 模式不会有 READY 事件，填了才知道「哪个 @ 是在叫我」；留空则群里任何 @ 都会触发回复' },
      { path: ['protocols', 'qqOfficial', 'listen'], label: 'Webhook 监听地址', kind: 'text', placeholder: '0.0.0.0:8443', when: function (v) { return v.protocol === 'qq-official' && v.protocols.qqOfficial.mode === 'webhook'; }, hint: '端口只能是 80 / 443 / 8080 / 8443' },
      { path: ['protocols', 'qqOfficial', 'path'], label: 'Webhook 回调路径', kind: 'text', placeholder: '/qqbot', when: function (v) { return v.protocol === 'qq-official' && v.protocols.qqOfficial.mode === 'webhook'; } },

      { path: ['group', 'enabled'], label: '启用群聊', kind: 'bool' },
      // ---- 接入与范围（命令前缀 + 群/私聊开关与白名单）----
      { path: ['commandPrefix'], label: '命令前缀', kind: 'text', placeholder: '（留空 = 不限制）', hint: '例如 /ai，只有带前缀的消息才会被处理' },
      { path: ['group', 'requireAt'], label: '群里必须 @ 机器人才回复', kind: 'bool' },
      { path: ['limits', 'perMinute'], label: '每人每分钟最多几条', kind: 'number', hint: '同一会话的同一个人每分钟最多驱动几个回合（防刷）' },
      { path: ['limits', 'queueMax'], label: '单会话最多排队几条', kind: 'number', hint: '超过就直接拒收，不排队' },
      { path: ['limits', 'maxChars'], label: '单条消息最大字数（入站）', kind: 'number', hint: '超出截断，避免超长文本整段进提示词' },
      { path: ['group', 'allow'], label: '群号白名单', kind: 'list', hint: '逗号分隔；留空 = 所有群都能用（清空不等于「谁都不许」）。想彻底停掉群聊请关上面的总开关' },
      { path: ['private', 'enabled'], label: '启用私聊', kind: 'bool' },
      { path: ['private', 'allow'], label: '私聊白名单', kind: 'list', hint: '逗号分隔；留空 = 所有人都能私聊（清空不等于「谁都不许」）。想彻底停掉私聊请关上面的总开关' },

      // ---- 身份与权限（QQ 号集中在此）----
      { path: ['auth', 'owners'], label: '拥有者 QQ 号', kind: 'list', hint: '逗号分隔。拥有者 = 全部权限 + 永久授权 + 可走独立会话；留空则不驱动任何会话（必填）' },
      { path: ['auth', 'superAdmins'], label: '后台设定的高级管理员', kind: 'list', hint: '逗号分隔。有群管理权限，但不能永久授权' },
      { path: ['auth', 'grantTtlMinutes'], label: '动态授权默认时长（分钟）', kind: 'number' },
      { path: ['auth', 'grantMaxTtlMinutes'], label: '群管理员单次可授最长（分钟）', kind: 'number' },
      { path: ['auth', 'guestDshTools'], label: '允许非拥有者使用 DSH 内部工具', kind: 'bool', hint: '默认关闭：访客不能用 bash/读写/子代理等（执行级拦截，不是靠提示词）' },
      { path: ['auth', 'guestToolAllow'], label: '访客仍可用的工具白名单', kind: 'list', hint: '逗号分隔，默认 qqgroup,qq_websearch,qq_webfetch,qq_imgsearch,qq_history。用白名单能自动挡住 run_code 这类不在全局层的特殊工具；别放 moli_fetch（能写文件/eval/读本机 cookie）' },
      { path: ['auth', 'ownerSettings'], label: '允许拥有者在 QQ 私聊里改设置', kind: 'bool', hint: '开启后拥有者可以对机器人说「把群 xxx 加进白名单」，机器人会用 qqconfig 工具改（白名单字段、两步确认、限流、审计）。关闭 = 彻底禁用这条通道' },
      { path: ['auth', 'ownerSettingsMaxPerHour'], label: '拥有者改设置每小时上限', kind: 'number' },
      { path: ['auth', 'ownerSettingsMaxPerDay'], label: '拥有者改设置每天上限', kind: 'number' },

      // ---- 群管理 ----
      { path: ['admin', 'enabled'], label: '启用群管理', kind: 'bool', hint: '总开关；关掉后指令与 qqgroup 工具都会拒绝' },
      { path: ['admin', 'manageGroups'], label: '可管理的群号', kind: 'list', hint: '逗号分隔；留空 = 回退用「群号白名单」，再空 = 不限制到群' },
      { path: ['admin', 'requireGroupAdmin'], label: '承认「本群管理员」这一路权限', kind: 'bool', hint: '关闭后只有静态名单与动态授权生效' },
      { path: ['admin', 'prefix'], label: '指令前缀（必须在消息首位）', kind: 'text', placeholder: '/' },
      { path: ['admin', 'dryRun'], label: '演练模式（只回复将执行什么）', kind: 'bool', hint: '先用它确认指令解析是否正确，再关掉真执行' },
      { path: ['admin', 'allowConsole'], label: '允许非 QQ 来源调用管理工具', kind: 'bool', hint: '例如从 Web UI 会话里直接让 Agent 踢人。注意：它放行的是「一切非 QQ 会话」——模型驱动的子代理、任务板、工作流同样算在内，不是只认你本人操作的那一个页面。默认关闭' },

      // ---- 会话 ----
      { path: ['session', 'fixedName'], label: '固定新建会话名（私聊_<QQ号>/群聊_<群号>）', kind: 'bool', hint: '开启后新会话不再用 LLM 自动起标题' },
      { path: ['perChatSession'], label: '每个 QQ 会话独立 DSH 会话', kind: 'bool' },
      { path: ['logAdapterFrames'], label: '日志打印每一帧（排错）', kind: 'bool' },

      // ---- agent preset（四处集中：按生效优先级排列，custom > owner/guest > 通用）----
      { path: ['agentPresetCustom'], label: '① 自定义 agent preset id（优先级最高）', kind: 'text', placeholder: '（留空 = 用下面的③）', hint: '如果你不知道你在做什么，最好别动这个。填 DSH 里自建 preset 的 id（例如 qq），它会整档接管人格 + 工具面，这条生效时 ②③ 全被忽略。加装了不影响安全的第三方扩展插件、却没进任何 preset 的，就在自建 preset 的 plugins 里把插件行加进去，再把 id 填到这里——别为了用扩展去改安全相关的项' },
      { path: ['auth', 'ownerPreset'], label: '② 拥有者会话的 preset', kind: 'text', placeholder: '（留空 = 用下面的③）', hint: '如果你不知道你在做什么，最好别动这个。只对拥有者私聊/所在群生效；换人格用，不是安全边界（工具隔离由访客工具闸负责）；① 非空时被忽略' },
      { path: ['auth', 'guestPreset'], label: '② 非拥有者会话的 preset', kind: 'text', placeholder: '（留空 = 用下面的③）', hint: '如果你不知道你在做什么，最好别动这个。只对访客会话生效；换人格用，不是安全边界；① 非空时被忽略' },
      { path: ['agentPreset'], label: '③ Agent preset（兜底）', kind: 'select', options: [['', '（部署默认）'], ['standard', 'standard（标准工具面，工具直接可见）'], ['ptc', 'ptc（网关模式，工具经 run_code 执行）'], ['minimal', 'minimal（极简）'], ['cordis', 'cordis（插件开发模式）']], placeholder: '（留空 = 部署默认）', hint: '如果你不知道你在做什么，最好别动这个。①② 都留空时才用它。优先级：① 自定义 id > ② 拥有者/访客分流 > ③ 本项 > 部署默认。只影响新会话' },

      // ---- 主动发言（可选，默认关）----
      { path: ['proactive', 'enabled'], label: '启用主动发言', kind: 'bool', hint: '按间隔看群里的最近消息，由模型自己判断要不要接话；默认关闭' },
      { path: ['proactive', 'groups'], label: '主动发言生效群号', kind: 'list', hint: '必须显式列；留空 = 不启用' },
      { path: ['proactive', 'intervalMinutes'], label: '检查间隔（分钟）', kind: 'number' },
      { path: ['proactive', 'minNewMessages'], label: '至少多少条新消息才考虑', kind: 'number' },
      { path: ['proactive', 'windowMessages'], label: '每次拉取消息条数', kind: 'number' },
      { path: ['proactive', 'quietHours'], label: '免打扰时段', kind: 'list', hint: '如 23:00-08:00；逗号分隔可多段' },
      { path: ['proactive', 'maxPerHour'], label: '每小时上限', kind: 'number' },
      { path: ['proactive', 'maxPerDay'], label: '每天上限', kind: 'number' },
      { path: ['proactive', 'minGapMinutes'], label: '两次发言最小间隔（分钟）', kind: 'number' },
      { path: ['proactive', 'eventGuard'], label: '事件去重（防重复回复）', kind: 'bool', hint: '跳过已过气的事件、只是应答一句的插话、以及冷却期内刚聊过的话题；关掉 = 旧行为' },
      { path: ['proactive', 'staleMinutes'], label: '事件过气阈值（分钟）', kind: 'number', hint: '最新消息超过这么久就不再接话，避免对聊完的事重复回复' },
      { path: ['proactive', 'topicCooldownMinutes'], label: '话题冷却（分钟）', kind: 'number', hint: '同一话题在这么久内不再重复接话' },
      { path: ['proactive', 'provider'], label: '判断用 provider', kind: 'select', dynamic: 'provider', placeholder: '（留空 = 群会话模型）', hint: '和识图同一份 DSH 模型目录，走 DSH 已配置的渠道，不需要另外填 key。留空 = 跟随该群会话的模型；群里还没有会话时会按全局 preset 建同一条会话再取' },
      { path: ['proactive', 'model'], label: '判断用模型', kind: 'select', dynamic: 'model', placeholder: '（留空 = 群会话模型）', hint: '跟随上面选的 provider 列出模型。判断只要一句 JSON，挑个便宜快的即可；留空 = 跟随群会话模型' },
      { path: ['proactive', 'speakProvider'], label: '发言阶段 provider（留空 = 与判断相同）', kind: 'select', dynamic: 'provider', placeholder: '（留空 = 与判断阶段相同）', hint: '两段式的发言渠道；留空则沿用判断阶段的 provider' },
      { path: ['proactive', 'speakModel'], label: '发言阶段模型（留空 = 单段模式）', kind: 'select', dynamic: 'model', placeholder: '（留空 = 单段模式：判断输出里直接带正文）', hint: '填了它才启用两段式：判断只出 JSON，正文由这个模型单独写，能用的文风模型和判断解耦；留空则维持现在的单段行为' },
      { path: ['proactive', 'speakFallback'], label: '两段式：发言失败时回退用判断模型的正文', kind: 'bool', hint: '默认开启；关掉则发言阶段写不出可用正文时这一轮就不发' },
      { path: ['proactive', 'requireCjk'], label: '发送前兜底：整句英文（超过 12 字）就丢掉', kind: 'bool', hint: '默认关。中文群建议开：模型偶尔会掉回英文拒答（Sorry, it looks like I can not…），整句不含任何 CJK 时几乎一定是它；英文群务必关掉。12 字符及以下的 ASCII 回应（666 / OK / lol）不会触发' },
      { path: ['proactive', 'timeoutMs'], label: '判断请求超时（毫秒）', kind: 'number', hint: '单次模型判断的超时，低于 5000 会按 5000 处理' },
      { path: ['proactive', 'maxChars'], label: '单条最大字数', kind: 'number' },
      { path: ['proactive', 'interests'], label: '话题偏好（可空）', kind: 'text' },
      { path: ['proactive', 'persona'], label: '主动发言人设（留空 = 复用全局人格）', kind: 'multiline', placeholder: '（留空 = 用下面「人格」组的名字 + 设定）', hint: '两处人设是「专用 + 兜底」关系：这里填了只用这里；留空则自动复用「人格」组的人格名字与设定，不必重复填写' },
      { path: ['proactive', 'dryRun'], label: '演练（只记日志不发送）', kind: 'bool' },
      { path: ['proactive', 'verbose'], label: '日志打印每次判断', kind: 'bool' },

      // ---- 回复 ----
      { path: ['reply', 'maxChars'], label: '单条最大字数', kind: 'number' },
      { path: ['reply', 'ackAfterMs'], label: '慢回复提示阈值（毫秒）', kind: 'number', hint: '0 = 关闭「正在处理」提示' },
      { path: ['reply', 'ackText'], label: '慢回复提示文案', kind: 'text' },
      { path: ['reply', 'contextHeader'], label: '消息附带来源前缀', kind: 'bool', hint: '形如 [QQ群 123 · 小明(22222)]' },
      { path: ['reply', 'botReply'], label: '被回复（引用）机器人消息时视同 @ 处理并响应', kind: 'bool', hint: '默认开启；含拉取该对话者与 bot 的最近相关发言作上下文，回复用 QQ 引用回复' },
      { path: ['reply', 'interim'], label: '中间发言（干活途中先说一句）', kind: 'bool', hint: '默认开启。长回合里模型每写完一段（比如「我先查一下」）就先发一条，不引用也不 @ 任何人；最终结论仍按正常回复发送' },
      { path: ['reply', 'interimMaxPerTurn'], label: '中间发言：每回合最多几条', kind: 'number', hint: '0 = 关闭（等于关掉上一项）' },
      { path: ['reply', 'interimMinGapMs'], label: '中间发言：两条之间最短间隔（毫秒）', kind: 'number', hint: '低于 500 按 500 处理，避免刷屏' },

      // ---- 图片视觉 ----
      { path: ['vision', 'enabled'], label: '图片视觉（识别 QQ 图片并入回复）', kind: 'bool', hint: '关闭后图片保持 [图片] 占位符' },
      { path: ['vision', 'provider'], label: '视觉 provider 路由', kind: 'select', dynamic: 'provider', placeholder: '（留空 = 会话模型）', hint: '复用 DSH 会话界面同一份模型目录；baseURL/apiKey 沿用原配置。⚠️ 留空 = 跟随会话模型，而会话模型不一定支持图片——此时识图会报错，请显式指定一个支持视觉的 provider' },
      { path: ['vision', 'model'], label: '视觉模型 id', kind: 'select', dynamic: 'model', placeholder: '（留空 = 会话模型）', hint: '跟随上面选的 provider 列出模型（如 deepseek-v4-flash-vision-exp）。留空 = 用会话模型：它会先探测是否支持图片，不支持时会直接回一条可读报错，引导你来这里换模型' },
      { path: ['vision', 'maxImages'], label: '单条最多图片数', kind: 'number' },
      { path: ['vision', 'downloadTimeoutMs'], label: '图片下载超时（毫秒）', kind: 'number' },

      // ---- 联网搜索（qq_websearch）----
      { path: ['webSearch', 'proxy'], label: '联网搜索 HTTP 代理', kind: 'text', placeholder: '（留空 = 直连）', hint: 'http://host:port；仅作用于 qq_websearch 联网搜索请求' },
      { path: ['webSearch', 'baseUrl'], label: '搜索 API 端点', kind: 'text', placeholder: '（留空 = https://api.deepseek.com/anthropic/v1）' },
      { path: ['webSearch', 'apiKeyEnv'], label: '搜索 API key 环境变量名', kind: 'text', placeholder: '（留空 = DEEPSEEK_BALANCE_API_KEY）', hint: '搜索服务专用，与生图的 key 互不影响' },
      { path: ['webSearch', 'maxUses'], label: '每次搜索最多触发次数', kind: 'number' },
      { path: ['webSearch', 'multiEngine'], label: '多引擎组合搜索（Tavily → DuckDuckGo → Yandex/Bing/Wikipedia；关闭则用官方 DeepSeek 搜索）', kind: 'bool', hint: '默认开；所有引擎请求都走上面的 HTTP 代理，留空直连' },

      // ---- 图片反搜（qq_imgsearch）----
      { path: ['imgSearch', 'enabled'], label: '图片反搜（qq_imgsearch 多引擎）', kind: 'bool', hint: '默认开；请求受上面的联网搜索 HTTP 代理管控，留空直连' },
      { path: ['imgSearch', 'maxResults'], label: '每次反搜最多返回结果数', kind: 'number' },
      { path: ['imgSearch', 'saucenaoKey'], label: 'SauceNAO API key（可选）', kind: 'text', placeholder: '（留空 = 不启用 SauceNAO）', hint: 'saucenao.com 注册可得；填入后反搜会带上 SauceNAO' },
      { path: ['imgSearch', 'weightedShuffle'], label: '有代理时按权重随机重排引擎', kind: 'bool', hint: '加权随机：Yandex/Tineye/Copyseeker 权重高，避免固定引擎一直打头' },
      // ---- 图片识别窗口（识图）----
      // 键名仍在 history 下（沿用旧配置，不做迁移），但这两项只作用于识图，所以显示在「识图与绘图」里。
      { path: ['history', 'scopeMessages'], label: '识图往回找几条消息', kind: 'number', hint: '群友发图并 @ 机器人时，以那条消息为起点往回找，这么多条消息内的图片才会识别；更早的图直接跳过，别人之前发过的图也不会被重复识别' },
      { path: ['history', 'imageLimit'], label: '这个范围内最多识别几张图', kind: 'number', hint: '上面那个范围里最多识别几张图，从最新的开始数；最小按 1 处理，想彻底关掉识图请把上面的「图片视觉」开关关掉' },
      { path: ['imageGen', 'enabled'], label: '生图（qq_draw）', kind: 'bool', hint: '开启后 AI 能按描述画图；接口/模型/key 由下面几项决定，插件不内置任何 key' },
      { path: ['imageGen', 'baseUrl'], label: '生图 API 地址', kind: 'text', placeholder: 'https://api.example.com/v1', hint: 'OpenAI 兼容：会请求 <地址>/images/generations' },
      { path: ['imageGen', 'model'], label: '生图模型', kind: 'text', placeholder: 'seedream-5.0-lite' },
      { path: ['imageGen', 'size'], label: '默认尺寸', kind: 'text', placeholder: '1024x1024' },
      { path: ['imageGen', 'apiKey'], label: '生图 API key', kind: 'password', placeholder: '（留空 = 读下面的环境变量）', hint: '只写字段：已设置时留空表示保持不变。生图只认这里或下面的环境变量，不再给主动发言兜底' },
      { path: ['imageGen', 'apiKeyEnv'], label: 'API key 环境变量名', kind: 'text', placeholder: 'IMAGE_API_KEY', hint: '上一条留空时才读它；这是生图自己的回退链，主动发言已不再取 key' },
      { path: ['imageGen', 'maxAttempts'], label: '失败重试次数（含首次）', kind: 'number', hint: '429 / 5xx / 网络错 / 空结果会重试；4xx 直接报错不重试' },
      { path: ['imageGen', 'retryIntervalMs'], label: '重试间隔（毫秒）', kind: 'number' },
      { path: ['imageGen', 'poll'], label: '返回 task_id 时继续轮询', kind: 'bool', hint: '异步生图的供应商才有用：关掉则只尝试一次' },
      { path: ['imageGen', 'pollIntervalMs'], label: '轮询间隔（毫秒）', kind: 'number' },
      { path: ['imageGen', 'maxPolls'], label: '最多轮询次数', kind: 'number' },
      { path: ['imageGen', 'timeoutMs'], label: '单次请求超时（毫秒）', kind: 'number' },
      { path: ['persona', 'enabled'], label: '自定义人格（每个新会话生效）', kind: 'bool', hint: '打开后，新会话第一轮末尾会带上下面的身份设定；已建会话不变' },
      { path: ['persona', 'name'], label: '人格名字', kind: 'text', placeholder: '（例：小助手）' },
      { path: ['persona', 'text'], label: '人格设定', kind: 'multiline', hint: '性格 / 说话风格 / 禁忌；越具体越稳定，留空则不加任何身份设定。主动发言未单独设人设时也会复用这里（含上面的名字）' },

      // ---- dsh-moli 接管（qq_webfetch）：卡片 + 现场检测，未安装插件时开关不可启用 ----
      { path: ['moli', 'enabled'], label: 'Moli 渲染抓取', kind: 'moli' },
      { path: ['protocols', 'qqOfficial', '__bind'], label: '扫码绑定（手机 QQ）', kind: 'qqbind', virtual: true, when: function (draft) { return String((draft && draft.protocol) || '') === 'qq-official'; } },
      // ---- 流程授权（私聊二次验证）----
      { path: ['flowAuth', 'enabled'], label: '流程授权（子代理 / 队友 / 工作流先要私聊动态码）', kind: 'bool', hint: '开启后这四个工具开跑前，机器人会在主人私聊里发一条授权请求，主人回 /auth 6位动态码才放行；标准 TOTP，配任意认证器 App，插件不内置万能码' },
      { path: ['flowAuth', 'enrolledAt'], label: '绑定二维码（只展示一次）', kind: 'qr' },
      { path: ['flowAuth', 'totpSecret'], label: 'TOTP 密钥（base32）', kind: 'password', hint: '在服务器上运行 node lib/totp-cli.mjs enroll，把输出的 secret 粘到这里（密钥不经 QQ，避免聊天记录泄露）；只写字段，已设置时留空表示保持不变' },
      { path: ['flowAuth', 'grantTtlSeconds'], label: '一次授权有效期（秒）', kind: 'number', hint: '默认 30 秒（最小 30），一次一用；超时作废——窗口短才叫一次性' },
      { path: ['flowAuth', 'maxAttempts'], label: '连续输错几次锁定', kind: 'number' },
      { path: ['flowAuth', 'lockoutMinutes'], label: '锁定时长（分钟）', kind: 'number' },
      { path: ['flowAuth', 'gatedTools'], label: '需要动态码的工具名', kind: 'list', hint: '逗号分隔；默认 subagent,subagent_fork,spawn_teammate,workflow,moli_fetch。开了动态码后，改这份名单要先在下面填一次 6 位码' },
      { path: ['flowAuth', 'gateEditCode'], label: '改名单用的动态码（6 位）', kind: 'password', hint: '填满 6 位即解锁上面的名单；点「保存」才算消费，保存成功后自动重新锁上并清空。离开设置页不保留解锁状态，也不保留未保存的改动' },
      { path: ['flowAuth', 'recoveryHashes'], label: '恢复码哈希（可选）', kind: 'list', hint: '逗号分隔的 scrypt 哈希（hex）；手机丢了又没备份时用一次性恢复码换授权（私聊发 /auth XXXXX-XXXXX）。留空 = 不用恢复码；生成命令见 README「流程授权」一节' },
      { path: ['flowAuth', 'recoverySalt'], label: '恢复码哈希用的盐', kind: 'password', hint: '与上面那串哈希配对；只写字段' },
      { path: ['flow', 'deliver'], label: '产物投递目标', kind: 'text', placeholder: 'private', hint: 'private = 发到主人私聊；group:<群号> = 发到指定群；none = 只回文字结论' },
      { path: ['flow', 'maxBytes'], label: '产物打包上限（字节）', kind: 'number' },
      { path: ['flow', 'maxFiles'], label: '最多打包文件数', kind: 'number' },
      { path: ['flow', 'skipHidden'], label: '打包时跳过隐藏文件', kind: 'bool' },
    ];

    // ------------------------------------------------------- 主标签分组（连接 / 基本 / 能力 / 高级）
    // 只按 path 头一层归类，不改字段定义，也不动保存/读取逻辑。
    var GROUPS = [
      { id: 'connection', label: '连接', hint: '协议、连接方式、地址与 token；改动会自动重启适配器（不影响 DSH 本身）' },
      { id: 'basic', label: '基本', hint: '准入名单与发言管理（用下方二级标签切换）' },
      { id: 'capability', label: '能力', hint: '识图、绘图、检索、抓取、对话与人格（用下方二级标签切换）' },
      { id: 'advanced', label: '高级', hint: '会话、preset、排错' },
    ];

    var GROUP_OF_HEAD = {
      // 连接（独立标签，排最前）
      protocol: 'connection', mode: 'connection', onebot: 'connection', protocols: 'connection',
      // 基本
      group: 'basic', private: 'basic', commandPrefix: 'basic',
      auth: 'basic', admin: 'basic', reply: 'basic',
      // limits 三项属于入站限流，归「基本」（以前落到兜底的「高级」，按「基本」找找不到）。
      limits: 'basic',
      // 能力
      vision: 'capability', webSearch: 'capability', imgSearch: 'capability',
      imageGen: 'capability', persona: 'capability', agentPresetCustom: 'advanced',
      proactive: 'capability', history: 'capability', moli: 'capability',
      // 高级
      flowAuth: 'advanced', flow: 'advanced',
      session: 'advanced', perChatSession: 'advanced', agentPreset: 'advanced',
      logAdapterFrames: 'advanced', restart: 'advanced',
    };

    // ------------------------------------------------------- 能力标签的二级分组
    // 能力页字段多，再分一层：识图绘图 / 搜索抓取 / 对话人格。
    var SUBGROUPS_BY_TAB = {
      basic: [
        { id: 'access', label: '准入与名单', hint: '群聊 / 私聊的开关与白名单、拥有者与高级管理员、访客可用的工具白名单——管「谁能用」' },
        { id: 'govern', label: '发言与管理', hint: '消息命令前缀、回复策略（字数、@ 回复、上下文头、确认提示）、群管理指令与可管理群——管「怎么说话、怎么管群」' },
      ],
      advanced: [
        { id: 'flow', label: '流程授权', hint: '私聊动态码闸门（TOTP 绑定 / 授权窗口 / 恢复码）与流程产物投递' },
        { id: 'gate', label: '闸门区', hint: '哪些工具必须过一次动态码。开了动态码后，改这份名单（或开关「流程授权」本身）都要先在下面填一次 6 位码：填满即解锁，点保存才消费，保存成功后重新锁上；不保存就不生效，离开页面不保留解锁状态与未保存的改动' },
        { id: 'session', label: '会话与排错', hint: '会话命名、per-chat 会话、agent preset、适配器日志与重启退避' },
      ],
      capability: [
        { id: 'vision', label: '识图与绘图', hint: '图片视觉识别（识图用哪个 provider/模型）与生图（qq_draw 的画图服务、尺寸、参考图）' },
        { id: 'retrieval', label: '搜索与抓取', hint: '联网搜索、图片反搜、网页抓取（含 moli 无头浏览器渲染、代理）' },
        { id: 'dialogue', label: '对话与人格', hint: '人格设定、主动发言、聊天记录读取' },
      ],
    };

    // 字段头一层 → 二级组 id。未列出的字段在所有二级标签下都显示（不会被藏掉）。
    // 个别字段的二级归属与 path 头不一致时在这里覆盖
    // （history.scopeMessages / imageLimit 是识图窗口，键名沿用 history 只为兼容旧配置）。
    var SUBGROUP_OF_PATH = {
      'history.scopeMessages': 'vision',
      'history.imageLimit': 'vision',
      // 两个 preset 字段属于高级页的「会话与排错」（它们的 head 是 auth，但展示位置被 GROUP_OF_PATH 搬到了高级）
      'auth.ownerPreset': 'session',
      'auth.guestPreset': 'session',
      // 闸门区单独一档：名单 + 改名单用的动态码放一起，免得和 TOTP 绑定/窗口参数混在一起。
      'flowAuth.gatedTools': 'gate',
      'flowAuth.gateEditCode': 'gate',
    };

    var SUBGROUP_OF_HEAD = {
      // 基本
      group: 'access', private: 'access', auth: 'access',
      commandPrefix: 'govern', reply: 'govern', admin: 'govern', limits: 'govern',
      // 能力
      vision: 'vision', imageGen: 'vision',
      webSearch: 'retrieval', imgSearch: 'retrieval', moli: 'retrieval',
      persona: 'dialogue', proactive: 'dialogue', history: 'dialogue',
      // 高级页的两个二级组
      flowAuth: 'flow', flow: 'flow',
      session: 'session', perChatSession: 'session', agentPreset: 'session', agentPresetCustom: 'session', logAdapterFrames: 'session', restart: 'session',
    };

    function subGroupOf(field) {
      var exact = SUBGROUP_OF_PATH[field.path.join('.')];
      if (exact !== undefined) return exact;
      return SUBGROUP_OF_HEAD[field.path[0]];
    }

    // 精确到字段的覆盖：个别字段虽挂在某组下，但要跟着另一档显示
    // （auth.ownerPreset / guestPreset 属 preset 家族，统一放「高级」与另两个 preset 相邻）。
    var GROUP_OF_PATH = {
      'auth.ownerPreset': 'advanced',
      'auth.guestPreset': 'advanced',
    };

    function groupOf(field) {
      var exact = GROUP_OF_PATH[field.path.join('.')];
      if (exact !== undefined) return exact;
      var head = field.path[0];
      return GROUP_OF_HEAD[head] === undefined ? 'advanced' : GROUP_OF_HEAD[head];
    }

    function getPath(object, path) {
      var cursor = object;
      for (var i = 0; i < path.length; i += 1) {
        if (cursor === null || cursor === undefined || typeof cursor !== 'object') return undefined;
        cursor = cursor[path[i]];
      }
      return cursor;
    }

    function setPath(object, path, value) {
      var next = JSON.parse(JSON.stringify(object === null || object === undefined ? {} : object));
      var cursor = next;
      for (var i = 0; i < path.length - 1; i += 1) {
        if (cursor[path[i]] === null || typeof cursor[path[i]] !== 'object') cursor[path[i]] = {};
        cursor = cursor[path[i]];
      }
      cursor[path[path.length - 1]] = value;
      return next;
    }

    function sameValue(a, b) {
      if (a === b) return true;
      if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (var i = 0; i < a.length; i += 1) if (!sameValue(a[i], b[i])) return false;
        return true;
      }
      if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
        var ka = Object.keys(a); var kb = Object.keys(b);
        if (ka.length !== kb.length) return false;
        for (var j = 0; j < ka.length; j += 1) {
          if (!Object.prototype.hasOwnProperty.call(b, ka[j])) return false;
          if (!sameValue(a[ka[j]], b[ka[j]])) return false;
        }
        return true;
      }
      return false;
    }

    function messageOf(error) {
      if (error === null || error === undefined) return String(error);
      if (typeof error === 'string') return error;
      if (typeof error.message === 'string') return error.message;
      return String(error);
    }

    // 设置 Remote 的返回是 { ok, value } 信封；这里兼容直接返回值的实现。
    function unwrap(response) {
      if (response === null || response === undefined) return undefined;
      if (typeof response === 'object' && Object.prototype.hasOwnProperty.call(response, 'ok')) {
        return response.ok === true ? response.value : undefined;
      }
      return response;
    }
    function errorOf(response) {
      if (response !== null && response !== undefined && typeof response === 'object' && response.ok === false) {
        return messageOf(response.error);
      }
      return '未知错误';
    }

    // ------------------------------------------------------------------- 样式
    // 用中性色，浅色/深色主题下都可用；不依赖具体主题 token。
    var S = {
      wrap: { padding: '4px 2px 24px', display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '620px' },
      hint: { fontSize: '12px', opacity: 0.65, lineHeight: 1.5 },
      row: { display: 'flex', flexDirection: 'column', gap: '5px' },
      label: { fontSize: '13px', fontWeight: 500 },
      input: {
        fontSize: '13px', padding: '6px 9px', borderRadius: '6px', width: '100%', boxSizing: 'border-box',
        border: '1px solid rgba(127,127,127,0.35)', background: 'rgba(127,127,127,0.06)', color: 'inherit',
      },
      // 下拉框：文字/背景用主题变量（--dsw-alias-*），默认主题与 maid-atelier 都能看清。
      select: {
        fontSize: '13px', padding: '6px 9px', borderRadius: '6px', width: '100%', boxSizing: 'border-box',
        border: '1px solid rgba(127,127,127,0.35)',
        background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06))',
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      selectDisabled: {
        fontSize: '13px', padding: '6px 9px', borderRadius: '6px', width: '100%', boxSizing: 'border-box',
        border: '1px dashed rgba(127,127,127,0.3)',
        background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06))',
        color: 'var(--dsw-alias-label-dimmed, rgba(127,127,127,0.55))',
        opacity: 0.75, cursor: 'not-allowed',
      },
      option: {
        color: 'var(--dsw-alias-label-primary, inherit)',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
      },
      checkboxRow: { display: 'flex', alignItems: 'center', gap: '8px' },
      actions: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '4px' },
      button: {
        fontSize: '13px', padding: '6px 16px', borderRadius: '6px', cursor: 'pointer',
        border: '1px solid rgba(127,127,127,0.4)', background: 'rgba(127,127,127,0.14)', color: 'inherit',
      },
      buttonGhost: {
        fontSize: '13px', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer',
        border: '1px solid rgba(127,127,127,0.25)', background: 'transparent', color: 'inherit',
      },
      notice: { fontSize: '12px', opacity: 0.8 },
      // 标签页外壳：顶端标签 + 可滚动主体 + 常驻底栏（仿 dsh-service 设置顶端）
      shell: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, padding: '4px 2px 0', boxSizing: 'border-box' },
      tabBar: {
        flex: 'none', display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'flex-end',
        borderBottom: '1px solid rgba(127,127,127,0.28)', paddingBottom: '0',
      },
      tab: {
        fontSize: '13px', lineHeight: '20px', padding: '7px 16px', cursor: 'pointer',
        border: '1px solid transparent', borderBottom: 'none',
        borderRadius: '8px 8px 0 0', background: 'transparent',
        color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.85))', fontWeight: 500,
        marginBottom: '-1px', transition: 'color .15s, background .15s',
      },
      tabActive: {
        fontSize: '13px', lineHeight: '20px', padding: '7px 16px', cursor: 'pointer',
        border: '1px solid rgba(127,127,127,0.28)', borderBottom: '1px solid var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06))',
        borderRadius: '8px 8px 0 0',
        background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.08))',
        color: 'var(--dsw-alias-label-primary, inherit)', fontWeight: 600,
        marginBottom: '-1px',
      },
      subTabBar: {
        flex: 'none', display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center',
        padding: '10px 2px 0',
      },
      subTab: {
        fontSize: '12px', lineHeight: '18px', padding: '4px 12px', borderRadius: '999px', cursor: 'pointer',
        border: '1px solid rgba(127,127,127,0.28)', background: 'transparent',
        color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.85))',
        transition: 'background .15s, color .15s',
      },
      subTabActive: {
        fontSize: '12px', lineHeight: '18px', padding: '4px 12px', borderRadius: '999px', cursor: 'pointer',
        border: '1px solid transparent',
        background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.14))',
        color: 'var(--dsw-alias-label-primary, inherit)', fontWeight: 600,
      },
      body: {
        flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
        display: 'flex', flexDirection: 'column', gap: '12px',
        padding: '14px 2px 12px',
      },
      groupHint: { fontSize: '12px', opacity: 0.6, lineHeight: 1.5, marginBottom: '2px' },
      footer: {
        flex: 'none', position: 'sticky', bottom: 0, zIndex: 2,
        display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
        padding: '12px 2px', marginTop: '2px',
        borderTop: '1px solid rgba(127,127,127,0.28)',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
      },
      error: { fontSize: '13px', color: '#d9534f', lineHeight: 1.6 },
      // 「Moli 渲染抓取」卡片（状态徽标 + 开关 + 检测按钮）
      moliCard: {
        display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px 14px',
        border: '1px solid rgba(127,127,127,0.28)', borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.05))',
      },
      moliHead: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px' },
      moliTitles: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
      moliTitle: { fontSize: '13px', fontWeight: 600 },
      moliSub: { fontSize: '11px', opacity: 0.6 },
      moliBadgeOk: {
        fontSize: '11px', lineHeight: '18px', padding: '0 8px', borderRadius: '999px', whiteSpace: 'nowrap',
        border: '1px solid rgba(63,160,90,0.45)', background: 'rgba(63,160,90,0.16)', color: 'inherit',
      },
      moliBadgeWarn: {
        fontSize: '11px', lineHeight: '18px', padding: '0 8px', borderRadius: '999px', whiteSpace: 'nowrap',
        border: '1px solid rgba(200,150,40,0.45)', background: 'rgba(200,150,40,0.16)', color: 'inherit',
      },
      moliBadgeBad: {
        fontSize: '11px', lineHeight: '18px', padding: '0 8px', borderRadius: '999px', whiteSpace: 'nowrap',
        border: '1px solid rgba(217,83,79,0.45)', background: 'rgba(217,83,79,0.14)', color: 'inherit',
      },
      moliBadgeIdle: {
        fontSize: '11px', lineHeight: '18px', padding: '0 8px', borderRadius: '999px', whiteSpace: 'nowrap',
        border: '1px solid rgba(127,127,127,0.35)', background: 'rgba(127,127,127,0.12)', color: 'inherit',
      },
      moliBody: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' },
      moliToggle: { display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px', cursor: 'pointer' },
      moliToggleDisabled: { display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px', cursor: 'not-allowed', opacity: 0.55 },
      moliDetail: { fontSize: '12px', opacity: 0.7, lineHeight: 1.55 },
      moliAdv: {
        display: 'flex', flexDirection: 'column', gap: '10px', paddingTop: '10px',
        borderTop: '1px dashed rgba(127,127,127,0.28)',
      },
      moliAdvItem: { display: 'flex', flexDirection: 'column', gap: '4px' },
      moliLink: { color: 'var(--dsw-alias-brand-primary, #4a90d9)', textDecoration: 'underline', cursor: 'pointer' },
      moliForced: { fontSize: '12px', color: '#d9534f', lineHeight: 1.5 },
      buttonGhostDisabled: {
        fontSize: '13px', padding: '6px 12px', borderRadius: '6px', cursor: 'not-allowed',
        border: '1px solid rgba(127,127,127,0.2)', background: 'transparent', color: 'inherit', opacity: 0.5,
      },
    };

    // --------------------------------------------------------------- 界面组件

    function QQBotSection(props) {
      var loadConfig = props.loadConfig;
      var saveConfig = props.saveConfig;
      var loadModelCatalog = props.loadModelCatalog;

      // 顶部标签：连接 / 基本 / 能力 / 高级。切标签只换视图，不改数据、不触发读写。
      var tabHook = React.useState(GROUPS[0].id);
      var tab = tabHook[0];
      var setTab = tabHook[1];

      // 二级标签：按主标签分别记忆当前选中的子分组（{ basic: 'access', capability: 'vision' }）。
      var subTabHook = React.useState({});
      var subTabMap = subTabHook[0];
      var setSubTabMap = subTabHook[1];

      var subs = SUBGROUPS_BY_TAB[tab] || null;
      var subTab = (subs !== null && subTabMap !== null && typeof subTabMap[tab] === 'string' && subTabMap[tab] !== '')
        ? subTabMap[tab]
        : (subs === null ? '' : subs[0].id);

      var setSubTab = React.useCallback(function (id) {
        setSubTabMap(function (current) {
          var next = Object.assign({}, (current === null || current === undefined) ? {} : current);
          next[tab] = id;
          return next;
        });
      }, [tab]);

      var stateHook = React.useState({ phase: 'loading', error: null, value: null, revision: undefined, secrets: [] });
      var state = stateHook[0];
      var setState = stateHook[1];

      var draftHook = React.useState(null);
      var draft = draftHook[0];
      var setDraft = draftHook[1];

      var noticeHook = React.useState('');
      var notice = noticeHook[0];
      var setNotice = noticeHook[1];

      var savingHook = React.useState(false);
      var saving = savingHook[0];
      var setSaving = savingHook[1];

      var reload = React.useCallback(function () {
        setState({ phase: 'loading', error: null, value: null, revision: undefined, secrets: [] });
        return Promise.resolve(loadConfig()).then(function (result) {
          if (result !== null && result !== undefined && result.ok === true) {
            setState({ phase: 'ready', error: null, value: result.value, revision: result.revision, secrets: result.secrets || [] });
            setDraft(JSON.parse(JSON.stringify(result.value === null || result.value === undefined ? {} : result.value)));
          } else {
            setState({ phase: 'error', error: (result && result.error) || '读取设置失败', value: null, revision: undefined, secrets: [] });
          }
        }, function (error) {
          setState({ phase: 'error', error: messageOf(error), value: null, revision: undefined, secrets: [] });
        });
      }, [loadConfig]);

      React.useEffect(function () { void reload(); }, [reload]);

      // 模型目录（官方 API / 登录账号 / 自定义 providers），供视觉 provider/model 下拉。
      var catalogHook = React.useState(null);
      var catalog = catalogHook[0];
      var setCatalog = catalogHook[1];

      var loadCatalog = React.useCallback(function () {
        if (typeof loadModelCatalog !== 'function') { setCatalog(null); return undefined; }
        setCatalog({ phase: 'loading' });
        return Promise.resolve(loadModelCatalog()).then(function (result) {
          if (result !== null && result !== undefined && result.ok === true) {
            setCatalog({ phase: 'ready', groups: (result.value && Array.isArray(result.value.groups)) ? result.value.groups : [] });
          } else {
            setCatalog({ phase: 'error', error: (result && result.error) || '读取模型目录失败' });
          }
        }, function (error) { setCatalog({ phase: 'error', error: messageOf(error) }); });
      }, [loadModelCatalog]);

      React.useEffect(function () { void loadCatalog(); }, [loadCatalog]);

      // Moli 引擎检测：打开面板先自动跑一次；卡片上的「检测」按钮可以手动刷新。
      // advanced 是卡片里「高级设置」的折叠状态，检测刷新时保持不变。
      var moliHook = React.useState({ phase: 'checking', advanced: false });
      var moliState = moliHook[0];
      var setMoliState = moliHook[1];
      // 闸门区：默认锁定；填满 6 位码解锁；保存成功后重新锁上（离开页面随组件销毁，什么都不留）。
      // gateUnlocked=false 表示锁定（默认）；填满 6 位码才置 true；保存成功后复位 false。
      var gateLockHook = React.useState(false);
      var gateUnlocked = gateLockHook[0];
      var setGateUnlocked = gateLockHook[1];
      var probeMoli = props.probeMoli;
      var keepAdvanced = function (current) { return current !== null && current !== undefined && current.advanced === true; };
      var runMoliProbe = React.useCallback(function () {
        if (typeof probeMoli !== 'function') {
          setMoliState({ phase: 'error', error: '注入面没有检测能力（Host 侧插件版本过旧）', advanced: false });
          return undefined;
        }
        setMoliState(function (current) { return { phase: 'checking', advanced: keepAdvanced(current) }; });
        return Promise.resolve(probeMoli()).then(function (result) {
          if (result !== null && result !== undefined && result.ok === true) {
            var info = (result.value === null || result.value === undefined) ? { installed: false, engineState: '' } : result.value;
            setMoliState(function (current) { return { phase: 'ready', value: info, advanced: keepAdvanced(current) }; });
          } else {
            setMoliState(function (current) { return { phase: 'error', error: (result && result.error) || '检测失败', advanced: keepAdvanced(current) }; });
          }
        }, function (error) { setMoliState(function (current) { return { phase: 'error', error: messageOf(error), advanced: keepAdvanced(current) }; }); });
      }, [probeMoli]);

      React.useEffect(function () { void runMoliProbe(); }, [runMoliProbe]);

      var toggleMoliAdvanced = React.useCallback(function () {
        setMoliState(function (current) {
          var base = (current === null || current === undefined) ? { phase: 'idle' } : current;
          return Object.assign({}, base, { advanced: !(base.advanced === true) });
        });
      }, []);

      var updateField = React.useCallback(function (path, value) {
        setDraft(function (current) { return setPath(current === null ? {} : current, path, value); });
        setNotice('');
      }, []);

      // 引擎不可用时把 draft 上的开关强制写回 false：保存时才真正落盘，
      // 避免「界面上关着、配置里开着」的假象。填了引擎路径则视为用户自己负责。
      React.useEffect(function () {
        if (moliState.phase !== 'ready') return;
        var info = moliState.value || {};
        var customExe = String(getPath(draft, ['moli', 'exePath']) || '').trim() !== '';
        var usable = info.engineState === 'installed' || customExe === true
          || (info.installed === true && (info.engineState === undefined || info.engineState === ''));
        if (usable === true) return;
        if (draft !== null && getPath(draft, ['moli', 'enabled']) === true) updateField(['moli', 'enabled'], false);
      }, [moliState, draft, updateField]);

      var save = React.useCallback(function () {
        if (draft === null) return undefined;
        setSaving(true);
        setNotice('');
        // 秘密字段是只写的：读回来的值里没有它，所以只有用户真的敲了新值才提交，
        // 否则会把 access_token 清空。
        var secretPaths = {};
        var secretList = state.secrets || [];
        for (var si = 0; si < secretList.length; si += 1) {
          if (secretList[si] && Array.isArray(secretList[si].path)) secretPaths[secretList[si].path.join(".")] = true;
        }
        var ops = [];
        // moli 卡片「高级设置」那几项（exePath / proxy / defaultTimeoutMs / maxChars / insecureTls
        // / guardProxy / allowGuest / rateLimitPerMin / maxConcurrentRenders）
        // 不在 FIELDS 里，是卡片内部独立的字段集。以前保存只看 FIELDS，于是界面能改、
        // 保存却永远「没有改动」——改了个寂寞。这里把两套合并后再比对。
        var allFields = FIELDS.concat(MOLI_ADVANCED_FIELDS);
        for (var i = 0; i < allFields.length; i += 1) {
          var field = allFields[i];
          var before = getPath(state.value, field.path);
          var after = getPath(draft, field.path);
          if (secretPaths[field.path.join(".")] === true) {
            if (typeof after !== "string" || after === "") continue;
          }
          if (!sameValue(before, after)) {
            ops.push({ op: 'set', path: field.path, value: after === undefined ? null : after });
          }
        }
        if (ops.length === 0) {
          setSaving(false);
          setNotice('没有改动');
          return undefined;
        }
        // 闸门区：动态码开着时改名单、或动「流程授权」开关本身，都必须带一次 6 位码；
        // 带着码保存才算消费。关掉闸门比改名单更狠，不能更容易。
        var flowOn = getPath(draft, ['flowAuth', 'enabled']) === true;
        var gatedChanged = sameValue(getPath(state.value, ['flowAuth', 'gatedTools']), getPath(draft, ['flowAuth', 'gatedTools'])) === false;
        var enabledChanged = sameValue(getPath(state.value, ['flowAuth', 'enabled']), getPath(draft, ['flowAuth', 'enabled'])) === false;
        var gateCode = String(getPath(draft, ['flowAuth', 'gateEditCode']) || '').trim();
        if ((enabledChanged === true || (flowOn === true && gatedChanged === true)) && /^\d{6}$/.test(gateCode) !== true) {
          setSaving(false);
          setNotice(enabledChanged === true
            ? '改「流程授权」开关也要一次码：先在「高级 → 闸门区」的「改名单用的动态码」里填当前 6 位码再保存'
            : '闸门名单已锁定：先在「改名单用的动态码」里填一次 6 位码再保存（不保存不生效）');
          return undefined;
        }
        return Promise.resolve(saveConfig(ops, state.revision)).then(function (result) {
          if (result !== null && result !== undefined && result.ok === true) {
            // 码是一次性的：保存成功即重新上锁，并把输入框里的码清掉（服务端也会清）。
            setGateUnlocked(false);
            updateField(['flowAuth', 'gateEditCode'], '');
            setNotice('已保存');
            setSaving(false);
            return reload();
          }
          setSaving(false);
          setNotice('保存失败：' + ((result && result.error) || '未知错误'));
          return undefined;
        }, function (error) {
          setSaving(false);
          setNotice('保存失败：' + messageOf(error));
          return undefined;
        });
      }, [draft, state.value, state.revision, saveConfig, reload]);

      if (state.phase === 'loading') {
        return h('div', { style: S.wrap }, h('div', { style: S.hint }, '正在读取设置…'));
      }

      if (state.phase === 'error') {
        return h('div', { style: S.wrap },
          h('div', { style: S.error }, state.error),
          h('div', { style: S.hint }, '如果提示命名空间未注册，说明 Host 侧插件没加载成功。'),
          h('div', { style: S.actions }, h('button', { style: S.button, onClick: reload }, '重试')),
        );
      }

      var rows = [];
      for (var index = 0; index < FIELDS.length; index += 1) {
        var field = FIELDS[index];
        if (groupOf(field) !== tab) continue;                 // 只渲染当前标签的字段
        if (subs !== null) {
          var fieldSub = subGroupOf(field);
          // 有二级分组时再筛一层；未归类的字段在每个二级标签下都显示。
          if (fieldSub !== undefined && fieldSub !== subTab) continue;
        }
        if (typeof field.when === 'function' && field.when(draft) !== true) continue;
        var fieldKey = field.path.join('.');
        var isSecret = false;
        var totpSecretSet = false;
        for (var si2 = 0; si2 < (state.secrets || []).length; si2 += 1) {
          var entry = (state.secrets || [])[si2];
          if (!entry || !Array.isArray(entry.path)) continue;
          var secretKey = entry.path.join('.');
          if (secretKey === fieldKey) isSecret = true;
          if (secretKey === 'flowAuth.totpSecret') totpSecretSet = true;
        }
        // 闸门区：动态码开着、还没解锁时，名单只读（填码即解锁；保存成功后会重新锁上）。
        var gateLocked = gateUnlocked !== true && getPath(draft, ['flowAuth', 'enabled']) === true
          && fieldKey === 'flowAuth.gatedTools';
        rows.push(renderField(field, getPath(draft, field.path), updateField, isSecret, draft, catalog, totpSecretSet, moliState, runMoliProbe, toggleMoliAdvanced, {
          locked: gateLocked,
          onGateCode: function (value) {
            updateField(['flowAuth', 'gateEditCode'], value);
            if (/^\d{6}$/.test(String(value || ''))) setGateUnlocked(true);
          },
        }));
      }

      var currentGroup = null;
      for (var gi = 0; gi < GROUPS.length; gi += 1) {
        if (GROUPS[gi].id === tab) { currentGroup = GROUPS[gi]; break; }
      }

      // 二级标签（有二级分组的主标签才出现；常驻在主标签条下方，不随内容滚动）
      var currentSub = null;
      var subTabBar = null;
      if (subs !== null) {
        for (var si = 0; si < subs.length; si += 1) {
          if (subs[si].id === subTab) { currentSub = subs[si]; break; }
        }
        subTabBar = h('div', { style: S.subTabBar, role: 'tablist', 'aria-label': '二级分组' },
          subs.map(function (group) {
            var active = group.id === subTab;
            return h('button', {
              key: group.id,
              type: 'button',
              role: 'tab',
              'aria-selected': active ? 'true' : 'false',
              'data-subtab': group.id,
              style: active ? S.subTabActive : S.subTab,
              onClick: function () { setSubTab(group.id); },
            }, group.label);
          }));
      }

      // 说明文字跟着当前二级组走
      var activeHint = currentSub !== null
        ? currentSub.hint
        : (currentGroup === null ? '' : currentGroup.hint);

      var tabBar = GROUPS.map(function (group) {
        var active = group.id === tab;
        return h('button', {
          key: group.id,
          type: 'button',
          role: 'tab',
          'aria-selected': active ? 'true' : 'false',
          'data-tab': group.id,
          style: active ? S.tabActive : S.tab,
          onClick: function () { setTab(group.id); },
        }, group.label);
      });

      return h('div', { style: S.shell },
        // 顶端标签（仿 dsh-service 设置顶端的切换条）
        h('div', { style: S.tabBar, role: 'tablist' }, tabBar),
        // 当前主标签的二级标签条（常驻在主标签条下方，无二级分组时为 null）
        subTabBar,
        // 可滚动主体：只显示当前标签（+ 当前二级标签）下的字段
        h('div', { style: S.body },
          activeHint === '' ? null : h('div', { style: S.groupHint }, activeHint),
          rows.length === 0 ? h('div', { style: S.hint }, '这一组暂时没有可配置项。') : null,
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, rows),
        ),
        // 常驻底栏：保存 / 重新读取（切标签时始终可见）
        h('div', { style: S.footer },
          h('button', { style: S.button, onClick: save, disabled: saving }, saving ? '保存中…' : '保存'),
          h('button', { style: S.buttonGhost, onClick: reload, disabled: saving }, '重新读取'),
          notice === '' ? null : h('span', { style: S.notice }, notice),
          h('span', { style: S.hint },
            '连接方式（协议/模式/地址/token）改动会自动重启适配器，其它改动对下一条消息生效；',
            '状态可让 Agent 调 qqbot 工具（action=status）查看。'),
        ),
      );
    }

    // 列表字段（群号白名单等）必须用本地 draft 文本编辑：
    // 直接把 value 渲染成 array.join(', ') 会让 React 每次按键都复位输入框，
    // 用户刚敲的分隔符当场消失，多值根本填不进去。
    var LIST_SPLIT = /[,\uFF0C\u3001;\uFF1B\s]+/;
    function splitList(text) {
      var raw = String(text === undefined || text === null ? '' : text).split(LIST_SPLIT);
      var out = [];
      for (var i = 0; i < raw.length; i += 1) {
        var item = raw[i].trim();
        if (item !== '') out.push(item);
      }
      return out;
    }

    function ListInput(props) {
      var field = props.field;
      var updateField = props.updateField;
      var canonical = Array.isArray(props.value) ? props.value.join(', ') : '';
      var textHook = React.useState(canonical);
      var text = textHook[0];
      var setText = textHook[1];
      var committedHook = React.useRef(canonical);
      React.useEffect(function () {
        if (committedHook.current !== canonical) {
          committedHook.current = canonical;
          setText(canonical);
        }
      }, [canonical]);
      return h('input', {
        type: 'text',
        style: S.input,
        disabled: props.locked === true,
        value: text,
        placeholder: field.placeholder || '',
        onChange: function (event) {
          if (props.locked === true) return;
          var next = event.target.value;
          setText(next);
          var parts = splitList(next);
          committedHook.current = parts.join(', ');
          updateField(field.path, parts);
        },
        onBlur: function () {
          var normalized = splitList(text).join(', ');
          committedHook.current = normalized;
          setText(normalized);
        },
      });
    }

    // ============================================================ 绑定二维码（浏览器版）
    // 与 lib/qr.js 同一套算法（字节模式 / 纠错等级 M / 版本 1..9）；服务端那份有 test/test-qr.mjs 的
    // 固定向量守着。**浏览器这份没有逐位比对的自动化测试**（评审时用独立解码器人工比过矩阵哈希），
    // 改这里请顺手用手机扫一次二维码确认能绑上。
    /* QR_BUNDLE_START */
    var QR_EXP = new Uint8Array(512);
    var QR_LOG = new Uint8Array(256);
    (function () {
      var x = 1;
      for (var i = 0; i < 255; i += 1) {
        QR_EXP[i] = x;
        QR_LOG[x] = i;
        x <<= 1;
        if ((x & 0x100) !== 0) x ^= 0x11d;
      }
      for (var j = 255; j < 512; j += 1) QR_EXP[j] = QR_EXP[j - 255];
    })();

    function qrMul(a, b) {
      if (a === 0 || b === 0) return 0;
      return QR_EXP[QR_LOG[a] + QR_LOG[b]];
    }

    function qrGenPoly(degree) {
      var poly = [1];
      for (var i = 0; i < degree; i += 1) {
        var next = [];
        for (var k = 0; k < poly.length + 1; k += 1) next.push(0);
        for (var j = 0; j < poly.length; j += 1) {
          next[j] ^= poly[j];
          next[j + 1] ^= qrMul(poly[j], QR_EXP[i]);
        }
        poly = next;
      }
      return poly;
    }

    function qrRemainder(data, ecLength) {
      var gen = qrGenPoly(ecLength);
      var res = [];
      for (var i = 0; i < ecLength; i += 1) res.push(0);
      for (var d = 0; d < data.length; d += 1) {
        var factor = data[d] ^ res[0];
        res.shift();
        res.push(0);
        for (var j = 0; j < ecLength; j += 1) res[j] ^= qrMul(gen[j + 1], factor);
      }
      return res;
    }

    var QR_EC_M = {
      1: { ec: 10, blocks: [[1, 16]] },
      2: { ec: 16, blocks: [[1, 28]] },
      3: { ec: 26, blocks: [[1, 44]] },
      4: { ec: 18, blocks: [[2, 32]] },
      5: { ec: 24, blocks: [[2, 43]] },
      6: { ec: 16, blocks: [[4, 27]] },
      7: { ec: 18, blocks: [[4, 31]] },
      8: { ec: 22, blocks: [[2, 38], [2, 39]] },
      9: { ec: 22, blocks: [[3, 36], [2, 37]] },
    };
    var QR_ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46] };

    function qrCapacity(version) {
      var table = QR_EC_M[version];
      var total = 0;
      for (var i = 0; i < table.blocks.length; i += 1) total += table.blocks[i][0] * table.blocks[i][1];
      return total;
    }

    function qrBytes(text) {
      var out = [];
      var encoded = unescape(encodeURIComponent(String(text)));
      for (var i = 0; i < encoded.length; i += 1) out.push(encoded.charCodeAt(i) & 0xff);
      return out;
    }

    function qrChoose(text) {
      var bytes = qrBytes(text);
      for (var version = 1; version <= 9; version += 1) {
        if (4 + 8 + bytes.length * 8 <= qrCapacity(version) * 8) return { version: version, bytes: bytes };
      }
      return { version: 0, bytes: bytes };
    }

    function qrCodewords(bytes, version) {
      var capacityBits = qrCapacity(version) * 8;
      var bits = [];
      function push(value, length) {
        for (var i = length - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
      }
      push(4, 4);
      push(bytes.length, 8);
      for (var b = 0; b < bytes.length; b += 1) push(bytes[b], 8);
      for (var t = 0; t < 4 && bits.length < capacityBits; t += 1) bits.push(0);
      while (bits.length % 8 !== 0) bits.push(0);
      var words = [];
      for (var i = 0; i < bits.length; i += 8) {
        var byte = 0;
        for (var j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
        words.push(byte);
      }
      var pad = [0xec, 0x11];
      var padIndex = 0;
      while (words.length < capacityBits / 8) {
        words.push(pad[padIndex % 2]);
        padIndex += 1;
      }
      return words;
    }

    function qrInterleave(words, version) {
      var table = QR_EC_M[version];
      var blocks = [];
      var offset = 0;
      for (var i = 0; i < table.blocks.length; i += 1) {
        var count = table.blocks[i][0];
        var len = table.blocks[i][1];
        for (var c = 0; c < count; c += 1) {
          var data = words.slice(offset, offset + len);
          offset += len;
          blocks.push({ data: data, ec: qrRemainder(data, table.ec) });
        }
      }
      var out = [];
      var maxData = 0;
      for (var m = 0; m < blocks.length; m += 1) maxData = Math.max(maxData, blocks[m].data.length);
      for (var d = 0; d < maxData; d += 1) {
        for (var n = 0; n < blocks.length; n += 1) if (d < blocks[n].data.length) out.push(blocks[n].data[d]);
      }
      for (var e = 0; e < table.ec; e += 1) {
        for (var p = 0; p < blocks.length; p += 1) out.push(blocks[p].ec[e]);
      }
      return out;
    }

    function qrFormatBits(mask) {
      var data = mask;   // 纠错等级 M 的指示位是 00
      var value = data << 10;
      for (var i = 14; i >= 10; i -= 1) if (((value >> i) & 1) !== 0) value ^= 0x537 << (i - 10);
      return ((data << 10) | value) ^ 0x5412;
    }

    function qrVersionBits(version) {
      var value = version << 12;
      for (var i = 17; i >= 12; i -= 1) if (((value >> i) & 1) !== 0) value ^= 0x1f25 << (i - 12);
      return (version << 12) | value;
    }

    var QR_MASKS = [
      function (r, c) { return (r + c) % 2 === 0; },
      function (r) { return r % 2 === 0; },
      function (r, c) { return c % 3 === 0; },
      function (r, c) { return (r + c) % 3 === 0; },
      function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
      function (r, c) { return ((r * c) % 2) + ((r * c) % 3) === 0; },
      function (r, c) { return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; },
      function (r, c) { return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0; },
    ];

    function qrMatrix(version) {
      var size = 17 + 4 * version;
      var modules = [];
      var reserved = [];
      for (var r = 0; r < size; r += 1) {
        var row = [];
        var rrow = [];
        for (var c = 0; c < size; c += 1) { row.push(false); rrow.push(false); }
        modules.push(row);
        reserved.push(rrow);
      }
      function set(rr, cc, dark) {
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) return;
        modules[rr][cc] = dark === true;
        reserved[rr][cc] = true;
      }
      function finder(row0, col0) {
        for (var rr = -1; rr <= 7; rr += 1) {
          for (var cc = -1; cc <= 7; cc += 1) {
            var dark = (rr >= 0 && rr <= 6 && (cc === 0 || cc === 6))
              || (cc >= 0 && cc <= 6 && (rr === 0 || rr === 6))
              || (rr >= 2 && rr <= 4 && cc >= 2 && cc <= 4);
            set(row0 + rr, col0 + cc, dark);
          }
        }
      }
      finder(0, 0);
      finder(0, size - 7);
      finder(size - 7, 0);
      for (var i = 8; i < size - 8; i += 1) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
      var centers = QR_ALIGN[version];
      for (var a = 0; a < centers.length; a += 1) {
        for (var b = 0; b < centers.length; b += 1) {
          var row = centers[a];
          var col = centers[b];
          if ((row === 6 && col === 6) || (row === 6 && col === size - 7) || (row === size - 7 && col === 6)) continue;
          for (var dr = -2; dr <= 2; dr += 1) {
            for (var dc = -2; dc <= 2; dc += 1) {
              set(row + dr, col + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
            }
          }
        }
      }
      for (var f = 0; f <= 8; f += 1) {
        if (f !== 6) { set(8, f, false); set(f, 8, false); }
      }
      set(8, 8, false);
      for (var g = 0; g < 8; g += 1) set(8, size - 1 - g, false);
      for (var h = 0; h < 7; h += 1) set(size - 1 - h, 8, false);
      set(size - 8, 8, false);
      if (version >= 7) {
        for (var v = 0; v < 18; v += 1) {
          set(Math.floor(v / 3), size - 11 + (v % 3), false);
          set(size - 11 + (v % 3), Math.floor(v / 3), false);
        }
      }
      return { size: size, modules: modules, reserved: reserved };
    }

    function qrPlace(matrix, words) {
      var size = matrix.size;
      var modules = matrix.modules;
      var reserved = matrix.reserved;
      var bits = [];
      for (var i = 0; i < words.length; i += 1) for (var b = 7; b >= 0; b -= 1) bits.push((words[i] >> b) & 1);
      var bitIndex = 0;
      var upward = true;
      for (var right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (var step = 0; step < size; step += 1) {
          var row = upward ? size - 1 - step : step;
          for (var offset = 0; offset < 2; offset += 1) {
            var col = right - offset;
            if (reserved[row][col]) continue;
            modules[row][col] = bitIndex < bits.length ? bits[bitIndex] === 1 : false;
            bitIndex += 1;
          }
        }
        upward = !upward;
      }
    }

    function qrApplyMask(matrix, maskIndex) {
      var fn = QR_MASKS[maskIndex];
      for (var r = 0; r < matrix.size; r += 1) {
        for (var c = 0; c < matrix.size; c += 1) {
          if (matrix.reserved[r][c]) continue;
          if (fn(r, c)) matrix.modules[r][c] = !matrix.modules[r][c];
        }
      }
    }

    function qrPutFormat(matrix, maskIndex) {
      var size = matrix.size;
      var modules = matrix.modules;
      var value = qrFormatBits(maskIndex);
      function bit(i) { return ((value >> i) & 1) === 1; }
      for (var i = 0; i < 15; i += 1) {
        var dark = bit(i);
        if (i < 6) modules[i][8] = dark;
        else if (i < 8) modules[i + 1][8] = dark;
        else modules[size - 15 + i][8] = dark;
        if (i < 8) modules[8][size - 1 - i] = dark;
        else if (i === 8) modules[8][7] = dark;
        else modules[8][15 - i - 1] = dark;
      }
      modules[size - 8][8] = true;
    }

    function qrPutVersion(matrix, version) {
      if (version < 7) return;
      var size = matrix.size;
      var value = qrVersionBits(version);
      for (var i = 0; i < 18; i += 1) {
        var dark = ((value >> i) & 1) === 1;
        var row = Math.floor(i / 3);
        var col = size - 11 + (i % 3);
        matrix.modules[row][col] = dark;
        matrix.modules[col][row] = dark;
      }
    }

    function qrPenalty(matrix) {
      var size = matrix.size;
      var modules = matrix.modules;
      var score = 0;
      function runScore(line) {
        var total = 0;
        var run = 1;
        for (var i = 1; i < line.length; i += 1) {
          if (line[i] === line[i - 1]) run += 1;
          else { if (run >= 5) total += 3 + (run - 5); run = 1; }
        }
        if (run >= 5) total += 3 + (run - 5);
        return total;
      }
      for (var r = 0; r < size; r += 1) score += runScore(modules[r]);
      for (var c = 0; c < size; c += 1) {
        var col = [];
        for (var rr = 0; rr < size; rr += 1) col.push(modules[rr][c]);
        score += runScore(col);
      }
      for (var y = 0; y < size - 1; y += 1) {
        for (var x = 0; x < size - 1; x += 1) {
          var v = modules[y][x];
          if (v === modules[y][x + 1] && v === modules[y + 1][x] && v === modules[y + 1][x + 1]) score += 3;
        }
      }
      var patternA = [true, false, true, true, true, false, true, false, false, false, false];
      var patternB = [false, false, false, false, true, false, true, true, true, false, true];
      function matches(line, at, pattern) {
        for (var i = 0; i < pattern.length; i += 1) if (line[at + i] !== pattern[i]) return false;
        return true;
      }
      for (var row2 = 0; row2 < size; row2 += 1) {
        for (var cc2 = 0; cc2 + 11 <= size; cc2 += 1) {
          if (matches(modules[row2], cc2, patternA)) score += 40;
          if (matches(modules[row2], cc2, patternB)) score += 40;
        }
      }
      for (var cc3 = 0; cc3 < size; cc3 += 1) {
        var line = [];
        for (var rr2 = 0; rr2 < size; rr2 += 1) line.push(modules[rr2][cc3]);
        for (var at = 0; at + 11 <= size; at += 1) {
          if (matches(line, at, patternA)) score += 40;
          if (matches(line, at, patternB)) score += 40;
        }
      }
      var darkCount = 0;
      for (var d1 = 0; d1 < size; d1 += 1) for (var d2 = 0; d2 < size; d2 += 1) if (modules[d1][d2]) darkCount += 1;
      score += Math.floor(Math.abs((darkCount * 100) / (size * size) - 50) / 5) * 10;
      return score;
    }

    function encodeQr(text) {
      var picked = qrChoose(text);
      if (picked.version === 0) throw new Error('内容太长，无法生成二维码');
      var words = qrInterleave(qrCodewords(picked.bytes, picked.version), picked.version);
      var best = null;
      for (var mask = 0; mask < 8; mask += 1) {
        var matrix = qrMatrix(picked.version);
        qrPlace(matrix, words);
        qrApplyMask(matrix, mask);
        qrPutFormat(matrix, mask);
        qrPutVersion(matrix, picked.version);
        var score = qrPenalty(matrix);
        if (best === null || score < best.score) best = { score: score, mask: mask, matrix: matrix };
      }
      return { version: picked.version, size: best.matrix.size, mask: best.mask, modules: best.matrix.modules };
    }
    /* QR_BUNDLE_END */

    var QR_BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    function makeTotpSecret() {
      var bytes = new Uint8Array(20);
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
      else for (var i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
      var out = '';
      var buffer = 0;
      var bits = 0;
      for (var j = 0; j < bytes.length; j += 1) {
        buffer = (buffer << 8) | bytes[j];
        bits += 8;
        while (bits >= 5) {
          out += QR_BASE32[(buffer >> (bits - 5)) & 31];
          bits -= 5;
        }
      }
      if (bits > 0) out += QR_BASE32[(buffer << (5 - bits)) & 31];
      return out;
    }

    function otpauthOf(secret) {
      var issuer = 'dsh-qq-bot';
      var label = encodeURIComponent(issuer) + ':' + encodeURIComponent('owner');
      return 'otpauth://totp/' + label + '?secret=' + encodeURIComponent(secret)
        + '&algorithm=SHA1&digits=6&period=30&issuer=' + encodeURIComponent(issuer);
    }

    function qrSvg(uri) {
      var matrix = encodeQr(uri);
      var scale = 4;
      var quiet = 4;
      var dim = (matrix.size + quiet * 2) * scale;
      var parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="' + dim + '" height="' + dim + '" viewBox="0 0 ' + dim + ' ' + dim + '">'];
      parts.push('<rect width="' + dim + '" height="' + dim + '" fill="#fff"/>');
      for (var r = 0; r < matrix.size; r += 1) {
        for (var c = 0; c < matrix.size; c += 1) {
          if (!matrix.modules[r][c]) continue;
          parts.push('<rect x="' + ((c + quiet) * scale) + '" y="' + ((r + quiet) * scale) + '" width="' + scale + '" height="' + scale + '" fill="#000"/>');
        }
      }
      parts.push('</svg>');
      return parts.join('');
    }
    /** 绑定区：未确认时显示二维码与密钥（只在这一次会话里），确认后只显示绑定时间。 */
    function renderQrBind(field, value, updateField, isSecret, draft, totpSecretSet) {
      var secret = '';
      var raw = (draft !== null && draft !== undefined && draft.flowAuth) ? draft.flowAuth.totpSecret : '';
      if (typeof raw === 'string') secret = raw.trim().toUpperCase().replace(/[^A-Z2-7]/g, '');
      var boundAt = Number(value) || 0;
      var children = [h('div', { key: 'label', style: S.label }, field.label)];
      if (boundAt > 0) {
        children.push(h('div', { key: 'bound', style: S.hint }, '已绑定（' + new Date(boundAt).toLocaleString() + '）：二维码与密钥不再展示；解绑请在私聊发 /flow unbind <6位动态码>。'));
        return h('div', { key: field.path.join('.'), style: S.row }, children);
      }
      var hasPlain = /^[A-Z2-7]{16,64}$/.test(secret);
      // 远程读取时 role(secret) 的值会被脱敏成空串，所以「有没有配过」只能看 secrets 标记；
      // 注意本字段的 path 是 enrolledAt，密钥在 flowAuth.totpSecret 上，得单独查一次。
      var hasSecret = hasPlain === true || isSecret === true || totpSecretSet === true;
      if (hasPlain !== true) {
        if (hasSecret === true) {
          children.push(h('div', { key: 'hint', style: S.hint }, '密钥已经配置好了（远程读取会脱敏，这里看不到明文），但还没有确认绑定：用认证器确认能算出码之后，直接点「我已扫码绑定」；不要点「生成密钥」，那会覆盖正在生效的密钥。'));
        } else {
          children.push(h('div', { key: 'hint', style: S.hint }, '还没有可用密钥：点下面「生成密钥」，就地生成 base32 密钥并显示二维码；用认证器 App 扫码后再点「我已扫码绑定」。'));
        }
      } else {
        var uri = otpauthOf(secret);
        var svg = qrSvg(uri);
        children.push(h('img', { key: 'qr', src: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg), style: { width: '200px', height: '200px', background: '#fff', imageRendering: 'pixelated', border: '1px solid #ddd' }, alt: 'TOTP 绑定二维码' }));
        children.push(h('div', { key: 'uri', style: S.hint }, '密钥：' + secret + '（只在确认绑定前展示；确认后需要重新生成）'));
        children.push(h('div', { key: 'pending', style: S.hint }, '这份密钥已经生效但还没确认绑定（例如从终端 enroll 粘过来的）：扫码后点「我已扫码绑定」就好，别点「生成密钥」——那会覆盖它。'));
      }
      children.push(h('div', { key: 'actions', style: S.actions },
        h('button', { key: 'gen', style: S.button, onClick: function () { updateField(['flowAuth', 'totpSecret'], makeTotpSecret()); updateField(['flowAuth', 'enrolledAt'], 0); } }, hasSecret ? '换一个密钥（覆盖当前）' : '生成密钥'),
        h('button', { key: 'bind', style: S.button, disabled: hasSecret !== true, onClick: function () { if (hasSecret !== true) return; updateField(['flowAuth', 'enrolledAt'], Date.now()); } }, '我已扫码绑定')));
      children.push(h('div', { key: 'save-hint', style: S.hint }, '改完点页面底部「保存」；确认绑定会同时写入绑定时间，之后这里只显示已绑定状态。'));
      return h('div', { key: field.path.join('.'), style: S.row }, children);
    }
    /**
     * 「Moli 渲染抓取」卡片：现场检测 dsh-moli 插件是否已注册。
     * 没装（或装了没启用）时开关强制关闭且不可点，只有「已安装 · 运行中」才放行。
     */
    // 卡片「高级设置」里的字段：对齐 dsh-moli 1.1.20 的 Config
    // （defaultTimeoutMs / maxChars / insecureTls / proxy / exePath），qq_webfetch 调 moli 时用的就是这几项。
    var MOLI_ADVANCED_FIELDS = [
      { path: ['moli', 'exePath'], label: 'moli 可执行文件路径', kind: 'text', placeholder: '（留空 = 自动探测 ~/.local/bin/moli 与 PATH）', hint: '引擎装在非标准位置时填这里；保存后下次抓取就用' },
      { path: ['moli', 'proxy'], label: '渲染抓取代理', kind: 'text', placeholder: '（留空 = 透传联网搜索代理）', hint: 'http://host:port；与「联网搜索 HTTP 代理」各自独立' },
      { path: ['moli', 'defaultTimeoutMs'], label: '渲染超时（毫秒）', kind: 'number', hint: '对应 moli 的 -t，默认 30000' },
      { path: ['moli', 'maxChars'], label: '单次输出上限（字符）', kind: 'number', hint: '超出按头尾省略，默认 200000' },
      { path: ['moli', 'insecureTls'], label: '跳过 TLS 证书校验', kind: 'bool', hint: '默认开。关掉后走严格证书校验：自签名证书、公司网关或代理的 TLS 拦截、证书吊销列表（CRL）取不到，都会让渲染抓取直接失败（表现为 qq_webfetch 报渲染失败，普通抓取不受影响）。反过来开着时，中间人可以替换页面内容——只有确认网络里没有中间人拦截，才建议关' },
      { path: ['moli', 'guardProxy'], label: '内网防护（本地校验代理）', kind: 'bool', hint: '默认开。把 moli 的全部流量收进只监听 127.0.0.1 的校验代理，每个目标先过内网 IP 黑名单：回环、10/8、172.16/12、192.168/16、169.254/16（云元数据）、100.64/10，IPv6 的 fe80/fc00/ff00、内嵌 IPv4、6to4、Teredo 一律 403。重定向、子资源、页面 JS 发起的请求也在这层拦。关掉就只剩「入口域名校验一次」，页面绕过入口去摸内网时没有第二道闸；它只拦内网，不拦外网刷屏（那个看下一项）' },
      { path: ['moli', 'allowGuest'], label: '允许访客渲染', kind: 'bool', hint: '默认开。关掉后只有拥有者私聊能用无头浏览器渲染，群聊和别人的私聊退回普通抓取（引擎照常装着，只是不给访客用）。与上面的「内网防护」相互独立：防护管能不能摸内网，这一项管谁能用' },
      { path: ['moli', 'rateLimitPerMin'], label: '每分钟最多渲染几次（每个会话）', kind: 'number', hint: '默认 5，0 = 不限。一次渲染要起一个无头浏览器（几十 MB 内存），群里刷屏就是这个开销；普通抓取不受这条限制' },
      { path: ['moli', 'maxConcurrentRenders'], label: '同时最多渲染几个（全局）', kind: 'number', hint: '默认 2，0 = 不限。跨会话的总闸：多个群同时刷渲染时，超出的请求直接回「忙，稍后再试」而不是排队——一次渲染实测峰值约 47 MB 常驻内存，这台机器扛不住十几个同时开' },
    ];

    /**
     * 「Moli 渲染抓取」卡片：检测 Moli 引擎是否就绪（dsh-moli 只负责装引擎）。
     * 引擎没就绪时开关强制关闭且不可点；就绪后在卡片里展开「高级设置」，直通 moli 的参数。
     */
    function renderMoliCard(field, value, updateField, isSecret, draft, catalog, totpSecretSet, moliState, runMoliProbe, toggleMoliAdvanced) {
      var state = (moliState === null || moliState === undefined) ? { phase: 'idle', advanced: false } : moliState;
      var checking = state.phase === 'checking';
      var advanced = state.advanced === true;
      var info = (state.phase === 'ready' && state.value !== null && state.value !== undefined) ? state.value : null;
      var engineReady = info !== null && info.engineState === 'installed';
      var engineState = (info !== null && typeof info.engineState === 'string') ? info.engineState : '';
      var engineVersion = (info !== null && typeof info.engineVersion === 'string') ? info.engineVersion : '';
      var pluginInstalled = info !== null && info.installed === true;
      var customExe = String(getPath(draft, ['moli', 'exePath']) || '').trim() !== '';
      // 能用开关的三种情况：引擎装好了 / 用户自己指定了引擎路径 / dsh-moli 在但读不到引擎状态（交给 Host 现场探测）。
      var canToggle = engineReady || customExe || (pluginInstalled && engineState === '');
      var on = value === true && canToggle;
      var forcedOff = value === true && canToggle !== true;

      var badge = '检测中…';
      var badgeStyle = S.moliBadgeIdle;
      var badgeKey = state.phase;
      var detail = '正在检测 Moli 引擎…';
      var detailExtra = null;
      if (state.phase === 'error') {
        badge = '检测失败';
        badgeStyle = S.moliBadgeBad;
        detail = String(state.error || '检测失败') + '（开关保持关闭）';
      } else if (info !== null) {
        if (engineReady === true) {
          badge = '引擎就绪';
          badgeStyle = S.moliBadgeOk;
          badgeKey = 'ready';
          detail = '已就绪：开启后 qq_webfetch 用 Moli 引擎渲染（可抓 SPA/JS 页）。'
            + (engineVersion !== '' ? '当前引擎 ' + engineVersion + '。' : '')
            + 'dsh-moli 只用它装引擎，装好之后启不启用它都无所谓。';
        } else if (pluginInstalled === true && engineState !== '') {
          badge = '引擎缺失';
          badgeStyle = S.moliBadgeWarn;
          badgeKey = 'engine-missing';
          detail = 'dsh-moli 在，但引擎没装好（engineState: ' + engineState + '）：去 dsh-moli 的卡片点安装引擎，装完回来点「检测」。';
        } else if (pluginInstalled === true) {
          badge = 'dsh-moli 在 · 引擎状态未知';
          badgeStyle = S.moliBadgeWarn;
          badgeKey = 'unknown';
          detail = '检测到 dsh-moli，但读不到它的引擎状态：实际能不能用由 Host 现场探测（抓取失败会明确报错）。也可以在「高级设置」里直接填引擎路径。';
        } else {
          badge = '未装 dsh-moli';
          badgeStyle = S.moliBadgeBad;
          badgeKey = 'missing';
          detail = '没检测到 dsh-moli——它只是用来装 Moli 引擎的（装一次就行，之后可以不管它）。'
            + '装上并装好引擎后再点「检测」；引擎已经在别处的话，在「高级设置」里填路径即可。';
          detailExtra = h('a', {
            key: 'repo',
            href: MOLI_REPO_URL,
            target: '_blank',
            rel: 'noopener noreferrer',
            'data-moli-repo': '1',
            style: S.moliLink,
          }, '去 GitHub 看 dsh-moli →');
        }
      }

      // 折叠设置：卡片可用（启用状态）时才出现，展开后逐项渲染 moli 的参数。
      var advancedRows = advanced
        ? MOLI_ADVANCED_FIELDS.map(function (item) {
          return h('div', { key: 'adv-' + item.path.join('.'), style: S.moliAdvItem },
            renderField(item, getPath(draft, item.path), updateField, false, draft, catalog, totpSecretSet, moliState, runMoliProbe, toggleMoliAdvanced));
        })
        : null;

      return h('div', { key: field.path.join('.'), style: S.moliCard },
        h('div', { key: 'head', style: S.moliHead },
          h('div', { key: 'titles', style: S.moliTitles },
            h('div', { key: 'title', style: S.moliTitle }, field.label || 'Moli 渲染抓取'),
            h('div', { key: 'sub', style: S.moliSub }, 'dsh-moli 装引擎 · qq_webfetch 渲染抓取'),
          ),
          h('span', { key: 'badge', 'data-moli-badge': badgeKey, style: badgeStyle }, badge),
        ),
        h('div', { key: 'body', style: S.moliBody },
          h('label', { key: 'toggle', style: canToggle ? S.moliToggle : S.moliToggleDisabled },
            h('input', {
              type: 'checkbox',
              'data-moli-toggle': '1',
              checked: on,
              disabled: canToggle !== true,
              onChange: function (event) { if (canToggle !== true) return; updateField(field.path, event.target.checked); },
            }),
            h('span', null, '启用 Moli 渲染抓取'),
          ),
          h('button', {
            key: 'probe',
            type: 'button',
            'data-moli-probe': '1',
            style: checking ? S.buttonGhostDisabled : S.buttonGhost,
            disabled: checking,
            onClick: function () { if (checking !== true) void runMoliProbe(); },
          }, checking ? '检测中…' : '检测'),
          canToggle === true
            ? h('button', {
              key: 'adv',
              type: 'button',
              'data-moli-advanced': '1',
              style: S.buttonGhost,
              onClick: function () { if (typeof toggleMoliAdvanced === 'function') toggleMoliAdvanced(); },
            }, advanced ? '高级设置 ▾' : '高级设置 ▸')
            : null,
        ),
        h('div', { key: 'detail', style: S.moliDetail },
          detailExtra === null ? detail : [detail, h('span', { key: 'gap' }, ' '), detailExtra]),
        advancedRows === null ? null : h('div', { key: 'adv', style: S.moliAdv }, advancedRows),
        forcedOff === true
          ? h('div', { key: 'forced', style: S.moliForced }, '配置里这个开关是开的，但引擎当前不可用：保存后会强制写回关闭。')
          : null,
      );
    }

    // ---------------------------------------------------------- 官方 Bot 扫码绑定卡片
    // 与宿主路由（lib/bind-routes.js）配套：只读状态 + 刷新二维码；appSecret 永远不出宿主。
    var QQ_BIND_STATE = '/dsh-qq-bot/bind';
    var QQ_BIND_REFRESH = '/dsh-qq-bot/bind/refresh';
    function QqBindCard() {
      var stateHook = React.useState({ phase: 'loading' });
      var st = stateHook[0];
      var setSt = stateHook[1];
      var Qr = qrSvg;
      var load = React.useCallback(function () {
        return fetch(QQ_BIND_STATE, { credentials: 'same-origin' })
          .then(function (res) { return res.json(); })
          .then(function (data) { setSt(Object.assign({ phase: 'idle' }, data)); }, function (error) {
            setSt({ phase: 'failed', error: '读取绑定状态失败：' + messageOf(error) });
          });
      }, []);
      React.useEffect(function () { void load(); }, [load]);
      React.useEffect(function () {
        if (st.phase !== 'waiting') return undefined;
        var timer = setInterval(function () { void load(); }, 2000);
        return function () { clearInterval(timer); };
      }, [st.phase, load]);
      var startScan = React.useCallback(function () {
        setSt({ phase: 'waiting', url: '' });
        fetch(QQ_BIND_REFRESH, { method: 'POST', credentials: 'same-origin' })
          .then(function (res) { return res.json(); })
          .then(function (data) { setSt(Object.assign({ phase: 'idle' }, data)); }, function (error) {
            setSt({ phase: 'failed', error: '启动扫码失败：' + messageOf(error) });
          });
      }, []);
      var children = [];
      if (st.phase === 'loading') {
        children.push(h('div', { key: 'load', style: S.hint }, '正在读取绑定状态…'));
      } else if (st.phase === 'waiting' && st.url) {
        children.push(h('img', { key: 'qr', src: 'data:image/svg+xml;utf8,' + encodeURIComponent(Qr(st.url)), alt: 'QQ 扫码绑定', style: { width: '200px', height: '200px', background: '#fff', imageRendering: 'pixelated', border: '1px solid #ddd' } }));
        children.push(h('div', { key: 'hint', style: S.hint }, '手机 QQ 扫码 → 确认 → AppID/AppSecret 自动写入设置（密钥不出宿主，页面只回显 AppID）。'));
      } else if (st.phase === 'waiting') {
        children.push(h('div', { key: 'wait', style: S.hint }, '正在生成二维码…'));
      } else if (st.phase === 'saving') {
        children.push(h('div', { key: 'save', style: S.hint }, '扫码成功，正在保存凭据…'));
      } else if (st.phase === 'failed') {
        children.push(h('div', { key: 'err', style: S.hint }, String(st.error || '扫码不可用')));
      } else if (st.appId) {
        children.push(h('div', { key: 'bound', style: S.hint }, '已绑定 AppID：' + String(st.appId)));
      }
      children.push(h('button', { key: 'btn', style: S.button, onClick: startScan }, st.phase === 'waiting' ? '刷新二维码' : (st.appId ? '重新扫码绑定' : '扫码绑定')));
      return h('div', { key: 'qqbind', style: S.row }, children);
    }

    function renderField(field, value, updateField, isSecret, draft, catalog, totpSecretSet, moliState, runMoliProbe, toggleMoliAdvanced, flags) {
      var gateFlags = (flags !== null && typeof flags === 'object') ? flags : {};
      var locked = gateFlags.locked === true;
      var children = [];

      if (field.kind === 'qqbind') return h(QqBindCard, { key: field.path.join('.') });
      if (field.kind === 'qr') return renderQrBind(field, value, updateField, isSecret, draft, totpSecretSet);

      if (field.kind === 'moli') {
        return renderMoliCard(field, value, updateField, isSecret, draft, catalog, totpSecretSet, moliState, runMoliProbe, toggleMoliAdvanced);
      }

      if (field.kind === 'bool') {
        children.push(h('div', { key: 'row', style: S.checkboxRow },
          h('input', {
            type: 'checkbox',
            checked: value === true,
            onChange: function (event) { updateField(field.path, event.target.checked); },
          }),
          h('span', { style: S.label }, field.label),
        ));
        if (field.hint) children.push(h('div', { key: 'hint', style: S.hint }, field.hint));
        return h('div', { key: field.path.join('.'), style: S.row }, children);
      }

      children.push(h('div', { key: 'label', style: S.label }, field.label));

      if (field.kind === 'select' && field.dynamic === 'provider') {
        // 视觉 provider 下拉：留空 = 会话模型；否则从 DSH 会话模型目录里选。
        var pGroups = (catalog && catalog.phase === 'ready' && Array.isArray(catalog.groups)) ? catalog.groups : null;
        if (pGroups === null) {
          children.push(h('input', {
            key: 'input',
            type: 'text',
            style: S.input,
            placeholder: field.placeholder || '',
            value: value === undefined || value === null ? '' : String(value),
            onChange: function (event) { updateField(field.path, event.target.value); },
          }));
          if (catalog && catalog.phase === 'error' && catalog.error) {
            children.push(h('div', { key: 'warn', style: S.hint }, '模型目录不可用（' + catalog.error + '），已退回手动填写。'));
          }
        } else {
          var pOptions = [['', '（留空 = 会话模型）']].concat(pGroups.map(function (group) {
            var label = group.id === 'deepseek-account' ? '登录账号 API（' + (group.name || group.id) + '）' : (group.name || group.id);
            return [group.id, label];
          }));
          children.push(h('select', {
            key: 'input',
            style: S.select,
            value: value === undefined || value === null ? '' : String(value),
            onChange: function (event) { updateField(field.path, event.target.value); },
          }, pOptions.map(function (pair) {
            return h('option', { key: pair[0], value: pair[0], style: S.option }, pair[1]);
          })));
        }
      } else if (field.kind === 'select' && field.dynamic === 'model') {
        // model 下拉：跟随同一组里的 provider 字段（vision.* 或 proactive.* 都适用）；留空 = 会话模型。
        var providerPath = field.path.slice(0, field.path.length - 1).concat(['provider']);
        var chosenProvider = getPath(draft, providerPath) || '';
        var mGroups = (catalog && catalog.phase === 'ready' && Array.isArray(catalog.groups)) ? catalog.groups : null;
        var chosenGroup = null;
        if (mGroups !== null) {
          for (var gi = 0; gi < mGroups.length; gi += 1) {
            if (mGroups[gi].id === chosenProvider) { chosenGroup = mGroups[gi]; break; }
          }
        }
        if (chosenProvider === '') {
          // provider 留空 = 用会话模型：model 下拉禁用，不可点击/不可编辑。
          children.push(h('select', {
            key: 'input',
            style: S.selectDisabled,
            disabled: true,
            value: '',
          }, h('option', { key: '', value: '', style: S.option }, '（留空 = 会话模型）')));
          children.push(h('div', { key: 'warn', style: S.hint }, '留空 = 跟随会话模型；想指定模型，先在上面的 provider 里选一个。'));
        } else if (chosenGroup === null) {
          // provider 不在目录里或目录不可用：回退手动填。
          children.push(h('input', {
            key: 'input',
            type: 'text',
            style: S.input,
            placeholder: field.placeholder || '',
            value: value === undefined || value === null ? '' : String(value),
            onChange: function (event) { updateField(field.path, event.target.value); },
          }));
          if (mGroups === null && catalog && catalog.phase === 'error' && catalog.error) {
            children.push(h('div', { key: 'warn', style: S.hint }, '模型目录不可用（' + catalog.error + '），已退回手动填写。'));
          } else {
            children.push(h('div', { key: 'warn', style: S.hint }, 'provider "' + chosenProvider + '" 不在模型目录里，可手动填模型 id。'));
          }
        } else {
          var mOptions = [['', '（留空 = 会话模型）']].concat((Array.isArray(chosenGroup.models) ? chosenGroup.models : []).map(function (model) {
            return [model.id, model.name || model.id];
          }));
          children.push(h('select', {
            key: 'input',
            style: S.select,
            value: value === undefined || value === null ? '' : String(value),
            onChange: function (event) { updateField(field.path, event.target.value); },
          }, mOptions.map(function (pair) {
            return h('option', { key: pair[0], value: pair[0], style: S.option }, pair[1]);
          })));
        }
      } else if (field.kind === 'select') {
        // 连接方式等普通下拉：同样用主题变量样式，默认主题与 maid-atelier 都清晰。
        var options = field.options.map(function (pair) {
          return h('option', { key: pair[0], value: pair[0], style: S.option }, pair[1]);
        });
        children.push(h('select', {
          key: 'input',
          style: S.select,
          value: value === undefined || value === null ? '' : String(value),
          onChange: function (event) { updateField(field.path, event.target.value); },
        }, options));
      } else if (field.kind === 'list') {
        children.push(h(ListInput, { key: 'input', field: field, value: value, updateField: updateField, locked: locked }));
        if (locked === true) children.push(h('div', { key: 'locked', style: S.hint }, '🔒 已锁定：先在「改名单用的动态码」里填一次 6 位码再改（保存才算消费）'));
      } else if (field.kind === 'multiline') {
        children.push(h('textarea', {
          key: 'input',
          style: S.input,
          rows: 6,
          value: (value === undefined || value === null) ? '' : String(value),
          onChange: function (event) { updateField(field.path, event.target.value); },
        }));
      } else if (field.kind === 'number') {
        children.push(h('input', {
          key: 'input',
          type: 'number',
          style: S.input,
          value: value === undefined || value === null ? '' : String(value),
          onChange: function (event) {
            var parsed = Number(event.target.value);
            updateField(field.path, Number.isFinite(parsed) ? parsed : 0);
          },
        }));
      } else {
        var isGateCode = field.path[0] === 'flowAuth' && field.path[1] === 'gateEditCode';
        children.push(h('input', {
          key: 'input',
          type: field.kind === 'password' ? 'password' : 'text',
          style: S.input,
          disabled: locked === true,
          placeholder: field.placeholder || '',
          value: value === undefined || value === null ? '' : String(value),
          onChange: function (event) {
            if (isGateCode === true && typeof gateFlags.onGateCode === 'function') gateFlags.onGateCode(event.target.value);
            else updateField(field.path, event.target.value);
          },
        }));
      }

      if (isSecret === true) children.push(h('div', { key: 'secret', style: S.hint }, '已设置；留空则保持不变，只有输入新值才会覆盖。'));
      if (field.hint) children.push(h('div', { key: 'hint', style: S.hint }, field.hint));
      return h('div', { key: field.path.join('.'), style: S.row }, children);
    }

    // -------------------------------------------------------------- 插件定义

    var name = PREFIX;
    // dsh-client-ui-settings 明确要求每个使用方自己声明 remote.settings，
    // 否则拿不到设置 Remote。slots 是宿主一定提供的插槽服务。
    // remote.session 用来拉 DSH 会话界面的模型目录（官方 API + 登录账号 + 自定义 providers），
    // 让视觉 provider/model 可以下拉选择而不是手打。
    var inject = ['slots', 'remote', 'remote.settings', 'remote.session'];

    /** 惰性解析设置 Remote：兼容 ctx.get / ctx["remote.settings"] / ctx.remote.settings 三种形态。 */
    function settingsApi(ctx) {
      try {
        if (typeof ctx.get === 'function') {
          var direct = ctx.get('remote.settings');
          if (direct !== undefined && direct !== null) return direct;
        }
      } catch (error) { /* 继续尝试其它形态 */ }
      try {
        if (ctx['remote.settings'] !== undefined && ctx['remote.settings'] !== null) return ctx['remote.settings'];
      } catch (error) { /* 继续 */ }
      try {
        if (ctx.remote !== undefined && ctx.remote !== null && ctx.remote.settings !== undefined) return ctx.remote.settings;
      } catch (error) { /* 继续 */ }
      return null;
    }

    /** 惰性解析会话 Remote（模型目录）：兼容 ctx.get / ctx["remote.session"] / ctx.remote.session 三种形态。 */
    function sessionApi(ctx) {
      try {
        if (typeof ctx.get === 'function') {
          var direct = ctx.get('remote.session');
          if (direct !== undefined && direct !== null) return direct;
        }
      } catch (error) { /* 继续尝试其它形态 */ }
      try {
        if (ctx['remote.session'] !== undefined && ctx['remote.session'] !== null) return ctx['remote.session'];
      } catch (error) { /* 继续 */ }
      try {
        if (ctx.remote !== undefined && ctx.remote !== null && ctx.remote.session !== undefined) return ctx.remote.session;
      } catch (error) { /* 继续 */ }
      return null;
    }

    /**
     * 惰性解析插件清单 Remote（remote.pluginManager）：只用来判断 dsh-moli 装没装。
     * 刻意不写进 inject——老版本 DSH 没这个服务时，声明 inject 会让整个插件加载失败；
     * 而 cordis 的 ctx.get 本来就是弱访问，拿不到只返回 undefined。
     */
    function pluginManagerApi(ctx) {
      try {
        if (typeof ctx.get === 'function') {
          var direct = ctx.get('remote.pluginManager');
          if (direct !== undefined && direct !== null) return direct;
        }
      } catch (error) { /* 继续尝试其它形态 */ }
      try {
        if (ctx['remote.pluginManager'] !== undefined && ctx['remote.pluginManager'] !== null) return ctx['remote.pluginManager'];
      } catch (error) { /* 继续 */ }
      try {
        if (ctx.remote !== undefined && ctx.remote !== null && ctx.remote.pluginManager !== undefined) return ctx.remote.pluginManager;
      } catch (error) { /* 继续 */ }
      return null;
    }

    function apply(ctx) {
      // 实际生效的命名空间：loadConfig 解析出来后写回这里，保存时按它下发。
      var activeNs = NS;

      var faces = {
        loadConfig: function () {
          var settings = settingsApi(ctx);
          if (settings === null) return Promise.resolve({ ok: false, error: '拿不到设置服务（remote.settings）' });
          return Promise.resolve(settings.describe()).then(function (response) {
            var view = unwrap(response);
            if (view === undefined) return { ok: false, error: errorOf(response) };
            var namespaces = (view && Array.isArray(view.namespaces)) ? view.namespaces : [];
            var row = null;
            for (var i = 0; i < namespaces.length; i += 1) {
              if (namespaces[i] && namespaces[i].ns === NS) { row = namespaces[i]; break; }
            }
            if (row === null) {
              var matches = [];
              for (var j = 0; j < namespaces.length; j += 1) {
                var candidate = namespaces[j];
                if (candidate && typeof candidate.ns === 'string' && NS_FALLBACK.test(candidate.ns)) matches.push(candidate);
              }
              if (matches.length === 1) row = matches[0];
            }
            if (row === null) {
              return {
                ok: false,
                error: '设置里找不到条目 "' + NS + '"（Host 侧插件可能没加载，'
                  + '或插件的 Config schema 缺少 .volatile() 字段）',
              };
            }
            activeNs = row.ns;
            return { ok: true, value: row.value, revision: row.revision, secrets: Array.isArray(row.secrets) ? row.secrets : [] };
          }, function (error) { return { ok: false, error: messageOf(error) }; });
        },
        saveConfig: function (ops, revision) {
          var settings = settingsApi(ctx);
          if (settings === null) return Promise.resolve({ ok: false, error: '拿不到设置服务（remote.settings）' });
          return Promise.resolve(settings.mutate(activeNs, ops, revision)).then(function (response) {
            var view = unwrap(response);
            if (view === undefined && response !== null && response !== undefined
              && Object.prototype.hasOwnProperty.call(response, 'ok') && response.ok === false) {
              return { ok: false, error: errorOf(response) };
            }
            return { ok: true, value: view };
          }, function (error) { return { ok: false, error: messageOf(error) }; });
        },
        loadModelCatalog: function () {
          var session = sessionApi(ctx);
          if (session === null) return Promise.resolve({ ok: false, error: '拿不到会话 Remote（remote.session），无法列出模型目录' });
          return Promise.resolve(session.modelCatalog()).then(function (response) {
            var view = unwrap(response);
            if (view === undefined) return { ok: false, error: errorOf(response) };
            return { ok: true, value: view };
          }, function (error) { return { ok: false, error: messageOf(error) }; });
        },
        // 检测 dsh-moli 插件是否已注册（不依赖上面的 inject 面：走 remote.pluginManager 的插件清单）。
        // 检测 Moli 引擎是否就绪：dsh-moli 的插件清单（装没装）＋ 它自己的设置命名空间里的
        // engineState/engineVersion（引擎装没装）。dsh-moli 只在装引擎时用得到，运行期不依赖它。
        probeMoli: function () {
          var manager = pluginManagerApi(ctx);
          var settings = settingsApi(ctx);

          var pluginPromise = (manager === null)
            ? Promise.resolve({ installed: false, enabled: false, known: false })
            : Promise.resolve(manager.listPlugins()).then(function (response) {
              if (response === null || response === undefined || response.ok !== true) {
                return { installed: false, enabled: false, known: false };
              }
              var list = Array.isArray(response.value) ? response.value : [];
              for (var i = 0; i < list.length; i += 1) {
                var row = list[i];
                if (row === null || row === undefined) continue;
                if (row.entryId === 'dsh-moli' || row.moduleName === 'dsh-moli') {
                  return {
                    installed: true,
                    enabled: row.enabled === true,
                    known: true,
                    fiberPhase: row.fiberPhase === undefined ? null : row.fiberPhase,
                  };
                }
              }
              return { installed: false, enabled: false, known: true };
            }, function () { return { installed: false, enabled: false, known: false }; });

          // dsh-moli 把引擎状态写在自己的命名空间里（engineState / engineVersion），
          // 设置 describle 能看到所有命名空间，直接读它就不用再猜。
          var enginePromise = (settings === null)
            ? Promise.resolve(null)
            : Promise.resolve(settings.describe()).then(function (response) {
              var view = unwrap(response);
              if (view === undefined || view === null || !Array.isArray(view.namespaces)) return null;
              for (var i = 0; i < view.namespaces.length; i += 1) {
                var ns = view.namespaces[i];
                if (ns !== null && ns !== undefined && ns.ns === 'dsh-moli') {
                  return (ns.value === null || ns.value === undefined) ? {} : ns.value;
                }
              }
              return null;
            }, function () { return null; });

          return Promise.all([pluginPromise, enginePromise]).then(function (both) {
            var plugin = both[0] || { installed: false, enabled: false, known: false };
            var engine = both[1];
            return {
              ok: true,
              value: {
                installed: plugin.installed === true,
                enabled: plugin.enabled === true,
                // 只回卡片真正会读的几个字段。以前还额外返回 pluginKnown / engineConfiguredPath，
                // 前端一处都没读，等于把「检测到什么」的信息藏在没人看的地方。
                engineState: (engine !== null && typeof engine.engineState === 'string') ? engine.engineState : '',
                engineVersion: (engine !== null && typeof engine.engineVersion === 'string') ? engine.engineVersion : '',
              },
            };
          }, function (error) { return { ok: false, error: messageOf(error) }; });
        },
      };

      // 注册到「插件」页的 bundle 配置面板（与 dsh-soul-md 一致）：
      // 打开插件管理里本插件的详情页时，配置区就是这整套表单。
      // 旧 settings.section 入口不再保留（设置页顶层不再单开「QQ 机器人」选项卡）。
      ctx.slots.inject('plugins.bundle.config', function () {
        return ctx.slots.register({
          name: 'plugins.bundle.config',
          key: PKG_NAME,
          inject: function () { return faces; },
        }, QQBotSection);
      });
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
