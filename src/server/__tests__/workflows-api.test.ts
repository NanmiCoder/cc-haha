import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  buildSessionActivityModel,
} from '../../../desktop/src/components/activity/sessionActivityModel.js'
import {
  getDefaultBaseUrl,
  setBaseUrl,
} from '../../../desktop/src/api/client.js'
import {
  runsForSession,
  useWorkflowStore,
} from '../../../desktop/src/stores/workflowStore.js'
import type { AppState } from '../../state/AppState.js'
import type { SetAppState } from '../../Task.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { ToolUseContext } from '../../Tool.js'
import { cleanupTaskOutput } from '../../utils/task/diskOutput.js'
import {
  completeWorkflowTask,
  registerWorkflowTask,
  updateWorkflowProgressBatch,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { getClaudeTempDir } from '../../utils/permissions/filesystem.js'
import * as filesystemPermissions from '../../utils/permissions/filesystem.js'
import { createWorkflowHarness } from '../../utils/workflows/harness.js'
import { WorkflowJournal } from '../../utils/workflows/journal.js'
import type { WorkflowProgressEvent } from '../../utils/workflows/types.js'
import { handleWorkflowsApi } from '../api/workflows.js'
import { sessionService } from '../services/sessionService.js'

let tmpHome: string
let projectDir: string
let originalConfigDir: string | undefined
let taskOutputRoot: string | undefined
let tempRootSpy: ReturnType<typeof spyOn> | undefined

function request(
  urlStr: string,
  init?: { method?: string; body?: unknown },
): { req: Request; url: URL; segments: string[] } {
  const url = new URL(urlStr, 'http://localhost:3456')
  const req = new Request(url.toString(), {
    method: init?.method ?? 'GET',
    ...(init?.body !== undefined
      ? {
          body: JSON.stringify(init.body),
          headers: { 'content-type': 'application/json' },
        }
      : {}),
  })
  return { req, url, segments: url.pathname.split('/').filter(Boolean) }
}

function call(
  urlStr: string,
  init?: { method?: string; body?: unknown },
): Promise<Response> {
  const { req, url, segments } = request(urlStr, init)
  return handleWorkflowsApi(req, url, segments)
}

const VALID_SCRIPT = [
  "export const meta = { name: 'my-audit', description: 'Audit the routes', phases: [{ title: 'Scan' }] }",
  "const out = await agent('scan')",
  'return out',
].join('\n')

function makeRuntimeHarness(
  runId: string,
  journal: WorkflowJournal,
  journalSnapshot?: Awaited<ReturnType<WorkflowJournal['load']>>,
) {
  const events: WorkflowProgressEvent[] = []
  let sequence = 0
  return {
    events,
    harness: createWorkflowHarness({
      toolUseContext: {
        options: { mainLoopModel: 'test-model' },
      } as unknown as ToolUseContext,
      canUseTool: (() => {}) as unknown as CanUseToolFn,
      runId,
      emit: event => events.push(event),
      onAgentController: () => {},
      journal,
      journalSnapshot,
      runAgentImpl: async params => ({
        agentId: `live-${params.prompt}-${++sequence}`,
        value: `live:${params.prompt}`,
        tokens: 1,
        toolCalls: 0,
      }),
    }),
  }
}

async function writeRuntimeTaskOutput(params: {
  taskId: string
  runId: string
  outputFile: string
  events: WorkflowProgressEvent[]
}): Promise<void> {
  const task = registerWorkflowTask({
    taskId: params.taskId,
    script: VALID_SCRIPT,
    workflowName: 'my-audit',
    workflowRunId: params.runId,
  })
  let state = { tasks: { [task.id]: task } } as unknown as AppState
  const setAppState: SetAppState = update => {
    state = update(state)
  }
  updateWorkflowProgressBatch(task.id, params.events, setAppState)
  try {
    await completeWorkflowTask(task.id, 'done', 4, [], setAppState)
    await fs.copyFile(task.outputFile, params.outputFile)
  } finally {
    await cleanupTaskOutput(task.id)
  }
}

describe('Workflows API', () => {
  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-api-'))
    projectDir = path.join(tmpHome, 'project')
    await fs.mkdir(path.join(projectDir, '.git'), { recursive: true })
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, 'claude')
    resetSettingsCache()
    taskOutputRoot = path.join(
      getClaudeTempDir(),
      `wf-api-${path.basename(tmpHome)}`,
    )
  })

  afterEach(async () => {
    tempRootSpy?.mockRestore()
    tempRootSpy = undefined
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    resetSettingsCache()
    if (taskOutputRoot) {
      await fs.rm(taskOutputRoot, { recursive: true, force: true })
    }
    await fs.rm(tmpHome, { recursive: true, force: true })
  })

  it('lists the bundled workflow', async () => {
    const response = await call(`/api/workflows?cwd=${encodeURIComponent(projectDir)}`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      workflows: Array<{ name: string; source: string; phases?: unknown[] }>
    }
    const deepResearch = body.workflows.find(w => w.name === 'deep-research')
    expect(deepResearch?.source).toBe('built-in')
    expect(deepResearch?.phases?.length).toBeGreaterThan(0)
    // The list stays small: no script bodies.
    expect(body.workflows.every(w => !('script' in w) || w.script === undefined)).toBe(true)
  })

  it('returns the script on the detail endpoint', async () => {
    const response = await call(
      `/api/workflows/deep-research?cwd=${encodeURIComponent(projectDir)}`,
    )
    const body = (await response.json()) as { script?: string }
    expect(body.script).toContain('export const meta')
  })

  it('validates a script without running it', async () => {
    const ok = await (
      await call('/api/workflows/validate', {
        method: 'POST',
        body: { script: VALID_SCRIPT },
      })
    ).json()
    expect(ok).toMatchObject({ ok: true, name: 'my-audit' })

    const nondeterministic = await (
      await call('/api/workflows/validate', {
        method: 'POST',
        body: {
          script:
            "export const meta = { name: 'x', description: 'y' }\nconst t = Date.now()\nreturn t\n",
        },
      })
    ).json()
    expect(nondeterministic).toMatchObject({ ok: true })
    expect((nondeterministic as { warnings: string[] }).warnings[0]).toContain(
      'Date.now()',
    )

    const bad = await (
      await call('/api/workflows/validate', {
        method: 'POST',
        body: { script: 'const x = 1\n' },
      })
    ).json()
    expect(bad).toMatchObject({ ok: false })
    expect((bad as { error: string }).error).toContain('FIRST statement')
  })

  it('saves a workflow and then lists and deletes it', async () => {
    const saved = await (
      await call('/api/workflows/save', {
        method: 'POST',
        body: { script: VALID_SCRIPT, scope: 'project', cwd: projectDir },
      })
    ).json()
    expect(saved).toMatchObject({ ok: true, name: 'my-audit' })
    expect((saved as { filePath: string }).filePath).toBe(
      path.join(projectDir, '.claude', 'workflows', 'my-audit.js'),
    )

    const listed = (await (
      await call(`/api/workflows?cwd=${encodeURIComponent(projectDir)}`)
    ).json()) as { workflows: Array<{ name: string; source: string }> }
    expect(
      listed.workflows.find(w => w.name === 'my-audit')?.source,
    ).toBe('projectSettings')

    const deleted = await call(
      `/api/workflows/my-audit?scope=project&cwd=${encodeURIComponent(projectDir)}`,
      { method: 'DELETE' },
    )
    expect(deleted.status).toBe(200)
    const after = (await (
      await call(`/api/workflows?cwd=${encodeURIComponent(projectDir)}`)
    ).json()) as { workflows: Array<{ name: string }> }
    expect(after.workflows.find(w => w.name === 'my-audit')).toBeUndefined()
  })

  it('saves a completed script under a user-chosen name and makes it invocable', async () => {
    const sessionId = '99999999-aaaa-bbbb-cccc-dddddddddddd'
    const runId = 'wf_save-run-abc'
    const sessionDir = path.join(
      tmpHome,
      'claude',
      'projects',
      '-tmp-project',
      sessionId,
    )
    await fs.mkdir(path.join(sessionDir, 'workflows'), { recursive: true })
    await fs.writeFile(
      path.join(sessionDir, 'workflows', `my-audit.${runId}.js`),
      VALID_SCRIPT,
      'utf8',
    )
    const journal = new WorkflowJournal(
      path.join(sessionDir, 'subagents', 'workflows', runId, 'journal.jsonl'),
    )
    const completed = makeRuntimeHarness(runId, journal)
    completed.harness.phase('Scan')
    await completed.harness.agent('scan')
    await journal.flush()

    const detailResponse = await call(
      `/api/workflows/runs/${sessionId}/${runId}`,
    )
    expect(detailResponse.status).toBe(200)
    const detail = (await detailResponse.json()) as {
      script: string
      agents: Array<{ result: unknown }>
    }
    expect(detail.agents).toHaveLength(1)

    const saved = await (
      await call('/api/workflows/save', {
        method: 'POST',
        body: {
          script: detail.script,
          name: 'release-audit',
          scope: 'project',
          cwd: projectDir,
        },
      })
    ).json()
    expect(saved).toMatchObject({ ok: true, name: 'release-audit' })
    expect((saved as { filePath: string }).filePath).toBe(
      path.join(projectDir, '.claude', 'workflows', 'release-audit.js'),
    )

    const originalApiKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const { clearCommandMemoizationCaches, getCommands } = await import(
      '../../commands.js'
    )
    try {
      // A new desktop session spawns a fresh CLI process. Clearing the module
      // memo here models that process boundary before command discovery.
      clearCommandMemoizationCaches()
      const command = (await getCommands(projectDir)).find(
        candidate => candidate.name === 'release-audit',
      )
      expect(command).toBeDefined()
      expect(command?.type).toBe('prompt')
      if (command?.type === 'prompt') {
        expect(await command.getPromptForCommand('src/routes')).toEqual([
          expect.objectContaining({
            type: 'text',
            text: expect.stringContaining('{ name: "release-audit" }'),
          }),
        ])
      }
    } finally {
      clearCommandMemoizationCaches()
      if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = originalApiKey
    }
  })

  it('rejects a name intercepted by the desktop command router', async () => {
    const response = await call('/api/workflows/save', {
      method: 'POST',
      body: {
        script: VALID_SCRIPT,
        name: 'save-workflow',
        scope: 'project',
        cwd: projectDir,
      },
    })

    expect(response.status).toBe(400)
    expect(await response.text()).toContain('reserved by the desktop')
  })

  it('rejects saving a script that does not compile', async () => {
    const response = await call('/api/workflows/save', {
      method: 'POST',
      body: {
        script:
          "export const meta = { name: 'broken', description: 'x' }\nconst a: string = 1\n",
        scope: 'user',
      },
    })
    expect(response.status).toBe(400)
  })

  it('uses the CLI project scope when saving from a nested worktree', async () => {
    const packageRoot = path.join(projectDir, 'packages', 'api')
    const nestedCwd = path.join(packageRoot, 'src', 'routes')
    const workflowsDir = path.join(packageRoot, '.claude', 'workflows')
    await fs.mkdir(nestedCwd, { recursive: true })
    await fs.mkdir(workflowsDir, { recursive: true })

    const response = await call('/api/workflows/save', {
      method: 'POST',
      body: {
        script: VALID_SCRIPT,
        name: 'nested-audit',
        scope: 'project',
        cwd: nestedCwd,
      },
    })
    expect(response.status).toBe(200)
    const saved = (await response.json()) as { filePath: string }
    expect(saved.filePath).toBe(path.join(workflowsDir, 'nested-audit.js'))
    expect(await fs.readFile(saved.filePath, 'utf8')).toContain(
      "name: 'nested-audit'",
    )

    const deleted = await call(
      `/api/workflows/nested-audit?scope=project&cwd=${encodeURIComponent(nestedCwd)}`,
      { method: 'DELETE' },
    )
    expect(deleted.status).toBe(200)
    await expect(fs.stat(saved.filePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reconstructs a past run from its script and journal', async () => {
    const sessionId = '11111111-2222-3333-4444-555555555555'
    const sessionDir = path.join(
      tmpHome,
      'claude',
      'projects',
      '-tmp-project',
      sessionId,
    )
    await fs.mkdir(path.join(sessionDir, 'workflows'), { recursive: true })
    await fs.writeFile(
      path.join(sessionDir, 'workflows', 'my-audit.wf_abc12345-def.js'),
      VALID_SCRIPT,
      'utf8',
    )
    const journalDir = path.join(
      sessionDir,
      'subagents',
      'workflows',
      'wf_abc12345-def',
    )
    await fs.mkdir(journalDir, { recursive: true })
    await fs.writeFile(
      path.join(journalDir, 'journal.jsonl'),
      [
        JSON.stringify({ type: 'started', key: '|scan|null', agentId: 'a1' }),
        JSON.stringify({
          type: 'result',
          key: '|scan|null',
          agentId: 'a1',
          result: 'found nothing',
        }),
        'not json at all',
      ].join('\n'),
      'utf8',
    )

    const runs = (await (await call('/api/workflows/runs')).json()) as {
      runs: Array<{ runId: string; workflowName: string; completedAgents: number }>
    }
    expect(runs.runs).toHaveLength(1)
    expect(runs.runs[0]).toMatchObject({
      runId: 'wf_abc12345-def',
      workflowName: 'my-audit',
      completedAgents: 1,
    })

    const detail = (await (
      await call(`/api/workflows/runs/${sessionId}/wf_abc12345-def`)
    ).json()) as {
      script: string
      description?: string
      agents: Array<{ agentId: string; result: unknown; key: string }>
    }
    expect(detail.script).toBe(VALID_SCRIPT)
    expect(detail.description).toBe('Audit the routes')
    expect(detail.agents).toHaveLength(1)
    expect(detail.agents[0]?.result).toBe('found nothing')
    // The raw journal key chains every prior prompt — the API must not leak it.
    expect(detail.agents[0]?.key).not.toContain('scan')
  })

  it('restores root and agent-owned run status from persisted lifecycle transitions', async () => {
    const sessionId = '77777777-2222-3333-4444-555555555555'
    const configProjectDir = path.join(tmpHome, 'claude', 'projects', '-tmp-project')
    const sessionDir = path.join(configProjectDir, sessionId)
    const workflowsDir = path.join(sessionDir, 'workflows')
    const subagentsDir = path.join(sessionDir, 'subagents')
    await fs.mkdir(workflowsDir, { recursive: true })
    await fs.mkdir(subagentsDir, { recursive: true })

    const definitions = [
      { runId: 'wf_complete-123', taskId: 'task-complete', name: 'complete-run', agentId: 'worker-complete', ownerAgentId: undefined },
      { runId: 'wf_failed-123', taskId: 'task-failed', name: 'failed-run', agentId: 'worker-failed', ownerAgentId: 'owner-fragment-a' },
      { runId: 'wf_stopped-123', taskId: 'task-stopped', name: 'stopped-run', agentId: 'worker-stopped', ownerAgentId: 'owner-fragment-a' },
      { runId: 'wf_running-123', taskId: 'task-running', name: 'running-run', agentId: 'worker-running', ownerAgentId: undefined },
      { runId: 'wf_owner-running-123', taskId: 'task-failed', name: 'owner-running-run', agentId: 'worker-owner-running', ownerAgentId: 'owner-fragment-b' },
    ]
    for (const [index, definition] of definitions.entries()) {
      await fs.writeFile(
        path.join(workflowsDir, `${definition.name}.${definition.runId}.js`),
        VALID_SCRIPT,
        'utf8',
      )
      await fs.writeFile(
        path.join(subagentsDir, `agent-${definition.agentId}.meta.json`),
        JSON.stringify({
          agentType: 'general-purpose',
          workflow: {
            runId: definition.runId,
            name: definition.name,
            phaseIndex: 1,
            phaseTitle: 'Review',
            agentIndex: index + 1,
          },
        }),
        'utf8',
      )
      const journalDir = path.join(subagentsDir, 'workflows', definition.runId)
      await fs.mkdir(journalDir, { recursive: true })
      await fs.writeFile(
        path.join(journalDir, 'journal.jsonl'),
        `${JSON.stringify({ type: 'started', key: `key-${index}`, agentId: definition.agentId })}\n${
          definition.runId === 'wf_complete-123'
            ? `${JSON.stringify({ type: 'result', key: `key-${index}`, agentId: definition.agentId, result: 'ok' })}\n`
            : ''
        }`,
        'utf8',
      )
    }
    await fs.writeFile(
      path.join(subagentsDir, 'agent-worker-caught.meta.json'),
      JSON.stringify({
        agentType: 'general-purpose',
        workflow: {
          runId: definitions[0]!.runId,
          name: definitions[0]!.name,
          phaseIndex: 1,
          phaseTitle: 'Review',
          agentIndex: definitions.length + 1,
        },
      }),
      'utf8',
    )
    await fs.appendFile(
      path.join(subagentsDir, 'workflows', definitions[0]!.runId, 'journal.jsonl'),
      `${JSON.stringify({ type: 'started', key: 'key-caught', agentId: 'worker-caught' })}\n`,
      'utf8',
    )

    const launchEntry = (
      definition: typeof definitions[number],
      timestamp: string,
    ) => ({
      type: 'user',
      uuid: `launch-${definition.taskId}`,
      timestamp,
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: `tool-${definition.taskId}`,
          content: JSON.stringify({
            status: 'async_launched',
            taskId: definition.taskId,
            taskType: 'local_workflow',
            workflowName: definition.name,
            runId: definition.runId,
          }),
        }],
      },
    })
    const terminalEntry = (
      definition: typeof definitions[number],
      status: 'completed' | 'failed' | 'stopped',
      timestamp: string,
    ) => ({
      type: 'cc-haha-task-notification',
      isMeta: true,
      timestamp,
      taskNotification: {
        taskId: definition.taskId,
        toolUseId: `tool-${definition.taskId}`,
        ...(definition.ownerAgentId ? { ownerAgentId: definition.ownerAgentId } : {}),
        status,
        summary: `${definition.name} ${status}`,
        timestamp,
      },
    })

    await fs.writeFile(
      path.join(configProjectDir, `${sessionId}.jsonl`),
      [
        launchEntry(definitions[0]!, '2026-01-01T00:00:01.000Z'),
        terminalEntry(definitions[0]!, 'completed', '2026-01-01T00:00:02.000Z'),
        launchEntry(definitions[3]!, '2026-01-01T00:00:07.000Z'),
        terminalEntry(definitions[1]!, 'failed', '2026-01-01T00:00:04.000Z'),
        terminalEntry(definitions[2]!, 'stopped', '2026-01-01T00:00:06.000Z'),
      ].map(entry => JSON.stringify(entry)).join('\n') + '\n',
      'utf8',
    )
    await fs.writeFile(
      path.join(subagentsDir, 'agent-owner-fragment-a.jsonl'),
      [
        launchEntry(definitions[1]!, '2026-01-01T00:00:03.000Z'),
        launchEntry(definitions[2]!, '2026-01-01T00:00:05.000Z'),
      ].map(entry => JSON.stringify(entry)).join('\n') + '\n',
      'utf8',
    )
    await fs.writeFile(
      path.join(subagentsDir, 'agent-owner-fragment-b.jsonl'),
      `${JSON.stringify(launchEntry(definitions[4]!, '2026-01-01T00:00:08.000Z'))}\n`,
      'utf8',
    )

    const response = await call(`/api/workflows/session-runs/${sessionId}`)
    expect(response.status).toBe(200)
    const body = await response.json() as {
      runs: Array<{
        runId: string
        taskId: string
        ownerAgentId?: string
        status: string
        agents: Array<{ agentId: string; state: string; skipped?: boolean }>
      }>
    }
    const byRunId = new Map(body.runs.map(run => [run.runId, run]))
    expect(byRunId.get('wf_complete-123')).toMatchObject({
      taskId: 'task-complete',
      status: 'completed',
    })
    expect(byRunId.get('wf_complete-123')?.agents).toContainEqual(expect.objectContaining({
      agentId: 'worker-complete',
      state: 'done',
    }))
    expect(byRunId.get('wf_complete-123')?.agents).toContainEqual(expect.objectContaining({
      agentId: 'worker-caught',
      state: 'done',
      skipped: true,
    }))
    expect(byRunId.get('wf_failed-123')).toMatchObject({
      taskId: 'task-failed',
      ownerAgentId: 'owner-fragment-a',
      status: 'failed',
      agents: [{ state: 'error' }],
    })
    expect(byRunId.get('wf_stopped-123')).toMatchObject({
      taskId: 'task-stopped',
      ownerAgentId: 'owner-fragment-a',
      status: 'stopped',
      agents: [{ state: 'error', skipped: true }],
    })
    expect(byRunId.get('wf_running-123')).toMatchObject({
      taskId: 'task-running',
      status: 'running',
      agents: [{ state: 'progress' }],
    })
    expect(byRunId.get('wf_owner-running-123')).toMatchObject({
      taskId: 'task-failed',
      ownerAgentId: 'owner-fragment-b',
      status: 'running',
      agents: [{ state: 'progress' }],
    })
  })

  it('keeps a failed transcript-only run that ended before its first agent', async () => {
    const sessionId = '88888888-2222-3333-4444-555555555555'
    const runId = 'wf_zero-agent-123'
    const taskId = 'task-zero-agent'
    const projectDir = path.join(tmpHome, 'claude', 'projects', '-tmp-project')
    await fs.mkdir(projectDir, { recursive: true })
    await fs.writeFile(
      path.join(projectDir, `${sessionId}.jsonl`),
      [
        {
          type: 'user',
          timestamp: '2026-01-01T00:00:01.000Z',
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: 'tool-zero-agent',
              content: JSON.stringify({
                status: 'async_launched',
                taskId,
                taskType: 'local_workflow',
                workflowName: 'zero-agent-run',
                runId,
              }),
            }],
          },
        },
        {
          type: 'cc-haha-task-notification',
          isMeta: true,
          timestamp: '2026-01-01T00:00:02.000Z',
          taskNotification: {
            taskId,
            toolUseId: 'tool-zero-agent',
            status: 'failed',
            summary: 'validation failed before spawn',
            timestamp: '2026-01-01T00:00:02.000Z',
          },
        },
      ].map(entry => JSON.stringify(entry)).join('\n') + '\n',
      'utf8',
    )

    const response = await call(`/api/workflows/session-runs/${sessionId}`)
    expect(response.status).toBe(200)
    const body = await response.json() as {
      runs: Array<{
        runId: string
        taskId: string
        status: string
        error?: string
        agents: unknown[]
      }>
    }
    expect(body.runs).toEqual([expect.objectContaining({
      runId,
      taskId,
      status: 'failed',
      error: 'validation failed before spawn',
      agents: [],
    })])
  })

  it('uses the newest sidecar for an agent index after a resumed insertion', async () => {
    const sessionId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
    const runId = 'wf_sidecar1-abc'
    const sessionDir = path.join(
      tmpHome,
      'claude',
      'projects',
      '-tmp-project',
      sessionId,
    )
    const workflowsDir = path.join(sessionDir, 'workflows')
    const subagentsDir = path.join(sessionDir, 'subagents')
    await fs.mkdir(workflowsDir, { recursive: true })
    await fs.mkdir(subagentsDir, { recursive: true })
    await fs.writeFile(
      path.join(workflowsDir, `my-audit.${runId}.js`),
      VALID_SCRIPT,
      'utf8',
    )
    const projectRoot = path.dirname(sessionDir)
    await fs.writeFile(path.join(projectRoot, `${sessionId}.jsonl`), '', 'utf8')

    // The latest attempt is authoritative even when its output is missing.
    // An older, readable output must not put the pre-resume shape back on top
    // of the newest sidecars.
    const oldTaskId = 'woldside1'
    const latestTaskId = 'wnewside1'
    const outputDir = path.join(taskOutputRoot!, sessionId, 'tasks')
    const oldOutput = path.join(outputDir, `${oldTaskId}.output`)
    await fs.mkdir(outputDir, { recursive: true })
    const staleJournal = new WorkflowJournal(
      path.join(sessionDir, 'subagents', 'workflows', runId, 'journal.jsonl'),
    )
    const stale = makeRuntimeHarness(runId, staleJournal)
    stale.harness.phase('Run')
    await stale.harness.agent('STALE')
    await staleJournal.flush()
    await writeRuntimeTaskOutput({
      taskId: oldTaskId,
      runId,
      outputFile: oldOutput,
      events: stale.events,
    })
    await sessionService.appendSessionTaskNotification(sessionId, {
      taskId: oldTaskId,
      toolUseId: 'tool-old-sidecar',
      workflowRunId: runId,
      status: 'stopped',
      outputFile: oldOutput,
      timestamp: '2026-08-10T01:00:00.000Z',
    })
    await fs.appendFile(
      path.join(projectRoot, `${sessionId}.jsonl`),
      `${JSON.stringify({
        type: 'user',
        uuid: 'launch-latest-sidecar',
        timestamp: '2026-08-10T01:01:00.000Z',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tool-new-sidecar',
            content: JSON.stringify({
              status: 'async_launched',
              taskId: latestTaskId,
              taskType: 'local_workflow',
              workflowName: 'my-audit',
              runId,
            }),
          }],
        },
      })}\n`,
      'utf8',
    )

    const writeSidecar = async (
      agentId: string,
      label: string,
      agentIndex: number,
      modifiedAt: Date,
    ) => {
      const filePath = path.join(subagentsDir, `agent-${agentId}.meta.json`)
      await fs.writeFile(
        filePath,
        JSON.stringify({
          description: label,
          workflow: {
            runId,
            name: 'my-audit',
            phaseIndex: 1,
            phaseTitle: 'Run',
            agentIndex,
          },
        }),
        'utf8',
      )
      await fs.utimes(filePath, modifiedAt, modifiedAt)
    }

    const oldTime = new Date('2026-08-10T01:00:00.000Z')
    const resumedTime = new Date('2026-08-10T01:01:00.000Z')
    await writeSidecar('00-old-a', 'A', 1, oldTime)
    await writeSidecar('00-old-b', 'B', 2, oldTime)
    await writeSidecar('00-old-c', 'C', 3, oldTime)
    await writeSidecar('00-old-d', 'D', 5, oldTime)
    await writeSidecar('zz-new-x', 'X', 2, resumedTime)
    await writeSidecar('zz-new-b', 'B', 3, resumedTime)
    await writeSidecar('zz-new-c', 'C', 4, resumedTime)

    const response = await call(`/api/workflows/session-runs/${sessionId}`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      runs: Array<{
        runId: string
        taskId: string
        status: string
        progress?: Array<{ type: string; label?: string }>
        agents: Array<{ agentId: string; label: string; agentIndex: number }>
      }>
    }
    expect(body.runs).toHaveLength(1)
    expect(body.runs[0]?.runId).toBe(runId)
    expect(body.runs[0]?.taskId).toBe(latestTaskId)
    expect(body.runs[0]?.status).toBe('running')
    expect(body.runs[0]?.progress).toBeUndefined()
    expect(
      body.runs[0]?.agents.map(agent => [
        agent.agentIndex,
        agent.label,
        agent.agentId,
      ]),
    ).toEqual([
      [1, 'A', '00-old-a'],
      [2, 'X', 'zz-new-x'],
      [3, 'B', 'zz-new-b'],
      [4, 'C', 'zz-new-c'],
    ])
  })

  it.each(['direct', 'aliased', 'escaping'])('reconstructs resumed progress only within the permitted root (%s)', async rootKind => {
    let physicalOutputRoot = taskOutputRoot!
    let aliasedTempRoot: string | undefined
    if (rootKind === 'aliased') {
      const actualRoot = getClaudeTempDir()
      await fs.mkdir(actualRoot, { recursive: true })
      const rootAlias = path.join(tmpHome, 'output-root-alias')
      await fs.symlink(path.resolve(actualRoot), rootAlias, process.platform === 'win32' ? 'junction' : 'dir')
      expect((await fs.stat(rootAlias)).isDirectory()).toBe(true)
      // Reproduce the lexical/canonical mismatch of Windows 8.3 temp roots
      // with a real filesystem alias on every supported host.
      aliasedTempRoot = rootAlias
      taskOutputRoot = path.join(rootAlias, `wf-api-${path.basename(tmpHome)}`)
    } else if (rootKind === 'escaping') {
      await fs.mkdir(getClaudeTempDir(), { recursive: true })
      const outsideRoot = path.join(tmpHome, 'outside-output')
      await fs.mkdir(outsideRoot)
      await fs.symlink(outsideRoot, taskOutputRoot!, process.platform === 'win32' ? 'junction' : 'dir')
      physicalOutputRoot = outsideRoot
    }
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const runId = 'wf_resume12-abc'
    const projectRoot = path.join(tmpHome, 'claude', 'projects', '-tmp-project')
    const sessionDir = path.join(projectRoot, sessionId)
    await fs.mkdir(path.join(sessionDir, 'workflows'), { recursive: true })
    await fs.writeFile(
      path.join(sessionDir, 'workflows', `my-audit.${runId}.js`),
      VALID_SCRIPT,
      'utf8',
    )
    // The task-notification transition appends to the parent session
    // transcript; run artifacts live in its sibling directory.
    await fs.writeFile(path.join(projectRoot, `${sessionId}.jsonl`), '', 'utf8')

    const oldTaskId = 'wold12345'
    const resumedTaskId = 'wnew12345'
    const outputDir = path.join(taskOutputRoot!, sessionId, 'tasks')
    // Bun on Windows cannot recursively mkdir through a junction; prepare the
    // real directory, then exercise all API reads through the alias below.
    await fs.mkdir(path.join(physicalOutputRoot, sessionId, 'tasks'), { recursive: true })
    const oldOutput = path.join(outputDir, `${oldTaskId}.output`)
    const resumedOutput = path.join(outputDir, `${resumedTaskId}.output`)
    const journal = new WorkflowJournal(
      path.join(sessionDir, 'subagents', 'workflows', runId, 'journal.jsonl'),
    )
    const first = makeRuntimeHarness(runId, journal)
    first.harness.phase('Run')
    await first.harness.agent('A')
    await first.harness.agent('B')
    await first.harness.agent('C')
    await journal.flush()
    await writeRuntimeTaskOutput({
      taskId: oldTaskId,
      runId,
      outputFile: oldOutput,
      events: first.events,
    })

    const resumed = makeRuntimeHarness(runId, journal, await journal.load())
    resumed.harness.phase('Run')
    await resumed.harness.agent('A')
    await resumed.harness.agent('X')
    await resumed.harness.agent('B')
    await resumed.harness.agent('C')
    await journal.flush()
    await writeRuntimeTaskOutput({
      taskId: resumedTaskId,
      runId,
      outputFile: resumedOutput,
      events: resumed.events,
    })
    await sessionService.appendSessionTaskNotification(sessionId, {
      taskId: oldTaskId,
      toolUseId: 'tool-old',
      workflowRunId: runId,
      status: 'stopped',
      outputFile: oldOutput,
      timestamp: '2026-08-10T01:00:00.000Z',
    })
    await sessionService.appendSessionTaskNotification(sessionId, {
      taskId: resumedTaskId,
      toolUseId: 'tool-new',
      workflowRunId: runId,
      status: 'completed',
      outputFile: resumedOutput,
      timestamp: '2026-08-10T01:01:00.000Z',
    })

    if (aliasedTempRoot) {
      tempRootSpy = spyOn(filesystemPermissions, 'getClaudeTempDir').mockReturnValue(aliasedTempRoot)
    }
    const response = await call(`/api/workflows/session-runs/${sessionId}`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      runs: Array<{
        runId: string
        progress: Array<{ type: string; label?: string; cached?: boolean }>
      }>
    }
    expect(body.runs).toHaveLength(1)
    expect(body.runs[0]?.runId).toBe(runId)
    if (rootKind === 'escaping') {
      expect(body.runs[0]?.progress).toBeUndefined()
      return
    }
    const agents = body.runs[0]!.progress.filter(
      event => event.type === 'workflow_agent',
    )
    expect(agents.map(agent => agent.label)).toEqual(['A', 'X', 'B', 'C'])
    expect(agents.filter(agent => agent.cached).map(agent => agent.label)).toEqual(['A'])

    const originalFetch = globalThis.fetch
    try {
      setBaseUrl('http://workflow.test')
      globalThis.fetch = async (input, init) => {
        const request = new Request(input, init)
        const url = new URL(request.url)
        return handleWorkflowsApi(
          request,
          url,
          url.pathname.split('/').filter(Boolean),
        )
      }
      useWorkflowStore.setState({ runs: {} })
      await useWorkflowStore.getState().hydrateSession(sessionId)
      await useWorkflowStore.getState().hydrateSession(sessionId)

      const hydratedRuns = runsForSession(
        useWorkflowStore.getState(),
        sessionId,
      )
      const activity = buildSessionActivityModel({
        sessionId,
        tasks: [],
        completedAndDismissed: false,
        backgroundTasks: [],
        agentNotifications: [],
        workflowRuns: hydratedRuns,
      })
      const hydratedAgents = activity.sections.workflow.rows.filter(
        row => !row.groupProgress,
      )
      expect(hydratedRuns).toHaveLength(1)
      expect(
        hydratedAgents.map(row => [row.label, row.cached === true]),
      ).toEqual([
        ['A', true],
        ['X', false],
        ['B', false],
        ['C', false],
      ])
    } finally {
      useWorkflowStore.setState({ runs: {} })
      globalThis.fetch = originalFetch
      setBaseUrl(getDefaultBaseUrl())
    }
  })

  it('404s an unknown run', async () => {
    const response = await call('/api/workflows/runs/nope/wf_000000-aaa')
    expect(response.status).toBe(404)
  })

  it('refuses to write through a symlinked target', async () => {
    const workflowsDir = path.join(tmpHome, 'claude', 'workflows')
    await fs.mkdir(workflowsDir, { recursive: true })
    const outsideDir = path.join(tmpHome, 'outside')
    await fs.mkdir(outsideDir)
    const outside = path.join(outsideDir, 'outside.js')
    await fs.writeFile(outside, '// pre-existing\n', 'utf8')
    // Junctions are real symbolic links according to lstat on Windows; the
    // final-entry guard must reject them before trying to write the script.
    await fs.symlink(
      process.platform === 'win32' ? outsideDir : outside,
      path.join(workflowsDir, 'my-audit.js'),
      process.platform === 'win32' ? 'junction' : 'file',
    )
    expect((await fs.lstat(path.join(workflowsDir, 'my-audit.js'))).isSymbolicLink()).toBe(true)

    const response = await call('/api/workflows/save', {
      method: 'POST',
      body: { script: VALID_SCRIPT, scope: 'user' },
    })
    expect(response.status).toBe(400)
    expect((await response.json()).message).toContain('Refusing to write through a symlink')
    expect(await fs.readFile(outside, 'utf8')).toBe('// pre-existing\n')
  })

  it('403s every route when workflows are disabled', async () => {
    await fs.mkdir(path.join(tmpHome, 'claude'), { recursive: true })
    await fs.writeFile(
      path.join(tmpHome, 'claude', 'settings.json'),
      JSON.stringify({ disableWorkflows: true }),
      'utf8',
    )
    resetSettingsCache()

    expect((await call('/api/workflows')).status).toBe(403)
    expect((await call('/api/workflows/runs')).status).toBe(403)
  })
})
