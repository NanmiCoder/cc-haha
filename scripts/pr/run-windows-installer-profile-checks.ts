#!/usr/bin/env bun

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isScalar, parseDocument } from 'yaml'
import { assertOutsideSourceGit, isInsideDirectory, sha256File } from './prepare-windows-installer-tests'
import { createSandboxedTestEnvironment } from './test-environment'

export const profileFixtureSources = [
  'scripts/pr/windows-installer-profile-fixture.cs',
  'scripts/pr/windows-installer-profile-native.cs',
  'scripts/pr/windows-installer-profile-fixture-tests.cs',
] as const

export const profileOnlyPacketSources = [
  'preflight.ps1',
  'fixtures/launch-profile-only.proposed.ps1',
  'fixtures/reconcile-profile-only.proposed.ps1',
  'fixtures/pins.proposed.json',
  'fixtures/profile-only-spec.proposed.json',
  'fixtures/root-admission.proposed.json',
  'fixtures/argv-env-plan.json',
] as const

const preflightChecks = [
  'packet-explicitly-unadmitted',
  ...['launch-profile-only.proposed.ps1', 'reconcile-profile-only.proposed.ps1'].flatMap(name =>
    ['parse', 'no-automatic-variable-assignment', 'default', 'pending-denial', 'one-embedded-source', 'compile'].map(check => `${check}-${name}`)),
  'atomic-private-root-acl', 'existing-root-rejected', 'readonly-allow-synchronize-roundtrip',
  'readonly-extra-write-rejected', 'readonly-extra-principal-rejected', 'packet-source-unchanged',
] as const

export function validateProfileOnlyPreflightResult(value: unknown) {
  const report = value as Record<string, unknown> | null
  const checks = report?.checks as Array<{ name: string; status: string }> | undefined
  if (!report || report.version !== 1 || report.mode !== 'profile-only-preflight' || report.status !== 'passed' ||
      report.engine !== 'WindowsPowerShell5.1-Desktop' || report.realAccountsCreated !== 0 || report.realProfilesCreated !== 0 ||
      report.releasedPeExecuted !== false || report.releasedPeMayHaveExecuted !== false || report.compatibilityEnabled !== false ||
      report.oldExit22Policy !== 'fatal' || report.cleanup !== 'passed' || report.packetUnchanged !== true ||
      !Array.isArray(checks) || checks.length !== preflightChecks.length ||
      checks.some(check => !check || check.status !== 'passed') ||
      preflightChecks.some(name => checks.filter(check => check.name === name).length !== 1)) {
    throw new Error('Invalid profile-only PowerShell preflight result or forbidden live effect')
  }
  return report
}

const evidenceFields = ['member_proven', 'installed_bytes_equal', 'old22_before_protected_mutation', 'removal_equivalence', 'full_old_to_new'] as const
type StageAMode = 'self-test' | 'abi-harness'
type CommandResult = { exitCode: number; stdout: string; stderr: string; timedOut?: boolean; outputLimitExceeded?: boolean }
type FixtureRunner = (command: string[], options: { cwd: string; env: Record<string, string>; timeoutMs: number }) => Promise<CommandResult>

export function validateStageAResult(value: unknown, mode: StageAMode) {
  const report = value as Record<string, unknown> | null
  if (!report || report.version !== 1 || report.mode !== mode || report.status !== 'passed' ||
      report.realAccountsCreated !== 0 || report.realProfilesCreated !== 0 || report.releasedPeExecuted !== false ||
      report.releasedPeMayHaveExecuted !== false || report.releasedPeExecutionStatus !== 'not_run' ||
      report.compatibilityEnabled !== false || report.oldExit22Policy !== 'fatal') {
    throw new Error(`Invalid ${mode} result or forbidden Stage B side effect`)
  }
  if (!Array.isArray(report.checks) || report.checks.length === 0 || report.checks.some(check =>
    !check || typeof check.name !== 'string' || !check.name || check.status !== 'passed')) {
    throw new Error(`${mode} must report nonempty passing checks, not only exit 0`)
  }
  if (evidenceFields.some(field => report[field] !== 'not_run')) {
    throw new Error('Stage A cannot promote any native profile evidence')
  }
  if (mode === 'abi-harness' && report.cleanup !== 'passed') throw new Error('Owned ABI cleanup was not proven successful')
  return report
}


