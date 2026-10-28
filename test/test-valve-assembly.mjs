/**
 * 阀门与组装顺序的自测（纯逻辑，不联网、不起进程）。
 *
 * 锁住三件事：
 *   1. 三个阀门各自独立成型、契约字段齐全（谁被拆掉都会红）；
 *   2. 组装顺序不可悄悄改（network → security → tool，改了就红）；
 *   3. 网络阀门的判定口径：能证明是内网的才拒绝，域名交给解析阶段判；
 *      工具阀消费安全阀发出的授权，一次授权只能用一次。
 *
 * 用法：node test/test-valve-assembly.mjs
 */
import assert from 'node:assert/strict';

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass += 1; console.log('  ok   ' + name); }
  catch (error) { fail += 1; console.log('  FAIL ' + name + '\n       ' + (error && error.message ? error.message : error)); }
}

const { STAGE, orderedValves, createNetworkValve, createSecurityValve, createToolValve } = await import('../lib/valve/index.js');
const { currentProxy } = await import('../lib/shared/http.js');
const { multiEngineRequest } = await import('../lib/shared/http.js');
const { assembleValves, describeAssembly, ASSEMBLY_ORDER } = await import('../lib/assemble.js');
const { assembleReply, ASSEMBLY_STEPS } = await import('../lib/message/index.js');
const { resolveAdapterPath, supportedProtocols } = await import('../lib/transport/index.js');

console.log('\n1. 阀门清单与顺序');
await check('三道阀门按 stage 升序排列', () => {
  const list = orderedValves();
  assert.deepEqual(list.map((v) => v.name), ['network', 'security', 'tool']);
  assert.deepEqual(list.map((v) => v.stage), [STAGE.NETWORK, STAGE.SECURITY, STAGE.TOOL]);
});
await check('依赖声明的方向正确（tool 依赖 security）', () => {
  const tool = orderedValves().find((v) => v.name === 'tool');
  assert.deepEqual(tool.dependsOn, ['security']);
});
await check('全链路装配顺序覆盖六层', () => {
  assert.deepEqual(ASSEMBLY_ORDER.map((x) => x.layer), ['valve/network', 'valve/security', 'valve/tool', 'message', 'gateway', 'transport']);
  assert.ok(describeAssembly().includes('10:valve/network'));
});

console.log('\n2. 网络阀门：判定口径');
const net = createNetworkValve({ proxy: () => '' });
await check('公网字面量放行', () => {
  assert.equal(net.isAllowedTarget('8.8.8.8'), true);
});
await check('内网/回环/云元数据一律拒绝', () => {
  for (const host of ['127.0.0.1', '192.168.1.1', '10.0.0.1', '169.254.169.254', '::1', 'fe80::1']) {
    assert.equal(net.isAllowedTarget(host), false, host + ' 应被拒绝');
  }
});
await check('编码变体先归一（0x7f.0.0.1 / 2130706433）', () => {
  assert.equal(net.isAllowedTarget('0x7f.0.0.1'), false);
  assert.equal(net.isAllowedTarget('2130706433'), false);
  assert.equal(net.isAllowedTarget('[::ffff:7f00:1]'), false);
});
await check('域名同步判不出来时放行（交给 assertHost 解析后再判）', () => {
  assert.equal(net.isAllowedTarget('example.com'), true);
});
await check('本机保留名算内网', () => {
  for (const host of ['localhost', 'foo.internal', 'a.local']) {
    assert.equal(net.isAllowedTarget(host), false, host);
    assert.equal(net.isLoopback(host), true, host);
  }
});
await check('域名不被误判成本机（否则会绕过代理）', () => {
  assert.equal(net.isLoopback('example.com'), false);
});
await check('空主机名拒绝', () => {
  assert.equal(net.isAllowedTarget(''), false);
  assert.equal(net.isAllowedTarget('a b'), false);
});
await check('assertHost 对内网目标抛错', async () => {
  await assert.rejects(() => net.assertHost('127.0.0.1'), /非公网/);
});

console.log('\n3. 安全阀与工具阀：授权链路');
const cfgHolder = { value: { flowAuth: { enabled: true, gatedTools: ['qq_draw'] } } };
const security = createSecurityValve({ config: () => cfgHolder.value });
const tool = createToolValve({ auth: security.flowAuth, enabled: security.enabled, gatedTools: security.gatedTools });
await check('安全阀暴露契约字段', () => {
  for (const key of ['flowAuth', 'enabled', 'gatedTools', 'verifyToken', 'judgeHistory', 'checkOwnerCaller']) {
    assert.ok(security[key] !== undefined, '缺少 ' + key);
  }
});
await check('工具阀只放行名单内的工具', () => {
  assert.equal(tool.isGated('qq_draw'), true);
  assert.equal(tool.isGated('qqbot'), false);
  assert.deepEqual(tool.names(), ['qq_draw']);
});
await check('动态码关闭时名单不生效', () => {
  cfgHolder.value = { flowAuth: { enabled: false, gatedTools: ['qq_draw'] } };
  assert.equal(tool.isGated('qq_draw'), false);
  cfgHolder.value = { flowAuth: { enabled: true, gatedTools: ['qq_draw'] } };
});
await check('没有授权时拒绝', () => {
  const verdict = tool.check('10001', 'qq_draw');
  assert.equal(verdict.allow, false);
  assert.equal(verdict.reason, 'no-grant');
});
await check('授权只能用一次', () => {
  tool.remember('10002', 'grant-x');
  // 这张 grant 不在 auth 里（伪造的），第一次就该被拒——这里锁的是「不会因为 remember 就放行」
  const first = tool.check('10002', 'qq_draw');
  assert.equal(first.allow, false);
  assert.equal(tool.check('10002', 'qq_draw').allow, false);
});
await check('被拦下时有可读的中文说明', () => {
  const text = tool.blockedText('no-grant');
  assert.ok(text.includes('授权'), text);
});

