/**
 * 组装根（composition root）—— 按优先级把各层装成一台可运行的插件。
 *
 * 这里**不放业务逻辑**，只做两件事：
 *   1. 按 STAGE 表把阀门依次成型（网络 → 安全 → 工具），保证「越靠近请求入口越先就位」；
 *   2. 把成型结果连同装配顺序交回网关（gateway/plugin.js），供启动日志与排障使用。
 *
 * 为什么需要它：三个阀门各自独立、可以单独单测，但跑起来时顺序不能乱——
 * 工具阀消费安全阀发出的授权，安全阀的判定又必须在任何出网之前成立。
 * 把顺序写死在调用方（apply）里，等于让「谁先谁后」散落在两千行闭包中；
 * 收到这里之后，调整优先级只改 valve/index.js 的一张表。
 *
 * 装配顺序（与 valve/index.js 的 STAGE 表一致）：
 *
 *   NETWORK(10) → SECURITY(20) → TOOL(30) → MESSAGE(40) → GATEWAY(50) → TRANSPORT(60)
 *   └ 出网策略    └ 身份授权     └ 工具闸门    └ 消息组装     └ 路由分发      └ 协议适配
 *
 * 前三个由本文件装配；后三个在网关内部按同一顺序创建（消息组装只依赖配置，
 * 网关依赖前面全部，传输层最后拉起进程/连接）。
 */

import { STAGE, orderedValves, createNetworkValve, createSecurityValve, createToolValve } from './valve/index.js';

/** 全链路装配顺序（含非阀门层），启动日志与文档都读它。 */
export const ASSEMBLY_ORDER = Object.freeze([
  { stage: STAGE.NETWORK, layer: 'valve/network', summary: '出网策略：公网判定 / 内网黑名单 / 钉地址 / 代理语义' },
  { stage: STAGE.SECURITY, layer: 'valve/security', summary: '身份授权：动态码 / 流程授权 / 历史鉴权 / 拥有者通道' },
  { stage: STAGE.TOOL, layer: 'valve/tool', summary: '工具闸门：名单判定 / 调用拦截 / 改闸门要码' },
  { stage: STAGE.MESSAGE, layer: 'message', summary: '消息组装：分条 / 流式 / 中间发言 / 段构造 / 去重' },
  { stage: STAGE.GATEWAY, layer: 'gateway', summary: '网关路由：入站分发 / 出站投递 / 路由挂载 / 指令解析' },
  { stage: STAGE.TRANSPORT, layer: 'transport', summary: '协议适配：OneBot 11/12 / Satori / Milky / 官方 Bot' },
]);

/**
 * 表自检：stage 必须唯一、每个阀门都得在 ASSEMBLY_ORDER 里登记过。
 * 以前没人查这两件事——stage 撞车会静默通过，新增阀门漏登记也不会有人报错。
 */
function assertAssemblyTable() {
  const seen = new Set();
  for (const valve of orderedValves()) {
    if (seen.has(valve.stage)) {
      throw new Error('阀门装配表错误：stage ' + String(valve.stage) + ' 被多个阀门占用（' + valve.name + '）');
    }
    seen.add(valve.stage);
  }
  const known = new Set(ASSEMBLY_ORDER.map((item) => item.stage));
  for (const valve of orderedValves()) {
    if (known.has(valve.stage) !== true) {
      throw new Error('阀门装配表错误：' + valve.name + ' 的 stage ' + String(valve.stage) + ' 没有在 ASSEMBLY_ORDER 里登记');
    }
  }
}

/**
 * 按优先级装配三道阀门。
 *
 * @param {object} deps
 * @param {() => Record<string, any>} deps.config     每次现取配置（支持热更新）
 * @param {(line: Record<string, any>) => void} [deps.audit]    安全阀的审计回调
 * @param {string} [deps.flowRoot]       流程脚本目录
 * @param {() => boolean} [deps.flowEnabled] 动态码总开关（缺省读配置）
 * @param {() => string[]} [deps.gatedTools] 受闸门工具名单（缺省读配置）
 * @param {() => string} [deps.proxy]    出网代理（'' = 直连）
 * @param {(line: string) => void} [deps.log]
 * @returns {{order: string[], network: Record<string, any>, security: Record<string, any>, tool: object}}
 */
export function assembleValves(deps) {
  const config = typeof deps.config === 'function' ? deps.config : () => ({});
  const log = typeof deps.log === 'function' ? deps.log : () => {};

  // 按 stage 升序逐个成型；每个阀门只拿它声明依赖的那几个（依赖表见 valve/index.js）。
  assertAssemblyTable();
  const built = new Map();
  for (const valve of orderedValves()) {
    for (const dep of valve.dependsOn) {
      if (built.has(dep) !== true) {
        throw new Error('阀门装配顺序错误：' + valve.name + ' 依赖 ' + dep + '，但后者尚未成型');
      }
    }
    if (valve.name === 'network') {
      built.set('network', createNetworkValve({
        proxy: typeof deps.proxy === 'function' ? deps.proxy : () => '',
        log,
      }));
      continue;
    }
    if (valve.name === 'security') {
      built.set('security', createSecurityValve({
        config,
        audit: deps.audit,
        flowRoot: deps.flowRoot,
      }));
      continue;
    }
    if (valve.name === 'tool') {
      const security = built.get('security');
      if (security === undefined || security === null) {
        throw new Error('阀门装配顺序错误：tool 依赖 security，但 security 没有先成型');
      }
      built.set('tool', createToolValve({
        auth: security.flowAuth,
        enabled: typeof deps.flowEnabled === 'function' ? deps.flowEnabled : security.enabled,
        gatedTools: typeof deps.gatedTools === 'function' ? deps.gatedTools : security.gatedTools,
      }));
      continue;
    }
    throw new Error('未知阀门：' + valve.name);
  }

  return {
    order: orderedValves().map((valve) => valve.name),
    network: built.get('network'),
    security: built.get('security'),
    tool: built.get('tool'),
  };
}

/** 一行启动日志：装配顺序 + 每层职责，排障时先看这一行。 */
export function describeAssembly() {
  return '装配顺序 ' + ASSEMBLY_ORDER.map((item) => item.stage + ':' + item.layer).join(' → ');
}

export { STAGE };
