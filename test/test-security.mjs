// 安全回归：协议帧 id 净化 / 越界删除复核 / 跨群权限重算 / 私聊判定用回合快照 / 撤回绑群
// 跑法：node test/test-security.mjs
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { safeSessionId, sessionWorkdir, imageCacheDir, isInside, qqMsgRootSync } from '../lib/workspace.js';
import { resolveTargetAuthority, createAdmin } from '../lib/admin.js';
import { checkCaller } from '../lib/owner-settings.js';
import { assertPublicHost, publicFetch, multiEngineRequest, pinnedLookup, isNonPublicIp, canonicalHost, __setNetworkHooks, MAX_FETCH_BYTES } from '../lib/http.js';
import { resolveListenAddress, tokenEquals, decodeFrames } from '../lib/bridge/ws.mjs';

let pass = 0;
const fails = [];
async function check(name, fn) {
  try { await fn(); pass += 1; console.log('  ok   ' + name); }
  catch (error) { fails.push(name); console.log('  FAIL ' + name + ' — ' + (error && error.message ? error.message : String(error))); }
}

console.log('\n1. safeSessionId：外部 id 不能拼出越界路径');
await check('数字 id 原样保留', () => assert.strictEqual(safeSessionId('qqbot-group-123456'), 'qqbot-group-123456'));
await check('带 /.. 的 id 被哈希化', () => {
  const got = safeSessionId('qqbot-group-/../../../evil');
  assert.match(got, /^sess-[0-9a-f]{12}$/);
  assert.ok(!got.includes('/') && !got.includes('..'));
});
await check('带 Windows 分隔符的 id 被哈希化', () => assert.match(safeSessionId('qqbot-group-..\\..\\..\\x'), /^sess-[0-9a-f]{12}$/));
await check('超长 id 被哈希化', () => assert.match(safeSessionId('a'.repeat(200)), /^sess-[0-9a-f]{12}$/));
await check('空 id 也不抛', () => assert.strictEqual(typeof safeSessionId(undefined), 'string'));
await check('sessionWorkdir 恒在 QQ_msg 之下', () => {
  const dir = sessionWorkdir('qqbot-group-/../../../evil');
  assert.ok(isInside(qqMsgRootSync(), dir), dir);
});
await check('imageCacheDir 恒在 QQ_msg/qq-images 之下', () => {
  const dir = imageCacheDir('qqbot-group-/../../../evil');
  assert.ok(isInside(qqMsgRootSync(), dir), dir);
  assert.ok(dir.includes('qq-images'), dir);
});

console.log('\n2. isInside：删除前复核');
await check('子目录算在内', () => assert.strictEqual(isInside('/a/qq-images', '/a/qq-images/s1'), true));
await check('自身算在内', () => assert.strictEqual(isInside('/a/qq-images', '/a/qq-images'), true));
await check('父目录不算', () => assert.strictEqual(isInside('/a/qq-images', '/a'), false));
await check('越界路径不算', () => assert.strictEqual(isInside('/a/qq-images', '/a/evil'), false));
await check('前缀相近但不相同不算', () => assert.strictEqual(isInside('/a/qq-images', '/a/qq-imagesx'), false));

console.log('\n3. resolveTargetAuthority：跨群动作按目标群重算');
const speakerA = { userId: '100', groupId: '111' };
const authA = { tier: 'admin', owner: false, groupId: '111', perms: new Set(['mute', 'kick']) };
const calls = [];
const stubResolve = async (userId, groupId) => { calls.push([userId, groupId]); return { tier: 'guest', perms: new Set() }; };
await check('同群不重算', async () => {
  calls.length = 0;
  const got = await resolveTargetAuthority(authA, speakerA, '111', stubResolve);
  assert.strictEqual(got, authA);
  assert.deepStrictEqual(calls, []);
});
await check('异群按目标群重算', async () => {
  calls.length = 0;
  const got = await resolveTargetAuthority(authA, speakerA, '999', stubResolve);
  assert.deepStrictEqual(calls, [['100', '999']]);
  assert.strictEqual(got.tier, 'guest');
});
await check('没有目标群时不重算', async () => {
  calls.length = 0;
  const got = await resolveTargetAuthority(authA, speakerA, null, stubResolve);
  assert.strictEqual(got, authA);
  assert.deepStrictEqual(calls, []);
});
await check('私聊说话人遇目标群时也按目标群重算', async () => {
  calls.length = 0;
  await resolveTargetAuthority(authA, { userId: '100', groupId: null }, '999', stubResolve);
  assert.deepStrictEqual(calls, [['100', '999']]);
});

