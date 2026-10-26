## 0.12.2 —— 修好「网页端加载失败」与「设置面板空白」

0.12.1 把包名改成 `@sputnikzaychik/dsh-qq-bot` 之后，插件里有两处身份还写死着旧名字，
装上就会表现为网页端不可用：

- 打开网页直接报 `Failed to load plugins … could not load "@sputnikzaychik/dsh-qq-bot"`；
- 即使能打开，插件详情页的配置区也是空白，设置项一个都看不到。

原因是 DSH 有两套身份：**客户端模块行**和**配置区插槽**都按 npm 包名派发，
而**设置命名空间**按 profile 条目 id 派发。插件把前两者也写成了条目 id，改名后就对不上。

### 修复

- `lib/client.js`：`__ModuleLoader__.load({ id })` 改用包名（原来写死 `'dsh-qq-bot'`）。
- `lib/client.js`：`plugins.bundle.config` 插槽的 key 改用包名（插件管理页按 `pkg.name` 渲染配置区）。
- 设置命名空间 `NS` 保持 `'dsh-qq-bot'` 不变——**升级不需要重填配置**，白名单、密钥、绑定都在。
- `lib/index.js`：清理已废弃配置字段时，同时认新包名与条目 id（`SELF_IDS` 精确匹配；
  刻意不用后缀正则，避免误伤 `my-qq-bot` 这类别的插件）。
- 测试：`test-client.mjs` 的包名原先写死成 `dsh-qq-bot`，改名后那条断言假通过；
  现在从 `package.json` 读，改名就会立刻失败。

### 兼容

装过 0.12.0 / 0.12.1 的，直接升到 0.12.2 即可；功能内容与 0.12.1 相同，这一版只修客户端加载。

## 0.12.1 —— 与 0.12.0 同一批内容，外加发布链路与文档的补齐

0.12.0 在清理 registry 残留时被 unpublish 过，npm 的政策是「用过的版本号永不复用」，
所以 0.12.x 的首个发布版本是 0.12.1。**功能内容与下面 0.12.0 两节完全一致，代码没有改动**；
这一版单独记的是发布链路和文档——它们属于这一批改动的一部分，不能只留在 PR 里。

### 发布链路

- **`release.yml` 补 `actions/setup-node`（node 24）**：runner 镜像自带的 npm 10.9.9 不认 OIDC，
  `npm publish --provenance` 在发起 OIDC 交换之前就报 `ENEEDAUTH`——这跟 `id-token: write` 无关，
  Trusted Publishing 要求 npm ≥ 11.5.1。补上之后本版首次以 OIDC 身份发布成功（npm 上发布者显示为
  GitHub Actions，provenance 进了 sigstore transparency log）。
- **新版本会先有元数据、后有 tarball**：publish 返回成功后 registry 上立刻能查到版本号，但 tarball
  仍 404 约 4 分钟（`npm notice Your package is being processed`），期间 `npm pack` / `npm install` 会 404。
  不是失败，等即可——别据此重发一个版本号。

### 文档

- README：当前版本 0.11.x → 0.12.x；两处「一键全量（27 套件）」→ 28；CHANGELOG 范围 → 0.12.1。
- ARCHITECTURE：标题版本、`tools.js` 8 → 9 个工具（补 `qqauth`）、套件数 27 → 28；新增 §3.6
  「编排工具闸门与产物投递」数据流（同名接管 → 私聊动态码落成 grant → 一次消费 → 按会话目录打包回传）；
  设计取舍补 5 行（同名接管 / 一次性授权 + 30 秒窗口 / 回合身份快照 / 产物按会话目录 / 中间发言顺序）。
- AI-DISCLOSURE：已验证工具补 `qqauth`（9 个）；配置合并项数 23 → 24。
- 去掉 README 与 AI-DISCLOSURE 的「1018 项」总项数：它与逐套件列表之和（1013）对不上，且随可选 peer
  是否存在而变化；改为只报套件数，逐项数留在各自那一行（那部分本机可核）。
- `ci.yml` 注释：26 个套件 → 28，补 `flow-wiring` / `interim`。

## 0.12.0 —— 私聊动态码授权（流程授权）与产物投递

一句话：可选的一把锁。打开后，子代理 / 队友 / 工作流这类「能自己干活」的工具，先要主人在私聊里回一条 6 位动态码，
才放行**一次**调用；这一轮跑完，把会话目录里新增的文件打包送回。默认关，关着的时候行为与 0.11 完全一样。

### 新增（全部可选）

- `flowAuth.enabled`（默认 **false**）：总开关。关着时既不接管编排工具，也不拦截 `/auth`、`/flow` 消息。
- `flowAuth.totpSecret`：标准 TOTP（RFC 6238，HMAC-SHA1 / 30 秒 / 6 位）。密钥在设置页「高级 → 流程授权 → 绑定二维码」就地生成、只展示一次，用任意认证器 App 扫码绑定；**密钥不经 QQ**，也不写日志。也可以跑 `node lib/totp-cli.mjs enroll` 在终端生成后粘贴。
- 新增第 9 个工具 `qqauth`（只在拥有者私聊可用）：`request` 申请一次授权、`status` 看开关与待授权状态。
- `/auth <6位动态码>`：只认拥有者私聊、消息首位；命中即拦截，动态码不进 Agent 回合、不落会话历史。通过后撤回自己那条请求，并把被拦下的那一轮续跑。
- `/flow` 指令族：`ls` / `use` / `off` / `rm` / `auth` / `reset` / `unbind`（流程脚本只是「下次跑什么」的任务书，插件不执行它）。
- 恢复码：终端 `node lib/totp-cli.mjs recovery` 生成 8 条一次性码（scrypt 哈希存配置，明文不进 QQ），手机丢了也能解绑。用掉后插件会把对应那条哈希从配置里删掉。
- 产物投递 `flow.*`：授权跑完这一轮，把「本会话目录里本轮新增/改动」的文件打包送回（默认私聊，`group:<群号>` 丢群，`none` 只回文字）。上限 `maxBytes` / `maxFiles`，隐藏文件默认跳过，符号链接一律不跟。
- 设置页「高级」下新增「流程授权」二级标签：开关、TOTP 密钥、绑定二维码、有效期、锁定策略、要授权的工具名、恢复码哈希与盐。

### 安全边界

- **一次一用**：一条授权只放行一次调用，默认 30 秒内有效；同一 30 秒窗口的动态码不能重放；连续错 5 次锁 15 分钟。
- **没有万能码、没有测试后门**：密钥缺失、短于 10 字节、格式不对、码不匹配，一律拒绝。
- **身份按回合快照**：闸门与工具层读的都是「这一回合开始时固化的发言人」，排队期间别人插话不会把访客的调用判成拥有者的。
- **产物按会话归属**：开关打开后，新会话独占 `QQ_msg/<会话id>` 当工作目录——共用工作区根时「谁写的新文件」是分不出来的，共用就必然串会话。

### 修复（本批合入前发现的问题）

