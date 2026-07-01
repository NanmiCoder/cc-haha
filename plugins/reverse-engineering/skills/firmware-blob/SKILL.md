---
name: firmware-blob
description: Static analysis for raw binary blobs and firmware images that have no PE/ELF/Mach-O header. Identifies architecture and endianness, extracts compressed/packed components (binwalk/unblob), recovers the base address, and loads the result into Ghidra or radare2 with the right processor module. Covers MIPS, ARM (incl. Thumb/Cortex-M), PowerPC (incl. VLE), 68k, SuperH, RISC-V, and other embedded ISAs.
whenToUse: When triage finds a binary that is NOT a recognised PE/ELF/Mach-O/APK/IPA — a router/IoT firmware dump, a U-Boot image, a Cortex-M flash dump, an old game cartridge ROM, or any blob without a standard executable header.
allowedTools: Bash, Read, Grep, Glob
---

# firmware-blob skill

Goal: take an opaque binary blob, figure out **what CPU it's for, in which
endianness, with what base address**, and load it into Ghidra or radare2 in a
state where the disassembly is actually correct.

This is the skill that handles MIPS / ARM / PowerPC / 68k and the rest of the
embedded ISA zoo. The decompilers themselves (Ghidra, r2) cover dozens of
architectures already — the work here is identifying which one and getting the
load configuration right.

## Pre-flight: what does the file look like?

Before opening anything, run a 60-second sanity pass:

```bash
file "$SAMPLE"                 # may say "data" — that's normal for blobs
sha256sum "$SAMPLE"
xxd "$SAMPLE" | head -8        # look at the first 128 bytes
ls -la "$SAMPLE"               # size matters: Cortex-M typical 64KB-2MB,
                               # router firmware 4-32MB, console ROMs 256KB-64MB
```

Container check — many "blobs" are actually a known container around payload:

```bash
which binwalk && binwalk "$SAMPLE"
which unblob && unblob "$SAMPLE" -o "${SAMPLE}.extracted"
# Optional: dd if=$SAMPLE bs=1 count=512 | xxd  # bootloader headers live here
```

If binwalk reports a JFFS2 / SquashFS / cramfs / ext2 filesystem, an
LZMA/gzip stream, an `MIPSEB-Linux` or `ARMEL-Linux` payload, or a U-Boot
uImage — extract first, then recurse this skill on each piece. Don't try to
analyse the outer container as code.

## Step 1 — Identify the architecture

You have three independent signals. Use whichever is fastest for your case.

### 1a. Container header (fastest when it works)

| Header bytes | Meaning |
|---|---|
| `27 05 19 56` | U-Boot uImage. Bytes at +28..+31 = `arch` field (1=alpha, 2=arm, 3=ix86, 4=ia64, 5=mips, 6=mips64, 7=ppc, 8=s390, 9=sh, 10=sparc, 11=sparc64, 12=m68k, 13=nios2, 14=microblaze, 15=nios, 16=blackfin, 17=avr32, 18=st200, 19=sandbox, 20=nds32, 21=or1k, 22=arm64, 23=arc, 24=x86_64, 25=xtensa, 26=riscv) |
| `D0 0D FE ED` | Device tree blob (`fdt`). Often precedes the kernel; look just past it. |
| `1F 8B`, `5D 00 00`, `28 B5 2F FD`, `42 5A 68` | gzip / LZMA / Zstandard / bzip2 — extract before analysing. |
| `7F 45 4C 46` ... | ELF after all. Use `pe-elf-macho` skill. |
| `4D 5A 90 00` ... | PE after all. Use `pe-elf-macho` skill. |
| `4D 4F 54 4F`, `53 30` (S-record), `:` (Intel HEX) | Wrapper format, decode with `objcopy -I srec -O binary` or `objcopy -I ihex -O binary` first. |

### 1b. Cortex-M heuristic — extremely common, instantly recognisable

A Cortex-M flash image starts with a vector table:

- **Word 0** (offset 0): initial stack pointer. Should look like a sane RAM
  address — `0x20000000`-ish for STM32 / NXP, `0x10000000` for nRF.
- **Word 1** (offset 4): reset handler address. Should be in flash range
  (`0x08000000`-ish for STM32, `0x00000000`-ish for nRF/Cortex-M0). **Always
  has bit 0 set** because Cortex-M only executes Thumb code (`0x08000125`,
  not `0x08000124`).
- Words 2..15: NMI / HardFault / etc. handlers — same flash range, all with
  bit 0 set.

