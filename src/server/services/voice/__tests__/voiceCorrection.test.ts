import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ApiError } from '../../../middleware/errorHandler.js'
import type { ProviderTextCompletionResult } from '../../providerTextCompletion.js'
import { VoiceServiceError } from '../errors.js'
import type { HistoryPaths } from '../history/scan.js'
import { VoiceProviderRegistry } from '../registry.js'
import { FileVoiceVocabularyStore } from '../vocabulary/store.js'
import { CORRECTION_TIMEOUT_MS, VoiceService } from '../voiceService.js'
import { fakeProviderRecord, fakeTargets, scriptedCompletion, text } from './fakeCorrection.js'
import { FakeProvider, memoryPreferencesStore } from './fakeProvider.js'

let tmpDir: string
let historyPaths: HistoryPaths

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-correction-'))
  historyPaths = { claudeConfigDir: path.join(tmpDir, 'claude'), codexHome: path.join(tmpDir, 'codex') }
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const active = fakeProviderRecord('active', { name: 'Active Provider' })
const chosen = fakeProviderRecord('chosen', { name: 'Chosen Provider' })

function createService(options: {
  replies?: Parameters<typeof scriptedCompletion>
  preferences?: Parameters<typeof memoryPreferencesStore>[0]
  defaultProvider?: typeof active | null
} = {}) {
  const completion = scriptedCompletion(...(options.replies ?? [text('')]))
  const vocabulary = new FileVoiceVocabularyStore({ filePath: path.join(tmpDir, 'voice-vocabulary.json') })
  const preferences = memoryPreferencesStore({ providerId: 'alpha', correctionEnabled: true, ...options.preferences })
  const service = new VoiceService({
    registry: new VoiceProviderRegistry().register(new FakeProvider({ id: 'alpha' })),
    preferences,
    correctionTargets: fakeTargets({
      defaultProvider: options.defaultProvider === undefined ? active : options.defaultProvider,
      providers: [chosen],
    }),
    completeText: completion.complete,
    vocabulary,
    historyPaths: () => historyPaths,
  })
  return { service, completion, vocabulary, preferences }
}

const signal = () => new AbortController().signal

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected rejection')
}

