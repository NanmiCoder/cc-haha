// @vitest-environment node

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path, { join as joinPath } from 'node:path'

import { describe, expect, it } from 'vitest'
import {
  reserveLocalPort,
  resolveHostTriple,
  resolveSidecarExecutable,
} from '../electron/services/sidecarManager'

function readBuildScript() {
  return readFileSync(path.resolve(import.meta.dirname, 'build-sidecars.ts'), 'utf8')
}

function readCliLauncher() {
  return readFileSync(
    path.resolve(import.meta.dirname, '../../bin/claude-haha'),
    'utf8',
  )
}

function readJson(pathname: string): { scripts?: Record<string, string> } {
  return JSON.parse(readFileSync(pathname, 'utf8')) as {
    scripts?: Record<string, string>
  }
}

function extractWindowsX64BunTarget(source: string) {
  const block = source.match(
    /case 'x86_64-pc-windows-msvc':([\s\S]*?)case 'aarch64-pc-windows-msvc':/,
  )?.[1] ?? ''
  const targets = [...block.matchAll(/return '([^']+)'/g)].map(match => match[1])
  return targets.at(-1) ?? null
}

type SidecarProcess = {
  child: ChildProcessWithoutNullStreams
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  logs: () => string
}

function controlledSidecarEnvironment(
  homeDir: string,
  configDir: string,
  localAccessToken: string,
): NodeJS.ProcessEnv {
  const inheritedKeys = [
    'PATH',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SystemRoot',
    'WINDIR',
    'ComSpec',
    'PATHEXT',
    'LD_LIBRARY_PATH',
    'DYLD_LIBRARY_PATH',
  ] as const
  const env: NodeJS.ProcessEnv = {}
  for (const key of inheritedKeys) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return {
    ...env,
    HOME: homeDir,
    CLAUDE_CONFIG_DIR: configDir,
    CC_HAHA_LOCAL_ACCESS_TOKEN: localAccessToken,
    NODE_ENV: 'test',
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
  }
}

function startCompiledSidecar(options: {
  executable: string
  repoRoot: string
  port: number
  env: NodeJS.ProcessEnv
}): SidecarProcess {
  const child = spawn(options.executable, [
    'server',
    '--app-root',
    options.repoRoot,
    '--host',
    '127.0.0.1',
    '--port',
    String(options.port),
  ], {
    cwd: options.repoRoot,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    output += String(chunk)
  })
  child.stderr.on('data', chunk => {
    output += String(chunk)
  })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit, rejectExit) => {
      child.once('error', rejectExit)
      child.once('exit', (code, signal) => resolveExit({ code, signal }))
    },
  )
  return { child, exited, logs: () => output }
}

/**
 * What the compiled binary must still enforce about the desktop process token.
 *
 * Loopback is trusted on its own, so reading sessions without the token is the
 * expected behaviour — plenty of legitimate local traffic (the OAuth success
 * page, `/preview-fs` links, plain `curl`) can never carry it. The token is a
 * strictly additive credential, required only on the `/api/h5-access` control
 * plane, where another program on the same box must not be able to publish the
 * user's sessions to the network.
 */
type CompiledSidecarAuthProof = {
  loopbackWithoutTokenStatus: number
  controlPlaneMissingTokenStatus: number
  controlPlaneWrongTokenStatus: number
  controlPlaneCorrectTokenStatus: number
}

