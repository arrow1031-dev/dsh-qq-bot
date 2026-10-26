/** 单元测试：lib/config.js —— DEFAULTS / plainConfig（volatile 还原）/ mergeConfig / describeError */
import { DEFAULTS, plainConfig, mergeConfig, staleConfigPaths, describeError } from '../lib/config.js';

const results = [];
let failures = 0;
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok));
  if (ok) console.log('  [PASS] ' + name);
  else { failures += 1; console.log('  [FAIL] ' + name + (detail ? ' — ' + detail : '')); }
};

console.log('1. DEFAULTS 默认值');
check('连接默认 forward + 默认 wsUrl', DEFAULTS.mode === 'forward' && DEFAULTS.onebot.wsUrl === 'ws://127.0.0.1:3001');
check('群聊默认仅 @ 响应', DEFAULTS.group.enabled === true && DEFAULTS.group.requireAt === true && Array.isArray(DEFAULTS.group.allow) && DEFAULTS.group.allow.length === 0);
check('访客白名单默认含 qq_history（不含 web_fetch）', Array.isArray(DEFAULTS.auth.guestToolAllow) && DEFAULTS.auth.guestToolAllow.includes('qq_history') && !DEFAULTS.auth.guestToolAllow.includes('web_fetch'));

console.log('2. plainConfig：volatile 引用还原成普通对象');
const vref = (val) => { const ref = { get: () => val }; ref[Symbol.for('cosmokit.volatile.write')] = true; return ref; };
check('顶层 volatile 引用还原', plainConfig(vref({ a: 1, b: 'x' })).a === 1 && plainConfig(vref({ a: 1, b: 'x' })).b === 'x');
check('嵌套对象里的 volatile 引用还原', (() => { const out = plainConfig({ auth: vref({ guestToolAllow: ['qq_history'] }) }); return out.auth.guestToolAllow.includes('qq_history'); })());
check('数组元素递归还原', (() => { const out = plainConfig([vref(1), vref('a'), { k: vref(2) }]); return out[0] === 1 && out[1] === 'a' && out[2].k === 2; })());

console.log('3. mergeConfig：深合并/数组覆盖/undefined 跳过');
check('两层深合并保留 base 未覆盖字段', (() => { const out = mergeConfig({ a: 1, group: { enabled: true, requireAt: true } }, { group: { requireAt: false } }); return out.a === 1 && out.group.enabled === true && out.group.requireAt === false; })());
check('数组整体覆盖（非合并）', (() => { const out = mergeConfig({ allow: [1, 2] }, { allow: [3] }); return Array.isArray(out.allow) && out.allow.length === 1 && out.allow[0] === 3; })());
check('undefined 跳过、标量覆盖', (() => { const out = mergeConfig({ a: 1, b: 2 }, { a: undefined, b: 9 }); return out.a === 1 && out.b === 9; })());
check('null override 直接生效', (() => { const out = mergeConfig({ a: 1 }, { a: null }); return out.a === null; })());

console.log('4. describeError');
check('Error 取 message / 字符串原样 / null 兜底', describeError(new Error('boom')) === 'boom' && describeError('直接文本') === '直接文本' && describeError(null) === 'null');

console.log('8. staleConfigPaths：找出 schema 不认识的键（版本升级删字段后的残留）');
check('干净配置没有废弃键', staleConfigPaths({ proactive: { enabled: true, groups: ['1'] }, onebot: { wsUrl: 'ws://a' } }).length === 0);
check('单个废弃键能被认出（返回键名数组）',
  JSON.stringify(staleConfigPaths({ proactive: { judgeProvider: 'uymu' } })) === '[["proactive","judgeProvider"]]');
check('整段不认识的子树只报最浅的一层', JSON.stringify(staleConfigPaths({ legacy: { a: 1, b: { c: 2 } } })) === '[["legacy"]]');
check('键名本身带点也不会被拆成嵌套路径',
  JSON.stringify(staleConfigPaths({ 'onebot.wsUrl': 'x' })) === '[["onebot.wsUrl"]]');
check('DEFAULTS 里每个键都是 schema 认识的（防默认值与 schema 漂移）',
  staleConfigPaths(DEFAULTS).length === 0,
  JSON.stringify(staleConfigPaths(DEFAULTS)));
check('空对象不算废弃（只是没写过）', staleConfigPaths({ restart: {} }).length === 0);
check('数组整体算叶子，不检查里面的键', staleConfigPaths({ proactive: { groups: ['a', 'b'] } }).length === 0);
check('非对象入参返回空', staleConfigPaths(null).length === 0 && staleConfigPaths([1, 2]).length === 0 && staleConfigPaths('x').length === 0);

console.log('9. staleConfigPaths 的两个边界（评审提出，曾会破坏用户配置）');
{
  // !!js 表达式在 DSH 配置里是合法值，解析出来是类实例；当成「未知子键」删掉会把表达式换成默认值。
  class JsExpr { constructor(source) { this.source = source; } }
  check('已知键上的 !!js 表达式不被当成废弃子键',
    staleConfigPaths({ mode: new JsExpr('x'), auth: new JsExpr('y') }).length === 0,
    JSON.stringify(staleConfigPaths({ mode: new JsExpr('x'), auth: new JsExpr('y') })));
  check('带 symbol 标记的表达式包装也不被拆', (() => {
    const tag = Symbol('expr');
    const wrapped = { [tag]: true, value: 1 };
    return staleConfigPaths({ auth: wrapped }).length === 0;
  })());
  check('DSH 的 !!js 表达式包装键（__jsExpr）不算废弃子键',
    staleConfigPaths({ flowAuth: { __jsExpr: 'x', enabled: true }, legacy: { __jsExpr: 'y' } }).length === 1,
    JSON.stringify(staleConfigPaths({ flowAuth: { __jsExpr: 'x', enabled: true }, legacy: { __jsExpr: 'y' } })));
  check('未知键的值是 null 也算残留（以前永远清不掉）',
    JSON.stringify(staleConfigPaths({ legacy: null })) === '[["legacy"]]');
  const cleanDefaults = staleConfigPaths(DEFAULTS);
  check('加了表达式跳过之后，DEFAULTS 仍然没有废弃键', cleanDefaults.length === 0, JSON.stringify(cleanDefaults));
}

const passed = results.filter(Boolean).length;
console.log('\n' + passed + '/' + results.length + ' 项通过');
if (failures > 0) { console.log('配置自测失败'); process.exit(1); }
console.log('配置自测通过');
process.exit(0);
