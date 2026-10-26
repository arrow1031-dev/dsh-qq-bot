#!/usr/bin/env node
/**
 * /auth 与 /flow 指令解析自测（纯函数）。
 *
 *   node test/test-flow-commands.mjs
 *
 * 只测「消息是不是这两条指令、参数是什么」；鉴权与放行不在这里（见 test-flow-auth / test-flow-gate）。
 */
import { parseAuthCommand, parseFlowCommand, flowInterceptKind, artifactInputLines, flowReasonZh, stripInvisible, FLOW_HELP } from '../lib/flow-commands.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail === '' ? '' : ' — ' + detail)); }
}

console.log('1. /auth 解析');
check('/auth 123456 → token=123456', parseAuthCommand('/auth 123456')?.token === '123456');
check('/AUTH 123456 大小写不敏感', parseAuthCommand('/AUTH 123456')?.token === '123456');
check('前后空格被裁掉', parseAuthCommand('   /auth   123456   ')?.token === '123456');
check('/auth 无参数 → token 为空串（提示用法，不当成聊天）', parseAuthCommand('/auth')?.token === '');
check('/auth x 不在这里做格式校验（交给 totpVerify 判 bad-format）', parseAuthCommand('/auth x')?.token === 'x');
check('指令必须位于消息开头：前有文字就不算', parseAuthCommand('请 /auth 123456') === null);
check('/authx 不算 /auth', parseAuthCommand('/authx 123456') === null);
check('/auth 带多余参数整段交出（格式由校验判，绝不漏给模型）', parseAuthCommand('/auth 123 456')?.token === '123 456');
check('无关消息返回 null', parseAuthCommand('今天天气不错') === null);
check('空字符串返回 null', parseAuthCommand('') === null);
check('undefined 返回 null（不抛）', parseAuthCommand(undefined) === null);

console.log('\n2. /flow 解析');
check('/flow → action 为空串（提示帮助）', parseFlowCommand('/flow')?.action === '');
check('/flow help', parseFlowCommand('/flow help')?.action === 'help');
check('/flow ls', parseFlowCommand('/flow ls')?.action === 'ls');
check('/flow 大小写归一', parseFlowCommand('/Flow LS')?.action === 'ls');
check('/flow use 名字 → arg 保留原文', parseFlowCommand('/flow use daily-check')?.arg === 'daily-check');
check('/flow auth 带用途时保留空格', parseFlowCommand('/flow auth 跑一遍日报 汇总')?.arg === '跑一遍日报 汇总');
check('/flowx 不算 /flow', parseFlowCommand('/flowx ls') === null);
check('无关消息返回 null', parseFlowCommand('flow ls') === null);

console.log('\n3. 帮助文案');
check('帮助文案提到 /auth 与 /flow', FLOW_HELP.includes('/auth') && FLOW_HELP.includes('/flow'));
check('帮助文案只写实现了的指令（不再出现 /flow stop、/flow retire 这类没做的）', !FLOW_HELP.includes('/flow stop') && !FLOW_HELP.includes('/flow save'));
check('帮助文案写明一次一用', FLOW_HELP.includes('一次一用'));


console.log('\\n4. 入口判定（谁的消息才会被前置拦截）');
check('主人私聊 /auth → auth', flowInterceptKind({ isGroup: false, isOwner: true, text: '/auth 123456' }) === 'auth');
check('主人私聊 /flow ls → flow', flowInterceptKind({ isGroup: false, isOwner: true, text: '/flow ls' }) === 'flow');
check('群里 /auth 不拦（授权只能在私聊做）', flowInterceptKind({ isGroup: true, isOwner: true, text: '/auth 123456' }) === null);
check('非拥有者私聊 /auth 不拦（交给访客闸/模型）', flowInterceptKind({ isGroup: false, isOwner: false, text: '/auth 123456' }) === null);
check('普通聊天不拦', flowInterceptKind({ isGroup: false, isOwner: true, text: '你好' }) === null);
check('空正文不拦', flowInterceptKind({ isGroup: false, isOwner: true, text: '   ' }) === null);
check('缺字段不炸', flowInterceptKind({}) === null && flowInterceptKind({ text: '/auth 1' }) === null);

console.log('\n5. 打包输入归一化（防 zip 参数注入 / stdin 行注入）');
check('普通名字加 ./ 前缀', JSON.stringify(artifactInputLines(['a.txt', 'b.md'])) === JSON.stringify(['./a.txt', './b.md']));
check('以 - 开头的名字也不会被当成选项', artifactInputLines(['-T'])[0] === './-T');
check('已带 ./ 的不重复加', artifactInputLines(['./x'])[0] === './x');
check('含换行的名字被丢弃（不能往 stdin 注入多行）', artifactInputLines(['ok.txt', 'bad\n-x']).length === 1);
check('空值/非数组不炸', artifactInputLines(undefined).length === 0 && artifactInputLines(['', null]).length === 0);
console.log('\n6. 零宽与报错文案（第二轮评审补的回归）');
check('拦截判定认得出前置零宽字符', flowInterceptKind({ isGroup: false, isOwner: true, text: '\u200b/auth 123456' }) === 'auth');
check('剥完之后能正常解析（否则消息被拦下来又静默丢掉）',
  (() => { const t = stripInvisible('\u200b/auth 123456'); return t === '/auth 123456' && parseAuthCommand(t) !== null; })());
check('软连字符 / 蒙古文分隔符 / 韩文填充符 / 变体选择符也拦得住',
  ['\u00ad', '\u180e', '\u3164', '\u115f', '\ufe0f'].every((ch) => flowInterceptKind({ isGroup: false, isOwner: true, text: ch + '/auth 123456' }) === 'auth'));
check('拦得住的这些也能解析（消息不会静默蒸发）',
  ['\u00ad', '\u180e', '\u3164', '\u115f'].every((ch) => parseAuthCommand(ch + '/auth 123456') !== null));
check('解析函数自己就剥（调用点传原文也不会丢）', parseAuthCommand('\u200b/auth 123456') !== null);
check('剥零宽对普通文本无副作用', stripInvisible('/flow ls') === '/flow ls');
check('流程层英文 reason 有中文翻译', flowReasonZh('sha-mismatch') !== 'sha-mismatch' && flowReasonZh('bad-name') !== 'bad-name');
check('认不出的 reason 不返回空', flowReasonZh('weird') === 'weird' && flowReasonZh('') === '未知原因');

console.log('\n7. 全量 Default_Ignorable（第三轮：手维护区间漏了这些）');
check('双向隔离符 U+2066–2069 也拦得住',
  ['\u2066', '\u2067', '\u2068', '\u2069'].every((ch) => flowInterceptKind({ isGroup: false, isOwner: true, text: ch + '/auth 123456' }) === 'auth'));
check('U+061C（阿拉伯字母标记）也拦得住',
  flowInterceptKind({ isGroup: false, isOwner: true, text: '\u061c/auth 123456' }) === 'auth');
check('U+E0020（标签字符）也拦得住',
  flowInterceptKind({ isGroup: false, isOwner: true, text: '\u{e0020}/auth 123456' }) === 'auth');
check('这些剥完之后也能解析',
  ['\u2066', '\u061c', '\u{e0020}'].every((ch) => parseAuthCommand(ch + '/auth 123456') !== null));
check('\\p{Cf} 全量剥不误伤正常文本', stripInvisible('/auth 123456') === '/auth 123456');

console.log('');
if (fail === 0) { console.log(pass + '/' + (pass + fail) + ' 项通过'); console.log('指令解析自测通过'); }
else { console.log(pass + ' 通过 / ' + fail + ' 失败'); process.exit(1); }