async function waitForCompiledSidecar(options: {
  baseUrl: string
  expectedSessionId: string
  deadlineMs: number
  exited: SidecarProcess['exited']
  logs: () => string
  localAccessToken: string
  onAuthProbe?: (proof: CompiledSidecarAuthProof) => void
}): Promise<void> {
  const deadline = Date.now() + options.deadlineMs
  let authProbeComplete = false
  let lastFailure = 'no response received'
  while (Date.now() < deadline) {
    const exited = await Promise.race([
      options.exited.then(result => ({ exited: true as const, result })),
      new Promise<{ exited: false }>(resolveWait => {
        setTimeout(() => resolveWait({ exited: false }), 0)
      }),
    ])
    if (exited.exited) {
      throw new Error(
        `compiled sidecar exited before readiness (${JSON.stringify(exited.result)}):\n${options.logs()}`,
      )
    }
    try {
      const authorizedHeaders = {
        Authorization: `Bearer ${options.localAccessToken}`,
      }
      const health = await fetchBeforeCompiledSidecarDeadline(
        `${options.baseUrl}/health`,
        { headers: authorizedHeaders },
        deadline,
      )
      if (!health.ok) throw new Error(`health returned ${health.status}`)
      let pendingAuthProof: CompiledSidecarAuthProof | undefined
      if (!authProbeComplete) {
        const controlPlaneUrl = `${options.baseUrl}/api/h5-access`
        const [
          loopbackWithoutToken,
          controlPlaneMissingToken,
          controlPlaneWrongToken,
          controlPlaneCorrectToken,
        ] = await Promise.all([
          fetchBeforeCompiledSidecarDeadline(
            `${options.baseUrl}/api/sessions?limit=1&offset=0`,
            {},
            deadline,
          ),
          fetchBeforeCompiledSidecarDeadline(controlPlaneUrl, {}, deadline),
          fetchBeforeCompiledSidecarDeadline(
            controlPlaneUrl,
            { headers: { Authorization: 'Bearer wrong-local-access-token' } },
            deadline,
          ),
          fetchBeforeCompiledSidecarDeadline(
            controlPlaneUrl,
            { headers: authorizedHeaders },
            deadline,
          ),
        ])
        pendingAuthProof = {
          loopbackWithoutTokenStatus: loopbackWithoutToken.status,
          controlPlaneMissingTokenStatus: controlPlaneMissingToken.status,
          controlPlaneWrongTokenStatus: controlPlaneWrongToken.status,
          controlPlaneCorrectTokenStatus: controlPlaneCorrectToken.status,
        }
      }
      const sessionsResponse = await fetchBeforeCompiledSidecarDeadline(
        `${options.baseUrl}/api/sessions?limit=400&offset=0`,
        { headers: authorizedHeaders },
        deadline,
      )
      if (!sessionsResponse.ok) {
        throw new Error(`sessions returned ${sessionsResponse.status}`)
      }
      if (pendingAuthProof) {
        options.onAuthProbe?.(pendingAuthProof)
        authProbeComplete = true
      }
      const body = await sessionsResponse.json() as {
        sessions?: Array<{ id?: string }>
        total?: number
        index?: { mode?: string; state?: string; indexed?: number }
      }
      if (
        body.index?.mode === 'on' &&
        body.index.state === 'ready' &&
        body.index.indexed === 1 &&
        body.total === 1 &&
        body.sessions?.some(session => session.id === options.expectedSessionId)
      ) {
        return
      }
      lastFailure = `sessions not ready: ${JSON.stringify(body)}`
    } catch (error) {
      // Startup and backfill are asynchronous; keep polling until the deadline.
      lastFailure = error instanceof Error ? error.message : String(error)
    }
    const remainingMs = deadline - Date.now()
    if (remainingMs > 0) {
      await new Promise(resolveWait => setTimeout(resolveWait, Math.min(25, remainingMs)))
    }
  }
  throw new Error(
    `compiled sidecar did not become ready (${lastFailure}):\n${options.logs()}`,
  )
}

