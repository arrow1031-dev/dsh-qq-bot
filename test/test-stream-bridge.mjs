#!/usr/bin/env node
/**
 * 流式增量桥自测：`node test-stream-bridge.mjs`
 *
 * 守的是：同会话增量合并（每次发全文）、节流窗口内不重复发、结束时必发 done、
 * 发送失败后停用本会话、群聊/非官方协议不会被这套逻辑“假装支持”。
 */
import { createStreamBridge, shouldStream } from '../lib/message/stream.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail === '' ? '' : ' — ' + detail)); }
}

function makeHarness() {
  let now = 0;
  const timers = [];
  const sent = [];
  const bridge = createStreamBridge({
    now: () => now,
    setTimer: (fn, ms) => { const h = { fn, at: now + ms, cleared: false }; timers.push(h); return h; },
    clearTimer: (h) => { h.cleared = true; },
    send: async (payload) => { sent.push({ ...payload, at: now }); return { ok: true }; },
    throttleMs: 600,
  });
  const tick = async (ms) => {
    now += ms;
    for (const h of timers) { if (!h.cleared && h.at <= now) { h.cleared = true; h.fn(); } }
    await Promise.resolve();
    await Promise.resolve();
  };
  return { bridge, sent, tick, timers, advance: (ms) => { now += ms; } };
}

console.log('1. 增量合并：节流窗口内只发一次全文');
{
  const h = makeHarness();
  h.bridge.push('k', { messageType: 'private', targetId: 'u1', msgId: 'm1' }, '你');
  h.bridge.push('k', null, '好');
  h.bridge.push('k', null, '呀');
  check('还没到节流点，一条都没发', h.sent.length === 0, JSON.stringify(h.sent));
  await h.tick(600);
  check('到点发一次、正文是累计全文', h.sent.length === 1 && h.sent[0].text === '你好呀', JSON.stringify(h.sent));
  check('done=false（未结束）', h.sent[0].done === false);
}

console.log('2. 结束必发 done，且带最后全文');
{
  const h = makeHarness();
  h.bridge.push('k', { messageType: 'private', targetId: 'u1', msgId: 'm1' }, '第一段');
  await h.tick(600);
  h.bridge.push('k', null, '第二段');
  await h.bridge.end('k');
  const last = h.sent[h.sent.length - 1];
  check('最后一条 done=true', last.done === true, JSON.stringify(last));
  check('最后一条是完整全文', last.text === '第一段第二段', JSON.stringify(last.text));
  check('结束后状态清空', h.bridge.size() === 0, 'size=' + h.bridge.size());
}

console.log('3. 发送失败 → 停用本会话（不刷错误）');
{
  let now = 0;
  const timers = [];
  const logs = [];
  let calls = 0;
  const bridge = createStreamBridge({
    now: () => now,
    setTimer: (fn, ms) => { const h = { fn, at: now + ms, cleared: false }; timers.push(h); return h; },
    clearTimer: (h) => { h.cleared = true; },
    throttleMs: 300,
    log: (line) => logs.push(line),
    send: async () => { calls += 1; return { ok: false, error: 'rate limited' }; },
  });
  bridge.push('k', { messageType: 'private', targetId: 'u1', msgId: 'm1' }, 'a');
  now += 300;
  for (const t of timers) if (!t.cleared && t.at <= now) { t.cleared = true; t.fn(); }
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  check('失败后本会话被停用（状态清空）', bridge.size() === 0, 'size=' + bridge.size());
  check('有日志说明原因', logs.length >= 1 && JSON.stringify(logs).includes('rate limited'), logs.join(' | '));
  check('只尝试发送一次', calls === 1, 'calls=' + calls);
}


console.log('4. 没有 target 的 push 不会发');
{
  const h = makeHarness();
  h.bridge.push('k', null, '孤立增量');
  await h.tick(600);
  check('没 target 就不发', h.sent.length === 0, JSON.stringify(h.sent));
}

console.log('5. 取消后不再发');
{
  const h = makeHarness();
  h.bridge.push('k', { messageType: 'private', targetId: 'u1', msgId: 'm1' }, 'x');
  h.bridge.cancel('k');
  await h.tick(1200);
  check('取消后没有发送', h.sent.length === 0, JSON.stringify(h.sent));
}


console.log('6. shouldStream：只有官方 v2 + 开关 + 私聊 + msg_id 才流');
{
  check('官方私聊 + 开关 + msg_id → true', shouldStream({ protocol: 'qq-official', streaming: true, isGroup: false, messageId: 'm1' }) === true);
  check('群聊一律 false（官方流式不支持群）', shouldStream({ protocol: 'qq-official', streaming: true, isGroup: true, messageId: 'm1' }) === false);
  check('开关没开 false', shouldStream({ protocol: 'qq-official', streaming: false, isGroup: false, messageId: 'm1' }) === false);
  check('非官方协议 false（OneBot 没有流式）', shouldStream({ protocol: 'onebot11', streaming: true, isGroup: false, messageId: 'm1' }) === false);
  check('没有 msg_id false（没有被动回复凭证）', shouldStream({ protocol: 'qq-official', streaming: true, isGroup: false, messageId: '' }) === false);
}

console.log('7. end() 返回是否真的发出帧（决定要不要回退普通发送）');
{
  const h = makeHarness();
  h.bridge.push('k', { messageType: 'private', targetId: 'u1', msgId: 'm1' }, '完整全文');
  const ended = await h.bridge.end('k');
  check('发出过帧 → ok=true 且 sent>=1', ended !== null && ended.ok === true && ended.sent >= 1, JSON.stringify(ended));
  check('end 之后状态清空', h.bridge.size() === 0);
}

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail > 0) process.exitCode = 1;
