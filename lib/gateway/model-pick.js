/**
 * 模型选择：检测宿主可用的模型接口 + /model 指令。
 *
 * 从 gateway/plugin.js 搬出（P3 2.4 第一阶段，只搬不改）：路由本身在
 * session/model-router.js；这里只保留「建路由 + 指令文案」这两件事，
 * 依赖（ctx.get / 配置前缀 / 日志）由插件注入，不持有全局状态。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createModelRouter, createPrefsFile } from '../session/model-router.js';

/**
 * @param {object} deps
 * @param {(id: string) => any} deps.getService ctx.get 的包装
 * @param {string} deps.prefsFile per-chat 偏好文件路径
 * @param {() => string} deps.getPrefix 当前指令前缀（读实时配置）
 * @param {(line: string) => void} [deps.log]
 */
export function createModelPicker(deps) {
  const getService = deps.getService;
  const prefsFile = deps.prefsFile;
  const getPrefix = typeof deps.getPrefix === 'function' ? deps.getPrefix : () => '/';
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const prefix = () => String(getPrefix() || '/');

  const modelRouter = createModelRouter({
    getService,
    prefs: createPrefsFile({
      file: prefsFile,
      fs: { readFileSync, writeFileSync },
      log,
    }),
    log,
  });

  async function handleModelCommand(rest, chatKey) {
    const found = modelRouter.detect();
    const parts = rest.split(/\s+/).filter((x) => x !== '');
    const verb = parts[0] ?? '';
    if (verb === '' || verb === 'show') {
      const current = modelRouter.currentSelection();
      const providers = await modelRouter.listProviders();
      const lines = ['模型：' + (current !== null && current.model !== '' ? (String(current.provider) + ' / ' + String(current.model)) : '宿主未报告（或当前是只读模式）')];
      lines.push('接口：' + (found.kind === 'agent-default-model' ? 'DSH 原生 agentDefaultModel（可切换）'
        : found.kind === 'llm-readonly' ? 'DSH llm（只能看不写）' : '未检测到可用模型接口'));
      if (providers.length > 0) lines.push('provider：' + providers.slice(0, 8).map((x) => x.id).join(', ') + (providers.length > 8 ? ' …' : ''));
      lines.push('用法：' + prefix() + 'model set <provider> <model> ｜ ' + prefix() + 'model models <provider>');
      return lines.join('\n');
    }
    if (verb === 'models') {
      const provider = parts[1] ?? '';
      if (provider === '') return '用法：' + prefix() + 'model models <provider>';
      const models = await modelRouter.listModels(provider);
      if (models.length === 0) return 'provider ' + provider + ' 没有可用模型（或接口只读且未返回）';
      return 'provider ' + provider + ' 的模型：' + models.slice(0, 30).map((x) => x.id).join(', ') + (models.length > 30 ? ' …' : '');
    }
    if (verb === 'set') {
      const provider = parts[1] ?? '';
      const model = parts[2] ?? '';
      if (provider === '' || model === '') return '用法：' + prefix() + 'model set <provider> <model>';
      const result = await modelRouter.setDefault({ provider, model }, chatKey);
      if (result.applied === true) return '已切换默认模型：' + provider + ' / ' + model + '（对之后的新会话与回合生效）';
      if (result.ok === true) return '已记录本会话偏好：' + provider + ' / ' + model + '；但' + String(result.error || '当前宿主没有可写接口');
      return '切换失败：' + String(result.error || '未知原因');
    }
    return '用法：' + prefix() + 'model ｜ ' + prefix() + 'model set <provider> <model> ｜ ' + prefix() + 'model models <provider>';
  }

  return { modelRouter, handleModelCommand };
}
