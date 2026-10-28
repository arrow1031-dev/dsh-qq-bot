/**
 * 工具阀（tool valve）—— 哪些工具必须先过动态码，以及「调用那一刻」的拦截。
 *
 * 与安全阀的分工：
 *   security 阀回答「你是谁、你手上这张授权卡是不是真的」；
 *   tool 阀回答「这个工具要不要卡、这张卡能不能用在这个工具上」。
 * 所以本模块持有闸门状态机（谁刚拿到授权、授权绑了哪个工具），但不持有密钥、不校验 TOTP
 * ——它只消费 security 阀给出的 grant。
 *
 * 三件事收在这里，避免各写一份：
 *   1. 名单判定（isGated）：配置里 gatedTools ∩ 动态码开关；
 *   2. 调用拦截（check）：一次授权只能用一次，用完即销；
 *   3. 改闸门本身的判定（decideEdit）：改名单 / 关开关都要码——关掉闸门不能比改名单更容易。
 *
 * 纯逻辑 + 注入依赖，可离网单测（test-flow-gate.mjs / test-gate-guard.mjs）。
 */

import { createFlowGate } from '../security/flow-auth.js';
import { decideGateEdit, sameToolList } from './gate-guard.js';

/** 阀门在组装顺序里的位置（在安全阀之后：它消费安全阀发的授权）。 */
export const VALVE_STAGE = 30;

/**
 * @param {object} deps
 * @param {object} deps.auth           安全阀的 flowAuth（申请 / 消费 / 作废授权）
 * @param {() => boolean} deps.enabled 动态码总开关
 * @param {() => string[]} deps.gatedTools 当前名单
 */
export function createToolValve(deps) {
  const enabled = typeof deps.enabled === 'function' ? deps.enabled : () => false;
  const gatedTools = typeof deps.gatedTools === 'function' ? deps.gatedTools : () => [];

  const gate = createFlowGate({ auth: deps.auth, enabled, gatedTools });

  return Object.freeze({
    stage: VALVE_STAGE,
    /** 底层闸门（会话侧接管工具时需要 isGated/names，保持同一份状态）。 */
    gate,
    /** 该工具此刻是否需要授权。 */
    isGated: (toolName) => gate.isGated(toolName),
    /** 名单快照（给会话接管与启动日志用）。 */
    names: () => gate.names(),
    /** 调用拦截：返回 { allow, reason, purpose? }；放行即消费掉这次授权。 */
    check: (qq, toolName) => gate.check(qq, toolName),
    /** 记下「这个 QQ 刚拿到一张授权卡」（/auth 校验通过后调用）。 */
    remember: (qq, grantId) => gate.remember(qq, grantId),
    /** 忘掉该 QQ 的授权（重置 / 解绑）。 */
    forget: (qq) => gate.forget(qq),
    /** 被拦下时发给用户的中文说法（含下一步该做什么，不泄露内部状态）。 */
    blockedText: (reason) => gate.blockedText(reason),
    /** 闸门拦下某工具时转记一笔，授权申请据此把 grant 绑到工具名上。 */
    noteBlocked: (qq, toolName) => gate.noteBlocked(qq, toolName),
    /** 改闸门区（GUI 保存设置时）：要不要码、接受还是拒绝。 */
    decideEdit: (input) => decideGateEdit(input),
    /** 两份名单是否一致（顺序敏感）。 */
    sameToolList,
  });
}
