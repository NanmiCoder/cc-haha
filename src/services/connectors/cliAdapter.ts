import { rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { ConnectorAdapter, ConnectorCheck, ConnectorDefinition, ConnectorId, ConnectorInstallation, ConnectorProgress } from './types.js'
import { defaultRuntimeDependencies, managedInstallation, prepareManagedRuntime, verifyManagedBinary, type ProcessResult, type RuntimeDependencies } from './managedRuntime.js'

const authHosts: Record<ConnectorId, string[]> = {
  feishu: ['accounts.feishu.cn', 'open.feishu.cn', 'accounts.larksuite.com', 'open.larksuite.com', 'passport.feishu.cn', 'accounts.larkoffice.com'],
  dingtalk: ['login.dingtalk.com', 'mcp.dingtalk.com'],
  wecom: ['work.weixin.qq.com'],
}

export function trustedAuthorizationUrl(id: ConnectorId, candidate: string): string | undefined {
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return undefined
    if (!authHosts[id].includes(url.hostname)) return undefined
    return url.toString()
  } catch { return undefined }
}

function jsonOutput(result: ProcessResult): Record<string, unknown> {
  // Lark emits structured failures to stderr, including first-install
  // config/not_configured. A successful command must still provide stdout.
  const streams = result.code === 0 ? [result.stdout] : [result.stdout, result.stderr]
  for (const text of streams) {
    try {
      const value = JSON.parse(text)
      if (value && typeof value === 'object' && !Array.isArray(value)) return value
    } catch { /* Never interpret unstructured or partial output as authenticated. */ }
  }
  throw new Error('Unexpected connector status response')
}

function feishuAccountLabel(data: Record<string, unknown>): string | undefined {
  // Pinned v1.0.95 internal/identitydiag/diagnostics.go emits this exact field.
  // Do not stringify identity objects: they also contain credential metadata.
  const identities = data.identities
  if (!identities || typeof identities !== 'object') return undefined
  const user = (identities as Record<string, unknown>).user
  if (!user || typeof user !== 'object') return undefined
  const name = (user as Record<string, unknown>).userName
  if (typeof name !== 'string') return undefined
  const label = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 160)
  return label || undefined
}

export function parseConnectorCheck(id: ConnectorId, result: ProcessResult): ConnectorCheck {
  if (id === 'wecom') {
    if (result.code !== 0) throw new Error('Unable to check connector authorization')
    const status = result.stdout.trim()
    if (!['authorized', 'unauthorized'].includes(status)) throw new Error('Unexpected connector status response')
    return { authenticated: status === 'authorized', verification: 'local' }
  }
  const data = jsonOutput(result)
  if (id === 'feishu') {
    const error = data.error as Record<string, unknown> | undefined
    if (error?.type === 'config' && error.subtype === 'not_configured') return { authenticated: false, verification: 'local' }
    if (result.code !== 0 || data.ok === false) throw new Error('Unable to check connector authorization')
    const accountLabel = feishuAccountLabel(data)
    return { authenticated: data.identity === 'user' && data.verified === true, verification: 'remote', ...(accountLabel ? { accountLabel } : {}) }
  }
  if (result.code !== 0 || data.success !== true || typeof data.authenticated !== 'boolean') throw new Error('Unable to check connector authorization')
  return { authenticated: data.authenticated, verification: 'local' }
}

export function createConnectorAdapter(definition: ConnectorDefinition, rootDirectory: string, dependencies: RuntimeDependencies = defaultRuntimeDependencies): ConnectorAdapter {
  const expected = () => managedInstallation(definition, rootDirectory, dependencies)
  const assertInstallation = (installation: ConnectorInstallation) => {
    const owned = expected()
    if (resolve(installation.directory) !== owned.directory || resolve(installation.command) !== owned.command) throw new Error('Invalid managed connector installation')
    return owned
  }
  const invoke = async (installation: ConnectorInstallation, args: string[], signal: AbortSignal, progress?: ConnectorProgress) => {
    const owned = assertInstallation(installation)
    signal.throwIfAborted()
    await verifyManagedBinary(definition, owned, dependencies)
    signal.throwIfAborted()
    let buffered = ''
    let previousUrl: string | undefined
    return dependencies.run(owned.command, [...owned.args, ...args], {
      env: owned.env, signal, timeoutMs: progress ? 300_000 : 30_000,
      onOutput: progress ? (text) => {
        buffered = (buffered + text).slice(-8192)
        // Require a terminator so split stdout chunks never publish partial URLs.
        for (const match of buffered.matchAll(/https:\/\/[^\s"<>\\]+(?=[\s"<>\\])/g)) {
          const url = trustedAuthorizationUrl(definition.id, match[0])
          if (url && url !== previousUrl) { previousUrl = url; progress('awaiting-authorization', url) }
        }
      } : undefined,
    })
  }
  const statusArgs = definition.id === 'feishu' ? ['auth', 'status', '--json', '--verify'] : definition.id === 'dingtalk' ? ['auth', 'status', '--format', 'json'] : ['auth', 'show', '--status']
  return {
    prepare: (signal, progress) => prepareManagedRuntime(definition, rootDirectory, signal, progress, dependencies),
    async authenticate(installation, signal, progress) {
      if (definition.id === 'feishu') {
        const status = await invoke(installation, ['auth', 'status', '--json'], signal)
        const data = jsonOutput(status)
        const error = data.error as Record<string, unknown> | undefined
        if (error?.type === 'config' && error.subtype === 'not_configured') {
          progress('configuring-account')
          const setup = await invoke(installation, ['config', 'init', '--new', '--brand', 'feishu'], signal, progress)
          if (setup.code !== 0) throw new Error('Connector application setup did not complete')
        } else if (status.code !== 0 || data.ok === false) throw new Error('Unable to read existing connector configuration')
      }
      progress('authorizing')
      const args = definition.id === 'feishu' ? ['auth', 'login', '--recommend', '--json'] : definition.id === 'dingtalk' ? ['auth', 'login', '--no-browser'] : ['auth', 'init', '--no-browser', '--noninteractive']
      const result = await invoke(installation, args, signal, progress)
      if (result.code !== 0) throw new Error('Connector authorization did not complete')
    },
    async check(installation, signal) { return parseConnectorCheck(definition.id, await invoke(installation, statusArgs, signal)) },
    async deactivate() { /* Plugin/session publication is managed by the service. Never revoke shared credentials here. */ },
    async remove(installation) {
      const owned = assertInstallation(installation)
      // This directory contains only this catalog connector's native versions.
      // Remove older versions and interrupted staging too; never accounts.
      await rm(dirname(owned.directory), { recursive: true, force: true })
      // Account directories intentionally survive removal. Only a separate,
      // explicitly authorized service logout may revoke existing credentials.
    },
  }
}
