#!/usr/bin/env node
/**
 * 入站去重自测：`node test-msgid-cache.mjs`
 *
 * 守的是「重连/重投下的消息只起一个回合」：第一次 false，重复 true；TTL 过期后可再次接受；
 * 超上限按最旧淘汰；空 id 不当重复；时间可注入。
 */
import { createMsgIdCache } from '../lib/msgid-cache.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail === '' ? '' : ' — ' + detail)); }
}

console.log('1. 基本语义：首见 false，复见 true');
{
  let now = 1000;
  const cache = createMsgIdCache({ now: () => now });
  check('第一次不重复', cache.hit('m1') === false);
  check('第二次是重复', cache.hit('m1') === true);
  check('不同 id 互不影响', cache.hit('m2') === false);
}

console.log('\n2. TTL 过期后可再次接受');
{
  let now = 1000;
  const cache = createMsgIdCache({ ttlMs: 5000, now: () => now });
  cache.hit('m1');
  now += 4000;
  check('窗口内仍判重复', cache.hit('m1') === true);
  now += 2000;  // 超过 5000
  check('过期后不再判重复', cache.hit('m1') === false);
}

console.log('\n3. 有界：超上限淘汰最旧');
{
  let now = 1000;
  const cache = createMsgIdCache({ max: 16, now: () => now });
  for (let i = 0; i < 20; i += 1) { cache.hit('m' + i); now += 1; }
  check('大小不超过上限', cache.size() <= 16, 'size=' + cache.size());
  check('最旧的已被淘汰', cache.hit('m0') === false);
  check('最新的仍在', cache.hit('m19') === true);
}

console.log('\n4. 边界与健壮性');
{
  const cache = createMsgIdCache({ now: () => 1 });
  check('空 id 不判重复', cache.hit('') === false && cache.hit(null) === false && cache.hit(undefined) === false);
  check('空 id 不占空间', cache.size() === 0);
  check('数字 id 当字符串处理', cache.hit(12345) === false && cache.hit('12345') === true);
  check('重复命中不延长 TTL', (() => {
    let now = 0;
    const c = createMsgIdCache({ ttlMs: 1000, now: () => now });
    c.hit('x');
    now = 500;
    c.hit('x');
    now = 1100;
    return c.hit('x') === false;
  })());
  cache.clear();
  check('clear 后从头开始', cache.hit('12345') === false);
}

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail > 0) process.exitCode = 1;
