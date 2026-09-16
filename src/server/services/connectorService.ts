import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import type { ConnectorAction, ConnectorActionOptions, ConnectorAdapter, ConnectorDefinition, ConnectorDto, ConnectorInstallation } from '../../services/connectors/types.js'
import { ConnectorsPersistence, type ConnectorRecord } from './connectorsPersistence.js'

export class ConnectorServiceError extends Error {
  constructor(public statusCode: number, message: string) { super(message) }
  static notFound(message: string) { return new ConnectorServiceError(404, message) }
  static conflict(message: string) { return new ConnectorServiceError(409, message) }
  static badRequest(message: string) { return new ConnectorServiceError(400, message) }
}

type Bridge = {
  installConnectorPlugin(def: ConnectorDefinition, installation: ConnectorInstallation): Promise<void>
  setConnectorPluginEnabled(def: ConnectorDefinition, enabled: boolean): Promise<void>
  removeConnectorPlugin(def: ConnectorDefinition): Promise<void>
  isConnectorPluginReady(def: ConnectorDefinition): Promise<boolean>
  reloadConnectorSessions(sessionId?: string, requiredConnector?: ConnectorDefinition): Promise<void>
}
export type ConnectorServiceDependencies = {
  definitions: readonly ConnectorDefinition[]
  createAdapter(def: ConnectorDefinition, root: string): ConnectorAdapter
  bridge: Bridge
  root: string
  platform?: string
}

export class ConnectorService {
  private persistence: ConnectorsPersistence
  private operations = new Map<string, AbortController>()
  private storageFailures = new Map<string, ConnectorRecord>()
  constructor(private deps: ConnectorServiceDependencies) {
    this.persistence = new ConnectorsPersistence(deps.root)
  }

  private definition(id: string): ConnectorDefinition {
    const definition = this.deps.definitions.find(item => item.id === id)
    if (!definition) throw ConnectorServiceError.notFound('Unknown connector')
    return definition
  }

  get(id: string): ConnectorDto {
    const def = this.definition(id)
    const state = { ...this.persistence.get(id), ...this.storageFailures.get(id) }
    return { ...def, supported: def.platforms.includes(this.deps.platform ?? `${process.platform}-${process.arch}`),
      installed: state.installed ?? false, installedVersion: state.installedVersion, updateAvailable: !!state.installed && state.installedVersion !== def.version, enabled: state.enabled ?? false,
      connection: state.connection ?? 'disconnected', runtime: state.runtime ?? 'missing', status: state.status ?? 'not-installed',
      operation: state.operation, error: state.error, lastCheckedAt: state.lastCheckedAt, accountLabel: state.accountLabel, verification: state.verification, failedPhase: state.failedPhase }
  }

