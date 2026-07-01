---
name: gdb-debug
description: Real single-step debugging via GDB MCP. Set breakpoints, step, read/write registers and memory, walk the call stack, watchpoints, reverse-debug. Cross-architecture (x86 / x86_64 / ARM / AArch64 / MIPS / PowerPC / 68k / SH / RISC-V) via gdbserver, qemu-gdb-stub, or any gdb-multiarch target.
whenToUse: When static analysis isn't enough and you need to observe runtime values, single-step through obfuscated code, set conditional breakpoints, or watch memory writes — especially for embedded firmware (GDB is the de facto cross-arch debugger for MIPS/ARM/PowerPC/68k routers, IoT, ECU).
allowedTools: Bash, Read
---

# gdb-debug skill

Goal: turn a static disassembly question into a deterministic dynamic answer.
"Does this branch ever taken?" / "What's in r3 when sub_401a30 is hit?" /
"Which write modifies the global at 0x804a020?" — all answerable in 30
seconds with GDB once the target is wired up.

## When this skill is the right pick

| Question | This skill | Pick something else |
|---|---|---|
| "Does control reach line X with this input?" | ✅ gdb-debug | Frida can do this too if the function is named |
| "What's the AES key passed to EVP_EncryptInit_ex at runtime?" | ✅ gdb-debug | Frida is fine for known APIs |
| "Single-step through the unpacker stub" | ✅ gdb-debug | Frida cannot single-step |
| "Watch every write to global 0x804a020" | ✅ gdb-debug (`rwatch`) | Frida `MemoryAccessMonitor` is alternative |
| "Reverse-execute back to the last syscall" | ✅ gdb-debug + rr | Frida cannot |
| "Hook every Java method on Android" | ❌ — use frida-dynamic | Java introspection isn't GDB's lane |
| "Trace all function calls in a heavy app for a minute" | ❌ — use Frida Stalker | GDB single-step is too slow |

## Tool selection

- **`gdb` MCP** (`gdb` server in this plugin) — wraps the `mcp-gdb` npm package
  (`signal-slot/mcp-gdb`). Provides `gdb_start`, `gdb_load`, `gdb_attach`,
  `gdb_set_breakpoint`, `gdb_continue`, `gdb_step`, `gdb_next`, `gdb_finish`,
  `gdb_backtrace`, `gdb_print`, `gdb_examine`, `gdb_info_registers`, plus
  `gdb_command` for arbitrary commands.

The MCP just wraps a real GDB. Anything you can do in GDB, you can do here —
the wrapper is only a JSON-RPC layer around the GDB/MI interpreter.

## Setup paths

### Path A — local Linux / macOS / WSL binary

You have an ELF binary you can run. Easiest case.

```text
gdb: gdb_start             # spawn a new gdb session, returns sessionId
gdb: gdb_load path=/path/to/binary sessionId=<id>
gdb: gdb_set_breakpoint location=main sessionId=<id>
gdb: gdb_command sessionId=<id> command="run <args>"
```

### Path B — embedded firmware via QEMU user-mode (cross-arch, no real hardware)

For an ELF compiled for MIPS / ARM / PowerPC / RISC-V running on your x86
host, qemu-user runs it with a built-in gdb stub:

```bash
# In a separate terminal — pick the right qemu-user binary:
qemu-mipsel -g 1234 ./bin/busybox        # MIPS LE, ELF, listening on :1234
qemu-mips -g 1234 ./bin/busybox          # MIPS BE
qemu-arm -g 1234 ./bin/binary            # ARM LE
qemu-aarch64 -g 1234 ./bin/binary        # AArch64
qemu-ppc -g 1234 ./bin/binary            # PowerPC BE
qemu-ppc64 -g 1234 ./bin/binary          # PPC64
qemu-riscv64 -g 1234 ./bin/binary        # RISC-V 64
qemu-m68k -g 1234 ./bin/binary           # 68k
qemu-sh4 -g 1234 ./bin/binary            # SH-4 (Dreamcast era)
```

Then connect from GDB:

```text
gdb: gdb_start
gdb: gdb_command command="set architecture <arch>"        # mips, arm, powerpc, ...
gdb: gdb_command command="set endian <big|little>"
gdb: gdb_load path=/path/to/binary
gdb: gdb_command command="target remote :1234"
```

Use `gdb-multiarch` (Debian/Ubuntu) or build GDB with `--enable-targets=all` —
plain `gdb` only supports its host arch.

### Path C — embedded firmware via QEMU system-mode (real OS / kernel / bootloader)

For a router firmware image, ECU dump, or bootloader, you need a full system
emulation:

```bash
# Example — MIPS BE Linux router image:
qemu-system-mips \
  -M malta -m 256 \
  -kernel vmlinux-3.2.0-4-4kc-malta \
  -hda debian_squeeze_mips_standard.qcow2 \
  -nographic \
  -s -S        # -s opens gdb stub on :1234, -S halts at startup
```

Then GDB sees the whole CPU — boot loader, kernel, userspace. Set the
architecture before connecting; load the binary you want symbols for via
`add-symbol-file`.

### Path D — hardware target via gdbserver / OpenOCD

Real hardware (router with serial console, Cortex-M dev board, ECU with
JTAG):

```bash
# On target — Linux with gdbserver:
gdbserver :1234 ./binary

# On Cortex-M via OpenOCD:
openocd -f interface/stlink.cfg -f target/stm32f4x.cfg
# OpenOCD opens a gdb stub on :3333 by default
```

