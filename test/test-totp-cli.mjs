#!/usr/bin/env node
/**
 * 密钥 CLI 自测：密钥只从终端出，不经 QQ。
 *
 *   node test/test-totp-cli.mjs
 *
 * 验的是「输出能用」而不是「输出长得对」：把 enroll 打出来的 secret 直接喂给 totp() 算码，
 * 再让 totpVerify 验回来；recovery 打出来的哈希也真的拿恢复码验一遍。
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { totpVerify, verifyBackupCode } from '../lib/valve/security/totp.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail === '' ? '' : ' — ' + detail)); }
}

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'valve', 'security', 'totp-cli.mjs');

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (error) {
    return { code: typeof error.status === 'number' ? error.status : -1, stdout: String(error.stdout || '') };
  }
}

console.log('1. enroll：secret 与 otpauth 一致，且真能算码');
const enroll = run(['enroll', 'lead-test']);
check('退出码 0', enroll.code === 0, String(enroll.code));
const secretMatch = /secret:\s+([A-Z2-7]{32})/.exec(enroll.stdout);
check('打印了 32 位 base32 secret', secretMatch !== null, enroll.stdout.slice(0, 80));
const secret = secretMatch === null ? '' : secretMatch[1];
const uriMatch = /otpauth:\/\/totp\/[^\s]+/.exec(enroll.stdout);
check('打印了 otpauth URI', uriMatch !== null);
check('URI 里的 secret 与 secret 行一致', uriMatch !== null && uriMatch[0].includes('secret=' + secret));
const code = (await import('../lib/valve/security/totp.js')).totp(secret, { timeMs: 1700000000000 });
const verified = totpVerify(secret, code, { timeMs: 1700000000000, window: 0 });
check('用打印出的 secret 算出的码能验过', verified.ok === true && verified.counter > 0);

console.log('\n2. recovery：盐 + 8 条明文 + 8 条哈希，哈希能验回明文');
const recovery = run(['recovery']);
check('退出码 0', recovery.code === 0, String(recovery.code));
const saltMatch = /salt:\s+(\S+)/.exec(recovery.stdout);
check('打印了盐', saltMatch !== null);
const salt = saltMatch === null ? '' : saltMatch[1];
const codes = [...recovery.stdout.matchAll(/^\s{2}([A-Z2-7]{5}-[A-Z2-7]{5})\s*$/gm)].map((m) => m[1]);
check('打印了 8 条恢复码', codes.length === 8, String(codes.length));
const hashLine = /\n\s{2}([0-9a-f,]+)\s*\n/.exec(recovery.stdout);
const hashes = hashLine === null ? [] : hashLine[1].split(',');
check('打印了 8 条哈希', hashes.length === 8, String(hashes.length));
const hit = verifyBackupCode(codes[0], hashes, salt);
check('第一条恢复码能验回哈希', hit.ok === true && hit.index === 0);
const miss = verifyBackupCode('AAAAA-BBBBB', hashes, salt);
check('乱填的恢复码验不过', miss.ok === false);

console.log('\n3. 用法与错误路径');
check('help 退出码 0', run(['help']).code === 0);
check('未知子命令退出码 1', run(['nonsense']).code === 1);
check('无参数也给出用法（退出码 0）', run([]).code === 0);

console.log('');
if (fail === 0) { console.log(pass + '/' + (pass + fail) + ' 项通过'); console.log('密钥 CLI 自测通过'); }
else { console.log(pass + ' 通过 / ' + fail + ' 失败'); process.exit(1); }
