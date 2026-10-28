// 运行时兼容自检：版本解析 / 比较 / 判定 / 探测回退 / 文案。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseVersion, compareVersions, judgeCompatibility, detectDshVersion,
  compatibilityInfo, describeCompatibility, SUPPORT_FLOOR, SUPPORT_CEILING,
} from '../lib/shared/compat.js';

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail === undefined ? '' : ' -> ' + detail)); }
}

const parsed = parseVersion('0.2.1-rc.3');
check('解析 0.2.1-rc.3', parsed !== null && parsed.major === 0 && parsed.minor === 2 && parsed.patch === 1 && parsed.prerelease.length === 2);
check('非法版本返回 null', parseVersion('not-a-version') === null);
check('rc.3 > rc.2', compareVersions('0.2.1-rc.3', '0.2.1-rc.2') === 1);
check('正式版 > 同号预发布', compareVersions('0.2.1', '0.2.1-rc.3') === 1);
check('数字标识按数值比较', compareVersions('0.2.1-rc.10', '0.2.1-rc.9') === 1);

const ok = judgeCompatibility('0.2.1-rc.3');
check('rc.3 判定为支持', ok.checked === true && ok.supported === true, JSON.stringify(ok));
const tooHigh = judgeCompatibility('0.3.0');
check('0.3.0 判定为超范围', tooHigh.checked === true && tooHigh.supported === false);
const tooLow = judgeCompatibility('0.1.6');
check('0.1.6 判定为超范围', tooLow.checked === true && tooLow.supported === false);
const unknown = judgeCompatibility(null);
check('未知版本 checked=false', unknown.checked === false && unknown.supported === null);

const tmp = mkdtempSync(join(tmpdir(), 'dsh-compat-'));
try {
  const pkgDir = join(tmp, 'node_modules', '@deepseek-ai', 'dsh');
  mkdirSync(join(pkgDir, 'lib'), { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.3' }));
  const entry = join(pkgDir, 'lib', 'bin.js');
  writeFileSync(entry, '// fake');
  const probed = detectDshVersion({ argv: ['node', entry], env: {} });
  check('从 argv[1] 探测版本', probed === '0.2.1-rc.3', String(probed));
  const fromEnv = detectDshVersion({ argv: ['node', entry], env: { DSH_VERSION: '0.2.1' } });
  check('DSH_VERSION 优先', fromEnv === '0.2.1', String(fromEnv));
  const nothing = detectDshVersion({ argv: ['node', join(tmp, 'no-such-bin.js')], env: {} });
  check('探测不到返回 null', nothing === null, String(nothing));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const text = describeCompatibility(ok);
check('文案含版本与范围', text.includes('0.2.1-rc.3') && text.includes(SUPPORT_FLOOR) && text.includes(SUPPORT_CEILING));
const envInfo = compatibilityInfo({ env: { DSH_VERSION: '0.2.1-rc.3' }, argv: ['node'] });
check('compatibilityInfo 走环境变量', envInfo.supported === true && envInfo.version === '0.2.1-rc.3');

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
