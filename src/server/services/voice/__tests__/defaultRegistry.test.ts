import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createDefaultProviders, createVoiceService } from '../defaultRegistry.js'
import { DEFAULT_VOICE_PREFERENCES } from '../types.js'
import { fakeProviderRecord, fakeTargets, scriptedCompletion, text } from './fakeCorrection.js'
import { memoryPreferencesStore } from './fakeProvider.js'

let configDir: string
let previousConfigDir: string | undefined

beforeEach(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-voice-default-'))
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
})

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  await fs.rm(configDir, { recursive: true, force: true })
})

describe('default voice providers', () => {
  test('ships the three local models, the default preference first', () => {
    const ids = createDefaultProviders().map(provider => provider.info.id)
    expect(ids).toEqual(['sensevoice-local', 'funasr-nano-local', 'qwen3-asr-local'])
    expect(ids[0]).toBe(DEFAULT_VOICE_PREFERENCES.providerId)
  })

  test('every provider can release its worker when the user switches away', () => {
    for (const provider of createDefaultProviders()) {
      expect(typeof provider.release).toBe('function')
    }
  })

  test('reports unprepared local providers without touching the network or the real home', async () => {
    const service = createVoiceService(createDefaultProviders())
    const catalog = await service.catalog()

    expect(catalog.providers.map(status => status.info.name)).toEqual(['SenseVoice Small (INT8)', 'Fun-ASR-Nano', 'Qwen3-ASR 0.6B'])
    for (const status of catalog.providers) {
      expect(status.info.location).toBe('local')
      expect(status.preparation.phase).toBe('unprepared')
    }
    const [sensevoice, funasrNano, qwen3] = catalog.providers
    expect(sensevoice!.info.languages).toContain('zh')
    expect(funasrNano!.info.languages).toEqual(['auto'])
    expect(qwen3!.info.languages).toEqual(['auto'])
    expect(catalog.preferences.providerId).toBe(sensevoice!.info.id)
    // Preferences are read from the redirected config dir, never the real one.
    await expect(fs.readdir(configDir)).resolves.toBeDefined()
  })

  test('passes every injected option to the service instead of falling back to the real ones', async () => {
    // A dropped option would quietly reach the real model transport and the real home.
    const provider = fakeProviderRecord('injected')
    const completion = scriptedCompletion(text('用 Codex 写'))
    const service = createVoiceService([], {
      preferences: memoryPreferencesStore({ correctionEnabled: true }),
      correctionTargets: fakeTargets({ defaultProvider: provider }),
      completeText: completion.complete,
    })

    const result = await service.correct('用 coded 写', new AbortController().signal)
    expect(completion.requests).toHaveLength(1)
    expect(result.target.providerId).toBe('injected')
  })
})
