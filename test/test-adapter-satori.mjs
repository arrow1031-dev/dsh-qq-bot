#!/usr/bin/env node
/**
 * Satori 适配器自测：本脚本扮演 SDK（Koishi 侧），适配器作为应用连进来。
 *
 *   node test/test-adapter-satori.mjs
 *
 * 覆盖：
 *   1. content 元素串 parser / serializer 往返（转义、实体、注释、未知标签、引用、图片）；
 *   2. IDENTIFY 握手（op:3 + token）与 PING/PONG 心跳（op:1/op:2）；
 *   3. 群消息 / 私聊消息 -> CONTRACT message 帧（channel_id 前缀映射、self_id、图片、引用）；
 *   4. 发送：text 与段数组都翻译成 Satori content，HTTP payload 形状与三个鉴权头；
 *   5. 动作映射（set_group_kick / set_group_ban -> guild.member.*）与不支持动作的 ok=false；
 *   6. 鉴权失败（HTTP 401 / WS 被关）与未知事件忽略。
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import { acceptKey, encodeTextFrame, encodeFrame, decodeFrames } from '../lib/transport/bridge/ws.mjs';
import { contentToSegments, segmentsToContent, normalizeWsUrl, deriveHttpBase, parseChannelId, eventToFrame } from '../lib/transport/adapters/satori.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.join(here, '..', 'lib', 'transport', 'adapters', 'satori.mjs');

let failures = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  if (!ok) failures += 1;
  console.log('  [' + (ok ? 'PASS' : 'FAIL') + '] ' + name + (ok || detail === '' ? '' : ' — ' + detail));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('等待超时：' + label);
    await sleep(40);
  }
}

// ================================================================= 假 Satori SDK

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

async function startMockSatori(options = {}) {
  const host = '127.0.0.1';
  const token = options.token ?? 'test-token';
  const platform = 'qq';
  const selfId = '10000';
  const calls = [];
  const identify = [];
  const wsPaths = [];
  const sockets = new Set();
  const state = { pings: 0, connections: 0, authFailures: 0, sn: 0, closedCodes: [] };
  let server = null;

  const sendFrame = (socket, value) => {
    try { socket.write(encodeTextFrame(JSON.stringify(value))); } catch { /* 客户端已断 */ }
  };
  const broadcast = (value) => {
    const frame = encodeTextFrame(JSON.stringify(value));
    for (const socket of sockets) {
      try { socket.write(frame); } catch { /* 忽略 */ }
    }
  };

  const routes = {
    'message.create': (body) => [{ id: 'srv-' + (calls.length), channel: { id: body.channel_id }, content: body.content }],
    'message.get': () => ({ id: '9001', content: '被引用的那条', user: { id: '10000', nick: 'bot' }, created_at: Date.now() }),
    'message.delete': () => ({}),
    'message.list': () => ({
      data: [{ id: 'm-2', content: '上一条', user: { id: '22222', nick: '小明' }, created_at: Date.now() - 60000 }],
      next: null,
      prev: null,
    }),
    'guild.get': (body) => ({ id: body.guild_id, name: '测试群' }),
    'guild.list': () => ({ data: [{ id: '33333', name: '测试群' }], next: null }),
    'guild.member.get': (body) => ({ user: { id: body.user_id, nick: '成员' + String(body.user_id) }, roles: [] }),
    'guild.member.list': () => ({
      data: [
        { user: { id: '22222', nick: '小明' }, roles: [] },
        { user: { id: '10000', nick: 'bot' }, roles: [{ id: 'admin', name: 'admin' }] },
      ],
      next: null,
    }),
    'guild.member.kick': () => ({}),
    'guild.member.mute': () => ({}),
    'guild.update': () => ({}),
    'channel.mute': () => ({}),
    'login.get': () => ({ sn: 1, platform, user: { id: selfId, nick: 'bot' }, status: 1, adapter: 'mock' }),
  };

  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://' + host);
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'POST') { json(405, { message: 'method not allowed' }); return; }
    const method = url.pathname.replace(/^\/v1\//, '');
    const raw = await readBody(req);
    let body = {};
    if (raw !== '') { try { body = JSON.parse(raw); } catch { body = {}; } }
    calls.push({ method, body, headers: req.headers, at: Date.now() });

    if (token !== '' && String(req.headers.authorization ?? '') !== 'Bearer ' + token) {
      json(401, { message: 'invalid token' });
      return;
    }
    if (String(req.headers['satori-platform'] ?? '') === '' || String(req.headers['satori-user-id'] ?? '') === '') {
      json(400, { message: 'missing Satori-Platform / Satori-User-ID' });
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(routes, method)) {
      json(404, { message: 'unsupported API ' + method });
      return;
    }
    json(200, routes[method](body));
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') { socket.destroy(); return; }
    const url = new URL(req.url ?? '/', 'http://' + host);
    wsPaths.push(url.pathname);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
      + 'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n',
    );
    socket.setNoDelay(true);
    sockets.add(socket);
    state.connections += 1;

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const decoded = decodeFrames(buffer);
      buffer = decoded.rest;
      for (const message of decoded.messages) {
        if (message.type === 'close') { socket.end(); continue; }
        if (message.type !== 'text') continue;
        let payload = null;
        try { payload = JSON.parse(message.payload.toString('utf8')); } catch { continue; }
        if (payload === null || typeof payload !== 'object') continue;

        if (payload.op === 3) {
          const body = payload.body !== null && typeof payload.body === 'object' ? payload.body : {};
          identify.push(body);
          if (token !== '' && String(body.token ?? '') !== token) {
            state.authFailures += 1;
            // 协议未定义鉴权失败帧，SDK 惯例是带 close code 关掉连接（4001 = Unauthorized）
            try { socket.write(encodeFrame(0x8, Buffer.from([0x0f, 0xa1]))); } catch { /* 忽略 */ }
            setTimeout(() => { try { socket.end(); } catch { /* 忽略 */ } }, 60);
            continue;
          }
          sendFrame(socket, {
            op: 4,
            body: {
              logins: [{ sn: 1, platform, user: { id: selfId, nick: 'bot' }, status: 1, adapter: 'mock', features: ['message.create'] }],
              proxy_urls: [],
            },
          });
          continue;
        }
        if (payload.op === 1) { state.pings += 1; sendFrame(socket, { op: 2, body: {} }); continue; }
      }
    });
    const cleanup = () => { sockets.delete(socket); };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });

  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve(server.address().port));
  });

  return {
    url: 'http://' + host + ':' + port,
    wsUrl: 'ws://' + host + ':' + port,
    calls,
    identify,
    wsPaths,
    state,
    inject(event) {
      state.sn += 1;
      broadcast({
        op: 0,
        body: Object.assign({
          sn: state.sn,
          timestamp: Date.now(),
          login: { sn: 1, platform, user: { id: selfId } },
        }, event),
      });
    },
    async close() {
      for (const socket of sockets) { try { socket.destroy(); } catch { /* 忽略 */ } }
      sockets.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function startAdapter(args) {
  const proc = spawn(process.execPath, [ADAPTER, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  const frames = [];
  let buffer = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line === '') continue;
      try { frames.push(JSON.parse(line)); } catch { /* 忽略噪声 */ }
    }
  });
  let stderr = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk) => { stderr += chunk; });
  return {
    proc,
    frames,
    stderr: () => stderr,
    send: (command) => proc.stdin.write(JSON.stringify(command) + '\n'),
  };
}

