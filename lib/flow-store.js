/**
 * 持久化流程脚本：<root>/<name>.js 是本体（一段给模型看的任务书），<name>.json 是可选的元数据。
 *
 * 用法：直接把 <name>.js 拷进这个目录，/flow ls 就会看到它；再配一份 <name>.js.json 旁的元数据
 * 可以写标题、投递目标与钉住的 sha256（钉住之后脚本被改会被 /flow use 拒绝）。没有元数据也能用，
 * 哈希按当前内容现算——这个功能的目标是「主人自己放脚本进来」，不该逼他先写一份 JSON。
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
    // 先落脚本、再落元数据：中途失败绝不能留下「元数据是新 sha、脚本还是旧的」——
    // 那样 read() 会永远 sha-mismatch，这条流程从此废掉。所以元数据失败就把旧元数据删掉，
    // 回到「没有元数据」的合法状态（哈希按当前内容现算）。
    fs.renameSync(tmpA, scriptPath(name));
    let metaOk = true;
    try { fs.renameSync(tmpB, metaPath(name)); } catch (error) {
      metaOk = false;
      try { fs.unlinkSync(tmpB); } catch (error2) { /* 临时文件清不掉也没关系 */ }
      try { fs.unlinkSync(metaPath(name)); } catch (error3) { /* 本来就没有 */ }
    }
    return { ok: true, name, sha256: digest, overwritten: exists, metaWriteFailed: metaOk === false };
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

  /**
   * 授权里带的 sha256 与磁盘现状比对。
   * 注意：目前没有「run」入口，插件不执行这些脚本，所以本函数暂时没有调用者——
   * /flow use 会自己核对钉住的 sha；留着它是给以后真要跑脚本时用的。
   */
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