import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VoiceServiceError } from '../errors.js'
import type { WorkerConfig } from './protocol.js'
import { installFakeSherpa } from './__fixtures__/fakeSherpa.js'
import { makeWav } from './__fixtures__/wav.js'
import { SenseVoiceRecognizer, isBundledWorkerHost, workerEnvironment, type RecognizerOptions, type SpawnWorker } from './recognizer.js'

const fakeWorker = fileURLToPath(new URL('./__fixtures__/fakeWorker.mjs', import.meta.url))
const wav = new Uint8Array(64)

let dir: string
let recognizers: SenseVoiceRecognizer[]

const spawnFake: SpawnWorker = ({ env, cwd }) => spawn(process.execPath, [fakeWorker], { env, cwd, stdio: 'pipe' })

function config(): WorkerConfig {
  return {
    runtimeRoot: dir,
    model: join(dir, 'model.onnx'),
    tokens: join(dir, 'tokens.txt'),
    vad: join(dir, 'vad.onnx'),
    threads: 1,
    maxAudioBytes: 1024,
    vadThreshold: 0.5,
    minSilenceSeconds: 0.5,
    minSpeechSeconds: 0.25,
    segmentSeconds: 30,
  }
}

function create(overrides: Partial<RecognizerOptions> = {}): SenseVoiceRecognizer {
  const recognizer = new SenseVoiceRecognizer({
    workerConfig: config,
    cwd: dir,
    spawnWorker: spawnFake,
    idleTimeoutMs: 0,
    killGraceMs: 500,
    ...overrides,
  })
  recognizers.push(recognizer)
  return recognizer
}

async function lines(name: string): Promise<string[]> {
  const text = await readFile(join(dir, name), 'utf8').catch(() => '')
  return text.split('\n').filter(Boolean)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const signal = () => new AbortController().signal

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'voice-recognizer-'))
  recognizers = []
})

afterEach(async () => {
  await Promise.all(recognizers.map(recognizer => recognizer.dispose()))
  await rm(dir, { recursive: true, force: true })
})

