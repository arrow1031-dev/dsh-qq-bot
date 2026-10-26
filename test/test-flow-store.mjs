#!/usr/bin/env node
/**
 * 持久化工作流定义存储自测：写/读/列/删、sha256 校验、路径穿越拒绝、覆盖需显式。
 *
 *   node test/test-flow-store.mjs
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
const script = 'return await agent("巡检一下仓库");'

console.log('1. 名字白名单');
check('合法名字通过', isValidFlowName('daily-check_2'));
check('非法名字拒绝（路径穿越 / 空格 / 空）', !isValidFlowName('../x') && !isValidFlowName('a b') && !isValidFlowName('') && !isValidFlowName('x/y'));

console.log('\n2. 保存 / 读取 / 列表');
const saved = store.save('daily-check', script, { title: '日常巡检' });
check('首次保存成功并返回 sha256', saved.ok === true && /^[0-9a-f]{64}$/.test(saved.sha256));
check('写入的 sha256 与内容一致', saved.sha256 === sha256(script));
const readBack = store.read('daily-check');
check('读回脚本与元数据', readBack.ok === true && readBack.script === script && readBack.meta.title === '日常巡检');
check('列表里能看到', store.list().some((x) => x.name === 'daily-check' && x.sha256 === saved.sha256));

console.log('\n3. 覆盖保护与显式覆盖');
const again = store.save('daily-check', 'return 1;');
check('不显式 overwrite 拒绝覆盖', again.ok === false && again.reason === 'exists');
const ow = store.save('daily-check', 'return 2;', { overwrite: true });
check('显式覆盖成功且 sha256 变了', ow.ok === true && ow.overwritten === true && ow.sha256 !== saved.sha256);

console.log('\n4. 脚本被手改 → sha 校验失败（授权要绑定脚本，不是名字）');
fs.writeFileSync(path.join(root, 'daily-check.js'), 'return 3;', 'utf8');
const broken = store.read('daily-check');
check('元数据与脚本不一致 → sha-mismatch', broken.ok === false && broken.reason === 'sha-mismatch');
const ver = store.verify('daily-check', ow.sha256);
check('按旧 sha 校验 → sha-changed', ver.ok === false && ver.reason === 'sha-changed');

console.log('\n5. 空脚本 / 删除 / 不存在');
check('空脚本拒绝', store.save('empty-one', '   ').ok === false);
check('删除成功', store.remove('daily-check').ok === true);
check('删除后读不到', store.read('daily-check').ok === false);
check('再删一次 → not-found', store.remove('daily-check').reason === 'not-found');

console.log('\n6. 坏名字不会落到磁盘上');
const evil = store.save('../escape', 'return 1;');
check('路径穿越被拒', evil.ok === false && evil.reason === 'bad-name');
check('root 外没有新文件', fs.readdirSync(root).every((f) => !f.includes('escape')));


console.log('\n7. 手写的 <名字>.js（没有元数据）也能用（README 承诺的用法）');
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, 'demo.js'), '// 每日总结\n把今天群里的聊天整理成三条\n', 'utf8');
const listed = store.list();
const demo = listed.find((it) => it.name === 'demo') || {};
check('list 能看到没有元数据的 .js', demo.name === 'demo' && demo.pinned === false);
check('标题取首行注释', demo.title === '每日总结', String(demo.title));
const readPlain = store.read('demo');
check('read 读得到，且没有元数据不算 sha-mismatch', readPlain.ok === true && readPlain.pinned === false && readPlain.sha256 === sha256(readPlain.script));
store.save('pinned-two', '第一版', {});
fs.writeFileSync(path.join(root, 'pinned-two.js'), '第二版', 'utf8');
check('钉住 sha 的脚本被手改 → sha-mismatch', store.read('pinned-two').reason === 'sha-mismatch');

fs.rmSync(root, { recursive: true, force: true });
console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);