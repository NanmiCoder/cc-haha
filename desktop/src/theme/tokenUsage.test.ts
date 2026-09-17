import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

import css from './globals.css?raw'

/**
 * Guards the contract between the stylesheet and the components that consume
 * it. A `var(--color-typo)` fails silently — the property just resolves to
 * nothing and the element renders with a transparent background or a
 * `currentColor` border — so nothing surfaces this except a test.
 */

/** Vitest runs with `desktop/` as the root (see vitest.config.ts). */
const SRC_ROOT = join(process.cwd(), 'src')

/** Provided by Tailwind v4's default theme, not by globals.css. */
const TAILWIND_BUILTIN = new Set([
  '--font-sans', '--font-serif', '--font-mono',
  '--radius-xs', '--radius-sm', '--radius-md', '--radius-lg', '--radius-xl', '--radius-2xl', '--radius-3xl', '--radius-4xl',
  '--shadow-2xs', '--shadow-xs', '--shadow-sm', '--shadow-md', '--shadow-lg', '--shadow-xl', '--shadow-2xl',
  '--spacing', '--container-sm', '--container-md', '--container-lg',
  '--text-xs', '--text-sm', '--text-base', '--text-lg', '--text-xl',
  '--ease-in', '--ease-out', '--ease-in-out',
])

/** Set on an element at runtime rather than declared in the stylesheet. */
const RUNTIME_INJECTED = new Set([
  '--workspace-diff-gutter-width',
  '--trace-tree-width',
  '--touch-h5-viewport-height',
  '--line-start',
])

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) collectSourceFiles(path, out)
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(path)
  }
  return out
}

const definedTokens = new Set(
  [...css.matchAll(/^\s*(--[a-zA-Z0-9-]+)\s*:/gm)].map((match) => match[1]),
)

const sourceFiles = collectSourceFiles(SRC_ROOT)

function sourceRelativePath(file: string): string {
  return relative(SRC_ROOT, file).replaceAll('\\', '/')
}

describe('css custom property usage', () => {
  it('resolves every var(--token) referenced from components', () => {
    const unresolved: string[] = []

    for (const file of sourceFiles) {
      // preview-agent 是注入到第三方页面的独立脚本：它的样式活在 Shadow DOM 里，
      // 页面上不存在 globals.css，token 由那段样式自己定义自己消费。自洽性由
      // preview-agent/editBubble.test.ts 用同等强度的检查守住。
      const relativePath = sourceRelativePath(file)
      if (relativePath.startsWith('preview-agent/')) continue

      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, index) => {
        for (const match of line.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
          const token = match[1]!
          if (definedTokens.has(token)) continue
          if (TAILWIND_BUILTIN.has(token)) continue
          if (RUNTIME_INJECTED.has(token)) continue
          unresolved.push(`src/${relativePath}:${index + 1}  ${token}`)
        }
      })
    }

    // Regression: six tokens (--color-bg, --color-bg-primary,
    // --color-bg-secondary, --color-surface-secondary, --color-border-strong,
    // --color-on-primary-container) were referenced but never defined, which
    // left borders falling back to currentColor and panels transparent.
    expect(unresolved).toEqual([])
  })

  it('scopes every raw z-index to the shared layering scale', () => {
    const offenders: string[] = []

    for (const file of sourceFiles) {
      // The pet window is an OS-level always-on-top surface with its own
      // stacking context; it is not part of the in-app overlay scale.
      if (file.includes('/features/pets/')) continue

      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, index) => {
        // `zIndex: 9999` and friends in inline styles.
        if (/zIndex:\s*\d/.test(line)) {
          offenders.push(`${file.replace(SRC_ROOT, 'src')}:${index + 1}  ${line.trim()}`)
        }
        // Arbitrary Tailwind z values above the utility scale, e.g. z-[10000].
        for (const match of line.matchAll(/\bz-\[(\d+)\]/g)) {
          if (Number(match[1]) > 100) {
            offenders.push(`${file.replace(SRC_ROOT, 'src')}:${index + 1}  z-[${match[1]}]`)
          }
        }
      })
    }

    // Regression: DirectoryPicker's portal used `zIndex: 9999` and
    // MobileBottomSheet used `z-[10000]`, both chosen to win a fight the
    // layering scale now settles by name.
    expect(offenders).toEqual([])
  })

  it('puts every full-viewport overlay on the shared layering scale', () => {
    // The rule above only catches ARBITRARY z values (`z-[10000]`). Tailwind's
    // built-in utilities (`z-50`) slip past it while being exactly as opaque:
    // a bare 50 says nothing about whether it should sit above the sidebar's
    // dock or below a dropdown, and the `--z-*` scale is the only place that
    // answer is written down.
    //
    // Scoped to `fixed inset-0` on purpose. Small local values (`z-1`, `z-2`)
    // order siblings inside one component and carry no cross-component meaning,
    // so forcing them onto the scale would be noise. A full-viewport overlay is
    // the opposite: it competes with every other layer in the app.
    const offenders: string[] = []

    for (const file of sourceFiles) {
      if (file.includes('/features/pets/')) continue

      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, index) => {
        if (!/fixed\s+inset-0/.test(line)) return
        const bareZ = /\bz-(\d+)\b/.exec(line)
        if (bareZ) {
          offenders.push(
            `${file.replace(SRC_ROOT, 'src')}:${index + 1}  z-${bareZ[1]} (use z-[var(--z-…)])`,
          )
        }
      })
    }

    // Regression: ComputerUseSettings' app picker was a hand-rolled
    // `fixed inset-0 z-50` overlay instead of the shared Modal. Bare 50 landed
    // it below `--z-dropdown` (70) and next to `--z-drawer`, so the sidebar's
    // settings dock rendered on top of the scrim. It now uses Modal, which
    // portals to body and sits on `--z-dialog`.
    expect(offenders).toEqual([])
  })
})
