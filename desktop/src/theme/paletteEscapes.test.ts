import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Blocks new uses of Tailwind's stock palette (`bg-amber-50`, `text-red-400`, …).
 *
 * Those classes are fixed colors. They do not move with `data-theme`, so a
 * component using them renders identically under all three themes — the same
 * defect as a hardcoded hex, except `tokenUsage.test.ts` cannot see it: there
 * is no `var()` to fail to resolve.
 *
 * This is a ratchet, not a clean sweep. The files below predate the component
 * library and are allowed to keep what they have; they may not grow, and no new
 * file may join them. Reduce a count when you convert some, and delete the
 * entry when it reaches zero.
 */

const SRC = join(process.cwd(), 'src')

const PALETTE = [
  'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan',
  'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
  'slate', 'gray', 'zinc', 'neutral', 'stone',
].join('|')

const PALETTE_CLASS = new RegExp(
  String.raw`\b(?:bg|text|border|ring|from|to|via|divide|outline|decoration|shadow)-(?:${PALETTE})-\d{2,3}\b`,
  'g',
)

/**
 * Known offenders, with the count they are allowed to keep.
 *
 * - `settings/H5AccessSettings.tsx` — two neutrals inside the QR panel. That panel
 *   is a hardcoded `bg-white` box because scanners need the contrast, so its text
 *   has to stay dark under `data-theme="dark"` as well. Theme tokens are the wrong
 *   answer here; the right one is a token pair for content on a permanently
 *   light surface, which does not exist yet. (The entry read `pages/Settings.tsx`
 *   until that file was split into one module per panel; the code is unchanged.)
 *
 * `StreamingIndicator.tsx` used to sit here with 20. Its retry banner is now on
 * the `warning` token pair, so it needed no `dark:` variants at all — the entry
 * is gone rather than reduced.
 *
 * `PetApp.tsx` used to sit here with 3, all in one `rose` error banner. It is
 * now on the `error` token pair, so its `dark:` variant went away with it —
 * that variant only ever covered one of the three themes anyway.
 *
 * `ComputerUseSettings.tsx` used to sit here with 21 — the permission-tier
 * status colors. They are now `--color-{success,warning,error}` and their
 * `-container` pairs, which also retired the `/5`–`/30` alpha modifiers that
 * Safari 15 drops entirely.
 */
const ALLOWED: Record<string, number> = {
  'pages/settings/H5AccessSettings.tsx': 2,
}

function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) collectSources(path, out)
    else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) out.push(path)
  }
  return out
}

describe('stock Tailwind palette', () => {
  const counts = new Map<string, number>()
  for (const file of collectSources(SRC)) {
    const hits = readFileSync(file, 'utf8').match(PALETTE_CLASS)?.length ?? 0
    if (hits > 0) counts.set(file.replace(`${SRC}/`, ''), hits)
  }

  it('is not used by any file outside the allowlist', () => {
    const newOffenders = [...counts.keys()].filter((file) => !(file in ALLOWED))
    expect(
      newOffenders,
      'Use theme tokens instead — stock palette colors do not follow data-theme. See components/AGENTS.md §3.1.',
    ).toEqual([])
  })

  it('does not grow in the files that already use it', () => {
    const grown = [...counts.entries()]
      .filter(([file, n]) => file in ALLOWED && n > ALLOWED[file]!)
      .map(([file, n]) => `${file}: ${n} (allowed ${ALLOWED[file]})`)

    expect(grown).toEqual([])
  })

  it('has an allowlist with no stale entries', () => {
    // Keeps the budget honest: once a file is converted, its entry must go.
    const stale = Object.keys(ALLOWED).filter((file) => !counts.has(file))
    expect(stale, 'These files no longer use the stock palette — drop them from ALLOWED.').toEqual([])
  })
})
