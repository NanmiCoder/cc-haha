#!/usr/bin/env bun

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { createSandboxedTestEnvironment } from '../../pr/test-environment'

export type PackageSmokePlatform = 'macos' | 'windows' | 'linux'
export type PackageSmokeArch = 'x64' | 'arm64'
export type VerificationMode = 'bundle-structure' | 'static-artifact'
export type PackageKind = 'auto' | 'dir' | 'release'

type CheckRecord = {
  label: string
  path: string
}

type InspectOptions = {
  platform: PackageSmokePlatform
  arch?: PackageSmokeArch
  artifactsDir?: string
  requireMacosGatekeeper?: boolean
  packageKind?: PackageKind
  commandRunner?: PackageSmokeCommandRunner
  hostPlatform?: string
  hostArch?: string
}

export type PackageSmokeArgs = {
  platform: PackageSmokePlatform
  arch?: PackageSmokeArch
  artifactsDir?: string
  requireMacosGatekeeper?: boolean
  packageKind?: PackageKind
}

export type PackageSmokeReport = {
  platform: PackageSmokePlatform
  hostPlatform: string
  productName: string
  version: string
  arch?: PackageSmokeArch
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

type PackageSmokeCommandOptions = {
  cwd: string
  env: Record<string, string>
  timeout: number
  maxBuffer: number
}

type PackageSmokeCommandRunner = (command: string, args: string[], options?: PackageSmokeCommandOptions) => PackageSmokeCommandResult

function usage() {
  return 'Usage: bun run test:package-smoke --platform <macos|windows|linux> [--arch <x64|arm64>] [--package-kind <auto|dir|release>] [--artifacts-dir <path>] [--require-macos-gatekeeper]'
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
  let arch: PackageSmokeArch | undefined
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

    if (arg === '--arch') {
      const value = readArgValue(argv, index, arg)
      if (value === 'x64' || value === 'arm64') {
        arch = value
      } else {
        throw new Error(`Unsupported --arch value: ${value}. Expected x64|arm64.\n${usage()}`)
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
    arch,
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

function bundledRipgrepNeedle(platform: PackageSmokePlatform) {
  return platform === 'windows' ? '/rg.exe' : '/rg'
}

function addBundledRipgrepLicenseChecks(
  report: PackageSmokeReport,
  rootDir: string,
  sidecarDir: string,
  platformLabel: string,
) {
  addPresenceCheck(
    report,
    rootDir,
    `${platformLabel} ripgrep build manifest`,
    join(sidecarDir, 'ripgrep-manifest.json'),
  )
  const licensesDir = join(sidecarDir, 'ripgrep-licenses')
  for (const fileName of ['COPYING', 'LICENSE-MIT', 'UNLICENSE']) {
    addPresenceCheck(
      report,
      rootDir,
      `${platformLabel} ripgrep license (${fileName})`,
      join(licensesDir, fileName),
    )
  }
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

type MachOArch = 'arm64' | 'x86_64'

const MACHO_CPU_TYPES: Record<number, MachOArch> = {
  [0x0100000c]: 'arm64',
  [0x01000007]: 'x86_64',
}

export function parseMachOArchitectures(bytes: Uint8Array): MachOArch[] {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buffer.length < 8) return []
  const architectures = new Set<MachOArch>()
  const addCpu = (value: number) => {
    const arch = MACHO_CPU_TYPES[value >>> 0]
    if (arch) architectures.add(arch)
  }

  const littleMagic = buffer.readUInt32LE(0)
  const bigMagic = buffer.readUInt32BE(0)
  if (littleMagic === 0xfeedface || littleMagic === 0xfeedfacf) {
    addCpu(buffer.readUInt32LE(4))
    return [...architectures]
  }
  if (bigMagic === 0xfeedface || bigMagic === 0xfeedfacf) {
    addCpu(buffer.readUInt32BE(4))
    return [...architectures]
  }

  const fat64 = bigMagic === 0xcafebabf || littleMagic === 0xcafebabf
  const fat32 = bigMagic === 0xcafebabe || littleMagic === 0xcafebabe
  if (!fat32 && !fat64) return []
  const bigEndian = bigMagic === 0xcafebabe || bigMagic === 0xcafebabf
  const readU32 = (offset: number) => bigEndian
    ? buffer.readUInt32BE(offset)
    : buffer.readUInt32LE(offset)
  const count = readU32(4)
  const stride = fat64 ? 32 : 20
  for (let index = 0; index < count; index += 1) {
    const offset = 8 + index * stride
    if (offset + 4 > buffer.length) return []
    addCpu(readU32(offset))
  }
  return [...architectures].sort()
}

function decodeMachOVersion(encoded: number): string {
  const major = (encoded >>> 16) & 0xffff
  const minor = (encoded >>> 8) & 0xff
  const patch = encoded & 0xff
  return patch > 0 ? `${major}.${minor}.${patch}` : `${major}.${minor}`
}

function parseThinMachOMinimumVersion(
  buffer: Buffer,
  start: number,
  length: number,
): string | null {
  if (length < 28 || start < 0 || start + length > buffer.length) return null
  const littleMagic = buffer.readUInt32LE(start)
  const bigMagic = buffer.readUInt32BE(start)
  const littleEndian = littleMagic === 0xfeedface || littleMagic === 0xfeedfacf
  const bigEndian = bigMagic === 0xfeedface || bigMagic === 0xfeedfacf
  if (!littleEndian && !bigEndian) return null
  const readU32 = (offset: number) => littleEndian
    ? buffer.readUInt32LE(offset)
    : buffer.readUInt32BE(offset)
  const is64Bit = (littleEndian ? littleMagic : bigMagic) === 0xfeedfacf
  const commandCount = readU32(start + 16)
  let cursor = start + (is64Bit ? 32 : 28)
  const end = start + length
  for (let index = 0; index < commandCount; index += 1) {
    if (cursor + 8 > end) return null
    const command = readU32(cursor)
    const commandSize = readU32(cursor + 4)
    if (commandSize < 8 || cursor + commandSize > end) return null
    if (command === 0x32 && commandSize >= 24) {
      // LC_BUILD_VERSION.minos
      return decodeMachOVersion(readU32(cursor + 12))
    }
    if (command === 0x24 && commandSize >= 16) {
      // Legacy LC_VERSION_MIN_MACOSX.version
      return decodeMachOVersion(readU32(cursor + 8))
    }
    cursor += commandSize
  }
  return null
}

export function parseMachOMinimumMacosVersions(bytes: Uint8Array): string[] {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buffer.length < 8) return []
  const bigMagic = buffer.readUInt32BE(0)
  const fat64 = bigMagic === 0xcafebabf || bigMagic === 0xbfbafeca
  const fat32 = bigMagic === 0xcafebabe || bigMagic === 0xbebafeca
  if (!fat32 && !fat64) {
    const version = parseThinMachOMinimumVersion(buffer, 0, buffer.length)
    return version ? [version] : []
  }

  const bigEndian = bigMagic === 0xcafebabe || bigMagic === 0xcafebabf
  const readU32 = (offset: number) => bigEndian
    ? buffer.readUInt32BE(offset)
    : buffer.readUInt32LE(offset)
  const readU64 = (offset: number) => Number(bigEndian
    ? buffer.readBigUInt64BE(offset)
    : buffer.readBigUInt64LE(offset))
  const count = readU32(4)
  const stride = fat64 ? 32 : 20
  const versions = new Set<string>()
  for (let index = 0; index < count; index += 1) {
    const entry = 8 + index * stride
    if (entry + stride > buffer.length) return []
    const offset = fat64 ? readU64(entry + 8) : readU32(entry + 8)
    const size = fat64 ? readU64(entry + 16) : readU32(entry + 12)
    const version = parseThinMachOMinimumVersion(buffer, offset, size)
    if (!version) return []
    versions.add(version)
  }
  return [...versions].sort()
}

function addExactMachOArchitectureCheck(
  report: PackageSmokeReport,
  rootDir: string,
  label: string,
  targetPath: string,
  expected: MachOArch,
) {
  const record = { label, path: toRelative(rootDir, targetPath) }
  try {
    const actual = parseMachOArchitectures(readFileSync(targetPath))
    if (actual.length === 1 && actual[0] === expected) {
      report.passedChecks.push(record)
      return
    }
    report.notes.push(`${label} expected ${expected}, found ${actual.join(', ') || 'not Mach-O'}.`)
  } catch (error) {
    report.notes.push(`${label} could not be inspected: ${String(error)}`)
  }
  report.missingChecks.push(record)
}

function addHelperMinimumSystemCheck(
  report: PackageSmokeReport,
  rootDir: string,
  infoPlistPath: string,
) {
  const label = 'macOS cu-helper minimum system version (14.4)'
  const record = { label, path: toRelative(rootDir, infoPlistPath) }
  try {
    const plist = readFileSync(infoPlistPath, 'utf8')
    const version = plist.match(
      /<key>LSMinimumSystemVersion<\/key>\s*<string>([^<]+)<\/string>/,
    )?.[1]?.trim()
    if (version === '14.4') {
      report.passedChecks.push(record)
      return
    }
    report.notes.push(`${label} expected 14.4, found ${version ?? 'missing'}.`)
  } catch (error) {
    report.notes.push(`${label} could not be inspected: ${String(error)}`)
  }
  report.missingChecks.push(record)
}

function addHelperMachOMinimumSystemCheck(
  report: PackageSmokeReport,
  rootDir: string,
  helperExecutable: string,
) {
  const label = 'macOS cu-helper Mach-O deployment target (14.4)'
  const record = { label, path: toRelative(rootDir, helperExecutable) }
  try {
    const versions = parseMachOMinimumMacosVersions(readFileSync(helperExecutable))
    if (versions.length > 0 && versions.every(version => version === '14.4')) {
      report.passedChecks.push(record)
      return
    }
    report.notes.push(`${label} expected 14.4, found ${versions.join(', ') || 'missing'}.`)
  } catch (error) {
    report.notes.push(`${label} could not be inspected: ${String(error)}`)
  }
  report.missingChecks.push(record)
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

function defaultCommandRunner(command: string, args: string[], options?: PackageSmokeCommandOptions): PackageSmokeCommandResult {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  })

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.error?.message ?? result.stderr ?? '',
  }
}

function assertCursorResourcesContained(helperApp: string, directory: string) {
  const app = realpathSync(helperApp)
  const pending = [directory]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const target = pending.pop()!
    const canonical = realpathSync(target)
    const withinApp = relative(app, canonical)
    if (isAbsolute(withinApp) || withinApp === '..' || withinApp.startsWith('../')) {
      throw new Error(`cursor resource escapes the helper app: ${target}`)
    }
    if (visited.has(canonical)) continue
    visited.add(canonical)
    const entry = statSync(target)
    if (entry.isDirectory()) pending.push(...readdirSync(target).map(name => join(target, name)))
    else if (!entry.isFile()) throw new Error(`cursor resource is not a regular file: ${target}`)
  }
}