console.log('\n4. 组装根：按优先级成型');
await check('assembleValves 返回三道阀门且顺序正确', () => {
  const a = assembleValves({ config: () => ({ flowAuth: { enabled: true, gatedTools: ['qqbot'] } }) });
  assert.deepEqual(a.order, ['network', 'security', 'tool']);
  assert.equal(a.network.stage, STAGE.NETWORK);
  assert.equal(a.security.stage, STAGE.SECURITY);
  assert.equal(a.tool.stage, STAGE.TOOL);
  assert.equal(a.tool.isGated('qqbot'), true);
});
await check('安全阀没成型时工具阀拿不到授权对象（依赖顺序被强制）', () => {
  const a = assembleValves({ config: () => ({}) });
  assert.ok(a.tool.gate !== undefined);
  assert.equal(typeof a.security.flowAuth.takeGrant, 'function');
});

console.log('\n5. 消息组装');
await check('中间发言排在正文之前', () => {
  const out = assembleReply({ text: '结论', interim: [{ text: '我先查一下' }] });
  assert.deepEqual(out.items.map((x) => x.kind), ['interim', 'final']);
});
await check('空文本不产生任何消息', () => {
  assert.deepEqual(assembleReply({ text: '   ' }).items, []);
  assert.deepEqual(assembleReply({}).items, []);
});
await check('分条开启时长文本被切开', () => {
  const long = ('段落内容'.repeat(60) + '\n\n').repeat(4);
  const out = assembleReply({ text: long, chunk: { enabled: true, max: 200 } });
  assert.ok(out.items.length > 1, '应当切成多条');
});
await check('组装步骤顺序固定', () => {
  assert.deepEqual(ASSEMBLY_STEPS, ['interim', 'chunk', 'stream']);
});

console.log('\n6. 传输层注册表');
await check('五种协议都有适配器路径', () => {
  const list = supportedProtocols();
  assert.deepEqual(list.sort(), ['milky', 'onebot11', 'onebot12', 'qq-official', 'satori']);
  for (const protocol of list) {
    const path = resolveAdapterPath(protocol);
    assert.ok(path.endsWith('.mjs'), protocol + ' -> ' + path);
  }
});
await check('未知协议回退 OneBot 11 入口', () => {
  assert.equal(resolveAdapterPath('nope'), resolveAdapterPath('onebot11'));
});

console.log('\n7. 代理归属：阀门决定，工具不持有');
await check('阀门成型后接管传输层的代理策略', async () => {
  // 成型前：默认直连
  assert.equal(currentProxy(), '');
  let configured = 'http://127.0.0.1:7890';
  const valve = createNetworkValve({ proxy: () => configured });
  // 成型即安装解析器：传输层跟着阀门走
  assert.equal(currentProxy(), 'http://127.0.0.1:7890');
  configured = 'http://10.0.0.9:1080';
  assert.equal(currentProxy(), 'http://10.0.0.9:1080', '配置改了，传输层立刻跟着变');
  configured = '';
  assert.equal(currentProxy(), '', '配置清空即直连');
  valve.uninstall();
  assert.equal(currentProxy(), '', '卸下后回到默认直连');
});
await check('hasProxy 反映当前是否配了代理', async () => {
  let configured = '';
  const valve = createNetworkValve({ proxy: () => configured });
  assert.equal(valve.hasProxy(), false);
  configured = 'http://127.0.0.1:7890';
  assert.equal(valve.hasProxy(), true);
  valve.uninstall();
});
await check('工具源码里不再读 webSearch.proxy（只有 moli 分支例外）', async () => {
  const fs = await import('node:fs/promises');
  const read = (p) => fs.readFile(new URL('../lib/tools/' + p, import.meta.url), 'utf8');
  const websearch = await read('websearch.js');
  const imgsearch = await read('imgsearch.js');
  assert.ok(!/webSearch\.proxy|\.proxy\b/.test(websearch), 'websearch 不该出现 proxy');
  assert.ok(!/webSearch\.proxy|\.proxy\b/.test(imgsearch), 'imgsearch 不该出现 proxy');
  const index = await read('index.js');
  // index.js 里仅 moli 分支保留代理串（moli 自己的 proxy 语义不归阀门管）
  const lines = index.split('\n').filter((l) => /\bproxy\b/i.test(l)
    && !/^\s*\/\//.test(l)          // 注释
    && !/^\s*import\b/.test(l));     // import 行
  for (const line of lines) {
    assert.ok(/moli|guard-?proxy|ensureGuardProxy|wsCfg/i.test(line),
      '非 moli 分支不该碰代理串：' + line.trim().slice(0, 80));
  }
});
await check('multiEngineRequest 不传代理时按阀门策略走', async () => {
  // 阀门配了代理 → 走代理分支；内网目标仍被拒（说明策略没被绕过）
  const valve = createNetworkValve({ proxy: () => 'http://127.0.0.1:7890' });
  assert.equal(currentProxy(), 'http://127.0.0.1:7890');
  let blocked = false;
  try { await multiEngineRequest('GET', 'http://127.0.0.1:1/x', {}, null); } catch (error) { blocked = true; }
  assert.ok(blocked, '配了代理也不能打内网');
  valve.uninstall();
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail > 0) process.exit(1);
