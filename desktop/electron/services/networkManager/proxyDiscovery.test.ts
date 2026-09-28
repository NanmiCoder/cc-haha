// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { discoverSakura } from './proxyDiscovery'
import { SAKURA_DISCOVERY_FUNCTIONS } from './proxyDiscoveryScript'
import type { NetworkCommand } from './powershell'

const core = (pid = 101, proxyPort = 7897) => ({
  pid, startedAt: '2026-09-27T01:00:00.000Z', executablePath: 'C:\\Mock App\\com.vortex.helper.exe',
  clientExecutable: 'C:\\Mock App\\SakuraCat.exe', configPath: `C:\\Mock App\\config-${pid}.yaml`,
  controller: '127.0.0.1:39798', listeningPorts: [proxyPort, 39798], configSource: 'process-argument' as const,
})
const state = (cores = [core()]) => ({ running: true, cores, issues: [] })

describe('Sakura discovery read-only and instance ownership', () => {
  it('selects the proxy-port owner, not the first process, and strips credentials/argv', async () => {
    const selected = { ...core(102), CommandLine: '-secret FIXTURE_SECRET_ONLY', secret: 'FIXTURE_SECRET_ONLY' }
    const runner = vi.fn(async (_command: NetworkCommand) => state([core(101, 7890), selected]))
    const files = vi.fn(async () => true)
    const result = await discoverSakura(7897, runner, files)
    expect(result.status).toBe('detected')
    expect(result.selected?.pid).toBe(102)
    expect(result.selected?.configPath).toBe('C:\\Mock App\\config-102.yaml')
    expect(files).toHaveBeenCalledWith('C:\\Mock App\\config-102.yaml')
    expect(runner.mock.calls).toHaveLength(2)
    expect(runner.mock.calls.every(args => args[0]?.action === 'proxyDiscover')).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/FIXTURE_SECRET_ONLY|CommandLine|secret/)
  })

  it('distinguishes not running, GUI-only, wrong port and ambiguous instances', async () => {
    const files = vi.fn(async () => true)
    expect((await discoverSakura(7897, async () => ({ running: false, cores: [], issues: [] }), files)).status).toBe('not-running')
    expect(await discoverSakura(7897, async () => state([]), files)).toMatchObject({ running: true, status: 'incomplete', selected: null })
    expect((await discoverSakura(7897, async () => state([core(101, 7890)]), files)).selected).toBeNull()
    expect((await discoverSakura(7897, async () => state([core(), core(102)]), files)).status).toBe('ambiguous')
    expect(files).not.toHaveBeenCalled()
  })

  it('never guesses a default YAML or uses a core as the GUI executable', async () => {
    expect(await discoverSakura(7897, async () => state([{ ...core(), configPath: '', configSource: 'unresolved' as never }]), async () => true))
      .toMatchObject({ status: 'incomplete', selected: null, issues: ['SAKURA_CONFIG_UNCONFIRMED'] })
    const result = await discoverSakura(7897, async () => state([{ ...core(), clientExecutable: '' }]), async () => true)
    expect(result.selected?.clientExecutable).toBe('')
    expect(result.selected?.executablePath).toContain('com.vortex.helper.exe')
  })

  it('rejects unsafe paths, remote controllers, unreadable files and auth overrides', async () => {
    for (const patch of [{ configPath: '..\\config.yaml' }, { configPath: '\\\\server\\share\\config.yaml' }, { controller: '192.0.2.1:9090' }]) {
      await expect(discoverSakura(7897, async () => state([{ ...core(), ...patch }]), async () => true)).rejects.toThrow('SAKURA_DISCOVERY_INVALID')
    }
    expect((await discoverSakura(7897, async () => state(), async () => false)).issues).toContain('SAKURA_CONFIG_UNREADABLE')
    expect((await discoverSakura(7897, async () => ({ ...state(), cores: [{ ...core(), authOverride: true }] }), async () => true)).issues).toContain('SAKURA_AUTH_OVERRIDE')
  })

  it('does not adopt a process replaced while checking the file', async () => {
    const runner = vi.fn().mockResolvedValueOnce(state()).mockResolvedValueOnce(state([{ ...core(), startedAt: '2026-09-27T02:00:00.000Z' }]))
    expect(await discoverSakura(7897, runner, async () => true)).toMatchObject({ status: 'incomplete', selected: null, issues: ['SAKURA_INSTANCE_CHANGED'] })
  })

  it('rejects invalid ports without running a native command', async () => {
    const runner = vi.fn()
    await expect(discoverSakura(0, runner)).rejects.toThrow('INVALID_PROXY_PORT')
    expect(runner).not.toHaveBeenCalled()
  })
})

// Fixed PowerShell is exercised with function stubs only; never enumerate this user's processes.
const nativeTest = process.platform === 'win32' ? it : it.skip
nativeTest('parses quoted process arguments, parent GUI, relative -f/-d and emits no command line', () => {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
function Get-CimInstance {
  param($ClassName, $Filter, $ErrorAction)
  if ($Filter -eq 'ProcessId=50') {
    return [pscustomobject]@{ Name='SakuraCat.exe'; ProcessId=50; ParentProcessId=0; ExecutablePath='C:\Mock App\SakuraCat.exe'; CreationDate=[datetime]'2026-09-27T00:00:00Z' }
  }
  @(
    [pscustomobject]@{ Name='com.vortex.helper.exe'; ProcessId=101; ParentProcessId=50; ExecutablePath='C:\Mock App\com.vortex.helper.exe'; CreationDate=[datetime]'2026-09-27T01:00:00Z'; CommandLine='"C:\Mock App\com.vortex.helper.exe" -f "C:\Mock App\runtime config.yaml" -ext-ctl 127.0.0.1:39798 --secret DO_NOT_RETURN_FIXTURE' },
    [pscustomobject]@{ Name='com.vortex.helper.exe'; ProcessId=102; ParentProcessId=0; ExecutablePath='C:\Mock App\com.vortex.helper.exe'; CreationDate=[datetime]'2026-09-27T01:00:00Z'; CommandLine='core -d "C:\Mock App" --config=relative.yaml' }
  )
}
function Get-NetTCPConnection {
  param($State, $ErrorAction)
  @([pscustomobject]@{LocalAddress='127.0.0.1';LocalPort=7897;OwningProcess=101}, [pscustomobject]@{LocalAddress='127.0.0.1';LocalPort=39798;OwningProcess=101})
}
` + SAKURA_DISCOVERY_FUNCTIONS + '\nGet-SakuraProcesses | ConvertTo-Json -Depth 6 -Compress'
  const ps = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const result = spawnSync(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20000, windowsHide: true })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).not.toMatch(/DO_NOT_RETURN_FIXTURE|CommandLine/)
  const parsed = JSON.parse(result.stdout.trim().replace(/^\uFEFF/, ''))
  expect(parsed.cores[0]).toMatchObject({ pid: 101, configPath: 'C:\\Mock App\\runtime config.yaml', clientExecutable: 'C:\\Mock App\\SakuraCat.exe', controller: '127.0.0.1:39798', authOverride: true })
  expect(parsed.cores[0].listeningPorts).toEqual([7897, 39798])
  expect(parsed.cores[1].configPath).toBe('C:\\Mock App\\relative.yaml')
})
