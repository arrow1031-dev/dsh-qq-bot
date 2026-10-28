/**
 * 本插件 HTTP 路由的鉴权闸门。
 *
 * 为什么需要它：插件用 `webServer.register` 挂的具名路由**在 DSH 的鉴权层之前**就被处理了，
 * 于是 `GET /` 和 `GET /api/settings` 回 401，而 `GET /dsh-qq-bot/settings` 回 200
 * （2026-10-28 审计 B1，已实测）。这本身是 DSH 的设计——具名路由交给插件自己负责——
 * 但插件以前一条都没管，后果是：
 *   - `/dsh-qq-bot/bind` 在扫码等待期会把**可用的登录 URL** 原样交给任何能连到这个端口的人；
 *   - `POST /dsh-qq-bot/bind/refresh` 谁都能调，可以反复重启绑定流程做 DoS；
 *   - 设置页模板与默认值对未登录者可见（不含密钥，但没必要公开）。
 *
 * 怎么验：DSH 把浏览器鉴权做成「绑定 authority 的签名 cookie」，由 `client-connection`
 * 服务持有（`HostConnectionService.browserAuth.isAuthenticated(req, secure)`）。
 * 插件通过 `ctx.get('client-connection')` 拿它，比自己猜 cookie 名、自己验签要正确得多。
 *
 * 降级策略（重要）：
 *   - 服务或方法拿不到（老版本 DSH / 桌面端）→ **放行**并只告警一次。理由：那种环境里
 *     DSH 自己也没有鉴权层，插件加一道只会把设置页彻底锁死，安全性并没有净收益。
 *   - 能拿到就严格判定：验签失败一律 401。
 *   - 额外做同源校验（Origin / Referer 与 Host 不一致就拒）：浏览器发起的跨站请求挡在
 *     最前面，与 cookie 校验互补。两者都不带时（curl）交给 cookie 判定。
 */

/** 与 DSH 自己回的那句保持一致，便于排障时一眼认出是「没登录」而不是「插件坏了」。 */
const UNAUTHORIZED_TEXT = 'dsh web authentication required; reopen the URL printed by dsh web.\n';

function deny(res) {
  try {
    res.writeHead(401, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' });
    res.end(UNAUTHORIZED_TEXT);
  } catch { /* 响应已经发出去 */ }
}

/** Origin / Referer（带了的那些）必须与 Host 同源；都没带视为「不是浏览器跨站请求」。 */
function sameOrigin(req) {
  const headers = (req !== null && req !== undefined && req.headers !== null && req.headers !== undefined) ? req.headers : {};
  const host = String(headers.host === undefined || headers.host === null ? '' : headers.host);
  if (host === '') return false;
  const check = (raw) => {
    if (raw === undefined || raw === null || raw === '') return true;
    const text = String(raw);
    if (text === 'null') return false;
    try { return new URL(text).host === host; } catch { return false; }
  };
  return check(headers.origin) === true && check(headers.referer) === true;
}

/**
 * 造一个 `(req, res) => boolean` 的闸门：true = 放行，false = 已经回了 401。
 *
 * @param {Record<string, any>} ctx 插件上下文（用来取 client-connection / webServer）
 * @param {(line: string) => void} [log]
 * @returns {(req: any, res: any) => boolean}
 */
export function createRouteGuard(ctx, log) {
  const say = (typeof log === 'function') ? log : () => {};
  let warned = false;

  const browserAuthOf = () => {
    try {
      const connection = (typeof ctx.get === 'function') ? ctx.get('client-connection') : undefined;
      const auth = (connection !== null && connection !== undefined) ? connection.browserAuth : undefined;
      if (auth !== null && auth !== undefined && typeof auth.isAuthenticated === 'function') return auth;
    } catch { /* 服务不可用：走降级 */ }
    return null;
  };

  const isSecure = () => {
    try {
      const server = (typeof ctx.get === 'function') ? ctx.get('webServer') : undefined;
      return (server !== null && server !== undefined && server.protocol === 'https:');
    } catch { return false; }
  };

  return (req, res) => {
    if (sameOrigin(req) !== true) { deny(res); return false; }
    const auth = browserAuthOf();
    if (auth === null) {
      if (warned !== true) {
        warned = true;
        say('拿不到 client-connection 的浏览器鉴权：HTTP 路由只做同源校验（这个 DSH 版本没有该服务，等同它自己也没鉴权）');
      }
      return true;
    }
    let authed = false;
    try { authed = auth.isAuthenticated(req, isSecure()) === true; } catch { authed = false; }
    if (authed !== true) { deny(res); return false; }
    return true;
  };
}
