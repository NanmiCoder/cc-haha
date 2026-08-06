import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, normalize, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Every component must be reachable from an entry point.
 *
 * This exists because the coverage gate could not tell "no test" from "no callers".
 * `BackgroundTasksBar`, `SessionTaskBar` and `TeamStatusBar` lost their last import in
 * 56a4be3d1 when `SessionActivityPanel` replaced them. Nothing noticed: 598b968ee then
 * wrote tests for two of them — its message says "cover the components left at zero" —
 * purely to lift changed-lines coverage past the gate, and c712f5285 restyled all three
 * during the UI redesign. 577 component lines and 348 test lines were maintained for
 * code no user could reach, and nine translation keys were carried in five locales for
 * it.
 *
 * A coverage number cannot catch that; reachability can, and it has to run first.
 *
 * Scoped to `.tsx`. The `.ts` side has real entry points a static import graph cannot
 * see — `workspaceDiffHighlight.worker.ts` is loaded through `new Worker(new URL(...))`
 * and `src/preview-agent/**` is built into its own bundle by scripts/build-preview-agent.ts
 * — so covering it needs an allowlist, and an allowlist is where this kind of check goes
 * to die. Components have no such escape hatches, and the list below is empty.
 */

const SRC = join(process.cwd(), 'src')
const ROOT = process.cwd()

/**
 * Components that are unreachable by static import and legitimately so.
 *
 * Empty, and worth keeping that way. Before adding an entry, check that the component
 * is genuinely reached some other way — a new HTML entry belongs in ENTRY_HTML below
 * instead, where it also brings in everything it imports.
 */
const ALLOWED_UNREACHABLE: Record<string, string> = {}

/** Every HTML file Vite builds. Their script tags are the real roots. */
const ENTRY_HTML = ['index.html', 'gallery.html']

function collect(dir: string, match: (file: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) collect(path, match, out)
    else if (match(entry)) out.push(path)
  }
  return out
}

/** Mirrors the `@/` alias and extensionless/index resolution Vite and tsc both apply. */
function resolveSpecifier(specifier: string, fromFile: string): string | null {
  let base: string
  if (specifier.startsWith('@/')) base = join(SRC, specifier.slice(2))
  else if (specifier.startsWith('.')) base = normalize(join(dirname(fromFile), specifier))
  else return null

  for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx', '']) {
    const candidate = `${base}${suffix}`
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // Not this suffix.
    }
  }
  return null
}

function entryPoints(): string[] {
  const entries: string[] = []
  for (const html of ENTRY_HTML) {
    let markup: string
    try {
      markup = readFileSync(join(ROOT, html), 'utf8')
    } catch {
      continue
    }
    for (const match of markup.matchAll(/src="\/([^"]+\.tsx?)"/g)) {
      const path = join(ROOT, match[1]!)
      try {
        if (statSync(path).isFile()) entries.push(path)
      } catch {
        // A script tag pointing at nothing is index-html.test.ts's problem, not ours.
      }
    }
  }
  return entries
}

function reachableFromEntries(): Set<string> {
  const entries = entryPoints()
  const seen = new Set(entries)
  const stack = [...entries]

  while (stack.length > 0) {
    const file = stack.pop()!
    const source = readFileSync(file, 'utf8')
    // `from '...'` covers import and re-export; `import('...')` covers lazy routes.
    const specifiers = [
      ...[...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!),
      ...[...source.matchAll(/import\('([^']+)'\)/g)].map((m) => m[1]!),
    ]
    for (const specifier of specifiers) {
      const resolved = resolveSpecifier(specifier, file)
      if (resolved && !seen.has(resolved)) {
        seen.add(resolved)
        stack.push(resolved)
      }
    }
  }
  return seen
}

describe('component reachability', () => {
  const components = collect(SRC, (file) => file.endsWith('.tsx') && !file.endsWith('.test.tsx'))
  const reachable = reachableFromEntries()

  it('finds the entry points it is supposed to walk from', () => {
    // A typo in ENTRY_HTML, or a renamed entry, would make everything look unreachable
    // and the failure message would send the reader hunting in the wrong place.
    const entries = entryPoints().map((path) => relative(ROOT, path))
    expect(entries).toContain('src/main.tsx')
    expect(entries.length).toBeGreaterThanOrEqual(2)
    // The walk must actually traverse: main.tsx alone proves nothing.
    expect(reachable.size).toBeGreaterThan(100)
    expect(components.length).toBeGreaterThan(100)
  })

  it('reaches every component from an entry point', () => {
    const unreachable = components
      .filter((path) => !reachable.has(path))
      .map((path) => relative(SRC, path))
      .filter((path) => !(path in ALLOWED_UNREACHABLE))
      .sort()

    expect(
      unreachable,
      'these components have no runtime importer. Delete them along with their tests and '
        + 'any translation keys only they use — do not write tests to raise their coverage.',
    ).toEqual([])
  })

  it('has no stale allowlist entries', () => {
    const stale = Object.keys(ALLOWED_UNREACHABLE)
      .filter((path) => reachable.has(join(SRC, path)))
    expect(stale, 'these are reachable again; drop them from ALLOWED_UNREACHABLE').toEqual([])
  })
})
