import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resetMcpStdioEnvironmentCacheForTests } from '../../utils/mcpStdioEnvironment.js'
import { inspectMcpHostCommand } from './mcpHostPreflight.js'

let tmpDir: string
const shellCaptureTest = process.platform === 'win32' ? it.skip : it
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

describe('MCP host preflight', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'mcp-host-preflight-test-'))
    originalEnv = {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      SHELL: process.env.SHELL,
      ZDOTDIR: process.env.ZDOTDIR,
      CC_HAHA_DISABLE_TERMINAL_SHELL_ENV:
        process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV,
    }
    delete process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV
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

  shellCaptureTest('finds npx from user shell PATH when the desktop process PATH is minimal', async () => {
    const shellPath = path.join(tmpDir, 'zsh')
    const nodeBin = path.join(tmpDir, 'node-bin')
    const npxPath = path.join(nodeBin, 'npx')
    await mkdir(nodeBin, { recursive: true })
    await writeFakeZsh(shellPath)
    await writeExecutable(npxPath, '#!/bin/sh\nexit 0\n')
    await writeFile(
      path.join(tmpDir, '.zshrc'),
      `export PATH="${nodeBin}:$PATH"\n`,
    )

    process.env.HOME = tmpDir
    process.env.SHELL = shellPath
    process.env.PATH = '/usr/bin:/bin'
    delete process.env.ZDOTDIR

    await expect(inspectMcpHostCommand('npx', tmpDir, {})).resolves.toEqual({
      ok: true,
      resolvedCommand: npxPath,
    })
  })

  it('finds commands from the desktop process PATH before shell fallback', async () => {
    const processBin = path.join(tmpDir, 'process-bin')
    const toolPath = path.join(processBin, 'mcp-tool')
    await mkdir(processBin, { recursive: true })
    await writeExecutable(toolPath, '#!/bin/sh\nexit 0\n')

    process.env.HOME = tmpDir
    process.env.SHELL = '/bin/zsh'
    process.env.PATH = processBin

    await expect(
      inspectMcpHostCommand('mcp-tool', tmpDir, {}),
    ).resolves.toEqual({
      ok: true,
      resolvedCommand: toolPath,
    })
  })

  it('uses explicit MCP PATH to resolve host commands', async () => {
    const configuredBin = path.join(tmpDir, 'configured-bin')
    const toolPath = path.join(configuredBin, 'mcp-tool')
    await mkdir(configuredBin, { recursive: true })
    await writeExecutable(toolPath, '#!/bin/sh\nexit 0\n')

    process.env.HOME = tmpDir
    process.env.SHELL = '/bin/zsh'
    process.env.PATH = '/usr/bin:/bin'

    await expect(
      inspectMcpHostCommand('mcp-tool', tmpDir, { PATH: configuredBin }),
    ).resolves.toEqual({
      ok: true,
      resolvedCommand: toolPath,
    })
  })

  it('does not fall back to shell PATH when MCP PATH is explicit', async () => {
    const shellPath = path.join(tmpDir, 'zsh')
    const nodeBin = path.join(tmpDir, 'node-bin')
    const emptyBin = path.join(tmpDir, 'empty-bin')
    const npxPath = path.join(nodeBin, 'npx')
    await mkdir(nodeBin, { recursive: true })
    await mkdir(emptyBin, { recursive: true })
    await writeFakeZsh(shellPath)
    await writeExecutable(npxPath, '#!/bin/sh\nexit 0\n')
    await writeFile(
      path.join(tmpDir, '.zshrc'),
      `export PATH="${nodeBin}:$PATH"\n`,
    )

    process.env.HOME = tmpDir
    process.env.SHELL = shellPath
    process.env.PATH = '/usr/bin:/bin'
    delete process.env.ZDOTDIR

    await expect(
      inspectMcpHostCommand('npx', tmpDir, { PATH: emptyBin }),
    ).resolves.toEqual({
      ok: false,
      message:
        'Host command "npx" is not available in PATH. This STDIO MCP runs on the host machine. Install Node.js on this machine so "npx" is available in PATH, then retry.',
    })
  })
})
