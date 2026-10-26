#!/usr/bin/env node
/**
 * 二次授权状态机自测：申请 → 校验 → grant → 消费，含重放 / 锁定 / 过期 / fail-closed。
 *
 *   node test/test-flow-auth.mjs
 *
 * 正确码由「注入时钟 + 真 TOTP」算出来，不存在任何测试专用 bypass。
 */
import { createFlowAuth } from '../lib/flow-auth.js';
import { generateSecret, totp, generateBackupCodes, hashBackupCode } from '../lib/totp.js';

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
check('申请成功', auth.requestAuth(owner, 'workflow:daily-check').ok === true);
const grant = auth.consumeToken(owner, codeAt());
check('正确动态码换到 grant', grant.ok === true && grant.purpose === 'workflow:daily-check' && /^g/.test(grant.grantId));
check('grant 可被消费一次', auth.takeGrant(grant.grantId, owner).ok === true);
check('同一 grant 不能再用第二次', auth.takeGrant(grant.grantId, owner).ok === false);

console.log('\n1b. 授权窗口：默认 30 秒，最低也是 30 秒');
const defaultAuth = createFlowAuth({ config: () => ({ enabled: true, totpSecret: secret }), now: () => clock });
check('没配 grantTtlSeconds 时默认 30 秒', defaultAuth.requestAuth(owner, 'x').ttlSeconds === 30, String(defaultAuth.requestAuth(owner, 'x').ttlSeconds));
const tinyAuth = createFlowAuth({ config: () => ({ enabled: true, totpSecret: secret, grantTtlSeconds: 5 }), now: () => clock });
check('配得再小也按 30 秒处理', tinyAuth.requestAuth(owner, 'x').ttlSeconds === 30);
console.log('\n2. 重放防护：同一 counter 的码第二次直接拒');
clock += 30000;
auth.requestAuth(owner, 'workflow:again');
check('第一次成功', auth.consumeToken(owner, codeAt()).ok === true);
auth.requestAuth(owner, 'workflow:replay');
const replay = auth.consumeToken(owner, codeAt());
check('同一秒内复用同一码 → replayed', replay.ok === false && replay.reason === 'replayed');

console.log('\n3. 错误码 / 锁定');
clock += 30000;
auth.requestAuth(owner, 'workflow:lock');
const wrong = codeAt() === '000000' ? '111111' : '000000';
check('错误码被拒（mismatch）', auth.consumeToken(owner, wrong).reason === 'mismatch');
auth.consumeToken(owner, wrong);
auth.consumeToken(owner, wrong);
const lockedTry = auth.consumeToken(owner, codeAt());
check('连续 3 次失败 → 锁定期内正确码也被拒', lockedTry.ok === false && lockedTry.reason === 'locked');
clock += 11 * 60000;
auth.requestAuth(owner, 'workflow:after-lock');
check('锁定到期后可以重新通过', auth.consumeToken(owner, codeAt()).ok === true);

console.log('\n4. 过期与主体绑定');
auth.requestAuth(owner, 'workflow:expire');
const g3 = auth.consumeToken(owner, codeAt());
clock += 301000;
check('过期 grant 不可用', auth.takeGrant(g3.grantId, owner).ok === false);
auth.requestAuth(owner, 'workflow:principal');
const g4 = auth.consumeToken(owner, codeAt());
const wrongPrincipal = auth.takeGrant(g4.grantId, '22222');
check('别的 QQ 号不能用这张 grant', wrongPrincipal.ok === false && wrongPrincipal.reason === 'wrong-principal');

console.log('\n5. fail-closed：关闭 / 无密钥 / 格式错');
const offAuth = createFlowAuth({ config: () => ({ enabled: false, totpSecret: secret }), now: () => clock, audit: () => {} });
check('enabled=false → 一律拒绝', offAuth.requestAuth(owner, 'x').ok === false && offAuth.consumeToken(owner, codeAt()).ok === false);
const noSec = createFlowAuth({ config: () => ({ enabled: true, totpSecret: '' }), now: () => clock, audit: () => {} });
check('密钥缺失 → no-secret', noSec.consumeToken(owner, '123456').reason === 'no-secret');
const fmtAuth = createFlowAuth({ config: () => cfg, now: () => clock, audit: () => {} });
fmtAuth.requestAuth(owner, 'x');
check('5 位码 → bad-format', fmtAuth.consumeToken(owner, '12345').reason === 'bad-format');
check('空码 → bad-format', fmtAuth.consumeToken(owner, '').reason === 'bad-format');

console.log('\n6. 恢复码（一次性、哈希存储）');
const codes = generateBackupCodes(3);
cfg.recoveryHashes = codes.map((c) => hashBackupCode(c, cfg.recoverySalt));
const recAuth = createFlowAuth({ config: () => cfg, now: () => clock, audit: () => {} });
recAuth.requestAuth(owner, 'workflow:recover');
const r1 = recAuth.consumeRecoveryCode(owner, codes[1]);
check('正确恢复码换到 grant（返回命中下标）', r1.ok === true && r1.usedRecoveryIndex === 1);
recAuth.requestAuth(owner, 'workflow:recover2');
check('错误恢复码被拒', recAuth.consumeRecoveryCode(owner, 'AAAAA-AAAAA').ok === false);
const emptyRec = createFlowAuth({ config: () => Object.assign({}, cfg, { recoveryHashes: [] }), now: () => clock, audit: () => {} });
emptyRec.requestAuth(owner, 'x');
check('没有恢复码时直接拒（no-recovery）', emptyRec.consumeRecoveryCode(owner, 'AAAAA-AAAAA').reason === 'no-recovery');

console.log('\n7. 审计只记结论，不记令牌');
const auditText = JSON.stringify(audits);
check('审计里有 ok/fail 与 grantId', audits.some((a) => a.action === 'grant' && a.ok === true) && audits.some((a) => a.action === 'token' && a.ok === false));
check('审计里不含正确的动态码明文', !auditText.includes(codeAt()));
check('审计结构固定（at/qq/action/ok/reason/grantId）', audits.every((a) => ['at', 'qq', 'action', 'ok', 'reason', 'grantId'].every((k) => k in a)));

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);