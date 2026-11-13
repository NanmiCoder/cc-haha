import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { release, tmpdir, version } from 'node:os'
import { join, resolve } from 'node:path'
import { createSandboxedTestEnvironment } from './test-environment'

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

// Only replace native declarations and allocation accounting in a disposable
// compiled copy. Relative/RenameNt/RunCase and their cleanup remain unchanged.
function withNativeIoStubs(source: string) {
  const replacements: Record<string, string> = {
    NtCreateFile: 'private static int NtCreateFile(out IntPtr handle, uint access, IntPtr attributes, IntPtr io, IntPtr allocation, uint fileAttributes, uint share, uint disposition, uint options, IntPtr ea, uint eaBytes) { return PrimitiveIoStubs.Create(out handle, access, attributes, io, allocation, fileAttributes, share, disposition, options, ea, eaBytes); }',
    NtSetInformationFile: 'private static int NtSetInformationFile(IntPtr handle, IntPtr io, IntPtr information, uint bytes, int kind) { return PrimitiveIoStubs.Rename(handle, io, information, bytes, kind); }',
    WaitForSingleObject: 'private static uint WaitForSingleObject(IntPtr handle, uint milliseconds) { return PrimitiveIoStubs.Wait(handle, milliseconds); }',
    CloseHandle: 'private static bool CloseHandle(IntPtr handle) { return PrimitiveIoStubs.Close(handle); }',
    RtlNtStatusToDosError: 'private static uint RtlNtStatusToDosError(int status) { return unchecked((uint)status); }',
  }
  for (const [name, replacement] of Object.entries(replacements)) {
    const declaration = new RegExp(`\\[DllImport\\([^\\n]+\\)\\]\\s*private static extern [^;]+?\\b${name}\\([^;]+;`, 'g')
    if ([...source.matchAll(declaration)].length !== 1) throw new Error(`Expected one native declaration: ${name}`)
    source = source.replace(declaration, replacement)
  }
  return source.replaceAll('Marshal.AllocHGlobal(', 'PrimitiveIoStubs.Allocate(').replaceAll('Marshal.FreeHGlobal(', 'PrimitiveIoStubs.Free(') + primitiveIoStub
}

const primitiveIoStub = String.raw`
internal static class PrimitiveIoStubs
{
  private static int Mode, Frees, Closes;
  private static IntPtr Io;
  private static readonly List<IntPtr> Allocations = new List<IntPtr>();
  public static IntPtr Allocate(int bytes) { IntPtr value = Marshal.AllocHGlobal(bytes); Allocations.Add(value); return value; }
  public static void Free(IntPtr value) { if (!Allocations.Remove(value)) throw new Exception("untracked-free"); Frees++; Marshal.FreeHGlobal(value); }
  public static bool Close(IntPtr value) { Closes++; return true; }
  private static int Call(IntPtr io)
  {
    Io = io;
    if (Mode == 0) Marshal.WriteInt32(io, 0x103);
    if (Mode == 6) { Marshal.WriteInt32(io, 0); Marshal.WriteIntPtr(io, IntPtr.Size, new IntPtr(1)); return 0; }
    return Mode == 3 ? unchecked((int)0xc0000022) : 0x103;
  }
  public static int Create(out IntPtr handle, uint access, IntPtr attributes, IntPtr io, IntPtr allocation, uint fileAttributes,
    uint share, uint disposition, uint options, IntPtr ea, uint eaBytes) { handle = new IntPtr(16); return Call(io); }
  public static int Rename(IntPtr handle, IntPtr io, IntPtr information, uint bytes, int kind) { return Call(io); }
  public static uint Wait(IntPtr handle, uint milliseconds)
  {
    if (Mode == 2 || Mode == 4 || Mode == 5) { Marshal.WriteInt32(Io, Mode == 2 ? unchecked((int)0xc0000022) : 0); Marshal.WriteIntPtr(Io, IntPtr.Size, new IntPtr(1)); }
    return Mode == 5 ? 0xffffffffu : 0u;
  }
  private static readonly Type Probe = typeof(RemovalPrimitiveProbe);
  private const BindingFlags Static = BindingFlags.Static | BindingFlags.NonPublic;
  private static object Invoke(string method, params object[] args) { return Probe.GetMethod(method, Static).Invoke(null, args); }
  private static bool Flag(string field) { return (bool)Probe.GetField(field, Static).GetValue(null); }
  private static void Set(string field, bool value) { Probe.GetField(field, Static).SetValue(null, value); }
  private static object Handle(int value)
  {
    return Activator.CreateInstance(Probe.GetNestedType("OwnedHandle", BindingFlags.NonPublic),
      BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic, null, new object[] { new IntPtr(value), "stub", 0u, 0u }, CultureInfo.InvariantCulture);
  }
  private static void Assert(bool value, string name) { if (!value) throw new Exception("pending-control-" + name); }
  public static string Run()
  {
    int cases = 0;
    foreach (bool relative in new bool[] { true, false }) for (Mode = 0; Mode < 7; Mode++)
    {
      foreach (string flag in new string[] { "PendingNativeIo", "UnsafeCleanup", "Failed", "CurrentCaseFailed" }) Set(flag, false);
      foreach (string list in new string[] { "Handles", "Checks", "DiagnosticChecks", "CaseResults", "Observations", "ReparseLeases" })
        ((IList)Probe.GetField(list, Static).GetValue(null)).Clear();
      Frees = Closes = 0;
      object file = null;
      bool result = (bool)Invoke("RunCase", "pending-stub", false, (Action)delegate {
        object parent = Handle(4); file = Handle(8);
        bool success;
        if (relative)
        {
          object opened = Invoke("OpenRelative", parent, "child", 0x1100a1u, 1u, true, "stub-open");
          success = (bool)opened.GetType().GetField("Success").GetValue(opened);
        }
        else success = (bool)Invoke("RenameNt", file, parent, "child", "stub-rename");
        if (!success) throw new InvalidOperationException("expected-stub-failure");
      });
      bool unresolved = Mode < 2 || Mode == 5;
      Assert(Flag("PendingNativeIo") == unresolved && Flag("UnsafeCleanup") == unresolved, "flags");
      Assert(result == (Mode == 4 || Mode == 6), "result");
      Assert(Frees == (unresolved ? 0 : relative ? 4 : 2), "free-accounting");
      Assert(Allocations.Count == (unresolved ? relative ? 4 : 2 : 0), "retained-buffer-count");
      Assert(Closes == (unresolved ? 0 : relative ? 3 : 2), "case-finally-closes");
      if (unresolved)
      {
        Assert(!(bool)file.GetType().GetMethod("Close").Invoke(file, null), "explicit-close-refused");
        Assert(Closes == 0, "no-pending-close");
      }
      // These allocations never reached an OS request; drain only the test
      // stubs after checking the production lifetime decisions.
      foreach (IntPtr retained in Allocations) Marshal.FreeHGlobal(retained);
      Allocations.Clear(); cases++;
    }
    return "pending-control-pass:" + cases.ToString(CultureInfo.InvariantCulture);
  }
  private static int Main() { Console.WriteLine(Run()); return 0; }
}
`

