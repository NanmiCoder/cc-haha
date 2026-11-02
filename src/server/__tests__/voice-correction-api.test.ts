import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleVoiceApi } from '../api/voice.js'
import { handleApiRequest } from '../router.js'
import type { ProviderTextCompletionResult } from '../services/providerTextCompletion.js'
import { VoiceProviderRegistry } from '../services/voice/registry.js'
import type { VoiceCorrection, VoiceHistorySuggestions, VoiceVocabulary } from '../services/voice/types.js'
import { FileVoiceVocabularyStore } from '../services/voice/vocabulary/store.js'
import { VoiceService } from '../services/voice/voiceService.js'
import {
  fakeProviderRecord,
  fakeTargets,
  scriptedCompletion,
  text,
} from '../services/voice/__tests__/fakeCorrection.js'
import { FakeProvider, memoryPreferencesStore } from '../services/voice/__tests__/fakeProvider.js'

let tmpDir: string
let originalConfigDir: string | undefined
let originalCodexHome: string | undefined
let service: VoiceService
let preferences: ReturnType<typeof memoryPreferencesStore>
let replies: ProviderTextCompletionResult[]

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-correction-api-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  originalCodexHome = process.env.CODEX_HOME
  process.env.CLAUDE_CONFIG_DIR = path.join(tmpDir, 'claude')
  process.env.CODEX_HOME = path.join(tmpDir, 'codex')
  replies = [text('用 Codex 写')]
  preferences = memoryPreferencesStore({ providerId: 'alpha', correctionEnabled: true })
  service = new VoiceService({
    registry: new VoiceProviderRegistry().register(new FakeProvider({ id: 'alpha' })),
    preferences,
    correctionTargets: fakeTargets({
      defaultProvider: fakeProviderRecord('active', { name: 'Active' }),
      providers: [fakeProviderRecord('chosen')],
    }),
    completeText: scriptedCompletion(request => replies.shift() ?? text(request.user)).complete,
    vocabulary: new FileVoiceVocabularyStore({ filePath: path.join(tmpDir, 'voice-vocabulary.json') }),
    historyPaths: () => ({ claudeConfigDir: path.join(tmpDir, 'claude'), codexHome: path.join(tmpDir, 'codex') }),
  })
})

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function call(method: string, target: string, body?: unknown, init: RequestInit = {}) {
  const url = new URL(target, 'http://localhost:3456')
  const request = new Request(url, {
    method,
    ...(body === undefined
      ? {}
      : { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    ...init,
  })
  return handleVoiceApi(request, url, url.pathname.split('/').filter(Boolean), service)
}

describe('POST /api/voice/correct', () => {
  test('returns the corrected text, its changes and the target', async () => {
    const res = await call('POST', '/api/voice/correct', { text: '用coded写' })
    expect(res.status).toBe(200)
    const body = await res.json() as VoiceCorrection
    expect(body).toMatchObject({
      text: '用Codex写',
      changes: [{ from: 'coded', to: 'Codex', start: 1, end: 6, inVocabulary: false }],
      target: { providerId: 'active', providerName: 'Active', modelId: 'active-fast' },
    })
  })

  test('answers 400 for bad bodies, 405 for other methods', async () => {
    expect((await call('POST', '/api/voice/correct', { text: '  ' })).status).toBe(400)
    expect((await call('POST', '/api/voice/correct', { text: 1 })).status).toBe(400)
    expect((await call('POST', '/api/voice/correct', ['text'])).status).toBe(400)
    expect((await call('POST', '/api/voice/correct', 'not json')).status).toBe(400)
    expect((await call('GET', '/api/voice/correct')).status).toBe(405)
    expect((await call('POST', '/api/voice/correct/extra', { text: 'x' })).status).toBe(404)
  })

  test('answers 409 while correction is off and 502 with a reason when the model fails', async () => {
    preferences.current = { ...preferences.current, correctionEnabled: false }
    const off = await call('POST', '/api/voice/correct', { text: '用coded写' })
    expect(off.status).toBe(409)
    expect(await off.json()).toMatchObject({ error: 'voice/correction-unavailable' })

    preferences.current = { ...preferences.current, correctionEnabled: true }
    replies = [{ ok: false, reason: 'auth', message: 'HTTP 401' }]
    const failed = await call('POST', '/api/voice/correct', { text: '用coded写' })
    expect(failed.status).toBe(502)
    expect(await failed.json()).toMatchObject({ error: 'voice/correction-failed', reason: 'auth' })

    replies = [text('这是一个完全不同的回答，和原来那句话没有关系。')]
    const invalid = await call('POST', '/api/voice/correct', { text: '用coded写' })
    expect(invalid.status).toBe(502)
    expect(await invalid.json()).toMatchObject({ error: 'voice/correction-failed', reason: 'invalid-output' })
  })

  test('a client that went away just ends the request (499, not an error)', async () => {
    replies = [{ ok: false, reason: 'aborted', message: 'cancelled' }]
    const res = await call('POST', '/api/voice/correct', { text: '用coded写' })
    expect(res.status).toBe(499)
  })
})

describe('vocabulary routes', () => {
  test('add, read, update, remove and dismiss round-trip', async () => {
    const empty = await call('GET', '/api/voice/vocabulary')
    expect(await empty.json()).toEqual({ terms: [], suggestions: [], history: null, maxTerms: 500 })

    const added = await call('POST', '/api/voice/vocabulary/terms', {
      entries: [{ term: 'Claude Code', aliases: ['cloud code'] }, { term: 'Codex' }, 'junk', { term: 'codex' }],
      source: 'history',
      dismiss: ['Gemini'],
    })
    expect(added.status).toBe(200)
    expect(await added.json()).toMatchObject({ added: 2, merged: 0, skipped: 2, vocabulary: { history: { addedCount: 2 } } })

    const updated = await call('PUT', '/api/voice/vocabulary/terms', { from: 'codex', term: 'Codex CLI', aliases: ['coded'] })
    expect(updated.status).toBe(200)
    expect((await updated.json() as { vocabulary: VoiceVocabulary }).vocabulary.terms[1]).toMatchObject({
      term: 'Codex CLI', aliases: ['coded'],
    })
    expect((await call('PUT', '/api/voice/vocabulary/terms', { from: 'nope', term: 'X', aliases: [] })).status).toBe(404)
    expect((await call('PUT', '/api/voice/vocabulary/terms', { from: 'Codex CLI', term: 'claude code', aliases: [] })).status).toBe(409)
    expect((await call('PUT', '/api/voice/vocabulary/terms', { from: 'Codex CLI', term: 'X' })).status).toBe(400)

    // A correction the vocabulary does not cover becomes a suggestion; dismissing hides it.
    replies = [text('用 Agent Browser 写')]
    await call('POST', '/api/voice/correct', { text: '用agent brother写' })
    expect((await (await call('GET', '/api/voice/vocabulary')).json() as VoiceVocabulary).suggestions)
      .toMatchObject([{ term: 'Agent Browser', heardAs: ['agent brother'], count: 1 }])
    const dismissed = await call('POST', '/api/voice/vocabulary/suggestions/dismiss', { term: 'Agent Browser' })
    expect((await dismissed.json() as { vocabulary: VoiceVocabulary }).vocabulary.suggestions).toEqual([])

    const removed = await call('DELETE', `/api/voice/vocabulary/terms?${new URLSearchParams({ term: 'Claude Code' })}`)
    expect(removed.status).toBe(200)
    expect((await removed.json() as { vocabulary: VoiceVocabulary }).vocabulary.terms.map(entry => entry.term)).toEqual(['Codex CLI'])
  })

  test('rejects malformed requests and unknown routes', async () => {
    expect((await call('POST', '/api/voice/vocabulary/terms', { entries: 'Codex' })).status).toBe(400)
    expect((await call('POST', '/api/voice/vocabulary/terms', { entries: [], source: 'robot' })).status).toBe(400)
    expect((await call('POST', '/api/voice/vocabulary/terms', { entries: [], dismiss: [1] })).status).toBe(400)
    expect((await call('DELETE', '/api/voice/vocabulary/terms')).status).toBe(400)
    expect((await call('PATCH', '/api/voice/vocabulary/terms', {})).status).toBe(405)
    expect((await call('POST', '/api/voice/vocabulary')).status).toBe(405)
    expect((await call('POST', '/api/voice/vocabulary/suggestions/dismiss', {})).status).toBe(400)
    expect((await call('GET', '/api/voice/vocabulary/suggestions/dismiss')).status).toBe(405)
    expect((await call('GET', '/api/voice/vocabulary/nope')).status).toBe(404)
  })

  test('is reachable through the main API router with the default file store', async () => {
    const url = new URL('http://localhost:3456/api/voice/vocabulary')
    const res = await handleApiRequest(new Request(url), url)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ terms: [], maxTerms: 500 })
  })
})

