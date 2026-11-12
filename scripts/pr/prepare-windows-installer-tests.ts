#!/usr/bin/env bun

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const historicalInstallerFixture = {
  tag: 'v0.7.8',
  assetId: 730495182,
  fileName: 'Claude-Code-Haha-0.7.8-Windows-x64-Setup.exe',
  url: 'https://github.com/NanmiCoder/cc-haha/releases/download/v0.7.8/Claude-Code-Haha-0.7.8-Windows-x64-Setup.exe',
  bytes: 230611497,
  sha256: 'dca6bb82f4d0fbee8d43c91912e4d50e7dcea69a7cb22c51cdd9cb265767c7e7',
} as const

export const pinnedNsisCompiler = {
  version: '3.0.4.1',
  archiveSha512: 'VKMiizYdmNdJOWpRGz4trl4lD++BvYP2irAXpMilheUP0pc93iKlWAoP843Vlraj8YG19CVn0j+dCo/hURz9+Q==',
} as const
const tempPrefix = 'cc-haha-nsis-'
const ownershipFile = '.cc-haha-installer-test-owner'

export type PreparedNsisTools = {
  compiler: string
  templates: string
  version: string
  archiveSha512: string
  compilerSha256: string
}

export type PreparedWindowsInstallerTests = {
  version: 1
  status: 'preparing' | 'prepared' | 'failed'
  sourceRoot: string
  tempParent: string
  tempRoot: string
  owner: string
  fixtureDirectory: string
  tools?: PreparedNsisTools
  historicalInstaller?: {
    tag: string
    assetId: number
    file: string
    bytes: number
    sha256: string
    verified: true
  }
  extraction?: {
    status: 'extracted' | 'not_proven'
    method: string
    diagnostics: string[]
    file?: string
    bytes?: number
    sha256?: string
  }
  compatibilityProfile: 'not_proven'
  oldExit22BeforeMutation: 'not_run'
  removalEquivalence: 'not_run'
  compatibilityEnabled: false
  error?: string
}

export function assertOutsideSourceGit(directory: string, sourceRoot: string) {
  const source = realpathSync(sourceRoot)
  const target = realpathSync(directory)
  const relation = relative(source, target)
  if (!relation || (!isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${sep}`))) {
    throw new Error(`Installer fixture temporary directory must be outside source Git root: ${target}`)
  }
}

export function isInsideDirectory(directory: string, file: string) {
  const relation = relative(realpathSync(directory), realpathSync(file))
  return Boolean(relation) && !isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${sep}`)
}

export async function sha256File(file: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export async function verifyInstallerFixture(file: string, expected: { bytes: number; sha256: string }) {
  if (statSync(file).size !== expected.bytes) throw new Error('Historical installer byte count does not match the pinned official asset')
  const digest = await sha256File(file)
  if (digest !== expected.sha256) throw new Error('Historical installer SHA-256 does not match the pinned official asset')
  return digest
}

function desktopRequire(sourceRoot: string) {
  return createRequire(join(sourceRoot, 'desktop/package.json'))
}

async function acquirePinnedNsisTools(sourceRoot: string, tempRoot: string): Promise<PreparedNsisTools> {
  const require = desktopRequire(sourceRoot)
  const appBuilder = require('app-builder-lib/package.json') as { version: string }
  if (appBuilder.version !== '26.8.1') throw new Error('Review the pinned NSIS dependency before changing app-builder-lib@26.8.1')
  // The locked dependency verifies the NSIS archive checksum. Keep its cache
  // private, and do not accept an inherited custom compiler override.
  delete process.env.ELECTRON_BUILDER_NSIS_DIR
  delete process.env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR
  process.env.ELECTRON_BUILDER_CACHE = join(tempRoot, 'builder-cache')
  const nsis = require('app-builder-lib/out/targets/nsis/nsisUtil.js') as {
    NsisTargetOptions: { resolve(options: object): void }
    NSIS_PATH(): Promise<string>
  }
  nsis.NsisTargetOptions.resolve({})
  const binaryRoot = await nsis.NSIS_PATH()
  assertOutsideSourceGit(binaryRoot, sourceRoot)
  const compiler = join(binaryRoot, 'Bin/makensis.exe')
  const templates = dirname(require.resolve('app-builder-lib/templates/nsis/installer.nsi'))
  if (!existsSync(compiler) || !existsSync(join(templates, 'include/getProcessInfo.nsh'))) {
    throw new Error('Pinned NSIS compiler or electron-builder templates are missing')
  }
  return { compiler, templates, ...pinnedNsisCompiler, compilerSha256: await sha256File(compiler) }
}

export async function downloadPinnedInstaller(url: string, target: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) })
  if (!response.ok || !response.body) throw new Error(`Historical installer download failed: HTTP ${response.status}`)
  await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(target, { flags: 'wx' }))
}

