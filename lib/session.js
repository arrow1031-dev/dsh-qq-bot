// 业务模块：会话条目与路由（getEntry/sessionRoute/entryForAgent）+ 被回复图片收集（collectReplyImageUrls）。
// 从 lib/index.js 拆出；依赖经 createSession(deps) 注入。

import { promises as fsPromises } from 'node:fs';
import { createHash } from 'node:crypto';

/**
 * 工作区限定的会话 id：当同名会话已绑在**别的工作区**（典型场景：0.7 时代 workspace=/root
 * 建的会话，升级后工作区变成 QQ_msg）时使用。只改新会话的 id，旧会话原样留着，向前兼容。
 */
export function scopedSessionId(sessionId, scopeKey) {
  const digest = createHash('sha1').update(String(scopeKey)).digest('hex').slice(0, 6);
  return String(sessionId) + '-ws' + digest;
}

export function createSession(deps) {
  const { getConfig, ctx, state, ensureQqMsgWorkspace, ensureSessionWorkspace, sessionWorkdir, callAdapterAction, describeError, isOwner, flowGate } = deps;
  const TAG = '[dsh-qq-bot]';
  const cfg = () => getConfig();

  function entryForAgent(agent) {
    if (agent === null || agent === undefined) return null;
    for (const pair of state.convos) if (pair[1].agent === agent) return pair[1];
    return null;
  }


  function sessionRoute(frame) {
    const isGroup = frame.message_type === 'group';
    const chatId = isGroup ? frame.group_id : frame.user_id;
    const scope = (isGroup ? 'group-' : 'private-') + String(chatId);
    const owner = isOwner(frame.user_id);
    const split = cfg().auth.ownerPreset !== '' || cfg().auth.guestPreset !== '';
    if (!split) {
      return { entryKey: scope, sessionId: 'qqbot-' + scope, preset: cfg().agentPreset, tier: owner ? 'owner' : 'guest' };
    }
    const tier = owner ? 'owner' : 'guest';
    return {
      entryKey: scope + '@' + tier,
      sessionId: 'qqbot-' + scope + (owner ? '' : '-guest'),
      preset: (owner ? cfg().auth.ownerPreset : cfg().auth.guestPreset) || cfg().agentPreset,
      tier,
    };
  }


  async function collectReplyImageUrls(frame) {
    if (frame.reply_to === null || frame.reply_to === undefined) return;
    try {
      const r = await callAdapterAction('get_msg', { message_id: Number(frame.reply_to) }, 8000);
      if (r.ok === true && r.data !== null && r.data !== undefined && Array.isArray(r.data.message)) {
        for (const seg of r.data.message) {
          if (seg === null || typeof seg !== 'object') continue;
          if (String(seg.type ?? '').toLowerCase() !== 'image') continue;
          const url = (seg.data && typeof seg.data.url === 'string') ? seg.data.url : '';
          if (url === '' || !/^https?:\/\//.test(url)) continue;
          if (!Array.isArray(frame.replyImageUrls)) frame.replyImageUrls = [];
          frame.replyImageUrls.push(url);
        }
      }
    } catch { /* 尽力而为 */ }
  }


  function getEntry(entryKey, sessionId, preset, fixedTitle) {
    const existing = state.convos.get(entryKey);
    if (existing !== undefined) return existing.ready;
    const entry = {
      key: entryKey, sessionId, agent: null, turns: 0, generation: 0,
      queue: Promise.resolve(), ready: null,
      // 本会话最近一条消息的说话人与身份（qqgroup 工具的鉴权依据）
      speaker: null, groupId: null,
      // 访客工具闸：注册一次，判据是这个可变标志位
      dshAllowed: false, liftGuard: null, guardUnavailable: false,
    };
    entry.ready = (async () => {
      // 官方组装路径：create 会幂等地创建/接管会话，resolveAgent 装上默认模型路由
      // 并挂载 Agent preset（人格 + 工具）。直接 agentLoop.create 不装模型路由，
      // 第一次模型请求必然失败。
      // 流程授权打开时，会话独占 QQ_msg/<sessionId>：产物投递要按会话归属文件，
      // 共用工作区根（QQ_msg）分不出哪个文件是这个会话写的——这正是上一轮的跨会话泄密来源。
      // 关着的时候仍走原来的共享分组，行为与 0.11 一致。
      const flowWorkspaceOn = (() => {
        const f = cfg().flowAuth;
        return f !== undefined && f !== null && f.enabled === true;
      })();
      const ws = (flowWorkspaceOn === true && typeof ensureSessionWorkspace === 'function')
        ? await ensureSessionWorkspace(sessionId)
        : await ensureQqMsgWorkspace();
      // 产物要按「真实工作目录」归属，不能按 sessionId 拼：工作区冲突时 entry.sessionId 会被改成
      // scoped，而工作区还挂在原来的路径上，两边一错位产物就永远扫不到。
      entry.flowWorkdir = (flowWorkspaceOn === true) ? ws.path : undefined;
      let request;
      if (ws.id !== null) {
        // 有 workspace 服务：传 workspaceId，DSH 会把会话挂到对应分组。
        request = { sessionId, workspaceId: ws.id };
      } else {
        // 回退：无 workspace 服务时用会话子目录当工作目录。
        const workdir = (ws.path !== undefined && ws.path !== null) ? ws.path : sessionWorkdir(sessionId);
        await fsPromises.mkdir(workdir, { recursive: true });
        request = { sessionId, cwd: workdir };
      }
      const effectivePreset = preset === undefined ? cfg().agentPreset : preset;
      if (effectivePreset !== '' && effectivePreset !== undefined && effectivePreset !== null) request.agentPreset = effectivePreset;
      let effectiveSessionId = sessionId;
      try {
        await ctx.sessionController.create(request);
      } catch (error) {
        const reason = describeError(error);
        if (reason.indexOf('belongs to') < 0) throw error;
        // 旧版本建的会话绑在别的工作区，DSH 不允许跨工作区复用同一个 id。
        // 不删旧会话（向前兼容），换一个工作区限定的 id 重开；旧历史原样保留。
        const scopeKey = ws.id !== null ? ('workspace:' + String(ws.id)) : ('cwd:' + sessionWorkdir(sessionId));
        const scoped = scopedSessionId(sessionId, scopeKey);
        console.log(TAG + ' 会话 ' + sessionId + ' 绑在其他工作区（' + reason + '），改用 ' + scoped + '；旧会话保留');
        entry.sessionId = scoped;
        effectiveSessionId = scoped;
        await ctx.sessionController.create(Object.assign({}, request, { sessionId: scoped }));
      }
      const resolved = await ctx.sessionController.resolveAgent(effectiveSessionId);
      if (resolved === null || resolved === undefined || resolved.error !== undefined) {
        const detail = (resolved !== null && resolved !== undefined && resolved.error)
          ? (resolved.error.message ? resolved.error.message : String(resolved.error.code))
          : 'resolveAgent 没有返回 agent';
        throw new Error(detail);
      }
      entry.agent = resolved.agent;

      // 访客工具闸：只在建 agent 时注册一次。guard 是一个每次执行才求值的函数，
      // 判据放进闭包里的可变标志位 entry.dshAllowed，所以拥有者/访客交替说话时
      // 既不用增删限制，也不会造成工具面抖动（那会多记 request/header、白费 token）。
      const guestAllow = new Set(Array.isArray(cfg().auth.guestToolAllow) ? cfg().auth.guestToolAllow : []);
      try {
        // 0.2 起 Guard 也管着 agent 上下文里的 tools：直接 ctx.tools 会抛，get() 才安全；
        // 0.1.x（以及单测里的 mock ctx）只有属性形态，两种都试。
        let agentTools;
        try {
          agentTools = (typeof entry.agent.ctx.get === 'function') ? entry.agent.ctx.get('tools') : undefined;
        } catch (error) { agentTools = undefined; }
        if (agentTools === undefined || agentTools === null) {
          try { agentTools = entry.agent.ctx.tools; } catch (error) { agentTools = undefined; }
        }
        if (agentTools === undefined || agentTools === null || typeof agentTools.guard !== 'function') {
          throw new Error('agent 上下文未提供 tools 服务（DSH 0.2 起需用 ctx.get("tools") 获取）');
        }
        entry.liftGuard = agentTools.guard((exec) => {
          const toolName = (exec !== null && exec !== undefined && typeof exec.name === 'string') ? exec.name : '';
          // 流程授权闸门先于「拥有者放行」：拥有者用高危工具同样要过动态码。
          // 只在拥有者身上生效——访客本来就被下面的访客闸挡掉，不必再叠一层。
          // 只读本回合开始时固化的发言人：entry.speaker 会被后到的消息覆盖，读它等于让晚到的消息改判已有回合。
          const speaker = (entry.turnSpeaker !== undefined && entry.turnSpeaker !== null) ? entry.turnSpeaker : entry.speaker;
          const isOwnerSpeaker = speaker !== undefined && speaker !== null && speaker.owner === true;
          if (isOwnerSpeaker && flowGate !== undefined && flowGate !== null && flowGate.isGated(toolName)) {
            // 授权只在「拥有者私聊」里生效：否则群里的同一个 owner 一句话就能把私聊刚发的码花掉，
            // 私聊那边续跑反而 no-grant（而且群消息本来就不该驱动编排工具）。
            if (ownerPrivateNow() !== true) {
              state.stats.flowBlocked += 1;
              console.log(TAG + ' 流程授权闸拦截：' + toolName + '（非拥有者私聊）');
              return '流程授权：这个工具只能在拥有者私聊里驱动（当前会话不允许）';
            }
            const qq = String(speaker.userId);
            const verdict = flowGate.check(qq, toolName);
            if (verdict.allow === true) {
              entry.flowArmedAt = Date.now();
              // 同名遮蔽的 wrapper 在 dispatch 之后才执行，如果它也去问一次闸门，一次调用就要两个码。
              // 这里记一笔「这次调用已经付过码」，wrapper 只认这笔账。
              if (entry.flowAllow === undefined || entry.flowAllow === null) entry.flowAllow = {};
              entry.flowAllow[toolName] = (Number(entry.flowAllow[toolName]) || 0) + 1;
              console.log(TAG + ' 流程授权通过：' + toolName + '（' + String(verdict.purpose || '') + '）');
              return undefined;
            }
            state.stats.flowBlocked += 1;
            console.log(TAG + ' 流程授权闸拦截：' + toolName + '（' + verdict.reason + '）');
            return flowGate.blockedText(verdict.reason);
          }
          if (entry.dshAllowed === true) return undefined;
          if (guestAllow.has(toolName)) return undefined;

          state.stats.guestBlocked += 1;
          console.log(TAG + ' 访客工具闸拦截：' + toolName);
          return '访客模式：不允许使用 DSH 内部工具 ' + toolName;
        });
      } catch (error) {
        entry.guardUnavailable = true;
        console.error(TAG + ' 无法安装访客工具闸，将拒绝驱动非拥有者：' + describeError(error));
      }

      // 高危编排工具：DSH 的全局注册在我们这些会话里由插件接管（同名遮蔽）。
      // 遮蔽在建会话时装一次，但闸门判据**每次执行时现读配置**：
      //   - 开关关着 → 直接交给原始工具（行为与 0.11 完全一致，群里/共享会话的拥有者照旧能用）；
      //   - 开关打开 + 拥有者私聊 → 要一次性动态码；
      //   - 开关打开 + 其它会话 → 拒绝（工具还在表里，但调用拿到的是可读的中文拒绝）。
      // 以前「开关只在建会话时算一次」，热切换会留半状态：开→关后群会话的工具仍被摘掉，
      // 关→开时老会话没有遮蔽、守卫又装不上就完全裸奔。现在两个方向都对称。
      const flowOnNow = () => {
        const f = cfg().flowAuth;
        return f !== undefined && f !== null && f.enabled === true;
      };
      const ownerPrivateNow = () => {
        if (typeof entryKey !== 'string' || entryKey.indexOf('private-') !== 0) return false;
        const qq = entryKey.slice('private-'.length).split('@')[0];
        const owners = Array.isArray(cfg().auth.owners) ? cfg().auth.owners.map((id) => String(id)) : [];
        return owners.indexOf(String(qq)) >= 0;
      };
      // 工具服务要在 try 外面声明：catch 里（遮蔽整体失败时）还要用它做兜底摘除。
      let toolsService; // eslint-disable-line prefer-const
      try {
        const hijackNames = ['subagent', 'subagent_fork', 'spawn_teammate', 'workflow'];
        // 上一个 try 里的 agentTools 是块级变量，这里必须重新取一次（否则整段会静默失败）。
        try {
          toolsService = (typeof entry.agent.ctx.get === 'function') ? entry.agent.ctx.get('tools') : entry.agent.ctx.tools;
        } catch (error) { toolsService = undefined; }
        if (toolsService === undefined || toolsService === null) throw new Error('agent 上下文未提供 tools 服务');
        // 摘除只作为「遮蔽失败」的兜底：一次摘除不可逆，所以只在开关打开时才做。
        const denyOne = (name) => {
          if (typeof toolsService.restrict !== 'function') return false;
          try {
            ctx.effect(() => toolsService.restrict({ deny: [name] }));
            return true;
          } catch (error) {
            console.log(TAG + ' 摘不掉 ' + name + '（宿主不认识这个工具名）：' + describeError(error));
            return false;
          }
        };
        const hijackOne = (name) => {
          let original;
          try { original = (typeof toolsService.get === 'function') ? toolsService.get(name) : undefined; }
          catch (error) { original = undefined; }
          if (original === undefined || original === null) {
            // 不在可见工具表里：多半是宿主 preset 没这个工具（正常）。开关开着才需要把它挡掉。
            if (flowOnNow() === true) denyOne(name);
            return;
          }
          const wrapped = Object.assign({}, original, {
            async execute(args, exec) {
              // 关着：原样交给原始工具，连身份都不看（0.11 行为）。
              if (flowOnNow() !== true) return original.execute(args, exec);
              if (ownerPrivateNow() !== true) {
                throw new Error('流程授权：这个工具只能在拥有者私聊里驱动（当前会话不允许）');
              }
              const speaker = (entry.turnSpeaker !== undefined && entry.turnSpeaker !== null) ? entry.turnSpeaker : entry.speaker;
              if (speaker === undefined || speaker === null || speaker.owner !== true) {
                throw new Error('流程授权：这个工具只允许拥有者本人在私聊里驱动');
              }
              // 上一层 guard 付过码的，直接执行（否则一次调用要吃两个 grant，等于永远跑不起来）；
              // 只有在 guard 没装或没拦的时候才现问一次闸门。
              const prepaid = entry.flowAllow !== undefined && entry.flowAllow !== null
                && Number(entry.flowAllow[name]) > 0;
              if (prepaid === true) {
                entry.flowAllow[name] = Number(entry.flowAllow[name]) - 1;
              } else {
                const verdict = (flowGate === undefined || flowGate === null)
                  ? { allow: true }
                  : flowGate.check(String(speaker.userId), name);
                if (verdict.allow !== true) throw new Error(flowGate.blockedText(verdict.reason));
              }
              entry.flowArmedAt = Date.now();
              try {
                return await original.execute(args, exec);
              } catch (error) {
                // 调用失败不该留着「本轮有产物」的标记，否则会白打一次包、还可能把半成品投出去。
                entry.flowArmedAt = undefined;
                throw error;
              }
            },
          });
          try {
            ctx.effect(() => toolsService.register(wrapped));
          } catch (error) {
            // 遮蔽失败不能让原生版本继续裸奔：开关开着时退一步把这个名字从工具表里摘掉。
            console.log(TAG + ' 遮蔽 ' + name + ' 失败：' + describeError(error));
            if (flowOnNow() === true) denyOne(name);
          }
        };
        for (const name of hijackNames) hijackOne(name);
      } catch (error) {
        console.log(TAG + ' 接管编排工具失败：' + describeError(error));
        // 只有开关打开时摘除才有意义（关着时摘掉就等于破坏 0.11 行为）。
        if (flowOnNow() === true && toolsService !== undefined && toolsService !== null) {
          if (typeof toolsService.restrict === 'function') {
            try { ctx.effect(() => toolsService.restrict({ deny: ['subagent', 'subagent_fork', 'spawn_teammate', 'workflow'] })); }
            catch (error2) { console.log(TAG + ' 摘除也失败，宿主行为未知：' + describeError(error2)); }
          }
        }
      }
      // 固定会话名（可选）：新建会话时钉死成 私聊_<QQ号> / 群聊_<群号>，避免 LLM 自动起标题。
      // rename 用 user 源标题，之后自动生成不会覆盖。只在首次建会话时执行一次。
      if (fixedTitle !== null && fixedTitle !== undefined && fixedTitle !== '' && entry.agent !== null && entry.agent.session !== undefined) {
        try {
          const titles = ctx.get('sessionTitle');
          if (titles !== undefined && titles !== null && typeof titles.rename === 'function') {
            titles.rename(entry.agent.session, fixedTitle);
          }
        } catch (error) {
          console.error(TAG + ' 固定会话名失败（忽略）：' + describeError(error));
        }
      }

      console.log(TAG + ' 会话 ' + sessionId + ' 已就绪（' + entryKey + '）');
      return entry;
    })().catch((error) => { state.convos.delete(entryKey); throw error; });
    state.convos.set(entryKey, entry);
    return entry.ready;
  }


  return { sessionRoute, getEntry, entryForAgent, collectReplyImageUrls };
}
