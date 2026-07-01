---
name: lldb-debug
description: Real single-step debugging via LLDB CLI directly. macOS / iOS (debugserver) / Linux. Set breakpoints, step, read/write registers and memory, walk the call stack, watchpoints, disassemble. Stronger than GDB for ObjC/Swift symbol handling, dyld shared cache, and Apple platform internals. Note — the `lldb-mcp` server was removed in v0.4.5 due to upstream packaging issues; the agent drives `lldb` directly via Bash.
whenToUse: When the target is on macOS or an iOS device (jailbroken or developer-signed), or when you need LLDB's superior ObjC/Swift handling on Linux. Particularly important for analysing iOS apps post-FairPlay-decryption.
allowedTools: Bash, Read
---

# lldb-debug skill

Goal: same goal as `gdb-debug` — single-step, set breakpoints, read state —
but on Apple platforms or wherever LLDB's symbol handling beats GDB.

## Tool surface — direct CLI, not MCP

This plugin's `lldb-mcp` server was removed in v0.4.5 because the upstream
(`stass/lldb-mcp` and `stableversion/lldb_mcp`) ships as a single Python
script with no `pyproject.toml` packaging — `uvx --from git+...` cannot
install it. See the README's "Currently unbundled MCP servers" section.

The agent drives LLDB **directly via the `lldb` CLI through Bash**.
Every workflow that used to look like `lldb: lldb_set_breakpoint
location=main` now reads as a real LLDB command issued to a session
spawned with `lldb -- /path/to/binary` or attached with `lldb -p <pid>`.

Two practical patterns:

### Pattern 1 — Interactive subprocess with batched commands

```bash
# Drive lldb non-interactively with -o (one-shot commands) or -s <file>
lldb -b -o "target create /path/to/binary" \
        -o "breakpoint set --name main" \
        -o "process launch -- arg1 arg2" \
        -o "register read x0 x1" \
        -o "thread backtrace 5" \
        -o "quit"
```

`-b` (`--batch`) means "exit on errors instead of dropping to prompt"
— good for scripted runs.

### Pattern 2 — Persistent session via fifo

When you need stateful interaction (set breakpoint, run, hit, inspect,
continue), drive LLDB through a named pipe so the agent's Bash tool
can issue commands across multiple turns:

```bash
mkfifo /tmp/lldb-in
lldb < /tmp/lldb-in &
LLDB_PID=$!

# Issue commands:
echo "target create /path/to/binary" > /tmp/lldb-in
echo "breakpoint set --name main" > /tmp/lldb-in
echo "run" > /tmp/lldb-in
# ...

# Cleanup
echo "quit" > /tmp/lldb-in
wait $LLDB_PID
rm /tmp/lldb-in
```

The simplest case (small batch of commands) is Pattern 1. Switch to
Pattern 2 only when you need to alternate between long inspection
turns and a single live process.

## When this skill is the right pick

| Question | This skill | Pick something else |
|---|---|---|
| "Step through an ObjC `-[NSString componentsSeparatedByString:]`" | ✅ lldb-debug | LLDB knows ObjC method signatures natively |
| "Inspect a Swift `Array<T>` at runtime" | ✅ lldb-debug | LLDB has a Swift formatter; GDB doesn't |
| "Debug an iOS app on a jailbroken device" | ✅ lldb-debug + debugserver | — |
| "Debug a macOS framework's dyld load order" | ✅ lldb-debug (`image list`, `image dump line-table`) | — |
| "Embedded MIPS firmware in QEMU" | ❌ — use gdb-debug | LLDB's cross-arch is weaker than gdb-multiarch |
| "PowerPC e200 ECU dump" | ❌ — use gdb-debug | LLDB doesn't ship PPC32 by default |
| "Hook every NSURLSession on iOS for an hour" | ❌ — use frida-dynamic | LLDB single-step is too slow for broad surveys |

## Setup paths

### Path A — local macOS or Linux binary

Easiest case. LLDB is on PATH (`xcrun lldb` on macOS, `apt install lldb`
on Debian, `dnf install lldb` on Fedora, `brew install llvm` for the
LLVM-bundled lldb).

```bash
# One-shot inspection
lldb -b -o "target create /path/to/binary" \
        -o "breakpoint set --name main" \
        -o "process launch" \
        -o "register read --all" \
        -o "thread backtrace" \
        -o "quit"
```

### Path B — attach to a running PID

```bash
# Attach to a running process
sudo lldb -p 12345 -b \
  -o "process status" \
  -o "thread backtrace all" \
  -o "register read x0 x1 x2" \
  -o "detach" \
  -o "quit"
```

macOS requires either Apple developer signing on your `lldb` binary, or
running as root. iOS in this mode is **only** for the simulator — for a
real device, see Path C.

### Path C — iOS device (jailbroken, with debugserver)

On the device:

```bash
# Push debugserver to /usr/bin (jailbroken; one-time setup)
debugserver *:1234 -a <pid>           # attach mode
# OR
debugserver *:1234 /Applications/Foo.app/Foo   # spawn mode
```

On your Mac:

