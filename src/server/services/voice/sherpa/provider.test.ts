import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, truncate, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { partPathFor } from '../download/index.js'
import { bypassProxyForLoopback, makeContent } from '../download/httpFixture.testUtil.js'
import { VoiceServiceError } from '../errors.js'
import { VOICE_LIMITS, type VoicePreparationState } from '../types.js'
import { makeWav } from './__fixtures__/wav.js'
import { startFakeAssets, type FakeAssets, type FakeModelFile } from './__fixtures__/fakeAssets.js'
import { totalDownloadBytes } from './assets.js'
import { modelLayout } from './layout.js'
import {
  FUNASR_NANO_MODEL,
  LOCAL_MODELS,
  QWEN3_ASR_MODEL,
  SENSEVOICE_MODEL,
  installItems,
  type LocalModelSpec,
} from './models.js'
import { WORKER_CONFIG_ENV, type WorkerConfig } from './protocol.js'
import { createLocalModelProvider, type LocalModelProvider, type LocalModelProviderOptions } from './provider.js'
import type { SpawnWorker } from './recognizer.js'

const fakeWorker = fileURLToPath(new URL('./__fixtures__/fakeWorker.mjs', import.meta.url))
const spawnFake: SpawnWorker = ({ env, cwd }) => spawn(process.execPath, [fakeWorker], { env, cwd, stdio: 'pipe' })
const noSleep = async () => {}

let restoreProxyEnv: () => void
let dataRoot: string
let assets: FakeAssets | undefined
let extraAssets: FakeAssets[]
let providers: LocalModelProvider[]

beforeAll(() => { restoreProxyEnv = bypassProxyForLoopback() })
afterAll(() => { restoreProxyEnv() })

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), 'voice-provider-'))
  providers = []
  extraAssets = []
})

afterEach(async () => {
  await Promise.all(providers.map(provider => provider.dispose()))
  await assets?.close()
  assets = undefined
  await Promise.all(extraAssets.map(extra => extra.close()))
  await rm(dataRoot, { recursive: true, force: true })
})

async function setup(
  behaviors: Parameters<typeof startFakeAssets>[0] = {},
  overrides: Partial<LocalModelProviderOptions> = {},
  tampered: Parameters<typeof startFakeAssets>[1] = {},
): Promise<LocalModelProvider> {
  assets = await startFakeAssets(behaviors, tampered)
  return make(overrides)
}

function make(
  overrides: Partial<LocalModelProviderOptions> = {},
  spec: LocalModelSpec = SENSEVOICE_MODEL,
  fake: FakeAssets = assets!,
): LocalModelProvider {
  const provider = createLocalModelProvider(spec, {
    dataRoot,
    items: fake.items,
    fetch: (input, init) => fetch(input, init as RequestInit),
    sleep: noSleep,
    spawnWorker: spawnFake,
    download: { maxRetries: 0, progressIntervalMs: 0, probeTimeoutMs: 100 },
    ...overrides,
  })
  providers.push(provider)
  return provider
}

async function prepareCollecting(provider: LocalModelProvider, signal = new AbortController().signal) {
  const states: VoicePreparationState[] = []
  const error = await provider.preparation.prepare(signal, state => states.push(state)).then(() => undefined, e => e)
  return { states, error }
}

const exists = (path: string) => stat(path).then(() => true, () => false)

