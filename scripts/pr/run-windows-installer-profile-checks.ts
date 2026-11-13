#!/usr/bin/env bun

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { assertOutsideSourceGit, isInsideDirectory, sha256File } from './prepare-windows-installer-tests'
import { createSandboxedTestEnvironment } from './test-environment'

export const profileFixtureSources = [
  'scripts/pr/windows-installer-profile-fixture.cs',
  'scripts/pr/windows-installer-profile-native.cs',
  'scripts/pr/windows-installer-profile-fixture-tests.cs',
] as const

const evidenceFields = ['member_proven', 'installed_bytes_equal', 'old22_before_protected_mutation', 'removal_equivalence', 'full_old_to_new'] as const
type StageAMode = 'self-test' | 'abi-harness'
type CommandResult = { exitCode: number; stdout: string; stderr: string; timedOut?: boolean }
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
  run?: FixtureRunner
} = {}) {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    console.log(`[windows-installer-profile] not_run on ${platform}; Windows Stage A must compile and run the real fixture`)
    return { status: 'not_run' as const, exitCode: 0 }
  }
  if (!options.run && process.env.CI !== 'true') throw new Error('Profile fixture checks require a disposable Windows CI runner')
  if (options.compiler && !options.run) throw new Error('A compiler override is only valid with a fake runner')
  const sourceRoot = realpathSync(options.sourceRoot ?? resolve(import.meta.dir, '../..'))
  const tempParent = realpathSync(options.tempParent ?? process.env.RUNNER_TEMP ?? tmpdir())
  assertOutsideSourceGit(tempParent, sourceRoot)
  const compiler = realpathSync(options.compiler ?? join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows',
    'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'))
  if (!lstatSync(compiler).isFile()) throw new Error('The system x64 Framework compiler is missing')
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
    compiler, compilerSha256: await sha256File(compiler), temporaryRoot: sandbox,
    realAccountsCreated: 'not_proven', realProfilesCreated: 'not_proven', releasedPeExecuted: 'not_proven',
    releasedPeMayHaveExecuted: 'not_proven', releasedPeExecutionStatus: 'not_proven',
    compatibilityEnabled: false, oldExit22Policy: 'fatal',
    ...Object.fromEntries(evidenceFields.map(field => [field, 'not_run'])), commands,
  }
  let exitCode = 1
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
      rmSync(sandbox, { recursive: true, force: true })
      report.privateRootRemoved = !existsSync(sandbox)
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
