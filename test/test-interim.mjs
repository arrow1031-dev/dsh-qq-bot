#!/usr/bin/env node
/**
 * 中间发言自测：哪些 assistant 段落可以「现在就发」，哪些要留给最终结算。
 *
 *   node test/test-interim.mjs
 *
 * 纯函数，不连 QQ、不用 DSH：守的是三条语义——
 *   1) 最后一条 assistant 消息永远不发（它是最终答复，会由正常回复发出，可能带引用 / @）；
 *   2) 后面还有消息（工具调用 / 下一段话）就说明这段写完了，可以发；
 *   3) 锚点丢失时宁可不说，也不能把上一轮的话当成本轮中间发言重播。
 */
import { pickInterim } from '../lib/message/interim.js';
import { DEFAULTS } from '../lib/config.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail === '' ? '' : ' — ' + detail)); }
}

const user = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }] });
const say = (id, text) => ({ id, role: 'assistant', content: [{ type: 'text', text }] });
const tool = (id) => ({ id, role: 'assistant', content: [{ type: 'tool-call', name: 'qq_websearch' }] });
const toolResult = (id) => ({ id, role: 'tool', content: [{ type: 'tool-result', text: 'ok' }] });

console.log('1. 只有最终答复：什么都不发');
check('单条 assistant（本轮唯一消息）不发', pickInterim([user('u1', '在吗'), say('a1', '在的')], 'u1').length === 0);

console.log('\n2. 「我先查一下」→ 工具 → 最终答复：只发前面那句');
const seq = [user('u1', 'bgm 上这个番评分多少'), say('a1', '我先查一下'), tool('a2'), toolResult('t1'), say('a3', '6.9 分')];
const got = pickInterim(seq, 'u1');
check('只挑出中间那句', got.length === 1 && got[0].text === '我先查一下', JSON.stringify(got));
check('最终答复没有提前发出去', got.every((x) => x.text !== '6.9 分'));

console.log('\n3. 多段中间发言：按出现顺序全给，最后一条仍然保留');
const multi = [user('u1', 'x'), say('a1', '第一段'), tool('a2'), say('a3', '第二段'), toolResult('t1'), say('a4', '结论')];
const gotMulti = pickInterim(multi, 'u1').map((x) => x.text);
check('两段中间发言都在，顺序不变', JSON.stringify(gotMulti) === JSON.stringify(['第一段', '第二段']), JSON.stringify(gotMulti));

console.log('\n4. 边界');
check('锚点不在日志里 → 一条都不发（不重播上一轮）', pickInterim([user('u0', '上一轮'), say('a0', '上一轮的话')], 'u1').length === 0);
check('空数组 / 非数组不炸', pickInterim([], 'u1').length === 0 && pickInterim(null, 'u1').length === 0);
check('没有锚点（undefined）时只看「最后一条」规则', pickInterim([say('a1', '甲'), say('a2', '乙')]).length === 1);
check('只有工具调用、没有文字 → 不发空消息', pickInterim([user('u1', 'x'), tool('a2'), toolResult('t1'), say('a3', '结论')], 'u1').length === 0);
check('纯空白文字也跳过', pickInterim([user('u1', 'x'), say('a1', '   \n  '), toolResult('t1'), say('a2', '结论')], 'u1').length === 0);
check('user 消息永远不算中间发言', pickInterim([user('u1', 'x'), user('u2', '又说一句'), say('a3', '结论')], 'u1').length === 0);

console.log('\n5. 同一段话的 id 稳定（靠它去重，不能每次现算）');
const first = pickInterim(seq, 'u1');
const second = pickInterim(seq, 'u1');
check('两次调用 id 相同', first[0].id === second[0].id, JSON.stringify([first[0].id, second[0].id]));
check('没有 id 的消息用下标兜底且稳定', pickInterim([user('u1', 'x'), { role: 'assistant', content: [{ type: 'text', text: '无 id' }] }, say('a3', '结论')], 'u1')[0].id === 'idx-1');

console.log('\n6. 配置默认值');
check('默认开启中间发言', DEFAULTS.reply.interim === true);
check('默认每回合 4 条、间隔 2500ms', DEFAULTS.reply.interimMaxPerTurn === 4 && DEFAULTS.reply.interimMinGapMs === 2500,
  JSON.stringify([DEFAULTS.reply.interimMaxPerTurn, DEFAULTS.reply.interimMinGapMs]));

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
