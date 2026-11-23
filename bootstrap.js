// Copyright (c) 2026 poimaino. MIT licence, see LICENSE in the repository root.
/* ScanFixer – Zotero 7 / 8 / 9 / 10 bootstrapped plugin
 *
 * Four commands. The item right-click menu has one "ScanFixer…" entry that opens a chooser; the PDF reader's menus have one entry for each (the "SF" button on the
 * reader's toolbar opens the same three, and the reader's page / thumbnail right-click menus pre-select pages):
 *
 *   Compress             makes a smaller black-and-white, greyscale or colour COPY, saved next to the file as
 *                        "… (compressed)". The file it started from is never changed. Text (in any script), links,
 *                        bookmarks and page numbers are carried over; form fields become flat.
 *   Compress, then fix   the same, and then opens that copy in the fix editor.
 *   Fix, then compress   fixes the file in place (with the usual backup), then compresses the fixed pages: cropped margins
 *                        and spine shadow are cut out before compressing. With several PDFs, "Compress" can reuse the first
 *                        window's settings for the rest (each copy is saved as soon as it is made).
 *   Fix pages            opens the visual editor in which pages can be split, cropped, turned, straightened and matched
 *                        in size. It looks at every page when it opens and sets the spine, the paper edges and the tilt;
 *                        these are ordinary guides that can be dragged, and a page can be reset. Comments (annotations)
 *                        are moved so they stay on the same point of the page. Changes can be undone (Ctrl/Cmd Z).
 *
 *   - The first time a file is fixed, a verified copy of the original is saved as "… (original)" and
 *     the fixed attachment is renamed "… (scanfixed)".
 *   - If the visual editor can't start, a simple numeric window is used instead.
 *   - Without a named command (Zotero 7's hand-made menu entry, or if the reader's menu can't open) a chooser window asks.
 */

var ScanFixerPlugin;

const SF_LABEL = "ScanFixer…";
/** The three things ScanFixer does. Each has its own entry in the item menu and the reader's menus; the chooser window is the fallback. */
const SF_ACTIONS = [
  { id: "fix", label: "ScanFixer: Fix pages…", short: "Fix pages…", hint: "Split, crop, straighten, remove and re-order pages" },
  { id: "compress", label: "ScanFixer: Compress…", short: "Compress…", hint: "Make a smaller copy, saved next to the original" },
  { id: "both", label: "ScanFixer: Compress, then fix…", short: "Compress, then fix…", hint: "Make the smaller copy, then fix its pages" },
  { id: "fixcompress", label: "ScanFixer: Fix, then compress…", short: "Fix, then compress…", hint: "Fix the pages, then make a smaller copy of the fixed file (cropped margins are cut out first)" },
];
const SF_COMPRESSED_SUFFIX = " (compressed)";
const SF_MENU_ID = "scanfixer-menu";
const SF_SUFFIX = " (scanfixed)";
/** "Paper (compressed) (scanfixed)" -> "Paper": every trailing ScanFixer suffix, so names never pile up. */
const sfStripSuffixes = (name) => {
  let out = String(name || "");
  for (let prev = null; prev !== out; ) { prev = out; out = out.replace(/ \((scanfixed|compressed)\)$/, ""); }
  return out;
};

function install() {}
function uninstall() {}