describe('VoiceService.correct', () => {
  test('still corrects, without the vocabulary, when the vocabulary file cannot be read', async () => {
    const { service, completion, vocabulary } = createService({ replies: [text('在 Codex 里用')] })
    Object.assign(vocabulary, { snapshot: async () => { throw new Error('EACCES: permission denied') } })

    const result = await service.correct('在 coded 里用', signal())
    expect(result.text).toBe('在 Codex 里用')
    expect(completion.requests[0]!.system).not.toContain('用户常用词表')
  })

  test('sends the normalized text with the vocabulary prompt and returns only the term fixes', async () => {
    const { service, completion, vocabulary } = createService({
      replies: [text('```\n开源的 Agent Browser skills，之前在 Codex 里用\n```')],
    })
    await vocabulary.add([{ term: 'Codex', aliases: ['coded'] }])

    const result = await service.correct('  开源的agent brother skills,之前在\n coded里用 ', signal())

    expect(result.text).toBe('开源的Agent Browser skills,之前在 Codex里用')
    expect(result.changes).toEqual([
      { from: 'agent brother', to: 'Agent Browser', start: 3, end: 16, inVocabulary: false },
      { from: 'coded', to: 'Codex', start: 28, end: 33, inVocabulary: true },
    ])
    for (const change of result.changes) expect(result.text.slice(change.start, change.end)).toBe(change.to)
    expect(result.target).toEqual({ providerId: 'active', providerName: 'Active Provider', modelId: 'active-fast' })
    expect(result.seconds).toBeGreaterThanOrEqual(0)

    const [request] = completion.requests
    expect(request!.user).toBe('开源的agent brother skills,之前在 coded里用')
    expect(request!.system).toContain('Codex（常被听成：coded）')
    expect(request!.maxTokens).toBe(1024)
    expect(request!.temperature).toBe(0)
    expect(request!.reasoningEffort).toBe('low')
    expect(request!.timeoutMs).toBe(CORRECTION_TIMEOUT_MS)
    expect(request!.provider.id).toBe('active')
    expect(request!.modelId).toBe('active-fast')
    expect(request!.signal).toBeDefined()

    // Only the fix the vocabulary did not explain becomes a suggestion.
    expect((await vocabulary.read()).suggestions).toEqual([
      expect.objectContaining({ term: 'Agent Browser', heardAs: ['agent brother'], count: 1 }),
    ])
  })

  test('uses the saved fixed model', async () => {
    const { service, completion } = createService({
      replies: [text('用 Codex')],
      preferences: { correctionProviderId: 'chosen', correctionModelId: 'chosen-model' },
    })
    const result = await service.correct('用coded', signal())
    expect(result.target).toEqual({ providerId: 'chosen', providerName: 'Chosen Provider', modelId: 'chosen-model' })
    expect(completion.requests[0]!.provider.id).toBe('chosen')
  })

  test('an unchanged answer has no changes and records nothing', async () => {
    const { service, vocabulary } = createService({ replies: [text('一句没有术语的话')] })
    expect(await service.correct('一句没有术语的话', signal())).toMatchObject({ text: '一句没有术语的话', changes: [] })
    expect((await vocabulary.read()).suggestions).toEqual([])
  })

  test('is unavailable while turned off or without a usable model, without calling one', async () => {
    const off = createService({ preferences: { correctionEnabled: false } })
    const noTarget = createService({ defaultProvider: null })
    const gone = createService({ preferences: { correctionProviderId: 'deleted', correctionModelId: 'm' } })

    for (const { service, completion } of [off, noTarget, gone]) {
      const error = await rejection(service.correct('用coded', signal()))
      expect(error).toBeInstanceOf(VoiceServiceError)
      expect(error).toMatchObject({ code: 'voice/correction-unavailable', status: 409 })
      expect(completion.requests).toEqual([])
    }
  })

  test('rejects missing, empty and oversized text as bad requests', async () => {
    const { service, completion } = createService()
    for (const input of [undefined, 42, '   \n ', 'x'.repeat(2001)]) {
      expect(await rejection(service.correct(input, signal()))).toBeInstanceOf(ApiError)
    }
    expect(completion.requests).toEqual([])
  })

  test.each(['auth', 'rate-limit', 'timeout', 'upstream'] as const)('classifies a %s failure as correction-failed', async (reason) => {
    const failure: ProviderTextCompletionResult = { ok: false, reason, message: 'fixture failure' }
    const { service } = createService({ replies: [failure] })
    const error = await rejection(service.correct('用coded', signal()))
    expect(error).toBeInstanceOf(VoiceServiceError)
    expect((error as VoiceServiceError).toBody()).toMatchObject({ error: 'voice/correction-failed', reason })
    expect((error as VoiceServiceError).status).toBe(502)
  })

  test('a cancelled request ends as an abort, not a failure', async () => {
    const { service } = createService({ replies: [{ ok: false, reason: 'aborted', message: 'cancelled' }] })
    expect(await rejection(service.correct('用coded', signal()))).toMatchObject({ name: 'AbortError' })
  })

  test.each([
    ['an answer to the question', '这个函数报错可能是因为参数类型不对，你可以检查一下传入的参数。'],
    ['an empty answer', '   '],
    ['an unrelated sentence', '今天是晴天，气温二十度'],
  ])('rejects %s as invalid-output', async (_label, answer) => {
    const { service, vocabulary } = createService({ replies: [text(answer)] })
    const error = await rejection(service.correct('帮我看一下这个函数为什么报错', signal()))
    expect((error as VoiceServiceError).toBody()).toMatchObject({ error: 'voice/correction-failed', reason: 'invalid-output' })
    expect((await vocabulary.read()).suggestions).toEqual([])
  })

  test('a failing suggestion write does not fail the correction', async () => {
    const { service, vocabulary } = createService({ replies: [text('用 Codex')] })
    vocabulary.recordSuggestions = async () => { throw new Error('disk full') }
    expect((await service.correct('用coded', signal())).text).toBe('用Codex')
  })
})

describe('VoiceService catalog correction info', () => {
  test('reports the default target and the saved choice', async () => {
    const followDefault = createService()
    expect((await followDefault.service.catalog()).correction).toEqual({
      defaultTarget: { providerId: 'active', providerName: 'Active Provider', modelId: 'active-fast' },
      target: { providerId: 'active', providerName: 'Active Provider', modelId: 'active-fast' },
    })

    const fixedGone = createService({ preferences: { correctionProviderId: 'deleted', correctionModelId: 'm' } })
    expect((await fixedGone.service.catalog()).correction).toEqual({
      defaultTarget: { providerId: 'active', providerName: 'Active Provider', modelId: 'active-fast' },
      target: null,
    })
  })
})

