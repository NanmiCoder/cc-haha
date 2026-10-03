/**
 * In-process teammate runner
 *
 * Wraps runAgent() for in-process teammates, providing:
 * - AsyncLocalStorage-based context isolation via runWithTeammateContext()
 * - Progress tracking and AppState updates
 * - Idle notification to leader when complete
 * - Plan mode approval flow support
 * - Cleanup on completion or abort
 */

import { feature } from 'bun:bundle'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { UUID } from 'crypto'
import { getSystemPrompt } from '../../constants/prompts.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import {
  processMailboxPermissionResponse,
  registerPermissionCallback,
  unregisterPermissionCallback,
} from '../../hooks/useSwarmPermissionPoller.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { getAutoCompactThreshold } from '../../services/compact/autoCompact.js'
import {
  buildPostCompactMessages,
  compactConversation,
  ERROR_MESSAGE_USER_ABORT,
} from '../../services/compact/compact.js'
import { resetMicrocompactState } from '../../services/compact/microCompact.js'
import type { AppState } from '../../state/AppState.js'
import type { Tool, ToolUseContext } from '../../Tool.js'
import { appendTeammateMessage } from '../../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import type {
  InProcessTeammateTaskState,
  TeammateIdentity,
} from '../../tasks/InProcessTeammateTask/types.js'
import {
  appendCappedMessage,
  TEAMMATE_MESSAGES_UI_CAP,
} from '../../tasks/InProcessTeammateTask/types.js'
import {
  createActivityDescriptionResolver,
  createProgressTracker,
  getProgressUpdate,
  updateProgressFromMessage,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import {
  type CustomAgentDefinition,
  isCustomAgent,
  isPluginAgent,
  type PluginAgentDefinition,
} from '../../tools/AgentTool/loadAgentsDir.js'
import { runAgent } from '../../tools/AgentTool/runAgent.js'
import { awaitClassifierAutoApproval } from '../../tools/BashTool/bashPermissions.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { SEND_MESSAGE_TOOL_NAME } from '../../tools/SendMessageTool/constants.js'
import { TASK_CREATE_TOOL_NAME } from '../../tools/TaskCreateTool/constants.js'
import { TASK_GET_TOOL_NAME } from '../../tools/TaskGetTool/constants.js'
import { TASK_LIST_TOOL_NAME } from '../../tools/TaskListTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from '../../tools/TaskUpdateTool/constants.js'
import { TEAM_CREATE_TOOL_NAME } from '../../tools/TeamCreateTool/constants.js'
import { TEAM_DELETE_TOOL_NAME } from '../../tools/TeamDeleteTool/constants.js'
import { asAgentId } from '../../types/ids.js'
import type { Message } from '../../types/message.js'
import type { PermissionDecision } from '../../types/permissions.js'
import {
  createAssistantAPIErrorMessage,
  createUserMessage,
  filterOrphanedThinkingOnlyMessages,
  filterUnresolvedToolUses,
  filterWhitespaceOnlyAssistantMessages,
  getAssistantMessageText,
  SYNTHETIC_MESSAGES,
} from '../../utils/messages.js'
import { evictTaskOutput } from '../../utils/task/diskOutput.js'
import { evictTerminalTask } from '../../utils/task/framework.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import {
  createAbortController,
  createChildAbortController,
} from '../abortController.js'
import { formatAgentId } from '../agentId.js'
import { type AgentContext, runWithAgentContext } from '../agentContext.js'
import { getCwd } from '../cwd.js'
import { logForDebugging } from '../debug.js'
import { errorMessage as getErrorMessage } from '../errors.js'
import { cloneFileStateCache } from '../fileStateCache.js'
import {
  SUBAGENT_REJECT_MESSAGE,
  SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX,
} from '../messages.js'
import type { ModelAlias } from '../model/aliases.js'
import {
  PERMISSION_MODES,
  type PermissionMode,
} from '../permissions/PermissionMode.js'
import {
  applyPermissionUpdates,
  persistPermissionUpdates,
} from '../permissions/PermissionUpdate.js'
import type { PermissionUpdate } from '../permissions/PermissionUpdateSchema.js'
import { hasPermissionsToUseTool } from '../permissions/permissions.js'
import { emitTaskTerminatedSdk } from '../sdkEventQueue.js'
import {
  type AgentMetadata,
  getAgentTranscript,
  readAgentMetadata,
} from '../sessionStorage.js'
import { sleep } from '../sleep.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import { asSystemPrompt } from '../systemPromptType.js'
import {
  claimTask,
  getCanonicalTeamTaskListId,
  listTasks,
  type Task,
} from '../tasks.js'
import type { TeammateContext } from '../teammateContext.js'
import {
  createTeamStreamScopeId,
  runWithTeammateContext,
} from '../teammateContext.js'
import {
  claimMailboxMessages,
  createIdleNotification,
  formatTeammateMessage,
  formatTeammateMessages,
  getLastPeerDmSummary,
  IDLE_FAILURE_REASON_MAX_CHARS,
  isPermissionResponse,
  isPlanApprovalResponse,
  isShutdownRequest,
  isStructuredProtocolMessage,
  markMessagesAsReadByIdentity,
  readMailbox,
  type TeammateMessage,
  writeToMailbox,
} from '../teammateMailbox.js'
import { unregisterAgent as unregisterPerfettoAgent } from '../telemetry/perfettoTracing.js'
import {
  type ContentReplacementState,
  createContentReplacementState,
  reconstructForSubagentResume,
} from '../toolResultStorage.js'
import { createAgentId } from '../uuid.js'
import { TEAM_LEAD_NAME } from './constants.js'
import {
  getLeaderSetToolPermissionContext,
  getLeaderToolUseConfirmQueue,
} from './leaderPermissionBridge.js'
import {
  createPermissionRequest,
  sendPermissionRequestViaMailbox,
} from './permissionSync.js'
import { spawnInProcessTeammate } from './spawnInProcess.js'
import {
  mutateTeamFileAsync,
  readTeamFile,
  readTeamFileAsync,
  setMemberActive,
} from './teamHelpers.js'
import { TEAMMATE_SYSTEM_PROMPT_ADDENDUM } from './teammatePromptAddendum.js'
import {
  formatTeammateAutoContinuePrompt,
  isTransientTurnFailure,
  summarizeTurnFailure,
  TEAMMATE_AUTO_CONTINUE_DELAYS_MS,
} from './turnFailure.js'

type SetAppStateFn = (updater: (prev: AppState) => AppState) => void

const PERMISSION_POLL_INTERVAL_MS = 500

/**
 * Creates a canUseTool function for in-process teammates that properly resolves
 * 'ask' permissions via the UI rather than treating them as denials.
 *
 * Always uses the leader's ToolUseConfirm dialog with a worker badge when
 * the bridge is available, giving teammates the same tool-specific UI
 * (BashPermissionRequest, FileEditToolDiff, etc.) as the leader's own tools.
 *
 * Falls back to the mailbox system when the bridge is unavailable:
 * sends a permission request to the leader's inbox, waits for the response
 * in the teammate's own mailbox.
 */
