// 主动发言（可选）：把「要不要接话、接什么」的判断做成纯逻辑，便于单测。
// 实际取历史、调模型、发消息都在 index.js；这里只负责：时间窗 / 消息清洗 / 摘要 / 提示词 / 决策解析 / 发言校验 / 频率闸。

export function parseClock(text) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(text === undefined || text === null ? '' : text));
  if (m === null) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mi) || h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

export function nowMinutes(date) {
  const d = date === undefined || date === null ? new Date() : date;
  return d.getHours() * 60 + d.getMinutes();
}

/** 解析免打扰时段：['23:00-08:00', '12:00-13:30'] -> [{start,end}]，跨零点也支持。 */
export function parseQuietRanges(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    const m = /^\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*$/.exec(String(item === undefined || item === null ? '' : item));
    if (m === null) continue;
    const start = parseClock(m[1]);
    const end = parseClock(m[2]);
    if (start === null || end === null) continue;
    out.push({ start, end });
  }
  return out;
}

export function isQuiet(minutesNow, list) {
  const ranges = parseQuietRanges(list);
  for (const r of ranges) {
    if (r.start === r.end) continue;
    if (r.start < r.end) {
      if (minutesNow >= r.start && minutesNow < r.end) return true;
    } else if (minutesNow >= r.start || minutesNow < r.end) {
      return true;
    }
  }
  return false;
}

/** OneBot 消息段 -> 纯文本（图片/表情给占位符）。 */
export function summarizeSegments(segments) {
  if (!Array.isArray(segments)) return '';
  const parts = [];
  for (const seg of segments) {
    if (seg === null || typeof seg !== 'object') continue;
    const type = String(seg.type === undefined ? '' : seg.type).toLowerCase();
    const data = seg.data === undefined || seg.data === null ? {} : seg.data;
    if (type === 'text') parts.push(String(data.text === undefined ? '' : data.text));
    else if (type === 'at') parts.push('@' + String(data.qq === undefined ? '' : data.qq));
    else if (type === 'image') parts.push('[图片]');
    else if (type === 'face' || type === 'mface') parts.push('[表情]');
    else if (type === 'file') parts.push('[文件]');
    else if (type === 'forward') parts.push('[转发]');
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

export function normalizeMessages(raw, selfId) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  const self = String(selfId === undefined || selfId === null ? '' : selfId);
  for (const m of raw) {
    if (m === null || typeof m !== 'object') continue;
    const sender = m.sender !== null && m.sender !== undefined && typeof m.sender === 'object' ? m.sender : {};
    const userId = String(m.user_id !== undefined && m.user_id !== null ? m.user_id : (sender.user_id === undefined ? '' : sender.user_id));
    const nickname = String(sender.card !== undefined && sender.card !== '' ? sender.card : (sender.nickname === undefined ? '' : sender.nickname));
    const text = summarizeSegments(m.message);
    if (text === '') continue;
    out.push({
      id: Number(m.message_id),
      time: Number(m.time) || 0,
      userId,
      nickname,
      text,
      isSelf: self !== '' && userId === self,
    });
  }
  return out;
}

/** 只保留比 sinceTime 更新的消息（严格大于）。 */
export function newerThan(messages, sinceTime) {
  const since = Number(sinceTime) || 0;
  return (Array.isArray(messages) ? messages : []).filter((m) => m.time > since);
}

export function buildDigest(messages, maxLines) {
  const limit = Math.max(1, Math.floor(Number(maxLines) || 20));
  const list = (Array.isArray(messages) ? messages : []).slice(-limit);
  const lines = [];
  for (const m of list) {
    const d = m.time > 0 ? new Date(m.time * 1000) : null;
    const hh = d === null ? '--:--' : String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    const who = m.nickname !== '' ? m.nickname : ('QQ' + m.userId);
    const text = String(m.text).replace(/\s+/g, ' ').slice(0, 160);
    lines.push('[' + hh + '] ' + who + '：' + text);
  }
  return lines.join('\n');
}

export function buildPrompt(input) {
  const data = input === undefined || input === null ? {} : input;
  const persona = typeof data.persona === 'string' ? data.persona.trim() : '';
  const interests = typeof data.interests === 'string' ? data.interests.trim() : '';
  const digest = typeof data.digest === 'string' ? data.digest : '';
  const maxChars = Math.max(20, Math.floor(Number(data.maxChars) || 120));
  const head = persona !== ''
    ? '你在 QQ 群里的设定：' + persona
    : '你是 QQ 群里的一个普通成员，有自己的脾气和兴趣。';
  const like = interests !== '' ? '\n你偏好的话题：' + interests : '';
  return head + like + '\n'
    + '下面是群里最近的消息。看看有没有你愿意接一句的话题：只在真的感兴趣、接得上时才说话，没有就别说。\n'
    + '不要接：没营养的刷屏、吵架、敏感话题、广告、看不懂的梗、只针对某个人又没头没尾的话。\n'
    + '不要复述别人的话，不要 @ 人，不要发链接，不要提 AI。一条消息，口语，最多 ' + maxChars + ' 字。\n\n'
    + '最近消息（旧→新）：\n' + digest + '\n\n'
    + '只输出 JSON，不要解释：{"speak": true 或 false, "topic": "想接什么", "message": "要说的话"}';
}

function normalizeJsonText(raw) {
  return String(raw)
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\uFF1A/g, ':')
    .replace(/\uFF0C/g, ',')
    .replace(/,\s*([}\]])/g, '$1');
}

