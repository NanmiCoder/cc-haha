import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import type { Command } from '../commands.js'
import { AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js'
import { SEND_MESSAGE_TOOL_NAME } from '../tools/SendMessageTool/constants.js'
import { TASK_CREATE_TOOL_NAME } from '../tools/TaskCreateTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from '../tools/TaskUpdateTool/constants.js'
import { TEAM_CREATE_TOOL_NAME } from '../tools/TeamCreateTool/constants.js'
import { isAgentSwarmsEnabled } from '../utils/agentSwarmsEnabled.js'
import { isTeamReviewRequired } from '../utils/swarm/teamPlanPolicy.js'
import { TEAM_PLAN_TOOL_NAME } from '../tools/TeamPlanTool/constants.js'

function teamPrompt(goal: string): string {
  if (!goal) {
    return [
      'Help the user start an Agent Team. They invoked /team without a goal.',
      `Do not call ${TEAM_CREATE_TOOL_NAME} yet. Explain that /team <goal> creates a team for a concrete objective, give one short example, and ask what the team should accomplish.`,
      'Always return this guidance to the user; do not end the turn silently.',
    ].join('\n')
  }

  return [
    'Create and coordinate an Agent Team for the exact goal below.',
    `Start by calling ${TEAM_CREATE_TOOL_NAME} with a concise team name and description.`,
    isTeamReviewRequired()
      ? `Prepare the full member roster, Agent presets, tasks, dependencies and suggested models with concise reasons. ${AGENT_TOOL_NAME} with a team name records draft members only. Submit the complete plan using ${TEAM_PLAN_TOOL_NAME}, then end this turn and wait for human review in the team panel. Do not execute team tasks or start members before approval. The server starts the approved members automatically.`
      : `Break the work into structured ${TASK_CREATE_TOOL_NAME} tasks, launch named teammates with ${AGENT_TOOL_NAME} using the same team_name, keep task state current with ${TASK_UPDATE_TOOL_NAME}, and use ${SEND_MESSAGE_TOOL_NAME} for coordination when useful.`,
    isTeamReviewRequired() ? 'Create a reviewable plan rather than only explaining how to create one.' : 'Do not merely describe how to create the team; create it and proceed with the work.',
    '',
    goal,
  ].join('\n')
}

const teamCommand: Command = {
  type: 'prompt',
  name: 'team',
  description: 'Create an Agent Team for a goal',
  argumentHint: '[goal]',
  progressMessage: 'starting agent team',
  contentLength: 0,
  source: 'builtin',
  allowedTools: [
    TEAM_CREATE_TOOL_NAME,
    TEAM_PLAN_TOOL_NAME,
    TASK_CREATE_TOOL_NAME,
    TASK_UPDATE_TOOL_NAME,
    AGENT_TOOL_NAME,
    SEND_MESSAGE_TOOL_NAME,
  ],
  isEnabled: () => isAgentSwarmsEnabled(),
  async getPromptForCommand(args): Promise<ContentBlockParam[]> {
    return [{ type: 'text', text: teamPrompt(args.trim()) }]
  },
}

export default teamCommand
