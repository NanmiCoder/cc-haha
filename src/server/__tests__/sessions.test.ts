/**
 * Unit tests for SessionService and Sessions API
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import * as fs from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'
import { SessionService, sessionService } from '../services/sessionService.js'
import {
  createRepositoryBranch,
  getRepositoryContext,
  prepareSessionWorkspace,
} from '../services/repositoryLaunchService.js'
import { conversationService } from '../services/conversationService.js'
import { clearCommandsCache } from '../../commands.js'
import { parseJSONL } from '../../utils/json.js'
import { createSessionBranch } from '../../utils/sessionBranching.js'
import { sanitizePath } from '../../utils/sessionStoragePortable.js'
import { clearInstalledPluginsCache } from '../../utils/plugins/installedPluginsManager.js'
import { clearPluginCache } from '../../utils/plugins/pluginLoader.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { updateSessionSlashCommands } from '../ws/handler.js'
import { reduceTranscript } from '../services/localIndex/transcriptReducer.js'
import { openLocalIndexDatabase } from '../services/localIndex/database.js'
import { readSessionEntriesByLocator } from '../services/localIndex/sessionEntries.js'
import {
  createSessionIndex,
  type LocalIndexGateway,
} from '../services/localIndex/sessionIndex.js'
import { createSessionProjector } from '../services/localIndex/sessionProjector.js'
import type {
  SessionListSummary,
  TranscriptChunk,
  TranscriptProjection,
} from '../services/localIndex/types.js'

// ============================================================================
// Test helpers
// ============================================================================

let tmpDir: string
let service: SessionService

/** Create a temporary config dir and configure the service to use it. */
async function setupTmpConfigDir(): Promise<string> {
  tmpDir = path.join(os.tmpdir(), `claude-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(path.join(tmpDir, 'projects'), { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  return tmpDir
}

async function cleanupTmpDir(): Promise<void> {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
  delete process.env.CLAUDE_CONFIG_DIR
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
  })
}

async function createCleanGitRepo(baseDir: string): Promise<string> {
  const workDir = path.join(
    baseDir,
    `repo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )

  await fs.mkdir(workDir, { recursive: true })
  git(workDir, 'init')
  git(workDir, 'config', 'user.email', 'sessions-api@example.com')
  git(workDir, 'config', 'user.name', 'Sessions API')
  git(workDir, 'checkout', '-b', 'main')
  await fs.writeFile(path.join(workDir, 'README.md'), 'main\n')
  git(workDir, 'add', 'README.md')
  git(workDir, 'commit', '-m', 'initial')
  git(workDir, 'checkout', '-b', 'feature/rail')
  await fs.writeFile(path.join(workDir, 'feature.txt'), 'feature\n')
  git(workDir, 'add', 'feature.txt')
  git(workDir, 'commit', '-m', 'feature')
  git(workDir, 'checkout', 'main')

  return workDir
}

/** Write a JSONL session file with given entries. */
async function writeSessionFile(
  projectDir: string,
  sessionId: string,
  entries: Record<string, unknown>[]
): Promise<string> {
  const dir = path.join(tmpDir, 'projects', projectDir)
  await fs.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `${sessionId}.jsonl`)
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
  await fs.writeFile(filePath, content, 'utf-8')
  return filePath
}

async function writeSubagentTranscriptFile(
  projectDir: string,
  sessionId: string,
  agentId: string,
  entries: Record<string, unknown>[],
): Promise<string> {
  const dir = path.join(tmpDir, 'projects', projectDir, sessionId, 'subagents')
  await fs.mkdir(dir, { recursive: true })
  const normalizedAgentId = agentId.startsWith('agent-') ? agentId : `agent-${agentId}`
  const filePath = path.join(dir, `${normalizedAgentId}.jsonl`)
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
  await fs.writeFile(filePath, content, 'utf-8')
  return filePath
}

async function writeSkill(
  rootDir: string,
  skillName: string,
  description: string,
): Promise<void> {
  const skillDir = path.join(rootDir, skillName)
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    ['---', `description: ${description}`, '---', '', `# ${skillName}`].join('\n'),
    'utf-8',
  )
}

async function writeLegacySlashCommand(
  commandsDir: string,
  commandName: string,
  description: string,
): Promise<void> {
  await fs.mkdir(commandsDir, { recursive: true })
  await fs.writeFile(
    path.join(commandsDir, `${commandName}.md`),
    ['---', `description: ${description}`, 'argument-hint: <topic>', '---', '', `Run ${commandName}.`].join('\n'),
    'utf-8',
  )
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
  })
}

async function createWorkspaceApiGitRepo(baseDir: string): Promise<string> {
  const workDir = await fs.mkdtemp(path.join(baseDir, 'w-'))

  const javaControllerDir = path.join(
    workDir,
    'services',
    'mental-health-service',
    'src',
    'main',
    'java',
    'com',
    'example',
    'campus',
    'mentalhealth',
    'controller',
  )
  await fs.mkdir(path.join(workDir, 'src'), { recursive: true })
  await fs.mkdir(javaControllerDir, { recursive: true })
  git(workDir, 'init')
  git(workDir, 'config', 'user.email', 'sessions-api@example.com')
  git(workDir, 'config', 'user.name', 'Sessions API')

  await fs.writeFile(path.join(workDir, 'tracked.txt'), 'before\n')
  await fs.writeFile(path.join(workDir, 'src', 'app.ts'), 'export const answer = 42\n')
  await fs.writeFile(
    path.join(javaControllerDir, 'MentalHealthTrendController.java'),
    'package com.example.campus.mentalhealth.controller;\n\npublic final class MentalHealthTrendController {}\n',
  )
  git(workDir, 'add', 'tracked.txt', 'src/app.ts', 'services')
  git(workDir, 'commit', '-m', 'initial')

  await fs.writeFile(path.join(workDir, 'tracked.txt'), 'before\nafter\n')

  return workDir
}

async function createCleanGitRepo(baseDir: string): Promise<string> {
  const workDir = path.join(
    baseDir,
    `repo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )

  await fs.mkdir(workDir, { recursive: true })
  git(workDir, 'init')
  git(workDir, 'config', 'user.email', 'sessions-api@example.com')
  git(workDir, 'config', 'user.name', 'Sessions API')
  git(workDir, 'checkout', '-b', 'main')
  await fs.writeFile(path.join(workDir, 'README.md'), 'main\n')
  git(workDir, 'add', 'README.md')
  git(workDir, 'commit', '-m', 'initial')
  git(workDir, 'checkout', '-b', 'feature/rail')
  await fs.writeFile(path.join(workDir, 'feature.txt'), 'feature\n')
  git(workDir, 'add', 'feature.txt')
  git(workDir, 'commit', '-m', 'feature')
  git(workDir, 'checkout', 'main')

  return workDir
}

// Sample entries matching real CLI format
function makeSnapshotEntry(): Record<string, unknown> {
  return {
    type: 'file-history-snapshot',
    messageId: crypto.randomUUID(),
    snapshot: {
      messageId: crypto.randomUUID(),
      trackedFileBackups: {},
      timestamp: '2026-01-01T00:00:00.000Z',
    },
    isSnapshotUpdate: false,
  }
}

function makeFileHistorySnapshotEntry(
  snapshotMessageId: string,
  trackedFileBackups: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'file-history-snapshot',
    messageId: crypto.randomUUID(),
    snapshot: {
      messageId: snapshotMessageId,
      trackedFileBackups,
      timestamp: '2026-01-01T00:00:00.000Z',
    },
    isSnapshotUpdate: false,
  }
}

function makeUserEntry(content: string, uuid?: string): Record<string, unknown> {
  return {
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content },
    uuid: uuid || crypto.randomUUID(),
    timestamp: '2026-01-01T00:01:00.000Z',
    userType: 'external',
    cwd: '/tmp/test',
    sessionId: 'test-session',
  }
}

function makeAssistantEntry(
  content: string,
  parentUuid?: string,
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  },
): Record<string, unknown> {
  return {
    parentUuid: parentUuid || null,
    isSidechain: false,
    type: 'assistant',
    message: {
      model: 'claude-opus-4-7',
      id: `msg_${crypto.randomUUID().slice(0, 20)}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: content }],
      ...(usage ? { usage } : {}),
    },
    uuid: crypto.randomUUID(),
    timestamp: '2026-01-01T00:02:00.000Z',
  }
}

function makeAssistantToolUseEntry(
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  parentUuid?: string,
): Record<string, unknown> {
  return {
    parentUuid: parentUuid || null,
    isSidechain: false,
    type: 'assistant',
    message: {
      model: 'claude-opus-4-7',
      id: `msg_${crypto.randomUUID().slice(0, 20)}`,
      type: 'message',
      role: 'assistant',
      content: toolUses.map((toolUse) => ({
        type: 'tool_use',
        id: toolUse.id,
        name: toolUse.name,
        input: toolUse.input,
      })),
    },
    uuid: crypto.randomUUID(),
    timestamp: '2026-01-01T00:02:00.000Z',
  }
}

function makeToolResultUserEntry(
  toolUseId: string,
  content: string,
  uuid?: string,
  parentUuid?: string,
  sessionId = 'test-session',
): Record<string, unknown> {
  return {
    parentUuid: parentUuid || null,
    isSidechain: false,
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content,
      }],
    },
    uuid: uuid || crypto.randomUUID(),
    timestamp: '2026-01-01T00:02:30.000Z',
    userType: 'external',
    cwd: '/tmp/test',
    sessionId,
  }
}

function makeMetaUserEntry(): Record<string, unknown> {
  return {
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: '<local-command-caveat>internal</local-command-caveat>' },
    isMeta: true,
    uuid: crypto.randomUUID(),
    timestamp: '2026-01-01T00:00:30.000Z',
  }
}

function makeSessionMetaEntry(workDir: string): Record<string, unknown> {
  return {
    type: 'session-meta',
    isMeta: true,
    workDir,
    timestamp: '2026-01-01T00:00:00.000Z',
  }
}

function makeWorktreeStateEntry(
  sessionId: string,
  worktreePath: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'worktree-state',
    sessionId,
    worktreeSession: {
      originalCwd: '/tmp/source',
      worktreePath,
      worktreeName: 'desktop-main-12345678',
      worktreeBranch: 'worktree-desktop-main-12345678',
      originalBranch: 'main',
      sessionId,
      ...overrides,
    },
  }
}

function makeContentReplacementEntry(
  sessionId: string,
  replacements: Array<{ kind: 'tool-result'; toolUseId: string; replacement: string }>,
): Record<string, unknown> {
  return {
    type: 'content-replacement',
    sessionId,
    replacements,
  }
}

async function writeFileHistoryBackup(
  sessionId: string,
  backupFileName: string,
  content: string,
): Promise<void> {
  const dir = path.join(tmpDir, 'file-history', sessionId)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, backupFileName), content, 'utf-8')
}

type ThreeTurnCheckpointFixture = {
  sessionId: string
  workDir: string
  stepFile: string
  createdFile: string
  firstUserId: string
  secondUserId: string
  thirdUserId: string
}

async function createThreeTurnCheckpointFixture(
  sessionId: string,
): Promise<ThreeTurnCheckpointFixture> {
  const workDir = path.join(tmpDir, `turn-checkpoints-${sessionId}`)
  const stepFile = path.join(workDir, 'src', 'step.js')
  const createdFile = path.join(workDir, 'notes', 'generated.txt')
  const firstUserId = crypto.randomUUID()
  const secondUserId = crypto.randomUUID()
  const thirdUserId = crypto.randomUUID()
  const backupBase = `${sessionId}-step@v1`
  const backupV1 = `${sessionId}-step@v2`
  const backupV2 = `${sessionId}-step@v3`

  await fs.mkdir(path.dirname(stepFile), { recursive: true })
  await fs.mkdir(path.dirname(createdFile), { recursive: true })
  await fs.writeFile(stepFile, "export const STEP = 'v3'\n", 'utf-8')
  await fs.writeFile(createdFile, 'generated third turn\n', 'utf-8')
  await writeFileHistoryBackup(sessionId, backupBase, "export const STEP = 'base'\n")
  await writeFileHistoryBackup(sessionId, backupV1, "export const STEP = 'v1'\n")
  await writeFileHistoryBackup(sessionId, backupV2, "export const STEP = 'v2'\n")

  await writeSessionFile('-tmp-api-turn-checkpoints', sessionId, [
    makeSessionMetaEntry(workDir),
    makeFileHistorySnapshotEntry(firstUserId, {
      'src/step.js': {
        backupFileName: backupBase,
        version: 1,
        backupTime: '2026-01-01T00:00:00.000Z',
      },
    }),
    {
      ...makeUserEntry('make v1', firstUserId),
      cwd: workDir,
      sessionId,
    },
    makeAssistantEntry('DONE v1', firstUserId),
    makeFileHistorySnapshotEntry(secondUserId, {
      'src/step.js': {
        backupFileName: backupV1,
        version: 2,
        backupTime: '2026-01-01T00:00:00.000Z',
      },
    }),
    {
      ...makeUserEntry('make v2', secondUserId),
      cwd: workDir,
      sessionId,
    },
    makeAssistantEntry('DONE v2', secondUserId),
    makeFileHistorySnapshotEntry(thirdUserId, {
      'src/step.js': {
        backupFileName: backupV2,
        version: 3,
        backupTime: '2026-01-01T00:00:00.000Z',
      },
      'notes/generated.txt': {
        backupFileName: null,
        version: 1,
        backupTime: '2026-01-01T00:00:00.000Z',
      },
    }),
    {
      ...makeUserEntry('make v3 and create file', thirdUserId),
      cwd: workDir,
      sessionId,
    },
    makeAssistantEntry('DONE v3', thirdUserId),
  ])

  return {
    sessionId,
    workDir,
    stepFile,
    createdFile,
    firstUserId,
    secondUserId,
    thirdUserId,
  }
}

// ============================================================================
// SessionService tests
// ============================================================================

