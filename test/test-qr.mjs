#!/usr/bin/env node
/**
 * QR 编码器自测：固定向量 + 结构检查。
 *
 *   node test/test-qr.mjs
 *
 * 固定向量不是「照着自己输出抄的」：这里的两个矩阵哈希与独立实现 qrcode@1.5.4
 * （字节模式、纠错等级 M、相同掩码）逐位对齐后取的，改坏一位就会红。
 */
import { createHash } from 'node:crypto';
import { encode, chooseVersion, toTerminal, MAX_VERSION } from '../lib/qr.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail === '' ? '' : ' — ' + detail)); }
}
const digest = (text) => {
  const m = encode(text);
  const rows = m.modules.map((row) => row.map((v) => (v ? '1' : '0')).join('')).join('\n');
  return { ...m, sha: createHash('sha256').update(rows).digest('hex') };
};
const URI = 'otpauth://totp/dsh-qq-bot:owner?secret=GVVVINITQ6CQKHA2F2B5FI4IMQMUG6V5&algorithm=SHA1&digits=6&period=30&issuer=dsh-qq-bot';

console.log('1. 固定向量（与独立实现逐位对齐）');
const hello = digest('HELLO');
check('HELLO → 版本 1 / 21x21 / 掩码 4', hello.version === 1 && hello.size === 21 && hello.mask === 4,
  'v' + hello.version + ' size' + hello.size + ' mask' + hello.mask);
check('HELLO 矩阵哈希匹配', hello.sha === 'c346c75add5698735afe3f7eb4f3e6c57ccefd9563f45f65c6d76aa518fb6f91', hello.sha);
const uri = digest(URI);
check('otpauth URI → 版本 8 / 49x49 / 掩码 2', uri.version === 8 && uri.size === 49 && uri.mask === 2,
  'v' + uri.version + ' size' + uri.size + ' mask' + uri.mask);
check('otpauth 矩阵哈希匹配', uri.sha === 'aa54eae1d4127bf64441c09ce4895a7d9b73029bc1fd774065cb3679cef37dd2', uri.sha);

console.log('\n2. 版本选择与容量边界');
check('14 字节仍进版本 1', chooseVersion('A'.repeat(14)).version === 1, String(chooseVersion('A'.repeat(14)).version));
check('15 字节涨到版本 2', chooseVersion('A'.repeat(15)).version === 2, String(chooseVersion('A'.repeat(15)).version));
check('超长内容返回 version 0（由调用方报错）', chooseVersion('A'.repeat(300)).version === 0);
check('支持到版本 ' + MAX_VERSION, MAX_VERSION === 9);
let threw = false;
try { encode('A'.repeat(300)); } catch (error) { threw = String(error.message).includes('太长'); }
check('encode 超长时抛可读错误', threw);

console.log('\n3. 结构检查（扫得出来才有意义）');
const m = encode('HELLO');
const isFinder = (r0, c0) => {
  for (let r = 0; r < 7; r += 1) {
    for (let c = 0; c < 7; c += 1) {
      const ring = r === 0 || r === 6 || c === 0 || c === 6;
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      if (m.modules[r0 + r][c0 + c] !== (ring || core)) return false;
    }
  }
  return true;
};
check('左上/右上/左下三个寻像图案完整', isFinder(0, 0) && isFinder(0, m.size - 7) && isFinder(m.size - 7, 0));
check('掩码编号在 0..7', m.mask >= 0 && m.mask <= 7);
check('固定黑点在 (size-8, 8)', m.modules[m.size - 8][8] === true);
const timingOk = (() => {
  for (let i = 8; i < m.size - 8; i += 1) {
    if (m.modules[6][i] !== (i % 2 === 0)) return false;
    if (m.modules[i][6] !== (i % 2 === 0)) return false;
  }
  return true;
})();
check('时序列逐格交替', timingOk);

console.log('\n4. 终端渲染');
const terminal = toTerminal('HI').split('\n');
check('宽度 = 矩阵宽度 + 2×静区', terminal[0].length === 25, String(terminal[0].length));
check('行数 = (宽 + 2×静区) / 2 向上取整', terminal.length === 13, String(terminal.length));
check('第一行是纯静区（全空格）', terminal[0].trim() === '');

console.log('\n5. URI 含非 ASCII 也能编（Label 里有中文）');
const cjk = 'otpauth://totp/dsh-qq-bot:%E5%B0%8F%E5%8A%A9%E6%89%8B?secret=GVVVINITQ6CQKHA2F2B5FI4IMQMUG6V5&issuer=dsh-qq-bot';
const cjkCode = chooseVersion(cjk);
check('中文 label 的 URI 能选出版本', cjkCode.version > 0, String(cjkCode.version));
check('编码不抛错且矩阵尺寸自洽', encode(cjk).modules.length === encode(cjk).size);

console.log('');
if (fail === 0) { console.log(pass + '/' + (pass + fail) + ' 项通过'); console.log('QR 编码器自测通过'); }
else { console.log(pass + ' 通过 / ' + fail + ' 失败'); process.exit(1); }
