---
name: dynamic-debug-overview
description: Decision guide for picking the right dynamic-analysis tool — Frida (instrumentation), GDB (cross-arch single-step + breakpoints), LLDB (Apple platforms). Lists what each can and cannot do, so the agent doesn't try to single-step with Frida or hook ObjC methods with GDB.
whenToUse: At the start of any dynamic-analysis stage, before invoking frida-dynamic / gdb-debug / lldb-debug. Read this first to pick the right tool; it's short.
allowedTools: Read
---

# dynamic-debug-overview skill

The dynamic-analysis tooling in this plugin splits into three lanes that
do different jobs. Picking the wrong one wastes 10x the time. This skill
exists so the agent reads the decision matrix before reaching for a tool.

## The three lanes

| Lane | Tool | Best at | Cannot do |
|---|---|---|---|
| **Instrumentation** | Frida (`frida-dynamic`) | Function-level hooks, broad behavioural surveys, JS-driven runtime probes, mobile (Android Java + iOS ObjC), cross-language at runtime, indirect call resolution via Stalker | Single-step, real breakpoints, kernel/embedded firmware (in practice) |
| **Cross-arch debugger** | GDB (`gdb-debug`) | Single-step, real breakpoints, watchpoints, **embedded firmware via qemu/gdbserver/OpenOCD on MIPS/ARM/PowerPC/68k/SH/RISC-V**, reverse-debug (rr) | ObjC/Swift introspection (LLDB does this better), Java-level hooks, broad behavioural surveys (too slow) |
| **Apple-native debugger** | LLDB (`lldb-debug`) | macOS/iOS internals, ObjC/Swift symbols, dyld shared cache, debugserver-based iOS device debugging | PowerPC/68k (LLDB doesn't ship them), Java-level hooks, broad surveys |

## Decision tree

```
Is the target on iOS or macOS?
├── Yes → lldb-debug
│         (For the static-decryption question first, see ios-analysis.)
└── No
    ├── Is the target embedded firmware (router image, ECU dump, Cortex-M flash, RTOS kernel)?
    │   └── gdb-debug, with qemu-system-* or hardware gdbserver / OpenOCD
    ├── Is the question "what does this app do at runtime, broadly?" or
    │   "what's the value passed to NSURLSession/OkHttp/Cipher.doFinal?"
    │   └── frida-dynamic (cheapest, fastest, broadest)
    ├── Is the question "what register / memory state / branch is taken
    │   when we hit address X?" or "single-step through unpacker"?
    │   └── gdb-debug (or lldb-debug on Apple platforms)
    ├── Is the question "watch every write to global G"?
    │   └── gdb-debug (`watch *(int*)G`) or lldb-debug (`watchpoint set`)
    │     (Frida MemoryAccessMonitor is a third option but costs more.)
    └── Default → frida-dynamic if a function name maps to the question;
                  otherwise gdb-debug.
```

## Capability matrix (so you don't ask the wrong tool)

| Capability | Frida | GDB | LLDB |
|---|---|---|---|
| Read process memory | ✅ `Memory.readByteArray` | ✅ `x/<n><fmt>` | ✅ `memory read` |
| Write process memory | ✅ `Memory.writeByteArray` | ✅ `set *(int*)addr = val` | ✅ `memory write` |
| Read GP registers | ✅ inside hook: `this.context.x0` | ✅ `info registers` | ✅ `register read` |
| Write GP registers | ✅ inside hook: `this.context.x0 = ptr(0)` | ✅ `set $eax = 0` | ✅ `register write x0 0x0` |
| Call stack | ✅ `Thread.backtrace + DebugSymbol.fromAddress` | ✅ `bt` | ✅ `bt` |
| Function-level hook | ✅ `Interceptor.attach` | ✅ breakpoint + commands | ✅ breakpoint + script |
| Address-level hook (any instruction) | ✅ `Interceptor.attach(addr, ...)` | ✅ breakpoint at `*0xADDR` | ✅ breakpoint at addr |
| Instruction-level trace | ✅ `Stalker` (cheap) | ✅ `set logging on; while 1: stepi` (slow) | ✅ same approach (slow) |
| Single-step (instruction) | ❌ | ✅ `stepi` | ✅ `thread step-inst` |
| Single-step (source line) | ❌ | ✅ `step`/`next` (with debug info) | ✅ same |
| Real software breakpoint | ❌ (uses trampoline) | ✅ INT3 / ARM BKPT | ✅ same |
| Hardware breakpoint | ⚠️ Linux only, `HardwareBreakpoint` API | ✅ `hbreak`, target-dependent | ✅ same |
| Watchpoint | ⚠️ via `MemoryAccessMonitor` (page granularity) | ✅ `watch`, byte granularity | ✅ `watchpoint set` |
| Reverse-debug | ❌ | ✅ via rr (Linux) or `record full` | ⚠️ limited (`reverse-step` requires support) |
| Java method hook | ✅ `Java.use("X").method.implementation = ...` | ❌ | ❌ |
| ObjC method hook | ✅ `Interceptor.attach(ObjC.classes.X['- y:'])` | ❌ | ✅ `breakpoint set -n "-[X y:]"` |
| Cross-architecture (MIPS, PPC, 68k) | ⚠️ via frida-server on target | ✅ gdb-multiarch / qemu-user | ⚠️ limited (no PPC32, no 68k) |
| iOS device | ✅ frida-server on jailbroken | ⚠️ via `debugserver` (LLDB-style) | ✅ via debugserver |
| Java/Android | ✅ JVM bridge | ⚠️ JNI only, no Java symbols | ⚠️ JNI only |

## Common mistakes the agent makes

1. **Trying to single-step in Frida.** Frida is not a debugger. Use
   `Stalker` for instruction-level *trace*, or switch to GDB/LLDB for
   actual stepping.
2. **Using GDB on iOS app code.** If the App Store binary hasn't been
   FairPlay-decrypted, GDB sees garbage in `__TEXT`. Run `ios-analysis`
   first; if `cryptid=1`, dynamic analysis is blocked until decryption.
3. **Using LLDB for embedded ARM/MIPS firmware in qemu.** LLDB doesn't
   ship cross-arch the way `gdb-multiarch` does. Use GDB for these.
4. **Reaching for Frida on Cortex-M flash.** Frida needs an OS to host
   `frida-server`; bare-metal embedded doesn't have one. Use GDB +
   OpenOCD or qemu-system.
5. **Hooking Java methods through GDB.** Java method dispatch goes
   through ART; you need Frida's Java bridge or a JDI-aware debugger.

## Hand-off

Once you've chosen a tool, jump to its skill (`frida-dynamic`,
`gdb-debug`, `lldb-debug`). Each writes its findings to a
tool-specific report file under `ARTIFACT_DIR/<sample-id>/`:

- `dynamic-frida.md`
- `dynamic-gdb.md`
- `dynamic-lldb.md`

The `re-report` skill aggregates them into the final `report.md`.
