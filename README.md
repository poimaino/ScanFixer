# ScanFixer

A plugin for [Zotero](https://www.zotero.org) that fixes scanned PDFs: split double-page spreads, crop, rotate,
straighten and match page sizes in a visual editor that finds the spine, page edges and tilt for you. It keeps your
comments and annotations in place and keeps a copy of the original. A separate **Compress** step makes a smaller
black-and-white, greyscale or colour copy.

<!-- Add a screenshot or two here, e.g. ![The ScanFixer editor](docs/editor.png) -->

## What it does

- **Fix pages**: split spreads down the middle, crop, rotate, straighten, remove and re-order pages, even out page sizes.
- **Compress**: write a smaller copy of the PDF next to the original. The original is never modified.
- Works from the item right-click menu and from the PDF reader (the "SF" button on the reader toolbar, and the page and thumbnail right-click menus).

## Install

1. Download `scanfixer-<version>.xpi` from the [latest release](https://github.com/poimaino/ScanFixer/releases/latest).
   (In Firefox-based browsers, right-click the link and choose "Save link as", so the browser does not try to install it.)
2. In Zotero: **Tools → Plugins**, click the gear icon, choose **Install Plugin From File…**, and pick the `.xpi`.
3. Restart Zotero if asked.

Requires Zotero 7 or later. Once installed, Zotero checks this repository for updates automatically.

## Privacy

Everything runs on your computer. ScanFixer makes no network requests, and your PDFs are never uploaded anywhere.

## Building

See [build/README.md](build/README.md).

## Reporting problems

Please open an [issue](https://github.com/poimaino/ScanFixer/issues). Say which Zotero version and operating system you use,
and attach a small sample PDF only if it contains nothing private.

## Licence

ScanFixer is released under the [MIT licence](LICENSE). It bundles pdf.js, pdf-lib and other components under their own
licences: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

ScanFixer is an independent project and is not affiliated with or endorsed by Zotero.
