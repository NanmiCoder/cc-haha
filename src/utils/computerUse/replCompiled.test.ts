import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createComputerUseReplWorker } from './replWorker'
import type { ReplOutput } from '../../vendor/computer-use-mcp/replProtocol'

test('minified bootstrap source remains self-contained in an isolated realm', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cu-repl-minified-'))
  try {
    const entrypoint = join(directory, 'bootstrap.ts')
    const apiPath = new URL('../../vendor/computer-use-mcp/replApi.ts', import.meta.url).pathname
    await writeFile(entrypoint, `export {REPL_BOOTSTRAP_SOURCE} from ${JSON.stringify(apiPath)}`)
    const build = await Bun.build({
      entrypoints: [entrypoint],
      outdir: join(directory, 'out'),
      minify: { whitespace: true, identifiers: true, syntax: true },
      target: 'bun',
    })
    expect(build.success).toBe(true)
    const { REPL_BOOTSTRAP_SOURCE } = await import(pathToFileURL(build.outputs[0]!.path).href)
    const messages: ReplOutput[] = []
    const worker = createComputerUseReplWorker(message => {
      messages.push(message)
      if (message.type === 'invoke') {
        queueMicrotask(() => {
          void worker.receive({
            type: 'response', cellId: message.cellId, requestId: message.requestId,
            result: { content: [{ type: 'text', text: 'App=Fixture\n[g1:1] button Test' }] },
          })
        })
      }
    })
    await worker.receive({ type: 'init', bootstrap: REPL_BOOTSTRAP_SOURCE })
    await worker.receive({ type: 'run', cellId: 1, code: 'let app = await cua.getApp("Fixture"); let count = 0' })
    await worker.receive({ type: 'run', cellId: 2, code: 'for(let i=0;i<3;i++){await app.click([10,10]);count++};nodeRepl.write("done="+count)' })
    expect(messages.filter(message => message.type === 'done' && message.error)).toEqual([])
    expect(messages).toContainEqual({ type: 'emit', cellId: 2, content: { type: 'text', text: 'done=3' } })
    expect(messages.filter(message => message.type === 'invoke').map(message => message.name)).toEqual(['get_app_state', 'click', 'click', 'click'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

const suite = process.platform === 'darwin' ? describe : describe.skip

suite('Computer Use compiled worker entrypoint', () => {
  test('minified standalone binaries run persistent cells without depending on embedded assets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cu-repl-compiled-'))
    const entrypoint = join(directory, 'fixture.ts')
    const executable = join(directory, 'fixture')
    const runtimePath = new URL('./replRuntime.ts', import.meta.url).pathname
    const workerPath = new URL('./replWorker.ts', import.meta.url).pathname
    const bundledPath = new URL('../bundledMode.ts', import.meta.url).pathname
    await writeFile(entrypoint, `
      if (process.argv[2] === '--computer-use-repl-worker') {
        const {runComputerUseReplWorker} = await import(${JSON.stringify(workerPath)})
        await runComputerUseReplWorker()
      } else {
        const {ComputerUseRepl} = await import(${JSON.stringify(runtimePath)})
        const {isInBundledMode} = await import(${JSON.stringify(bundledPath)})
        const runtime = new ComputerUseRepl()
        const calls = []
        const invoke = async (name, args) => {
          calls.push({name, args})
          return {content:[{type:'text',text:'App=Fixture\\n[g1:1] button Test'}]}
        }
        try {
          const first = await runtime.run({code:'let app = await cua.getApp("Fixture"); let count = 0',timeoutMs:5000},invoke)
          const second = await runtime.run({code:'for(let i=0;i<3;i++){await app.click([10,10]);count++};nodeRepl.write("done="+count)',timeoutMs:5000},invoke)
          console.log(JSON.stringify({embedded:Bun.embeddedFiles.length,bundled:isInBundledMode(),main:Bun.main,url:import.meta.url,argv1:process.argv[1],first,second,calls}))
        } finally {
          await runtime.reset()
        }
      }
    `)
    let child: ReturnType<typeof Bun.spawn> | undefined
    try {
      const build = await Bun.build({
        entrypoints: [entrypoint],
        minify: { whitespace: true, identifiers: true, syntax: true },
        sourcemap: 'none',
        target: 'bun',
        compile: { outfile: executable },
      })
      expect(build.success).toBe(true)
      // Match the sidecar build's required signature repair using ad-hoc
      // signing only. No developer certificate or keychain is consulted.
      for (const args of [
        ['--remove-signature', executable],
        ['--sign', '-', '--force', '--timestamp=none', executable],
      ]) {
        const signing = Bun.spawn(['/usr/bin/codesign', ...args], { stdout: 'ignore', stderr: 'pipe' })
        expect(await signing.exited).toBe(0)
      }
      child = Bun.spawn([executable], {
        cwd: directory,
        env: { HOME: directory, TMPDIR: directory, CLAUDE_CONFIG_DIR: join(directory, '.claude'), PATH: '/usr/bin:/bin' },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
      const result = JSON.parse(stdout)
      expect(result.embedded).toBe(0)
      const errors = [result.first, result.second].filter(item => item.isError)
      expect(errors).toEqual([])
      expect(result.second.content).toContainEqual({ type: 'text', text: 'done=3' })
      expect(result.calls.map((call: { name: string }) => call.name)).toEqual(['get_app_state', 'click', 'click', 'click'])
    } finally {
      child?.kill()
      if (child) {
        await child.exited
      }
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
})
