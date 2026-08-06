import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

/**
 * Repository-local module graph for change-impact selection.
 *
 * The PR gate routes changed paths to checks by prefix alone. That is correct only
 * while every consumer of a file lives under the same prefix, which this repository
 * violates in both directions: `desktop/src/config/providerPresets.ts` imports
 * `src/server/config/providerPresets.json`, `desktop/src/lib/runtimeSelection.ts`
 * imports `src/shared/modelReasoning`, and `desktop/electron/**` imports
 * `desktop/src/**` while being excluded from `desktop/tsconfig.json`. A prefix-only
 * router keeps those PRs green and ships the break.
 *
 * The graph is intentionally lexical: it resolves relative and `@/`-aliased
 * specifiers only. Bare package specifiers cannot create an intra-repository edge,
 * and a full type-aware resolver would add a dependency and a per-run compile.
 */

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'] as const
const RESOLUTION_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'] as const
const INDEX_BASENAMES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs', 'index.cjs'] as const
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'artifacts', 'electron-dist', 'build-artifacts', 'target'])

export const GRAPH_SOURCE_ROOTS = ['src', 'desktop/src', 'desktop/electron', 'adapters', 'scripts'] as const

/**
 * Matches `import ... from 'x'`, `export ... from 'x'`, bare `import 'x'`,
 * `import('x')`, and `require('x')`. Only the specifier is captured.
 */
const SPECIFIER_PATTERN = /(?:\bfrom\s*|\bimport\s*|\brequire\s*)\(?\s*['"]([^'"]+)['"]/g

export type ModuleGraph = {
  /** Repo-relative file -> repo-relative files it imports. */
  imports: Map<string, Set<string>>
  /** Repo-relative file -> repo-relative files that import it. */
  importedBy: Map<string, Set<string>>
  /** Relative specifiers the lexical resolver could not map to a file in the repo. */
  unresolved: Array<{ file: string; specifier: string }>
  fileCount: number
}

export function normalizeGraphPath(path: string) {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '')
}

function isSourceFile(path: string) {
  return SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension))
}

export function listGraphSourceFiles(rootDir: string, roots: readonly string[] = GRAPH_SOURCE_ROOTS) {
  const files: string[] = []

  const walk = (absolute: string) => {
    let entries: string[]
    try {
      entries = readdirSync(absolute)
    } catch {
      return
    }

    for (const entry of entries) {
      if (SKIPPED_DIRECTORIES.has(entry)) continue
      const fullPath = join(absolute, entry)
      let stat: ReturnType<typeof statSync>
      try {
        stat = statSync(fullPath)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        walk(fullPath)
        continue
      }
      if (stat.isFile() && isSourceFile(entry)) {
        files.push(normalizeGraphPath(relative(rootDir, fullPath).split(sep).join('/')))
      }
    }
  }

  for (const root of roots) {
    const absolute = join(rootDir, root)
    if (existsSync(absolute)) walk(absolute)
  }

  return files.sort()
}

export function extractRelativeSpecifiers(source: string): string[] {
  const specifiers = new Set<string>()
  SPECIFIER_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SPECIFIER_PATTERN.exec(source)) !== null) {
    const specifier = match[1]
    if (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('@/')) {
      specifiers.add(specifier)
    }
  }
  return [...specifiers]
}

/**
 * Resolve one specifier to a repo-relative file.
 *
 * Handles the two forms this repository mixes: extensionless TypeScript imports and
 * ESM-style `.js` specifiers that actually point at a `.ts` source file.
 */
