---
name: frida-dynamic
description: Dynamic instrumentation via Frida (frida-mcp PyPI package). Function and address-level hooks, memory read/write, register inspection inside hooks, call stacks, instruction-level tracing via Stalker, watchpoints via MemoryAccessMonitor. Best for mobile (Android/iOS) and broad behavioural surveys; not a single-step debugger — for that use gdb-debug or lldb-debug. Includes anti-anti-frida prep for hardened mobile apps with RASP detection.
whenToUse: When you need runtime behaviour from a process you can attach to (Android via frida-server, iOS via frida-server on jailbroken device, Linux/macOS/Windows desktop via Frida CLI). Pick this over gdb-debug when the question is "what does this app do at runtime broadly" or "hook every Java method"; pick gdb-debug instead when the question is "single-step through unpacker" or "watch register r3 at address X".
allowedTools: Bash, Read, Glob
---

# frida-dynamic skill

Goal: get runtime answers — function arguments, return values, memory
content, register state, control flow, call stacks — from a process the
user has authorised you to instrument. Optimised for mobile and for
broad behavioural questions; for single-step / breakpoint workflows use
`gdb-debug` or `lldb-debug` (see `dynamic-debug-overview`).

## Pre-flight checks

Before any hook fires:

1. **Authorisation** — confirm with the user that the target device or
   VM is theirs and they want it instrumented. If they didn't explicitly
   say yes, stop and ask.
2. **Frida server reachable** — `frida-mcp` (PyPI) needs a `frida-server`
   process on the target (Android emulator, jailbroken iPhone) or
   `frida` on the local host (desktop). Verify with
   `frida: list_devices` and `frida: list_processes`.
3. **Target launched** (or attachable) — note the package name (Android),
   bundle id (iOS), or PID.
4. **RASP / anti-frida present?** — if the target is a hardened
   mobile app (per `apk-hardening` triage), assume frida will be
   detected. See "Anti-anti-frida prep" section below before attaching.

## Anatomy of a Frida session

```text
frida: list_devices                                       # local | usb | remote
frida: list_processes device=usb
frida: spawn package=com.example.app                      # Android — spawn paused
frida: attach pid=<pid>                                   # OR attach to running
frida: load_script pid=<pid> source="<JS>"                # inject JS
frida: read_messages pid=<pid> max=200                    # tail send() messages
frida: detach pid=<pid>
```

The injected JS runs **inside the target process**. It has Frida's
JavaScript runtime (`Memory`, `Module`, `Process`, `Thread`, `Java`,
`ObjC`, `Interceptor`, `Stalker`, `Stalker`) bound to native APIs.

## Capability 1 — Function and address-level hooks

### Native functions by export name

```js
const fn = Module.findExportByName(null, "connect")  // null = any module
Interceptor.attach(fn, {
  onEnter(args) {
    send({ kind: "connect.enter", sockfd: args[0].toInt32() })
    // args[0..N] are NativePointers; convert as needed.
  },
  onLeave(retval) {
    send({ kind: "connect.leave", ret: retval.toInt32() })
    // retval.replace(ptr(-1)) would force the call to fail
  }
})
```

### Hook by address (any instruction in mapped memory)

```js
const base = Module.getBaseAddress("libfoo.so")
const target = base.add(0x1a30)  // address you got from Ghidra
Interceptor.attach(target, {
  onEnter() { send({ kind: "hit", at: target.toString() }) }
})
```

This is Frida's equivalent of "set a breakpoint at address X" — it's a
trampoline, not a real CPU breakpoint, but functionally identical for
catching execution at a specific address.

### Replace function entirely

```js
const malloc = Module.findExportByName(null, "malloc")
const orig = new NativeFunction(malloc, "pointer", ["size_t"])
Interceptor.replace(malloc, new NativeCallback(function (size) {
  send({ kind: "malloc", size: size.toInt32() })
  return orig(size)            // call through to the real one
}, "pointer", ["size_t"]))
```

Use `Interceptor.replace` when you need to filter or modify behaviour,
not just observe.

### Java hook (Android only)

```js
Java.perform(function () {
  const Cipher = Java.use("javax.crypto.Cipher")
  Cipher.doFinal.overload("[B").implementation = function (input) {
    send({ kind: "aes.input.b64",
           b64: Java.use("android.util.Base64").encodeToString(input, 0) })
    return this.doFinal(input)
  }
})
```

### ObjC hook (iOS / macOS)

