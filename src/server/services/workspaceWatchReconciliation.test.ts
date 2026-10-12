import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { EventEmitter } from 'node:events'
import * as nativeFs from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { WorkspaceService, type WorkspaceWatchChange } from './workspaceService.js'
import { WORKSPACE_WATCH_RECONCILIATION } from './workspaceWatchState.js'

let root: string
let service: WorkspaceService
let abort: AbortController
let watchSpy: ReturnType<typeof spyOn<typeof nativeFs, 'watch'>>
const handles: { close: ReturnType<typeof mock> }[] = []

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-reconcile-')))
  await fs.mkdir(path.join(root, 'src'))
  service = new WorkspaceService(async () => root)
  abort = new AbortController()
  // Simulate an attached native watcher whose callbacks never arrive. Real
  // filesystem writes must still invalidate the client's directory/file cache.
  watchSpy = spyOn(nativeFs, 'watch').mockImplementation((() => {
    const handle = Object.assign(new EventEmitter(), { close: mock(() => {}) })
    handles.push(handle)
    return handle as nativeFs.FSWatcher
  }) as typeof nativeFs.watch)
})

afterEach(async () => {
  abort.abort()
  watchSpy.mockRestore()
  handles.splice(0)
  await fs.rm(root, { recursive: true, force: true })
})

async function until(check: () => boolean) {
  const deadline = Date.now() + 2_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('No reconciliation event without native callbacks')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

function controlledTimers() {
  const nativeSetTimeout = globalThis.setTimeout
  const nativeClearTimeout = globalThis.clearTimeout
  const pending = new Map<ReturnType<typeof setTimeout>, { delay: number; invoke: () => unknown }>()
  let sequence = 0
  const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
    if (delay !== 60 && delay !== WORKSPACE_WATCH_RECONCILIATION.intervalMs) return nativeSetTimeout(callback, delay, ...args)
    const timer = ++sequence as unknown as ReturnType<typeof setTimeout>
    pending.set(timer, { delay, invoke: () => callback(...args) })
    return timer
  })
  const clearSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(timer => {
    if (!pending.delete(timer as ReturnType<typeof setTimeout>)) nativeClearTimeout(timer)
  })
  return {
    pending,
    async flush(delay: number) {
      for (const [timer, task] of [...pending]) {
        if (task.delay !== delay) continue
        pending.delete(timer)
        await task.invoke()
      }
    },
    restore() {
      timerSpy.mockRestore()
      clearSpy.mockRestore()
    },
  }
}

