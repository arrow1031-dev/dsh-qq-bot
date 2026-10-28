/**
 * 适配器与插件之间的 stdio 契约（换行分隔 JSON）。
 *
 * 出（适配器 -> 插件）：hello / status / message / notice / request / heartbeat /
 *                       listening / send_result / action_result / log / error / pong
 * 入（插件 -> 适配器）：send / action / ping / shutdown
 *
 * 所有协议适配器都实现同一套帧，插件侧（lib/index.js）因此与协议无关。
 */
import process from 'node:process';

export function createEmitter() {
  const emit = (frame) => {
    try { process.stdout.write(JSON.stringify(frame) + '\n'); } catch { /* 父进程没了 */ }
  };
  return {
    emit,
    log: (text, level = 'info') => emit({ type: 'log', level, text: String(text) }),
    fail: (text) => emit({ type: 'error', text: String(text) }),
  };
}

const sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); if (t.unref) t.unref(); });

/**
 * 串行发送队列：协议侧只提供 send(action, params) -> Promise<result>，
 * 队列负责节流与 send_result 回报。
 * @param {object} options
 * @param {number} options.gapMs 两次发送之间的最小间隔
 * @param {(action: string, params: Record<string, any>) => Promise<Record<string, any>>} options.send
 * @param {(frame: Record<string, any>) => void} options.emit
 */
export function createSendQueue({ gapMs = 350, send, emit }) {
  const queue = [];
  let running = false;
  let lastAt = 0;

  async function pump() {
    running = true;
    try {
      while (queue.length > 0) {
        const job = queue.shift();
        const wait = gapMs - (Date.now() - lastAt);
        if (wait > 0) await sleep(wait);
        let result;
        try {
          result = await send(job.action, job.params);
        } catch (error) {
          result = { ok: false, error: String(error && error.message ? error.message : error) };
        }
        lastAt = Date.now();
        emit({
          type: 'send_result',
          ok: result.ok === true,
          echo: job.echo ?? null,
          message_id: result.messageId ?? null,
          error: result.ok === true ? null : (result.error ?? '未知错误'),
          retcode: result.retcode ?? null,
        });
      }
    } finally {
      running = false;
    }
  }

  return {
    enqueue(job) {
      queue.push(job);
      if (!running) void pump();
    },
  };
}

/**
 * 读 stdin 的命令循环。
 * @param {object} options
 * @param {(command: Record<string, any>) => void} options.onCommand 每条命令（send/action 由适配器处理）
 * @param {(code: number) => void} options.onShutdown
 * @param {(text: string) => void} options.onError
 * @param {() => void} options.onPing 收到 ping 命令（无参调用，参数从未传入）
 */
export function installStdin({ onCommand, onShutdown, onError, onPing }) {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line === '') continue;
      let command;
      try { command = JSON.parse(line); }
      catch { onError('JSON 解析失败：' + line.slice(0, 200)); continue; }
      if (command !== null && typeof command === 'object') {
        if (command.type === 'ping') { onPing(); continue; }
        if (command.type === 'shutdown') { onShutdown(0); return; }
      }
      try { onCommand(command); }
      catch (error) { onError(String(error && error.stack ? error.stack : error)); }
    }
  });
  process.stdin.on('end', () => onShutdown(0));
}

/** 进程级兜底：信号、未捕获异常。 */
export function installCrashHandlers({ onShutdown, onError }) {
  process.on('SIGTERM', () => onShutdown(0));
  process.on('SIGINT', () => onShutdown(0));
  process.on('uncaughtException', (error) => onError('未捕获异常：' + (error && error.stack ? error.stack : error)));
  process.on('unhandledRejection', (reason) => {
    // Node 类型把 reason 标成 unknown；运行期它是任意被 reject 的值（可能是 Error，也可能是字符串）。
    const rejection = /** @type {any} */ (reason);
    onError('未处理的 rejection：' + (rejection && rejection.stack ? rejection.stack : rejection));
  });
}

/** 带超时的 JSON POST（OneBot/Satori/Milky 的 HTTP API 都用它）。 */
export async function postJson(url, headers, body, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (timer.unref) timer.unref();
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
      body: JSON.stringify(body === undefined ? {} : body),
      signal: controller.signal,
    });
  } finally { clearTimeout(timer); }
  const text = await response.text();
  let data = null;
  if (text.length > 0) { try { data = JSON.parse(text); } catch { data = null; } }
  return { status: response.status, ok: response.ok, text, data };
}