- **一次调用原来要吃两个动态码**：守卫层与同名遮蔽层都会去问闸门，而一条授权只够一次消费，结果开关一打开、四个编排工具 100% 报「还没有授权」。现在守卫放行时记一笔账，遮蔽层直接认账，不再二次消费；调用失败也不再留下「本轮有产物」的标记。
- **关掉开关却仍在改工具面**：接管逻辑原先不看 `flowAuth.enabled`，群里/共享会话的拥有者会被摘掉编排工具。现在只在开关打开时接管，关着时与 0.11 完全一致。
- **产物恒为空**：原来只扫 `QQ_msg/<会话id>`，而这个目录只在没有 workspace 服务时才会被创建；正常部署里模型写在共用根下，扫不到。现在开关打开时给会话分配独立目录，扫得到、也不串会话。
- `tools.js` 里 qqgroup / qqauth / qq_draw 三处仍读会被后到消息覆盖的 `entry.speaker`，现在统一读回合快照。
- `/auth` 续跑没带发言人快照，共享会话里中间插一个访客回合会让续跑按访客身份跑；已补上。
- 动态码拦截能被前置零宽字符绕过（`\u200b/auth 123456` 会漏进模型），现在先剥不可见字符再判。
- 待授权申请没有过期时间（几小时前的申请仍能被一条新码兑现），现在按 TTL 清理；失败文案补上 `weak-secret` 的中文说明。
- 顺带修了测试：`dsh-tools` 在本地永远解析不到，导致工具注册断言长期被跳过（工具数从 7 漂到 9 也没人发现）；现在会尝试 DSH 安装目录，工具数断言按真机 9 个写，并新加 `test/test-flow-wiring.mjs` 守住「一次调用一个码」「关着不动工具面」「失败不留产物标记」。

### 新增（同批合入）

- **中间发言**（`reply.interim`，默认开）：回合没跑完时，模型先说的那几句（「我先查一下」「让我看看这条链接」）会**单独发一条，不引用也不 @ 任何人**；最终结论仍走正常回复（该引用就引用、该分片就分片）。判据是「这段文字后面还有消息」——最后一条 assistant 消息永远留给最终结算，所以不会出现「先念一遍结论、再正式回一遍」。一个回合最多 4 条、两条之间至少 2.5 秒（`interimMaxPerTurn` / `interimMinGapMs`，设置页可调，填 0 关闭）。锚点丢失时宁可不说，也不把上一轮的话重播一遍。

### 第二轮复审查出的问题（同批修复）

- **开关热切换半状态**：接管原先只在建会话时判一次开关，`开→关` 后群会话的工具仍被摘掉、私聊仍是带闸门的 wrapper，`关→开` 后老会话又不遮蔽。现在包装器每次执行时现读配置：关着直接交给原生工具（与 0.11 完全一致），打开且不在拥有者私聊就拒绝。
- **零宽字符绕过**：原先只剥 4 个码点，软连字符、蒙古文元音分隔符、韩文填充符、变体选择符都能把 `/auth` 顶到行首之外整条送进模型；而且判定剥了、解析仍用原文，拦下来又静默蒸发。现在剥离收进 `parseAuthCommand` / `parseFlowCommand` 本身，字符集扩到不可见字符全集。
- **手写的流程脚本根本读不到**：文档让人把 `<名字>.js` 放进 `flows/`，但存储只认 `.json` 元数据，`/flow ls` 永远为空。现在 `.js` 就是本体，元数据可有可无（标题取首行注释；钉住的 sha 仍然会校验）。
- **反向 WS 重连后哑掉**：反向链路只加不摘，NapCat 重连后所有发送都打到已销毁的 socket（每条卡满 15 秒超时），`connected` 却还显示 true。现在断链即摘除并置 `ready=false`，`send()` 也返回真实写入结果。
- **参考图可穿越读任意文件**：`qq_draw` 的本地参考图校验是纯字符串前缀，`<QQ_msg>/qq-images/../../../../etc/hostname` 能通过，内容会被 base64 塞进外部生图请求。现在归一化后按目录边界判断。
- **访客能当任意发言机**：`qqbot` 默认在访客白名单里，工具本身又不鉴权，群成员一句提示注入就能让 bot 给任意 QQ/群发消息、`interrupt all` 掐掉主人正在跑的回合。现在 `qqbot` 只给拥有者，默认白名单里已移除。
- **排队顺序不保证**：`getEntry` 与「查群成员」都是 await，谁先完成谁先入队，连发两条会反着执行。现在同会话在消息到达时同步占位，处理顺序与到达顺序一致。
- **字符串 message_id 被 `Number()` 变成 NaN**：qq-official 的 `ROBOT1.0_…` 因此发不出引用回复（退化成有频控的主动消息），「回复 bot 视同 @」也失效。现在纯数字转数字、其余原样保留。
- **直连抓取没有超时**：`qq_webfetch` / `qq_websearch` 的直连分支超时没盖住读 body（`webSearchPost` 甚至完全没超时），端点慢速灌体会把整条会话队列堵死。现在统一用 `AbortSignal.timeout`。
- **设置页仍会覆盖线上密钥**：密钥是 `role(secret)`，远程读会被脱敏成空串，页面据此判「还没有可用密钥」并给出「生成密钥」按钮——点一下保存就覆盖正在生效的密钥，所有认证器立刻全废。现在改用 `secrets[]` 里的标记判断「配过没有」，提示改成「已经配置好了，别点生成」。
- **授权能被群里那次尝试白吃掉**：私聊发的码，同一个主人在群里触发一次编排工具就会被消费掉（随后私聊续跑反而 no-grant）。现在闸门只在拥有者私聊里消费。
- **恢复码不看待授权申请的时效**：十分钟前的申请早就过期了，用恢复码照样兑现，而且可以连兑两次。现在与动态码走同一条时效检查。
- **多拥有者死锁**：授权提示固定发给 `owners[0]`，闸门却只认发起人的 qq，第二位拥有者永远等不到码。现在提示发给「发起申请的那位」。
- **`/flow rm` 可能假成功**：脚本位置变成目录时 `remove` 照样回 `ok`，主人以为删了其实还在；`save` 的两次 rename 断在中间会留下「元数据是新 sha、脚本是旧的」，那条流程从此永远 sha-mismatch。现在删除会复核、保存失败就回落到「没有元数据」。
- **产物被截断不说**：`maxFiles` 按文件名序取前 N 个，QQ 只说「3 个文件」。现在回执里写明「超出上限，只打包了 3/5 个」。
- 其它：消息入口补 `.catch`（否则一次抛出就是 unhandled rejection，Node 24 直接退进程）、`qq_history` 与提示词里的身份改读回合快照（否则访客能借主人身份读跨群历史）、设置页绑定区在「密钥已配未确认」时不再误报没有密钥。

### 兼容

- 默认全关：不装认证器、不打开开关的话，配置、日志、工具面、`/auth` 行为都与 0.11 一致；新增字段都有默认值，不需要迁移。
- 关闭状态下 `staleConfigPaths` 不会动这些字段；打开再关掉也不会残留待授权请求（`/flow reset` 同理）。


## 0.12.0（同批）—— 两段式发言、发送前兜底、废弃配置清理与几处稳健性修复

一句话：可选的两段式。判断阶段只要稳出 JSON（可以挑便宜快的模型），正文交给另一个模型写（可以挑文风更合适的），
不填就跟以前完全一样。

### 新增（全部可选）

