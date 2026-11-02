import type { McpServerRecord } from '@/types/mcp'

function normalizeSeparators(path: string, isWindowsPath: boolean): string {
  const trimmed = isWindowsPath ? path.trim().replaceAll('\\', '/') : path
  const isUnc = trimmed.startsWith('//')
  let normalized = trimmed.replace(/\/{2,}/g, '/')
  if (isUnc && !normalized.startsWith('//')) normalized = `/${normalized}`

  if (normalized.length > 1 && !/^[A-Za-z]:\/$/.test(normalized)) {
    normalized = normalized.replace(/\/+$/, '')
  }

  return normalized
}

/**
 * Stable comparison key for project paths crossing the desktop/server boundary.
 * Windows paths arrive from session history with backslashes and from
 * ~/.claude.json with forward slashes. They refer to the same case-insensitive
 * location and must not create two MCP rows.
 */
export function mcpProjectPathKey(path?: string): string {
  if (!path) return ''
  const windowsCandidate = path.trim().replaceAll('\\', '/')
  const isWindowsPath = /^[A-Za-z]:\//.test(windowsCandidate) || windowsCandidate.startsWith('//')
  // On POSIX a backslash or trailing space can be part of the filename. Do
  // not turn a checkbox for that directory into a second directory's target.
  const normalized = normalizeSeparators(path, isWindowsPath)
  return isWindowsPath ? normalized.toLocaleLowerCase('en-US') : normalized
}

export function dedupeMcpProjectPaths(paths: Array<string | undefined>): string[] {
  const deduped = new Map<string, string>()
  for (const path of paths) {
    if (!path) continue
    const key = mcpProjectPathKey(path)
    if (!deduped.has(key)) deduped.set(key, path)
  }
  return [...deduped.values()]
}

export function getMcpServerIdentityKey(
  server: Pick<McpServerRecord, 'name' | 'scope' | 'projectPath'>,
): string {
  if (server.scope === 'local' || server.scope === 'project') {
    return `${server.scope}:${mcpProjectPathKey(server.projectPath)}:${server.name}`
  }
  return `${server.scope}:${server.name}`
}

export function isSameMcpServer(
  left: Pick<McpServerRecord, 'name' | 'scope' | 'projectPath'>,
  right: Pick<McpServerRecord, 'name' | 'scope' | 'projectPath'>,
): boolean {
  return getMcpServerIdentityKey(left) === getMcpServerIdentityKey(right)
}
