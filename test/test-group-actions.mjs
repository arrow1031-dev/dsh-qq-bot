#!/usr/bin/env node
/**
 * 群管理动作表自测：`node test/test-group-actions.mjs`
 *
 * 守的是「同一份知识只写一遍」：动作 → 权限名 / OneBot 请求只允许在
 * lib/api/group-actions.js 里定义；缺 permission 必须是加载期错误，不能静默放行。
 */
import { readFileSync } from 'node:fs';
import { GROUP_ACTIONS, GROUP_ACTION_NAMES, PERMISSION_LIST, assertGroupActions, toId } from '../lib/api/group-actions.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail === '' ? '' : ' — ' + detail)); }
}

const EXPECTED = [
  'group-list', 'group-info', 'member-list', 'member-info',
  'mute', 'unmute', 'kick', 'whole-ban', 'set-card', 'set-admin', 'rename', 'recall', 'poke',
];

console.log('1. 动作清单与表结构');
{
  check('动作清单是这 13 个', GROUP_ACTION_NAMES.slice().sort().join(',') === EXPECTED.slice().sort().join(','), GROUP_ACTION_NAMES.join(','));
  check('每个动作都有合法 permission', Object.values(GROUP_ACTIONS).every((d) => PERMISSION_LIST.includes(d.permission)), JSON.stringify(Object.entries(GROUP_ACTIONS).map(([k, v]) => [k, v.permission])));
  check('每个动作都有 build 函数', Object.values(GROUP_ACTIONS).every((d) => typeof d.build === 'function'));
  check('表本身通过加载期校验', (() => { try { assertGroupActions(); return true; } catch { return false; } })());
}

console.log('2. 缺字段必须在加载期报错（以前是静默零权限检查）');
{
  const cloneTable = () => Object.fromEntries(Object.entries(GROUP_ACTIONS).map(([k, v]) => [k, { ...v }]));
  const missingPermission = cloneTable();
  delete missingPermission.mute.permission;
  let threw = '';
  try { assertGroupActions(missingPermission); } catch (error) { threw = String(error.message); }
  check('缺 permission 抛错', threw.includes('缺少 permission'), threw);

  const bogusPermission = cloneTable();
  bogusPermission.kick.permission = 'root';
  threw = '';
  try { assertGroupActions(bogusPermission); } catch (error) { threw = String(error.message); }
  check('permission 不在档位里抛错', threw.includes('不在合法档位'), threw);

  const noBuild = cloneTable();
  delete noBuild.recall.build;
  threw = '';
  try { assertGroupActions(noBuild); } catch (error) { threw = String(error.message); }
  check('缺 build 抛错', threw.includes('缺少 build'), threw);
}

console.log('3. 请求构造（参数不足一律 null）');
{
  check('group-list', JSON.stringify(GROUP_ACTIONS['group-list'].build({})) === JSON.stringify({ action: 'get_group_list', params: {} }));
  check('mute 秒数原样下发', JSON.stringify(GROUP_ACTIONS.mute.build({ groupId: '123', uid: '456', durationSec: 600 })) === JSON.stringify({ action: 'set_group_ban', params: { group_id: 123, user_id: 456, duration: 600 } }));
  check('unmute 固定 0 秒', GROUP_ACTIONS.unmute.build({ groupId: '123', uid: '456' }).params.duration === 0);
  check('kick 带 reject_add_request=false', GROUP_ACTIONS.kick.build({ groupId: '1', uid: '2' }).params.reject_add_request === false);
  check('whole-ban 默认开', GROUP_ACTIONS['whole-ban'].build({ groupId: '1' }).params.enable === true);
  check('whole-ban 可关', GROUP_ACTIONS['whole-ban'].build({ groupId: '1', enable: false }).params.enable === false);
  check('set-card 用 text', GROUP_ACTIONS['set-card'].build({ groupId: '1', uid: '2', text: '新名片' }).params.card === '新名片');
  check('rename 用 text', GROUP_ACTIONS.rename.build({ groupId: '1', text: '新群名' }).params.group_name === '新群名');
  check('recall 把 message_id 转数字', GROUP_ACTIONS.recall.build({ messageId: '77' }).params.message_id === 77);
  check('poke 下发群与成员', JSON.stringify(GROUP_ACTIONS.poke.build({ groupId: '1', uid: '2' }).params) === JSON.stringify({ group_id: 1, user_id: 2 }));
  check('缺群号返回 null', GROUP_ACTIONS['group-info'].build({ groupId: null }) === null);
  check('缺成员返回 null', GROUP_ACTIONS.mute.build({ groupId: '1', uid: null, durationSec: 1 }) === null);
  check('空名片返回 null', GROUP_ACTIONS['set-card'].build({ groupId: '1', uid: '2', text: '' }) === null);
  check('缺消息 id 返回 null', GROUP_ACTIONS.recall.build({ messageId: null }) === null);
  check('toId 数字串转数字、非数字保留字符串', toId('123') === 123 && toId('abc') === 'abc');
}

console.log('4. 两条路径不再各写一份（防回退）');
{
  const tools = readFileSync(new URL('../lib/tools/index.js', import.meta.url), 'utf8');
  const admin = readFileSync(new URL('../lib/api/group-admin.js', import.meta.url), 'utf8');
  check('工具侧不再有 TOOL_PERMISSION 表', tools.includes('TOOL_PERMISSION') === false);
  check('工具侧不再有 plans 请求表', tools.includes('const plans = {') === false);
  check('工具侧从动作表 import', tools.includes("from '../api/group-actions.js'"));
  check('指令侧从动作表 import', admin.includes("from './group-actions.js'"));
  check('指令侧不再自己写 set_group_ban', admin.includes("action: 'set_group_ban'") === false);
}

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail > 0) process.exitCode = 1;
