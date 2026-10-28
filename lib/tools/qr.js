/**
 * 最小 QR 编码器：只做这件事——把 otpauth:// URI 编成二维码，供认证器 App 扫码离线绑定。
 *
 * 为什么自己写而不引依赖：插件对外一直是零依赖（换协议端、离线内核、裸跑测试都靠这点），
 * 为一个二维码拉一个几十 KB 的包不值当。所以这里只实现「字节模式 + 纠错等级 M + 版本 1..9」，
 * 够装一条 otpauth URI（≤ 182 个数据码字）。
 *
 * 正确性策略：掩码按标准罚分选（任意合法掩码都能被扫出来）；数据放置 / RS 纠错 / 格式信息 /
 * 版本信息逐版本对过独立实现（见 test/test-qr.mjs 的固定向量）。
 *
 * 规格：ISO/IEC 18004。GF(256) 本原多项式 0x11D；格式信息 BCH(15,5) 生成多项式 0x537，掩码 0x5412。
 */

// ---------------------------------------------------------------- GF(256) / RS
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if ((x & 0x100) !== 0) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= gfMul(poly[j], 1);
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data, ecLength) {
  const gen = rsGeneratorPoly(ecLength);
  const remainder = new Array(ecLength).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.shift();
    remainder.push(0);
    for (let i = 0; i < ecLength; i += 1) remainder[i] ^= gfMul(gen[i + 1], factor);
  }
  return remainder;
}

// ---------------------------------------------------------------- 版本表（纠错等级 M）
// ec = 每块纠错码字数；blocks = [[块数, 每块数据码字数], ...]
const EC_M = {
  1: { ec: 10, blocks: [[1, 16]] },
  2: { ec: 16, blocks: [[1, 28]] },
  3: { ec: 26, blocks: [[1, 44]] },
  4: { ec: 18, blocks: [[2, 32]] },
  5: { ec: 24, blocks: [[2, 43]] },
  6: { ec: 16, blocks: [[4, 27]] },
  7: { ec: 18, blocks: [[4, 31]] },
  8: { ec: 22, blocks: [[2, 38], [2, 39]] },
  9: { ec: 22, blocks: [[3, 36], [2, 37]] },
};

/** 对齐图案中心（版本 1 没有）。 */
const ALIGN_CENTERS = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
};

export const MAX_VERSION = 9;

function dataCapacityBytes(version) {
  const table = EC_M[version];
  let total = 0;
  for (const [count, len] of table.blocks) total += count * len;
  return total;
}

function utf8Bytes(text) {
  const encoder = new TextEncoder();
  return Array.from(encoder.encode(String(text)));
}

/** 选能装下的最小版本；装不下返回 version 0。 */
export function chooseVersion(text) {
  const bytes = utf8Bytes(text);
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    const capacityBits = dataCapacityBytes(version) * 8;
    if (4 + 8 + bytes.length * 8 <= capacityBits) return { version, bytes };
  }
  return { version: 0, bytes };
}

function buildCodewords(bytes, version) {
  const capacityBits = dataCapacityBytes(version) * 8;
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };
  push(0b0100, 4);            // 字节模式
  push(bytes.length, 8);      // 版本 1..9 的长度字段是 8 位
  for (const byte of bytes) push(byte, 8);
  for (let i = 0; i < 4 && bits.length < capacityBits; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  const padBytes = [0xec, 0x11];
  let padIndex = 0;
  while (codewords.length < capacityBits / 8) {
    codewords.push(padBytes[padIndex % 2]);
    padIndex += 1;
  }
  return codewords;
}

