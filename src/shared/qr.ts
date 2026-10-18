/**
 * QR codes, so a link (a share, an invite, emergency access, pairing) can be
 * scanned instead of typed. Byte mode, error correction level M (a code still
 * scans with about 15% of it damaged or smudged), versions 1 to 15: up to 412
 * bytes, far more than any Cardboard link. Pure and dependency-free, so the
 * dashboard draws it as SVG and the CLI prints it in the terminal.
 *
 * Follows ISO/IEC 18004; the structure mirrors Project Nayuki's reference
 * implementation.
 */

/** Rows of modules, true = dark. */
export type QrMatrix = boolean[][];

// Per version 1–15 at level M: [error-correction codewords per block, blocks in group 1, data codewords per group-1 block, blocks in group 2].
// Group-2 blocks hold one more data codeword than group-1 blocks.
const LEVEL_M: ReadonlyArray<readonly [number, number, number, number]> = [
  [10, 1, 16, 0],
  [16, 1, 28, 0],
  [26, 1, 44, 0],
  [18, 2, 32, 0],
  [24, 2, 43, 0],
  [16, 4, 27, 0],
  [18, 4, 31, 0],
  [22, 2, 38, 2],
  [22, 3, 36, 2],
  [26, 4, 43, 1],
  [30, 1, 50, 4],
  [22, 6, 36, 2],
  [22, 8, 37, 1],
  [24, 4, 40, 5],
  [24, 5, 41, 5],
];

const ALIGNMENT: ReadonlyArray<readonly number[]> = [
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
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
];

/** Level M's two format bits. */
const FORMAT_M = 0b00;

function dataCapacity(version: number): number {
  const [, g1, d1, g2] = LEVEL_M[version - 1]!;
  return g1 * d1 + g2 * (d1 + 1);
}

/** Encodes text (as UTF-8) into a QR code. Throws if it's too long for version 15. `mask` forces one (for tests). */
export function qrEncode(text: string, options: { mask?: number } = {}): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  for (; version <= LEVEL_M.length; version++) {
    const bits = 4 + (version < 10 ? 8 : 16) + bytes.length * 8;
    if (bits <= dataCapacity(version) * 8) break;
  }
  if (version > LEVEL_M.length) throw new Error(`That's too long for a QR code (${bytes.length} bytes, at most 412).`);

  // Mode, length, the bytes, a terminator, then padding to fill every data codeword.
  const capacity = dataCapacity(version);
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacity * 8 - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);

  const codewords = withErrorCorrection(data, version);
  const qr = new Builder(version);
  qr.drawCodewords(codewords);
  let best: QrMatrix | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    if (options.mask !== undefined && mask !== options.mask) continue;
    const candidate = qr.masked(mask);
    const score = penalty(candidate);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best!;
}

// ── Error correction (Reed–Solomon over GF(256), polynomial 0x11d) ─────────

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < degree) result[j]! ^= result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => (result[i]! ^= gfMultiply(coef, factor)));
  }
  return result;
}

/** Splits data into blocks, adds each block's error correction, and interleaves them. */
function withErrorCorrection(data: number[], version: number): number[] {
  const [ecLength, g1, d1, g2] = LEVEL_M[version - 1]!;
  const divisor = rsDivisor(ecLength);
  const blocks: Array<{ data: number[]; ec: number[] }> = [];
  let at = 0;
  for (let i = 0; i < g1 + g2; i++) {
    const size = i < g1 ? d1 : d1 + 1;
    const chunk = data.slice(at, at + size);
    at += size;
    blocks.push({ data: chunk, ec: rsRemainder(chunk, divisor) });
  }
  const out: number[] = [];
  for (let i = 0; i <= d1; i++) for (const block of blocks) if (i < block.data.length) out.push(block.data[i]!);
  for (let i = 0; i < ecLength; i++) for (const block of blocks) out.push(block.ec[i]!);
  return out;
}

// ── Drawing ────────────────────────────────────────────────────────────────

class Builder {
  readonly version: number;
  readonly size: number;
  private readonly modules: boolean[][];
  private readonly reserved: boolean[][];

  constructor(version: number) {
    this.version = version;
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.reserved = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.drawFunctionPatterns();
  }

  private set(x: number, y: number, dark: boolean) {
    this.modules[y]![x] = dark;
    this.reserved[y]![x] = true;
  }

