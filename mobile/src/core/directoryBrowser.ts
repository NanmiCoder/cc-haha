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
  ) throw new Error('The computer returned an invalid directory listing; please retry.')
  return { ...result, entries: result.entries.filter(entry => entry.isDirectory === true) }
}

export function directoryError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return 'The computer does not allow browsing this directory yet. Go up a level or choose another project; update older desktop versions first.'
    if (error.status === 404) return 'This directory no longer exists; please choose another one.'
    if (error.status === 400) return 'This location is not a directory; please choose again.'
    if (error.status === 500) return 'The computer cannot read this directory; check directory permissions and retry.'
  }
  return error instanceof Error ? error.message : 'Failed to read directory, please retry.'
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
