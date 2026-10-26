/**
 * 持久化工作流定义：<root>/<name>.js + <name>.json（元数据 + sha256）。
 *
 * 为什么要 sha256：授权绑定的是「哪份脚本」，不是「哪个名字」。脚本被换掉而名字不变时，
 * 旧授权必须失效——所以 run 前校验脚本哈希，对不上直接拒绝。
 *
 * 设计约束：
 * - 名字白名单字符，拒绝路径穿越（../、绝对路径、盘符）；
 * - 写入原子（tmp + rename），中途失败不留下半个脚本；
 * - 覆盖必须显式 overwrite，避免手滑改掉线上工作流。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function isValidFlowName(name) {
  const n = String(name === undefined || name === null ? '' : name);
  return NAME_RE.test(n) && !n.includes('..');
}

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

export function createFlowStore(options = {}) {
  const root = String(options.root || '');
  if (root === '') throw new Error('flow store 需要 root 目录');

  function scriptPath(name) { return path.join(root, name + '.js'); }
  function metaPath(name) { return path.join(root, name + '.json'); }

  function list() {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch (error) { return []; }
    const out = [];
    for (const file of entries) {
      if (!file.endsWith('.json')) continue;
      const name = file.slice(0, -5);
      if (!isValidFlowName(name)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath(name), 'utf8'));
        out.push({ name, sha256: String(meta.sha256 || ''), title: String(meta.title || ''), updatedAt: Number(meta.updatedAt) || 0, target: String(meta.target || 'private') });
      } catch (error) { /* 坏掉的元数据跳过 */ }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  function read(name) {
    if (!isValidFlowName(name)) return { ok: false, reason: 'bad-name' };
    try {
      const script = fs.readFileSync(scriptPath(name), 'utf8');
      const meta = JSON.parse(fs.readFileSync(metaPath(name), 'utf8'));
      const actual = sha256(script);
      if (String(meta.sha256 || '') !== actual) return { ok: false, reason: 'sha-mismatch', expected: String(meta.sha256 || ''), actual };
      return { ok: true, name, script, meta, sha256: actual };
    } catch (error) { return { ok: false, reason: 'not-found' }; }
  }

  function save(name, script, meta = {}) {
    if (!isValidFlowName(name)) return { ok: false, reason: 'bad-name' };
    const text = String(script === undefined || script === null ? '' : script);
    if (text.trim() === '') return { ok: false, reason: 'empty-script' };
    fs.mkdirSync(root, { recursive: true });
    const exists = fs.existsSync(scriptPath(name));
    if (exists && meta.overwrite !== true) return { ok: false, reason: 'exists' };
    const digest = sha256(text);
    const payload = {
      name,
      sha256: digest,
      title: String(meta.title || ''),
      target: String(meta.target || 'private'),
      updatedAt: Number(meta.updatedAt) || Date.now(),
    };
    const tmpA = scriptPath(name) + '.tmp-' + process.pid;
    const tmpB = metaPath(name) + '.tmp-' + process.pid;
    fs.writeFileSync(tmpA, text, 'utf8');
    fs.writeFileSync(tmpB, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpA, scriptPath(name));
    fs.renameSync(tmpB, metaPath(name));
    return { ok: true, name, sha256: digest, overwritten: exists };
  }

  function remove(name) {
    if (!isValidFlowName(name)) return { ok: false, reason: 'bad-name' };
    let removed = false;
    for (const p of [scriptPath(name), metaPath(name)]) {
      try { fs.unlinkSync(p); removed = true; } catch (error) { /* 不存在就算了 */ }
    }
    return removed ? { ok: true, name } : { ok: false, reason: 'not-found' };
  }

  /** 授权里带的 sha256 与磁盘现状比对：对不上就拒绝（脚本被换掉的场景）。 */
  function verify(name, expectedSha) {
    if (!isValidFlowName(name)) return { ok: false, reason: 'bad-name' };
    let script;
    try { script = fs.readFileSync(scriptPath(name), 'utf8'); } catch (error) { return { ok: false, reason: 'not-found' }; }
    const actual = sha256(script);
    const want = String(expectedSha || '');
    if (want !== '' && want !== actual) return { ok: false, reason: 'sha-changed', expected: want, actual };
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(metaPath(name), 'utf8')); } catch (error) { meta = {}; }
    if (String(meta.sha256 || '') !== actual) return { ok: false, reason: 'meta-mismatch', expected: String(meta.sha256 || ''), actual };
    return { ok: true, sha256: actual };
  }

  return { root, list, read, save, remove, verify };
}