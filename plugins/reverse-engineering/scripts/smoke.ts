#!/usr/bin/env bun
/**
 * End-to-end smoke for the reverse-engineering plugin.
 *
 * Prerequisites (start in two separate terminals first; this script does
 * NOT manage them — same boundary as scripts/dev-mcp-test.ps1):
 *
 *   $env:SERVER_PORT='3456'; bun run src/server/index.ts     # repo root
 *   bun run dev                                              # cd desktop
 *
 * What it does:
 *   1.  GET  /health                                — server up?
 *   2.  POST /api/plugins/marketplace               — register local marketplace (idempotent)
 *   3.  POST /api/plugins/enable                    — enable plugin (idempotent)
 *   4.  POST /api/plugins/update                    — re-materialise from current version (idempotent)
 *   5.  POST /api/plugins/reload                    — clear caches
 *   6.  GET  /api/plugins/detail?id=...             — assert version, component counts, no errors
 *   7.  Print PASS/FAIL summary, exit non-zero on any failure.
 *
 * Usage (from repo root):
 *   bun run plugins/reverse-engineering/scripts/smoke.ts
 *   bun run plugins/reverse-engineering/scripts/smoke.ts --server http://127.0.0.1:3456
 */

import path from 'node:path'
import process from 'node:process'
import { readFile } from 'node:fs/promises'

type DetailComponentCounts = {
  commands: number
  agents: number
  skills: number
  hooks: number
  mcpServers: number
  lspServers: number
}

type ExpectedCounts = Pick<
  DetailComponentCounts,
  'commands' | 'agents' | 'skills' | 'mcpServers'
>

const args = process.argv.slice(2)
const serverArgIdx = args.indexOf('--server')
const serverOrigin =
  serverArgIdx >= 0 ? args[serverArgIdx + 1] : 'http://127.0.0.1:3456'

const repoRoot = path.resolve(import.meta.dir, '..', '..', '..')
const pluginRoot = path.join(repoRoot, 'plugins', 'reverse-engineering')
const marketplaceRoot = path.join(repoRoot, 'plugins')
const pluginManifest = path.join(pluginRoot, '.claude-plugin', 'plugin.json')
const pluginId = 'reverse-engineering@cc-haha-builtin'

let pass = 0
let fail = 0

function step(name: string): void {
  // biome-ignore lint/suspicious/noConsole:: developer tool
  console.log(`\n==> ${name}`)
}
function ok(msg: string): void {
  // biome-ignore lint/suspicious/noConsole:: developer tool
  console.log(`    OK  ${msg}`)
  pass++
}
function bad(msg: string): void {
  // biome-ignore lint/suspicious/noConsole:: developer tool
  console.log(`    FAIL ${msg}`)
  fail++
}

async function http<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const r = await fetch(`${serverOrigin}${path}`, init)
  const text = await r.text()
  let data: unknown
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = text
  }
  return { status: r.status, data: data as T }
}

async function readExpectedCounts(): Promise<{
  expected: ExpectedCounts
  expectedSkills: string[]
  expectedVersion: string
}> {
  // Count files under known directories. Match the plugin loader's view:
  //   - skills/<name>/SKILL.md          (one per directory)
  //   - agents/*.md                     (one per file)
  //   - commands/*.md                   (one per file)
  //   - mcp/servers.json -> mcpServers  (count keys)
  const { Glob } = await import('bun')
  const skillFiles = await Array.fromAsync(
    new Glob('skills/*/SKILL.md').scan({ cwd: pluginRoot }),
  )
  const agentFiles = await Array.fromAsync(
    new Glob('agents/*.md').scan({ cwd: pluginRoot }),
  )
  const commandFiles = await Array.fromAsync(
    new Glob('commands/*.md').scan({ cwd: pluginRoot }),
  )
  const serversRaw = await readFile(
    path.join(pluginRoot, 'mcp', 'servers.json'),
    'utf8',
  )
  const servers = JSON.parse(serversRaw) as {
    mcpServers: Record<string, unknown>
  }
  const manifestRaw = await readFile(pluginManifest, 'utf8')
  const manifest = JSON.parse(manifestRaw) as { version?: string }

  const expectedSkills = skillFiles
    .map(p => `reverse-engineering:${p.split(/[\\/]/)[1]}`)
    .sort()

  return {
    expected: {
      skills: skillFiles.length,
      agents: agentFiles.length,
      commands: commandFiles.length,
      mcpServers: Object.keys(servers.mcpServers).length,
    },
    expectedSkills,
    expectedVersion: manifest.version ?? '',
  }
}

