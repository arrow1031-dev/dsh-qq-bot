#!/usr/bin/env node
/**
 * 主动发言回合的端到端验证：不需要 DSH，不需要 QQ，也不需要等定时器。
 *
 *   node test/test-proactive-round.mjs
 *
 * 目的：把「轮到该说话 → 判断 → 发言 → 校验（requireCjk）→ 回退 → 发送」整条链在
 * 真插件代码上跑一遍。此前这条链只有生产实例上肉眼验证过，纯函数测试盖不到
 * index.js 里那段胶水——尤其「requireCjk 有没有真的透传进发言阶段」这种接线错误。
 *
 * 做法：假 ctx + 真 lib/index.js + 假 OneBot；把插件注册的定时器回调抓出来手动触发，
 * 于是整轮检查是确定性的，不用 sleep 五分钟。
 */

import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import process from 'node:process';
import { startMockOneBot } from './mock-onebot.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(here, '..');
let failures = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  if (!ok) failures += 1;
  console.log('  [' + (ok ? 'PASS' : 'FAIL') + '] ' + name + (ok || detail === '' ? '' : ' — ' + detail));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (sent) => {
  const msg = (sent && Array.isArray(sent.message)) ? sent.message : [];
  const seg = msg.find((s) => s && s.type === 'text');
  return seg && seg.data && typeof seg.data.text === 'string' ? seg.data.text : '';
};
async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('等待超时：' + label);
    await sleep(50);
  }
}

const linkPath = path.join(PKG_ROOT, 'node_modules');
let createdLink = false;
const PROFILE_MODULES = process.env.DSH_PROFILE_MODULES ?? path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'profiles', 'node_modules');
if (!fs.existsSync(linkPath) && fs.existsSync(PROFILE_MODULES)) {
  fs.symlinkSync(PROFILE_MODULES, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  createdLink = true;
}
try { await import.meta.resolve('@deepseek-ai/schemastery'); }
catch {
  console.log('缺少 @deepseek-ai/schemastery —— 请先在本目录执行 npm install / pnpm install。');
  process.exit(2);
}

const logLines = [];
const realLog = console.log;
console.log = (...args) => { logLines.push(args.map(String).join(' ')); realLog(...args); };

const mock = await startMockOneBot({ quiet: true });
const disposers = [];
const agents = new Map();
const fakeWorkspaces = new Map();
const fakeWorkspaceRegistry = {
  async resolveByPath(p) { return fakeWorkspaces.get(p); },
  async create(p, title) { const ws = { id: 'ws-' + (fakeWorkspaces.size + 1), path: p, title }; fakeWorkspaces.set(p, ws); return ws; },
  async list() { return [...fakeWorkspaces.values()]; },
};
const fakeAgent = (sessionId) => ({ sessionId, options: { provider: '', model: '' }, async followup() {}, async whenIdle() {} });

// 抓 proactive 的定时器：首次检查 = intervalMinutes*60000/2，远大于阈值。
const proactiveTimers = [];
let speakCalls = 0;
const ctx = {
  fiber: { marker: 'plugin-fiber' },
  inject(names, callback) {
    if (Array.isArray(names) && names.includes('settings')) callback({ effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {}; }, settings: { configure() { return () => {}; } } });
    return () => {};
  },
  on() { return () => {}; },
  subprocess: {
    async resolveExecutable() { return process.execPath; },
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      const done = new Promise((resolve) => child.on('close', (exitCode, signal) => resolve({ exitCode, signal })));
      return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, done, terminate() { try { child.kill('SIGTERM'); } catch { /* ignore */ } }, waitForExit: () => done.then(() => true), _child: child };
    },
  },
  reflect: { get(name) { return name === 'workspaceRegistry' ? fakeWorkspaceRegistry : undefined; } },
  workspaceRegistry: fakeWorkspaceRegistry,
  sessionController: {
    async create(request) { return { sessionId: request.sessionId }; },
    async resolveAgent(sessionId) { if (!agents.has(sessionId)) agents.set(sessionId, fakeAgent(sessionId)); return { agent: agents.get(sessionId) }; },
  },
  timeout(cb, delay) {
    if (Number(delay) >= 30000) { proactiveTimers.push({ cb, delay: Number(delay) }); return () => {}; }
    const t = setTimeout(cb, delay);
    return () => clearTimeout(t);
  },
  effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {}; },
  tools: { register() { return () => {}; } },
  attachments: { async saveImage() { return { attachmentId: 'x', mediaType: 'image/png', bytes: 1, width: 0, height: 0 }; } },
  llm: {
    async resolveModelInfo(provider, model) { return { provider, model, inputModalities: ['text'] }; },
    async *stream(options) {
      const model = String(options.model ?? '');
      if (model === 'judge-m') {
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ speak: true, topic: '下午打球', message: '那就下午三点老地方见' }) };
        return;
      }
      speakCalls += 1;
      // 发言阶段故意返回整句英文拒绝语：requireCjk 开着时应当被拦，然后回退到判断正文。
      yield { type: 'text-delta', index: 0, text: "Sorry, it looks like I can't chat about this topic right now." };
    },
  },
};

