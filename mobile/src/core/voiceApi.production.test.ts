import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment, removeTestSandbox } from '../../../scripts/pr/test-environment'

test('mobile WAV uploads agree with the production voice handler and a deterministic provider', () => {
  const sandboxHome = mkdtempSync(join(tmpdir(), 'mobile-voice-contract-'))
  try {
    const env = createSandboxedTestEnvironment(sandboxHome)
    const resultPath = join(sandboxHome, 'voice-contract-result.json')
    const source = (path: string) => JSON.stringify(new URL(path, import.meta.url).href)
    // Keep server imports inside the isolated process: this mobile project's
    // typecheck and native bundle must not load the server's runtime graph.
    const script = `
      import assert from 'node:assert/strict'
      import { writeFileSync, writeSync } from 'node:fs'
      const report = value => writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(value))
      report({ phase: 'started' })
      try {
        assert.equal(process.env.HOME, ${JSON.stringify(sandboxHome)})
        globalThis.fetch = () => { throw new Error('Network is forbidden in the voice contract test') }
        const { ApiClient } = await import(${source('./client.ts')})
        const { loadVoiceCatalog, transcribeVoice } = await import(${source('./voiceApi.ts')})
        const { handleVoiceApi } = await import(${source('../../../src/server/api/voice.ts')})
        const { VoiceService } = await import(${source('../../../src/server/services/voice/voiceService.ts')})
        const { VoiceProviderRegistry } = await import(${source('../../../src/server/services/voice/registry.ts')})
        const { FakeProvider, makeWav, memoryPreferencesStore } = await import(${source('../../../src/server/services/voice/__tests__/fakeProvider.ts')})
        const provider = new FakeProvider({ id: 'fixture-local', text: '来自电脑的离线转写' })
        const preferences = memoryPreferencesStore({ providerId: provider.info.id })
        const service = new VoiceService({ registry: new VoiceProviderRegistry().register(provider), preferences })
        const host = { id: 'fixture', name: 'Computer', url: 'https://voice.fixture.invalid', auth: 'remote' }
        const fetch = async (url, init) => {
          assert.equal(init.headers.Authorization, 'Bearer fixture-handler-token')
          assert.equal(init.headers.Origin, host.url)
          const target = new URL(url)
          return handleVoiceApi(new Request(url, init), target, target.pathname.split('/').filter(Boolean), service)
        }
        const client = new ApiClient(host, 'fixture-handler-token', { fetch })
        const before = await loadVoiceCatalog(client)
        assert.equal(before.providers[0].info.id, 'fixture-local')
        assert.equal(before.providers[0].preparation.phase, 'unprepared')
        assert.deepEqual(before.limits, { maxAudioSeconds: 120, maxAudioBytes: 4 * 1024 * 1024 })
        await assert.rejects(transcribeVoice(client, makeWav(0.5)), error => error.status === 409 && error.code === 'voice/not-ready')
        provider.installed = true
        assert.equal((await loadVoiceCatalog(client)).providers[0].preparation.phase, 'ready')
        const transcript = await transcribeVoice(client, makeWav(0.5), { language: 'zh' })
        assert.deepEqual(transcript, { text: '来自电脑的离线转写', audioSeconds: 0.5, inferenceSeconds: 0.25 })
        assert.deepEqual(provider.transcribeCalls, [{ bytes: 16044, language: 'zh' }])
        await assert.rejects(transcribeVoice(client, new Uint8Array([1, 2])), error => error.status === 400 && error.code === 'voice/invalid-audio')
        assert.equal(provider.prepareCalls, 0)
        assert.deepEqual(preferences.current, before.preferences)
        report({ ok: true, transcript, prepareCalls: 0, unchangedPreferences: true })
      } catch (error) {
        report({ message: error.message })
        writeSync(2, String(error.stack || error))
        process.exitCode = 1
      }
      process.exit(process.exitCode || 0)
    `
    const result = spawnSync(process.execPath, [
      '--no-env-file', '--preload',
      new URL('../../../preload.ts', import.meta.url).pathname,
      '-e', script,
    ], { cwd: sandboxHome, env: { ...env, NODE_ENV: 'test' }, encoding: 'utf8', timeout: 15000 })
    const report = existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : 'No child report'
    if (result.status !== 0) throw new Error(`Isolated voice contract failed: ${report}\n${result.error?.message ?? ''}\n${result.stderr}`)
    expect(JSON.parse(report)).toEqual({
      ok: true,
      transcript: { text: '来自电脑的离线转写', audioSeconds: 0.5, inferenceSeconds: 0.25 },
      prepareCalls: 0,
      unchangedPreferences: true,
    })
  } finally { removeTestSandbox(sandboxHome, 'mobile voice contract') }
}, 20000)