async function main(): Promise<void> {
  step('1. server health')
  try {
    const { status, data } = await http<{ status: string }>('GET', '/health')
    if (status === 200 && data.status === 'ok') {
      ok(`${serverOrigin}/health -> ok`)
    } else {
      bad(`/health returned ${status}: ${JSON.stringify(data)}`)
      process.exit(1)
    }
  } catch (e) {
    bad(`server unreachable at ${serverOrigin}: ${(e as Error).message}`)
    process.exit(1)
  }

  step('2. register local marketplace')
  {
    const { status, data } = await http<{ ok?: boolean; error?: string }>(
      'POST',
      '/api/plugins/marketplace',
      { input: marketplaceRoot },
    )
    if (status === 200 && data.ok) ok('marketplace registered')
    else bad(`status=${status} body=${JSON.stringify(data)}`)
  }

  step('3. enable plugin')
  {
    const { status, data } = await http<{
      ok?: boolean
      message?: string
      error?: string
    }>('POST', '/api/plugins/enable', { id: pluginId, scope: 'user' })
    if (status === 200 && data.ok) {
      ok(data.message ?? 'enabled')
    } else if (
      status === 400 &&
      typeof data.message === 'string' &&
      data.message.toLowerCase().includes('already enabled')
    ) {
      ok('already enabled (idempotent)')
    } else {
      bad(`status=${status} body=${JSON.stringify(data)}`)
    }
  }

  step('4. update plugin (re-materialise current version)')
  {
    const { status, data } = await http<{
      ok?: boolean
      message?: string
      error?: string
    }>('POST', '/api/plugins/update', { id: pluginId, scope: 'user' })
    // 200 with ok=true OR a "no update needed" message both fine.
    if (status === 200) ok(data.message ?? 'update returned 200')
    else bad(`status=${status} body=${JSON.stringify(data)}`)
  }

  step('5. reload')
  {
    const { status, data } = await http<{ ok?: boolean }>(
      'POST',
      '/api/plugins/reload',
      {},
    )
    if (status === 200 && data.ok) ok('caches cleared')
    else bad(`status=${status} body=${JSON.stringify(data)}`)
  }

  step('6. inspect detail')
  let detail: {
    detail?: {
      version?: string
      componentCounts?: DetailComponentCounts
      capabilities?: { skills?: string[] }
      errors?: unknown[]
    }
  } = {}
  {
    const r = await http<typeof detail>(
      'GET',
      `/api/plugins/detail?id=${encodeURIComponent(pluginId)}`,
    )
    if (r.status === 200) {
      detail = r.data
      ok(`got detail for ${pluginId}`)
    } else {
      bad(`status=${r.status} body=${JSON.stringify(r.data)}`)
      summary()
      return
    }
  }

  const d = detail.detail
  if (!d) {
    bad('detail.detail is missing')
    summary()
    return
  }

  const { expected, expectedSkills, expectedVersion } =
    await readExpectedCounts()

  if (d.version === expectedVersion) ok(`version = ${d.version}`)
  else bad(`version mismatch: detail=${d.version} manifest=${expectedVersion}`)

  if (d.errors && d.errors.length === 0) ok('errors = []')
  else bad(`errors = ${JSON.stringify(d.errors)}`)

  const c = d.componentCounts
  if (!c) {
    bad('componentCounts missing')
  } else {
    const checks: Array<[keyof ExpectedCounts, number, number]> = [
      ['commands', expected.commands, c.commands],
      ['agents', expected.agents, c.agents],
      ['skills', expected.skills, c.skills],
      ['mcpServers', expected.mcpServers, c.mcpServers],
    ]
    for (const [name, want, got] of checks) {
      if (want === got) ok(`${name} = ${got}`)
      else bad(`${name} expected ${want}, got ${got}`)
    }
  }

  const skills = (d.capabilities?.skills ?? []).slice().sort()
  const expectedJoined = expectedSkills.join(',')
  const gotJoined = skills.join(',')
  if (expectedJoined === gotJoined) ok(`skill ids match (${skills.length})`)
  else bad(`skill ids differ:\n      expected: ${expectedJoined}\n      got:      ${gotJoined}`)

  summary()
}

function summary(): void {
  // biome-ignore lint/suspicious/noConsole:: developer tool
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(err => {
  // biome-ignore lint/suspicious/noConsole:: developer tool
  console.error(err)
  process.exit(2)
})
