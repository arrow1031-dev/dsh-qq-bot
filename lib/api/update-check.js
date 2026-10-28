/**
 * 新版本探测：问 npm registry 要最新版，判断是否比当前新、且与当前 DSH 运行时兼容。
 *
 * 复用 shared/compat 的版本比较（同一套 semver 规则，不另造一份）。
 *
 * 边界：
 *   - 只在服务端拉（浏览器直连 registry 会被 CORS 挡）；
 *   - 结果缓存（默认 6 小时），设置页轮询不会每次都打外网；
 *   - 网络失败/解析失败不报红：返回 error 字段，UI 静默（更新提示不该变成噪音）；
 *   - 「兼容」按上游包自己声明的 dsh.compatibility.dsh 判断（>=a <b；也支持 ^ / 精确版本）。
 */
import { compareVersions } from '../shared/compat.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 读自己这张包的版本号（lib/api/ → 上两级是包根）。 */
export function readPackageVersion(metaUrl) {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', metaUrl)), 'utf8')).version;
  } catch (error) {
    return '0.0.0';
  }
}

/** 判断 version 是否满足 range（支持 *、^x.y.z、>=a、<b、精确版本；空格表示「与」）。 */
export function satisfies(version, range) {
  const text = String(range === undefined || range === null ? '' : range).trim();
  if (text === '' || text === '*') return true;
  const parts = text.split(/\s+/).filter((x) => x !== '');
  for (const part of parts) {
    if (part.startsWith('^')) {
      const base = part.slice(1);
      if (compareVersions(version, base) < 0) return false;
      const v = version.replace(/^v/i, '').split('.');
      const b = base.replace(/^v/i, '').split('.');
      if (Number(v[0]) !== Number(b[0])) return false;
      if (Number(v[0]) === 0 && Number(v[1]) !== Number(b[1])) return false;
      continue;
    }
    if (part.startsWith('>=')) { if (compareVersions(version, part.slice(2)) < 0) return false; continue; }
    if (part.startsWith('<=')) { if (compareVersions(version, part.slice(2)) > 0) return false; continue; }
    if (part.startsWith('>')) { if (compareVersions(version, part.slice(1)) <= 0) return false; continue; }
    if (part.startsWith('<')) { if (compareVersions(version, part.slice(1)) >= 0) return false; continue; }
    if (compareVersions(version, part) !== 0) return false;
  }
  return true;
}

/**
 * @param {object} deps
 * @param {string} deps.currentVersion 当前安装版本
 * @param {string} deps.dshVersion     当前 DSH 版本（用于兼容判断）
 * @param {(url: string) => Promise<any>} [deps.fetchJson]
 * @param {() => number} [deps.now]
 * @param {number} [deps.ttlMs]
 * @param {string} [deps.registry]
 * @param {() => boolean} [deps.enabled]
 */
export function createUpdateChecker(deps) {
  const currentVersion = String(deps.currentVersion || '0.0.0');
  const dshVersion = String(deps.dshVersion || '');
  const fetchJson = (typeof deps.fetchJson === 'function') ? deps.fetchJson : null;
  const now = (typeof deps.now === 'function') ? deps.now : () => Date.now();
  const ttlMs = Math.max(60 * 1000, Number(deps.ttlMs) || 6 * 60 * 60 * 1000);
  const registries = (Array.isArray(deps.registry) ? deps.registry : [deps.registry]).filter((x) => typeof x === 'string' && x !== '');
  if (registries.length === 0) {
    registries.push('https://registry.npmjs.org/@sputnikzaychik%2Fdsh-qq-bot/latest');
    registries.push('https://registry.npmmirror.com/@sputnikzaychik%2Fdsh-qq-bot/latest');
  }
  // 失败只缓存 5 分钟：网络抖动不该让提示blind 6 小时。
  const errorTtlMs = Math.min(ttlMs, 5 * 60 * 1000);
  const enabled = (typeof deps.enabled === 'function') ? deps.enabled : () => true;

  let cached = null;   // { at, value }

  async function fetchLatest() {
    if (fetchJson === null) throw new Error('没有可用的 fetchJson 注入');
    const failures = [];
    for (const registry of registries) {
      try {
        const manifest = await fetchJson(registry);
        if (manifest === null || typeof manifest !== 'object') throw new Error('registry 返回不是对象');
        const latest = String(manifest.version || '');
        if (latest === '') throw new Error('registry 没有返回 version');
        const dshRange = (manifest.dsh !== null && typeof manifest.dsh === 'object'
          && manifest.dsh.compatibility !== null && typeof manifest.dsh.compatibility === 'object')
          ? String(manifest.dsh.compatibility.dsh || '') : '';
        return { latest, dshRange, registry };
      } catch (error) {
        failures.push(String(error && error.message ? error.message : error));
      }
    }
    throw new Error(failures.join(' | ') || 'registry 不可用');
  }

  async function check() {
    if (enabled() !== true) return { enabled: false, current: currentVersion };
    const at = now();
    if (cached !== null && at - cached.at < (cached.value.error === undefined ? ttlMs : errorTtlMs)) return cached.value;
    let value;
    try {
      const info = await fetchLatest();
      const compatible = info.dshRange === '' || dshVersion === '' ? true : satisfies(dshVersion, info.dshRange);
      value = {
        enabled: true,
        current: currentVersion,
        latest: info.latest,
        compatible,
        hasUpdate: compareVersions(info.latest, currentVersion) > 0,
        dshRange: info.dshRange,
        registry: info.registry,
        checkedAt: at,
      };
    } catch (error) {
      value = {
        enabled: true,
        current: currentVersion,
        latest: null,
        compatible: false,
        hasUpdate: false,
        checkedAt: at,
        error: String(error && error.message ? error.message : error),
      };
    }
    cached = { at, value };
    return value;
  }

  return { check, satisfies, currentVersion };
}

/** 默认 fetch JSON（8 秒超时，失败抛错由调用方兜住）。 */
export async function fetchJsonDefault(url, timeoutMs = 8000) {
  if (typeof fetch !== 'function') throw new Error('运行时不支持 fetch');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
    if ('ok' in res && res.ok !== true) throw new Error('HTTP ' + String(res.status));
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
