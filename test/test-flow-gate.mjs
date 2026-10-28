#!/usr/bin/env node
/**
 * 流程授权闸门自测：什么该拦、什么该放、一次一用、过期与错人。
 *
 *   node test/test-flow-gate.mjs
 *
 * 正确码由注入时钟 + 真 TOTP 算出来，没有任何测试专用放行。
 */
import { createFlowAuth, createFlowGate } from '../lib/valve/security/flow-auth.js';
import { generateSecret, totp } from '../lib/valve/security/totp.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail === '' ? '' : ' — ' + detail)); }
}

const secret = generateSecret(20);
let clock = 1700000000000;
const owner = '319543886';
const other = '10001';
const cfg = { enabled: true, totpSecret: secret, grantTtlSeconds: 300, maxAttempts: 3, lockoutMinutes: 10 };
const auth = createFlowAuth({ config: () => cfg, now: () => clock });
let gateEnabled = true;
const gate = createFlowGate({
  auth,
  enabled: () => gateEnabled,
  gatedTools: () => ['subagent', 'spawn_teammate', 'workflow'],
});
const code = () => totp(secret, { timeMs: clock });

console.log('1. 不在名单里的工具不受影响');
check('qqbot 不在 gatedTools → 直接放行', gate.check(owner, 'qqbot').allow === true);
check('isGated(subagent) 为真', gate.isGated('subagent') === true);
check('isGated(qqbot) 为假', gate.isGated('qqbot') === false);
check('未知名字不炸', gate.isGated('') === false && gate.isGated(null) === false);

console.log('\n2. 没有授权就要拦');
const blocked = gate.check(owner, 'workflow');
check('没有 grant → 拒绝', blocked.allow === false && blocked.reason === 'no-grant');
check('拒绝文案让模型去申请授权', gate.blockedText(blocked.reason).includes('qqauth'));

console.log('\n3. 授权到手后放行一次');
auth.requestAuth(owner, 'workflow:release', 'workflow');
const grant = auth.consumeToken(owner, code());
check('拿到 grant', grant.ok === true);
gate.remember(owner, grant.grantId);
const first = gate.check(owner, 'workflow');
check('第一次放行', first.allow === true && first.purpose === 'workflow:release');
const second = gate.check(owner, 'workflow');
check('第二次被拦（一次一用）', second.allow === false && second.reason === 'no-grant');

console.log('\n4. 别人的授权用不了');
clock += 30000;
auth.requestAuth(owner, 'workflow:for-owner', 'workflow');
const g2 = auth.consumeToken(owner, code());
gate.remember(owner, g2.grantId);
const stolen = gate.check(other, 'workflow');
check('错人 → 拒绝', stolen.allow === false);
check('原主人的授权还在，没有被别人用掉', gate.check(owner, 'workflow').allow === true);

console.log('\n5. 过期即失效');
clock += 30000;
auth.requestAuth(owner, 'workflow:expiring', 'workflow');
const g3 = auth.consumeToken(owner, code());
gate.remember(owner, g3.grantId);
clock += 301000;
const expired = gate.check(owner, 'workflow');
check('超过有效期 → 拒绝', expired.allow === false && expired.reason === 'expired');
check('过期授权已被清掉，再用还是拒绝', gate.check(owner, 'workflow').allow === false);

console.log('\n6. 总开关关掉后不再拦');
gateEnabled = false;
check('关闭后 subagent 直接放行', gate.check(owner, 'subagent').allow === true);
check('关闭后 isGated 为假', gate.isGated('subagent') === false);

console.log('\n7. forget 清掉待用授权');
gateEnabled = true;
clock += 30000;
auth.requestAuth(owner, 'workflow:forget', 'workflow');
const g4 = auth.consumeToken(owner, code());
gate.remember(owner, g4.grantId);
gate.forget(owner);
const afterForget = gate.check(owner, 'workflow');
check('forget 之后拒绝', afterForget.allow === false && afterForget.reason === 'no-grant');

console.log('');
if (fail === 0) { console.log(pass + '/' + (pass + fail) + ' 项通过'); console.log('流程授权闸门自测通过'); }
else { console.log(pass + ' 通过 / ' + fail + ' 失败'); process.exit(1); }
