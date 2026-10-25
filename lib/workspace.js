// 工作区根（QQ_msg）解析：被 index.js / imgsearch.js 共用。
//
// 0.9.5 及更早：这段逻辑只写在 index.js 里，imgsearch.js 的 meIsAllowedImageFile
// 直接调 qqMsgRootSync() —— 但那个文件并没有导入它，运行时抛 ReferenceError，
// 被 catch 吞掉后一律返回 false（qq_imgsearch 的本地文件校验因此永远拒绝）。
// 0.9.6 起抽到本模块，两个文件都从这里导入。
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

let qqMsgRootValue = null;

export function qqMsgRootSync() {
  if (qqMsgRootValue !== null) return qqMsgRootValue;
  const root = join(resolveDocumentsDir(), 'deepseek-harness', 'QQ_msg');
  try { mkdirSync(root, { recursive: true }); } catch { /* 目录不可建时不阻塞插件 */ }
  qqMsgRootValue = root;
  return root;
}

export function sessionWorkdir(sessionId) {
  return join(qqMsgRootSync(), String(sessionId));
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
