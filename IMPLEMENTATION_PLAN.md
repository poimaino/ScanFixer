# ScanFixer refinement plan

This document records the agreed scope for the next implementation pass.

## Annotation sizing during normalization

When normalization applies a uniform scale to a page, apply the same scale factor to the numeric annotation-position fields that describe dimensions: `width`, `height`, and `fontSize`. Transform coordinate arrays as currently implemented and preserve other position metadata unchanged.

## Omit a half-scan

When a page is split, allow either output half to be omitted. The option should follow the visible half when the split axis changes. At least one output half must remain. Annotations assigned to an omitted half follow the same disposition selected for omitted-page annotations.

## Omit an entire PDF page

Allow the user to mark individual input pages for omission. Do not permit a plan that omits every page. Before applying a plan that removes pages containing Zotero annotations, offer:

- Delete annotations on omitted pages; or
- Copy available annotation text and comments to a Zotero note, then delete those annotations.

The note preserves textual content/comments only; it cannot preserve ink strokes or image data and does not perform OCR on printed page content. Attach the note to the PDF's parent item when available; for a standalone PDF, create a standalone note in the same library/collections.

## Annotation disposition

For omitted pages or halves, annotations cannot remain visible in the PDF. For annotations with readable text/comments, the note option copies that textual information before deleting the original annotation records. Other annotation data (including image pixels and ink paths) is not represented in the note. For annotations spanning a split, assigning them to either retained output is acceptable.

## UI copy

- Change `Straighten (rotate a little)` to `Straighten`.
- Change `Show grid to judge it by` to `Show grid`.

## Tests and build readiness

Add regression coverage for annotation dimension scaling and metadata preservation; half omission in both split orientations; whole-page omission; annotation delete/note disposition; and invalid plans that omit all outputs. Add a reproducible XPI build, syntax/test checks, and archive validation. Test the generated XPI in Zotero using a copy of a PDF with text, note, image, and ink annotations before publishing a release.

## Release metadata

The manifest currently contains an example update URL and placeholder author. Remove or replace these before release. Do not publish a release or change the update URL without the owner's confirmation.
