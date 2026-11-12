/**
 * scan-missing-imports.ts
 *
 * Before compiling the sidecar, scan every relative import / require / type import
 * specifier in src/, find targets missing on disk, and generate a minimal stub for each.
 *
 * Why: this fork's src/ uses the ant-internal feature() macro with dynamic
 * require/import heavily, gating source files that only exist in Anthropic's internal build.
 * bun build --compile must resolve every import specifier to a real file before
 * DCE, and fails outright when one is missing.
 *
 * A stub is a Proxy: any property read, call, or construct returns a safe noop.
 * Because these code paths are removed by DCE when feature(...) === false, the stub
 * is never actually evaluated at runtime; it is only a placeholder for the resolver.
 *
 * Generated stubs carry `// @generated stub from scan-missing-imports` so the script can
 * safely overwrite them without touching real code.
 */

import { readdir, stat, readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dir, '../..')
const srcRoot = path.join(repoRoot, 'src')
const adaptersRoot = path.join(repoRoot, 'adapters')

// Roots allowed for scanning and stub creation. Stubs outside them are refused,
// so nothing is accidentally written into node_modules or system paths.
const ALLOWED_STUB_ROOTS = [srcRoot, adaptersRoot]

const STUB_MARKER_TS = '// @generated stub from scan-missing-imports'
const STUB_MARKER_TEXT = '<!-- @generated stub from scan-missing-imports -->'

const TS_STUB_CONTENT = `${STUB_MARKER_TS}
// Generated file standing in for an ant-internal feature()-gated module.
// No external-build code path executes this after DCE; it is only a
// placeholder for the bun build resolver.
const __target = function noop() {}
const __handler: ProxyHandler<any> = {
  get(_t, prop) {
    if (prop === '__esModule') return true
    if (prop === 'default') return new Proxy(__target, __handler)
    if (prop === Symbol.toPrimitive) return () => undefined
    if (prop === Symbol.iterator) return function* () {}
    if (prop === Symbol.asyncIterator) return async function* () {}
    if (prop === 'then') return undefined
    return new Proxy(__target, __handler)
  },
  apply() {
    return new Proxy(__target, __handler)
  },
  construct() {
    return new Proxy(__target, __handler)
  },
}
const stub: any = new Proxy(__target, __handler)
export default stub
export const __stubMissing = true
// Common named exports; anything not listed here falls back to the default Proxy
export const createCachedMCState = stub
export const isCachedMicrocompactEnabled = stub
export const isModelSupportedForCacheEditing = stub
export const getCachedMCConfig = stub
export const markToolsSentToAPI = stub
export const resetCachedMCState = stub
export const checkProtectedNamespace = stub
export const getCoordinatorUserContext = stub
`

// Text assets (.md / .txt / .json, etc.) are inlined by Bun's text/json loader;
// a stub only needs to be valid, non-empty content in that format.
const TEXT_STUB_CONTENT = `${STUB_MARKER_TEXT}\nstub\n`
const JSON_STUB_CONTENT = `{"__stubMissing": true}\n`

const TEXT_EXTS = new Set(['.md', '.markdown', '.txt'])
const JSON_EXTS = new Set(['.json', '.json5'])

const IMPORT_PATTERNS = [
  // import X from './foo'
  /from\s+['"](\.[^'"]+)['"]/g,
  // import('./foo')
  /import\s*\(\s*['"](\.[^'"]+)['"]/g,
  // require('./foo')
  /require\s*\(\s*['"](\.[^'"]+)['"]/g,
  // import './foo' (side-effect only)
  /import\s+['"](\.[^'"]+)['"]/g,
  // typeof import('./foo')
  /typeof\s+import\s*\(\s*['"](\.[^'"]+)['"]/g,
]

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'])
// Test files are never compiled into the sidecar; they also write repo-root-relative
// import('./src/...') inside child-process source strings, which would create bogus stubs under src/ if resolved from the test's directory.
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.name === 'node_modules') continue
    if (entry.name === '__tests__') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walk(full)
    } else if (
      entry.isFile() &&
      SOURCE_EXT.has(path.extname(entry.name)) &&
      !TEST_FILE.test(entry.name)
    ) {
      yield full
    }
  }
}

