// Copyright (c) 2026 poimaino. MIT licence, see LICENSE in the repository root.
/* Pure pixel routines for ScanFixer. No Zotero, DOM or PDF APIs in here, so it runs in Node for tests
 * and inside the render worker (bootstrap.getWorkerSource() puts this file in front of render-worker.js).
 *
 * Two jobs:
 *
 *   1. SUGGESTIONS  analysePage(gray, w, h, opts)  looks at one rendered page and proposes
 *        - a straightening angle      (angle,  degrees clockwise, same sign as the editor's slider)
 *        - the edges of the paper     (edges,  fractions of the page)
 *        - the spine of a spread      (spine,  fraction of the page width)
 *      Every answer carries a confidence (0..1). They are only suggestions: the editor shows them
 *      as ordinary guides that can be dragged, typed over or undone.
 *
 *   2. OUTPUT       flattenBackground / otsuThreshold / packBits / describeSample / suggestCompression
 *      are the building blocks of the separate "Compress" step (greyscale or black-and-white output).
 *
 * Images are 8-bit greyscale in a Uint8Array/Uint8ClampedArray (index = y * w + x, y grows downward).
 * All coordinates returned by the suggestion code are fractions (0..1) of the width/height given.
 */
var ScanFixerImage = (function () {
  "use strict";

  const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);

  // ------------------------------------------------------------------ basics
  function toGray(rgba, w, h) {
    const g = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (rgba[j] * 77 + rgba[j + 1] * 151 + rgba[j + 2] * 28) >> 8;
    return g;
  }

  function histogram(g) {
    const hst = new Uint32Array(256);
    for (let i = 0; i < g.length; i++) hst[g[i]]++;
    return hst;
  }
  function percentileOf(hst, total, p) {
    const target = p * total;
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hst[v];
      if (acc >= target) return v;
    }
    return 255;
  }
  /** Otsu's threshold: the grey level that best separates dark ink from light paper. */
  function otsuThreshold(hst, total) {
    let sumAll = 0;
    for (let v = 0; v < 256; v++) sumAll += v * hst[v];
    let wB = 0, sumB = 0, best = -1, thr = 127;
    for (let v = 0; v < 256; v++) {
      wB += hst[v];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += v * hst[v];
      const mB = sumB / wB, mF = (sumAll - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = v; }
    }
    return thr;
  }

  /** Summed-area table: boxSum() then gives the sum of any rectangle in constant time. */
  function integral(g, w, h) {
    const W = w + 1;
    const I = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += g[y * w + x];
        I[(y + 1) * W + x + 1] = I[y * W + x + 1] + row;
      }
    }
    return I;
  }
  const boxSum = (I, w, x0, y0, x1, y1) => {
    const W = w + 1;
    return I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0];
  };

  /** Shrink by averaging (so thin text lines survive), keeping the aspect ratio. */
  function downscale(gray, w, h, maxW) {
    if (w <= maxW) return { gray, w, h };
    const nw = maxW, nh = Math.max(1, Math.round((h * maxW) / w));
    const I = integral(gray, w, h);
    const out = new Uint8Array(nw * nh);
    const fx = w / nw, fy = h / nh;
    for (let y = 0; y < nh; y++) {
      const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.min(h, Math.floor((y + 1) * fy)));
      for (let x = 0; x < nw; x++) {
        const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.min(w, Math.floor((x + 1) * fx)));
        out[y * nw + x] = Math.round(boxSum(I, w, x0, y0, x1, y1) / ((x1 - x0) * (y1 - y0)));
      }
    }
    return { gray: out, w: nw, h: nh };
  }

  /** Shrink an RGBA picture by averaging blocks (alpha is ignored). */
  function downscaleRGBA(rgba, w, h, maxW) {
    if (w <= maxW) return { rgba, w, h };
    const nw = maxW, nh = Math.max(1, Math.round((h * maxW) / w));
    const out = new Uint8ClampedArray(nw * nh * 4);
    const fx = w / nw, fy = h / nh;
    for (let y = 0; y < nh; y++) {
      const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.min(h, Math.floor((y + 1) * fy)));
      for (let x = 0; x < nw; x++) {
        const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.min(w, Math.floor((x + 1) * fx)));
        let r = 0, g = 0, b = 0;
        for (let yy = y0; yy < y1; yy++) {
          for (let xx = x0, i = (yy * w + x0) * 4; xx < x1; xx++, i += 4) { r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; }
        }
        const n = (y1 - y0) * (x1 - x0), o = (y * nw + x) * 4;
        out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n); out[o + 3] = 255;
      }
    }
    return { rgba: out, w: nw, h: nh };
  }

  function movingAverage(arr, win) {
    const n = arr.length, out = new Float64Array(n), pre = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + arr[i];
    const r = Math.max(0, win >> 1);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - r), b = Math.min(n, i + r + 1);
      out[i] = (pre[b] - pre[a]) / (b - a);
    }
    return out;
  }
  const quantile = (arr, q) => {
    const s = Array.from(arr).sort((a, b) => a - b);
    return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0;
  };

  /** 1 where a pixel is clearly darker than its surroundings (text, lines, pictures), else 0. */
  function inkMask(gray, w, h, win, ratio) {
    const I = integral(gray, w, h);
    const mask = new Uint8Array(w * h);
    const r = win >> 1;
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        const mean = boxSum(I, w, x0, y0, x1, y1) / ((x1 - x0) * (y1 - y0));
        const g = gray[y * w + x];
        if (g < mean * ratio && mean - g > 20) mask[y * w + x] = 1;
      }
    }
    return mask;
  }

  /** Turn the image clockwise by `angle` degrees about its centre (bilinear); `fill` shows in the corners. */
  function rotateGray(gray, w, h, angle, fill) {
    const out = new Uint8Array(w * h);
    const a = (angle * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = x - cx, dy = y - cy;
        const sx = dx * c + dy * s + cx; // inverse of: x' = dx cos - dy sin, y' = dx sin + dy cos
        const sy = -dx * s + dy * c + cy;
        if (sx < 0 || sy < 0 || sx > w - 1 || sy > h - 1) { out[y * w + x] = fill; continue; }
        const x0 = Math.floor(sx), y0 = Math.floor(sy);
        const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
        const fx = sx - x0, fy = sy - y0;
        const top = gray[y0 * w + x0] * (1 - fx) + gray[y0 * w + x1] * fx;
        const bot = gray[y1 * w + x0] * (1 - fx) + gray[y1 * w + x1] * fx;
        out[y * w + x] = Math.round(top * (1 - fy) + bot * fy);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ suggestion 1: where the paper is
  /** First and last index (end exclusive) of the run where `frac` is high enough to count as paper. */
  function paperSpan(frac) {
    const n = frac.length;
    const sm = movingAverage(frac, Math.max(1, Math.round(n * 0.006)));
    const ref = quantile(sm, 0.8);
    if (ref < 0.05) return null;
    const thr = 0.5 * ref, k = Math.max(2, Math.round(n * 0.008));
    const solid = (i, dir) => { for (let j = 0; j < k; j++) { const q = i + dir * j; if (q < 0 || q >= n || sm[q] < thr) return false; } return true; };
    let lo = 0;
    while (lo < n && !solid(lo, 1)) lo++;
    let hi = n - 1;
    while (hi >= 0 && !solid(hi, -1)) hi--;
    return hi > lo ? [lo, hi + 1] : null;
  }

  /**
   * The rectangle of light paper in the picture (a dark scanner lid, a table, black scan borders and
   * the like are left outside). Pixel coordinates; x1/y1 are exclusive.
   */
  function findPaperRect(gray, w, h) {
    const hst = histogram(gray);
    const p90 = percentileOf(hst, w * h, 0.9);
    const thr = Math.max(40, 0.55 * p90);
    let x0 = 0, x1 = w, y0 = 0, y1 = h;
    for (let pass = 0; pass < 2; pass++) {
      const cols = new Float64Array(x1 - x0), rows = new Float64Array(y1 - y0);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (gray[y * w + x] > thr) { cols[x - x0]++; rows[y - y0]++; }
        }
      }
      for (let i = 0; i < cols.length; i++) cols[i] /= y1 - y0;
      for (let i = 0; i < rows.length; i++) rows[i] /= x1 - x0;
      const sx = paperSpan(cols), sy = paperSpan(rows);
      if (!sx || !sy) break;
      [x0, x1] = [x0 + sx[0], x0 + sx[1]];
      [y0, y1] = [y0 + sy[0], y0 + sy[1]];
    }
    const total = w * h, inside = (x1 - x0) * (y1 - y0);
    const outsideShare = 1 - inside / total;
    const trivial = x0 <= w * 0.003 && y0 <= h * 0.003 && x1 >= w * 0.997 && y1 >= h * 0.997;
    let contrast = 0, confidence;
    if (trivial) {
      confidence = 0.9; // the picture is all paper: nothing to trim
    } else {
      const I = integral(gray, w, h);
      const sIn = boxSum(I, w, x0, y0, x1, y1), sAll = boxSum(I, w, 0, 0, w, h);
      const meanIn = sIn / inside, meanOut = (sAll - sIn) / Math.max(1, total - inside);
      contrast = (meanIn - meanOut) / Math.max(meanIn, 1);
      confidence = clamp(contrast / 0.35, 0, 1) * (inside >= total * 0.35 ? 1 : 0.5);
    }
    return { x0, y0, x1, y1, trivial, contrast, confidence, outsideShare };
  }

  // ------------------------------------------------------------------ suggestion 2: how crooked it is
  /**
   * Skew by projection profile: turn the ink by candidate angles and pick the one that piles the ink up
   * into the sharpest horizontal text lines. Returns the angle to turn the page CLOCKWISE by to straighten
   * it (the sign the editor's "Straighten" slider uses).
   * @param region {x0,y0,x1,y1} part of the picture to look at; `skipBand` {x0,x1} columns to ignore (a spine)
   */
  function estimateSkew(gray, w, h, region, skipBand) {
    const win = Math.max(9, Math.round(w * 0.012) | 1);
    const mask = inkMask(gray, w, h, win, 0.85);
    const area = (region.x1 - region.x0) * (region.y1 - region.y0);
    let count = 0;
    for (let y = region.y0; y < region.y1; y++) {
      for (let x = region.x0; x < region.x1; x++) {
        if (skipBand && x >= skipBand.x0 && x < skipBand.x1) continue;
        if (mask[y * w + x]) count++;
      }
    }
    if (count < Math.max(300, area * 0.004)) return { angle: 0, confidence: 0, ink: count, reason: "not enough text to measure" };
    const stride = Math.max(1, Math.ceil(count / 150000));
    const px = new Float32Array(Math.ceil(count / stride) + 1), py = new Float32Array(px.length);
    let n = 0, seen = 0;
    const cx = w / 2, cy = h / 2;
    for (let y = region.y0; y < region.y1; y++) {
      for (let x = region.x0; x < region.x1; x++) {
        if (skipBand && x >= skipBand.x0 && x < skipBand.x1) continue;
        if (!mask[y * w + x]) continue;
        if (seen++ % stride) continue;
        px[n] = x - cx; py[n] = y - cy; n++;
      }
    }
    const size = Math.ceil(h + w * 0.5) + 8, offset = size / 2;
    const bins = new Float64Array(size);
    const score = (deg) => {
      const a = (deg * Math.PI) / 180, s = Math.sin(a), c = Math.cos(a);
      bins.fill(0);
      for (let i = 0; i < n; i++) bins[(px[i] * s + py[i] * c + offset) | 0]++;
      let sum = 0;
      for (let i = 0; i < size; i++) sum += bins[i] * bins[i];
      return sum;
    };
    const LIMIT = 10;
    const coarse = [];
    let best = 0, bestScore = -1;
    for (let a = -LIMIT; a <= LIMIT + 1e-9; a += 0.5) {
      const sc = score(a);
      coarse.push(sc);
      if (sc > bestScore) { bestScore = sc; best = a; }
    }
    const baseline = quantile(coarse, 0.5);
    for (const [span, step] of [[0.5, 0.1], [0.1, 0.02]]) {
      const centre = best;
      for (let a = centre - span; a <= centre + span + 1e-9; a += step) {
        const sc = score(a);
        if (sc > bestScore) { bestScore = sc; best = a; }
      }
    }
    const ratio = bestScore / Math.max(baseline, 1);
    let confidence = clamp((ratio - 1.15) / 0.6, 0, 1);
    if (Math.abs(best) > LIMIT - 0.6) confidence *= 0.3; // at the edge of what we search: probably not skew at all
    return { angle: Math.round(best * 100) / 100, confidence, ink: count, ratio };
  }

  // ------------------------------------------------------------------ suggestion 3: where the spine is
  /**
   * Where two facing pages meet, inside the paper rectangle `rect`. Three clues, strongest first:
   *   - a clear strip of background between two separately scanned pages ("gap-bg")
   *   - the dark shadow in the fold of a bound book                         ("shadow")
   *   - the widest ink-free gutter between two blocks of text               ("gap")
   * else the middle ("middle", low confidence). Pixel coordinates.
   */
  function findSpine(gray, w, h, rect) {
    const W = rect.x1 - rect.x0, H = rect.y1 - rect.y0;
    const ya = Math.round(rect.y0 + H * 0.06), yb = Math.round(rect.y1 - H * 0.06);
    const winA = Math.round(rect.x0 + W * 0.25), winB = Math.round(rect.x0 + W * 0.75);
    const rows = Math.max(1, yb - ya);
    const hst = histogram(gray);
    const paperThr = Math.max(40, 0.55 * percentileOf(hst, w * h, 0.9));

    // per-column measurements over the page body
    const mean = new Float64Array(W), paper = new Float64Array(W);
    for (let x = 0; x < W; x++) {
      let s = 0, p = 0;
      for (let y = ya; y < yb; y++) { const g = gray[y * w + rect.x0 + x]; s += g; if (g > paperThr) p++; }
      mean[x] = s / rows; paper[x] = p / rows;
    }
    const smooth = Math.max(3, Math.round(W * 0.012));
    const mc = movingAverage(mean, smooth);
    const a = winA - rect.x0, b = winB - rect.x0;

    const flank = [];
    for (let x = Math.round(W * 0.04); x < Math.round(W * 0.24); x++) flank.push(mc[x]);
    for (let x = Math.round(W * 0.76); x < Math.round(W * 0.96); x++) flank.push(mc[x]);
    const ref = quantile(flank, 0.5);
    const noise = quantile(flank.map((v) => Math.abs(v - ref)), 0.5) * 1.4826;

    // 1. a strip of background between two pages
    let gapBg = null;
    {
      const pc = movingAverage(paper, Math.max(1, Math.round(W * 0.003)));
      const refP = quantile(pc, 0.6);
      let i = a;
      while (i < b) {
        if (pc[i] < refP * 0.25) {
          let j = i;
          while (j < b && pc[j] < refP * 0.25) j++;
          if (j - i >= Math.max(3, W * 0.008) && (!gapBg || j - i > gapBg[1] - gapBg[0])) gapBg = [i, j];
          i = j;
        } else i++;
      }
    }

    // 2. the shadow in the fold
    let shadow = null;
    {
      let minV = Infinity, minX = a;
      for (let x = a; x < b; x++) if (mc[x] < minV) { minV = mc[x]; minX = x; }
      const depth = ref - minV;
      if (depth >= Math.max(0.05 * ref, 3.5 * noise)) {
        let sx0 = minX, sx1 = minX;
        const level = ref - 0.3 * depth;
        while (sx0 > 0 && mc[sx0 - 1] < level) sx0--;
        while (sx1 < W - 1 && mc[sx1 + 1] < level) sx1++;
        let wsum = 0, xsum = 0;
        const reach = Math.round(W * 0.08);
        for (let x = Math.max(a, minX - reach); x <= Math.min(b, minX + reach); x++) {
          const wt = Math.max(0, ref - mc[x] - 0.4 * depth);
          wsum += wt; xsum += wt * x;
        }
        shadow = { x: wsum > 0 ? xsum / wsum : minX, x0: sx0, x1: sx1 + 1, depth: depth / Math.max(ref, 1), strength: depth / Math.max(noise, 0.5) };
      }
    }

    // 3. the ink-free gutter
    let inkGap = null;
    {
      const mask = inkMask(gray, w, h, Math.max(9, Math.round(w * 0.012) | 1), 0.85);
      const ink = new Float64Array(W);
      for (let x = 0; x < W; x++) {
        let s = 0;
        for (let y = ya; y < yb; y++) s += mask[y * w + rect.x0 + x];
        ink[x] = s / rows;
      }
      const ic = movingAverage(ink, Math.max(1, Math.round(W * 0.003)));
      let i = a;
      while (i < b) {
        if (ic[i] <= 0.012) {
          let j = i;
          while (j < b && ic[j] <= 0.012) j++;
          if (j - i >= Math.max(3, W * 0.012) && (!inkGap || j - i > inkGap[1] - inkGap[0])) inkGap = [i, j];
          i = j;
        } else i++;
      }
    }

    const mid = W / 2;
    const out = (x, source, confidence, extra) => ({ x: rect.x0 + x, source, confidence, ...extra });
    if (gapBg) {
      return out((gapBg[0] + gapBg[1]) / 2, "gap-bg", 0.9, { gap: [rect.x0 + gapBg[0], rect.x0 + gapBg[1]] });
    }
    if (shadow) {
      let conf = clamp(0.45 + shadow.depth * 3, 0.45, 0.9);
      let alt = null;
      if (inkGap) {
        const gm = (inkGap[0] + inkGap[1]) / 2;
        if (Math.abs(gm - shadow.x) <= W * 0.03) conf = Math.min(1, conf + 0.12);
        else { conf *= 0.75; alt = rect.x0 + gm; }
      }
      return out(shadow.x, "shadow", conf, { shadow: [rect.x0 + shadow.x0, rect.x0 + shadow.x1], alt });
    }
    if (inkGap) {
      const wide = (inkGap[1] - inkGap[0]) / W;
      return out((inkGap[0] + inkGap[1]) / 2, "gap", clamp(0.45 + wide * 4, 0.45, 0.75), {});
    }
    return out(mid, "middle", 0.2, {});
  }

  // ------------------------------------------------------------------ all three, in the right order
  /**
   * Analyse one page picture.
   * @param opts.spread  look for a spine (default: when the paper area is clearly wider than tall)
   * @returns {{ angle:{value,confidence}, edges:{u0,v0,u1,v1,confidence,trivial}, spine:null|{u,confidence,source,...},
   *             spread:boolean, w:number, h:number }}  all positions as fractions of the picture, measured
   *             AFTER the page has been straightened by angle.value (which is what the editor shows).
   */
  function analysePage(gray, w, h, opts = {}) {
    // 1. rough paper outline, to know where the text is
    let paper = findPaperRect(gray, w, h);
    const insetX = Math.round((paper.x1 - paper.x0) * 0.03), insetY = Math.round((paper.y1 - paper.y0) * 0.03);
    const region = { x0: paper.x0 + insetX, y0: paper.y0 + insetY, x1: paper.x1 - insetX, y1: paper.y1 - insetY };
    const spreadGuess = opts.spread !== undefined ? !!opts.spread : paper.x1 - paper.x0 > (paper.y1 - paper.y0) * 1.05;
    const band = spreadGuess ? { x0: Math.round(region.x0 + (region.x1 - region.x0) * 0.44), x1: Math.round(region.x0 + (region.x1 - region.x0) * 0.56) } : null;

    // 2. skew
    const skew = region.x1 - region.x0 > 20 && region.y1 - region.y0 > 20 ? estimateSkew(gray, w, h, region, band) : { angle: 0, confidence: 0 };
    let g = gray, applied = 0;
    if (skew.confidence >= 0.4 && Math.abs(skew.angle) >= 0.15) {
      const frame = [];
      const f = Math.max(1, Math.round(Math.min(w, h) * 0.01));
      for (let x = 0; x < w; x += 3) for (let k = 0; k < f; k++) { frame.push(gray[k * w + x], gray[(h - 1 - k) * w + x]); }
      for (let y = 0; y < h; y += 3) for (let k = 0; k < f; k++) { frame.push(gray[y * w + k], gray[y * w + w - 1 - k]); }
      g = rotateGray(gray, w, h, skew.angle, quantile(frame, 0.5));
      applied = skew.angle;
      paper = findPaperRect(g, w, h);
    }

    // 3. edges, after straightening; pulled in a hair so no shadow fringe is left
    const padX = Math.max(1, Math.round(w * 0.003)), padY = Math.max(1, Math.round(h * 0.003));
    const rect = paper.trivial
      ? { x0: 0, y0: 0, x1: w, y1: h }
      : { x0: Math.min(paper.x0 + padX, w - 2), y0: Math.min(paper.y0 + padY, h - 2), x1: Math.max(paper.x1 - padX, 2), y1: Math.max(paper.y1 - padY, 2) };
    const edges = { u0: rect.x0 / w, v0: rect.y0 / h, u1: rect.x1 / w, v1: rect.y1 / h, confidence: paper.confidence, trivial: paper.trivial };

    // 4. spine
    const spread = opts.spread !== undefined ? !!opts.spread : paper.x1 - paper.x0 > (paper.y1 - paper.y0) * 1.05;
    let spine = null;
    if (spread && rect.x1 - rect.x0 > 40 && rect.y1 - rect.y0 > 40) {
      const s = findSpine(g, w, h, paper.trivial ? rect : { x0: paper.x0, y0: paper.y0, x1: paper.x1, y1: paper.y1 });
      spine = {
        u: s.x / w, confidence: s.confidence, source: s.source,
        shadow: s.shadow ? [s.shadow[0] / w, s.shadow[1] / w] : null,
        gap: s.gap ? [s.gap[0] / w, s.gap[1] / w] : null,
        alt: s.alt ? s.alt / w : null,
      };
    }
    return {
      angle: { value: skew.angle, confidence: skew.confidence, applied, ink: skew.ink, reason: skew.reason },
      edges, spine, spread, w, h,
    };
  }

  // ------------------------------------------------------------------ output (the Compress step)
  /**
   * Even out the lighting: divide by an estimate of the paper brightness, so the shadow in the fold, a
   * tinted page or a dim corner comes out the same white as the rest. Returns a new image.
   */
  function flattenBackground(gray, w, h) {
    const win = Math.max(15, Math.round(Math.min(w, h) / 12) | 1), r = win >> 1;
    const I1 = integral(gray, w, h);
    const clipped = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        const m = boxSum(I1, w, x0, y0, x1, y1) / ((x1 - x0) * (y1 - y0));
        const v = gray[y * w + x];
        clipped[y * w + x] = v > m ? v : Math.round(m); // ink counts as "about the average", so it hardly dents the estimate
      }
    }
    const I2 = integral(clipped, w, h);
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        const bg = Math.max(30, boxSum(I2, w, x0, y0, x1, y1) / ((x1 - x0) * (y1 - y0)));
        out[y * w + x] = Math.min(255, Math.round((gray[y * w + x] * 255) / (bg * 0.97)));
      }
    }
    return out;
  }

  /** Stretch so the paper is white and the darkest ink black (a mild "levels"). Returns a new image. */
  function stretchLevels(gray) {
    const hst = histogram(gray);
    const lo = percentileOf(hst, gray.length, 0.005), hi = Math.max(lo + 20, percentileOf(hst, gray.length, 0.85));
    const out = new Uint8Array(gray.length);
    const k = 255 / (hi - lo);
    for (let i = 0; i < gray.length; i++) out[i] = clamp(Math.round((gray[i] - lo) * k), 0, 255);
    return out;
  }

  /** Pack to 1 bit per pixel for a PDF /DeviceGray image: 1 = white, 0 = black, rows padded to whole bytes. */
  function packBits(gray, w, h, threshold) {
    const rowBytes = (w + 7) >> 3;
    const out = new Uint8Array(rowBytes * h);
    for (let y = 0; y < h; y++) {
      const base = y * rowBytes;
      for (let x = 0; x < w; x++) if (gray[y * w + x] > threshold) out[base + (x >> 3)] |= 0x80 >> (x & 7);
    }
    return out;
  }

  /** PNG "Up" filter for packed rows (use with /Predictor 15): usually makes scans deflate noticeably smaller. */
  function upFilter(packed, rowBytes, h) {
    const out = new Uint8Array((rowBytes + 1) * h);
    for (let y = 0; y < h; y++) {
      const o = y * (rowBytes + 1), s = y * rowBytes;
      out[o] = 2;
      for (let i = 0; i < rowBytes; i++) out[o + 1 + i] = (packed[s + i] - (y ? packed[s - rowBytes + i] : 0)) & 255;
    }
    return out;
  }

  /**
   * Convert a rendered page (RGBA) as requested.
   * @param opts {mode:"bw"|"gray"|"colour", flatten:boolean, sensitivity:-30..30 (positive = darker/heavier)}
   * @returns {{gray?: Uint8Array, bits?: Uint8Array, rowBytes?: number}}
   */
  function processForOutput(rgba, w, h, opts) {
    if (opts.mode === "colour") return {};
    let g = toGray(rgba, w, h);
    if (opts.flatten !== false) g = flattenBackground(g, w, h);
    g = stretchLevels(g);
    if (opts.mode === "gray") return { gray: g };
    const thr = clamp(otsuThreshold(histogram(g), g.length) + (Number(opts.sensitivity) || 0), 20, 235);
    return { gray: g, bits: packBits(g, w, h, thr), rowBytes: (w + 7) >> 3, threshold: thr };
  }

  // ------------------------------------------------------------------ what kind of page is this? (suggests a compression mode)
  /** Facts about one rendered page (RGBA) that decide between colour, greyscale and black-and-white. */
  function describeSample(rgba, w, h) {
    let chromaSum = 0, chromaN = 0;
    const g = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) {
      const r = rgba[j], gg = rgba[j + 1], b = rgba[j + 2];
      g[i] = (r * 77 + gg * 151 + b * 28) >> 8;
      const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
      if (mx < 235) { chromaSum += mx - mn; chromaN++; } // leave out the (possibly tinted) paper itself
    }
    const gh = histogram(g);
    if (percentileOf(gh, g.length, 0.85) - percentileOf(gh, g.length, 0.01) < 25) return { blank: true, chroma: 0, inkShare: 0, flatMidShare: 0 }; // nothing on it
    const flat = stretchLevels(flattenBackground(g, w, h));
    // Text edges are anti-aliased, so they always contain mid-greys. What marks shading or a photo is a
    // mid-grey that is NOT right next to solid ink: count only those ("flat" mid-tones).
    const darkMask = new Uint8Array(w * h);
    let dark = 0;
    for (let i = 0; i < flat.length; i++) if (flat[i] < 70) { darkMask[i] = 1; dark++; }
    const I = integral(darkMask, w, h), r = 2;
    let mid = 0, flatMid = 0;
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const v = flat[y * w + x];
        if (v < 70 || v >= 205) continue;
        mid++;
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        if (boxSum(I, w, x0, y0, x1, y1) === 0) flatMid++;
      }
    }
    const inked = dark + mid;
    return { chroma: chromaN ? chromaSum / chromaN : 0, inkShare: inked / flat.length, flatMidShare: flatMid / flat.length };
  }

  /**
   * Turn a handful of samples into a recommendation. Always a suggestion: the person can pick anything.
   * @param samples   describeSample() results
   * @param sourceDpi estimated resolution of the scans, or 0 if unknown
   */
  function suggestCompression(samples, sourceDpi) {
    samples = samples.filter((x) => !x.blank);
    const n = Math.max(1, samples.length);
    const chroma = samples.reduce((a, s) => a + s.chroma, 0) / n;
    const flatMid = samples.reduce((a, s) => a + s.flatMidShare, 0) / n;
    let mode, why;
    if (chroma > 28) { mode = "colour"; why = "the pages contain real colour"; }
    else if (flatMid < 0.025) { mode = "bw"; why = "the pages look like plain text on paper"; }
    else { mode = "gray"; why = "the pages have no colour but contain shading or pictures"; }
    const cap = sourceDpi > 0 ? Math.floor(sourceDpi / 50) * 50 : 0;
    let dpi = mode === "bw" ? 300 : mode === "gray" ? 200 : 150;
    if (cap && cap < dpi) dpi = Math.max(100, cap);
    return { mode, dpi, why };
  }

  return {
    toGray, downscale, downscaleRGBA, histogram, percentileOf, otsuThreshold, integral, inkMask, rotateGray,
    findPaperRect, estimateSkew, findSpine, analysePage,
    flattenBackground, stretchLevels, packBits, upFilter, processForOutput, describeSample, suggestCompression,
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ScanFixerImage;
