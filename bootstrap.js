/* ScanFixer – Zotero 7 / 8 / 9 / 10 bootstrapped plugin
 *
 * One command, "ScanFixer…", reachable from the item right-click menu and from an "SF" button on the
 * PDF reader's toolbar (and the reader's page / thumbnail right-click menus, which pre-select pages).
 * It opens a visual editor in which pages can be split, cropped, turned, straightened and matched in
 * size. Comments (annotations) are moved so they stay on the same point of the page.
 *
 *   - The first time a file is fixed, a verified copy of the original is saved as "… (original)" and
 *     the fixed attachment is renamed "… (scanfixed)".
 *   - If the visual editor can't start, a simple numeric window is used instead.
 */

var ScanFixerPlugin;

const SF_LABEL = "ScanFixer…";
const SF_MENU_ID = "scanfixer-menu";
const SF_SUFFIX = " (scanfixed)";

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
    loadScript(rootURI + "content/editor.js");
  };

  ScanFixerPlugin = {
    id,
    version,
    rootURI,
    menuRegID: null,
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
      this.removeStaleItems();
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
              onCommand: (event, context) => this.run({ items: this.itemsFrom(context) }),
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

    registerReaderUI() {
      if (!Zotero.Reader?.registerEventListener) return;
      const reg = (type, handler) => Zotero.Reader.registerEventListener(type, handler, this.id);

      // The "SF" button on the PDF viewer's toolbar.
      reg("renderToolbar", (event) => {
        const { reader, doc, append } = event;
        if (reader.type && reader.type !== "pdf") return;
        doc.getElementById("scanfixer-toolbar-button")?.remove(); // never two (the toolbar is re-rendered often)
        const button = doc.createElement("button");
        button.id = "scanfixer-toolbar-button";
        button.className = "toolbar-button";
        button.setAttribute("title", "ScanFixer: split, crop, straighten and tidy scanned pages");
        button.setAttribute("tabindex", "-1");
        button.textContent = "SF";
        button.style.cssText = "font-weight:600;font-size:11px;letter-spacing:.02em;min-width:30px;";
        button.addEventListener("click", () => this.run({ reader, pages: this.currentPage(reader) }));
        append(button);
      });

      // Right-click on a page thumbnail / on the page: same command, with pages pre-selected.
      const menuEntry = (type, pagesFor) =>
        reg(type, (event) => {
          const { reader, params, append } = event;
          if (reader.type && reader.type !== "pdf") return;
          append({ label: SF_LABEL, onCommand: () => this.run({ reader, pages: pagesFor(reader, params) }) });
        });
      menuEntry("createThumbnailContextMenu", (reader, params) => this.pagesFromParams(params, reader));
      menuEntry("createViewContextMenu", (reader) => this.currentPage(reader));
    },

    itemsFrom(context) {
      return context?.items || Zotero.getActiveZoteroPane().getSelectedItems();
    },

    /** Remove hand-made menu items left by this or the earlier-named plugin, so nothing shows twice. */
    removeStaleItems() {
      for (const win of Zotero.getMainWindows()) {
        for (const id of ["spread-splitter-menuitem", "spread-splitter-adjust-menuitem", "spread-splitter-separator"]) {
          win.document.getElementById(id)?.remove();
        }
      }
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
      for (const id of ["scanfixer-menuitem", "scanfixer-separator"]) doc.getElementById(id)?.remove();
    },

    // ------------------------------------------------------------------
    // Selection helpers
    // ------------------------------------------------------------------
    isPDF(item) {
      return !!item && item.isFileAttachment() && item.attachmentContentType === "application/pdf";
    },

    /** PDF attachments implied by a selection: selected PDFs plus PDFs under selected parents. */
    getTargets(items) {
      const out = [];
      for (const it of items || []) {
        if (this.isPDF(it)) out.push(it);
        else if (it.isRegularItem()) {
          for (const attID of it.getAttachments()) {
            const a = Zotero.Items.get(attID);
            if (this.isPDF(a)) out.push(a);
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
      pw.changeHeadline(`${headline} (v${this.version})`);
      pw.show();
      let failures = 0;
      for (const att of targets) {
        const title = att.getDisplayTitle();
        const prog = new pw.ItemProgress(att.getImageSrc?.() || "", title);
        try {
          const text = await work(att);
          prog.setProgress(100);
          prog.setText(`${title}: ${text}`);
        } catch (e) {
          failures++;
          Zotero.logError(e);
          Zotero.debug("[ScanFixer] " + (e.stack || e));
          prog.setError();
          prog.setText(`${title}: ${e.name && e.name !== "Error" ? e.name + ": " : ""}${e.message || e}`);
        }
      }
      pw.startCloseTimer(failures ? 15000 : 6000);
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
        const url = this.rootURI + "content/render-worker.js";
        try {
          this._workerSource = await Zotero.File.getContentsFromURLAsync(url);
        } catch (e) {
          this._workerSource = await (await fetch(url)).text();
        }
      }
      return this._workerSource;
    },

    /** Where a page index lands after earlier pages in the plan were split in two. */
    mapPageIndex(plan, index) {
      let shift = 0;
      for (const [k, spec] of Object.entries(plan.pages)) if (spec.rects.length === 2 && Number(k) < index) shift++;
      return index + shift;
    },

    // ------------------------------------------------------------------
    // The command
    // ------------------------------------------------------------------
    /** @param {{items?: object[], reader?: object, pages?: {indexes:number[], source:string}|null}} ctx */
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
      const idx = ctx.pages && ctx.pages.indexes.length ? ctx.pages.indexes : null;
      const extras = targets.map(() => ({
        initialPage: idx ? idx[0] : undefined,
        selection: idx && idx.length > 1 ? this.toPageSpec(idx) : undefined,
      }));
      try {
        await this.runVisual(targets, extras);
      } finally {
        this._workerSource = null; // don't keep the ~3 MB renderer script in memory between uses
      }
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
      if (!jobs.length) return;
      const plans = new Map(jobs.map((j) => [j.att.id, j.plan]));
      await this.withProgress("ScanFixer…", jobs.map((j) => j.att), (att) => this.applyPlanTo(att, plans.get(att.id)));
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
              ? "This file has already been through ScanFixer, so changes are made in place. Dimmed areas are currently hidden and can be brought back."
              : "The first time, a copy of the original is saved as “… (original)” and this attachment becomes “… (scanfixed)”. Nothing changes unless that copy is verified.",
            comments.length
              ? `${comments.length} comment${comments.length > 1 ? "s" : ""} will be moved so they stay on the same point of the page.`
              : "Only the visible area is changed; the scanned images are never re-compressed.",
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
    async runSimple(targets) {
      const jobs = [];
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
              notes: ["A copy of the original is saved first as “… (original)”. Comments are moved so they stay on the same point of the page."],
            });
            if (!opts) return;
            plan = ScanFixer.planFromSplitOptions(pages, opts);
          } else {
            const answer = await ScanFixerDialog.open(win, {
              mode: "adjust",
              title: "ScanFixer – " + att.getDisplayTitle(),
              intro: "Move the edges of some pages.",
              pages: { value: "", hint: "Page numbers as shown in the reader. Combine with commas: 1, 4-9, 12." },
              notes: ["Only the visible area changes; you can run this again to fine-tune or undo."],
            });
            if (!answer) return;
            plan = ScanFixer.planFromEdges(pages, ScanFixer.parsePageSpec(answer.pagesText, pages.length), answer.edges);
          }
          jobs.push({ att, plan });
        } catch (e) {
          await this.withProgress("ScanFixer", [att], async () => { throw e; });
        }
      }
      await this.applyJobs(jobs);
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
    async applyPlanTo(att, plan) {
      const { path, bytes: original } = await this.readPDF(att);
      const processed = (await ScanFixer.describePages(PDFLib, original)).some((p) => p.fixed);
      const res = await ScanFixer.applyPlan(PDFLib, original, plan);

      const moves = [];
      let outside = 0;
      for (const { annotation, position } of this.commentsOf(att)) {
        const r = ScanFixer.relocateAnnotation(res.pageMap, position);
        if (!r) continue;
        if (r.outside) outside++;
        const json = JSON.stringify(r.position);
        if (json === annotation.annotationPosition) continue; // unchanged: leave it alone
        moves.push({ annotation, json, sortIndex: ScanFixer.sortIndexFor(annotation.annotationSortIndex, r.pageIndex, r.top) });
      }

      let backup = null;
      if (!processed) backup = await this.backupOriginal(att, path, original);

      const open = await this.closeReaders(att);
      await IOUtils.write(path, res.bytes, { tmpPath: path + ".scanfixer.tmp" });
      try {
        if (moves.length) {
          await Zotero.DB.executeTransaction(async () => {
            for (const m of moves) {
              m.annotation.annotationPosition = m.json;
              m.annotation.annotationSortIndex = m.sortIndex;
              await m.annotation.save();
            }
          });
        }
      } catch (e) {
        await IOUtils.write(path, original, { tmpPath: path + ".scanfixer.tmp" }); // put the file back
        if (backup) await backup.eraseTx().catch(Zotero.logError);
        throw new Error("Couldn't move the comments, so nothing was changed (" + (e.message || e) + ")");
      }
      if (!processed) await this.markScanFixed(att);
      await this.reindex(att);
      await this.reopenReaders(att, open.map((o) => ({ pageIndex: o.pageIndex === null ? null : this.mapPageIndex(plan, o.pageIndex) })));

      const parts = [];
      if (res.split) parts.push(`${res.split} spread(s) split → ${res.pagesOut} pages`);
      if (res.cropped) parts.push(`${res.cropped} page(s) cropped`);
      if (plan.normalize) parts.push("page sizes matched");
      if (res.transformed && !plan.normalize) parts.push(`${res.transformed} page(s) turned or straightened`);
      if (moves.length) parts.push(`${moves.length} comment(s) moved`);
      if (outside) parts.push(`${outside} comment(s) now outside the kept area`);
      if (backup) parts.push("original saved");
      return (parts.join("; ") || "done") + ".";
    },

    /** Save a copy of the original as a sibling attachment "… (original)" and verify it. Throws if it can't be verified. */
    async backupOriginal(att, path, original) {
      const title = (att.getField("title") || PathUtils.filename(path)).replace(/ \(scanfixed\)$/, "");
      const backup = await Zotero.Attachments.importFromFile({
        file: Zotero.File.pathToFile(path),
        libraryID: att.libraryID,
        parentItemID: att.parentItemID || undefined,
        collections: att.parentItemID ? undefined : att.getCollections(),
        fileBaseName: PathUtils.filename(path).replace(/\.pdf$/i, "") + " (original)",
        contentType: "application/pdf",
        saveOptions: { skipSelect: true },
      });
      try {
        backup.setField("title", title + " (original)");
        await backup.saveTx();
        const backupPath = await backup.getFilePathAsync();
        const size = backupPath ? (await IOUtils.stat(backupPath)).size : -1;
        if (size !== original.length) throw new Error("backup verification failed");
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

function shutdown() {
  if (ScanFixerPlugin) {
    if (ScanFixerPlugin.menuRegID) {
      try { Zotero.MenuManager.unregisterMenu(ScanFixerPlugin.menuRegID); } catch (e) { /* already gone */ }
    }
    for (const win of Zotero.getMainWindows()) ScanFixerPlugin.removeFromWindow(win);
  }
  ScanFixerPlugin = undefined;
}
