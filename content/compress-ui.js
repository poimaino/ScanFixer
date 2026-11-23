// Copyright (c) 2026 poimaino. MIT licence, see LICENSE in the repository root.
/* The "Compress" window: a separate step from fixing pages. It makes a smaller COPY of a PDF as black-and-white,
 * greyscale or (smaller) colour pages, and never touches the original.
 *
 *   ScanFixerCompressor.open(parentWindow, config) -> Promise<{ pages, settings } | null>
 *
 * config:
 *   title         window title
 *   pdfBytes      Uint8Array   the PDF to compress (pages are drawn exactly as they look now)
 *   pageCount     number
 *   fileSize      bytes of the PDF now (for the "was / will be" line)
 *   getWorkerSource()  async -> string   the render worker script (imageops + pdf.js + glue)
 *   pageBytes     [bytes per page today]   sets each page's size budget for "Keep pages smaller than before"
 *   batch         { remaining }  how many more PDFs follow this one; if > 0 the window offers "use these settings for the others"
 *   carry         { forms, links, bookmarks, labels }  what the file has besides pictures, for the notes under the settings
 *   comments      [{ key, page, points }]  where the file's comments are (PDF user-space points; page is 1-based), so
 *                 they can be moved onto the compressed pages; the window offers "Copy N comments" when there are any
 *
 * The suggestion (format, resolution) comes from looking at a few pages, is pre-selected, and can be changed freely;
 * a live preview of the page shown and a size estimate follow every change. Result `pages` are what
 * the worker returned per page, ready for ScanFixerCompress.build().
 * Depends on ScanFixerEditor (for the worker client) and ScanFixerCompress (for sizes).
 */