```bash
lldb -b \
  -o "platform select remote-ios" \
  -o "process connect connect://<device-ip>:1234" \
  -o "image list" \
  -o "process status"
```

Note iOS apps from the App Store arrive **FairPlay-encrypted** — the
`__TEXT` segment is unreadable until you've dumped the decrypted binary
(via `frida-ios-dump` / `bagbak`). Without that, breakpoints in app code
won't resolve to anything meaningful. State this in the report.

### Path D — Linux gdbserver-style remote (lldb-server)

LLDB has its own remote daemon, `lldb-server`:

```bash
# On target:
lldb-server platform --listen *:1234
# OR for a specific binary:
lldb-server gdbserver *:1234 -- ./binary
```

On your host:

```bash
lldb -b \
  -o "platform select remote-linux" \
  -o "platform connect connect://<ip>:1234" \
  -o "target create /local/path/to/binary"
```

## Procedure — once you're connected

### Step 1 — Symbols

LLDB picks up symbols automatically if dSYM bundles are next to the
binary or in the dyld shared cache. For stripped binaries:

```bash
lldb -b -o "target create /path/to/binary" \
        -o "image list" \
        -o "add-dsym /path/to/Foo.app.dSYM" \
        -o "image lookup -n SymbolName" \
        -o "quit"
```

For ObjC, classes/methods come from the `__objc_*` sections in the binary
itself — no separate `.dSYM` needed. `image lookup -n -[NSString
componentsSeparatedByString:]` works on stripped binaries.

### Step 2 — Set breakpoints

LLDB breakpoint syntax:

```text
breakpoint set --name main                          # by symbol
breakpoint set --name "-[ViewController viewDidAppear:]"
breakpoint set --address 0x100001a30                # by absolute address
breakpoint set --regex "^cleartext_.*"              # all funcs starting with cleartext_

# Conditional:
breakpoint set -n send -c '$arg2 != 0'

# Commands to run on hit (use breakpoint command add):
breakpoint command add 1
> bt 5
> register read x0 x1
> continue
> DONE
```

Watchpoints:

```text
watchpoint set variable g_state
watchpoint set expression -- 0x100008020
watchpoint modify -c '*((int*)0x100008020) > 0'
```

### Step 3 — Step / continue

```text
continue                            # resume to next breakpoint
step                                # step into (source line if symbols, else instruction)
next                                # step over
finish                              # run to current function return
thread step-inst                    # single-instruction step (stepi)
thread step-inst-over               # nexti
disassemble                         # disasm at PC
disassemble -c 10                   # 10 instructions
```

### Step 4 — Read state

```text
register read --all                 # all GP/FP/SIMD regs
register read x0 x1 x2 x3
print argv[1]
print *(unsigned int*)0x100008020
memory read --size 4 --format x --count 64 0x100008000
memory read -s 4 -fx -c 64 0x100008000   # short form
thread backtrace                    # bt
thread backtrace all
thread list
thread select 2

# ObjC-specific:
po self                             # describe current ObjC instance
po (id)$x0                          # treat register as ObjC id
expression -l objc -- (id)NSStringFromClass([self class])

# Swift-specific (when LLDB is Swift-aware):
frame variable
expression -l swift -- self.someProperty
```

### Step 5 — Modify state

```text
register write x0 0x0
memory write --size 4 0x100008020 0x0000dead
thread jump --by 8                  # skip 8 bytes ahead
```

Same caveat as in `gdb-debug`: in-memory patches don't change the binary
on disk, but they DO change what the process sees. Document.

### Step 6 — Disassemble around a stuck point

```text
disassemble                         # current frame
disassemble --address 0x100001a30 --count 32
disassemble --name "-[NSString length]"
```

## Outputs

Write to `$ARTIFACT_DIR/$SAMPLE_ID/dynamic-lldb.md`:

```markdown
# Dynamic (LLDB) — <sample-id>

## Question
<the one runtime question>

## Setup
- Platform: macOS / iOS-device / iOS-simulator / Linux
- Architecture: <x86_64 / arm64>
- Binary: <path>
- FairPlay status (iOS only): encrypted / decrypted dump
- LLDB version: <output of `lldb --version`>
- Auth: <user-authorised, device X owned by user, etc.>

## Breakpoints / watchpoints
| Where | Type | Hit count | Note |

## Captures
| Time | Location | Register/Memory/ObjC | Value | Comment |

## Verdict
<the answer, citing captures>

## What we did NOT cover
- ...
```

## Hard rules

- **iOS App Store binaries are FairPlay-encrypted.** Breakpoints in
  app code resolve to garbage until you've debugged a decrypted dump.
  State the encryption status before any other claim.
- **macOS SIP and notarisation gates.** Some processes can't be
  debugged even by root without disabling SIP or signing your `lldb`
  with the right entitlements (`com.apple.security.cs.debugger`).
  Don't disable SIP on a production machine.
- **Don't reverse-engineer commercial DRM via LLDB on a target you
  don't own.** Same rule as gdb-debug.
- **Don't dump the dyld shared cache** to the report. It's huge and
  sample-specific. Excerpt the symbol/section you need.
- **Confidence is high** for direct LLDB observations.