describe('provider info and pinned assets', () => {
  it('describes the local SenseVoice provider with the size of what it downloads', () => {
    const provider = createLocalModelProvider(SENSEVOICE_MODEL, { dataRoot, platform: { platform: 'darwin', arch: 'arm64' } })
    providers.push(provider)
    expect(provider.info).toEqual({
      id: 'sensevoice-local',
      name: 'SenseVoice Small (INT8)',
      location: 'local',
      languages: ['auto', 'zh', 'en', 'ja', 'ko', 'yue'],
      // sherpa-onnx-node + sherpa-onnx-darwin-arm64 + model.int8.onnx + tokens.txt + silero_vad.onnx
      downloadBytes: 11_954 + 10_047_754 + 239_233_841 + 315_894 + 1_807_522,
    })
  })

  it.each([
    ['darwin', 'arm64', 'sherpa-onnx-darwin-arm64'],
    ['darwin', 'x64', 'sherpa-onnx-darwin-x64'],
    ['linux', 'x64', 'sherpa-onnx-linux-x64'],
    ['linux', 'arm64', 'sherpa-onnx-linux-arm64'],
    ['win32', 'x64', 'sherpa-onnx-win-x64'],
  ] as const)('maps %s/%s to %s and pins every download', (platform, arch, nativePackage) => {
    const provider = createLocalModelProvider(SENSEVOICE_MODEL, { dataRoot, platform: { platform, arch } })
    providers.push(provider)
    const platformKey = nativePackage.replace('sherpa-onnx-', '')
    const items = installItems(SENSEVOICE_MODEL, platformKey as Parameters<typeof installItems>[1])
    expect(items.map(item => item.target)).toEqual([
      'sherpa-onnx-node', nativePackage, 'model.int8.onnx', 'tokens.txt', 'silero_vad.onnx',
    ])
    expect(provider.info.downloadBytes).toBe(totalDownloadBytes(items))
    for (const { asset } of items) {
      expect(asset.bytes).toBeGreaterThan(0)
      expect(asset.urls.length).toBeGreaterThanOrEqual(2)
      expect(new Set(asset.urls.map(url => new URL(url).origin)).size).toBe(asset.urls.length)
      if (asset.name.endsWith('.tgz')) {
        expect(asset.hash).toMatchObject({ algorithm: 'sha512', encoding: 'base64' })
        expect(asset.hash.value).toMatch(/^[A-Za-z0-9+/]{86}==$/)
        expect(asset.urls[0]).toBe(`https://registry.npmjs.org/${asset.name.replace('-1.13.8.tgz', '')}/-/${asset.name}`)
        expect(asset.urls[1]).toStartWith('https://registry.npmmirror.com/')
      } else {
        expect(asset.hash).toMatchObject({ algorithm: 'sha256', encoding: 'hex' })
        expect(asset.hash.value).toMatch(/^[a-f0-9]{64}$/)
        expect(asset.urls[0]).toStartWith('https://huggingface.co/')
        expect(asset.urls[1]).toStartWith('https://hf-mirror.com/')
      }
    }
  })

  it.each([
    ['auto', ['https://registry.npmjs.org', 'https://registry.npmmirror.com'], ['https://huggingface.co', 'https://hf-mirror.com']],
    ['official', ['https://registry.npmjs.org'], ['https://huggingface.co']],
    ['mirror', ['https://registry.npmmirror.com'], ['https://hf-mirror.com']],
  ] as const)('download source %s selects only its hosts, official first, for every model', (source, npmOrigins, modelOrigins) => {
    for (const spec of LOCAL_MODELS) {
      const items = installItems(spec, 'win-x64', source)
      const auto = installItems(spec, 'win-x64')
      // The source only changes where bytes come from, never what is installed.
      expect(items.map(item => [item.target, item.asset.bytes, item.asset.hash])).toEqual(
        auto.map(item => [item.target, item.asset.bytes, item.asset.hash]),
      )
      for (const { asset } of items) {
        const origins = asset.urls.map(url => new URL(url).origin)
        expect(origins).toEqual([...(asset.name.endsWith('.tgz') ? npmOrigins : modelOrigins)])
      }
    }
  })

  // Hugging Face LFS records at the pinned commits; merges.txt is a plain git file, hashed after download.
  const LLM_PINS = [
    {
      spec: FUNASR_NANO_MODEL,
      id: 'funasr-nano-local',
      name: 'Fun-ASR-Nano',
      resolve: 'csukuangfj/sherpa-onnx-funasr-nano-int8-2025-12-30/resolve/6f16bd378457e13f36ccf3910df9017f96c346fb',
      files: [
        ['encoder_adaptor.int8.onnx', 237_792_748, 'f36dea2e30fbc33b5db1d7a7265cc976c5e5586c77b042d5adb1ad27c72db422'],
        ['llm.int8.onnx', 600_356_593, 'dfbf9aa3be41bccc257587f151e15c63fbe1b549f2b517f5ccd5bdce3bf4322a'],
        ['embedding.int8.onnx', 155_584_380, '95e61cd0c9c3b9543339a4cf973c95c116815e745ccc1e0285cbd81f76d18644'],
        ['Qwen3-0.6B/merges.txt', 1_671_853, '8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5'],
        ['Qwen3-0.6B/tokenizer.json', 11_422_654, 'aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4'],
        ['Qwen3-0.6B/vocab.json', 2_776_833, 'ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910'],
      ],
    },
    {
      spec: QWEN3_ASR_MODEL,
      id: 'qwen3-asr-local',
      name: 'Qwen3-ASR 0.6B',
      resolve: 'csukuangfj2/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25/resolve/68818b2313fe77bd06f6a7c5068ff3ef59d02b8a',
      files: [
        ['conv_frontend.onnx', 44_148_281, 'd22dc4423e0940e49884e903d2ea2f7e5567c14fc1aed97e4e26d6b8f208ef9e'],
        ['encoder.int8.onnx', 182_491_662, '60748d3e6744a57c9c91e1b17424a6c2990567e8adceb0783940c03ed98fa9d9'],
        ['decoder.int8.onnx', 755_914_231, '4f6885be5959ae26af3089d38ee7972c5fafbeeb1cf8d5e76eab6d8b61ca5771'],
        ['tokenizer/merges.txt', 1_671_853, '8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5'],
        ['tokenizer/tokenizer_config.json', 12_487, '4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c'],
        ['tokenizer/vocab.json', 2_776_833, 'ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910'],
      ],
    },
  ] as const

  it.each(LLM_PINS.map(pin => [pin.id, pin] as const))('pins every %s file at one commit on both model hosts', (_id, pin) => {
    const provider = createLocalModelProvider(pin.spec, { dataRoot, platform: { platform: 'darwin', arch: 'arm64' } })
    providers.push(provider)
    const items = installItems(pin.spec, 'darwin-arm64')
    const senseVoice = installItems(SENSEVOICE_MODEL, 'darwin-arm64')

    // The same pinned runtime and VAD as SenseVoice, installed again into this model's own directory.
    expect(items.map(item => item.target)).toEqual([
      'sherpa-onnx-node', 'sherpa-onnx-darwin-arm64', ...pin.files.map(([path]) => path), 'silero_vad.onnx',
    ])
    expect(items.slice(0, 2)).toEqual(senseVoice.slice(0, 2))
    expect(items.at(-1)).toEqual(senseVoice.at(-1))

    const official = installItems(pin.spec, 'darwin-arm64', 'official')
    const mirror = installItems(pin.spec, 'darwin-arm64', 'mirror')
    for (const [path, bytes, sha256] of pin.files) {
      const item = items.find(entry => entry.target === path)!
      expect(item).toMatchObject({ step: 'model', kind: 'file' })
      expect(item.asset).toEqual({
        name: path,
        bytes,
        hash: { algorithm: 'sha256', encoding: 'hex', value: sha256 },
        urls: [`https://huggingface.co/${pin.resolve}/${path}`, `https://hf-mirror.com/${pin.resolve}/${path}`],
      })
      expect(official.find(entry => entry.target === path)!.asset.urls).toEqual([`https://huggingface.co/${pin.resolve}/${path}`])
      expect(mirror.find(entry => entry.target === path)!.asset.urls).toEqual([`https://hf-mirror.com/${pin.resolve}/${path}`])
    }

    expect(provider.info).toEqual({
      id: pin.id,
      name: pin.name,
      location: 'local',
      languages: ['auto'],
      downloadBytes: 11_954 + 10_047_754 + pin.files.reduce((sum, [, bytes]) => sum + bytes, 0) + 1_807_522,
    })
  })

  it('gives every model its own directory under the voice data root', () => {
    expect(LOCAL_MODELS.map(spec => [spec.id, modelLayout(dataRoot, spec.dirName).base])).toEqual([
      ['sensevoice-local', join(dataRoot, 'sensevoice')],
      ['funasr-nano-local', join(dataRoot, 'funasr-nano')],
      ['qwen3-asr-local', join(dataRoot, 'qwen3-asr')],
    ])
  })

  it('prepare() contacts only the hosts of the requested download source', async () => {
    const requested: string[] = []
    const provider = createLocalModelProvider(SENSEVOICE_MODEL, {
      dataRoot,
      platform: { platform: 'win32', arch: 'x64' },
      fetch: async input => {
        requested.push(new URL(String(input)).origin)
        throw new TypeError('fetch failed')
      },
      sleep: noSleep,
      spawnWorker: spawnFake,
      download: { maxRetries: 0, progressIntervalMs: 0, probeTimeoutMs: 100 },
    })
    providers.push(provider)

    const error = await provider.preparation
      .prepare(new AbortController().signal, () => {}, { downloadSource: 'mirror' })
      .then(() => undefined, e => e)

    expect(error).toBeDefined()
    expect(requested.length).toBeGreaterThan(0)
    expect(new Set(requested)).toEqual(new Set(['https://registry.npmmirror.com']))
  })

  it('reports an unsupported platform instead of pretending it can download', async () => {
    const provider = createLocalModelProvider(SENSEVOICE_MODEL, { dataRoot, platform: { platform: 'freebsd', arch: 'x64' } })
    providers.push(provider)

    expect(await provider.preparation.status()).toMatchObject({ phase: 'failed', error: { reason: 'unsupported-platform' } })
    const states: VoicePreparationState[] = []
    const error = await provider.preparation.prepare(new AbortController().signal, state => states.push(state)).catch(e => e)
    expect(error).toBeInstanceOf(VoiceServiceError)
    expect(states.at(-1)).toMatchObject({ phase: 'failed', error: { reason: 'unsupported-platform' } })
    await expect(provider.transcribe(makeWav(1), { language: 'zh' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'voice/not-ready' })
  })
})

describe('prepare', () => {
  it('installs runtime, model and VAD in order and ends ready', async () => {
    const provider = await setup()
    expect(await provider.preparation.status()).toEqual({ phase: 'unprepared' })

    const { states, error } = await prepareCollecting(provider)

    expect(error).toBeUndefined()
    const sequence = states.map(state => `${state.phase}:${state.step ?? ''}`)
    const firstOf = (marker: string) => sequence.indexOf(marker)
    expect(firstOf('downloading:runtime')).toBeLessThan(firstOf('downloading:model'))
    expect(firstOf('downloading:model')).toBeLessThan(firstOf('downloading:vad'))
    expect(firstOf('downloading:vad')).toBeLessThan(firstOf('verifying:verify'))
    expect(states.at(-1)).toEqual({ phase: 'ready' })

    const downloading = states.filter(state => state.phase === 'downloading')
    expect(downloading.every(state => state.totalBytes === assets!.totalBytes)).toBe(true)
    const completed = downloading.map(state => state.completedBytes!)
    expect([...completed].sort((a, b) => a - b)).toEqual(completed)
    expect(downloading.at(-1)!.completedBytes).toBe(assets!.totalBytes)
    expect(downloading.some(state => state.resource === 'model.int8.onnx' && state.source?.startsWith('http://127.0.0.1'))).toBe(true)

    const layout = modelLayout(dataRoot, 'sensevoice')
    expect(await readFile(join(layout.models, 'tokens.txt'))).toEqual(assets!.byTarget['tokens.txt']!.content)
    expect(await readFile(join(layout.runtimeRoot, 'node_modules', 'sherpa-onnx-node', 'sherpa-onnx.js'), 'utf8')).toBe('module.exports = {}')
    expect(await readFile(join(layout.runtimeRoot, 'node_modules', 'sherpa-onnx-test-arch', 'sherpa-onnx.node'), 'utf8')).toBe('native-bytes')
    // No tarballs or staging directories are left behind.
    expect(await readdir(layout.downloads)).toEqual([])
    expect(await readdir(layout.staging)).toEqual([])
    expect(await provider.preparation.status()).toEqual({ phase: 'ready' })
  })

  it('answers readiness from the verified record without touching the network or rehashing', async () => {
    const provider = await setup()
    await prepareCollecting(provider)
    await assets!.close()

    expect(await provider.preparation.status()).toEqual({ phase: 'ready' })
    // A second prepare is a no-op that still ends ready.
    const again = await prepareCollecting(provider)
    expect(again.error).toBeUndefined()
    expect(again.states.at(-1)).toEqual({ phase: 'ready' })
    expect(again.states.some(state => state.phase === 'downloading')).toBe(false)
  })

  it('stays ready when only a file mtime changes (backup, copy or sync tools rewrite it)', async () => {
    const provider = await setup()
    await prepareCollecting(provider)
    const layout = modelLayout(dataRoot, 'sensevoice')
    const future = new Date(Date.now() + 60_000)

    await utimes(join(layout.models, 'model.int8.onnx'), future, future)
    await utimes(join(layout.runtimeRoot, 'node_modules', 'sherpa-onnx-node', 'sherpa-onnx.js'), future, future)

    expect(await provider.preparation.status()).toEqual({ phase: 'ready' })
  })

  it('treats a truncated, deleted or unrecorded file as not installed and repairs it', async () => {
    const provider = await setup()
    await prepareCollecting(provider)
    const layout = modelLayout(dataRoot, 'sensevoice')
    const model = join(layout.models, 'model.int8.onnx')

    await truncate(model, 100)
    expect((await provider.preparation.status()).phase).toBe('unprepared')
    await prepareCollecting(provider)
    expect(await provider.preparation.status()).toEqual({ phase: 'ready' })
    expect(await readFile(model)).toEqual(assets!.byTarget['model.int8.onnx']!.content)

    await rm(join(layout.models, 'tokens.txt'))
    expect((await provider.preparation.status()).phase).toBe('unprepared')
    await prepareCollecting(provider)
    expect(await provider.preparation.status()).toEqual({ phase: 'ready' })

    await rm(layout.manifest)
    expect((await provider.preparation.status()).phase).toBe('unprepared')
    // The files are intact, so re-recording them must not download anything again.
    const gets = assets!.byTarget['model.int8.onnx']!.fixture.gets().length
    await prepareCollecting(provider)
    expect(assets!.byTarget['model.int8.onnx']!.fixture.gets().length).toBe(gets)
  })

  it('keeps progress across an interrupted download and resumes from the partial file', async () => {
    const provider = await setup({ 'model.int8.onnx': { breakAfter: 50_000, chunkDelayMs: 2 } })

    const first = await prepareCollecting(provider)

    expect(first.states.at(-1)).toMatchObject({
      phase: 'failed', step: 'model', resource: 'model.int8.onnx', error: { reason: 'network' },
    })
    expect(first.error).toBeDefined()
    const layout = modelLayout(dataRoot, 'sensevoice')
    const partial = (await stat(partPathFor(join(layout.models, 'model.int8.onnx')))).size
    expect(partial).toBeGreaterThan(0)
    // The partial bytes are visible before the user clicks download again.
    const status = await provider.preparation.status()
    expect(status).toMatchObject({ phase: 'unprepared', totalBytes: assets!.totalBytes })
    expect(status.completedBytes).toBeGreaterThan(partial)

    assets!.byTarget['model.int8.onnx']!.fixture.behavior.breakAfter = undefined
    const second = await prepareCollecting(provider)

    expect(second.error).toBeUndefined()
    const resumed = second.states.find(state => state.resumedFromBytes !== undefined)
    const runtimeBytes = assets!.items.slice(0, 2).reduce((sum, item) => sum + item.asset.bytes, 0)
    expect(resumed?.resumedFromBytes).toBe(runtimeBytes + partial)
    expect(assets!.byTarget['model.int8.onnx']!.fixture.gets().at(-1)?.range).toBe(`bytes=${partial}-`)
    expect(await readFile(join(layout.models, 'model.int8.onnx'))).toEqual(assets!.byTarget['model.int8.onnx']!.content)
    expect(await provider.preparation.status()).toEqual({ phase: 'ready' })
  })

  it('retries interruptions on its own within one prepare', async () => {
    const provider = await setup(
      { 'model.int8.onnx': { breakAfter: 30_000, breakRequests: 2, chunkDelayMs: 2 } },
      { download: { maxRetries: 3, progressIntervalMs: 0, probeTimeoutMs: 100 } },
    )
    const { states, error } = await prepareCollecting(provider)
    expect(error).toBeUndefined()
    expect(states.at(-1)).toEqual({ phase: 'ready' })
    expect(states.some(state => (state.resumedFromBytes ?? 0) > 0)).toBe(true)
  })

  it('cancels, keeps the partial download, and continues it next time', async () => {
    const provider = await setup({ 'model.int8.onnx': { chunkDelayMs: 5 } })
    const controller = new AbortController()
    const states: VoicePreparationState[] = []

    const error = await provider.preparation.prepare(controller.signal, state => {
      states.push(state)
      if (state.resource === 'model.int8.onnx' && (state.completedBytes ?? 0) > assets!.items[0]!.asset.bytes + assets!.items[1]!.asset.bytes + 40_000) {
        controller.abort()
      }
    }).catch(e => e)

    expect(error).toBeDefined()
    expect(states.at(-1)).toMatchObject({ phase: 'cancelled', totalBytes: assets!.totalBytes })
    const layout = modelLayout(dataRoot, 'sensevoice')
    expect(await exists(partPathFor(join(layout.models, 'model.int8.onnx')))).toBe(true)

    const again = await prepareCollecting(provider)
    expect(again.error).toBeUndefined()
    expect(again.states.some(state => state.resumedFromBytes !== undefined)).toBe(true)
    expect(await provider.preparation.status()).toEqual({ phase: 'ready' })
  })

  it('reports HTTP failures with the failing resource and status', async () => {
    const provider = await setup({ 'silero_vad.onnx': { status: 404 } })
    const { states, error } = await prepareCollecting(provider)
    expect(error).toBeDefined()
    expect(states.at(-1)).toMatchObject({
      phase: 'failed', step: 'vad', resource: 'silero_vad.onnx',
      error: { reason: 'http', status: 404, resource: 'silero_vad.onnx' },
    })
    // Items that already verified stay installed.
    expect(await exists(join(modelLayout(dataRoot, 'sensevoice').models, 'model.int8.onnx'))).toBe(true)
  })

  it('rejects a tampered download and installs nothing from it', async () => {
    const tampered = Buffer.from(makeContent(120_000, 1))
    tampered[10] ^= 1
    const provider = await setup({}, {}, { 'model.int8.onnx': tampered })

    const { states } = await prepareCollecting(provider)

    expect(states.at(-1)).toMatchObject({ phase: 'failed', error: { reason: 'integrity' } })
    const layout = modelLayout(dataRoot, 'sensevoice')
    expect(await exists(join(layout.models, 'model.int8.onnx'))).toBe(false)
    expect(await exists(partPathFor(join(layout.models, 'model.int8.onnx')))).toBe(false)
    expect((await provider.preparation.status()).phase).toBe('unprepared')
  })

  it('fails when a runtime package does not contain its entry file', async () => {
    const provider = await setup({}, {
      extract: async ({ cwd, into }) => {
        // Extracts nothing: an archive with an unexpected layout.
        await writeFile(join(cwd, into, 'unrelated.txt'), 'x')
      },
    })
    const { states } = await prepareCollecting(provider)
    expect(states.at(-1)).toMatchObject({ phase: 'failed', step: 'runtime', error: { reason: 'integrity' } })
  })

  it('reports a failed unpack as a storage problem', async () => {
    const provider = await setup({}, {
      extract: async () => { throw Object.assign(new Error('tar exploded'), { code: 'ENOSPC' }) },
    })
    const { states } = await prepareCollecting(provider)
    expect(states.at(-1)).toMatchObject({ phase: 'failed', error: { reason: 'storage' } })
  })

  it('refuses a second concurrent prepare', async () => {
    const provider = await setup({ 'model.int8.onnx': { chunkDelayMs: 20 } })
    const running = prepareCollecting(provider)
    await new Promise(resolve => setTimeout(resolve, 30))
    const second = await provider.preparation.prepare(new AbortController().signal, () => {}).catch(e => e)
    expect(second.message).toContain('already running')
    expect((await running).error).toBeUndefined()
  })
})

describe('remove', () => {
  it('deletes the runtime, models and partial files', async () => {
    const provider = await setup()
    await prepareCollecting(provider)

    await provider.preparation.remove()

    expect(await exists(modelLayout(dataRoot, 'sensevoice').base)).toBe(false)
    expect(await provider.preparation.status()).toEqual({ phase: 'unprepared' })
  })

  it('stops a running worker before deleting', async () => {
    const provider = await setup()
    await prepareCollecting(provider)
    await provider.transcribe(makeWav(1), { language: 'zh' }, new AbortController().signal)
    const [pid] = (await readFile(join(modelLayout(dataRoot, 'sensevoice').models, 'starts.log'), 'utf8')).split('\n')

    await provider.preparation.remove()

    expect(() => process.kill(Number(pid), 0)).toThrow()
  })
})

describe('transcribe', () => {
  const signal = () => new AbortController().signal

  it('refuses to run before the assets are installed', async () => {
    const provider = await setup()
    const error = await provider.transcribe(makeWav(1), { language: 'zh' }, signal()).catch(e => e)
    expect(error).toBeInstanceOf(VoiceServiceError)
    expect(error.code).toBe('voice/not-ready')
  })

  it('transcribes through the worker once installed', async () => {
    const provider = await setup()
    await prepareCollecting(provider)

    const result = await provider.transcribe(makeWav(1), { language: 'ja' }, signal())

    expect(result).toEqual({ text: 'echo:ja', audioSeconds: 1, inferenceSeconds: 0.01 })
  })

  it('reclaims the idle worker after the configured time', async () => {
    const provider = await setup({}, { idleTimeoutMs: 100 })
    await prepareCollecting(provider)
    await provider.transcribe(makeWav(1), { language: 'zh' }, signal())
    const [pid] = (await readFile(join(modelLayout(dataRoot, 'sensevoice').models, 'starts.log'), 'utf8')).split('\n')

    const deadline = Date.now() + 3000
    const alive = () => { try { process.kill(Number(pid), 0); return true } catch { return false } }
    while (alive() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    expect(alive()).toBe(false)
  })

  it('release() stops the worker to free its memory; the next transcription starts it again', async () => {
    const provider = await setup()
    await prepareCollecting(provider)
    await provider.transcribe(makeWav(1), { language: 'zh' }, signal())
    const startsLog = join(modelLayout(dataRoot, 'sensevoice').models, 'starts.log')
    const [first] = (await readFile(startsLog, 'utf8')).split('\n')

    await provider.release()

    expect(() => process.kill(Number(first), 0)).toThrow()
    expect(await provider.transcribe(makeWav(1), { language: 'en' }, signal())).toMatchObject({ text: 'echo:en' })
    expect((await readFile(startsLog, 'utf8')).split('\n').filter(Boolean)).toHaveLength(2)
    // Releasing keeps the model installed.
    expect(await provider.preparation.status()).toEqual({ phase: 'ready' })
  })
})

/** Qwen3-ASR's real file layout (tokenizer files in a subdirectory), with tiny contents. */
const QWEN3_FAKE_FILES: FakeModelFile[] = [
  { target: 'conv_frontend.onnx', bytes: 20_000 },
  { target: 'encoder.int8.onnx', bytes: 40_000 },
  { target: 'decoder.int8.onnx', bytes: 60_000 },
  { target: 'tokenizer/merges.txt', bytes: 3_000 },
  { target: 'tokenizer/tokenizer_config.json', bytes: 500 },
  { target: 'tokenizer/vocab.json', bytes: 4_000 },
]

const FUNASR_NANO_FAKE_FILES: FakeModelFile[] = [
  { target: 'encoder_adaptor.int8.onnx', bytes: 40_000 },
  { target: 'llm.int8.onnx', bytes: 60_000 },
  { target: 'embedding.int8.onnx', bytes: 20_000 },
  { target: 'Qwen3-0.6B/merges.txt', bytes: 3_000 },
  { target: 'Qwen3-0.6B/tokenizer.json', bytes: 5_000 },
  { target: 'Qwen3-0.6B/vocab.json', bytes: 4_000 },
]

describe('LLM speech models', () => {
  const signal = () => new AbortController().signal

  function capturingSpawn(configs: WorkerConfig[]): SpawnWorker {
    return input => {
      configs.push(JSON.parse(input.env[WORKER_CONFIG_ENV]!))
      return spawnFake(input)
    }
  }

  it.each([
    ['Qwen3-ASR', QWEN3_ASR_MODEL, QWEN3_FAKE_FILES, 'tokenizer'],
    ['Fun-ASR-Nano', FUNASR_NANO_MODEL, FUNASR_NANO_FAKE_FILES, 'Qwen3-0.6B'],
  ] as const)('%s installs its tokenizer files under their repository subdirectory and ends ready', async (_label, spec, files, tokenizerDir) => {
    assets = await startFakeAssets({}, {}, [...files])
    const provider = make({}, spec)

    const { states, error } = await prepareCollecting(provider)

    expect(error).toBeUndefined()
    expect(states.at(-1)).toEqual({ phase: 'ready' })
    const layout = modelLayout(dataRoot, spec.dirName)
    for (const file of files) {
      expect(await readFile(join(layout.models, ...file.target.split('/')))).toEqual(assets.byTarget[file.target]!.content)
    }
    const manifest = JSON.parse(await readFile(layout.manifest, 'utf8')) as { files: Array<{ name: string }> }
    expect(manifest.files.map(entry => entry.name)).toContain(`models/${tokenizerDir}/vocab.json`)
    expect(await readdir(layout.downloads)).toEqual([])
    expect(await provider.preparation.status()).toEqual({ phase: 'ready' })

    // A tokenizer file going missing makes the model unprepared again.
    await rm(join(layout.models, tokenizerDir, 'merges.txt'))
    expect((await provider.preparation.status()).phase).toBe('unprepared')
  })

  it('hands the worker the Qwen3-ASR files and its measured segment limits', async () => {
    assets = await startFakeAssets({}, {}, QWEN3_FAKE_FILES)
    const configs: WorkerConfig[] = []
    const provider = make({ spawnWorker: capturingSpawn(configs) }, QWEN3_ASR_MODEL)
    await prepareCollecting(provider)

    expect(await provider.transcribe(makeWav(1), { language: 'auto' }, signal())).toMatchObject({ text: 'echo:auto' })

    const layout = modelLayout(dataRoot, 'qwen3-asr')
    expect(configs).toEqual([{
      runtimeRoot: layout.runtimeRoot,
      model: {
        engine: 'qwen3-asr',
        convFrontend: join(layout.models, 'conv_frontend.onnx'),
        encoder: join(layout.models, 'encoder.int8.onnx'),
        decoder: join(layout.models, 'decoder.int8.onnx'),
        tokenizer: join(layout.models, 'tokenizer'),
        maxTotalLen: 512,
        maxNewTokens: 256,
      },
      vad: join(layout.models, 'silero_vad.onnx'),
      threads: 4,
      maxAudioBytes: VOICE_LIMITS.maxAudioBytes,
      vadThreshold: 0.5,
      minSilenceSeconds: 0.5,
      minSpeechSeconds: 0.25,
      segmentSeconds: 20,
      maxSegmentSeconds: 25,
    }])
  })

  it('hands the worker the Fun-ASR-Nano files and its measured segment limits', async () => {
    assets = await startFakeAssets({}, {}, FUNASR_NANO_FAKE_FILES)
    const configs: WorkerConfig[] = []
    const provider = make({ spawnWorker: capturingSpawn(configs) }, FUNASR_NANO_MODEL)
    await prepareCollecting(provider)

    await provider.transcribe(makeWav(1), { language: 'auto' }, signal())

    const layout = modelLayout(dataRoot, 'funasr-nano')
    expect(configs).toEqual([{
      runtimeRoot: layout.runtimeRoot,
      model: {
        engine: 'funasr-nano',
        encoderAdaptor: join(layout.models, 'encoder_adaptor.int8.onnx'),
        llm: join(layout.models, 'llm.int8.onnx'),
        embedding: join(layout.models, 'embedding.int8.onnx'),
        tokenizer: join(layout.models, 'Qwen3-0.6B'),
        maxNewTokens: 256,
      },
      vad: join(layout.models, 'silero_vad.onnx'),
      threads: 4,
      maxAudioBytes: VOICE_LIMITS.maxAudioBytes,
      vadThreshold: 0.5,
      minSilenceSeconds: 0.5,
      minSpeechSeconds: 0.25,
      segmentSeconds: 15,
      maxSegmentSeconds: 20,
    }])
  })

  it('keeps the SenseVoice worker configuration it always had', async () => {
    const configs: WorkerConfig[] = []
    const provider = await setup({}, { spawnWorker: capturingSpawn(configs) })
    await prepareCollecting(provider)

    await provider.transcribe(makeWav(1), { language: 'zh' }, signal())

    const layout = modelLayout(dataRoot, 'sensevoice')
    expect(configs).toEqual([{
      runtimeRoot: layout.runtimeRoot,
      model: { engine: 'sensevoice', model: join(layout.models, 'model.int8.onnx'), tokens: join(layout.models, 'tokens.txt') },
      vad: join(layout.models, 'silero_vad.onnx'),
      threads: 2,
      maxAudioBytes: VOICE_LIMITS.maxAudioBytes,
      vadThreshold: 0.5,
      minSilenceSeconds: 0.5,
      minSpeechSeconds: 0.25,
      segmentSeconds: 30,
    }])
  })

  it('deleting one model leaves the others installed, ready and transcribing', async () => {
    assets = await startFakeAssets()
    const senseVoice = make()
    const qwenAssets = await startFakeAssets({}, {}, QWEN3_FAKE_FILES)
    extraAssets.push(qwenAssets)
    const qwen = make({}, QWEN3_ASR_MODEL, qwenAssets)
    await prepareCollecting(senseVoice)
    await prepareCollecting(qwen)
    await qwen.transcribe(makeWav(1), { language: 'auto' }, signal())

    await qwen.preparation.remove()

    expect(await exists(modelLayout(dataRoot, 'qwen3-asr').base)).toBe(false)
    expect(await qwen.preparation.status()).toEqual({ phase: 'unprepared' })
    expect(await senseVoice.preparation.status()).toEqual({ phase: 'ready' })
    expect(await senseVoice.transcribe(makeWav(1), { language: 'zh' }, signal())).toMatchObject({ text: 'echo:zh' })
  })
})

describe('SenseVoice installs made before other models existed', () => {
  const legacyManifest = fileURLToPath(new URL('./__fixtures__/legacySenseVoiceManifest.json', import.meta.url))

  /** Recreates the files the manifest describes, at their recorded sizes (sparse, so this stays fast). */
  async function restoreLegacyInstall(): Promise<void> {
    const manifest = JSON.parse(await readFile(legacyManifest, 'utf8')) as { files: Array<{ name: string; bytes: number }> }
    const base = join(dataRoot, 'sensevoice')
    for (const entry of manifest.files) {
      const path = join(base, ...entry.name.split('/'))
      await mkdir(dirname(path), { recursive: true })
      const handle = await open(path, 'w')
      await handle.truncate(entry.bytes)
      await handle.close()
    }
    await writeFile(join(base, 'verified.json'), await readFile(legacyManifest))
  }

  it('stay ready: same directory, file paths and manifest names', async () => {
    await restoreLegacyInstall()
    const provider = createLocalModelProvider(SENSEVOICE_MODEL, { dataRoot, platform: { platform: 'darwin', arch: 'arm64' } })
    providers.push(provider)

    expect(await provider.preparation.status()).toEqual({ phase: 'ready' })
  })

  it('are not mistaken for the new models, which stay separate installs', async () => {
    await restoreLegacyInstall()
    for (const spec of [FUNASR_NANO_MODEL, QWEN3_ASR_MODEL]) {
      const provider = createLocalModelProvider(spec, { dataRoot, platform: { platform: 'darwin', arch: 'arm64' } })
      providers.push(provider)
      expect(await provider.preparation.status()).toEqual({ phase: 'unprepared' })
    }
  })
})
