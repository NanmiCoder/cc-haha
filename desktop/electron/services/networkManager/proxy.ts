import fs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import http from 'node:http'
import { parseDocument } from 'yaml'
import { proxyBypassCovers, type NetworkProfile, type NetworkSnapshot } from '../../../src/features/network-manager/networkTypes'
import { runNetworkPowerShell, type NetworkRunner } from './powershell'

export const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
export type ProxyUndo = { path: string; beforeRules: unknown; beforeMode: unknown; beforeHash: string; afterHash: string; restoredHash: string; runtimeBeforeMode: string; runtimeAfterMode: 'rule'; runtimeRulesHash: string; afterRuntimeRulesHash?: string; controlPathHash: string }
export type ProxyAdapter = {
  inspect(profile: NetworkProfile): Promise<NetworkSnapshot['proxy']>
  apply(profile: NetworkProfile, expectedHash: string, prepared?: (undo: ProxyUndo) => Promise<void>): Promise<ProxyUndo>
  rollback(profile: NetworkProfile, undo: ProxyUndo): Promise<boolean>
}

export function requestController(base: string, secret: string, route: string, body?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request(base + route, { method: data ? 'PUT' : 'GET', headers: {
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
    } }, res => {
      let text = ''
      res.on('data', chunk => { text += String(chunk); if (text.length > 2_000_000) req.destroy(new Error('PROXY_RESPONSE_LIMIT')) })
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) return reject(new Error('PROXY_AUTH_REQUIRED'))
        if (!res.statusCode || res.statusCode >= 300) return reject(new Error('PROXY_CONTROLLER_UNAVAILABLE'))
        try { resolve(text ? JSON.parse(text) : {}) } catch { reject(new Error('PROXY_RESPONSE_INVALID')) }
      })
    })
    req.setTimeout(3000, () => req.destroy(new Error('PROXY_CONTROLLER_TIMEOUT')))
    req.on('error', () => reject(new Error('PROXY_CONTROLLER_UNAVAILABLE')))
    req.end(data)
  })
}

async function readConfig(filePath: string, runner: NetworkRunner, proxyPort: number) {
  if (!filePath) throw new Error('PROXY_CONFIG_REQUIRED')
  if ((await fs.stat(filePath)).size > 8_000_000) throw new Error('PROXY_CONFIG_LIMIT')
  const text = await fs.readFile(filePath, 'utf8')
  const document = parseDocument(text)
  if (document.errors.length || !document.contents || typeof document.toJS() !== 'object') throw new Error('PROXY_CONFIG_INVALID')
  const running = process.platform === 'win32' ? await runner({ action: 'proxyController', configPath: filePath, proxyPort }) as { controller?: string | null; instanceId?: string; listeningPorts?: number[] } | null : null
  const endpoint = running?.controller ?? document.get('external-controller')
  if (typeof endpoint !== 'string' || !/^(?:127\.0\.0\.1|localhost):[1-9][0-9]{0,4}$/.test(endpoint)) throw new Error('PROXY_LOOPBACK_REQUIRED')
  const port = Number(endpoint.split(':')[1])
  if (port > 65535) throw new Error('PROXY_CONFIG_INVALID')
  if (running?.instanceId && !running.listeningPorts?.includes(port)) throw new Error('PROXY_CONTROLLER_OWNER_MISMATCH')
  const secret = document.get('secret')
  if (secret !== undefined && typeof secret !== 'string') throw new Error('PROXY_CONFIG_INVALID')
  return { document, hash: hash(text), controller: `http://${endpoint}`, secret: (secret ?? '') as string, instanceId: running?.instanceId || undefined }
}

async function atomicWrite(filePath: string, text: string, runner: NetworkRunner, expectedHash: string) {
  const temporary = `${filePath}.${randomUUID()}.tmp`
  try {
    const handle = await fs.open(temporary, 'wx', 0o600)
    await handle.close()
    // Windows ignores POSIX mode. Preserve the source file's actual ACL before replacing it.
    if (process.platform === 'win32') await runner({ action: 'copyAcl', source: filePath, target: temporary })
    await fs.writeFile(temporary, text)
    if (hash(await fs.readFile(filePath, 'utf8')) !== expectedHash) throw new Error('PROXY_CONFIG_CHANGED')
    await fs.rename(temporary, filePath)
  } finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
}

function controlPathHash(runtime: Record<string, any>) {
  return hash({
    tun: runtime.tun ?? { enable: false }, ipv6: runtime.ipv6 ?? false,
    port: runtime.port ?? 0, socksPort: runtime['socks-port'] ?? 0, redirPort: runtime['redir-port'] ?? 0,
    tproxyPort: runtime['tproxy-port'] ?? 0, mixedPort: runtime['mixed-port'] ?? 0,
    allowLan: runtime['allow-lan'] ?? false, bindAddress: runtime['bind-address'] ?? '*',
    interfaceName: runtime['interface-name'] ?? '', routingMark: runtime['routing-mark'] ?? '',
  })
}