async function fetchBeforeCompiledSidecarDeadline(
  input: RequestInfo | URL,
  init: RequestInit,
  deadline: number,
): Promise<Response> {
  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) {
    throw new Error('compiled sidecar request deadline exceeded')
  }
  const controller = new AbortController()
  let responseAfterHeaders: Response | undefined
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined

  const operation = (async (): Promise<Response> => {
    const response = await fetch(input, { ...init, signal: controller.signal })
    responseAfterHeaders = response
    if (controller.signal.aborted) {
      try {
        const cancellation = response.body?.cancel(controller.signal.reason)
        if (cancellation) void Promise.resolve(cancellation).catch(() => {})
      } catch {
        // A fetch that ignored abort may also return a non-cancellable body.
      }
      throw controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new Error('compiled sidecar request deadline exceeded')
    }
    if (!response.body) return response

    const reader = response.body.getReader()
    activeReader = reader
    const chunks: Uint8Array[] = []
    let byteLength = 0
    try {
      while (true) {
        const result = await reader.read()
        if (result.done) break
        chunks.push(result.value)
        byteLength += result.value.byteLength
      }
    } finally {
      if (activeReader === reader) activeReader = undefined
      try {
        reader.releaseLock()
      } catch {
        // A timed-out read may still be pending on a non-cooperative stream.
      }
    }

    const body = new Uint8Array(byteLength)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new Response(body.byteLength > 0 ? body.buffer : null, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    })
  })()

  return new Promise<Response>((resolve, reject) => {
    let settled = false
    const cancelBodyBestEffort = (reason: Error): void => {
      try {
        const cancellation = activeReader
          ? activeReader.cancel(reason)
          : responseAfterHeaders?.body?.cancel(reason)
        if (cancellation) void Promise.resolve(cancellation).catch(() => {})
      } catch {
        // Cancellation is best-effort; the deadline must not wait for it.
      }
    }
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      const error = new Error('compiled sidecar request deadline exceeded')
      controller.abort(error)
      cancelBodyBestEffort(error)
      reject(error)
    }, remainingMs)

    operation.then(
      response => {
        if (settled) {
          try {
            const cancellation = response.body?.cancel()
            if (cancellation) void Promise.resolve(cancellation).catch(() => {})
          } catch {
            // Consume a late response without extending the caller deadline.
          }
          return
        }
        settled = true
        clearTimeout(timeout)
        resolve(response)
      },
      error => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(error)
      },
    )
  })
}

async function terminateCompiledSidecar(processHandle: SidecarProcess): Promise<void> {
  if (processHandle.child.exitCode !== null || processHandle.child.signalCode !== null) {
    await processHandle.exited
    return
  }
  processHandle.child.kill('SIGTERM')
  const graceful = await Promise.race([
    processHandle.exited.then(() => true),
    new Promise<boolean>(resolveWait => setTimeout(() => resolveWait(false), 10_000)),
  ])
  if (graceful) return
  processHandle.child.kill('SIGKILL')
  await processHandle.exited
}

