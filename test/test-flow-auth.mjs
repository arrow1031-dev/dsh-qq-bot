#!/usr/bin/env node
/**
 * 二次授权状态机自测：申请 → 校验 → grant → 消费，含重放 / 锁定 / 过期 / fail-closed。
 *
 *   node test/test-flow-auth.mjs
 *
 * 正确码由「注入时钟 + 真 TOTP」算出来，不存在任何测试专用 bypass。
 */
import { createFlowAuth } from '../lib/valve/security/flow-auth.js';
import { generateSecret, totp, generateBackupCodes, hashBackupCode } from '../lib/valve/security/totp.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail === '' ? '' : ' — ' + detail)); }
}

const secret = generateSecret(20);
let clock = 1700000000000;
const audits = [];
const cfg = { enabled: true, totpSecret: secret, grantTtlSeconds: 300, maxAttempts: 3, lockoutMinutes: 10, recoverySalt: 'salt-x', recoveryHashes: [] };
const auth = createFlowAuth({ config: () => cfg, now: () => clock, audit: (e) => audits.push(e) });
const owner = '319543886';
const codeAt = (offsetMs = 0) => totp(secret, { timeMs: clock + offsetMs });

console.log('1. 申请 → 校验 → grant → 消费');
const noPending = auth.consumeToken(owner, codeAt());
check('未申请直接换码被拒（no-pending）', noPending.ok === false && noPending.reason === 'no-pending');
check('申请成功', auth.requestAuth(owner, 'workflow:daily-check', 'subagent').ok === true);
const grant = auth.consumeToken(owner, codeAt());
check('正确动态码换到 grant', grant.ok === true && grant.purpose === 'workflow:daily-check' && /^g/.test(grant.grantId));
check('grant 可被消费一次', auth.takeGrant(grant.grantId, owner, 'subagent').ok === true);
check('同一 grant 不能再用第二次', auth.takeGrant(grant.grantId, owner, 'subagent').ok === false);

console.log('\n1b. 授权窗口：默认 30 秒，最低也是 30 秒');
const defaultAuth = createFlowAuth({ config: () => ({ enabled: true, totpSecret: secret }), now: () => clock });
check('没配 grantTtlSeconds 时默认 30 秒', defaultAuth.requestAuth(owner, 'x', 'subagent').ttlSeconds === 30, String(defaultAuth.requestAuth(owner, 'x', 'subagent').ttlSeconds));
const tinyAuth = createFlowAuth({ config: () => ({ enabled: true, totpSecret: secret, grantTtlSeconds: 5 }), now: () => clock });
check('配得再小也按 30 秒处理', tinyAuth.requestAuth(owner, 'x', 'subagent').ttlSeconds === 30);
console.log('\n2. 重放防护：同一 counter 的码第二次直接拒');
clock += 30000;
auth.requestAuth(owner, 'workflow:again', 'subagent');
check('第一次成功', auth.consumeToken(owner, codeAt()).ok === true);
auth.requestAuth(owner, 'workflow:replay', 'subagent');
const replay = auth.consumeToken(owner, codeAt());
check('同一秒内复用同一码 → replayed', replay.ok === false && replay.reason === 'replayed');

console.log('\n3. 错误码 / 锁定');
clock += 30000;
auth.requestAuth(owner, 'workflow:lock', 'subagent');
const wrong = codeAt() === '000000' ? '111111' : '000000';
check('错误码被拒（mismatch）', auth.consumeToken(owner, wrong).reason === 'mismatch');
auth.consumeToken(owner, wrong);
auth.consumeToken(owner, wrong);
const lockedTry = auth.consumeToken(owner, codeAt());
check('连续 3 次失败 → 锁定期内正确码也被拒', lockedTry.ok === false && lockedTry.reason === 'locked');
clock += 11 * 60000;
auth.requestAuth(owner, 'workflow:after-lock', 'subagent');
check('锁定到期后可以重新通过', auth.consumeToken(owner, codeAt()).ok === true);

