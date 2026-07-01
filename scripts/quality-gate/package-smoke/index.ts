#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'

export type PackageSmokePlatform = 'macos' | 'windows' | 'linux'
export type VerificationMode = 'bundle-structure' | 'static-artifact'
export type PackageKind = 'auto' | 'dir' | 'release'

type CheckRecord = {
  label: string
  path: string
}

type InspectOptions = {
  platform: PackageSmokePlatform
  artifactsDir?: string
  requireMacosGatekeeper?: boolean
  packageKind?: PackageKind
  commandRunner?: PackageSmokeCommandRunner
  hostPlatform?: string
}

export type PackageSmokeArgs = {
  platform: PackageSmokePlatform
  artifactsDir?: string
  requireMacosGatekeeper?: boolean
  packageKind?: PackageKind
}

export type PackageSmokeReport = {
  platform: PackageSmokePlatform
  hostPlatform: string
  productName: string
  version: string
  verificationMode: VerificationMode
  packageKind: PackageKind
  artifactsDir: string
  packagedArtifacts: CheckRecord[]
  optionalArtifacts: CheckRecord[]
  passedChecks: CheckRecord[]
  missingChecks: CheckRecord[]
  notes: string[]
  passed: boolean
}

type DesktopMetadata = {
  productName: string
  version: string
}

type PackageSmokeCommandResult = {
  status: number | null
  stdout?: string
  stderr?: string
}

type PackageSmokeCommandRunner = (command: string, args: string[]) => PackageSmokeCommandResult

function usage() {
  return 'Usage: bun run test:package-smoke --platform <macos|windows|linux> [--package-kind <auto|dir|release>] [--artifacts-dir <path>] [--require-macos-gatekeeper]'
}

