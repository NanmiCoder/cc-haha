---
name: re-report
description: Produces the final structured report.md for an RE engagement. Aggregates triage / static / dynamic / keygen artefacts and surfaces IOCs, findings, and follow-up questions.
whenToUse: As the final step in any RE workflow, after triage and at least one specialist skill have written their intermediate artefacts to ARTIFACT_DIR/<sample-id>/.
allowedTools: Read, Glob, Grep
---

# re-report skill

Goal: produce a single `report.md` that an analyst who hasn't seen the sample
can read in 15 minutes and reproduce the findings.

## Inputs

Read whichever of these exist under `ARTIFACT_DIR/<sample-id>/`:

- `triage.md` — always present.
- `static-native.md` — from pe-elf-macho.
- `static-android.md` — from apk-analysis.
- `static-ios.md` — from ios-analysis.
- `dynamic.md` — from frida-dynamic, only if dynamic was run.
- `crackme.md` + `keygen.py` — from crackme-keygen, only for CTF tasks.

## Output structure

Write `ARTIFACT_DIR/<sample-id>/report.md`:

```markdown
# RE report — <sample-id>

## Verdict
<one or two sentences. The thing the user gets to know first.>

## Sample
- Path: <path>
- SHA-256: <full hash>
- Type: <PE32+ / ELF64 / Mach-O arm64 / APK / IPA>
- Size: <bytes>
- Packing/obfuscation: <UPX / R8 / none / suspect>

## Findings
Each finding is a row in a table, or a short subsection if the finding
needs more than 2 lines.

| # | Finding | Where | Confidence |
|---|---------|-------|------------|
| 1 | Connects to evil.example.com over HTTPS at startup | sub_401a30 @ 0x401a30; xref to string @ 0x402100 | high (static decompile + dynamic confirmed) |
| 2 | AES-256-CBC with hardcoded key and IV | sub_4022c0; key at 0x403040 | high |

For findings that need elaboration:

### Finding 1 — C2 endpoint
<short prose, 3–6 lines>
```c
// minimal cleaned decompilation showing the call
```

## Indicators of compromise (IOCs)
| Type | Value | Source |
|------|-------|--------|
| sha256 | <hash> | sample itself |
| domain | evil.example.com | static + dynamic |
| ip | 1.2.3.4 | dynamic capture |
| mutex | Global\\Foo | static (xref 0x404000) |
| registry | HKCU\\Software\\Foo | static |

(Omit table rows that don't apply.)

## What we did NOT cover
- <branches not traced, anti-analysis paths skipped, dynamic events not observed>

## Suggested next steps
- <one or two concrete next investigations>

## Provenance
- Triaged at: <timestamp>
- Static analysis tools: <Ghidra 11.x / radare2 5.9.x / JADX 1.5.0>
- Dynamic analysis: <yes / no, with environment details if yes>
- Plugin: cc-haha reverse-engineering v0.1.0
```

## Rules

- **Every finding cites a location.** Function name + offset, file path, or hook
  name. No "the malware does X" without a pointer.
- **No verbatim sample bytes.** Hex dumps allowed only when needed for clarity
  (e.g., showing a 16-byte AES key); keep them short.
- **Confidence is honest.** Static-only claims about runtime behaviour cap at
  medium. Dynamic-confirmed claims are high.
- **What's NOT covered is mandatory.** A report that doesn't say what was
  skipped is worse than one that does — it implies false completeness.
- **Reproducibility info goes at the end.** Tool versions and environment
  details so another analyst can verify.
