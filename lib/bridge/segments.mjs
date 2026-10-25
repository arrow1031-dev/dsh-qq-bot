/**
 * 统一「消息段」约定。
 *
 * 插件内部（以及适配器发给插件的 message 帧）用的是一套 OneBot 11 风格的段：
 *   { type: 'text',  data: { text: '...' } }
 *   { type: 'at',    data: { qq: '123' } }
 *   { type: 'image', data: { url: '...' | file: '...' } }
 *   { type: 'reply', data: { id: 123 } }
 *   { type: 'face' | 'record' | 'video' | 'file' | 'json' | 'xml' | 'forward' | 'poke', data: {...} }
 *
 * 这是兼容层的「中间表示」：各协议适配器把自家消息翻译成它，插件只认它。
 * 新增协议时，只要能产出这套段、并能把插件下发的段翻译回去，就算兼容完成。
 */

const LABELS = {
  face: '[表情]',
  record: '[语音]',
  video: '[视频]',
  json: '[卡片消息]',
  xml: '[卡片消息]',
  forward: '[合并转发]',
  poke: '[戳一戳]',
  mface: '[表情]',
};

/** 段数组 -> 纯文本（给模型看的），图片保留占位符。 */
export function segmentsToText(segments) {
  let text = '';
  if (!Array.isArray(segments)) return text;
  for (const seg of segments) {
    if (seg === null || typeof seg !== 'object') continue;
    const type = String(seg.type ?? '').toLowerCase();
    const data = seg.data ?? {};
    switch (type) {
      case 'text': text += String(data.text ?? ''); break;
      case 'at': {
        const qq = String(data.qq ?? '');
        text += qq === 'all' ? '@全体成员 ' : qq ? '@' + qq + ' ' : '';
        break;
      }
      case 'image': text += '[图片]'; break;
      case 'file': text += '[文件:' + String(data.name ?? data.file ?? '') + ']'; break;
      case 'reply': break;   // 引用不占正文，否则斜杠指令不在首位
      default: text += LABELS[type] ?? (typeof data.text === 'string' ? data.text : '');
    }
  }
  return text;
}

export function countImages(segments) {
  if (!Array.isArray(segments)) return 0;
  let count = 0;
  for (const seg of segments) {
    if (seg !== null && typeof seg === 'object' && String(seg.type ?? '').toLowerCase() === 'image') count += 1;
  }
  return count;
}

/** 收集图片可访问地址（供视觉识别）。 */
export function imageUrlsOf(segments) {
  const urls = [];
  if (!Array.isArray(segments)) return urls;
  for (const seg of segments) {
    if (seg === null || typeof seg !== 'object') continue;
    if (String(seg.type ?? '').toLowerCase() !== 'image') continue;
    const data = seg.data ?? {};
    const url = typeof data.url === 'string' && data.url !== '' ? data.url
      : (typeof data.file === 'string' && data.file !== '' ? data.file : '');
    if (url !== '') urls.push(url);
  }
  return urls;
}

/** 第一条 reply 段的被引用消息 id（没有则 null）。 */
export function replyIdOf(segments) {
  if (!Array.isArray(segments)) return null;
  for (const seg of segments) {
    if (seg === null || typeof seg !== 'object') continue;
    if (String(seg.type ?? '').toLowerCase() !== 'reply') continue;
    const raw = seg.data?.id;
    if (raw === undefined || raw === null || raw === '') continue;
    // OneBot 11 的 message_id 是数字，OneBot 12 / Satori / 官方 API 是字符串：
    // 数字就转 number（兼容旧逻辑），否则原样返回字符串。
    const numeric = Number(raw);
    return Number.isFinite(numeric) && String(raw).trim() !== '' ? numeric : raw;
  }
  return null;
}

/** 归一化：把段数组变成 { text, images, imageUrls, replyTo }。 */
export function summarizeSegments(segments) {
  return {
    text: segmentsToText(segments),
    images: countImages(segments),
    imageUrls: imageUrlsOf(segments),
    replyTo: replyIdOf(segments),
  };
}

/** 快捷构造器（适配器里写测试夹具方便）。 */
export const seg = {
  text: (text) => ({ type: 'text', data: { text: String(text ?? '') } }),
  at: (qq) => ({ type: 'at', data: { qq: String(qq) } }),
  image: (url) => ({ type: 'image', data: { url: String(url) } }),
  reply: (id) => ({ type: 'reply', data: { id } }),
};
