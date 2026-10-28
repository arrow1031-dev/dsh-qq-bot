/**
 * 传输层入口 —— 协议适配器与传输管道的注册表。
 *
 * 插件侧只认「协议名」：这里给出该协议对应的适配器脚本路径，
 * 具体协议语义（消息/事件/动作）由各适配器自己实现，插件侧与协议无关。
 *
 * 约定（改这里之前先读 bridge/CONTRACT.md）：
 *   - 所有适配器都实现同一套 stdio 帧，宿主用 subprocess 拉起；
 *   - OneBot 11 保留旧入口文件名（onebot-adapter.mjs）做向前兼容，
 *     配置里写了 adapterPath 时以配置为准（自定义适配器不受本表约束）。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 协议名 -> 适配器脚本相对本目录的路径。 */
export const ADAPTER_ENTRIES = Object.freeze({
  onebot11: 'onebot-adapter.mjs',
  onebot12: 'adapters/onebot12.mjs',
  satori: 'adapters/satori.mjs',
  milky: 'adapters/milky.mjs',
  'qq-official': 'adapters/qq-official.mjs',
});

/** 兜底适配器（协议名不认识时用它，等价于 OneBot 11）。 */
export const BUNDLED_ADAPTER = join(HERE, ADAPTER_ENTRIES.onebot11);

/**
 * 解析协议对应的适配器绝对路径。
 * @param {string} protocol 协议名（onebot11 / onebot12 / satori / milky / qq-official）
 * @returns {string} 适配器脚本绝对路径（未知协议回退 OneBot 11）
 */
export function resolveAdapterPath(protocol) {
  const entry = ADAPTER_ENTRIES[String(protocol)];
  return entry === undefined ? BUNDLED_ADAPTER : join(HERE, entry);
}

/** 已支持的协议名列表（启动日志与设置页提示用）。 */
export function supportedProtocols() {
  return Object.keys(ADAPTER_ENTRIES);
}

export { ADAPTER_ENTRIES as ADAPTER_FILES };
