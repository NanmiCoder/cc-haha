---
name: triage
description: First-pass identification of an unknown sample. Detects file type, packer/obfuscator, and routes to the right specialist skill. Always the first step in any RE workflow.
whenToUse: When given an unknown binary, APK, IPA, or Mach-O and the analyst doesn't yet know what tool to point at it.
allowedTools: Bash, Read, Glob, Grep
---

# Triage skill

Goal: in under 30 seconds of work, answer four questions:

1. **What is it?** PE / ELF / Mach-O / APK / IPA / archive / shell script / something
   unusual.
2. **Is it packed or obfuscated?** UPX, ASPack, custom XOR, ProGuard / R8, native
   string encryption, control-flow flattening, VM protection.
3. **Is it big and worth careful analysis, or trivially small?** Size and entropy
   bound how much effort is reasonable.
4. **Which specialist skill comes next?** pe-elf-macho / apk-analysis /
   ios-analysis.

## Inputs

- `$SAMPLE`: absolute path to the file.
- `$SAMPLE_ID`: short identifier you choose; defaults to first 12 chars of SHA-256.

## Procedure

### Step 1 — Identify

Use whichever of these is available (in this order — `file` is universal,
the rest are nicer):

```bash
sha256sum "$SAMPLE"
file "$SAMPLE"
# Optional, more detail if installed:
which trid && trid -ce:nul "$SAMPLE"
which exiftool && exiftool "$SAMPLE"
```

On Windows where `file` is missing, read the first 16 bytes:

- `4D 5A` → PE (Windows). Continue with `pe-elf-macho`.
- `7F 45 4C 46` → ELF (Linux/BSD). Continue with `pe-elf-macho`.
- `CF FA ED FE` / `CE FA ED FE` / `CA FE BA BE` → Mach-O / fat binary. Continue
  with `pe-elf-macho` or `ios-analysis` depending on container.
- `50 4B 03 04` + entries with `AndroidManifest.xml` → APK. Continue with
  `apk-analysis`.
- `50 4B 03 04` + `Payload/*.app/` → IPA. Unzip; the `.app/<binary>` is
  Mach-O — continue with `ios-analysis`.
- `27 05 19 56` → U-Boot uImage. Continue with `firmware-blob` (it parses
  the arch field at +28).
- `D0 0D FE ED` → Device tree blob, usually next to a kernel image. Continue
  with `firmware-blob`.
- None of the above + non-zero entropy + plausible code-shaped bytes → raw
  binary blob (router/IoT firmware, Cortex-M flash, console ROM, ECU dump).
  Continue with `firmware-blob`.

### Step 2 — Detect packing / obfuscation

```bash
# Section entropy (if a Ghidra/r2 MCP is connected, prefer that for accuracy)
which python && python -c "
import sys, math, collections
b = open(sys.argv[1],'rb').read()
c = collections.Counter(b)
e = -sum((v/len(b)) * math.log2(v/len(b)) for v in c.values())
print(f'overall entropy: {e:.3f}')
" "$SAMPLE"

# Quick UPX check (works on PE/ELF/Mach-O):
which upx && upx -t "$SAMPLE" || true

# String count — packed binaries have very few human strings:
strings "$SAMPLE" | wc -l
```

When the sample is an APK (zip with `AndroidManifest.xml`), also run
[APKiD](https://github.com/rednaga/APKiD) — the canonical Android packer
fingerprinter. It pattern-matches against ~30 commercial/open packers
(360 加固, Tencent Legu, Bangcle, Naga, Ijiami, ApkProtect, etc.) plus
common obfuscators and anti-analysis indicators.

```bash
# Install once: pipx install apkid   OR   uv tool install apkid
which apkid && apkid -j "$SAMPLE" > "$ARTIFACT_DIR/$SAMPLE_ID/apkid.json"
which apkid && cat "$ARTIFACT_DIR/$SAMPLE_ID/apkid.json" | python -m json.tool | head -40
```

If APKiD reports a packer / protector match, **route the sample to the
`apk-hardening` skill, not `apk-analysis`** — the latter assumes a
non-hardened APK and will hand back gibberish on a packed one.

Heuristics:

- Overall entropy ≥ 7.5 + low string count → packed or encrypted.
- UPX `-t` says "tested" → UPX-packed; offer to `upx -d` if user says yes.
- APK with `classes.dex` of size < 5 KB and a giant `.so` → likely native-loaded;
  most logic is in the `.so`, treat as binary.
- AndroidManifest with `android:extractNativeLibs="false"` and abundant
  `Lcom/.../a/a;` short class names → ProGuard/R8 obfuscated.

### Step 3 — Pick the next skill

Based on what step 1 said:

| Detected | Next skill |
|---|---|
| PE / ELF / Mach-O (standalone) | `pe-elf-macho` |
| **APK with packer detected by APKiD or manual signature** | **`apk-hardening`** — covers 360 加固 / Tencent Legu / Bangcle / Naga / Ijiami / Flutter / etc. |
| APK (no packer detected) | `apk-analysis` (and recurse into `pe-elf-macho` for embedded `.so`) |
| IPA / iOS Mach-O | `ios-analysis` |
| **Raw binary blob, no recognised header (router firmware, Cortex-M flash, U-Boot uImage, console ROM, ECU dump, etc.)** | **`firmware-blob`** — covers MIPS / ARM / Cortex-M / PowerPC / 68k / SuperH / RISC-V / AVR / 6502 / Z80 |
| Crackme (small PE/ELF asking for serial) | `crackme-keygen` |
| Live process / instrumented session / any runtime question | `dynamic-debug-overview` (it then picks frida-dynamic / gdb-debug / lldb-debug) |

### Step 4 — Write triage record

Append a triage record to `$ARTIFACT_DIR/$SAMPLE_ID/triage.md`:

```markdown
# Triage — $SAMPLE_ID

- Path: $SAMPLE
- SHA-256: <hash>
- File type: <output of `file`>
- Size: <bytes>
- Overall entropy: <number>
- Packing/obfuscation: <UPX | ProGuard | none | suspect, see notes>
- Routed to: <skill name>
- Triaged at: <ISO timestamp>
- Notes: <one or two lines of judgement>
```

## Hard rules

- **Never run the sample.** Triage is read-only. No double-clicking, no
  `chmod +x; ./sample`. The only time you execute anything is via Frida on a
  sandboxed target — and that's stage 3, not triage.
- **Don't upload to public services.** No VirusTotal, no MalwareBazaar uploads
  unless the user explicitly says the sample is already public.
- **Don't truncate the SHA-256 in the report**, even though `$SAMPLE_ID` does.
  Full hash is the report's primary identity field.
