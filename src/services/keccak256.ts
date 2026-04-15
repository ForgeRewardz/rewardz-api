// Minimal pure-TypeScript Keccak-256 (original Keccak, *not* NIST SHA3-256).
//
// Matches the `sha3::Keccak256` crate used on-chain. The only deviation from
// SHA3-256 is the domain-separation byte (Keccak uses 0x01, SHA3 uses 0x06).
// Implemented with 32-bit lane halves to avoid BigInt overhead and sidestep
// the subtleties of `(1n<<64n)` wrap-around.
//
// Used by game-service.ts to mirror `compute_player_hit` /
// `compute_motherlode_hit` byte-for-byte off-chain.

// ---- Round constants, split into (high, low) 32-bit halves ----------------

// prettier-ignore
const RC_HI = new Uint32Array([
  0x00000000, 0x00000000, 0x80000000, 0x80000000,
  0x00000000, 0x00000000, 0x80000000, 0x80000000,
  0x00000000, 0x00000000, 0x00000000, 0x00000000,
  0x00000000, 0x80000000, 0x80000000, 0x80000000,
  0x80000000, 0x80000000, 0x00000000, 0x80000000,
  0x80000000, 0x80000000, 0x00000000, 0x80000000,
]);

// prettier-ignore
const RC_LO = new Uint32Array([
  0x00000001, 0x00008082, 0x0000808a, 0x80008000,
  0x0000808b, 0x80000001, 0x80008081, 0x00008009,
  0x0000008a, 0x00000088, 0x80008009, 0x8000000a,
  0x8000808b, 0x0000008b, 0x00008089, 0x00008003,
  0x00008002, 0x00000080, 0x0000800a, 0x8000000a,
  0x80008081, 0x00008080, 0x80000001, 0x80008008,
]);

// Rotation offsets for the ρ step, indexed by lane position i = x + 5*y
// (classic Keccak ordering).
// prettier-ignore
const R = [
  0,  1, 62, 28, 27,
  36, 44,  6, 55, 20,
   3, 10, 43, 25, 39,
  41, 45, 15, 21,  8,
  18,  2, 61, 56, 14,
];

// 64-bit rotate-left on (hi, lo) halves, returning [hi, lo]. Handles n=0..63.
function rotl(hi: number, lo: number, n: number): [number, number] {
  const m = n & 63;
  if (m === 0) return [hi >>> 0, lo >>> 0];
  if (m < 32) {
    return [
      ((hi << m) | (lo >>> (32 - m))) >>> 0,
      ((lo << m) | (hi >>> (32 - m))) >>> 0,
    ];
  }
  const k = m - 32;
  if (k === 0) {
    return [lo >>> 0, hi >>> 0];
  }
  return [
    ((lo << k) | (hi >>> (32 - k))) >>> 0,
    ((hi << k) | (lo >>> (32 - k))) >>> 0,
  ];
}

