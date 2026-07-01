---
name: crackme-keygen
description: For CTF / crackme challenges where the deliverable is a serial, key, or input that the binary accepts. Recovers the validation logic, then either reverses it (keygen) or supplies a witness input.
whenToUse: When triage shows a small standalone binary (PE/ELF/Mach-O) that prompts for a license/serial/key and the user's goal is to satisfy the check. Not for malware analysis.
allowedTools: Bash, Read, Grep
---

# crackme-keygen skill

Goal: produce either (a) a single accepted input, or (b) a small program /
script (a "keygen") that produces accepted inputs on demand.

This skill is built around the public framing in
[Binary Reverse Engineering for Agents (arxiv 2605.10597)](https://arxiv.org/html/2605.10597v1)
— and follows the spirit of CTF / crackme-style challenges, not real-world
license cracking. **Do not use this on commercial software you don't own.**

## Procedure

### Step 1 — Verify the brief

Before doing anything, get clarity on:

- Is this a CTF challenge, your own crackme, or your own software?
- What does the program accept as input — stdin? command-line argument? file?
- What's the success indicator — exit code 0? a "Correct!" string? a flag?

If the answer involves third-party commercial software, **stop**. This skill is
for CTF and self-owned binaries only.

### Step 2 — Reach the validation function

Use the `pe-elf-macho` skill to locate the function that decides accept vs
reject. Concretely: find xrefs to the failure string ("Invalid", "Wrong",
"Try again") and walk back to the comparison.

Typical shapes:

- **String compare** — `strcmp(input, "h4xx0r")` → the answer is the literal.
- **Hash compare** — `compare(sha256(input), "abcd…")` → either crack the hash
  (rainbow / weak preimage) or replace the binary's expected hash with one of
  yours.
- **Stateful transform** — input → series of arithmetic / XOR / table lookups
  → compared against constant. Reverse the transform.
- **Per-character math** — for each i, `input[i] = f(i, secret_constants)`. Often
  invertible directly.
- **CRC / custom checksum** — find the algorithm (xrefs to the constant
  polynomial / table), then either invert or brute-force.

### Step 3 — Decompile and rewrite as Python (or C)

Take the validation function's decompiled output and re-express the math in
Python. Then either:

- **Forward-solve**: feed candidate inputs through your Python implementation
  until it accepts (only sane when input space is small).
- **Backward-solve**: implement the inverse so each accepted output yields an
  input. This is the keygen.
- **Symbolic-solve**: when the function is loopy XOR/arithmetic that you don't
  want to invert by hand, use `z3` or `claripy` (angr) to ask "find input s.t.
  validate(input) returns 0". Suggest this to the user when control flow has
  many branches.

### Step 4 — Confirm against the real binary

A keygen that works in your Python script but fails on the real binary is
worthless. Always verify:

```bash
echo -n "<generated-input>" | $SAMPLE
# or:
$SAMPLE "<generated-input>"
echo "Exit code: $?"
```

If it doesn't accept, you missed an instruction. Common misses:

- Endianness in the comparison.
- Off-by-one (input length vs null terminator).
- A second check after the first (some crackmes split validation across two
  functions).
- A side-channel — anti-tamper hash over the binary itself, which fires only
  when you've tampered with it (irrelevant for keygens, but watch for it).

### Step 5 — Write the keygen artefact

Place the keygen at
`ARTIFACT_DIR/<sample-id>/keygen.py` (or `.c`) and a short writeup at
`ARTIFACT_DIR/<sample-id>/crackme.md`:

```markdown
# Crackme — <sample-id>

## Validation function
- Address: 0x401a30 (sub_401a30)
- Input: ASCII string from argv[1], length must be 16
- Algorithm: per-character XOR with rotating key derived from a constant table
  at 0x402000

## Decompiled (cleaned)
```c
<short snippet>
```

## Keygen logic
For i in 0..15: input[i] = TABLE[i] ^ ((i * 0x9E3779B9) & 0xFF)

## Witness
A valid input: `5b2f04a7e91c6f3d`
Verified accepted by binary: yes (exit code 0, prints "Correct!")
```

## Hard rules

- **No commercial license cracking.** This skill is for CTFs, crackmes, and
  your own software. If asked to crack non-trivial commercial DRM, refuse.
- **The keygen is the deliverable, not the patched binary.** Don't byte-patch
  the comparison — that defeats the point.
- **Always confirm against the real binary.** A keygen that works in Python
  but not on disk is a regression you have to find before claiming success.
