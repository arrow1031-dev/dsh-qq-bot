/**
 * 会话归档召回自测：被 DSH「归档」的 QQ 会话，在消息触发时必须先解除归档。
 *
 * 为什么这条非测不可：宿主的 ArchivedSessionGate 挂在 agent/pre-step 上，对归档会话
 * 直接 reject —— 回合以 blocked 结束、一个模型请求都不发；而 SessionController.create
 * 的 reusable 判定也把归档会话排除。不召回 = QQ 侧消息石沉大海且没有任何报错。
 *
 * 所以断言盯的是三件事：
 *   ① unarchiveSession 真的被调用（且只在确实归档时）；
 *   ② 调用发生在 sessionController.create **之前**（晚了 reusable 就会另建会话）；
 *   ③ 召回失败/宿主没有该接口时，收发主链一点不受影响。
 *
 * 用法：node test/test-session-archive.mjs
 */
import { createSessionArchive } from '../lib/session/session-archive.js';
import { createSession } from '../lib/session/manager.js';

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + (detail === undefined ? '' : '：' + detail)); }
}

/** 静音包裹：createSession 的建会话日志太多，只让 check 的结果露出来。 */
async function quiet(fn) {
  const savedLog = console.log;
  const savedError = console.error;
  console.log = () => {};
  console.error = () => {};
  try { return await fn(); }
  finally { console.log = savedLog; console.error = savedError; }
}

/** 假 registry：只有召回真正需要的那两个成员。 */
function fakeRegistry(archived) {
  const state = { archived: archived.slice(), unarchiveCalls: [] };
  const registry = {
    get archivedSessionIds() { return state.archived.slice(); },
    async unarchiveSession(sessionId) {
      state.unarchiveCalls.push(String(sessionId));
      state.archived = state.archived.filter((id) => id !== String(sessionId));
    },
  };
  return { registry, state };
}

function ctxOf(registry) {
  return { reflect: { get: (name) => (name === 'workspaceRegistry' ? registry : undefined) } };
}

// ───────────────────────────── 召回器单元 ─────────────────────────────

{
  const { registry, state } = fakeRegistry(['qqbot-group-1']);
  const api = createSessionArchive({ ctx: ctxOf(registry) });
  const recalled = await api.recall('qqbot-group-1', '测试');
  check('已归档的会话被召回', recalled === true);
  check('调用一次 unarchiveSession', state.unarchiveCalls.length === 1 && state.unarchiveCalls[0] === 'qqbot-group-1');
  check('召回后不在归档集合里', !state.archived.includes('qqbot-group-1'));
  check('stats.recalled 计数', api.stats.recalled === 1 && api.stats.lastRecalledId === 'qqbot-group-1');
}

{
  const { registry, state } = fakeRegistry([]);
  const api = createSessionArchive({ ctx: ctxOf(registry) });
  const recalled = await api.recall('qqbot-group-2');
  check('未归档时不召回', recalled === false);
  check('未归档时不调用 unarchiveSession（不白写盘）', state.unarchiveCalls.length === 0);
}

{
  // 第二次调用时已经不在归档集合里了：宿主本身就是幂等的，这里要求不给它添乱。
  const { registry, state } = fakeRegistry(['qqbot-x']);
  const api = createSessionArchive({ ctx: ctxOf(registry) });
  await api.recall('qqbot-x');
  const again = await api.recall('qqbot-x');
  check('重复召回第二次直接跳过', again === false && state.unarchiveCalls.length === 1);
}

{
  const api = createSessionArchive({ ctx: {} });
  const recalled = await api.recall('qqbot-y');
  check('没有 workspaceRegistry（headless）不抛', recalled === false);
  check('headless 记为 unavailable 而非失败', api.stats.unavailable === 1 && api.stats.failed === 0);
}

{
  // 回落 ctx.get：reflect 取不到时仍要能找到服务。
  const { registry, state } = fakeRegistry(['qqbot-z']);
  const ctx = { reflect: { get: () => undefined }, get: (name) => (name === 'workspaceRegistry' ? registry : undefined) };
  const api = createSessionArchive({ ctx });
  const recalled = await api.recall('qqbot-z');
  check('reflect 取不到时回落 ctx.get', recalled === true && state.unarchiveCalls.length === 1);
}

