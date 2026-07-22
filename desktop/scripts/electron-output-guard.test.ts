// @vitest-environment node

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertElectronOutputIdle,
  findRunningElectronOutputProcesses,
  parseProcessSnapshots,
} from './electron-output-guard'

const outputDir = path.resolve('build-artifacts', 'electron')
const bundledMainCommand = path.join(
  outputDir,
  'mac-arm64',
  'Claude Code Haha.app',
  'Contents',
  'MacOS',
  'Claude Code Haha',
)
const bundledSidecarCommand = path.join(
  outputDir,
  'mac-arm64',
  'Claude Code Haha.app',
  'Contents',
  'Resources',
  'app.asar.unpacked',
  'src-tauri',
  'binaries',
  'claude-sidecar server',
)
const scriptsDir = import.meta.dirname

describe('Electron output guard', () => {
  it('parses the ps process table into individual snapshots', () => {
    expect(parseProcessSnapshots([
      '  20641 /workspace/Claude Code Haha.app/Contents/MacOS/Claude Code Haha',
      '    321 /usr/bin/example --flag',
      '',
    ].join('\n'))).toEqual([
      {
        pid: 20641,
        command: '/workspace/Claude Code Haha.app/Contents/MacOS/Claude Code Haha',
      },
      { pid: 321, command: '/usr/bin/example --flag' },
    ])
  })

  it('finds a packaged app main process running from the output directory', () => {
    const processes = findRunningElectronOutputProcesses(outputDir, [
      {
        pid: 20641,
        command: bundledMainCommand,
      },
      {
        pid: 20656,
        command: bundledSidecarCommand,
      },
      {
        pid: 99,
        command: '/Applications/Claude Code Haha.app/Contents/MacOS/Claude Code Haha',
      },
    ])

    expect(processes).toEqual([
      {
        pid: 20641,
        command: bundledMainCommand,
      },
      {
        pid: 20656,
        command: bundledSidecarCommand,
      },
    ])
  })

  it('fails before cleanup with an actionable message', () => {
    expect(() => assertElectronOutputIdle(outputDir, [{
      pid: 20641,
      command: bundledMainCommand,
    }])).toThrow(/Quit the packaged app before rebuilding.*PID 20641/s)
  })

  it('allows cleanup when only packaged apps outside the output directory are running', () => {
    expect(() => assertElectronOutputIdle(outputDir, [{
      pid: 99,
      command: '/Applications/Claude Code Haha.app/Contents/MacOS/Claude Code Haha',
    }])).not.toThrow()
  })

  it('guards both direct cleanup and the macOS build before deleting artifacts', () => {
    const cleanSource = readFileSync(path.join(scriptsDir, 'clean-electron-output.ts'), 'utf8')
    const macBuildSource = readFileSync(path.join(scriptsDir, 'build-macos-arm64.sh'), 'utf8')

    expect(cleanSource.indexOf('assertElectronOutputIdle(')).toBeLessThan(
      cleanSource.indexOf('await rm('),
    )
    expect(macBuildSource).toContain(
      'bun run ./scripts/assert-electron-output-idle.ts "${ELECTRON_OUTPUT_DIR}" "${CANONICAL_OUTPUT_DIR}"',
    )
    expect(macBuildSource).not.toContain('rm -rf "${ELECTRON_OUTPUT_DIR}"')
  })
})
