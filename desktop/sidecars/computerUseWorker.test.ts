// @vitest-environment node

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { describe, expect, it } from 'vitest'
import { createComputerUseReplSandboxCommand } from '../../src/utils/computerUse/replRuntime'
import { REPL_BOOTSTRAP_SOURCE } from '../../src/vendor/computer-use-mcp/replApi'
import type { ReplInput, ReplOutput } from '../../src/vendor/computer-use-mcp/replProtocol'

const repoRoot = path.resolve(import.meta.dirname, '../..')

async function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  if (code !== 0) throw new Error(`${path.basename(command)} exited ${code}: ${stderr}\n${stdout}`)
  return stdout
}

describe.skipIf(process.platform !== 'darwin')('compiled desktop Computer Use worker routing', () => {
  it('boots the real merged entrypoint inside the production sandbox without preload and retains native App bindings', async () => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'cc-haha-sidecar-cu-worker-')))
    const executable = path.join(directory, 'claude-sidecar-aarch64-apple-darwin')
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: directory,
      TMPDIR: directory,
      TMP: directory,
      TEMP: directory,
      CLAUDE_CONFIG_DIR: path.join(directory, '.claude'),
      BUN_OPTIONS: '--no-env-file',
      // preload.ts would chdir here. The internal worker must never load it.
      CALLER_DIR: path.join(directory, 'must-not-enter-preload'),
    }
    let child: ChildProcessWithoutNullStreams | undefined
    let closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined
    try {
      // Compile the real production entrypoint, not a handwritten worker shim.
      // These are the optional externals used by build-sidecars.ts; Acorn and
      // sandbox-runtime remain bundled. No signing identity/keychain discovery.
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
      await run('/usr/bin/codesign', ['--remove-signature', executable], directory, env)
      await run('/usr/bin/codesign', ['--sign', '-', '--force', '--timestamp=none', executable], directory, env)

      const command = createComputerUseReplSandboxCommand({
        args: [executable, '--computer-use-repl-worker'],
        readable: [executable, directory],
        directory,
      })
      child = spawn('/bin/sh', ['-c', `exec ${command}`], { cwd: directory, env, stdio: 'pipe' })
      closed = new Promise(resolve => child!.once('close', (code, signal) => resolve({ code, signal })))
      const messages: ReplOutput[] = []
      const invocations: Array<{ name: string; args: unknown }> = []
      let stderr = ''
      let failure: Error | undefined
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.on('error', error => { failure = error })
      child.stdin.on('error', error => { failure = error })
      const lines = createInterface({ input: child.stdout })
      const send = (message: ReplInput) => child!.stdin.write(`${JSON.stringify(message)}\n`)
      lines.on('line', line => {
        try {
          const message = JSON.parse(line) as ReplOutput
          messages.push(message)
          if (message.type === 'invoke') {
            invocations.push({ name: message.name, args: message.args })
            send({
              type: 'response', cellId: message.cellId, requestId: message.requestId,
              result: {
                app: (message.args as { app?: string }).app === 'Replacement'
                  ? '/Applications/Replacement.app' : '/Applications/Fixture.app',
                content: [{ type: 'text', text: '<app_state>\ng1:0 window\n\tg1:1 button Test\n</app_state>' }],
              },
            })
          }
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error))
        }
      })
      async function until(predicate: () => boolean) {
        const deadline = Date.now() + 10_000
        while (!predicate()) {
          if (failure) throw failure
          if (child!.exitCode !== null || child!.signalCode !== null) {
            throw new Error(`Worker exited before readiness/completion: ${stderr}`)
          }
          if (Date.now() > deadline) throw new Error(`Worker timed out: ${stderr}`)
          await new Promise(resolve => setTimeout(resolve, 10))
        }
      }
      send({ type: 'init', bootstrap: REPL_BOOTSTRAP_SOURCE })
      await until(() => messages.some(message => message.type === 'ready'))
      send({ type: 'run', cellId: 1, code: 'let app = await cua.getApp("Fixture"); let count = 0; async function press(){await app.click([10,10]);count++}; function current(){return count}' })
      await until(() => messages.some(message => message.type === 'done' && message.cellId === 1))
      send({ type: 'run', cellId: 2, code: 'for (let i=0;i<3;i++) await press(); nodeRepl.write(count)' })
      await until(() => messages.some(message => message.type === 'done' && message.cellId === 2))
      send({ type: 'run', cellId: 3, code: 'app = await cua.getApp("Replacement"); count=10; await press(); nodeRepl.write({count,current:current()})' })
      await until(() => messages.some(message => message.type === 'done' && message.cellId === 3))
      expect(messages.filter(message => message.type === 'done' && message.error)).toEqual([])
      expect(invocations.map(call => call.name)).toEqual(['get_app_state', 'click', 'click', 'click', 'get_app_state', 'click'])
      expect(invocations[1]?.args).toEqual({ app: '/Applications/Fixture.app', x: 10, y: 10 })
      expect(invocations[5]?.args).toEqual({ app: '/Applications/Replacement.app', x: 10, y: 10 })
      expect(messages).toContainEqual({ type: 'emit', cellId: 2, content: { type: 'text', text: '3' } })
      const closureResult = messages.find(message => message.type === 'emit' && message.cellId === 3 && message.content.type === 'text' && message.content.text.includes('current'))
      expect(closureResult?.type === 'emit' && closureResult.content.type === 'text' && JSON.parse(closureResult.content.text)).toEqual({ count: 11, current: 11 })
      child.stdin.end()
      expect(await closed).toEqual({ code: 0, signal: null })
      expect(stderr).toBe('')
      expect((await readdir(directory)).filter(name => name !== path.basename(executable))).toEqual([])
    } finally {
      child?.kill('SIGKILL')
      if (closed) await closed
      await rm(directory, { recursive: true, force: true })
    }
  }, 120_000)
})