- 判断阶段沿用现有 `proactive.provider` / `proactive.model`，**不新增 judge 字段**——它们只会是别名，同一个模型两个入口反而增加心智负担。
- 新增 `proactive.requireCjk`（默认关）：发送前兜底，**单段与两段模式都生效**——正文没有 CJK 字符且长度超过 12 时判不可用（原因 `no-cjk`，verbose 可见）。它不是「拒绝语识别」，判据是结构性的「中文群里整句英文」；中文群建议开，英文群务必关。长度阈值 12 是代码常量 `CJK_MIN_LENGTH`（按码点计，emoji 与生僻字不会被算成两个字）（正常 ASCII 短回应 ≤ 10、整句英文拒绝语 ≥ 20，12 是安全中点），CJK 判据用 Unicode 属性转义覆盖汉字 / 假名 / 谚文 / `々` / 扩展 B 区。
- `proactive.speakProvider` / `speakModel`：发言阶段用哪个 provider / 模型，留空表示**单段模式**（判断模型同时把话写出来，即原有行为）。
- `proactive.speakFallback`（默认开）：两段式下发言阶段失败（报错 / 空回复 / 正文被拦）时，回退用判断模型给的那句 `speak`；发言阶段最多试 2 次（1 次重试）。
- **提示词防编造约束**：判断阶段的 `topic` 只能来自聊天记录里出现过的事；发言阶段只用记录里的信息、不编造具体事实（自己的经历、时间、地点、金额、别人的事）。
  起因是生产实例上真发出去一条自编经历（详见 PR 描述）——约束能压低概率，不能消除。
- 设置页「能力 → 对话与人格 → 主动发言」新增 1 个 provider 下拉、1 个 model 下拉（跟随所选 provider）和两个开关（`requireCjk` / `speakFallback`）。
- 设置页的两项识图范围（「识图往回找几条消息」「这个范围内最多识别几张图」）从「对话与人格」挪到「识图与绘图」，标签改成大白话；键名不变，不需要迁移。
- 启动横幅的模型来源行在启用两段式时追加「两段式（判断 a/b / 发言 c/d）」；单段模式不追加，与原来一模一样。
- 发言阶段的「重试 → 全被拦 → 回退 → 判断正文也不可用则放弃」抽成 `runSpeakStage()` 并补单测；回退被跳过时（判断正文本身不合格）verbose 会说明原因。
- 两段式缺项的告警前移到第一次判断调用之前——配置填错不该先花一次调用的钱。
- `owner-settings` 的 `DENY_PREFIXES` 补上 `speakProvider` / `speakModel`（和 `proactive.model` 同级：等于换掉说话的人）。
- 成本写进文档：两段式每次接话正常是 2 次模型调用（判断 1 + 发言 1）；判断阶段自己最多试 3 次、发言阶段最多试 2 次，最坏 5 次。

### 修复

- **历史消息方向看反了**：NapCat 的 `get_group_msg_history` 返回的是「最新在前」，插件却按「旧→新」理解，于是事件闸的时效判断拿的是窗口里**最早**那条（新鲜话题可能被判过气、老话题也可能被当新鲜，「最新一条是我自己发的」「最新一条像应答」同样看错）、摘要给模型的是最旧那几条、提示词标签与实际方向相反。现在归一化时按时间升序（同一时间按消息 id 稳定排序），所有调用方自动跟上。
- `proactive.requireCjk` 进了 `owner-settings` 白名单，群主可以在 QQ 私聊里直接关掉这道兜底。
- **插件重挂时会把整个宿主带崩（主动发言开着就必中）**：每轮检查结束要排下一次，而那次 `ctx.timeout` 在插件卸载/重挂之后会抛 `INACTIVE`；timer 回调丢弃返回值，异常变成 unhandled rejection，Node 24 默认直接 `exit 1`。升级插件、改适配器路径、关 DSH 都会踩到。现在卸载中不再排下一轮，异常也不会漏出回调。
- **改一次连接配置就多起一个适配器**：旧进程的退出通知晚到，`handle` 已是 null，于是又排了一次重启；两个适配器连同一个 OneBot，入站消息被处理两遍（重复回合、重复回复）。现在会取消已排的重启、旧进程退出不再触发重启、见到已有进程就不起第二个；重启退避在连上之后清零。
- **废弃配置清理的两处隐患**：id 匹配改成精确相等（原来的后缀匹配会把 `my-qq-bot` 这类别人的插件当成自己，误删对方配置）；键名本身带点（如 `a.b`）时不再删错键；写回基座改用 profile 层，避免多层 patch 时把上层内容抄下来；删掉的键连同旧值一起进日志。
- **升级残留的废弃配置会自动清掉**：DSH 写设置是合并语义，schema 不认识的键没人删，会一直躺在 `cordis.patch.yml` 里（版本升级删掉的字段就是这样留下来的）。现在插件在启动时、以及每次保存设置后比对一次 schema，把整段不认识的键从自己那一行配置里摘掉再写回；只动本插件自己的段，别的插件一概不碰。真机实测清掉了 4 个，其中 2 个是本插件早期版本遗留的 `reply.quoteReply` / `reply.subagentReply`。清理是一次性的：写回对 loader 属于非 volatile 变更，会重挂一次插件（适配器断连重连），之后不会反复触发。

### 兼容

- 四个新字段都有默认值，`speakModel` 留空时走原来的单段路径，行为、日志、配置都不需要迁移。
- 判断阶段的温度（0.8）、超时、重试次数与原来一致；发言阶段温度 0.9，且与判断共用同一套 `validateMessage`（字数 / 链接 / @ / 重复），被拦只记 verbose 日志，不改变判断路径的重试。

### 测试

- `test/test-proactive.mjs` 从 49 项扩到 84 项：两段式分派、只配一半、空回复回退到判断正文、回退关闭后不出声、单段模式不受影响、两段提示词的防编造约束、发言阶段胶水（重试 / 回退 / 放弃）的四种组合、`requireCjk` 的默认关 / 长度门槛两侧 / 纯 `々` 串 / 扩展 B 区 / 整句英文拦截、历史消息方向（归一化升序 / 事件闸算时效 / 摘要末行是最新 / 同秒按消息 id 定先后）、长度上限也按码点、判据顺序（纯符号串仍报「无实质内容」）、emoji 短回应不被误拦。
- 新增 `test/test-proactive-round.mjs`（35 项）：主动发言回合的端到端验证——假 ctx + 真 `lib/index.js` + 假 OneBot，把插件注册的定时器回调抓出来手动触发，跑「判断 → 发言 → requireCjk 拦截 → 回退判断正文 → 发送」整条链。此前这段胶水只有生产实例上肉眼验证过。后来补了三个场景：关掉兜底后发言被拦就闭嘴、判断提示词里的摘要方向必须旧→新、以及「卸载竞态」——tick 回来时定时器服务已不可用，只能记一行日志。
- 全套 28 个套件 / 1018 项通过。

## 0.11.0 —— 设置页迁到插件面板 + 主动发言走会话模型

一句话：设置页不再挂在「设置 → QQ 机器人」，改为插件自己的配置面板（首页侧边栏 插件 → 已安装 → dsh-qq-bot），
字段按「连接 / 基本 / 能力 / 高级」四档归类，后两档再分二级标签。

### 设置页

