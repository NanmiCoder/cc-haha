import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'

const originalEnvironment = { ...process.env }
let sandbox: string
let configDir: string
let handleSessionsApi: typeof import('./sessions.js').handleSessionsApi
let sessionService: typeof import('../services/sessionService.js').sessionService

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'frozen-turn-evidence-'))
  const environment = createSandboxedTestEnvironment(sandbox, {
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
  })
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, environment)
  configDir = environment.CLAUDE_CONFIG_DIR!
  handleSessionsApi = (await import('./sessions.js')).handleSessionsApi
  sessionService = (await import('../services/sessionService.js')).sessionService
})

afterAll(async () => {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnvironment)
  await rm(sandbox, { recursive: true, force: true })
})

type FixtureOptions = {
  firstResult?: 'success' | 'missing'
  secondMutation?: 'pending-edit' | 'patch' | 'unknown'
  snapshotOnly?: boolean
  malformedBefore?: boolean
  firstBackupReadable?: boolean
}

async function createFixture(options: FixtureOptions = {}) {
  const sessionId = crypto.randomUUID()
  const firstUserId = crypto.randomUUID()
  const secondUserId = crypto.randomUUID()
  const workDir = join(sandbox, sessionId)
  const historyDir = join(configDir, 'file-history', sessionId)
  const projectDir = join(configDir, 'projects', sessionId)
  await mkdir(workDir)
  await mkdir(historyDir, { recursive: true })
  await mkdir(projectDir, { recursive: true })
  const firstPath = join(workDir, 'a.txt')
  const secondPath = join(workDir, 'b.txt')
  const firstBefore = 'existing A before\n'
  const firstAfter = 'existing A after\n'
  const secondContent = 'unchanged existing B\n'
  await writeFile(join(historyDir, 'a-after'), firstAfter)
  if (options.firstBackupReadable) await writeFile(join(historyDir, 'a-expired'), firstBefore)
  await writeFile(join(historyDir, 'b-after'), secondContent)
  // Both before backups expired. Current bytes are intentionally unrelated so
  // an accepted diff must come from the recorded Edit, never from disk.
  await writeFile(firstPath, 'unrelated current A\n')
  await writeFile(secondPath, 'unrelated current B\n')
  const descriptor = (name: string) => ({ backupFileName: name, version: 1, backupTime: '2026-10-01T00:00:00.000Z' })
  const snapshot = (id: string, backups: unknown) => ({
    type: 'file-history-snapshot', messageId: id, isSnapshotUpdate: false,
    snapshot: { messageId: id, trackedFileBackups: backups, timestamp: '2026-10-01T00:00:00.000Z' },
  })
  const message = (type: string, content: unknown, id = crypto.randomUUID()) => ({
    type, uuid: id, cwd: workDir, sessionId, timestamp: '2026-10-01T00:00:00.000Z',
    message: { role: type, content },
  })
  const tool = (id: string, name: string, input: unknown) => message('assistant', [{ type: 'tool_use', id, name, input }])
  const result = (id: string) => message('user', [{ type: 'tool_result', tool_use_id: id, content: 'The file has been updated.' }])
  const rows: unknown[] = [
    { type: 'session-meta', isMeta: true, workDir, timestamp: '2026-10-01T00:00:00.000Z' },
    snapshot(firstUserId, options.malformedBefore ? null : { 'a.txt': descriptor('a-expired'), 'b.txt': descriptor('b-expired') }),
    message('user', 'Edit A, leaving carried-forward B alone', firstUserId),
  ]
  if (!options.snapshotOnly) {
    rows.push(tool('edit-a', 'Edit', { file_path: firstPath, old_string: firstBefore, new_string: firstAfter }))
    if (options.firstResult !== 'missing') rows.push(result('edit-a'))
  }
  if (options.secondMutation === 'pending-edit') {
    rows.push(tool('edit-b', 'Edit', { file_path: secondPath, old_string: secondContent, new_string: 'pending B\n' }))
  } else if (options.secondMutation === 'patch') {
    rows.push(tool('patch-b', 'apply_patch', { patch: '*** Begin Patch\n*** Update File: b.txt\n@@\n-unchanged existing B\n+changed B\n*** End Patch' }), result('patch-b'))
  } else if (options.secondMutation === 'unknown') {
    rows.push(tool('unknown-write', 'Bash', { command: 'some-command-that-may-write' }), result('unknown-write'))
  }
  rows.push(
    message('assistant', [{ type: 'text', text: 'done' }]),
    snapshot(secondUserId, { 'a.txt': descriptor('a-after'), 'b.txt': descriptor('b-after') }),
    message('user', 'Next turn does not change files', secondUserId),
    message('assistant', [{ type: 'text', text: 'confirmed' }]),
  )
  const transcriptPath = join(projectDir, `${sessionId}.jsonl`)
  await writeFile(transcriptPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  return { sessionId, firstUserId, firstPath, secondPath, firstBefore, firstAfter, transcriptPath }
}

async function request(sessionId: string, resource: string, body?: unknown) {
  const req = new Request(`http://localhost/api/sessions/${sessionId}/${resource}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const url = new URL(req.url)
  return handleSessionsApi(req, url, url.pathname.split('/').filter(Boolean))
}

async function firstCheckpoint(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const response = await request(fixture.sessionId, 'turn-checkpoints?frozen=true')
  expect(response.status).toBe(200)
  const body = await response.json() as { checkpoints: Array<{
    target: { targetUserMessageId: string }
    code: { available: boolean; filesChanged: string[]; insertions: number; deletions: number; reason?: string }
    restoreAvailable: boolean
  }> }
  return body.checkpoints.find(checkpoint => checkpoint.target.targetUserMessageId === fixture.firstUserId)!
}

test('frozen review keeps a recorded Edit visible when unrelated carried-forward backups expired', async () => {
  const fixture = await createFixture()
  const checkpoint = await firstCheckpoint(fixture)
  expect(checkpoint.code).toMatchObject({ available: true, filesChanged: [fixture.firstPath], insertions: 1, deletions: 1 })
  expect(checkpoint.restoreAvailable).toBe(false)

  const response = await request(fixture.sessionId, `turn-checkpoints/diff?frozen=true&targetUserMessageId=${fixture.firstUserId}&path=a.txt`)
  expect(response.status).toBe(200)
  const diff = await response.json() as { state: string; diff?: string }
  expect(diff.state).toBe('ok')
  expect(diff.diff).toContain('-existing A before')
  expect(diff.diff).toContain('+existing A after')
  expect(diff.diff).not.toContain('unrelated current')
  expect(diff.diff).not.toContain('/dev/null')
  const missing = await request(fixture.sessionId, `turn-checkpoints/diff?frozen=true&targetUserMessageId=${fixture.firstUserId}&path=b.txt`)
  expect(await missing.json()).toMatchObject({ state: 'missing' })

  // Viewing recorded evidence must not grant permission to restore missing
  // before-states or rewrite the transcript and workspace.
  const transcriptBefore = await readFile(fixture.transcriptPath, 'utf8')
  const rewind = await request(fixture.sessionId, 'rewind', { targetUserMessageId: fixture.firstUserId })
  expect(rewind.status).toBe(400)
  expect(await readFile(fixture.firstPath, 'utf8')).toBe('unrelated current A\n')
  expect(await readFile(fixture.secondPath, 'utf8')).toBe('unrelated current B\n')
  expect(await readFile(fixture.transcriptPath, 'utf8')).toBe(transcriptBefore)
})

test.each([
  { firstResult: 'missing' },
  { snapshotOnly: true },
  { secondMutation: 'pending-edit' },
  { secondMutation: 'patch' },
  { secondMutation: 'unknown' },
  { malformedBefore: true },
] satisfies FixtureOptions[])('frozen review stays unavailable without complete recorded mutation evidence: %j', async (options) => {
  const fixture = await createFixture(options)
  const checkpoint = await firstCheckpoint(fixture)
  expect(checkpoint.code.available).toBe(false)
  expect(checkpoint.restoreAvailable).toBe(false)
  expect(checkpoint.code.reason).toContain(options.malformedBefore ? 'invalid before-file map' : 'b.txt')
  if (options.secondMutation === 'patch') {
    // apply_patch records that B was touched, but carries no replayable diff.
    expect(checkpoint.code.filesChanged).toContain(fixture.secondPath)
    const response = await request(fixture.sessionId, `turn-checkpoints/diff?frozen=true&targetUserMessageId=${fixture.firstUserId}&path=b.txt`)
    expect(await response.json()).toMatchObject({ state: 'missing' })
  } else {
    expect(checkpoint.code.filesChanged).not.toContain(fixture.secondPath)
  }
})

test('frozen review does not scope missing boundaries when transcript evidence is incomplete', async () => {
  const fixture = await createFixture()
  const readMessages = sessionService.getSessionMessagesWithEvidence.bind(sessionService)
  const spy = spyOn(sessionService, 'getSessionMessagesWithEvidence').mockImplementation(async (...args) => ({
    ...await readMessages(...args), transcriptEvidenceComplete: false,
  }))
  try {
    const checkpoint = await firstCheckpoint(fixture)
    expect(checkpoint.code.available).toBe(false)
    expect(checkpoint.code.reason).toContain('b.txt')
    expect(checkpoint.restoreAvailable).toBe(false)
  } finally {
    spy.mockRestore()
  }
})

test('frozen review does not advertise restoration when only an unrelated before backup expired', async () => {
  const fixture = await createFixture({ firstBackupReadable: true })
  const checkpoint = await firstCheckpoint(fixture)
  expect(checkpoint.code).toMatchObject({ available: true, filesChanged: [fixture.firstPath], insertions: 1, deletions: 1 })
  expect(checkpoint.restoreAvailable).toBe(false)
})
