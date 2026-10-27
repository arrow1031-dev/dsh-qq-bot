// 通用 HTTP 传输层（multiEngineRequest / 代理 CONNECT 隧道 / 文本工具）。
// 被 websearch.js 与 imgsearch.js 共用 —— 两个搜索模块都受本模块的 http 代理管控。
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { lookup as dnsLookup } from 'node:dns/promises';
function extractHttpBody(rawText) {
  const headEnd = rawText.indexOf('\r\n\r\n');
  if (headEnd < 0) return { status: 0, body: '', head: '' };
  const head = rawText.slice(0, headEnd);
  const statusMatch = head.match(/^HTTP\/\S+ (\d{3})/);
  const rest = rawText.slice(headEnd + 4);
  if (/transfer-encoding:\s*chunked/i.test(head)) {
    // 按 RFC 7230 解码 chunked：逐帧读大小行 + 数据 + 尾部 CRLF（Buffer 操作，带越界保护）。
    const buf = Buffer.from(rest, 'utf8');
    const parts = [];
    let pos = 0;
    while (pos < buf.length) {
      const nl = buf.indexOf('\r\n', pos);
      if (nl < 0) break;
      const size = parseInt(buf.slice(pos, nl).toString('utf8').trim(), 16);
      if (!Number.isFinite(size) || size === 0) break;
      const end = nl + 2 + size;
      if (end > buf.length) { parts.push(buf.slice(nl + 2)); break; }
      parts.push(buf.slice(nl + 2, end));
      pos = end + 2;
    }
    return { status: statusMatch ? Number(statusMatch[1]) : 0, body: Buffer.concat(parts).toString('utf8'), head };
  }
  return { status: statusMatch ? Number(statusMatch[1]) : 0, body: rest, head };
}
/** 从 HTTP 响应头文本里取 set-cookie（合并成 name=value; 串），供 Copyseeker 等需要会话 cookie 的引擎用。 */
function meHeadersFromRaw(head) {
  const out = {};
  if (typeof head !== 'string' || head === '') return out;
  for (const line of head.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim().toLowerCase();
    if (k === 'set-cookie') {
      const pair = line.slice(idx + 1).trim().split(';')[0];
      if (pair !== '') out[k] = out[k] !== undefined ? out[k] + '; ' + pair : pair;
    }
  }
  return out;
}
// ---- 地址判定：判定对象必须是网络栈真正会去连的那个字符串 ----
// 教训（验收复测 #13/#15/#20/#21 发现的 F1）：WHATWG URL 会把各种写法改写成规范形式——
//   0177.0.0.1（八进制）→ 127.0.0.1     0x7f.0.0.1（十六进制）→ 127.0.0.1
//   127.1（短写）→ 127.0.0.1            2130706433（整数）→ 127.0.0.1
//   [::ffff:127.0.0.1] → [::ffff:7f00:1]（十六进制组）
// 自己拿正则匹配「某一种写法」，等于给攻击者留一条「换个写法」的旁路：上一版只认 ::ffff:
// 后面的点分 IPv4，于是 [::ffff:7f00:1] / [::ffff:a00:1] / [::ffff:c0a8:101] / [::ffff:a9fe:a9fe]
// 全被判成公网。现在一律先过 URL 解析器归一，再按 8 组整数或 4 段整数判段。
/** 用 URL 解析器把地址字面量归一成 hostname（IPv6 保留方括号）；非法返回空串。 */
function canonicalHost(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (raw === '') return '';
  // hostname 里不可能有这些字符，出现说明调用方把整条 URL 或路径混进来了。
  if (/[/?#@\\\s]/.test(raw)) return '';
  const host = raw.includes(':') && !raw.startsWith('[') ? '[' + raw + ']' : raw;
  let parsed;
  try { parsed = new URL('http://' + host + '/'); } catch (error) { return ''; }
  return String(parsed.hostname);
}

/** canonicalHost 去掉 IPv6 的方括号，得到 net.isIP 认识的形态。 */
function bareHost(value) {
  return canonicalHost(value).replace(/^\[|\]$/g, '');
}

/** 解析 IPv6 文本成 8 组 16 位整数；非法返回 null。支持 :: 省略与 IPv4 尾巴。 */
function parseIpv6Groups(text) {
  const s = String(text).toLowerCase();
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part) => {
    if (part === '') return [];
    const out = [];
    for (const item of part.split(':')) {
      if (item === '') return null;
      if (item.includes('.')) {
        const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(item);
        if (m === null) return null;
        const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
        if (o.some((x) => x > 255)) return null;
        out.push((o[0] << 8) | o[1]);
        out.push((o[2] << 8) | o[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(item)) return null;
      out.push(parseInt(item, 16));
    }
    return out;
  };
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return head.concat(new Array(fill).fill(0), tail);
}

function isNonPublicV4(a, b) {
  if (a < 1 || a > 223) return true;                          // 0.x / 224+ 保留与组播
  if (a === 10) return true;                                  // 10/8
  if (a === 127) return true;                                 // 回环
  if (a === 169 && b === 254) return true;                    // 链路本地（云元数据）
  if (a === 172 && b >= 16 && b <= 31) return true;           // 172.16/12
  if (a === 192 && b === 168) return true;                    // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true;          // 100.64/10 CGN
  return false;
}

/** 地址字面量是否不能出站。非字面量（域名/垃圾）一律 true——本函数只认字面量，域名走 resolvePublicAddresses。 */
function isNonPublicIp(ip) {
  if (typeof ip !== 'string' || ip === '') return true;
  const host = bareHost(ip);
  if (host === '') return true;
  const kind = isIP(host);
  if (kind === 4) {
    const o = host.split('.').map((part) => Number(part));
    return isNonPublicV4(o[0], o[1]);
  }
  if (kind !== 6) return true;
  const g = parseIpv6Groups(host);
  if (g === null) return true;
  if (g.every((x) => x === 0)) return true;                   // ::
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0 && g[6] === 0 && g[7] === 1) return true; // ::1
  if ((g[0] & 0xffc0) === 0xfe80) return true;                // fe80::/10
  if ((g[0] & 0xfe00) === 0xfc00) return true;                // fc00::/7
  if ((g[0] & 0xff00) === 0xff00) return true;                // ff00::/8
  // 6to4（2002::/16）与 Teredo（2001::/32）把 IPv4 编进了地址本身：
  // 2002:7f00:1:: 就是 127.0.0.1，2001:0:80ff:fffe:: 是 127.0.0.2（取反存储）。
  // 不拆开判，等于给内网留了一条 IPv6 后门。
  if (g[0] === 0x2002) return isNonPublicV4((g[1] >>> 8) & 0xff, g[1] & 0xff);
  if (g[0] === 0x2001 && g[1] === 0) {
    const teredo = ~g[2] & 0xffff;
    return isNonPublicV4((teredo >>> 8) & 0xff, teredo & 0xff);
  }
  // 内嵌 IPv4 的四种形态：映射 ::ffff:0:0/96、转换 ::ffff:0:0:0/96、兼容 ::/96、NAT64 64:ff9b::/96。
  // 必须按 16 位组取低 32 位，不能只看点分写法（URL 会把 [::ffff:127.0.0.1] 写成 [::ffff:7f00:1]）。
  const embed = ((g[6] << 16) | g[7]) >>> 0;
  const v4 = [((embed >>> 24) & 0xff), ((embed >>> 16) & 0xff), ((embed >>> 8) & 0xff), (embed & 0xff)];
  const mapped = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff;
  const translated = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0xffff && g[5] === 0;
  const compatible = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0;
  const nat64 = g[0] === 0x64 && g[1] === 0xff9b;
  if (mapped || translated || compatible || nat64) return isNonPublicV4(v4[0], v4[1]);
  return false;
}

/**
 * 解析目标主机并返回「已校验的公网地址列表」。
 * 一个域名可能有多条 A/AAAA：只要有一条落在内网就拒绝（防「公网 + 内网」双记录绕过）。
 * 返回值直接喂给 pinnedLookup，让连接只可能发生在这几个地址上（防解析后重绑定 DNS rebinding）。
 */
async function resolvePublicAddresses(hostname) {
  const host = bareHost(hostname);
  if (host === '') throw new Error('目标主机为空，已拒绝');
  const kind = isIP(host);
  if (kind !== 0) {
    if (isNonPublicIp(host)) throw new Error('目标 ' + host + ' 是非公网地址，已拒绝');
    return [{ address: host, family: kind }];
  }
  // 测试注入点（见 __setNetworkHooks）：解析结果照样要过 isNonPublicIp，**不能**用注入放宽判定。
  const list = networkHooks !== null && typeof networkHooks.lookup === 'function'
    ? await networkHooks.lookup(host)
    : await dnsLookup(host, { all: true, verbatim: true });
  const addresses = Array.isArray(list) ? list : [];
  if (addresses.length === 0) throw new Error('目标 ' + host + ' 解析不到地址，已拒绝');
  for (const item of addresses) {
    if (isNonPublicIp(item.address)) throw new Error('目标 ' + host + ' 解析到非公网 IP：' + item.address);
  }
  return addresses.map((item) => ({ address: item.address, family: isIP(item.address) || 4 }));
}

async function assertPublicHost(hostname) {
  await resolvePublicAddresses(hostname);
}

// 测试注入点。publicFetch 用 node:http(s) 直连（要拿 lookup 钩子做地址钉死），
// 于是测试里「把 fetch 换成桩」这套办法对它无效；离线环境又不可能真去连 example.com。
// 这里只允许测试替换「解析」与「单次请求」两个动作，判定逻辑（canonicalHost / isNonPublicIp）不可绕过：
// 注入的解析结果仍然逐个过 isNonPublicIp，注入的请求只在测试里替代真正的网络调用。
let networkHooks = null;
function __setNetworkHooks(hooks) {
  networkHooks = hooks === null || hooks === undefined ? null : hooks;
  return networkHooks;
}

/**
 * 把连接用的 DNS 结果钉死在校验过的那几个地址上。
 * 只校验不钉死等于留了个 TOCTOU：第一次解析给公网、第二次解析给 127.0.0.1。
 */
function pinnedLookup(addresses) {
  const pool = Array.isArray(addresses) ? addresses : [];
  let cursor = 0;
  return function lookup(hostname, options, callback) {
    const wantAll = options !== null && typeof options === 'object' && options.all === true;
    const family = options !== null && typeof options === 'object' && Number(options.family) > 0 ? Number(options.family) : 0;
    const match = family === 0 ? pool : pool.filter((item) => item.family === family);
    const usable = match.length > 0 ? match : pool;
    if (usable.length === 0) {
      callback(Object.assign(new Error('没有可用的已校验地址：' + hostname), { code: 'ENOTFOUND' }), wantAll ? [] : '', 0);
      return;
    }
    if (wantAll === true) {
      callback(null, usable.map((item) => ({ address: item.address, family: item.family })));
      return;
    }
    const picked = usable[cursor % usable.length];
    cursor += 1;
    callback(null, picked.address, picked.family);
  };
}

// 抓取一个 http(s) 网页原文：proxy 非空时经 webSearch.proxy 的 CONNECT 隧道（https 目标包 TLS），
// 否则直连。抓取前先校验目标为公网 IP；只返回文本体，二进制/非文本由调用方按 content-type 判断。
const MAX_FETCH_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECT_HOPS = 5;

/** 单跳请求：lookup 钉死已校验地址、响应体边读边截、超时覆盖到读完。 */
function requestOnce(parsed, addresses, options, maxBytes, binary, deadline, started) {
  const left = deadline - (Date.now() - started);
  if (left <= 0) return Promise.reject(new Error('抓取超时（' + deadline + 'ms）'));
  const secure = parsed.protocol === 'https:';
  const hostBare = parsed.hostname.replace(/^\[|\]$/g, '');
  const headers = Object.assign({ 'accept-encoding': 'identity' }, options.headers === undefined || options.headers === null ? {} : options.headers);
  const payload = options.body === undefined || options.body === null
    ? null
    : (Buffer.isBuffer(options.body) ? options.body : Buffer.from(String(options.body)));
  if (payload !== null) headers['content-length'] = String(payload.length);
  const limit = Math.max(1024, Math.floor(Number(maxBytes) || MAX_FETCH_BYTES));
  if (networkHooks !== null && typeof networkHooks.request === 'function') {
    return Promise.resolve(networkHooks.request({ parsed, addresses, options, headers, payload, maxBytes: limit, binary, deadline, started, left }));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    // 绝对 deadline：requestOptions.timeout 是「socket 空闲」超时，对端每 10 秒滴一个字节
    // 就能一直不触发；慢速滴灌必须被总时长按住，否则一个访客就能长期占用连接。
    let hardTimer = null;
    const done = (fn, value) => {
      if (settled === true) return;
      settled = true;
      if (hardTimer !== null) { clearTimeout(hardTimer); hardTimer = null; }
      fn(value);
    };
    let reqRef = null;
    hardTimer = setTimeout(() => {
      const why = '抓取超时（' + deadline + 'ms）';
      try { if (reqRef !== null) reqRef.destroy(new Error(why)); } catch { /* 已结束 */ }
      done(reject, new Error(why));
    }, left);
    if (typeof hardTimer.unref === 'function') hardTimer.unref();
    const requestOptions = {
      protocol: parsed.protocol,
      hostname: hostBare,
      port: parsed.port === '' ? (secure ? 443 : 80) : Number(parsed.port),
      path: parsed.pathname + parsed.search,
      method: options.method === undefined || options.method === null ? 'GET' : options.method,
      headers,
      lookup: pinnedLookup(addresses),
      timeout: left,
    };
    // 只有域名才设 SNI：给 IP 设 servername 会触发 Node 告警，证书校验也用不上。
    if (secure === true && isIP(hostBare) === 0) requestOptions.servername = hostBare;
    const req = (secure === true ? httpsRequest : httpRequest)(requestOptions);
    reqRef = req;
    req.on('timeout', () => req.destroy(new Error('抓取超时（' + deadline + 'ms）')));
    req.on('error', (error) => done(reject, error));
    req.on('response', (res) => {
      const status = Number(res.statusCode === undefined || res.statusCode === null ? 0 : res.statusCode);
      const location = typeof res.headers.location === 'string' ? res.headers.location : '';
      const rawCookie = res.headers['set-cookie'];
      const setCookie = Array.isArray(rawCookie)
        ? rawCookie.map((item) => String(item).split(';')[0].trim()).filter((item) => item.includes('=')).join('; ')
        : '';
      const contentType = typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : '';
      const parts = [];
      let total = 0;
      let truncated = false;
      const finish = () => {
        const joined = Buffer.concat(parts, total);
        done(resolve, { status, location, setCookie, contentType, body: binary === true ? joined : joined.toString('utf8'), truncated });
      };
      if (status >= 300 && status < 400) { res.resume(); finish(); return; }
      res.on('data', (chunk) => {
        if (total >= limit) return;
        const buf = Buffer.from(chunk);
        if (total + buf.length > limit) {
          parts.push(buf.subarray(0, limit - total));
          total = limit;
          truncated = true;
          res.destroy();
          return;
        }
        parts.push(buf);
        total += buf.length;
      });
      res.on('end', finish);
      res.on('close', finish);
      res.on('error', (error) => done(reject, error));
    });
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/**
 * 只允许公网的抓取：逐跳解析并钉住地址、响应体带上限、显式 identity（防 SSRF / rebinding / 压缩炸弹）。
 * 返回 { status, body, finalUrl, truncated, setCookie, contentType }。
 */
async function publicFetch(url, options = {}) {
  const binary = options.binary === true;
  const maxBytes = Math.max(1024, Math.floor(Number(options.maxBytes) || MAX_FETCH_BYTES));
  const deadline = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 15000;
  const started = Date.now();
  let current = String(url === undefined || url === null ? '' : url);
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    let parsed;
    try { parsed = new URL(current); } catch (error) { throw new Error('抓取地址无效：' + current); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('抓取仅支持 http:// 或 https://（得到 ' + parsed.protocol + '）');
    }
    const addresses = await resolvePublicAddresses(parsed.hostname);
    const res = await requestOnce(parsed, addresses, options, maxBytes, binary, deadline, started);
    if (res.status >= 300 && res.status < 400) {
      if (res.location === '') {
        return { status: res.status, body: binary ? Buffer.alloc(0) : '', finalUrl: parsed.href, truncated: false, setCookie: '', contentType: '' };
      }
      current = new URL(res.location, parsed.href).href;
      continue;
    }
    // 归一：binary 给 Buffer，否则给字符串。测试钩子（__setNetworkHooks）经常直接塞 Buffer，
    // 不归一的话同一个函数在两条路径上返回不同类型，调用方得两套判断。
    const rawBody = res.body === undefined || res.body === null ? Buffer.alloc(0) : res.body;
    const asBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
    return {
      status: res.status,
      body: binary ? asBuffer : asBuffer.toString('utf8'),
      finalUrl: parsed.href,
      truncated: res.truncated === true,
      setCookie: res.setCookie,
      contentType: res.contentType,
    };
  }
  throw new Error('抓取跳转次数过多（>' + MAX_REDIRECT_HOPS + '）');
}

// ---- 代理隧道（CONNECT）统一实现 ----
// 以前三段调用方各写一遍，于是漂移成三种语义：fetchUrlViaProxy 有 timer 没体积上限、
// webSearchPost 两者都没有（注释还写着「代理分支自己带定时器」）、multiEngineRequest 有 timer 没上限。
// 三处还都是「校验主机名 → 把主机名原样交给代理再解析」：校验对象和执行对象不是同一个字符串，
// TTL=0 的域名先答公网让我方校验通过、代理再解析成内网，SSRF 防护就被绕开了。
// 现在收成一处：
//   1) 目标主机先解析成公网地址，CONNECT 直接用 IP:port（TLS 的 SNI 仍用原主机名，证书校验不受影响）；
//   2) 建连与读体共用一个 deadline（对端不吐字节也不会让回合永远挂着）；
//   3) 响应体边读边截，超限只截断并标记 truncated（与直连路径 requestOnce 同语义）。
function dechunkBuffer(buf) {
  const parts = [];
  let pos = 0;
  while (pos < buf.length) {
    const lineEnd = buf.indexOf('\r\n', pos);
    if (lineEnd < 0) break;
    // 只认正数：'-24' 会被 parseInt 解成 -24，end 落在 pos 之前，pos 往回退之后同一段
    // 被反复解析——同步死循环，一条 11 字节的畸形响应就能把整个宿主卡住。
    const size = parseInt(buf.subarray(pos, lineEnd).toString('utf8').trim(), 16);
    if (!Number.isFinite(size) || size <= 0) break;
    const start = lineEnd + 2;
    const end = Math.min(start + size, buf.length);
    parts.push(buf.subarray(start, end));
    if (end >= buf.length) break;
    // 单调推进：任何异常大小都不允许让 pos 回退。
    const next = end + 2;
    if (next <= pos) break;
    pos = next;
  }
  return Buffer.concat(parts);
}

/** 从响应头文本里取单个头的值（location 等，meHeadersFromRaw 只收 set-cookie）。 */
function headerValueOf(head, name) {
  const want = String(name).toLowerCase() + ':';
  for (const line of String(head).split('\r\n')) {
    if (line.toLowerCase().startsWith(want) === true) return line.slice(want.length).trim();
  }
  return '';
}

function proxyRequest(options) {
  const opts = options === undefined || options === null ? {} : options;
  const label = typeof opts.label === 'string' ? opts.label : '抓取';
  const method = typeof opts.method === 'string' && opts.method !== '' ? opts.method : 'GET';
  const headers = opts.headers !== undefined && opts.headers !== null ? opts.headers : {};
  const deadline = Number.isFinite(opts.deadline) && opts.deadline > 0 ? opts.deadline : ME_TIMEOUT_MS;
  const maxBytes = Math.max(1024, Math.floor(Number(opts.maxBytes) || MAX_FETCH_BYTES));
  let targetUrl;
  try { targetUrl = new URL(String(opts.url)); } catch (error) { return Promise.reject(new Error(label + '地址无效：' + String(opts.url))); }
  if (targetUrl.protocol !== 'https:' && targetUrl.protocol !== 'http:') {
    return Promise.reject(new Error(label + '仅支持 http:// 或 https://（得到 ' + targetUrl.protocol + '）'));
  }
  let proxyUrl;
  try { proxyUrl = new URL(String(opts.proxy)); } catch (error) { return Promise.reject(new Error('webSearch.proxy 无效：' + String(opts.proxy))); }
  if (proxyUrl.protocol !== 'http:' && proxyUrl.protocol !== 'https:') {
    return Promise.reject(new Error('webSearch.proxy 仅支持 http:// 或 https://（得到 ' + proxyUrl.protocol + '）'));
  }
  const payload = opts.body === undefined || opts.body === null
    ? null
    : (Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(String(opts.body)));
  const targetPort = targetUrl.port !== '' ? targetUrl.port : (targetUrl.protocol === 'https:' ? '443' : '80');
  const proxyPort = proxyUrl.port !== '' ? proxyUrl.port : (proxyUrl.protocol === 'https:' ? 443 : 80);
  return resolvePublicAddresses(targetUrl.hostname).then((addresses) => new Promise((resolve, reject) => {
    const pinned = String(addresses[0].address);
    const connectTarget = (pinned.includes(':') ? '[' + pinned + ']' : pinned) + ':' + targetPort;
    let settled = false;
    let timer = null;
    let socket = null;
    let connectReq = null;
    const finish = (fn, value) => {
      if (settled === true) return;
      settled = true;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (socket !== null) { try { socket.destroy(); } catch (error) { /* 已销毁 */ } }
      if (connectReq !== null) { try { connectReq.destroy(); } catch (error) { /* 已销毁 */ } }
      fn(value);
    };
    const proxyRequestFn = proxyUrl.protocol === 'https:' ? httpsRequest : httpRequest;
    connectReq = proxyRequestFn({
      host: proxyUrl.hostname,
      port: Number(proxyPort),
      method: 'CONNECT',
      path: connectTarget,
      headers: { Host: connectTarget, 'Proxy-Connection': 'keep-alive' },
    });
    timer = setTimeout(() => finish(reject, new Error(label + '超时（' + deadline + 'ms）')), deadline);
    connectReq.on('error', (error) => finish(reject, error));
    connectReq.on('connect', (res, sock) => {
      socket = sock;
      if (res.statusCode !== 200) { finish(reject, new Error('代理 CONNECT 失败：HTTP ' + res.statusCode)); return; }
      const send = (stream) => {
        stream.on('error', (error) => finish(reject, error));
        const lines = [method + ' ' + targetUrl.pathname + targetUrl.search + ' HTTP/1.1', 'Host: ' + targetUrl.host];
        for (const pair of Object.entries(headers)) {
          // 手拼报文时，头名/头值里只要有一个 CR/LF 就能凭空多插一条头（甚至插进请求体区）。
          // 直连走 node:http 有内建校验，隧道这条路径必须自己挡。
          const name = String(pair[0]);
          const value = String(pair[1]);
          if (/[\r\n]/u.test(name) === true || /[\r\n]/u.test(value) === true) {
            finish(reject, new Error(label + '请求头含换行，已拒绝'));
            return;
          }
          lines.push(name + ': ' + value);
        }
        lines.push('accept-encoding: identity', 'connection: close');
        if (payload !== null) lines.push('content-length: ' + String(payload.length));
        stream.write(lines.join('\r\n') + '\r\n\r\n');
        if (payload !== null) stream.write(payload);
        const chunks = [];
        let received = 0;      // 已并入 chunks 的字节数（含响应头）
        let bodyTotal = 0;     // 其中属于 body 的字节数
        let headDone = false;  // 响应头是否已经完整落在 chunks 里
        let truncated = false;
        stream.on('data', (chunk) => {
          if (settled === true || truncated === true) return;
          const buf = Buffer.from(chunk);
          if (headDone !== true) {
            // 头部还没读完就先全收（上限只管 body）；读到头后把已收字节里属于头的部分扣掉。
            chunks.push(buf);
            received += buf.length;
            // 响应头也有上限：正常的头不会超过几十 KB。以前这里是「读到空行为止无上限」，
            // 而且每块都 Buffer.concat 整个缓冲（O(n²)），0.5MB 的头能让进程多占几十 MB。
            if (received > 64 * 1024) { finish(reject, new Error(label + '响应头过大（超过 64KB）')); return; }
            const joined = Buffer.concat(chunks);
            const sepIdx = joined.indexOf('\r\n\r\n');
            if (sepIdx >= 0) {
              headDone = true;
              bodyTotal = joined.length - (sepIdx + 4);
            }
            if (bodyTotal > maxBytes) {
              truncated = true;
              stream.destroy();
            }
            return;
          }
          if (bodyTotal + buf.length > maxBytes) {
            chunks.push(buf.subarray(0, maxBytes - bodyTotal));
            bodyTotal = maxBytes;
            truncated = true;
            stream.destroy();
            return;
          }
          chunks.push(buf);
          bodyTotal += buf.length;
        });
        const emit = () => {
          const rawBuf = Buffer.concat(chunks);
          const sepIdx = rawBuf.indexOf('\r\n\r\n');
          if (sepIdx < 0) { finish(reject, new Error(label + '响应无效（无 HTTP 状态）')); return; }
          const head = rawBuf.subarray(0, sepIdx).toString('utf8');
          const statusMatch = /^HTTP\/1\.[01] (\d{3})/.exec(head);
          if (statusMatch === null) { finish(reject, new Error(label + '响应无效（无 HTTP 状态）')); return; }
          let bodyBuf = rawBuf.subarray(sepIdx + 4);
          if (truncated === true && bodyBuf.length > maxBytes) bodyBuf = bodyBuf.subarray(0, maxBytes);
          if (/transfer-encoding:\s*chunked/i.test(head)) bodyBuf = dechunkBuffer(bodyBuf);
          finish(resolve, {
            status: Number(statusMatch[1]),
            location: headerValueOf(head, 'location'),
            headers: meHeadersFromRaw(head),
            body: bodyBuf,
            truncated,
            finalUrl: targetUrl.href,
          });
        };
        stream.on('close', emit);
      };
      if (targetUrl.protocol === 'https:') send(tlsConnect({ socket: sock, servername: targetUrl.hostname }));
      else send(sock);
    });
    connectReq.end();
  }));
}

function fetchUrlViaProxy(url, proxy, timeoutMs) {
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000;
  const started = Date.now();
  const direct = proxy === undefined || proxy === null || proxy === '';
  if (direct === true) {
    // 直连：publicFetch 自己逐跳校验跳转目标、带上限与 identity、超时覆盖到读完。
    return publicFetch(url, {
      timeoutMs: deadline,
      headers: { 'accept': 'text/html,text/plain,application/json,*/*', 'user-agent': 'dsh-qq-bot/0.6.4' },
    }).then((res) => ({ status: res.status, text: res.body, finalUrl: res.finalUrl, truncated: res.truncated }));
  }
  // 代理：逐跳自己跟（proxyRequest 只做一跳），每一跳都重新校验并钉地址，预算共用一个 deadline。
  const hop = (current, hops) => {
    if (hops > MAX_REDIRECT_HOPS) return Promise.reject(new Error('抓取跳转次数过多（>' + MAX_REDIRECT_HOPS + '）'));
    const left = deadline - (Date.now() - started);
    if (left <= 0) return Promise.reject(new Error('抓取超时（' + deadline + 'ms）'));
    return proxyRequest({
      url: current,
      proxy,
      method: 'GET',
      headers: { 'accept': 'text/html,text/plain,application/json,*/*', 'user-agent': 'dsh-qq-bot/0.6.4' },
      deadline: left,
      label: '抓取',
    }).then((res) => {
      if (res.status >= 300 && res.status < 400 && res.location !== '') {
        let next = '';
        try { next = new URL(res.location, current).href; } catch (error) { next = ''; }
        if (next !== '') return hop(next, hops + 1);
      }
      return { status: res.status, text: res.body.toString('utf8'), finalUrl: current, truncated: res.truncated === true };
    });
  };
  return hop(url, 0);
}
// 带可选代理的 POST：proxy 为空 → publicFetch 直连；非空 → 手动 CONNECT 隧道 + TLS over socket。
function webSearchPost(endpoint, headers, body, proxy) {
  if (proxy === undefined || proxy === null || proxy === '') {
    // 直连也要有超时：端点挂起时 otherwise 会把整条会话队列拖死。
    // 走 publicFetch：端点同样过公网校验 + 8 MB 上限 + 显式 identity（以前直接 fetch + resp.json()
    // 会把对端塞来的 gzip 炸弹整包解压进内存，对端挂起时也没有读体超时）。
    return publicFetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), timeoutMs: 60000 })
      .then((res) => {
        let parsed = null;
        try { parsed = JSON.parse(String(res.body)); } catch (error) { /* 保留 null */ }
        return { status: res.status, parsed };
      });
  }
  // 代理分支以前完全没有超时（注释还写着「代理分支自己带定时器」）：端点不吐字节，这个 Promise
  // 就永不 settle，而 runWebSearch 是在回合里被 await 的，整条会话队列跟着堵死。
  // 现在与直连同语义：公网校验 + 上限 + 超时，全在 proxyRequest 里。
  return proxyRequest({
    url: endpoint,
    proxy,
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    deadline: 60000,
    label: '搜索请求',
  }).then((res) => {
    let parsed = null;
    try { parsed = JSON.parse(res.body.toString('utf8')); } catch (error) { /* 保留 null */ }
    return { status: res.status, parsed };
  });
}
const ME_TIMEOUT_MS = 15000;
const ME_BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
function multiEngineRequest(method, url, headers, body, proxy, timeoutMs, binary) {
  const wantBinary = binary === true;
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : ME_TIMEOUT_MS;
  let targetUrl;
  try { targetUrl = new URL(url); } catch (error) { return Promise.reject(new Error('搜索地址无效：' + url)); }
  if (targetUrl.protocol !== 'https:' && targetUrl.protocol !== 'http:') {
    return Promise.reject(new Error('仅支持 http(s) 搜索地址（得到 ' + targetUrl.protocol + '）'));
  }
  if (proxy === undefined || proxy === null || proxy === '') {
    // 直连与代理必须同一道公网校验：以前只有代理分支校验，直连分支可被拿来打内网。
    return assertPublicHost(targetUrl.hostname)
      .then(() => publicFetch(url, { method, headers, body, timeoutMs: deadline, binary: wantBinary }))
      .then((res) => {
        const out = {};
        if (typeof res.setCookie === 'string' && res.setCookie !== '') out['set-cookie'] = res.setCookie;
        return { status: res.status, body: res.body, headers: out };
      });
  }
  // 代理路径也走 proxyRequest：公网校验（解析即钉死）、同一套超时与体积上限。
  return proxyRequest({
    url,
    proxy,
    method,
    headers,
    body,
    deadline,
    maxBytes: MAX_FETCH_BYTES,
    label: '搜索请求',
  }).then((res) => {
    const out = {};
    if (typeof res.headers['set-cookie'] === 'string' && res.headers['set-cookie'] !== '') out['set-cookie'] = res.headers['set-cookie'];
    return { status: res.status, body: wantBinary ? res.body : res.body.toString('utf8'), headers: out };
  });
}

