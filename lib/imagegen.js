// 生图引擎（qq_draw）：调用用户自填的 OpenAI 兼容图片接口。
// 纯逻辑 + 少量 IO（存盘 / 参考图读取），不依赖 Cordis，便于单测。
// 能力：失败重试（429 / 5xx / 网络错 / 空结果）+ 异步任务轮询（供应商返回 task_id 时）。
import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';

const DONE_WORDS = ['succeeded', 'success', 'completed', 'complete', 'done', 'finished'];
const FAILED_WORDS = ['failed', 'failure', 'error', 'canceled', 'cancelled'];

export function trimBaseUrl(baseUrl) {
  const text = (baseUrl === undefined || baseUrl === null) ? '' : String(baseUrl);
  return text.trim().replace(/\/+$/, '');
}

export function generationsUrl(baseUrl) {
  const base = trimBaseUrl(baseUrl);
  return base === '' ? '' : base + '/images/generations';
}

function imageFrom(item) {
  if (item === null || item === undefined || typeof item !== 'object') return null;
  if (typeof item.b64_json === 'string' && item.b64_json !== '') return { kind: 'image', b64: item.b64_json };
  if (typeof item.image_base64 === 'string' && item.image_base64 !== '') return { kind: 'image', b64: item.image_base64 };
  if (typeof item.url === 'string' && item.url !== '') return { kind: 'image', url: item.url };
  if (typeof item.image_url === 'string' && item.image_url !== '') return { kind: 'image', url: item.image_url };
  return null;
}

/** 解析一次生图响应：拿到图片 / 拿到任务 id / 报错。 */
export function parseImagePayload(payload) {
  if (payload === null || payload === undefined || typeof payload !== 'object') {
    return { kind: 'error', error: '响应不是 JSON 对象' };
  }
  if (payload.error !== undefined && payload.error !== null) {
    const err = payload.error;
    const text = typeof err === 'string' ? err : (err.message !== undefined ? String(err.message) : JSON.stringify(err));
    return { kind: 'error', error: text.slice(0, 300) };
  }
  const first = Array.isArray(payload.data) ? payload.data[0] : null;
  const direct = imageFrom(first) || imageFrom(payload)
    || (Array.isArray(payload.images) ? imageFrom(payload.images[0]) : null);
  if (direct !== null) return direct;

  const rawStatus = payload.status !== undefined ? payload.status : payload.task_status;
  const status = String(rawStatus === undefined || rawStatus === null ? '' : rawStatus).toLowerCase();
  let taskId = payload.task_id;
  if (taskId === undefined || taskId === null || taskId === '') taskId = payload.id;
  if ((taskId === undefined || taskId === null || taskId === '')
    && payload.data !== null && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
    taskId = payload.data.task_id !== undefined ? payload.data.task_id : payload.data.id;
  }
  if (taskId !== undefined && taskId !== null && taskId !== '') {
    return { kind: 'task', taskId: String(taskId), status };
  }
  if (DONE_WORDS.indexOf(status) >= 0) {
    return { kind: 'error', error: '任务已完成但响应里没有图片（检查接口返回格式）' };
  }
  if (FAILED_WORDS.indexOf(status) >= 0) {
    return { kind: 'error', error: '任务失败：' + (payload.message === undefined ? status : payload.message) };
  }
  return { kind: 'error', error: '响应里没有图片：' + JSON.stringify(payload).slice(0, 200) };
}

/** 参考图 → 接口能吃的字符串：公网 URL 原样传，本地文件转 data URL（限 qq-images 目录）。 */
export async function referenceToDataUrl(reference, allowDir) {
  const text = String(reference === undefined || reference === null ? '' : reference).trim();
  if (text === '') return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (typeof allowDir === 'string' && allowDir !== '' && text.indexOf(allowDir) !== 0) {
    throw new Error('reference 只允许 qq-images 目录下的本地图片');
  }
  const bytes = await fsPromises.readFile(text);
  const lower = text.toLowerCase();
  const mime = (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) ? 'image/jpeg'
    : lower.endsWith('.webp') ? 'image/webp'
      : lower.endsWith('.gif') ? 'image/gif' : 'image/png';
  return 'data:' + mime + ';base64,' + bytes.toString('base64');
}

