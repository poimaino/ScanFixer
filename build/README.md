# Building ScanFixer

`content/render-worker.js` is a prebuilt bundle. It was generated with a JavaScript bundler and the original
build command was not kept. Rebuilding it is only needed to upgrade pdf.js; every other file is edited directly.

## What is in the package

Everything except one file is plain source that is shipped as written:

- `manifest.json`, `bootstrap.js`
- `content/*.js` (ScanFixer's own code)
- `content/pdf-lib.min.js`: pdf-lib, minified upstream build

`content/render-worker.js` is **generated**. It is made of:

1. pdf.js 5.6.205, "legacy" build (`pdfjs-dist/legacy/build/pdf.min.mjs` and `pdf.worker.min.mjs`), bundled into one
   script that defines the globals `pdfjsLib`, `pdfjsWorker` and `__pdfjsWasm` (the OpenJPEG, qcms and JBIG2 WebAssembly
   files, base64-encoded);
2. ScanFixer's message handler, which is the part starting with the comment "Runs inside a Web Worker".

At run time `bootstrap.js` joins `imageops.js`, `jpeg.js` and `render-worker.js` into one worker script.

## Upgrading pdf.js

To upgrade, install the new `pdfjs-dist` from npm, then bundle (for example with esbuild) the "legacy" build of
`pdf.min.mjs` and `pdf.worker.min.mjs` plus the three `.wasm` files (base64-encoded into `__pdfjsWasm`) into a single
script that defines `pdfjsLib`, `pdfjsWorker` and `__pdfjsWasm`. Put ScanFixer's handler (the part of the current file
that starts with "Runs inside a Web Worker") after it. Then:

- update the version in the first line of `render-worker.js` and in `THIRD_PARTY_NOTICES.md`;
- refresh the `licenses/pdfjs-wasm-*` files from the new package's `wasm/` folder;
- keep build-machine paths out of the output (`grep -n "home/" content/render-worker.js` should find nothing);
- test the plugin in Zotero (open a scan, run Fix and Compress) before releasing.

## Making the XPI

An XPI is a zip file with `manifest.json` at its root:

```bash
zip -X -r scanfixer-2.0.0.xpi manifest.json bootstrap.js content LICENSE THIRD_PARTY_NOTICES.md licenses
sha256sum scanfixer-2.0.0.xpi   # put this in updates.json as "sha256:<hash>"
```
