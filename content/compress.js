// Copyright (c) 2026 poimaino. MIT licence, see LICENSE in the repository root.
/* Builds the "(compressed)" PDF from pages that the render worker has already converted.
 * Pure: needs only the pdf-lib namespace it is handed, so it runs in Node for tests.
 *
 *   ScanFixerCompress.build(PDFLib, pages, { title }) -> Promise<Uint8Array>
 *
 * Each entry of `pages` is what the worker's "compress" command returned:
 *   { kind: "jpeg" | "flate1", bytes, w, h, widthPt, heightPt, text?: [{ s, t:[a,b,c,d,e,f], w }] }
 *   jpeg    a JPEG (greyscale or colour pictures)
 *   flate1  1-bit black-and-white, zlib-compressed; `predictor: true` when PNG "Up" row filtering was applied (/Predictor 15)
 *   text    the page's old text layer in page space (points, origin top-left, y down), kept as invisible text
 * Pages come out as one picture filling the page. The text layer is written as invisible text in any script (a font
 * with no glyphs plus a ToUnicode map), and when `opts.source = { bytes, order }` is given the source's links, bookmarks
 * and page labels are carried over (order[k] = the source page that is page k). Form fields and comments are not:
 * the filled-in values stay visible in the picture but can't be edited, so the copy is flat there.
 */