function createInProcessCanUseTool(
  identity: TeammateIdentity,
  abortController: AbortController,
  onPermissionWaitMs?: (waitMs: number) => void,
): CanUseToolFn {
  return async (
    tool,
    input,
    toolUseContext,
    assistantMessage,
    toolUseID,
    forceDecision,
  ) => {
    const result =
      forceDecision ??
      (await hasPermissionsToUseTool(
        tool,
        input,
        toolUseContext,
        assistantMessage,
        toolUseID,
      ))

    // Pass through allow/deny decisions directly
    if (result.behavior !== 'ask') {
      return result
    }

    // For bash commands, try classifier auto-approval before showing leader dialog.
    // Agents await the classifier result (rather than racing it against user
    // interaction like the main agent).
    if (
      feature('BASH_CLASSIFIER') &&
      tool.name === BASH_TOOL_NAME &&
      result.pendingClassifierCheck
    ) {
      const classifierDecision = await awaitClassifierAutoApproval(
        result.pendingClassifierCheck,
        abortController.signal,
        toolUseContext.options.isNonInteractiveSession,
      )
      if (classifierDecision) {
        return {
          behavior: 'allow',
          updatedInput: input as Record<string, unknown>,
          decisionReason: classifierDecision,
        }
      }
    }

    // Check if aborted before showing UI
    if (abortController.signal.aborted) {
      return { behavior: 'ask', message: SUBAGENT_REJECT_MESSAGE }
    }

    const appState = toolUseContext.getAppState()

    const description = await (tool as Tool).description(input as never, {
      isNonInteractiveSession: toolUseContext.options.isNonInteractiveSession,
      toolPermissionContext: appState.toolPermissionContext,
      tools: toolUseContext.options.tools,
    })

    if (abortController.signal.aborted) {
      return { behavior: 'ask', message: SUBAGENT_REJECT_MESSAGE }
    }

    const setToolUseConfirmQueue = getLeaderToolUseConfirmQueue()

    // Standard path: use ToolUseConfirm dialog with worker badge
    if (setToolUseConfirmQueue) {
      return new Promise<PermissionDecision>(resolve => {
        let decisionMade = false
        const permissionStartMs = Date.now()

        // Report permission wait time to the caller so it can be
        // subtracted from the displayed elapsed time.
        const reportPermissionWait = () => {
          onPermissionWaitMs?.(Date.now() - permissionStartMs)
        }

        const onAbortListener = () => {
          if (decisionMade) return
          decisionMade = true
          reportPermissionWait()
          resolve({ behavior: 'ask', message: SUBAGENT_REJECT_MESSAGE })
          setToolUseConfirmQueue(queue =>
            queue.filter(item => item.toolUseID !== toolUseID),
          )
        }

        abortController.signal.addEventListener('abort', onAbortListener, {
          once: true,
        })

        setToolUseConfirmQueue(queue => [
          ...queue,
          {
            assistantMessage,
            tool: tool as Tool,
            description,
            input,
            toolUseContext,
            toolUseID,
            permissionResult: result,
            permissionPromptStartTimeMs: permissionStartMs,
            workerBadge: identity.color
              ? { name: identity.agentName, color: identity.color }
              : undefined,
            onUserInteraction() {
              // No-op for teammates (no classifier auto-approval)
            },
            onAbort() {
              if (decisionMade) return
              decisionMade = true
              abortController.signal.removeEventListener(
                'abort',
                onAbortListener,
              )
              reportPermissionWait()
              resolve({ behavior: 'ask', message: SUBAGENT_REJECT_MESSAGE })
            },
            async onAllow(
              updatedInput: Record<string, unknown>,
              permissionUpdates: PermissionUpdate[],
              feedback?: string,
              contentBlocks?: ContentBlockParam[],
            ) {
              if (decisionMade) return
              decisionMade = true
              abortController.signal.removeEventListener(
                'abort',
                onAbortListener,
              )
              reportPermissionWait()
              persistPermissionUpdates(permissionUpdates)
              // Write back permission updates to the leader's shared context
              if (permissionUpdates.length > 0) {
                const setToolPermissionContext =
                  getLeaderSetToolPermissionContext()
                if (setToolPermissionContext) {
                  const currentAppState = toolUseContext.getAppState()
                  const updatedContext = applyPermissionUpdates(
                    currentAppState.toolPermissionContext,
                    permissionUpdates,
                  )
                  // Preserve the leader's mode to prevent workers'
                  // transformed 'acceptEdits' context from leaking back
                  // to the coordinator
                  setToolPermissionContext(updatedContext, {
                    preserveMode: true,
                  })
                }
              }
              const trimmedFeedback = feedback?.trim()
              resolve({
                behavior: 'allow',
                updatedInput,
                userModified: false,
                acceptFeedback: trimmedFeedback || undefined,
                ...(contentBlocks &&
                  contentBlocks.length > 0 && { contentBlocks }),
              })
            },
            onReject(feedback?: string, contentBlocks?: ContentBlockParam[]) {
              if (decisionMade) return
              decisionMade = true
              abortController.signal.removeEventListener(
                'abort',
                onAbortListener,
              )
              reportPermissionWait()
              const message = feedback
                ? `${SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX}${feedback}`
                : SUBAGENT_REJECT_MESSAGE
              resolve({ behavior: 'ask', message, contentBlocks })
            },
            async recheckPermission() {
              if (decisionMade) return
              const freshResult = await hasPermissionsToUseTool(
                tool,
                input,
                toolUseContext,
                assistantMessage,
                toolUseID,
              )
              if (freshResult.behavior === 'allow') {
                decisionMade = true
                abortController.signal.removeEventListener(
                  'abort',
                  onAbortListener,
                )
                reportPermissionWait()
                setToolUseConfirmQueue(queue =>
                  queue.filter(item => item.toolUseID !== toolUseID),
                )
                resolve({
                  ...freshResult,
                  updatedInput: input,
                  userModified: false,
                })
              }
            },
          },
        ])
      })
    }

    // Fallback: use mailbox system when leader UI queue is unavailable
    return new Promise<PermissionDecision>(resolve => {
      const request = createPermissionRequest({
        toolName: (tool as Tool).name,
        toolUseId: toolUseID,
        input,
        description,
        permissionSuggestions: result.suggestions,
        workerId: identity.agentId,
        workerName: identity.agentName,
        workerColor: identity.color,
        teamName: identity.teamName,
      })

      // Register callback to be invoked when the leader responds
      registerPermissionCallback({
        requestId: request.id,
        toolUseId: toolUseID,
        onAllow(
          updatedInput: Record<string, unknown> | undefined,
          permissionUpdates: PermissionUpdate[],
          _feedback?: string,
          contentBlocks?: ContentBlockParam[],
        ) {
          cleanup()
          persistPermissionUpdates(permissionUpdates)
          const finalInput =
            updatedInput && Object.keys(updatedInput).length > 0
              ? updatedInput
              : input
          resolve({
            behavior: 'allow',
            updatedInput: finalInput,
            userModified: false,
            ...(contentBlocks && contentBlocks.length > 0 && { contentBlocks }),
          })
        },
        onReject(feedback?: string, contentBlocks?: ContentBlockParam[]) {
          cleanup()
          const message = feedback
            ? `${SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX}${feedback}`
            : SUBAGENT_REJECT_MESSAGE
          resolve({ behavior: 'ask', message, contentBlocks })
        },
      })

      // Send request to leader's mailbox
      void sendPermissionRequestViaMailbox(request)

      // Poll teammate's mailbox for the response
      const pollInterval = setInterval(
        async (abortController, cleanup, resolve, identity, request) => {
          if (abortController.signal.aborted) {
            cleanup()
            resolve({ behavior: 'ask', message: SUBAGENT_REJECT_MESSAGE })
            return
          }

          const allMessages = await readMailbox(
            identity.agentName,
            identity.teamName,
          )
          for (let i = 0; i < allMessages.length; i++) {
            const msg = allMessages[i]
            if (msg && !msg.read) {
              const parsed = isPermissionResponse(msg.text)
              if (parsed && parsed.request_id === request.id) {
                await markMessagesAsReadByIdentity(
                  identity.agentName,
                  identity.teamName,
                  [msg],
                )
                if (parsed.subtype === 'success') {
                  processMailboxPermissionResponse({
                    requestId: parsed.request_id,
                    decision: 'approved',
                    updatedInput: parsed.response?.updated_input,
                    permissionUpdates: parsed.response?.permission_updates,
                  })
                } else {
                  processMailboxPermissionResponse({
                    requestId: parsed.request_id,
                    decision: 'rejected',
                    feedback: parsed.error,
                  })
                }
                return // Callback already resolves the promise
              }
            }
          }
        },
        PERMISSION_POLL_INTERVAL_MS,
        abortController,
        cleanup,
        resolve,
        identity,
        request,
      )

      const onAbortListener = () => {
        cleanup()
        resolve({ behavior: 'ask', message: SUBAGENT_REJECT_MESSAGE })
      }

      abortController.signal.addEventListener('abort', onAbortListener, {
        once: true,
      })

      function cleanup() {
        clearInterval(pollInterval)
        unregisterPermissionCallback(request.id)
        abortController.signal.removeEventListener('abort', onAbortListener)
      }
    })
  }
}

/**
 * Formats a message as <teammate-message> XML for injection into the conversation.
 * This ensures the model sees messages in the same format as tmux teammates.
 */
function formatAsTeammateMessage(
  from: string,
  content: string,
  color?: string,
  summary?: string,
): string {
  return formatTeammateMessage({ from, text: content, color, summary })
}

/**
 * Configuration for running an in-process teammate.
 */
export type InProcessRunnerConfig = {
  /** Teammate identity for context */
  identity: TeammateIdentity
  /** Task ID in AppState */
  taskId: string
  /** Initial prompt for the teammate */
  prompt: string
  /** Optional agent definition (for specialized agents) */
  agentDefinition?: CustomAgentDefinition | PluginAgentDefinition
  /** Teammate context for AsyncLocalStorage */
  teammateContext: TeammateContext
  /** Parent's tool use context */
  toolUseContext: ToolUseContext
  /** Abort controller linked to parent */
  abortController: AbortController
  /** Optional model override for this teammate */
  model?: string
  /** Optional system prompt override for this teammate */
  systemPrompt?: string
  /** How to apply the system prompt: 'replace' or 'append' to default */
  systemPromptMode?: 'default' | 'replace' | 'append'
  /** Tool permissions to auto-allow for this teammate */
  allowedTools?: string[]
  /** Whether this teammate can show permission prompts for unlisted tools.
   * When false (default), unlisted tools are auto-denied. */
  allowPermissionPrompts?: boolean
  /** Short description of the task (used as summary for the initial prompt header) */
  description?: string
  /** request_id of the API call that spawned this teammate, for lineage
   *  tracing on tengu_api_* events. */
  invokingRequestId?: string
  /** Earlier conversation of a resumed teammate, loaded from its transcript */
  resumeMessages?: Message[]
  /** Content replacement state rebuilt from that transcript */
  resumeReplacementState?: ContentReplacementState
  /** Sender shown on the first prompt (default: the team lead) */
  initialFrom?: string
  /** Backoff before each automatic continuation after a transient failure.
   *  Defaults to TEAMMATE_AUTO_CONTINUE_DELAYS_MS. */
  autoContinueDelaysMs?: readonly number[]
}

/**
 * Result from running an in-process teammate.
 */
export type InProcessRunnerResult = {
  /** Whether the run completed successfully */
  success: boolean
  /** Error message if failed */
  error?: string
  /** Messages produced by the agent */
  messages: Message[]
}

