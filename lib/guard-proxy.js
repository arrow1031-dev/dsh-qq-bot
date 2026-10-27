/**
 * 本地校验代理（guard proxy）：给 Moli 无头浏览器兜底的那层「内网 IP 黑名单」。
 *
 * 为什么需要它：moli 是个独立进程，它会跟随 3xx、加载子资源、跑页面里的 JS fetch，
 * 插件在入口处做的那次 assertPublicHost 只管主文档的那一个域名。把 moli 的全部流量
 * 收进一个只监听回环的代理，逐条请求先过 guardTargetAllowed（isNonPublicIp 那一套规则），
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
import { isNonPublicIp } from './http.js';

const HEAD_LIMIT = 64 * 1024;

/** 内网保留后缀：这些名字一律不进解析阶段。 */
const PRIVATE_SUFFIX = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|private)$/i;

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
 *   - 域名解析不了：放行，交给代理侧解析（连不上自然失败，不是安全拒绝）
 */
/**
 * 把"策略拒绝"和"连接失败"分开：
 * 前者是安全闸拦下的（403），后者是网络/上游代理的问题（502）。
 * 以前两者一律回 403 且响应体一样，结果 moli 和模型都把"代理连不上"
 * 读成"被内网防护拦了"（2026-10-27 审计 P1-4）。
 */
function policyRejection(reason) {
  const error = new Error(reason);
  error.policyRejected = true;
  return error;
}

async function guardTargetAllowed(host) {
  const name = String(host === undefined || host === null ? '' : host).trim().replace(/^\[|\]$/g, '');
  if (name === '') return '空目标';
  if (net.isIP(name) !== 0) {
    return isNonPublicIp(name) ? '目标 ' + name + ' 是非公网地址' : '';
  }
  if (PRIVATE_SUFFIX.test(name) === true) return '目标域名 ' + name + ' 属于内网保留后缀';
  let addrs = [];
  try { addrs = await dns.lookup(name, { all: true }); } catch { return ''; }
  for (const addr of addrs) {
    if (isNonPublicIp(addr.address) === true) return '目标 ' + name + ' 解析到非公网 IP：' + addr.address;
  }
  return '';
}

/**
 * 目标主机名归一。尾部点必须去掉：`127.0.0.1.` 与 `127.0.0.1` 是同一个目标，
 * 但 `net.isIP('127.0.0.1.')` 返回 0，于是它被当成"域名"跳过字面量判定、
 * 再交给 DNS 解析成 127.0.0.1 放行过去（P1-5 实测可达）。
 */
function normalizeHost(value) {
  let name = String(value === undefined || value === null ? '' : value).trim();
  while (name.length > 1 && name.endsWith('.') === true) name = name.slice(0, -1);
  return name;
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
 * @param {(line: string) => void} [options.log]
 */
export function createGuardProxy(options = {}) {
  const log = (typeof options.log === 'function') ? options.log : () => {};
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

  function refuse(clientSocket, status, reason) {
    try {
      clientSocket.end('HTTP/1.1 ' + status + ' ' + reason + '\r\n'
        + 'content-type: text/plain; charset=utf-8\r\n'
        + 'connection: close\r\n\r\n'
        + 'guard-proxy: ' + status + ' ' + reason + '\n');
    } catch { /* 对端已经关了 */ }
  }

  /** 建一条到目标的连接：配了上游代理就先向上游发 CONNECT 拿隧道。 */
  function connectTarget(host, port) {
    if (upstream === null) {
      return new Promise((resolve, reject) => {
        const socket = net.connect({ host, port }, () => {
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
    guardTargetAllowed(parsed.host).then((reason) => {
      if (reason !== '') throw policyRejection(reason);
      return connectTarget(parsed.host, parsed.port);
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
      if (rejected === true) refuse(clientSocket, '403', 'Blocked by public-address check');
      else refuse(clientSocket, '502', 'Upstream unreachable');
    });
  }

  function onRequest(req, res) {
    // 走代理的明文 http 请求是以绝对 URI 形式来的：GET http://host/path HTTP/1.1
    let parsed;
    try { parsed = new URL(String(req.url === undefined ? '' : req.url)); } catch { res.writeHead(400); res.end('guard-proxy: bad request'); return; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') { res.writeHead(400); res.end('guard-proxy: bad scheme'); return; }
    guardTargetAllowed(parsed.hostname).then((reason) => {
      if (reason !== '') throw policyRejection(reason);
      return new Promise((resolve, reject) => {
      const headers = Object.assign({}, req.headers);
      delete headers['proxy-connection'];
      const targetPort = parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port);
      let upstreamReq;
      if (upstream !== null) {
        upstreamReq = http.request({
          host: upstream.host, port: upstream.port, method: req.method,
          path: parsed.href, headers: headers,
        }, resolve);
      } else {
        upstreamReq = http.request({
          host: parsed.hostname, port: targetPort, method: req.method,
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
        await new Promise((resolve, reject) => {
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
        });
        return boundPort;
      })();
      try {
        return await starting;
      } finally {
        starting = null;
      }
    },
    port() { return boundPort; },
    get upstreamLabel() { return upstream === null ? '' : upstream.host + ':' + String(upstream.port); },
    async stop() {
      for (const socket of sockets) { try { socket.destroy(); } catch { /* 关闭中 */ } }
      sockets.clear();
      const current = server;
      server = null;
      boundPort = 0;
      if (current === null) return;
      await new Promise((resolve) => current.close(() => resolve()));
    },
  };
}
