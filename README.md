# ScanFixer

A plugin for [Zotero](https://www.zotero.org) that fixes visual scanned PDFs

## What it does

- **Compress**: write a smaller copy of the PDF next to the original (select colour, greyscale or b&w; modify dpi and darkness). The original is never modified.
- **Fix pages**: split, crop, rotate, straighten, remove, re-order, re-number, normalise size. Auto-suggest and manually adjust splits and margins.

Options to run one mode by itself or both in sequence (in either order). Both modes feature visual editor with single page and thumbnail grid view. Comments are retained in copies. Launch ScanFixerfrom the item right-click menu in Zotero library or from the toolbar in pdf viewer.
This add-on is designed to work without other dependencies. Other tools for more advanced processing that require dependencies are available. ScanFixer is useful for preparing visual scans for OCR processing (for which users will need a dedicated OCR add-on). 


## Install

1. Download `scanfixer-<version>.xpi` from the [latest release](https://github.com/poimaino/ScanFixer/releases/latest).
2. In Zotero: **Tools → Plugins**, click the gear icon, choose **Install Plugin From File…**, and pick the `.xpi`.
3. Restart Zotero if asked.

Requires Zotero 7 or later. 

## Privacy

Everything runs on your computer. ScanFixer makes no network requests, and your PDFs are never uploaded anywhere.





## Licence

ScanFixer is released under the [MIT licence](LICENSE). It bundles pdf.js, pdf-lib and other components under their own
licences: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

ScanFixer is an independent project and is not affiliated with or endorsed by Zotero.