export function buildInProcessTeammateAgentDefinition(
  agentName: string,
  systemPrompt: string,
  agentDefinition?: CustomAgentDefinition | PluginAgentDefinition,
): CustomAgentDefinition {
  return {
    agentType: agentName,
    whenToUse: `In-process teammate: ${agentName}`,
    rawSystemPrompt: systemPrompt,
    getSystemPrompt: () => systemPrompt,
    // Inject team-essential tools so teammates can always respond to shutdown
    // requests, send messages, and coordinate via the task list.
    tools: agentDefinition?.tools
      ? [
          ...new Set([
            ...agentDefinition.tools,
            SEND_MESSAGE_TOOL_NAME,
            TEAM_CREATE_TOOL_NAME,
            TEAM_DELETE_TOOL_NAME,
            TASK_CREATE_TOOL_NAME,
            TASK_GET_TOOL_NAME,
            TASK_LIST_TOOL_NAME,
            TASK_UPDATE_TOOL_NAME,
          ]),
        ]
      : ['*'],
    source: 'projectSettings',
    permissionMode: 'default',
    ...(agentDefinition?.model ? { model: agentDefinition.model } : {}),
    ...(agentDefinition?.effort !== undefined
      ? { effort: agentDefinition.effort }
      : {}),
  }
}

async function setInProcessTeammateActivity(
  identity: Pick<TeammateIdentity, 'agentName' | 'teamName'>,
  isActive: boolean,
): Promise<void> {
  try {
    await setMemberActive(identity.teamName, identity.agentName, isActive)
  } catch (error) {
    logForDebugging(
      `[inProcessRunner] Failed to sync ${identity.agentName} activity: ${error}`,
    )
  }
}

/** Keep the persisted roster active only while an in-process turn is running. */
export async function withInProcessTeammateActivity<T>(
  identity: Pick<TeammateIdentity, 'agentName' | 'teamName'>,
  runTurn: () => Promise<T>,
): Promise<T> {
  await setInProcessTeammateActivity(identity, true)
  try {
    return await runTurn()
  } finally {
    await setInProcessTeammateActivity(identity, false)
  }
}

/**
 * Updates task state in AppState.
 */
function updateTaskState(
  taskId: string,
  updater: (task: InProcessTeammateTaskState) => InProcessTeammateTaskState,
  setAppState: SetAppStateFn,
): void {
  setAppState(prev => {
    const task = prev.tasks[taskId]
    if (!task || task.type !== 'in_process_teammate') {
      return prev
    }
    const updated = updater(task)
    if (updated === task) {
      return prev
    }
    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [taskId]: updated,
      },
    }
  })
}

/**
 * Sends a message to the leader's file-based mailbox.
 * Uses the same mailbox system as tmux teammates for consistency.
 * @returns whether the message was persisted
 */
async function sendMessageToLeader(
  from: string,
  text: string,
  color: string | undefined,
  teamName: string,
): Promise<boolean> {
  return writeToMailbox(
    TEAM_LEAD_NAME,
    {
      from,
      text,
      timestamp: new Date().toISOString(),
      color,
    },
    teamName,
  )
}

/**
 * Sends idle notification to the leader via file-based mailbox.
 * Uses agentName (not agentId) for consistency with process-based teammates.
 * Without an idleReason it is a result-only frame: the teammate reports a
 * finished turn but goes straight on with mail that was already waiting.
 * @returns whether the notification was persisted
 */
async function sendIdleNotification(
  agentName: string,
  agentColor: string | undefined,
  teamName: string,
  options?: {
    idleReason?: 'available' | 'interrupted' | 'failed'
    summary?: string
    completedTaskId?: string
    completedStatus?: 'resolved' | 'blocked' | 'failed'
    failureReason?: string
    result?: string
  },
): Promise<boolean> {
  const notification = createIdleNotification(agentName, options)

  return sendMessageToLeader(
    agentName,
    jsonStringify(notification),
    agentColor,
    teamName,
  )
}

/** Why a teammate's turn ended on an API error, and whether a retry can fix it. */
export type TeammateTurnFailure = {
  /** First line of the error, as the lead sees it */
  reason: string
  isTransient: boolean
}

/**
 * Classifies a finished turn from its messages. A turn failed when its last
 * assistant message is an API error that is not a cancellation marker (an
 * interrupted request is the user's choice, not a failure).
 */
export function classifyTeammateTurnFailure(
  turnMessages: readonly Message[],
): TeammateTurnFailure | undefined {
  const last = turnMessages.findLast(message => message.type === 'assistant')
  if (!last?.isApiErrorMessage) return undefined
  const text = getAssistantMessageText(last) ?? ''
  if (SYNTHETIC_MESSAGES.has(text) || text === ERROR_MESSAGE_USER_ABORT) {
    return undefined
  }
  const detail =
    text ||
    (typeof last.errorDetails === 'string' ? last.errorDetails : '')
  return {
    reason: summarizeTurnFailure(detail) || 'API error',
    isTransient: isTransientTurnFailure(detail),
  }
}

/** A user message that starts a turn: a prompt, not a tool result or meta. */
function isTurnBoundary(message: Message): boolean {
  if (message.type !== 'user' || message.isMeta) return false
  const content = message.message.content
  return (
    typeof content === 'string' ||
    !content.some(
      (block: { type: string }) => block.type === 'tool_result',
    )
  )
}

/** Whether a tool result's text is a structured `{ success: false }` reply. */
function reportsFailure(content: unknown): boolean {
  const texts =
    typeof content === 'string'
      ? [content]
      : Array.isArray(content)
        ? content.flatMap(block =>
            block?.type === 'text' && typeof block.text === 'string'
              ? [block.text]
              : [],
          )
        : []
  return texts.some(text => {
    if (!text.startsWith('{')) return false
    try {
      const parsed = jsonParse(text) as { success?: unknown } | null
      return parsed?.success === false
    } catch {
      return false
    }
  })
}

function isSendMessageToLead(block: {
  type: string
  name?: string
  input?: unknown
}): boolean {
  if (block.type !== 'tool_use' || block.name !== SEND_MESSAGE_TOOL_NAME) {
    return false
  }
  const input = block.input as { to?: unknown } | null | undefined
  return (
    typeof input?.to === 'string' &&
    input.to.toLowerCase() === TEAM_LEAD_NAME.toLowerCase()
  )
}

/**
 * The teammate's final response for its latest turn: the newest assistant
 * text since the turn's prompt. Undefined when the turn produced no text, or
 * when that text came no later than a SendMessage to the lead that went
 * through -- the lead already has that report.
 */
export function getTeammateTurnResult(
  messages: readonly Message[],
): string | undefined {
  let boundary = -1
  for (let index = messages.length - 1; index >= 0; index--) {
    if (isTurnBoundary(messages[index]!)) {
      boundary = index
      break
    }
  }
  const turn = messages.slice(boundary + 1)

  const deliveredToolUseIds = new Set<string>()
  for (const message of turn) {
    if (message.type !== 'user' || typeof message.message.content === 'string') {
      continue
    }
    for (const block of message.message.content) {
      if (
        block.type === 'tool_result' &&
        block.is_error !== true &&
        !reportsFailure(block.content)
      ) {
        deliveredToolUseIds.add(block.tool_use_id)
      }
    }
  }

  for (let index = turn.length - 1; index >= 0; index--) {
    const message = turn[index]!
    if (message.type !== 'assistant' || message.isApiErrorMessage) continue
    const reportedToLead = message.message.content.some(
      (block: { type: string; id?: string; name?: string; input?: unknown }) =>
        isSendMessageToLead(block) &&
        block.id !== undefined &&
        deliveredToolUseIds.has(block.id),
    )
    if (reportedToLead) return undefined
    const text = getAssistantMessageText(message)
    if (text) return text
  }
  return undefined
}

/**
 * Find an available task from the team's task list.
 * A task is available if it's pending, has no owner, and is not blocked.
 */
function findAvailableTasks(tasks: Task[]): Task[] {
  const unresolvedTaskIds = new Set(
    tasks.filter(t => t.status !== 'completed').map(t => t.id),
  )

  return tasks.filter(task => {
    if (task.status !== 'pending') return false
    if (task.owner) return false
    return task.blockedBy.every(id => !unresolvedTaskIds.has(id))
  })
}

/**
 * Format a task as a prompt for the teammate to work on.
 */
function formatTaskAsPrompt(task: Task): string {
  let prompt = `Complete all open tasks. Start with task #${task.id}: \n\n ${task.subject}`

  if (task.description) {
    prompt += `\n\n${task.description}`
  }

  return prompt
}

/**
 * Try to claim follow-up work from the team's task list.
 *
 * A newly spawned teammate must first receive an explicit owner assignment from
 * the lead. Otherwise concurrent spawns race through the same unowned list and
 * can attach another member's task to the teammate's first prompt. Once the
 * member has appeared as an owner, completed ownership is the durable signal
 * that it may autonomously continue with the next available task.
 */
