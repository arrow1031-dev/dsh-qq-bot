// 流程产物投递：打包本回合产物并按 flow.deliver 上传（私聊 / 指定群 / none）。
// 从 gateway/plugin.js 搬出（P3 2.4 第二阶段，只搬不改）。
export function createFlowDelivery(deps) {
  const { TAG, getConfig, callAdapterAction, describeError, sendReply, ownerQq, artifactDirs, listFreshFiles, packFlowFiles } = deps;
  async function deliverFlowArtifacts(entry, frame) {
    const armedAt = entry.flowArmedAt;
    entry.flowArmedAt = undefined;
    if (armedAt === undefined || armedAt === null) return;
    const conf = getConfig().flow || {};
    const deliver = String(conf.deliver === undefined || conf.deliver === null ? 'private' : conf.deliver);
    if (deliver === 'none') return;
    const maxFiles = Math.max(1, Math.floor(Number(conf.maxFiles) || 40));
    const maxBytes = Math.max(1024, Math.floor(Number(conf.maxBytes) || 20971520));
    let dir = '';
    let files = [];
    for (const candidate of artifactDirs(entry)) {
      const found = await listFreshFiles(candidate, armedAt, maxFiles, conf.skipHidden !== false);
      if (found.length > 0) { dir = candidate; files = found; break; }
    }
    if (files.length === 0) return;
    let total = 0;
    const picked = [];
    for (const file of files) {
      if (total + file.size > maxBytes) continue;
      total += file.size;
      picked.push(file);
    }
    if (picked.length === 0) return;
    const truncated = picked.length < files.length ? ('（超出上限，只打包了 ' + picked.length + '/' + files.length + ' 个）') : '';
    if (truncated !== '') console.log(TAG + ' 产物超出上限，只打包 ' + picked.length + '/' + files.length + ' 个文件');
    const packPath = await packFlowFiles(dir, picked);
    if (packPath === '') return;
    const name = packPath.slice(dir.length + 1);
    const toGroup = deliver.indexOf('group:') === 0;
    const target = toGroup ? deliver.slice(6).trim() : ownerQq();
    if (target === '' || !/^\d+$/.test(target)) {
      console.log(TAG + ' 产物投递目标无效（' + deliver + '），跳过投递');
      return;
    }
    const action = toGroup ? 'upload_group_file' : 'upload_private_file';
    const params = toGroup
      ? { group_id: Number(target), file: packPath, name }
      : { user_id: Number(target), file: packPath, name };
    let delivered = false;
    let note = '';
    try {
      const result = await callAdapterAction(action, params, 120000);
      delivered = result.ok === true;
      if (delivered !== true) note = String(result.error === undefined ? (result.status === undefined ? '未知原因' : result.status) : result.error);
    } catch (error) {
      note = describeError(error);
    }
    if (delivered !== true) {
      console.log(TAG + ' 产物上传失败：' + note);
      sendReply(frame, '产物已打包但上传失败（协议端可能不支持文件上传，' + note + '），路径：' + packPath);
      return;
    }
    sendReply(frame, '产物已打包：' + name + '（' + picked.length + ' 个文件，' + total + ' 字节）' + truncated);
  }

  return { deliverFlowArtifacts };
}
