// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { detectPowerCapabilities, executePowerAction, type PowerAction, type PowerPlatformDependencies } from './idlePowerPlatform'

type RunCommand = NonNullable<PowerPlatformDependencies['runCommand']>
const unavailable = { lock: false, sleep: false, hibernate: false, shutdown: false }
const available = { lock: true, sleep: true, hibernate: true, shutdown: true }
const windowsCapabilities = {
  interactive: true,
  systemS1: false,
  systemS2: false,
  systemS3: true,
  systemS4: true,
  systemS5: true,
  aoAc: false,
  hiberFilePresent: true,
  hiberFileType: 2,
}

function fixture(platform: NodeJS.Platform, override?: (file: string, args: readonly string[]) => string | void) {
  const runCommand = vi.fn<RunCommand>(async (file, args) => {
    const overridden = override?.(file, args)
    if (overridden !== undefined) return { stdout: overridden, stderr: '' }
    if (file === '/bin/test') return { stdout: '', stderr: '' }
    if (file === '/usr/bin/pmset' && args[0] === '-g') return { stdout: 'Capabilities for AC Power:\n displaysleep\n sleep\n', stderr: '' }
    if (file.endsWith('powershell.exe')) {
      return { stdout: args.at(-1)?.includes('GetPwrCapabilities') ? JSON.stringify(windowsCapabilities) : 'true\r\n', stderr: '' }
    }
    if (file === '/usr/bin/loginctl') return { stdout: 'Active=yes\nRemote=no\nType=wayland\n', stderr: '' }
    if (file === '/usr/bin/busctl') {
      if (args.at(-1)?.startsWith('Can')) return { stdout: 's "yes"\n', stderr: '' }
      if (args.at(-1) === 'GetActive') return { stdout: 'b false\n', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  })
  const deps: PowerPlatformDependencies = { platform, env: { XDG_SESSION_ID: '2', SystemRoot: 'C:\\Windows' }, runCommand }
  return { runCommand, deps }
}

describe('idle power platform capabilities', () => {
  it('uses read-only macOS probes and never offers hibernation or unentitled automation', async () => {
    const { deps, runCommand } = fixture('darwin')
    expect(await detectPowerCapabilities(deps)).toEqual({ ...available, hibernate: false, shutdown: false })
    expect(runCommand.mock.calls).toContainEqual(['/usr/bin/pmset', ['-g', 'cap']])
    expect(runCommand.mock.calls.every(([file, args]) => file === '/bin/test' || args[0] === '-g')).toBe(true)
  })

  it('does not advertise missing macOS tools or a missing sleep capability', async () => {
    const { deps } = fixture('darwin', (file, args) => {
      if (file === '/bin/test' && args[1]?.endsWith('/CGSession')) throw new Error('missing executable')
      if (file === '/usr/bin/pmset') return 'Capabilities for AC Power:\n displaysleep\n'
    })
    expect(await detectPowerCapabilities(deps)).toEqual(unavailable)
  })

  it.each([
    [{ hiberFilePresent: false }, false],
    [{ hiberFileType: 1 }, false],
    [{ systemS4: false }, false],
    [{}, true],
  ])('requires configured full Windows hibernation: %j', async (patch, hibernate) => {
    const { deps, runCommand } = fixture('win32', () => JSON.stringify({ ...windowsCapabilities, ...patch }))
    expect(await detectPowerCapabilities(deps)).toEqual({ ...available, hibernate })
    expect(runCommand.mock.calls).toHaveLength(1)
    const script = runCommand.mock.calls[0]![1].at(-1)!
    expect(script).toContain('GetPwrCapabilities')
    expect(script).not.toContain('SetSuspendState')
    expect(script).not.toContain('powercfg')
  })

  it('recognizes Windows modern standby without S1/S2/S3 and excludes noninteractive sessions', async () => {
    const { deps } = fixture('win32', () => JSON.stringify({ ...windowsCapabilities, systemS3: false, aoAc: true }))
    expect((await detectPowerCapabilities(deps)).sleep).toBe(true)
    const inactive = fixture('win32', () => JSON.stringify({ ...windowsCapabilities, interactive: false }))
    expect(await detectPowerCapabilities(inactive.deps)).toEqual(unavailable)
  })

  it.each(['not json', 'null', '{}', '{"interactive":"true","systemS4":"true"}'])('fails closed on invalid Windows capability output: %s', async stdout => {
    const { deps } = fixture('win32', () => stdout)
    expect(await detectPowerCapabilities(deps)).toEqual(unavailable)
  })

  it('only accepts logind authorization without prompting', async () => {
    const { deps, runCommand } = fixture('linux', (file, args) => {
      if (file === '/usr/bin/busctl' && args.at(-1) === 'CanHibernate') return 's "challenge"\n'
      if (file === '/usr/bin/busctl' && args.at(-1) === 'CanPowerOff') return 's "inhibitor-blocked"\n'
    })
    expect(await detectPowerCapabilities(deps)).toEqual({ lock: true, sleep: true, hibernate: false, shutdown: false })
    expect(runCommand.mock.calls.filter(([file]) => file === '/usr/bin/busctl').every(([, args]) => args.includes('--allow-interactive-authorization=no'))).toBe(true)
  })

  it.each(['Active=no\nRemote=no\nType=wayland\n', 'Active=yes\nRemote=yes\nType=x11\n', 'Active=yes\nRemote=no\nType=tty\n', ''])('requires an active local graphical Linux session: %s', async stdout => {
    const { deps, runCommand } = fixture('linux', file => file === '/usr/bin/loginctl' ? stdout : undefined)
    expect(await detectPowerCapabilities(deps)).toEqual(unavailable)
    expect(runCommand).toHaveBeenCalledTimes(1)
  })

  it('does not advertise Linux screen locking unless a session locker answers', async () => {
    const { deps } = fixture('linux', (file, args) => {
      if (file === '/usr/bin/busctl' && args.at(-1) === 'GetActive') throw new Error('no screen locker')
    })
    expect(await detectPowerCapabilities(deps)).toEqual({ ...available, lock: false })
  })

  it('treats failed probes as unavailable and never runs commands on unsupported platforms', async () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const { deps } = fixture(platform, () => { throw new Error('probe denied') })
      expect(await detectPowerCapabilities(deps)).toEqual(unavailable)
    }
    const { deps, runCommand } = fixture('freebsd')
    expect(await detectPowerCapabilities(deps)).toEqual(unavailable)
    expect(runCommand).not.toHaveBeenCalled()
  })
})

