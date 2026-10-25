/**
 * 协议适配器共用的 WebSocket 传输层（零依赖，手写 RFC 6455）。
 *
 * 之所以自己写：插件与适配器都以单文件脚本分发，不能引入 ws 依赖。
 * 本模块只负责「管道」——握手、帧编解码、断线重连、反向服务端、
 * 链路集合与状态广播；具体协议语义（消息/事件/动作）由各协议适配器实现。
 */
import http from 'node:http';
import { createHash } from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function acceptKey(key) {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

/** 服务端 -> 客户端的未掩码帧 */
export function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

export const encodeTextFrame = (text) => encodeFrame(0x1, Buffer.from(text, 'utf8'));

/** 解析缓冲区里所有完整帧（客户端帧必须掩码） */
export function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;
  let fragments = null;
  let fragmentOpcode = 0;
  for (;;) {
    if (buffer.length - offset < 2) break;
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (buffer.length - cursor < 2) break;
      length = buffer.readUInt16BE(cursor); cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break;
      length = Number(buffer.readBigUInt64BE(cursor)); cursor += 8;
    }
    let maskKey = null;
    if (masked) {
      if (buffer.length - cursor < 4) break;
      maskKey = buffer.subarray(cursor, cursor + 4); cursor += 4;
    }
    if (buffer.length - cursor < length) break;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (maskKey !== null) for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
    cursor += length;
    offset = cursor;
    if (opcode === 0x8) { messages.push({ type: 'close' }); continue; }
    if (opcode === 0x9) { messages.push({ type: 'ping', payload }); continue; }
    if (opcode === 0xa) continue;
    if (opcode === 0x0) {
      if (fragments !== null) fragments.push(payload);
      if (fin && fragments !== null) {
        messages.push({ type: fragmentOpcode === 0x1 ? 'text' : 'binary', payload: Buffer.concat(fragments) });
        fragments = null;
      }
      continue;
    }
    if (fin) messages.push({ type: opcode === 0x1 ? 'text' : 'binary', payload });
    else { fragments = [payload]; fragmentOpcode = opcode; }
  }
  return { messages, rest: buffer.subarray(offset) };
}

export const sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); if (t.unref) t.unref(); });

/**
 * 链路集合：正向/反向连接都归一成 { label, ready, send(text), close() }。
 * @param {object} options
 * @param {(info: object) => void} options.onStatus 连接数/原因变化时回调（适配器决定怎么上报）
 */
export function createLinkSet(options = {}) {
  const links = new Set();
  const onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {};
  return {
    links,
    size: () => links.size,
    active() {
      for (const link of links) if (link.ready) return link;
      return null;
    },
    add(link) { links.add(link); onStatus({ event: 'add', label: link.label, size: links.size }); },
    remove(link) {
      if (!links.delete(link)) return;
      onStatus({ event: 'remove', label: link.label, size: links.size });
    },
    closeAll() { for (const link of links) link.close(); links.clear(); },
  };
}

/**
 * 正向 WS 客户端：断线指数退避重连。
 * token 通过 ?access_token= 传入（WHATWG WebSocket 无法自定义请求头）。
 */
