// 运行时兼容自检：不写死 DSH 版本号。
// 读当前进程实际加载的 DSH 版本，与声明支持范围比较，给出结论；
// 结果只用于启动日志与 qqbot 工具的 status 输出，任何异常都不影响收发消息。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

/** 声明支持的下限（含预发布）与上限（不含）。只维护这两个常量。 */
export const SUPPORT_FLOOR = '0.2.0-rc.2';
export const SUPPORT_CEILING = '0.3.0-0';

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** 解析 x.y.z[-pre]；不合法返回 null。 */
export function parseVersion(input) {
  const text = String(input === undefined || input === null ? '' : input).trim();
  const m = VERSION_RE.exec(text);
  if (m === null) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] === undefined ? [] : m[4].split('.'),
  };
}

function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;   // 正式版 > 同号预发布
  if (right.length === 0) return -1;
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const a = left[i];
    const b = right[i];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const na = /^\d+$/.test(a);
    const nb = /^\d+$/.test(b);
    if (na && nb) {
      if (Number(a) !== Number(b)) return Number(a) < Number(b) ? -1 : 1;
    } else if (na) {
      return -1;                     // 数字标识 < 字符串标识
    } else if (nb) {
      return 1;
    } else if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return 0;
}

/** 语义化比较：返回 -1 / 0 / 1。 */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === null || b === null) throw new Error('版本号不合法：' + String(left) + ' / ' + String(right));
  const keys = ['major', 'minor', 'patch'];
  for (const key of keys) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

/** 判定一个版本是否落在 [floor, ceiling) 内。 */
export function judgeCompatibility(version, floor, ceiling) {
  const low = floor === undefined || floor === null ? SUPPORT_FLOOR : String(floor);
  const high = ceiling === undefined || ceiling === null ? SUPPORT_CEILING : String(ceiling);
  const base = { version: version === undefined ? null : version, floor: low, ceiling: high };
  if (parseVersion(version) === null) {
    return Object.assign(base, { checked: false, supported: null, reason: '未能识别 DSH 版本' });
  }
  try {
    const within = compareVersions(version, low) >= 0 && compareVersions(version, high) < 0;
    return Object.assign(base, {
      checked: true,
      supported: within,
      reason: within ? '在声明支持范围内' : '超出声明支持范围',
    });
  } catch (error) {
    return Object.assign(base, {
      checked: false,
      supported: null,
      reason: '版本比较失败：' + (error !== null && error !== undefined && error.message ? error.message : String(error)),
    });
  }
}

function readVersionFromPackage(file) {
  try {
    if (!existsSync(file)) return null;
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    if (pkg === null || typeof pkg !== 'object') return null;
    const name = typeof pkg.name === 'string' ? pkg.name : '';
    if (name !== '@deepseek-ai/dsh' && name !== '@deepseek-ai/dsh-desktop-runtime') return null;
    if (typeof pkg.version !== 'string' || parseVersion(pkg.version) === null) return null;
    return pkg.version;
  } catch (error) {
    return null;
  }
}

/**
 * 探测当前运行的 DSH 版本：
 * 1) 环境变量 DSH_VERSION（显式覆盖，便于测试/特殊部署）；
 * 2) 从 process.argv[1]（dsh 的 bin.js）向上找 @deepseek-ai/dsh/package.json；
 * 3) 模块解析兜底（桌面版 asar 等场景）。
 * 都拿不到返回 null。
 */
export function detectDshVersion(options) {
  const opts = options === undefined || options === null ? {} : options;
  const env = opts.env === undefined ? process.env : opts.env;
  const argv = opts.argv === undefined ? process.argv : opts.argv;
  if (env !== null && env !== undefined && typeof env.DSH_VERSION === 'string') {
    const v = env.DSH_VERSION.trim();
    if (parseVersion(v) !== null) return v;
  }
  const entry = Array.isArray(argv) ? argv[1] : undefined;
  if (typeof entry === 'string' && entry !== '') {
    let dir = dirname(entry);
    for (let i = 0; i < 6; i += 1) {
      const found = readVersionFromPackage(join(dir, 'package.json'));
      if (found !== null) return found;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  try {
    const req = createRequire(import.meta.url);
    const ids = ['@deepseek-ai/dsh/package.json', '@deepseek-ai/dsh-desktop-runtime/package.json'];
    for (const id of ids) {
      try {
        const found = readVersionFromPackage(req.resolve(id));
        if (found !== null) return found;
      } catch (error) { /* 解析不到就继续 */ }
    }
  } catch (error) { /* 忽略 */ }
  return null;
}

/** 探测 + 判定，返回 judgeCompatibility 的结果。 */
export function compatibilityInfo(options) {
  return judgeCompatibility(detectDshVersion(options));
}

/** 生成一行中文描述，供启动日志使用。 */
export function describeCompatibility(info) {
  const data = info === undefined || info === null ? judgeCompatibility(null) : info;
  const range = data.floor + ' <= v < ' + data.ceiling;
  if (data.checked !== true) return '未能识别 DSH 版本（声明支持 ' + range + '；不影响运行）';
  if (data.supported === true) return '运行于 DSH ' + data.version + '（在声明支持范围 ' + range + ' 内）';
  return '运行于 DSH ' + data.version + '（超出声明支持范围 ' + range + '，遇到问题请反馈）';
}
