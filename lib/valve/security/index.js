/**
 * 安全阀（security valve）—— 身份、动态码、授权与审计的唯一入口。
 *
 * 为什么把它做成一个独立模块：本插件里「谁可以做什么」散落在四个地方
 * （TOTP 校验、流程授权、拥有者设置通道、历史消息跨会话鉴权）。它们共享同一套红线，
 * 却各自持有状态；一旦有人只改一处，就会出现「这个入口要码、那个入口不要」的裂缝。
 * 这里把四件事收进一个门面，红线集中写在下面，谁调用都走同一份判定。
 *
 * 红线（与 totp.js 一致，任何一条都不许为了「好用」放宽）：
 *   - 没有万能码、没有测试模式、没有跳过开关；密钥缺失或格式非法一律 fail-closed；
 *   - 同一 counter 的令牌只能用一次（重放防护）；连续失败达上限即锁定；
 *   - 身份只取自当前会话，绝不接受工具参数里的 QQ 号；
 *   - 审计只记 ok/fail、失败次数、grantId，绝不记令牌本身。
 *
 * 本模块只做「判定与授权状态」，不发消息、不写业务配置：需要落盘的动作由调用方
 * 通过 settings 服务完成（见 owner-settings.js 的 apply）。
 */

import { createFlowAuth } from './flow-auth.js';
import { createFlowStore } from './flow-store.js';
import { totpVerify, verifyBackupCode } from './totp.js';
import { judgeHistoryAccess } from './history-auth.js';
import { checkCaller } from './owner-settings.js';

/** 阀门在组装顺序里的位置（数值越小越先成型）。 */
export const VALVE_STAGE = 20;

/**
 * @param {object} deps
 * @param {() => object} deps.config 每次现取配置（支持热更新），返回 { flowAuth?: {...} }
 * @param {(line: object) => void} [deps.audit] 审计回调（只收结构化的 ok/fail 记录）
 * @param {string} [deps.flowRoot] 流程脚本目录（/flow ls 读这里）
 */
export function createSecurityValve(deps) {
  const config = typeof deps.config === 'function' ? deps.config : () => ({});
  const audit = typeof deps.audit === 'function' ? deps.audit : () => {};

  /** 流程授权配置（永远是对象，缺省空）。 */
  const flowConfig = () => {
    const cfg = config();
    const section = (cfg === null || cfg === undefined) ? undefined : cfg.flowAuth;
    return (section === null || section === undefined) ? {} : section;
  };

  /** 动态码总开关。关着的时候闸门只是摆设——但「关掉闸门」本身要码（见 tool/gate-guard.js）。 */
  const enabled = () => flowConfig().enabled === true;

  /** 当前需要过闸门的工具名（配置里那一份，去重前的原始顺序）。 */
  const gatedTools = () => {
    const list = flowConfig().gatedTools;
    return Array.isArray(list) ? list.map((item) => String(item)) : [];
  };

  const flowAuth = createFlowAuth({ config: flowConfig, audit });
  const flowStore = (typeof deps.flowRoot === 'string' && deps.flowRoot !== '')
    ? createFlowStore({ root: deps.flowRoot })
    : null;

  return Object.freeze({
    stage: VALVE_STAGE,
    /** 流程授权（申请 / 消费 / 恢复码 / 状态）。 */
    flowAuth,
    /** 流程脚本只读视图；没给 flowRoot 时为 null。 */
    flowStore,
    enabled,
    gatedTools,
    /** 校验一次性动态码（/auth）。fail-closed：密钥缺失直接 false。 */
    verifyToken: (secret, token, options) => totpVerify(secret, token, options),
    /** 校验恢复码（哈希表比对）。 */
    verifyRecovery: (code, hashes, salt) => verifyBackupCode(code, hashes, salt),
    /** 跨会话读历史的鉴权（拥有者 / 高级管理员 / 群管理员三档）。 */
    judgeHistory: (input) => judgeHistoryAccess(input),
    /** qqconfig 通道的调用者判定（只在与拥有者的私聊里放行）。 */
    checkOwnerCaller: (cfg, entry) => checkCaller(cfg, entry),
  });
}
