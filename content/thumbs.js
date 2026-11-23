// Copyright (c) 2026 poimaino. MIT licence, see LICENSE in the repository root.
/* Thumbnail grid shared by the Fix editor and the Compress window.
 *
 *   const grid = ScanFixerThumbs.create(doc, win, client, opts)   ->  { el, refresh, selected, selectAll, clear, handleKey, destroy, ... }
 *
 * opts:
 *   count     number of pages in the PDF
 *   order     () -> array of 0-based page indexes in the order they are to be shown
 *   info      (i) -> { removed, rects: [{u0,v0,u1,v1,exclude}], rotate, tags: [text], label }   what to draw on page i
 *   reorder   true to allow drag-and-drop re-ordering (calls onMove(ids, beforePosition))
 *   onChange  () selection changed        onOpen(i) double-click       onMove(ids, pos)
 *   actions   [elements] extra buttons or labelled groups (div.tgroup > span.tglabel + buttons) for the toolbar
 *
 * Thumbnails are drawn lazily (only what is on screen), one at a time, so the main preview is never kept waiting.
 * Plain DOM calls only. Click selects, Ctrl/Cmd-click adds or removes, Shift-click selects a run, Ctrl/Cmd+A selects all.
 * Keyboard: Tab enters the grid (one stop; the cells are a listbox). Arrows move to and select a page, Shift+arrows extend the
 * selection from the anchor, Ctrl/Cmd+arrows move without selecting, Space toggles the page, Enter opens it, Home/End jump.
 */
