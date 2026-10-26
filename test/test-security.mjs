// 安全回归：协议帧 id 净化 / 越界删除复核 / 跨群权限重算 / 私聊判定用回合快照 / 撤回绑群
// 跑法：node test/test-security.mjs
import assert from 'node:assert';
import { safeSessionId, sessionWorkdir, imageCacheDir, isInside, qqMsgRootSync } from '../lib/workspace.js';
import { resolveTargetAuthority, createAdmin } from '../lib/admin.js';
import { checkCaller } from '../lib/owner-settings.js';
import { assertPublicHost, publicFetch, multiEngineRequest, MAX_FETCH_BYTES } from '../lib/http.js';

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
console.log('\n' + pass + '/' + (pass + fails.length) + ' 项通过');
if (fails.length > 0) { console.log('安全回归失败：' + fails.join('; ')); process.exit(1); }
console.log('安全回归通过');
