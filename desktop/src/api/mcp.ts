import { api } from './client'
import type { MarketplaceCatalog, MarketplaceRemoteSource, McpServerRecord, McpToolsResult, McpToolToggleResult, McpUpsertPayload } from '../types/mcp'

export const mcpApi = {
  list: (cwd?: string) => {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
    return api.get<{ servers: McpServerRecord[] }>(`/api/mcp${query}`)
  },

  projectPaths: () => {
    return api.get<{ projectPaths: string[] }>('/api/mcp/project-paths')
  },

  status: (name: string, cwd?: string) => {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
    return api.get<{ server: McpServerRecord }>(`/api/mcp/${encodeURIComponent(name)}/status${query}`)
  },

  /**
   * List the raw tools advertised by a connected MCP server. The backend handles
   * disabled / unreachable servers by returning an empty `tools` array with the
   * appropriate status — callers should branch on `status` rather than treating
   * a 200 response as guaranteed connection.
   */
  tools: (name: string, cwd?: string) => {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
    return api.get<McpToolsResult>(`/api/mcp/${encodeURIComponent(name)}/tools${query}`)
  },

  /**
   * Toggle a single MCP tool on/off at the user/global scope. Persisted to
   * `~/.claude.json`'s `disabledMcpTools` map and shared across all projects
   * that use the same server name.
   */
  toggleTool: (
    name: string,
    toolName: string,
    enabled: boolean,
    cwd?: string,
  ) => {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
    return api.post<McpToolToggleResult>(
      `/api/mcp/${encodeURIComponent(name)}/tools/${encodeURIComponent(toolName)}/toggle${query}`,
      { enabled },
    )
  },

  marketplace: {
    /** Returns the merged builtin + remote MCP catalog. */
    list: () => api.get<MarketplaceCatalog>('/api/mcp/marketplace'),

    /** Refreshes the named remote sources, or all enabled sources if `sourceIds` is omitted. */
    refresh: (sourceIds?: string[]) =>
      api.post<MarketplaceCatalog>(
        '/api/mcp/marketplace/refresh',
        sourceIds ? { sourceIds } : {},
      ),

    /** Adds a new remote source URL. Server eagerly fetches it so the catalog is non-empty. */
    addSource: (input: { url: string; label?: string; enabled?: boolean }) =>
      api.post<{ source: MarketplaceRemoteSource }>(
        '/api/mcp/marketplace/sources',
        input,
      ),

    /** Removes a remote source by id and drops its cached catalog entries. */
    removeSource: (id: string) =>
      api.delete<{ ok: true }>(
        `/api/mcp/marketplace/sources/${encodeURIComponent(id)}`,
      ),
  },

  create: (name: string, payload: McpUpsertPayload, cwd?: string) => {
    return api.post<{ server: McpServerRecord }>('/api/mcp', {
      name,
      ...payload,
      ...(cwd ? { cwd } : {}),
    })
  },

  update: (name: string, payload: McpUpsertPayload, cwd?: string, previousCwd?: string) => {
    return api.put<{ server: McpServerRecord }>(`/api/mcp/${encodeURIComponent(name)}`, {
      ...payload,
      ...(cwd ? { cwd } : {}),
      ...(previousCwd ? { previousCwd } : {}),
    })
  },

  remove: (name: string, scope: string, cwd?: string) => {
    const query = new URLSearchParams({ scope })
    if (cwd) query.set('cwd', cwd)
    return api.delete<{ ok: true }>(`/api/mcp/${encodeURIComponent(name)}?${query.toString()}`)
  },

  toggle: (name: string, cwd?: string, sessionId?: string) => {
    return api.post<{ server: McpServerRecord }>(
      `/api/mcp/${encodeURIComponent(name)}/toggle`,
      {
        ...(cwd ? { cwd } : {}),
        ...(sessionId ? { sessionId } : {}),
      },
    )
  },

  reconnect: (name: string, cwd?: string) => {
    return api.post<{ server: McpServerRecord }>(`/api/mcp/${encodeURIComponent(name)}/reconnect`, cwd ? { cwd } : {})
  },
}
