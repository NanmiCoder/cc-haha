import { describe, expect, test } from 'bun:test'
import { loadBringExtras, type BringExtras } from './useBringExtras'

function run(responses: Record<string, unknown | Error>, workDir: string | undefined = '/work dir') {
  const paths: string[] = []
  const client = {
    get: async (path: string) => {
      paths.push(path)
      const key = path.split('?')[0]!
      const value = responses[key]
      if (value instanceof Error) throw value
      return value
    },
  } as unknown as Parameters<typeof loadBringExtras>[0]
  const result: Partial<BringExtras> = {}
  const controller = new AbortController()
  const done = loadBringExtras(client, workDir, controller.signal, (key, value) => {
    ;(result as Record<string, unknown>)[key] = value
  })
  return { paths, result, done, controller }
}

const real = {
  '/api/agents': { availableTools: [], activeAgents: [{ agentType: 'reviewer', description: '审代码' }], allAgents: [] },
  '/api/connectors': { items: [{ id: 'github', displayName: 'GitHub', connection: 'connected', supported: true, installed: true }] },
  '/api/workflows': { workflows: [{ name: 'ship', description: '发版' }] },
}

describe('loadBringExtras', () => {
  test('reads the three real response shapes from their endpoints, passing the project folder to agents and workflows', async () => {
    const { paths, result, done } = run(real)
    await done
    expect(paths.sort()).toEqual(['/api/agents?cwd=%2Fwork%20dir', '/api/connectors', '/api/workflows?cwd=%2Fwork%20dir'])
    expect(result.agents).toEqual([{ agentType: 'reviewer', description: '审代码' }])
    expect(result.connectors?.[0]).toMatchObject({ id: 'github', connection: 'connected' })
    expect(result.workflows).toEqual([{ name: 'ship', description: '发版' }])
  })

  test('an endpoint that is missing, forbidden or failing only blanks its own part', async () => {
    const { result, done } = run({
      '/api/agents': new Error('network'),
      '/api/connectors': { error: 'Desktop-only capability' },
      '/api/workflows': real['/api/workflows'],
    })
    await done
    expect(result.agents).toBeNull()
    expect(result.connectors).toBeNull()
    expect(result.workflows).toEqual([{ name: 'ship', description: '发版' }])
  })

  test('an empty list is a success (the row shows with zero), not a failure', async () => {
    const { result, done } = run({ '/api/agents': { activeAgents: [] }, '/api/connectors': { items: [] }, '/api/workflows': { workflows: [] } }, undefined)
    await done
    expect(result).toEqual({ agents: [], connectors: [], workflows: [] })
  })

  test('nothing is reported after the sheet closed', async () => {
    const { result, done, controller } = run(real)
    controller.abort()
    await done
    expect(result).toEqual({})
  })
})