describe('workspace watch reconciliation without native callbacks', () => {
  it('detects an existing file content change, create, rename and delete', async () => {
    await fs.writeFile(path.join(root, 'src/a.ts'), 'before')
    const events: WorkspaceWatchChange[] = []
    await service.watchDirectories('task', ['src'], event => events.push(event), abort.signal)
    const saw = (name: string) => events.some(event => event.paths.includes(`src/${name}`))
    await fs.writeFile(path.join(root, 'src/a.ts'), 'after!')
    await until(() => saw('a.ts'))
    events.length = 0
    await fs.writeFile(path.join(root, 'src/b.ts'), 'created')
    await until(() => saw('b.ts'))
    events.length = 0
    await fs.rename(path.join(root, 'src/b.ts'), path.join(root, 'src/c.ts'))
    await until(() => saw('b.ts') && saw('c.ts'))
    events.length = 0
    await fs.unlink(path.join(root, 'src/c.ts'))
    await until(() => saw('c.ts'))
    expect(events.every(event => event.directories.includes('src'))).toBe(true)
  })

  it('detects restored ancestors and then changes in a reattached descendant', async () => {
    await fs.rm(path.join(root, 'src'), { recursive: true })
    const events: WorkspaceWatchChange[] = []
    let stop = await service.watchDirectories('task', ['src/nested'], event => events.push(event), abort.signal)
    await fs.mkdir(path.join(root, 'src'))
    await until(() => events.some(event => event.paths.includes('src')))
    stop()
    events.length = 0
    stop = await service.watchDirectories('task', ['src/nested'], event => events.push(event), abort.signal)
    await fs.mkdir(path.join(root, 'src/nested'))
    await until(() => events.some(event => event.paths.includes('src/nested')))
    stop()
    events.length = 0
    await service.watchDirectories('task', ['src/nested'], event => events.push(event), abort.signal)
    await fs.writeFile(path.join(root, 'src/nested/restored.ts'), 'restored')
    await until(() => events.some(event => event.paths.includes('src/nested/restored.ts')))
  })

  it('names a vanished watch target so it can reattach to live ancestors and recover without user interaction', async () => {
    await fs.mkdir(path.join(root, 'src/nested'))
    await fs.writeFile(path.join(root, 'src/nested/restore.txt'), 'before')
    const events: WorkspaceWatchChange[] = []
    let stop = await service.watchDirectories('task', ['src/nested'], event => events.push(event), abort.signal)
    await fs.rm(path.join(root, 'src'), { recursive: true })
    await until(() => events.some(event => event.paths.includes('src/nested')))
    stop()
    events.length = 0
    stop = await service.watchDirectories('task', ['src/nested'], event => events.push(event), abort.signal)
    await fs.mkdir(path.join(root, 'src'))
    await until(() => events.some(event => event.paths.includes('src')))
    stop()
    events.length = 0
    stop = await service.watchDirectories('task', ['src/nested'], event => events.push(event), abort.signal)
    await fs.mkdir(path.join(root, 'src/nested'))
    await until(() => events.some(event => event.paths.includes('src/nested')))
    stop()
    events.length = 0
    await service.watchDirectories('task', ['src/nested'], event => events.push(event), abort.signal)
    await fs.writeFile(path.join(root, 'src/nested/restore.txt'), 'after')
    await until(() => events.some(event => event.paths.includes('src/nested/restore.txt')))
    expect((await service.readFile('task', 'src/nested/restore.txt')).content).toBe('after')
  })

  it('recovers the final named path and content from rapid write/write/rename without native callbacks', async () => {
    const events: WorkspaceWatchChange[] = []
    await service.watchDirectories('task', ['src'], event => events.push(event), abort.signal)
    await fs.writeFile(path.join(root, 'src/transient.ts'), 'one')
    await fs.writeFile(path.join(root, 'src/transient.ts'), 'two')
    await fs.rename(path.join(root, 'src/transient.ts'), path.join(root, 'src/final.ts'))
    await until(() => events.some(event => event.paths.includes('src/final.ts')))
    expect(events.every(event => event.directories.includes('src'))).toBe(true)
    expect((await service.readFile('task', 'src/final.ts')).content).toBe('two')
  })

  it('round robins at most four directories per tick with only one scheduled scan', async () => {
    const names = Array.from({ length: 9 }, (_, index) => `dir-${index}`)
    await Promise.all(names.map(name => fs.mkdir(path.join(root, name))))
    const timers = controlledTimers()
    const openSpy = spyOn(fs, 'opendir')
    try {
      const stop = await service.watchDirectories('task', names, () => {}, abort.signal)
      openSpy.mockClear()
      expect(timers.pending.size).toBe(1)
      for (let tick = 0; tick < 3; tick++) {
        await timers.flush(WORKSPACE_WATCH_RECONCILIATION.intervalMs)
        expect(openSpy.mock.calls.length).toBe((tick + 1) * 4)
        expect(timers.pending.size).toBe(1)
      }
      expect(new Set(openSpy.mock.calls.map(([directory]) => path.basename(String(directory))))).toEqual(new Set(names))
      stop()
      expect(timers.pending.size).toBe(0)
      expect(handles.every(handle => handle.close.mock.calls.length === 1)).toBe(true)
    } finally {
      abort.abort()
      openSpy.mockRestore()
      timers.restore()
    }
  })

  it('revalidates symlink replacements and stops all resources before reporting an error', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-outside-'))
    const timers = controlledTimers()
    const errors: Error[] = []
    const events: WorkspaceWatchChange[] = []
    try {
      await service.watchDirectories('task', ['src'], event => events.push(event), abort.signal, error => errors.push(error))
      await fs.rm(path.join(root, 'src'), { recursive: true })
      await fs.symlink(outside, path.join(root, 'src'))
      await fs.writeFile(path.join(outside, 'secret.txt'), 'outside')
      await timers.flush(WORKSPACE_WATCH_RECONCILIATION.intervalMs)
      expect(errors.length).toBe(1)
      expect(errors[0]!.message).toContain('outside workspace')
      expect(events).toEqual([])
      expect(timers.pending.size).toBe(0)
      expect(handles.every(handle => handle.close.mock.calls.length === 1)).toBe(true)
    } finally {
      abort.abort()
      timers.restore()
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('rejects a directory swapped to an outside symlink during open before reading entries', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-open-outside-'))
    const timers = controlledTimers()
    const errors: Error[] = []
    const events: WorkspaceWatchChange[] = []
    let openSpy: ReturnType<typeof spyOn<typeof fs, 'opendir'>> | undefined
    try {
      await service.watchDirectories('task', ['src'], event => events.push(event), abort.signal, error => errors.push(error))
      const nativeOpen = fs.opendir
      const handle = await nativeOpen(outside)
      const read = spyOn(handle, 'read')
      const close = spyOn(handle, 'close')
      openSpy = spyOn(fs, 'opendir').mockImplementation((async () => {
        await fs.rm(path.join(root, 'src'), { recursive: true })
        await fs.symlink(outside, path.join(root, 'src'))
        return handle
      }) as typeof fs.opendir)
      await timers.flush(WORKSPACE_WATCH_RECONCILIATION.intervalMs)
      expect(errors).toHaveLength(1)
      expect(errors[0]!.message).toContain('changed while opening')
      expect(read).not.toHaveBeenCalled()
      expect(close).toHaveBeenCalledTimes(1)
      expect(events).toEqual([])
      expect(timers.pending.size).toBe(0)
    } finally {
      abort.abort()
      openSpy?.mockRestore()
      timers.restore()
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('cancels an in-flight scan without emitting or rescheduling, and closes its directory', async () => {
    const timers = controlledTimers()
    const events: WorkspaceWatchChange[] = []
    let openSpy: ReturnType<typeof spyOn<typeof fs, 'opendir'>> | undefined
    try {
      await service.watchDirectories('task', ['src'], event => events.push(event), abort.signal)
      await fs.writeFile(path.join(root, 'src/late.ts'), 'late')
      const open = fs.opendir
      const handle = await open(path.join(root, 'src'))
      const close = spyOn(handle, 'close')
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      let started!: () => void
      const entered = new Promise<void>(resolve => { started = resolve })
      openSpy = spyOn(fs, 'opendir').mockImplementation((async () => {
        started()
        await gate
        return handle
      }) as typeof fs.opendir)
      const flush = timers.flush(WORKSPACE_WATCH_RECONCILIATION.intervalMs)
      await entered
      expect(timers.pending.size).toBe(0)
      abort.abort()
      release()
      await flush
      expect(close).toHaveBeenCalledTimes(1)
      expect(events).toEqual([])
      expect(timers.pending.size).toBe(0)
      expect(handles.every(watcher => watcher.close.mock.calls.length === 1)).toBe(true)
    } finally {
      abort.abort()
      openSpy?.mockRestore()
      timers.restore()
    }
  })

  it('ignores VCS internals and unopened descendants but detects the subscribed directory disappearing', async () => {
    const timers = controlledTimers()
    await fs.mkdir(path.join(root, 'src/nested'))
    await fs.mkdir(path.join(root, 'src/.git'))
    const events: WorkspaceWatchChange[] = []
    try {
      await service.watchDirectories('task', ['src'], event => events.push(event), abort.signal)
      await fs.writeFile(path.join(root, 'src/nested/deep.ts'), 'deep')
      await fs.writeFile(path.join(root, 'src/.git/index'), 'ignored')
      await timers.flush(WORKSPACE_WATCH_RECONCILIATION.intervalMs)
      await timers.flush(60)
      expect(events.flatMap(event => event.paths)).not.toContain('src/nested/deep.ts')
      expect(events.flatMap(event => event.paths).some(name => name.includes('.git'))).toBe(false)
      events.length = 0
      await fs.rm(path.join(root, 'src'), { recursive: true })
      await timers.flush(WORKSPACE_WATCH_RECONCILIATION.intervalMs)
      await timers.flush(60)
      expect(events).toHaveLength(1)
      expect(events[0]!.directories).toEqual(['src'])
    } finally {
      abort.abort()
      timers.restore()
    }
  })

  it('keeps a stable large root with a loaded child idle across ready and resubscriptions, and detects content beyond the first chunk', async () => {
    const names = Array.from({ length: 513 }, (_, index) => `${index}.fixture`)
    await Promise.all(names.map(name => fs.writeFile(path.join(root, name), 'unchanged')))
    const timers = controlledTimers()
    const events: WorkspaceWatchChange[] = []
    const statSpy = spyOn(fs, 'lstat')
    try {
      let stop = await service.watchDirectories('task', ['', 'src'], event => events.push(event), abort.signal)
      const fileCalls = statSpy.mock.calls.map(([file]) => path.basename(String(file))).filter(name => name.endsWith('.fixture'))
      const initialChunk = new Set(fileCalls.slice(names.length))
      expect(initialChunk.size).toBeLessThanOrEqual(WORKSPACE_WATCH_RECONCILIATION.entriesPerDirectory)
      expect(initialChunk.size).toBeGreaterThan(0)
      const beyondChunk = names.find(name => !initialChunk.has(name))!
      for (let tick = 0; tick < 8; tick++) {
        await timers.flush(WORKSPACE_WATCH_RECONCILIATION.intervalMs)
        await timers.flush(60)
        expect(events).toEqual([])
        expect(timers.pending.size).toBe(1)
      }
      // Changing content does not change the parent directory mtime. The
      // complete digest must find an entry excluded from the first chunk.
      await fs.writeFile(path.join(root, beyondChunk), 'changed!!')
      for (let tick = 0; tick < 3; tick++) {
        await timers.flush(WORKSPACE_WATCH_RECONCILIATION.intervalMs)
        await timers.flush(60)
      }
      expect(events).toEqual([{ paths: [], directories: [''] }])
      events.length = 0
      stop()
      expect(timers.pending.size).toBe(0)
      // Model the UI aborting and reattaching its loaded child after a coarse
      // root change. A stable baseline cannot trigger a subscription loop.
      for (let attachment = 0; attachment < 3; attachment++) {
        stop = await service.watchDirectories('task', ['', 'src'], event => events.push(event), abort.signal)
        for (let tick = 0; tick < 3; tick++) {
          await timers.flush(WORKSPACE_WATCH_RECONCILIATION.intervalMs)
          await timers.flush(60)
        }
        expect(events).toEqual([])
        expect(timers.pending.size).toBe(1)
        stop()
        expect(timers.pending.size).toBe(0)
      }
      expect(handles.every(handle => handle.close.mock.calls.length === 1)).toBe(true)
    } finally {
      abort.abort()
      statSpy.mockRestore()
      timers.restore()
    }
  })
})
