/**
 * Local speech worker process: loads sherpa-onnx with one model, then serves
 * transcriptions over an authenticated loopback HTTP socket. Native inference is
 * synchronous, so requests are naturally serialized. Nothing here may import
 * server modules; in the compiled desktop app this file is reached through
 * `claude-sidecar --voice-worker`.
 */
import { timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import {
  WORKER_CONFIG_ENV,
  WORKER_LANGUAGES,
  WORKER_MODEL_FILES,
  WORKER_TOKEN_ENV,
  type WorkerConfig,
  type WorkerEngine,
  type WorkerErrorBody,
  type WorkerModel,
  type WorkerTranscript,
} from './protocol.js'
import { WavError, readSamples } from './wav.js'

interface Stream {
  acceptWaveform(audio: { samples: Float32Array; sampleRate: number }): void
}
interface Recognizer {
  createStream(): Stream
  setConfig(config: object): void
  decode(stream: Stream): void
  getResult(stream: Stream): { text: string }
}
interface Detector {
  acceptWaveform(samples: Float32Array): void
  isEmpty(): boolean
  front(externalBuffer: false): { samples: Float32Array }
  pop(): void
  reset(): void
  flush(): void
}
export interface Sherpa {
  OfflineRecognizer: new (config: object) => Recognizer
  Vad: new (config: object, bufferSeconds: number) => Detector
}

const VAD_WINDOW = 512

/**
 * Loads sherpa-onnx-node from an explicit path. In a compiled Bun binary,
 * resolving the package by name or directory fails; the absolute entry file works.
 */
export function loadSherpa(runtimeRoot: string): Sherpa {
  const entry = join(runtimeRoot, 'node_modules', 'sherpa-onnx-node', 'sherpa-onnx.js')
  return createRequire(join(runtimeRoot, 'package.json'))(entry) as Sherpa
}

class InvalidInput extends Error {}

/**
 * The engine section of sherpa's `modelConfig`. The LLM engines decode with
 * sherpa's documented defaults (near-greedy sampling with a fixed seed) and take
 * no hotwords: biasing is left to the optional text correction step.
 */
function engineConfig(model: WorkerModel): Record<string, unknown> {
  switch (model.engine) {
    case 'sensevoice':
      return {
        senseVoice: { model: model.model, language: 'auto', useInverseTextNormalization: 1 },
        tokens: model.tokens,
      }
    case 'funasr-nano':
      return {
        funasrNano: {
          encoderAdaptor: model.encoderAdaptor,
          llm: model.llm,
          embedding: model.embedding,
          tokenizer: model.tokenizer,
          maxNewTokens: model.maxNewTokens,
        },
        tokens: '',
      }
    case 'qwen3-asr':
      return {
        qwen3Asr: {
          convFrontend: model.convFrontend,
          encoder: model.encoder,
          decoder: model.decoder,
          tokenizer: model.tokenizer,
          maxTotalLen: model.maxTotalLen,
          maxNewTokens: model.maxNewTokens,
          temperature: 1e-6,
          topP: 0.8,
          seed: 42,
        },
        tokens: '',
      }
  }
}

/** Splits a segment longer than `maxSamples` into equal consecutive parts that fit. */
export function splitSegment(samples: Float32Array, maxSamples: number | undefined): Float32Array[] {
  if (!maxSamples || samples.length <= maxSamples) return [samples]
  const parts = Math.ceil(samples.length / maxSamples)
  const size = Math.ceil(samples.length / parts)
  const out: Float32Array[] = []
  for (let start = 0; start < samples.length; start += size) out.push(samples.subarray(start, start + size))
  return out
}

/** Builds the synchronous WAV-to-text function around one loaded model and VAD. */
export function createTranscriber(
  config: WorkerConfig,
  sherpa: Sherpa,
): (wav: Uint8Array, language: string) => WorkerTranscript {
  const engine = engineConfig(config.model)
  // Only SenseVoice takes a language hint; the LLM engines detect the language themselves.
  const senseVoice = engine.senseVoice as { language: string } | undefined
  const nativeConfig = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      ...engine,
      numThreads: config.threads,
      provider: 'cpu',
      debug: 0,
    },
  }
  const maxSegmentSamples = config.maxSegmentSeconds ? Math.floor(config.maxSegmentSeconds * 16000) : undefined
  const recognizer = new sherpa.OfflineRecognizer(nativeConfig)
  const detector = new sherpa.Vad({
    sileroVad: {
      model: config.vad,
      threshold: config.vadThreshold,
      minSilenceDuration: config.minSilenceSeconds,
      minSpeechDuration: config.minSpeechSeconds,
      maxSpeechDuration: config.segmentSeconds,
      windowSize: VAD_WINDOW,
    },
    sampleRate: 16000,
    numThreads: config.threads,
    provider: 'cpu',
    debug: 0,
  }, config.segmentSeconds + config.minSilenceSeconds + 1)

  const decode = (samples: Float32Array): string => {
    const stream = recognizer.createStream()
    stream.acceptWaveform({ sampleRate: 16000, samples })
    recognizer.decode(stream)
    try {
      return recognizer.getResult(stream).text.trim()
    } catch (error) {
      // sherpa-onnx-node JSON-parses the native result; text that ends inside a UTF-8
      // sequence makes that JSON invalid. Losing one segment beats failing the recording.
      if (error instanceof SyntaxError) return ''
      throw error
    }
  }

  return (wav, language) => {
    if (!WORKER_LANGUAGES.includes(language)) throw new InvalidInput('Unsupported speech language')
    let samples: Float32Array
    try {
      samples = readSamples(wav)
    } catch (error) {
      if (error instanceof WavError) throw new InvalidInput(error.message)
      throw error
    }
    if (senseVoice) {
      senseVoice.language = language
      recognizer.setConfig(nativeConfig)
    }
    detector.reset()

    const started = performance.now()
    const texts: string[] = []
    const drain = (): void => {
      while (!detector.isEmpty()) {
        // Copy the segment out of native memory; the compiled runtime forbids external buffers.
        const segment = detector.front(false)
        for (const part of splitSegment(segment.samples, maxSegmentSamples)) texts.push(decode(part))
        detector.pop()
      }
    }
    for (let offset = 0; offset < samples.length; offset += VAD_WINDOW) {
      detector.acceptWaveform(samples.subarray(offset, offset + VAD_WINDOW))
      drain()
    }
    detector.flush()
    drain()

    return {
      text: texts.filter(Boolean).join(' ').trim(),
      audioSeconds: samples.length / 16000,
      inferenceSeconds: (performance.now() - started) / 1000,
    }
  }
}

