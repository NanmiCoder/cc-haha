import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import { createSandboxedTestEnvironment } from './test-environment'

const script = resolve('scripts/pr/windows-installer-etw-calibration.ps1')
const powershell = process.platform === 'win32'
  ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
  : ['/opt/homebrew/bin/pwsh', '/usr/bin/pwsh'].find(existsSync)
const ps = (value: string) => `'${value.replaceAll("'", "''")}'`
function pure(code: string) {
  const root = mkdtempSync(join(tmpdir(), 'cc-haha-etw-pure-'))
  try {
    const file = join(root, 'pure.ps1')
    writeFileSync(file, `$ErrorActionPreference='Stop'\n. ${ps(script)} -DefinitionsOnly\n${code}\n`)
    const result = spawnSync(powershell!, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', file], {
      env: createSandboxedTestEnvironment(join(root, 'home'), { GITHUB_ACTIONS: 'false' }), encoding: 'utf8', timeout: 25_000, maxBuffer: 1024 * 1024,
    })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    return JSON.parse(result.stdout.trim())
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('requires the deterministic contract while keeping OS observations advisory', () => {
  const jobs = (parse(readFileSync('.github/workflows/pr-quality.yml', 'utf8')) as any).jobs
  const job = jobs['windows-installer-checks']
  const contract = job.steps.find((item: any) => item.name === 'Validate the owned ETW calibration contract')
  const step = job.steps.find((item: any) => item.name === 'Collect owned ETW calibration without accounts or profiles (advisory)')
  expect(contract['continue-on-error']).not.toBe(true)
  expect(contract.if).toBe("always() && steps.prepare.outcome == 'success'")
  expect(contract.run).toBe('bun --no-env-file test ./scripts/pr/windows-installer-etw-calibration.test.ts')
  expect(step['continue-on-error']).toBe(true)
  expect(step.shell).toBe('powershell')
  expect(step.if).toBe("always() && steps.prepare.outcome == 'success'")
  expect(step['timeout-minutes']).toBe(3)
  expect(step.run).toContain('-RunCiCalibration')
  expect(step.run).not.toContain('windows-installer-etw-calibration.test.ts')
  expect(job.steps.indexOf(contract)).toBe(job.steps.findIndex((item: any) => item.name?.includes('Probe owned removal primitives')) + 1)
  expect(job.steps.indexOf(step)).toBe(job.steps.indexOf(contract) + 1)
  expect(job['continue-on-error']).not.toBe(true)
  for (const prior of job.steps.slice(0, job.steps.indexOf(step))) expect(prior['continue-on-error']).not.toBe(true)
  expect(jobs['pr-quality-gate'].needs).toContain('windows-installer-checks')
}, 30_000)

describe.skipIf(!powershell)('pure PowerShell ETW boundaries; no Windows API or registry calls', () => {
  test('parses and compiles the declared ABI without initializing ETW or touching HKCU', () => {
    const value = pure(`$errors=$null; $tokens=$null
      [Management.Automation.Language.Parser]::ParseFile(${ps(script)},[ref]$tokens,[ref]$errors)|Out-Null
      if($errors.Count){throw 'parse failure'}; Initialize-EtwNative
      $flags=[Reflection.BindingFlags]'NonPublic'; $log=[CcHahaCiEtw].GetNestedType('LogFile',$flags)
      @{header=[Runtime.InteropServices.Marshal]::SizeOf([type][CcHahaCiEtw+Header]); log=[Runtime.InteropServices.Marshal]::SizeOf([type]$log)}|ConvertTo-Json -Compress`)
    expect(value).toEqual({ header: 280, log: 448 })
  }, 30_000)

  test('denies execution before writing files when the explicit hosted CI scope is absent', () => {
    expect(pure(`$RunCiCalibration=$true; try { Assert-CiCalibration; throw 'unexpected admission' } catch { @{denied=$_.Exception.Message -ne 'unexpected admission'}|ConvertTo-Json -Compress }`)).toEqual({ denied: true })
  }, 30_000)

  test('refuses non-metadata tool names before resolving or executing any program', () => {
    expect(pure(`try { Invoke-ReadOnlyTool 'setup.exe' @() 'unused'; throw 'unexpected execution' } catch { @{denied=$_.Exception.Message -eq 'Only fixed read-only metadata tools are allowed'}|ConvertTo-Json -Compress }`)).toEqual({ denied: true })
  }, 30_000)

  test('never stops a session whose start outcome is uncertain, even when a query finds it', () => {
    expect(pure(`$n=[pscustomobject]@{Created=$false; StartAttempted=$true; stops=0; queries=0}
      $n|Add-Member ScriptMethod StopOwned {$this.stops++; throw 'must not stop'}
      $n|Add-Member ScriptMethod QueryOwn {$this.queries++; return @{code=0}}
      $s=@{}; Complete-OwnedSession $n $s
      @{stops=$n.stops; queries=$n.queries; cleanup=$s.cleanup}|ConvertTo-Json -Compress`)).toEqual({ stops: 0, queries: 1, cleanup: 'unknown' })
  }, 30_000)

  test('retains the first stop failure and marks the attempted boundary before invoking it', () => {
    expect(pure(`$n=[pscustomobject]@{Created=$true; StartAttempted=$true}
      $n|Add-Member ScriptMethod StopOwned {throw [ComponentModel.Win32Exception]::new(5)}
      $s=@{}; try { Complete-OwnedSession $n $s } catch { $e=Safe-Error $_ 'stop-owned-session' }
      @{attempted=$s.stopAttempted; code=$e.nativeCode; stage=$e.stage; noResult=!$s.ContainsKey('stop')}|ConvertTo-Json -Compress`)).toEqual({ attempted: true, code: 5, stage: 'stop-owned-session', noResult: true })
  }, 30_000)

  test('binds session cleanup to all three independent native identity fields', () => {
    const value = pure(`Initialize-EtwNative; $id=[guid]::NewGuid(); $p=[CcHahaCiEtw+Props]::new(); $w=[CcHahaCiEtw+Wnode]::new(); $w.Guid=$id; $w.Context=42; $p.W=$w
      $values=@([CcHahaCiEtw]::SameSession($p,42,$id,'C:\\owned\\trace.etl','C:\\owned\\trace.etl'),
        [CcHahaCiEtw]::SameSession($p,43,$id,'C:\\owned\\trace.etl','C:\\owned\\trace.etl'),
        [CcHahaCiEtw]::SameSession($p,42,[guid]::NewGuid(),'C:\\owned\\trace.etl','C:\\owned\\trace.etl'),
        [CcHahaCiEtw]::SameSession($p,42,$id,'C:\\other\\trace.etl','C:\\owned\\trace.etl'))
      ConvertTo-Json -InputObject $values -Compress`)
    expect(value).toEqual([true, false, false, false])
  }, 30_000)

  test('rejects a preexisting output and an ancestor link before creating its outside target', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-haha-etw-path-'))
    try {
      const workspace = join(root, 'workspace'), outside = join(root, 'outside')
      mkdirSync(workspace); mkdirSync(outside)
      symlinkSync(outside, join(workspace, 'artifacts'), process.platform === 'win32' ? 'junction' : 'dir')
      expect(pure(`try { Get-CiOutputPath ${ps(workspace)} ${ps(join(workspace, 'artifacts/windows-installer/new'))}; throw 'escaped' } catch { @{denied=$_.Exception.Message -eq 'Output ancestor is reparse'}|ConvertTo-Json -Compress }`)).toEqual({ denied: true })
      expect(existsSync(join(outside, 'windows-installer'))).toBe(false)
      expect(pure(`try { Get-CiOutputPath ${ps(root)} ${ps(outside)}; throw 'escaped' } catch { @{denied=$_.Exception.Message -ne 'escaped'}|ConvertTo-Json -Compress }`)).toEqual({ denied: true })
    } finally { rmSync(root, { recursive: true, force: true }) }
  }, 60_000)

  test('requires actual mapped write and set-restore events despite an unchanged final snapshot', () => {
    const result = pure(`$n=@{FileNtPath='\\Device\\fixture\\canary.bin'; KeyNtPath='\\REGISTRY\\USER\\fixture\\canary'; ThreadId=42}; $o=@{}; $k=@{}; $f=New-CalibrationFacts
      $file=[pscustomobject]@{ProviderId=[guid]'edd08927-9cc4-4e65-b970-c2560fb5c289'; Id=16; Version=1; ProcessId=$PID}
      Add-CalibrationEvent $f $file @{FileObject='0x42'; IssuingThreadId=42} $n $o $k
      $unmapped=$f.fileWrites; $file.Id=12
      Add-CalibrationEvent $f $file @{FileName=$n.FileNtPath; FileObject='0x42'} $n $o $k; $file.Id=16
      1..3|ForEach-Object { Add-CalibrationEvent $f $file @{FileObject='0x42'; IssuingThreadId=42} $n $o $k }
      $reg=[pscustomobject]@{ProviderId=[guid]'70eb4f03-c1de-4f73-a051-33d13d5413bd'; Id=5; Version=0; ProcessId=$PID}
      foreach($type in @(0,3,0)){ Add-CalibrationEvent $f $reg @{KeyName=$n.KeyNtPath; KeyObject='0x84'; ValueName='type-canary'; Type=$type; DataSize=0; Status=0} $n $o $k }
      @{unmapped=$unmapped; writes=$f.fileWrites; sets=$f.registrySets; mapping=$f.mapping}|ConvertTo-Json -Compress`)
    expect(result).toEqual({ unmapped: 0, writes: 3, sets: 3, mapping: 'canary-path-object-thread-observed' })
  }, 30_000)

  test.each(['missing', 'different'])('does not infer %s issuing threads from the matching process ID', kind => {
    const result = pure(`$n=@{FileNtPath='owned-file'; KeyNtPath='owned-key'; ThreadId=42}; $f=New-CalibrationFacts; $o=@{}; $k=@{}
      $file=[pscustomobject]@{ProviderId=[guid]'edd08927-9cc4-4e65-b970-c2560fb5c289'; Id=12; Version=1; ProcessId=$PID}
      Add-CalibrationEvent $f $file @{FileName=$n.FileNtPath; FileObject='0x42'} $n $o $k; $file.Id=16
      $data=@{FileObject='0x42'}; ${kind === 'different' ? '$data.IssuingThreadId=43' : ''}
      1..3|ForEach-Object { Add-CalibrationEvent $f $file $data $n $o $k }
      $reg=[pscustomobject]@{ProviderId=[guid]'70eb4f03-c1de-4f73-a051-33d13d5413bd'; Id=5; Version=0; ProcessId=$PID}
      foreach($type in @(0,3,0)){ Add-CalibrationEvent $f $reg @{KeyName=$n.KeyNtPath; KeyObject='0x84'; ValueName='type-canary'; Type=$type; DataSize=0; Status=0} $n $o $k }
      @{writes=$f.fileWrites; sets=$f.registrySets; mapping=$f.mapping}|ConvertTo-Json -Compress`)
    expect(result).toEqual({ writes: 0, sets: 3, mapping: 'unknown' })
  }, 30_000)

  test('does not retain captured values or promote zero pointers and unknown mappings', () => {
    const result = pure(`$n=@{FileNtPath='owned'; KeyNtPath='owned'; ThreadId=42}; $f=New-CalibrationFacts; $o=@{}; $k=@{}
      $r=[pscustomobject]@{ProviderId=[guid]'edd08927-9cc4-4e65-b970-c2560fb5c289'; Id=12; Version=1; ProcessId=$PID}
      Add-CalibrationEvent $f $r @{FileName='owned'; FileObject='0x0'} $n $o $k
      try { Add-CalibrationEvent $f $r @{CapturedDataSize=1; CapturedData='never-retain-this'} $n $o $k } catch { $e=Safe-Error $_ 'decode' }
      @{mapped=$o.Count; payloadFlag=$e.valuePayload; error=($e|ConvertTo-Json -Compress); mapping=$f.mapping}|ConvertTo-Json -Compress`)
    expect(result.mapped).toBe(0)
    expect(result.payloadFlag).toBe(true)
    expect(result.error).not.toContain('never-retain-this')
    expect(result.mapping).toBe('unknown')
  }, 30_000)

  test.each(['event-loss', 'buffer-loss', 'log-loss', 'realtime-loss', 'unfinalized', 'no-calibration', 'unrestored', 'job-unbound'])('keeps %s evidence not proven', kind => {
    expect(pure(`$h=@{EndTime=2; StartTime=1; Frequency=1; Written=1; EventsLost=0; BuffersLost=0}; $s=@{eventsLost=0; logBuffersLost=0; realTimeBuffersLost=0}; $f=@{mapping='canary-path-object-thread-observed'}; $restored=$true; $bound=$true
      switch(${ps(kind)}) { 'event-loss' {$h.EventsLost=1}; 'buffer-loss' {$h.BuffersLost=1}; 'log-loss' {$s.logBuffersLost=1}; 'realtime-loss' {$s.realTimeBuffersLost=1}; 'unfinalized' {$h.EndTime=0}; 'no-calibration' {$f.mapping='unknown'}; 'unrestored' {$restored=$false}; 'job-unbound' {$bound=$false} }
      @{accepted=(Test-CalibrationEvidence $h $s $f $restored $bound $true)}|ConvertTo-Json -Compress`)).toEqual({ accepted: false })
  }, 30_000)
})