describe('SenseVoiceRecognizer', () => {
  it('starts the worker on first use and reuses it afterwards', async () => {
    const recognizer = create()
    expect(await lines('starts.log')).toEqual([])
    expect(recognizer.running).toBe(false)

    expect(await recognizer.transcribe(wav, 'zh', signal())).toEqual({ text: 'echo:zh', audioSeconds: 1, inferenceSeconds: 0.01 })
    await recognizer.transcribe(wav, 'en', signal())

    expect(await lines('starts.log')).toHaveLength(1)
    expect((await lines('requests.log')).map(line => line.split(' ')[1])).toEqual(['zh', 'en'])
    expect(recognizer.running).toBe(true)
  })

  it('authenticates with a per-process token the worker receives only through its environment', async () => {
    const recognizer = create()
    let seen: Record<string, string> = {}
    const recognizerWithSpy = create({
      spawnWorker: input => {
        seen = input.env
        return spawnFake(input)
      },
    })
    await recognizer.transcribe(wav, 'zh', signal())
    await recognizerWithSpy.transcribe(wav, 'zh', signal())
    expect(seen.CC_HAHA_VOICE_WORKER_TOKEN).toMatch(/^[a-f0-9]{64}$/)
    expect(Object.keys(seen)).not.toContain('HTTP_PROXY')
    expect(JSON.parse(seen.CC_HAHA_VOICE_WORKER_CONFIG!).model).toBe(join(dir, 'model.onnx'))
  })

  it('stops an idle worker and starts a fresh one for the next request', async () => {
    const recognizer = create({ idleTimeoutMs: 100 })
    await recognizer.transcribe(wav, 'zh', signal())
    const [first] = await lines('starts.log')
    expect(alive(Number(first))).toBe(true)

    await until(() => !alive(Number(first)))
    expect(recognizer.running).toBe(false)

    await recognizer.transcribe(wav, 'zh', signal())
    const starts = await lines('starts.log')
    expect(starts).toHaveLength(2)
    expect(starts[1]).not.toBe(first)
  })

  it('does not reclaim the worker while requests are queued', async () => {
    const recognizer = create({ idleTimeoutMs: 100 })
    const first = recognizer.transcribe(wav, 'slow', signal())
    const second = recognizer.transcribe(wav, 'slow', signal())
    await Promise.all([first, second])
    expect(await lines('starts.log')).toHaveLength(1)
  })

  it('recovers after the worker crashes mid-request', async () => {
    const recognizer = create()
    await recognizer.transcribe(wav, 'zh', signal())

    const crashed = await recognizer.transcribe(wav, 'crash', signal()).catch(error => error)
    expect(crashed).toBeInstanceOf(VoiceServiceError)
    expect(crashed.code).toBe('voice/failed')

    expect(await recognizer.transcribe(wav, 'en', signal())).toMatchObject({ text: 'echo:en' })
    expect(await lines('starts.log')).toHaveLength(2)
  })

  it('kills the worker when a request is cancelled and starts clean afterwards', async () => {
    const recognizer = create()
    const controller = new AbortController()
    const pending = recognizer.transcribe(wav, 'hold', controller.signal)
    await until(async () => (await lines('requests.log')).length === 1)
    const [pid] = (await lines('requests.log'))[0]!.split(' ')

    controller.abort(new Error('user cancelled'))
    const error = await pending.catch(e => e)
    expect(error.message).toBe('user cancelled')
    await until(() => !alive(Number(pid)))

    expect(await recognizer.transcribe(wav, 'zh', signal())).toMatchObject({ text: 'echo:zh' })
    expect(await lines('starts.log')).toHaveLength(2)
  })

  it('kills a worker that exceeds the inference timeout', async () => {
    const recognizer = create({ inferenceTimeoutMs: 150 })
    const error = await recognizer.transcribe(wav, 'hold', signal()).catch(e => e)
    expect(error).toBeInstanceOf(VoiceServiceError)
    expect(error.code).toBe('voice/failed')
    expect(error.message).toContain('timed out')
    const [pid] = (await lines('requests.log'))[0]!.split(' ')
    await until(() => !alive(Number(pid)))
    expect(recognizer.running).toBe(false)
  })

  it('never sends a request that was cancelled while waiting in the queue', async () => {
    const recognizer = create()
    const running = recognizer.transcribe(wav, 'slow', signal())
    const controller = new AbortController()
    const waiting = recognizer.transcribe(wav, 'en', controller.signal)
    controller.abort(new Error('changed my mind'))

    expect((await waiting.catch(e => e)).message).toBe('changed my mind')
    await running
    expect((await lines('requests.log')).map(line => line.split(' ')[1])).toEqual(['slow'])
  })

  it('rejects when too many requests are pending', async () => {
    const recognizer = create({ maxPending: 2 })
    const results = [
      recognizer.transcribe(wav, 'slow', signal()),
      recognizer.transcribe(wav, 'slow', signal()),
    ]
    const overflow = await recognizer.transcribe(wav, 'slow', signal()).catch(e => e)
    expect(overflow).toBeInstanceOf(VoiceServiceError)
    expect(overflow.message).toContain('queue is full')
    await expect(Promise.all(results)).resolves.toHaveLength(2)
  })

  it('maps worker input rejections to invalid-audio and keeps the worker', async () => {
    const recognizer = create()
    const error = await recognizer.transcribe(wav, 'invalid-input', signal()).catch(e => e)
    expect(error).toBeInstanceOf(VoiceServiceError)
    expect(error.code).toBe('voice/invalid-audio')

    await recognizer.transcribe(wav, 'zh', signal())
    expect(await lines('starts.log')).toHaveLength(1)
  })

  it('treats worker errors and malformed output as failures and restarts the worker', async () => {
    const recognizer = create()
    for (const language of ['error', 'garbage']) {
      const error = await recognizer.transcribe(wav, language, signal()).catch(e => e)
      expect(error.code).toBe('voice/failed')
    }
    await recognizer.transcribe(wav, 'zh', signal())
    expect(await lines('starts.log')).toHaveLength(3)
  })

  it('reports a startup failure with the worker diagnostics, then starts once the cause is gone', async () => {
    const recognizer = create()
    await writeFile(join(dir, 'fail-start'), '')
    const error = await recognizer.transcribe(wav, 'zh', signal()).catch(e => e)
    expect(error.code).toBe('voice/failed')
    expect(error.message).toContain('model failed to load')

    await rm(join(dir, 'fail-start'))
    expect(await recognizer.transcribe(wav, 'zh', signal())).toMatchObject({ text: 'echo:zh' })
  })

  it('gives up when the worker does not become ready in time', async () => {
    const recognizer = create({ startupTimeoutMs: 50 })
    await writeFile(join(dir, 'slow-start'), '')
    const error = await recognizer.transcribe(wav, 'zh', signal()).catch(e => e)
    expect(error.code).toBe('voice/failed')
    expect(error.message).toContain('startup timed out')
    const [pid] = await lines('starts.log')
    await until(() => !alive(Number(pid)))
  })

  it('stops the worker and refuses new work after dispose', async () => {
    const recognizer = create()
    await recognizer.transcribe(wav, 'zh', signal())
    const [pid] = await lines('starts.log')

    await recognizer.dispose()

    expect(alive(Number(pid))).toBe(false)
    await expect(recognizer.transcribe(wav, 'zh', signal())).rejects.toThrow('disposed')
  })
})

