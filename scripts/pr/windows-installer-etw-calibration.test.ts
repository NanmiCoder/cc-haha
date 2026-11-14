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

// Replace only ETL I/O. Get-CalibrationFacts still parses, validates, decodes and
// writes each real XML fixture; no EventLogReader or Windows API is invoked.
const xmlReaderFixture = String.raw`
function New-Object {
  if ($args[0] -eq 'Diagnostics.Eventing.Reader.EventLogQuery') { return [pscustomobject]@{} }
  if ($args[0] -eq 'Diagnostics.Eventing.Reader.EventLogReader') {
    $reader=[pscustomobject]@{Index=0}
    $reader|Add-Member ScriptMethod ReadEvent { if($this.Index -ge $script:fixtureRecords.Count){return $null}; $item=$script:fixtureRecords[$this.Index]; $this.Index++; return $item }
    $reader|Add-Member ScriptMethod Dispose {}
    return $reader
  }
  return Microsoft.PowerShell.Utility\New-Object @args
}
function FixtureRecord([string]$Body,[int]$Id=30,[int]$Version=1,[int]$Process=124,[string]$Provider='edd08927-9cc4-4e65-b970-c2560fb5c289') {
  $xml="<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Guid='$Provider'/><EventID>$Id</EventID><Version>$Version</Version><TimeCreated SystemTime='2026-11-14T00:00:30Z'/><Execution ProcessID='$Process' ThreadID='42'/></System>$Body</Event>"
  $item=[pscustomobject]@{ProviderId=[guid]$Provider; Id=$Id; Version=$Version; ProcessId=$Process; ThreadId=42; TimeCreated=[datetime]'2026-11-14T00:00:30Z'; Xml=$xml}
  $item|Add-Member ScriptMethod ToXml {return $this.Xml}; $item|Add-Member ScriptMethod Dispose {}; return $item
}
function ScanFixture($Records) {
  $script:fixtureRecords=@($Records); $path=Join-Path ([IO.Path]::GetTempPath()) (([guid]::NewGuid().ToString('N'))+'.sanitized.xml')
  $native=@{ChildPid=123; ChildThreadId=42; CreationUtc='2026-11-14T00:00:00Z'; ExitUtc='2026-11-14T00:01:00Z'; ProcessIdentityVerified=$true; FileNtPath='owned'; KeyNtPath='owned'}
  try { $facts=Get-CalibrationFacts 'owned-not-an-etl' $path $native; $text=[IO.File]::ReadAllText($path)
    return @{facts=$facts; text=$text; eligible=(!$facts.ContainsKey('payloadScanComplete') -or $facts.payloadScanComplete)}
  } finally { if([IO.File]::Exists($path)){[IO.File]::Delete($path)} }
}
`

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
  test('quarantines opaque and nested XML bodies through the actual reader for other PIDs', () => {
    const result = pure(`${xmlReaderFixture}
      $marker='4E455645522D5055424C495348'; $out=@()
      foreach($body in @("<BinaryEventData>$marker</BinaryEventData>","<ProcessingErrorData><EventPayload>$marker</EventPayload></ProcessingErrorData>","<EventData><Binary>$marker</Binary></EventData>","<EventData><ComplexData><Data Name='CapturedData'>$marker</Data></ComplexData></EventData>")) {
        $r=ScanFixture @((FixtureRecord $body)); $out+=@{published=$r.text.Contains($marker); eligible=$r.eligible; unknown=$r.facts.unknownRecords; mapping=$r.facts.mapping}
      }; ConvertTo-Json -InputObject $out -Compress`)
    expect(result).toEqual(Array.from({ length: 4 }, () => ({ published: false, eligible: false, unknown: 1, mapping: 'not_proven' })))
  }, 30_000)

  test('rejects adjacent extra nodes, namespace substitutions, attributes and nested flat fields', () => {
    const result = pure(`${xmlReaderFixture}
      $marker='4E455645522D5055424C495348'; $out=@()
      $bodies=@("<EventData><Data Name='FileObject'>0x42</Data><Extra>$marker</Extra></EventData>","<EventData><Data Name='FileObject'><Data>$marker</Data></Data></EventData>","<EventData><Data Name='FileObject' Extra='$marker'>0x42</Data></EventData>","<EventData xmlns='urn:unknown'><Data Name='FileObject'>$marker</Data></EventData>","<EventData><Data xmlns='urn:unknown' Name='FileObject'>$marker</Data></EventData>","<EventData/><Extra>$marker</Extra>","<EventData/><!--$marker-->","<EventData><Data Name='FileObject'><![CDATA[$marker]]></Data></EventData>")
      foreach($body in $bodies) { $r=ScanFixture @((FixtureRecord $body)); $out+=@{published=$r.text.Contains($marker); eligible=$r.eligible; unknown=$r.facts.unknownRecords} }
      $record=FixtureRecord '<EventData/>'; $record.Xml=$record.Xml.Replace("<Event xmlns=", "<Event Extra='$marker' xmlns=")
      $r=ScanFixture @($record); $out+=@{published=$r.text.Contains($marker); eligible=$r.eligible; unknown=$r.facts.unknownRecords}
      $record=FixtureRecord '<EventData/>'; $record.Xml="<!DOCTYPE Event [<!ENTITY hidden '$marker'>]>"+$record.Xml
      $r=ScanFixture @($record); $out+=@{published=$r.text.Contains($marker); eligible=$r.eligible; unknown=$r.facts.unknownRecords}
      $record=FixtureRecord '<EventData/>'; $record.Xml=$record.Xml.Replace('<System>',"<System><Unexpected>$marker</Unexpected>")
      $r=ScanFixture @($record); $out+=@{published=$r.text.Contains($marker); eligible=$r.eligible; unknown=$r.facts.unknownRecords}
      ConvertTo-Json -InputObject $out -Compress`)
    expect(result).toEqual(Array.from({ length: 11 }, () => ({ published: false, eligible: false, unknown: 1 })))
  }, 30_000)

  test('retains known flat metadata fields and an empty flat metadata-header fixture', () => {
    const result = pure(`${xmlReaderFixture}
      # Field shape is the actual c899 File30/v1 shape, with test-owned values.
      $flat="<EventData><Data Name='Irp'>0x99</Data><Data Name='FileObject'>0x42</Data><Data Name='IssuingThreadId'>42</Data><Data Name='CreateOptions'>37752928</Data><Data Name='CreateAttributes'>0</Data><Data Name='ShareAccess'>7</Data><Data Name='FileName'>owned</Data></EventData>"
      $r=ScanFixture @((FixtureRecord $flat),(FixtureRecord '<EventData/>' 0 2 124 '68fdd900-4a3e-11d1-84f4-0000f80464e3'))
      @{eligible=$r.eligible; unknown=$r.facts.unknownRecords; events=$r.facts.events; flat=$r.text.Contains('FileName'); mapping=$r.facts.mapping}|ConvertTo-Json -Compress`)
    expect(result).toEqual({ eligible: true, unknown: 0, events: 2, flat: true, mapping: 'not_proven' })
  }, 30_000)

  test('keeps a rejected metadata header private while scanning later valid canary facts', () => {
    const result = pure(`${xmlReaderFixture}
      $marker='4E455645522D5055424C495348'
      $unknown=FixtureRecord "<ProcessingErrorData><ErrorCode>15003</ErrorCode><DataItemName/><EventPayload>$marker</EventPayload></ProcessingErrorData>" 0 2 124 '68fdd900-4a3e-11d1-84f4-0000f80464e3'
      $create=FixtureRecord "<EventData><Data Name='FileName'>owned</Data><Data Name='FileObject'>0x42</Data><Data Name='Irp'>0x99</Data><Data Name='IssuingThreadId'>42</Data></EventData>" 30 1 123
      $end=FixtureRecord "<EventData><Data Name='Irp'>0x99</Data><Data Name='Status'>0</Data></EventData>" 24 0 123
      $write=FixtureRecord "<EventData><Data Name='FileObject'>0x42</Data><Data Name='IssuingThreadId'>42</Data></EventData>" 16 1 123
      $r=ScanFixture @($unknown,$create,$end,$write)
      @{eligible=$r.eligible; unknown=$r.facts.unknownRecords; events=$r.facts.events; writes=$r.facts.fileWrites; published=$r.text.Contains($marker); mapping=$r.facts.mapping; sanitized=$r.facts.xmlMeaning; labelled=$r.text.Contains('CompleteStream="false"')}|ConvertTo-Json -Compress`)
    expect(result).toEqual({ eligible: false, unknown: 1, events: 4, writes: 1, published: false, mapping: 'not_proven', sanitized: 'validated-records-only;not-complete-stream', labelled: true })
  }, 30_000)

  test('maps the observed File30/v1 only inside the retained fresh-child epoch and explicit thread', () => {
    const result = pure(`$n=@{ChildPid=123; ChildThreadId=42; CreationUtc='2026-11-14T00:00:00Z'; ExitUtc='2026-11-14T00:01:00Z'; ProcessIdentityVerified=$true; FileNtPath='\\Device\\owned\\canary.bin'; KeyNtPath='\\REGISTRY\\USER\\S-1-5-21-42\\Software\\CcHaha-CI-Fixture-owned'}
      $f=New-FreshCalibrationFacts; $o=@{}; $k=@{}
      $r=[pscustomobject]@{ProviderId=[guid]'edd08927-9cc4-4e65-b970-c2560fb5c289'; Id=30; Version=1; ProcessId=123; ThreadId=42; TimeCreated=[datetime]'2026-11-14T00:00:30Z'}
      Add-FreshCalibrationEvent $f $r @{FileName=$n.FileNtPath; FileObject='0x42'; Irp='0x99'; IssuingThreadId=42} $n $o $k
      $r.Id=24; $r.Version=0; Add-FreshCalibrationEvent $f $r @{Irp='0x99'; Status=0} $n $o $k
      $r.Id=16; $r.Version=1; 1..3|ForEach-Object { Add-FreshCalibrationEvent $f $r @{FileObject='0x42'; IssuingThreadId=42} $n $o $k }
      $r.ProcessId=124; Add-FreshCalibrationEvent $f $r @{FileObject='0x42'; IssuingThreadId=42} $n $o $k
      @{writes=$f.fileWrites; other=$f.otherProcessEvents; mapping=$f.mapping}|ConvertTo-Json -Compress`)
    expect(result).toEqual({ writes: 3, other: 1, mapping: 'not_proven' })
  }, 30_000)

  test('does not manufacture a registry namespace from a GUID leaf or the canary argument', () => {
    const result = pure(`$n=@{ChildPid=123; ChildThreadId=42; CreationUtc='2026-11-14T00:00:00Z'; ExitUtc='2026-11-14T00:01:00Z'; ProcessIdentityVerified=$true; FileNtPath='owned'; KeyNtPath='\\REGISTRY\\USER\\S-1-5-21-42\\Software\\CcHaha-CI-Fixture-owned'}
      $f=New-FreshCalibrationFacts; $o=@{}; $k=@{}
      $r=[pscustomobject]@{ProviderId=[guid]'70eb4f03-c1de-4f73-a051-33d13d5413bd'; Id=1; Version=0; ProcessId=123; ThreadId=42; TimeCreated=[datetime]'2026-11-14T00:00:30Z'}
      Add-FreshCalibrationEvent $f $r @{BaseObject='0x10'; KeyObject='0x20'; RelativeName='CcHaha-CI-Fixture-owned'; BaseName=''; Status=0} $n $o $k
      $r.Id=5; foreach($t in @(0,3,0)){ Add-FreshCalibrationEvent $f $r @{KeyObject='0x20'; ValueName='type-canary'; Type=$t; Status=0; DataSize=0} $n $o $k }
      @{sets=$f.registrySets; anchors=$f.absoluteAnchors; mapping=$f.mapping; view=$f.registryView}|ConvertTo-Json -Compress`)
    expect(result).toEqual({ sets: 0, anchors: 0, mapping: 'not_proven', view: 'not_proven' })
  }, 30_000)

  test('uses only an observed absolute registry anchor and retires closed object generations', () => {
    const result = pure(`$n=@{ChildPid=123; ChildThreadId=42; CreationUtc='2026-11-14T00:00:00Z'; ExitUtc='2026-11-14T00:01:00Z'; ProcessIdentityVerified=$true; FileNtPath='owned'; KeyNtPath='\\REGISTRY\\USER\\S-1-5-21-42\\Software\\CcHaha-CI-Fixture-owned'}
      $f=New-FreshCalibrationFacts; $o=@{}; $k=@{}
      $r=[pscustomobject]@{ProviderId=[guid]'70eb4f03-c1de-4f73-a051-33d13d5413bd'; Id=2; Version=0; ProcessId=123; ThreadId=42; TimeCreated=[datetime]'2026-11-14T00:00:30Z'}
      Add-FreshCalibrationEvent $f $r @{KeyObject='0x10'; RelativeName='\\REGISTRY\\USER\\S-1-5-21-42\\Software'; Status=0} $n $o $k
      $r.Id=1; Add-FreshCalibrationEvent $f $r @{BaseObject='0x10'; KeyObject='0x20'; RelativeName='CcHaha-CI-Fixture-owned'; Status=0} $n $o $k
      $r.Id=5; foreach($t in @(0,3,0)){ Add-FreshCalibrationEvent $f $r @{KeyObject='0x20'; ValueName='type-canary'; Type=$t; Status=0; DataSize=0} $n $o $k }
      $r.Id=13; Add-FreshCalibrationEvent $f $r @{KeyObject='0x20'; Status=0} $n $o $k
      $r.Id=5; Add-FreshCalibrationEvent $f $r @{KeyObject='0x20'; ValueName='type-canary'; Type=3; Status=0; DataSize=0} $n $o $k
      @{sets=$f.registrySets; types=($f.registryTypes -join ','); retired=$f.keyCloses; mapping=$f.mapping; view=$f.registryView}|ConvertTo-Json -Compress`)
    expect(result).toEqual({ sets: 3, types: '0,3,0', retired: 1, mapping: 'not_proven', view: 'not_proven' })
  }, 30_000)

  test('rejects fresh-child thread, version, epoch and reused-or-closed object gaps', () => {
    const result = pure(`$n=@{ChildPid=123; ChildThreadId=42; CreationUtc='2026-11-14T00:00:00Z'; ExitUtc='2026-11-14T00:01:00Z'; ProcessIdentityVerified=$true; FileNtPath='owned'; KeyNtPath='owned'}; $writes=0
      foreach($kind in @('missing-thread','wrong-thread','wrong-version','before-epoch','unverified-process','closed','reused')) {
        $n.ProcessIdentityVerified=$true; $f=New-FreshCalibrationFacts; $o=@{}; $k=@{}
        $r=[pscustomobject]@{ProviderId=[guid]'edd08927-9cc4-4e65-b970-c2560fb5c289'; Id=30; Version=1; ProcessId=123; ThreadId=42; TimeCreated=[datetime]'2026-11-14T00:00:30Z'}
        $create=@{FileName='owned'; FileObject='0x42'; Irp='0x99'; IssuingThreadId=42}; Add-FreshCalibrationEvent $f $r $create $n $o $k
        $r.Id=24; $r.Version=0; Add-FreshCalibrationEvent $f $r @{Irp='0x99'; Status=0} $n $o $k; $r.Version=1
        if($kind -eq 'closed') { foreach($i in @(13,14)){ $r.Id=$i; Add-FreshCalibrationEvent $f $r @{FileObject='0x42'; IssuingThreadId=42} $n $o $k } }
        if($kind -eq 'reused') { $r.Id=30; Add-FreshCalibrationEvent $f $r $create $n $o $k }
        $r.Id=16; $d=@{FileObject='0x42'; IssuingThreadId=42}
        switch($kind) { 'missing-thread' {$d.Remove('IssuingThreadId')}; 'wrong-thread' {$d.IssuingThreadId=43}; 'wrong-version' {$r.Version=2}; 'before-epoch' {$r.TimeCreated=[datetime]'2026-11-13T23:59:00Z'}; 'unverified-process' {$n.ProcessIdentityVerified=$false} }
        Add-FreshCalibrationEvent $f $r $d $n $o $k; $writes+=$f.fileWrites
      }; @{writes=$writes}|ConvertTo-Json -Compress`)
    expect(result).toEqual({ writes: 0 })
  }, 30_000)

  test('rejects unowned captured data and unknown body fields before any XML publication', () => {
    const result = pure(`$n=@{ChildPid=123}; $f=New-FreshCalibrationFacts; $o=@{}; $k=@{}
      $r=[pscustomobject]@{ProviderId=[guid]'70eb4f03-c1de-4f73-a051-33d13d5413bd'; Id=5; Version=0; ProcessId=124}
      try { Add-FreshCalibrationEvent $f $r @{CapturedDataSize=1; CapturedData='never-retain-value'} $n $o $k } catch { $a=Safe-Error $_ 'decode' }
      try { Add-FreshCalibrationEvent $f $r @{UnknownPayload='never-retain-value'} $n $o $k } catch { $b=Safe-Error $_ 'decode' }
      @{payload=$a.valuePayload; fields=$b.unvalidatedFields; errors=(@($a,$b)|ConvertTo-Json -Compress)}|ConvertTo-Json -Compress`)
    expect(result.payload).toBe(true)
    expect(result.fields).toEqual(['UnknownPayload'])
    expect(result.errors).not.toContain('never-retain-value')
  }, 30_000)

  test('never parses empty, fractional or overflowing event fields as a zero status or size', () => {
    expect(pure(`$values=@('', ' ', '42.0', '-1', '+0', '18446744073709551616')
      $unknown=@($values|ForEach-Object { $null -eq (Read-EventUnsigned $_) })
      @{unknown=$unknown; zero=(Read-EventUnsigned '0'); hex=(Read-EventUnsigned '0x2a')}|ConvertTo-Json -Compress`)).toEqual({ unknown: [true, true, true, true, true, true], zero: 0, hex: 42 })
  }, 30_000)

  test('parses and compiles the declared ABI without initializing ETW or touching HKCU', () => {
    const value = pure(`$errors=$null; $tokens=$null
      [Management.Automation.Language.Parser]::ParseFile(${ps(script)},[ref]$tokens,[ref]$errors)|Out-Null
      if($errors.Count){throw 'parse failure'}; Initialize-EtwNative
      $flags=[Reflection.BindingFlags]'NonPublic'; $log=[CcHahaCiEtw].GetNestedType('LogFile',$flags)
      @{header=[Runtime.InteropServices.Marshal]::SizeOf([type][CcHahaCiEtw+Header]); log=[Runtime.InteropServices.Marshal]::SizeOf([type]$log)}|ConvertTo-Json -Compress`)
    expect(value).toEqual({ header: 280, log: 448 })
  }, 30_000)

  test('compiles both owned declarations and checks the SDK x64 child ABI without running either entry point', () => {
    expect(pure(`Initialize-EtwNative; Add-Type -TypeDefinition (Get-OwnedCanarySource)
      @{native=[CcHahaCiEtw]::FreshAbi(); child=[CcHahaFreshCanary]::ManagedAbi(); startup=[Runtime.InteropServices.Marshal]::SizeOf([type][CcHahaCiEtw+Startup]); process=[Runtime.InteropServices.Marshal]::SizeOf([type][CcHahaCiEtw+ProcessInfo])}|ConvertTo-Json -Compress`)).toEqual({ native: true, child: true, startup: 104, process: 24 })
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
