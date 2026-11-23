// Copyright (c) 2026 poimaino. MIT licence, see LICENSE in the repository root.
/* A small baseline JPEG encoder for ScanFixer's Compress step. No DOM, Zotero or PDF code in here, so it runs in the
 * render worker (bootstrap.getWorkerSource() puts it in front of the worker) and in Node for tests.
 *
 * Why not the browser's canvas.toBlob("image/jpeg")? It always writes three colour channels with generic Huffman
 * tables, even for a greyscale picture. A scanned page is mostly flat white, which is exactly where that overhead
 * is worst, so a "greyscale" file could come out LARGER than the colour original. This encoder writes
 *   - a true one-channel JPEG for greyscale (no empty colour channels), and
 *   - Huffman tables built from the page's own statistics (what jpegtran -optimize does),
 *   - 4:2:0 chroma subsampling for colour.
 *
 *   ScanFixerJpeg.encodeGray(gray, w, h, quality)  -> Uint8Array   gray: 8-bit, index y*w+x
 *   ScanFixerJpeg.encodeRGBA(rgba, w, h, quality)  -> Uint8Array   rgba: 8-bit RGBA, 4:2:0
 * quality is 1..100 like everywhere else (the standard libjpeg scaling of the standard tables).
 */
var ScanFixerJpeg = (function () {
  "use strict";

  const ZIGZAG = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
  ];
  const BASE_LUMA = [
    16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
  ];
  const BASE_CHROMA = [
    17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  ];

  /** The standard tables scaled for a quality, in natural (row-major) order. */
  function quantTable(base, quality) {
    const q = Math.min(100, Math.max(1, Math.round(quality)));
    const scale = q < 50 ? 5000 / q : 200 - 2 * q;
    return base.map((v) => Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100))));
  }

  // 8-point DCT as a matrix: C[u*8+x] = a(u) cos((2x+1) u pi / 16). Two passes (rows, then columns) give the 2-D DCT.
  const DCT = new Float32Array(64);
  for (let u = 0; u < 8; u++) for (let x = 0; x < 8; x++) DCT[u * 8 + x] = (u === 0 ? Math.SQRT1_2 : 1) * 0.5 * Math.cos(((2 * x + 1) * u * Math.PI) / 16);

  /**
   * Cut a plane into 8x8 blocks, transform, quantise and store each block in zigzag order.
   * The plane is padded to whole blocks by repeating its edge pixels.
   */
  function quantiseBlocks(plane, pw, ph, blocksX, blocksY, qt) {
    const coef = new Int16Array(blocksX * blocksY * 64);
    const inv = new Float32Array(64);
    for (let i = 0; i < 64; i++) inv[i] = 1 / qt[i];
    const tmp = new Float32Array(64), blk = new Float32Array(64), out = new Float32Array(64);
    for (let by = 0; by < blocksY; by++) {
      for (let bx = 0; bx < blocksX; bx++) {
        for (let y = 0; y < 8; y++) {
          const sy = Math.min(ph - 1, by * 8 + y) * pw;
          for (let x = 0; x < 8; x++) blk[y * 8 + x] = plane[sy + Math.min(pw - 1, bx * 8 + x)] - 128;
        }
        // rows: tmp[y][u] = sum_x blk[y][x] C[u][x]
        for (let y = 0; y < 8; y++) {
          for (let u = 0; u < 8; u++) {
            let s = 0;
            for (let x = 0; x < 8; x++) s += blk[y * 8 + x] * DCT[u * 8 + x];
            tmp[y * 8 + u] = s;
          }
        }
        // columns: out[v][u] = sum_y tmp[y][u] C[v][y]
        for (let v = 0; v < 8; v++) {
          for (let u = 0; u < 8; u++) {
            let s = 0;
            for (let y = 0; y < 8; y++) s += tmp[y * 8 + u] * DCT[v * 8 + y];
            out[v * 8 + u] = s;
          }
        }
        const o = (by * blocksX + bx) * 64;
        for (let k = 0; k < 64; k++) {
          const z = ZIGZAG[k];
          coef[o + k] = Math.round(out[z] * inv[z]);
        }
      }
    }
    return coef;
  }

  const bitLength = (v) => (v === 0 ? 0 : 32 - Math.clz32(v));

  /** JPEG Annex K.2: Huffman code lengths from symbol frequencies, limited to 16 bits. Returns {bits[1..16], vals}. */
  function optimalTable(freqIn) {
    const freq = Float64Array.from(freqIn);
    freq[256] = 1; // reserved symbol, so that no real symbol gets the all-ones code
    const codesize = new Int32Array(257), others = new Int32Array(257).fill(-1);
    for (;;) {
      let c1 = -1, v = Infinity;
      for (let i = 0; i <= 256; i++) if (freq[i] && freq[i] <= v) { v = freq[i]; c1 = i; }
      let c2 = -1; v = Infinity;
      for (let i = 0; i <= 256; i++) if (freq[i] && freq[i] <= v && i !== c1) { v = freq[i]; c2 = i; }
      if (c2 < 0) break;
      freq[c1] += freq[c2];
      freq[c2] = 0;
      codesize[c1]++;
      while (others[c1] >= 0) { c1 = others[c1]; codesize[c1]++; }
      others[c1] = c2;
      codesize[c2]++;
      while (others[c2] >= 0) { c2 = others[c2]; codesize[c2]++; }
    }
    const bits = new Int32Array(33);
    for (let i = 0; i <= 256; i++) if (codesize[i]) bits[codesize[i]]++;
    for (let i = 32; i > 16; i--) {
      while (bits[i] > 0) {
        let j = i - 2;
        while (bits[j] === 0) j--;
        bits[i] -= 2; bits[i - 1]++; bits[j + 1] += 2; bits[j]--;
      }
    }
    let i = 16;
    while (bits[i] === 0) i--;
    bits[i]--; // drop the reserved symbol
    const vals = [];
    for (let len = 1; len <= 32; len++) for (let s = 0; s < 256; s++) if (codesize[s] === len) vals.push(s);
    return { bits: Array.from(bits.slice(1, 17)), vals };
  }

  /** Canonical codes for a table: code[sym], size[sym]. */
  function codesFor(table) {
    const code = new Int32Array(256), size = new Int32Array(256);
    let c = 0, k = 0;
    for (let len = 1; len <= 16; len++) {
      for (let n = 0; n < table.bits[len - 1]; n++) { code[table.vals[k]] = c; size[table.vals[k]] = len; k++; c++; }
      c <<= 1;
    }
    return { code, size };
  }

  class Bytes {
    constructor(cap) { this.a = new Uint8Array(cap); this.n = 0; }
    put(b) { if (this.n === this.a.length) { const g = new Uint8Array(this.a.length * 2); g.set(this.a); this.a = g; } this.a[this.n++] = b; }
    word(v) { this.put(v >> 8); this.put(v & 255); }
    bytes(arr) { for (const b of arr) this.put(b); }
    done() { return this.a.slice(0, this.n); }
  }

  /**
   * comps: [{ coef, blocksX, blocksY, hs, vs, table: 0|1 (which DQT / Huffman set) }], scan order as listed.
   * Walks the blocks in MCU order, calling visit(compIndex, blockOffset) for each.
   */
  function walk(comps, mcusX, mcusY, visit) {
    if (comps.length === 1) {
      const c = comps[0];
      for (let by = 0; by < c.blocksY; by++) for (let bx = 0; bx < c.blocksX; bx++) visit(0, (by * c.blocksX + bx) * 64);
      return;
    }
    for (let my = 0; my < mcusY; my++) {
      for (let mx = 0; mx < mcusX; mx++) {
        for (let ci = 0; ci < comps.length; ci++) {
          const c = comps[ci];
          for (let v = 0; v < c.vs; v++) for (let h = 0; h < c.hs; h++) visit(ci, ((my * c.vs + v) * c.blocksX + mx * c.hs + h) * 64);
        }
      }
    }
  }

  function encode(width, height, comps, qtables, hasColour) {
    const nTables = hasColour ? 2 : 1;
    // pass 1: symbol statistics
    const dcFreq = [new Float64Array(257), new Float64Array(257)], acFreq = [new Float64Array(257), new Float64Array(257)];
    const mcusX = Math.ceil(width / (8 * Math.max(...comps.map((c) => c.hs)))), mcusY = Math.ceil(height / (8 * Math.max(...comps.map((c) => c.vs))));
    let pred = comps.map(() => 0);
    const scanBlock = (ci, off, onDC, onAC) => {
      const c = comps[ci], coef = c.coef;
      const diff = coef[off] - pred[ci];
      pred[ci] = coef[off];
      onDC(c.table, diff);
      let run = 0;
      for (let k = 1; k < 64; k++) {
        const v = coef[off + k];
        if (v === 0) { run++; continue; }
        while (run > 15) { onAC(c.table, 0xf0, 0, 0); run -= 16; }
        onAC(c.table, (run << 4) | bitLength(Math.abs(v)), v, bitLength(Math.abs(v)));
        run = 0;
      }
      if (run > 0) onAC(c.table, 0x00, 0, 0);
    };
    walk(comps, mcusX, mcusY, (ci, off) => scanBlock(ci, off, (t, d) => { dcFreq[t][bitLength(Math.abs(d))]++; }, (t, sym) => { acFreq[t][sym]++; }));
    const dcT = [], acT = [], dcC = [], acC = [];
    for (let t = 0; t < nTables; t++) {
      dcT.push(optimalTable(dcFreq[t])); acT.push(optimalTable(acFreq[t]));
      dcC.push(codesFor(dcT[t])); acC.push(codesFor(acT[t]));
    }

    // headers
    const out = new Bytes(Math.max(4096, (width * height) >> 3));
    out.word(0xffd8);
    out.word(0xffe0); out.word(16); out.bytes([0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]); // JFIF 1.01
    for (let t = 0; t < nTables; t++) {
      out.word(0xffdb); out.word(67); out.put(t);
      for (let k = 0; k < 64; k++) out.put(qtables[t][ZIGZAG[k]]);
    }
    out.word(0xffc0); out.word(8 + 3 * comps.length); out.put(8); out.word(height); out.word(width); out.put(comps.length);
    comps.forEach((c, i) => { out.put(i + 1); out.put((c.hs << 4) | c.vs); out.put(c.table); });
    for (let t = 0; t < nTables; t++) {
      for (const [cls, tab] of [[0, dcT[t]], [1, acT[t]]]) {
        out.word(0xffc4); out.word(19 + tab.vals.length); out.put((cls << 4) | t); out.bytes(tab.bits); out.bytes(tab.vals);
      }
    }
    out.word(0xffda); out.word(6 + 2 * comps.length); out.put(comps.length);
    comps.forEach((c, i) => { out.put(i + 1); out.put((c.table << 4) | c.table); });
    out.put(0); out.put(63); out.put(0);

    // pass 2: the entropy-coded data
    let buf = 0, cnt = 0;
    const emit = (code, size) => {
      buf = (buf << size) | code;
      cnt += size;
      while (cnt >= 8) {
        const b = (buf >> (cnt - 8)) & 255;
        out.put(b);
        if (b === 255) out.put(0);
        cnt -= 8;
      }
      buf &= (1 << cnt) - 1;
    };
    const amp = (v, size) => (v < 0 ? v + (1 << size) - 1 : v);
    pred = comps.map(() => 0);
    walk(comps, mcusX, mcusY, (ci, off) =>
      scanBlock(
        ci, off,
        (t, d) => { const s = bitLength(Math.abs(d)); emit(dcC[t].code[s], dcC[t].size[s]); if (s) emit(amp(d, s), s); },
        (t, sym, v, s) => { emit(acC[t].code[sym], acC[t].size[sym]); if (s) emit(amp(v, s), s); }
      )
    );
    if (cnt > 0) emit((1 << (8 - cnt)) - 1, 8 - cnt); // pad with 1-bits
    out.word(0xffd9);
    return out.done();
  }

  function encodeGray(gray, w, h, quality) {
    const qt = quantTable(BASE_LUMA, quality);
    const bx = Math.ceil(w / 8), by = Math.ceil(h / 8);
    const coef = quantiseBlocks(gray, w, h, bx, by, qt);
    return encode(w, h, [{ coef, blocksX: bx, blocksY: by, hs: 1, vs: 1, table: 0 }], [qt], false);
  }

  function encodeRGBA(rgba, w, h, quality) {
    const qy = quantTable(BASE_LUMA, quality), qc = quantTable(BASE_CHROMA, quality);
    const n = w * h, Y = new Uint8Array(n);
    const cw = Math.ceil(w / 2), ch = Math.ceil(h / 2);
    const cbSum = new Float32Array(cw * ch), crSum = new Float32Array(cw * ch), cnt = new Uint8Array(cw * ch);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
        Y[y * w + x] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        const ci = (y >> 1) * cw + (x >> 1);
        cbSum[ci] += 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
        crSum[ci] += 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
        cnt[ci]++;
      }
    }
    const Cb = new Uint8Array(cw * ch), Cr = new Uint8Array(cw * ch);
    for (let i = 0; i < cw * ch; i++) { Cb[i] = Math.round(cbSum[i] / cnt[i]); Cr[i] = Math.round(crSum[i] / cnt[i]); }
    const mcusX = Math.ceil(w / 16), mcusY = Math.ceil(h / 16);
    const comps = [
      { coef: quantiseBlocks(Y, w, h, mcusX * 2, mcusY * 2, qy), blocksX: mcusX * 2, blocksY: mcusY * 2, hs: 2, vs: 2, table: 0 },
      { coef: quantiseBlocks(Cb, cw, ch, mcusX, mcusY, qc), blocksX: mcusX, blocksY: mcusY, hs: 1, vs: 1, table: 1 },
      { coef: quantiseBlocks(Cr, cw, ch, mcusX, mcusY, qc), blocksX: mcusX, blocksY: mcusY, hs: 1, vs: 1, table: 1 },
    ];
    return encode(w, h, comps, [qy, qc], true);
  }

  return { encodeGray, encodeRGBA, quantTable, optimalTable };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ScanFixerJpeg;
