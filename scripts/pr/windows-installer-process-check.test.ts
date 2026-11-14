import { describe, expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createSandboxedTestEnvironment } from './test-environment'
import { renderInstallProcessHelperNsh } from '../../desktop/scripts/generate-install-process-helper-nsh'
import { fallbackApiCases, frozenResidualMacrosSha256, readFallbackMacros, renderFallbackApiHarness, renderResidualFindApiHarness, renderResidualFindNativeHarness, residualFindApiCases } from './windows-installer-native-fixtures'
import { compileInstallerPathCases, guardedRemovalCompilerFixturePe, installerPathCases } from './windows-installer-template-fixtures'

const legacyTemplate = createRequire(import.meta.url)('../../desktop/scripts/nsis-legacy-compat.cjs') as {
  adaptInstallUtil(source: string): string
  defaultRemoveFiles(source: string): string
  pins: Record<string, string>
  prepare(options: { vendorRoot: string; uninstaller: string; bootstrap: string; temporaryParent: string; compilerCwd?: string }): { directory: string; owner: string }
  cleanup(directory: string, owner: string): void
  prepareGuarded(options: { vendorRoot: string; source: string; bootstrap: string; temporaryParent: string; compilerCwd: string; compile: (options: { source: string; directory: string }) => Record<string, unknown> }): { directory: string; owner: string }
}
const legacyVendorRoot = (() => {
  if (process.env.CC_HAHA_TEST_NSIS_VENDOR) return process.env.CC_HAHA_TEST_NSIS_VENDOR
  try { return path.dirname(createRequire(path.resolve('desktop/package.json')).resolve('app-builder-lib/package.json')) } catch { return undefined }
})()

function sha256(source: string | Buffer) {
  return createHash('sha256').update(source).digest('hex')
}

function preserveResidualEvidence(name: string, evidence: Record<string, unknown>, files: Record<string, string> = {}) {
  const directory = path.resolve('artifacts/windows-installer/residual-matches')
  mkdirSync(directory, { recursive: true })
  for (const [suffix, text] of Object.entries(files)) {
    writeFileSync(path.join(directory, `${name}.${suffix}`), text)
  }
  writeFileSync(path.join(directory, `${name}.json`), `${JSON.stringify({
    ...evidence,
    recordedAtUtc: new Date().toISOString(),
    platform: process.platform,
    frozenSourceCommit: '3babd7615c2a4abf6408e5d50d3a2615ce429dce',
    frozenResidualMacrosSha256,
    releasedPeRun: false,
    originalUserScenario: 'not_run',
  }, null, 2)}\n`)
}

function residualRunFiles(journal: string) {
  const files: Record<string, string> = {}
  for (const [suffix, file] of [['log', journal], ['csv', `${journal}.csv`], ['residual.csv', `${journal}.residual.csv`]]) {
    if (existsSync(file!)) files[suffix!] = readFileSync(file!, 'utf8')
  }
  return files
}