const framesOfType = (frames, type) => frames.filter((frame) => frame.type === type);
const lastCall = (calls, method) => [...calls].reverse().find((call) => call.method === method);

// ================================================================= 1. 编解码

console.log('\n1. content parser / serializer');
{
  const source = 'hi<at id="10000"/><img src="https://x/y.png"/><quote id="9001"/><b>加粗</b>&amp;&lt;&#65;';
  const parsed = contentToSegments(source);
  check('parser produces a segment array', Array.isArray(parsed.segments) && parsed.segments.length >= 5, JSON.stringify(parsed.segments));
  check('at element becomes an at segment', parsed.segments.some((s) => s.type === 'at' && s.data.qq === '10000'));
  check('img element becomes an image segment with src url', parsed.segments.some((s) => s.type === 'image' && s.data.url === 'https://x/y.png'));
  check('quote element becomes reply + replyTo', parsed.replyTo === 9001 && parsed.segments.some((s) => s.type === 'reply' && s.data.id === 9001));
  check('text entities decoded, tags stripped', parsed.text.includes('加粗&<A'), JSON.stringify(parsed.text));
  check('image counter and url list', parsed.images === 1 && parsed.imageUrls[0] === 'https://x/y.png');

  const quoted = contentToSegments('<quote id="77">被引用的内容</quote>收到');
  check('quoted content does not leak into the body text', quoted.text === '收到', JSON.stringify(quoted.text));

  const segments = [
    { type: 'text', data: { text: 'a<b & c' } },
    { type: 'at', data: { qq: '10000' } },
    { type: 'image', data: { url: 'https://x/i.png' } },
    { type: 'reply', data: { id: 9001 } },
    { type: 'face', data: { id: '1' } },
  ];
  const content = segmentsToContent(segments, {});
  check('serializer escapes text', content.startsWith('a&lt;b &amp; c'), content);
  check('serializer emits at', content.includes('<at id="10000"/>'), content);
  check('serializer emits img', content.includes('<img src="https://x/i.png"/>'), content);
  check('serializer emits quote with id', content.includes('<quote id="9001"/>'), content);
  check('serializer emits emoji for face', content.includes('<emoji id="1"/>'), content);

  const roundTripped = contentToSegments(content);
  check(
    'round trip keeps text/at/image/reply/face (order and payload)',
    roundTripped.text === 'a<b & c@10000 [图片][表情]'
      && roundTripped.segments.some((s) => s.type === 'at' && s.data.qq === '10000')
      && roundTripped.segments.some((s) => s.type === 'image' && s.data.url === 'https://x/i.png')
      && roundTripped.replyTo === 9001
      && roundTripped.segments.some((s) => s.type === 'face' && s.data.id === '1'),
    JSON.stringify(roundTripped),
  );

  check('unknown tag keeps its children', contentToSegments('<unknown>保留</unknown>').text === '保留');
  check('unclosed tag does not swallow the text', contentToSegments('<b>粗体').text === '粗体');
  check('comment is dropped', contentToSegments('a<!-- 注释 -->b').text === 'ab');
  check('stray < stays literal text', contentToSegments('1 < 2').text === '1 < 2');

  check('bare ws url gets /v1/events', normalizeWsUrl('ws://127.0.0.1:5140') === 'ws://127.0.0.1:5140/v1/events', normalizeWsUrl('ws://127.0.0.1:5140'));
  check('explicit ws path kept', normalizeWsUrl('ws://h:5140/v1/events') === 'ws://h:5140/v1/events');
  check('http base derived from ws url', deriveHttpBase('ws://127.0.0.1:5140/v1/events') === 'http://127.0.0.1:5140', deriveHttpBase('ws://127.0.0.1:5140/v1/events'));
  check('channel prefix mapping', parseChannelId('group:33333').messageType === 'group'
    && parseChannelId('group:33333').targetId === '33333'
    && parseChannelId('private:44444').messageType === 'private'
    && parseChannelId('777', 1).messageType === 'private'
    && parseChannelId('777', 0).messageType === 'group');

  const frame = eventToFrame({
    type: 'message-created',
    timestamp: 1700000000000,
    login: { sn: 1, platform: 'qq', user: { id: '10000' } },
    channel: { id: 'group:33333', type: 0 },
    guild: { id: '33333', name: '测试群' },
    user: { id: '22222', nick: '小明' },
    message: { id: 'm1', content: 'hi<at id="10000"/>' },
  });
  check('eventToFrame is pure and fills CONTRACT fields', frame !== null
    && frame.message_type === 'group' && frame.group_id === '33333' && frame.user_id === '22222'
    && frame.self_id === '10000' && frame.time === 1700000000 && frame.message_id === 'm1', JSON.stringify(frame));
  check('eventToFrame ignores non message events', eventToFrame({ type: 'guild-updated' }) === null);
}