async function writeTranscript(session: string, texts: string[]) {
  const dir = path.join(historyPaths.claudeConfigDir, 'projects', '-work')
  await fs.mkdir(dir, { recursive: true })
  const lines = texts.map(content => JSON.stringify({ type: 'user', message: { role: 'user', content } }))
  await fs.writeFile(path.join(dir, `${session}.jsonl`), lines.join('\n') + '\n')
}

describe('VoiceService history suggestions', () => {
  test('counts locally, sends only words and counts, and marks the run', async () => {
    await writeTranscript('s1', ['私密内容 用 Codex 和 DeepSeek 以及 Gemini'])
    await writeTranscript('s2', ['另一段私密内容 Codex DeepSeek Gemini'])
    const pick = JSON.stringify({
      groups: [
        { category: 'model', terms: [{ term: 'DeepSeek', doubtful: false }, { term: 'Invented', doubtful: false }] },
        { category: 'tool', terms: [{ term: 'Codex', doubtful: false }] },
      ],
    })
    const { service, completion, vocabulary } = createService({ replies: [text(pick)] })
    await vocabulary.add([{ term: 'Gemini' }])

    const result = await service.suggestFromHistory({ sources: ['claude-code', 'codex'], providerId: null, modelId: null }, signal())

    expect(result).toMatchObject({
      sessions: 2,
      messages: 2,
      candidates: 2,
      target: { providerId: 'active', modelId: 'active-fast' },
      groups: [
        { category: 'model', terms: [{ term: 'DeepSeek', sessions: 2, doubtful: false, inVocabulary: false }] },
        { category: 'tool', terms: [{ term: 'Codex', sessions: 2, doubtful: false, inVocabulary: false }] },
      ],
    })
    const [request] = completion.requests
    expect(request!.user).toBe('Codex\t2\nDeepSeek\t2')
    expect(request!.user).not.toContain('私密')
    expect(request!.system).toContain('"groups"')
    expect(request!.temperature).toBe(0)
    expect((await vocabulary.read()).history?.lastRunAt).toBeTruthy()
  })

  test('uses an explicit model pair and skips the model call when nothing qualifies', async () => {
    const { service, completion, vocabulary } = createService()
    const result = await service.suggestFromHistory({ sources: ['codex'], providerId: 'chosen', modelId: 'chosen-model' }, signal())
    expect(result).toMatchObject({ groups: [], sessions: 0, candidates: 0, target: { providerId: 'chosen', modelId: 'chosen-model' } })
    expect(completion.requests).toEqual([])
    expect((await vocabulary.read()).history).not.toBeNull()
  })

  test('validates sources and the model pair', async () => {
    const { service } = createService()
    for (const body of [
      null,
      {},
      { sources: [] },
      { sources: ['slack'] },
      { sources: ['codex'], providerId: 'chosen', modelId: null },
      { sources: ['codex'], providerId: null, modelId: 'm' },
    ]) {
      expect(await rejection(service.suggestFromHistory(body, signal()))).toBeInstanceOf(ApiError)
    }
  })

  test('is unavailable without a model and reports pick failures', async () => {
    await writeTranscript('s1', ['Codex DeepSeek'])
    await writeTranscript('s2', ['Codex DeepSeek'])

    const noTarget = createService({ defaultProvider: null })
    expect(await rejection(noTarget.service.suggestFromHistory({ sources: ['claude-code'] }, signal())))
      .toMatchObject({ code: 'voice/correction-unavailable' })
    expect(await rejection(noTarget.service.suggestFromHistory(
      { sources: ['claude-code'], providerId: 'deleted', modelId: 'm' },
      signal(),
    ))).toMatchObject({ code: 'voice/correction-unavailable' })

    const failing = createService({ replies: [{ ok: false, reason: 'rate-limit', message: 'slow down' }] })
    expect(((await rejection(failing.service.suggestFromHistory({ sources: ['claude-code'] }, signal()))) as VoiceServiceError).toBody())
      .toMatchObject({ error: 'voice/correction-failed', reason: 'rate-limit' })
    expect((await failing.vocabulary.read()).history).toBeNull()

    const garbled = createService({ replies: [text('Sorry, no JSON here')] })
    expect(((await rejection(garbled.service.suggestFromHistory({ sources: ['claude-code'] }, signal()))) as VoiceServiceError).toBody())
      .toMatchObject({ error: 'voice/correction-failed', reason: 'invalid-output' })
  })

  test('lists sources from the configured history paths', async () => {
    await writeTranscript('s1', ['hello'])
    const { service } = createService()
    expect(await service.historySources()).toEqual([
      { id: 'claude-code', available: true, sessions: 1 },
      { id: 'codex', available: false, sessions: 0 },
    ])
  })
})
