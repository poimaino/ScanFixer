// Copyright (c) 2026 poimaino. MIT licence, see LICENSE in the repository root.
/* Visual editor for ScanFixer: a page preview with draggable guides.
 *
 *   ScanFixerEditor.open(parentWindow, config) -> Promise<{ plan, rtl } | null>
 *
 * config:
 *   processed     the file has been through ScanFixer before: pages then start out as "leave as is".
 *                 A fresh file starts with every landscape page set to split down the middle.
 *   title, notes[], warnings[]
 *   annotations   { "<page index>": [{u0,v0,u1,v1}] }  where the PDF's comments sit (drawn on the preview,
 *                 and counted if they would fall outside the kept area)
 *   pages         [{ index, vw, vh, visual:{u0,v0,u1,v1}, landscape, partial }]  from describePages()
 *   pdfBytes      Uint8Array   what to preview (every page showing its whole original area)
 *   getWorkerSource()  async -> string   the render worker script (pdf.js bundle + glue)
 *   parsePages(text, pageCount) -> [0-based indexes]
 *   initialPage   0-based page to show first
 *   selection     optional page-range text to pre-fill "copy to…" with
 *   rtl           initial reading direction
 *
 * result.plan.pages is { "<index>": { rects, rotate?, axis?, angle? } }:
 *   rects   one rect crops a page, two rects split it. Fractions (0..1) of the page's original
 *           area as displayed, i.e. after `rotate`.
 *   plan.normalize  make all pages the same size
 *   rotate  extra turn in degrees (90/180/270, clockwise)
 *   axis    "v" two pages side by side (default) or "h" stacked top/bottom
 *   angle   straighten by this many degrees clockwise
 *
 * Auto-detect: the "Suggest" button (next to three ticks for what to look for) asks the render worker to look at every
 * page picture (ScanFixerImage.analysePage), the one on screen first, and fills in the spine, the paper edges and the
 * tilt. They land in the same spec the person edits by hand, so every guide stays draggable; pages the person has
 * already changed are never touched, and "Reset page" / "Reset all" put pages back.
 *
 * Page images are rendered by pdf.js inside a Web Worker (see render-worker.js); buildEditor()
 * only uses standard DOM/SVG calls so it can be tested in an ordinary browser.
 */