test('native pending regression stubs only replace declarations and allocation accounting', () => {
  const injected = withNativeIoStubs(readFileSync(resolve('scripts/pr/windows-installer-removal-primitives.cs'), 'utf8'))
  expect(injected).toContain('PrimitiveIoStubs.Rename(')
  expect(injected).toContain('PrimitiveIoStubs.Allocate(')
})

function mayCleanOwnedSandbox(nativeStarted: boolean, native: Record<string, any> | undefined) {
  return !nativeStarted || (native?.version === 4 && native.safeForControllerCleanup === true &&
    native.cleanupState?.rootInitiallyVerified === true && native.cleanupState?.allHandlesClosed === true &&
    native.cleanupState?.pendingNativeIo === false && native.cleanupState?.reparseUncertain === false &&
    native.cleanupState?.unsafeEffectObserved === false)
}

// Preflight the complete bounded tree before deleting anything. No recursive
// rm, reparse traversal, or automatic cleanup after a crashed/unknown native run.
function removeOwnedPlainTree(root: string) {
  const plan: { path: string; directory: boolean; dev: number; ino: number }[] = []
  function inspect(path: string, depth: number) {
    if (depth > 16 || plan.length >= 2048) throw new Error('Owned cleanup exceeds its bounded tree')
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('Owned cleanup refuses reparse or unknown entries')
    if (stat.isDirectory()) for (const entry of readdirSync(path)) inspect(join(path, entry), depth + 1)
    plan.push({ path, directory: stat.isDirectory(), dev: stat.dev, ino: stat.ino })
  }
  inspect(root, 0)
  for (const entry of plan) {
    const stat = lstatSync(entry.path)
    if (stat.isSymbolicLink() || stat.dev !== entry.dev || stat.ino !== entry.ino || stat.isDirectory() !== entry.directory) {
      throw new Error('Owned cleanup refuses changed identity')
    }
    if (entry.directory) rmdirSync(entry.path)
    else unlinkSync(entry.path)
  }
}

test('retains an owned native arena for missing, pending, reparse or incomplete-close evidence', () => {
  const known = { version: 4, safeForControllerCleanup: true, cleanupState: { rootInitiallyVerified: true,
    allHandlesClosed: true, pendingNativeIo: false, reparseUncertain: false, unsafeEffectObserved: false } }
  expect(mayCleanOwnedSandbox(false, undefined)).toBe(true)
  expect(mayCleanOwnedSandbox(true, undefined)).toBe(false)
  expect(mayCleanOwnedSandbox(true, known)).toBe(true)
  for (const key of ['rootInitiallyVerified', 'allHandlesClosed', 'pendingNativeIo', 'reparseUncertain', 'unsafeEffectObserved']) {
    const changed = structuredClone(known)
    changed.cleanupState[key as keyof typeof changed.cleanupState] = !changed.cleanupState[key as keyof typeof changed.cleanupState]
    expect(mayCleanOwnedSandbox(true, changed)).toBe(false)
  }
  expect(mayCleanOwnedSandbox(true, { ...known, safeForControllerCleanup: false })).toBe(false)
})