GDB connects the same way (`target remote <host>:<port>`).

### Path E — attach to a running PID

Linux only, requires ptrace:

```text
gdb: gdb_attach sessionId=<id> pid=12345
```

Note: many distros restrict ptrace; you may need
`sudo sysctl kernel.yama.ptrace_scope=0` or run as root. State this in the
report when relevant.

## Procedure — once you're connected

### Step 1 — Set the right symbols

For ELF this happens automatically via `gdb_load`. For raw firmware blobs
(no ELF wrapper), load symbols explicitly:

```text
gdb: gdb_command command="add-symbol-file <syms.elf> <text-base>"
gdb: gdb_command command="symbol-file <syms.elf>"        # alternative
```

If you have NO symbols (common for stripped router firmware), use Ghidra
to recover function names statically, export them as a `.elf` symbol file
(`ExportProgramScript.java`), then load those symbols into GDB. Or just
work with raw addresses; `gdb_command command="info functions"` shows
what GDB knows.

### Step 2 — Set breakpoints

```text
gdb: gdb_set_breakpoint location=main
gdb: gdb_set_breakpoint location="*0x401a30"               # by address
gdb: gdb_set_breakpoint location="sub_401a30 if argc > 1"  # conditional
```

Watchpoints (break on memory access):

```text
gdb: gdb_command command="watch *(int*)0x804a020"          # break on write
gdb: gdb_command command="rwatch *(int*)0x804a020"         # break on read
gdb: gdb_command command="awatch *(int*)0x804a020"         # break on access (read or write)
```

### Step 3 — Run, step, inspect

```text
gdb: gdb_continue                                          # run / continue
gdb: gdb_step                                              # step into (single instruction with `stepi`)
gdb: gdb_next                                              # step over
gdb: gdb_finish                                            # run to function return

# Disassembly + single-instruction step:
gdb: gdb_command command="stepi"
gdb: gdb_command command="nexti"
gdb: gdb_command command="x/10i $pc"                       # 10 instructions at PC
```

### Step 4 — Read state

```text
gdb: gdb_info_registers                                    # all GP regs
gdb: gdb_command command="info registers all"              # all incl. FP/SIMD
gdb: gdb_print expression="argv[1]"
gdb: gdb_print expression="*(unsigned int*)0x804a020"
gdb: gdb_examine expression="0x80100000" format="xw" count=64
        # x = examine, w = word (4 bytes), 64 of them
        # other formats: x/<count><format><size> — b byte, h half, w word, g giant
        #                                          x hex, d dec, u unsigned, t binary, i instruction, s string
gdb: gdb_backtrace                                         # call stack
gdb: gdb_command command="info threads"
gdb: gdb_command command="thread <id>"                     # switch threads
```

### Step 5 — Modify state (powerful, dangerous)

```text
gdb: gdb_command command="set $eax = 0"                    # rewrite a register
gdb: gdb_command command="set var x = 42"                  # rewrite a variable
gdb: gdb_command command="set *(int*)0x804a020 = 0xdead"   # rewrite memory
gdb: gdb_command command="jump *0x401a45"                  # skip over a check
```

Use these to bypass anti-debug checks for analysis purposes only — write
down what you patched in the report so the conclusions are reproducible.

### Step 6 — Reverse debugging (rr or gdb's built-in)

If the binary supports it (gdb's record requires native, not remote, and
small workloads):

```text
gdb: gdb_command command="record full"
gdb: gdb_continue                                          # run forward
gdb: gdb_command command="reverse-continue"                # run backward
gdb: gdb_command command="reverse-step"
```

For larger workloads use [rr](https://rr-project.org) (Linux x86/x86_64
only): `rr record ./binary && rr replay`, then `target extended-remote
| rr-gdb-stub` from inside this skill. rr is the gold standard for
"how did we get into this corrupt state".

## Outputs

Write to `ARTIFACT_DIR/<sample-id>/dynamic-gdb.md`:

```markdown
# Dynamic (GDB) — <sample-id>

## Question
<the one runtime question you came to answer>

## Setup
- Target: native ELF / qemu-user / qemu-system / gdbserver / OpenOCD
- Architecture: <x86_64 / mipsel / armv7-eb / ppc / ...>
- Binary: <path>
- Symbols: <yes from .symtab | imported from Ghidra | none>
- Auth/Authz: <user-authorised, on local VM, on hardware target X>

## Breakpoints / watchpoints set
| Where | Type | Hit count | Note |

## Captures
| Time | Location | Register/Memory | Value | Comment |

## Verdict
<the answer to the question, with citations to the captures table>

## What we did NOT cover
- ...
```

## Hard rules

- **Never debug an un-authorised target.** ptrace/JTAG access to anything
  not yours is illegal in many jurisdictions. State the authorisation
  basis in the report.
- **Single-stepping is slow.** For broad behavioural questions ("what
  does this app do for a minute?") use Frida `Stalker` instead. GDB
  single-step is for narrow, targeted questions.
- **Memory writes via `set` change behaviour.** Patches you apply during
  debugging do NOT modify the on-disk binary, but they DO change what the
  process sees. Use them deliberately and document them.
- **Do not paste full memory dumps into the report.** Hash them or
  excerpt the few bytes needed for clarity. Long dumps go into a separate
  file under `ARTIFACT_DIR/<sample-id>/raw/`.
- **Confidence is high** for direct GDB observations (you saw the
  register value, you watched the memory write happen). Static-only
  inferences in the same report still cap at medium.