var ScanFixerEditor = (function () {
  const HTML = "http://www.w3.org/1999/xhtml";
  const SVGNS = "http://www.w3.org/2000/svg";
  const MIN = 0.02; // smallest allowed rect side, as a fraction
  const LINK_EPS = 0.004; // edges closer than this count as "the same edge" and move together
  const KEY = { l: "u0", r: "u1", t: "v0", b: "v1" };
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  // `exclude: true` marks a page that is left out of the result; plainRect() drops it
  const cloneRect = (r) => (r.exclude ? { u0: r.u0, v0: r.v0, u1: r.u1, v1: r.v1, exclude: true } : { u0: r.u0, v0: r.v0, u1: r.u1, v1: r.v1 });
  const plainRect = (r) => ({ u0: r.u0, v0: r.v0, u1: r.u1, v1: r.v1 });
  const toPct = (n) => Math.round(n * 1000) / 10;

  // Colours are explicit and opaque: Zotero's plain windows can otherwise be see-through.
  const CSS = `
    :root { color-scheme: light dark; --bg: #ffffff; --fg: #1d1d1f; --panel: #ececef; --line: rgba(0,0,0,.25); --accent: #1b6ef3; }
    @media (prefers-color-scheme: dark) { :root { --bg: #28282b; --fg: #ececec; --panel: #1b1b1d; --line: rgba(255,255,255,.28); } }
    html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); }
    body { font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
    .app { display: grid; grid-template-columns: minmax(0, 1fr) 300px; grid-template-rows: auto minmax(0, 1fr) auto; height: 100%; background: var(--bg); }
    header { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; padding: 7px 12px; border-bottom: 1px solid var(--line); background: var(--bg); }
    .group { display: flex; align-items: center; gap: 6px; }
    button, input, select { font: inherit; }
    button { padding: 3px 11px; }
    button[aria-pressed=true] { background: var(--accent); color: #fff; border-color: var(--accent); }
    .pagemenu { position: relative; }
    #pageNo { min-width: 64px; text-align: left; }
    .pagelist { position: absolute; top: calc(100% + 2px); left: 0; z-index: 30; min-width: 100%; max-height: min(60vh, 340px); overflow: auto; background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; box-shadow: 0 4px 14px rgba(0,0,0,.3); padding: 3px 0; outline: none; }
    .pageopt { padding: 2px 14px 2px 10px; cursor: pointer; white-space: nowrap; }
    .pageopt.on { background: var(--accent); color: #fff; }
    .pageopt.cur { font-weight: 700; }
    .info { opacity: .75; }
    .centre { position: relative; min-width: 0; min-height: 0; display: grid; }
    .centre > * { grid-area: 1 / 1; min-width: 0; min-height: 0; }
    main { position: relative; overflow: auto; min-height: 260px; display: flex; padding: 14px; box-sizing: border-box; background: var(--panel); }
    #stage { position: relative; background: #fff; box-shadow: 0 1px 8px rgba(0,0,0,.35); margin: auto; flex: none; }
    .app.grid .pageonly { display: none !important; }
    .app:not(.grid) .gridonly { display: none !important; }
    header { gap: 8px 22px; }
    .hgroup { display: flex; align-items: center; gap: 6px; }
    .hlabel { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; opacity: .6; margin-right: 2px; }
    aside > * { flex: none; }
    aside h2 { padding-top: 10px; border-top: 1px solid var(--line); }
    aside h2:first-child, aside .titlerow h2 { padding-top: 0; border-top: 0; }
    .hint { margin: 0 0 8px; padding: 6px 9px; border-radius: 6px; background: rgba(27,110,243,.12); font-size: 12px; }
    .rangechip { display: flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 6px; padding: 3px 4px 3px 9px; margin: 0 0 5px; }
    .rangechip .txt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
    .rangechip button { padding: 0 7px; }
    .numform { display: grid; grid-template-columns: auto 1fr; gap: 5px 8px; align-items: center; margin: 4px 0 6px; }
    .numform input[type=number], .numform input.prefix { width: 100%; box-sizing: border-box; }
    #zoomLbl { min-width: 46px; text-align: center; }
    .rule { padding: 5px 7px; }
    .rule input[type=number] { width: 54px; }
    .rule input.prefix { width: 64px; flex: none; min-width: 0; }
    #canvas, #overlay { position: absolute; left: 0; top: 0; width: 100%; height: 100%; }
    #overlay { touch-action: none; user-select: none; overflow: visible; }
    #msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: 16px; color: #333; font-size: 13px; pointer-events: none; }
    aside { border-left: 1px solid var(--line); padding: 10px 12px; overflow: auto; background: var(--bg); display: flex; flex-direction: column; }
    aside h2 { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; opacity: .62; margin: 14px 0 5px; }
    aside h2:first-child { margin-top: 0; }
    .nowrap { white-space: nowrap; }
    .card { border: 1px solid var(--line); border-radius: 8px; padding: 7px 9px; margin: 0 0 8px; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1px 10px; }
    .chips { display: flex; flex-wrap: wrap; gap: 1px 14px; }
    .chips .opt { margin: 0; white-space: nowrap; }
    .row.between { justify-content: space-between; }
    .titlerow { display: flex; align-items: center; justify-content: space-between; margin: 0 0 5px; }
    .titlerow h2 { margin: 0 !important; }
    .titlerow button { padding: 2px 12px; font-weight: 600; }
    .inline { display: flex; flex-wrap: wrap; gap: 2px 16px; }
    .inline .opt { margin: 0; white-space: nowrap; }
    .tip { margin: 0 0 6px; }
    .bottom { margin-top: auto; padding-top: 14px; }
    .bottom .small { margin: 0 0 6px; }
    .btns { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .pair { display: flex; }
    .pair button { border-radius: 0; margin-left: -1px; }
    .pair button:first-child { border-top-left-radius: 6px; border-bottom-left-radius: 6px; margin-left: 0; }
    .pair button:last-child { border-top-right-radius: 6px; border-bottom-right-radius: 6px; }
    .info.page { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; }
    details { margin-top: 12px; }
    .sub { font-weight: 600; margin: 6px 0 3px; }
    details > summary { cursor: pointer; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; opacity: .62; }
    details[open] > summary { margin-bottom: 6px; }
    #detect { opacity: .75; white-space: nowrap; }
    [hidden] { display: none !important; }
    .small { font-size: 12px; opacity: .75; margin: 4px 0; }
    .opt { display: block; margin: 2px 0; }
    .grid2 .opt { margin: 1px 0; white-space: nowrap; }
    input:disabled { opacity: .45; }
    .bad-note { color: #b35a00; font-weight: 600; }
    .row { display: flex; gap: 6px; align-items: center; margin: 4px 0; flex-wrap: wrap; }
    .row input[type=text] { flex: 1; min-width: 80px; padding: 2px 5px; }
    .row input[type=range] { flex: 1; min-width: 90px; }
    #angleNum { width: 60px; text-align: right; }
    footer { grid-column: 1 / -1; display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-top: 1px solid var(--line); background: var(--bg); }
    #summary { flex: 1; }
    #error { color: #d12; font-weight: 600; }
    .warn { background: #fdf0d5; color: #3b2a00; border: 1px solid #f5a623; border-radius: 6px; padding: 5px 8px; margin: 0 0 8px; font-size: 12px; }
    #loading { display: flex; align-items: center; justify-content: center; height: 100%; font-size: 14px; background: var(--bg); color: var(--fg); }
    .edge.h { cursor: ew-resize; } .edge.v { cursor: ns-resize; }
    .corner.nwse { cursor: nwse-resize; } .corner.nesw { cursor: nesw-resize; }
  ` + (typeof ScanFixerThumbs !== "undefined" ? ScanFixerThumbs.CSS : "");

  // ---------------------------------------------------------------- DOM helpers
  function el(doc, tag, attrs, ...kids) {
    const e = doc.createElementNS(HTML, tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "text") e.textContent = v;
      else e.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of kids.flat()) if (c) e.append(c);
    return e;
  }
  function svg(doc, tag, attrs) {
    const e = doc.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, String(v));
    return e;
  }

  // ---------------------------------------------------------------- render worker client
  class RenderClient {
    constructor(win, source) {
      this.win = win;
      this.nextId = 1;
      this.pending = new Map();
      this.url = win.URL.createObjectURL(new win.Blob([source], { type: "text/javascript" }));
      this.worker = new win.Worker(this.url);
      this.worker.onmessage = (e) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        if (e.data.error) p.reject(Object.assign(new Error(e.data.error), { cancelled: !!e.data.cancelled }));
        else p.resolve(e.data);
      };
      this.worker.onerror = (e) => {
        const err = new Error((e && e.message) || "The page renderer failed to start");
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
      };
    }
    request(msg, transfer) {
      const id = this.nextId++;
      const promise = new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.worker.postMessage({ ...msg, id }, transfer || []);
      });
      return { id, promise };
    }
    async open(bytes, timeoutMs = 60000) {
      const copy = new this.win.Uint8Array(bytes.length); // copy into this window's realm
      copy.set(bytes);
      const { promise } = this.request({ cmd: "open", data: copy.buffer }, [copy.buffer]);
      const timeout = new Promise((_, rej) => this.win.setTimeout(() => rej(new Error("Timed out starting the page renderer")), timeoutMs));
      return (await Promise.race([promise, timeout])).pages;
    }
    render(pageNumber, width, rotate) {
      return this.request({ cmd: "render", page: pageNumber, width, rotate: rotate || 0 });
    }
    cancel(id) {
      this.request({ cmd: "cancel", target: id });
    }
    /** Ask the worker to look at a page picture and suggest spine / edges / straightening. */
    analyse(pageNumber, width, rotate, spread) {
      return this.request({ cmd: "analyse", page: pageNumber, width, rotate: rotate || 0, spread });
    }
    /** What kind of pages are these (colour? plain text?) and how finely were they scanned. Used by Compress. */
    sample(pageNumbers, width) {
      return this.request({ cmd: "sample", pages: pageNumbers, width });
    }
    /** Where PDF user-space points land on the page as shown (used to carry comments to a compressed copy). */
    mapPoints(pageNumber, points) {
      return this.request({ cmd: "mapPoints", page: pageNumber, points });
    }
    /** Convert one page for the Compress step (see render-worker.js). */
    compress(pageNumber, options) {
      return this.request({ cmd: "compress", page: pageNumber, ...options });
    }
    terminate() {
      try { this.worker.terminate(); } catch (e) { /* already gone */ }
      try { this.win.URL.revokeObjectURL(this.url); } catch (e) { /* ignore */ }
    }
  }

  async function createClient(win, source, bytes) {
    const client = new RenderClient(win, source);
    try {
      const pages = await client.open(bytes);
      return { client, pages };
    } catch (e) {
      client.terminate();
      throw e;
    }
  }

  // ---------------------------------------------------------------- geometry helpers
  const union = (rects) => ({
    u0: Math.min(...rects.map((r) => r.u0)), v0: Math.min(...rects.map((r) => r.v0)),
    u1: Math.max(...rects.map((r) => r.u1)), v1: Math.max(...rects.map((r) => r.v1)),
    ...(rects.every((r) => r.exclude) ? { exclude: true } : {}),
  });
  /** Two halves of a rect: side by side ("v" = vertical dividing line) or stacked ("h"). */
  function halves(u, axis) {
    if (axis === "h") {
      const mid = (u.v0 + u.v1) / 2;
      return [{ u0: u.u0, v0: u.v0, u1: u.u1, v1: mid }, { u0: u.u0, v0: mid, u1: u.u1, v1: u.v1 }];
    }
    const mid = (u.u0 + u.u1) / 2;
    return [{ u0: u.u0, v0: u.v0, u1: mid, v1: u.v1 }, { u0: mid, v0: u.v0, u1: u.u1, v1: u.v1 }];
  }
  /** The same physical area after turning the page 90 degrees clockwise / anticlockwise. */
  const turnRect = (r, delta) =>
    delta > 0
      ? { u0: 1 - r.v1, v0: r.u0, u1: 1 - r.v0, v1: r.u1 }
      : { u0: r.v0, v0: 1 - r.u1, u1: r.v1, v1: 1 - r.u0 };

  // ---------------------------------------------------------------- the editor
  function buildEditor(doc, win, config, client, finish) {
    const pages = config.pages;
    const N = pages.length;
    const hasFileLabels = pages.some((p) => p.hasLabels); // the PDF has page labels of its own (they are dropped when pages are split, removed or re-ordered)
    const fresh = !config.processed; // a file ScanFixer hasn't touched: landscape pages start as "split"
    const state = {
      cur: clamp(config.initialPage || 0, 0, N - 1),
      cur0: 0, // page on screen when auto-detect started (set below)
      specs: new Map(),
      touched: new Set(), // pages the user has changed
      rtl: !!config.rtl,
      normalize: false, // make all pages the same size
      grid: false,
      bitmap: null,
      suggested: new Map(), // page index -> { prev: spec before the suggestion, wasTouched, lines: [what was detected] }
      batch: null, // { stop, done } while auto-detect runs
      order: Array.from({ length: N }, (_, i) => i), // page indexes in the order they will have in the new file
      zoom: 1, // 1 = fit the window
      view: "page", // "page" | "grid" (thumbnails)
      sugScope: "all", // Suggest runs on "all" pages or on "this" page (page view) / the selected pages (thumbnails)
      labelsOn: false, // write page numbers of my own (state.rules); otherwise the file's numbers are left as they are
      selEdge: null, // the line picked on the page: { ri, edge }; the arrow keys nudge it
      rules: [], // [{ from (1-based, in the finished file), style, start, prefix }]
    };

    // ---- undo / redo: a snapshot of everything the person can change (page settings, order, page-number ranges, size matching,
    //      reading direction). commit() runs after every change; a drag or an auto-detect run counts as one step.
    const hist = { undo: [], redo: [], last: null, key: "", ready: false };
    function snapshot() {
      const specs = [];
      for (const [i, s] of state.specs) {
        const c = cloneSpec(s);
        if (JSON.stringify(c) !== JSON.stringify(cloneSpec(defaultSpec(i)))) specs.push([i, c]); // a page nobody changed isn't part of the state
      }
      specs.sort((a, b) => a[0] - b[0]);
      return {
        specs,
        touched: [...state.touched].sort((a, b) => a - b),
        suggested: [...state.suggested].map(([i, v]) => [i, { prev: cloneSpec(v.prev), wasTouched: v.wasTouched, lines: v.lines }]).sort((a, b) => a[0] - b[0]),
        order: state.order.slice(), rules: state.rules.map((r) => ({ ...r })), normalize: state.normalize, rtl: state.rtl,
      };
    }
    function syncUndo() {
      if (!$.undo) return;
      $.undo.disabled = !hist.undo.length || !!state.batch;
      $.redo.disabled = !hist.redo.length || !!state.batch;
    }
    function commit() {
      if (!hist.ready || drag || state.batch) return;
      const s = snapshot(), key = JSON.stringify(s);
      if (key === hist.key) return;
      hist.undo.push(hist.last);
      if (hist.undo.length > 100) hist.undo.shift();
      hist.redo = [];
      hist.last = s;
      hist.key = key;
      syncUndo();
    }
    function restore(s) {
      state.specs.clear();
      for (const [i, sp] of s.specs) state.specs.set(i, cloneSpec(sp));
      state.touched.clear();
      for (const i of s.touched) state.touched.add(i);
      state.suggested.clear();
      for (const [i, v] of s.suggested) state.suggested.set(i, { prev: cloneSpec(v.prev), wasTouched: v.wasTouched, lines: v.lines });
      state.order = s.order.slice();
      state.rules = s.rules.map((r) => ({ ...r }));
      state.normalize = s.normalize;
      $.normalize.checked = s.normalize;
      state.rtl = s.rtl;
      $.rtl.checked = s.rtl;
      $.ltr.checked = !s.rtl;
      fromEdited = false;
      $.selMsg.textContent = "";
      setPageLabel();
      thumbs.layout();
      renderRules();
      renderPages();
      refresh();
      renderPage(); // the turn of the page on screen may have changed
    }
    function stepHistory(from, to) {
      if (state.batch || !from.length) return;
      to.push(hist.last);
      hist.last = from.pop();
      hist.key = JSON.stringify(hist.last);
      restore(hist.last);
      syncUndo();
    }
    const undo = () => stepHistory(hist.undo, hist.redo);
    const redo = () => stepHistory(hist.redo, hist.undo);

    // ---- specs: { mode: "split" | "single" | "skip", rects, rotate, axis, angle }, created lazily
    const baseSpec = (i) => ({ mode: "skip", rects: [cloneRect(pages[i].visual)], rotate: 0, axis: "v", angle: 0 });
    const defaultSpec = (i) => {
      const p = pages[i];
      const s = baseSpec(i);
      if (fresh && p.landscape) {
        s.mode = "split";
        s.axis = "v";
        s.rects = halves(p.visual, "v");
      }
      return s;
    };
    const spec = (i) => {
      if (!state.specs.has(i)) state.specs.set(i, defaultSpec(i));
      return state.specs.get(i);
    };
    const touch = (i) => state.touched.add(i);
    const pos = () => state.order.indexOf(state.cur); // where the page on screen sits in the new order
    const orderChanged = () => state.order.some((v, k) => v !== k);
    const pageRemoved = (i) => { const s = spec(i); return s.mode !== "skip" && s.rects.length > 0 && s.rects.every((r) => r.exclude); };
    /** Remove (or bring back) the whole of page i: both halves, if it is split. */
    function setPageRemoved(i, flag) {
      const s = spec(i);
      touch(i);
      if (flag && s.mode === "skip") setMode(i, "single"); // taking a page out is a change to it
      for (const r of s.rects) { if (flag) r.exclude = true; else delete r.exclude; }
    }
    /** The pages of the finished file, in order: which source page, and which half of it. */
    function outputPages() {
      const out = [];
      for (const i of state.order) {
        const s = spec(i);
        if (s.mode === "skip") out.push({ src: i, ri: 0 });
        else s.rects.forEach((r, ri) => { if (!r.exclude) out.push({ src: i, ri }); });
      }
      return out;
    }
    const rulesForPlan = () => (state.labelsOn ? state.rules.map((r) => ({ from: Math.max(0, (Math.round(Number(r.from)) || 1) - 1), style: r.style, start: Math.max(1, Math.round(Number(r.start)) || 1), prefix: r.prefix || "" })) : []);
    const labelsNow = () => { const rules = rulesForPlan(); return rules.length ? ScanFixer.pageLabels(rules, outputPages().length) : null; };
    let lblMap = null; // source page -> the page number(s) it will carry, for the thumbnails
    const invalidateLabels = () => { lblMap = null; };
    const getLblMap = () => {
      if (lblMap) return lblMap;
      lblMap = new Map();
      const L = labelsNow();
      if (L) outputPages().forEach((o, k) => lblMap.set(o.src, lblMap.has(o.src) ? lblMap.get(o.src) + " / " + L[k] : L[k]));
      return lblMap;
    };
    const dimsOf = (i, rotate) => (rotate % 180 ? { vw: pages[i].vh, vh: pages[i].vw } : { vw: pages[i].vw, vh: pages[i].vh });
    /** Is the visible area of page i wider than tall once turned by `rotate`? */
    const isLandscape = (i, rotate) => {
      const p = pages[i], v = p.visual;
      let w = (v.u1 - v.u0) * p.vw, h = (v.v1 - v.v0) * p.vh;
      if (rotate % 180) [w, h] = [h, w];
      return w > h;
    };

    function setMode(i, mode) {
      const s = spec(i);
      touch(i);
      if (mode === "split") {
        if (s.rects.length !== 2) {
          // choose the dividing line from the shape on screen: wide pages are two pages side by side,
          // tall pages are two pages one above the other (turn the page first if that isn't right)
          const u = s.rects[0];
          const d = dimsOf(i, s.rotate);
          s.axis = (u.u1 - u.u0) * d.vw >= (u.v1 - u.v0) * d.vh ? "v" : "h";
          s.rects = halves(u, s.axis);
        }
      } else if (mode === "single") {
        if (s.rects.length === 2) s.rects = [union(s.rects)];
      } else {
        Object.assign(s, baseSpec(i)); // "leave as is": back to exactly how the page is now
      }
      s.mode = mode;
    }
    /** The pages the vertical/horizontal toggle acts on: the split pages picked in the thumbnails, or the page on screen. */
    const axisTargets = () => (state.view === "grid" ? thumbs.selected().filter((i) => spec(i).mode === "split") : [state.cur]);
    function reflectAxis(s) {
      const t = state.view === "grid" ? axisTargets().map(spec) : s.mode === "split" ? [s] : [];
      const same = t.length > 0 && t.every((x) => x.axis === t[0].axis);
      for (const p of ["", "t"]) { // the header's toggle and the thumbnail toolbar's
        $[p + "axis-v"].setAttribute("aria-pressed", String(same && t[0].axis === "v"));
        $[p + "axis-h"].setAttribute("aria-pressed", String(same && t[0].axis === "h"));
      }
      $.groupAxis.style.display = $.groupAxisT.style.display = t.length ? "" : "none";
    }
    function setAxis(i, axis) {
      const s = spec(i);
      touch(i);
      s.axis = axis;
      if (s.rects.length === 2) s.rects = halves(union(s.rects), axis);
    }
    function rotatePage(i, delta) {
      const s = spec(i);
      touch(i);
      if (s.mode === "skip") s.mode = "single";
      s.rects = s.rects.map((r) => ({ ...turnRect(r, delta), ...(r.exclude ? { exclude: true } : {}) }));
      s.rotate = (((s.rotate + delta) % 360) + 360) % 360;
      if (s.rects.length === 2) {
        if (delta % 180 !== 0) s.axis = s.axis === "v" ? "h" : "v"; // a side-by-side pair is now stacked, and vice versa
        s.rects.sort((a, b) => (s.axis === "h" ? a.v0 - b.v0 : a.u0 - b.u0));
      }
    }

    // ---- build the DOM
    doc.title = config.title;
    const style = el(doc, "style");
    style.textContent = CSS;
    (doc.head || doc.documentElement).append(style);
    doc.body.replaceChildren();

    state.cur0 = state.cur;
    const $ = {};
    const btn = (key, text, title, id) => ($[key] = el(doc, "button", { type: "button", title, "aria-pressed": "false", id, text }));
    $.prev = el(doc, "button", { type: "button", id: "prev", title: "Previous page (PageUp)", text: "◀" });
    $.next = el(doc, "button", { type: "button", id: "next", title: "Next page (PageDown)", text: "▶" });
    // ◀ ▶ (triangles) go to the previous / next page; this menu jumps to any page. Moving a page in the order uses the ← → buttons under "Pages".
    $.pageNo = el(doc, "button", { type: "button", id: "pageNo", "aria-haspopup": "listbox", "aria-expanded": "false", title: "Go to page" });
    $.pageList = el(doc, "div", { id: "pageList", class: "pagelist", role: "listbox", tabindex: "-1", hidden: true });
    $.pageMenu = el(doc, "div", { class: "pagemenu" }, $.pageNo, $.pageList);
    const setPageLabel = () => { $.pageNo.textContent = `${pos() + 1} ▾`; };
    setPageLabel();
    $.info = el(doc, "span", { class: "info page", id: "pageInfo" });
    $.ltr = el(doc, "input", { type: "radio", name: "dir", id: "dir-ltr" });
    $.rtl = el(doc, "input", { type: "radio", name: "dir", id: "dir-rtl" });
    $.ltr.checked = !state.rtl;
    $.rtl.checked = state.rtl;
    $.rotL = el(doc, "button", { type: "button", id: "rotL", title: "Turn this page 90° anticlockwise", text: "↺" });
    $.rotR = el(doc, "button", { type: "button", id: "rotR", title: "Turn this page 90° clockwise", text: "↻" });
    $.vPage = el(doc, "button", { type: "button", id: "vPage", title: "One page at a time", text: "Page", "aria-pressed": "true" });
    $.vGrid = el(doc, "button", { type: "button", id: "vGrid", title: "Thumbnails of every page: select, remove, re-order, turn", text: "Thumbnails", "aria-pressed": "false" });
    $.zoomOut = el(doc, "button", { type: "button", id: "zoomOut", title: "Zoom out (Ctrl/Cmd −)", text: "−" });
    $.zoomIn = el(doc, "button", { type: "button", id: "zoomIn", title: "Zoom in (Ctrl/Cmd +, or Ctrl/Cmd + scroll)", text: "+" });
    $.zoomLbl = el(doc, "button", { type: "button", id: "zoomLbl", title: "Fit the page to the window (Ctrl/Cmd 0)", text: "Fit" });

    $.groupAxis = el(doc, "div", { class: "pair", id: "groupAxis" },
      btn("axis-v", "│", "Dividing line: vertical (two pages side by side)", "axis-v"), btn("axis-h", "─", "Dividing line: horizontal (two pages one above the other)", "axis-h"));
    // the same toggle for the thumbnail toolbar
    $.groupAxisT = el(doc, "div", { class: "pair", id: "groupAxisT" },
      btn("taxis-v", "│", "Dividing line: vertical (two pages side by side)", "taxis-v"), btn("taxis-h", "─", "Dividing line: horizontal (two pages one above the other)", "taxis-h"));
    const hgroup = (label, cls, ...kids) => el(doc, "div", { class: "hgroup" + (cls ? " " + cls : "") }, label ? el(doc, "span", { class: "hlabel", text: label }) : null, ...kids);
    $.info.classList.add("pageonly");
    let fromEdited = false; // the person typed their own "From page" for the page numbers
    const header = el(doc, "header", {},
      hgroup("View", "", el(doc, "div", { class: "pair" }, $.vPage, $.vGrid)),
      hgroup("Go to", "pageonly", $.prev, $.pageMenu, el(doc, "span", { class: "info", text: `/ ${N}` }), $.next),
      hgroup("Layout", "pageonly",
        el(doc, "div", { class: "pair" },
          btn("mode-split", "Split", "Cut this page into two pages", "mode-split"),
          btn("mode-single", "Single", "Keep one page (a page you haven't changed is a single page too); crop, straighten or turn it as you like. \u201cReset page\u201d puts it back as it was opened.", "mode-single")),
        $.groupAxis),
      hgroup("Turn", "pageonly", el(doc, "div", { class: "pair" }, $.rotL, $.rotR)),
      hgroup("Zoom", "pageonly", el(doc, "div", { class: "pair" }, $.zoomOut, $.zoomLbl, $.zoomIn)),
      el(doc, "div", { class: "hgroup", title: "Which of the two pages is read first" }, el(doc, "span", { class: "hlabel", text: "Reading" }),
        el(doc, "label", {}, $.ltr, " L→R"), el(doc, "label", {}, $.rtl, " R→L")),
      $.info);

    $.canvas = el(doc, "canvas", { id: "canvas" });
    $.overlay = svg(doc, "svg", { id: "overlay", tabindex: "-1" });
    $.msg = el(doc, "div", { id: "msg" });
    $.stage = el(doc, "div", { id: "stage" }, $.canvas, $.overlay, $.msg);
    $.main = el(doc, "main", {}, $.stage);
    $.centre = el(doc, "div", { class: "centre" }, $.main);

    $.angle = el(doc, "input", { type: "range", id: "angle", min: -10, max: 10, step: 0.1, value: 0, "aria-label": "Straighten" });
    $.angleNum = el(doc, "input", { type: "number", id: "angleNum", min: -45, max: 45, step: 0.1, value: 0, "aria-label": "Straighten degrees" });
    $.grid = el(doc, "input", { type: "checkbox", id: "grid" });
    // Radio buttons rather than a drop-down: HTML <select> pop-ups don't work reliably in Zotero's plain windows.
    const copyRadio = (value, text) => {
      const input = el(doc, "input", { type: "radio", name: "copyTarget", id: "copy-" + value, value });
      $["copy-" + value] = input;
      return el(doc, "label", { class: "opt" }, input, " " + text);
    };
    $.copyRange = el(doc, "input", { type: "text", id: "copyRange", placeholder: "e.g. 5-40, 52, odd", value: config.selection || "" });
    $.normalize = el(doc, "input", { type: "checkbox", id: "normalize" });
    $.copyExclusions = el(doc, "input", { type: "checkbox", id: "copyExclusions" });
    // page order: acts on the page on screen, or on the pages picked in the thumbnails
    $.mvEarlier = el(doc, "button", { type: "button", id: "mvEarlier", title: "Move the page (or selected pages) one place earlier", text: "← Move earlier" });
    $.mvLater = el(doc, "button", { type: "button", id: "mvLater", title: "Move the page (or selected pages) one place later", text: "Move later →" });
    $.mvStart = el(doc, "button", { type: "button", id: "mvStart", title: "Move the page (or selected pages) to the beginning", text: "⇤ Move to start" });
    $.mvEnd = el(doc, "button", { type: "button", id: "mvEnd", title: "Move the page (or selected pages) to the end", text: "Move to end ⇥" });
    $.mvPos = el(doc, "input", { type: "number", id: "mvPos", min: 1, max: N, step: 1, title: "Move this page to this place in the new order", "aria-label": "Move to place" });
    // thumbnails: remove the left / right half of the selected spreads
    $.rmL = el(doc, "button", { type: "button", id: "rmL", text: "Remove left", title: "Remove the left-hand (or top) page of a split page; for the selected pages in Thumbnails" });
    $.rmR = el(doc, "button", { type: "button", id: "rmR", text: "Remove right", title: "Remove the right-hand (or bottom) page of each selected split page" });
    $.rmNote = el(doc, "div", { class: "small", id: "rmNote" });
    $.rmWhole = el(doc, "button", { type: "button", id: "tbRemove", text: "Remove whole page", title: "Take the whole page (both halves) out of the new file (Delete)" });
    $.rmRestore = el(doc, "button", { type: "button", id: "tbRestore", text: "Restore", title: "Bring back everything removed from the page" });
    $.gridHint = el(doc, "div", { class: "hint gridonly", id: "gridHint" });
    // page numbers: one form (style, start, prefix, where) and the list of ranges it has made
    $.rules = el(doc, "div", { id: "rules" });
    $.rulesHead = el(doc, "div", { class: "small", text: "Ranges set so far" });
    $.lblWarn = el(doc, "div", { class: "warn", id: "lblWarn", hidden: true });
    $.clearRules = el(doc, "button", { type: "button", id: "clearRules", text: "Clear all (leave numbers as they are)" });
    $.lblPreview = el(doc, "div", { class: "small", id: "lblPreview" });
    $.selStyle = el(doc, "button", { type: "button", id: "selStyle", title: "Click to change the numbering style" });
    $.selFrom = el(doc, "input", { type: "number", id: "selFrom", min: 1, step: 1, value: 1, "aria-label": "From page" });
    $.selFromRow = el(doc, "label", { class: "row", style: "display:contents" }, el(doc, "span", { text: "From page" }), $.selFrom);
    $.selStart = el(doc, "input", { type: "number", id: "selStart", min: 1, step: 1, value: 1, "aria-label": "Start at" });
    $.selPrefix = el(doc, "input", { type: "text", id: "selPrefix", class: "prefix", placeholder: "none", "aria-label": "Prefix" });
    $.selApply = el(doc, "button", { type: "button", id: "selApply", text: "Set page numbers" });
    $.selMsg = el(doc, "div", { class: "small", id: "selMsg" });
    $.copyBtn = el(doc, "button", { type: "button", id: "copyBtn", text: "Copy" });
    $.copyMsg = el(doc, "div", { class: "small", id: "copyMsg" });
    $.reset = el(doc, "button", { type: "button", id: "reset", text: "Reset page", title: "Back to the default layout for this page" });
    $.undo = el(doc, "button", { type: "button", id: "undo", text: "↶ Undo", title: "Undo the last change (Ctrl/Cmd Z)", disabled: true });
    $.redo = el(doc, "button", { type: "button", id: "redo", text: "Redo ↷", title: "Redo (Ctrl/Cmd Shift Z)", disabled: true });
    $.resetAll = el(doc, "button", { type: "button", id: "resetAll", text: "Reset all", title: "Back to the start: default layout, original page order, no page numbers of your own, no size matching" });
    const sugCheck = (key, text, checked) => {
      $[key] = el(doc, "input", { type: "checkbox", id: key });
      $[key].checked = checked;
      return el(doc, "label", { class: "opt" }, $[key], " " + text);
    };
    $.detect = el(doc, "span", { id: "detect" });
    $.sugRun = el(doc, "button", { type: "button", id: "sugRun", text: "Suggest", title: "Look at every page and set the spine, paper edges and tilt (pages you have edited are skipped). Press again to stop." });

    $.sugAll = btn("sugAll", "All pages", "Look at every page (pages you have already edited are skipped)", "sugAll");
    $.sugThis = btn("sugThis", "This page", "Look only at the page on screen", "sugThis");
    const warnings = (config.warnings || []).map((w) => el(doc, "div", { class: "warn", text: w }));
    // created even when the section isn't shown (a file that was already fixed), so the code below can rely on them
    const sugChecks = [sugCheck("sugSpine", "Spine", !config.processed), sugCheck("sugEdges", "Edges", true), sugCheck("sugAngle", "Tilt", true), sugCheck("sugShadow", "Trim shadow", false)];
    const aside = el(doc, "aside", {},
      el(doc, "p", { class: "small tip pageonly", text: "Drag lines or corners · Alt/Option moves one edge · click a line, then arrow keys nudge it (Shift = 10 px)" }),
      $.gridHint,
      warnings,
      el(doc, "div", {},
        el(doc, "div", { class: "titlerow" }, el(doc, "h2", { text: "Auto-detect" }), $.sugRun),
        el(doc, "div", { class: "row" }, el(doc, "span", { class: "info", text: "Run on" }), el(doc, "div", { class: "pair" }, $.sugAll, $.sugThis)),
        el(doc, "div", { class: "chips" }, ...sugChecks),
        config.processed ? el(doc, "div", { class: "small", text: "Already fixed: Spine is off, since the pages are split. Edges and Tilt look at what is visible now." }) : null),
      el(doc, "div", { class: "pageonly" },
        el(doc, "h2", { text: "Straighten" }),
        el(doc, "div", { class: "row" }, $.angle, $.angleNum, " °"),
        el(doc, "label", { class: "opt" }, $.grid, " Grid")),
      el(doc, "h2", { text: "Pages" }),
      el(doc, "div", { class: "small sub", text: "Remove" }),
      el(doc, "div", { class: "btns" }, $.rmL, $.rmR),
      el(doc, "div", { class: "btns", style: "margin-top:6px" }, $.rmWhole, $.rmRestore),
      $.rmNote,
      el(doc, "div", { class: "small sub", text: "Order (move pages)" }),
      el(doc, "div", { class: "btns" }, $.mvEarlier, $.mvLater, $.mvStart, $.mvEnd),
      el(doc, "div", { class: "row pageonly" }, el(doc, "label", {}, "Move to place ", $.mvPos)),
      $.lblWarn,
      ($.detNumbers = el(doc, "details", { id: "detNumbers" },
        el(doc, "summary", { text: "Page numbers", title: "The numbers a PDF reader shows (i, ii, iii, then 1, 2, 3…). Until you set some, the file's own numbers are kept; splitting, removing or re-ordering pages drops them." }),
        el(doc, "div", { class: "card" },
          el(doc, "div", { class: "numform" },
            el(doc, "span", { text: "Style" }), $.selStyle,
            el(doc, "span", { text: "Start at" }), $.selStart,
            el(doc, "span", { text: "Prefix" }), $.selPrefix,
            $.selFromRow),
          el(doc, "div", { class: "row" }, $.selApply), $.selMsg),
        $.rulesHead, $.rules,
        el(doc, "div", { class: "row" }, $.clearRules), $.lblPreview)),
      el(doc, "h2", { text: "Normalise page size" }),
      el(doc, "label", { class: "opt", title: "Pages are scaled slightly to match, never cropped. Landscape and portrait pages are matched separately." }, $.normalize, " Make all pages the same size"),
      ($.detCopy = el(doc, "details", { id: "detCopy", class: "pageonly", open: config.selection ? true : undefined },
        el(doc, "summary", { text: "Copy layout" }),
        el(doc, "div", { class: "card" },
          el(doc, "b", { text: "Copy this layout to", title: "Copies the split / crop areas, the turn and the tilt of this page to the pages you choose" }),
          el(doc, "div", { class: "small", text: "Copies the areas, turn and tilt of this page." }),
          el(doc, "div", { class: "grid2" }, copyRadio("all", "All"), copyRadio("landscape", "Landscape"), copyRadio("portrait", "Portrait"), copyRadio("some", "Only:")),
          el(doc, "div", { class: "row" }, $.copyRange, $.copyBtn),
          el(doc, "label", { class: "opt", title: "Also remove the target pages when this page is removed" }, $.copyExclusions, " Apply to removed pages"), $.copyMsg))),
      el(doc, "div", { class: "bottom" },
        ...(config.notes || []).map((n) => el(doc, "p", { class: "small", text: n })),
        el(doc, "div", { class: "btns" }, $.reset, $.resetAll)));
    $["copy-some"].checked = true; // not "All": copying to every page by a stray click is too easy to do and can't be undone here

    $.summary = el(doc, "div", { id: "summary" });
    $.error = el(doc, "span", { id: "error", role: "alert" });
    $.cancel = el(doc, "button", { type: "button", id: "cancel", text: "Cancel" });
    $.ok = el(doc, "button", { type: "button", id: "ok", text: "Apply" });
    const footer = el(doc, "footer", {}, $.summary, $.detect, $.error, $.undo, $.redo, $.cancel, $.ok);

    $.app = el(doc, "div", { class: "app" }, header, $.centre, aside, footer);
    doc.body.append($.app);

    // ---- state -> UI
    const view = { w: 0, h: 0 };
    const dpr = () => win.devicePixelRatio || 1;

    function reflectMode() {
      const s = spec(state.cur);
      $["mode-split"].setAttribute("aria-pressed", String(s.mode === "split"));
      $["mode-single"].setAttribute("aria-pressed", String(s.mode !== "split")); // an untouched page is a single page too
      reflectAxis(s);
      const angle = Number(s.angle) || 0;
      $.angle.value = angle;
      if (doc.activeElement !== $.angleNum) $.angleNum.value = angle;
      const notes = [pages[state.cur].landscape ? "landscape" : "portrait"];
      notes.push(s.mode === "split" ? "split" : s.mode === "single" ? "crop" : "unchanged");
      if (s.rotate) notes.push(`turned ${s.rotate}°`);
      if (angle) notes.push(`tilt ${angle}°`);
      if (s.mode !== "skip") {
        const gone = s.rects.filter((r) => r.exclude).length;
        if (gone) notes.push(gone === s.rects.length ? "removed" : "one half removed");
      }
      if (pos() !== state.cur) notes.push(`was page ${state.cur + 1}`);
      $.info.textContent = notes.join(" · ");
      $.info.title = $.info.textContent;
      syncRemove();
      syncSuggest();
      if (doc.activeElement !== $.mvPos) $.mvPos.value = pos() + 1;
      if (!fromEdited && doc.activeElement !== $.selFrom) $.selFrom.value = pos() + 1;
      syncOrderButtons();
      syncNumberForm();
    }

    function summarise() {
      let splits = 0, crops = 0, turned = 0, excluded = 0, kept = 0;
      for (let i = 0; i < N; i++) {
        const s = spec(i);
        if (s.mode === "split") splits++;
        else if (s.mode === "single") crops++;
        if (s.mode !== "skip" && (s.rotate || s.angle)) turned++;
        if (s.mode === "skip") kept++;
        else for (const r of s.rects) { if (r.exclude) excluded++; else kept++; }
      }
      const why = [splits && "split", excluded && "removed", orderChanged() && "re-ordered"].filter(Boolean);
      const dropLabels = hasFileLabels && why.length > 0 && !rulesForPlan().length;
      $.lblWarn.hidden = !dropLabels;
      if (dropLabels) $.lblWarn.textContent = `This file has its own page numbers (for example i, ii, iii before 1, 2, 3). They will be removed, because pages are ${why.join(" and ")}. Open “Page numbers” below to write new ones.`;
      const parts = [];
      if (splits) parts.push(`${splits} page${splits > 1 ? "s" : ""} will be split in two`);
      if (crops) parts.push(`${crops} cropped`);
      if (turned) parts.push(`${turned} turned or straightened`);
      if (excluded) parts.push(`${excluded} page${excluded > 1 ? "s" : ""} removed`);
      if (orderChanged()) parts.push("pages re-ordered");
      if (rulesForPlan().length) parts.push("page numbers set");
      if (state.normalize) parts.push("page sizes will be matched");
      const f = fates();
      if (f.outside) parts.push(`${f.outside} comment${f.outside > 1 ? "s" : ""} would end up outside the kept area`);
      if (f.trash) parts.push(`${f.trash} comment${f.trash > 1 ? "s" : ""} on removed pages will go to the Trash`);
      if (state.rules.length) $.detNumbers.open = true; // a section that holds a setting is never left shut
      commit();
      $.summary.className = f.outside || f.trash ? "bad-note" : "";
      $.summary.textContent = parts.length ? parts.join(" · ") : "No changes yet";
      return { splits, crops, turned, excluded, kept };
    }

    /** Remove / restore pages: the same buttons in both views. They act on the pages picked in the thumbnails, or on the page on screen. */
    function removeTargets() { return state.view === "grid" ? thumbs.selected() : [state.cur]; }
    /** Targets that are split in two: the only ones with a left / right (or top / bottom) half to remove. */
    function splitTargets() { return removeTargets().filter((i) => { const s = spec(i); return s.mode === "split" && s.rects.length === 2; }); }
    function toggleHalf(ri) {
      const t = splitTargets();
      if (!t.length) return;
      const allGone = t.every((i) => spec(i).rects[ri].exclude);
      for (const i of t) { touch(i); const r = spec(i).rects[ri]; if (allGone) delete r.exclude; else r.exclude = true; }
      refresh();
    }
    function syncRemove() {
      const all = removeTargets(), sp = splitTargets();
      const axes = new Set(sp.map((i) => spec(i).axis));
      const names = axes.size === 1 ? (axes.has("h") ? ["top", "bottom"] : ["left", "right"]) : ["left/top", "right/bottom"];
      [$.rmL, $.rmR].forEach((b, ri) => {
        const gone = sp.length > 0 && sp.every((i) => spec(i).rects[ri].exclude);
        b.textContent = (gone ? "Restore " : "Remove ") + names[ri];
        b.setAttribute("aria-pressed", String(gone));
        b.disabled = !sp.length;
      });
      $.rmWhole.disabled = !all.length || all.every(pageRemoved);
      $.rmRestore.disabled = !all.some((i) => { const s = spec(i); return s.mode !== "skip" && s.rects.some((r) => r.exclude); });
      const what = state.view === "grid" ? "None of the selected pages is split" : "This page isn't split";
      $.rmNote.textContent = !all.length ? "" : !sp.length ? `${what}, so it has no left or right half to remove. Use Split first.`
        : sp.length < all.length ? `${sp.length} of the ${all.length} selected pages are split; the left/right buttons apply to those.` : "";
    }
    const renderPages = syncRemove, syncPages = syncRemove; // older call sites: "the remove controls need redrawing"

    // ---- annotations (Zotero comments): where they sit on the page, and whether the kept area still covers them
    const annOf = (i) => (config.annotations && config.annotations[i]) || [];
    function turnedAnnotations(i, s) {
      let rs = annOf(i).map(cloneRect);
      const steps = ((Math.round(s.rotate / 90) % 4) + 4) % 4;
      for (let k = 0; k < steps; k++) rs = rs.map((r) => turnRect(r, 90));
      return rs;
    }
    /** Centre of an annotation (visual fractions) after the page was turned and straightened. */
    function annCentre(i, s, r) {
      const d = dimsOf(i, s.rotate);
      const th = ((Number(s.angle) || 0) * Math.PI) / 180;
      const dx = ((r.u0 + r.u1) / 2 - 0.5) * d.vw, dy = ((r.v0 + r.v1) / 2 - 0.5) * d.vh;
      return [0.5 + (dx * Math.cos(th) - dy * Math.sin(th)) / d.vw, 0.5 + (dx * Math.sin(th) + dy * Math.cos(th)) / d.vh];
    }
    const within = (k, c) => c[0] >= k.u0 - 0.002 && c[0] <= k.u1 + 0.002 && c[1] >= k.v0 - 0.002 && c[1] <= k.v1 + 0.002;
    /** "ok" | "outside" (cut off by the crop) | "trash" (on a page you excluded) */
    function fateOf(i, s, r) {
      if (s.mode === "skip") return "ok";
      const hit = s.rects.find((k) => within(k, annCentre(i, s, r)));
      if (!hit) return "outside";
      return hit.exclude ? "trash" : "ok";
    }
    function fates() {
      let outside = 0, trash = 0;
      for (const key of Object.keys(config.annotations || {})) {
        const i = Number(key);
        const s = spec(i);
        if (s.mode === "skip") continue;
        for (const r of turnedAnnotations(i, s)) {
          const f = fateOf(i, s, r);
          if (f === "outside") outside++;
          else if (f === "trash") trash++;
        }
      }
      return { outside, trash };
    }
    const countOutside = () => fates().outside;
    const countTrash = () => fates().trash;

    function drawOverlay() {
      const { w: W, h: H } = view;
      $.overlay.replaceChildren();
      if (!W || !H) return;
      $.overlay.setAttribute("viewBox", `0 0 ${W} ${H}`);
      const s = spec(state.cur);
      const px = (r) => ({ x0: r.u0 * W, y0: r.v0 * H, x1: r.u1 * W, y1: r.v1 * H });

      if (state.grid) {
        for (let k = 1; k < 10; k++) {
          const x = (W * k) / 10, y = (H * k) / 10;
          $.overlay.append(svg(doc, "line", { x1: x, y1: 0, x2: x, y2: H, stroke: "rgba(0,110,255,.4)", "stroke-width": 1, "pointer-events": "none" }));
          $.overlay.append(svg(doc, "line", { x1: 0, y1: y, x2: W, y2: y, stroke: "rgba(0,110,255,.4)", "stroke-width": 1, "pointer-events": "none" }));
        }
      }

      // dim everything outside the kept areas
      let d = `M0 0H${W}V${H}H0Z`;
      for (const r of s.rects) if (!r.exclude) { const q = px(r); d += `M${q.x0} ${q.y0}H${q.x1}V${q.y1}H${q.x0}Z`; }
      $.overlay.append(svg(doc, "path", { d, "fill-rule": "evenodd", fill: "rgba(0,0,0,0.5)", "pointer-events": "none" }));

      // comments on this page, turned and straightened exactly like the page will be
      const anns = turnedAnnotations(state.cur, s);
      if (anns.length) {
        const angle = Number(s.angle) || 0;
        const g = svg(doc, "g", { "pointer-events": "none", "data-annotations": anns.length });
        if (angle) g.setAttribute("transform", `rotate(${angle} ${W / 2} ${H / 2})`);
        for (const r of anns) {
          const fate = fateOf(state.cur, s, r);
          const q = px(r);
          g.append(svg(doc, "rect", {
            x: q.x0, y: q.y0, width: Math.max(2, q.x1 - q.x0), height: Math.max(2, q.y1 - q.y0),
            fill: fate === "trash" ? "rgba(70,70,70,.40)" : fate === "outside" ? "rgba(220,40,40,.30)" : "rgba(255,190,0,.32)",
            stroke: fate === "trash" ? "#444" : fate === "outside" ? "#d12" : "#e69500", "stroke-width": 1.2,
          }));
        }
        $.overlay.append(g);
      }

      // the dividing line, when the two pages share an edge
      if (s.rects.length === 2) {
        const [a, b] = s.rects;
        if (s.axis === "v" && Math.abs(a.u1 - b.u0) < LINK_EPS) {
          const x = a.u1 * W;
          $.overlay.append(svg(doc, "line", { x1: x, y1: 0, x2: x, y2: H, stroke: "#fff", "stroke-width": 1, "stroke-dasharray": "5 4", opacity: 0.9, "pointer-events": "none" }));
        } else if (s.axis === "h" && Math.abs(a.v1 - b.v0) < LINK_EPS) {
          const y = a.v1 * H;
          $.overlay.append(svg(doc, "line", { x1: 0, y1: y, x2: W, y2: y, stroke: "#fff", "stroke-width": 1, "stroke-dasharray": "5 4", opacity: 0.9, "pointer-events": "none" }));
        }
      }

      s.rects.forEach((r, ri) => {
        const q = px(r);
        $.overlay.append(svg(doc, "rect", { x: q.x0, y: q.y0, width: q.x1 - q.x0, height: q.y1 - q.y0, fill: "none", stroke: "#fff", "stroke-width": 3.5, "pointer-events": "none" }));
        $.overlay.append(svg(doc, "rect", { x: q.x0, y: q.y0, width: q.x1 - q.x0, height: q.y1 - q.y0, fill: "none", stroke: r.exclude ? "#d12" : "#1b6ef3", "stroke-width": 1.75, "stroke-dasharray": r.exclude ? "6 4" : "", "pointer-events": "none" }));
        if (r.exclude) {
          $.overlay.append(svg(doc, "rect", { x: q.x0, y: q.y0, width: q.x1 - q.x0, height: q.y1 - q.y0, fill: "rgba(220,40,40,.22)", "data-excluded": ri, "pointer-events": "none" }));
          for (const [x1, y1, x2, y2] of [[q.x0, q.y0, q.x1, q.y1], [q.x1, q.y0, q.x0, q.y1]]) {
            $.overlay.append(svg(doc, "line", { x1, y1, x2, y2, stroke: "#d12", "stroke-width": 2, opacity: 0.75, "pointer-events": "none" }));
          }
          const cx = (q.x0 + q.x1) / 2, cy = (q.y0 + q.y1) / 2;
          $.overlay.append(svg(doc, "rect", { x: cx - 44, y: cy - 13, width: 88, height: 26, rx: 13, fill: "#d12", "pointer-events": "none" }));
          const label = svg(doc, "text", { x: cx, y: cy + 5, "text-anchor": "middle", fill: "#fff", "font-size": 13, "font-weight": 700, "pointer-events": "none" });
          label.textContent = "Removed";
          $.overlay.append(label);
        }
        if (s.rects.length === 2) {
          const order = (s.axis === "v" && state.rtl ? 1 - ri : ri) + 1; // reading order of this page
          $.overlay.append(svg(doc, "circle", { cx: q.x0 + 16, cy: q.y0 + 16, r: 11, fill: "#1b6ef3", stroke: "#fff", "stroke-width": 1.5, "pointer-events": "none" }));
          const t = svg(doc, "text", { x: q.x0 + 16, y: q.y0 + 20.5, "text-anchor": "middle", fill: "#fff", "font-size": 13, "font-weight": 700, "pointer-events": "none" });
          t.textContent = String(order);
          $.overlay.append(t);
        }
        const edge = (name, x1, y1, x2, y2, cls) =>
          $.overlay.append(svg(doc, "line", { x1, y1, x2, y2, stroke: "transparent", "stroke-width": 14, "stroke-linecap": "butt", class: "edge " + cls, "data-ri": ri, "data-edge": name }));
        edge("l", q.x0, q.y0, q.x0, q.y1, "h");
        edge("r", q.x1, q.y0, q.x1, q.y1, "h");
        edge("t", q.x0, q.y0, q.x1, q.y0, "v");
        edge("b", q.x0, q.y1, q.x1, q.y1, "v");
        if (state.selEdge && state.selEdge.ri === ri) {
          const en = state.selEdge.edge;
          const hl = { stroke: "#ff9500", "stroke-width": 3, "pointer-events": "none", "data-selected": en };
          if (en.length === 1) {
            const [x1, y1, x2, y2] = en === "l" ? [q.x0, q.y0, q.x0, q.y1] : en === "r" ? [q.x1, q.y0, q.x1, q.y1] : en === "t" ? [q.x0, q.y0, q.x1, q.y0] : [q.x0, q.y1, q.x1, q.y1];
            $.overlay.append(svg(doc, "line", { x1, y1, x2, y2, ...hl }));
          } else {
            const cx = en[0] === "l" ? q.x0 : q.x1, cy = en[1] === "t" ? q.y0 : q.y1;
            $.overlay.append(svg(doc, "rect", { x: cx - 7, y: cy - 7, width: 14, height: 14, fill: "none", ...hl }));
          }
        }
        for (const [name, x, y, cur] of [["lt", q.x0, q.y0, "nwse"], ["rt", q.x1, q.y0, "nesw"], ["lb", q.x0, q.y1, "nesw"], ["rb", q.x1, q.y1, "nwse"]]) {
          $.overlay.append(svg(doc, "rect", { x: x - 5, y: y - 5, width: 10, height: 10, fill: "#fff", stroke: "#1b6ef3", "stroke-width": 1.5, class: "corner " + cur, "data-ri": ri, "data-edge": name }));
        }
      });
    }

    /** Draw the rendered page, turned by the straighten angle (the preview is exact: same centre, same direction). */
    function paint() {
      const bmp = state.bitmap;
      if (!bmp) return;
      const c = $.canvas;
      if (c.width !== bmp.width || c.height !== bmp.height) { c.width = bmp.width; c.height = bmp.height; }
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      const angle = Number(spec(state.cur).angle) || 0;
      if (!angle) {
        ctx.drawImage(bmp, 0, 0);
      } else {
        ctx.save();
        ctx.translate(c.width / 2, c.height / 2);
        ctx.rotate((angle * Math.PI) / 180); // canvas angles run clockwise: same as the setting
        ctx.drawImage(bmp, -c.width / 2, -c.height / 2);
        ctx.restore();
      }
    }

    function refresh() {
      invalidateLabels();
      if (state.view === "grid") thumbs.refresh();
      reflectMode();
      syncPages();
      drawOverlay();
      summarise();
      $.error.textContent = "";
    }

    // ---- layout + rendering
    function layout() {
      const { vw, vh } = dimsOf(state.cur, spec(state.cur).rotate);
      const aspect = vw / vh;
      const availW = Math.max(120, $.main.clientWidth - 28);
      const availH = Math.max(120, $.main.clientHeight - 28);
      const w = Math.min(availW, availH * aspect) * state.zoom;
      view.w = Math.max(60, Math.round(w));
      view.h = Math.max(60, Math.round(w / aspect));
      $.stage.style.width = view.w + "px";
      $.stage.style.height = view.h + "px";
    }

    let renderSeq = 0, active = null;
    async function renderPage() {
      const seq = ++renderSeq;
      layout();
      drawOverlay();
      if (active) client.cancel(active.id);
      $.msg.textContent = "Rendering…";
      $.msg.style.display = "flex";
      const rotate = spec(state.cur).rotate;
      try {
        active = client.render(state.cur + 1, Math.min(3600, Math.round(view.w * dpr())), rotate);
        const r = await active.promise;
        if (seq !== renderSeq) { if (r.bmp && r.bmp.close) r.bmp.close(); return; }
        if (state.bitmap && state.bitmap.close) state.bitmap.close();
        state.bitmap = r.bmp;
        paint();
        $.msg.textContent = "";
        $.msg.style.display = "none";
        $.stage.setAttribute("data-rendered", String(state.cur + 1));
        $.stage.setAttribute("data-rotate", String(rotate));
      } catch (e) {
        if (seq !== renderSeq || e.cancelled) return;
        if (state.bitmap && state.bitmap.close) state.bitmap.close();
        state.bitmap = null;
        $.canvas.getContext("2d").clearRect(0, 0, $.canvas.width, $.canvas.height);
        $.msg.textContent = "Couldn't draw a preview of this page (" + (e.message || e) + "). You can still type exact values on the right.";
        $.stage.setAttribute("data-rendered", "error");
      }
    }

    /** Show page index i (its number in the original file). */
    function goTo(i) {
      state.cur = clamp(Math.round(i), 0, N - 1);
      state.selEdge = null;
      setPageLabel();
      renderPages();
      reflectMode();
      renderPage();
    }
    /** Show the page at place p of the new order. */
    const goToPos = (p) => goTo(state.order[clamp(Math.round(p), 0, N - 1)]);

    // ---- dragging (works for side-by-side and stacked pages alike)
    let drag = null;
    const pointerUV = (e) => {
      const b = $.overlay.getBoundingClientRect();
      return [clamp((e.clientX - b.left) / b.width, 0, 1), clamp((e.clientY - b.top) / b.height, 0, 1)];
    };
    const bounds = (r, key) => ({ u0: [0, r.u1 - MIN], u1: [r.u0 + MIN, 1], v0: [0, r.v1 - MIN], v1: [r.v0 + MIN, 1] }[key]);
    /** The edge on the other page that sits on the same line as this one, if any (so they move together). */
    function partnerOf(s, ri, ch) {
      if (s.rects.length !== 2) return null;
      const pairs = s.axis === "h" ? [["b", "t"], ["l", "l"], ["r", "r"]] : [["r", "l"], ["t", "t"], ["b", "b"]]; // [edge of rect 0, edge of rect 1]
      for (const [c0, c1] of pairs) {
        if (Math.abs(s.rects[0][KEY[c0]] - s.rects[1][KEY[c1]]) >= LINK_EPS) continue;
        if (ri === 0 && ch === c0) return { ri: 1, ch: c1 };
        if (ri === 1 && ch === c1) return { ri: 0, ch: c0 };
      }
      return null;
    }
    $.overlay.addEventListener("pointerdown", (e) => {
      const t = e.target;
      const edge = t.getAttribute && t.getAttribute("data-edge");
      if (!edge) {
        if (state.selEdge) { state.selEdge = null; drawOverlay(); }
        return;
      }
      e.preventDefault();
      state.selEdge = { ri: +t.getAttribute("data-ri"), edge }; // arrow keys now nudge this line
      try { $.overlay.focus({ preventScroll: true }); } catch (err) { /* not focusable here */ }
      const s = spec(state.cur);
      if (s.mode === "skip") setMode(state.cur, "single");
      touch(state.cur);
      const ri = +t.getAttribute("data-ri");
      const partners = {};
      for (const ch of edge) partners[ch] = e.altKey ? null : partnerOf(s, ri, ch);
      drag = { ri, edge, partners };
      reflectMode();
      drawOverlay();
      try { $.overlay.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
    });
    $.overlay.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const s = spec(state.cur);
      const [u, v] = pointerUV(e);
      for (const ch of drag.edge) {
        const key = KEY[ch];
        const r = s.rects[drag.ri];
        let [lo, hi] = bounds(r, key);
        const p = drag.partners[ch];
        if (p) {
          const [lo2, hi2] = bounds(s.rects[p.ri], KEY[p.ch]);
          lo = Math.max(lo, lo2);
          hi = Math.min(hi, hi2);
        }
        const val = clamp(key[0] === "u" ? u : v, lo, Math.max(lo, hi));
        r[key] = val;
        if (p) s.rects[p.ri][KEY[p.ch]] = val;
      }
      refresh();
    });
    const endDrag = () => { drag = null; commit(); };
    /** Arrow keys on the selected line: 1 pixel of the preview (Shift: 10). Left/Right move vertical lines, Up/Down horizontal ones; a corner moves both. */
    function nudgeEdge(key, big, alt) {
      const sel = state.selEdge;
      if (!sel || !view.w || !view.h) return false;
      const s = spec(state.cur), r = s.rects[sel.ri];
      if (!r) return false;
      const horizontal = key === "ArrowLeft" || key === "ArrowRight";
      const sign = key === "ArrowLeft" || key === "ArrowUp" ? -1 : 1;
      const step = (big ? 10 : 1) / (horizontal ? view.w : view.h);
      let moved = false;
      for (const ch of sel.edge) {
        const k = KEY[ch];
        if ((k[0] === "u") !== horizontal) continue;
        let [lo, hi] = bounds(r, k);
        const p = alt ? null : partnerOf(s, sel.ri, ch);
        if (p) {
          const [lo2, hi2] = bounds(s.rects[p.ri], KEY[p.ch]);
          lo = Math.max(lo, lo2);
          hi = Math.min(hi, hi2);
        }
        const val = clamp(r[k] + sign * step, lo, Math.max(lo, hi));
        if (val === r[k]) continue;
        r[k] = val;
        if (p) s.rects[p.ri][KEY[p.ch]] = val;
        moved = true;
      }
      if (moved) { touch(state.cur); refresh(); }
      return moved;
    }
    $.overlay.addEventListener("pointerup", endDrag);
    $.overlay.addEventListener("pointercancel", endDrag);

    // ---- suggestions: spine, paper edges, tilt
    const SUG_MIN = 0.45; // confidence below this is reported but not applied
    const level = (c) => (c >= 0.75 ? "" : " (" + (c >= SUG_MIN ? "medium" : "low") + ")"); // shown only when not high
    const cloneSpec = (s) => ({ mode: s.mode, rects: s.rects.map(cloneRect), rotate: s.rotate, axis: s.axis, angle: s.angle });
    const spineWhy = { shadow: "fold shadow", gap: "text gap", "gap-bg": "gap between pages", middle: "middle" };
    const signed = (n) => (n > 0 ? "+" : "") + n.toFixed(1) + "°";

    /** What the analysis would change on page i: { spec, lines, changed } (spec is a modified copy). */
    function buildSuggestion(i, res, o) {
      const s = cloneSpec(spec(i));
      const lines = [];
      let changed = false;
      if (o.angle) {
        const a = res.angle;
        if (a.confidence >= SUG_MIN) {
          if (Math.abs(a.value) >= 0.15) {
            s.angle = Math.round(clamp(a.value, -45, 45) * 10) / 10;
            lines.push(`Tilt ${signed(s.angle)}${level(a.confidence)}`);
            changed = true;
          } else lines.push("Tilt: already straight");
        } else lines.push("Tilt: not measurable, left alone");
      }
      const E = res.edges;
      const useEdges = o.edges && E.confidence >= SUG_MIN && !E.trivial;
      if (o.edges) {
        if (E.trivial) lines.push("Edges: nothing to trim");
        else if (!useEdges) lines.push("Edges: unclear, left alone");
        else lines.push(`Edges ${toPct(E.u0)}–${toPct(E.u1)}% × ${toPct(E.v0)}–${toPct(E.v1)}%${level(E.confidence)}`);
      }
      const base = useEdges ? { u0: E.u0, v0: E.v0, u1: E.u1, v1: E.v1 } : union(s.rects);
      const sp = res.spine;
      const canSplit = o.spine && res.spread && sp && s.mode !== "single" && (s.mode === "split" ? s.axis === "v" : true);
      if (o.spine && !res.spread) lines.push("Spine: not a spread");
      if (canSplit) {
        const good = sp.confidence >= SUG_MIN;
        const mid = (base.u0 + base.u1) / 2;
        let uL = good ? sp.u : mid, uR = uL;
        if (good && sp.gap) { uL = sp.gap[0]; uR = sp.gap[1]; }
        else if (good && o.shadow && sp.shadow) { uL = sp.shadow[0]; uR = sp.shadow[1]; }
        const lo = base.u0 + MIN, hi = base.u1 - MIN;
        uL = clamp(uL, lo, hi - MIN); uR = clamp(uR, uL, hi);
        s.mode = "split"; s.axis = "v";
        s.rects = [{ u0: base.u0, v0: base.v0, u1: uL, v1: base.v1 }, { u0: uR, v0: base.v0, u1: base.u1, v1: base.v1 }];
        lines.push(good ? `Spine ${toPct(sp.u)}% · ${spineWhy[sp.source]}${level(sp.confidence)}` : "Spine: not found, split down the middle");
        changed = true;
      } else if (useEdges) {
        if (s.mode === "split" && s.rects.length === 2) {
          // keep the existing dividing line, just move the outer edges
          const [a, b] = s.rects;
          const d = s.axis === "v" ? { a: { ...a, u0: base.u0, v0: base.v0, v1: base.v1 }, b: { ...b, u1: base.u1, v0: base.v0, v1: base.v1 } } : { a: { ...a, u0: base.u0, u1: base.u1, v0: base.v0 }, b: { ...b, u0: base.u0, u1: base.u1, v1: base.v1 } };
          s.rects = [d.a, d.b];
        } else {
          s.mode = "single";
          s.rects = [{ ...base }];
        }
        changed = true;
      }
      if (changed && s.mode === "skip") s.mode = "single";
      return { spec: s, lines, changed };
    }

    const sugOptions = () => ({ spine: $.sugSpine.checked, edges: $.sugEdges.checked, angle: $.sugAngle.checked, shadow: $.sugShadow.checked });

    function applySuggestion(i, built) {
      if (!built.changed) return false;
      const prior = state.suggested.get(i);
      state.suggested.set(i, { prev: prior ? prior.prev : cloneSpec(spec(i)), wasTouched: prior ? prior.wasTouched : state.touched.has(i), lines: built.lines });
      state.specs.set(i, built.spec);
      return true;
    }
    function afterSuggestion(rerender) {
      renderPages();
      refresh();
      if (rerender) paint();
    }
    const analyseWidth = () => 1200;

    const setSuggestLabel = (t) => { $.sugRun.textContent = t; if (typeof syncSuggest === "function") syncSuggest(); };

    /**
     * Look at the pages in `list` one after the other and set spine, paper edges and tilt. With no explicit choice
     * (the Suggest button) pages the person has already edited are skipped; pages picked in the thumbnails are
     * always done. Pages edited while it runs are left alone.
     */
    function detectPages(list, explicit) {
      const o = sugOptions();
      if (!o.spine && !o.edges && !o.angle) { $.detect.textContent = "Tick at least one option."; return Promise.resolve(); }
      if (!list.length) return Promise.resolve();
      // forget earlier suggestions on pages nobody edited, so this run starts clean with the current ticks
      for (const i of list) if (!state.touched.has(i)) undoSuggestion(i);
      afterSuggestion(true);
      const batch = (state.batch = { stop: false });
      setSuggestLabel("Stop");
      syncUndo();
      batch.done = (async () => {
        let n = 0, failed = 0;
        const total = list.filter((i) => explicit || !state.touched.has(i)).length; // pages that will really be looked at
        for (const i of list) {
          if (batch.stop) break;
          const was = state.touched.has(i);
          if (was && !explicit) continue; // skipped pages don't count
          n++;
          $.detect.textContent = `Looking at page ${n} of ${Math.max(total, n)}…`;
          try {
            const { promise } = client.analyse(i + 1, analyseWidth(), spec(i).rotate);
            const { result } = await promise;
            if (batch.stop || (!was && state.touched.has(i))) continue; // edited while we were looking: leave it
            applySuggestion(i, buildSuggestion(i, result, o));
          } catch (e) {
            if (!batch.stop) failed++;
          }
          if (i === state.cur) afterSuggestion(true);
          else if (state.view === "grid") thumbs.refresh([i]);
          else if (n % 6 === 0) summarise();
        }
        state.batch = null;
        setSuggestLabel("Suggest");
        commit(); // the whole run is one undo step
        $.detect.textContent = failed ? `${failed} page${failed > 1 ? "s" : ""} couldn't be analysed` : "";
        summarise();
        afterSuggestion(true);
        if (thumbs && typeof syncToolbar === "function") syncToolbar();
      })();
      return batch.done;
    }
    /** The Suggest button: every page, the one on screen first. */
    function detectAll() {
      const p = pos();
      return detectPages(state.order.map((_, k) => state.order[(p + k) % N]), false);
    }

    function undoSuggestion(i) {
      const sug = state.suggested.get(i);
      if (!sug) return false;
      state.specs.set(i, sug.prev);
      if (!sug.wasTouched) state.touched.delete(i);
      state.suggested.delete(i);
      return true;
    }
    /** The pages Suggest will look at: every page (null), or this page / the pages picked in the thumbnails. */
    const suggestTargets = () => (state.sugScope === "all" ? null : state.view === "grid" ? thumbs.selected() : [state.cur]);
    function syncSuggest() {
      const grid = state.view === "grid";
      $.sugThis.textContent = grid ? "Selected pages" : "This page";
      $.sugThis.title = grid ? "Look only at the pages picked in the thumbnails" : "Look only at the page on screen";
      $.sugAll.setAttribute("aria-pressed", String(state.sugScope === "all"));
      $.sugThis.setAttribute("aria-pressed", String(state.sugScope !== "all"));
      const t = suggestTargets();
      const idle = !state.batch && !!t && t.length === 0; // "selected pages" but none selected
      $.sugRun.disabled = idle;
      const MSG = "Select pages in the thumbnails first.";
      if (!state.batch) { if (idle) $.detect.textContent = MSG; else if ($.detect.textContent === MSG) $.detect.textContent = ""; }
    }
    function runSuggest() {
      if (state.batch) { state.batch.stop = true; $.detect.textContent = "Stopping…"; return; }
      const t = suggestTargets();
      if (!t) detectAll();
      else if (t.length) detectPages(t, true); // pages the person names are always done, even if edited
    }
    $.sugRun.addEventListener("click", runSuggest);
    for (const [btnEl, scope] of [[$.sugAll, "all"], [$.sugThis, "this"]]) btnEl.addEventListener("click", () => { state.sugScope = scope; syncSuggest(); });

    // ---- controls
    $.prev.addEventListener("click", () => goToPos(pos() - 1));
    $.next.addEventListener("click", () => goToPos(pos() + 1));
    let menuIndex = -1, typed = "", typedTimer = null;
    const options = () => Array.from($.pageList.children);
    const highlight = (i) => {
      const list = options();
      if (!list.length) return;
      menuIndex = clamp(i, 0, list.length - 1);
      list.forEach((o, k) => { o.classList.toggle("on", k === menuIndex); o.setAttribute("aria-selected", String(k === menuIndex)); });
      list[menuIndex].scrollIntoView({ block: "nearest" });
    };
    function closePageList(focusButton) {
      if ($.pageList.hidden) return;
      $.pageList.hidden = true;
      $.pageNo.setAttribute("aria-expanded", "false");
      if (focusButton) $.pageNo.focus();
    }
    function openPageList() {
      if (!$.pageList.hidden) return;
      if (!$.pageList.firstChild) {
        for (let i = 0; i < N; i++) $.pageList.append(el(doc, "div", { class: "pageopt", role: "option", "data-page": i, text: String(i + 1) }));
      }
      options().forEach((o, k) => o.classList.toggle("cur", k === pos()));
      $.pageList.hidden = false;
      $.pageNo.setAttribute("aria-expanded", "true");
      highlight(pos());
      $.pageList.focus();
    }
    const choosePage = (i) => { closePageList(true); goToPos(i); };
    $.pageNo.addEventListener("click", () => ($.pageList.hidden ? openPageList() : closePageList(true)));
    $.pageNo.addEventListener("keydown", (e) => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); openPageList(); } });
    $.pageList.addEventListener("click", (e) => {
      const o = e.target.closest && e.target.closest(".pageopt");
      if (o) choosePage(Number(o.getAttribute("data-page")));
    });
    $.pageList.addEventListener("mousemove", (e) => {
      const o = e.target.closest && e.target.closest(".pageopt");
      if (o) highlight(Number(o.getAttribute("data-page")));
    });
    $.pageList.addEventListener("keydown", (e) => {
      const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 }[e.key];
      if (step) { e.preventDefault(); e.stopPropagation(); highlight(menuIndex + step); }
      else if (e.key === "Home" || e.key === "End") { e.preventDefault(); e.stopPropagation(); highlight(e.key === "Home" ? 0 : N - 1); }
      else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); choosePage(menuIndex); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePageList(true); }
      else if (e.key === "Tab") closePageList(false);
      else if (/^[0-9]$/.test(e.key)) { // type a page number to jump to it
        e.preventDefault(); e.stopPropagation();
        typed += e.key;
        win.clearTimeout(typedTimer);
        typedTimer = win.setTimeout(() => { typed = ""; }, 900);
        const hit = Math.min(N, Number(typed));
        if (hit >= 1) highlight(hit - 1);
      }
    });
    const onDocDown = (e) => { if (!$.pageList.hidden && !$.pageMenu.contains(e.target)) closePageList(false); };
    doc.addEventListener("mousedown", onDocDown, true);
    for (const k of ["split", "single"]) {
      $["mode-" + k].addEventListener("click", () => {
        if (k === "single" && spec(state.cur).mode === "skip") return; // already one page, exactly as it is
        setMode(state.cur, k);
        renderPages();
        refresh();
      });
    }
    for (const axis of ["v", "h"]) for (const p of ["", "t"]) {
      $[p + "axis-" + axis].addEventListener("click", () => { for (const i of axisTargets()) setAxis(i, axis); renderPages(); refresh(); });
    }
    for (const [key, delta] of [["rotL", -90], ["rotR", 90]]) {
      $[key].addEventListener("click", () => {
        rotatePage(state.cur, delta);
        renderPages();
        refresh();
        renderPage(); // new orientation: new picture
      });
    }
    const setAngle = (val) => {
      const s = spec(state.cur);
      if (s.mode === "skip") setMode(state.cur, "single");
      touch(state.cur);
      s.angle = Math.round(clamp(val, -45, 45) * 10) / 10;
      paint();
      refresh();
    };
    $.angle.addEventListener("input", () => setAngle(Number($.angle.value)));
    $.angleNum.addEventListener("change", () => { const n = Number($.angleNum.value); if (Number.isFinite(n)) setAngle(n); else $.angleNum.value = spec(state.cur).angle; });
    $.grid.addEventListener("change", () => { state.grid = $.grid.checked; drawOverlay(); });
    const onDir = () => { state.rtl = $.rtl.checked; renderPages(); drawOverlay(); commit(); };
    $.ltr.addEventListener("change", onDir);
    $.rtl.addEventListener("change", onDir);
    $.reset.addEventListener("click", () => {
      const hadRotation = spec(state.cur).rotate;
      state.specs.set(state.cur, defaultSpec(state.cur));
      state.touched.delete(state.cur);
      state.suggested.delete(state.cur);
      renderPages();
      refresh();
      if (hadRotation) renderPage(); else paint();
    });
    $.resetAll.addEventListener("click", () => {
      if (!win.confirm("Reset everything?\n\nEvery page goes back to its default layout, and the page order, page numbers and \u201cNormalise page size\u201d are cleared. All your changes and suggestions will be lost, unless you press Undo.")) return;
      if (state.batch) state.batch.stop = true;
      state.specs.clear(); // pages fall back to their defaults the next time they are read
      state.touched.clear();
      state.suggested.clear();
      state.order = Array.from({ length: N }, (_, i) => i); // original page order
      state.normalize = false;
      $.normalize.checked = false;
      state.rules = []; // the file's own page numbers again
      $.selMsg.textContent = "";
      fromEdited = false;
      $.detect.textContent = "";
      setPageLabel();
      thumbs.layout();
      renderRules();
      renderPages();
      refresh();
      renderPage();
    });

    const copyChoice = () => (["all", "landscape", "portrait", "some"].find((k) => $["copy-" + k].checked)) || "all";
    const syncCopy = () => {
      const some = copyChoice() === "some";
      $.copyRange.disabled = !some; // greyed out unless "Only these pages" is chosen
    };
    for (const k of ["all", "landscape", "portrait", "some"]) {
      $["copy-" + k].addEventListener("change", () => {
        syncCopy();
        if (k === "some") $.copyRange.focus();
      });
    }
    if (config.selection) $["copy-some"].checked = true;
    syncCopy();

    $.copyBtn.addEventListener("click", () => {
      $.copyMsg.textContent = "";
      const choice = copyChoice();
      let targets;
      try {
        if (choice === "all") targets = config.parsePages("all", N);
        else if (choice === "some") targets = config.parsePages($.copyRange.value, N);
        else targets = pages.map((p, i) => i).filter((i) => (choice === "landscape") === pages[i].landscape);
      } catch (e) {
        $.copyMsg.textContent = e.message || String(e);
        return;
      }
      if (!targets.length) { $.copyMsg.textContent = `There are no ${choice} pages.`; return; }
      const src = spec(state.cur);
      const srcLandscape = isLandscape(state.cur, src.rotate);
      // "all landscape/portrait pages" is explicit about the shape; "all" and "these pages" skip pages whose shape wouldn't fit
      const checkShape = choice === "all" || choice === "some";
      const wanted = targets.filter((i) => i !== state.cur && !(checkShape && src.mode !== "skip" && isLandscape(i, src.rotate) !== srcLandscape));
      if (wanted.length > 5 && !win.confirm(`Copy this page's layout (areas, turn and tilt) to ${wanted.length} pages?\n\nTheir own settings will be replaced. You can undo this (Ctrl/Cmd Z).`)) return;
      let done = 0, skipped = 0;
      for (const i of targets) {
        if (i === state.cur) continue;
        if (checkShape && src.mode !== "skip" && isLandscape(i, src.rotate) !== srcLandscape) { skipped++; continue; }
        state.specs.set(i, src.mode === "skip" ? baseSpec(i) : { mode: src.mode, rects: src.rects.map($.copyExclusions.checked ? cloneRect : plainRect), rotate: src.rotate, axis: src.axis, angle: src.angle });
        touch(i);
        done++;
      }
      $.copyMsg.textContent = `Copied to ${done} page${done === 1 ? "" : "s"}` + (skipped ? ` (${skipped} with a different shape skipped)` : "") + ".";
      summarise();
    });
    $.normalize.addEventListener("change", () => { state.normalize = $.normalize.checked; summarise(); });

    /** Has the person changed anything that Cancel would throw away? (The default layout of a fresh file doesn't count.) */
    function isDirty() {
      return state.touched.size > 0 || state.suggested.size > 0 || orderChanged() || state.rules.length > 0 || state.normalize;
    }
    /** Cancel / Escape: ask first if there is work to lose. */
    function requestCancel() {
      if (isDirty() && !win.confirm("Discard your changes?\n\nThe PDF has not been changed yet. Cancelling throws away everything you set in this window.")) return;
      finish(null);
    }
    $.cancel.addEventListener("click", requestCancel);
    $.undo.addEventListener("click", undo);
    $.redo.addEventListener("click", redo);
    $.ok.addEventListener("click", () => {
      if (state.batch && !win.confirm("Auto-detect hasn't finished yet. Apply now?\n\nPages it hasn't reached keep their default layout.")) return;
      if (state.batch) state.batch.stop = true;
      const counts = summarise();
      if (fresh && counts.splits > 0 && state.touched.size === 0 && state.suggested.size === 0 && !win.confirm(`Split ${counts.splits} landscape page${counts.splits > 1 ? "s" : ""} down the middle?\n\nNothing has been adjusted yet, so every wide page (including fold-out tables or maps) will be cut in two. Click Cancel to go back and check the pages first.`)) return;
      if (counts.kept === 0) {
        $.error.textContent = "Every page is removed: nothing would be left.";
        return;
      }
      if (!counts.splits && !counts.crops && !state.normalize && !orderChanged() && !rulesForPlan().length) {
        $.error.textContent = "Nothing to apply yet: change, remove or re-order a page, set page numbers, or tick “Normalise page size”.";
        return;
      }
      const out = {};
      for (let i = 0; i < N; i++) {
        const s = spec(i);
        if (s.mode === "skip") continue;
        const entry = { rects: s.rects.map(cloneRect) };
        if (s.rotate) entry.rotate = s.rotate;
        if (s.rects.length === 2) entry.axis = s.axis;
        if (s.angle) entry.angle = s.angle;
        out[i] = entry;
      }
      const plan = { pages: out, rtl: state.rtl };
      if (state.normalize) plan.normalize = true;
      if (orderChanged()) plan.order = state.order.slice();
      const rules = rulesForPlan();
      if (rules.length) plan.labelRules = rules;
      finish({ plan, rtl: state.rtl });
    });
    const onKey = (e) => {
      const typing = !!(e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName || "") && !["checkbox", "radio", "range", "button"].includes(e.target.type));
      if (e.key === "Escape") { e.preventDefault(); requestCancel(); }
      else if ((e.ctrlKey || e.metaKey) && !e.altKey && !typing && /^[zy]$/i.test(e.key)) {
        e.preventDefault();
        if (e.key.toLowerCase() === "y" || e.shiftKey) redo(); else undo();
      } else if (state.view === "page" && state.selEdge && !e.ctrlKey && !e.metaKey && /^Arrow(Left|Right|Up|Down)$/.test(e.key) && (e.target === $.overlay || e.target === doc.body || e.target === doc.documentElement)) {
        if (nudgeEdge(e.key, e.shiftKey, e.altKey)) e.preventDefault();
      } else if (state.view === "grid") {
        if (thumbs.handleKey(e)) return;
        if ((e.key === "Delete" || e.key === "Backspace") && !typing && thumbs.selected().length) { e.preventDefault(); toggleRemoveSelected(); }
      } else if (e.key === "Delete" && !typing && $.pageList.hidden) { // page view: Delete removes (or brings back) the page on screen
        e.preventDefault();
        setPageRemoved(state.cur, !pageRemoved(state.cur));
        renderPages();
        refresh();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "+" || e.key === "=")) { e.preventDefault(); setZoom(state.zoom * 1.25); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === "-" || e.key === "_")) { e.preventDefault(); setZoom(state.zoom / 1.25); }
      else if ((e.ctrlKey || e.metaKey) && e.key === "0") { e.preventDefault(); setZoom(1); }
      else if (e.key === "PageDown" || (e.ctrlKey && e.key === "ArrowRight")) { e.preventDefault(); goToPos(pos() + 1); }
      else if (e.key === "PageUp" || (e.ctrlKey && e.key === "ArrowLeft")) { e.preventDefault(); goToPos(pos() - 1); }
    };
    let resizeTimer = null;
    const onResize = () => {
      win.clearTimeout(resizeTimer);
      resizeTimer = win.setTimeout(() => { if (state.view !== "grid") renderPage(); }, 150);
    };
    doc.addEventListener("keydown", onKey);
    win.addEventListener("resize", onResize);

    // ---- zoom (the page view)
    let zoomTimer = null;
    const reflectZoom = () => {
      $.zoomLbl.textContent = state.zoom === 1 ? "Fit" : Math.round(state.zoom * 100) + "%";
      $.zoomOut.disabled = state.zoom <= 1;
      $.zoomIn.disabled = state.zoom >= 4;
    };
    function setZoom(z) {
      const n = clamp(Math.round(z * 100) / 100, 1, 4);
      if (n === state.zoom) return;
      state.zoom = n;
      reflectZoom();
      layout();
      drawOverlay();
      win.clearTimeout(zoomTimer);
      zoomTimer = win.setTimeout(renderPage, 180); // sharpen once the zooming stops
    }
    $.zoomIn.addEventListener("click", () => setZoom(state.zoom * 1.25));
    $.zoomOut.addEventListener("click", () => setZoom(state.zoom / 1.25));
    $.zoomLbl.addEventListener("click", () => setZoom(1));
    $.main.addEventListener("wheel", (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      setZoom(state.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    }, { passive: false });
    reflectZoom();

    // ---- order
    function applyOrder(next) {
      state.order = next;
      setPageLabel();
      thumbs.layout();
      refresh();
    }
    /** The order after moving each picked page one place earlier (dir -1) or later (dir 1); pages picked together keep their gaps. */
    function nudged(ids, dir) {
      const set = new Set(ids), o = state.order.slice();
      if (dir < 0) { for (let k = 1; k < o.length; k++) if (set.has(o[k]) && !set.has(o[k - 1])) [o[k - 1], o[k]] = [o[k], o[k - 1]]; }
      else { for (let k = o.length - 2; k >= 0; k--) if (set.has(o[k]) && !set.has(o[k + 1])) [o[k + 1], o[k]] = [o[k], o[k + 1]]; }
      return o;
    }
    const nudge = (ids, dir) => applyOrder(nudged(ids, dir));
    /** Pages the order buttons act on: the thumbnails' selection, or the page on screen. */
    const orderTargets = () => (state.view === "grid" ? thumbs.selected() : [state.cur]);
    const differs = (next) => next.some((v, k) => v !== state.order[k]);
    function syncOrderButtons() {
      const t = orderTargets();
      const none = t.length === 0;
      $.mvEarlier.disabled = none || !differs(nudged(t, -1));
      $.mvLater.disabled = none || !differs(nudged(t, 1));
      $.mvStart.disabled = none || !differs(ScanFixerThumbs.moveBlock(state.order, t, 0));
      $.mvEnd.disabled = none || !differs(ScanFixerThumbs.moveBlock(state.order, t, N));
    }
    $.mvEarlier.addEventListener("click", () => nudge(orderTargets(), -1));
    $.mvLater.addEventListener("click", () => nudge(orderTargets(), 1));
    $.mvStart.addEventListener("click", () => applyOrder(ScanFixerThumbs.moveBlock(state.order, orderTargets(), 0)));
    $.mvEnd.addEventListener("click", () => applyOrder(ScanFixerThumbs.moveBlock(state.order, orderTargets(), N)));
    $.mvPos.addEventListener("change", () => {
      const n = Math.round(Number($.mvPos.value));
      if (!(n >= 1 && n <= N)) { $.mvPos.value = pos() + 1; return; }
      const rest = state.order.filter((i) => i !== state.cur);
      rest.splice(n - 1, 0, state.cur);
      applyOrder(rest);
    });

    // ---- page numbers: one form, plus the list of ranges it has made. No ranges = the file's own numbers are left alone.
    const STYLES = [["D", "1, 2, 3"], ["r", "i, ii, iii"], ["R", "I, II, III"], ["a", "a, b, c"], ["A", "A, B, C"], [null, "no number"]];
    const styleText = (st) => (STYLES.find((x) => x[0] === st) || STYLES[0])[1];
    const nextStyle = (st) => STYLES[(STYLES.findIndex((x) => x[0] === st) + 1) % STYLES.length][0];
    let numStyle = "D";
    $.selStyle.textContent = styleText(numStyle);
    $.selStyle.addEventListener("click", () => { numStyle = nextStyle(numStyle); $.selStyle.textContent = styleText(numStyle); });
    $.selFrom.addEventListener("input", () => { fromEdited = true; syncNumberForm(); });
    /** Does "Number…" act on the pages picked in the thumbnails (true) or from a page number onwards (false)? */
    const numberBySelection = () => state.view === "grid" && thumbs.selected().length > 0 && !fromEdited;
    function syncNumberForm() {
      const n = state.view === "grid" ? thumbs.selected().length : 0;
      const bySel = numberBySelection();
      $.selFromRow.hidden = bySel;
      const from = Math.max(1, Math.round(Number($.selFrom.value)) || 1);
      $.selApply.textContent = bySel ? `Number ${n} selected page${n > 1 ? "s" : ""}` : `Number from page ${from} onwards`;
    }
    function updateLabels() {
      const L = labelsNow();
      $.lblPreview.textContent = !state.labelsOn ? "" : L ? "The new file will read: " + (L.length <= 10 ? L.join(", ") : L.slice(0, 6).join(", ") + " … " + L.slice(-3).join(", ")) : "";
      refresh();
    }
    function renderRules() {
      state.labelsOn = state.rules.length > 0;
      $.rules.replaceChildren();
      $.rulesHead.hidden = $.clearRules.hidden = !state.rules.length;
      state.rules.forEach((r, k) => {
        const start = Math.max(1, Math.round(Number(r.start)) || 1);
        const sample = r.style === null ? (r.prefix || "no number") : ScanFixer.pageLabels([{ from: 0, style: r.style, start, prefix: r.prefix || "" }], 3).join(", ") + " …";
        const txt = el(doc, "span", { class: "txt", text: `From page ${r.from}: ${sample}`, title: "Click to load this range into the form above" });
        const del = el(doc, "button", { type: "button", text: "✕", title: "Remove this range", "aria-label": "Remove this range" });
        txt.addEventListener("click", () => {
          numStyle = r.style; $.selStyle.textContent = styleText(numStyle);
          $.selStart.value = start; $.selPrefix.value = r.prefix || "";
          $.selFrom.value = Math.round(Number(r.from)) || 1; fromEdited = true; syncNumberForm();
        });
        del.addEventListener("click", () => { state.rules.splice(k, 1); renderRules(); });
        $.rules.append(el(doc, "div", { class: "rangechip" }, txt, del));
      });
      syncNumberForm();
      updateLabels();
    }
    $.clearRules.addEventListener("click", () => { state.rules = []; $.selMsg.textContent = ""; renderRules(); });
    $.selApply.addEventListener("click", () => {
      $.selMsg.textContent = "";
      if (numberBySelection()) return numberSelection();
      const total = outputPages().length;
      const from = Math.round(Number($.selFrom.value));
      if (!(from >= 1 && from <= total)) { $.selMsg.textContent = `Choose a page from 1 to ${total}.`; return; }
      const start = Math.max(1, Math.round(Number($.selStart.value)) || 1);
      state.rules = state.rules.filter((r) => (Math.round(Number(r.from)) || 1) !== from); // one range per starting page
      state.rules.push({ from, style: numStyle, start, prefix: $.selPrefix.value });
      state.rules.sort((x, y) => x.from - y.from);
      fromEdited = false;
      renderRules();
      $.selMsg.textContent = `Pages from ${from} onwards are numbered.`;
    });

    // ---- number the pages picked in the thumbnails: one range per run of picked pages, and a range after each run
    //      that carries on the numbering that was there, so only the picked pages change
    function numberSelection() {
      const ids = new Set(thumbs.selected());
      if (!ids.size) return;
      const out = outputPages(), total = out.length;
      const idx = [];
      out.forEach((o, k) => { if (ids.has(o.src)) idx.push(k); });
      if (!idx.length) { $.selMsg.textContent = "The selected pages are all removed."; return; }
      const old = rulesForPlan().sort((a, b) => a.from - b.from);
      const effective = (k) => { let r = null; for (const x of old) if (x.from <= k) r = x; return r; };
      const runs = [];
      for (const k of idx) { const l = runs[runs.length - 1]; if (l && l[1] === k - 1) l[1] = k; else runs.push([k, k]); }
      const inRun = (k) => runs.some(([a, b]) => k >= a && k <= b);
      const merged = new Map(old.filter((r) => !inRun(r.from)).map((r) => [r.from, r]));
      for (const [, b] of runs) { // carry on what was there after each run
        const k = b + 1;
        if (k >= total || inRun(k)) continue;
        const r = effective(k);
        merged.set(k, r ? { from: k, style: r.style, start: r.start + (k - r.from), prefix: r.prefix } : { from: k, style: "D", start: k + 1, prefix: "" });
      }
      const begin = Math.max(1, Math.round(Number($.selStart.value)) || 1);
      let done = 0;
      for (const [a, b] of runs) {
        merged.set(a, { from: a, style: numStyle, start: begin + done, prefix: $.selPrefix.value });
        done += b - a + 1;
      }
      state.rules = [...merged.values()].sort((x, y) => x.from - y.from).map((r) => ({ ...r, from: r.from + 1 }));
      renderRules();
      $.selMsg.textContent = `Numbered ${idx.length} page${idx.length > 1 ? "s" : ""}; the pages after keep their numbers.`;
    }

    // ---- thumbnails: pick pages, then remove / turn / re-order / auto-suggest them together
    const tb = (id, text, title) => el(doc, "button", { type: "button", id, text, title });
    const B = {
      split: tb("tbSplit", "Split", "Cut the selected pages into two"),
      crop: tb("tbCrop", "Single", "Keep each selected page as one page, with its own crop"),
      leave: tb("tbLeave", "Reset", "Put the selected pages back to how they were when the file was opened (no split, crop or turn)"),
      rotL: tb("tbRotL", "↺", "Turn the selected pages 90° anticlockwise"),
      rotR: tb("tbRotR", "↻", "Turn the selected pages 90° clockwise"),
    };
    const selIds = () => thumbs.selected();
    const bulk = (fn) => { for (const i of selIds()) fn(i); renderPages(); refresh(); };
    function toggleRemoveSelected() {
      const ids = selIds();
      const allGone = ids.length > 0 && ids.every(pageRemoved);
      bulk((i) => setPageRemoved(i, !allGone));
    }
    function syncToolbar() {
      const n = selIds().length, none = n === 0;
      for (const b of Object.values(B)) b.disabled = none;
      reflectAxis(spec(state.cur));
      $.gridHint.textContent = none ? "Select pages in the grid, then use the tools here." : `${n} page${n > 1 ? "s" : ""} selected. The tools below apply to ${n > 1 ? "them" : "it"}.`;
      syncRemove();
      syncOrderButtons();
      syncNumberForm();
      syncSuggest();
    }
    const onTargets = (fn) => { for (const i of removeTargets()) fn(i); refresh(); };
    $.rmWhole.addEventListener("click", () => onTargets((i) => setPageRemoved(i, true)));
    $.rmRestore.addEventListener("click", () => onTargets((i) => setPageRemoved(i, false)));
    $.rmL.addEventListener("click", () => toggleHalf(0));
    $.rmR.addEventListener("click", () => toggleHalf(1));
    for (const k of ["split", "crop", "leave"]) B[k].addEventListener("click", () => bulk((i) => setMode(i, k === "crop" ? "single" : k === "leave" ? "skip" : "split")));
    B.rotL.addEventListener("click", () => bulk((i) => rotatePage(i, -90)));
    B.rotR.addEventListener("click", () => bulk((i) => rotatePage(i, 90)));
    const tgroup = (label, ...kids) => el(doc, "div", { class: "tgroup" }, el(doc, "span", { class: "tglabel", text: label }), ...kids);
    const tpair = (...kids) => el(doc, "div", { class: "pair" }, ...kids);

    const thumbs = ScanFixerThumbs.create(doc, win, client, {
      count: N,
      reorder: true,
      order: () => state.order,
      info: (i) => {
        const s = spec(i);
        const removed = pageRemoved(i);
        const tags = [];
        if (removed) tags.push("removed");
        else if (s.mode === "split") tags.push(s.rects.some((r) => r.exclude) ? "split, one half removed" : "split");
        else if (s.mode === "single") tags.push("crop");
        if (s.rotate) tags.push(`turned ${s.rotate}°`);
        if (s.angle) tags.push(`tilt ${s.angle}°`);
        if (state.suggested.has(i)) tags.push("suggested");
        return { removed, rects: s.mode === "skip" ? [] : s.rects, rotate: s.rotate, tags, label: getLblMap().get(i) };
      },
      onChange: () => { fromEdited = false; syncToolbar(); },
      onOpen: (i) => { state.cur = i; setView("page"); },
      onMove: (ids, p) => applyOrder(ScanFixerThumbs.moveBlock(state.order, ids, p)),
      actions: [tgroup("Layout", tpair(B.split, B.crop, B.leave), $.groupAxisT), tgroup("Turn", tpair(B.rotL, B.rotR))],
    });
    thumbs.el.hidden = true;
    $.centre.append(thumbs.el);
    syncToolbar();

    function setView(v) {
      state.view = v;
      $.app.classList.toggle("grid", v === "grid");
      $.main.hidden = v === "grid";
      thumbs.el.hidden = v !== "grid";
      $.vPage.setAttribute("aria-pressed", String(v === "page"));
      $.vGrid.setAttribute("aria-pressed", String(v === "grid"));
      if (v === "grid") {
        invalidateLabels();
        thumbs.layout();
        thumbs.scrollTo(state.cur);
        syncToolbar();
      } else {
        const picked = thumbs.selected(); // go to the page picked in the thumbnails (the one clicked last, else the first)
        if (picked.length) state.cur = picked.includes(thumbs.anchor()) ? thumbs.anchor() : picked[0];
        setPageLabel();
        renderPages();
        reflectMode();
        renderPage();
      }
    }
    $.vPage.addEventListener("click", () => setView("page"));
    $.vGrid.addEventListener("click", () => setView("grid"));

    renderRules();
    renderPages();
    reflectMode();
    hist.last = snapshot();
    hist.key = JSON.stringify(hist.last);
    hist.ready = true;
    summarise();
    renderPage();

    return {
      state, goTo, goToPos, refresh, spec, client, undo, redo, hist, countOutside, countTrash, thumbs, setView, setZoom,
      destroy: () => {
        thumbs.destroy();
        win.clearTimeout(zoomTimer);
        if (state.batch) state.batch.stop = true;
        doc.removeEventListener("keydown", onKey);
        doc.removeEventListener("mousedown", onDocDown, true);
        win.removeEventListener("resize", onResize);
        win.clearTimeout(resizeTimer);
        if (state.bitmap && state.bitmap.close) state.bitmap.close();
        client.terminate();
      },
    };
  }

  // ---------------------------------------------------------------- opening the window (Zotero)
  async function open(parentWindow, config) {
    const win = parentWindow.openDialog(
      "about:blank",
      "scanfixer-editor",
      "chrome,dialog=no,dependent,centerscreen,resizable,width=1180,height=820"
    );
    const sleep = (ms) => new Promise((r) => parentWindow.setTimeout(r, ms));
    for (let i = 0; i < 120; i++) {
      const d = win.document;
      if (d && d.readyState === "complete" && d.body && win.location.href === "about:blank") break;
      await sleep(25);
    }
    if (!win.document || !win.document.body) throw new Error("Could not open the editor window");
    const doc = win.document;
    doc.title = config.title;
    // opaque from the first moment, so the window is never see-through while loading
    const base = el(doc, "style");
    base.textContent = CSS;
    (doc.head || doc.documentElement).append(base);
    doc.body.replaceChildren(el(doc, "div", { id: "loading", text: "Loading page previews…" }));

    let client = null;
    let editor = null;
    let finished = false;
    let resolveOuter;
    const done = new Promise((r) => (resolveOuter = r));
    const finish = (value) => {
      if (finished) return;
      finished = true;
      if (editor) editor.destroy();
      else if (client) client.terminate();
      try { win.close(); } catch (e) { /* already closed */ }
      resolveOuter(value);
    };
    win.addEventListener("unload", () => finish(null));

    try {
      const source = await config.getWorkerSource();
      const created = await createClient(win, source, config.pdfBytes);
      client = created.client;
      if (created.pages !== config.pages.length) throw new Error("The preview has a different page count than the file");
      if (finished) { client.terminate(); return done; } // window was closed while loading
      editor = buildEditor(doc, win, config, client, finish);
      win.focus();
    } catch (e) {
      finished = true;
      if (client) client.terminate();
      try { win.close(); } catch (err) { /* ignore */ }
      throw e;
    }
    return done;
  }

  return { open, buildEditor, createClient, RenderClient };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ScanFixerEditor;
