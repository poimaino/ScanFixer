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
  const cloneRect = (r) => ({ u0: r.u0, v0: r.v0, u1: r.u1, v1: r.v1 });
  const toPct = (n) => Math.round(n * 1000) / 10;

  // Colours are explicit and opaque: Zotero's plain windows can otherwise be see-through.
  const CSS = `
    :root { color-scheme: light dark; --bg: #ffffff; --fg: #1d1d1f; --panel: #ececef; --line: rgba(0,0,0,.25); --accent: #1b6ef3; }
    @media (prefers-color-scheme: dark) { :root { --bg: #28282b; --fg: #ececec; --panel: #1b1b1d; --line: rgba(255,255,255,.28); } }
    html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); }
    body { font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
    .app { display: grid; grid-template-columns: minmax(0, 1fr) 300px; grid-template-rows: auto minmax(0, 1fr) auto; height: 100%; background: var(--bg); }
    header { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 18px; padding: 8px 12px; border-bottom: 1px solid var(--line); background: var(--bg); }
    .group { display: flex; align-items: center; gap: 6px; }
    button, input, select { font: inherit; }
    button { padding: 3px 11px; }
    button[aria-pressed=true] { background: var(--accent); color: #fff; border-color: var(--accent); }
    #pageNo { width: 56px; text-align: right; }
    .info { opacity: .75; }
    main { position: relative; overflow: hidden; min-height: 260px; display: flex; align-items: center; justify-content: center; background: var(--panel); }
    #stage { position: relative; background: #fff; box-shadow: 0 1px 8px rgba(0,0,0,.35); }
    #canvas, #overlay { position: absolute; left: 0; top: 0; width: 100%; height: 100%; }
    #overlay { touch-action: none; user-select: none; overflow: visible; }
    #msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: 16px; color: #333; font-size: 13px; pointer-events: none; }
    aside { border-left: 1px solid var(--line); padding: 10px 12px; overflow: auto; background: var(--bg); }
    aside h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; opacity: .65; margin: 12px 0 6px; }
    aside h2:first-child { margin-top: 0; }
    .rectbox { border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; margin: 0 0 8px; }
    .rectbox b { display: block; margin-bottom: 3px; }
    .nums { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 10px; }
    .nums label { display: flex; align-items: center; justify-content: space-between; gap: 4px; }
    .nowrap { white-space: nowrap; }
    .nums input { width: 54px; text-align: right; padding: 2px 4px; box-sizing: border-box; }
    input.bad { outline: 2px solid #d12; }
    .small { font-size: 12px; opacity: .75; margin: 4px 0; }
    .opt { display: block; margin: 2px 0; }
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
  `;

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
    const fresh = !config.processed; // a file ScanFixer hasn't touched: landscape pages start as "split"
    const state = {
      cur: clamp(config.initialPage || 0, 0, N - 1),
      specs: new Map(),
      touched: new Set(), // pages the user has changed
      rtl: !!config.rtl,
      normalize: false, // make all pages the same size
      grid: false,
      bitmap: null,
    };

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
      s.rects = s.rects.map((r) => turnRect(r, delta));
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

    const $ = {};
    const btn = (key, text, title, id) => ($[key] = el(doc, "button", { type: "button", title, "aria-pressed": "false", id, text }));
    $.prev = el(doc, "button", { type: "button", title: "Previous page (PageUp)", text: "◀" });
    $.next = el(doc, "button", { type: "button", title: "Next page (PageDown)", text: "▶" });
    $.pageNo = el(doc, "input", { type: "number", id: "pageNo", min: 1, max: N, value: state.cur + 1 });
    $.info = el(doc, "span", { class: "info", id: "pageInfo" });
    $.ltr = el(doc, "input", { type: "radio", name: "dir", id: "dir-ltr" });
    $.rtl = el(doc, "input", { type: "radio", name: "dir", id: "dir-rtl" });
    $.ltr.checked = !state.rtl;
    $.rtl.checked = state.rtl;
    $.rotL = el(doc, "button", { type: "button", id: "rotL", title: "Turn this page 90° anticlockwise", text: "↺ 90°" });
    $.rotR = el(doc, "button", { type: "button", id: "rotR", title: "Turn this page 90° clockwise", text: "↻ 90°" });

    $.groupAxis = el(doc, "div", { class: "group", id: "groupAxis" }, el(doc, "span", { class: "info", text: "Dividing line:" }),
      btn("axis-v", "│ Vertical", "Two pages side by side", "axis-v"), btn("axis-h", "─ Horizontal", "Two pages one above the other", "axis-h"));
    const header = el(doc, "header", {},
      el(doc, "div", { class: "group" }, $.prev, el(doc, "label", {}, "Page ", $.pageNo, ` of ${N}`), $.next, $.info),
      el(doc, "div", { class: "group" },
        btn("mode-split", "Split in two", "Cut this page into two pages", "mode-split"),
        btn("mode-single", "Crop only", "Keep one page, but crop (and optionally straighten or turn) it", "mode-single"),
        btn("mode-skip", "Leave as is", "Don't change this page", "mode-skip")),
      $.groupAxis,
      el(doc, "div", { class: "group" }, $.rotL, $.rotR),
      el(doc, "div", { class: "group" }, el(doc, "span", { class: "info", text: "Reading order:" }),
        el(doc, "label", {}, $.ltr, " left-to-right"), el(doc, "label", {}, $.rtl, " right-to-left")));

    $.canvas = el(doc, "canvas", { id: "canvas" });
    $.overlay = svg(doc, "svg", { id: "overlay" });
    $.msg = el(doc, "div", { id: "msg" });
    $.stage = el(doc, "div", { id: "stage" }, $.canvas, $.overlay, $.msg);
    $.main = el(doc, "main", {}, $.stage);

    $.numbers = el(doc, "div", { id: "numbers" });
    $.angle = el(doc, "input", { type: "range", id: "angle", min: -10, max: 10, step: 0.1, value: 0, "aria-label": "Straighten" });
    $.angleNum = el(doc, "input", { type: "number", id: "angleNum", min: -45, max: 45, step: 0.1, value: 0, "aria-label": "Straighten degrees" });
    $.angleReset = el(doc, "button", { type: "button", id: "angleReset", title: "Back to 0°", text: "0" });
    $.grid = el(doc, "input", { type: "checkbox", id: "grid" });
    // Radio buttons rather than a drop-down: HTML <select> pop-ups don't work reliably in Zotero's plain windows.
    const copyRadio = (value, text) => {
      const input = el(doc, "input", { type: "radio", name: "copyTarget", id: "copy-" + value, value });
      $["copy-" + value] = input;
      return el(doc, "label", { class: "opt" }, input, " " + text);
    };
    $.copyRange = el(doc, "input", { type: "text", id: "copyRange", placeholder: "e.g. 5-40, 52, odd, even", value: config.selection || "" });
    $.normalize = el(doc, "input", { type: "checkbox", id: "normalize" });
    $.copyBtn = el(doc, "button", { type: "button", id: "copyBtn", text: "Copy" });
    $.copyMsg = el(doc, "div", { class: "small", id: "copyMsg" });
    $.reset = el(doc, "button", { type: "button", id: "reset", text: "Reset this page" });

    const warnings = (config.warnings || []).map((w) => el(doc, "div", { class: "warn", text: w }));
    const aside = el(doc, "aside", {}, warnings,
      el(doc, "h2", { text: "This page" }), $.numbers,
      el(doc, "h2", { text: "Straighten (rotate a little)" }),
      el(doc, "div", { class: "row" }, $.angle, $.angleNum, " °", $.angleReset),
      el(doc, "div", { class: "row" }, el(doc, "label", {}, $.grid, " Show grid to judge it by")),
      el(doc, "div", { class: "row" }, $.reset),
      el(doc, "h2", { text: "Use this layout on other pages" }),
      copyRadio("all", "All pages"),
      copyRadio("landscape", "All landscape pages"),
      copyRadio("portrait", "All portrait pages"),
      copyRadio("some", "Only these pages:"),
      el(doc, "div", { class: "row" }, $.copyRange, $.copyBtn), $.copyMsg,
      el(doc, "h2", { text: "Whole document" }),
      el(doc, "div", { class: "row" }, el(doc, "label", {}, $.normalize, " Make all pages the same size")),
      el(doc, "p", { class: "small", text: "Pages are scaled slightly to match (never cropped), so small differences in trimming don't leave a jumble of sizes. Landscape and portrait pages are matched separately." }),
      el(doc, "p", { class: "small", text: "Drag the lines or corners. Edges that touch (like the spine) move together; hold Alt/Option to move just one. Positive straighten turns the page clockwise." }),
      ...(config.notes || []).map((n) => el(doc, "p", { class: "small", text: n })));
    $["copy-all"].checked = true;

    $.summary = el(doc, "div", { id: "summary" });
    $.error = el(doc, "span", { id: "error", role: "alert" });
    $.cancel = el(doc, "button", { type: "button", id: "cancel", text: "Cancel" });
    $.ok = el(doc, "button", { type: "button", id: "ok", text: "Apply" });
    const footer = el(doc, "footer", {}, $.summary, $.error, $.cancel, $.ok);

    doc.body.append(el(doc, "div", { class: "app" }, header, $.main, aside, footer));

    // ---- state -> UI
    const view = { w: 0, h: 0 };
    const dpr = () => win.devicePixelRatio || 1;

    function reflectMode() {
      const s = spec(state.cur);
      for (const k of ["split", "single", "skip"]) $["mode-" + k].setAttribute("aria-pressed", String(s.mode === k));
      $["axis-v"].setAttribute("aria-pressed", String(s.axis === "v"));
      $["axis-h"].setAttribute("aria-pressed", String(s.axis === "h"));
      $.groupAxis.style.display = s.mode === "split" ? "" : "none";
      const angle = Number(s.angle) || 0;
      $.angle.value = angle;
      if (doc.activeElement !== $.angleNum) $.angleNum.value = angle;
      const notes = [pages[state.cur].landscape ? "landscape" : "portrait"];
      notes.push(s.mode === "split" ? "will be split in two" : s.mode === "single" ? "will be cropped" : "unchanged");
      if (s.rotate) notes.push(`turned ${s.rotate}°`);
      if (angle) notes.push(`straightened ${angle}°`);
      $.info.textContent = notes.join(", ");
    }

    function summarise() {
      let splits = 0, crops = 0, turned = 0;
      for (let i = 0; i < N; i++) {
        const s = spec(i);
        if (s.mode === "split") splits++;
        else if (s.mode === "single") crops++;
        if (s.mode !== "skip" && (s.rotate || s.angle)) turned++;
      }
      const parts = [];
      if (splits) parts.push(`${splits} page${splits > 1 ? "s" : ""} will be split in two`);
      if (crops) parts.push(`${crops} cropped`);
      if (turned) parts.push(`${turned} turned or straightened`);
      if (state.normalize) parts.push("page sizes will be matched");
      const outside = countOutside();
      if (outside) parts.push(`${outside} comment${outside > 1 ? "s" : ""} would end up outside the kept area`);
      $.summary.className = outside ? "bad-note" : "";
      $.summary.textContent = parts.length ? parts.join(" · ") : "No changes yet";
      return { splits, crops };
    }

    const pageLabels = (s) => (s.axis === "h" ? ["Top page (1st)", "Bottom page (2nd)"] : state.rtl ? ["Right page (1st)", "Left page (2nd)"] : ["Left page (1st)", "Right page (2nd)"]);
    function renderNumbers() {
      const s = spec(state.cur);
      $.numbers.replaceChildren();
      s.rects.forEach((r, ri) => {
        const names = pageLabels(s);
        // rects are ordered left->right (or top->bottom); right-to-left books read the right one first
        const label = s.rects.length === 2 ? (s.axis === "v" && state.rtl ? names[1 - ri] : names[ri]) : "Page area";
        const box = el(doc, "div", { class: "rectbox" }, el(doc, "b", { text: label }));
        const grid = el(doc, "div", { class: "nums" });
        for (const [key, text] of [["u0", "Left"], ["v0", "Top"], ["u1", "Right"], ["v1", "Bottom"]]) {
          const input = el(doc, "input", { type: "number", step: 0.1, min: 0, max: 100, "data-ri": ri, "data-key": key, "aria-label": `${label} ${text}`, value: toPct(r[key]) });
          input.addEventListener("change", () => onNumber(ri, key, input));
          grid.append(el(doc, "label", {}, text, el(doc, "span", { class: "nowrap" }, input, " %")));
        }
        box.append(grid);
        $.numbers.append(box);
      });
    }
    function syncNumbers() {
      const s = spec(state.cur);
      const inputs = $.numbers.querySelectorAll("input");
      if (inputs.length !== s.rects.length * 4) return renderNumbers();
      for (const input of inputs) {
        input.classList.remove("bad");
        if (doc.activeElement !== input) input.value = toPct(s.rects[+input.getAttribute("data-ri")][input.getAttribute("data-key")]);
      }
    }
    function onNumber(ri, key, input) {
      const s = spec(state.cur);
      const val = Number(input.value) / 100;
      const r = s.rects[ri];
      const trial = { ...r, [key]: val };
      const ok = Number.isFinite(val) && input.value !== "" && val >= 0 && val <= 1 && trial.u1 - trial.u0 >= MIN && trial.v1 - trial.v0 >= MIN;
      input.classList.toggle("bad", !ok);
      if (!ok) return;
      if (s.mode === "skip") setMode(state.cur, "single");
      touch(state.cur);
      r[key] = val;
      // keep the shared edge together, like dragging does
      if (s.rects.length === 2) {
        const [a, b] = s.rects;
        if (s.axis === "v") {
          if (ri === 0 && key === "u1" && b.u0 < val && b.u1 - val >= MIN) b.u0 = val;
          if (ri === 1 && key === "u0" && a.u1 > val && val - a.u0 >= MIN) a.u1 = val;
        } else {
          if (ri === 0 && key === "v1" && b.v0 < val && b.v1 - val >= MIN) b.v0 = val;
          if (ri === 1 && key === "v0" && a.v1 > val && val - a.v0 >= MIN) a.v1 = val;
        }
      }
      refresh();
    }

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
    const insideKept = (s, c) => s.rects.some((k) => c[0] >= k.u0 - 0.002 && c[0] <= k.u1 + 0.002 && c[1] >= k.v0 - 0.002 && c[1] <= k.v1 + 0.002);
    function countOutside() {
      let n = 0;
      for (const key of Object.keys(config.annotations || {})) {
        const i = Number(key);
        const s = spec(i);
        if (s.mode === "skip") continue;
        for (const r of turnedAnnotations(i, s)) if (!insideKept(s, annCentre(i, s, r))) n++;
      }
      return n;
    }

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
      for (const r of s.rects) { const q = px(r); d += `M${q.x0} ${q.y0}H${q.x1}V${q.y1}H${q.x0}Z`; }
      $.overlay.append(svg(doc, "path", { d, "fill-rule": "evenodd", fill: "rgba(0,0,0,0.5)", "pointer-events": "none" }));

      // comments on this page, turned and straightened exactly like the page will be
      const anns = turnedAnnotations(state.cur, s);
      if (anns.length) {
        const angle = Number(s.angle) || 0;
        const g = svg(doc, "g", { "pointer-events": "none", "data-annotations": anns.length });
        if (angle) g.setAttribute("transform", `rotate(${angle} ${W / 2} ${H / 2})`);
        for (const r of anns) {
          const lost = s.mode !== "skip" && !insideKept(s, annCentre(state.cur, s, r));
          const q = px(r);
          g.append(svg(doc, "rect", {
            x: q.x0, y: q.y0, width: Math.max(2, q.x1 - q.x0), height: Math.max(2, q.y1 - q.y0),
            fill: lost ? "rgba(220,40,40,.30)" : "rgba(255,190,0,.32)", stroke: lost ? "#d12" : "#e69500", "stroke-width": 1.2,
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
        $.overlay.append(svg(doc, "rect", { x: q.x0, y: q.y0, width: q.x1 - q.x0, height: q.y1 - q.y0, fill: "none", stroke: "#1b6ef3", "stroke-width": 1.75, "pointer-events": "none" }));
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
      reflectMode();
      syncNumbers();
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
      const w = Math.min(availW, availH * aspect);
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
        active = client.render(state.cur + 1, Math.round(view.w * dpr()), rotate);
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

    function goTo(i) {
      state.cur = clamp(Math.round(i), 0, N - 1);
      $.pageNo.value = state.cur + 1;
      renderNumbers();
      reflectMode();
      renderPage();
    }

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
      if (!edge) return;
      e.preventDefault();
      const s = spec(state.cur);
      if (s.mode === "skip") setMode(state.cur, "single");
      touch(state.cur);
      const ri = +t.getAttribute("data-ri");
      const partners = {};
      for (const ch of edge) partners[ch] = e.altKey ? null : partnerOf(s, ri, ch);
      drag = { ri, edge, partners };
      reflectMode();
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
    const endDrag = () => { drag = null; };
    $.overlay.addEventListener("pointerup", endDrag);
    $.overlay.addEventListener("pointercancel", endDrag);

    // ---- controls
    $.prev.addEventListener("click", () => goTo(state.cur - 1));
    $.next.addEventListener("click", () => goTo(state.cur + 1));
    $.pageNo.addEventListener("change", () => {
      const n = Number($.pageNo.value);
      if (Number.isFinite(n) && n >= 1 && n <= N) goTo(n - 1);
      else $.pageNo.value = state.cur + 1;
    });
    for (const k of ["split", "single", "skip"]) {
      $["mode-" + k].addEventListener("click", () => {
        const hadRotation = spec(state.cur).rotate;
        setMode(state.cur, k);
        renderNumbers();
        refresh();
        if (hadRotation && k === "skip") renderPage(); // "leave as is" also undoes a turn
      });
    }
    for (const axis of ["v", "h"]) {
      $["axis-" + axis].addEventListener("click", () => { setAxis(state.cur, axis); renderNumbers(); refresh(); });
    }
    for (const [key, delta] of [["rotL", -90], ["rotR", 90]]) {
      $[key].addEventListener("click", () => {
        rotatePage(state.cur, delta);
        renderNumbers();
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
    $.angleReset.addEventListener("click", () => setAngle(0));
    $.grid.addEventListener("change", () => { state.grid = $.grid.checked; drawOverlay(); });
    const onDir = () => { state.rtl = $.rtl.checked; renderNumbers(); drawOverlay(); };
    $.ltr.addEventListener("change", onDir);
    $.rtl.addEventListener("change", onDir);
    $.reset.addEventListener("click", () => {
      const hadRotation = spec(state.cur).rotate;
      state.specs.set(state.cur, defaultSpec(state.cur));
      state.touched.delete(state.cur);
      renderNumbers();
      refresh();
      if (hadRotation) renderPage(); else paint();
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
      let done = 0, skipped = 0;
      for (const i of targets) {
        if (i === state.cur) continue;
        if (checkShape && src.mode !== "skip" && isLandscape(i, src.rotate) !== srcLandscape) { skipped++; continue; }
        state.specs.set(i, src.mode === "skip" ? baseSpec(i) : { mode: src.mode, rects: src.rects.map(cloneRect), rotate: src.rotate, axis: src.axis, angle: src.angle });
        touch(i);
        done++;
      }
      $.copyMsg.textContent = `Copied to ${done} page${done === 1 ? "" : "s"}` + (skipped ? ` (${skipped} with a different shape skipped)` : "") + ".";
      summarise();
    });
    $.normalize.addEventListener("change", () => { state.normalize = $.normalize.checked; summarise(); });

    $.cancel.addEventListener("click", () => finish(null));
    $.ok.addEventListener("click", () => {
      const counts = summarise();
      if (!counts.splits && !counts.crops && !state.normalize) {
        $.error.textContent = "Nothing to apply yet: change at least one page, or tick “Make all pages the same size”.";
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
      finish({ plan, rtl: state.rtl });
    });
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); finish(null); }
      else if (e.key === "PageDown" || (e.ctrlKey && e.key === "ArrowRight")) { e.preventDefault(); goTo(state.cur + 1); }
      else if (e.key === "PageUp" || (e.ctrlKey && e.key === "ArrowLeft")) { e.preventDefault(); goTo(state.cur - 1); }
    };
    let resizeTimer = null;
    const onResize = () => {
      win.clearTimeout(resizeTimer);
      resizeTimer = win.setTimeout(renderPage, 150);
    };
    doc.addEventListener("keydown", onKey);
    win.addEventListener("resize", onResize);

    renderNumbers();
    reflectMode();
    summarise();
    renderPage();

    return {
      state, goTo, refresh, spec, client, countOutside,
      destroy: () => {
        doc.removeEventListener("keydown", onKey);
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
