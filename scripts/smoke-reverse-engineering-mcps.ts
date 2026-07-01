#!/usr/bin/env bun
/**
 * Reverse-engineering plugin MCP smoke test.
 *
 * For each MCP server declared in `plugins/reverse-engineering/mcp/servers.json`:
 *   1. Probe every prerequisite command on PATH.
 *   2. If all prereqs present, spawn the server with its declared
 *      `command + args + env`.
 *   3. Send an LSP-style framed JSON-RPC `initialize` request.
 *   4. Wait up to 2 s for the response.
 *   5. Kill the process and record the outcome.
 *
 * Output is a status matrix and an action list of install commands for
 * any missing prereq (sourced from the same `prerequisites[].install` map
 * that the desktop one-click installer reads), plus schema-gap warnings
 * for prereqs that are clearly missing from servers.json itself (e.g.
 * jadx-mcp-server needs `jadx` on PATH but it isn't in the prereq list).
 *
 * NOT to be confused with `dev-mcp-test.ps1` — that one only sets up the
 * chrome-devtools-mcp browser smoke environment (Vite proxy, H5 token).
 *
 * Usage:
 *   bun run scripts/smoke-reverse-engineering-mcps.ts
 *   bun run scripts/smoke-reverse-engineering-mcps.ts --verbose
 *   bun run scripts/smoke-reverse-engineering-mcps.ts --plugin reverse-engineering
 */

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..')

type InstallStep = { manager: string; cmd: string }
type Prereq = {
  command: string
  label?: string
  homepage?: string
  install?: { win32?: InstallStep[]; darwin?: InstallStep[]; linux?: InstallStep[] }
}
type ServerDef = {
  type: 'stdio'
  command: string
  args: string[]
  env?: Record<string, string>
  prerequisites?: Prereq[]
}
type ServersFile = { mcpServers: Record<string, ServerDef> }

type ProbeResult = { command: string; installed: boolean; resolved?: string }
type SpawnOutcome =
  | { kind: 'skipped-missing-prereq'; missing: string[] }
  | { kind: 'spawn-failed'; reason: string }
  | { kind: 'initialize-ok'; ms: number }
  | { kind: 'initialize-no-response'; ms: number; stderrTail?: string }
  | { kind: 'process-exited'; code: number | null; stderrTail?: string }
  | { kind: 'parse-failed'; raw: string; stderrTail?: string }

const args = process.argv.slice(2)
const verbose = args.includes('--verbose') || args.includes('-v')

function platformKey(): 'win32' | 'darwin' | 'linux' {
  if (process.platform === 'win32') return 'win32'
  if (process.platform === 'darwin') return 'darwin'
  return 'linux'
}

function probeCommand(command: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    const probeCmd = isWin ? 'where' : 'command'
    const probeArgs = isWin ? [command] : ['-v', command]
    let stdout = ''
    const child = spawn(probeCmd, probeArgs, {
      shell: !isWin,
      windowsHide: true,
    })
    child.stdout?.on('data', (b) => (stdout += b.toString('utf8')))
    child.on('error', () => resolve({ command, installed: false }))
    child.on('close', (code) => {
      const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      const ok = code === 0 && lines.length > 0
      resolve({ command, installed: ok, ...(ok ? { resolved: lines[0] } : {}) })
    })
  })
}

function frameJsonRpc(payload: unknown): string {
  // MCP stdio transport is newline-delimited JSON, NOT LSP-style
  // Content-Length framing. Each JSON-RPC message is one line on stdin/
  // stdout. Earlier drafts of this script used Content-Length framing,
  // which servers like frida-mcp would log as a JSON parse error
  // (`Invalid JSON: EOF while parsing` — the server saw "Content-Length:..."
  // as the first line and tried to JSON.parse it).
  return JSON.stringify(payload) + '\n'
}

function parseFramedResponse(buf: Buffer): { id: unknown; result?: unknown; error?: unknown } | null {
  const text = buf.toString('utf8')
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const obj = JSON.parse(line) as { id?: unknown; result?: unknown; error?: unknown }
      if (obj.id !== undefined && (obj.result !== undefined || obj.error !== undefined)) {
        return obj as { id: unknown; result?: unknown; error?: unknown }
      }
    } catch {
      // incomplete line, keep accumulating
    }
  }
  return null
}

