import { describe, expect, it } from 'bun:test'
import { mergeInstallMap } from './pluginService'
import type { McpPrerequisite } from '../../services/mcp/types'

type InstallMap = NonNullable<McpPrerequisite['install']>

describe('mergeInstallMap', () => {
  it('returns a copy of the incoming map when existing is undefined', () => {
    const incoming: InstallMap = {
      win32: [{ manager: 'winget', cmd: 'winget install --id=x' }],
    }
    const merged = mergeInstallMap(undefined, incoming) as InstallMap
    expect(merged.win32).toEqual(incoming.win32)
    expect(merged.darwin).toBeUndefined()
    expect(merged.linux).toBeUndefined()
  })

  it('appends incoming steps NOT already present, preserving order', () => {
    const existing: InstallMap = {
      win32: [
        { manager: 'winget', cmd: 'winget install --id=astral-sh.uv -e' },
        { manager: 'scoop', cmd: 'scoop install uv' },
      ],
    }
    const incoming: InstallMap = {
      win32: [
        { manager: 'winget', cmd: 'winget install --id=astral-sh.uv -e' },
        { manager: 'powershell', cmd: 'powershell -c "irm https://astral.sh/uv/install.ps1 | iex"' },
      ],
    }
    const merged = mergeInstallMap(existing, incoming) as InstallMap
    expect(merged.win32).toHaveLength(3)
    expect(merged.win32![0]!.manager).toBe('winget')
    expect(merged.win32![1]!.manager).toBe('scoop')
    expect(merged.win32![2]!.manager).toBe('powershell')
  })

  it('dedups (manager, cmd) pairs exactly — same manager with different cmd both kept', () => {
    const existing: InstallMap = {
      win32: [{ manager: 'shell', cmd: 'curl -A | sh' }],
    }
    const incoming: InstallMap = {
      win32: [
        { manager: 'shell', cmd: 'curl -A | sh' }, // duplicate, dropped
        { manager: 'shell', cmd: 'wget -qO- | sh' }, // different cmd, kept
      ],
    }
    const merged = mergeInstallMap(existing, incoming) as InstallMap
    expect(merged.win32).toHaveLength(2)
    expect(merged.win32!.map((s) => s.cmd)).toEqual([
      'curl -A | sh',
      'wget -qO- | sh',
    ])
  })

  it('merges across platforms independently', () => {
    const existing: InstallMap = {
      win32: [{ manager: 'winget', cmd: 'a' }],
      darwin: [{ manager: 'brew', cmd: 'brew install x' }],
    }
    const incoming: InstallMap = {
      win32: [{ manager: 'scoop', cmd: 'b' }],
      linux: [{ manager: 'apt', cmd: 'sudo apt install x' }],
    }
    const merged = mergeInstallMap(existing, incoming) as InstallMap
    expect(merged.win32).toHaveLength(2)
    expect(merged.darwin).toHaveLength(1)
    expect(merged.linux).toHaveLength(1)
  })

  it('treats missing platform arrays the same as empty', () => {
    const merged = mergeInstallMap(
      { win32: [{ manager: 'a', cmd: 'a' }] },
      { darwin: [{ manager: 'b', cmd: 'b' }] },
    ) as InstallMap
    expect(merged.win32).toHaveLength(1)
    expect(merged.darwin).toHaveLength(1)
    expect(merged.linux).toBeUndefined()
  })
})
