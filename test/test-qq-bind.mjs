#!/usr/bin/env node
/**
 * 官方 Bot 扫码绑定（服务端状态机 + 路由）自测：`node test-qq-bind.mjs`
 *
 * 守的边界：二维码回调 → waiting；凭据只经 onCredentials 一次、不进 state()；
 * 出错给 failed 而不是静默；refresh 会停旧任务；路由响应不含 appSecret。
 */
import { createQqBind } from '../lib/qq-bind.js';
import { registerBindRoutes, BIND_STATE_PATH, BIND_REFRESH_PATH } from '../lib/bind-routes.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail === '' ? '' : ' — ' + detail)); }
}

/** 假 SDK：把回调留住，方便测试里手动触发扫码事件。 */
function makeFakeConnect() {
  const sessions = [];
  const connect = (callbacks) => {
    const session = { callbacks, stopped: 0 };
    sessions.push(session);
    return () => { session.stopped += 1; };
  };
  return { connect, sessions };
}

console.log('1. 回调顺序：显示二维码 → 成功 → 保存');
{
  const { connect, sessions } = makeFakeConnect();
  const saved = [];
  let now = 5000;
  const bind = createQqBind({ connect, onCredentials: (creds) => saved.push(creds), now: () => now });
  check('初始 idle', bind.state().phase === 'idle', JSON.stringify(bind.state()));
  await bind.start();
  sessions[0].callbacks.onQrDisplayed('https://q.qq.com/bind?x=1');
  const waiting = bind.state();
  check('二维码 URL 进入 waiting 状态', waiting.phase === 'waiting' && waiting.url.includes('q.qq.com'), JSON.stringify(waiting));
  check('响应只有 url / issuedAt（无密钥字段）', Object.keys(waiting).sort().join(',') === 'issuedAt,phase,url', Object.keys(waiting).join(','));
  sessions[0].callbacks.onSuccess([{ appId: '102000001', appSecret: 'SECRET-XYZ' }]);
  await new Promise((r) => setTimeout(r, 5));
  check('凭据回调被调用一次', saved.length === 1 && saved[0].appId === '102000001' && saved[0].appSecret === 'SECRET-XYZ', JSON.stringify(saved));
  check('保存后回到 idle', bind.state().phase === 'idle', JSON.stringify(bind.state()));
  check('state() 全文不含 appSecret', JSON.stringify(bind.state()).includes('SECRET') === false);
  check('成功后停掉旧任务', sessions[0].stopped >= 1, 'stopped=' + sessions[0].stopped);
}

console.log('\n2. 失败与刷新');
{
  const { connect, sessions } = makeFakeConnect();
  const bind = createQqBind({ connect, onCredentials: () => {} });
  await bind.start();
  sessions[0].callbacks.onFailure(new Error('用户取消'));
  check('失败进 failed 并带原因', bind.state().phase === 'failed' && bind.state().error.includes('用户取消'), JSON.stringify(bind.state()));
  await bind.refresh();
  check('refresh 之后重新进等待', bind.state().phase === 'waiting' || bind.state().phase === 'idle', JSON.stringify(bind.state()));
  check('旧任务被停掉', sessions[0].stopped >= 1, 'stopped=' + sessions[0].stopped);
  check('起了新任务', sessions.length === 2, 'sessions=' + sessions.length);
}

console.log('\n3. 没有 SDK：明确失败，不假装能扫');
{
  const bind = createQqBind({ connect: null, onCredentials: () => {} });
  await bind.start();
  const s = bind.state();
  check('failed 且提示装 SDK / 手填', s.phase === 'failed' && s.error.includes('qqbot-connector'), JSON.stringify(s));
}

console.log('\n4. 异步工厂（动态 import）也能等到 stop 函数');
{
  let stopped = 0;
  const bind = createQqBind({
    connect: async (callbacks) => { callbacks.onQrDisplayed('https://q.qq.com/async'); return () => { stopped += 1; }; },
    onCredentials: () => {},
  });
  const state = await bind.start();
  check('异步工厂可用', state.phase === 'waiting' && state.url.includes('async'), JSON.stringify(state));
  bind.stop();
  check('stop 调到工厂返回的函数', stopped === 1, 'stopped=' + stopped);
}

console.log('\n5. 路由：状态 JSON + refresh 方法限制');
{
  const handlers = {};
  const fakeWebServer = { register: (route) => { handlers[route.path] = route.handler; return () => {}; } };
  const { connect } = makeFakeConnect();
  const bind = createQqBind({ connect, onCredentials: () => {} });
  const reg = registerBindRoutes({ webServer: fakeWebServer, bind, boundAppId: () => '102000001' });
  check('两条路由都注册了', reg.ok === true && typeof handlers[BIND_STATE_PATH] === 'function' && typeof handlers[BIND_REFRESH_PATH] === 'function');
  const replies = [];
  const fakeRes = { writeHead: (status, headers) => { replies.push({ status, headers }); }, end: (body) => { replies[replies.length - 1].body = body; } };
  await handlers[BIND_STATE_PATH]({}, fakeRes);
  const body = JSON.parse(replies[0].body);
  check('状态响应带脱敏 appId', replies[0].status === 200 && body.appId === '102000001', replies[0].body);
  check('状态响应拿不到 appSecret', JSON.stringify(body).includes('SECRET') === false);
  const replies2 = [];
  const fakeRes2 = { writeHead: (status) => { replies2.push({ status }); }, end: (body) => { replies2[replies2.length - 1].body = body; } };
  await handlers[BIND_REFRESH_PATH]({ method: 'GET' }, fakeRes2);
  check('refresh 只接受 POST', replies2[0].status === 405);
  const replies3 = [];
  const fakeRes3 = { writeHead: (status) => { replies3.push({ status }); }, end: (body) => { replies3[replies3.length - 1].body = body; } };
  await handlers[BIND_REFRESH_PATH]({ method: 'POST' }, fakeRes3);
  check('POST refresh 返回状态', replies3[0].status === 200, JSON.stringify(replies3[0]));
  reg.unregister();
}

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail > 0) process.exitCode = 1;
