import { create } from 'zustand'
import { mcpApi } from '../api/mcp'
import { sessionsApi } from '../api/sessions'
import {
  dedupeMcpProjectPaths,
  getMcpServerIdentityKey,
  isSameMcpServer,
  mcpProjectPathKey,
} from '../lib/mcpIdentity'
import type { McpServerRecord, McpToggleResult, McpUpsertPayload } from '../types/mcp'

type McpStore = {
  servers: McpServerRecord[]
  selectedServer: McpServerRecord | null
  isLoading: boolean
  error: string | null
  fetchServers: (projectPaths?: string[], fallbackCwd?: string) => Promise<void>
  fetchServersForKnownProjects: (currentWorkDir?: string) => Promise<void>
  createServer: (name: string, payload: McpUpsertPayload, cwd?: string) => Promise<McpServerRecord>
  updateServer: (server: McpServerRecord, payload: McpUpsertPayload, cwd?: string) => Promise<McpServerRecord>
  deleteServer: (server: McpServerRecord, cwd?: string) => Promise<void>
  toggleServer: (server: McpServerRecord, cwd?: string, sessionId?: string) => Promise<McpToggleResult>
  reconnectServer: (server: McpServerRecord, cwd?: string) => Promise<McpServerRecord>
  refreshServerStatus: (server: McpServerRecord, cwd?: string) => Promise<McpServerRecord>
  selectServer: (server: McpServerRecord | null) => void
}

/**
 * The full set of project paths whose MCP servers should appear in the list:
 * the active session's cwd, recent session projects, and every path the
 * server knows to hold MCP config (GH #1126). Callers that refresh the whole
 * store must query this set — fetching a single cwd would overwrite the list
 * with a one-project view.
 */
async function collectKnownProjectPaths(currentWorkDir?: string): Promise<string[]> {
  const [recentProjectPaths, configuredMcpProjectPaths] = await Promise.all([
    sessionsApi.getRecentProjects(8)
      .then(({ projects }) => projects.map((project) => project.realPath))
      .catch(() => []),
    mcpApi.projectPaths()
      .then(({ projectPaths }) => projectPaths)
      .catch(() => []),
  ])
  return dedupeMcpProjectPaths([
    currentWorkDir,
    ...recentProjectPaths,
    ...configuredMcpProjectPaths,
  ])
}

function isProjectScoped(server: Pick<McpServerRecord, 'scope'>) {
  return server.scope === 'local' || server.scope === 'project'
}

function attachProjectPath(server: McpServerRecord, cwd?: string) {
  if (!isProjectScoped(server)) {
    return {
      ...server,
      projectPath: undefined,
    }
  }

  return {
    ...server,
    projectPath: server.projectPath ?? cwd,
  }
}

function preserveCurrentContextActivity(
  next: McpServerRecord,
  previous: Pick<McpServerRecord, 'activeInCurrentContext'>,
) {
  return {
    ...next,
    activeInCurrentContext:
      next.activeInCurrentContext ?? previous.activeInCurrentContext,
  }
}

function replaceServer(
  servers: McpServerRecord[],
  previous: Pick<McpServerRecord, 'name' | 'scope' | 'projectPath'>,
  next: McpServerRecord,
  cwd?: string,
) {
  const normalizedNext = attachProjectPath(next, cwd)
  const index = servers.findIndex((item) => isSameMcpServer(item, previous))
  if (index === -1) return [...servers, normalizedNext]

  return servers.map((item, itemIndex) => (
    itemIndex === index
      ? {
          ...normalizedNext,
          activeInCurrentContext:
            normalizedNext.activeInCurrentContext ?? item.activeInCurrentContext,
        }
      : item
  ))
}

let fetchServersRequestId = 0

