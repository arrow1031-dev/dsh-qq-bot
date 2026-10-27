#!/usr/bin/env node
/**
 * 本地校验代理（内网 IP 黑名单的落点）自测。
 *
 *   node test/test-guard-proxy.mjs
 *
 * 只测「拒绝」这一类：不依赖外网，内网目标在 DNS/字面量阶段就被判掉，
 * 跑在离网 CI 上也是同样的结果。公网放行由人工在真机上验证过（moli → 代理 → 上游代理 → 目标）。
 */
import http from 'node:http';
import { createGuardProxy } from '../lib/guard-proxy.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail === '' ? '' : ' — ' + detail)); }
}

/** 以 CONNECT 形式请求代理，返回状态码（吃到响应头即断开）。 */
function connectVia(port, authority) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: authority, timeout: 15000 });
    req.on('connect', (res) => { resolve(res.statusCode); req.destroy(); });
    req.on('response', (res) => { resolve(res.statusCode); res.resume(); });
    req.on('timeout', () => { req.destroy(); resolve('timeout'); });
    req.on('error', () => resolve('closed'));
    req.end();
  });
}

/** 以「绝对 URI」形式请求代理（明文 http）。 */
function getVia(port, url) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: url, timeout: 15000 }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('timeout', () => { req.destroy(); resolve('timeout'); });
    req.on('error', () => resolve('closed'));
    req.end();
  });
}

const logs = [];
const proxy = createGuardProxy({ log: (line) => logs.push(line) });
const port = await proxy.start();

console.log('1. 起得来');
check('返回了回环端口', Number.isInteger(port) && port > 0, String(port));
check('日志里说明了监听地址', logs.some((l) => l.includes('127.0.0.1:' + port)), logs.join(' | '));

console.log('\n2. CONNECT 内网一律 403');
const cases = [
  ['回环 IPv4', '127.0.0.1:3080'],
  ['云元数据', '169.254.169.254:80'],
  ['私网 10/8', '10.1.2.3:443'],
  ['私网 192.168', '192.168.1.10:8080'],
  ['私网 172.16', '172.20.0.1:80'],
  ['CGN 100.64', '100.64.0.1:80'],
  ['IPv6 回环', '[::1]:80'],
  ['IPv6 链路本地', '[fe80::1]:80'],
  ['IPv6 ULA', '[fd00::1]:80'],
  ['6to4 内嵌回环', '[2002:7f00:1::]:80'],
  ['localhost 域名', 'localhost:3080'],
];
for (const [name, authority] of cases) {
  const status = await connectVia(port, authority);
  check('拒绝 ' + name, status === 403, 'status=' + String(status));
}

console.log('\n3. CONNECT 非法目标不崩');
const bad = await connectVia(port, 'no-port-and-no-colon');
check('缺端口的 authority 被处理（400 或 403）', bad === 400 || bad === 403, 'status=' + String(bad));
const badPort = await connectVia(port, 'example.com:0');
check('端口 0 被拒', badPort === 400 || badPort === 403 || badPort === 'closed', 'status=' + String(badPort));

console.log('\n4. 明文 http 绝对 URI 也过同一道闸');
const plain = await getVia(port, 'http://127.0.0.1:3080/');
check('拒绝 127.0.0.1 的明文请求', plain === 403, 'status=' + String(plain));

console.log('\n5. 全被拒之后代理还活着');
const again = await connectVia(port, '192.168.1.1:80');
check('后续请求照常返回 403（没有被打崩）', again === 403, 'status=' + String(again));

console.log('\n6. stop 之后端口不再接受连接');
await proxy.stop();
const after = await connectVia(port, '192.168.1.1:80');
check('停掉后连不上', after === 'closed' || after === 'timeout', String(after));

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail > 0) process.exitCode = 1;