function addMacosCursorResourceCheck(
  report: PackageSmokeReport,
  rootDir: string,
  helperApp: string,
  options: InspectOptions,
) {
  const sequenceRelative = 'Contents/Resources/cu-helper_cc-haha-computer-use.bundle/LensSequence'
  const sourceDirectory = join(helperApp, sequenceRelative)
  const structureLabel = 'macOS cu-helper cursor resource directory'
  const executionLabel = 'macOS relocated cu-helper cursor resource execution'
  const record = { label: executionLabel, path: toRelative(rootDir, helperApp) }
  let probeRoot: string | undefined
  try {
    if (!statSync(sourceDirectory).isDirectory()) throw new Error('LensSequence is not a directory')
    assertCursorResourcesContained(helperApp, sourceDirectory)
    report.passedChecks.push({ label: structureLabel, path: toRelative(rootDir, sourceDirectory) })
  } catch (error) {
    report.missingChecks.push({ label: structureLabel, path: toRelative(rootDir, sourceDirectory) })
    report.notes.push(`${structureLabel} failed: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (report.hostPlatform !== 'macos') {
    report.notes.push(`SKIPPED: ${executionLabel}; host platform is ${report.hostPlatform}.`)
    return
  }
  const hostArch = options.hostArch ?? process.arch
  const hostMachOArch = hostArch === 'x64' ? 'x86_64' : hostArch
  const targetArch = report.arch === 'x64' ? 'x86_64' : report.arch
  if (targetArch && targetArch !== hostMachOArch) {
    report.notes.push(`SKIPPED: ${executionLabel}; target ${targetArch}, host ${hostMachOArch}. Only package structure was checked.`)
    return
  }
  try {
    const inner = 'Contents/MacOS/cc-haha-computer-use'
    const architectures = parseMachOArchitectures(readFileSync(join(helperApp, inner)))
    if (!architectures.includes(hostMachOArch as MachOArch)) {
      if (architectures.length === 0) throw new Error('helper has no recognized Mach-O architecture')
      report.notes.push(`SKIPPED: ${executionLabel}; binary ${architectures.join(',')}, host ${hostMachOArch}. Only package structure was checked.`)
      return
    }
    probeRoot = mkdtempSync(join(tmpdir(), 'cc-haha-packaged-cursor-'))
    const app = join(probeRoot, 'Relocated Helper.app')
    cpSync(helperApp, app, { recursive: true, verbatimSymlinks: true })
    assertCursorResourcesContained(app, join(app, sequenceRelative))
    const expected = realpathSync(join(app, sequenceRelative))
    const home = join(probeRoot, 'home')
    mkdirSync(home)
    const env = createSandboxedTestEnvironment(home, {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin', CFFIXED_USER_HOME: home,
    }, {})
    const result = (options.commandRunner ?? defaultCommandRunner)(join(app, inner), ['--probe-cursor-resources'], {
      cwd: probeRoot, env, timeout: 10_000, maxBuffer: 1024 * 1024,
    })
    if (result.status !== 0) throw new Error(`probe exited with status ${result.status}: ${result.stderr ?? ''}`)
    const resources = JSON.parse(result.stdout ?? '') as Record<string, unknown>
    if (!resources || typeof resources.resourceDirectory !== 'string'
      || !isAbsolute(resources.resourceDirectory)
      || realpathSync(resources.resourceDirectory) !== expected) {
      throw new Error('probe did not load resources from the relocated final package')
    }
    if (!Number.isSafeInteger(resources.frameCount) || (resources.frameCount as number) < 0
      || resources.proceduralFallback !== (resources.frameCount === 0)) {
      throw new Error('probe returned invalid cursor frame/fallback diagnostics')
    }
    report.passedChecks.push(record)
    report.notes.push(`${executionLabel}: executed ${hostMachOArch}, frames=${resources.frameCount}, proceduralFallback=${resources.proceduralFallback}. No GUI or input was requested.`)
  } catch (error) {
    report.missingChecks.push(record)
    report.notes.push(`${executionLabel} failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (probeRoot) rmSync(probeRoot, { recursive: true, force: true })
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

type CodesignMetadata = {
  identifier: string | null
  authority: string | null
  team: string | null
  timestamp: string | null
}

export function parseCodesignMetadata(output: string): CodesignMetadata {
  const first = (prefix: string) => output
    .split(/\r?\n/)
    .find(line => line.startsWith(prefix))
    ?.slice(prefix.length)
    .trim() ?? null
  const team = first('TeamIdentifier=')
  return {
    identifier: first('Identifier='),
    authority: first('Authority='),
    team: team === 'not set' ? null : team,
    timestamp: first('Timestamp='),
  }
}

function addMacosComputerUseAttestationCheck(
  report: PackageSmokeReport,
  rootDir: string,
  appBundle: string,
  sidecar: string,
  helperApp: string,
  commandRunner: PackageSmokeCommandRunner,
) {
  const label = 'macOS Computer Use signing attestation chain'
  const record = { label, path: toRelative(rootDir, helperApp) }
  if (report.hostPlatform !== 'macos') {
    report.notes.push(`${label} was requested but skipped because host platform is ${report.hostPlatform}.`)
    return
  }

  const targets = [
    { name: 'host', path: appBundle, identifier: 'com.claude-code-haha.desktop', deep: true },
    { name: 'sidecar', path: sidecar, identifier: 'com.claude-code-haha.desktop.sidecar', deep: false },
    { name: 'helper', path: helperApp, identifier: 'dev.cchaha.cu-helper', deep: true },
  ] as const
  const metadata: CodesignMetadata[] = []
  for (const target of targets) {
    const verifyArgs = ['--verify', ...(target.deep ? ['--deep'] : []), '--strict', '--verbose=2', target.path]
    const verify = commandRunner('/usr/bin/codesign', verifyArgs)
    if (verify.status !== 0) {
      report.missingChecks.push(record)
      addCommandDiagnostics(report, `${target.name} codesign verification`, verify)
      return
    }
    const details = commandRunner('/usr/bin/codesign', ['-dv', '--verbose=4', target.path])
    if (details.status !== 0) {
      report.missingChecks.push(record)
      addCommandDiagnostics(report, `${target.name} codesign details`, details)
      return
    }
    const parsed = parseCodesignMetadata(`${details.stdout ?? ''}${details.stderr ?? ''}`)
    if (
      parsed.identifier !== target.identifier
      || !parsed.authority?.startsWith('Developer ID Application:')
      || !parsed.team
      || !parsed.timestamp
    ) {
      report.missingChecks.push(record)
      report.notes.push(
        `${label} rejected ${target.name}: identifier=${parsed.identifier ?? 'missing'}, `
        + `authority=${parsed.authority ?? 'missing'}, team=${parsed.team ?? 'missing'}, `
        + `timestamp=${parsed.timestamp ? 'present' : 'missing'}.`,
      )
      return
    }
    metadata.push(parsed)
  }

  if (metadata.length !== targets.length) {
    report.missingChecks.push(record)
    report.notes.push(`${label} could not collect metadata for every required executable.`)
    return
  }
  const [host, sidecarMetadata, helper] = metadata as [
    CodesignMetadata,
    CodesignMetadata,
    CodesignMetadata,
  ]
  if (
    host.authority !== sidecarMetadata.authority
    || host.authority !== helper.authority
    || host.team !== sidecarMetadata.team
    || host.team !== helper.team
  ) {
    report.missingChecks.push(record)
    report.notes.push(`${label} rejected mismatched Developer ID authority/team values.`)
    return
  }
  report.passedChecks.push(record)
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
  arch: PackageSmokeArch | undefined,
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
    arch,
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
  const sidecarDir = join(unpackedDir, 'src-tauri', 'binaries')
  const helperApp = join(sidecarDir, 'cc-haha-computer-use.app')
  const helperInfoPlist = join(helperApp, 'Contents', 'Info.plist')
  const helperExecutable = join(helperApp, 'Contents', 'MacOS', 'cc-haha-computer-use')
  const hostExecutable = join(contentsDir, 'MacOS', report.productName)

  addPresenceCheck(report, rootDir, 'macOS Info.plist', join(contentsDir, 'Info.plist'))
  addPresenceCheck(report, rootDir, 'macOS app executable', hostExecutable)
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
  addPresenceCheck(report, rootDir, 'macOS cu-helper app bundle', helperApp)
  addPresenceCheck(report, rootDir, 'macOS cu-helper Info.plist', helperInfoPlist)
  addPresenceCheck(report, rootDir, 'macOS cu-helper executable', helperExecutable)
  addMacosCursorResourceCheck(report, rootDir, helperApp, options)
  if (existsSync(helperInfoPlist)) addHelperMinimumSystemCheck(report, rootDir, helperInfoPlist)
  addBundledRipgrepLicenseChecks(report, rootDir, sidecarDir, 'macOS')
  addMatchCheck(
    report,
    rootDir,
    'macOS bundled ripgrep binary',
    findMatches(sidecarDir, candidate =>
      normalizePath(candidate).endsWith(bundledRipgrepNeedle('macos'))),
    sidecarDir,
  )
  if (report.arch) {
    const expectedMachOArch: MachOArch = report.arch === 'arm64' ? 'arm64' : 'x86_64'
    const targetTriple = report.arch === 'arm64'
      ? 'aarch64-apple-darwin'
      : 'x86_64-apple-darwin'
    const nodePtyArch = report.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
    const sidecar = join(sidecarDir, `claude-sidecar-${targetTriple}`)
    const pty = join(prebuildsDir, nodePtyArch, 'pty.node')
    const spawnHelper = join(prebuildsDir, nodePtyArch, 'spawn-helper')
    addPresenceCheck(report, rootDir, `macOS ${report.arch} unpacked sidecar binary`, sidecar)
    addPresenceCheck(report, rootDir, `macOS ${report.arch} node-pty native module`, pty)
    addPresenceCheck(report, rootDir, `macOS ${report.arch} node-pty spawn-helper`, spawnHelper)
    if (existsSync(helperExecutable)) {
      addHelperMachOMinimumSystemCheck(report, rootDir, helperExecutable)
    }
    for (const [label, target] of [
      ['app executable', hostExecutable],
      ['sidecar', sidecar],
      ['cu-helper', helperExecutable],
      ['node-pty native module', pty],
      ['node-pty spawn-helper', spawnHelper],
    ] as const) {
      if (existsSync(target)) {
        addExactMachOArchitectureCheck(
          report,
          rootDir,
          `macOS ${report.arch} ${label} Mach-O architecture`,
          target,
          expectedMachOArch,
        )
      }
    }
  } else {
    addMatchCheck(
      report,
      rootDir,
      'macOS unpacked sidecar binary',
      findMatches(sidecarDir, (candidate) => normalizePath(candidate).includes('/claude-sidecar-')),
      sidecarDir,
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
  }

  report.notes.push('No GUI launch was attempted. Matching macOS helper architectures also run an input-free resource probe from a disposable copy of the final package.')
  if (options.requireMacosGatekeeper) {
    if (report.arch) {
      const targetTriple = report.arch === 'arm64'
        ? 'aarch64-apple-darwin'
        : 'x86_64-apple-darwin'
      addMacosComputerUseAttestationCheck(
        report,
        rootDir,
        appBundle,
        join(sidecarDir, `claude-sidecar-${targetTriple}`),
        helperApp,
        options.commandRunner ?? defaultCommandRunner,
      )
    }
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
    return normalized.endsWith('.exe') && !isInsideWindowsUnpackedDir(normalized)
  })
  const unpackedDir = findWindowsUnpackedDir(report.artifactsDir, report.arch)
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
    const sidecarDir = join(unpackedResourcesDir, 'src-tauri', 'binaries')
    const sidecarNeedle = report.arch === 'arm64'
      ? '/claude-sidecar-aarch64-pc-windows-msvc.exe'
      : report.arch === 'x64'
        ? '/claude-sidecar-x86_64-pc-windows-msvc.exe'
        : '/claude-sidecar-'
    const nodePtyNeedle = report.arch === 'arm64'
      ? '/win32-arm64/'
      : report.arch === 'x64'
        ? '/win32-x64/'
        : '/win32-'
    addPresenceCheck(report, rootDir, 'Windows app.asar', join(resourcesDir, 'app.asar'))
    addInstalledUpdateMetadataCheck(
      report,
      rootDir,
      'Windows app-update.yml',
      resourcesDir,
      releaseMode,
    )
    addPresenceCheck(report, rootDir, 'Windows node-pty package.json', join(nodePtyDir, 'package.json'))
    addMatchCheck(
      report,
      rootDir,
      report.arch ? `Windows ${report.arch} unpacked sidecar binary` : 'Windows unpacked sidecar binary',
      findMatches(sidecarDir, (candidate) => normalizePath(candidate).includes(sidecarNeedle)),
      report.arch
        ? join(sidecarDir, sidecarNeedle.slice(1))
        : sidecarDir,
    )
    addMatchCheck(
      report,
      rootDir,
      report.arch ? `Windows ${report.arch} bundled ripgrep binary` : 'Windows bundled ripgrep binary',
      findMatches(sidecarDir, candidate =>
        normalizePath(candidate).endsWith(bundledRipgrepNeedle('windows'))),
      sidecarDir,
    )
    addBundledRipgrepLicenseChecks(report, rootDir, sidecarDir, 'Windows')
    addMatchCheck(
      report,
      rootDir,
      report.arch ? `Windows ${report.arch} node-pty native module` : 'Windows node-pty native module',
      findMatches(join(nodePtyDir, 'prebuilds'), (candidate) => normalizePath(candidate).includes(nodePtyNeedle) && normalizePath(candidate).endsWith('/pty.node')),
      join(nodePtyDir, 'prebuilds'),
    )
  } else {
    report.missingChecks.push({
      label: 'Windows unpacked directory for static resource inspection',
      path: toRelative(rootDir, join(electronDir, report.arch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked')),
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

function isWindowsUnpackedDirPath(candidate: string): boolean {
  return /\/win(?:-[a-z0-9_]+)?-unpacked$/.test(normalizePath(candidate))
}

function isInsideWindowsUnpackedDir(candidate: string): boolean {
  return /\/win(?:-[a-z0-9_]+)?-unpacked\//.test(normalizePath(candidate))
}

function findWindowsUnpackedDir(artifactsDir: string, arch?: 'x64' | 'arm64'): string | undefined {
  const unpackedDirs = findMatches(
    artifactsDir,
    isWindowsUnpackedDirPath,
    { directoriesOnly: true },
  )
  if (arch === 'arm64') {
    return unpackedDirs.find((candidate) => normalizePath(candidate).endsWith('/win-arm64-unpacked')) ?? unpackedDirs[0]
  }
  if (arch === 'x64') {
    return unpackedDirs.find((candidate) => normalizePath(candidate).endsWith('/win-unpacked')) ?? unpackedDirs[0]
  }
  return unpackedDirs[0]
}

function inspectLinuxArtifacts(rootDir: string, report: PackageSmokeReport) {
  const packagedArtifacts = findMatches(
    report.artifactsDir,
    (candidate) => candidate.endsWith('.AppImage')
      || candidate.endsWith('.deb')
      || candidate.endsWith('.rpm'),
  )
  const unpackedDir = findLinuxUnpackedDir(report.artifactsDir)
  const updateMetadata = findMatches(report.artifactsDir, (candidate) => /latest-linux(?:-[a-z0-9]+)?\.yml$/.test(candidate))
  const appImageBlockmaps = findMatches(report.artifactsDir, (candidate) => candidate.endsWith('.AppImage.blockmap'))
  const releaseMode = report.packageKind === 'release' || (report.packageKind === 'auto' && (packagedArtifacts.length > 0 || updateMetadata.length > 0))

  report.packagedArtifacts.push(...packagedArtifacts.map((candidate) => ({
    label: candidate.endsWith('.deb')
      ? 'Linux deb package'
      : candidate.endsWith('.rpm')
        ? 'Linux RPM package'
        : 'Linux AppImage',
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
      'linux packaged artifact (.AppImage, .deb, or .rpm)',
      packagedArtifacts,
      report.artifactsDir,
    )
  } else if (!unpackedDir) {
    report.missingChecks.push({
      label: 'linux packaged artifact (.AppImage, .deb, or .rpm)',
      path: toRelative(rootDir, report.artifactsDir),
    })
  } else {
    report.notes.push('No .AppImage, .deb, or .rpm was found; treating linux-unpacked as a directory-only development package.')
  }

  if (unpackedDir) {
    const resourcesDir = join(unpackedDir, 'resources')
    const unpackedResourcesDir = join(resourcesDir, 'app.asar.unpacked')
    const nodePtyDir = join(unpackedResourcesDir, 'node_modules', 'node-pty')
    const sidecarDir = join(unpackedResourcesDir, 'src-tauri', 'binaries')
    addPresenceCheck(report, rootDir, 'Linux app.asar', join(resourcesDir, 'app.asar'))
    addInstalledUpdateMetadataCheck(
      report,
      rootDir,
      'Linux app-update.yml',
      resourcesDir,
      releaseMode,
    )
    addPresenceCheck(report, rootDir, 'Linux node-pty package.json', join(nodePtyDir, 'package.json'))
    addMatchCheck(
      report,
      rootDir,
      'Linux unpacked sidecar binary',
      findMatches(sidecarDir, (candidate) => normalizePath(candidate).includes('/claude-sidecar-')),
      sidecarDir,
    )
    addBundledRipgrepLicenseChecks(report, rootDir, sidecarDir, 'Linux')
    addMatchCheck(
      report,
      rootDir,
      'Linux bundled ripgrep binary',
      findMatches(sidecarDir, candidate =>
        normalizePath(candidate).endsWith(bundledRipgrepNeedle('linux'))),
      sidecarDir,
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
    options.arch,
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
  if (report.arch) {
    console.log(`[package-smoke] arch=${report.arch}`)
  }
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
