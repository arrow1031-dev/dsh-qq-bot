/**
 * 设置页模板的数据源（挂在 DSH webServer 上，和设置页同源）。
 *
 * 一条：
 *   GET /dsh-qq-bot/settings   返回整页模板：标签页骨架 + 全部字段
 *
 * 为什么要有这条路由：设置页的字段定义不再写死在客户端 bundle 里，而是散在
 * 各所有者目录的 `-set.json`（`lib/tools/*-set.json`、`lib/valve/<阀门>/*-set.json`）。
 * 客户端 bundle 读不到 lib/ 下的文件（它只允许 `require('react')`），所以由服务端
 * 在加载期组装好，运行时按需下发。
 *
 * 设计要点：
 *   - **只回模板，不回配置值**。字段里没有 label 之外的用户数据；默认值走 /defaults 那条。
 *   - 模板是加载期常量，组装时就已校验过（路径在 schema 里、标签页存在），
 *     所以这里不会再出错——真出错会在插件启动时就抛出来。
 *   - 加一个字段 = 改对应 `-set.json`，不用碰客户端代码，也不用重新打包。
 *   - webServer 不可用时静默跳过（桌面端没有该服务是正常情况），
 *     设置页会退化成「读不到模板，请检查插件版本」，不影响其它功能。
 */

import { SETTINGS_TABS, SETTINGS_FIELDS, SETTINGS_SOURCES } from '../config.js';

export const SETTINGS_PATH = '/dsh-qq-bot/settings';

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

export function registerSettingsRoutes(deps) {
  const webServer = deps === undefined || deps === null ? undefined : deps.webServer;
  const log = (deps !== undefined && deps !== null && typeof deps.log === 'function') ? deps.log : () => {};
  if (webServer === null || webServer === undefined || typeof webServer.register !== 'function') {
    return { ok: false, error: 'webServer 服务不可用（设置页会退化成读不到模板）', unregister: () => {} };
  }

  const handleSettings = async (req, res) => {
    if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'method not allowed' }); return; }
    json(res, 200, {
      ok: true,
      tabs: SETTINGS_TABS,
      fields: SETTINGS_FIELDS,
      // 只给「哪个文件贡献了几个字段」，方便排错；不含任何配置值。
      sources: SETTINGS_SOURCES,
    });
  };

  const unregisters = [];
  try {
    unregisters.push(webServer.register({ kind: 'exact', path: SETTINGS_PATH, handler: handleSettings }));
  } catch (error) {
    log('注册设置页模板路由失败：' + String(error && error.message ? error.message : error));
    for (const u of unregisters) { try { u(); } catch { /* 已卸 */ } }
    return { ok: false, error: '注册路由失败：' + String(error && error.message ? error.message : error), unregister: () => {} };
  }
  return {
    ok: true,
    unregister: () => { for (const u of unregisters) { try { u(); } catch { /* 已卸 */ } } },
  };
}