function decodeFileWrites(nsh: string): string {
  return [...nsh.matchAll(/^\s*FileWrite \$0 "(.*)"$/gm)]
    .map(([, literal]) => literal!.replace(/\$(\$|\\"|\\n)/g, (_, escape: string) =>
      escape === '$' ? '$' : escape === '\\"' ? '"' : '\n'))
    .join('')
}

const guardedBuild = createRequire(import.meta.url)('../../desktop/scripts/nsis-guarded-removal.cjs') as {
  clrConfig: Buffer
  compile(options: Record<string, unknown>): { executable: string; bytes: number; sha256: string; config: string; configBytes: number; configSha256: string; sourceSha256: string; compiler: string }
  validatePe(bytes: Buffer): void
}

describe('Windows guarded removal build and launch boundaries', () => {
  const fixture = () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'cc-haha-guarded-compiler-')))
    const windowsDirectory = path.join(root, 'Windows')
    const framework = path.join(windowsDirectory, 'Microsoft.NET', 'Framework', 'v4.0.30319')
    const directory = path.join(root, 'output')
    mkdirSync(framework, { recursive: true })
    mkdirSync(directory)
    for (const name of ['csc.exe', 'mscorlib.dll', 'System.dll', 'System.Core.dll']) writeFileSync(path.join(framework, name), 'Owned fixture; never executed')
    const source = path.join(root, 'source.cs')
    writeFileSync(source, '// Owned fake-compiler input; no product backend execution.\n')
    const spawn = (_compiler: string, args: string[]) => {
      writeFileSync(args.find(item => item.startsWith('/out:'))!.slice(5), guardedRemovalCompilerFixturePe(), { flag: 'wx' })
      return { status: 0, stdout: '', stderr: '' }
    }
    return { root, windowsDirectory, framework, directory, source, spawn }
  }

  test('uses system CLR4 CSC with fixed x86 flags and explicit framework references (fake compiler)', () => {
    const item = fixture()
    const calls: Array<{ compiler: string; args: string[]; options: Record<string, unknown> }> = []
    try {
      const result = guardedBuild.compile({ ...item, platform: 'win32', spawn: (compiler: string, args: string[], options: Record<string, unknown>) => {
        calls.push({ compiler, args, options })
        return item.spawn(compiler, args)
      } })
      expect(calls).toHaveLength(1)
      expect(calls[0]!.compiler).toBe(path.join(item.framework, 'csc.exe'))
      expect(calls[0]!.args).toEqual(['/nologo', '/noconfig', '/nostdlib+', '/target:exe', '/platform:x86', '/optimize+', '/checked+', '/warnaserror+',
        ...['mscorlib.dll', 'System.dll', 'System.Core.dll'].map(name => `/reference:${path.join(item.framework, name)}`),
        `/out:${path.join(item.directory, 'guarded-removal.exe')}`, path.join(item.directory, 'guarded-removal.cs')])
      expect(calls[0]!.options.cwd).toBe(item.framework)
      expect(calls[0]!.options.shell).toBe(false)
      expect(Object.keys(calls[0]!.options.env as Record<string, string>).some(name => /^(?:COR_|CORECLR_|COMPLUS_|DOTNET_|APPDOMAIN_|DEVPATH$|__COMPAT_LAYER$)/i.test(name))).toBe(false)
      expect(result.sha256).toBe(sha256(readFileSync(result.executable)))
      expect(result.bytes).toBe(guardedRemovalCompilerFixturePe().length)
      expect(readFileSync(result.config)).toEqual(guardedBuild.clrConfig)
      expect(result.configSha256).toBe(sha256(guardedBuild.clrConfig))
      expect(result.sourceSha256).toBe(sha256(readFileSync(item.source)))
    } finally { rmSync(item.root, { recursive: true, force: true }) }
  })

  test('rejects non-Windows production compilation, compiler failure, wrong architecture and non-PE output', () => {
    if (process.platform !== 'win32') expect(() => guardedBuild.compile({})).toThrow('must be built on Windows')
    const item = fixture()
    try {
      expect(() => guardedBuild.compile({ ...item, platform: 'win32', spawn: () => ({ status: 1, stderr: 'owned compiler failure' }) })).toThrow('owned compiler failure')
      expect(() => guardedBuild.validatePe(Buffer.from('MZ-invalid'))).toThrow('produce a PE')
      const x64 = guardedRemovalCompilerFixturePe()
      x64.writeUInt16LE(0x8664, 0x84)
      expect(() => guardedBuild.validatePe(x64)).toThrow('x86 CLR PE')
      const anyCpu = guardedRemovalCompilerFixturePe()
      anyCpu.writeUInt32LE(1, 0x1a0 + 16)
      expect(() => guardedBuild.validatePe(anyCpu)).toThrow('require 32 bits')
      const truncated = guardedRemovalCompilerFixturePe().subarray(0, 440)
      expect(() => guardedBuild.validatePe(truncated)).toThrow('require 32 bits')
    } finally { rmSync(item.root, { recursive: true, force: true }) }
  })

  test.skipIf(!legacyVendorRoot)('binds final helper/config bytes and keeps exact vendor default removal plus normal restore', () => {
    const item = fixture()
    let generated: { directory: string; owner: string } | undefined
    try {
      const bootstrap = path.join(item.root, 'bootstrap.nsh')
      const options = { vendorRoot: legacyVendorRoot!, source: item.source, bootstrap, temporaryParent: item.root,
        compilerCwd: path.join(legacyVendorRoot!, 'templates/nsis') }
      generated = legacyTemplate.prepareGuarded({ ...options, compile: values => guardedBuild.compile({ ...values, windowsDirectory: item.windowsDirectory, platform: 'win32', spawn: item.spawn }) })
      const helper = path.join(generated.directory, 'guarded-removal.exe')
      const definitions = readFileSync(bootstrap, 'utf8')
      expect(definitions).toContain(`CC_HAHA_GUARDED_HELPER_SHA256 "${sha256(readFileSync(helper))}"`)
      expect(definitions).toContain(`CC_HAHA_GUARDED_HELPER_BYTES ${readFileSync(helper).length}`)
      expect(definitions).toContain(`CC_HAHA_GUARDED_CONFIG_SHA256 "${sha256(guardedBuild.clrConfig)}"`)
      const vendor = readFileSync(path.join(legacyVendorRoot!, 'templates/nsis/uninstaller.nsh'), 'utf8')
      const extracted = legacyTemplate.defaultRemoveFiles(vendor)
      expect(extracted).toContain('Call un.restoreFiles')
      expect(readFileSync(path.join(generated.directory, 'default-remove-files.nsh'), 'utf8')).toBe(`!macro CcHahaVendorDefaultRemoveFiles\n${extracted}!macroend\n`)
      expect(vendor).toContain(`  !else\n${extracted}  !endif\n\n  $` + '{ifNot} ${isKeepShortcuts}')
      expect(() => legacyTemplate.defaultRemoveFiles(vendor.replace('Call un.restoreFiles', 'Call un.changedRestore'))).toThrow('Unreviewed')
      const before = readdirSync(item.root).filter(name => name.startsWith('cc-haha-nsis-compat-'))
      expect(() => legacyTemplate.prepareGuarded({ ...options, compile: () => { throw new Error('owned rejected compiler') } })).toThrow('owned rejected compiler')
      expect(readdirSync(item.root).filter(name => name.startsWith('cc-haha-nsis-compat-'))).toEqual(before)
    } finally {
      if (generated) legacyTemplate.cleanup(generated.directory, generated.owner)
      rmSync(item.root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform !== 'win32' && process.env.CC_HAHA_TEST_NSIS_COMPILE_ONLY !== '1')('hands original capabilities through two real NSIS boundaries into an owned CLR fixture (Mac compiles only)', async () => {
    const compiler = process.env.CC_HAHA_TEST_MAKENSIS
    const resources = process.env.CC_HAHA_TEST_NSIS_RESOURCES
    if (!compiler || !resources || !legacyVendorRoot) throw new Error('Run the prepared pinned Windows installer lane')
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'cc-haha-guarded-two-hop-')))
    const env = createSandboxedTestEnvironment(path.join(root, 'home'))
    const source = path.join(root, 'handoff.cs')
    const output = path.join(root, 'helper')
    mkdirSync(output)
    // This separate test entry point never reads product registry/profile state.
    // Its only mutation is delete/recreate of an empty, newly owned root after
    // both NSIS parents and the fixture close all original weak capabilities.
    writeFileSync(source, String.raw`using System;
using System.IO;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class OwnedHandoff {
  [StructLayout(LayoutKind.Sequential)] public struct Info { public uint A,CL,CH,AL,AH,WL,WH,V,SH,SL,N,IH,IL; }
  [StructLayout(LayoutKind.Sequential)] public struct Time { public uint L,H; }
  [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetFileInformationByHandle(IntPtr h,out Info i);
  [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetHandleInformation(IntPtr h,out uint f);
  [DllImport("kernel32.dll",SetLastError=true)] public static extern bool SetHandleInformation(IntPtr h,uint m,uint f);
  [DllImport("kernel32.dll",SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll",SetLastError=true)] public static extern uint GetProcessId(IntPtr h);
  [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetProcessTimes(IntPtr h,out Time c,out Time e,out Time k,out Time u);
  [DllImport("kernel32.dll",SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr h,uint ms);
  public static IntPtr Handle(string s) { return new IntPtr(unchecked((int)UInt32.Parse(s))); }
  public static void Require(bool b) { if(!b) throw new Exception("owned handoff rejection"); }
  public static void Stage(string root,string text) { try { File.AppendAllText(root+".clr.log",text+Environment.NewLine); } catch(Exception) {} }
  public static int Main(string[] args) {
    string root = "",phase="arguments";
    try {
      Require(IntPtr.Size==4 && args.Length==4 && args[0]=="--cc-guarded-removal=1");
      Require(args[1].StartsWith("--root=") && args[2].StartsWith("--capabilities=") && args[3].StartsWith("--parent="));
      root=args[1].Substring(7);
      Stage(root,"main-enter;pointerBytes="+IntPtr.Size);
      var p=args[3].Substring(9).Split(':'); Require(p.Length==4);
      IntPtr parent=Handle(p[0]); uint flags; Time creation,exit,kernel,user;
      phase="parent-inheritance"; bool parentInfo=GetHandleInformation(parent,out flags); int nativeError=Marshal.GetLastWin32Error();
      Stage(root,"parent-info;handle="+parent.ToInt64()+";success="+parentInfo+";flags="+flags+";error="+nativeError);
      Require(parentInfo && (flags&1)==1 && SetHandleInformation(parent,1,0));
      phase="parent-pid"; uint parentPid=GetProcessId(parent); Stage(root,"parent-pid;actual="+parentPid+";expected="+p[1]); Require(parentPid==UInt32.Parse(p[1]));
      phase="parent-times"; bool parentTimes=GetProcessTimes(parent,out creation,out exit,out kernel,out user); nativeError=Marshal.GetLastWin32Error();
      Stage(root,"parent-times;success="+parentTimes+";low="+creation.L+";high="+creation.H+";error="+nativeError); Require(parentTimes);
      Require(creation.L==UInt32.Parse(p[2]) && creation.H==UInt32.Parse(p[3]) && WaitForSingleObject(parent,0)==258);
      phase="weak-capabilities";
      var handles=new List<IntPtr>(); var ids=new HashSet<IntPtr>();
      foreach(string tuple in args[2].Substring(15).Split(',')) {
        var x=tuple.Split(':'); Require(x.Length==4); IntPtr h=Handle(x[0]); Info i;
        Require(h!=parent && ids.Add(h) && GetHandleInformation(h,out flags) && (flags&1)==1 && SetHandleInformation(h,1,0));
        Require(GetFileInformationByHandle(h,out i) && (i.A&0x410)==0x10 && i.V==UInt32.Parse(x[1]) && i.IL==UInt32.Parse(x[2]) && i.IH==UInt32.Parse(x[3]));
        handles.Add(h);
      }
      Require(handles.Count>=2);
      Stage(root,"weak-verified;count="+handles.Count);
      foreach(IntPtr h in handles) Require(CloseHandle(h));
      phase="empty-root-delete-recreate"; Stage(root,"weak-closed");
      Require(WaitForSingleObject(parent,0)==258 && Directory.GetFileSystemEntries(root).Length==0);
      Directory.Delete(root,false);
      Require(!Directory.Exists(root));
      Directory.CreateDirectory(root); // Fails if a parent retained a delete-pending weak root.
      Require(WaitForSingleObject(parent,0)==258 && CloseHandle(parent));
      File.WriteAllText(root+".handoff.log","all-inherited-ids-and-parent-verified;all-weak-closed;empty-root-deleted-and-recreated");
      Stage(root,"main-exit;code=0");
      return 0;
    } catch(Exception e) { if(root!="") { Stage(root,"main-rejected;phase="+phase+";type="+e.GetType().FullName); File.WriteAllText(root+".rejected.log",e.ToString()); } return 22; }
  }
}
`)
    let helper: ReturnType<typeof guardedBuild.compile>
    if (process.platform === 'win32') helper = guardedBuild.compile({ source, directory: output, environment: env })
    else {
      const executable = path.join(output, 'guarded-removal.exe')
      writeFileSync(executable, guardedRemovalCompilerFixturePe())
      writeFileSync(`${executable}.config`, guardedBuild.clrConfig)
      helper = { executable, config: `${executable}.config`, bytes: guardedRemovalCompilerFixturePe().length,
        sha256: sha256(guardedRemovalCompilerFixturePe()), configBytes: guardedBuild.clrConfig.length,
        configSha256: sha256(guardedBuild.clrConfig), sourceSha256: sha256(readFileSync(source)), compiler: 'injected non-runnable fixture' }
    }
    const production = readFileSync('desktop/build/guarded-removal-launch.nsh', 'utf8').replace(/\r\n/g, '\n')
    // This ledger is inserted only into the owned compiled fixture copies.
    // Preserve registers, NSIS Errors and thread LastError around diagnostics.
    const stageMacro = (file: string, role: string) => String.raw`
!macro FixtureStage _TEXT
  System::Call 'kernel32::GetLastError() i.s'
  Push $0
  Push $1
  StrCpy $1 0
  IfErrors 0 +2
    StrCpy $1 1
  ClearErrors
  FileOpen $0 "${file}" a
  ${'${IfNot}'} ${'${Errors}'}
    FileWrite $0 "${role};${'${_TEXT}'}$\r$\n"
    FileClose $0
  ${'${EndIf}'}
  ${'${If}'} $1 == 1
    SetErrors
  ${'${Else}'}
    ClearErrors
  ${'${EndIf}'}
  Pop $1
  Pop $0
  System::Call 'kernel32::SetLastError(i s)'
!macroend
`
    const instrument = (text: string) => text.split('\n').map(line => {
      let detail = ''
      if (line.includes("System::Call 'kernel32::CreateFileW(w \"$ccHahaGuardPath\"")) detail = 'directory-open;handle=$R1;path=$ccHahaGuardPath'
      if (line.includes("System::Call 'kernel32::GetFileType(p R1) i.R5")) detail = 'identity-type;result=$R5;path=$ccHahaGuardPath'
      if (line.includes("System::Call 'kernel32::GetFileType(p R1) i.R2")) detail = 'receive-type;result=$R2;handle=$R1'
      if (line.includes("System::Call 'kernel32::GetFileInformationByHandle(p R1,")) detail = 'identity-info;result=$R5;handle=$R1;path=$ccHahaGuardPath'
      if (line.includes("System::Call '*$ccHahaGuardInformation(i.R5,")) detail = 'identity-info-fields;attrs=$R5;volume=$R2;low=$R3;high=$R4'
      if (line.includes("System::Call 'kernel32::GetFileInformationByHandleEx(p R1,")) detail = 'identity-standard;result=$R5;handle=$R1;path=$ccHahaGuardPath'
      if (line.includes("System::Call '*$ccHahaGuardStandard(l, l, i,")) detail = 'identity-standard-fields;pending=$R5;directory=$R6'
      if (line.includes("System::Call 'kernel32::GetFinalPathNameByHandleW(p R1,")) detail = 'identity-final;length=$R6;expected=$ccHahaGuardPath;observed=$R5'
      if (line.trim() === 'cc_haha_guard_capture_done:') detail = 'capture;ok=$ccHahaGuardOk;count=$ccHahaGuardCount;root=$ccHahaGuardRoot'
      if (line.trim() === 'cc_haha_guard_revalidate_done:') detail = 'revalidate;ok=$ccHahaGuardOk;count=$ccHahaGuardCount;root=$ccHahaGuardRoot'
      if (line.trim() === 'cc_haha_guard_root_done:') detail = 'root-syntax;ok=$ccHahaGuardOk;root=$ccHahaGuardRoot'
      if (line.trim() === 'cc_haha_guard_code_root_done:') detail = 'code-pin;ok=$ccHahaGuardOk;application=$ccHahaGuardApplication'
      if (line.includes("System::Call 'kernel32::GetFinalPathNameByHandleW(p $ccHahaGuardCode,")) detail = 'code-final;length=$R2;expected=$ccHahaGuardApplication;observed=$R1'
      if (line.includes("System::Call 'kernel32::OpenProcess(")) detail = 'self-cap-open;handle=$R2'
      if (line.includes("System::Call 'kernel32::GetHandleInformation(p $ccHahaGuardParent,")) detail = 'receive-parent-info;result=$R1;flags=$R0;parent=$ccHahaGuardParent'
      if (line.includes("System::Call 'kernel32::GetProcessId(p $ccHahaGuardParent)")) detail = 'receive-parent-pid;actual=$R0;expected=$ccHahaGuardParentPid'
      if (line.includes("System::Call 'kernel32::GetProcessTimes(p $ccHahaGuardParent,")) detail = 'receive-parent-times;result=$R4'
      if (line.includes("System::Call 'kernel32::UpdateProcThreadAttribute(")) detail = 'inherit-list;result=$R1;count=$ccHahaGuardCount'
      if (line.includes("System::Call 'kernel32::CreateProcessW(")) detail = 'create;result=$R0;count=$ccHahaGuardCount;application=$ccHahaGuardApplication'
      if (line.trim() === 'Call ${CC_HAHA_GUARD_PREFIX}CcHahaGuardCloseWeak') detail = 'weak-close-before-resume;ok=$ccHahaGuardOk;count=$ccHahaGuardCount'
      if (line.includes("System::Call 'kernel32::CloseHandle(p $ccHahaGuardOwnProcess)")) detail = 'self-cap-close;result=$R0'
      if (line.includes("System::Call 'kernel32::ResumeThread(")) detail = 'resume;previous=$R0'
      if (line.includes("System::Call 'kernel32::GetExitCodeProcess(")) detail = 'child-exit;query=$R1;exit=$R0'
      if (line.trim() === 'cc_haha_guard_launch_done:') detail = 'launch-finish;exit=$ccHahaGuardExit;resumed=$ccHahaGuardResumed;process=$ccHahaGuardProcess'
      if (line.trim() === 'cc_haha_guard_receive_arguments:') detail = 'receive-arguments;root=$ccHahaGuardRoot'
      if (line.trim() === '${GetParameters} $R0') detail = 'receive-parameters;value=$R0'
      if (line.trim() === 'cc_haha_guard_receive_validate:') detail = 'receive-parsed;count=$ccHahaGuardCount;root=$ccHahaGuardRoot'
      if (line.trim() === 'Call un.CcHahaGuardReceiveParent') detail = 'receive-parent;ok=$ccHahaGuardOk;parent=$ccHahaGuardParent'
      if (line.trim() === 'cc_haha_guard_receive_done:') detail = 'receive-finish;mode=$ccHahaGuardMode;count=$ccHahaGuardCount;root=$ccHahaGuardRoot'
      if (line.trim() === 'cc_haha_guard_remove_done:') detail = 'remove-finish;exit=$ccHahaGuardExit'
      if (line.trim().startsWith('IntCmp $R0 ${NSIS_MAX_STRLEN} cc_haha_guard_launch_done')) {
        return `  !insertmacro FixtureStage "command-bound;size=$R0;root=$ccHahaGuardRoot"\n${line}`
      }
      if (!detail) return line
      if (line.trim().startsWith("System::Call 'kernel32::") && !line.endsWith(" ?e'")) {
        return `${line.slice(0, -1)} ?e'\n  Pop $fixtureNativeError\n  !insertmacro FixtureStage "${detail};nativeError=$fixtureNativeError"`
      }
      return `${line}\n  !insertmacro FixtureStage "${detail}"`
    }).join('\n')
    const include = path.join(root, 'guarded.nsh')
    const currentStages = path.join(root, 'current.stages.log')
    writeFileSync(include, instrument(production))
    const common = String.raw`Unicode true
RequestExecutionLevel user
SilentInstall silent
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!addplugindir /x86-unicode "${path.join(resources, 'plugins/x86-unicode')}"
!include "${path.join(legacyVendorRoot, 'templates/nsis/include/StdUtils.nsh')}"
Var fixtureNativeError
`
    const compile = (name: string, text: string) => {
      const file = path.join(root, `${name}.nsi`)
      writeFileSync(file, text)
      const prefix = process.platform === 'win32' ? '/' : '-'
      const result = spawnSync(compiler, [`${prefix}WX`, `${prefix}V2`, file], {
        env: { ...env, NSISDIR: path.resolve(path.dirname(compiler), '..') }, encoding: 'utf8', timeout: 30_000,
      })
      expect(result.error, result.stderr || result.stdout).toBeUndefined()
      expect(result.status, result.stderr || result.stdout).toBe(0)
    }
    const current = path.join(root, 'current.exe')
    let safeToClean = true
    const preserveHandoffEvidence = (name: string, run: { status: number | null; error?: Error }, expected: number, files: Record<string, string>) => {
      // Copy bounded owned metadata before assertions/finally can remove the
      // disposable fixture. No executable or file payload enters evidence.
      const evidence = path.resolve('artifacts/windows-installer/guarded-two-hop')
      mkdirSync(evidence, { recursive: true })
      const metadata = { name, status: run.status, expected, error: run.error?.message,
        root, temp: env.TEMP, tmp: env.TMP, productionLfSha256: sha256(production), files: {} as Record<string, { bytes: number; truncated: boolean }> }
      for (const [kind, file] of Object.entries(files)) {
        if (!existsSync(file)) continue
        const bytes = readFileSync(file)
        metadata.files[kind] = { bytes: bytes.length, truncated: bytes.length > 65536 }
        writeFileSync(path.join(evidence, `${name}.${kind}.log`), bytes.subarray(0, 65536))
      }
      writeFileSync(path.join(evidence, `${name}.json`), `${JSON.stringify(metadata, null, 2)}\n`)
      if (run.error || run.status !== expected) safeToClean = false
      return metadata
    }
    try {
      const wrapper = path.join(root, 'wrapper.exe')
      compile('current-wrapper', common + stageMacro(currentStages, 'current') + String.raw`Name "Owned capability receiver"
OutFile "${wrapper}"
!define BUILD_UNINSTALLER
!define CC_HAHA_GUARDED_HELPER_FILE "${helper.executable}"
!define CC_HAHA_GUARDED_HELPER_BYTES ${helper.bytes}
!define CC_HAHA_GUARDED_HELPER_SHA256 "${helper.sha256}"
!define CC_HAHA_GUARDED_CONFIG_FILE "${helper.config}"
!define CC_HAHA_GUARDED_CONFIG_BYTES ${helper.configBytes}
!define CC_HAHA_GUARDED_CONFIG_SHA256 "${helper.configSha256}"
!include "${include}"
!insertmacro CcHahaGuardFunctions
!insertmacro CcHahaGuardUninstallerFunctions
Section
  WriteUninstaller "${current}"
SectionEnd
Section "un.Uninstall"
  SetOutPath $INSTDIR
  Call un.CcHahaGuardReceive
  ${'${If}'} $ccHahaGuardMode == 1
    Call un.CcHahaGuardedRemove
    SetErrorLevel $ccHahaGuardExit
  ${'${Else}'}
    SetErrorLevel 22
  ${'${EndIf}'}
  Quit
SectionEnd
`)
      const require = createRequire(path.join(legacyVendorRoot, 'package.json'))
      require('./out/index.js')
      await require('./out/targets/nsis/nsisUtil.js').UninstallerReader.exec(wrapper, current)
      for (const item of [
        { name: 'complete', expected: 0, resumes: 1, terminates: 0 },
        { name: 'wrong-code-hash', expected: 22, resumes: 0, terminates: 0 },
        { name: 'weak-close-failure', expected: 22, resumes: 0, terminates: 1 },
        { name: 'resume-unknown', expected: 22, resumes: 1, terminates: 0 },
      ]) {
        const owned = path.join(root, item.name)
        mkdirSync(owned)
        let adapted = production
          .replace("System::Call 'kernel32::ResumeThread(p $ccHahaGuardThread) i.R0'", "IntOp $fixtureResumes $fixtureResumes + 1\n  System::Call 'kernel32::ResumeThread(p $ccHahaGuardThread) i.R0'" + (item.name === 'resume-unknown' ? '\n  StrCpy $R0 0' : ''))
          .replace("System::Call 'kernel32::TerminateProcess(p $ccHahaGuardProcess, i 22) i.R0'", "IntOp $fixtureTerminates $fixtureTerminates + 1\n        System::Call 'kernel32::TerminateProcess(p $ccHahaGuardProcess, i 22) i.R0'")
          .replace('StrCpy $ccHahaGuardThread $R2', "StrCpy $ccHahaGuardThread $R2\n  System::Call 'kernel32::GetProcessId(p $ccHahaGuardProcess) i.R1'\n  StrCpy $fixtureChildPid $R1")
        if (item.name === 'weak-close-failure') adapted = adapted.replace("System::Call 'kernel32::CloseHandle(p R2) i.R3'", "System::Call 'kernel32::CloseHandle(p R2) i.R3'\n      ${If} $fixtureCloseInjected == 0\n        StrCpy $fixtureCloseInjected 1\n        StrCpy $R3 0\n      ${EndIf}")
        const fixtureInclude = path.join(root, `${item.name}.nsh`)
        writeFileSync(fixtureInclude, instrument(adapted))
        const executable = path.join(root, `${item.name}.exe`)
        const journal = `${owned}.parent.log`
        const outerStages = `${owned}.stages.log`
        compile(item.name, common + stageMacro(outerStages, 'outer') + String.raw`Name "Owned capability launcher"
OutFile "${executable}"
Var fixtureResumes
Var fixtureTerminates
Var fixtureCloseInjected
Var fixtureChildPid
!include "${fixtureInclude}"
!insertmacro CcHahaGuardFunctions
Section
  StrCpy $fixtureResumes 0
  StrCpy $fixtureTerminates 0
  StrCpy $fixtureCloseInjected 0
  StrCpy $fixtureChildPid 0
  InitPluginsDir
  File /oname=$PLUGINSDIR\cc-haha-current-uninstaller.exe "${current}"
  StrCpy $ccHahaGuardRoot "${owned}"
  Call CcHahaGuardCapture
  StrCpy $ccHahaGuardApplication "$PLUGINSDIR\cc-haha-current-uninstaller.exe"
  StrCpy $ccHahaGuardExtraArguments "/S /KEEP_APP_DATA /currentuser --keep-shortcuts --updated"
  StrCpy $ccHahaGuardIsUninstaller 1
  StrCpy $ccHahaGuardExpectedHash "${item.name === 'wrong-code-hash' ? '0'.repeat(64) : sha256(readFileSync(current))}"
  StrCpy $ccHahaGuardExpectedBytes ${readFileSync(current).length}
  StrCpy $ccHahaGuardConfigHash ""
  StrCpy $ccHahaGuardConfigBytes 0
  Call CcHahaGuardLaunch
  Call CcHahaGuardDiscard
  FileOpen $0 "${journal}" w
  FileWrite $0 "exit=$ccHahaGuardExit;resumes=$fixtureResumes;terminates=$fixtureTerminates;child=$fixtureChildPid;closed=$fixtureCloseInjected;"
  FileClose $0
  SetErrorLevel $ccHahaGuardExit
SectionEnd
`)
        if (process.platform !== 'win32') continue
        const run = spawnSync(executable, ['/S'], { env, windowsHide: true, timeout: 30_000 })
        const metadata = preserveHandoffEvidence(item.name, run, item.expected, { outer: outerStages, current: currentStages,
          parent: journal, clr: `${owned}.clr.log`, rejected: `${owned}.rejected.log` })
        const trace = existsSync(journal) ? readFileSync(journal, 'utf8') : 'missing parent journal'
        const context = JSON.stringify({ ...metadata, parent: trace })
        expect(run.error, context).toBeUndefined()
        expect(run.status, context).toBe(item.expected)
        expect(trace, item.name).toContain(`exit=${item.expected};resumes=${item.resumes};terminates=${item.terminates};`)
        const pid = Number(trace.match(/child=(\d+);/)![1])
        const deadline = Date.now() + 15_000
        if (pid) {
          while (Date.now() < deadline) {
            try { process.kill(pid, 0) } catch { break }
            await new Promise(resolve => setTimeout(resolve, 25))
          }
          try { process.kill(pid, 0); safeToClean = false } catch {}
          expect(safeToClean, `Owned fixture child is still running; retained ${root}`).toBe(true)
        }
        if (item.name === 'complete') expect(readFileSync(`${owned}.handoff.log`, 'utf8')).toContain('empty-root-deleted-and-recreated')
        if (item.name === 'wrong-code-hash' || item.name === 'weak-close-failure') expect(existsSync(`${owned}.handoff.log`)).toBe(false)
      }
      if (process.platform === 'win32') {
        const owned = path.join(root, 'invalid-capabilities')
        mkdirSync(owned)
        const run = spawnSync(current, ['/S', '/KEEP_APP_DATA', '/currentuser', '--keep-shortcuts', '--updated', '--cc-guarded-removal=1',
          `--root=${owned}`, '--capabilities=0:0:0:0', '--parent=0:0:0:0', `_?=${owned}`], { env, windowsHide: true, timeout: 15_000 })
        const metadata = preserveHandoffEvidence('invalid-capabilities', run, 22, { current: currentStages,
          clr: `${owned}.clr.log`, rejected: `${owned}.rejected.log` })
        expect(run.error, JSON.stringify(metadata)).toBeUndefined()
        expect(run.status, JSON.stringify(metadata)).toBe(22)
        expect(existsSync(`${owned}.handoff.log`)).toBe(false)
      }
    } finally { if (safeToClean) rmSync(root, { recursive: true, force: true }) }
  }, 120_000)

  test('keeps suspended exact-handle inheritance and guarded removal separate from default recursive removal', () => {
    const launch = readFileSync('desktop/build/guarded-removal-launch.nsh', 'utf8').replace(/\r\n/g, '\n')
    const installer = readFileSync('desktop/build/installer.nsh', 'utf8').replace(/\r\n/g, '\n')
    const legacy = readFileSync('desktop/build/legacy-uninstaller-compat.nsh', 'utf8').replace(/\r\n/g, '\n')
    expect(launch).toContain('InitializeProcThreadAttributeList(p 0, i 1, i 0, *i.R0)')
    expect(launch).toContain('UpdateProcThreadAttribute(p $ccHahaGuardAttributes, i 0, p 0x20002, p $ccHahaGuardList, i R0, p 0, p 0)')
    expect(launch).toContain('System::Alloc 72')
    expect(launch).toContain('IntOp $R0 $ccHahaGuardStartup + 68')
    expect(launch).toContain('System::Alloc 16')
    expect(launch).toContain('OpenProcess(i 0x101000, i 1, i R1) p.R2')
    expect(launch).toContain('IntOp $R0 $ccHahaGuardCount + 1')
    expect(launch).toContain('--parent=$\\\"$ccHahaGuardParentArguments$\\\"')
    expect(launch).toContain('GetProcessId(p $ccHahaGuardParent) i.R0')
    expect(launch).toContain('GetProcessTimes(p $ccHahaGuardParent')
    expect(launch).toContain('WaitForSingleObject(p $ccHahaGuardParent, i 0)')
    const create = launch.indexOf("System::Call 'kernel32::CreateProcessW")
    const close = launch.indexOf('Call ${CC_HAHA_GUARD_PREFIX}CcHahaGuardCloseWeak', create)
    const resume = launch.indexOf("System::Call 'kernel32::ResumeThread", close)
    expect(create).toBeGreaterThan(0)
    expect(close).toBeGreaterThan(create)
    expect(resume).toBeGreaterThan(close)
    expect(launch.slice(create, resume)).toContain('StrCmp $ccHahaGuardOk 1 0 cc_haha_guard_launch_done')
    expect(launch.slice(resume)).toContain('StrCmp $R0 1 0 cc_haha_guard_launch_done')
    expect(launch).toContain('i 0x8080404, p $ccHahaGuardEnvironment, w "$SYSDIR"')
    expect(launch).toContain('${If} $ccHahaGuardResumed == 0\n        ; This is solely our never-resumed child')
    expect(launch.slice(close, resume)).toContain('StrCpy $ccHahaGuardResumed "unknown"')
    expect(launch).toContain('!insertmacro CcHahaVendorDefaultRemoveFiles')
    expect(launch).not.toMatch(/^\s*(?:Rename|RMDir|DeleteRegKey)\b/m)
    expect(installer.indexOf('!insertmacro CcHahaGuardCheckUninstallerEntry')).toBeLessThan(installer.indexOf('!insertmacro CcHahaUseDefaultPowerShellModulePath', installer.indexOf('!macro customCheckAppRunning')))
    expect(legacy).toContain('Call CcHahaGuardCapture')
    expect(legacy).not.toContain('ExecWait')
  })
})

