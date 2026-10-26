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
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { promises as fsPromises, mkdirSync } from 'node:fs';
import { fetchUrlViaProxy, publicFetch } from './http.js';
import { runWebSearch } from './websearch.js';
import { runImageSearch, uploadToHost, imgSearchSoutubotFile, imgSearchTraceMoeFile, meIsAllowedImageFile } from './imgsearch.js';
import { meFindMoli, meMoliFetchText } from './moli.js';
import { Config, DEFAULTS, plainConfig, mergeConfig, staleConfigPaths, describeError } from './config.js';
import { createAdmin } from './admin.js';
import { createSession } from './session.js';
import { createTools } from './tools.js';
import { qqMsgRootSync, sessionWorkdir, imageCacheDir, isInside } from './workspace.js';
import { createOwnerSettings } from './owner-settings.js';
import { createFlowAuth, createFlowGate } from './flow-auth.js';
import { createFlowStore } from './flow-store.js';
import { parseAuthCommand, parseFlowCommand, flowInterceptKind, artifactInputLines, flowReasonZh, stripInvisible, FLOW_HELP } from './flow-commands.js';
import { pickInterim } from './interim.js';

import { compatibilityInfo, describeCompatibility } from './compat.js';
import { nowMinutes as proactiveNowMinutes, isQuiet as proactiveIsQuiet, normalizeMessages as proactiveNormalizeMessages, newerThan as proactiveNewerThan, buildDigest as proactiveBuildDigest, buildPrompt as proactiveBuildPrompt, parseDecision as proactiveParseDecision, validateMessage as proactiveValidateMessage, allowSend as proactiveAllowSend, analyzeEvent as proactiveAnalyzeEvent, topicKey as proactiveTopicKey, topicRepeated as proactiveTopicRepeated, resolveModel as proactiveResolveModel, resolveStageModels as proactiveResolveStageModels, buildSpeakPrompt as proactiveBuildSpeakPrompt, runSpeakStage as proactiveRunSpeakStage } from './proactive.js';

export { Config };

export const name = 'dsh-qq-bot';
// attachments / llm：图片视觉用（把 QQ 图片注册成 DSH image 块并探测模型能力）。
// 两者都由 dsh-base 恒常挂载（attachment-local 与 dsh-llm），声明为硬依赖。
export const inject = ['subprocess', 'sessionController', 'timer', 'attachments', 'llm', 'tools'];

// 本插件的「自报身份」：npm 包名（带作用域，0.12 起）+ 条目 id（一直是 dsh-qq-bot）。
// 配置残留清理按这两个名字**精确**认自己的条目，不做后缀正则（会误伤 my-qq-bot）。
const SELF_IDS = new Set(['dsh-qq-bot', '@sputnikzaychik/dsh-qq-bot']);

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLED_ADAPTER = join(HERE, 'onebot-adapter.mjs');
/** 协议 -> 适配器脚本（0.10 起适配器统一放 lib/adapters/，OneBot 11 保留旧入口做兼容）。 */
const ADAPTER_FILES = {
  onebot11: BUNDLED_ADAPTER,
  onebot12: join(HERE, 'adapters', 'onebot12.mjs'),
  satori: join(HERE, 'adapters', 'satori.mjs'),
  milky: join(HERE, 'adapters', 'milky.mjs'),
  'qq-official': join(HERE, 'adapters', 'qq-official.mjs'),
};

// —— 工作区根（QQ_msg）：读取 DSH 官方默认 Workspace 位置（<系统 Documents>/deepseek-harness），
// 在它的同级目录建 QQ_msg 作为本插件的全局工作区根；每个 QQ 会话一个子目录。
// Documents 解析复刻 @deepseek-ai/dsh-api-workspace-controller 的平台命令；Linux 上
// xdg-user-dir 在无独立 Documents 目录时回退到主目录，这里同样按返回值采用（即
// 建在 <主目录>/deepseek-harness/QQ_msg，仍与官方 default-workspace 严格同级）。
// 已解析/注册的 QQ_msg 工作区（DSH workspace 分组）；id 为 null 表示该 DSH 无 workspace 服务，回退 cwd。
let qqWorkspaceValue = null;



/** 把设置里的「人格」渲染成一段身份设定；未启用或没填内容时返回空串。 */
function buildPersonaHint(persona) {
  if (persona === null || persona === undefined || persona.enabled !== true) return '';
  const name = typeof persona.name === 'string' ? persona.name.trim() : '';
  const text = typeof persona.text === 'string' ? persona.text.trim() : '';
  if (name === '' && text === '') return '';
  return '（身份设定，请始终遵守：' + (name === '' ? '' : '你是' + name + '。') + text + '）';
}