test('owned cleanup rejects a junction or symlink before touching its owned outside marker', () => {
  const arena = mkdtempSync(join(tmpdir(), 'cc-haha-probe-cleanup-'))
  const inside = join(arena, 'inside'), outside = join(arena, 'outside')
  mkdirSync(inside)
  mkdirSync(outside)
  writeFileSync(join(outside, 'marker'), 'owned outside marker')
  const alias = join(inside, 'alias')
  symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir')
  try {
    expect(() => removeOwnedPlainTree(inside)).toThrow('refuses reparse')
    expect(readFileSync(join(outside, 'marker'), 'utf8')).toBe('owned outside marker')
    expect(existsSync(alias)).toBe(true)
  } finally {
    // Remove just this known test link, then use the same non-follow cleanup.
    unlinkSync(alias)
    removeOwnedPlainTree(arena)
  }
})

function fileEvidence(file: string) {
  if (!existsSync(file)) return { path: file, exists: false }
  const stat = lstatSync(file)
  return { path: file, exists: true, bytes: stat.size, sha256: stat.isFile() ? sha256(readFileSync(file)) : null }
}

function directories(directory: string) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^\d+(?:\.\d+)+$/.test(entry.name))
    .map(entry => entry.name).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
}

// Read installed tool metadata only. This does not initialize VS, run cl,
// install an SDK, or assume the windows-latest image has a working x86 target.
function inspectToolchain(env: Record<string, string>) {
  const programFiles = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const vswhere = join(programFiles, 'Microsoft Visual Studio/Installer/vswhere.exe')
  const lookup = existsSync(vswhere) ? spawnSync(vswhere,
    ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-format', 'json'],
    { env, encoding: 'utf8', timeout: 15_000, windowsHide: true }) : null
  let installation: { installationPath?: string; installationVersion?: string } | undefined
  let parseError: string | undefined
  try { installation = lookup?.status === 0 ? JSON.parse(lookup.stdout)[0] : undefined } catch (error) { parseError = String(error) }
  const versionFile = installation?.installationPath && join(installation.installationPath, 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt')
  const version = versionFile && existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : undefined
  const validVersion = version && /^\d+(?:\.\d+)+$/.test(version) ? version : undefined
  const vc = installation?.installationPath && validVersion && join(installation.installationPath, 'VC/Tools/MSVC', validVersion)
  const sdk = join(programFiles, 'Windows Kits/10')
  const sdks = directories(join(sdk, 'Include')).map(version => ({ version, files: [
    fileEvidence(join(sdk, 'Include', version, 'um/Windows.h')),
    fileEvidence(join(sdk, 'Include', version, 'shared/minwindef.h')),
    fileEvidence(join(sdk, 'Include', version, 'ucrt/stdio.h')),
    fileEvidence(join(sdk, 'Lib', version, 'um/x86/kernel32.lib')),
    fileEvidence(join(sdk, 'Lib', version, 'ucrt/x86/libucrt.lib')),
  ] }))
  const files = vc ? [fileEvidence(join(vc, 'bin/Hostx64/x86/cl.exe')), fileEvidence(join(vc, 'bin/Hostx64/x86/link.exe')),
    fileEvidence(join(vc, 'lib/x86/libcmt.lib')), fileEvidence(join(vc, 'lib/x86/libvcruntime.lib'))] : []
  return { status: vc && files.every(file => file.exists) && sdks.some(sdk => sdk.files.every(file => file.exists)) ? 'located-not-compiled' : 'not-located',
    hostArchitecture: process.arch, targetArchitecture: 'x86', vswhere: fileEvidence(vswhere),
    lookup: lookup && { status: lookup.status, error: lookup.error?.message, stderr: lookup.stderr, stdout: lookup.stdout }, parseError,
    installation, versionFile: versionFile && fileEvidence(versionFile), msvcVersion: validVersion, files, sdks }
}

for (const architecture of ['x86', 'x64'] as const) {
  test.skipIf(process.platform !== 'win32')(`probes ${architecture} readonly MOVE guards and parent-relative named PRUNE using owned temp only`, () => {
    if (process.env.CI !== 'true') throw new Error('Run this owned primitive probe only on a disposable Windows CI runner')
    const sandbox = mkdtempSync(join(tmpdir(), `cc-haha-removal-primitives-${architecture}-`))
    const env = createSandboxedTestEnvironment(join(sandbox, 'home'))
    const fixture = join(sandbox, 'fixture')
    mkdirSync(fixture)
    const evidence = resolve('artifacts/windows-installer/removal-primitives', architecture)
    mkdirSync(evidence, { recursive: true })
    for (const name of ['native.raw.json', 'compile.log', 'toolchain.json', 'report.json']) rmSync(join(evidence, name), { force: true })
    const source = resolve('scripts/pr/windows-installer-removal-primitives.cs')
    const copiedSource = join(sandbox, 'probe.cs')
    const executable = join(sandbox, 'probe.exe')
    const raw = join(sandbox, 'native.raw.json')
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows'
    const framework = join(systemRoot, architecture === 'x86' ? 'Microsoft.NET/Framework/v4.0.30319' : 'Microsoft.NET/Framework64/v4.0.30319')
    const compiler = join(framework, 'csc.exe')
    const compileCommand = [compiler, '/nologo', '/langversion:5', '/target:exe', `/platform:${architecture}`, '/optimize+', `/out:${executable}`, copiedSource]
    let nativeStarted = false
    let native: Record<string, any> | undefined
    let originalFailure = false
    const report: Record<string, unknown> = { version: 4, status: 'starting', platform: process.platform,
      operatingSystem: { release: release(), version: version() },
      architecture, source: fileEvidence(source), compiler: fileEvidence(compiler),
      compileCommand, sandbox, ownedFixtureRoot: fixture, officialOldPeExecuted: false, productPeExecuted: false,
      realAccountsCreated: 0, realProfilesCreated: 0, crossProcessPinnedAck: 'not_run', junctionRaces: 'not_run',
      completeFailureRestore: 'unknown', productRemoval: 'not_run', f1: 'not_run' }
    try {
      const tools = inspectToolchain(env)
      writeFileSync(join(evidence, 'toolchain.json'), `${JSON.stringify(tools, null, 2)}\n`)
      report.toolchain = tools
      expect(existsSync(compiler), `The actual system ${architecture} Framework C# compiler is required`).toBe(true)
      copyFileSync(source, copiedSource)
      const compile = spawnSync(compiler, compileCommand.slice(1), { env, encoding: 'utf8', timeout: 30_000, windowsHide: true })
      report.compile = { status: compile.status, error: compile.error?.message }
      writeFileSync(join(evidence, 'compile.log'), `${compile.stdout ?? ''}${compile.stderr ?? ''}${compile.error ?? ''}`)
      expect(compile.error, compile.stderr || compile.stdout).toBeUndefined()
      expect(compile.status, compile.stderr || compile.stdout).toBe(0)
      const stubSource = join(sandbox, 'pending-stubbed.cs'), stubExecutable = join(sandbox, 'pending-stubs.exe')
      writeFileSync(stubSource, withNativeIoStubs(readFileSync(source, 'utf8')))
      const stubCompile = spawnSync(compiler, ['/nologo', '/langversion:5', '/target:exe', `/platform:${architecture}`,
        '/checked+', '/warnaserror+', '/main:PrimitiveIoStubs', `/out:${stubExecutable}`, stubSource],
      { env, encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 })
      writeFileSync(join(evidence, 'pending-stubs-compile.log'), `${stubCompile.stdout ?? ''}${stubCompile.stderr ?? ''}${stubCompile.error ?? ''}`)
      expect(stubCompile.error).toBeUndefined()
      expect(stubCompile.status, stubCompile.stderr || stubCompile.stdout).toBe(0)
      const stubRun = spawnSync(stubExecutable, [], { env, encoding: 'utf8', timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 })
      report.pendingControlFlow = { status: stubRun.status, stdout: stubRun.stdout, stderr: stubRun.stderr, nativeApiCalled: false }
      expect(stubRun.error).toBeUndefined()
      expect(stubRun.status, stubRun.stderr).toBe(0)
      expect(stubRun.stdout.trim()).toBe('pending-control-pass:14')
      const bytes = readFileSync(executable)
      expect(bytes.readUInt16LE(bytes.readUInt32LE(0x3c) + 4)).toBe(architecture === 'x86' ? 0x14c : 0x8664)
      report.executable = fileEvidence(executable)
      const versionsInput = join(sandbox, 'tool-versions-input.json')
      const binaries = [compiler, ...(tools.vswhere.exists ? [tools.vswhere.path] : []),
        ...tools.files.filter(file => file.exists && /\.exe$/i.test(file.path)).map(file => file.path)]
      writeFileSync(versionsInput, `${binaries.join('\n')}\n`)
      nativeStarted = true
      const run = spawnSync(executable, [fixture, raw, versionsInput], { env, encoding: 'utf8', timeout: 30_000, windowsHide: true })
      report.run = { status: run.status, error: run.error?.message, stdout: run.stdout, stderr: run.stderr }
      if (existsSync(raw)) copyFileSync(raw, join(evidence, 'native.raw.json'))
      expect(run.error).toBeUndefined()
      expect(existsSync(raw), 'Native observations must come from the executed owned fixture').toBe(true)
      native = JSON.parse(readFileSync(raw, 'utf8'))
      if (!native) throw new Error('Missing native evidence')
      report.native = native
      expect(run.status, JSON.stringify({ status: native.status, failedChecks: native.checks.filter((item: any) => item.status === 'failed'), cleanup: native.cleanupState })).toBe(0)
      expect(native.version).toBe(4)
      expect(native.status).toBe('passed')
      expect(native.chosenPrimitive).toBe('NtRename+readonly-share3+relative-NtCreate-sentinel+same-handle-named-prune')
      expect(native.chosenPrimitiveStatus).toBe('passed')
      expect(native.processPointerBytes).toBe(architecture === 'x86' ? 4 : 8)
      expect(native.renameNameOffset).toBe(architecture === 'x86' ? 12 : 20)
      expect(native.renameInformationBytes).toBe(architecture === 'x86' ? 16 : 24)
      expect(native.ioStatusBlockBytes).toBe(architecture === 'x86' ? 8 : 16)
      expect(native.ioInformationOffset).toBe(architecture === 'x86' ? 4 : 8)
      expect(native.fileIdDescriptorBytes).toBe(24)
      expect(native.fileIdDescriptorUnionOffset).toBe(8)
      expect(native.ownedFixtureRoot.toLowerCase()).toBe(resolve(fixture).toLowerCase())
      expect(native.executable.toLowerCase()).toBe(resolve(executable).toLowerCase())
      for (const name of ['weak-and-strong-same-object', 'preopened-writer-denies-strong', 'preopened-deleter-denies-strong']) {
        expect(native.checks.some((check: { name: string; status: string }) => check.name === name && check.status === 'passed')).toBe(true)
      }
      const chosen = 'chosen-sentinel-share3-roundtrip'
      expect(native.caseResults.find((item: { name: string }) => item.name === chosen)).toEqual({
        name: chosen, role: 'required', completed: true, capabilityCredit: true, fullRoundtrip: true,
      })
      for (const name of ['relative-forward-existing-file-handle', 'rename-kept-source-object', 'prune-child-same-handle-disposition',
        'prune-parent-same-handle-disposition', 'relative-restore-after-prune', 'restore-kept-source-object', 'restore-preserved-owned-payload-bytes']) {
        expect(native.checks.some((check: { caseName: string; name: string; status: string }) =>
          check.caseName === chosen && check.name === name && check.status === 'passed')).toBe(true)
      }
      expect(native.checks.some((check: { name: string; status: string }) =>
        check.name === 'file-id-descriptor-sdk-layout' && check.status === 'passed')).toBe(true)
      const oldNt = 'control-nt-strong-metadata-roundtrip'
      const oldNtResult = native.caseResults.find((item: { name: string }) => item.name === oldNt)
      expect(oldNtResult.role).toBe('diagnostic')
      expect(oldNtResult.capabilityCredit).toBe(false)
      const oldNtCalls = native.observations.filter((item: { caseName: string; api: string }) =>
        item.caseName === oldNt && item.api === 'NtSetInformationFile(FileRenameInformation)')
      expect(oldNtCalls.length).toBeGreaterThan(0)
      for (const call of oldNtCalls) expect(call.diagnosticOnly).toBe(true)
      const diagnostics = ['control-win32-strong-original-buffer', 'control-win32-metadata-original-buffer', 'control-win32-metadata-contract-roundtrip']
      for (const name of diagnostics) {
        const result = native.caseResults.find((item: { name: string }) => item.name === name)
        expect(result.role).toBe('diagnostic')
        expect(result.capabilityCredit).toBe(false)
        const calls = native.observations.filter((item: { caseName: string; api: string }) => item.caseName === name && item.api === 'SetFileInformationByHandle(FileRenameInfo)')
        expect(calls.length).toBeGreaterThan(0)
        for (const call of calls) expect(call.diagnosticOnly).toBe(true)
      }
      for (const name of diagnostics.slice(0, 2)) {
        const calls = native.observations.filter((item: { caseName: string; api: string }) =>
          item.caseName === name && item.api === 'SetFileInformationByHandle(FileRenameInfo)')
        expect(calls).toHaveLength(1)
        expect(calls[0].detail.contractLength).toBe(false)
        expect(calls[0].detail.nameBytesExcludingNul).toBe(22)
        expect(calls[0].detail.bufferBytesIncludingNul).toBe(architecture === 'x86' ? 36 : 44)
        const aliases = native.observations.filter((item: { caseName: string; api: string; name: string }) =>
          item.caseName === name && item.api === 'CreateFileW' && item.name === 'control-metadata-alias')
        expect(aliases).toHaveLength(name === diagnostics[0] ? 0 : 1)
      }
      const win32Roundtrip = native.caseResults.find((item: { name: string }) => item.name === 'control-win32-metadata-contract-roundtrip')
      for (const call of native.observations.filter((item: { caseName: string; api: string }) =>
        item.caseName === win32Roundtrip.name && item.api === 'SetFileInformationByHandle(FileRenameInfo)')) {
        expect(call.detail.contractLength).toBe(true)
        expect(call.detail.bufferBytesIncludingNul).toBe(architecture === 'x86' ? 38 : 46)
      }
      if (win32Roundtrip.completed) {
        expect(win32Roundtrip.fullRoundtrip).toBe(true)
        for (const name of ['relative-forward-existing-file-handle', 'prune-parent-after-weak-release', 'relative-restore-after-prune', 'restore-preserved-owned-payload-bytes']) {
          expect(native.diagnosticChecks.some((check: { caseName: string; name: string; status: string; capabilityCredit: boolean }) =>
            check.caseName === win32Roundtrip.name && check.name === name && check.status === 'observed-true' && check.capabilityCredit === false)).toBe(true)
        }
      }
      const ntCalls = native.observations.filter((item: { caseName: string; api: string }) =>
        item.caseName === chosen && item.api === 'NtSetInformationFile(FileRenameInformation)')
      expect(ntCalls).toHaveLength(2)
      expect(native.observations.filter((item: { caseName: string; api: string }) =>
        item.caseName === chosen && item.api === 'SetFileInformationByHandle(FileRenameInfo)')).toHaveLength(0)
      for (const call of ntCalls) {
        expect(call.diagnosticOnly).toBe(false)
        expect(call.informationClass).toBe(10)
        expect(call.success && call.callSucceeded && call.ioSucceeded && call.completed).toBe(true)
        expect(Number.parseInt(call.ioNtStatus, 16)).toBeLessThan(0x80000000)
        expect(call.ioNtStatus).not.toBe('00000103')
        if (call.callWasPending) expect(call.wait.result).toBe(0)
        else expect(Number.parseInt(call.callNtStatus, 16)).toBeLessThan(0x80000000)
        expect(call.errorSource).toContain('derived')
        expect(call.detail.contractLength).toBe(true)
        expect(call.detail.bufferBytesIncludingNul).toBe(architecture === 'x86' ? 38 : 46)
      }
      expect(native.directoryEntryNameOffset).toBe(104)
      expect(native.directoryEntryIdOffset).toBe(96)
      expect(native.controlledThreatBoundary).toContain('fresh private sandbox only')
      expect(native.controlledThreatBoundary).toContain('not installed ancestry')
      for (const key of ['sandboxBinding', 'fixtureBinding', 'outsideBinding']) {
        expect(native[key].directory && !native[key].reparse && !native[key].deletePending).toBe(true)
        expect(native[key].volume).toBe(native.sandboxBinding.volume)
        expect(native[key].fileId).toMatch(/^[0-9a-f]{16}$/)
        expect(native[key].canonical.toLowerCase()).toContain(resolve(sandbox).toLowerCase())
      }
      expect(mayCleanOwnedSandbox(true, native)).toBe(true)
      const oldShare1 = native.caseResults.find((item: { name: string }) => item.name === 'control-nt-readonly-share1-roundtrip')
      expect(oldShare1.role).toBe('diagnostic')
      expect(oldShare1.capabilityCredit).toBe(false)
      const chosenObservations = native.observations.filter((item: { caseName: string }) => item.caseName === chosen)
      expect(chosenObservations.some((item: { api: string }) => item.api === 'CreateFileW' || item.api === 'CreateDirectoryW')).toBe(false)
      const aliases = chosenObservations.filter((item: { api: string; name: string }) => item.api === 'OpenFileById' && /chosen-(?:stage|restore)-alias$/.test(item.name))
      expect(aliases).toHaveLength(2)
      for (const alias of aliases) {
        expect(alias.success).toBe(true)
        expect(alias.detail.access).toBe(0xa0)
        expect(alias.detail.share).toBe(7)
      }
      const guards = chosenObservations.filter((item: { api: string; name: string }) => item.api === 'OpenFileById' && item.name.endsWith('-readonly-guard'))
      expect(guards).toHaveLength(6)
      for (const guard of guards) {
        expect(guard.success).toBe(true)
        expect(guard.detail.access).toBe(0xa1)
        expect(guard.detail.share).toBe(3)
      }
      const creates = chosenObservations.filter((item: { api: string }) => item.api === 'NtCreateFile(FILE_CREATE)')
      expect(creates.filter((item: { directory: boolean }) => item.directory)).toHaveLength(6)
      for (const call of creates) {
        expect(call.success && call.completed && call.securityDescriptorNull).toBe(true)
        expect(call.ioInformation).toBe(2)
        expect(call.objectAttributes).toBe(0x1040)
        expect(call.createDisposition).toBe(2)
        expect(call.createOptions).toBe(call.directory ? 0x200021 : 0x200060)
        expect(call.leaf).toMatch(/^[a-z0-9][a-z0-9.-]*$/)
        expect(call.fallback).toBe(false)
        if (call.name.endsWith('-sentinel')) {
          expect(call.access).toBe(0x110080)
          expect(call.share).toBe(1)
        }
      }
      expect(chosenObservations.filter((item: { api: string }) => item.api === 'SetFileInformationByHandle(FileDispositionInfo)')).toHaveLength(4)
      for (const kind of ['child', 'parent']) {
        const name = `prune-${kind}`
        const position = (api: string, label: string) => chosenObservations.findIndex((item: { api: string; name: string }) => item.api === api && item.name === label)
        const closeGuard = position('CloseHandle', `move-${kind}-readonly-guard`)
        const open = position('NtCreateFile(FILE_OPEN)', `${name}-delete-pin`)
        const validate = position('ValidateNamedPruneCandidate', name)
        const closeWeak = position('CloseHandle', `move-${kind}-directory`)
        const deleteSentinel = position('SetFileInformationByHandle(FileDispositionInfo)', `${name}-sentinel-disposition`)
        const closeSentinel = position('CloseHandle', `move-${kind}-sentinel`)
        const deleteDirectory = position('SetFileInformationByHandle(FileDispositionInfo)', `${name}-directory-disposition`)
        const closePin = position('CloseHandle', `${name}-delete-pin`)
        expect(closeGuard).toBeGreaterThan(-1)
        for (const [earlier, later] of [[closeGuard, open], [open, validate], [validate, closeWeak], [closeWeak, deleteSentinel],
          [deleteSentinel, closeSentinel], [closeSentinel, deleteDirectory], [deleteDirectory, closePin]]) expect(later).toBeGreaterThan(earlier)
        const acquired = chosenObservations[open]
        expect(acquired.success).toBe(true)
        expect(acquired.access).toBe(0x1100a1)
        expect(acquired.share).toBe(1)
        expect(acquired.objectAttributes).toBe(0x1040)
        expect(acquired.createDisposition).toBe(1)
        expect(acquired.createOptions).toBe(0x200021)
        expect(acquired.ioInformation).toBe(1)
        expect(acquired.completed && !acquired.fallback).toBe(true)
        const validated = chosenObservations[validate]
        expect(validated.success).toBe(true)
        expect(validated.removalMutationPerformed).toBe(false)
        expect(validated.actual).toEqual(validated.expected)
        expect(validated.weak).toEqual(validated.expected)
        expect(chosenObservations[deleteDirectory].detail.handle).toBe(acquired.handle)
        expect(chosenObservations[deleteDirectory].success && chosenObservations[closePin].success).toBe(true)
        expect(chosenObservations.slice(deleteSentinel, deleteDirectory).some((item: { api: string }) =>
          /CreateFile|CreateDirectory|Rename/.test(item.api))).toBe(false)
      }
      const barrierCases = ['pre-junction-relative-create', 'sentinel-blocks-junction', 'ordinary-named-prune', 'last-sentinel-junction-disposition', 'last-sentinel-new-child-rejected']
      for (const name of barrierCases) {
        const result = native.caseResults.find((item: { name: string }) => item.name === name)
        expect(result.role).toBe('required')
        expect(result.completed && result.capabilityCredit).toBe(true)
      }
      const ordinaryNamed = native.observations.find((item: any) => item.api === 'NtCreateFile(FILE_OPEN)' && item.name === 'ordinary-named-prune-delete-pin')
      expect(ordinaryNamed.success && ordinaryNamed.completed).toBe(true)
      expect(ordinaryNamed.createDisposition).toBe(1)
      expect(ordinaryNamed.ioInformation).toBe(1)
      expect(ordinaryNamed.access).toBe(0x1100a1)
      expect(ordinaryNamed.share).toBe(1)
      const sets = native.observations.filter((item: { api: string }) => item.api === 'DeviceIoControl(FSCTL_SET_REPARSE_POINT)')
      expect(sets.length).toBeGreaterThanOrEqual(4)
      expect(new Set(sets.map((item: any) => item.detail.bufferBase64)).size).toBe(1)
      for (const call of sets) {
        expect(call.detail.access).toBe(0x180)
        expect(call.detail.share).toBe(7)
        expect(call.detail.synchronous && call.detail.bytesReturnedPointerNonNull).toBe(true)
      }
      const blocked = sets.find((item: { caseName: string }) => item.caseName === 'sentinel-blocks-junction')
      expect(blocked.success).toBe(false)
      expect(blocked.win32Error).toBe(145)
      for (const name of ['pre-junction-relative-create', 'last-sentinel-junction-disposition']) {
        expect(sets.find((item: { caseName: string }) => item.caseName === name).success).toBe(true)
        const get = native.observations.find((item: any) => item.caseName === name && item.api === 'DeviceIoControl(FSCTL_GET_REPARSE_POINT)' && item.detail.exactTarget)
        expect(get.success && get.detail.sameIdentity).toBe(true)
        expect(get.detail.reparseTag).toBe('a0000003')
      }
      const hostile = native.observations.find((item: any) => item.name === 'hostile-root-sentinel' && item.api === 'NtCreateFile(FILE_CREATE)')
      expect(hostile.objectAttributes).toBe(0x1040)
      expect(hostile.createOptions).toBe(0x200060)
      expect(hostile.access).toBe(0x110080)
      expect(hostile.share).toBe(1)
      expect(hostile.completed).toBe(true)
      if (!hostile.success) {
        expect(hostile.handle).toBe(0)
        expect(['c0000280', 'c000050b']).toContain(hostile.callNtStatus)
        expect(hostile.callNtStatus).not.toBe('00000103')
      }
      const ordinaryPair = native.observations.find((item: any) => item.api === 'NtCreateFile(FILE_CREATE)' && item.name === 'pre-junction-positive-sentinel')
      expect(ordinaryPair.success && ordinaryPair.completed).toBe(true)
      expect(ordinaryPair.ioInformation).toBe(2)
      for (const key of ['rootDirectoryHandle', 'leaf', 'access', 'share', 'objectAttributes', 'createDisposition', 'createOptions']) {
        expect(ordinaryPair[key]).toBe(hostile[key])
      }
      expect(native.checks.find((item: any) => item.name === 'pre-junction-paired-target-empty-before-set').status).toBe('passed')
      expect(native.checks.find((item: any) => item.name === 'named-prune-managed-contracts').detail.pureCases).toBe(38)
      expect(chosenObservations.filter((item: any) => item.api === 'NtCreateFile(FILE_OPEN)')).toHaveLength(2)
      expect(chosenObservations.some((item: any) => item.api === 'OpenFileById' && (item.detail.access & 0x10000) !== 0)).toBe(false)
      expect(native.checks.find((item: any) => item.name === 'pre-junction-create-no-outside-effect').status).toBe('passed')
      expect(native.checks.find((item: any) => item.name === 'pre-junction-root-admission-still-rejected').detail.admissionGranted).toBe(false)
      const finalCase = native.observations.filter((item: any) => item.caseName === 'last-sentinel-junction-disposition')
      const finalPin = finalCase.find((item: any) => item.api === 'NtCreateFile(FILE_OPEN)' && item.name === 'last-sentinel-delete-pin')
      const finalDisposition = finalCase.find((item: any) => item.api === 'SetFileInformationByHandle(FileDispositionInfo)' && item.name === 'last-sentinel-directory-disposition')
      expect(finalDisposition.success).toBe(true)
      expect(finalDisposition.detail.handle).toBe(finalPin.handle)
      const lateChild = native.observations.find((item: any) => item.name === 'late-child-directory-disposition' && item.api === 'SetFileInformationByHandle(FileDispositionInfo)')
      expect(lateChild.success).toBe(false)
      expect(lateChild.win32Error).toBe(145)
      const unprotected = native.caseResults.find((item: any) => item.name === 'control-nt-no-sentinel-pre-junction')
      expect(unprotected.role).toBe('diagnostic')
      expect(unprotected.capabilityCredit).toBe(false)
      for (const [caseName, reason] of [['byid-reject-canonical-drift', 'canonical-drift'], ['byid-reject-id-mismatch', 'id-mismatch']]) {
        const result = native.caseResults.find((item: { name: string }) => item.name === caseName)
        expect(result.role).toBe('required')
        expect(result.completed).toBe(true)
        const observations = native.observations.filter((item: { caseName: string }) => item.caseName === caseName)
        expect(observations.filter((item: { api: string }) => item.api === 'OpenFileById')).toHaveLength(1)
        const validation = observations.find((item: { api: string }) => item.api === 'ValidateByIdPruneCandidate')
        expect(validation.success).toBe(false)
        expect(validation.reason).toBe(reason)
        expect(validation.weakStillLive).toBe(true)
        expect(validation.removalMutationPerformed).toBe(false)
        if (reason === 'canonical-drift') {
          expect(validation.actualId).toBe(validation.expectedId)
          expect(validation.actualCanonical).not.toBe(validation.expectedCanonical)
          expect(observations.some((item: { api: string; success: boolean }) =>
            item.api === 'MoveFileExW(owned-fixture-barrier)' && item.success)).toBe(true)
        } else expect(validation.actualId).not.toBe(validation.expectedId)
        expect(observations.some((item: { api: string }) => item.api === 'SetFileInformationByHandle(FileDispositionInfo)')).toBe(false)
        expect(native.checks.some((check: { caseName: string; name: string; status: string }) =>
          check.caseName === caseName && check.name === 'rejection-keeps-owned-sentinels' && check.status === 'passed')).toBe(true)
      }
      for (const reason of ['canonical-drift', 'id-mismatch', 'reparse']) {
        const caseName = `named-prune-reject-${reason}`
        const result = native.caseResults.find((item: any) => item.name === caseName)
        expect(result.role).toBe('required')
        expect(result.completed).toBe(true)
        const calls = native.observations.filter((item: any) => item.caseName === caseName)
        const named = calls.filter((item: any) => item.api === 'NtCreateFile(FILE_OPEN)' && item.name === 'named-rejection-delete-pin')
        expect(named).toHaveLength(1)
        expect(named[0].createDisposition).toBe(1)
        expect(named[0].access).toBe(0x1100a1)
        expect(named[0].share).toBe(1)
        const validation = calls.find((item: any) => item.api === 'ValidateNamedPruneCandidate')
        expect(validation.success).toBe(false)
        expect(validation.reason).toBe(reason)
        expect(validation.removalMutationPerformed || validation.fallback).toBe(false)
        expect(validation.weak.fileId).toBe(validation.expected.fileId)
        expect(calls.some((item: any) => item.api === 'SetFileInformationByHandle(FileDispositionInfo)')).toBe(false)
        if (reason === 'reparse') {
          expect(calls.find((item: any) => item.name === 'named-rejection-set').success).toBe(true)
          expect(calls.find((item: any) => item.name === 'named-rejection-get').detail.exactTarget).toBe(true)
        } else {
          const moves = calls.filter((item: any) => item.api === 'MoveFileExW(owned-fixture-barrier)')
          expect(moves).toHaveLength(reason === 'id-mismatch' ? 2 : 1)
          expect(moves.every((item: any) => item.success)).toBe(true)
          expect(validation.weak.canonical).not.toBe(validation.expected.canonical)
          if (reason === 'id-mismatch') {
            expect(named[0].success && named[0].completed).toBe(true)
            expect(named[0].ioInformation).toBe(1)
            expect(validation.actual.fileId).not.toBe(validation.expected.fileId)
          }
        }
      }
      for (const caseName of ['weak-lifetime', 'shared-reader-lifetime']) {
        expect(native.checks.some((check: { caseName?: string; name: string; status: string }) =>
          check.caseName === caseName && check.name === 'retained-handle-keeps-pending-object-live' && check.status === 'passed')).toBe(true)
      }
      expect(native.crossProcessPinnedAck).toBe('not_run')
      expect(native.completeFailureRestore).toBe('unknown')
      report.status = 'passed'
    } catch (error) {
      originalFailure = true
      report.status = 'failed'
      report.error = String(error)
      throw error
    } finally {
      let cleanupFailure: unknown
      try {
        if (mayCleanOwnedSandbox(nativeStarted, native)) {
          removeOwnedPlainTree(sandbox)
          report.cleanup = { status: existsSync(sandbox) ? 'failed' : 'passed', temporaryRootRemoved: !existsSync(sandbox), recursiveRmUsed: false }
        } else {
          report.cleanup = { status: 'unknown', temporaryRootRemoved: false, retainedOwnedRoot: sandbox,
            reason: 'Native completion, reparse state or handle closure is unknown', recursiveRmUsed: false }
          cleanupFailure = new Error('Owned native arena retained because cleanup is not proven safe')
        }
      } catch (error) {
        cleanupFailure = error
        report.cleanup = { status: 'failed', temporaryRootRemoved: false, retainedOwnedRoot: sandbox, error: String(error), recursiveRmUsed: false }
      } finally {
        if (cleanupFailure) report.status = 'failed'
        writeFileSync(join(evidence, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
      }
      if (cleanupFailure && !originalFailure) throw cleanupFailure
    }
  }, 90_000)
}
