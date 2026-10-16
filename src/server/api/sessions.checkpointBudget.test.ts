import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rename, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'

// Checkpoints drop tool output while parsing; everything else stays resident.
const retainedBudget = 24 * 1024 * 1024
const sourceBudget = 256 * 1024 * 1024
const originalEnvironment = { ...process.env }
let sandbox: string
let workDir: string
let configDir: string
let handleSessionsApi: typeof import('./sessions.js').handleSessionsApi
let sessionService: typeof import('../services/sessionService.js').sessionService
let listSessionTurnCheckpoints: typeof import('../services/sessionRewindService.js').listSessionTurnCheckpoints

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'qa-005-checkpoint-budget-'))
  const environment = createSandboxedTestEnvironment(sandbox, {
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
  })
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, environment)
  configDir = environment.CLAUDE_CONFIG_DIR!
  workDir = join(sandbox, 'workspace')
  await mkdir(workDir)
  await mkdir(join(configDir, 'projects', 'fixture'), { recursive: true })
  handleSessionsApi = (await import('./sessions.js')).handleSessionsApi
  sessionService = (await import('../services/sessionService.js')).sessionService
  listSessionTurnCheckpoints = (await import('../services/sessionRewindService.js')).listSessionTurnCheckpoints
})

afterAll(async () => {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnvironment)
  await rm(sandbox, { recursive: true, force: true })
})

function row(type: string, content: unknown, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    uuid: crypto.randomUUID(), type, cwd: workDir,
    timestamp: '2026-10-01T08:00:00.000Z',
    message: { role: type, content }, ...extra,
  }) + '\n'
}

async function createTranscript(
  content: string,
  activityCount = 0,
  totalBytes?: number,
  padding: 'records' | 'toolOutput' = 'records',
) {
  const sessionId = crypto.randomUUID()
  const filePath = join(configDir, 'projects', 'fixture', `${sessionId}.jsonl`)
  const changedPath = join(workDir, `${sessionId}.txt`)
  const entries = [row('user', 'Synthetic history replay; inspect the file')]
  // Like the QA fixture, these are completed Agent records below the per-record
  // budget. Their cumulative activity is allowed to overflow recovery while the
  // small Write remains complete. This never invokes an agent or provider.
  for (let index = 0; index < activityCount; index++) {
    entries.push(row('assistant', [{ type: 'tool_use', id: `agent-${index}`, name: 'Agent', input: {
      description: 'a'.repeat(10 * 1024), subagent_type: 'general-purpose',
    } }]))
    entries.push(row('user', [{ type: 'tool_result', tool_use_id: `agent-${index}`, content: 'Synthetic completed result' }]))
  }
  entries.push(row('assistant', [{ type: 'tool_use', id: 'write', name: 'Write', input: { file_path: changedPath, content } }]))
  entries.push(row('user', [{ type: 'tool_result', tool_use_id: 'write', content: 'Created successfully' }]))
  entries.push(row('assistant', [{ type: 'text', text: 'Synthetic replay complete' }]))
  if (totalBytes !== undefined && padding === 'toolOutput') {
    // Large Read results, the usual bulk of a long session.
    entries.push(row('assistant', [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: changedPath } }]))
    let remaining = totalBytes - Buffer.byteLength(entries.join(''))
    while (remaining > 0) {
      const line = row('user', [{ type: 'tool_result', tool_use_id: 'read', content: 'x'.repeat(60 * 1024) }])
      entries.push(line)
      remaining -= Buffer.byteLength(line)
    }
  } else if (totalBytes !== undefined) {
    let remaining = totalBytes - Buffer.byteLength(entries.join(''))
    const overhead = Buffer.byteLength(JSON.stringify({ type: 'progress', padding: '' }) + '\n')
    while (remaining > 0) {
      const bytes = Math.min(60 * 1024, remaining)
      if (bytes < overhead) throw new Error('Invalid fixture padding')
      entries.push(JSON.stringify({ type: 'progress', padding: 'x'.repeat(bytes - overhead) }) + '\n')
      remaining -= bytes
    }
  }
  const transcript = entries.join('')
  await writeFile(filePath, transcript)
  await writeFile(changedPath, content)
  return { sessionId, fileName: `${sessionId}.txt`, bytes: Buffer.byteLength(transcript) }
}

