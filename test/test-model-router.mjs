#!/usr/bin/env node
/**
 * 模型路由自动检测自测：`node test-model-router.mjs`
 *
 * 守的是「有现成机制就用现成的」：
 *   - agentDefaultModel 可读可写 → 用它（saveSelection）；
 *   - 只有 llm → 能列（listProviders/listModels），不能写（如实 applied=false + 落到偏好）；
 *   - 都没有 → 不假装，给明确错误；
 *   - 偏好文件读写（官方插件那套 fallback）。
 */
import { createModelRouter, createPrefsFile } from '../lib/model-router.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail === '' ? '' : ' — ' + detail)); }
}

function makeFs(initial = null) {
  const store = { content: initial };
  return {
    readFileSync: () => { if (store.content === null) throw new Error('ENOENT'); return store.content; },
    writeFileSync: (_file, text) => { store.content = text; },
    dump: () => store.content,
  };
}

console.log('1. 检测优先级：agentDefaultModel > llm > none');
{
  const adm = { currentSelection: () => ({ provider: 'p1', model: 'm1' }), saveSelection: () => {} };
  const llm = { listProviders: () => [{ id: 'p1' }], listModels: async () => [{ id: 'm1' }] };
  const router = createModelRouter({ getService: (id) => (id === 'agentDefaultModel' ? adm : (id === 'llm' ? llm : undefined)) });
  check('有 agentDefaultModel 就选它', router.detect().kind === 'agent-default-model');
  check('currentSelection 透传', router.currentSelection().provider === 'p1' && router.currentSelection().model === 'm1');
  const llmOnly = createModelRouter({ getService: (id) => (id === 'llm' ? llm : undefined) });
  check('没有 agentDefaultModel 退到 llm（只读）', llmOnly.detect().kind === 'llm-readonly');
  const none = createModelRouter({ getService: () => undefined });
  check('都没有就是 none', none.detect().kind === 'none');
}

console.log('2. 写：有 native 接口就走 saveSelection');
{
  const calls = [];
  const adm = { currentSelection: () => null, saveSelection: (route) => calls.push(route) };
  const router = createModelRouter({ getService: (id) => (id === 'agentDefaultModel' ? adm : undefined) });
  const r = await router.setDefault({ provider: 'p1', model: 'm1' });
  check('applied=true 且调用了 saveSelection', r.ok === true && r.applied === true && calls.length === 1, JSON.stringify(r));
  check('route 原样透传', calls[0].provider === 'p1' && calls[0].model === 'm1', JSON.stringify(calls[0]));
  const bad = await router.setDefault({ provider: '', model: 'm1' });
  check('空 provider 被拒', bad.ok === false && String(bad.error).includes('不能为空'));
}

console.log('3. 只有 llm：能列不能写（如实报告并落偏好）');
{
  const llm = { listProviders: () => ['p1', 'p2'], listModels: async () => ['a', 'b'] };
  const prefsStore = {};
  const prefs = { get: (k) => prefsStore[k] ?? null, set: (k, v) => { prefsStore[k] = v; }, remove: (k) => { delete prefsStore[k]; } };
  const router = createModelRouter({ getService: (id) => (id === 'llm' ? llm : undefined), prefs });
  const providers = await router.listProviders();
  check('provider 列表可用', providers.length === 2 && providers[0].id === 'p1', JSON.stringify(providers));
  const models = await router.listModels('p1');
  check('模型列表可用', models.length === 2 && models[1].id === 'b', JSON.stringify(models));
  const r = await router.setDefault({ provider: 'p1', model: 'a' }, 'private-u1');
  check('写不进去时 applied=false 并记录偏好', r.ok === true && r.applied === false && prefsStore['private-u1'].model === 'a', JSON.stringify(r));
}

console.log('4. 都没有：不假装能写');
{
  const router = createModelRouter({ getService: () => undefined });
  const r = await router.setDefault({ provider: 'p1', model: 'm1' }, 'k');
  check('返回 ok=false 且说明没有接口', r.ok === false && String(r.error).includes('没有可写模型接口'), JSON.stringify(r));
  check('列模型返回空', (await router.listModels('p1')).length === 0);
}

console.log('5. 偏好文件（官方插件那套 fallback）');
{
  const fsStub = makeFs('{"overrides":{"g1":{"provider":"p1","model":"m1"}}}');
  const prefs = createPrefsFile({ file: 'x.json', fs: fsStub });
  check('读已有偏好', prefs.get('g1').model === 'm1', JSON.stringify(prefs.get('g1')));
  prefs.set('g2', { provider: 'p2', model: 'm2' });
  check('写入后能读回', prefs.get('g2').provider === 'p2');
  check('落盘内容是 JSON', String(fsStub.dump()).includes('"g2"'));
  prefs.remove('g1');
  check('删除生效', prefs.get('g1') === null);
  const broken = createPrefsFile({ file: 'y.json', fs: makeFs('not json') });
  check('坏文件当空处理', broken.all() !== null && Object.keys(broken.all()).length === 0);
}

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail > 0) process.exitCode = 1;
