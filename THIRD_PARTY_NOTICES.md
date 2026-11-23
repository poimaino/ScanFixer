# Third-party notices

ScanFixer's own code is MIT-licensed (see `LICENSE`). It ships with the open-source
components below, each under its own licence. Full licence texts are in the `licenses/` folder.

| Component | Where it is | Licence | Text |
|---|---|---|---|
| [pdf.js](https://github.com/mozilla/pdf.js) 5.6.205 (Mozilla Foundation) | `content/render-worker.js` | Apache-2.0 | `licenses/Apache-2.0.txt` |
| core-js 3.48.0 (Denis Pushkarev), bundled by pdf.js's legacy build | `content/render-worker.js` | MIT | `licenses/core-js-MIT.txt` |
| OpenJPEG decoder (compiled to WebAssembly by pdf.js) | embedded in `content/render-worker.js` | BSD-2-Clause | `licenses/pdfjs-wasm-LICENSE_OPENJPEG.txt`, `licenses/pdfjs-wasm-LICENSE_PDFJS_OPENJPEG.txt` |
| qcms colour management (compiled to WebAssembly by pdf.js) | embedded in `content/render-worker.js` | MIT (qcms) and BSD-2-Clause (pdf.js wrapper) | `licenses/pdfjs-wasm-LICENSE_QCMS.txt`, `licenses/pdfjs-wasm-LICENSE_PDFJS_QCMS.txt` |
| JBIG2 decoder (PDFium-derived, compiled to WebAssembly by pdf.js) | embedded in `content/render-worker.js` | BSD-style (PDFium Authors) and Apache-2.0 (pdf.js wrapper) | `licenses/pdfjs-wasm-LICENSE_JBIG2.txt`, `licenses/pdfjs-wasm-LICENSE_PDFJS_JBIG2.txt` |
| [pdf-lib](https://github.com/Hopding/pdf-lib) (Andrew Dillon) | `content/pdf-lib.min.js` | MIT | `licenses/pdf-lib-MIT.txt` |
| tslib helpers inside pdf-lib's minified bundle (Microsoft) | `content/pdf-lib.min.js` | Apache-2.0 (as stated in the bundle's own header) | `licenses/Apache-2.0.txt` |

The licence texts for the pdf.js WebAssembly decoders were taken from the `wasm/` folder of the
`pdfjs-dist` npm package. If you upgrade pdf.js, refresh them from the version you bundle.

The standard JPEG quantisation and Huffman tables used in `content/jpeg.js` come from the JPEG
specification (ITU-T T.81, Annex K) and are not subject to a separate licence.

ScanFixer is an independent project and is not affiliated with or endorsed by Zotero or the
Corporation for Digital Scholarship.
