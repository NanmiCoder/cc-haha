import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { switchSession } from '../../bootstrap/state.js'
import type { SessionId } from '../../types/ids.js'
import {
  clearSessionMessagesCache,
  flushSessionStorage,
  getLastSessionLog,
  getTranscriptPathForSession,
  reAppendSessionMetadata,
  recordTranscript,
  recordSidechainTranscript,
  getAgentTranscriptPath,
  resetProjectForTesting,
  getCurrentSessionTitle,
  saveAiGeneratedTitle,
  saveTaskSummary,
  saveCustomTitle,
  saveTag,
  saveAgentName,
  saveAgentColor,
  saveWorktreeState,
  linkSessionToPR,
  adoptResumedSessionFile,
  recordContentReplacement,
  removeTranscriptMessage,
} from '../sessionStorage.js'
import { resetSettingsCache, setSessionSettingsCache } from '../settings/settingsCache.js'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalTestPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
const retention = (days: number) => setSessionSettingsCache({ settings: { cleanupPeriodDays: days }, errors: [] })
let messageClock = 0
const user = (content: string) => ({
  type: 'user' as const,
  uuid: randomUUID(),
  timestamp: new Date(1_700_000_000_000 + messageClock++).toISOString(),
  message: { role: 'user', content },
})

// Exercise the growing in-memory history used by QueryEngine without a model.
describe('session retention transitions', () => {
  let tmpDir: string
  let sessionId: SessionId
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-retention-'))
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    resetProjectForTesting()
    clearSessionMessagesCache()
    sessionId = randomUUID() as SessionId
    switchSession(sessionId)
    retention(365)
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
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  for (const initiallyEnabled of [false, true]) {
    it(`never backfills disabled user/assistant/tool history (${initiallyEnabled ? 'positive→0→positive' : '0→positive'})`, async () => {
      const history: any[] = []
      const transcriptPath = getTranscriptPathForSession(sessionId)
      if (initiallyEnabled) {
        history.push(user('previously saved and then removed'))
        await recordTranscript(history)
        await flushSessionStorage()
        await fs.unlink(transcriptPath)
      }
      retention(0)
      const privateUser = user('PRIVATE USER CANARY')
      const privateAssistant = {
        type: 'assistant', uuid: randomUUID(), timestamp: new Date(1_700_000_000_000 + messageClock++).toISOString(),
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-private', name: 'Read', input: { file_path: 'PRIVATE TOOL INPUT' } }] },
      }
      const privateResult = {
        ...user(''), sourceToolAssistantUUID: privateAssistant.uuid,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-private', content: 'PRIVATE TOOL RESULT' }] },
      }
      history.push(privateUser, privateAssistant, privateResult)
      const disabledParent = await recordTranscript(history)
      await flushSessionStorage()
      expect(await fs.access(transcriptPath).then(() => true, () => false)).toBe(false)
      retention(365)
      // An incremental caller can retain a stale parent hint; tool results may
      // also explicitly refer to a suppressed assistant across the transition.
      const fresh = { ...user('NEW PUBLIC MESSAGE'), sourceToolAssistantUUID: privateAssistant.uuid }
      history.push(fresh)
      await recordTranscript(history, undefined, disabledParent ?? undefined)
      await flushSessionStorage()
      reAppendSessionMetadata()
      const raw = await fs.readFile(transcriptPath, 'utf8')
      expect(raw).not.toContain('PRIVATE')
      expect(raw).not.toContain('previously saved and then removed')
      const entries = raw.trim().split('\n').map(line => JSON.parse(line))
      const messages = entries.filter(entry => entry.type === 'user' || entry.type === 'assistant')
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({ uuid: fresh.uuid, parentUuid: null })
      const next = user('SECOND PUBLIC MESSAGE')
      history.push(next)
      await recordTranscript(history)
      await flushSessionStorage()
      const restored = await getLastSessionLog(sessionId)
      expect(restored?.messages.map(message => message.uuid)).toEqual([fresh.uuid, next.uuid])
    })
  }

  it('keeps an unflushed enabled prefix when a second incremental write arrives', async () => {
    const first = user('enabled first')
    const second = user('enabled second')
    const parent = await recordTranscript([first] as never[])
    await recordTranscript([first, second] as never[], undefined, parent ?? undefined)
    await flushSessionStorage()
    expect((await getLastSessionLog(sessionId))?.messages.map(message => message.uuid)).toEqual([first.uuid, second.uuid])
  })

  it('starts a valid new chain after cleanup even when no messages were sent while disabled', async () => {
    const old = user('OLD REMOVED HISTORY')
    await recordTranscript([old] as never[])
    await flushSessionStorage()
    retention(0)
    const transcriptPath = getTranscriptPathForSession(sessionId)
    await fs.unlink(transcriptPath)
    retention(365)
    const fresh = user('NEW AFTER IDLE CLEANUP')
    await recordTranscript([old, fresh] as never[])
    await flushSessionStorage()
    const raw = await fs.readFile(transcriptPath, 'utf8')
    expect(raw).not.toContain('OLD REMOVED HISTORY')
    expect(JSON.parse(raw.trim())).toMatchObject({ uuid: fresh.uuid, parentUuid: null })
    expect((await getLastSessionLog(sessionId))?.messages.map(message => message.uuid)).toEqual([fresh.uuid])
  })

  it('drops queued writes when retention is disabled before flush', async () => {
    const message = user('QUEUED PRIVATE PROMPT')
    await recordTranscript([message] as never[])
    const transcriptPath = getTranscriptPathForSession(sessionId)
    retention(0)
    await fs.rm(transcriptPath, { force: true })
    await flushSessionStorage()
    expect(await fs.access(transcriptPath).then(() => true, () => false)).toBe(false)
    retention(365)
    await recordTranscript([message, user('new after queued discard')] as never[])
    await flushSessionStorage()
    expect(await fs.readFile(transcriptPath, 'utf8')).not.toContain('QUEUED PRIVATE PROMPT')
  })

  it('attributes discarded queued messages to their original session across a switch', async () => {
    const privateMessage = user('PRIVATE QUEUED SESSION A')
    await recordTranscript([privateMessage] as never[])
    switchSession(randomUUID() as SessionId)
    retention(0)
    await flushSessionStorage()
    switchSession(sessionId)
    clearSessionMessagesCache()
    retention(365)
    const fresh = user('public session A')
    await recordTranscript([privateMessage, fresh] as never[])
    await flushSessionStorage()
    const raw = await fs.readFile(getTranscriptPathForSession(sessionId), 'utf8')
    expect(raw).not.toContain('PRIVATE')
    expect(JSON.parse(raw.trim())).toMatchObject({ uuid: fresh.uuid, parentUuid: null })
  })

  it('keeps excluded sidechain messages private after dedup cache invalidation', async () => {
    const privateMessage = user('PRIVATE SIDECHAIN')
    retention(0)
    await recordSidechainTranscript([privateMessage] as never[], 'retention-agent')
    clearSessionMessagesCache()
    retention(365)
    const fresh = user('public sidechain')
    await recordSidechainTranscript([privateMessage, fresh] as never[], 'retention-agent', privateMessage.uuid)
    await flushSessionStorage()
    const raw = await fs.readFile(getAgentTranscriptPath('retention-agent' as never), 'utf8')
    expect(raw).not.toContain('PRIVATE')
    expect(JSON.parse(raw.trim())).toMatchObject({ uuid: fresh.uuid, parentUuid: null })
  })

  async function updatePrivateMetadata() {
    saveAiGeneratedTitle(sessionId, 'PRIVATE AI TITLE')
    saveTaskSummary(sessionId, 'PRIVATE TASK SUMMARY')
    await saveCustomTitle(sessionId, 'PRIVATE CUSTOM TITLE')
    await saveTag(sessionId, 'PRIVATE TAG')
    await saveAgentName(sessionId, 'PRIVATE AGENT')
    await saveAgentColor(sessionId, 'PRIVATE COLOR')
    await linkSessionToPR(sessionId, 1, 'https://example.invalid/PRIVATE', 'PRIVATE REPO')
    saveWorktreeState(null)
  }

  it('removes an older failed message without losing later transcript content during a full rewrite', async () => {
    const failed = user('FAILED STREAM MESSAGE')
    const later = user('later retained content '.repeat(4000))
    await recordTranscript([failed, later] as never[])
    await flushSessionStorage()
    const transcriptPath = getTranscriptPathForSession(sessionId)
    // Preserve an unparseable line as well: tombstoning only removes the
    // selected UUID, even when the target is outside the tail read window.
    await fs.appendFile(transcriptPath, 'incomplete trailing entry\n')
    await removeTranscriptMessage(failed.uuid)
    const saved = await fs.readFile(transcriptPath, 'utf8')
    expect(saved).not.toContain('FAILED STREAM MESSAGE')
    const lines = saved.trim().split('\n')
    expect(JSON.parse(lines[0]!)).toMatchObject({ uuid: later.uuid, message: later.message })
    expect(lines[1]).toBe('incomplete trailing entry')
    expect(lines).toHaveLength(2)
  })

  for (const replaceFile of [false, true]) {
    it(`binds resumed content replacement to its existing file (replaced=${replaceFile})`, async () => {
      const transcriptPath = getTranscriptPathForSession(sessionId)
      await fs.mkdir(path.dirname(transcriptPath), { recursive: true })
      await fs.writeFile(transcriptPath, '')
      adoptResumedSessionFile()
      const originalSetTimeout = globalThis.setTimeout
      globalThis.setTimeout = ((callback: any, delay?: number, ...args: any[]) =>
        originalSetTimeout(callback, delay === 100 ? 60_000 : delay, ...args)) as typeof setTimeout
      try {
        await recordContentReplacement([{ kind: 'tool-result', toolUseId: 'tool-private', replacement: 'PRIVATE REPLACEMENT' }])
        if (replaceFile) {
          await fs.rename(transcriptPath, transcriptPath + '.removed')
          await fs.writeFile(transcriptPath, '')
        }
        await flushSessionStorage()
        const saved = await fs.readFile(transcriptPath, 'utf8')
        if (replaceFile) expect(saved).toBe('')
        else expect(JSON.parse(saved)).toMatchObject({ type: 'content-replacement', replacements: [{ replacement: 'PRIVATE REPLACEMENT' }] })
      } finally {
        globalThis.setTimeout = originalSetTimeout
      }
    })
  }

  it('synchronous metadata helpers do not modify saved content while retention is zero', async () => {
    await recordTranscript([user('public before private metadata')] as never[])
    await flushSessionStorage()
    const transcriptPath = getTranscriptPathForSession(sessionId)
    const before = await fs.readFile(transcriptPath, 'utf8')
    retention(0)
    await updatePrivateMetadata()
    expect(await fs.readFile(transcriptPath, 'utf8')).toBe(before)
    expect(getCurrentSessionTitle(sessionId)).toBe('PRIVATE CUSTOM TITLE')
  })

  it('synchronous metadata helpers do not recreate a removed transcript with enabled cached settings', async () => {
    await recordTranscript([user('public removed transcript')] as never[])
    await flushSessionStorage()
    const transcriptPath = getTranscriptPathForSession(sessionId)
    await fs.unlink(transcriptPath)
    await updatePrivateMetadata()
    await expect(fs.readFile(transcriptPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not reappend private metadata caches when new public records materialize after deletion', async () => {
    const old = user('old removed history')
    await recordTranscript([old] as never[])
    await flushSessionStorage()
    const transcriptPath = getTranscriptPathForSession(sessionId)
    retention(0)
    await updatePrivateMetadata()
    await fs.unlink(transcriptPath)
    retention(365)
    await recordTranscript([old, user('new public history')] as never[])
    await flushSessionStorage()
    reAppendSessionMetadata()
    const saved = await fs.readFile(transcriptPath, 'utf8')
    expect(saved).toContain('new public history')
    expect(saved).not.toContain('PRIVATE')
    await saveCustomTitle(sessionId, 'new public title')
    await saveTag(sessionId, 'new public tag')
    reAppendSessionMetadata()
    const updated = await fs.readFile(transcriptPath, 'utf8')
    expect(updated).not.toContain('PRIVATE')
    expect(updated.match(/new public title/g)).toHaveLength(2)
    expect(updated.match(/new public tag/g)).toHaveLength(2)
  })

  it('does not rebuild a removed session through cached last-prompt metadata while disabled', async () => {
    await recordTranscript([user('old prompt')] as never[])
    await flushSessionStorage()
    const transcriptPath = getTranscriptPathForSession(sessionId)
    retention(0)
    await fs.unlink(transcriptPath)
    await recordTranscript([user('PRIVATE LAST PROMPT')] as never[])
    reAppendSessionMetadata()
    await flushSessionStorage()
    expect(await fs.access(transcriptPath).then(() => true, () => false)).toBe(false)
  })
})
