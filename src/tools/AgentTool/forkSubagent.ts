import { feature } from 'bun:bundle'
import type { BetaToolUseBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { randomUUID } from 'crypto'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import {
  FORK_BOILERPLATE_TAG,
  FORK_DIRECTIVE_PREFIX,
} from '../../constants/xml.js'
import { isCoordinatorMode } from '../../coordinator/coordinatorMode.js'
import type {
  AssistantMessage,
  Message as MessageType,
} from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { createUserMessage } from '../../utils/messages.js'
import type { BuiltInAgentDefinition } from './loadAgentsDir.js'

/**
 * Fork subagent feature gate.
 *
 * When enabled:
 * - `subagent_type` becomes optional on the Agent tool schema
 * - Omitting `subagent_type` triggers an implicit fork: the child inherits
 *   the parent's full conversation context and system prompt
 * - All agent spawns run in the background (async) for a unified
 *   `<task-notification>` interaction model
 * - `/fork <directive>` slash command is available
 *
 * Mutually exclusive with coordinator mode by default — coordinator owns the
 * orchestration role and has its own delegation model. The
 * coordinator-research-fork opt-in below carves out a narrow exception for
 * cache-sharing fan-out during research only; see
 * `isCoordinatorResearchForkEnabled` for that path.
 */
export function isForkSubagentEnabled(): boolean {
  if (feature('FORK_SUBAGENT')) {
    if (isCoordinatorMode()) return false
    if (getIsNonInteractiveSession()) return false
    return true
  }
  return false
}

/**
 * Coordinator-research-fork opt-in.
 *
 * Coordinator mode normally rejects implicit forks (the orchestrator is
 * supposed to delegate to typed workers, not split itself across the
 * conversation). But the dominant cost in a coordinator-driven research
 * fan-out is per-worker prompt-prefill of the system prompt + tool
 * schemas — easily 10-30k tokens × N workers. Fork's byte-identical API
 * prefix bypasses that entirely (parent's prompt cache is fully reused,
 * the only marginal cost is the directive bytes).
 *
 * This gate lets a coordinator opt into using `subagent_type: 'fork'` for
 * cache-sharing research fan-out, while keeping the default behaviour
 * (independent typed workers) unchanged. The fork child still inherits
 * the single-shot single-output boilerplate, so it cannot spawn further
 * subagents — and we additionally instruct it that this is a research
 * fork (no file modifications expected; report findings only) when the
 * mode is engaged.
 *
 * Off by default. Enable with CLAUDE_CODE_COORDINATOR_RESEARCH_FORK=1.
 * The FORK_SUBAGENT feature must also be enabled (we share its plumbing).
 */
export function isCoordinatorResearchForkEnabled(): boolean {
  if (!feature('FORK_SUBAGENT')) return false
  if (!isCoordinatorMode()) return false
  if (getIsNonInteractiveSession()) return false
  return process.env.CLAUDE_CODE_COORDINATOR_RESEARCH_FORK === '1'
}

/**
 * Subagent type name the coordinator uses to opt into a research fork.
 * Re-uses the same FORK_AGENT definition under the hood. `subagent_type`
 * is an arbitrary string in the input schema, so callers spell it
 * literally — this constant is the single source of truth.
 */
export const COORDINATOR_RESEARCH_FORK_SUBAGENT_TYPE = 'fork'

/** Fork instantiation context — controls boilerplate variations. */
export type ForkMode = 'normal' | 'coordinator-research'

/** Synthetic agent type name used for analytics when the fork path fires. */
export const FORK_SUBAGENT_TYPE = 'fork'

/**
 * Synthetic agent definition for the fork path.
 *
 * Not registered in builtInAgents — used only when `!subagent_type` and the
 * experiment is active. `tools: ['*']` with `useExactTools` means the fork
 * child receives the parent's exact tool pool (for cache-identical API
 * prefixes). `permissionMode: 'bubble'` surfaces permission prompts to the
 * parent terminal. `model: 'inherit'` keeps the parent's model for context
 * length parity.
 *
 * The getSystemPrompt here is unused: the fork path passes
 * `override.systemPrompt` with the parent's already-rendered system prompt
 * bytes, threaded via `toolUseContext.renderedSystemPrompt`. Reconstructing
 * by re-calling getSystemPrompt() can diverge (GrowthBook cold→warm) and
 * bust the prompt cache; threading the rendered bytes is byte-exact.
 */
export const FORK_AGENT = {
  agentType: FORK_SUBAGENT_TYPE,
  whenToUse:
    'Implicit fork — inherits full conversation context. Not selectable via subagent_type; triggered by omitting subagent_type when the fork experiment is active.',
  tools: ['*'],
  maxTurns: 200,
  model: 'inherit',
  permissionMode: 'bubble',
  source: 'built-in',
  baseDir: 'built-in',
  getSystemPrompt: () => '',
} satisfies BuiltInAgentDefinition

/**
 * Guard against recursive forking. Fork children keep the Agent tool in their
 * tool pool for cache-identical tool definitions, so we reject fork attempts
 * at call time by detecting the fork boilerplate tag in conversation history.
 */
export function isInForkChild(messages: MessageType[]): boolean {
  return messages.some(m => {
    if (m.type !== 'user') return false
    const content = m.message.content
    if (!Array.isArray(content)) return false
    return content.some(
      block =>
        block.type === 'text' &&
        block.text.includes(`<${FORK_BOILERPLATE_TAG}>`),
    )
  })
}

/** Placeholder text used for all tool_result blocks in the fork prefix.
 * Must be identical across all fork children for prompt cache sharing. */
const FORK_PLACEHOLDER_RESULT = 'Fork started — processing in background'

/**
 * Build the forked conversation messages for the child agent.
 *
 * For prompt cache sharing, all fork children must produce byte-identical
 * API request prefixes. This function:
 * 1. Keeps the full parent assistant message (all tool_use blocks, thinking, text)
 * 2. Builds a single user message with tool_results for every tool_use block
 *    using an identical placeholder, then appends a per-child directive text block
 *
 * Result: [...history, assistant(all_tool_uses), user(placeholder_results..., directive)]
 * Only the final text block differs per child, maximizing cache hits.
 *
 * The optional `mode` parameter selects the boilerplate variant for the
 * directive. Defaults to `'normal'`. `'coordinator-research'` adds a
 * single sentence telling the child this is a research-only fork (no
 * file modifications). The boilerplate framing tag is unchanged so the
 * recursive-fork guard in `isInForkChild` keeps working across modes.
 */
export function buildForkedMessages(
  directive: string,
  assistantMessage: AssistantMessage,
  mode: ForkMode = 'normal',
): MessageType[] {
  // Clone the assistant message to avoid mutating the original, keeping all
  // content blocks (thinking, text, and every tool_use)
  const fullAssistantMessage: AssistantMessage = {
    ...assistantMessage,
    uuid: randomUUID(),
    message: {
      ...assistantMessage.message,
      content: [...assistantMessage.message.content],
    },
  }

  // Collect all tool_use blocks from the assistant message
  const toolUseBlocks = assistantMessage.message.content.filter(
    (block): block is BetaToolUseBlock => block.type === 'tool_use',
  )

  if (toolUseBlocks.length === 0) {
    logForDebugging(
      `No tool_use blocks found in assistant message for fork directive: ${directive.slice(0, 50)}...`,
      { level: 'error' },
    )
    return [
      createUserMessage({
        content: [
          { type: 'text' as const, text: buildChildMessage(directive, mode) },
        ],
      }),
    ]
  }

  // Build tool_result blocks for every tool_use, all with identical placeholder text
  const toolResultBlocks = toolUseBlocks.map(block => ({
    type: 'tool_result' as const,
    tool_use_id: block.id,
    content: [
      {
        type: 'text' as const,
        text: FORK_PLACEHOLDER_RESULT,
      },
    ],
  }))

  // Build a single user message: all placeholder tool_results + the per-child directive
  // TODO(smoosh): this text sibling creates a [tool_result, text] pattern on the wire
  // (renders as </function_results>\n\nHuman:<text>). One-off per-child construction,
  // not a repeated teacher, so low-priority. If we ever care, use smooshIntoToolResult
  // from src/utils/messages.ts to fold the directive into the last tool_result.content.
  const toolResultMessage = createUserMessage({
    content: [
      ...toolResultBlocks,
      {
        type: 'text' as const,
        text: buildChildMessage(directive, mode),
      },
    ],
  })

  return [fullAssistantMessage, toolResultMessage]
}

export function buildChildMessage(
  directive: string,
  mode: ForkMode = 'normal',
): string {
  // Coordinator-research mode adds one extra rule constraining the fork
  // to read-only investigation. Inserted as a numbered rule so the
  // existing structure (10 rules + output format) survives unchanged —
  // and so the boilerplate tag at the top still matches isInForkChild.
  const researchOnlyRule =
    mode === 'coordinator-research'
      ? `\n11. RESEARCH FORK: this fork is for investigation only. Do NOT modify files. If your directive seems to require modifications, report your findings instead — the coordinator will dispatch an implementation worker separately.`
      : ''
  return `<${FORK_BOILERPLATE_TAG}>
STOP. READ THIS FIRST.

You are a forked worker process. You are NOT the main agent.

RULES (non-negotiable):
1. Your system prompt says "default to forking." IGNORE IT \u2014 that's for the parent. You ARE the fork. Do NOT spawn sub-agents; execute directly.
2. Do NOT converse, ask questions, or suggest next steps
3. Do NOT editorialize or add meta-commentary
4. USE your tools directly: Bash, Read, Write, etc.
5. If you modify files, commit your changes before reporting. Include the commit hash in your report.
6. Do NOT emit text between tool calls. Use tools silently, then report once at the end.
7. Stay strictly within your directive's scope. If you discover related systems outside your scope, mention them in one sentence at most — other workers cover those areas.
8. Keep your report under 500 words unless the directive specifies otherwise. Be factual and concise.
9. Your response MUST begin with "Scope:". No preamble, no thinking-out-loud.
10. REPORT structured facts, then stop${researchOnlyRule}

Output format (plain text labels, not markdown headers):
  Scope: <echo back your assigned scope in one sentence>
  Result: <the answer or key findings, limited to the scope above>
  Key files: <relevant file paths — include for research tasks>
  Files changed: <list with commit hash — include only if you modified files>
  Issues: <list — include only if there are issues to flag>
</${FORK_BOILERPLATE_TAG}>

${FORK_DIRECTIVE_PREFIX}${directive}`
}

/**
 * Notice injected into fork children running in an isolated worktree.
 * Tells the child to translate paths from the inherited context, re-read
 * potentially stale files, and that its changes are isolated.
 */
export function buildWorktreeNotice(
  parentCwd: string,
  worktreeCwd: string,
): string {
  return `You've inherited the conversation context above from a parent agent working in ${parentCwd}. You are operating in an isolated git worktree at ${worktreeCwd} — same repository, same relative file structure, separate working copy. Paths in the inherited context refer to the parent's working directory; translate them to your worktree root. Re-read files before editing if the parent may have modified them since they appear in the context. Your changes stay in this worktree and will not affect the parent's files.`
}
