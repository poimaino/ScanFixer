// Copyright (c) 2026 poimaino. MIT licence, see LICENSE in the repository root.
/* The one window ScanFixer opens first: what do you want to do?
 *
 *   ScanFixerChooser.open(parentWindow, config) -> Promise<"compress" | "both" | "fixcompress" | "fix" | null>
 *
 *   config.title     window title
 *   config.subject   what the choice applies to, e.g. "Smith 2019.pdf" or "3 PDFs"
 *   config.initial   the option to highlight ("compress" | "both" | "fixcompress" | "fix"), usually the one used last time
 *
 * Built by hand in a plain chrome window like the other ScanFixer windows; buildForm() only uses standard DOM calls,
 * so it can be tested in an ordinary browser.
 */
var ScanFixerChooser = (function () {
  const NS = "http://www.w3.org/1999/xhtml";

  const OPTIONS = [
    { value: "compress", title: "Compress only", text: "A smaller black-and-white, greyscale or colour copy, saved next to the original." },
    { value: "both", title: "Compress, then fix", text: "Make the smaller copy, then split, crop and straighten its pages." },
    { value: "fixcompress", title: "Fix, then compress", text: "Fix the pages first, then make a smaller copy of the fixed file. Cropped margins and spine shadow are cut out before compressing." },
    { value: "fix", title: "Fix only", text: "Split spreads, crop, rotate and straighten pages. The original is backed up." },
  ];

  const CSS = `
    :root { color-scheme: light dark; --bg: #ffffff; --fg: #1d1d1f; --line: rgba(0,0,0,.25); --accent: #1b6ef3; --sel: rgba(27,110,243,.09); }
    @media (prefers-color-scheme: dark) { :root { --bg: #28282b; --fg: #ececec; --line: rgba(255,255,255,.28); --sel: rgba(27,110,243,.22); } }
    html, body { margin: 0; background: var(--bg); color: var(--fg); }
    body { font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 18px 20px 16px; box-sizing: border-box; }
    h1 { font-size: 15px; margin: 0 0 2px; }
    .subject { opacity: .72; margin: 0 0 12px; overflow-wrap: anywhere; }
    .choice { display: block; width: 100%; box-sizing: border-box; text-align: left; font: inherit; color: inherit; background: transparent; border: 1px solid var(--line); border-radius: 8px; padding: 9px 12px; margin: 0 0 8px; cursor: pointer; }
    .choice:hover, .choice:focus-visible { border-color: var(--accent); outline: none; }
    .choice.on { border-color: var(--accent); background: var(--sel); }
    .choice b { display: block; font-size: 14px; }
    .choice span { display: block; opacity: .8; }
    .buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
    #cancel { font: inherit; padding: 4px 16px; min-width: 84px; }
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

  function buildForm(doc, config, finish) {
    doc.title = config.title || "ScanFixer";
    const style = h(doc, "style");
    style.textContent = CSS;
    (doc.head || doc.documentElement).append(style);
    doc.body.replaceChildren();

    const initial = OPTIONS.some((o) => o.value === config.initial) ? config.initial : "fix";
    // Each choice is a button: one click chooses it and closes the window. The one used last time is highlighted and focused,
    // so Enter repeats it; 1 to 4 pick by number.
    const cards = OPTIONS.map((o, k) => {
      const card = h(doc, "button", { type: "button", class: "choice" + (o.value === initial ? " on" : ""), id: "choice-" + o.value, "data-value": o.value },
        h(doc, "b", { text: o.title }), h(doc, "span", { text: o.text }));
      card.addEventListener("click", () => finish(o.value));
      return card;
    });
    const cancel = h(doc, "button", { type: "button", id: "cancel", text: "Cancel" });
    cancel.addEventListener("click", () => finish(null));
    doc.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); finish(null); }
      else if (/^[1-4]$/.test(e.key) && OPTIONS[+e.key - 1]) { e.preventDefault(); finish(OPTIONS[+e.key - 1].value); }
    });
    doc.body.append(
      h(doc, "h1", { text: "ScanFixer" }),
      config.subject ? h(doc, "p", { class: "subject", id: "subject", text: config.subject }) : null,
      ...cards,
      h(doc, "div", { class: "buttons" }, cancel)
    );
    cards[Math.max(0, OPTIONS.findIndex((o) => o.value === initial))].focus();
  }

  async function open(parentWindow, config) {
    const win = parentWindow.openDialog("about:blank", "scanfixer-chooser", "chrome,dialog=no,dependent,centerscreen,resizable=no,width=460,height=440");
    const sleep = (ms) => new Promise((r) => parentWindow.setTimeout(r, ms));
    for (let i = 0; i < 120; i++) {
      const d = win.document;
      if (d && d.readyState === "complete" && d.body && win.location.href === "about:blank") break;
      await sleep(25);
    }
    if (!win.document || !win.document.body) throw new Error("Could not open the ScanFixer window");
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
        win.resizeTo(win.outerWidth, Math.min(win.document.documentElement.scrollHeight + extra + 8, 700));
      } catch (e) { /* sizing is cosmetic */ }
      win.focus();
    });
  }

  return { open, buildForm, OPTIONS };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ScanFixerChooser;
