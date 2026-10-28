/**
 * 阀门层注册表 —— 只声明「有哪几道阀门、谁先成型、依赖谁」，不实现任何判定。
 *
 * 为什么要有这一层：三个阀门各自独立、可以单独单测，但插件跑起来时它们的**成型顺序**
 * 不能随便——网络阀门决定出站策略，安全阀依赖配置与审计通道，工具阀消费安全阀发出的授权。
 * 顺序写在这里，组装根（assemble.js）照着执行；想调整优先级只改这张表。
 *
 * 约定：数值越小越先成型，且越小越靠近请求入口（越早拦）。
 *   NETWORK(10) → SECURITY(20) → TOOL(30) → MESSAGE(40) → GATEWAY(50) → TRANSPORT(60)
 * 阀门之外的分层（message / gateway / transport）也登记在 STAGE 里，因为它们是同一根装配链。
 */

export const STAGE = Object.freeze({
  /** 网络阀门：任何出网动作之前必须就位。 */
  NETWORK: 10,
  /** 安全阀：任何特权动作之前必须就位。 */
  SECURITY: 20,
  /** 工具阀：消费安全阀发的授权，必须排在它之后。 */
  TOOL: 30,
  /** 消息组装：分条 / 流式 / 中间发言，只依赖配置。 */
  MESSAGE: 40,
  /** 网关路由：入站 → 会话 → 出站，依赖上面全部。 */
  GATEWAY: 50,
  /** 协议适配：最外层，最后拉起（进程/连接）。 */
  TRANSPORT: 60,
});

/** 阀门清单（名字 -> 成型顺序），组装根与文档都读这张表。 */
export const VALVES = Object.freeze([
  { name: 'network', stage: STAGE.NETWORK, dependsOn: [], summary: '出网策略：公网判定、内网黑名单、钉地址、代理语义、本地校验代理' },
  { name: 'security', stage: STAGE.SECURITY, dependsOn: [], summary: '身份与授权：TOTP 动态码、流程授权、历史跨会话鉴权、拥有者通道' },
  { name: 'tool', stage: STAGE.TOOL, dependsOn: ['security'], summary: '工具闸门：名单判定、调用拦截、改闸门要码' },
]);

/** 按成型顺序排好的阀门清单（组装根照这个顺序装）。 */
export function orderedValves() {
  return VALVES.slice().sort((a, b) => a.stage - b.stage);
}

export { createNetworkValve } from './network/index.js';
export { createSecurityValve } from './security/index.js';
export { createToolValve } from './tool/index.js';