/** 深拷贝一份配置，并把指定路径（键名数组）整段摘掉（不改入参）。 */
export function dropConfigPaths(raw, paths) {
  const clone = (value) => {
    if (Array.isArray(value)) return value.map(clone);
    if (value === null || typeof value !== 'object') return value;
    const next = {};
    for (const [key, child] of Object.entries(value)) next[key] = clone(child);
    return next;
  };
  const result = clone(raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw) ? {} : raw);
  for (const entry of paths) {
    // 只认键名数组：字符串会被当成单个键名，避免 "a.b" 被误解成嵌套路径。
    const parts = (Array.isArray(entry) ? entry : [entry]).map((part) => String(part)).filter((part) => part !== '');
    if (parts.length === 0) continue;
    let node = result;
    for (let index = 0; index < parts.length - 1; index += 1) {
      node = node === null || typeof node !== 'object' ? null : node[parts[index]];
      if (node === null || node === undefined || typeof node !== 'object') { node = null; break; }
    }
    if (node !== null && node !== undefined && typeof node === 'object') delete node[parts[parts.length - 1]];
  }
  return result;
}

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
 * @param {object} ctx 插件上下文
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
        void cleanupStaleConfig(ctx, { tag: TAG });
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
    return ADAPTER_FILES[CONFIG.protocol] ?? BUNDLED_ADAPTER;
  };

  // 确保 QQ_msg 已注册为 DSH workspace（Web UI 侧栏的「分组」）。Cordis 的
  // ctx.<服务> 需要 inject 声明才能访问；ctx.reflect.get(name) 是官方的免注入
  // 读服务方法，服务缺失时返回 undefined —— 自动回退 cwd 方式（不分组，不影响收发）。
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
      stats: { inbound: 0, accepted: 0, skipped: 0, replies: 0, chunks: 0, errors: 0, admin: 0, actions: 0, notices: 0, guestBlocked: 0, flowBlocked: 0 },
      // 动作请求/响应关联：{ echo -> resolve }
      pending: new Map(),
      actionSeq: 0,
  };

  // 兼容自检：读当前实际加载的 DSH 版本，启动日志与 qqbot status 都给出结论；
  // 不逐版本硬编码，支持范围只维护 lib/compat.js 里的两个常量。
  state.dsh = compatibilityInfo();
  console.log(TAG + ' ' + describeCompatibility(state.dsh));
  state.proactive = { timer: null, groups: new Map(), selfId: null, warned: '', banner: '' };
  // ---------------------------------------------------- 流程授权状态（不跨会话共享）
  // promptIds: qq -> 机器人发出去那条授权提示的 message_id（通过后撤回它）
  // resume: 授权通过后要续跑的回合 { entry, frame }；active: 活动流程名（/flow use 切换）
  state.flow = { promptIds: new Map(), resume: null, active: '', recoveryUsed: new Set() };
  const flowAuditFile = join(qqMsgRootSync(), 'qqbot-flow-audit.jsonl');
  const flowAuth = createFlowAuth({
    config: () => ((CONFIG.flowAuth === undefined || CONFIG.flowAuth === null) ? {} : CONFIG.flowAuth),
    audit: (line) => {
      console.log(TAG + ' 流程授权审计 ' + JSON.stringify(line));
      try {
        fsPromises.appendFile(flowAuditFile, JSON.stringify(line) + '\n', 'utf8').catch(() => {});
      } catch (error) { /* 审计写不进去不阻塞授权 */ }
    },
  });
  const flowGate = createFlowGate({
    auth: flowAuth,
    enabled: () => flowEnabled(),
    gatedTools: () => ((CONFIG.flowAuth === undefined || CONFIG.flowAuth === null
      || !Array.isArray(CONFIG.flowAuth.gatedTools)) ? [] : CONFIG.flowAuth.gatedTools),
  });
  const flowStore = createFlowStore({ root: join(qqMsgRootSync(), 'flows') });
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

  // -------------------------------------------------------------- 主动发言（可选）
  // 只在「开关打开 + 显式列群 + 不在免打扰 + 新消息够多 + 频率没超」时才让模型看一次；
  // 要不要接、接什么话题全由模型判断，插话内容再过一遍长度/链接/@/重复校验。
  function proactiveConfig() {
    const p = CONFIG.proactive;
    return (p === null || p === undefined) ? {} : p;
  }

  function proactiveGroupList() {
    const p = proactiveConfig();
    const list = Array.isArray(p.groups) ? p.groups : [];
    const out = [];
    for (const item of list) {
      const id = String(item === undefined || item === null ? '' : item).trim();
      if (id !== '' && out.indexOf(id) < 0) out.push(id);
    }
    return out;
  }

  function stopProactive() {
    if (state.proactive.timer !== null) {
      try { state.proactive.timer(); } catch (error) { /* 已经触发过 */ }
      state.proactive.timer = null;
    }
  }

  function scheduleProactive() {
    stopProactive();
    // 配置可能刚被改过（热更新会重跑这里），缺项告警重新判断，不要因为旧的 warned 而哑掉。
    state.proactive.warned = '';
    const p = proactiveConfig();
    if (p.enabled !== true) { state.proactive.banner = ''; return; }
    const groups = proactiveGroupList();
    if (groups.length === 0) {
      console.log(TAG + ' 主动发言已开启但没配置群号（proactive.groups），跳过');
      return;
    }
    const minutes = Math.max(5, Number(p.intervalMinutes) > 0 ? Number(p.intervalMinutes) : 60);
    const base = minutes * 60000;
    const loop = async () => {
      try { await runProactiveTick(); }
      catch (error) { console.log(TAG + ' 主动发言检查失败（忽略）：' + describeError(error)); }
      // 这一轮 tick 可能在 await 期间跨过了插件卸载/重挂：那时 ctx.timeout 会抛
      // "cannot get required service in inactive context"，而 timer 回调丢弃返回值，
      // 抛出来就是 unhandled rejection —— Node 24 默认直接 exit 1，整个宿主陪葬。
      if (state.stopping === true) return;
      const jitter = Math.floor(base * 0.2 * Math.random());
      try { state.proactive.timer = ctx.timeout(loop, base + jitter); }
      catch (error) { console.log(TAG + ' 主动发言不再排下一轮（插件已卸载）：' + describeError(error)); }
    };
    state.proactive.timer = ctx.timeout(loop, Math.floor(base * 0.5));
    const stage = proactiveResolveStageModels(p, null);
    const label = (s) => (s.provider !== '' && s.model !== '') ? (s.provider + '/' + s.model) : '群会话模型';
    const source = stage.judge;
    const sourceLabel = (source.provider !== '' && source.model !== '')
      ? ('指定模型 ' + source.provider + '/' + source.model)
      : '跟随群会话模型';
    const stageLabel = stage.twoStage === true
      ? ('，两段式（判断 ' + label(stage.judge) + ' / 发言 ' + label(stage.speak) + '）')
      : '';
    // 任何 volatile 字段改动都会重跑这里，横幅只在内容真的变了时才打，避免刷屏。
    const banner = '每 ' + minutes + ' 分钟看一次，群=' + groups.join(',')
      + '，首次检查约 ' + Math.round(minutes / 2) + ' 分钟后，模型来源=' + sourceLabel + stageLabel;
    if (banner !== state.proactive.banner) {
      state.proactive.banner = banner;
      console.log(TAG + ' 主动发言已开启：' + banner);
    }
  }

  function proactiveGroupState(groupId) {
    let s = state.proactive.groups.get(groupId);
    if (s === undefined) {
      s = { lastSeenTime: 0, lastSentAt: 0, lastSentText: '', sentTimes: [], lastDecision: '', topics: [], sentTexts: [] };
      state.proactive.groups.set(groupId, s);
    }
    return s;
  }

  async function runProactiveTick() {
    const p = proactiveConfig();
    if (p.enabled !== true) return;
    if (state.connected !== true) return;
    if (proactiveIsQuiet(proactiveNowMinutes(new Date()), p.quietHours)) return;
    for (const groupId of proactiveGroupList()) {
      try { await proactiveConsiderGroup(groupId, p); }
      catch (error) { console.log(TAG + ' 主动发言（群 ' + groupId + '）失败（忽略）：' + describeError(error)); }
    }
  }

  async function proactiveSelfId() {
    if (state.proactive.selfId !== null) return state.proactive.selfId;
    try {
      const info = await callAdapterAction('get_login_info', {}, 8000);
      if (info.ok === true && info.data !== null && info.data !== undefined && info.data.user_id !== undefined) {
        state.proactive.selfId = String(info.data.user_id);
      }
    } catch (error) { /* 取不到就按未知处理 */ }
    return state.proactive.selfId;
  }

  // 配置不全时只告警一次，避免每轮刷屏；改完配置重启会重新判断。
  function warnProactiveIncomplete(missing) {
    const signature = missing.join('|');
    if (state.proactive.warned === signature) return;
    state.proactive.warned = signature;
    console.log(TAG + ' 主动发言不会真的发言：缺少 ' + missing.join('、')
      + '。可在插件设置「能力 → 对话与人格 → 主动发言」里用下拉选一个 provider/模型，留空则跟随群会话模型。');
  }

  /**
   * 取「这个群当前用的模型」：已有会话直接用；还没有会话就按全局 preset 建同一条会话
   * （主动发言要发话时本来也会用到它，所以不算额外开销）。
   * 这样即使刚重启、群里还没人说话，也能跟随会话模型而不是直接失败。
   */
  async function proactiveSessionOptions(groupId) {
    const scopeKey = 'group-' + String(groupId);
    const pick = (entry) => (entry !== null && entry !== undefined && entry.agent !== null && entry.agent !== undefined
      && entry.agent.options !== null && entry.agent.options !== undefined) ? entry.agent.options : null;
    // 1) 非分流配置下的主会话；2) 分流配置下 owner / guest 两条
    const hit = pick(state.convos.get(scopeKey)) || pick(state.convos.get(scopeKey + '@owner')) || pick(state.convos.get(scopeKey + '@guest'));
    if (hit !== null) return hit;
    // 3) 冷启动：按和收消息时一样的入口建（不分流时就是这样）
    // 分流模式下会话键是 group-x@owner / group-x@guest，这里判断不了该算哪一档，
    // 硬建只会留下一条收消息时永远用不到的孤儿会话——直接放弃，交给告警提示去指定模型。
    const split = String(CONFIG.auth.ownerPreset || '').trim() !== '' || String(CONFIG.auth.guestPreset || '').trim() !== '';
    if (split) return null;
    try {
      const entryKey = CONFIG.perChatSession ? scopeKey : 'shared';
      const sessionId = CONFIG.perChatSession ? 'qqbot-' + scopeKey : 'qqbot-shared';
      const fixedTitle = (CONFIG.session !== null && CONFIG.session !== undefined && CONFIG.session.fixedName === true)
        ? '群聊_' + String(groupId) : null;
      const entry = await sessionApi.getEntry(entryKey, sessionId, CONFIG.agentPreset, fixedTitle);
      return pick(entry);
    } catch (error) {
      console.log(TAG + ' 主动发言：取会话模型失败（' + describeError(error) + '）');
      return null;
    }
  }

  async function proactiveCallModel(source, prompt, p, temperature) {
    if (source.missing.length > 0) { warnProactiveIncomplete(source.missing); return ''; }
    if (p.verbose === true) {
      console.log(TAG + ' 主动发言请求：' + source.provider + '/' + source.model
        + ' prompt=' + prompt.length + ' 字 head=' + JSON.stringify(String(prompt).slice(0, 80)));
    }
    return proactiveLlmModel(source, prompt, p, temperature);
  }

  /** DSH 内置 llm 服务（走已注册 provider，认证由 DSH 负责，不需要 key）。 */
  async function proactiveLlmModel(source, prompt, p, temperature) {
    const llm = ctx.llm;
    if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
      console.log(TAG + ' 主动发言：DSH llm 服务不可用（ctx.llm.stream 缺失），请确认 DSH 的 llm 插件已启用');
      return '';
    }
    const timeout = Math.max(5000, Math.floor(Number(p.timeoutMs) || 60000));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
    let out = '';
    try {
      const temp = Number.isFinite(temperature) ? temperature : 0.8;
      for await (const chunk of llm.stream({ provider: source.provider, model: source.model, messages, maxTokens: 500, temperature: temp, signal: controller.signal })) {
        if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text;
      }
    } catch (error) {
      console.log(TAG + ' 主动发言模型调用失败（' + source.provider + '/' + source.model + '）：' + describeError(error));
      return '';
    } finally {
      clearTimeout(timer);
    }
    if (out.trim() === '') console.log(TAG + ' 主动发言模型空返回（' + source.provider + '/' + source.model + '）');
    return out.trim();
  }

  async function proactiveConsiderGroup(groupId, p) {
    const st = proactiveGroupState(groupId);
    const verbose = p.verbose === true;
    const now = Date.now();
    const gate = proactiveAllowSend({ now, sentTimes: st.sentTimes, lastSentAt: st.lastSentAt, maxPerHour: p.maxPerHour, maxPerDay: p.maxPerDay, minGapMinutes: p.minGapMinutes });
    if (gate.ok !== true) { if (verbose) console.log(TAG + ' 主动发言跳过（' + groupId + '）：' + gate.reason); return; }
    const windowSize = Math.max(5, Math.min(100, Math.floor(Number(p.windowMessages) || 30)));
    const result = await callAdapterAction('get_group_msg_history', { group_id: Number(groupId), count: windowSize }, 8000);
    if (result.ok !== true) { if (verbose) console.log(TAG + ' 主动发言取历史失败（' + groupId + '）'); return; }
    const raw = result.data !== null && result.data !== undefined && Array.isArray(result.data.messages) ? result.data.messages : [];
    const selfId = await proactiveSelfId();
    const messages = proactiveNormalizeMessages(raw, selfId === null ? '' : selfId);
    const fresh = proactiveNewerThan(messages, st.lastSeenTime).filter((m) => m.isSelf !== true);
    for (const m of messages) { if (m.time > st.lastSeenTime) st.lastSeenTime = m.time; }
    const minNew = Math.max(1, Math.floor(Number(p.minNewMessages) || 6));
    if (fresh.length < minNew) { if (verbose) console.log(TAG + ' 主动发言跳过（' + groupId + '）：新消息 ' + fresh.length + ' < ' + minNew); return; }
    // 事件闸（可关）：过气的、只是应答一句的、自己刚说过的，都不接——避免对同一件事重复回复。
    const eventGuard = p.eventGuard !== false;
    let event = { ok: true, reason: '', ageMinutes: 0, eventTime: 0 };
    if (eventGuard === true) {
      event = proactiveAnalyzeEvent(messages, { nowSec: Math.floor(Date.now() / 1000), staleMinutes: p.staleMinutes });
      if (event.ok !== true) { if (verbose) console.log(TAG + ' 主动发言跳过（' + groupId + '）：' + event.reason); return; }
    }
    // 模型来源交给 proactiveCallModel 里的 resolveModel 统一判断（留空就跟随群会话模型，不需要 key）。
    const personaText = String(p.persona === undefined || p.persona === null ? '' : p.persona).trim();
    const basePersona = CONFIG.persona !== null && CONFIG.persona !== undefined && String(CONFIG.persona.text || '').trim() !== ''
      ? (String(CONFIG.persona.name || '').trim() !== '' ? String(CONFIG.persona.name).trim() + '：' : '') + String(CONFIG.persona.text).trim()
      : '';
    const prompt = proactiveBuildPrompt({
      persona: personaText !== '' ? personaText : basePersona,
      interests: p.interests,
      digest: proactiveBuildDigest(fresh, Math.min(40, windowSize)),
      maxChars: p.maxChars,
      // 把事件年龄与「别重复」的要求交给模型，配合上面的确定性事件闸一起用。
      eventAgeMinutes: event.ageMinutes,
      recentTopics: st.topics.map((item) => item.key).filter((key) => String(key).length > 0).slice(-3),
    });
    // 判断/发言可以各用各的模型；speakModel 没配时就是单段模式，行为与之前完全一致。
    const stageModels = proactiveResolveStageModels(p, await proactiveSessionOptions(groupId));
    // 两段式缺项在这里就拦住：等判断那次调用花完钱才发现配置填错没有意义。
    if (stageModels.twoStage === true && stageModels.speak.missing.length > 0) { warnProactiveIncomplete(stageModels.speak.missing); return; }
    let answer = '';
    let decision = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      answer = await proactiveCallModel(stageModels.judge, prompt, p, 0.8);
      decision = answer === '' ? null : proactiveParseDecision(answer);
      if (decision !== null) break;
      if (verbose) console.log(TAG + ' 主动发言：第 ' + String(attempt + 1) + ' 次无有效决策' + (answer === '' ? '' : '（原文：' + answer.slice(0, 120) + '）'));
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    if (decision === null) { if (verbose) console.log(TAG + ' 主动发言：放弃本轮'); return; }
    st.lastDecision = decision.topic + (decision.why === '' ? '' : '｜' + decision.why);
    if (decision.speak !== true) { if (verbose) console.log(TAG + ' 主动发言（' + groupId + '）：决定不接话｜' + st.lastDecision); return; }
    const maxChars = Math.max(20, Math.floor(Number(p.maxChars) || 120));
    const recentTexts = (Array.isArray(st.sentTexts) && st.sentTexts.length > 0 ? st.sentTexts : [st.lastSentText]);
    // 单段模式也过同一道兜底：开关默认关，透传不改变任何现有部署的行为。
    let verdict = proactiveValidateMessage(decision.message, { maxChars, recentTexts, requireCjk: p.requireCjk === true });
    // 两段式（可选）：判断只出 JSON，正文交给发言模型写；写不出来时才回退到判断模型给的那句。
    if (stageModels.twoStage === true) {
      const speakPrompt = proactiveBuildSpeakPrompt({
        persona: personaText !== '' ? personaText : basePersona,
        digest: proactiveBuildDigest(fresh, Math.min(40, windowSize)),
        topic: decision.topic,
        maxChars,
      });
      const stage = await proactiveRunSpeakStage({
        call: () => proactiveCallModel(stageModels.speak, speakPrompt, p, 0.9),
        // requireCjk 是发送前兜底（默认关）：无 CJK 且长度 > 12 判不可用，专治模型掉回英文拒答模板。
        validate: (raw) => proactiveValidateMessage(raw, { maxChars, recentTexts, requireCjk: p.requireCjk === true }),
        attempts: 2,
        // 判断阶段的 message 在这里只为回退保留：精简 judge 提示词时不能把它删掉，否则回退会静默失效。
        fallback: { enabled: p.speakFallback !== false, ok: verdict.ok === true, text: verdict.text },
        onBlocked: (index, checked) => { if (verbose) console.log(TAG + ' 主动发言：发言阶段第 ' + String(index + 1) + ' 次被拦（' + checked.reason + '）'); },
        onFallback: () => { if (verbose) console.log(TAG + ' 主动发言：发言阶段没有产出，回退用判断模型给的正文'); },
      });
      if (stage.text === '') {
        if (verbose) {
          const why = (p.speakFallback !== false && verdict.ok !== true) ? '（判断正文本身不可用：' + verdict.reason + '，无处可退）' : '';
          console.log(TAG + ' 主动发言（' + groupId + '）：两段式没有可发的正文' + why);
        }
        return;
      }
      verdict = { ok: true, reason: '', text: stage.text };
    }
    if (verdict.ok !== true) { if (verbose) console.log(TAG + ' 主动发言（' + groupId + '）：内容被拦（' + verdict.reason + '）'); return; }
    // 话题闸：冷却时间内说过同一件事（哪怕换了说法）就不再重复。
    const topicKey = proactiveTopicKey(decision.topic !== '' ? decision.topic : verdict.text);
    if (eventGuard === true && proactiveTopicRepeated(topicKey, st.topics, { now: Date.now(), cooldownMinutes: p.topicCooldownMinutes }) === true) {
      console.log(TAG + ' 主动发言跳过（' + groupId + '）：话题「' + topicKey + '」在冷却时间内已经说过');
      return;
    }
    if (p.dryRun === true) { console.log(TAG + ' 主动发言（演练，不发送）→ 群 ' + groupId + '：' + verdict.text); return; }
    const sent = writeToAdapter({ type: 'send', message_type: 'group', target_id: groupId, text: verdict.text });
    if (sent !== true) { if (verbose) console.log(TAG + ' 主动发言（' + groupId + '）：适配器不可用'); return; }
    const sentAt = Date.now();
    st.lastSentAt = sentAt;
    st.lastSentText = verdict.text;
    st.sentTexts = (Array.isArray(st.sentTexts) ? st.sentTexts : []).concat([verdict.text]).slice(-5);
    st.topics = (Array.isArray(st.topics) ? st.topics : []).concat([{ at: sentAt, key: topicKey }]).slice(-20);
    st.sentTimes.push(sentAt);
    st.sentTimes = st.sentTimes.filter((t) => sentAt - t < 86400000);
    console.log(TAG + ' 主动发言 → 群 ' + groupId + (decision.topic === '' ? '' : '（' + decision.topic + '）') + '：' + verdict.text);
  }

  // -------------------------------------------------------------- 适配器监管
  let handle = null;
  let stdoutBuffer = '';
  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();

  /**
   * 组装适配器命令行参数。各协议适配器共用 --ws / --listen / --http / --token 这组通用开关，
   * 协议特有的再追加（satori 的 --platform/--self-id、qq-official 的 --app-id/--app-secret/--path…）。
   */
  function adapterArgv() {
    const args = [nodePath, currentAdapterPath()];
    const protocol = String(CONFIG.protocol ?? 'onebot11');
    if (protocol === 'onebot11' || protocol === 'onebot12') {
      const block = protocol === 'onebot11' ? CONFIG.onebot : CONFIG.protocols.onebot12;
      const mode = protocol === 'onebot11' ? CONFIG.mode : block.mode;
      if (mode === 'reverse') args.push('--listen', String(block.listen));
      else args.push('--ws', String(block.wsUrl));
      if (block.httpUrl !== '') args.push('--http', String(block.httpUrl));
      if (block.accessToken !== '') args.push('--token', String(block.accessToken));
      return args;
    }
    if (protocol === 'satori') {
      const block = CONFIG.protocols.satori;
      if (block.wsUrl !== '') args.push('--ws', String(block.wsUrl));
      if (block.httpUrl !== '') args.push('--http', String(block.httpUrl));
      if (block.token !== '') args.push('--token', String(block.token));
      if (block.platform !== '') args.push('--platform', String(block.platform));
      if (block.selfId !== '') args.push('--self-id', String(block.selfId));
      return args;
    }
    if (protocol === 'milky') {
      const block = CONFIG.protocols.milky;
      if (block.wsUrl !== '') args.push('--ws', String(block.wsUrl));
      if (block.httpUrl !== '') args.push('--http', String(block.httpUrl));
      if (block.accessToken !== '') args.push('--token', String(block.accessToken));
      return args;
    }
    if (protocol === 'qq-official') {
      const block = CONFIG.protocols.qqOfficial;
      args.push('--mode', String(block.mode));
      if (block.appId !== '') args.push('--appid', String(block.appId));
      // QQ 开放平台的回调签名也用 AppSecret 作为 seed，适配器内部自行派生 ed25519 私钥。
      if (block.appSecret !== '') args.push('--secret', String(block.appSecret));
      args.push('--listen', String(block.listen));
      if (block.path !== '') args.push('--path', String(block.path));
      return args;
    }
    // 未知协议：按 OneBot 11 的默认参数启动，保证不至于完全起不来
    if (CONFIG.mode === 'reverse') args.push('--listen', String(CONFIG.onebot.listen));
    else args.push('--ws', String(CONFIG.onebot.wsUrl));
    return args;
  }

  function writeToAdapter(frame) {
    if (handle === null) return false;
    const sink = handle.stdin;
    if (sink === null || sink === undefined || typeof sink.write !== 'function') return false;
    try { sink.write(JSON.stringify(frame) + '\n'); return true; }
    catch (error) {
      state.stats.errors += 1;
      console.error(TAG + ' 写适配器 stdin 失败：' + describeError(error));
      return false;
    }
  }

    /**
     * 通过适配器执行平台动作（OneBot 风格命名，由适配器翻译），并等待带 echo 的 action_result。
     * 群管理、查询都走这里；超时会给出明确错误而不是挂死。
     */
    function callAdapterAction(action, params, timeoutMs) {
      return new Promise((resolve) => {
        if (handle === null) { resolve({ ok: false, error: '适配器未运行' }); return; }
        const echo = 'act-' + (++state.actionSeq) + '-' + Date.now();
        const cancel = ctx.timeout(() => {
          if (state.pending.delete(echo)) resolve({ ok: false, error: '动作超时：' + action });
        }, (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : 12000);
        state.pending.set(echo, (result) => {
          if (typeof cancel === 'function') cancel();
          resolve(result);
        });
        const written = writeToAdapter({ type: 'action', action, params, echo });
        if (written !== true) {
          state.pending.delete(echo);
          if (typeof cancel === 'function') cancel();
          resolve({ ok: false, error: '无法把动作写到适配器' });
        }
      });
    }

  function scheduleRestart() {
    if (state.stopping) return;
    if (state.restartPending === true) return; // 已经排了一个，别叠第二个
    state.restarts += 1;
    const delay = Math.min(CONFIG.restart.baseMs * Math.pow(2, Math.min(state.restarts, 5)), CONFIG.restart.maxMs);
    console.error(TAG + ' 适配器将在 ' + delay + 'ms 后重启');
    state.restartPending = true;
    try {
      const cancel = ctx.timeout(() => { state.restartPending = false; state.restartCancel = null; spawnAdapter(); }, delay);
      state.restartCancel = typeof cancel === 'function' ? cancel : null;
    } catch (error) {
      state.restartPending = false;
      console.error(TAG + ' 无法安排重启：' + describeError(error));
    }
  }

  function cancelRestart() {
    if (state.restartPending !== true) return;
    state.restartPending = false;
    const cancel = state.restartCancel;
    state.restartCancel = null;
    if (typeof cancel === 'function') { try { cancel(); } catch { /* 已经触发过 */ } }
  }

  function spawnAdapter() {
    if (state.stopping) return;
    // 已有进程在跑就别再起一个：旧进程的 done 晚到时会照排重启，不挡住就是两个
    // 适配器同连一个 OneBot，入站消息被处理两遍（重复回合、重复回复）。
    if (handle !== null) return;
    let proc;
    try {
      proc = subprocess.spawn({
        argv: adapterArgv(),
        cwd: qqMsgRootSync(),
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 3000,
      });
    } catch (error) {
      state.stats.errors += 1;
      console.error(TAG + ' 启动适配器失败：' + describeError(error));
      scheduleRestart();
      return;
    }
    handle = proc;
    stdoutBuffer = '';
    console.log(TAG + ' 适配器已启动（' + CONFIG.mode + ' 模式）');

    if (proc.stdout !== null && proc.stdout !== undefined) {
      proc.stdout.on('data', (chunk) => {
        stdoutBuffer += stdoutDecoder.decode(chunk, { stream: true });
        let index;
        while ((index = stdoutBuffer.indexOf('\n')) >= 0) {
          const line = stdoutBuffer.slice(0, index).trim();
          stdoutBuffer = stdoutBuffer.slice(index + 1);
          if (line === '') continue;
          let frame;
          try { frame = JSON.parse(line); }
          catch { console.error(TAG + ' 适配器输出了非 JSON：' + line.slice(0, 240)); continue; }
          try { onAdapterFrame(frame); }
          catch (error) { state.stats.errors += 1; console.error(TAG + ' 帧处理失败：' + describeError(error)); }
        }
      });
    } else {
      console.error(TAG + ' 适配器 stdout 不可用，收不到 QQ 消息');
    }

    if (proc.stderr !== null && proc.stderr !== undefined) {
      proc.stderr.on('data', (chunk) => {
        const text = stderrDecoder.decode(chunk, { stream: true }).trim();
        if (text !== '') console.error(TAG + '/adapter ' + text);
      });
    }

    const onSettled = (label) => {
      const current = handle === proc;
      if (current === true) handle = null;
      state.connected = false;
      state.statusReason = label;
      console.error(TAG + ' 适配器已退出（' + label + '）');
      // 被 stopAdapter 换下来的旧进程一律不排重启：它的退出是主动的，重启由调用方决定。
      if (current === true) scheduleRestart();
    };
    proc.done.then(
      (outcome) => onSettled('退出码 ' + String(outcome === null || outcome === undefined ? '?' : outcome.exitCode)),
      (error) => onSettled('失败：' + describeError(error)),
    );
  }

  function stopAdapter() {
    cancelRestart();
    if (handle === null) return;
    const proc = handle;
    try { writeToAdapter({ type: 'shutdown' }); } catch { /* 正在退出 */ }
    handle = null;
    state.connected = false;
    try { proc.terminate(); }
    catch (error) { console.error(TAG + ' 终止适配器失败：' + describeError(error)); }
  }

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

  /** 拉取被回复（引用）的那条消息，把其中的图片收集到 frame.replyImageUrls，
   * 供 describeImages 一并识别（回复引用流程保留）。不构建文本上下文——
   * 需要群内近期消息/图片时，由 AI 主动调 qq_history 工具自取。
   */
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

  /** 主人的 QQ 号：取 auth.owners 里第一个非空项；没有主人时授权无从谈起。 */
  function ownerQq() {
    const owners = Array.isArray(CONFIG.auth.owners) ? CONFIG.auth.owners : [];
    for (const item of owners) {
      const text = String(item === undefined || item === null ? '' : item).trim();
      if (text !== '') return text;
    }
    return '';
  }

  const AUTH_FAIL_TEXT = {
    disabled: '流程授权没有开启',
    'no-secret': '还没配置 TOTP 密钥（服务器上跑 node lib/totp-cli.mjs enroll，把 secret 填进设置页）',
    'weak-secret': '密钥太短（少于 10 字节），请在设置页重新生成一个',
    'no-pending': '没有待授权的请求（先让机器人申请一次）',
    'bad-format': '动态码格式不对（6 位数字）',
    mismatch: '动态码不对',
    replayed: '这个动态码已经用过（同一个 30 秒窗口只能用一次）',
    locked: '错误次数太多，已临时锁定',
    'no-recovery': '没有配置恢复码',
  };

  async function sendPrivateText(qq, text) {
    try {
      const result = await callAdapterAction('send_private_msg', {
        user_id: Number(qq),
        message: String(text),
      }, 8000);
      if (result.ok === true && result.data !== null && result.data !== undefined
        && result.data.message_id !== undefined && result.data.message_id !== null) {
        return String(result.data.message_id);
      }
    } catch (error) {
      console.log(TAG + ' 私聊发送失败：' + describeError(error));
    }
    return '';
  }

  /** 撤回机器人自己发的那条消息；失败只记日志（撤不回来也不影响授权结果）。 */
  async function recallMessage(messageId) {
    if (messageId === undefined || messageId === null || String(messageId) === '') return;
    try { await callAdapterAction('delete_msg', { message_id: Number(messageId) }, 8000); }
    catch (error) { console.log(TAG + ' 撤回授权提示失败（忽略）：' + describeError(error)); }
  }

  /** 发起一次授权申请：登记用途、往主人私聊发提示，并记住「授权通过后要续跑哪个回合」。 */
  async function requestFlowAuth(purpose, entry, frame) {
    if (flowEnabled() !== true) return { ok: false, reason: 'disabled' };
    // 提示要发给「发起这次申请的那位拥有者」：多拥有者时固定发第一个人，
    // 第二个 owner 就会一直等一条永远不来的码（闸门只认他自己的 qq）。
    const requester = (frame !== null && frame !== undefined && frame.user_id !== null && frame.user_id !== undefined)
      ? String(frame.user_id) : '';
    const owners = Array.isArray(CONFIG.auth.owners) ? CONFIG.auth.owners.map((id) => String(id)) : [];
    const qq = (requester !== '' && owners.indexOf(requester) >= 0) ? requester : ownerQq();
    if (qq === '') return { ok: false, reason: 'no-owner' };
    const label = String(purpose === undefined || purpose === null || String(purpose).trim() === ''
      ? '有一项操作要跑' : String(purpose).trim());
    const req = flowAuth.requestAuth(qq, label);
    if (req.ok !== true) return req;
    const ttlSeconds = Math.max(30, Math.floor(Number(req.ttlSeconds) || 30));
    const windowText = ttlSeconds >= 60 ? (Math.round(ttlSeconds / 60) + ' 分钟') : (ttlSeconds + ' 秒');
    const messageId = await sendPrivateText(qq,
      '【流程授权】' + label + '\n'
      + '请直接回我一条：/auth 6位动态码\n'
      + '（' + windowText + '内有效，一次一用；验证通过后我撤回这条，你那条也记得撤回）');
    if (messageId !== '') state.flow.promptIds.set(qq, messageId);
    state.flow.resume = (entry === undefined || entry === null || frame === undefined || frame === null)
      ? null : {
        entry,
        frame,
        // 排队期间 entry.speaker 会被后到的消息覆盖，续跑必须沿用发起申请那一回合的身份。
        speaker: (entry.turnSpeaker !== undefined && entry.turnSpeaker !== null) ? entry.turnSpeaker : entry.speaker,
      };
    return { ok: true, ttlSeconds };
  }

  /** 把被拦下的回合接着跑：授权到手后模型重试那个工具即可，不用人再催一遍。 */
  function resumeAfterAuth() {
    const pending = state.flow.resume;
    state.flow.resume = null;
    if (pending === null || pending === undefined) return;
    const entry = pending.entry;
    const frame = pending.frame;
    if (entry === null || entry === undefined || frame === null || frame === undefined) return;
    const active = state.flow.active === '' ? '' : '（活动流程：' + state.flow.active + '）';
    const generation = entry.generation;
    entry.queue = entry.queue
      .then(() => runTurn(entry, frame,
        '（主人已完成流程授权' + active + '：继续刚才被拦下的任务，直接重试那个工具，不要重复申请授权。）',
        generation, true, false, pending.speaker))
      .then(() => deliverFlowArtifacts(entry, frame))
      .catch((error) => {
        state.stats.errors += 1;
        console.error(TAG + ' 授权后续跑失败：' + describeError(error));
      });
  }

  /** /auth <6位>：只认主人私聊；通过后撤回提示、提醒撤回动态码，并把回合续上。 */
  async function handleAuthMessage(frame, text) {
    const cmd = parseAuthCommand(text);
    if (cmd === null) return false;
    if (flowEnabled() !== true) {
      sendReply(frame, '流程授权没有开启（设置页 → 高级 → 流程授权）。');
      return true;
    }
    if (cmd.token === '') {
      sendReply(frame, '用法：/auth 6位动态码（动态码来自认证器 App）');
      return true;
    }
    const qq = String(frame.user_id);
    // 恢复码形如 XXXXX-XXXXX（字母 + 2-7 字符集），动态码是纯 6 位数字——靠格式区分，不靠猜。
    const isRecovery = /^[A-Za-z2-7]{5}-[A-Za-z2-7]{5}$/.test(cmd.token);
    if (isRecovery && state.flow.recoveryUsed.has(cmd.token.toUpperCase())) {
      sendReply(frame, '授权失败：这个恢复码已经用过了（一次性）');
      return true;
    }
    const result = isRecovery ? flowAuth.consumeRecoveryCode(qq, cmd.token) : flowAuth.consumeToken(qq, cmd.token);
    if (result.ok !== true) {
      sendReply(frame, '授权失败：' + (AUTH_FAIL_TEXT[result.reason] || result.reason));
      return true;
    }
    flowGate.remember(qq, result.grantId);
    if (isRecovery) {
      state.flow.recoveryUsed.add(cmd.token.toUpperCase());
      // 真一次性：用掉的那条哈希从配置里剔掉（否则重启后又能用一次）。
      const hashes = Array.isArray(CONFIG.flowAuth && CONFIG.flowAuth.recoveryHashes) ? CONFIG.flowAuth.recoveryHashes.slice() : [];
      const keep = hashes.filter((item, i) => i !== result.usedRecoveryIndex);
      if (keep.length !== hashes.length) {
        const patched = await writeFlowAuthPatch({ recoveryHashes: keep });
        if (patched.ok !== true) console.log(TAG + ' 恢复码哈希落盘失败（该码在重启前仍可用）：' + patched.error);
      }
    }
    const minutes = Math.max(1, Math.round((result.expiresAt - Date.now()) / 60000));
    const promptId = state.flow.promptIds.get(qq);
    state.flow.promptIds.delete(qq);
    await recallMessage(promptId);
    sendReply(frame, '已授权：' + result.purpose + '（' + minutes + ' 分钟内 1 次有效）\n'
      + '⚠️ 请撤回你刚发的那条动态码（我撤不了你的消息）。'
      + (isRecovery ? '\n恢复码已经用掉，对应的那条哈希我从设置里删了（万一写盘失败，才需要你去设置页手动删）。' : ''));
    resumeAfterAuth();
    return true;
  }

  /** /flow …：管理「流程脚本」（持久流的编排脚本），本身不执行任何工作。 */
  async function handleFlowCommand(frame, text) {
    const cmd = parseFlowCommand(text);
    if (cmd === null) return false;
    const action = cmd.action;
    const arg = cmd.arg;
    if (action === '' || action === 'help') { sendReply(frame, FLOW_HELP); return true; }
    if (action === 'ls' || action === 'list') {
      const flows = flowStore.list();
      if (flows.length === 0) { sendReply(frame, '还没有流程脚本（把 .js 放进 ' + flowStore.root + ' 就会出现在这里）。'); return true; }
      const lines = flows.map((item) => '· ' + item.name + (item.title === '' ? '' : '（' + item.title + '）')
        + ' ' + String(item.sha256).slice(0, 8));
      sendReply(frame, '流程脚本：\n' + lines.join('\n')
        + (state.flow.active === '' ? '' : '\n活动流程：' + state.flow.active));
      return true;
    }
    if (action === 'use' || action === 'switch') {
      if (arg === '') { sendReply(frame, '用法：/flow use <名字>'); return true; }
      const got = flowStore.read(arg);
      if (got.ok !== true) { sendReply(frame, '找不到可用流程：' + arg + '（' + flowReasonZh(got.reason) + '）'); return true; }
      state.flow.active = got.name;
      sendReply(frame, '活动流程已切到：' + got.name + '（' + got.script.length + ' 字符，sha ' + got.sha256.slice(0, 8) + '）');
      return true;
    }
    if (action === 'off' || action === 'clear') {
      state.flow.active = '';
      sendReply(frame, '已取消活动流程（后续不再带流程名）。');
      return true;
    }
    if (action === 'rm' || action === 'retire' || action === 'delete') {
      if (arg === '') { sendReply(frame, '用法：/flow rm <名字>'); return true; }
      const removed = flowStore.remove(arg);
      if (removed.ok !== true) { sendReply(frame, '删除失败：' + flowReasonZh(removed.reason)); return true; }
      if (state.flow.active === arg) state.flow.active = '';
      sendReply(frame, '已删除流程：' + arg);
      return true;
    }
    if (action === 'auth') {
      const result = await requestFlowAuth(arg === '' ? ('流程 ' + (state.flow.active || '临时任务')) : arg, null, frame);
      if (result.ok !== true) sendReply(frame, '没法发起授权：' + (AUTH_FAIL_TEXT[result.reason] || result.reason));
      return true;
    }
    if (action === 'unbind') {
      // 解绑等于把闸门整个拆掉，所以不能一行命令就做：必须先在私聊里交一次动态码或恢复码。
      // 验码复用授权状态机（锁定 / 重放 / 一次性都继承），通过后清空密钥与绑定标记。
      const secret = String((CONFIG.flowAuth === undefined || CONFIG.flowAuth === null ? '' : CONFIG.flowAuth.totpSecret) || '').trim();
      if (secret === '') { sendReply(frame, '当前没有绑定密钥（未绑定状态无需解绑）。'); return true; }
      if (arg === '') {
        sendReply(frame, '解绑要验证身份：/flow unbind <6位动态码>（或一次性的 XXXXX-XXXXX 恢复码）。\n'
          + '只发一条 /flow unbind 不会解绑——那样网页会话或拿到你手机的人就能把闸门拆掉。');
        return true;
      }
      const qq = String(frame.user_id);
      const issued = flowAuth.requestAuth(qq, 'unbind');
      if (issued.ok !== true) { sendReply(frame, '解绑申请被拒：' + (AUTH_FAIL_TEXT[issued.reason] || issued.reason)); return true; }
      const isRecovery = /^[A-Za-z2-7]{5}-[A-Za-z2-7]{5}$/.test(arg);
      const verdict = isRecovery ? flowAuth.consumeRecoveryCode(qq, arg) : flowAuth.consumeToken(qq, arg);
      if (verdict.ok !== true) { sendReply(frame, '解绑失败：' + (AUTH_FAIL_TEXT[verdict.reason] || verdict.reason)); return true; }
      flowAuth.takeGrant(verdict.grantId, qq);
      const written = await writeFlowAuthPatch({ totpSecret: '', enrolledAt: 0, recoveryHashes: [], recoverySalt: '' });
      flowAuth.reset();
      flowGate.forget(qq);
      state.flow.resume = null;
      state.flow.promptIds.clear();
      sendReply(frame, written.ok === true
        ? '已解绑：密钥、绑定标记与恢复码已清空，闸门保持开启但没有可用密钥，所有授权请求都会失败——重新绑定请跑 node lib/totp-cli.mjs enroll。'
        : '解绑已在内存生效，但落盘失败（' + written.error + '）：请到设置页手动清空 TOTP 密钥，否则重启后仍算已绑定。');
      return true;
    }
    if (action === 'reset') {
      flowAuth.reset();
      flowGate.forget(ownerQq());
      state.flow.resume = null;
      state.flow.promptIds.clear();
      sendReply(frame, '已清空所有待授权请求与未用授权。');
      return true;
    }
    sendReply(frame, '不认识的 /flow 指令。\n' + FLOW_HELP);
    return true;
  }

  /** 把 flowAuth 的若干字段写回 DSH 设置（走 settings 服务；失败返回可读原因）。 */
  async function writeFlowAuthPatch(patch) {
    let settings;
    try { settings = ctx.get('settings'); } catch (error) { settings = undefined; }
    if (settings === undefined || settings === null || typeof settings.describe !== 'function') {
      return { ok: false, error: '设置服务不可用' };
    }
    try {
      const listed = await settings.describe();
      const items = Array.isArray(listed) ? listed : (Array.isArray(listed.items) ? listed.items : []);
      const target = items.find((item) => item && (item.ns === 'dsh-qq-bot' || String(item.ns || '').endsWith('qq-bot')));
      if (target === undefined) return { ok: false, error: '找不到插件设置命名空间' };
      const payload = {};
      for (const key of Object.keys(patch)) payload[key] = patch[key];
      const wrapped = { flowAuth: payload };
      const service = settings;
      await service.update(target.ns, wrapped, target.revision);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  }

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

  /** 打包产物：优先 zip（-@ 从 stdin 读文件名），没有 zip 就退回 tar.gz。 */
  function packFlowFiles(dir, files) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    // 统一 ./ 前缀并丢掉含换行的名字：zip -@ 从 stdin 读文件名，裸的 -x / 带换行都可能被当成额外指令。
    const rel = artifactInputLines(files.map((file) => file.path.slice(dir.length + 1)));
    const zipPath = join(dir, 'qqbot-artifacts-' + stamp + '.zip');
    try {
      execFileSync('zip', ['-q', '-@', zipPath], { cwd: dir, input: rel.join('\n') + '\n', timeout: 120000 });
      return zipPath;
    } catch (error) {
      const tarPath = join(dir, 'qqbot-artifacts-' + stamp + '.tar.gz');
      try {
        execFileSync('tar', ['-czf', tarPath].concat(rel), { cwd: dir, timeout: 120000 });
        return tarPath;
      } catch (error2) {
        console.log(TAG + ' 打包产物失败：' + describeError(error2));
        return '';
      }
    }
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
  async function deliverFlowArtifacts(entry, frame) {
    const armedAt = entry.flowArmedAt;
    entry.flowArmedAt = undefined;
    if (armedAt === undefined || armedAt === null) return;
    const conf = CONFIG.flow || {};
    const deliver = String(conf.deliver === undefined || conf.deliver === null ? 'private' : conf.deliver);
    if (deliver === 'none') return;
    const maxFiles = Math.max(1, Math.floor(Number(conf.maxFiles) || 40));
    const maxBytes = Math.max(1024, Math.floor(Number(conf.maxBytes) || 20971520));
    let dir = '';
    let files = [];
    for (const candidate of artifactDirs(entry)) {
      const found = await listFreshFiles(candidate, armedAt, maxFiles, conf.skipHidden !== false);
      if (found.length > 0) { dir = candidate; files = found; break; }
    }
    if (files.length === 0) return;
    let total = 0;
    const picked = [];
    for (const file of files) {
      if (total + file.size > maxBytes) continue;
      total += file.size;
      picked.push(file);
    }
    if (picked.length === 0) return;
    const truncated = picked.length < files.length ? ('（超出上限，只打包了 ' + picked.length + '/' + files.length + ' 个）') : '';
    if (truncated !== '') console.log(TAG + ' 产物超出上限，只打包 ' + picked.length + '/' + files.length + ' 个文件');
    const packPath = packFlowFiles(dir, picked);
    if (packPath === '') return;
    const name = packPath.slice(dir.length + 1);
    const toGroup = deliver.indexOf('group:') === 0;
    const target = toGroup ? deliver.slice(6).trim() : ownerQq();
    if (target === '' || !/^\d+$/.test(target)) {
      console.log(TAG + ' 产物投递目标无效（' + deliver + '），跳过投递');
      return;
    }
    if (target === '') return;
    const action = toGroup ? 'upload_group_file' : 'upload_private_file';
    const params = toGroup
      ? { group_id: Number(target), file: packPath, name }
      : { user_id: Number(target), file: packPath, name };
    let delivered = false;
    let note = '';
    try {
      const result = await callAdapterAction(action, params, 120000);
      delivered = result.ok === true;
      if (delivered !== true) note = String(result.error === undefined ? (result.status === undefined ? '未知原因' : result.status) : result.error);
    } catch (error) {
      note = describeError(error);
    }
    if (delivered !== true) {
      console.log(TAG + ' 产物上传失败：' + note);
      sendReply(frame, '产物已打包但上传失败（协议端可能不支持文件上传，' + note + '），路径：' + packPath);
      return;
    }
    sendReply(frame, '产物已打包：' + name + '（' + picked.length + ' 个文件，' + total + ' 字节）' + truncated);
  }

  // 同会话处理顺序锁：到达时同步占位，处理完（消息已挂上会话队列）再释放。
  // 不这样做的话，getEntry / 查群成员鉴权这些 await 谁先完成谁先入队，连发两条会反着执行。
  const orderChains = new Map();
  function acquireOrder(key) {
    const prev = orderChains.get(key);
    let release = () => {};
    const mine = new Promise((resolve) => { release = resolve; });
    const chained = (prev === undefined ? Promise.resolve() : prev).then(() => mine);
    orderChains.set(key, chained);
    return () => {
      release();
      if (orderChains.get(key) === chained) orderChains.delete(key);
    };
  }

  async function acceptMessage(frame) {
    const isGroup = frame.message_type === 'group';
    const policy = isGroup ? CONFIG.group : CONFIG.private;
    const chatId = isGroup ? frame.group_id : frame.user_id;

    if (policy.enabled !== true) { state.stats.skipped += 1; return; }
    const selfId = frame.self_id === null || frame.self_id === undefined ? null : String(frame.self_id);
    if (selfId !== null && String(frame.user_id) === selfId) { state.stats.skipped += 1; return; }

    // 群管理指令优先：不要求 @ 机器人，也不会送给模型。
    if (isGroup) {
      const handled = await adminApi.handleAdminCommand(frame, typeof frame.text === 'string' ? frame.text : '');
      if (handled === true) return;
    }
    if (!allowlistOk(policy.allow, chatId)) { state.stats.skipped += 1; return; }
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
      const mention = selfId === null ? null : '@' + selfId;
      if (mention !== null) {
        if (text.includes(mention)) {
          text = text.split(mention).join(' ').trim();
          botMentioned = true;
          mentionHit = true;
        } else if (!repliedToBot) { state.stats.skipped += 1; return; }
      } else if (!text.includes('@') && !repliedToBot) { state.stats.skipped += 1; return; }
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

    const generation = entry.generation;
    // 入队时就把发言人钉住：排队期间新消息不会改动这一回合的身份判定。
    const turnSpeaker = { userId: String(frame.user_id), groupId: entry.groupId, tier: speakerAuthority.tier, owner: speakerAuthority.owner === true, sources: speakerAuthority.sources };
    entry.queue = entry.queue
      .then(() => runTurn(entry, frame, text, generation, allowDsh, botMentioned, turnSpeaker))
      .then(() => deliverFlowArtifacts(entry, frame))
      .catch((error) => {
        state.stats.errors += 1;
        console.error(TAG + ' ' + entryKey + ' 回合失败：' + describeError(error));
      });
    // 已挂上会话队列：顺序由 entry.queue 保证，这里释放顺序锁。
    releaseOrder();
  }

  /** 每个 QQ 会话只建一次 Agent；fixedTitle 非空时把新建会话名钉死（可选） */
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
      return { error: '（图片视觉：图片下载或识别失败，请稍后重试）', text: '' };
    }
    return { error: '', text: descriptions.join('\n'), paths: savedPaths };
  }

  /** 下载一张 http(s) 图片，返回 { data: Uint8Array, mediaType } 或 null。 */
  async function downloadImage(url, timeoutMs) {
    // 走 publicFetch：公网校验 + 逐跳校验 + 8MB 上限。
    // 图片 URL 来自消息里的 CQ 码（`[CQ:image,url=...]`）或协议端帧，属外部输入，
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
      const bytes = new Uint8Array(res.body);
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

  function buildPrompt(frame, text, entry) {
    const sender = frame.sender;
    const who = (sender !== null && sender !== undefined)
      ? (sender.card ? String(sender.card) : (sender.nickname ? String(sender.nickname) : '未知用户'))
      : '未知用户';
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
  function startInterimLoop(entry, frame, afterId) {
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
        if (sent >= maxPerTurn) break;
        if (spoken.has(item.id)) continue;
        spoken.add(item.id);
        sent += 1;
        // 不传 withQuote：中间发言不引用、也不 @ 任何人。
        sendReply(frame, item.text);
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

    // 中间发言：回合没跑完时，模型先说的那几句单独发出去（不引用、不 @）。
    const stopInterim = startInterimLoop(entry, frame, message.id);
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
      return;
    }
    sendReply(frame, reply, quoteReply === true);
    state.stats.replies += 1;

    // 会话结算：删除本会话缓存的图片目录（<QQ_msg>/qq-images/<会话id>/），
    // 图片仅用于本轮识图与联网查证，结算后不留残留；会话与工作区保留。
    if (Array.isArray(vision.paths) && vision.paths.length > 0) {
      const imgRoot = imageCacheDir(entry ? entry.sessionId : 'default');
      try {
        // 路径已由 safeSessionId 净化；删除前再复核一次归属，绝不递归删 QQ_msg 之外的东西。
        if (isInside(join(qqMsgRootSync(), 'qq-images'), imgRoot) !== true) {
          console.log(TAG + ' 图片缓存目录越界，拒绝删除：' + imgRoot);
        } else {
          await fsPromises.rm(imgRoot, { recursive: true, force: true });
        }
      } catch (cleanErr) {
        console.log(TAG + ' 图片缓存清理失败：' + describeError(cleanErr));
      }
    }
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

  /** 诊断：本轮为什么结束（从会话日志读 turn/end 原因） */
  /** 把 turn/end reason 清洗成一句话：只保留失败号（400/503/429…），隐藏 request id 等敏感内容 */
  function summarizeTurnReason(reason) {
    let code = '';
    try {
      if (reason !== null && typeof reason === 'object') {
        const err = reason.error;
        const msg = (err !== null && typeof err === 'object' && typeof err.message === 'string') ? err.message
          : (typeof err === 'string' ? err : '');
        const m = /^(\d{3})\s*:/.exec(msg);
        if (m !== null) code = m[1];
      } else if (typeof reason === 'string') {
        const m = /^(\d{3})\s*:/.exec(reason);
        if (m !== null) code = m[1];
      }
      return code !== '' ? code : '未知原因';
    } catch {
      return '未知原因';
    }
  }

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

  function chunkText(text, limit) {
    const max = (typeof limit === 'number' && limit > 0) ? limit : 1200;
    if (text.length <= max) return [text];
    const chunks = [];
    let rest = text;
    while (rest.length > max) {
      let cut = rest.lastIndexOf('\n', max);
      if (cut <= 0) cut = max;
      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).replace(/^\n+/, '');
    }
    if (rest.trim() !== '') chunks.push(rest.trim());
    return chunks;
  }

  /**
   * 发回复。withQuote=true 且是群聊时，用「QQ 回复消息流程」（引用触发消息）。
   * 注意：引用回复只在 bot 被点名（@ 了 bot 或回复了 bot）的响应上用；
   * 若对每条群消息都引用，requireAt 关闭时就会每条消息都引用回复。
   */
  /** 协议 id 归一：纯数字转 number，其余（qq-official 的 ROBOT1.0_… 之类）原样保留字符串。 */
  function idValue(value) {
    if (value === null || value === undefined) return undefined;
    const text = String(value);
    if (/^-?\d+$/.test(text) === true) {
      const num = Number(text);
      if (Number.isSafeInteger(num) === true) return num;
    }
    return text;
  }

  function sendReply(frame, text, withQuote) {
    const target = frame.message_type === 'group' ? frame.group_id : frame.user_id;
    if (target === null || target === undefined) return;
    const replyTo = (withQuote === true && frame.message_type === 'group'
      && frame.message_id !== null && frame.message_id !== undefined)
      ? idValue(frame.message_id) : undefined;
    for (const chunk of chunkText(String(text), CONFIG.reply.maxChars)) {
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

  const toolsApi = createTools({ getConfig: () => CONFIG, state, ctx, writeToAdapter, callAdapterAction, describeError, toId: adminApi.toId, entryForAgent: sessionApi.entryForAgent, resolveAuthority: adminApi.resolveAuthority, hasPerm: adminApi.hasPerm, describeAuthority: adminApi.describeAuthority, groupInScope: adminApi.groupInScope, permissionList: adminApi.PERMISSION_LIST, runWebSearch, fetchUrlViaProxy, meFindMoli, meMoliFetchText, runImageSearch, uploadToHost, imgSearchSoutubotFile, imgSearchTraceMoeFile, meIsAllowedImageFile, downloadImage, askVision, qqMsgRootSync, currentAdapterPath, ownerSettings, flowAuthApi });

  // -------------------------------------------------------------- 动态工具
  // 用动态 import 拿 defineTool：即使这个包不在，桥接本身照样工作，只是少一个工具。
  try {
    await toolsApi.registerTools();
  } catch (error) {
    console.log(TAG + ' 跳过 qqbot 工具注册：' + describeError(error));
  }

  // 配置热更新：cordis-plugin-loader 在 volatile 字段变化时不会重挂插件，只就地更新
  // 引用并发 'loader/volatile-update'（只有普通字段变化才会重挂，而本插件的可编辑字段
  // 全是 volatile）。所以这里自己刷新 CONFIG。
  // 只有「连接方式」那几项需要重启适配器；其它改动下一轮消息自然生效。
  let lastTransport = transportKey(CONFIG);
  const onVolatileUpdate = () => {
    try {
      CONFIG = resolveConfig();
      scheduleProactive();
      scheduleStaleCleanup(300);
      const next = transportKey(CONFIG);
      if (next === lastTransport) return;
      lastTransport = next;
      console.log(TAG + ' 连接配置已更新，重启适配器');
      stopAdapter();
      state.restarts = 0;
      ctx.timeout(() => { spawnAdapter(); }, 250);
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

  // 启动时把授权闸门状态写进日志：开了但没配密钥属于「开了却不生效」，必须一眼看见。
  if (flowEnabled()) {
    const secretReady = String((CONFIG.flowAuth && CONFIG.flowAuth.totpSecret) || '').trim() !== '';
    console.log(TAG + ' 流程授权已开启：' + (secretReady ? '密钥已配置' : '⚠️ 还没配 TOTP 密钥（node lib/totp-cli.mjs enroll）')
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
}
