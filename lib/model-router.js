/**
 * 模型选择路由（自动检测，最大兼容）。
 *
 * 优先级（用户要求：有现成机制就用现成的，没有就借用官方插件的那套「本地偏好」轮子）：
 *   1. DSH 原生 `agentDefaultModel` 服务：currentSelection() / saveSelection({provider, model})。
 *      这是宿主自己的默认模型机制，改完对所有会话生效，最不打架。
 *   2. DSH `llm` 服务：listProviders() / listModels(provider)，只读——能列能看，不能写。
 *   3. 都没有：退到官方插件那套 per-chat 偏好（model-prefs.json），只记录、不假装能应用。
 *
 * 纯逻辑 + 注入依赖，可离网单测（test-model-router.mjs）。
 */

/** DSH 原生默认模型服务的最小投影。 */
function isAgentDefaultModel(service) {
  return service !== null && service !== undefined
    && typeof service.currentSelection === 'function'
    && typeof service.saveSelection === 'function';
}

function isLlm(service) {
  return service !== null && service !== undefined
    && (typeof service.listProviders === 'function');
}

/**
 * @param {object} deps
 * @param {(id: string) => any} deps.getService 按 id 取 DSH 服务（ctx.get）
 * @param {object} [deps.prefs] 官方插件式本地偏好（fallback）：{ get, set, remove, all }
 * @param {(line: string) => void} [deps.log]
 */
export function createModelRouter(deps) {
  const getService = (typeof deps.getService === 'function') ? deps.getService : () => undefined;
  const prefs = (deps.prefs !== null && typeof deps.prefs === 'object') ? deps.prefs : null;
  const log = (typeof deps.log === 'function') ? deps.log : () => {};

  function detect() {
    let current = null;
    try { current = getService('agentDefaultModel'); } catch { current = null; }
    if (isAgentDefaultModel(current)) return { kind: 'agent-default-model', service: current };
    let llm = null;
    try { llm = getService('llm'); } catch { llm = null; }
    if (isLlm(llm)) return { kind: 'llm-readonly', service: llm };
    return { kind: 'none', service: null };
  }

  function currentSelection() {
    const found = detect();
    if (found.kind !== 'agent-default-model') return null;
    try {
      const value = found.service.currentSelection();
      if (value === null || typeof value !== 'object') return null;
      return {
        provider: String(value.provider ?? ''),
        model: String(value.model ?? ''),
        reasoningEffort: value.reasoningEffort === undefined ? undefined : String(value.reasoningEffort),
      };
    } catch (error) {
      log('读取默认模型失败：' + String(error && error.message ? error.message : error));
      return null;
    }
  }

  async function listProviders() {
    const found = detect();
    if (isLlm(found.service) === false) return [];
    try {
      const raw = found.service.listProviders();
      const items = Array.isArray(raw) ? raw : [];
      return items.map((item) => (typeof item === 'string' ? { id: item, name: item } : { id: String(item.id ?? ''), name: String(item.name ?? item.id ?? '') }));
    } catch (error) {
      log('列举 provider 失败：' + String(error && error.message ? error.message : error));
      return [];
    }
  }

  async function listModels(providerId) {
    const found = detect();
    if (isLlm(found.service) === false) return [];
    try {
      const raw = await found.service.listModels(providerId);
      const items = Array.isArray(raw) ? raw : (raw !== null && typeof raw === 'object' && Array.isArray(raw.models) ? raw.models : []);
      return items.map((item) => (typeof item === 'string' ? { id: item, name: item } : { id: String(item.id ?? ''), name: String(item.name ?? item.id ?? '') }));
    } catch (error) {
      log('列举模型失败：' + String(error && error.message ? error.message : error));
      return [];
    }
  }

  /**
   * 设置默认模型。能写就写；不能写（llm-readonly / none）就落到本地偏好并如实返回 applied=false。
   * @returns {{ok: boolean, applied: boolean, source: string, error?: string}}
   */
  async function setDefault(routeIsh, chatKey = '') {
    const provider = String(routeIsh.provider ?? '').trim();
    const model = String(routeIsh.model ?? '').trim();
    if (provider === '' || model === '') return { ok: false, applied: false, source: detect().kind, error: 'provider / model 都不能为空' };
    const found = detect();
    if (found.kind === 'agent-default-model') {
      try {
        await found.service.saveSelection({ provider, model, ...(routeIsh.reasoningEffort !== undefined ? { reasoningEffort: routeIsh.reasoningEffort } : {}) });
        return { ok: true, applied: true, source: found.kind };
      } catch (error) {
        return { ok: false, applied: false, source: found.kind, error: String(error && error.message ? error.message : error) };
      }
    }
    if (prefs !== null && typeof prefs.set === 'function' && chatKey !== '') {
      prefs.set(chatKey, { provider, model });
      return { ok: true, applied: false, source: found.kind, error: '当前宿主没有可写模型接口，已记录本会话偏好（不会自动应用）' };
    }
    return { ok: false, applied: false, source: found.kind, error: '当前宿主没有可写模型接口' };
  }

  return { detect, currentSelection, listProviders, listModels, setDefault };
}

/** 官方插件式 per-chat 偏好文件（fallback 用）：<dir>/model-prefs.json。 */
export function createPrefsFile({ file, fs, log = () => {} }) {
  let data = { overrides: {} };
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && parsed.overrides !== null && typeof parsed.overrides === 'object') data = { overrides: parsed.overrides };
  } catch { /* 文件不存在或坏了：从空开始 */ }
  function write() {
    try { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); }
    catch (error) { log('写模型偏好失败：' + String(error && error.message ? error.message : error)); }
  }
  return {
    get: (key) => data.overrides[String(key)] ?? null,
    set: (key, value) => { data.overrides[String(key)] = value; write(); },
    remove: (key) => { delete data.overrides[String(key)]; write(); },
    all: () => ({ ...data.overrides }),
  };
}
