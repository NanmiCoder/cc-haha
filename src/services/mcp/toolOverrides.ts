/**
 * User-scope MCP tool override store.
 *
 * Lives at the global config level (`~/.claude.json`'s `disabledMcpTools`),
 * not per-project — the prevailing motivation for hiding a tool from the
 * agent ("I never want this MCP to call `take_screenshot`") is a personal
 * preference, not a project-bound config. Per-project server toggles still
 * live in `MCPProjectConfig.disabledMcpServers` and operate independently
 * (a server-level disable hides every tool on it regardless of this map).
 *
 * The agent loop reads `isMcpToolDisabled` inside `fetchToolsForClient` to
 * filter the list it shows the model. Mutations through `setMcpToolEnabled`
 * invalidate the cached tool list for that server so the next fetch reflects
 * the new state without forcing a reconnect.
 */

import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'

function readMap(): Record<string, string[]> {
  return getGlobalConfig().disabledMcpTools ?? {}
}

/**
 * Returns true if the given MCP tool is currently hidden at the user scope.
 *
 * Cheap to call — just a cached config read and an `Array.includes` —
 * suitable for the per-tool filter inside `fetchToolsForClient`.
 */
export function isMcpToolDisabled(
  serverName: string,
  toolName: string,
): boolean {
  const list = readMap()[serverName]
  return Array.isArray(list) && list.includes(toolName)
}

/**
 * Returns the disabled tool names for a single server, or `[]` if none are
 * disabled. Returned array is fresh — safe to mutate by callers.
 */
export function getDisabledToolsForServer(serverName: string): string[] {
  const list = readMap()[serverName]
  return Array.isArray(list) ? [...list] : []
}

/**
 * Returns the entire disabled-tools map. Useful for the settings UI / API
 * layer when projecting `enabled` flags onto the raw tool catalog.
 */
export function getAllDisabledMcpTools(): Record<string, string[]> {
  const map = readMap()
  // Defensive copy so callers can't mutate cached config state.
  const out: Record<string, string[]> = {}
  for (const [name, list] of Object.entries(map)) {
    if (Array.isArray(list) && list.length > 0) out[name] = [...list]
  }
  return out
}

/**
 * Toggle a single MCP tool on/off at the user scope. Idempotent: turning an
 * already-enabled tool on, or an already-disabled tool off, is a no-op write.
 *
 * Returns the new enabled state so callers can echo it back to the UI without
 * a second config read.
 */
export function setMcpToolEnabled(
  serverName: string,
  toolName: string,
  enabled: boolean,
): boolean {
  saveGlobalConfig((current) => {
    const previous = current.disabledMcpTools ?? {}
    const previousList = Array.isArray(previous[serverName])
      ? previous[serverName]!
      : []

    const isCurrentlyDisabled = previousList.includes(toolName)
    const shouldBeDisabled = !enabled

    if (isCurrentlyDisabled === shouldBeDisabled) {
      // No-op: existing state already matches the request.
      return current
    }

    const nextList = shouldBeDisabled
      ? [...previousList, toolName]
      : previousList.filter((name) => name !== toolName)

    const nextMap: Record<string, string[]> = { ...previous }
    if (nextList.length === 0) {
      delete nextMap[serverName]
    } else {
      nextMap[serverName] = nextList
    }

    return { ...current, disabledMcpTools: nextMap }
  })

  return enabled
}
