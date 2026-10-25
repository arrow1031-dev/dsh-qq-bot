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
  const age = Math.max(0, Math.floor(Number(data.eventAgeMinutes) || 0));
  const recent = Array.isArray(data.recentTopics) ? data.recentTopics.map((x) => String(x)).filter((x) => x !== '').slice(-3) : [];
  const freshness = age > 0 ? '\n注意：最新一条消息已经是 ' + age + ' 分钟前发的了。' : '';
  const noRepeat = recent.length > 0 ? '\n你最近已经聊过这些话题：' + recent.join('、') + '，不要再重复。' : '';
  return head + like + freshness + noRepeat + '\n'
    + '下面是群里最近的消息。看看有没有你愿意接一句的话题：只在真的感兴趣、接得上时才说话，没有就别说。\n'
    + '不要接：没营养的刷屏、吵架、敏感话题、广告、看不懂的梗、只针对某个人又没头没尾的话。\n'
    + '不要复述别人的话，不要 @ 人，不要发链接，不要提 AI。一条消息，口语，最多 ' + maxChars + ' 字。\n'
    + '如果这件事已经有人（包括别的 AI）回应过，或者已经过去很久，就不要再说一遍——宁可不说。\n\n'
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

/**
 * 判断「现在这段对话还值不值得接话」。
 *
 * 规则都是确定性的，不靠模型判断——模型很容易对一件早就聊完的事再回一次：
 *   1. 最新一条如果是自己发的，说明这轮已经说过话；
 *   2. 最新一条距今超过 staleMinutes，视为事件已经过气（这段时间里人或别的 bot 大概率已经接过）；
 *   3. 最新一条太短又不像提问（"行" / "OK" / "我去修一下"），是应答而不是新话题，不插话；
 *   4. 事件起点取「同一发送者连续补话（间隔 ≤ 3 分钟）」的第一条，用来算事件年龄。
 */
export function analyzeEvent(messages, options) {
  const opts = options === undefined || options === null ? {} : options;
  const nowSec = Number(opts.nowSec) > 0 ? Number(opts.nowSec) : Math.floor(Date.now() / 1000);
  const staleMinutes = Math.max(1, Math.floor(Number(opts.staleMinutes) || 15));
  const minChars = Math.max(1, Math.floor(Number(opts.minChars) || 6));
  const list = (Array.isArray(messages) ? messages : []).filter((m) => m !== null && typeof m === 'object' && Number(m.time) > 0);
  if (list.length === 0) return { ok: false, reason: '没有消息', ageMinutes: 0, eventTime: 0, replyish: false };
  const last = list[list.length - 1];
  const lastTime = Number(last.time);
  const ageMinutes = Math.max(0, Math.floor((nowSec - lastTime) / 60));
  if (last.isSelf === true) return { ok: false, reason: '最新一条是我自己发的', ageMinutes, eventTime: lastTime, replyish: false };
  if (ageMinutes > staleMinutes) {
    return { ok: false, reason: '最新消息已过去 ' + ageMinutes + ' 分钟（> ' + staleMinutes + ' 分钟，事件已经过气）', ageMinutes, eventTime: lastTime, replyish: false };
  }
  const text = String(last.text === undefined || last.text === null ? '' : last.text).trim();
  const asking = /[?？]\s*$/.test(text) || /(吗|呢|怎么|如何|什么|哪|多少|是不是|能不能)\s*[?？]?$/.test(text);
  // 上一句如果是同一个人 3 分钟内的发言，这条短句算是「补充说明」，不是应答别人。
  const prev = list.length >= 2 ? list[list.length - 2] : null;
  const continuation = prev !== null && prev.isSelf !== true && String(prev.userId) === String(last.userId) && (lastTime - Number(prev.time) <= 180);
  const replyish = text.length > 0 && text.length < minChars && asking !== true && continuation !== true;
  if (replyish === true) return { ok: false, reason: '最新一条像是应答（' + text + '），不插话', ageMinutes, eventTime: lastTime, replyish: true };
  // 事件起点：同一个人连着补话算同一件事
  let start = list.length - 1;
  while (start > 0) {
    const prev = list[start - 1];
    if (prev.isSelf === true || String(prev.userId) !== String(last.userId)) break;
    if (lastTime - Number(prev.time) > 180) break;
    start -= 1;
  }
  const head = list[start];
  // 场合判断：最近几条如果只有两个人在来回说，那是两个人的对话，别硬插进去。
  const pairWindow = Math.max(2, Math.floor(Number(opts.pairWindow) || 6));
  const humans = list.slice(-pairWindow).filter((m) => m.isSelf !== true);
  if (humans.length >= 4) {
    const senders = new Set(humans.map((m) => String(m.userId)));
    if (senders.size <= 2) {
      return { ok: false, reason: '最近 ' + humans.length + ' 条只有 ' + senders.size + ' 个人在说，像是他们的对话，不插话', ageMinutes, eventTime: Number(head.time), replyish: false };
    }
  }
  return { ok: true, reason: '', ageMinutes, eventTime: Number(head.time), replyish: false };
}

/** 话题归一化：去掉空白与标点、转小写，用于判断"这个话题是不是刚说过"。 */
export function topicKey(text) {
  return String(text === undefined || text === null ? '' : text)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。！？、；：,.!?;:~～"'“”‘’（）()【】\[\]]/g, '')
    .slice(0, 40);
}

/** 同一话题是否在冷却时间内已经说过（避免换个说法把同一件事再回一遍）。 */
export function topicRepeated(key, topics, options) {
  const target = topicKey(key);
  if (target === '') return false;
  const opts = options === undefined || options === null ? {} : options;
  const now = Number(opts.now) || Date.now();
  const cooldownMs = Math.max(1, Number(opts.cooldownMinutes) || 120) * 60000;
  const list = Array.isArray(topics) ? topics : [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    const at = Number(item.at) || 0;
    if (at > 0 && now - at > cooldownMs) continue;
    const old = topicKey(item.key);
    if (old === '') continue;
    if (old === target) return true;
    // 一长一短但互相包含，也当作同一话题（"老人家急诊住院" vs "住院"）；太短的 key 不参与包含判断，免得误伤。
    if (Math.min(old.length, target.length) >= 2 && (old.includes(target) || target.includes(old))) return true;
  }
  return false;
}