function readArgValue(argv: string[], index: number, flag: string) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}\n${usage()}`)
  }
  return value
}

export function parsePackageSmokeArgs(argv: string[]): PackageSmokeArgs {
  let platform: PackageSmokePlatform | undefined
  let artifactsDir: string | undefined
  let requireMacosGatekeeper = false
  let packageKind: PackageKind = 'auto'

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--platform') {
      const value = readArgValue(argv, index, arg)
      if (value === 'macos' || value === 'windows' || value === 'linux') {
        platform = value
      } else {
        throw new Error(`Unsupported --platform value: ${value}. Expected macos|windows|linux.\n${usage()}`)
      }
      index += 1
      continue
    }

    if (arg === '--artifacts-dir') {
      artifactsDir = readArgValue(argv, index, arg)
      index += 1
      continue
    }

    if (arg === '--package-kind') {
      const value = readArgValue(argv, index, arg)
      if (value === 'auto' || value === 'dir' || value === 'release') {
        packageKind = value
      } else {
        throw new Error(`Unsupported --package-kind value: ${value}. Expected auto|dir|release.\n${usage()}`)
      }
      index += 1
      continue
    }

    if (arg === '--require-macos-gatekeeper') {
      requireMacosGatekeeper = true
      continue
    }
  }

  if (!platform) {
    throw new Error(`Missing required --platform <macos|windows|linux>\n${usage()}`)
  }

  return {
    platform,
    artifactsDir,
    requireMacosGatekeeper,
    packageKind,
  }
}

function detectHostPlatform() {
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'linux') return 'linux'
  return process.platform
}

function readDesktopMetadata(rootDir: string): DesktopMetadata {
  const packageJsonPath = join(rootDir, 'desktop', 'package.json')
  const raw = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    version?: string
    productName?: string
    build?: { productName?: string }
    name?: string
  }

  return {
    productName: raw.build?.productName ?? raw.productName ?? raw.name ?? 'app',
    version: raw.version ?? 'unknown',
  }
}

function toRelative(rootDir: string, targetPath: string) {
  return relative(rootDir, targetPath) || '.'
}

function normalizePath(targetPath: string) {
  return targetPath.replaceAll('\\', '/')
}

function walkPaths(rootDir: string, options?: { directoriesOnly?: boolean }) {
  if (!existsSync(rootDir)) {
    return [] as string[]
  }

  const results: string[] = []
  const stack = [rootDir]

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue

    let entries: ReturnType<typeof readdirSync> = []
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const fullPath = join(current, entry.name)
      if (entry.isDirectory()) {
        results.push(fullPath)
        stack.push(fullPath)
      } else if (!options?.directoriesOnly) {
        results.push(fullPath)
      }
    }
  }

  return results
}

function findMatches(rootDir: string, matcher: (candidate: string) => boolean, options?: { directoriesOnly?: boolean }) {
  return walkPaths(rootDir, options).filter(matcher).sort()
}

function addPresenceCheck(
  report: PackageSmokeReport,
  rootDir: string,
  label: string,
  targetPath: string,
) {
  const record = {
    label,
    path: toRelative(rootDir, targetPath),
  }

  if (existsSync(targetPath)) {
    report.passedChecks.push(record)
  } else {
    report.missingChecks.push(record)
  }
}

function addMatchCheck(
  report: PackageSmokeReport,
  rootDir: string,
  label: string,
  matches: string[],
  fallbackPath: string,
) {
  if (matches.length > 0) {
    report.passedChecks.push({
      label,
      path: toRelative(rootDir, matches[0]),
    })
    return
  }

  report.missingChecks.push({
    label,
    path: toRelative(rootDir, fallbackPath),
  })
}

function parseUpdateMetadataReferences(content: string) {
  const references = [] as string[]
  const pattern = /^\s*(?:url|path):\s*['"]?([^'"\n]+?)['"]?\s*$/gm
  let match: RegExpExecArray | null
  while ((match = pattern.exec(content))) {
    const value = match[1]?.trim()
    if (!value || value.includes('://')) continue
    references.push(value)
  }
  return references
}

function addUpdateMetadataChecks(
  report: PackageSmokeReport,
  rootDir: string,
  metadataFiles: string[],
) {
  for (const metadataFile of metadataFiles) {
    report.optionalArtifacts.push({
      label: 'update metadata',
      path: toRelative(rootDir, metadataFile),
    })

    const metadataDir = dirname(metadataFile)
    const references = parseUpdateMetadataReferences(readFileSync(metadataFile, 'utf8'))
    for (const reference of references) {
      const decodedReference = decodeURIComponent(reference)
      addPresenceCheck(
        report,
        rootDir,
        `update metadata referenced artifact (${reference})`,
        join(metadataDir, decodedReference),
      )
    }
  }
}

function addBlockmapChecks(
  report: PackageSmokeReport,
  rootDir: string,
  labelPrefix: string,
  artifacts: string[],
) {
  for (const artifact of artifacts) {
    addPresenceCheck(
      report,
      rootDir,
      `${labelPrefix} blockmap (${relative(dirname(artifact), artifact)})`,
      `${artifact}.blockmap`,
    )
  }
}

function findLinuxUnpackedDir(artifactsDir: string) {
  const unpackedDirs = findMatches(
    artifactsDir,
    (candidate) => /\/linux(?:-[a-z0-9_]+)?-unpacked$/.test(normalizePath(candidate)),
    { directoriesOnly: true },
  )

  return unpackedDirs.sort((left, right) => {
    const leftName = normalizePath(left).split('/').pop()
    const rightName = normalizePath(right).split('/').pop()
    if (leftName === 'linux-unpacked') return -1
    if (rightName === 'linux-unpacked') return 1
    return left.localeCompare(right)
  })[0]
}

function firstDiagnosticLine(output: string) {
  return output
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean)
}

function collectDiagnosticLines(output: string, limit = 3) {
  return output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, limit)
}

function defaultCommandRunner(command: string, args: string[]): PackageSmokeCommandResult {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
  })

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function isTooManyOpenFiles(result: PackageSmokeCommandResult) {
  return /Too many open files/i.test(`${result.stdout ?? ''}${result.stderr ?? ''}`)
}

function runMacosGatekeeperAssessment(
  appBundle: string,
  commandRunner: PackageSmokeCommandRunner,
) {
  const initial = commandRunner('/usr/sbin/spctl', ['-a', '-vvv', '-t', 'execute', appBundle])
  if (!isTooManyOpenFiles(initial)) {
    return { result: initial, retriedAfterTooManyOpenFiles: false }
  }

  const retry = commandRunner('/bin/zsh', [
    '-lc',
    `ulimit -n 1048575 2>/dev/null || true; exec /usr/sbin/spctl -a -vvv -t execute ${shellQuote(appBundle)}`,
  ])
  return { result: retry, retriedAfterTooManyOpenFiles: true }
}

function addCommandDiagnostics(
  report: PackageSmokeReport,
  label: string,
  result: PackageSmokeCommandResult,
) {
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const lines = collectDiagnosticLines(output)
  const status = result.status ?? 'unknown'

  if (lines.length === 0) {
    report.notes.push(`${label} exited with status ${status} and produced no diagnostic output.`)
    return
  }

  report.notes.push(`${label} exited with status ${status}: ${lines.join(' | ')}`)
}

function addMacosGatekeeperCheck(
  report: PackageSmokeReport,
  rootDir: string,
  appBundle: string,
  commandRunner: PackageSmokeCommandRunner = defaultCommandRunner,
) {
  if (report.hostPlatform !== 'macos') {
    report.notes.push(`macOS Gatekeeper assessment was requested but skipped because host platform is ${report.hostPlatform}.`)
    return
  }

  const { result, retriedAfterTooManyOpenFiles } = runMacosGatekeeperAssessment(appBundle, commandRunner)
  if (retriedAfterTooManyOpenFiles) {
    report.notes.push('spctl Gatekeeper assessment initially failed with Too many open files; retried with a raised file descriptor limit.')
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const detail = firstDiagnosticLine(output)
  const record = {
    label: detail ? `macOS Gatekeeper launch approval (${detail})` : 'macOS Gatekeeper launch approval',
    path: toRelative(rootDir, appBundle),
  }

  if (result.status === 0) {
    report.passedChecks.push(record)
  } else {
    report.missingChecks.push(record)
    addCommandDiagnostics(report, 'spctl Gatekeeper assessment', result)
    addCommandDiagnostics(
      report,
      'codesign verification',
      commandRunner('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appBundle]),
    )
    addCommandDiagnostics(
      report,
      'codesign signature details',
      commandRunner('/usr/bin/codesign', ['-dv', '--verbose=4', appBundle]),
    )
    addCommandDiagnostics(
      report,
      'notarization ticket validation',
      commandRunner('/usr/bin/xcrun', ['stapler', 'validate', appBundle]),
    )
  }
}

function addInstalledUpdateMetadataCheck(
  report: PackageSmokeReport,
  rootDir: string,
  label: string,
  resourcesDir: string,
  hasReleaseMetadata: boolean,
) {
  if (hasReleaseMetadata) {
    addPresenceCheck(report, rootDir, label, join(resourcesDir, 'app-update.yml'))
  } else {
    report.notes.push(`${label} was not required because no release archive/update metadata was found in this artifact set.`)
  }
}

function createReport(
  rootDir: string,
  platform: PackageSmokePlatform,
  metadata: DesktopMetadata,
  artifactsDir: string,
  verificationMode: VerificationMode,
  packageKind: PackageKind,
  hostPlatform = detectHostPlatform(),
): PackageSmokeReport {
  return {
    platform,
    hostPlatform,
    productName: metadata.productName,
    version: metadata.version,
    verificationMode,
    packageKind,
    artifactsDir,
    packagedArtifacts: [],
    optionalArtifacts: [],
    passedChecks: [],
    missingChecks: [],
    notes: [],
    passed: false,
  }
}

function inspectMacosArtifacts(rootDir: string, report: PackageSmokeReport, options: InspectOptions) {
  const appBundles = findMatches(
    report.artifactsDir,
    (candidate) => {
      const normalized = normalizePath(candidate)
      return normalized.endsWith(`/${report.productName}.app`) && !normalized.includes('/Contents/Frameworks/')
    },
    { directoriesOnly: true },
  )
  const archives = findMatches(report.artifactsDir, (candidate) => candidate.endsWith('.zip') || candidate.endsWith('.dmg'))
  const updateMetadata = findMatches(report.artifactsDir, (candidate) => candidate.endsWith('latest-mac.yml'))
  const releaseMode = report.packageKind === 'release' || (report.packageKind === 'auto' && (archives.length > 0 || updateMetadata.length > 0))

  report.packagedArtifacts.push(...appBundles.map((candidate) => ({
    label: 'macOS app bundle',
    path: toRelative(rootDir, candidate),
  })))
  report.optionalArtifacts.push(...archives.map((candidate) => ({
    label: candidate.endsWith('.dmg') ? 'macOS dmg archive' : 'macOS zip archive',
    path: toRelative(rootDir, candidate),
  })))
  if (releaseMode) {
    addUpdateMetadataChecks(report, rootDir, updateMetadata)
    addBlockmapChecks(report, rootDir, 'macOS update artifact', archives)
  }

  if (appBundles.length === 0) {
    report.missingChecks.push({
      label: 'macOS app bundle',
      path: toRelative(rootDir, join(report.artifactsDir, 'electron')),
    })
    return
  }

  const appBundle = appBundles[0]
  const contentsDir = join(appBundle, 'Contents')
  const resourcesDir = join(contentsDir, 'Resources')
  const unpackedDir = join(resourcesDir, 'app.asar.unpacked')
  const nodePtyDir = join(unpackedDir, 'node_modules', 'node-pty')
  const prebuildsDir = join(nodePtyDir, 'prebuilds')

  addPresenceCheck(report, rootDir, 'macOS Info.plist', join(contentsDir, 'Info.plist'))
  addPresenceCheck(report, rootDir, 'macOS app executable', join(contentsDir, 'MacOS', report.productName))
  addPresenceCheck(report, rootDir, 'macOS app.asar', join(resourcesDir, 'app.asar'))
  addPresenceCheck(report, rootDir, 'macOS unpacked H5 shell', join(unpackedDir, 'dist', 'index.html'))
  addInstalledUpdateMetadataCheck(
    report,
    rootDir,
    'macOS app-update.yml',
    resourcesDir,
    releaseMode,
  )
  addPresenceCheck(report, rootDir, 'macOS node-pty package.json', join(nodePtyDir, 'package.json'))
  addPresenceCheck(
    report,
    rootDir,
    'macOS unpacked cc-haha-builtin plugin seed',
    join(unpackedDir, 'plugin-seed', 'marketplaces', 'cc-haha-builtin', '.claude-plugin', 'marketplace.json'),
  )
  addMatchCheck(
    report,
    rootDir,
    'macOS unpacked sidecar binary',
    findMatches(join(unpackedDir, 'src-tauri', 'binaries'), (candidate) => normalizePath(candidate).includes('/claude-sidecar-')),
    join(unpackedDir, 'src-tauri', 'binaries'),
  )
  addMatchCheck(
    report,
    rootDir,
    'macOS node-pty native module',
    findMatches(prebuildsDir, (candidate) => normalizePath(candidate).includes('/darwin-') && normalizePath(candidate).endsWith('/pty.node')),
    prebuildsDir,
  )
  addMatchCheck(
    report,
    rootDir,
    'macOS node-pty spawn-helper',
    findMatches(prebuildsDir, (candidate) => normalizePath(candidate).includes('/darwin-') && normalizePath(candidate).endsWith('/spawn-helper')),
    prebuildsDir,
  )

  report.notes.push('No GUI launch was attempted. This command only inspects packaged bundle structure and key unpacked resources.')
  if (options.requireMacosGatekeeper) {
    addMacosGatekeeperCheck(report, rootDir, appBundle, options.commandRunner)
  } else if (report.hostPlatform === 'macos') {
    report.notes.push('macOS Gatekeeper launch approval was not assessed. Add --require-macos-gatekeeper for release-readiness launch policy checks.')
  }
  if (report.packageKind === 'dir') {
    report.notes.push('macOS release archive and update metadata checks were skipped for a directory-only development package.')
  } else if (archives.length === 0) {
    report.notes.push('No .zip or .dmg archive was found to record alongside the .app bundle.')
  } else if (updateMetadata.length === 0) {
    report.missingChecks.push({
      label: 'macOS update metadata (latest-mac.yml)',
      path: toRelative(rootDir, join(report.artifactsDir, 'electron', 'latest-mac.yml')),
    })
  }
  if (report.packageKind === 'release' && archives.length === 0) {
    report.missingChecks.push({
      label: 'macOS release archive (.zip or .dmg)',
      path: toRelative(rootDir, report.artifactsDir),
    })
  }
}

function inspectWindowsArtifacts(rootDir: string, report: PackageSmokeReport) {
  const installers = findMatches(report.artifactsDir, (candidate) => {
    const normalized = normalizePath(candidate)
    return normalized.endsWith('.exe') && !normalized.includes('/win-unpacked/')
  })
  const unpackedDir = findMatches(report.artifactsDir, (candidate) => normalizePath(candidate).endsWith('/win-unpacked'), { directoriesOnly: true })[0]
  const electronDir = join(report.artifactsDir, 'electron')
  const updateMetadata = findMatches(report.artifactsDir, (candidate) => candidate.endsWith('latest.yml'))
  const releaseMode = report.packageKind === 'release' || (report.packageKind === 'auto' && (installers.length > 0 || updateMetadata.length > 0))

  report.packagedArtifacts.push(...installers.map((candidate) => ({
    label: 'Windows installer',
    path: toRelative(rootDir, candidate),
  })))
  if (releaseMode) {
    addUpdateMetadataChecks(report, rootDir, updateMetadata)
    addBlockmapChecks(report, rootDir, 'Windows update artifact', installers)
    addMatchCheck(
      report,
      rootDir,
      'windows packaged artifact (.exe installer)',
      installers,
      electronDir,
    )
  } else {
    report.notes.push('Windows installer and update metadata checks were skipped for a directory-only development package.')
  }

  if (unpackedDir) {
    const resourcesDir = join(unpackedDir, 'resources')
    const unpackedResourcesDir = join(resourcesDir, 'app.asar.unpacked')
    const nodePtyDir = join(unpackedResourcesDir, 'node_modules', 'node-pty')
    addPresenceCheck(report, rootDir, 'Windows app.asar', join(resourcesDir, 'app.asar'))
    addInstalledUpdateMetadataCheck(
      report,
      rootDir,
      'Windows app-update.yml',
      resourcesDir,
      releaseMode,
    )
    addPresenceCheck(report, rootDir, 'Windows node-pty package.json', join(nodePtyDir, 'package.json'))
    addPresenceCheck(
      report,
      rootDir,
      'Windows unpacked cc-haha-builtin plugin seed',
      join(unpackedResourcesDir, 'plugin-seed', 'marketplaces', 'cc-haha-builtin', '.claude-plugin', 'marketplace.json'),
    )
    addMatchCheck(
      report,
      rootDir,
      'Windows unpacked sidecar binary',
      findMatches(join(unpackedResourcesDir, 'src-tauri', 'binaries'), (candidate) => normalizePath(candidate).includes('/claude-sidecar-')),
      join(unpackedResourcesDir, 'src-tauri', 'binaries'),
    )
    addMatchCheck(
      report,
      rootDir,
      'Windows node-pty native module',
      findMatches(join(nodePtyDir, 'prebuilds'), (candidate) => normalizePath(candidate).includes('/win32-') && normalizePath(candidate).endsWith('/pty.node')),
      join(nodePtyDir, 'prebuilds'),
    )
  } else {
    report.missingChecks.push({
      label: 'Windows unpacked directory (win-unpacked) for static resource inspection',
      path: toRelative(rootDir, join(electronDir, 'win-unpacked')),
    })
  }

  report.notes.push('This is a static artifact check only. It does not claim installer execution or app launch success.')
  if (releaseMode && updateMetadata.length === 0) {
    report.missingChecks.push({
      label: 'Windows update metadata (latest.yml)',
      path: toRelative(rootDir, join(electronDir, 'latest.yml')),
    })
  }
  if (report.hostPlatform !== 'windows') {
    report.notes.push(`Host platform is ${report.hostPlatform}, so Windows verification stayed artifact-only.`)
  }
}

function inspectLinuxArtifacts(rootDir: string, report: PackageSmokeReport) {
  const packagedArtifacts = findMatches(
    report.artifactsDir,
    (candidate) => candidate.endsWith('.AppImage') || candidate.endsWith('.deb'),
  )
  const unpackedDir = findLinuxUnpackedDir(report.artifactsDir)
  const updateMetadata = findMatches(report.artifactsDir, (candidate) => /latest-linux(?:-[a-z0-9]+)?\.yml$/.test(candidate))
  const appImageBlockmaps = findMatches(report.artifactsDir, (candidate) => candidate.endsWith('.AppImage.blockmap'))
  const releaseMode = report.packageKind === 'release' || (report.packageKind === 'auto' && (packagedArtifacts.length > 0 || updateMetadata.length > 0))

  report.packagedArtifacts.push(...packagedArtifacts.map((candidate) => ({
    label: candidate.endsWith('.deb') ? 'Linux deb package' : 'Linux AppImage',
    path: toRelative(rootDir, candidate),
  })))
  report.optionalArtifacts.push(...appImageBlockmaps.map((candidate) => ({
    label: 'Linux AppImage blockmap',
    path: toRelative(rootDir, candidate),
  })))
  if (releaseMode) {
    addUpdateMetadataChecks(report, rootDir, updateMetadata)
    if (appImageBlockmaps.length === 0 && packagedArtifacts.some(candidate => candidate.endsWith('.AppImage'))) {
      report.notes.push('Linux AppImage blockmaps were not required because Electron Builder did not emit them for this artifact set.')
    }
  }

  if (releaseMode) {
    addMatchCheck(
      report,
      rootDir,
      'linux packaged artifact (.AppImage or .deb)',
      packagedArtifacts,
      report.artifactsDir,
    )
  } else if (!unpackedDir) {
    report.missingChecks.push({
      label: 'linux packaged artifact (.AppImage or .deb)',
      path: toRelative(rootDir, report.artifactsDir),
    })
  } else {
    report.notes.push('No .AppImage or .deb was found; treating linux-unpacked as a directory-only development package.')
  }

  if (unpackedDir) {
    const resourcesDir = join(unpackedDir, 'resources')
    const unpackedResourcesDir = join(resourcesDir, 'app.asar.unpacked')
    const nodePtyDir = join(unpackedResourcesDir, 'node_modules', 'node-pty')
    addPresenceCheck(report, rootDir, 'Linux app.asar', join(resourcesDir, 'app.asar'))
    addInstalledUpdateMetadataCheck(
      report,
      rootDir,
      'Linux app-update.yml',
      resourcesDir,
      releaseMode,
    )
    addPresenceCheck(report, rootDir, 'Linux node-pty package.json', join(nodePtyDir, 'package.json'))
    addPresenceCheck(
      report,
      rootDir,
      'Linux unpacked cc-haha-builtin plugin seed',
      join(unpackedResourcesDir, 'plugin-seed', 'marketplaces', 'cc-haha-builtin', '.claude-plugin', 'marketplace.json'),
    )
    addMatchCheck(
      report,
      rootDir,
      'Linux unpacked sidecar binary',
      findMatches(join(unpackedResourcesDir, 'src-tauri', 'binaries'), (candidate) => normalizePath(candidate).includes('/claude-sidecar-')),
      join(unpackedResourcesDir, 'src-tauri', 'binaries'),
    )
    addMatchCheck(
      report,
      rootDir,
      'Linux node-pty native module',
      findMatches(nodePtyDir, (candidate) => normalizePath(candidate).endsWith('/pty.node') && (normalizePath(candidate).includes('/linux-') || normalizePath(candidate).includes('/Release/'))),
      nodePtyDir,
    )
  } else {
    if (releaseMode) {
      report.missingChecks.push({
        label: 'Linux unpacked directory (linux-unpacked or linux-*-unpacked) for static resource inspection',
        path: toRelative(rootDir, join(report.artifactsDir, 'linux-unpacked')),
      })
    } else {
      report.notes.push('linux-unpacked was not found, so this check only verified packaged artifact presence.')
    }
  }

  report.notes.push('This is a static artifact check only. It does not claim installer execution or app launch success.')
  if (releaseMode && updateMetadata.length === 0) {
    report.missingChecks.push({
      label: 'Linux update metadata (latest-linux*.yml)',
      path: toRelative(rootDir, join(report.artifactsDir, 'latest-linux.yml')),
    })
  }
  if (report.hostPlatform !== 'linux') {
    report.notes.push(`Host platform is ${report.hostPlatform}, so Linux verification stayed artifact-only.`)
  }
}

export async function inspectPackagedArtifacts(rootDir: string, options: InspectOptions): Promise<PackageSmokeReport> {
  const resolvedRootDir = resolve(rootDir)
  const artifactsDir = options.artifactsDir
    ? resolve(resolvedRootDir, options.artifactsDir)
    : join(resolvedRootDir, 'desktop', 'build-artifacts')
  const metadata = readDesktopMetadata(resolvedRootDir)
  const verificationMode = options.platform === 'macos' ? 'bundle-structure' : 'static-artifact'
  const packageKind = options.packageKind ?? 'auto'
  const report = createReport(
    resolvedRootDir,
    options.platform,
    metadata,
    artifactsDir,
    verificationMode,
    packageKind,
    options.hostPlatform,
  )

  if (options.platform === 'macos') {
    inspectMacosArtifacts(resolvedRootDir, report, options)
  } else if (options.platform === 'windows') {
    inspectWindowsArtifacts(resolvedRootDir, report)
  } else {
    inspectLinuxArtifacts(resolvedRootDir, report)
  }

  report.passed = report.missingChecks.length === 0
  return report
}

function printRecord(prefix: string, record: CheckRecord) {
  console.log(`${prefix} ${record.label}: ${record.path}`)
}

function printReport(report: PackageSmokeReport) {
  console.log(`[package-smoke] platform=${report.platform} host=${report.hostPlatform} mode=${report.verificationMode}`)
  console.log(`[package-smoke] packageKind=${report.packageKind}`)
  console.log(`[package-smoke] product=${report.productName} version=${report.version}`)
  console.log(`[package-smoke] artifactsDir=${report.artifactsDir}`)

  if (report.packagedArtifacts.length > 0) {
    console.log('[package-smoke] packaged artifacts:')
    for (const artifact of report.packagedArtifacts) {
      printRecord('  -', artifact)
    }
  }

  if (report.optionalArtifacts.length > 0) {
    console.log('[package-smoke] optional artifacts:')
    for (const artifact of report.optionalArtifacts) {
      printRecord('  -', artifact)
    }
  }

  if (report.passedChecks.length > 0) {
    console.log('[package-smoke] passed checks:')
    for (const check of report.passedChecks) {
      printRecord('  -', check)
    }
  }

  if (report.missingChecks.length > 0) {
    console.log('[package-smoke] missing checks:')
    for (const check of report.missingChecks) {
      printRecord('  -', check)
    }
  }

  if (report.notes.length > 0) {
    console.log('[package-smoke] notes:')
    for (const note of report.notes) {
      console.log(`  - ${note}`)
    }
  }

  console.log(`[package-smoke] result=${report.passed ? 'PASS' : 'FAIL'}`)
}

if (import.meta.main) {
  try {
    const args = parsePackageSmokeArgs(process.argv.slice(2))
    const report = await inspectPackagedArtifacts(process.cwd(), args)
    printReport(report)
    process.exit(report.passed ? 0 : 1)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    process.exit(1)
  }
}
