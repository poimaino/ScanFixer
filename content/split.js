/* Pure PDF logic. No Zotero APIs in here so it can be unit-tested in Node.
 *
 * Everything works by changing each page's visible area (MediaBox and CropBox are kept
 * identical, so every viewer agrees). The page content (scanned images, OCR text) is
 * never re-encoded, so it is lossless and the file barely grows. The page's original
 * full area is remembered in a private key (/ScanFixerOrigBox), so any crop can
 * later be widened again ("revealed") with adjust(), up to that original area.
 *
 *   split()          cut each landscape spread into two pages, with optional gutter
 *                    position and edge trims
 *   adjust()         nudge the visible edges of chosen pages (positive = trim in,
 *                    negative = reveal more)
 *   parsePageSpec()  "3, 5-9, odd" -> [2, 4, 5, ...]  (0-based indexes)
 */
var ScanFixer = (function () {
  // Which unrotated edge each *visual* edge corresponds to, for each page /Rotate value.
  // axis: x or y; end: lo (smaller coordinate) or hi (larger).
  const EDGE = {
    0:   { left: ["x", "lo"], right: ["x", "hi"], top: ["y", "hi"], bottom: ["y", "lo"] },
    90:  { left: ["y", "lo"], right: ["y", "hi"], top: ["x", "lo"], bottom: ["x", "hi"] },
    180: { left: ["x", "hi"], right: ["x", "lo"], top: ["y", "lo"], bottom: ["y", "hi"] },
    270: { left: ["y", "hi"], right: ["y", "lo"], top: ["x", "hi"], bottom: ["x", "lo"] },
  };
  const MIN_SIZE = 20; // points: refuse to crop a page smaller than this

  const ORIG_KEY = "ScanFixerOrigBox";
  const LEGACY_ORIG_KEY = "SpreadSplitterOrigBox"; // written by the plugin's earlier name; still understood
  const rotationOf = (page) => (((page.getRotation().angle % 360) + 360) % 360);

  /** The largest area this page may ever show: its remembered original, else its MediaBox. */
  function limitOf(PDFLib, page) {
    const { PDFName, PDFArray } = PDFLib;
    const arr = page.node.lookupMaybe(PDFName.of(ORIG_KEY), PDFArray) || page.node.lookupMaybe(PDFName.of(LEGACY_ORIG_KEY), PDFArray);
    return arr ? arr.asRectangle() : page.getMediaBox();
  }

  /** Remember the original full area the first time we touch a page (copied by page clones). */
  function rememberOriginal(PDFLib, page) {
    const { PDFName } = PDFLib;
    if (page.node.get(PDFName.of(ORIG_KEY)) || page.node.get(PDFName.of(LEGACY_ORIG_KEY))) return;
    const m = page.getMediaBox();
    page.node.set(PDFName.of(ORIG_KEY), page.node.context.obj([m.x, m.y, m.x + m.width, m.y + m.height]));
  }

  /** Set the visible area; MediaBox and CropBox are kept identical on purpose. */
  function setVisible(page, x, y, w, h) {
    page.setMediaBox(x, y, w, h);
    page.setCropBox(x, y, w, h);
  }

  /**
   * Move the visible edges of a page. Values are percentages of the page's current
   * visual width (left/right) or height (top/bottom). Positive trims inward, negative
   * reveals more (never beyond the MediaBox).
   */
  function moveEdges(PDFLib, page, edges) {
    rememberOriginal(PDFLib, page);
    const crop = page.getCropBox();
    const media = limitOf(PDFLib, page);
    const rot = rotationOf(page);
    const sideways = rot === 90 || rot === 270;
    const visW = sideways ? crop.height : crop.width;
    const visH = sideways ? crop.width : crop.height;

    const v = { x: [crop.x, crop.x + crop.width], y: [crop.y, crop.y + crop.height] }; // [lo, hi]
    for (const side of ["left", "right", "top", "bottom"]) {
      const pct = Number(edges[side]) || 0;
      if (!pct) continue;
      const amount = (pct / 100) * (side === "left" || side === "right" ? visW : visH);
      const [axis, end] = EDGE[rot][side];
      if (end === "lo") v[axis][0] += amount; // moving the low edge up = trimming in
      else v[axis][1] -= amount;
    }
    // never reveal beyond the page's original area
    v.x[0] = Math.max(v.x[0], media.x);
    v.x[1] = Math.min(v.x[1], media.x + media.width);
    v.y[0] = Math.max(v.y[0], media.y);
    v.y[1] = Math.min(v.y[1], media.y + media.height);

    if (v.x[1] - v.x[0] < MIN_SIZE || v.y[1] - v.y[0] < MIN_SIZE) {
      throw new Error("That trim would leave almost nothing of the page");
    }
    setVisible(page, v.x[0], v.y[0], v.x[1] - v.x[0], v.y[1] - v.y[0]);
  }

  function dropExtraBoxes(page, PDFName) {
    for (const k of ["TrimBox", "BleedBox", "ArtBox"]) page.node.delete(PDFName.of(k));
  }

  function asLocalBytes(bytes) {
    // Zotero's IOUtils.read() returns a Uint8Array from a different JS realm, which fails
    // pdf-lib's `instanceof Uint8Array` check ("...but was actually of type NaN").
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  }

  /**
   * Split each landscape page into two.
   * @param {object}     PDFLib
   * @param {Uint8Array} bytes
   * @param {object}     opts
   *   rtl            right-to-left book (right half comes first)
   *   onlyLandscape  leave portrait pages (covers etc.) untouched      [true]
   *   ratio          gutter position as a fraction from the left        [0.5]
   *   trim           { top, bottom, outer, inner } percentages to trim off each new page.
   *                  "outer" is the edge away from the spine, "inner" the edge at the spine.
   */
  async function split(PDFLib, bytes, opts = {}) {
    const { PDFDocument, PDFPage, PDFName } = PDFLib;
    const rtl = !!opts.rtl;
    const onlyLandscape = opts.onlyLandscape !== false;
    const r = typeof opts.ratio === "number" ? opts.ratio : 0.5;
    if (!(r > 0.05 && r < 0.95)) throw new Error("Gutter position must be between 5% and 95%");
    const t = Object.assign({ top: 0, bottom: 0, outer: 0, inner: 0 }, opts.trim || {});

    const doc = await PDFDocument.load(asLocalBytes(bytes), { updateMetadata: false });
    const pagesIn = doc.getPageCount();
    let splitCount = 0;

    // Go backwards so inserting pages doesn't shift indices we haven't visited.
    for (let i = pagesIn - 1; i >= 0; i--) {
      const page = doc.getPage(i);
      page.node.normalize(); // pull inherited MediaBox/Resources/Rotate onto the leaf

      const box = page.getCropBox(); // visible area (defaults to MediaBox)
      const rot = rotationOf(page);
      const sideways = rot === 90 || rot === 270;
      const visW = sideways ? box.height : box.width;
      const visH = sideways ? box.width : box.height;
      if (onlyLandscape && visW <= visH) continue;

      // Two halves in *unrotated* page coordinates. A = visually left, B = visually right.
      const { x, y, width: w, height: h } = box;
      let A, B;
      switch (rot) {
        case 90: // unrotated bottom edge ends up on the visual left
          A = [x, y, w, h * r];
          B = [x, y + h * r, w, h * (1 - r)];
          break;
        case 180: // unrotated right side ends up on the visual left
          A = [x + w * (1 - r), y, w * r, h];
          B = [x, y, w * (1 - r), h];
          break;
        case 270: // unrotated top edge ends up on the visual left
          A = [x, y + h * (1 - r), w, h * r];
          B = [x, y, w, h * (1 - r)];
          break;
        default:
          A = [x, y, w * r, h];
          B = [x + w * r, y, w * (1 - r), h];
      }

      rememberOriginal(PDFLib, page); // so the clone inherits it

      // Duplicate the page object (shallow: shares content streams/images).
      const clone = page.node.clone(doc.context);
      clone.delete(PDFName.of("Annots")); // keep annotations on the first page only
      const clonePage = PDFPage.of(clone, doc.context.register(clone), doc);
      doc.insertPage(i + 1, clonePage);

      // Original page object stays first in the file, the clone second.
      const [firstBox, secondBox] = rtl ? [B, A] : [A, B];
      const firstIsLeft = !rtl;
      for (const [p, b, isLeft] of [[page, firstBox, firstIsLeft], [clonePage, secondBox, !firstIsLeft]]) {
        dropExtraBoxes(p, PDFName);
        setVisible(p, b[0], b[1], b[2], b[3]);
        // outer = edge away from the spine; inner = edge at the spine (visual)
        moveEdges(PDFLib, p, {
          top: t.top, bottom: t.bottom,
          left: isLeft ? t.outer : t.inner,
          right: isLeft ? t.inner : t.outer,
        });
      }
      splitCount++;
    }

    doc.catalog.delete(PDFName.of("PageLabels")); // labels would now point at the wrong pages
    const out = await doc.save();
    return { bytes: out, pagesIn, pagesOut: doc.getPageCount(), split: splitCount };
  }

  /**
   * Nudge the visible edges of selected pages.
   * @param {number[]} pages      0-based page indexes, or
   * @param {string}   pagesText  a page selection such as "3, 5-9, odd" (parsed against the PDF)
   * @param {object}   edges      { left, right, top, bottom } percentages (+ trims in, - reveals)
   */
  async function adjust(PDFLib, bytes, { pages, pagesText, edges }) {
    const doc = await PDFLib.PDFDocument.load(asLocalBytes(bytes), { updateMetadata: false });
    const n = doc.getPageCount();
    const indexes = pagesText !== undefined ? parsePageSpec(pagesText, n) : pages;
    if (!indexes || !indexes.length) throw new Error("No pages selected");
    if (indexes.some((p) => p < 0 || p >= n)) throw new Error(`Page out of range (this PDF has ${n} pages)`);
    if (!["left", "right", "top", "bottom"].some((k) => Number(edges[k]))) {
      throw new Error("Nothing to change: all four edge values are 0");
    }
    for (const idx of indexes) {
      const page = doc.getPage(idx);
      page.node.normalize();
      moveEdges(PDFLib, page, edges);
    }
    return { bytes: await doc.save(), pageCount: n, changed: indexes.length };
  }


  // ------------------------------------------------------------------
  // Visual coordinates (used by the visual editor)
  //
  // "Visual" space is the page as displayed: u runs left->right and v top->bottom, both as
  // fractions (0..1) of the page's *original area* ("limit": /ScanFixerOrigBox, else the
  // MediaBox), after page rotation. These helpers convert to and from unrotated page space.
  // ------------------------------------------------------------------
  function toPage(rot, L, u, v) {
    const { x, y, width: w, height: h } = L;
    switch (rot) {
      case 90: return [x + v * w, y + u * h];
      case 180: return [x + (1 - u) * w, y + v * h];
      case 270: return [x + (1 - v) * w, y + (1 - u) * h];
      default: return [x + u * w, y + (1 - v) * h];
    }
  }
  function toVisual(rot, L, px, py) {
    const { x, y, width: w, height: h } = L;
    switch (rot) {
      case 90: return [(py - y) / h, (px - x) / w];
      case 180: return [1 - (px - x) / w, (py - y) / h];
      case 270: return [1 - (py - y) / h, 1 - (px - x) / w];
      default: return [(px - x) / w, 1 - (py - y) / h];
    }
  }
  function visualRectToBox(rot, L, r) {
    const a = toPage(rot, L, r.u0, r.v0);
    const b = toPage(rot, L, r.u1, r.v1);
    return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(a[0] - b[0]), height: Math.abs(a[1] - b[1]) };
  }
  function boxToVisualRect(rot, L, box) {
    const a = toVisual(rot, L, box.x, box.y);
    const b = toVisual(rot, L, box.x + box.width, box.y + box.height);
    const c = (n) => Math.min(1, Math.max(0, n));
    return { u0: c(Math.min(a[0], b[0])), v0: c(Math.min(a[1], b[1])), u1: c(Math.max(a[0], b[0])), v1: c(Math.max(a[1], b[1])) };
  }


  // ------------------------------------------------------------------
  // Affine matrices [a b c d e f] (PDF convention: x' = a*x + c*y + e, y' = b*x + d*y + f)
  // ------------------------------------------------------------------
  const applyM = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  /** The matrix that does `m1` first and then `m2`. */
  const thenM = (m1, m2) => [
    m1[0] * m2[0] + m1[1] * m2[2], m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2], m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4], m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
  /** Turn by `angle` degrees clockwise (as displayed) about the centre of L. */
  function angleMatrix(L, angle) {
    const phi = (-angle * Math.PI) / 180; // PDF angles run anticlockwise
    const cos = Math.cos(phi), sin = Math.sin(phi);
    const cx = L.x + L.width / 2, cy = L.y + L.height / 2;
    return [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
  }

  /**
   * Wrap a page's content streams in a transformation, so the drawing is moved/scaled/turned
   * without being re-encoded. Later wraps go outside earlier ones, so they compose naturally.
   */
  function wrapContent(PDFLib, doc, page, m) {
    const { PDFName, PDFArray, PDFRef } = PDFLib;
    const ctx = doc.context;
    const n = (v) => Number(v.toFixed(6));
    const key = PDFName.of("Contents");
    const cur = page.node.get(key);
    const asRef = (o) => (o instanceof PDFRef ? o : ctx.register(o));
    let existing = [];
    if (cur instanceof PDFArray) existing = cur.asArray().map(asRef);
    else if (cur) existing = [asRef(cur)];
    const pre = ctx.register(ctx.stream(`q ${m.map(n).join(" ")} cm\n`));
    const post = ctx.register(ctx.stream("\nQ\n"));
    page.node.set(key, ctx.obj([pre, ...existing, post]));
  }

  /**
   * One entry per page, for the visual editor.
   *   vw, vh        visual size (points) of the page's original area
   *   visual        the currently visible area as a visual rect (fractions of that original area)
   *   landscape     is the *visible* area wider than tall
   *   partial       part of the original area is currently hidden (so a preview copy is needed)
   *   fixed         the page has been through ScanFixer before
   */
  async function describePages(PDFLib, bytes) {
    const doc = await PDFLib.PDFDocument.load(asLocalBytes(bytes), { updateMetadata: false });
    return doc.getPages().map((page, index) => {
      page.node.normalize();
      const rot = rotationOf(page);
      const L = limitOf(PDFLib, page);
      const vis = page.getCropBox();
      const sideways = rot === 90 || rot === 270;
      const visual = boxToVisualRect(rot, L, vis);
      return {
        index,
        rotation: rot,
        vw: sideways ? L.height : L.width,
        vh: sideways ? L.width : L.height,
        visual,
        limit: { x: L.x, y: L.y, width: L.width, height: L.height }, // the page's original area, in page units
        landscape: (sideways ? vis.height : vis.width) > (sideways ? vis.width : vis.height),
        partial: visual.u0 > 0.001 || visual.v0 > 0.001 || visual.u1 < 0.999 || visual.v1 < 0.999,
        // this page has been through ScanFixer (or its earlier version) before
        fixed: !!(page.node.get(PDFLib.PDFName.of(ORIG_KEY)) || page.node.get(PDFLib.PDFName.of(LEGACY_ORIG_KEY))),
      };
    });
  }

  /** A copy of the PDF in which every page shows its whole original area (for the editor's preview). */
  async function previewCopy(PDFLib, bytes) {
    const { PDFDocument, PDFName } = PDFLib;
    const doc = await PDFDocument.load(asLocalBytes(bytes), { updateMetadata: false });
    for (const page of doc.getPages()) {
      page.node.normalize();
      const L = limitOf(PDFLib, page);
      dropExtraBoxes(page, PDFName);
      setVisible(page, L.x, L.y, L.width, L.height);
    }
    return doc.save();
  }

  /**
   * Apply a plan made in the visual editor.
   *   plan.pages      { "<0-based index>": { rects: [ {u0,v0,u1,v1}, ... ], rotate?, axis?, angle? } }
   *                   one rect = crop the page; two rects = split it into two pages
   *                   rotate  extra turn in 90 degree steps (0/90/180/270, clockwise as displayed);
   *                           the rects are then fractions of the page *as rotated*
   *                   axis    "v" (default): two rects side by side, "h": stacked top and bottom
   *                   angle   straighten the scan by this many degrees clockwise (small, e.g. -3.5)
   *   plan.rtl        right-to-left book: for side-by-side splits the right-hand rect comes first
   *   plan.normalize  make every page the same size (the median, separately for landscape and
   *                   portrait pages). Pages are scaled to fit and centred, never cropped.
   *
   * Returns { bytes, pagesIn, pagesOut, split, cropped, transformed, pageMap }. pageMap has one
   * entry per output page, in order, saying how its content was moved, so annotations can follow:
   *   { old, box, R, N, rot, final }   see relocateAnnotation()
   */
  async function applyPlan(PDFLib, bytes, plan) {
    const { PDFDocument, PDFPage, PDFName } = PDFLib;
    const doc = await PDFDocument.load(asLocalBytes(bytes), { updateMetadata: false });
    const pagesIn = doc.getPageCount();
    const indexes = Object.keys(plan.pages || {}).map(Number).sort((a, b) => b - a); // backwards
    if (!indexes.length && !plan.normalize) throw new Error("No pages to change");
    let split = 0, cropped = 0, transformed = 0;

    // how each old page looked before we touched anything (for pages we don't change)
    const before = doc.getPages().map((p) => p.getCropBox()); // (reads inherited boxes; touches nothing)
    const outputs = new Map(); // old index -> [{ box, R }] in output order

    for (const i of indexes) {
      if (!(i >= 0 && i < pagesIn)) throw new Error(`Page ${i + 1} is out of range (this PDF has ${pagesIn} pages)`);
      const spec = plan.pages[i];
      const rects = (spec.rects || []).map((r) => ({ u0: +r.u0, v0: +r.v0, u1: +r.u1, v1: +r.v1 }));
      if (rects.length < 1 || rects.length > 2) throw new Error(`Page ${i + 1}: expected one or two areas`);
      for (const r of rects) {
        if (![r.u0, r.v0, r.u1, r.v1].every(Number.isFinite) || r.u1 - r.u0 < 0.01 || r.v1 - r.v0 < 0.01) {
          throw new Error(`Page ${i + 1}: that area is too small or invalid`);
        }
        r.u0 = Math.max(0, r.u0); r.v0 = Math.max(0, r.v0); r.u1 = Math.min(1, r.u1); r.v1 = Math.min(1, r.v1);
      }
      const sortAxis = spec.axis === "h" ? "v0" : "u0";
      rects.sort((a, b) => a[sortAxis] - b[sortAxis]); // left -> right, or top -> bottom

      const page = doc.getPage(i);
      page.node.normalize();
      rememberOriginal(PDFLib, page);
      const L = limitOf(PDFLib, page);

      const extra = (((Number(spec.rotate) || 0) % 360) + 360) % 360;
      if (extra % 90 !== 0) throw new Error(`Page ${i + 1}: rotation must be a multiple of 90 degrees`);
      const angle = Number(spec.angle) || 0;
      if (!(Math.abs(angle) <= 45)) throw new Error(`Page ${i + 1}: straighten angle must be between -45 and 45 degrees`);
      const axis = spec.axis === "h" ? "h" : "v";
      const rot = (rotationOf(page) + extra) % 360;

      const boxes = rects.map((r) => visualRectToBox(rot, L, r));
      if (boxes.some((b) => b.width < MIN_SIZE || b.height < MIN_SIZE)) {
        throw new Error(`Page ${i + 1}: that area would be too small`);
      }
      const R = angle ? angleMatrix(L, angle) : null;
      if (R) wrapContent(PDFLib, doc, page, R); // before cloning, so both halves share it
      if (extra) page.setRotation(PDFLib.degrees(rot));

      if (boxes.length === 1) {
        dropExtraBoxes(page, PDFName);
        setVisible(page, boxes[0].x, boxes[0].y, boxes[0].width, boxes[0].height);
        outputs.set(i, [{ box: boxes[0], R }]);
        cropped++;
      } else {
        const clone = page.node.clone(doc.context);
        clone.delete(PDFName.of("Annots")); // keep embedded annotations on the first page only
        const clonePage = PDFPage.of(clone, doc.context.register(clone), doc);
        doc.insertPage(i + 1, clonePage);
        const swap = plan.rtl && axis === "v";
        const [first, second] = swap ? [boxes[1], boxes[0]] : [boxes[0], boxes[1]];
        for (const [p, b] of [[page, first], [clonePage, second]]) {
          dropExtraBoxes(p, PDFName);
          setVisible(p, b.x, b.y, b.width, b.height);
        }
        outputs.set(i, [{ box: first, R }, { box: second, R }]);
        split++;
      }
      if (angle || extra) transformed++;
    }
    if (split) doc.catalog.delete(PDFName.of("PageLabels")); // labels would now point at the wrong pages

    // the map from old pages to output pages, in output order
    const pageMap = [];
    for (let i = 0; i < pagesIn; i++) {
      const outs = outputs.get(i) || [{ box: before[i], R: null }];
      for (const o of outs) pageMap.push({ old: i, box: o.box, R: o.R, N: null });
    }

    if (plan.normalize) transformed += normalizeSizes(PDFLib, doc, pageMap);

    // final geometry of every output page (what annotations are measured against)
    doc.getPages().forEach((page, k) => {
      pageMap[k].rot = rotationOf(page);
      pageMap[k].final = page.getCropBox();
    });
    return { bytes: await doc.save(), pagesIn, pagesOut: doc.getPageCount(), split, cropped, transformed, pageMap };
  }

  /**
   * Make every page the same size: the median displayed size, separately for landscape and
   * portrait pages. Each page is scaled (uniformly) to fit inside that size and centred, so
   * nothing is cropped; a page that is already the right size is left alone.
   * @returns {number} how many pages were changed
   */
  function normalizeSizes(PDFLib, doc, pageMap) {
    const { PDFName } = PDFLib;
    const info = doc.getPages().map((page) => {
      const box = page.getCropBox();
      const rot = rotationOf(page);
      const sideways = rot === 90 || rot === 270;
      return { page, box, sideways, dw: sideways ? box.height : box.width, dh: sideways ? box.width : box.height };
    });
    const median = (xs) => {
      const a = [...xs].sort((p, q) => p - q);
      const m = Math.floor(a.length / 2);
      return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
    };
    const kind = (p) => (p.dw > p.dh ? "landscape" : "portrait");
    const target = {};
    for (const g of ["landscape", "portrait"]) {
      const group = info.filter((p) => kind(p) === g);
      if (group.length) target[g] = { w: median(group.map((p) => p.dw)), h: median(group.map((p) => p.dh)) };
    }
    let changed = 0;
    info.forEach((p, k) => {
      const t = target[kind(p)];
      const tw = p.sideways ? t.h : t.w, th = p.sideways ? t.w : t.h; // target in unrotated page space
      if (Math.abs(p.box.width - tw) < 0.5 && Math.abs(p.box.height - th) < 0.5) return; // already that size
      const s = Math.min(tw / p.box.width, th / p.box.height);
      const N = [s, 0, 0, s, (tw - s * p.box.width) / 2 - s * p.box.x, (th - s * p.box.height) / 2 - s * p.box.y];
      rememberOriginal(PDFLib, p.page);
      const L = limitOf(PDFLib, p.page);
      wrapContent(PDFLib, doc, p.page, N);
      dropExtraBoxes(p.page, PDFName);
      setVisible(p.page, 0, 0, tw, th);
      // The page's original area, in its new coordinates, so it can still be widened later. It must
      // include the new visible page (which has margins when the content was scaled down to fit).
      const a = applyM(N, L.x, L.y), b = applyM(N, L.x + L.width, L.y + L.height);
      const x0 = Math.min(a[0], b[0], 0), y0 = Math.min(a[1], b[1], 0);
      const x1 = Math.max(a[0], b[0], tw), y1 = Math.max(a[1], b[1], th);
      p.page.node.set(PDFName.of(ORIG_KEY), p.page.node.context.obj([x0, y0, x1, y1]));
      pageMap[k].N = N;
      changed++;
    });
    return changed;
  }

  // ------------------------------------------------------------------
  // Annotations: where does a Zotero annotation go after the pages were changed?
  //
  // Zotero stores positions in PDF user space: rects [[x1,y1,x2,y2],...] (highlights, notes, images),
  // paths [[x1,y1,x2,y2,...],...] (ink). Cropping or splitting doesn't move the content, so such a
  // position only needs the right page number. Straightening and size normalising do move content,
  // so the same transformation is applied to the position.
  // ------------------------------------------------------------------
  function positionPoints(position) {
    const pts = [];
    for (const r of position.rects || []) { pts.push([r[0], r[1]], [r[2], r[3]]); }
    for (const path of position.paths || []) {
      if (path.length && Array.isArray(path[0])) for (const q of path) pts.push([q[0], q[1]]);
      else for (let i = 0; i + 1 < path.length; i += 2) pts.push([path[i], path[i + 1]]);
    }
    return pts;
  }

  /**
   * @param {object[]} pageMap  from applyPlan()
   * @param {object}   position a Zotero annotation position ({ pageIndex, rects?, paths?, width? })
   * @returns {{ pageIndex: number, position: object, outside: boolean, top: number } | null}
   *   outside = the annotation lies outside every kept area of its page (it is still moved, but
   *   it won't be visible); top = its distance from the top of the new page in points (for sorting)
   */
  function relocateAnnotation(pageMap, position) {
    const cands = [];
    pageMap.forEach((m, k) => { if (m.old === position.pageIndex) cands.push({ m, k }); });
    if (!cands.length) return null;
    const pts = positionPoints(position);
    const toR = (m, x, y) => (m.R ? applyM(m.R, x, y) : [x, y]);
    const toFinal = (m, x, y) => { const q = toR(m, x, y); return m.N ? applyM(m.N, q[0], q[1]) : q; };

    let pick = cands[0], outside = false;
    if (pts.length) {
      const cx = pts.reduce((a, q) => a + q[0], 0) / pts.length, cy = pts.reduce((a, q) => a + q[1], 0) / pts.length;
      const dist = (c) => {
        const q = toR(c.m, cx, cy), b = c.m.box;
        const dx = Math.max(b.x - q[0], 0, q[0] - (b.x + b.width)), dy = Math.max(b.y - q[1], 0, q[1] - (b.y + b.height));
        return Math.hypot(dx, dy);
      };
      pick = cands.reduce((best, c) => (dist(c) < dist(best) ? c : best), cands[0]);
      outside = dist(pick) > 1;
    }
    const m = pick.m;
    const pt = (x, y) => toFinal(m, x, y);
    const out = { ...position, pageIndex: pick.k };
    if (position.rects) {
      out.rects = position.rects.map((r) => {
        const a = pt(r[0], r[1]), b = pt(r[2], r[3]);
        return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
      });
    }
    if (position.paths) {
      out.paths = position.paths.map((path) => {
        if (path.length && Array.isArray(path[0])) return path.map((q) => pt(q[0], q[1]));
        const flat = [];
        for (let i = 0; i + 1 < path.length; i += 2) flat.push(...pt(path[i], path[i + 1]));
        return flat;
      });
    }
    if (typeof position.width === "number" && m.N) out.width = position.width * m.N[0];

    // distance from the top of the displayed page, for the sort index
    let top = 0;
    if (m.final && out.rects && out.rects.length) {
      const f = m.final, rot = m.rot || 0;
      const vmin = Math.min(...out.rects.flatMap((r) => [toVisual(rot, f, r[0], r[1])[1], toVisual(rot, f, r[2], r[3])[1]]));
      top = Math.max(0, vmin) * (rot === 90 || rot === 270 ? f.width : f.height);
    }
    return { pageIndex: pick.k, position: out, outside, top };
  }

  /** "00005|001234|00123": page | text offset | distance from the top. Keep the offset, update the rest. */
  function sortIndexFor(oldSortIndex, pageIndex, top) {
    const parts = String(oldSortIndex || "").split("|");
    const offset = parts[1] && /^\d+$/.test(parts[1]) ? parts[1] : "000000";
    return [String(pageIndex).padStart(5, "0"), offset, String(Math.max(0, Math.floor(top))).padStart(5, "0")].join("|");
  }


  /**
   * Where a Zotero annotation sits on a page, as visual rects (fractions of the page's original area),
   * for drawing on the preview. `info` is one entry from describePages().
   */
  function visualRectsOf(info, position) {
    const to = (x, y) => toVisual(info.rotation, info.limit, x, y);
    const box = (pts) => {
      const q = pts.map((p) => to(p[0], p[1]));
      return { u0: Math.min(...q.map((a) => a[0])), v0: Math.min(...q.map((a) => a[1])), u1: Math.max(...q.map((a) => a[0])), v1: Math.max(...q.map((a) => a[1])) };
    };
    const out = [];
    for (const r of position.rects || []) out.push(box([[r[0], r[1]], [r[2], r[3]]]));
    for (const path of position.paths || []) {
      const pts = [];
      if (path.length && Array.isArray(path[0])) for (const q of path) pts.push([q[0], q[1]]);
      else for (let i = 0; i + 1 < path.length; i += 2) pts.push([path[i], path[i + 1]]);
      if (pts.length) out.push(box(pts));
    }
    return out;
  }

  /** The plain options window's answer (spine position, trims…) as a plan. `pages` is from describePages(). */
  function planFromSplitOptions(pages, opts) {
    const r = typeof opts.ratio === "number" ? opts.ratio : 0.5;
    if (!(r > 0.05 && r < 0.95)) throw new Error("Gutter position must be between 5% and 95%");
    const t = Object.assign({ top: 0, bottom: 0, outer: 0, inner: 0 }, opts.trim || {});
    const out = {};
    for (const p of pages) {
      if (opts.onlyLandscape !== false && !p.landscape) continue;
      const v = p.visual, h = v.v1 - v.v0;
      const mid = v.u0 + (v.u1 - v.u0) * r;
      const lw = mid - v.u0, rw = v.u1 - mid;
      const v0 = v.v0 + (h * t.top) / 100, v1 = v.v1 - (h * t.bottom) / 100;
      out[p.index] = { rects: [
        { u0: v.u0 + (lw * t.outer) / 100, v0, u1: mid - (lw * t.inner) / 100, v1 },
        { u0: mid + (rw * t.inner) / 100, v0, u1: v.u1 - (rw * t.outer) / 100, v1 },
      ] };
    }
    return { pages: out, rtl: !!opts.rtl };
  }

  /** The plain adjust window's answer (move each edge by a percentage) as a plan, for the given 0-based pages. */
  function planFromEdges(pages, indexes, edges) {
    const out = {};
    for (const i of indexes) {
      const v = pages[i].visual, w = v.u1 - v.u0, h = v.v1 - v.v0;
      out[i] = { rects: [{
        u0: Math.max(0, v.u0 + (w * (edges.left || 0)) / 100), u1: Math.min(1, v.u1 - (w * (edges.right || 0)) / 100),
        v0: Math.max(0, v.v0 + (h * (edges.top || 0)) / 100), v1: Math.min(1, v.v1 - (h * (edges.bottom || 0)) / 100),
      }] };
    }
    return { pages: out, rtl: false };
  }

  /**
   * Parse a page selection into sorted, unique 0-based indexes.
   * Accepts comma/semicolon separated parts: "7", "3-9", "all", "odd", "even",
   * and ranges with a filter: "10-40 odd".
   */
  function parsePageSpec(text, pageCount) {
    const spec = String(text || "").trim().toLowerCase();
    if (!spec) throw new Error("Enter which pages to adjust, e.g. 3, 5-9, odd, even or all");
    const out = new Set();
    for (const part of spec.split(/[,;]+/).map((s) => s.trim()).filter(Boolean)) {
      const m = part.match(/^(?:(\d+)(?:\s*-\s*(\d+))?|(all))?\s*(odd|even)?$/);
      if (!m || (!m[1] && !m[3] && !m[4])) throw new Error(`Couldn't understand "${part}"`);
      let lo = 1, hi = pageCount;
      if (m[1]) { lo = Number(m[1]); hi = m[2] ? Number(m[2]) : lo; }
      if (lo < 1 || hi < lo) throw new Error(`"${part}" is not a valid page range`);
      if (lo > pageCount) throw new Error(`Page ${lo} is beyond the end (${pageCount} pages)`);
      for (let p = lo; p <= Math.min(hi, pageCount); p++) {
        if (m[4] === "odd" && p % 2 === 0) continue;
        if (m[4] === "even" && p % 2 === 1) continue;
        out.add(p - 1);
      }
    }
    if (!out.size) throw new Error("That selection doesn't match any pages");
    return [...out].sort((a, b) => a - b);
  }

  return {
    split, adjust, parsePageSpec, describePages, previewCopy, applyPlan, relocateAnnotation, sortIndexFor,
    visualRectsOf, planFromSplitOptions, planFromEdges, visualRectToBox, boxToVisualRect,
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ScanFixer;
