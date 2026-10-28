/**
 * 中间发言：把本轮里「已经说完、后面还有内容」的 assistant 文本挑出来。
 *
 * 回合结束前模型往往先写一句（「我先查一下」「让我看看这条链接」）再去调工具，
 * 这些话本身不是最终结论。把它们挑出来单独发一条，能让长回合不至于一声不吭；
 * 列表里**最后一条消息**永远留给最终结算（那里才会引用 / @ 人）——判据是位置不是角色：
 * 回合以工具调用收尾时，最后一条 assistant 文本不算最终结算，照常作为中间发言发出去。
 *
 * 判据是「后面还有消息」：assistant 文本之后再出现任何消息（工具调用、下一段话），
 * 说明这段文字已经写完、不会继续追加，可以安全地发出去。
 */

/** 从一条消息里拼出纯文本（只认 text 段）。 */
function textOf(message) {
  if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) return '';
  let out = '';
  for (const block of message.content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') out += block.text;
  }
  return out.trim();
}

/**
 * @param {Array} messages 会话消息（deriveMessages() 的结果）
 * @param {string} afterId  本轮用户消息的 id（锚点）
 * @returns {{ id: string, text: string }[]} 可以现在就说出去的中间发言（按出现顺序）
 */
export function pickInterim(messages, afterId) {
  if (!Array.isArray(messages)) return [];
  let start = 0;
  if (afterId !== undefined && afterId !== null) {
    const at = messages.findIndex((m) => m !== null && typeof m === 'object' && m.id === afterId);
    // 锚点不在日志里：宁可不说，也不要把上一轮的话当成这一轮的中间发言重发一遍。
    if (at < 0) return [];
    start = at + 1;
  }
  const lastIndex = messages.length - 1;
  const picked = [];
  for (let index = start; index <= lastIndex; index += 1) {
    const message = messages[index];
    if (message === null || typeof message !== 'object' || message.role !== 'assistant') continue;
    // 压轴的那条留给最终结算：哪怕它已经写完，也可能正是最终答复。
    if (index === lastIndex) continue;
    const text = textOf(message);
    if (text === '') continue;
    picked.push({ id: (typeof message.id === 'string' && message.id !== '') ? message.id : 'idx-' + index, text });
  }
  return picked;
}
