import { z } from 'zod/v4'
import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { cronToHuman, parseCronExpression } from '../../utils/cron.js'
import type { CronTask } from '../../utils/cronTasks.js'
import {
  getCronFilePath,
  listAllCronTasks,
  nextCronRunMs,
  updateCronTask,
} from '../../utils/cronTasks.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { getTeammateContext } from '../../utils/teammateContext.js'
import {
  buildCronUpdatePrompt,
  CRON_UPDATE_DESCRIPTION,
  CRON_UPDATE_TOOL_NAME,
  isDurableCronEnabled,
  isKairosCronEnabled,
} from './prompt.js'
import { renderUpdateResultMessage, renderUpdateToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    id: z.string().describe('Job ID returned by CronCreate.'),
    cron: z
      .string()
      .optional()
      .describe('New 5-field cron expression in local time.'),
    prompt: z.string().optional().describe('New prompt to enqueue at each fire time.'),
    name: z.string().optional().describe('New task name.'),
    description: z.string().optional().describe('New task description.'),
    folder: z.string().optional().describe('New working directory path.'),
    model: z.string().optional().describe('New model to use.'),
    permissionMode: z
      .string()
      .optional()
      .describe('New permission mode: "ask" | "auto-accept" | "plan" | "bypass".'),
    worktree: semanticBoolean(z.boolean().optional()).describe(
      'New worktree setting.',
    ),
    recurring: semanticBoolean(z.boolean().optional()).describe(
      'New recurring setting.',
    ),
    frequency: z
      .string()
      .optional()
      .describe('New frequency: "manual" | "hourly" | "daily" | "weekdays" | "weekly".'),
    scheduledTime: z
      .string()
      .optional()
      .describe('New time string (e.g. "09:00").'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    humanSchedule: z.string(),
    updated: z.boolean(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type UpdateOutput = z.infer<OutputSchema>

export const CronUpdateTool = buildTool({
  name: CRON_UPDATE_TOOL_NAME,
  searchHint: 'update/edit a scheduled cron job',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return isKairosCronEnabled()
  },
  toAutoClassifierInput(input) {
    return input.id
  },
  async description() {
    return CRON_UPDATE_DESCRIPTION
  },
  async prompt() {
    return buildCronUpdatePrompt(isDurableCronEnabled())
  },
  getPath() {
    return getCronFilePath()
  },
  async validateInput(input): Promise<ValidationResult> {
    const tasks = await listAllCronTasks()
    const task = tasks.find(t => t.id === input.id)
    if (!task) {
      return {
        result: false,
        message: `No scheduled job with id '${input.id}'`,
        errorCode: 1,
      }
    }
    // Teammates may only update their own crons.
    const ctx = getTeammateContext()
    if (ctx && task.agentId !== ctx.agentId) {
      return {
        result: false,
        message: `Cannot update cron job '${input.id}': owned by another agent`,
        errorCode: 2,
      }
    }
    // Validate new cron expression if provided.
    if (input.cron !== undefined) {
      if (!parseCronExpression(input.cron)) {
        return {
          result: false,
          message: `Invalid cron expression '${input.cron}'. Expected 5 fields: M H DoM Mon DoW.`,
          errorCode: 3,
        }
      }
      if (nextCronRunMs(input.cron, Date.now()) === null) {
        return {
          result: false,
          message: `Cron expression '${input.cron}' does not match any calendar date in the next year.`,
          errorCode: 4,
        }
      }
    }
    return { result: true }
  },
  async call({ id, ...updates }) {
    // Only include fields that were explicitly provided (not undefined).
    // Use a whitelist of valid field names to discard typos.
    const VALID_FIELDS: ReadonlySet<string> = new Set([
      'cron', 'prompt', 'name', 'description', 'folder', 'model',
      'permissionMode', 'worktree', 'recurring', 'frequency', 'scheduledTime',
    ])
    const cleanUpdates: Partial<Omit<CronTask, 'id' | 'createdAt'>> = {}
    for (const [k, v] of Object.entries(updates)) {
      if (v !== undefined && VALID_FIELDS.has(k)) {
        (cleanUpdates as Record<string, unknown>)[k] = v
      }
    }

    // Read the current cron before updating, so we can display the
    // effective schedule without a redundant disk read after the update.
    let currentCron = ''
    if (!updates.cron) {
      const tasks = await listAllCronTasks()
      const t = tasks.find(t => t.id === id)
      currentCron = t?.cron ?? ''
    }

    const updated = await updateCronTask(id, cleanUpdates)
    const effectiveCron = updates.cron ?? currentCron
    const humanSchedule = effectiveCron
      ? cronToHuman(effectiveCron)
      : 'unknown'

    return {
      data: {
        id,
        humanSchedule,
        updated,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: output.updated
        ? `Updated job ${output.id} (${output.humanSchedule}).`
        : `Job ${output.id} not found — it may have been deleted.`,
    }
  },
  renderToolUseMessage: renderUpdateToolUseMessage,
  renderToolResultMessage: renderUpdateResultMessage,
} satisfies ToolDef<InputSchema, UpdateOutput>)
