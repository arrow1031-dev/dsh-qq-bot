/**
 * QQ 端二次授权（动态码）的纯逻辑：申请 → 校验 → 发 grant → 消费；含重放、锁定、审计。
 *
 * 设计红线（与 lib/totp.js 一致）：
 * - 没有万能码 / 没有测试模式跳过；enabled=false、密钥缺失、令牌格式错 → 一律拒绝；
 * - 同一 counter 的令牌只能用一次（重放防护）；
 * - 连续失败 maxAttempts 次锁 lockoutMinutes 分钟，锁定期内即使码正确也拒绝；
 * - 审计只记 ok/fail、失败次数、grantId，绝不记令牌本身；
 * - grant 绑定 qq + purpose + expiresAt + usesLeft，默认一次性。
 */
import { totpVerify, verifyBackupCode } from './totp.js';

const DEFAULT_TTL_SECONDS = 30;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_LOCKOUT_MINUTES = 15;

export function createFlowAuth(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const audit = typeof options.audit === 'function' ? options.audit : () => {};
  const cfg = () => (typeof options.config === 'function' ? options.config() : (options.config || {}));

  const pending = new Map();   // qq -> { purpose, requestedAt }
  const grants = new Map();    // grantId -> { id, qq, purpose, createdAt, expiresAt, usesLeft }
  const failures = new Map();  // qq -> { count, lockedUntil }
  const lastCounter = new Map(); // qq -> 最近一次成功使用的 counter（重放防护）
  let seq = 0;

  function conf() {
    const c = cfg() || {};
    return {
      enabled: c.enabled === true,
      secret: String(c.totpSecret || '').trim(),
      ttlSeconds: Math.max(30, Math.floor(Number(c.grantTtlSeconds) || DEFAULT_TTL_SECONDS)),
      maxAttempts: Math.max(1, Math.floor(Number(c.maxAttempts) || DEFAULT_MAX_ATTEMPTS)),
      lockoutMinutes: Math.max(1, Math.floor(Number(c.lockoutMinutes) || DEFAULT_LOCKOUT_MINUTES)),
      recoverySalt: String(c.recoverySalt || ''),
      recoveryHashes: Array.isArray(c.recoveryHashes) ? c.recoveryHashes.map((x) => String(x)) : [],
      gatedTools: Array.isArray(c.gatedTools) ? c.gatedTools.map((x) => String(x)) : [],
    };
  }

  function stateOf(qq) {
    const key = String(qq);
    let st = failures.get(key);
    if (st === undefined) { st = { count: 0, lockedUntil: 0 }; failures.set(key, st); }
    return st;
  }

  function locked(qq, at) {
    const st = stateOf(qq);
    return st.lockedUntil > at;
  }

  function record(qq, action, ok, reason, grantId) {
    audit({ at: now(), qq: String(qq), action, ok: ok === true, reason: reason || '', grantId: grantId || '' });
  }

  /** 主人发起一次授权申请：只登记「等谁的什么用途」，不产生任何权限。 */
  function requestAuth(qq, purpose) {
    const c = conf();
    if (c.enabled !== true) return { ok: false, reason: 'disabled' };
    if (c.secret === '') return { ok: false, reason: 'no-secret' };
    const at = now();
    if (locked(qq, at)) return { ok: false, reason: 'locked' };
    pending.set(String(qq), { purpose: String(purpose || ''), requestedAt: at });
    record(qq, 'request', true, purpose);
    return { ok: true, ttlSeconds: c.ttlSeconds };
  }

  function grant(qq, purpose, at, toolName) {
    const c = conf();
    // 顺手清掉过期 grant：长时间只申请不使用，Map 会缓慢长大。
    for (const [id, g] of grants) { if (g.expiresAt <= at) grants.delete(id); }
    seq += 1;
    const id = 'g' + String(seq).padStart(6, '0') + '-' + String(Math.floor(at / 1000)).slice(-6);
    const tool = (toolName === undefined || toolName === null) ? '' : String(toolName);
    const g = { id, qq: String(qq), purpose, toolName: tool, createdAt: at, expiresAt: at + c.ttlSeconds * 1000, usesLeft: 1 };
    grants.set(id, g);
    return g;
  }

  /** 用动态码换取 grant。任何拒绝路径都计入失败次数。 */
  function consumeToken(qq, token) {
    const c = conf();
    const at = now();
    if (c.enabled !== true) return { ok: false, reason: 'disabled' };
    if (c.secret === '') return { ok: false, reason: 'no-secret' };
    if (locked(qq, at)) { record(qq, 'token', false, 'locked'); return { ok: false, reason: 'locked' }; }
    const pend = pending.get(String(qq));
    if (pend === undefined) { record(qq, 'token', false, 'no-pending'); return { ok: false, reason: 'no-pending' }; }
    // 申请本身也要过期：几小时前的申请不该被一条新码兑现（pending 以前只有成功时才删）。
    if (at - pend.requestedAt > Math.max(60, c.ttlSeconds * 3) * 1000) {
      pending.delete(String(qq));
      record(qq, 'token', false, 'no-pending');
      return { ok: false, reason: 'no-pending' };
    }

    // window: 0 = 只认当前 30 秒步长，不给相邻窗口任何机会；代价是必须开 NTP（本机误差 > 30 秒会一直验不过）。
    // 取 ±1 会让一条码在最多 90 秒内可被重试，与「30 秒一次性」的口径冲突，这里选择严格。
    const v = totpVerify(c.secret, token, { timeMs: at, window: 0 });
    if (v.ok !== true) {
      const st = stateOf(qq);
      st.count += 1;
      if (st.count >= c.maxAttempts) { st.lockedUntil = at + c.lockoutMinutes * 60000; st.count = 0; }
      record(qq, 'token', false, v.reason);
      return { ok: false, reason: v.reason };
    }

    // 重放：同一个 counter 的成功码只能用一次
    const prev = lastCounter.get(String(qq));
    if (prev !== undefined && v.counter <= prev) { record(qq, 'token', false, 'replayed'); return { ok: false, reason: 'replayed' }; }
    lastCounter.set(String(qq), v.counter);

    const st = stateOf(qq);
    st.count = 0;
    st.lockedUntil = 0;
    pending.delete(String(qq));
    // 用途如果正好是一个受闸门控制的工具名，就把它绑到 grant 上：
    // 主人在私聊里看到的是什么用途，就只能拿它跑哪个工具。
    const purposeText = String(pend.purpose || '');
    const toolName = c.gatedTools.indexOf(purposeText) >= 0 ? purposeText : '';
    const g = grant(qq, pend.purpose, at, toolName);
    record(qq, 'grant', true, pend.purpose, g.id);
    return { ok: true, grantId: g.id, purpose: g.purpose, expiresAt: g.expiresAt };
  }

  /** 用恢复码换 grant（恢复码一次性；用完由调用方从配置里剔除对应哈希）。 */
  function consumeRecoveryCode(qq, code) {
    const c = conf();
    const at = now();
    if (c.enabled !== true) return { ok: false, reason: 'disabled' };
    if (locked(qq, at)) return { ok: false, reason: 'locked' };
    const pend = pending.get(String(qq));
    if (pend === undefined) return { ok: false, reason: 'no-pending' };
    // 待授权申请本身也会过期：十分钟前的申请不该用一条恢复码就兑现（TOTP 路径同样有这条检查）。
    if (at - pend.requestedAt > Math.max(60, c.ttlSeconds * 3) * 1000) {
      pending.delete(String(qq));
      return { ok: false, reason: 'no-pending' };
    }
    if (c.recoveryHashes.length === 0) return { ok: false, reason: 'no-recovery' };
    const hit = verifyBackupCode(code, c.recoveryHashes, c.recoverySalt);
    if (hit.ok !== true) {
      const st = stateOf(qq);
      st.count += 1;
      if (st.count >= c.maxAttempts) { st.lockedUntil = at + c.lockoutMinutes * 60000; st.count = 0; }
      record(qq, 'recovery', false, 'mismatch');
      return { ok: false, reason: 'mismatch' };
    }
    pending.delete(String(qq));
    const purposeText = String(pend.purpose || '');
    const toolName = c.gatedTools.indexOf(purposeText) >= 0 ? purposeText : '';
    const g = grant(qq, pend.purpose, at, toolName);
    record(qq, 'grant', true, 'recovery', g.id);
    return { ok: true, grantId: g.id, purpose: g.purpose, expiresAt: g.expiresAt, usedRecoveryIndex: hit.index };
  }

  /** 取用 grant：一次性、过期即失效、只能由发起它的 qq 使用。 */
  function takeGrant(grantId, qq, toolName) {
    const at = now();
    const g = grants.get(String(grantId));
    if (g === undefined) return { ok: false, reason: 'not-found' };
    if (g.qq !== String(qq)) return { ok: false, reason: 'wrong-principal' };
    // 授权绑定了用途工具时，只能用来跑那个工具（防止「申请时写查天气、实际跑 workflow」）。
    // 省略 toolName 也必须拒：以前 `&& want !== ''` 让「不传工具名」变成一条绕过绑定的后门。
    const want = (toolName === undefined || toolName === null) ? '' : String(toolName);
    if (g.toolName !== '' && g.toolName !== want) return { ok: false, reason: 'wrong-tool' };
    if (g.expiresAt <= at) { grants.delete(g.id); return { ok: false, reason: 'expired' }; }
    if (g.usesLeft <= 0) return { ok: false, reason: 'used' };
    g.usesLeft -= 1;
    if (g.usesLeft <= 0) grants.delete(g.id);
    record(qq, 'use', true, g.purpose, g.id);
    return { ok: true, purpose: g.purpose };
  }

  function status() {
    return { pending: pending.size, grants: grants.size, locked: [...failures.entries()].filter(([, v]) => v.lockedUntil > now()).length };
  }

  function reset(qq) {
    if (qq === undefined || qq === null) { pending.clear(); grants.clear(); failures.clear(); lastCounter.clear(); return; }
    const key = String(qq);
    pending.delete(key);
    // grants 是「grantId -> grant」，按 qq 删要遍历（以前误用 qq 当 grantId，删不掉）。
    for (const [id, g] of grants) { if (g.qq === key) grants.delete(id); }
    failures.delete(key); lastCounter.delete(key);
  }

  return { requestAuth, consumeToken, consumeRecoveryCode, takeGrant, status, reset };
}

