import { z } from 'zod/v4'
import type { TaskStateBase } from '../../Task.js'
import { isLocalShellTask } from '../../tasks/LocalShellTask/guards.js'
import { resolveLocalShellTask } from '../../tasks/LocalShellTask/resolveLocalShellTask.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { stopTask } from '../../tasks/stopTask.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { DESCRIPTION, TASK_STOP_TOOL_NAME } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    task_id: z
      .string()
      .optional()
      .describe('The ID of the background task to stop'),
    // shell_id is accepted for backward compatibility with the deprecated KillShell tool
    shell_id: z.string().optional().describe('Deprecated: use task_id instead'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    message: z.string().describe('Status message about the operation'),
    task_id: z.string().describe('The ID of the task that was stopped'),
    task_type: z.string().describe('The type of the task that was stopped'),
    // Optional: tool outputs are persisted to transcripts and replayed on --resume
    // without re-validation, so sessions from before this field was added lack it.
    command: z
      .string()
      .optional()
      .describe('The command or description of the stopped task'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const TaskStopTool = buildTool({
  name: TASK_STOP_TOOL_NAME,
  searchHint: 'kill a running background task',
  // KillShell is the deprecated name - kept as alias for backward compatibility
  // with existing transcripts and SDK users
  aliases: ['KillShell'],
  maxResultSizeChars: 100_000,
  userFacingName: () => (process.env.USER_TYPE === 'ant' ? '' : 'Stop Task'),
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  shouldDefer: true,
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.task_id ?? input.shell_id ?? ''
  },
  async validateInput({ task_id, shell_id }, { getAppState }) {
    // Support both task_id and shell_id (deprecated KillShell compat)
    const id = task_id ?? shell_id
    if (!id) {
      return {
        result: false,
        message: 'Missing required parameter: task_id',
        errorCode: 1,
      }
    }

    const appState = getAppState()
    const task = appState.tasks?.[id] as TaskStateBase | undefined
    const resolved = task && isLocalShellTask(task) && task.status === 'running' && !task.shellCommand
      ? await resolveLocalShellTask(id, getAppState)
      : task
        ? undefined
        : await resolveLocalShellTask(id, getAppState)
    const resolvedTask = resolved?.task ?? task

    if (!resolvedTask) {
      return {
        result: false,
        message: `No task found with ID: ${id}`,
        errorCode: 1,
      }
    }

    if (isLocalShellTask(resolvedTask) && resolvedTask.status === 'running' && resolvedTask.terminationPending) {
      return {
        result: false,
        message: `Task ${id} termination is already in progress`,
        errorCode: 4,
      }
    }

    if (isLocalShellTask(resolvedTask) && resolvedTask.status === 'running' && !resolvedTask.shellCommand) {
      return {
        result: false,
        message: `Task ${id} has no controllable process handle`,
        errorCode: 3,
      }
    }

    if (resolved && !resolved.canStop) {
      return {
        result: false,
        message: `Task ${id} was recovered without a controllable process handle`,
        errorCode: 3,
      }
    }

    if (resolvedTask.status !== 'running') {
      return {
        result: false,
        message: `Task ${id} is not running (status: ${resolvedTask.status})`,
        errorCode: 3,
      }
    }

    if (isLocalShellTask(resolvedTask) && resolvedTask.processObservation === 'unknown') {
      return {
        result: false,
        message: `Task ${id} process state is unverified`,
        errorCode: 3,
      }
    }

    return { result: true }
  },
  async description() {
    return `Stop a running background task by ID`
  },
  async prompt() {
    return DESCRIPTION
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(output),
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async call(
    { task_id, shell_id },
    { getAppState, setAppState },
  ) {
    // Support both task_id and shell_id (deprecated KillShell compat)
    const id = task_id ?? shell_id
    if (!id) {
      throw new Error('Missing required parameter: task_id')
    }

    const result = await stopTask(id, {
      getAppState,
      setAppState,
    })

    return {
      data: {
        message: `Successfully stopped task: ${result.taskId} (${result.command})`,
        task_id: result.taskId,
        task_type: result.taskType,
        command: result.command,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