describe('build-sidecars Windows x64 target mapping', () => {
  it('uses the running Bun executable when PATH has no bun shim', () => {
    expect(readBuildScript()).toContain(
      "[process.execPath, 'run', path.join(desktopRoot, 'scripts/scan-missing-imports.ts')]",
    )
  })

  it('uses the baseline Bun runtime so older CPUs do not crash with Illegal Instruction', () => {
    expect(extractWindowsX64BunTarget(readBuildScript())).toBe('bun-windows-x64-baseline')
  })

  it('requires an explicit opt-in before using the AVX2 Windows x64 runtime', () => {
    const source = readBuildScript()
    const block = source.match(
      /case 'x86_64-pc-windows-msvc':([\s\S]*?)case 'aarch64-pc-windows-msvc':/,
    )?.[1] ?? ''

    expect(block).toContain("CC_HAHA_BUN_WINDOWS_X64_TARGET === 'bun-windows-x64'")
    expect(block).toContain("return 'bun-windows-x64'")
  })

  it('compiles the sidecar with the transcript classifier feature', () => {
    expect(readBuildScript()).toContain("features: ['TRANSCRIPT_CLASSIFIER']")
  })

  it('starts the development CLI with the transcript classifier feature', () => {
    expect(readCliLauncher()).toContain('--feature=TRANSCRIPT_CLASSIFIER')
  })

  it('wires the opt-in compiled sidecar smoke into the native gate', () => {
    const desktopPackage = readJson(path.resolve(import.meta.dirname, '../package.json'))
    const rootPackage = readJson(path.resolve(import.meta.dirname, '../../package.json'))

    expect(desktopPackage.scripts?.['test:compiled-sidecar-smoke']).toContain(
      'CC_HAHA_RUN_COMPILED_SIDECAR_SMOKE=1',
    )
    expect(rootPackage.scripts?.['check:native']).toContain(
      'test:compiled-sidecar-smoke',
    )
  })

  it('keeps the request deadline active until a delayed response body is consumable', async () => {
    const originalFetch = globalThis.fetch
    let bodyClosed = false
    let bodyTimer: ReturnType<typeof setTimeout> | undefined
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        bodyTimer = setTimeout(() => {
          controller.enqueue(new TextEncoder().encode('{"ready":true}'))
          bodyClosed = true
          controller.close()
        }, 20)
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch

    try {
      const response = await fetchBeforeCompiledSidecarDeadline(
        'http://127.0.0.1:1/delayed-body',
        {},
        Date.now() + 250,
      )
      expect(bodyClosed).toBe(true)
      await expect(response.json()).resolves.toEqual({ ready: true })
    } finally {
      if (bodyTimer) clearTimeout(bodyTimer)
      globalThis.fetch = originalFetch
    }
  })

  it('rejects at the deadline and consumes non-cooperative late fetch settlements', async () => {
    const originalFetch = globalThis.fetch
    try {
      for (const outcome of ['resolve', 'reject'] as const) {
        let lateBodyCancelCount = 0
        let resolveFetch!: (response: Response) => void
        let rejectFetch!: (error: Error) => void
        globalThis.fetch = (() => new Promise<Response>((resolve, reject) => {
          resolveFetch = resolve
          rejectFetch = reject
        })) as typeof fetch

        const request = fetchBeforeCompiledSidecarDeadline(
          `http://127.0.0.1:1/late-${outcome}`,
          {},
          Date.now() + 10,
        )
        const lateTimer = setTimeout(() => {
          if (outcome === 'resolve') {
            resolveFetch(new Response(new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"late":'))
              },
              cancel() {
                lateBodyCancelCount += 1
              },
            }), { status: 200 }))
          } else {
            rejectFetch(new Error('late fetch rejection'))
          }
        }, 40)

        await expect(request).rejects.toThrow('compiled sidecar request deadline exceeded')
        await new Promise(resolveWait => setTimeout(resolveWait, 50))
        clearTimeout(lateTimer)
        if (outcome === 'resolve') expect(lateBodyCancelCount).toBe(1)
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('bounds a sidecar response with headers but a never-ending body and still cleans up', async () => {
    const originalFetch = globalThis.fetch
    const originalEnvironment = {
      HOME: process.env.HOME,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      CC_HAHA_LOCAL_INDEX: process.env.CC_HAHA_LOCAL_INDEX,
      CC_HAHA_LOCAL_ACCESS_TOKEN: process.env.CC_HAHA_LOCAL_ACCESS_TOKEN,
    }
    const rootDir = await mkdtemp(joinPath(tmpdir(), 'cc-haha-hung-sidecar-smoke-'))
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit, rejectExit) => {
        child.once('error', rejectExit)
        child.once('exit', (code, signal) => resolveExit({ code, signal }))
      },
    )
    const processHandle: SidecarProcess = {
      child,
      exited,
      logs: () => '',
    }
    let bodyCancelCount = 0
    let rejectCancellation: ((error: Error) => void) | undefined
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'))
      },
      cancel() {
        bodyCancelCount += 1
        return new Promise<void>((_resolve, reject) => {
          rejectCancellation = reject
        })
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch

    const startedAt = performance.now()
    let guardTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await expect(Promise.race([
        waitForCompiledSidecar({
          baseUrl: 'http://127.0.0.1:1',
          expectedSessionId: 'never-ready',
          deadlineMs: 25,
          exited,
          logs: processHandle.logs,
          localAccessToken: 'hung-sidecar-local-access-token',
        }),
        new Promise<never>((_resolve, reject) => {
          guardTimer = setTimeout(
            () => reject(new Error('never-ending response body guard fired')),
            250,
          )
        }),
      ])).rejects.toThrow('compiled sidecar did not become ready')
    } finally {
      if (guardTimer) clearTimeout(guardTimer)
      globalThis.fetch = originalFetch
      try {
        await terminateCompiledSidecar(processHandle)
      } finally {
        await rm(rootDir, { recursive: true, force: true })
      }
    }

    expect(performance.now() - startedAt).toBeLessThan(150)
    expect(bodyCancelCount).toBeGreaterThan(0)
    rejectCancellation?.(new Error('late body cancellation rejection'))
    await new Promise(resolveWait => setTimeout(resolveWait, 0))
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    expect(await stat(rootDir).then(() => true, () => false)).toBe(false)
    expect(process.env.HOME).toBe(originalEnvironment.HOME)
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(originalEnvironment.CLAUDE_CONFIG_DIR)
    expect(process.env.CC_HAHA_LOCAL_INDEX).toBe(originalEnvironment.CC_HAHA_LOCAL_INDEX)
    expect(process.env.CC_HAHA_LOCAL_ACCESS_TOKEN).toBe(
      originalEnvironment.CC_HAHA_LOCAL_ACCESS_TOKEN,
    )
  })
})