async function startup({ id, version, rootURI }, reason) {
  await Zotero.initializationPromise;

  // Nothing heavy is loaded at startup: the menu is registered below and the PDF code (pdf-lib,
  // the engine, the editor) is loaded the first time the command runs. See ensureLoaded().
  const loadScripts = () => {
    // pdf-lib uses setTimeout, which may not exist as a global in the bootstrap scope.
    if (typeof globalThis.setTimeout !== "function") {
      const Timer = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
      globalThis.setTimeout = Timer.setTimeout;
      globalThis.clearTimeout = Timer.clearTimeout;
    }
    // Bypass the script cache so an in-place plugin update can't keep running stale code.
    const loadScript = (url) => {
      if (typeof Services.scriptloader.loadSubScriptWithOptions === "function") {
        Services.scriptloader.loadSubScriptWithOptions(url, { ignoreCache: true });
      } else {
        Services.scriptloader.loadSubScript(url);
      }
    };
    loadScript(rootURI + "content/pdf-lib.min.js");
    loadScript(rootURI + "content/split.js");
    loadScript(rootURI + "content/dialog.js");
    loadScript(rootURI + "content/thumbs.js");
    loadScript(rootURI + "content/editor.js");
    loadScript(rootURI + "content/imageops.js");
    loadScript(rootURI + "content/compress.js");
    loadScript(rootURI + "content/compress-ui.js");
    loadScript(rootURI + "content/chooser.js");
  };

  ScanFixerPlugin = {
    id,
    version,
    rootURI,
    menuRegID: null,
    _tabObserver: null,
    _workerSource: null,
    _loaded: false,
    _legacy: new Map(), // window -> popupshowing handler (Zotero 7 fallback)
    CANCELLED: Symbol("cancelled"),
    UNAVAILABLE: Symbol("unavailable"),

    /** Load the PDF code on first use (keeps Zotero's startup and idle cost near zero). */
    ensureLoaded() {
      if (this._loaded) return;
      loadScripts();
      this._loaded = true;
    },

    // ------------------------------------------------------------------
    // Menus and buttons
    // ------------------------------------------------------------------
    init() {
      this.registerLibraryMenu();
      this.registerReaderUI();
    },

    registerLibraryMenu() {
      const MM = Zotero.MenuManager;
      if (MM?.registerMenu) {
        // Registration is idempotent: clear anything this plugin registered earlier (an in-place update
        // can leave a stale registration), then register exactly one entry.
        try { MM.unregisterMenu(SF_MENU_ID); } catch (e) { /* nothing was registered */ }
        const regID = MM.registerMenu({
          menuID: SF_MENU_ID,
          pluginID: this.id,
          target: "main/library/item",
          menus: [
            {
              menuType: "menuitem",
              onShowing: (event, context) => {
                context.menuElem?.setAttribute("label", SF_LABEL);
                context.setVisible(this.getTargets(this.itemsFrom(context)).length > 0);
              },
              onCommand: (event, context) => this.run({ items: this.itemsFrom(context) }), // no action named: the chooser asks
            },
          ],
        });
        if (!regID) Zotero.logError(new Error("ScanFixer: Zotero refused to register the menu item"));
        this.menuRegID = regID || null;
        return; // never also add hand-made items when Zotero has its own menu API (that made them appear twice)
      }
      // Zotero 7 (no MenuManager): inject into the item context menu by hand.
      for (const win of Zotero.getMainWindows()) this.addToWindow(win);
    },

    /**
     * Put the "SF" button on one reader's toolbar. `append` adds it to that toolbar. The button carries this version, so
     * an in-place plugin update replaces the previous version's button (whose click would still run the old code).
     * @returns {boolean} whether a button was added
     */
    addToolbarButton(reader, doc, append, force) {
      const old = doc.getElementById("scanfixer-toolbar-button");
      if (old && !force && old.getAttribute("data-build") === this.version) return false;
      old?.remove();
      const button = doc.createElement("button");
      button.id = "scanfixer-toolbar-button";
      button.className = "toolbar-button";
      button.setAttribute("data-build", this.version);
      button.setAttribute("title", "ScanFixer: fix or compress this PDF");
      button.setAttribute("aria-label", "ScanFixer");
      button.setAttribute("tabindex", "-1");
      button.style.cssText = "display:flex;align-items:center;justify-content:center;min-width:30px;";
      // a page with a dashed line down the middle (a spread to split); drawn with the toolbar's own text colour
      const SVG = "http://www.w3.org/2000/svg";
      const icon = doc.createElementNS(SVG, "svg");
      for (const [k, v] of Object.entries({ viewBox: "0 0 16 16", width: "16", height: "16", fill: "none", stroke: "currentColor", "stroke-width": "1.4", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) icon.setAttribute(k, v);
      const outline = doc.createElementNS(SVG, "rect");
      for (const [k, v] of Object.entries({ x: "2.5", y: "1.5", width: "11", height: "13", rx: "1" })) outline.setAttribute(k, v);
      const mid = doc.createElementNS(SVG, "path");
      mid.setAttribute("d", "M8 1.5v13");
      mid.setAttribute("stroke-dasharray", "2 1.6");
      icon.append(outline, mid);
      button.append(icon);
      button.addEventListener("click", () => {
        try {
          this.showActionMenu(reader, doc, button);
        } catch (e) {
          Zotero.logError(e);
          this.run({ reader, pages: this.currentPage(reader) }); // the menu couldn't open: ask in the chooser window instead
        }
      });
      append(button);
      return true;
    },

    /** The small menu under the reader's button: Fix / Compress / Compress then fix, acting on the page being viewed. */
    showActionMenu(reader, doc, anchor) {
      const old = doc.getElementById("scanfixer-action-menu");
      if (old) { old.remove(); return; } // a second click closes it
      const menu = doc.createElement("div");
      menu.id = "scanfixer-action-menu";
      menu.setAttribute("role", "menu");
      const r = anchor.getBoundingClientRect();
      menu.style.cssText = "position:fixed;z-index:2147483000;min-width:240px;padding:4px;border:1px solid GrayText;border-radius:6px;background:Canvas;color:CanvasText;color-scheme:light dark;box-shadow:0 4px 14px rgba(0,0,0,.3);font:13px system-ui,sans-serif;" +
        `top:${Math.round(r.bottom + 2)}px;right:${Math.max(4, Math.round(doc.documentElement.clientWidth - r.right))}px;`;
      const items = [];
      const close = () => {
        menu.remove();
        doc.removeEventListener("mousedown", onDown, true);
        doc.removeEventListener("keydown", onKey, true);
      };
      const onDown = (e) => { if (!menu.contains(e.target) && e.target !== anchor) close(); };
      const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); anchor.focus?.(); return; }
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        const at = items.indexOf(doc.activeElement);
        items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
      };
      for (const a of SF_ACTIONS) {
        const item = doc.createElement("button");
        item.setAttribute("role", "menuitem");
        item.setAttribute("title", a.hint);
        item.textContent = a.short;
        item.style.cssText = "display:block;width:100%;text-align:left;padding:6px 10px;border:0;border-radius:4px;background:transparent;color:inherit;font:inherit;cursor:pointer;";
        const light = (on) => { item.style.background = on ? "Highlight" : "transparent"; item.style.color = on ? "HighlightText" : "inherit"; };
        item.addEventListener("mouseenter", () => light(true));
        item.addEventListener("mouseleave", () => light(false));
        item.addEventListener("focus", () => light(true));
        item.addEventListener("blur", () => light(false));
        item.addEventListener("click", () => { close(); this.run({ reader, pages: this.currentPage(reader), action: a.id }); });
        items.push(item);
        menu.append(item);
      }
      (doc.body || doc.documentElement).append(menu);
      doc.addEventListener("mousedown", onDown, true);
      doc.addEventListener("keydown", onKey, true);
      items[0].focus();
    },

    /** Add the button to every open PDF reader that doesn't have this version's button. Safe to call any number of times. */
    sweepToolbars() {
      for (const reader of Zotero.Reader?._readers || []) {
        try {
          if (reader.type && reader.type !== "pdf") continue;
          const doc = reader._iframeWindow?.document;
          const bar = doc && (doc.querySelector(".toolbar .end") || doc.querySelector(".toolbar"));
          if (!bar) continue; // not drawn yet: a later sweep will get it
          const existing = doc.getElementById("scanfixer-toolbar-button");
          if (existing && bar.contains(existing) && existing.getAttribute("data-build") === this.version) continue;
          this.addToolbarButton(reader, doc, (el) => bar.append(el), true);
        } catch (e) {
          Zotero.logError(e);
        }
      }
    },

    scheduleSweeps(delays) {
      for (const ms of delays) {
        Zotero.Promise.delay(ms).then(() => { if (ScanFixerPlugin === this) this.sweepToolbars(); }).catch(() => {});
      }
    },

    removeToolbarButtons() {
      for (const reader of Zotero.Reader?._readers || []) {
        try { reader._iframeWindow?.document?.getElementById("scanfixer-toolbar-button")?.remove(); } catch (e) { /* reader is closing */ }
      }
    },

    registerReaderUI() {
      if (!Zotero.Reader?.registerEventListener) return;
      const reg = (type, handler) => Zotero.Reader.registerEventListener(type, handler, this.id);

      // The "SF" button on the PDF viewer's toolbar. Zotero sends this event when it draws a toolbar, which does not
      // happen for a tab it restored before this plugin started: sweepToolbars() covers those.
      reg("renderToolbar", (event) => {
        const { reader, doc, append } = event;
        if (reader.type && reader.type !== "pdf") return;
        this.addToolbarButton(reader, doc, append, true); // the toolbar is re-rendered often: always put a fresh one
      });

      // Readers that were already open when the plugin started (Zotero reopens the last tab before plugins load).
      this.sweepToolbars();
      this.scheduleSweeps([500, 2000, 6000, 15000]);
      try {
        this._tabObserver = Zotero.Notifier.registerObserver(
          { notify: (event, type) => { if (type === "tab" && ["add", "select", "load"].includes(event)) this.scheduleSweeps([200, 1200]); } },
          ["tab"],
          "scanfixer"
        );
      } catch (e) {
        Zotero.logError(e);
      }

      // Right-click on a page thumbnail / on the page: same command, with pages pre-selected.
      const menuEntry = (type, pagesFor) =>
        reg(type, (event) => {
          const { reader, params, append } = event;
          if (reader.type && reader.type !== "pdf") return;
          for (const a of SF_ACTIONS) append({ label: a.label, onCommand: () => this.run({ reader, pages: pagesFor(reader, params), action: a.id }) });
        });
      menuEntry("createThumbnailContextMenu", (reader, params) => this.pagesFromParams(params, reader));
      menuEntry("createViewContextMenu", (reader) => this.currentPage(reader));
    },

    itemsFrom(context) {
      return context?.items || Zotero.getActiveZoteroPane().getSelectedItems();
    },

    addToWindow(window) {
      const doc = window.document;
      const menu = doc.getElementById("zotero-itemmenu");
      if (!menu || doc.getElementById("scanfixer-menuitem")) return;
      const sep = doc.createXULElement("menuseparator");
      sep.id = "scanfixer-separator";
      const item = doc.createXULElement("menuitem");
      item.id = "scanfixer-menuitem";
      item.setAttribute("label", SF_LABEL);
      item.addEventListener("command", () => this.run({ items: window.ZoteroPane.getSelectedItems() }));
      menu.append(sep, item);
      const handler = () => {
        const show = this.getTargets(window.ZoteroPane.getSelectedItems()).length > 0;
        sep.hidden = item.hidden = !show;
      };
      menu.addEventListener("popupshowing", handler);
      this._legacy.set(window, handler);
    },

    removeFromWindow(window) {
      const doc = window.document;
      const menu = doc.getElementById("zotero-itemmenu");
      const handler = this._legacy.get(window);
      if (menu && handler) menu.removeEventListener("popupshowing", handler);
      this._legacy.delete(window);
      for (const id of ["scanfixer-menuitem", "scanfixer-compress-menuitem", "scanfixer-separator"]) doc.getElementById(id)?.remove();
    },

    // ------------------------------------------------------------------
    // Selection helpers
    // ------------------------------------------------------------------
    isPDF(item) {
      return !!item && item.isFileAttachment() && item.attachmentContentType === "application/pdf";
    },

    /** Is this attachment one of the copies ScanFixer made itself (the "… (original)" backup or a "… (compressed)" copy)? */
    isOurCopy(att) {
      return /\((original|compressed|before edit)\)(?: \(scanfixed\))*$/.test((att && att.getField("title")) || "");
    },

    /**
     * PDF attachments implied by a selection: selected PDFs plus PDFs under selected parents. Under a parent, ScanFixer's
     * own "(original)" / "(compressed)" copies are left out (a PDF the person selected directly is always included).
     */
    getTargets(items) {
      const out = [];
      for (const it of items || []) {
        if (this.isPDF(it)) out.push(it);
        else if (it.isRegularItem()) {
          for (const attID of it.getAttachments()) {
            const a = Zotero.Items.get(attID);
            if (this.isPDF(a) && !this.isOurCopy(a)) out.push(a);
          }
        }
      }
      return [...new Map(out.map((a) => [a.id, a])).values()];
    },

    /** Best-effort access to the reader's internal pdf.js viewer (undocumented, so all guarded). */
    pdfViewerApp(reader) {
      try {
        const w = reader._iframeWindow?.wrappedJSObject;
        const view = w?._reader?._primaryView || w?._reader?._lastView || reader._internalReader?._primaryView;
        return view?._iframeWindow?.wrappedJSObject?.PDFViewerApplication || view?._iframeWindow?.PDFViewerApplication || null;
      } catch (e) {
        return null;
      }
    },

    currentPageIndex(reader) {
      try {
        const page = this.pdfViewerApp(reader)?.page;
        return Number.isInteger(page) && page > 0 ? page - 1 : null;
      } catch (e) {
        return null;
      }
    },

    /** The page being viewed, as `{ indexes, source }` (or null if it can't be determined). */
    currentPage(reader) {
      const i = this.currentPageIndex(reader);
      return i === null ? null : { indexes: [i], source: "the page you are viewing" };
    },

    /** Page selection from a thumbnail context menu's params (shape isn't documented: be defensive). */
    pagesFromParams(params, reader) {
      const raw = params?.pageIndexes ?? params?.ids;
      const nums = Array.isArray(raw) ? raw.map(Number).filter((n) => Number.isInteger(n) && n >= 0) : [];
      if (nums.length) return { indexes: nums, source: "the thumbnails you right-clicked" };
      return this.currentPage(reader);
    },

    /** [2,3,4,9] (0-based) -> "3-5, 10" (1-based, as shown in the reader). */
    toPageSpec(indexes) {
      const s = [...new Set(indexes)].sort((a, b) => a - b);
      const parts = [];
      for (let i = 0; i < s.length; ) {
        let j = i;
        while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
        parts.push(j > i ? `${s[i] + 1}-${s[j] + 1}` : `${s[i] + 1}`);
        i = j + 1;
      }
      return parts.join(", ");
    },

    // ------------------------------------------------------------------
    // Progress window and file helpers
    // ------------------------------------------------------------------
    async withProgress(headline, targets, work) {
      const pw = new Zotero.ProgressWindow({ closeOnClick: true });
      pw.changeHeadline(headline);
      pw.show();
      let failures = 0;
      for (const att of targets) {
        const title = att.getDisplayTitle();
        const prog = new pw.ItemProgress(att.getImageSrc?.() || "", title);
        try {
          const outcome = await work(att);
          const warn = !!(outcome && typeof outcome === "object" && outcome.warn);
          const text = outcome && typeof outcome === "object" ? outcome.text : outcome;
          if (warn) {
            failures++; // nothing was produced: show it like a problem, and keep the window open longer
            prog.setError();
          } else {
            prog.setProgress(100);
          }
          prog.setText(`${title}: ${text}`);
        } catch (e) {
          failures++;
          Zotero.logError(e);
          Zotero.debug("[ScanFixer] " + (e.stack || e));
          prog.setError();
          prog.setText(`${title}: ${this.friendlyError(e)}`);
        }
      }
      pw.startCloseTimer(failures ? 15000 : 6000);
      return failures;
    },

    /** An error as the person should read it. */
    friendlyError(e) {
      const msg = String((e && e.message) || e);
      if (/is encrypted|encrypt/i.test(msg) && /PDFDocument|encrypted/i.test(msg)) {
        return "This PDF is encrypted, so ScanFixer can't change it. That can mean a password, or only restrictions on printing or copying (it may open without asking for anything). Save a copy without the protection (for example, print it to a new PDF) and try again.";
      }
      return `${e && e.name && e.name !== "Error" ? e.name + ": " : ""}${msg}`;
    },

    /** Do these two byte arrays hold exactly the same bytes? (Used to check the copies it saves.) */
    sameBytes(a, b) {
      if (!a || !b || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    },

    async readPDF(att) {
      const library = Zotero.Libraries.get(att.libraryID);
      if (library && library.filesEditable === false) throw new Error("Files in this library are read-only");
      const path = await att.getFilePathAsync();
      if (!path) throw new Error("Attachment file not found");
      return { path, bytes: await IOUtils.read(path) };
    },

    /** The render worker script (pdf.js + glue), read once from the plugin package. */
    async getWorkerSource() {
      if (!this._workerSource) {
        const read = async (name) => {
          const url = this.rootURI + "content/" + name;
          try {
            return await Zotero.File.getContentsFromURLAsync(url);
          } catch (e) {
            return await (await fetch(url)).text();
          }
        };
        // the pixel routines (suggestions, greyscale / black-and-white) and the JPEG writer run inside the worker too
        this._workerSource = (await read("imageops.js")) + "\n" + (await read("jpeg.js")) + "\n" + (await read("render-worker.js"));
      }
      return this._workerSource;
    },

    // ------------------------------------------------------------------
    // Compress (a separate step: makes a smaller COPY, never changes the original)
    // ------------------------------------------------------------------
    /** PDFs to compress: the ones selected, plus those under selected parents (skipping our own "(original)" / "(compressed)" copies). */
    getCompressTargets(items) {
      return this.getTargets(items); // the same rule for Fix and Compress
    },

    /**
     * Compress each target in turn (one window each) and save each copy as soon as its window is done, so only one file's
     * pages are in memory at a time. In the first window "Use these settings for the other PDFs" skips the rest of the windows:
     * the others are compressed the same way with a small progress window. Cancelling stops the rest; copies already saved stay.
     */
    async runCompress(targets) {
      if (!targets.length) return;
      let rest = null; // the settings to reuse, once "use for the others" was ticked
      for (let k = 0; k < targets.length; k++) {
        const att = targets[k];
        let got;
        try {
          got = rest
            ? await this.compressBatchOne(att, rest, k, targets.length)
            : await this.compressDialog(att, { remaining: targets.length - k - 1 });
        } catch (e) {
          await this.withProgress("ScanFixer: Compress", [att], async () => { throw e; });
          continue;
        }
        if (got === this.CANCELLED) return;
        if (got.error) {
          await this.withProgress("ScanFixer: Compress", [att], async () => { throw new Error(got.error); });
          continue;
        }
        if (!rest && got.answer.rest) rest = got.answer.rest;
        await this.withProgress("ScanFixer: Compress", [att], async (a) => {
          const saved = await this.saveCompressed(a, got.answer, got.comments);
          return saved.notSmaller ? { text: saved.message, warn: true } : saved.message;
        });
        got = null; // let go of this file's pages before the next one starts
      }
    },

    /**
     * For each target: compress it, save the copy, then open that copy in the fix editor and apply the fix to it.
     * The copy is a throwaway of the real original, so no further "(original)" backup is made of it.
     * Cancelling the compress window stops everything; cancelling the fix editor keeps the compressed copy.
     */
    async runCompressThenFix(targets, extras) {
      for (let k = 0; k < targets.length; k++) {
        const att = targets[k];
        let dlg;
        try {
          dlg = await this.compressDialog(att);
        } catch (e) {
          await this.withProgress("ScanFixer: Compress", [att], async () => { throw e; });
          continue;
        }
        if (dlg === this.CANCELLED) return;
        let saved = null;
        await this.withProgress("ScanFixer: Compress", [att], async (a) => {
          saved = await this.saveCompressed(a, dlg.answer, dlg.comments);
          return saved.message;
        });
        let target = saved && saved.copy;
        if (!target) {
          if (!saved || !saved.notSmaller) continue; // the error was shown in the progress window
          const human = ScanFixerCompress.humanSize;
          const fixOriginal = Services.prompt.confirm(
            Zotero.getMainWindow(),
            "ScanFixer",
            `Compressing would not make this file smaller (${human(saved.originalSize)} → ${human(saved.newSize)}), so no compressed copy was saved.\n\nFix the original file instead?`
          );
          if (!fixOriginal) return;
          target = att;
        }
        const viaCopy = target !== att;
        let result;
        try {
          result = await this.editVisually(target, { ...(extras[k] || {}), compressedCopy: viaCopy });
        } catch (e) {
          await this.withProgress("ScanFixer", [target], async () => { throw e; });
          continue;
        }
        if (result === this.CANCELLED) return; // the compressed copy stays where it is
        if (result === this.UNAVAILABLE) {
          await this.runSimple([target], viaCopy ? { backup: false } : undefined);
          continue;
        }
        await this.applyJobs([{ att: target, plan: result, opts: viaCopy ? { backup: false } : undefined }]);
      }
    },

    /**
     * For each target: fix it in place (the usual "(original)" backup, then the editor's changes), then compress the fixed file
     * into a "… (compressed)" copy. The copy is made from the pages as they now look, so cropped margins and spine shadow are
     * cut out of the pixels and black-and-white thresholding works on the final page.
     * Cancelling the fix editor stops everything; cancelling the compress window keeps the fix.
     */
    async runFixThenCompress(targets, extras) {
      for (let k = 0; k < targets.length; k++) {
        const att = targets[k];
        let result;
        try {
          result = await this.editVisually(att, extras[k] || {});
        } catch (e) {
          await this.withProgress("ScanFixer", [att], async () => { throw e; });
          continue;
        }
        if (result === this.CANCELLED) return;
        let failed = 0;
        if (result === this.UNAVAILABLE) {
          failed = await this.runSimple([att]);
        } else {
          failed = await this.applyJobs([{ att, plan: result }]);
        }
        if (failed) continue; // the problem is in the progress window: don't compress a file that wasn't fixed
        let dlg;
        try {
          dlg = await this.compressDialog(att);
        } catch (e) {
          await this.withProgress("ScanFixer: Compress", [att], async () => { throw e; });
          continue;
        }
        if (dlg === this.CANCELLED) return; // the fix stays
        await this.withProgress("ScanFixer: Compress", [att], async (a) => {
          const saved = await this.saveCompressed(a, dlg.answer, dlg.comments);
          return saved.notSmaller ? { text: saved.message, warn: true } : saved.message;
        });
      }
    },

    /** What the Compress window (and the batch runner) need to know about one attachment. */
    async prepareCompress(att) {
      const { bytes } = await this.readPDF(att);
      const pages = await ScanFixer.describePages(PDFLib, bytes);
      let pageBytes = [];
      try { pageBytes = await ScanFixerCompress.pageImageBytes(PDFLib, bytes); } catch (e) { Zotero.logError(e); } // only used to keep each page smaller than it was
      // comments that can be carried onto the new file (not in the Trash, not running across two pages)
      const comments = this.commentsOf(att)
        .filter(({ annotation, position }) => !annotation.deleted && position.pageIndex < pages.length && ScanFixerCompress.movable(position))
        .map((c, key) => ({ ...c, key }));
      return {
        bytes, pages, pageBytes, comments,
        commentRequests: comments.map((c) => ({ key: c.key, page: c.position.pageIndex + 1, points: ScanFixerCompress.positionPoints(c.position) })),
      };
    },

    /** Show the Compress window for one attachment: pages are converted there, with a live preview. `opts.remaining` = PDFs still to come. */
    async compressDialog(att, opts = {}) {
      const { bytes, pages, pageBytes, comments, commentRequests } = await this.prepareCompress(att);
      let carry = null;
      try { carry = await ScanFixerCompress.inspect(PDFLib, bytes); } catch (e) { Zotero.logError(e); } // only used for the notes in the window
      const answer = await ScanFixerCompressor.open(Zotero.getMainWindow(), {
        title: "ScanFixer: Compress – " + att.getDisplayTitle(),
        carry,
        batch: { remaining: opts.remaining || 0 },
        pdfBytes: bytes,
        pageCount: pages.length,
        fileSize: bytes.length,
        pageBytes,
        comments: commentRequests,
        getWorkerSource: () => this.getWorkerSource(),
      });
      if (answer) answer.total = pages.length;
      return answer ? { answer, comments } : this.CANCELLED;
    },

    /** The same compression with settings chosen for an earlier file: a small progress window instead of the full one. */
    async compressBatchOne(att, rest, k, n) {
      const { bytes, pages, pageBytes, comments, commentRequests } = await this.prepareCompress(att);
      const answer = await ScanFixerCompressor.runBatch(Zotero.getMainWindow(), {
        title: "ScanFixer: Compress – " + att.getDisplayTitle(),
        subject: `Compressing PDF ${k + 1} of ${n}`,
        fileName: att.getDisplayTitle(),
        pdfBytes: bytes,
        fileSize: bytes.length,
        pageBytes,
        comments: commentRequests,
        getWorkerSource: () => this.getWorkerSource(),
      }, rest);
      if (!answer) return this.CANCELLED;
      if (answer.error) return { error: answer.error };
      answer.total = pages.length;
      return { answer, comments };
    },

    /** Build the smaller PDF and import it as a sibling attachment "… (compressed)". The source file is not touched. */
    async saveCompressed(att, answer, comments = []) {
      const { path, bytes: original } = await this.readPDF(att);
      const title = sfStripSuffixes(att.getField("title") || PathUtils.filename(path));
      const pageData = answer.pages.map((p) => ({
        kind: p.kind, predictor: !!p.predictor, colourSpace: p.colourSpace, w: p.w, h: p.h, widthPt: p.widthPt, heightPt: p.heightPt,
        bytes: new Uint8Array(p.bytes), // copy into this scope
        text: (p.text || []).map((t) => ({ s: String(t.s), t: Array.from(t.t, Number), w: Number(t.w) })),
      }));
      const built = await ScanFixerCompress.buildEx(PDFLib, pageData, { title: title + SF_COMPRESSED_SUFFIX, source: { bytes: original, order: answer.order } });
      const out = built.bytes, report = built.report;
      const human = ScanFixerCompress.humanSize;
      if (out.length >= original.length * 0.97) {
        return {
          copy: null, notSmaller: true, originalSize: original.length, newSize: out.length,
          message: `not saved: the result (${human(out.length)}) would not be smaller than the original (${human(original.length)}). Try a lower resolution or black & white.`,
        };
      }
      const tmpPath = PathUtils.join(PathUtils.tempDir, "scanfixer-compress-" + Date.now() + ".pdf");
      await IOUtils.write(tmpPath, out);
      let copy = null;
      try {
        copy = await Zotero.Attachments.importFromFile({
          file: Zotero.File.pathToFile(tmpPath),
          libraryID: att.libraryID,
          parentItemID: att.parentItemID || undefined,
          collections: att.parentItemID ? undefined : att.getCollections(),
          fileBaseName: sfStripSuffixes(PathUtils.filename(path).replace(/\.pdf$/i, "")) + SF_COMPRESSED_SUFFIX,
          contentType: "application/pdf",
          saveOptions: { skipSelect: true },
        });
        copy.setField("title", title + SF_COMPRESSED_SUFFIX);
        await copy.saveTx();
        const copyPath = await copy.getFilePathAsync();
        if (!copyPath || !this.sameBytes(await IOUtils.read(copyPath), out)) throw new Error("the saved copy did not verify");
      } catch (e) {
        if (copy) await copy.eraseTx().catch(Zotero.logError);
        throw new Error("Could not save the compressed copy, so nothing was added (" + (e.message || e) + ")");
      } finally {
        await IOUtils.remove(tmpPath, { ignoreAbsent: true }).catch(() => {});
      }
      await this.reindex(copy);
      const cfg = answer.settings || {};
      const carried = cfg.copyComments ? await this.copyComments(copy, comments, answer.mapped || {}, pageData, answer.order, report.labels) : { copied: 0 };
      const modeName = { bw: "black & white", gray: "greyscale", colour: "colour" }[cfg.mode] || "";
      const message = `saved as “… (compressed)”: ${human(original.length)} → ${human(out.length)} (${Math.round((1 - out.length / original.length) * 100)}% smaller${modeName ? ", " + modeName + " at " + cfg.dpi + " dpi" : ""}).` +
        (answer.total && answer.order && answer.order.length < answer.total ? ` ${answer.total - answer.order.length} page${answer.total - answer.order.length > 1 ? "s were" : " was"} left out.` : "") +
        (answer.squeezed ? ` ${answer.squeezed} page${answer.squeezed > 1 ? "s were" : " was"} lowered to stay smaller${answer.over ? ` (${answer.over} could not get smaller)` : ""}.` : "") +
        (report.links || report.bookmarks || report.labels ? ` Kept: ${[report.links && `${report.links} link${report.links > 1 ? "s" : ""}`, report.bookmarks && `${report.bookmarks} bookmark${report.bookmarks > 1 ? "s" : ""}`, report.labels && "page numbers"].filter(Boolean).join(", ")}.` : "") +
        (report.linksLost || report.bookmarksLost ? ` Left out: ${[report.linksLost && `${report.linksLost} link${report.linksLost > 1 ? "s" : ""}`, report.bookmarksLost && `${report.bookmarksLost} bookmark${report.bookmarksLost > 1 ? "s" : ""}`].filter(Boolean).join(", ")} (they led to removed pages or used actions that can't be carried over).` : "") +
        (report.forms ? " Form fields are now flat: what was filled in is still visible but can't be edited." : "") +
        (report.error ? ` Some extras could not be carried over (${report.error}).` : "") +
        (carried.copied ? ` ${carried.copied} comment${carried.copied > 1 ? "s" : ""} copied across.` : "") +
        (carried.error ? ` The comments could not be copied (${carried.error}); they are still on the original.` : "") +
        " The original was not changed.";
      return { copy, message };
    },

    /**
     * Copy comments onto the compressed attachment at their new positions, in one all-or-nothing step.
     * `mapped[key]` are the viewport points pdf.js gave for each comment (see ScanFixerCompress.mapPosition).
     * The originals stay where they are.
     */
    async copyComments(copy, comments, mapped, pageData, order, labels) {
      const made = [];
      const kept = order || pageData.map((_, k) => k); // kept[k] = the old page that is page k of the copy (pages may have been left out)
      const shifted = kept.some((v, k) => v !== k);
      try {
        await Zotero.DB.executeTransaction(async () => {
          for (const { annotation, position, key } of comments) {
            const points = mapped[key];
            const at = kept.indexOf(position.pageIndex); // a comment on a page that was left out stays on the original only
            const page = pageData[at];
            if (at < 0 || !points || !page) continue;
            const moved = ScanFixerCompress.mapPosition(position, Array.from(points, (p) => [Number(p[0]), Number(p[1])]), page.heightPt);
            moved.pageIndex = at;
            const a = new Zotero.Item("annotation");
            a.libraryID = copy.libraryID;
            a.parentID = copy.id;
            a.annotationType = annotation.annotationType;
            a.annotationText = annotation.annotationText || "";
            a.annotationComment = annotation.annotationComment || "";
            a.annotationColor = annotation.annotationColor;
            a.annotationPageLabel = labels && labels[at] !== undefined ? labels[at] : shifted ? String(at + 1) : annotation.annotationPageLabel || "";
            a.annotationSortIndex = shifted ? [String(at).padStart(5, "0"), ...String(annotation.annotationSortIndex || "").split("|").slice(1)].join("|") : annotation.annotationSortIndex;
            a.annotationPosition = JSON.stringify(moved);
            for (const t of annotation.getTags ? annotation.getTags() : []) a.addTag(t.tag, t.type);
            await a.save();
            made.push(a);
          }
        });
        return { copied: made.length };
      } catch (e) {
        Zotero.logError(e);
        return { copied: 0, error: e.message || String(e) };
      }
    },

    /** Where an old page lands in the new file (its first half, if it was split). A removed page goes to the nearest kept page before it. */
    newPageIndex(pageMap, index) {
      for (let k = index; k >= 0; k--) {
        const m = pageMap.find((x) => x.old === k && !x.excluded);
        if (m) return m.index;
      }
      return 0;
    },

    // ------------------------------------------------------------------
    // The command
    // ------------------------------------------------------------------
    /** @param {{items?: object[], reader?: object, pages?: {indexes:number[], source:string}|null, action?: "fix"|"compress"|"both"}} ctx
     *  With `action` the chooser window is skipped; without it, the chooser asks. */
    async run(ctx) {
      this.ensureLoaded();
      let targets;
      if (ctx.reader) {
        const att = Zotero.Items.get(ctx.reader.itemID);
        targets = att ? [att] : [];
      } else {
        targets = this.getTargets(ctx.items);
      }
      if (!targets.length) return;
      try {
        const direct = SF_ACTIONS.some((a) => a.id === ctx.action) ? ctx.action : null;
        const choice = direct || (await this.chooseAction(targets)); // no action named (the old single menu entry, or the menu couldn't open): ask
        if (!choice) return;
        if (direct) { try { Zotero.Prefs.set("extensions.scanfixer.lastAction", direct, true); } catch (e) { /* not remembered */ } }
        const idx = ctx.pages && ctx.pages.indexes.length ? ctx.pages.indexes : null;
        const extra = {
          initialPage: idx ? idx[0] : undefined,
          selection: idx && idx.length > 1 ? this.toPageSpec(idx) : undefined,
        };
        if (choice === "fix") {
          await this.runVisual(targets, targets.map(() => extra));
          return;
        }
        if (choice === "fixcompress") {
          const list = ctx.reader ? targets : this.getCompressTargets(ctx.items);
          if (list.length) await this.runFixThenCompress(list, list.map(() => extra));
          return;
        }
        // compressing: leave out our own "(original)" / "(compressed)" copies when a whole item was selected
        const toCompress = ctx.reader ? targets : this.getCompressTargets(ctx.items);
        if (!toCompress.length) return;
        if (choice === "compress") await this.runCompress(toCompress);
        else await this.runCompressThenFix(toCompress, toCompress.map(() => extra));
      } finally {
        this._workerSource = null; // don't keep the ~3 MB renderer script in memory between uses
      }
    },

    /** The first window: compress only / compress then fix / fix only. Remembers the last choice. */
    async chooseAction(targets) {
      const PREF = "extensions.scanfixer.lastAction";
      let initial = "fix";
      try {
        const v = Zotero.Prefs.get(PREF, true);
        if (["compress", "both", "fixcompress", "fix"].includes(v)) initial = v;
      } catch (e) { /* no saved choice */ }
      let choice;
      try {
        choice = await ScanFixerChooser.open(Zotero.getMainWindow(), {
          title: "ScanFixer",
          subject: targets.length === 1 ? targets[0].getDisplayTitle() : `${targets.length} PDFs`,
          initial,
        });
      } catch (e) {
        Zotero.logError(e);
        return "fix"; // the question window couldn't open: do what the plugin always did
      }
      if (choice) {
        try { Zotero.Prefs.set(PREF, choice, true); } catch (e) { /* not remembered */ }
      }
      return choice;
    },

    /** Edit each target in turn, then apply everything. Nothing changes if you cancel any editor. */
    async runVisual(targets, extras) {
      const jobs = [];
      let fallback = null;
      for (let k = 0; k < targets.length; k++) {
        let result;
        try {
          result = await this.editVisually(targets[k], extras[k] || {});
        } catch (e) {
          await this.withProgress("ScanFixer", [targets[k]], async () => { throw e; });
          continue;
        }
        if (result === this.CANCELLED) return;
        if (result === this.UNAVAILABLE) { fallback = targets.slice(k); break; }
        jobs.push({ att: targets[k], plan: result });
      }
      await this.applyJobs(jobs);
      if (fallback) await this.runSimple(fallback);
    },

    async applyJobs(jobs) {
      if (!jobs.length) return 0;
      const plans = new Map(jobs.map((j) => [j.att.id, j.plan]));
      const options = new Map(jobs.map((j) => [j.att.id, j.opts]));
      return this.withProgress("ScanFixer…", jobs.map((j) => j.att), (att) => this.applyPlanTo(att, plans.get(att.id), options.get(att.id))); // how many failed
    },

    /** Comments on this attachment as { annotation, position } (those whose position can be read). */
    commentsOf(att) {
      const out = [];
      for (const annotation of att.getAnnotations(true)) {
        try {
          const position = JSON.parse(annotation.annotationPosition);
          if (position && Number.isInteger(position.pageIndex)) out.push({ annotation, position });
        } catch (e) { /* not a position we understand: leave it alone */ }
      }
      return out;
    },

    /**
     * Run the visual editor for one attachment.
     * @returns {Promise<object|symbol>} a plan, or CANCELLED, or UNAVAILABLE (couldn't start)
     */
    async editVisually(att, extra = {}) {
      const { bytes } = await this.readPDF(att); // a file we can't read isn't an editor problem: let the caller report it
      const pages = await ScanFixer.describePages(PDFLib, bytes);
      const pdfBytes = pages.some((p) => p.partial) ? await ScanFixer.previewCopy(PDFLib, bytes) : bytes;
      const processed = pages.some((p) => p.fixed);

      // where the comments sit, so the editor can draw them and warn if a crop would cut one off
      const comments = this.commentsOf(att);
      const annotations = {};
      for (const { position } of comments) {
        const info = pages[position.pageIndex];
        if (!info) continue;
        for (const r of ScanFixer.visualRectsOf(info, position)) (annotations[position.pageIndex] ||= []).push(r);
      }
      const firstLandscape = pages.findIndex((p) => p.landscape);
      try {
        const answer = await ScanFixerEditor.open(Zotero.getMainWindow(), {
          title: "ScanFixer – " + att.getDisplayTitle(),
          processed,
          pages,
          pdfBytes,
          annotations,
          getWorkerSource: () => this.getWorkerSource(),
          parsePages: (text, n) => ScanFixer.parsePageSpec(text, n),
          initialPage: extra.initialPage ?? (!processed && firstLandscape >= 0 ? firstLandscape : 0),
          selection: extra.selection,
          warnings: [],
          notes: [
            processed
              ? "Already fixed: changes are made in place. Dimmed areas are hidden and can be restored."
              : extra.compressedCopy
                ? "Working on the compressed copy. Your original is untouched, so no extra backup is made."
                : "A verified copy of the original is saved first, as “… (original)”.",
            comments.length
              ? `${comments.length} comment${comments.length > 1 ? "s" : ""} will follow their page content. Comments on removed pages go to the Trash.`
              : "Images are never re-compressed here.",
            "Cropping hides the rest of a page but does not delete it: cropped-out content stays inside the file (and can be restored). To remove it for good, use Compress.",
          ],
        });
        return answer ? answer.plan : this.CANCELLED;
      } catch (e) {
        Zotero.logError(e);
        Zotero.debug("[ScanFixer] visual editor unavailable: " + (e.stack || e));
        Services.prompt.alert(
          Zotero.getMainWindow(),
          "ScanFixer",
          "The page preview couldn't start (" + (e.message || e) + "), so the simpler options window will be used instead."
        );
        return this.UNAVAILABLE;
      }
    },

    /** The plain numeric windows: used only if the visual editor can't start. They produce the same kind of plan. */
    async runSimple(targets, opts) {
      const jobs = [];
      let problems = 0; // returned with the number of failures, so a caller can tell whether the fix happened
      const win = Zotero.getMainWindow();
      for (const att of targets) {
        try {
          const { bytes } = await this.readPDF(att);
          const pages = await ScanFixer.describePages(PDFLib, bytes);
          let plan;
          if (!pages.some((p) => p.fixed)) {
            const opts = await ScanFixerDialog.open(win, {
              mode: "split",
              title: "ScanFixer – " + att.getDisplayTitle(),
              intro: "Cut each landscape page down the middle into two pages.",
              warnings: [],
              notes: ["A verified copy of the original is saved first, as “… (original)”."],
            });
            if (!opts) return 1;
            plan = ScanFixer.planFromSplitOptions(pages, opts);
          } else {
            const answer = await ScanFixerDialog.open(win, {
              mode: "adjust",
              title: "ScanFixer – " + att.getDisplayTitle(),
              intro: "Move the edges of some pages.",
              pages: { value: "", hint: "Page numbers as shown in the reader. Combine with commas: 1, 4-9, 12." },
              notes: ["Only the visible area changes. Run it again to fine-tune or undo."],
            });
            if (!answer) return 1;
            plan = ScanFixer.planFromEdges(pages, ScanFixer.parsePageSpec(answer.pagesText, pages.length), answer.edges);
          }
          jobs.push({ att, plan, opts });
        } catch (e) {
          await this.withProgress("ScanFixer", [att], async () => { throw e; });
          problems++;
        }
      }
      return (await this.applyJobs(jobs)) + problems;
    },

    // ------------------------------------------------------------------
    // Applying a plan
    // ------------------------------------------------------------------
    /**
     * 1. work out the new file and where every comment goes (nothing touched yet)
     * 2. first time only: save a verified copy of the original
     * 3. write the new file   4. move the comments (one all-or-nothing step)   5. first time only: rename
     * If moving the comments fails, the file is put back, so file and comments always agree.
     */
    async applyPlanTo(att, plan, opts = {}) {
      const { path, bytes: original } = await this.readPDF(att);
      const processed = (await ScanFixer.describePages(PDFLib, original)).some((p) => p.fixed);
      const res = await ScanFixer.applyPlan(PDFLib, original, plan);

      const moves = [];
      const trashes = [];
      let outside = 0;
      for (const { annotation, position } of this.commentsOf(att)) {
        const r = ScanFixer.relocateAnnotation(res.pageMap, position);
        if (!r) continue;
        if (r.excluded) { // its page isn't in the new file: the Trash, not oblivion
          if (!annotation.deleted) trashes.push(annotation);
          continue;
        }
        if (r.outside) outside++;
        const json = JSON.stringify(r.position);
        // page numbers were set by hand: the comment shows the number of the page it is now on
        // (when the file's own page numbers were dropped because pages moved, the reader shows plain 1, 2, 3…: match that)
        const label = res.labels ? res.labels[r.pageIndex] : res.labelsDropped ? String(r.pageIndex + 1) : undefined;
        const labelChanged = label !== undefined && label !== (annotation.annotationPageLabel || "");
        if (json === annotation.annotationPosition && !labelChanged) continue; // unchanged: leave it alone
        moves.push({
          annotation, json, label: labelChanged ? label : undefined, sortIndex: ScanFixer.sortIndexFor(annotation.annotationSortIndex, r.pageIndex, r.top),
          was: { position: annotation.annotationPosition, sortIndex: annotation.annotationSortIndex, label: annotation.annotationPageLabel },
        });
      }

      let backup = null;
      if (!processed && opts.backup !== false) backup = await this.backupOriginal(att, path, original); // a compressed copy has its own untouched original, so it needs none
      else if (processed && opts.backup !== false && res.excluded && !this.hasBackupSibling(att)) {
        // already fixed once, but its "(original)" is gone and this edit removes pages for good: keep what it looked like until now
        backup = await this.backupOriginal(att, path, original, " (before edit)");
      }

      const open = await this.closeReaders(att);
      const reopenAsWas = () => this.reopenReaders(att, open.map((o) => ({ pageIndex: o.pageIndex })));
      try {
        await IOUtils.write(path, res.bytes, { tmpPath: path + ".scanfixer.tmp" });
      } catch (e) {
        // the file was not changed (the write goes through a temporary file): take the backup back out, so a retry doesn't make a second one
        if (backup) await backup.eraseTx().catch(Zotero.logError);
        await reopenAsWas();
        throw e;
      }
      try {
        if (moves.length || trashes.length) {
          await Zotero.DB.executeTransaction(async () => {
            for (const m of moves) {
              m.annotation.annotationPosition = m.json;
              m.annotation.annotationSortIndex = m.sortIndex;
              if (m.label !== undefined) m.annotation.annotationPageLabel = m.label;
              await m.annotation.save();
            }
            for (const a of trashes) {
              a.deleted = true;
              await a.save();
            }
          });
        }
      } catch (e) {
        // undo everything: the database rolled back, so put the in-memory comments back too, and the file
        for (const m of moves) { m.annotation.annotationPosition = m.was.position; m.annotation.annotationSortIndex = m.was.sortIndex; if (m.label !== undefined) m.annotation.annotationPageLabel = m.was.label; }
        for (const a of trashes) a.deleted = false;
        await IOUtils.write(path, original, { tmpPath: path + ".scanfixer.tmp" }); // put the file back
        if (backup) await backup.eraseTx().catch(Zotero.logError);
        await reopenAsWas();
        throw new Error("Couldn't move the comments, so nothing was changed (" + (e.message || e) + ")");
      }
      if (!processed) await this.markScanFixed(att);
      await this.reindex(att);
      await this.reopenReaders(att, open.map((o) => ({ pageIndex: o.pageIndex === null ? null : this.newPageIndex(res.pageMap, o.pageIndex) })));

      const parts = [];
      if (res.split) parts.push(`${res.split} spread(s) split → ${res.pagesOut} pages`);
      if (res.cropped) parts.push(`${res.cropped} page(s) cropped`);
      if (plan.normalize) parts.push("page sizes matched");
      if (res.transformed && !plan.normalize) parts.push(`${res.transformed} page(s) turned or straightened`);
      if (res.excluded) parts.push(`${res.excluded} page(s) removed`);
      if (plan.order && plan.order.some((v, k) => v !== k)) parts.push("pages re-ordered");
      if (res.labels) parts.push("page numbers set");
      if (moves.length) parts.push(`${moves.length} comment(s) moved`);
      if (trashes.length) parts.push(`${trashes.length} comment(s) on removed pages moved to the Trash`);
      if (outside) parts.push(`${outside} comment(s) now outside the kept area`);
      if (backup) parts.push("original saved");
      return (parts.join("; ") || "done") + ".";
    },

    /** Save a copy of the original as a sibling attachment "… (original)" and verify it. Throws if it can't be verified. */
    /** Does this attachment's parent still hold an "(original)" (or "(before edit)") copy? Always true without a parent (can't tell). */
    hasBackupSibling(att) {
      if (!att.parentItemID) return true;
      try {
        const parent = Zotero.Items.get(att.parentItemID);
        return parent.getAttachments().some((id) => id !== att.id && /\((original|before edit)\)$/.test(Zotero.Items.get(id)?.getField("title") || ""));
      } catch (e) { return true; }
    },

    async backupOriginal(att, path, original, suffix = " (original)") {
      const title = (att.getField("title") || PathUtils.filename(path)).replace(/ \(scanfixed\)$/, "");
      const backup = await Zotero.Attachments.importFromFile({
        file: Zotero.File.pathToFile(path),
        libraryID: att.libraryID,
        parentItemID: att.parentItemID || undefined,
        collections: att.parentItemID ? undefined : att.getCollections(),
        fileBaseName: PathUtils.filename(path).replace(/\.pdf$/i, "") + suffix,
        contentType: "application/pdf",
        saveOptions: { skipSelect: true },
      });
      try {
        backup.setField("title", title + suffix);
        await backup.saveTx();
        const backupPath = await backup.getFilePathAsync();
        if (!backupPath || !this.sameBytes(await IOUtils.read(backupPath), original)) throw new Error("backup verification failed");
      } catch (e) {
        await backup.eraseTx().catch(Zotero.logError);
        throw new Error("Could not create a verified copy of the original, so nothing was changed (" + (e.message || e) + ")");
      }
      return backup;
    },

    /** Name the fixed attachment "… (scanfixed)": its title, and (for stored files) its file name. */
    async markScanFixed(att) {
      try {
        const title = att.getField("title") || "";
        if (!title.endsWith(SF_SUFFIX)) {
          att.setField("title", title + SF_SUFFIX);
          await att.saveTx();
        }
        const stored = typeof att.isStoredFileAttachment === "function" ? att.isStoredFileAttachment() : true;
        const file = await att.getFilePathAsync();
        if (stored && file && !/ \(scanfixed\)\.pdf$/i.test(file)) {
          await att.renameAttachmentFile(PathUtils.filename(file).replace(/\.pdf$/i, "") + SF_SUFFIX + ".pdf");
        }
      } catch (e) {
        Zotero.logError(e); // the naming is cosmetic: don't fail the whole job over it
      }
    },

    // ------------------------------------------------------------------
    // Readers & index
    // ------------------------------------------------------------------
    /** Close reader tabs/windows showing this attachment; returns where each one was. */
    async closeReaders(att) {
      const was = [];
      try {
        const win = Zotero.getMainWindow();
        for (const r of [...(Zotero.Reader?._readers || [])]) {
          if ((r.itemID ?? r._item?.id) !== att.id) continue;
          was.push({ pageIndex: this.currentPageIndex(r) });
          if (r.tabID && win.Zotero_Tabs) win.Zotero_Tabs.close(r.tabID);
          else if (r._window) r._window.close();
        }
      } catch (e) {
        Zotero.logError(e);
      }
      if (was.length) await Zotero.Promise.delay(300);
      return was;
    },

    async reopenReaders(att, was) {
      for (const { pageIndex } of was) {
        try {
          await Zotero.Reader.open(att.id, pageIndex === null ? undefined : { pageIndex }, { allowDuplicate: false });
        } catch (e) {
          Zotero.logError(e); // not fatal: the user can just reopen the PDF
        }
      }
    },

    /** Refresh the full-text index; Zotero's sync picks up the changed file by itself. */
    async reindex(att) {
      // (Full-text internals were rewritten in Zotero 10, so check the method exists.)
      try {
        if (typeof Zotero.Fulltext?.indexItems === "function") await Zotero.Fulltext.indexItems([att.id]);
      } catch (e) {
        Zotero.logError(e);
      }
    },
  };

  ScanFixerPlugin.init();
}

