import { describe, expect, test } from 'bun:test'
import { ApiError } from '../../../middleware/errorHandler.js'
import { VoiceServiceError } from '../errors.js'
import { VoiceProviderRegistry } from '../registry.js'
import { VOICE_LIMITS } from '../types.js'
import { VoiceService } from '../voiceService.js'
import { FakeProvider, makeWav, memoryPreferencesStore } from './fakeProvider.js'

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const signal = () => new AbortController().signal

function createService(
  providers: FakeProvider[],
  options: { preferences?: Parameters<typeof memoryPreferencesStore>[0] } = {},
) {
  const registry = new VoiceProviderRegistry()
  for (const provider of providers) registry.register(provider)
  const preferences = memoryPreferencesStore({ providerId: providers[0]?.info.id, ...options.preferences })
  const service = new VoiceService({ registry, preferences })
  return { service, preferences }
}

async function expectRejects<T extends Error>(promise: Promise<unknown>, type: new (...args: never[]) => T) {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(type)
    return error as T
  }
  throw new Error('expected promise to reject')
}

describe('VoiceService catalog', () => {
  test('lists every registered provider with preferences and limits', async () => {
    const a = new FakeProvider({ id: 'alpha', name: 'Alpha' })
    const b = new FakeProvider({ id: 'beta', name: 'Beta', languages: ['auto', 'ja'] })
    b.installed = true
    const { service } = createService([a, b], { preferences: { providerId: 'alpha' } })

    const catalog = await service.catalog()

    expect(catalog.supported).toBe(true)
    expect(catalog.limits).toEqual(VOICE_LIMITS)
    expect(catalog.preferences).toEqual({ enabled: true, providerId: 'alpha', language: 'auto', downloadSource: 'auto' })
    expect(catalog.providers.map(item => [item.info.id, item.preparation.phase])).toEqual([
      ['alpha', 'unprepared'],
      ['beta', 'ready'],
    ])
    expect(catalog.providers[1]!.info.languages).toEqual(['auto', 'ja'])
  })

  test('is unsupported only when no provider exists or every provider reports unsupported-platform', async () => {
    const { service: noRuntime } = createService([new FakeProvider({ id: 'alpha', unsupported: true })])
    const { service: mixed } = createService([
      new FakeProvider({ id: 'alpha', unsupported: true }),
      new FakeProvider({ id: 'beta' }),
    ])
    const { service: empty } = createService([])

    const unsupported = await noRuntime.catalog()
    expect(unsupported.supported).toBe(false)
    expect(unsupported.providers[0]!.preparation).toMatchObject({
      phase: 'failed',
      error: { reason: 'unsupported-platform' },
    })
    expect((await mixed.catalog()).supported).toBe(true)
    expect((await empty.catalog()).supported).toBe(false)
  })

  test('treats a provider without assets as ready', async () => {
    const { service } = createService([new FakeProvider({ id: 'cloud', location: 'cloud', needsAssets: false })])

    expect((await service.status('cloud')).preparation).toEqual({ phase: 'ready' })
  })
})

describe.each([
  ['first provider', () => new FakeProvider({ id: 'alpha', text: 'hello from alpha' }), 'hello from alpha'],
  ['second provider', () => new FakeProvider({ id: 'beta', languages: ['auto', 'zh'], text: 'hello from beta' }), 'hello from beta'],
] as const)('VoiceService lifecycle (%s)', (_label, make, expectedText) => {
  test('prepare runs in the background, reports progress, then transcribes', async () => {
    const provider = make()
    const { service } = createService([provider])
    const id = provider.info.id

    expect((await service.status(id)).preparation.phase).toBe('unprepared')
    await expectRejects(service.transcribe(id, makeWav(1), 'auto', signal()), VoiceServiceError)

    // prepare() must return while the provider is still downloading.
    const started = await service.prepare(id)
    expect(started.preparation.phase).toBe('downloading')
    await provider.started
    provider.report({ phase: 'downloading', step: 'model', completedBytes: 10, totalBytes: 100 })
    expect((await service.status(id)).preparation).toMatchObject({ step: 'model', completedBytes: 10 })

    provider.finishPrepare()
    await flush()
    expect((await service.status(id)).preparation.phase).toBe('ready')

    const transcript = await service.transcribe(id, makeWav(2), 'auto', signal())
    expect(transcript).toEqual({ text: expectedText, audioSeconds: 2, inferenceSeconds: 0.25 })

    const removed = await service.removeAssets(id)
    expect(removed.preparation.phase).toBe('unprepared')
    expect(provider.removeCalls).toBe(1)
  })
})

