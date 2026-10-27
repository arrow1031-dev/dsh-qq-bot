#!/usr/bin/env node
/**
 * 闸门区改动的判定（GUI 填码解锁 → 保存即消费；不保存不应用）。
 *
 *   node test-gate-guard.mjs
 *
 * 守的安全边界：
 *   - 动态码关着、名单变化 → 不要码（关着时名单只是摆设）；
 *   - 动态码开着、名单变化 → 要码；
 *   - 动态码开关本身变化（开↔关）→ 要码（否则「先关、改名单、再开」能绕过名单保护）；
 *   - 没码 / 错码 / 没配 secret 一律拒绝（调用方回滚名单与开关并清码）；
 *   - 什么都没变 → 接受，但顺手把填进来的码清掉（码不落盘）。
 */
import { sameToolList, decideGateEdit } from '../lib/gate-guard.js';
import { generateSecret, totp } from '../lib/totp.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail === '' ? '' : ' — ' + detail)); }
}

const secret = generateSecret(20);
const now = 1700000000000;
const prev = ['subagent', 'moli_fetch'];
const next = ['subagent', 'moli_fetch', 'workflow'];
const code = totp(secret, { timeMs: now });

console.log('1. 名单比较（顺序敏感）');
check('内容相同 → true', sameToolList(['a', 'b'], ['a', 'b']) === true);
check('顺序不同 → false', sameToolList(['a', 'b'], ['b', 'a']) === false);
check('长度不同 → false', sameToolList(['a'], ['a', 'b']) === false);

console.log('\n2. 动态码关着：改名单不需要码');
{
  const r = decideGateEdit({ previousEnabled: false, nextEnabled: false, previous: prev, next, code: '', secret, nowMs: now });
  check('接受改动', r.accept === true && r.changed === true && r.needsCode === false, JSON.stringify(r));
  check('没填码就不需要清码', r.clearCode === false, JSON.stringify(r));
}

console.log('\n3. 动态码开着：改名单没码 / 错码一律拒绝');
{
  const noCode = decideGateEdit({ previousEnabled: true, nextEnabled: true, previous: prev, next, code: '', secret, nowMs: now });
  check('没码 → 拒绝', noCode.accept === false && noCode.reason === 'no-code', JSON.stringify(noCode));
  const bad = decideGateEdit({ previousEnabled: true, nextEnabled: true, previous: prev, next, code: '000000', secret, nowMs: now });
  check('错码 → 拒绝并清码', bad.accept === false && bad.clearCode === true, JSON.stringify(bad));
  const noSecret = decideGateEdit({ previousEnabled: true, nextEnabled: true, previous: prev, next, code: code, secret: '', nowMs: now });
  check('没配 secret → 拒绝', noSecret.accept === false && noSecret.reason === 'no-secret', JSON.stringify(noSecret));
}

console.log('\n4. 动态码开着：对码（同一窗口）接受，并标记清码');
{
  const ok = decideGateEdit({ previousEnabled: true, nextEnabled: true, previous: prev, next, code, secret, nowMs: now });
  check('对码 → 接受', ok.accept === true && ok.changed === true && ok.reason === 'ok', JSON.stringify(ok));
  check('接受后要求清空码字段', ok.clearCode === true, JSON.stringify(ok));
}

console.log('\n5. 相邻窗口（±1）仍认，两格之前不认');
{
  const adjacent = totp(secret, { timeMs: now + 30000 });
  const r1 = decideGateEdit({ previousEnabled: true, nextEnabled: true, previous: prev, next, code: adjacent, secret, nowMs: now });
  check('+1 窗口的码也接受（时钟漂移容差）', r1.accept === true, JSON.stringify(r1));
  const stale = totp(secret, { timeMs: now + 90000 });
  const r2 = decideGateEdit({ previousEnabled: true, nextEnabled: true, previous: prev, next, code: stale, secret, nowMs: now });
  check('+3 窗口的码拒绝', r2.accept === false, JSON.stringify(r2));
}

console.log('\n6. 开关本身变化（开↔关）也要码');
{
  const offNoCode = decideGateEdit({ previousEnabled: true, nextEnabled: false, previous: prev, next: prev.slice(), code: '', secret, nowMs: now });
  check('关掉闸门没码 → 拒绝（不能比改名单更容易）', offNoCode.accept === false && offNoCode.reason === 'no-code', JSON.stringify(offNoCode));
  const offWithCode = decideGateEdit({ previousEnabled: true, nextEnabled: false, previous: prev, next: prev.slice(), code, secret, nowMs: now });
  check('关掉闸门带对码 → 接受', offWithCode.accept === true, JSON.stringify(offWithCode));
  const onNoCode = decideGateEdit({ previousEnabled: false, nextEnabled: true, previous: prev, next: prev.slice(), code: '', secret, nowMs: now });
  check('打开闸门没码 → 拒绝（否则可先开后放行名单）', onNoCode.accept === false, JSON.stringify(onNoCode));
  const onWithCode = decideGateEdit({ previousEnabled: false, nextEnabled: true, previous: prev, next: prev.slice(), code, secret, nowMs: now });
  check('打开闸门带对码 → 接受', onWithCode.accept === true, JSON.stringify(onWithCode));
}

console.log('\n7. 什么都没变：接受，但填进来的码要清掉');
{
  const same = decideGateEdit({ previousEnabled: true, nextEnabled: true, previous: prev, next: prev.slice(), code, secret, nowMs: now });
  check('不接受改动但也不报错', same.accept === true && same.changed === false && same.reason === 'unchanged', JSON.stringify(same));
  check('顺手清掉码', same.clearCode === true, JSON.stringify(same));
}

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail > 0) process.exitCode = 1;
