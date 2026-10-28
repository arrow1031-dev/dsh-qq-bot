/**
 * 本地校验代理（guard proxy）：给 Moli 无头浏览器兜底的那层「内网 IP 黑名单」。
 *
 * 为什么需要它：moli 是个独立进程，它会跟随 3xx、加载子资源、跑页面里的 JS fetch，
 * 插件在入口处做的那次 assertPublicHost 只管主文档的那一个域名。把 moli 的全部流量
 * 收进一个只监听回环的代理，逐条请求先过 resolveGuardTarget（isNonPublicIp 那一套规则），
 * 内网目标直接 403——重定向、子资源、DNS rebinding 都在这层被拦下。
 *
 * moli 官方对 --http-proxy 的说明正好是这个意思：
 *   "Moli resolves and pins the proxy endpoint; the proxy is responsible for
 *    resolving and filtering request target hostnames"
 *
 * 只监听 127.0.0.1，不接受外部连接；上游代理（用户配的那个）由本代理再串一跳，
 * 所以本地校验永远发生在最前面，链路上游换节点也不影响。
 */
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
// 判定口径只认策略层：阀门内部不该反过来依赖传输层（避免两处口径漂移）。
import { isNonPublicIp, canonicalHost } from './policy.js';

const HEAD_LIMIT = 64 * 1024;

/** 内网保留后缀：这些名字一律不进解析阶段。 */
const PRIVATE_SUFFIX = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|private)$/i;

/**
 * 把"策略拒绝"和"连接失败"分开：
 * 前者是安全闸拦下的（403），后者是网络/上游代理的问题（502）。
 * 以前两者一律回 403 且响应体一样，结果 moli 和模型都把"代理连不上"
 * 读成"被内网防护拦了"（2026-10-27 审计 P1-4）。
 */
function policyRejection(reason) {
  /** @type {Error & { policyRejected?: boolean }} */
  const error = new Error(reason);
  error.policyRejected = true;
  return error;
}

/**
 * 目标放行判定（用于守卫代理的每一条请求）。
 *
 * 与 http.js 的 assertPublicHost 有一处关键差别：**本地解析失败不算内网**。
 * 走上游代理时，域名本来就是代理侧解析的；本机 DNS 解析不了（常见于只有代理能解析的
 * CDN 域名）时如果直接拒绝，会把整页子资源全误杀——第一版就是这么把 bilibili 的
 * data.bilibili.com 全挡了。所以这里只在「确定是内网」时才拒绝：
 *   - 字面量 IP：直接判 isNonPublicIp
 *   - 保留后缀（localhost / *.local / *.internal …）：拒绝
 *   - 域名能解析：任一地址是内网就拒绝
 *   - 域名解析不了：返回 address=null（「判不了」，不是「安全」）
 *
 * **address=null 只是判定结果，能不能连由调用方决定**：直连模式必须拒绝（见
 * assertDialable），否则退回主机名会让 net.connect 再解析一次，攻击者的权威 DNS
 * 只要在判定时答 SERVFAIL、在连接时答内网地址就能穿过去（2026-10-28 审计 A1）。
 * 只有配了上游代理时，才允许把「解析」这件事交给代理侧。
 */
export async function resolveGuardTarget(host, resolver) {
  const name = String(host === undefined || host === null ? '' : host).trim().replace(/^\[|\]$/g, '');
  if (name === '') return { reason: '空目标', address: null };
  if (net.isIP(name) !== 0) {
    return isNonPublicIp(name) === true
      ? { reason: '目标 ' + name + ' 是非公网地址', address: null }
      : { reason: '', address: name };
  }
  if (PRIVATE_SUFFIX.test(name) === true) return { reason: '目标域名 ' + name + ' 属于内网保留后缀', address: null };
  const lookup = (typeof resolver === 'function') ? resolver : ((target) => dns.lookup(target, { all: true }));
  let addrs = [];
  try { addrs = await lookup(name); } catch { return { reason: '', address: null }; }
  for (const addr of addrs === undefined || addrs === null ? [] : addrs) {
    if (isNonPublicIp(addr.address) === true) return { reason: '目标 ' + name + ' 解析到非公网 IP：' + addr.address, address: null };
  }
  // 关键：把判定时解析到的地址一并返回，连接阶段用它直连，不再让 net.connect 重新解析一次。
  // 以前「先查后连」是两次解析：TTL=0 的域名可以先答公网骗过判定、再答 127.0.0.1 打内网
  // （DNS rebinding TOCTOU，与 0.12.4 修 publicFetch 时封的是同一类问题）。
  const pinned = (Array.isArray(addrs) && addrs.length > 0) ? String(addrs[0].address) : null;
  return { reason: '', address: pinned };
}

