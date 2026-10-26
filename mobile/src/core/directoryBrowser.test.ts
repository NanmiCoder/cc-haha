import { describe, expect, test } from 'bun:test'
import { ApiClient, type FetchAdapter } from './client'
import { DirectoryBrowserController, directoryBrowseUrl, loadDirectories } from './directoryBrowser'

const listing = (path: string) => ({ currentPath: path, parentPath: '/fixture', entries: [] })
const client = (fetch: FetchAdapter) => new ApiClient(
  { id: 'fixture', name: 'Fixture', url: 'http://localhost:3457', auth: 'lan' },
  'fixture-token', { fetch }
)
const response = (body: unknown, status = 200) => ({
  ok: status < 400, status, redirected: false, url: '', text: async () => JSON.stringify(body),
})

describe('computer directory browser', () => {
  test('keeps absolute computer paths intact and never requests files or search', () => {
    for (const path of ['/Users/test/项目 & app', 'C:\\work\\project', '\\\\server\\share\\folder']) {
      const url = new URL(directoryBrowseUrl(path), 'http://fixture')
      expect(url.searchParams.get('path')).toBe(path)
      expect([...url.searchParams.keys()]).toEqual(['path'])
    }
    expect(directoryBrowseUrl()).toBe('/api/filesystem/browse')
  })

  test('uses the server parent path and only displays directory entries', async () => {
    const result = await loadDirectories(client(async () => response({
      currentPath: 'C:\\work', parentPath: 'C:\\', entries: [
        { name: 'app', path: 'C:\\work\\app', isDirectory: true },
        { name: 'secret.txt', path: 'C:\\work\\secret.txt', isDirectory: false },
      ],
    })), 'C:\\work', new AbortController().signal)
    expect(result.parentPath).toBe('C:\\')
    expect(result.entries.map(entry => entry.name)).toEqual(['app'])
  })

  test('late navigation cannot overwrite a newer directory, even if transport ignores abort', async () => {
    const pending: { path: string; resolve: (value: ReturnType<typeof response>) => void }[] = []
    const controller = new DirectoryBrowserController(client(async input => new Promise(resolve => {
      pending.push({ path: new URL(input).searchParams.get('path')!, resolve })
    })), () => {})
    const first = controller.open('/fixture/first')
    const second = controller.open('/fixture/second')
    pending[1]!.resolve(response(listing('/fixture/second')))
    await second
    pending[0]!.resolve(response(listing('/fixture/first')))
    await first
    expect(controller.state.listing?.currentPath).toBe('/fixture/second')
    controller.dispose()
  })

  test('failed navigation preserves the successful directory and retries the failed destination', async () => {
    const paths: string[] = []
    let failed = true
    const controller = new DirectoryBrowserController(client(async input => {
      const path = new URL(input).searchParams.get('path')!
      paths.push(path)
      return path.endsWith('missing') && failed
        ? response({ error: 'not found' }, 404) : response(listing(path))
    }), () => {})
    await controller.open('/fixture/project')
    await controller.open('/fixture/missing')
    expect(controller.state.listing?.currentPath).toBe('/fixture/project')
    expect(controller.state.error).toContain('不存在')
    failed = false
    await controller.retry()
    expect(paths).toEqual(['/fixture/project', '/fixture/missing', '/fixture/missing'])
    expect(controller.state.listing?.currentPath).toBe('/fixture/missing')
    expect(controller.state.error).toBeUndefined()
    controller.dispose()
  })

  test('leaving the picker prevents pending responses from changing its state', async () => {
    let finish!: (value: ReturnType<typeof response>) => void
    let changes = 0
    const controller = new DirectoryBrowserController(client(async () => new Promise(resolve => { finish = resolve })), () => { changes++ })
    const work = controller.open()
    controller.dispose()
    finish(response(listing('/fixture')))
    await work
    expect(changes).toBe(1)
    expect(controller.state.listing).toBeUndefined()
  })

  test('rejects malformed server listings instead of enabling a broken select action', async () => {
    await expect(loadDirectories(client(async () => response({ entries: [] })), undefined, new AbortController().signal))
      .rejects.toThrow('无效的目录列表')
  })
})
