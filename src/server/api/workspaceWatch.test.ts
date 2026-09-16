import { describe, expect, it } from 'bun:test'
import { handleWorkspaceWatchRoute } from './workspaceWatch.js'
import type { WorkspaceWatchChange } from '../services/workspaceService.js'

describe('workspace watch stream', () => {
  it('preserves independent coarse directory ranges and named paths through SSE', async () => {
    const abort = new AbortController()
    const request = new Request('http://localhost/watch?path=&path=src&path=tests', { signal: abort.signal })
    let notify!: (change: WorkspaceWatchChange) => void
    const response = await handleWorkspaceWatchRoute(request, 'task', new URL(request.url), {
      async watchDirectories(_session, _directories, onChange) {
        notify = onChange
        return () => {}
      },
    })
    const reader = response.body!.getReader()
    try {
      await reader.read()
      for (const event of [
        { paths: [], directories: [''] },
        { paths: ['src/a.ts'], directories: ['', 'src'] },
        { paths: ['tests/b.ts'], directories: ['src', 'tests'] },
      ]) {
        notify(event)
        const data = new TextDecoder().decode((await reader.read()).value)
        expect(JSON.parse(data.slice('data: '.length).trim())).toEqual({ type: 'change', ...event })
      }
    } finally {
      abort.abort()
      await reader.cancel()
    }
  })

  it('sends ready after attachment, forwards changes, and closes on request abort', async () => {
    const abort = new AbortController()
    const request = new Request('http://localhost/api/sessions/task/workspace/watch?path=&path=src', { signal: abort.signal })
    let notify!: (change: WorkspaceWatchChange) => void
    let watcherSignal!: AbortSignal
    let stopped = 0
    const response = await handleWorkspaceWatchRoute(request, 'task', new URL(request.url), {
      async watchDirectories(sessionId, directories, onChange, signal) {
        expect(sessionId).toBe('task')
        expect(directories).toEqual(['', 'src'])
        notify = onChange
        watcherSignal = signal
        return () => { stopped += 1 }
      },
    })
    const reader = response.body!.getReader()
    expect(response.headers.get('Content-Type')).toBe('text/event-stream')
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"type":"ready"')
    notify({ paths: ['src/a.ts'], directories: ['src'] })
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('src/a.ts')
    abort.abort()
    expect(watcherSignal.aborted).toBe(true)
    expect(stopped).toBe(1)
    expect((await reader.read()).done).toBe(true)
  })

  it('closes native watches when the response reader is cancelled', async () => {
    const request = new Request('http://localhost/watch?path=')
    let stopped = false
    const response = await handleWorkspaceWatchRoute(request, 'task', new URL(request.url), {
      async watchDirectories() { return () => { stopped = true } },
    })
    await response.body!.cancel()
    expect(stopped).toBe(true)
  })
})
