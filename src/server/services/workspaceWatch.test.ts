import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as nativeFs from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { WorkspaceService, type WorkspaceWatchChange } from './workspaceService.js'

let root: string
let service: WorkspaceService
const controllers: AbortController[] = []

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-watch-'))
  await fs.mkdir(path.join(root, 'src'))
  service = new WorkspaceService(async () => root)
})

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort()
  await fs.rm(root, { recursive: true, force: true })
})

function controller() {
  const value = new AbortController()
  controllers.push(value)
  return value
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 2_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for filesystem event')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** Keep real validated directories/handles, but drive native events and the 60ms flush exactly. */
function controlledWatchCallbacks(canonicalRoot: string) {
  type Listener = (event: string, filename: string | Buffer | null) => void
  const listeners = new Map<string, Listener>()
  const nativeWatch = nativeFs.watch
  const nativeSetTimeout = globalThis.setTimeout
  const nativeClearTimeout = globalThis.clearTimeout
  const pending = new Map<ReturnType<typeof setTimeout>, () => void>()
  const closeSpies: ReturnType<typeof spyOn<nativeFs.FSWatcher, 'close'>>[] = []
  let sequence = 0
  const watchSpy = spyOn(nativeFs, 'watch').mockImplementation(((filename, options, listener) => {
    const watcher = nativeWatch(filename, options, listener)
    listeners.set(path.relative(canonicalRoot, String(filename)).replace(/\\/g, '/'), listener as Listener)
    closeSpies.push(spyOn(watcher, 'close'))
    return watcher
  }) as typeof nativeFs.watch)
  const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
    if (delay !== 60) return nativeSetTimeout(callback, delay, ...args)
    const timer = ++sequence as unknown as ReturnType<typeof setTimeout>
    pending.set(timer, () => callback(...args))
    return timer
  })
  const clearSpy = spyOn(globalThis, 'clearTimeout').mockImplementation((timer) => {
    if (!pending.delete(timer as ReturnType<typeof setTimeout>)) nativeClearTimeout(timer)
  })
  return {
    pending,
    closeSpies,
    emit(directory: string, filename: string | Buffer | null) {
      const listener = listeners.get(directory)
      if (!listener) throw new Error(`No registered watcher for ${directory}`)
      listener('rename', filename)
    },
    flush() {
      const callbacks = [...pending.values()]
      pending.clear()
      for (const callback of callbacks) callback()
    },
    restore() {
      watchSpy.mockRestore()
      timerSpy.mockRestore()
      clearSpy.mockRestore()
      for (const close of closeSpies) close.mockRestore()
    },
  }
}

describe('workspace watch coalescing contract', () => {
  it.each(['named-first', 'coarse-first'] as const)('retains same-directory coarse and named changes in one flush (%s)', async (order) => {
    const control = controlledWatchCallbacks(await fs.realpath(root))
    const events: WorkspaceWatchChange[] = []
    const abort = controller()
    try {
      await service.watchDirectories('task', ['src'], event => events.push(event), abort.signal)
      for (const filename of order === 'named-first' ? ['a.ts', null] : [null, 'a.ts']) control.emit('src', filename)
      control.emit('src', Buffer.from('a.ts'))
      expect(control.pending.size).toBe(1)
      expect(events).toEqual([])
      control.flush()
      expect(events).toEqual([{ paths: ['src/a.ts'], directories: ['src'] }])
    } finally {
      abort.abort()
      control.restore()
    }
  })

  it('retains a coarse directory when a different directory supplies the named path, then clears both sets', async () => {
    await fs.mkdir(path.join(root, 'tests'))
    const control = controlledWatchCallbacks(await fs.realpath(root))
    const events: WorkspaceWatchChange[] = []
    const abort = controller()
    try {
      await service.watchDirectories('task', ['src', 'tests'], event => events.push(event), abort.signal)
      control.emit('src', null)
      control.emit('tests', 'b.ts')
      control.flush()
      expect(events).toEqual([{ paths: ['tests/b.ts'], directories: ['src', 'tests'] }])
      control.emit('tests', null)
      control.flush()
      expect(events[1]).toEqual({ paths: [], directories: ['tests'] })
    } finally {
      abort.abort()
      control.restore()
    }
  })

  it('preserves the empty root directory in coarse-only and mixed notifications', async () => {
    const control = controlledWatchCallbacks(await fs.realpath(root))
    const events: WorkspaceWatchChange[] = []
    const abort = controller()
    try {
      await service.watchDirectories('task', ['', 'src'], event => events.push(event), abort.signal)
      control.emit('', null)
      control.flush()
      expect(events[0]).toEqual({ paths: [], directories: [''] })
      control.emit('', null)
      control.emit('src', 'a.ts')
      control.emit('', 'README.md')
      control.flush()
      expect(events[1]).toEqual({ paths: ['src/a.ts', 'README.md'], directories: ['', 'src'] })
    } finally {
      abort.abort()
      control.restore()
    }
  })

  it('cancels the pending mixed batch and ignores already queued callbacks after abort', async () => {
    const control = controlledWatchCallbacks(await fs.realpath(root))
    const events: WorkspaceWatchChange[] = []
    const abort = controller()
    try {
      await service.watchDirectories('task', ['', 'src'], event => events.push(event), abort.signal)
      control.emit('', null)
      control.emit('src', 'a.ts')
      const queuedFlush = [...control.pending.values()][0]!
      abort.abort()
      expect(control.pending.size).toBe(0)
      expect(control.closeSpies).toHaveLength(2)
      for (const close of control.closeSpies) expect(close).toHaveBeenCalledTimes(1)
      queuedFlush()
      control.emit('', null)
      control.emit('src', 'late.ts')
      control.flush()
      expect(control.pending.size).toBe(0)
      expect(events).toEqual([])
    } finally {
      abort.abort()
      control.restore()
    }
  })
})