function reply(response: import('node:http').ServerResponse, status: number, body: WorkerTranscript | WorkerErrorBody): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

/** Binds an ephemeral loopback listener. Model loading has already finished. */
export async function startWorkerServer(
  token: string,
  maxAudioBytes: number,
  transcribe: (wav: Uint8Array, language: string) => WorkerTranscript,
): Promise<{ server: Server; port: number }> {
  const expected = Buffer.from(`Bearer ${token}`)
  const server = createServer((request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? '')
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      request.resume()
      reply(response, 401, { error: 'Unauthorized' })
      return
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (request.method !== 'POST' || url.pathname !== '/transcribe') {
      request.resume()
      reply(response, 404, { error: 'Unknown endpoint' })
      return
    }
    const length = Number(request.headers['content-length'])
    if (!Number.isSafeInteger(length) || length < 46 || length > maxAudioBytes) {
      request.resume()
      reply(response, 413, { error: 'Invalid speech audio size', code: 'invalid-input' })
      return
    }
    void (async () => {
      try {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(chunk as Buffer)
        reply(response, 200, transcribe(Buffer.concat(chunks), url.searchParams.get('language') ?? 'auto'))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        reply(response, error instanceof InvalidInput ? 400 : 500, {
          error: message,
          ...(error instanceof InvalidInput ? { code: 'invalid-input' as const } : {}),
        })
      }
    })()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  return { server, port: (server.address() as { port: number }).port }
}

function readConfig(env: NodeJS.ProcessEnv): { config: WorkerConfig; token: string } {
  const raw = env[WORKER_CONFIG_ENV]
  const token = env[WORKER_TOKEN_ENV]
  delete env[WORKER_CONFIG_ENV]
  delete env[WORKER_TOKEN_ENV]
  if (!raw || !token || !/^[A-Za-z0-9_-]{32,}$/.test(token)) {
    throw new Error('Voice worker was started without its configuration')
  }
  const config = JSON.parse(raw) as WorkerConfig
  for (const key of ['runtimeRoot', 'vad'] as const) {
    if (typeof config[key] !== 'string' || !config[key]) throw new Error(`Voice worker config is missing ${key}`)
  }
  const model = (config.model ?? {}) as unknown as Record<string, unknown>
  const engine = model.engine
  if (typeof engine !== 'string' || !Object.hasOwn(WORKER_MODEL_FILES, engine)) {
    throw new Error(`Voice worker config has an unknown engine: ${String(engine)}`)
  }
  for (const key of WORKER_MODEL_FILES[engine as WorkerEngine]) {
    if (typeof model[key] !== 'string' || !model[key]) throw new Error(`Voice worker config is missing model.${key}`)
  }
  return { config, token }
}

/**
 * Worker entry. Resolves only when the parent closes stdin or sends SIGTERM/SIGINT,
 * so the process also ends if the server that spawned it disappears.
 */
export async function runVoiceWorker(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { config, token } = readConfig(env)
  const transcribe = createTranscriber(config, loadSherpa(config.runtimeRoot))
  const { server, port } = await startWorkerServer(token, config.maxAudioBytes, transcribe)

  const finished = new Promise<void>(resolve => {
    const stop = (): void => resolve()
    process.stdin.once('end', stop)
    process.stdin.once('close', stop)
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
  })
  process.stdin.resume()
  process.stdout.write(`${JSON.stringify({ port })}\n`)
  await finished
  server.close()
}
