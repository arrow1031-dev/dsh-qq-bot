// 产物收集与打包：从会话目录按 mtime 收本轮新文件，用 zip/tar 打包（异步，不阻塞事件循环）。
// 从 gateway/plugin.js 搬出（P3 2.4 第三阶段，只搬不改）。
import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { artifactInputLines } from './commands.js';
import { sessionWorkdir } from '../session/workspace.js';

export function createArtifactCollect(deps) {
  const { TAG } = deps;
  /** 列出会话工作区里本轮新增/改动的文件；跳过隐藏项（.git、.env 之类不进包）。 */
  async function listFreshFiles(root, sinceMs, limit, skipHidden) {
    const out = [];
    async function walk(dir, depth) {
      if (out.length >= limit || depth > 6) return;
      let items;
      try { items = await fsPromises.readdir(dir, { withFileTypes: true }); } catch (error) { return; }
      items.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      for (const item of items) {
        if (out.length >= limit) return;
        const name = String(item.name);
        if (skipHidden === true && name.startsWith('.')) continue;
        // 上一轮的产物包不参与本轮打包（否则每轮都会把旧 zip 再套一层）。
        if (name.indexOf('qqbot-artifacts-') === 0) continue;
        const full = join(dir, name);
        if (item.isDirectory()) { await walk(full, depth + 1); continue; }
        if (item.isFile() !== true) continue;
        try {
          const stat = await fsPromises.stat(full);
          if (stat.mtimeMs >= sinceMs) out.push({ path: full, size: stat.size });
        } catch (error) { /* 读不到就跳过 */ }
      }
    }
    await walk(root, 0);
    return out;
  }

  /** 异步跑一个打包命令：execFileSync 会把整个 DSH 事件循环停住（Web UI 和别的会话一起卡）。 */
  function runPacker(command, args, options) {
    return new Promise((resolve) => {
      const input = options.input;
      let child;
      try {
        child = spawn(command, args, {
          cwd: options.cwd,
          // zip -@ 从 stdin 读文件名列表：只有需要输入时才开 pipe。
          stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'],
        });
      } catch { resolve(false); return; }
      let done = false;
      const finish = (ok) => { if (done === true) return; done = true; resolve(ok); };
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已经退出 */ } finish(false); }, 120000);
      if (typeof timer.unref === 'function') timer.unref();
      child.on('error', () => { clearTimeout(timer); finish(false); });
      child.on('close', (code) => { clearTimeout(timer); finish(code === 0); });
      if (input !== undefined && child.stdin !== null && child.stdin !== undefined) {
        child.stdin.on('error', () => { /* 写入即失败时由 close/error 结算 */ });
        child.stdin.end(input);
      }
    });
  }

  async function packFlowFiles(dir, files) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    // 统一 ./ 前缀并丢掉含换行的名字：zip -@ 从 stdin 读文件名，裸的 -x / 带换行都可能被当成额外指令。
    const rel = artifactInputLines(files.map((file) => file.path.slice(dir.length + 1)));
    const zipPath = join(dir, 'qqbot-artifacts-' + stamp + '.zip');
    if (await runPacker('zip', ['-q', '-@', zipPath], { cwd: dir, input: rel.join('\n') + '\n' }) === true) return zipPath;
    const tarPath = join(dir, 'qqbot-artifacts-' + stamp + '.tar.gz');
    if (await runPacker('tar', ['-czf', tarPath].concat(rel), { cwd: dir }) === true) return tarPath;
    console.log(TAG + ' 打包产物失败：zip 与 tar 都不可用');
    return '';
  }

  /**
   * 产物只从会话自己的目录收。
   *
   * 不能用 agent 的 cwd / workspace.path：所有 QQ 会话共用同一个 QQ_msg 工作区根，
   * 按 mtime 从根往下扫会把别的会话的文件、审计日志一起打进包（评审在真实合并的树上实测过）。
   */
  function artifactDirs(entry) {
    // 优先用建会话时记下的真实目录（独立工作区模式下就是 QQ_msg/<原 id>，
    // 即使 entry.sessionId 后来被改成 scoped 也不会错位）；没有就退回按 id 拼。
    const dir = (entry.flowWorkdir !== undefined && entry.flowWorkdir !== null)
      ? String(entry.flowWorkdir)
      : sessionWorkdir(entry.sessionId);
    return [dir];
  }


  return { listFreshFiles, packFlowFiles, artifactDirs };
}
