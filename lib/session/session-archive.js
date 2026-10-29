// 会话归档召回：把被 DSH 宿主「归档」的 QQ 会话在**消息触发时**拉回可见。
//
// 为什么必须做（本地 DSH 0.2.1-rc.3 实测，不是推测）：
//
//   ① `dsh-api-session-controller` 的 ArchivedSessionGate 挂在 `agent/pre-step` 上，
//      对归档会话（以及它的 subagent 后代）直接返回 `{ kind: 'reject' }` ——
//      回合以 blocked 结束，**一个模型请求都不发**。QQ 侧的表现就是
//      「消息发出去了、bot 没反应、日志里也没有报错」。
//   ② 同一个包的 `SessionController.create` 里 reusable 判定是
//      `!archivedSessionIds.includes(id) && …` —— 归档会话不会被重用。
//      插件拿着 `qqbot-group-<群号>` 去 create 时，宿主要么另建一条会话、
//      要么直接报错，历史断在旧 id 上。
//
// 所以「召回」不是给侧边栏做美化，而是 QQ 消息能不能进模型的**前置条件**，
// 必须发生在 `create` / `followup` 之前。
//
// 与参考实现（zaofan-make/dsh-qqbot 的 src/session/workspace-attach.ts）的差异：
//   那边注释写「宿主只暴露 archiveSession，没有任何 unarchive / restore」，
//   于是只能 duck-typing 直接改 `registry.state.archivedSessionIds`、兜底
//   `global.set`、再手动同步内存 state。本地 dsh-workspace 0.2.1-rc.3 的
//   registry **有正式方法 `unarchiveSession(sessionId)`**：
//     幂等（不在归档集合里直接 resolve，不写盘）、不做会话存在性校验、
//     内部走 enqueueOperation 串行队列 + setState 落盘。
//   所以这里直接调它，不碰任何内部字段，也不需要兜底写入或重试。
//
// 全 fail-soft：registry 没挂载（headless）、尚未启动、任何异常 → 只记日志
// （同一错误 60 秒内只打一次，避免每消息刷屏），绝不影响消息主链。

const REGISTRY_SERVICE = 'workspaceRegistry';

/** 归一化错误文本：宿主抛的多半是 Error，也可能是字符串。 */
function describeError(error) {
  if (error === null || error === undefined) return '未知错误';
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string' && error.message !== '') return error.message;
  return String(error);
}

/**
 * 从宿主上下文取 workspaceRegistry：`reflect.get` 优先（免 inject 读服务，
 * 与 gateway/plugin.js 的 ensureQqMsgWorkspace 同一取法），回落 `ctx.get()`。
 * 取不到返回 undefined —— 调用方据此静默降级。
 */
function getRegistry(ctx) {
  if (ctx === null || ctx === undefined) return undefined;
  try {
    if (typeof ctx.reflect?.get === 'function') {
      const viaReflect = ctx.reflect.get(REGISTRY_SERVICE);
      if (viaReflect !== undefined && viaReflect !== null) return viaReflect;
    }
  } catch { /* 服务缺失：继续试下一种取法 */ }
  try {
    if (typeof ctx.get === 'function') {
      const viaGet = ctx.get(REGISTRY_SERVICE);
      if (viaGet !== undefined && viaGet !== null) return viaGet;
    }
  } catch { /* 同上 */ }
  return undefined;
}

/** 读归档集合（getter 同步；registry 未启动时 requireState() 会抛，交给调用方 catch）。 */
function archivedList(registry) {
  const ids = registry.archivedSessionIds;
  return Array.isArray(ids) ? ids.map(String) : [];
}

/**
 * 创建归档召回器。
 *
 * @param {object} deps
 * @param {object} deps.ctx   宿主 Cordis 上下文（用来取 workspaceRegistry）
 * @param {(line: string) => void} [deps.log] 日志回调（默认丢弃）
 * @returns {{
 *   recall: (sessionId: unknown, reason?: string) => Promise<boolean>,
 *   isArchived: (sessionId: unknown) => boolean,
 *   stats: { recalled: number, failed: number, unavailable: number, lastRecalledId: string, lastError: string },
 * }}
 */
export function createSessionArchive(deps) {
  const ctx = (deps !== null && deps !== undefined) ? deps.ctx : undefined;
  const log = (deps !== null && deps !== undefined && typeof deps.log === 'function') ? deps.log : () => {};
  const stats = { recalled: 0, failed: 0, unavailable: 0, lastRecalledId: '', lastError: '' };

  // 失败日志去重：同一行 60 秒内只打一次。归档召回失败不该比消息本身更吵。
  let lastFailureLine = '';
  let lastFailureAt = 0;
  function logFailure(line) {
    const now = Date.now();
    if (line === lastFailureLine && now - lastFailureAt < 60000) return;
    lastFailureLine = line;
    lastFailureAt = now;
    log(line);
  }

  /**
   * 只读探测：这个会话当前是否在宿主的归档集合里。
   * 取不到 registry / 读不到集合一律按「没归档」处理（不拦消息）。
   */
  function isArchived(sessionId) {
    const registry = getRegistry(ctx);
    if (registry === undefined) return false;
    try {
      return archivedList(registry).includes(String(sessionId));
    } catch {
      return false;
    }
  }

  /**
   * 把一个会话从「归档」里拉回来（幂等）。
   *
   * 语义与参考实现一致：**不是「归档动作秒级弹回」，而是「会话被触发时弹回」**——
   * 主人主动归档的会话保持归档，只有 QQ 消息真正触发它时才解除。所以这里既不
   * 拦归档动作，也不跑定时巡检。
   *
   * @param {unknown} sessionId 会话 id（与 sessionController.create 用的那个一致）
   * @param {string} [reason] 触发原因，只用于日志
   * @returns {Promise<boolean>} true = 本次真的从归档里摘掉了
   */
  async function recall(sessionId, reason) {
    const id = String(sessionId);
    const registry = getRegistry(ctx);
    if (registry === undefined || typeof registry.unarchiveSession !== 'function') {
      // headless profile / 宿主没挂 workspaceRegistry：根本没有归档概念，放过。
      stats.unavailable += 1;
      stats.lastError = 'no-workspaceRegistry';
      return false;
    }
    let archived;
    try {
      archived = archivedList(registry);
    } catch (error) {
      // 宿主 registry 还没启动（requireState 抛 "workspace registry is not started yet"）。
      // 这时归档集合读不到，也就无所谓召回；不记失败，下一条消息再试。
      stats.unavailable += 1;
      stats.lastError = describeError(error);
      return false;
    }
    // 绝大多数消息走这里：一次数组包含判断，不碰写盘、不进宿主的串行队列。
    if (archived.includes(id) !== true) return false;
    try {
      await registry.unarchiveSession(id);
      stats.recalled += 1;
      stats.lastRecalledId = id;
      stats.lastError = '';
      log('会话 ' + id + ' 原本在「归档」里，已按触发消息召回' + (reason ? '（' + reason + '）' : ''));
      return true;
    } catch (error) {
      // fail-soft：召回失败绝不影响会话使用（下次消息还会再试）。
      stats.failed += 1;
      stats.lastError = describeError(error);
      logFailure('会话 ' + id + ' 归档召回失败（不影响收发主链，下次触发重试）：' + describeError(error));
      return false;
    }
  }

  return { recall, isArchived, stats };
}
