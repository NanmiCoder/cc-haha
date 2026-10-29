import { stat } from 'node:fs/promises'
import { sessionService } from './sessionService.js'
import { SettingsService } from './settingsService.js'
import { ProviderService } from './providerService.js'
import { observeSessionTurns } from './sessionTurnEvents.js'
import { getCollaborationRuntime, getSessionTurnState, stopScheduledTaskTurn, submitScheduledTaskTurn } from '../ws/handler.js'
import { resolveSessionRuntime, validateSessionRuntime } from './sessionModelCatalog.js'
import { setScheduledSessionTaskExecutor, type ScheduledSessionTaskInput, type ScheduledSessionTaskResult } from './scheduledTaskExecution.js'
import { formatScheduledTaskPrompt } from '../../utils/scheduledTaskMessage.js'
import { registerScheduledTaskNotificationRun } from './scheduledTaskNotificationDecision.js'

export function configureScheduledTaskHost(serverHost: string, serverPort: number): () => void {
  return setScheduledSessionTaskExecutor({
    async canStart(task) {
      return task.execution?.kind !== 'session' || getSessionTurnState(task.execution.targetSessionId) === 'idle'
    },
    execute: input => executeScheduledSessionTask(input, { serverHost, serverPort }),
  })
}

async function resolveTarget(input: ScheduledSessionTaskInput): Promise<string> {
  const { task } = input
  if (task.execution?.kind === 'session') {
    const id = task.execution.targetSessionId
    if (!await sessionService.getSessionSummary(id)) throw new Error('Scheduled task target session no longer exists')
    const workDir = await sessionService.getSessionWorkDir(id)
    if (!workDir || !(await stat(workDir)).isDirectory()) throw new Error('Scheduled task workspace is unavailable')
    await validateSessionRuntime(await getCollaborationRuntime(id))
    return id
  }
  if (task.execution?.kind !== 'new-session') throw new Error('Missing scheduled session execution mode')
  const source = task.sourceSessionId
  const sourceInfo = source ? await sessionService.getSessionLaunchInfo(source) : undefined
  if (source && !sourceInfo) throw new Error('Scheduled task source session no longer exists')
  const workDir = task.folderPath || sourceInfo?.workDir
  if (!workDir || !(await stat(workDir)).isDirectory()) throw new Error('Scheduled task workspace is unavailable')
  // An omitted provider follows the desktop default; explicit null means Claude
  // official. Keep those distinct, including when multiple providers share a model.
  const providerId = source || task.providerId !== undefined
    ? task.providerId
    : (await new ProviderService().listProviders()).activeId
  // A task with no explicit selection follows the same desktop defaults as a
  // normal new chat. In native settings/env mode there is no catalogued OAuth
  // identity to validate or persist. Explicit null still means Claude OAuth.
  const followsNativeDefaults = !source && task.providerId === undefined && task.model === undefined && providerId == null
  const inherited = source ? await getCollaborationRuntime(source) : { providerId: providerId ?? null, modelId: task.model ?? 'default' }
  const runtime = followsNativeDefaults ? undefined : await validateSessionRuntime(await resolveSessionRuntime({ model: task.model, providerId }, inherited))
  const permissionMode = sourceInfo?.permissionMode ?? task.permissionMode ?? await new SettingsService().getPermissionMode()
  if (!await input.canSend()) throw new Error('Scheduled task changed before session creation')
  const created = await sessionService.createSession(workDir, task.useWorktree ? { worktree: true } : undefined, permissionMode)
  await sessionService.appendSessionMetadata(created.sessionId, {
    workDir: created.workDir, customTitle: task.name || task.prompt.slice(0, 80), permissionMode,
    ...(runtime ? {
      runtimeProviderId: runtime.providerId, runtimeModelId: runtime.modelId,
      effortLevel: runtime.effortLevel, openAIFastMode: runtime.openAIFastMode ?? false,
    } : {}),
  })
  return created.sessionId
}

