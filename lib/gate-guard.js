/**
 * 闸门区改动的判定（GUI 里填码解锁 → 保存即消费；不保存就不应用）。
 *
 * 为什么放在纯函数里：这份名单决定「哪些工具必须过动态码」，判定必须能离网单测，
 * 不能埋在 settings 热更新回调里靠人肉点。
 *
 * 哪些改动要码：
 *   - 名单（gatedTools）变了，且动态码当前是开着的 → 要码；
 *   - 动态码开关本身变了（开 → 关，或 关 → 开）→ 要码。
 *     关掉闸门等于把整扇门拆了，不能比改名单更容易；打开闸门同样要一次码，
 *     否则拿到浏览器的人可以先关、改名单、再开，绕开名单保护。
 *   - 动态码没开、名单变了 → 不要码（关着的时候名单只是摆设）。
 *
 * 名单/开关没变：接受，但顺手把填进来的码清掉（码不落盘）。
 * 需要码却没码 / 码错 / 没配 secret：拒绝——调用方负责回滚名单与开关并清空码字段。
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
 * @param {boolean} input.previousEnabled 上一次被接受的 flowAuth.enabled
 * @param {boolean} input.nextEnabled     本次配置里的 flowAuth.enabled
 * @param {string[]} input.previous       上一次被接受的名单（内存基线）
 * @param {string[]} input.next           本次配置里的名单
 * @param {string} input.code             用户在「闸门区」填的 6 位码
 * @param {string} input.secret           TOTP secret（base32）
 * @param {number} [input.nowMs]          判定时间（测试注入）
 * @param {number} [input.window]         允许的窗口偏移，默认 ±1
 * @returns {{accept: boolean, changed: boolean, needsCode: boolean, clearCode: boolean, reason: string}}
 */
export function decideGateEdit(input) {
  const opts = (input !== null && typeof input === 'object') ? input : {};
  const previousEnabled = opts.previousEnabled === true;
  const nextEnabled = opts.nextEnabled === true;
  const previous = Array.isArray(opts.previous) ? opts.previous.map((item) => String(item)) : [];
  const next = Array.isArray(opts.next) ? opts.next.map((item) => String(item)) : [];
  const code = String(opts.code === undefined || opts.code === null ? '' : opts.code).trim();
  const enabledChanged = previousEnabled !== nextEnabled;
  const listChanged = sameToolList(previous, next) === false;
  const changed = enabledChanged || listChanged;
  if (changed === false) {
    return { accept: true, changed: false, needsCode: false, clearCode: code !== '', reason: 'unchanged' };
  }
  // 开 → 关、关 → 开：都要码（关掉闸门比改名单更狠，不能更容易）。
  // 名单改动：只有在闸门开着时才要码。
  const needsCode = enabledChanged === true ? true : previousEnabled === true;
  if (needsCode !== true) {
    return { accept: true, changed: true, needsCode: false, clearCode: code !== '', reason: 'gate-off' };
  }
  const secret = String(opts.secret === undefined || opts.secret === null ? '' : opts.secret).trim();
  if (secret === '') return { accept: false, changed: true, needsCode: true, clearCode: true, reason: 'no-secret' };
  if (code === '') return { accept: false, changed: true, needsCode: true, clearCode: false, reason: 'no-code' };
  const window = Number.isInteger(opts.window) ? opts.window : 1;
  const verdict = totpVerify(secret, code, { window, timeMs: opts.nowMs });
  if (verdict.ok !== true) return { accept: false, changed: true, needsCode: true, clearCode: true, reason: verdict.reason || 'bad-code' };
  return { accept: true, changed: true, needsCode: true, clearCode: true, reason: 'ok' };
}