describe('VoiceService prepare', () => {
  test('concurrent prepare calls join a single provider task', async () => {
    const provider = new FakeProvider({ id: 'alpha' })
    const { service } = createService([provider])

    const [first, second] = await Promise.all([service.prepare('alpha'), service.prepare('alpha')])
    await provider.started
    await service.prepare('alpha')

    expect(first.preparation.phase).toBe('downloading')
    expect(second.preparation.phase).toBe('downloading')
    expect(provider.prepareCalls).toBe(1)
    provider.finishPrepare()
    await flush()
  })

  test('passes the saved download source to the provider when a download starts', async () => {
    const provider = new FakeProvider({ id: 'alpha' })
    const { service } = createService([provider], { preferences: { downloadSource: 'official' } })

    await service.prepare('alpha')
    await provider.started

    expect(provider.prepareOptions).toEqual([{ downloadSource: 'official' }])
    provider.finishPrepare()
    await flush()
  })

  test('does not start a download for assets that are already installed', async () => {
    const provider = new FakeProvider({ id: 'alpha' })
    provider.installed = true
    const { service } = createService([provider])

    await service.prepare('alpha')
    await flush()

    expect(provider.prepareCalls).toBe(0)
    expect((await service.status('alpha')).preparation.phase).toBe('ready')
  })

  test('keeps the provider-reported unsupported-platform failure after prepare', async () => {
    const provider = new FakeProvider({ id: 'alpha', unsupported: true })
    const { service } = createService([provider])

    await service.prepare('alpha')
    await flush()

    expect((await service.status('alpha')).preparation).toMatchObject({
      phase: 'failed',
      error: { reason: 'unsupported-platform' },
    })
  })

  test('cancel aborts the provider, reports cancelled and allows a fresh prepare', async () => {
    const provider = new FakeProvider({ id: 'alpha' })
    const { service } = createService([provider])

    await service.prepare('alpha')
    await provider.started
    provider.resetStarted()
    const cancelled = await service.cancel('alpha')
    expect(cancelled.preparation.phase).toBe('cancelled')
    await flush()
    expect((await service.status('alpha')).preparation.phase).toBe('cancelled')

    const retry = await service.prepare('alpha')
    expect(retry.preparation.phase).toBe('downloading')
    await provider.started
    expect(provider.prepareCalls).toBe(2)
    provider.finishPrepare()
    await flush()
    expect((await service.status('alpha')).preparation.phase).toBe('ready')
  })

  test('a prepare issued right after cancel waits for the cancelled download to stop', async () => {
    const provider = new FakeProvider({ id: 'alpha' })
    provider.holdAbort = true
    const { service } = createService([provider])
    await service.prepare('alpha')
    await provider.started
    provider.resetStarted()

    await service.cancel('alpha')
    const retry = await service.prepare('alpha')
    await flush()

    // The cancelled download is still winding down, so no second one may start.
    expect(retry.preparation.phase).toBe('downloading')
    expect(provider.prepareCalls).toBe(1)

    provider.releaseAbort()
    await provider.started
    expect(provider.prepareCalls).toBe(2)
    provider.finishPrepare()
    await flush()
    expect((await service.status('alpha')).preparation.phase).toBe('ready')
  })

  test('cancel without a running download is a no-op status read', async () => {
    const provider = new FakeProvider({ id: 'alpha' })
    const { service } = createService([provider])

    expect((await service.cancel('alpha')).preparation.phase).toBe('unprepared')
  })

  test('a failed download is reported with its reason and cleared by the next prepare', async () => {
    const provider = new FakeProvider({ id: 'alpha' })
    const { service } = createService([provider])

    await service.prepare('alpha')
    await provider.started
    provider.resetStarted()
    provider.report({
      phase: 'failed',
      error: { reason: 'dns', source: 'https://huggingface.co', message: 'getaddrinfo ENOTFOUND' },
    })
    provider.failPrepare(new Error('network down'))
    await flush()

    expect((await service.status('alpha')).preparation).toEqual({
      phase: 'failed',
      error: { reason: 'dns', source: 'https://huggingface.co', message: 'getaddrinfo ENOTFOUND' },
    })

    await service.prepare('alpha')
    await provider.started
    expect((await service.status('alpha')).preparation.phase).toBe('downloading')
    provider.finishPrepare()
    await flush()
  })

  test('an unreported provider error becomes an unknown failure', async () => {
    const provider = new FakeProvider({ id: 'alpha' })
    const { service } = createService([provider])

    await service.prepare('alpha')
    await provider.started
    provider.failPrepare(new Error('disk exploded'))
    await flush()

    expect((await service.status('alpha')).preparation).toEqual({
      phase: 'failed',
      error: { reason: 'unknown', message: 'disk exploded' },
    })
  })

  test('removeAssets cancels a running download before deleting', async () => {
    const provider = new FakeProvider({ id: 'alpha' })
    const { service } = createService([provider])
    await service.prepare('alpha')
    await provider.started

    const removed = await service.removeAssets('alpha')

    expect(removed.preparation.phase).toBe('unprepared')
    expect(provider.removeCalls).toBe(1)
  })

  test('a prepare issued while assets are being removed waits for the removal to finish', async () => {
    const provider = new FakeProvider({ id: 'alpha' })
    provider.installed = true
    let finishRemoval!: () => void
    const removal = new Promise<void>(resolve => { finishRemoval = resolve })
    const originalRemove = provider.preparation!.remove
    provider.preparation!.remove = async () => {
      await removal
      await originalRemove()
    }
    const { service } = createService([provider])

    const removing = service.removeAssets('alpha')
    await flush()
    await service.prepare('alpha')
    await flush()

    // The new download must not start (and get deleted) while removal is in flight.
    expect(provider.prepareCalls).toBe(0)

    finishRemoval()
    await removing
    await provider.started

    expect(provider.removeCalls).toBe(1)
    expect(provider.prepareCalls).toBe(1)
  })

  test('unknown providers are rejected by every provider operation', async () => {
    const { service } = createService([new FakeProvider({ id: 'alpha' })])

    for (const call of [
      () => service.status('nope'),
      () => service.prepare('nope'),
      () => service.cancel('nope'),
      () => service.removeAssets('nope'),
    ]) {
      const error = await expectRejects(call(), VoiceServiceError)
      expect(error.code).toBe('voice/unknown-provider')
      expect(error.status).toBe(404)
    }
  })
})

