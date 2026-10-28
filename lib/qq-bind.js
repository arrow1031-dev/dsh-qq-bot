/**
 * 官方 Bot 扫码绑定（服务端状态机）。
 *
 * 扫码绑定基于官方 SDK @tencent-connect/qqbot-connector（按官方文档接入）：
 * 状态机在我们自己手里，SDK 只在真正扫码时动态 import，
 * 网关连接仍然走本插件已有的 qq-official 适配器（webhook / ws 都保留），只是省掉手填密钥。
 *
 * 边界：
 *   - appSecret 只在宿主进程内存里经过一次（onCredentials 回调），不写日志、不进 HTTP 响应；
 *   - 对外只暴露 { phase, url, issuedAt, error }，已绑定时由调用方另给脱敏 appId；
 *   - 轮询可停止（刷新 / 卸载 / 超时），不留孤儿任务。
 */

const PHASE_IDLE = 'idle';
const PHASE_WAITING = 'waiting';
const PHASE_SAVING = 'saving';
const PHASE_FAILED = 'failed';

/**
 * @param {object} deps
 * @param {(callbacks: object, options: object) => (() => void)} [deps.connect] 注入点（测试用）
 * @param {(creds: {appId: string, appSecret: string}) => Promise<void>|void} deps.onCredentials
 * @param {(line: string) => void} [deps.log]
 * @param {() => number} [deps.now]
 */
export function createQqBind(deps) {
  const connect = (typeof deps.connect === 'function') ? deps.connect : null;
  const onCredentials = (typeof deps.onCredentials === 'function') ? deps.onCredentials : async () => {};
  const log = (typeof deps.log === 'function') ? deps.log : () => {};
  const now = (typeof deps.now === 'function') ? deps.now : () => Date.now();

  let phase = { kind: PHASE_IDLE };
  let stopFn = null;

  function setPhase(next) {
    phase = next;
  }

  function stop() {
    if (stopFn !== null) {
      try { stopFn(); } catch { /* 已经停了 */ }
      stopFn = null;
    }
  }

  /** 当前状态（HTTP 响应用）；不含任何密钥。 */
  function state() {
    if (phase.kind === PHASE_WAITING) return { phase: 'waiting', url: phase.url, issuedAt: phase.issuedAt };
    if (phase.kind === PHASE_SAVING) return { phase: 'saving' };
    if (phase.kind === PHASE_FAILED) return { phase: 'failed', error: phase.error };
    return { phase: 'idle' };
  }

  async function start(connectFn) {
    if (phase.kind === PHASE_WAITING || phase.kind === PHASE_SAVING) return state();
    const factory = connectFn || connect;
    if (typeof factory !== 'function') {
      setPhase({ kind: PHASE_FAILED, error: '扫码绑定不可用：未安装 @tencent-connect/qqbot-connector（可在 profile 里装上，或手动填 AppID/AppSecret）' });
      return state();
    }
    stop();
    setPhase({ kind: PHASE_IDLE });
    let stopThis = null;
    const controller = {
      disposed: false,
    };
    try {
      // 工厂可以是异步的（动态 import 官方 SDK 时）：await 到 stop 函数为止。
      const started = factory({
        onQrDisplayed: (url) => {
          if (controller.disposed === true) return;
          setPhase({ kind: PHASE_WAITING, url: String(url), issuedAt: now() });
        },
        onQrExpired: () => {
          if (controller.disposed === true) return;
          // SDK 自己会刷新二维码；这里只标记等待，别把过期当失败。
          log('扫码二维码已过期，等待刷新');
        },
        onSuccess: (payload) => {
          if (controller.disposed === true) return;
          const creds = Array.isArray(payload) ? payload[0] : payload;
          const appId = (creds !== null && typeof creds === 'object') ? String(creds.appId || '') : '';
          const appSecret = (creds !== null && typeof creds === 'object') ? String(creds.appSecret || '') : '';
          if (appId === '' || appSecret === '') {
            setPhase({ kind: PHASE_FAILED, error: '扫码成功但没拿到完整凭据' });
            return;
          }
          setPhase({ kind: PHASE_SAVING });
          Promise.resolve(onCredentials({ appId, appSecret })).then(() => {
            if (controller.disposed === true) return;
            stopThis?.();
            setPhase({ kind: PHASE_IDLE });
            log('扫码绑定完成，凭据已写入设置');
          }, (error) => {
            if (controller.disposed === true) return;
            setPhase({ kind: PHASE_FAILED, error: '凭据保存失败：' + String(error && error.message ? error.message : error) });
          });
        },
        onFailure: (error) => {
          if (controller.disposed === true) return;
          setPhase({ kind: PHASE_FAILED, error: String(error && error.message ? error.message : error) });
        },
      }, { displayQrCodeToConsole: false });
      stopThis = (started !== null && started !== undefined && typeof started.then === 'function') ? await started : started;
      if (typeof stopThis !== 'function') stopThis = null;
    } catch (error) {
      setPhase({ kind: PHASE_FAILED, error: '启动扫码失败：' + String(error && error.message ? error.message : error) });
      return state();
    }
    stopFn = () => {
      controller.disposed = true;
      if (typeof stopThis === 'function') stopThis();
    };
    if (phase.kind === PHASE_IDLE) setPhase({ kind: PHASE_WAITING, url: '', issuedAt: now() });
    return state();
  }

  async function refresh(connectFn) {
    stop();
    setPhase({ kind: PHASE_IDLE });
    return start(connectFn);
  }

  return { state, start, refresh, stop, __phase: () => phase };
}

/** 动态加载官方 SDK 的 connect（装了就可用；没装返回 null）。 */
export async function loadOfficialConnect(log = () => {}) {
  try {
    const mod = await import('@tencent-connect/qqbot-connector');
    if (mod !== null && typeof mod.startQrConnect === 'function') return mod.startQrConnect;
    return null;
  } catch (error) {
    log('未安装 @tencent-connect/qqbot-connector（扫码绑定不可用）：' + String(error && error.message ? error.message : error));
    return null;
  }
}