console.log('\n4. 过期与主体绑定');
auth.requestAuth(owner, 'workflow:expire', 'subagent');
const g3 = auth.consumeToken(owner, codeAt());
clock += 301000;
check('过期 grant 不可用', auth.takeGrant(g3.grantId, owner).ok === false);
auth.requestAuth(owner, 'workflow:principal', 'subagent');
const g4 = auth.consumeToken(owner, codeAt());
const wrongPrincipal = auth.takeGrant(g4.grantId, '22222');
check('别的 QQ 号不能用这张 grant', wrongPrincipal.ok === false && wrongPrincipal.reason === 'wrong-principal');

console.log('\n5. fail-closed：关闭 / 无密钥 / 格式错');
const offAuth = createFlowAuth({ config: () => ({ enabled: false, totpSecret: secret }), now: () => clock, audit: () => {} });
check('enabled=false → 一律拒绝', offAuth.requestAuth(owner, 'x', 'subagent').ok === false && offAuth.consumeToken(owner, codeAt()).ok === false);
const noSec = createFlowAuth({ config: () => ({ enabled: true, totpSecret: '' }), now: () => clock, audit: () => {} });
check('密钥缺失 → no-secret', noSec.consumeToken(owner, '123456').reason === 'no-secret');
const fmtAuth = createFlowAuth({ config: () => cfg, now: () => clock, audit: () => {} });
fmtAuth.requestAuth(owner, 'x', 'subagent');
check('5 位码 → bad-format', fmtAuth.consumeToken(owner, '12345').reason === 'bad-format');
check('空码 → bad-format', fmtAuth.consumeToken(owner, '').reason === 'bad-format');

console.log('\n6. 恢复码（一次性、哈希存储）');
const codes = generateBackupCodes(3);
cfg.recoveryHashes = codes.map((c) => hashBackupCode(c, cfg.recoverySalt));
const recAuth = createFlowAuth({ config: () => cfg, now: () => clock, audit: () => {} });
recAuth.requestAuth(owner, 'workflow:recover', 'subagent');
const r1 = recAuth.consumeRecoveryCode(owner, codes[1]);
check('正确恢复码换到 grant（返回命中下标）', r1.ok === true && r1.usedRecoveryIndex === 1);
recAuth.requestAuth(owner, 'workflow:recover2', 'subagent');
check('错误恢复码被拒', recAuth.consumeRecoveryCode(owner, 'AAAAA-AAAAA').ok === false);
const emptyRec = createFlowAuth({ config: () => Object.assign({}, cfg, { recoveryHashes: [] }), now: () => clock, audit: () => {} });
emptyRec.requestAuth(owner, 'x', 'subagent');
check('没有恢复码时直接拒（no-recovery）', emptyRec.consumeRecoveryCode(owner, 'AAAAA-AAAAA').reason === 'no-recovery');

console.log('\n7. 审计只记结论，不记令牌');
const auditText = JSON.stringify(audits);
check('审计里有 ok/fail 与 grantId', audits.some((a) => a.action === 'grant' && a.ok === true) && audits.some((a) => a.action === 'token' && a.ok === false));
check('审计里不含正确的动态码明文', !auditText.includes(codeAt()));
check('审计结构固定（at/qq/action/ok/reason/grantId）', audits.every((a) => ['at', 'qq', 'action', 'ok', 'reason', 'grantId'].every((k) => k in a)));


