---
name: apk-analysis
description: Static analysis of (non-hardened) Android APKs using JADX (decompilation) and apktool (resources). Extracts the manifest, exported components, permissions, hardcoded secrets, and routes embedded native libs back to native binary analysis. **For hardened/packed APKs, use `apk-hardening` first to unpack.**
whenToUse: After triage detects an APK (zip with AndroidManifest.xml) AND APKiD did not flag a packer/protector. For packed APKs, run `apk-hardening` first; it will produce dumped DEX files which you can then feed back into this skill. For embedded `.so` files, complete this skill first, then chain to pe-elf-macho.
allowedTools: Bash, Read, Grep, Glob
---

# apk-analysis skill

Goal: turn an opaque (non-hardened) APK into a structured picture of (a) the
Android attack surface (manifest, exported components, permissions), (b) the
Java/Kotlin code the developer wrote, and (c) any native code that takes
over from there.

## Pre-check — is this APK hardened?

Before running this skill's static workflow, confirm the APK is **not
packed**. A hardened APK presents a stub `classes.dex` that fools static
analysis; you'll see meaningless code and reach incorrect conclusions.

```bash
# Run APKiD if it's installed (recommended — see apk-hardening skill)
which apkid && apkid -j "$SAMPLE" | python -m json.tool | head -40

# Quick manual signal — stub-sized classes.dex is a giveaway
unzip -l "$SAMPLE" | awk '/classes.*\.dex/ { print $1, $4 }'
# If classes.dex < 50 KB while the APK is megabytes → likely hardened.

# Application class in a known shell namespace
unzip -p "$SAMPLE" AndroidManifest.xml | xxd | grep -aE 'com\.(stub|shell|qihoo|tencent|bangcle|ijiami|secneo)' || true
```

If any of those say "hardened", **route to the `apk-hardening` skill**.
That skill produces dumped DEX files; once you have those, feed them
into this skill (run jadx on the dumped DEX rather than on `$SAMPLE`
directly).

If everything says "looks normal", continue with this skill.

## Tool selection

This plugin's `jadx` and `apktool` MCP servers were **removed in v0.4.5**
because their upstream packaging is currently broken (see the README's
"Currently unbundled MCP servers" section). The agent drives both tools
**directly via shell** — JADX (`jadx` CLI) and apktool (`apktool` CLI),
both Java-based, both single-binary.

Prereqs (verify once at session start):

```bash
which jadx     || echo "jadx not on PATH — see README External CLI tools"
which apktool  || echo "apktool not on PATH — see README External CLI tools"
which java     || echo "java not on PATH — both jadx and apktool need JRE 17+"
```

## Procedure

### Step 1 — Manifest and structure

```bash
# Decode AndroidManifest.xml + resources to a working dir
mkdir -p "$ARTIFACT_DIR/$SAMPLE_ID/apktool-out"
apktool d -f "$SAMPLE" -o "$ARTIFACT_DIR/$SAMPLE_ID/apktool-out"
cat "$ARTIFACT_DIR/$SAMPLE_ID/apktool-out/AndroidManifest.xml" | head -200

# Fallback if apktool is missing:
unzip -p "$SAMPLE" AndroidManifest.xml > "$ARTIFACT_DIR/$SAMPLE_ID/manifest.bin"
# Then use aapt2 dump if available:
which aapt2 && aapt2 dump xmltree "$SAMPLE" --file AndroidManifest.xml | head -100
```

Extract:

- **package name** and **version**
- **min/target SDK**
- **permissions** — flag dangerous ones: `READ_SMS`, `RECEIVE_SMS`, `READ_CONTACTS`,
  `ACCESS_FINE_LOCATION`, `RECORD_AUDIO`, `CAMERA`, `SYSTEM_ALERT_WINDOW`,
  `BIND_ACCESSIBILITY_SERVICE`, `BIND_DEVICE_ADMIN`, `REQUEST_INSTALL_PACKAGES`.
- **exported components** — activities, services, receivers, providers with
  `android:exported="true"` or implicit-export via intent filter on pre-API-31.
  These are reachable from other apps and worth special attention.
- **`debuggable`** flag — if true on a release APK, that's a finding by itself.
- **network security config** — does it allow cleartext, custom CAs?

### Step 2 — Java / Kotlin code via JADX CLI

```bash
# Decompile to Java sources (preferred) and smali (always available)
mkdir -p "$ARTIFACT_DIR/$SAMPLE_ID/jadx-out"
jadx -d "$ARTIFACT_DIR/$SAMPLE_ID/jadx-out" "$SAMPLE"

# Layout under jadx-out/:
#   sources/    — decompiled .java
#   resources/  — strings.xml, layouts, raw assets
```

Map the goal to a class search using grep over the decompiled tree:

