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

import { createSession } from '../lib/session/manager.js';
import { createFlowAuth, createFlowGate } from '../lib/valve/security/flow-auth.js';
import { generateSecret, totp } from '../lib/valve/security/totp.js';

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
function makeWorld(flowEnabled, options = {}) {
  const gatedList = options.gated === undefined ? GATED.slice() : options.gated.slice();
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
    gatedTools: () => gatedList,
  });

  const guards = [];
  const registry = {};
  const restricted = [];
  const moliCalls = [];
  let nativeCalls = 0;
  const toolsService = {
    guard: (fn) => { guards.push(fn); return () => {}; },
    get: (name) => registry[name],
    register: (def) => { registry[def.name] = def; return () => {}; },
    restrict: (filter) => { restricted.push(filter); return () => {}; },
  };
  registry.subagent = { name: 'subagent', execute: async () => { nativeCalls += 1; return { native: true }; } };
  registry.subagent_fork = { name: 'subagent_fork', execute: async () => { nativeCalls += 1; return { fork: true }; } };
  registry.moli_fetch = { name: 'moli_fetch', execute: async (args) => { moliCalls.push(args); return { ok: true, url: args.url }; } };

  const state = { convos: new Map(), stats: { guestBlocked: 0, flowBlocked: 0 } };
  const cfg = {
    auth: { guestToolAllow: ['qqbot', 'qqgroup'], owners: [OWNER] },
    agentPreset: '',
    flowAuth: { enabled: flowEnabled === true, gatedTools: gatedList.slice() },
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
    clock, secret, auth, gate, guards, registry, restricted, state, session, runGuards, toolsService, moliCalls,
    nativeCalls: () => nativeCalls,
  };
}

async function ownerEntry(world, key, qq) {
  const entry = await world.session.getEntry(key, 'qqbot-' + key, '', null);
  // groupId 按会话键推：闸门现在是靠回合快照判「私聊」的（不再解析 entryKey），
  // 夹具不带上群号等于把群会话伪装成私聊。
  const groupId = key.startsWith('group-') ? key.slice('group-'.length) : null;
  entry.turnSpeaker = { userId: qq, groupId, tier: 'owner', owner: true, sources: ['static'] };
  entry.dshAllowed = true;
  entry.flowArmedAt = undefined;
  entry.flowAllow = undefined;
  return entry;
}

console.log('1. 开关关着：行为与 0.11 一致（遮蔽装上了，但原样放行）');
{
  const w = makeWorld(false);
  const entryOff = await ownerEntry(w, 'private-' + OWNER, OWNER);
  check('没有摘除任何编排工具', w.restricted.length === 0, 'restricted=' + w.restricted.length);
  // 关着时「身份不对也必须放行」才是 0.11 的行为：接管只允许发生在开关打开时。
  entryOff.turnSpeaker = { userId: '999999', groupId: null, tier: 'guest', owner: false, sources: [] };
  let threwOff = ''; let outOff = null;
  try { outOff = await w.registry.subagent.execute({}, { name: 'subagent', agent: null }); } catch (error) { threwOff = String(error.message); }
  check('关着时访客也照常能用（不看身份、不拦）', threwOff === '' && outOff !== null && outOff.native === true, threwOff);
  check('关着时不消耗授权、也不标产物', w.auth.status().pending === 0 && entryOff.flowArmedAt === undefined);
  check('关着时 requestAuth 直接拒绝（不建 pending）', w.auth.requestAuth(OWNER, 'x', 'subagent').ok === false);
}

console.log('\n2. 开关打开：拥有者私聊 → 同名遮蔽成带闸门的 wrapper');
const world = makeWorld(true);
const entry = await ownerEntry(world, 'private-' + OWNER, OWNER);
// 行为断言（不看源码字符串）：开关打开、没有授权时 wrapper 必须拒绝。
let threwShadow = '';
try { await world.registry.subagent.execute({}, { name: 'subagent', agent: null }); } catch (error) { threwShadow = String(error.message); }
check('开关打开且没授权时 wrapper 拒绝', threwShadow !== '' && threwShadow.includes('授权'), threwShadow);
check('没有把 subagent 摘掉（工具仍在表里）', world.restricted.every((f) => !(Array.isArray(f.deny) && f.deny.includes('subagent'))));

