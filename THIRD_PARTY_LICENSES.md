# Third-Party Licenses

This project includes code and binaries from the following open source projects.

## agent-desktop

- Project: [agent-desktop](https://github.com/vercel-labs/agent-desktop), Vercel Labs
- Included as: the vendored native Windows/Linux Computer Use implementation in `native/agent-desktop/`, built into desktop-distribution executables. The existing macOS Swift engine is separate.
- Version: **1.0.2**
- Upstream commit: [`9eb9b296192fcb70bda25e918cd6dd66abfa3d0d`](https://github.com/vercel-labs/agent-desktop/tree/9eb9b296192fcb70bda25e918cd6dd66abfa3d0d)
- License: [Apache License 2.0](native/agent-desktop/LICENSE)
- Source provenance: [UPSTREAM.json](native/agent-desktop/UPSTREAM.json), including the pinned revision and original SHA-256 hashes of copied files
- Distribution notice: [NOTICE](native/agent-desktop/NOTICE)
- Local modifications: [PATCHES.md](native/agent-desktop/PATCHES.md), including the product cursor presentation changes
- Locked Rust dependency notices and license texts: [THIRD-PARTY-NOTICES](native/agent-desktop/THIRD-PARTY-NOTICES); dependency versions are recorded in [Cargo.lock](native/agent-desktop/Cargo.lock)

Original upstream agent-desktop code remains available under Apache-2.0. The root cc-haha Community Source License does not narrow or replace those existing Apache grants. Local integration code and changes follow their applicable notices; dependencies retain their own licenses.

`desktop/scripts/native-agent-desktop.ts` builds the vendored source and stages the CLI, plus the Linux clipboard-owner helper where applicable, under `desktop/src-tauri/binaries/`. It also stages `LICENSE`, `NOTICE`, `THIRD-PARTY-NOTICES`, `UPSTREAM.json`, and `PATCHES.md` under `agent-desktop-licenses/` beside the executables. Desktop packages must retain these files.

## ripgrep

- Project: ripgrep (https://github.com/BurntSushi/ripgrep)
- Included as: platform-specific desktop search executable
- Version: 15.1.0
- License: dual-licensed under MIT or the Unlicense
- License texts: bundled beside the executable under `ripgrep-licenses/`

## pdf.js

- Project: pdf.js (https://github.com/mozilla/pdf.js), distributed as `pdfjs-dist`
- Included as: the PDF engine and its worker, loaded when a PDF is opened in the workspace, and the run-time data files it reads, emitted beside the app under `assets/pdfjs-<version>/`
- Adapted in: `desktop/src/components/workspace/surfaces/document/pdfPage.css` (the text-layer rules of `web/pdf_viewer.css`)
- Version: 6.3.289
- License: Apache-2.0
- Bundled data files, each folder shipped unmodified with its own license files:
  - `cmaps/`: character maps, Copyright 1990-2009 Adobe Systems Incorporated (BSD-style license, `cmaps/LICENSE`)
  - `standard_fonts/`: Foxit fonts (Copyright PDFium Authors, BSD-3-Clause, `LICENSE_FOXIT`) and Liberation Sans fonts (Liberation Font License, GNU GPL v2 with a font exception, `LICENSE_LIBERATION`), kept as separate data files
  - `wasm/`: image decoders OpenJPEG (BSD-2-Clause), JBIG2 from PDFium (BSD-3-Clause) and qcms (MIT), with pdf.js' wrappers for them; each license is in a `LICENSE_*` file beside the decoder
  - `iccs/`: an ICC colour profile (CC0 1.0, `iccs/LICENSE`)

## claude-tap

- Project: claude-tap (https://github.com/liaohch3/claude-tap)
- Adapted in: `desktop/src/lib/trace/sse.ts` (SSE stream reassembly, ported from Python to TypeScript)
- License: MIT

```
MIT License

Copyright (c) 2025 liaohch3

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