{
  // 宿主 registry 还没启动：archivedSessionIds 的 getter 抛 "workspace registry is not started yet"。
  const registry = {
    get archivedSessionIds() { throw new Error('workspace registry is not started yet'); },
    async unarchiveSession() { throw new Error('不该走到这里'); },
  };
  const api = createSessionArchive({ ctx: ctxOf(registry) });
  let threw = false;
  let recalled;
  try { recalled = await api.recall('qqbot-early'); } catch { threw = true; }
  check('registry 未启动时不抛', threw === false && recalled === false);
  check('registry 未启动记为 unavailable', api.stats.unavailable === 1 && api.stats.failed === 0);
}

{
  const registry = {
    get archivedSessionIds() { return ['qqbot-bad']; },
    async unarchiveSession() { throw new Error('磁盘写失败'); },
  };
  const api = createSessionArchive({ ctx: ctxOf(registry) });
  let threw = false;
  let recalled;
  try { recalled = await api.recall('qqbot-bad'); } catch { threw = true; }
  check('unarchiveSession 抛错时不向外抛', threw === false && recalled === false);
  check('失败计数与错误文本', api.stats.failed === 1 && api.stats.lastError === '磁盘写失败');
}

{
  const { registry } = fakeRegistry(['qqbot-p']);
  const api = createSessionArchive({ ctx: ctxOf(registry) });
  check('isArchived 命中', api.isArchived('qqbot-p') === true);
  check('isArchived 未命中', api.isArchived('qqbot-q') === false);
  const none = createSessionArchive({ ctx: undefined });
  check('没有 registry 时 isArchived 恒 false', none.isArchived('qqbot-p') === false);
}

{
  // 老宿主：没有 unarchiveSession 方法。要求静默跳过、不抛（向后兼容）。
  const registry = { get archivedSessionIds() { return ['qqbot-old']; } };
  const api = createSessionArchive({ ctx: ctxOf(registry) });
  let threw = false;
  let recalled;
  try { recalled = await api.recall('qqbot-old'); } catch { threw = true; }
  check('宿主无 unarchiveSession 时不抛', threw === false && recalled === false);
}

// ───────────────────────── 与 getEntry 的接线 ─────────────────────────

/**
 * 拼一个能跑 getEntry 的最小世界：假 sessionController + 假 tools 服务 + 可控归档集合。
 * createSawArchived 记录「create 被调用那一刻该会话是否还在归档里」——这是本文件的核心断言。
 */
function makeWorld(opts) {
  const o = opts || {};
  const archived = Array.isArray(o.archived) ? o.archived.slice() : [];
  const unarchiveCalls = [];
  const createCalls = [];
  const world = { createSawArchived: null };
  const registry = {
    get archivedSessionIds() { return archived.slice(); },
    async unarchiveSession(sessionId) {
      unarchiveCalls.push(String(sessionId));
      const idx = archived.indexOf(String(sessionId));
      if (idx >= 0) archived.splice(idx, 1);
    },
  };
  const archiveApi = createSessionArchive({ ctx: ctxOf(registry) });
  // 假的 tools 服务：够 createSession 装访客闸与编排工具接管用。
  const toolsService = {
    guard() { return () => {}; },
    get() { return undefined; },
    register() {},
    restrict() {},
  };
  const ctx = {
    reflect: { get: (name) => (name === 'workspaceRegistry' ? registry : undefined) },
    get: () => undefined,
    effect() {},
    timeout() { return 0; },
    sessionController: {
      async create(request) {
        createCalls.push(request);
        world.createSawArchived = archived.includes(String(request.sessionId));
      },
      async resolveAgent(sessionId) {
        return { agent: { id: sessionId, session: {}, ctx: { get: () => toolsService } } };
      },
    },
  };
  const cfg = () => ({
    auth: { ownerPreset: '', guestPreset: '', guestToolAllow: [] },
    agentPreset: 'standard',
    session: { fixedName: true, recallArchived: o.recallArchived !== false },
    flowAuth: { enabled: false },
    perChatSession: true,
  });
  const session = createSession({
    getConfig: cfg,
    ctx,
    state: { convos: new Map(), stats: {} },
    ensureQqMsgWorkspace: async () => ({ id: 'ws-1', path: '/tmp/qqmsg' }),
    ensureSessionWorkspace: async () => ({ id: null, path: '/tmp/qqmsg/s1' }),
    sessionWorkdir: () => '/tmp/qqmsg/s1',
    callAdapterAction: async () => ({ ok: false }),
    describeError: (error) => String((error && error.message) || error),
    isOwner: () => true,
    flowGate: null,
    archiveApi,
  });
  return { session, archived, unarchiveCalls, createCalls, world };
}

