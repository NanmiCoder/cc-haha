import { api, type ApiRequestOptions } from './client'

type DirEntry = {
  name: string
  path: string
  isDirectory: boolean
  relativePath?: string
}

type BrowseResult = {
  currentPath: string
  parentPath: string
  entries: DirEntry[]
  query?: string
}

export const filesystemApi = {
  browse(path?: string, options?: { includeFiles?: boolean } & ApiRequestOptions) {
    const q = new URLSearchParams()
    if (path) q.set('path', path)
    if (options?.includeFiles) q.set('includeFiles', 'true')
    const qs = q.toString()
    return api.get<BrowseResult>(`/api/filesystem/browse${qs ? `?${qs}` : ''}`, options)
  },

  search(query: string, cwd?: string, options?: ApiRequestOptions) {
    const q = new URLSearchParams({ search: query, maxResults: '200', includeFiles: 'true' })
    if (cwd) q.set('path', cwd)
    return api.get<BrowseResult>(`/api/filesystem/browse?${q}`, options)
  },
}