const canaryOutputLimit = 65_536
const canaryReportLimit = 1_000_000
class CanaryEvidenceSafetyError extends Error {}
const safeObject = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
function knownKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new CanaryEvidenceSafetyError('Unsafe canary evidence shape')
}
const unsigned = (value: unknown, max = Number.MAX_SAFE_INTEGER) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max
const guid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const provider = '(?:edd08927-9cc4-4e65-b970-c2560fb5c289|70eb4f03-c1de-4f73-a051-33d13d5413bd)'
const schemaCount = new RegExp(`^${provider}/[0-9]{1,5}/[0-9]{1,3} count=[0-9]{1,6}$`)
const schemaShape = new RegExp(`^${provider}/[0-9]{1,5}/[0-9]{1,3} [A-Za-z_][A-Za-z0-9_]{0,255}:type=[0-9]{1,5},flags=[0-9]{1,10},count=[0-9]{1,5},length=[0-9]{1,5}(?:;[A-Za-z_][A-Za-z0-9_]{0,255}:type=[0-9]{1,5},flags=[0-9]{1,10},count=[0-9]{1,5},length=[0-9]{1,5})*$`)

/** Accept only this owned metadata producer's schema, never value payloads or F1 claims. */
export function validateF1NativeCanaryResult(value: unknown, binarySha256: string) {
  let retainedHandle: bigint | undefined
  if (typeof value === 'string') {
    try {
      const text = value.replace(/^\uFEFF/, '')
      value = JSON.parse(text)
      const document = parseDocument(text, { schema: 'json', intAsBigInt: true, uniqueKeys: true, strict: true, prettyErrors: false })
      if (document.errors.length) throw new Error('invalid JSON keys')
      const token = document.getIn(['f1NativeCanary', 'retainedHandle'], true)
      if (token !== undefined) {
        if (!isScalar(token) || typeof token.value !== 'bigint' || typeof token.source !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/.test(token.source)) throw new Error('invalid UInt64 token')
        retainedHandle = BigInt(token.source)
        if (retainedHandle > 18_446_744_073_709_551_615n) throw new Error('UInt64 overflow')
      }
    } catch { throw new CanaryEvidenceSafetyError('Invalid canary JSON or UInt64 remains private') }
  }
  if (!safeObject(value)) throw new CanaryEvidenceSafetyError('Invalid canary report')
  knownKeys(value, ['version', 'mode', 'status', 'checks', 'f1NativeCanary', 'realAccountsCreated', 'realProfilesCreated',
    'releasedPeExecuted', 'releasedPeMayHaveExecuted', 'releasedPeExecutionStatus', 'compatibilityEnabled', 'oldExit22Policy',
    ...evidenceFields, 'binarySha256', 'specSha256', 'startedAtUtc', 'finishedAtUtc', 'failedStage', 'cleanup', 'trace', 'phases', 'observations', 'evidenceFiles'])
  if (value.version !== 1 || value.mode !== 'f1-native-zero-account' || !['passed', 'failed'].includes(String(value.status)) ||
      value.binarySha256 !== binarySha256 || !['passed', 'unknown'].includes(String(value.cleanup)) ||
      value.realAccountsCreated !== 0 || value.realProfilesCreated !== 0 || value.releasedPeExecuted !== false ||
      value.releasedPeMayHaveExecuted !== false || value.releasedPeExecutionStatus !== 'not_run' ||
      value.compatibilityEnabled !== false || value.oldExit22Policy !== 'fatal' || evidenceFields.some(field => value[field] !== 'not_run') ||
      !Array.isArray(value.phases) || value.phases.length !== 0 || !Array.isArray(value.observations) || value.observations.length !== 0 ||
      !safeObject(value.evidenceFiles) || Object.keys(value.evidenceFiles).length !== 0 || value.specSha256 != null || value.failedStage != null ||
      !['startedAtUtc', 'finishedAtUtc'].every(key => typeof value[key] === 'string' && /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(value[key] as string))) {
    throw new CanaryEvidenceSafetyError('Invalid canary identity or forbidden account/profile/product effect')
  }
  const successDetail = 'Runtime observations only; provider scope support, complete lifecycle/namespace and F1 remain not_proven.'
  if (!Array.isArray(value.checks) || value.checks.length < 1 || value.checks.length > 8 || value.checks.some(check => {
    if (!safeObject(check)) return true
    knownKeys(check, ['name', 'status', 'detail'])
    return !['f1-real-debug-pump-and-owned-metadata', 'f1-zero-account-native', 'f1-canary-cleanup', 'fixture-entry'].includes(String(check.name)) ||
      !['passed', 'failed'].includes(String(check.status)) || typeof check.detail !== 'string' || check.detail.length > 256 ||
      !(check.detail === successDetail || /^f1-[a-z0-9-]+$/.test(check.detail) || /^Native operation failed \([A-Za-z0-9 ._-]{1,160}\)$/.test(check.detail) ||
        /^[A-Za-z][A-Za-z0-9 _-]{0,95} failed \((?:Win32|NET_API_STATUS) [0-9]{1,10}\)$/.test(check.detail))
  })) throw new CanaryEvidenceSafetyError('Unsafe canary diagnostics')
  if (!Array.isArray(value.trace) || value.trace.length > 128 || value.trace.some(row => typeof row !== 'string' || row.length > 512 ||
      !(schemaCount.test(row) || /^native-metadata-owned=[0-9]+;other-headers=[0-9]+;unknown=[0-9]+;file-writes=[0-9]+;registry-sets=[0-9]+$/.test(row)))) {
    throw new CanaryEvidenceSafetyError('Unsafe canary metadata trace')
  }
  if (value.f1NativeCanary != null) {
    const native = value.f1NativeCanary
    if (!safeObject(native)) throw new CanaryEvidenceSafetyError('Invalid native observation')
    const booleans = ['startAttempted', 'started', 'stopAttempted', 'stopped', 'consumerDrained', 'closed', 'gap', 'childResumeAttempted', 'childResumed', 'childExited']
    const counters = ['ownedRecords', 'otherHeaders', 'unknownRecords', 'mappedFileWrites', 'mappedRegistrySets', 'childPid']
    knownKeys(native, ['status', 'F1', 'scopeSupport', 'name', 'guid', 'retainedHandle', ...booleans, 'eventsLost', 'buffersLost',
      'processTraceResult', 'fileEnableCode', 'registryEnableCode', ...counters, 'childCreationTime', 'nativeSchemaShapes'])
    const exactHandle = retainedHandle ?? (unsigned(native.retainedHandle) ? BigInt(native.retainedHandle as number) : undefined)
    if (native.status !== 'not_proven' || native.F1 !== 'not_proven' || native.scopeSupport !== 'not_proven' ||
        typeof native.name !== 'string' || !new RegExp(`^CcHaha1879-F1-${guid}$`).test(native.name) ||
        typeof native.guid !== 'string' || !new RegExp(`^${guid}$`).test(native.guid) || exactHandle === undefined || exactHandle < 0n || exactHandle > 18_446_744_073_709_551_615n ||
        booleans.some(key => typeof native[key] !== 'boolean') || counters.some(key => !unsigned(native[key])) ||
        ['eventsLost', 'buffersLost', 'processTraceResult', 'fileEnableCode', 'registryEnableCode'].some(key => native[key] !== null && !unsigned(native[key], 0xffffffff * 2)) ||
        (native.childCreationTime !== null && (typeof native.childCreationTime !== 'string' || !/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(native.childCreationTime))) ||
        !Array.isArray(native.nativeSchemaShapes) || native.nativeSchemaShapes.length > 64 ||
        native.nativeSchemaShapes.some(row => typeof row !== 'string' || row.length > 65_536 || !schemaShape.test(row))) {
      throw new CanaryEvidenceSafetyError('Unsafe or promoted native observation')
    }
  }
  const observation = value.f1NativeCanary as Record<string, unknown> | undefined
  if (value.cleanup === 'passed' && observation && (observation.closed !== true || (observation.childResumeAttempted === true && observation.childExited !== true))) {
    throw new CanaryEvidenceSafetyError('Contradictory canary cleanup success')
  }
  if (value.status === 'passed') {
    const native = value.f1NativeCanary as Record<string, unknown> | undefined
    if (value.cleanup !== 'passed' || value.checks.some(check => (check as Record<string, unknown>).status !== 'passed') || !native ||
        ['startAttempted', 'started', 'stopAttempted', 'stopped', 'consumerDrained', 'closed', 'childResumeAttempted', 'childResumed', 'childExited'].some(key => native[key] !== true) ||
        native.gap !== false || native.eventsLost !== 0 || native.buffersLost !== 0 || native.processTraceResult !== 0 ||
        native.fileEnableCode !== 0 || native.registryEnableCode !== 0 || !unsigned(native.childPid) || native.childPid === 0 ||
        typeof native.childCreationTime !== 'string' || Number(native.mappedFileWrites) < 3 || Number(native.mappedRegistrySets) < 3) {
      throw new CanaryEvidenceSafetyError('Contradictory canary producer success')
    }
  }
  return value
}