/** 收图存盘，返回绝对路径。 */
export async function saveImage(dir, bytes) {
  await fsPromises.mkdir(dir, { recursive: true });
  const name = 'draw_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.png';
  const file = join(dir, name);
  await fsPromises.writeFile(file, bytes);
  return file;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function requestJson(fetchImpl, url, init, timeoutMs) {
  const controller = (typeof AbortController === 'function') ? new AbortController() : null;
  const timer = controller === null ? null : setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    const options = Object.assign({}, init);
    if (controller !== null) options.signal = controller.signal;
    const res = await fetchImpl(url, options);
    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch (error) { json = null; }
    return { ok: res.ok === true, status: res.status, json, raw: String(raw).slice(0, 300) };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function pollTask(opts, taskId) {
  const base = trimBaseUrl(opts.baseUrl);
  const urls = [
    base + '/images/generations/' + taskId,
    base + '/images/tasks/' + taskId,
    base + '/tasks/' + taskId,
  ];
  const interval = Number(opts.pollIntervalMs) > 0 ? Number(opts.pollIntervalMs) : 5000;
  const limit = Number(opts.maxPolls) > 0 ? Number(opts.maxPolls) : 30;
  let lastError = '任务未完成';
  for (let i = 1; i <= limit; i += 1) {
    await sleep(interval);
    for (const url of urls) {
      let out = null;
      try { out = await requestJson(opts.fetchImpl, url, { method: 'GET', headers: opts.headers }, opts.timeoutMs); }
      catch (error) { lastError = String(error && error.message ? error.message : error); continue; }
      if (out.ok !== true) { lastError = 'HTTP ' + out.status; continue; }
      const parsed = parseImagePayload(out.json);
      if (parsed.kind === 'image') return { ok: true, b64: parsed.b64, url: parsed.url, polls: i };
      if (parsed.kind === 'task') {
        if (FAILED_WORDS.indexOf(parsed.status) >= 0) {
          return { ok: false, error: '任务失败：' + parsed.status, polls: i };
        }
        lastError = '任务仍在进行（' + (parsed.status === '' ? 'pending' : parsed.status) + '）';
        continue;
      }
      lastError = parsed.error;
    }
    if (typeof opts.onLog === 'function') opts.onLog('轮询 #' + i + '：' + lastError);
  }
  return { ok: false, error: '轮询超时：' + lastError, polls: limit };
}

/** 主流程：一次生成（含失败重试与任务轮询）。 */
export async function generateImage(opts) {
  const url = generationsUrl(opts.baseUrl);
  if (url === '') return { ok: false, attempts: 0, error: '未配置生图 API 地址' };
  const fetchImpl = (opts.fetchImpl !== undefined && opts.fetchImpl !== null)
    ? opts.fetchImpl : (typeof fetch === 'function' ? fetch : null);
  if (fetchImpl === null) return { ok: false, attempts: 0, error: '当前运行时不支持 fetch' };
  const attempts = Number(opts.maxAttempts) > 0 ? Math.floor(Number(opts.maxAttempts)) : 4;
  const interval = Number(opts.retryIntervalMs) >= 0 ? Number(opts.retryIntervalMs) : 5000;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 180000;
  const headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
  if (typeof opts.apiKey === 'string' && opts.apiKey !== '') headers.authorization = 'Bearer ' + opts.apiKey;
  const body = { model: opts.model === undefined ? '' : opts.model, prompt: opts.prompt, n: 1 };
  if (typeof opts.size === 'string' && opts.size !== '') body.size = opts.size;
  if (Array.isArray(opts.reference) && opts.reference.length > 0) body.image = opts.reference;
  const init = { method: 'POST', headers, body: JSON.stringify(body) };
  let lastError = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let out = null;
    try { out = await requestJson(fetchImpl, url, init, timeoutMs); }
    catch (error) { lastError = String(error && error.message ? error.message : error); }
    if (out !== null) {
      if (out.ok !== true && out.status !== 429 && out.status < 500) {
        return { ok: false, attempts, error: 'HTTP ' + out.status + '：' + out.raw };
      }
      if (out.ok !== true) {
        lastError = 'HTTP ' + out.status + '：' + out.raw;
      } else {
        const parsed = parseImagePayload(out.json);
        if (parsed.kind === 'image') return { ok: true, attempts, b64: parsed.b64, url: parsed.url };
        if (parsed.kind === 'task') {
          if (opts.poll !== false) {
            const polled = await pollTask({
              baseUrl: opts.baseUrl, headers, timeoutMs, fetchImpl,
              pollIntervalMs: opts.pollIntervalMs, maxPolls: opts.maxPolls, onLog: opts.onLog,
            }, parsed.taskId);
            if (polled.ok === true) {
              return { ok: true, attempts, b64: polled.b64, url: polled.url, polls: polled.polls };
            }
            lastError = polled.error;
          } else {
            lastError = '接口返回任务 id ' + parsed.taskId + '（设置里关闭了轮询）';
          }
        } else {
          lastError = parsed.error;
        }
      }
    }
    if (typeof opts.onLog === 'function') opts.onLog('第 ' + attempt + '/' + attempts + ' 次失败：' + lastError);
    if (attempt < attempts) await sleep(interval);
  }
  return { ok: false, attempts, error: lastError };
}
