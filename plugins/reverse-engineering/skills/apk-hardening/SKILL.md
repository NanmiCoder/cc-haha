---
name: apk-hardening
description: Identify Android packers/hardeners (360 加固, Tencent Legu/乐固, Bangcle/梆梆, Naga/娜迦, Ijiami/爱加密, ApkProtect, generic VMP, etc.) and route to the correct unpacking strategy. Covers DEX-encryption, class extraction, native packing, anti-debug/anti-frida defences, and Flutter (Dart AOT). Sits between `apk-analysis` (which assumes a non-hardened APK) and the dynamic skills.
whenToUse: When `triage` or `apk-analysis` reports the APK is packed, when `classes.dex` looks empty/stub, when the entry application class is in `com.stub.*` / `com.shell.*` / `com.qihoo.util.*`, or when the user asks "this APK is hardened, what do I do".
allowedTools: Bash, Read, Grep, Glob
---

# apk-hardening skill

Goal: turn "this APK is hardened, decompiled output is gibberish" into a
**concrete next step** — identify which packer / hardener / VMP family is
in use, then route to the unpacking technique that's known to work for
that family (FRIDA-DEXDump for class-extraction shells, FART for full
ART-runtime dump, Unidbg for SO emulation, Blutter for Flutter, etc.).

The skill is split into:

1. **Identification** — APKiD + manual fingerprints — answers "which packer?"
2. **Routing matrix** — given the answer to (1), which technique to try
3. **Per-technique playbooks** — exact shell + frida workflows
4. **Anti-anti-frida prep** — what to do when the target detects frida and bails

## Hard scope reminder before anything else

This skill teaches dynamic-analysis techniques used in **legitimate
security research**:

- self-owned APKs (you wrote it, your company owns it, you got authorisation)
- malware analysis (already-malicious sample to be understood)
- learning / CTF / crackme
- vulnerability research → responsible disclosure → fix loop

**It does NOT cover bypassing commercial license/membership/payment walls
on third-party software.** That's outside this plugin's scope (see the
Scope and rules section in the plugin README).  If the user's goal is
"unlock VIP on app X without paying", refuse and explain.

## Step 1 — Identify the packer

### Pre-check: is the APK actually hardened?

Quick heuristic before reaching for tools — examples that suggest hardening:

```bash
# 1. classes.dex of stub size (real code is encrypted elsewhere)
unzip -l "$SAMPLE" | awk '/classes.*\.dex/ { print $1, $4 }'
# Stub: classes.dex < 50 KB while the APK is megabytes.

# 2. Application class in a shell namespace
unzip -p "$SAMPLE" AndroidManifest.xml | xxd | grep -aE 'com\.(stub|shell|qihoo|tencent|bangcle|ijiami|secneo)' || true

# 3. .so files of suspicious names
unzip -l "$SAMPLE" | grep -E 'lib(jiagu|secshell|shellx|nagain|bangcle|tup|legu|appfortify|kdp)' || true

# 4. assets/ directory holding "i.bin" / "o.dat" / encrypted blobs
unzip -l "$SAMPLE" | grep -E 'assets/(i\.bin|o\.dat|libapp\.so|kdp\.bin)' || true
```

Any of those → APK is almost certainly hardened.

### APKiD — the canonical packer fingerprinter