// Keccak-f[1600] on a state of 25 lanes, represented as two Uint32Arrays
// (high/low halves of each 64-bit lane).
function keccakF1600(sh: Uint32Array, sl: Uint32Array): void {
  const CH = new Uint32Array(5);
  const CL = new Uint32Array(5);
  const DH = new Uint32Array(5);
  const DL = new Uint32Array(5);
  const BH = new Uint32Array(25);
  const BL = new Uint32Array(25);

  for (let round = 0; round < 24; round++) {
    // θ: column parities
    for (let x = 0; x < 5; x++) {
      CH[x] = sh[x] ^ sh[x + 5] ^ sh[x + 10] ^ sh[x + 15] ^ sh[x + 20];
      CL[x] = sl[x] ^ sl[x + 5] ^ sl[x + 10] ^ sl[x + 15] ^ sl[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      const [rH, rL] = rotl(CH[(x + 1) % 5], CL[(x + 1) % 5], 1);
      DH[x] = CH[(x + 4) % 5] ^ rH;
      DL[x] = CL[(x + 4) % 5] ^ rL;
    }
    for (let i = 0; i < 25; i++) {
      sh[i] ^= DH[i % 5];
      sl[i] ^= DL[i % 5];
    }

    // ρ + π: rotate then permute lanes to position (y, 2x+3y)
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const i = x + 5 * y;
        const [rH, rL] = rotl(sh[i], sl[i], R[i]);
        const j = y + 5 * ((2 * x + 3 * y) % 5);
        BH[j] = rH;
        BL[j] = rL;
      }
    }

    // χ: non-linear row step
    for (let y = 0; y < 5; y++) {
      const o = y * 5;
      const h0 = BH[o + 0],
        l0 = BL[o + 0];
      const h1 = BH[o + 1],
        l1 = BL[o + 1];
      const h2 = BH[o + 2],
        l2 = BL[o + 2];
      const h3 = BH[o + 3],
        l3 = BL[o + 3];
      const h4 = BH[o + 4],
        l4 = BL[o + 4];
      sh[o + 0] = (h0 ^ (~h1 & h2)) >>> 0;
      sl[o + 0] = (l0 ^ (~l1 & l2)) >>> 0;
      sh[o + 1] = (h1 ^ (~h2 & h3)) >>> 0;
      sl[o + 1] = (l1 ^ (~l2 & l3)) >>> 0;
      sh[o + 2] = (h2 ^ (~h3 & h4)) >>> 0;
      sl[o + 2] = (l2 ^ (~l3 & l4)) >>> 0;
      sh[o + 3] = (h3 ^ (~h4 & h0)) >>> 0;
      sl[o + 3] = (l3 ^ (~l4 & l0)) >>> 0;
      sh[o + 4] = (h4 ^ (~h0 & h1)) >>> 0;
      sl[o + 4] = (l4 ^ (~l0 & l1)) >>> 0;
    }

    // ι: add round constant to lane 0
    sh[0] = (sh[0] ^ RC_HI[round]) >>> 0;
    sl[0] = (sl[0] ^ RC_LO[round]) >>> 0;
  }
}

/**
 * Keccak-256 (pre-NIST Keccak). Padding byte: 0x01. Output: 32 bytes.
 */
export function keccak256(input: Uint8Array): Uint8Array {
  const rate = 136; // 1088-bit rate for 256-bit output
  const sh = new Uint32Array(25);
  const sl = new Uint32Array(25);
  const buffer = new Uint8Array(rate);

  const absorbBlock = () => {
    // Each 8-byte chunk → one little-endian 64-bit lane (lo first, then hi).
    for (let i = 0; i < rate / 8; i++) {
      const off = i * 8;
      const lo =
        (buffer[off] |
          (buffer[off + 1] << 8) |
          (buffer[off + 2] << 16) |
          (buffer[off + 3] << 24)) >>>
        0;
      const hi =
        (buffer[off + 4] |
          (buffer[off + 5] << 8) |
          (buffer[off + 6] << 16) |
          (buffer[off + 7] << 24)) >>>
        0;
      sl[i] = (sl[i] ^ lo) >>> 0;
      sh[i] = (sh[i] ^ hi) >>> 0;
    }
    keccakF1600(sh, sl);
  };

  let filled = 0;
  let consumed = 0;
  const total = input.length;
  while (consumed < total) {
    const take = Math.min(rate - filled, total - consumed);
    buffer.set(input.subarray(consumed, consumed + take), filled);
    filled += take;
    consumed += take;
    if (filled === rate) {
      absorbBlock();
      filled = 0;
    }
  }

  // Padding (Keccak domain separator: 0x01 ... 0x80)
  buffer.fill(0, filled);
  buffer[filled] = 0x01;
  buffer[rate - 1] = (buffer[rate - 1] | 0x80) & 0xff;
  absorbBlock();

  // Squeeze: emit first 32 bytes (lanes 0..3) little-endian.
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    const off = i * 8;
    const lo = sl[i];
    const hi = sh[i];
    out[off + 0] = lo & 0xff;
    out[off + 1] = (lo >>> 8) & 0xff;
    out[off + 2] = (lo >>> 16) & 0xff;
    out[off + 3] = (lo >>> 24) & 0xff;
    out[off + 4] = hi & 0xff;
    out[off + 5] = (hi >>> 8) & 0xff;
    out[off + 6] = (hi >>> 16) & 0xff;
    out[off + 7] = (hi >>> 24) & 0xff;
  }
  return out;
}