export const useMcpStore = create<McpStore>((set, get) => ({
  servers: [],
  selectedServer: null,
  isLoading: false,
  error: null,

  fetchServers: async (projectPaths, fallbackCwd) => {
    const requestId = ++fetchServersRequestId
    set({ isLoading: true, error: null })
    try {
      const normalizedPaths = dedupeMcpProjectPaths(projectPaths ?? [])
      const contexts = normalizedPaths.length > 0 ? normalizedPaths : [fallbackCwd].filter(Boolean)
      const activeContextKey = mcpProjectPathKey(fallbackCwd)

      const responses = await Promise.all(
        (contexts.length > 0 ? contexts : [undefined]).map(async (cwd) => {
          const response = await mcpApi.list(cwd)
          return response.servers.map((server) => ({
            ...server,
            projectPath:
              server.scope === 'local' || server.scope === 'project'
                ? server.projectPath ?? cwd
                : undefined,
            activeInCurrentContext:
              activeContextKey.length > 0 && mcpProjectPathKey(cwd) === activeContextKey,
          }))
        }),
      )

      const deduped = new Map<string, McpServerRecord>()
      for (const group of responses) {
        for (const server of group) {
          const key = getMcpServerIdentityKey(server)
          const existing = deduped.get(key)
          if (!existing || server.activeInCurrentContext) {
            deduped.set(key, server)
          } else if (server.activeInCurrentContext !== existing.activeInCurrentContext) {
            deduped.set(key, {
              ...existing,
              activeInCurrentContext:
                existing.activeInCurrentContext || server.activeInCurrentContext,
            })
          }
        }
      }

      if (requestId !== fetchServersRequestId) return
      set({ servers: [...deduped.values()], isLoading: false })
    } catch (error) {
      if (requestId !== fetchServersRequestId) return
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to load MCP servers',
      })
    }
  },

  fetchServersForKnownProjects: async (currentWorkDir) => {
    const projectPaths = await collectKnownProjectPaths(currentWorkDir)
    await get().fetchServers(
      projectPaths.length ? projectPaths : undefined,
      currentWorkDir,
    )
  },

  createServer: async (name, payload, cwd) => {
    const response = await mcpApi.create(name, payload, cwd)
    const created = attachProjectPath(response.server, cwd)
    set((state) => ({
      servers: [...state.servers, created],
      selectedServer: created,
      error: null,
    }))
    return created
  },

  updateServer: async (server, payload, cwd) => {
    const previousCwd = isProjectScoped(server) ? server.projectPath : undefined
    const response = await mcpApi.update(server.name, payload, cwd, previousCwd)
    const updated = preserveCurrentContextActivity(
      attachProjectPath(response.server, cwd ?? server.projectPath),
      server,
    )
    set((state) => ({
      servers: replaceServer(state.servers, server, updated, cwd ?? server.projectPath),
      selectedServer: state.selectedServer && isSameMcpServer(state.selectedServer, server) ? updated : state.selectedServer,
      error: null,
    }))
    return updated
  },

  deleteServer: async (server, cwd) => {
    await mcpApi.remove(server.name, server.scope, cwd)
    set((state) => ({
      servers: state.servers.filter((item) => !isSameMcpServer(item, server)),
      selectedServer:
        state.selectedServer && isSameMcpServer(state.selectedServer, server)
          ? null
          : state.selectedServer,
      error: null,
    }))
  },

  toggleServer: async (server, cwd, sessionId) => {
    const response = await mcpApi.toggle(server.name, cwd, sessionId)
    const updated = preserveCurrentContextActivity(
      attachProjectPath(response.server, cwd ?? server.projectPath),
      server,
    )
    set((state) => ({
      servers: replaceServer(state.servers, server, updated, cwd ?? server.projectPath),
      selectedServer: state.selectedServer && isSameMcpServer(state.selectedServer, server) ? updated : state.selectedServer,
      error: null,
    }))
    return { ...response, server: updated }
  },

  reconnectServer: async (server, cwd) => {
    const response = await mcpApi.reconnect(server.name, cwd)
    const updated = preserveCurrentContextActivity(
      attachProjectPath(response.server, cwd ?? server.projectPath),
      server,
    )
    set((state) => ({
      servers: replaceServer(state.servers, server, updated, cwd ?? server.projectPath),
      selectedServer: state.selectedServer && isSameMcpServer(state.selectedServer, server) ? updated : state.selectedServer,
      error: null,
    }))
    return updated
  },

  refreshServerStatus: async (server, cwd) => {
    const snapshot = get().servers.find((item) => isSameMcpServer(item, server))
    const response = await mcpApi.status(server.name, cwd)
    const current = get().servers.find((item) => isSameMcpServer(item, server))
    // A toggle, edit, or refresh completed while this probe was in flight.
    // Keep its newer state instead of restoring an old enabled connection.
    if (current !== snapshot) return current ?? server
    const updated = preserveCurrentContextActivity(
      attachProjectPath(response.server, cwd ?? server.projectPath),
      server,
    )
    set((state) => ({
      servers: replaceServer(state.servers, server, updated, cwd ?? server.projectPath),
      selectedServer: state.selectedServer && isSameMcpServer(state.selectedServer, server) ? updated : state.selectedServer,
      error: null,
    }))
    return updated
  },

  selectServer: (server) => set({ selectedServer: server }),
}))
