/**
 * dsh-qq-bot —— 把 QQ 接到 DSH Agent 的 Cordis 插件（Host 侧）
 *
 *   QQ/其它平台 -> 协议适配器（lib/adapters）-> 统一中间表示 -> DSH Agent -> 回复回原平台
 *
 * 依赖的宿主服务（peerDependency，由 DSH 运行时提供）：
 *   subprocess         拉起并监管适配器子进程
 *   sessionController  用官方组装路径创建/取出每个 QQ 会话的 Agent
 *   timer              慢回合提示 + 适配器重启退避
 *   settings（可选）    声明设置页由本插件自带的「QQ 机器人」选项卡负责
 *
 * 配置契约（DSH ≥ 0.1.7）：本模块导出 schemastery 的 `Config`。DSH 直接把它当作
 * 设置表单的来源，并把界面上的修改写回 profile 的 cordis.patch.yml。标了 `.volatile()`
 * 的字段可以热改：cordis-plugin-loader 会就地更新运行中 fiber 的配置引用并发
 * 'loader/volatile-update'，不重新挂载插件。
 * 0.1.6 时代的 `ctx.settings.register(ns, schema, {base})` 在 0.1.7 中已被移除
 * （settings-file 包整体删除），所以这里不再自行注册命名空间。
 *
 * 工作区：读取 DSH 官方默认 Workspace 位置（<系统 Documents>/deepseek-harness），在其同级目录
 * 自动创建 QQ_msg 作为本插件的全局工作区根，每个 QQ 会话一个子目录；无需任何路径配置。
 */

import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { promises as fsPromises, readFileSync, writeFileSync } from 'node:fs';
import { publicFetch } from '../shared/http.js';
import { runWebSearch } from '../tools/websearch.js';
import { runImageSearch, uploadToHost, imgSearchSoutubotFile, imgSearchTraceMoeFile, meIsAllowedImageFile } from '../tools/imgsearch.js';
import { meFindMoli, meMoliFetchText } from '../tools/moli.js';
import { Config, DEFAULTS, plainConfig, mergeConfig, staleConfigPaths, describeError } from '../config.js';
import { createAdmin } from '../api/group-admin.js';
import { createSession } from '../session/manager.js';
import { createTools } from '../tools/index.js';
import { qqMsgRootSync, sessionWorkdir, imageCacheDir, isInside } from '../session/workspace.js';
import { createOwnerSettings, matchNamespace } from '../valve/security/owner-settings.js';
import { decideGateEdit, securitySnapshot } from '../valve/tool/gate-guard.js';
import { assembleValves, describeAssembly } from '../assemble.js';
import { resolveAdapterPath } from '../transport/index.js';
import { chunkMarkdown } from '../message/chunk.js';
import { createMsgIdCache } from '../message/msgid-cache.js';
import { buildPersonaHint, dropConfigPaths, sanitizeDisplayName, summarizeTurnReason, idValue } from './turn-text.js';
import { createModelPicker } from './model-pick.js';
import { createProactiveSurface } from './proactive-surface.js';
import { createAdapterSupervision } from './adapter-supervision.js';
import { createRouteGlue } from './routes-glue.js';
import { createFlowDelivery } from './flow-delivery.js';
import { createInboundLimits } from './inbound-limits.js';
import { createAuthFlow } from './auth-flow.js';
import { createStreamBridge, shouldStream } from '../message/stream.js';
import { createQqBind, loadOfficialConnect } from '../api/qq-bind.js';
import { mountRoutesWhenReady } from './index.js';
import { createRouteGuard } from './route-auth.js';
import { parseModelCommand } from '../session/model-router.js';
import { flowInterceptKind, artifactInputLines, stripInvisible } from './commands.js';
import { pickInterim } from '../message/interim.js';

import { compatibilityInfo, describeCompatibility } from '../shared/compat.js';
import { createUpdateChecker, fetchJsonDefault, readPackageVersion } from '../api/update-check.js';

export { Config };

export const name = 'dsh-qq-bot';
// attachments / llm：图片视觉用（把 QQ 图片注册成 DSH image 块并探测模型能力）。
// 两者都由 dsh-base 恒常挂载（attachment-local 与 dsh-llm），声明为硬依赖。
export const inject = ['subprocess', 'sessionController', 'timer', 'attachments', 'llm', 'tools'];

// 本插件的「自报身份」：npm 包名（带作用域，0.12 起）+ 条目 id（一直是 dsh-qq-bot）。
// 配置残留清理按这两个名字**精确**认自己的条目，不做后缀正则（会误伤 my-qq-bot）。
const SELF_IDS = new Set(['dsh-qq-bot', '@sputnikzaychik/dsh-qq-bot']);

// 适配器路径由传输层统一解析（协议 -> 脚本），这里不再自己拼目录：
// 0.10 起适配器统一放 lib/transport/，OneBot 11 保留旧入口文件名做向前兼容。


// —— 工作区根（QQ_msg）：读取 DSH 官方默认 Workspace 位置（<系统 Documents>/deepseek-harness），
// 在它的同级目录建 QQ_msg 作为本插件的全局工作区根；每个 QQ 会话一个子目录。
// Documents 解析复刻 @deepseek-ai/dsh-api-workspace-controller 的平台命令；Linux 上
// xdg-user-dir 在无独立 Documents 目录时回退到主目录，这里同样按返回值采用（即
// 建在 <主目录>/deepseek-harness/QQ_msg，仍与官方 default-workspace 严格同级）。
// 已解析/注册的 QQ_msg 工作区（DSH workspace 分组）；id 为 null 表示该 DSH 无 workspace 服务，回退 cwd。
let qqWorkspaceValue = null;



/** 把设置里的「人格」渲染成一段身份设定；未启用或没填内容时返回空串。 */
/** 深拷贝一份配置，并把指定路径（键名数组）整段摘掉（不改入参）。 */
/**
 * 把本插件配置里 schema 不认识的键从 patch 里清掉。
 *
 * 为什么需要：DSH 的设置写入是「合并」语义（settings.write 里 mergeLayers(strip(raw), next)），
 * 只有 schema 认识的字段才会被替换；版本升级删掉的旧字段没人管，会一直躺在 cordis.patch.yml 里。
 * Schemastery 校验也不报错（未知键原样保留），所以它们既不生效、也不会自己消失。
 *
 * 这里走 configEditor.edit：返回什么就落盘什么，是唯一能真正删掉键的入口
 * （settings.update / settings.mutate 都是合并语义，删不掉键）。
 *
 * 两条安全边界：
 *  1. 只认本插件自己那一行 entry，id / name 精确匹配——不做前后缀模糊匹配，
 *     否则 "my-qq-bot" 这种别人的插件会被误删配置；
 *  2. 以 profile 层（configuration().override）为基座，而不是 edit 回调给的 current。
 *     current 是「各层同 id 后行整段替换」之后的最终配置，拿它当基座会把上层
 *     patch（~/.dsh/cordis.patch.yml、--patch overlay）的内容整段抄进 profile 行。
 *
 * 删掉的键和旧值都会打进日志，升级/降级来回折腾时能照着加回去。
 *
 * @param {Record<string, any>} ctx 插件上下文
 * @param {{tag?: string, log?: (line: string) => void}} [options]
 * @returns {Promise<string[]>} 实际清掉的路径（点号连接，仅供日志与测试使用）
 */
