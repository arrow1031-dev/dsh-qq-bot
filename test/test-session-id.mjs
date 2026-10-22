/**
 * 会话 id 作用域回退自测：旧工作区会话冲突时不删旧会话，改用工作区限定 id。
 * 用法：node test/test-session-id.mjs
 */
import { scopedSessionId } from '../lib/session.js';

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + (detail === undefined ? '' : '：' + detail)); }
}

const a = scopedSessionId('qqbot-group-534139082', 'workspace:abc');
const b = scopedSessionId('qqbot-group-534139082', 'workspace:abc');
const c = scopedSessionId('qqbot-group-534139082', 'workspace:def');
check('同一作用域结果稳定', a === b, a + ' vs ' + b);
check('不同作用域结果不同', a !== c, a + ' vs ' + c);
check('保留原会话 id 前缀', a.indexOf('qqbot-group-534139082') === 0, a);
check('文件名安全（无 / 与空格）', /^[A-Za-z0-9_@.-]+$/.test(a), a);
check('长度可控', a.length < 80, String(a.length));

console.log('\n' + pass + '/' + (pass + fail) + ' 项通过');
if (fail > 0) { console.log('会话 id 自测失败'); process.exit(1); }
console.log('会话 id 自测通过');
