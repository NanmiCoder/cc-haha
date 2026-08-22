import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { Tool, ToolUseContext } from '../../Tool.js'
import { toolMatchesName } from '../../Tool.js'
import {
  createActivityDescriptionResolver,
  createProgressTracker,
  getTokenCountFromTracker,
  updateProgressFromMessage,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type {
  AgentDefinition,
  BuiltInAgentDefinition,
} from '../../tools/AgentTool/loadAgentsDir.js'
import { getLastToolUseName } from '../../tools/AgentTool/agentToolUtils.js'
import { runAgent } from '../../tools/AgentTool/runAgent.js'
import {
  createSyntheticOutputTool,
  SYNTHETIC_OUTPUT_TOOL_NAME,
} from '../../tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { assembleToolPool } from '../../tools.js'
import type { Message } from '../../types/message.js'
import { createAbortController } from '../abortController.js'
import { runWithCwdOverride } from '../cwd.js'
import { logForDebugging } from '../debug.js'
import { createUserMessage, extractTextContent } from '../messages.js'
import { createAgentId } from '../uuid.js'
import type { AgentMetadata } from '../sessionStorage.js'
import {
  createAgentWorktreeIfSupported,
  hasWorktreeChanges,
  removeAgentWorktree,
  type AgentWorktree,
} from '../worktree.js'
import {
  WORKFLOW_SUBAGENT_PROMPT,
  WORKFLOW_SUBAGENT_TYPE,
  workflowStructuredOutputNote,
  workflowStructuredSubagentPrompt,
} from './constants.js'
import type { WorkflowAgentOptions } from './types.js'

/**
 * The agent definition every workflow subagent runs under.
 *
 * `permissionMode: 'acceptEdits'` is deliberate and independent of the
 * session's mode: the script is the orchestrator and there is nobody to
 * approve each of a hundred file edits. Tool calls still go through the
 * session allowlist, so shell/MCP calls can prompt.
 */
function buildWorkflowAgentDefinition(
  schemaToolName: string | undefined,
): BuiltInAgentDefinition {
  return {
    agentType: WORKFLOW_SUBAGENT_TYPE,
    whenToUse: 'Internal subagent for workflow script orchestration.',
    tools: ['*'],
    source: 'built-in',
    baseDir: 'built-in',
    permissionMode: 'acceptEdits',
    getSystemPrompt: () =>
      schemaToolName
        ? workflowStructuredSubagentPrompt(schemaToolName)
        : WORKFLOW_SUBAGENT_PROMPT,
  }
}


export type WorkflowAgentRunParams = {
  prompt: string
  opts?: WorkflowAgentOptions
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  runId: string
  /** Agent transcript that launched this workflow; persisted on each worker. */
  ownerAgentId?: string
  /** Workflow/phase provenance stamped onto the agent's sidecar metadata. */
  workflow?: AgentMetadata['workflow']
  /** Per-agent controller so the user can skip or restart a single agent. */
  abortController: AbortController
  /** Called once the agent id is known, before the first model request. */
  onAgentId: (agentId: string) => void
  /** Called on every assistant message with the running token/tool totals. */
  onProgress: (progress: {
    tokens: number
    toolCalls: number
    lastToolName?: string
  }) => void
}

export type WorkflowAgentRunResult = {
  agentId: string
  /** Structured output object when a schema was given, otherwise the final text. */
  value: unknown
  tokens: number
  toolCalls: number
  worktreePath?: string
}

/**
 * Run one `agent()` call to completion and return its value to the script.
 *
 * With a `schema`, the agent is forced through `StructuredOutput` and the
 * validated object is returned — validation happens at the tool-call layer so
 * the model retries a bad shape itself instead of the script parsing prose.
 */
export async function runWorkflowAgent(
  params: WorkflowAgentRunParams,
): Promise<WorkflowAgentRunResult> {
  const {
    prompt,
    opts,
    toolUseContext,
    canUseTool,
    runId,
    ownerAgentId,
    workflow,
    abortController,
    onAgentId,
    onProgress,
  } = params

  const agentDefinition = resolveAgentDefinition(toolUseContext, opts)
  const schemaTool = buildSchemaTool(opts?.schema)
  if (schemaTool && 'error' in schemaTool) {
    throw new Error(`agent({schema}): ${schemaTool.error}`)
  }

  const appState = toolUseContext.getAppState()
  const workerPermissionContext = {
    ...appState.toolPermissionContext,
    mode: agentDefinition.permissionMode ?? ('acceptEdits' as const),
  }
  const basePool = assembleToolPool(workerPermissionContext, appState.mcp.tools)
  // A parent StructuredOutput (from --json-schema) carries a different schema;
  // leaving it in would let the agent satisfy the wrong contract.
  const availableTools: Tool[] = schemaTool
    ? [
        ...basePool.filter(
          tool => !toolMatchesName(tool, SYNTHETIC_OUTPUT_TOOL_NAME),
        ),
        schemaTool.tool,
      ]
    : [...basePool]

  const agentId = createAgentId()
  onAgentId(agentId)

  const promptText = schemaTool
    ? `${prompt}${workflowStructuredOutputNote(SYNTHETIC_OUTPUT_TOOL_NAME)}`
    : prompt

  // Isolation is best-effort: a workspace with no git repository and no
  // WorktreeCreate hook has no worktree to give, and failing every agent over
  // that would make the whole run unusable. The agent runs in the shared cwd
  // instead; the harness reports the degrade once per run.
  let worktree: AgentWorktree | null = null
  if (opts?.isolation === 'worktree') {
    const attempt = await createAgentWorktreeIfSupported(
      `agent-${agentId.slice(0, 8)}`,
    )
    worktree = attempt.worktree ?? null
  }

  const tracker = createProgressTracker()
  const resolveActivity = createActivityDescriptionResolver(
    toolUseContext.options.tools,
  )
  const messages: Message[] = []
  let structuredOutput: unknown

  const runInCwd = <T,>(fn: () => T): T =>
    worktree ? runWithCwdOverride(worktree.worktreePath, fn) : fn()

  try {
    const iterator = runInCwd(() =>
      runAgent({
        agentDefinition,
        promptMessages: [createUserMessage({ content: promptText })],
        toolUseContext: {
          ...toolUseContext,
          abortController,
          agentId,
          agentType: agentDefinition.agentType,
          options: {
            ...toolUseContext.options,
            tools: availableTools,
            ...(opts?.model ? { mainLoopModel: opts.model } : {}),
          },
        },
        canUseTool,
        isAsync: false,
        canShowPermissionPrompts: true,
        querySource: 'workflow_agent',
        model: opts?.model,
        availableTools,
        description: opts?.label ?? prompt.slice(0, 60),
        ...(ownerAgentId ? { ownerAgentId } : {}),
        ...(workflow ? { workflow } : {}),
        // Deliberately no `transcriptSubdir`. A workflow agent is an ordinary
        // subagent run by the same runner, so its transcript belongs in the
        // session's flat `subagents/` directory with every other one — that is
        // the only place the reader looks, and routing these into
        // `subagents/workflows/<runId>/` is what made them unopenable in the
        // UI. The run's journal still lives in the per-run directory.
        ...(worktree ? { worktreePath: worktree.worktreePath } : {}),
        override: { agentId, abortController },
      }),
    )

    for await (const message of iterator) {
      messages.push(message)
      if (
        message.type === 'attachment' &&
        message.attachment.type === 'structured_output'
      ) {
        structuredOutput = message.attachment.data
        continue
      }
      if (message.type !== 'assistant') continue
      updateProgressFromMessage(
        tracker,
        message,
        resolveActivity,
        toolUseContext.options.tools,
      )
      onProgress({
        tokens: getTokenCountFromTracker(tracker),
        toolCalls: tracker.toolUseCount,
        lastToolName: getLastToolUseName(message),
      })
    }
  } finally {
    if (worktree) {
      await cleanupWorkflowWorktree(worktree).catch(error =>
        logForDebugging(
          `Workflow worktree cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
    }
  }

  const value = schemaTool
    ? structuredOutput
    : extractFinalText(messages)

  if (schemaTool && structuredOutput === undefined) {
    throw new Error(
      `agent({schema}): the subagent ended without calling ${SYNTHETIC_OUTPUT_TOOL_NAME}`,
    )
  }

  return {
    agentId,
    value: value ?? null,
    tokens: getTokenCountFromTracker(tracker),
    toolCalls: tracker.toolUseCount,
    ...(worktree ? { worktreePath: worktree.worktreePath } : {}),
  }
}

/**
 * Resolve `opts.agentType` against the session's active agents.
 *
 * A named agent keeps its own system prompt and tool list — the workflow only
 * supplies the prompt — so a script can reuse `code-reviewer` or a custom
 * agent instead of the generic workflow subagent.
 */
function resolveAgentDefinition(
  toolUseContext: ToolUseContext,
  opts: WorkflowAgentOptions | undefined,
): AgentDefinition {
  const requested = opts?.agentType
  const schemaToolName = opts?.schema ? SYNTHETIC_OUTPUT_TOOL_NAME : undefined
  if (requested == null) return buildWorkflowAgentDefinition(schemaToolName)

  const activeAgents = toolUseContext.options.agentDefinitions.activeAgents
  const match = activeAgents.find(agent => agent.agentType === requested)
  if (!match) {
    const available = activeAgents.map(agent => agent.agentType).join(', ')
    throw new Error(
      `agent({agentType}): agent type '${requested}' not found. Available agents: ${available}`,
    )
  }
  if (!schemaToolName) return match
  // Custom agent + schema: keep its prompt but append the StructuredOutput
  // instruction so the two contracts don't fight.
  const basePrompt = match.getSystemPrompt({
    toolUseContext: { options: toolUseContext.options },
  } as never)
  return {
    ...match,
    getSystemPrompt: () =>
      `${basePrompt}\n${workflowStructuredOutputNote(schemaToolName)}`,
  } as AgentDefinition
}

function buildSchemaTool(
  schema: unknown,
): { tool: Tool } | { error: string } | undefined {
  if (schema == null) return undefined
  if (typeof schema !== 'object' || Array.isArray(schema)) {
    return { error: 'schema must be a JSON Schema object' }
  }
  return createSyntheticOutputTool(schema as Record<string, unknown>) as
    | { tool: Tool }
    | { error: string }
}

/**
 * The agent's final text. Falls back to the last assistant message that had
 * any text, so a run that ended on a bare tool_use block still returns
 * something instead of an empty string.
 */
function extractFinalText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type !== 'assistant') continue
    const text = extractTextContent(message.message.content, '\n').trim()
    if (text !== '') return text
  }
  return ''
}

async function cleanupWorkflowWorktree(worktree: AgentWorktree): Promise<void> {
  const { worktreePath, worktreeBranch, headCommit, gitRoot, hookBased } =
    worktree
  if (hookBased) return
  if (!headCommit) return
  if (await hasWorktreeChanges(worktreePath, headCommit)) return
  await removeAgentWorktree(worktreePath, worktreeBranch, gitRoot)
}

/** Exposed so the harness can create per-agent controllers consistently. */
export function createWorkflowAgentController(
  parent: AbortSignal | undefined,
): AbortController {
  const controller = createAbortController()
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason)
    else
      parent.addEventListener('abort', () => controller.abort(parent.reason), {
        once: true,
      })
  }
  return controller
}