describe('SessionService', () => {
  beforeEach(async () => {
    await setupTmpConfigDir()
    service = new SessionService()
    clearInstalledPluginsCache()
    clearPluginCache('sessions-api-test-setup')
    resetSettingsCache()
  })

  afterEach(async () => {
    clearCommandsCache()
    clearInstalledPluginsCache()
    clearPluginCache('session-service-test-teardown')
    resetSettingsCache()
    await cleanupTmpDir()
  })

  // --------------------------------------------------------------------------
  // listSessions
  // --------------------------------------------------------------------------

  it('should return empty list when no sessions exist', async () => {
    const result = await service.listSessions()
    expect(result.sessions).toEqual([])
    expect(result.total).toBe(0)
  })

  it('should list sessions from JSONL files', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-testproject', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Hello Claude'),
      makeAssistantEntry('Hi there!'),
    ])

    const result = await service.listSessions()
    expect(result.total).toBe(1)
    expect(result.sessions).toHaveLength(1)

    const session = result.sessions[0]!
    expect(session.id).toBe(sessionId)
    expect(session.title).toBe('Hello Claude')
    expect(session.messageCount).toBe(2) // 1 user + 1 assistant
    expect(session.projectPath).toBe('-tmp-testproject')
    expect(session.projectRoot).toBe('/tmp/test')
  })

  it('should keep duplicate session ids from different transcript paths distinct', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-duplicate-one', sessionId, [
      makeUserEntry('First physical transcript'),
    ])
    await writeSessionFile('-tmp-duplicate-two', sessionId, [
      makeUserEntry('Second physical transcript'),
    ])

    const result = await service.listSessions({ limit: 10 })

    expect(result.total).toBe(2)
    expect(result.sessions.map((session) => session.projectPath).sort()).toEqual([
      '-tmp-duplicate-one',
      '-tmp-duplicate-two',
    ])
  })

  it('should expose the source project root for persisted worktree sessions', async () => {
    const sourceWorkDir = path.join(tmpDir, 'source-repo')
    const worktreePath = path.join(sourceWorkDir, '.claude', 'worktrees', 'desktop-main-12345678')
    await fs.mkdir(worktreePath, { recursive: true })
    const sessionId = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile(sanitizePath(worktreePath), sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry(worktreePath),
      makeWorktreeStateEntry(sessionId, worktreePath, {
        originalCwd: sourceWorkDir,
      }),
      makeUserEntry('Hello from worktree'),
    ])

    const result = await service.listSessions()

    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      id: sessionId,
      projectPath: sanitizePath(worktreePath),
      projectRoot: await fs.realpath(sourceWorkDir),
      workDir: worktreePath,
      workDirExists: true,
      workspaceState: 'available',
    })
  })

  it('should classify a cleaned worktree separately when its source project still exists', async () => {
    const sourceWorkDir = path.join(tmpDir, 'cleaned-worktree-source')
    const worktreePath = path.join(sourceWorkDir, '.claude', 'worktrees', 'desktop-main-87654321')
    await fs.mkdir(sourceWorkDir, { recursive: true })
    const sessionId = 'bbbbbbbb-bbbb-cccc-dddd-ffffffffffff'
    await writeSessionFile(sanitizePath(worktreePath), sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry(worktreePath),
      makeWorktreeStateEntry(sessionId, worktreePath, {
        originalCwd: sourceWorkDir,
      }),
      makeUserEntry('History from a cleaned worktree'),
    ])

    const listed = await service.listSessions()
    const detail = await service.getSession(sessionId)

    expect(listed.sessions[0]).toMatchObject({
      projectRoot: await fs.realpath(sourceWorkDir),
      workDir: worktreePath,
      workDirExists: false,
      workspaceState: 'worktree_removed',
    })
    expect(detail).toMatchObject({
      projectRoot: await fs.realpath(sourceWorkDir),
      workDirExists: false,
      workspaceState: 'worktree_removed',
    })
  })

  it('should keep a genuinely missing project classified as missing', async () => {
    const missingWorkDir = path.join(tmpDir, 'deleted-project')
    const sessionId = 'bbbbbbbb-bbbb-cccc-dddd-111111111111'
    await writeSessionFile(sanitizePath(missingWorkDir), sessionId, [
      makeSessionMetaEntry(missingWorkDir),
      makeUserEntry('History from a deleted project'),
    ])

    const result = await service.listSessions()

    expect(result.sessions[0]).toMatchObject({
      projectRoot: missingWorkDir,
      workDir: missingWorkDir,
      workDirExists: false,
      workspaceState: 'missing',
    })
  })

  it('should paginate results with limit and offset', async () => {
    // Create 3 sessions
    for (let i = 0; i < 3; i++) {
      const id = `0000000${i}-bbbb-cccc-dddd-eeeeeeeeeeee`
      await writeSessionFile('-tmp-test', id, [
        makeSnapshotEntry(),
        makeUserEntry(`Message ${i}`),
      ])
    }

    const page1 = await service.listSessions({ limit: 2, offset: 0 })
    expect(page1.total).toBe(3)
    expect(page1.sessions).toHaveLength(2)

    const page2 = await service.listSessions({ limit: 2, offset: 2 })
    expect(page2.total).toBe(3)
    expect(page2.sessions).toHaveLength(1)
  })

  it('should scan summaries before pagination so metadata-only writes cannot skew order', async () => {
    for (let i = 0; i < 12; i++) {
      const id = `1000000${i.toString(16)}-bbbb-cccc-dddd-eeeeeeeeeeee`
      const filePath = await writeSessionFile('-tmp-many-sessions', id, [
        makeSnapshotEntry(),
        makeUserEntry(`Message ${i}`),
      ])
      const mtime = new Date(Date.now() - i * 1000)
      await fs.utimes(filePath, mtime, mtime)
    }

    const serviceWithSpy = service as unknown as {
      scanSessionListSummary: (...args: unknown[]) => Promise<unknown>
    }
    const originalScanSessionListSummary = serviceWithSpy.scanSessionListSummary.bind(service)
    let scanCount = 0
    serviceWithSpy.scanSessionListSummary = async (...args) => {
      scanCount += 1
      return originalScanSessionListSummary(...args)
    }

    const result = await service.listSessions({ limit: 3, offset: 0 })

    expect(result.total).toBe(12)
    expect(result.sessions).toHaveLength(3)
    expect(scanCount).toBe(12)
  })

  it('should ignore metadata-only writes when sorting and dating the session list', async () => {
    const activeSessionId = '10000000-aaaa-bbbb-cccc-eeeeeeeeeeee'
    const viewedHistorySessionId = '10000001-aaaa-bbbb-cccc-eeeeeeeeeeee'
    const activeFilePath = await writeSessionFile('-tmp-viewed-history-sessions', activeSessionId, [
      makeSnapshotEntry(),
      {
        ...makeUserEntry('Recent real work'),
        timestamp: '2026-07-02T02:00:00.000Z',
      },
      {
        ...makeAssistantEntry('Recent reply'),
        timestamp: '2026-07-02T02:05:00.000Z',
      },
    ])
    const historyFilePath = await writeSessionFile('-tmp-viewed-history-sessions', viewedHistorySessionId, [
      makeSnapshotEntry(),
      {
        ...makeUserEntry('Older work'),
        timestamp: '2026-07-01T02:00:00.000Z',
      },
      {
        ...makeAssistantEntry('Older reply'),
        timestamp: '2026-07-01T02:05:00.000Z',
      },
      {
        ...makeSessionMetaEntry('/tmp/viewed-history'),
        timestamp: '2026-07-02T03:00:00.000Z',
      },
    ])
    await fs.utimes(activeFilePath, new Date('2026-07-02T02:05:00.000Z'), new Date('2026-07-02T02:05:00.000Z'))
    await fs.utimes(historyFilePath, new Date('2026-07-02T03:00:00.000Z'), new Date('2026-07-02T03:00:00.000Z'))

    const result = await service.listSessions({ project: '/tmp/viewed-history-sessions', limit: 2 })

    expect(result.sessions.map((session) => session.id)).toEqual([
      activeSessionId,
      viewedHistorySessionId,
    ])
    expect(result.sessions.find((session) => session.id === viewedHistorySessionId)?.modifiedAt)
      .toBe('2026-07-01T02:05:00.000Z')
  })

  it('should leave an incomplete final JSON line out of the session summary', async () => {
    const sessionId = '10000002-aaaa-bbbb-cccc-eeeeeeeeeeee'
    const projectDir = '-tmp-incomplete-summary'
    const dir = path.join(tmpDir, 'projects', projectDir)
    const filePath = path.join(dir, `${sessionId}.jsonl`)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      filePath,
      JSON.stringify({
        ...makeUserEntry('This line is not durable yet'),
        timestamp: '2026-07-03T02:00:00.000Z',
      }),
      'utf-8',
    )
    const fallbackTime = new Date('2026-07-03T03:00:00.000Z')
    await fs.utimes(filePath, fallbackTime, fallbackTime)

    const result = await service.listSessions({ project: '/tmp/incomplete-summary' })

    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      title: 'Untitled Session',
      modifiedAt: fallbackTime.toISOString(),
      messageCount: 0,
    })
  })

  it('should keep the file scanner and canonical reducer summaries identical', async () => {
    const sessionId = '10000003-aaaa-bbbb-cccc-eeeeeeeeeeee'
    const projectDir = '-tmp-reducer-parity'
    const dir = path.join(tmpDir, 'projects', projectDir)
    const filePath = path.join(dir, `${sessionId}.jsonl`)
    const repository = {
      requestedWorkDir: '/repo',
      repoRoot: '/repo',
      branch: 'main',
      worktree: true,
      baseRef: 'main',
      worktreePath: '/repo/.claude/worktrees/parity',
      worktreeBranch: 'worktree-parity',
      worktreeSlug: 'parity',
    }
    const worktreeSession = {
      originalCwd: '/repo',
      worktreePath: '/repo/.claude/worktrees/parity',
      worktreeName: 'parity',
      sessionId,
    }
    const completeLines = [
      JSON.stringify({
        type: 'session-meta',
        isMeta: true,
        workDir: '/repo/.claude/worktrees/parity',
        permissionMode: 'acceptEdits',
        runtimeProviderId: 'provider-a',
        runtimeModelId: 'model-a',
        effortLevel: 'high',
        timestamp: '2026-07-01T01:00:00.000Z',
      }),
      JSON.stringify({
        ...makeUserEntry('First user title'),
        cwd: '/repo/fallback',
        repository,
        timestamp: '2026-07-01T02:00:00.000Z',
      }),
      JSON.stringify({
        ...makeAssistantEntry('Assistant response'),
        timestamp: '2026-07-01T02:05:00.000Z',
      }),
      '{malformed complete line}',
      JSON.stringify({
        ...makeMetaUserEntry(),
        timestamp: '2026-07-02T03:00:00.000Z',
      }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'AI title' }),
      JSON.stringify({
        type: 'system',
        subtype: 'local_command',
        content: '<command-name>/goal</command-name><command-args>Parity goal</command-args>',
      }),
      JSON.stringify({ type: 'worktree-state', worktreeSession }),
      JSON.stringify({
        type: 'custom-title',
        customTitle: 'Canonical parity title',
        timestamp: '2026-07-02T04:00:00.000Z',
      }),
      JSON.stringify({
        type: 'session-meta',
        isMeta: true,
        workDir: '/repo/.claude/worktrees/parity-latest',
        runtimeProviderId: null,
        runtimeModelId: 'model-b',
        effortLevel: 'max',
        timestamp: '2026-07-02T05:00:00.000Z',
      }),
    ].map((line) => `${line}\n`)
    const incompleteTail = JSON.stringify({
      ...makeAssistantEntry('Pending response'),
      timestamp: '2026-07-03T00:00:00.000Z',
    })
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(filePath, `${completeLines.join('')}${incompleteTail}`, 'utf-8')

    const stat = await fs.stat(filePath)
    const scanner = service as unknown as {
      scanSessionListSummary: (
        targetPath: string,
        targetProject: string,
        targetStat: { birthtime: Date; mtime: Date },
      ) => Promise<SessionListSummary>
    }
    const scanned = await scanner.scanSessionListSummary(filePath, projectDir, stat)
    const chunks: TranscriptChunk[] = []
    let byteStart = 0
    for (const text of completeLines) {
      chunks.push({ text, byteStart, completeLine: true })
      byteStart += Buffer.byteLength(text)
    }
    chunks.push({ text: incompleteTail, byteStart, completeLine: false })
    const seed: TranscriptProjection = {
      summary: {
        title: 'Untitled Session',
        createdAt: stat.birthtime.toISOString(),
        modifiedAt: stat.mtime.toISOString(),
        messageCount: 0,
        workDir: service.desanitizePath(projectDir),
      },
      indexedBytes: 0,
      pendingTailBytes: 0,
      malformedLineCount: 0,
    }
    const reduced = reduceTranscript(chunks, seed)

    expect(scanned).toEqual(reduced.summary)
    expect(scanned).toEqual({
      title: 'Canonical parity title',
      createdAt: '2026-07-01T01:00:00.000Z',
      modifiedAt: '2026-07-01T02:05:00.000Z',
      messageCount: 3,
      workDir: '/repo/.claude/worktrees/parity-latest',
      permissionMode: 'acceptEdits',
      runtimeProviderId: null,
      runtimeModelId: 'model-b',
      effortLevel: 'max',
      repository,
      worktreeSession,
    })
    expect(reduced.malformedLineCount).toBe(1)
    expect(reduced.pendingTailBytes).toBe(Buffer.byteLength(incompleteTail))
  })

  it('should scan a multibuffer CRLF line once without splitting UTF-8 metadata', async () => {
    const sessionId = '10000004-aaaa-bbbb-cccc-eeeeeeeeeeee'
    const projectDir = '-tmp-multibuffer-reducer'
    const dir = path.join(tmpDir, 'projects', projectDir)
    const filePath = path.join(dir, `${sessionId}.jsonl`)
    const streamBufferBytes = 64 * 1024
    const targetCharacterByteStart = streamBufferBytes * 3 - 1
    const buildUserLine = (paddingLength: number) => JSON.stringify({
      type: 'user',
      padding: 'x'.repeat(paddingLength),
      message: { role: 'user', content: '你 boundary title' },
      timestamp: '2026-07-04T01:00:00.000Z',
      cwd: '/fallback/from-user',
    })
    const emptyPaddingLine = buildUserLine(0)
    const emptyCharacterIndex = emptyPaddingLine.indexOf('你')
    const emptyCharacterByteStart = Buffer.byteLength(
      emptyPaddingLine.slice(0, emptyCharacterIndex),
    )
    const userLine = buildUserLine(targetCharacterByteStart - emptyCharacterByteStart)
    const characterIndex = userLine.indexOf('你')
    expect(Buffer.byteLength(userLine.slice(0, characterIndex))).toBe(targetCharacterByteStart)

    const sessionMetaLine = JSON.stringify({
      type: 'session-meta',
      isMeta: true,
      workDir: '/metadata/workdir',
      runtimeProviderId: 'boundary-provider',
      runtimeModelId: 'boundary-model',
      effortLevel: 'xhigh',
      timestamp: '2026-07-04T02:00:00.000Z',
    })
    const firstCompleteLine = `${userLine}\r\n`
    const secondCompleteLine = `${sessionMetaLine}\r\n`
    const content = `${firstCompleteLine}${secondCompleteLine}`
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(filePath, content, 'utf-8')

    const stat = await fs.stat(filePath)
    const scanner = service as unknown as {
      scanSessionListSummary: (
        targetPath: string,
        targetProject: string,
        targetStat: { birthtime: Date; mtime: Date },
      ) => Promise<SessionListSummary>
    }
    const originalConcat = Buffer.concat
    let concatCalls = 0
    Buffer.concat = ((...args: Parameters<typeof Buffer.concat>) => {
      concatCalls += 1
      return originalConcat(...args)
    }) as typeof Buffer.concat

    let scanned: SessionListSummary
    try {
      scanned = await scanner.scanSessionListSummary(filePath, projectDir, stat)
    } finally {
      Buffer.concat = originalConcat
    }

    const seed: TranscriptProjection = {
      summary: {
        title: 'Untitled Session',
        createdAt: stat.birthtime.toISOString(),
        modifiedAt: stat.mtime.toISOString(),
        messageCount: 0,
        workDir: service.desanitizePath(projectDir),
      },
      indexedBytes: 0,
      pendingTailBytes: 0,
      malformedLineCount: 0,
    }
    const secondLineByteStart = Buffer.byteLength(firstCompleteLine)
    const reduced = reduceTranscript([
      { text: firstCompleteLine, byteStart: 0, completeLine: true },
      { text: secondCompleteLine, byteStart: secondLineByteStart, completeLine: true },
    ], seed)

    expect(concatCalls).toBe(1)
    expect(scanned).toEqual(reduced.summary)
    expect(scanned).toMatchObject({
      title: '你 boundary title',
      modifiedAt: '2026-07-04T01:00:00.000Z',
      messageCount: 1,
      workDir: '/metadata/workdir',
      runtimeProviderId: 'boundary-provider',
      runtimeModelId: 'boundary-model',
      effortLevel: 'xhigh',
    })
    expect(reduced.indexedBytes).toBe(Buffer.byteLength(content))
    expect(reduced.pendingTailBytes).toBe(0)
  })

  it('should reuse cached list metadata for repeated requests', async () => {
    for (let i = 0; i < 5; i++) {
      const id = `2000000${i.toString(16)}-bbbb-cccc-dddd-eeeeeeeeeeee`
      const filePath = await writeSessionFile('-tmp-cached-sessions', id, [
        makeSnapshotEntry(),
        makeUserEntry(`Cached message ${i}`),
      ])
      const mtime = new Date(Date.now() - i * 1000)
      await fs.utimes(filePath, mtime, mtime)
    }

    const serviceWithSpy = service as unknown as {
      scanSessionListSummary: (...args: unknown[]) => Promise<unknown>
    }
    const originalScanSessionListSummary = serviceWithSpy.scanSessionListSummary.bind(service)
    let scanCount = 0
    serviceWithSpy.scanSessionListSummary = async (...args) => {
      scanCount += 1
      return originalScanSessionListSummary(...args)
    }

    const first = await service.listSessions({ limit: 3, offset: 0 })
    const second = await service.listSessions({ limit: 3, offset: 0 })

    expect(first.sessions.map((session) => session.id)).toEqual(second.sessions.map((session) => session.id))
    expect(scanCount).toBe(5)
  })

  it('should coalesce concurrent session list scans for the same query', async () => {
    for (let i = 0; i < 3; i++) {
      const id = `2400000${i.toString(16)}-bbbb-cccc-dddd-eeeeeeeeeeee`
      await writeSessionFile('-tmp-concurrent-session-list', id, [
        makeSnapshotEntry(),
        makeUserEntry(`Concurrent message ${i}`),
      ])
    }

    const serviceWithSpy = service as unknown as {
      scanSessionListSummary: (...args: unknown[]) => Promise<unknown>
    }
    const originalScanSessionListSummary = serviceWithSpy.scanSessionListSummary.bind(service)
    let scanCount = 0
    let releaseFirstScan: () => void = () => {}
    let markFirstScanStarted: () => void = () => {}
    const firstScanStarted = new Promise<void>((resolve) => {
      markFirstScanStarted = resolve
    })
    const firstScanGate = new Promise<void>((resolve) => {
      releaseFirstScan = resolve
    })

    serviceWithSpy.scanSessionListSummary = async (...args) => {
      scanCount += 1
      if (scanCount === 1) {
        markFirstScanStarted()
        await firstScanGate
      }
      return originalScanSessionListSummary(...args)
    }

    const first = service.listSessions({ limit: 3, offset: 0 })
    await firstScanStarted
    const second = service.listSessions({ limit: 3, offset: 0 })
    await new Promise((resolve) => setTimeout(resolve, 10))
    releaseFirstScan()

    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(firstResult).toEqual(secondResult)
    expect(scanCount).toBe(3)
  })

  it('should isolate warm session list caches by the active config scope', async () => {
    const scopeRoot = path.join(tmpDir, 'session-list-cache-scopes')
    const firstConfigDir = path.join(scopeRoot, 'first')
    const secondConfigDir = path.join(scopeRoot, 'second')
    const seedScope = async (configDir: string, sessionId: string, title: string) => {
      const projectDir = path.join(configDir, 'projects', '-tmp-cache-scope')
      await fs.mkdir(projectDir, { recursive: true })
      await fs.writeFile(
        path.join(projectDir, `${sessionId}.jsonl`),
        `${JSON.stringify(makeUserEntry(title))}\n`,
        'utf8',
      )
    }
    await seedScope(
      firstConfigDir,
      '24100000-bbbb-cccc-dddd-eeeeeeeeeeee',
      'First scope title',
    )
    await seedScope(
      secondConfigDir,
      '24100001-bbbb-cccc-dddd-eeeeeeeeeeee',
      'Second scope title',
    )

    process.env.CLAUDE_CONFIG_DIR = firstConfigDir
    const first = await service.listSessions({ limit: 10, offset: 0 })
    process.env.CLAUDE_CONFIG_DIR = secondConfigDir
    const second = await service.listSessions({ limit: 10, offset: 0 })

    expect(first.sessions.map(session => session.id)).toEqual([
      '24100000-bbbb-cccc-dddd-eeeeeeeeeeee',
    ])
    expect(second.sessions.map(session => session.id)).toEqual([
      '24100001-bbbb-cccc-dddd-eeeeeeeeeeee',
    ])
  })

  it('should bound session page and summary caches with LRU retention', async () => {
    let now = 1_000
    const projects = ['-tmp-bounded-cache-a', '-tmp-bounded-cache-b', '-tmp-bounded-cache-c']
    for (let index = 0; index < projects.length; index += 1) {
      await writeSessionFile(
        projects[index]!,
        `2420000${index}-bbbb-cccc-dddd-eeeeeeeeeeee`,
        [makeUserEntry(`Bounded cache ${index}`)],
      )
    }
    const boundedService = new SessionService(undefined, {
      now: () => now,
      sessionListCacheMaxEntries: 2,
      sessionListSummaryCacheMaxEntries: 2,
    })
    const internals = boundedService as unknown as {
      sessionListCache: Map<string, unknown>
      sessionListSummaryCache: Map<string, unknown>
    }

    await boundedService.listSessions({ project: '/tmp/bounded/cache/a', limit: 1 })
    await boundedService.listSessions({ project: '/tmp/bounded/cache/b', limit: 1 })
    now += 6_000
    await boundedService.listSessions({ project: '/tmp/bounded/cache/a', limit: 1 })
    await boundedService.listSessions({ project: '/tmp/bounded/cache/c', limit: 1 })

    expect(internals.sessionListCache.size).toBe(2)
    expect([...internals.sessionListCache.keys()].some(key => (
      JSON.parse(key) as { project: string }
    ).project === '/tmp/bounded/cache/a')).toBe(true)
    expect([...internals.sessionListCache.keys()].some(key => (
      JSON.parse(key) as { project: string }
    ).project === '/tmp/bounded/cache/b')).toBe(false)
    expect(internals.sessionListSummaryCache.size).toBe(2)
    expect([...internals.sessionListSummaryCache.keys()].some(filePath => (
      filePath.includes('-tmp-bounded-cache-a')
    ))).toBe(true)
    expect([...internals.sessionListSummaryCache.keys()].some(filePath => (
      filePath.includes('-tmp-bounded-cache-b')
    ))).toBe(false)
  })

  it('should remove a deleted transcript from the session summary cache', async () => {
    const sessionId = '24205000-bbbb-cccc-dddd-eeeeeeeeeeee'
    const filePath = await writeSessionFile(
      '-tmp-deleted-summary-cache',
      sessionId,
      [makeUserEntry('Delete cached summary')],
    )
    const internals = service as unknown as {
      sessionListSummaryCache: Map<string, unknown>
    }

    await service.listSessions({ limit: 10 })
    expect(internals.sessionListSummaryCache.has(filePath)).toBe(true)
    await service.deleteSession(sessionId)

    expect(internals.sessionListSummaryCache.has(filePath)).toBe(false)
  })

  it('should remove expired session pages and caches from inactive config scopes', async () => {
    let now = 1_000
    const boundedService = new SessionService(undefined, { now: () => now })
    const internals = boundedService as unknown as {
      sessionListCache: Map<string, unknown>
      sessionListSummaryCache: Map<string, unknown>
    }
    const scopeRoot = path.join(tmpDir, 'bounded-cache-scopes')
    const firstConfigDir = path.join(scopeRoot, 'first')
    const secondConfigDir = path.join(scopeRoot, 'second')
    const seedScope = async (configDir: string, sessionId: string) => {
      const projectDir = path.join(configDir, 'projects', '-tmp-bounded-scope')
      await fs.mkdir(projectDir, { recursive: true })
      await fs.writeFile(
        path.join(projectDir, `${sessionId}.jsonl`),
        `${JSON.stringify(makeUserEntry(sessionId))}\n`,
        'utf8',
      )
    }
    await seedScope(firstConfigDir, '24210000-bbbb-cccc-dddd-eeeeeeeeeeee')
    await seedScope(secondConfigDir, '24210001-bbbb-cccc-dddd-eeeeeeeeeeee')

    process.env.CLAUDE_CONFIG_DIR = firstConfigDir
    await boundedService.listSessions({ limit: 1, offset: 0 })
    now += 6_000
    await boundedService.listSessions({ limit: 1, offset: 1 })
    expect(internals.sessionListCache.size).toBe(1)

    process.env.CLAUDE_CONFIG_DIR = secondConfigDir
    await boundedService.listSessions({ limit: 1, offset: 0 })

    expect([...internals.sessionListCache.keys()].every(key => (
      JSON.parse(key) as { scope: string }
    ).scope === path.resolve(secondConfigDir))).toBe(true)
    expect([...internals.sessionListSummaryCache.keys()].every(filePath => (
      filePath.startsWith(`${path.resolve(secondConfigDir)}${path.sep}`)
    ))).toBe(true)
  })

  it('should not coalesce in-flight session list scans across config scopes', async () => {
    const scopeRoot = path.join(tmpDir, 'session-list-request-scopes')
    const firstConfigDir = path.join(scopeRoot, 'first')
    const secondConfigDir = path.join(scopeRoot, 'second')
    const seedScope = async (configDir: string, sessionId: string, title: string) => {
      const projectDir = path.join(configDir, 'projects', '-tmp-request-scope')
      await fs.mkdir(projectDir, { recursive: true })
      await fs.writeFile(
        path.join(projectDir, `${sessionId}.jsonl`),
        `${JSON.stringify(makeUserEntry(title))}\n`,
        'utf8',
      )
    }
    await seedScope(
      firstConfigDir,
      '24300000-bbbb-cccc-dddd-eeeeeeeeeeee',
      'First in-flight scope',
    )
    await seedScope(
      secondConfigDir,
      '24300001-bbbb-cccc-dddd-eeeeeeeeeeee',
      'Second in-flight scope',
    )

    const serviceWithSpy = service as unknown as {
      scanSessionListSummary: (...args: unknown[]) => Promise<unknown>
    }
    const originalScanSessionListSummary = serviceWithSpy.scanSessionListSummary.bind(service)
    let releaseFirstScan: () => void = () => {}
    let markFirstScanStarted: () => void = () => {}
    const firstScanStarted = new Promise<void>((resolve) => {
      markFirstScanStarted = resolve
    })
    const firstScanGate = new Promise<void>((resolve) => {
      releaseFirstScan = resolve
    })
    serviceWithSpy.scanSessionListSummary = async (...args) => {
      if (String(args[0]).startsWith(firstConfigDir)) {
        markFirstScanStarted()
        await firstScanGate
      }
      return originalScanSessionListSummary(...args)
    }

    process.env.CLAUDE_CONFIG_DIR = firstConfigDir
    const firstScopeRequest = service.listSessions({ limit: 10, offset: 0 })
    await firstScanStarted
    process.env.CLAUDE_CONFIG_DIR = secondConfigDir
    const secondScopeRequest = service.listSessions({ limit: 10, offset: 0 })
    await new Promise(resolve => setTimeout(resolve, 10))
    releaseFirstScan()

    const [first, second] = await Promise.all([firstScopeRequest, secondScopeRequest])
    expect(first.sessions.map(session => session.id)).toEqual([
      '24300000-bbbb-cccc-dddd-eeeeeeeeeeee',
    ])
    expect(second.sessions.map(session => session.id)).toEqual([
      '24300001-bbbb-cccc-dddd-eeeeeeeeeeee',
    ])
  })

  it('should coalesce file summary scans across concurrent pagination queries', async () => {
    for (let i = 0; i < 3; i++) {
      const id = `2420000${i.toString(16)}-bbbb-cccc-dddd-eeeeeeeeeeee`
      await writeSessionFile('-tmp-concurrent-session-pages', id, [
        makeSnapshotEntry(),
        makeUserEntry(`Concurrent page message ${i}`),
      ])
    }

    const serviceWithSpy = service as unknown as {
      scanSessionListSummary: (...args: unknown[]) => Promise<unknown>
    }
    const originalScanSessionListSummary = serviceWithSpy.scanSessionListSummary.bind(service)
    let scanCount = 0
    let releaseFirstScan: () => void = () => {}
    let markFirstScanStarted: () => void = () => {}
    const firstScanStarted = new Promise<void>((resolve) => {
      markFirstScanStarted = resolve
    })
    const firstScanGate = new Promise<void>((resolve) => {
      releaseFirstScan = resolve
    })

    serviceWithSpy.scanSessionListSummary = async (...args) => {
      scanCount += 1
      if (scanCount === 1) {
        markFirstScanStarted()
        await firstScanGate
      }
      return originalScanSessionListSummary(...args)
    }

    const sidebarRequest = service.listSessions({ limit: 400, offset: 0 })
    await firstScanStarted
    const tabRestoreRequest = service.listSessions({ limit: 200, offset: 0 })
    await new Promise((resolve) => setTimeout(resolve, 10))
    releaseFirstScan()

    const [sidebarResult, tabRestoreResult] = await Promise.all([
      sidebarRequest,
      tabRestoreRequest,
    ])

    expect(sidebarResult.sessions).toHaveLength(3)
    expect(tabRestoreResult.sessions).toHaveLength(3)
    expect(scanCount).toBe(3)
  })

  it('should not reuse or cache a list scan started before session metadata changes', async () => {
    const sessionId = '24500000-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-invalidated-session-list', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Original title'),
    ])

    const serviceWithSpy = service as unknown as {
      scanSessionListSummary: (...args: unknown[]) => Promise<unknown>
    }
    const originalScanSessionListSummary = serviceWithSpy.scanSessionListSummary.bind(service)
    let scanCount = 0
    let releaseFirstScan: () => void = () => {}
    let markFirstScanStarted: () => void = () => {}
    const firstScanStarted = new Promise<void>((resolve) => {
      markFirstScanStarted = resolve
    })
    const firstScanGate = new Promise<void>((resolve) => {
      releaseFirstScan = resolve
    })

    serviceWithSpy.scanSessionListSummary = async (...args) => {
      scanCount += 1
      const summary = await originalScanSessionListSummary(...args)
      if (scanCount === 1) {
        markFirstScanStarted()
        await firstScanGate
      }
      return summary
    }

    const staleRequest = service.listSessions({ limit: 10, offset: 0 })
    await firstScanStarted
    await service.renameSession(sessionId, 'Renamed while scanning')

    const freshRequest = service.listSessions({ limit: 10, offset: 0 })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(scanCount).toBe(2)

    const freshResult = await freshRequest
    expect(freshResult.sessions[0]?.title).toBe('Renamed while scanning')

    releaseFirstScan()
    const staleResult = await staleRequest
    expect(staleResult.sessions[0]?.title).toBe('Original title')

    const cachedResult = await service.listSessions({ limit: 10, offset: 0 })
    expect(cachedResult.sessions[0]?.title).toBe('Renamed while scanning')
  })

  it('should reuse unchanged file summaries after the list response cache is cleared', async () => {
    const sessionFiles: Array<{ id: string; filePath: string }> = []
    for (let i = 0; i < 3; i++) {
      const id = `2500000${i.toString(16)}-bbbb-cccc-dddd-eeeeeeeeeeee`
      const filePath = await writeSessionFile('-tmp-file-summary-cache', id, [
        makeSnapshotEntry(),
        makeUserEntry(`Cached file summary ${i}`),
      ])
      const mtime = new Date(Date.now() - i * 1000)
      await fs.utimes(filePath, mtime, mtime)
      sessionFiles.push({ id, filePath })
    }

    const serviceWithSpy = service as unknown as {
      scanSessionListSummary: (...args: unknown[]) => Promise<unknown>
    }
    const serviceInternals = service as unknown as {
      sessionListCache: Map<string, unknown>
    }
    const originalScanSessionListSummary = serviceWithSpy.scanSessionListSummary.bind(service)
    let scanCount = 0
    serviceWithSpy.scanSessionListSummary = async (...args) => {
      scanCount += 1
      return originalScanSessionListSummary(...args)
    }

    await service.listSessions({ limit: 3, offset: 0 })
    expect(scanCount).toBe(3)

    serviceInternals.sessionListCache.clear()
    const second = await service.listSessions({ limit: 3, offset: 0 })
    expect(second.sessions).toHaveLength(3)
    expect(scanCount).toBe(3)

    await fs.appendFile(
      sessionFiles[1]!.filePath,
      `${JSON.stringify({
        type: 'custom-title',
        customTitle: 'Changed cached file summary',
        timestamp: new Date().toISOString(),
      })}\n`,
      'utf-8',
    )
    serviceInternals.sessionListCache.clear()

    const third = await service.listSessions({ limit: 3, offset: 0 })
    expect(third.sessions.find((session) => session.id === sessionFiles[1]!.id)?.title)
      .toBe('Changed cached file summary')
    expect(scanCount).toBe(4)
  })

  it('should invalidate cached list metadata after writes', async () => {
    const sessionId = '30000000-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-cache-invalidation', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Original title'),
    ])

    const first = await service.listSessions({ limit: 10, offset: 0 })
    expect(first.sessions[0]!.title).toBe('Original title')

    await service.renameSession(sessionId, 'Renamed title')
    const second = await service.listSessions({ limit: 10, offset: 0 })

    expect(second.sessions[0]!.title).toBe('Renamed title')
  })

  it('should filter sessions by project', async () => {
    const id1 = 'aaaaaaaa-1111-cccc-dddd-eeeeeeeeeeee'
    const id2 = 'aaaaaaaa-2222-cccc-dddd-eeeeeeeeeeee'

    await writeSessionFile('-project-a', id1, [makeSnapshotEntry(), makeUserEntry('In A')])
    await writeSessionFile('-project-b', id2, [makeSnapshotEntry(), makeUserEntry('In B')])

    const resultA = await service.listSessions({ project: '/project/a' })
    expect(resultA.total).toBe(1)
    expect(resultA.sessions[0]!.id).toBe(id1)
  })

  // --------------------------------------------------------------------------
  // getSession
  // --------------------------------------------------------------------------

  it('should return null for non-existent session', async () => {
    const result = await service.getSession('00000000-0000-0000-0000-000000000000')
    expect(result).toBeNull()
  })

  it('should return session detail with messages', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const userUuid = crypto.randomUUID()
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Tell me a joke', userUuid),
      makeAssistantEntry('Why did the chicken cross the road?', userUuid),
    ])

    const detail = await service.getSession(sessionId)
    expect(detail).not.toBeNull()
    expect(detail!.id).toBe(sessionId)
    expect(detail!.title).toBe('Tell me a joke')
    expect(detail!.messages).toHaveLength(2)
    expect(detail!.messages[0]!.type).toBe('user')
    expect(detail!.messages[1]!.type).toBe('assistant')
  })

  it('should derive session detail modifiedAt from transcript messages', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const filePath = await writeSessionFile('-tmp-project', sessionId, [
      {
        ...makeSessionMetaEntry('/tmp/project'),
        timestamp: '2026-01-03T00:00:00.000Z',
      },
      {
        ...makeUserEntry('Earlier user work'),
        timestamp: '2026-01-01T00:01:00.000Z',
      },
      {
        ...makeAssistantEntry('Earlier assistant reply'),
        timestamp: '2026-01-01T00:02:00.000Z',
      },
      {
        type: 'custom-title',
        customTitle: 'Later title metadata',
        timestamp: '2026-01-04T00:00:00.000Z',
      },
    ])
    const mtime = new Date('2026-01-05T00:00:00.000Z')
    await fs.utimes(filePath, mtime, mtime)

    const detail = await service.getSession(sessionId)

    expect(detail?.modifiedAt).toBe('2026-01-01T00:02:00.000Z')
  })

  it('should skip meta entries in messages', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeMetaUserEntry(),
      makeUserEntry('Real message'),
    ])

    const detail = await service.getSession(sessionId)
    expect(detail!.messages).toHaveLength(1)
    expect(detail!.messages[0]!.content).toBe('Real message')
  })

  // --------------------------------------------------------------------------
  // getSessionMessages
  // --------------------------------------------------------------------------

  it('should throw for non-existent session messages', async () => {
    expect(
      service.getSessionMessages('00000000-0000-0000-0000-000000000000')
    ).rejects.toThrow('Session not found')
  })

  it('should return messages only', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Hello'),
      makeAssistantEntry('World'),
    ])

    const messages = await service.getSessionMessages(sessionId)
    expect(messages).toHaveLength(2)
  })

  it('preserves structured toolUseResult metadata for AskUserQuestion answers', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'ask-1',
              content: 'User has answered your questions: "Pick one?"="A". You can now continue with the user\'s answers in mind.',
            },
          ],
        },
        toolUseResult: {
          questions: [{ question: 'Pick one?', options: [{ label: 'A' }] }],
          answers: { 'Pick one?': 'A' },
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:01.000Z',
      },
    ])

    const messages = await service.getSessionMessages(sessionId)

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      type: 'tool_result',
      toolUseResult: {
        answers: { 'Pick one?': 'A' },
      },
    })
  })

  it('should append subagent tool calls under their parent agent tool result', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-project'
    const agentId = 'abc123'

    await writeSessionFile(projectDir, sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Dispatch an agent'),
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'Agent:0',
              name: 'Agent',
              input: { description: 'Inspect alpha' },
            },
          ],
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:02.000Z',
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'Agent:0',
              content: [
                {
                  type: 'text',
                  text: `alpha summary\nagentId: ${agentId} (use SendMessage with to: '${agentId}' to continue this agent)\n<usage>total_tokens: 10\ntool_uses: 2\nduration_ms: 30</usage>`,
                },
              ],
            },
          ],
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:03.000Z',
      },
    ])
    await writeSubagentTranscriptFile(projectDir, sessionId, agentId, [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'Read:0',
              name: 'Read',
              input: { file_path: '/tmp/alpha.txt' },
            },
          ],
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:04.000Z',
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'Read:0',
              content: 'alpha body',
            },
          ],
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:05.000Z',
      },
    ])

    const messages = await service.getSessionMessages(sessionId)
    const childToolUse = messages.find(
      (message) => message.type === 'tool_use' && message.parentToolUseId === 'Agent:0',
    )
    const childToolResult = messages.find(
      (message) => message.type === 'tool_result' && message.parentToolUseId === 'Agent:0',
    )

    expect(childToolUse?.content).toEqual([
      {
        type: 'tool_use',
        id: 'Agent:0/abc123/Read:0',
        name: 'Read',
        input: { file_path: '/tmp/alpha.txt' },
        original_tool_use_id: 'Read:0',
      },
    ])
    expect(childToolResult?.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'Agent:0/abc123/Read:0',
        content: 'alpha body',
        original_tool_use_id: 'Read:0',
      },
    ])
  })

  it('should include linked subagent transcript changes in the message signature', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-project'
    const agentId = 'abc123'

    await writeSessionFile(projectDir, sessionId, [
      makeSnapshotEntry(),
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'Agent:0',
              name: 'Agent',
              input: { description: 'Inspect alpha' },
            },
          ],
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:02.000Z',
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'Agent:0',
              content: [
                {
                  type: 'text',
                  text: `alpha summary\nagentId: ${agentId}`,
                },
              ],
            },
          ],
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:03.000Z',
      },
    ])
    const subagentFile = await writeSubagentTranscriptFile(projectDir, sessionId, agentId, [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'Read:0',
              name: 'Read',
              input: { file_path: '/tmp/alpha.txt' },
            },
          ],
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:04.000Z',
      },
    ])

    const before = await service.getSessionMessagesSignature(sessionId)

    await fs.appendFile(subagentFile, `${JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'Read:0',
            content: 'updated alpha body',
          },
        ],
      },
      uuid: crypto.randomUUID(),
      timestamp: '2026-01-01T00:00:05.000Z',
    })}\n`)

    const after = await service.getSessionMessagesSignature(sessionId)

    expect(before).not.toBe(after)
  })

  it('should hide synthetic interruption, no-response, and malformed command breadcrumb transcript entries', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('正常用户消息', crypto.randomUUID()),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '[Request interrupted by user]' }],
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:02.000Z',
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'No response requested.' }],
          model: '<synthetic>',
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:03.000Z',
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: '<command-name>/exit</command-name>\n<command-message>exit</command-message>\n<command-args></command-args>',
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:04.000Z',
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<command-name>/agent</command-name>\n<command-message>agent</command-message>\n<command-args>Plan 222</command-args>',
            },
          ],
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:05.000Z',
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: '<command-name>/agent</command-name> malformed breadcrumb',
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:06.000Z',
      },
      makeAssistantEntry('正常助手消息', crypto.randomUUID()),
    ])

    const messages = await service.getSessionMessages(sessionId)

    expect(messages).toHaveLength(4)
    expect(messages[0]).toMatchObject({ type: 'user', content: '正常用户消息' })
    expect(messages[1]).toMatchObject({
      type: 'user',
      content: '<command-name>/exit</command-name>\n<command-message>exit</command-message>\n<command-args></command-args>',
    })
    expect(messages[2]).toMatchObject({
      type: 'user',
      content: [{
        type: 'text',
        text: '<command-name>/agent</command-name>\n<command-message>agent</command-message>\n<command-args>Plan 222</command-args>',
      }],
    })
    expect(messages[3]).toMatchObject({
      type: 'assistant',
      content: [{ type: 'text', text: '正常助手消息' }],
    })
  })

  it('should keep user-invoked skill command metadata for desktop history restore', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry([
        '<command-message>frontend-design</command-message>',
        '<command-name>/frontend-design</command-name>',
        '<command-args>redesign the settings page</command-args>',
      ].join('\n'), 'skill-command-user'),
      makeAssistantEntry('正常助手消息', 'skill-command-user'),
    ])

    const messages = await service.getSessionMessages(sessionId)

    expect(messages).toHaveLength(2)
    const skillCommandContent = String(messages[0]!.content)
    expect(messages[0]).toMatchObject({
      id: 'skill-command-user',
      type: 'user',
      content: expect.stringContaining('<command-name>/frontend-design</command-name>'),
    })
    expect(skillCommandContent).toContain('<command-args>redesign the settings page</command-args>')
    expect(messages[1]).toMatchObject({ type: 'assistant' })
  })

  it('should keep /goal local command transcript entries for desktop history restore', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      {
        parentUuid: null,
        isSidechain: false,
        type: 'system',
        subtype: 'local_command',
        content: '<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>ship persisted goal</command-args>',
        level: 'info',
        timestamp: '2026-01-01T00:00:01.000Z',
        uuid: 'goal-command',
      },
      {
        parentUuid: 'goal-command',
        isSidechain: false,
        type: 'system',
        subtype: 'local_command',
        content: '<local-command-stdout>Goal set: ship persisted goal</local-command-stdout>',
        level: 'info',
        timestamp: '2026-01-01T00:00:02.000Z',
        uuid: 'goal-output',
      },
      {
        parentUuid: 'goal-output',
        isSidechain: false,
        type: 'system',
        subtype: 'local_command',
        content: '<local-command-stdout>Goal continuing: verify persisted follow-up</local-command-stdout>',
        level: 'info',
        timestamp: '2026-01-01T00:00:03.000Z',
        uuid: 'goal-continuing',
      },
      makeAssistantEntry('正常助手消息', crypto.randomUUID()),
    ])

    const messages = await service.getSessionMessages(sessionId)

    expect(messages).toMatchObject([
      {
        id: 'goal-command',
        type: 'system',
        content: expect.stringContaining('<command-name>/goal</command-name>'),
      },
      {
        id: 'goal-output',
        type: 'system',
        content: expect.stringContaining('Goal set: ship persisted goal'),
      },
      {
        id: 'goal-continuing',
        type: 'system',
        content: expect.stringContaining('Goal continuing: verify persisted follow-up'),
      },
      {
        type: 'assistant',
      },
    ])
  })

  it('should hide task-notification turns and their automatic responses from history', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const firstUserId = crypto.randomUUID()
    const firstAssistantId = crypto.randomUUID()
    const taskNotificationId = crypto.randomUUID()
    const taskAssistantId = crypto.randomUUID()
    const taskToolUseMessageId = crypto.randomUUID()
    const taskToolResultId = crypto.randomUUID()
    const taskAfterToolId = crypto.randomUUID()
    const realFollowUpId = crypto.randomUUID()
    const realAssistantId = crypto.randomUUID()

    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      {
        ...makeUserEntry('创建一个项目', firstUserId),
        parentUuid: null,
      },
      {
        ...makeAssistantEntry('项目已经创建', firstUserId),
        uuid: firstAssistantId,
      },
      {
        ...makeUserEntry(
          '<task-notification>\n<task-id>bg-1</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>completed</status>\n<summary>Background command completed</summary>\n</task-notification>',
          taskNotificationId,
        ),
        parentUuid: firstAssistantId,
      },
      {
        ...makeAssistantEntry('旧后台任务通知，无需处理', taskNotificationId),
        uuid: taskAssistantId,
      },
      {
        ...makeAssistantToolUseEntry([{
          id: 'toolu_restart',
          name: 'Bash',
          input: { command: 'npm run dev' },
        }], taskAssistantId),
        uuid: taskToolUseMessageId,
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_restart',
            content: 'server restarted',
          }],
        },
        uuid: taskToolResultId,
        parentUuid: taskToolUseMessageId,
        timestamp: '2026-01-01T00:03:00.000Z',
      },
      {
        ...makeAssistantEntry('后台任务触发的工具调用完成', taskToolResultId),
        uuid: taskAfterToolId,
      },
      {
        ...makeUserEntry('继续真实问题', realFollowUpId),
        parentUuid: taskAfterToolId,
      },
      {
        ...makeAssistantEntry('真实回答', realFollowUpId),
        uuid: realAssistantId,
      },
    ])

    const messages = await service.getSessionMessages(sessionId)
    const taskNotifications = await service.getSessionTaskNotifications(sessionId)

    expect(messages.map((message) => message.id)).toEqual([
      firstUserId,
      firstAssistantId,
      realFollowUpId,
      realAssistantId,
    ])
    expect(JSON.stringify(messages)).not.toContain('<task-notification>')
    expect(JSON.stringify(messages)).not.toContain('旧后台任务通知')
    expect(JSON.stringify(messages)).not.toContain('server restarted')
    expect(JSON.stringify(messages)).not.toContain('后台任务触发的工具调用完成')
    expect(taskNotifications).toEqual([
      {
        taskId: 'bg-1',
        toolUseId: 'toolu_bg',
        status: 'completed',
        summary: 'Background command completed',
        timestamp: '2026-01-01T00:01:00.000Z',
      },
    ])
  })

  it('uses bounded locators for snapshots and task notifications with safe fallback', async () => {
    const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const projectDir = '-tmp-locator-consumers'
    const snapshotMessageId = crypto.randomUUID()
    const taskNotification = [
      '<task-notification>',
      '<task-id>locator-task</task-id>',
      '<tool-use-id>toolu_locator</tool-use-id>',
      '<status>completed</status>',
      '<summary>Locator completed</summary>',
      '</task-notification>',
    ].join('\n')
    const filePath = await writeSessionFile(projectDir, sessionId, [
      makeFileHistorySnapshotEntry(snapshotMessageId, {}),
      makeUserEntry(taskNotification, 'task-notification-locator'),
      makeAssistantEntry('x'.repeat(256 * 1024), 'task-notification-locator'),
    ])
    const snapshot = await fs.stat(filePath)
    const database = openLocalIndexDatabase({ path: path.join(tmpDir, 'index-v1.sqlite') })
    const index = createSessionIndex(database)
    const projector = createSessionProjector({ database, index, scope: tmpDir })
    await projector.projectSource({
      path: filePath,
      sessionId,
      projectPath: projectDir,
      fallbackCreatedAt: snapshot.birthtime.toISOString(),
      fallbackModifiedAt: snapshot.mtime.toISOString(),
      fallbackWorkDir: '/tmp/locator-consumers',
      modifiedAtMs: snapshot.mtimeMs,
    })

    let mode: 'off' | 'shadow' | 'on' = 'on'
    let locatorCalls = 0
    let serveWrongEmptyFingerprint = false
    const gateway: LocalIndexGateway = {
      async start() {},
      async stop() {},
      getMode: () => mode,
      getPublicStatus: () => ({
        mode,
        state: mode === 'off' ? 'off' : 'ready',
        discovered: 1,
        indexed: 1,
        degradedSources: 0,
        databaseBytes: 0,
        walBytes: 0,
        lastUpdatedAt: '2026-07-15T00:00:00.000Z',
        lastErrorCode: null,
      }),
      isSessionScopeReady: () => mode !== 'off',
      rebuild: async () => gateway.getPublicStatus(),
      listSessions: options => index.listSessions(options),
      findSessionFiles: id => index.findSessionFiles(id),
      getSessionEntryLocators: (transcriptPath, entryTypes) => {
        locatorCalls += 1
        const page = index.getSessionEntryLocators(transcriptPath, entryTypes)
        if (!page || !serveWrongEmptyFingerprint) return page
        return {
          source: {
            ...page.source,
            fileIdentity: null,
            fingerprint: 'wrong-fingerprint',
          },
          entries: [],
        }
      },
    }
    const targetedReads: Array<{ bytesRead: number; rangesRead: number }> = []
    const indexedService = new SessionService(gateway, {
      targetedEntryReader: async options => {
        const result = await readSessionEntriesByLocator(options)
        if (result) targetedReads.push(result)
        return result
      },
    })

    try {
      expect(await indexedService.getSessionFileHistorySnapshots(sessionId)).toEqual([
        expect.objectContaining({ messageId: snapshotMessageId }),
      ])
      expect(await indexedService.getSessionTaskNotifications(sessionId)).toEqual([{
        taskId: 'locator-task',
        toolUseId: 'toolu_locator',
        status: 'completed',
        summary: 'Locator completed',
        timestamp: '2026-01-01T00:01:00.000Z',
      }])
      const fileSize = (await fs.stat(filePath)).size
      expect(targetedReads).toHaveLength(2)
      expect(targetedReads.every(read => read.rangesRead === 1)).toBeTrue()
      expect(targetedReads.every(read => read.bytesRead < fileSize)).toBeTrue()

      serveWrongEmptyFingerprint = true
      expect(await indexedService.getSessionFileHistorySnapshots(sessionId)).toEqual([
        expect.objectContaining({ messageId: snapshotMessageId }),
      ])
      serveWrongEmptyFingerprint = false

      const callsBeforeFullHistory = locatorCalls
      expect(await indexedService.getSessionMessages(sessionId)).toHaveLength(0)
      expect(locatorCalls).toBe(callsBeforeFullHistory)

      mode = 'shadow'
      const callsBeforeShadow = locatorCalls
      expect(await indexedService.getSessionTaskNotifications(sessionId)).toHaveLength(1)
      expect(locatorCalls).toBe(callsBeforeShadow)

      mode = 'on'
      const fallbackService = new SessionService(gateway, {
        targetedEntryReader: async () => {
          throw new Error('injected range read failure')
        },
      })
      expect(await fallbackService.getSessionFileHistorySnapshots(sessionId)).toEqual([
        expect.objectContaining({ messageId: snapshotMessageId }),
      ])
    } finally {
      database.close()
    }
  })

  it('should reconstruct parent agent tool linkage from parentUuid chains', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const userUuid = crypto.randomUUID()
    const agentAssistantUuid = crypto.randomUUID()
    const childAssistantUuid = crypto.randomUUID()

    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Inspect the codebase', userUuid),
      {
        parentUuid: userUuid,
        isSidechain: false,
        type: 'assistant',
        message: {
          model: 'claude-opus-4-7',
          id: `msg_${crypto.randomUUID().slice(0, 20)}`,
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Agent',
              id: 'agent-tool-1',
              input: { description: 'Inspect src/components' },
            },
          ],
        },
        uuid: agentAssistantUuid,
        timestamp: '2026-01-01T00:02:00.000Z',
      },
      {
        parentUuid: agentAssistantUuid,
        isSidechain: true,
        type: 'assistant',
        message: {
          model: 'claude-opus-4-7',
          id: `msg_${crypto.randomUUID().slice(0, 20)}`,
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Read',
              id: 'read-tool-1',
              input: { file_path: 'src/components/App.tsx' },
            },
          ],
        },
        uuid: childAssistantUuid,
        timestamp: '2026-01-01T00:02:30.000Z',
      },
      {
        parentUuid: childAssistantUuid,
        isSidechain: true,
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'read-tool-1',
              content: 'ok',
              is_error: false,
            },
          ],
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:03:00.000Z',
        userType: 'external',
        cwd: '/tmp/test',
        sessionId: 'test-session',
      },
    ])

    const messages = await service.getSessionMessages(sessionId)

    expect(messages[1]).toMatchObject({
      type: 'tool_use',
      parentToolUseId: undefined,
    })
    expect(messages[2]).toMatchObject({
      type: 'tool_use',
      parentToolUseId: 'agent-tool-1',
    })
    expect(messages[3]).toMatchObject({
      type: 'tool_result',
      parentToolUseId: 'agent-tool-1',
    })
  })

  it('should recover workDir from session-meta entries', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry('/tmp/from-meta'),
      makeUserEntry('Hello'),
    ])

    const workDir = await service.getSessionWorkDir(sessionId)
    expect(workDir).toBe('/tmp/from-meta')
  })

  it('should recover workDir from the latest session-meta entry', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry('/tmp/old-worktree'),
      makeUserEntry('Hello'),
      makeSessionMetaEntry('/tmp/latest-worktree'),
    ])

    const workDir = await service.getSessionWorkDir(sessionId)
    expect(workDir).toBe('/tmp/latest-worktree')
  })

  it('should prefer the newest duplicate session file when worktree metadata moves', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const sourceFile = await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry('/tmp/project'),
    ])
    const worktreeFile = await writeSessionFile('-tmp-project--claude-worktrees-desktop-main-12345678', sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry('/tmp/project/.claude/worktrees/desktop-main-12345678'),
    ])

    const oldTime = new Date('2026-01-01T00:00:00.000Z')
    const newTime = new Date('2026-01-01T00:00:01.000Z')
    await fs.utimes(sourceFile, oldTime, oldTime)
    await fs.utimes(worktreeFile, newTime, newTime)

    const workDir = await service.getSessionWorkDir(sessionId)
    expect(workDir).toBe('/tmp/project/.claude/worktrees/desktop-main-12345678')
  })

  it('should recover CLI worktree state from transcript metadata', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project--claude-worktrees-desktop-main-12345678', sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry('/tmp/project/.claude/worktrees/desktop-main-12345678'),
      makeWorktreeStateEntry(sessionId, '/tmp/project/.claude/worktrees/desktop-main-12345678', {
        originalCwd: '/tmp/project',
      }),
      makeUserEntry('Hello from CLI worktree'),
    ])

    const launchInfo = await service.getSessionLaunchInfo(sessionId)
    expect(launchInfo?.worktreeSession).toMatchObject({
      originalCwd: '/tmp/project',
      worktreePath: '/tmp/project/.claude/worktrees/desktop-main-12345678',
      worktreeName: 'desktop-main-12345678',
      worktreeBranch: 'worktree-desktop-main-12345678',
      originalBranch: 'main',
    })
  })

  it('should preserve repository metadata when replacing placeholder transcripts', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const { sessionId, workDir: sessionWorkDir } = await service.createSession(
      workDir,
      { branch: 'feature/rail', worktree: true },
    )

    await service.clearSessionTranscript(sessionId, sessionWorkDir)
    const launchInfo = await service.getSessionLaunchInfo(sessionId)

    expect(launchInfo?.workDir).toBe(sessionWorkDir)
    expect(launchInfo?.repository).toMatchObject({
      requestedWorkDir: await fs.realpath(workDir),
      worktree: true,
      worktreePath: expect.stringContaining(path.join('.claude', 'worktrees', 'desktop-feature-rail-')),
    })
  })

  it('should preserve permission metadata when clearing placeholder transcripts', async () => {
    const workDir = path.join(tmpDir, 'clear-permission-workdir')
    await fs.mkdir(workDir, { recursive: true })
    const { sessionId } = await (service.createSession as unknown as (
      workDir?: string,
      repositoryOptions?: unknown,
      permissionMode?: string,
    ) => Promise<{ sessionId: string; workDir: string }>)(workDir, undefined, 'acceptEdits')

    await service.clearSessionTranscript(sessionId, workDir)
    const launchInfo = await service.getSessionLaunchInfo(sessionId)

    expect(launchInfo?.workDir).toBe(await fs.realpath(workDir))
    expect(launchInfo?.permissionMode).toBe('acceptEdits')
  })

  it('should persist session permission mode in launch metadata', async () => {
    const workDir = path.join(tmpDir, 'permission-workdir')
    await fs.mkdir(workDir, { recursive: true })
    const { sessionId } = await (service.createSession as unknown as (
      workDir?: string,
      repositoryOptions?: unknown,
      permissionMode?: string,
    ) => Promise<{ sessionId: string; workDir: string }>)(workDir, undefined, 'acceptEdits')

    let launchInfo = await service.getSessionLaunchInfo(sessionId)
    expect(launchInfo?.permissionMode).toBe('acceptEdits')

    await (service.appendSessionMetadata as unknown as (
      sessionId: string,
      metadata: { workDir: string; permissionMode?: string },
    ) => Promise<void>)(sessionId, {
      workDir,
      permissionMode: 'plan',
    })

    launchInfo = await service.getSessionLaunchInfo(sessionId)
    expect(launchInfo?.permissionMode).toBe('plan')
  })

  it('should round-trip auto through creation, list, metadata update, restore, and clear', async () => {
    const workDir = path.join(tmpDir, 'auto-permission-workdir')
    await fs.mkdir(workDir, { recursive: true })

    const { sessionId } = await service.createSession(workDir, undefined, 'auto')

    expect((await service.getSessionLaunchInfo(sessionId))?.permissionMode).toBe('auto')
    expect(
      (await service.listSessions()).sessions.find((session) => session.id === sessionId)
        ?.permissionMode,
    ).toBe('auto')

    await service.appendSessionMetadata(sessionId, {
      workDir,
      permissionMode: 'default',
    })
    await service.appendSessionMetadata(sessionId, {
      workDir,
      permissionMode: 'auto',
    })
    expect((await service.getSessionLaunchInfo(sessionId))?.permissionMode).toBe('auto')

    await service.clearSessionTranscript(sessionId, workDir, 'auto')
    expect((await service.getSessionLaunchInfo(sessionId))?.permissionMode).toBe('auto')
  })

  it('should expose the latest runtime selection in the session list', async () => {
    const workDir = '/tmp/runtime-list-metadata'
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile(sanitizePath(workDir), sessionId, [
      makeSnapshotEntry(),
      {
        ...makeSessionMetaEntry(workDir),
        runtimeProviderId: 'provider-latest',
        runtimeModelId: 'anthropic/claude-opus-4.7',
        effortLevel: 'max',
      },
      makeUserEntry('Use the latest runtime metadata'),
    ])

    const listed = (await service.listSessions()).sessions.find((session) => session.id === sessionId)

    expect(listed).toMatchObject({
      runtimeProviderId: 'provider-latest',
      runtimeModelId: 'anthropic/claude-opus-4.7',
      effortLevel: 'max',
    })
  })

  it('should not append duplicate runtime metadata when it already matches', async () => {
    const workDir = '/tmp/runtime-idempotent'
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const filePath = await writeSessionFile(sanitizePath(workDir), sessionId, [
      makeSnapshotEntry(),
      {
        ...makeSessionMetaEntry(workDir),
        runtimeProviderId: 'provider-a',
        runtimeModelId: 'model-a',
        effortLevel: 'max',
      },
      makeUserEntry('Runtime metadata should stay stable'),
    ])
    const before = await fs.readFile(filePath, 'utf-8')

    await service.appendSessionMetadata(sessionId, {
      workDir,
      runtimeProviderId: 'provider-a',
      runtimeModelId: 'model-a',
      effortLevel: 'max',
    })

    expect(await fs.readFile(filePath, 'utf-8')).toBe(before)

    await service.appendSessionMetadata(sessionId, {
      workDir,
      runtimeProviderId: 'provider-a',
      runtimeModelId: 'model-b',
      effortLevel: 'max',
    })

    const afterChange = await fs.readFile(filePath, 'utf-8')
    expect(afterChange).not.toBe(before)
    expect(afterChange).toContain('"runtimeModelId":"model-b"')
  })

  it('should remove stale placeholder files after native CLI worktree startup', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const sourceFile = await writeSessionFile('-tmp-source', sessionId, [
      makeSnapshotEntry(),
      { type: 'session-meta', isMeta: true, workDir: '/tmp/source', timestamp: '2026-01-01T00:00:00.000Z' },
      { type: 'session-meta', isMeta: true, workDir: '/tmp/source/.claude/worktrees/desktop-agent', timestamp: '2026-01-01T00:00:02.000Z' },
    ])
    const worktreeFile = await writeSessionFile('-tmp-source--claude-worktrees-desktop-agent', sessionId, [
      makeSnapshotEntry(),
      { type: 'session-meta', isMeta: true, workDir: '/tmp/source/.claude/worktrees/desktop-agent', timestamp: '2026-01-01T00:00:01.000Z' },
      makeUserEntry('Hello from worktree'),
    ])

    const removed = await service.deletePlaceholderSessionFiles(
      sessionId,
      '/tmp/source/.claude/worktrees/desktop-agent',
    )

    expect(removed).toBe(1)
    await expect(fs.access(sourceFile)).rejects.toThrow()
    await expect(fs.access(worktreeFile)).resolves.toBeNull()
  })

  it('should move repository metadata to the CLI worktree transcript before deleting placeholders', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const { sessionId } = await service.createSession(
      workDir,
      { branch: 'main', worktree: true },
    )
    const initialLaunchInfo = await service.getSessionLaunchInfo(sessionId)
    const worktreePath = initialLaunchInfo?.repository?.worktreePath
    expect(worktreePath).toBeTruthy()

    const worktreeFile = await writeSessionFile(sanitizePath(worktreePath!), sessionId, [
      makeSnapshotEntry(),
      {
        type: 'system',
        subtype: 'init',
        cwd: worktreePath,
        timestamp: '2026-01-01T00:00:01.000Z',
      },
      makeUserEntry('Hello from worktree'),
    ])

    await service.appendSessionMetadata(sessionId, {
      workDir: worktreePath!,
    })
    const removed = await service.deletePlaceholderSessionFiles(sessionId, worktreePath!)
    const launchInfo = await service.getSessionLaunchInfo(sessionId)

    expect(removed).toBe(1)
    await expect(fs.access(worktreeFile)).resolves.toBeNull()
    expect(launchInfo?.workDir).toBe(worktreePath)
    expect(launchInfo?.repository).toMatchObject({
      requestedWorkDir: await fs.realpath(workDir),
      branch: 'main',
      worktree: true,
      worktreePath,
      worktreeSlug: initialLaunchInfo?.repository?.worktreeSlug,
    })
  })

  it('should recover workDir from transcript cwd when session-meta is missing', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      {
        ...makeUserEntry('Hello'),
        cwd: '/tmp/from-cwd',
      },
    ])

    const workDir = await service.getSessionWorkDir(sessionId)
    expect(workDir).toBe('/tmp/from-cwd')
  })

  // --------------------------------------------------------------------------
  // createSession
  // --------------------------------------------------------------------------

  it('should create a new session file', async () => {
    const workDir = path.join(tmpDir, 'workspace', 'my-project')
    await fs.mkdir(workDir, { recursive: true })
    const { sessionId } = await service.createSession(workDir)
    expect(sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )

    // Verify the file was created
    const canonicalWorkDir = await fs.realpath(workDir)
    const sanitized = sanitizePath(canonicalWorkDir)
    const filePath = path.join(tmpDir, 'projects', sanitized, `${sessionId}.jsonl`)
    const stat = await fs.stat(filePath)
    expect(stat.isFile()).toBe(true)

    // Verify the file starts with the initial snapshot entry
    const content = await fs.readFile(filePath, 'utf-8')
    const entry = JSON.parse(content.trim().split('\n')[0]!)
    expect(entry.type).toBe('file-history-snapshot')
  })

  it('should defer isolated worktree creation until CLI startup', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const { sessionId, workDir: sessionWorkDir } = await service.createSession(
      workDir,
      { branch: 'feature/rail', worktree: true },
    )

    expect(sessionWorkDir).toBe(await fs.realpath(workDir))
    expect(git(workDir, 'branch', '--show-current')).toBe('main\n')
    expect(git(workDir, 'status', '--porcelain')).toBe('')

    const sanitized = sanitizePath(await fs.realpath(workDir))
    const filePath = path.join(tmpDir, 'projects', sanitized, `${sessionId}.jsonl`)
    const lines = (await fs.readFile(filePath, 'utf-8')).trim().split('\n')
    const metadata = JSON.parse(lines[1]!)
    const plannedWorktreePath = metadata.repository.worktreePath as string
    expect(metadata.workDir).toBe(await fs.realpath(workDir))
    expect(metadata.repository).toMatchObject({
      requestedWorkDir: await fs.realpath(workDir),
      branch: 'feature/rail',
      worktree: true,
      baseRef: 'feature/rail',
      worktreePath: expect.stringContaining(path.join('.claude', 'worktrees', 'desktop-feature-rail-')),
      worktreeBranch: expect.stringContaining('worktree-desktop-feature-rail-'),
      worktreeSlug: expect.stringContaining('desktop-feature-rail-'),
    })
    await expect(fs.access(plannedWorktreePath)).rejects.toThrow()

    const context = await getRepositoryContext(workDir)
    expect(context.state).toBe('ok')
    expect(context.branches.map((branch) => branch.name)).not.toContain(
      path.basename(plannedWorktreePath).replace(/^desktop-/, 'worktree-desktop-'),
    )
    expect(context.branches.some((branch) => branch.name.startsWith('worktree-desktop-'))).toBe(false)
  })

  it('should defer direct branch switching until CLI startup when worktree isolation is disabled', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const { sessionId, workDir: sessionWorkDir } = await service.createSession(
      workDir,
      { branch: 'feature/rail', worktree: false },
    )

    expect(sessionWorkDir).toBe(await fs.realpath(workDir))
    expect(git(workDir, 'branch', '--show-current')).toBe('main\n')

    const sanitized = sanitizePath(await fs.realpath(workDir))
    const filePath = path.join(tmpDir, 'projects', sanitized, `${sessionId}.jsonl`)
    const lines = (await fs.readFile(filePath, 'utf-8')).trim().split('\n')
    const metadata = JSON.parse(lines[1]!)
    expect(metadata.workDir).toBe(await fs.realpath(workDir))
    expect(metadata.repository).toMatchObject({
      requestedWorkDir: await fs.realpath(workDir),
      branch: 'feature/rail',
      worktree: false,
      baseRef: 'feature/rail',
    })
  })

  it('should not list hidden desktop worktree branches', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const existingWorktree = path.join(tmpDir, `desktop-hidden-${Date.now()}`)
    git(workDir, 'worktree', 'add', '-b', 'worktree-desktop-hidden', existingWorktree, 'feature/rail')

    expect(git(existingWorktree, 'branch', '--show-current')).toBe('worktree-desktop-hidden\n')

    const context = await getRepositoryContext(existingWorktree)
    expect(context.state).toBe('ok')
    expect(context.currentBranch).toBe('worktree-desktop-hidden')
    expect(context.branches.some((branch) => branch.name === context.currentBranch)).toBe(false)
    expect(context.branches.some((branch) => branch.name.startsWith('worktree-desktop-'))).toBe(false)
  })

  // --------------------------------------------------------------------------
  // createRepositoryBranch
  // --------------------------------------------------------------------------

  it('should create a branch at the selected base without moving HEAD', async () => {
    const workDir = await createCleanGitRepo(tmpDir)

    const result = await createRepositoryBranch(workDir, {
      name: 'feature/new-rail',
      from: 'feature/rail',
    })

    expect(result.branch).toBe('feature/new-rail')
    expect(result.baseRef).toBe('feature/rail')
    expect(git(workDir, 'rev-parse', 'feature/new-rail'))
      .toBe(git(workDir, 'rev-parse', 'feature/rail'))
    // Picking a branch in the launch controls has never checked it out on the
    // spot; the switch happens when the session starts, behind the dirty and
    // already-checked-out guards. Creating the ref must not jump that queue.
    expect(git(workDir, 'branch', '--show-current')).toBe('main\n')
    expect(result.context.branches.some((branch) => (
      branch.name === 'feature/new-rail' && branch.local && !branch.current
    ))).toBe(true)
  })

  it('should start a branch at HEAD when no base is given', async () => {
    const workDir = await createCleanGitRepo(tmpDir)

    const result = await createRepositoryBranch(workDir, { name: 'from-head' })

    expect(result.baseRef).toBe('HEAD')
    expect(git(workDir, 'rev-parse', 'from-head')).toBe(git(workDir, 'rev-parse', 'HEAD'))
  })

  it('should leave uncommitted work untouched when creating a branch', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    await fs.writeFile(path.join(workDir, 'README.md'), 'main\nwork in progress\n')

    await createRepositoryBranch(workDir, { name: 'wip', from: 'main' })

    expect(git(workDir, 'status', '--porcelain')).toBe(' M README.md\n')
    expect(await fs.readFile(path.join(workDir, 'README.md'), 'utf-8'))
      .toBe('main\nwork in progress\n')
  })

  it('should report the commit each branch points at alongside HEAD', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    await createRepositoryBranch(workDir, { name: 'same-commit', from: 'main' })

    const context = await getRepositoryContext(workDir)
    const head = git(workDir, 'rev-parse', 'HEAD').trim()

    // Without these the UI cannot tell a switch that rewrites files from one
    // that only moves the ref, and warns about uncommitted changes for both.
    expect(context.headCommit).toBe(head)
    expect(context.branches.find((branch) => branch.name === 'same-commit')?.commit).toBe(head)
    expect(context.branches.find((branch) => branch.name === 'feature/rail')?.commit)
      .toBe(git(workDir, 'rev-parse', 'feature/rail').trim())
  })

  it('should reject a branch name that already exists', async () => {
    const workDir = await createCleanGitRepo(tmpDir)

    await expect(createRepositoryBranch(workDir, { name: 'feature/rail' }))
      .rejects.toMatchObject({ code: 'REPOSITORY_BRANCH_EXISTS' })
  })

  it('should start a branch from a remote-only base at the remote commit', async () => {
    const originDir = await createCleanGitRepo(tmpDir)
    const workDir = path.join(tmpDir, `clone-${Date.now()}`)
    git(tmpDir, 'clone', '--quiet', originDir, workDir)
    git(workDir, 'config', 'user.email', 'clone@example.com')
    git(workDir, 'config', 'user.name', 'Clone')

    const result = await createRepositoryBranch(workDir, {
      name: 'local-rail',
      from: 'feature/rail',
    })

    // Resolving the base to its plain name instead of the tracking ref would
    // silently branch off HEAD, which is a different commit.
    expect(result.baseRef).toBe('origin/feature/rail')
    expect(git(workDir, 'rev-parse', 'local-rail'))
      .toBe(git(workDir, 'rev-parse', 'origin/feature/rail'))
    expect(git(workDir, 'rev-parse', 'local-rail'))
      .not.toBe(git(workDir, 'rev-parse', 'HEAD'))
  })

  it('should refuse to shadow a remote-only branch with a local one', async () => {
    const originDir = await createCleanGitRepo(tmpDir)
    const workDir = path.join(tmpDir, `shadow-${Date.now()}`)
    git(tmpDir, 'clone', '--quiet', originDir, workDir)

    // The picker lists `feature/rail` as a selectable remote branch, and picking
    // it launches `switch --track -c feature/rail origin/feature/rail`. Creating
    // a second local branch under that name off `main` wins the name and makes
    // the launch silently run on main's content instead.
    await expect(createRepositoryBranch(workDir, { name: 'feature/rail', from: 'main' }))
      .rejects.toMatchObject({ code: 'REPOSITORY_BRANCH_EXISTS' })
    expect(git(workDir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').trim())
      .toBe('main')
  })

  it('should not create a hidden desktop worktree branch', async () => {
    const workDir = await createCleanGitRepo(tmpDir)

    // `listBranches` filters this prefix out, so such a branch would exist on
    // disk and appear in no context the app ever renders — unselectable, and
    // undeletable from the app.
    await expect(createRepositoryBranch(workDir, { name: 'worktree-desktop-sneaky' }))
      .rejects.toMatchObject({ code: 'REPOSITORY_BRANCH_NAME_INVALID' })
    expect(git(workDir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').trim().split('\n'))
      .toEqual(['feature/rail', 'main'])
  })

  it('should reject a branch name past the length cap', async () => {
    const workDir = await createCleanGitRepo(tmpDir)

    await expect(createRepositoryBranch(workDir, { name: 'a'.repeat(201) }))
      .rejects.toMatchObject({ code: 'REPOSITORY_BRANCH_NAME_INVALID' })
    await expect(createRepositoryBranch(workDir, { name: 'a'.repeat(200) }))
      .resolves.toMatchObject({ branch: 'a'.repeat(200) })
  })

  it('should not let a flag-shaped base branch reach git as an option', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    // `git branch` refuses to create this, but a ref written out of band is
    // listed like any other and can be picked as the base.
    git(workDir, 'update-ref', 'refs/heads/-x', 'feature/rail')

    const context = await getRepositoryContext(workDir)
    expect(context.branches.some((branch) => branch.name === '-x')).toBe(true)

    const result = await createRepositoryBranch(workDir, { name: 'from-dash', from: '-x' })
    expect(result.baseRef).toBe('-x')
    expect(git(workDir, 'rev-parse', 'from-dash')).toBe(git(workDir, 'rev-parse', 'feature/rail'))
  })

  it('should map a case-folded collision onto the already-exists code', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const created = await createRepositoryBranch(workDir, { name: 'Main' })
      .then(() => 'created' as const, (error: { code?: string }) => error.code)

    // macOS and Windows fold the ref path, so git rejects this even though the
    // branch list has no exact match. Case-sensitive filesystems create it
    // happily, and both outcomes are correct — a raw English `fatal:` in a form
    // translated into five locales is not.
    expect(['created', 'REPOSITORY_BRANCH_EXISTS']).toContain(created)
  })

  it('should reject branch creation in a repository with no commits', async () => {
    const workDir = path.join(tmpDir, `unborn-${Date.now()}`)
    await fs.mkdir(workDir, { recursive: true })
    git(workDir, 'init')
    git(workDir, 'checkout', '-b', 'main')

    // The picker renders normally here — `state: 'ok'`, one branch from the
    // current-branch fallback — so "Create branch…" is offered and used to fail
    // with untranslated `fatal: not a valid object name`.
    const context = await getRepositoryContext(workDir)
    expect(context.state).toBe('ok')
    expect(context.headCommit).toBeNull()

    await expect(createRepositoryBranch(workDir, { name: 'first', from: 'main' }))
      .rejects.toMatchObject({ code: 'REPOSITORY_NO_COMMITS' })
  })

  it('should branch from the picked worktree HEAD, not the main checkout', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const linked = path.join(tmpDir, `linked-${Date.now()}`)
    git(workDir, 'worktree', 'add', linked, 'feature/rail')

    const context = await getRepositoryContext(linked)
    const result = await createRepositoryBranch(linked, { name: 'from-linked' })

    // `repoRoot` resolves a linked worktree back to the main checkout, where
    // HEAD is a different commit than the one `headCommit` just reported.
    expect(result.baseRef).toBe('HEAD')
    expect(git(linked, 'rev-parse', 'from-linked')).toBe(`${context.headCommit}\n`)
    expect(git(linked, 'rev-parse', 'from-linked'))
      .not.toBe(git(workDir, 'rev-parse', 'HEAD'))
  })

  it.each([
    ['a space', 'bad name'],
    ['a double dot', 'bad..name'],
    ['a trailing slash', 'bad/'],
    ['a lock suffix', 'bad.lock'],
    ['nothing at all', '   '],
  ])('should reject a branch name with %s', async (_label, name) => {
    const workDir = await createCleanGitRepo(tmpDir)

    await expect(createRepositoryBranch(workDir, { name }))
      .rejects.toMatchObject({ code: 'REPOSITORY_BRANCH_NAME_INVALID' })
    expect(git(workDir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').trim().split('\n'))
      .toEqual(['feature/rail', 'main'])
  })

  it('should not let a branch name starting with a dash reach git as a flag', async () => {
    const workDir = await createCleanGitRepo(tmpDir)

    // `-D` / `--delete` would be read as "delete a branch" by any call that
    // interpolates the name before `--`.
    await expect(createRepositoryBranch(workDir, { name: '--delete' }))
      .rejects.toMatchObject({ code: 'REPOSITORY_BRANCH_NAME_INVALID' })
    await expect(createRepositoryBranch(workDir, { name: '-D' }))
      .rejects.toMatchObject({ code: 'REPOSITORY_BRANCH_NAME_INVALID' })
    expect(git(workDir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').trim().split('\n'))
      .toEqual(['feature/rail', 'main'])
  })

  it('should reject a base branch the repository does not have', async () => {
    const workDir = await createCleanGitRepo(tmpDir)

    await expect(createRepositoryBranch(workDir, { name: 'ok-name', from: 'missing/branch' }))
      .rejects.toMatchObject({ code: 'REPOSITORY_BRANCH_NOT_FOUND' })
  })

  it('should reject branch creation outside a Git repository', async () => {
    const workDir = path.join(tmpDir, `not-git-branch-${Date.now()}`)
    await fs.mkdir(workDir, { recursive: true })

    await expect(createRepositoryBranch(workDir, { name: 'ok-name' }))
      .rejects.toMatchObject({ code: 'REPOSITORY_NOT_GIT' })
  })

  it('should keep stale worktree records when their paths cannot be resolved', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const staleWorktreeName = `stale-worktree-${Date.now()}`
    const staleWorktree = path.join(tmpDir, staleWorktreeName)
    git(workDir, 'worktree', 'add', '-b', 'stale-worktree', staleWorktree, 'feature/rail')
    await fs.rm(staleWorktree, { recursive: true, force: true })

    const context = await getRepositoryContext(workDir)
    const expectedPath = path.join(await fs.realpath(tmpDir), staleWorktreeName).normalize('NFC')
    expect(context.state).toBe('ok')
    expect(context.worktrees.some((worktree) => (
      worktree.path === expectedPath && worktree.branch === 'stale-worktree' && !worktree.current
    ))).toBe(true)
  })

  it('should let git carry compatible dirty changes during direct branch launch', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    await fs.writeFile(path.join(workDir, 'README.md'), 'main\nlocal-pricing-edit\n')

    const { sessionId } = await service.createSession(
      workDir,
      { branch: 'feature/rail', worktree: false },
    )

    expect(git(workDir, 'branch', '--show-current')).toBe('main\n')
    expect(await fs.readFile(path.join(workDir, 'README.md'), 'utf-8'))
      .toContain('local-pricing-edit')
    const prepared = await prepareSessionWorkspace(
      workDir,
      { branch: 'feature/rail', worktree: false },
      sessionId,
    )

    expect(prepared.workDir).toBe(await fs.realpath(workDir))
    expect(git(workDir, 'branch', '--show-current')).toBe('feature/rail\n')
    expect(await fs.readFile(path.join(workDir, 'README.md'), 'utf-8'))
      .toContain('local-pricing-edit')
  })

  it('should plan isolated worktrees from dirty source checkouts without switching branches', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    await fs.writeFile(path.join(workDir, 'README.md'), 'main\nlocal-pricing-edit\n')

    const { sessionId } = await service.createSession(
      workDir,
      { branch: 'feature/rail', worktree: true },
    )
    const launchInfo = await service.getSessionLaunchInfo(sessionId)

    expect(launchInfo?.repository).toMatchObject({
      branch: 'feature/rail',
      worktree: true,
      baseRef: 'feature/rail',
    })
    expect(git(workDir, 'branch', '--show-current')).toBe('main\n')
    expect(await fs.readFile(path.join(workDir, 'README.md'), 'utf-8'))
      .toContain('local-pricing-edit')
  })

  it('should defer checked-out direct branch launch validation until CLI startup', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const existingWorktree = path.join(tmpDir, `existing-feature-rail-${Date.now()}`)
    git(workDir, 'worktree', 'add', existingWorktree, 'feature/rail')

    const { sessionId } = await service.createSession(
      workDir,
      { branch: 'feature/rail', worktree: false },
    )

    expect(git(workDir, 'branch', '--show-current')).toBe('main\n')
    await expect(prepareSessionWorkspace(
      workDir,
      { branch: 'feature/rail', worktree: false },
      sessionId,
    )).rejects.toMatchObject({ code: 'REPOSITORY_BRANCH_CHECKED_OUT' })
  })

  it('should reject branch launch outside Git repositories with a stable error code', async () => {
    const workDir = path.join(tmpDir, `not-git-${Date.now()}`)
    await fs.mkdir(workDir, { recursive: true })

    await expect(service.createSession(
      workDir,
      { branch: 'main', worktree: false },
    )).rejects.toMatchObject({ code: 'REPOSITORY_NOT_GIT' })
  })

  it('should reject missing selected branches with a stable error code', async () => {
    const workDir = await createCleanGitRepo(tmpDir)

    await expect(service.createSession(
      workDir,
      { branch: 'missing/branch', worktree: true },
    )).rejects.toMatchObject({ code: 'REPOSITORY_BRANCH_NOT_FOUND' })
  })

  it('should create a Windows-safe project directory name', async () => {
    if (process.platform !== 'win32') return

    const workDir = process.cwd()
    const { sessionId } = await service.createSession(workDir)
    const sanitized = sanitizePath(workDir)
    const projectDir = path.join(tmpDir, 'projects', sanitized)

    expect(sanitized.includes(':')).toBe(false)
    const stat = await fs.stat(path.join(projectDir, `${sessionId}.jsonl`))
    expect(stat.isFile()).toBe(true)
  })

  it('should default to the user home directory when workDir is missing', async () => {
    const { sessionId, workDir } = await service.createSession('')
    expect(workDir).toBe(await fs.realpath(os.homedir()))
    const filePath = path.join(
      tmpDir,
      'projects',
      sanitizePath(workDir),
      `${sessionId}.jsonl`,
    )

    const stat = await fs.stat(filePath)
    expect(stat.isFile()).toBe(true)
  })

  it('should throw when workDir does not exist', async () => {
    expect(service.createSession('/tmp/definitely-missing-claude-code-haha')).rejects.toThrow(
      'Working directory does not exist'
    )
  })

  // --------------------------------------------------------------------------
  // deleteSession
  // --------------------------------------------------------------------------

  it('should delete an existing session', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const filePath = await writeSessionFile('-tmp-project', sessionId, [makeSnapshotEntry()])

    await service.deleteSession(sessionId)

    // File should no longer exist
    expect(fs.access(filePath)).rejects.toThrow()
  })

  it('should throw when deleting non-existent session', async () => {
    expect(
      service.deleteSession('00000000-0000-0000-0000-000000000000')
    ).rejects.toThrow('Session not found')
  })

  // --------------------------------------------------------------------------
  // renameSession
  // --------------------------------------------------------------------------

  it('should rename a session by appending custom-title entry', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const filePath = await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Original message'),
    ])

    await service.renameSession(sessionId, 'My Custom Title')

    // Read the file and check the last entry
    const content = await fs.readFile(filePath, 'utf-8')
    const lines = content.trim().split('\n')
    const lastEntry = JSON.parse(lines[lines.length - 1]!)
    expect(lastEntry.type).toBe('custom-title')
    expect(lastEntry.customTitle).toBe('My Custom Title')

    // Verify the title is now returned in list
    const detail = await service.getSession(sessionId)
    expect(detail!.title).toBe('My Custom Title')
  })

  it('should throw when renaming non-existent session', async () => {
    expect(
      service.renameSession('00000000-0000-0000-0000-000000000000', 'Title')
    ).rejects.toThrow('Session not found')
  })

  // --------------------------------------------------------------------------
  // Title extraction
  // --------------------------------------------------------------------------

  it('should use first user message as title when no custom title', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeMetaUserEntry(),
      makeUserEntry('This is my first real question'),
    ])

    const detail = await service.getSession(sessionId)
    expect(detail!.title).toBe('This is my first real question')
  })

  it('should derive a clean title from slash command breadcrumb metadata', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry([
        '<command-message>frontend-design</command-message>',
        '<command-name>/frontend-design</command-name>',
        '<command-args>@website 重新设计首页</command-args>',
      ].join('\n')),
    ])

    const detail = await service.getSession(sessionId)
    expect(detail!.title).toBe('/frontend-design @website 重新设计首页')
  })

  it('should keep a goal creation title instead of later goal status titles', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      {
        parentUuid: null,
        isSidechain: false,
        type: 'system',
        subtype: 'local_command',
        content: '<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>ship the actual objective</command-args>',
        level: 'info',
        timestamp: '2026-01-01T00:00:01.000Z',
        uuid: 'goal-command',
      },
      {
        type: 'ai-title',
        aiTitle: '/goal status',
        timestamp: '2026-01-01T00:02:00.000Z',
      },
    ])

    const detail = await service.getSession(sessionId)
    expect(detail!.title).toBe('/goal ship the actual objective')
  })

  it('should display stored AI titles without internal XML tags', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('fallback message'),
      {
        type: 'ai-title',
        aiTitle: [
          '<command-message>frontend-design</command-message>',
          '<command-name>/frontend-design</command-name>',
          '<command-args>@website</command-args>',
        ].join(' '),
        timestamp: '2026-01-01T00:02:00.000Z',
      },
    ])

    const detail = await service.getSession(sessionId)
    expect(detail!.title).toBe('/frontend-design @website')
  })

  it('should truncate long titles to 80 chars', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const longMessage = 'A'.repeat(120)
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry(longMessage),
    ])

    const detail = await service.getSession(sessionId)
    expect(detail!.title.length).toBe(83) // 80 + '...'
    expect(detail!.title.endsWith('...')).toBe(true)
  })

  it('should fall back to "Untitled Session" when no user message', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [makeSnapshotEntry()])

    const detail = await service.getSession(sessionId)
    expect(detail!.title).toBe('Untitled Session')
  })

  it('should detect placeholder launch info for desktop-created sessions', async () => {
    const workDir = await fs.realpath(os.tmpdir())
    const { sessionId } = await service.createSession(workDir)

    const launchInfo = await service.getSessionLaunchInfo(sessionId)
    expect(launchInfo).not.toBeNull()
    expect(launchInfo!.workDir).toBe(workDir)
    expect(launchInfo!.transcriptMessageCount).toBe(0)
    expect(launchInfo!.customTitle).toBeNull()
  })

  it('should detect resumable launch info for transcript sessions', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const userUuid = crypto.randomUUID()
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      { type: 'session-meta', isMeta: true, workDir: '/tmp/project', timestamp: '2026-01-01T00:00:00.000Z' },
      makeUserEntry('Hello again', userUuid),
      makeAssistantEntry('Welcome back', userUuid),
      { type: 'custom-title', customTitle: 'Saved chat', timestamp: '2026-01-01T00:03:00.000Z' },
    ])

    const launchInfo = await service.getSessionLaunchInfo(sessionId)
    expect(launchInfo).not.toBeNull()
    expect(launchInfo!.workDir).toBe('/tmp/project')
    expect(launchInfo!.transcriptMessageCount).toBe(2)
    expect(launchInfo!.customTitle).toBe('Saved chat')
  })

  it('should recover Windows drive paths from sanitized project dirs for old transcripts without metadata', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff'
    const userUuid = crypto.randomUUID()
    const userEntry = makeUserEntry('Resume this Windows session', userUuid)
    delete userEntry.cwd
    await writeSessionFile('g--AI-NTos-NT-deepseek-nano-core', sessionId, [
      makeSnapshotEntry(),
      userEntry,
      makeAssistantEntry('Welcome back', userUuid),
    ])

    const expectedWorkDir = 'g:\\AI\\NTos\\NT\\deepseek\\nano\\core'
    expect(await service.getSessionWorkDir(sessionId)).toBe(expectedWorkDir)

    const launchInfo = await service.getSessionLaunchInfo(sessionId)
    expect(launchInfo).not.toBeNull()
    expect(launchInfo!.workDir).toBe(expectedWorkDir)
    expect(launchInfo!.transcriptMessageCount).toBe(2)
  })

  it('createSessionBranch should preserve branch metadata, copied snapshots, and filtered replacements', async () => {
    const sessionId = 'branch-source-session'
    const workDir = path.join(tmpDir, 'branch-source')
    const worktreePath = path.join(workDir, '.claude', 'worktrees', 'desktop-main-12345678')
    const firstUserId = crypto.randomUUID()
    const firstAssistantId = crypto.randomUUID()
    const firstToolResultId = crypto.randomUUID()
    const laterUserId = crypto.randomUUID()
    const laterAssistantId = crypto.randomUUID()
    const repository = {
      branch: 'feature/rail',
      worktree: true,
      baseRef: 'feature/rail',
      repoRoot: workDir,
    }
    const sourceProjectDir = sanitizePath(workDir)
    const sourcePath = await writeSessionFile(sourceProjectDir, sessionId, [
      makeSessionMetaEntry(workDir),
      {
        type: 'session-meta',
        isMeta: true,
        workDir,
        repository,
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      makeWorktreeStateEntry(sessionId, worktreePath, {
        originalCwd: workDir,
      }),
      makeFileHistorySnapshotEntry(firstUserId, {
        'src/step.js': {
          backupFileName: 'branch-source-step@v1',
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('branch this conversation', firstUserId),
        cwd: workDir,
        sessionId,
      },
      {
        ...makeAssistantToolUseEntry([
          { id: 'tool-1', name: 'Read', input: { path: 'src/step.js' } },
        ], firstUserId),
        uuid: firstAssistantId,
        cwd: workDir,
        sessionId,
      },
      {
        ...makeToolResultUserEntry('tool-1', 'first tool result', firstToolResultId, firstAssistantId, sessionId),
        cwd: workDir,
      },
      makeContentReplacementEntry(sessionId, [
        { kind: 'tool-result', toolUseId: 'tool-1', replacement: 'preview-1' },
        { kind: 'tool-result', toolUseId: 'tool-2', replacement: 'preview-2' },
      ]),
      makeFileHistorySnapshotEntry(laterUserId, {
        'src/step.js': {
          backupFileName: 'branch-source-step@v2',
          version: 2,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('later prompt', laterUserId),
        parentUuid: firstToolResultId,
        cwd: workDir,
        sessionId,
      },
      {
        ...makeAssistantEntry('later reply', laterUserId),
        uuid: laterAssistantId,
        cwd: workDir,
        sessionId,
      },
    ])

    const sourceBefore = await fs.readFile(sourcePath, 'utf-8')

    const branch = await createSessionBranch({
      sourceSessionId: sessionId,
      sourceTranscriptPath: sourcePath,
      targetMessageId: firstToolResultId,
      title: 'Desktop branch',
      sourceWorkDir: workDir,
      sourceRepository: repository,
      sourceWorktreeSession: {
        originalCwd: workDir,
        worktreePath,
        worktreeName: 'desktop-main-12345678',
        worktreeBranch: 'worktree-desktop-main-12345678',
        originalBranch: 'main',
        sessionId,
      },
    })

    const branchMessages = await service.getSessionMessages(branch.sessionId)
    expect(branchMessages.map((message) => message.id)).toEqual([
      firstUserId,
      firstAssistantId,
      firstToolResultId,
    ])
    expect(branch.title).toBe('Desktop branch (Branch)')

    const launchInfo = await service.getSessionLaunchInfo(branch.sessionId)
    expect(launchInfo).toMatchObject({
      workDir,
      repository,
      worktreeSession: {
        originalCwd: workDir,
        worktreePath,
      },
    })

    const branchEntries = parseJSONL<Record<string, unknown>>(await fs.readFile(branch.forkPath))
    expect(branchEntries.some((entry) => (
      entry.type === 'content-replacement' &&
      entry.sessionId === branch.sessionId &&
      Array.isArray(entry.replacements) &&
      entry.replacements.length === 1 &&
      (entry.replacements[0] as { toolUseId?: string }).toolUseId === 'tool-1'
    ))).toBe(true)
    expect(branchEntries.some((entry) => (
      entry.type === 'file-history-snapshot' &&
      typeof (entry.snapshot as { messageId?: string } | undefined)?.messageId === 'string' &&
      (entry.snapshot as { messageId?: string }).messageId === firstUserId
    ))).toBe(true)
    expect(branchEntries.some((entry) => (
      entry.type === 'file-history-snapshot' &&
      typeof (entry.snapshot as { messageId?: string } | undefined)?.messageId === 'string' &&
      (entry.snapshot as { messageId?: string }).messageId === laterUserId
    ))).toBe(false)
    expect(branchEntries.some((entry) => (
      entry.type === 'custom-title' &&
      entry.customTitle === 'Desktop branch (Branch)'
    ))).toBe(true)
    expect(branchEntries.filter((entry) => (
      entry.type === 'user' ||
      entry.type === 'assistant'
    )).every((entry) => (
      entry.sessionId === branch.sessionId &&
      typeof (entry.forkedFrom as { sessionId?: string } | undefined)?.sessionId === 'string'
    ))).toBe(true)

    const sourceAfter = await fs.readFile(sourcePath, 'utf-8')
    expect(sourceAfter).toBe(sourceBefore)
  })

  it('createSessionBranch should not expose inherited token usage as usage generated by the fork', async () => {
    const sessionId = 'branch-token-source'
    const workDir = path.join(tmpDir, 'branch-token-source')
    const sourceUserId = crypto.randomUUID()
    const sourceAssistantId = crypto.randomUUID()
    const sourceAssistant = {
      ...makeAssistantEntry(
        'source reply',
        sourceUserId,
        { input_tokens: 1200, output_tokens: 80 },
      ),
      uuid: sourceAssistantId,
      sessionId,
    }
    const sourcePath = await writeSessionFile(sanitizePath(workDir), sessionId, [
      {
        ...makeUserEntry('branch this conversation', sourceUserId),
        sessionId,
      },
      sourceAssistant,
    ])

    const branch = await createSessionBranch({
      sourceSessionId: sessionId,
      sourceTranscriptPath: sourcePath,
      targetMessageId: sourceAssistantId,
      sourceWorkDir: workDir,
    })

    const inheritedMessages = await service.getSessionMessages(branch.sessionId)
    expect(inheritedMessages.find((message) => message.id === sourceAssistantId)?.usage)
      .toBeUndefined()
    expect(await service.getTranscriptUsage(branch.sessionId)).toBeNull()
    const inheritedSnapshot = await service.getInspectionTranscriptSnapshot(branch.sessionId)
    expect(inheritedSnapshot?.usage).toBeNull()
    expect(inheritedSnapshot?.contextEstimate?.totalTokens).toBe(1280)
    expect(inheritedSnapshot?.contextEstimate?.apiUsage).toEqual({
      input_tokens: 1200,
      output_tokens: 80,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })

    const forkUserId = crypto.randomUUID()
    const forkAssistantId = crypto.randomUUID()
    await fs.appendFile(branch.forkPath, [
      JSON.stringify({
        ...makeUserEntry('continue in the fork', forkUserId),
        parentUuid: sourceAssistantId,
        sessionId: branch.sessionId,
      }),
      JSON.stringify({
        ...makeAssistantEntry(
          'fork reply',
          forkUserId,
          { input_tokens: 50, output_tokens: 5 },
        ),
        uuid: forkAssistantId,
        sessionId: branch.sessionId,
      }),
    ].join('\n') + '\n')

    const updatedMessages = await service.getSessionMessages(branch.sessionId)
    expect(updatedMessages.find((message) => message.id === forkAssistantId)?.usage).toEqual({
      input_tokens: 50,
      output_tokens: 5,
    })
    expect(await service.getTranscriptUsage(branch.sessionId)).toMatchObject({
      totalInputTokens: 50,
      totalOutputTokens: 5,
    })
    expect((await service.getInspectionTranscriptSnapshot(branch.sessionId))?.usage)
      .toMatchObject({
        totalInputTokens: 50,
        totalOutputTokens: 5,
      })
  })
})

// ============================================================================
// Sessions API integration tests
// ============================================================================

describe('Sessions API', () => {
  let baseUrl: string
  let server: ReturnType<typeof Bun.serve> | null = null

  beforeEach(async () => {
    await setupTmpConfigDir()
    service = new SessionService()

    // Import and start a minimal test server
    const { handleSessionsApi } = await import('../api/sessions.js')
    const { handleConversationsApi } = await import('../api/conversations.js')

    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',

      async fetch(req) {
        const url = new URL(req.url)
        const segments = url.pathname.split('/').filter(Boolean)

        if (segments[0] === 'api' && segments[1] === 'sessions') {
          // Route chat sub-resource to conversations handler
          if (segments[3] === 'chat') {
            return handleConversationsApi(req, url, segments)
          }
          return handleSessionsApi(req, url, segments)
        }

        return new Response('Not Found', { status: 404 })
      },
    })
    baseUrl = `http://127.0.0.1:${server.port}`
  })

  afterEach(async () => {
    if (server) {
      server.stop(true)
      server = null
    }
    clearInstalledPluginsCache()
    clearPluginCache('sessions-api-test-teardown')
    resetSettingsCache()
    await cleanupTmpDir()
  })

  it('GET /api/sessions should return empty list', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      sessions: unknown[]
      total: number
      index?: { mode: string; state: string; lastErrorCode: string | null }
    }
    expect(body.sessions).toEqual([])
    expect(body.total).toBe(0)
    expect(body.index).toMatchObject({
      mode: expect.any(String),
      state: expect.any(String),
    })
    expect(body.index?.lastErrorCode === null || typeof body.index?.lastErrorCode === 'string').toBe(true)
  })

  it('POST /api/sessions should create a session', async () => {
    const workDir = await fs.mkdtemp(path.join(tmpDir, 'api-session-'))
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir }),
    })
    expect(res.status).toBe(201)

    const body = (await res.json()) as { sessionId: string }
    expect(body.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
  })

  it('POST /api/sessions should create a session when workDir is omitted', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(201)

    const body = (await res.json()) as { sessionId: string }
    expect(body.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
  })

  it('POST /api/sessions should reject an unknown permission mode', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissionMode: 'unknown' }),
    })

    expect(res.status).toBe(400)
  })

  it('GET /api/sessions/:id/inspection should report persisted permission mode for inactive sessions', async () => {
    const workDir = await fs.mkdtemp(path.join(tmpDir, 'api-session-permission-'))
    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir, permissionMode: 'bypassPermissions' }),
    })
    expect(createRes.status).toBe(201)

    const { sessionId } = (await createRes.json()) as { sessionId: string }
    const inspectionRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/inspection?includeContext=0`)
    expect(inspectionRes.status).toBe(200)

    const inspection = (await inspectionRes.json()) as {
      active: boolean
      status: { permissionMode?: string }
    }
    expect(inspection.active).toBe(false)
    expect(inspection.status.permissionMode).toBe('bypassPermissions')
  })

  it('GET /api/sessions/repository-context should return branch launch metadata', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const res = await fetch(
      `${baseUrl}/api/sessions/repository-context?workDir=${encodeURIComponent(workDir)}`,
    )
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      state: string
      repoName: string
      currentBranch: string
      branches: Array<{ name: string; current: boolean; local: boolean }>
      worktrees: Array<{ path: string; branch: string | null; current: boolean }>
    }
    expect(body.state).toBe('ok')
    expect(body.repoName).toBe(path.basename(workDir))
    expect(body.currentBranch).toBe('main')
    expect(body.branches.some((branch) => branch.name === 'main' && branch.current)).toBe(true)
    expect(body.branches.some((branch) => branch.name === 'feature/rail' && branch.local)).toBe(true)
    const realWorkDir = await fs.realpath(workDir)
    expect(body.worktrees.some((worktree) => worktree.path === realWorkDir && worktree.current)).toBe(true)
  })

  it('POST /api/sessions/repository-branch should create a branch and return the refreshed context', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const res = await fetch(`${baseUrl}/api/sessions/repository-branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir, name: 'feature/from-api', from: 'feature/rail' }),
    })
    expect(res.status).toBe(201)

    const body = (await res.json()) as {
      branch: string
      baseRef: string
      context: { state: string; branches: Array<{ name: string; local: boolean }> }
    }
    expect(body.branch).toBe('feature/from-api')
    expect(body.baseRef).toBe('feature/rail')
    expect(body.context.state).toBe('ok')
    expect(body.context.branches.some((branch) => (
      branch.name === 'feature/from-api' && branch.local
    ))).toBe(true)
    expect(git(workDir, 'branch', '--show-current')).toBe('main\n')
  })

  it('POST /api/sessions/repository-branch should surface a rejected name as a stable error code', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const res = await fetch(`${baseUrl}/api/sessions/repository-branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir, name: 'feature/rail' }),
    })
    expect(res.status).toBe(400)
    // The desktop form translates this code; a changed spelling silently
    // downgrades it to the untranslated generic failure.
    expect((await res.json()).error).toBe('REPOSITORY_BRANCH_EXISTS')
  })

  it('GET /api/sessions/recent-projects should keep pending repository launches on the source project', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workDir,
        repository: { branch: 'feature/rail', worktree: true },
      }),
    })
    expect(createRes.status).toBe(201)

    const created = (await createRes.json()) as { workDir: string }
    const recentRes = await fetch(`${baseUrl}/api/sessions/recent-projects?limit=20`)
    expect(recentRes.status).toBe(200)

    const body = (await recentRes.json()) as {
      projects: Array<{ realPath: string; projectName: string; branch: string | null }>
    }
    const project = body.projects.find((candidate) => candidate.realPath === created.workDir)
    expect(project).toBeDefined()
    expect(project?.projectName).toBe(path.basename(workDir))
    expect(project?.branch).toBe('main')
    expect(project?.realPath).toBe(await fs.realpath(workDir))
  })

  it('GET /api/sessions/recent-projects should retain source projects for cleaned worktrees', async () => {
    const sourceWorkDir = await createCleanGitRepo(tmpDir)
    const worktreePath = path.join(sourceWorkDir, '.claude', 'worktrees', 'desktop-main-87654321')
    const sessionId = 'c1000000-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile(sanitizePath(worktreePath), sessionId, [
      makeSessionMetaEntry(worktreePath),
      makeWorktreeStateEntry(sessionId, worktreePath, {
        originalCwd: sourceWorkDir,
      }),
      makeUserEntry('Cleaned worktree history'),
    ])

    const recentRes = await fetch(`${baseUrl}/api/sessions/recent-projects?limit=20`)
    expect(recentRes.status).toBe(200)

    const body = (await recentRes.json()) as {
      projects: Array<{ realPath: string; sessionCount: number }>
    }
    expect(body.projects).toContainEqual(expect.objectContaining({
      realPath: await fs.realpath(sourceWorkDir),
      sessionCount: 1,
    }))
  })

  it('GET /api/sessions/recent-projects should isolate cached projects by config scope', async () => {
    const firstConfigDir = path.join(tmpDir, 'recent-project-scopes', 'first')
    const secondConfigDir = path.join(tmpDir, 'recent-project-scopes', 'second')
    const firstWorkDir = path.join(tmpDir, 'recent-project-workspaces', 'first')
    const secondWorkDir = path.join(tmpDir, 'recent-project-workspaces', 'second')
    const firstSessionId = 'a1000000-bbbb-cccc-dddd-eeeeeeeeeeee'
    const secondSessionId = 'a1000001-bbbb-cccc-dddd-eeeeeeeeeeee'
    const seedScope = async (
      configDir: string,
      sessionId: string,
      workDir: string,
      title: string,
    ) => {
      const projectDir = path.join(configDir, 'projects', '-tmp-recent-scope')
      await fs.mkdir(projectDir, { recursive: true })
      await fs.mkdir(workDir, { recursive: true })
      await fs.writeFile(
        path.join(projectDir, `${sessionId}.jsonl`),
        `${JSON.stringify({
          ...makeUserEntry(title),
          cwd: workDir,
          sessionId,
        })}\n`,
        'utf8',
      )
    }
    await seedScope(firstConfigDir, firstSessionId, firstWorkDir, 'First recent scope')
    await seedScope(secondConfigDir, secondSessionId, secondWorkDir, 'Second recent scope')
    const firstRealWorkDir = await fs.realpath(firstWorkDir)
    const secondRealWorkDir = await fs.realpath(secondWorkDir)

    process.env.CLAUDE_CONFIG_DIR = firstConfigDir
    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: firstWorkDir }),
    })
    expect(createRes.status).toBe(201)
    const firstRecentRes = await fetch(`${baseUrl}/api/sessions/recent-projects?limit=20`)
    expect(firstRecentRes.status).toBe(200)
    const firstRecent = await firstRecentRes.json() as {
      projects: Array<{ realPath: string }>
    }

    process.env.CLAUDE_CONFIG_DIR = secondConfigDir
    const secondRecentRes = await fetch(`${baseUrl}/api/sessions/recent-projects?limit=20`)
    expect(secondRecentRes.status).toBe(200)
    const secondRecent = await secondRecentRes.json() as {
      projects: Array<{ realPath: string }>
    }

    expect(firstRecent.projects.some(project => project.realPath === firstRealWorkDir)).toBe(true)
    expect(secondRecent.projects.some(project => project.realPath === secondRealWorkDir)).toBe(true)
    expect(secondRecent.projects.some(project => project.realPath === firstRealWorkDir)).toBe(false)
  })

  it('GET /api/sessions/:id should return session detail', async () => {
    // Create a session file
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-api-test', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('API test message'),
      makeAssistantEntry('API test response'),
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { id: string; title: string; messages: unknown[] }
    expect(body.id).toBe(sessionId)
    expect(body.title).toBe('API test message')
    expect(body.messages).toHaveLength(2)
  })

  it('GET /api/sessions/:id should 404 for unknown session', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/00000000-0000-0000-0000-000000000000`)
    expect(res.status).toBe(404)
  })

  it('GET /api/sessions/:id/messages should return messages', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-api-test', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Hello'),
      makeAssistantEntry('World', undefined, { input_tokens: 1234, output_tokens: 56 }),
      makeUserEntry(
        '<task-notification>\n<task-id>bg-1</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>failed</status>\n<summary>Background command failed &amp; stopped</summary>\n<result>Stack trace &amp; failed assertion</result>\n<output-file>C:\\Temp\\bg.output</output-file>\n</task-notification>',
        crypto.randomUUID(),
      ),
      makeAssistantEntry('internal task response'),
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      messages: unknown[]
      taskNotifications: unknown[]
    }
    expect(body.messages).toHaveLength(2)
    expect(body.messages[1]).toMatchObject({
      type: 'assistant',
      usage: { input_tokens: 1234, output_tokens: 56 },
    })
    expect(JSON.stringify(body.messages)).not.toContain('<task-notification>')
    expect(body.taskNotifications).toEqual([
      {
        taskId: 'bg-1',
        toolUseId: 'toolu_bg',
        status: 'failed',
        summary: 'Background command failed & stopped',
        result: 'Stack trace & failed assertion',
        outputFile: 'C:\\Temp\\bg.output',
        timestamp: expect.any(String),
      },
    ])
  })

  it('GET /api/sessions/:id/messages exposes persisted terminal ownership', async () => {
    const sessionId = 'abababab-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-api-owned-terminal', sessionId, [
      makeSnapshotEntry(),
      {
        type: 'cc-haha-task-notification',
        isMeta: true,
        taskNotification: {
          taskId: 'nested-workflow-task',
          toolUseId: 'Workflow:0',
          ownerAgentId: 'parent-agent',
          status: 'completed',
          summary: 'Nested workflow completed',
        },
        timestamp: '2026-08-10T00:00:01.000Z',
      },
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`)
    expect(res.status).toBe(200)
    const body = await res.json() as { taskNotifications: unknown[] }
    expect(body.taskNotifications).toEqual([{
      taskId: 'nested-workflow-task',
      toolUseId: 'Workflow:0',
      ownerAgentId: 'parent-agent',
      status: 'completed',
      summary: 'Nested workflow completed',
      timestamp: '2026-08-10T00:00:01.000Z',
    }])
  })

  it('GET /api/sessions/:id/subagents/by-tool/:toolUseId should return a resolved run', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-api-subagent-run'
    const agentId = 'abc123'
    await writeSessionFile(projectDir, sessionId, [
      makeSnapshotEntry(),
      makeAssistantToolUseEntry([
        {
          id: 'tool-1',
          name: 'Agent',
          input: { description: 'Inspect server seam', prompt: 'Read session routes' },
        },
      ]),
      makeToolResultUserEntry('tool-1', `server summary\nagentId: ${agentId}`),
    ])
    await writeSubagentTranscriptFile(projectDir, sessionId, agentId, [
      {
        type: 'user',
        message: { role: 'user', content: 'Read session routes' },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:04.000Z',
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Found sessions.ts' }] },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:05.000Z',
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: '<task-notification>\n<task-id>child-shell-task</task-id>\n<tool-use-id>child-shell.call</tool-use-id>\n<status>killed</status>\n<summary>Child shell stopped</summary>\n</task-notification>',
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:06.000Z',
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: 'Internal notification response' },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:07.000Z',
      },
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/subagents/by-tool/tool-1`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      sessionId: string
      toolUseId: string
      agentId: string | null
      description?: string
      prompt?: string
      messages: unknown[]
      taskNotifications: unknown[]
      source: string
    }
    expect(body).toMatchObject({
      sessionId,
      toolUseId: 'tool-1',
      agentId,
      description: 'Inspect server seam',
      prompt: 'Read session routes',
      source: 'subagent-jsonl',
    })
    expect(body.messages).toHaveLength(2)
    expect(JSON.stringify(body.messages)).not.toContain('<task-notification>')
    expect(JSON.stringify(body.messages)).not.toContain('Internal notification response')
    expect(body.taskNotifications).toEqual([{
      taskId: 'child-shell-task',
      toolUseId: 'child-shell.call',
      status: 'stopped',
      summary: 'Child shell stopped',
      timestamp: '2026-01-01T00:00:06.000Z',
    }])
  })

  it('GET /api/sessions/:id/subagents/by-tool/:toolUseId should use a live task id while running', async () => {
    const sessionId = 'edededed-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-api-live-subagent-run'
    const agentId = 'abc123'
    await writeSessionFile(projectDir, sessionId, [
      makeSnapshotEntry(),
      makeAssistantToolUseEntry([{
        id: 'tool-1',
        name: 'Agent',
        input: { description: 'Inspect live seam', prompt: 'Read the route' },
      }]),
    ])
    await writeSubagentTranscriptFile(projectDir, sessionId, agentId, [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'child-tool-1', name: 'Read', input: {} }],
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:04.000Z',
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'child-tool-1', content: 'route source' }],
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:05.000Z',
      },
    ])

    const res = await fetch(
      `${baseUrl}/api/sessions/${sessionId}/subagents/by-tool/tool-1?taskId=${agentId}`,
    )
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      agentId: string | null
      taskId?: string
      status: string
      messages: unknown[]
      source: string
    }
    expect(body).toMatchObject({
      agentId,
      taskId: agentId,
      status: 'running',
      source: 'subagent-jsonl',
    })
    expect(body.messages).toHaveLength(2)
  })

  it('POST /api/sessions/:id/subagents/by-tool/:toolUseId/messages should resume the resolved agent', async () => {
    const sessionId = 'fefefefe-bbbb-cccc-dddd-eeeeeeeeeeee'
    const agentId = 'resumable-agent-1'
    await writeSessionFile('-tmp-api-subagent-message', sessionId, [
      makeSnapshotEntry(),
      makeAssistantToolUseEntry([{
        id: 'tool-1',
        name: 'Agent',
        input: { description: 'Review the route', prompt: 'Inspect the server API' },
      }]),
      makeToolResultUserEntry('tool-1', `review complete\nagentId: ${agentId}`),
    ])
    const requestControl = spyOn(conversationService, 'requestControl').mockResolvedValue({
      agent_id: agentId,
      delivery: 'resumed',
    })
    const hasSession = spyOn(conversationService, 'hasSession').mockReturnValue(false)
    const startSession = spyOn(conversationService, 'startSession').mockResolvedValue()

    try {
      const res = await fetch(
        `${baseUrl}/api/sessions/${sessionId}/subagents/by-tool/tool-1/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: 'Please review the new patch.' }),
        },
      )

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        ok: true,
        agent_id: agentId,
        delivery: 'resumed',
      })
      expect(requestControl).toHaveBeenCalledWith(sessionId, {
        subtype: 'send_agent_message',
        agent_id: agentId,
        content: 'Please review the new patch.',
      })
      expect(startSession).toHaveBeenCalledWith(
        sessionId,
        expect.any(String),
        expect.stringMatching(new RegExp(
          `^ws://127\\.0\\.0\\.1:${new URL(baseUrl).port}/sdk/${sessionId}\\?token=`,
        )),
        expect.objectContaining({ resumeInterruptedTurn: false }),
      )
    } finally {
      startSession.mockRestore()
      hasSession.mockRestore()
      requestControl.mockRestore()
    }
  })

  it('POST /api/sessions/:id/subagents/by-tool/:toolUseId/messages should reuse a running parent CLI', async () => {
    const sessionId = 'abababab-bbbb-cccc-dddd-eeeeeeeeeeee'
    const agentId = 'running-parent-agent'
    await writeSessionFile('-tmp-api-running-parent-subagent-message', sessionId, [
      makeSnapshotEntry(),
      makeAssistantToolUseEntry([{
        id: 'tool-running',
        name: 'Agent',
        input: { description: 'Continue the agent', prompt: 'Stay available' },
      }]),
      makeToolResultUserEntry('tool-running', `ready\nagentId: ${agentId}`),
    ])
    const hasSession = spyOn(conversationService, 'hasSession').mockReturnValue(true)
    const startSession = spyOn(conversationService, 'startSession').mockResolvedValue()
    const requestControl = spyOn(conversationService, 'requestControl').mockResolvedValue({
      agent_id: agentId,
      delivery: 'queued',
    })

    try {
      const res = await fetch(
        `${baseUrl}/api/sessions/${sessionId}/subagents/by-tool/tool-running/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: 'Continue from the same context.' }),
        },
      )

      expect(res.status).toBe(200)
      expect(startSession).not.toHaveBeenCalled()
      expect(requestControl).toHaveBeenCalledWith(sessionId, {
        subtype: 'send_agent_message',
        agent_id: agentId,
        content: 'Continue from the same context.',
      })
    } finally {
      requestControl.mockRestore()
      startSession.mockRestore()
      hasSession.mockRestore()
    }
  })

  it('POST /api/sessions/:id/subagents/by-tool/:toolUseId should return 405', async () => {
    const res = await fetch(
      `${baseUrl}/api/sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/subagents/by-tool/tool-1`,
      { method: 'POST' },
    )

    expect(res.status).toBe(405)
  })

  it('GET /api/sessions/:id/subagents/by-tool/:toolUseId/extra should return 404', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const agentId = 'abc123'
    await writeSessionFile('-tmp-api-subagent-run-extra', sessionId, [
      makeSnapshotEntry(),
      makeAssistantToolUseEntry([
        {
          id: 'tool-1',
          name: 'Agent',
          input: { description: 'Inspect server seam', prompt: 'Read session routes' },
        },
      ]),
      makeToolResultUserEntry('tool-1', `server summary\nagentId: ${agentId}`),
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/subagents/by-tool/tool-1/extra`)

    expect(res.status).toBe(404)
  })

  it('GET /api/sessions/:id/subagents/by-tool/:toolUseId should return 404 for malformed encoding', async () => {
    const { handleSessionsApi } = await import('../api/sessions.js')
    const res = await handleSessionsApi(
      new Request(`${baseUrl}/api/sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/subagents/by-tool/%25E0%25A4%25A`),
      new URL(`${baseUrl}/api/sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/subagents/by-tool/%25E0%25A4%25A`),
      ['api', 'sessions', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'subagents', 'by-tool', '%E0%A4%A'],
    )

    expect(res.status).toBe(404)
  })

  it('GET /api/sessions/:id/git-info should prefer the active CLI workDir', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const activeWorktree = path.join(tmpDir, `active-feature-rail-${Date.now()}`)
    git(workDir, 'worktree', 'add', activeWorktree, 'feature/rail')
    const { sessionId } = await sessionService.createSession(workDir)
    const sessionsMap = (conversationService as any).sessions as Map<string, { workDir: string }>

    sessionsMap.set(sessionId, { workDir: activeWorktree })
    try {
      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git-info`)
      expect(res.status).toBe(200)

      const body = (await res.json()) as { branch: string | null; workDir: string }
      expect(body.workDir).toBe(activeWorktree)
      expect(body.branch).toBe('feature/rail')
    } finally {
      sessionsMap.delete(sessionId)
    }
  })

  it('GET /api/sessions/:id/git-info should keep the session launch branch stable', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const { sessionId } = await sessionService.createSession(
      workDir,
      { branch: 'feature/rail', worktree: false },
    )
    const sessionsMap = (conversationService as any).sessions as Map<string, { workDir: string }>

    sessionsMap.set(sessionId, { workDir })
    git(workDir, 'switch', 'main')
    try {
      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git-info`)
      expect(res.status).toBe(200)

      const body = (await res.json()) as { branch: string | null; workDir: string }
      expect(body.workDir).toBe(workDir)
      expect(body.branch).toBe('feature/rail')
    } finally {
      sessionsMap.delete(sessionId)
    }
  })

  it('GET /api/sessions/:id/git-info should not report the source checkout as a planned worktree', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const { sessionId } = await sessionService.createSession(
      workDir,
      { branch: 'feature/rail', worktree: true },
    )
    const launchInfo = await sessionService.getSessionLaunchInfo(sessionId)
    const plannedPath = launchInfo?.repository?.worktreePath
    expect(plannedPath).toBeTruthy()

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git-info`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      workDir: string
      worktree: {
        path: string | null
        plannedPath: string | null
      } | null
    }
    expect(body.workDir).toBe(launchInfo?.workDir)
    expect(body.worktree).toMatchObject({
      path: null,
      plannedPath,
    })
    expect(body.worktree?.plannedPath).not.toBe(body.workDir)
  })

  it('GET /api/sessions/:id/git-info should keep the visible launch branch while including isolated worktree identity', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const { sessionId } = await sessionService.createSession(
      workDir,
      { branch: 'feature/rail', worktree: true },
    )
    const launchInfo = await sessionService.getSessionLaunchInfo(sessionId)
    const repository = launchInfo?.repository
    expect(repository?.worktreePath).toBeTruthy()
    expect(repository?.worktreeBranch).toBeTruthy()

    const activeWorktree = repository!.worktreePath!
    git(workDir, 'worktree', 'add', '-b', repository!.worktreeBranch!, activeWorktree, 'feature/rail')
    const sessionsMap = (conversationService as any).sessions as Map<string, { workDir: string }>

    sessionsMap.set(sessionId, { workDir: activeWorktree })
    try {
      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git-info`)
      expect(res.status).toBe(200)

      const body = (await res.json()) as {
        branch: string | null
        workDir: string
        worktree: {
          enabled: boolean
          path: string | null
          plannedPath: string | null
          sourceWorkDir: string | null
          slug: string | null
          branch: string | null
        } | null
      }
      expect(body.branch).toBe('feature/rail')
      expect(body.workDir).toBe(activeWorktree)
      expect(body.worktree).toEqual({
        enabled: true,
        path: activeWorktree,
        plannedPath: activeWorktree,
        sourceWorkDir: repository!.requestedWorkDir,
        slug: repository!.worktreeSlug,
        branch: repository!.worktreeBranch,
      })
    } finally {
      sessionsMap.delete(sessionId)
    }
  })

  it('GET /api/sessions/:id/git-info should use CLI worktree-state after reload', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const activeWorktree = path.join(workDir, '.claude', 'worktrees', 'desktop-main-12345678')
    git(workDir, 'worktree', 'add', '-b', 'worktree-desktop-main-12345678', activeWorktree, 'main')
    await writeSessionFile(sanitizePath(activeWorktree), sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry(activeWorktree),
      makeWorktreeStateEntry(sessionId, activeWorktree, {
        originalCwd: await fs.realpath(workDir),
      }),
      makeUserEntry('Hello from persisted worktree state'),
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git-info`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      branch: string | null
      repoName: string | null
      workDir: string
      worktree: {
        enabled: boolean
        path: string | null
        plannedPath: string | null
        sourceWorkDir: string | null
        slug: string | null
        branch: string | null
      } | null
    }
    expect(body.branch).toBe('main')
    expect(body.workDir).toBe(activeWorktree)
    expect(body.worktree).toEqual({
      enabled: true,
      path: activeWorktree,
      plannedPath: activeWorktree,
      sourceWorkDir: await fs.realpath(workDir),
      slug: 'desktop-main-12345678',
      branch: 'worktree-desktop-main-12345678',
    })
  })

  it('GET /api/sessions/:id/git-info should prefer CLI worktree-state identity over desktop metadata', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const activeWorktree = path.join(workDir, '.claude', 'worktrees', 'desktop-main-12345678')
    git(workDir, 'worktree', 'add', '-b', 'worktree-desktop-main-12345678', activeWorktree, 'main')
    await writeSessionFile(sanitizePath(activeWorktree), sessionId, [
      makeSnapshotEntry(),
      {
        type: 'session-meta',
        isMeta: true,
        workDir: activeWorktree,
        repository: {
          requestedWorkDir: '/stale/source',
          repoRoot: '/stale/source',
          branch: 'main',
          worktree: true,
          baseRef: 'main',
          worktreePath: '/stale/source/.claude/worktrees/stale',
          worktreeBranch: 'worktree-stale',
          worktreeSlug: 'stale',
        },
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      makeWorktreeStateEntry(sessionId, activeWorktree, {
        originalCwd: await fs.realpath(workDir),
      }),
      makeUserEntry('Hello from persisted worktree state'),
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git-info`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      branch: string | null
      worktree: {
        path: string | null
        plannedPath: string | null
        sourceWorkDir: string | null
        slug: string | null
        branch: string | null
      } | null
    }
    expect(body.branch).toBe('main')
    expect(body.worktree).toMatchObject({
      path: activeWorktree,
      plannedPath: activeWorktree,
      sourceWorkDir: await fs.realpath(workDir),
      slug: 'desktop-main-12345678',
      branch: 'worktree-desktop-main-12345678',
    })
  })

  it('GET /api/sessions/:id/git-info should not hang when git blocks in a UTF-8 workDir', async () => {
    if (process.platform === 'win32') return

    const parentDir = path.join(tmpDir, '数据包看板')
    const workDir = path.join(parentDir, 'datavizprocessingplatform')
    await fs.mkdir(workDir, { recursive: true })
    git(workDir, 'init', '--initial-branch', 'main')
    git(workDir, 'config', 'user.email', 'sessions-api@example.com')
    git(workDir, 'config', 'user.name', 'Sessions API')
    await fs.writeFile(path.join(workDir, 'README.md'), 'main\n')
    git(workDir, 'add', 'README.md')
    git(workDir, 'commit', '-m', 'initial')

    const fsmonitorPath = path.join(tmpDir, 'slow-fsmonitor.sh')
    await fs.writeFile(fsmonitorPath, '#!/bin/sh\nsleep 2\nexit 0\n', 'utf-8')
    await fs.chmod(fsmonitorPath, 0o755)
    git(workDir, 'config', 'core.fsmonitor', fsmonitorPath)

    const { sessionId } = await sessionService.createSession(workDir)
    const oldTimeout = process.env.CC_HAHA_GIT_INFO_TIMEOUT_MS
    process.env.CC_HAHA_GIT_INFO_TIMEOUT_MS = '80'

    try {
      const startedAt = Date.now()
      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git-info`, {
        signal: AbortSignal.timeout(1_000),
      })
      expect(Date.now() - startedAt).toBeLessThan(1_000)
      expect(res.status).toBe(200)

      const body = (await res.json()) as {
        branch: string | null
        repoName: string | null
        workDir: string
        changedFiles: number
      }
      expect(body.workDir).toBe(await fs.realpath(workDir))
      expect(body.workDir).toContain('数据包看板')
      expect(body.branch).toBe('main')
      expect(body.repoName).toBe('datavizprocessingplatform')
      expect(body.changedFiles).toBe(0)
    } finally {
      if (oldTimeout === undefined) {
        delete process.env.CC_HAHA_GIT_INFO_TIMEOUT_MS
      } else {
        process.env.CC_HAHA_GIT_INFO_TIMEOUT_MS = oldTimeout
      }
    }
  })

  it('DELETE /api/sessions/:id should delete the session', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-api-test', sessionId, [makeSnapshotEntry()])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' })
    expect(res.status).toBe(200)

    // Verify it's gone
    const res2 = await fetch(`${baseUrl}/api/sessions/${sessionId}`)
    expect(res2.status).toBe(404)
  })

  it('DELETE /api/sessions/:id should invalidate recent projects cache', async () => {
    const workDir = await fs.mkdtemp(path.join(tmpDir, 'recent-cache-delete-'))
    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir }),
    })
    expect(createRes.status).toBe(201)
    const { sessionId } = await createRes.json() as { sessionId: string }
    const realWorkDir = await fs.realpath(workDir)

    const firstRecentRes = await fetch(`${baseUrl}/api/sessions/recent-projects?limit=20`)
    expect(firstRecentRes.status).toBe(200)
    const firstRecent = await firstRecentRes.json() as {
      projects: Array<{ realPath: string }>
    }
    expect(firstRecent.projects.some((project) => project.realPath === realWorkDir)).toBe(true)

    const deleteRes = await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' })
    expect(deleteRes.status).toBe(200)

    const secondRecentRes = await fetch(`${baseUrl}/api/sessions/recent-projects?limit=20`)
    expect(secondRecentRes.status).toBe(200)
    const secondRecent = await secondRecentRes.json() as {
      projects: Array<{ realPath: string }>
    }
    expect(secondRecent.projects.some((project) => project.realPath === realWorkDir)).toBe(false)
  })

  it('DELETE /api/sessions/:id should remove matching IM adapter session mappings', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const otherSessionId = 'ffffffff-1111-2222-3333-ffffffffffff'
    await writeSessionFile('-tmp-api-test', sessionId, [makeSnapshotEntry()])
    await fs.writeFile(
      path.join(tmpDir, 'adapter-sessions.json'),
      JSON.stringify({
        'wechat-chat': {
          sessionId,
          workDir: '/tmp/project-a',
          updatedAt: 1,
        },
        'wechat-chat-2': {
          sessionId,
          workDir: '/tmp/project-b',
          updatedAt: 2,
        },
        'other-chat': {
          sessionId: otherSessionId,
          workDir: '/tmp/project-c',
          updatedAt: 3,
        },
      }, null, 2),
      'utf-8',
    )

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' })
    expect(res.status).toBe(200)

    const persisted = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'adapter-sessions.json'), 'utf-8'),
    )
    expect(persisted['wechat-chat']).toBeUndefined()
    expect(persisted['wechat-chat-2']).toBeUndefined()
    expect(persisted['other-chat'].sessionId).toBe(otherSessionId)
  })

  it('DELETE /api/sessions/:id should roll back the deleted marker when file deletion fails', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-api-test', sessionId, [makeSnapshotEntry()])

    const originalDeleteSession = sessionService.deleteSession.bind(sessionService)
    sessionService.deleteSession = (async (targetSessionId: string) => {
      if (targetSessionId === sessionId) {
        throw new Error('simulated unlink failure')
      }
      return originalDeleteSession(targetSessionId)
    }) as typeof sessionService.deleteSession

    try {
      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' })
      expect(res.status).toBe(500)
      expect((conversationService as any).deletedSessions.has(sessionId)).toBe(false)

      const detailRes = await fetch(`${baseUrl}/api/sessions/${sessionId}`)
      expect(detailRes.status).toBe(200)
    } finally {
      sessionService.deleteSession = originalDeleteSession as typeof sessionService.deleteSession
      conversationService.unmarkSessionDeleted(sessionId)
    }
  })

  it('POST /api/sessions/batch-delete should delete sessions and clean adapter mappings', async () => {
    const sessionIdA = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const sessionIdB = 'ffffffff-1111-2222-3333-ffffffffffff'
    const otherSessionId = '99999999-1111-2222-3333-999999999999'
    await writeSessionFile('-tmp-api-test', sessionIdA, [makeSnapshotEntry()])
    await writeSessionFile('-tmp-api-test', sessionIdB, [makeSnapshotEntry()])
    await fs.writeFile(
      path.join(tmpDir, 'adapter-sessions.json'),
      JSON.stringify({
        'wechat-chat-a': {
          sessionId: sessionIdA,
          workDir: '/tmp/project-a',
          updatedAt: 1,
        },
        'wechat-chat-b': {
          sessionId: sessionIdB,
          workDir: '/tmp/project-b',
          updatedAt: 2,
        },
        'other-chat': {
          sessionId: otherSessionId,
          workDir: '/tmp/project-c',
          updatedAt: 3,
        },
      }, null, 2),
      'utf-8',
    )

    const res = await fetch(`${baseUrl}/api/sessions/batch-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionIds: [sessionIdA, sessionIdB] }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      successes: [sessionIdA, sessionIdB],
      failures: [],
    })

    expect((await fetch(`${baseUrl}/api/sessions/${sessionIdA}`)).status).toBe(404)
    expect((await fetch(`${baseUrl}/api/sessions/${sessionIdB}`)).status).toBe(404)
    const persisted = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'adapter-sessions.json'), 'utf-8'),
    )
    expect(persisted['wechat-chat-a']).toBeUndefined()
    expect(persisted['wechat-chat-b']).toBeUndefined()
    expect(persisted['other-chat'].sessionId).toBe(otherSessionId)
  })

  it('POST /api/sessions/batch-delete should report partial failures and roll back failed delete markers', async () => {
    const successSessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const failedSessionId = 'ffffffff-1111-2222-3333-ffffffffffff'
    await writeSessionFile('-tmp-api-test', successSessionId, [makeSnapshotEntry()])
    await writeSessionFile('-tmp-api-test', failedSessionId, [makeSnapshotEntry()])

    const originalDeleteSession = sessionService.deleteSession.bind(sessionService)
    sessionService.deleteSession = (async (targetSessionId: string) => {
      if (targetSessionId === failedSessionId) {
        throw new Error('simulated batch unlink failure')
      }
      return originalDeleteSession(targetSessionId)
    }) as typeof sessionService.deleteSession

    try {
      const res = await fetch(`${baseUrl}/api/sessions/batch-delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: [successSessionId, failedSessionId] }),
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        ok: false,
        successes: [successSessionId],
        failures: [{
          sessionId: failedSessionId,
          message: 'simulated batch unlink failure',
        }],
      })
      expect((conversationService as any).deletedSessions.has(failedSessionId)).toBe(false)
      expect((await fetch(`${baseUrl}/api/sessions/${successSessionId}`)).status).toBe(404)
      expect((await fetch(`${baseUrl}/api/sessions/${failedSessionId}`)).status).toBe(200)
    } finally {
      sessionService.deleteSession = originalDeleteSession as typeof sessionService.deleteSession
      conversationService.unmarkSessionDeleted(successSessionId)
      conversationService.unmarkSessionDeleted(failedSessionId)
    }
  })

  it('PATCH /api/sessions/:id should rename the session', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-api-test', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Old title message'),
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Custom Title' }),
    })
    expect(res.status).toBe(200)

    // Verify new title
    const detailRes = await fetch(`${baseUrl}/api/sessions/${sessionId}`)
    const detail = (await detailRes.json()) as { title: string }
    expect(detail.title).toBe('New Custom Title')
  })

  it('GET /api/sessions/:id/slash-commands should include user and project skills before CLI init', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const workDir = path.join(tmpDir, 'workspace', 'app')

    await fs.mkdir(path.join(workDir, '.claude', 'skills'), { recursive: true })
    await fs.mkdir(path.join(tmpDir, 'skills'), { recursive: true })
    await writeSkill(path.join(tmpDir, 'skills'), 'user-skill', 'User skill description')
    await writeSkill(path.join(workDir, '.claude', 'skills'), 'project-skill', 'Project skill description')

    await writeSessionFile('-tmp-api-test', sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry(workDir),
    ])

    clearCommandsCache()

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/slash-commands`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      commands: Array<{ name: string; description: string }>
    }

    expect(body.commands).toContainEqual(
      expect.objectContaining({
        name: 'user-skill',
        description: 'User skill description',
        kind: 'skill',
        source: 'user',
      }),
    )
    expect(body.commands).toContainEqual(
      expect.objectContaining({
        name: 'project-skill',
        description: 'Project skill description',
        kind: 'skill',
        source: 'project',
      }),
    )
  })

  it('GET /api/sessions/:id/slash-commands should include legacy custom commands before CLI init', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeef'
    const workDir = path.join(tmpDir, 'workspace', 'app')

    await writeLegacySlashCommand(
      path.join(tmpDir, 'commands'),
      'user-probe',
      'User custom slash command',
    )
    await writeLegacySlashCommand(
      path.join(workDir, '.claude', 'commands'),
      'project-probe',
      'Project custom slash command',
    )

    await writeSessionFile('-tmp-api-test', sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry(workDir),
    ])

    clearCommandsCache()

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/slash-commands`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      commands: Array<{ name: string; description: string; argumentHint?: string }>
    }

    expect(body.commands).toContainEqual(
      expect.objectContaining({
        name: 'user-probe',
        description: 'User custom slash command',
        argumentHint: '<topic>',
        kind: 'command',
      }),
    )
    expect(body.commands).toContainEqual(
      expect.objectContaining({
        name: 'project-probe',
        description: 'Project custom slash command',
        argumentHint: '<topic>',
        kind: 'command',
      }),
    )
  })

  it('GET /api/sessions/:id/slash-commands should preserve cached command argument hints when merging custom commands', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeef001'
    const workDir = path.join(tmpDir, 'workspace', 'app')

    await writeSkill(
      path.join(workDir, '.claude', 'skills'),
      'project-skill-probe',
      'Project skill description',
    )
    await writeLegacySlashCommand(
      path.join(workDir, '.claude', 'commands'),
      'project-probe',
      'Project custom slash command',
    )

    await writeSessionFile('-tmp-api-test', sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry(workDir),
    ])

    updateSessionSlashCommands(
      sessionId,
      [
        { name: 'builtin-probe', description: 'Cached CLI command', argumentHint: '<value>' },
        { name: 'project-skill-probe', description: 'Cached CLI skill', argumentHint: '<topic>' },
      ],
      { notifyClient: false },
    )
    clearCommandsCache()

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/slash-commands`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      commands: Array<{ name: string; description: string; argumentHint?: string }>
    }

    expect(body.commands).toContainEqual({
      name: 'builtin-probe',
      description: 'Cached CLI command',
      argumentHint: '<value>',
      kind: 'command',
    })
    expect(body.commands).toContainEqual({
      name: 'project-skill-probe',
      description: 'Cached CLI skill',
      argumentHint: '<topic>',
      kind: 'skill',
      source: 'project',
    })
    expect(body.commands).toContainEqual(
      expect.objectContaining({
        name: 'project-probe',
        description: 'Project custom slash command',
        kind: 'command',
      }),
    )
  })

  it('GET /api/sessions/:id/slash-commands should include enabled plugin skills before CLI init', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff'
    const workDir = path.join(tmpDir, 'workspace', 'app')
    const marketplaceRoot = path.join(tmpDir, 'marketplace-root')
    const pluginRoot = path.join(marketplaceRoot, 'plugins', 'superpowers')
    const pluginsDir = path.join(tmpDir, 'plugins')
    const marketplaceFile = path.join(
      marketplaceRoot,
      '.claude-plugin',
      'marketplace.json',
    )

    await fs.mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true })
    await fs.mkdir(path.dirname(marketplaceFile), { recursive: true })
    await fs.mkdir(pluginsDir, { recursive: true })
    await fs.mkdir(workDir, { recursive: true })
    await writeSkill(
      path.join(pluginRoot, 'skills'),
      'brainstorming',
      'Superpowers brainstorming skill',
    )
    await fs.writeFile(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'superpowers',
        version: '5.0.7',
        description: 'Core skills library',
      }),
      'utf-8',
    )
    await fs.writeFile(
      marketplaceFile,
      JSON.stringify({
        name: 'claude-plugins-official',
        owner: { name: 'Test' },
        plugins: [
          {
            name: 'superpowers',
            source: './plugins/superpowers',
            version: '5.0.7',
          },
        ],
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(pluginsDir, 'known_marketplaces.json'),
      JSON.stringify({
        'claude-plugins-official': {
          source: { source: 'directory', path: marketplaceRoot },
          installLocation: marketplaceRoot,
          lastUpdated: new Date(0).toISOString(),
        },
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({
        enabledPlugins: {
          'superpowers@claude-plugins-official': true,
        },
      }),
      'utf-8',
    )

    resetSettingsCache()
    clearPluginCache('sessions-api-plugin-skills')
    clearCommandsCache()
    await writeSessionFile('-tmp-api-test', sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry(workDir),
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/slash-commands`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      commands: Array<{ name: string; description: string }>
    }

    expect(body.commands).toContainEqual(
      expect.objectContaining({
        name: 'superpowers:brainstorming',
        description: 'Superpowers brainstorming skill',
        kind: 'skill',
        source: 'plugin',
      }),
    )
  })

  it('GET /api/sessions/:id/workspace/status|tree|search|file|diff should return workspace data', async () => {
    const workDir = await createWorkspaceApiGitRepo(tmpDir)
    const { sessionId } = await service.createSession(workDir)

    const statusRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/workspace/status`)
    expect(statusRes.status).toBe(200)
    const statusBody = await statusRes.json() as {
      state: string
      workDir: string
      changedFiles: Array<{ path: string; status: string }>
      isGitRepo: boolean
    }
    expect(statusBody.state).toBe('ok')
    expect(statusBody.workDir).toBe(await fs.realpath(workDir))
    expect(statusBody.isGitRepo).toBe(true)
    expect(statusBody.changedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'tracked.txt', status: 'modified' }),
      ]),
    )

    const treeRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/workspace/tree`)
    expect(treeRes.status).toBe(200)
    const treeBody = await treeRes.json() as {
      state: string
      path: string
      entries: Array<{ name: string; path: string; isDirectory: boolean }>
    }
    expect(treeBody).toMatchObject({
      state: 'ok',
      path: '',
    })
    expect(treeBody.entries).toEqual([
      { name: 'services', path: 'services', isDirectory: true },
      { name: 'src', path: 'src', isDirectory: true },
      { name: 'tracked.txt', path: 'tracked.txt', isDirectory: false },
    ])

    const searchRes = await fetch(
      `${baseUrl}/api/sessions/${sessionId}/workspace/search?query=${encodeURIComponent('MentalHealthTrendController')}`,
    )
    expect(searchRes.status).toBe(200)
    expect(await searchRes.json()).toMatchObject({
      state: 'ok',
      query: 'MentalHealthTrendController',
      truncated: false,
      entries: [{
        name: 'MentalHealthTrendController.java',
        path: 'services/mental-health-service/src/main/java/com/example/campus/mentalhealth/controller/MentalHealthTrendController.java',
        isDirectory: false,
      }],
    })

    const fileRes = await fetch(
      `${baseUrl}/api/sessions/${sessionId}/workspace/file?path=${encodeURIComponent('src/app.ts')}`,
    )
    expect(fileRes.status).toBe(200)
    const fileBody = await fileRes.json() as {
      state: string
      path: string
      content?: string
      language: string
      size: number
    }
    expect(fileBody).toMatchObject({
      state: 'ok',
      path: 'src/app.ts',
      language: 'typescript',
      size: 25,
      content: 'export const answer = 42\n',
    })

    const diffRes = await fetch(
      `${baseUrl}/api/sessions/${sessionId}/workspace/diff?path=${encodeURIComponent('tracked.txt')}`,
    )
    expect(diffRes.status).toBe(200)
    const diffBody = await diffRes.json() as {
      state: string
      path: string
      diff?: string
    }
    expect(diffBody.state).toBe('ok')
    expect(diffBody.path).toBe('tracked.txt')
    expect(diffBody.diff).toContain('tracked.txt')
  })

  it('GET /api/sessions/:id/workspace/* should surface transcript changes for a non-git tmp session', async () => {
    const sessionId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
    const workDir = await fs.mkdtemp(path.join(tmpDir, 'workspace-api-non-git-'))
    const srcDir = path.join(workDir, 'src')
    const notesDir = path.join(workDir, 'notes')
    const assetsDir = path.join(workDir, 'assets')

    await fs.mkdir(srcDir, { recursive: true })
    await fs.mkdir(notesDir, { recursive: true })
    await fs.mkdir(assetsDir, { recursive: true })
    await fs.writeFile(path.join(workDir, 'README.md'), '# Temporary project\n')
    await fs.writeFile(path.join(srcDir, 'app.ts'), 'export const answer = 2\n')
    await fs.writeFile(path.join(notesDir, 'todo.md'), '- ship workspace panel\n')
    await fs.writeFile(
      path.join(assetsDir, 'pixel.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
        'base64',
      ),
    )

    await writeSessionFile(sanitizePath(workDir), sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry(workDir),
      makeUserEntry('Update this temporary project'),
      makeAssistantToolUseEntry([
        {
          id: 'toolu-edit-app',
          name: 'Edit',
          input: {
            file_path: path.join(workDir, 'src', 'app.ts'),
            old_string: 'export const answer = 1\n',
            new_string: 'export const answer = 2\n',
          },
        },
        {
          id: 'toolu-write-todo',
          name: 'Write',
          input: {
            file_path: path.join(workDir, 'notes', 'todo.md'),
            content: '- ship workspace panel\n',
          },
        },
      ]),
    ])

    const statusRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/workspace/status`)
    expect(statusRes.status).toBe(200)
    const statusBody = await statusRes.json() as {
      state: string
      workDir: string
      repoName: string | null
      branch: string | null
      isGitRepo: boolean
      changedFiles: Array<{
        path: string
        status: string
        additions: number
        deletions: number
      }>
    }
    expect(statusBody).toMatchObject({
      state: 'ok',
      workDir,
      repoName: path.basename(workDir),
      branch: null,
      isGitRepo: false,
    })
    expect(statusBody.changedFiles).toEqual([
      expect.objectContaining({
        path: 'notes/todo.md',
        status: 'added',
        additions: 1,
        deletions: 0,
      }),
      expect.objectContaining({
        path: 'src/app.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
      }),
    ])

    const treeRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/workspace/tree`)
    expect(treeRes.status).toBe(200)
    const treeBody = await treeRes.json() as {
      state: string
      path: string
      entries: Array<{ name: string; path: string; isDirectory: boolean }>
    }
    expect(treeBody).toMatchObject({ state: 'ok', path: '' })
    expect(treeBody.entries).toEqual([
      { name: 'assets', path: 'assets', isDirectory: true },
      { name: 'notes', path: 'notes', isDirectory: true },
      { name: 'src', path: 'src', isDirectory: true },
      { name: 'README.md', path: 'README.md', isDirectory: false },
    ])

    const srcTreeRes = await fetch(
      `${baseUrl}/api/sessions/${sessionId}/workspace/tree?path=${encodeURIComponent('src')}`,
    )
    expect(srcTreeRes.status).toBe(200)
    expect(await srcTreeRes.json()).toMatchObject({
      state: 'ok',
      path: 'src',
      entries: [{ name: 'app.ts', path: 'src/app.ts', isDirectory: false }],
    })

    const fileRes = await fetch(
      `${baseUrl}/api/sessions/${sessionId}/workspace/file?path=${encodeURIComponent('src/app.ts')}`,
    )
    expect(fileRes.status).toBe(200)
    expect(await fileRes.json()).toMatchObject({
      state: 'ok',
      path: 'src/app.ts',
      previewType: 'text',
      language: 'typescript',
      content: 'export const answer = 2\n',
    })

    const imageRes = await fetch(
      `${baseUrl}/api/sessions/${sessionId}/workspace/file?path=${encodeURIComponent('assets/pixel.png')}`,
    )
    expect(imageRes.status).toBe(200)
    const imageBody = await imageRes.json() as {
      state: string
      path: string
      previewType: string
      mimeType: string
      dataUrl: string
    }
    expect(imageBody).toMatchObject({
      state: 'ok',
      path: 'assets/pixel.png',
      previewType: 'image',
      mimeType: 'image/png',
    })
    expect(imageBody.dataUrl).toStartWith('data:image/png;base64,')

    const appDiffRes = await fetch(
      `${baseUrl}/api/sessions/${sessionId}/workspace/diff?path=${encodeURIComponent('src/app.ts')}`,
    )
    expect(appDiffRes.status).toBe(200)
    const appDiffBody = await appDiffRes.json() as { state: string; path: string; diff?: string }
    expect(appDiffBody).toMatchObject({ state: 'ok', path: 'src/app.ts' })
    expect(appDiffBody.diff).toContain('diff --session a/src/app.ts b/src/app.ts')
    expect(appDiffBody.diff).toContain('-export const answer = 1')
    expect(appDiffBody.diff).toContain('+export const answer = 2')

    const todoDiffRes = await fetch(
      `${baseUrl}/api/sessions/${sessionId}/workspace/diff?path=${encodeURIComponent('notes/todo.md')}`,
    )
    expect(todoDiffRes.status).toBe(200)
    const todoDiffBody = await todoDiffRes.json() as { state: string; path: string; diff?: string }
    expect(todoDiffBody).toMatchObject({ state: 'ok', path: 'notes/todo.md' })
    expect(todoDiffBody.diff).toContain('--- /dev/null')
    expect(todoDiffBody.diff).toContain('+++ b/notes/todo.md')
    expect(todoDiffBody.diff).toContain('+- ship workspace panel')
  })

  it('GET /api/sessions/:id/workspace/* should surface file-history changes for a non-git generated subdirectory', async () => {
    const sessionId = crypto.randomUUID()
    const workDir = path.join(tmpDir, 'workspace-file-history-generated')
    const generatedFile = path.join(workDir, 'aacc', 'src', 'App.tsx')
    const userId = crypto.randomUUID()

    await fs.mkdir(path.dirname(generatedFile), { recursive: true })
    await fs.writeFile(
      generatedFile,
      'export default function App() { return <main>Tetris</main> }\n',
      'utf-8',
    )

    await writeSessionFile(sanitizePath(workDir), sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(userId, {
        'aacc/src/App.tsx': {
          backupFileName: null,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('create aacc project', userId),
        cwd: workDir,
        sessionId,
      },
      makeAssistantEntry('DONE', userId),
      makeUserEntry(
        '<task-notification>\n<task-id>bg-1</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>completed</status>\n<summary>Background command completed</summary>\n</task-notification>',
        crypto.randomUUID(),
      ),
      makeAssistantEntry('Background task completed again, no action needed'),
    ])

    const statusRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/workspace/status`)
    expect(statusRes.status).toBe(200)
    const statusBody = await statusRes.json() as {
      state: string
      workDir: string
      isGitRepo: boolean
      changedFiles: Array<{
        path: string
        status: string
        additions: number
        deletions: number
      }>
    }
    expect(statusBody).toMatchObject({
      state: 'ok',
      workDir,
      isGitRepo: false,
    })
    expect(statusBody.changedFiles).toEqual([
      expect.objectContaining({
        path: 'aacc/src/App.tsx',
        status: 'added',
        additions: 1,
        deletions: 0,
      }),
    ])

    const diffRes = await fetch(
      `${baseUrl}/api/sessions/${sessionId}/workspace/diff?path=${encodeURIComponent('aacc/src/App.tsx')}`,
    )
    expect(diffRes.status).toBe(200)
    const diffBody = await diffRes.json() as {
      state: string
      path: string
      diff: string
    }
    expect(diffBody).toMatchObject({
      state: 'ok',
      path: 'aacc/src/App.tsx',
    })
    expect(diffBody.diff).toContain('diff --session /dev/null b/aacc/src/App.tsx')
    expect(diffBody.diff).toContain('+export default function App() { return <main>Tetris</main> }')

    const checkpointsRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn-checkpoints`)
    expect(checkpointsRes.status).toBe(200)
    const checkpointsBody = await checkpointsRes.json() as {
      checkpoints: Array<{
        target: {
          targetUserMessageId: string
          userMessageIndex: number
          userMessageCount: number
        }
        code: {
          filesChanged: string[]
        }
      }>
    }
    expect(checkpointsBody.checkpoints).toHaveLength(1)
    expect(checkpointsBody.checkpoints[0]?.target).toMatchObject({
      targetUserMessageId: userId,
      userMessageIndex: 0,
      userMessageCount: 1,
    })
    expect(checkpointsBody.checkpoints[0]?.code.filesChanged).toEqual([generatedFile])
  })

  it('GET /api/sessions/:id/workspace/file and diff should require a path query', async () => {
    const workDir = await createWorkspaceApiGitRepo(tmpDir)
    const { sessionId } = await service.createSession(workDir)

    for (const route of ['file', 'diff']) {
      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/workspace/${route}`)
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({
        error: 'BAD_REQUEST',
      })
    }
  })

  it('GET /api/sessions/:id/workspace/search should require a non-empty query', async () => {
    const workDir = await createWorkspaceApiGitRepo(tmpDir)
    const { sessionId } = await service.createSession(workDir)

    for (const suffix of ['', '?query=%20%20']) {
      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/workspace/search${suffix}`)
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: 'BAD_REQUEST' })
    }
  })

  it('GET /api/sessions/:id/workspace/file and tree should reject traversal with 403', async () => {
    const workDir = await createWorkspaceApiGitRepo(tmpDir)
    const { sessionId } = await service.createSession(workDir)

    for (const route of ['file', 'tree']) {
      const res = await fetch(
        `${baseUrl}/api/sessions/${sessionId}/workspace/${route}?path=${encodeURIComponent('../outside.txt')}`,
      )
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({
        error: 'FORBIDDEN',
      })
    }
  })

  it('GET /api/sessions/:id/workspace/diff should reject traversal with 403', async () => {
    const workDir = await createWorkspaceApiGitRepo(tmpDir)
    const { sessionId } = await service.createSession(workDir)

    const res = await fetch(
      `${baseUrl}/api/sessions/${sessionId}/workspace/diff?path=${encodeURIComponent('../outside.txt')}`,
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      error: 'FORBIDDEN',
    })
  })

  it('GET /api/sessions/:id/workspace/status should 404 for unknown sessions', async () => {
    const res = await fetch(
      `${baseUrl}/api/sessions/00000000-0000-0000-0000-000000000000/workspace/status`,
    )
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({
      error: 'NOT_FOUND',
    })
  })

  it('non-GET workspace routes should return 405', async () => {
    const workDir = await createWorkspaceApiGitRepo(tmpDir)
    const { sessionId } = await service.createSession(workDir)

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/workspace/status`, {
      method: 'POST',
    })

    expect(res.status).toBe(405)
    expect(await res.json()).toMatchObject({
      error: 'METHOD_NOT_ALLOWED',
    })
  })

  it('POST /api/sessions/:id/branch should create a branched session up to the target message', async () => {
    const sessionId = '11111111-1111-4111-8111-111111111111'
    const workDir = path.join(tmpDir, 'branch-api-workdir')
    const firstUserId = crypto.randomUUID()
    const firstAssistantId = crypto.randomUUID()
    const secondUserId = crypto.randomUUID()
    const secondAssistantId = crypto.randomUUID()

    await writeSessionFile(sanitizePath(workDir), sessionId, [
      {
        type: 'session-meta',
        isMeta: true,
        workDir,
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      {
        ...makeUserEntry('first prompt', firstUserId),
        cwd: workDir,
        sessionId,
      },
      {
        ...makeAssistantEntry('first reply', firstUserId),
        uuid: firstAssistantId,
        cwd: workDir,
        sessionId,
      },
      {
        ...makeUserEntry('second prompt', secondUserId),
        parentUuid: firstAssistantId,
        cwd: workDir,
        sessionId,
      },
      {
        ...makeAssistantEntry('second reply', secondUserId),
        uuid: secondAssistantId,
        cwd: workDir,
        sessionId,
      },
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetMessageId: firstAssistantId,
        title: 'API branch',
      }),
    })
    expect(res.status).toBe(201)

    const body = await res.json() as {
      sessionId: string
      title: string
      workDir: string
      sourceSessionId: string
      targetMessageId: string
    }
    expect(body).toMatchObject({
      title: 'API branch (Branch)',
      workDir,
      sourceSessionId: sessionId,
      targetMessageId: firstAssistantId,
    })

    const branchMessages = await service.getSessionMessages(body.sessionId)
    expect(branchMessages.map((message) => message.id)).toEqual([
      firstUserId,
      firstAssistantId,
    ])
  })

  it('POST /api/sessions/:id/branch should reject sidechain targets', async () => {
    const sessionId = '22222222-2222-4222-8222-222222222222'
    const rootUserId = crypto.randomUUID()
    const rootAssistantId = crypto.randomUUID()
    const sidechainId = crypto.randomUUID()

    await writeSessionFile('-tmp-api-branch-sidechain', sessionId, [
      makeSnapshotEntry(),
      {
        ...makeUserEntry('root prompt', rootUserId),
        sessionId,
      },
      {
        ...makeAssistantEntry('root reply', rootUserId),
        uuid: rootAssistantId,
        sessionId,
      },
      {
        ...makeUserEntry('side question', sidechainId),
        parentUuid: rootAssistantId,
        isSidechain: true,
        sessionId,
      },
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetMessageId: sidechainId }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: 'BAD_REQUEST',
    })
  })

  it('POST /api/sessions/:id/branch should validate request bodies and missing sessions', async () => {
    const methodNotAllowedRes = await fetch(`${baseUrl}/api/sessions/33333333-3333-4333-8333-333333333333/branch`)
    expect(methodNotAllowedRes.status).toBe(405)

    const missingTargetRes = await fetch(`${baseUrl}/api/sessions/branch-missing-target/branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(missingTargetRes.status).toBe(400)

    const invalidJsonRes = await fetch(`${baseUrl}/api/sessions/branch-invalid-json/branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    })
    expect(invalidJsonRes.status).toBe(400)

    const invalidTitleRes = await fetch(`${baseUrl}/api/sessions/44444444-4444-4444-8444-444444444444/branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetMessageId: 'message-1', title: 123 }),
    })
    expect(invalidTitleRes.status).toBe(400)

    const missingSessionRes = await fetch(`${baseUrl}/api/sessions/00000000-0000-0000-0000-000000000000/branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetMessageId: 'missing-target' }),
    })
    expect(missingSessionRes.status).toBe(404)
  })

  it('POST /api/sessions/:id/rewind should preview and trim the active conversation chain', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const firstUserId = crypto.randomUUID()
    const firstAssistantId = crypto.randomUUID()
    const secondUserId = crypto.randomUUID()
    const secondAssistantId = crypto.randomUUID()

    await writeSessionFile('-tmp-api-test', sessionId, [
      makeSnapshotEntry(),
      {
        parentUuid: null,
        isSidechain: false,
        type: 'user',
        message: { role: 'user', content: 'first prompt' },
        uuid: firstUserId,
        timestamp: '2026-01-01T00:01:00.000Z',
        userType: 'external',
        cwd: '/tmp/test',
        sessionId,
      },
      {
        parentUuid: firstUserId,
        isSidechain: false,
        type: 'assistant',
        message: {
          model: 'claude-opus-4-7',
          id: `msg_${crypto.randomUUID().slice(0, 20)}`,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'first reply' }],
        },
        uuid: firstAssistantId,
        timestamp: '2026-01-01T00:02:00.000Z',
      },
      {
        parentUuid: firstAssistantId,
        isSidechain: false,
        type: 'user',
        message: { role: 'user', content: 'second prompt' },
        uuid: secondUserId,
        timestamp: '2026-01-01T00:03:00.000Z',
        userType: 'external',
        cwd: '/tmp/test',
        sessionId,
      },
      {
        parentUuid: secondUserId,
        isSidechain: false,
        type: 'assistant',
        message: {
          model: 'claude-opus-4-7',
          id: `msg_${crypto.randomUUID().slice(0, 20)}`,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'second reply' }],
        },
        uuid: secondAssistantId,
        timestamp: '2026-01-01T00:04:00.000Z',
      },
    ])

    const previewRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessageIndex: 1, dryRun: true }),
    })
    expect(previewRes.status).toBe(200)

    const previewBody = await previewRes.json() as {
      conversation: { messagesRemoved: number }
      code: { available: boolean }
    }
    expect(previewBody.conversation.messagesRemoved).toBe(2)
    expect(previewBody.code.available).toBe(false)

    const executeRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessageIndex: 1 }),
    })
    expect(executeRes.status).toBe(200)

    const executeBody = await executeRes.json() as {
      conversation: { messagesRemoved: number; removedMessageIds: string[] }
    }
    expect(executeBody.conversation.messagesRemoved).toBe(2)
    expect(executeBody.conversation.removedMessageIds).toEqual([
      secondUserId,
      secondAssistantId,
    ])

    const remainingMessages = await service.getSessionMessages(sessionId)
    expect(remainingMessages.map((message) => message.id)).toEqual([
      firstUserId,
      firstAssistantId,
    ])
  })

  it('trimSessionMessagesFrom should remove orphan transcript entries beyond the rewind point', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const firstUserId = crypto.randomUUID()
    const firstAssistantId = crypto.randomUUID()
    const secondUserId = crypto.randomUUID()
    const secondAssistantId = crypto.randomUUID()

    const filePath = await writeSessionFile('-tmp-api-rewind-orphans', sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry('/tmp/project-with-hyphen'),
      {
        ...makeUserEntry('first prompt', firstUserId),
        sessionId,
      },
      {
        ...makeAssistantEntry('first reply', firstUserId),
        uuid: firstAssistantId,
      },
      {
        ...makeUserEntry('second prompt', secondUserId),
        parentUuid: firstAssistantId,
        sessionId,
      },
      {
        ...makeAssistantEntry('second reply', secondUserId),
        uuid: secondAssistantId,
      },
      {
        ...makeAssistantEntry('late stale reply', secondUserId),
        uuid: crypto.randomUUID(),
      },
    ])

    const result = await service.trimSessionMessagesFrom(sessionId, firstUserId)
    expect(result.removedMessageIds).toContain(firstUserId)
    expect(result.removedMessageIds).toContain(secondUserId)

    const raw = await fs.readFile(filePath, 'utf-8')
    expect(raw).toContain('"type":"session-meta"')
    expect(raw).not.toContain('late stale reply')
    expect(await service.getSessionMessages(sessionId)).toEqual([])

    const launchInfo = await service.getSessionLaunchInfo(sessionId)
    expect(launchInfo).not.toBeNull()
    expect(launchInfo!.workDir).toBe('/tmp/project-with-hyphen')
    expect(launchInfo!.transcriptMessageCount).toBe(0)
  })

  it('POST /api/sessions/:id/rewind should target the selected message id instead of a shifted visible index', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff'
    const firstUserId = crypto.randomUUID()
    const firstAssistantId = crypto.randomUUID()
    const hiddenUserId = crypto.randomUUID()
    const targetUserId = crypto.randomUUID()
    const targetAssistantId = crypto.randomUUID()

    await writeSessionFile('-tmp-api-rewind-id-target', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('first prompt', firstUserId),
      {
        ...makeAssistantEntry('first reply', firstUserId),
        uuid: firstAssistantId,
      },
      makeUserEntry(
        '<teammate-message teammate_id="reviewer">internal status that the main chat hides</teammate-message>',
        hiddenUserId,
      ),
      makeUserEntry('second visible prompt', targetUserId),
      {
        ...makeAssistantEntry('second reply', targetUserId),
        uuid: targetAssistantId,
      },
    ])

    const executeRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userMessageIndex: 1,
        targetUserMessageId: targetUserId,
        expectedContent: 'second visible prompt',
      }),
    })
    expect(executeRes.status).toBe(200)

    const executeBody = await executeRes.json() as {
      target: { targetUserMessageId: string; userMessageIndex: number }
      conversation: { messagesRemoved: number; removedMessageIds: string[] }
    }
    expect(executeBody.target.targetUserMessageId).toBe(targetUserId)
    expect(executeBody.target.userMessageIndex).toBe(2)
    expect(executeBody.conversation.messagesRemoved).toBe(2)
    expect(executeBody.conversation.removedMessageIds).toEqual([
      targetUserId,
      targetAssistantId,
    ])

    const remainingMessages = await service.getSessionMessages(sessionId)
    expect(remainingMessages.map((message) => message.id)).toEqual([
      firstUserId,
      firstAssistantId,
      hiddenUserId,
    ])
  })

  it('POST /api/sessions/:id/rewind should reject an index fallback when the selected prompt no longer matches', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-000000000000'
    const firstUserId = crypto.randomUUID()
    const hiddenUserId = crypto.randomUUID()
    const targetUserId = crypto.randomUUID()

    await writeSessionFile('-tmp-api-rewind-index-guard', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('first prompt', firstUserId),
      makeUserEntry(
        '<teammate-message teammate_id="reviewer">internal status that the main chat hides</teammate-message>',
        hiddenUserId,
      ),
      makeUserEntry('second visible prompt', targetUserId),
    ])

    const executeRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userMessageIndex: 1,
        expectedContent: 'second visible prompt',
      }),
    })
    expect(executeRes.status).toBe(400)

    const body = await executeRes.json() as { message: string }
    expect(body.message).toContain('does not match the selected prompt')

    const remainingMessages = await service.getSessionMessages(sessionId)
    expect(remainingMessages.map((message) => message.id)).toEqual([
      firstUserId,
      hiddenUserId,
      targetUserId,
    ])
  })

  it('POST /api/sessions/:id/rewind should restore a single edited file', async () => {
    const sessionId = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee'
    const workDir = path.join(tmpDir, 'single-file-fixture')
    const targetFile = path.join(workDir, 'src', 'app.js')
    const userId = crypto.randomUUID()
    const assistantId = crypto.randomUUID()
    const backupName = 'single-file@v1'

    await fs.mkdir(path.dirname(targetFile), { recursive: true })
    await fs.writeFile(
      targetFile,
      "export const ORIGINAL_VALUE = 'after-rewind'\n",
      'utf-8',
    )
    await writeFileHistoryBackup(
      sessionId,
      backupName,
      "export const ORIGINAL_VALUE = 'before-rewind'\n",
    )

    await writeSessionFile('-tmp-api-single-file', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(userId, {
        'src/app.js': {
          backupFileName: backupName,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('edit app.js', userId),
        cwd: workDir,
        sessionId,
      },
      {
        ...makeAssistantEntry('DONE', userId),
        uuid: assistantId,
      },
    ])

    const previewRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessageIndex: 0, dryRun: true }),
    })
    expect(previewRes.status).toBe(200)
    const preview = await previewRes.json() as {
      code: { available: boolean; filesChanged: string[] }
    }
    expect(preview.code.available).toBe(true)
    expect(preview.code.filesChanged).toEqual([targetFile])

    const executeRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessageIndex: 0 }),
    })
    expect(executeRes.status).toBe(200)
    expect(await fs.readFile(targetFile, 'utf-8')).toBe(
      "export const ORIGINAL_VALUE = 'before-rewind'\n",
    )

    const remainingMessages = await service.getSessionMessages(sessionId)
    expect(remainingMessages).toHaveLength(0)
  })

  it('POST /api/sessions/:id/rewind should reject unsafe tracked paths before any partial restore', async () => {
    const sessionId = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeef'
    const workDir = path.join(tmpDir, 'linked-file-fixture')
    const outsideDir = path.join(tmpDir, 'outside-linked-file-fixture')
    const safeFile = path.join(workDir, 'safe.txt')
    const missingFile = path.join(workDir, 'missing.txt')
    const symlinkFile = path.join(workDir, 'symlink.txt')
    const linkedDir = path.join(workDir, 'linked-dir')
    const hardLinkFile = path.join(workDir, 'hard-link.txt')
    const hardLinkDeleteFile = path.join(workDir, 'hard-link-delete.txt')
    const outsideSafeFile = path.join(outsideDir, 'safe-absolute.txt')
    const outsideRelativeFile = path.join(outsideDir, 'relative-target.txt')
    const outsideSymlinkFile = path.join(outsideDir, 'symlink-target.txt')
    const outsideDeleteFile = path.join(outsideDir, 'delete-target.txt')
    const outsideHardLinkFile = path.join(outsideDir, 'hard-link-target.txt')
    const outsideHardLinkDeleteFile = path.join(outsideDir, 'hard-link-delete-target.txt')
    const userId = crypto.randomUUID()
    const safeBackup = 'linked-safe@v1'
    const missingBackup = 'linked-missing@v1'
    const outsideSafeBackup = 'linked-safe-absolute@v1'
    const outsideRelativeBackup = 'linked-relative@v1'
    const symlinkBackup = 'linked-symlink@v1'
    const hardLinkBackup = 'linked-hard-link@v1'

    await fs.mkdir(workDir, { recursive: true })
    await fs.mkdir(outsideDir, { recursive: true })
    await fs.writeFile(safeFile, 'safe after\n', 'utf-8')
    await fs.writeFile(outsideSafeFile, 'safe absolute after\n', 'utf-8')
    await fs.writeFile(outsideRelativeFile, 'relative outside after\n', 'utf-8')
    await fs.writeFile(outsideSymlinkFile, 'symlink outside after\n', 'utf-8')
    await fs.writeFile(outsideDeleteFile, 'delete outside after\n', 'utf-8')
    await fs.writeFile(outsideHardLinkFile, 'hard link outside after\n', 'utf-8')
    await fs.writeFile(outsideHardLinkDeleteFile, 'hard link delete outside after\n', 'utf-8')
    await fs.symlink(outsideSymlinkFile, symlinkFile)
    await fs.symlink(outsideDir, linkedDir)
    await fs.link(outsideHardLinkFile, hardLinkFile)
    await fs.link(outsideHardLinkDeleteFile, hardLinkDeleteFile)
    await writeFileHistoryBackup(sessionId, safeBackup, 'safe before\n')
    await writeFileHistoryBackup(sessionId, missingBackup, 'missing before\n')
    await writeFileHistoryBackup(sessionId, outsideSafeBackup, 'safe absolute before\n')
    await writeFileHistoryBackup(sessionId, outsideRelativeBackup, 'relative before\n')
    await writeFileHistoryBackup(sessionId, symlinkBackup, 'symlink before\n')
    await writeFileHistoryBackup(sessionId, hardLinkBackup, 'hard link before\n')

    await writeSessionFile('-tmp-api-linked-file', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(userId, {
        'safe.txt': {
          backupFileName: safeBackup,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
        'missing.txt': {
          backupFileName: missingBackup,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
        [outsideSafeFile]: {
          backupFileName: outsideSafeBackup,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
        '../outside-linked-file-fixture/relative-target.txt': {
          backupFileName: outsideRelativeBackup,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
        'symlink.txt': {
          backupFileName: symlinkBackup,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
        'linked-dir/delete-target.txt': {
          backupFileName: null,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
        'hard-link.txt': {
          backupFileName: hardLinkBackup,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
        'hard-link-delete.txt': {
          backupFileName: null,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('edit linked files', userId),
        cwd: workDir,
        sessionId,
      },
      makeAssistantEntry('DONE', userId),
    ])

    const previewRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessageIndex: 0, dryRun: true }),
    })
    expect(previewRes.status).toBe(200)
    const preview = await previewRes.json() as {
      code: { available: boolean; filesChanged: string[] }
      restoreAvailable?: boolean
    }
    expect(preview.code.filesChanged).toEqual([
      safeFile,
      missingFile,
      outsideSafeFile,
      outsideRelativeFile,
      symlinkFile,
      path.join(linkedDir, 'delete-target.txt'),
      hardLinkFile,
      hardLinkDeleteFile,
    ])
    expect(preview.restoreAvailable).toBe(false)

    const executeRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessageIndex: 0 }),
    })
    expect(executeRes.status).toBe(400)

    expect(await fs.readFile(safeFile, 'utf-8')).toBe('safe after\n')
    await expect(fs.stat(missingFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(outsideSafeFile, 'utf-8')).toBe('safe absolute after\n')
    expect(await fs.readFile(outsideRelativeFile, 'utf-8')).toBe(
      'relative outside after\n',
    )
    expect(await fs.readFile(outsideSymlinkFile, 'utf-8')).toBe('symlink outside after\n')
    expect(await fs.readFile(outsideDeleteFile, 'utf-8')).toBe('delete outside after\n')
    expect(await fs.readFile(outsideHardLinkFile, 'utf-8')).toBe('hard link outside after\n')
    expect(await fs.readFile(outsideHardLinkDeleteFile, 'utf-8')).toBe(
      'hard link delete outside after\n',
    )
    expect((await fs.lstat(symlinkFile)).isSymbolicLink()).toBe(true)
    expect((await fs.lstat(linkedDir)).isSymbolicLink()).toBe(true)
    expect((await fs.stat(hardLinkFile)).nlink).toBe(2)
    expect((await fs.stat(hardLinkDeleteFile)).nlink).toBe(2)
    expect((await service.getSessionMessages(sessionId)).map((message) => message.id))
      .toContain(userId)
  })

  it('POST /api/sessions/:id/rewind should resolve checkpoint paths from the target prompt cwd', async () => {
    const sessionId = 'bbbbbbbb-bbbb-cccc-dddd-ffffffffffff'
    const parentDir = path.join(tmpDir, 'nested-cwd-parent')
    const workDir = path.join(parentDir, 'testbb')
    const targetFile = path.join(workDir, 'vite.config.js')
    const userId = crypto.randomUUID()
    const assistantId = crypto.randomUUID()
    const laterUserId = crypto.randomUUID()
    const backupName = 'nested-cwd@v1'

    await fs.mkdir(workDir, { recursive: true })
    await fs.writeFile(targetFile, "export default 'after'\n", 'utf-8')
    await writeFileHistoryBackup(sessionId, backupName, "export default 'before'\n")

    await writeSessionFile(sanitizePath(parentDir), sessionId, [
      makeFileHistorySnapshotEntry(userId, {
        'testbb/vite.config.js': {
          backupFileName: backupName,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('create a nested project', userId),
        cwd: parentDir,
        sessionId,
      },
      {
        ...makeAssistantEntry('DONE', userId),
        uuid: assistantId,
      },
      {
        ...makeUserEntry('latest tool result after cd', laterUserId),
        cwd: workDir,
        sessionId,
      },
    ])

    const previewRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessageIndex: 0, dryRun: true }),
    })
    expect(previewRes.status).toBe(200)
    const preview = await previewRes.json() as {
      code: { available: boolean; filesChanged: string[] }
    }
    expect(preview.code.available).toBe(true)
    expect(preview.code.filesChanged).toEqual([targetFile])

    const executeRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessageIndex: 0 }),
    })
    expect(executeRes.status).toBe(200)
    expect(await fs.readFile(targetFile, 'utf-8')).toBe("export default 'before'\n")
  })

  it('POST /api/sessions/:id/rewind should restore multiple files and remove created files', async () => {
    const sessionId = 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee'
    const workDir = path.join(tmpDir, 'multi-file-fixture')
    const appFile = path.join(workDir, 'src', 'app.js')
    const readmeFile = path.join(workDir, 'README.md')
    const createdFile = path.join(workDir, 'notes', 'generated.txt')
    const userId = crypto.randomUUID()
    const backupApp = 'multi-app@v1'
    const backupReadme = 'multi-readme@v1'

    await fs.mkdir(path.dirname(appFile), { recursive: true })
    await fs.mkdir(path.dirname(createdFile), { recursive: true })
    await fs.writeFile(appFile, "export const VALUE = 'edited'\n", 'utf-8')
    await fs.writeFile(readmeFile, '# changed\n', 'utf-8')
    await fs.writeFile(createdFile, 'new file\n', 'utf-8')
    await writeFileHistoryBackup(sessionId, backupApp, "export const VALUE = 'original'\n")
    await writeFileHistoryBackup(sessionId, backupReadme, '# original\n')

    await writeSessionFile('-tmp-api-multi-file', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(userId, {
        'src/app.js': {
          backupFileName: backupApp,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
        'README.md': {
          backupFileName: backupReadme,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
        'notes/generated.txt': {
          backupFileName: null,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('edit multiple files', userId),
        cwd: workDir,
        sessionId,
      },
      makeAssistantEntry('DONE', userId),
    ])

    const previewRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessageIndex: 0, dryRun: true }),
    })
    expect(previewRes.status).toBe(200)
    const preview = await previewRes.json() as {
      code: { available: boolean; filesChanged: string[] }
    }
    expect(preview.code.available).toBe(true)
    expect(preview.code.filesChanged.sort()).toEqual([
      appFile,
      createdFile,
      readmeFile,
    ].sort())

    const executeRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessageIndex: 0 }),
    })
    expect(executeRes.status).toBe(200)

    expect(await fs.readFile(appFile, 'utf-8')).toBe("export const VALUE = 'original'\n")
    expect(await fs.readFile(readmeFile, 'utf-8')).toBe('# original\n')
    await expect(fs.stat(createdFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('POST /api/sessions/:id/rewind should restore the previous version when rewinding the second edit of the same file', async () => {
    const sessionId = 'dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee'
    const workDir = path.join(tmpDir, 'same-file-two-turns')
    const targetFile = path.join(workDir, 'src', 'app.js')
    const firstUserId = crypto.randomUUID()
    const secondUserId = crypto.randomUUID()
    const backupV1 = 'same-file@v1'
    const backupV2 = 'same-file@v2'

    await fs.mkdir(path.dirname(targetFile), { recursive: true })
    await fs.writeFile(targetFile, "export const STEP = 'v2'\n", 'utf-8')
    await writeFileHistoryBackup(sessionId, backupV1, "export const STEP = 'base'\n")
    await writeFileHistoryBackup(sessionId, backupV2, "export const STEP = 'v1'\n")

    await writeSessionFile('-tmp-api-two-turns', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(firstUserId, {
        'src/app.js': {
          backupFileName: backupV1,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('make v1', firstUserId),
        cwd: workDir,
        sessionId,
      },
      makeAssistantEntry('DONE', firstUserId),
      makeFileHistorySnapshotEntry(secondUserId, {
        'src/app.js': {
          backupFileName: backupV2,
          version: 2,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('make v2', secondUserId),
        cwd: workDir,
        sessionId,
      },
      makeAssistantEntry('DONE', secondUserId),
    ])

    const executeRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessageIndex: 1 }),
    })
    expect(executeRes.status).toBe(200)
    expect(await fs.readFile(targetFile, 'utf-8')).toBe("export const STEP = 'v1'\n")

    const remainingMessages = await service.getSessionMessages(sessionId)
    expect(remainingMessages.map((message) => message.id)).toHaveLength(2)
    expect(remainingMessages[0]?.id).toBe(firstUserId)
  })

  it('POST /api/sessions/:id/rewind should keep first-turn file state when undoing only the latest turn', async () => {
    const sessionId = 'dddddddd-bbbb-cccc-dddd-ffffffffffff'
    const workDir = path.join(tmpDir, 'two-turns-separate-files')
    const firstTurnFile = path.join(workDir, 'src', 'first.js')
    const secondTurnFile = path.join(workDir, 'src', 'second.js')
    const firstUserId = crypto.randomUUID()
    const secondUserId = crypto.randomUUID()
    const firstBaseBackup = 'separate-first@v1'
    const firstAfterTurnBackup = 'separate-first@v2'
    const secondBaseBackup = 'separate-second@v1'

    await fs.mkdir(path.dirname(firstTurnFile), { recursive: true })
    await fs.writeFile(firstTurnFile, "export const FIRST = 'v1'\n", 'utf-8')
    await fs.writeFile(secondTurnFile, "export const SECOND = 'v2'\n", 'utf-8')
    await writeFileHistoryBackup(sessionId, firstBaseBackup, "export const FIRST = 'base'\n")
    await writeFileHistoryBackup(sessionId, firstAfterTurnBackup, "export const FIRST = 'v1'\n")
    await writeFileHistoryBackup(sessionId, secondBaseBackup, "export const SECOND = 'base'\n")

    await writeSessionFile('-tmp-api-two-turns-separate-files', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(firstUserId, {
        'src/first.js': {
          backupFileName: firstBaseBackup,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('make first file v1', firstUserId),
        cwd: workDir,
        sessionId,
      },
      makeAssistantEntry('DONE first', firstUserId),
      makeFileHistorySnapshotEntry(secondUserId, {
        'src/first.js': {
          backupFileName: firstAfterTurnBackup,
          version: 2,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
        'src/second.js': {
          backupFileName: secondBaseBackup,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('make second file v2', secondUserId),
        cwd: workDir,
        sessionId,
      },
      makeAssistantEntry('DONE second', secondUserId),
    ])

    const previewRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessageIndex: 1, dryRun: true }),
    })
    expect(previewRes.status).toBe(200)
    const preview = await previewRes.json() as {
      code: { available: boolean; filesChanged: string[] }
    }
    expect(preview.code.available).toBe(true)
    expect(preview.code.filesChanged).toEqual([secondTurnFile])

    const executeRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessageIndex: 1 }),
    })
    expect(executeRes.status).toBe(200)

    expect(await fs.readFile(firstTurnFile, 'utf-8')).toBe("export const FIRST = 'v1'\n")
    expect(await fs.readFile(secondTurnFile, 'utf-8')).toBe("export const SECOND = 'base'\n")

    const remainingMessages = await service.getSessionMessages(sessionId)
    expect(remainingMessages).toHaveLength(2)
    expect(remainingMessages[0]?.id).toBe(firstUserId)
  })

  it('POST /api/sessions/:id/rewind should include files created after the first turn', async () => {
    const sessionId = 'eeeeeeee-bbbb-cccc-dddd-eeeeeeeeeeee'
    const workDir = path.join(tmpDir, 'created-on-second-turn')
    const firstFile = path.join(workDir, 'src', 'step.js')
    const createdFile = path.join(workDir, 'notes', 'generated.txt')
    const firstUserId = crypto.randomUUID()
    const secondUserId = crypto.randomUUID()
    const backupV1 = 'second-created-step@v1'
    const backupV2 = 'second-created-step@v2'

    await fs.mkdir(path.dirname(firstFile), { recursive: true })
    await fs.mkdir(path.dirname(createdFile), { recursive: true })
    await fs.writeFile(firstFile, "export const STEP = 'v2'\n", 'utf-8')
    await fs.writeFile(createdFile, 'generated\n', 'utf-8')
    await writeFileHistoryBackup(sessionId, backupV1, "export const STEP = 'base'\n")
    await writeFileHistoryBackup(sessionId, backupV2, "export const STEP = 'v1'\n")

    await writeSessionFile('-tmp-api-second-turn-created', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(firstUserId, {
        'src/step.js': {
          backupFileName: backupV1,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('make v1', firstUserId),
        cwd: workDir,
        sessionId,
      },
      makeAssistantEntry('DONE', firstUserId),
      makeFileHistorySnapshotEntry(secondUserId, {
        'src/step.js': {
          backupFileName: backupV2,
          version: 2,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
        'notes/generated.txt': {
          backupFileName: null,
          version: 2,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('make v2 and create file', secondUserId),
        cwd: workDir,
        sessionId,
      },
      makeAssistantEntry('DONE', secondUserId),
    ])

    const previewRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessageIndex: 1, dryRun: true }),
    })
    expect(previewRes.status).toBe(200)
    const preview = await previewRes.json() as {
      code: { available: boolean; filesChanged: string[]; insertions: number }
    }
    expect(preview.code.filesChanged.sort()).toEqual([
      createdFile,
      firstFile,
    ].sort())
    expect(preview.code.insertions).toBe(2)

    const executeRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessageIndex: 1 }),
    })
    expect(executeRes.status).toBe(200)
    expect(await fs.readFile(firstFile, 'utf-8')).toBe("export const STEP = 'v1'\n")
    await expect(fs.stat(createdFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('GET /api/sessions/:id/turn-checkpoints should list completed turn previews with turn-bound diff stats', async () => {
    const fixture = await createThreeTurnCheckpointFixture(
      '99999999-bbbb-cccc-dddd-eeeeeeeeeeee',
    )

    const res = await fetch(`${baseUrl}/api/sessions/${fixture.sessionId}/turn-checkpoints`)
    expect(res.status).toBe(200)

    const body = await res.json() as {
      checkpoints: Array<{
        target: {
          targetUserMessageId: string
          userMessageIndex: number
          userMessageCount: number
        }
        conversation: { messagesRemoved: number }
        code: {
          available: boolean
          filesChanged: string[]
          insertions: number
          deletions: number
        }
        workDir: string
      }>
    }

    expect(body.checkpoints).toHaveLength(3)
    expect(body.checkpoints).toEqual([
      {
        target: {
          targetUserMessageId: fixture.firstUserId,
          userMessageIndex: 0,
          userMessageCount: 3,
        },
        conversation: { messagesRemoved: 6 },
        code: {
          available: true,
          filesChanged: [fixture.stepFile],
          insertions: 1,
          deletions: 1,
        },
        workDir: fixture.workDir,
        restoreAvailable: true,
        unverifiedChangeSources: [],
      },
      {
        target: {
          targetUserMessageId: fixture.secondUserId,
          userMessageIndex: 1,
          userMessageCount: 3,
        },
        conversation: { messagesRemoved: 4 },
        code: {
          available: true,
          filesChanged: [fixture.stepFile],
          insertions: 1,
          deletions: 1,
        },
        workDir: fixture.workDir,
        restoreAvailable: true,
        unverifiedChangeSources: [],
      },
      {
        target: {
          targetUserMessageId: fixture.thirdUserId,
          userMessageIndex: 2,
          userMessageCount: 3,
        },
        conversation: { messagesRemoved: 2 },
        code: {
          available: true,
          filesChanged: [fixture.stepFile, fixture.createdFile],
          insertions: 2,
          deletions: 1,
        },
        workDir: fixture.workDir,
        restoreAvailable: true,
        unverifiedChangeSources: [],
      },
    ])
  })

  it('GET /api/sessions/:id/turn-checkpoints should reuse the loaded transcript cwd for every turn', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-000000000021'
    const projectDir = '-tmp-long-turn-checkpoint-session'
    const workDir = path.join(tmpDir, 'long-turn-checkpoint-session')
    const turnCount = 200
    const entries: Record<string, unknown>[] = [makeSessionMetaEntry(workDir)]

    await fs.mkdir(workDir, { recursive: true })
    for (let index = 0; index < turnCount; index += 1) {
      const userId = crypto.randomUUID()
      const toolUseId = `Write:long-turn-${index}`
      entries.push(
        {
          ...makeUserEntry(`write turn ${index}`, userId),
          cwd: workDir,
          sessionId,
        },
        {
          ...makeAssistantToolUseEntry([{
            id: toolUseId,
            name: 'Write',
            input: {
              file_path: path.join(workDir, `turn-${index}.ts`),
              content: `export const turn = ${index}\n`,
            },
          }], userId),
          cwd: workDir,
          sessionId,
        },
        {
          ...makeToolResultUserEntry(
            toolUseId,
            'Written successfully.',
            undefined,
            undefined,
            sessionId,
          ),
          cwd: workDir,
        },
      )
    }
    await writeSessionFile(projectDir, sessionId, entries)

    const messagesSpy = spyOn(sessionService, 'getSessionMessagesWithEvidence')
    const messageCwdSpy = spyOn(sessionService, 'getSessionMessageCwd')
    try {
      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn-checkpoints`)
      expect(res.status).toBe(200)
      const body = await res.json() as { checkpoints: unknown[] }

      expect(body.checkpoints).toHaveLength(turnCount)
      expect(messagesSpy).toHaveBeenCalledTimes(1)
      expect(messageCwdSpy).not.toHaveBeenCalled()
    } finally {
      messagesSpy.mockRestore()
      messageCwdSpy.mockRestore()
    }
  })

  it('GET /api/sessions/:id/turn-checkpoints should keep an available empty preview for an unchanged snapshot-backed turn', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-000000000005'
    const workDir = path.join(tmpDir, 'unchanged-snapshot-session')
    const targetFile = path.join(workDir, 'src', 'unchanged.ts')
    const userId = crypto.randomUUID()
    const backupName = 'unchanged-snapshot@v1'
    const content = 'export const unchanged = true\n'

    await fs.mkdir(path.dirname(targetFile), { recursive: true })
    await fs.writeFile(targetFile, content, 'utf-8')
    await writeFileHistoryBackup(sessionId, backupName, content)
    await writeSessionFile('-tmp-unchanged-snapshot-session', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(userId, {
        'src/unchanged.ts': {
          backupFileName: backupName,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('inspect the project', userId),
        cwd: workDir,
        sessionId,
      },
      makeAssistantEntry('No files needed changes.', userId),
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn-checkpoints`)
    expect(res.status).toBe(200)
    const body = await res.json() as {
      checkpoints: Array<{
        target: { targetUserMessageId: string }
        code: {
          available: boolean
          filesChanged: string[]
          insertions: number
          deletions: number
        }
      }>
    }

    expect(body.checkpoints).toHaveLength(1)
    expect(body.checkpoints[0]).toMatchObject({
      target: { targetUserMessageId: userId },
      code: {
        available: true,
        filesChanged: [],
        insertions: 0,
        deletions: 0,
      },
    })
  })

  it('GET /api/sessions/:id/turn-checkpoints should retain transcript changes when the snapshot diff is empty', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-000000000006'
    const workDir = path.join(tmpDir, 'empty-snapshot-transcript-session')
    const unchangedFile = path.join(workDir, 'src', 'unchanged.ts')
    const transcriptFile = path.join(workDir, 'test123.md')
    const userId = crypto.randomUUID()
    const backupName = 'empty-snapshot-transcript@v1'
    const content = 'export const unchanged = true\n'

    await fs.mkdir(path.dirname(unchangedFile), { recursive: true })
    await fs.writeFile(unchangedFile, content, 'utf-8')
    await writeFileHistoryBackup(sessionId, backupName, content)
    await writeSessionFile('-tmp-empty-snapshot-transcript-session', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(userId, {
        'src/unchanged.ts': {
          backupFileName: backupName,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('write a short note', userId),
        cwd: workDir,
        sessionId,
      },
      makeAssistantToolUseEntry([{
        id: 'Write:empty-snapshot-fallback',
        name: 'Write',
        input: {
          file_path: transcriptFile,
          content: '# Notes\n',
        },
      }], userId),
      makeToolResultUserEntry(
        'Write:empty-snapshot-fallback',
        `The file ${transcriptFile} has been written successfully.`,
        undefined,
        undefined,
        sessionId,
      ),
      makeAssistantEntry('Note written.', userId),
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn-checkpoints`)
    expect(res.status).toBe(200)
    const body = await res.json() as {
      checkpoints: Array<{
        code: {
          available: boolean
          filesChanged: string[]
          insertions: number
          deletions: number
        }
      }>
    }

    expect(body.checkpoints).toHaveLength(1)
    expect(body.checkpoints[0]!.code).toEqual({
      available: true,
      filesChanged: [transcriptFile],
      insertions: 1,
      deletions: 0,
    })
  })

  it('GET /api/sessions/:id/turn-checkpoints should merge successful transcript edits missing from a partial snapshot', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-000000000007'
    const workDir = path.join(tmpDir, 'partial-snapshot-transcript-session')
    const capturedFile = path.join(workDir, 'src', 'captured.ts')
    const missedFile = path.join(workDir, 'src', 'missed.ts')
    const userId = crypto.randomUUID()
    const backupName = 'partial-snapshot-captured@v1'
    const capturedBefore = "export const captured = 'before'\n"
    const capturedAfter = "export const captured = 'after'\n"
    const missedBefore = "export const missed = 'before'\n"
    const missedAfter = "export const missed = 'after'\n"

    await fs.mkdir(path.dirname(capturedFile), { recursive: true })
    await fs.writeFile(capturedFile, capturedAfter, 'utf-8')
    await fs.writeFile(missedFile, missedAfter, 'utf-8')
    await writeFileHistoryBackup(sessionId, backupName, capturedBefore)
    await writeSessionFile('-tmp-partial-snapshot-transcript-session', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(userId, {
        'src/captured.ts': {
          backupFileName: backupName,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('update both files', userId),
        cwd: workDir,
        sessionId,
      },
      makeAssistantToolUseEntry([
        {
          id: 'Edit:captured-by-snapshot',
          name: 'Edit',
          input: {
            file_path: capturedFile,
            old_string: capturedBefore.trim(),
            new_string: capturedAfter.trim(),
          },
        },
        {
          id: 'Edit:missing-from-snapshot',
          name: 'Edit',
          input: {
            file_path: missedFile,
            old_string: missedBefore.trim(),
            new_string: missedAfter.trim(),
          },
        },
      ], userId),
      makeToolResultUserEntry(
        'Edit:captured-by-snapshot',
        `The file ${capturedFile} has been updated successfully.`,
        undefined,
        undefined,
        sessionId,
      ),
      makeToolResultUserEntry(
        'Edit:missing-from-snapshot',
        `The file ${missedFile} has been updated successfully.`,
        undefined,
        undefined,
        sessionId,
      ),
      makeAssistantEntry('Both files updated.', userId),
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn-checkpoints`)
    expect(res.status).toBe(200)
    const body = await res.json() as {
      checkpoints: Array<{
        code: {
          available: boolean
          filesChanged: string[]
          insertions: number
          deletions: number
        }
      }>
    }

    expect(body.checkpoints).toHaveLength(1)
    expect(body.checkpoints[0]!.code).toEqual({
      available: true,
      filesChanged: [capturedFile, missedFile],
      insertions: 2,
      deletions: 2,
    })

    const dryRunRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserMessageId: userId, dryRun: true }),
    })
    expect(dryRunRes.status).toBe(200)
    expect(await dryRunRes.json()).toMatchObject({
      code: {
        filesChanged: [capturedFile, missedFile],
        insertions: 2,
        deletions: 2,
      },
      restoreAvailable: false,
    })
  })

  it('GET /api/sessions/:id/turn-checkpoints should include a successful external edit missing from a partial snapshot', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-000000000008'
    const workDir = path.join(tmpDir, 'partial-snapshot-external-session')
    const outsideDir = path.join(tmpDir, 'partial-snapshot-external-target')
    const capturedFile = path.join(workDir, 'captured.ts')
    const externalFile = path.join(outsideDir, 'external.ts')
    const userId = crypto.randomUUID()
    const backupName = 'partial-snapshot-external@v1'
    const capturedBefore = "export const captured = 'before'\n"
    const capturedAfter = "export const captured = 'after'\n"
    const externalBefore = "export const external = 'before'\n"
    const externalAfter = "export const external = 'after'\n"

    await fs.mkdir(workDir, { recursive: true })
    await fs.mkdir(outsideDir, { recursive: true })
    await fs.writeFile(capturedFile, capturedAfter, 'utf-8')
    await fs.writeFile(externalFile, externalAfter, 'utf-8')
    await writeFileHistoryBackup(sessionId, backupName, capturedBefore)
    await writeSessionFile('-tmp-partial-snapshot-external-session', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(userId, {
        'captured.ts': {
          backupFileName: backupName,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('update an internal and external file', userId),
        cwd: workDir,
        sessionId,
      },
      makeAssistantToolUseEntry([
        {
          id: 'Edit:captured-external-case',
          name: 'Edit',
          input: {
            file_path: capturedFile,
            old_string: capturedBefore.trim(),
            new_string: capturedAfter.trim(),
          },
        },
        {
          id: 'Edit:external-missing-from-snapshot',
          name: 'Edit',
          input: {
            file_path: externalFile,
            old_string: externalBefore.trim(),
            new_string: externalAfter.trim(),
          },
        },
      ], userId),
      makeToolResultUserEntry(
        'Edit:captured-external-case',
        `The file ${capturedFile} has been updated successfully.`,
        undefined,
        undefined,
        sessionId,
      ),
      makeToolResultUserEntry(
        'Edit:external-missing-from-snapshot',
        `The file ${externalFile} has been updated successfully.`,
        undefined,
        undefined,
        sessionId,
      ),
      makeAssistantEntry('Both files updated.', userId),
    ])

    const checkpointsRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn-checkpoints`)
    expect(checkpointsRes.status).toBe(200)
    const checkpointsBody = await checkpointsRes.json() as {
      checkpoints: Array<{
        code: { filesChanged: string[]; insertions: number; deletions: number }
        restoreAvailable?: boolean
      }>
    }
    expect(checkpointsBody.checkpoints).toHaveLength(1)
    expect(checkpointsBody.checkpoints[0]).toMatchObject({
      code: {
        filesChanged: [capturedFile, externalFile],
        insertions: 2,
        deletions: 2,
      },
      restoreAvailable: false,
    })

    const dryRunRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserMessageId: userId, dryRun: true }),
    })
    expect(dryRunRes.status).toBe(200)
    expect(await dryRunRes.json()).toMatchObject({
      code: { filesChanged: [capturedFile, externalFile] },
      restoreAvailable: false,
    })

    const rewindRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserMessageId: userId }),
    })
    expect(rewindRes.status).toBe(400)
    expect(await fs.readFile(capturedFile, 'utf-8')).toBe(capturedAfter)
    expect(await fs.readFile(externalFile, 'utf-8')).toBe(externalAfter)
    expect((await service.getSessionMessages(sessionId)).map((message) => message.id))
      .toContain(userId)
  })

  it('GET /api/sessions/:id/turn-checkpoints should not treat a next-turn backup as a restorable target snapshot', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-000000000015'
    const workDir = path.join(tmpDir, 'historical-partial-snapshot-session')
    const capturedFile = path.join(workDir, 'captured.ts')
    const missedFile = path.join(workDir, 'missed.ts')
    const firstUserId = crypto.randomUUID()
    const secondUserId = crypto.randomUUID()
    const capturedBeforeBackup = 'historical-captured-before@v1'
    const capturedAfterBackup = 'historical-captured-after@v2'
    const missedAfterBackup = 'historical-missed-after@v1'
    const before = "export const value = 'before'\n"
    const after = "export const value = 'after'\n"

    await fs.mkdir(workDir, { recursive: true })
    await fs.writeFile(capturedFile, after, 'utf-8')
    await fs.writeFile(missedFile, after, 'utf-8')
    await writeFileHistoryBackup(sessionId, capturedBeforeBackup, before)
    await writeFileHistoryBackup(sessionId, capturedAfterBackup, after)
    await writeFileHistoryBackup(sessionId, missedAfterBackup, after)
    await writeSessionFile('-tmp-historical-partial-snapshot-session', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(firstUserId, {
        'captured.ts': {
          backupFileName: capturedBeforeBackup,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('update both files', firstUserId),
        cwd: workDir,
        sessionId,
      },
      makeAssistantToolUseEntry([
        {
          id: 'Edit:historical-captured',
          name: 'Edit',
          input: {
            file_path: capturedFile,
            old_string: before.trim(),
            new_string: after.trim(),
          },
        },
        {
          id: 'Edit:historical-missed',
          name: 'Edit',
          input: {
            file_path: missedFile,
            old_string: before.trim(),
            new_string: after.trim(),
          },
        },
      ], firstUserId),
      makeToolResultUserEntry(
        'Edit:historical-captured',
        'Updated successfully.',
        undefined,
        undefined,
        sessionId,
      ),
      makeToolResultUserEntry(
        'Edit:historical-missed',
        'Updated successfully.',
        undefined,
        undefined,
        sessionId,
      ),
      makeAssistantEntry('First turn complete.', firstUserId),
      makeFileHistorySnapshotEntry(secondUserId, {
        'captured.ts': {
          backupFileName: capturedAfterBackup,
          version: 2,
          backupTime: '2026-01-01T00:01:00.000Z',
        },
        'missed.ts': {
          backupFileName: missedAfterBackup,
          version: 1,
          backupTime: '2026-01-01T00:01:00.000Z',
        },
      }),
      {
        ...makeUserEntry('inspect the result', secondUserId),
        cwd: workDir,
        sessionId,
      },
      makeAssistantEntry('Second turn complete.', secondUserId),
    ])

    const checkpointsRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn-checkpoints`)
    expect(checkpointsRes.status).toBe(200)
    const checkpointsBody = await checkpointsRes.json() as {
      checkpoints: Array<{
        target: { targetUserMessageId: string }
        code: { filesChanged: string[] }
        restoreAvailable?: boolean
      }>
    }
    const firstCheckpoint = checkpointsBody.checkpoints.find(
      (checkpoint) => checkpoint.target.targetUserMessageId === firstUserId,
    )
    expect(firstCheckpoint).toMatchObject({
      code: { filesChanged: [capturedFile, missedFile] },
      restoreAvailable: false,
    })

    const rewindRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserMessageId: firstUserId }),
    })
    expect(rewindRes.status).toBe(400)
    expect(await fs.readFile(capturedFile, 'utf-8')).toBe(after)
    expect(await fs.readFile(missedFile, 'utf-8')).toBe(after)
    expect((await service.getSessionMessages(sessionId)).map((message) => message.id))
      .toContain(firstUserId)
  })

  it('GET /api/sessions/:id/turn-checkpoints should not restore a snapshot-covered zero-net file from transcript edits', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-000000000009'
    const workDir = path.join(tmpDir, 'snapshot-covered-zero-net-session')
    const changedFile = path.join(workDir, 'changed.ts')
    const restoredFile = path.join(workDir, 'restored.ts')
    const userId = crypto.randomUUID()
    const changedBackup = 'snapshot-covered-changed@v1'
    const restoredBackup = 'snapshot-covered-restored@v1'
    const changedBefore = "export const changed = 'before'\n"
    const changedAfter = "export const changed = 'after'\n"
    const restoredContent = "export const restored = 'original'\n"
    const restoredIntermediate = "export const restored = 'temporary'\n"

    await fs.mkdir(workDir, { recursive: true })
    await fs.writeFile(changedFile, changedAfter, 'utf-8')
    await fs.writeFile(restoredFile, restoredContent, 'utf-8')
    await writeFileHistoryBackup(sessionId, changedBackup, changedBefore)
    await writeFileHistoryBackup(sessionId, restoredBackup, restoredContent)
    await writeSessionFile('-tmp-snapshot-covered-zero-net-session', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(userId, {
        'changed.ts': {
          backupFileName: changedBackup,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
        'restored.ts': {
          backupFileName: restoredBackup,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('change one file and restore another', userId),
        cwd: workDir,
        sessionId,
      },
      makeAssistantToolUseEntry([
        {
          id: 'Edit:changed-net',
          name: 'Edit',
          input: {
            file_path: changedFile,
            old_string: changedBefore.trim(),
            new_string: changedAfter.trim(),
          },
        },
        {
          id: 'Edit:restored-forward',
          name: 'Edit',
          input: {
            file_path: restoredFile,
            old_string: restoredContent.trim(),
            new_string: restoredIntermediate.trim(),
          },
        },
        {
          id: 'Edit:restored-back',
          name: 'Edit',
          input: {
            file_path: restoredFile,
            old_string: restoredIntermediate.trim(),
            new_string: restoredContent.trim(),
          },
        },
      ], userId),
      makeToolResultUserEntry('Edit:changed-net', 'Updated successfully.', undefined, undefined, sessionId),
      makeToolResultUserEntry('Edit:restored-forward', 'Updated successfully.', undefined, undefined, sessionId),
      makeToolResultUserEntry('Edit:restored-back', 'Updated successfully.', undefined, undefined, sessionId),
      makeAssistantEntry('Finished.', userId),
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn-checkpoints`)
    expect(res.status).toBe(200)
    const body = await res.json() as {
      checkpoints: Array<{
        code: { filesChanged: string[]; insertions: number; deletions: number }
        restoreAvailable?: boolean
      }>
    }
    expect(body.checkpoints).toHaveLength(1)
    expect(body.checkpoints[0]).toMatchObject({
      code: {
        filesChanged: [changedFile],
        insertions: 1,
        deletions: 1,
      },
      restoreAvailable: true,
    })
  })

  it('GET /api/sessions/:id/turn-checkpoints should ignore transcript edits without a completed tool result', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-000000000010'
    const workDir = path.join(tmpDir, 'partial-snapshot-incomplete-tool-session')
    const capturedFile = path.join(workDir, 'captured.ts')
    const interruptedFile = path.join(workDir, 'interrupted.ts')
    const userId = crypto.randomUUID()
    const backupName = 'partial-snapshot-incomplete-tool@v1'
    const before = "export const value = 'before'\n"
    const after = "export const value = 'after'\n"

    await fs.mkdir(workDir, { recursive: true })
    await fs.writeFile(capturedFile, after, 'utf-8')
    await writeFileHistoryBackup(sessionId, backupName, before)
    await writeSessionFile('-tmp-partial-snapshot-incomplete-tool-session', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(userId, {
        'captured.ts': {
          backupFileName: backupName,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('update two files before interruption', userId),
        cwd: workDir,
        sessionId,
      },
      makeAssistantToolUseEntry([
        {
          id: 'Edit:captured-complete',
          name: 'Edit',
          input: {
            file_path: capturedFile,
            old_string: before.trim(),
            new_string: after.trim(),
          },
        },
        {
          id: 'Edit:interrupted-without-result',
          name: 'Edit',
          input: {
            file_path: interruptedFile,
            old_string: before.trim(),
            new_string: after.trim(),
          },
        },
      ], userId),
      makeToolResultUserEntry(
        'Edit:captured-complete',
        'Updated successfully.',
        undefined,
        undefined,
        sessionId,
      ),
      makeAssistantEntry('The second edit was interrupted.', userId),
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn-checkpoints`)
    expect(res.status).toBe(200)
    const body = await res.json() as {
      checkpoints: Array<{ code: { filesChanged: string[] }; restoreAvailable?: boolean }>
    }
    expect(body.checkpoints).toHaveLength(1)
    expect(body.checkpoints[0]).toMatchObject({
      code: { filesChanged: [capturedFile] },
      restoreAvailable: false,
    })

    const rewindRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserMessageId: userId }),
    })
    expect(rewindRes.status).toBe(400)
    expect(await fs.readFile(capturedFile, 'utf-8')).toBe(after)
    expect((await service.getSessionMessages(sessionId)).map((message) => message.id))
      .toContain(userId)
  })

  it('POST /api/sessions/:id/rewind should recheck late tool output after stopping the runtime', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-000000000017'
    const workDir = path.join(tmpDir, 'rewind-stop-recheck-session')
    const capturedFile = path.join(workDir, 'captured.ts')
    const lateFile = path.join(workDir, 'late.ts')
    const userId = crypto.randomUUID()
    const backupName = 'rewind-stop-recheck@v1'
    const before = "export const value = 'before'\n"
    const after = "export const value = 'after'\n"

    await fs.mkdir(workDir, { recursive: true })
    await fs.writeFile(capturedFile, after, 'utf-8')
    await writeFileHistoryBackup(sessionId, backupName, before)
    const transcriptPath = await writeSessionFile('-tmp-rewind-stop-recheck-session', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(userId, {
        'captured.ts': {
          backupFileName: backupName,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('update files', userId),
        cwd: workDir,
        sessionId,
      },
      makeAssistantEntry('Initial response complete.', userId),
    ])

    const originalStopSessionAndWait = conversationService.stopSessionAndWait
    conversationService.stopSessionAndWait = async (targetSessionId: string) => {
      if (targetSessionId !== sessionId) return
      await fs.writeFile(lateFile, after, 'utf-8')
      const lateEntries = [
        {
          ...makeAssistantToolUseEntry([{
            id: 'Write:late-after-stop-started',
            name: 'Write',
            input: { file_path: lateFile, content: after },
          }], userId),
          cwd: workDir,
        },
        {
          ...makeToolResultUserEntry(
            'Write:late-after-stop-started',
            'Written successfully.',
            undefined,
            undefined,
            sessionId,
          ),
          cwd: workDir,
        },
      ]
      await fs.appendFile(
        transcriptPath,
        lateEntries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
        'utf-8',
      )
    }

    try {
      const rewindRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUserMessageId: userId }),
      })
      expect(rewindRes.status).toBe(400)
      expect(await fs.readFile(capturedFile, 'utf-8')).toBe(after)
      expect(await fs.readFile(lateFile, 'utf-8')).toBe(after)
      expect((await service.getSessionMessages(sessionId)).map((message) => message.id))
        .toContain(userId)
    } finally {
      conversationService.stopSessionAndWait = originalStopSessionAndWait
    }
  })

  it('GET /api/sessions/:id/turn-checkpoints should deduplicate snapshot and transcript aliases by canonical path', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-000000000011'
    const workDir = path.join(tmpDir, 'snapshot-transcript-alias-session')
    const aliasDir = path.join(tmpDir, 'snapshot-transcript-alias-link')
    const targetFile = path.join(workDir, 'src', 'aliased.ts')
    const aliasFile = path.join(aliasDir, 'src', 'aliased.ts')
    const userId = crypto.randomUUID()
    const backupName = 'snapshot-transcript-alias@v1'
    const before = "export const alias = 'before'\n"
    const after = "export const alias = 'after'\n"

    await fs.mkdir(path.dirname(targetFile), { recursive: true })
    await fs.writeFile(targetFile, after, 'utf-8')
    await fs.symlink(workDir, aliasDir, 'dir')
    await writeFileHistoryBackup(sessionId, backupName, before)
    await writeSessionFile('-tmp-snapshot-transcript-alias-session', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(userId, {
        'src/aliased.ts': {
          backupFileName: backupName,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
        'src/../src/aliased.ts': {
          backupFileName: backupName,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('edit a file through an alias', userId),
        cwd: workDir,
        sessionId,
      },
      makeAssistantToolUseEntry([{
        id: 'Edit:canonical-alias',
        name: 'Edit',
        input: {
          file_path: aliasFile,
          old_string: before.trim(),
          new_string: after.trim(),
        },
      }], userId),
      makeToolResultUserEntry(
        'Edit:canonical-alias',
        'Updated successfully.',
        undefined,
        undefined,
        sessionId,
      ),
      makeAssistantEntry('Finished.', userId),
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn-checkpoints`)
    expect(res.status).toBe(200)
    const body = await res.json() as {
      checkpoints: Array<{
        code: { filesChanged: string[]; insertions: number; deletions: number }
        restoreAvailable?: boolean
      }>
    }
    expect(body.checkpoints).toHaveLength(1)
    expect(body.checkpoints[0]).toMatchObject({
      code: {
        filesChanged: [targetFile],
        insertions: 1,
        deletions: 1,
      },
      restoreAvailable: true,
    })
  })

  it('GET /api/sessions/:id/turn-checkpoints should resolve relative tool paths from the tool message cwd', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-000000000012'
    const workDir = path.join(tmpDir, 'transcript-tool-cwd-session')
    const toolCwd = path.join(workDir, 'MyDemo')
    const targetFile = path.join(toolCwd, 'src', 'App.ts')
    const userId = crypto.randomUUID()

    await fs.mkdir(path.dirname(targetFile), { recursive: true })
    await fs.writeFile(targetFile, 'export const app = true\n', 'utf-8')
    await writeSessionFile('-tmp-transcript-tool-cwd-session', sessionId, [
      makeSessionMetaEntry(workDir),
      {
        ...makeUserEntry('create a nested app file', userId),
        cwd: workDir,
        sessionId,
      },
      {
        ...makeAssistantToolUseEntry([{
          id: 'Write:tool-message-cwd',
          name: 'Write',
          input: {
            file_path: 'src/App.ts',
            content: 'export const app = true\n',
          },
        }], userId),
        cwd: toolCwd,
      },
      makeToolResultUserEntry(
        'Write:tool-message-cwd',
        'Written successfully.',
        undefined,
        undefined,
        sessionId,
      ),
      makeAssistantEntry('Finished.', userId),
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn-checkpoints`)
    expect(res.status).toBe(200)
    const body = await res.json() as {
      checkpoints: Array<{
        code: { filesChanged: string[] }
        restoreAvailable?: boolean
      }>
    }
    expect(body.checkpoints).toHaveLength(1)
    expect(body.checkpoints[0]).toMatchObject({
      code: { filesChanged: [targetFile] },
      restoreAvailable: false,
    })
  })

  it('GET /api/sessions/:id/turn-checkpoints should collect every supported successful file tool', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-000000000014'
    const workDir = path.join(tmpDir, 'transcript-supported-tools-session')
    const writeFile = path.join(workDir, 'write.txt')
    const multiEditFile = path.join(workDir, 'multi.ts')
    const notebookFile = path.join(workDir, 'notes.ipynb')
    const patchSourceFile = path.join(workDir, 'old-name.ts')
    const patchTargetFile = path.join(workDir, 'new-name.ts')
    const outsideFile = path.join(tmpDir, 'transcript-supported-tools-outside.txt')
    const userId = crypto.randomUUID()

    await fs.mkdir(workDir, { recursive: true })
    await fs.writeFile(writeFile, 'written\n', 'utf-8')
    await fs.writeFile(multiEditFile, 'const value = 2\n', 'utf-8')
    await fs.writeFile(notebookFile, '{"cells": []}\n', 'utf-8')
    await fs.writeFile(patchTargetFile, 'export const renamed = true\n', 'utf-8')
    await fs.writeFile(outsideFile, 'outside\n', 'utf-8')
    await writeSessionFile('-tmp-transcript-supported-tools-session', sessionId, [
      makeSessionMetaEntry(workDir),
      {
        ...makeUserEntry('exercise every file editing tool', userId),
        cwd: workDir,
        sessionId,
      },
      {
        ...makeAssistantToolUseEntry([
          {
            id: 'Write:supported',
            name: 'Write',
            input: { file_path: writeFile, content: 'written\n' },
          },
          {
            id: 'MultiEdit:supported',
            name: 'MultiEdit',
            input: {
              file_path: multiEditFile,
              edits: [{ old_string: 'const value = 1', new_string: 'const value = 2' }],
            },
          },
          {
            id: 'NotebookEdit:supported',
            name: 'NotebookEdit',
            input: { notebook_path: notebookFile, new_source: 'print("done")' },
          },
          {
            id: 'ApplyPatch:supported',
            name: 'apply_patch',
            input: {
              patch: [
                '*** Begin Patch',
                '*** Update File: old-name.ts',
                '*** Move to: new-name.ts',
                '*** End Patch',
              ].join('\n'),
            },
          },
          {
            id: 'Write:relative-outside',
            name: 'Write',
            input: {
              file_path: path.relative(workDir, outsideFile),
              content: 'outside\n',
            },
          },
        ], userId),
        cwd: workDir,
      },
      makeToolResultUserEntry('Write:supported', 'Written successfully.', undefined, undefined, sessionId),
      makeToolResultUserEntry('MultiEdit:supported', 'Updated successfully.', undefined, undefined, sessionId),
      makeToolResultUserEntry('NotebookEdit:supported', 'Updated successfully.', undefined, undefined, sessionId),
      makeToolResultUserEntry('ApplyPatch:supported', 'Patched successfully.', undefined, undefined, sessionId),
      makeToolResultUserEntry('Write:relative-outside', 'Written successfully.', undefined, undefined, sessionId),
      makeAssistantEntry('Finished.', userId),
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn-checkpoints`)
    expect(res.status).toBe(200)
    const body = await res.json() as {
      checkpoints: Array<{ code: { filesChanged: string[] }; restoreAvailable?: boolean }>
    }
    expect(body.checkpoints).toHaveLength(1)
    expect(body.checkpoints[0]!.code.filesChanged.sort()).toEqual([
      writeFile,
      multiEditFile,
      notebookFile,
      patchSourceFile,
      patchTargetFile,
      outsideFile,
    ].sort())
    expect(body.checkpoints[0]!.restoreAvailable).toBe(false)
  })

  it('GET /api/sessions/:id/turn-checkpoints/diff should return target-bound checkpoint diffs', async () => {
    const fixture = await createThreeTurnCheckpointFixture(
      '99999999-bbbb-cccc-dddd-ffffffffffff',
    )

    const secondTurnRes = await fetch(
      `${baseUrl}/api/sessions/${fixture.sessionId}/turn-checkpoints/diff?targetUserMessageId=${fixture.secondUserId}&path=src/step.js`,
    )
    expect(secondTurnRes.status).toBe(200)
    const secondTurnBody = await secondTurnRes.json() as {
      state: string
      path: string
      diff?: string
      target: { targetUserMessageId: string }
    }
    expect(secondTurnBody.target.targetUserMessageId).toBe(fixture.secondUserId)
    expect(secondTurnBody.state).toBe('ok')
    expect(secondTurnBody.path).toBe('src/step.js')
    expect(secondTurnBody.diff).toContain("export const STEP = 'v2'")
    expect(secondTurnBody.diff).toContain("export const STEP = 'v1'")
    expect(secondTurnBody.diff).not.toContain("export const STEP = 'v3'")

    const thirdTurnRes = await fetch(
      `${baseUrl}/api/sessions/${fixture.sessionId}/turn-checkpoints/diff?targetUserMessageId=${fixture.thirdUserId}&path=src/step.js`,
    )
    expect(thirdTurnRes.status).toBe(200)
    const thirdTurnBody = await thirdTurnRes.json() as {
      state: string
      diff?: string
      target: { targetUserMessageId: string }
    }
    expect(thirdTurnBody.target.targetUserMessageId).toBe(fixture.thirdUserId)
    expect(thirdTurnBody.state).toBe('ok')
    expect(thirdTurnBody.diff).toContain("export const STEP = 'v3'")
    expect(thirdTurnBody.diff).toContain("export const STEP = 'v2'")
    expect(thirdTurnBody.diff).not.toContain("export const STEP = 'v1'")

    const createdFileRes = await fetch(
      `${baseUrl}/api/sessions/${fixture.sessionId}/turn-checkpoints/diff?targetUserMessageId=${fixture.thirdUserId}&path=notes/generated.txt`,
    )
    expect(createdFileRes.status).toBe(200)
    const createdFileBody = await createdFileRes.json() as {
      state: string
      diff?: string
    }
    expect(createdFileBody.state).toBe('ok')
    expect(createdFileBody.diff).toContain('generated third turn')
    expect(createdFileBody.diff).toContain('/dev/null')
  })

  it('GET /api/sessions/:id/turn-checkpoints should fall back to transcript tool changes when file snapshots are missing', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-000000000001'
    const workDir = path.join(tmpDir, 'transcript-only-session')
    const userId = crypto.randomUUID()
    await fs.mkdir(path.join(workDir, 'todo-app', 'src'), { recursive: true })

    await writeSessionFile('-tmp-transcript-only-session', sessionId, [
      makeSessionMetaEntry(workDir),
      {
        ...makeUserEntry('build a todo app', userId),
        cwd: workDir,
        sessionId,
      },
      makeAssistantToolUseEntry([
        {
          id: 'Write:1',
          name: 'Write',
          input: {
            file_path: path.join(workDir, 'todo-app', 'src', 'App.tsx'),
            content: 'export function App() {\n  return <main>Todo</main>\n}\n',
          },
        },
        {
          id: 'Write:2',
          name: 'Write',
          input: {
            file_path: 'todo-app/vite.config.ts',
            content: 'import { defineConfig } from "vite"\nexport default defineConfig({})\n',
          },
        },
      ], userId),
      makeToolResultUserEntry(
        'Write:1',
        'The file App.tsx has been written successfully.',
        undefined,
        undefined,
        sessionId,
      ),
      makeToolResultUserEntry(
        'Write:2',
        'The file vite.config.ts has been written successfully.',
        undefined,
        undefined,
        sessionId,
      ),
      makeAssistantEntry('Todo app created', userId),
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn-checkpoints`)
    expect(res.status).toBe(200)
    const body = await res.json() as {
      checkpoints: Array<{
        target: { targetUserMessageId: string }
        code: {
          available: boolean
          filesChanged: string[]
          insertions: number
          deletions: number
        }
        workDir: string
      }>
    }

    expect(body.checkpoints).toHaveLength(1)
    expect(body.checkpoints[0]!.target.targetUserMessageId).toBe(userId)
    expect(body.checkpoints[0]!.workDir).toBe(workDir)
    expect(body.checkpoints[0]!.code.available).toBe(true)
    expect(body.checkpoints[0]!.code.filesChanged.sort()).toEqual([
      path.join(workDir, 'todo-app', 'src', 'App.tsx'),
      path.join(workDir, 'todo-app', 'vite.config.ts'),
    ].sort())
    expect(body.checkpoints[0]!.code.insertions).toBe(5)
    expect(body.checkpoints[0]!.code.deletions).toBe(0)
  })

  it('GET /api/sessions/:id/turn-checkpoints should ignore rejected transcript tool changes', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-000000000004'
    const workDir = path.join(tmpDir, 'transcript-rejected-session')
    const userId = crypto.randomUUID()
    const toolUseId = 'Write:rejected'
    await fs.mkdir(workDir, { recursive: true })

    await writeSessionFile('-tmp-transcript-rejected-session', sessionId, [
      makeSessionMetaEntry(workDir),
      {
        ...makeUserEntry('write a denied file', userId),
        cwd: workDir,
        sessionId,
      },
      makeAssistantToolUseEntry([{
        id: toolUseId,
        name: 'Write',
        input: {
          file_path: path.join(workDir, 'permission-denial-test.txt'),
          content: 'must not be written\n',
        },
      }], userId),
      {
        ...makeToolResultUserEntry(
          toolUseId,
          'The user rejected this tool use.',
          undefined,
          undefined,
          sessionId,
        ),
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: 'The user rejected this tool use.',
            is_error: true,
          }],
        },
        cwd: workDir,
      },
      makeAssistantEntry('The requested write was not completed.', userId),
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn-checkpoints`)
    expect(res.status).toBe(200)
    const body = await res.json() as { checkpoints: unknown[] }

    expect(body.checkpoints).toEqual([])
    await expect(fs.stat(path.join(workDir, 'permission-denial-test.txt')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('GET /api/sessions/:id/turn-checkpoints/diff should return transcript tool diffs when file snapshots are missing', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-000000000002'
    const workDir = path.join(tmpDir, 'transcript-only-diff-session')
    const userId = crypto.randomUUID()

    await writeSessionFile('-tmp-transcript-only-diff-session', sessionId, [
      makeSessionMetaEntry(workDir),
      {
        ...makeUserEntry('edit config', userId),
        cwd: workDir,
        sessionId,
      },
      makeAssistantToolUseEntry([
        {
          id: 'Edit:1',
          name: 'Edit',
          input: {
            file_path: path.join(workDir, 'todo-app', 'vite.config.ts'),
            old_string: 'plugins: [react()]',
            new_string: 'plugins: [react(), tailwindcss()]',
          },
        },
      ], userId),
      makeToolResultUserEntry(
        'Edit:1',
        'The file vite.config.ts has been updated successfully.',
        undefined,
        undefined,
        sessionId,
      ),
      makeAssistantEntry('Config updated', userId),
    ])

    const res = await fetch(
      `${baseUrl}/api/sessions/${sessionId}/turn-checkpoints/diff?targetUserMessageId=${userId}&path=${encodeURIComponent('todo-app/vite.config.ts')}`,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as {
      state: string
      path: string
      diff?: string
      target: { targetUserMessageId: string }
    }

    expect(body.target.targetUserMessageId).toBe(userId)
    expect(body.state).toBe('ok')
    expect(body.path).toBe('todo-app/vite.config.ts')
    expect(body.diff).toContain('diff --session a/todo-app/vite.config.ts b/todo-app/vite.config.ts')
    expect(body.diff).toContain('-plugins: [react()]')
    expect(body.diff).toContain('+plugins: [react(), tailwindcss()]')
  })

  it('GET /api/sessions/:id/turn-checkpoints should include subagent transcript file changes for the parent turn', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-000000000003'
    const workDir = path.join(tmpDir, 'transcript-subagent-session')
    const firstUserId = crypto.randomUUID()
    const secondUserId = crypto.randomUUID()
    const agentMessageId = crypto.randomUUID()
    await fs.mkdir(path.join(workDir, 'todo-app', 'src'), { recursive: true })

    await writeSessionFile('-tmp-transcript-subagent-session', sessionId, [
      makeSessionMetaEntry(workDir),
      {
        ...makeUserEntry('build a todo app', firstUserId),
        cwd: workDir,
        sessionId,
      },
      {
        parentUuid: firstUserId,
        isSidechain: false,
        type: 'assistant',
        message: {
          model: 'claude-opus-4-7',
          id: `msg_${crypto.randomUUID().slice(0, 20)}`,
          type: 'message',
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'Agent:todo',
            name: 'Agent',
            input: { description: 'Create todo app files' },
          }],
        },
        uuid: agentMessageId,
        timestamp: '2026-01-01T00:02:00.000Z',
      },
      {
        ...makeUserEntry('now explain it', secondUserId),
        parentUuid: agentMessageId,
        cwd: workDir,
        sessionId,
      },
      {
        parentUuid: agentMessageId,
        isSidechain: true,
        type: 'assistant',
        message: {
          model: 'claude-opus-4-7',
          id: `msg_${crypto.randomUUID().slice(0, 20)}`,
          type: 'message',
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'Write:child',
            name: 'Write',
            input: {
              file_path: path.join(workDir, 'todo-app', 'src', 'Board.tsx'),
              content: 'export function Board() {\n  return null\n}\n',
            },
          }],
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:03:00.000Z',
      },
      {
        ...makeToolResultUserEntry(
          'Write:child',
          'The file Board.tsx has been written successfully.',
          undefined,
          undefined,
          sessionId,
        ),
        parent_tool_use_id: 'Agent:todo',
        isSidechain: true,
        cwd: workDir,
      },
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn-checkpoints`)
    expect(res.status).toBe(200)
    const body = await res.json() as {
      checkpoints: Array<{
        target: { targetUserMessageId: string }
        code: { filesChanged: string[]; insertions: number; deletions: number }
      }>
    }

    expect(body.checkpoints).toHaveLength(1)
    expect(body.checkpoints[0]!.target.targetUserMessageId).toBe(firstUserId)
    expect(body.checkpoints[0]!.code.filesChanged).toEqual([
      path.join(workDir, 'todo-app', 'src', 'Board.tsx'),
    ])
    expect(body.checkpoints[0]!.code.insertions).toBe(3)
    expect(body.checkpoints[0]!.code.deletions).toBe(0)
  })

  it('GET /api/sessions/:id/turn-checkpoints should include nested subagent changes with their own cwd', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-000000000013'
    const projectDir = '-tmp-transcript-nested-subagent-session'
    const workDir = path.join(tmpDir, 'transcript-nested-subagent-session')
    const nestedCwd = path.join(workDir, 'nested-project')
    const targetFile = path.join(nestedCwd, 'src', 'Deep.ts')
    const userId = crypto.randomUUID()

    await fs.mkdir(path.dirname(targetFile), { recursive: true })
    await fs.writeFile(targetFile, 'export const deep = true\n', 'utf-8')
    await writeSessionFile(projectDir, sessionId, [
      makeSessionMetaEntry(workDir),
      {
        ...makeUserEntry('delegate a nested project change', userId),
        cwd: workDir,
        sessionId,
      },
      makeAssistantToolUseEntry([{
        id: 'Agent:outer',
        name: 'Agent',
        input: { description: 'Run an outer agent' },
      }], userId),
      makeToolResultUserEntry(
        'Agent:outer',
        'Outer agent completed.\nagentId: outer',
        undefined,
        undefined,
        sessionId,
      ),
      makeAssistantEntry('Delegation completed.', userId),
    ])
    await writeSubagentTranscriptFile(projectDir, sessionId, 'outer', [
      {
        ...makeAssistantToolUseEntry([{
          id: 'Agent:nested',
          name: 'Agent',
          input: { description: 'Run a nested agent' },
        }]),
        cwd: workDir,
      },
      {
        ...makeToolResultUserEntry(
          'Agent:nested',
          'Nested agent completed.\nagentId: nested',
          undefined,
          undefined,
          sessionId,
        ),
        cwd: workDir,
      },
    ])
    await writeSubagentTranscriptFile(projectDir, sessionId, 'nested', [
      {
        ...makeAssistantToolUseEntry([{
          id: 'Write:deep-child',
          name: 'Write',
          input: {
            file_path: 'src/Deep.ts',
            content: 'export const deep = true\n',
          },
        }]),
        cwd: nestedCwd,
      },
      {
        ...makeToolResultUserEntry(
          'Write:deep-child',
          'Written successfully.',
          undefined,
          undefined,
          sessionId,
        ),
        cwd: nestedCwd,
      },
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn-checkpoints`)
    expect(res.status).toBe(200)
    const body = await res.json() as {
      checkpoints: Array<{
        code: { filesChanged: string[]; insertions: number; deletions: number }
        restoreAvailable?: boolean
      }>
    }
    expect(body.checkpoints).toHaveLength(1)
    expect(body.checkpoints[0]).toMatchObject({
      code: {
        filesChanged: [targetFile],
        insertions: 1,
        deletions: 0,
      },
      restoreAvailable: false,
    })
  })

  it('GET /api/sessions/:id/turn-checkpoints should bound cyclic subagent transcript links', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-000000000016'
    const projectDir = '-tmp-transcript-cyclic-subagent-session'
    const workDir = path.join(tmpDir, 'transcript-cyclic-subagent-session')
    const targetFile = path.join(workDir, 'once.ts')
    const userId = crypto.randomUUID()

    await fs.mkdir(workDir, { recursive: true })
    await fs.writeFile(targetFile, 'export const once = true\n', 'utf-8')
    await writeSessionFile(projectDir, sessionId, [
      makeSessionMetaEntry(workDir),
      {
        ...makeUserEntry('run a self-referencing agent', userId),
        cwd: workDir,
        sessionId,
      },
      makeAssistantToolUseEntry([{
        id: 'Agent:cycle-root',
        name: 'Agent',
        input: { description: 'Run the cyclic agent fixture' },
      }], userId),
      makeToolResultUserEntry(
        'Agent:cycle-root',
        'Agent completed.\nagentId: cycle',
        undefined,
        undefined,
        sessionId,
      ),
      makeAssistantEntry('Delegation complete.', userId),
    ])
    await writeSubagentTranscriptFile(projectDir, sessionId, 'cycle', [
      {
        ...makeAssistantToolUseEntry([
          {
            id: 'Write:cycle-once',
            name: 'Write',
            input: {
              file_path: targetFile,
              content: 'export const once = true\n',
            },
          },
          {
            id: 'Agent:cycle-self',
            name: 'Agent',
            input: { description: 'Reference the same transcript again' },
          },
        ]),
        cwd: workDir,
      },
      {
        ...makeToolResultUserEntry(
          'Write:cycle-once',
          'Written successfully.',
          undefined,
          undefined,
          sessionId,
        ),
        cwd: workDir,
      },
      {
        ...makeToolResultUserEntry(
          'Agent:cycle-self',
          'Agent completed.\nagentId: cycle',
          undefined,
          undefined,
          sessionId,
        ),
        cwd: workDir,
      },
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn-checkpoints`)
    expect(res.status).toBe(200)
    const body = await res.json() as {
      checkpoints: Array<{ code: { filesChanged: string[] }; restoreAvailable?: boolean }>
    }
    expect(body.checkpoints).toHaveLength(1)
    expect(body.checkpoints[0]).toMatchObject({
      code: { filesChanged: [targetFile] },
      restoreAvailable: false,
    })
  })

  it('should fall back to transcript evidence when the next partial snapshot drops a tracked path', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-000000000017'
    const projectDir = '-tmp-next-partial-drops-path'
    const workDir = path.join(tmpDir, 'next-partial-drops-path')
    const keptFile = path.join(workDir, 'kept.ts')
    const droppedFile = path.join(workDir, 'dropped.ts')
    const firstUserId = crypto.randomUUID()
    const secondUserId = crypto.randomUUID()
    const keptBackup = 'next-partial-kept@v1'
    const droppedBackup = 'next-partial-dropped@v1'
    const before = "export const value = 'before'\n"
    const after = "export const value = 'after'\n"

    await fs.mkdir(workDir, { recursive: true })
    await fs.writeFile(keptFile, before)
    await fs.writeFile(droppedFile, after)
    await writeFileHistoryBackup(sessionId, keptBackup, before)
    await writeFileHistoryBackup(sessionId, droppedBackup, before)
    await writeSessionFile(projectDir, sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(firstUserId, {
        'kept.ts': { backupFileName: keptBackup, version: 1, backupTime: '2026-01-01T00:00:00.000Z' },
        'dropped.ts': { backupFileName: droppedBackup, version: 1, backupTime: '2026-01-01T00:00:00.000Z' },
      }),
      { ...makeUserEntry('edit dropped', firstUserId), cwd: workDir, sessionId },
      makeAssistantToolUseEntry([{
        id: 'Edit:dropped-from-next',
        name: 'Edit',
        input: { file_path: droppedFile, old_string: before.trim(), new_string: after.trim() },
      }], firstUserId),
      makeToolResultUserEntry('Edit:dropped-from-next', 'Updated successfully.', undefined, undefined, sessionId),
      makeAssistantEntry('Done.', firstUserId),
      makeFileHistorySnapshotEntry(secondUserId, {
        'kept.ts': { backupFileName: keptBackup, version: 1, backupTime: '2026-01-01T00:01:00.000Z' },
      }),
      { ...makeUserEntry('inspect', secondUserId), cwd: workDir, sessionId },
      makeAssistantEntry('Inspected.', secondUserId),
    ])

    const listRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn-checkpoints`)
    const listBody = await listRes.json() as {
      checkpoints: Array<{ target: { targetUserMessageId: string }; code: { filesChanged: string[] }; restoreAvailable?: boolean }>
    }
    expect(listBody.checkpoints.find((item) =>
      item.target.targetUserMessageId === firstUserId
    )).toMatchObject({
      code: { filesChanged: [droppedFile] },
      restoreAvailable: true,
    })

    const diffRes = await fetch(
      `${baseUrl}/api/sessions/${sessionId}/turn-checkpoints/diff?targetUserMessageId=${firstUserId}&path=dropped.ts`,
    )
    expect(await diffRes.json()).toMatchObject({ state: 'ok', path: 'dropped.ts' })

    const rewindRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserMessageId: firstUserId }),
    })
    expect(rewindRes.status).toBe(200)
    expect(await fs.readFile(droppedFile, 'utf-8')).toBe(before)
  })

  it('should restore snapshot-covered files while reporting a writing shell command as unverified', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-000000000018'
    const workDir = path.join(tmpDir, 'unknown-write-tool')
    const capturedFile = path.join(workDir, 'captured.txt')
    const shellFile = path.join(workDir, 'shell.txt')
    const userId = crypto.randomUUID()
    const backupName = 'unknown-tool-captured@v1'
    await fs.mkdir(workDir, { recursive: true })
    await fs.writeFile(capturedFile, 'after\n')
    await fs.writeFile(shellFile, 'written by shell\n')
    await writeFileHistoryBackup(sessionId, backupName, 'before\n')
    await writeSessionFile('-tmp-unknown-write-tool', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(userId, {
        'captured.txt': { backupFileName: backupName, version: 1, backupTime: '2026-01-01T00:00:00.000Z' },
      }),
      { ...makeUserEntry('write with shell', userId), cwd: workDir, sessionId },
      makeAssistantToolUseEntry([{
        id: 'Bash:write-file',
        name: 'Bash',
        input: { command: `printf written > ${shellFile}` },
      }], userId),
      makeToolResultUserEntry('Bash:write-file', 'Done.', undefined, undefined, sessionId),
      makeAssistantEntry('Done.', userId),
    ])

    const listRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn-checkpoints`)
    const body = await listRes.json() as {
      checkpoints: Array<{ restoreAvailable?: boolean; unverifiedChangeSources?: string[] }>
    }
    expect(body.checkpoints[0]?.restoreAvailable).toBe(true)
    expect(body.checkpoints[0]?.unverifiedChangeSources).toEqual(['Bash'])

    const rewindRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserMessageId: userId }),
    })
    expect(rewindRes.status).toBe(200)
    expect(await rewindRes.json()).toMatchObject({ unverifiedChangeSources: ['Bash'] })
    // The snapshot-covered file is undone; the shell-written file is untouched,
    // which is exactly what the unverified source is warning about.
    expect(await fs.readFile(capturedFile, 'utf-8')).toBe('before\n')
    expect(await fs.readFile(shellFile, 'utf-8')).toBe('written by shell\n')
  })

  it('should keep a Bash-only first turn rewindable without touching the shell-written file', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-000000000033'
    const workDir = path.join(tmpDir, 'bash-only-empty-checkpoint')
    const shellFile = path.join(workDir, 'shell-only.txt')
    const userId = crypto.randomUUID()
    await fs.mkdir(workDir, { recursive: true })
    await fs.writeFile(shellFile, 'written by shell\n')
    await writeSessionFile('-tmp-bash-only-empty-checkpoint', sessionId, [
      makeSessionMetaEntry(workDir),
      // Real prompt submission records a snapshot even when no structured file
      // tool has anything to track. That empty checkpoint must still carry the
      // Bash coverage warning through to the desktop.
      makeFileHistorySnapshotEntry(userId, {}),
      { ...makeUserEntry('write only with Bash', userId), cwd: workDir, sessionId },
      makeAssistantToolUseEntry([{
        id: 'Bash:write-only-file',
        name: 'Bash',
        input: { command: `printf 'written by shell\\n' > ${shellFile}` },
      }], userId),
      makeToolResultUserEntry('Bash:write-only-file', '', undefined, undefined, sessionId),
      makeAssistantEntry('BASH_ONLY_DONE', userId),
    ])

    const listRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn-checkpoints`)
    expect(listRes.status).toBe(200)
    const listBody = await listRes.json() as {
      checkpoints: Array<{
        target: { targetUserMessageId: string }
        code: { available: boolean; filesChanged: string[] }
        restoreAvailable?: boolean
        unverifiedChangeSources?: string[]
      }>
    }
    expect(listBody.checkpoints).toHaveLength(1)
    expect(listBody.checkpoints[0]).toMatchObject({
      target: { targetUserMessageId: userId },
      code: { available: true, filesChanged: [] },
      restoreAvailable: true,
      unverifiedChangeSources: ['Bash'],
    })

    const rewindRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserMessageId: userId, mode: 'conversation' }),
    })
    expect(rewindRes.status).toBe(200)
    expect(await rewindRes.json()).toMatchObject({
      mode: 'conversation',
      unverifiedChangeSources: ['Bash'],
    })
    expect(await fs.readFile(shellFile, 'utf-8')).toBe('written by shell\n')

    const messagesRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`)
    const messagesBody = await messagesRes.json() as { messages: Array<{ id: string }> }
    expect(messagesBody.messages.some((message) => message.id === userId)).toBe(false)
  })

  it('should keep restore available and unflagged when the turn only ran a read-only shell command', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-0000000f0001'
    const workDir = path.join(tmpDir, 'repro-1192-readonly-bash')
    const editedFile = path.join(workDir, 'src.ts')
    const userId = crypto.randomUUID()
    const backupName = 'repro-1192-src@v1'
    await fs.mkdir(workDir, { recursive: true })
    await fs.writeFile(editedFile, 'after\n')
    await writeFileHistoryBackup(sessionId, backupName, 'before\n')
    await writeSessionFile('-tmp-repro-1192-readonly-bash', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(userId, {
        'src.ts': { backupFileName: backupName, version: 1, backupTime: '2026-01-01T00:00:00.000Z' },
      }),
      { ...makeUserEntry('edit then check status', userId), cwd: workDir, sessionId },
      makeAssistantToolUseEntry([{
        id: 'Edit:src',
        name: 'Edit',
        input: { file_path: editedFile, old_string: 'before', new_string: 'after' },
      }], userId),
      makeToolResultUserEntry('Edit:src', 'Updated successfully.', undefined, undefined, sessionId),
      makeAssistantToolUseEntry([{
        id: 'Bash:git-status',
        name: 'Bash',
        input: { command: 'git status --short' },
      }], userId),
      makeToolResultUserEntry('Bash:git-status', ' M src.ts', undefined, undefined, sessionId),
      makeAssistantEntry('Done.', userId),
    ])

    const listRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn-checkpoints`)
    const body = await listRes.json() as {
      checkpoints: Array<{
        code: { filesChanged: string[] }
        restoreAvailable?: boolean
        unverifiedChangeSources?: string[]
      }>
    }
    expect(body.checkpoints[0]).toMatchObject({
      code: { filesChanged: [editedFile] },
      restoreAvailable: true,
      // `git status` is provably read-only, so it must not even be reported.
      unverifiedChangeSources: [],
    })

    const rewindRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserMessageId: userId }),
    })
    expect(rewindRes.status).toBe(200)
    expect(await fs.readFile(editedFile, 'utf-8')).toBe('before\n')
  })

  it('should keep restore available when the turn ran a tool with no file-change extractor', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-0000000f0002'
    const workDir = path.join(tmpDir, 'repro-1192-taskcreate')
    const editedFile = path.join(workDir, 'src.ts')
    const userId = crypto.randomUUID()
    const backupName = 'repro-1192-task-src@v1'
    await fs.mkdir(workDir, { recursive: true })
    await fs.writeFile(editedFile, 'after\n')
    await writeFileHistoryBackup(sessionId, backupName, 'before\n')
    await writeSessionFile('-tmp-repro-1192-taskcreate', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(userId, {
        'src.ts': { backupFileName: backupName, version: 1, backupTime: '2026-01-01T00:00:00.000Z' },
      }),
      { ...makeUserEntry('track then edit', userId), cwd: workDir, sessionId },
      makeAssistantToolUseEntry([{
        id: 'TaskCreate:1',
        name: 'TaskCreate',
        input: { tasks: [{ content: 'do it', activeForm: 'doing it' }] },
      }], userId),
      makeToolResultUserEntry('TaskCreate:1', 'Created.', undefined, undefined, sessionId),
      makeAssistantToolUseEntry([{
        id: 'TaskUpdate:1',
        name: 'TaskUpdate',
        input: { taskId: 't1', status: 'completed' },
      }], userId),
      makeToolResultUserEntry('TaskUpdate:1', 'Updated.', undefined, undefined, sessionId),
      makeAssistantToolUseEntry([{
        id: 'Edit:src',
        name: 'Edit',
        input: { file_path: editedFile, old_string: 'before', new_string: 'after' },
      }], userId),
      makeToolResultUserEntry('Edit:src', 'Updated successfully.', undefined, undefined, sessionId),
      makeAssistantEntry('Done.', userId),
    ])

    const listRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn-checkpoints`)
    const body = await listRes.json() as {
      checkpoints: Array<{ restoreAvailable?: boolean; unverifiedChangeSources?: string[] }>
    }
    expect(body.checkpoints[0]?.restoreAvailable).toBe(true)
    // TaskCreate can spawn shell/agent work that writes files, so it is reported;
    // TaskUpdate only touches task metadata, so it must not add noise.
    expect(body.checkpoints[0]?.unverifiedChangeSources).toEqual(['TaskCreate'])
  })

  it('should deduplicate and cap the reported unverified change sources', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-0000000f0003'
    const workDir = path.join(tmpDir, 'repro-1192-many-sources')
    const editedFile = path.join(workDir, 'src.ts')
    const userId = crypto.randomUUID()
    const backupName = 'repro-1192-many-src@v1'
    await fs.mkdir(workDir, { recursive: true })
    await fs.writeFile(editedFile, 'after\n')
    await writeFileHistoryBackup(sessionId, backupName, 'before\n')
    // 10 distinct unknown tools plus a repeat, to prove both the dedup and the cap.
    const unknownTools = [
      'ToolA', 'ToolB', 'ToolC', 'ToolD', 'ToolE',
      'ToolF', 'ToolG', 'ToolH', 'ToolI', 'ToolJ', 'ToolA',
    ]
    await writeSessionFile('-tmp-repro-1192-many-sources', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(userId, {
        'src.ts': { backupFileName: backupName, version: 1, backupTime: '2026-01-01T00:00:00.000Z' },
      }),
      { ...makeUserEntry('many tools', userId), cwd: workDir, sessionId },
      ...unknownTools.flatMap((name, index) => [
        makeAssistantToolUseEntry([{ id: `${name}:${index}`, name, input: { x: 1 } }], userId),
        makeToolResultUserEntry(`${name}:${index}`, 'ok', undefined, undefined, sessionId),
      ]),
      makeAssistantToolUseEntry([{
        id: 'Edit:src',
        name: 'Edit',
        input: { file_path: editedFile, old_string: 'before', new_string: 'after' },
      }], userId),
      makeToolResultUserEntry('Edit:src', 'Updated successfully.', undefined, undefined, sessionId),
      makeAssistantEntry('Done.', userId),
    ])

    const listRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn-checkpoints`)
    const body = await listRes.json() as {
      checkpoints: Array<{ restoreAvailable?: boolean; unverifiedChangeSources?: string[] }>
    }
    expect(body.checkpoints[0]?.restoreAvailable).toBe(true)
    expect(body.checkpoints[0]?.unverifiedChangeSources).toEqual([
      'ToolA', 'ToolB', 'ToolC', 'ToolD', 'ToolE', 'ToolF', 'ToolG', 'ToolH',
    ])
  })

  it('should keep blocking restore when the transcript itself cannot be read', async () => {
    // Guards the split introduced for issue #1192: an unknown *tool* only
    // downgrades coverage, but an unreadable *transcript* still blocks, because
    // then even the reported file list may be wrong.
    const sessionId = '99999999-bbbb-cccc-dddd-0000000f0004'
    const workDir = path.join(tmpDir, 'repro-1192-broken-transcript')
    const editedFile = path.join(workDir, 'src.ts')
    const userId = crypto.randomUUID()
    const backupName = 'repro-1192-broken@v1'
    await fs.mkdir(workDir, { recursive: true })
    await fs.writeFile(editedFile, 'after\n')
    await writeFileHistoryBackup(sessionId, backupName, 'before\n')
    const projectDir = '-tmp-repro-1192-broken-transcript'
    await writeSessionFile(projectDir, sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(userId, {
        'src.ts': { backupFileName: backupName, version: 1, backupTime: '2026-01-01T00:00:00.000Z' },
      }),
      { ...makeUserEntry('edit src', userId), cwd: workDir, sessionId },
      makeAssistantToolUseEntry([{
        id: 'Edit:src',
        name: 'Edit',
        input: { file_path: editedFile, old_string: 'before', new_string: 'after' },
      }], userId),
      makeToolResultUserEntry('Edit:src', 'Updated successfully.', undefined, undefined, sessionId),
      makeAssistantEntry('Done.', userId),
    ])
    const transcriptPath = path.join(tmpDir, 'projects', projectDir, `${sessionId}.jsonl`)
    await fs.appendFile(transcriptPath, '{"type":"assistant","truncated\n')

    const listRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn-checkpoints`)
    const body = await listRes.json() as { checkpoints: Array<{ restoreAvailable?: boolean }> }
    expect(body.checkpoints[0]?.restoreAvailable).toBe(false)
    const rewindRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserMessageId: userId }),
    })
    expect(rewindRes.status).toBe(400)
    expect(await fs.readFile(editedFile, 'utf-8')).toBe('after\n')
  })

  it('should roll back the conversation alone when the files cannot be restored', async () => {
    // The whole point of the mode: an unreadable transcript blocks the file
    // restore, but the user must still be able to back out of their prompt.
    const sessionId = '99999999-bbbb-cccc-dddd-0000000f0005'
    const workDir = path.join(tmpDir, 'repro-1192-conversation-only')
    const editedFile = path.join(workDir, 'src.ts')
    const firstUserId = crypto.randomUUID()
    const secondUserId = crypto.randomUUID()
    const backupName = 'repro-1192-convonly@v1'
    await fs.mkdir(workDir, { recursive: true })
    await fs.writeFile(editedFile, 'after\n')
    await writeFileHistoryBackup(sessionId, backupName, 'before\n')
    const projectDir = '-tmp-repro-1192-conversation-only'
    await writeSessionFile(projectDir, sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(firstUserId, {
        'src.ts': { backupFileName: backupName, version: 1, backupTime: '2026-01-01T00:00:00.000Z' },
      }),
      { ...makeUserEntry('first prompt', firstUserId), cwd: workDir, sessionId },
      makeAssistantEntry('First done.', firstUserId),
      { ...makeUserEntry('second prompt', secondUserId), cwd: workDir, sessionId },
      makeAssistantToolUseEntry([{
        id: 'Edit:src',
        name: 'Edit',
        input: { file_path: editedFile, old_string: 'before', new_string: 'after' },
      }], secondUserId),
      makeToolResultUserEntry('Edit:src', 'Updated successfully.', undefined, undefined, sessionId),
      makeAssistantEntry('Second done.', secondUserId),
    ])
    const transcriptPath = path.join(tmpDir, 'projects', projectDir, `${sessionId}.jsonl`)
    await fs.appendFile(transcriptPath, '{"type":"assistant","truncated\n')

    // Default mode still refuses, and changes nothing.
    const bothRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserMessageId: secondUserId }),
    })
    expect(bothRes.status).toBe(400)
    expect(await fs.readFile(editedFile, 'utf-8')).toBe('after\n')

    const conversationRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserMessageId: secondUserId, mode: 'conversation' }),
    })
    expect(conversationRes.status).toBe(200)
    expect(await conversationRes.json()).toMatchObject({
      mode: 'conversation',
      // Reported honestly: the files were left alone because we could not
      // restore them, not because the user declined.
      restoreAvailable: false,
    })
    // Files untouched...
    expect(await fs.readFile(editedFile, 'utf-8')).toBe('after\n')
    // ...conversation actually trimmed back to before the second prompt.
    const messagesRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`)
    const messages = await messagesRes.json() as { messages: Array<{ id: string }> }
    expect(messages.messages.some((message) => message.id === secondUserId)).toBe(false)
    expect(messages.messages.some((message) => message.id === firstUserId)).toBe(true)
  })

  it('should leave files alone in conversation mode even when they are restorable', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-0000000f0006'
    const workDir = path.join(tmpDir, 'repro-1192-conversation-opt-out')
    const editedFile = path.join(workDir, 'src.ts')
    const userId = crypto.randomUUID()
    const backupName = 'repro-1192-optout@v1'
    await fs.mkdir(workDir, { recursive: true })
    await fs.writeFile(editedFile, 'after\n')
    await writeFileHistoryBackup(sessionId, backupName, 'before\n')
    await writeSessionFile('-tmp-repro-1192-conversation-opt-out', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(userId, {
        'src.ts': { backupFileName: backupName, version: 1, backupTime: '2026-01-01T00:00:00.000Z' },
      }),
      { ...makeUserEntry('edit src', userId), cwd: workDir, sessionId },
      makeAssistantToolUseEntry([{
        id: 'Edit:src',
        name: 'Edit',
        input: { file_path: editedFile, old_string: 'before', new_string: 'after' },
      }], userId),
      makeToolResultUserEntry('Edit:src', 'Updated successfully.', undefined, undefined, sessionId),
      makeAssistantEntry('Done.', userId),
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserMessageId: userId, mode: 'conversation' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ mode: 'conversation', restoreAvailable: true })
    expect(await fs.readFile(editedFile, 'utf-8')).toBe('after\n')
  })

  it('should echo the default mode and reject an unknown one', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-0000000f0007'
    const workDir = path.join(tmpDir, 'repro-1192-mode-validation')
    const userId = crypto.randomUUID()
    await fs.mkdir(workDir, { recursive: true })
    await writeSessionFile('-tmp-repro-1192-mode-validation', sessionId, [
      makeSessionMetaEntry(workDir),
      { ...makeUserEntry('hello', userId), cwd: workDir, sessionId },
      makeAssistantEntry('Hi.', userId),
    ])

    const badRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserMessageId: userId, mode: 'code' }),
    })
    expect(badRes.status).toBe(400)

    const defaultRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserMessageId: userId }),
    })
    expect(defaultRes.status).toBe(200)
    expect(await defaultRes.json()).toMatchObject({ mode: 'both' })
  })

  it('should reject unsafe backup file names without reading outside file history', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-000000000019'
    const workDir = path.join(tmpDir, 'unsafe-backup-name')
    const targetFile = path.join(workDir, 'target.txt')
    const userId = crypto.randomUUID()
    await fs.mkdir(workDir, { recursive: true })
    await fs.writeFile(targetFile, 'after\n')
    await writeSessionFile('-tmp-unsafe-backup-name', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(userId, {
        'target.txt': { backupFileName: '../../../../outside-secret', version: 1, backupTime: '2026-01-01T00:00:00.000Z' },
      }),
      { ...makeUserEntry('edit target', userId), cwd: workDir, sessionId },
      makeAssistantEntry('Done.', userId),
    ])
    const dryRunRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserMessageId: userId, dryRun: true }),
    })
    expect(await dryRunRes.json()).toMatchObject({ restoreAvailable: false })
    const rewindRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserMessageId: userId }),
    })
    expect(rewindRes.status).toBe(400)
    expect(await fs.readFile(targetFile, 'utf-8')).toBe('after\n')
  })

  it('should reject conflicting snapshot aliases before presenting undo as available', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-000000000020'
    const workDir = path.join(tmpDir, 'conflicting-snapshot-aliases')
    const targetFile = path.join(workDir, 'target.txt')
    const userId = crypto.randomUUID()
    await fs.mkdir(workDir, { recursive: true })
    await fs.writeFile(targetFile, 'after\n')
    await writeFileHistoryBackup(sessionId, 'alias-one@v1', 'before one\n')
    await writeFileHistoryBackup(sessionId, 'alias-two@v1', 'before two\n')
    await writeSessionFile('-tmp-conflicting-snapshot-aliases', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(userId, {
        'target.txt': { backupFileName: 'alias-one@v1', version: 1, backupTime: '2026-01-01T00:00:00.000Z' },
        'nested/../target.txt': { backupFileName: 'alias-two@v1', version: 1, backupTime: '2026-01-01T00:00:00.000Z' },
      }),
      { ...makeUserEntry('edit target', userId), cwd: workDir, sessionId },
      makeAssistantEntry('Done.', userId),
    ])
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn-checkpoints`)
    const body = await res.json() as { checkpoints: Array<{ restoreAvailable?: boolean }> }
    expect(body.checkpoints[0]?.restoreAvailable).toBe(false)
  })

  it('should preflight every restore target before changing the first file', async () => {
    if (process.platform === 'win32') return
    const sessionId = '99999999-bbbb-cccc-dddd-000000000021'
    const workDir = path.join(tmpDir, 'restore-preflight')
    const firstFile = path.join(workDir, 'first.txt')
    const secondFile = path.join(workDir, 'second.txt')
    const userId = crypto.randomUUID()
    await fs.mkdir(workDir, { recursive: true })
    await fs.writeFile(firstFile, 'first after\n')
    await fs.writeFile(secondFile, 'second after\n')
    await writeFileHistoryBackup(sessionId, 'preflight-first@v1', 'first before\n')
    await writeFileHistoryBackup(sessionId, 'preflight-second@v1', 'second before\n')
    await writeSessionFile('-tmp-restore-preflight', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(userId, {
        'first.txt': { backupFileName: 'preflight-first@v1', version: 1, backupTime: '2026-01-01T00:00:00.000Z' },
        'second.txt': { backupFileName: 'preflight-second@v1', version: 1, backupTime: '2026-01-01T00:00:00.000Z' },
      }),
      { ...makeUserEntry('edit both', userId), cwd: workDir, sessionId },
      makeAssistantEntry('Done.', userId),
    ])
    await fs.chmod(secondFile, 0o400)
    try {
      const rewindRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUserMessageId: userId }),
      })
      expect(rewindRes.status).toBe(400)
      expect(await fs.readFile(firstFile, 'utf-8')).toBe('first after\n')
      expect((await service.getSessionMessages(sessionId)).map((message) => message.id))
        .toContain(userId)
    } finally {
      await fs.chmod(secondFile, 0o600)
    }
  })

  it('should roll restored files forward again when transcript trimming fails', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-000000000026'
    const workDir = path.join(tmpDir, 'trim-failure-file-rollback')
    const targetFile = path.join(workDir, 'target.txt')
    const userId = crypto.randomUUID()
    await fs.mkdir(workDir, { recursive: true })
    await fs.writeFile(targetFile, 'after\n')
    await writeFileHistoryBackup(sessionId, 'trim-failure@v1', 'before\n')
    await writeSessionFile('-tmp-trim-failure-file-rollback', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(userId, {
        'target.txt': { backupFileName: 'trim-failure@v1', version: 1, backupTime: '2026-01-01T00:00:00.000Z' },
      }),
      { ...makeUserEntry('edit target', userId), cwd: workDir, sessionId },
      makeAssistantEntry('Done.', userId),
    ])
    const originalTrim = sessionService.trimSessionMessagesFrom.bind(sessionService)
    sessionService.trimSessionMessagesFrom = async () => {
      throw new Error('simulated atomic transcript replacement failure')
    }
    try {
      const rewindRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUserMessageId: userId }),
      })
      expect(rewindRes.status).toBe(500)
      expect(await fs.readFile(targetFile, 'utf-8')).toBe('after\n')
    } finally {
      sessionService.trimSessionMessagesFrom = originalTrim
    }
    expect((await service.getSessionMessages(sessionId)).map((message) => message.id))
      .toContain(userId)
  })

  it('should not require write access for an unchanged tracked file', async () => {
    if (process.platform === 'win32') return
    const sessionId = '99999999-bbbb-cccc-dddd-000000000027'
    const workDir = path.join(tmpDir, 'unchanged-read-only-rewind')
    const targetFile = path.join(workDir, 'target.txt')
    const userId = crypto.randomUUID()
    await fs.mkdir(workDir, { recursive: true })
    await fs.writeFile(targetFile, 'same\n')
    await writeFileHistoryBackup(sessionId, 'unchanged-read-only@v1', 'same\n')
    await writeSessionFile('-tmp-unchanged-read-only-rewind', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(userId, {
        'target.txt': { backupFileName: 'unchanged-read-only@v1', version: 1, backupTime: '2026-01-01T00:00:00.000Z' },
      }),
      { ...makeUserEntry('inspect only', userId), cwd: workDir, sessionId },
      makeAssistantEntry('Done.', userId),
    ])
    await fs.chmod(targetFile, 0o400)
    try {
      const rewindRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUserMessageId: userId }),
      })
      expect(rewindRes.status).toBe(200)
      expect(await fs.readFile(targetFile, 'utf-8')).toBe('same\n')
    } finally {
      await fs.chmod(targetFile, 0o600)
    }
  })

  it('should disable rewind when nested subagent evidence hits the depth bound', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-000000000022'
    const projectDir = '-tmp-subagent-depth-bound'
    const workDir = path.join(tmpDir, 'subagent-depth-bound')
    const capturedFile = path.join(workDir, 'captured.txt')
    const omittedFile = path.join(workDir, 'omitted.txt')
    const userId = crypto.randomUUID()
    await fs.mkdir(workDir, { recursive: true })
    await fs.writeFile(capturedFile, 'same\n')
    await fs.writeFile(omittedFile, 'deep write\n')
    await writeFileHistoryBackup(sessionId, 'depth-captured@v1', 'same\n')
    await writeSessionFile(projectDir, sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(userId, {
        'captured.txt': { backupFileName: 'depth-captured@v1', version: 1, backupTime: '2026-01-01T00:00:00.000Z' },
      }),
      { ...makeUserEntry('delegate deeply', userId), cwd: workDir, sessionId },
      makeAssistantToolUseEntry([{ id: 'Agent:depth-root', name: 'Agent', input: {} }], userId),
      makeToolResultUserEntry('Agent:depth-root', 'agentId: depth-1', undefined, undefined, sessionId),
      makeAssistantEntry('Done.', userId),
    ])
    for (let depth = 1; depth <= 17; depth += 1) {
      const entries = depth === 17
        ? [
            { ...makeAssistantToolUseEntry([{ id: 'Write:deep', name: 'Write', input: { file_path: omittedFile, content: 'deep write\n' } }]), cwd: workDir },
            { ...makeToolResultUserEntry('Write:deep', 'Written.', undefined, undefined, sessionId), cwd: workDir },
          ]
        : [
            { ...makeAssistantToolUseEntry([{ id: `Agent:depth-${depth}`, name: 'Agent', input: {} }]), cwd: workDir },
            { ...makeToolResultUserEntry(`Agent:depth-${depth}`, `agentId: depth-${depth + 1}`, undefined, undefined, sessionId), cwd: workDir },
          ]
      await writeSubagentTranscriptFile(projectDir, sessionId, `depth-${depth}`, entries)
    }
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn-checkpoints`)
    const body = await res.json() as { checkpoints: Array<{ restoreAvailable?: boolean }> }
    expect(body.checkpoints[0]?.restoreAvailable).toBe(false)
    const rewindRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserMessageId: userId }),
    })
    expect(rewindRes.status).toBe(400)
    expect(await fs.readFile(omittedFile, 'utf-8')).toBe('deep write\n')
  })

  it('should disable rewind when the root transcript contains an incomplete JSONL entry', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-000000000023'
    const workDir = path.join(tmpDir, 'incomplete-root-transcript')
    const targetFile = path.join(workDir, 'target.txt')
    const userId = crypto.randomUUID()
    await fs.mkdir(workDir, { recursive: true })
    await fs.writeFile(targetFile, 'after\n')
    await writeFileHistoryBackup(sessionId, 'incomplete-root@v1', 'before\n')
    const transcriptPath = await writeSessionFile('-tmp-incomplete-root-transcript', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(userId, {
        'target.txt': { backupFileName: 'incomplete-root@v1', version: 1, backupTime: '2026-01-01T00:00:00.000Z' },
      }),
      { ...makeUserEntry('edit target', userId), cwd: workDir, sessionId },
      makeAssistantEntry('Done.', userId),
    ])
    await fs.appendFile(transcriptPath, '{"type":"assistant","message":\n')

    const listRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn-checkpoints`)
    const body = await listRes.json() as { checkpoints: Array<{ restoreAvailable?: boolean }> }
    expect(body.checkpoints[0]?.restoreAvailable).toBe(false)
    const rewindRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserMessageId: userId }),
    })
    expect(rewindRes.status).toBe(400)
    expect(await fs.readFile(targetFile, 'utf-8')).toBe('after\n')
  })

  it('should disable rewind when an Agent result has no resolvable child transcript id', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-000000000024'
    const workDir = path.join(tmpDir, 'unresolved-agent-result')
    const targetFile = path.join(workDir, 'target.txt')
    const userId = crypto.randomUUID()
    await fs.mkdir(workDir, { recursive: true })
    await fs.writeFile(targetFile, 'after\n')
    await writeFileHistoryBackup(sessionId, 'unresolved-agent@v1', 'before\n')
    await writeSessionFile('-tmp-unresolved-agent-result', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(userId, {
        'target.txt': { backupFileName: 'unresolved-agent@v1', version: 1, backupTime: '2026-01-01T00:00:00.000Z' },
      }),
      { ...makeUserEntry('delegate edit', userId), cwd: workDir, sessionId },
      makeAssistantToolUseEntry([{ id: 'Agent:missing-id', name: 'Agent', input: {} }], userId),
      makeToolResultUserEntry('Agent:missing-id', 'Agent completed.', undefined, undefined, sessionId),
      makeAssistantEntry('Done.', userId),
    ])
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn-checkpoints`)
    const body = await res.json() as { checkpoints: Array<{ restoreAvailable?: boolean }> }
    expect(body.checkpoints[0]?.restoreAvailable).toBe(false)
  })

  it('should load Task subagent edits outside the prompt workdir', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-000000000025'
    const projectDir = '-tmp-task-subagent-external'
    const workDir = path.join(tmpDir, 'task-subagent-workdir')
    const outsideFile = path.join(tmpDir, 'task-subagent-outside', 'outside.txt')
    const userId = crypto.randomUUID()
    await fs.mkdir(workDir, { recursive: true })
    await fs.mkdir(path.dirname(outsideFile), { recursive: true })
    await fs.writeFile(outsideFile, 'outside\n')
    await writeSessionFile(projectDir, sessionId, [
      makeSessionMetaEntry(workDir),
      { ...makeUserEntry('delegate external edit', userId), cwd: workDir, sessionId },
      makeAssistantToolUseEntry([{ id: 'Task:external', name: 'Task', input: {} }], userId),
      makeToolResultUserEntry('Task:external', 'agentId: task-external', undefined, undefined, sessionId),
      makeAssistantEntry('Done.', userId),
    ])
    await writeSubagentTranscriptFile(projectDir, sessionId, 'task-external', [
      { ...makeAssistantToolUseEntry([{ id: 'Write:task-external', name: 'Write', input: { file_path: outsideFile, content: 'outside\n' } }]), cwd: workDir },
      { ...makeToolResultUserEntry('Write:task-external', 'Written.', undefined, undefined, sessionId), cwd: workDir },
    ])
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn-checkpoints`)
    const body = await res.json() as {
      checkpoints: Array<{ code: { filesChanged: string[] }; restoreAvailable?: boolean }>
    }
    expect(body.checkpoints[0]).toMatchObject({
      code: { filesChanged: [outsideFile] },
      restoreAvailable: false,
    })
  })

  it('should validate transcript-only changes from every turn removed by rewind', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-000000000028'
    const workDir = path.join(tmpDir, 'later-turn-evidence')
    const capturedFile = path.join(workDir, 'captured.txt')
    const outsideFile = path.join(tmpDir, 'later-turn-outside.txt')
    const firstUserId = crypto.randomUUID()
    const secondUserId = crypto.randomUUID()
    await fs.mkdir(workDir, { recursive: true })
    await fs.writeFile(capturedFile, 'same\n')
    await fs.writeFile(outsideFile, 'after\n')
    await writeFileHistoryBackup(sessionId, 'later-turn-captured@v1', 'same\n')
    await writeSessionFile('-tmp-later-turn-evidence', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(firstUserId, {
        'captured.txt': { backupFileName: 'later-turn-captured@v1', version: 1, backupTime: '2026-01-01T00:00:00.000Z' },
      }),
      { ...makeUserEntry('first turn', firstUserId), cwd: workDir, sessionId },
      makeAssistantEntry('Done.', firstUserId),
      { ...makeUserEntry('edit outside', secondUserId), cwd: workDir, sessionId },
      makeAssistantToolUseEntry([{
        id: 'Edit:later-external', name: 'Edit',
        input: { file_path: outsideFile, old_string: 'before', new_string: 'after' },
      }], secondUserId),
      makeToolResultUserEntry('Edit:later-external', 'Updated.', undefined, undefined, sessionId),
      makeAssistantEntry('Done.', secondUserId),
    ])
    const dryRunRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserMessageId: firstUserId, dryRun: true }),
    })
    expect(await dryRunRes.json()).toMatchObject({
      code: { filesChanged: [outsideFile] },
      restoreAvailable: false,
    })
    const rewindRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserMessageId: firstUserId }),
    })
    expect(rewindRes.status).toBe(400)
    expect(await fs.readFile(outsideFile, 'utf-8')).toBe('after\n')
  })

  it('should report errored write-capable tools as unverified without blocking restore', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-000000000029'
    const workDir = path.join(tmpDir, 'errored-write-tool')
    const targetFile = path.join(workDir, 'target.txt')
    const userId = crypto.randomUUID()
    await fs.mkdir(workDir, { recursive: true })
    await fs.writeFile(targetFile, 'after\n')
    await writeFileHistoryBackup(sessionId, 'errored-write@v1', 'before\n')
    await writeSessionFile('-tmp-errored-write-tool', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(userId, {
        'target.txt': { backupFileName: 'errored-write@v1', version: 1, backupTime: '2026-01-01T00:00:00.000Z' },
      }),
      { ...makeUserEntry('run a failing write', userId), cwd: workDir, sessionId },
      makeAssistantToolUseEntry([{ id: 'Bash:error-after-write', name: 'Bash', input: { command: 'write then fail' } }], userId),
      makeToolResultUserEntry('Bash:error-after-write', 'failed after write', true, undefined, sessionId),
      makeAssistantEntry('Failed.', userId),
    ])
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn-checkpoints`)
    const body = await res.json() as {
      checkpoints: Array<{ restoreAvailable?: boolean; unverifiedChangeSources?: string[] }>
    }
    expect(body.checkpoints[0]?.restoreAvailable).toBe(true)
    expect(body.checkpoints[0]?.unverifiedChangeSources).toEqual(['Bash'])
  })

  it('should reject a symlinked file-history session directory', async () => {
    if (process.platform === 'win32') return
    const sessionId = '99999999-bbbb-cccc-dddd-000000000030'
    const workDir = path.join(tmpDir, 'symlinked-backup-directory')
    const targetFile = path.join(workDir, 'target.txt')
    const outsideBackupDir = path.join(tmpDir, 'outside-backup-directory')
    const backupName = 'symlinked-directory@v1'
    const userId = crypto.randomUUID()
    await fs.mkdir(workDir, { recursive: true })
    await fs.mkdir(outsideBackupDir, { recursive: true })
    await fs.writeFile(targetFile, 'after\n')
    await fs.writeFile(path.join(outsideBackupDir, backupName), 'outside secret\n')
    await writeFileHistoryBackup(sessionId, backupName, 'before\n')
    const backupDir = path.join(tmpDir, 'file-history', sessionId)
    await fs.rm(backupDir, { recursive: true })
    await fs.symlink(outsideBackupDir, backupDir, 'dir')
    await writeSessionFile('-tmp-symlinked-backup-directory', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(userId, {
        'target.txt': { backupFileName: backupName, version: 1, backupTime: '2026-01-01T00:00:00.000Z' },
      }),
      { ...makeUserEntry('edit target', userId), cwd: workDir, sessionId },
      makeAssistantEntry('Done.', userId),
    ])
    const dryRunRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserMessageId: userId, dryRun: true }),
    })
    expect(await dryRunRes.json()).toMatchObject({ restoreAvailable: false })
    expect(await fs.readFile(targetFile, 'utf-8')).toBe('after\n')
  })

  it('should reject a symlinked backup file', async () => {
    if (process.platform === 'win32') return
    const sessionId = '99999999-bbbb-cccc-dddd-000000000031'
    const workDir = path.join(tmpDir, 'symlinked-backup-file')
    const targetFile = path.join(workDir, 'target.txt')
    const outsideBackup = path.join(tmpDir, 'outside-backup.txt')
    const backupName = 'symlinked-file@v1'
    const userId = crypto.randomUUID()
    await fs.mkdir(workDir, { recursive: true })
    await fs.writeFile(targetFile, 'after\n')
    await fs.writeFile(outsideBackup, 'outside secret\n')
    await writeFileHistoryBackup(sessionId, backupName, 'before\n')
    const backupPath = path.join(tmpDir, 'file-history', sessionId, backupName)
    await fs.unlink(backupPath)
    await fs.symlink(outsideBackup, backupPath)
    await writeSessionFile('-tmp-symlinked-backup-file', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(userId, {
        'target.txt': { backupFileName: backupName, version: 1, backupTime: '2026-01-01T00:00:00.000Z' },
      }),
      { ...makeUserEntry('edit target', userId), cwd: workDir, sessionId },
      makeAssistantEntry('Done.', userId),
    ])
    const dryRunRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserMessageId: userId, dryRun: true }),
    })
    expect(await dryRunRes.json()).toMatchObject({ restoreAvailable: false })
    expect(await fs.readFile(targetFile, 'utf-8')).toBe('after\n')
  })

  it('POST /api/sessions/:id/rewind should restore the base state when rewinding the first turn of a three-turn file history', async () => {
    const fixture = await createThreeTurnCheckpointFixture(
      'aaaaaaaa-1111-2222-3333-444444444444',
    )

    const executeRes = await fetch(`${baseUrl}/api/sessions/${fixture.sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessageIndex: 0 }),
    })
    expect(executeRes.status).toBe(200)

    expect(await fs.readFile(fixture.stepFile, 'utf-8')).toBe("export const STEP = 'base'\n")
    await expect(fs.stat(fixture.createdFile)).rejects.toMatchObject({ code: 'ENOENT' })

    const remainingMessages = await service.getSessionMessages(fixture.sessionId)
    expect(remainingMessages).toHaveLength(0)
  })

  // Files created by the FIRST turn (the mirror of the fixture above, which
  // creates its file in the third turn). Rewinding back to turn 1 has to delete
  // them, because "before turn 1" is a state in which they did not exist.
  async function writeFirstTurnCreatesFilesFixture(sessionId: string) {
    const workDir = path.join(tmpDir, `first-turn-creates-${sessionId}`)
    const fileA = path.join(workDir, 'a.ts')
    const fileB = path.join(workDir, 'b.ts')
    const fileC = path.join(workDir, 'c.ts')
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
    await fs.mkdir(workDir, { recursive: true })
    // Disk holds the third-turn content.
    await fs.writeFile(fileA, 'a v3\n')
    await fs.writeFile(fileB, 'b v3\n')
    await fs.writeFile(fileC, 'c v3\n')
    await writeFileHistoryBackup(sessionId, 'a@v2', 'a v1\n')
    await writeFileHistoryBackup(sessionId, 'b@v2', 'b v1\n')
    await writeFileHistoryBackup(sessionId, 'a@v3', 'a v2\n')
    await writeFileHistoryBackup(sessionId, 'b@v3', 'b v2\n')
    await writeFileHistoryBackup(sessionId, 'c@v2', 'c v2\n')
    const stamp = '2026-01-01T00:00:00.000Z'
    await writeSessionFile(`-tmp-first-turn-creates-${sessionId}`, sessionId, [
      makeSessionMetaEntry(workDir),
      // Turn 1 creates a.ts and b.ts — neither existed before it.
      makeFileHistorySnapshotEntry(ids[0]!, {
        'a.ts': { backupFileName: null, version: 1, backupTime: stamp },
        'b.ts': { backupFileName: null, version: 1, backupTime: stamp },
      }),
      { ...makeUserEntry('create a and b', ids[0]), cwd: workDir, sessionId },
      makeAssistantEntry('Created.', ids[0]),
      // Turn 2 edits both and creates c.ts.
      makeFileHistorySnapshotEntry(ids[1]!, {
        'a.ts': { backupFileName: 'a@v2', version: 2, backupTime: stamp },
        'b.ts': { backupFileName: 'b@v2', version: 2, backupTime: stamp },
        'c.ts': { backupFileName: null, version: 1, backupTime: stamp },
      }),
      { ...makeUserEntry('edit a, b and create c', ids[1]), cwd: workDir, sessionId },
      makeAssistantEntry('Done.', ids[1]),
      // Turn 3 edits a.ts, b.ts and c.ts again.
      makeFileHistorySnapshotEntry(ids[2]!, {
        'a.ts': { backupFileName: 'a@v3', version: 3, backupTime: stamp },
        'b.ts': { backupFileName: 'b@v3', version: 3, backupTime: stamp },
        'c.ts': { backupFileName: 'c@v2', version: 2, backupTime: stamp },
      }),
      { ...makeUserEntry('edit again', ids[2]), cwd: workDir, sessionId },
      makeAssistantEntry('Done.', ids[2]),
    ])
    return { workDir, fileA, fileB, fileC, ids }
  }

  it('POST /api/sessions/:id/rewind should return to the start of the third turn without touching earlier turns', async () => {
    const sessionId = 'aaaaaaaa-9999-1111-2222-333333333333'
    const f = await writeFirstTurnCreatesFilesFixture(sessionId)

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserMessageId: f.ids[2] }),
    })
    expect(res.status).toBe(200)

    // Back to the state captured when turn 3's prompt was submitted.
    expect(await fs.readFile(f.fileA, 'utf-8')).toBe('a v2\n')
    expect(await fs.readFile(f.fileB, 'utf-8')).toBe('b v2\n')
    // c.ts existed before turn 3, so it survives with its pre-turn-3 content.
    expect(await fs.readFile(f.fileC, 'utf-8')).toBe('c v2\n')
  })

  it('POST /api/sessions/:id/rewind should delete first-turn-created files when rewinding all the way back', async () => {
    const sessionId = 'aaaaaaaa-9999-4444-5555-666666666666'
    const f = await writeFirstTurnCreatesFilesFixture(sessionId)

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserMessageId: f.ids[0] }),
    })
    expect(res.status).toBe(200)

    // a.ts and b.ts did not exist before turn 1 — undo removes them outright.
    await expect(fs.stat(f.fileA)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(f.fileB)).rejects.toMatchObject({ code: 'ENOENT' })
    // c.ts was created two turns later and is removed as well: the restore plan
    // spans every tracked path, not just the ones in the target snapshot.
    await expect(fs.stat(f.fileC)).rejects.toMatchObject({ code: 'ENOENT' })

    expect(await service.getSessionMessages(sessionId)).toHaveLength(0)
  })

  it('POST /api/sessions/:id/rewind should keep the first turn and remove later file changes when rewinding the second turn of a three-turn history', async () => {
    const fixture = await createThreeTurnCheckpointFixture(
      'aaaaaaaa-5555-6666-7777-888888888888',
    )

    const executeRes = await fetch(`${baseUrl}/api/sessions/${fixture.sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessageIndex: 1 }),
    })
    expect(executeRes.status).toBe(200)

    expect(await fs.readFile(fixture.stepFile, 'utf-8')).toBe("export const STEP = 'v1'\n")
    await expect(fs.stat(fixture.createdFile)).rejects.toMatchObject({ code: 'ENOENT' })

    const remainingMessages = await service.getSessionMessages(fixture.sessionId)
    expect(remainingMessages).toHaveLength(2)
    expect(remainingMessages[0]?.id).toBe(fixture.firstUserId)
    expect(remainingMessages[1]?.type).toBe('assistant')
  })

  // --------------------------------------------------------------------------
  // Conversations API via /api/sessions/:id/chat
  // --------------------------------------------------------------------------

  it('GET /api/sessions/:id/chat/status should return idle by default', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/chat/status`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { state: string; activityState: string }
    expect(body.state).toBe('idle')
    expect(body.activityState).toBe('idle')
  })

  it('POST /api/sessions/:id/chat should queue a message', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-api-test', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Previous'),
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'New question' }),
    })
    expect(res.status).toBe(202)

    const body = (await res.json()) as { messageId: string; status: string }
    expect(body.status).toBe('queued')
    expect(body.messageId).toBeTruthy()

    const statusRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/chat/status`)
    const status = (await statusRes.json()) as { state: string; activityState: string }
    expect(status.state).toBe('thinking')
    expect(status.activityState).toBe('running')

    await fetch(`${baseUrl}/api/sessions/${sessionId}/chat/stop`, { method: 'POST' })
  })

  it('POST /api/sessions/:id/chat/stop should reset state to idle', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/chat/stop`, {
      method: 'POST',
    })
    expect(res.status).toBe(200)

    // Verify state is idle
    const statusRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/chat/status`)
    const status = (await statusRes.json()) as { state: string; activityState: string }
    expect(status.state).toBe('idle')
    expect(status.activityState).toBe('idle')
  })
})