async function smokeServer(name: string, def: ServerDef): Promise<{
  outcome: SpawnOutcome
  prereqResults: ProbeResult[]
}> {
  const prereqResults: ProbeResult[] = []
  for (const p of def.prerequisites ?? []) {
    prereqResults.push(await probeCommand(p.command))
  }
  const missing = prereqResults.filter((r) => !r.installed).map((r) => r.command)
  if (missing.length > 0) {
    return { prereqResults, outcome: { kind: 'skipped-missing-prereq', missing } }
  }

  // All declared prereqs present; spawn the server and probe initialize.
  const env = { ...process.env, ...(def.env ?? {}) }
  let proc: ReturnType<typeof spawn>
  try {
    proc = spawn(def.command, def.args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (err) {
    return {
      prereqResults,
      outcome: {
        kind: 'spawn-failed',
        reason: err instanceof Error ? err.message : String(err),
      },
    }
  }

  let stderrBuf = ''
  proc.stderr?.on('data', (b) => {
    stderrBuf += b.toString('utf8')
    if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-8192)
  })

  const start = Date.now()
  const initializePromise = new Promise<SpawnOutcome>((resolve) => {
    let stdoutBuf = Buffer.alloc(0)
    let resolved = false
    const finish = (out: SpawnOutcome) => {
      if (resolved) return
      resolved = true
      resolve(out)
    }
    proc.stdout?.on('data', (b: Buffer) => {
      stdoutBuf = Buffer.concat([stdoutBuf, b])
      const parsed = parseFramedResponse(stdoutBuf)
      if (parsed) {
        finish({ kind: 'initialize-ok', ms: Date.now() - start })
      } else if (stdoutBuf.length > 32 * 1024) {
        finish({
          kind: 'parse-failed',
          raw: stdoutBuf.toString('utf8', 0, 200),
          stderrTail: stderrBuf.slice(-2048),
        })
      }
    })
    proc.on('exit', (code) => {
      finish({
        kind: 'process-exited',
        code,
        stderrTail: stderrBuf.slice(-2048),
      })
    })
    proc.on('error', () => {
      finish({
        kind: 'spawn-failed',
        reason: 'spawn error event',
      })
    })
    setTimeout(() => {
      finish({
        kind: 'initialize-no-response',
        ms: Date.now() - start,
        stderrTail: stderrBuf.slice(-2048),
      })
    }, 5000) // 5s — some uvx-from-git installs are slow first time
  })

  // Send initialize after a brief delay to let the process bind stdin.
  setTimeout(() => {
    try {
      const payload = frameJsonRpc({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'cc-haha-smoke', version: '0.5.11' },
        },
      })
      proc.stdin?.write(payload)
    } catch {
      // ignored — outcome will be no-response or exit
    }
  }, 100)

  const outcome = await initializePromise
  try {
    proc.kill('SIGKILL')
  } catch {
    // ignored
  }
  return { prereqResults, outcome }
}

function describeOutcome(outcome: SpawnOutcome): string {
  switch (outcome.kind) {
    case 'skipped-missing-prereq':
      return `❌ prereq missing: ${outcome.missing.join(', ')}`
    case 'spawn-failed':
      return `❌ spawn failed: ${outcome.reason}`
    case 'initialize-ok':
      return `✅ initialize ok (${outcome.ms} ms)`
    case 'initialize-no-response':
      return `⚠️  spawned but no JSON-RPC response in ${outcome.ms} ms`
    case 'process-exited':
      return `❌ process exited (code=${outcome.code ?? 'null'})`
    case 'parse-failed':
      return `❌ unrecognized output (no Content-Length frame)`
  }
}

function describeStderr(outcome: SpawnOutcome): string | null {
  if ('stderrTail' in outcome && outcome.stderrTail && outcome.stderrTail.trim()) {
    return outcome.stderrTail.trim().split(/\r?\n/).slice(-3).join(' | ')
  }
  return null
}

