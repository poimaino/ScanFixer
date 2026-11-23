// Copyright (c) 2026 poimaino. MIT licence, see LICENSE in the repository root.
/* Options dialog for ScanFixer.
 *
 * Built by hand in a plain chrome window (about:blank), so it needs no XUL/XHTML files and
 * no chrome:// registration. buildForm() only uses standard DOM calls, so it can be tested
 * in an ordinary browser.
 *
 *   ScanFixerDialog.open(parentWindow, config) -> Promise<result | null>
 *
 *   config.mode      "split" | "adjust"
 *   config.title     window title
 *   config.intro     short paragraph at the top
 *   config.notes     [string]  small print (e.g. the backup note)
 *   config.warnings  [string]  highlighted warnings (e.g. "has annotations")
 *   config.pages     (adjust) { value: "3-5", hint: "Pre-filled from your selection…" }
 */
var ScanFixerDialog = (function () {
  const NS = "http://www.w3.org/1999/xhtml";

  // Colours are explicit and opaque: Zotero's plain windows can otherwise be see-through.
  const CSS = `
    :root { color-scheme: light dark; --bg: #ffffff; --fg: #1d1d1f; --line: rgba(0,0,0,.25); }
    @media (prefers-color-scheme: dark) { :root { --bg: #28282b; --fg: #ececec; --line: rgba(255,255,255,.28); } }
    html, body { margin: 0; background: var(--bg); color: var(--fg); }
    body { font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 18px 20px 16px; box-sizing: border-box; }
    h1 { font-size: 15px; margin: 0 0 6px; }
    p { margin: 0 0 10px; }
    fieldset { border: 1px solid var(--line); border-radius: 6px; margin: 0 0 12px; padding: 8px 12px 10px; }
    legend { font-weight: 600; padding: 0 4px; }
    .row { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
    .row label.grow { flex: 1; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 16px; }
    .grid label { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    input[type=number], input[type=text] { font: inherit; padding: 3px 6px; box-sizing: border-box; }
    input[type=number] { width: 72px; text-align: right; }
    input[type=text] { width: 100%; }
    .unit { opacity: .65; }
    .hint { font-size: 12px; opacity: .72; margin: 3px 0 0; }
    .warn { background: #fdf0d5; color: #3b2a00; border: 1px solid #f5a623; border-radius: 6px; padding: 6px 10px; margin: 0 0 10px; }
    .notes { font-size: 12px; opacity: .78; margin: 0 0 12px; }
    .notes p { margin: 0 0 4px; }
    .error { color: #d12; min-height: 1.4em; margin: 0 0 8px; font-weight: 600; }
    .buttons { display: flex; justify-content: flex-end; gap: 8px; }
    button { font: inherit; padding: 4px 16px; min-width: 76px; }
  `;

  function h(doc, tag, attrs, ...children) {
    const el = doc.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "text") el.textContent = v;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of children.flat()) if (c) el.append(c);
    return el;
  }

  const num = (doc, id, value, { min, max, step = 0.5 } = {}) =>
    h(doc, "input", { type: "number", id, value, min, max, step });

  /**
   * Render the form into doc.body.
   * @param finish(result|null) called exactly once by the buttons / Enter / Escape
   */
  function buildForm(doc, config, finish) {
    const split = config.mode === "split";
    doc.title = config.title;
    const style = h(doc, "style");
    style.textContent = CSS;
    (doc.head || doc.documentElement).append(style);
    const body = doc.body;
    body.replaceChildren();

    const error = h(doc, "div", { class: "error", role: "alert", id: "error" });
    const field = (id) => doc.getElementById(id);
    const read = (id) => {
      const el = field(id);
      return el.value === "" ? NaN : Number(el.value);
    };

    body.append(h(doc, "h1", { text: config.title }));
    if (config.intro) body.append(h(doc, "p", { text: config.intro }));
    for (const w of config.warnings || []) body.append(h(doc, "div", { class: "warn", text: w }));

    if (split) {
      body.append(
        h(doc, "fieldset", {},
          h(doc, "legend", { text: "Book" }),
          h(doc, "div", { class: "row" },
            h(doc, "label", {}, h(doc, "input", { type: "radio", name: "dir", id: "dir-ltr", checked: true }), " Left-to-right"),
            h(doc, "label", {}, h(doc, "input", { type: "radio", name: "dir", id: "dir-rtl" }), " Right-to-left (e.g. Arabic, Hebrew, manga)")),
          h(doc, "div", { class: "row" },
            h(doc, "label", {}, h(doc, "input", { type: "checkbox", id: "landscape", checked: true }),
              " Only split landscape pages (leave portrait pages such as covers alone)"))),
        h(doc, "fieldset", {},
          h(doc, "legend", { text: "Dividing line" }),
          h(doc, "div", { class: "row" },
            h(doc, "label", { for: "gutter", class: "grow", text: "Position of the spine, from the left edge of the spread" }),
            num(doc, "gutter", 50, { min: 10, max: 90 }), h(doc, "span", { class: "unit", text: "%" })),
          h(doc, "p", { class: "hint", text: "50 is the exact middle. Use a smaller number (e.g. 46) if the spine sits left of centre in this scan, larger if it sits right of centre." })),
        h(doc, "fieldset", {},
          h(doc, "legend", { text: "Trim edges of each new page" }),
          h(doc, "div", { class: "grid" },
            h(doc, "label", {}, "Top", h(doc, "span", {}, num(doc, "t-top", 0, { min: 0, max: 40 }), " ", h(doc, "span", { class: "unit", text: "%" }))),
            h(doc, "label", {}, "Bottom", h(doc, "span", {}, num(doc, "t-bottom", 0, { min: 0, max: 40 }), " ", h(doc, "span", { class: "unit", text: "%" }))),
            h(doc, "label", {}, "Outer edge", h(doc, "span", {}, num(doc, "t-outer", 0, { min: 0, max: 40 }), " ", h(doc, "span", { class: "unit", text: "%" }))),
            h(doc, "label", {}, "Inner (spine) edge", h(doc, "span", {}, num(doc, "t-inner", 0, { min: 0, max: 40 }), " ", h(doc, "span", { class: "unit", text: "%" })))),
          h(doc, "p", { class: "hint", text: "Percentages of each new page's size. Useful for dark borders or scanner bed edges. You can fine-tune individual pages afterwards by opening ScanFixer again." })));
    } else {
      body.append(
        h(doc, "fieldset", {},
          h(doc, "legend", { text: "Pages" }),
          h(doc, "input", { type: "text", id: "pages", value: (config.pages && config.pages.value) || "", placeholder: "e.g.  3   5-9   odd   even   all   10-40 odd" }),
          h(doc, "p", { class: "hint", text: (config.pages && config.pages.hint) || "Page numbers as shown in the reader. Combine with commas: 1, 4-9, 12." })),
        h(doc, "fieldset", {},
          h(doc, "legend", { text: "Move edges" }),
          h(doc, "div", { class: "grid" },
            h(doc, "label", {}, "Left", h(doc, "span", {}, num(doc, "e-left", 0, { min: -50, max: 50 }), " ", h(doc, "span", { class: "unit", text: "%" }))),
            h(doc, "label", {}, "Right", h(doc, "span", {}, num(doc, "e-right", 0, { min: -50, max: 50 }), " ", h(doc, "span", { class: "unit", text: "%" }))),
            h(doc, "label", {}, "Top", h(doc, "span", {}, num(doc, "e-top", 0, { min: -50, max: 50 }), " ", h(doc, "span", { class: "unit", text: "%" }))),
            h(doc, "label", {}, "Bottom", h(doc, "span", {}, num(doc, "e-bottom", 0, { min: -50, max: 50 }), " ", h(doc, "span", { class: "unit", text: "%" })))),
          h(doc, "p", { class: "hint", text: "Positive values trim that edge inwards. Negative values bring hidden content back, up to the page's original edges (so a split can be nudged either way). Percentages of the page's current width/height; edges are as you see them on screen." })));
    }

    if (config.notes && config.notes.length) {
      body.append(h(doc, "div", { class: "notes" }, config.notes.map((n) => h(doc, "p", { text: n }))));
    }
    const ok = h(doc, "button", { type: "button", id: "ok", text: split ? "Split" : "Apply" });
    const cancel = h(doc, "button", { type: "button", id: "cancel", text: "Cancel" });
    body.append(error, h(doc, "div", { class: "buttons" }, cancel, ok));

    const fail = (msg, id) => {
      error.textContent = msg;
      if (id) field(id)?.focus();
      return null;
    };

    function collect() {
      error.textContent = "";
      if (split) {
        const gutter = read("gutter");
        if (!(gutter >= 10 && gutter <= 90)) return fail("The spine position must be between 10 and 90 percent.", "gutter");
        const trim = {};
        for (const [key, id] of [["top", "t-top"], ["bottom", "t-bottom"], ["outer", "t-outer"], ["inner", "t-inner"]]) {
          const v = read(id);
          if (!(v >= 0 && v <= 40)) return fail("Trim values must be between 0 and 40 percent.", id);
          trim[key] = v;
        }
        return { rtl: field("dir-rtl").checked, onlyLandscape: field("landscape").checked, ratio: gutter / 100, trim };
      }
      const pagesText = field("pages").value.trim();
      if (!pagesText) return fail("Enter which pages to adjust (for example 3, 5-9, odd, even or all).", "pages");
      const edges = {};
      for (const side of ["left", "right", "top", "bottom"]) {
        const v = read("e-" + side);
        if (!(v >= -50 && v <= 50)) return fail("Edge values must be between -50 and 50 percent.", "e-" + side);
        edges[side] = v;
      }
      if (!Object.values(edges).some((v) => v !== 0)) return fail("Set at least one edge to something other than 0.", "e-left");
      return { pagesText, edges };
    }

    const submit = () => {
      const result = collect();
      if (result) finish(result);
    };
    ok.addEventListener("click", submit);
    cancel.addEventListener("click", () => finish(null));
    doc.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); finish(null); }
      else if (e.key === "Enter" && e.target.tagName !== "BUTTON") { e.preventDefault(); submit(); }
    });
    (split ? field("gutter") : field("pages")).focus();
  }

  /** Open the dialog window and resolve with the user's choices, or null if cancelled. */
  async function open(parentWindow, config) {
    const win = parentWindow.openDialog(
      "about:blank",
      "scanfixer-dialog",
      "chrome,dialog=no,dependent,centerscreen,resizable,width=540,height=560"
    );
    const sleep = (ms) => new Promise((r) => parentWindow.setTimeout(r, ms));
    for (let i = 0; i < 120; i++) {
      const d = win.document;
      if (d && d.readyState === "complete" && d.body && win.location.href === "about:blank") break;
      await sleep(25);
    }
    if (!win.document || !win.document.body) throw new Error("Could not open the options window");

    return new Promise((resolve) => {
      let finished = false;
      const finish = (value) => {
        if (finished) return;
        finished = true;
        try { win.close(); } catch (e) { /* already closed */ }
        resolve(value);
      };
      win.addEventListener("unload", () => finish(null));
      buildForm(win.document, config, finish);
      try {
        const extra = win.outerHeight - win.innerHeight;
        win.resizeTo(win.outerWidth, Math.min(win.document.documentElement.scrollHeight + extra + 8, 900));
      } catch (e) { /* sizing is cosmetic */ }
      win.focus();
    });
  }

  return { open, buildForm };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ScanFixerDialog;