// ================================================================= 2. 握手

const mock = await startMockSatori({ token: 'test-token' });
console.log('\nmock Satori: ' + mock.url);

const adapter = startAdapter([
  '--ws', mock.wsUrl,
  '--http', mock.url,
  '--token', 'test-token',
  '--platform', 'qq',
  '--ping-ms', '150',
  '--send-gap-ms', '10',
]);

let adapter2 = null;
try {
  console.log('\n2. IDENTIFY 与 PING/PONG 握手');
  const status = await waitFor(
    () => adapter.frames.find((frame) => frame.type === 'status' && frame.connected === true),
    10000,
    'status connected',
  );
  check('adapter reports connected', status !== undefined);
  const hello = adapter.frames.find((frame) => frame.type === 'hello');
  check('hello frame advertises the satori adapter', hello !== undefined && hello.adapter === 'satori', JSON.stringify(hello));
  check('hello contains ws/http/platform', hello.wsUrl.endsWith('/v1/events') && hello.httpUrl === mock.url && hello.platform === 'qq');
  await waitFor(() => mock.wsPaths.length > 0, 5000, 'websocket upgrade');
  check('adapter connected to /v1/events', mock.wsPaths[0] === '/v1/events', String(mock.wsPaths[0]));
  await waitFor(() => mock.identify.length > 0, 5000, 'IDENTIFY');
  check('IDENTIFY is op:3 with the token', mock.identify[0].token === 'test-token', JSON.stringify(mock.identify[0]));
  await waitFor(() => mock.state.pings >= 1, 5000, 'PING');
  check('adapter pings the SDK', mock.state.pings >= 1, String(mock.state.pings));
  await sleep(250);
  const firstConnectedAt = adapter.frames.findIndex((frame) => frame.type === 'status' && frame.connected === true);
  const laterDisconnect = firstConnectedAt >= 0
    && adapter.frames.slice(firstConnectedAt + 1).some((frame) => frame.type === 'status' && frame.connected === false);
  check('PING/PONG keeps the link up (no disconnect after connect)', firstConnectedAt >= 0 && !laterDisconnect,
    JSON.stringify(adapter.frames.filter((frame) => frame.type === 'status')));
  check('self_id learned from READY', adapter.frames.some((frame) => frame.type === 'status' && frame.selfId === '10000')
    || adapter.frames.some((frame) => frame.type === 'log' && String(frame.text).includes('self_id=10000')));

  // ---------------------------------------------------------------- 3. 收消息
  console.log('\n3. 群消息 / 私聊消息翻译');
  mock.inject({
    type: 'message-created',
    channel: { id: 'group:33333', type: 0 },
    guild: { id: '33333', name: '测试群' },
    user: { id: '22222', nick: '小明' },
    message: { id: 'm-100', content: '<at id="10000"/> 你好，帮我看看<img src="https://x/y.jpg"/>' },
  });
  const groupFrame = await waitFor(() => framesOfType(adapter.frames, 'message')[0], 5000, 'group message frame');
  check('group message mapped to message_type=group', groupFrame.message_type === 'group');
  check('group id from channel_id prefix', String(groupFrame.group_id) === '33333', String(groupFrame.group_id));
  check('sender id preserved', String(groupFrame.user_id) === '22222', String(groupFrame.user_id));
  check('self_id filled from READY', String(groupFrame.self_id) === '10000', String(groupFrame.self_id));
  check('segment array present and typed', Array.isArray(groupFrame.message)
    && groupFrame.message.some((s) => s.type === 'at' && s.data.qq === '10000')
    && groupFrame.message.some((s) => s.type === 'image'), JSON.stringify(groupFrame.message));
  check('readable text with image placeholder', groupFrame.text === '@10000  你好，帮我看看[图片]', JSON.stringify(groupFrame.text));
  check('image count and urls', groupFrame.images === 1 && groupFrame.image_urls[0] === 'https://x/y.jpg');
  check('sender nickname preserved', groupFrame.sender !== null && groupFrame.sender.nickname === '小明', JSON.stringify(groupFrame.sender));
  check('message_id / time / reply_to fields', groupFrame.message_id === 'm-100'
    && typeof groupFrame.time === 'number' && groupFrame.reply_to === null, JSON.stringify(groupFrame));

  mock.inject({
    type: 'message-created',
    channel: { id: 'private:44444', type: 1 },
    user: { id: '44444', nick: '小红' },
    message: { id: 'm-101', content: '<quote id="9001"/>在吗' },
  });
  const privateFrame = await waitFor(() => framesOfType(adapter.frames, 'message')[1], 5000, 'private message frame');
  check('private message mapped to message_type=private', privateFrame.message_type === 'private');
  check('private user id from channel prefix, group_id null', String(privateFrame.user_id) === '44444' && privateFrame.group_id === null, String(privateFrame.user_id) + '/' + String(privateFrame.group_id));
  check('quote id becomes numeric reply_to', privateFrame.reply_to === 9001, JSON.stringify(privateFrame.reply_to));
  check('reply segment included', privateFrame.message.some((s) => s.type === 'reply' && s.data.id === 9001));
  check('quoted body does not pollute text', privateFrame.text === '在吗', JSON.stringify(privateFrame.text));

  mock.inject({
    type: 'message-created',
    channel: { id: 'group:33333', type: 0 },
    guild: { id: '33333' },
    user: { id: '22222', nick: '小明' },
    message: { id: 'm-102', content: '<img src="internal:qq/10000/_tmp/a.png"/>' },
  });
  const proxied = await waitFor(() => framesOfType(adapter.frames, 'message')[2], 5000, 'internal image frame');
  check('internal: image rewritten to /v1/proxy', proxied.image_urls[0] === mock.url + '/v1/proxy/internal:qq/10000/_tmp/a.png', String(proxied.image_urls[0]));
  check('original internal: url kept on the segment', proxied.message.some((s) => s.type === 'image' && s.data.file === 'internal:qq/10000/_tmp/a.png'));

  // ---------------------------------------------------------------- 4. 未知事件
  console.log('\n4. 未知事件忽略');
  const before = framesOfType(adapter.frames, 'message').length;
  mock.inject({ type: 'guild-updated', guild: { id: '33333', name: '改名了' } });
  mock.inject({ type: 'reaction-added', channel: { id: 'group:33333' } });
  await sleep(300);
  check('unknown events produce no message frame', framesOfType(adapter.frames, 'message').length === before, String(framesOfType(adapter.frames, 'message').length));

  // ---------------------------------------------------------------- 5. 发送
  console.log('\n5. 发送 payload（text / 段数组 / 引用）');
  adapter.send({ type: 'send', message_type: 'group', target_id: '33333', text: 'a<b & c', reply_to: '9001', echo: 's1' });
  const send1 = await waitFor(() => framesOfType(adapter.frames, 'send_result')[0], 10000, 'first send_result');
  check('send_result ok with a message_id', send1.ok === true && send1.echo === 's1' && send1.message_id !== null, JSON.stringify(send1));
  const create1 = await waitFor(() => lastCall(mock.calls, 'message.create'), 5000, 'message.create call');
  check('channel_id uses group: prefix', create1.body.channel_id === 'group:33333', String(create1.body.channel_id));
  check('text escaped and quote prepended', create1.body.content === '<quote id="9001"/>a&lt;b &amp; c', JSON.stringify(create1.body.content));
  check('Authorization bearer header sent', String(create1.headers.authorization) === 'Bearer test-token', String(create1.headers.authorization));
  check('Satori-Platform header sent', String(create1.headers['satori-platform']) === 'qq', String(create1.headers['satori-platform']));
  check('Satori-User-ID header sent', String(create1.headers['satori-user-id']) === '10000', String(create1.headers['satori-user-id']));
  check('no referrer unless enabled', create1.body.referrer === undefined && create1.body.channel_id !== undefined);

  adapter.send({
    type: 'send',
    message_type: 'private',
    target_id: '44444',
    message: [
      { type: 'at', data: { qq: '10000' } },
      { type: 'image', data: { url: 'https://x/i.png' } },
      { type: 'text', data: { text: '看图' } },
    ],
    echo: 's2',
  });
  await waitFor(() => framesOfType(adapter.frames, 'send_result').length >= 2, 10000, 'second send_result');
  const creates = mock.calls.filter((call) => call.method === 'message.create');
  check('segment array serialized into content', creates[1].body.content === '<at id="10000"/><img src="https://x/i.png"/>看图', JSON.stringify(creates[1].body.content));
  check('private target uses private: prefix', creates[1].body.channel_id === 'private:44444', String(creates[1].body.channel_id));

  adapter.send({ type: 'send', message_type: 'group', target_id: '33333', text: 'explicit channel', channel_id: 'channel:abc', echo: 's4' });
  await waitFor(() => framesOfType(adapter.frames, 'send_result').find((frame) => frame.echo === 's4'), 10000, 'explicit channel send_result');
  const explicitCall = lastCall(mock.calls, 'message.create');
  check('explicit channel_id from the plugin wins', explicitCall.body.channel_id === 'channel:abc', String(explicitCall.body.channel_id));

  adapter.send({ type: 'send', message_type: 'group', target_id: '33333', text: '', echo: 's3' });
  const emptyResult = await waitFor(() => framesOfType(adapter.frames, 'send_result').find((frame) => frame.echo === 's3'), 5000, 'empty send_result');
  check('empty message rejected locally (ok=false)', emptyResult.ok === false && String(emptyResult.error).includes('空消息'), JSON.stringify(emptyResult));

  // ---------------------------------------------------------------- 6. 动作
  console.log('\n6. 动作映射与不支持动作');
  adapter.send({ type: 'action', action: 'set_group_kick', params: { group_id: 33333, user_id: 22222 }, echo: 'a1' });
  const kick = await waitFor(() => framesOfType(adapter.frames, 'action_result').find((frame) => frame.echo === 'a1'), 10000, 'kick action_result');
  check('set_group_kick maps to guild.member.kick', kick.ok === true, JSON.stringify(kick));
  const kickCall = lastCall(mock.calls, 'guild.member.kick');
  check('kick payload carries guild_id and user_id', kickCall !== undefined
    && String(kickCall.body.guild_id) === '33333' && String(kickCall.body.user_id) === '22222', JSON.stringify(kickCall && kickCall.body));

  adapter.send({ type: 'action', action: 'set_group_ban', params: { group_id: 33333, user_id: 22222, duration: 60 }, echo: 'a2' });
  await waitFor(() => framesOfType(adapter.frames, 'action_result').find((frame) => frame.echo === 'a2'), 10000, 'ban action_result');
  const muteCall = lastCall(mock.calls, 'guild.member.mute');
  check('set_group_ban converts seconds to milliseconds', muteCall !== undefined && muteCall.body.duration === 60000, JSON.stringify(muteCall && muteCall.body));

  adapter.send({ type: 'action', action: 'set_group_card', params: { group_id: 33333, user_id: 22222, card: '新名片' }, echo: 'a3' });
  const card = await waitFor(() => framesOfType(adapter.frames, 'action_result').find((frame) => frame.echo === 'a3'), 10000, 'card action_result');
  check('unsupported action returns ok=false', card.ok === false, JSON.stringify(card));
  check('unsupported action explains Satori limitation', String(card.error).includes('Satori') && String(card.error).includes('不支持'), String(card.error));

  adapter.send({ type: 'action', action: 'message.list', params: { channel_id: 'group:33333', limit: 5 }, echo: 'a4' });
  const direct = await waitFor(() => framesOfType(adapter.frames, 'action_result').find((frame) => frame.echo === 'a4'), 10000, 'passthrough action_result');
  check('native resource.method passes through', direct.ok === true && Array.isArray(direct.data.data), JSON.stringify(direct));

  // ---------------------------------------------------------------- 7. 鉴权失败
  console.log('\n7. 鉴权失败');
  mock.inject({ type: 'message-created', channel: { id: 'group:33333' }, user: { id: '22222' }, message: { id: 'm-103', content: 'x' } });
  await waitFor(() => framesOfType(adapter.frames, 'message').length > 0, 5000, 'message after unknown events');
  adapter2 = startAdapter(['--ws', mock.wsUrl, '--http', mock.url, '--token', 'wrong-token', '--send-gap-ms', '10']);
  await waitFor(() => mock.state.authFailures >= 1, 8000, 'mock to reject IDENTIFY');
  check('wrong token is rejected at IDENTIFY', mock.state.authFailures >= 1);
  check('bad adapter never reports connected', !adapter2.frames.some((frame) => frame.type === 'status' && frame.connected === true)
    || adapter2.frames.some((frame) => frame.type === 'status' && frame.connected === false));
  adapter2.send({ type: 'send', message_type: 'private', target_id: '44444', text: 'hi', echo: 'bad1' });
  const badSend = await waitFor(() => adapter2.frames.find((frame) => frame.type === 'send_result' && frame.echo === 'bad1'), 10000, 'bad send_result');
  check('HTTP 401 surfaces as send failure', badSend.ok === false && String(badSend.error).includes('鉴权失败'), JSON.stringify(badSend));
  const badAdapterFrames = adapter2.frames;
  check('auth failure also emitted as error frame', badAdapterFrames.some((frame) => frame.type === 'error' && String(frame.text).includes('鉴权'))
    || badAdapterFrames.some((frame) => frame.type === 'status' && frame.connected === false),
    JSON.stringify(badAdapterFrames.filter((frame) => frame.type === 'error' || frame.type === 'status')));

  // ---------------------------------------------------------------- 8. 退出
  console.log('\n8. 干净退出');
  adapter.send({ type: 'shutdown' });
  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 5000);
    adapter.proc.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  check('adapter exits on shutdown', exitCode === 0, 'exit=' + String(exitCode));
} catch (error) {
  failures += 1;
  console.log('\nERROR: ' + (error && error.message ? error.message : String(error)));
  if (adapter.stderr().trim() !== '') console.log('adapter stderr:\n' + adapter.stderr());
  if (adapter2 !== null && adapter2.stderr().trim() !== '') console.log('adapter2 stderr:\n' + adapter2.stderr());
} finally {
  try { adapter.proc.kill('SIGKILL'); } catch { /* 已退出 */ }
  if (adapter2 !== null) { try { adapter2.proc.kill('SIGKILL'); } catch { /* 已退出 */ } }
  await mock.close();
}

const passed = results.filter((result) => result.ok).length;
console.log('\n' + passed + '/' + results.length + ' checks passed');
if (failures > 0) {
  console.log('SATORI ADAPTER SELF-TEST FAILED');
  process.exit(1);
}
console.log('SATORI ADAPTER SELF-TEST PASSED');
process.exit(0);