console.log('\n8. 恢复码同样受待授权申请时效约束');
{
  const salt = 'cafe';
  const codes = ['ABCDEFGH', 'IJKLMNOP'];
  const conf2 = { enabled: true, totpSecret: generateSecret(20), grantTtlSeconds: 30, maxAttempts: 5, lockoutMinutes: 15, recoveryHashes: codes.map((c) => hashBackupCode(c, salt)), recoverySalt: salt };
  let t2 = 1700000000000;
  const a2 = createFlowAuth({ config: () => conf2, now: () => t2 });
  a2.requestAuth('777', 'x', 'subagent');
  t2 += 10 * 60 * 1000;   // 十分钟后才回恢复码：申请早该过期了
  const late = a2.consumeRecoveryCode('777', codes[0]);
  check('十分钟前的申请不能用恢复码兑现', late.ok === false && late.reason === 'no-pending', JSON.stringify(late));
  a2.requestAuth('777', 'y', 'subagent');
  const fresh = a2.consumeRecoveryCode('777', codes[0]);
  check('重新申请后恢复码立刻可用', fresh.ok === true);
  const again = a2.consumeRecoveryCode('777', codes[0]);
  check('同一条恢复码不能连用两次（pending 已消费）', again.ok === false, JSON.stringify(again));
}

console.log('\n9. 授权绑定工具：申请时写什么，就只能跑什么');
{
  const conf3 = { enabled: true, totpSecret: secret, gatedTools: ['subagent', 'workflow'], grantTtlSeconds: 300 };
  let t3 = clock;
  const a3 = createFlowAuth({ config: () => conf3, now: () => t3 });
  a3.requestAuth('888', 'subagent', 'subagent');
  const g3 = a3.consumeToken('888', codeAt());
  check('用途是受闸门工具时，grant 绑定了工具名', g3.ok === true);
  const wrong = a3.takeGrant(g3.grantId, '888', 'workflow');
  check('拿它去跑另一个工具被拒（wrong-tool）', wrong.ok === false && wrong.reason === 'wrong-tool', JSON.stringify(wrong));
  const omitted = a3.takeGrant(g3.grantId, '888');
  check('取用时省略工具名同样被拒（不能靠「不传」绕过绑定）', omitted.ok === false && omitted.reason === 'wrong-tool', JSON.stringify(omitted));
  const right = a3.takeGrant(g3.grantId, '888', 'subagent');
  check('拿它跑申请的那个工具放行', right.ok === true);
  // 用途不是工具名（自由文本）时不绑定，任何受闸门工具都能用一次
  t3 += 31 * 1000;   // 跨过 30 秒步长，否则同一个码会被判重放
  a3.requestAuth('888', 'just checking', 'subagent');
  const g4 = a3.consumeToken('888', totp(secret, { timeMs: t3 }));
  // 以前自由文本用途会绑成空串、任何工具都能用；现在申请必须带工具名，
  // 绑完之后只认那个工具（用途文本仍只是给人看的说明）。
  check('自由文本用途只能跑绑定的那个工具',
    g4.ok === true && g4.toolName === 'subagent'
    && a3.takeGrant(g4.grantId, '888', 'workflow').ok === false
    && a3.takeGrant(g4.grantId, '888', 'subagent').ok === true);
}
console.log('\n10. reset 与过期回收');
{
  const conf4 = { enabled: true, totpSecret: secret, gatedTools: ['subagent'], grantTtlSeconds: 30 };
  let t4 = clock;
  const a4 = createFlowAuth({ config: () => conf4, now: () => t4 });
  a4.requestAuth('999', 'subagent', 'subagent');
  const g5 = a4.consumeToken('999', codeAt());
  check('拿得到 grant', g5.ok === true);
  a4.reset('999');
  check('reset(qq) 能按 qq 把 grant 清掉（以前按 grantId 找，删不掉）', a4.status().grants === 0, JSON.stringify(a4.status()));
  // 过期回收：申请并消费很多次、都不使用，grant 数量不应持续增长
  for (let i = 0; i < 5; i += 1) {
    t4 += 31 * 1000;   // 每次跨过 30 秒 TTL
    a4.requestAuth('999', 'subagent', 'subagent');
    a4.consumeToken('999', codeAt());
  }
  check('过期的 grant 会被顺手清掉（数量不超过 2）', a4.status().grants <= 2, JSON.stringify(a4.status()));
}

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);