- 注册到官方 `plugins.bundle.config`（keyed slot，`entryKey` 用包名），不再占用设置页顶层分区。
- 顶端四档标签：**连接**（排最前，默认打开）/ **基本** / **能力** / **高级**；改传输类字段（协议、连接方式、各协议地址）会自动重启适配器。
- 二级标签：**基本** → 准入与名单 / 发言与管理；**能力** → 识图与绘图 / 搜索与抓取 / 对话与人格。
  两组各自记住上次位置；未归类的字段在每个二级标签下都显示。
- 「保存」「重新读取」常驻底栏，切主标签或二级标签都不消失。
- 重叠项整理：四处 preset 集中到「高级」并标注 ①自定义 id → ②拥有者/访客分流 → ③兜底 的优先级；
  主动发言人设标明与全局人格的兜底关系；三处 API key 的回退链写清；
  视觉 provider/model 留空时提示「会话模型不一定支持图片」。
- 补齐三个此前没暴露的配置：`protocols.onebot12.mode`（接入方式，并据此显隐正向地址 / 反向监听）、
  `proactive.provider`、`proactive.timeoutMs`；`proactive.provider` / `proactive.model` 两项做成和识图一样的下拉。

### 主动发言

- 审查补齐：分流（owner/guest 不同 preset）配置下**不再冷启动建孤儿会话**——那种配置的会话键是
  `group-x@owner` / `group-x@guest`，主动发言判断不了该算哪一档，硬建只会留下收消息时用不到的空会话。
- 修掉删除自定义端点后遗留的过期文案（日志还提示去补 `baseUrl`、生图/搜索 key 的说明还宣称被主动发言复用）；
  `SECURITY.md` 的拒绝清单同步成 `proactive.model`。
- 任何 volatile 配置改动都会重跑调度，横幅日志改为内容变化时才打，缺项告警也随配置变化重新判断。
- 顺手修了 README 里上游带来的 `不会 \`\` 人`（应为「不会 `@` 人」）。

- **和识图完全对齐：统一走 `ctx.llm.stream()`，不再自建 OpenAI 兼容端点。**
  原来必须自己配 `baseUrl` + `model` + `apiKey` 才能说话，现在 `provider` / `model` 留空就**跟随该群会话的模型**，
  零密钥；群里还没有会话时按全局 agent preset 建同一条会话再取。
- 设置页里 `provider` / `model` 改成**下拉选择**（复用 DSH 同一份模型目录，model 跟随所选 provider），
  与识图的交互一致；删掉 `baseUrl` / `apiKey` / `apiKeyEnv` 三个字段。
- 修掉「界面显示已开启、实际一句不发」：`proactiveConsiderGroup` 里原有一道
  「缺 `baseUrl` 或 `model` 就直接 return」的前置闸，配合 `imageGen` 兜底，配置一空就整轮跳过。
  现在由 `resolveModel` 判断，启动日志打印「模型来源=跟随群会话模型 / 指定模型 x/y」，真缺项会明确告警。
- 移除 `imageGen` 端点兜底：生图接口不是聊天接口，语义本就不对。

### 要求

- **DSH ≥ 0.2.0-rc.2**（`compat.js` 的 SUPPORT_FLOOR、`package.json` 的 `engines.dsh` 与 `dsh.compatibility` 三处一致）。

### 其它

- `DEFAULTS` 补上缺失的 `moli` / `session` 块，与 schema 默认值对齐（裸配置下不再取到 undefined）。
- 删掉旧标题留下的死样式 `heading`。
- CI 只改文档（`**.md` / `docs/**` / `LICENSE` 等）不再触发全量测试，并修了注释里过期的套件数。

### 测试

- `test/test-client.mjs` 从 32 项扩到 80 项：四档标签、二级标签、字段分组隔离、底栏常驻，
  外加一条**字段覆盖守卫**——schema 里可配置的字段若没出现在设置页就判失败（上游新增字段不会再被静默漏掉）。
- `test/test-proactive.mjs` 从 42 项扩到 49 项（来源解析：跟随会话 / 显式优先 / 只配一半 / 空白串 / 缺项报告）。
- 全套 18 个套件 / 683 项通过。

## 0.10.1 —— 主动发言不再对同一件事重复回复

一句话：修掉「主动发言时对一件已经聊完的事再回一次」的 bug，并给了可关的开关。

### 修复

- 新增**事件闸**（`proactive.eventGuard`，默认开）。原来只有「频率」和「和上一条文本一模一样」两道闸，
  所以一件早就有人接过的事，只要换个说法就会再回一遍。现在开跑前先判断这件事还该不该接：
  - 最新消息距今超过 `staleMinutes`（默认 15 分钟）→ 视为事件已过气，不接；
  - 最新一条是「行」「OK」这类短应答且不是提问 → 不插话（同一人 3 分钟内的补充说明不算应答）；
  - 最近 6 条只有两个人在来回说 → 视为两个人的对话，不硬插；
  - 同一话题在 `topicCooldownMinutes`（默认 120 分钟）内说过就不再重复，换说法（包含关系）也算同一件事。
- 去重记忆按群保存：最近 5 条发过的文本 + 最近 20 个话题 + 每条话题的时间，重启后重置。
- `lastSentAt` 改成发送时刻（原来是本轮开始时刻），最小间隔不再被上游延迟吃掉。

### 可选开关

- `proactive.eventGuard: false` 退回 0.10.0 的行为（只做频率与逐字去重）；设置页里是「事件去重（防重复回复）」。
- 阈值都可调：`staleMinutes`、`topicCooldownMinutes`。

### 测试

- `test/test-proactive.mjs` 从 28 项扩到 42 项（事件过气、短应答、两人对话、话题包含去重等）。
- 全套 18 个套件 / 628 项通过。
## 0.10.0 —— 多协议适配器（OneBot 11/12、Satori、Milky、QQ 官方）+ 拥有者设置通道

一句话：插件不再绑死 OneBot 11。同一套插件逻辑，换 `protocol` 就能接 OneBot 12、Satori（Koishi 生态）、
Milky 和 QQ 官方机器人开放平台；外加拥有者可以在 QQ 私聊里改自己的设置。

### 协议适配器（新）

- 适配器统一迁到 `lib/adapters/`，共享 `lib/bridge/`（手写 WebSocket、stdio 契约、消息段归一），
  仍然**零 npm 依赖**；`lib/onebot-adapter.mjs` 保留为兼容入口。
- 内部统一「中间表示」：一套消息段 + 一套 message 帧（见 `lib/bridge/CONTRACT.md`），
  各协议只做翻译，插件上层（会话、权限、历史、主动发言）完全协议无关。
- `protocol` 取值与传输：

  | 协议 | 适配器 | 传输 | 鉴权 |
  | --- | --- | --- | --- |
  | `onebot11`（默认） | adapters/onebot11.mjs | 正向/反向 WS + HTTP | access_token（Bearer / query） |
  | `onebot12` | adapters/onebot12.mjs | 正向/反向 WS + HTTP | access_token，反向 WS 需 Sec-WebSocket-Protocol |
  | `satori` | adapters/satori.mjs | WS /v1/events + HTTP RPC | Bearer + Satori-Platform / Satori-User-ID |
  | `milky` | adapters/milky.mjs | /event WS（或 SSE）+ /api | Bearer |
  | `qq-official` | adapters/qq-official.mjs | Webhook 或 WS 网关 | AppID/AppSecret → QQBot token，Webhook Ed25519 校验 |