describe('VoiceService transcribe', () => {
  function readyService(overrides: ConstructorParameters<typeof FakeProvider>[0] = { id: 'alpha' }) {
    const provider = new FakeProvider(overrides)
    provider.installed = true
    return { provider, ...createService([provider]) }
  }

  test('uses preferred provider and language when none are given', async () => {
    const { service, provider, preferences } = readyService()
    preferences.current = { ...preferences.current, providerId: 'alpha', language: 'zh' }

    await service.transcribe(undefined, makeWav(1), undefined, signal())

    expect(provider.transcribeCalls).toEqual([{ bytes: makeWav(1).byteLength, language: 'zh' }])
  })

  test('falls back to auto when the saved language is not offered by the provider', async () => {
    const { service, provider, preferences } = readyService({ id: 'alpha', languages: ['auto', 'en'] })
    preferences.current = { ...preferences.current, language: 'yue' }

    await service.transcribe(undefined, makeWav(1), undefined, signal())

    expect(provider.transcribeCalls[0]!.language).toBe('auto')
  })

  test('rejects an explicit language the provider does not list', async () => {
    const { service } = readyService({ id: 'alpha', languages: ['auto', 'en'] })

    const error = await expectRejects(service.transcribe('alpha', makeWav(1), 'ja', signal()), ApiError)

    expect(error.statusCode).toBe(400)
  })

  test('rejects invalid audio before touching the provider', async () => {
    const { service, provider } = readyService()

    const error = await expectRejects(service.transcribe('alpha', new Uint8Array(100), 'auto', signal()), VoiceServiceError)

    expect(error.code).toBe('voice/invalid-audio')
    expect(provider.transcribeCalls).toHaveLength(0)
  })

  test('reports not-ready while assets are missing or still downloading', async () => {
    const provider = new FakeProvider({ id: 'alpha' })
    const { service } = createService([provider])

    const missing = await expectRejects(service.transcribe('alpha', makeWav(1), 'auto', signal()), VoiceServiceError)
    expect(missing.code).toBe('voice/not-ready')
    expect(missing.status).toBe(409)

    await service.prepare('alpha')
    await provider.started
    const downloading = await expectRejects(service.transcribe('alpha', makeWav(1), 'auto', signal()), VoiceServiceError)
    expect(downloading.code).toBe('voice/not-ready')
    expect(downloading.message).toContain('downloading')
    expect(provider.transcribeCalls).toHaveLength(0)
    provider.finishPrepare()
    await flush()
  })

  test('still transcribes while the feature is disabled so settings can test it', async () => {
    const { service, provider, preferences } = readyService()
    preferences.current = { ...preferences.current, enabled: false }

    await service.transcribe('alpha', makeWav(1), 'auto', signal())

    expect(provider.transcribeCalls).toHaveLength(1)
  })

  test('wraps provider errors as voice/failed', async () => {
    const { service, provider } = readyService()
    provider.transcribeError = new Error('worker crashed')

    const error = await expectRejects(service.transcribe('alpha', makeWav(1), 'auto', signal()), VoiceServiceError)

    expect(error.code).toBe('voice/failed')
    expect(error.status).toBe(500)
    expect(error.message).toContain('worker crashed')
  })

  test('keeps a provider VoiceServiceError code instead of rewriting it to voice/failed', async () => {
    const { service, provider } = readyService()

    // A worker rejecting the audio is the caller's problem (400), and a model
    // removed after the readiness check is a conflict (409); neither is a 500.
    provider.transcribeError = new VoiceServiceError('voice/invalid-audio', 'Audio is not a WAV file')
    const invalid = await expectRejects(service.transcribe('alpha', makeWav(1), 'auto', signal()), VoiceServiceError)
    expect(invalid.code).toBe('voice/invalid-audio')
    expect(invalid.status).toBe(400)
    expect(invalid.message).toBe('Audio is not a WAV file')

    provider.transcribeError = new VoiceServiceError('voice/not-ready', 'Speech model is not downloaded yet')
    const notReady = await expectRejects(service.transcribe('alpha', makeWav(1), 'auto', signal()), VoiceServiceError)
    expect(notReady.code).toBe('voice/not-ready')
    expect(notReady.status).toBe(409)
  })

  test('rethrows the provider error untouched when the caller aborted', async () => {
    const { service, provider } = readyService()
    const controller = new AbortController()
    const abortError = new DOMException('The operation was aborted', 'AbortError')
    provider.transcribeError = abortError
    controller.abort()

    const error = await expectRejects(service.transcribe('alpha', makeWav(1), 'auto', controller.signal), DOMException)

    expect(error).toBe(abortError)
  })

  test('runs the same transcribe path for two different providers', async () => {
    const alpha = new FakeProvider({ id: 'alpha', text: 'A' })
    const beta = new FakeProvider({ id: 'beta', text: 'B', needsAssets: false, location: 'cloud' })
    alpha.installed = true
    const { service } = createService([alpha, beta])

    expect((await service.transcribe('alpha', makeWav(1), 'auto', signal())).text).toBe('A')
    expect((await service.transcribe('beta', makeWav(1), 'auto', signal())).text).toBe('B')
  })
})

