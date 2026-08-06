import { appendFileSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { applyUserStateGuard, createQualityGateSandbox } from '../sandbox'
import type { BaselineCase, BaselineTarget, LaneResult } from '../types'

type ServerMessage = {
  type: string
  requestId?: string
  message?: string
  code?: string
  [key: string]: unknown
}

function getPort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function waitForHttp(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // Keep polling until timeout.
    }
    await Bun.sleep(500)
  }
  throw new Error(`Timed out waiting for ${url}`)
}

async function runCommand(command: string[], cwd: string) {
  const proc = Bun.spawn(command, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  return { exitCode, stdout, stderr }
}

function listFiles(root: string, current = root): string[] {
  const files: string[] = []
  for (const entry of readdirSync(current)) {
    if (entry === 'node_modules' || entry === '.git') {
      continue
    }

    const fullPath = join(current, entry)
    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      files.push(...listFiles(root, fullPath))
      continue
    }
    if (stat.isFile()) {
      files.push(fullPath.slice(root.length + 1))
    }
  }
  return files.sort()
}

export function changedFiles(beforeDir: string, afterDir: string) {
  const before = new Set(listFiles(beforeDir))
  const after = new Set(listFiles(afterDir))
  const changed = new Set<string>()

  for (const file of before) {
    if (!after.has(file)) {
      changed.add(file)
      continue
    }
    if (!readFileSync(join(beforeDir, file)).equals(readFileSync(join(afterDir, file)))) {
      changed.add(file)
    }
  }

  for (const file of after) {
    if (!before.has(file)) {
      changed.add(file)
    }
  }

  return [...changed].sort()
}

export async function writeDiffPatch(beforeDir: string, afterDir: string, patchPath: string) {
  const result = await runCommand(['git', 'diff', '--no-index', '--', beforeDir, afterDir], process.cwd())
  writeFileSync(patchPath, `${result.stdout}${result.stderr}`)
}

function verifyChangedFiles(testCase: BaselineCase, changed: string[]) {
  const expected = testCase.verify.expectedFiles
  if (expected) {
    const unexpected = changed.filter((file) => !expected.includes(file))
    if (unexpected.length > 0) {
      throw new Error(`unexpected changed files: ${unexpected.join(', ')}`)
    }
  }

  const required = testCase.verify.requiredFiles ?? []
  const missing = required.filter((file) => !changed.includes(file))
  if (missing.length > 0) {
    throw new Error(`required files were not changed: ${missing.join(', ')}`)
  }

  const forbidden = testCase.verify.forbiddenFiles ?? []
  const forbiddenChanged = forbidden.filter((file) => changed.includes(file))
  if (forbiddenChanged.length > 0) {
    throw new Error(`forbidden files changed: ${forbiddenChanged.join(', ')}`)
  }
}

function verifyTranscript(testCase: BaselineCase, transcriptPath: string) {
  const assertions = testCase.verify.transcriptAssertions ?? []
  if (assertions.length === 0) {
    return
  }

  const transcript = readFileSync(transcriptPath, 'utf8')
  const missing = assertions.filter((assertion) => !transcript.includes(assertion))
  if (missing.length > 0) {
    throw new Error(`transcript assertions missing: ${missing.join(', ')}`)
  }
}

async function pipeToFile(stream: ReadableStream<Uint8Array> | null, path: string) {
  if (!stream) return
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    appendFileSync(path, decoder.decode(value, { stream: true }))
  }
}

function waitForWebSocketOpen(ws: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('WebSocket failed to open'))
  })
}

