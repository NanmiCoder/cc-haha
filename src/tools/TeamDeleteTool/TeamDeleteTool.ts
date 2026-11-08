import { z } from 'zod/v4'
import { logEvent } from '../../services/analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/metadata.js'
import type { Tool } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  cleanupTeamDirectories,
  getRegisteredTeamLifecycle,
  readTeamFile,
  unregisterTeamForSessionCleanup,
} from '../../utils/swarm/teamHelpers.js'
import { clearTeammateColors } from '../../utils/swarm/teammateLayoutManager.js'
import {
  clearLeaderTeamName,
  getCanonicalTeamTaskListId,
  readTaskListLifecycleState,
  type Task,
  type TaskListLifecycleToken,
} from '../../utils/tasks.js'
import { getSessionId } from '../../bootstrap/state.js'
import { TEAM_DELETE_TOOL_NAME } from './constants.js'
import { getPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

export type Output = {
  success: boolean
  message: string
  team_name?: string
  finalTasks?: Task[]
  taskListSnapshotAt?: string
  taskListSnapshotRevision?: number
}

export type Input = z.infer<InputSchema>

/**
 * The incarnation of the team this lead may clean up. The process that ran
 * TeamCreate registered it; a desktop lead process restarts often (a model or
 * permission change, a crash, a reopen) and finds it in the durable record,
 * which names the session leading it. Once the team's config is gone (removed
 * by hand) nothing else proves the leftovers are this lead's: 'foreign' is a
 * record of an incarnation this lead cannot claim, undefined no record at all.
 */
async function ownedLifecycle(
  teamName: string,
): Promise<TaskListLifecycleToken | 'foreign' | undefined> {
  const registered = getRegisteredTeamLifecycle(teamName)
  if (registered) return registered
  const state = await readTaskListLifecycleState(
    getCanonicalTeamTaskListId(teamName),
  ).catch(() => undefined)
  const identity = state?.activeIdentity
  if (!state || !identity) return undefined
  if (identity.teamName !== teamName || identity.leadSessionId !== getSessionId()) {
    return 'foreign'
  }
  return { generation: state.generation, identity }
}

export const TeamDeleteTool: Tool<InputSchema, Output> = buildTool({
  name: TEAM_DELETE_TOOL_NAME,
  searchHint: 'disband a swarm team and clean up',
  maxResultSizeChars: 100_000,
  shouldDefer: true,

  userFacingName() {
    return ''
  },

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  isEnabled() {
    return isAgentSwarmsEnabled()
  },

  async description() {
    return 'Clean up team and task directories when the swarm is complete'
  },

  async prompt() {
    return getPrompt()
  },

  mapToolResultToToolResultBlockParam(data, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: [
        {
          type: 'text' as const,
          text: jsonStringify(data),
        },
      ],
    }
  },

  async call(_input, context) {
    const { setAppState, getAppState } = context
    const appState = getAppState()
    const teamName = appState.teamContext?.teamName

    let finalTasks: Task[] | undefined
    let taskListSnapshotAt: string | undefined
    let taskListSnapshotRevision: number | undefined
    let alreadyRemoved = false

    if (teamName) {
      // Read team config to check for active members
      const teamFile = readTeamFile(teamName)
      if (teamFile) {
        // An idle teammate is still alive and polling its mailbox. Deleting
        // the Team while it remains registered lets that old actor wake after
        // a same-name recreation and mutate the new generation's task list.
        // Shutdown approval removes teammates from the config; only that
        // durable transition makes cleanup safe.
        const nonLeadMembers = teamFile.members.filter(
          m => m.agentId !== teamFile.leadAgentId && !(m.backendType === 'process' && m.terminated === true),
        )

        if (nonLeadMembers.length > 0) {
          const memberNames = nonLeadMembers.map(m => m.name).join(', ')
          return {
            data: {
              success: false,
              message: `Cannot cleanup team with ${nonLeadMembers.length} registered teammate(s): ${memberNames}. Send each a shutdown_request with SendMessage, then end your turn: approvals arrive as messages, and TeamDelete succeeds once those teammates have exited. Never delete the team or task directories yourself.`,
              team_name: teamName,
            },
          }
        }
      }

      const lifecycle = await ownedLifecycle(teamName)
      // Without its config, a team whose record names another lead is gone
      // and what is left may be another session's; only let go of it, or this
      // lead could never form another team.
      if (teamFile || lifecycle !== 'foreign') {
        const finalTaskSnapshot = await cleanupTeamDirectories(
          teamName,
          lifecycle === 'foreign' ? undefined : lifecycle,
        )
        finalTasks = finalTaskSnapshot.tasks.filter(task => !task.metadata?._internal)
        taskListSnapshotAt = finalTaskSnapshot.capturedAt
        taskListSnapshotRevision = finalTaskSnapshot.revision
        // Already cleaned — don't try again on gracefulShutdown.
        unregisterTeamForSessionCleanup(teamName, {
          generation: finalTaskSnapshot.generation,
          identity: finalTaskSnapshot.identity,
        })
      } else {
        alreadyRemoved = true
      }

      // Clear color assignments so new teams start fresh
      clearTeammateColors()

      // Clear leader team name so getTaskListId() falls back to session ID
      clearLeaderTeamName()

      logEvent('tengu_team_deleted', {
        team_name:
          teamName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }

    // Clear team context and inbox from app state
    setAppState(prev => ({
      ...prev,
      teamContext: undefined,
      inbox: {
        messages: [], // Clear any queued messages
      },
    }))

    return {
      data: {
        success: true,
        message: !teamName
          ? 'No team name found, nothing to clean up'
          : alreadyRemoved
            ? `Team "${teamName}" was already removed; this session no longer leads it`
            : `Cleaned up directories and worktrees for team "${teamName}"`,
        team_name: teamName,
        finalTasks,
        taskListSnapshotAt,
        taskListSnapshotRevision,
      },
    }
  },

  renderToolUseMessage,
  renderToolResultMessage,
} satisfies ToolDef<InputSchema, Output>)