| Goal | Search |
|---|---|
| Find auth / login | `grep -rE '(?i)(login\|signin\|auth)' sources/ \| head -40` |
| Find network endpoints | `grep -rE 'https?://[a-zA-Z]' sources/ \| head -50` |
| Find Retrofit / OkHttp wiring | `grep -rE '(@(GET\|POST\|PUT\|DELETE\|PATCH)|baseUrl\\(\|OkHttpClient\\.Builder)' sources/` |
| Find hardcoded secrets | `grep -rE '(BEGIN PRIVATE\|AKIA[A-Z0-9]{16}\|sk_[a-z]+_[A-Za-z0-9]{24,})' sources/` |
| Find crypto | `grep -rE '(Cipher\\.getInstance\|MessageDigest\\.getInstance\|SecretKeySpec)' sources/` |
| Find native bridge | `grep -rE '(System\\.loadLibrary\|external fun \|@JvmStatic external)' sources/` |
| Find broadcast / intent receivers reachable from outside | grep `apktool-out/AndroidManifest.xml` for `android:exported="true"` and `<intent-filter>` |

For each interesting hit:

```bash
# Read full class file
cat "$ARTIFACT_DIR/$SAMPLE_ID/jadx-out/sources/com/example/X.java"

# Cross-references via grep (no real xref index, but grep is fast)
grep -rE '\b(MethodName|FieldName|ClassName)\b' "$ARTIFACT_DIR/$SAMPLE_ID/jadx-out/sources/"
```

For obfuscated APKs (one-letter class names like `a/a/a.java`), focus on
the larger files — obfuscators typically can't shrink string constants
or compress non-trivial control flow, so the longest classes are usually
the meaningful ones.

### Step 3 — Native libraries

If `lib/` is present in the apktool output:

```bash
ls "$ARTIFACT_DIR/$SAMPLE_ID/apktool-out/lib/"
# Typical: arm64-v8a/  armeabi-v7a/  x86/  x86_64/

# For each .so, route to pe-elf-macho:
for so in "$ARTIFACT_DIR/$SAMPLE_ID/apktool-out/lib/arm64-v8a"/*.so; do
  echo "== $so =="
  file "$so"
  # → hand off to the pe-elf-macho skill, which uses Ghidra MCP
done
```

Specifically check JNI registration. Search the largest `.so`:

```bash
# Static JNI: function symbols start with Java_<package>_
nm -D libfoo.so 2>/dev/null | grep -E '^[0-9a-f]+ T Java_'

# Dynamic JNI: look for RegisterNatives strings
strings libfoo.so | grep -E 'RegisterNatives|JNI_OnLoad'
```

This maps Java native methods to native function names (which differ
when registered dynamically).

### Step 4 — Resources and assets

```bash
# Already decoded in Step 1 by apktool (apktool-out/res/ and apktool-out/assets/)
# Look at:
ls "$ARTIFACT_DIR/$SAMPLE_ID/apktool-out/assets/" 2>/dev/null
cat "$ARTIFACT_DIR/$SAMPLE_ID/apktool-out/res/values/strings.xml" 2>/dev/null | head -60
```

Watch for:

- `assets/` — frequently contains additional payloads, JS bundles
  (Cordova/React Native — `assets/index.android.bundle`), embedded
  models, encrypted blobs.
- `res/raw/` — same.
- `strings.xml` — sometimes contains API URLs not present in code.

### Step 5 — Quick obfuscation check

```bash
# Count short class names (1-3 char, like `a/a/a.java`)
find "$ARTIFACT_DIR/$SAMPLE_ID/jadx-out/sources" -name '*.java' \
  -printf '%f\n' | awk '{ if (length($0) <= 8) c++; t++ } END { printf "%d/%d short names (%d%%)\n", c, t, c*100/t }'
```

If most class names are 1–3 characters and look like `a.a.a.b`, the app
has ProGuard/R8 obfuscation. Note this in the report; analysis will focus
on resources, manifest, and native code rather than reading every Java
class.

## Outputs

Write to `$ARTIFACT_DIR/$SAMPLE_ID/static-android.md`:

```markdown
# Static APK analysis — <sample-id>

## Manifest summary
- Package: com.example.x
- Version: 1.2.3 (3014)
- min/target SDK: 21 / 33
- debuggable: false
- Network: cleartext disallowed

## Permissions of interest
| Permission | Risk | Justified by code? |

## Exported components
| Type | Class | Note |

## Hardcoded findings
| Where | Type | Value | Confidence |

## Native libraries
| ABI | File | Routed to |

## Open questions
- ...
```

## Hard rules

- **Don't install the APK on a real device** to extract files. Use static
  unzip / apktool / jadx; if you need a runtime view, that's
  `frida-dynamic` on a controlled emulator.
- **Don't expand resource decoding into a full decompilation.** APKs can
  have thousands of resource files. Decode the manifest and grep
  `assets/`/`res/raw/`; don't dump everything to disk.
- **If APKiD or stub-DEX heuristic flagged hardening, do NOT continue
  this skill.** Route to `apk-hardening`. Static analysis of a packed
  APK produces wrong answers, not partial answers.