function executableCandidates(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error('Historical extraction contains an unexpected symbolic link')
    if (entry.isDirectory()) return executableCandidates(file)
    return entry.isFile() && /uninstall.*\.exe$/i.test(entry.name) ? [file] : []
  })
}

async function extractHistoricalUninstaller(sourceRoot: string, installer: string, directory: string) {
  const require = desktopRequire(sourceRoot)
  const diagnostics: string[] = []
  const output = join(directory, 'Uninstall Claude Code Haha.exe')
  const { UninstallerReader } = require('app-builder-lib/out/targets/nsis/nsisUtil.js') as {
    UninstallerReader: { exec(installer: string, output: string): Promise<void> }
  }
  try {
    await UninstallerReader.exec(installer, output)
    return { status: 'extracted' as const, method: 'app-builder-lib@26.8.1 UninstallerReader', diagnostics, file: output }
  } catch (error) {
    rmSync(output, { force: true })
    diagnostics.push(`UninstallerReader: ${String(error)}`)
  }

  // Only extract selected bytes. Neither the public setup nor the extracted
  // uninstaller is executed; their deletion semantics remain unproved.
  const appRequire = createRequire(require.resolve('app-builder-lib/package.json'))
  const builderRequire = createRequire(appRequire.resolve('builder-util/package.json'))
  const sevenZipPackage = builderRequire('7zip-bin/package.json') as { version: string }
  if (sevenZipPackage.version !== '5.2.0') throw new Error('Review the pinned 7zip-bin@5.2.0 extractor before changing it')
  const sevenZip = (builderRequire('7zip-bin') as { path7za: string }).path7za
  const extract = spawnSync(sevenZip, ['x', '-y', `-o${directory}`, installer, '*uninstall*', '-r'], {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  })
  diagnostics.push(`7zip-bin@5.2.0 exit=${extract.status}; ${extract.stdout ?? ''}${extract.stderr ?? ''}${extract.error ?? ''}`)
  const candidates = executableCandidates(directory)
  if (extract.status === 0 && candidates.length === 1) {
    return { status: 'extracted' as const, method: '7zip-bin@5.2.0 NSIS read-only extraction', diagnostics, file: candidates[0] }
  }
  diagnostics.push(`Unambiguous uninstaller candidates: ${candidates.length}`)
  return { status: 'not_proven' as const, method: 'static extraction unavailable', diagnostics }
}