```js
const cls = ObjC.classes.NSURLSession
const m = cls["- dataTaskWithURL:completionHandler:"]
Interceptor.attach(m.implementation, {
  onEnter(args) {
    // args[0]=self, args[1]=_cmd, args[2]=URL, args[3]=completionHandler
    const url = new ObjC.Object(args[2])
    send({ kind: "nsurlsession.url", url: url.absoluteString().toString() })
  }
})
```

## Capability 2 — Memory read and write

```js
// Read
const buf = Memory.readByteArray(addr, 64)             // 64 bytes as ArrayBuffer
const cstr = Memory.readUtf8String(addr)               // until \0
const u32 = Memory.readU32(addr)
const u64 = Memory.readU64(addr)
const ptr_ = Memory.readPointer(addr)
const f64 = Memory.readDouble(addr)

// Write (pre-mutate)
Memory.writeU32(addr, 0xdeadbeef)
Memory.writeByteArray(addr, [0x90, 0x90, 0x90, 0x90])  // x86 nops
Memory.writeUtf8String(addr, "patched")

// Allocate scratch buffer
const scratch = Memory.alloc(256)

// Scan memory for a pattern (limited; expensive)
Memory.scan(base, size, "00 11 22 ?? 44", {
  onMatch(addr, size_) { send({ kind: "match", at: addr.toString() }) },
  onComplete() { send({ kind: "scan.done" }) }
})

// Protection (rwx)
Memory.protect(addr, size, "rwx")  // careful — required before write to .text
```

Memory you write **persists for the life of the process** (or until you
write again). It does NOT modify the binary on disk. Use this for
"what if I bypass this anti-debug check?" experiments.

## Capability 3 — Registers, via CpuContext (inside hooks)

`this.context` inside `onEnter` / `onLeave` is the live CPU context. You
can read and write registers there.

```js
Interceptor.attach(target, {
  onEnter() {
    // x86_64
    send({ rax: this.context.rax.toString(),
           rdi: this.context.rdi.toString(),
           rsi: this.context.rsi.toString(),
           pc: this.context.rip.toString() })

    // ARM64
    send({ x0: this.context.x0.toString(),
           x1: this.context.x1.toString(),
           pc: this.context.pc.toString(),
           sp: this.context.sp.toString() })

    // Write back — bypass an anti-debug check by faking the return:
    this.context.x0 = ptr(0)        // or rewrite any register
  }
})
```

Available registers depend on architecture (`Process.arch`):
- `ia32`: `eax, ebx, ecx, edx, esi, edi, ebp, esp, eip, eflags`
- `x64`: `rax..r15, rip, rflags`
- `arm`: `r0..r12, sp, lr, pc, cpsr`
- `arm64`: `x0..x28, fp, lr, sp, pc, nzcv`

## Capability 4 — Call stack

```js
Interceptor.attach(target, {
  onEnter() {
    const frames = Thread.backtrace(this.context, Backtracer.ACCURATE)
    const sym = frames.map(f => DebugSymbol.fromAddress(f).toString())
    send({ kind: "bt", frames: sym })
  }
})
```

Two backtracer modes:
- `Backtracer.ACCURATE` — uses unwind info; slower, correct for
  optimised code.
- `Backtracer.FUZZY` — heuristic; faster, sometimes wrong.

`DebugSymbol.fromAddress(addr)` resolves to `module!fname+offset` when
symbols are available; otherwise just `module+offset`.

## Capability 5 — Stalker (instruction-level trace)

This is Frida's answer to "what does this code actually execute" — the
closest Frida gets to a single-step debugger. It works at the **basic
block** granularity by default, with optional instruction granularity.
Way faster than GDB single-step, way more data.

```js
const tid = Process.getCurrentThreadId()

Stalker.follow(tid, {
  events: {
    call: true,        // every call instruction
    ret: false,
    exec: false,       // every executed instruction (very expensive)
    block: true,       // every basic block entered
    compile: false
  },
  onReceive(events) {
    const parsed = Stalker.parseEvents(events)
    parsed.forEach(e => {
      // e is [eventTypeChar, location, target, depth] for call events
      send({ kind: "stalker", e })
    })
  }
})

// Run target code...

Stalker.unfollow(tid)
Stalker.flush()
```

### When to use Stalker vs GDB

- "Trace every function called for 5 seconds" → Stalker.
- "Single-step 30 instructions through a hand-crafted decryption stub" →
  GDB. Stalker can do it (`exec: true`) but throughput is limited and
  the data volume is hard to consume.
- "Find the basic block where the password compare happens" → Stalker
  with `block: true`, then look at addresses that fire only when the
  comparison is hit.