```bash
xxd -e -l 64 "$SAMPLE" | head -4
# If words alternate between something like 20000400, 08000125, 08000451 ...
# you have a Cortex-M image. Base = high nibble of word 1 (mask off the Thumb
# bit — 0x08000124).
```

### 1c. Heuristic / statistical recognisers (when 1a and 1b fail)

```bash
which cpu_rec.py && cpu_rec.py "$SAMPLE"
# https://github.com/airbus-seclab/cpu_rec — installs as a python script
which isadetect && isadetect detect "$SAMPLE"
# https://github.com/kannwism/isadetect
```

These score the file against trained byte-bigram models for ~70 ISAs. Output
gives you `mipsel`, `mipseb`, `armel`, `armeb`, `ppcbe`, `m68k`, `sh4`,
`riscv`, etc. Don't trust silently: if the top score is < 2× the second score,
the result is weak.

### 1d. Manual byte inspection (last resort)

Read the first 256 bytes and look for ISA tells:

| Tell | ISA |
|---|---|
| `00 00 00 0X 00 00 00 0Y` repeating with words ending in `00 26` etc. | MIPS-BE common opcode patterns |
| Lots of `XX XX XX EA` / `XX XX XX EB` (b/bl) | ARM, little endian |
| Lots of `XX XX 80 4E` / `XX XX 80 4B` (bl/b) | PowerPC big endian |
| `4E 75` (rts), `4E 56` (link), `4E 5E` (unlk) common | M68k |
| `61 XX` (bsr 8-bit), `7E XX XX` (bra) | M68k or H8 — distinguish by stack frame shape |
| `48 b8 ... ...` (mov rax, imm64) | x86_64 — wrong skill, use pe-elf-macho |

## Step 2 — Identify endianness (when not given)

Big endian binaries put the MSB first. For a 32-bit pointer-rich blob:

```bash
# Count occurrences of likely-pointer high bytes at word boundaries.
# If you see lots of 0x80 / 0x00 / 0xBF at offset 0 (mod 4), it's BE.
# If you see lots of 0x80 / 0x00 / 0xBF at offset 3 (mod 4), it's LE.
python3 -c "
import sys, collections
b = open(sys.argv[1],'rb').read()
mod = collections.Counter(b[i] for i in range(0, len(b), 4))
print('byte at offset%4=0:', mod.most_common(5))
mod3 = collections.Counter(b[i+3] for i in range(0, len(b)-3, 4))
print('byte at offset%4=3:', mod3.most_common(5))
" "$SAMPLE"
```

Or test load both endiannesses in r2 and see which gives sane disassembly:

```text
radare2: open path=$SAMPLE
radare2: cmd "e asm.arch=mips ; e asm.bits=32 ; e cfg.bigendian=true ; pd 64"
radare2: cmd "e cfg.bigendian=false ; pd 64"
```

The "right" endianness has obvious instructions (`addiu`, `lw`, `jal`); the
wrong one is gibberish.

## Step 3 — Recover the base address

For an unmapped raw blob, the base address is whatever the chip's reset vector
or boot ROM jumps to. Common defaults:

| Target | Typical base |
|---|---|
| MIPS BE router (older Broadcom/Realtek) | `0x80000000` (kseg0) or `0xBFC00000` (kseg1 reset) |
| MIPS LE router (Atheros/Qualcomm) | `0x80000000` |
| Linux ELF on MIPS userspace | `0x00400000` |
| ARM Cortex-M (STM32) | `0x08000000` |
| ARM Cortex-M (nRF52) | `0x00000000` |
| ARM Cortex-A (older bootloader) | `0x80000000` |
| ARM Linux userspace | `0x00010000` or `0x00400000` |
| PowerPC e200/e500 (NXP MPC57xx) | `0x00000000` (boot from 0) |
| PowerPC AppliedMicro / older | `0xFFF00100` (boot from end of address space) |
| 68k Mac classic | `0x00000000` (system) or `0x00040000` (app heap) |
| SH-2 (Sega Saturn) | `0x06000000` |
| SH-4 (Dreamcast) | `0x8C010000` |
| 6502 (NES PRG-ROM) | `0x8000` |

Better than guessing: look at absolute pointers / branch targets. If the binary
has a string table at `0x12340000` and you load with base `0x80000000`, every
xref to that string will resolve to nonsense. Cross-check by:

1. Finding likely ASCII strings with `strings -n 8 -t x "$SAMPLE"`.
2. Picking one that's clearly used as a format string ("error: %s\n").
3. Searching for its absolute address at word boundaries in the binary.
4. The high bits of the matches reveal the base.

## Step 4 — Load with the right config

### Ghidra MCP

