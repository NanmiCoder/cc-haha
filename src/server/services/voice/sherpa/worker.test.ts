import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installFakeSherpa } from './__fixtures__/fakeSherpa.js'
import { makeWav } from './__fixtures__/wav.js'
import { FUNASR_NANO_MODEL, QWEN3_ASR_MODEL, SENSEVOICE_MODEL } from './models.js'
import { WORKER_CONFIG_ENV, WORKER_TOKEN_ENV, type WorkerConfig, type WorkerModel } from './protocol.js'
import { createTranscriber, splitSegment, type Sherpa } from './worker.js'

const workerMain = fileURLToPath(new URL('./workerMain.ts', import.meta.url))
const token = 'a'.repeat(64)

const senseVoiceModel: WorkerModel = { engine: 'sensevoice', model: 'model.int8.onnx', tokens: 'tokens.txt' }

function baseConfig(runtimeRoot: string, model: WorkerModel = senseVoiceModel): WorkerConfig {
  return {
    runtimeRoot,
    model,
    vad: 'silero_vad.onnx',
    threads: 1,
    maxAudioBytes: 200_000,
    vadThreshold: 0.5,
    minSilenceSeconds: 0.5,
    minSpeechSeconds: 0.25,
    segmentSeconds: 30,
  }
}

describe('createTranscriber', () => {
  /**
   * The VAD emits one segment holding everything received, plus one empty segment,
   * unless `segmentSamples` gives explicit segment lengths. `results` scripts what
   * getResult returns or throws, in decode order.
   */
  function fakeSherpa(options: { segmentSamples?: number[]; results?: Array<string | Error> } = {}) {
    const calls = {
      configs: [] as Array<{ modelConfig: Record<string, unknown> }>,
      vadConfigs: [] as Array<{ config: { sileroVad: Record<string, unknown> }; bufferSeconds: number }>,
      languages: [] as string[],
      resets: 0,
      frontArgs: [] as unknown[],
      decoded: [] as number[],
    }
    const segments: Float32Array[] = []
    const results = [...(options.results ?? [])]
    let buffered: Float32Array[] = []
    const sherpa: Sherpa = {
      OfflineRecognizer: class {
        private language = 'auto'
        constructor(config: { modelConfig: Record<string, unknown> }) {
          calls.configs.push(structuredClone(config))
        }
        createStream() {
          return { acceptWaveform: (audio: { samples: Float32Array }) => { calls.decoded.push(audio.samples.length) } }
        }
        setConfig(config: object) {
          this.language = (config as { modelConfig: { senseVoice: { language: string } } }).modelConfig.senseVoice.language
          calls.languages.push(this.language)
        }
        decode() {}
        getResult() {
          const scripted = results.shift()
          if (scripted instanceof Error) throw scripted
          if (scripted !== undefined) return { text: scripted }
          const length = calls.decoded.at(-1)
          return { text: length === 0 ? '  ' : ` ${this.language}-${length} ` }
        }
      } as unknown as Sherpa['OfflineRecognizer'],
      Vad: class {
        constructor(config: { sileroVad: Record<string, unknown> }, bufferSeconds: number) {
          calls.vadConfigs.push({ config, bufferSeconds })
        }
        acceptWaveform(samples: Float32Array) { buffered.push(Float32Array.from(samples)) }
        isEmpty() { return segments.length === 0 }
        front(external: false) {
          calls.frontArgs.push(external)
          return { samples: segments[0]! }
        }
        pop() { segments.shift() }
        reset() { calls.resets++; buffered = [] }
        flush() {
          const total = buffered.reduce((sum, part) => sum + part.length, 0)
          if (options.segmentSamples) {
            for (const length of options.segmentSamples) segments.push(new Float32Array(length))
          } else {
            // Two segments (one silent) so joining and dropping empties is exercised.
            segments.push(new Float32Array(total), new Float32Array(0))
          }
        }
      } as unknown as Sherpa['Vad'],
    }
    return { sherpa, calls }
  }

  it('segments with VAD, decodes each segment, joins non-empty text and copies buffers out of native memory', () => {
    const { sherpa, calls } = fakeSherpa()
    const transcribe = createTranscriber(baseConfig('/unused'), sherpa)

    const result = transcribe(makeWav(1), 'zh')

    expect(result.text).toBe('zh-16000')
    expect(result.audioSeconds).toBe(1)
    expect(result.inferenceSeconds).toBeGreaterThanOrEqual(0)
    expect(calls.frontArgs.length).toBeGreaterThan(0)
    expect(calls.frontArgs.every(arg => arg === false)).toBe(true)
  })

  it('sets the language and resets VAD state for every recording', () => {
    const { sherpa, calls } = fakeSherpa()
    const transcribe = createTranscriber(baseConfig('/unused'), sherpa)
    transcribe(makeWav(0.5), 'zh')
    transcribe(makeWav(0.5), 'en')
    expect(calls.languages).toEqual(['zh', 'en'])
    expect(calls.resets).toBe(2)
  })

  it('rejects unsupported languages and malformed audio before touching the recognizer', () => {
    const { sherpa, calls } = fakeSherpa()
    const transcribe = createTranscriber(baseConfig('/unused'), sherpa)
    expect(() => transcribe(makeWav(1), 'fr')).toThrow('Unsupported speech language')
    expect(() => transcribe(new Uint8Array(100), 'zh')).toThrow('WAV')
    expect(calls.languages).toEqual([])
  })

  it('builds the SenseVoice recognizer exactly as before: language hint, ITN, its tokens file, 30 s VAD segments', () => {
    const { sherpa, calls } = fakeSherpa()
    const config = { ...baseConfig('/rt', SENSEVOICE_MODEL.workerModel('/m')), threads: 2 }
    createTranscriber(config, sherpa)

    expect(calls.configs).toEqual([{
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        senseVoice: { model: join('/m', 'model.int8.onnx'), language: 'auto', useInverseTextNormalization: 1 },
        tokens: join('/m', 'tokens.txt'),
        numThreads: 2,
        provider: 'cpu',
        debug: 0,
      },
    }] as never)
    expect(calls.vadConfigs[0]!.config.sileroVad).toMatchObject({ model: 'silero_vad.onnx', maxSpeechDuration: 30, threshold: 0.5 })
  })

  it('builds the Fun-ASR-Nano recognizer from its four files, without tokens or hotwords', () => {
    const { sherpa, calls } = fakeSherpa()
    const { tuning } = FUNASR_NANO_MODEL
    createTranscriber({ ...baseConfig('/rt', FUNASR_NANO_MODEL.workerModel('/m')), ...tuning }, sherpa)

    expect(calls.configs[0]!.modelConfig).toEqual({
      funasrNano: {
        encoderAdaptor: join('/m', 'encoder_adaptor.int8.onnx'),
        llm: join('/m', 'llm.int8.onnx'),
        embedding: join('/m', 'embedding.int8.onnx'),
        tokenizer: join('/m', 'Qwen3-0.6B'),
        maxNewTokens: 256,
      },
      tokens: '',
      numThreads: tuning.threads,
      provider: 'cpu',
      debug: 0,
    })
    expect(calls.vadConfigs[0]!.config.sileroVad).toMatchObject({ maxSpeechDuration: tuning.segmentSeconds })
  })

  it('builds the Qwen3-ASR recognizer with the 512-token KV cap and near-greedy sampling, without hotwords', () => {
    const { sherpa, calls } = fakeSherpa()
    const { tuning } = QWEN3_ASR_MODEL
    createTranscriber({ ...baseConfig('/rt', QWEN3_ASR_MODEL.workerModel('/m')), ...tuning }, sherpa)

    expect(calls.configs[0]!.modelConfig).toEqual({
      qwen3Asr: {
        convFrontend: join('/m', 'conv_frontend.onnx'),
        encoder: join('/m', 'encoder.int8.onnx'),
        decoder: join('/m', 'decoder.int8.onnx'),
        tokenizer: join('/m', 'tokenizer'),
        maxTotalLen: 512,
        maxNewTokens: 256,
        temperature: 1e-6,
        topP: 0.8,
        seed: 42,
      },
      tokens: '',
      numThreads: tuning.threads,
      provider: 'cpu',
      debug: 0,
    })
    expect(calls.vadConfigs[0]!.config.sileroVad).toMatchObject({ maxSpeechDuration: tuning.segmentSeconds })
  })

  it('never sends a language hint to the LLM engines', () => {
    for (const spec of [FUNASR_NANO_MODEL, QWEN3_ASR_MODEL]) {
      const { sherpa, calls } = fakeSherpa()
      const transcribe = createTranscriber(baseConfig('/rt', spec.workerModel('/m')), sherpa)
      expect(transcribe(makeWav(1), 'zh').text).toBe('auto-16000')
      expect(calls.languages).toEqual([])
    }
  })

  it('skips a segment whose native result is not valid JSON and keeps the rest', () => {
    const { sherpa, calls } = fakeSherpa({
      segmentSamples: [16_000, 8_000, 4_000],
      results: ['第一段', new SyntaxError('JSON Parse error: Invalid UTF-8 sequence'), 'third'],
    })
    const transcribe = createTranscriber(baseConfig('/rt', QWEN3_ASR_MODEL.workerModel('/m')), sherpa)

    expect(transcribe(makeWav(2), 'auto').text).toBe('第一段 third')
    expect(calls.decoded).toEqual([16_000, 8_000, 4_000])
    // The next recording (same three segments, readable this time) is unaffected.
    expect(transcribe(makeWav(1), 'auto').text).toBe('auto-16000 auto-8000 auto-4000')
  })

  it('still fails the recording on any other recognizer error', () => {
    const { sherpa } = fakeSherpa({ results: [new Error('onnxruntime crashed')] })
    const transcribe = createTranscriber(baseConfig('/rt'), sherpa)
    expect(() => transcribe(makeWav(1), 'zh')).toThrow('onnxruntime crashed')
  })

  it('decodes a VAD segment longer than the hard cap in equal parts that fit', () => {
    // The VAD treats maxSpeechDuration as soft; a 24.4 s segment came out of a 20 s cap.
    const { sherpa, calls } = fakeSherpa({ segmentSamples: [16_000 * 24, 16_000 * 9] })
    const transcribe = createTranscriber({ ...baseConfig('/rt', FUNASR_NANO_MODEL.workerModel('/m')), maxSegmentSeconds: 20 }, sherpa)

    const result = transcribe(makeWav(1), 'auto')

    expect(calls.decoded).toEqual([16_000 * 12, 16_000 * 12, 16_000 * 9])
    expect(result.text).toBe(`auto-${16_000 * 12} auto-${16_000 * 12} auto-${16_000 * 9}`)
  })

  it('splitSegment keeps every sample, in order, in parts no longer than the cap', () => {
    const samples = Float32Array.from({ length: 1001 }, (_, i) => i)
    const parts = splitSegment(samples, 300)
    expect(parts.map(part => part.length)).toEqual([251, 251, 251, 248])
    expect(parts.flatMap(part => [...part])).toEqual([...samples])
    expect(splitSegment(samples, 1001)).toEqual([samples])
    expect(splitSegment(samples, undefined)).toEqual([samples])
  })
})