- 新增 4 个适配器测试套件（onebot12 / milky / satori / qq-official），全部用本地假协议端，不连真实 QQ。

### 拥有者设置通道（qqconfig）

- 拥有者可以在 QQ 私聊里让机器人改自己的设置（不必手改 `cordis.patch.yml`）。
  防护分层：身份只取自当前会话发言人（必须命中 `auth.owners`）、只允许私聊、字段白名单
  （`auth.*` / `onebot.*` / 密钥 / 模型名硬拒绝）、值类型与范围校验、`propose`→`apply` 两步确认
  （token 300s、一次性、绑定拥有者+路径+值+配置修订号）、只走 DSH settings 服务落盘（不手改 YAML）、
  限流（每小时 6 / 每天 30）与审计日志 `QQ_msg/qqbot-config-audit.jsonl`。总开关 `auth.ownerSettings`。

### 其它

- `qqbot` 的 `send` 支持可选 `image`（本地图片绝对路径，只允许 `<QQ_msg>/qq-images` 内）。
- 修 `qq_imgsearch` 的本地文件白名单 bug：0.9.5 的 `meIsAllowedImageFile` 调用了未导入的
  `qqMsgRootSync`，ReferenceError 被吞掉后永远返回 false。工作区根解析抽到 `lib/workspace.js`。
- 新增 `lib/owner-settings.js`、`lib/workspace.js`、`lib/bridge/*`、`lib/adapters/*`；
  测试套件 14 → 18。

## 0.9.5 —— 主动发言（可选，默认关）

