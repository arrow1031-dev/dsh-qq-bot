#!/usr/bin/env node
/**
 * 加群自动审核：\`node test/test-join-review.mjs\`
 *
 * 只对配置的群生效；申请理由包含任一答案才自动通过，答错/空答案保持待人工。
 */
import { judgeJoinRequest, normalizeJoinAnswer } from '../lib/message/join-review.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail === '' ? '' : ' — ' + detail)); }
}

const cfg = { groups: ['1091766276'], answers: ['0.12.7'] };
const frame = (over) => Object.assign({ request_type: 'group', sub_type: 'add', group_id: '1091766276', user_id: '10001', comment: '0.12.7', flag: 'f1' }, over);

console.log('1. 归一化');
check('去首尾空白 + 小写', normalizeJoinAnswer('  0.12.7  ') === '0.12.7');
check('全角数字/字母 NFKC', normalizeJoinAnswer('０．１２．７') === '0.12.7');
check('内部空白压成一个', normalizeJoinAnswer('a   b') === 'a b');

console.log('2. 不该接的请求一律忽略');
check('空帧忽略', judgeJoinRequest(null, cfg).action === 'ignore');
check('非加群请求忽略', judgeJoinRequest(frame({ request_type: 'friend' }), cfg).action === 'ignore');
check('非 add 忽略', judgeJoinRequest(frame({ sub_type: 'invite' }), cfg).action === 'ignore');
check('没配置的群忽略', judgeJoinRequest(frame({ group_id: '999' }), cfg).action === 'ignore');

console.log('3. 只有答对才通过');
check('答案完全一致 → 通过', judgeJoinRequest(frame({}), cfg).action === 'approve');
check('理由里包含答案 → 通过', judgeJoinRequest(frame({ comment: '答案是 0.12.7' }), cfg).action === 'approve');
check('全角答案 → 通过', judgeJoinRequest(frame({ comment: '０.１２.７' }), cfg).action === 'approve');
check('答错 → 待人工', judgeJoinRequest(frame({ comment: '0.12.6' }), cfg).action === 'pending');
check('空理由 → 待人工', judgeJoinRequest(frame({ comment: '' }), cfg).action === 'pending');
check('答案没配置 → 待人工（不误通过）', judgeJoinRequest(frame({}), { groups: ['1091766276'], answers: [] }).action === 'pending');
check('只答了一半不算对', judgeJoinRequest(frame({ comment: '0.12' }), cfg).action === 'pending');

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail > 0) process.exitCode = 1;
