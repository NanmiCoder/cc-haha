import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleApiRequest } from '../router.js'

let tmpDir: string
let originalConfigDir: string | undefined

function makeRequest(
  method: string,
  urlStr: string,
  body?: Record<string, unknown>,
): { req: Request; url: URL } {
  const url = new URL(urlStr, 'http://localhost:3456')
  const init: RequestInit = { method }
  if (body) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  return {
    req: new Request(url.toString(), init),
    url,
  }
}

describe('Agent Runtime API', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-runtime-api-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
  })

  afterEach(async () => {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('exposes an OpenClaw-like runtime profile for existing yuanclaw capabilities', async () => {
    const { req, url } = makeRequest(
      'GET',
      '/api/agent-runtime?cwd=/tmp/current-project',
    )

    const res = await handleApiRequest(req, url)

    expect(res.status).toBe(200)
    const body = await res.json() as {
      runtime: {
        id: string
        cwd: string
        controlPlane: {
          mode: string
          transports: string[]
          endpoints: string[]
        }
        harnessSelection: {
          mode: string
          providerSurface: string
        }
        capabilityRegistry: {
          concepts: Array<{
            openClawConcept: string
            yuanclawSurfaces: string[]
            status: string
          }>
        }
        sessionPolicy: {
          isolation: string
          identityKeys: string[]
          queuePolicy: string
        }
      }
    }

    expect(body.runtime.id).toBe('yuanclaw-general-agent-runtime')
    expect(body.runtime.cwd).toBe('/tmp/current-project')
    expect(body.runtime.controlPlane.mode).toBe('gateway-like-server')
    expect(body.runtime.controlPlane.transports).toEqual(
      expect.arrayContaining(['rest', 'websocket']),
    )
    expect(body.runtime.controlPlane.endpoints).toEqual(
      expect.arrayContaining(['/api/agents', '/api/plugins', '/api/mcp']),
    )
    expect(body.runtime.harnessSelection).toMatchObject({
      mode: 'provider-backed',
      providerSurface: '/api/providers',
    })
    expect(body.runtime.sessionPolicy.identityKeys).toEqual(
      expect.arrayContaining(['sessionId', 'cwd']),
    )
    expect(body.runtime.sessionPolicy.queuePolicy).toBe('session-keyed-task-lanes')

    const concepts = body.runtime.capabilityRegistry.concepts.map(
      (entry) => entry.openClawConcept,
    )
    expect(concepts).toEqual(
      expect.arrayContaining([
        'Gateway',
        'AgentHarness',
        'PluginRegistry',
        'ToolAssembly',
        'MultiAgentSession',
        'SessionQueue',
      ]),
    )

    for (const concept of body.runtime.capabilityRegistry.concepts) {
      expect(concept.status).toBe('available')
      expect(concept.yuanclawSurfaces.length).toBeGreaterThan(0)
    }
  })

  it('exposes a dynamic runtime registry with live source summaries', async () => {
    const { req, url } = makeRequest(
      'GET',
      '/api/agent-runtime/registry?cwd=/tmp/current-project',
    )

    const res = await handleApiRequest(req, url)

    expect(res.status).toBe(200)
    const body = await res.json() as {
      registry: {
        id: string
        version: number
        cwd: string
        controlPlane: { endpoints: string[]; transports: string[] }
        entries: Array<{
          kind: string
          id: string
          origin: string
          capabilities: string[]
          surfaces: string[]
        }>
        liveSources: {
          providers: { endpoint: string; providerCount: number; activeId: string | null }
          plugins: { endpoint: string; total: number; enabled: number; errorCount: number }
          mcp: { endpoint: string; mode: string }
        }
        extensionKinds: string[]
      }
    }

    expect(body.registry.id).toBe('yuanclaw-agent-runtime-registry')
    expect(body.registry.version).toBe(1)
    expect(body.registry.cwd).toBe('/tmp/current-project')
    expect(body.registry.controlPlane.endpoints).toEqual(
      expect.arrayContaining(['/api/agent-runtime/registry', '/api/agents', '/api/mcp']),
    )
    expect(body.registry.extensionKinds).toEqual(
      expect.arrayContaining(['agentHarness', 'toolAssembly', 'pluginSource', 'sessionPolicy']),
    )
    expect(body.registry.entries).toContainEqual(
      expect.objectContaining({
        kind: 'agentHarness',
        id: 'yuanclaw-agent-harness',
        origin: 'builtin',
        capabilities: expect.arrayContaining(['agent.run', 'agent.wait']),
        surfaces: expect.arrayContaining(['/api/agents', '/api/tasks']),
      }),
    )
    expect(body.registry.entries).toContainEqual(
      expect.objectContaining({
        kind: 'toolAssembly',
        id: 'yuanclaw-tool-assembly',
        capabilities: expect.arrayContaining(['tools.invoke', 'mcp.tools']),
      }),
    )
    expect(body.registry.liveSources.providers).toMatchObject({
      endpoint: '/api/providers',
      providerCount: 0,
      activeId: null,
    })
    expect(body.registry.liveSources.plugins).toMatchObject({
      endpoint: '/api/plugins',
      total: 0,
      enabled: 0,
      errorCount: 0,
    })
    expect(body.registry.liveSources.mcp).toMatchObject({
      endpoint: '/api/mcp',
      mode: 'config-backed',
    })
  })

  it('registers and persists custom runtime entries through the registry API', async () => {
    const registration = {
      kind: 'agentHarness',
      id: 'reviewer-harness',
      displayName: 'Reviewer Harness',
      description: 'Routes review requests to a plugin-backed reviewer agent.',
      source: 'plugin',
      surfaces: ['plugins/reviewer', '/api/plugins/detail?id=reviewer'],
      capabilities: ['agent.review', 'agent.run'],
      enabled: true,
      metadata: { owner: 'quality' },
    }

    const create = makeRequest('POST', '/api/agent-runtime/registry', registration)
    const createRes = await handleApiRequest(create.req, create.url)

    expect(createRes.status).toBe(201)
    const createBody = await createRes.json() as {
      entry: { id: string; kind: string; origin: string; enabled: boolean }
    }
    expect(createBody.entry).toMatchObject({
      id: 'reviewer-harness',
      kind: 'agentHarness',
      origin: 'plugin',
      enabled: true,
    })

    const list = makeRequest('GET', '/api/agent-runtime/registry')
    const listRes = await handleApiRequest(list.req, list.url)
    const listBody = await listRes.json() as {
      registry: {
        entries: Array<{
          id: string
          kind: string
          displayName: string
          origin: string
          capabilities: string[]
          metadata?: Record<string, unknown>
        }>
      }
    }

    expect(listBody.registry.entries).toContainEqual(
      expect.objectContaining({
        id: 'reviewer-harness',
        kind: 'agentHarness',
        displayName: 'Reviewer Harness',
        origin: 'plugin',
        capabilities: expect.arrayContaining(['agent.review', 'agent.run']),
        metadata: { owner: 'quality' },
      }),
    )

    const raw = await fs.readFile(
      path.join(tmpDir, 'yuanclaw', 'agent-runtime-registry.json'),
      'utf-8',
    )
    const persisted = JSON.parse(raw) as { entries: Array<{ id: string }> }
    expect(persisted.entries).toContainEqual(expect.objectContaining({ id: 'reviewer-harness' }))
  })

  it('upserts duplicate runtime entry ids within the same kind', async () => {
    const base = {
      kind: 'toolAssembly',
      id: 'browser-tools',
      displayName: 'Browser Tools',
      source: 'plugin',
      surfaces: ['/api/plugins/detail?id=browser'],
      capabilities: ['browser.open'],
    }

    await handleApiRequest(
      makeRequest('POST', '/api/agent-runtime/registry', base).req,
      makeRequest('POST', '/api/agent-runtime/registry', base).url,
    )
    const update = makeRequest('POST', '/api/agent-runtime/registry', {
      ...base,
      displayName: 'Browser Tool Assembly',
      capabilities: ['browser.open', 'browser.click'],
    })
    const updateRes = await handleApiRequest(update.req, update.url)
    expect(updateRes.status).toBe(200)

    const list = makeRequest('GET', '/api/agent-runtime/registry')
    const listRes = await handleApiRequest(list.req, list.url)
    const listBody = await listRes.json() as {
      registry: {
        entries: Array<{ id: string; kind: string; displayName: string; capabilities: string[] }>
      }
    }
    const matching = listBody.registry.entries.filter(
      (entry) => entry.kind === 'toolAssembly' && entry.id === 'browser-tools',
    )

    expect(matching).toHaveLength(1)
    expect(matching[0]).toMatchObject({
      displayName: 'Browser Tool Assembly',
      capabilities: ['browser.open', 'browser.click'],
    })
  })

  it('deletes custom runtime entries without removing built-in entries', async () => {
    const create = makeRequest('POST', '/api/agent-runtime/registry', {
      kind: 'pluginSource',
      id: 'qa-plugin-source',
      displayName: 'QA Plugin Source',
      source: 'plugin',
      surfaces: ['/api/plugins'],
      capabilities: ['plugins.load'],
    })
    await handleApiRequest(create.req, create.url)

    const remove = makeRequest(
      'DELETE',
      '/api/agent-runtime/registry/pluginSource/qa-plugin-source',
    )
    const removeRes = await handleApiRequest(remove.req, remove.url)

    expect(removeRes.status).toBe(200)
    const list = makeRequest('GET', '/api/agent-runtime/registry')
    const listRes = await handleApiRequest(list.req, list.url)
    const listBody = await listRes.json() as {
      registry: { entries: Array<{ id: string; kind: string }> }
    }

    expect(listBody.registry.entries).not.toContainEqual(
      expect.objectContaining({ id: 'qa-plugin-source' }),
    )
    expect(listBody.registry.entries).toContainEqual(
      expect.objectContaining({ id: 'yuanclaw-plugin-registry', kind: 'pluginSource' }),
    )
  })

  it('rejects invalid runtime registrations', async () => {
    const invalid = makeRequest('POST', '/api/agent-runtime/registry', {
      kind: 'gateway',
      id: '../bad',
      source: 'plugin',
      surfaces: ['/api/plugins'],
      capabilities: ['plugins.load'],
    })

    const res = await handleApiRequest(invalid.req, invalid.url)
    const body = await res.json() as { error: string; message: string }

    expect(res.status).toBe(400)
    expect(body.error).toBe('BAD_REQUEST')
    expect(body.message).toContain('kind')
  })
})