var ScanFixerThumbs = (function () {
  const HTML = "http://www.w3.org/1999/xhtml";
  const RENDER_W = 320;

  const CSS = `
    .thumbwrap { display: flex; flex-direction: column; min-height: 0; height: 100%; background: var(--panel); }
    .thumbbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 20px; padding: 8px 14px; border-bottom: 1px solid var(--line); background: var(--bg); color: var(--fg); }
    .thumbbar .sep { width: 1px; align-self: stretch; background: var(--line); margin: 0 -6px; }
    .thumbbar .tgroup { display: flex; align-items: center; gap: 6px; }
    .thumbbar .tglabel { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; opacity: .6; margin-right: 2px; }
    .thumbbar .count { opacity: .75; min-width: 90px; }
    .thumbbar .size { display: flex; align-items: center; gap: 6px; margin-left: auto; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }
    .thumbbar .size input { width: 90px; }
    .thumbbar button:disabled { opacity: .45; }
    .thumbgrid { flex: 1; min-height: 0; overflow: auto; padding: 12px; display: grid; --tw: 150px; grid-template-columns: repeat(auto-fill, minmax(var(--tw), 1fr)); gap: 14px 12px; align-content: start; outline: none; }
    .tcell { position: relative; cursor: pointer; user-select: none; border-radius: 8px; padding: 6px 6px 4px; border: 2px solid transparent; }
    .tcell:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .tcell:hover { background: rgba(127,127,127,.14); }
    .tcell.sel { border-color: var(--accent); background: rgba(27,110,243,.14); }
    .tcell.sel .tcap b { color: var(--accent); }
    .tcell.dropbefore::before, .tcell.dropafter::after { content: ""; position: absolute; top: 0; bottom: 0; width: 4px; background: var(--accent); border-radius: 2px; }
    .tcell.dropbefore::before { left: -8px; } .tcell.dropafter::after { right: -8px; }
    .tframe { position: relative; width: 100%; aspect-ratio: 3 / 4; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.35); overflow: hidden; }
    .tframe canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
    .tov { position: absolute; inset: 0; pointer-events: none; }
    .tov .r { position: absolute; box-sizing: border-box; border: 1.5px solid #1b6ef3; background: rgba(27,110,243,.05); }
    .tov .r.gone { border: 1.5px dashed #d12; background: rgba(220,40,40,.22); }
    .tcell.removed .tframe canvas { opacity: .35; }
    .tcell.removed .tframe::after { content: "Removed"; position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%); background: #d12; color: #fff; font-weight: 700; font-size: 12px; padding: 2px 10px; border-radius: 11px; }
    .tcap { margin-top: 3px; font-size: 12px; line-height: 1.3; text-align: center; color: var(--fg); }
    .tcap b { font-size: 13px; }
    .tcap .t { opacity: .65; display: block; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  `;

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

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

  /** The new order after taking `ids` out and putting them (in their old relative order) before position `pos` of the old order. */
  function moveBlock(order, ids, pos) {
    const set = new Set(ids);
    const moving = order.filter((i) => set.has(i));
    const before = order.slice(0, pos).filter((i) => !set.has(i)).length;
    const rest = order.filter((i) => !set.has(i));
    rest.splice(before, 0, ...moving);
    return rest;
  }

  function create(doc, win, client, opts) {
    const N = opts.count;
    const order = () => opts.order();
    const sel = new Set();
    let anchor = null, destroyed = false, busy = false, dragIds = null, cursor = null; // cursor: the page that has keyboard focus
    const cells = new Map(); // page index -> { cell, frame, canvas, ov, cap }
    const drawn = new Map(); // page index -> rotation it was drawn at (or "err")
    const visible = new Set();

    const $ = {};
    $.count = el(doc, "span", { class: "count" });
    $.all = el(doc, "button", { type: "button", id: "selAll", text: "Select all", title: "Select every page (Ctrl/Cmd+A)" });
    $.none = el(doc, "button", { type: "button", id: "selNone", text: "Deselect all", title: "Clear the selection" });
    $.size = el(doc, "input", { type: "range", id: "thumbSize", min: 90, max: 320, step: 10, value: 150, title: "Thumbnail size" });
    $.bar = el(doc, "div", { class: "thumbbar" },
      el(doc, "div", { class: "tgroup" }, el(doc, "span", { class: "tglabel", text: "Select" }), $.all, $.none, $.count),
      ...(opts.actions && opts.actions.length ? [el(doc, "span", { class: "sep" }), ...opts.actions] : []),
      el(doc, "label", { class: "size" }, "Size ", $.size));
    $.grid = el(doc, "div", { class: "thumbgrid", id: "thumbGrid", role: "listbox", "aria-multiselectable": "true", "aria-label": "Pages" });
    $.el = el(doc, "div", { class: "thumbwrap" }, $.bar, $.grid);

    const io = typeof win.IntersectionObserver === "function"
      ? new win.IntersectionObserver((entries) => {
          for (const e of entries) {
            const i = Number(e.target.getAttribute("data-i"));
            if (e.isIntersecting) visible.add(i); else visible.delete(i);
          }
          pump();
        }, { root: $.grid, rootMargin: "300px" })
      : null;

    function makeCell(i) {
      const canvas = el(doc, "canvas", { width: 1, height: 1 });
      const ov = el(doc, "div", { class: "tov" });
      const frame = el(doc, "div", { class: "tframe" }, canvas, ov);
      const cap = el(doc, "div", { class: "tcap" });
      const cell = el(doc, "div", { class: "tcell", "data-i": i, role: "option", tabindex: "-1", "aria-selected": "false", draggable: opts.reorder ? "true" : undefined }, frame, cap);
      cell.addEventListener("click", (e) => { cursor = i; syncCursor(); onClick(i, e); });
      cell.addEventListener("focus", () => { if (cursor !== i) { cursor = i; syncCursor(); } });
      cell.addEventListener("dblclick", () => opts.onOpen && opts.onOpen(i));
      if (opts.reorder) {
        cell.addEventListener("dragstart", (e) => {
          if (!sel.has(i)) { sel.clear(); sel.add(i); anchor = i; paintAll(); opts.onChange && opts.onChange(); }
          dragIds = selected();
          try { e.dataTransfer.setData("text/plain", "scanfixer-pages"); e.dataTransfer.effectAllowed = "move"; } catch (err) { /* ignore */ }
        });
        cell.addEventListener("dragover", (e) => {
          if (!dragIds) return;
          e.preventDefault();
          const b = cell.getBoundingClientRect();
          const after = e.clientX > b.left + b.width / 2;
          clearDrop();
          cell.classList.add(after ? "dropafter" : "dropbefore");
        });
        cell.addEventListener("dragleave", () => { cell.classList.remove("dropbefore", "dropafter"); });
        cell.addEventListener("drop", (e) => {
          if (!dragIds) return;
          e.preventDefault();
          const b = cell.getBoundingClientRect();
          const after = e.clientX > b.left + b.width / 2;
          const pos = order().indexOf(i) + (after ? 1 : 0);
          const ids = dragIds;
          dragIds = null;
          clearDrop();
          opts.onMove && opts.onMove(ids, pos);
        });
        cell.addEventListener("dragend", () => { dragIds = null; clearDrop(); });
      }
      if (io) io.observe(cell);
      cells.set(i, { cell, frame, canvas, ov, cap });
      return cells.get(i);
    }
    const clearDrop = () => { for (const c of cells.values()) c.cell.classList.remove("dropbefore", "dropafter"); };
    for (let i = 0; i < N; i++) makeCell(i);

    const selected = () => order().filter((i) => sel.has(i));
    const changed = () => { paintAll(); opts.onChange && opts.onChange(); };

    function onClick(i, e) {
      const ord = order();
      if (e.shiftKey && anchor !== null) {
        const a = ord.indexOf(anchor), b = ord.indexOf(i);
        const [lo, hi] = a < b ? [a, b] : [b, a];
        if (!(e.ctrlKey || e.metaKey)) sel.clear();
        for (let k = lo; k <= hi; k++) sel.add(ord[k]);
      } else if (e.ctrlKey || e.metaKey) {
        if (sel.has(i)) sel.delete(i); else sel.add(i);
        anchor = i;
      } else {
        sel.clear();
        sel.add(i);
        anchor = i;
      }
      changed();
    }

    function paint(i) {
      const c = cells.get(i);
      const inf = opts.info(i) || {};
      const pos = order().indexOf(i);
      c.cell.classList.toggle("sel", sel.has(i));
      c.cell.setAttribute("aria-selected", sel.has(i) ? "true" : "false");
      c.cell.setAttribute("aria-label", `Page ${pos + 1}${inf.removed ? ", removed" : ""}${pos !== i ? `, was page ${i + 1}` : ""}`);
      c.cell.classList.toggle("removed", !!inf.removed);
      c.ov.replaceChildren(...(inf.rects || []).map((r) => {
        const d = el(doc, "div", { class: "r" + (r.exclude || inf.removed ? " gone" : "") });
        d.style.left = r.u0 * 100 + "%"; d.style.top = r.v0 * 100 + "%";
        d.style.width = (r.u1 - r.u0) * 100 + "%"; d.style.height = (r.v1 - r.v0) * 100 + "%";
        return d;
      }));
      const num = el(doc, "b", { text: String(pos + 1) });
      const was = pos !== i ? ` (was ${i + 1})` : "";
      const label = inf.label !== undefined && inf.label !== String(pos + 1) ? ` “${inf.label}”` : "";
      c.cap.replaceChildren(num, was + label, ...(inf.tags && inf.tags.length ? [el(doc, "span", { class: "t", text: inf.tags.join(" · ") })] : []));
      if (inf.tags) c.cap.title = inf.tags.join(" · ");
    }
    /** One tab stop for the whole grid: the page that has the cursor (the first one until a key or click moves it). */
    function syncCursor() {
      const ord = order();
      if (cursor === null || !cells.has(cursor)) cursor = ord.length ? ord[0] : null;
      for (const [i, c] of cells) c.cell.setAttribute("tabindex", i === cursor ? "0" : "-1");
    }
    function paintAll() {
      syncCursor();
      for (let i = 0; i < N; i++) paint(i);
      const n = sel.size;
      $.count.textContent = n ? `${n} selected` : "None selected";
      pump();
    }

    /** Put the cells in the current order (after a move) and redraw their captions. */
    function layoutCells() {
      $.grid.append(...order().map((i) => cells.get(i).cell));
      paintAll();
    }

    async function pump() {
      if (busy || destroyed) return;
      busy = true;
      try {
        for (;;) {
          if (destroyed) return;
          const ord = order();
          let next = null, rot = 0;
          for (const i of ord) {
            if (!visible.has(i)) continue;
            const r = ((opts.info(i) || {}).rotate || 0) % 360;
            if (drawn.get(i) !== r) { next = i; rot = r; break; }
          }
          if (next === null) return;
          try {
            const r = await client.render(next + 1, RENDER_W, rot).promise;
            if (destroyed) { if (r.bmp && r.bmp.close) r.bmp.close(); return; }
            const c = cells.get(next);
            c.canvas.width = r.bmp.width; c.canvas.height = r.bmp.height;
            c.frame.style.aspectRatio = `${r.bmp.width} / ${r.bmp.height}`;
            c.canvas.getContext("2d").drawImage(r.bmp, 0, 0);
            if (r.bmp.close) r.bmp.close();
            drawn.set(next, rot);
          } catch (e) {
            drawn.set(next, rot); // don't retry a page that can't be drawn
          }
        }
      } finally {
        busy = false;
      }
    }

    $.all.addEventListener("click", () => selectAll());
    $.none.addEventListener("click", () => clear());
    $.size.addEventListener("input", () => $.grid.style.setProperty("--tw", $.size.value + "px"));

    function selectAll() { for (let i = 0; i < N; i++) sel.add(i); changed(); }
    function clear() { sel.clear(); anchor = null; changed(); }
    function set(ids) { sel.clear(); for (const i of ids) sel.add(i); changed(); }
    /** Call from the window's key handler while the grid is on screen. Returns true if the key was used. */
    function handleKey(e) {
      const t = e.target;
      const typing = t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && t.type !== "range" && t.type !== "checkbox" && t.type !== "radio";
      if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A") && !typing) { e.preventDefault(); selectAll(); return true; }
      // the keys below work on the grid itself or on the page, never while a button, slider or text box has the focus
      const inGrid = t && ($.grid.contains(t) || t === doc.body || t === doc.documentElement);
      if (!inGrid || typing || e.altKey) return false;
      const ord = order();
      if (!ord.length) return false;
      const columns = () => {
        const n = String((win.getComputedStyle($.grid) || {}).gridTemplateColumns || "").trim().split(/\s+/).filter(Boolean).length;
        return Math.max(1, n);
      };
      const at = Math.max(0, ord.indexOf(cursor));
      let to = null;
      if (e.key === "ArrowRight") to = at + 1;
      else if (e.key === "ArrowLeft") to = at - 1;
      else if (e.key === "ArrowDown") to = at + columns();
      else if (e.key === "ArrowUp") to = at - columns();
      else if (e.key === "Home") to = 0;
      else if (e.key === "End") to = ord.length - 1;
      else if (e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        if (cursor === null) return true;
        if (sel.has(cursor)) sel.delete(cursor); else sel.add(cursor);
        anchor = cursor;
        changed();
        return true;
      } else if (e.key === "Enter" && cursor !== null && opts.onOpen && $.grid.contains(t)) {
        e.preventDefault();
        opts.onOpen(cursor);
        return true;
      } else return false;
      e.preventDefault();
      to = Math.min(ord.length - 1, Math.max(0, to));
      const target = ord[to];
      cursor = target;
      if (e.shiftKey) {
        const a = ord.indexOf(anchor === null ? ord[at] : anchor), b = to;
        if (anchor === null) anchor = ord[at];
        sel.clear();
        for (let k = Math.min(a, b); k <= Math.max(a, b); k++) sel.add(ord[k]);
        changed();
      } else if (!(e.ctrlKey || e.metaKey)) {
        sel.clear();
        sel.add(target);
        anchor = target;
        changed();
      }
      syncCursor();
      const c = cells.get(target);
      if (c) { c.cell.focus({ preventScroll: true }); scrollTo(target); }
      return true;
    }
    function scrollTo(i) { const c = cells.get(i); if (c && c.cell.scrollIntoView) c.cell.scrollIntoView({ block: "nearest" }); }

    layoutCells();
    return {
      el: $.el, refresh: (ids) => { if (ids) { ids.forEach(paint); pump(); } else paintAll(); }, layout: layoutCells, selected, selectAll, clear, set, handleKey, scrollTo,
      has: (i) => sel.has(i),
      anchor: () => anchor,
      destroy: () => { destroyed = true; if (io) io.disconnect(); },
    };
  }

  return { create, moveBlock, CSS };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ScanFixerThumbs;