async function runCanaryCommand(command: string[], options: Parameters<FixtureRunner>[1]): Promise<CommandResult> {
  const child = Bun.spawn(command, { cwd: options.cwd, env: options.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  let timedOut = false
  let outputLimitExceeded = false
  const timer = setTimeout(() => { timedOut = true; child.kill() }, options.timeoutMs)
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        const remaining = canaryOutputLimit - size
        chunks.push(part.value.subarray(0, Math.max(0, remaining)))
        size += part.value.length
        if (size > canaryOutputLimit) { outputLimitExceeded = true; child.kill(); await reader.cancel(); break }
      }
    } finally { reader.releaseLock() }
    return Buffer.concat(chunks).toString('utf8')
  }
  try {
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, read(child.stdout), read(child.stderr)])
    return { exitCode, stdout, stderr, timedOut, outputLimitExceeded }
  } finally { clearTimeout(timer) }
}

function assertRegularFile(file: string, root: string) {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || !isInsideDirectory(root, file)) {
    throw new Error('Fixture file is not an ordinary file inside its owned directory')
  }
}

async function runCommand(command: string[], options: Parameters<FixtureRunner>[1]): Promise<CommandResult> {
  const child = Bun.spawn(command, { cwd: options.cwd, env: options.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill()
  }, options.timeoutMs)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    return { exitCode, stdout, stderr, timedOut }
  } finally {
    clearTimeout(timeout)
  }
}

