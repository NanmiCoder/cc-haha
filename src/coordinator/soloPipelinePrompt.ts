/**
 * Solo Pipeline mode — system prompt template.
 *
 * Sibling to `coordinatorMode.ts`. While coordinator mode does
 * dynamic fan-out (the lead AI decides what to delegate, when, and
 * to whom), Solo Pipeline mode runs a fixed five-stage script with
 * gates between stages: plan → implement → test → review (HUMAN
 * APPROVAL) → land.
 *
 * This module owns ONLY the prompt text + the boolean predicate
 * (`isSoloPipelineMode`). Wiring (CLI flag plumbing,
 * `--append-system-prompt`, WS `set_pipeline_mode { flavor }`,
 * desktop toggle) lives in the consumer layer and lands in a
 * follow-up PR after the in-flight coordinator-mode optimization
 * stabilizes the geometry it has to plug into.
 *
 * Why a separate module instead of a flag inside coordinatorMode:
 *   - Solo's prompt is a different shape (staged + gated) and would
 *     dilute coordinatorMode.ts. Keeping them sibling-but-separate
 *     means each can evolve on its own cadence.
 *   - The wiring layer (consumer of `getSoloPipelineSystemPrompt`)
 *     can dispatch on `flavor` cleanly: `flavor === 'solo'` → this
 *     prompt, otherwise the coordinator prompt or default.
 *
 * Stage 0 — intent triage — is in the prompt itself, not in the
 * wiring. Any chat message that arrives while Solo is on goes
 * through Stage 0 first; only TASK-classed messages engage the
 * pipeline. This is what gives the user the "I turned Solo on but
 * said hello and nothing weird happened" experience that's a hard
 * requirement for the toggle to be non-scary.
 */

import { feature } from 'bun:bundle'
import { isEnvTruthy } from '../utils/envUtils.js'

/**
 * The env var the CLI subprocess sees. Mirrors the
 * `CLAUDE_CODE_COORDINATOR_MODE` pattern so the WS handler's
 * `getRuntimeArgs` can flip both modes through the same plumbing
 * once we wire it: when `flavor === 'solo'` the desktop sends an
 * env override + the system-prompt append; the CLI side reads
 * either env var via the predicate below and chooses the right
 * prompt in `systemPrompt.ts`.
 *
 * Tied to the same `COORDINATOR_MODE` feature flag for now: Solo
 * is a flavor of coordinator, not a separate engine, so the two
 * gate together. A future feature flag split is fine if the modes
 * diverge enough to warrant independent rollout.
 */
const SOLO_PIPELINE_ENV_VAR = 'CLAUDE_CODE_SOLO_PIPELINE_MODE'

/**
 * Predicate consumed by `systemPrompt.ts` (and tool-list builders,
 * once they exist for Solo) to decide whether the Solo prompt
 * should be active. Same shape as `isCoordinatorMode` so the
 * future systemPrompt branch reads symmetrically.
 */
export function isSoloPipelineMode(): boolean {
  if (!feature('COORDINATOR_MODE')) return false
  return isEnvTruthy(process.env[SOLO_PIPELINE_ENV_VAR])
}

/**
 * The Solo Pipeline system prompt.
 *
 * Held as a function (not a const) so the future wiring layer can
 * thread project-specific context in (e.g. the workdir's primary
 * language, the verification command from AGENTS.md, the user's
 * configured specialist agent set) without breaking the calling
 * shape. Today it's static.
 *
 * The prompt itself is intentionally English-only — model
 * compliance is consistently better on English instruction blocks
 * than on Chinese ones, and this matches the
 * `getCoordinatorSystemPrompt` precedent. User-facing strings
 * (Stage announcements, gate copy) are still localizable through
 * the desktop's i18n layer when the Solo wiring layer renders the
 * status chip + welcome card; the AI's INTERNAL stage logic stays
 * in this English block.
 */
export function getSoloPipelineSystemPrompt(): string {
  return SOLO_PIPELINE_PROMPT
}

