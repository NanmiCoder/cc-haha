---
name: pe-elf-macho
description: Static analysis of native binaries (PE, ELF, Mach-O) using Ghidra (preferred) or radare2 as a fallback. Recovers imports, decompiles target functions, extracts strings/constants, and surfaces suspicious API patterns.
whenToUse: After triage routes a Windows EXE/DLL, Linux ELF, macOS Mach-O, or an embedded `.so`/`.dylib` to native analysis.
allowedTools: Bash, Read, Grep, Glob
---

# pe-elf-macho skill

Goal: produce a 15-minute-verifiable picture of a native binary — what APIs it
imports, what its main control flow looks like, where its interesting strings live,
and any callouts that suggest malicious or anti-analysis behavior.

## Tool selection

You have two MCP backends. Pick in this order:

1. **Ghidra MCP** (`ghidra` server) — preferred. Better decompiler. Use when
   `ENABLE_GHIDRA=true` and `GHIDRA_INSTALL_DIR` points at a working Ghidra.
2. **radare2 MCP** (`radare2` server) — fallback. Good for quick triage,
   weaker decompiler (`pdc`/r2ghidra). Use when r2 is on PATH and Ghidra isn't.

If neither is available, do not fabricate findings. Tell the user to enable one
in the plugin's user config and stop.

## Procedure

### Step 1 — Open the binary

With **Ghidra MCP**:

```text
ghidra: open_program path=$SAMPLE
ghidra: analyze (default analyzers, including aggressive instruction recovery)
```

With **radare2 MCP**:

```text
radare2: open path=$SAMPLE
radare2: cmd "aaa"        # full analysis pass
```

### Step 2 — Inventory

In one pass, collect:

- **Imports / dynamic symbols** — what APIs does it pull in? Group by category:
  network (socket, connect, WSAStartup, getaddrinfo, libcurl), crypto
  (CryptAcquireContext, EVP_*, AES_*, SSL_*), process/thread
  (CreateProcess, CreateRemoteThread, ptrace, fork+execve), filesystem and
  registry, anti-analysis (IsDebuggerPresent, NtQueryInformationProcess,
  ptrace(PT_DENY_ATTACH), CheckRemoteDebuggerPresent).
- **Exports** — for DLLs/so libraries.
- **Sections** — name + size + entropy. Flag any section with entropy > 7.0 as
  suspicious (likely encrypted/packed payload).
- **Strings** — at minimum: URLs, IP literals, file paths, registry keys,
  pipe/mutex names, format strings that look like C2 commands. Filter the noise
  (CRT internals, common library strings).

Ghidra MCP suggested calls:
```text
ghidra: list_imports
ghidra: list_exports
ghidra: list_sections (include entropy)
ghidra: list_strings min_length=5 ascii_and_utf16=true
```

radare2 MCP suggested calls:
```text
radare2: cmd "iiq"        # imports
radare2: cmd "iEq"        # exports
radare2: cmd "iSq"        # sections
radare2: cmd "izzj"       # full strings as JSON
```

### Step 3 — Identify the function the user cares about

The user gave you a goal. Translate it into a function search:

| Goal | Search pattern |
|---|---|
| Find license/serial check | xrefs to strings like "Invalid", "Wrong", "license", "serial"; also xrefs to MessageBox/printf |
| Find C2 endpoint | xrefs to network imports + xrefs to URL strings |
| Find file-drop logic | xrefs to CreateFileA/W + WriteFile + temp dir strings |
| Find crypto key | xrefs to crypto APIs; constants of size 16/24/32 in `.rodata` |
| Find anti-debug | xrefs to anti-analysis API list above |

Then jump to the function and decompile it.

### Step 4 — Decompile and annotate

For each function in scope:

- Get the decompiled output.
- Rename obviously-named locals (`uVar1` → `pConfig`) when you're confident.
- Annotate the Ghidra/r2 database with comments stating *why* you renamed.
- Capture the cleaned-up decompiled snippet and the function's address.

### Step 5 — Cross-reference and unpack obvious crypto

- For each interesting string, list its xrefs and walk back to the originating
  function.
- If you see `XOR` loops with a small key — decode them and add the cleartext to
  the report.
- If you see standard crypto (AES with a hardcoded key, RC4 with an obvious
  key-schedule) — note the algorithm + key + IV in the report.

## Outputs

Write to `ARTIFACT_DIR/<sample-id>/static-native.md`:

