import '../../../preload.ts'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { _setGlobalConfigCacheForTesting, getProjectPathForConfig } from '../../utils/config.js'
import { getGlobalClaudeFile } from '../../utils/env.js'
import { handleMcpApi } from '../api/mcp.js'

let fixture: string
let previousConfigDir: string | undefined
let previousNodeEnv: string | undefined

function nodeFixture(script: string, ...args: string[]) {
  const result = Bun.spawnSync(['node', '--input-type=commonjs', '-e', script, ...args], { stdout: 'pipe', stderr: 'pipe' })
  expect(new TextDecoder().decode(result.stderr)).toBe('')
  expect(result.exitCode).toBe(0)
  return JSON.parse(new TextDecoder().decode(result.stdout))
}

function pairedDirectories(seed = false) {
  const literal = join(fixture, 'path\\leaf')
  const nested = join(fixture, 'path', 'leaf')
  return nodeFixture(`
    const fs = require('node:fs')
    const path = require('node:path')
    const [literal, nested, seed] = process.argv.slice(1)
    for (const dir of [literal, nested]) fs.mkdirSync(dir, { recursive: true })
    if (seed === 'true') {
      for (const [dir, label] of [[literal, 'literal'], [nested, 'nested']]) {
        fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { shared: { type: 'http', url: 'https://' + label + '.invalid' } } }))
      }
    }
    const left = fs.statSync(literal)
    const right = fs.statSync(nested)
    console.log(JSON.stringify({ literal, nested, literalReal: fs.realpathSync(literal), nestedReal: fs.realpathSync(nested),
      left: { dev: left.dev, ino: left.ino }, right: { dev: right.dev, ino: right.ino } }))
  `, literal, nested, String(seed))
}

function inspectPair(literal: string, nested: string) {
  return nodeFixture(`
    const fs = require('node:fs')
    const path = require('node:path')
    const read = dir => { const file = path.join(dir, '.mcp.json'); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null }
    console.log(JSON.stringify({ literal: read(process.argv[1]), nested: read(process.argv[2]) }))
  `, literal, nested)
}

function resetCaches() {
  getGlobalClaudeFile.cache.clear?.()
  getProjectPathForConfig.cache.clear?.()
  _setGlobalConfigCacheForTesting(null)
}

async function request(method: string, urlPath: string, body?: unknown) {
  const url = new URL(urlPath, 'http://localhost:3456')
  const req = new Request(url, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
  const response = await handleMcpApi(req, url, url.pathname.split('/').filter(Boolean))
  return { status: response.status, body: await response.json() }
}

describe('project MCP physical directory validation', () => {
  beforeEach(async () => {
    fixture = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'mcp-directory-identity-')))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    previousNodeEnv = process.env.NODE_ENV
    process.env.CLAUDE_CONFIG_DIR = join(fixture, 'config')
    process.env.NODE_ENV = 'development'
    await fs.mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
    resetCaches()
  })

  afterEach(async () => {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
    resetCaches()
    nodeFixture(`require('node:fs').rmSync(process.argv[1], { recursive: true, force: true }); console.log('null')`, fixture)
  })

  it.skipIf(process.platform === 'win32')('never redirects a literal directory write into its distinct nested substitute', async () => {
    const pair = pairedDirectories()
    expect(pair.left).not.toEqual(pair.right)
    expect(pair.literalReal).not.toBe(pair.nestedReal)
    const global = JSON.stringify({ futureGlobal: true, projects: { [pair.literal]: { futureProject: true } } })
    await fs.writeFile(getGlobalClaudeFile(), global)
    const query = new URLSearchParams()
    query.append('projectPath', pair.literal)
    query.append('projectPath', pair.nested)
    const preview = await request('GET', `/api/mcp/shared/projects?${query}`)
    const saved = await request('PUT', '/api/mcp/shared/projects', { config: { type: 'http', url: 'https://fixture.invalid' }, targets: [{ projectPath: pair.literal, selected: true, expectedRevision: null }] })
    const files = inspectPair(pair.literal, pair.nested)

    expect(files.nested).toBeNull()
    expect(preview.status).toBe(200)
    expect(preview.body.projects).toHaveLength(2)
    expect(saved.status).toBe(200)
    const literalRow = preview.body.projects.find(row => row.projectPath === pair.literalReal)
    if (saved.body.results[0].success) {
      // Runtimes that resolve this legal POSIX name faithfully may support it.
      expect(saved.body.results[0].projectPath).toBe(pair.literalReal)
      expect(files.literal.mcpServers.shared.url).toBe('https://fixture.invalid')
      expect(literalRow.error).toBeUndefined()
    } else {
      // Bun versions with an untrustworthy realpath must reject, never redirect.
      expect(files.literal).toBeNull()
      expect(literalRow).toMatchObject({ selected: false, error: 'Project directory identity could not be verified' })
      expect(saved.body.results[0]).toMatchObject({ projectPath: pair.literal, error: 'Project directory identity could not be verified' })
    }
    expect(await fs.readFile(getGlobalClaudeFile(), 'utf8')).toBe(global)
  })

  it.skipIf(process.platform === 'win32')('keeps an unverified DTO on its original path and never treats its registry key as a physical alias', async () => {
    const pair = pairedDirectories(true)
    expect(pair.left).not.toEqual(pair.right)
    await fs.writeFile(getGlobalClaudeFile(), JSON.stringify({ futureGlobal: true, projects: { [pair.literal]: { futureProject: true } } }))
    const listed = await request('GET', `/api/mcp?cwd=${encodeURIComponent(pair.literal)}`)
    const row = listed.body.servers.find(server => server.scope === 'project' && server.name === 'shared')
    expect(row.projectPath).toBe(pair.literalReal)
    if (row.error) {
      expect(row).toMatchObject({ error: 'Project directory identity could not be verified', canEdit: false, canRemove: false, canReconnect: false, canToggle: false })
    } else {
      expect(row).toMatchObject({ canEdit: true, canRemove: true })
    }
    const query = new URLSearchParams({ projectPath: pair.nested })
    const preview = await request('GET', `/api/mcp/new-shared/projects?${query}`)
    const target = preview.body.projects.find(project => project.projectPath === pair.nested)
    const saved = await request('PUT', '/api/mcp/new-shared/projects', { config: { type: 'http', url: 'https://selected-nested.invalid' }, targets: [{ projectPath: pair.nested, selected: true, expectedRevision: target.revision }] })
    expect(saved.body.results[0].success).toBe(true)
    const global = JSON.parse(await fs.readFile(getGlobalClaudeFile(), 'utf8'))
    expect(global.projects[pair.literal]).toEqual({ futureProject: true })
    expect(global.projects[pair.nested]).toBeTruthy()
    expect(global.futureGlobal).toBe(true)
    const files = inspectPair(pair.literal, pair.nested)
    expect(files.literal.mcpServers).toEqual({ shared: { type: 'http', url: 'https://literal.invalid' } })
    expect(files.nested.mcpServers['new-shared'].url).toBe('https://selected-nested.invalid')
  })
})
