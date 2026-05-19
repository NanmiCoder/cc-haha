import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  getTerminalShellEnvironment,
  mergeTerminalShellEnvironment,
  resetTerminalShellEnvironmentCacheForTests,
} from './terminalShellEnvironment.js'

let tmpDir: string

async function writeFakeZsh(filePath: string) {
  await writeFile(
    filePath,
    [
      '#!/bin/sh',
      'command=',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "-c" ]; then',
      '    shift',
      '    command="$1"',
      '    break',
      '  fi',
      '  shift',
      'done',
      'if [ -f "$HOME/.zshrc" ]; then',
      '  . "$HOME/.zshrc" </dev/null >/dev/null 2>/dev/null || true',
      'fi',
      'exec /bin/sh -c "$command"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
}

describe('terminal shell environment', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'terminal-shell-env-test-'))
    resetTerminalShellEnvironmentCacheForTests()
  })

  afterEach(async () => {
    resetTerminalShellEnvironmentCacheForTests()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('captures exported variables from an interactive user shell', async () => {
    const shellPath = path.join(tmpDir, 'zsh')
    const nodeBin = path.join(tmpDir, 'node-bin')
    const nvmDir = path.join(tmpDir, '.nvm')
    await mkdir(nodeBin, { recursive: true })
    await mkdir(nvmDir, { recursive: true })
    await writeFakeZsh(shellPath)
    await writeFile(
      path.join(tmpDir, '.zshrc'),
      [
        `export NVM_DIR="${nvmDir}"`,
        `export PATH="${nodeBin}:$PATH"`,
        '',
      ].join('\n'),
    )

    const env = await getTerminalShellEnvironment({
      HOME: tmpDir,
      SHELL: shellPath,
      PATH: '/usr/bin:/bin',
    })

    expect(env?.NVM_DIR).toBe(nvmDir)
    expect(env?.PATH?.split(path.delimiter)[0]).toBe(nodeBin)
  })

  it('merges shell PATH before base PATH while preserving app env overrides', () => {
    const merged = mergeTerminalShellEnvironment(
      {
        PATH: '/usr/bin:/bin',
        CC_HAHA_DESKTOP_SERVER_URL: 'http://127.0.0.1:3456',
        TOOL_HOME: '/base/tool',
      },
      {
        PATH: '/opt/homebrew/bin:/usr/bin',
        NVM_DIR: '/Users/test/.nvm',
        TOOL_HOME: '/shell/tool',
      },
    )

    expect(merged.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin')
    expect(merged.NVM_DIR).toBe('/Users/test/.nvm')
    expect(merged.TOOL_HOME).toBe('/base/tool')
    expect(merged.CC_HAHA_DESKTOP_SERVER_URL).toBe('http://127.0.0.1:3456')
  })

  it('can be disabled for deterministic tests and controlled environments', async () => {
    const env = await getTerminalShellEnvironment({
      HOME: tmpDir,
      SHELL: path.join(tmpDir, 'zsh'),
      PATH: '/usr/bin:/bin',
      CC_HAHA_DISABLE_TERMINAL_SHELL_ENV: '1',
    })

    expect(env).toBeNull()
  })

  it('does not capture shell env when the current process owns an interactive TTY', async () => {
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')

    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: true,
    })
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    })

    try {
      const shellPath = path.join(tmpDir, 'zsh')
      await writeFakeZsh(shellPath)

      const env = await getTerminalShellEnvironment({
        HOME: tmpDir,
        SHELL: shellPath,
        PATH: '/usr/bin:/bin',
      })

      expect(env).toBeNull()
    } finally {
      if (stdinDescriptor) {
        Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor)
      } else {
        delete (process.stdin as { isTTY?: boolean }).isTTY
      }
      if (stdoutDescriptor) {
        Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor)
      } else {
        delete (process.stdout as { isTTY?: boolean }).isTTY
      }
    }
  })
})