describe('worker process', () => {
  let dir: string
  let child: ChildProcessWithoutNullStreams | undefined
  let closed: Promise<void> | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-worker-'))
    child = undefined
    closed = undefined
  })

  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
    await closed
    await rm(dir, { recursive: true, force: true })
  })

  function launch(env: Record<string, string>): { stderr: () => string } {
    child = spawn(process.execPath, ['--no-env-file', workerMain], {
      cwd: dir,
      stdio: 'pipe',
      env: { PATH: process.env.PATH ?? '', ...env },
    })
    closed = new Promise(resolve => child!.once('close', () => resolve()))
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    return { stderr: () => stderr }
  }

  function start(config: WorkerConfig): Promise<{ port: number }> {
    const { stderr } = launch({ [WORKER_CONFIG_ENV]: JSON.stringify(config), [WORKER_TOKEN_ENV]: token })
    return new Promise((resolve, reject) => {
      let text = ''
      child!.stdout.on('data', chunk => {
        text += String(chunk)
        if (text.includes('\n')) resolve(JSON.parse(text.split('\n')[0]!))
      })
      child!.once('exit', code => reject(new Error(`worker exited ${code}: ${stderr()}`)))
    })
  }

  const post = (port: number, body: Uint8Array, options: { language?: string; token?: string; path?: string } = {}) =>
    fetch(`http://127.0.0.1:${port}${options.path ?? '/transcribe'}?language=${options.language ?? 'zh'}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${options.token ?? token}`, 'content-type': 'audio/wav' },
      body,
      // Keep loopback traffic off any ambient proxy.
      proxy: '',
    } as RequestInit)

  it('loads sherpa from the runtime directory by absolute path and transcribes over the private socket', async () => {
    await installFakeSherpa(dir)
    const { port } = await start(baseConfig(dir))

    const response = await post(port, makeWav(1), { language: 'ja' })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ text: 'ja:16000', audioSeconds: 1 })
  })

  it.each([
    ['funasr-nano', FUNASR_NANO_MODEL, 'funasrNano/auto:16000'],
    ['qwen3-asr', QWEN3_ASR_MODEL, 'qwen3Asr/auto:16000'],
  ] as const)('serves the %s engine from the same entry point', async (_engine, spec, text) => {
    await installFakeSherpa(dir)
    const { port } = await start({ ...baseConfig(dir, spec.workerModel(join(dir, 'models'))), ...spec.tuning })

    const response = await post(port, makeWav(1), { language: 'auto' })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ text, audioSeconds: 1 })
  })

  it('rejects unauthenticated requests, unknown endpoints and bad audio without dying', async () => {
    await installFakeSherpa(dir)
    const { port } = await start(baseConfig(dir))

    expect((await post(port, makeWav(1), { token: 'b'.repeat(64) })).status).toBe(401)
    expect((await post(port, makeWav(1), { path: '/other' })).status).toBe(404)
    expect((await post(port, new Uint8Array(10))).status).toBe(413)

    const badLanguage = await post(port, makeWav(1), { language: 'fr' })
    expect(badLanguage.status).toBe(400)
    expect(await badLanguage.json()).toMatchObject({ code: 'invalid-input' })

    expect((await post(port, new Uint8Array(100))).status).toBe(400)

    // Still serving.
    expect((await post(port, makeWav(1))).status).toBe(200)
  })

  it('exits cleanly when its parent closes stdin', async () => {
    await installFakeSherpa(dir)
    await start(baseConfig(dir))
    const exited = new Promise<number | null>(resolve => child!.once('exit', code => resolve(code)))
    child!.stdin.end()
    expect(await exited).toBe(0)
  })

  it('fails fast with a diagnostic when the runtime is missing', async () => {
    const error = await start(baseConfig(dir)).catch(e => e)
    expect(error.message).toContain('worker exited 1')
    expect(error.message).toContain('sherpa-onnx')
  })

  it.each([
    ['an unknown engine', { engine: 'whisper', model: 'm' }, 'unknown engine: whisper'],
    ['a missing engine file', { engine: 'qwen3-asr', convFrontend: 'c', encoder: 'e', tokenizer: 't', maxTotalLen: 512, maxNewTokens: 256 }, 'missing model.decoder'],
    ['the pre-engine config shape', 'model.int8.onnx', 'unknown engine'],
  ] as const)('refuses to start with %s', async (_label, model, message) => {
    await installFakeSherpa(dir)
    const error = await start({ ...baseConfig(dir), model: model as unknown as WorkerModel }).catch(e => e)
    expect(error.message).toContain('worker exited 1')
    expect(error.message).toContain(message)
  })

  it('refuses to start without a token', async () => {
    const { stderr } = launch({ [WORKER_CONFIG_ENV]: JSON.stringify(baseConfig(dir)) })
    const code = await new Promise<number | null>(resolve => child!.once('exit', c => resolve(c)))
    expect(code).toBe(1)
    expect(stderr()).toContain('without its configuration')
  })
})