- 新增可选能力：按间隔看群里最近的消息，由模型自己判断要不要接话、接什么话题；默认关闭，且必须显式列群号才生效。
- 可控点：检查间隔、新消息门槛、免打扰时段、每小时 / 每天上限、两次发言最小间隔、最大字数、话题偏好、人设、演练模式、逐次判断日志。
- 安全阀：模型返回 speak=false 就不说话；发言前校验长度 / 链接 / ` / 重复；只有 verbose 才打印判断细节。
- 判断走 OpenAI 兼容接口（baseUrl / model / apiKey，留空复用生图配置），不依赖 DSH 会话模型。
- 新增 `test/test-proactive.mjs`（28 项），全套件 13/13、290 项。
- 修一处内部命名冲突：主动发言用的 buildPrompt 与插件原有回合提示词构造同名，改为显式别名。

## 0.9.4 —— qq_history：私聊历史 + 分页 + 按权限跨会话

- **私聊也能取历史**：之前 qq_history 只支持群聊（私聊直接报错）。现在当前私聊会用触发消息当锚点调 `get_friend_msg_history`，私聊里也能主动翻记录；`peer_id` 可指定别的私聊（需权限）。
- **分页**：新增 `before_seq`（上一页最旧的 message_id），返回里带 `next_before` 作为下一页游标；群聊用 `message_seq + reverseOrder`，私聊同样按锚点往前翻。
- **跨会话按权限取**（`lib/history-auth.js`）：当前会话随意读；拥有者 / 高级管理员可读任意群和私聊；群管理员只能读「自己是管理员（或已授权）且群在可管理范围」的群；别人的私聊只有拥有者/高级管理员可读。越权返回明确原因，不静默给空。
- 消息统一归一化成「新→旧」并按 message_id 去重；返回增加 `target` / `access` 字段说明读的是谁、凭什么权限。
- 新增 `test/test-history.mjs`（23 项：会话定向 / 越权判定 / 请求构造 / 归一化），全套件 12/12、262 项。
- 已在真实 NapCat 4.18.19 上验证：`get_group_msg_history`（带 message_seq 翻页）与 `get_friend_msg_history`（锚点）均 retcode 0。

## 0.9.3 —— 运行时兼容自检（不写死 DSH 版本）

- 新增 `lib/compat.js`：读取当前实际加载的 DSH 版本（`DSH_VERSION` 环境变量 → 从 `process.argv[1]` 向上找
  `@deepseek-ai/dsh/package.json` → 模块解析兜底），与声明支持范围比较后给出结论。
- 启动日志多一行：`运行于 DSH x.y.z（在声明支持范围内 / 超出支持范围 / 未能识别）`；
  `qqbot` 工具 `action="status"` 的 `runtime` 字段返回 `{dsh, supportingRange, compatible, note}`。
- 支持范围只维护两个常量（`SUPPORT_FLOOR = 0.1.7-0`、`SUPPORT_CEILING = 0.3.0-0`），
  不再逐版本维护兼容表；识别失败或超范围只提示，不影响收发消息。
- 已在 DSH 0.2.1-rc.2（线上）与 0.2.1-rc.3（隔离 profile）实测：七条工具注册齐全、启动无报错；
  新增 `test/test-compat.mjs`（14 项），全套件 11/11。
- 消息链路零改动：升级只多一行日志与一个状态字段。

## 0.9.2 —— 跨对话检索 + 旧会话向前兼容

- **不再清理旧会话**：当持久化的会话绑在别的工作区（例如 0.7 时代 workspace=/root 建的会话，
  升级后工作区变成 QQ_msg）时，DSH 会拒绝跨工作区复用同一 id。现在改为**保留旧会话**、
  用一个「工作区限定」的新 id（如 qqbot-group-123-ws1a2b3c）重开，历史一条不删。
- **跨对话信息调用**：配合 DSH 的 `@deepseek-ai/dsh-tool-session-query` 使用，Agent 可以
  session_search / session_event_search / session_trace / session_event_read 检索同工作区下的其他会话
  （QQ 的每个群/私聊都是一条会话，cwd 相同即互相可查）。
- **qq_history 支持跨群**：传别的 group_id 就能读其它群的消息（只读）。
- 新增 test/test-session-id.mjs（5 项）校验 id 回退稳定性；全套件 10/10。

## 0.9.1

- 生图（`qq_draw`）与人格设置正式发布；接口地址 / key / 模型 / 重试与轮询、人格开关 / 名字 / 设定、
  自定义 preset id 全部在「设置 → QQ 机器人」里。
- **撤回并重发 0.9.0**：0.9.0 的文档示例里带了维护者个人的中转站地址、设置占位带了个人人格名，
  已从历史中移除该版本并重发为 0.9.1（功能一致，无任何个人痕迹）。
- 人格默认留空：默认不注入任何身份设定，只有自己填了才会生效（自己用的配置属于部署侧，不进仓库）。
- 贡献者：[@arrow1031](https://github.com/arrow1031)（0.9.x 生图与人格）、[@nd002723](https://github.com/nd002723)（0.8.0 并入的模块化重构与 qq_history / qq_websearch / qq_webfetch / qq_imgsearch）。
- 修合并遗留的 `qqbot` send 分支未注入 `writeToAdapter` 的问题。
- 新增 `lib/imagegen.js` 与 `test/test-imagegen.mjs`（16 项）；全套件 9/9、220 项。

## 0.9.0 —— 生图（qq_draw）与人格都进设置

- 新增工具 `qq_draw`：按描述画图并直接发到当前 QQ 会话；接口地址 / key / 模型 / 尺寸 / 重试与轮询全在「设置 → QQ 机器人」里填，插件不内置任何 key。
- 生图容错：`429 / 5xx / 网络错 / 空结果` 自动重试（`maxAttempts` / `retryIntervalMs`）；`4xx` 直接报错；供应商返回 `task_id` 时继续轮询（`pollIntervalMs` / `maxPolls`，依次尝试三种轮询路径）。
- 参考图：`reference` 支持公网 URL 或 `qq-images` 下的本地图，用来保持同一人物形象（做「自拍」）。
- 人格进设置：新增 `persona`（开关 / 名字 / 设定），每个新会话第一轮附一次身份设定；新增 `agentPresetCustom`，自建 preset id 直接接管整档人格与工具面。
- 修掉合并时留下的隐患：`qqbot` 工具 `send` 分支引用了未注入的 `writeToAdapter`（发送必然失败），现已正式注入工具层。
- 新增 `lib/imagegen.js`（不依赖 Cordis，可单测）与 `test/test-imagegen.mjs`（16 项：URL 拼接、响应解析、重试、轮询）；全套件 9/9、220 项。

## 0.8.2

文档纠正到当前状态（无代码改动）：

- README 头部改为「本仓库即维护主干、已解除封版、0.8.x 要求 DSH >= 0.1.7」
- 架构图与文件清单更新为 0.8 的模块化结构（config / session / tools / admin / http / websearch / imgsearch / moli）
- 已验证表格与自测章节换成实测条数：8 个套件、204 项（adapter 19 / reverse 12 / plugin 76 / client 32 / admin 32 / http 17 / config 11 / websearch 5）
- 「维护状态」由「fork 自上游的继续维护版 / 原版已封版」改为「社区化维护中、不封版、跟随 main」
- 修复 CONTRIBUTING / SECURITY / PR 模板里的占位符残留，社区段补上 Discussions / 行为准则链接

## 0.8.1

- 修复：设置页「列表类字段」（群号白名单、私聊白名单、拥有者、可管理的群等）输入框吞掉逗号，
  只能填一个值。改为本地 draft 文本编辑，支持逗号 / 中文逗号 / 顿号 / 分号 / 空白分隔，失焦归一化。

## 0.8.0 — 合并下游分支（模块化 + qq_history / qq_websearch / qq_webfetch / qq_img）

首次把下游开发者分支（nd002723/dsh-qq-bot，0.6.3 → 0.6.11）并入主干，并把 0.7.0 的
DSH 0.2 服务访问契约移植到模块化代码上。

- 结构：单体 lib/index.js 拆分为 lib/{config,http,websearch,imgsearch,moli,admin,session,tools}.js
- 工具：新增 qq_websearch（多引擎组合搜索）、qq_webfetch（独立抓取）、qq_img（图片搜索/上传）、qq_history（AI 自取聊天记录）
- 工作区：QQ_msg 工作区自动创建，会话自动归入分组；群聊回复/引用机器人视同 @；被回复的图片识图
- 健壮性：本轮运行失败不再重发上一轮回复；失败提示总是作为回复发出（只输出状态码）
- 兼容：工具注册与访客工具闸改为 ctx.get('tools') / ctx.inject(['tools'])（DSH 0.2 契约），
  并保留 0.1.x 属性形态兜底
- 测试：node test/run-all.mjs（含 config/http/websearch/plugin 套件）
- 社区化：完全解除封版（安装跟随 main，不再锁 tag）；启用 Discussions；
  新增 CONTRIBUTING / CODE_OF_CONDUCT / SECURITY / issue 与 PR 模板 / CODEOWNERS；
  邀请下游开发者 @nd002723 为协作者

# 更新日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## 0.6.8

模块化重构 + qq_history：聊天上下文改为 AI 主动自取（不再硬塞），业务代码按模块拆分。

- **模块化重构**：`lib/index.js`（原 3346 行单文件）拆成模块——保留 napcat 通信与子进程监管（`lib/onebot-adapter.mjs`），抽出网络查询通道（`lib/http.js` 通用 HTTP 传输 / `lib/websearch.js` 联网搜索 / `lib/imgsearch.js` 图片反搜）、dsh-moli 联动（`lib/moli.js`）、配置契约（`lib/config.js`：`DEFAULTS` + `Config` + `plainConfig`/`mergeConfig`）；业务再拆三块——`lib/admin.js`（权限三路鉴权 + 群管理指令 `handleAdminCommand`/`planAdminCommand`/`runGroupAction`）、`lib/session.js`（会话条目与路由 `getEntry`/`sessionRoute`/`entryForAgent` + 被回复图片收集）、`lib/tools.js`（6 工具动态注册）；`lib/index.js` 只留 napcat 通信 + 装配与生命周期（1906 → 845 行）。所有外部请求仍走 `webSearch.proxy` 管控（留空直连、非空走 CONNECT 隧道、非公网 IP 拒绝）。
- **qq_history（新工具，AI 自取聊天记录）**：不再自动把群内「最近相关发言」硬塞进会话——`acceptMessage` 里的 `fetchReplyContext`/`replyTargetQQs` 已删除，需要历史上下文时由 Agent **主动调 `qq_history`** 拉取（prompt 有引导）。
  - 返回结构化消息列表：`{ok, group_id, messages:[{time, user_id, nickname, text, images:[{url, description}]}]}`，参数 `group_id`（默认当前群）/ `user_id`（可选筛人）/ `count`（默认 20，上限 50）/ `with_images`（默认开）。
  - **识别窗口锚定「最新提及」**：只对触发本条回复的那条消息（@ bot / 回复 bot / 命令前缀）**往前 `scopeMessages` 条**内的图片做识别（默认 5），最多 `imageLimit` 张（默认 3，最近的优先）；更早的 @ 不锚定、其附近图片不因「也是被提及」而识别，避免重复拉取/重复识图。
  - 窗口内图片用现有视觉链路（下载 + `askVision`）识别，返回 URL + 描述；识别失败只给 URL 不阻塞。修复：工具 execute 不再闭包未定义的 `entry`（原会 ReferenceError），改由执行上下文 `exec.agent` 经 `entryForAgent` 反查当前会话。
- **被回复消息的图片仍走视觉识别**：`collectReplyImageUrls` 保留「用 `get_msg` 拉被回复消息、收集图片并入识图」的能力（回复引用流程不受影响），但不再把被回复消息文本塞进上下文。
- **访客白名单**：默认加入 `qq_history`。
- **新配置段 `history`**：`scopeMessages`（识别窗口条数，默认 5）/ `imageLimit`（窗口内最多识图张数，默认 3），设置页可改。
- **测试**：`npm test` 全绿（adapter 12 / plugin 88 / client 32 / admin 36）；新增 4f 段（工具注册 / 白名单 / 结构化拉取 / 窗口锚定 / 限张），旧「自动塞上下文」断言全部翻转为「不再自动携带」。

## 0.6.7

继续维护版：qq_websearch 的 url 抓取拆成独立工具 qq_webfetch，新增 dsh-moli 接管。

- **qq_webfetch（新独立工具）**：从 qq_websearch 拆出 url 抓取，平级注册；受 `webSearch.proxy` 管控（留空直连、非空走 HTTP CONNECT 隧道 + TLS），抓取前校验目标为公网 IP（内网/回环/私有地址一律拒绝）。
- **dsh-moli 接管（qq_webfetch）**：设置页新增 `moli` 段（默认关）——开启后 qq_webfetch 改用 Moli 无头浏览器渲染抓取（可抓 SPA/JS 渲染页）；HTTP 代理自动透传 `webSearch.proxy`（可被 `moli.proxy` 覆盖）；未检测到 moli 引擎时开关无效，工具返回 `moliUnavailable` 明确报错。
- **访客白名单**：默认加入 `qq_webfetch`。

## 0.6.6

继续维护版：群聊「回复机器人」视同 @ 处理，bot 被点名时改用 QQ 引用回复，命令前缀视同点名；点名但无正文也处理。

- **回复（引用）bot 消息视同 @ 处理**：群聊里没 @ 机器人、但回复（引用）了 bot 的消息，照常进入 Agent 旅程；开关 `reply.botReply`（设置页「回复」区，默认开启）。判定方式：调 NapCat `get_msg` 查被引用消息的发送者是否为 bot 自己。
- **追加最近相关发言上下文**：回复 bot 触发时，调 NapCat `get_group_msg_history` 筛出**该对话者 + bot** 的最近最多 **5 条**发言，按时间正序并入 Agent 输入（`【HH:MM】对话者/bot：内容`）。
- **「回复别人 + 正文 @bot」**：同样触发（引用回复 + 拉上下文）；上下文把**被回复者 / 被 @ 对象**的发言也并入，扩充到 **8 条**。
- **「回复 bot + 正文 @别人」**：这条可能不是对 bot 说的——消息照常进模型，但**不强制引用回复**，交给 bot 自行判断是否继续回复。
- **QQ 引用回复（回复消息流程）**：bot 被点名（@ bot / 回复 bot / 命令前缀 / 管理指令）时的响应，统一**引用触发消息**发送（CQ `reply` 段）；`requireAt` 关闭后的普通闲聊不引用，避免每条群消息都变引用回复。
- **命令前缀视同点名**：设置了 `commandPrefix`（如 `/ai`）时，命中前缀的消息豁免 requireAt（不需要 @），并走引用回复——与群管理指令同理。
- **点名但无正文也响应**：bot 被点名（@ bot / 回复 bot / 命令前缀）时，即使消息没有正文（纯回复、纯 @、回复别人 + @bot 但没打字），照常进入 Agent 旅程——给 Agent 占位正文「（本条消息无正文，仅点名了 bot）」，结合上下文主动回应；普通空消息（未点名）仍跳过。
- **被回复消息始终并入上下文**：被回复（引用）的那条消息用 `get_msg` 按 id 单独拉取，不受最近历史窗口限制；上下文**最低保证 2 条**（被回复消息 + 发言人本条），不硬补其它群友。
- **被回复消息的图片也走视觉识别**：`get_msg` 拉被回复消息时一并收集里面的图片 URL，与本条消息的图合并交给插件原有的识图功能（`describeImages`）识别，识别文本并入 Agent 输入。
- **修复**：`requireAt` 关闭（群=全部）时，回复 bot 的消息此前不识别（不引用、不拉上下文）——现已修复，只要 `reply.botReply` 开启且消息带了被引用消息就查。
- **多引擎组合搜索（qq_websearch）**：`webSearch.multiEngine`（默认开，设置页有开关）——Tavily（配 `TAVILY_API_KEY` 才启用）→ DuckDuckGo（html→lite）→ Yandex / Bing / Wikipedia 并发兜底，全部请求受 `webSearch.proxy` 管控（留空直连、非空走 CONNECT 隧道）；关闭则落回官方 DeepSeek web_search。完全独立实现，不依赖任何其它插件。
- **测试**：`npm test` **161 项全绿**（test-plugin 81 项，新增无正文 / 窗口外被回复消息 / 最低 2 条兜底 / 被回复图片识别 / 多引擎搜索五组用例；admin 36 项）。

## 0.6.5

继续维护版：联网抓取走代理、固定会话名、访客白名单瘦身、设置页重排。

- **`qq_websearch` 新增 url 抓取模式**：`{url}` 直接抓指定网页原文（http/https，仅公网），返回 `{ok, url, status, text}`；与搜索共用 `webSearch.proxy`——非空时经 HTTP CONNECT 隧道 + TLS（含境内/境外分流），留空直连。抓取前校验目标为公网 IP，内网/回环/私有地址一律拒绝（防经代理扫内网）。
- **固定新建会话名**：`session.fixedName`（默认开启），新会话显示名钉死为 `群聊_<群号>` / `私聊_<QQ号>`，替代 LLM 自动起标题（用 DSH `sessionTitle.rename` 的 user 源标题，自动生成不会覆盖）；已建会话保持原名。
- **访客默认白名单瘦身**：移除 `web_fetch`，访客联网统一走 `qq_websearch`（搜索 + url 抓取，都经代理）；DSH 自带的 `web_fetch` 仅拥有者可用。
- **设置页重排**：字段按功能分 7 块（接入与范围 → 身份与权限 → 群管理 → 会话 → 回复 → 图片视觉 → 联网搜索），QQ 号类字段集中；`cordis.patch.yml` 键序同步排版（纯排版，值不变）。
- **测试**：`npm test` **144 项全绿**（test-plugin 45 项）。

## 0.6.4

继续维护版：访客联网搜索，工具面设置更顺手。

- **联网搜索工具 `qq_websearch`**：访客白名单搜索（DeepSeek web_search），`webSearch` 配置段可选代理 / 端点 / key 环境变量名 / 触发上限；key 自动走 DSH 凭据服务，`process.env` 兜底。
- **访客默认白名单**：扩为 `qqbot, qqgroup, qq_websearch, web_fetch`（`web_fetch` 只抓公网，内网 IP 由 DSH 拒绝）。
- **Agent preset 下拉**：设置页改为下拉选择（部署默认 / standard / ptc / minimal / cordis），只影响新会话；人格分离字段空位自动回落 `agentPreset`。
- **修复**：`inject` 补 `'tools'`，解决生产环境工具注册失败（`cannot get property "tools" without inject`）。
- **测试**：`npm test` **147 项全绿**。

## 0.6.3

继续维护版（fork 自 [arrow1031/dsh-qq-bot](https://github.com/arrow1031/dsh-qq-bot)）：工作区自动管理，会话自动归入分组。

- **工作区自动管理**：移除 `workspace` 配置项；自动读取 DSH 官方默认 Workspace 位置（`<系统 Documents>/deepseek-harness`），在其同级目录创建 `QQ_msg` 并注册为 DSH workspace——Web UI 侧栏的「QQ 消息」分组，**新会话自动归入该分组**（通过 Cordis `ctx.reflect.get('workspaceRegistry')` 免注入读服务，缺失时自动回退）。
- **图片缓存结算清理**：带图消息的原图缓存到 `QQ_msg/qq-images/<会话id>/`，会话结算后自动删除，会话与工作区保留。
- **测试**：`npm test` **133 项全绿**（test-plugin 38 项，含分组断言）。

## 0.6.2

继续维护版：图片视觉增强、图片缓存导出。

- **图片视觉**：`vision` 配置新增 provider / model 下拉选择（从 DSH 自定义 providers 选，协议 / baseURL / apiKey 沿用）；模型不支持图片时给可读报错并引导切换。
- **图片缓存导出**：带图消息的原图缓存到 `<QQ_msg>/qq-images/<会话id>/`，会话结算后自动删除；消息附上识图结果与图片路径，并提示 Agent 结合用户发言作答、需确认身份时提炼关键词联网查证，勿凭空猜测。
- **插件标准**：package.json 补 `engines.dsh` 版本范围与 `dsh.runtime: host`。
- **测试**：`npm test` **133 项全绿**（test-plugin 38 项）。

## 0.6.1

**适配 DSH 0.1.7：设置契约重做**。0.1.7 移除了 `ctx.settings.register()`，0.6.0 在 0.1.7 上会
注册失败（设置页整个消失）。除设置相关外，收发消息的链路没有变化。

- **根因**：0.1.7 删掉了 `packages/settings/settings-file`（独立的 `settings.yaml` 文档），
  并把 `settings` 服务重写成「直接读 profile 里每个插件条目的 Config schema」。因此
  **`ctx.settings.register(ns, schema, { base })` 不再存在**：设置表单改由**插件自己导出的
  Cordis `Config` schema** 承载，界面上的改动写回 profile 的 `cordis.patch.yml`。
- **Host**：新增 `export const Config`（schemastery）；所有出现在设置页里的字段标 `.volatile()`
  （`settings` 只允许 volatile 字段被编辑）；删掉 `settings.register` 调用；配置改从 Cordis
  求值后的 `config` 参数读取 —— volatile 字段是引用，要 `.get()`。
- **热更新语义变了**：0.1.7 里 volatile 字段变化**不会重挂插件**，`cordis-plugin-loader`
  只就地更新运行中 fiber 的引用并发 `loader/volatile-update`。所以改为监听该事件刷新配置；
  连接方式（模式 / 地址 / token）变化时才重启适配器，与旧行为一致。
- **客户端**：设置命名空间从自定义的 `qq-bot` 改为 **profile 条目 id `dsh-qq-bot`**
  （条目被改名时回退到「以 qq-bot 结尾」的唯一匹配）；按 0.1.7 的要求在 `inject` 里声明
  `remote` 与 `remote.settings`。
- **设置页归属**：用 `settings.configure({ auto: false }, ctx.fiber)` 声明「本插件的设置页由
  自带的『QQ 机器人』选项卡负责」，避免 DSH 再按 schema 自动生成一个重复页面。
- **依赖**：新增运行时依赖 `@deepseek-ai/schemastery@^3.18.4`（`Config` 必需；
  3.18.2 及更早没有 `.volatile()`）。
- **Windows 修复**（0.6.0 只在 Linux 验证过）：
  - 测试里 `import(path.join(...))` 在 Windows 上报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`，
    改用 `pathToFileURL()`；
  - `PROFILE_MODULES` 不再写死 `/home/dsh/.dsh/profiles/node_modules`，可用
    `DSH_PROFILE_MODULES` 覆盖；
  - 测试清理临时软链时不再对 junction 用 `fs.rmSync(recursive)`（会把目标目录删空），
    改用 `rmdirSync` / `unlinkSync`。
