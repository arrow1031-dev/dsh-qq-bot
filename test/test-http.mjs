/** 单元测试：lib/http.js —— IP 公网判定 / HTTP 响应体解析 / 实体解码净化 / set-cookie 合并 */
import { isNonPublicIp, canonicalHost, extractHttpBody, meHeadersFromRaw, meDecodeEntities, meCleanText, meStripCdata } from '../lib/http.js';

const results = [];
let failures = 0;
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok));
  if (ok) console.log('  [PASS] ' + name);
  else { failures += 1; console.log('  [FAIL] ' + name + (detail ? ' — ' + detail : '')); }
};

console.log('1. isNonPublicIp：公网/私网/IPv6/边界判定（防 SSRF 第一道闸）');
check('公网 IPv4 放行', isNonPublicIp('8.8.8.8') === false && isNonPublicIp('1.1.1.1') === false);
check('公网边缘 223.x 放行 / 224+ 组播拒绝', isNonPublicIp('223.255.255.255') === false && isNonPublicIp('224.0.0.1') === true);
check('10/8 与 172.16-31/12 拒绝', isNonPublicIp('10.0.0.1') === true && isNonPublicIp('172.16.0.1') === true && isNonPublicIp('172.31.255.255') === true && isNonPublicIp('172.32.0.1') === false);
check('192.168/16 与 169.254 链路本地与 127 回环拒绝', isNonPublicIp('192.168.1.1') === true && isNonPublicIp('169.254.1.1') === true && isNonPublicIp('127.0.0.1') === true);
check('100.64/10 CGN 拒绝', isNonPublicIp('100.64.0.1') === true && isNonPublicIp('100.127.255.255') === true && isNonPublicIp('100.128.0.1') === false);
check('IPv6 回环/未指定/ULA/链路本地拒绝', isNonPublicIp('::1') === true && isNonPublicIp('::') === true && isNonPublicIp('fc00::1') === true && isNonPublicIp('fe80::1') === true);
check('IPv4 映射的 IPv6 递归判定', isNonPublicIp('::ffff:8.8.8.8') === false && isNonPublicIp('::ffff:192.168.1.1') === true);
check('非字符串/空串视为不可信', isNonPublicIp('') === true && isNonPublicIp(null) === true && isNonPublicIp(undefined) === true);

// F1（验收复测发现）：判定必须建立在「URL 解析器归一后的写法」上。
// 只认某一种写法 = 留下一条换写法就能过的旁路：WHATWG URL 会把 [::ffff:127.0.0.1] 写成 [::ffff:7f00:1]。
check('IPv4 映射按十六进制组写也被拒', ['::ffff:7f00:1', '::ffff:a00:1', '::ffff:c0a8:101', '::ffff:a9fe:a9fe'].every((ip) => isNonPublicIp(ip) === true));
check('IPv4-translated（::ffff:0:0/96）与 NAT64 内嵌 IPv4 被拒', isNonPublicIp('::ffff:0:7f00:1') === true && isNonPublicIp('64:ff9b::7f00:1') === true && isNonPublicIp('::7f00:1') === true);
check('IPv4 非常规写法（八进制/十六进制/短写/整数）归一后仍拒绝', ['0177.0.0.1', '0x7f.0.0.1', '127.1', '2130706433', '0177.0.0.1'].every((ip) => isNonPublicIp(ip) === true));
check('公网不会因归一而被误伤', ['::ffff:5db8:d822', '2001:db8::1', '93.184.216.34', '0x59000000' /* 89.0.0.0 */].every((ip) => isNonPublicIp(ip) === false));
check('canonicalHost 归一结果与 URL 一致', canonicalHost('0177.0.0.1') === '127.0.0.1'
  && canonicalHost('[::ffff:127.0.0.1]') === '[::ffff:7f00:1]'
  && canonicalHost('2130706433') === '127.0.0.1'
  && canonicalHost('example.com') === 'example.com'
  && canonicalHost('a/../b') === '');
check('域名不会被当成字面量放行', isNonPublicIp('example.com') === true && isNonPublicIp('localhost') === true);

console.log('2. extractHttpBody：普通/chunked/截断/无头');
check('普通响应解析出状态码与正文', (() => { const r = extractHttpBody('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\nHello'); return r.status === 200 && r.body === 'Hello' && r.head.includes('200 OK'); })());
check('chunked 按 RFC 7230 解码', (() => { const r = extractHttpBody('HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n5\r\nHello\r\n6\r\n World\r\n0\r\n\r\n'); return r.status === 200 && r.body === 'Hello World'; })());
check('chunked 数据被截断时保留已解析部分（带越界保护）', (() => { const r = extractHttpBody('HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n5\r\nHello\r\nA\r\n12345'); return r.status === 200 && r.body.startsWith('Hello'); })());
check('无头部分隔符返回空', (() => { const r = extractHttpBody('no-header-here'); return r.status === 0 && r.body === ''; })());

console.log('3. meHeadersFromRaw：set-cookie 合并');
check('同名 set-cookie 合并为一条', (() => { const h = meHeadersFromRaw('Set-Cookie: a=1; Path=/\nSet-Cookie: b=2\nContent-Type: text/plain'); return h['set-cookie'] === 'a=1; b=2'; })());
check('空/非字符串输入返回空对象', (() => { const h = meHeadersFromRaw(''); return Object.keys(h).length === 0; })());

console.log('4. 实体解码与文本净化');
check('HTML 实体解码', meDecodeEntities('&amp;lt;&amp;gt;') === '<>' && meDecodeEntities('&#39;quoted&#x2F;') === '\'quoted/' && meDecodeEntities('a&nbsp;b&mdash;c&hellip;') === 'a b—c…');
check('meCleanText 去标签并压缩空白', meCleanText('<p>  hello <b>world</b>  </p>') === 'hello world');
check('meStripCdata 剥 CDATA 包裹', meStripCdata('x<![CDATA[inner]]>y') === 'xinnery');

const passed = results.filter(Boolean).length;
console.log('\n' + passed + '/' + results.length + ' 项通过');
if (failures > 0) { console.log('HTTP 自测失败'); process.exit(1); }
console.log('HTTP 自测通过');
process.exit(0);
