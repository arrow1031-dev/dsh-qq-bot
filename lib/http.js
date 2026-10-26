// 通用 HTTP 传输层（multiEngineRequest / 代理 CONNECT 隧道 / 文本工具）。
// 被 websearch.js 与 imgsearch.js 共用 —— 两个搜索模块都受本模块的 http 代理管控。
import { request as httpRequest } from 'node:http';
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
// 目标必须是公网 IP：防止经 webSearch.proxy 把抓取转发到内网/回环地址（复用 DSH 全局 web_fetch 的同类防线）。
function isNonPublicIp(ip) {
  if (typeof ip !== 'string' || ip === '') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a < 1 || a > 223) return true;                          // 0.x / 224+ 保留与组播
    if (a === 10) return true;                                  // 10/8
    if (a === 127) return true;                                 // 回环
    if (a === 169 && b === 254) return true;                    // 链路本地
    if (a === 172 && b >= 16 && b <= 31) return true;           // 172.16/12
    if (a === 192 && b === 168) return true;                    // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true;          // 100.64/10 CGN
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;           // 回环 / 未指定
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;          // fc00::/7
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // fe80::/10
  if (lower.startsWith('::ffff:')) return isNonPublicIp(lower.slice(7));      // IPv4 映射
  return false;
}
async function assertPublicHost(hostname) {
  const host = String(hostname === undefined || hostname === null ? '' : hostname).replace(/^\[|\]$/g, '');
  if (host === '') throw new Error('目标主机为空，已拒绝');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) {
    if (isNonPublicIp(host)) throw new Error('目标 ' + host + ' 是非公网地址，已拒绝');
    return;
  }
  // 一个域名可能有多条 A/AAAA：只要有一条落在内网就拒绝（防「公网 + 内网」双记录绕过）。
  const list = await dnsLookup(host, { all: true, verbatim: true });
  const addresses = Array.isArray(list) ? list : [];
  if (addresses.length === 0) throw new Error('目标 ' + host + ' 解析不到地址，已拒绝');
  for (const item of addresses) {
    if (isNonPublicIp(item.address)) throw new Error('目标 ' + host + ' 解析到非公网 IP：' + item.address);
  }
}
// 抓取一个 http(s) 网页原文：proxy 非空时经 webSearch.proxy 的 CONNECT 隧道（https 目标包 TLS），
// 否则直连。抓取前先校验目标为公网 IP；只返回文本体，二进制/非文本由调用方按 content-type 判断。
const MAX_FETCH_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECT_HOPS = 5;

/** 从响应流里读 body，最多 maxBytes（超限截断并标记，不读进内存再截）。 */
async function readCappedBody(resp, maxBytes, binary) {
  const limit = Math.max(1024, Math.floor(Number(maxBytes) || MAX_FETCH_BYTES));
  const body = resp.body;
  if (body === null || body === undefined || typeof body.getReader !== 'function') {
    const buf = Buffer.from(await resp.arrayBuffer());
    const cut = buf.subarray(0, limit);
    return { body: binary ? cut : cut.toString('utf8'), truncated: buf.length > limit };
  }
  const reader = body.getReader();
  const parts = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done === true) break;
    const value = chunk.value;
    if (value === undefined || value === null) continue;
    const buf = Buffer.from(value);
    if (total + buf.length > limit) {
      parts.push(buf.subarray(0, limit - total));
      total = limit;
      truncated = true;
      try { await reader.cancel(); } catch (error) { /* 忽略 */ }
      break;
    }
    parts.push(buf);
    total += buf.length;
  }
  const joined = Buffer.concat(parts, total);
  return { body: binary ? joined : joined.toString('utf8'), truncated };
}

