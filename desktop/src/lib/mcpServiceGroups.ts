import { mcpProjectPathKey } from './mcpIdentity'
import type { McpEditableConfig, McpServerRecord } from '../types/mcp'

export type ProjectServiceGroup = {
  name: string
  copies: McpServerRecord[]
  primary: McpServerRecord
  configConsistent: boolean
  hasAttention: boolean
  hasFailure: boolean
  connectedCount: number
  enabledCount: number
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    )
  }
  return value
}

export function mcpConfigFingerprint(config: McpEditableConfig): string {
  return JSON.stringify(stableValue(config))
}

export function isActiveProjectCopy(
  server: Pick<McpServerRecord, 'projectPath'>,
  currentWorkDir?: string,
): boolean {
  return Boolean(
    currentWorkDir &&
    server.projectPath &&
    mcpProjectPathKey(server.projectPath) === mcpProjectPathKey(currentWorkDir),
  )
}

/** All project copies for one service name, keyed by project path. */
export function getProjectServiceCopies(
  name: string,
  servers: McpServerRecord[],
): McpServerRecord[] {
  const copies = new Map<string, McpServerRecord>()
  for (const server of servers) {
    if (server.scope !== 'project' || server.name !== name || !server.projectPath) continue
    const key = mcpProjectPathKey(server.projectPath)
    if (!copies.has(key)) copies.set(key, server)
  }
  return [...copies.values()]
}

export function sortProjectCopies(
  copies: McpServerRecord[],
  currentWorkDir?: string,
): McpServerRecord[] {
  return [...copies].sort((left, right) => {
    const leftActive = isActiveProjectCopy(left, currentWorkDir)
    const rightActive = isActiveProjectCopy(right, currentWorkDir)
    if (leftActive !== rightActive) return leftActive ? -1 : 1
    return (left.projectPath ?? '').localeCompare(right.projectPath ?? '')
  })
}

export function groupProjectServices(
  servers: McpServerRecord[],
  currentWorkDir?: string,
): ProjectServiceGroup[] {
  const byName = new Map<string, McpServerRecord[]>()
  for (const server of servers) {
    if (server.scope !== 'project' || !server.name) continue
    const copies = byName.get(server.name) ?? []
    copies.push(server)
    byName.set(server.name, copies)
  }

  return [...byName.entries()]
    .map(([name, rawCopies]) => {
      const copies = sortProjectCopies(
        getProjectServiceCopies(name, rawCopies),
        currentWorkDir,
      )
      const fingerprints = new Set(copies.map((copy) => mcpConfigFingerprint(copy.config)))
      const activeCopies = copies.filter((copy) => copy.activeInCurrentContext !== false)
      return {
        name,
        copies,
        primary: copies[0]!,
        configConsistent: fingerprints.size === 1,
        hasAttention: activeCopies.some((copy) => (
          copy.status === 'failed' || copy.status === 'needs-auth'
        )),
        hasFailure: activeCopies.some((copy) => copy.status === 'failed'),
        connectedCount: activeCopies.filter((copy) => copy.status === 'connected').length,
        enabledCount: copies.filter((copy) => copy.enabled).length,
      }
    })
    .filter((group) => group.copies.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name))
}