const compiledSidecarSmokeEnabled =
  process.env.CC_HAHA_RUN_COMPILED_SIDECAR_SMOKE === '1'
const configuredCompiledSidecarStarts = Number.parseInt(
  process.env.CC_HAHA_COMPILED_SIDECAR_SMOKE_STARTS ?? '',
  10,
)
const compiledSidecarSmokeStarts = Number.isInteger(configuredCompiledSidecarStarts)
  && configuredCompiledSidecarStarts >= 2
  && configuredCompiledSidecarStarts <= 50
  ? configuredCompiledSidecarStarts
  : 2

describe.skipIf(!compiledSidecarSmokeEnabled)('compiled sidecar local-index smoke', () => {
  it('uses SQLite by default, serves one indexed session, and reopens the database', async () => {
    const repoRoot = path.resolve(import.meta.dirname, '../..')
    const desktopRoot = path.resolve(import.meta.dirname, '..')
    const builtExecutable = resolveSidecarExecutable(
      desktopRoot,
      resolveHostTriple(),
    )
    await stat(builtExecutable)

    const rootDir = await mkdtemp(joinPath(tmpdir(), 'cc-haha-compiled-sidecar-smoke-'))
    const unicodeInstallDir = joinPath(rootDir, '中文 安装目录')
    const executable = process.platform === 'win32'
      ? joinPath(unicodeInstallDir, path.basename(builtExecutable))
      : builtExecutable

    const homeDir = joinPath(rootDir, '中文 用户目录')
    const configDir = joinPath(homeDir, '.claude')
    const projectDir = joinPath(configDir, 'projects', '-tmp-中文-compiled-sidecar-smoke')
    const sessionId = 'compiled-sidecar-smoke-session'
    const localAccessToken = 'compiled-sidecar-smoke-local-access-token'
    const authenticationProofs: CompiledSidecarAuthProof[] = []
    const databasePath = joinPath(
      configDir,
      'cc-haha',
      'db',
      'index-v1.sqlite',
    )
    let activeProcess: SidecarProcess | undefined

    const startAndVerify = async (): Promise<void> => {
      const port = await reserveLocalPort('127.0.0.1')
      activeProcess = startCompiledSidecar({
        executable,
        repoRoot,
        port,
        env: controlledSidecarEnvironment(homeDir, configDir, localAccessToken),
      })
      try {
        await waitForCompiledSidecar({
          baseUrl: `http://127.0.0.1:${port}`,
          expectedSessionId: sessionId,
          deadlineMs: 30_000,
          exited: activeProcess.exited,
          logs: activeProcess.logs,
          localAccessToken,
          onAuthProbe: proof => authenticationProofs.push(proof),
        })
        expect((await stat(databasePath)).isFile()).toBe(true)
      } finally {
        await terminateCompiledSidecar(activeProcess)
        activeProcess = undefined
      }
    }

    try {
      await mkdir(projectDir, { recursive: true })
      if (process.platform === 'win32') {
        await mkdir(unicodeInstallDir, { recursive: true })
        await copyFile(builtExecutable, executable)
      }
      await writeFile(
        joinPath(projectDir, `${sessionId}.jsonl`),
        `${JSON.stringify({
          parentUuid: null,
          isSidechain: false,
          type: 'user',
          message: {
            role: 'user',
            content: 'Compiled sidecar smoke prompt',
          },
          uuid: 'compiled-sidecar-smoke-user-entry',
          timestamp: '2026-07-15T00:00:00.000Z',
        })}\n`,
        'utf8',
      )

      for (let start = 0; start < compiledSidecarSmokeStarts; start += 1) {
        await startAndVerify()
      }
      expect(authenticationProofs).toHaveLength(compiledSidecarSmokeStarts)
      for (const proof of authenticationProofs) {
        expect(proof).toEqual({
          loopbackWithoutTokenStatus: 200,
          controlPlaneMissingTokenStatus: 403,
          controlPlaneWrongTokenStatus: 403,
          controlPlaneCorrectTokenStatus: 200,
        })
      }
    } finally {
      try {
        if (activeProcess) await terminateCompiledSidecar(activeProcess)
      } finally {
        await rm(rootDir, { recursive: true, force: true })
      }
    }

    expect(await stat(rootDir).then(() => true, () => false)).toBe(false)
  }, Math.max(90_000, compiledSidecarSmokeStarts * 10_000))
})

