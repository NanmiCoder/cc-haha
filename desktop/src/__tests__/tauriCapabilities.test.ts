import { describe, expect, it } from 'vitest'
import defaultCapabilityJson from '../../src-tauri/capabilities/default.json?raw'

function readDefaultCapabilityPermissions(): string[] {
  const capability = JSON.parse(defaultCapabilityJson) as {
    permissions?: unknown[]
  }

  return (capability.permissions ?? []).filter((permission): permission is string =>
    typeof permission === 'string'
  )
}

describe('Tauri default capability', () => {
  it('allows the dialog message API used by Tauri alert/confirm shims', () => {
    const permissions = readDefaultCapabilityPermissions()

    expect(
      permissions.some(permission =>
        permission === 'dialog:default' || permission === 'dialog:allow-message'
      )
    ).toBe(true)
  })

  it('keeps file dialog access enabled', () => {
    const permissions = readDefaultCapabilityPermissions()

    expect(permissions).toContain('dialog:allow-open')
    expect(permissions).toContain('dialog:allow-save')
  })
})
