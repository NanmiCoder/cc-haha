import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createSandboxedTestEnvironment } from './test-environment'

const backend = resolve('desktop/build/guarded-removal.cs')
const harness = resolve('scripts/pr/windows-installer-guarded-removal.cs')
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

function ownedSandboxParent(env: NodeJS.ProcessEnv = process.env, fallback = tmpdir()) {
  return env.CI === 'true' && env.RUNNER_TEMP ? env.RUNNER_TEMP : fallback
}

function createCanonicalOwnedSandbox(parent = ownedSandboxParent()) {
  return realpathSync(mkdtempSync(join(parent, 'cc-haha-guarded-removal-')))
}

function withNativeIoStubs(source: string) {
  const replacements: Record<string, string> = {
    NtCreateFile: 'internal static int NtCreateFile(out IntPtr handle, uint access, IntPtr attributes, IntPtr io, IntPtr allocation, uint fileAttributes, uint share, uint disposition, uint options, IntPtr ea, uint eaBytes) { return GuardedRemovalIoStubs.Create(out handle, access, attributes, io, allocation, fileAttributes, share, disposition, options, ea, eaBytes); }',
    NtSetInformationFile: 'internal static int NtSetInformationFile(IntPtr handle, IntPtr io, IntPtr information, uint bytes, int kind) { return GuardedRemovalIoStubs.Rename(handle, io, information, bytes, kind); }',
    WaitForSingleObject: 'internal static uint WaitForSingleObject(IntPtr handle, uint milliseconds) { return GuardedRemovalIoStubs.Wait(handle, milliseconds); }',
    CloseHandle: 'internal static bool CloseHandle(IntPtr handle) { return GuardedRemovalIoStubs.Close(handle); }',
    NtQueryObject: 'internal static int NtQueryObject(IntPtr handle, int kind, IntPtr information, uint bytes, out uint returned) { return GuardedRemovalIoStubs.QueryParent(handle, kind, information, bytes, out returned); }',
  }
  for (const [name, replacement] of Object.entries(replacements)) {
    const declaration = new RegExp(`\\[DllImport\\([^\\n]+\\)\\] internal static extern [^;\\n]+\\b${name}\\([^;]+;`, 'g')
    if ([...source.matchAll(declaration)].length !== 1) throw new Error(`Expected one native declaration: ${name}`)
    source = source.replace(declaration, replacement)
  }
  return source.replaceAll('Marshal.AllocHGlobal(', 'GuardedRemovalIoStubs.Allocate(').replaceAll('Marshal.FreeHGlobal(', 'GuardedRemovalIoStubs.Free(')
}

