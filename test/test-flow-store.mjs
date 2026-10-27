#!/usr/bin/env node
/**
 * 持久化工作流定义存储自测：读/列/删、sha256 校验、路径穿越拒绝。
 *
 *   node test/test-flow-store.mjs
 *
 * 注意：store 只提供 list / read / remove。流程脚本由主人自己放进目录
 * （README 承诺的用法就是「把 .js 放进 qq-flows/」），插件不写入、也不执行。
 * 以前那两个 save / verify 没有任何生产调用，已删除；这里改成直接落盘造 fixture。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFlowStore, isValidFlowName, sha256 } from '../lib/flow-store.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail === '' ? '' : ' — ' + detail)); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqflow-'));
const store = createFlowStore({ root });
const script = 'return await agent("巡检一下仓库");';

/** 主人视角：把脚本（可选带元数据）写进流程目录。 */
function put(name, text, meta) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, name + '.js'), text, 'utf8');
  if (meta !== undefined) {
    const payload = {
      name,
      sha256: sha256(text),
      title: String(meta.title || ''),
      target: String(meta.target || 'private'),
      updatedAt: Date.now(),
    };
    fs.writeFileSync(path.join(root, name + '.json'), JSON.stringify(payload, null, 2) + '\n', 'utf8');
  }
  return { ok: true, sha256: sha256(text) };
}

console.log('1. 名字白名单');
check('合法名字通过', isValidFlowName('daily-check_2'));
check('非法名字拒绝（路径穿越 / 空格 / 空）', !isValidFlowName('../x') && !isValidFlowName('a b') && !isValidFlowName('') && !isValidFlowName('x/y'));

console.log('\n2. 写入 / 读取 / 列表');
const saved = put('daily-check', script, { title: '日常巡检' });
check('落盘后能读回 sha256', /^[0-9a-f]{64}$/.test(saved.sha256));
check('写入的 sha256 与内容一致', saved.sha256 === sha256(script));
const readBack = store.read('daily-check');
check('读回脚本与元数据', readBack.ok === true && readBack.script === script && readBack.meta.title === '日常巡检');
check('列表里能看到', store.list().some((x) => x.name === 'daily-check' && x.sha256 === saved.sha256));

console.log('\n3. 脚本被手改 → sha 校验失败（授权要绑定脚本，不是名字）');
fs.writeFileSync(path.join(root, 'daily-check.js'), 'return 3;', 'utf8');
const broken = store.read('daily-check');
check('元数据与脚本不一致 → sha-mismatch', broken.ok === false && broken.reason === 'sha-mismatch');

console.log('\n4. 删除 / 不存在');
check('删除成功', store.remove('daily-check').ok === true);
check('删除后读不到', store.read('daily-check').ok === false);
check('再删一次 → not-found', store.remove('daily-check').reason === 'not-found');

console.log('\n5. 坏名字不会落到磁盘上');
check('路径穿越的名字进不了目录（没有 store.save 入口，只有合法名字才会被读写）',
  isValidFlowName('../escape') === false && fs.readdirSync(root).every((f) => !f.includes('escape')));

console.log('\n6. 手写的 <名字>.js（没有元数据）也能用（README 承诺的用法）');
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, 'demo.js'), '// 每日总结\n把今天群里的聊天整理成三条\n', 'utf8');
const listed = store.list();
const demo = listed.find((it) => it.name === 'demo') || {};
check('list 能看到没有元数据的 .js', demo.name === 'demo' && demo.pinned === false);
check('标题取首行注释', demo.title === '每日总结', String(demo.title));
const readPlain = store.read('demo');
check('read 读得到，且没有元数据不算 sha-mismatch', readPlain.ok === true && readPlain.pinned === false && readPlain.sha256 === sha256(readPlain.script));
put('pinned-two', '第一版', {});
fs.writeFileSync(path.join(root, 'pinned-two.js'), '第二版', 'utf8');
check('钉住 sha 的脚本被手改 → sha-mismatch', store.read('pinned-two').reason === 'sha-mismatch');

console.log('\n7. 脚本位置变成目录时，删除必须报失败（不能嘴上说删了）');
fs.mkdirSync(path.join(root, 'dirscript.js'), { recursive: true });
const dirRemove = store.remove('dirscript');
check('删不掉就返回 not-removed', dirRemove.ok === false && dirRemove.reason === 'not-removed', JSON.stringify(dirRemove));
check('目录确实还在（没被当成已删除）', fs.existsSync(path.join(root, 'dirscript.js')) === true);

fs.rmSync(root, { recursive: true, force: true });
console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail > 0) process.exitCode = 1;
