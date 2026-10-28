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

export function parseAuthCommand(rawText) {
  const text = stripInvisible(rawText);
  const raw = String(text === undefined || text === null ? '' : text).trim();
  const m = AUTH_RE.exec(raw);
  if (m === null) return null;
  return { kind: 'auth', token: String(m[1] || '').trim() };
}

export function parseFlowCommand(rawText) {
  const text = stripInvisible(rawText);
  const raw = String(text === undefined || text === null ? '' : text).trim();
  const m = FLOW_RE.exec(raw);
  if (m === null) return null;
  const action = String(m[1] || '').toLowerCase();
  const rest = String(m[2] || '').trim();
  return { kind: 'flow', action, arg: rest };
}

const FLOW_REASON_ZH = {
  'bad-name': '名字不合法（只能字母、数字、- 和 _，最长 64，且不能用 ..）',
  'sha-mismatch': '脚本内容和钉住的哈希对不上（脚本被改过，或元数据过期了）',
  'not-found': '没找到这个流程脚本',
  'not-removed': '脚本没删掉（同名位置可能是个目录，或者没有写权限）',
  'exists': '同名流程已存在',
  'empty-script': '脚本是空的',
  'no-secret': '还没绑定 TOTP 密钥（设置页 → 高级 → 流程授权 → 生成密钥）',
  'locked': '错误次数太多，暂时锁定了',
  'disabled': '流程授权没有开启',
  'no-owner': '只能在拥有者的私聊里用',
  'weak-secret': '密钥太短（至少 10 字节）',
  // 动态码 / grant 相关。注意：这里的键是历史存量——flow-gate 的失败文案实际由
  // gateway/plugin.js 里的 AUTH_FAIL_TEXT 提供，只有 flowReasonZh 的调用方会用本表查这几个键。
  'tool-unknown': '先调用一次要授权的高危工具让它被拦下，再来申请（申请会绑定那个工具）',
  'no-pending': '没有待授权的申请（先在 qqauth 里 action="request"）',
  'replayed': '这条动态码已经用过了（同一个 30 秒窗口不能重复用）',
  'mismatch': '动态码不对',
  'no-recovery': '还没有配置恢复码',
};

/** 把授权/流程层的中文 reason 翻译成人话；认不出来的原样返回，别把英文直接甩给主人。 */
export function flowReasonZh(reason) {
  const key = String(reason === undefined || reason === null ? '' : reason);
  return FLOW_REASON_ZH[key] || (key === '' ? '未知原因' : key);
}

/** 剥掉零宽与其它不可见字符：既防绕过拦截，也保证解析拿到的是同一份文本。 */
export function stripInvisible(text) {
  // 零宽 / 软连字符 / 蒙古文元音分隔符 / 韩文填充符 / 变体选择符 / 标签字符……都算「不可见」，
  // 只要有一个漏网，'<不可见>/auth 123456' 就会整条进模型和会话历史。
  // \p{Cf} 覆盖零宽与方向隔离符（含 U+2066–2069）、软连字符等；再补 Default_Ignorable 里非 Cf 的那几段。
  // C0/C1 控制符（除 \t \n \r 这些真空白）也必须剥：\u0000 不是空白，trim() 去不掉，'\u0000/auth 123456'
  // 于是整条绕过拦截进了模型与会话历史。
  return String(text === undefined || text === null ? '' : text).replace(
    /[\p{Cf}\u0000-\u0008\u000e-\u001f\u007f-\u009f\u115f\u1160\u3164\ufe00-\ufe0f\uffa0\u{e0100}-\u{e01ef}]/gu,
    '',
  );
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
  const raw = stripInvisible(input.text).trim();
  if (raw === '') return null;
  if (parseAuthCommand(raw) !== null) return 'auth';
  if (parseFlowCommand(raw) !== null) return 'flow';
  return null;
}

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
/** 给主人的玩法提示（同时也是错误信息复用文案）。只写真的实现了的指令。 */
export const FLOW_HELP = [
  '一次性流：直接说要做的事，我先申请授权（你在私聊回 /auth 6位动态码）。',
  '持久流：编排脚本放 <QQ_msg>/flows/<名字>.js；/flow ls 看全部，/flow use <名字> 切活动流程。',
  '其它：/flow off 取消活动流程；/flow rm <名字> 删除；/flow auth [用途] 手动发起授权；/flow reset 清空待授权与未用授权。',
  '授权只在私聊、只认主人，一次一用；跑完的产物自动打包发回（默认私聊）。',
].join('\n');