export function connectForward(options) {
  const {
    url, token = '', linkSet, onText,
    onOpen = () => {}, onClose = () => {}, onError = () => {},
    maxRetryMs = 30000,
  } = options;
  let retry = 1000;
  let shuttingDown = false;
  let link = null;

  function scheduleRetry() {
    if (shuttingDown) return;
    const delay = retry;
    retry = Math.min(retry * 2, maxRetryMs);
    onError({ phase: 'retry', delayMs: delay });
    const timer = setTimeout(() => { if (timer.unref) timer.unref(); connect(); }, delay);
    if (timer.unref) timer.unref();
  }

  function connect() {
    if (shuttingDown) return;
    const target = token === ''
      ? url
      : url + (url.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(token);
    let socket;
    try {
      socket = new WebSocket(target);
    } catch (error) {
      onError({ phase: 'create', error });
      scheduleRetry();
      return;
    }
    const current = {
      label: 'forward ' + url,
      ready: false,
      send(text) {
        if (socket.readyState !== 1) return false;
        try { socket.send(text); return true; } catch { return false; }
      },
      close() { try { socket.close(); } catch { /* ignore */ } },
    };
    link = current;
    linkSet.add(current);
    socket.addEventListener('open', () => {
      current.ready = true;
      retry = 1000;
      onOpen({ link: current });
    });
    socket.addEventListener('message', (event) => {
      onText(current, typeof event.data === 'string' ? event.data : String(event.data));
    });
    socket.addEventListener('error', (event) => onError({ phase: 'socket', event }));
    socket.addEventListener('close', (event) => {
      current.ready = false;
      if (link === current) link = null;
      linkSet.remove(current);
      onClose({ link: current, code: event && event.code !== undefined ? event.code : null });
      scheduleRetry();
    });
  }

  connect();
  return { close() { shuttingDown = true; if (link !== null) link.close(); }, reconnect: connect };
}

/**
 * 反向 WS 服务端：等对端连进来（OneBot 反向 / Satori server / Milky）。
 * @param {object} options
 * @param {string} options.listen 'host:port' 或 'port'
 * @param {string} [options.path] 只接受该路径（空 = 任意路径）
 * @param {(req: import('node:http').IncomingMessage, url: URL) => boolean} [options.authorize]
 * @param {(link, text) => void} options.onText
 * @param {(link) => void} [options.onReady] 握手完成回调（可在这里发 protocol hello）
 * @param {(info) => void} [options.onListening]
 * @param {(message: string) => void} [options.onError]
 */
export function startReverseServer(options) {
  const { listen, path = '', authorize, onText, onReady = () => {}, onListening = () => {}, onError = () => {} } = options;
  const [host, portText] = String(listen).includes(':') ? String(listen).split(':') : ['0.0.0.0', String(listen)];
  const port = Number(portText);
  if (!Number.isFinite(port)) { onError('--listen 端口无效：' + listen); return null; }

  const server = http.createServer((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('需要 WebSocket 升级');
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') { socket.destroy(); return; }
    const url = new URL(req.url ?? '/', 'http://' + (host === '0.0.0.0' ? '127.0.0.1' : host));
    if (path !== '' && url.pathname !== path) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (typeof authorize === 'function' && authorize(req, url) !== true) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
      + 'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n',
    );
    socket.setNoDelay(true);

    const link = {
      label: 'reverse ' + String(req.socket.remoteAddress) + ':' + String(req.socket.remotePort),
      ready: true,
      send(text) { try { socket.write(encodeTextFrame(text)); return true; } catch { return false; } },
      close() { try { socket.destroy(); } catch { /* ignore */ } },
      request: req,
      url,
    };
    let buffer = Buffer.alloc(0);
    const teardown = () => { try { socket.destroy(); } catch { /* ignore */ } };
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const decoded = decodeFrames(buffer);
      buffer = decoded.rest;
      for (const message of decoded.messages) {
        if (message.type === 'close') { socket.end(); continue; }
        if (message.type === 'ping') { try { socket.write(encodeFrame(0xa, message.payload)); } catch { /* ignore */ } continue; }
        if (message.type === 'text') onText(link, message.payload.toString('utf8'));
      }
    });
    socket.on('close', () => onReady && teardown());
    socket.on('error', teardown);
    onReady(link);
  });

  server.on('error', (error) => onError('反向 WS 服务启动失败：' + String(error && error.message ? error.message : error)));
  server.listen(port, host, () => {
    const bound = server.address();
    const actualPort = bound !== null && typeof bound === 'object' ? bound.port : port;
    onListening({ host, port: actualPort });
  });
  return server;
}

/** 反向连接的鉴权（OneBot 语义：Authorization: Bearer <token> 或 ?access_token=）。 */
export function bearerOrQueryToken(token) {
  return (req, url) => {
    if (!token) return true;
    if (String(req.headers.authorization ?? '') === 'Bearer ' + token) return true;
    return url.searchParams.get('access_token') === token;
  };
}
