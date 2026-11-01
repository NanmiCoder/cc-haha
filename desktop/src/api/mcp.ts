import { api } from './client'
import type { McpServerRecord, McpReconnectResult, McpToggleResult, McpUpsertPayload, McpProjectSharingSnapshot, McpProjectSharingPayload, McpProjectSharingResult } from '../types/mcp'

export const mcpApi = {
  list: (cwd?: string) => {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
    return api.get<{ servers: McpServerRecord[] }>(`/api/mcp${query}`)
  },

  projectPaths: () => {
    return api.get<{ projectPaths: string[] }>('/api/mcp/project-paths')
  },

  projectSharing: (name: string, projectPaths: string[], sourceCwd?: string, configHashes?: string[]) => {
    const query = new URLSearchParams()
    for (const path of projectPaths) query.append('projectPath', path)
    if (sourceCwd) query.set('sourceCwd', sourceCwd)
    for (const hash of configHashes ?? []) query.append('configHash', hash)
    return api.get<McpProjectSharingSnapshot>(`/api/mcp/${encodeURIComponent(name)}/projects?${query}`)
  },

  saveProjectSharing: (name: string, payload: McpProjectSharingPayload) => {
    return api.put<McpProjectSharingResult>(`/api/mcp/${encodeURIComponent(name)}/projects`, payload)
  },

  status: (name: string, cwd?: string) => {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
    return api.get<{ server: McpServerRecord }>(`/api/mcp/${encodeURIComponent(name)}/status${query}`)
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
    return api.post<McpToggleResult>(
      `/api/mcp/${encodeURIComponent(name)}/toggle`,
      {
        ...(cwd ? { cwd } : {}),
        ...(sessionId ? { sessionId } : {}),
      },
    )
  },

  reconnect: (name: string, cwd?: string, sessionId?: string) => {
    return api.post<McpReconnectResult>(`/api/mcp/${encodeURIComponent(name)}/reconnect`, {
      ...(cwd ? { cwd } : {}),
      ...(sessionId ? { sessionId } : {}),
    })
  },
}