export async function claimNextInProcessTask(
  identity: Pick<TeammateIdentity, 'agentName' | 'teamName'>,
): Promise<string | undefined> {
  const { agentName } = identity
  const taskListId = getCanonicalTeamTaskListId(identity.teamName)

  try {
    const tasks = await listTasks(taskListId)
    if (!tasks.some(task => task.owner === agentName)) return undefined

    for (const availableTask of findAvailableTasks(tasks)) {
      const result = await claimTask(
        taskListId,
        availableTask.id,
        agentName,
        { checkAgentBusy: true, markInProgress: true },
      )
      if (!result.success) {
        logForDebugging(
          `[inProcessRunner] Failed to claim task #${availableTask.id}: ${result.reason}`,
        )
        continue
      }

      logForDebugging(
        `[inProcessRunner] Claimed task #${availableTask.id}: ${availableTask.subject}`,
      )

      return formatTaskAsPrompt(availableTask)
    }
    return undefined
  } catch (err) {
    logForDebugging(`[inProcessRunner] Error checking task list: ${err}`)
    return undefined
  }
}

/**
 * What a teammate is handed next while it waits.
 */
type WaitResult =
  | {
      type: 'shutdown_request'
      from: string
      originalMessage: string
    }
  | {
      /** Every deliverable unread mailbox message, oldest first */
      type: 'new_messages'
      messages: TeammateMessage[]
    }
  | {
      /** Input typed into the teammate's transcript view, or a claimed task */
      type: 'new_message'
      message: string
      from: string
    }
  | {
      type: 'aborted'
    }
  | {
      /** The wait's deadline passed with nothing to deliver */
      type: 'timeout'
    }
  | {
      /** The wait's own cancel signal fired */
      type: 'cancelled'
    }

export type TeammateMailboxDelivery = Extract<
  WaitResult,
  { type: 'shutdown_request' | 'new_messages' }
>

/**
 * Takes what is waiting in a teammate's inbox in one pass.
 *
 * A shutdown request goes first and alone, so peer chatter can never starve
 * it. Everything else unread is delivered together, as one prompt. Protocol
 * frames belong to their own handlers and never become prose for the model:
 * they are acknowledged and dropped here -- except a plan approval response
 * from the lead, which the model has always received.
 *
 * Only messages this call managed to mark read (by identity) are delivered,
 * so a failed mark delivers nothing and the next poll tries again.
 */
export async function takeTeammateMailbox(
  identity: Pick<TeammateIdentity, 'agentName' | 'teamName'>,
): Promise<TeammateMailboxDelivery | null> {
  const { agentName, teamName } = identity
  const unread = (await readMailbox(agentName, teamName)).filter(
    message => !message.read,
  )
  if (unread.length === 0) return null

  const shutdownMessage = unread.find(message =>
    isShutdownRequest(message.text),
  )
  if (shutdownMessage) {
    const claimed = await claimMailboxMessages(agentName, teamName, [
      shutdownMessage,
    ])
    if (claimed === undefined) return null
    if (claimed.length > 0) {
      const request = isShutdownRequest(shutdownMessage.text)
      logForDebugging(
        `[inProcessRunner] ${agentName} received shutdown request from ${request?.from} (prioritized over ${unread.length - 1} unread messages)`,
      )
      return {
        type: 'shutdown_request',
        from: request?.from || shutdownMessage.from || TEAM_LEAD_NAME,
        originalMessage: shutdownMessage.text,
      }
    }
  }

  const deliverable: TeammateMessage[] = []
  const protocolFrames: TeammateMessage[] = []
  for (const message of unread) {
    if (message === shutdownMessage) continue
    if (
      !isStructuredProtocolMessage(message.text) ||
      (message.from === TEAM_LEAD_NAME && isPlanApprovalResponse(message.text))
    ) {
      deliverable.push(message)
    } else {
      protocolFrames.push(message)
    }
  }

  if (protocolFrames.length > 0) {
    logForDebugging(
      `[inProcessRunner] ${agentName} dropping ${protocolFrames.length} protocol frame(s) from ${[...new Set(protocolFrames.map(message => message.from))].join(', ')}`,
      { level: 'warn' },
    )
    await claimMailboxMessages(agentName, teamName, protocolFrames)
  }

  if (deliverable.length === 0) return null
  const claimed = await claimMailboxMessages(agentName, teamName, deliverable)
  if (!claimed || claimed.length === 0) return null
  logForDebugging(
    `[inProcessRunner] ${agentName} draining ${claimed.length} message(s) from ${[...new Set(claimed.map(message => message.from))].join(', ')}`,
  )
  return { type: 'new_messages', messages: claimed }
}

/**
 * Waits for the teammate's next prompt: input typed into its transcript view,
 * then its mailbox (see takeTeammateMailbox), then -- when allowed -- an
 * unclaimed task from the team's list. Polls every 500ms.
 *
 * This keeps the teammate alive in 'idle' state instead of terminating.
 * Does NOT auto-approve shutdown - the model should make that decision.
 *
 * With a deadline the wait ends in 'timeout', and with a cancel signal in
 * 'cancelled' when that fires; the backoff before an automatic retry uses
 * both.
 */
async function waitForNextPromptOrShutdown(
  identity: TeammateIdentity,
  abortController: AbortController,
  taskId: string,
  getAppState: () => AppState,
  setAppState: SetAppStateFn,
  options: {
    deadline?: number
    /** Must be the lifecycle controller's child when given */
    cancelSignal?: AbortSignal
    claimTasks?: boolean
  } = {},
): Promise<WaitResult> {
  const POLL_INTERVAL_MS = 500
  const { deadline, cancelSignal, claimTasks = true } = options
  const sleepSignal = cancelSignal ?? abortController.signal

  logForDebugging(
    `[inProcessRunner] ${identity.agentName} starting poll loop (abort=${abortController.signal.aborted})`,
  )

  let pollCount = 0
  while (!abortController.signal.aborted) {
    if (cancelSignal?.aborted) return { type: 'cancelled' }

    // Check for in-memory pending messages on every iteration (from transcript viewing)
    const appState = getAppState()
    const task = appState.tasks[taskId]
    if (
      task &&
      task.type === 'in_process_teammate' &&
      task.pendingUserMessages.length > 0
    ) {
      const message = task.pendingUserMessages[0]! // Safe: checked length > 0
      // Pop the message from the queue
      setAppState(prev => {
        const prevTask = prev.tasks[taskId]
        if (!prevTask || prevTask.type !== 'in_process_teammate') {
          return prev
        }
        return {
          ...prev,
          tasks: {
            ...prev.tasks,
            [taskId]: {
              ...prevTask,
              pendingUserMessages: prevTask.pendingUserMessages.slice(1),
            },
          },
        }
      })
      logForDebugging(
        `[inProcessRunner] ${identity.agentName} found pending user message (poll #${pollCount})`,
      )
      return {
        type: 'new_message',
        message,
        from: 'user',
      }
    }

    // Wait before next poll (skip on first iteration to check immediately)
    if (pollCount > 0) {
      const waitMs =
        deadline === undefined
          ? POLL_INTERVAL_MS
          : Math.min(POLL_INTERVAL_MS, deadline - Date.now())
      if (waitMs > 0) await sleep(waitMs, sleepSignal)
    }
    pollCount++

    // Check for abort
    if (abortController.signal.aborted) {
      logForDebugging(
        `[inProcessRunner] ${identity.agentName} aborted while waiting (poll #${pollCount})`,
      )
      return { type: 'aborted' }
    }
    if (cancelSignal?.aborted) return { type: 'cancelled' }

    // Check for messages in mailbox
    logForDebugging(
      `[inProcessRunner] ${identity.agentName} poll #${pollCount}: checking mailbox`,
    )
    try {
      const delivery = await takeTeammateMailbox(identity)
      if (delivery) return delivery
    } catch (err) {
      logForDebugging(
        `[inProcessRunner] ${identity.agentName} poll error: ${err}`,
      )
      // Continue polling even if one read fails
    }

    // Check the team's task list for unclaimed tasks
    if (claimTasks) {
      const taskPrompt = await claimNextInProcessTask(identity)
      if (taskPrompt) {
        return {
          type: 'new_message',
          message: taskPrompt,
          from: 'task-list',
        }
      }
    }

    if (deadline !== undefined && Date.now() >= deadline) {
      return { type: 'timeout' }
    }
  }

  logForDebugging(
    `[inProcessRunner] ${identity.agentName} exiting poll loop (abort=${abortController.signal.aborted}, polls=${pollCount})`,
  )
  return { type: 'aborted' }
}

/**
 * A failure reason with a note that must survive the idle notification's
 * length cap.
 */
function withFailureNote(reason: string, note: string): string {
  const room = IDLE_FAILURE_REASON_MAX_CHARS - note.length - 1
  const head =
    reason.length > room ? `${reason.slice(0, Math.max(0, room - 1))}…` : reason
  return `${head} ${note}`
}

/**
 * Builds the teammate's system prompt for its systemPromptMode.
 */
