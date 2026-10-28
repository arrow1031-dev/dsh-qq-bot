#!/usr/bin/env node
/**
 * 二维码一致性：`node test/test-qr-consistency.mjs`
 *
 * 客户端 bundle 不能 import 服务端 ESM，所以设置页里的二维码实现是一份粘贴副本
 * （lib/client/settings.js 的 QR_BUNDLE 区块）。这里把副本抽出来求值，与服务端
 * lib/tools/qr.js 对同一批输入逐位比对矩阵——副本漂移会立刻变红。
 */
import { readFileSync } from 'node:fs';
import { encode, MAX_VERSION } from '../lib/tools/qr.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail === '' ? '' : ' — ' + detail)); }
}

const START = '/* QR_BUNDLE_START */';
const END = '/* QR_BUNDLE_END */';
const source = readFileSync(new URL('../lib/client/settings.js', import.meta.url), 'utf8');

console.log('1. 客户端副本能被原样抽出来');
const start = source.indexOf(START);
const end = source.indexOf(END);
check('找得到 QR_BUNDLE 起止标记', start >= 0 && end > start, start + '/' + end);
const block = source.slice(start + START.length, end);
check('副本不是空块', block.trim().length > 2000, String(block.length));

let clientEncode = null;
try {
  clientEncode = new Function(block + '\nreturn encodeQr;')();
  check('副本能在隔离作用域里求值并暴露 encodeQr', typeof clientEncode === 'function');
} catch (error) {
  check('副本能在隔离作用域里求值并暴露 encodeQr', false, String(error.message));
}

console.log('2. 与服务端逐位比对矩阵（覆盖多个版本与掩码）');
const cases = [
  'a',
  'hello',
  'https://example.com/bind?x=1',
  '你好',
  'Observer 的绑定二维码',
  'x'.repeat(32),
  'y'.repeat(64),
  'z'.repeat(96),
  '长'.repeat(50),
  'q'.repeat(150),
  'https://q.qq.com/qqbot/openapi/v2/qqbot/bind?token=' + 'abc123'.repeat(8),
];
if (clientEncode !== null) {
  const versions = new Set();
  let mismatches = 0;
  for (const text of cases) {
    const server = encode(text);
    const client = clientEncode(text);
    versions.add(server.version);
    const same = server.version === client.version
      && server.size === client.size
      && server.mask === client.mask
      && server.modules.length === client.modules.length
      && server.modules.every((row, r) => row.length === client.modules[r].length
        && row.every((value, c) => value === client.modules[r][c]));
    if (!same) { mismatches += 1; console.log('    差异：' + JSON.stringify(text.slice(0, 24)) + ' server v' + server.version + '/mask' + server.mask + ' client v' + client.version + '/mask' + client.mask); }
  }
  check('11 组输入全部逐位一致', mismatches === 0, 'mismatches=' + mismatches);
  check('样本覆盖多个版本（≥3）', versions.size >= 3, Array.from(versions).join(','));
  check('版本不超过 MAX_VERSION', Math.max(...versions) <= MAX_VERSION, String(Math.max(...versions)));
  let serverThrows = false;
  let clientThrows = false;
  const tooLong = 'x'.repeat(4000);
  try { encode(tooLong); } catch { serverThrows = true; }
  try { clientEncode(tooLong); } catch { clientThrows = true; }
  check('超长内容两边都拒绝', serverThrows && clientThrows, serverThrows + '/' + clientThrows);
}

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail > 0) process.exitCode = 1;