describe('default worker launch', () => {
  it('relaunches a compiled executable as a worker and transcribes successive recordings', async () => {
    await installFakeSherpa(dir)
    const executable = join(dir, `voice-recognizer${process.platform === 'win32' ? '.exe' : ''}`)
    const build = await Bun.build({
      entrypoints: [fileURLToPath(new URL('./__fixtures__/compiledRecognizer.ts', import.meta.url))],
      target: 'bun',
      compile: { outfile: executable },
    })
    expect(build.success).toBe(true)
    if (process.platform === 'darwin') {
      for (const args of [['--remove-signature', executable], ['--sign', '-', '--force', '--timestamp=none', executable]]) {
        const signing = Bun.spawn(['/usr/bin/codesign', ...args], { stdout: 'ignore', stderr: 'pipe' })
        expect(await signing.exited).toBe(0)
      }
    }
    const configPath = join(dir, 'config.json')
    await writeFile(configPath, JSON.stringify({ ...config(), maxAudioBytes: 200_000 }))
    const child = spawn(executable, [configPath], {
      cwd: dir,
      env: workerEnvironment({ HOME: dir, USERPROFILE: dir, TMPDIR: dir, TMP: dir, TEMP: dir, CLAUDE_CONFIG_DIR: join(dir, '.claude') }),
      stdio: 'pipe',
      windowsHide: true,
      timeout: 10_000,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    expect(stdout.trim().split('\n').map(line => JSON.parse(line))).toMatchObject([
      { text: 'zh:16000', audioSeconds: 1 },
      { text: 'en:8000', audioSeconds: 0.5 },
    ])
  }, 30_000)

  it('runs the source worker entry with Bun when not compiled, passing config and token through the environment', async () => {
    await installFakeSherpa(dir)
    // No spawnWorker override: this is the launch path the server uses from source.
    const recognizer = create({
      spawnWorker: undefined,
      workerConfig: () => ({ ...config(), maxAudioBytes: 200_000 }),
    })

    const result = await recognizer.transcribe(makeWav(1), 'ko', signal())

    expect(result).toMatchObject({ text: 'ko:16000', audioSeconds: 1 })
  })

  it('detects compiled executables by their virtual module URLs', () => {
    expect(isBundledWorkerHost('file:///$bunfs/root/claude-sidecar', false)).toBe(true)
    expect(isBundledWorkerHost('file:///B:/~BUN/root/claude-sidecar.exe', false)).toBe(true)
    expect(isBundledWorkerHost('file:///B:/%7EBUN/root/claude-sidecar.exe', false)).toBe(true)
    expect(isBundledWorkerHost('file:///B:/%7eBUN/root/claude-sidecar.exe', false)).toBe(true)
    expect(isBundledWorkerHost('file:///repo/src/server/services/voice/sensevoice/recognizer.ts', false)).toBe(false)
    expect(isBundledWorkerHost('file:///C:/project/~BUN-tools/recognizer.ts', false)).toBe(false)
    expect(isBundledWorkerHost('https://example.test/B:/%7EBUN/root/recognizer.ts', false)).toBe(false)
    expect(isBundledWorkerHost('file:///B:/%ZZ/root/recognizer.ts', false)).toBe(false)
    expect(isBundledWorkerHost('not a file URL', false)).toBe(false)
    expect(isBundledWorkerHost('file:///repo/src/x.ts', true)).toBe(true)
  })
})
