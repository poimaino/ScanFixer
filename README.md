# ScanFixer
 
A Zotero plugin for tidying up scanned PDFs: split double-page spreads, crop, straighten, reorder and shrink them, without leaving Zotero. Your comments stay attached to the right part of the page.
 
Works with Zotero 7 and later.
 
## Install
 
1. Download the latest `.xpi` from the [Releases](../../releases) page.
2. In Zotero, go to **Tools → Plugins**.
3. Click the gear icon, choose **Install Plugin From File…**, and pick the `.xpi`.
## Use it
 
- **In your library:** right-click a PDF (or an item with a PDF) and choose **ScanFixer…**
- **In the PDF reader:** click the **SF** button in the toolbar, or right-click a page or thumbnail. Pages you right-clicked are pre-selected.
Pick one of four actions:
 
| Action | What it does |
|---|---|
| **Fix pages** | Opens the page editor. |
| **Compress** | Opens the compress window, then saves a smaller copy next to the original. |
| **Compress, then fix** | Compress window first, then the page editor on the smaller copy. |
| **Fix, then compress** | Page editor first, then the compress window on the fixed file. |
 
Both the editor and the compress window show a live preview of the page, and nothing is saved until you click the button at the bottom (**Apply** or **Compress**). **Cancel** or **Esc** throws your choices away (it asks first if you've changed anything).
 
## Fix pages
 
Opens a preview of each page with draggable guides. Drag the lines or corners to crop; hold Alt/Option to move a single edge; click a line and use the arrow keys to nudge it. Use **◀ ▶** or PageUp/PageDown to move between pages, or switch to **Thumbnails** to see them all.
 
**Layout**
- **Split** cuts a page into two, with a vertical line for spreads or a horizontal one for stacked pages. **Single** keeps one page that you can crop, turn or straighten.
- **Reading L→R / R→L** sets which half comes first. Use R→L for right-to-left books.
- **Turn ↺ ↻** rotates a page in 90° steps.
- **Straighten** tilts a page by up to ±45° (slider covers ±10°, or type a number). A **Grid** overlay helps you line up text.
**Auto-detect**
- **Suggest** looks at the pages and sets the guides for you. Tick what to look for: **Spine**, **Edges**, **Tilt**, and **Trim shadow** (off by default).
- Choose **All pages** or **This page**. Pages you've already edited are never touched.
- The results are normal guides, so you can still drag them. Press **Suggest** again while it runs to stop it.
**Pages**
- **Remove** the left or right half of a split page, or the whole page. **Restore** brings it back (the Delete key also works).
- **Move earlier / later / to start / to end**, or type a position, to reorder.
- **Page numbers** lets you set the numbers a PDF reader shows (for example i, ii, iii, then 1, 2, 3). Pick a style, a start number, an optional prefix and where it begins. Until you set some, the file's own numbers are kept, but splitting, removing or reordering pages drops them. The editor warns you when that will happen.
- **Make all pages the same size** scales pages slightly to match (landscape and portrait are matched separately). Nothing is cropped.
- **Copy layout** applies one page's crop, turn and tilt to all, landscape-only, portrait-only, or a list of pages such as `5-40, 52, odd`.
**Undo / Redo** (Ctrl/Cmd+Z) go back through your changes. **Reset page** and **Reset all** return to the starting layout.
 
## Compress
 
Opens a window with a preview of your pages (**Before** / **After** buttons let you compare) and a live estimate of the final file size. It suggests a format and resolution after looking at a few pages, and you can change anything.
 
- **Format:** **B&W** is smallest and best for text. **Greyscale** suits shading or pictures. **Colour** keeps colour but smaller.
- **Resolution:** 300, 200, 150, 120 or 100 dpi, or **As scanned**. It never goes above the scan's own resolution.
- **Quality** slider (greyscale and colour): lower is smaller.
- **Darkness** slider (B&W): makes the black-and-white result lighter or darker.
- **Clean background:** evens out shadows and whitens the paper.
- **Keep text searchable:** carries over the page's existing text layer as invisible text, in any language.
- **Keep pages smaller than before:** lowers quality, then resolution, on any page that would otherwise come out larger.
- **Copy N comments:** puts your comments on the new file too. The original keeps its own.
- **Suggest for each page** gives photo plates, text pages and so on their own format. You can also set **Just this page** to a different format, for example colour for one photo plate in a black-and-white book.
- **Remove page** (or the **Thumbnails** view) leaves pages out of the copy.
- **Use these settings for the other PDFs** appears when you've selected several, so you only fill in the window once.
The copy is saved as "… (compressed)". Links, bookmarks and page numbers are kept. Form fields become flat (still visible, no longer editable). The original is never changed. If the result wouldn't be meaningfully smaller, nothing is saved and you're told why.
 
## Your files are kept safe
 
- The first time a file is fixed, ScanFixer saves a checked copy of it as "**… (original)**". The fixed file is renamed "**… (scanfixed)**".
- Comments move with their page content. Comments on pages you remove go to the Zotero Trash.
- Cropping **hides** the rest of the page but doesn't delete it. To remove it for good, use Compress.
## Good to know
 
- Encrypted PDFs aren't supported. That includes ones that open without a password but have print or copy restrictions. Print to a new PDF first.
- Compress turns every page into an image, so it's meant for scans rather than PDFs that were born digital.
- Everything runs on your computer. ScanFixer makes no network requests.
 