async function main() {
  const pluginIdx = args.indexOf('--plugin')
  const pluginName = pluginIdx >= 0 ? args[pluginIdx + 1] : 'reverse-engineering'
  const serversPath = path.join(ROOT, 'plugins', pluginName!, 'mcp', 'servers.json')

  let raw: string
  try {
    raw = await readFile(serversPath, 'utf-8')
  } catch (err) {
    console.error(`Failed to read ${serversPath}: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }
  const file = JSON.parse(raw) as ServersFile
  const entries = Object.entries(file.mcpServers ?? {})
  console.log(`\n=== Reverse-engineering MCP smoke ===`)
  console.log(`Source: ${path.relative(ROOT, serversPath)}`)
  console.log(`Servers: ${entries.length}`)
  console.log('')

  const summaries: Array<{
    name: string
    prereqResults: ProbeResult[]
    outcome: SpawnOutcome
  }> = []
  const platform = platformKey()
  const installCommandsByMissingTool = new Map<string, InstallStep[]>()

  for (const [name, def] of entries) {
    process.stdout.write(`  ${name.padEnd(10)} … `)
    const { outcome, prereqResults } = await smokeServer(name, def)
    summaries.push({ name, prereqResults, outcome })

    // Collect install commands for missing prereqs (deduped by tool name).
    if (outcome.kind === 'skipped-missing-prereq') {
      for (const tool of outcome.missing) {
        if (installCommandsByMissingTool.has(tool)) continue
        const prereq = def.prerequisites?.find((p) => p.command === tool)
        if (prereq?.install?.[platform]) {
          installCommandsByMissingTool.set(tool, prereq.install[platform]!)
        }
      }
    }
    console.log(describeOutcome(outcome))
    if (verbose) {
      const stderr = describeStderr(outcome)
      if (stderr) console.log(`    stderr: ${stderr}`)
      for (const pr of prereqResults) {
        console.log(`    prereq ${pr.command.padEnd(10)} ${pr.installed ? '✓' : '✗'} ${pr.resolved ?? ''}`)
      }
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────
  const ok = summaries.filter((s) => s.outcome.kind === 'initialize-ok')
  const noResp = summaries.filter((s) => s.outcome.kind === 'initialize-no-response')
  const exited = summaries.filter((s) => s.outcome.kind === 'process-exited')
  const skipped = summaries.filter((s) => s.outcome.kind === 'skipped-missing-prereq')
  const spawnFail = summaries.filter((s) => s.outcome.kind === 'spawn-failed')
  const parseFail = summaries.filter((s) => s.outcome.kind === 'parse-failed')

  console.log('')
  console.log('=== Summary ===')
  console.log(`  ✅ initialize ok       : ${ok.length}/${entries.length}  (${ok.map((s) => s.name).join(', ') || '—'})`)
  console.log(`  ⚠️  spawned, no response: ${noResp.length}/${entries.length}  (${noResp.map((s) => s.name).join(', ') || '—'})`)
  console.log(`  ❌ process exited      : ${exited.length}/${entries.length}  (${exited.map((s) => s.name).join(', ') || '—'})`)
  console.log(`  ❌ prereq missing      : ${skipped.length}/${entries.length}  (${skipped.map((s) => s.name).join(', ') || '—'})`)
  console.log(`  ❌ spawn failed        : ${spawnFail.length}/${entries.length}  (${spawnFail.map((s) => s.name).join(', ') || '—'})`)
  console.log(`  ❌ parse failed        : ${parseFail.length}/${entries.length}  (${parseFail.map((s) => s.name).join(', ') || '—'})`)

  // ── Action items: install commands for missing prereqs ────────────────
  if (installCommandsByMissingTool.size > 0) {
    console.log('')
    console.log(`=== Install commands for missing prereqs (${platform}) ===`)
    for (const [tool, steps] of installCommandsByMissingTool) {
      console.log(`  ${tool}:`)
      for (const step of steps) {
        console.log(`    ${step.manager.padEnd(10)} ${step.cmd}`)
      }
    }
    console.log('')
    console.log('Pick one manager per tool. After installing, rerun this script.')
  }

  // ── Schema-gap warnings ───────────────────────────────────────────────
  // Heuristic: an MCP server whose name implies a tool (jadx, apktool,
  // gdb, radare2, lldb) should have that tool listed in its prerequisites
  // — otherwise the desktop "one-click install" never knows to install
  // it, and the server crashes at first run.
  //
  // Note: `ghidra` is intentionally excluded — Ghidra is a GUI binary
  // configured via the `GHIDRA_INSTALL_DIR` env var, not a PATH command,
  // so probing for it via `where ghidra` would always fail.
  //
  // Note: `frida` is intentionally excluded — the `frida-mcp` PyPI
  // package bundles its own Python `frida` client as a transitive
  // dependency, so the server starts fine without the standalone
  // `frida` CLI on PATH. Connecting to a target device may still need
  // a frida-server installed on the target itself, which is out of
  // scope for prereq probing.
  const expectedToolByServer: Record<string, string> = {
    jadx: 'jadx',
    apktool: 'apktool',
    lldb: 'lldb',
    gdb: 'gdb',
    radare2: 'radare2',
  }
  const schemaGaps: string[] = []
  for (const [name, def] of entries) {
    const expected = expectedToolByServer[name]
    if (!expected) continue
    const declared = (def.prerequisites ?? []).some((p) => p.command === expected)
    if (!declared) {
      schemaGaps.push(`  • ${name}: prerequisites missing '${expected}' — desktop one-click install can't surface this missing tool`)
    }
  }
  if (schemaGaps.length > 0) {
    console.log('')
    console.log('=== Schema gaps (servers.json fix candidates) ===')
    for (const g of schemaGaps) console.log(g)
  }

  // ── Exit code ─────────────────────────────────────────────────────────
  // Exit 0 when at least one server initialized — the script is informational,
  // not a CI gate. CI consumers can grep stdout if they want a strict mode.
  process.exit(0)
}

void main()
