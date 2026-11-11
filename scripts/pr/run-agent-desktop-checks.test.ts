import { existsSync } from 'node:fs'
import { expect, test } from 'bun:test'
import { runAgentDesktopChecks } from './run-agent-desktop-checks'

test('native checks isolate user state, strip provider credentials, stay offline and clean up', async () => {
  const commands: string[][] = []
  let home = ''
  const code = await runAgentDesktopChecks({
    source: { ...process.env, ANTHROPIC_API_KEY: 'must-not-leak', AGENT_DESKTOP_HOME: '/real/state', DISPLAY: ':real', DBUS_SESSION_BUS_ADDRESS: 'real' },
    run: async (command, { env }) => {
      commands.push(command)
      home = env.HOME!
      expect(home).not.toBe(process.env.HOME)
      expect(env.AGENT_DESKTOP_HOME).toBeUndefined()
      expect(env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(env.DISPLAY).toBeUndefined()
      expect(env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined()
      expect(env.CARGO_NET_OFFLINE).toBe('true')
      expect(command).toContain('--offline')
      return 0
    },
  })
  expect(code).toBe(0)
  expect(commands).toHaveLength(process.platform === 'win32' ? 6 : 4)
  expect(commands[2]).toContain('cli::')
  expect(commands[3]).toContain('dispatch::cursor_overlay_lifecycle_tests::')
  if (process.platform === 'win32') {
    expect(commands[4]).toContain('agent-desktop-windows')
    expect(commands[4]).toContain('system::cursor_overlay::')
    expect(commands[4]).toContain('winforms')
    expect(commands[4]).toContain('system::cursor_overlay::window::tests::')
    expect(commands[5]).toContain('windows_private_file_install')
  }
  expect(existsSync(home)).toBe(false)
})

test('a failed native suite stops further checks and preserves the failure', async () => {
  let calls = 0
  expect(await runAgentDesktopChecks({ run: async () => { ++calls; return 7 } })).toBe(7)
  expect(calls).toBe(1)
})
