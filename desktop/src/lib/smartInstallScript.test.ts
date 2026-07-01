import { describe, expect, it } from 'vitest'
import {
  buildSmartInstallPlan,
  buildSmartInstallScript,
  buildSmartInstallCommandLine,
} from './smartInstallScript'
import type { PluginPrerequisiteRow } from '../types/plugin'

const uvxRow: PluginPrerequisiteRow = {
  command: 'uvx',
  label: 'uv (Python tool runner)',
  homepage: 'https://docs.astral.sh/uv/',
  installed: false,
  resolvedPath: null,
  install: {
    win32: [
      { manager: 'winget', cmd: 'winget install --id=astral-sh.uv -e' },
      { manager: 'scoop', cmd: 'scoop install uv' },
    ],
    darwin: [{ manager: 'brew', cmd: 'brew install uv' }],
    linux: [{ manager: 'shell', cmd: 'curl -LsSf https://astral.sh/uv/install.sh | sh' }],
  },
  affectedServers: [{ name: 'ghidra' }, { name: 'lldb' }],
}

const javaRow: PluginPrerequisiteRow = {
  command: 'java',
  installed: false,
  resolvedPath: null,
  install: {
    win32: [
      { manager: 'winget', cmd: 'winget install --id=EclipseAdoptium.Temurin.17.JDK -e' },
    ],
  },
  affectedServers: [{ name: 'jadx' }],
}

const installedRow: PluginPrerequisiteRow = {
  command: 'node',
  installed: true,
  resolvedPath: 'C:\\Program Files\\nodejs\\node.exe',
  install: { win32: [{ manager: 'winget', cmd: 'winget install OpenJS.NodeJS.LTS' }] },
  affectedServers: [{ name: 'radare2' }],
}

describe('buildSmartInstallPlan', () => {
  it('skips already-installed rows', () => {
    const plan = buildSmartInstallPlan([uvxRow, installedRow], 'win32')
    expect(plan).toHaveLength(1)
    expect(plan[0]!.command).toBe('uvx')
  })

  it('skips rows without install steps for the requested platform', () => {
    // javaRow has only win32 — asking for darwin should drop it.
    const plan = buildSmartInstallPlan([javaRow], 'darwin')
    expect(plan).toHaveLength(0)
  })

  it('preserves the declared order of install options', () => {
    const plan = buildSmartInstallPlan([uvxRow], 'win32')
    expect(plan[0]!.options.map((o) => o.manager)).toEqual(['winget', 'scoop'])
  })
})

describe('buildSmartInstallScript', () => {
  it('emits a no-op marker when the plan is empty', () => {
    expect(buildSmartInstallScript([])).toContain('nothing to install')
  })

  it('embeds each command and option into the script body', () => {
    const plan = buildSmartInstallPlan([uvxRow, javaRow], 'win32')
    const script = buildSmartInstallScript(plan)
    expect(script).toContain("command = 'uvx'")
    expect(script).toContain("command = 'java'")
    expect(script).toContain("manager = 'winget'")
    expect(script).toContain("manager = 'scoop'")
  })

  it('auto-appends winget non-interactive flags', () => {
    const plan = buildSmartInstallPlan([uvxRow], 'win32')
    const script = buildSmartInstallScript(plan)
    expect(script).toContain('--accept-source-agreements')
    expect(script).toContain('--accept-package-agreements')
  })

  it('does NOT add winget flags when the manager is not winget', () => {
    const scoopOnly: PluginPrerequisiteRow = {
      ...uvxRow,
      install: { win32: [{ manager: 'scoop', cmd: 'scoop install uv' }] },
    }
    const script = buildSmartInstallScript(buildSmartInstallPlan([scoopOnly], 'win32'))
    expect(script).toContain("manager = 'scoop'")
    // No winget flags injected when no winget step is present.
    expect(script).not.toContain('--accept-source-agreements')
  })

  it('escapes single quotes inside install commands so the PS literal stays valid', () => {
    const trickyRow: PluginPrerequisiteRow = {
      ...uvxRow,
      install: {
        win32: [
          {
            manager: 'shell',
            cmd: "powershell -c \"irm https://example.com/it's-tricky.ps1 | iex\"",
          },
        ],
      },
    }
    const plan = buildSmartInstallPlan([trickyRow], 'win32')
    const script = buildSmartInstallScript(plan)
    // PowerShell single-quoted strings escape ' as ''. Our input has
    // a single ', so the script should contain it'' (the doubled form).
    expect(script).toContain("it''s-tricky.ps1")
  })

  it('embeds the verifier helpers (Test-Cmd, Update-PathFromRegistry) so the runtime path-refresh logic is present', () => {
    const plan = buildSmartInstallPlan([uvxRow], 'win32')
    const script = buildSmartInstallScript(plan)
    expect(script).toContain('function Update-PathFromRegistry')
    expect(script).toContain('function Test-Cmd')
    expect(script).toContain('function Try-OneOption')
    expect(script).toContain("[System.Environment]::GetEnvironmentVariable('Path', 'Machine')")
  })
})

describe('buildSmartInstallCommandLine', () => {
  it('produces a single powershell.exe -EncodedCommand invocation', () => {
    const plan = buildSmartInstallPlan([uvxRow, javaRow], 'win32')
    const line = buildSmartInstallCommandLine(plan)
    expect(line).toMatch(/^powershell\.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand /)
    // Encoded payload is base64; nothing else after.
    const encoded = line.split(' -EncodedCommand ')[1]!
    expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/)
  })

  it('decodes back to the same script body', () => {
    const plan = buildSmartInstallPlan([uvxRow], 'win32')
    const line = buildSmartInstallCommandLine(plan)
    const encoded = line.split(' -EncodedCommand ')[1]!
    // Decode base64 → UTF-16LE bytes → string (mirroring what
    // powershell.exe will do).
    const binary = atob(encoded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    let decoded = ''
    for (let i = 0; i < bytes.length; i += 2) {
      decoded += String.fromCharCode(bytes[i]! | (bytes[i + 1]! << 8))
    }
    expect(decoded).toContain("command = 'uvx'")
    expect(decoded).toContain('Update-PathFromRegistry')
  })
})
