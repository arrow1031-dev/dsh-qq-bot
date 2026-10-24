// 主动发言：时间窗 / 消息清洗 / 摘要 / 提示词 / 决策解析 / 发言校验 / 频率闸。
import {
  parseClock, nowMinutes, parseQuietRanges, isQuiet, summarizeSegments,
  normalizeMessages, newerThan, buildDigest, buildPrompt, parseDecision,
  validateMessage, allowSend,
} from '../lib/proactive.js';

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail === undefined ? '' : ' -> ' + detail)); }
}

check('parseClock 23:00', parseClock('23:00') === 1380);
check('parseClock 非法', parseClock('25:00') === null && parseClock('x') === null);
check('parseQuietRanges 跨零点', JSON.stringify(parseQuietRanges(['23:00-08:00'])) === JSON.stringify([{ start: 1380, end: 480 }]));

check('免打扰：23:30 属于 23:00-08:00', isQuiet(23 * 60 + 30, ['23:00-08:00']) === true);
check('免打扰：07:59 属于', isQuiet(7 * 60 + 59, ['23:00-08:00']) === true);
check('免打扰：08:00 不属于', isQuiet(8 * 60, ['23:00-08:00']) === false);
check('免打扰：12:00 不属于', isQuiet(12 * 60, ['23:00-08:00']) === false);
check('免打扰：多段', isQuiet(13 * 60, ['12:00-13:30']) === true && isQuiet(14 * 60, ['12:00-13:30']) === false);

const segText = summarizeSegments([{ type: 'text', data: { text: '你好' } }, { type: 'at', data: { qq: '123' } }, { type: 'image', data: {} }]);
check('消息段摘要', segText.includes('你好') && segText.includes('@123') && segText.includes('[图片]'), segText);
const rawMsgs = [
  { message_id: 1, time: 1000, user_id: 22222, sender: { nickname: '小明', card: '' }, message: [{ type: 'text', data: { text: '第一条' } }] },
  { message_id: 2, time: 1001, user_id: 10000, sender: { nickname: 'bot', card: '' }, message: [{ type: 'text', data: { text: '自己的' } }] },
];
const msgs = normalizeMessages(rawMsgs, '10000');
check('normalizeMessages 映射字段', msgs.length === 2 && msgs[0].nickname === '小明' && msgs[0].userId === '22222' && msgs[0].time === 1000);
check('normalizeMessages 标记自己', msgs[1].isSelf === true && msgs[0].isSelf === false);
const newer = newerThan(msgs, 1000);
check('newerThan 只留更新的', newer.length === 1 && newer[0].id === 2);

const digest = buildDigest(msgs, 5);
check('buildDigest 含昵称与正文', digest.includes('小明') && digest.includes('第一条') && digest.split('\n').length === 2, digest);

const prompt = buildPrompt({ persona: '一只猫娘', interests: '游戏', digest: '[10:00] 小明：在吗', maxChars: 80 });
check('buildPrompt 含人设/偏好/摘要', prompt.includes('一只猫娘') && prompt.includes('游戏') && prompt.includes('在吗'));
check('buildPrompt 含 JSON 指令与长度', prompt.includes('speak') && prompt.includes('80'));

const d1 = parseDecision('{"speak":true,"topic":"游戏","message":"我也在"}');
check('parseDecision 正常 JSON', d1 !== null && d1.speak === true && d1.message === '我也在' && d1.topic === '游戏');
const fence = String.fromCharCode(96).repeat(3);
const d2 = parseDecision(fence + 'json\n{"speak":false}\n' + fence);
check('parseDecision 去掉代码块', d2 !== null && d2.speak === false);
check('parseDecision 非法返回 null', parseDecision('不是 JSON') === null);

check('validateMessage 正常', validateMessage('这游戏我也在玩', { maxChars: 50 }).ok === true);
check('validateMessage 超长', validateMessage('很长'.repeat(60), { maxChars: 50 }).ok === false);
check('validateMessage 链接', validateMessage('看这个 https://x.com', { maxChars: 50 }).ok === false);
check('validateMessage @人', validateMessage('@123456 你说的对', { maxChars: 50 }).ok === false);
check('validateMessage 自称 AI', validateMessage('作为一个AI我觉得', { maxChars: 50 }).ok === false);
check('validateMessage 重复上一条', validateMessage('这游戏我也在玩', { maxChars: 50, recentTexts: ['这游戏我也在玩。'] }).ok === false);

const now = Date.now();
check('allowSend 正常放行', allowSend({ now, sentTimes: [], lastSentAt: 0, maxPerHour: 2, maxPerDay: 4, minGapMinutes: 10 }).ok === true);
check('allowSend 间隔不足', allowSend({ now, sentTimes: [now - 60000], lastSentAt: now - 60000, maxPerHour: 2, maxPerDay: 4, minGapMinutes: 10 }).ok === false);
check('allowSend 每小时上限', allowSend({ now, sentTimes: [now - 120000, now - 180000], lastSentAt: 0, maxPerHour: 2, maxPerDay: 10, minGapMinutes: 0 }).ok === false);
check('allowSend 每天上限', allowSend({ now, sentTimes: [now - 7200000, now - 7300000, now - 7400000], lastSentAt: 0, maxPerHour: 10, maxPerDay: 3, minGapMinutes: 0 }).ok === false);

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
