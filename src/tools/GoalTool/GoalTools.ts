import { z } from 'zod/v4'
import { getSessionId } from '../../bootstrap/state.js'
import { goalService } from '../../server/services/goalService.js'
import { buildTool } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  CREATE_GOAL_TOOL_NAME,
  GET_GOAL_TOOL_NAME,
  UPDATE_GOAL_TOOL_NAME,
} from './constants.js'
import {
  CREATE_GOAL_DESCRIPTION,
  CREATE_GOAL_PROMPT,
  GET_GOAL_DESCRIPTION,
  GET_GOAL_PROMPT,
  UPDATE_GOAL_DESCRIPTION,
  UPDATE_GOAL_PROMPT,
} from './prompt.js'

const emptyInputSchema = lazySchema(() => z.strictObject({}))
type EmptyInputSchema = ReturnType<typeof emptyInputSchema>

const createGoalInputSchema = lazySchema(() =>
  z.strictObject({
    objective: z.string().min(1).describe('The user-requested goal objective'),
    tokenBudget: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Optional token budget for pursuing this goal'),
  }),
)
type CreateGoalInputSchema = ReturnType<typeof createGoalInputSchema>

const updateGoalInputSchema = lazySchema(() =>
  z.strictObject({
    status: z
      .literal('complete')
      .describe('The only model-writable status. Use after the goal is achieved.'),
  }),
)
type UpdateGoalInputSchema = ReturnType<typeof updateGoalInputSchema>

const goalOutputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    goal: z
      .object({
        sessionId: z.string(),
        goalId: z.string(),
        objective: z.string(),
        status: z.enum(['active', 'paused', 'budget_limited', 'complete']),
        tokenBudget: z.number().optional(),
        tokensUsed: z.number(),
        timeUsedSeconds: z.number(),
        createdAt: z.string(),
        updatedAt: z.string(),
      })
      .nullable(),
    message: z.string().optional(),
  }),
)

function isDesktopGoalToolEnabled(): boolean {
  return Boolean(process.env.CC_HAHA_DESKTOP_SERVER_URL)
}

export const GetGoalTool = buildTool({
  name: GET_GOAL_TOOL_NAME,
  aliases: ['get_goal'],
  searchHint: 'read persistent session objective',
  maxResultSizeChars: 20_000,
  alwaysLoad: true,
  async description() {
    return GET_GOAL_DESCRIPTION
  },
  async prompt() {
    return GET_GOAL_PROMPT
  },
  get inputSchema(): EmptyInputSchema {
    return emptyInputSchema()
  },
  get outputSchema() {
    return goalOutputSchema()
  },
  isEnabled() {
    return isDesktopGoalToolEnabled()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  renderToolUseMessage() {
    return null
  },
  async call() {
    const goal = await goalService.getGoal(getSessionId())
    return {
      data: {
        success: true,
        goal,
        message: goal ? undefined : 'No session goal is set.',
      },
    }
  },
})

export const CreateGoalTool = buildTool({
  name: CREATE_GOAL_TOOL_NAME,
  aliases: ['create_goal'],
  searchHint: 'create persistent session objective',
  maxResultSizeChars: 20_000,
  alwaysLoad: true,
  async description() {
    return CREATE_GOAL_DESCRIPTION
  },
  async prompt() {
    return CREATE_GOAL_PROMPT
  },
  get inputSchema(): CreateGoalInputSchema {
    return createGoalInputSchema()
  },
  get outputSchema() {
    return goalOutputSchema()
  },
  isEnabled() {
    return isDesktopGoalToolEnabled()
  },
  isConcurrencySafe() {
    return false
  },
  renderToolUseMessage() {
    return null
  },
  toAutoClassifierInput(input) {
    return input.objective
  },
  async call({ objective, tokenBudget }) {
    const goal = await goalService.setGoalObjective(getSessionId(), objective, {
      tokenBudget,
    })
    return {
      data: {
        success: true,
        goal,
        message: 'Goal created.',
      },
    }
  },
})

export const UpdateGoalTool = buildTool({
  name: UPDATE_GOAL_TOOL_NAME,
  aliases: ['update_goal'],
  searchHint: 'complete persistent session objective',
  maxResultSizeChars: 20_000,
  alwaysLoad: true,
  async description() {
    return UPDATE_GOAL_DESCRIPTION
  },
  async prompt() {
    return UPDATE_GOAL_PROMPT
  },
  get inputSchema(): UpdateGoalInputSchema {
    return updateGoalInputSchema()
  },
  get outputSchema() {
    return goalOutputSchema()
  },
  isEnabled() {
    return isDesktopGoalToolEnabled()
  },
  isConcurrencySafe() {
    return false
  },
  renderToolUseMessage() {
    return null
  },
  async call() {
    const goal = await goalService.setGoalStatus(getSessionId(), 'complete')
    return {
      data: {
        success: Boolean(goal),
        goal,
        message: goal ? 'Goal marked complete.' : 'No session goal is set.',
      },
    }
  },
})
