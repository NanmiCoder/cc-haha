import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleSessionsApi } from '../api/sessions.js'
import { SessionService, sessionService } from '../services/sessionService.js'
import { sanitizePath } from '../../utils/sessionStoragePortable.js'

const SESSION_ID = '12870000-bbbb-cccc-dddd-eeeeeeeeeeee'
const MISSING_ID = '12879999-bbbb-cccc-dddd-eeeeeeeeeeee'
let configDir: string
let previousConfigDir: string | undefined

beforeEach(async () => {
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-summary-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
})

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  await fs.rm(configDir, { recursive: true, force: true })
})

async function seedSession(sessionId = SESSION_ID) {
  const sourceWorkDir = path.join(configDir, 'source-project')
  const workDir = path.join(sourceWorkDir, '.claude', 'worktrees', 'removed')
  await fs.mkdir(sourceWorkDir, { recursive: true })
  const projectPath = sanitizePath(workDir)
  const directory = path.join(configDir, 'projects', projectPath)
  await fs.mkdir(directory, { recursive: true })
  const filePath = path.join(directory, `${sessionId}.jsonl`)
  await fs.writeFile(filePath, [
    { type: 'session-meta', workDir, permissionMode: 'plan', runtimeProviderId: 'fixture-provider', runtimeModelId: 'fixture-model', effortLevel: 'high' },
    { type: 'worktree-state', worktreeSession: { originalCwd: sourceWorkDir, worktreePath: workDir, worktreeName: 'removed', sessionId } },
    { type: 'user', uuid: 'message-1', timestamp: '2020-01-01T00:00:00.000Z', message: { role: 'user', content: 'Old conversation' } },
    { type: 'assistant', uuid: 'message-2', timestamp: '2020-01-02T00:00:00.000Z', message: { role: 'assistant', content: 'Old reply' } },
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n')
  return { filePath, sourceWorkDir, workDir, projectPath }
}

function requestSummary(sessionId: string, method = 'GET') {
  const url = new URL(`http://127.0.0.1/api/sessions/${sessionId}/summary`)
  return handleSessionsApi(new Request(url, { method }), url, url.pathname.split('/').filter(Boolean))
}

describe('session summary', () => {
  it('reads only the selected old transcript with list-equivalent runtime and workspace metadata', async () => {
    const fixture = await seedSession()
    await seedSession('12870001-bbbb-cccc-dddd-eeeeeeeeeeee')
    const service = new SessionService()
    const internals = service as unknown as {
      scanSessionListSummary: (...args: unknown[]) => Promise<unknown>
      readJsonlFile: (...args: unknown[]) => Promise<unknown>
    }
    const scan = spyOn(internals, 'scanSessionListSummary')
    const fullRead = spyOn(internals, 'readJsonlFile')
    try {
      const summary = await service.getSessionSummary(SESSION_ID)
      expect(summary).toMatchObject({
        id: SESSION_ID,
        title: 'Old conversation',
        createdAt: '2020-01-01T00:00:00.000Z',
        modifiedAt: '2020-01-02T00:00:00.000Z',
        messageCount: 2,
        workDir: fixture.workDir,
        projectPath: fixture.projectPath,
        projectRoot: await fs.realpath(fixture.sourceWorkDir),
        workDirExists: false,
        workspaceState: 'worktree_removed',
        permissionMode: 'plan',
        runtimeProviderId: 'fixture-provider',
        runtimeModelId: 'fixture-model',
        effortLevel: 'high',
      })
      expect(summary).not.toHaveProperty('messages')
      expect(scan).toHaveBeenCalledTimes(1)
      expect(scan.mock.calls[0]?.[0]).toBe(fixture.filePath)
      expect(await service.getSessionSummary(SESSION_ID)).toEqual(summary)
      expect(scan).toHaveBeenCalledTimes(1)
      const listed = await service.listSessions()
      expect(listed.sessions.find(session => session.id === SESSION_ID)).toEqual(summary)
      expect(fullRead).not.toHaveBeenCalled()
    } finally {
      scan.mockRestore()
      fullRead.mockRestore()
    }
  })

  it('returns a metadata-only API response and refreshes it after transcript changes', async () => {
    const fixture = await seedSession()
    const fullDetail = spyOn(sessionService, 'getSession')
    try {
      const response = await requestSummary(SESSION_ID)
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toMatchObject({ id: SESSION_ID, runtimeModelId: 'fixture-model', workspaceState: 'worktree_removed' })
      expect(body).not.toHaveProperty('messages')
      await fs.appendFile(fixture.filePath, `${JSON.stringify({ type: 'custom-title', customTitle: 'Renamed history' })}\n`)
      const refreshed = await requestSummary(SESSION_ID)
      expect(await refreshed.json()).toMatchObject({ id: SESSION_ID, title: 'Renamed history' })
      expect(fullDetail).not.toHaveBeenCalled()
    } finally {
      fullDetail.mockRestore()
    }
  })

  it('returns 404 for missing or deleted sessions and rejects mutations on the summary route', async () => {
    const fixture = await seedSession()
    expect((await requestSummary(MISSING_ID)).status).toBe(404)
    expect((await requestSummary(SESSION_ID, 'DELETE')).status).toBe(405)
    expect((await requestSummary(SESSION_ID)).status).toBe(200)
    await fs.unlink(fixture.filePath)
    expect((await requestSummary(SESSION_ID)).status).toBe(404)
  })
})
