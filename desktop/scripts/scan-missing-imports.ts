/**
 * scan-missing-imports.ts
 *
 * 在编译 sidecar 之前，扫描 src/ 里所有相对路径的 import / require / 类型 import
 * specifier，找出磁盘上不存在的目标，给它们生成最小 stub 文件。
 *
 * 为什么需要：本 fork 的 src/ 大量使用 ant-internal 的 feature() macro 配
 * dynamic require/import，gating 一堆只在 Anthropic 内部 build 才存在的源文件。
 * bun build --compile 在 DCE 之前必须先把所有 import specifier 都 resolve 到
 * 实际文件，找不到就直接 fail。
 *
 * Stub 文件内容是一个 Proxy，任何属性读、函数调用、构造调用都返回安全 noop。
 * 由于这些代码路径都被 feature(...) === false 的 DCE 干掉了，stub 在运行时
 * 永远不会真的被求值 —— 它只是给 resolver 的"占位符"。
 *
 * 生成的 stub 标记 `// @generated stub from scan-missing-imports` 让脚本可以
 * 安全地覆写它们而不会动到真实代码。
 */

import { readdir, stat, readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dir, '../..')
const srcRoot = path.join(repoRoot, 'src')
const adaptersRoot = path.join(repoRoot, 'adapters')

// 扫描 + 创建 stub 时允许的根目录。stub 写到这些目录之外会被拒绝，
// 防止意外往 node_modules / 系统路径写文件。
const ALLOWED_STUB_ROOTS = [srcRoot, adaptersRoot]

const STUB_MARKER_TS = '// @generated stub from scan-missing-imports'
const STUB_MARKER_TEXT = '<!-- @generated stub from scan-missing-imports -->'

const TS_STUB_CONTENT = `${STUB_MARKER_TS}
// 该文件自动生成，对应 ant-internal 的 feature() gated 模块。
// 所有外部 build 的代码路径在 DCE 后都不会真的执行这里的代码，这只是
// bun build resolver 的占位符。
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
// 兼容常见的命名导出 —— 没列在这里的也会通过 default Proxy 兜底
export const createCachedMCState = stub
export const isCachedMicrocompactEnabled = stub
export const isModelSupportedForCacheEditing = stub
export const getCachedMCConfig = stub
export const markToolsSentToAPI = stub
export const resetCachedMCState = stub
export const checkProtectedNamespace = stub
export const getCoordinatorUserContext = stub
`

// 文本类资源（.md / .txt / .json 等）通过 Bun 的 text/json loader 内联，
// stub 内容只要是合法的对应格式且非空即可。
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

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.name === 'node_modules') continue
    if (entry.name === '__tests__') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walk(full)
    } else if (entry.isFile() && SOURCE_EXT.has(path.extname(entry.name))) {
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
  // 把 .js 还原成 .ts —— TS 源里写 .js 是 ESM-on-Node 的惯例
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
    // 安全检查：只在 ALLOWED_STUB_ROOTS（src/、adapters/）下创建，
    // 且如果文件已存在但不是 stub 就跳过
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
