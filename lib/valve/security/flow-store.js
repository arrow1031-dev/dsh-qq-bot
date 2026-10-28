/**
 * 流程脚本的只读视图：<root>/<name>.js 是本体（一段给模型看的任务书），<name>.json 是可选的元数据。
 *
 * 用法：直接把 <name>.js 拷进这个目录，/flow ls 就会看到它；同名的 <name>.json 可以写标题、
 * 投递目标与钉住的 sha256（钉住之后脚本被改会被 /flow use 拒绝）。没有元数据也能用，哈希按
 * 当前内容现算——这个功能的目标是「主人自己放脚本进来」，不该逼他先写一份 JSON。
 *
 * 设计约束：
 * - 名字白名单字符，拒绝路径穿越（../、绝对路径、盘符）；
 * - 本模块只读不写：保存/覆盖脚本的能力已经移除（见 CHANGELOG），这里只提供 list / read / remove。
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

  /** 没有元数据时用脚本首行注释当标题（'// 每日总结' → '每日总结'）。 */
  function titleFromScript(script) {
    const line = String(script || '').split(/\r?\n/, 1)[0] || '';
    const trimmed = line.replace(/^\s*(?:\/\/|#)\s*/, '').trim();
    return trimmed.slice(0, 60);
  }

  function readMeta(name) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath(name), 'utf8'));
      return (meta !== null && typeof meta === 'object') ? meta : {};
    } catch (error) { return null; }   // null = 没有元数据（合法，不报错）
  }

  function list() {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch (error) { return []; }
    const out = [];
    for (const file of entries) {
      if (!file.endsWith('.js')) continue;
      const name = file.slice(0, -3);
      if (!isValidFlowName(name)) continue;
      try {
        const script = fs.readFileSync(scriptPath(name), 'utf8');
        const meta = readMeta(name) || {};
        const stat = fs.statSync(scriptPath(name));
        out.push({
          name,
          sha256: sha256(script),
          pinned: String(meta.sha256 || '') !== '',
          title: String(meta.title || '') || titleFromScript(script),
          updatedAt: Number(meta.updatedAt) || stat.mtimeMs,
          target: String(meta.target || 'private'),
        });
      } catch (error) { /* 读不动的脚本跳过 */ }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  function read(name) {
    if (!isValidFlowName(name)) return { ok: false, reason: 'bad-name' };
    let script;
    try { script = fs.readFileSync(scriptPath(name), 'utf8'); } catch (error) { return { ok: false, reason: 'not-found' }; }
    const meta = readMeta(name) || {};
    const actual = sha256(script);
    const pinned = String(meta.sha256 || '');
    if (pinned !== '' && pinned !== actual) return { ok: false, reason: 'sha-mismatch', expected: pinned, actual };
    return { ok: true, name, script, meta, sha256: actual, pinned: pinned !== '' };
  }

  function remove(name) {
    if (!isValidFlowName(name)) return { ok: false, reason: 'bad-name' };
    let removed = false;
    for (const p of [scriptPath(name), metaPath(name)]) {
      try { fs.unlinkSync(p); removed = true; } catch (error) { /* 不存在就算了 */ }
    }
    // 脚本位置如果是个目录（unlink 会失败），以前照样回 ok，主人以为删掉了实际上还在跑。
    if (fs.existsSync(scriptPath(name)) === true) return { ok: false, reason: 'not-removed' };
    return removed ? { ok: true, name } : { ok: false, reason: 'not-found' };
  }

  return { root, list, read, remove };
}
