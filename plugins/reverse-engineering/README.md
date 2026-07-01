# reverse-engineering plugin

Multi-platform reverse engineering toolkit for cc-haha — static + dynamic
+ report — bundled as a single plugin install. Currently ships **three
MCP servers** (down from seven in v0.4.3 — see "Currently unbundled MCP
servers" below for why), one orchestration agent, eleven skills, and two
slash commands.

## What it gives you

| Surface | Item |
|---|---|
| Agent | `reverse-engineer` — orchestrates triage → static → optional dynamic → report |
| Skills | `triage`, `pe-elf-macho`, `firmware-blob`, `apk-analysis`, **`apk-hardening`** (new in 0.4.6), `ios-analysis`, `dynamic-debug-overview`, `frida-dynamic`, `gdb-debug`, `lldb-debug`, `crackme-keygen`, `re-report` |
| Commands | `/reverse-engineering:triage <path>`, `/reverse-engineering:report <sample-id>` |
| MCP servers | `ghidra` (pyghidra-mcp), `gdb` (mcp-gdb), `frida` (frida-mcp on PyPI) — verified end-to-end as of v0.4.5 |
| Hooks | placeholder (add a fileCreated hook locally if you want SOC-style auto-triage) |

> **Skills still cover the unbundled lanes.** `lldb-debug` / `apk-analysis`
> still teach the agent how to drive LLDB / apktool / jadx / radare2 via
> the shell — the loss of MCP wrapping just means there's no JSON-RPC tool
> surface for them; the agent can still invoke them as subprocess tools.

## Dynamic capabilities (what AI can actually drive)

This is the lane that matters most for AI-driven RE. Static analysis has
limited ROI when reading optimised, obfuscated, or stripped code; runtime
observation turns hypotheses into facts. The plugin ships three dynamic
lanes that don't overlap:

| Capability | Frida | GDB | LLDB |
|---|---|---|---|
| Read/write process memory | ✅ | ✅ | ✅ |
| Read/write GP registers | ✅ inside hook | ✅ | ✅ |
| Call stack | ✅ | ✅ | ✅ |
| Function-level hook | ✅ | ✅ via breakpoint | ✅ via breakpoint |
| Address-level hook (any instruction) | ✅ | ✅ | ✅ |
| Instruction-level trace | ✅ Stalker (cheap) | ⚠️ stepi loop (slow) | ⚠️ thread step-inst loop (slow) |
| **Real single-step (instruction)** | ❌ | ✅ | ✅ |
| **Real software/hardware breakpoints** | ⚠️ trampoline only | ✅ | ✅ |
| Watchpoint (byte granularity) | ⚠️ page only | ✅ | ✅ |
| Reverse-debug | ❌ | ✅ rr / record full | ⚠️ limited |
| Java method hook | ✅ | ❌ | ❌ |
| ObjC method hook | ✅ | ❌ | ✅ |
| Cross-arch (MIPS/PPC/68k/SH) | ⚠️ via frida-server | ✅ gdb-multiarch + qemu | ⚠️ no PPC32/68k |
| iOS device | ✅ frida-server jailbroken | ⚠️ via debugserver | ✅ via debugserver |

The agent reads `dynamic-debug-overview` first to pick the right lane.
For "single-step through MIPS router firmware" → GDB. For "what URL does
this Android app POST to" → Frida. For "step into ObjC method on iOS" →
LLDB.

## Architecture coverage

The reverse-engineering decompilers (Ghidra, radare2) are multi-arch by
design. The `pe-elf-macho` and `firmware-blob` skills cover:

- **x86 / x86-64** — Windows PE, Linux ELF, macOS Mach-O (the default case)
- **ARM** — ARMv4-v8, Thumb/Thumb2 interworking, AArch64. Cortex-M
  (Thumb-only) flash images load via `firmware-blob` using the vector-table
  heuristic.
- **MIPS** — MIPS32/64, big and little endian, MIPS16e/microMIPS. Common in
  routers, PSX, older PIC32, embedded Linux.
- **PowerPC** — PPC32/PPC64, plus VLE (e200, NXP MPC57xx automotive). Common
  in Wii/GameCube, Xbox 360, older Macs, network gear.
- **Motorola 68k** — M68000 through 68060, ColdFire. Old Macs, Atari ST,
  Amiga, Sega Genesis. Recognises Mac Toolbox A-line traps when applicable.
- **SuperH** — SH-2 (Sega Saturn) and SH-4 (Dreamcast).
- **RISC-V** — RV32/RV64 with C/M/A/F/D extensions.
- **Smaller ISAs Ghidra/r2 also handle** — AVR (Arduino), MSP430, 6502
  (NES), Z80, TriCore, Hexagon, Xtensa.

The `firmware-blob` skill specifically handles raw blobs (no PE/ELF/Mach-O
header) — router firmware, Cortex-M flash dumps, U-Boot uImages, console
ROMs, ECU dumps — by identifying the ISA + endianness + base address before
loading into Ghidra/r2 with the right processor module.

## Install

`<repo-root>` below is wherever you have cc-haha checked out (e.g.
`C:\Users\you\cc-haha` on Windows, `~/cc-haha` on macOS/Linux).

From the repo root, add the marketplace by directory:

```pwsh
# inside cc-haha checkout, in PowerShell:
$marketplace = (Resolve-Path .\plugins).Path
# Then in the desktop UI: Settings → Plugins → Add marketplace
# → paste $marketplace, install "reverse-engineering", enable.
```

Or via the CLI:

```pwsh
./bin/claude-haha plugin marketplace add (Resolve-Path .\plugins).Path
./bin/claude-haha plugin install reverse-engineering@cc-haha-builtin
```

Validate the manifest at any time:

```pwsh
./bin/claude-haha plugin validate plugins/reverse-engineering
```

## Quickstart — first real run

Once the plugin is enabled and at least one of the underlying tools is on
your PATH (Ghidra or radare2 covers most native cases), pick a small,
non-malicious open-source binary to drive the workflow. `busybox` is a
good first target — it's a single static ELF, big enough to be
interesting, small enough to finish quickly.

```pwsh
# 1. Get a sample
mkdir samples
curl -L -o samples/busybox 'https://busybox.net/downloads/binaries/1.31.0-defconfig-multiarch-musl/busybox-x86_64'

# 2. Triage — identifies file type, packing, picks the next skill
#    (in chat) /reverse-engineering:triage samples/busybox

# 3. Static analysis happens automatically once triage routes to pe-elf-macho.
#    For a non-x86 sample (firmware blob, MIPS router image, Cortex-M flash dump),
#    triage routes to firmware-blob first, which identifies the ISA and base
#    address before handing back to pe-elf-macho.

# 4. Final report
#    (in chat) /reverse-engineering:report <sample-id>
```

Expected products under `${ARTIFACT_DIR}/<sample-id>/`:

```
triage.md            — file type, entropy, routing decision
static-native.md     — imports, key functions decompiled, strings, decoded constants
report.md            — verdict + findings table + IOCs + open questions
```

Confidence is honest: static-only conclusions about runtime behaviour cap
at medium. To upgrade to high you have to run `frida-dynamic` against a
target you've authorised.

## Development workflow (changing skills / agent prompts)

The plugin loader caches each plugin under
`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` keyed on the
manifest version. That means a naive "edit SKILL.md, reload" loop **will
not see your changes** until the version is bumped.

Two options:

### Option A — version bump (publishing flow)

```pwsh
# Edit plugin sources, then:
# 1. Bump "version" in plugins/reverse-engineering/.claude-plugin/plugin.json
# 2. Re-materialise:
Invoke-RestMethod -Method POST -Uri http://127.0.0.1:3456/api/plugins/update `
  -ContentType 'application/json' `
  -Body '{"id":"reverse-engineering@cc-haha-builtin","scope":"user"}'
Invoke-RestMethod -Method POST -Uri http://127.0.0.1:3456/api/plugins/reload `
  -ContentType 'application/json' -Body '{}'
```

### Option B — dev junction (fast iteration loop)

```pwsh
# Replace the cached version dir with a junction to the in-repo source.
bun run plugins/reverse-engineering/scripts/dev-link.ts

# Now editing any SKILL.md / agent / command takes effect after just:
Invoke-RestMethod -Method POST -Uri http://127.0.0.1:3456/api/plugins/reload `
  -ContentType 'application/json' -Body '{}'

# When done, restore the real cache before publishing:
bun run plugins/reverse-engineering/scripts/dev-link.ts --restore
```

`dev-link.ts` is Windows-only (uses `mklink /J`); on macOS/Linux a manual
`ln -s` does the same thing.

## Smoke test

End-to-end check after manifest changes — assumes server (`:3456`) and
vite (`:1420`) are running (start them as documented in
`docs/desktop/10-local-mcp-testing.md`):

```pwsh
bun run plugins/reverse-engineering/scripts/smoke.ts
```

The script registers the marketplace, enables the plugin, runs
`/api/plugins/update` + `/reload`, and asserts that detail returns the
right version, zero errors, and the expected component counts (counted
from the on-disk source, not hardcoded). Exits non-zero on any
mismatch.

## External tool prerequisites

The plugin doesn't ship the underlying tools. You need them on your machine
(installable independently — none are required all at once):

> **Auto-detect since cc-haha v0.5.10:** when you enable this plugin from
> the desktop **Settings → Plugins** page, cc-haha probes whether each of
> the host commands below is on PATH. Anything missing (e.g. `uvx`,
> `radare2`, `java`) shows up in a one-click install modal with platform-
> specific commands — winget/scoop on Windows, brew on macOS, apt/dnf on
> Linux. The probe is a `where` / `command -v` lookup; it never executes
> the underlying tool. Declarations live in
> [`mcp/servers.json`](mcp/servers.json) under each server's
> `prerequisites` key.

| MCP | What you need | Install |
|-----|---------------|---------|
| `ghidra` | Ghidra (NSA), Java 17+, `uvx` (from `uv`) | https://ghidra-sre.org + set `GHIDRA_INSTALL_DIR` |
| `gdb` | GDB on PATH (`gdb-multiarch` for cross-arch), Node | `apt install gdb gdb-multiarch` / `brew install gdb` / `scoop install gdb` |
| `frida` | `uvx` (the `frida-mcp` PyPI pkg bundles a Python frida client; only needs frida-server on the target device) | uvx auto-installs frida-mcp; deploy frida-server to your authorised target separately |

You can disable individual MCP servers (e.g., turn off Frida if you only do
static work) from the desktop **MCP** settings page (Settings → MCP) — the
plugin's job is to bundle the configurations; per-server enable/disable is a
runtime decision, not a manifest one.

## Currently unbundled MCP servers

The v0.5.10 release of cc-haha shipped this plugin with seven MCP servers,
but four of them turned out to have upstream packaging or runtime issues
that no manifest-level fix can paper over. They have been removed from
`mcp/servers.json` for v0.4.5 (cc-haha v0.5.12+) so users don't see four
permanently-red "Unavailable" cards in the MCP page. Each entry below
records the failure mode discovered during end-to-end smoke; if the
upstream lands a fix, the server can be re-added in a future patch.

| Server | Upstream tried | Failure mode |
|---|---|---|
| `radare2` | npm `@radareorg/radare2-mcp` | npm registry returns **404 — package unpublished**. The official GitHub repo `radareorg/radare2-mcp` is a C/Meson project that requires compilation, not direct `npx`/`uvx` install. Fork `drvcvt/radare2-mcp` is a TypeScript project but ships no `dist/` and no `prepare` build hook, so `npx --package=git+...` fails to find the entry binary. |
| `lldb` | `stass/lldb-mcp` (and the `stableversion/lldb_mcp` fork) | Repo is a single-file `lldb_mcp.py` script with no `pyproject.toml` / `setup.py` packaging, so `uvx --from git+...` errors with `does not appear to be a Python project`. |
| `jadx` | `zinja-coder/jadx-mcp-server` (and `mseep-jadx-mcp-server` PyPI republish) | Original repo packages but crashes at startup with `ModuleNotFoundError: No module named 'src'` (upstream packaging bug). The PyPI republish under `mseep-jadx-mcp-server` is a 0-byte placeholder that contains only `dist-info` metadata with no actual code. |
| `apktool` | `zinja-coder/apktool-mcp-server` (and `SecFathy/APktool-MCP`) | uv git fetch consistently fails with `Git operation failed`, persisting after `uv cache clean`. The SecFathy alternative is also unpackaged (single `APktool.py` file). |

To use these locally without waiting for upstream:

1. Clone the upstream repo to a fixed path under your home directory.
2. Add a custom MCP server entry pointing at the local script in your
   user-level `~/.claude/mcp.json` (not the plugin manifest — that gets
   overwritten on plugin update).
3. The agent skills (`lldb-debug`, `gdb-debug`, etc.) still teach the
   agent how to drive these tools via shell, so even without the JSON-RPC
   wrapping you can still get a working dynamic-analysis workflow as long
   as the binaries are on PATH.

If a packaged alternative shows up on PyPI / npm, please open an issue
and we'll re-add the server to `mcp/servers.json`.

## External CLI tools (Bash-driven, not MCP)

Several skills reach for command-line tools that **aren't** wrapped as MCP
servers — either because they're already mature and stable as CLIs (jadx,
apktool, lldb), or because their value is one-shot identification rather
than long-running structured tool surface (APKiD), or because their
upstream MCP packaging is currently broken.

These are user-installed prerequisites — cc-haha never auto-runs the install
commands. Install once and the agent skills work via Bash.

### Static analysis CLI tools

| Tool | Used by skill | Install (Win) | Install (mac) | Install (linux) |
|---|---|---|---|---|
| **jadx** | `apk-analysis` | `scoop install jadx` | `brew install jadx` | `apt install jadx` / `snap install jadx` |
| **apktool** | `apk-analysis` | `scoop install apktool` | `brew install apktool` | `apt install apktool` / `snap install apktool` |
| **APKiD** | `triage`, `apk-hardening` | `pipx install apkid` | `pipx install apkid` | `pipx install apkid` |
| **lldb** | `lldb-debug` | LLVM installer (winget / scoop) | `xcode-select --install` (built-in) | `apt install lldb` / `dnf install lldb` |
| **java** (JDK 17+) | jadx + apktool | `winget install EclipseAdoptium.Temurin.17.JDK` | `brew install --cask temurin@17` | `apt install openjdk-17-jdk` |

### Dynamic / unpacking CLI tools (for hardened APKs)

The `apk-hardening` and `frida-dynamic` skills walk the agent through
the workflows below; the tools are user-installed once.

| Tool | Used by skill | Purpose | Install |
|---|---|---|---|
| **objection** | `frida-dynamic` (anti-anti-frida prep) | Anti-root + SSL-pinning bypasses, frida-gadget injection on unrooted devices | `pipx install objection` |
| **frida_dump (lasting-yang)** | `apk-hardening` | Memory-scan dex unpacker for class-extraction shells | `git clone https://github.com/lasting-yang/frida_dump` (Python script, no install) |
| **FART** | `apk-hardening` | Full ART-runtime dex dumper for class-call-recompile shells | Pre-built ROM image; out-of-band setup, see [`hanbinglengyue/FART`](https://github.com/hanbinglengyue/FART) |
| **Unidbg** | `apk-hardening` | Java-based Android native lib emulator (offline SO decryption, key recovery) | `git clone https://github.com/zhkl0228/unidbg && ./gradlew build` |
| **Blutter** | `apk-hardening` (Flutter) | Flutter Dart AOT snapshot reverse engineering | `git clone https://github.com/worawit/blutter && ./scripts/build.sh` |

The agent picks the right tool from the routing matrix in `apk-hardening/SKILL.md`
based on what APKiD / manual signatures identify as the packer family.

### Quick-install for a typical Android RE workflow

If you'll be doing Android RE often, install the static + bypass chunk in one go:

```pwsh
# Windows (PowerShell — needs scoop + pipx already set up)
scoop install jadx apktool gdb
pipx install apkid objection
winget install EclipseAdoptium.Temurin.17.JDK

# macOS
brew install jadx apktool gdb
pipx install apkid objection
brew install --cask temurin@17

# Linux (Debian / Ubuntu)
sudo apt install -y jadx apktool gdb gdb-multiarch lldb openjdk-17-jdk
pipx install apkid objection
```

Once those are on PATH, `apk-analysis` and `apk-hardening` work end-to-end
on non-hardened APKs and on common class-extraction shells. For tougher
unpacking (FART / Unidbg / Blutter) follow the per-tool clone-and-build
steps when the agent reaches that branch in the hardening routing matrix.

## User-config knobs

| Key | Default | Purpose |
|-----|---------|---------|
| `GHIDRA_INSTALL_DIR` | (env fallback) | Path to Ghidra install. Substituted into the ghidra MCP server's env at launch. |
| `ARTIFACT_DIR` | `artifacts/re-runs` | Where reports and intermediates go. Resolved relative to the agent's current working directory at run time. |

## Scope and rules

- **Read-only on samples.** No skill in this plugin will execute a sample on
  the host. Frida runs only on user-authorised targets (sandboxed device or VM).
- **No public uploads.** No VirusTotal, no malware-bazaar pushes.
- **No commercial license cracking.** The `crackme-keygen` skill is for CTFs
  and self-owned binaries.
- **Confidence is honest.** Static-only conclusions about runtime behaviour cap
  at medium; high requires confirmation by another channel.

## References

- Ghidra MCP — https://github.com/LaurieWired/GhidraMCP and https://github.com/clearbluejar/pyghidra-mcp
- GDB MCP — https://github.com/signal-slot/mcp-gdb (npm package `mcp-gdb`)
- Frida MCP — https://pypi.org/project/frida-mcp/ (PyPI `frida-mcp`)
- (deferred) radare2 MCP — https://github.com/radareorg/radare2-mcp — C project, requires compile; npm pkg unpublished
- (deferred) LLDB MCP — https://github.com/stass/lldb-mcp — upstream not Python-packaged
- (deferred) JADX MCP — https://github.com/zinja-coder/jadx-mcp-server — upstream `ModuleNotFoundError: 'src'` bug
- (deferred) apktool MCP — https://github.com/zinja-coder/apktool-mcp-server — `uv` git fetch fails; no working alternative
- Multi-agent macOS malware triage prior art — https://www.sentinelone.com/labs/building-an-adversarial-consensus-engine-multi-agent-llms-for-automated-malware-analysis/
- Binary RE for Agents (eval framing) — https://arxiv.org/html/2605.10597v1
- STRIATUM-CTF (protocol-driven CTF agents) — https://arxiv.org/html/2603.22577v1