async function runPromptOverWebSocket(
  baseUrl: string,
  sessionId: string,
  prompt: string,
  timeoutMs: number,
  target?: BaselineTarget,
) {
  const wsUrl = baseUrl.replace(/^http/, 'ws')
  const ws = new WebSocket(`${wsUrl}/ws/${sessionId}`)
  const messages: ServerMessage[] = []

  try {
    await waitForWebSocketOpen(ws)

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for baseline case completion after ${timeoutMs}ms`))
      }, timeoutMs)

      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as ServerMessage
        messages.push(message)

        if (message.type === 'connected') {
          if (target && target.modelId !== 'current') {
            ws.send(JSON.stringify({
              type: 'set_runtime_config',
              providerId: target.providerId,
              modelId: target.modelId,
            }))
          }
          ws.send(JSON.stringify({ type: 'user_message', content: prompt }))
          return
        }

        if (message.type === 'permission_request' && typeof message.requestId === 'string') {
          ws.send(JSON.stringify({
            type: 'permission_response',
            requestId: message.requestId,
            allowed: true,
            rule: 'baseline-run',
          }))
          return
        }

        if (message.type === 'message_complete') {
          clearTimeout(timer)
          resolve()
          return
        }

        if (message.type === 'error') {
          clearTimeout(timer)
          reject(new Error(`${message.code ?? 'WS_ERROR'}: ${message.message ?? 'unknown error'}`))
        }
      }

      ws.onerror = () => {
        clearTimeout(timer)
        reject(new Error('WebSocket error during baseline case'))
      }
    })
  } finally {
    ws.close()
  }

  return messages
}

export async function executeBaselineCase(
  testCase: BaselineCase,
  rootDir: string,
  artifactDir: string,
  target?: BaselineTarget,
): Promise<LaneResult> {
  const started = Date.now()
  const resultId = target
    ? `baseline:${testCase.id}:${target.label.replace(/[^a-zA-Z0-9._-]+/g, '-')}`
    : `baseline:${testCase.id}`
  const resultTitle = target ? `${testCase.title} (${target.label})` : testCase.title
  mkdirSync(artifactDir, { recursive: true })

  const port = await getPort()
  const baseUrl = `http://127.0.0.1:${port}`
  const workRoot = await mkdtemp(join(tmpdir(), `quality-gate-${testCase.id}-`))
  const originalDir = join(workRoot, 'original')
  const projectDir = join(workRoot, 'project')
  cpSync(join(rootDir, testCase.fixture), originalDir, { recursive: true })
  cpSync(join(rootDir, testCase.fixture), projectDir, { recursive: true })

  const serverLogPath = join(artifactDir, 'server.log')
  const transcriptPath = join(artifactDir, 'transcript.jsonl')
  const verificationPath = join(artifactDir, 'verification.log')
  const diffPath = join(artifactDir, 'diff.patch')
  // Baseline cases boot the real product server, which resolves transcripts,
  // session index, and settings from CLAUDE_CONFIG_DIR. Without a sandbox the run
  // writes into the developer's real ~/.claude.
  const sandbox = createQualityGateSandbox({ label: `baseline-${testCase.id}`, seedProviders: true })
  const server = Bun.spawn(['bun', 'run', 'src/server/index.ts', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: rootDir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...sandbox.env,
      SERVER_PORT: String(port),
    },
  })
  const stdoutPump = pipeToFile(server.stdout, serverLogPath)
  const stderrPump = pipeToFile(server.stderr, serverLogPath)
  const finish = (result: LaneResult) => applyUserStateGuard(result, sandbox, artifactDir)

  try {
    await waitForHttp(`${baseUrl}/health`, 60_000)

    const createResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: projectDir }),
    })
    if (!createResponse.ok) {
      throw new Error(`Failed to create session: ${createResponse.status}`)
    }
    const session = await createResponse.json() as { sessionId?: string }
    if (!session.sessionId) {
      throw new Error('Session response did not include sessionId')
    }

    const messages = await runPromptOverWebSocket(baseUrl, session.sessionId, testCase.prompt, testCase.timeoutMs, target)
    writeFileSync(transcriptPath, messages.map((message) => JSON.stringify(message)).join('\n') + '\n')
    verifyTranscript(testCase, transcriptPath)

    await writeDiffPatch(originalDir, projectDir, diffPath)
    const changed = changedFiles(originalDir, projectDir)
    verifyChangedFiles(testCase, changed)

    let verificationLog = ''
    for (const command of testCase.verify.commands) {
      const result = await runCommand(command, projectDir)
      verificationLog += `$ ${command.join(' ')}\n${result.stdout}${result.stderr}\n`
      if (result.exitCode !== 0) {
        writeFileSync(verificationPath, verificationLog)
        return finish({
          id: resultId,
          title: resultTitle,
          status: 'failed',
          durationMs: Date.now() - started,
          exitCode: result.exitCode,
          error: `verification command failed: ${command.join(' ')}`,
          artifactDir,
        })
      }
    }
    writeFileSync(verificationPath, verificationLog)

    return finish({
      id: resultId,
      title: resultTitle,
      status: 'passed',
      durationMs: Date.now() - started,
      artifactDir,
    })
  } catch (error) {
    return finish({
      id: resultId,
      title: resultTitle,
      status: 'failed',
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
      artifactDir,
    })
  } finally {
    server.kill()
    await server.exited.catch(() => undefined)
    await Promise.all([stdoutPump, stderrPump]).catch(() => undefined)
    rmSync(workRoot, { recursive: true, force: true })
    sandbox.cleanup()
  }
}
