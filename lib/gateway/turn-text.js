/**
 * 回合文本工具：提示词人格段、配置脱敏、昵称清洗、turn 失败原因归一、协议 id 归一。
 *
 * 从 gateway/plugin.js 搬出（P3 2.4 第一阶段）：这些只吃参数、不碰运行时状态，
 * 搬出去不改变任何行为，只为让 plugin.js 少背一段「和网关生命周期无关」的知识。
 */

/** 把设置里的「人格」渲染成一段身份设定；未启用或没填内容时返回空串。 */
export function buildPersonaHint(persona) {
  if (persona === null || persona === undefined || persona.enabled !== true) return '';
  const name = typeof persona.name === 'string' ? persona.name.trim() : '';
  const text = typeof persona.text === 'string' ? persona.text.trim() : '';
  if (name === '' && text === '') return '';
  return '（身份设定，请始终遵守：' + (name === '' ? '' : '你是' + name + '。') + text + '）';
}

/** 深拷贝一份配置，并把指定路径（键名数组）整段摘掉（不改入参）。 */
export function dropConfigPaths(raw, paths) {
  const clone = (value) => {
    if (Array.isArray(value)) return value.map(clone);
    if (value === null || typeof value !== 'object') return value;
    const next = {};
    for (const [key, child] of Object.entries(value)) next[key] = clone(child);
    return next;
  };
  const result = clone(raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw) ? {} : raw);
  for (const entry of paths) {
    // 只认键名数组：字符串会被当成单个键名，避免 "a.b" 被误解成嵌套路径。
    const parts = (Array.isArray(entry) ? entry : [entry]).map((part) => String(part)).filter((part) => part !== '');
    if (parts.length === 0) continue;
    let node = result;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const key = parts[index];
      if (node === null || typeof node !== 'object' || node[key] === undefined) { node = null; break; }
      node = node[key];
    }
    if (node !== null && typeof node === 'object') delete node[parts[parts.length - 1]];
  }
  return result;
}

/** 昵称/群名片 → 一行安全文本（去 \r\n 与方括号、压空白、限长）。 */
export function sanitizeDisplayName(value) {
  const text = String(value === undefined || value === null ? '' : value)
    .replace(/[\r\n\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return '未知用户';
  return text.length > 32 ? text.slice(0, 32) + '…' : text;
}

/** 把 turn/end reason 清洗成一句话：只保留失败号（400/503/429…），隐藏 request id 等敏感内容 */
export function summarizeTurnReason(reason) {
  let code = '';
  try {
    if (reason !== null && typeof reason === 'object') {
      const err = reason.error;
      const msg = (err !== null && typeof err === 'object' && typeof err.message === 'string') ? err.message
        : (typeof err === 'string' ? err : '');
      const m = /^(\d{3})\s*:/.exec(msg);
      if (m !== null) code = m[1];
    } else if (typeof reason === 'string') {
      const m = /^(\d{3})\s*:/.exec(reason);
      if (m !== null) code = m[1];
    }
    return code !== '' ? code : '未知原因';
  } catch {
    return '未知原因';
  }
}

/** 协议 id 归一：纯数字转 number，其余（qq-official 的 ROBOT1.0_… 之类）原样保留字符串。 */
export function idValue(value) {
  if (value === null || value === undefined) return undefined;
  const text = String(value);
  if (/^-?\d+$/.test(text) === true) {
    const num = Number(text);
    if (Number.isSafeInteger(num) === true) return num;
  }
  return text;
}