function interleave(codewords, version) {
  const table = EC_M[version];
  const blocks = [];
  let offset = 0;
  for (const [count, len] of table.blocks) {
    for (let i = 0; i < count; i += 1) {
      const data = codewords.slice(offset, offset + len);
      offset += len;
      blocks.push({ data, ec: rsRemainder(data, table.ec) });
    }
  }
  const out = [];
  const maxData = Math.max(...blocks.map((block) => block.data.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const block of blocks) if (i < block.data.length) out.push(block.data[i]);
  }
  for (let i = 0; i < table.ec; i += 1) {
    for (const block of blocks) out.push(block.ec[i]);
  }
  return out;
}

// ---------------------------------------------------------------- 矩阵
function bchFormatInfo(maskIndex) {
  const data = (0b00 << 3) | maskIndex;   // 纠错等级 M 的指示位是 00
  let value = data << 10;
  for (let i = 14; i >= 10; i -= 1) {
    if (((value >> i) & 1) !== 0) value ^= 0x537 << (i - 10);
  }
  return ((data << 10) | value) ^ 0x5412;
}

function bchVersionInfo(version) {
  let value = version << 12;
  for (let i = 17; i >= 12; i -= 1) {
    if (((value >> i) & 1) !== 0) value ^= 0x1f25 << (i - 12);
  }
  return (version << 12) | value;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function makeMatrix(version) {
  const size = 17 + 4 * version;
  const modules = [];
  const reserved = [];
  for (let r = 0; r < size; r += 1) {
    modules.push(new Array(size).fill(false));
    reserved.push(new Array(size).fill(false));
  }
  const set = (r, c, dark) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    modules[r][c] = dark === true;
    reserved[r][c] = true;
  };
  const finder = (row, col) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const rr = row + r;
        const cc = col + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const dark = (r >= 0 && r <= 6 && (c === 0 || c === 6))
          || (c >= 0 && c <= 6 && (r === 0 || r === 6))
          || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        set(rr, cc, dark);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);
  for (let i = 8; i < size - 8; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const centers = ALIGN_CENTERS[version];
  for (const row of centers) {
    for (const col of centers) {
      if ((row === 6 && col === 6) || (row === 6 && col === size - 7) || (row === size - 7 && col === 6)) continue;
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
          set(row + r, col + c, dark);
        }
      }
    }
  }
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) { set(8, i, false); set(i, 8, false); }
  }
  set(8, 8, false);
  for (let i = 0; i < 8; i += 1) set(8, size - 1 - i, false);
  for (let i = 0; i < 7; i += 1) set(size - 1 - i, 8, false);
  set(size - 8, 8, false);   // 固定黑点位置：不让数据占
  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      set(Math.floor(i / 3), size - 11 + (i % 3), false);
      set(size - 11 + (i % 3), Math.floor(i / 3), false);
    }
  }
  return { size, modules, reserved };
}

function placeData(matrix, codewords) {
  const { size, modules, reserved } = matrix;
  const bits = [];
  for (const byte of codewords) for (let i = 7; i >= 0; i -= 1) bits.push((byte >> i) & 1);
  let bitIndex = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (let offset = 0; offset < 2; offset += 1) {
        const col = right - offset;
        if (reserved[row][col]) continue;
        const bit = bitIndex < bits.length ? bits[bitIndex] : 0;
        bitIndex += 1;
        modules[row][col] = bit === 1;
      }
    }
    upward = !upward;
  }
}

function applyMask(matrix, maskIndex) {
  const { size, modules, reserved } = matrix;
  const fn = MASKS[maskIndex];
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (reserved[r][c]) continue;
      if (fn(r, c)) modules[r][c] = !modules[r][c];
    }
  }
}

function putFormatInfo(matrix, maskIndex) {
  const { size, modules } = matrix;
  const value = bchFormatInfo(maskIndex);
  const bit = (i) => ((value >> i) & 1) === 1;
  for (let i = 0; i < 15; i += 1) {
    const dark = bit(i);
    // 竖排（第 8 列）：bit0..5 在 0..5 行，bit6/7 在 7/8 行，bit8..14 在 size-7..size-1 行
    if (i < 6) modules[i][8] = dark;
    else if (i < 8) modules[i + 1][8] = dark;
    else modules[size - 15 + i][8] = dark;
    // 横排（第 8 行）：bit0..7 在 size-1..size-8 列，bit8 在第 7 列，bit9..14 在 5..0 列
    if (i < 8) modules[8][size - 1 - i] = dark;
    else if (i === 8) modules[8][7] = dark;
    else modules[8][15 - i - 1] = dark;
  }
  modules[size - 8][8] = true;
}

