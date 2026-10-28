#!/usr/bin/env node
/**
 * 零依赖 TOTP 自测：RFC 4226 / 6238 官方测试向量 + fail-closed 红线。
 *
 *   node test/test-totp.mjs
 */
import { base32Decode, hotp, totp, totpVerify, generateSecret, otpauthUri, generateBackupCodes, hashBackupCode, verifyBackupCode } from '../lib/valve/security/totp.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail === '' ? '' : ' — ' + detail)); }
}

// RFC 4226 附录 D 的密钥：ASCII "12345678901234567890"
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

console.log('1. RFC 4226 HOTP 测试向量');
const hotpVectors = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
hotpVectors.forEach((want, counter) => {
  const got = hotp(RFC_SECRET, counter, 6);
  check('HOTP counter=' + counter + ' → ' + want, got === want, 'got=' + got);
});

console.log('\n2. RFC 6238 TOTP 测试向量（SHA-1 / 8 位）');
const totpVectors = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];
for (const [sec, want] of totpVectors) {
  const got = totp(RFC_SECRET, { timeMs: sec * 1000, digits: 8 });
  check('TOTP t=' + sec + ' → ' + want, got === want, 'got=' + got);
}

console.log('\n3. fail-closed：密钥缺失 / 非法 / 令牌格式错 —— 一律拒绝');
const at = 1700000000000;
check('空密钥 → no-secret', totpVerify('', '123456', { timeMs: at }).ok === false && totpVerify('', '123456', { timeMs: at }).reason === 'no-secret');
check('null 密钥 → no-secret', totpVerify(null, '123456', { timeMs: at }).reason === 'no-secret');
check('非法字符密钥 → no-secret', totpVerify('NOT!BASE32', '123456', { timeMs: at }).reason === 'no-secret');
check('5 位令牌 → bad-format', totpVerify(RFC_SECRET, '12345', { timeMs: at }).reason === 'bad-format');
check('字母令牌 → bad-format', totpVerify(RFC_SECRET, 'abcdef', { timeMs: at }).reason === 'bad-format');
check('空令牌 → bad-format', totpVerify(RFC_SECRET, '', { timeMs: at }).reason === 'bad-format');

console.log('\n4. 正确码能被校验，错误码不能被校验（无万能码）');
const good = totp(RFC_SECRET, { timeMs: at });
const r1 = totpVerify(RFC_SECRET, good, { timeMs: at, window: 1 });
check('当前时间正确码 → ok，且返回 counter', r1.ok === true && r1.counter > 0);
check('相邻步长的旧码在 window=1 内也接受', totpVerify(RFC_SECRET, totp(RFC_SECRET, { timeMs: at - 30000 }), { timeMs: at, window: 1 }).ok === true);
check('超出窗口的旧码拒绝', totpVerify(RFC_SECRET, totp(RFC_SECRET, { timeMs: at - 120000 }), { timeMs: at, window: 1 }).ok === false);
const wrong = good === '000000' ? '111111' : '000000';
check('错误码（含 000000）一律 mismatch', totpVerify(RFC_SECRET, wrong, { timeMs: at }).ok === false);
check('同长度但不同值的码不会误判', totpVerify(RFC_SECRET, good.split('').reverse().join(''), { timeMs: at }).ok === false);

console.log('\n5. 密钥生成 / otpauth URI');
const secret = generateSecret(20);
check('生成的密钥是 base32 且可解码', /^[A-Z2-7]+$/.test(secret) && base32Decode(secret).length === 20);
check('两次生成不重复', generateSecret(20) !== generateSecret(20));
const uri = otpauthUri({ secret, issuer: 'DSH QQ Bot', label: 'owner' });
check('otpauth URI 含 secret / algorithm=SHA1 / digits=6 / period=30', uri.startsWith('otpauth://totp/') && uri.includes('secret=' + secret) && uri.includes('algorithm=SHA1') && uri.includes('digits=6') && uri.includes('period=30'));

check('otpauth URI 含 secret / algorithm=SHA1 / digits=6 / period=30', uri.startsWith('otpauth://totp/') && uri.includes('secret=' + secret) && uri.includes('algorithm=SHA1') && uri.includes('digits=6') && uri.includes('period=30'));

console.log('\n5b. otpauth URI 标准格式（Google / Microsoft Authenticator 能导入）');
const std = otpauthUri({ secret, issuer: 'dsh-qq-bot', label: 'owner' });
const parsed = new URL(std.replace('otpauth://', 'https://'));
check('路径是 /dsh-qq-bot:owner（冒号必须字面量，不能是 %3A）', parsed.pathname === '/dsh-qq-bot:owner', parsed.pathname);
check('secret 参数是 32 位 base32、可解出 20 字节密钥', /^[A-Z2-7]{32}$/.test(parsed.searchParams.get('secret')) && base32Decode(parsed.searchParams.get('secret')).length === 20);
check('参数齐全：algorithm=SHA1 / digits=6 / period=30 / issuer', parsed.searchParams.get('algorithm') === 'SHA1' && parsed.searchParams.get('digits') === '6' && parsed.searchParams.get('period') === '30' && parsed.searchParams.get('issuer') === 'dsh-qq-bot');
check('没有 url 编码残留的 %3A', !std.includes('%3A'));
const noIssuer = otpauthUri({ secret, label: 'owner' });
check('不填 issuer 时路径只有账号，也不带 issuer 参数', new URL(noIssuer.replace('otpauth://', 'https://')).pathname === '/owner' && !noIssuer.includes('issuer='));
const cjk = otpauthUri({ secret, issuer: 'DSH QQ Bot', label: '小助手 的 手机' });
check('发行方/账号里的空格与中文被百分号编码，仍是合法 URI', cjk.startsWith('otpauth://totp/DSH%20QQ%20Bot:') && /%E5%B0%8F/.test(cjk) && !/ /.test(cjk));
console.log('\n6. 恢复码：一次性、哈希存储、不存明文');
const codes = generateBackupCodes(8);
check('生成 8 条且互不相同', codes.length === 8 && new Set(codes).size === 8);
check('格式为 XXXXX-XXXXX', codes.every((c) => /^[A-Z2-7]{5}-[A-Z2-7]{5}$/.test(c)));
const salt = 'unit-test-salt';
const hashes = codes.map((c) => hashBackupCode(c, salt));
check('哈希里不含明文码', hashes.every((h) => codes.every((c) => !h.includes(c.replace('-', '')))));
check('正确恢复码可通过', verifyBackupCode(codes[3], hashes, salt).ok === true && verifyBackupCode(codes[3], hashes, salt).index === 3);
check('错误恢复码被拒', verifyBackupCode('AAAAA-AAAAA', hashes, salt).ok === false);
check('空哈希列表被拒（fail-closed）', verifyBackupCode(codes[0], [], salt).ok === false);
check('空盐不产生可用哈希（fail-closed）', hashBackupCode(codes[0], '') === '' && verifyBackupCode(codes[0], [''], '').ok === false);

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);