  private drawFunctionPatterns() {
    const { size } = this;
    for (let i = 0; i < size; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [
      [3, 3],
      [size - 4, 3],
      [3, size - 4],
    ] as const) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const distance = Math.max(Math.abs(dx), Math.abs(dy));
          this.set(x, y, distance !== 2 && distance !== 4);
        }
      }
    }
    const positions = ALIGNMENT[this.version - 1]!;
    const last = positions.length - 1;
    positions.forEach((x, i) =>
      positions.forEach((y, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }),
    );
    this.drawFormat(this.modules, 0);
    if (this.version >= 7) {
      let rem = this.version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (this.version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const dark = ((bits >>> i) & 1) === 1;
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.set(a, b, dark);
        this.set(b, a, dark);
      }
    }
  }

  /** The 15 format bits (level and mask, with their own error correction), twice. Also marks them reserved. */
  private drawFormat(grid: boolean[][], mask: number) {
    const { size } = this;
    const data = (FORMAT_M << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) === 1;
    const put = (x: number, y: number, dark: boolean) => {
      grid[y]![x] = dark;
      this.reserved[y]![x] = true;
    };
    for (let i = 0; i <= 5; i++) put(8, i, bit(i));
    put(8, 7, bit(6));
    put(8, 8, bit(7));
    put(7, 8, bit(8));
    for (let i = 9; i < 15; i++) put(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) put(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) put(8, size - 15 + i, bit(i));
    put(8, size - 8, true);
  }

  /** Lays the codewords in the zigzag, two columns at a time, skipping function patterns. */
  drawCodewords(codewords: number[]) {
    const { size } = this;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (this.reserved[y]![x] || i >= codewords.length * 8) continue;
          this.modules[y]![x] = ((codewords[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }

  masked(mask: number): QrMatrix {
    const grid = this.modules.map((row) => [...row]);
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.reserved[y]![x]) continue;
        const flip = [
          (x + y) % 2 === 0,
          y % 2 === 0,
          x % 3 === 0,
          (x + y) % 3 === 0,
          (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
          ((x * y) % 2) + ((x * y) % 3) === 0,
          (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
          (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
        ][mask]!;
        if (flip) grid[y]![x] = !grid[y]![x];
      }
    }
    this.drawFormat(grid, mask);
    return grid;
  }
}

/** The standard penalty: the mask that leaves the fewest confusing patterns wins. */
function penalty(grid: QrMatrix): number {
  const size = grid.length;
  let score = 0;
  const lines = (vertical: boolean) => {
    for (let a = 0; a < size; a++) {
      let color = false;
      let run = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      const addHistory = (length: number) => {
        history.pop();
        history.unshift(history[0] === 0 && history.every((h) => h === 0) ? length + size : length);
      };
      const finderLike = () => {
        const n = history[1]!;
        const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
        return (core && history[0]! >= n * 4 && history[6]! >= n ? 1 : 0) + (core && history[6]! >= n * 4 && history[0]! >= n ? 1 : 0);
      };
      for (let b = 0; b < size; b++) {
        const dark = vertical ? grid[b]![a]! : grid[a]![b]!;
        if (dark === color) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score++;
        } else {
          addHistory(run);
          if (!color) score += finderLike() * 40;
          color = dark;
          run = 1;
        }
      }
      if (color) {
        addHistory(run);
        run = 0;
      }
      addHistory(run + size);
      score += finderLike() * 40;
    }
  };
  lines(false);
  lines(true);
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = grid[y]![x];
      if (c === grid[y]![x + 1] && c === grid[y + 1]![x] && c === grid[y + 1]![x + 1]) score += 3;
    }
  }
  const dark = grid.reduce((n, row) => n + row.filter(Boolean).length, 0);
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

// ── Output ─────────────────────────────────────────────────────────────────

/** An SVG path drawing every dark module, offset by a quiet zone of `margin` modules. */
export function qrPath(matrix: QrMatrix, margin = 4): string {
  const parts: string[] = [];
  matrix.forEach((row, y) => row.forEach((dark, x) => dark && parts.push(`M${x + margin} ${y + margin}h1v1h-1z`)));
  return parts.join("");
}

/**
 * For a terminal: two rows per line with half blocks, dark on light whatever
 * the terminal's colours, so phone cameras read it.
 */
export function qrTerminal(matrix: QrMatrix, margin = 2): string {
  const size = matrix.length + margin * 2;
  const dark = (x: number, y: number) => matrix[y - margin]?.[x - margin] === true;
  const lines: string[] = [];
  for (let y = 0; y < size; y += 2) {
    let line = "";
    for (let x = 0; x < size; x++) {
      const top = dark(x, y);
      const bottom = y + 1 < size && dark(x, y + 1);
      line += `\x1b[${top ? 30 : 97};${bottom ? 40 : 107}m▀`;
    }
    lines.push(`${line}\x1b[0m`);
  }
  return lines.join("\n");
}
