import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { buildRemotePlugin, createRemoteConnectorBridge, saveRemoteApiKey, type RemoteConnectorRecipe } from './remoteConnector.js'
import type { ConnectorAdapter, ConnectorDefinition, ConnectorInstallation } from './types.js'

export type RemoteAdapterDependencies = {
  createBridge: typeof createRemoteConnectorBridge
  saveApiKey: typeof saveRemoteApiKey
}
const defaultDependencies: RemoteAdapterDependencies = { createBridge: createRemoteConnectorBridge, saveApiKey: saveRemoteApiKey }

export function createRemoteConnectorAdapter(definition: ConnectorDefinition, rootDirectory: string, recipe: RemoteConnectorRecipe, dependencies: RemoteAdapterDependencies = defaultDependencies): ConnectorAdapter {
  // Validate the catalog identity before constructing any paths or touching
  // credentials. Only the application-owned plugin namespace is accepted.
  buildRemotePlugin(recipe)
  if (definition.id !== recipe.id || definition.pluginId !== recipe.pluginId || definition.version !== recipe.version || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(definition.version)) throw new Error('Invalid managed remote connector definition')
  const directory = join(resolve(rootDirectory), 'remote', recipe.id, definition.version)
  const installation: ConnectorInstallation = { directory, command: '', args: [], env: {} }
  const bridge = dependencies.createBridge(recipe)
  function validateInstallation(value: ConnectorInstallation): void {
    if (resolve(value.directory) !== directory || value.command !== '' || value.args.length !== 0 || Object.keys(value.env).length !== 0) throw new Error('Invalid managed remote connector installation')
  }
  return {
    async configure(configuration) {
      if (Object.keys(configuration).some(key => key !== 'apiKey') || Object.values(configuration).some(value => typeof value !== 'string')) throw new Error('Unsupported remote connector configuration field')
      const apiKey = configuration.apiKey?.trim()
      // Blank fields from an edit form retain an existing secret. They never
      // clear credentials or reset a live connection as a side effect.
      if (!apiKey) return
      if (recipe.auth.type !== 'api-key') throw new Error('This connector does not use an API key')
      if (apiKey.length > 8192 || /[\u0000-\u001f\u007f]/.test(apiKey) || apiKey.includes('${')) throw new Error('A valid connector API key is required')
      // The old cache key includes the old resolved credentials; detach it
      // before saving, while the bridge can still resolve that configuration.
      await bridge.deactivate()
      dependencies.saveApiKey(recipe, apiKey)
    },
    async prepare(signal, progress) {
      signal.throwIfAborted()
      progress('preparing-plugin')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      signal.throwIfAborted()
      return { ...installation, args: [], env: {} }
    },
    async authenticate(value, signal, progress) {
      validateInstallation(value)
      signal.throwIfAborted()
      if (!bridge.isConfigured()) throw new Error('Configure the connector API key first')
      await bridge.authenticate(signal, progress)
    },
    async check(value, signal) {
      validateInstallation(value)
      signal.throwIfAborted()
      if (!bridge.isConfigured()) return { authenticated: false, verification: 'remote' }
      return bridge.check(signal)
    },
    async deactivate() { await bridge.deactivate() },
    async remove(value) {
      validateInstallation(value)
      await bridge.removeCredentials()
      // This subtree contains only markers for this connector. Keep all native
      // runtime/accounts trees and every other connector untouched.
      await rm(dirname(directory), { recursive: true, force: true })
    },
  }
}