async function get(sessionId: string, resource: string) {
  const request = new Request(`http://localhost/api/sessions/${sessionId}/${resource}`)
  const url = new URL(request.url)
  return handleSessionsApi(request, url, url.pathname.split('/').filter(Boolean))
}

test('QA-005 keeps the full checkpoint limit while retaining bounded workspace files after activity overflow', async () => {
  // Agent calls are retained: their results link subagent transcripts.
  const fixture = await createTranscript('QA retained workspace evidence\n', 2600)
  expect(fixture.bytes).toBeGreaterThan(retainedBudget)
  const checkpoints = await get(fixture.sessionId, 'turn-checkpoints')
  expect(checkpoints.status).toBe(413)
  expect(await checkpoints.json()).toMatchObject({ error: 'HISTORY_CHECKPOINT_PREVIEW_LIMIT' })
  const workspace = await get(fixture.sessionId, 'workspace/status')
  expect(workspace.status).toBe(200)
  expect(await workspace.json()).toMatchObject({
    state: 'ok', isGitRepo: false,
    changedFiles: [{ path: fixture.fileName, status: 'added', additions: 1, deletions: 0 }],
  })
  const file = await get(fixture.sessionId, `workspace/file?path=${fixture.fileName}`)
  expect(file.status).toBe(200)
  expect(await file.json()).toMatchObject({ state: 'ok', content: 'QA retained workspace evidence\n' })
  // A current-content preview is safe; a claimed turn baseline still requires
  // the full checkpoint evidence and must not sneak past its original budget.
  expect((await get(fixture.sessionId, `turn-checkpoints/diff?userMessageIndex=0&path=${fixture.fileName}`)).status).toBe(413)
}, 20_000)

test('QA-005 oversized Write remains conservative even though the current file is readable', async () => {
  const fixture = await createTranscript('x'.repeat(128 * 1024), 2600)
  const workspace = await get(fixture.sessionId, 'workspace/status')
  expect(workspace.status).toBe(413)
  expect(await workspace.json()).toMatchObject({ error: 'HISTORY_WORKSPACE_LIMIT' })
  const file = await get(fixture.sessionId, `workspace/file?path=${fixture.fileName}`)
  expect(file.status).toBe(200)
  expect(await file.json()).toMatchObject({ state: 'ok', size: 128 * 1024 })
  const checkpoints = await get(fixture.sessionId, 'turn-checkpoints')
  expect(checkpoints.status).toBe(413)
  expect(await checkpoints.json()).toMatchObject({ error: 'HISTORY_CHECKPOINT_PREVIEW_LIMIT' })
}, 20_000)

async function expectPreviewOf(sessionId: string, fileName: string) {
  const checkpoints = await get(sessionId, 'turn-checkpoints')
  expect(checkpoints.status).toBe(200)
  const body = await checkpoints.json() as { checkpoints: Array<{ code: { filesChanged: string[] } }> }
  expect(body.checkpoints[0]?.code.filesChanged).toContain(join(workDir, fileName))
  const diff = await get(sessionId, `turn-checkpoints/diff?userMessageIndex=0&path=${fileName}`)
  expect(diff.status).toBe(200)
}

async function expectPreviewRejected(sessionId: string) {
  const response = await get(sessionId, 'turn-checkpoints')
  expect(response.status).toBe(413)
  expect(await response.json()).toMatchObject({ error: 'HISTORY_CHECKPOINT_PREVIEW_LIMIT' })
}

