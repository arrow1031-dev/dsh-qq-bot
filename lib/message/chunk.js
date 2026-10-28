/**
 * 回复分条：按 Markdown 结构切分长回答（QQ 单条消息有字数上限）。
 *
 * 参照官方文档与公开资料整理后重写：以前只按换行硬切，会把代码块和 GFM 表格拦腰截断，
 * 读的人拿到的两半都修不回来。这里的判据是：代码块整块搬、表格整块搬、优先空行切开、超长才硬切；
 * 被强制切开的代码块在本段补收尾围栏、下一段补回语言标记，两段各自完整。
 *
 * 纯函数：不碰配置、不发消息，单测在 test-chunk.mjs。
 */

const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;

/** 行级切分：优先按整行累积（避免把行内的单词/URL 劈开）；单行本身超过 max 时只能按字符硬切。 */
function splitByLines(text, max) {
  const parts = [];
  let current = '';
  for (const line of text.split('\n')) {
    // 单行本身超限（长 URL、单行压缩的 JSON）：只能按字符硬切，但保留行内顺序。
    if (line.length > max) {
      if (current !== '') { parts.push(current); current = ''; }
      let rest = line;
      while (rest.length > max) { parts.push(rest.slice(0, max)); rest = rest.slice(max); }
      current = rest;
      continue;
    }
    if (current === '') { current = line; continue; }
    if ((current + '\n' + line).length > max) { parts.push(current); current = line; }
    else current = current + '\n' + line;
  }
  if (current !== '') parts.push(current);
  return parts;
}

/** 超长代码块：保留原围栏，切成多段，每段自带收尾围栏。 */
function splitFenceBlock(block, max) {
  const lines = block.split('\n');
  const open = lines[0];
  let close = lines[lines.length - 1];
  if (FENCE.test(close) !== true) close = '';
  const body = lines.slice(1, close === '' ? lines.length : lines.length - 1);
  const budget = Math.max(16, max - open.length - close.length - 2);
  const pieces = [];
  let current = '';
  for (const line of body) {
    if (line.length > budget) {
      if (current !== '') { pieces.push(current); current = ''; }
      let rest = line;
      while (rest.length > budget) { pieces.push(rest.slice(0, budget)); rest = rest.slice(budget); }
      current = rest;
      continue;
    }
    const next = current === '' ? line : current + '\n' + line;
    if (next.length > budget && current !== '') { pieces.push(current); current = line; }
    else current = next;
  }
  if (current !== '' || pieces.length === 0) pieces.push(current);
  const fenceTail = close === '' ? open.slice(0, open.search(/\S/)) + '\n' : '';
  return pieces.map((piece) => open + '\n' + piece + '\n' + close + fenceTail);
}

/** 切成原子块：代码块（含起止围栏）/ 表格（连续 | 行）/ 普通行。 */
function tokenize(source) {
  const blocks = [];
  let fence = null;
  let table = [];
  const flushTable = () => {
    if (table.length === 0) return;
    blocks.push({ kind: 'table', text: table.join('\n') });
    table = [];
  };
  for (const line of source.split('\n')) {
    if (fence !== null) {
      fence.body.push(line);
      const close = FENCE.exec(line);
      if (close !== null && close[2].startsWith(fence.marker) === true) {
        blocks.push({ kind: 'fence', text: fence.line + '\n' + fence.body.join('\n') });
        fence = null;
      }
      continue;
    }
    const open = FENCE.exec(line);
    if (open !== null) { flushTable(); fence = { marker: open[2], line, body: [] }; continue; }
    if (TABLE_ROW.test(line) === true) { table.push(line); continue; }
    flushTable();
    blocks.push({ kind: 'line', text: line });
  }
  if (fence !== null) {
    blocks.push({ kind: 'fence', text: fence.line + '\n' + fence.body.join('\n') + '\n' + fence.marker });
  }
  flushTable();
  return blocks;
}

/**
 * @param {string} text
 * @param {number} limit 单条上限（字符）
 * @returns {string[]} 非空分条；空输入返回 []
 */
export function chunkMarkdown(text, limit) {
  const source = String(text === undefined || text === null ? '' : text);
  const max = (Number.isFinite(limit) && limit > 0) ? Math.floor(limit) : 1200;
  if (source === '') return [];
  if (source.length <= max) return [source];

  const chunks = [];
  let current = '';
  const flush = () => {
    const trimmed = current.replace(/\n+$/, '');
    if (trimmed !== '') chunks.push(trimmed);
    current = '';
  };
  const append = (piece) => {
    if (current === '') { current = piece; return; }
    if ((current + '\n' + piece).length > max) { flush(); current = piece; return; }
    current = current + '\n' + piece;
  };
  // 原子块放不下时：代码块按围栏拆，其余按行切，再逐段放。
  const appendBlock = (block) => {
    if (block.text.length <= max) { append(block.text); return; }
    const parts = block.kind === 'fence' ? splitFenceBlock(block.text, max) : splitByLines(block.text, max);
    for (const part of parts) {
      if (part.length <= max) append(part);
      else for (const tiny of splitByLines(part, max)) append(tiny);
    }
  };
  for (const block of tokenize(source)) appendBlock(block);
  flush();
  return chunks;
}
