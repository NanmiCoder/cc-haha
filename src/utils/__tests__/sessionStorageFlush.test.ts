import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  enqueueSessionEntryAfterPendingForTesting,
  flushSessionStorage,
  resetProjectForTesting,
} from '../sessionStorage.js'
import type { CustomTitleMessage } from '../../types/logs.js'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

async function createTmpDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `session-storage-flush-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  await fs.mkdir(dir, { recursive: true })
  return dir
}

describe('sessionStorage flush', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    resetProjectForTesting()
  })

  afterEach(async () => {
    resetProjectForTesting()
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it('drains writes that are queued by pending operations during flush', async () => {
    const transcriptPath = path.join(tmpDir, 'late-enqueue.jsonl')
    const entry: CustomTitleMessage = {
      type: 'custom-title',
      customTitle: 'late enqueue',
      sessionId: '11111111-1111-4111-8111-111111111111',
    }
    const writePromise = enqueueSessionEntryAfterPendingForTesting(
      transcriptPath,
      entry,
      10,
    )

    await flushSessionStorage()
    await writePromise

    const content = await fs.readFile(transcriptPath, 'utf-8')
    expect(content).toContain('"customTitle":"late enqueue"')
  })
})
