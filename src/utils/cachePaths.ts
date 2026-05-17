import envPaths from 'env-paths'
import { join } from 'path'
import { getFsImplementation } from './fsOperations.js'
import { djb2Hash } from './hash.js'

// When CLAUDE_CONFIG_DIR is set (portable mode), place cache under it
// so the install is fully self-contained. Otherwise fall back to the
// system default (%LOCALAPPDATA%\claude-cli-nodejs\Cache on Windows).
function getCacheRoot() {
  const claudeConfigDir = (process.env as Record<string, string | undefined>).CLAUDE_CONFIG_DIR
  return claudeConfigDir ? join(claudeConfigDir, 'Cache') : envPaths('claude-cli').cache
}

// Local sanitizePath using djb2Hash — NOT the shared version from
// sessionStoragePortable.ts which uses Bun.hash (wyhash) when available.
// Cache directory names must remain stable across upgrades so existing cache
// data (error logs, MCP logs) is not orphaned.
const MAX_SANITIZED_LENGTH = 200
function sanitizePath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= MAX_SANITIZED_LENGTH) {
    return sanitized
  }
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${Math.abs(djb2Hash(name)).toString(36)}`
}

function getProjectDir(cwd: string): string {
  return sanitizePath(cwd)
}

export const CACHE_PATHS = {
  baseLogs: () => join(getCacheRoot(), getProjectDir(getFsImplementation().cwd())),
  errors: () =>
    join(getCacheRoot(), getProjectDir(getFsImplementation().cwd()), 'errors'),
  messages: () =>
    join(getCacheRoot(), getProjectDir(getFsImplementation().cwd()), 'messages'),
  mcpLogs: (serverName: string) =>
    join(
      getCacheRoot(),
      getProjectDir(getFsImplementation().cwd()),
      // Sanitize server name for Windows compatibility (colons are reserved for drive letters)
      `mcp-logs-${sanitizePath(serverName)}`,
    ),
}
