import { execFile } from 'node:child_process'
import path from 'node:path'

export type PowerAction = 'lock' | 'sleep' | 'hibernate' | 'shutdown'
export type PowerCapabilities = Record<PowerAction, boolean>
export type PowerPlatformDependencies = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Reject on a nonzero exit code, timeout, or failure to start the command. */
  runCommand?: (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>
  /** Final controller safety check, after all probes and immediately before dispatch. */
  beforeExecute?: () => Promise<void>
}

type RunCommand = NonNullable<PowerPlatformDependencies['runCommand']>
type Command = { file: string; args: readonly string[]; expectsBoolean?: boolean }
type PowerPlan = { capabilities: PowerCapabilities; commands: Partial<Record<PowerAction, Command>> }
const actions: readonly PowerAction[] = ['lock', 'sleep', 'hibernate', 'shutdown']
const macLock = '/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession'
const logind = ['org.freedesktop.login1', '/org/freedesktop/login1', 'org.freedesktop.login1.Manager']
const noInteractiveAuthorization = '--allow-interactive-authorization=no'

const runCommand: RunCommand = (file, args) => new Promise((resolve, reject) => {
  execFile(file, [...args], { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(error)
    else resolve({ stdout, stderr })
  })
})

// SYSTEM_POWER_CAPABILITIES has a fixed 76-byte layout on Windows 10 and later.
// Keep BOOLEAN fields one byte, including the GetPwrCapabilities return value.
// HiberFileType=2 is FULL; a reduced fast-startup file cannot hibernate a session.
// https://learn.microsoft.com/windows/win32/api/winnt/ns-winnt-system_power_capabilities
const windowsCapabilitiesScript = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Explicit, Size = 76)]
public struct IdlePowerCapabilities {
  [FieldOffset(3)] public byte SystemS1;
  [FieldOffset(4)] public byte SystemS2;
  [FieldOffset(5)] public byte SystemS3;
  [FieldOffset(6)] public byte SystemS4;
  [FieldOffset(7)] public byte SystemS5;
  [FieldOffset(8)] public byte HiberFilePresent;
  [FieldOffset(20)] public byte AoAc;
  [FieldOffset(22)] public byte HiberFileType;
}
public static class IdlePowerNative {
  [DllImport("powrprof.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.U1)]
  public static extern bool GetPwrCapabilities(out IdlePowerCapabilities capabilities);
}
'@
$caps = New-Object IdlePowerCapabilities
if (-not [IdlePowerNative]::GetPwrCapabilities([ref]$caps)) { throw 'GetPwrCapabilities failed' }
@{
  interactive = [Environment]::UserInteractive
  systemS1 = $caps.SystemS1 -ne 0
  systemS2 = $caps.SystemS2 -ne 0
  systemS3 = $caps.SystemS3 -ne 0
  systemS4 = $caps.SystemS4 -ne 0
  systemS5 = $caps.SystemS5 -ne 0
  aoAc = $caps.AoAc -ne 0
  hiberFilePresent = $caps.HiberFilePresent -ne 0
  hiberFileType = [int]$caps.HiberFileType
} | ConvertTo-Json -Compress`

const windowsLockScript = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class IdlePowerNative {
  [DllImport("user32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool LockWorkStation();
}
'@
$result = [IdlePowerNative]::LockWorkStation()
if (-not $result) { throw 'LockWorkStation failed' }
$result | ConvertTo-Json -Compress`

function windowsSuspendScript(state: 'Suspend' | 'Hibernate'): string {
  // The managed API enables the shutdown privilege and returns the native result.
  // Neither forcing applications nor disabling wake events is requested.
  return `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$result = [System.Windows.Forms.Application]::SetSuspendState([System.Windows.Forms.PowerState]::${state}, $false, $false)
if (-not $result) { throw 'SetSuspendState failed' }
$result | ConvertTo-Json -Compress`
}

function unavailable(): PowerCapabilities {
  return { lock: false, sleep: false, hibernate: false, shutdown: false }
}

async function probe(command: Command, run: RunCommand): Promise<string | null> {
  try {
    return (await run(command.file, command.args)).stdout.trim()
  } catch {
    return null
  }
}

async function inspectMac(run: RunCommand): Promise<PowerPlan> {
  const [lock, sleep] = await Promise.all([
    probe({ file: '/bin/test', args: ['-x', macLock] }, run),
    probe({ file: '/usr/bin/pmset', args: ['-g', 'cap'] }, run),
  ])
  return {
    capabilities: {
      lock: lock !== null,
      sleep: sleep?.split('\n').some(line => line.trim() === 'sleep') ?? false,
      // macOS safe sleep is an OS policy, not an independently supported action.
      hibernate: false,
      // The hardened app has no Apple Events automation entitlement. Merely
      // finding osascript cannot prove unattended shutdown authorization; do not
      // advertise an action that would fail or introduce an OS consent prompt.
      shutdown: false,
    },
    commands: {
      lock: { file: macLock, args: ['-suspend'] },
      sleep: { file: '/usr/bin/pmset', args: ['sleepnow'] },
    },
  }
}

async function inspectWindows(run: RunCommand, env: NodeJS.ProcessEnv): Promise<PowerPlan> {
  const system32 = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32')
  const powershell = path.win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const scriptCommand = (script: string, expectsBoolean = false): Command => ({
    file: powershell,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    expectsBoolean,
  })
  const plan: PowerPlan = {
    capabilities: unavailable(),
    commands: {
      lock: scriptCommand(windowsLockScript, true),
      sleep: scriptCommand(windowsSuspendScript('Suspend'), true),
      hibernate: scriptCommand(windowsSuspendScript('Hibernate'), true),
      // A positive /t implies /f. Zero preserves applications' shutdown veto.
      shutdown: { file: path.win32.join(system32, 'shutdown.exe'), args: ['/s', '/t', '0'] },
    },
  }
  const output = await probe(scriptCommand(windowsCapabilitiesScript), run)
  if (output === null) return plan
  try {
    const caps: unknown = JSON.parse(output)
    if (!caps || typeof caps !== 'object' || !('interactive' in caps) || caps.interactive !== true) return plan
    const supported = (key: string) => key in caps && (caps as Record<string, unknown>)[key] === true
    plan.capabilities = {
      lock: true,
      sleep: ['systemS1', 'systemS2', 'systemS3', 'aoAc'].some(supported),
      hibernate: supported('systemS4') && supported('hiberFilePresent') && 'hiberFileType' in caps && caps.hiberFileType === 2,
      shutdown: supported('systemS5'),
    }
  } catch {
    // Unknown or localized/malformed output must not enable an action.
  }
  return plan
}

async function inspectLinux(run: RunCommand, env: NodeJS.ProcessEnv): Promise<PowerPlan> {
  const plan: PowerPlan = { capabilities: unavailable(), commands: {} }
  const sessionId = env.XDG_SESSION_ID || 'self'
  if (!/^[a-zA-Z0-9_]+$/.test(sessionId)) return plan
  const session = await probe({
    file: '/usr/bin/loginctl',
    args: ['show-session', sessionId, '--property=Active', '--property=Remote', '--property=Type'],
  }, run)
  const properties = new Map(session?.split('\n').map(line => {
    const separator = line.indexOf('=')
    return [line.slice(0, separator), line.slice(separator + 1)]
  }))
  if (properties.get('Active') !== 'yes' || properties.get('Remote') !== 'no' || !['x11', 'wayland'].includes(properties.get('Type') ?? '')) return plan

  const findLocker = async (): Promise<Command | undefined> => {
    for (const [name, objectPath] of [
      ['org.freedesktop.ScreenSaver', '/ScreenSaver'],
      ['org.gnome.ScreenSaver', '/org/gnome/ScreenSaver'],
    ] as const) {
      const args = ['--user', noInteractiveAuthorization, '--auto-start=no', 'call', name, objectPath, name]
      const active = await probe({ file: '/usr/bin/busctl', args: [...args, 'GetActive'] }, run)
      if (active === 'b false' || active === 'b true') return { file: '/usr/bin/busctl', args: [...args, 'Lock'] }
    }
    return undefined
  }
  await Promise.all([
    findLocker().then(command => {
      plan.capabilities.lock = !!command
      if (command) plan.commands.lock = command
    }),
    ...([['sleep', 'Suspend'], ['hibernate', 'Hibernate'], ['shutdown', 'PowerOff']] as const).map(async ([action, method]) => {
      const args = ['--system', noInteractiveAuthorization, 'call', ...logind]
      const result = await probe({ file: '/usr/bin/busctl', args: [...args, `Can${method}`] }, run)
      // "challenge", "no", "na" and inhibitor states cannot run unattended.
      plan.capabilities[action] = result === 's "yes"'
      plan.commands[action] = { file: '/usr/bin/busctl', args: [...args, method, 'b', 'false'] }
    }),
  ])
  return plan
}

async function inspect(deps: PowerPlatformDependencies, run: RunCommand): Promise<PowerPlan> {
  const env = deps.env ?? process.env
  switch (deps.platform ?? process.platform) {
    case 'darwin': return inspectMac(run)
    case 'win32': return inspectWindows(run, env)
    case 'linux': return inspectLinux(run, env)
    default: return { capabilities: unavailable(), commands: {} }
  }
}

/** Read-only support checks; OS policy, inhibitors or app vetoes may still reject dispatch. */
export async function detectPowerCapabilities(deps: PowerPlatformDependencies = {}): Promise<PowerCapabilities> {
  return (await inspect(deps, deps.runCommand ?? runCommand)).capabilities
}

/** Resolves when the OS accepts the request, not when sleep/shutdown has completed. */
export async function executePowerAction(action: PowerAction, deps: PowerPlatformDependencies = {}): Promise<void> {
  if (!actions.includes(action)) throw new Error('Unsupported power action')
  const run = deps.runCommand ?? runCommand
  const plan = await inspect(deps, run)
  const command = plan.commands[action]
  if (!plan.capabilities[action] || !command) throw new Error(`Power action ${action} is unavailable`)
  await deps.beforeExecute?.()
  const result = await run(command.file, command.args)
  if (command.expectsBoolean && result.stdout.trim().toLowerCase() !== 'true') {
    throw new Error(`Power action ${action} did not confirm OS acceptance`)
  }
}