console.log('\n4. checkCaller：私聊判定必须读回合快照');
const cfgOk = { auth: { ownerSettings: true, owners: ['100'] } };
await check('群回合（快照有 groupId）即便 entry.groupId 被冲成 null，也拒绝', () => {
  const entry = { turnSpeaker: { userId: '100', groupId: '111' }, groupId: null, speaker: { userId: '100', groupId: null } };
  const r = checkCaller(cfgOk, entry);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'not-private');
});
await check('真私聊（快照无 groupId）放行', () => {
  const r = checkCaller(cfgOk, { turnSpeaker: { userId: '100', groupId: null }, groupId: null });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.ownerId, '100');
});
await check('非拥有者一律拒绝', () => {
  assert.strictEqual(checkCaller(cfgOk, { turnSpeaker: { userId: '200', groupId: null }, groupId: null }).code, 'not-owner');
});

console.log('\n5. /recall 必须绑定本群');
async function runRecall(getMsgGroup) {
  const replies = [];
  const actions = [];
  const cfg = { admin: { enabled: true, dryRun: false, requireGroupAdmin: false, manageGroups: [], allowConsole: false, prefix: '/' }, auth: { owners: ['100'], superAdmins: [] }, group: { allow: [] }, private: { allow: [] } };
  const admin = createAdmin({
    getConfig: () => cfg,
    callAdapterAction: async (action, params) => {
      actions.push([action, params]);
      if (action === 'get_msg') return { ok: true, data: { group_id: getMsgGroup, message: [] } };
      return { ok: true, data: null };
    },
    sendReply: (frame, text) => { replies.push(text); },
    state: { stats: { admin: 0 } },
  });
  const frame = { user_id: 100, group_id: 111, reply_to: null, message_type: 'group' };
  const handled = await admin.handleAdminCommand(frame, '/recall 555');
  return { replies, actions, handled };
}
await check('撤回别群消息被拒', async () => {
  const r = await runRecall(999);
  assert.ok(r.replies.some((t) => String(t).includes('只能撤回本群消息')), JSON.stringify(r.replies));
  assert.ok(!r.actions.some(([a]) => a === 'delete_msg'), '不应真的发 delete_msg');
});
await check('撤回本群消息放行', async () => {
  const r = await runRecall(111);
  assert.ok(r.actions.some(([a, p]) => a === 'delete_msg' && p.message_id === 555), JSON.stringify(r.actions));
});


console.log('\\n6. 出站抓取只允许公网（publicFetch / multiEngineRequest）');
await check('assertPublicHost 拒绝回环', async () => { await assert.rejects(() => assertPublicHost('127.0.0.1')); });
await check('assertPublicHost 拒绝链路本地（云元数据）', async () => { await assert.rejects(() => assertPublicHost('169.254.169.254')); });
await check('assertPublicHost 拒绝内网段', async () => { await assert.rejects(() => assertPublicHost('10.1.2.3')); });
await check('publicFetch 拒绝回环', async () => { await assert.rejects(() => publicFetch('http://127.0.0.1:1/')); });
await check('publicFetch 拒绝非 http(s)', async () => { await assert.rejects(() => publicFetch('file:///etc/passwd')); });
await check('multiEngineRequest 直连分支拒绝内网', async () => { await assert.rejects(() => multiEngineRequest('GET', 'http://127.0.0.1:1/x', {}, null, '')); });
await check('响应体上限是 8MB', () => assert.strictEqual(MAX_FETCH_BYTES, 8 * 1024 * 1024));

