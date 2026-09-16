import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectorsPersistence } from './connectorsPersistence.js'

describe('connector persistence upgrades', () => {
  test('migrates an old fixture, preserves unknown fields and invalidates interrupted readiness', () => {
    const root = mkdtempSync(join(tmpdir(), 'connectors-'))
    try {
      writeFileSync(join(root, 'state.json'), JSON.stringify({ custom: 'keep', connectors: { feishu: { custom: 42, installed: true, enabled: true, status: 'ready', runtime: 'ready', operation: { id: 'old' } } } }))
      const store = new ConnectorsPersistence(root)
      expect(store.get('feishu').runtime).toBe('missing')
      expect(store.get('feishu').operation).toBeUndefined()
      expect(store.get('feishu').status).toBe('needs-auth')
      store.set('feishu', { status: 'disabled' })
      const saved = JSON.parse(readFileSync(store.path, 'utf8'))
      expect(saved.schemaVersion).toBe(1)
      expect(saved.custom).toBe('keep')
      expect(saved.connectors.feishu.custom).toBe(42)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test('refuses future schemas without overwriting them', () => {
    const root = mkdtempSync(join(tmpdir(), 'connectors-'))
    try {
      const fixture = JSON.stringify({ schemaVersion: 999, connectors: {} })
      writeFileSync(join(root, 'state.json'), fixture)
      expect(() => new ConnectorsPersistence(root)).toThrow('Unsupported')
      expect(readFileSync(join(root, 'state.json'), 'utf8')).toBe(fixture)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