function resolveCandidates(importer: string, spec: string): string[] {
  const importerDir = path.dirname(importer)
  const base = path.resolve(importerDir, spec)
  return [
    base,
    base + '.ts',
    base + '.tsx',
    base + '.mts',
    base + '.cts',
    base + '.js',
    base + '.jsx',
    base + '.mjs',
    base + '.cjs',
    base.replace(/\.(m|c)?js$/, '.ts'),
    base.replace(/\.(m|c)?js$/, '.tsx'),
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.js'),
  ]
}

function pickStubPath(importer: string, spec: string): string {
  const importerDir = path.dirname(importer)
  const base = path.resolve(importerDir, spec)
  // Map .js back to .ts: writing .js in TS sources is the ESM-on-Node convention
  if (base.endsWith('.js')) return base.slice(0, -3) + '.ts'
  if (base.endsWith('.jsx')) return base.slice(0, -4) + '.tsx'
  if (path.extname(base) === '') return base + '.ts'
  return base
}

function pickStubContent(stubPath: string): { content: string; marker: string } {
  const ext = path.extname(stubPath).toLowerCase()
  if (TEXT_EXTS.has(ext)) {
    return { content: TEXT_STUB_CONTENT, marker: STUB_MARKER_TEXT }
  }
  if (JSON_EXTS.has(ext)) {
    return { content: JSON_STUB_CONTENT, marker: '"__stubMissing"' }
  }
  return { content: TS_STUB_CONTENT, marker: STUB_MARKER_TS }
}

async function* walkRoots(roots: string[]): AsyncGenerator<string> {
  for (const root of roots) {
    if (!existsSync(root)) continue
    yield* walk(root)
  }
}

async function main() {
  const missing = new Map<string, Set<string>>() // stubPath → set of importers
  let scannedFiles = 0

  for await (const file of walkRoots([srcRoot, adaptersRoot])) {
    scannedFiles++
    let contents: string
    try {
      contents = await readFile(file, 'utf8')
    } catch {
      continue
    }

    for (const pattern of IMPORT_PATTERNS) {
      pattern.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = pattern.exec(contents)) !== null) {
        const spec = match[1]!
        if (!spec.startsWith('.')) continue
        const candidates = resolveCandidates(file, spec)
        let exists = false
        for (const c of candidates) {
          if (existsSync(c)) {
            exists = true
            break
          }
        }
        if (exists) continue
        const stubPath = pickStubPath(file, spec)
        if (!missing.has(stubPath)) missing.set(stubPath, new Set())
        missing.get(stubPath)!.add(path.relative(repoRoot, file))
      }
    }
  }

  console.log(`[scan] scanned ${scannedFiles} source files`)
  console.log(`[scan] missing ${missing.size} stub targets`)

  let createdCount = 0
  let skippedCount = 0
  for (const [stubPath, importers] of missing) {
    // Safety check: only create under ALLOWED_STUB_ROOTS (src/, adapters/),
    // and skip a file that already exists but is not a stub
    const isAllowed = ALLOWED_STUB_ROOTS.some(
      (root) => stubPath.startsWith(root + path.sep),
    )
    if (!isAllowed) {
      console.warn(`[scan] skip out-of-tree stub target: ${stubPath}`)
      continue
    }
    const { content, marker } = pickStubContent(stubPath)
    if (existsSync(stubPath)) {
      try {
        const existing = await readFile(stubPath, 'utf8')
        if (!existing.includes(marker) && !existing.includes(STUB_MARKER_TS)) {
          console.warn(
            `[scan] skip non-stub existing file: ${path.relative(repoRoot, stubPath)}`,
          )
          skippedCount++
          continue
        }
      } catch {
        // ignore
      }
    }
    await mkdir(path.dirname(stubPath), { recursive: true })
    await writeFile(stubPath, content, 'utf8')
    createdCount++
    const rel = path.relative(repoRoot, stubPath)
    const sample = [...importers].slice(0, 2).join(', ')
    console.log(
      `[scan] stub: ${rel} (referenced from ${sample}${importers.size > 2 ? `, +${importers.size - 2}` : ''})`,
    )
  }
  console.log(`[scan] created ${createdCount} stubs, skipped ${skippedCount}`)
}

await main()
