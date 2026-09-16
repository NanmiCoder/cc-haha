import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConnectorDto, ConnectorInstallation } from '../../services/connectors/types.js'

export type ConnectorRecord = Partial<ConnectorDto> & { installation?: ConnectorInstallation, sharedCredentialsAcknowledged?: boolean }
type Store = { schemaVersion: number, connectors: Record<string, ConnectorRecord>, [key: string]: unknown }

export class ConnectorsPersistence {
  private store: Store
  readonly path: string

  constructor(private root: string) {
    this.path = join(root, 'state.json')
    let raw: unknown
    try { raw = JSON.parse(readFileSync(this.path, 'utf8')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read connector state; existing state was preserved')
      raw = { schemaVersion: 1, connectors: {} }
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid connector state')
    const value = raw as Store
    if (value.schemaVersion !== undefined && value.schemaVersion !== 0 && value.schemaVersion !== 1) {
      throw new Error('Unsupported connector state version; update the app before modifying connectors')
    }
    if (!value.connectors || typeof value.connectors !== 'object' || Array.isArray(value.connectors)) throw new Error('Invalid connector records')
    // v0 used the same record collection without an explicit schema marker.
    this.store = { ...value, schemaVersion: 1 }
    for (const [id, record] of Object.entries(this.store.connectors)) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid connector record')
      this.store.connectors[id] = { ...record, operation: undefined, verification: undefined, runtime: 'missing', connection: record.installed ? 'needs-auth' : 'disconnected',
        status: record.installed ? (record.enabled ? 'needs-auth' : 'disabled') : 'not-installed',
        ...(record.operation ? { error: 'Previous operation was interrupted. Check the connection again.' } : {}) }
    }
  }

  get(id: string): ConnectorRecord { return this.store.connectors[id] ?? {} }

  set(id: string, record: ConnectorRecord): void {
    const next = { ...this.store, connectors: { ...this.store.connectors, [id]: { ...this.get(id), ...record } } }
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 })
    renameSync(temporary, this.path)
    this.store = next
  }
}