  private installedDefinition(def: ConnectorDefinition, record: ConnectorRecord): ConnectorDefinition {
    const legacyVersion = record.installation && basename(record.installation.directory).match(/^(.+)-(?:darwin|win32)-(?:arm64|x64)$/)?.[1]
    const version = record.installedVersion ?? legacyVersion ?? def.version
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version)) {
      throw new Error('Invalid installed connector version')
    }
    return { ...def, version }
  }

  list(): ConnectorDto[] { return this.deps.definitions.map(def => this.get(def.id)) }

  private patch(id: string, state: ConnectorRecord): void {
    try {
      this.persistence.set(id, state)
      this.storageFailures.delete(id)
    } catch {
      this.storageFailures.set(id, { enabled: false, runtime: 'error', status: 'error', operation: undefined,
        failedPhase: 'persistence', error: 'Could not save connector state. Check available disk space and retry.' })
      throw new Error('Could not save connector state')
    }
  }

  action(id: string, action: ConnectorAction, options: ConnectorActionOptions = {}): ConnectorDto {
    const def = this.definition(id)
    const current = this.get(id)
    if (action === 'cancel') {
      const controller = this.operations.get(id)
      if (!controller) throw ConnectorServiceError.conflict('No operation to cancel')
      controller.abort()
      this.patch(id, { operation: { ...current.operation!, phase: 'cancelling', authUrl: undefined } })
      return this.get(id)
    }
    if (this.operations.has(id)) throw ConnectorServiceError.conflict('A connector operation is already running')
    if (!current.supported && action !== 'remove' && action !== 'deactivate') throw ConnectorServiceError.badRequest('Connector is not supported on this platform')
    if ((action === 'authenticate' || (action === 'check' && !this.persistence.get(id).sharedCredentialsAcknowledged)) && def.credentialMode === 'shared' && options.acknowledgeSharedCredentials !== true) {
      throw ConnectorServiceError.badRequest('Confirm shared credentials before connecting')
    }
    if (action === 'prepare' && current.installed && !current.updateAvailable && current.status !== 'error') throw ConnectorServiceError.conflict('Connector is already installed')
    if (['authenticate', 'check'].includes(action) && !this.persistence.get(id).installation) throw ConnectorServiceError.conflict('Prepare this connector first')
    if (options.configuration && !['prepare', 'authenticate'].includes(action)) throw ConnectorServiceError.badRequest('Configuration is only accepted during setup or authentication')
    if (action === 'prepare' && current.installed && options.configuration && Object.values(options.configuration).some(value => value.trim())) throw ConnectorServiceError.badRequest('Use authentication to change credentials on an installed connector')
    const previous = { ...this.persistence.get(id) }
    const controller = new AbortController()
    this.patch(id, { operation: { id: randomUUID(), kind: action, phase: action, startedAt: new Date().toISOString() }, error: undefined, failedPhase: undefined,
      ...(action === 'prepare' ? { status: 'preparing' as const } : {}),
      ...(action === 'authenticate' ? { status: 'authorizing' as const } : {}) })
    this.operations.set(id, controller)
    void this.run(def, action, options, controller, previous).catch(async () => {
      // Persistence errors can also occur in catch/finally. Consume the promise
      // and retain the in-memory non-ready state installed by patch().
      try {
        await this.deps.bridge.setConnectorPluginEnabled(def, false)
        await this.deps.bridge.reloadConnectorSessions(options.sessionId)
      } catch { /* runtime remains explicitly non-ready */ }
      this.operations.delete(id)
    })
    return this.get(id)
  }

  private async run(def: ConnectorDefinition, action: ConnectorAction, options: ConnectorActionOptions, controller: AbortController, previous: ConnectorRecord): Promise<void> {
    const { id } = def
    let adapter: ConnectorAdapter | undefined
    // A cancelled prepare may only fall back to the prior record while nothing
    // was published; once the bridge owns the new installation the rollback is
    // the only safe route back.
    let published = false
    const bridge = this.deps.bridge
    const signal = controller.signal
    const assertActive = () => { if (signal.aborted) throw new Error('Operation cancelled') }
    const progress = (phase: string, authUrl?: string) => {
      if (!['downloading', 'extracting', 'verifying', 'awaiting-authorization', 'configuring-account', 'authorizing', 'installing-plugin', 'checking', 'enabling-plugin', 'refreshing-sessions', 'verifying-runtime'].includes(phase)) return
      if (!signal.aborted) {
        try { this.patch(id, { operation: { ...this.get(id).operation!, phase, authUrl } }) }
        catch { controller.abort() }
      }
    }
    try {
      adapter = this.deps.createAdapter(action === 'prepare' ? def : this.installedDefinition(def, previous), this.deps.root)
      if (action === 'authenticate' || action === 'check') {
        // Detach old session tools before changing credentials or checking a
        // previously connected account. A negative check must stay detached.
        this.patch(id, { runtime: 'missing', connection: 'needs-auth', enabled: false, verification: undefined, accountLabel: undefined, status: action === 'authenticate' ? 'authorizing' : 'needs-auth' })
        await bridge.setConnectorPluginEnabled(def, false)
        await bridge.reloadConnectorSessions(options.sessionId)
        assertActive()
      }
      if (options.configuration && Object.keys(options.configuration).length) {
        if (!adapter.configure || !['prepare', 'authenticate'].includes(action)) throw new Error('Connector does not accept configuration for this action')
        await adapter.configure(options.configuration)
        assertActive()
      }
      if (action === 'prepare') {
        const installation = await adapter.prepare(signal, progress)
        assertActive()
        progress('installing-plugin')
        assertActive()
        await bridge.installConnectorPlugin(def, installation)
        published = true
        await bridge.setConnectorPluginEnabled(def, false)
        assertActive()
        await bridge.reloadConnectorSessions(options.sessionId)
        assertActive()
        this.patch(id, { installation, installed: true, installedVersion: def.version, sharedCredentialsAcknowledged: previous.sharedCredentialsAcknowledged ?? false, enabled: false, connection: 'needs-auth', runtime: 'missing', status: 'needs-auth', verification: undefined, lastCheckedAt: undefined, accountLabel: undefined })
        if (def.transport === 'skills') {
          // Skill packages have no account authorization step. Verify their
          // installed files and loader, without claiming runtime dependencies.
          const checked = await adapter.check(installation, signal)
          assertActive()
          if (!checked.authenticated) throw new Error('Skill package validation failed')
          progress('enabling-plugin')
          await bridge.setConnectorPluginEnabled(def, true)
          assertActive()
          await bridge.reloadConnectorSessions(options.sessionId, def)
          assertActive()
          if (!await bridge.isConnectorPluginReady(def)) throw new Error('Skill package could not load')
          assertActive()
          this.patch(id, { enabled: true, connection: 'connected', runtime: 'ready', status: 'configured', verification: 'local' })
        }
      } else if (action === 'authenticate' || action === 'check') {
        const installation = this.persistence.get(id).installation!
        progress('checking')
        assertActive()
        let checked = await adapter.check(installation, signal)
        assertActive()
        // Binding an existing shared account must not run login/init again.
        // A failed status command is an error, not evidence that login is needed.
        if (action === 'authenticate' && checked.authenticated === false) {
          progress('authorizing')
          assertActive()
          await adapter.authenticate(installation, signal, progress)
          assertActive()
          progress('checking')
          assertActive()
          checked = await adapter.check(installation, signal)
          assertActive()
        }
        this.patch(id, { lastCheckedAt: new Date().toISOString(), accountLabel: checked.accountLabel, verification: checked.verification })
        if (!checked.authenticated) {
          this.patch(id, { connection: 'needs-auth', runtime: 'missing', enabled: false, status: 'needs-auth' })
        } else {
          this.patch(id, { connection: 'connected', sharedCredentialsAcknowledged: def.credentialMode === 'shared' ? true : undefined })
          progress('enabling-plugin')
          assertActive()
          await bridge.setConnectorPluginEnabled(def, true)
          assertActive()
          progress('refreshing-sessions')
          assertActive()
          await bridge.reloadConnectorSessions(options.sessionId, def)
          assertActive()
          progress('verifying-runtime')
          assertActive()
          if (!await bridge.isConnectorPluginReady(def)) throw new Error('Connector runtime is not ready')
          assertActive()
          this.patch(id, { enabled: true, runtime: 'ready', status: checked.verification === 'remote' ? 'ready' : 'configured' })
        }
      } else {
        await bridge.setConnectorPluginEnabled(def, false)
        this.patch(id, { enabled: false, runtime: 'missing', status: 'disabled' })
        await bridge.reloadConnectorSessions(options.sessionId)
        assertActive()
        await adapter.deactivate()
        if (action === 'remove') {
          await bridge.removeConnectorPlugin(def)
          const installation = this.persistence.get(id).installation
          if (installation) await adapter.remove(installation)
          this.patch(id, { installed: false, installedVersion: undefined, installation: undefined, sharedCredentialsAcknowledged: false, connection: 'disconnected', status: 'not-installed', accountLabel: undefined, lastCheckedAt: undefined })
        }
      }
    } catch {
      const cancelled = signal.aborted
      // A persistence failure stays a failure even when it also aborted the
      // operation; it is never reported as a user cancellation.
      const persistenceFailed = this.storageFailures.has(id)
      const failedPhase = persistenceFailed ? 'persistence' : this.get(id).operation?.phase ?? action
      // Never surface CLI output here: it can contain tokens or credential material.
      const rollbackNeeded = action === 'prepare' && !!previous.installed && !!previous.installation
      let restored = false
      if (rollbackNeeded) {
        try {
          const oldDefinition = this.installedDefinition(def, previous)
          await bridge.installConnectorPlugin(oldDefinition, previous.installation)
          await bridge.setConnectorPluginEnabled(oldDefinition, previous.enabled ?? false)
          await bridge.reloadConnectorSessions(options.sessionId, previous.enabled ? oldDefinition : undefined)
          restored = true
        } catch { /* failed rollback must remain disabled */ }
      }
      let cleanupFailed = false
      if (!restored) {
        try { await bridge.setConnectorPluginEnabled(def, false); await bridge.reloadConnectorSessions(options.sessionId) } catch { cleanupFailed = true }
      }
      if (cancelled && !restored) { try { await adapter?.deactivate() } catch { cleanupFailed = true } }
      if (cancelled && !persistenceFailed && !cleanupFailed) {
        if (action === 'prepare' && (restored || (!rollbackNeeded && !published))) {
          // Cancelling an upgrade keeps the previous installation and its
          // state, including a previously ready connection. Cancelling a first
          // install that never published anything leaves no failure behind.
          this.patch(id, restored ? { ...previous } : { ...previous, enabled: false, runtime: 'missing', status: previous.installed ? 'disabled' : 'not-installed', connection: previous.installed ? 'needs-auth' : 'disconnected' })
        } else if (action === 'authenticate' || action === 'check') {
          // The user cancelled: no credential evidence exists, so the
          // connector is neutral needs-auth and can be connected again instead
          // of showing a runtime error that only offers a retry check.
          this.patch(id, { connection: 'needs-auth', runtime: 'missing', enabled: false, status: 'needs-auth', verification: undefined, accountLabel: undefined, error: undefined, failedPhase: undefined })
        } else {
          this.patch(id, { enabled: false, runtime: 'error', status: 'error', failedPhase, error: 'Operation cancelled. Check the connector before using it.' })
        }
      } else {
        this.patch(id, { ...(action === 'prepare' ? previous : {}), enabled: restored ? previous.enabled ?? false : false, runtime: 'error', status: 'error', failedPhase,
          error: cancelled ? 'Operation cancelled. Check the connector before using it.' : 'Connector setup failed. Retry or check the connection.' })
      }
    } finally {
      this.patch(id, { operation: undefined })
      this.operations.delete(id)
    }
  }
}

