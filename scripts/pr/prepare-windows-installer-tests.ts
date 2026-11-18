#!/usr/bin/env bun

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { bootstrapFullSevenZip, historicalUninstallerMember, pinnedFullSevenZip, proveNsisMember, type NsisMemberProof, type SevenZipExtractor } from './windows-installer-member-proof'

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
export const pinnedNsisResources = {
  version: '3.4.1',
  archiveSha512: 'Dqd6g+2buwwvoG1Vyf6BHR1b+25QMmPcwZx40atOT57gH27rkjOei1L0JTldxZu4NFoEmW4kJgZ3DlSWVON3+Q==',
  plugins: ['StdUtils.dll', 'UAC.dll', 'WinShell.dll', 'nsProcess.dll'],
} as const
const tempPrefix = 'cc-haha-nsis-'
const ownershipFile = '.cc-haha-installer-test-owner'

export type PreparedNsisTools = {
  compiler: string
  templates: string
  version: string
  archiveSha512: string
  compilerSha256: string
  resources: {
    directory: string
    version: string
    archiveSha512: string
    pluginsSha256: Record<string, string>
  }
  fullSevenZip?: SevenZipExtractor
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
    memberProof?: NsisMemberProof
    memberProofEvidenceFile?: string
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
    NSIS_RESOURCES_PATH(): Promise<string>
  }
  nsis.NsisTargetOptions.resolve({})
  const binaryRoot = await nsis.NSIS_PATH()
  const resources = await nsis.NSIS_RESOURCES_PATH()
  assertOutsideSourceGit(binaryRoot, sourceRoot)
  assertOutsideSourceGit(resources, sourceRoot)
  const compiler = join(binaryRoot, 'Bin/makensis.exe')
  const templates = dirname(require.resolve('app-builder-lib/templates/nsis/installer.nsi'))
  if (!existsSync(compiler) || !existsSync(join(templates, 'include/getProcessInfo.nsh'))) {
    throw new Error('Pinned NSIS compiler or electron-builder templates are missing')
  }
  if (!isInsideDirectory(tempRoot, resources)) throw new Error('Pinned NSIS resources escaped the private dependency directory')
  const pluginsSha256: Record<string, string> = {}
  for (const name of pinnedNsisResources.plugins) {
    const file = join(resources, 'plugins/x86-unicode', name)
    if (!isInsideDirectory(tempRoot, file)) throw new Error('Pinned NSIS resources escaped the private dependency directory')
    pluginsSha256[name] = await sha256File(file)
  }
  const appRequire = createRequire(require.resolve('app-builder-lib/package.json'))
  const builderRequire = createRequire(appRequire.resolve('builder-util/package.json'))
  const sevenZipPackage = builderRequire('7zip-bin/package.json') as { version: string }
  if (sevenZipPackage.version !== '5.2.0') throw new Error('Review the pinned 7zip-bin@5.2.0 bootstrap before changing it')
  // Do not honor USE_SYSTEM_7ZA or resolve an unknown executable from PATH.
  const bootstrap = join(dirname(builderRequire.resolve('7zip-bin/package.json')), 'win/x64/7za.exe')
  if (await sha256File(bootstrap) !== 'b0cfdeaf429f5cc53f85123dd8f5a5feb92c19d31aa34df257edf9a26be05f95') {
    throw new Error('Pinned 7zip-bin Windows bootstrap identity changed')
  }
  const archive = join(tempRoot, '7z2606-x64.exe')
  await downloadPinnedInstaller(pinnedFullSevenZip.url, archive)
  await verifyInstallerFixture(archive, pinnedFullSevenZip)
  const fullSevenZip = bootstrapFullSevenZip({ archive, bootstrap, directory: join(tempRoot, 'full-seven-zip'),
    evidenceDirectory: join(sourceRoot, 'artifacts/windows-installer/member-proof/tools') })
  return { compiler, templates, ...pinnedNsisCompiler, compilerSha256: await sha256File(compiler), resources: {
    directory: resources, version: pinnedNsisResources.version, archiveSha512: pinnedNsisResources.archiveSha512, pluginsSha256,
  }, fullSevenZip }
}

export async function downloadPinnedInstaller(url: string, target: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) })
  if (!response.ok || !response.body) throw new Error(`Historical installer download failed: HTTP ${response.status}`)
  await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(target, { flags: 'wx' }))
}

type HistoricalExtraction = NonNullable<PreparedWindowsInstallerTests['extraction']>
async function extractHistoricalUninstaller(sourceRoot: string, installer: string, directory: string, extractor?: SevenZipExtractor): Promise<HistoricalExtraction> {
  const method = '7-Zip 26.06 forced NSIS literal-member proof'
  if (!extractor) return { status: 'not_proven', method, diagnostics: ['A pinned full NSIS extractor was not prepared'] }
  const { proof, evidenceFile } = proveNsisMember({
    setup: { file: installer, bytes: historicalInstallerFixture.bytes, sha256: historicalInstallerFixture.sha256 },
    // The fixed local output is independent of the archive's virtual $R0 directory.
    extractor, member: historicalUninstallerMember, output: join(directory, 'Uninstall Claude Code Haha.exe'),
    evidenceDirectory: join(sourceRoot, 'artifacts/windows-installer/member-proof/historical'),
  })
  return { status: proof.status === 'member_proven' ? 'extracted' : 'not_proven', method,
    diagnostics: proof.error ? [proof.error] : [], memberProof: proof, memberProofEvidenceFile: evidenceFile,
    ...(proof.output ? { file: proof.output.file, bytes: proof.output.bytes, sha256: proof.output.sha256 } : {}) }
}

export async function prepareWindowsInstallerTests(options: {
  platform?: NodeJS.Platform
  sourceRoot?: string
  tempParent?: string
  manifestFile?: string
  fixture?: { tag: string; assetId: number; fileName: string; url: string; bytes: number; sha256: string }
  acquireTools?: typeof acquirePinnedNsisTools
  download?: typeof downloadPinnedInstaller
  extract?: (sourceRoot: string, installer: string, directory: string) => Promise<HistoricalExtraction>
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
    const extraction = options.extract
      ? await options.extract(sourceRoot, installer, extractionDirectory)
      : await extractHistoricalUninstaller(sourceRoot, installer, extractionDirectory, manifest.tools.fullSevenZip)
    manifest.extraction = extraction
    if (extraction.status === 'extracted' && extraction.file) {
      const file = realpathSync(extraction.file)
      if (isInsideDirectory(extractionDirectory, file)) {
        const header = readFileSync(file).subarray(0, 2)
        if (!header.equals(Buffer.from('MZ'))) throw new Error('Extracted uninstaller is not a PE executable')
        const bytes = statSync(file).size
        const sha256 = await sha256File(file)
        if (extraction.memberProof && (extraction.memberProof.status !== 'member_proven' ||
            extraction.memberProof.setup.file !== installer || extraction.memberProof.setup.bytes !== fixture.bytes ||
            extraction.memberProof.setup.sha256 !== fixture.sha256 || extraction.memberProof.output?.file !== file ||
            extraction.memberProof.output.bytes !== bytes || extraction.memberProof.output.sha256 !== sha256)) {
          throw new Error('Extracted file no longer matches its static member proof')
        }
        manifest.extraction = { ...extraction, file, bytes, sha256 }
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
