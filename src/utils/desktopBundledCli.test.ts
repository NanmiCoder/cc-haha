import { describe, expect, test } from 'bun:test'
import { buildClaudeCliArgs, resolveClaudeCliLauncher } from './desktopBundledCli'

describe('desktop bundled CLI launcher', () => {
  test('uses the running Bun executable for TypeScript CLI scripts when available', () => {
    const bunExecutable = process.platform === 'win32' ? 'C:\\tools\\bun\\bun.exe' : '/opt/bun/bin/bun'
    const cliPath = process.platform === 'win32' ? 'C:\\repo\\mock-sdk-cli.ts' : '/repo/mock-sdk-cli.ts'
    const launcher = resolveClaudeCliLauncher({ cliPath, execPath: bunExecutable })

    expect(launcher).toEqual({
      command: cliPath,
      kind: 'script',
      requiresAppRoot: false,
      scriptRuntime: bunExecutable,
    })
    expect(buildClaudeCliArgs(launcher!, ['--model', 'test'])).toEqual([
      bunExecutable,
      cliPath,
      '--model',
      'test',
    ])
  })

  test('keeps PATH-based Bun fallback when the current executable is not Bun', () => {
    const cliPath = process.platform === 'win32' ? 'C:\\repo\\mock-sdk-cli.ts' : '/repo/mock-sdk-cli.ts'
    const serverExecutable = process.platform === 'win32' ? 'C:\\app\\claude-server.exe' : '/app/claude-server'
    const launcher = resolveClaudeCliLauncher({ cliPath, execPath: serverExecutable })

    expect(launcher?.scriptRuntime).toBeUndefined()
    expect(buildClaudeCliArgs(launcher!, ['--version'])).toEqual(['bun', cliPath, '--version'])
  })
})