function putVersionInfo(matrix, version) {
  if (version < 7) return;
  const { size, modules } = matrix;
  const value = bchVersionInfo(version);
  for (let i = 0; i < 18; i += 1) {
    const dark = ((value >> i) & 1) === 1;
    const row = Math.floor(i / 3);
    const col = size - 11 + (i % 3);
    modules[row][col] = dark;
    modules[col][row] = dark;
  }
}

function penalty(matrix) {
  const { size, modules } = matrix;
  let score = 0;
  const runScore = (line) => {
    let total = 0;
    let run = 1;
    for (let i = 1; i < line.length; i += 1) {
      if (line[i] === line[i - 1]) run += 1;
      else { if (run >= 5) total += 3 + (run - 5); run = 1; }
    }
    if (run >= 5) total += 3 + (run - 5);
    return total;
  };
  for (let r = 0; r < size; r += 1) score += runScore(modules[r]);
  for (let c = 0; c < size; c += 1) score += runScore(modules.map((row) => row[c]));
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) score += 3;
    }
  }
  const patternA = [true, false, true, true, true, false, true, false, false, false, false];
  const patternB = [false, false, false, false, true, false, true, true, true, false, true];
  const matches = (line, at, pattern) => {
    for (let i = 0; i < pattern.length; i += 1) if (line[at + i] !== pattern[i]) return false;
    return true;
  };
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c + 11 <= size; c += 1) {
      if (matches(modules[r], c, patternA)) score += 40;
      if (matches(modules[r], c, patternB)) score += 40;
    }
  }
  for (let c = 0; c < size; c += 1) {
    const col = modules.map((row) => row[c]);
    for (let r = 0; r + 11 <= size; r += 1) {
      if (matches(col, r, patternA)) score += 40;
      if (matches(col, r, patternB)) score += 40;
    }
  }
  let dark = 0;
  for (const row of modules) for (const value of row) if (value) dark += 1;
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return score;
}

/** 把文本编成二维码矩阵（自动选版本与掩码）。 */
export function encode(text) {
  const picked = chooseVersion(text);
  if (picked.version === 0) throw new Error('QR：内容太长（超出本项目支持的版本 9 / 纠错等级 M）');
  const codewords = interleave(buildCodewords(picked.bytes, picked.version), picked.version);
  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const matrix = makeMatrix(picked.version);
    placeData(matrix, codewords);
    applyMask(matrix, mask);
    putFormatInfo(matrix, mask);
    putVersionInfo(matrix, picked.version);
    const score = penalty(matrix);
    if (best === null || score < best.score) best = { score, mask, matrix };
  }
  return { version: picked.version, size: best.matrix.size, mask: best.mask, modules: best.matrix.modules };
}

/** 终端渲染：半块字符两行并一行，留 2 格静区。 */
export function toTerminal(text) {
  const { modules } = encode(text);
  const size = modules.length;
  const quiet = 2;
  const lines = [];
  for (let r = -quiet; r < size + quiet; r += 2) {
    let line = '';
    for (let c = -quiet; c < size + quiet; c += 1) {
      const top = r >= 0 && r < size && c >= 0 && c < size ? modules[r][c] : false;
      const bottomRow = r + 1;
      const bottom = bottomRow >= 0 && bottomRow < size && c >= 0 && c < size ? modules[bottomRow][c] : false;
      if (top && bottom) line += '█';
      else if (top) line += '▀';
      else if (bottom) line += '▄';
      else line += ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}
