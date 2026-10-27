// Moli 引擎封装：探测 moli 可执行文件，并用它渲染抓取网页（qq_webfetch 的 moli 路径）。
//
// dsh-moli 插件只在**安装引擎**时用得到（它的 moli_probe 会下载官方引擎），运行期不依赖它：
// 引擎在、参数对，就能用。这里的探测顺序与命令行参数都对齐 dsh-moli 1.1.20（含
// 「URL 一律放在 -- 之后」这条防注入修复），设置页卡片上的高级设置也直通这些字段。
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { assertPublicHost } from './http.js';

/** 数字兜底：非有限值或越界就回退到 fallback（并夹在 [min, max] 内）。 */
function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * 探测 Moli 引擎可执行文件：显式配置 → MOLI_BIN → 安装器的标准位置 → PATH。
 * 顺序与 dsh-moli 的 moliCandidates 一致；未找到返回 undefined。
 */
function meFindMoli(exePath) {
  const home = process.env.HOME ?? homedir();
  const candidates = [
    exePath,
    process.env.MOLI_BIN,
    join(home, '.local', 'bin', 'moli'),
    join(home, '.local', 'share', 'moli', 'bin', 'moli'),
    join(home, '.local', 'share', 'moli', 'moli'),
    join(home, '.moli', 'bin', 'moli'),
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue;
    try { if (existsSync(candidate)) return candidate; } catch { /* 继续下一个 */ }
  }
  for (const dir of String(process.env.PATH ?? '').split(':')) {
    if (dir === '') continue;
    const candidate = join(dir, 'moli');
    try { if (existsSync(candidate)) return candidate; } catch { /* 继续 */ }
  }
  return undefined;
}

/** 超出上限时保留头尾、中间省略（与 dsh-moli 的 maxChars 语义一致）。 */
function clipMiddle(text, limit) {
  if (!(limit > 0) || text.length <= limit) return text;
  const marker = '\n\n…（中间省略 ' + String(text.length - limit) + ' 字符，全文 ' + String(text.length) + ' 字符）…\n\n';
  const budget = Math.max(0, limit - marker.length);
  const headLen = Math.max(0, Math.floor(budget * 0.6));
  const tailLen = Math.max(0, budget - headLen);
  return text.slice(0, headLen) + marker + (tailLen === 0 ? '' : text.slice(text.length - tailLen));
}

/**
 * 用 Moli 无头浏览器渲染抓取 URL，返回渲染后的 markdown 文本。
 *
 * 参数组合对齐 dsh-moli 1.1.20 的 buildArgs/fetchOnce：`-t` 紧跟在 `fetch` 之后
 * （放到末尾会被后面的 `--eval` 之类吞掉）、`--http-proxy`、TLS 跳过开关、
 * URL 一律放在 `--` 之后（`-` 开头的值不会被当成 flag），spawn 超时 = 引擎超时 + 30 秒。
 *
 * @param {string} url 目标地址（只放行 http/https，且必须是公网地址）
 * @param {{proxy?: string, timeoutMs?: number, maxChars?: number, exePath?: string, insecureTls?: boolean}} [options]
 * @returns {Promise<string>} 渲染文本（已按 maxChars 截断）
 */
function meMoliFetchText(url, options = {}) {
  const exe = meFindMoli(options.exePath);
  if (exe === undefined) return Promise.reject(new Error('Moli 引擎未找到（未在标准位置或 PATH 里发现 moli 可执行文件）'));

  const target = String(url === undefined || url === null ? '' : url).trim();
  // 无头浏览器会把子资源也抓一遍，所以入口先限制 scheme 与公网地址（比 dsh-moli 多一道防线）。
  let parsed;
  try { parsed = new URL(target); } catch { return Promise.reject(new Error('抓取地址无效：' + target)); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return Promise.reject(new Error('moli 只支持 http:// 或 https://（得到 ' + parsed.protocol + '）'));
  }
  if (target.startsWith('-')) return Promise.reject(new Error('抓取地址不能以 - 开头'));

  const deadline = clampNumber(options.timeoutMs, 1000, 300000, 30000);
  const cap = clampNumber(options.maxChars, 1000, 5000000, 200000);
  const proxy = (typeof options.proxy === 'string') ? options.proxy.trim() : '';
  // 本地校验代理开着时，入口校验之后的所有请求（重定向 / 子资源 / 页面 JS）也都走它：
  // moli 只连 127.0.0.1，用户配的上游代理由守卫代理再串一跳。
  const guardPort = (Number.isInteger(options.guardPort) && options.guardPort > 0) ? options.guardPort : 0;

  return assertPublicHost(parsed.hostname).then(() => {
    // 顺序对齐 dsh-moli：fetch → -t → -d → --fail → 代理 → TLS → -- → URL。
    //
    // --fail-with-body：最终主文档状态码 >= 400 时以退出码 22 结束，但**保留响应体**。
    // 用它而不是 --fail，是因为要同时拿到两件事：退出码说明"这次不是正常页面"，
    // 响应体里才看得出是守卫代理拦下的（body 以 "guard-proxy:" 开头）还是目标站点自己报的 4xx/5xx。
    // 没有它，守卫拦下内网地址时回的那段文字会被当成页面正文一直交给模型、再复述到群里（P0-1 假成功）。
    const argv = ['fetch', '-t', String(deadline), '-d', 'markdown', '--fail-with-body'];
    if (guardPort > 0) argv.push('--http-proxy', 'http://127.0.0.1:' + String(guardPort));
    else if (proxy !== '') argv.push('--http-proxy', proxy);
    if (options.insecureTls === true) argv.push('--insecure-disable-tls-host-verification');
    argv.push('--', target);
    return new Promise((resolve, reject) => {
      execFile(exe, argv, {
        // 取消兜底要比引擎自己的 -t 宽松，否则进程还没报超时就被杀了（dsh-moli 也是 +30s）。
        timeout: deadline + 30000,
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8',
      }, (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr ?? '').trim();
          const wrapped = new Error(detail === '' ? String(error.message ?? error) : detail);
          // 把退出码与两路输出带给调用方：退出码 22 = --fail 判定的 4xx/5xx，
          // 调用方据此把「被守卫拦下 / 目标报错 / 引擎自身故障」分开，而不是一律当成抓取失败。
          wrapped.exitCode = typeof error.code === 'number' ? error.code : null;
          wrapped.stdout = String(stdout ?? '');
          wrapped.stderr = detail;
          reject(wrapped);
          return;
        }
        resolve(clipMiddle(String(stdout ?? ''), cap));
      });
    });
  });
}

export { meFindMoli, meMoliFetchText };
