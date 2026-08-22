import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createReconciliationWatcher,
  type ReconciliationBatch,
  type ReconciliationWatchHandle,
} from './reconciliationWatcher.js'

const tempDirs: string[] = []

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'cc-haha-reconciliation-watcher-'))
  tempDirs.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true }),
  ))
})

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for watcher')
    await Bun.sleep(5)
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(settle => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('local index reconciliation watcher', () => {
  test('deduplicates exact transcript paths and emits bounded serial batches', async () => {
    const scope = await createTempDir()
    const projectDir = join(scope, 'projects', '-repo')
    await mkdir(projectDir, { recursive: true })
    const batches: ReconciliationBatch[] = []
    let active = 0
    let maxActive = 0
    const watcher = createReconciliationWatcher({
      scope,
      debounceMs: 10,
      maxWaitMs: 40,
      safetySweepMs: 60_000,
      watchDirectory: () => ({ close() {} }),
      onBatch: async batch => {
        active += 1
        maxActive = Math.max(maxActive, active)
        batches.push(batch)
        await Bun.sleep(1)
        active -= 1
      },
    })

    await watcher.start()
    const paths = Array.from({ length: 60 }, (_, index) =>
      join(projectDir, `session-${index}.jsonl`),
    )
    for (const path of paths) {
      watcher.queueTranscriptPath(path)
      watcher.queueTranscriptPath(path)
    }
    await waitFor(() => batches.flatMap(batch => batch.paths).length === paths.length)

    expect(batches.every(batch => batch.paths.length <= 25)).toBe(true)
    expect(new Set(batches.flatMap(batch => batch.paths))).toEqual(new Set(paths))
    expect(batches.every(batch => batch.fullSweep === false)).toBe(true)
    expect(maxActive).toBe(1)
    await watcher.stop()
  })

  test('maps exact project events and coalesces unknown watcher events to one full sweep', async () => {
    const scope = await createTempDir()
    const projectDir = join(scope, 'projects', '-repo')
    await mkdir(projectDir, { recursive: true })
    const listeners = new Map<string, (eventType: string, filename: string | null) => void>()
    const handles: ReconciliationWatchHandle[] = []
    const batches: ReconciliationBatch[] = []
    const watcher = createReconciliationWatcher({
      scope,
      debounceMs: 10,
      maxWaitMs: 40,
      safetySweepMs: 60_000,
      watchDirectory: (directory, listener) => {
        listeners.set(directory, listener)
        const handle = { close() {} }
        handles.push(handle)
        return handle
      },
      onBatch: async batch => {
        batches.push(batch)
      },
    })

    await watcher.start()
    listeners.get(projectDir)?.('change', 'exact.jsonl')
    listeners.get(projectDir)?.('rename', '../escape.jsonl')
    listeners.get(projectDir)?.('change', null)
    listeners.get(projectDir)?.('change', null)
    await waitFor(() => batches.length > 0)

    expect(batches).toEqual([{ paths: [], fullSweep: true }])
    await watcher.stop()
    expect(handles.length).toBeGreaterThan(0)
  })

  test('supports a recursive projection classifier and marks it dirty before debounce', async () => {
    const scope = await createTempDir()
    const projectDir = join(scope, 'projects', '-repo')
    await mkdir(projectDir, { recursive: true })
    const listeners = new Map<string, (eventType: string, filename: string | null) => void>()
    const batches: ReconciliationBatch[] = []
    let dirty = 0
    const watcher = createReconciliationWatcher({
      scope,
      debounceMs: 20,
      maxWaitMs: 40,
      safetySweepMs: 60_000,
      isTargetPath: (candidateScope, candidate) =>
        candidate.startsWith(join(candidateScope, 'projects')) && candidate.endsWith('.jsonl'),
      onDirty: () => {
        dirty += 1
      },
      watchDirectory: (directory, listener) => {
        listeners.set(directory, listener)
        return { close() {} }
      },
      onBatch: async batch => {
        batches.push(batch)
      },
    })

    await watcher.start()
    listeners.get(projectDir)?.(
      'change',
      join('owner-session', 'subagents', 'workflows', 'wf-1', 'agent-1.jsonl'),
    )

    expect(dirty).toBe(1)
    expect(batches).toEqual([])
    await waitFor(() => batches.length === 1)
    expect(batches).toEqual([{
      paths: [join(
        projectDir,
        'owner-session',
        'subagents',
        'workflows',
        'wf-1',
        'agent-1.jsonl',
      )],
      fullSweep: false,
    }])
    await watcher.stop()
  })

  test('collapses overflow and event storms into at most one queued full sweep', async () => {
    const scope = await createTempDir()
    const projectDir = join(scope, 'projects', '-repo')
    await mkdir(projectDir, { recursive: true })
    const batches: ReconciliationBatch[] = []
    const watcher = createReconciliationWatcher({
      scope,
      debounceMs: 10,
      maxWaitMs: 40,
      maxQueuedPaths: 8,
      safetySweepMs: 60_000,
      watchDirectory: () => ({ close() {} }),
      onBatch: async batch => {
        batches.push(batch)
      },
    })
    await watcher.start()

    for (let index = 0; index < 100; index += 1) {
      watcher.queueTranscriptPath(join(projectDir, `${index}.jsonl`))
      watcher.queueFullSweep()
    }
    await waitFor(() => batches.length === 1)

    expect(batches).toEqual([{ paths: [], fullSweep: true }])
    expect(watcher.getMetrics().queuedPaths).toBe(0)
    await watcher.stop()
  })

  test('coalesces repeated debounce snapshots while the first batch is running', async () => {
    const scope = await createTempDir()
    const firstBatch = deferred()
    const batches: ReconciliationBatch[] = []
    const watcher = createReconciliationWatcher({
      scope,
      debounceMs: 5,
      maxWaitMs: 10,
      safetySweepMs: 60_000,
      watchDirectory: () => ({ close() {} }),
      onBatch: async batch => {
        batches.push(batch)
        if (batches.length === 1) await firstBatch.promise
      },
    })
    await watcher.start()

    try {
      watcher.queueFullSweep()
      await waitFor(() => batches.length === 1)
      for (let index = 0; index < 4; index += 1) {
        watcher.queueFullSweep()
        await Bun.sleep(15)
      }

      expect(batches).toHaveLength(1)
      firstBatch.resolve()
      await waitFor(() => batches.length >= 2)
      await Bun.sleep(20)
      expect(batches).toEqual([
        { paths: [], fullSweep: true },
        { paths: [], fullSweep: true },
      ])
    } finally {
      firstBatch.resolve()
      await watcher.stop()
    }
  })

  test('deduplicates every exact path merged into the pending snapshot', async () => {
    const scope = await createTempDir()
    const projectDir = join(scope, 'projects', '-repo')
    await mkdir(projectDir, { recursive: true })
    const firstBatch = deferred()
    const batches: ReconciliationBatch[] = []
    const watcher = createReconciliationWatcher({
      scope,
      debounceMs: 5,
      maxWaitMs: 10,
      safetySweepMs: 60_000,
      watchDirectory: () => ({ close() {} }),
      onBatch: async batch => {
        batches.push(batch)
        if (batches.length === 1) await firstBatch.promise
      },
    })
    await watcher.start()

    try {
      watcher.queueFullSweep()
      await waitFor(() => batches.length === 1)
      const paths = ['alpha.jsonl', 'beta.jsonl', 'gamma.jsonl']
        .map(name => join(projectDir, name))
      watcher.queueTranscriptPath(paths[0]!)
      watcher.queueTranscriptPath(paths[1]!)
      await Bun.sleep(15)
      watcher.queueTranscriptPath(paths[1]!)
      watcher.queueTranscriptPath(paths[2]!)
      await Bun.sleep(15)

      firstBatch.resolve()
      await waitFor(() => batches.length >= 2)
      await Bun.sleep(20)
      expect(batches).toEqual([
        { paths: [], fullSweep: true },
        { paths, fullSweep: false },
      ])
    } finally {
      firstBatch.resolve()
      await watcher.stop()
    }
  })

  test('lets a pending full sweep supersede pending exact paths', async () => {
    const scope = await createTempDir()
    const projectDir = join(scope, 'projects', '-repo')
    await mkdir(projectDir, { recursive: true })
    const firstBatch = deferred()
    const batches: ReconciliationBatch[] = []
    const watcher = createReconciliationWatcher({
      scope,
      debounceMs: 5,
      maxWaitMs: 10,
      safetySweepMs: 60_000,
      watchDirectory: () => ({ close() {} }),
      onBatch: async batch => {
        batches.push(batch)
        if (batches.length === 1) await firstBatch.promise
      },
    })
    await watcher.start()

    try {
      watcher.queueTranscriptPath(join(projectDir, 'initial.jsonl'))
      await waitFor(() => batches.length === 1)
      watcher.queueTranscriptPath(join(projectDir, 'before-sweep.jsonl'))
      await Bun.sleep(15)
      watcher.queueFullSweep()
      await Bun.sleep(15)
      watcher.queueTranscriptPath(join(projectDir, 'after-sweep.jsonl'))
      await Bun.sleep(15)

      firstBatch.resolve()
      await waitFor(() => batches.length >= 2)
      await Bun.sleep(20)
      expect(batches).toEqual([
        { paths: [join(projectDir, 'initial.jsonl')], fullSweep: false },
        { paths: [], fullSweep: true },
      ])
    } finally {
      firstBatch.resolve()
      await watcher.stop()
    }
  })

  test('opens a new pending window for events arriving during the second batch', async () => {
    const scope = await createTempDir()
    const projectDir = join(scope, 'projects', '-repo')
    await mkdir(projectDir, { recursive: true })
    const firstBatch = deferred()
    const secondBatch = deferred()
    const batches: ReconciliationBatch[] = []
    const watcher = createReconciliationWatcher({
      scope,
      debounceMs: 5,
      maxWaitMs: 10,
      safetySweepMs: 60_000,
      watchDirectory: () => ({ close() {} }),
      onBatch: async batch => {
        batches.push(batch)
        if (batches.length === 1) await firstBatch.promise
        if (batches.length === 2) await secondBatch.promise
      },
    })
    await watcher.start()

    try {
      watcher.queueFullSweep()
      await waitFor(() => batches.length === 1)
      const secondPaths = ['second-a.jsonl', 'second-b.jsonl']
        .map(name => join(projectDir, name))
      secondPaths.forEach(path => watcher.queueTranscriptPath(path))
      await Bun.sleep(15)
      firstBatch.resolve()
      await waitFor(() => batches.length === 2)

      const thirdPaths = ['third-a.jsonl', 'third-b.jsonl']
        .map(name => join(projectDir, name))
      watcher.queueTranscriptPath(thirdPaths[0]!)
      await Bun.sleep(15)
      watcher.queueTranscriptPath(thirdPaths[1]!)
      await Bun.sleep(15)
      secondBatch.resolve()
      await waitFor(() => batches.length >= 3)
      await Bun.sleep(20)

      expect(batches).toEqual([
        { paths: [], fullSweep: true },
        { paths: secondPaths, fullSweep: false },
        { paths: thirdPaths, fullSweep: false },
      ])
    } finally {
      firstBatch.resolve()
      secondBatch.resolve()
      await watcher.stop()
    }
  })

  test('drops an already debounced pending snapshot across stop and restart', async () => {
    const scope = await createTempDir()
    const projectDir = join(scope, 'projects', '-repo')
    await mkdir(projectDir, { recursive: true })
    const firstBatch = deferred()
    const batches: ReconciliationBatch[] = []
    const watcher = createReconciliationWatcher({
      scope,
      debounceMs: 5,
      maxWaitMs: 10,
      safetySweepMs: 60_000,
      watchDirectory: () => ({ close() {} }),
      onBatch: async batch => {
        batches.push(batch)
        if (batches.length === 1) await firstBatch.promise
      },
    })
    await watcher.start()

    try {
      watcher.queueFullSweep()
      await waitFor(() => batches.length === 1)
      watcher.queueTranscriptPath(join(projectDir, 'stale.jsonl'))
      await Bun.sleep(15)

      const stopping = watcher.stop()
      firstBatch.resolve()
      await stopping
      await watcher.start()
      await Bun.sleep(20)
      expect(batches).toHaveLength(1)

      watcher.queueTranscriptPath(join(projectDir, 'fresh.jsonl'))
      await waitFor(() => batches.length === 2)
      expect(batches[1]).toEqual({
        paths: [join(projectDir, 'fresh.jsonl')],
        fullSweep: false,
      })
    } finally {
      firstBatch.resolve()
      await watcher.stop()
    }
  })

  test('honors the max-wait deadline during a continuous trailing debounce storm', async () => {
    const scope = await createTempDir()
    const projectDir = join(scope, 'projects', '-repo')
    await mkdir(projectDir, { recursive: true })
    const startedAt = Date.now()
    const observedAt: number[] = []
    const watcher = createReconciliationWatcher({
      scope,
      debounceMs: 30,
      maxWaitMs: 60,
      safetySweepMs: 60_000,
      watchDirectory: () => ({ close() {} }),
      onBatch: async () => {
        observedAt.push(Date.now())
      },
    })
    await watcher.start()
    const storm = setInterval(() => {
      watcher.queueTranscriptPath(join(projectDir, 'storm.jsonl'))
    }, 10)
    try {
      await waitFor(() => observedAt.length > 0)
    } finally {
      clearInterval(storm)
    }

    expect(observedAt[0]! - startedAt).toBeLessThan(100)
    await watcher.stop()
  })

  test('runs a low-frequency safety sweep and clears timers and late batches on stop', async () => {
    const scope = await createTempDir()
    const projectDir = join(scope, 'projects', '-repo')
    await mkdir(projectDir, { recursive: true })
    let releaseFirst!: () => void
    const firstRelease = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    const batches: ReconciliationBatch[] = []
    const watcher = createReconciliationWatcher({
      scope,
      debounceMs: 5,
      maxWaitMs: 20,
      safetySweepMs: 15,
      watchDirectory: () => ({ close() {} }),
      onBatch: async batch => {
        batches.push(batch)
        if (batches.length === 1) {
          await firstRelease
        }
      },
    })
    await watcher.start()
    try {
      await waitFor(() => batches.length > 0)
      watcher.queueTranscriptPath(join(projectDir, 'late.jsonl'))
      const stopping = watcher.stop()
      releaseFirst()
      await stopping
      await Bun.sleep(40)

      expect(batches).toEqual([{ paths: [], fullSweep: true }])
    } finally {
      releaseFirst()
      await watcher.stop()
    }
  })

  test('reports watch failure once per attempt and retries with bounded backoff', async () => {
    const scope = await createTempDir()
    let attempts = 0
    let failures = 0
    let recoveries = 0
    const watcher = createReconciliationWatcher({
      scope,
      debounceMs: 5,
      maxWaitMs: 20,
      safetySweepMs: 60_000,
      watchRetryBaseMs: 10,
      watchRetryMaxMs: 20,
      listWatchDirectories: async () => [scope],
      watchDirectory: () => {
        attempts += 1
        if (attempts === 1) throw new Error('/private/path')
        return { close() {} }
      },
      onWatchFailure: code => {
        expect(code).toBe('LOCAL_INDEX_WATCH_FAILED')
        failures += 1
      },
      onWatchRecovered: () => {
        recoveries += 1
      },
      onBatch: async () => {},
    })

    await watcher.start()
    await waitFor(() => attempts === 2)
    expect(failures).toBe(1)
    expect(recoveries).toBe(1)
    expect(watcher.getMetrics().watchFailures).toBe(1)
    await watcher.stop()
  })
})
