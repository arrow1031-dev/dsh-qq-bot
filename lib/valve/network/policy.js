/**
 * 网络阀门 · 策略层（纯判定，不发请求）。
 *
 * 这一层回答唯一一个问题：**这个目标能不能出站**。
 * 判定对象必须是网络栈真正会去连的那个字符串，所以一律先过 URL 解析器归一，
 * 再按 8 组整数或 4 段整数判段——不拿正则匹配「某一种写法」给攻击者留旁路。
 *
 * 谁在用：shared/http.js（真正发请求的地方）、valve/network/guard-proxy.js（本地校验代理）、
 * tools/moli.js（渲染抓取前的入口校验）。**本模块是「公网/内网」判定的唯一来源，但不是唯一出口**：
 * 少数固定目标的请求直接走全局 fetch（api/update-check.js 查 npm registry、qq-official 与 stdio
 * 适配器连本机/厂商端点），它们不经过这里，也就没有代理解析。新增出网代码请优先走 shared/http.js。
 */
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

// ---- 地址判定：判定对象必须是网络栈真正会去连的那个字符串 ----
// 教训（验收复测 #13/#15/#20/#21 发现的 F1）：WHATWG URL 会把各种写法改写成规范形式——
//   0177.0.0.1（八进制）→ 127.0.0.1     0x7f.0.0.1（十六进制）→ 127.0.0.1
//   127.1（短写）→ 127.0.0.1            2130706433（整数）→ 127.0.0.1
//   [::ffff:127.0.0.1] → [::ffff:7f00:1]（十六进制组）
// 自己拿正则匹配「某一种写法」，等于给攻击者留一条「换个写法」的旁路：上一版只认 ::ffff:
// 后面的点分 IPv4，于是 [::ffff:7f00:1] / [::ffff:a00:1] / [::ffff:c0a8:101] / [::ffff:a9fe:a9fe]
// 全被判成公网。现在一律先过 URL 解析器归一，再按 8 组整数或 4 段整数判段。
/** 用 URL 解析器把地址字面量归一成 hostname（IPv6 保留方括号）；非法返回空串。 */
export function canonicalHost(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (raw === '') return '';
  // hostname 里不可能有这些字符，出现说明调用方把整条 URL 或路径混进来了。
  if (/[/?#@\\\s]/.test(raw)) return '';
  const host = raw.includes(':') && !raw.startsWith('[') ? '[' + raw + ']' : raw;
  let parsed;
  try { parsed = new URL('http://' + host + '/'); } catch (error) { return ''; }
  return String(parsed.hostname);
}

/** canonicalHost 去掉 IPv6 的方括号，得到 net.isIP 认识的形态。 */
export function bareHost(value) {
  return canonicalHost(value).replace(/^\[|\]$/g, '');
}

/** 解析 IPv6 文本成 8 组 16 位整数；非法返回 null。支持 :: 省略与 IPv4 尾巴。 */
export function parseIpv6Groups(text) {
  const s = String(text).toLowerCase();
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part) => {
    if (part === '') return [];
    const out = [];
    for (const item of part.split(':')) {
      if (item === '') return null;
      if (item.includes('.')) {
        const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(item);
        if (m === null) return null;
        const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
        if (o.some((x) => x > 255)) return null;
        out.push((o[0] << 8) | o[1]);
        out.push((o[2] << 8) | o[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(item)) return null;
      out.push(parseInt(item, 16));
    }
    return out;
  };
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return head.concat(new Array(fill).fill(0), tail);
}

export function isNonPublicV4(a, b) {
  if (a < 1 || a > 223) return true;                          // 0.x / 224+ 保留与组播
  if (a === 10) return true;                                  // 10/8
  if (a === 127) return true;                                 // 回环
  if (a === 169 && b === 254) return true;                    // 链路本地（云元数据）
  if (a === 172 && b >= 16 && b <= 31) return true;           // 172.16/12
  if (a === 192 && b === 168) return true;                    // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true;          // 100.64/10 CGN
  return false;
}

/** 地址字面量是否不能出站。非字面量（域名/垃圾）一律 true——本函数只认字面量，域名走 resolvePublicAddresses。 */
export function isNonPublicIp(ip) {
  if (typeof ip !== 'string' || ip === '') return true;
  const host = bareHost(ip);
  if (host === '') return true;
  const kind = isIP(host);
  if (kind === 4) {
    const o = host.split('.').map((part) => Number(part));
    return isNonPublicV4(o[0], o[1]);
  }
  if (kind !== 6) return true;
  const g = parseIpv6Groups(host);
  if (g === null) return true;
  if (g.every((x) => x === 0)) return true;                   // ::
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0 && g[6] === 0 && g[7] === 1) return true; // ::1
  if ((g[0] & 0xffc0) === 0xfe80) return true;                // fe80::/10
  if ((g[0] & 0xfe00) === 0xfc00) return true;                // fc00::/7
  if ((g[0] & 0xff00) === 0xff00) return true;                // ff00::/8
  // 6to4（2002::/16）与 Teredo（2001::/32）把 IPv4 编进了地址本身：
  // 2002:7f00:1:: 就是 127.0.0.1；不拆开判，等于给内网留了一条 IPv6 后门。
  if (g[0] === 0x2002) return isNonPublicV4((g[1] >>> 8) & 0xff, g[1] & 0xff);
  if (g[0] === 0x2001 && g[1] === 0) {
    // Teredo 布局：2001:0000:<服务器 v4 高16>:<服务器 v4 低16>:<flags>:<混淆端口>:<混淆客户端 v4 高16>:<低16>
    // 客户端地址在最后两组且按位取反（RFC 4380），**不是** g[2]——那是 Teredo 服务器地址。
    // 例：2001:0:4136:e378:0:9cbf:80ff:fffe 的客户端 = ~80ff:~fffe = 127.0.0.1（曾被漏判放行）。
    const clientHi = (~g[6]) & 0xffff;
    return isNonPublicV4((clientHi >>> 8) & 0xff, clientHi & 0xff);
  }
  // 内嵌 IPv4 的四种形态：映射 ::ffff:0:0/96、转换 ::ffff:0:0:0/96、兼容 ::/96、NAT64 64:ff9b::/96。
  // 必须按 16 位组取低 32 位，不能只看点分写法（URL 会把 [::ffff:127.0.0.1] 写成 [::ffff:7f00:1]）。
  const embed = ((g[6] << 16) | g[7]) >>> 0;
  const v4 = [((embed >>> 24) & 0xff), ((embed >>> 16) & 0xff), ((embed >>> 8) & 0xff), (embed & 0xff)];
  const mapped = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff;
  const translated = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0xffff && g[5] === 0;
  const compatible = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0;
  const nat64 = g[0] === 0x64 && g[1] === 0xff9b;
  if (mapped || translated || compatible || nat64) return isNonPublicV4(v4[0], v4[1]);
  return false;
}

/**
 * 解析目标主机并返回「已校验的公网地址列表」。
 * 一个域名可能有多条 A/AAAA：只要有一条落在内网就拒绝（防「公网 + 内网」双记录绕过）。
 * 返回值直接喂给 pinnedLookup，让连接只可能发生在这几个地址上（防解析后重绑定 DNS rebinding）。
 */
export async function resolvePublicAddresses(hostname) {
  const host = bareHost(hostname);
  if (host === '') throw new Error('目标主机为空，已拒绝');
  const kind = isIP(host);
  if (kind !== 0) {
    if (isNonPublicIp(host)) throw new Error('目标 ' + host + ' 是非公网地址，已拒绝');
    return [{ address: host, family: kind }];
  }
  // 测试注入点（见 __setNetworkHooks）：解析结果照样要过 isNonPublicIp，**不能**用注入放宽判定。
  const list = networkHooks !== null && typeof networkHooks.lookup === 'function'
    ? await networkHooks.lookup(host)
    : await dnsLookup(host, { all: true, verbatim: true });
  const addresses = Array.isArray(list) ? list : [];
  if (addresses.length === 0) throw new Error('目标 ' + host + ' 解析不到地址，已拒绝');
  for (const item of addresses) {
    if (isNonPublicIp(item.address)) throw new Error('目标 ' + host + ' 解析到非公网 IP：' + item.address);
  }
  return addresses.map((item) => ({ address: item.address, family: isIP(item.address) || 4 }));
}

export async function assertPublicHost(hostname) {
  await resolvePublicAddresses(hostname);
}

// 测试注入点。publicFetch 用 node:http(s) 直连（要拿 lookup 钩子做地址钉死），
// 于是测试里「把 fetch 换成桩」这套办法对它无效；离线环境又不可能真去连 example.com。
// 这里只允许测试替换「解析」与「单次请求」两个动作，判定逻辑（canonicalHost / isNonPublicIp）不可绕过：
// 注入的解析结果仍然逐个过 isNonPublicIp，注入的请求只在测试里替代真正的网络调用。
let networkHooks = null;
export function __setNetworkHooks(hooks) {
  networkHooks = hooks === null || hooks === undefined ? null : hooks;
  return networkHooks;
}

/**
 * 把连接用的 DNS 结果钉死在校验过的那几个地址上。
 * 只校验不钉死等于留了个 TOCTOU：第一次解析给公网、第二次解析给 127.0.0.1。
 */
export function pinnedLookup(addresses) {
  const pool = Array.isArray(addresses) ? addresses : [];
  let cursor = 0;
  return function lookup(hostname, options, callback) {
    const wantAll = options !== null && typeof options === 'object' && options.all === true;
    const family = options !== null && typeof options === 'object' && Number(options.family) > 0 ? Number(options.family) : 0;
    const match = family === 0 ? pool : pool.filter((item) => item.family === family);
    const usable = match.length > 0 ? match : pool;
    if (usable.length === 0) {
      callback(Object.assign(new Error('没有可用的已校验地址：' + hostname), { code: 'ENOTFOUND' }), wantAll ? [] : '', 0);
      return;
    }
    if (wantAll === true) {
      callback(null, usable.map((item) => ({ address: item.address, family: item.family })));
      return;
    }
    const picked = usable[cursor % usable.length];
    cursor += 1;
    callback(null, picked.address, picked.family);
  };
}

/**
 * 当前生效的测试注入点（只读）。
 * requestOnce 需要判断「测试是否替换了单次请求」，因此策略层额外提供这个访问器，
 * 而不是把可变状态再复制一份到传输层。
 */
export function __networkHooks() {
  return networkHooks;
}
