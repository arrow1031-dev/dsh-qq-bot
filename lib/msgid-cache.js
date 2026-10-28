/**
 * 入站消息去重：按 message_id 记最近见过的 id。
 *
 * 起因是消化 tencent-connect/dsh-qqbot（MIT）的 msgid-cache：官方 Bot 的 WS 在 resume/重连后
 * 会重放少量事件，webhook 也可能重投；不去重就会对同一条消息起两个回合（回复两次、额度双花）。
 *
 * 实现按本仓库口味：纯内存、有界（LRU 语义：超上限淘汰最旧的），带 TTL（默认 10 分钟），
 * 时间可注入以便单测。不落盘——重启后最多重复一次，比误杀真实消息可接受。
 */

/**
 * @param {object} [options]
 * @param {number} [options.max]   最多记多少条（默认 512）
 * @param {number} [options.ttlMs] 单条保留时长（默认 10 分钟）
 * @param {() => number} [options.now]
 */
export function createMsgIdCache(options = {}) {
  const max = Math.max(16, Math.floor(Number(options.max) || 512));
  const ttlMs = Math.max(1000, Math.floor(Number(options.ttlMs) || 10 * 60 * 1000));
  const now = (typeof options.now === 'function') ? options.now : () => Date.now();
  /** @type {Map<string, number>} id -> expiresAt（按插入顺序，Map 天然是 LRU 的插入序） */
  const seenIds = new Map();

  function prune(at) {
    for (const [id, expiresAt] of seenIds) {
      if (expiresAt > at) break;
      seenIds.delete(id);
    }
    while (seenIds.size > max) {
      const oldest = seenIds.keys().next();
      if (oldest.done === true) break;
      seenIds.delete(oldest.value);
    }
  }

  /**
   * 记录并判断：第一次见到返回 false（不重复），再次见到返回 true（重复，应丢弃）。
   * 同一个 id 被重复调用不会延长 TTL——重复消息不该把窗口顶长。
   */
  function hit(id) {
    const key = String(id === undefined || id === null ? '' : id).trim();
    if (key === '') return false;
    const at = now();
    const expiresAt = seenIds.get(key);
    if (expiresAt !== undefined && expiresAt > at) return true;
    if (expiresAt !== undefined) seenIds.delete(key);
    seenIds.set(key, at + ttlMs);
    prune(at);
    return false;
  }

  return {
    hit,
    size: () => seenIds.size,
    clear: () => seenIds.clear(),
  };
}
