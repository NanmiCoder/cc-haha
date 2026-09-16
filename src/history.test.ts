import { afterEach, describe, expect, mock, test } from 'bun:test'
import * as fsPromises from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
let testConfigDir: string | null = null

afterEach(async () => {
  mock.restore()
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  if (testConfigDir) {
    await fsPromises.rm(testConfigDir, { recursive: true, force: true })
    testConfigDir = null
  }
})

describe('prompt history persistence', () => {
  test('reconciles partial and fully committed append failures without duplicates', async () => {
    const configDir = await fsPromises.mkdtemp(
      join(tmpdir(), 'cc-haha-history-test-'),
    )
    testConfigDir = configDir
    process.env.CLAUDE_CONFIG_DIR = configDir

    let appendCalls = 0
    let behaviorCalls = 0
    let behavior:
      | 'partial-then-success'
      | 'full-then-error'
      | 'rollback-fails'
      | 'read-fails'
      | 'unexpected-tail' = 'partial-then-success'
    const realAppendFile = fsPromises.appendFile
    const realReadFile = fsPromises.readFile
    const realTruncate = fsPromises.truncate
    mock.module('fs/promises', () => ({
      ...fsPromises,
      appendFile: async (...args: Parameters<typeof fsPromises.appendFile>) => {
        appendCalls += 1
        behaviorCalls += 1
        if (behavior === 'partial-then-success' && behaviorCalls === 1) {
          const payload = Buffer.from(String(args[1]))
          await realAppendFile(
            args[0],
            payload.subarray(0, Math.floor(payload.length / 2)),
            { mode: 0o600 },
          )
          throw new Error('injected partial append failure')
        }
        if (behavior === 'full-then-error' && behaviorCalls === 1) {
          await realAppendFile(...args)
          throw new Error('injected post-commit append failure')
        }
        if (behavior === 'rollback-fails' && behaviorCalls === 1) {
          const payload = Buffer.from(String(args[1]))
          await realAppendFile(
            args[0],
            payload.subarray(0, Math.floor(payload.length / 2)),
            { mode: 0o600 },
          )
          throw new Error('injected partial append failure')
        }
        if (behavior === 'read-fails' && behaviorCalls === 1) {
          throw new Error('injected append failure before reconciliation read')
        }
        if (behavior === 'unexpected-tail' && behaviorCalls === 1) {
          await realAppendFile(args[0], 'not-a-payload-prefix', {
            mode: 0o600,
          })
          throw new Error('injected append with unexpected tail')
        }
        return realAppendFile(...args)
      },
      readFile: async (...args: Parameters<typeof fsPromises.readFile>) => {
        if (behavior === 'read-fails' && behaviorCalls === 1) {
          throw new Error('injected reconciliation read failure')
        }
        return realReadFile(...args)
      },
      truncate: async (...args: Parameters<typeof fsPromises.truncate>) => {
        if (behavior === 'rollback-fails') {
          throw new Error('injected rollback failure')
        }
        return realTruncate(...args)
      },
    }))

    const history = await import('./history.js')
    history.clearPendingHistoryEntries()
    history.addToHistory('FIRST_SENTINEL_你好😀')

    await waitFor(() => appendCalls === 1)
    const historyPath = join(configDir, 'history.jsonl')
    await waitFor(async () => {
      const contents = await fsPromises
        .readFile(historyPath, 'utf8')
        .catch(() => '')
      // The failed append already contains the sentinel before rollback.
      // Wait for the retry's complete JSONL record, not that transient prefix.
      if (!contents.endsWith('\n')) return false
      try {
        return contents.trimEnd().split('\n').some(line =>
          JSON.parse(line).display === 'FIRST_SENTINEL_你好😀',
        )
      } catch {
        return false
      }
    })

    const contents = await fsPromises.readFile(historyPath, 'utf8')
    expect(contents.match(/FIRST_SENTINEL/g)).toHaveLength(1)

    behavior = 'full-then-error'
    behaviorCalls = 0
    history.addToHistory('SECOND_SENTINEL')
    await waitFor(() => behaviorCalls === 1)
    await Bun.sleep(600)

    const reconciled = await fsPromises.readFile(historyPath, 'utf8')
    expect(reconciled.match(/FIRST_SENTINEL/g)).toHaveLength(1)
    expect(reconciled.match(/SECOND_SENTINEL/g)).toHaveLength(1)
    for (const line of reconciled.trim().split('\n')) {
      expect(() => JSON.parse(line)).not.toThrow()
    }

    const realDateNow = Date.now
    Date.now = () => 1_234_567_890
    behavior = 'partial-then-success'
    behaviorCalls = 1
    try {
      history.addToHistory('SAME_TIME_A')
      history.addToHistory('SAME_TIME_B')
    } finally {
      Date.now = realDateNow
    }
    await waitFor(async () => {
      const current = await fsPromises.readFile(historyPath, 'utf8')
      return (
        current.includes('SAME_TIME_A') && current.includes('SAME_TIME_B')
      )
    })
    history.removeLastFromHistory()
    const visible: string[] = []
    for await (const entry of history.makeHistoryReader()) {
      if (entry.display.startsWith('SAME_TIME_')) {
        visible.push(entry.display)
      }
    }
    expect(visible).toEqual(['SAME_TIME_A'])

    history.clearPendingHistoryEntries()
    behavior = 'rollback-fails'
    behaviorCalls = 0
    history.addToHistory('POISONED_SENTINEL')
    await waitFor(() => behaviorCalls === 1)
    await Bun.sleep(600)
    expect(behaviorCalls).toBe(1)
    const pending: string[] = []
    for await (const entry of history.makeHistoryReader()) {
      if (entry.display === 'POISONED_SENTINEL') {
        pending.push(entry.display)
      }
    }
    expect(pending).toEqual(['POISONED_SENTINEL'])

    history.clearPendingHistoryEntries()
    behavior = 'read-fails'
    behaviorCalls = 0
    history.addToHistory('READ_FAILURE_SENTINEL')
    await waitFor(() => behaviorCalls === 1)
    await Bun.sleep(600)
    expect(behaviorCalls).toBe(1)

    history.clearPendingHistoryEntries()
    behavior = 'unexpected-tail'
    behaviorCalls = 0
    history.addToHistory('UNEXPECTED_TAIL_SENTINEL')
    await waitFor(() => behaviorCalls === 1)
    await Bun.sleep(600)
    expect(behaviorCalls).toBe(1)

    history.clearPendingHistoryEntries()
  })
})

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now()
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`condition not met within ${timeoutMs}ms`)
    }
    await Bun.sleep(10)
  }
}