/**
 * 只允许公网的抓取：逐跳校验跳转、响应体带上限、显式 identity（防 SSRF 与压缩炸弹）。
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
    await assertPublicHost(parsed.hostname);
    const left = deadline - (Date.now() - started);
    if (left <= 0) throw new Error('抓取超时（' + deadline + 'ms）');
    const headers = Object.assign({ 'accept-encoding': 'identity' }, options.headers === undefined || options.headers === null ? {} : options.headers);
    const init = { method: options.method === undefined || options.method === null ? 'GET' : options.method, headers, redirect: 'manual', signal: AbortSignal.timeout(Math.max(1000, left)) };
    if (options.body !== undefined && options.body !== null) init.body = options.body;
    const resp = await fetch(parsed.href, init);
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location');
      if (typeof location !== 'string' || location === '') {
        return { status: resp.status, body: binary ? Buffer.alloc(0) : '', finalUrl: parsed.href, truncated: false, setCookie: '', contentType: '' };
      }
      current = new URL(location, parsed.href).href;
      continue;
    }
    const read = await readCappedBody(resp, maxBytes, binary);
    const sc = resp.headers.get('set-cookie');
    const ct = resp.headers.get('content-type');
    return {
      status: resp.status, body: read.body, finalUrl: parsed.href, truncated: read.truncated,
      setCookie: typeof sc === 'string' ? sc.split(';').map((s) => s.trim()).filter((s) => s.includes('=')).join('; ') : '',
      contentType: typeof ct === 'string' ? ct : '',
    };
  }
  throw new Error('抓取跳转次数过多（>' + MAX_REDIRECT_HOPS + '）');
}
function fetchUrlViaProxy(url, proxy, timeoutMs) {
  let targetUrl;
  try { targetUrl = new URL(url); } catch (error) { return Promise.reject(new Error('抓取地址无效：' + url)); }
  if (targetUrl.protocol !== 'https:' && targetUrl.protocol !== 'http:') {
    return Promise.reject(new Error('抓取仅支持 http:// 或 https://（得到 ' + targetUrl.protocol + '）'));
  }
  const targetPort = targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80);
  const connectTarget = targetUrl.hostname + ':' + targetPort;
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000;
  // 先校验公网，再决定走代理还是直连
  return assertPublicHost(targetUrl.hostname).then(() => {
    if (proxy === undefined || proxy === null || proxy === '') {
      // 用 AbortSignal.timeout：超时覆盖「建立连接 + 读 body」全程。
      // 以前是手搓 timer 且在读 body 之前就 clearTimeout，对端慢速灌体时能永久挂住，
      // 而回合的 whenIdle 没有超时——整条会话队列会跟着堵死。
      // 走 publicFetch：逐跳校验跳转目标、响应体带上限（以前 redirect:'follow' 一跳就能打到内网）。
      return publicFetch(url, { timeoutMs: deadline, headers: { 'accept': 'text/html,text/plain,application/json,*/*', 'user-agent': 'dsh-qq-bot/0.6.4' } })
        .then((res) => ({ status: res.status, text: res.body, finalUrl: res.finalUrl, truncated: res.truncated }));
    }
    return new Promise((resolve, reject) => {
      let proxyUrl;
      try { proxyUrl = new URL(proxy); } catch (error) { reject(new Error('webSearch.proxy 无效：' + proxy)); return; }
      if (proxyUrl.protocol !== 'http:' && proxyUrl.protocol !== 'https:') {
        reject(new Error('webSearch.proxy 仅支持 http:// 或 https://（得到 ' + proxyUrl.protocol + '）')); return;
      }
      let timer = null;
      let socket = null;
      const connectReq = httpRequest({
        host: proxyUrl.hostname,
        port: proxyUrl.port || (proxyUrl.protocol === 'https:' ? 443 : 80),
        method: 'CONNECT',
        path: connectTarget,
        headers: { Host: connectTarget, 'Proxy-Connection': 'keep-alive' },
      });
      const cleanup = () => { if (timer !== null) { clearTimeout(timer); timer = null; } if (socket !== null) { try { socket.destroy(); } catch (e) { /* 已销毁 */ } } };
      connectReq.on('error', (error) => { cleanup(); reject(error); });
      connectReq.on('connect', (res, sock) => {
        socket = sock;
        if (res.statusCode !== 200) { cleanup(); reject(new Error('代理 CONNECT 失败：HTTP ' + res.statusCode)); return; }
        timer = setTimeout(() => { cleanup(); reject(new Error('抓取超时（' + deadline + 'ms）')); }, deadline);
        const doSend = (stream) => {
          stream.on('error', (error) => { cleanup(); reject(error); });
          stream.write('GET ' + targetUrl.pathname + targetUrl.search + ' HTTP/1.1\r\n'
            + 'Host: ' + targetUrl.host + '\r\n'
            + 'accept: text/html,text/plain,application/json,*/*\r\n'
            + 'accept-encoding: identity\r\n'
            + 'user-agent: dsh-qq-bot/0.6.4\r\n'
            + 'connection: close\r\n\r\n');
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => {
            cleanup();
            const raw = Buffer.concat(chunks).toString('utf8');
            const { status, body } = extractHttpBody(raw);
            if (status === 0) { reject(new Error('抓取响应无效（无 HTTP 状态）')); return; }
            resolve({ status, text: body, finalUrl: url });
          });
        };
        if (targetUrl.protocol === 'https:') {
          const tlsSock = tlsConnect({ socket: sock, servername: targetUrl.hostname });
          doSend(tlsSock);
        } else doSend(sock);
      });
      connectReq.end();
    });
  });
}
// 带可选代理的 POST：proxy 为空 → fetch 直连；非空 → 手动 CONNECT 隧道 + TLS over socket。
function webSearchPost(endpoint, headers, body, proxy) {
  if (proxy === undefined || proxy === null || proxy === '') {
    // 直连也要有超时：端点挂起时 otherwise 会把整条会话队列拖死（proxy 分支自己带定时器）。
    return fetch(endpoint, { method: 'POST', redirect: 'error', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) })
      .then(async (resp) => {
        let parsed = null;
        try { parsed = await resp.json(); } catch { /* 保留 null */ }
        return { status: resp.status, parsed };
      });
  }
  return new Promise((resolve, reject) => {
    let proxyUrl;
    try { proxyUrl = new URL(proxy); } catch (error) { reject(new Error('webSearch.proxy 无效：' + proxy)); return; }
    if (proxyUrl.protocol !== 'http:' && proxyUrl.protocol !== 'https:') {
      reject(new Error('webSearch.proxy 仅支持 http:// 或 https://（得到 ' + proxyUrl.protocol + '）')); return;
    }
    let targetUrl;
    try { targetUrl = new URL(endpoint); } catch (error) { reject(new Error('搜索端点无效：' + endpoint)); return; }
    if (targetUrl.protocol !== 'https:') {
      reject(new Error('搜索端点必须是 https（代理隧道仅支持 https 目标）')); return;
    }
    const targetPort = targetUrl.port || 443;
    const connectTarget = targetUrl.hostname + ':' + targetPort;
    const connectReq = httpRequest({
      host: proxyUrl.hostname,
      port: proxyUrl.port || (proxyUrl.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: connectTarget,
      headers: { Host: connectTarget, 'Proxy-Connection': 'keep-alive' },
    });
    connectReq.on('error', reject);
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); reject(new Error('代理 CONNECT 失败：HTTP ' + res.statusCode)); return; }
      const tlsSocket = tlsConnect({ socket, servername: targetUrl.hostname });
      tlsSocket.on('error', reject);
      tlsSocket.on('secureConnect', () => {
        const raw = JSON.stringify(body);
        tlsSocket.write('POST ' + targetUrl.pathname + targetUrl.search + ' HTTP/1.1\r\n'
          + 'Host: ' + targetUrl.host + '\r\n'
          + Object.entries(headers).map(([k, v]) => k + ': ' + v).join('\r\n')
          + '\r\ncontent-length: ' + Buffer.byteLength(raw) + '\r\nconnection: close\r\n\r\n' + raw);
      });
      const chunks = [];
      tlsSocket.on('data', (chunk) => chunks.push(chunk));
      tlsSocket.on('end', () => {
        const rawResp = Buffer.concat(chunks).toString('utf8');
        const { status, body: bodyPart } = extractHttpBody(rawResp);
        let parsed = null;
        try { parsed = JSON.parse(bodyPart); } catch { /* 保留 null */ }
        resolve({ status, parsed });
      });
    });
    connectReq.end();
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
  // 代理路径：先校验目标公网（防经代理扫内网），再 CONNECT 隧道。
  return assertPublicHost(targetUrl.hostname).then(() => new Promise((resolve, reject) => {
    let proxyUrl;
    try { proxyUrl = new URL(proxy); } catch (error) { reject(new Error('webSearch.proxy 无效：' + proxy)); return; }
    if (proxyUrl.protocol !== 'http:' && proxyUrl.protocol !== 'https:') {
      reject(new Error('webSearch.proxy 仅支持 http:// 或 https://（得到 ' + proxyUrl.protocol + '）')); return;
    }
    const targetPort = targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80);
    const connectTarget = targetUrl.hostname + ':' + targetPort;
    let timer = null;
    let socket = null;
    const connectReq = httpRequest({
      host: proxyUrl.hostname,
      port: proxyUrl.port || (proxyUrl.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: connectTarget,
      headers: { Host: connectTarget, 'Proxy-Connection': 'keep-alive' },
    });
    const cleanup = () => { if (timer !== null) { clearTimeout(timer); timer = null; } if (socket !== null) { try { socket.destroy(); } catch (e) { /* 已销毁 */ } } };
    connectReq.on('error', (error) => { cleanup(); reject(error); });
    connectReq.on('connect', (res, sock) => {
      socket = sock;
      if (res.statusCode !== 200) { cleanup(); reject(new Error('代理 CONNECT 失败：HTTP ' + res.statusCode)); return; }
      timer = setTimeout(() => { cleanup(); reject(new Error('搜索请求超时（' + deadline + 'ms）')); }, deadline);
      const doSend = (stream) => {
        stream.on('error', (error) => { cleanup(); reject(error); });
        const headerLines = Object.entries(headers || {}).map(([k, v]) => k + ': ' + v);
        const head = method + ' ' + targetUrl.pathname + targetUrl.search + ' HTTP/1.1\r\n'
          + 'Host: ' + targetUrl.host + '\r\n' + headerLines.join('\r\n')
          + '\r\naccept-encoding: identity\r\nconnection: close\r\n';
        const payload = (body !== undefined && body !== null)
          ? (Buffer.isBuffer(body) || body instanceof ArrayBuffer ? Buffer.from(body) : Buffer.from(String(body)))
          : null;
        stream.write(head + 'content-length: ' + (payload === null ? 0 : payload.length) + '\r\n\r\n');
        if (payload !== null) stream.write(payload);
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => {
          cleanup();
          const rawBuf = Buffer.concat(chunks);
          const sepIdx = rawBuf.indexOf('\r\n\r\n');
          if (sepIdx < 0) { reject(new Error('搜索响应无效（无 HTTP 状态）')); return; }
          const headText = rawBuf.slice(0, sepIdx).toString('utf8');
          const statusMatch = /^HTTP\/1\.[01] (\d{3})/.exec(headText);
          if (statusMatch === null) { reject(new Error('搜索响应无效（无 HTTP 状态）')); return; }
          const bodyBuf = rawBuf.slice(sepIdx + 4);
          resolve({ status: Number(statusMatch[1]), body: wantBinary ? bodyBuf : bodyBuf.toString('utf8'), headers: meHeadersFromRaw(headText) });
        });
      };
      if (targetUrl.protocol === 'https:') {
        const tlsSock = tlsConnect({ socket: sock, servername: targetUrl.hostname });
        doSend(tlsSock);
      } else doSend(sock);
    });
    connectReq.end();
  }));
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
/** DuckDuckGo 跳转链接还原（//duckduckgo.com/l/?uddg=<encoded>）。 */

// —— 模块导出（http 传输层，供 websearch.js / imgsearch.js 使用）
export { multiEngineRequest, extractHttpBody, meHeadersFromRaw, isNonPublicIp, assertPublicHost, publicFetch, MAX_FETCH_BYTES, fetchUrlViaProxy, webSearchPost, meDecodeEntities, meCleanText, meStripCdata, ME_BROWSER_UA, ME_TIMEOUT_MS };