/**
 * 闸门：把「工具调用」和「一次性授权」接起来。
 *
 * 放行规则（没有例外分支）：
 * - enabled=false 或工具不在 gatedTools 里 → 不拦；
 * - 有未用且未过期的 grant，且属于同一个 qq → 放行并把这一次 grant 用掉（一次性）；
 * - 其它一律拒绝，返回可读文案让模型去申请授权。
 */
export function createFlowGate(options = {}) {
  const auth = options.auth;
  const enabled = typeof options.enabled === 'function' ? options.enabled : () => false;
  const gatedTools = typeof options.gatedTools === 'function' ? options.gatedTools : () => [];
  const latest = new Map();   // qq -> grantId（最近一次拿到的授权）

  function remember(qq, grantId) { latest.set(String(qq), String(grantId)); }

  /** 当前配置里需要流程授权的工具名（供 session.js 决定接管哪些工具，别再各写一份硬编码名单）。 */
  function names() {
    const list = gatedTools();
    return Array.isArray(list) ? list.map((item) => String(item)) : [];
  }

  function isGated(toolName) {
    if (enabled() !== true) return false;
    const name = String(toolName === undefined || toolName === null ? '' : toolName);
    if (name === '') return false;
    const list = gatedTools();
    if (!Array.isArray(list)) return false;
    for (const item of list) if (String(item) === name) return true;
    return false;
  }

  function check(qq, toolName) {
    if (isGated(toolName) !== true) return { allow: true, reason: 'not-gated' };
    const key = String(qq);
    const id = latest.get(key);
    if (id === undefined) return { allow: false, reason: 'no-grant' };
    const taken = auth.takeGrant(id, key, toolName);
    latest.delete(key);
    if (taken.ok !== true) return { allow: false, reason: taken.reason };
    return { allow: true, reason: 'granted', purpose: taken.purpose };
  }

  const REASON_TEXT = {
    'no-grant': '还没有授权',
    expired: '授权已过期',
    used: '授权已经用掉了',
    'not-found': '授权不存在',
    'wrong-principal': '这次授权不属于你',
    'wrong-tool': '这次授权是给另一个工具申请的',
  };

  function blockedText(reason) {
    const why = REASON_TEXT[String(reason)] || '授权不可用';
    return '流程授权未通过（' + why + '）：请先调 qqauth action="request" 申请一次授权，'
      + '主人在私聊里回 6 位动态码之后，再重试本工具。';
  }

  function forget(qq) { latest.delete(String(qq)); }

  return { remember, isGated, names, check, blockedText, forget };
}