function normalizeHost(value) {
  // 复用 http.js 的 canonicalHost（走 URL 解析器）：0177.0.0.1 / 0x7f.0.0.1 / 127.1 /
  // 2130706433 全部归一成 127.0.0.1，IPv4 尾部点也会去掉。
  //
  // 为什么不用手写的"去尾点"：那些写法 net.isIP 都认不出来（返回 0），会被当成域名。
  // 实测确认靠 dns.lookup 也能拦住——本机 getaddrinfo 支持 inet_aton 语义，查
  // '0177.0.0.1' 直接得到 127.0.0.1，判定照样命中。但那是在依赖平台行为，而且多一次
  // 查询；归一放在判定之前更稳，也顺手省掉这次 DNS。
  return canonicalHost(value);
}

function parseHostPort(authority) {
  const text = String(authority === undefined || authority === null ? '' : authority).trim();
  if (text === '') return null;
  // [::1]:443 这种带方括号的形式不会出现在公网目标上，但按规范拆一下更稳
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
  if (bracket !== null) {
    const port = bracket[2] === undefined ? 443 : Number(bracket[2]);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? { host: normalizeHost(bracket[1]), port } : null;
  }
  // CONNECT 目标不该带 userinfo：`user@127.0.0.1:80` 以前会被整个当主机名放行，
  // 再由上游代理按 @ 之后解析——判定看的和实际连的不是同一个名字（P1-5）。
  if (text.includes('@') === true) return null;
  const index = text.lastIndexOf(':');
  if (index < 0) return { host: normalizeHost(text), port: 443 };
  const port = Number(text.slice(index + 1));
  const host = text.slice(0, index);
  if (host === '' || Number.isInteger(port) !== true || port <= 0 || port > 65535) return null;
  // 没加方括号却含冒号：要么是 IPv6（本该带方括号），要么是 `host:80:90` 这种畸形。
  // 以前整串会变成 hostname 交给 DNS/上游去猜，等于放弃判定。
  if (host.includes(':') === true) return null;
  return { host: normalizeHost(host), port };
}

function parseProxyUrl(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (text === '') return null;
  try {
    const url = new URL(text.includes('://') ? text : 'http://' + text);
    if (url.protocol !== 'http:') return null;      // 只支持 HTTP 代理（SOCKS 由 moli 自己直连）
    const port = url.port === '' ? 80 : Number(url.port);
    if (url.hostname === '' || Number.isInteger(port) !== true || port <= 0) return null;
    return { host: url.hostname, port };
  } catch { return null; }
}

/**
 * @param {object} [options]
 * @param {string} [options.upstreamProxy] 用户配的代理（http://host:port），本代理串在它前面
 * @param {(host: string) => Promise<Array<{ address: string, family?: number }>>} [options.resolve] 域名解析（测试注入用，默认系统解析）
 * @param {(line: string) => void} [options.log]
 */
