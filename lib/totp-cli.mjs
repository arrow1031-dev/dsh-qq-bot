#!/usr/bin/env node
/**
 * 密钥生成器：只在终端打印一次，**不经过 QQ**、不写日志、不落任何文件。
 *
 *   node lib/totp-cli.mjs enroll [账号标签]
 *   node lib/totp-cli.mjs recovery
 *
 * enroll   生成 TOTP 密钥与 otpauth:// URI；把 secret 粘进设置页「高级 → 流程授权 → TOTP 密钥」。
 * recovery 生成一组一次性恢复码 + 盐 + 哈希；明文抄走，哈希与盐填进设置页。
 *
 * 为什么不放在 QQ 里生成：动态码是「持有即可放行」，密钥一旦经过聊天通道就等于泄露，
 * 撤回也追不回已经同步到对方设备的记录。所以导入只能走「你本地终端 → 设置页」这条路。
 */
import process from 'node:process';
import { randomBytes } from 'node:crypto';
import { generateSecret, otpauthUri, generateBackupCodes, hashBackupCode } from './totp.js';
import { toTerminal } from './qr.js';

const command = String(process.argv[2] || '').toLowerCase();
const label = String(process.argv[3] || 'owner');

function randomSalt() {
  return randomBytes(12).toString('base64').replace(/[+/=]/g, '').slice(0, 12);
}

if (command === 'enroll') {
  const secret = generateSecret(20);
  const uri = otpauthUri({ secret, issuer: 'dsh-qq-bot', label });
  console.log('secret:  ' + secret);
  console.log('otpauth: ' + uri);
  console.log('');
  console.log('用认证器 App 扫下面这个码（离线绑定；终端字号调小一点更好扫）：');
  console.log('');
  console.log(toTerminal(uri));
  console.log('');
  console.log('扫上面的码最简单；也可以把 secret 粘进设置页「高级 → 流程授权 → TOTP 密钥」。');
  console.log('密钥只在这里打印，不经过 QQ、不写日志；终端回滚记录请自行清理。');
} else if (command === 'recovery') {
  const salt = randomSalt();
  const codes = generateBackupCodes(8);
  console.log('salt: ' + salt);
  console.log('codes（抄到纸上，验完就删）:');
  for (const code of codes) console.log('  ' + code);
  console.log('hashes（逗号分隔，填设置页「恢复码哈希」）:');
  console.log('  ' + codes.map((code) => hashBackupCode(code, salt)).join(','));
  console.log('');
  console.log('盐填设置页「恢复码哈希用的盐」；恢复码用掉一条后插件会自动把对应哈希删掉（写盘失败才需要你手动删）。');
} else {
  console.log('用法：');
  console.log('  node lib/totp-cli.mjs enroll [账号标签]   生成 TOTP 密钥（粘进设置页）');
  console.log('  node lib/totp-cli.mjs recovery           生成一次性恢复码 + 盐 + 哈希');
  if (command !== '' && command !== 'help' && command !== '--help') process.exit(1);
}