// ---- HTML 实体解码与文本清理（Yandex 命中词是 <b> 逐字包住中文，剥标签必须用空串） ----
function meDecodeEntities(text) {
  return text
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x27;|&#39;/g, "'").replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ').replace(/&ensp;/g, ' ').replace(/&emsp;/g, ' ')
    .replace(/&#0*39;/g, "'").replace(/&#0*183;/g, '·')
    .replace(/&#0*8212;/g, '—').replace(/&#0*8230;/g, '…')
    .replace(/&hellip;/g, '…').replace(/&mdash;/g, '—').replace(/&middot;/g, '·')
    .replace(/&#x201[0-9a-f];/gi, ' ');
}
function meCleanText(text) {
  return meDecodeEntities(String(text).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim());
}
function meStripCdata(text) {
  return String(text).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

// —— 模块导出（http 传输层，供 websearch.js / imgsearch.js 使用）
export { proxyRequest, multiEngineRequest, extractHttpBody, meHeadersFromRaw, isNonPublicIp, canonicalHost, resolvePublicAddresses, pinnedLookup, __setNetworkHooks, assertPublicHost, publicFetch, MAX_FETCH_BYTES, fetchUrlViaProxy, webSearchPost, meDecodeEntities, meCleanText, meStripCdata, ME_BROWSER_UA, ME_TIMEOUT_MS };
