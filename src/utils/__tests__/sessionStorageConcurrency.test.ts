import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { switchSession } from '../../bootstrap/state.js'
import { asAgentId, type SessionId } from '../../types/ids.js'
import type { Message } from '../../types/message.js'
import * as git from '../git.js'
import { createAssistantMessage, createUserMessage } from '../messages.js'
import {
  clearSessionMessagesCache,
  doesMessageExistInSession,
  enqueueSessionEntryAfterPendingForTesting,
  flushSessionStorage,
  getAgentTranscriptPath,
  getTranscriptPathForSession,
  recordSidechainTranscript,
  recordTranscript,
  resetProjectForTesting,
  setSessionFileForTesting,
} from '../sessionStorage.js'
import { resetSettingsCache, setSessionSettingsCache } from '../settings/settingsCache.js'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalTestPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE

async function transcriptUuids(filePath: string): Promise<string[]> {
  return (await readFile(filePath, 'utf8')).split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { uuid?: string })
    .flatMap(entry => entry.uuid ? [entry.uuid] : [])
}

describe('concurrent transcript recording', () => {
  let directory: string
  let sessionId: SessionId

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'session-storage-concurrency-'))
    process.env.CLAUDE_CONFIG_DIR = directory
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    setSessionSettingsCache({ settings: { cleanupPeriodDays: 365 }, errors: [] })
    resetProjectForTesting()
    clearSessionMessagesCache()
    sessionId = randomUUID() as SessionId
    switchSession(sessionId)
  })

  afterEach(async () => {
    await flushSessionStorage()
    resetProjectForTesting()
    clearSessionMessagesCache()
    resetSettingsCache()
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    if (originalTestPersistence === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    else process.env.TEST_ENABLE_SESSION_PERSISTENCE = originalTestPersistence
    await rm(directory, { recursive: true, force: true })
  })

  it('records each streamed block once when growing transcript writes overlap', async () => {
    const history: Message[] = [
      createUserMessage({ content: 'Read each file in sequence' }),
      createAssistantMessage({ content: 'First page read; continuing' }),
    ]
    await recordTranscript(history)
    await flushSessionStorage()

    for (let round = 0; round < 2; round++) {
      // QueryEngine fire-and-forgets each completed assistant block. The text
      // write and the following tool-block write can reach the UUID check
      // together after their asynchronous branch lookup finishes.
      const text = createAssistantMessage({ content: 'Page read; continuing' })
      const tool = createAssistantMessage({ content: [{
        type: 'tool_use', id: `read-${round}`, name: 'Read', input: { file_path: `page-${round}.txt` },
      }] })
      const waiters: Array<(branch: string) => void> = []
      const branch = spyOn(git, 'getBranch').mockImplementation(() => new Promise(resolve => {
        waiters.push(resolve)
        if (waiters.length === 2) {
          for (const release of waiters.splice(0)) release('fixture')
        }
      }))
      try {
        await Promise.all([
          recordTranscript([...history, text]),
          recordTranscript([...history, text, tool]),
        ])
      } finally {
        branch.mockRestore()
      }
      history.push(text, tool)
    }

    // A later call replays the growing array. Equal prose with distinct UUIDs
    // is still two real responses, while replayed UUIDs must not be appended.
    await recordTranscript(history)
    await flushSessionStorage()
    expect(await transcriptUuids(getTranscriptPathForSession(sessionId)))
      .toEqual(history.map(message => message.uuid))
  })

  it('keeps inherited UUIDs in sidechains without claiming main transcript rows', async () => {
    const prompt = createUserMessage({ content: 'Shared prompt' })
    const child = createAssistantMessage({ content: 'Child response' })
    const parent = createAssistantMessage({ content: 'Parent response' })
    const agentId = asAgentId('concurrent-storage-child')

    await recordTranscript([prompt])
    await recordSidechainTranscript([prompt, child], agentId)
    await recordTranscript([prompt, child, parent])
    await flushSessionStorage()

    expect(await transcriptUuids(getAgentTranscriptPath(agentId)))
      .toEqual([prompt.uuid, child.uuid])
    expect(await transcriptUuids(getTranscriptPathForSession(sessionId)))
      .toEqual([prompt.uuid, child.uuid, parent.uuid])
  })

  it('allows retrying a UUID after its enqueue fails', async () => {
    const prompt = createUserMessage({ content: 'Saved prompt' })
    const reply = createAssistantMessage({ content: 'Retryable response' })
    await recordTranscript([prompt])
    await flushSessionStorage()
    const transcriptPath = getTranscriptPathForSession(sessionId)

    let reachedLookup!: () => void
    const lookupStarted = new Promise<void>(resolve => { reachedLookup = resolve })
    let releaseLookup!: (value: string) => void
    const lookupResult = new Promise<string>(resolve => { releaseLookup = resolve })
    const branch = spyOn(git, 'getBranch').mockImplementation(() => {
      reachedLookup()
      return lookupResult
    })
    try {
      const write = recordTranscript([prompt, reply])
      await lookupStarted
      // File preparation has finished. Redirect only the pending enqueue to
      // an invalid destination so it fails after the UUID was reserved.
      setSessionFileForTesting(directory)
      releaseLookup('fixture')
      await expect(write).rejects.toThrow(/Refusing non-regular transcript target|EISDIR|EPERM/)
    } finally {
      branch.mockRestore()
      setSessionFileForTesting(transcriptPath)
    }

    await recordTranscript([prompt, reply])
    await flushSessionStorage()
    expect(await transcriptUuids(transcriptPath)).toEqual([prompt.uuid, reply.uuid])
  })

  it('keeps UUID ownership when compaction invalidates the cache during an append', async () => {
    const history = [createUserMessage({ content: 'Read each page' })]
    await recordTranscript(history)
    await flushSessionStorage()
    const text = createAssistantMessage({ content: 'Page read; continuing' })
    const tool = createAssistantMessage({ content: [{
      type: 'tool_use', id: 'cache-boundary-read', name: 'Read', input: { file_path: 'next.txt' },
    }] })
    let shorterWrite: Promise<unknown> | undefined
    let shortStarted!: () => void
    const didStartShort = new Promise<void>(resolve => { shortStarted = resolve })
    let invalidated = false
    const branch = spyOn(git, 'getBranch').mockImplementation(() => {
      if (!invalidated) {
        invalidated = true
        // appendEntry captures the old memoized Set in the first continuation.
        // A concurrent compaction clears it before that await resumes. The
        // shorter snapshot then starts while the earlier writes are unflushed.
        queueMicrotask(() => queueMicrotask(() => {
          clearSessionMessagesCache()
          shorterWrite = recordTranscript([...history, text])
          shortStarted()
        }))
      }
      return Promise.resolve('fixture')
    })
    try {
      await recordTranscript([...history, text, tool])
      await didStartShort
      await shorterWrite
    } finally {
      branch.mockRestore()
    }
    await flushSessionStorage()

    expect(await transcriptUuids(getTranscriptPathForSession(sessionId)))
      .toEqual([...history, text, tool].map(message => message.uuid))
  })

  it('drains a new writer when cache invalidation overlaps an explicit flush', async () => {
    const prompt = createUserMessage({ content: 'Saved prompt' })
    const text = createAssistantMessage({ content: 'Pending response' })
    const next = createAssistantMessage({ content: 'A newer completed block' })
    await recordTranscript([prompt])
    await flushSessionStorage()

    let reachedLookup!: () => void
    const lookupStarted = new Promise<void>(resolve => { reachedLookup = resolve })
    let releaseLookup!: (value: string) => void
    const lookupResult = new Promise<string>(resolve => { releaseLookup = resolve })
    let firstLookup = true
    const branch = spyOn(git, 'getBranch').mockImplementation(() => {
      if (!firstLookup) return Promise.resolve('fixture')
      firstLookup = false
      reachedLookup()
      return lookupResult
    })
    try {
      const pending = recordTranscript([prompt, text])
      await lookupStarted
      clearSessionMessagesCache()
      const flush = flushSessionStorage()
      await recordTranscript([prompt, text, next])
      releaseLookup('fixture')
      await Promise.all([pending, flush])
    } finally {
      releaseLookup('fixture')
      branch.mockRestore()
    }

    clearSessionMessagesCache()
    await recordTranscript([prompt, text, next])
    await flushSessionStorage()
    expect(await transcriptUuids(getTranscriptPathForSession(sessionId)))
      .toEqual([prompt.uuid, text.uuid, next.uuid])
  })

  it('invalidates an idle cache immediately so the next read sees external entries', async () => {
    const prompt = createUserMessage({ content: 'Saved prompt' })
    const reply = createAssistantMessage({ content: 'Written by another transcript source' })
    await recordTranscript([prompt])
    await flushSessionStorage()
    await appendFile(getTranscriptPathForSession(sessionId), JSON.stringify({
      ...reply, parentUuid: prompt.uuid, sessionId, isSidechain: false,
    }) + '\n')
    expect(await doesMessageExistInSession(sessionId, reply.uuid)).toBe(false)

    clearSessionMessagesCache()

    expect(await doesMessageExistInSession(sessionId, reply.uuid)).toBe(true)
  })

  it('waits for a writer started between a shared flush reaching idle and settling', async () => {
    const filePath = join(directory, 'flush-settlement.jsonl')
    const first = flushSessionStorage()
    let write: Promise<void> | undefined
    let second: Promise<void> | undefined
    let enqueued = false
    await new Promise<void>(resolve => {
      // The empty drain reaches idle first, but its finally callback has not
      // settled the shared promise when this continuation starts a new writer.
      queueMicrotask(() => {
        write = enqueueSessionEntryAfterPendingForTesting(filePath, {
          type: 'custom-title', customTitle: 'late writer is durable', sessionId,
        }, 20).then(() => { enqueued = true })
        second = flushSessionStorage()
        resolve()
      })
    })
    try {
      await second
      expect(enqueued).toBe(true)
      expect(await readFile(filePath, 'utf8')).toContain('late writer is durable')
    } finally {
      await Promise.all([first, write])
      await flushSessionStorage()
    }
  })
})