export async function executeScheduledSessionTask(
  input: ScheduledSessionTaskInput,
  endpoint: { serverHost: string; serverPort: number },
): Promise<ScheduledSessionTaskResult> {
  let sessionId: string | undefined
  try {
    input.signal.throwIfAborted()
    sessionId = await resolveTarget(input)
    await input.onSessionResolved?.(sessionId)
    input.signal.throwIfAborted()
    if (!await input.canSend()) throw new Error('Scheduled task changed before delivery')
    // A human can start a turn while target/runtime validation awaits I/O.
    // Wait before observing output so that turn's stop/result cannot settle ours.
    // Once idle, there is no await before submit reserves the normal turn slot.
    while (getSessionTurnState(sessionId) !== 'idle') {
      await new Promise<void>((resolve, reject) => {
        const abortWait = () => {
          clearTimeout(timer)
          input.signal.removeEventListener('abort', abortWait)
          reject(input.signal.reason ?? new Error('Scheduled task interrupted'))
        }
        const timer = setTimeout(() => {
          input.signal.removeEventListener('abort', abortWait)
          resolve()
        }, 250)
        input.signal.addEventListener('abort', abortWait, { once: true })
        if (input.signal.aborted) abortWait()
      })
      if (!await input.canSend()) throw new Error('Scheduled task changed while waiting for the conversation')
    }
  } catch (error) {
    return { status: input.signal.aborted ? 'timeout' : 'failed', sessionId, error: error instanceof Error ? error.message : String(error) }
  }
  const target = sessionId
  const notification = registerScheduledTaskNotificationRun(input.runId, target)
  let consumed = false
  let settled = false
  let dispose = () => {}
  let finish!: (result: ScheduledSessionTaskResult) => void
  const completion = new Promise<ScheduledSessionTaskResult>(resolve => {
    finish = result => {
      if (settled) return
      settled = true
      dispose()
      input.signal.removeEventListener('abort', abort)
      resolve({ ...result, sessionId: target, notificationDecision: notification.decision() })
    }
  })
  const abort = () => {
    if (settled) return
    finish({ status: 'timeout', error: 'Scheduled task execution was interrupted or timed out' })
    stopScheduledTaskTurn(target, input.occurrenceId)
  }
  dispose = observeSessionTurns(event => {
    if (event.sessionId !== target) return
    if (event.type === 'stopped') { finish({ status: 'failed', error: 'Scheduled task was stopped by the user' }); return }
    if (event.type !== 'output') return
    const message = event.message
    if (message.type === 'system' && message.subtype === 'session_message_receipt' && message.message_id === input.occurrenceId && message.status === 'consumed') {
      consumed = true
    }
    if (consumed && message.type === 'result' && !message.parent_tool_use_id && typeof message.is_error === 'boolean') {
      const output = String(message.result ?? message.errors?.join('\n') ?? '')
      const failed = message.is_error || (message.subtype && message.subtype !== 'success')
      finish({ status: failed ? 'failed' : 'completed', output, ...(failed ? { error: output || 'Scheduled task failed' } : {}) })
    }
  })
  input.signal.addEventListener('abort', abort, { once: true })
  try {
    input.signal.throwIfAborted()
    const ack = await submitScheduledTaskTurn(target, formatScheduledTaskPrompt(input.task.prompt, input.runId, input.task.notificationPolicy === 'important'), {
      ...endpoint, messageId: input.occurrenceId, signal: input.signal,
      scheduledTask: { taskId: input.task.id, runId: input.runId, scheduledFor: input.scheduledFor, taskName: input.task.name || input.task.prompt.slice(0, 80) },
      canSend: () => !input.signal.aborted && !settled,
      beforeSend: input.canSend,
    })
    if (ack.status === 'consumed' && !consumed) {
      // A previous process already accepted this occurrence. Never replay an
      // uncertain external action merely because its final result is missing.
      finish({ status: 'failed', error: 'This task was already delivered; inspect the linked session for its result' })
    }
    return await completion
  } catch (error) {
    finish({ status: 'failed', error: error instanceof Error ? error.message : String(error) })
    return await completion
  } finally {
    dispose()
    input.signal.removeEventListener('abort', abort)
    notification.dispose()
  }
}
