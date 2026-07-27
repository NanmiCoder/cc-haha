# Third-Party Licenses

This project includes code and binaries from the following open source projects.

## ripgrep

- Project: ripgrep (https://github.com/BurntSushi/ripgrep)
- Included as: platform-specific desktop search executable
- Version: 15.1.0
- License: dual-licensed under MIT or the Unlicense
- License texts: bundled beside the executable under `ripgrep-licenses/`

## OpenAI Codex Windows sandbox

- Project: OpenAI Codex (https://github.com/openai/codex)
- Included as: pinned Windows sandbox launcher, setup helper, and command runner
- Version: 0.145.0
- License: Apache License 2.0
- License text: bundled beside the executables under `codex-windows-sandbox-licenses/`

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
