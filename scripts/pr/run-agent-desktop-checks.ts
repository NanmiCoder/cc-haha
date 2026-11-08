import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSandboxedTestEnvironment, removeTestSandbox } from './test-environment'

type Runner = (command: string[], options: { cwd: string; env: Record<string, string> }) => Promise<number>

export async function runAgentDesktopChecks(options: { run?: Runner; source?: NodeJS.ProcessEnv } = {}) {
  const root = resolve(import.meta.dir, '../..')
  const source = options.source ?? process.env
  const sandbox = mkdtempSync(join(tmpdir(), 'cc-haha-native-desktop-'))
  const run = options.run ?? (async (command, settings) => {
    const child = Bun.spawn(command, { ...settings, stdout: 'inherit', stderr: 'inherit' })
    return child.exited
  })
  try {
    const compiler: Record<string, string> = {}
    for (const key of ['LIB', 'LIBPATH', 'INCLUDE', 'VCINSTALLDIR', 'VCToolsInstallDir', 'WindowsSdkDir', 'WindowsSDKVersion']) {
      if (source[key]) compiler[key] = source[key]!
    }
    const env = createSandboxedTestEnvironment(sandbox, {
      ...compiler,
      CARGO_HOME: source.CARGO_HOME ?? join(homedir(), '.cargo'),
      RUSTUP_HOME: source.RUSTUP_HOME ?? join(homedir(), '.rustup'),
      CARGO_NET_OFFLINE: 'true',
    }, source)
    const cargo = ['cargo', '+stable', 'test', '--locked', '--offline', '--manifest-path', join(root, 'native/agent-desktop/Cargo.toml')]
    const commands = [
      [...cargo, '-p', 'agent-desktop-core', '--lib', '--', '--test-threads=1'],
      [...cargo, '-p', 'agent-desktop-core', '--test', 'product_cursor_visuals'],
      [...cargo, '-p', 'agent-desktop', '--bin', 'agent-desktop', 'cli::', '--', '--test-threads=1'],
      [...cargo, '-p', 'agent-desktop', '--bin', 'agent-desktop', 'dispatch::cursor_overlay_lifecycle_tests::', '--', '--test-threads=1'],
    ]
    if (process.platform === 'win32') {
      commands.push([
        ...cargo, '-p', 'agent-desktop-windows', '--lib', '--',
        'system::cursor_overlay::', 'winforms', '--test-threads=1', '--skip', 'system::cursor_overlay::window::tests::',
      ])
      commands.push([
        ...cargo, '-p', 'agent-desktop', '--test', 'windows_private_file_install',
        'status_probe_refuses_inherited_access_and_accepts_a_native_created_root', '--', '--exact',
      ])
    }
    for (const command of commands) {
      const code = await run(command, { cwd: root, env })
      if (code !== 0) return code
    }
    return 0
  } finally {
    removeTestSandbox(sandbox, 'native-desktop-checks')
  }
}

if (import.meta.main) process.exit(await runAgentDesktopChecks())
