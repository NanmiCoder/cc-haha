import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SessionService } from '../services/sessionService.js'
import { SessionProtocolError } from '../services/sessionProtocolHistory.js'
import { sanitizePath } from '../../utils/sessionStoragePortable.js'

const sessionId = '12870000-bbbb-cccc-dddd-eeeeeeeeeeee'
let configDir: string
let previousConfigDir: string | undefined
let previousIndexMode: string | undefined
let workDir: string
let filePath: string

beforeEach(async () => {
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  previousIndexMode = process.env.CC_HAHA_LOCAL_INDEX
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-protocol-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  process.env.CC_HAHA_LOCAL_INDEX = 'off'
  workDir = path.join(configDir, 'repo')
  await fs.mkdir(workDir)
  filePath = path.join(configDir, 'projects', sanitizePath(workDir), `${sessionId}.jsonl`)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
})

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  if (previousIndexMode === undefined) delete process.env.CC_HAHA_LOCAL_INDEX
  else process.env.CC_HAHA_LOCAL_INDEX = previousIndexMode
  await fs.rm(configDir, { recursive: true, force: true })
})

async function seed(entries: object[]) {
  const original = [
    { type: 'session-meta', workDir, customFutureField: { keep: true } }, ...entries,
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n'
  await fs.writeFile(filePath, original)
  return original
}
const user = { type: 'user', uuid: 'user-1', message: { role: 'user', content: 'hello' } }
const assistant = { type: 'assistant', uuid: 'assistant-1', message: { role: 'assistant', model: 'fixture-model', content: 'reply' } }

describe('session API protocol persistence', () => {
  it('locks on first send, survives restart, rejects a different protocol without writes', async () => {
    const original = await seed([])
    const service = new SessionService()
    expect(await service.getSessionApiFormat(sessionId)).toBeUndefined()
    await service.lockSessionApiFormat(sessionId, 'openai_chat')
    const locked = await fs.readFile(filePath, 'utf8')
    expect(locked.startsWith(original)).toBe(true)
    const restarted = new SessionService()
    expect(await restarted.getSessionApiFormat(sessionId)).toBe('openai_chat')
    await restarted.lockSessionApiFormat(sessionId, 'openai_chat')
    await expect(restarted.lockSessionApiFormat(sessionId, 'anthropic')).rejects.toBeInstanceOf(SessionProtocolError)
    expect(await fs.readFile(filePath, 'utf8')).toBe(locked)
  })

  it('creates protocol metadata for a live SDK session before its first transcript write', async () => {
    const service = new SessionService()
    await service.lockSessionApiFormat('live-sdk-session', 'openai_responses', workDir)
    expect(await service.getSessionApiFormat('live-sdk-session')).toBe('openai_responses')
    await expect(service.lockSessionApiFormat('live-sdk-session', 'anthropic', workDir)).rejects.toBeInstanceOf(SessionProtocolError)
    await expect(service.lockSessionApiFormat('../outside', 'anthropic', workDir)).rejects.toThrow('Invalid session ID')
    await expect(service.lockSessionApiFormat(sessionId, 'anthropic')).rejects.toThrow('Session not found')
  })

  it('serializes competing first sends across service instances', async () => {
    await seed([])
    const results = await Promise.allSettled([
      new SessionService().lockSessionApiFormat(sessionId, 'anthropic'),
      new SessionService().lockSessionApiFormat(sessionId, 'openai_responses'),
    ])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(await new SessionService().getSessionApiFormat(sessionId)).toBe('anthropic')
    expect((await fs.readFile(filePath, 'utf8')).match(/sessionApiFormat/g)).toHaveLength(1)
  })

  it('upgrades old official-route history additively only on send and exposes every read surface', async () => {
    const original = await seed([{ type: 'session-meta', runtimeProviderId: 'openai-official' }, user, assistant])
    const service = new SessionService()
    expect(await service.getSessionApiFormat(sessionId)).toBe('openai_responses')
    expect((await service.getSessionLaunchInfo(sessionId))?.sessionApiFormat).toBe('openai_responses')
    expect((await service.getSession(sessionId))?.sessionApiFormat).toBe('openai_responses')
    expect((await service.getSessionSummary(sessionId))?.sessionApiFormat).toBe('openai_responses')
    expect((await service.listSessions()).sessions[0]?.sessionApiFormat).toBe('openai_responses')
    expect((await service.getInspectionTranscriptSnapshot(sessionId))?.launchInfo.sessionApiFormat).toBe('openai_responses')
    expect(await fs.readFile(filePath, 'utf8')).toBe(original)
    await service.lockSessionApiFormat(sessionId, 'openai_responses')
    expect((await fs.readFile(filePath, 'utf8')).startsWith(original)).toBe(true)
  })

  it.each(['unknown', 'mixed'] as const)('blocks %s old histories without rewriting them', async state => {
    const entries = state === 'mixed'
      ? [{ type: 'session-meta', runtimeProviderId: null }, user, assistant,
        { type: 'session-meta', runtimeProviderId: 'openai-official' }, user, assistant]
      : [{ type: 'session-meta', runtimeProviderId: 'mutable-saved-provider' }, user, assistant]
    const original = await seed(entries)
    const service = new SessionService()
    expect(await service.getSessionApiFormat(sessionId)).toBe(state)
    await expect(service.lockSessionApiFormat(sessionId, 'anthropic')).rejects.toMatchObject({ code: 'SESSION_PROTOCOL_UNRESOLVED' })
    expect(await fs.readFile(filePath, 'utf8')).toBe(original)
  })

  it('preserves protocol when runtime metadata moves to another workspace', async () => {
    await seed([{ type: 'session-meta', sessionApiFormat: 'openai_chat' }, user, assistant])
    const destination = path.join(configDir, 'second-repo')
    await fs.mkdir(destination)
    const service = new SessionService()
    await service.appendSessionMetadata(sessionId, { workDir: destination, runtimeProviderId: 'different-saved-provider' })
    expect(await service.getSessionApiFormat(sessionId)).toBe('openai_chat')
    expect((await service.getSessionLaunchInfo(sessionId))?.sessionApiFormat).toBe('openai_chat')
  })

  it('keeps the lock when clearing or rewinding the same session', async () => {
    await seed([{ type: 'session-meta', sessionApiFormat: 'anthropic' }, user, assistant])
    const service = new SessionService()
    await service.trimSessionMessagesFrom(sessionId, 'user-1')
    expect(await service.getSessionApiFormat(sessionId)).toBe('anthropic')
    await service.clearSessionTranscript(sessionId, workDir)
    expect(await new SessionService().getSessionApiFormat(sessionId)).toBe('anthropic')
  })
})