test('previews a session whose bulk is tool output far past the retained budget', async () => {
  const fixture = await createTranscript('output heavy\n', 0, 2 * retainedBudget, 'toolOutput')
  expect(fixture.bytes).toBeGreaterThan(2 * retainedBudget)
  await expectPreviewOf(fixture.sessionId, fixture.fileName)
}, 20_000)

test('previews retained records under the budget and rejects them over it', async () => {
  const admitted = await createTranscript('boundary\n', 0, retainedBudget - 1024 * 1024)
  await expectPreviewOf(admitted.sessionId, admitted.fileName)
  const rejected = await createTranscript('boundary\n', 0, retainedBudget + 1024 * 1024)
  await expectPreviewRejected(rejected.sessionId)
}, 20_000)

test('rejects a source above its budget without reading it', async () => {
  const fixture = await createTranscript('oversized source\n', 0, undefined)
  // Sparse and newline-free: parsing it would build one 256 MiB line.
  await truncate(join(configDir, 'projects', 'fixture', `${fixture.sessionId}.jsonl`), sourceBudget + 1)
  await expectPreviewRejected(fixture.sessionId)
}, 20_000)

type SnapshotRecord = { messageId: string; backups: Record<string, string>; update?: boolean }

/** Snapshot-only session: each record maps tracked paths to backup contents. */
async function createSnapshotSession(records: SnapshotRecord[], current: Record<string, string>) {
  const sessionId = crypto.randomUUID()
  const historyDir = join(configDir, 'file-history', sessionId)
  await mkdir(historyDir, { recursive: true })
  const backupNames = new Map<string, string>()
  const lines: string[] = []
  for (const record of records) {
    const trackedFileBackups: Record<string, unknown> = {}
    for (const [trackingPath, content] of Object.entries(record.backups)) {
      let name = backupNames.get(content)
      if (!name) {
        name = `backup-${backupNames.size}@v1`
        backupNames.set(content, name)
        await writeFile(join(historyDir, name), content)
      }
      trackedFileBackups[trackingPath] = { backupFileName: name, version: 1, backupTime: '2026-10-01T08:00:00.000Z' }
    }
    lines.push(JSON.stringify({
      type: 'file-history-snapshot', messageId: record.messageId, isSnapshotUpdate: record.update === true,
      snapshot: { messageId: record.messageId, trackedFileBackups, timestamp: '2026-10-01T08:00:00.000Z' },
    }) + '\n')
    if (!record.update) {
      lines.push(row('user', `turn ${record.messageId}`, { uuid: record.messageId }))
      lines.push(row('assistant', [{ type: 'text', text: 'done' }]))
    }
  }
  for (const [relativePath, content] of Object.entries(current)) await writeFile(join(workDir, relativePath), content)
  await writeFile(join(configDir, 'projects', 'fixture', `${sessionId}.jsonl`), lines.join(''))
  return sessionId
}

async function workspaceChanges(sessionId: string) {
  const response = await get(sessionId, 'workspace/status')
  expect(response.status).toBe(200)
  const body = await response.json() as { changedFiles: Array<{ path: string; additions: number; deletions: number }> }
  return body.changedFiles
}

test('workspace status lists changes of a session with more snapshots than the old record budget', async () => {
  // Each snapshot repeats every tracked file, so 1200 turns x 30 files is far
  // past the former 1000-record / 2 MB snapshot budget.
  const prefix = `many-${crypto.randomUUID().slice(0, 8)}`
  const tracked = Object.fromEntries(Array.from({ length: 30 }, (_, file) => [`${prefix}-${file}.txt`, `base ${file}\n`]))
  const records = Array.from({ length: 1200 }, () => ({ messageId: crypto.randomUUID(), backups: tracked }))
  const sessionId = await createSnapshotSession(records, {
    ...tracked,
    [`${prefix}-0.txt`]: 'base 0\nchanged\n',
    [`${prefix}-1.txt`]: 'base 1\nchanged\n',
  })
  const changes = (await workspaceChanges(sessionId)).filter((change) => change.path.startsWith(prefix))
  expect(changes).toEqual([
    expect.objectContaining({ path: `${prefix}-0.txt`, additions: 1, deletions: 0 }),
    expect.objectContaining({ path: `${prefix}-1.txt`, additions: 1, deletions: 0 }),
  ])
}, 20_000)

