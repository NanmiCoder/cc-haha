/**
 * Coordinator-mode agent registry.
 *
 * When `feature('COORDINATOR_MODE')` is enabled and the user starts the
 * CLI with `CLAUDE_CODE_COORDINATOR_MODE=1`, the main thread takes the
 * "coordinator" role and the agent list returned here replaces the
 * default flat 15-agent registry.
 *
 * The shape is "coordinator + experts":
 *   - WORKER_AGENT: a generic delegate (full tool access) for any task
 *     that doesn't have a specialist. Matches the existing coordinator
 *     system prompt's `subagent_type: "worker"` references.
 *   - The existing 11 specialists from the default registry, minus
 *     `general-purpose` (replaced by `worker`), `claude-code-guide` (a
 *     docs lookup, not orchestrator-relevant), and `statusline-setup`
 *     (a niche shell helper that doesn't fit the orchestrator workflow).
 *   - Explore + Plan + verification: always included so coordinators can
 *     parallelise research / planning / adversarial verification — these
 *     are the three highest-leverage delegations in the workflow.
 *
 * This file replaces a generated stub. The stub had a Proxy fallback for
 * unrelated symbols (createCachedMCState, isCachedMicrocompactEnabled,
 * etc.) that turned out not to be imported from this path elsewhere in
 * the codebase, so dropping them is safe.
 */

import { CODE_REVIEWER_AGENT } from '../tools/AgentTool/built-in/codeReviewerAgent.js'
import { COMMIT_PR_AGENT } from '../tools/AgentTool/built-in/commitPrAgent.js'
import { DEBUGGER_AGENT } from '../tools/AgentTool/built-in/debuggerAgent.js'
import { DOCS_WRITER_AGENT } from '../tools/AgentTool/built-in/docsWriterAgent.js'
import { EXPLORE_AGENT } from '../tools/AgentTool/built-in/exploreAgent.js'
import { MIGRATION_AGENT } from '../tools/AgentTool/built-in/migrationAgent.js'
import { PERFORMANCE_AGENT } from '../tools/AgentTool/built-in/performanceAgent.js'
import { PLAN_AGENT } from '../tools/AgentTool/built-in/planAgent.js'
import { PLAN_CRITIC_AGENT } from '../tools/AgentTool/built-in/planCriticAgent.js'
import { REFACTOR_AGENT } from '../tools/AgentTool/built-in/refactorAgent.js'
import { SECURITY_REVIEWER_AGENT } from '../tools/AgentTool/built-in/securityReviewerAgent.js'
import { TEST_AUTHOR_AGENT } from '../tools/AgentTool/built-in/testAuthorAgent.js'
import { VERIFICATION_AGENT } from '../tools/AgentTool/built-in/verificationAgent.js'
import type {
  AgentDefinition,
  BuiltInAgentDefinition,
} from '../tools/AgentTool/loadAgentsDir.js'

const WORKER_SYSTEM_PROMPT = `You are a worker agent for Claude Code's coordinator mode. The coordinator has delegated a specific, self-contained task to you. Complete it autonomously using your tools and report back with a concise summary of what you did and the information the coordinator needs.

Your strengths:
- Working autonomously without back-and-forth turns
- Handling research, implementation, OR verification — whichever the coordinator asked for
- Producing a focused report instead of a play-by-play

Guidelines:
- Read the prompt carefully — the coordinator can't see your turn-by-turn tool use, only your final reply.
- For research: report what you found (file paths, line numbers, types involved), not the search queries you ran.
- For implementation: state which files changed, the key edits, and whether you ran tests/build/typecheck. If those produced errors, fix them or surface them.
- For verification: state what you actually ran (build, tests, adversarial probes) and the verdict — do not approve work you only read.
- NEVER create documentation files (*.md, README) unless the task explicitly requires them.
- NEVER prefix the final output with conversational pleasantries — go straight to the report.
- If a task obviously fits a specialist (code review, security, debugging, refactor, migration, docs, performance, commit/PR, tests, verification) the coordinator should be using that specialist instead of you. If you notice this mid-task, complete what you were asked and mention it in your report so the coordinator can route follow-ups correctly.`

/**
 * Generic delegate for the coordinator. Has full tool access so it can
 * research, implement, or verify in a single autonomous run.
 */
export const WORKER_AGENT: BuiltInAgentDefinition = {
  agentType: 'worker',
  whenToUse:
    'Generic worker for any task the coordinator delegates that does not fit a specialist. Use a specialist (code-reviewer, security-reviewer, debugger, refactor, migration, docs-writer, performance, commit-pr, test-author, verification) when the task fits one of them — fall back to worker for everything else.',
  tools: ['*'],
  source: 'built-in',
  baseDir: 'built-in',
  getSystemPrompt: () => WORKER_SYSTEM_PROMPT,
}

/**
 * The list of agents available to a coordinator. Order matters for the
 * agent listing in the coordinator's prompt — `worker` first so the
 * coordinator sees its default option, then specialists grouped by
 * "review/audit", "fix/transform", and "research/verify".
 */
export function getCoordinatorAgents(): AgentDefinition[] {
  return [
    WORKER_AGENT,
    // review / audit
    CODE_REVIEWER_AGENT,
    SECURITY_REVIEWER_AGENT,
    // diagnose / transform
    DEBUGGER_AGENT,
    REFACTOR_AGENT,
    MIGRATION_AGENT,
    PERFORMANCE_AGENT,
    // produce
    DOCS_WRITER_AGENT,
    TEST_AUTHOR_AGENT,
    COMMIT_PR_AGENT,
    // research / verify
    EXPLORE_AGENT,
    PLAN_AGENT,
    PLAN_CRITIC_AGENT,
    VERIFICATION_AGENT,
  ]
}
