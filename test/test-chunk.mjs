#!/usr/bin/env node
/**
 * 回复分条（Markdown 感知）自测：`node test-chunk.mjs`
 *
 * 守的是「切完之后每段都能独立读」：代码块不拦腰断、表格不切行、超长行能硬切、
 * 内容不丢（把各段拼回首尾能对上）。
 */
import { chunkMarkdown } from '../lib/chunk.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail === '' ? '' : ' — ' + detail)); }
}

const LONG = Array.from({ length: 60 }, (_, i) => '第 ' + i + ' 行内容').join('\n');

console.log('1. 短文本与空输入');
check('空字符串 → 空数组', JSON.stringify(chunkMarkdown('', 100)) === '[]');
check('短文本原样返回', JSON.stringify(chunkMarkdown('hello', 100)) === JSON.stringify(['hello']));

console.log('\n2. 普通长文本：不超限、内容不丢');
{
  const chunks = chunkMarkdown(LONG, 120);
  check('切成多段', chunks.length > 1, 'n=' + chunks.length);
  check('每段不超过上限', chunks.every((c) => c.length <= 120), JSON.stringify(chunks.map((c) => c.length)));
  check('行内容全部保留（按行比对）', chunks.join('\n').split('\n').join('|') === LONG.split('\n').join('|'));
}

console.log('\n3. 代码块：不拦腰断，被强切时两段各自围栏完整');
{
  const body = Array.from({ length: 20 }, (_, i) => 'console.log(' + i + ');').join('\n');
  const text = 'before\n' + '\x60\x60\x60js\n' + body + '\n' + '\x60\x60\x60\nafter';
  const chunks = chunkMarkdown(text, 120);
  const fenceLines = chunks.map((c) => c.split('\n').filter((l) => l.trim().startsWith('\x60\x60\x60')).length);
  check('代码块被切开', chunks.length >= 2, 'n=' + chunks.length);
  check('每段围栏成对（0 或 2）', fenceLines.every((n) => n === 0 || n === 2), JSON.stringify(fenceLines));
  check('被切开的段保留语言标记', chunks.filter((c) => c.includes('\x60\x60\x60js')).length >= 1);
}

console.log('\n4. 表格：按行整块搬，不切行');
{
  const rows = Array.from({ length: 12 }, (_, i) => '| 名字' + i + ' | 值' + i + ' |');
  const text = '导出结果如下：\n' + rows.join('\n') + '\n结束';
  const chunks = chunkMarkdown(text, 80);
  const allRows = chunks.join('\n').split('\n').filter((l) => l.includes('| 名字'));
  check('表格行全部保留', allRows.length === 12, 'rows=' + allRows.length);
  check('每段没有半行表格（每行都以 | 收尾）', chunks.every((c) => c.split('\n').filter((l) => l.includes('|') && l.includes('名字')).every((l) => /\|\s*$/.test(l))));
}

console.log('\n5. 超长单行：硬切也不越界太多');
{
  const one = 'x'.repeat(500);
  const chunks = chunkMarkdown(one, 100);
  check('被切成多段', chunks.length >= 5, 'n=' + chunks.length);
  check('每段不超过上限', chunks.every((c) => c.length <= 100), JSON.stringify(chunks.map((c) => c.length)));
  check('内容不丢（长度守恒）', chunks.join('').length === 500);
}

console.log('\n6. 未闭合围栏：也要给出可读的段');
{
  const text = '前\n' + '\x60\x60\x60py\nprint(1)\nprint(2)\nprint(3)';
  const chunks = chunkMarkdown(text, 40);
  check('有输出', chunks.length >= 1);
  check('每段不空', chunks.every((c) => c.trim() !== ''));
}

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail > 0) process.exitCode = 1;