console.log('\n6b. 地址判定只有一条事实来源：URL 解析器归一后的写法（F1）');
// 教训：只看「::ffff: + 点分 IPv4」时，WHATWG URL 把 [::ffff:127.0.0.1] 规范化成 [::ffff:7f00:1]，
// 于是这类写法全被判成公网，上面四条出站防线一起被绕过。
await check('URL 会把映射地址改写成十六进制组', () => {
  assert.strictEqual(new URL('http://[::ffff:127.0.0.1]/').hostname, '[::ffff:7f00:1]');
  assert.strictEqual(new URL('http://0177.0.0.1/').hostname, '127.0.0.1');
  assert.strictEqual(new URL('http://2130706433/').hostname, '127.0.0.1');
});
await check('映射地址的十/八/十六进制与短写都被判非公网', () => {
  for (const ip of ['::ffff:7f00:1', '::ffff:0:7f00:1', '::ffff:a00:1', '::ffff:c0a8:101', '::ffff:a9fe:a9fe',
    '127.1', '0177.0.0.1', '0x7f.0.0.1', '2130706433', '0x7f000001']) {
    assert.strictEqual(isNonPublicIp(ip), true, ip + ' 应判非公网');
  }
});
await check('publicFetch 拒绝各种写法的回环', async () => {
  for (const url of ['http://[::ffff:127.0.0.1]:1/', 'http://0177.0.0.1:1/', 'http://2130706433:1/',
    'http://[0:0:0:0:0:ffff:7f00:1]:1/', 'http://127.1:1/']) {
    await assert.rejects(() => publicFetch(url), url + ' 应被拒');
  }
});
await check('assertPublicHost 拒绝映射内网与云元数据', async () => {
  for (const host of ['[::ffff:a00:1]', '[::ffff:c0a8:101]', '[::ffff:a9fe:a9fe]', '::ffff:169.254.169.254']) {
    await assert.rejects(() => assertPublicHost(host), host + ' 应被拒');
  }
});
await check('公网映射地址不被误伤', async () => {
  assert.strictEqual(isNonPublicIp('::ffff:5db8:d822'), false);
  await assertPublicHost('::ffff:5db8:d822');
});
await check('非字面量一律拒绝（域名交给 DNS 分支，不在本函数放行）', () => {
  assert.strictEqual(isNonPublicIp('example.com'), true);
  assert.strictEqual(isNonPublicIp('a/../b'), true);
  assert.strictEqual(canonicalHost('a/../b'), '');
});
await check('测试网络钩子不能绕过公网判定', async () => {
  // 钩子只替换「解析」与「单次请求」，注入的解析结果仍要过 isNonPublicIp。
  __setNetworkHooks({ lookup: async () => [{ address: '127.0.0.1', family: 4 }], request: async () => ({ status: 200, body: 'x' }) });
  try {
    await assert.rejects(() => publicFetch('http://hooktest.example/'), /非公网/);
  } finally {
    __setNetworkHooks(null);
  }
});
await check('pinnedLookup 只返回已校验地址（防 rebinding）', () => {
  const lookup = pinnedLookup([{ address: '93.184.216.34', family: 4 }, { address: '2001:db8::1', family: 6 }]);
  const v4 = [];
  const v6 = [];
  const all = [];
  lookup('example.com', { family: 4, all: false }, (error, address, family) => v4.push([error, address, family]));
  lookup('example.com', { family: 6, all: false }, (error, address, family) => v6.push([error, address, family]));
  lookup('example.com', { family: 0, all: true }, (error, list) => all.push([error, list]));
  const none = [];
  pinnedLookup([])('example.com', { family: 0, all: false }, (error) => none.push(error));
  return v4.length === 1 && v4[0][1] === '93.184.216.34' && v4[0][2] === 4
    && v6.length === 1 && v6[0][1] === '2001:db8::1' && v6[0][2] === 6
    && all.length === 1 && Array.isArray(all[0][1]) && all[0][1].length === 2
    && none.length === 1 && none[0] instanceof Error;
});