/** Stage A only: compile reviewed sources and execute fake/owned harnesses. */
export async function runWindowsInstallerProfileChecks(options: {
  platform?: NodeJS.Platform
  sourceRoot?: string
  tempParent?: string
  compiler?: string
  powershell?: string
  run?: FixtureRunner
} = {}) {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    console.log(`[windows-installer-profile] not_run on ${platform}; Windows Stage A must compile and run the real fixture`)
    return { status: 'not_run' as const, exitCode: 0 }
  }
  if (!options.run && process.env.CI !== 'true') throw new Error('Profile fixture checks require a disposable Windows CI runner')
  if (options.compiler && !options.run) throw new Error('A compiler override is only valid with a fake runner')
  if (options.powershell && !options.run) throw new Error('A PowerShell override is only valid with a fake runner')
  const sourceRoot = realpathSync(options.sourceRoot ?? resolve(import.meta.dir, '../..'))
  const tempParent = realpathSync(options.tempParent ?? process.env.RUNNER_TEMP ?? tmpdir())
  assertOutsideSourceGit(tempParent, sourceRoot)
  const compiler = realpathSync(options.compiler ?? join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows',
    'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'))
  if (!lstatSync(compiler).isFile()) throw new Error('The system x64 Framework compiler is missing')
  const powershell = realpathSync(options.powershell ?? join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  if (!lstatSync(powershell).isFile()) throw new Error('The system Windows PowerShell 5.1 is missing')
  const sourceBytes = new Map<string, Buffer>()
  const sources = profileFixtureSources.map(path => {
    const file = join(sourceRoot, path)
    assertRegularFile(file, sourceRoot)
    const bytes = readFileSync(file)
    sourceBytes.set(path, bytes)
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      canonicalSha256: createHash('sha256').update(bytes.toString('utf8').replace(/\r\n/g, '\n')).digest('hex') }
  })
  const sourceSetSha256 = createHash('sha256').update(JSON.stringify(sources.map(({ path, canonicalSha256 }) => ({ path, canonicalSha256 })))).digest('hex')
  const packetSources = profileOnlyPacketSources.map(path => {
    const file = join(sourceRoot, 'scripts/pr/windows-installer-profile-only', path)
    assertRegularFile(file, sourceRoot)
    const bytes = readFileSync(file)
    if (bytes.length > 1_048_576) throw new Error('Profile-only preflight source exceeded its bound')
    sourceBytes.set(path, bytes)
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  })
  const sandbox = mkdtempSync(join(tempParent, 'cc-haha-profile-stage-a-'))
  assertOutsideSourceGit(sandbox, sourceRoot)
  const executable = join(sandbox, 'profile-fixture.exe')
  const evidenceRoot = join(sourceRoot, 'artifacts/windows-installer/profile-stage-a')
  mkdirSync(evidenceRoot, { recursive: true })
  const runner = options.run ?? runCommand
  const env = createSandboxedTestEnvironment(join(sandbox, 'home'))
  const commands: Array<Record<string, unknown>> = []
  const report: Record<string, unknown> = {
    version: 1, stage: 'A', status: 'failed', platform, sourceRoot, sources, sourceSetSha256,
    runner: options.run ? 'test-double' : 'native-windows-system-compiler',
    compiler, compilerSha256: await sha256File(compiler), powershell, packetSources, temporaryRoot: sandbox,
    realAccountsCreated: 'not_proven', realProfilesCreated: 'not_proven', releasedPeExecuted: 'not_proven',
    releasedPeMayHaveExecuted: 'not_proven', releasedPeExecutionStatus: 'not_proven',
    compatibilityEnabled: false, oldExit22Policy: 'fatal',
    ...Object.fromEntries(evidenceFields.map(field => [field, 'not_run'])), commands,
  }
  let exitCode = 1
  let retainSandbox = false
  try {
    const sourceCopies = profileFixtureSources.map(path => {
      const file = join(sandbox, path.split('/').at(-1)!)
      writeFileSync(file, sourceBytes.get(path)!)
      return file
    })
    const compileCommand = [compiler, '/nologo', '/target:exe', '/platform:x64', '/optimize+',
      `/out:${executable}`, '/r:System.Management.dll', '/r:System.Runtime.Serialization.dll', '/r:System.Security.dll',
      ...sourceCopies]
    const invoke = async (name: string, command: string[], timeoutMs: number) => {
      const startedAtUtc = new Date().toISOString()
      const result = await runner(command, { cwd: sandbox, env, timeoutMs })
      commands.push({ name, command, timeoutMs, startedAtUtc, finishedAtUtc: new Date().toISOString(), ...result })
      writeFileSync(join(evidenceRoot, `${name}.log`), `${result.stdout}\n${result.stderr}`)
      if (result.timedOut || result.exitCode !== 0) throw new Error(`${name} failed${result.timedOut ? ' (timeout)' : ` (exit ${result.exitCode})`}`)
    }
    await invoke('compile', compileCommand, 45_000)
    assertRegularFile(executable, sandbox)
    if (readFileSync(executable).subarray(0, 2).toString('ascii') !== 'MZ') throw new Error('Compiler returned success without a fixture PE')
    report.executableSha256 = await sha256File(executable)
    copyFileSync(executable, join(evidenceRoot, 'profile-fixture.exe'))
    for (const source of sourceCopies) copyFileSync(source, join(evidenceRoot, source.split(/[\\/]/).at(-1)!))
    for (const mode of ['self-test', 'abi-harness'] as const) {
      const output = join(env.TEMP!, `${mode}.json`)
      if (await sha256File(executable) !== report.executableSha256) throw new Error('Fixture binary changed before a harness')
      try {
        await invoke(mode, [executable, `--${mode}`, '--output', output], mode === 'self-test' ? 45_000 : 60_000)
      } finally {
        // Failure reports contain the actual API/cleanup boundary. Preserve
        // them before deleting the sandbox, even when the producer exits 1.
        if (existsSync(output)) {
          assertRegularFile(output, sandbox)
          if (lstatSync(output).size > 1_000_000) throw new Error('Fixture result exceeded its evidence bound')
          copyFileSync(output, join(evidenceRoot, `${mode}.raw.json`))
        }
      }
      if (await sha256File(executable) !== report.executableSha256) throw new Error('Fixture binary changed during a harness')
      assertRegularFile(output, sandbox)
      if (lstatSync(output).size > 1_000_000) throw new Error('Fixture result exceeded its evidence bound')
      const raw = readFileSync(output, 'utf8')
      const result = validateStageAResult(JSON.parse(raw.replace(/^\uFEFF/, '')), mode)
      if (result.binarySha256 !== report.executableSha256) throw new Error('Harness result does not identify the compiled fixture binary')
      writeFileSync(join(evidenceRoot, `${mode}.json`), `${JSON.stringify(result, null, 2)}\n`)
    }
    const packetRoot = join(sandbox, 'profile-only-packet')
    mkdirSync(packetRoot)
    for (const source of packetSources) {
      const target = source.path === 'preflight.ps1' ? join(sandbox, source.path) : join(packetRoot, source.path.split('/').at(-1)!)
      writeFileSync(target, sourceBytes.get(source.path)!)
    }
    const preflightOutput = join(env.TEMP!, 'profile-only-preflight.json')
    try {
      await invoke('profile-only-preflight', [powershell, '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', join(sandbox, 'preflight.ps1'), '-PacketDirectory', packetRoot,
        '-FixtureRoot', join(sandbox, 'preflight-owned-acl'), '-OutputPath', preflightOutput], 120_000)
    } finally {
      if (existsSync(preflightOutput)) {
        assertRegularFile(preflightOutput, sandbox)
        if (lstatSync(preflightOutput).size > 1_000_000) throw new Error('Preflight result exceeded its evidence bound')
        copyFileSync(preflightOutput, join(evidenceRoot, 'profile-only-preflight.raw.json'))
      }
    }
    const preflight = validateProfileOnlyPreflightResult(JSON.parse(readFileSync(preflightOutput, 'utf8').replace(/^\uFEFF/, '')))
    const hashes = preflight.packetHashes as Record<string, string>
    if (!hashes || packetSources.filter(source => source.path !== 'preflight.ps1')
      .some(source => hashes[source.path.split('/').at(-1)!] !== source.sha256)) {
      throw new Error('Preflight packet source binding changed')
    }
    writeFileSync(join(evidenceRoot, 'profile-only-preflight.json'), `${JSON.stringify(preflight, null, 2)}\n`)

    const canary: Record<string, unknown> = { version: 1, status: 'not_run', capability: 'not_proven', F1: 'not_proven',
      advisory: true, producer: 'f1-native-zero-account', executableSha256: report.executableSha256, sourceSetSha256 }
    report.f1NativeCanary = canary
    if (options.run || (process.platform === 'win32' && process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true')) {
      const output = join(env.TEMP!, 'f1-native-canary.json')
      const command = [executable, '--f1-audit-canary', '--output', output]
      let safetyFailure: unknown
      retainSandbox = true
      try {
        if (existsSync(output) || await sha256File(executable) !== report.executableSha256) throw new CanaryEvidenceSafetyError('Canary output already exists or binary changed')
        const startedAtUtc = new Date().toISOString()
        const result = await (options.run ?? runCanaryCommand)(command, { cwd: sandbox, env: options.run ? { ...env, CI: 'true', GITHUB_ACTIONS: 'true' } : env, timeoutMs: 60_000 })
        const oversized = Buffer.byteLength(result.stdout) > canaryOutputLimit || Buffer.byteLength(result.stderr) > canaryOutputLimit
        const bounded = { ...result, stdout: Buffer.from(result.stdout).subarray(0, canaryOutputLimit).toString('utf8'),
          stderr: Buffer.from(result.stderr).subarray(0, canaryOutputLimit).toString('utf8') }
        const stdout = Buffer.from(bounded.stdout)
        const stderr = Buffer.from(bounded.stderr)
        writeFileSync(join(sandbox, 'f1-native-canary.stdout.private.log'), stdout)
        writeFileSync(join(sandbox, 'f1-native-canary.stderr.private.log'), stderr)
        const diagnostic = { stdoutBytes: stdout.length, stdoutSha256: createHash('sha256').update(stdout).digest('hex'),
          stderrBytes: stderr.length, stderrSha256: createHash('sha256').update(stderr).digest('hex') }
        commands.push({ name: 'f1-native-canary', command, timeoutMs: 60_000, startedAtUtc, finishedAtUtc: new Date().toISOString(),
          exitCode: result.exitCode, timedOut: result.timedOut === true, outputLimitExceeded: result.outputLimitExceeded === true || oversized,
          diagnosticPolicy: 'private-raw;published-counts-and-hashes-only', ...diagnostic })
        writeFileSync(join(evidenceRoot, 'f1-native-canary.log'), `Owned canary diagnostics retained privately.\n${JSON.stringify(diagnostic)}\n`)
        const safeStderr = bounded.stderr === '' || /^Installer profile fixture stopped: (?:f1-[a-z0-9-]+|Native operation failed \([A-Za-z0-9 ._-]{1,160}\)|[A-Za-z][A-Za-z0-9 _-]{0,95} failed \((?:Win32|NET_API_STATUS) [0-9]{1,10}\))\r?\n?$/.test(bounded.stderr)
        if (bounded.stdout !== '' || !safeStderr) throw new CanaryEvidenceSafetyError('Unsupported canary diagnostics remain private')
        Object.assign(canary, { command, output, exitCode: result.exitCode, timedOut: result.timedOut === true,
          outputLimitExceeded: result.outputLimitExceeded === true || oversized, startedAtUtc })
        if (oversized || result.outputLimitExceeded) throw new CanaryEvidenceSafetyError('Canary diagnostic output exceeded its bound')
        if (await sha256File(executable) !== report.executableSha256) throw new CanaryEvidenceSafetyError('Canary binary changed during execution')
        if (!existsSync(output)) { canary.status = 'not_proven'; canary.reason = 'missing-producer-report' }
        else {
          try { assertRegularFile(output, sandbox) } catch { throw new CanaryEvidenceSafetyError('Canary output was not an owned ordinary file') }
          if (lstatSync(output).size > canaryReportLimit) throw new CanaryEvidenceSafetyError('Canary report exceeded its metadata bound')
          const raw = readFileSync(output)
          Object.assign(canary, { reportBytes: raw.length, reportSha256: createHash('sha256').update(raw).digest('hex') })
          const validated = validateF1NativeCanaryResult(raw.toString('utf8'), String(report.executableSha256))
          // Preserve exact bytes: TRACEHANDLE can exceed JS's safe integer range.
          writeFileSync(join(evidenceRoot, 'f1-native-canary.raw.json'), raw)
          canary.status = validated.status === 'failed' || result.exitCode !== 0 || result.timedOut || result.outputLimitExceeded || oversized ? 'failed' : 'not_proven'
          canary.producerStatus = validated.status
          canary.cleanup = validated.cleanup
          retainSandbox = validated.cleanup !== 'passed' || result.timedOut === true || result.outputLimitExceeded === true || oversized
        }
      } catch (error) {
        canary.status = 'failed'
        canary.reason = error instanceof CanaryEvidenceSafetyError ? error.message : 'canary-invocation-or-evidence-unknown'
        if (error instanceof CanaryEvidenceSafetyError) safetyFailure = error
      } finally {
        canary.privateRootRetained = retainSandbox
        writeFileSync(join(evidenceRoot, 'f1-native-canary-consumer.json'), `${JSON.stringify(canary, null, 2)}\n`)
      }
      if (safetyFailure) throw safetyFailure
    } else {
      canary.reason = 'requires-actual-windows-hosted-ci'
      writeFileSync(join(evidenceRoot, 'f1-native-canary-consumer.json'), `${JSON.stringify(canary, null, 2)}\n`)
    }
    exitCode = 0
    report.status = 'passed'
    report.realAccountsCreated = 0
    report.realProfilesCreated = 0
    report.releasedPeExecuted = false
    report.releasedPeMayHaveExecuted = false
    report.releasedPeExecutionStatus = 'not_run'
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error)
  } finally {
    try {
      if (retainSandbox) { report.privateRootRemoved = false; report.privateRootRetained = 'native-canary-closure-or-evidence-unknown' }
      else { rmSync(sandbox, { recursive: true, force: true }); report.privateRootRemoved = !existsSync(sandbox) }
    } catch (error) {
      report.cleanupError = error instanceof Error ? error.message : String(error)
      report.status = 'failed'
      exitCode = 1
    }
    report.exitCode = exitCode
    writeFileSync(join(evidenceRoot, 'checks.json'), `${JSON.stringify(report, null, 2)}\n`)
  }
  return { status: exitCode === 0 ? 'passed' as const : 'failed' as const, exitCode }
}

if (import.meta.main) {
  try {
    // No user-supplied role/spec/execution switch is forwarded by this CI entry.
    if (process.argv.length !== 2) throw new Error('Stage A accepts no account/profile execution arguments')
    process.exitCode = (await runWindowsInstallerProfileChecks()).exitCode
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
