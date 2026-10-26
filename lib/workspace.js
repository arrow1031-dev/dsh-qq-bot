// 工作区根（QQ_msg）解析：被 index.js / imgsearch.js 共用。
//
// 0.9.5 及更早：这段逻辑只写在 index.js 里，imgsearch.js 的 meIsAllowedImageFile
// 直接调 qqMsgRootSync() —— 但那个文件并没有导入它，运行时抛 ReferenceError，
// 被 catch 吞掉后一律返回 false（qq_imgsearch 的本地文件校验因此永远拒绝）。
// 0.9.6 起抽到本模块，两个文件都从这里导入。
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

let qqMsgRootValue = null;

export function qqMsgRootSync() {
  if (qqMsgRootValue !== null) return qqMsgRootValue;
  const root = join(resolveDocumentsDir(), 'deepseek-harness', 'QQ_msg');
  try { mkdirSync(root, { recursive: true }); } catch { /* 目录不可建时不阻塞插件 */ }
  qqMsgRootValue = root;
  return root;
}

const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * 会话 id → 安全文件名。
 * 协议帧里的 group_id / user_id 是外部输入，直接拼路径会越界
 * （`join(root, 'qqbot-group-/../../../evil')` 会跑出 QQ_msg），而本插件拿会话 id 当工作区、
 * 当识图临时目录，回合结束还会递归删除那个临时目录——所以这里必须收口。
 */
export function safeSessionId(sessionId) {
  const raw = String(sessionId === undefined || sessionId === null ? '' : sessionId);
  if (SESSION_ID_RE.test(raw)) return raw;
  return 'sess-' + createHash('sha1').update(raw).digest('hex').slice(0, 12);
}

export function sessionWorkdir(sessionId) {
  return join(qqMsgRootSync(), safeSessionId(sessionId));
}

/** 识图临时目录（回合结束会递归删除它，路径必须受限）。 */
export function imageCacheDir(sessionId) {
  return join(qqMsgRootSync(), 'qq-images', safeSessionId(sessionId));
}

/** target 是否落在 base 之内（删除、写入前复核，防越界）。 */
export function isInside(base, target) {
  const root = resolve(String(base));
  const full = resolve(String(target));
  return full === root || full.startsWith(root + sep);
}

/** 复刻 @deepseek-ai/dsh-api-workspace-controller 的 Documents 解析；失败回退 <home>/Documents。 */
export function resolveDocumentsDir() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments, [Environment+SpecialFolderOption]::DoNotVerify)"],
        { encoding: 'utf8', timeout: 15000, windowsHide: true });
      const dir = out.replace(/[\r\n]+$/, '').trim();
      if (dir !== '') return dir;
    } else if (process.platform === 'darwin') {
      const out = execFileSync('osascript', ['-e', 'POSIX path of (path to documents folder from user domain without folder creation)'],
        { encoding: 'utf8', timeout: 15000 });
      const dir = out.replace(/[\r\n]+$/, '').trim();
      if (dir !== '') return dir;
    } else {
      const out = execFileSync('xdg-user-dir', ['DOCUMENTS'], { encoding: 'utf8', timeout: 10000 });
      const dir = out.replace(/[\r\n]+$/, '').trim();
      if (dir !== '') return dir;
    }
  } catch (error) { /* 平台命令不可用则走回退 */ }
  return join(homedir(), 'Documents');
}
