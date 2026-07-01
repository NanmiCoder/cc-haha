---
name: ios-analysis
description: Static analysis of iOS apps (.ipa) and Mach-O frameworks. Extracts the bundle structure, Info.plist, entitlements, ObjC class layout, and routes the actual binary to native analysis.
whenToUse: "After triage detects an IPA archive or a standalone Mach-O. Note on signature/encryption: App Store binaries arrive FairPlay-encrypted, cleartext analysis requires a decrypted dump."
allowedTools: Bash, Read, Grep, Glob
---

# ios-analysis skill

Goal: get from an `.ipa` (or a raw Mach-O) to a usable picture of the app's
class hierarchy, entitlements, exposed schemes, and native code.

## Up-front constraint

App Store IPAs are **FairPlay-encrypted** — the `__TEXT` segment of the main
binary is unreadable until decrypted on a jailbroken device with a tool like
`frida-ios-dump` or `bagbak`. If the user gives you an App Store IPA you cannot
fully analyse it statically. State this clearly. Free or in-house IPAs are
usually unencrypted.

How to tell: in the Mach-O load commands look for `LC_ENCRYPTION_INFO_64` with
`cryptid=1`. cryptid 0 = decrypted.

## Procedure

### Step 1 — Unpack the IPA

```bash
unzip -d "$SAMPLE_ID-unpacked" "$SAMPLE"
# IPAs always have: Payload/<AppName>.app/
APP_DIR=$(find "$SAMPLE_ID-unpacked/Payload" -maxdepth 1 -type d -name "*.app" | head -1)
APP_NAME=$(basename "$APP_DIR" .app)
APP_BIN="$APP_DIR/$APP_NAME"
```

### Step 2 — Bundle metadata

Read these files from `$APP_DIR`:

- **`Info.plist`** — bundle id, version, supported platforms, URL schemes
  (`CFBundleURLTypes`), background modes, NS*UsageDescription strings.
  Convert binary plist with `plutil -convert xml1 -o - Info.plist`.
- **`embedded.mobileprovision`** — provisioning profile. Extract entitlements:
  ```bash
  security cms -D -i "$APP_DIR/embedded.mobileprovision" > /tmp/profile.plist
  plutil -extract Entitlements xml1 -o - /tmp/profile.plist
  ```
  Flag: `get-task-allow=true` (debuggable), keychain-access-groups,
  `com.apple.developer.networking.networkextension`.
- **`PkgInfo`** and presence of `Watch/`, `PlugIns/`, `Frameworks/` —
  multi-target apps need separate analysis per target.

### Step 3 — Mach-O analysis

Open the main binary with **radare2 MCP** (`radare2` server):

```text
radare2: open path=$APP_BIN
radare2: cmd "aaa"
radare2: cmd "iIq"          # mach-o info: arch, encryption, PIE, NX
radare2: cmd "iLq"           # linked libraries
radare2: cmd "iEq"           # exports
```

Specifically check:

- **encryption**: `cryptid` in `iI` output. If 1, halt static and state the
  blocker.
- **architecture**: arm64 only, or fat binary with armv7? Usually arm64 for
  modern apps.
- **PIE / NX / stack canary**: missing PIE on a recent app is a finding.

### Step 4 — ObjC / Swift class recovery

ObjC class metadata lives in `__objc_classlist` etc. and is recoverable even
with stripped symbols.

```text
radare2: cmd "ic"           # list classes
radare2: cmd "icj"          # JSON form
radare2: cmd "ii"           # imports (will include common ObjC runtime)
```

For Swift, symbol recovery is best-effort — Swift mangles aggressively. If r2's
demangler doesn't help, `nm $APP_BIN | swift demangle` (when toolchain is
available) usually does.

External tools that complement when installed (mention to the user, don't run
silently): `class-dump-dyld`, `ipsw`, `Hopper Decompiler` (paid), `Ghidra` with
the iOS loader.

### Step 5 — URL schemes, deep links, network

Search the binary for:

- `http://`, `https://`, `wss://`
- Custom URL scheme strings (`myapp://`)
- API path templates
- AppTransportSecurity exceptions in Info.plist

### Step 6 — Optional: hand off to pe-elf-macho

If the user wants a deeper decompilation of specific functions, the
`pe-elf-macho` skill works on Mach-O. Hand `$APP_BIN` to it.

## Outputs

Write to `ARTIFACT_DIR/<sample-id>/static-ios.md`:

```markdown
# Static iOS analysis — <sample-id>

## Bundle
- Bundle ID: com.example.app
- Version: ...
- URL schemes: myapp://
- Encrypted (FairPlay): yes / no
- Architecture: arm64
- PIE / NX / Canary: yes / yes / yes

## Entitlements of interest
| Key | Value | Note |

## ObjC classes of interest
| Class | Methods | Note |

## Strings of interest
| Type | Value | Where |

## Open questions / blockers
- ...
```

## Hard rules

- **Don't install the IPA on your iPhone.** Static analysis is on the bundle;
  dynamic is `frida-dynamic` on a controlled jailbroken device.
- **If `cryptid=1`, do not pretend to decompile** the encrypted segment. State
  the blocker and stop the static stage.
