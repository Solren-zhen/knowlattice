/**
 * 纯前端二维码编码（QR Code Model 2 / Byte 模式 / 纠错等级 M）。
 *
 * 项目没有二维码依赖，而 B 站扫码登录需要把登录 URL 画成二维码，所以这里手写一个
 * 最小编码器：只覆盖 version 1–10（v10-M 能放 213 字节，足够登录链接），只输出
 * 行优先布尔矩阵，具体渲染（SVG / canvas）交给 UI。
 */

/** 单个数据块分组：块数 + 每块数据码字数 */
interface BlockGroup {
  count: number;
  dataBytes: number;
}

/** 某个版本的 M 级纠错参数 */
interface EcSpec {
  /** 每块纠错码字数 */
  ecPerBlock: number;
  /** 数据块分组，短块在前（交错时需要） */
  groups: BlockGroup[];
}

/** M 级纠错参数表，下标 = version - 1 */
const EC_M: readonly EcSpec[] = [
  { ecPerBlock: 10, groups: [{ count: 1, dataBytes: 16 }] },
  { ecPerBlock: 16, groups: [{ count: 1, dataBytes: 28 }] },
  { ecPerBlock: 26, groups: [{ count: 1, dataBytes: 44 }] },
  { ecPerBlock: 18, groups: [{ count: 2, dataBytes: 32 }] },
  { ecPerBlock: 24, groups: [{ count: 2, dataBytes: 43 }] },
  { ecPerBlock: 16, groups: [{ count: 4, dataBytes: 27 }] },
  { ecPerBlock: 18, groups: [{ count: 4, dataBytes: 31 }] },
  { ecPerBlock: 22, groups: [{ count: 2, dataBytes: 38 }, { count: 2, dataBytes: 39 }] },
  { ecPerBlock: 22, groups: [{ count: 3, dataBytes: 36 }, { count: 2, dataBytes: 37 }] },
  { ecPerBlock: 26, groups: [{ count: 4, dataBytes: 43 }, { count: 1, dataBytes: 44 }] },
];

/** 各版本校正图案的中心坐标（行列共用） */
const ALIGNMENT: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

/** 纠错容量表里某个版本的数据码字总数 */
function dataCodewordCount(version: number): number {
  return EC_M[version - 1].groups.reduce((n, g) => n + g.count * g.dataBytes, 0);
}

/** 选中能容纳这些字节的最小版本 */
function pickVersion(byteLength: number): number {
  for (let version = 1; version <= 10; version++) {
    const headerBits = 4 + (version <= 9 ? 8 : 16); // 模式指示符 + 字符计数
    if (headerBits + byteLength * 8 <= dataCodewordCount(version) * 8) return version;
  }
  throw new Error('text too long for QR version 1-10');
}

// ---------- GF(256) 与 Reed-Solomon ----------

const GF_EXP = new Array<number>(512).fill(0);
const GF_LOG = new Array<number>(256).fill(0);

// 本原多项式 0x11D
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** 生成 degree 次的 RS 生成多项式（不含首项 1，供竖式除法用） */
function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

/** 计算一个数据块的纠错码字 */
function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() as number);
    result.push(0);
    for (let i = 0; i < divisor.length; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

// ---------- 数据码字 ----------

/** UTF-8 编码（Byte 模式） */
function utf8Bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

/** 生成数据码字：模式 + 计数 + 数据 + 终止符 + 补齐 + 填充字节 */
function buildDataCodewords(version: number, bytes: readonly number[]): number[] {
  const capacityBits = dataCodewordCount(version) * 8;
  const bits: number[] = [];
  const pushBits = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };

  pushBits(0b0100, 4); // Byte 模式
  pushBits(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) pushBits(byte, 8);

  // 终止符最多 4 位，然后补齐到字节边界
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  // 交替填充 0xEC / 0x11 直到填满
  const pads = [0xec, 0x11];
  for (let i = 0; codewords.length < dataCodewordCount(version); i++) codewords.push(pads[i % 2]);
  return codewords;
}

/** 分块计算纠错码，再按 QR 规范交错排布 */
function addErrorCorrection(version: number, data: readonly number[]): number[] {
  const spec = EC_M[version - 1];
  const divisor = rsDivisor(spec.ecPerBlock);
  const dataBlocks: number[][] = [];
  let offset = 0;
  for (const group of spec.groups) {
    for (let i = 0; i < group.count; i++) {
      dataBlocks.push(data.slice(offset, offset + group.dataBytes));
      offset += group.dataBytes;
    }
  }
  const ecBlocks = dataBlocks.map((block) => rsRemainder(block, divisor));

  const maxData = Math.max(...dataBlocks.map((block) => block.length));
  const out: number[] = [];
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const block of ecBlocks) out.push(block[i]);
  }
  return out;
}

// ---------- 矩阵 ----------

/** 掩码条件：返回 true 表示该模块需要取反 */
function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