export function createGuardProxy(options = {}) {
  const log = (typeof options.log === 'function') ? options.log : () => {};
  // 解析函数可注入：测试用它模拟「同一域名先后给出不同答案」，生产用系统解析。
  const resolver = (typeof options.resolve === 'function') ? options.resolve : undefined;
  const upstreamRaw = (typeof options.upstreamProxy === 'string') ? options.upstreamProxy.trim() : '';
  const upstream = parseProxyUrl(upstreamRaw);
  // 配了却不认识（典型是 socks5://）：以前默默当直连，用户以为走的是自己的代理，
  // 实际由本机直接出网——既漏掉代理链，也让"解析失败就放行"的判定面对真实 DNS（P1-12）。
  if (upstreamRaw !== '' && upstream === null) {
    log('守卫代理：上游代理「' + upstreamRaw + '」无法解析（只支持 http://host:port），本次改为直连');
  }
  const sockets = new Set();
  let server = null;
  let boundPort = 0;
  let starting = null;

  function track(socket) {
    sockets.add(socket);
    const drop = () => { sockets.delete(socket); };
    socket.on('close', drop);
    socket.on('error', drop);
  }

  function refuse(clientSocket, status, reason, body) {
    // 状态行里的 reason 用规范大写（Blocked / Upstream Unreachable）；响应体**由调用方显式传入**
    // 小写文案（见下面的 403/502），靠它判因、不看状态行。只有没传 body 时才回落到
    // 'guard-proxy: <status> <Reason>'——那种写法 reason 是大写，与显式文案不一致，别依赖它。
    const text = body === undefined ? ('guard-proxy: ' + status + ' ' + reason) : body;
    try {
      clientSocket.end('HTTP/1.1 ' + status + ' ' + reason + '\r\n'
        + 'content-type: text/plain; charset=utf-8\r\n'
        + 'connection: close\r\n\r\n'
        + text + '\n');
    } catch { /* 对端已经关了 */ }
  }

  /** 判定阶段没拿到地址时的分流：直连一律拒绝，走上游代理才允许交给代理侧解析。
   *
   * 为什么直连必须拒绝：`connectTarget` 以前在 pinned 为空时退回主机名，等于让
   * `net.connect` 再解析一次。攻击者的权威 DNS 只要按查询序号作答（判定时 SERVFAIL、
   * 连接时 10.0.0.5），就能把隧道导进内网——判定和执行看的不是同一个地址，
   * 正是 resolveGuardTarget 里那段注释想封掉的 TOCTOU（2026-10-28 审计 A1，PoC 已复现）。
   * 直连模式下「本机解析不了」本来也连不上，拒绝不会误杀任何正常目标。 */
  function assertDialable(host, verdict) {
    if (verdict.address !== null && verdict.address !== '') return;
    if (upstream !== null) {
      // 走上游代理时域名由代理侧解析：只有代理能解析的 CDN 域名靠这条才不被误杀。
      // 代价是这一段判定权交给了代理，攻击者可控域名理论上仍可借代理指向内网
      // （A1 的代理变体），所以留一行日志便于事后追溯。
      log('守卫代理放行无法本地解析的目标 ' + host + '（交给上游代理解析）');
      return;
    }
    throw policyRejection('目标 ' + host + ' 无法在本机解析，直连模式拒绝盲连');
  }

  /** 建一条到目标的连接：配了上游代理就先向上游发 CONNECT 拿隧道。
   *  pinned 是判定阶段解析出的公网地址；直连必须用它，绝不再让 net.connect 解析一次。 */
  function connectTarget(host, port, pinned) {
    if (upstream === null) {
      // 兜底：调用方漏了 assertDialable 也不能退回主机名（见 assertDialable 的注释）。
      if (typeof pinned !== 'string' || pinned === '') {
        return Promise.reject(policyRejection('目标 ' + host + ' 无法在本机解析，直连模式拒绝盲连'));
      }
      const dialHost = pinned;
      return new Promise((resolve, reject) => {
        const socket = net.connect({ host: dialHost, port }, () => {
          // 这个 30s 只是"建连阶段"的兜底；连上之后必须撤掉，
          // 否则 setTimeout 是**空闲**超时：隧道只要 30 秒没字节就被 destroy，
          // keep-alive 池 / SSE / 长时间无帧的 wss 都会无辜被砍（P1-2）。
          socket.setTimeout(0);
          resolve(socket);
        });
        socket.once('error', reject);
        socket.setTimeout(30000, () => { socket.destroy(new Error('连接目标超时')); });
      });
    }
    return new Promise((resolve, reject) => {
      const authority = host + ':' + String(port);
      const socket = net.connect({ host: upstream.host, port: upstream.port }, () => {
        socket.write('CONNECT ' + authority + ' HTTP/1.1\r\nHost: ' + authority + '\r\n\r\n');
      });
      let received = '';
      const onData = (chunk) => {
        received += chunk.toString('latin1');
        if (received.length > HEAD_LIMIT) {
          socket.removeListener('data', onData);
          socket.destroy();
          reject(new Error('上游代理响应头过大'));
          return;
        }
        const end = received.indexOf('\r\n\r\n');
        if (end < 0) return;
        socket.removeListener('data', onData);
        const statusLine = received.slice(0, received.indexOf('\r\n'));
        if (/ 200\b/.test(statusLine) !== true) {
          socket.destroy();
          reject(new Error('上游代理拒绝：' + statusLine));
          return;
        }
        const rest = received.slice(end + 4);
        if (rest !== '') socket.unshift(Buffer.from(rest, 'latin1'));
        socket.setTimeout(0);
        resolve(socket);
      };
      socket.on('data', onData);
      socket.once('error', reject);
      socket.setTimeout(30000, () => { socket.destroy(new Error('上游代理握手超时')); });
    });
  }

  function pipeBoth(a, b) {
    a.pipe(b);
    b.pipe(a);
    const end = () => { try { a.destroy(); } catch { /* 关闭中 */ } try { b.destroy(); } catch { /* 关闭中 */ } };
    a.on('error', end);
    b.on('error', end);
    a.on('close', end);
    b.on('close', end);
  }

  function onConnect(req, clientSocket, head) {
    track(clientSocket);
    const parsed = parseHostPort(req.url);
    if (parsed === null) { refuse(clientSocket, '400', 'Bad Request'); return; }
    resolveGuardTarget(parsed.host, resolver).then((verdict) => {
      if (verdict.reason !== '') throw policyRejection(verdict.reason);
      assertDialable(parsed.host, verdict);
      return connectTarget(parsed.host, parsed.port, verdict.address);
    }).then((target) => {
      track(target);
      if (clientSocket.destroyed === true) { target.destroy(); return; }
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head !== undefined && head !== null && head.length > 0) target.write(head);
      pipeBoth(clientSocket, target);
    }).catch((error) => {
      const why = String(error && error.message ? error.message : error);
      const rejected = error !== null && error !== undefined && error.policyRejected === true;
      // 措辞也分开：以前连接失败也写"拒绝"，日志读起来像安全拦截，排障时会走错路。
      log('守卫代理' + (rejected === true ? '拒绝' : '转发失败') + ' CONNECT ' + parsed.host + ':' + String(parsed.port) + '（' + why + '）');
      // 响应体必须与明文分支（onRequest 里的 res.end）逐字一致：tools.js 与测试都靠这句话
      // 区分「被守卫拦下」和「上游连不上」，两条路径曾经一个 Blocked 一个 blocked。
      if (rejected === true) refuse(clientSocket, '403', 'Blocked', 'guard-proxy: 403 blocked by public-address check');
      else refuse(clientSocket, '502', 'Upstream Unreachable', 'guard-proxy: 502 upstream unreachable');
    });
  }

  function onRequest(req, res) {
    // 走代理的明文 http 请求是以绝对 URI 形式来的：GET http://host/path HTTP/1.1
    let parsed;
    try { parsed = new URL(String(req.url === undefined ? '' : req.url)); } catch { res.writeHead(400); res.end('guard-proxy: bad request'); return; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') { res.writeHead(400); res.end('guard-proxy: bad scheme'); return; }
    resolveGuardTarget(parsed.hostname, resolver).then((verdict) => {
      if (verdict.reason !== '') throw policyRejection(verdict.reason);
      assertDialable(parsed.hostname, verdict);
      return new Promise((resolve, reject) => {
      const headers = Object.assign({}, req.headers);
      delete headers['proxy-connection'];
      // 虚拟主机路由靠 Host 头；连接目标换成钉住的 IP，两者分开。
      headers.host = parsed.host;
      const targetPort = parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port);
      let upstreamReq;
      if (upstream !== null) {
        upstreamReq = http.request({
          host: upstream.host, port: upstream.port, method: req.method,
          path: parsed.href, headers: headers,
        }, resolve);
      } else {
        upstreamReq = http.request({
          // 直连地址只认判定阶段钉住的那个（assertDialable 已保证非空），
          // 绝不退回 parsed.hostname —— 那等于把判定权交给第二次解析。
          host: String(verdict.address), port: targetPort, method: req.method,
          path: parsed.pathname + parsed.search, headers: headers,
        }, resolve);
      }
      upstreamReq.on('error', reject);
      upstreamReq.setTimeout(30000, () => upstreamReq.destroy(new Error('请求目标超时')));
      req.pipe(upstreamReq);
      });
    }).then((upstreamRes) => {
      res.writeHead(upstreamRes.statusCode === undefined ? 502 : upstreamRes.statusCode, upstreamRes.headers);
      // 两头互相收尸：浏览器中途断开要停掉对目标的请求；目标端中途报错也要断掉浏览器这边，
      // 否则 res 会一直挂到超时（P1-10）。
      res.on('close', () => { try { upstreamRes.destroy(); } catch { /* 已关 */ } });
      upstreamRes.on('error', () => { try { res.destroy(); } catch { /* 已关 */ } });
      upstreamRes.pipe(res);
    }).catch((error) => {
      const why = String(error && error.message ? error.message : error);
      const rejected = error !== null && error !== undefined && error.policyRejected === true;
      log('守卫代理' + (rejected === true ? '拒绝' : '转发失败') + '请求 ' + parsed.hostname + '（' + why + '）');
      if (rejected === true) {
        if (res.headersSent !== true) res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('guard-proxy: 403 blocked by public-address check\n');
      } else {
        if (res.headersSent !== true) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('guard-proxy: 502 upstream unreachable (' + why + ')\n');
      }
    });
  }

  return {
    async start() {
      // 先看有没有正在启动的：IIFE 里第一件事就把 server 建出来了，所以下一个并发调用
      // 会先命中「server 非空」并拿到 boundPort=0。判断顺序必须是 starting 优先（P1-8）。
      if (starting !== null) return starting;
      if (server !== null) return boundPort;
      starting = (async () => {
        server = http.createServer();
        server.on('request', onRequest);
        server.on('connect', onConnect);
        server.on('connection', track);
        // 别让这个监听器拖住进程退出：它只是个可选的辅助代理，插件卸载或宿主收尾时
        // 即便没人调 stop()，事件循环也不该因为它在监听就退不出去（P1-11）。
        if (typeof server.unref === 'function') server.unref();
        await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
          const onError = (error) => { server = null; reject(error); };
          server.once('error', onError);
          // 只监听回环：外面连不进来，这个代理就没法被当成跳板
          server.listen(0, '127.0.0.1', () => {
            server.removeListener('error', onError);
            const address = server.address();
            boundPort = (address !== null && typeof address === 'object') ? address.port : 0;
            log('校验代理已启动 127.0.0.1:' + String(boundPort) + (upstream === null ? '' : '（上游 ' + upstream.host + ':' + String(upstream.port) + '）'));
            resolve();
          });
        }));
        return boundPort;
      })();
      try {
        return await starting;
      } finally {
        starting = null;
      }
    },
    port() { return boundPort; },
    async stop() {
      for (const socket of sockets) { try { socket.destroy(); } catch { /* 关闭中 */ } }
      sockets.clear();
      const current = server;
      server = null;
      boundPort = 0;
      if (current === null) return;
      await /** @type {Promise<void>} */ (new Promise((resolve) => current.close(() => resolve())));
    },
  };
}
