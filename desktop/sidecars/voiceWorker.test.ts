// @vitest-environment node

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeWav } from '../../src/server/services/voice/sensevoice/__fixtures__/wav'
import { WORKER_CONFIG_ENV, WORKER_TOKEN_ENV } from '../../src/server/services/voice/sensevoice/protocol'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const token = 'c'.repeat(64)

async function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  if (code !== 0) throw new Error(`${path.basename(command)} exited ${code}: ${stderr}`)
}

function post(port: number, body: Uint8Array, headers: Record<string, string>) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/transcribe?language=zh',
      agent: false,
      headers: { 'content-type': 'audio/wav', 'content-length': String(body.byteLength), ...headers },
    }, response => {
      let text = ''
      response.on('data', chunk => { text += String(chunk) })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text }))
    })
    req.once('error', reject)
    req.end(Buffer.from(body))
  })
}

describe('compiled desktop voice worker routing', () => {
  it('boots the real merged entrypoint as a voice worker, loads the runtime by absolute path and serves the private socket', async () => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'cc-haha-sidecar-voice-worker-')))
    const executable = path.join(directory, `claude-sidecar-voice-fixture${process.platform === 'win32' ? '.exe' : ''}`)
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: directory,
      USERPROFILE: directory,
      TMPDIR: directory,
      TMP: directory,
      TEMP: directory,
      SystemRoot: process.env.SystemRoot,
      CLAUDE_CONFIG_DIR: path.join(directory, '.claude'),
      BUN_OPTIONS: '--no-env-file',
      // preload.ts would chdir here. The worker must never load it.
      CALLER_DIR: path.join(directory, 'must-not-enter-preload'),
    }
    let child: ChildProcessWithoutNullStreams | undefined
    let exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined
    try {
      // Compile the real production entrypoint, not a handwritten worker shim.
      const build = {
        entrypoints: [path.join(repoRoot, 'desktop/sidecars/claude-sidecar.ts')],
        features: ['TRANSCRIPT_CLASSIFIER'],
        minify: { whitespace: true, identifiers: true, syntax: true },
        sourcemap: 'none',
        target: 'bun',
        external: [
          '@opentelemetry/exporter-trace-otlp-grpc', '@opentelemetry/exporter-trace-otlp-http',
          '@opentelemetry/exporter-trace-otlp-proto', '@opentelemetry/exporter-logs-otlp-grpc',
          '@opentelemetry/exporter-logs-otlp-http', '@opentelemetry/exporter-logs-otlp-proto',
          '@opentelemetry/exporter-metrics-otlp-grpc', '@opentelemetry/exporter-metrics-otlp-http',
          '@opentelemetry/exporter-metrics-otlp-proto', '@opentelemetry/exporter-prometheus',
          '@aws-sdk/client-bedrock', '@aws-sdk/client-sts', '@anthropic-ai/bedrock-sdk',
          '@anthropic-ai/foundry-sdk', '@anthropic-ai/vertex-sdk', '@azure/identity',
          '@anthropic-ai/mcpb', 'fflate', 'sharp', 'react-devtools-core',
        ],
        compile: { outfile: executable, autoloadTsconfig: true, autoloadPackageJson: true },
      }
      await run('bun', ['--no-env-file', '-e', `const r=await Bun.build(${JSON.stringify(build)});if(!r.success){console.error(r.logs);process.exit(1)}`], repoRoot, { ...env, CALLER_DIR: undefined })
      if (process.platform === 'darwin') {
        await run('/usr/bin/codesign', ['--remove-signature', executable], directory, env)
        await run('/usr/bin/codesign', ['--sign', '-', '--force', '--timestamp=none', executable], directory, env)
      }

      // A stand-in for the downloaded runtime, at the layout the installer produces.
      const runtimeRoot = path.join(directory, 'runtime')
      const packageDir = path.join(runtimeRoot, 'node_modules', 'sherpa-onnx-node')
      await mkdir(packageDir, { recursive: true })
      await writeFile(path.join(packageDir, 'sherpa-onnx.js'), `
        let language = 'auto'
        class OfflineRecognizer {
          constructor() {}
          createStream() { return { samples: 0, acceptWaveform(a) { this.samples += a.samples.length } } }
          setConfig(config) { language = config.modelConfig.senseVoice.language }
          decode() {}
          getResult(stream) { return { text: 'compiled-' + language + ':' + stream.samples } }
        }
        class Vad {
          constructor() { this.total = 0; this.ready = [] }
          acceptWaveform(samples) { this.total += samples.length }
          isEmpty() { return this.ready.length === 0 }
          front() { return { samples: new Float32Array(this.total) } }
          pop() { this.ready.shift() }
          reset() { this.total = 0; this.ready = [] }
          flush() { this.ready.push(this.total) }
        }
        module.exports = { OfflineRecognizer, Vad }
      `)

      child = spawn(executable, ['--voice-worker'], {
        cwd: directory,
        stdio: 'pipe',
        env: {
          ...env,
          [WORKER_CONFIG_ENV]: JSON.stringify({
            runtimeRoot, model: 'm', tokens: 't', vad: 'v', threads: 1,
            maxAudioBytes: 4 * 1024 * 1024,
            vadThreshold: 0.5, minSilenceSeconds: 0.5, minSpeechSeconds: 0.25, segmentSeconds: 30,
          }),
          [WORKER_TOKEN_ENV]: token,
        },
      })
      exited = new Promise(resolve => child!.once('close', (code, signal) => resolve({ code, signal })))
      let stderr = ''
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      const port = await new Promise<number>((resolve, reject) => {
        let text = ''
        child!.stdout.on('data', chunk => {
          text += String(chunk)
          if (text.includes('\n')) resolve(JSON.parse(text.split('\n')[0]!).port)
        })
        child!.once('exit', code => reject(new Error(`voice worker exited ${code}: ${stderr}`)))
        setTimeout(() => reject(new Error(`voice worker never became ready: ${stderr}`)), 20_000)
      })

      const wav = makeWav(1)
      const ok = await post(port, wav, { authorization: `Bearer ${token}` })
      expect(ok.status).toBe(200)
      expect(JSON.parse(ok.body)).toMatchObject({ text: 'compiled-zh:16000', audioSeconds: 1 })
      expect((await post(port, wav, { authorization: 'Bearer nope' })).status).toBe(401)

      // The parent going away (stdin closing) is what ends the worker.
      child.stdin.end()
      expect(await exited).toEqual({ code: 0, signal: null })
      expect(stderr).toBe('')
    } finally {
      child?.kill('SIGKILL')
      if (exited) await exited
      await rm(directory, { recursive: true, force: true })
    }
  }, 120_000)
})