var ScanFixerCompress = (function () {
  "use strict";

  // Invisible text can be in any script. Only characters that can't be searched or copied are removed: controls,
  // zero-width and direction marks, and lone surrogates.
  const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
  const INVISIBLE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
  const writable = (s) => String(s).replace(LONE, "").replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();

  /**
   * The font for the invisible text: a Type0 / Identity-H font with no font program. The text is never drawn, so it
   * needs no glyphs, only a code for each character and a ToUnicode map so search and copy give the real text back.
   * Every glyph is 0.5 em wide; addInvisibleText() stretches each line to the width it had on the old page.
   */
  function makeTextFont(P, doc) {
    const cidOf = new Map(), chars = [];
    let ref = null;
    const encode = (str) => {
      let hex = "", n = 0;
      for (const ch of str) {
        const cp = ch.codePointAt(0);
        let cid = cidOf.get(cp);
        if (!cid) {
          if (chars.length >= 65534) continue;
          chars.push(cp);
          cid = chars.length;
          cidOf.set(cp, cid);
        }
        hex += cid.toString(16).padStart(4, "0");
        n++;
      }
      return { hex, n };
    };
    const u16 = (cp) => {
      if (cp < 0x10000) return cp.toString(16).padStart(4, "0");
      const v = cp - 0x10000;
      return (0xD800 + (v >> 10)).toString(16) + (0xDC00 + (v & 0x3FF)).toString(16);
    };
    const use = () => (ref ||= doc.context.nextRef());
    const finish = () => {
      if (!ref) return;
      let cmap = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n";
      for (let i = 0; i < chars.length; i += 100) {
        const part = chars.slice(i, i + 100);
        cmap += part.length + " beginbfchar\n" + part.map((cp, j) => "<" + (i + j + 1).toString(16).padStart(4, "0") + "> <" + u16(cp) + ">").join("\n") + "\nendbfchar\n";
      }
      cmap += "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n";
      const tu = doc.context.register(doc.context.flateStream(cmap));
      const desc = doc.context.register(doc.context.obj({
        Type: "FontDescriptor", FontName: "ScanFixerGlyphless", Flags: 4, FontBBox: [0, -200, 1000, 800],
        ItalicAngle: 0, Ascent: 800, Descent: -200, CapHeight: 700, StemV: 80,
      }));
      const cid = doc.context.register(doc.context.obj({
        Type: "Font", Subtype: "CIDFontType2", BaseFont: "ScanFixerGlyphless",
        CIDSystemInfo: { Registry: P.PDFString.of("Adobe"), Ordering: P.PDFString.of("Identity"), Supplement: 0 },
        FontDescriptor: desc, DW: 500, CIDToGIDMap: "Identity",
      }));
      doc.context.assign(ref, doc.context.obj({
        Type: "Font", Subtype: "Type0", BaseFont: "ScanFixerGlyphless", Encoding: "Identity-H", DescendantFonts: [cid], ToUnicode: tu,
      }));
    };
    return { encode, use, finish, get count() { return chars.length; } };
  }

  function addImage(doc, page, P, entry) {
    const { PDFName, PDFNumber } = P;
    const bytes = new Uint8Array(entry.bytes);
    let ref;
    if (entry.kind === "jpeg") {
      const img = doc.context.stream(bytes, {
        Type: "XObject", Subtype: "Image", Width: entry.w, Height: entry.h,
        ColorSpace: entry.colourSpace || "DeviceRGB", BitsPerComponent: 8, Filter: "DCTDecode",
      });
      ref = doc.context.register(img);
    } else {
      const img = doc.context.stream(bytes, {
        Type: "XObject", Subtype: "Image", Width: entry.w, Height: entry.h,
        ColorSpace: "DeviceGray", BitsPerComponent: 1, Filter: "FlateDecode",
        ...(entry.predictor ? { DecodeParms: { Predictor: 15, Colors: 1, BitsPerComponent: 1, Columns: entry.w } } : {}),
      });
      ref = doc.context.register(img);
    }
    page.node.setXObject(PDFName.of("Im0"), ref);
    page.pushOperators(
      P.pushGraphicsState(),
      P.concatTransformationMatrix(entry.widthPt, 0, 0, entry.heightPt, 0, 0),
      P.drawObject("Im0"),
      P.popGraphicsState()
    );
  }

  const FONT_KEY = "SFG";
  function addInvisibleText(P, page, font, items, heightPt) {
    let drawn = 0;
    for (const it of items) {
      const str = writable(it.s);
      if (!str) continue;
      const [a, b, c, d, e, f] = it.t;
      // page space is y-down here; the PDF wants y-up
      const m = [a, -b, c, -d, e, heightPt - f];
      const scaleX = Math.hypot(m[0], m[1]);
      if (!(scaleX > 0.01)) continue;
      const { hex, n } = font.encode(str);
      if (!n) continue;
      const natural = n * 0.5 * scaleX; // width in points at this size (every glyph is half an em)
      const tz = natural > 0 && it.w > 0 ? Math.min(400, Math.max(10, (100 * it.w) / natural)) : 100;
      if (!drawn) page.node.setFontDictionary(P.PDFName.of(FONT_KEY), font.use());
      drawn++;
      page.pushOperators(
        P.pushGraphicsState(),
        P.beginText(),
        P.setFontAndSize(FONT_KEY, 1),
        P.setTextRenderingMode(P.TextRenderingMode.Invisible),
        P.PDFOperator.of("Tz", [P.PDFNumber.of(tz)]),
        P.setTextMatrix(m[0], m[1], m[2], m[3], m[4], m[5]),
        P.showText(P.PDFHexString.of(hex)),
        P.endText(),
        P.popGraphicsState()
      );
    }
    return drawn;
  }

  /** Build the file. Returns { bytes, report }; report says what was carried over from `opts.source` (see carryStructure). */
  async function buildEx(P, pages, opts = {}) {
    const doc = await P.PDFDocument.create();
    if (opts.title) doc.setTitle(opts.title);
    doc.setProducer("ScanFixer (compressed)");
    doc.setCreator("ScanFixer");
    const font = makeTextFont(P, doc);
    const report = { links: 0, linksLost: 0, bookmarks: 0, bookmarksLost: 0, labels: null, forms: 0, error: null };
    for (const entry of pages) {
      const page = doc.addPage([entry.widthPt, entry.heightPt]);
      addImage(doc, page, P, entry);
      if (entry.text && entry.text.length) addInvisibleText(P, page, font, entry.text, entry.heightPt);
    }
    font.finish();
    if (opts.source && opts.source.bytes) {
      try {
        await carryStructure(P, doc, pages, opts.source, report);
      } catch (e) {
        report.error = String((e && e.message) || e); // the pictures and text are fine; the extras are just missing
      }
    }
    return { bytes: await doc.save({ useObjectStreams: true }), report };
  }

  async function build(P, pages, opts = {}) {
    return (await buildEx(P, pages, opts)).bytes;
  }

  // ---- links, bookmarks and page labels
  // Everything below reads the source with pdf-lib and writes into the new document. A page of the new file is the page
  // as pdf.js shows it (CropBox, /Rotate), so source points go through the same transform pdf.js uses, then a y flip.
  const ROMAN = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  /** The text of a page label for number n in a numbering style ("D", "R", "r", "A", "a" or none). */
  function labelString(style, n) {
    if (style === "D") return String(n);
    if (style === "R" || style === "r") {
      let out = "", left = n;
      if (left < 1 || left > 3999) return String(n);
      for (const [v, t] of ROMAN) while (left >= v) { out += t; left -= v; }
      return style === "r" ? out.toLowerCase() : out;
    }
    if ((style === "A" || style === "a") && n >= 1) {
      const ch = String.fromCharCode((style === "A" ? 65 : 97) + ((n - 1) % 26));
      return ch.repeat(Math.floor((n - 1) / 26) + 1);
    }
    return "";
  }

  const textOf = (o) => {
    if (!o) return "";
    if (typeof o.decodeText === "function") { try { return o.decodeText(); } catch (e) { /* fall through */ } }
    return "";
  };
  const bytesText = (o) => { try { return String.fromCharCode(...o.asBytes()); } catch (e) { return ""; } };
  const bytesKey = (o) => { try { return Array.from(o.asBytes(), (b) => b.toString(16).padStart(2, "0")).join(""); } catch (e) { return ""; } };
  const numOr = (o, d) => (o && typeof o.asNumber === "function" ? o.asNumber() : d);

  /** pdf.js's page transform: user-space (x, y) -> viewport (x, y), y down, scale 1. */
  function viewTransform(page) {
    const mb = page.getMediaBox();
    let box = [mb.x, mb.y, mb.x + mb.width, mb.y + mb.height];
    try {
      const cb = page.getCropBox();
      const c = [Math.max(box[0], cb.x), Math.max(box[1], cb.y), Math.min(box[2], cb.x + cb.width), Math.min(box[3], cb.y + cb.height)];
      if (c[2] > c[0] && c[3] > c[1]) box = c;
    } catch (e) { /* no CropBox: the MediaBox is the view */ }
    let rot = 0;
    try { rot = ((Math.round(page.getRotation().angle / 90) * 90) % 360 + 360) % 360; } catch (e) { /* upright */ }
    const [x0, y0, x1, y1] = box;
    const w = rot % 180 ? y1 - y0 : x1 - x0, h = rot % 180 ? x1 - x0 : y1 - y0;
    const f = rot === 90 ? (x, y) => [y - y0, x - x0]
      : rot === 180 ? (x, y) => [x1 - x, y - y0]
      : rot === 270 ? (x, y) => [y1 - y, x1 - x]
      : (x, y) => [x - x0, y1 - y];
    return { f, w, h, box };
  }

  function nameTreeMap(P, root) {
    const out = new Map();
    const seen = new Set();
    const walk = (node, depth) => {
      if (!(node instanceof P.PDFDict) || seen.has(node) || depth > 30 || out.size > 100000) return;
      seen.add(node);
      const names = node.lookup(P.PDFName.of("Names"));
      if (names instanceof P.PDFArray) for (let i = 0; i + 1 < names.size(); i += 2) out.set(bytesKey(names.lookup(i)), names.lookup(i + 1));
      const kids = node.lookup(P.PDFName.of("Kids"));
      if (kids instanceof P.PDFArray) for (let i = 0; i < kids.size(); i++) walk(kids.lookup(i), depth + 1);
    };
    walk(root, 0);
    return out;
  }

  async function carryStructure(P, doc, pages, source, report) {
    const { PDFName, PDFDict, PDFArray, PDFRef, PDFNumber, PDFString, PDFHexString } = P;
    const src = await P.PDFDocument.load(source.bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
    const srcPages = src.getPages();
    const kept = (source.order || pages.map((_, k) => k)).filter((o) => o >= 0 && o < srcPages.length);
    const newOf = new Map(kept.map((o, k) => [o, k]));
    const oldOf = new Map(srcPages.map((p, i) => [String(p.ref), i]));
    const outPages = doc.getPages();
    const N = (s) => PDFName.of(s);
    const cat = src.catalog;

    const maps = new Map();
    const mapper = (o) => {
      if (maps.has(o)) return maps.get(o);
      const k = newOf.get(o), e = pages[k], vt = viewTransform(srcPages[o]);
      const sx = vt.w > 0 ? e.widthPt / vt.w : 1, sy = vt.h > 0 ? e.heightPt / vt.h : 1;
      const m = { vt, point: (x, y) => { const [vx, vy] = vt.f(x, y); return [vx * sx, e.heightPt - vy * sy]; } };
      maps.set(o, m);
      return m;
    };

    // forms: only noted (the picture already shows what was filled in)
    const form = cat.lookup(N("AcroForm"));
    const fields = form instanceof PDFDict ? form.lookup(N("Fields")) : null;
    report.forms = fields instanceof PDFArray ? fields.size() : 0;

    // destinations
    let namedDests = null;
    const resolveDest = (d, depth = 0) => {
      if (depth > 8 || !d) return null;
      if (d instanceof PDFArray) return d;
      if (d instanceof PDFDict) return resolveDest(d.lookup(N("D")), depth + 1);
      if (d instanceof PDFName) {
        const dests = cat.lookup(N("Dests"));
        return dests instanceof PDFDict ? resolveDest(dests.lookup(d), depth + 1) : null;
      }
      if (d instanceof PDFString || d instanceof PDFHexString) {
        if (!namedDests) {
          const names = cat.lookup(N("Names"));
          const tree = names instanceof PDFDict ? names.lookup(N("Dests")) : null;
          namedDests = tree ? nameTreeMap(P, tree) : new Map();
        }
        return resolveDest(namedDests.get(bytesKey(d)), depth + 1);
      }
      return null;
    };
    /** A destination of the source as an explicit destination in the new file, or null when its page is not there. */
    const mapDest = (d) => {
      const arr = resolveDest(d);
      if (!arr || arr.size() < 2) return null;
      const target = arr.get(0);
      const old = target instanceof PDFRef ? oldOf.get(String(target)) : undefined;
      const k = old === undefined ? undefined : newOf.get(old);
      if (k === undefined) return null;
      const type = String(arr.lookup(1));
      const nz = (i) => { const v = arr.lookup(i); return v instanceof PDFNumber ? v.asNumber() : null; };
      const m = mapper(old), box = m.vt.box;
      let at = null, zoom = null;
      if (type === "/XYZ" && nz(2) !== null && nz(3) !== null) { at = m.point(nz(2), nz(3)); zoom = nz(4) || null; }
      else if ((type === "/FitH" || type === "/FitBH") && nz(2) !== null) at = m.point(box[0], nz(2));
      else if ((type === "/FitV" || type === "/FitBV") && nz(2) !== null) at = m.point(nz(2), box[3]);
      return doc.context.obj(at ? [outPages[k].ref, "XYZ", round(at[0]), round(at[1]), zoom] : [outPages[k].ref, "Fit"]);
    };
    const actionOf = (holder) => {
      // -> { dest } | { uri } | null (an action we leave out)
      const a = holder.lookup(N("A"));
      if (a instanceof PDFDict) {
        const s = String(a.lookup(N("S")));
        if (s === "/GoTo") return { dest: a.lookup(N("D")) };
        if (s === "/URI") {
          const uri = bytesText(a.lookup(N("URI")));
          return uri && !/^\s*(javascript|data|file|vbscript):/i.test(uri) ? { uri } : null;
        }
        return null;
      }
      const d = holder.lookup(N("Dest"));
      return d ? { dest: d } : null;
    };

    // links, page by page
    for (let k = 0; k < kept.length; k++) {
      const o = kept[k];
      let annots;
      try { annots = srcPages[o].node.Annots(); } catch (e) { continue; }
      if (!annots) continue;
      const m = mapper(o);
      for (let i = 0; i < annots.size(); i++) {
        try {
          const an = annots.lookup(i);
          if (!(an instanceof PDFDict) || String(an.lookup(N("Subtype"))) !== "/Link") continue;
          const act = actionOf(an);
          const rect = an.lookup(N("Rect"));
          if (!act || !(rect instanceof PDFArray) || rect.size() < 4) { report.linksLost++; continue; }
          const r = [0, 1, 2, 3].map((j) => numOr(rect.lookup(j), 0));
          const p = [m.point(r[0], r[1]), m.point(r[2], r[3]), m.point(r[0], r[3]), m.point(r[2], r[1])];
          const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
          const action = act.uri ? { S: "URI", URI: PDFString.of(act.uri) } : null;
          const dest = act.dest ? mapDest(act.dest) : null;
          if (!action && !dest) { report.linksLost++; continue; }
          const annot = doc.context.register(doc.context.obj({
            Type: "Annot", Subtype: "Link", Rect: [round(Math.min(...xs)), round(Math.min(...ys)), round(Math.max(...xs)), round(Math.max(...ys))],
            Border: [0, 0, 0], F: 4, ...(action ? { A: action } : { Dest: dest }),
          }));
          outPages[k].node.addAnnot(annot);
          report.links++;
        } catch (e) { report.linksLost++; }
      }
    }

    // bookmarks
    try {
      const root = cat.lookup(N("Outlines"));
      if (root instanceof PDFDict) {
        let budget = 20000;
        const read = (first, depth) => {
          const out = [], seen = new Set();
          for (let node = first; node instanceof PDFDict && !seen.has(node) && budget-- > 0; node = node.lookup(N("Next"))) {
            seen.add(node);
            try {
              const act = actionOf(node);
              const c = node.lookup(N("C"));
              out.push({
                title: textOf(node.lookup(N("Title"))), act, open: numOr(node.lookup(N("Count")), 0) > 0,
                color: c instanceof PDFArray && c.size() === 3 ? [0, 1, 2].map((j) => numOr(c.lookup(j), 0)) : null,
                flags: numOr(node.lookup(N("F")), 0),
                children: depth < 30 ? read(node.lookup(N("First")), depth + 1) : [],
              });
            } catch (e) { report.bookmarksLost++; }
          }
          return out;
        };
        const prune = (nodes) => {
          const out = [];
          for (const n of nodes) {
            n.children = prune(n.children);
            n.dest = n.act && n.act.dest ? mapDest(n.act.dest) : null;
            n.uri = n.act && n.act.uri ? n.act.uri : null;
            if (n.dest || n.uri || n.children.length) { out.push(n); if (!n.dest && !n.uri && n.act) report.bookmarksLost++; }
            else report.bookmarksLost++;
          }
          return out;
        };
        const tree = prune(read(root.lookup(N("First")), 0));
        if (tree.length) {
          const visible = (nodes) => nodes.reduce((s, n) => s + 1 + (n.open ? visible(n.children) : 0), 0);
          const write = (nodes, parent) => {
            const refs = nodes.map(() => doc.context.nextRef());
            nodes.forEach((n, i) => {
              const kids = n.children.length ? write(n.children, refs[i]) : null;
              doc.context.assign(refs[i], doc.context.obj({
                Title: PDFHexString.fromText(n.title || " "), Parent: parent,
                Prev: i > 0 ? refs[i - 1] : undefined, Next: i + 1 < nodes.length ? refs[i + 1] : undefined,
                First: kids ? kids.first : undefined, Last: kids ? kids.last : undefined,
                Count: kids ? (n.open ? 1 : -1) * visible(n.children) : undefined,
                Dest: n.dest || undefined, A: !n.dest && n.uri ? { S: "URI", URI: PDFString.of(n.uri) } : undefined,
                C: n.color || undefined, F: n.flags || undefined,
              }));
              report.bookmarks++;
            });
            return { first: refs[0], last: refs[refs.length - 1] };
          };
          const rootRef = doc.context.nextRef();
          const top = write(tree, rootRef);
          doc.context.assign(rootRef, doc.context.obj({ Type: "Outlines", First: top.first, Last: top.last, Count: visible(tree) }));
          doc.catalog.set(N("Outlines"), rootRef);
        }
      }
    } catch (e) { report.error = report.error || "bookmarks: " + ((e && e.message) || e); }

    // page labels
    try {
      const ranges = readLabelRanges(P, cat);
      if (ranges.length) {
        const labels = [], nums = [];
        let prev = null;
        kept.forEach((o, k) => {
          let r = null;
          for (const x of ranges) if (x.from <= o) r = x;
          const style = r ? r.style : "D", prefix = r ? r.prefix : "";
          const n = r ? r.start + (o - r.from) : o + 1;
          labels.push(prefix + labelString(style, n));
          if (!(prev && prev.r === r && prev.n + 1 === n)) {
            nums.push(k, doc.context.obj({
              S: style ? style : undefined, P: prefix ? PDFHexString.fromText(prefix) : undefined, St: n !== 1 ? n : undefined,
            }));
          }
          prev = { r, n };
        });
        doc.catalog.set(N("PageLabels"), doc.context.obj({ Nums: nums }));
        report.labels = labels;
      }
    } catch (e) { report.error = report.error || "page labels: " + ((e && e.message) || e); }
  }

  const round = (n) => Math.round(n * 1000) / 1000;

  /** The source's page-label ranges, in order: [{ from, style, prefix, start }]. */
  function readLabelRanges(P, cat) {
    const root = cat.lookup(P.PDFName.of("PageLabels"));
    const out = [], seen = new Set();
    const walk = (node, depth) => {
      if (!(node instanceof P.PDFDict) || seen.has(node) || depth > 30) return;
      seen.add(node);
      const nums = node.lookup(P.PDFName.of("Nums"));
      if (nums instanceof P.PDFArray) {
        for (let i = 0; i + 1 < nums.size(); i += 2) {
          const d = nums.lookup(i + 1);
          if (!(d instanceof P.PDFDict)) continue;
          const s = d.lookup(P.PDFName.of("S"));
          out.push({
            from: numOr(nums.lookup(i), 0), style: s ? String(s).slice(1) : "", prefix: textOf(d.lookup(P.PDFName.of("P"))),
            start: Math.max(1, numOr(d.lookup(P.PDFName.of("St")), 1)),
          });
        }
      }
      const kids = node.lookup(P.PDFName.of("Kids"));
      if (kids instanceof P.PDFArray) for (let i = 0; i < kids.size(); i++) walk(kids.lookup(i), depth + 1);
    };
    walk(root, 0);
    return out.sort((a, b) => a.from - b.from);
  }

  /**
   * What the source has that a compressed copy keeps or loses, for the Compress window's notes:
   * { forms, links, bookmarks, labels }. Counts are rough (links are counted, bookmarks are counted down the tree).
   */
  async function inspect(P, bytes) {
    const out = { forms: 0, links: 0, bookmarks: 0, labels: false };
    const doc = await P.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
    const N = (s) => P.PDFName.of(s);
    const cat = doc.catalog;
    try {
      const form = cat.lookup(N("AcroForm"));
      const f = form instanceof P.PDFDict ? form.lookup(N("Fields")) : null;
      out.forms = f instanceof P.PDFArray ? f.size() : 0;
    } catch (e) { /* unreadable: treated as none */ }
    try {
      for (const page of doc.getPages()) {
        const an = page.node.Annots();
        if (!an) continue;
        for (let i = 0; i < an.size(); i++) {
          const a = an.lookup(i);
          if (a instanceof P.PDFDict && String(a.lookup(N("Subtype"))) === "/Link") out.links++;
        }
      }
    } catch (e) { /* ignore */ }
    try {
      const root = cat.lookup(N("Outlines"));
      const c = root instanceof P.PDFDict ? root.lookup(N("Count")) : null;
      if (root instanceof P.PDFDict && root.lookup(N("First"))) out.bookmarks = Math.max(1, Math.abs(numOr(c, 1)));
    } catch (e) { /* ignore */ }
    try { out.labels = readLabelRanges(P, cat).length > 0; } catch (e) { /* ignore */ }
    return out;
  }

  /**
   * How many bytes of picture each page carries today (the encoded image streams on it, a picture shared by several
   * pages, as after splitting a spread, counted once and divided between them). The budget for the compressed page
   * is a share of this. Returns an array with one number per page; pages whose pictures can't be found get the average.
   */
  async function pageImageBytes(P, bytes) {
    const { PDFDocument, PDFName, PDFDict, PDFRef, PDFRawStream } = P;
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
    const sizes = new Map(), uses = new Map(), perPage = [];
    const streamSize = (obj) => (obj && obj.contents ? obj.contents.length : 0);
    for (const page of doc.getPages()) {
      const refs = [];
      try {
        const res = page.node.Resources();
        const xo = res && res.lookupMaybe(PDFName.of("XObject"), PDFDict);
        if (xo) {
          for (const [, ref] of xo.entries()) {
            if (!(ref instanceof PDFRef)) continue;
            const obj = doc.context.lookup(ref);
            if (!(obj instanceof PDFRawStream)) continue;
            const sub = obj.dict.get(PDFName.of("Subtype"));
            if (!sub || String(sub) !== "/Image") continue;
            const key = String(ref);
            if (!sizes.has(key)) {
              const mask = obj.dict.get(PDFName.of("SMask"));
              sizes.set(key, streamSize(obj) + (mask instanceof PDFRef ? streamSize(doc.context.lookup(mask)) : 0));
            }
            refs.push(key);
          }
        }
      } catch (e) { /* a page we can't read: it gets the average below */ }
      perPage.push(refs);
    }
    for (const refs of perPage) for (const k of new Set(refs)) uses.set(k, (uses.get(k) || 0) + 1);
    const out = perPage.map((refs) => (refs.length ? [...new Set(refs)].reduce((a, k) => a + sizes.get(k) / uses.get(k), 0) : 0));
    const known = out.filter((n) => n > 0);
    const avg = known.length ? known.reduce((a, b) => a + b, 0) / known.length : bytes.length / Math.max(1, out.length);
    return out.map((n) => Math.round(n > 0 ? n : avg));
  }

  // ---- carrying comments over
  // A Zotero comment sits at PDF user-space coordinates on its page. pdf.js knows how a page's CropBox and /Rotate
  // turn those into what you see ("viewport" points, origin top-left, y down, in points). The compressed page is
  // exactly that view with its own origin at the bottom-left, so a comment moves by: ask pdf.js for the viewport
  // point, then flip y. positionPoints() lists the points to ask about; mapPosition() rebuilds the position.
  function pathPoints(path) {
    if (path.length && Array.isArray(path[0])) return path.map((q) => [q[0], q[1]]);
    const out = [];
    for (let i = 0; i + 1 < path.length; i += 2) out.push([path[i], path[i + 1]]);
    return out;
  }
  /** Can this position be carried over? (Comments that run across two pages can't.) */
  const movable = (pos) => !!pos && Number.isInteger(pos.pageIndex) && !pos.nextPageIndex && ((pos.rects && pos.rects.length) || (pos.paths && pos.paths.length));

  function positionPoints(pos) {
    const pts = [];
    for (const r of pos.rects || []) pts.push([r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]);
    for (const p of pos.paths || []) pts.push(...pathPoints(p));
    return pts;
  }
  /** @param mapped pdf.js viewport points for positionPoints(pos), in the same order; @param heightPt height of the new page */
  function mapPosition(pos, mapped, heightPt) {
    const out = { ...pos };
    let k = 0;
    if (pos.rects) {
      out.rects = pos.rects.map(() => {
        const q = [mapped[k++], mapped[k++], mapped[k++], mapped[k++]];
        const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
        return [round(Math.min(...xs)), round(heightPt - Math.max(...ys)), round(Math.max(...xs)), round(heightPt - Math.min(...ys))];
      });
    }
    if (pos.paths) {
      out.paths = pos.paths.map((p) => {
        const nested = p.length && Array.isArray(p[0]);
        const pts = pathPoints(p).map(() => mapped[k++]);
        return nested ? pts.map((q) => [round(q[0]), round(heightPt - q[1])]) : pts.flatMap((q) => [round(q[0]), round(heightPt - q[1])]);
      });
    }
    return out;
  }

  /** "Why this size?": pixels, and a rough estimate of the whole file from a few measured pages. */
  function estimateTotal(sampleBytes, sampleCount, pageCount) {
    if (!sampleCount) return 0;
    return Math.round((sampleBytes / sampleCount) * pageCount + 2000 + pageCount * 600);
  }

  const humanSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");

  return { build, buildEx, inspect, labelString, estimateTotal, humanSize, writable, movable, positionPoints, mapPosition, pageImageBytes };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ScanFixerCompress;