describe('bounded workspace watches', () => {
  it('reports each restored ancestor so a missing multilevel target can be reattached and read again', async () => {
    await fs.mkdir(path.join(root, 'src/nested'))
    const filePath = path.join(root, 'src/nested/a.ts')
    await fs.writeFile(filePath, 'before')
    expect(await service.readFile('task', filePath)).toMatchObject({ path: 'src/nested/a.ts', content: 'before' })
    const events: WorkspaceWatchChange[] = []
    const abort = controller()
    let stop = await service.watchDirectories('task', ['', 'src/nested'], (event) => events.push(event), abort.signal)
    try {
      await fs.rm(path.join(root, 'src'), { recursive: true })
      await until(() => events.some((event) => event.paths.includes('src')))
      stop()
      events.length = 0
      stop = await service.watchDirectories('task', ['', 'src/nested'], (event) => events.push(event), abort.signal)
      await fs.mkdir(path.join(root, 'src'))
      await until(() => events.some((event) => event.paths.includes('src')))
      stop()
      events.length = 0
      stop = await service.watchDirectories('task', ['', 'src/nested'], (event) => events.push(event), abort.signal)
      await fs.mkdir(path.join(root, 'src/nested'))
      await until(() => events.some((event) => event.paths.includes('src/nested')))
      stop()
      events.length = 0
      stop = await service.watchDirectories('task', ['', path.join(root, 'src/nested')], (event) => events.push(event), abort.signal)
      await fs.writeFile(filePath, 'after')
      await until(() => events.some((event) => event.paths.includes('src/nested/a.ts')))
      expect(events.some((event) => event.directories.includes('src/nested'))).toBe(true)
      expect(await service.readFile('task', filePath)).toMatchObject({ path: 'src/nested/a.ts', content: 'after' })
    } finally {
      stop()
    }
  })

  it('coalesces real writes and renames in subscribed directories and cancels cleanly', async () => {
    const events: WorkspaceWatchChange[] = []
    const abort = controller()
    await service.watchDirectories('task', ['src'], (event) => events.push(event), abort.signal)
    await fs.writeFile(path.join(root, 'src/a.ts'), 'one')
    await fs.writeFile(path.join(root, 'src/a.ts'), 'two')
    await fs.rename(path.join(root, 'src/a.ts'), path.join(root, 'src/b.ts'))
    await until(() => events.some((event) => event.paths.includes('src/b.ts')))
    expect(events.flatMap((event) => event.paths)).toContain('src/a.ts')
    expect(events.every((event) => new Set(event.paths).size === event.paths.length)).toBe(true)
    expect(events.every((event) => event.directories.includes('src'))).toBe(true)

    abort.abort()
    const count = events.length
    await fs.writeFile(path.join(root, 'src/after-close.ts'), 'closed')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(events).toHaveLength(count)
  })

  it('does not recursively watch unopened descendants', async () => {
    await fs.mkdir(path.join(root, 'src/nested'))
    const events: WorkspaceWatchChange[] = []
    await service.watchDirectories('task', [''], (event) => events.push(event), controller().signal)
    await fs.writeFile(path.join(root, 'src/nested/a.ts'), 'nested')
    await new Promise((resolve) => setTimeout(resolve, 100))
    // macOS may report that the immediate child directory changed, even for
    // a deeper write. The subscription must not enumerate the nested file.
    expect(events.flatMap((event) => event.paths)).not.toContain('src/nested/a.ts')
    expect(events.flatMap((event) => event.directories).every((directory) => directory === '')).toBe(true)
  })

  it('rejects out-of-root and symlink escapes before registering any watch', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-watch-outside-'))
    try {
      await fs.symlink(outside, path.join(root, 'escape'))
      for (const requested of ['../outside', 'escape']) {
        await expect(service.watchDirectories('task', ['', requested], () => {}, controller().signal))
          .rejects.toThrow(/outside workspace/i)
      }
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('limits directories and stops a cancelled setup before attaching resources', async () => {
    await expect(service.watchDirectories('task', Array.from({ length: 65 }, (_, i) => `dir-${i}`), () => {}, controller().signal))
      .rejects.toThrow(/64/)
    const aborted = controller()
    aborted.abort()
    await expect(service.watchDirectories('task', ['src'], () => {}, aborted.signal)).rejects.toThrow()
  })
})
