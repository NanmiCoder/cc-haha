import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * The 「素 Porcelain」 system, enforced.
 *
 * The UI felt subtly off because nothing constrained it: 36 font sizes
 * including 12.5 / 13.5 / 11.5px, 41 corner radii, two icon sets with 20 icon
 * sizes, monospace "bold" that the browser had to fake from a 400-only font,
 * and Chinese set in italics (CJK has no italic; the browser just slants it).
 * Each rule below names one of those causes. A violation lists file:line so the
 * fix is a lookup, not a hunt.
 */

const SRC_ROOT = join(process.cwd(), 'src')

/**
 * `preview-agent` is a script injected into third-party pages with its own
 * shadow-DOM stylesheet; it never sees this design system. `test/` holds
 * fixtures that generate document content (an italic run inside a .docx),
 * not interface.
 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'preview-agent', '__tests__', 'test'])

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) collect(path, out)
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(path)
  }
  return out
}

const files = collect(SRC_ROOT).map((path) => ({
  path: relative(SRC_ROOT, path),
  lines: readFileSync(path, 'utf8').split('\n'),
}))

/** Lines that are only a comment are prose about the rule, not a use of it. */
function isComment(line: string) {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

function violations(pattern: RegExp, accept?: (match: RegExpMatchArray, line: string) => boolean) {
  const out: string[] = []
  for (const file of files) {
    file.lines.forEach((line, index) => {
      if (isComment(line)) return
      for (const match of line.matchAll(pattern)) {
        if (accept && accept(match, line)) continue
        out.push(`${file.path}:${index + 1}  ${match[0]}`)
      }
    })
  }
  return out
}

/** 11 / 12 / 13 / 14 / 15 / 18 / 22 / 26 — the whole type scale. */
const TYPE_SCALE = new Set([11, 12, 13, 14, 15, 18, 22, 26])

describe('「素」 design system', () => {
  it('uses only the type scale for arbitrary font sizes', () => {
    expect(violations(/\btext-\[(\d+(?:\.\d+)?)px\]/g, (m) => TYPE_SCALE.has(Number(m[1])))).toEqual([])
  })

  it('uses only the type scale for inline font sizes', () => {
    expect(violations(/fontSize:\s*['"]?(\d+(?:\.\d+)?)(?:px)?['"]?/g, (m) => TYPE_SCALE.has(Number(m[1])))).toEqual([])
  })

  it('does not use Tailwind sizes that fall off the scale (base 16, xl 20, 2xl 24, …)', () => {
    expect(violations(/\btext-(?:base|xl|[2-9]xl)\b/g)).toEqual([])
  })

  it('tops out at semibold, the heaviest Inter weight shipped', () => {
    expect(violations(/\bfont-(?:bold|extrabold|black)\b/g)).toEqual([])
  })

  it('never asks the 400-only monospace face for a synthesized bold', () => {
    expect(violations(/[^"'`]*\bfont-mono\b[^"'`]*/g, (m) => !/\bfont-semibold\b/.test(m[0]))).toEqual([])
  })

  it('does not slant text: CJK has no italic, the browser only skews it', () => {
    expect(violations(/(?<![\w-])italic\b(?!\w)/g, (_m, line) => !/className|cx\(|['"`]/.test(line))).toEqual([])
  })

  it('draws every icon from lucide, not Material Symbols', () => {
    expect(violations(/material-symbols/g)).toEqual([])
  })

  it('names things by what they are, not with the generic "AI" sparkle glyph', () => {
    // The sparkle said "AI" on the thinking line, skills, memory and new-feature
    // prompts alike, so it said nothing about any of them. Skills use the box
    // the @ and / menus use for SKILL.md; a working turn uses the running ring.
    // BrandSeal draws its own sparkles as part of the logo, not this icon.
    const sparkleImports = files
      .filter((file) => /import\s*\{[^}]*\b(?:WandSparkles|Sparkles?)\b[^}]*\}\s*from\s*'lucide-react'/.test(file.lines.join('\n')))
      .map((file) => file.path)
    expect(sparkleImports).toEqual([])
  })

  it('takes corners from the radius tokens, never Tailwind names or raw pixels', () => {
    expect(violations(/\brounded(?:-[tblrse]{1,2})?-(?:sm|md|lg|xl|2xl|3xl)\b/g)).toEqual([])
    expect(violations(/\brounded(?:-[tblrse]{1,2})?-\[\d+(?:\.\d+)?px\]/g)).toEqual([])
  })

  it('keeps small labels in sentence case without wide tracking (it does nothing for Chinese)', () => {
    expect(violations(/\btracking-(?:wide|wider|widest)\b|\btracking-\[0?\.(?:0[5-9]|[1-9]\d?)em\]/g)).toEqual([])
  })
})
