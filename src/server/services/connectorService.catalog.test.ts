import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ALL_CONNECTORS } from '../../services/connectors/catalog.js'
import { ConnectorService } from './connectorService.js'

// Exercise every catalog definition through the production state machine.
// Adapters and chat transport are fixtures: no downloaded binaries or accounts.
test.each(ALL_CONNECTORS)('$id gates readiness on chat capabilities through connect, recheck, disable and removal', async definition => {
  const root = mkdtempSync(join(tmpdir(), 'connector-catalog-state-'))
  let enabled = false
  let available = true
  let authenticated = definition.transport === 'skills'
  const required: string[] = []
  const service = new ConnectorService({
    root, definitions: [definition], platform: definition.platforms[0],
    createAdapter: () => ({
      prepare: async () => ({ directory: root, command: '', args: [], env: {} }),
      authenticate: async () => { authenticated = true },
      check: async () => ({ authenticated, verification: definition.transport === 'mcp' ? 'remote' : 'local' }),
      deactivate: async () => {}, remove: async () => {},
    }),
    bridge: {
      installConnectorPlugin: async () => {}, removeConnectorPlugin: async () => {},
      setConnectorPluginEnabled: async (_def, value) => { enabled = value },
      isConnectorPluginReady: async () => true,
      reloadConnectorSessions: async (_session, target) => {
        if (!target) return
        expect(enabled).toBe(true)
        expect(target).toEqual(definition)
        required.push(target.id)
        if (!available) throw new Error('Fixture chat did not load its connector')
      },
    },
  })
  async function settle() {
    for (let i = 0; i < 200 && service.get(definition.id).operation; i++) await Bun.sleep(1)
    expect(service.get(definition.id).operation).toBeUndefined()
  }
  try {
    service.action(definition.id, 'prepare')
    await settle()
    if (definition.transport !== 'skills') {
      expect(required).toEqual([])
      service.action(definition.id, 'authenticate', { acknowledgeSharedCredentials: true })
      await settle()
    }
    expect(required).toEqual([definition.id])
    expect(service.get(definition.id)).toMatchObject({ enabled: true, runtime: 'ready' })

    available = false
    service.action(definition.id, 'check')
    await settle()
    expect(service.get(definition.id)).toMatchObject({ enabled: false, runtime: 'error', status: 'error' })
    expect(enabled).toBe(false)

    available = true
    service.action(definition.id, 'check')
    await settle()
    expect(service.get(definition.id)).toMatchObject({ enabled: true, runtime: 'ready' })
    expect(required).toEqual([definition.id, definition.id, definition.id])
    service.action(definition.id, 'deactivate')
    await settle()
    expect(service.get(definition.id)).toMatchObject({ enabled: false, status: 'disabled' })
    service.action(definition.id, 'remove')
    await settle()
    expect(service.get(definition.id)).toMatchObject({ enabled: false, installed: false })
    expect(required).toHaveLength(3)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
