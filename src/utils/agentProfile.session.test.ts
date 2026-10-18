import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as fsPromises from 'fs/promises'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { loadConversationForResume } from './conversationRecovery.js'
import { switchSession } from '../bootstrap/state.js'
import type { SessionId } from '../types/ids.js'
import * as processUtils from './process.js'
import { assertSessionAgentProfile, getAgentProfile, initializeSessionAgentProfile, readSessionAgentProfile, resetSessionAgentProfileCacheForTesting, setAgentProfile } from './agentProfile.js'
import { flushSessionStorage, getTranscriptPathForSession, reAppendSessionMetadata, recordTranscript, resetProjectForTesting } from './sessionStorage.js'
import { LITE_READ_BUF_SIZE } from './sessionStoragePortable.js'

let dir: string
const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, TEST_ENABLE_SESSION_PERSISTENCE: process.env.TEST_ENABLE_SESSION_PERSISTENCE }
const id = '66666666-6666-4666-8666-666666666666'
let path: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'profile-session-'))
  process.env.HOME = dir
  process.env.CLAUDE_CONFIG_DIR = join(dir, 'config')
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  switchSession(id as SessionId, join(dir, 'config', 'projects', 'fixture'))
  resetProjectForTesting()
  setAgentProfile('standard')
  path = getTranscriptPathForSession(id)
  await mkdir(dirname(path), { recursive: true })
})
afterEach(async () => {
  await flushSessionStorage()
  resetProjectForTesting()
  resetSessionAgentProfileCacheForTesting()
  setAgentProfile('standard')
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(dir, { recursive: true, force: true })
})
const meta = (agentProfile: string) => JSON.stringify({ type: 'session-meta', isMeta: true, agentProfile }) + '\n'

test('old metadata migrates to standard without rewriting unknown fields', async () => {
  const fixture = '{"type":"session-meta","isMeta":true,"workDir":"/fixture","future":{"keep":true}}\n'
  await writeFile(path, fixture)
  await initializeSessionAgentProfile({ print: true, resume: id })
  expect(getAgentProfile()).toBe('standard')
  expect(await readFile(path, 'utf8')).toBe(fixture)
})

test('UUID resume inherits lean before tool assembly and later sparse metadata does not reset it', async () => {
  await writeFile(path, meta('lean') + '{"type":"session-meta","workDir":"/fixture"}\n')
  await initializeSessionAgentProfile({ print: true, resume: id })
  expect(getAgentProfile()).toBe('lean')
  await assertSessionAgentProfile(path)
})

test('explicit profile cannot change either existing profile', async () => {
  const exit = spyOn(processUtils, 'exitWithError').mockImplementation(message => { throw new Error(message) })
  try {
    for (const stored of ['standard', 'lean']) {
      await writeFile(path, meta(stored))
      await expect(initializeSessionAgentProfile({ print: true, resume: id, agentProfile: stored === 'lean' ? 'standard' : 'lean' })).rejects.toThrow('cannot be changed')
    }
  } finally { exit.mockRestore() }
})

test('interactive, continue-style recovery and fork cannot silently use lean history', async () => {
  await writeFile(path, meta('lean'))
  await expect(assertSessionAgentProfile(path)).rejects.toThrow('uses --agent-profile lean')
  const exit = spyOn(processUtils, 'exitWithError').mockImplementation(message => { throw new Error(message) })
  try {
    await expect(initializeSessionAgentProfile({ resume: id })).rejects.toThrow('requires --print')
    await expect(initializeSessionAgentProfile({ print: true, resume: id, forkSession: true })).rejects.toThrow('--fork-session')
  } finally { exit.mockRestore() }
})

test('invalid and conflicting stored profiles fail closed', async () => {
  await writeFile(path, meta('other'))
  await expect(readSessionAgentProfile(path)).rejects.toThrow('Invalid agent profile')
  await writeFile(path, meta('lean') + meta('standard'))
  await expect(readSessionAgentProfile(path)).rejects.toThrow('Conflicting agent profiles')
})

