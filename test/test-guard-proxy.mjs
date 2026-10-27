#!/usr/bin/env node
/**
 * 本地校验代理（内网 IP 黑名单的落点）自测。
 *
 *   node test/test-guard-proxy.mjs
 *
 * 判别力说明（2026-10-27 审计 P3-1 之后重写）：
 * 旧版本只看 statusCode，而守卫把「连接失败」也回 403——把实现改成「一律放行」之后
 * 大部分用例照样绿，通过的理由根本不是策略拒绝。现在每个拒绝用例都配一个本地监听器数
 * accept：只要真的连过去了 accept 就 > 0，用例必红。另加上游代理链路与 403/502 语义
 * 分离的用例。全部离网可跑（公网侧一律用 IP 字面量 + 假上游，不做真实解析）。
 */
import http from 'node:http';
import net from 'node:net';
import { createGuardProxy, resolveGuardTarget } from '../lib/guard-proxy.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail === '' ? '' : ' — ' + detail)); }
}

/** 本地「目标」监听器：只数 accept，进来就断。用来证明守卫真的没有把连接放过去。 */
async function startTarget() {
  const state = { accepts: 0, port: 0 };
  const server = net.createServer((socket) => { state.accepts += 1; socket.destroy(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = server.address().port;
  state.close = () => new Promise((resolve) => {
    try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections(); } catch { /* 老 Node */ }
    server.close(() => resolve());
    const timer = setTimeout(resolve, 1000);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return state;
}

/** 假上游代理：记录收到的 CONNECT 目标；mode=ok 回 200 并保持，mode=deny 回 403。 */
async function startUpstream(mode) {
  const state = { seen: [], port: 0 };
  const server = http.createServer((req, res) => { res.writeHead(400); res.end(); });
  server.on('connect', (req, socket) => {
    state.seen.push(req.url);
    socket.on('error', () => {});
    if (mode === 'ok') {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    } else {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = server.address().port;
  state.close = () => new Promise((resolve) => {
    try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections(); } catch { /* 老 Node */ }
    server.close(() => resolve());
    const timer = setTimeout(resolve, 1000);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return state;
}

/**
 * 以 CONNECT 形式请求代理，返回 { status, body }。
 *
 * 用裸 socket 手写而不是 http.request：Node 对 CONNECT 的**非 200** 响应走 'connect' 事件，
 * 那里面拿不到响应体，于是"403 说被拦 / 502 说上游不通"这两句文案没法断言（旧版正是因此
 * 只能比对状态码，也才让"一律放行"的变异体蒙混过关）。
 */
function connectVia(port, authority) {
  return new Promise((resolve) => {
    let done = false;
    let data = '';
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.write('CONNECT ' + authority + ' HTTP/1.1\r\nHost: ' + authority + '\r\n\r\n');
    });
    const finish = () => {
      if (done === true) return;
      done = true;
      socket.destroy();
      const statusMatch = /^HTTP\/1\.[01] (\d{3})/.exec(data);
      const bodyStart = data.indexOf('\r\n\r\n');
      const body = bodyStart < 0 ? '' : data.slice(bodyStart + 4);
      resolve({ status: statusMatch === null ? 'closed' : Number(statusMatch[1]), body });
    };
    const timer = setTimeout(finish, 5000);
    if (typeof timer.unref === 'function') timer.unref();
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      data += chunk;
      if (data.indexOf('\r\n\r\n') >= 0) finish();
    });
    socket.on('end', finish);
    socket.on('close', finish);
    socket.on('error', finish);
  });
}

/** 以「绝对 URI」形式请求代理（明文 http），返回 { status, body }。 */
function getVia(port, url) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: url, timeout: 8000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'timeout', body: '' }); });
    req.on('error', () => resolve({ status: 'closed', body: '' }));
    req.end();
  });
}

const target = await startTarget();

const logs = [];
const proxy = createGuardProxy({ log: (line) => logs.push(line) });
const port = await proxy.start();

console.log('1. 起得来');
check('返回了回环端口', Number.isInteger(port) && port > 0, String(port));
check('日志里说明了监听地址', logs.some((l) => l.includes('127.0.0.1:' + port)), logs.join(' | '));

console.log('\n1b. 并发 start 返回同一个有效端口（P1-8）');
{
  const concurrent = createGuardProxy({ log: () => {} });
  const [first, second] = await Promise.all([concurrent.start(), concurrent.start()]);
  check('两次并发 start 都不返回 0', first > 0 && second > 0, 'a=' + String(first) + ' b=' + String(second));
  check('两次拿到同一个端口', first === second, 'a=' + String(first) + ' b=' + String(second));
  await concurrent.stop();
}

console.log('\n1c. 不认识的上游代理会告警，而不是静默直连（P1-12）');
{
  const quiet = [];
  const socks = createGuardProxy({ upstreamProxy: 'socks5://127.0.0.1:1080', log: (line) => quiet.push(line) });
  await socks.start();
  check('日志里说明了改直连', quiet.some((l) => l.includes('无法解析')), quiet.join(' | '));
  await socks.stop();
}