describe('idle power platform dispatch', () => {
  it.each([
    ['lock', '/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession', ['-suspend']],
    ['sleep', '/usr/bin/pmset', ['sleepnow']],
  ] as const)('dispatches macOS %s with fixed arguments', async (action, file, args) => {
    const { deps, runCommand } = fixture('darwin')
    await executePowerAction(action, deps)
    expect(runCommand).toHaveBeenLastCalledWith(file, args)
  })

  it('rejects macOS shutdown without dispatching Apple events or prompting for authorization', async () => {
    const { deps, runCommand } = fixture('darwin')
    await expect(executePowerAction('shutdown', deps)).rejects.toThrow('unavailable')
    expect(runCommand.mock.calls.some(([file]) => file.includes('osascript'))).toBe(false)
  })

  it('uses Windows shutdown without force or an implied force timeout', async () => {
    const { deps, runCommand } = fixture('win32')
    await executePowerAction('shutdown', deps)
    expect(runCommand).toHaveBeenLastCalledWith('C:\\Windows\\System32\\shutdown.exe', ['/s', '/t', '0'])
  })

  it.each(['lock', 'sleep', 'hibernate'] as const)('checks the native boolean for Windows %s', async action => {
    const { deps, runCommand } = fixture('win32')
    await executePowerAction(action, deps)
    const script = runCommand.mock.calls.at(-1)![1].at(-1)!
    expect(script).toContain('if (-not $result)')
    if (action !== 'lock') {
      expect(script).toContain(action === 'sleep' ? '::Suspend' : '::Hibernate')
      expect(script).toContain('$false, $false')
    }
    const failed = fixture('win32', (file, args) => file.endsWith('powershell.exe') && !args.at(-1)?.includes('GetPwrCapabilities') ? 'False\r\n' : undefined)
    await expect(executePowerAction(action, failed.deps)).rejects.toThrow('did not confirm')
  })

  it.each([
    ['sleep', 'Suspend'], ['hibernate', 'Hibernate'], ['shutdown', 'PowerOff'],
  ] as const)('dispatches Linux %s with no interactive authorization or force option', async (action, method) => {
    const { deps, runCommand } = fixture('linux')
    await executePowerAction(action, deps)
    expect(runCommand).toHaveBeenLastCalledWith('/usr/bin/busctl', [
      '--system', '--allow-interactive-authorization=no', 'call', 'org.freedesktop.login1',
      '/org/freedesktop/login1', 'org.freedesktop.login1.Manager', method, 'b', 'false',
    ])
  })

  it('locks the answering Linux session locker, including GNOME fallback', async () => {
    const { deps, runCommand } = fixture('linux', (file, args) => {
      if (file === '/usr/bin/busctl' && args.includes('org.freedesktop.ScreenSaver')) throw new Error('no freedesktop locker')
    })
    await executePowerAction('lock', deps)
    expect(runCommand).toHaveBeenLastCalledWith('/usr/bin/busctl', [
      '--user', '--allow-interactive-authorization=no', '--auto-start=no', 'call', 'org.gnome.ScreenSaver',
      '/org/gnome/ScreenSaver', 'org.gnome.ScreenSaver', 'Lock',
    ])
  })

  it('rechecks capabilities before the final hook and performs no more probes after it', async () => {
    const { deps, runCommand } = fixture('darwin')
    const events: string[] = []
    const run = deps.runCommand!
    deps.runCommand = async (file, args) => { events.push(args[0] === 'sleepnow' ? 'execute' : 'probe'); return run(file, args) }
    deps.beforeExecute = async () => { events.push('hook') }
    await executePowerAction('sleep', deps)
    expect(events.slice(-2)).toEqual(['hook', 'execute'])
    expect(runCommand).toHaveBeenLastCalledWith('/usr/bin/pmset', ['sleepnow'])
  })

  it('does not dispatch when the final hook rejects', async () => {
    const { deps, runCommand } = fixture('darwin')
    deps.beforeExecute = async () => { throw new Error('new work started') }
    await expect(executePowerAction('sleep', deps)).rejects.toThrow('new work started')
    expect(runCommand.mock.calls.some(([, args]) => args.includes('sleepnow'))).toBe(false)
  })

  it('rejects unsupported and injected actions without a mutation', async () => {
    const { deps, runCommand } = fixture('darwin')
    await expect(executePowerAction('hibernate', deps)).rejects.toThrow('unavailable')
    runCommand.mockClear()
    await expect(executePowerAction('shutdown; touch /tmp/unsafe' as PowerAction, deps)).rejects.toThrow('Unsupported power action')
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('propagates command failures instead of reporting a request as successful', async () => {
    const { deps } = fixture('darwin', (_file, args) => {
      if (args[0] === 'sleepnow') throw new Error('OS refused sleep')
    })
    await expect(executePowerAction('sleep', deps)).rejects.toThrow('OS refused sleep')
  })
})
