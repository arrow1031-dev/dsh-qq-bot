/**
 * 消息组装层入口 —— 「一句话怎么变成一条能发出去的 QQ 消息」的唯一出处。
 *
 * 这一层只处理**文本与段**，不碰网络、不碰会话、不碰权限：
 *
 *   chunk.js        长回答分条（按 Markdown 结构切：代码块整块搬、表格整块搬）
 *   stream.js       流式增量（仅官方 v2 私聊；把增量按节流合并成「当前全文」）
 *   interim.js      中间发言（回合结束前先说完的那几句，单独发一条）
 *   segments.js     统一段构造（各协议适配器共用的段语义）
 *   msgid-cache.js  入站去重（重连/重投的同一条消息只起一个回合）
 *
 * 为什么收成一个入口：分条、流式、中间发言三者都会改动「这一回合对外说了几句话」，
 * 分别接在网关里各写一遍，就会出现「流式发了一半又整条重发」这类错位。
 * 组装顺序固定为：**中间发言 → 正文分条 → 流式合并**（先说的先发，正文按条发，
 * 流式只在支持它的协议上把最后一条的增量合并）。
 */

import { chunkMarkdown } from './chunk.js';
import { createStreamBridge, shouldStream } from './stream.js';
import { pickInterim } from './interim.js';
import { createMsgIdCache } from './msgid-cache.js';
import { segmentsToText, countImages, imageUrlsOf, summarizeSegments } from './segments.mjs';

/** 组装顺序（越靠前越先对外可见）。 */
export const ASSEMBLY_STEPS = Object.freeze(['interim', 'chunk', 'stream']);

/**
 * 把一回合的输出组装成「要发出去的若干条文本」。
 *
 * 纯函数：不发送、不记状态，调用方拿到结果自己发。
 *
 * @param {object} input
 * @param {string} input.text            本回合最终文本
 * @param {Array<{id: string, text: string}>} [input.interim] 中间发言（按出现顺序）
 * @param {object} [input.chunk]         { enabled, max } 分条配置
 * @returns {{items: Array<{kind: 'interim'|'final', text: string}>}}
 */
export function assembleReply(input) {
  const data = (input === null || input === undefined) ? {} : input;
  const items = [];

  const interim = Array.isArray(data.interim) ? data.interim : [];
  for (const line of interim) {
    const text = (line === null || line === undefined) ? '' : String(line.text === undefined ? '' : line.text).trim();
    if (text !== '') items.push({ kind: 'interim', text });
  }

  const finalText = String(data.text === undefined || data.text === null ? '' : data.text);
  if (finalText.trim() !== '') {
    const cfg = (data.chunk === null || data.chunk === undefined) ? {} : data.chunk;
    const enabled = cfg.enabled === true;
    const max = Math.max(200, Math.floor(Number(cfg.max) || 0));
    const chunks = enabled ? chunkMarkdown(finalText, max) : [finalText];
    for (const chunk of chunks) {
      const text = String(chunk === undefined || chunk === null ? '' : chunk);
      if (text.trim() !== '') items.push({ kind: 'final', text });
    }
  }

  return { items };
}

export { chunkMarkdown, createStreamBridge, shouldStream, pickInterim, createMsgIdCache };
export { segmentsToText, countImages, imageUrlsOf, summarizeSegments };