console.log('\n3. 一次调用只吃一个 grant（guard + wrapper 不能各问一次）');
{
  world.auth.requestAuth(OWNER, 'run subagent', 'subagent');
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
  w.auth.requestAuth(OWNER, 'boom', 'subagent');
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


console.log('\n6. 同一回合的第二个 gated 工具仍要自己的码（记账不能跨工具复用）');
{
  const w = makeWorld(true);
  await ownerEntry(w, 'private-' + OWNER, OWNER);
  w.auth.requestAuth(OWNER, 'a', 'subagent');
  const granted = w.auth.consumeToken(OWNER, totp(w.secret, { timeMs: w.clock.now }));
  w.gate.remember(OWNER, granted.grantId);
  const exec = { name: 'subagent', agent: null };
  w.runGuards(exec);
  let firstThrew = '';
  try { await w.registry.subagent.execute({}, exec); } catch (error) { firstThrew = String(error.message); }
  check('第一个工具靠这条 grant 跑通', firstThrew === '', firstThrew);
  let secondThrew = '';
  try { await w.registry.subagent_fork.execute({}, { name: 'subagent_fork', agent: null }); } catch (error) { secondThrew = String(error.message); }
  check('换一个 gated 工具仍被拦（记账按工具，不是全局通行证）', secondThrew.includes('授权'), secondThrew);
}

console.log('\n7. 群里的尝试不能把私聊的授权烧掉');
{
  const w = makeWorld(true);
  w.auth.requestAuth(OWNER, 'x', 'subagent');
  const granted = w.auth.consumeToken(OWNER, totp(w.secret, { timeMs: w.clock.now }));
  w.gate.remember(OWNER, granted.grantId);
  // 每个会话各装一个守卫：这里只看「刚建的这个会话」的守卫（真机上也只有这一个在跑）。
  const g0 = w.guards.length;
  await ownerEntry(w, 'group-123', OWNER);
  const groupVerdict = w.guards[g0]({ name: 'subagent', agent: null });
  check('群里调用被拒，并提示只能在拥有者私聊', typeof groupVerdict === 'string' && groupVerdict.includes('拥有者私聊'), String(groupVerdict));
  const g1 = w.guards.length;
  await ownerEntry(w, 'private-' + OWNER, OWNER);
  const privateVerdict = w.guards[g1]({ name: 'subagent', agent: null });
  check('私聊这边码还在（没被群里的尝试花掉）', privateVerdict === undefined, JSON.stringify(privateVerdict));
}

console.log('\n8. moli_fetch：原装工具只设一道验证墙（动态码），我们的渲染分支另有守卫');
{
  const gated = GATED.concat(['moli_fetch']);
  const w = makeWorld(true, { gated });
  await ownerEntry(w, 'private-' + OWNER, OWNER);
  let noCode = '';
  try { await w.registry.moli_fetch.execute({ url: 'http://127.0.0.1:1/' }, { name: 'moli_fetch', agent: null }); } catch (error) { noCode = String(error.message); }
  check('没码时被闸门拦下（内网目标也一样）', noCode.includes('授权'), noCode);
  check('拦下时没有调用原工具', w.moliCalls.length === 0, 'calls=' + w.moliCalls.length);

  w.auth.requestAuth(OWNER, 'm', 'moli_fetch');
  const granted = w.auth.consumeToken(OWNER, totp(w.secret, { timeMs: w.clock.now }));
  w.gate.remember(OWNER, granted.grantId);
  const okRes = await w.registry.moli_fetch.execute({ url: 'http://127.0.0.1:1/' }, { name: 'moli_fetch', agent: null });
  check('拿到码后原样转交（内网地址由拥有者自己负责）', okRes.ok === true && w.moliCalls.length === 1, JSON.stringify(okRes));
}


// 以前这里印 total/total：即使挂了 3 条，汇总行照样是 20/20，看日志的人只会看到「全过」。
console.log('\n' + (total - failures) + '/' + total + ' 项通过');
if (failures > 0) {
  console.log(failures + ' 项失败');
  process.exit(1);
}
