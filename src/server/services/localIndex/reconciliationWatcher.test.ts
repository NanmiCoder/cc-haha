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
