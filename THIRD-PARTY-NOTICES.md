# Third-party notices

KnowLattice bundles or depends on the third-party assets and libraries listed
below. Keep this file, plus the per-asset NOTICE files, when redistributing.

**These third-party components are not covered by this project's GPL-3.0 license.**
`LICENSE` applies to KnowLattice's own source code only; each item below keeps
its own terms.

## Bundled data

### 3D anatomy models
- Source : Anatria-3D (https://github.com/Nurkan1/Anatria-3D); meshes adapted
           from Z-Anatomy, derived from BodyParts3D / DBCLS.
- Files  : public/anatomy/*.glb, public/anatomy/manifest.json
- License: CC BY-SA 4.0 (meshes) / Apache-2.0 (code) / CC BY-SA 2.1 JP (BodyParts3D)
- Notice : public/anatomy/NOTICE

### Brain atlas (MNI152 template + Harvard-Oxford parcellation)
- Files  : public/brain/mni152_t1_2mm.nii.gz
           public/brain/ho_cortical_dseg.nii.gz
           public/brain/ho_subcortical_dseg.nii.gz
           public/brain/regions.json
- MRI template : MNI152NLin2009cAsym, McConnell Brain Imaging Centre (McGill),
                 via TemplateFlow (https://templateflow.org).
                 Permissive, MIT-style: "Permission to use, copy, modify, and
                 distribute this software and its documentation for any purpose
                 and without fee is hereby granted, provided that the above
                 copyright notice appear in all copies." Copyright (C) 1993-2004
                 Louis Collins, MNI, McGill University. Cite Fonov et al.,
                 NeuroImage 54(1), 2011.
- Parcellation : Harvard-Oxford Structural Atlas, FSL / FMRIB, University of
                 Oxford. CC BY-SA 4.0 — the FSL licence states that the
                 Harvard-Oxford atlases "are released under the CC BY-SA 4.0
                 licence"; the FSL non-commercial terms do not apply to them.
                 Attribution + share-alike; CC BY-SA 4.0 is one-way compatible
                 with GPLv3.
- Notice       : public/brain/NOTICE

### OCR engine and language data (tesseract.js)
- Files  : public/tesseract/*.wasm, public/tesseract/*.js   (tesseract.js-core)
           public/tessdata/chi_sim.traineddata.gz, eng.traineddata.gz
- License: Apache-2.0 — tesseract.js, tesseract.js-core, and the tessdata_fast
           traineddata models.
- Note   : public/tesseract/ ships THREE core builds (~2.7 MB each raw, ~1.0 MB
           each gzipped). tesseract.js picks exactly one at runtime by browser
           capability (getCore.js: if/else, no fallback) — relaxed-SIMD for
           2024+, SIMD for 2021-2024, plain for older browsers. Dropping any of
           them breaks OCR outright for that class of browser, so all three are
           kept deliberately.

### Draco mesh decoder
- Files  : public/draco/draco_decoder.js, draco_decoder.wasm, draco_wasm_wrapper.js
- Source : Google Draco — https://github.com/google/draco
- License: Apache-2.0
- Notice : public/draco/README.md ships alongside the decoder and carries the
           Apache-2.0 pointer.

## Libraries

| Library | License | Use |
|---|---|---|
| @firecrawl/anydoc-wasm (anydoc) | MIT | document to Markdown |
| @niivue/niivue | BSD-2-Clause | medical image viewer (brain atlas) |
| pdfjs-dist | Apache-2.0 | PDF rendering / text layer |
| @react-pdf-viewer/core + default-layout | Custom — see below | PDF viewer React shell |
| mammoth | BSD-2-Clause | .docx to HTML |
| docx-preview | Apache-2.0 | .docx rendering |
| turndown | MIT | HTML to Markdown |
| three | MIT | 3D rendering |
| force-graph | MIT | knowledge graph |
| mind-elixir | MIT | mind map |
| minisearch | MIT | full-text search |
| ts-fsrs | MIT | spaced-repetition scheduler |
| @earendil-works/pi-agent-core + pi-ai | MIT | AI assistant engine (agent loop, provider transport) |
| sql.js | MIT | SQLite in WebAssembly |
| xlsx (SheetJS) | Apache-2.0 | spreadsheet import |
| jszip | MIT | zip export |
| idb | ISC | IndexedDB helper |
| markdown-it | MIT | Markdown preview |
| codemirror / @codemirror/* | MIT | editor |
| react, react-dom | MIT | UI runtime |
| tesseract.js + tesseract.js-core | Apache-2.0 | OCR for scanned PDFs |
| katex | MIT | math rendering |
| @vscode/markdown-it-katex | MIT | KaTeX plugin for markdown-it |

Tauri (Apache-2.0 / MIT) is used for the optional desktop shell.

## @react-pdf-viewer — custom licence, NOT open source

`@react-pdf-viewer/core` and `@react-pdf-viewer/default-layout` are not under a
standard open-source licence. The LICENSE.md shipped inside the package states:
"You have to purchase a Commercial License at the official website"
(https://react-pdf-viewer.dev/license) — free for personal / non-commercial use,
paid for commercial use.

KnowLattice relies on the free non-commercial terms: the project is GPL-3.0,
distributed at no charge, and educational in purpose. Consequences:

- If KnowLattice is ever sold, bundled into a paid product, or deployed
  commercially, remove these two packages or purchase a licence first.
- The upstream repository was archived in August 2024 and is unmaintained.
  `pdfjs-dist` is already a direct dependency of this project, so the migration
  path (a plain pdfjs viewer, or an MIT-licensed wrapper such as EmbedPDF) is
  kept deliberately cheap.

## Icon geometry

All UI icons in `src/views/icons.tsx` are drawn for this project on a 24 px grid
(1.75 px stroke) except one:

- `IconBrain` (brain-atlas navigation entry): outline adapted from
  **Tabler Icons** (https://github.com/tabler/tabler-icons), MIT license.
  The remaining icons are original.

Region coordinates in public/brain/regions.json are centroids computed offline
from the Harvard-Oxford label volumes. Region names come from the FSL atlas XML
files (HarvardOxford-Cortical-Lateralized.xml, HarvardOxford-Subcortical.xml);
Chinese names were added by this project and follow standard Chinese
neuroanatomy terminology (人卫《系统解剖学》《神经解剖学》译名).