/** 生成一版矩阵（不含掩码选择），setFn 同时登记功能模块 */
function buildMatrix(version: number, codewords: readonly number[], mask: number): boolean[][] {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const setFn = (x: number, y: number, dark: boolean) => {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };

  // timing
  for (let i = 0; i < size; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }

  // 定位图案 + 分隔符（会覆盖 timing 的两端）
  const drawFinder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || x >= size || y < 0 || y >= size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        setFn(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);

  // 校正图案（跳过与三个定位图案重合的角）
  const centers = ALIGNMENT[version - 1];
  const n = centers.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      const cx = centers[i];
      const cy = centers[j];
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // format info（M 级 = 0b00），同时写入固定深色模块
  const formatData = (0b00 << 3) | mask;
  let formatRem = formatData;
  for (let i = 0; i < 10; i++) formatRem = (formatRem << 1) ^ ((formatRem >>> 9) * 0x537);
  const formatBits = ((formatData << 10) | formatRem) ^ 0x5412;
  const formatBit = (i: number) => ((formatBits >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i++) setFn(8, i, formatBit(i));
  setFn(8, 7, formatBit(6));
  setFn(8, 8, formatBit(7));
  setFn(7, 8, formatBit(8));
  for (let i = 9; i < 15; i++) setFn(14 - i, 8, formatBit(i));
  for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, formatBit(i));
  for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, formatBit(i));
  setFn(8, size - 8, true);

  // version info（v7 起）
  if (version >= 7) {
    let versionRem = version;
    for (let i = 0; i < 12; i++) versionRem = (versionRem << 1) ^ ((versionRem >>> 11) * 0x1f25);
    const versionBits = (version << 12) | versionRem;
    for (let i = 0; i < 18; i++) {
      const dark = ((versionBits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFn(b, a, dark);
      setFn(a, b, dark);
    }
  }

  // 数据码字：从右下角开始两列一组、蛇形向上/向下填
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (isFunction[y][x] || bitIndex >= totalBits) continue;
        modules[y][x] = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0;
        bitIndex++;
      }
    }
  }

  // 掩码只作用于非功能模块
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!isFunction[y][x] && maskBit(mask, x, y)) modules[y][x] = !modules[y][x];
    }
  }
  return modules;
}

/** 罚分（规则 1、2、4），用于挑一个观感更好的掩码 */
function penaltyScore(matrix: readonly boolean[][]): number {
  const size = matrix.length;
  let score = 0;

  // 规则 1：同色连续 5 个以上
  for (let i = 0; i < size; i++) {
    let runRow = 1;
    let runCol = 1;
    for (let j = 1; j < size; j++) {
      if (matrix[i][j] === matrix[i][j - 1]) {
        runRow++;
      } else {
        if (runRow >= 5) score += 3 + (runRow - 5);
        runRow = 1;
      }
      if (matrix[j][i] === matrix[j - 1][i]) {
        runCol++;
      } else {
        if (runCol >= 5) score += 3 + (runCol - 5);
        runCol = 1;
      }
    }
    if (runRow >= 5) score += 3 + (runRow - 5);
    if (runCol >= 5) score += 3 + (runCol - 5);
  }

  // 规则 2：2x2 同色块
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const color = matrix[y][x];
      if (color === matrix[y][x + 1] && color === matrix[y + 1][x] && color === matrix[y + 1][x + 1]) score += 3;
    }
  }

  // 规则 4：深色比例偏离 50%
  let dark = 0;
  for (const row of matrix) for (const cell of row) if (cell) dark++;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

/**
 * 把文本编码成二维码矩阵。
 *
 * @param text 任意 UTF-8 文本
 * @returns 行优先矩阵，matrix[row][col] 为 true 表示深色模块
 * @throws 文本超出 version 1–10 的 Byte 容量时抛错
 */
export function encodeQr(text: string): boolean[][] {
  const bytes = utf8Bytes(text);
  const version = pickVersion(bytes.length);
  const codewords = addErrorCorrection(version, buildDataCodewords(version, bytes));

  let best = buildMatrix(version, codewords, 0);
  let bestScore = penaltyScore(best);
  for (let mask = 1; mask < 8; mask++) {
    const matrix = buildMatrix(version, codewords, mask);
    const score = penaltyScore(matrix);
    if (score < bestScore) {
      best = matrix;
      bestScore = score;
    }
  }
  return best;
}

/**
 * 把矩阵转成 SVG path，坐标与矩阵一一对应（每格 1 单位）。
 * 同一行的连续深色模块会合并成一个矩形。
 */
export function qrPathData(matrix: boolean[][]): string {
  const parts: string[] = [];
  for (let y = 0; y < matrix.length; y++) {
    const row = matrix[y];
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      let width = 1;
      while (x + width < row.length && row[x + width]) width++;
      parts.push(`M${x} ${y}h${width}v1h-${width}z`);
      x += width;
    }
  }
  return parts.join('');
}