```markdown
# Static native analysis — <sample-id>

## Imports of interest
| Category | API | Likely use |

## Sections
| Name | Size | Entropy | Note |

## Decompiled key functions
### sub_401a30 @ 0x401a30 — license check
<short prose>
```c
<cleaned decompilation>
```

## Strings of interest
| Offset | String | Context |

## Decoded constants / keys
| Where | Algorithm | Key (hex) | Notes |

## Open questions
- ...
```

## Hard rules

- **Don't rely on the decompiler past the point you can verify.** Ghidra and r2
  both produce wrong code on hand-tuned assembly, packed data, and unusual
  calling conventions. Cross-check with disassembly when something feels off.
- **Don't run the binary.** This is a static skill. Dynamic behavior is for the
  `frida-dynamic` skill.
- **Cap unverifiable claims at medium confidence.** "This connects to evil.com"
  on the basis of a string match without a confirmed call into `connect()` is
  medium, not high.

## Architecture-specific notes (when the binary is not x86)

The procedure above works for any ISA Ghidra/r2 supports — but each one has
gotchas that bite if you read the disassembly with x86 mental models. If
triage / firmware-blob handed you a non-x86 target, lean on this section.

### MIPS (32 / 64, BE and LE — routers, PSX, older PIC32, embedded Linux)

- **Delay slots are real.** Every branch (`beq`, `j`, `jal`, `jr`) executes
  the instruction immediately after it before transferring control. When you
  read disassembly, the visually-after instruction belongs to the *taken*
  path. Ghidra and r2 model this; hand-written annotations have to too.
- **`$gp` global pointer.** The C compiler accesses globals via
  `lw $reg, offset($gp)` where `$gp` points 32K into the `.sdata` segment.
  Ghidra sets up `_gp_disp` automatically for ELF; for raw blobs you may
  need to identify `_gp` and tell Ghidra (`Specify $gp Value` in
  Memory Map dialog) or it will miss xrefs to globals.
- **Calling convention (o32):** `$a0..$a3` for first four args, rest on
  stack, `$v0` for return, `$ra` is link register, `$sp` stack. n32/n64 use
  `$a0..$a7`.
- **`jal` jumps within a 256MB region** — long jumps go through `$t9`.
  Indirect calls almost always use `$t9` because PIC code does.
- **`mips16e` / `microMIPS`** — variable-length instructions, looks like LE
  16-bit code interleaved with 32-bit. If you see lots of `0x65`/`0x6D`
  prefixes you may be in the wrong sub-mode. Switch language ID
  (`MIPS:LE:32:micro`) and reanalyse.

### ARM (ARMv4-v8, Thumb, Thumb2, AArch64 — phones, IoT, Cortex-M)

- **ARM/Thumb interworking.** `bx`/`blx` switches between modes based on the
  low bit of the target address: `0x1234` = ARM, `0x1235` = Thumb. A function
  pointer with the low bit set is **not** a misaligned bug — it's Thumb.
  Ghidra's "ARM Thumb" analyser handles this; for raw r2 you must
  `e anal.armthumb=true` and use `s+ 1` to enter Thumb at an address.
- **Cortex-M is Thumb-only.** No ARM-mode instructions. Use language
  `ARM:LE:32:Cortex` (Ghidra) or `e asm.cpu=cortex` (r2). The vector table at
  the start of flash gives you 16+ early function pointers for free.
- **PIC literal pools.** ARM compilers emit `ldr r0, =0x12345` as
  `ldr r0, [pc, #N]` with the constant stored mid-function. This means a
  chunk of "code" disassembles to garbage — that's a literal pool, not a
  decompiler bug. Ghidra usually marks it as data; r2's
  `aaaa` / `afta` helps.
- **Calling convention (AAPCS):** `r0..r3` for first four args, rest on
  stack, `r0..r1` for return (64-bit results in pair), `r12=ip`, `r13=sp`,
  `r14=lr`, `r15=pc`. AArch64 uses `x0..x7`.
- **AArch64 has fewer footguns** than 32-bit ARM — fixed 32-bit instructions,
  no Thumb, but watch out for `adrp` + `add` pairs that compute page-relative
  addresses (Ghidra usually folds them).

### PowerPC (PPC32 / PPC64, BE — Wii/GameCube, Xbox 360, NXP MPC57xx, older Macs)

- **Link register is separate.** `bl` writes the return address to `lr`, not
  the stack. Functions `mflr` / `mtlr` to save/restore it across calls.
