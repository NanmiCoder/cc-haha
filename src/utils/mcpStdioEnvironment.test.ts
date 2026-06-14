import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  getMcpStdioEnvironment,
  resetMcpStdioEnvironmentCacheForTests,
} from './mcpStdioEnvironment.js'

let tmpDir: string
let originalEnv: {
  HOME?: string
  PATH?: string
  SHELL?: string
  ZDOTDIR?: string
  CC_HAHA_DISABLE_TERMINAL_SHELL_ENV?: string
}

async function writeExecutable(filePath: string, content: string) {
  await writeFile(filePath, content, { mode: 0o755 })
}

async function writeFakeZsh(filePath: string) {
  await writeExecutable(
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
  )
}

describe('MCP stdio environment', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'mcp-stdio-env-test-'))
    originalEnv = {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      SHELL: process.env.SHELL,
      ZDOTDIR: process.env.ZDOTDIR,
      NVM_DIR: process.env.NVM_DIR,
      CC_HAHA_DISABLE_TERMINAL_SHELL_ENV:
        process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV,
    }
    delete process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV
    // The CI runner exports a real NVM_DIR (/home/runner/.nvm). The env merge
    // lets inherited process env win over shell-captured values, so a leaked
    // NVM_DIR would shadow the fake .zshrc value asserted below. Clear it so the
    // only source of NVM_DIR is the fake shell config.
    delete process.env.NVM_DIR
    resetMcpStdioEnvironmentCacheForTests()
  })

  afterEach(async () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    resetMcpStdioEnvironmentCacheForTests()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('adds PATH entries sourced from the user zshrc when MCP env has no explicit PATH', async () => {
    const shellPath = path.join(tmpDir, 'zsh')
    const nodeBin = path.join(tmpDir, 'node-bin')
    await mkdir(nodeBin, { recursive: true })
    await writeFakeZsh(shellPath)
    await writeFile(
      path.join(tmpDir, '.zshrc'),
      [
        `export NVM_DIR="${path.join(tmpDir, '.nvm')}"`,
        `export PATH="${nodeBin}:$PATH"`,
        '',
      ].join('\n'),
    )

    process.env.HOME = tmpDir
    process.env.SHELL = shellPath
    process.env.PATH = '/usr/bin:/bin'
    delete process.env.ZDOTDIR

    const env = await getMcpStdioEnvironment({})

    expect(env.PATH?.split(path.delimiter)[0]).toBe(nodeBin)
    expect(env.PATH?.split(path.delimiter)).toContain('/usr/bin')
    expect(env.NVM_DIR).toBe(path.join(tmpDir, '.nvm'))
  })

  it('keeps an explicit MCP PATH instead of reading shell config', async () => {
    const shellPath = path.join(tmpDir, 'zsh')
    const nodeBin = path.join(tmpDir, 'node-bin')
    await mkdir(nodeBin, { recursive: true })
    await writeFakeZsh(shellPath)
    await writeFile(
      path.join(tmpDir, '.zshrc'),
      `export PATH="${nodeBin}:$PATH"\n`,
    )

    process.env.HOME = tmpDir
    process.env.SHELL = shellPath
    process.env.PATH = '/usr/bin:/bin'

    const env = await getMcpStdioEnvironment({ PATH: '/custom/bin' })

    expect(env.PATH).toBe('/custom/bin')
  })
})