console.log('\n2. CONNECT 内网一律 403，且**真的没有连过去**（accept 计数）');
const loop = await connectVia(port, '127.0.0.1:' + String(target.port));
check('拒绝 回环目标', loop.status === 403, 'status=' + String(loop.status));
check('回环目标根本没有被连上（accept=0）', target.accepts === 0, 'accepts=' + String(target.accepts));
check('403 的响应体说明了是策略拒绝', /public-address/.test(loop.body), JSON.stringify(loop.body.slice(0, 80)));

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
  ['Teredo 内嵌回环', '[2001:0:4136:e378:0:9cbf:80ff:fffe]:80'],
  ['localhost 域名', 'localhost:3080'],
  ['带尾部点的回环', '127.0.0.1.:3080'],
  ['带尾部点的私网', '192.168.1.10.:8080'],
  // 下面四种写法 net.isIP 都认不出来；这里既守住"靠 dns.lookup 兜底也能拦"的现状，
  // 也守住改用 canonicalHost 归一之后依然拦得住（变异实验确认：换回手写去尾点，这四条仍然绿——
  // 拦是拦住了，只是靠 DNS 而不是靠归一，所以它们是回归保护，不是"修复绕过"的证据）。
  ['八进制写法', '0177.0.0.1:3080'],
  ['十六进制写法', '0x7f.0.0.1:3080'],
  ['短写', '127.1:3080'],
  ['整数写法', '2130706433:3080'],
  ['IPv6 映射写法', '[::ffff:7f00:1]:3080'],
];
for (const [name, authority] of cases) {
  const got = await connectVia(port, authority);
  check('拒绝 ' + name, got.status === 403, 'status=' + String(got.status));
}

console.log('\n3. 畸形 authority 回 400（而不是被当成目标去连）');
for (const [name, authority] of [['端口 0', 'example.com:0'], ['端口越界', 'example.com:99999'], ['端口非数字', 'example.com:abc'], ['带 userinfo 的目标', 'user@127.0.0.1:80'], ['多冒号畸形目标', '127.0.0.1:80:90']]) {
  const got = await connectVia(port, authority);
  check(name + ' → 400', got.status === 400, 'status=' + String(got.status));
}
// 缺端口：按 443 容错处理，于是走公网连接→失败 502；关键是它**没有**被当成内网目标放过去，也没把测试挂住。
{
  const got = await connectVia(port, 'no-port-and-no-colon');
  check('缺端口按 443 容错（502 或 400，不 hang）', got.status === 502 || got.status === 400, 'status=' + String(got.status));
}

console.log('\n4. 明文 http 绝对 URI 也过同一道闸');
const plain = await getVia(port, 'http://127.0.0.1:' + String(target.port) + '/');
check('拒绝 127.0.0.1 的明文请求', plain.status === 403, 'status=' + String(plain.status));
check('明文请求同样没有连到目标', target.accepts === 0, 'accepts=' + String(target.accepts));
check('明文 403 的响应体说明是策略拒绝', /public-address/.test(plain.body), JSON.stringify(plain.body.slice(0, 80)));

console.log('\n5. 上游代理链路（以前完全没测）');
const upOk = await startUpstream('ok');
const proxy2 = createGuardProxy({ upstreamProxy: 'http://127.0.0.1:' + String(upOk.port), log: () => {} });
const port2 = await proxy2.start();
const viaUp = await connectVia(port2, '1.2.3.4:443');
check('公网 IP 经上游放行', viaUp.status === 200, 'status=' + String(viaUp.status));
check('上游确实收到了 CONNECT', upOk.seen.includes('1.2.3.4:443'), JSON.stringify(upOk.seen));

console.log('\n6. 上游拒绝时回 502，不是 403（语义分离）');
const upDeny = await startUpstream('deny');
const proxy3 = createGuardProxy({ upstreamProxy: 'http://127.0.0.1:' + String(upDeny.port), log: () => {} });
const port3 = await proxy3.start();
const viaDeny = await connectVia(port3, '1.2.3.4:443');
check('上游拒绝 → 502', viaDeny.status === 502, 'status=' + String(viaDeny.status));
check('502 的响应体说明是上游不可达', /upstream unreachable/i.test(viaDeny.body), JSON.stringify(viaDeny.body.slice(0, 80)));

console.log('\n7. 上游死端口（连不上）也回 502');
const proxy4 = createGuardProxy({ upstreamProxy: 'http://127.0.0.1:1', log: () => {} });
const port4 = await proxy4.start();
const viaDead = await connectVia(port4, '1.2.3.4:443');
check('上游连不上 → 502', viaDead.status === 502, 'status=' + String(viaDead.status));

console.log('\n8. 全被拒之后代理还活着');
const again = await connectVia(port, '192.168.1.1:80');
check('后续请求照常返回 403（没有被打崩）', again.status === 403, 'status=' + String(again.status));

console.log('\n9. stop 之后端口不再接受连接');
await proxy.stop();
await proxy2.stop();
await proxy3.stop();
await proxy4.stop();
const after = await connectVia(port, '192.168.1.1:80');
check('停掉后连不上', after.status === 'closed' || after.status === 'timeout', String(after.status));

await target.close();
await upOk.close();
await upDeny.close();


console.log('\n10. 解析即钉住（DNS rebinding 只在判定那一次决胜）');
{
  let calls = 0;
  const rebind = async () => { calls += 1; return calls === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]; };
  const first = await resolveGuardTarget('rebind.test', rebind);
  check('判定时解析出的公网地址被一并返回（连接阶段不再解析）', first.reason === '' && first.address === '93.184.216.34', JSON.stringify(first));
  check('一个目标只解析一次', calls === 1, 'calls=' + String(calls));
  const priv = await resolveGuardTarget('rebind.test', async () => [{ address: '10.0.0.1', family: 4 }]);
  check('解析出内网就拒绝（带原因）', typeof priv.reason === 'string' && priv.reason.includes('非公网') && priv.address === null, JSON.stringify(priv));
  const noDns = await resolveGuardTarget('no-such-host.test', async () => { throw new Error('ENOTFOUND'); });
  check('本机解析不了 → 不判内网、交给连接阶段（保留旧语义）', noDns.reason === '' && noDns.address === null, JSON.stringify(noDns));
}
console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail > 0) process.exitCode = 1;