describe('history routes', () => {
  async function writeTranscript(session: string, content: string) {
    const dir = path.join(tmpDir, 'claude', 'projects', '-work')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, `${session}.jsonl`), JSON.stringify({ type: 'user', message: { content } }) + '\n')
  }

  test('lists sources and suggests terms from them', async () => {
    await writeTranscript('s1', '用 Codex 和 DeepSeek')
    await writeTranscript('s2', 'Codex 还有 DeepSeek')

    const sources = await call('GET', '/api/voice/vocabulary/history/sources')
    expect(await sources.json()).toEqual({
      sources: [
        { id: 'claude-code', available: true, sessions: 2 },
        { id: 'codex', available: false, sessions: 0 },
      ],
    })

    replies = [text('{"groups":[{"category":"tool","terms":[{"term":"Codex","doubtful":false}]}]}')]
    const res = await call('POST', '/api/voice/vocabulary/history/suggest', { sources: ['claude-code'], providerId: null, modelId: null })
    expect(res.status).toBe(200)
    expect(await res.json() as VoiceHistorySuggestions).toMatchObject({
      groups: [{ category: 'tool', terms: [{ term: 'Codex', sessions: 2, doubtful: false, inVocabulary: false }] }],
      sessions: 2,
      messages: 2,
      candidates: 2,
      target: { providerId: 'active' },
    })
  })

  test('answers 400 for bad requests, 409 without a model and 502 when the pick fails', async () => {
    await writeTranscript('s1', 'Codex DeepSeek')
    await writeTranscript('s2', 'Codex DeepSeek')

    expect((await call('POST', '/api/voice/vocabulary/history/suggest', { sources: ['mail'] })).status).toBe(400)
    expect((await call('POST', '/api/voice/vocabulary/history/suggest', { sources: ['codex'], providerId: 'chosen' })).status).toBe(400)
    expect((await call('GET', '/api/voice/vocabulary/history/suggest')).status).toBe(405)
    expect((await call('POST', '/api/voice/vocabulary/history/sources')).status).toBe(405)

    const gone = await call('POST', '/api/voice/vocabulary/history/suggest', { sources: ['claude-code'], providerId: 'deleted', modelId: 'm' })
    expect(gone.status).toBe(409)
    expect(await gone.json()).toMatchObject({ error: 'voice/correction-unavailable' })

    replies = [{ ok: false, reason: 'timeout', message: 'slow' }]
    const failed = await call('POST', '/api/voice/vocabulary/history/suggest', { sources: ['claude-code'] })
    expect(failed.status).toBe(502)
    expect(await failed.json()).toMatchObject({ error: 'voice/correction-failed', reason: 'timeout' })
  })

  test('a cancelled scan ends the request without an error response', async () => {
    await writeTranscript('s1', 'Codex')
    const controller = new AbortController()
    controller.abort()
    const res = await call('POST', '/api/voice/vocabulary/history/suggest', { sources: ['claude-code'] }, { signal: controller.signal })
    expect(res.status).toBe(499)
  })
})

describe('PUT /api/voice/preferences correction fields', () => {
  test('stores the switch and the model pair; rejects a mixed or unknown pair', async () => {
    const ok = await call('PUT', '/api/voice/preferences', { correctionProviderId: 'chosen', correctionModelId: 'm1' })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ preferences: { correctionProviderId: 'chosen', correctionModelId: 'm1' } })

    expect((await call('PUT', '/api/voice/preferences', { correctionProviderId: 'chosen', correctionModelId: null })).status).toBe(400)
    expect((await call('PUT', '/api/voice/preferences', { correctionProviderId: 'deleted', correctionModelId: 'm' })).status).toBe(400)
    expect((await call('PUT', '/api/voice/preferences', { correctionEnabled: 'on' })).status).toBe(400)

    const catalog = await (await call('GET', '/api/voice/catalog')).json() as { correction: unknown }
    expect(catalog.correction).toEqual({
      defaultTarget: { providerId: 'active', providerName: 'Active', modelId: 'active-fast' },
      target: { providerId: 'chosen', providerName: 'Provider chosen', modelId: 'm1' },
    })
  })
})
