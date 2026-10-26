/**
 * 零依赖 TOTP（RFC 6238，SHA-1 / 30 秒 / 6 位），兼容离线验证器（Google Authenticator 等）。
 *
 * 设计红线（防止出现「万能码」「假验证」这类后门）：
 * - 没有任何固定可接受的码，没有长度/前缀特判，没有「测试模式跳过后」；
 * - 密钥缺失或格式非法一律 fail-closed（返回 ok:false），绝不放行；
 * - 校验用常量时间比较，不用 ===；
 * - 单测通过注入时钟与密钥构造正确码，而不是绕过校验。
 */
import crypto from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** base32 → Buffer（只允许 base32 字符，其余字符直接判非法）。 */
export function base32Decode(input) {
  const raw = String(input === undefined || input === null ? '' : input).toUpperCase().replace(/[\s=]/g, '');
  if (raw === '') return Buffer.alloc(0);
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of raw) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) return null; // 非法字符：交给调用方 fail-closed
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 生成新密钥（默认 20 字节 = 160 bit），返回 base32（无填充）。 */
export function generateSecret(bytes = 20) {
  const buf = crypto.randomBytes(Math.max(10, Math.floor(Number(bytes) || 20)));
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** RFC 4226 HOTP：HMAC-SHA1(secret, counter) + 动态截断。 */
export function hotp(secret, counter, digits = 6) {
  const key = Buffer.isBuffer(secret) ? secret : base32Decode(secret);
  if (key === null || key.length === 0) return null;
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(Number(counter) || 0))));
  const mac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  const mod = 10 ** Math.max(6, Math.floor(Number(digits) || 6));
  return String(binary % mod).padStart(Math.max(6, Math.floor(Number(digits) || 6)), '0');
}

/** 当前时间对应的 TOTP（注入时间便于测试）。 */
export function totp(secret, options = {}) {
  const step = Math.max(1, Math.floor(Number(options.step) || 30));
  const digits = Math.max(6, Math.floor(Number(options.digits) || 6));
  const nowMs = Number.isFinite(options.timeMs) ? Number(options.timeMs) : Date.now();
  const counter = Math.floor(nowMs / 1000 / step);
  return hotp(secret, counter, digits);
}

/**
 * 校验 TOTP。返回 {ok, counter, reason}；counter 供上层做 replay 防护。
 * - 密钥为空/非法 → ok:false, reason:'no-secret'（fail-closed）；
 * - 令牌不是恰好 digits 位数字 → ok:false, reason:'bad-format'；
 * - 不在当前及 ±window 个步长内 → ok:false, reason:'mismatch'。
 */
export function totpVerify(secret, token, options = {}) {
  const key = base32Decode(secret);
  if (key === null || key.length === 0) return { ok: false, reason: 'no-secret', counter: 0 };
  // 弱密钥：少于 10 字节的 seed 熵不足（评审指出 1 字节密钥也能算出码），直接按配置错误拒。
  if (key.length < 10) return { ok: false, reason: 'weak-secret', counter: 0 };
  const step = Math.max(1, Math.floor(Number(options.step) || 30));
  const digits = Math.max(6, Math.floor(Number(options.digits) || 6));
  const window = Math.max(0, Math.floor(Number(options.window) || 0));
  const text = String(token === undefined || token === null ? '' : token).trim();
  if (!new RegExp('^\\d{' + digits + '}$').test(text)) return { ok: false, reason: 'bad-format', counter: 0 };
  const nowMs = Number.isFinite(options.timeMs) ? Number(options.timeMs) : Date.now();
  const base = Math.floor(nowMs / 1000 / step);
  const want = Buffer.from(text, 'utf8');
  for (let delta = -window; delta <= window; delta += 1) {
    const counter = base + delta;
    if (counter < 0) continue;
    const expected = hotp(key, counter, digits);
    if (expected === null) continue;
    const got = Buffer.from(expected, 'utf8');
    if (got.length === want.length && crypto.timingSafeEqual(got, want)) return { ok: true, reason: '', counter };
  }
  return { ok: false, reason: 'mismatch', counter: 0 };
}

/** otpauth:// URI，用于把密钥录进离线验证器。 */
export function otpauthUri(input = {}) {
  const secret = String(input.secret === undefined || input.secret === null ? '' : input.secret).toUpperCase();
  const issuer = String(input.issuer === undefined || input.issuer === null ? '' : input.issuer);
  const label = String(input.label === undefined || input.label === null ? '' : input.label);
  const digits = Math.max(6, Math.floor(Number(input.digits) || 6));
  const period = Math.max(1, Math.floor(Number(input.period) || 30));
  const parts = ['secret=' + encodeURIComponent(secret), 'algorithm=SHA1', 'digits=' + digits, 'period=' + period];
  if (issuer !== '') parts.push('issuer=' + encodeURIComponent(issuer));
  // label 里的冒号是「发行方:账号」的分隔符，必须保持字面量：整段 encodeURIComponent 会把它变成 %3A，
  // Google / Microsoft Authenticator 就认不出 issuer 前缀了（会显示成一条没有发行方的条目）。
  // 规范做法是 issuer 与账号各自编码，冒号原样保留。
  const name = issuer === ''
    ? encodeURIComponent(label)
    : encodeURIComponent(issuer) + ':' + encodeURIComponent(label);
  return 'otpauth://totp/' + name + '?' + parts.join('&');
}

/** 恢复码：随机、可一次性校验（scrypt 哈希，不存明文）。 */
export function generateBackupCodes(count = 8) {
  const n = Math.max(1, Math.min(20, Math.floor(Number(count) || 8)));
  const codes = [];
  for (let i = 0; i < n; i += 1) {
    const buf = crypto.randomBytes(5);
    let s = '';
    for (const byte of buf) s += BASE32[byte & 31] + BASE32[(byte >> 5) | ((byte * 3) & 31)];
    const compact = s.slice(0, 10).toUpperCase();
    codes.push(compact.slice(0, 5) + '-' + compact.slice(5));
  }
  return codes;
}

export function hashBackupCode(code, salt) {
  const s = String(salt === undefined || salt === null ? '' : salt);
  if (s === '') return '';
  const norm = String(code === undefined || code === null ? '' : code).toUpperCase().replace(/[^A-Z2-7]/g, '');
  if (norm === '') return '';
  return crypto.scryptSync(norm, s, 32).toString('hex');
}

export function verifyBackupCode(code, hashes, salt) {
  if (!Array.isArray(hashes) || hashes.length === 0) return { ok: false, index: -1 };
  const candidate = hashBackupCode(code, salt);
  if (candidate === '') return { ok: false, index: -1 };
  const buf = Buffer.from(candidate, 'utf8');
  for (let i = 0; i < hashes.length; i += 1) {
    const h = Buffer.from(String(hashes[i] || ''), 'utf8');
    if (h.length === buf.length && crypto.timingSafeEqual(h, buf)) return { ok: true, index: i };
  }
  return { ok: false, index: -1 };
}