async function buildTeammateSystemPrompt(
  config: Pick<
    InProcessRunnerConfig,
    'toolUseContext' | 'agentDefinition' | 'systemPrompt' | 'systemPromptMode'
  >,
): Promise<string> {
  const { toolUseContext, agentDefinition, systemPrompt, systemPromptMode } =
    config
  if (systemPromptMode === 'replace' && systemPrompt) {
    return systemPrompt
  }

  const fullSystemPromptParts = await getSystemPrompt(
    toolUseContext.options.tools,
    toolUseContext.options.mainLoopModel,
    undefined,
    toolUseContext.options.mcpClients,
  )

  const systemPromptParts = [
    ...fullSystemPromptParts,
    TEAMMATE_SYSTEM_PROMPT_ADDENDUM,
  ]

  // If custom agent definition provided, append its prompt
  if (agentDefinition) {
    const customPrompt = agentDefinition.getSystemPrompt()
    if (customPrompt) {
      systemPromptParts.push(`\n# Custom Agent Instructions\n${customPrompt}`)
    }

    // Log agent memory loaded event for in-process teammates
    if (agentDefinition.memory) {
      logEvent('tengu_agent_memory_loaded', {
        ...(process.env.USER_TYPE === 'ant'
          ? {
              agent_type:
                agentDefinition.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            }
          : {}),
        scope:
          agentDefinition.memory as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        source:
          'in-process-teammate' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }
  }

  // Append mode: add provided system prompt after default
  if (systemPromptMode === 'append' && systemPrompt) {
    systemPromptParts.push(systemPrompt)
  }

  return systemPromptParts.join('\n')
}

/**
 * Runs an in-process teammate with a continuous prompt loop.
 *
 * Executes runAgent() within the teammate's AsyncLocalStorage context,
 * tracks progress, updates task state, sends idle notification on completion,
 * then waits for new prompts or shutdown requests.
 *
 * Unlike background tasks, teammates stay alive and can receive multiple prompts.
 * The loop only exits on abort or after shutdown is approved by the model.
 *
 * Every turn runs under one durable agent id, so the teammate keeps a single
 * transcript (and SendMessage can resume it from there). A turn that ends on
 * a transient API error is continued automatically with backoff, as the
 * desktop runtime does for its process members; the lead hears about it only
 * when the retries run out.
 *
 * @param config - Runner configuration
 * @returns Result with messages and success status
 */
export async function runInProcessTeammate(
  config: InProcessRunnerConfig,
): Promise<InProcessRunnerResult> {
  const {
    identity,
    taskId,
    prompt,
    description,
    agentDefinition,
    teammateContext,
    toolUseContext,
    abortController,
    model,
    allowedTools,
    allowPermissionPrompts,
    invokingRequestId,
    resumeMessages,
    resumeReplacementState,
    initialFrom,
    autoContinueDelaysMs = TEAMMATE_AUTO_CONTINUE_DELAYS_MS,
  } = config
  const { setAppState } = toolUseContext
  const teamFile = readTeamFile(identity.teamName)
  const scopedTeammateContext: TeammateContext = {
    ...teammateContext,
    ...(teamFile
      ? { streamScopeId: createTeamStreamScopeId(teamFile) }
      : {}),
  }
  // One transcript for the teammate's whole life, across turns and resumes
  const transcriptAgentId = asAgentId(
    identity.resumableAgentId ?? createAgentId(),
  )

  logForDebugging(
    `[inProcessRunner] Starting agent loop for ${identity.agentId}`,
  )

  // Create AgentContext for analytics attribution
  const agentContext: AgentContext = {
    agentId: identity.agentId,
    parentSessionId: identity.parentSessionId,
    agentName: identity.agentName,
    teamName: identity.teamName,
    agentColor: identity.color,
    planModeRequired: identity.planModeRequired,
    isTeamLead: false,
    agentType: 'teammate',
    invokingRequestId,
    invocationKind: 'spawn',
    invocationEmitted: false,
  }

  // All messages across all prompts; a resumed teammate starts from its transcript
  const allMessages: Message[] = resumeMessages ? [...resumeMessages] : []
  // Messages already in the transcript: runAgent appends only what follows
  const recordedUuids = new Set<UUID>(allMessages.map(message => message.uuid))
  const transcriptMetadata: Partial<AgentMetadata> = {
    taskKind: 'in_process_teammate',
    teamName: identity.teamName,
    name: identity.agentName,
    planModeRequired: identity.planModeRequired,
    ...(identity.color && { color: identity.color }),
    ...(agentDefinition && { customAgentType: agentDefinition.agentType }),
  }
  // Wrap initial prompt with XML for proper styling in transcript view
  let currentPrompt = formatAsTeammateMessage(
    initialFrom ?? TEAM_LEAD_NAME,
    prompt,
    undefined,
    description,
  )
  let shouldExit = false
  // Consecutive automatic continuations after transient failures
  let autoContinueAttempts = 0
  // The result the lead last received, so a failure report does not repeat it
  let lastDeliveredResult = resumeMessages
    ? getTeammateTurnResult(resumeMessages)
    : undefined

  // Makes what the teammate was handed while waiting its next prompt
  const takeNextPrompt = (next: WaitResult): void => {
    // A new instruction starts a fresh retry budget: someone has seen the
    // teammate's state and wants it to go on.
    autoContinueAttempts = 0
    switch (next.type) {
      case 'shutdown_request':
        // Pass shutdown request to model for decision
        // Format as teammate-message for consistency with how tmux teammates receive it
        // The model will use approveShutdown or rejectShutdown tool
        logForDebugging(
          `[inProcessRunner] ${identity.agentId} received shutdown request - passing to model`,
        )
        currentPrompt = formatAsTeammateMessage(
          next.from,
          next.originalMessage,
        )
        // Add shutdown request to task.messages for transcript display
        appendTeammateMessage(
          taskId,
          createUserMessage({ content: currentPrompt }),
          setAppState,
        )
        break

      case 'new_messages':
        logForDebugging(
          `[inProcessRunner] ${identity.agentId} received ${next.messages.length} message(s)`,
        )
        // The whole batch is one prompt, each message in its own envelope
        currentPrompt = formatTeammateMessages(next.messages)
        appendTeammateMessage(
          taskId,
          createUserMessage({ content: currentPrompt }),
          setAppState,
        )
        break

      case 'new_message':
        logForDebugging(
          `[inProcessRunner] ${identity.agentId} received new message from ${next.from}`,
        )
        // Messages from the user should be plain text (not wrapped in XML)
        // Messages from 'user' come from pendingUserMessages which are already
        // added to task.messages by injectUserMessageToTeammate
        if (next.from === 'user') {
          currentPrompt = next.message
        } else {
          currentPrompt = formatAsTeammateMessage(next.from, next.message)
          appendTeammateMessage(
            taskId,
            createUserMessage({ content: currentPrompt }),
            setAppState,
          )
        }
        break

      case 'aborted':
      case 'timeout':
      case 'cancelled':
        logForDebugging(
          `[inProcessRunner] ${identity.agentId} aborted while waiting`,
        )
        shouldExit = true
        break
    }
  }

  try {
    // Built inside the try: a failure here must still settle the task
    const teammateSystemPrompt = await buildTeammateSystemPrompt(config)

    // Resolve agent definition - use full system prompt with teammate addendum
    // IMPORTANT: Set permissionMode to 'default' so teammates always get full tool
    // access regardless of the leader's permission mode.
    // runAgent applies definition effort over the parent AppState while the
    // existing ToolUseContext keeps the teammate on the session thinking mode.
    const resolvedAgentDefinition = buildInProcessTeammateAgentDefinition(
      identity.agentName,
      teammateSystemPrompt,
      agentDefinition,
    )

    // Add initial prompt to task.messages for display (wrapped with XML),
    // after the latest part of a resumed conversation
    updateTaskState(
      taskId,
      task => {
        let messages = task.messages
        for (const message of resumeMessages?.slice(
          -(TEAMMATE_MESSAGES_UI_CAP - 1),
        ) ?? []) {
          messages = appendCappedMessage(messages, message)
        }
        return {
          ...task,
          messages: appendCappedMessage(
            messages,
            createUserMessage({ content: currentPrompt }),
          ),
        }
      },
      setAppState,
    )

    // Per-teammate content replacement state. The while-loop below calls
    // runAgent repeatedly over an accumulating `allMessages` buffer (which
    // carries FULL original tool result content, not previews — query() yields
    // originals, enforcement is non-mutating). Without persisting state across
    // iterations, each call gets a fresh empty state from createSubagentContext
    // and makes holistic replace-globally-largest decisions, diverging from
    // earlier iterations' incremental frozen-first decisions → wire prefix
    // differs → cache miss. Gated on parent to inherit feature-flag-off.
    let teammateReplacementState = toolUseContext.contentReplacementState
      ? (resumeReplacementState ?? createContentReplacementState())
      : undefined

    // Main teammate loop - runs until abort or shutdown approved
    while (!abortController.signal.aborted && !shouldExit) {
      logForDebugging(
        `[inProcessRunner] ${identity.agentId} processing prompt: ${currentPrompt.substring(0, 50)}...`,
      )

      // Create a per-turn abort controller for this iteration.
      // This allows Escape to stop current work without killing the whole teammate.
      // The lifecycle abortController still kills the whole teammate if needed.
      const currentWorkAbortController = createAbortController()

      // Store the work controller in task state so UI can abort it
      updateTaskState(
        taskId,
        task => ({ ...task, currentWorkAbortController }),
        setAppState,
      )

      // Prepare prompt messages for this iteration
      // For the first iteration, start fresh
      // For subsequent iterations, pass accumulated messages as context
      const userMessage = createUserMessage({ content: currentPrompt })
      const promptMessages: Message[] = [userMessage]

      // Check if compaction is needed before building context
      let contextMessages = allMessages
      const tokenCount = tokenCountWithEstimation(allMessages)
      if (
        tokenCount >
        getAutoCompactThreshold(toolUseContext.options.mainLoopModel)
      ) {
        logForDebugging(
          `[inProcessRunner] ${identity.agentId} compacting history (${tokenCount} tokens)`,
        )
        // Create an isolated copy of toolUseContext so that compaction
        // does not clear the main session's caches or trigger the main
        // session's UI callbacks. It runs under the teammate's own lifecycle
        // controller and agent id: the spawn-time context carries the lead's
        // per-turn controller, which stays aborted once that lead turn was
        // interrupted and would fail every later compaction.
        const compactionContext: ToolUseContext = {
          ...toolUseContext,
          abortController,
          agentId: transcriptAgentId,
          readFileState: cloneFileStateCache(toolUseContext.readFileState),
          loadedNestedMemoryPaths: new Set(),
          onCompactProgress: undefined,
          setStreamMode: undefined,
        }
        try {
          const compactedSummary = await compactConversation(
            allMessages,
            compactionContext,
            {
              systemPrompt: asSystemPrompt([]),
              userContext: {},
              systemContext: {},
              toolUseContext: compactionContext,
              // The summarizing fork reads the conversation from here
              forkContextMessages: allMessages,
            },
            true, // suppressFollowUpQuestions
            undefined, // customInstructions
            true, // isAutoCompact
          )
          contextMessages = buildPostCompactMessages(compactedSummary)
          // Reset microcompact state since full compact replaces all
          // messages — old tool IDs are no longer relevant
          resetMicrocompactState()
          // Reset content replacement state — compact replaces all messages
          // so old tool_use_ids are gone. Stale Map entries are harmless
          // (UUID keys never match) but accumulate memory over long runs.
          if (teammateReplacementState) {
            teammateReplacementState = createContentReplacementState()
          }
          // Update allMessages in place with compacted version
          allMessages.length = 0
          allMessages.push(...contextMessages)
          // The compacted history starts a new chain in the same transcript
          recordedUuids.clear()

          // Mirror compaction into task.messages — otherwise the AppState
          // mirror grows unbounded (500 turns = 500+ messages, 10-50MB).
          // Replace with the compacted messages, matching allMessages.
          updateTaskState(
            taskId,
            task => ({ ...task, messages: [...contextMessages, userMessage] }),
            setAppState,
          )
        } catch (error) {
          if (abortController.signal.aborted) {
            logForDebugging(
              `[inProcessRunner] ${identity.agentId} aborted during compaction`,
            )
            break
          }
          // A summary that failed (API error, hook...) must not end the
          // teammate: the turn runs on the full history instead. If that is
          // too long for the model, the turn fails and the lead is told.
          logForDebugging(
            `[inProcessRunner] ${identity.agentId} compaction failed, continuing uncompacted: ${getErrorMessage(error)}`,
            { level: 'warn' },
          )
        }
      }

      // Pass previous messages as context to preserve conversation history
      // allMessages accumulates all previous messages (user + assistant) from prior iterations
      const forkContextMessages =
        contextMessages.length > 0 ? [...contextMessages] : undefined

      // Add the user message to allMessages so it's included in future context
      // This ensures the full conversation (user + assistant turns) is preserved
      allMessages.push(userMessage)

      // Create fresh progress tracker for this prompt
      const tracker = createProgressTracker()
      const resolveActivity = createActivityDescriptionResolver(
        toolUseContext.options.tools,
      )
      const iterationMessages: Message[] = []

      // Read current permission mode from task state (may have been cycled by leader via Shift+Tab)
      const currentAppState = toolUseContext.getAppState()
      const currentTask = currentAppState.tasks[taskId]
      const currentPermissionMode =
        currentTask && currentTask.type === 'in_process_teammate'
          ? currentTask.permissionMode
          : 'default'
      const iterationAgentDefinition = {
        ...resolvedAgentDefinition,
        permissionMode: currentPermissionMode,
      }

      // Track if this iteration was interrupted by work abort (not lifecycle abort)
      let workWasAborted = false

      // Run agent within contexts
      const runActiveTurn = () => runWithTeammateContext(scopedTeammateContext, async () => {
        return runWithAgentContext(agentContext, async () => {
          // Mark task as running (not idle)
          updateTaskState(
            taskId,
            task => ({ ...task, status: 'running', isIdle: false }),
            setAppState,
          )

          // Run the normal agent loop - same runAgent() used by AgentTool/subagents.
          // This calls query() internally, so we share the core API infrastructure.
          // Pass forkContextMessages to preserve conversation history across prompts.
          // In-process teammates are async but run in the same process as the leader,
          // so they CAN show permission prompts (unlike true background agents).
          // Use currentWorkAbortController so Escape stops this turn only, not the teammate.
          for await (const message of runAgent({
            agentDefinition: iterationAgentDefinition,
            promptMessages,
            toolUseContext,
            canUseTool: createInProcessCanUseTool(
              identity,
              currentWorkAbortController,
              (waitMs: number) => {
                updateTaskState(
                  taskId,
                  task => ({
                    ...task,
                    totalPausedMs: (task.totalPausedMs ?? 0) + waitMs,
                  }),
                  setAppState,
                )
              },
            ),
            isAsync: true,
            canShowPermissionPrompts: allowPermissionPrompts ?? true,
            forkContextMessages,
            querySource: 'agent:custom',
            // Every turn writes to the same transcript, appending only the
            // messages it has not recorded yet
            override: {
              abortController: currentWorkAbortController,
              agentId: transcriptAgentId,
            },
            recordedUuids,
            description,
            extraMetadata: {
              ...transcriptMetadata,
              permissionMode: currentPermissionMode,
            },
            model: model as ModelAlias | undefined,
            preserveToolUseResults: true,
            availableTools: toolUseContext.options.tools,
            allowedTools,
            contentReplacementState: teammateReplacementState,
            streamTargetAgentId: identity.agentId,
          })) {
            // Check lifecycle abort first (kills whole teammate)
            if (abortController.signal.aborted) {
              logForDebugging(
                `[inProcessRunner] ${identity.agentId} lifecycle aborted`,
              )
              break
            }

            // Check work abort (stops current turn only)
            if (currentWorkAbortController.signal.aborted) {
              logForDebugging(
                `[inProcessRunner] ${identity.agentId} current work aborted (Escape pressed)`,
              )
              workWasAborted = true
              break
            }

            iterationMessages.push(message)
            allMessages.push(message)

            updateProgressFromMessage(
              tracker,
              message,
              resolveActivity,
              toolUseContext.options.tools,
            )
            const progress = getProgressUpdate(tracker)

            updateTaskState(
              taskId,
              task => {
                // Track in-progress tool use IDs for animation in transcript view
                let inProgressToolUseIDs = task.inProgressToolUseIDs
                if (message.type === 'assistant') {
                  for (const block of message.message.content) {
                    if (block.type === 'tool_use') {
                      inProgressToolUseIDs = new Set([
                        ...(inProgressToolUseIDs ?? []),
                        block.id,
                      ])
                    }
                  }
                } else if (message.type === 'user') {
                  const content = message.message.content
                  if (Array.isArray(content)) {
                    for (const block of content) {
                      if (
                        typeof block === 'object' &&
                        'type' in block &&
                        block.type === 'tool_result'
                      ) {
                        if (inProgressToolUseIDs) {
                          inProgressToolUseIDs = new Set(inProgressToolUseIDs)
                          inProgressToolUseIDs.delete(block.tool_use_id)
                        }
                      }
                    }
                  }
                }

                return {
                  ...task,
                  progress,
                  messages: appendCappedMessage(task.messages, message),
                  inProgressToolUseIDs,
                }
              },
              setAppState,
            )
          }

          return { success: true, messages: iterationMessages }
        })
      })
      try {
        await withInProcessTeammateActivity(identity, runActiveTurn)
      } catch (error) {
        // runAgent ends a run whose controller was aborted by throwing
        // AbortError. A turn stopped by the user, or by the teammate being
        // stopped, is not a failure.
        if (
          !abortController.signal.aborted &&
          !currentWorkAbortController.signal.aborted
        ) {
          throw error
        }
        logForDebugging(
          `[inProcessRunner] ${identity.agentId} turn ended by abort: ${getErrorMessage(error)}`,
        )
      }

      // Clear the work controller from state (it's no longer valid)
      updateTaskState(
        taskId,
        task => ({ ...task, currentWorkAbortController: undefined }),
        setAppState,
      )

      // Check if lifecycle aborted during agent run (kills whole teammate)
      if (abortController.signal.aborted) {
        break
      }

      const turnInterrupted =
        workWasAborted || currentWorkAbortController.signal.aborted

      // If work was aborted (Escape), log it and add interrupt message, then continue to idle state
      if (turnInterrupted) {
        logForDebugging(
          `[inProcessRunner] ${identity.agentId} work interrupted, returning to idle`,
        )

        // Add interrupt message to teammate's messages so it appears in their scrollback
        const interruptMessage = createAssistantAPIErrorMessage({
          content: ERROR_MESSAGE_USER_ABORT,
        })
        updateTaskState(
          taskId,
          task => ({
            ...task,
            messages: appendCappedMessage(task.messages, interruptMessage),
          }),
          setAppState,
        )
      }

      const failure = turnInterrupted
        ? undefined
        : classifyTeammateTurnFailure(iterationMessages)
      let retryCancelled = false
      if (
        failure?.isTransient &&
        autoContinueAttempts < autoContinueDelaysMs.length
      ) {
        const attempt = ++autoContinueAttempts
        const delayMs = autoContinueDelaysMs[attempt - 1]!
        logForDebugging(
          `[inProcessRunner] ${identity.agentId} turn failed transiently (${failure.reason}); continuing in ${delayMs}ms (retry ${attempt} of ${autoContinueDelaysMs.length})`,
        )
        // The lead is not told yet. The teammate stays busy (not idle)
        // until the retry runs; new mail or input cuts the wait short and is
        // delivered instead, and Escape cancels the retry.
        const retryWait = createChildAbortController(abortController)
        updateTaskState(
          taskId,
          task => ({ ...task, currentWorkAbortController: retryWait }),
          setAppState,
        )
        const next = await waitForNextPromptOrShutdown(
          identity,
          abortController,
          taskId,
          toolUseContext.getAppState,
          setAppState,
          {
            deadline: Date.now() + delayMs,
            cancelSignal: retryWait.signal,
            claimTasks: false,
          },
        )
        updateTaskState(
          taskId,
          task =>
            task.currentWorkAbortController === retryWait
              ? { ...task, currentWorkAbortController: undefined }
              : task,
          setAppState,
        )
        if (next.type === 'timeout') {
          currentPrompt = formatTeammateAutoContinuePrompt(
            failure.reason,
            attempt,
            autoContinueDelaysMs.length,
          )
          appendTeammateMessage(
            taskId,
            createUserMessage({ content: currentPrompt }),
            setAppState,
          )
          continue
        }
        if (next.type !== 'cancelled') {
          takeNextPrompt(next)
          continue
        }
        retryCancelled = true
      }
      if (!failure) {
        autoContinueAttempts = 0
      }
      const failureReason = !failure
        ? undefined
        : retryCancelled
          ? withFailureNote(failure.reason, '(automatic retry cancelled)')
          : failure.isTransient
            ? withFailureNote(
                failure.reason,
                `(automatic retries exhausted; message ${identity.agentName} to continue)`,
              )
            : failure.reason

      // The turn's final response travels with the idle notification
      const result = turnInterrupted
        ? undefined
        : getTeammateTurnResult(allMessages)
      const summary = getLastPeerDmSummary(allMessages)

      // Mail that arrived during the turn is taken now, as one batch, without
      // going idle in between. The lead still gets this turn's result.
      if (!turnInterrupted) {
        let delivery: TeammateMailboxDelivery | null = null
        try {
          delivery = await takeTeammateMailbox(identity)
        } catch (error) {
          logForDebugging(
            `[inProcessRunner] ${identity.agentName} turn-end mailbox check failed: ${error}`,
          )
        }
        if (delivery) {
          if (result !== undefined || failure) {
            const sent = await sendIdleNotification(
              identity.agentName,
              identity.color,
              identity.teamName,
              {
                ...(failure && {
                  idleReason: 'failed' as const,
                  failureReason,
                }),
                summary,
                result,
              },
            )
            if (sent && result !== undefined) lastDeliveredResult = result
          }
          takeNextPrompt(delivery)
          continue
        }
      }

      // Check if already idle before updating (to skip duplicate notification)
      const prevAppState = toolUseContext.getAppState()
      const prevTask = prevAppState.tasks[taskId]
      const wasAlreadyIdle =
        prevTask?.type === 'in_process_teammate' && prevTask.isIdle

      // Mark task as idle (NOT completed) and notify any waiters
      updateTaskState(
        taskId,
        task => {
          // Call any registered idle callbacks
          task.onIdleCallbacks?.forEach(cb => cb())
          return { ...task, isIdle: true, onIdleCallbacks: [] }
        },
        setAppState,
      )

      // Only send idle notification on transition to idle (not if already idle)
      if (!wasAlreadyIdle) {
        const sent = await sendIdleNotification(
          identity.agentName,
          identity.color,
          identity.teamName,
          {
            idleReason: turnInterrupted
              ? 'interrupted'
              : failure
                ? 'failed'
                : 'available',
            summary,
            failureReason,
            result,
          },
        )
        if (sent && result !== undefined) lastDeliveredResult = result
      } else {
        logForDebugging(
          `[inProcessRunner] Skipping duplicate idle notification for ${identity.agentName}`,
        )
      }

      logForDebugging(
        `[inProcessRunner] ${identity.agentId} finished prompt, waiting for next`,
      )

      // Wait for next message or shutdown
      takeNextPrompt(
        await waitForNextPromptOrShutdown(
          identity,
          abortController,
          taskId,
          toolUseContext.getAppState,
          setAppState,
        ),
      )
    }

    // Mark as completed when exiting the loop
    let alreadyTerminal = false
    let toolUseId: string | undefined
    updateTaskState(
      taskId,
      task => {
        // killInProcessTeammate may have already set status:killed +
        // notified:true + cleared fields. Don't overwrite (would flip
        // killed → completed and double-emit the SDK bookend).
        if (task.status !== 'running') {
          alreadyTerminal = true
          return task
        }
        toolUseId = task.toolUseId
        task.onIdleCallbacks?.forEach(cb => cb())
        task.unregisterCleanup?.()
        return {
          ...task,
          status: 'completed' as const,
          notified: true,
          endTime: Date.now(),
          messages: task.messages?.length ? [task.messages.at(-1)!] : undefined,
          pendingUserMessages: [],
          inProgressToolUseIDs: undefined,
          abortController: undefined,
          unregisterCleanup: undefined,
          currentWorkAbortController: undefined,
          onIdleCallbacks: [],
        }
      },
      setAppState,
    )
    void evictTaskOutput(taskId)
    // Eagerly evict task from AppState since it's been consumed
    evictTerminalTask(taskId, setAppState)
    // notified:true pre-set → no XML notification → print.ts won't emit
    // the SDK task_notification. Close the task_started bookend directly.
    if (!alreadyTerminal) {
      emitTaskTerminatedSdk(taskId, 'completed', {
        toolUseId,
        summary: identity.agentId,
        ownerAgentId: identity.agentId,
      })
    }

    unregisterPerfettoAgent(identity.agentId)
    return { success: true, messages: allMessages }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error'

    logForDebugging(
      `[inProcessRunner] Agent ${identity.agentId} failed: ${errorMessage}`,
    )

    // Mark task as failed and notify any waiters
    let alreadyTerminal = false
    let toolUseId: string | undefined
    updateTaskState(
      taskId,
      task => {
        if (task.status !== 'running') {
          alreadyTerminal = true
          return task
        }
        toolUseId = task.toolUseId
        task.onIdleCallbacks?.forEach(cb => cb())
        task.unregisterCleanup?.()
        return {
          ...task,
          status: 'failed' as const,
          notified: true,
          error: errorMessage,
          isIdle: true,
          endTime: Date.now(),
          onIdleCallbacks: [],
          messages: task.messages?.length ? [task.messages.at(-1)!] : undefined,
          pendingUserMessages: [],
          inProgressToolUseIDs: undefined,
          abortController: undefined,
          unregisterCleanup: undefined,
          currentWorkAbortController: undefined,
        }
      },
      setAppState,
    )
    void evictTaskOutput(taskId)
    // Eagerly evict task from AppState since it's been consumed
    evictTerminalTask(taskId, setAppState)
    // notified:true pre-set → no XML notification → close SDK bookend directly.
    if (!alreadyTerminal) {
      emitTaskTerminatedSdk(taskId, 'failed', {
        toolUseId,
        summary: identity.agentId,
        ownerAgentId: identity.agentId,
      })
    }

    // Send idle notification with failure via file-based mailbox, with
    // whatever the teammate said last unless the lead already has it
    const partialResult = getTeammateTurnResult(allMessages)
    await sendIdleNotification(
      identity.agentName,
      identity.color,
      identity.teamName,
      {
        idleReason: 'failed',
        completedStatus: 'failed',
        failureReason: errorMessage,
        result:
          partialResult !== lastDeliveredResult ? partialResult : undefined,
      },
    )

    unregisterPerfettoAgent(identity.agentId)
    return {
      success: false,
      error: errorMessage,
      messages: allMessages,
    }
  }
}

/**
 * How to bring a teammate back once its runner has ended: the configuration
 * it ran with, minus anything tied to that run. Kept for the life of the
 * process -- a stopped teammate has nothing else to resume from -- and keyed
 * by its name@team address, so a newer teammate with that name replaces it.
 * The context it holds is the lead's spawn-time context, which outlives the
 * teammate anyway.
 */
type TeammateRespawnTemplate = Pick<
  InProcessRunnerConfig,
  | 'identity'
  | 'agentDefinition'
  | 'toolUseContext'
  | 'model'
  | 'systemPrompt'
  | 'systemPromptMode'
  | 'allowedTools'
  | 'allowPermissionPrompts'
> & {
  /** createdAt of the team the teammate belonged to */
  teamCreatedAt?: number
}

const respawnTemplates = new Map<string, TeammateRespawnTemplate>()
const resumesInFlight = new Map<string, Promise<InProcessTeammateResume>>()

function isCurrentTemplate(
  template: TeammateRespawnTemplate | undefined,
  teamCreatedAt: number | undefined,
): template is TeammateRespawnTemplate {
  // A teammate of an earlier team with the same name must not come back
  return (
    template !== undefined &&
    (template.teamCreatedAt === undefined ||
      template.teamCreatedAt === teamCreatedAt)
  )
}

/**
 * Whether this process ran an in-process teammate of this name in the team
 * (created at `teamCreatedAt`) and can resume it, even after it left the
 * team file.
 */
export function hasResumableInProcessTeammate(
  agentName: string,
  teamName: string,
  teamCreatedAt: number | undefined,
): boolean {
  return isCurrentTemplate(
    respawnTemplates.get(formatAgentId(agentName, teamName)),
    teamCreatedAt,
  )
}

/**
 * Starts an in-process teammate in the background.
 *
 * This is the main entry point called after spawn. It starts the agent
 * execution loop in a fire-and-forget manner.
 *
 * @param config - Runner configuration
 */
export function startInProcessTeammate(config: InProcessRunnerConfig): void {
  // The runner and the respawn template must agree on the transcript id
  const runnerConfig: InProcessRunnerConfig = config.identity.resumableAgentId
    ? config
    : {
        ...config,
        identity: { ...config.identity, resumableAgentId: createAgentId() },
      }
  const { identity } = runnerConfig
  respawnTemplates.set(identity.agentId, {
    identity,
    agentDefinition: runnerConfig.agentDefinition,
    toolUseContext: runnerConfig.toolUseContext,
    model: runnerConfig.model,
    systemPrompt: runnerConfig.systemPrompt,
    systemPromptMode: runnerConfig.systemPromptMode,
    allowedTools: runnerConfig.allowedTools,
    allowPermissionPrompts: runnerConfig.allowPermissionPrompts,
    teamCreatedAt: readTeamFile(identity.teamName)?.createdAt,
  })
  // Extract agentId before the closure so the catch handler doesn't retain
  // the full config object (including toolUseContext) while the promise is
  // pending - which can be hours for a long-running teammate.
  const agentId = identity.agentId
  void runInProcessTeammate(runnerConfig).catch(error => {
    logForDebugging(`[inProcessRunner] Unhandled error in ${agentId}: ${error}`)
  })
}

export type InProcessTeammateResume =
  | {
      kind: 'resumed'
      taskId: string
      /** Messages of the earlier conversation the teammate continues from */
      resumedMessageCount: number
    }
  | {
      /** Another caller restarted it first; it is running now */
      kind: 'already_running'
    }

/**
 * Restarts an in-process teammate that is not running -- its runner failed,
 * finished, was stopped or evicted -- from its own transcript, with `prompt`
 * as its next turn. It keeps its name@team address, color, model and agent
 * definition, gets a new task and abort controller, and rejoins the team file
 * if it had left it. Mail that arrived while it was stopped stays in its
 * inbox. A teammate this process never ran (the lead restarted since)
 * restarts from its team-file record without earlier conversation.
 */
export async function resumeInProcessTeammate(
  params: ResumeInProcessTeammateParams,
): Promise<InProcessTeammateResume> {
  const agentId = formatAgentId(params.agentName, params.teamName)
  const pending = resumesInFlight.get(agentId)
  if (pending) {
    const resumed = await pending.then(
      () => true,
      () => false,
    )
    return resumed
      ? { kind: 'already_running' }
      : resumeInProcessTeammate(params)
  }
  const resume = resumeStoppedTeammate(params)
  resumesInFlight.set(agentId, resume)
  try {
    return await resume
  } finally {
    resumesInFlight.delete(agentId)
  }
}

type ResumeInProcessTeammateParams = {
  agentName: string
  teamName: string
  /** The message that becomes the teammate's next prompt */
  prompt: string
  /** Its sender */
  from: string
  summary?: string
  /** Context of the caller */
  context: ToolUseContext
}

/** Never resume into bypassPermissions from a file on disk. */
function resumablePermissionMode(
  metadata: AgentMetadata | null,
): PermissionMode | undefined {
  const mode =
    metadata?.taskKind === 'in_process_teammate'
      ? metadata.permissionMode
      : undefined
  return mode &&
    mode !== 'bypassPermissions' &&
    (PERMISSION_MODES as readonly string[]).includes(mode)
    ? mode
    : undefined
}

function findTeammateAgentDefinition(
  context: ToolUseContext,
  agentType: string | undefined,
): CustomAgentDefinition | PluginAgentDefinition | undefined {
  if (!agentType) return undefined
  const found = context.options?.agentDefinitions?.activeAgents.find(
    agent => agent.agentType === agentType,
  )
  return found && (isCustomAgent(found) || isPluginAgent(found))
    ? found
    : undefined
}

async function resumeStoppedTeammate({
  agentName,
  teamName,
  prompt,
  from,
  summary,
  context,
}: ResumeInProcessTeammateParams): Promise<InProcessTeammateResume> {
  const agentId = formatAgentId(agentName, teamName)
  const teamFile = await readTeamFileAsync(teamName)
  if (!teamFile?.members) {
    throw new Error(`Team "${teamName}" does not exist`)
  }
  const member = teamFile.members.find(entry => entry.name === agentName)
  const storedTemplate = respawnTemplates.get(agentId)
  const template = isCurrentTemplate(storedTemplate, teamFile.createdAt)
    ? storedTemplate
    : undefined
  if (!template && member?.backendType !== 'in-process') {
    throw new Error(
      `"${agentName}" is not an in-process teammate of team "${teamName}"`,
    )
  }

  const transcriptAgentId = template?.identity.resumableAgentId
  const [transcript, metadata] = transcriptAgentId
    ? await Promise.all([
        getAgentTranscript(asAgentId(transcriptAgentId)),
        readAgentMetadata(asAgentId(transcriptAgentId)).catch(() => null),
      ])
    : [null, null]
  const resumeMessages = transcript
    ? filterWhitespaceOnlyAssistantMessages(
        filterOrphanedThinkingOnlyMessages(
          filterUnresolvedToolUses(transcript.messages),
        ),
      )
    : []

  const runnerContext: ToolUseContext = template?.toolUseContext ?? {
    ...context,
    messages: [],
    // A teammate caller's own setAppState does not reach the root store
    setAppState: context.setAppStateForTasks ?? context.setAppState,
  }
  const agentDefinition = template
    ? template.agentDefinition
    : findTeammateAgentDefinition(context, member?.agentType)
  const color = template ? template.identity.color : member?.color
  const planModeRequired = template
    ? template.identity.planModeRequired
    : (member?.planModeRequired ?? false)
  const model = template ? template.model : member?.model

  const spawned = await spawnInProcessTeammate(
    {
      name: agentName,
      teamName,
      prompt,
      color,
      planModeRequired,
      model,
      // Without a transcript the teammate starts a new one, but it still
      // keeps the mail that was left for it
      resumableAgentId: transcriptAgentId ?? createAgentId(),
      permissionMode: resumablePermissionMode(metadata),
    },
    { setAppState: runnerContext.setAppState, toolUseId: context.toolUseId },
  )
  if (
    !spawned.success ||
    !spawned.taskId ||
    !spawned.identity ||
    !spawned.teammateContext ||
    !spawned.abortController
  ) {
    throw new Error(spawned.error ?? 'Failed to respawn in-process teammate')
  }

  // Rejoin the roster before the runner starts
  try {
    await mutateTeamFileAsync(teamName, file => {
      const entry = file.members.find(candidate => candidate.agentId === agentId)
      if (entry) {
        entry.joinedAt = Date.now()
        return
      }
      file.members.push({
        agentId,
        name: agentName,
        agentType: agentDefinition?.agentType ?? member?.agentType,
        model,
        color,
        planModeRequired,
        joinedAt: Date.now(),
        tmuxPaneId: 'in-process',
        cwd: getCwd(),
        subscriptions: [],
        backendType: 'in-process',
      })
    })
  } catch (error) {
    logForDebugging(
      `[inProcessRunner] could not re-add ${agentId} to the team file: ${error}`,
    )
  }
  runnerContext.setAppState(prev =>
    prev.teamContext
      ? {
          ...prev,
          teamContext: {
            ...prev.teamContext,
            teammates: {
              ...prev.teamContext.teammates,
              [agentId]: {
                name: agentName,
                agentType: agentDefinition?.agentType ?? member?.agentType,
                color,
                tmuxSessionName: 'in-process',
                tmuxPaneId: 'in-process',
                cwd: getCwd(),
                spawnedAt: Date.now(),
              },
            },
          },
        }
      : prev,
  )

  startInProcessTeammate({
    identity: spawned.identity,
    taskId: spawned.taskId,
    prompt,
    description: summary,
    initialFrom: from,
    agentDefinition,
    model,
    systemPrompt: template?.systemPrompt,
    systemPromptMode: template?.systemPromptMode,
    allowedTools: template?.allowedTools,
    allowPermissionPrompts: template?.allowPermissionPrompts,
    teammateContext: spawned.teammateContext,
    toolUseContext: runnerContext,
    abortController: spawned.abortController,
    resumeMessages,
    resumeReplacementState: transcript
      ? reconstructForSubagentResume(
          runnerContext.contentReplacementState,
          resumeMessages,
          transcript.contentReplacements,
        )
      : undefined,
  })
  logForDebugging(
    `[inProcessRunner] Resumed ${agentId} with ${resumeMessages.length} prior messages`,
  )
  return {
    kind: 'resumed',
    taskId: spawned.taskId,
    resumedMessageCount: resumeMessages.length,
  }
}