const SOLO_PIPELINE_PROMPT = `# Solo Pipeline Mode

You are operating in **Solo Pipeline mode**: a staged, gated workflow for
turning one feature/change request into shipped, verified work. You drive
five stages in order, delegating each to a specialist subagent, and you
pause at human gates. You are the conductor — you do NOT write the code,
run the tests, or approve the work yourself; you route to the right
specialist and enforce the gate between stages.

## STAGE 0 — Intent triage (ALWAYS run this first, silently)

Before engaging the pipeline, classify the user's latest message:

- **CHAT / QUESTION** — greetings, "how does X work", "what do you think",
  explanations, opinions, small one-off lookups, or anything that is NOT a
  request to build / change / fix something concrete.
  → Do NOT start the pipeline. Answer normally and briefly. Do not mention
    stages. At most, end with one line: "(Solo mode is on — tell me a
    feature or fix to build and I'll run the full pipeline.)"

- **TASK** — a concrete request to design, build, change, fix, refactor,
  test, or ship something.
  → Engage the pipeline. Announce it (see below), then start Stage 1.

- **AMBIGUOUS** — could be either.
  → Ask ONE short clarifying question before engaging. Do not spin up
    subagents on a guess.

Never run the pipeline for chat. The cost of five specialist sessions is
only justified for real build work.

## Announcing the pipeline (when a TASK is detected)

Open with a one-line, scannable plan, e.g.:

  "Solo pipeline: ① plan → ② implement → ③ test → ④ review (your
   approval) → ⑤ land. Starting Stage 1: planning."

Keep the user oriented: at each stage transition, print a single status
line "▸ Stage N/5: <name> — <one-line goal>".

## The five stages

1. **PLAN** (specialist: planner / context-gatherer)
   - Inspect the real code first. Produce a short written plan: the
     changed surface, the approach, the files to touch, the success
     criteria, and the verification commands.
   - Hand-off artifact: \`plan\` (the written plan).
   - GATE → automatic. Advance when the plan names concrete files +
     a verification command. If it can't, loop back with the user.

2. **IMPLEMENT** (specialist: implementer)
   - Receives the plan verbatim. Makes the narrowest change that
     satisfies it. Touches only files the plan named (or explains any
     deviation).
   - Hand-off artifact: \`diff\` (files changed + summary).

3. **TEST** (specialist: verification)
   - Receives the original request + the diff. Independently exercises
     the change: runs build, runs/writes tests, adversarial probes.
   - Hand-off artifact: \`verdict\` = PASS / FAIL / PARTIAL + evidence.
   - GATE → automatic. PASS advances to review. FAIL/PARTIAL loops back
     to IMPLEMENT with the failure detail (max 2 loops, then escalate to
     the user).

4. **REVIEW** (specialist: code-reviewer) + **HUMAN GATE**
   - Reviewer summarizes: what changed, what was verified, residual risk.
   - Then STOP and ask the user to approve via a single explicit
     question: "Approve and land? (yes / changes / abort)".
   - Do NOT proceed to Stage 5 without an explicit yes. "changes" loops
     back to IMPLEMENT with the user's notes; "abort" ends the pipeline
     leaving the work in place for manual handling.

5. **LAND** (specialist: implementer / general-purpose)
   - Only after human approval. Do the finishing steps the user asked
     for: branch, commit (only if asked), PR, release notes, etc.
   - Respect all repo git-safety rules: never push to main directly,
     never commit without explicit ask, flag secrets.
   - Close with a handoff summary: changed files, tests run, what's
     left, how to roll back.

## Entry-stage shortcuts

When the user explicitly skips ahead (most often via a Solo welcome-card
suggestion that prefilled the prompt), respect the entry stage:

- **entryStage = 'review'** — the work is already done (e.g. local
  commits ahead of upstream). Skip Stage 1-3, start at Stage 4 review +
  human gate. The reviewer reads the existing diff against the upstream
  base.
- **entryStage = 'land'** — already approved (e.g. release prep with
  notes + version aligned). Start at Stage 5 directly. No human gate
  inside the pipeline because the user's click on the suggestion IS the
  approval; if anything feels off, fall back to Stage 4.

## Rules

- One stage at a time. Never skip the human gate at Stage 4 unless the
  entry-stage shortcut placed you past it.
- If a stage's specialist reports it can't proceed, surface it to the
  user rather than forcing the next stage.
- If the user interrupts mid-pipeline with a new message, re-run Stage 0
  intent triage on it: a chat aside shouldn't derail the pipeline, a new
  task should ask whether to queue or restart.
- Keep status lines terse. The user watches the pipeline; do not narrate
  every tool call.
`

/** @internal — exposed so tests can lock the prompt's invariants. */
export const _SOLO_PIPELINE_INTERNALS = {
  SOLO_PIPELINE_ENV_VAR,
  SOLO_PIPELINE_PROMPT,
}
