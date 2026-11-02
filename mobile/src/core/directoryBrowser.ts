import { ApiClient, ApiError } from './client'
import { FocusedRequests } from './focusedRequests'

export type DirectoryEntry = { name: string; path: string; isDirectory: true }
export type DirectoryListing = {
  currentPath: string
  parentPath: string
  entries: DirectoryEntry[]
}
export type DirectoryBrowserState = {
  loading: boolean
  listing?: DirectoryListing
  error?: string
}

/** The computer supplies absolute paths, including Windows/UNC parent paths. */
export function directoryBrowseUrl(path?: string) {
  return `/api/filesystem/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`
}

export async function loadDirectories(
  client: ApiClient,
  path: string | undefined,
  signal: AbortSignal
): Promise<DirectoryListing> {
  const result = await client.get<DirectoryListing>(directoryBrowseUrl(path), { signal })
  if (
    !result || typeof result.currentPath !== 'string' || !result.currentPath ||
    typeof result.parentPath !== 'string' || !Array.isArray(result.entries) ||
    result.entries.some(entry => !entry || typeof entry.name !== 'string' || typeof entry.path !== 'string')
  ) throw new Error('电脑返回了无效的目录列表，请重试。')
  return { ...result, entries: result.entries.filter(entry => entry.isDirectory === true) }
}

export function directoryError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return '电脑暂未允许浏览这个目录。请返回上一级或选择其他项目；旧版电脑端请先更新。'
    if (error.status === 404) return '这个目录已不存在，请选择其他目录。'
    if (error.status === 400) return '这个位置不是目录，请重新选择。'
    if (error.status === 500) return '电脑无法读取这个目录，请检查目录权限后重试。'
  }
  return error instanceof Error ? error.message : '目录读取失败，请重试。'
}

/** Only the latest navigation may replace the last successful directory. */
export class DirectoryBrowserController {
  private requests = new FocusedRequests()
  private requestedPath?: string
  state: DirectoryBrowserState = { loading: false }

  constructor(private client: ApiClient, private changed: (state: DirectoryBrowserState) => void) {
    this.requests.focus()
  }

  async open(path?: string) {
    const request = this.requests.begin()
    if (!request) return
    this.requestedPath = path
    this.update({ ...this.state, loading: true, error: undefined })
    try {
      const listing = await loadDirectories(this.client, path, request.signal)
      if (request.isCurrent()) this.update({ loading: false, listing })
    } catch (error) {
      if (request.isCurrent()) this.update({ ...this.state, loading: false, error: directoryError(error) })
    }
  }

  retry() { return this.open(this.requestedPath) }
  dispose() { this.requests.blur() }

  private update(state: DirectoryBrowserState) {
    this.state = state
    this.changed(state)
  }
}