describe('VoiceService preferences', () => {
  test('applies partial updates without dropping other fields', async () => {
    const { service, preferences } = createService([new FakeProvider({ id: 'alpha' })], {
      preferences: { enabled: true, language: 'en' },
    })

    expect(await service.updatePreferences({ language: 'zh' })).toEqual({
      enabled: true,
      providerId: 'alpha',
      language: 'zh',
      downloadSource: 'auto',
    })
    expect(preferences.current.enabled).toBe(true)
  })

  test('stores the download source and rejects unknown ones', async () => {
    const { service, preferences } = createService([new FakeProvider({ id: 'alpha' })])

    expect(await service.updatePreferences({ downloadSource: 'mirror' })).toMatchObject({ downloadSource: 'mirror' })
    expect(await service.updatePreferences({ downloadSource: 'official' })).toMatchObject({ downloadSource: 'official' })
    await expectRejects(service.updatePreferences({ downloadSource: 'npmmirror' }), ApiError)
    await expectRejects(service.updatePreferences({ downloadSource: 1 }), ApiError)

    expect(preferences.current.downloadSource).toBe('official')
  })

  test('rejects unknown providers, bad types and unsupported languages', async () => {
    const { service, preferences } = createService([new FakeProvider({ id: 'alpha', languages: ['auto', 'en'] })], {
      preferences: { providerId: 'alpha' },
    })
    const before = { ...preferences.current }

    expect((await expectRejects(service.updatePreferences({ providerId: 'nope' }), VoiceServiceError)).code)
      .toBe('voice/unknown-provider')
    await expectRejects(service.updatePreferences({ enabled: 'yes' }), ApiError)
    await expectRejects(service.updatePreferences({ language: 'fr' }), ApiError)
    await expectRejects(service.updatePreferences({ language: 'ja' }), ApiError)
    await expectRejects(service.updatePreferences(null), ApiError)
    await expectRejects(service.updatePreferences([]), ApiError)

    expect(preferences.current).toEqual(before)
  })

  test('switching provider resets a language the new provider cannot serve', async () => {
    const { service } = createService(
      [
        new FakeProvider({ id: 'alpha', languages: ['auto', 'zh', 'yue'] }),
        new FakeProvider({ id: 'beta', languages: ['auto', 'en'] }),
      ],
      { preferences: { providerId: 'alpha', language: 'yue' } },
    )

    expect(await service.updatePreferences({ providerId: 'beta' })).toMatchObject({
      providerId: 'beta',
      language: 'auto',
    })
  })
})
