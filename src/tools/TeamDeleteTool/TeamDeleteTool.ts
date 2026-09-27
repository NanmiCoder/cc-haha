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
import { clearLeaderTeamName, type Task } from '../../utils/tasks.js'
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
              message: `Cannot cleanup team with ${nonLeadMembers.length} registered teammate(s): ${memberNames}. Use requestShutdown and wait for shutdown approval first.`,
              team_name: teamName,
            },
          }
        }
      }

      const finalTaskSnapshot = await cleanupTeamDirectories(
        teamName,
        getRegisteredTeamLifecycle(teamName),
      )
      finalTasks = finalTaskSnapshot.tasks.filter(task => !task.metadata?._internal)
      taskListSnapshotAt = finalTaskSnapshot.capturedAt
      taskListSnapshotRevision = finalTaskSnapshot.revision
      // Already cleaned — don't try again on gracefulShutdown.
      unregisterTeamForSessionCleanup(teamName, {
        generation: finalTaskSnapshot.generation,
        identity: finalTaskSnapshot.identity,
      })

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
        message: teamName
          ? `Cleaned up directories and worktrees for team "${teamName}"`
          : 'No team name found, nothing to clean up',
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
