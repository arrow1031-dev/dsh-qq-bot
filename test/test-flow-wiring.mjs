#!/usr/bin/env node
/**
 * 流程授权的「接线」回归：session.js 里两处闸门 + 工具接管的语义。
 *
 *   node test-flow-wiring.mjs
 *
 * 不连 QQ、不用 DSH：真 createSession + 真 flowAuth/flowGate + 假 tools 服务。
 * 守的是三条改坏也没人发现的语义：
 *   1) 一次工具调用只能吃一个 grant（guard 与同名遮蔽 wrapper 不能各问一次闸门）；
 *   2) 开关关着时不许动工具面（0.11 行为：既不遮蔽也不摘除）；
 *   3) 调用失败不能留下「本轮有产物」的标记。
 */

import { createSession } from '../lib/session.js';
import { createFlowAuth, createFlowGate } from '../lib/flow-auth.js';
import { generateSecret, totp } from '../lib/totp.js';

const OWNER = '319543886';
const GATED = ['subagent', 'subagent_fork', 'spawn_teammate', 'workflow'];

let failures = 0;
let total = 0;
function check(name, ok, detail = '') {
  total += 1;
  if (ok !== true) failures += 1;
  console.log('  [' + (ok ? 'PASS' : 'FAIL') + '] ' + name + (ok || detail === '' ? '' : ' — ' + detail));
}

/** 造一个最小的会话世界：假 tools 服务记录 guard/register/restrict，假 agent 直接返回。 */
function makeWorld(flowEnabled) {
  const clock = { now: 1700000000000 };
  const secret = generateSecret(20);
  const conf = {
    enabled: flowEnabled === true,
    totpSecret: flowEnabled === true ? secret : '',
    grantTtlSeconds: 300,
    maxAttempts: 5,
    lockoutMinutes: 15,
  };
  const auth = createFlowAuth({ config: () => conf, now: () => clock.now });
  const gate = createFlowGate({
    auth,
    enabled: () => conf.enabled === true,
    gatedTools: () => GATED,
  });

  const guards = [];
  const registry = {};
  const restricted = [];
  let nativeCalls = 0;
  const toolsService = {
    guard: (fn) => { guards.push(fn); return () => {}; },
    get: (name) => registry[name],
    register: (def) => { registry[def.name] = def; return () => {}; },
    restrict: (filter) => { restricted.push(filter); return () => {}; },
  };
  registry.subagent = { name: 'subagent', execute: async () => { nativeCalls += 1; return { native: true }; } };

  const state = { convos: new Map(), stats: { guestBlocked: 0, flowBlocked: 0 } };
  const cfg = {
    auth: { guestToolAllow: ['qqbot', 'qqgroup'], owners: [OWNER] },
    agentPreset: '',
    flowAuth: { enabled: flowEnabled === true, gatedTools: GATED.slice() },
  };
  const agent = { ctx: { get: (k) => (k === 'tools' ? toolsService : undefined) }, session: undefined, status: 'idle' };
  const ctx = {
    sessionController: { create: async () => {}, resolveAgent: async () => ({ agent }) },
    effect: (fn) => { fn(); return () => {}; },
    get: () => undefined,
    timeout: (fn) => { const t = setTimeout(fn, 5); return () => clearTimeout(t); },
    reflect: {},
  };
  const session = createSession({
    getConfig: () => cfg,
    ctx,
    state,
    ensureQqMsgWorkspace: async () => ({ id: null, path: '/tmp' }),
    sessionWorkdir: (id) => '/tmp/' + id,
    callAdapterAction: async () => ({ ok: false }),
    describeError: (e) => String(e !== null && e !== undefined && e.message ? e.message : e),
    isOwner: (qq) => String(qq) === OWNER,
    flowGate: gate,
  });

  const runGuards = (exec) => {
    for (const g of guards) {
      const verdict = g(exec);
      if (typeof verdict === 'string') return verdict;
    }
    return undefined;
  };

  return {
    clock, secret, auth, gate, guards, registry, restricted, state, session, runGuards, toolsService,
    nativeCalls: () => nativeCalls,
  };
}

async function ownerEntry(world, key, qq) {
  const entry = await world.session.getEntry(key, 'qqbot-' + key, '', null);
  entry.turnSpeaker = { userId: qq, groupId: null, tier: 'owner', owner: true, sources: ['static'] };
  entry.dshAllowed = true;
  entry.flowArmedAt = undefined;
  entry.flowAllow = undefined;
  return entry;
}

