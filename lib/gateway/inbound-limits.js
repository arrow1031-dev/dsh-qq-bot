// 入站限制：滑动窗口限流、队列深度、单条长度与限流提示去重。
// 从 gateway/plugin.js 搬出（P3 2.4 第三阶段，只搬不改）：窗口表是模块内状态，
// 配置每次现取（支持热更新），提示走注入的 sendReply。
export function createInboundLimits(deps) {
  const { getConfig, sendReply } = deps;
  const inboundWindows = new Map();      // key -> [时间戳…]（滑动 60 秒窗口）
  const throttleNotifiedAt = new Map();  // 频率提示别把私聊刷成刷屏
  function limitNumber(value, fallback, min) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < min) return fallback;
    return Math.floor(number);
  }
  function inboundPerMinute() {
    const limits = getConfig().limits === undefined || getConfig().limits === null ? {} : getConfig().limits;
    return limitNumber(limits.perMinute, 20, 1);
  }
  function inboundQueueMax() {
    const limits = getConfig().limits === undefined || getConfig().limits === null ? {} : getConfig().limits;
    return limitNumber(limits.queueMax, 5, 1);
  }
  function inboundMaxChars() {
    const limits = getConfig().limits === undefined || getConfig().limits === null ? {} : getConfig().limits;
    return limitNumber(limits.maxChars, 4000, 100);
  }
  /** 滑动窗口取一个回合名额；超限返回 false（调用方只回一句提示，不进 Agent）。 */
  function takeTurnSlot(key) {
    const now = Date.now();
    const perMinute = inboundPerMinute();
    const list = (inboundWindows.get(key) === undefined ? [] : inboundWindows.get(key)).filter((at) => now - at < 60000);
    if (list.length >= perMinute) { inboundWindows.set(key, list); return false; }
    list.push(now);
    inboundWindows.set(key, list);
    // 别让这张表跟着「来过多少人」一起长：过期的 key 顺手清掉。
    if (inboundWindows.size > 500) {
      for (const [staleKey, stamps] of inboundWindows) {
        const last = stamps.length === 0 ? 0 : stamps[stamps.length - 1];
        if (now - last > 120000) inboundWindows.delete(staleKey);
      }
    }
    return true;
  }
  /** 频率提示：群里和私聊都回一句，按会话去重（同群/同人 60 秒内最多一条）。 */
  function notifyThrottled(frame, isGroup) {
    // 群里也回一句：以前直接 return，被限流的 @ 在群里等于消息人间蒸发（只加 skipped 计数）。
    // 去重键按会话算，同一个群 60 秒内最多提醒一次。
    const key = isGroup === true ? 'g' + String(frame.group_id) : String(frame.user_id);
    const now = Date.now();
    if (now - (throttleNotifiedAt.get(key) === undefined ? 0 : throttleNotifiedAt.get(key)) < 60000) return;
    throttleNotifiedAt.set(key, now);
    sendReply(frame, '（发得太快了：一分钟内最多 ' + inboundPerMinute() + ' 条，稍等一下再发）');
  }

  return { inboundPerMinute, inboundQueueMax, inboundMaxChars, takeTurnSlot, notifyThrottled };
}