{
  const w = makeWorld({ archived: ['qqbot-group-9'] });
  await quiet(() => w.session.getEntry('group-9', 'qqbot-group-9', 'standard', null));
  check('归档会话在 create 之前已被召回', w.world.createSawArchived === false);
  check('召回恰好一次', w.unarchiveCalls.length === 1 && w.unarchiveCalls[0] === 'qqbot-group-9');
  check('会话照常建出来', w.createCalls.length === 1);
}

{
  const w = makeWorld({ archived: [] });
  await quiet(() => w.session.getEntry('group-10', 'qqbot-group-10', 'standard', null));
  check('未归档的会话不触发召回', w.unarchiveCalls.length === 0);
  check('未归档的会话照常建', w.createCalls.length === 1);
}

{
  // 已有条目（agent 还活着）也可能被归档：这一步是新消息能不能继续跑的关键。
  const w = makeWorld({ archived: [] });
  await quiet(() => w.session.getEntry('group-11', 'qqbot-group-11', 'standard', null));
  w.archived.push('qqbot-group-11');   // 模拟主人在 DSH 侧手动归档
  await quiet(() => w.session.getEntry('group-11', 'qqbot-group-11', 'standard', null));
  check('已有条目被归档后，下一条消息把它召回', w.unarchiveCalls.length === 1);
  check('已有条目不会重复建会话', w.createCalls.length === 1);
}

{
  // 开关关闭：一切都照旧（不召回），但不能崩。
  const w = makeWorld({ archived: ['qqbot-group-12'], recallArchived: false });
  await quiet(() => w.session.getEntry('group-12', 'qqbot-group-12', 'standard', null));
  check('开关关闭时不召回', w.unarchiveCalls.length === 0);
  check('开关关闭时仍能建会话', w.createCalls.length === 1);
}

{
  // 竞态回归：两条并发消息到达同一会话，只能建一次会话。
  // 召回必须放进 ready 链里——若放在 getEntry 开头 await，get/set 之间出现空档，
  // 两条消息会各自发现「没有条目」、各建一次。
  const w = makeWorld({ archived: ['qqbot-group-13'] });
  await quiet(() => Promise.all([
    w.session.getEntry('group-13', 'qqbot-group-13', 'standard', null),
    w.session.getEntry('group-13', 'qqbot-group-13', 'standard', null),
  ]));
  check('并发两条消息只建一次会话', w.createCalls.length === 1);
}

{
  // 老宿主（没有 unarchiveSession）也不能挡住消息。
  const archived = ['qqbot-group-14'];
  const ctx = { reflect: { get: () => ({ get archivedSessionIds() { return archived.slice(); } }) }, get: () => undefined, effect() {}, timeout() { return 0; } };
  let created = 0;
  ctx.sessionController = {
    async create() { created += 1; },
    async resolveAgent(id) { return { agent: { id, session: {}, ctx: { get: () => ({ guard: () => () => {}, get: () => undefined, register() {}, restrict() {} }) } } }; },
  };
  const archiveApi = createSessionArchive({ ctx });
  const session = createSession({
    getConfig: () => ({
      auth: { ownerPreset: '', guestPreset: '', guestToolAllow: [] },
      agentPreset: 'standard', session: { fixedName: true, recallArchived: true },
      flowAuth: { enabled: false }, perChatSession: true,
    }),
    ctx,
    state: { convos: new Map(), stats: {} },
    ensureQqMsgWorkspace: async () => ({ id: 'ws-1', path: '/tmp/qqmsg' }),
    ensureSessionWorkspace: async () => ({ id: null, path: '/tmp/qqmsg/s1' }),
    sessionWorkdir: () => '/tmp/qqmsg/s1',
    callAdapterAction: async () => ({ ok: false }),
    describeError: (error) => String((error && error.message) || error),
    isOwner: () => true,
    flowGate: null,
    archiveApi,
  });
  await quiet(() => session.getEntry('group-14', 'qqbot-group-14', 'standard', null));
  check('老宿主上召回静默跳过、会话照建', created === 1);
}

console.log('\n' + pass + '/' + (pass + fail) + ' 项通过');
if (fail > 0) { console.log('会话归档召回自测失败'); process.exit(1); }
console.log('会话归档召回自测通过');