describe('Windows installer process matching', () => {
  test.skipIf(process.platform !== 'win32' && process.env.CC_HAHA_TEST_NSIS_COMPILE_ONLY !== '1')('requires literal old, capability-source and current target paths at the actual NSIS admission comparison (Mac compiles only)', () => {
    const compiler = process.env.CC_HAHA_TEST_MAKENSIS
    if (!compiler) throw new Error('Run the prepared pinned Windows installer lane')
    const source = readFileSync('desktop/build/legacy-uninstaller-compat.nsh', 'utf8').replace(/\r\n/g, '\n')
    const gate = source.match(/^  StrCmpS? \$R2 \$ccHahaCompatRoot 0 \$\{_FAIL\}\n  StrCmpS? \$R2 \$INSTDIR 0 \$\{_FAIL\}$/m)?.[0]
    if (!gate) throw new Error('Missing production old/current installation identity comparison')
    const before = gate.replace(/StrCmpS/g, 'StrCmp')
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'cc-haha-literal-root-')))
    const env = createSandboxedTestEnvironment(path.join(root, 'home'))
    const executable = path.join(root, 'literal-roots.exe')
    const journal = path.join(root, 'literal-roots.log')
    const cases = [
      { name: 'before-case-different-target', gate: before, registered: String.raw`C:\owned\App`, capability: String.raw`C:\owned\App`, target: String.raw`C:\owned\app`, ready: 1 },
      { name: 'literal-match', gate, registered: String.raw`C:\owned\App`, capability: String.raw`C:\owned\App`, target: String.raw`C:\owned\App`, ready: 1 },
      { name: 'case-different-target', gate, registered: String.raw`C:\owned\App`, capability: String.raw`C:\owned\App`, target: String.raw`C:\owned\app`, ready: 0 },
      { name: 'case-different-capability-source', gate, registered: String.raw`C:\owned\app`, capability: String.raw`C:\owned\App`, target: String.raw`C:\owned\app`, ready: 0 },
    ]
    // All other identity gates are assumed valid here. Use the actual two
    // production comparisons; the before control restores only StrCmp's
    // insensitive operator. No real directories, registry, or launch are used.
    const rendered = String.raw`Unicode true
RequestExecutionLevel user
SilentInstall silent
Name "Owned literal install-root comparison"
OutFile "${executable}"
Var ccHahaCompatRoot
Var ccHahaCompatReady
Var fixtureLaunches
${cases.map((item, index) => String.raw`Function FixtureAdmission${index}
  StrCpy $ccHahaCompatReady 0
  StrCpy $ccHahaCompatRoot "${item.capability}"
  StrCpy $INSTDIR "${item.target}"
  StrCpy $R2 "${item.registered}"
${item.gate.replaceAll('${_FAIL}', `fixture_admission_done_${index}`)}
  StrCpy $ccHahaCompatReady 1
  fixture_admission_done_${index}:
FunctionEnd
`).join('\n')}
Section
  FileOpen $0 "${journal}" w
${cases.map((item, index) => String.raw`  StrCpy $fixtureLaunches 0
  Call FixtureAdmission${index}
  StrCmp $ccHahaCompatReady 1 0 +2
    IntOp $fixtureLaunches $fixtureLaunches + 1
  FileWrite $0 "${item.name}:ready=$ccHahaCompatReady;launches=$fixtureLaunches;$\r$\n"
`).join('')}
  FileClose $0
  SetErrorLevel 0
SectionEnd
`
    try {
      const nsi = path.join(root, 'literal-roots.nsi')
      writeFileSync(nsi, rendered)
      const prefix = process.platform === 'win32' ? '/' : '-'
      const compile = spawnSync(compiler, [`${prefix}WX`, `${prefix}V2`, nsi], { env: { ...env, NSISDIR: path.resolve(path.dirname(compiler), '..') }, encoding: 'utf8', timeout: 15_000 })
      expect(compile.error, compile.stderr || compile.stdout).toBeUndefined()
      expect(compile.status, compile.stderr || compile.stdout).toBe(0)
      if (process.platform !== 'win32') return // Compile evidence only; StrCmpS executes on Windows.
      const run = spawnSync(executable, ['/S'], { env, windowsHide: true, timeout: 15_000 })
      expect(run.error).toBeUndefined()
      expect(run.status).toBe(0)
      const trace = readFileSync(journal, 'utf8')
      for (const item of cases) expect(trace).toContain(`${item.name}:ready=${item.ready};launches=${item.ready};`)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }, 30_000)

  test('only adds narrow first-exit-22 hooks to the frozen NSIS template', () => {
    const before = readFileSync('scripts/pr/fixtures/nsis-install-util-26.8.1.nsh', 'utf8').replace(/\r\n/g, '\n')
    expect(sha256(before)).toBe(legacyTemplate.pins['templates/nsis/include/installUtil.nsh'])
    const after = legacyTemplate.adaptInstallUtil(before)
    // Exact byte reversal proves retry, Retry/Cancel, launch fallback, zero
    // success and the vendor uninstall logic were not replaced or weakened.
    expect(after.replace('  !insertmacro CcHahaPrepareLegacyCompat\n\n', '')
      .replace('      !insertmacro CcHahaReturnForLegacyCompat22\n', '')
      .replace('\n!cd "${CC_HAHA_NSIS_COMPAT_ORIGINAL_CWD}"\n', '')).toBe(before)
    expect(after.indexOf('CcHahaPrepareLegacyCompat')).toBeGreaterThan(after.indexOf('!insertmacro copyFile "$uninstallerFileName"'))
    expect(after.indexOf('CcHahaPrepareLegacyCompat')).toBeLessThan(after.indexOf('StrCpy $R5 0'))
    expect(after).toContain('CheckResult:\n      !insertmacro CcHahaReturnForLegacyCompat22\n      ${if} $R0 == 0')
    expect(() => legacyTemplate.adaptInstallUtil(before.replace('Sleep 1000', 'Sleep 999'))).toThrow('Unreviewed')
    expect(before).not.toContain('CcHahaReturnForLegacyCompat22')
  })

  test.skipIf(!legacyVendorRoot)('binds the trusted replacement to the current build and fails closed on template drift', () => {
    const vendorRoot = legacyVendorRoot!
    const root = mkdtempSync(path.join(tmpdir(), 'cc-haha-compat-template-test-'))
    const generated: Array<{ directory: string; owner: string }> = []
    try {
      const uninstaller = path.join(root, 'current.exe')
      const bootstrap = path.join(root, 'bootstrap.nsh')
      const bytes = Buffer.from('MZ-owned-build-fixture-never-executed')
      writeFileSync(uninstaller, bytes)
      const compilerCwd = path.join(vendorRoot, 'templates/nsis')
      generated.push(legacyTemplate.prepare({ vendorRoot, uninstaller, bootstrap, temporaryParent: root, compilerCwd }))
      generated.push(legacyTemplate.prepare({ vendorRoot, uninstaller, bootstrap, temporaryParent: root, compilerCwd }))
      expect(generated[0]!.directory).not.toBe(generated[1]!.directory)
      expect(readFileSync(bootstrap, 'utf8')).toContain(`CC_HAHA_CURRENT_UNINSTALLER_SHA256 "${sha256(bytes)}"`)
      expect(readFileSync(bootstrap, 'utf8')).toContain(`CC_HAHA_CURRENT_UNINSTALLER_BYTES ${bytes.length}`)
      expect(readFileSync(bootstrap, 'utf8')).toContain('!cd "')
      expect(readFileSync(bootstrap, 'utf8')).toContain('CC_HAHA_NSIS_COMPAT_ORIGINAL_CWD')
      expect(readFileSync(path.join(generated[0]!.directory, 'installUtil.nsh'), 'utf8')).toBe(
        legacyTemplate.adaptInstallUtil(readFileSync('scripts/pr/fixtures/nsis-install-util-26.8.1.nsh', 'utf8').replace(/\r\n/g, '\n')),
      )
      expect(() => legacyTemplate.cleanup(generated[0]!.directory, 'wrong-owner')).toThrow('unowned')
      expect(() => legacyTemplate.prepare({ vendorRoot, uninstaller, bootstrap, temporaryParent: root, compilerCwd: root })).toThrow('working directory')
      writeFileSync(uninstaller, 'not-a-PE')
      expect(() => legacyTemplate.prepare({ vendorRoot, uninstaller, bootstrap, temporaryParent: root, compilerCwd })).toThrow('uninstaller')
      const wrongVendor = path.join(root, 'vendor')
      mkdirSync(wrongVendor)
      writeFileSync(path.join(wrongVendor, 'package.json'), '{"version":"26.8.2"}')
      expect(() => legacyTemplate.prepare({ vendorRoot: wrongVendor, uninstaller, bootstrap, temporaryParent: root })).toThrow('pinned')
    } finally {
      for (const item of generated) legacyTemplate.cleanup(item.directory, item.owner)
      rmSync(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform !== 'win32' && (process.env.CC_HAHA_TEST_NSIS_COMPILE_ONLY !== '1' || !process.env.CC_HAHA_TEST_NSIS_RESOURCES))('preserves source/current/temp path bytes through real two-stage compilation', async () => {
    const compiler = process.env.CC_HAHA_TEST_MAKENSIS
    const templates = process.env.CC_HAHA_TEST_NSIS_TEMPLATES ?? (legacyVendorRoot && path.join(legacyVendorRoot, 'templates/nsis'))
    const resources = process.env.CC_HAHA_TEST_NSIS_RESOURCES
    if (!compiler || !templates || !resources) throw new Error('Run the prepared Windows installer lane with its pinned compiler and resources')
    const root = mkdtempSync(path.join(tmpdir(), 'cc-haha-nsis-paths-'))
    try {
      const observations = await compileInstallerPathCases({ root, sourceRoot: process.cwd(), compiler, templates, resources,
        env: createSandboxedTestEnvironment(path.join(root, 'home')),
      })
      expect(observations).toHaveLength(installerPathCases.length * 2)
      for (const item of observations) {
        if (item.revision === 'before' && item.beforeFails) {
          expect(item.wrapper.status === 1 || item.final.status === 1, `${item.wrapper.log} ${item.final.log}`).toBe(true)
        } else {
          expect(item.wrapper.status, item.wrapper.log).toBe(0)
          expect(item.final.status, item.final.log).toBe(0)
        }
        expect(item.peExecution).toBe(false)
        expect(item.helperCompiler).toBe('injected non-runnable fixture')
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  }, 120_000)

  test.skipIf(process.platform !== 'win32' && process.env.CC_HAHA_TEST_NSIS_COMPILE_ONLY !== '1')('returns on the first proven old 22 with injected capability handoff observations in real NSIS (Mac can compile only)', () => {
    const compiler = process.env.CC_HAHA_TEST_MAKENSIS
    if (!compiler || !existsSync(compiler)) throw new Error('Run the prepared Windows installer lane')
    const root = mkdtempSync(path.join(tmpdir(), 'cc-haha-legacy-state-'))
    const env = createSandboxedTestEnvironment(path.join(root, 'home'))
    const source = readFileSync('desktop/build/legacy-uninstaller-compat.nsh', 'utf8').replace(/\r\n/g, '\n')
    const installer = readFileSync('desktop/build/installer.nsh', 'utf8').replace(/\r\n/g, '\n')
    const macro = (name: string, text = source) => {
      const result = text.match(new RegExp(`!macro ${name}[^\\n]*\\n[\\s\\S]*?\\n!macroend`))?.[0]
      if (!result) throw new Error(`Missing real production macro ${name}`)
      return result
    }
    const old = readFileSync('scripts/pr/fixtures/nsis-install-util-26.8.1.nsh', 'utf8').replace(/\r\n/g, '\n')
    const cases = [
      { name: 'original-defect', before: true, ready: 1, oldExit: 22, childExit: 0, expected: 2, runs: 5, attempted: 0 },
      { name: 'first-proven-22', ready: 1, oldExit: 22, childExit: 0, expected: 0, runs: 1, attempted: 1 },
      { name: 'unknown-legacy-or-cancel', ready: 0, oldExit: 22, childExit: 0, expected: 2, runs: 5, attempted: 0 },
      { name: 'old-launch-error', ready: 1, oldExit: 22, oldError: true, childExit: 0, expected: 2, runs: 2, attempted: 0 },
      { name: 'old-other-exit', ready: 1, oldExit: 2, childExit: 0, expected: 2, runs: 5, attempted: 0 },
      { name: 'old-success', ready: 1, oldExit: 0, childExit: 0, expected: 0, runs: 1, attempted: 0 },
      { name: 'identity-changed', ready: 1, identity: 0, oldExit: 22, childExit: 0, expected: 2, runs: 1, attempted: 1 },
      { name: 'fault-not-reproduced', ready: 1, fault: 0, oldExit: 22, childExit: 0, expected: 2, runs: 1, attempted: 1 },
      { name: 'replacement-cancel-22', ready: 1, oldExit: 22, childExit: 22, expected: 2, runs: 1, attempted: 1 },
      { name: 'replacement-exit-2', ready: 1, oldExit: 22, childExit: 2, expected: 2, runs: 1, attempted: 1 },
      { name: 'replacement-launch-error', ready: 1, oldExit: 22, childExit: 0, brokenChild: true, expected: 2, runs: 1, attempted: 1 },
      { name: 'removal-not-proven', ready: 1, removal: 0, oldExit: 22, childExit: 0, expected: 2, runs: 1, attempted: 1 },
    ]
    const compile = (file: string, text: string) => {
      writeFileSync(file, text)
      const result = spawnSync(compiler, [process.platform === 'win32' ? '/V2' : '-V2', file], {
        env: { ...env, NSISDIR: path.resolve(path.dirname(compiler), '..') }, encoding: 'utf8', timeout: 15_000,
      })
      expect(result.error, result.stderr || result.stdout).toBeUndefined()
      expect(result.status, result.stderr || result.stdout).toBe(0)
    }
    try {
      for (const item of cases) {
        const fixture = item as typeof item & { before?: boolean; oldError?: boolean; brokenChild?: boolean; identity?: number; fault?: number; removal?: number }
        const child = path.join(root, `${fixture.name}-child.exe`)
        const childJournal = path.join(root, `${fixture.name}-child.log`)
        if (fixture.brokenChild) writeFileSync(child, 'MZ-owned-invalid-image')
        else compile(`${child}.nsi`, String.raw`Unicode true
RequestExecutionLevel user
SilentInstall silent
Name "Owned no-op replacement fixture"
OutFile "${child}"
Section
  FileOpen $0 "${childJournal}" w
  FileWrite $0 "$CMDLINE"
  FileClose $0
  SetErrorLevel ${fixture.childExit}
SectionEnd
`)
        const childBytes = readFileSync(child)
        const executable = path.join(root, `${fixture.name}.exe`)
        const journal = path.join(root, `${fixture.name}.log`)
        const template = fixture.before ? old : legacyTemplate.adaptInstallUtil(old)
        const loop = template.slice(template.indexOf('  # Retry counter'), template.indexOf('\nFunctionEnd', template.indexOf('  # Retry counter')))
          .replace(/^\s*ExecWait [^\n]+\$R0/gm, '\n    !insertmacro FixtureOldExec')
          .replace('Sleep 1000', 'Sleep 0')
        compile(`${executable}.nsi`, String.raw`Unicode true
RequestExecutionLevel user
SilentInstall silent
Name "Owned legacy state boundary fixture"
OutFile "${executable}"
!include "LogicLib.nsh"
!define CC_HAHA_LEGACY_COMPAT_TEMPLATE "26.8.1"
!define UNINSTALLER_OUT_FILE "${child}"
!define CC_HAHA_CURRENT_UNINSTALLER_BYTES ${childBytes.length}
!define CC_HAHA_CURRENT_UNINSTALLER_SHA256 "${sha256(childBytes)}"
; Identity, fault/removal observations and hash are injected boundaries here.
; Real registry/token/path/hash behavior requires the Windows profile/product lane.
!define StdUtils.HashFile '!insertmacro FixtureHashFile'
!macro FixtureHashFile _OUT _ALGORITHM _FILE
  StrCpy ${'${_OUT}'} "${sha256(childBytes)}"
!macroend
Var ccHahaCompatReady
Var ccHahaCompatFirstExit22
Var ccHahaCompatAttempted
Var ccHahaCompatIdentity
Var ccHahaCompatFault
Var ccHahaCompatRoot
Var ccHahaGuardRoot
Var ccHahaGuardOk
Var ccHahaGuardApplication
Var ccHahaGuardExtraArguments
Var ccHahaGuardIsUninstaller
Var ccHahaGuardExpectedHash
Var ccHahaGuardExpectedBytes
Var ccHahaGuardConfigHash
Var ccHahaGuardConfigBytes
Var ccHahaGuardExit
Var ccHahaProcessHelperWriteBlocked
Var fixtureRuns
Var uninstallerFileNameTemp
Var uninstallerFileName
Var installationDir
LoadLanguageFile "${'${NSISDIR}'}\Contrib\Language files\English.nlf"
LangString appCannotBeClosed 1033 "Close app"
LangString uninstallFailed 1033 "Uninstall failed"
${macro('CcHahaReturnForLegacyCompat22')}
${macro('CcHahaCompatFileFingerprint')}
${macro('CcHahaTrustedLegacyRemovalBody')}
${macro('CcHahaHandleOldUninstallerResult', installer)}
!macro FixtureOldExec
  IntOp $fixtureRuns $fixtureRuns + 1
  StrCpy $R0 ${fixture.oldExit}
  ${fixture.oldError ? 'SetErrors' : 'ClearErrors'}
!macroend
Function FixtureOld
${loop}
FunctionEnd
Function CcHahaCompatValidateIdentity
  StrCpy $ccHahaCompatIdentity ${fixture.identity ?? 1}
FunctionEnd
Function CcHahaCompatValidateFaultAndProcesses
  StrCpy $ccHahaCompatFault ${fixture.fault ?? 1}
FunctionEnd
Function CcHahaCompatValidateRemoval
  StrCpy $ccHahaCompatIdentity ${fixture.removal ?? 1}
FunctionEnd
; Handoff is an injected boundary in this state-machine fixture. The real
; STARTUPINFOEX/capability/backend behavior needs the separate Windows lane.
Function CcHahaGuardRevalidate
  StrCpy $ccHahaGuardOk 1
FunctionEnd
Function CcHahaGuardDiscard
  StrCpy $ccHahaGuardOk 1
FunctionEnd
Function CcHahaGuardLaunch
  ClearErrors
  ExecWait '$\"$ccHahaGuardApplication$\" $ccHahaGuardExtraArguments _?=$ccHahaCompatRoot' $ccHahaGuardExit
  IfErrors 0 +2
    StrCpy $ccHahaGuardExit 22
FunctionEnd
${source.match(/Function CcHahaTryTrustedLegacyRemoval\n[\s\S]*?\nFunctionEnd/)![0]}
Section
  InitPluginsDir
  StrCpy $ccHahaCompatReady ${fixture.ready}
  StrCpy $ccHahaCompatRoot "${path.join(root, 'owned installation root')}"
  StrCpy $ccHahaCompatFirstExit22 0
  StrCpy $ccHahaCompatAttempted 0
  StrCpy $fixtureRuns 0
  ClearErrors
  Call FixtureOld
  StrCpy $R1 "caller-one"
  StrCpy $R6 "caller-six"
  Push "stack-canary"
  Call CcHahaTryTrustedLegacyRemoval
  Pop $R9
  FileOpen $0 "${journal}" w
  FileWrite $0 "oldRuns=$fixtureRuns;attempted=$ccHahaCompatAttempted;first22=$ccHahaCompatFirstExit22;result=$R0;one=$R1;six=$R6;stack=$R9;"
  FileClose $0
  !insertmacro CcHahaHandleOldUninstallerResult
  SetErrorLevel 0
SectionEnd
`)
        // This option is deliberately compile-only on a non-Windows host. It
        // proves NSIS expansion, not ExecWait, the old PE, or removal behavior.
        if (process.platform !== 'win32') continue
        const run = spawnSync(executable, ['/S'], { env, timeout: 15_000, windowsHide: true })
        expect(run.error, fixture.name).toBeUndefined()
        expect(run.status, fixture.name).toBe(fixture.expected)
        const trace = readFileSync(journal, 'utf8')
        expect(trace, fixture.name).toContain(`oldRuns=${fixture.runs};attempted=${fixture.attempted};`)
        expect(trace, fixture.name).toContain('one=caller-one;six=caller-six;stack=stack-canary;')
        const ranChild = fixture.attempted === 1 && fixture.identity !== 0 && fixture.fault !== 0 && !fixture.brokenChild
        expect(existsSync(childJournal), fixture.name).toBe(ranChild)
        if (ranChild) {
          const command = readFileSync(childJournal, 'utf8')
          expect(command).toContain('/S /KEEP_APP_DATA /currentuser --keep-shortcuts --updated')
          expect(command).not.toContain('--delete-app-data')
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  }, 120_000)

  test('keeps admission and replacement failures separate from successful old removal', () => {
    const source = readFileSync('desktop/build/legacy-uninstaller-compat.nsh', 'utf8').replace(/\r\n/g, '\n')
    const header = readFileSync('desktop/build/installer.nsh', 'utf8').replace(/\r\n/g, '\n')
    const prepare = source.slice(source.indexOf('!macro CcHahaPrepareLegacyCompat'), source.indexOf('!macro CcHahaReturnForLegacyCompat22'))
    const earlyReturn = source.slice(source.indexOf('!macro CcHahaReturnForLegacyCompat22'), source.indexOf('!macro CcHahaTrustedLegacyRemovalBody'))
    const replace = source.slice(source.indexOf('!macro CcHahaTrustedLegacyRemovalBody'))
    for (const requirement of [
      '$ccHahaCompatAttempted != 1', '$ccHahaRecoveryDone == 1', '$installMode == "CurrentUser"',
      '${AndIfNot} ${UAC_IsAdmin}', '${AndIfNot} ${UAC_IsInnerInstance}', '${AndIfNot} ${isDeleteAppData}',
      '"${APP_GUID}" == "f01cf2f0-8fe7-55b9-af4b-027bcf9c2cfe"', '${AndIf} ${IsNativeAMD64}',
      'Call CcHahaCompatValidateIdentity', 'Call CcHahaCompatValidateFaultAndProcesses',
    ]) expect(prepare).toContain(requirement)
    for (const requirement of ['$R0 == 22', '$R5 == 1', '$ccHahaCompatReady == 1', '$R9 == 0']) expect(earlyReturn).toContain(requirement)
    expect(earlyReturn).toMatch(/StrCpy \$ccHahaCompatFirstExit22 1\s+Pop \$R9\s+ClearErrors\s+Return/)
    expect(prepare).toMatch(/\$R9 == 1\s+SetErrors\s+\$\{Else\}\s+ClearErrors/)
    expect(source).toContain('"b0242b31b839cc8bf40ba4ac492004629bcf8ed28f8648d8c46b1797f7befb60" 174881')
    expect(source).toContain('GetTokenInformation(p R1, i 20, *i .R3, i 4, *i .R4)')
    expect(source).toContain('StrCmp $R4 4 0')
    expect(source).toContain('Call CcHahaCanSkipLegacyRecovery')
    expect(source).toContain('ReadEnvStr $R2 CC_HAHA_APP_PORTABLE_DIR')
    expect(source).toContain('Call CcHahaCompatPlainTree')
    expect(source).toContain('IntOp $R5 $R3 & 0x400')
    expect(source).toContain('StrCmp $ccHahaCompatExternalMatch 1 0')
    expect(source).toContain('shlwapi::StrToIntExW')
    expect(replace).toContain('File /oname=$PLUGINSDIR\\cc-haha-current-uninstaller.exe "${UNINSTALLER_OUT_FILE}"')
    expect(replace).toContain('StrCpy $ccHahaGuardExtraArguments "/S /KEEP_APP_DATA /currentuser --keep-shortcuts --updated"')
    expect(replace).not.toContain('$0 _?=')
    expect(replace).toMatch(/StrCpy \$ccHahaCompatAttempted 1[\s\S]*Call CcHahaGuardRevalidate[\s\S]*Call CcHahaGuardLaunch/)
    expect(replace).toMatch(/IfErrors cc_haha_compat_replacement_failed[\s\S]*\$R0 == 0[\s\S]*Call CcHahaCompatValidateRemoval/)
    expect(replace).toMatch(/cc_haha_compat_replacement_failed:\s*;[^\n]*\n\s*StrCpy \$R0 22\s+SetErrors/)
    expect(source).not.toMatch(/^\s*(?:RMDir|DeleteRegKey|Rename|WriteUninstaller)\b/m)
    expect(header).toContain('!ifdef CC_HAHA_LEGACY_COMPAT_TEMPLATE\n    Call CcHahaTryTrustedLegacyRemoval')
  })
  test('freezes the real 3bab whole-Find path and renders real findstr residual guards', () => {
    const frozenSource = readFileSync('scripts/pr/fixtures/installer-fallback-before-residual-matches.nsh', 'utf8').replace(/\r\n/g, '\n')
    const before = readFallbackMacros(frozenSource, { includeFind: true, frozenResidual: true })
    const current = readFallbackMacros(readFileSync('desktop/build/installer.nsh', 'utf8').replace(/\r\n/g, '\n'), { includeFind: true })
    expect(sha256(before)).toBe(frozenResidualMacrosSha256)
    expect(before.match(/^!macro /gm)).toHaveLength(3)
    expect(fallbackApiCases).toHaveLength(30)
    expect(() => readFallbackMacros(frozenSource.replace('so setup continues.', 'tampered'), { includeFind: true, frozenResidual: true })).toThrow('frozen 3bab')
    for (const macros of [before, current]) {
      const rendered = renderResidualFindApiHarness(macros, before, 'C:\\owned\\probe.exe', 'C:\\owned\\probe.log', 'C:\\owned\\missing')
      expect(rendered.match(/!insertmacro CcHahaFindInstallProcess /g)).toHaveLength(3)
      expect(rendered).toContain('!insertmacro FixtureOwnedTasklist')
      expect(rendered).not.toContain('/D /C tasklist')
      expect(rendered).toContain('nsExec::ExecToStack /TIMEOUT=30000 \'"$SYSDIR\\findstr.exe" /I /L')
      expect(rendered).toContain('Pop $fixtureFilterReturn')
      const native = renderResidualFindNativeHarness(macros, before, 'C:\\owned\\native.exe', 'C:\\owned\\native.log', 'C:\\owned\\install')
      expect(native).toContain(macros)
      expect(native).toContain('/D /C tasklist /FO CSV /NH')
      expect(native).not.toContain('FixtureKernelCall')
    }
  })

  test.skipIf(process.platform !== 'win32')('keeps every original findstr hit protected through the whole native Find macro', () => {
    const compiler = process.env.CC_HAHA_TEST_MAKENSIS
    if (!compiler || !existsSync(compiler)) throw new Error('Run the prepared Windows installer lane with its locked NSIS compiler')
    const root = mkdtempSync(path.join(tmpdir(), 'cc-haha-find-api-'))
    const env = createSandboxedTestEnvironment(path.join(root, 'home'))
    const installer = readFileSync('desktop/build/installer.nsh', 'utf8').replace(/\r\n/g, '\n')
    const before = readFallbackMacros(readFileSync('scripts/pr/fixtures/installer-fallback-before-residual-matches.nsh', 'utf8').replace(/\r\n/g, '\n'), { includeFind: true, frozenResidual: true })
    const current = readFallbackMacros(installer, { includeFind: true })
    try {
      for (const [version, macros] of [['before', before], ['current', current]] as const) {
        const executable = path.join(root, `${version}.exe`)
        const source = path.join(root, `${version}.nsi`)
        const journal = path.join(root, `${version}.log`)
        const rendered = renderResidualFindApiHarness(macros, before, executable, journal, path.join(root, 'missing-install'))
        writeFileSync(source, rendered)
        const compileStartedAtUtc = new Date().toISOString()
        const compile = spawnSync(compiler, ['/V2', source], { env, encoding: 'utf8', timeout: 30_000 })
        preserveResidualEvidence(`api-${version}-compile`, {
          mode: 'real-nsis-findstr-with-injected-kernel-results-and-owned-csv',
          compileStartedAtUtc, compileFinishedAtUtc: new Date().toISOString(),
          sourceSha256: sha256(rendered), macroSha256: sha256(macros),
          productionSourceSha256: sha256(installer), status: compile.status, error: compile.error?.message,
          executableSha256: existsSync(executable) ? sha256(readFileSync(executable)) : null,
        }, { nsi: rendered, 'compile.log': `${compile.stdout ?? ''}${compile.stderr ?? ''}` })
        expect(compile.error, compile.stderr || compile.stdout).toBeUndefined()
        expect(compile.status, compile.stderr || compile.stdout).toBe(0)
        for (const fixture of residualFindApiCases) {
          for (const file of [journal, `${journal}.csv`, `${journal}.residual.csv`]) rmSync(file, { force: true })
          const startedAtUtc = new Date().toISOString()
          const run = spawnSync(executable, ['/S', `/CASE=${fixture.name}`], { env, timeout: 30_000, windowsHide: true })
          const files = residualRunFiles(journal)
          const trace = files.log ?? ''
          const expected = version === 'before' ? 1 : fixture.expected
          preserveResidualEvidence(`api-${version}-${fixture.name}`, {
            mode: 'real-nsis-findstr-with-injected-kernel-results-and-owned-csv',
            startedAtUtc, finishedAtUtc: new Date().toISOString(), case: fixture.name,
            sourceSha256: sha256(rendered), macroSha256: sha256(macros),
            expectedSafeResult: fixture.expected, expectedObservedResult: expected,
            observedResults: trace.match(/results=([^;]+);/)?.[1] ?? null,
            exitCode: run.status, error: run.error?.message,
            processPathErrorActuallyObserved: false,
            faultBoundary: fixture.name === 'verification-command-launch-error'
              ? 'real Verify residual-command launch; fixture tasklist is intentionally unaffected'
              : fixture.name === 'unattributed-foorg-no-path-proof'
                ? 'OpenProcess would fail if requested; the exact-name census never requests foorg path'
                : fixture.name === 'pattern-file-open-error' ? 'real Verify pattern FileOpen against an owned directory' : null,
          }, files)
          expect(run.error, `${version}/${fixture.name}`).toBeUndefined()
          expect(run.status, `${version}/${fixture.name}`).toBe(0)
          expect(trace, `${version}/${fixture.name}`).toContain(`results=${expected},${expected},${expected};`)
          expect(trace).toContain('handles=0;allocations=0;badClose=0;')
          expect(trace).toContain('stack=stack-canary;zero=caller-zero;one=caller-one;two=caller-two;three=caller-three;seven=caller-seven;')
          expect(trace).toContain('originalFilter=0;')
          expect(trace).toContain(fixture.image)
          if (fixture.name === 'unattributed-foorg-no-path-proof') expect(trace).toContain('openCalls=0;')
          if (version === 'current' && fixture.expected === 1) expect(trace).toContain('verified outside the install directory')
          if (version === 'current' && fixture.name === 'verification-command-launch-error') expect(trace).toContain('tasklist match verification failed')
          if (version === 'current' && fixture.name === 'pattern-file-open-error') expect(trace).toContain('could not all be verified')
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 180_000)

  test.skipIf(process.platform !== 'win32')('fails closed at the real NSIS fallback API boundaries and preserves its stack', () => {
    const compiler = process.env.CC_HAHA_TEST_MAKENSIS
    if (!compiler || !existsSync(compiler)) {
      throw new Error('Run the prepared Windows installer lane with its locked NSIS compiler')
    }
    const root = mkdtempSync(path.join(tmpdir(), 'cc-haha-api-'))
    const env = createSandboxedTestEnvironment(path.join(root, 'home'))
    const missingRoot = path.join(root, 'unreadable-or-missing-install')
    expect(existsSync(missingRoot)).toBe(false)
    const current = readFallbackMacros(readFileSync('desktop/build/installer.nsh', 'utf8').replace(/\r\n/g, '\n'))
    const before = readFallbackMacros(readFileSync('scripts/pr/fixtures/installer-fallback-before-root-identity.nsh', 'utf8').replace(/\r\n/g, '\n'), true)
    try {
      for (const [version, macros] of [['before', before], ['current', current]] as const) {
        const executable = path.join(root, `${version}.exe`)
        const source = path.join(root, `${version}.nsi`)
        const journal = path.join(root, `${version}.log`)
        writeFileSync(source, renderFallbackApiHarness(macros, executable, journal, missingRoot))
        const compile = spawnSync(compiler, ['/V2', source], { env, encoding: 'utf8', timeout: 30_000 })
        expect(compile.error, compile.stderr || compile.stdout).toBeUndefined()
        expect(compile.status, compile.stderr || compile.stdout).toBe(0)
        const cases = version === 'before'
          ? [{ name: 'root-open-error', expected: 1 }]
          : fallbackApiCases
        for (const fixture of cases) {
          const run = spawnSync(executable, ['/S', `/CASE=${fixture.name}`], { env, timeout: 15_000, windowsHide: true })
          expect(run.error, `${version}/${fixture.name}`).toBeUndefined()
          expect(run.status, `${version}/${fixture.name}`).toBe(0)
          const trace = readFileSync(journal, 'utf8')
          expect(trace, `${version}/${fixture.name}`).toContain(`results=${fixture.expected},${fixture.expected},${fixture.expected};`)
          expect(trace, `${version}/${fixture.name}`).toContain('handles=0;allocations=0;badClose=0;stack=stack-canary;zero=caller-zero;one=caller-one;seven=caller-seven;')
          if (version === 'before') {
            // The frozen original macro claims external ownership even when
            // the installation root could not be established. The current
            // macro must return 0 for this exact same native fixture.
            expect(trace).toContain('other software outside the install directory')
          } else if (fixture.expected === 0) {
            expect(trace).toContain('Close them manually.')
          }
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  test.skipIf(process.platform !== 'win32')('handles blocked helper writes and old-uninstaller results in native NSIS', () => {
    const compiler = process.env.CC_HAHA_TEST_MAKENSIS ?? path.join(
      process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache', 'nsis',
      'nsis-3.0.4.1-nsis-3.0.4.1', 'Bin', 'makensis.exe',
    )
    const templates = process.env.CC_HAHA_TEST_NSIS_TEMPLATES
      ?? path.resolve('desktop/node_modules/app-builder-lib/templates/nsis')
    if (!existsSync(compiler) || !existsSync(path.join(templates, 'include/getProcessInfo.nsh'))) {
      throw new Error('Native NSIS regression requires electron-builder dependencies and its cached compiler, or CC_HAHA_TEST_MAKENSIS/CC_HAHA_TEST_NSIS_TEMPLATES')
    }
    const installer = readFileSync('desktop/build/installer.nsh', 'utf8').replace(/\r\n/g, '\n')
    const checkStart = installer.indexOf('!macro customCheckAppRunning')
    const writeStart = installer.indexOf('!insertmacro IS_POWERSHELL_AVAILABLE', checkStart)
    const writeEnd = installer.indexOf('  StrCpy $ccHahaProcessDiagnostic ""', writeStart)
    expect(writeStart).toBeGreaterThan(checkStart)
    expect(writeEnd).toBeGreaterThan(writeStart)
    // Expand the actual hook's write/fallback transition, rather than copying it.
    const writeHook = installer.slice(installer.indexOf('\n', writeStart) + 1, writeEnd)
    const root = mkdtempSync(path.join(tmpdir(), 'cc-haha-nsis-write-'))
    const env = createSandboxedTestEnvironment(path.join(root, 'home'))
    const cases = [
      { name: 'locked', target: 'locked', result: 0, exit: 0 },
      { name: 'locked-uninstall-failure', target: 'locked', result: 2, exit: 0 },
      { name: 'directory', target: 'directory', result: 2, exit: 0 },
      { name: 'normal', target: 'normal', result: 0, exit: 0 },
      { name: 'unrelated-uninstall-failure', target: 'normal', result: 2, exit: 2 },
      { name: 'running-app-with-stale-error', target: 'locked', result: 22, exit: 2 },
    ]
    try {
      for (const fixture of cases) {
        const executable = path.join(root, `${fixture.name}.exe`)
        const journal = path.join(root, `${fixture.name}.log`)
        const extracted = path.join(root, `${fixture.name}.ps1`)
        const script = String.raw`
Unicode true
RequestExecutionLevel user
SilentInstall silent
AllowSkipFiles off
Name "Isolated installer write regression"
OutFile "${executable}"
!addincludedir "${templates}\include"
!define APP_GUID "cc-haha-nsis-test-no-user-state"
!define UNINSTALL_APP_KEY "cc-haha-nsis-test-no-user-state"
!define APP_FILENAME "isolated-test"
!define PRODUCT_FILENAME "isolated-test"
!define BUILD_RESOURCES_DIR "${path.resolve('desktop/build')}"
!include "${path.resolve('desktop/build/installer.nsh')}"
LoadLanguageFile "${'${NSISDIR}'}\Contrib\Language files\English.nlf"
LangString uninstallFailed 1033 "Uninstall failed"
Var IsPowerShellAvailable
Var lockedHandle
Var journalHandle
Section
  InitPluginsDir
  StrCpy $IsPowerShellAvailable 0
  ${fixture.target === 'directory' ? 'CreateDirectory "$PLUGINSDIR\\check-install-processes.ps1"' : ''}
  ${fixture.target === 'locked' ? `System::Call 'kernel32::CreateFileW(w "$PLUGINSDIR\\check-install-processes.ps1", i 0x40000000, i 0, p 0, i 2, i 0x80, p 0) p.s'\n  Pop $lockedHandle` : ''}
${writeHook}
  ${fixture.target === 'locked' ? "System::Call 'kernel32::CloseHandle(p $lockedHandle)'" : ''}
  FileOpen $journalHandle "${journal}" w
  FileWrite $journalHandle "blocked=$ccHahaProcessHelperWriteBlocked; powershell=$IsPowerShellAvailable$\n"
  FileClose $journalHandle
  ${fixture.target === 'normal' ? `CopyFiles /SILENT "$PLUGINSDIR\\check-install-processes.ps1" "${extracted}"` : ''}
  StrCpy $R0 ${fixture.result}
  ${fixture.result === 22 ? 'SetErrors' : 'ClearErrors'}
  !insertmacro CcHahaHandleOldUninstallerResult
  FileOpen $journalHandle "${journal}" a
  FileSeek $journalHandle 0 END
  FileWrite $journalHandle "continued$\n"
  FileClose $journalHandle
SectionEnd
`
        const source = path.join(root, `${fixture.name}.nsi`)
        writeFileSync(source, script)
        const compile = spawnSync(compiler, ['/V2', source], { env, encoding: 'utf8', timeout: 15_000 })
        expect(compile.error, compile.stderr || compile.stdout).toBeUndefined()
        expect(compile.status, compile.stderr || compile.stdout).toBe(0)
        const run = spawnSync(executable, ['/S'], { env, timeout: 10_000, windowsHide: true })
        expect(run.error).toBeUndefined()
        expect(run.status, fixture.name).toBe(fixture.exit)
        const trace = readFileSync(journal, 'utf8')
        const blocked = fixture.target !== 'normal'
        expect(trace, fixture.name).toContain(`blocked=${blocked ? 1 : 0}; powershell=${blocked ? 1 : 0}`)
        expect(trace.includes('continued'), fixture.name).toBe(fixture.exit === 0)
        if (!blocked) {
          expect(readFileSync(extracted, 'utf8')).toBe(
            readFileSync('desktop/build/check-install-processes.ps1', 'utf8').replace(/\r\n/g, '\n'),
          )
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 90_000)

  test('resets the PowerShell module path before deciding whether PowerShell is usable', () => {
    const installerHook = readFileSync('desktop/build/installer.nsh', 'utf8').replace(/\r\n/g, '\n')
    const macro = installerHook.match(
      /!macro CcHahaUseDefaultPowerShellModulePath\n([\s\S]*?)!macroend/,
    )?.[1]
    expect(macro).toContain('System::Call \'kernel32::SetEnvironmentVariable(w "PSModulePath", p 0)\'')

    const checkStart = installerHook.indexOf('!macro customCheckAppRunning')
    const reset = installerHook.indexOf('!insertmacro CcHahaUseDefaultPowerShellModulePath', checkStart)
    const availability = installerHook.indexOf('!insertmacro IS_POWERSHELL_AVAILABLE', checkStart)
    expect(checkStart).toBeGreaterThan(-1)
    expect(reset).toBeGreaterThan(checkStart)
    expect(availability).toBeGreaterThan(reset)
  })

  test.skipIf(process.platform !== 'win32')('drops an inherited foreign PSModulePath before PowerShell children start in native NSIS', () => {
    const compiler = process.env.CC_HAHA_TEST_MAKENSIS ?? path.join(
      process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache', 'nsis',
      'nsis-3.0.4.1-nsis-3.0.4.1', 'Bin', 'makensis.exe',
    )
    const templates = process.env.CC_HAHA_TEST_NSIS_TEMPLATES
      ?? path.resolve('desktop/node_modules/app-builder-lib/templates/nsis')
    if (!existsSync(compiler) || !existsSync(path.join(templates, 'include/allowOnlyOneInstallerInstance.nsh'))) {
      throw new Error('Native NSIS regression requires electron-builder dependencies and its cached compiler, or CC_HAHA_TEST_MAKENSIS/CC_HAHA_TEST_NSIS_TEMPLATES')
    }
    const root = mkdtempSync(path.join(tmpdir(), 'cc-haha-nsis-psmodulepath-'))
    // Stands in for PowerShell 7's Microsoft.PowerShell.Security: listed ahead
    // of the Windows PowerShell modules, it shadows Get-ExecutionPolicy and
    // fails to load in 5.1, as the real PowerShell 7 module does.
    const foreignModules = path.join(root, 'foreign-modules')
    const security = path.join(foreignModules, 'Microsoft.PowerShell.Security')
    mkdirSync(security, { recursive: true })
    writeFileSync(path.join(security, 'Microsoft.PowerShell.Security.psd1'), [
      '@{',
      "  ModuleVersion = '99.0.0'",
      "  RootModule = 'Broken.psm1'",
      "  FunctionsToExport = @('Get-ExecutionPolicy')",
      '  CmdletsToExport = @()',
      '}',
      '',
    ].join('\r\n'))
    writeFileSync(path.join(security, 'Broken.psm1'), "throw 'Simulated PowerShell 7 module loaded by Windows PowerShell'\r\n")
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    const baseEnv = Object.fromEntries(
      Object.entries(createSandboxedTestEnvironment(path.join(root, 'home')))
        .filter(([key]) => key.toLowerCase() !== 'psmodulepath'),
    )
    const env = {
      ...baseEnv,
      PSModulePath: `${foreignModules};${systemRoot}\\system32\\WindowsPowerShell\\v1.0\\Modules`,
    }
    // Both fixtures ask Windows PowerShell, without loading any module, whether
    // the foreign module directory is still on its module path. Importing
    // Microsoft.PowerShell.Security by name cannot tell the two apart: 5.1 loads
    // its in-box core modules from $PSHOME, so that import succeeds either way,
    // while command auto-loading (Get-ExecutionPolicy) still picks the foreign
    // copy. electron-builder's full IS_POWERSHELL_AVAILABLE check is left out:
    // it starts PowerShell without -NoProfile against the sandbox's cold module
    // analysis cache, and on CI runners it took from 8 s to over 30 s, too
    // variable for the release smoke this test gates.
    const backtick = '`'
    try {
      for (const fixture of [
        { name: 'inherited-module-path', reset: false, expected: 'foreign=1' },
        { name: 'reset-module-path', reset: true, expected: 'foreign=0' },
      ]) {
        const executable = path.join(root, `${fixture.name}.exe`)
        const journal = path.join(root, `${fixture.name}.log`)
        const script = String.raw`
Unicode true
RequestExecutionLevel user
SilentInstall silent
Name "Isolated PowerShell module path regression"
OutFile "${executable}"
!addincludedir "${templates}\include"
!define APP_GUID "cc-haha-nsis-test-no-user-state"
!define UNINSTALL_APP_KEY "cc-haha-nsis-test-no-user-state"
!define APP_FILENAME "isolated-test"
!define PRODUCT_FILENAME "isolated-test"
!define BUILD_RESOURCES_DIR "${path.resolve('desktop/build')}"
!include "${path.resolve('desktop/build/installer.nsh')}"
!include "allowOnlyOneInstallerInstance.nsh"
LoadLanguageFile "${'${NSISDIR}'}\Contrib\Language files\English.nlf"
LangString uninstallFailed 1033 "Uninstall failed"
Var PowerShellPath
Var journalHandle
Section
  StrCpy $PowerShellPath "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ${fixture.reset ? '!insertmacro CcHahaUseDefaultPowerShellModulePath' : ''}
  FileOpen $journalHandle "${journal}" w
  nsExec::Exec ${backtick}"$PowerShellPath" -NoLogo -NoProfile -NonInteractive -Command "if ($$env:PSModulePath -like '*foreign-modules*') { exit 1 } else { exit 0 }"${backtick}
  Pop $0
  FileWrite $journalHandle "foreign=$0$\n"
  FileClose $journalHandle
SectionEnd
`
        const source = path.join(root, `${fixture.name}.nsi`)
        writeFileSync(source, script)
        const compile = spawnSync(compiler, ['/V2', source], { env, encoding: 'utf8', timeout: 15_000 })
        expect(compile.error, compile.stderr || compile.stdout).toBeUndefined()
        expect(compile.status, compile.stderr || compile.stdout).toBe(0)
        const run = spawnSync(executable, ['/S'], { env, timeout: 30_000, windowsHide: true })
        expect(run.error).toBeUndefined()
        expect(run.status, fixture.name).toBe(0)
        // Without the reset the child still sees the foreign path, proving the
        // fixture reproduces the inheritance the reset removes.
        expect(readFileSync(journal, 'utf8'), fixture.name).toContain(fixture.expected)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 90_000)

  test.skipIf(process.platform !== 'win32')('blocks the no-PowerShell fallback only for helpers that run from the install directory (#1879)', async () => {
    const compiler = process.env.CC_HAHA_TEST_MAKENSIS ?? path.join(
      process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache', 'nsis',
      'nsis-3.0.4.1-nsis-3.0.4.1', 'Bin', 'makensis.exe',
    )
    const templates = process.env.CC_HAHA_TEST_NSIS_TEMPLATES
      ?? path.resolve('desktop/node_modules/app-builder-lib/templates/nsis')
    if (!existsSync(compiler) || !existsSync(path.join(templates, 'include/getProcessInfo.nsh'))) {
      throw new Error('Native NSIS regression requires electron-builder dependencies and its cached compiler, or CC_HAHA_TEST_MAKENSIS/CC_HAHA_TEST_NSIS_TEMPLATES')
    }
    const root = mkdtempSync(path.join(tmpdir(), 'cc-haha-nsis-fallback-'))
    const env = createSandboxedTestEnvironment(path.join(root, 'home'))
    // Setup knows the install directory through a junction (a Programs folder
    // moved to another drive), while Windows reports process paths resolved.
    const realInstallDir = path.join(root, 'Moved Programs', 'Claude Code Haha')
    const installDir = path.join(root, 'Claude Code Haha')
    // A sibling whose name starts with the install directory's: Windows
    // Terminal's console host and the app's bundled one share an image name.
    const foreignDir = `${realInstallDir} Tools`
    const bundledDir = path.join(installDir, 'resources')
    mkdirSync(foreignDir, { recursive: true })
    mkdirSync(realInstallDir, { recursive: true })
    symlinkSync(realInstallDir, installDir, 'junction')
    mkdirSync(bundledDir, { recursive: true })
    const probeSource = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'ping.exe')
    const probes: ChildProcess[] = []
    const stopProbe = (probe: ChildProcess) => new Promise<void>((resolve, reject) => {
      if (!probe.pid || probe.exitCode !== null || probe.signalCode !== null) return resolve()
      probe.once('exit', () => resolve())
      probe.once('error', reject)
      probe.kill()
    })
    const startProbe = async (directory: string, imageName = 'OpenConsole.exe') => {
      const executable = path.join(directory, imageName)
      copyFileSync(probeSource, executable)
      const probe = spawn(executable, ['-t', '127.0.0.1'], { stdio: 'ignore', windowsHide: true })
      probes.push(probe)
      await new Promise<void>((resolve, reject) => {
        probe.once('spawn', () => resolve())
        probe.once('error', reject)
      })
      await new Promise(resolve => setTimeout(resolve, 500))
      expect(probe.exitCode).toBeNull()
      return probe.pid!
    }
    const installer = readFileSync('desktop/build/installer.nsh', 'utf8').replace(/\r\n/g, '\n')
    const before = readFallbackMacros(readFileSync('scripts/pr/fixtures/installer-fallback-before-residual-matches.nsh', 'utf8').replace(/\r\n/g, '\n'), { includeFind: true, frozenResidual: true })
    const current = readFallbackMacros(installer, { includeFind: true })
    const builds = [['before', before], ['current', current]].map(([version, macros]) => {
      const executable = path.join(root, `fallback-${version}.exe`)
      const source = path.join(root, `fallback-${version}.nsi`)
      const journal = path.join(root, `fallback-${version}.log`)
      const rendered = renderResidualFindNativeHarness(macros!, before, executable, journal, installDir)
      return { version: version!, macros: macros!, executable, source, journal, rendered }
    })
    const check = (caseName: string, expectedSafe: number, expectedBefore = expectedSafe) => {
      const traces: Record<string, string> = {}
      for (const build of builds) {
        for (const file of [build.journal, `${build.journal}.csv`, `${build.journal}.residual.csv`]) rmSync(file, { force: true })
        const startedAtUtc = new Date().toISOString()
        const run = spawnSync(build.executable, ['/S'], { env, timeout: 60_000, windowsHide: true })
        const files = residualRunFiles(build.journal)
        const trace = files.log ?? ''
        const expected = build.version === 'before' ? expectedBefore : expectedSafe
        preserveResidualEvidence(`native-${build.version}-${caseName}`, {
          mode: 'real-nsis-tasklist-findstr-census-file-identity-and-owned-ping-processes',
          startedAtUtc, finishedAtUtc: new Date().toISOString(), case: caseName,
          sourceSha256: sha256(build.rendered), macroSha256: sha256(build.macros),
          productionSourceSha256: sha256(installer), expectedSafeResult: expectedSafe,
          expectedObservedResult: expected, observedResults: trace.match(/results=([^;]+);/)?.[1] ?? null,
          ownedLiveProbePids: probes.filter(probe => probe.exitCode === null && probe.signalCode === null).map(probe => probe.pid),
          exitCode: run.status, error: run.error?.message,
        }, files)
        expect(run.error, `${build.version}/${caseName}`).toBeUndefined()
        expect(run.status, `${build.version}/${caseName}`).toBe(0)
        expect(trace, `${build.version}/${caseName}`).toStartWith(`results=${expected};`)
        expect(trace).toContain('originalFilter=0;')
        expect(trace).toContain('stack=stack-canary;zero=caller-zero;one=caller-one;two=caller-two;three=caller-three;seven=caller-seven;')
        traces[build.version] = trace
      }
      return traces
    }
    try {
      for (const build of builds) {
        writeFileSync(build.source, build.rendered)
        const compileStartedAtUtc = new Date().toISOString()
        const compile = spawnSync(compiler, ['/V2', build.source], { env, encoding: 'utf8', timeout: 15_000 })
        preserveResidualEvidence(`native-${build.version}-compile`, {
          mode: 'real-nsis-tasklist-findstr-census-file-identity-and-owned-ping-processes',
          compileStartedAtUtc, compileFinishedAtUtc: new Date().toISOString(),
          sourceSha256: sha256(build.rendered), macroSha256: sha256(build.macros),
          productionSourceSha256: sha256(installer), ownedProbeSourceSha256: sha256(readFileSync(probeSource)),
          status: compile.status, error: compile.error?.message,
          executableSha256: existsSync(build.executable) ? sha256(readFileSync(build.executable)) : null,
        }, { nsi: build.rendered, 'compile.log': `${compile.stdout ?? ''}${compile.stderr ?? ''}` })
        expect(compile.error, compile.stderr || compile.stdout).toBeUndefined()
        expect(compile.status, compile.stderr || compile.stdout).toBe(0)
      }

      const foreignPid = await startProbe(foreignDir)
      const foreignOnly = check('external-OpenConsole', 1)
      expect(foreignOnly.before).toContain('other software outside the install directory')
      expect(foreignOnly.current).toContain('verified outside the install directory')
      expect(foreignOnly.current).not.toContain(`PID ${foreignPid})`)

      const bundledPid = await startProbe(bundledDir)
      const withBundled = check('internal-OpenConsole-through-junction', 0)
      expect(withBundled.current).toContain(`OpenConsole.exe (PID ${bundledPid});`)
      expect(withBundled.current).not.toContain(`PID ${foreignPid})`)
      expect(withBundled.current).toContain('Close them manually.')
      await stopProbe(probes[1]!)
      await stopProbe(probes[0]!)

      const substringPid = await startProbe(bundledDir, 'foorg.exe')
      const internalSubstring = check('internal-foorg-through-junction', 0, 1)
      expect(internalSubstring.before).toContain('originalFilter=0;')
      expect(internalSubstring.before).toContain('foorg.exe')
      expect(internalSubstring.current).toContain('no verified external path')
      expect(internalSubstring.current).toContain(`"foorg.exe","${substringPid}"`)
      await stopProbe(probes[2]!)

      const externalRgPid = await startProbe(foreignDir, 'rg.exe')
      const externalRg = check('external-exact-rg', 1)
      expect(externalRg.current).toContain('verified outside the install directory')
      const mixedFoorgPid = await startProbe(bundledDir, 'foorg.exe')
      const mixed = check('external-exact-rg-with-internal-foorg', 0, 1)
      expect(mixed.before).toContain('other software outside the install directory')
      expect(mixed.before).toContain('foorg.exe')
      expect(mixed.current).toContain(`"foorg.exe","${mixedFoorgPid}"`)
      expect(mixed.current).toContain('no verified external path')
      expect(probes[3]!.pid).toBe(externalRgPid)
      expect(probes[3]!.exitCode).toBeNull()
      expect(probes[4]!.exitCode).toBeNull()
      await stopProbe(probes[4]!)
      await stopProbe(probes[3]!)

      // Names only this app uses still block wherever the process runs from.
      const sidecarPid = await startProbe(foreignDir, 'claude-sidecar.exe')
      const withSidecar = check('external-unique-sidecar', 0)
      expect(withSidecar.current).toContain(`claude-sidecar.exe (PID ${sidecarPid});`)
    } finally {
      for (const probe of probes) await stopProbe(probe)
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  test('uses a directory-boundary-aware process helper', () => {
    // A Windows checkout has CRLF line endings.
    const installerHook = readFileSync('desktop/build/installer.nsh', 'utf8').replace(/\r\n/g, '\n')
    const processHelper = readFileSync(
      'desktop/build/check-install-processes.ps1',
      'utf8',
    )

    expect(installerHook).not.toContain('!insertmacro _CHECK_APP_RUNNING')
    expect(installerHook).toContain('check-install-processes.ps1')
    expect(installerHook).toContain('!macro CcHahaFindInstallProcess')
    expect(installerHook).toContain('!macro CcHahaKillInstallProcess')
    expect(installerHook).toContain('-InstallerPid "$pid"')
    expect(installerHook).toContain('-InstallerParentPid "$1"')
    // The USERNAME filter makes tasklist look up every process owner, which can
    // block forever and froze setup and the silent uninstaller.
    expect(installerHook).not.toContain('USERNAME eq')
    expect(installerHook).toContain(
      'nsExec::Exec /TIMEOUT=30000 \'"$CmdPath" /D /C tasklist /FO CSV /NH > "$PLUGINSDIR\\cc-haha-processes.csv"\'',
    )
    expect(installerHook).toContain('nsExec::ExecToStack /TIMEOUT=30000 \'"$SYSDIR\\findstr.exe" /I /L')
    expect(installerHook).toContain('tasklist process enumeration failed')
    expect(installerHook).toContain('fallback process filtering failed')
    expect(installerHook).toMatch(
      /tasklist process enumeration failed[\s\S]*StrCpy \$\{_RETURN\} 0/,
    )
    expect(installerHook).toMatch(
      /fallback process filtering failed[\s\S]*StrCpy \$\{_RETURN\} 0/,
    )
    // A timed-out or unlaunchable nsExec pushes "timeout"/"error". LogicLib's
    // == and != compare strings, so those block setup; an integer test (= or
    // <>) would read them as 0 and let setup continue on a partial CSV.
    expect(installerHook).toMatch(
      /tasklist \/FO CSV \/NH > [^\n]*\n\s*Pop \$\{_RETURN\}\n\s*\$\{If\} \$\{_RETURN\} != 0\n/,
    )
    const filter = installerHook.match(/!macro CcHahaFilterFallbackProcesses[^\n]*\n[\s\S]*?\n!macroend/)?.[0]
    expect(filter).toMatch(/findstr\.exe[^\n]*\n\s*Pop \$\{_RETURN\}\n\s*Pop \$\{_OUTPUT\}\n/)
    expect(installerHook).toMatch(/!insertmacro CcHahaFilterFallbackProcesses[^\n]*\n\s*\$\{If\} \$\{_RETURN\} == 0\n/)
    expect(installerHook).toContain('possibly in another user\'s session')
    expect(installerHook).toContain('claude-sidecar-x86_64-pc-windows-msvc.exe')
    expect(installerHook).toContain('claude-sidecar-aarch64-pc-windows-msvc.exe')
    expect(installerHook).toContain('/C:"OpenConsole.exe"')
    expect(installerHook).toContain('/C:"winpty-agent.exe"')
    expect(installerHook).toContain('/C:"rg.exe"')
    expect(installerHook).toContain('bundled terminal/search helper')
    expect(installerHook).toContain('Differently named child processes cannot be attributed')
    // A name hit is attributed by executable path before it blocks setup, and
    // the two name lists stay in sync (#1879).
    expect(installerHook).toMatch(
      /\$\{If\} \$\{_RETURN\} == 0\n[^\n]*possibly in another user's session[^\n]*\n\s*!insertmacro CcHahaAttributeFallbackMatches "\$\{_FILE\}" \$\{_RETURN\}\n\s*\$\{If\} \$\{_RETURN\} == 1\n\s*!insertmacro CcHahaVerifyFallbackRemainder "\$\{_FILE\}" \$\{_RETURN\} "\$CmdPath"\n\s*\$\{EndIf\}\n\s*\$\{ElseIf\} \$\{_RETURN\} == 1\n/,
    )
    const attribution = installerHook.slice(
      installerHook.indexOf('!macro CcHahaAttributeFallbackMatches'),
      installerHook.indexOf('!macro CcHahaFindInstallProcess'),
    )
    const findstrNames = [...installerHook.matchAll(/\/C:"([^"$]+\.exe)"/g)].map(([, name]) => name!)
    expect(findstrNames.length).toBeGreaterThan(0)
    for (const name of findstrNames) {
      expect(attribution).toContain(`$R5 == "${name}"`)
    }
    expect(attribution).toContain('$R5 == "${_FILE}"')
    expect(installerHook).not.toContain('| "$FindPath"')

    expect(processHelper).toContain('function Test-PathInsideInstallDirectory')
    expect(processHelper).toContain(
      '$rootWithSeparator = $resolvedRoot + [IO.Path]::DirectorySeparatorChar',
    )
    expect(processHelper).toContain('[StringComparison]::OrdinalIgnoreCase')
    expect(processHelper).toContain('$process.ProcessId -eq $InstallerPid')
    expect(processHelper).not.toContain('$process.ProcessId -eq $InstallerParentPid')
    expect(processHelper).toContain('Matched protected install process:')
    expect(processHelper).toContain('Blocked unknown-path application process:')
    expect(processHelper).toContain('$unknownPathMatches.Add($process)')
    expect(installerHook).not.toContain('taskkill')
    expect(installerHook).toContain('refusing to terminate by image name')
    const processCheck = installerHook.match(/!macro customCheckAppRunning\n[\s\S]*?\n!macroend/)![0]
    expect(processCheck.match(/SetErrorLevel 22/g)).toHaveLength(2)
    expect(installerHook).toMatch(
      /MessageBox MB_OKCANCEL[\s\S]*SetErrorLevel 22\s+Quit/,
    )
    expect(installerHook).toMatch(
      /MessageBox MB_RETRYCANCEL[\s\S]*SetErrorLevel 22\s+Quit/,
    )
  })

  test('writes the process helper without a fatal File extraction (#1486)', () => {
    const installerHook = readFileSync('desktop/build/installer.nsh', 'utf8').replace(/\r\n/g, '\n')
    const processHelper = readFileSync('desktop/build/check-install-processes.ps1', 'utf8').replace(/\r\n/g, '\n')
    const helperWriter = readFileSync('desktop/build/check-install-processes.nsh', 'utf8').replace(/\r\n/g, '\n')

    // NSIS aborts setup when `File` cannot write; security tools block .ps1 in %TEMP%.
    expect(installerHook).not.toMatch(/^\s*File\b.*check-install-processes\.ps1/m)
    expect(installerHook).toContain('!include "${BUILD_RESOURCES_DIR}\\check-install-processes.nsh"')
    expect(helperWriter).not.toMatch(/^\s*File\b/m)
    expect(helperWriter).toMatch(/ClearErrors\s+FileOpen \$0 "\$\{_PATH\}" w\s+\$\{If\} \$\{Errors\}\s+StrCpy \$\{_WRITE_FAILED\} "1"/)
    expect(helperWriter).toContain('StrCpy ${_WRITE_FAILED} "0"')
    expect(helperWriter).toMatch(/\$\{If\} \$\{Errors\}\s+StrCpy \$\{_WRITE_FAILED\} "1"\s+\$\{EndIf\}\s+FileClose/)

    // The committed writer is generated from, and reproduces, the real helper.
    expect(helperWriter).toBe(renderInstallProcessHelperNsh(processHelper))
    expect(decodeFileWrites(helperWriter)).toBe(processHelper)

    const checkAppRunning = installerHook.slice(
      installerHook.indexOf('!macro customCheckAppRunning'),
      installerHook.indexOf('cc_haha_stop_process:'),
    )
    expect(checkAppRunning).toMatch(
      /!insertmacro IS_POWERSHELL_AVAILABLE[\s\S]*!insertmacro CcHahaWriteInstallProcessHelper "\$PLUGINSDIR\\check-install-processes\.ps1" \$ccHahaProcessHelperWriteBlocked[\s\S]*?\$\{If\} \$ccHahaProcessHelperWriteBlocked == "1"\s+\$\{OrIfNot\} \$\{FileExists\} "\$PLUGINSDIR\\check-install-processes\.ps1"[\s\S]*?StrCpy \$IsPowerShellAvailable 1/,
    )

    // A helper that never ran (missing file, launch error) must not read as "no process".
    const findProcess = installerHook.slice(
      installerHook.indexOf('!macro CcHahaFindInstallProcess'),
      installerHook.indexOf('!macro CcHahaKillInstallProcess'),
    )
    expect(findProcess).toMatch(
      /\$\{If\} \$\{_RETURN\} != 0\s+\$\{AndIf\} \$\{_RETURN\} != 1[\s\S]*?StrCpy \$IsPowerShellAvailable 1\s+\$\{EndIf\}\s+\$\{EndIf\}\s+\$\{If\} \$IsPowerShellAvailable != 0\s+Delete "\$PLUGINSDIR\\cc-haha-processes\.csv"/,
    )
  })

  test('installs over the old version when its uninstaller cannot write the helper (#1486)', () => {
    const installerHook = readFileSync('desktop/build/installer.nsh', 'utf8').replace(/\r\n/g, '\n')
    const handler = installerHook.slice(
      installerHook.indexOf('!macro CcHahaHandleOldUninstallerResult'),
      installerHook.indexOf('!macro customUnInstallCheck\n'),
    )

    expect(installerHook).toMatch(
      /!macro customUnInstallCheck\s+!insertmacro CcHahaHandleOldUninstallerResult\s+!macroend/,
    )
    expect(installerHook).toMatch(
      /!macro customUnInstallCheckCurrentUser\s+!insertmacro CcHahaHandleOldUninstallerResult\s+!macroend/,
    )
    // Overwrite in place only when this installer hit the same blocked helper
    // write, and never when the old uninstaller saw the app running (exit 22).
    expect(installerHook).toMatch(
      /!insertmacro CcHahaWriteInstallProcessHelper[\s\S]*?StrCpy \$ccHahaProcessHelperWriteBlocked "1"/,
    )
    expect(handler).toMatch(
      /^\s*\$\{If\} \$R0 != 0\s+\$\{AndIf\} \$R0 != 22\s+\$\{AndIf\} \$ccHahaProcessHelperWriteBlocked == "1"\s+DetailPrint `[^`]*installing over the existing files\.`/m,
    )
    // The launch-error branch must not swallow exit code 22 (ExecWait keeps the
    // error flag when the in-place retry runs), and other failures still quit.
    expect(handler).toMatch(/\$\{ElseIf\} \$R0 != 22\s+\$\{AndIf\} \$\{Errors\}/)
    expect(handler).toMatch(/\$\{ElseIf\} \$R0 != 0\s+MessageBox [^\n]*\$\(uninstallFailed\)[\s\S]*?SetErrorLevel 2\s+Quit\s+\$\{EndIf\}/)
    expect(handler.match(/Quit/g)).toHaveLength(1)
  })

  test('keeps sibling-prefix and real install process cases in Windows smoke', () => {
    const installerSmoke = readFileSync(
      'desktop/scripts/windows-installer-smoke.ps1',
      'utf8',
    )

    expect(installerSmoke).toContain("$siblingDir = \"$installDir Tools\"")
    expect(installerSmoke).toContain("$siblingProbe = Join-Path $siblingDir 'Claude Code Haha.exe'")
    expect(installerSmoke).toContain('Sibling-prefix process remains running')
    expect(installerSmoke).toContain('Install-directory parent process detection')
    expect(installerSmoke).toContain('Install-directory process was not terminated')
    // Only a helper inside the install directory blocks the no-CLR fallback; a
    // same-named one next to it (other software) stays alive through the next
    // no-CLR stage without changing its outcome: exit 20 on the elevated CI
    // runner (22 before the fix), a completed reinstall for a trusted user.
    expect(installerSmoke).toContain("$installHelperProbe = Join-Path $installDir 'OpenConsole.exe'")
    expect(installerSmoke).toMatch(
      /No-CLR install-directory bundled-helper process reinstall' -ExpectedExitCode 22/,
    )
    expect(installerSmoke).toContain('No-CLR exact-image fallback terminated an install-directory bundled-helper')
    expect(installerSmoke).toContain("$bundledHelperProbe = Join-Path $siblingDir 'OpenConsole.exe'")
    expect(installerSmoke).not.toContain('No-CLR external bundled-helper process reinstall')
    expect(installerSmoke).toMatch(
      /\$bundledHelperProcess = Start-Process[\s\S]*?default-mode reinstall without CLR[\s\S]*?No-CLR exact-image fallback terminated an external bundled-helper/,
    )
  })
})
