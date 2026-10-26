/**
 * QQ 端管理指令的解析（纯函数，便于单测）：/auth 与 /flow。
 *
 * 约束：
 * - 只在私聊里由主人触发；这里只负责解析，不负责鉴权；
 * - 解析不出就返回 null，调用方按普通聊天处理；
 * - /auth 的令牌整段收下（允许中间有空格），格式交给 TOTP 校验判——关键是必须被拦截，
 *   不能让带多余参数的「/auth 123 456」漏到模型那里去。
 */
const AUTH_RE = /^\/auth(?:\s+([\s\S]+))?$/i;
const FLOW_RE = /^\/flow(?:\s+(\S+))?(?:\s+([\s\S]*))?$/i;

export function parseAuthCommand(text) {
  const raw = String(text === undefined || text === null ? '' : text).trim();
  const m = AUTH_RE.exec(raw);
  if (m === null) return null;
  return { kind: 'auth', token: String(m[1] || '').trim() };
}

export function parseFlowCommand(text) {
  const raw = String(text === undefined || text === null ? '' : text).trim();
  const m = FLOW_RE.exec(raw);
  if (m === null) return null;
  const action = String(m[1] || '').toLowerCase();
  const rest = String(m[2] || '').trim();
  return { kind: 'flow', action, arg: rest };
}

/**
 * 入口判定：这条消息要不要在进入 Agent 之前被拦截。
 * 返回 'auth' | 'flow' | null —— 只认「私聊 + 拥有者 + 消息首位是 /auth 或 /flow」。
 * 群聊里永远返回 null：授权只能在私聊完成，群里叫不动。
 */
export function flowInterceptKind(input = {}) {
  if (input.isGroup === true) return null;
  if (input.isOwner !== true) return null;
  // 先剥掉零宽与不可见字符：'\u200b/auth 123456' 这种 trim 不掉，会让动态码绕过拦截进到模型和会话里。
  const raw = String(input.text === undefined || input.text === null ? '' : input.text)
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
    .trim();
  if (raw === '') return null;
  if (parseAuthCommand(raw) !== null) return 'auth';
  if (parseFlowCommand(raw) !== null) return 'flow';
  return null;
}

/** 给主人的玩法提示（同时也是错误信息复用文案）。只写真的实现了的指令。 */

/**
 * 打包输入归一化：给 zip -@ 的每行文件名加 ./ 前缀（否则以 - 开头的名字会被 zip 当成选项），
 * 并丢弃含换行的名字（否则一个名字能往 stdin 里注入多行）。
 */
export function artifactInputLines(relPaths) {
  const out = [];
  for (const raw of Array.isArray(relPaths) ? relPaths : []) {
    const name = String(raw === undefined || raw === null ? '' : raw);
    if (name === '') continue;
    if (/[\r\n]/.test(name)) continue;
    out.push(name.indexOf('./') === 0 ? name : './' + name);
  }
  return out;
}
export const FLOW_HELP = [
  '一次性流：直接说要做的事，我先申请授权（你在私聊回 /auth 6位动态码）。',
  '持久流：编排脚本放 <QQ_msg>/flows/<名字>.js；/flow ls 看全部，/flow use <名字> 切活动流程。',
  '其它：/flow off 取消活动流程；/flow rm <名字> 删除；/flow auth [用途] 手动发起授权；/flow reset 清空待授权与未用授权。',
  '授权只在私聊、只认主人，一次一用；跑完的产物自动打包发回（默认私聊）。',
].join('\n');