describe('build-sidecars cu-helper macOS gating', () => {
  it('guards the cu-helper build behind a darwin platform check so Windows/Linux skip it', () => {
    const source = readBuildScript()
    // The cu-helper build entrypoint must be wrapped in a `process.platform === 'darwin'`
    // guard, so non-macOS sidecar builds keep using the Python helper instead of
    // attempting a macOS-only Swift build.
    const guarded = source.match(
      /if \(process\.platform === 'darwin' && cuHelperArch\) \{\s*await buildCuHelper\(cuHelperArch\)\s*\}/,
    )
    expect(guarded).not.toBeNull()
  })

  it('invokes native/cu-helper/build.sh from the cu-helper build step', () => {
    const source = readBuildScript()
    expect(source).toMatch(/'native',\s*'cu-helper',\s*'build\.sh'/)
    expect(source).toContain('env: createCuHelperBuildEnv(targetTriple, process.env)')
  })

  it('copies the cu-helper binary and its resource bundle into the binaries dir', () => {
    const source = readBuildScript()
    // Both the bare binary AND the SwiftPM resource bundle must be copied, or the
    // LensSequence overlay assets fail to load at runtime via Bundle.module.
    expect(source).toContain('cu-helper_cc-haha-computer-use.bundle')
    expect(source).toMatch(/binariesDir,\s*'cc-haha-computer-use'/)
  })

  it('does NOT ad-hoc re-sign cu-helper (would rotate its stable TCC identity)', () => {
    const source = readBuildScript()
    // adHocSignMacBinary must only be applied to the bun-compiled sidecar, never
    // to cu-helper (build.sh already signs it with a stable hardened-runtime identity).
    const buildCuHelperBody = source.slice(source.indexOf('async function buildCuHelper()'))
    expect(buildCuHelperBody).not.toContain('adHocSignMacBinary')
  })
})