let defaultService: Promise<ConnectorService> | undefined
export function getConnectorService(): Promise<ConnectorService> {
  return defaultService ??= Promise.all([
    import('../../services/connectors/catalog.js'), import('../../services/connectors/cliAdapter.js'), import('../../services/connectors/pluginBridge.js'), import('../../utils/envUtils.js'), import('../../services/connectors/remoteCatalog.js'), import('../../services/connectors/remoteAdapter.js'), import('../../services/connectors/skillCatalog.js'), import('../../services/connectors/skillAdapter.js'),
  ]).then(([catalog, adapter, bridge, { getClaudeConfigHomeDir }, remoteCatalog, remoteAdapter, skillCatalog, skillAdapter]) => new ConnectorService({ definitions: catalog.ALL_CONNECTORS, createAdapter: (definition, root) => {
    const bundle = skillCatalog.getSkillRecipe(definition.id, definition.version)
    if (bundle) return skillAdapter.createSkillBundleAdapter(definition, root, bundle)
    const remote = remoteCatalog.getRemoteRecipe(definition.id)
    return remote ? remoteAdapter.createRemoteConnectorAdapter(definition, root, remote) : adapter.createConnectorAdapter(definition, root)
  }, bridge, root: join(getClaudeConfigHomeDir(), 'connectors') }))
}