function onMainWindowLoad({ window }) {
  // Only needed for the Zotero 7 fallback; MenuManager handles new windows itself.
  if (ScanFixerPlugin && !Zotero.MenuManager?.registerMenu) ScanFixerPlugin.addToWindow(window);
}

function onMainWindowUnload({ window }) {
  ScanFixerPlugin?.removeFromWindow(window);
}

/** Close any ScanFixer window that is still open. Closing runs each window's own cleanup, which stops its worker. */
function closeOpenWindows() {
  try {
    const wins = Services.wm.getEnumerator(null);
    const mine = [];
    while (wins.hasMoreElements()) {
      const w = wins.getNext();
      if (w && typeof w.name === "string" && w.name.startsWith("scanfixer-")) mine.push(w);
    }
    for (const w of mine) { try { w.close(); } catch (e) { /* already closing */ } }
  } catch (e) { Zotero.logError(e); }
}

function shutdown() {
  closeOpenWindows(); // an editor or compress window left open would keep its renderer running with code that is being unloaded
  if (ScanFixerPlugin) {
    if (ScanFixerPlugin.menuRegID) {
      try { Zotero.MenuManager.unregisterMenu(ScanFixerPlugin.menuRegID); } catch (e) { /* already gone */ }
    }
    for (const win of Zotero.getMainWindows()) ScanFixerPlugin.removeFromWindow(win);
    ScanFixerPlugin.removeToolbarButtons();
    if (ScanFixerPlugin._tabObserver) {
      try { Zotero.Notifier.unregisterObserver(ScanFixerPlugin._tabObserver); } catch (e) { /* already gone */ }
    }
  }
  ScanFixerPlugin = undefined;
}
