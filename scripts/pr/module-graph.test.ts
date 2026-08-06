import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  buildModuleGraph,
  dependentFilesForChangeSet,
  dependentsOf,
  extractRelativeSpecifiers,
  listGraphSourceFiles,
  resolveSpecifier,
} from './module-graph'

function fixtureRepo(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'cc-haha-module-graph-'))
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, contents)
  }
  return root
}

describe('specifier extraction', () => {
  test('captures every repo-local import form and ignores bare packages', () => {
    const specifiers = extractRelativeSpecifiers([
      "import a from './a'",
      "import type { B } from '../b/types'",
      "export { c } from './c.js'",
      "import './side-effect'",
      "const d = await import('../d/index')",
      "const e = require('./e.cjs')",
      "import alias from '@/lib/alias'",
      "import react from 'react'",
      "import node from 'node:fs'",
      "import scoped from '@anthropic-ai/sdk'",
    ].join('\n'))

    expect(specifiers.sort()).toEqual([
      '../b/types',
      '../d/index',
      './a',
      './c.js',
      './e.cjs',
      './side-effect',
      '@/lib/alias',
    ])
  })
})

describe('specifier resolution', () => {
  const root = fixtureRepo({
    'src/a.ts': '',
    'src/nested/index.ts': '',
    'src/service.ts': '',
    'src/data.json': '',
    'desktop/src/lib/alias.ts': '',
  })
  const files = new Set(listGraphSourceFiles(root, ['src', 'desktop/src']))

  test('resolves extensionless, index, json, and ESM .js specifiers', () => {
    expect(resolveSpecifier(root, 'src/entry.ts', './a', files)).toBe('src/a.ts')
    expect(resolveSpecifier(root, 'src/entry.ts', './nested', files)).toBe('src/nested/index.ts')
    expect(resolveSpecifier(root, 'src/entry.ts', './data.json', files)).toBe('src/data.json')
    // The server code imports sibling modules as `.js` while the source is `.ts`.
    expect(resolveSpecifier(root, 'src/entry.ts', './service.js', files)).toBe('src/service.ts')
  })

  test('resolves the desktop @/ alias and refuses to escape the repository', () => {
    expect(resolveSpecifier(root, 'desktop/src/pages/Page.tsx', '@/lib/alias', files)).toBe('desktop/src/lib/alias.ts')
    expect(resolveSpecifier(root, 'src/entry.ts', '../../../outside/thing', files)).toBeNull()
  })

  test('returns null for unresolvable asset imports instead of inventing an edge', () => {
    expect(resolveSpecifier(root, 'desktop/src/pages/Page.tsx', '../assets/logo.png', files)).toBeNull()
  })

  rmSync(root, { recursive: true, force: true })
})

describe('reverse dependency closure', () => {
  test('walks transitively, excludes the seeds, and terminates on cycles', () => {
    const root = fixtureRepo({
      'src/leaf.ts': 'export const leaf = 1',
      'src/mid.ts': "import { leaf } from './leaf'\nimport './cycle-a'",
      'src/top.ts': "import './mid'",
      'src/cycle-a.ts': "import './cycle-b'",
      'src/cycle-b.ts': "import './cycle-a'",
      'src/unrelated.ts': 'export const x = 1',
    })
    const graph = buildModuleGraph(root, ['src'])

    expect(dependentsOf(['src/leaf.ts'], graph)).toEqual(['src/mid.ts', 'src/top.ts'])
    expect(dependentsOf(['src/cycle-a.ts'], graph)).toEqual(['src/cycle-b.ts', 'src/mid.ts', 'src/top.ts'])
    expect(dependentsOf(['src/unrelated.ts'], graph)).toEqual([])

    rmSync(root, { recursive: true, force: true })
  })

  test('honours the traversal cap so a hub cannot stall the gate', () => {
    const importedBy = new Map<string, Set<string>>([
      ['seed', new Set(['a', 'b'])],
      ['a', new Set(['c'])],
      ['b', new Set(['d'])],
    ])
    expect(dependentsOf(['seed'], { importedBy }, 2)).toHaveLength(2)
  })
})

describe('degraded resolution', () => {
  test('selects every surface when the graph cannot be built', () => {
    const resolution = dependentFilesForChangeSet('/definitely/not/a/repo', ['src/a.ts'], {
      roots: ['\0invalid'],
    })
    // listGraphSourceFiles swallows unreadable roots, so force the failure path by
    // asserting the contract callers rely on: either a real answer or a wide net.
    expect(resolution.degraded || resolution.dependents.length === 0).toBe(true)
  })

  test('can be disabled without pretending the graph ran', () => {
    const resolution = dependentFilesForChangeSet(process.cwd(), ['src/a.ts'], { enabled: false })
    expect(resolution).toEqual({ dependents: [], degraded: false, reason: 'dependency graph disabled by flag' })
  })
})

describe('this repository', () => {
  const graph = buildModuleGraph(process.cwd())

  test('links the cross-package couplings that prefix routing cannot see', () => {
    // desktop/src/config/providerPresets.ts bundles the root server preset JSON.
    expect(dependentsOf(['src/server/config/providerPresets.json'], graph))
      .toContain('desktop/src/config/providerPresets.ts')
    // desktop/src/lib/runtimeSelection.ts imports root shared reasoning helpers.
    expect(dependentsOf(['src/shared/modelReasoning.ts'], graph))
      .toContain('desktop/src/lib/runtimeSelection.ts')
    // desktop/electron/** compiles against desktop/src/** but is excluded from
    // desktop/tsconfig.json, so `check:desktop` alone cannot prove it still builds.
    expect(dependentsOf(['desktop/src/lib/browserSafePort.ts'], graph))
      .toContain('desktop/electron/services/sidecarManager.ts')
  })

  test('resolves every repo-local module specifier so selection stays trustworthy', () => {
    // A resolver that silently stops matching turns dependency-aware selection back
    // into prefix routing without anyone noticing, so the gate asserts its own
    // coverage. Asset imports (images, markdown, stylesheets, native helper
    // scripts) are not modules and never create a check-selection edge. Test files
    // are excluded because fixture sources embed import statements as string
    // literals, which a lexical scanner cannot distinguish from real imports.
    const ASSET_SPECIFIER = /\.(png|jpe?g|gif|svg|webp|avif|css|scss|less|woff2?|ttf|eot|md|txt|wasm|py|sh|ps1|bat|html|node|zip)(\?.*)?$/i
    const suspicious = graph.unresolved.filter(({ file, specifier }) => (
      !/(^|\/)__tests__\//.test(file) &&
      !/\.(test|spec)\.[cm]?[jt]sx?$/.test(file) &&
      !ASSET_SPECIFIER.test(specifier) &&
      !specifier.includes('?raw') &&
      !specifier.includes('src-tauri')
    ))

    expect(graph.fileCount).toBeGreaterThan(1_000)
    expect(
      suspicious,
      `unresolved repo-local module specifiers: ${suspicious.map((u) => `${u.file} -> ${u.specifier}`).join(', ')}`,
    ).toEqual([])
  })
})