function jsonCandidates(text) {
  const out = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j += 1) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) { out.push(text.slice(i, j + 1)); break; }
      }
    }
  }
  return out;
}

export function parseDecision(text) {
  const raw = String(text === undefined || text === null ? '' : text).trim();
  if (raw === '') return null;
  const stripped = raw.split(String.fromCharCode(96)).join('').trim();
  const sources = [stripped];
  const inner = stripped.slice(stripped.indexOf('{'), stripped.lastIndexOf('}') + 1);
  if (inner !== '' && inner !== stripped) sources.push(inner);
  for (const src of sources) {
    for (const candidate of jsonCandidates(src)) {
      let data = null;
      try { data = JSON.parse(normalizeJsonText(candidate)); } catch (error) { continue; }
      if (data === null || typeof data !== 'object') continue;
      const speakRaw = data.speak !== undefined ? data.speak
        : (data.join !== undefined ? data.join
          : (data.reply !== undefined ? data.reply : data.say));
      const hasKey = data.speak !== undefined || data.join !== undefined || data.reply !== undefined || data.say !== undefined
        || data.message !== undefined || data.text !== undefined || data.topic !== undefined;
      if (hasKey !== true) continue;
      const speak = speakRaw === true || speakRaw === 'true';
      const message = String(data.message !== undefined ? data.message : (data.text !== undefined ? data.text : (data.say !== undefined ? data.say : ''))).trim();
      const topic = String(data.topic !== undefined ? data.topic : '').trim().slice(0, 80);
      const why = String(data.why !== undefined ? data.why : (data.reason !== undefined ? data.reason : '')).trim().slice(0, 160);
      return { speak, topic, message, why };
    }
  }
  return null;
}

export function validateMessage(message, options) {
  const opts = options === undefined || options === null ? {} : options;
  const maxChars = Math.max(20, Math.floor(Number(opts.maxChars) || 120));
  const text = String(message === undefined || message === null ? '' : message).replace(/\s+\n/g, '\n').trim();
  if (text === '') return { ok: false, reason: '空内容' };
  if (text.length > maxChars) return { ok: false, reason: '超过长度上限 ' + maxChars };
  if (/https?:\/\/|www\./i.test(text)) return { ok: false, reason: '含链接' };
  if (/@\d{5,}/.test(text)) return { ok: false, reason: '含 @' };
  if (/(作为|我是).{0,6}(ai|人工智能|语言模型|助手)/i.test(text)) return { ok: false, reason: '自称 AI' };
  if (/^[\s\p{P}\p{S}]+$/u.test(text)) return { ok: false, reason: '无实质内容' };
  const norm = text.toLowerCase().replace(/\s+/g, '').replace(/[，。！？、；：,.!?;:~～]/g, '');
  const recent = Array.isArray(opts.recentTexts) ? opts.recentTexts : [];
  for (const old of recent) {
    const o = String(old === undefined || old === null ? '' : old).toLowerCase().replace(/\s+/g, '').replace(/[，。！？、；：,.!?;:~～]/g, '');
    if (o !== '' && o === norm) return { ok: false, reason: '和上一条重复' };
  }
  return { ok: true, reason: '', text };
}

export function allowSend(input) {
  const data = input === undefined || input === null ? {} : input;
  const now = Number(data.now) || Date.now();
  const times = (Array.isArray(data.sentTimes) ? data.sentTimes : []).filter((t) => Number.isFinite(Number(t))).map(Number);
  const hour = Math.max(0, Math.floor(Number(data.maxPerHour) || 0));
  const day = Math.max(0, Math.floor(Number(data.maxPerDay) || 0));
  const gap = Math.max(0, Number(data.minGapMinutes) || 0) * 60000;
  const last = Number(data.lastSentAt) || 0;
  if (gap > 0 && last > 0 && now - last < gap) return { ok: false, reason: '距上次发言不足最小间隔' };
  const inHour = times.filter((t) => now - t < 3600000).length;
  if (hour > 0 && inHour >= hour) return { ok: false, reason: '每小时上限' };
  const inDay = times.filter((t) => now - t < 86400000).length;
  if (day > 0 && inDay >= day) return { ok: false, reason: '每天上限' };
  return { ok: true, reason: '' };
}