export async function prepareWindowsInstallerTests(options: {
  platform?: NodeJS.Platform
  sourceRoot?: string
  tempParent?: string
  manifestFile?: string
  fixture?: { tag: string; assetId: number; fileName: string; url: string; bytes: number; sha256: string }
  acquireTools?: typeof acquirePinnedNsisTools
  download?: typeof downloadPinnedInstaller
  extract?: typeof extractHistoricalUninstaller
} = {}) {
  if ((options.platform ?? process.platform) !== 'win32') throw new Error('Windows installer dependency preparation is Windows-only')
  if ((!options.acquireTools || !options.download || !options.extract) && (process.platform !== 'win32' || process.env.CI !== 'true')) {
    throw new Error('Real installer preparation may run only on a disposable Windows CI runner')
  }
  const sourceRoot = realpathSync(options.sourceRoot ?? resolve(import.meta.dir, '../..'))
  const tempParent = realpathSync(options.tempParent ?? process.env.RUNNER_TEMP ?? tmpdir())
  assertOutsideSourceGit(tempParent, sourceRoot)
  const tempRoot = mkdtempSync(join(tempParent, tempPrefix))
  assertOutsideSourceGit(tempRoot, sourceRoot)
  const owner = randomUUID()
  writeFileSync(join(tempRoot, ownershipFile), owner)
  const fixtureDirectory = join(tempRoot, 'historical-fixture')
  mkdirSync(fixtureDirectory)
  const manifestFile = options.manifestFile ?? join(sourceRoot, 'artifacts/windows-installer/prepared.json')
  mkdirSync(dirname(manifestFile), { recursive: true })
  const manifest: PreparedWindowsInstallerTests = {
    version: 1, status: 'preparing', sourceRoot, tempParent, tempRoot, owner, fixtureDirectory,
    compatibilityProfile: 'not_proven', oldExit22BeforeMutation: 'not_run', removalEquivalence: 'not_run', compatibilityEnabled: false,
  }
  const save = () => writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
  save()
  try {
    manifest.tools = await (options.acquireTools ?? acquirePinnedNsisTools)(sourceRoot, tempRoot)
    const fixture = options.fixture ?? historicalInstallerFixture
    const installer = join(fixtureDirectory, fixture.fileName)
    const partial = `${installer}.partial`
    await (options.download ?? downloadPinnedInstaller)(fixture.url, partial)
    const digest = await verifyInstallerFixture(partial, fixture)
    renameSync(partial, installer)
    manifest.historicalInstaller = { tag: fixture.tag, assetId: fixture.assetId, file: installer, bytes: fixture.bytes, sha256: digest, verified: true }
    const extractionDirectory = join(fixtureDirectory, 'extracted')
    mkdirSync(extractionDirectory)
    const extraction = await (options.extract ?? extractHistoricalUninstaller)(sourceRoot, installer, extractionDirectory)
    manifest.extraction = extraction
    if (extraction.status === 'extracted' && extraction.file) {
      const file = realpathSync(extraction.file)
      if (isInsideDirectory(extractionDirectory, file)) {
        const header = readFileSync(file).subarray(0, 2)
        if (!header.equals(Buffer.from('MZ'))) throw new Error('Extracted uninstaller is not a PE executable')
        manifest.extraction = { ...extraction, file, bytes: statSync(file).size, sha256: await sha256File(file) }
      } else throw new Error('Extracted uninstaller escaped its private fixture directory')
    }
    manifest.status = 'prepared'
    save()
    return manifest
  } catch (error) {
    manifest.status = 'failed'
    manifest.error = String(error)
    save()
    throw error
  }
}

export function assertPreparedTemporaryRoot(manifest: PreparedWindowsInstallerTests, options: { sourceRoot?: string; tempParent?: string } = {}) {
  const sourceRoot = realpathSync(options.sourceRoot ?? resolve(import.meta.dir, '../..'))
  const expectedParent = realpathSync(options.tempParent ?? process.env.RUNNER_TEMP ?? tmpdir())
  const tempParent = realpathSync(manifest.tempParent)
  const tempRoot = realpathSync(manifest.tempRoot)
  assertOutsideSourceGit(tempRoot, sourceRoot)
  if (manifest.version !== 1 || manifest.sourceRoot !== sourceRoot || tempParent !== expectedParent ||
      dirname(tempRoot) !== tempParent || !basename(tempRoot).startsWith(tempPrefix) ||
      readFileSync(join(tempRoot, ownershipFile), 'utf8') !== manifest.owner) {
    throw new Error('Refusing to use an unowned installer fixture directory')
  }
  return tempRoot
}

export function cleanupPreparedWindowsInstallerTests(manifest: PreparedWindowsInstallerTests, options: { sourceRoot?: string; tempParent?: string } = {}) {
  const tempRoot = assertPreparedTemporaryRoot(manifest, options)
  rmSync(tempRoot, { recursive: true, force: true })
}

if (import.meta.main) {
  const manifestFile = resolve('artifacts/windows-installer/prepared.json')
  try {
    const manifest = await prepareWindowsInstallerTests({ manifestFile })
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `manifest=${manifestFile}\nfixture_dir=${manifest.fixtureDirectory}\n`)
    }
    console.log(`[windows-installer-prepare] official asset verified; static extraction=${manifest.extraction?.status}; F1 compatibility remains disabled`)
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
