// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * pdf.js, docx-preview and SheetJS are hundreds of kilobytes apiece. The build does
 * not warn when one of them slips into the main bundle (`INEFFECTIVE_DYNAMIC_IMPORT`
 * is silenced in vite.config.ts), and every user would then pay for it on startup
 * whether or not they ever open a document.
 *
 * So the rule is checked here, on the source: a document engine is reached by a
 * dynamic `import()` from inside a function, never by an `import` at the top of a
 * module. The one exception is the worker entry, which exists to be loaded on its
 * own by `?worker` and is not part of any bundle that runs on the page.
 */

const srcRoot = path.resolve(import.meta.dirname, '..')

const HEAVY_PACKAGE = /^(pdfjs-dist|docx-preview|xlsx)(\/|$)/

/** Modules whose whole job is to be the far end of a dynamic import or a worker. */
const ENTRY_POINTS = new Set(['components/workspace/surfaces/document/pdf.worker.ts'])

/** `src/test`: fixtures and fakes that only tests import. They build documents with these very libraries. */
const TEST_SUPPORT_DIRECTORY = path.join(srcRoot, 'test')

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' || full === TEST_SUPPORT_DIRECTORY ? [] : sourceFiles(full)
    return /\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : []
  })
}

type StaticImport = { file: string; specifier: string; typeOnly: boolean }

function staticImports(file: string): StaticImport[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const found: StaticImport[] = []
  for (const node of source.statements) {
    const isImport = ts.isImportDeclaration(node)
    const isReExport = ts.isExportDeclaration(node)
    if (!(isImport || isReExport) || !node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) continue
    const typeOnly = isImport ? node.importClause?.isTypeOnly === true : node.isTypeOnly
    found.push({ file: path.relative(srcRoot, file).split(path.sep).join('/'), specifier: node.moduleSpecifier.text, typeOnly })
  }
  return found
}

const files = sourceFiles(srcRoot)
const imports = files.flatMap(staticImports)

describe('document engines stay out of the main bundle', () => {
  it('reads the source tree it is guarding', () => {
    // A scan that found nothing would pass every rule below.
    expect(files.length).toBeGreaterThan(500)
    expect(files.some((file) => file.endsWith('pdfEngine.ts'))).toBe(true)
    expect(imports.some((statement) => statement.specifier === 'react')).toBe(true)
  })

  it('imports a document engine only dynamically, or as a type', () => {
    const eager = imports.filter(
      (statement) => HEAVY_PACKAGE.test(statement.specifier) && !statement.typeOnly && !ENTRY_POINTS.has(statement.file),
    )

    expect(eager.map((statement) => `${statement.file} imports ${statement.specifier}`)).toEqual([])
  })

  it('loads pdf.js through the engine, which fetches it on first use', () => {
    const engine = readFileSync(path.join(srcRoot, 'components/workspace/surfaces/document/pdfEngine.ts'), 'utf8')

    expect(engine).toMatch(/import\('pdfjs-dist\/legacy\/build\/pdf\.mjs'\)/)
  })

  it('never imports the worker entry from the page, only through ?worker', () => {
    const direct = imports.filter((statement) => /(^|\/)pdf\.worker(\.ts)?$/.test(statement.specifier))

    expect(direct.map((statement) => `${statement.file} imports ${statement.specifier}`)).toEqual([])
  })

  it('reaches every document viewer through a lazy import, so opening a workspace loads none of them', () => {
    const viewers = imports.filter((statement) => statement.file.endsWith('document/documentViewers.ts'))

    // Only React (for `lazy`) and types: a viewer named here would be in the main bundle.
    expect(viewers.filter((statement) => !statement.typeOnly).map((statement) => statement.specifier)).toEqual(['react'])
  })

  it('does not let the panel that hosts documents import a viewer or engine directly', () => {
    const host = imports.filter(
      (statement) => statement.file.endsWith('workbench/WorkspaceFileTab.tsx') && !statement.typeOnly,
    )

    expect(host.filter((statement) => /(Pdf|Docx|Spreadsheet)(Surface|Viewer|Engine)/.test(statement.specifier))).toEqual([])
  })
})

describe('document libraries are declared as what they are', () => {
  const manifest = JSON.parse(readFileSync(path.resolve(srcRoot, '../package.json'), 'utf8')) as {
    dependencies: Record<string, string>
    devDependencies: Record<string, string>
  }

  it.each(['pdfjs-dist', 'docx-preview', 'xlsx', 'fflate'])(
    '%s is a devDependency: the renderer bundles it, and electron-builder packs every "dependencies" entry into app.asar',
    (name) => {
      // Listed under `dependencies` these four shipped a second, unused copy of about 45 MB
      // in every installer, beside the copy Vite had already put in dist/.
      expect(manifest.devDependencies[name]).toBeDefined()
      expect(manifest.dependencies[name]).toBeUndefined()
    },
  )

  it('takes SheetJS from its own CDN release, because the npm package stops at 0.18.5 and has unfixed advisories', () => {
    expect(manifest.devDependencies.xlsx).toBe('https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz')
  })

  it.each(['pdfjs-dist', 'docx-preview'])('pins %s to one version: the viewers are written against its internals', (name) => {
    expect(manifest.devDependencies[name]).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
