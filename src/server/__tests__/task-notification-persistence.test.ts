import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  __persistCliTaskNotificationForTests,
  __resetWebSocketHandlerStateForTests,
} from '../ws/handler.js'
import { SessionService, sessionService } from '../services/sessionService.js'

describe('background task notification persistence', () => {
  let configDir = ''
  let previousConfigDir: string | undefined

  beforeEach(async () => {
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-task-notification-'))
    process.env.CLAUDE_CONFIG_DIR = configDir
    await fs.mkdir(path.join(configDir, 'projects'), { recursive: true })
  })

  afterEach(async () => {
    __resetWebSocketHandlerStateForTests()
    mock.restore()
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    await fs.rm(configDir, { recursive: true, force: true })
  })

  it('restores a terminal Agent notification that was not forwarded into transcript history', async () => {
    const sessionId = crypto.randomUUID()
    const projectDir = path.join(configDir, 'projects', '-tmp-background-agent')
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`)
    await fs.mkdir(projectDir, { recursive: true })
    await fs.writeFile(transcriptPath, `${JSON.stringify({
      type: 'assistant',
      uuid: crypto.randomUUID(),
      timestamp: '2026-07-18T00:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'agent-tool-1',
          name: 'Agent',
          input: { description: 'Verify background restore', run_in_background: true },
        }],
      },
    })}\n`, 'utf8')

    const service = new SessionService()
    await service.appendSessionTaskNotification(sessionId, {
      taskId: 'agent-task-1',
      toolUseId: 'agent-tool-1',
      status: 'completed',
      workflowRunId: 'wf_persisted-run',
      summary: 'Agent completed after the foreground Skill output',
      result: 'Background verification passed',
      timestamp: '2026-07-18T00:01:00.000Z',
    })

    expect(await service.getSessionTaskNotifications(sessionId)).toEqual([{
      taskId: 'agent-task-1',
      toolUseId: 'agent-tool-1',
      status: 'completed',
      workflowRunId: 'wf_persisted-run',
      summary: 'Agent completed after the foreground Skill output',
      result: 'Background verification passed',
      timestamp: '2026-07-18T00:01:00.000Z',
    }])
    expect(await fs.readFile(transcriptPath, 'utf8')).toContain('"type":"cc-haha-task-notification"')
  })

  it('aborts and drains an in-flight task append before clearing the transcript', async () => {
    const sessionId = crypto.randomUUID()
    const projectDir = path.join(configDir, 'projects', '-tmp-clear-task-append')
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`)
    await fs.mkdir(projectDir, { recursive: true })
    await fs.writeFile(transcriptPath, `${JSON.stringify({
      type: 'session-meta',
      isMeta: true,
      workDir: '/tmp/clear-task-append',
      timestamp: '2026-07-18T00:00:00.000Z',
    })}\n`, 'utf8')

    const realOpen = fs.open
    const realWriteFile = fs.writeFile
    let appendClosed = false
    let markAppendStarted!: () => void
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve
    })
    spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args)
      const realClose = handle.close.bind(handle)
      spyOn(handle, 'close').mockImplementation(async () => {
        await realClose()
        appendClosed = true
      })
      spyOn(handle, 'writeFile').mockImplementation((_data, options) => {
        markAppendStarted()
        const signal = typeof options === 'object' ? options?.signal : undefined
        return new Promise<void>((resolve) => {
          if (signal?.aborted) resolve()
          else signal?.addEventListener('abort', () => resolve(), { once: true })
        })
      })
      return handle
    })
    spyOn(fs, 'writeFile').mockImplementation((...args) => {
      expect(appendClosed).toBe(true)
      return realWriteFile(...args)
    })

    const service = new SessionService()
    const append = service.appendSessionTaskNotification(sessionId, {
      taskId: 'agent-task-clear-race',
      toolUseId: 'agent-tool-clear-race',
      status: 'stopped',
      summary: 'This old generation must not survive clear',
      timestamp: '2026-07-18T00:01:00.000Z',
    })
    await appendStarted

    await service.clearSessionTranscript(sessionId, '/tmp/clear-task-append')
    await append

    const cleared = await fs.readFile(transcriptPath, 'utf8')
    expect(cleared).not.toContain('cc-haha-task-notification')
    expect(cleared).not.toContain('agent-task-clear-race')
    expect(cleared).toContain('"type":"session-meta"')
  })

  it('restores an aborted terminal notification when transcript clear fails', async () => {
    const sessionId = crypto.randomUUID()
    const projectDir = path.join(configDir, 'projects', '-tmp-failed-clear-task-append')
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`)
    await fs.mkdir(projectDir, { recursive: true })
    await fs.writeFile(transcriptPath, `${JSON.stringify({
      type: 'session-meta',
      isMeta: true,
      workDir: '/tmp/failed-clear-task-append',
      timestamp: '2026-07-18T00:00:00.000Z',
    })}\n`, 'utf8')

    const realOpen = fs.open
    let appendAttempts = 0
    let abortedAppendClosed = false
    let markAppendStarted!: () => void
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve
    })
    spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args)
      appendAttempts++
      if (appendAttempts > 1) return handle
      const realClose = handle.close.bind(handle)
      spyOn(handle, 'close').mockImplementation(async () => {
        await realClose()
        abortedAppendClosed = true
      })
      spyOn(handle, 'writeFile').mockImplementation((_data, options) => {
        markAppendStarted()
        const signal = typeof options === 'object' ? options?.signal : undefined
        return new Promise<void>((_resolve, reject) => {
          const rejectAbort = () => {
            const error = new Error('The operation was aborted')
            error.name = 'AbortError'
            reject(error)
          }
          if (signal?.aborted) rejectAbort()
          else signal?.addEventListener('abort', rejectAbort, { once: true })
        })
      })
      return handle
    })
    spyOn(fs, 'writeFile').mockImplementation(() => {
      expect(abortedAppendClosed).toBe(true)
      return Promise.reject(new Error('transcript replacement failed'))
    })

    const service = new SessionService()
    const append = service.appendSessionTaskNotification(sessionId, {
      taskId: 'agent-task-failed-clear-race',
      toolUseId: 'agent-tool-failed-clear-race',
      status: 'completed',
      summary: 'Terminal state must survive a failed clear',
      timestamp: '2026-07-18T00:01:00.000Z',
    })
    void append.catch(() => {})
    await appendStarted

    await expect(
      service.clearSessionTranscript(sessionId, '/tmp/failed-clear-task-append'),
    ).rejects.toThrow('transcript replacement failed')
    await expect(append).rejects.toThrow('The operation was aborted')

    expect(await service.getSessionTaskNotifications(sessionId)).toContainEqual({
      taskId: 'agent-task-failed-clear-race',
      toolUseId: 'agent-tool-failed-clear-race',
      status: 'completed',
      summary: 'Terminal state must survive a failed clear',
      timestamp: '2026-07-18T00:01:00.000Z',
    })
  })

  it('keeps restoring legacy task-notification transcript turns', async () => {
    const sessionId = crypto.randomUUID()
    const projectDir = path.join(configDir, 'projects', '-tmp-legacy-notification')
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`)
    await fs.mkdir(projectDir, { recursive: true })
    await fs.writeFile(transcriptPath, `${JSON.stringify({
      type: 'user',
      uuid: crypto.randomUUID(),
      timestamp: '2026-07-17T00:00:00.000Z',
      message: {
        role: 'user',
        content: '<task-notification>\n<task-id>legacy-task</task-id>\n<tool-use-id>legacy-tool</tool-use-id>\n<status>completed</status>\n<summary>Legacy task completed</summary>\n</task-notification>',
      },
    })}\n`, 'utf8')

    const service = new SessionService()
    expect(await service.getSessionTaskNotifications(sessionId)).toEqual([{
      taskId: 'legacy-task',
      toolUseId: 'legacy-tool',
      status: 'completed',
      summary: 'Legacy task completed',
      timestamp: '2026-07-17T00:00:00.000Z',
    }])
  })

  it('restores workflow run identity from task-notification transcript turns', async () => {
    const sessionId = crypto.randomUUID()
    const projectDir = path.join(configDir, 'projects', '-tmp-workflow-notification')
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`)
    await fs.mkdir(projectDir, { recursive: true })
    await fs.writeFile(transcriptPath, `${JSON.stringify({
      type: 'user',
      uuid: crypto.randomUUID(),
      timestamp: '2026-07-17T00:00:00.000Z',
      message: {
        role: 'user',
        content: '<task-notification>\n<task-id>workflow-task</task-id>\n<tool-use-id>workflow-tool</tool-use-id>\n<workflow-run-id>wf_transcript-run</workflow-run-id>\n<status>completed</status>\n<summary>Workflow completed</summary>\n</task-notification>',
      },
    })}\n`, 'utf8')

    const service = new SessionService()
    expect(await service.getSessionTaskNotifications(sessionId)).toEqual([{
      taskId: 'workflow-task',
      toolUseId: 'workflow-tool',
      status: 'completed',
      workflowRunId: 'wf_transcript-run',
      summary: 'Workflow completed',
      timestamp: '2026-07-17T00:00:00.000Z',
    }])
  })

  it('keeps root and multiple child terminals with the same leaf tool id distinct', async () => {
    const sessionId = crypto.randomUUID()
    const projectDir = path.join(configDir, 'projects', '-tmp-owned-terminals')
    await fs.mkdir(projectDir, { recursive: true })
    await fs.writeFile(
      path.join(projectDir, `${sessionId}.jsonl`),
      `${JSON.stringify({
        type: 'session-meta',
        isMeta: true,
        workDir: '/tmp/owned-terminals',
        timestamp: '2026-08-10T00:00:00.000Z',
      })}\n`,
      'utf8',
    )
    const service = new SessionService()

    await service.appendSessionTaskNotification(sessionId, {
      taskId: 'root-task',
      toolUseId: 'Agent:0',
      status: 'completed',
      timestamp: '2026-08-10T00:00:01.000Z',
    })
    await service.appendSessionTaskNotification(sessionId, {
      taskId: 'child-a-task',
      toolUseId: 'Agent:0',
      ownerAgentId: 'child-a',
      status: 'failed',
      timestamp: '2026-08-10T00:00:02.000Z',
    })
    await service.appendSessionTaskNotification(sessionId, {
      taskId: 'child-b-task',
      toolUseId: 'Agent:0',
      ownerAgentId: 'child-b',
      status: 'stopped',
      timestamp: '2026-08-10T00:00:03.000Z',
    })

    expect(await service.getSessionTaskNotifications(sessionId)).toEqual([
      expect.objectContaining({
        taskId: 'root-task',
        toolUseId: 'Agent:0',
        status: 'completed',
      }),
      expect.objectContaining({
        taskId: 'child-a-task',
        toolUseId: 'Agent:0',
        ownerAgentId: 'child-a',
        status: 'failed',
      }),
      expect.objectContaining({
        taskId: 'child-b-task',
        toolUseId: 'Agent:0',
        ownerAgentId: 'child-b',
        status: 'stopped',
      }),
    ])
  })

  it('restores an owned synthetic stop without degrading it to root scope', async () => {
    const sessionId = crypto.randomUUID()
    const projectDir = path.join(configDir, 'projects', '-tmp-owned-synthetic-stop')
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`)
    await fs.mkdir(projectDir, { recursive: true })
    await fs.writeFile(transcriptPath, `${JSON.stringify({
      type: 'session-meta',
      isMeta: true,
      workDir: '/tmp/owned-synthetic-stop',
      timestamp: '2026-07-18T00:00:00.000Z',
    })}\n`, 'utf8')

    const service = new SessionService()
    await service.appendSessionTaskNotification(sessionId, {
      taskId: 'provider-analyzer-teammate',
      toolUseId: 'provider-analyzer-teammate-tool',
      ownerAgentId: 'provider-analyzer',
      status: 'stopped',
      summary: 'Provider analyzer teammate stopped because the runtime exited',
    })

    expect(await service.getSessionTaskNotifications(sessionId)).toEqual([
      expect.objectContaining({
        taskId: 'provider-analyzer-teammate',
        toolUseId: 'provider-analyzer-teammate-tool',
        ownerAgentId: 'provider-analyzer',
        status: 'stopped',
      }),
    ])
  })

  it('normalizes and persists one terminal SDK event for multiple observers', async () => {
    const append = spyOn(sessionService, 'appendSessionTaskNotification').mockResolvedValue()
    const sdkEvent = {
      type: 'system',
      subtype: 'task_notification',
      uuid: 'terminal-event-1',
      task_id: 'agent-task-1',
      tool_use_id: 'agent-tool-1',
      status: 'completed',
      workflow_run_id: 'wf_sdk-run',
      summary: 'Agent completed',
      result: 'All checks passed',
      output_file: '/tmp/agent-task-1.output',
      owner_agent_id: 'parent-agent',
      timestamp: '2026-07-18T00:01:00.000Z',
    }

    const first = __persistCliTaskNotificationForTests('session-1', sdkEvent)
    const second = __persistCliTaskNotificationForTests('session-1', sdkEvent)
    expect(first).not.toBeNull()
    expect(second).toBe(first)
    await Promise.all([first, second])

    expect(append).toHaveBeenCalledTimes(1)
    expect(append).toHaveBeenCalledWith('session-1', {
      taskId: 'agent-task-1',
      toolUseId: 'agent-tool-1',
      status: 'completed',
      workflowRunId: 'wf_sdk-run',
      summary: 'Agent completed',
      result: 'All checks passed',
      outputFile: '/tmp/agent-task-1.output',
      ownerAgentId: 'parent-agent',
      timestamp: '2026-07-18T00:01:00.000Z',
    })
  })
})