test('guarded backend has no fixture CLI or alternate destructive path', () => {
  const code = readFileSync(backend, 'utf8')
  expect(code).not.toMatch(/--self-test|fixture-lifetime|CreateProcess|TerminateProcess|MoveFileEx|Directory\.Delete|File\.Delete|DeleteSubKey|RegDelete|PowerShell|System\.Net/)
  expect(code.match(/\bMain\s*\(/g)).toHaveLength(1)
  const injected = withNativeIoStubs(code)
  expect(injected).toContain('GuardedRemovalIoStubs.Rename(')
  expect(injected).toContain('GuardedRemovalIoStubs.Allocate(')
})

function removePlainOwnedTree(root: string) {
  const plan: { path: string; directory: boolean; dev: number; ino: number }[] = []
  function inspect(path: string, depth: number) {
    if (depth > 32 || plan.length >= 4096) throw new Error('Owned guarded harness cleanup exceeds bounds')
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('Owned guarded harness cleanup refuses reparse or unknown state')
    if (stat.isDirectory()) for (const entry of readdirSync(path)) inspect(join(path, entry), depth + 1)
    plan.push({ path, directory: stat.isDirectory(), dev: stat.dev, ino: stat.ino })
  }
  inspect(root, 0)
  for (const entry of plan) {
    const current = lstatSync(entry.path)
    if (current.isSymbolicLink() || current.dev !== entry.dev || current.ino !== entry.ino || current.isDirectory() !== entry.directory) {
      throw new Error('Owned guarded harness cleanup refuses identity drift')
    }
    if (entry.directory) rmdirSync(entry.path)
    else unlinkSync(entry.path)
  }
}

test('guarded fixture prefers CI runner temp and keeps the isolated local fallback', () => {
  const arena = realpathSync(mkdtempSync(join(tmpdir(), 'cc-haha-guarded-temp-alias-')))
  const actual = join(arena, 'actual'), alias = join(arena, 'alias')
  mkdirSync(actual)
  symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir')
  try {
    const legacy = mkdtempSync(join(alias, 'legacy-'))
    expect(resolve(legacy)).not.toBe(realpathSync(legacy))
    const canonical = createCanonicalOwnedSandbox(alias)
    const fixture = join(canonical, 'fixture')
    mkdirSync(fixture)
    expect(canonical).toBe(realpathSync(canonical))
    expect(fixture).toBe(realpathSync(fixture))
    expect(canonical.startsWith(`${actual}\\`) || canonical.startsWith(`${actual}/`)).toBe(true)
    const runnerTemp = join(arena, 'runner-temp')
    mkdirSync(runnerTemp)
    const selected = ownedSandboxParent({ CI: 'true', RUNNER_TEMP: runnerTemp }, alias)
    expect(selected).toBe(runnerTemp)
    expect(dirname(createCanonicalOwnedSandbox(selected))).toBe(realpathSync(runnerTemp))
    expect(ownedSandboxParent({ CI: 'false', RUNNER_TEMP: runnerTemp }, alias)).toBe(alias)
    expect(ownedSandboxParent({ CI: 'true' }, actual)).toBe(actual)
  } finally {
    unlinkSync(alias)
    removePlainOwnedTree(arena)
  }
})

test.skipIf(process.platform !== 'win32')('compiles CLR4 x86 and exercises shared guarded engine only on fresh owned data', async () => {
  if (process.env.CI !== 'true') throw new Error('Guarded native harness requires a disposable Windows CI runner')
  const sandbox = createCanonicalOwnedSandbox()
  const code = join(sandbox, 'code')
  mkdirSync(code)
  const privateEnvironment = createSandboxedTestEnvironment(join(sandbox, 'home'))
  const windows = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows'
  const env: Record<string, string> = {
    SystemRoot: windows, WINDIR: windows, PATH: join(windows, 'System32'), CI: 'true',
    TEMP: privateEnvironment.TEMP!, TMP: privateEnvironment.TMP!,
    HOME: privateEnvironment.HOME!, USERPROFILE: privateEnvironment.USERPROFILE!,
    APPDATA: privateEnvironment.APPDATA!, LOCALAPPDATA: privateEnvironment.LOCALAPPDATA!,
  }
  const evidence = resolve('artifacts/windows-installer/guarded-removal')
  mkdirSync(evidence, { recursive: true })
  const report: Record<string, unknown> = { status: 'starting', sourceSha256: sha256(readFileSync(backend)),
    harnessSha256: sha256(readFileSync(harness)), mode: 'same-source-engine-owned-harness',
    productionAdmissionExecuted: false, crossProcessNsisHandoff: 'tested-separately', realAccountsCreated: 0,
    fixtureInput: { systemTemp: tmpdir(), runnerTemp: process.env.RUNNER_TEMP ?? null, selectedParent: ownedSandboxParent(), sandbox },
    realProfilesCreated: 0, productPeExecuted: false, ordinaryNativePrimitives: 'separate-probe-evidence', sandbox }
  let nativeUnknown = false
  let priorFailure = false
  try {
    const compiler = join(windows, 'Microsoft.NET/Framework/v4.0.30319/csc.exe')
    const references = ['mscorlib.dll', 'System.dll', 'System.Core.dll'].map(name => `/reference:${join(dirname(compiler), name)}`)
    const sourceCopy = join(code, 'guarded-removal.cs'), harnessCopy = join(code, 'checks.cs')
    copyFileSync(backend, sourceCopy)
    copyFileSync(harness, harnessCopy)
    const executable = join(code, 'checks.exe'), production = join(code, 'guarded-removal.exe'), stubExecutable = join(code, 'pending-stubs.exe')
    const injectedSource = join(code, 'pending-stubbed-source.cs')
    writeFileSync(injectedSource, withNativeIoStubs(readFileSync(backend, 'utf8')))
    const flags = ['/nologo', '/noconfig', '/nostdlib+', '/langversion:5', '/platform:x86', '/target:exe', '/checked+', '/warnaserror+', ...references]
    for (const [name, args] of [
      ['production', [...flags, `/out:${production}`, sourceCopy]],
      ['harness', [...flags, '/main:GuardedRemovalChecks', `/out:${executable}`, sourceCopy, harnessCopy]],
      ['pending-stubs', [...flags, '/main:GuardedRemovalIoStubs', `/out:${stubExecutable}`, injectedSource, harnessCopy]],
    ] as const) {
      const compiled = spawnSync(compiler, [...args], { env, cwd: dirname(compiler), encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 })
      writeFileSync(join(evidence, `${name}-compile.log`), `${compiled.stdout ?? ''}${compiled.stderr ?? ''}${compiled.error ?? ''}`)
      expect(compiled.error).toBeUndefined()
      expect(compiled.status, compiled.stderr || compiled.stdout).toBe(0)
    }
    const bytes = readFileSync(production)
    expect(bytes.readUInt16LE(bytes.readUInt32LE(0x3c) + 4)).toBe(0x14c)
    report.productionCompile = { sha256: sha256(bytes), bytes: bytes.length, executed: false }
    const managed = spawnSync(executable, ['managed'], { env, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 })
    report.managed = { status: managed.status, stdout: managed.stdout, stderr: managed.stderr }
    expect(managed.error).toBeUndefined()
    expect(managed.status, managed.stderr).toBe(0)
    expect(managed.stdout).toMatch(/^managed-pass:\d+/)
    const pending = spawnSync(stubExecutable, [], { env, encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 })
    report.pendingControlFlow = { status: pending.status, stdout: pending.stdout, stderr: pending.stderr, nativeApiCalled: false }
    expect(pending.error).toBeUndefined()
    expect(pending.status, pending.stderr).toBe(0)
    expect(pending.stdout.trim()).toBe('pending-control-pass:14')
    const parentQuery = spawnSync(stubExecutable, ['parent-capability'], { env, encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 })
    report.parentCapabilityControlFlow = { status: parentQuery.status, stdout: parentQuery.stdout, stderr: parentQuery.stderr, nativeApiCalled: false }
    expect(parentQuery.error).toBeUndefined()
    expect(parentQuery.status, parentQuery.stderr).toBe(0)
    expect(parentQuery.stdout.trim()).toBe('parent-query-control-pass:7')
    const cases: unknown[] = []
    for (const mode of ['success', 'rollback', 'busy', 'wrong-cap', 'namespace-change', 'parent-dead',
      'data-plain', 'data-missing', 'data-config-leaf', 'data-product-leaf', 'data-config-ancestor', 'data-product-ancestor',
      'data-missing-then-plain', 'data-missing-then-junction']) {
      const arena = join(sandbox, `case-${mode}`)
      mkdirSync(arena)
      const fixture = join(arena, 'fixture')
      mkdirSync(fixture)
      const knownAliases: string[] = []
      if (mode.startsWith('data-')) {
        const profile = join(arena, 'profile'), roaming = join(arena, 'roaming')
        mkdirSync(profile)
        mkdirSync(roaming)
        if (mode === 'data-plain') {
          mkdirSync(join(profile, '.claude'))
          mkdirSync(join(roaming, 'Claude Code Haha'))
          writeFileSync(join(profile, '.claude', 'owned-data-canary'), 'owned protected config')
          writeFileSync(join(roaming, 'Claude Code Haha', 'owned-data-canary'), 'owned protected product data')
        }
        const alias = mode === 'data-config-leaf' ? join(profile, '.claude')
          : mode === 'data-product-leaf' ? join(roaming, 'Claude Code Haha')
            : mode === 'data-config-ancestor' ? join(arena, 'profile-parent')
              : mode === 'data-product-ancestor' ? join(arena, 'roaming-parent') : undefined
        if (alias) { symlinkSync(fixture, alias, 'junction'); knownAliases.push(alias) }
        if (mode === 'data-missing-then-junction') knownAliases.push(join(profile, '.claude'))
      }
      const raw = join(arena, 'raw.json')
      // This test-only lifetime process exits naturally. It is never killed to
      // make a pending mutation appear restored or successful.
      const lifetime = mode === 'parent-dead' ? spawn(executable, ['fixture-lifetime'], { env, stdio: 'ignore', windowsHide: true }) : undefined
      const parentPid = lifetime?.pid ?? process.pid
      if (lifetime && !lifetime.pid) throw new Error('Owned lifetime fixture did not start')
      nativeUnknown = true
      const run = spawnSync(executable, [mode, fixture, String(parentPid), raw], { env, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 })
      if (lifetime) await new Promise<void>((resolve, reject) => {
        if (lifetime.exitCode !== null) resolve()
        else { lifetime.once('error', reject); lifetime.once('exit', () => resolve()) }
      })
      if (existsSync(raw)) copyFileSync(raw, join(evidence, `${mode}.raw.json`))
      expect(run.error).toBeUndefined()
      expect(existsSync(raw), `${mode}: native evidence must exist`).toBe(true)
      const result = JSON.parse(readFileSync(raw, 'utf8'))
      cases.push({ mode, processStatus: run.status, ...result })
      nativeUnknown = result.safeForOwnedCleanup !== true
      expect(run.status, JSON.stringify(result)).toBe(0)
      expect(result.fixtureStatus).toBe('passed')
      expect(result.realAccountsCreated).toBe(0)
      expect(result.realProfilesCreated).toBe(0)
      expect(result.productPeExecuted).toBe(false)
      expect(result.safeForOwnedCleanup).toBe(true)
      // Only successful fixture evidence authorizes removing these exact links
      // created by this case. Unknown state remains under the no-follow policy.
      for (const alias of knownAliases) {
        expect(lstatSync(alias).isSymbolicLink()).toBe(true)
        expect(resolve(readlinkSync(alias))).toBe(resolve(fixture))
        unlinkSync(alias)
      }
      if (mode === 'data-plain') {
        expect(readFileSync(join(arena, 'profile/.claude/owned-data-canary'), 'utf8')).toBe('owned protected config')
        expect(readFileSync(join(arena, 'roaming/Claude Code Haha/owned-data-canary'), 'utf8')).toBe('owned protected product data')
      }
      if (mode === 'success') expect(result.operationOutcome).toBe('removed')
      else expect(result.originalBytesPreserved).toBe(true)
      if (mode === 'success' || mode === 'rollback' || mode === 'parent-dead') expect(result.namedPrunePins).toBeGreaterThan(0)
      if (mode === 'rollback' || mode === 'parent-dead') {
        expect(result.restored).toBe(true)
        expect(result.originalFileIdsAndBytesPreserved).toBe(true)
      }
    }
    report.cases = cases
    report.status = 'passed'
  } catch (error) {
    priorFailure = true
    report.status = 'failed'
    report.error = String(error)
    throw error
  } finally {
    let cleanupError: unknown
    try {
      if (nativeUnknown) {
        report.cleanup = { status: 'unknown', retainedOwnedRoot: sandbox }
        cleanupError = new Error('Guarded native harness retained because its final state is unknown')
      } else {
        removePlainOwnedTree(sandbox)
        report.cleanup = { status: 'passed', temporaryRootRemoved: !existsSync(sandbox), recursiveRmUsed: false }
      }
    } catch (error) { cleanupError = error; report.cleanup = { status: 'failed', retainedOwnedRoot: sandbox, error: String(error) } }
    if (cleanupError) report.status = 'failed'
    writeFileSync(join(evidence, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
    if (cleanupError && !priorFailure) throw cleanupError
  }
}, 90_000)