- 测试：**124 项全绿**。新增契约断言：`client.js` 里每个表单字段都必须是 volatile、
  `volatileForm(Config)` 非空、`accessToken` 是 secret、内部字段不进设置页；
  以及热更新断言（volatile 就地更新 → 重启适配器；非连接类改动不重启）。

## 0.6.0

- **访客工具闸**：非拥有者的消息驱动 Agent 时，禁用 DSH 内部工具（bash / 读写 / 子代理 / …）。
  实现为 `tools.guard`，只在建会话时注册一次，判据是可变标志位——因此不注入提示词、
  不改工具表、不记 `request/header`，**0 额外 token**，且保持单会话单历史。
- 采用**白名单**而非黑名单（`auth.guestToolAllow`，默认 `qqbot,qqgroup`），
  使 `run_code` 这类"不在全局层"的 PTC 保留传输也自动被挡。
- 会话分流（`ownerPreset` / `guestPreset`）**降级为可选的人格分离**，默认关闭；
  文档与设置页明确标注它不再是安全边界。
- 设置页新增「允许非拥有者使用 DSH 内部工具」「访客仍可用的工具白名单」。

## 0.5.0

- **权限模型重做**，改为三路并行取并集：
  1. 静态名单：`auth.owners`（拥有者，含永久授权）、`auth.superAdmins`（后台设定的高级管理员）
  2. 动态授权：群维度、可带时限，由拥有者或本群管理员授予，**不可跨群生效**
  3. 本群身份：`get_group_member_info` 查到 admin / owner
