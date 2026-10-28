/**
 * 扫码绑定的 HTTP 路由（挂在 DSH webServer 上，和设置页同源）。
 *
 * 两条：
 *   GET  /dsh-qq-bot/bind          读取绑定状态（waiting 时带二维码 URL；不返回任何密钥）
 *   POST /dsh-qq-bot/bind/refresh  重新生成二维码
 *
 * 设计要点（参照官方文档实现，风格按本仓库习惯）：
 *   - appSecret 只在 onCredentials 回调里经过一次，写进设置服务；HTTP 响应永远只有 appId；
 *   - 路由可用性由 webServer 服务决定：桌面/Web 都有具名路由能力，拿不到就静默跳过（手动填表单照旧）。
 */

export const BIND_STATE_PATH = '/dsh-qq-bot/bind';
export const BIND_REFRESH_PATH = '/dsh-qq-bot/bind/refresh';

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

export function registerBindRoutes(deps) {
  const webServer = deps.webServer;
  const bind = deps.bind;
  const boundAppId = (typeof deps.boundAppId === 'function') ? deps.boundAppId : () => '';
  const log = (typeof deps.log === 'function') ? deps.log : () => {};
  // 鉴权闸门由调用方注入（它需要 ctx 才能拿到 DSH 的浏览器 cookie 校验器，见 route-auth.js）。
  const guard = (typeof deps.guard === 'function') ? deps.guard : () => true;
  if (webServer === null || webServer === undefined || typeof webServer.register !== 'function') {
    return { ok: false, error: 'webServer 服务不可用（扫码绑定按钮会退化为手动填表）', unregister: () => {} };
  }
  const handleState = async (req, res) => {
    // waiting 阶段会把「可用的扫码登录 URL」原样交出去，所以必须先过鉴权（2026-10-28 审计 B1）。
    if (guard(req, res) !== true) return;
    if (req.method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return; }
    json(res, 200, Object.assign({}, bind.state(), { appId: boundAppId() }));
  };
  const handleRefresh = async (req, res) => {
    if (guard(req, res) !== true) return;
    if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return; }
    try {
      const next = await bind.refresh();
      json(res, 200, Object.assign({}, next, { appId: boundAppId() }));
    } catch (error) {
      json(res, 500, { phase: 'failed', error: String(error && error.message ? error.message : error) });
    }
  };
  const unregisters = [];
  try {
    unregisters.push(webServer.register({ kind: 'exact', path: BIND_STATE_PATH, handler: handleState }));
    unregisters.push(webServer.register({ kind: 'exact', path: BIND_REFRESH_PATH, handler: handleRefresh }));
  } catch (error) {
    log('注册扫码绑定路由失败：' + String(error && error.message ? error.message : error));
    for (const u of unregisters) { try { u(); } catch { /* 已卸 */ } }
    return { ok: false, error: '注册路由失败：' + String(error && error.message ? error.message : error), unregister: () => {} };
  }
  return {
    ok: true,
    unregister: () => { for (const u of unregisters) { try { u(); } catch { /* 已卸 */ } } },
  };
}
