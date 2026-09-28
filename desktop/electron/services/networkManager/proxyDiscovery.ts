import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { SakuraDiscovery, SakuraInstance } from '../../../src/features/network-manager/networkTypes'
import type { NetworkRunner } from './powershell'

const localPath = (value: string) => value === '' || (value.length <= 2048 && /^[a-z]:[\\/]/i.test(value) && !/[\u0000-\u001f"<>|*?]/.test(value))
const file = z.string().refine(localPath)
const port = z.number().int().min(1).max(65535)
const coreSchema = z.object({
  pid: z.number().int().positive(), startedAt: z.string().max(100),
  executablePath: file, clientExecutable: file, configPath: file,
  controller: z.string().max(100).refine(value => value === '' || /^(127\.0\.0\.1|localhost):[1-9][0-9]{0,4}$/.test(value) && Number(value.split(':')[1]) <= 65535),
  listeningPorts: z.array(port).max(128), configSource: z.enum(['process-argument', 'unresolved']),
  authOverride: z.boolean().optional(),
})
const stateSchema = z.object({ running: z.boolean(), cores: z.array(coreSchema).max(32), issues: z.array(z.string().regex(/^[A-Z][A-Z0-9_]+$/)).max(32) })

export type SakuraFileCheck = (filePath: string) => Promise<boolean>
const readableConfig: SakuraFileCheck = async filePath => {
  try {
    const info = await fs.stat(filePath)
    if (!info.isFile() || info.size > 8_000_000) return false
    const handle = await fs.open(filePath, 'r')
    await handle.close()
    return true
  } catch { return false }
}

/** Display-only discovery. No default-path guess, process launch, YAML write or external probe. */
export async function discoverSakura(proxyPort: number, runner: NetworkRunner, checkFile: SakuraFileCheck = readableConfig): Promise<SakuraDiscovery> {
  if (!port.safeParse(proxyPort).success) throw new Error('INVALID_PROXY_PORT')
  const raw = stateSchema.safeParse(await runner({ action: 'proxyDiscover' }))
  if (!raw.success) throw new Error('SAKURA_DISCOVERY_INVALID')
  const state = raw.data
  const project = (core: z.infer<typeof coreSchema>): SakuraInstance => ({
    pid: core.pid, startedAt: core.startedAt,
    executablePath: core.executablePath, clientExecutable: core.clientExecutable,
    configPath: core.configPath, controller: core.controller,
    listeningPorts: core.listeningPorts, configSource: core.configSource,
  })
  const result: SakuraDiscovery = { status: 'incomplete', running: state.running || state.cores.length > 0,
    checkedAt: new Date().toISOString(), proxyPort, selected: null, candidates: state.cores.map(project), issues: [...state.issues] }
  if (!result.running) { result.status = 'not-running'; return result }
  const owners = state.cores.filter(core => core.listeningPorts.includes(proxyPort))
  if (owners.length !== 1) {
    result.status = owners.length > 1 ? 'ambiguous' : 'incomplete'
    result.issues.push(owners.length > 1 ? 'SAKURA_MULTIPLE_OWNERS' : 'SAKURA_PORT_OWNER_UNCONFIRMED')
    return result
  }
  const core = owners[0]!
  if (!core.startedAt || core.configSource !== 'process-argument' || !/\.ya?ml$/i.test(core.configPath)
    || !/\.exe$/i.test(core.executablePath) || path.win32.basename(core.executablePath).toLowerCase() !== 'com.vortex.helper.exe') {
    result.issues.push('SAKURA_CONFIG_UNCONFIRMED')
    return result
  }
  if (core.authOverride) { result.issues.push('SAKURA_AUTH_OVERRIDE'); return result }
  if (!await checkFile(core.configPath)) { result.issues.push('SAKURA_CONFIG_UNREADABLE'); return result }
  // File checks yield; reject a replaced process/port/config instead of showing stale paths.
  const latest = stateSchema.safeParse(await runner({ action: 'proxyDiscover' }))
  const current = latest.success ? latest.data.cores.filter(item => item.listeningPorts.includes(proxyPort)) : []
  if (current.length !== 1 || current[0]!.authOverride || JSON.stringify(project(current[0]!)) !== JSON.stringify(project(core))) {
    result.issues.push('SAKURA_INSTANCE_CHANGED')
    return result
  }
  result.status = 'detected'
  result.selected = project(core)
  return result
}