- 新增 `/whoami`、`/perms`、`/grant`、`/revoke`、`/grants`；权限来源会如实列出。
- **指令严格匹配**：前缀必须在消息首位；动词必须完全匹配；token 数必须落在
  该指令声明的 `[min,max]` 内，多余内容判为用法错误且不执行——防止聊天内容夹带
  指令样内容被误执行。
- Agent 工具 `qqgroup` 改用同一套鉴权，"说话人"取自本会话最近一条消息。
- **reply 透传**：适配器解析 `[CQ:reply,id=…]` 并输出 `reply_to`，
  `/recall` 因此支持"回复某条消息即可撤回"；同时 reply 段不再污染正文
  （否则正文以 `[回复]` 开头，斜杠就不在首位了）。

## 0.4.0

- 新增群管理：QQ 侧指令（`/mute`、`/kick`、`/banall`、`/card`、`/admin`、`/recall`、
  `/rename`、`/members`、`/info`、`/help`）+ Agent 工具 `qqgroup`。
- 适配器新增**通用 action 通道**，任意 OneBot 11 动作都可透传，无需为每个动作改代码。
- `notice` / `request` 事件改为**全字段透传**（此前丢了 `operator_id`、`duration`、
  `target_id`、`card` 等群管理必需字段）。
- 引入「演练模式」`admin.dryRun`：只回复将执行什么，不真执行。

## 0.3.2

- **修复** `registration.schema.toJSON is not a function`：设置命名空间的 schema
  必须同时是可调用的解析函数和可 JSON 化的对象。
- `access_token` 改为**只写字段**：不上发到浏览器，留空即不修改（避免保存时被清空）。
- **修复**保存成功后按钮卡在「保存中…」（`setSaving(false)` 漏在成功分支）。

## 0.3.1

- 文档补充升级注意事项：`dsh plugin add` 走 pnpm，按 tarball 完整性缓存，
  改代码必须打成**新版本号文件名**再装，否则会被判成 lockfile 最新而跳过。

## 0.3.0

- 新增**客户端半边**：在 DSH「设置」里贡献「QQ 机器人」选项卡，配置项全部可视化修改。
- 手写客户端 bundle（`window.__ModuleLoader__.load`），只 `require('react')`，无需打包器。
- 配置分两层：composition 行配置是 base 层，设置面板改的是用户层。

## 0.2.0

- 首个可安装的插件包：`dsh plugin --profile web add` 即自动注册为 profile 层。
- OneBot 11 适配器（零 npm 依赖，用 Node 22 内置 `WebSocket` / `fetch`）：
  正向 WebSocket 收事件 + HTTP API 发消息，自带指数退避重连与发送限速。
- 每个 QQ 会话对应一个 DSH Agent，会话落盘并出现在 Web UI。
- 群聊默认要求 @机器人，私聊直接回，长回复按换行分片。

## 0.1.0

- 未发布的原型：以「动态 Cordis Package」形式在运行的 DSH 进程里验证了完整链路
  （`examples/dynamic-package-host.js` 保留了这一形态）。