try {
  const mod = await import(pathToFileURL(path.join(PKG_ROOT, 'lib', 'index.js')).href);
  const validated = mod.Config['~standard'].validate({
    onebot: { wsUrl: mock.wsUrl, httpUrl: mock.httpUrl },
    reply: { ackAfterMs: 0 },
    proactive: {
      enabled: true,
      groups: ['33333'],
      intervalMinutes: 5,
      windowMessages: 20,
      minNewMessages: 1,
      quietHours: [],
      maxPerHour: 5,
      maxPerDay: 20,
      minGapMinutes: 0,
      provider: 'mockp',
      model: 'judge-m',
      speakModel: 'speak-m',
      speakFallback: true,
      requireCjk: true,
      dryRun: false,
      verbose: true,
      maxChars: 120,
    },
  });
  check('Config 校验通过', validated.issues === undefined, JSON.stringify(validated.issues));
  await mod.apply(ctx, validated.value);
  await waitFor(() => mock.clientCount() === 1, 10000, '适配器连上假 OneBot');
  await waitFor(() => logLines.some((l) => l.includes('OneBot 已连接')), 8000, 'OneBot 已连接');
  check('适配器已连接且 OneBot 就绪', mock.clientCount() === 1 && logLines.some((l) => l.includes('OneBot 已连接')));
  check('抓到了主动发言定时器', proactiveTimers.length >= 1, String(proactiveTimers.length));

  // 造一段「有三人、最新一条是问题、时间新鲜」的群聊，绕开事件闸的各种跳过条件。
  const nowSec = Math.floor(Date.now() / 1000);
  const chat = [
    [30001, '阿七', '下午有人打球吗', 300],
    [30002, '小满', '我去，不过得三点后', 240],
    [30003, '路人', '我也想去，场地订了吗', 180],
    [30001, '阿七', '还没订，人够就订', 120],
    [30002, '小满', '那我来订，你们几点到', 60],
  ];
  for (const [uid, nick, text, ago] of chat) {
    mock.history.push({
      message_id: 900000 + uid, time: nowSec - ago, message_type: 'group', group_id: 33333,
      user_id: uid, sender: { user_id: uid, nickname: nick, card: '' },
      message: [{ type: 'text', data: { text } }], raw_message: text,
    });
  }

  // 手动触发那一轮检查（不用真的等三分钟）。
  const best = proactiveTimers.slice().sort((a, b) => b.delay - a.delay)[0];
  const tick = best.cb;
  await tick();
  const sentGroup = await waitFor(() => mock.sent.find((s) => Number(s.group_id) === 33333 || Number(s.target_id) === 33333), 8000, '主动发言发送');
  const text = textOf({ message: sentGroup.message });
  check('发言阶段两次拿到英文拒绝语（说明真调到了发言模型）', speakCalls >= 2, 'speakCalls=' + speakCalls);
  check('英文拒绝语没有被发出去', !/^Sorry,/i.test(text), JSON.stringify(text.slice(0, 40)));
  check('回退到了判断阶段的正文', text.includes('老地方'), JSON.stringify(text));
  check('verbose 日志记录了 no-cjk 拦截', logLines.some((l) => l.includes('no-cjk')), 'logLines=' + logLines.length);
} catch (error) {
  failures += 1;
  console.log('\n错误：' + (error && error.stack ? error.stack : String(error)));
} finally {
  for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  await sleep(400);
  await mock.close();
  if (createdLink) { try { if (process.platform === 'win32') fs.rmdirSync(linkPath); else fs.unlinkSync(linkPath); } catch { /* ignore */ } }
}

const passed = results.filter(Boolean).length;
console.log('\n' + passed + '/' + results.length + ' 项通过');
if (failures > 0) { console.log('主动发言回合自测失败'); process.exit(1); }
console.log('主动发言回合自测通过');
process.exit(0);