- **Conditional execution via CR fields.** `cmpw cr0, r3, 0` then
  `beq cr0, dest`. There are 8 condition register fields (`cr0..cr7`); the
  compiler allocates them for parallelism.
- **TOC (PPC64) and small data (`.sdata` via `r2` / `r13`).** Globals are
  loaded as `lwz r3, offset(r2)` (PPC32 SDA) or `ld r3, offset@toc(r2)`
  (PPC64 ABIv1). r2 is **always** the TOC base, not free for use. Ghidra's
  PowerPC analyser tracks this; raw r2 may need
  `omr $$ ; om $$ <base> ; e anal.gp=<sdata-base>`.
- **VLE (Variable-Length Encoding)** on e200 cores (NXP MPC57xx automotive)
  is a separate ISA that mixes 16- and 32-bit instructions. Use language
  `PowerPC:BE:32:e200` in Ghidra or `e asm.cpu=vle` in r2.
- **Calling convention:** `r3..r10` for args, `r3` for return, `r1` is
  stack, `r2` is TOC (PPC64) or thread pointer (PPC32 EABI).

### Motorola 68k (M68000-M68060, ColdFire — old Macs, Atari ST, Amiga, Sega Genesis, embedded)

- **Two register banks, almost orthogonal.** `D0..D7` for data,
  `A0..A7` for addresses (`A7` is `SP`, `A6` often frame pointer).
  Most instructions are typed by suffix: `move.b`, `move.w`, `move.l`.
- **Old Mac Toolbox calls go through A-line traps.** Instructions starting
  with `0xA...` are not real opcodes — they're system calls into the Mac
  Toolbox. `0xA9F4` = `_Read`, `0xA9C2` = `_OpenResFile`, etc. Ghidra's
  Mac OS Classic loader knows these; for a raw blob you need to apply the
  M68k Mac trap names manually (Inside Macintosh tables).
- **F-line instructions (0xF...)** are FPU (68040+) or unimplemented
  (handled by trap on older 68000). On Atari/Amiga F-line is unused.
- **`link` / `unlk` for stack frames.** `link a6, #-N` is the prologue,
  `unlk a6 ; rts` the epilogue. Recognise these as function boundaries.
- **Sega Genesis / Mega Drive ROMs** start with a 256-byte cartridge header;
  reset vector is at offset 4 (big endian). VDP I/O lives at `0xC00000`,
  controllers at `0xA10003`/`0xA10005`. Sound CPU (Z80) lives at `0xA00000`.

### SuperH (SH-2, SH-4 — Sega Saturn, Dreamcast, some printers/copiers)

- **Fixed 16-bit instructions** — small footprint, clean decode. Big endian.
- **Delay slots** like MIPS: `bra`, `bsr`, `jmp`, `jsr`, `bf/s`, `bt/s` all
  execute one instruction after the branch.
- **PIC literal loads via `mov.l @(disp,pc), Rn`.** Same literal-pool pattern
  as ARM: chunks of "data" interleaved with code.
- **SH-2 (Saturn)** has two CPUs running in parallel — recover both.
  **SH-4 (Dreamcast)** has FPU and an MMU; same instruction set otherwise.

### RISC-V (RV32I/RV64I, with C/M/A/F/D extensions)

- **Compressed extension `C`** — 16-bit forms of common instructions
  intermixed with 32-bit. Ghidra/r2 handle this transparently when you set
  `RISCV:LE:32:RV32IC` or similar.
- **`auipc` + `jalr` / `auipc` + `addi`** patterns build PC-relative
  addresses. Ghidra folds these in analysis; r2 sometimes doesn't.
- **Calling convention:** `a0..a7` for args, `a0..a1` return, `ra` link,
  `sp` stack, `gp` global pointer (often unused), `tp` thread pointer.

### Architecture-blind reminders

- **Indirect calls / function tables.** All these ISAs use indirect-call
  patterns (jump tables for switch, vtables for OOP, callback arrays). When
  the static decompiler shows `(*func)(...)`, find where `func` is written.
- **MMIO regions** are uncached memory at fixed addresses (e.g.,
  `0xFFE00000` for STM32 peripherals, `0x1F801000` for PSX I/O). Reads/writes
  there are device interactions, not data accesses — annotate accordingly.
- **Interrupt vectors / handlers** are usually the second-most-important
  function set after `main`/`reset`. They show what events the firmware
  cares about (UART RX, timer tick, button press).
