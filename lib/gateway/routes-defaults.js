/**
 * 设置页「一键还原默认」的数据源（挂在 DSH webServer 上，和设置页同源）。
 *
 * 一条：
 *   GET /dsh-qq-bot/defaults   返回本插件的默认配置（DEFAULTS 原样，键名与配置树一致）
 *
 * 设计要点：
 *   - **只回默认值，不回当前生效配置**。默认值是编译期常量，里面没有任何真实密钥
 *     （密钥字段的默认值是空串）；用户填过的 baseUrl / apiKey / token 一律不出现在响应里。
 *   - 还原只在浏览器侧改 draft，**不落盘**：真正写配置仍然要按设置页的「保存」，
 *     这样「还原默认」绕不过流程授权的动态码校验，也不会产生「点一下按钮配置就被改了」的意外。
 *   - webServer 不可用时静默跳过（桌面端没有该服务是正常情况），设置页的还原按钮
 *     会退化成「读不到默认值，请手动改」，不影响其它功能。
 */

import { DEFAULTS } from '../config.js';

export const DEFAULTS_PATH = '/dsh-qq-bot/defaults';

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

export function registerDefaultsRoutes(deps) {
  const webServer = deps === undefined || deps === null ? undefined : deps.webServer;
  const log = (deps !== undefined && deps !== null && typeof deps.log === 'function') ? deps.log : () => {};
  // 鉴权闸门由调用方注入（见 route-auth.js）；拿不到就放行，保持桌面端/老版本可用。
  const guard = (deps !== undefined && deps !== null && typeof deps.guard === 'function') ? deps.guard : () => true;
  if (webServer === null || webServer === undefined || typeof webServer.register !== 'function') {
    return { ok: false, error: 'webServer 服务不可用（还原默认按钮会退化为手动改）', unregister: () => {} };
  }

  const handleDefaults = async (req, res) => {
    if (guard(req, res) !== true) return;
    if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'method not allowed' }); return; }
    json(res, 200, { ok: true, defaults: DEFAULTS });
  };

  const unregisters = [];
  try {
    unregisters.push(webServer.register({ kind: 'exact', path: DEFAULTS_PATH, handler: handleDefaults }));
  } catch (error) {
    log('注册默认值路由失败：' + String(error && error.message ? error.message : error));
    for (const u of unregisters) { try { u(); } catch { /* 已卸 */ } }
    return { ok: false, error: '注册路由失败：' + String(error && error.message ? error.message : error), unregister: () => {} };
  }
  return {
    ok: true,
    unregister: () => { for (const u of unregisters) { try { u(); } catch { /* 已卸 */ } } },
  };
}