console.log('' + String.fromCharCode(10) + '7. 反向 WS：默认只监听回环 + 恒定时间 token + 帧上限');
await check('未配 token 时 0.0.0.0 被收回到回环', () => {
  const a = resolveListenAddress('0.0.0.0:6199', false);
  assert.strictEqual(a.host, '127.0.0.1');
  assert.strictEqual(a.port, '6199');
  assert.strictEqual(a.forcedLoopback, true);
});
await check('配了 token 才允许公网监听', () => {
  const a = resolveListenAddress('0.0.0.0:6199', true);
  assert.strictEqual(a.host, '0.0.0.0');
  assert.strictEqual(a.forcedLoopback, false);
});
await check('本来就是回环的不动', () => assert.strictEqual(resolveListenAddress('127.0.0.1:6199', false).host, '127.0.0.1'));
await check('只给端口也收回到回环', () => assert.strictEqual(resolveListenAddress('6199', false).host, '127.0.0.1'));
await check('token 相等为真', () => assert.strictEqual(tokenEquals('s3cret', 's3cret'), true));
await check('token 不等为假', () => assert.strictEqual(tokenEquals('s3cret', 's3cres'), false));
await check('空 token 恒假（不允许空口令放行）', () => assert.strictEqual(tokenEquals('', ''), false));
await check('长度不同不抛', () => assert.strictEqual(tokenEquals('a', 'aaaaaaaa'), false));
function frameOf(len) {
  const head = Buffer.alloc(10);
  head[0] = 0x81;
  head[1] = 0x7f;
  head.writeBigUInt64BE(BigInt(len), 2);
  return head;
}
await check('声明超大帧被标记 oversize', () => {
  const got = decodeFrames(frameOf(1024 * 1024 * 100));
  assert.strictEqual(got.oversize, true);
});
await check('正常小帧不误判', () => {
  const payload = Buffer.from('hi');
  const head = Buffer.alloc(2);
  head[0] = 0x81; head[1] = payload.length;
  const got = decodeFrames(Buffer.concat([head, payload]));
  assert.ok(got.oversize !== true);
  assert.strictEqual(got.messages.length, 1);
});

console.log('\n8. 回归：识图下载必须走 publicFetch（#15 曾被分支重建回退过一次）');
// downloadImage 是 apply() 里的闭包，没有导出，运行期测不到；这里锁源码形状：
// 谁在旧快照上重建分支，这一条会立刻红，而不是等下次渗透测试才发现回归。
const indexSrc = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8');
function functionBody(src, signature) {
  const start = src.indexOf(signature);
  if (start < 0) return '';
  const brace = src.indexOf('{', start);
  const end = src.indexOf('\n  }', brace);
  return src.slice(start, end < 0 ? src.length : end);
}
await check('downloadImage 走 publicFetch', () => {
  const body = functionBody(indexSrc, 'async function downloadImage(');
  assert.ok(body !== '', '找不到 downloadImage（签名变了要同步改这条测试）');
  assert.ok(/publicFetch\(/.test(body), 'downloadImage 没有走 publicFetch —— #15 回归了');
});
await check('downloadImage 里没有裸 fetch', () => {
  const body = functionBody(indexSrc, 'async function downloadImage(').replace(/publicFetch\(/g, '');
  assert.ok(!/(^|[^\w.])fetch\(/.test(body), 'downloadImage 里又出现了裸 fetch —— #15 回归了');
});
await check('downloadImage 不再整包 arrayBuffer', () => {
  const body = functionBody(indexSrc, 'async function downloadImage(');
  assert.ok(!body.includes('arrayBuffer()'), 'downloadImage 又整包读入了');
});

console.log('\n' + pass + '/' + (pass + fails.length) + ' 项通过');
if (fails.length > 0) { console.log('安全回归失败：' + fails.join('; ')); process.exit(1); }
console.log('安全回归通过');