export async function cleanupStaleConfig(ctx, options) {
  const opts = options === undefined || options === null ? {} : options;
  const tag = typeof opts.tag === 'string' && opts.tag !== '' ? opts.tag : '[dsh-qq-bot]';
  const log = typeof opts.log === 'function' ? opts.log : (line) => { console.log(line); };
  const read = (name) => {
    try { if (typeof ctx.get === 'function') { const found = ctx.get(name); if (found !== undefined && found !== null) return found; } } catch { /* 服务未就绪 */ }
    try { if (ctx.reflect !== undefined && ctx.reflect !== null && typeof ctx.reflect.get === 'function') return ctx.reflect.get(name); } catch { /* ignore */ }
    return undefined;
  };
  const editor = read('configEditor');
  if (editor === undefined || editor === null || typeof editor.configuration !== 'function' || typeof editor.edit !== 'function') return [];
  let rows;
  try { rows = editor.configuration(); } catch (error) {
    log(tag + ' 读取配置清单失败，本次跳过废弃字段清理：' + describeError(error));
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const mine = rows.find((row) => {
    const entryOptions = row === null || row === undefined || row.entry === null || row.entry === undefined ? undefined : row.entry.options;
    if (entryOptions === undefined || entryOptions === null) return false;
    const name = entryOptions.name === undefined || entryOptions.name === null ? '' : String(entryOptions.name);
    const id = entryOptions.id === undefined || entryOptions.id === null ? '' : String(entryOptions.id);
    // 自报名字：0.12 起包名带作用域，而条目 id 仍是 dsh-qq-bot，两个都要认。
    // 这里**只做精确匹配**——用 /(^|[-_] )qq-bot$/ 之类的正则会误伤 my-qq-bot 这类别的插件。
    return SELF_IDS.has(name) || SELF_IDS.has(id);
  });
  if (mine === undefined) return [];
  const override = mine.override === undefined || mine.override === null ? {} : mine.override;
  const stale = staleConfigPaths(override);
  if (stale.length === 0) return [];
  const labels = stale.map((path) => path.join('.'));
  const describeValue = (value) => {
    if (value === undefined) return 'undefined';
    try {
      const text = JSON.stringify(value);
      return text !== undefined && text.length > 120 ? text.slice(0, 117) + '…' : String(text);
    } catch { return String(value); }
  };
  const readValue = (path) => {
    let node = override;
    for (const part of path) {
      if (node === null || typeof node !== 'object') return undefined;
      node = node[part];
    }
    return node;
  };
  const removed = stale.map((path, index) => labels[index] + '=' + describeValue(readValue(path))).join('、');
  try {
    // 基座是 profile 层的 override：current 含上层 patch 的合并结果，拿它写回会把别人的层抄进来。
    await editor.edit(mine.entry, () => dropConfigPaths(override, stale));
  } catch (error) {
    log(tag + ' 清理废弃配置失败（不影响运行）：' + describeError(error));
    return [];
  }
  log(tag + ' 清理了 ' + stale.length + ' 个本版本已不存在的配置字段：' + removed);
  return labels;
}

export async function apply(ctx, rawConfig) {
  const TAG = '[dsh-qq-bot]';
  const subprocess = ctx.subprocess;
  const sessionController = ctx.sessionController;

  // DSH 交给插件的已经是「按 Config schema 求值过」的配置：composition 行配置、
  // profile 的 cordis.patch.yml、schema 默认值三层已经合并完。volatile 字段是引用
  // （要 .get()），这里还原成普通对象；CONFIG 是个 let，热更新时整体刷新。
  const resolveConfig = () => {
    const merged = mergeConfig(DEFAULTS, plainConfig(rawConfig ?? {}));
    // 设置页的 preset 下拉只列内置四个；自定义档位（如 qq）用 agentPresetCustom 填，非空时优先。
    const customPreset = (merged.agentPresetCustom === undefined || merged.agentPresetCustom === null)
      ? '' : String(merged.agentPresetCustom).trim();
    if (customPreset !== '') merged.agentPreset = customPreset;
    return merged;
  };
  let CONFIG = resolveConfig();

  // 本插件自带「设置 → QQ 机器人」选项卡，所以不要 DSH 再按 schema 自动生成一个。
  let settingsConfigured = false;
  try {
    ctx.inject(['settings'], (child) => {
      child.effect(() => {
        if (settingsConfigured) return () => {};
        settingsConfigured = true;
        const dispose = child.settings.configure({ auto: false }, ctx.fiber);
        return () => { settingsConfigured = false; if (typeof dispose === 'function') dispose(); };
      });
    });
  } catch (error) {
    console.log(TAG + ' 未能声明设置页归属（不影响运行）：' + describeError(error));
  }

  // 废弃字段清理：启动时跑一次，之后每次保存设置（volatile 更新）再跑一次。
  // 只有真的存在废弃键时才写盘；写盘对 loader 来说是非 volatile 变更（schema 外的键
  // 在 equal() 里严格比较），所以清理成功会重挂一次插件、适配器断连重连——一次性，不会自激。
  let staleCleanupPending = null;
  const scheduleStaleCleanup = (delay) => {
    if (staleCleanupPending !== null) return;
    try {
      staleCleanupPending = ctx.timeout(() => {
        staleCleanupPending = null;
        // void 只吞 lint，不吞 rejection；这里漏了就会变成 unhandled rejection（Node 默认退出）。
        void cleanupStaleConfig(ctx, { tag: TAG }).catch((error) => {
          console.error(TAG + ' 清理废弃配置失败：' + describeError(error));
        });
      }, delay);
    } catch (error) {
      staleCleanupPending = null;
    }
  };
  scheduleStaleCleanup(1200);

  // 只关心影响「连接方式」的那几项：变了才重启适配器。
  const transportKey = (cfg) => JSON.stringify([
    cfg.protocol, cfg.mode,
    cfg.onebot.wsUrl, cfg.onebot.listen, cfg.onebot.httpUrl, cfg.onebot.accessToken,
    cfg.protocols.onebot12, cfg.protocols.satori, cfg.protocols.milky, cfg.protocols.qqOfficial,
  ]);

  // 工作区根（QQ_msg）不依赖 CONFIG：模块级 qqMsgRootSync() 解析一次即缓存。
  // 适配器路径依赖 CONFIG（会被热更新整体替换），所以用取值函数而不是快照常量。
  const currentAdapterPath = () => {
    if (CONFIG.adapterPath !== '') return CONFIG.adapterPath;
    return resolveAdapterPath(CONFIG.protocol);
  };

  /** 流程授权开启时给每个会话一个独立工作区（QQ_msg/<sessionId>）：产物要按会话归属，共用根分不出是谁写的。 */
  async function ensureSessionWorkspace(sessionId) {
    const dir = sessionWorkdir(sessionId);
    try { await fsPromises.mkdir(dir, { recursive: true }); }
    catch (error) { console.error(TAG + ' 会话目录建不出来（产物投递会拿不到文件）：' + describeError(error)); }
    let id = null;
    try {
      const reg = (typeof ctx.reflect?.get === 'function') ? ctx.reflect.get('workspaceRegistry') : undefined;
      if (reg && typeof reg.resolveByPath === 'function' && typeof reg.create === 'function') {
        let ws = await reg.resolveByPath(dir);
        if (ws === undefined || ws === null) ws = await reg.create(dir, 'QQ 会话 ' + sessionId);
        id = (ws && typeof ws.id === 'string' && ws.id !== '') ? ws.id : null;
      }
    } catch (error) { console.error(TAG + ' 会话工作区分组不可用（回退 cwd 方式）：' + describeError(error)); }
    return { id, path: dir };
  }

  // 确保 QQ_msg 已注册为 DSH workspace（Web UI 侧栏的「分组」）。Cordis 的
  // ctx.<服务> 需要 inject 声明才能访问；ctx.reflect.get(name) 是官方的免注入
  // 读服务方法，服务缺失时返回 undefined —— 自动回退 cwd 方式（不分组，不影响收发）。
  async function ensureQqMsgWorkspace() {
    if (qqWorkspaceValue !== null) return qqWorkspaceValue;
    const root = qqMsgRootSync();
    let id = null;
    try {
      const reg = (typeof ctx.reflect?.get === 'function') ? ctx.reflect.get('workspaceRegistry') : undefined;
      if (reg && typeof reg.resolveByPath === 'function' && typeof reg.create === 'function') {
        let ws = await reg.resolveByPath(root);
        if (ws === undefined || ws === null) ws = await reg.create(root, 'QQ 消息');
        id = (ws && typeof ws.id === 'string' && ws.id !== '') ? ws.id : null;
      }
    } catch (error) {
      console.error(TAG + ' 工作区分组不可用（回退 cwd 方式）：' + describeError(error));
    }
    qqWorkspaceValue = { id, path: root };
    return qqWorkspaceValue;
  }

  let uidCounter = 0;
  const uid = (prefix) => prefix + '-' + Date.now().toString(36) + '-'
    + (uidCounter++).toString(36) + '-' + Math.random().toString(36).slice(2, 8);

  const state = {
    connected: false, statusReason: '', restarts: 0, stopping: false,
    // 已排上但还没执行的重启：用来去重（避免两个定时器各起一个适配器）并支持取消。
    restartPending: false, restartCancel: null,
    adapterPid: null, listenPort: null,
    convos: new Map(),
      stats: { inbound: 0, accepted: 0, skipped: 0, duplicates: 0, replies: 0, chunks: 0, errors: 0, admin: 0, actions: 0, notices: 0, guestBlocked: 0, flowBlocked: 0 },
    // 入站去重（消息幂等）：重连/重投的同一条消息只起一个回合。
    msgIds: createMsgIdCache({ max: 512, ttlMs: 10 * 60 * 1000 }),
      // 动作请求/响应关联：{ echo -> resolve }
      pending: new Map(),
      actionSeq: 0,
  };

  // 兼容自检：读当前实际加载的 DSH 版本，启动日志与 qqbot status 都给出结论；
  // 不逐版本硬编码，支持范围只维护 lib/shared/compat.js 里的两个常量。
  state.dsh = compatibilityInfo();
  console.log(TAG + ' ' + describeCompatibility(state.dsh));
  state.proactive = { timer: null, groups: new Map(), selfId: null, warned: '', banner: '' };
  // ---------------------------------------------------- 流程授权状态（不跨会话共享）
  // promptIds: qq -> 机器人发出去那条授权提示的 message_id（通过后撤回它）
  // resume: 授权通过后要续跑的回合 { entry, frame }；active: 活动流程名（/flow use 切换）
  state.flow = { promptIds: new Map(), resume: null, active: '', recoveryUsed: new Set() };
  const flowAuditFile = join(qqMsgRootSync(), 'qqbot-flow-audit.jsonl');
  // 阀门按优先级成型：network(10) → security(20) → tool(30)。
  // 出网策略先就位，安全阀拿到配置与审计通道，工具阀再消费安全阀发出的授权；
  // 顺序由 assemble.js + valve/index.js 的 STAGE 表决定，这里不再自己排。
  const valves = assembleValves({
    config: () => CONFIG,
    audit: (line) => {
      console.log(TAG + ' 流程授权审计 ' + JSON.stringify(line));
      try {
        fsPromises.appendFile(flowAuditFile, JSON.stringify(line) + '\n', 'utf8').catch(() => {});
      } catch (error) { /* 审计写不进去不阻塞授权 */ }
    },
    flowRoot: join(qqMsgRootSync(), 'flows'),
    flowEnabled: () => flowEnabled(),
    gatedTools: () => ((CONFIG.flowAuth === undefined || CONFIG.flowAuth === null
      || !Array.isArray(CONFIG.flowAuth.gatedTools)) ? [] : CONFIG.flowAuth.gatedTools),
    proxy: () => ((CONFIG.webSearch === undefined || CONFIG.webSearch === null) ? '' : String(CONFIG.webSearch.proxy || '')),
    log: (line) => console.log(TAG + line),
  });
  console.log(TAG + ' ' + describeAssembly());
  const flowAuth = valves.security.flowAuth;
  const flowGate = /** @type {Record<string, any>} */ (valves.tool).gate;
  const flowStore = valves.security.flowStore;
  const flowAuthApi = {
    enabled: () => flowEnabled(),
    request: (purpose, entry, frame) => requestFlowAuth(purpose, entry, frame),
    status: () => flowAuth.status(),
    active: () => state.flow.active,
  };


  let nodePath = CONFIG.nodePath;
  if (nodePath === '') {
    nodePath = process.execPath;
    try { nodePath = await subprocess.resolveExecutable('node'); }
    catch (error) { console.log(TAG + ' 未能解析 node，改用 ' + nodePath); }
  }

  // 主动发言：实现搬到 gateway/proactive-surface.js（P3 2.4 第二阶段，只搬不改）。
  const proactive = createProactiveSurface({
    TAG,
    getConfig: () => CONFIG,
    getState: () => state,
    ctx,
    describeError,
    callAdapterAction: (action, params, timeoutMs) => callAdapterAction(action, params, timeoutMs),
    sessionApi: () => sessionApi,
    writeToAdapter: (frame) => writeToAdapter(frame),
  });
  const { scheduleProactive, stopProactive } = proactive;

  // 适配器监管：实现搬到 gateway/adapter-supervision.js（P3 2.4 第二阶段，只搬不改）。
  const adapterSupervision = createAdapterSupervision({
    TAG,
    getConfig: () => CONFIG,
    getState: () => state,
    ctx,
    describeError,
    nodePath,
    getAdapterPath: currentAdapterPath,
    spawn: subprocess.spawn,
    qqMsgRoot: qqMsgRootSync,
    onFrame: (frame) => onAdapterFrame(frame),
  });
  const { writeToAdapter, callAdapterAction, spawnAdapter, stopAdapter, scheduleRestart, cancelRestart } = adapterSupervision;

  // -------------------------------------------------------------- 入站帧
  function onAdapterFrame(frame) {
    if (frame === null || typeof frame !== 'object') return;
    if (CONFIG.logAdapterFrames) console.log(TAG + ' <- ' + JSON.stringify(frame));

    if (frame.type === 'hello') {
      state.adapterPid = frame.pid ?? null;
      console.log(TAG + ' 适配器就绪（pid ' + String(frame.pid) + '，' + String(frame.mode) + ' 模式）');
    } else if (frame.type === 'listening') {
      state.listenPort = frame.port ?? null;
      console.log(TAG + ' 反向 WS 监听中：' + String(frame.host) + ':' + String(frame.port));
    } else if (frame.type === 'status') {
      state.connected = frame.connected === true;
      if (state.connected === true) state.restarts = 0; // 连上了就把退避清零，下次抖动重新从 baseMs 起
      state.statusReason = typeof frame.reason === 'string' ? frame.reason : '';
      console.log(TAG + ' OneBot ' + (state.connected ? '已连接' : '未连接')
        + (state.statusReason === '' ? '' : '（' + state.statusReason + '）'));
    } else if (frame.type === 'message') {
      state.stats.inbound += 1;
      // 入口必须自己兜底：acceptMessage 里的 await（建会话、查群成员、下鉴权）
      // 只要抛一次就会变成 unhandled rejection，Node 24 会直接退进程（B1 同款坑）。
      void acceptMessage(frame).catch((error) => {
        state.stats.errors += 1;
        console.error(TAG + ' 处理消息失败：' + describeError(error));
      });
    } else if (frame.type === 'action_result') {
      state.stats.actions += 1;
      const waiter = state.pending.get(frame.echo);
      if (waiter !== undefined) { state.pending.delete(frame.echo); waiter(frame); }
    } else if (frame.type === 'notice') {
      state.stats.notices += 1;
    } else if (frame.type === 'send_result') {
      if (frame.ok === true) state.stats.chunks += 1;
      else { state.stats.errors += 1; console.error(TAG + ' 发送失败：' + String(frame.error)); }
    } else if (frame.type === 'log') {
      console.log(TAG + '/adapter ' + String(frame.text));
    } else if (frame.type === 'error') {
      console.error(TAG + '/adapter ' + String(frame.text));
    }
  }

  const allowlistOk = (allow, id) => {
    if (!Array.isArray(allow) || allow.length === 0) return true;
    for (const entry of allow) if (String(entry) === String(id)) return true;
    return false;
  };

  // ==================================================== 权限：三路并行 + 动态授权
  // 三路并行取并集（不是先命中先返回）：
  //   1. 静态名单：拥有者（全部权限 + 永久授权）、后台设定的高级管理员（群管理权限）
  //   2. 动态授权：**群维度**、可带时限，由拥有者或本群管理员授予，不可跨群生效
  //   3. 本群身份：get_group_member_info 查到 admin / owner
  // 拥有者另有一条「路由」特权：拥有者与非拥有者可以走不同的会话与 agent preset
  // （见 sessionRoute；不配 preset 就共用一条会话，行为与以前一致）。

  /** 查询被引用（回复）消息的发送者是否 bot 自己；查不到按非 bot 处理。 */
  async function isReplyToSelf(frame) {
    if (frame.reply_to === null || frame.reply_to === undefined) return false;
    const selfId = frame.self_id === null || frame.self_id === undefined ? null : String(frame.self_id);
    if (selfId === null) return false;
    try {
      const result = await callAdapterAction('get_msg', { message_id: idValue(frame.reply_to) }, 8000);
      if (result.ok === true && result.data !== null && result.data !== undefined
        && result.data.sender !== null && result.data.sender !== undefined
        && String(result.data.sender.user_id) === selfId) return true;
    } catch { /* 查不到按非 bot 处理 */ }
    return false;
  }

  // ============================================== 流程授权（私聊动态码）与会话续跑
  // 产品约定（按用户原话落地）：
  //   1. 授权只在私聊里、由主人本人发起和完成；群里叫不动它；
  //   2. 动态码是标准 TOTP（RFC 6238），插件不认万能码，也没有测试后门；
  //   3. 令牌消息在 acceptMessage 里前置拦截：不进模型、不落会话；验证通过后机器人
  //      撤回自己那条请求，并提醒主人撤回他发的码（QQ 只允许撤回自己的消息）；
  //   4. 授权一次一用，用完即弃；用完那一刻把被拦下的回合接着跑完。
  function flowEnabled() {
    return CONFIG.flowAuth !== undefined && CONFIG.flowAuth !== null && CONFIG.flowAuth.enabled === true;
  }

  // 没配拥有者只提示一次：默认装配下每条消息都会走到这里，逐条 warn 会把日志刷满。
  let ownerMissingWarned = false;
  function warnOwnerMissingOnce() {
    if (ownerMissingWarned === true) return;
    ownerMissingWarned = true;
    console.log(TAG + ' 警告：auth.owners 为空，插件不驱动任何会话（fail-closed）。请先在「设置 → QQ 机器人 → 拥有者 QQ 号」填上自己的 QQ 号。');
  }

  // 入站限制：实现搬到 gateway/inbound-limits.js（P3 2.4 第三阶段，只搬不改）。
  const inboundLimits = createInboundLimits({
    getConfig: () => CONFIG,
    sendReply: (frame, text) => sendReply(frame, text),
  });
  const { inboundPerMinute, inboundQueueMax, inboundMaxChars, takeTurnSlot, notifyThrottled } = inboundLimits;

  // 授权/流程：实现搬到 gateway/auth-flow.js（P3 2.4 第三阶段，只搬不改）。
  const authFlow = createAuthFlow({
    TAG,
    getConfig: () => CONFIG,
    getState: () => state,
    ctx,
    describeError,
    sendReply: (frame, text, quote) => sendReply(frame, text, quote),
    callAdapterAction: (action, params, timeoutMs) => callAdapterAction(action, params, timeoutMs),
    flowGate,
    writeToAdapter: (frame) => writeToAdapter(frame),
    flowEnabled,
    flowAuth,
    getDeliverFlowArtifacts: () => deliverFlowArtifacts,
    runTurn,
    flowStore,
  });
  const { ownerQq, sendPrivateText, recallMessage, requestFlowAuth, resumeAfterAuth, handleAuthMessage, handleFlowCommand, writeFlowAuthPatch } = authFlow;

  /** 列出会话工作区里本轮新增/改动的文件；跳过隐藏项（.git、.env 之类不进包）。 */
  async function listFreshFiles(root, sinceMs, limit, skipHidden) {
    const out = [];
    async function walk(dir, depth) {
      if (out.length >= limit || depth > 6) return;
      let items;
      try { items = await fsPromises.readdir(dir, { withFileTypes: true }); } catch (error) { return; }
      items.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      for (const item of items) {
        if (out.length >= limit) return;
        const name = String(item.name);
        if (skipHidden === true && name.startsWith('.')) continue;
        // 上一轮的产物包不参与本轮打包（否则每轮都会把旧 zip 再套一层）。
        if (name.indexOf('qqbot-artifacts-') === 0) continue;
        const full = join(dir, name);
        if (item.isDirectory()) { await walk(full, depth + 1); continue; }
        if (item.isFile() !== true) continue;
        try {
          const stat = await fsPromises.stat(full);
          if (stat.mtimeMs >= sinceMs) out.push({ path: full, size: stat.size });
        } catch (error) { /* 读不到就跳过 */ }
      }
    }
    await walk(root, 0);
    return out;
  }

  /** 异步跑一个打包命令：execFileSync 会把整个 DSH 事件循环停住（Web UI 和别的会话一起卡）。 */
  function runPacker(command, args, options) {
    return new Promise((resolve) => {
      const input = options.input;
      let child;
      try {
        child = spawn(command, args, {
          cwd: options.cwd,
          // zip -@ 从 stdin 读文件名列表：只有需要输入时才开 pipe。
          stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'],
        });
      } catch { resolve(false); return; }
      let done = false;
      const finish = (ok) => { if (done === true) return; done = true; resolve(ok); };
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已经退出 */ } finish(false); }, 120000);
      if (typeof timer.unref === 'function') timer.unref();
      child.on('error', () => { clearTimeout(timer); finish(false); });
      child.on('close', (code) => { clearTimeout(timer); finish(code === 0); });
      if (input !== undefined && child.stdin !== null && child.stdin !== undefined) {
        child.stdin.on('error', () => { /* 写入即失败时由 close/error 结算 */ });
        child.stdin.end(input);
      }
    });
  }

  async function packFlowFiles(dir, files) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    // 统一 ./ 前缀并丢掉含换行的名字：zip -@ 从 stdin 读文件名，裸的 -x / 带换行都可能被当成额外指令。
    const rel = artifactInputLines(files.map((file) => file.path.slice(dir.length + 1)));
    const zipPath = join(dir, 'qqbot-artifacts-' + stamp + '.zip');
    if (await runPacker('zip', ['-q', '-@', zipPath], { cwd: dir, input: rel.join('\n') + '\n' }) === true) return zipPath;
    const tarPath = join(dir, 'qqbot-artifacts-' + stamp + '.tar.gz');
    if (await runPacker('tar', ['-czf', tarPath].concat(rel), { cwd: dir }) === true) return tarPath;
    console.log(TAG + ' 打包产物失败：zip 与 tar 都不可用');
    return '';
  }

  /**
   * 产物只从会话自己的目录收。
   *
   * 不能用 agent 的 cwd / workspace.path：所有 QQ 会话共用同一个 QQ_msg 工作区根，
   * 按 mtime 从根往下扫会把别的会话的文件、审计日志一起打进包（评审在真实合并的树上实测过）。
   */
  function artifactDirs(entry) {
    // 优先用建会话时记下的真实目录（独立工作区模式下就是 QQ_msg/<原 id>，
    // 即使 entry.sessionId 后来被改成 scoped 也不会错位）；没有就退回按 id 拼。
    const dir = (entry.flowWorkdir !== undefined && entry.flowWorkdir !== null)
      ? String(entry.flowWorkdir)
      : sessionWorkdir(entry.sessionId);
    return [dir];
  }

  /** 被授权的工具跑完这一轮后，把新产物打包送出；没有产物就什么都不做。 */
  // 产物投递：实现搬到 gateway/flow-delivery.js（P3 2.4 第二阶段，只搬不改）。
  const flowDelivery = createFlowDelivery({
    TAG,
    getConfig: () => CONFIG,
    callAdapterAction: (action, params, timeoutMs) => callAdapterAction(action, params, timeoutMs),
    describeError,
    sendReply: (frame, text) => sendReply(frame, text),
    ownerQq: () => ownerQq(),
    artifactDirs,
    listFreshFiles,
    packFlowFiles,
  });
  const { deliverFlowArtifacts } = flowDelivery;


  // 同会话处理顺序锁：到达时同步占位，处理完（消息已挂上会话队列）再释放。
  // 不这样做的话，getEntry / 查群成员鉴权这些 await 谁先完成谁先入队，连发两条会反着执行。
  const orderChains = new Map();
  /** 顺序锁的兜底持有上限：调用方漏 release（异常路径）时也不能让这个会话永久哑掉。 */
  const ORDER_HOLD_TIMEOUT_MS = 120000;

  function acquireOrder(key) {
    const prev = orderChains.get(key);
    /** @type {(value?: any) => void} */
    let resolveGate = () => {};
    let released = false;
    const mine = new Promise((resolve) => { resolveGate = resolve; });
    const chained = (prev === undefined ? Promise.resolve() : prev).then(() => mine);
    orderChains.set(key, chained);
    // release 幂等 + 超时兜底：显式出口有好几处，但从这里到 acceptMessage 拿到锁之间还有
    // 未包的 await（resolveAuthority 会往适配器发动作），任何一处抛出都会漏掉释放，之后该会话
    // 的每条消息都卡在 prev 上永不入队（表现是「一个人突然不说话了」）。
    const timer = setTimeout(() => {
      console.error(TAG + ' 顺序锁超过 ' + ORDER_HOLD_TIMEOUT_MS + 'ms 未释放，强制放行（' + key + '）');
      release();
    }, ORDER_HOLD_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    function release() {
      if (released === true) return;
      released = true;
      clearTimeout(timer);
      resolveGate();
      if (orderChains.get(key) === chained) orderChains.delete(key);
    }
    return release;
  }

  async function acceptMessage(frame) {
    // 去重放在最前面：走完准入再判重，重投消息会先被计入 skipped 并可能触发回复提示。
    const frameId = (frame.message_id === undefined || frame.message_id === null) ? '' : String(frame.message_id).trim();
    if (frameId !== '' && state.msgIds.hit(frameId) === true) {
      state.stats.skipped += 1;
      state.stats.duplicates += 1;
      return;
    }
    const isGroup = frame.message_type === 'group';
    const policy = isGroup ? CONFIG.group : CONFIG.private;
    const chatId = isGroup ? frame.group_id : frame.user_id;

    if (policy.enabled !== true) { state.stats.skipped += 1; return; }
    const selfId = frame.self_id === null || frame.self_id === undefined ? null : String(frame.self_id);
    if (selfId !== null && String(frame.user_id) === selfId) { state.stats.skipped += 1; return; }

    // 默认准入是 fail-closed（#27）：没有拥有者就**不驱动任何会话**。
    // 以前 owners 为空只是「没人有额外权限」，而白名单为空又表示「不限」，于是装好即对外开放——
    // 任何人私聊或在群里 @ 一下就能消耗拥有者的额度，并把插件当成打内网/搜网页的跳板。
    if (ownerQq() === '') {
      state.stats.skipped += 1;
      warnOwnerMissingOnce();
      // 只在私聊里回配置指引：群里回一句就等于把配置口暴露给所有人看，还容易被当成噪声。
      if (isGroup !== true) {
        sendReply(frame, '还没配置拥有者，我不会驱动会话。请到「DSH 设置 → QQ 机器人 → 拥有者 QQ 号」填上你自己的 QQ 号后重试。');
      }
      return;
    }

    // 白名单必须排在**所有**处理之前（2026-10-28 审计 A2）。
    // 以前它排在群管理指令和 /model 之后，于是 group.allow 收紧到单群之后，
    // 其它群里的 /help、/whoami 仍然会拿到回复——白名单实际只挡住了「进 Agent 回合」，
    // 没挡住「在群里说话」。默认准入是 fail-closed，这里也照同一个口径。
    if (!allowlistOk(policy.allow, chatId)) { state.stats.skipped += 1; return; }

    // 群管理指令优先：不要求 @ 机器人，也不会送给模型。
    if (isGroup) {
      const handled = await adminApi.handleAdminCommand(frame, typeof frame.text === 'string' ? frame.text : '');
      if (handled === true) return;
    }
    // /model：模型查看与切换（拥有者专用）。
    // 群里被 @ 时文本前面会带 "@qq "，指令前也可能有空格——统一交给 parseModelCommand 剥。
    if (adminApi.isOwner(frame.user_id) === true) {
      const parsedModel = parseModelCommand(stripInvisible(frame.text), String(CONFIG.admin.prefix || '/'));
      if (parsedModel !== null) {
        const chatKey = isGroup === true ? 'g' + String(frame.group_id) : 'p' + String(frame.user_id);
        sendReply(frame, await handleModelCommand(parsedModel.rest, chatKey), true);
        return;
      }
    }
    // 私聊二次授权：/auth 动态码 + /flow 流程脚本管理。只认「拥有者 + 私聊 + 消息首位」，
    // 命中即在此结束：不进 Agent 回合，动态码不落会话（不会被历史或日志带出去）。
    const flowInterceptOn = CONFIG.flowAuth !== undefined && CONFIG.flowAuth !== null && CONFIG.flowAuth.enabled === true;
    // 判定与解析必须用同一份文本：只剥一次，否则零宽串会被「拦下来但解析失败」，消息人间蒸发。
    const flowText = stripInvisible(frame.text);
    const flowKind = flowInterceptOn === true
      ? flowInterceptKind({ isGroup, isOwner: adminApi.isOwner(frame.user_id), text: flowText })
      : null;
    if (flowKind === 'auth') { await handleAuthMessage(frame, flowText); return; }
    if (flowKind === 'flow') { await handleFlowCommand(frame, flowText); return; }


    let text = typeof frame.text === 'string' ? frame.text : '';

    // 命令前缀（如 /ai）：命中视同点名（bot 被调用），豁免 requireAt；
    // 与群管理指令同理，也走「QQ 回复消息流程」引用回复。
    let prefixHit = false;
    if (CONFIG.commandPrefix !== '') {
      if (!text.startsWith(CONFIG.commandPrefix)) { state.stats.skipped += 1; return; }
      text = text.slice(CONFIG.commandPrefix.length).trim();
      prefixHit = true;
    }

    // 被回复（引用）了 bot 消息：视同 @ 处理（群聊 + 开关开启时）。
    // 查询被引用消息的发送者是否 bot 自己；查不到按非 bot 处理。
    // 前缀指令已豁免 @，无需再查。
    let repliedToBot = false;
    // 只要开关开启且消息带了被引用消息，就查发送者是否 bot 自己；
    // 不依赖 requireAt——requireAt 关闭（群=全部）时回复了 bot 同样要识别并引用回复。
    if (!prefixHit && isGroup && CONFIG.reply.botReply === true
      && frame.reply_to !== null && frame.reply_to !== undefined) {
      repliedToBot = await isReplyToSelf(frame);
    }

    // bot 是否被点名（@ 了 bot / 回复了 bot / 前缀指令）：被点名才用「QQ 回复消息流程」引用回复。
    let botMentioned = repliedToBot || prefixHit;
    let mentionHit = false;
    if (isGroup && policy.requireAt === true && !prefixHit) {
      // 判定只认「at 段」，不认正文（2026-10-28 审计 A1）：
      //   1) 用户在正文里手打 '@机器人QQ' 会命中旧的 includes 判定，requireAt 形同虚设；
      //   2) '@10001' 是 '@100012' 的前缀，正常 @ 别人会被误判成 @ 了我，
      //      而旧代码 split('@10001').join(' ') 剥前缀时还会把对方 QQ 号咬掉一位。
      // 适配器都带 frame.mentions；自定义适配器没给时退化成「@数字 + 数字边界」的保守匹配，
      // 宁可漏判（要求 @）也不误判（把别人的 @ 算成我的）。
      const mentions = Array.isArray(frame.mentions) ? frame.mentions.map((qq) => String(qq)) : null;
      const mention = selfId === null ? null : '@' + selfId;
      const mentionPattern = mention === null ? null : mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?!\\d)';
      const atMe = (mentions !== null && selfId !== null)
        ? mentions.includes(selfId)
        : (mentionPattern === null ? text.includes('@') : new RegExp(mentionPattern).test(text));
      if (atMe === true) {
        if (mentionPattern !== null) text = text.replace(new RegExp(mentionPattern, 'g'), ' ').trim();
        botMentioned = true;
        mentionHit = true;
      } else if (!repliedToBot) { state.stats.skipped += 1; return; }
    }

    // 例外：回复了 bot 但正文 @ 的是别人（剥离 @bot 后仍有 @）——
    // 这条可能不是对 bot 说的，不强制引用回复，交给 bot 自行判断是否继续回复。
    if (repliedToBot && !mentionHit && /@/.test(text)) botMentioned = false;

    // 不再主动拉取聊天上下文塞进会话（fetchReplyContext/replyTargetQQs 已移除）：
    // 需要群内近期消息/图片时，由 AI 主动调 qq_history 工具自取。
    // 只保留「被回复消息的图片」收集，供 describeImages 一并识别（回复引用流程不受影响）。
    if (frame.reply_to !== null && frame.reply_to !== undefined
      && (repliedToBot || mentionHit)) {
      try { await sessionApi.collectReplyImageUrls(frame); }
      catch (error) { console.log(TAG + ' 收集被回复图片失败（忽略）：' + describeError(error)); }
    }

    // 无正文：bot 被点名（@ / 回复 bot / 命令前缀）时也给一个占位正文让它回应（如纯回复/纯 @）；
    // 否则（普通空消息）照旧跳过。
    if (text === '' && !(typeof frame.images === 'number' && frame.images > 0)) {
      if (!botMentioned) { state.stats.skipped += 1; return; }
      text = '（本条消息无正文，仅点名了 bot）';
    }
    // 单条长度上限（#22）：超长正文不进提示词，否则一条几百 KB 的消息就能顶掉整轮上下文。
    const inboundCap = inboundMaxChars();
    if (text.length > inboundCap) {
      text = text.slice(0, inboundCap) + '\n…（消息过长，已截断：原文 ' + text.length + ' 字，只处理前 ' + inboundCap + ' 字）';
    }
    state.stats.accepted += 1;

    // 入口路由：按「拥有者 / 非拥有者」决定走哪条会话与 preset；
    // 两个 preset 都不配就共用一条会话（行为与以前一致）。
    const route = sessionApi.sessionRoute(frame);
    const entryKey = CONFIG.perChatSession ? route.entryKey : 'shared';
    const sessionId = CONFIG.perChatSession ? route.sessionId : 'qqbot-shared';
    const preset = CONFIG.perChatSession ? route.preset : CONFIG.agentPreset;

    const fixedTitle = (CONFIG.session !== null && CONFIG.session !== undefined && CONFIG.session.fixedName === true)
      ? (frame.message_type === 'group' ? '群聊_' : '私聊_') + String(frame.message_type === 'group' ? frame.group_id : frame.user_id)
      : null;
    // 从这里开始的处理必须按到达顺序进行（建会话、查群成员鉴权都是 await）。
    const releaseOrder = acquireOrder(entryKey);
    let entry;
    try { entry = await sessionApi.getEntry(entryKey, sessionId, preset, fixedTitle); }
    catch (error) {
      state.stats.errors += 1;
      console.error(TAG + ' 为 ' + entryKey + ' 建会话失败：' + describeError(error));
      sendReply(frame, '（内部错误：无法创建对话会话）');
      releaseOrder();
      return;
    }

    // 记录本条消息的说话人与身份：qqgroup 工具的鉴权依据（三路并行）。
    const speakerAuthority = await adminApi.resolveAuthority(frame.user_id, isGroup ? chatId : null);
    entry.groupId = isGroup ? String(chatId) : null;
    // 记录本条触发消息，qq_history 工具以此锚定图片识别窗口（最新提及）。
    entry.currentFrame = frame;
    entry.speaker = {
      userId: String(frame.user_id),
      groupId: entry.groupId,
      tier: speakerAuthority.tier,
      owner: speakerAuthority.owner === true,
      sources: speakerAuthority.sources,
    };

    // 本回合是否允许使用 DSH 内部工具：只有拥有者（或显式放开 guestDshTools）才行。
    const allowDsh = speakerAuthority.owner === true || CONFIG.auth.guestDshTools === true;

    // 入站限流（#22）：同一个人在同一会话里每分钟最多驱动 N 个回合。
    // 必须等「这条消息确定会驱动回合」之后再计费：放在入口处会把群里的闲聊、
    // 图片消息和没点名的消息全算进去，活跃群里几十条闲聊就能把额度刷光，
    // 之后真正的 @ 反而被静默丢掉（群里不回复，只加 skipped 计数）。
    if (takeTurnSlot((isGroup === true ? 'g' : 'p') + String(chatId) + ':' + String(frame.user_id)) !== true) {
      state.stats.skipped += 1;
      notifyThrottled(frame, isGroup);
      releaseOrder();
      return;
    }

    const generation = entry.generation;
    // 入队时就把发言人钉住：排队期间新消息不会改动这一回合的身份判定。
    const turnSpeaker = { userId: String(frame.user_id), groupId: entry.groupId, tier: speakerAuthority.tier, owner: speakerAuthority.owner === true, sources: speakerAuthority.sources };
    // 队列深度上限（#22）：排太多就直接拒收，不让消息无限堆在内存里（每条都要跑一个完整回合）。
    const queueMax = inboundQueueMax();
    const pendingTurns = Number(entry.pendingTurns === undefined ? 0 : entry.pendingTurns) + 1;
    if (pendingTurns > queueMax) {
      state.stats.skipped += 1;
      sendReply(frame, '（这条先不处理：同一会话排队的回合太多了，等前面的回答完再发）');
      releaseOrder();
      return;
    }
    entry.pendingTurns = pendingTurns;
    entry.queue = entry.queue
      .then(() => runTurn(entry, frame, text, generation, allowDsh, botMentioned, turnSpeaker))
      .then(() => deliverFlowArtifacts(entry, frame))
      .catch((error) => {
        state.stats.errors += 1;
        console.error(TAG + ' ' + entryKey + ' 回合失败：' + describeError(error));
      })
      .then(() => { entry.pendingTurns = Math.max(0, Number(entry.pendingTurns || 1) - 1); });
    // 已挂上会话队列：顺序由 entry.queue 保证，这里释放顺序锁。
    releaseOrder();
  }

  /**
   * 识别 QQ 消息里的图片：下载图片，用 DSH 已配置的视觉模型（从自定义 providers
   * 里选，协议/baseURL/apiKey 全部沿用 DSH 原本填写的）做图片理解，返回识别文本。
   * 返回 { error, text }：error 非空 = 不应继续（可读报错提示）；text 非空 = 识别结果。
   */
  async function describeImages(frame, entry) {
    const vision = CONFIG.vision || {};
    if (vision.enabled !== true) return { error: '', text: '' };
    const urls = [
      ...(Array.isArray(frame.image_urls) ? frame.image_urls : []),
      ...(Array.isArray(frame.replyImageUrls) ? frame.replyImageUrls : []),
    ];
    if (urls.length === 0) return { error: '', text: '' };
    const attachments = ctx.attachments;
    if (attachments === undefined || attachments === null || typeof attachments.saveImage !== 'function') {
      return { error: '（图片视觉已开启，但附件服务不可用，请检查 DSH 的 attachments 插件是否启用）', text: '' };
    }
    // 解析视觉模型：显式配置优先（用户从 DSH 自定义 providers 里选），否则用会话当前模型
    const provider = (typeof vision.provider === 'string' && vision.provider !== '') ? vision.provider
      : (entry && entry.agent && entry.agent.options && typeof entry.agent.options.provider === 'string'
        ? entry.agent.options.provider : '');
    const model = (typeof vision.model === 'string' && vision.model !== '') ? vision.model
      : (entry && entry.agent && entry.agent.options && typeof entry.agent.options.model === 'string'
        ? entry.agent.options.model : '');
    if (provider === '' || model === '') {
      return { error: '（图片视觉：未能确定视觉模型。请到「设置 → QQ 机器人 → 图片视觉」里填写 provider 与 model，例如你的自定义 provider / deepseek-v4-flash-vision-exp）', text: '' };
    }
    // 模型不支持图片时给可读报错（仅当能力明确可知；未知则放行交给请求本身判断）
    if (typeof ctx.llm === 'object' && ctx.llm !== null && typeof ctx.llm.resolveModelInfo === 'function') {
      try {
        const info = await ctx.llm.resolveModelInfo(provider, model);
        const modalities = (info && Array.isArray(info.inputModalities)) ? info.inputModalities : null;
        if (modalities !== null && !modalities.includes('image')) {
          return { error: '（当前视觉模型 ' + provider + '/' + model + ' 不支持图片识别。'
            + '请到「设置 → QQ 机器人 → 图片视觉」切换支持图片的模型，例如 deepseek-v4-flash-vision-exp 或 deepseek-v4.1-flash-request）', text: '' };
        }
      } catch (error) {
        console.log(TAG + ' 视觉能力探测失败（放行，交给请求本身）：' + describeError(error));
      }
    }
    const max = Math.max(1, Math.min(vision.maxImages ?? 3, urls.length));
    const timeoutMs = vision.downloadTimeoutMs ?? 10000;
    const descriptions = [];
    const savedPaths = [];
    // 缓存图片导出：把原图写入 <QQ_msg>/qq-images/<会话id>/（留档用，识图由视觉模型完成）；
    // 会话结算（本轮回复完成后）会整体删除该缓存目录，见 runTurn 收尾。
    const imgRoot = imageCacheDir(entry ? entry.sessionId : 'default');
    for (let i = 0; i < max; i += 1) {
      const url = urls[i];
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) continue;
      try {
        const downloaded = await downloadImage(url, timeoutMs);
        if (downloaded === null) continue;
        const ref = await attachments.saveImage({ data: downloaded.data, mediaType: downloaded.mediaType });
        const text = await askVision(provider, model, ref, i + 1);
        if (text !== '') descriptions.push(text);
        // 导出原图到工作目录（会话 id 区分），随消息附上路径
        try {
          const ext = downloaded.mediaType === 'image/png' ? 'png'
            : downloaded.mediaType === 'image/webp' ? 'webp'
              : downloaded.mediaType === 'image/gif' ? 'gif' : 'jpg';
          const abs = join(imgRoot, 'qq-' + Date.now() + '-' + i + '.' + ext);
          await fsPromises.mkdir(imgRoot, { recursive: true });
          await fsPromises.writeFile(abs, downloaded.data);
          savedPaths.push(abs);
        } catch (saveErr) {
          console.log(TAG + ' 图片导出失败（不影响识别）：' + describeError(saveErr));
        }
      } catch (error) {
        console.log(TAG + ' 图片识别失败（跳过）：' + describeError(error));
      }
    }
    if (descriptions.length === 0) {
      // paths 必须一起返回：调用方据此清理已落盘的原图。以前这里丢掉 savedPaths，
      // 于是「识别全失败」这一支写进用户文档目录的图再没人知道，永远删不掉。
      return { error: '（图片视觉：图片下载或识别失败，请稍后重试）', text: '', paths: savedPaths };
    }
    return { error: '', text: descriptions.join('\n'), paths: savedPaths };
  }

  /** 下载一张 http(s) 图片，返回 { data: Uint8Array, mediaType } 或 null。 */
  async function downloadImage(url, timeoutMs) {
    // 走 publicFetch：公网校验 + 地址钉死 + 逐跳校验 + 8MB 上限。
    // 图片 URL 来自消息里的 CQ 码（[CQ:image,url=...]）或协议端帧，属外部输入，
    // 以前这里直接 fetch 且 arrayBuffer 整包读入——一条消息就能打内网或撑爆内存。
    try {
      const res = await publicFetch(url, { binary: true, timeoutMs, maxBytes: 8 * 1024 * 1024 });
      if (res.status < 200 || res.status >= 300) return null;
      const ct = String(res.contentType === undefined || res.contentType === null ? '' : res.contentType).split(';')[0].trim().toLowerCase();
      let mediaType = null;
      if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(ct)) mediaType = ct;
      else if (ct === '') {
        mediaType = /\.png$/i.test(url) ? 'image/png'
          : /\.webp$/i.test(url) ? 'image/webp'
            : /\.gif$/i.test(url) ? 'image/gif' : 'image/jpeg';
      } else {
        return null;
      }
      const bytes = new Uint8Array(/** @type {any} */ (res.body));
      if (bytes.length === 0) return null;
      return { data: bytes, mediaType };
    } catch {
      return null;
    }
  }

  /** 用 DSH 的 llm 服务（走已注册的 provider 适配器）对一张图片做识别，返回识别文本。 */
  async function askVision(provider, model, ref, index) {
    const llm = ctx.llm;
    if (llm === undefined || llm === null || typeof llm.stream !== 'function') return '';
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: '这是用户发来的第 ' + index + ' 张图片。请用简体中文描述这张图片的内容，要具体、可读，不要猜测没有出现的信息。' },
        { type: 'image', attachment: ref },
      ],
    }];
    let out = '';
    try {
      for await (const chunk of llm.stream({ provider, model, messages, maxTokens: 512 })) {
        if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text;
      }
    } catch (error) {
      console.log(TAG + ' 视觉请求失败（' + provider + '/' + model + ' 第' + index + '张）：' + describeError(error));
      return '';
    }
    if (out.trim() === '') {
      console.log(TAG + ' 视觉请求空返回（' + provider + '/' + model + ' 第' + index + '张图，流式结束无文本）');
    }
    return out.trim();
  }

  /** 昵称/群名片 → 一行安全文本（去 \r\n 与方括号、压空白、限长）。 */
  function buildPrompt(frame, text, entry) {
    const sender = frame.sender;
    // 昵称/群名片是外部输入，进提示词前必须清洗：换行与方括号能让访客伪造出第二行身份头。
    const who = sanitizeDisplayName(sender === null || sender === undefined ? '' : (sender.card || sender.nickname));
    const body = text === '' ? '（发来了一张图片）' : text;
    if (CONFIG.reply.contextHeader !== true) return body;
    const where = frame.message_type === 'group' ? 'QQ群 ' + String(frame.group_id) : 'QQ私聊';
    // 把说话人身份带给 Agent：非拥有者的请求是否该执行，由 Agent 结合权限判断。
    let tag = '';
    // 身份标签同样读本回合的快照：排队串台时 entry.speaker 可能已经是别人的了。
    const speakerSnap = (entry !== null && entry !== undefined)
      ? ((entry.turnSpeaker !== undefined && entry.turnSpeaker !== null) ? entry.turnSpeaker : entry.speaker)
      : null;
    if (speakerSnap !== null && speakerSnap !== undefined) {
      const tier = adminApi.TIER_LABEL[speakerSnap.tier] === undefined ? speakerSnap.tier : adminApi.TIER_LABEL[speakerSnap.tier];
      const src = Array.isArray(speakerSnap.sources) && speakerSnap.sources.length > 0 ? '｜' + speakerSnap.sources.join('+') : '';
      tag = ' · 身份:' + tier + src;
    }
    let head = '[' + where + ' · ' + who + '(' + String(frame.user_id) + ')' + tag + ']';
    return head + ' ' + body;
  }

  /**
   * 中间发言循环：每过一会儿看一眼会话日志，把「说完但后面还有内容」的 assistant 段落发一条。
   * 最后一条 assistant 消息不在这里发（那是最终结算的正文），所以不会出现「先说一遍再正式回一遍」。
   * 返回停止函数；回合结束（whenIdle）时务必调用，否则会继续说下去。
   */
  function startInterimLoop(entry, frame, afterId, onInterim) {
    const conf = CONFIG.reply || {};
    const maxPerTurn = Math.max(0, Math.floor(Number(conf.interimMaxPerTurn) || 0));
    if (conf.interim !== true || maxPerTurn === 0) return () => {};
    const gapMs = Math.max(500, Math.floor(Number(conf.interimMinGapMs) || 2500));
    const spoken = new Set();
    let sent = 0;
    let stopped = false;
    let cancel = null;
    const schedule = () => {
      if (stopped === true || sent >= maxPerTurn) return;
      try { cancel = ctx.timeout(tick, gapMs); } catch (error) { cancel = null; }
    };
    const tick = () => {
      cancel = null;
      if (stopped === true) return;
      const agent = entry.agent;
      const session = (agent === null || agent === undefined) ? null : agent.session;
      if (session === null || session === undefined || typeof session.deriveMessages !== 'function') { schedule(); return; }
      let messages = [];
      try { messages = session.deriveMessages(); } catch (error) { messages = []; }
      const picks = pickInterim(messages, afterId);
      for (const item of picks) {
        // 这里的 sent < maxPerTurn 由 schedule() 保证，不需要再判一次。
        if (spoken.has(item.id)) continue;
        spoken.add(item.id);
        sent += 1;
        // 不传 withQuote：中间发言不引用、也不 @ 任何人。
        // 流式模式下（官方 v2 私聊）交给桥累积，不单独再发一条。
        if (typeof onInterim === 'function') onInterim(item.text);
        else sendReply(frame, item.text);
        console.log(TAG + ' 中间发言（' + String(item.text.length) + ' 字）：' + item.text.slice(0, 40).replace(/\s+/g, ' '));
        break;      // 一次最多发一条，间隔交给下一轮定时器
      }
      schedule();
    };
    schedule();
    return () => {
      stopped = true;
      if (typeof cancel === 'function') { try { cancel(); } catch (error) { /* 已经触发过了 */ } }
    };
  }

  async function runTurn(entry, frame, text, generation, allowDsh, quoteReply, turnSpeaker) {
    // 发言人快照：排队期间的其它消息会覆盖 entry.speaker，闸门必须看本回合的。
    if (turnSpeaker !== undefined && turnSpeaker !== null) entry.turnSpeaker = turnSpeaker;
    // 上一轮可能留下没被消费的「已付码」记账（例如守卫放行后工具自己没跑成），新回合一律清空。
    entry.flowAllow = undefined;
    if (entry.generation !== generation) return;   // 已被 interrupt 作废

    // 必须在串行回合内部设置：如果在接收入口设，排队的两条消息（先拥有者后访客）
    // 会互相覆盖，导致后一个回合用错权限。
    entry.dshAllowed = allowDsh === true;
    if (entry.guardUnavailable === true && allowDsh !== true) {
      sendReply(frame, '（本会话无法安装工具隔离，已拒绝这次驱动）');
      return;
    }

    entry.turns += 1;

    const body = buildPrompt(frame, text, entry);
    // 人格（persona）与首轮提示都只在会话第一轮追加一次：零额外 token。
    const firstHints = [];
    const personaHint = buildPersonaHint(CONFIG.persona);
    if (personaHint !== '') firstHints.push(personaHint);
    if (CONFIG.reply.firstTurnHint !== '') firstHints.push(CONFIG.reply.firstTurnHint);
    const userText = entry.turns === 1 && firstHints.length > 0
      ? body + '\n\n' + firstHints.join('\n\n')
      : body;

    const content = [{ type: 'text', text: userText }];
    const vision = await describeImages(frame, entry);
    if (vision.error !== '') {
      // 模型不支持图片 / 图片下载失败：给用户可读报错，引导去插件设置切换模型
      sendReply(frame, vision.error);
      return;
    }
    if (vision.text !== '') {
      // 把视觉识别结果并入用户消息，让 Agent 依据图片内容作答
      // 本条消息带图片：随附导出的原图路径（留档），并提示 Agent 结合用户发言作答、
      // 需确认身份时联网查证。图片仅用于本次会话，结算后自动删除。
      const imgPaths = Array.isArray(vision.paths) && vision.paths.length > 0
        ? '\n\n[图片文件] ' + vision.paths.join('\n')
        : '';
      content[0] = { type: 'text', text: userText + '\n\n[图片识别] ' + vision.text + imgPaths
        + '\n\n（本条消息含图片。请结合用户发言作答；自行提炼关键词调用qq_websearch qq_imgsearch进行查找（漫画用 kind=comic），尽量勿凭空猜测。）' };
    }
    const message = {
      id: uid('qqmsg'),
      role: 'user',
      content,
      source: { kind: 'user' },
    };

    let acked = false;
    let cancelAck = null;
    if (CONFIG.reply.ackAfterMs > 0 && CONFIG.reply.ackText !== '') {
      try {
        cancelAck = ctx.timeout(() => { acked = true; sendReply(frame, CONFIG.reply.ackText); }, CONFIG.reply.ackAfterMs);
      } catch { /* 定时器不可用就跳过 */ }
    }

    // 流式：只有「官方 v2 + 私聊 + 有被动回复 msg_id + 开关打开」才走；其它协议保持原来的分段回复。
    const streamOn = shouldStream({
      protocol: CONFIG.protocol,
      streaming: CONFIG.protocols.qqOfficial !== undefined && CONFIG.protocols.qqOfficial !== null && CONFIG.protocols.qqOfficial.streaming === true,
      isGroup: frame.message_type === 'group',
      messageId: frame.message_id,
    });
    const streamKey = streamOn === true ? ('o:' + String(frame.user_id) + ':' + String(frame.message_id)) : null;
    let streamedText = '';
    const onInterim = streamKey === null ? null : (fragment) => {
      streamedText += String(fragment);
      streamBridge.push(streamKey, null, String(fragment));
    };
    if (streamKey !== null) {
      streamBridge.push(streamKey, { messageType: 'private', targetId: String(frame.user_id), msgId: String(frame.message_id) }, '');
    }
    // 中间发言：回合没跑完时，模型先说的那几句单独发出去（不引用、不 @）。
    const stopInterim = startInterimLoop(entry, frame, message.id, onInterim);
    try {
      entry.agent.followup(message);
      await entry.agent.whenIdle();
    } finally {
      stopInterim();
      if (typeof cancelAck === 'function') cancelAck();
    }

    const reply = extractReply(entry.agent, message.id);
    if (reply === '') {
      // 失败提示总是作为正式回复发出（即使 ack 已发过「正在处理」也不吞掉结论）
      sendReply(frame, '（本轮没有产生文字回复：' + lastTurnReason(entry.agent) + '）');
      // 这一支以前直接 return，跳过了下面的缓存清理：失败的回合一定留图。
      await cleanupImageCache(entry);
      return;
    }
    if (streamKey !== null) {
      // 最后一帧用 done 收尾：把中间没发到的剩余文本补进去（官方流式是全量替换）。
      const rest = streamedText !== '' && reply.startsWith(streamedText) ? reply.slice(streamedText.length) : (streamedText === '' ? reply : reply);
      if (rest !== '') streamBridge.push(streamKey, null, rest);
      const ended = await streamBridge.end(streamKey);
      if (ended === null || ended.ok !== true) {
        // 桥没发出任何帧（例如官方接口拒绝）：退化为普通发送，保证用户至少拿到一条。
        sendReply(frame, reply, quoteReply === true);
      }
    } else {
      sendReply(frame, reply, quoteReply === true);
    }
    state.stats.replies += 1;

    // 会话结算：删除本会话缓存的图片目录（<QQ_msg>/qq-images/<会话id>/），
    // 图片仅用于本轮识图与联网查证，结算后不留残留；会话与工作区保留。
    await cleanupImageCache(entry);
  }

  /**
   * 删掉本会话的图片缓存目录。异常/中断的回合走不到这里，靠启动后的定期 sweep 兜底
   * （见 sweepStaleImages），这里只负责「正常收尾时立刻清掉」。
   */
  async function cleanupImageCache(entry) {
    const imgRoot = imageCacheDir(entry !== null && entry !== undefined && entry.sessionId ? entry.sessionId : 'default');
    try {
      // 路径已由 safeSessionId 净化；删除前再复核一次归属，绝不递归删 QQ_msg 之外的东西。
      if (isInside(join(qqMsgRootSync(), 'qq-images'), imgRoot) !== true) {
        console.log(TAG + ' 图片缓存目录越界，拒绝删除：' + imgRoot);
        return;
      }
      await fsPromises.rm(imgRoot, { recursive: true, force: true });
    } catch (cleanErr) {
      console.log(TAG + ' 图片缓存清理失败：' + describeError(cleanErr));
    }
  }

  const IMAGE_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
  const IMAGE_SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

  /**
   * 图片缓存的兜底收尸：回合抛异常、被取消、或者 qq_draw 的 gen 目录，都不会走
   * cleanupImageCache。这里按 mtime 清掉 24 小时以上的东西——正常回合结束就删了，
   * 剩下的按定义都是漏网的。只动 <QQ_msg>/qq-images 之下，不做递归越界。
   */
  async function sweepStaleImages() {
    const root = join(qqMsgRootSync(), 'qq-images');
    const now = Date.now();
    let entries;
    try { entries = await fsPromises.readdir(root, { withFileTypes: true }); } catch { return; }
    let removed = 0;
    for (const ent of entries) {
      const abs = join(root, ent.name);
      try {
        const st = await fsPromises.stat(abs);
        if (now - st.mtimeMs <= IMAGE_SWEEP_MAX_AGE_MS) continue;
        if (ent.isDirectory()) await fsPromises.rm(abs, { recursive: true, force: true });
        else await fsPromises.rm(abs, { force: true });
        removed += 1;
      } catch { /* 正在被写真删不掉，下一轮再说 */ }
    }
    if (removed > 0) console.log(TAG + ' 清理过期图片缓存 ' + removed + ' 项');
  }

  function scheduleImageSweep() {
    const tick = () => {
      void sweepStaleImages().catch((error) => {
        console.log(TAG + ' 图片缓存清理失败：' + describeError(error));
      });
      try { ctx.timeout(tick, IMAGE_SWEEP_INTERVAL_MS); } catch { /* 插件已卸载 */ }
    };
    try { ctx.timeout(tick, 8000); } catch { /* 定时器不可用就跳过 */ }
  }

  /** 只取 afterId（本条用户消息 id）之后新增的 assistant 文本；本轮无回复返回 ''，绝不回退重发上一轮内容 */
  function extractReply(agent, afterId) {
    const session = (agent === null || agent === undefined) ? null : agent.session;
    if (session === null || session === undefined || typeof session.deriveMessages !== 'function') return '';
    const messages = session.deriveMessages();
    if (!Array.isArray(messages)) return '';
    let start = 0;
    if (afterId !== undefined && afterId !== null) {
      const at = messages.findIndex((m) => m !== null && typeof m === 'object' && m.id === afterId);
      if (at < 0) return '';      // 锚点不在日志里：宁可不回，也不回退到上一轮内容
      start = at + 1;
    }
    for (let index = messages.length - 1; index >= start; index -= 1) {
      const message = messages[index];
      if (message === null || typeof message !== 'object' || message.role !== 'assistant') continue;
      if (!Array.isArray(message.content)) continue;
      let text = '';
      for (const block of message.content) {
        if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') text += block.text;
      }
      if (text.trim() !== '') return text.trim();
    }
    return '';
  }

  /** 把 turn/end reason 清洗成一句话：只保留失败号（400/503/429…），隐藏 request id 等敏感内容 */
  function lastTurnReason(agent) {
    try {
      const session = agent.session;
      const events = session.snapshotEvents(0, session.seq);
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index].type === 'turn/end') return summarizeTurnReason(events[index].data.reason);
      }
      return '本回合未结束（' + String(events.length) + ' 个事件）';
    } catch (error) {
      return '读取日志失败：' + describeError(error);
    }
  }

  /** 协议 id 归一：纯数字转 number，其余（qq-official 的 ROBOT1.0_… 之类）原样保留字符串。 */
  /**
   * 发回复。withQuote=true 且是群聊时，用「QQ 回复消息流程」（引用触发消息）。
   * 注意：引用回复只在 bot 被点名（@ 了 bot 或回复了 bot）的响应上用；
   * 若对每条群消息都引用，requireAt 关闭时就会每条消息都引用回复。
   */
  function sendReply(frame, text, withQuote) {
    const target = frame.message_type === 'group' ? frame.group_id : frame.user_id;
    if (target === null || target === undefined) return;
    const replyTo = (withQuote === true && frame.message_type === 'group'
      && frame.message_id !== null && frame.message_id !== undefined)
      ? idValue(frame.message_id) : undefined;
    for (const chunk of chunkMarkdown(String(text), CONFIG.reply.maxChars)) {
      writeToAdapter({
        type: 'send',
        message_type: frame.message_type === 'group' ? 'group' : 'private',
        target_id: String(target),
        text: chunk,
        ...(replyTo !== undefined ? { reply_to: replyTo } : {}),
      });
    }
  }

  // 业务模块装配：权限/指令（admin）、会话（session）、动态工具（tools）都从独立模块工厂取。
  // 依赖经工厂注入（CONFIG 走 getConfig() 每次现取，支持热更新；state/ctx 传引用）。
  const adminApi = createAdmin({ getConfig: () => CONFIG, callAdapterAction, sendReply, state });
  const sessionApi = createSession({ getConfig: () => CONFIG, ctx, state, ensureQqMsgWorkspace, ensureSessionWorkspace, sessionWorkdir, callAdapterAction, describeError, isOwner: adminApi.isOwner, flowGate });
  // 拥有者专用设置通道：落盘只走 DSH settings 服务（schema 校验 + 原子写 + 热重载），
  // 不直接改 profile 的 cordis.patch.yml；每次写入都追加一条审计日志到 QQ_msg 根目录。
  const ownerSettings = createOwnerSettings({
    getSettings: () => { try { return ctx.get('settings'); } catch (error) { return undefined; } },
    getConfig: () => CONFIG,
    audit: async (line) => {
      try {
        await fsPromises.appendFile(join(qqMsgRootSync(), 'qqbot-config-audit.jsonl'), JSON.stringify(line) + '\n', 'utf8');
      } catch (error) {
        console.log(TAG + ' 设置审计写入失败：' + describeError(error));
      }
    },
    log: (message) => console.log(TAG + ' ' + message),
  });

  const toolsApi = createTools({ getConfig: () => CONFIG, state, ctx, net: valves.network, writeToAdapter, callAdapterAction, describeError, toId: adminApi.toId, entryForAgent: sessionApi.entryForAgent, resolveAuthority: adminApi.resolveAuthority, hasPerm: adminApi.hasPerm, describeAuthority: adminApi.describeAuthority, groupInScope: adminApi.groupInScope, permissionList: adminApi.PERMISSION_LIST, runWebSearch, meFindMoli, meMoliFetchText, runImageSearch, uploadToHost, imgSearchSoutubotFile, imgSearchTraceMoeFile, meIsAllowedImageFile, downloadImage, askVision, qqMsgRootSync, currentAdapterPath, ownerSettings, flowAuthApi });

  // -------------------------------------------------------------- 动态工具
  // 用动态 import 拿 defineTool：即使这个包不在，桥接本身照样工作，只是少一个工具。
  try {
    await toolsApi.registerTools();
  } catch (error) {
    console.log(TAG + ' 跳过 qqbot 工具注册：' + describeError(error));
  }

  // -------------------------------------------------------------- 闸门区
  // 「哪些工具需要动态码」这份名单本身也要受码保护：GUI 里填码解锁、改完点保存 = 消费一次码；
  // 不保存就什么都不写。服务端只认结果：名单变了但码不对，回滚名单并清空码字段，
  // 绝不静默接受（设置页刷一下就能看到名单弹回去）。
  let lastGatedTools = Array.isArray(CONFIG.flowAuth.gatedTools) ? CONFIG.flowAuth.gatedTools.map((item) => String(item)) : [];
  let lastFlowEnabled = CONFIG.flowAuth.enabled === true;
  // 保护闸门本身的字段（密钥/恢复码/试错上限/授权时长）同样要有内存基线：
  // 以前只比 enabled + gatedTools，于是「换掉 totpSecret」这一步连码都不会被问，
  // 换完之后所有「改名单要码」都变成「用攻击者的码验攻击者的锁」（2026-10-28 审计 A1）。
  let lastFlowSecurity = securitySnapshot(CONFIG.flowAuth);
  // 闸门码的重放与失败锁定状态：flow-auth 那条路早就有，这条以前是纯无状态校验。
  const gateState = { lastCounter: undefined, fails: 0, lockedUntil: 0 };
  const writeSettingsPatch = async (patch) => {
    try {
      const settings = ctx.get('settings');
      if (settings === undefined || settings === null || typeof settings.describe !== 'function' || typeof settings.update !== 'function') {
        return { ok: false, error: '设置服务不可用' };
      }
      const descriptors = await settings.describe();
      const matched = matchNamespace(descriptors);
      if (matched.ok !== true) return { ok: false, error: matched.error };
      await settings.update(matched.descriptor.ns, patch, matched.descriptor.revision);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  };
  // 模型选择：路由与 /model 指令实现搬到 gateway/model-pick.js（P3 2.4 第一阶段，只搬不改）。
  const modelPicker = createModelPicker({
    getService: (id) => { try { return ctx.get(id); } catch (error) { return undefined; } },
    prefsFile: join(qqMsgRootSync(), 'model-prefs.json'),
    getPrefix: () => CONFIG.admin.prefix,
    log: (line) => console.log(TAG + ' ' + line),
  });
  const { modelRouter, handleModelCommand } = modelPicker;
  // 流式桥：只有官方 v2 私聊会用；send 交给适配器的 stream 命令（fire-and-forget，失败在适配器侧记日志）。
  const streamBridge = createStreamBridge({
    send: async (payload) => {
      writeToAdapter({
        type: 'stream',
        message_type: payload.messageType,
        target_id: payload.targetId,
        msg_id: payload.msgId,
        text: payload.text,
        done: payload.done,
      });
      return { ok: true };
    },
    log: (line) => console.log(TAG + ' ' + line),
  });

  // 扫码 / 版本探测 / 路由挂载：实现搬到 gateway/routes-glue.js（P3 2.4 第二阶段，只搬不改）。
  const routeGlue = createRouteGlue({
    ctx,
    TAG,
    getConfig: () => CONFIG,
    getState: () => state,
    setConfig: (next) => { CONFIG = next; },
    writeSettingsPatch: (...args) => writeSettingsPatch(...args),
    packageUrl: import.meta.url,
    resolveConfig: () => resolveConfig(),
  });
  const { qqBind } = routeGlue;

  const enforceGateEdit = async () => {
    const conf = (CONFIG.flowAuth !== undefined && CONFIG.flowAuth !== null) ? CONFIG.flowAuth : {};
    const next = Array.isArray(conf.gatedTools) ? conf.gatedTools.map((item) => String(item)) : [];
    const nextEnabled = conf.enabled === true;
    const decision = decideGateEdit({
      previousEnabled: lastFlowEnabled,
      nextEnabled,
      previous: lastGatedTools,
      next,
      previousSecurity: lastFlowSecurity,
      nextSecurity: securitySnapshot(conf),
      code: conf.gateEditCode,
      gateState,
      nowMs: Date.now(),
    });
    if (decision.accept !== true) {
      // 关掉闸门与改名单一样要码：连开关一起回滚，否则「先关、改名单、再开」就绕过去了。
      // 回滚必须连保护面一起：只回名单不回 totpSecret，攻击者换掉的那把锁就留在配置里了。
      const reverted = await writeSettingsPatch({
        flowAuth: Object.assign({}, lastFlowSecurity, {
          enabled: lastFlowEnabled,
          gatedTools: lastGatedTools,
          gateEditCode: '',
        }),
      });
      CONFIG = resolveConfig();
      console.log(TAG + ' 闸门名单改动被拒（' + decision.reason + '）：需要一次有效的 6 位动态码'
        + (reverted.ok === true ? '；已回滚' : '；回滚失败：' + reverted.error));
      return;
    }
    lastGatedTools = next;
    lastFlowEnabled = nextEnabled;
    lastFlowSecurity = securitySnapshot(conf);
    if (decision.clearCode !== true) return;
    // 码是改名单用的一次性凭据，不得留在配置里。
    const cleared = await writeSettingsPatch({ flowAuth: { gateEditCode: '' } });
    if (cleared.ok === true) CONFIG = resolveConfig();
    else console.log(TAG + ' 清空闸门动态码失败：' + cleared.error);
  };

  // 配置热更新：cordis-plugin-loader 在 volatile 字段变化时不会重挂插件，只就地更新
  // 引用并发 'loader/volatile-update'（只有普通字段变化才会重挂，而本插件的可编辑字段
  // 全是 volatile）。所以这里自己刷新 CONFIG。
  // 只有「连接方式」那几项需要重启适配器；其它改动下一轮消息自然生效。
  let lastTransport = transportKey(CONFIG);
  const onVolatileUpdate = () => {
    try {
      CONFIG = resolveConfig();
      void enforceGateEdit();
      scheduleProactive();
      scheduleStaleCleanup(300);
      const next = transportKey(CONFIG);
      if (next === lastTransport) return;
      lastTransport = next;
      console.log(TAG + ' 连接配置已更新，重启适配器');
      // 等旧适配器真的退出再起新的：只隔 250ms 会让旧进程还在 graceMs 里，
      // 两个适配器同连一个端（重复回合），反向模式的新进程还会 EADDRINUSE 卡死。
      void stopAdapter().then(() => {
        state.restarts = 0;
        try { ctx.timeout(() => { spawnAdapter(); }, 250); } catch { /* 已卸载 */ }
      });
    } catch (error) {
      console.error(TAG + ' 应用设置变更失败：' + describeError(error));
    }
  };
  try {
    ctx.on('loader/volatile-update', onVolatileUpdate);
  } catch (error) {
    console.log(TAG + ' 未能监听配置热更新（不影响运行）：' + describeError(error));
  }

  // -------------------------------------------------------------- 生命周期
  ctx.effect(() => () => {
    state.stopping = true;
    stopProactive();
    stopAdapter();
    for (const pair of state.convos) {
      const entry = pair[1];
      if (entry.agent !== null && typeof entry.agent.cancel === 'function') {
        try { entry.agent.cancel({ kind: 'disposed' }); } catch { /* 交给卸载流程 */ }
      }
    }
    console.log(TAG + ' 已停止');
  });

  // 启动时把模型接口探出来：用户一眼看到 /model 走的是哪条路（native / 只读 / 无）。
  try {
    const modelKind = modelRouter.detect().kind;
    console.log(TAG + ' 模型接口：' + (modelKind === 'agent-default-model' ? 'DSH 原生 agentDefaultModel（可切换）'
      : modelKind === 'llm-readonly' ? 'DSH llm（只读列举）' : '未检测到（/model 只能记录偏好）'));
  } catch (error) { console.log(TAG + ' 模型接口探测失败（忽略）：' + describeError(error)); }

  // 启动时把授权闸门状态写进日志：开了但没配密钥属于「开了却不生效」，必须一眼看见。
  if (flowEnabled()) {
    const secretReady = String((CONFIG.flowAuth && CONFIG.flowAuth.totpSecret) || '').trim() !== '';
    console.log(TAG + ' 流程授权已开启：' + (secretReady ? '密钥已配置' : '⚠️ 还没配 TOTP 密钥（node lib/valve/security/totp-cli.mjs enroll）')
      + ' | 需要授权的工具=' + ((Array.isArray(CONFIG.flowAuth.gatedTools) ? CONFIG.flowAuth.gatedTools.join(',') : '') || '（空）')
      + ' | 产物投递=' + String((CONFIG.flow && CONFIG.flow.deliver) || 'private'));
  }
  const wsInfo = await ensureQqMsgWorkspace();
  console.log(TAG + ' 启动中：' + (CONFIG.protocol !== 'onebot11' ? CONFIG.protocol + ' / ' : '') + CONFIG.mode + ' 模式'
    + (CONFIG.mode === 'reverse' ? ' listen=' + CONFIG.onebot.listen : ' ws=' + CONFIG.onebot.wsUrl)
    + ' | 群=' + (CONFIG.group.enabled ? (CONFIG.group.requireAt ? '仅@' : '全部') : '关')
    + ' | 私聊=' + (CONFIG.private.enabled ? '开' : '关')
    + ' | 工作区=' + qqMsgRootSync()
    + (wsInfo.id !== null ? ' | 分组=QQ_msg（已注册）' : ' | 分组=不可用（会话回退 cwd）'));
  spawnAdapter();
  scheduleProactive();
  scheduleImageSweep();
}