```text
ghidra: import_program path=$SAMPLE language=<language-id> base_address=<hex>
ghidra: analyze
```

Common language IDs (use the ID, not the human name):

| ISA | Ghidra language ID |
|---|---|
| MIPS32 BE | `MIPS:BE:32:default` |
| MIPS32 LE | `MIPS:LE:32:default` |
| MIPS64 BE | `MIPS:BE:64:default` |
| ARMv7 LE | `ARM:LE:32:v7` |
| ARMv7 BE | `ARM:BE:32:v7` |
| Cortex-M (Thumb-only) | `ARM:LE:32:Cortex` |
| AArch64 | `AARCH64:LE:64:v8A` |
| PowerPC 32 BE | `PowerPC:BE:32:default` |
| PowerPC e200 VLE | `PowerPC:BE:32:e200` |
| PowerPC 64 BE | `PowerPC:BE:64:default` |
| 68000 | `68000:BE:32:default` |
| 68020 | `68000:BE:32:MC68020` |
| ColdFire | `68000:BE:32:Coldfire` |
| SuperH SH-2 | `SuperH:BE:32:SH-2` |
| SuperH SH-4 | `SuperH:LE:32:SH-4` |
| RISC-V 32 | `RISCV:LE:32:default` |
| RISC-V 64 | `RISCV:LE:64:default` |
| AVR8 (Arduino) | `avr8:LE:24:default` |
| MSP430 | `TI_MSP430:LE:16:default` |
| 6502 | `6502:LE:16:default` |
| Z80 | `z80:LE:16:default` |

### radare2 MCP

```text
radare2: open path=$SAMPLE flags="-n"        # -n disables bin parsing
radare2: cmd "e asm.arch=<arch>"
radare2: cmd "e asm.bits=<bits>"
radare2: cmd "e cfg.bigendian=<true|false>"
radare2: cmd "e asm.cpu=<cpu>"               # e.g. cortex, e200, sh4
radare2: cmd "om $$ 0x<base> $size 0 rwx mapname"   # set base via map
radare2: cmd "s 0x<entry>"
radare2: cmd "aaa"
```

`asm.arch` values: `mips`, `arm`, `arm64` (or `arm.bits=64`), `ppc`, `m68k`,
`sh`, `riscv`, `avr`, `msp430`, `6502`, `z80`, `tricore`, `hexagon`,
`xtensa`. Run `e asm.arch=??` in r2 to dump the full list.

For Cortex-M specifically, set `e anal.armthumb=true` and `e asm.cpu=cortex`.
For MIPS with delay slots set `e asm.delay=true` (default). For PowerPC VLE
set `e asm.cpu=vle`.

## Step 5 — Hand off to pe-elf-macho

Once the binary is loaded with the correct ISA and base, the analysis playbook
is the same as for a regular ELF — function recovery, string extraction,
xrefs, decompilation. Hand off to the **`pe-elf-macho`** skill, which now has
an "Architecture-specific notes" section for MIPS / ARM / PowerPC / 68k.

## Outputs

Append to `ARTIFACT_DIR/<sample-id>/firmware-load.md`:

```markdown
# Firmware load — <sample-id>

## Container
- File type: raw blob (no PE/ELF/Mach-O header)
- Container detected by binwalk: <none | uImage | SquashFS | ...>
- Extracted artefacts: <list of files written to ${SAMPLE}.extracted/>

## ISA identification
- Architecture: <MIPS32 | ARM Cortex-M | PowerPC e200 VLE | ...>
- Endianness: <BE | LE>
- Source of identification: <U-Boot header arch=5 | Cortex-M vector table | cpu_rec | manual>
- Confidence: <high | medium | low>

## Load configuration
- Base address: 0x... (rationale: <reset vector | string-pointer-match | guess>)
- Entry point: 0x...
- Ghidra language ID: ...
- r2 args: -a ... -b ... -e ... -m ...

## Open questions
- ...
```

## Hard rules

- **Don't run the firmware.** Even via qemu — that's a separate skill / a
  decision the user has to make. This is static.
- **Don't trust automatic analysis past the load configuration.** Wrong base
  or wrong endianness produces plausible-looking but completely fake
  disassembly. Always cross-check by picking 2-3 absolute pointers / strings
  and confirming they resolve.
- **Cap confidence at medium when the ISA was identified by cpu_rec/isadetect
  alone.** Statistical recognisers misclassify on packed/encrypted blobs and
  on small files (< 16 KB).
- **State residual unknowns explicitly.** If you couldn't recover the base
  address, say so; don't load at 0 and pretend xrefs are meaningful.