[APKiD](https://github.com/rednaga/APKiD) by Red Naga is the open-source
Android equivalent of `peid` — pattern-matches against ~30 known packers,
obfuscators, and protectors. Pip-installable, runs offline.

Install (one-time, see plugin README's "External CLI tools" section):

```bash
pipx install apkid
# OR (works in a uv-managed env):
uv tool install apkid
```

Run:

```bash
apkid -j "$SAMPLE" > "$ARTIFACT_DIR/$SAMPLE_ID/apkid.json"
cat "$ARTIFACT_DIR/$SAMPLE_ID/apkid.json" | python -m json.tool | head -60
```

Output (JSON) lists matched detectors per file in the APK. Look for keys
like `packer`, `protector`, `obfuscator`, `anti_vm`, `anti_disassembly`,
`anti_debug`, `manipulator`.

### Manual fingerprints when APKiD says "unknown"

Some Chinese-market packers aren't in APKiD's signatures. Walk the
shipped `.so` and Application class name:

| Library / class fragment | Family |
|---|---|
| `libjiagu.so` / `com.qihoo.util.StubApp` | **360 加固保 / Qihoo 360 Jiagu** |
| `libtup.so` / `libshella.so` / `libshellx-2.so` / `com.tencent.StubShell` / `com.tencent.shell` | **Tencent Legu / 腾讯乐固** |
| `libsecshell.so` / `libsecexe.so` / `com.secneo.apkwrapper` / `com.SecShell` | **Bangcle / 梆梆** (also Secneo) |
| `libnagain.so` / `libnagainapk.so` | **Naga / 娜迦** |
| `libexec.so` / `libexecmain.so` / `com.shell.NativeApplication` | **Ijiami / 爱加密** |
| `libDexHelper.so` / `libDexHelper-x86.so` / `com.alibaba.wireless.security.framework.SecurityGuardManager` | **Alibaba 聚安全** |
| `libbaiduprotect.so` / `libbaiduprotect_arm64.so` | **Baidu 加固** |
| `libapp.so` (with `assets/flutter_assets/`) | **Flutter** (not really hardening, but needs special tooling) |
| `libreact*.so` (with `assets/index.android.bundle`) | **React Native** (handle as a JS bundle) |
| `libil2cpp.so` (with `assets/bin/Data/Managed/Metadata/global-metadata.dat`) | **Unity IL2CPP** |
| Heavily small `classes.dex` + `assets/data.bin` | Custom shell, dump-then-analyse |

### What "VMP" means here

Some packers add VM Protection on top of class-extraction — e.g. 腾讯乐固
upgraded variants, 爱加密 Pro, Bangcle Enterprise. That layer translates
key methods to a custom bytecode interpreted at runtime. Symptoms:

- Extracted DEX has methods that just `invoke-virtual` into a stub /
  return constant — real semantics live elsewhere.
- A method's smali looks too short for what the corresponding Java does.

VMP recovery is **not** automatable in the general case; it requires
reverse-engineering the protector's interpreter. If you suspect VMP, say
so and stop — this is a manual research task.

## Step 2 — Routing matrix

Once you have the packer family, pick a technique:

| Family | Recommended technique | Notes |
|---|---|---|
| 360 加固 (jiagu) | FART / FRIDA-DEXDump | jiagu uses class extraction + native VMP (newer versions). FART works for older versions; FRIDA-DEXDump catches the post-load DEX in memory. |
| Tencent Legu | FRIDA-DEXDump first; for v4.1 also `quarkslab/legu_unpacker_2019` static unpacker | Legu's classes.dex is a stub; real DEX rebuilt at runtime under `/data/data/<pkg>/.tmp/.cache/`. |
| Bangcle / Secneo | FRIDA-DEXDump or hook `dvmDexFileOpenPartial` (older) / `LoadMethod` (ART) | Some Bangcle versions split classes across multiple memory regions; you'll dump multiple DEX files. |
| Naga / Ijiami | FRIDA-DEXDump | Class-extraction shells; usually straightforward. |
| Alibaba 聚安全 | FRIDA-DEXDump + Unidbg for `libDexHelper.so` decryption | Some keys derived in native code; emulate with Unidbg if frida hook fails. |
| Baidu 加固 | FRIDA-DEXDump | Class extraction. |
| Flutter | **Blutter** | Different problem — Dart AOT snapshot, not Android packing. See dedicated section below. |
| Unity IL2CPP | **Il2CppInspector / Il2CppDumper** (not in this skill) | Same — it's a different kind of "hardening". |
| React Native | Just unzip and look at `assets/index.android.bundle` | Not really hardened, just minified JS. |
| Unknown / custom | FRIDA-DEXDump first, then FART, then manual | When all else fails, manual hook on `art::ClassLinker::DefineClass` |

## Step 3 — Per-technique playbooks

Each playbook below assumes:

- Authorised target — see scope reminder above
- Rooted Android device or x86 emulator with root (Genymotion, WSA + Magisk, Android Studio AVD with kernel root)
- frida-server running on the device (matching frida client version)
- ADB working, `adb root && adb shell` succeeds

### 3a — FRIDA-DEXDump (most common starting point)

[`lasting-yang/frida_dump`](https://github.com/lasting-yang/frida_dump) is
the most actively maintained as of 2026; the original
[`hluwa/FRIDA-DEXDump`](https://github.com/hluwa/FRIDA-DEXDump) is the
canonical reference.

```bash
# One-time clone
mkdir -p "$HOME/re-tools"
cd "$HOME/re-tools"
git clone --depth 1 https://github.com/lasting-yang/frida_dump.git
cd frida_dump

# Run against a target package
adb shell pidof <package_name>     # confirm not currently running
python main.py -U -f <package_name>
# Output goes to ./<package_name>/<pid>/*.dex
```

What it does: scans the target's memory for `dex\n035` / `dex\n037` magic
bytes after the package launches, dumps each contiguous DEX it finds.
Many class-extraction shells leave the assembled DEX visible in memory
once the shell's loader has finished its init — this is the easiest dump.

Verify the dumps:

```bash
for f in <package>/<pid>/*.dex; do
  echo "=== $f ==="
  file "$f"        # 'Dalvik dex file version 035'
  # Re-decompile with jadx
  jadx -d "$f.jadx" "$f"
done
```

If multiple dumps came out, the real classes are usually in the largest.
A 50 KB stub dex is the original classes.dex (decoy); the megabyte-sized
ones are the real code.

### 3b — FART (full ART-runtime dump for stubborn packers)

When FRIDA-DEXDump misses methods (because the packer recompiles them
on each call, classic class-extraction with method-level granularity),
FART intercepts the ART runtime itself.

[`hanbinglengyue/FART`](https://github.com/hanbinglengyue/FART) is the
original AOSP-modified ROM. Building it is non-trivial:

- Either: use a pre-built FART ROM (search community archives) for
  Android 7-10
- Or: use [`luoyesiqiu/android-fart`](https://github.com/luoyesiqiu/android-fart),
  a more maintained fork

Result: after launching the target package on a FART device, dumps land
in `/sdcard/fart/` keyed by package — all classes, including those
recompiled per-call.

Pull and reassemble:

```bash
adb pull /sdcard/fart/<package>/ ./fart-out/
ls ./fart-out/
# Files: <method-id>_<class>.bin, plus a per-class JSON describing
# method offsets. There's a Python reassembler in luoyesiqiu/android-fart.
```

Cost of FART: needs a flashed device (one-time), output is bulky and
needs reassembly into a real DEX before you can jadx it. Use it only
when FRIDA-DEXDump came up empty.

### 3c — Unidbg (when SO decryption blocks you)

If the packer's native code decrypts DEX in memory using keys derived in
the SO, frida-side reads might miss the moment. Better path: emulate the
SO offline with [`zhkl0228/unidbg`](https://github.com/zhkl0228/unidbg)
and dump the decryption inputs/outputs.

```bash
# Clone Unidbg (one-time)
git clone --depth 1 https://github.com/zhkl0228/unidbg.git "$HOME/re-tools/unidbg"
cd "$HOME/re-tools/unidbg"
./gradlew :unidbg-android:build

# Write a small Java harness that loads your APK's libsecshell.so and
# calls the decryptor. See unidbg's `unidbg-android/src/test/` for templates.
# Once running, you get the decrypted bytes returned to your harness.
```

This is high-effort — you're writing Java code to drive the emulator —
but it's the only reliable path when:

- The decryption is deeply tied to ART internals (`libnativehelper.so`
  symbols frida can't easily hook)
- The packer detects frida and bails before the dump
- You want repeatable, headless dumping for multiple samples

### 3d — Blutter (Flutter Dart AOT)

Flutter apps don't fit the "dex dump" mental model. Code lives in
`lib/<arch>/libapp.so` as a Dart AOT snapshot — no Java, no DEX,
not even regular ARM functions. You need
[`worawit/blutter`](https://github.com/worawit/blutter):

```bash
# One-time
git clone --depth 1 https://github.com/worawit/blutter.git "$HOME/re-tools/blutter"
cd "$HOME/re-tools/blutter"
./scripts/build.sh

# Use it
cd ../my-flutter-apk
unzip -d unpacked "$SAMPLE"
python "$HOME/re-tools/blutter/blutter.py" \
  unpacked/lib/arm64-v8a out-blutter

# Output: out-blutter/objs.txt (Dart class layout),
#         out-blutter/blutter_frida.js (Frida hooks for Dart methods),
#         IDA / Ghidra import scripts.
```

Blutter only handles arm64 + recent-ish Dart versions. For older Dart,
fall back to [`Doldrums`](https://github.com/rscloura/Doldrums).

## Step 4 — Anti-anti-frida prep (when the target detects frida)

Many hardened APKs ship RASP (runtime application self-protection) checks
that bail on detection. Common detections:

- Process scan for `frida-server`, `frida-agent` strings in `/proc/*/maps`
- Port scan for the default frida-server port `27042`
- `ptrace(PTRACE_TRACEME)` self-attach
- `/sdcard/re.frida.server/` existence
- Inspecting `TracerPid:` in `/proc/self/status`
- Reading `/system/lib/libfrida.so` / similar

The robust answer is [`sensepost/objection`](https://github.com/sensepost/objection),
a frida CLI wrapper that ships pre-built bypasses for the common checks.

Install (one-time):

```bash
pipx install objection
# OR
uv tool install objection
```

Use it:

```bash
# Spawn the target with frida-gadget injected (if the device isn't rooted,
# objection patches the APK to load the gadget; on a rooted device it
# attaches via frida-server).
objection -g <package_name> explore

# Inside the REPL:
android root disable               # patches isRooted() / Magisk detection
android sslpinning disable         # bypasses cert pinning (TrustManager, OkHttp)
android hooking watch class <fqn>  # observe a class without writing JS
android hooking generate simple <fqn>   # emit a starter Frida JS
```

Custom-name the frida-server to evade name-based scans:

```bash
# On the target device:
adb push frida-server /data/local/tmp/fs2024
adb shell chmod +x /data/local/tmp/fs2024
adb shell "/data/local/tmp/fs2024 -l 0.0.0.0:23456 &"

# On your host:
frida -H 127.0.0.1:23456 -F          # forwarded via adb forward tcp:23456 tcp:23456
```

When even renamed frida-server is detected (kernel-level RASP), the only
remaining open-source path is **Magisk + LSPosed + a Zygisk module that
hides frida from the target's `read()` of `/proc`**. That's outside this
skill — it's a Magisk module configuration step the user does once on
their test device.

## Outputs

Append to `$ARTIFACT_DIR/$SAMPLE_ID/hardening.md`:

```markdown
# APK hardening — <sample-id>

## Identification
- APKiD says: <packer name from apkid.json>
- Manual signatures observed:
  - libXXX.so present
  - StubApplication class: com.qihoo.util.StubApp
  - assets/ encrypted blobs: i.bin, o.dat
- Family: 360 加固 / Tencent Legu / Bangcle / ...
- VMP suspected: yes / no — <evidence>

## Strategy
- Primary technique: FRIDA-DEXDump
- Fallback: FART
- Anti-anti-frida needed: yes (detection of frida-server name)
- Tools used: lasting-yang/frida_dump, objection (root + ssl bypass)

## Outcome
- Dumped DEXes: 3 files (12 KB stub, 4.2 MB main, 800 KB plugin)
- Largest dump matches the visible class names in jadx after fresh decompile
- Anti-anti-frida required objection android root disable + custom frida-server name fs2024

## What this run did NOT do
- VMP recovery (some methods are still empty stubs — manual research needed)
- Native code under libsecshell.so (kicked back to pe-elf-macho with Unidbg note)
```

## Hard rules

- **Hard scope** — see the reminder at the top. Refuse if the user is
  trying to bypass a commercial license/membership/payment wall.
- **Never operate on a device the user hasn't authorised.** A rooted
  test device they own is fine; a colleague's phone is not.
- **Don't push frida-server to production-issued devices.** Use a
  dedicated test device, emulator, or VM.
- **Confidence is honest.** Class extraction shells often leave VMP'd
  methods un-recovered; if a chunk of methods come out empty after dump,
  say so in the report — don't claim "fully unpacked".
- **Document the failure mode.** If FRIDA-DEXDump dumped a 50 KB stub
  and that's all, that's a finding — call it out, don't quietly skip
  to FART without explaining why.

## References

- APKiD — https://github.com/rednaga/APKiD
- FRIDA-DEXDump (active fork) — https://github.com/lasting-yang/frida_dump
- FRIDA-DEXDump (canonical) — https://github.com/hluwa/FRIDA-DEXDump
- FART — https://github.com/hanbinglengyue/FART
- FART (more maintained fork) — https://github.com/luoyesiqiu/android-fart
- Tencent Legu static unpacker (older) — https://github.com/quarkslab/legu_unpacker_2019
- Generic check-point unpacker — https://github.com/CheckPointSW/android_unpacker
- Unidbg — https://github.com/zhkl0228/unidbg
- Blutter (Flutter) — https://github.com/worawit/blutter
- Doldrums (Flutter, older Dart) — https://github.com/rscloura/Doldrums
- objection (anti-anti-frida) — https://github.com/sensepost/objection
- OWASP MASTG — root detection bypass and dynamic analysis on hardened APKs — https://mas.owasp.org/MASTG/
