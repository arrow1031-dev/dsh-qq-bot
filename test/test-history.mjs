// qq_history 的会话定向 / 鉴权 / 请求构造 / 归一化。
import {
  currentConversationOf, resolveHistoryTarget,
  judgeHistoryAccess, buildHistoryRequest, normalizeHistory,
} from '../lib/valve/security/history-auth.js';

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail === undefined ? '' : ' -> ' + detail)); }
}
const perms = (...items) => new Set(items);
const owner = { owner: true, tier: 'owner', perms: perms('query') };
const superAdmin = { owner: false, tier: 'super', perms: perms('query') };
const groupAdmin = { owner: false, tier: 'group-admin', perms: perms('query', 'mute') };
const guest = { owner: false, tier: 'guest', perms: perms() };

const frameGroup = { group_id: 33333, user_id: 22222, message_id: 9001 };
check('currentConversationOf 群取 frame.group_id', JSON.stringify(currentConversationOf({ groupId: '33333' }, frameGroup)) === JSON.stringify({ kind: 'group', id: '33333' }));
const framePrivate = { user_id: 22222, message_id: 9002 };
check('currentConversationOf 私聊取 user_id', JSON.stringify(currentConversationOf({ groupId: null, userId: '22222' }, framePrivate)) === JSON.stringify({ kind: 'private', id: '22222' }));

const cur = { kind: 'group', id: '33333' };
check('resolveHistoryTarget 默认当前会话', JSON.stringify(resolveHistoryTarget({ argGroup: '', argPeer: '', current: cur }).target) === JSON.stringify(cur));
check('resolveHistoryTarget 指定群', JSON.stringify(resolveHistoryTarget({ argGroup: '44444', argPeer: '', current: cur }).target) === JSON.stringify({ kind: 'group', id: '44444' }));
check('resolveHistoryTarget 指定私聊', JSON.stringify(resolveHistoryTarget({ argGroup: '', argPeer: '55555', current: cur }).target) === JSON.stringify({ kind: 'private', id: '55555' }));
check('resolveHistoryTarget 两个都传报错', typeof resolveHistoryTarget({ argGroup: '1', argPeer: '2', current: cur }).error === 'string');

const sameGroup = judgeHistoryAccess({ target: { kind: 'group', id: '33333' }, current: cur, authority: guest, withinScope: false });
check('当前群：访客也允许', sameGroup.allowed === true && sameGroup.scope === 'current');
const crossOwner = judgeHistoryAccess({ target: { kind: 'group', id: '44444' }, current: cur, authority: owner, withinScope: true });
check('跨群：拥有者允许', crossOwner.allowed === true && crossOwner.reason === '拥有者');
const crossSuper = judgeHistoryAccess({ target: { kind: 'group', id: '44444' }, current: cur, authority: superAdmin, withinScope: true });
check('跨群：高级管理员允许', crossSuper.allowed === true);
const crossAdmin = judgeHistoryAccess({ target: { kind: 'group', id: '44444' }, current: cur, authority: guest, targetAuthority: groupAdmin, withinScope: true });
check('跨群：目标群管理员允许（范围重合）', crossAdmin.allowed === true && crossAdmin.scope === 'group');
const crossAdminOut = judgeHistoryAccess({ target: { kind: 'group', id: '44444' }, current: cur, authority: guest, targetAuthority: groupAdmin, withinScope: false });
check('跨群：目标群管理员但不在可管理范围 -> 拒绝', crossAdminOut.allowed === false && crossAdminOut.reason.includes('可管理'));
const crossMember = judgeHistoryAccess({ target: { kind: 'group', id: '44444' }, current: cur, authority: guest, targetAuthority: guest, withinScope: true });
check('跨群：普通成员拒绝', crossMember.allowed === false);
const otherPrivate = judgeHistoryAccess({ target: { kind: 'private', id: '55555' }, current: cur, authority: guest, withinScope: true });
check('其他私聊：普通成员拒绝', otherPrivate.allowed === false && otherPrivate.scope === 'private');
const otherPrivateOwner = judgeHistoryAccess({ target: { kind: 'private', id: '55555' }, current: cur, authority: owner, withinScope: true });
check('其他私聊：拥有者允许', otherPrivateOwner.allowed === true);
const ownPrivate = judgeHistoryAccess({ target: { kind: 'private', id: '22222' }, current: { kind: 'private', id: '22222' }, authority: guest, withinScope: true });
check('自己的私聊：允许', ownPrivate.allowed === true && ownPrivate.scope === 'current');

const reqLatest = buildHistoryRequest({ target: { kind: 'group', id: '33333' }, count: 20, beforeSeq: NaN, anchorId: 9001 });
check('群聊最新页：不带 message_seq', reqLatest.action === 'get_group_msg_history' && reqLatest.params.count === 20 && reqLatest.params.message_seq === undefined && reqLatest.paged === false);
const reqPaged = buildHistoryRequest({ target: { kind: 'group', id: '33333' }, count: 30, beforeSeq: 12345, anchorId: 9001 });
check('群聊分页：带 message_seq + reverseOrder', reqPaged.params.message_seq === 12345 && reqPaged.params.reverseOrder === true && reqPaged.paged === true);
const reqPrivate = buildHistoryRequest({ target: { kind: 'private', id: '22222' }, count: 10, beforeSeq: NaN, anchorId: 9002 });
check('私聊：用锚点消息拉历史', reqPrivate.action === 'get_friend_msg_history' && reqPrivate.params.user_id === 22222 && reqPrivate.params.message_seq === 9002);
const reqPrivateNoAnchor = buildHistoryRequest({ target: { kind: 'private', id: '22222' }, count: 10, beforeSeq: NaN, anchorId: NaN });
check('私聊：没有锚点给明确错误', typeof reqPrivateNoAnchor.error === 'string' && reqPrivateNoAnchor.error.includes('锚点'));

const norm = normalizeHistory([{ message_id: 1, text: 'a' }, { message_id: 2, text: 'b' }, { message_id: 1, text: 'dup' }], true);
check('normalizeHistory：升序转新→旧并去重', norm.length === 2 && norm[0].message_id === 2 && norm[1].message_id === 1);

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