/** Contains no client stop/restart, system proxy mutation, subscription or TUN modification. */
export function createProxyAdapter(request = requestController, runner: NetworkRunner = runNetworkPowerShell): ProxyAdapter {
  async function inspect(profile: NetworkProfile): Promise<NetworkSnapshot['proxy']> {
    const config = await readConfig(profile.proxyConfigPath, runner, profile.proxyPort)
    const version = await request(config.controller, config.secret, '/version')
    if (!version || typeof version.version !== 'string') throw new Error('PROXY_CONTROLLER_INCOMPATIBLE')
    const runtime = await request(config.controller, config.secret, '/configs')
    const rules = await request(config.controller, config.secret, '/rules')
    if (Number(runtime['mixed-port'] || runtime.port) !== profile.proxyPort) throw new Error('PROXY_PORT_MISMATCH')
    if (!Array.isArray(rules.rules)) throw new Error('PROXY_CONTROLLER_INCOMPATIBLE')
    const saved = config.document.toJS()
    // PUT /configs reloads the complete file. Reject drift that could alter the current
    // remote-control path; changing mode is safe only when file and runtime agree first.
    const defaults: Record<string, unknown> = { mode: 'rule', port: 0, 'socks-port': 0, 'redir-port': 0, 'tproxy-port': 0, 'mixed-port': 0, 'allow-lan': false, ipv6: false, 'bind-address': '*' }
    for (const [key, fallback] of Object.entries(defaults)) {
      if ((saved[key] ?? fallback) !== (runtime[key] ?? fallback)) throw new Error('PROXY_RUNTIME_CONFIG_MISMATCH')
    }
    if (Boolean(saved.tun?.enable) !== Boolean(runtime.tun?.enable)) throw new Error('PROXY_RUNTIME_CONFIG_MISMATCH')
    // Disabled TUN fields are inert; the controller may normalize stack casing.
    if (saved.tun?.enable && saved.tun && typeof saved.tun === 'object') {
      for (const [key, value] of Object.entries(saved.tun)) {
        const observed = runtime.tun?.[key]
        if (key === 'stack' && typeof value === 'string' && typeof observed === 'string'
          && value.toLowerCase() === observed.toLowerCase()) continue
        if (JSON.stringify(value) !== JSON.stringify(observed)) throw new Error('PROXY_RUNTIME_CONFIG_MISMATCH')
      }
    }
    if ((saved['interface-name'] ?? '') !== (runtime['interface-name'] ?? '')) throw new Error('PROXY_RUNTIME_CONFIG_MISMATCH')
    if ((saved['routing-mark'] ?? 0) !== (runtime['routing-mark'] ?? 0)) throw new Error('PROXY_RUNTIME_CONFIG_MISMATCH')
    // Domain rules do not shadow a literal IPv4 target. A non-DIRECT IP rule
    // or an unknown rule can shadow it, so do not claim coverage beyond one.
    const prefixes: string[] = []
    for (const rule of rules.rules) {
      if (['Domain', 'DomainSuffix', 'DomainKeyword', 'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD'].includes(rule.type)) continue
      if (!['IP-CIDR', 'IPCIDR'].includes(rule.type) || rule.proxy !== 'DIRECT') break
      if (typeof rule.payload === 'string') prefixes.push(rule.payload)
    }
    return { available: true, mode: String(runtime.mode || ''), tunEnabled: Boolean(runtime.tun?.enable), controller: config.controller, bypassPrefixes: prefixes, configHash: config.hash, ...(config.instanceId ? { instanceId: config.instanceId } : {}) }
  }
  return {
    inspect,
    async apply(profile, expectedHash, prepared) {
      const beforeRuntime = await inspect(profile)
      if (beforeRuntime.configHash !== expectedHash) throw new Error('PROXY_CONFIG_CHANGED')
      const config = await readConfig(profile.proxyConfigPath, runner, profile.proxyPort)
      if (config.hash !== expectedHash) throw new Error('PROXY_CONFIG_CHANGED')
      const oldRules = config.document.get('rules')
      const beforeRules = oldRules === undefined ? undefined : JSON.parse(JSON.stringify(oldRules))
      const beforeMode = config.document.get('mode')
      const rules = config.document.toJS().rules
      if (rules !== undefined && (!Array.isArray(rules) || rules.some((rule: unknown) => typeof rule !== 'string'))) throw new Error('PROXY_RULES_INVALID')
      const prefixes = [profile.managementPrefix, ...(profile.containerEnabled ? [profile.containerPrefix] : [])]
      const insertedPrefixes = prefixes.filter(prefix => !proxyBypassCovers(beforeRuntime.bypassPrefixes, prefix))
      const direct = insertedPrefixes.map(prefix => `IP-CIDR,${prefix},DIRECT,no-resolve`)
      const next = [...direct, ...(rules ?? []).filter((rule: string) => !insertedPrefixes.some(prefix => {
        const parts = rule.split(',').map(part => part.trim())
        return parts[0] === 'IP-CIDR' && parts[1] === prefix && parts[2] === 'DIRECT'
      }))]
      config.document.set('rules', next)
      config.document.set('mode', 'rule')
      const text = config.document.toString()
      const restored = parseDocument(text)
      if (beforeRules === undefined) restored.delete('rules')
      else restored.set('rules', beforeRules)
      if (beforeMode === undefined) restored.delete('mode')
      else restored.set('mode', beforeMode)
      const runtimeRules = await request(config.controller, config.secret, '/rules')
      const runtime = await request(config.controller, config.secret, '/configs')
      const undo: ProxyUndo = { path: profile.proxyConfigPath, beforeRules, beforeMode, beforeHash: config.hash, afterHash: hash(text), restoredHash: hash(restored.toString()), runtimeBeforeMode: beforeRuntime.mode, runtimeAfterMode: 'rule', runtimeRulesHash: hash(runtimeRules.rules), controlPathHash: controlPathHash(runtime) }
      await prepared?.(undo)
      // Journaling yields to the event loop; recheck the file and running control path immediately before writing.
      const latest = await inspect(profile)
      if (latest.configHash !== expectedHash) throw new Error('PROXY_CONFIG_CHANGED')
      await atomicWrite(profile.proxyConfigPath, text, runner, expectedHash)
      try {
        await request(config.controller, config.secret, '/configs?force=true', { path: profile.proxyConfigPath })
        const observed = await inspect(profile)
        if (observed.mode !== 'rule' || prefixes.some(prefix => !proxyBypassCovers(observed.bypassPrefixes, prefix))) throw new Error('PROXY_RELOAD_NOT_APPLIED')
        const appliedRules = await request(config.controller, config.secret, '/rules')
        undo.afterRuntimeRulesHash = hash(appliedRules.rules)
      } catch (error) {
        // Return the inverse to the caller even when hot reload fails after the file mutation.
        throw Object.assign(new Error('PROXY_RELOAD_FAILED'), { undo, cause: error })
      }
      return undo
    },
    async rollback(profile, undo) {
      const config = await readConfig(undo.path, runner, profile.proxyPort)
      const alreadyRestored = config.hash === undo.beforeHash || config.hash === undo.restoredHash
      if (!alreadyRestored && config.hash !== undo.afterHash) return false
      const runtime = await request(config.controller, config.secret, '/configs')
      if (undo.controlPathHash && controlPathHash(runtime) !== undo.controlPathHash) return false
      // A completed apply owns the applied runtime state until rollback starts. If the
      // file is still applied, mode/rules drifting even back to their old values means
      // another writer touched runtime state and must be preserved. Once rollback has
      // already restored the file, accept either endpoint so a failed hot reload can
      // be retried safely. Failed applies have no afterRuntimeRulesHash, so their
      // never-confirmed runtime is allowed to be either before or after as well.
      const completedApply = Boolean(undo.afterRuntimeRulesHash)
      const allowedModes = completedApply && !alreadyRestored
        ? [undo.runtimeAfterMode]
        : [undo.runtimeAfterMode, undo.runtimeBeforeMode]
      if (!allowedModes.includes(runtime.mode)) return false
      if (undo.afterRuntimeRulesHash && undo.runtimeRulesHash) {
        const currentRules = await request(config.controller, config.secret, '/rules')
        const currentRulesHash = hash(currentRules.rules)
        const allowedRules = !alreadyRestored
          ? [undo.afterRuntimeRulesHash]
          : [undo.afterRuntimeRulesHash, undo.runtimeRulesHash]
        if (!allowedRules.includes(currentRulesHash)) return false
      }
      if (!alreadyRestored) {
        if (undo.beforeRules === undefined) config.document.delete('rules')
        else config.document.set('rules', undo.beforeRules)
        if (undo.beforeMode === undefined) config.document.delete('mode')
        else config.document.set('mode', undo.beforeMode)
        await atomicWrite(undo.path, config.document.toString(), runner, config.hash)
      }
      await request(config.controller, config.secret, '/configs?force=true', { path: undo.path })
      const restored = await inspect(profile)
      const rules = await request(config.controller, config.secret, '/rules')
      if (restored.mode !== undo.runtimeBeforeMode || hash(rules.rules) !== undo.runtimeRulesHash) throw new Error('PROXY_RESTORE_NOT_APPLIED')
      return true
    },
  }
}
