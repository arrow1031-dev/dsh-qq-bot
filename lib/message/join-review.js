/**
 * 加群请求审核：只对指定群生效，申请理由（comment）答对了才自动通过。
 *
 * 配置来自 group.joinReview：
 *   groups   生效的群号列表（空 = 不启用）
 *   answers  可接受的答案（申请人填写/回答的文本里包含任一答案即通过）
 *   question 便于记录的题目文案（不参与判定）
 *
 * 判定只认「答对」：答错/空答案一律保持待审（不自动拒绝），留人工处理。
 */

/** 归一化：NFKC、去首尾与多余空白、小写；保留标点（版本号里的点有意义）。 */
export function normalizeJoinAnswer(text) {
  return String(text === undefined || text === null ? '' : text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {{request_type?: string, sub_type?: string, group_id?: string|number, comment?: string}} frame
 * @param {{groups?: (string|number)[], answers?: string[]}} config
 * @returns {{action: 'ignore'|'approve'|'pending', reason: string}}
 */
export function judgeJoinRequest(frame, config) {
  if (frame === null || frame === undefined || typeof frame !== 'object') return { action: 'ignore', reason: 'no-frame' };
  if (frame.request_type !== 'group' || frame.sub_type !== 'add') return { action: 'ignore', reason: 'not-group-add' };
  const groups = Array.isArray(config && config.groups) ? config.groups.map((g) => String(g)) : [];
  if (groups.includes(String(frame.group_id)) !== true) return { action: 'ignore', reason: 'group-not-enabled' };
  const answers = (Array.isArray(config && config.answers) ? config.answers : [])
    .map((a) => normalizeJoinAnswer(a))
    .filter((a) => a !== '');
  if (answers.length === 0) return { action: 'pending', reason: 'no-answer-configured' };
  const given = normalizeJoinAnswer(frame.comment);
  if (given === '') return { action: 'pending', reason: 'empty-answer' };
  for (const answer of answers) {
    if (given === answer || given.includes(answer)) return { action: 'approve', reason: 'answer-match' };
  }
  return { action: 'pending', reason: 'answer-mismatch' };
}