### Stalker.exclude — keep it cheap

Stalker recompiles every basic block on first execution. Excluding
hot paths (system libs, runtime) saves CPU:

```js
Stalker.exclude(Module.find('libc.so.6').enumerateRanges('--x'))
Stalker.exclude(Module.find('libsystem_c.dylib').enumerateRanges('--x'))
```

## Capability 6 — Watchpoints (MemoryAccessMonitor)

Page-granularity, software-emulated watchpoints. Slower than GDB's
hardware watchpoints, but they work cross-platform.

```js
MemoryAccessMonitor.enable([{ base: ptr("0x1234000"), size: 0x1000 }], {
  onAccess(details) {
    send({ kind: "wp",
           op: details.operation,        // "read" | "write" | "execute"
           from: details.from.toString(),
           addr: details.address.toString() })
  }
})
```

For byte-granularity watchpoints, use `gdb-debug` instead.

## Capability 7 — Hardware breakpoints (Linux/Android only)

```js
// Available on Linux/Android x86_64 and arm64.
const hbp = HardwareBreakpoint.create({
  index: 0,                            // DR0..DR3 on x86, BVR0..BVR3 on arm
  address: ptr("0x401a30"),
  type: "execute",                     // "execute" | "read" | "write" | "access"
  size: 4
})
// hits surface as Process exception events you'd subscribe to.
```

Limited; for a real "I want to break and inspect" workflow, switch to
GDB or LLDB.

## Capability 8 — Tracking dynamically-loaded code

```js
Process.enumerateModules({
  onMatch(mod) { send({ kind: "mod", name: mod.name, base: mod.base.toString() }) }
})

// Notify on new loads:
Process.attachExceptionHandler(...)  // for SIGSEGV / illegal instr handling
```

For tracking `dlopen`/`LoadLibrary` calls (so you don't miss
runtime-loaded modules), hook those APIs and re-scan.

## Anti-anti-frida prep

Hardened mobile apps (anything triaged by `apk-hardening` as packed,
plus most banking / payment / DRM apps) ship RASP (runtime application
self-protection) checks that detect frida and either crash on attach,
quietly disable functionality, or bail with a generic error. Before
spending time on the actual hooks, walk through the bypass.

### Common anti-frida defences observed in 2025-2026

| Detection | What the target looks for | Bypass |
|---|---|---|
| Process scan | `frida-server`, `frida-agent` strings in `/proc/*/maps`, `/proc/*/cmdline` | Rename frida-server to a random binary; objection's `android root disable` patches `/proc` reads |
| Port scan | TCP `0.0.0.0:27042` (default) listening | Run frida-server on a random port + `adb forward` |
| Self-attach | `ptrace(PTRACE_TRACEME)` returns -1 if a debugger / frida is attached | objection's `android root disable` covers this; or LSPosed Zygisk module |
| Tracer probe | `/proc/self/status` `TracerPid:` non-zero | Same as above |
| Marker file | Looks for `/data/local/tmp/re.frida.server` etc. | Don't drop the canonical paths; use `/data/local/tmp/<random>` |
| Library scan | `dlopen`-walks loaded modules for `libfrida-*.so` | Use frida-gadget injected into the APK rather than frida-server, with renamed gadget |

### Path A — objection (recommended starting point)

