import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSearchContentCoordinator } from '../../../services/localIndex/searchContentCoordinator.js'
import {
  markSessionSensitive,
  resetSensitivityPolicyForTests,
} from '../../../../services/managedContext/sensitivityPolicy.js'
import { composeUserContent } from '../composer.js'

const SECRET = 'fake-host-password-123'
const SESSION_ID = 'sensitive-search-session'
const BODY = 'visible managed question'
const tempDirs: string[] = []

afterEach(async () => {
  resetSensitivityPolicyForTests()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function waitReady(coordinator: ReturnType<typeof createSearchContentCoordinator>): Promise<void> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (coordinator.getStatus().state === 'ready') return
    await Bun.sleep(5)
  }
  throw new Error(`search coordinator did not become ready: ${JSON.stringify(coordinator.getStatus())}`)
}

describe('M8 search sensitivity sanitization', () => {
  it('removes already-indexed assistant secret text and keeps only projected user body', async () => {
    resetSensitivityPolicyForTests()
    const scope = await mkdtemp(join(tmpdir(), 'm8-search-sensitive-'))
    tempDirs.push(scope)
    const source = join(scope, 'projects', '-repo', `${SESSION_ID}.jsonl`)
    await mkdir(join(source, '..'), { recursive: true })
    const managed = composeUserContent({
      userText: BODY,
      contextText: JSON.stringify({ password: SECRET }),
    }).content
    await writeFile(source, [
      JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: managed } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: `assistant repeated ${SECRET}` }] } }),
      '',
    ].join('\n'))

    const coordinator = createSearchContentCoordinator({
      resolveScope: () => scope,
      resolveDatabasePath: () => join(scope, 'cc-haha', 'db', 'search-index-v1.sqlite'),
      schedule: task => queueMicrotask(task),
      createWatcher: () => ({
        async start() {},
        async stop() {},
        queueTranscriptPath() {},
        queueFullSweep() {},
        getMetrics: () => ({ queuedPaths: 0, maxBatchSize: 0, yielded: 0, fullSweeps: 0, watchFailures: 0 }),
      }),
    })

    await coordinator.start()
    await waitReady(coordinator)
    expect(coordinator.search(SECRET)?.sessions).toHaveLength(1)

    markSessionSensitive(SESSION_ID)
    const pending = coordinator.sanitizeSession(SESSION_ID)
    expect(coordinator.search(SECRET)).toBeNull()
    await pending
    await waitReady(coordinator)

    expect(coordinator.search(SECRET)?.sessions).toEqual([])
    const visible = coordinator.search(BODY)
    expect(visible?.sessions).toHaveLength(1)
    expect(visible?.sessions[0]?.matches).toEqual([
      expect.objectContaining({ role: 'user', body: BODY }),
    ])
    await coordinator.stop()
  })
})
