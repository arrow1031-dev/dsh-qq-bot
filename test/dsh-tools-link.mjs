/**
 * 让测试能像「装进 profile 之后」那样解析 @deepseek-ai/dsh-tools。
 *
 * 插件静态 import 这个包；裸克隆里没有它，工具注册整段会被跳过——
 * 于是「工具数从 7 漂到 9」「inject 少了 tools 导致注册失败」这类问题全绿通过。
 * 这里按 显式环境变量 > profile node_modules > DSH 安装目录 的顺序找，找到就建一个软链。
 *
 * 返回 true = 现在能解析（或本来就能）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DSH_INSTALL_MODULES = path.join('/usr/local/lib/node_modules/@deepseek-ai/dsh', 'node_modules');

export function ensureDshToolsLink(pkgRoot) {
  const linkPath = path.join(pkgRoot, 'node_modules', '@deepseek-ai', 'dsh-tools');
  if (fs.existsSync(linkPath)) return true;
  const candidates = [
    process.env.DSH_PROFILE_MODULES,
    path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'profiles', 'node_modules'),
    DSH_INSTALL_MODULES,
  ].filter((dir) => typeof dir === 'string' && dir !== '');
  for (const dir of candidates) {
    const target = path.join(dir, '@deepseek-ai', 'dsh-tools');
    if (fs.existsSync(target) !== true) continue;
    try {
      fs.mkdirSync(path.dirname(linkPath), { recursive: true });
      fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      return true;
    } catch (error) { /* 建不出就继续试下一个 */ }
  }
  return false;
}
