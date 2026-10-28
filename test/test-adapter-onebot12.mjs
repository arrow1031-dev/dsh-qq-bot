#!/usr/bin/env node
/**
 * OneBot 12 适配器自测：正向 WS 事件翻译 / HTTP 动作发送 / 反向 WS / 不支持动作。
 * 全程本地假实现端，不连真实 QQ。
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { startReverseServer, connectForward } from '../lib/transport/bridge/ws.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.join(here, '..', 'lib', 'transport', 'adapters', 'onebot12.mjs');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail === undefined ? '' : ' -> ' + detail)); }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timeout: ' + label);
    await sleep(30);
  }
}

function startAdapter(args) {
  const child = spawn(process.execPath, [ADAPTER, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  const frames = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line === '') continue;
      try { frames.push(JSON.parse(line)); } catch { /* ignore */ }
    }
  });
  return { child, frames, send: (command) => child.stdin.write(JSON.stringify(command) + '\n') };
}

// ---------------------------------------------------------------- 1. 正向 WS + HTTP 发送
const groupEvent = {
  id: 'e1', time: 1700000000.5, type: 'message', detail_type: 'group', sub_type: '',
  self: { platform: 'qq', user_id: '10000' },
  message_id: 'm-1', user_id: '22222', group_id: '33333',
  alt_message: '@10000 你好[图片]',
  message: [
    { type: 'mention', data: { user_id: '10000' } },
    { type: 'text', data: { text: '你好，帮我看看' } },
    { type: 'image', data: { file_id: 'file-abc' } },
    { type: 'reply', data: { message_id: 'm-0' } },
  ],
  sender: { nickname: '小明' },
};

const delivered = [];
const mockHttp = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { parsed = null; }
    delivered.push({ path: req.url, action: parsed && parsed.action, params: parsed && parsed.params });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (parsed && parsed.action === 'delete_message') {
      res.end(JSON.stringify({ status: 'failed', retcode: 10002, data: null, message: 'unsupported action' }));
    } else {
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: '42', time: 1700000001.5 } }));
    }
  });
});
await new Promise((resolve) => mockHttp.listen(0, '127.0.0.1', resolve));
const httpUrl = 'http://127.0.0.1:' + mockHttp.address().port;

let serverLink = null;
const mockWs = startReverseServer({
  listen: '127.0.0.1:0',
  onText: () => {},
  onReady: (link) => { serverLink = link; },
  onListening: () => {},
  onError: (text) => { throw new Error(text); },
});
const wsPort = await waitFor(() => {
  const address = mockWs.address();
  return address && typeof address === 'object' ? address.port : 0;
}, 5000, 'mock ws listen');

const forward = startAdapter(['--ws', 'ws://127.0.0.1:' + wsPort + '/', '--http', httpUrl, '--send-gap-ms', '5', '--heartbeat-ms', '0']);
const hello = await waitFor(() => forward.frames.find((f) => f.type === 'hello'), 5000, 'hello');
check('hello 帧带协议 id', hello.adapter === 'onebot12', String(hello.adapter));

await waitFor(() => serverLink !== null, 5000, 'adapter connected');
const connected = await waitFor(() => forward.frames.find((f) => f.type === 'status' && f.connected === true), 5000, 'status connected');
check('正向 WS 连接后上报 connected', connected !== undefined);

serverLink.send(JSON.stringify({ id: 'c1', time: 1700000000.1, type: 'meta', detail_type: 'connect', sub_type: '', version: { impl: 'mock', onebot_version: '12' } }));
serverLink.send(JSON.stringify(groupEvent));

const inbound = await waitFor(() => forward.frames.find((f) => f.type === 'message'), 5000, 'message frame');
check('群消息映射为 group', inbound.message_type === 'group');
check('群号与发送者 ID 是字符串', inbound.group_id === '33333' && inbound.user_id === '22222');
check('self_id 来自 self.user_id', inbound.self_id === '10000');
check('文本归一正确', inbound.text === '@10000 你好，帮我看看[图片]', JSON.stringify(inbound.text));
check('图片计数', inbound.images === 1, String(inbound.images));
check('引用 id 提取', String(inbound.reply_to) === 'm-0', String(inbound.reply_to));
check('段数组已转统一段', Array.isArray(inbound.message) && inbound.message.some((s) => s.type === 'at' && s.data.qq === '10000'));
check('sender 昵称兜底', inbound.sender && inbound.sender.nickname === '小明');

