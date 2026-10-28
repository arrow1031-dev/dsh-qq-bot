/**
 * 群管理动作表：动作 → 所需权限 / OneBot 请求构造。
 *
 * 工具（qqgroup）与 QQ 侧 / 指令两条路径都从这里取同一份知识，避免「加了动作漏了
 * 权限」这类静默降权：permission 是必填字段，缺了或拼错会在加载期报错，而不是
 * 等到线上有人敲那条指令才发现零权限检查直接执行。
 */
/** 权限档位（与 group-admin 的鉴权档一致）。 */
export const PERMISSION_LIST = ['query', 'mute', 'kick', 'recall', 'settings', 'grant'];

const toId = (value) => (/^\d+$/.test(String(value)) ? Number(value) : String(value));
const missing = (value) => value === null || value === undefined || value === '';

/**
 * 每个动作：
 *   permission  必填，PERMISSION_LIST 里的一项
 *   build(params)  params = { groupId, uid, text, enable, durationSec, messageId }
 *                  参数不足返回 null（调用方统一报「缺少必要参数」）
 */
export const GROUP_ACTIONS = {
  'group-list': {
    permission: 'query',
    build: () => ({ action: 'get_group_list', params: {} }),
  },
  'group-info': {
    permission: 'query',
    build: ({ groupId }) => (missing(groupId) ? null : { action: 'get_group_info', params: { group_id: toId(groupId) } }),
  },
  'member-list': {
    permission: 'query',
    build: ({ groupId }) => (missing(groupId) ? null : { action: 'get_group_member_list', params: { group_id: toId(groupId) } }),
  },
  'member-info': {
    permission: 'query',
    build: ({ groupId, uid }) => (missing(groupId) || missing(uid)
      ? null
      : { action: 'get_group_member_info', params: { group_id: toId(groupId), user_id: toId(uid), no_cache: true } }),
  },
  mute: {
    permission: 'mute',
    build: ({ groupId, uid, durationSec }) => (missing(groupId) || missing(uid)
      ? null
      : { action: 'set_group_ban', params: { group_id: toId(groupId), user_id: toId(uid), duration: durationSec } }),
  },
  unmute: {
    permission: 'mute',
    build: ({ groupId, uid }) => (missing(groupId) || missing(uid)
      ? null
      : { action: 'set_group_ban', params: { group_id: toId(groupId), user_id: toId(uid), duration: 0 } }),
  },
  kick: {
    permission: 'kick',
    build: ({ groupId, uid }) => (missing(groupId) || missing(uid)
      ? null
      : { action: 'set_group_kick', params: { group_id: toId(groupId), user_id: toId(uid), reject_add_request: false } }),
  },
  'whole-ban': {
    permission: 'settings',
    build: ({ groupId, enable }) => (missing(groupId)
      ? null
      : { action: 'set_group_whole_ban', params: { group_id: toId(groupId), enable: enable !== false } }),
  },
  'set-card': {
    permission: 'settings',
    build: ({ groupId, uid, text }) => (missing(groupId) || missing(uid) || typeof text !== 'string' || text === ''
      ? null
      : { action: 'set_group_card', params: { group_id: toId(groupId), user_id: toId(uid), card: text } }),
  },
  'set-admin': {
    permission: 'settings',
    build: ({ groupId, uid, enable }) => (missing(groupId) || missing(uid)
      ? null
      : { action: 'set_group_admin', params: { group_id: toId(groupId), user_id: toId(uid), enable: enable !== false } }),
  },
  rename: {
    permission: 'settings',
    build: ({ groupId, text }) => (missing(groupId) || typeof text !== 'string' || text === ''
      ? null
      : { action: 'set_group_name', params: { group_id: toId(groupId), group_name: text } }),
  },
  recall: {
    permission: 'recall',
    build: ({ messageId }) => (messageId === null || messageId === undefined
      ? null
      : { action: 'delete_msg', params: { message_id: Number(messageId) } }),
  },
  poke: {
    permission: 'query',
    build: ({ groupId, uid }) => (missing(groupId) || missing(uid)
      ? null
      : { action: 'send_group_poke', params: { group_id: toId(groupId), user_id: toId(uid) } }),
  },
};

export const GROUP_ACTION_NAMES = Object.freeze(Object.keys(GROUP_ACTIONS));

/**
 * 加载期校验：permission 必填、必须在合法档位里，build 必须是函数。
 * @param {Record<string, {permission?: string, build?: Function}>} [table]
 * @param {string[]} [permissions]
 */
export function assertGroupActions(table = GROUP_ACTIONS, permissions = PERMISSION_LIST) {
  const known = new Set(permissions);
  for (const name of Object.keys(table)) {
    const def = table[name];
    if (def === null || typeof def !== 'object') throw new Error('群管理动作 ' + name + ' 的定义不是对象');
    if (typeof def.permission !== 'string' || def.permission === '') {
      throw new Error('群管理动作 ' + name + ' 缺少 permission（缺项等于不做权限检查）');
    }
    if (known.has(def.permission) !== true) {
      throw new Error('群管理动作 ' + name + ' 的 permission 不在合法档位里：' + def.permission);
    }
    if (typeof def.build !== 'function') throw new Error('群管理动作 ' + name + ' 缺少 build 函数');
  }
  return table;
}

export { toId };

assertGroupActions();