var ScanFixerCompressor = (function () {
  const HTML = "http://www.w3.org/1999/xhtml";
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const MODES = { bw: "Black & white", gray: "Greyscale", colour: "Colour" };
  const MODE_HINT = { bw: "Smallest. Best for text.", gray: "For pages with shading or pictures.", colour: "Keeps colour, just smaller." };
  const DPIS = [300, 200, 150, 120, 100];
  const BUDGET_SHARE = 0.8; // with "keep pages smaller", a page may use up to this share of the picture bytes it has now

  const CSS = `
    :root { color-scheme: light dark; --bg: #ffffff; --fg: #1d1d1f; --muted: rgba(0,0,0,.58); --panel: #eeeef1; --line: rgba(0,0,0,.18); --accent: #1b6ef3; --card: rgba(0,0,0,.035); --warn: #b35a00; }
    @media (prefers-color-scheme: dark) { :root { --bg: #28282b; --fg: #ececec; --muted: rgba(255,255,255,.62); --panel: #1b1b1d; --line: rgba(255,255,255,.2); --card: rgba(255,255,255,.05); --warn: #f0a24a; } }
    [hidden] { display: none !important; }
    html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); }
    body { font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
    button, input { font: inherit; }
    .app { display: grid; grid-template-columns: minmax(0, 1fr) 300px; grid-template-rows: auto minmax(0, 1fr) auto; height: 100%; }
    header { grid-column: 1 / -1; display: flex; align-items: center; gap: 16px; padding: 7px 12px; border-bottom: 1px solid var(--line); }
    header .grow { flex: 1; }
    .group { display: flex; align-items: center; gap: 6px; }
    #pageNo { width: 52px; text-align: right; }
    .info { color: var(--muted); white-space: nowrap; }
    button { padding: 3px 11px; }
    .toggle[aria-pressed=true] { background: var(--accent); color: #fff; border-color: var(--accent); }
    .pair { display: flex; }
    .pair button:first-child { border-top-right-radius: 0; border-bottom-right-radius: 0; }
    .pair button:last-child { border-top-left-radius: 0; border-bottom-left-radius: 0; margin-left: -1px; }
    .centre { position: relative; min-width: 0; min-height: 0; display: grid; }
    .centre > * { grid-area: 1 / 1; min-width: 0; min-height: 0; }
    .app.grid .pageonly { display: none !important; }
    #zoomLbl { min-width: 46px; text-align: center; }
    main { position: relative; overflow: auto; background: var(--panel); min-height: 240px; }
    main.fit { display: flex; align-items: center; justify-content: center; overflow: hidden; }
    #canvas { background: #fff; box-shadow: 0 1px 8px rgba(0,0,0,.3); display: block; margin: 12px auto; }
    main.fit #canvas { margin: 0; max-width: calc(100% - 24px); max-height: calc(100% - 24px); }
    #msg { position: absolute; top: 10px; left: 50%; transform: translateX(-50%); padding: 3px 12px; border-radius: 12px; background: var(--bg); color: var(--muted); box-shadow: 0 1px 4px rgba(0,0,0,.25); pointer-events: none; }
    aside { border-left: 1px solid var(--line); padding: 12px; overflow: auto; background: var(--bg); display: flex; flex-direction: column; gap: 12px; }
    .field > .cap { display: block; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 0 0 4px; }
    .seg { display: flex; border: 1px solid var(--line); border-radius: 7px; overflow: hidden; }
    .seg label { position: relative; flex: 1; display: block; border-left: 1px solid var(--line); }
    .seg label:first-child { border-left: 0; }
    .seg input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
    .seg span { display: block; padding: 5px 4px; text-align: center; white-space: nowrap; pointer-events: none; }
    .seg input:checked + span { background: var(--accent); color: #fff; font-weight: 600; }
    .seg input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: -2px; }
    .seg input:disabled + span { opacity: .4; }
    .seg.over label.cap span { opacity: .5; }
    .seg + .seg { margin-top: 5px; }
    .hint { font-size: 12px; color: var(--muted); margin: 4px 0 0; }
    .suggest { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid var(--accent); border-radius: 7px; }
    .suggest div { flex: 1; min-width: 0; }
    .suggest button { padding: 2px 10px; }
    .slider { display: flex; align-items: center; gap: 8px; }
    .slider .name { width: 58px; color: var(--muted); }
    .slider input[type=range] { flex: 1; min-width: 0; }
    .slider .val { width: 26px; text-align: right; font-variant-numeric: tabular-nums; }
    .checks label { display: flex; align-items: center; gap: 7px; margin: 3px 0; }
    .checks label.off { opacity: .45; }
    .result { margin-top: auto; border: 1px solid var(--line); border-radius: 8px; padding: 9px 11px; background: var(--card); }
    .result .big { font-size: 20px; font-weight: 650; line-height: 1.2; }
    .result .sub { color: var(--muted); }
    .result .bad { color: var(--warn); font-weight: 600; }
    .foot { font-size: 11.5px; color: var(--muted); margin: 6px 0 0; }
    .foot.warn { color: var(--warn); }
    footer { grid-column: 1 / -1; display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-top: 1px solid var(--line); }
    #summary { flex: 1; color: var(--muted); }
    #error { color: #d12; font-weight: 600; }
    progress { width: 220px; }
    #ok { font-weight: 600; }
    #loading { display: flex; align-items: center; justify-content: center; height: 100%; font-size: 14px; }
  ` + (typeof ScanFixerThumbs !== "undefined" ? ScanFixerThumbs.CSS : "");

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

  /** What the copy keeps and what it flattens, as short notes. `carry` is ScanFixerCompress.inspect()'s answer (or null). */
  function carryNotes(carry) {
    const out = [];
    if (!carry) return out;
    const kept = [carry.links && `${carry.links} link${carry.links > 1 ? "s" : ""}`, carry.bookmarks && "bookmarks", carry.labels && "page numbers"].filter(Boolean);
    if (kept.length) out.push({ text: `Kept in the copy: ${kept.join(", ")} (links and bookmarks to pages you remove are dropped).` });
    if (carry.forms) out.push({ warn: true, text: `This file has form fields. In the copy they become flat: what was filled in stays visible but can't be edited.` });
    return out;
  }

  function build(doc, win, config, client, finish) {
    const N = config.pageCount;
    const batchLeft = (config.batch && config.batch.remaining) || 0;
    const human = ScanFixerCompress.humanSize;
    const known = (config.pageBytes || []).filter((n) => n > 0);
    const avgBytes = known.length ? known.reduce((a, b) => a + b, 0) / known.length : (config.fileSize || 0) / Math.max(1, N);
    const S = {
      cur: 0, view: "result", zoom: null, // zoom: null = fit the window, otherwise a factor of the picture's own pixels
      removed: new Set(), pageMode: new Map(), grid: false, sample: null, // pages taken out of the copy; thumbnail view on; { bytes, n } measured so far
      mode: "gray", dpi: 200, quality: 60, sensitivity: 0, flatten: true, text: true, copyComments: true, limit: true,
      sourceDpi: 0, suggestion: null,
      result: null, orig: null, // ImageBitmaps for the page shown
      estimate: null, // { thisPage, total, squeezed }
      running: null, // { stop }
      token: 0,
    };

    doc.title = config.title;
    const style = el(doc, "style");
    style.textContent = CSS;
    (doc.head || doc.documentElement).append(style);
    doc.body.replaceChildren();

    const $ = {};
    /** A segmented control: one real radio per segment (kept focusable, drawn as a button). */
    const segment = (group, items, cls) =>
      el(doc, "div", { class: "seg" + (cls ? " " + cls : ""), role: "radiogroup" },
        items.map(([value, text, id, title]) => {
          $[id] = el(doc, "input", { type: "radio", name: group, value, id });
          return el(doc, "label", { id: id + "-label", title }, $[id], el(doc, "span", { text }));
        }));
    const check = (key, text, title, checked = true) => {
      $[key] = el(doc, "input", { type: "checkbox", id: key });
      $[key].checked = checked;
      return el(doc, "label", { title, id: key + "-row" }, $[key], el(doc, "span", { text }));
    };

    // header
    $.prev = el(doc, "button", { type: "button", text: "◀", title: "Previous page" });
    $.next = el(doc, "button", { type: "button", text: "▶", title: "Next page" });
    $.pageNo = el(doc, "input", { type: "number", id: "pageNo", min: 1, max: N, value: 1 });
    $.viewOrig = el(doc, "button", { type: "button", id: "viewOrig", class: "toggle", text: "Before", "aria-pressed": "false", title: "The page as it is now" });
    $.viewResult = el(doc, "button", { type: "button", id: "viewResult", class: "toggle", text: "After", "aria-pressed": "true", title: "The page as it will be" });
    $.zoomOut = el(doc, "button", { type: "button", id: "zoomOut", text: "−", title: "Zoom out (Ctrl/Cmd −)" });
    $.zoomIn = el(doc, "button", { type: "button", id: "zoomIn", text: "+", title: "Zoom in (Ctrl/Cmd +, or Ctrl/Cmd + scroll)" });
    $.zoomLbl = el(doc, "button", { type: "button", id: "zoomLbl", text: "Fit", title: "Fit the page to the window (Ctrl/Cmd 0)" });
    $.zoom100 = el(doc, "button", { type: "button", id: "zoom100", text: "100%", title: "Show the picture pixel for pixel" });
    $.rm = el(doc, "button", { type: "button", id: "rmPage", class: "toggle", text: "Remove page", "aria-pressed": "false", title: "Leave this page out of the compressed copy (or bring it back)" });
    $.vPage = el(doc, "button", { type: "button", id: "vPage", class: "toggle", text: "Page", "aria-pressed": "true", title: "One page at a time" });
    $.vGrid = el(doc, "button", { type: "button", id: "vGrid", class: "toggle", text: "Thumbnails", "aria-pressed": "false", title: "Thumbnails of every page: select and remove pages" });
    $.info = el(doc, "span", { class: "info", id: "info" });
    const header = el(doc, "header", {},
      el(doc, "div", { class: "pair" }, $.vPage, $.vGrid),
      el(doc, "div", { class: "group pageonly" }, $.prev, el(doc, "label", {}, $.pageNo, ` / ${N}`), $.next),
      el(doc, "div", { class: "pair pageonly" }, $.viewOrig, $.viewResult),
      el(doc, "div", { class: "group pageonly" }, el(doc, "div", { class: "pair" }, $.zoomOut, $.zoomLbl, $.zoomIn), $.zoom100),
      el(doc, "div", { class: "group pageonly" }, $.rm),
      el(doc, "span", { class: "grow" }), $.info);

    // preview
    $.canvas = el(doc, "canvas", { id: "canvas", width: 10, height: 10 });
    $.msg = el(doc, "div", { id: "msg", text: "Looking at your pages…" });
    $.main = el(doc, "main", { class: "fit" }, $.canvas, $.msg);
    $.centre = el(doc, "div", { class: "centre" }, $.main);

    // sidebar
    $.suggestText = el(doc, "div", { id: "suggestText", text: "Looking at a few pages…" });
    $.useSuggestion = el(doc, "button", { type: "button", id: "useSuggestion", text: "Use" });
    $.suggest = el(doc, "div", { class: "suggest", id: "suggest" }, $.suggestText, $.useSuggestion);
    $.hint = el(doc, "p", { class: "hint", id: "modeHint" });
    $.dpiNote = el(doc, "p", { class: "hint", id: "dpiNote" });
    const sliderRow = (id, name, min, max, step, value) => {
      $[id] = el(doc, "input", { type: "range", id, min, max, step, value });
      $[id + "Val"] = el(doc, "span", { class: "val", id: id + "Val", text: String(value) });
      return el(doc, "div", { class: "slider", id: id + "Row" }, el(doc, "span", { class: "name", text: name }), $[id], $[id + "Val"]);
    };
    const commentCount = (config.comments || []).length;

    $.detect = el(doc, "button", { type: "button", id: "detectPages", text: "Suggest for each page", title: "Look at every page and give photo plates, text pages and so on their own format" });
    $.detectNote = el(doc, "p", { class: "hint", id: "detectNote", hidden: true });
    const aside = el(doc, "aside", {},
      $.suggest,
      el(doc, "div", { class: "field" }, $.detect, $.detectNote),
      el(doc, "div", { class: "field" }, el(doc, "span", { class: "cap", text: "Format" }),
        segment("mode", [["bw", "B&W", "mode-bw", "Black and white: the smallest files, best for text"], ["gray", "Greyscale", "mode-gray", "Shades of grey: for shading or pictures"], ["colour", "Colour", "mode-colour", "Keep colour, just smaller"]]), $.hint),
      $.pageField = el(doc, "div", { class: "field pageonly", id: "pageField" }, el(doc, "span", { class: "cap", text: "Just this page" }),
        $.pageMode = el(doc, "select", { id: "pageMode", title: "Give this page its own format, e.g. colour for a photo plate in a black-and-white book" },
          el(doc, "option", { value: "", text: "Same as the rest" }),
          ...Object.keys(MODES).map((m) => el(doc, "option", { value: m, text: MODES[m] })))),
      el(doc, "div", { class: "field" }, el(doc, "span", { class: "cap", text: "Resolution (dpi)" }),
        segment("dpi", DPIS.map((d) => [String(d), String(d), "dpi-" + d, d + " dpi"]), "dpis"),
        segment("dpi", [["0", "As scanned", "dpi-0", "Keep the scan's own resolution"]]), $.dpiNote),
      el(doc, "div", { class: "field sliders" },
        sliderRow("quality", "Quality", 20, 90, 5, S.quality),
        sliderRow("sens", "Darkness", -30, 30, 2, 0)),
      el(doc, "div", { class: "checks" },
        check("flatten", "Clean background", "Even out shadows and whiten the paper"),
        check("text", "Keep text searchable", "Carry over the page's text layer as invisible text (any language)"),
        check("limit", "Keep pages smaller than before", "Lower quality, then resolution, on any page that would come out larger"),
        batchLeft ? check("applyAll", `Use these settings for the other ${batchLeft} PDF${batchLeft > 1 ? "s" : ""}`, "No more windows: the others are compressed the same way (mode, resolution, quality), one after another, each saved as soon as it is done", false) : null,
        commentCount ? check("copyComments", `Copy ${commentCount} comment${commentCount > 1 ? "s" : ""}`, "Put your comments on the new file too (the original keeps its own)") : null),
      el(doc, "div", { class: "result" }, el(doc, "div", { id: "est", text: "…" })),
      ...carryNotes(config.carry).map((n) => el(doc, "p", { class: "foot" + (n.warn ? " warn" : ""), text: n.text })),
      el(doc, "p", { class: "foot", text: "Saved as a new “… (compressed)” copy. The original is not changed." }));
    $.est = doc.getElementById("est") || $.est;

    $.summary = el(doc, "div", { id: "summary" });
    $.progress = el(doc, "progress", { id: "progress", max: 100, value: 0, style: "display:none" });
    $.error = el(doc, "span", { id: "error", role: "alert" });
    $.cancel = el(doc, "button", { type: "button", id: "cancel", text: "Cancel" });
    $.ok = el(doc, "button", { type: "button", id: "ok", text: "Compress" });
    $.app = el(doc, "div", { class: "app" }, header, $.centre, aside, el(doc, "footer", {}, $.summary, $.progress, $.error, $.cancel, $.ok));
    doc.body.append($.app);
    $.est = doc.getElementById("est");

    // ---------------------------------------------------------------- settings <-> UI
    const effectiveDpi = () => (S.dpi > 0 ? S.dpi : S.sourceDpi || 300);
    const settings = () => ({
      mode: S.mode, dpi: effectiveDpi(), maxDpi: S.sourceDpi || 0, minDpi: 100,
      quality: S.quality, sensitivity: S.sensitivity, flatten: S.flatten && S.mode !== "colour", text: S.text,
    });
    /** Settings for page `i` (0-based): the window's own, with this page's format if the person chose one. */
    const settingsFor = (i) => {
      const mode = S.pageMode.get(i) || S.mode;
      return { ...settings(), mode, flatten: S.flatten && mode !== "colour" };
    };
    const SHORT = { bw: "B&W", gray: "Grey", colour: "Colour" };
    /** How many bytes page `i` (0-based) may use, or 0 for no limit. */
    const pageOnly = (i) => { const f = settingsFor(i); return { mode: f.mode, flatten: f.flatten }; };
    const budgetFor = (i) => (S.limit ? Math.round(((config.pageBytes || [])[i] || avgBytes) * BUDGET_SHARE) : 0);
    const describe = (s) => `${MODES[s.mode]} · ${s.dpi} dpi`;
    const keptList = () => Array.from({ length: N }, (_, i) => i).filter((i) => !S.removed.has(i));

    function reflect() {
      for (const m of Object.keys(MODES)) $["mode-" + m].checked = S.mode === m;
      for (const d of DPIS) $["dpi-" + d].checked = S.dpi === d;
      $["dpi-0"].checked = S.dpi === 0;
      $["dpi-0"].disabled = !S.sourceDpi;
      doc.getElementById("dpi-0-label").querySelector("span").textContent = S.sourceDpi ? `As scanned (${Math.round(S.sourceDpi)})` : "As scanned";
      const seg = doc.querySelector(".dpis");
      DPIS.forEach((d) => doc.getElementById("dpi-" + d + "-label").classList.toggle("cap", !!S.sourceDpi && d > S.sourceDpi + 10));
      seg.classList.toggle("over", !!S.sourceDpi);
      const bw = S.mode === "bw", colour = S.mode === "colour";
      doc.getElementById("qualityRow").hidden = bw;
      doc.getElementById("sensRow").hidden = !bw;
      $.qualityVal.textContent = String(S.quality);
      $.sensVal.textContent = (S.sensitivity > 0 ? "+" : "") + S.sensitivity;
      $.flatten.disabled = colour;
      doc.getElementById("flatten-row").classList.toggle("off", colour);
      $.hint.textContent = MODE_HINT[S.mode];
      const over = S.sourceDpi && S.dpi > S.sourceDpi + 10;
      $.dpiNote.textContent = over ? `Limited to the scan's own ~${Math.round(S.sourceDpi)} dpi.` : "";
      $.dpiNote.hidden = !over;
      $.viewResult.setAttribute("aria-pressed", String(S.view === "result"));
      $.viewOrig.setAttribute("aria-pressed", String(S.view === "original"));
      $.zoomLbl.textContent = S.zoom === null ? "Fit" : Math.round(S.zoom * 100) + "%";
      $.zoomOut.disabled = S.zoom !== null && S.zoom <= 0.1;
      $.zoomIn.disabled = S.zoom !== null && S.zoom >= 8;
      $.main.className = S.zoom === null ? "fit" : "";
      $.pageNo.value = S.cur + 1;
      $.pageMode.value = S.pageMode.get(S.cur) || "";
      const gone = S.removed.has(S.cur);
      $.rm.textContent = gone ? "Restore page" : "Remove page";
      $.rm.setAttribute("aria-pressed", String(gone));
      showRemovedBanner();
      reflectSummary();
    }
    function showRemovedBanner() {
      const gone = S.removed.has(S.cur);
      $.canvas.style.opacity = gone ? "0.4" : "";
      if (gone) { $.msg.textContent = "This page will be left out"; $.msg.style.display = ""; }
      else if ($.msg.textContent === "This page will be left out") { $.msg.textContent = ""; $.msg.style.display = "none"; }
    }
    function reflectSummary() {
      if (S.running) return;
      const n = S.removed.size;
      const own = Array.from(S.pageMode.keys()).filter((i) => !S.removed.has(i)).length;
      $.summary.textContent = [n ? `${n} page${n > 1 ? "s" : ""} removed · ${N - n} will be compressed` : "", own ? `${own} page${own > 1 ? "s" : ""} with their own format` : ""].filter(Boolean).join(" · ");
    }
    function showSuggestion() {
      const g = S.suggestion;
      if (!g) return;
      $.suggestText.textContent = `Suggested: ${describe(g)}`;
      $.suggest.title = `Because ${g.why}.`;
      $.useSuggestion.disabled = g.mode === S.mode && g.dpi === S.dpi;
    }

    // ---------------------------------------------------------------- preview + estimate
    const wait = (ms) => new Promise((r) => win.setTimeout(r, ms));
    let timer = null, activeIds = [];
    const requestPage = (page, extra) => {
      const r = client.compress(page, { ...settingsFor(page - 1), budget: budgetFor(page - 1), ...extra });
      activeIds.push(r.id);
      return r.promise;
    };
    function draw() {
      const bmp = S.view === "original" ? S.orig : S.result;
      if (!bmp) return;
      $.canvas.width = bmp.width;
      $.canvas.height = bmp.height;
      const ctx = $.canvas.getContext("2d");
      ctx.drawImage(bmp, 0, 0);
      if (S.zoom !== null) { $.canvas.style.width = Math.round(bmp.width * S.zoom) + "px"; $.canvas.style.height = Math.round(bmp.height * S.zoom) + "px"; }
      else { $.canvas.style.width = ""; $.canvas.style.height = ""; }
      $.canvas.style.imageRendering = S.zoom !== null && S.zoom > 1 ? "pixelated" : "";
    }
    function updateEstimateText() {
      const e = S.estimate;
      if (!e) { $.est.replaceChildren(el(doc, "div", { class: "sub", text: "Working it out…" })); return; }
      const now = config.fileSize || 0;
      const smaller = now && e.total < now;
      $.est.replaceChildren(...[
        el(doc, "div", { class: "big", text: "≈ " + human(e.total) }),
        now ? el(doc, "div", { class: smaller ? "sub" : "bad", text: smaller ? `was ${human(now)} · ${Math.round((1 - e.total / now) * 100)}% smaller` : `was ${human(now)} · not smaller` }) : null,
        e.squeezed ? el(doc, "div", { class: "sub", text: "Some pages are lowered to stay smaller." }) : null,
      ].filter(Boolean));
    }
    /** The size estimate from the pages measured so far, for the pages that are being kept. */
    function reestimate() {
      const m = S.sample;
      if (!m) return;
      const kept = keptList().length;
      S.estimate = { thisPage: m.thisPage, total: kept ? ScanFixerCompress.estimateTotal(m.bytes, m.n, kept) : 0, squeezed: m.squeezed };
      updateEstimateText();
    }
    async function refreshPreview() {
      S.sample = null;
      const token = ++S.token;
      for (const id of activeIds) client.cancel(id);
      activeIds = [];
      S.estimate = null;
      updateEstimateText();
      $.msg.textContent = "Making a preview…";
      $.msg.style.display = "";
      const i = S.cur;
      try {
        const r = await requestPage(i + 1, { preview: true, text: false });
        if (token !== S.token) { if (r.bmp && r.bmp.close) r.bmp.close(); return; }
        if (S.result && S.result.close) S.result.close();
        S.result = r.bmp;
        if (S.orig && S.orig.close) S.orig.close();
        S.orig = null;
        $.info.textContent = `${r.w} × ${r.h} px · ${r.dpi} dpi · ${human(r.bytes.byteLength)}`;
        $.msg.style.display = "none";
        showRemovedBanner();
        if (S.view === "result") draw();
        // measure a few other pages to estimate the whole file
        let bytes = r.bytes.byteLength, n = 1, squeezed = !!r.squeezed;
        const keptNow = keptList();
        const others = Array.from(new Set([keptNow[Math.round(keptNow.length / 3)], keptNow[Math.round((2 * keptNow.length) / 3)]])).filter((k) => k !== undefined && k !== i);
        S.sample = { bytes, n, thisPage: r.bytes.byteLength, squeezed };
        reestimate();
        for (const k of others) {
          const o = await requestPage(k + 1, { text: false });
          if (token !== S.token) return;
          bytes += o.bytes.byteLength; n++; squeezed = squeezed || !!o.squeezed;
          S.sample = { bytes, n, thisPage: r.bytes.byteLength, squeezed };
          reestimate();
        }
        if (S.view === "original") await loadOriginal(token);
      } catch (e) {
        if (token !== S.token || e.cancelled) return;
        $.msg.textContent = "Couldn't make a preview (" + (e.message || e) + ")";
      }
    }
    async function loadOriginal(token) {
      if (!S.result) return;
      if (!S.orig) {
        const { promise } = client.render(S.cur + 1, S.result.width, 0);
        const r = await promise;
        if (token !== undefined && token !== S.token) { if (r.bmp && r.bmp.close) r.bmp.close(); return; }
        S.orig = r.bmp;
      }
      draw();
    }
    const scheduleRefresh = () => { win.clearTimeout(timer); timer = win.setTimeout(refreshPreview, 350); };
    let edited = false; // has the person changed a setting or taken a page out? (Cancel then asks first)
    const changed = () => { edited = true; reflect(); showSuggestion(); scheduleRefresh(); };
    /** Cancel / Escape when nothing is running: ask first if there are choices to lose. */
    const requestCancel = () => {
      if (S.running) { S.running.stop = true; return; }
      if (detecting) detecting.stop = true;
      if (edited && !win.confirm("Discard your settings?\n\nNo compressed copy has been made yet.")) return;
      finish(null);
    };

    // ---------------------------------------------------------------- events
    for (const m of Object.keys(MODES)) $["mode-" + m].addEventListener("change", () => {
      S.mode = m;
      for (const [i, v] of Array.from(S.pageMode)) if (v === m) S.pageMode.delete(i);
      thumbs.refresh();
      changed();
    });
    for (const d of DPIS) $["dpi-" + d].addEventListener("change", () => { S.dpi = d; changed(); });
    $["dpi-0"].addEventListener("change", () => { S.dpi = 0; changed(); });
    $.quality.addEventListener("input", () => { S.quality = Number($.quality.value); changed(); });
    $.sens.addEventListener("input", () => { S.sensitivity = Number($.sens.value); changed(); });
    $.flatten.addEventListener("change", () => { S.flatten = $.flatten.checked; changed(); });
    $.limit.addEventListener("change", () => { S.limit = $.limit.checked; changed(); });
    $.text.addEventListener("change", () => { S.text = $.text.checked; edited = true; reflect(); });
    if ($.copyComments) $.copyComments.addEventListener("change", () => { S.copyComments = $.copyComments.checked; edited = true; });
    $.useSuggestion.addEventListener("click", () => {
      if (!S.suggestion) return;
      S.mode = S.suggestion.mode;
      S.dpi = S.suggestion.dpi;
      changed();
    });
    const go = (i) => { S.cur = clamp(Math.round(i), 0, N - 1); S.view = "result"; reflect(); refreshPreview(); };
    $.prev.addEventListener("click", () => go(S.cur - 1));
    $.next.addEventListener("click", () => go(S.cur + 1));
    $.pageNo.addEventListener("change", () => { const n = Number($.pageNo.value); if (Number.isFinite(n) && n >= 1 && n <= N) go(n - 1); else reflect(); });
    $.viewResult.addEventListener("click", () => { S.view = "result"; reflect(); draw(); });
    $.viewOrig.addEventListener("click", async () => { S.view = "original"; reflect(); await loadOriginal(); });
    // zoom: Fit, or any factor of the picture's pixels
    const zoomNow = () => (S.zoom !== null ? S.zoom : ($.canvas.clientWidth && $.canvas.width ? $.canvas.clientWidth / $.canvas.width : 1));
    const zoomTo = (z) => { S.zoom = z === null ? null : Math.min(8, Math.max(0.1, Math.round(z * 100) / 100)); reflect(); draw(); };
    $.zoomIn.addEventListener("click", () => zoomTo(zoomNow() * 1.25));
    $.zoomOut.addEventListener("click", () => zoomTo(zoomNow() / 1.25));
    $.zoomLbl.addEventListener("click", () => zoomTo(null));
    $.zoom100.addEventListener("click", () => zoomTo(1));
    $.main.addEventListener("wheel", (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      zoomTo(zoomNow() * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    }, { passive: false });

    // removing pages: one at a time, or several picked in the thumbnails
    function setRemoved(ids, flag) {
      if (S.running) return;
      edited = true;
      for (const i of ids) { if (flag) S.removed.add(i); else S.removed.delete(i); }
      reflect();
      reestimate();
      thumbs.refresh();
      $.error.textContent = "";
    }
    function setPageMode(ids, mode) {
      if (S.running) return;
      edited = true;
      for (const i of ids) { if (mode && mode !== S.mode) S.pageMode.set(i, mode); else S.pageMode.delete(i); }
      reflect();
      thumbs.refresh();
      showSuggestion();
      scheduleRefresh();
    }
    /** Look at the pages one by one; the commonest suggestion becomes the window's format, the others get their own. */
    let detecting = null;
    async function detectPages() {
      if (detecting) { detecting.stop = true; return; }
      if (S.running) return;
      const run = (detecting = { stop: false });
      const list = keptList();
      const found = new Map();
      $.detect.textContent = "Stop";
      $.detectNote.hidden = false;
      $.error.textContent = "";
      try {
        for (let k = 0; k < list.length && !run.stop; k++) {
          $.detectNote.textContent = `Looking at page ${list[k] + 1} (${k + 1} of ${list.length})…`;
          const { samples, dpi } = await client.sample([list[k] + 1], 800).promise;
          if (run.stop) break;
          found.set(list[k], suggestFor(samples, dpi).mode);
        }
      } catch (e) {
        if (!e.cancelled) $.error.textContent = "Couldn't look at every page (" + (e.message || e) + ")";
      }
      detecting = null;
      $.detect.textContent = "Suggest for each page";
      if (!found.size) { $.detectNote.hidden = true; return; }
      const tally = {};
      for (const m of found.values()) tally[m] = (tally[m] || 0) + 1;
      const common = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0];
      edited = true;
      S.mode = common;
      for (const [i, m] of found) { if (m === common) S.pageMode.delete(i); else S.pageMode.set(i, m); }
      const odd = found.size - tally[common];
      $.detectNote.textContent = `${run.stop ? "Stopped early: " : ""}${MODES[common]} for most pages${odd ? `, ${odd} page${odd > 1 ? "s" : ""} different` : ""}. Change any of them below.`;
      reflect();
      thumbs.refresh();
      showSuggestion();
      scheduleRefresh();
    }
    $.detect.addEventListener("click", detectPages);
    $.pageMode.addEventListener("change", () => setPageMode([S.cur], $.pageMode.value));
    $.rm.addEventListener("click", () => setRemoved([S.cur], !S.removed.has(S.cur)));
    const tbBtn = (id, text, title) => el(doc, "button", { type: "button", id, text, title });
    const tbRemove = tbBtn("tbRemove", "Remove", "Leave the selected pages out of the compressed copy (Delete)");
    const tbRestore = tbBtn("tbRestore", "Restore", "Bring the selected pages back");
    const tbMode = {};
    for (const m of Object.keys(MODES)) tbMode[m] = tbBtn("tbMode-" + m, SHORT[m], `Compress the selected pages as ${MODES[m]}`);
    const tbSame = tbBtn("tbModeSame", "Same", "Give the selected pages the window's own format again");
    const thumbs = ScanFixerThumbs.create(doc, win, client, {
      count: N,
      reorder: false,
      order: () => Array.from({ length: N }, (_, i) => i),
      info: (i) => ({ removed: S.removed.has(i), rects: [], rotate: 0, tags: S.removed.has(i) ? ["removed"] : S.pageMode.has(i) ? [SHORT[S.pageMode.get(i)]] : [] }),
      onChange: () => { const none = thumbs.selected().length === 0; for (const b of [tbRemove, tbRestore, tbSame, ...Object.values(tbMode)]) b.disabled = none; },
      onOpen: (i) => { S.cur = i; setGrid(false); go(i); },
      actions: [tbRemove, tbRestore, ...Object.values(tbMode), tbSame],
    });
    for (const b of [tbRemove, tbRestore, tbSame, ...Object.values(tbMode)]) b.disabled = true;
    thumbs.el.hidden = true;
    $.centre.append(thumbs.el);
    tbRemove.addEventListener("click", () => setRemoved(thumbs.selected(), true));
    tbRestore.addEventListener("click", () => setRemoved(thumbs.selected(), false));
    for (const m of Object.keys(MODES)) tbMode[m].addEventListener("click", () => setPageMode(thumbs.selected(), m));
    tbSame.addEventListener("click", () => setPageMode(thumbs.selected(), ""));
    function setGrid(on) {
      S.grid = on;
      $.app.classList.toggle("grid", on);
      $.main.hidden = on;
      thumbs.el.hidden = !on;
      $.vPage.setAttribute("aria-pressed", String(!on));
      $.vGrid.setAttribute("aria-pressed", String(on));
      if (on) { thumbs.layout(); thumbs.scrollTo(S.cur); }
    }
    $.vPage.addEventListener("click", () => setGrid(false));
    $.vGrid.addEventListener("click", () => setGrid(true));
    $.cancel.addEventListener("click", requestCancel);
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); requestCancel(); }
      else if (S.grid) {
        if (thumbs.handleKey(e)) return;
        const typing = e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName || "") && !["checkbox", "radio", "range", "button"].includes(e.target.type);
        if ((e.key === "Delete" || e.key === "Backspace") && !typing && thumbs.selected().length) {
          e.preventDefault();
          const ids = thumbs.selected();
          setRemoved(ids, !ids.every((i) => S.removed.has(i)));
        }
      }
      else if ((e.ctrlKey || e.metaKey) && (e.key === "+" || e.key === "=")) { e.preventDefault(); zoomTo(zoomNow() * 1.25); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === "-" || e.key === "_")) { e.preventDefault(); zoomTo(zoomNow() / 1.25); }
      else if ((e.ctrlKey || e.metaKey) && e.key === "0") { e.preventDefault(); zoomTo(null); }
      else if (e.key === "PageDown") { e.preventDefault(); go(S.cur + 1); }
      else if (e.key === "PageUp") { e.preventDefault(); go(S.cur - 1); }
    };
    doc.addEventListener("keydown", onKey);

    $.ok.addEventListener("click", async () => {
      if (S.running) return;
      S.token++; // forget previews in flight
      for (const id of activeIds) client.cancel(id);
      activeIds = [];
      win.clearTimeout(timer);
      const kept = keptList();
      if (!kept.length) { $.error.textContent = "Every page is removed: nothing would be left."; return; }
      const run = (S.running = { stop: false });
      const cfg = settings();
      for (const e of Array.from(aside.querySelectorAll("input, button, select"))) e.disabled = true;
      for (const e of Array.from(header.querySelectorAll("button"))) e.disabled = true;
      for (const e of Array.from(thumbs.el.querySelectorAll("button"))) e.disabled = true;
      $.ok.disabled = true;
      $.cancel.textContent = "Stop";
      $.cancel.disabled = false;
      $.progress.style.display = "";
      $.error.textContent = "";
      const pages = [];
      let bytes = 0, squeezed = 0, over = 0;
      try {
        for (let k = 0; k < kept.length; k++) {
          const i = kept[k];
          if (run.stop) break;
          $.summary.textContent = `Page ${k + 1} of ${kept.length} · ${human(bytes)} so far`;
          $.progress.value = (k / kept.length) * 100;
          const r = await client.compress(i + 1, { ...cfg, ...pageOnly(i), budget: budgetFor(i) }).promise;
          pages.push(r);
          bytes += r.bytes.byteLength;
          if (r.squeezed) squeezed++;
          if (r.overBudget) over++;
        }
      } catch (e) {
        $.error.textContent = "Stopped: " + (e.message || e);
        run.stop = true;
      }
      S.running = null;
      if (run.stop) {
        finish(null);
        return;
      }
      // where do the comments land on the new pages? pdf.js knows how each page is shown (crop box, rotation)
      const mapped = {};
      if (S.copyComments && (config.comments || []).length) {
        try {
          $.summary.textContent = "Placing your comments…";
          for (const rq of config.comments) if (!S.removed.has(rq.page - 1)) mapped[rq.key] = (await client.mapPoints(rq.page, rq.points).promise).points;
        } catch (e) {
          $.error.textContent = "Couldn't place the comments (" + (e.message || e) + "); the file will be made without them.";
          for (const k of Object.keys(mapped)) delete mapped[k];
        }
      }
      $.progress.value = 100;
      const rest = batchLeft && $.applyAll && $.applyAll.checked
        ? { mode: S.mode, dpi: S.dpi, quality: S.quality, sensitivity: S.sensitivity, flatten: S.flatten, text: S.text, limit: S.limit, copyComments: S.copyComments }
        : null; // dpi 0 = "as scanned", worked out again for each file
      finish({ pages, order: kept, settings: { ...cfg, copyComments: S.copyComments && Object.keys(mapped).length > 0 }, mapped, squeezed, over, rest });
    });

    // ---------------------------------------------------------------- start: look at a few pages, suggest, preview
    reflect();
    updateEstimateText();
    (async () => {
      try {
        const idx = Array.from(new Set([0, Math.floor(N / 4), Math.floor(N / 2), Math.floor((3 * N) / 4)])).filter((k) => k < N);
        const { samples, dpi } = await client.sample(idx.map((k) => k + 1), 800).promise;
        S.sourceDpi = dpi || 0;
        const g = suggestFor(samples, dpi);
        S.suggestion = g;
        S.mode = g.mode;
        S.dpi = DPIS.reduce((best, d) => (Math.abs(d - g.dpi) < Math.abs(best - g.dpi) ? d : best), 200);
        S.suggestion.dpi = S.dpi;
        $.quality.value = S.quality = g.mode === "colour" ? 65 : 60;
        $.sens.value = S.sensitivity = 0;
        reflect();
        showSuggestion();
      } catch (e) {
        $.suggestText.textContent = "No suggestion (couldn't read the pages)";
        $.useSuggestion.disabled = true;
      }
      refreshPreview();
    })();

    return {
      S, settings, refreshPreview,
      destroy: () => {
        win.clearTimeout(timer);
        S.token++;
        doc.removeEventListener("keydown", onKey);
        for (const b of [S.result, S.orig]) if (b && b.close) b.close();
        client.terminate();
      },
    };
  }

  /** The recommendation is computed by the same module the worker uses; the window only has the numbers. */
  function suggestFor(samples, dpi) {
    if (typeof ScanFixerImage !== "undefined") return ScanFixerImage.suggestCompression(samples, dpi);
    return { mode: "gray", dpi: 200, why: "it is a safe default" };
  }

  async function openBlank(parentWindow, name, features) {
    const win = parentWindow.openDialog("about:blank", name, features);
    const sleep = (ms) => new Promise((r) => parentWindow.setTimeout(r, ms));
    for (let i = 0; i < 120; i++) {
      const d = win.document;
      if (d && d.readyState === "complete" && d.body && win.location.href === "about:blank") break;
      await sleep(25);
    }
    if (!win.document || !win.document.body) throw new Error("Could not open the compression window");
    return win;
  }

  /**
   * "Use these settings for the other PDFs": compress one more file without the full window. A small window shows the
   * progress (and Cancel). `rest` is the answer's `rest` from the first file's window; "as scanned" (dpi 0) is worked out
   * again for this file. Resolves to an answer shaped like open()'s, to null if cancelled, or to { error }.
   */
  async function runBatch(parentWindow, config, rest) {
    const win = await openBlank(parentWindow, "scanfixer-compress-batch", "chrome,dialog=no,dependent,centerscreen,width=480,height=210");
    const doc = win.document;
    doc.title = config.title;
    const style = el(doc, "style");
    style.textContent = CSS + ` .batch { padding: 18px 20px; display: flex; flex-direction: column; gap: 10px; box-sizing: border-box; height: 100vh; } .batch h1 { font-size: 15px; margin: 0; } .batch progress { width: 100%; } .batch .btns { margin-top: auto; display: flex; justify-content: flex-end; }`;
    (doc.head || doc.documentElement).append(style);
    const what = el(doc, "div", { id: "batchWhat", text: "Starting…" });
    const bar = el(doc, "progress", { id: "batchBar", max: 100, value: 0 });
    const cancel = el(doc, "button", { type: "button", id: "batchCancel", text: "Cancel" });
    doc.body.replaceChildren(el(doc, "div", { class: "batch" },
      el(doc, "h1", { text: config.subject || "Compressing" }),
      el(doc, "div", { class: "sub", text: config.fileName || "" }),
      what, bar, el(doc, "div", { class: "btns" }, cancel)));

    let client = null, stopped = false, finished = false, resolveOuter;
    const done = new Promise((r) => (resolveOuter = r));
    const finish = (value) => {
      if (finished) return;
      finished = true;
      if (client) client.terminate();
      try { win.close(); } catch (e) { /* already closed */ }
      resolveOuter(value);
    };
    const stop = () => { stopped = true; finish(null); };
    cancel.addEventListener("click", stop);
    win.addEventListener("unload", stop);
    doc.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); stop(); } });
    (async () => {
      try {
        const source = await config.getWorkerSource();
        const created = await ScanFixerEditor.createClient(win, source, config.pdfBytes);
        client = created.client;
        if (stopped) return;
        const N = created.pages;
        const human = ScanFixerCompress.humanSize;
        const known = (config.pageBytes || []).filter((n) => n > 0);
        const avgBytes = known.length ? known.reduce((a, b) => a + b, 0) / known.length : (config.fileSize || 0) / Math.max(1, N);
        let sourceDpi = 0;
        try {
          const idx = Array.from(new Set([0, Math.floor(N / 4), Math.floor(N / 2), Math.floor((3 * N) / 4)])).filter((k) => k < N);
          sourceDpi = (await client.sample(idx.map((k) => k + 1), 800).promise).dpi || 0;
        } catch (e) { /* no scan resolution known: the chosen dpi is used as it is */ }
        if (stopped) return;
        const cfg = {
          mode: rest.mode, dpi: rest.dpi > 0 ? rest.dpi : sourceDpi || 300, maxDpi: sourceDpi, minDpi: 100,
          quality: rest.quality, sensitivity: rest.sensitivity, flatten: !!rest.flatten && rest.mode !== "colour", text: !!rest.text,
        };
        const pages = [];
        let bytes = 0, squeezed = 0, over = 0;
        for (let i = 0; i < N; i++) {
          if (stopped) return;
          what.textContent = `Page ${i + 1} of ${N} · ${human(bytes)} so far`;
          bar.value = (i / N) * 100;
          const budget = rest.limit ? Math.round(((config.pageBytes || [])[i] || avgBytes) * BUDGET_SHARE) : 0;
          const r = await client.compress(i + 1, { ...cfg, budget }).promise;
          pages.push(r);
          bytes += r.bytes.byteLength;
          if (r.squeezed) squeezed++;
          if (r.overBudget) over++;
        }
        const mapped = {};
        if (rest.copyComments && (config.comments || []).length) {
          what.textContent = "Placing the comments…";
          try {
            for (const rq of config.comments) mapped[rq.key] = (await client.mapPoints(rq.page, rq.points).promise).points;
          } catch (e) {
            for (const k of Object.keys(mapped)) delete mapped[k]; // made without them
          }
        }
        bar.value = 100;
        finish({ pages, order: Array.from({ length: N }, (_, i) => i), settings: { ...cfg, copyComments: !!rest.copyComments && Object.keys(mapped).length > 0 }, mapped, squeezed, over, total: N });
      } catch (e) {
        if (!stopped) finish({ error: String((e && e.message) || e) });
      }
    })();
    return done;
  }

  async function open(parentWindow, config) {
    const win = await openBlank(parentWindow, "scanfixer-compress", "chrome,dialog=no,dependent,centerscreen,resizable,width=1100,height=800");
    const doc = win.document;
    doc.title = config.title;
    const base = el(doc, "style");
    base.textContent = CSS;
    (doc.head || doc.documentElement).append(base);
    doc.body.replaceChildren(el(doc, "div", { id: "loading", text: "Starting…" }));

    let client = null, ui = null, finished = false, resolveOuter;
    const done = new Promise((r) => (resolveOuter = r));
    const finish = (value) => {
      if (finished) return;
      finished = true;
      if (ui) ui.destroy();
      else if (client) client.terminate();
      try { win.close(); } catch (e) { /* already closed */ }
      resolveOuter(value);
    };
    win.addEventListener("unload", () => finish(null));
    try {
      const source = await config.getWorkerSource();
      const created = await ScanFixerEditor.createClient(win, source, config.pdfBytes);
      client = created.client;
      if (finished) { client.terminate(); return done; }
      ui = build(doc, win, { ...config, pageCount: created.pages }, client, finish);
      win.focus();
    } catch (e) {
      finished = true;
      if (client) client.terminate();
      try { win.close(); } catch (err) { /* ignore */ }
      throw e;
    }
    return done;
  }

  return { open, build, runBatch };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ScanFixerCompressor;