// 发送：文本
forward.send({ type: 'send', message_type: 'group', target_id: '33333', text: '在的', echo: 'e-send-1' });
const sendResult = await waitFor(() => forward.frames.find((f) => f.type === 'send_result' && f.echo === 'e-send-1'), 5000, 'send_result');
check('send_result ok', sendResult.ok === true, String(sendResult.error));
check('send_result 带 message_id', sendResult.message_id === '42');
const sendCall = delivered.find((row) => row.action === 'send_message');
check('动作名是 send_message', sendCall !== undefined);
check('群发送参数正确', sendCall.params.detail_type === 'group' && sendCall.params.group_id === '33333');
check('文本段形状正确', JSON.stringify(sendCall.params.message) === JSON.stringify([{ type: 'text', data: { text: '在的' } }]));

// 发送：带引用与 at 的私聊
forward.send({ type: 'send', message_type: 'private', target_id: '22222', text: '', reply_to: 'm-0',
  message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: '收到' } }, { type: 'image', data: { url: 'https://x/y.png' } }],
  echo: 'e-send-2' });
const sendResult2 = await waitFor(() => forward.frames.find((f) => f.type === 'send_result' && f.echo === 'e-send-2'), 5000, 'send_result 2');
check('私聊发送 ok', sendResult2.ok === true, String(sendResult2.error));
const privateCall = delivered.filter((row) => row.action === 'send_message')[1];
check('私聊 detail_type/user_id', privateCall.params.detail_type === 'private' && privateCall.params.user_id === '22222');
check('reply 段在最前', privateCall.params.message[0].type === 'reply' && privateCall.params.message[0].data.message_id === 'm-0');
check('at 映射成 mention', privateCall.params.message[1].type === 'mention' && privateCall.params.message[1].data.user_id === '10000');
check('image 映射成 file_id', privateCall.params.message[3].type === 'image' && privateCall.params.message[3].data.file_id === 'https://x/y.png');

// 不支持的动作
forward.send({ type: 'action', action: 'delete_msg', params: { message_id: 'm-1' }, echo: 'e-act-1' });
const actResult = await waitFor(() => forward.frames.find((f) => f.type === 'action_result' && f.echo === 'e-act-1'), 5000, 'action_result');
check('动作映射到 delete_message', delivered.some((row) => row.action === 'delete_message'));
check('不支持的动回报 ok=false', actResult.ok === false);
check('错误信息说明不支持', String(actResult.error).includes('不支持'), String(actResult.error));

// ping / shutdown
forward.send({ type: 'ping' });
check('ping 回 pong', await waitFor(() => forward.frames.find((f) => f.type === 'pong'), 3000, 'pong') !== undefined);
forward.send({ type: 'shutdown' });
const exitCode = await new Promise((resolve) => forward.child.on('exit', (code) => resolve(code)));
check('shutdown 正常退出', exitCode === 0, String(exitCode));
mockHttp.close();
mockWs.close();

// ---------------------------------------------------------------- 2. 反向 WS
const reverse = startAdapter(['--listen', '127.0.0.1:0', '--token', 'secret', '--heartbeat-ms', '0']);
const listening = await waitFor(() => reverse.frames.find((f) => f.type === 'listening'), 5000, 'listening');
check('反向模式上报 listening', listening.port > 0);

// 错误 token 的连接应被拒绝（握手 401），正确的能连上
let rejected = false;
try {
  connectForward({ url: 'ws://127.0.0.1:' + listening.port + '/', token: 'wrong', linkSet: { add: () => {}, remove: () => {}, active: () => null }, onText: () => {}, onError: () => { rejected = true; } });
} catch { rejected = true; }
await sleep(300);
check('错误 token 被拒绝', rejected === true);

const clientLinks = { list: [], add(link) { this.list.push(link); }, remove(link) { this.list = this.list.filter((x) => x !== link); }, active() { return this.list[0] ?? null; } };
let clientText = null;
connectForward({
  url: 'ws://127.0.0.1:' + listening.port + '/', token: 'secret', linkSet: clientLinks,
  onText: (_link, text) => { clientText = text; }, onOpen: () => {}, onError: () => {},
});
const clientLink = await waitFor(() => { const active = clientLinks.active(); return active && active.ready === true ? active : null; }, 5000, 'reverse client connected');
check('反向 WS 连接建立', clientLink !== null);
clientLink.send(JSON.stringify({
  id: 'e2', time: 1700000002, type: 'message', detail_type: 'private', sub_type: '',
  self: { platform: 'qq', user_id: '10000' }, message_id: 'm-9', user_id: '22222',
  alt_message: 'hi', message: [{ type: 'text', data: { text: 'hi' } }],
}));
const reverseInbound = await waitFor(() => reverse.frames.find((f) => f.type === 'message'), 5000, 'reverse message');
check('反向模式私聊消息翻译', reverseInbound.message_type === 'private' && reverseInbound.user_id === '22222' && reverseInbound.text === 'hi');
check('反向模式 self_id 正确', reverseInbound.self_id === '10000');
reverse.send({ type: 'shutdown' });
await new Promise((resolve) => reverse.child.on('exit', resolve));

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
