import { afterEach, describe, expect, it, vi } from 'vitest'
import { setAuthToken, setBaseUrl } from '../../api/client'
import { streamWorkspaceWatch, type WorkspaceWatchEvent } from './fileWatch'

afterEach(() => {
  vi.unstubAllGlobals()
  setAuthToken(null)
})

describe('authenticated workspace event transport', () => {
  it('parses split UTF-8 chunks, targets the task, and passes bearer authentication', async () => {
    setBaseUrl('http://127.0.0.1:3210')
    setAuthToken('fake-watch-token')
    const bytes = new TextEncoder().encode('data: {"type":"ready"}\n\ndata: {"type":"change","paths":["src/文件.ts"],"directories":["src"]}\n\n')
    const fetchMock = vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3))
        controller.close()
      },
    })))
    vi.stubGlobal('fetch', fetchMock)
    const events: WorkspaceWatchEvent[] = []
    const abort = new AbortController()
    await streamWorkspaceWatch('task-a', ['', 'src'], abort.signal, (event) => events.push(event))

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:3210/api/sessions/task-a/workspace/watch?path=&path=src', expect.objectContaining({
      headers: { Accept: 'text/event-stream', Authorization: 'Bearer fake-watch-token' },
      signal: abort.signal,
    }))
    expect(events).toEqual([{ type: 'ready' }, { type: 'change', paths: ['src/文件.ts'], directories: ['src'] }])
  })

  it('cancels a quiet stream without waiting for another filesystem event', async () => {
    const cancel = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }))))
    const abort = new AbortController()
    const events = vi.fn()
    const listening = streamWorkspaceWatch('task', [''], abort.signal, events)
    await Promise.resolve()
    abort.abort()
    await listening
    expect(cancel).toHaveBeenCalledOnce()
    expect(events).not.toHaveBeenCalled()
  })
})