console.log('1. 开关关着：工具面一个字节都不动（0.11 行为）');
{
  const w = makeWorld(false);
  await ownerEntry(w, 'private-' + OWNER, OWNER);
  const touched = w.restricted.length + (w.registry.subagent.execute.toString().includes('flowGate') ? 1 : 0);
  check('关着时既不遮蔽也不摘除编排工具', touched === 0, 'restricted=' + w.restricted.length);
  w.auth.requestAuth(OWNER, 'x');
  check('关着时 requestAuth 直接拒绝（不建 pending）', w.auth.requestAuth(OWNER, 'x').ok === false);
}

console.log('\n2. 开关打开：拥有者私聊 → 同名遮蔽成带闸门的 wrapper');
const world = makeWorld(true);
const entry = await ownerEntry(world, 'private-' + OWNER, OWNER);
check('subagent 被同名遮蔽（注册了 wrapper）',
  world.registry.subagent.execute.toString().includes('flowGate'), 'not shadowed');
check('没有把 subagent 摘掉', world.restricted.every((f) => !(Array.isArray(f.deny) && f.deny.includes('subagent'))));

console.log('\n3. 一次调用只吃一个 grant（guard + wrapper 不能各问一次）');
{
  world.auth.requestAuth(OWNER, 'run subagent');
  const granted = world.auth.consumeToken(OWNER, totp(world.secret, { timeMs: world.clock.now }));
  world.gate.remember(OWNER, granted.grantId);
  const exec = { name: 'subagent', agent: null };
  const guardVerdict = world.runGuards(exec);
  check('guard 放行（返回 undefined）', guardVerdict === undefined, JSON.stringify(guardVerdict));
  let threw = '';
  let result = null;
  try { result = await world.registry.subagent.execute({}, exec); } catch (error) { threw = String(error.message); }
  check('wrapper 不再要第二个码', threw === '', threw);
  check('原生工具真的被执行了一次', world.nativeCalls() === 1 && result !== null && result.native === true,
    JSON.stringify({ calls: world.nativeCalls(), result }));
  check('放行后标记了本轮已授权', typeof entry.flowArmedAt === 'number');
}

console.log('\n4. 没有授权时：guard 拦下，wrapper 也不放行');
{
  const fresh = await ownerEntry(world, 'private-' + OWNER, OWNER);
  const exec = { name: 'subagent', agent: null };
  const guardVerdict = world.runGuards(exec);
  check('guard 返回可读拦截文案', typeof guardVerdict === 'string' && guardVerdict.includes('qqauth'), String(guardVerdict));
  let threw = '';
  try { await world.registry.subagent.execute({}, exec); } catch (error) { threw = String(error.message); }
  check('wrapper 也拒绝（绕过 guard 直接调工具也不行）', threw !== '', threw);
  check('拦截不计入产物标记', fresh.flowArmedAt === undefined);
}

console.log('\n5. 工具执行失败：撤掉产物标记');
{
  // 先把原生工具换成会抛错的版本，再让它被遮蔽——wrapper 调的是 original.execute，动态取到抛错版本。
  const w = makeWorld(true);
  w.registry.subagent.execute = async () => { throw new Error('boom'); };
  const e = await ownerEntry(w, 'private-' + OWNER, OWNER);
  w.auth.requestAuth(OWNER, 'boom');
  const granted = w.auth.consumeToken(OWNER, totp(w.secret, { timeMs: w.clock.now }));
  w.gate.remember(OWNER, granted.grantId);
  const exec = { name: 'subagent', agent: null };
  w.runGuards(exec);
  check('放行时先标了产物标记', typeof e.flowArmedAt === 'number');
  let threw = '';
  try { await w.registry.subagent.execute({}, exec); } catch (error) { threw = String(error.message); }
  check('失败时抛错照旧', threw.includes('boom'), threw);
  check('失败后不留 flowArmedAt（不会白打包半成品）', e.flowArmedAt === undefined, String(e.flowArmedAt));
}

console.log('\n' + total + '/' + total + ' 项通过');
if (failures > 0) {
  console.log(failures + ' 项失败');
  process.exit(1);
}