test('workspace baseline follows the earliest message even when its snapshot is updated later', async () => {
  const path = `update-${crypto.randomUUID().slice(0, 8)}.txt`
  const first = crypto.randomUUID()
  const second = crypto.randomUUID()
  const sessionId = await createSnapshotSession([
    { messageId: first, backups: {} },
    { messageId: second, backups: { [path]: 'two\n' } },
    // An update replaces the first message's snapshot without moving it.
    { messageId: first, backups: { [path]: 'one\n' }, update: true },
  ], { [path]: 'two\nthree\n' })
  const change = (await workspaceChanges(sessionId)).find((candidate) => candidate.path === path)
  expect(change).toMatchObject({ additions: 2, deletions: 1 })
}, 20_000)

test('workspace baseline is reread when a rewind replaces the transcript between passes', async () => {
  const path = `rewound-${crypto.randomUUID().slice(0, 8)}.txt`
  const first = crypto.randomUUID()
  const sessionId = await createSnapshotSession([
    { messageId: first, backups: { [path]: 'one\n' } },
    { messageId: crypto.randomUUID(), backups: { [path]: 'two\n' } },
  ], { [path]: 'two\nthree\n' })
  const transcriptPath = join(configDir, 'projects', 'fixture', `${sessionId}.jsonl`)
  const service = sessionService as unknown as { forEachSnapshotLine: (...args: unknown[]) => Promise<void> }
  const readLines = service.forEachSnapshotLine.bind(sessionService)
  let passes = 0
  const spy = spyOn(service, 'forEachSnapshotLine').mockImplementation(async (...args: unknown[]) => {
    await readLines(...args)
    if (++passes !== 1) return
    // Like a rewind: write a replacement and rename it over the transcript,
    // here with a leading record that shifts every line number.
    const replacement = `${transcriptPath}.rewind.tmp`
    await writeFile(replacement, `${JSON.stringify({ type: 'progress' })}\n${await readFile(transcriptPath, 'utf8')}`)
    await rename(replacement, transcriptPath)
  })
  try {
    const change = (await workspaceChanges(sessionId)).find((candidate) => candidate.path === path)
    expect(change).toMatchObject({ additions: 2, deletions: 1 })
    // Two passes over the replaced read, two over the reread.
    expect(passes).toBe(4)
  } finally { spy.mockRestore() }
}, 20_000)

test('a snapshot-heavy session is charged against the retained budget', async () => {
  // No tool output at all: every byte is snapshots repeating 400 tracked files.
  const prefix = `heavy-${crypto.randomUUID().slice(0, 8)}`
  const tracked = Object.fromEntries(Array.from({ length: 400 }, (_, file) => [`${prefix}-${file}.txt`, 'same\n']))
  const records = Array.from({ length: 700 }, () => ({ messageId: crypto.randomUUID(), backups: tracked }))
  const sessionId = await createSnapshotSession(records, {})
  await expectPreviewRejected(sessionId)
}, 20_000)

test('a cancelled checkpoint listing stops while reading the transcript', async () => {
  const fixture = await createTranscript('cancelled\n')
  const hydrate = spyOn(sessionService as unknown as { entriesToMessages: () => unknown }, 'entriesToMessages')
  try {
    await expect(listSessionTurnCheckpoints(fixture.sessionId, AbortSignal.abort())).rejects.toThrow()
    expect(hydrate).not.toHaveBeenCalled()
  } finally { hydrate.mockRestore() }
})