export function resolveSpecifier(
  rootDir: string,
  fromFile: string,
  specifier: string,
  fileSet: ReadonlySet<string>,
): string | null {
  const base = specifier.startsWith('@/')
    ? join(rootDir, 'desktop', 'src', specifier.slice(2))
    : resolve(join(rootDir, dirname(fromFile)), specifier)

  const candidates: string[] = [base]
  for (const extension of RESOLUTION_EXTENSIONS) {
    candidates.push(`${base}${extension}`)
  }
  const jsLike = base.match(/\.(js|jsx|mjs|cjs)$/)
  if (jsLike) {
    const stem = base.slice(0, -jsLike[0].length)
    for (const extension of ['.ts', '.tsx', '.mts', '.cts'] as const) {
      candidates.push(`${stem}${extension}`)
    }
  }
  for (const indexName of INDEX_BASENAMES) {
    candidates.push(join(base, indexName))
  }

  for (const candidate of candidates) {
    const relativePath = normalizeGraphPath(relative(rootDir, candidate).split(sep).join('/'))
    if (relativePath.startsWith('..')) continue
    if (fileSet.has(relativePath)) return relativePath
  }
  return null
}

export function buildModuleGraph(
  rootDir: string,
  roots: readonly string[] = GRAPH_SOURCE_ROOTS,
): ModuleGraph {
  const files = listGraphSourceFiles(rootDir, roots)
  const fileSet = new Set(files)
  const imports = new Map<string, Set<string>>()
  const importedBy = new Map<string, Set<string>>()
  const unresolved: Array<{ file: string; specifier: string }> = []

  for (const file of files) {
    if (file.endsWith('.json')) continue
    let source: string
    try {
      source = readFileSync(join(rootDir, file), 'utf8')
    } catch {
      continue
    }

    for (const specifier of extractRelativeSpecifiers(source)) {
      const target = resolveSpecifier(rootDir, file, specifier, fileSet)
      if (!target) {
        unresolved.push({ file, specifier })
        continue
      }
      if (target === file) continue

      if (!imports.has(file)) imports.set(file, new Set())
      imports.get(file)!.add(target)
      if (!importedBy.has(target)) importedBy.set(target, new Set())
      importedBy.get(target)!.add(file)
    }
  }

  return { imports, importedBy, unresolved, fileCount: files.length }
}

/**
 * Files that transitively import any of `changedFiles`, excluding the changed files
 * themselves. This is what turns a prefix-scoped diff into the full set of surfaces
 * a check must cover.
 */
export type DependentResolution = {
  dependents: string[]
  /** True when the graph could not be built and selection fell back to a wide net. */
  degraded: boolean
  reason?: string
}

/**
 * Resolve dependents for a change set, degrading safely.
 *
 * If the graph cannot be built the gate must not silently return to prefix-only
 * routing, because that is the failure mode this module exists to remove. Instead it
 * reports every source root as affected so the run over-selects rather than
 * under-selects, and says so out loud.
 */
export function dependentFilesForChangeSet(
  rootDir: string,
  changedFiles: readonly string[],
  options: { enabled?: boolean; roots?: readonly string[] } = {},
): DependentResolution {
  if (options.enabled === false) {
    return { dependents: [], degraded: false, reason: 'dependency graph disabled by flag' }
  }

  try {
    const graph = buildModuleGraph(rootDir, options.roots)
    return { dependents: dependentsOf(changedFiles, graph), degraded: false }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      dependents: WIDE_NET_FALLBACK_FILES.slice(),
      degraded: true,
      reason,
    }
  }
}

/**
 * Stand-ins that make every surface check select when the graph is unavailable.
 * These paths need not exist; the policy only matches on prefixes.
 */
export const WIDE_NET_FALLBACK_FILES = [
  'src/server/ws/handler.ts',
  'src/server/services/providerService.ts',
  'src/server/services/persistentStorageMigrations.ts',
  'desktop/src/stores/chatStore.ts',
  'desktop/electron/main.ts',
  'adapters/index.ts',
]

export function dependentsOf(
  changedFiles: readonly string[],
  graph: Pick<ModuleGraph, 'importedBy'>,
  maxFiles = 5_000,
): string[] {
  const seeds = changedFiles.map(normalizeGraphPath)
  const seen = new Set(seeds)
  const queue = [...seeds]
  const dependents = new Set<string>()

  while (queue.length > 0 && dependents.size < maxFiles) {
    const current = queue.shift()!
    for (const importer of graph.importedBy.get(current) ?? []) {
      if (seen.has(importer)) continue
      seen.add(importer)
      dependents.add(importer)
      queue.push(importer)
    }
  }

  return [...dependents].sort()
}