test('real transcript writer persists the selected profile and preserves user history', async () => {
  setAgentProfile('lean')
  await recordTranscript([{ type: 'user', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: 'saved prompt' } } as never])
  await flushSessionStorage()
  expect(await readSessionAgentProfile(path)).toBe('lean')
  expect(await readFile(path, 'utf8')).toContain('saved prompt')
  setAgentProfile('standard')
  await expect(loadConversationForResume(id, path)).rejects.toThrow('uses --agent-profile lean')
  await initializeSessionAgentProfile({ print: true, resume: id })
  expect(getAgentProfile()).toBe('lean')
})


test('profile lookup projects oversized history and finds metadata after it', async () => {
  const largeMessage = JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(6 * 1024 * 1024) } })
  await writeFile(path, largeMessage + '\n' + meta('lean'))
  expect(await readSessionAgentProfile(path)).toBe('lean')
  await initializeSessionAgentProfile({ print: true, resume: id })
  expect(getAgentProfile()).toBe('lean')
})

describe('bounded profile resolution on resume', () => {
  const W = LITE_READ_BUF_SIZE
  const MB = 1024 * 1024
  const LARGE = 160 * MB
  const record = (entry: object) => JSON.stringify(entry) + '\n'
  const snapshot = record({ type: 'file-history-snapshot', messageId: 'fixture', snapshot: { messageId: 'fixture', trackedFileBackups: {}, timestamp: 'fixture' }, isSnapshotUpdate: false })
  // Shape of the desktop createSession / clear record (workDir, optional profile).
  const desktopMeta = (agentProfile?: string) => record({ type: 'session-meta', isMeta: true, workDir: '/fixture', ...(agentProfile === undefined ? {} : { agentProfile }), timestamp: 'fixture' })
  const message = (text: string) => record({ type: 'user', uuid: '11111111-1111-4111-8111-111111111111', message: { role: 'user', content: text } })
  const lastPrompt = record({ type: 'last-prompt', lastPrompt: 'fixture prompt' })

  /** A sparse transcript of `size` bytes whose only real bytes are `segments`. */
  async function writeSparse(file: string, size: number, segments: Array<[offset: number, text: string]>) {
    const handle = await fsPromises.open(file, 'w')
    try {
      await handle.truncate(size)
      for (const [offset, text] of segments) await handle.write(text, offset)
    } finally {
      await handle.close()
    }
  }
  /** Head records at offset 0 and tail records ending exactly at EOF. */
  const headAndTail = (head: string, tail: string, size = LARGE): Array<[number, string]> =>
    [[0, head], [size - Buffer.byteLength(`\n${tail}`), `\n${tail}`]]

  /** Count opens of, and bytes read from, `file` while `run` executes. */
  async function transcriptReads(file: string, run: () => Promise<unknown>) {
    const realOpen = fsPromises.open
    const reads = { opens: 0, bytes: 0 }
    const spy = spyOn(fsPromises, 'open').mockImplementation((async (...args: Parameters<typeof realOpen>) => {
      const handle = await realOpen(...args)
      if (resolve(String(args[0])) === resolve(file)) {
        reads.opens++
        const read = handle.read.bind(handle) as (...readArgs: unknown[]) => Promise<{ bytesRead: number }>
        Object.assign(handle, {
          read: async (...readArgs: unknown[]) => {
            const result = await read(...readArgs)
            reads.bytes += result.bytesRead
            return result
          },
        })
      }
      return handle
    }) as typeof realOpen)
    try {
      await run()
    } finally {
      spy.mockRestore()
    }
    return reads
  }

  test('cost does not grow with transcript size: one open, two fixed windows, history between them unread', async () => {
    for (const size of [1 * MB, LARGE]) {
      const cases = [
        ['legacy standard', snapshot + desktopMeta() + message('first'), message('last'), 'standard'],
        ['desktop standard', snapshot + desktopMeta('standard') + message('first'), message('last'), 'standard'],
        ['resumed lean', snapshot + desktopMeta('lean') + message('first'), message('last') + meta('lean') + lastPrompt, 'lean'],
      ] as const
      for (const [name, head, tail, expected] of cases) {
        // A whole-file scan would reject this mid-history record; a bounded read never reaches it.
        await writeSparse(path, size, [...headAndTail(head, tail, size), [size / 2, `\n${meta('not-a-profile')}`]])
        let profile: string | undefined
        const reads = await transcriptReads(path, async () => { profile = await readSessionAgentProfile(path) })
        expect({ name, size, profile, ...reads }).toEqual({ name, size, profile: expected, opens: 1, bytes: 2 * W + 1 })
      }
    }
  })

  test('a resume reads the profile once; the load-time check reuses it only for the same transcript', async () => {
    await writeSparse(path, LARGE, headAndTail(snapshot + desktopMeta('lean'), message('last') + meta('lean')))
    const once = await transcriptReads(path, async () => {
      await initializeSessionAgentProfile({ print: true, resume: id })
      await assertSessionAgentProfile(path)
    })
    expect(getAgentProfile()).toBe('lean')
    expect(once).toEqual({ opens: 1, bytes: 2 * W + 1 })

    // Another transcript is judged by its own records, never by the startup result.
    const other = join(dirname(path), 'other.jsonl')
    await writeSparse(other, LARGE, headAndTail(snapshot + desktopMeta('standard'), message('last')))
    await initializeSessionAgentProfile({ print: true, resume: id })
    const otherReads = await transcriptReads(other, async () => {
      await expect(assertSessionAgentProfile(other)).rejects.toThrow('uses --agent-profile standard')
    })
    expect(otherReads.opens).toBe(1)

    // The reuse is one-shot: a later recovery of the same path reads the file again.
    await initializeSessionAgentProfile({ print: true, resume: id })
    await assertSessionAgentProfile(path)
    const later = await transcriptReads(path, () => assertSessionAgentProfile(path))
    expect(later.opens).toBe(1)
  })

  test('resolution matrix over large histories; conflicts and invalid values in either window fail closed', async () => {
    const cases = [
      ['desktop-created lean, never re-appended', snapshot + desktopMeta('lean') + message('first'), message('last'), 'lean'],
      ['resumed lean, head and EOF markers', snapshot + desktopMeta('lean'), message('last') + meta('lean') + lastPrompt, 'lean'],
      ['compacted lean known only from its EOF re-append', snapshot + desktopMeta() + message('first'), record({ type: 'system', subtype: 'compact_boundary' }) + meta('lean') + lastPrompt, 'lean'],
      ['later sparse metadata does not reset lean', snapshot + desktopMeta('lean'), desktopMeta(), 'lean'],
      ['legacy transcript without a profile', snapshot + desktopMeta() + message('first'), message('last'), 'standard'],
      ['explicit standard', snapshot + desktopMeta('standard'), message('last'), 'standard'],
    ] as const
    for (const [name, head, tail, expected] of cases) {
      await writeSparse(path, LARGE, headAndTail(head, tail))
      expect({ name, profile: await readSessionAgentProfile(path) }).toEqual({ name, profile: expected })
    }
    const failures = [
      [snapshot + desktopMeta('lean'), meta('standard'), 'Conflicting agent profiles'],
      [snapshot + desktopMeta('standard'), meta('lean'), 'Conflicting agent profiles'],
      [snapshot + desktopMeta('other'), message('last'), 'Invalid agent profile'],
      [snapshot + desktopMeta('lean'), meta('other'), 'Invalid agent profile'],
    ] as const
    for (const [head, tail, error] of failures) {
      await writeSparse(path, LARGE, headAndTail(head, tail))
      await expect(readSessionAgentProfile(path)).rejects.toThrow(error)
    }
  })

  test('CLI-created lean stays lean across a large history and the real compaction re-append', async () => {
    setAgentProfile('lean')
    await recordTranscript([{ type: 'user', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: 'first' } } as never])
    await flushSessionStorage()
    // A long history without any EOF marker (e.g. the process was killed before exit).
    const late = `\n${message('late')}`
    const handle = await fsPromises.open(path, 'r+')
    try {
      await handle.write(late, LARGE - Buffer.byteLength(late))
    } finally {
      await handle.close()
    }
    expect(await readSessionAgentProfile(path)).toBe('lean')
    // What compaction and exit do: the writer's EOF marker must land inside the tail window.
    reAppendSessionMetadata()
    await flushSessionStorage()
    const tailHandle = await fsPromises.open(path, 'r')
    try {
      const { size } = await tailHandle.stat()
      const { buffer } = await tailHandle.read(Buffer.alloc(W), 0, W, size - W)
      expect(buffer.toString('utf8')).toContain('"type":"session-meta","isMeta":true')
      expect(buffer.toString('utf8')).toContain('"agentProfile":"lean"')
    } finally {
      await tailHandle.close()
    }
    expect(await readSessionAgentProfile(path)).toBe('lean')
  })

  test('an explicit flag cannot change a large stored profile; a missing transcript keeps its diagnostic path', async () => {
    const exit = spyOn(processUtils, 'exitWithError').mockImplementation(message => { throw new Error(message) })
    try {
      for (const [stored, flag, tail] of [['lean', 'standard', message('last') + meta('lean')], ['standard', 'lean', message('last')]] as const) {
        await writeSparse(path, LARGE, headAndTail(snapshot + desktopMeta(stored), tail))
        await expect(initializeSessionAgentProfile({ print: true, resume: id, agentProfile: flag })).rejects.toThrow('cannot be changed')
      }
    } finally {
      exit.mockRestore()
    }
    const missing = '77777777-7777-4777-8777-777777777777'
    await expect(readSessionAgentProfile(getTranscriptPathForSession(missing))).rejects.toMatchObject({ code: 'ENOENT' })
    await initializeSessionAgentProfile({ print: true, resume: missing, agentProfile: 'lean' })
    expect(getAgentProfile()).toBe('lean')
    await initializeSessionAgentProfile({ print: true, resume: missing })
    expect(getAgentProfile()).toBe('standard')
  })

  test('window edges: only records wholly inside the head or tail window are examined', async () => {
    const lean = meta('lean')
    const L = Buffer.byteLength(lean)
    const size = 1 * MB
    const cases: Array<[name: string, size: number, segments: Array<[number, string]>, expected: string]> = [
      ['record ends on the last head byte', size, [[W - L - 1, `\n${lean}`]], 'lean'],
      ['record crosses the head window end', size, [[W - L, `\n${lean}`]], 'standard'],
      ['record starts on the first tail byte', size, [[size - W - 1, `\n${lean}`]], 'lean'],
      ['record starts one byte before the tail window', size, [[size - W - 2, `\n${lean}`]], 'standard'],
      ['file of exactly two windows is read whole', 2 * W, [[W - 11, `\n${lean}`]], 'lean'],
      ['one byte larger leaves a straddling record unread', 2 * W + 1, [[W - 11, `\n${lean}`]], 'standard'],
      ['no newline in the head window', size, [[0, 'x'.repeat(W + 10)], [size - L - 1, `\n${lean}`]], 'lean'],
      ['no newline in the tail window', size, [[0, lean], [size - W - 10, `\n${'x'.repeat(W + 9)}`]], 'lean'],
    ]
    for (const [name, fileSize, segments, expected] of cases) {
      await writeSparse(path, fileSize, segments)
      expect({ name, profile: await readSessionAgentProfile(path) }).toEqual({ name, profile: expected })
    }
  })
})
