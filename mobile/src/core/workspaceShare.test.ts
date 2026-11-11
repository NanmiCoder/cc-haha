import { expect, test } from 'bun:test'
import { FocusedRequests } from './focusedRequests'
import { shareFocusedWorkspaceFile } from './workspaceShare'

function deferred<T>() {
  let resolve!: (value: T) => void
  return {
    promise: new Promise<T>((value) => {
      resolve = value
    }),
    resolve: (value: T) => resolve(value),
  }
}
test('leaving and returning while a download ignores abort cannot write or show a stale share sheet', async () => {
  const requests = new FocusedRequests()
  requests.focus()
  const request = requests.begin()!
  const download = deferred<string>()
  const effects: string[] = []
  const completion = shareFocusedWorkspaceFile(request, {
    download: () => download.promise,
    available: async () => true,
    write: (value) => {
      effects.push(value)
      return value
    },
    share: async (uri) => {
      effects.push(uri)
    },
  })
  requests.blur()
  requests.focus()
  download.resolve('old-host-file')
  await completion
  expect(request.signal.aborted).toBe(true)
  expect(effects).toEqual([])
})
test('switching files during the system availability check cancels later native effects', async () => {
  const requests = new FocusedRequests()
  requests.focus()
  const available = deferred<boolean>()
  const effects: string[] = []
  const completion = shareFocusedWorkspaceFile(requests.begin()!, {
    download: async () => 'file A',
    available: () => available.promise,
    write: (value) => {
      effects.push(value)
      return value
    },
    share: async (uri) => {
      effects.push(uri)
    },
  })
  await Promise.resolve()
  requests.begin()
  available.resolve(true)
  await completion
  expect(effects).toEqual([])
  await shareFocusedWorkspaceFile(requests.begin()!, {
    download: async () => 'file B',
    available: async () => true,
    write: (value) => {
      effects.push(value)
      return '/cache/B'
    },
    share: async (uri) => {
      effects.push(uri)
    },
  })
  expect(effects).toEqual(['file B', '/cache/B'])
})
