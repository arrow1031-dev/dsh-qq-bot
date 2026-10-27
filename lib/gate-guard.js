/**
 * 闸门名单改动的判定（GUI 里填码 → 保存即消费；不保存就不应用）。
 *
 * 为什么放在纯函数里：这条规则是安全边界（名单决定「哪些工具必须过动态码」），
 * 判定必须能离网单测，不能埋在 settings 热更新的回调里靠人肉点。
 *
 * 语义：
 *   - 名单没变：接受（顺手把填进来的码清掉，避免明文留存）；
 *   - 动态码没开：接受，不需要码（关着的时候这份名单只是摆设）；
 *   - 动态码开着：必须有 secret、必须填当前 6 位码（允许 ±1 个 30 秒窗口），
 *     通过才接受；否则拒绝——调用方负责回滚名单并清空码字段。
 */
import { totpVerify } from './totp.js';

/** 两份工具名单是否一致（顺序敏感：用户看到的顺序就是保存下来的顺序）。 */
export function sameToolList(a, b) {
  const left = Array.isArray(a) ? a.map((item) => String(item)) : [];
  const right = Array.isArray(b) ? b.map((item) => String(item)) : [];
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * @param {object} input
 * @param {boolean} input.enabled   flowAuth.enabled 的当前值
 * @param {string[]} input.previous 上一次被接受的名单（内存基线）
 * @param {string[]} input.next     本次配置里的名单
 * @param {string} input.code       用户在「闸门区」填的 6 位码
 * @param {string} input.secret     TOTP secret（base32）
 * @param {number} [input.nowMs]    判定时间（测试注入）
 * @param {number} [input.window]   允许的窗口偏移，默认 ±1
 * @returns {{accept: boolean, changed: boolean, clearCode: boolean, reason: string}}
 */
export function decideGateEdit(input) {
  const opts = (input !== null && typeof input === 'object') ? input : {};
  const previous = Array.isArray(opts.previous) ? opts.previous.map((item) => String(item)) : [];
  const next = Array.isArray(opts.next) ? opts.next.map((item) => String(item)) : [];
  const code = String(opts.code === undefined || opts.code === null ? '' : opts.code).trim();
  const changed = sameToolList(previous, next) === false;
  if (changed === false) {
    // 名单没动：填了码也清掉（码是改名单用的，不该因为别的原因留在配置里）。
    return { accept: true, changed: false, clearCode: code !== '', reason: 'unchanged' };
  }
  if (opts.enabled !== true) {
    return { accept: true, changed: true, clearCode: code !== '', reason: 'gate-off' };
  }
  const secret = String(opts.secret === undefined || opts.secret === null ? '' : opts.secret).trim();
  if (secret === '') return { accept: false, changed: true, clearCode: true, reason: 'no-secret' };
  if (code === '') return { accept: false, changed: true, clearCode: false, reason: 'no-code' };
  const window = Number.isInteger(opts.window) ? opts.window : 1;
  const verdict = totpVerify(secret, code, { window, timeMs: opts.nowMs });
  if (verdict.ok !== true) return { accept: false, changed: true, clearCode: true, reason: verdict.reason || 'bad-code' };
  return { accept: true, changed: true, clearCode: true, reason: 'ok' };
}
