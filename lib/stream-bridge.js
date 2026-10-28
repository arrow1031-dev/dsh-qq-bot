/**
 * 流式增量桥（仅 QQ 官方 v2 私聊）。
 *
 * 官方开放平台只对 C2C 私聊开放 stream_messages，所以这里做成**特有能力**：
 *   - 只在 protocol=qq-official、私聊、且 protocols.qqOfficial.streaming 打开时启用；
 *   - 其它协议/群聊拿到的是同一份文本缓冲，但不会发出任何流式请求（不假装支持）。
 *
 * 设计（对应官方 SDK 的 StreamingWriter）：
 *   - 增量按 throttleMs 合并：每次只发「当前全文」，不是 delta（官方 input_mode=replace）；
 *   - 回合结束时发一帧 done，收尾并清状态；
 *   - 发送失败只记一行日志并停用该会话的流式，避免每 500ms 刷一次错误；
 *   - 计时器可注入，纯逻辑可单测（不碰网络）。
 */

/**
 * @param {object} deps
 * @param {(target: {messageType: string, targetId: string, msgId: string, text: string, done: boolean}) => Promise<{ok: boolean, error?: string}>} deps.send
 * @param {(line: string) => void} [deps.log]
 * @param {number} [deps.throttleMs] 最小发送间隔（默认 600ms，官方建议 ≥300）
 * @param {() => number} [deps.now]
 * @param {(fn: () => void, ms: number) => any} [deps.setTimer]
 * @param {(handle: any) => void} [deps.clearTimer]
 */
export function createStreamBridge(deps) {
  const send = deps.send;
  const log = (typeof deps.log === 'function') ? deps.log : () => {};
  const throttleMs = Math.max(300, Math.floor(Number(deps.throttleMs) || 600));
  const now = (typeof deps.now === 'function') ? deps.now : () => Date.now();
  const setTimer = (typeof deps.setTimer === 'function') ? deps.setTimer : ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = (typeof deps.clearTimer === 'function') ? deps.clearTimer : ((handle) => clearTimeout(handle));

  /** key -> { target, text, timer, lastSentAt, ended } */
  const sessions = new Map();

  function stateOf(key) {
    let st = sessions.get(key);
    if (st === undefined) {
      st = { target: null, text: '', timer: null, lastSentAt: 0, ended: false };
      sessions.set(key, st);
    }
    return st;
  }

  function schedule(key, st) {
    if (st.timer !== null || st.ended === true) return;
    const wait = Math.max(0, throttleMs - (now() - st.lastSentAt));
    st.timer = setTimer(() => {
      st.timer = null;
      void flush(key, st, false);
    }, wait);
  }

  async function flush(key, st, done) {
    if (st.target === null) return;
    const text = st.text;
    if (text === '' && done !== true) return;
    st.lastSentAt = now();
    const target = st.target;
    try {
      const result = await send({ messageType: target.messageType, targetId: target.targetId, msgId: target.msgId, text, done });
      if (result !== null && result !== undefined && result.ok !== true) {
        log('流式消息发送失败，本会话停止流式（' + String(result.error || '未知错误') + '）');
        stop(key);
      }
    } catch (error) {
      log('流式消息异常，本会话停止流式：' + String(error && error.message ? error.message : error));
      stop(key);
    }
  }

  function stop(key) {
    const st = sessions.get(key);
    if (st === undefined) return;
    if (st.timer !== null) { clearTimer(st.timer); st.timer = null; }
    sessions.delete(key);
  }

  return {
    /** 追加一段增量（第一次必须带 target） */
    push(key, target, delta) {
      const st = stateOf(key);
      if (st.ended === true) return;
      if (target !== null && target !== undefined) st.target = target;
      if (typeof delta === 'string' && delta !== '') st.text += delta;
      schedule(key, st);
    },
    /** 回合结束：立刻发最后一帧（done=true）并清理 */
    async end(key) {
      const st = sessions.get(key);
      if (st === undefined) return;
      st.ended = true;
      if (st.timer !== null) { clearTimer(st.timer); st.timer = null; }
      await flush(key, st, true);
      sessions.delete(key);
    },
    /** 主动放弃（例如回合被取消） */
    cancel(key) { stop(key); },
    size: () => sessions.size,
  };
}
