import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installFakeSherpa } from './__fixtures__/fakeSherpa.js'
import { makeWav } from './__fixtures__/wav.js'
import { WORKER_CONFIG_ENV, WORKER_TOKEN_ENV, type WorkerConfig } from './protocol.js'
import { createTranscriber, type Sherpa } from './worker.js'

const workerMain = fileURLToPath(new URL('./workerMain.ts', import.meta.url))
const token = 'a'.repeat(64)

function baseConfig(runtimeRoot: string): WorkerConfig {
  return {
    runtimeRoot,
    model: 'model.int8.onnx',
    tokens: 'tokens.txt',
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
  function fakeSherpa() {
    const calls = { languages: [] as string[], resets: 0, frontArgs: [] as unknown[], decoded: [] as number[] }
    const segments: Float32Array[] = []
    let buffered: Float32Array[] = []
    const sherpa: Sherpa = {
      OfflineRecognizer: class {
        private language = 'auto'
        createStream() {
          return { acceptWaveform: (audio: { samples: Float32Array }) => { calls.decoded.push(audio.samples.length) } }
        }
        setConfig(config: object) {
          this.language = (config as { modelConfig: { senseVoice: { language: string } } }).modelConfig.senseVoice.language
          calls.languages.push(this.language)
        }
        decode() {}
        getResult() {
          const length = calls.decoded.at(-1)
          return { text: length === 0 ? '  ' : ` ${this.language}-${length} ` }
        }
      } as unknown as Sherpa['OfflineRecognizer'],
      Vad: class {
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
          // Two segments (one silent) so joining and dropping empties is exercised.
          segments.push(new Float32Array(total), new Float32Array(0))
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
    expect(() => transcribe(makeWav(1), 'fr')).toThrow('Unsupported SenseVoice language')
    expect(() => transcribe(new Uint8Array(100), 'zh')).toThrow('WAV')
    expect(calls.languages).toEqual([])
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

  function start(config: WorkerConfig): Promise<{ port: number }> {
    child = spawn(process.execPath, ['--no-env-file', workerMain], {
      cwd: dir,
      stdio: 'pipe',
      env: {
        PATH: process.env.PATH ?? '',
        [WORKER_CONFIG_ENV]: JSON.stringify(config),
        [WORKER_TOKEN_ENV]: token,
      },
    })
    closed = new Promise(resolve => child!.once('close', () => resolve()))
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    return new Promise((resolve, reject) => {
      let text = ''
      child!.stdout.on('data', chunk => {
        text += String(chunk)
        if (text.includes('\n')) resolve(JSON.parse(text.split('\n')[0]!))
      })
      child!.once('exit', code => reject(new Error(`worker exited ${code}: ${stderr}`)))
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

  it('refuses to start without a token', async () => {
    child = spawn(process.execPath, ['--no-env-file', workerMain], {
      cwd: dir,
      stdio: 'pipe',
      env: { PATH: process.env.PATH ?? '', [WORKER_CONFIG_ENV]: JSON.stringify(baseConfig(dir)) },
    })
    closed = new Promise(resolve => child!.once('close', () => resolve()))
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const code = await new Promise<number | null>(resolve => child!.once('exit', c => resolve(c)))
    expect(code).toBe(1)
    expect(stderr).toContain('without its configuration')
  })
})