[`sensepost/objection`](https://github.com/sensepost/objection) is a
pip-installable frida CLI wrapper that ships pre-built bypasses for
the common detections plus a usable interactive REPL.

```bash
# Install once: pipx install objection   OR   uv tool install objection
which objection || echo "objection not on PATH — see README External CLI tools"

# Spawn the target with frida-gadget already injected (works even on
# unrooted devices because objection patches the APK to load gadget):
objection -g <package_name> explore

# Inside the REPL, run the standard bypasses BEFORE any hook:
android root disable               # patches isRooted(), Magisk, su detection
android sslpinning disable         # bypasses pinning for HTTPS interception
android hooking watch class <fqn>  # monitor a class without writing JS
android hooking generate simple <fqn>   # emit a starter Frida JS snippet

# Then either drive everything from objection, or attach a separate
# frida session to the same gadget for advanced JS hooks.
```

### Path B — rename frida-server, run on non-default port

For rooted devices where you want the full frida toolkit (not just
objection's REPL), evade name-based detection:

```bash
# On the target device:
adb push frida-server-16.x.x-android-arm64 /data/local/tmp/fs2024
adb shell "chmod +x /data/local/tmp/fs2024"
adb shell "/data/local/tmp/fs2024 -l 0.0.0.0:23456 &"
# Forward to host:
adb forward tcp:23456 tcp:23456

# Host frida CLI with explicit host:port:
frida -H 127.0.0.1:23456 -F            # foreground all
frida -H 127.0.0.1:23456 -n com.example.app -l hook.js   # spawn + load script
```

### Path C — LSPosed + frida-hider Zygisk module

When even renamed frida-server is detected (kernel-level RASP that
checks process metadata or scans memory for frida agent regions), the
remaining open-source path is a Zygisk module that hides frida from
the target's view of the system. This is a one-time device setup:

1. Root the test device with Magisk
2. Install Zygisk + LSPosed
3. Install a frida-hider Zygisk module (community-maintained; search
   your usual Magisk module repo)
4. Whitelist the target package in the module's scope

This is outside this skill's scope (it's device prep, not skill
content), but the agent should mention it as the escalation path when
A and B both fail.

### Verifying the bypass actually worked

After applying any bypass, run a quick smoke before committing to a
real session:

```bash
# 1. Can the target be spawned/attached without immediate exit?
frida -H 127.0.0.1:23456 -f <pkg> -l /dev/null --no-pause

# 2. Does it survive the first second?
sleep 2
adb shell "pidof <pkg>"
# Should still be alive. If the PID changed or vanished, the app's
# anti-debug killed itself — escalate to Path B/C or report the
# failure mode.
```

If the target actively monitors anti-tampering after the bypass (some
apps re-check periodically), instrument that check and bypass it too —
but document what you bypassed, since silenced anti-tamper is itself
a finding the user should know about.

## Procedure — driving a session

### Step 1 — Pick the question

Have one runtime question written down before injecting any script.
"Look around" wastes time and risks tipping off anti-analysis.

### Step 2 — Pick the smallest viable hook (decision table)

| Question | Hook |
|---|---|
| Where does this Android app phone home? | `okhttp3.OkHttpClient` / `java.net.URL` / native `connect` |
| What plaintext goes into AES on iOS? | `CCCrypt` import / `-[NSData AES256...]` ObjC |
| Crypto plaintext (Linux) | `EVP_EncryptUpdate` |
| Why does control reach branch B and not A at sub_401a30? | `Interceptor.attach` at addr, dump `this.context.pc/flags`, capture call stack |
| What's the runtime layout of struct X at runtime? | `Memory.readByteArray(this.context.x0, sizeof(X))` then parse |
| Trace every basic block for 1 sec | `Stalker.follow` with `block: true` |
| When is global at 0x1234000 first written? | `MemoryAccessMonitor` on its 4KB page |

### Step 3 — Capture, don't roam

`send({...})` results — don't `console.log` huge dumps. Frida's
inter-process channel has a practical message-rate ceiling.

### Step 4 — Persist

Append every observation to
`ARTIFACT_DIR/<sample-id>/dynamic-frida.md`:

```markdown
# Dynamic (Frida) — <sample-id>

## Question
What URL is contacted on Login?

## Setup
- Device: Pixel 6 emulator (Android 13, x86_64)
- frida-server: 16.4.10 (running as root)
- Target: com.example.app (PID 9821, attached at 14:21 UTC)
- Authorised by user: yes

## Hook
- okhttp3.Request$Builder.url(String)

## Captured
- 14:21:33Z  https://api.example.com/v3/login
- 14:21:33Z  https://telemetry.example.com/event

## Verdict
Login press triggers 2 HTTPS calls — the auth (api.example.com) and a
telemetry beacon (telemetry.example.com) wrapped in a separate SDK
(com.metric.sdk) not visible in static analysis.
```

## Hard rules

- **Never** instrument a device or app the user hasn't explicitly
  authorised. "It's a public app" is not consent.
- **Don't bypass anti-cheat / DRM** unless legal basis exists (your own
  software, authorised pentest scope, public CTF). Refuse otherwise.
- **Detach when done.** Long-lived hooks accumulate state, slow the
  target, and leak.
- **Don't dump full request/response bodies** to the report unless they
  are small and clearly non-PII. Hash them, or redact.
- **Stalker is expensive.** Always `Stalker.exclude` system libraries
  and `Stalker.flush()` after `unfollow`.
- **State residual risk.** If the question wasn't fully answered, say
  so; dynamic snapshots can miss code paths that need different inputs.
- **Frida is not a debugger.** If the question requires real
  single-stepping or watching individual register values change one
  instruction at a time, switch to `gdb-debug` (cross-arch) or
  `lldb-debug` (Apple platforms).
