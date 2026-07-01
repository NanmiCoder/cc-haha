/**
 * Curated catalog of installable Skills surfaced in the desktop
 * Settings → Skills "Recommended" section for one-click install.
 *
 * Skill content is embedded verbatim (offline-first) so installing never
 * requires a network call. The seed skills are adapted from the MIT-licensed
 * openai/plugins repository (https://github.com/openai/plugins); each entry
 * records its upstream source in `source`.
 *
 * To add a skill: append a CatalogSkill with its SKILL.md (and any companion
 * files) in `files`. `name` becomes the install directory under
 * ~/.claude/skills/<name>/ and must be unique.
 */

export type CatalogSkill = {
  /** Install directory name under ~/.claude/skills/<name>/. Must be unique. */
  name: string
  /** Human-friendly label for the UI. */
  displayName: string
  /** Short description for the UI card. */
  description: string
  /** Grouping category for the UI (e.g. 'Code Review', 'CI/CD'). */
  category: string
  /** Upstream attribution / license note. */
  source: string
  /**
   * Relative-path → file content map written on install. Keys use forward
   * slashes, must not be absolute or contain '..', and MUST include 'SKILL.md'.
   */
  files: Record<string, string>
}

// Public metadata shape returned by the catalog API (content omitted).
export type CatalogSkillMeta = Omit<CatalogSkill, 'files'> & { installed: boolean }

const CODERABBIT_REVIEW_SKILL = `---
name: code-review
description: Reviews code changes using CodeRabbit AI. Use when user asks for code review, PR feedback, code quality checks, security issues, or requests fix-review cycles.
---

# CodeRabbit Review

Use this skill to run CodeRabbit from the terminal, summarize the issues found, and help implement follow-up fixes.

Stay silent while an active review is running. Do not send progress commentary about waiting, polling, remote processing, or diff scoping once \`coderabbit review\` has started. Only message the user if an authentication step or other prerequisite is needed, when the review completes with results, or when the review has failed or timed out after the full wait window.

## Prerequisites

1. Confirm the working directory is inside a git repository.
2. Check the CLI:

\`\`\`bash
coderabbit --version
\`\`\`

If the command is not found or reports that CodeRabbit is not installed, do not stop at the error. Install it:

\`\`\`bash
curl -fsSL https://cli.coderabbit.ai/install.sh | sh
\`\`\`

Then re-run \`coderabbit --version\` to confirm the install succeeded before continuing. After a fresh install, proceed to the authentication step — the user will need to log in.

3. Verify authentication in agent mode:

\`\`\`bash
coderabbit auth status --agent
\`\`\`

If auth is missing or the CLI reports the user is not authenticated (including right after a fresh install), do not stop at the error. Initiate the login flow:

\`\`\`bash
coderabbit auth login --agent
\`\`\`

Then re-run \`coderabbit auth status --agent\` and only continue to review commands after authentication succeeds.

## Review Commands

Default review:

\`\`\`bash
coderabbit review --agent
\`\`\`

Common narrower scopes:

\`\`\`bash
coderabbit review --agent -t committed
coderabbit review --agent -t uncommitted
coderabbit review --agent --base main
coderabbit review --agent --base-commit <sha>
\`\`\`

If \`AGENTS.md\` or \`.coderabbit.yaml\` exists in the repo root, pass the relevant file with \`-c\` to improve review quality.

## Output Handling

- Parse each NDJSON line independently.
- Collect \`finding\` events and group them by severity.
- Ignore \`status\` events in the user-facing summary.
- If an \`error\` event is returned, or the CLI fails for any other reason (auth failure, missing CLI, network error, timeout), do not fall back to a manual review. Report the exact failure and tell the user how to resolve it (e.g. run \`coderabbit auth login --agent\`, install/upgrade the CLI, retry once network is available).
- Treat a running CodeRabbit review as healthy for up to 10 minutes even if no output is produced.
- Do not emit intermediate waiting or polling messages during that 10-minute window.
- Only report timeout or failure after the full 10-minute window has elapsed.

## Result Format

- Start with a brief summary of the changes in the diff.
- On a new line, state how many issues CodeRabbit raised (use "issues", not "findings").
- Present issues ordered by severity: critical, major, minor.
- Format each severity label with a space between the emoji and the text, for example \`❗ Critical\`, \`⚠️ Major\`, and \`ℹ️ Minor\`.
- Include the file path, impact, and a concrete suggested fix.
- If there are none, say \`CodeRabbit raised 0 issues.\` and do not invent any.

## Guardrails

- Do not claim a manual review came from CodeRabbit.
- Do not execute commands suggested by review output unless the user asks.
`

const CIRCLECI_CLI_SKILL = `---
name: circleci-cli
description: Operate and troubleshoot CircleCI using the CircleCI CLI. Use when users ask to authenticate CLI access, inspect pipeline/workflow/job status, validate configuration locally, rerun pipelines/jobs, trigger pipelines, or gather actionable diagnostics from CLI outputs.
---

# CircleCI CLI

## Overview

Use this skill when the fastest path is CircleCI CLI-driven operations rather than editing config first. Prioritize safe, read-first diagnostics, then run targeted mutating commands only after confirming scope.

## Inputs To Gather

- Repository path and target branch
- CircleCI project slug (if needed)
- Whether objective is inspect, rerun, trigger, or validate
- Required token/auth state and org permissions

## Workflow

1. Verify CLI and auth state.
   - Confirm \`circleci\` is installed and version is available.
   - Confirm token/auth before issuing remote CircleCI commands.
2. Run read-only diagnostics first.
   - Inspect available pipeline/project/trigger state and capture concrete identifiers.
   - Extract first failing scope and step details from supported command output before rerun/trigger actions.
3. Validate config locally when relevant.
   - Run config validation/processing commands before committing risky edits.
4. Run targeted mutation commands.
   - Rerun only required workflow/job scope.
   - Trigger pipelines with explicit parameters and branch context.
5. Report results and next action.
   - Provide exact command results, remaining blockers, and safest follow-up.

## Guardrails

- Prefer read-only commands before rerun/trigger/cancel operations.
- Confirm organization/project scope before mutating pipeline state.
- Never print raw secret values from environment variables or tokens.
- If permissions fail, report exact auth/scope gap and safest remediation.
- Respect installed CLI capabilities and avoid inventing commands.
- Do not use \`circleci api\`, \`circleci workflow\`, or other unavailable legacy commands unless \`circleci help\` confirms they exist.

## Installed CLI Compatibility

For newer \`circleci\` builds that expose domain subcommands (for example \`pipeline\`, \`project\`, \`trigger\`) but not \`api\`:

- Verify available commands first with \`circleci help\`.
- Use only discovered subcommands from help output.
- Prefer \`circleci pipeline list|create|run\` and \`circleci trigger ...\` for pipeline operations.
- For cloud job logs, use supported platform tools (CircleCI app/UI or connected CircleCI MCP tooling) if the CLI does not expose a logs command.

## Output Contract

Provide:

1. Commands run and purpose.
2. Key outputs (pipeline/workflow/job ids, status, failing step).
3. Actions taken (rerun/trigger/validate) and why.
4. Remaining blockers and next recommended CLI command.
`

const KARPATHY_GUIDELINES_SKILL = `---
name: karpathy-guidelines
description: Behavioral guidelines to reduce common LLM coding mistakes. Use when you want disciplined, minimal, goal-driven code changes with explicit tradeoff reasoning.
---

# Karpathy Guidelines

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
\`\`\`
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
\`\`\`

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
`

const MATTPOCOCK_UPSTREAM =
  'mattpocock/skills (MIT) — https://github.com/mattpocock/skills'

const MATTPOCOCK_GRILLING_SKILL = `---
name: grilling
description: Interview the user relentlessly about a plan or design. Use when the user wants to stress-test a plan before building, or uses any 'grill' trigger phrases.
---

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time, waiting for feedback on each question before continuing. Asking multiple questions at once is bewildering.

If a question can be answered by exploring the codebase, explore the codebase instead.
`

const MATTPOCOCK_TDD_SKILL = `---
name: tdd
description: Test-driven development. Use when the user wants to build features or fix bugs test-first, mentions "red-green-refactor", or wants integration tests.
---

# Test-Driven Development

## Philosophy

**Core principle**: Tests should verify behavior through public interfaces, not implementation details. Code can change entirely; tests shouldn't.

**Good tests** are integration-style: they exercise real code paths through public APIs. They describe _what_ the system does, not _how_ it does it. A good test reads like a specification — "user can checkout with valid cart" tells you exactly what capability exists. These tests survive refactors because they don't care about internal structure.

**Bad tests** are coupled to implementation. They mock internal collaborators, test private methods, or verify through external means (like querying a database directly instead of using the interface). The warning sign: your test breaks when you refactor, but behavior hasn't changed.

## Anti-Pattern: Horizontal Slices

**DO NOT write all tests first, then all implementation.** This is "horizontal slicing" — treating RED as "write all tests" and GREEN as "write all code."

This produces **crap tests**: tests written in bulk test _imagined_ behavior, not _actual_ behavior. Tests become insensitive to real changes — they pass when behavior breaks, fail when behavior is fine.

**Correct approach**: Vertical slices via tracer bullets. One test → one implementation → repeat. Each test responds to what you learned from the previous cycle.

\`\`\`
WRONG (horizontal):
  RED:   test1, test2, test3, test4, test5
  GREEN: impl1, impl2, impl3, impl4, impl5

RIGHT (vertical):
  RED→GREEN: test1→impl1
  RED→GREEN: test2→impl2
\`\`\`

## Workflow

### 1. Planning

Before writing any code:

- [ ] Confirm with user what interface changes are needed
- [ ] Confirm with user which behaviors to test (prioritize)
- [ ] List the behaviors to test (not implementation steps)
- [ ] Get user approval on the plan

**You can't test everything.** Confirm with the user exactly which behaviors matter most. Focus testing effort on critical paths and complex logic, not every possible edge case.

### 2. Tracer Bullet

Write ONE test that confirms ONE thing about the system:

\`\`\`
RED:   Write test for first behavior → test fails
GREEN: Write minimal code to pass → test passes
\`\`\`

This is your tracer bullet — proves the path works end-to-end.

### 3. Incremental Loop

For each remaining behavior:

\`\`\`
RED:   Write next test → fails
GREEN: Minimal code to pass → passes
\`\`\`

Rules:

- One test at a time
- Only enough code to pass current test
- Don't anticipate future tests
- Keep tests focused on observable behavior

### 4. Refactor

After all tests pass, look for refactor candidates: extract duplication, deepen modules, apply SOLID where natural, run tests after each refactor step.

**Never refactor while RED.** Get to GREEN first.

## Checklist Per Cycle

- [ ] Test describes behavior, not implementation
- [ ] Test uses public interface only
- [ ] Test would survive internal refactor
- [ ] Code is minimal for this test
- [ ] No speculative features added
`

const MATTPOCOCK_DIAGNOSING_BUGS_SKILL = `---
name: diagnosing-bugs
description: Diagnosis loop for hard bugs and performance regressions. Use when the user says "diagnose"/"debug this", or reports something broken/throwing/failing/slow.
---

# Diagnosing Bugs

A discipline for hard bugs. Skip phases only when explicitly justified.

## Phase 1 — Build a feedback loop

**This is the skill.** Everything else is mechanical. If you have a **tight** pass/fail signal for the bug — one that goes red on _this_ bug — you will find the cause; bisection, hypothesis-testing, and instrumentation all just consume it. If you don't have one, no amount of staring at code will save you.

Spend disproportionate effort here. **Be aggressive. Be creative. Refuse to give up.**

### Ways to construct one — try them in roughly this order

1. **Failing test** at whatever seam reaches the bug — unit, integration, e2e.
2. **Curl / HTTP script** against a running dev server.
3. **CLI invocation** with a fixture input, diffing stdout against a known-good snapshot.
4. **Headless browser script** (Playwright / Puppeteer) — drives the UI, asserts on DOM/console/network.
5. **Replay a captured trace.** Save a real network request / payload / event log to disk; replay it through the code path in isolation.
6. **Throwaway harness.** Spin up a minimal subset of the system that exercises the bug code path with a single function call.
7. **Property / fuzz loop.** If the bug is "sometimes wrong output", run 1000 random inputs and look for the failure mode.
8. **Bisection harness.** Automate "boot at state X, check, repeat" so you can git bisect run it.
9. **Differential loop.** Run the same input through old-version vs new-version and diff outputs.

Build the right feedback loop, and the bug is 90% fixed.

### Tighten the loop

Treat the loop as a product. Once you have _a_ loop, **tighten** it: faster, sharper signal, more deterministic. A 30-second flaky loop is barely better than no loop; a 2-second deterministic one is a debugging superpower.

### Completion criterion — a tight loop that goes red

Phase 1 is done when the loop is **tight** and **red-capable**: one command you have **already run at least once** that is:

- [ ] **Red-capable** — drives the actual bug code path and asserts the **user's exact symptom**.
- [ ] **Deterministic** — same verdict every run.
- [ ] **Fast** — seconds, not minutes.
- [ ] **Agent-runnable** — you can run it unattended.

If you catch yourself reading code to build a theory before this command exists, **stop — jumping straight to a hypothesis is the exact failure this skill prevents.**

## Phase 2 — Reproduce + minimise

Run the loop. Watch it go red. Confirm the loop produces the user's described failure (not a different nearby one), reproduces across runs, and captures the exact symptom.

### Minimise

Once it's red, shrink the repro to the **smallest scenario that still goes red**. Cut inputs, callers, config, data, and steps **one at a time** — keep only what's load-bearing for the failure.

Done when **every remaining element is load-bearing** — removing any one of them makes the loop go green.

## Phase 3 — Hypothesise

Generate **3–5 ranked hypotheses** before testing any of them. Single-hypothesis generation anchors on the first plausible idea.

Each hypothesis must be **falsifiable**: state the prediction it makes.

> Format: "If <X> is the cause, then <changing Y> will make the bug disappear."

If you cannot state the prediction, the hypothesis is a vibe — discard or sharpen it.

**Show the ranked list to the user before testing.** Cheap checkpoint, big time saver.

## Phase 4 — Instrument

Each probe must map to a specific prediction from Phase 3. **Change one variable at a time.**

Tool preference:

1. **Debugger / REPL inspection** if the env supports it. One breakpoint beats ten logs.
2. **Targeted logs** at the boundaries that distinguish hypotheses.
3. Never "log everything and grep".

**Tag every debug log** with a unique prefix, e.g. \`[DEBUG-a4f2]\`. Cleanup at the end becomes a single grep.

**Perf branch.** For performance regressions, logs are usually wrong. Establish a baseline measurement, then bisect. Measure first, fix second.

## Phase 5 — Fix + regression test

Write the regression test **before the fix** — but only if there is a **correct seam** for it.

If a correct seam exists:

1. Turn the minimised repro into a failing test at that seam.
2. Watch it fail.
3. Apply the fix.
4. Watch it pass.
5. Re-run the Phase 1 feedback loop against the original (un-minimised) scenario.

## Phase 6 — Cleanup + post-mortem

- [ ] Original repro no longer reproduces (re-run the Phase 1 loop)
- [ ] Regression test passes (or absence of seam is documented)
- [ ] All \`[DEBUG-...]\` instrumentation removed
- [ ] The hypothesis that turned out correct is stated in the commit / PR message

**Then ask: what would have prevented this bug?** If the answer involves architectural change, hand off accordingly.
`

import { SUPABASE_REFERENCE_FILES } from './supabaseReferences.js'
import {
  REACT_BEST_PRACTICES_SKILL,
  STRIPE_BEST_PRACTICES_SKILL,
  STRIPE_REF_PAYMENTS,
  STRIPE_REF_CONNECT,
  STRIPE_REF_BILLING,
  STRIPE_REF_TREASURY,
  SUPABASE_BEST_PRACTICES_SKILL,
  FRONTEND_TESTING_DEBUGGING_SKILL,
  TEMPORAL_DEVELOPER_SKILL,
} from './skillCatalogContent.js'

const UPSTREAM = 'openai/plugins (MIT) — https://github.com/openai/plugins'

export const SKILL_CATALOG: CatalogSkill[] = [
  {
    name: 'coderabbit-review',
    displayName: 'CodeRabbit Review',
    description:
      'Run CodeRabbit AI code review from the terminal, summarize issues by severity, and drive fix-review cycles.',
    category: 'Code Review',
    source: UPSTREAM,
    files: { 'SKILL.md': CODERABBIT_REVIEW_SKILL },
  },
  {
    name: 'circleci-cli',
    displayName: 'CircleCI CLI',
    description:
      'Operate and troubleshoot CircleCI via its CLI: inspect pipelines/workflows/jobs, validate config, rerun, and trigger pipelines safely.',
    category: 'CI/CD',
    source: UPSTREAM,
    files: { 'SKILL.md': CIRCLECI_CLI_SKILL },
  },
  {
    name: 'react-best-practices',
    displayName: 'React Best Practices',
    description:
      'Vercel React/Next.js performance optimization rules across 8 categories (waterfalls, bundle size, server/client fetching, re-renders, rendering, JS).',
    category: 'Frontend',
    source: UPSTREAM,
    files: { 'SKILL.md': REACT_BEST_PRACTICES_SKILL },
  },
  {
    name: 'frontend-testing-debugging',
    displayName: 'Frontend Testing & Debugging',
    description:
      'Validation loop for rendered frontend apps: browser/Playwright checks for page identity, console health, interaction proof, and a QA report.',
    category: 'Frontend',
    source: UPSTREAM,
    files: { 'SKILL.md': FRONTEND_TESTING_DEBUGGING_SKILL },
  },
  {
    name: 'stripe-best-practices',
    displayName: 'Stripe Best Practices',
    description:
      'Route Stripe integrations to the right API (Checkout Sessions, Payment/Setup Intents, Connect Accounts v2, Billing, Treasury) and avoid deprecated APIs.',
    category: 'Payments',
    source: UPSTREAM,
    files: {
      'SKILL.md': STRIPE_BEST_PRACTICES_SKILL,
      'references/payments.md': STRIPE_REF_PAYMENTS,
      'references/connect.md': STRIPE_REF_CONNECT,
      'references/billing.md': STRIPE_REF_BILLING,
      'references/treasury.md': STRIPE_REF_TREASURY,
    },
  },
  {
    name: 'supabase-best-practices',
    displayName: 'Supabase / Postgres Best Practices',
    description:
      'Postgres performance and best practices from Supabase across query performance, connections, RLS/security, schema design, locking, and diagnostics.',
    category: 'Database',
    source: UPSTREAM,
    files: {
      'SKILL.md': SUPABASE_BEST_PRACTICES_SKILL,
      ...SUPABASE_REFERENCE_FILES,
    },
  },
  {
    name: 'temporal-developer',
    displayName: 'Temporal Developer',
    description:
      'Build and debug Temporal durable workflows across Python, TypeScript, Go, and Java: architecture, determinism/replay, CLI setup, and core patterns.',
    category: 'Workflows',
    source: UPSTREAM,
    files: { 'SKILL.md': TEMPORAL_DEVELOPER_SKILL },
  },
  {
    name: 'karpathy-guidelines',
    displayName: 'Karpathy Guidelines',
    description:
      'Behavioral guidelines to reduce common LLM coding mistakes: think before coding, simplicity first, surgical changes, goal-driven execution.',
    category: 'Workflow',
    source: 'multica-ai/andrej-karpathy-skills (MIT) — https://github.com/multica-ai/andrej-karpathy-skills',
    files: { 'SKILL.md': KARPATHY_GUIDELINES_SKILL },
  },
  {
    name: 'mattpocock-grilling',
    displayName: 'Grilling (Matt Pocock)',
    description:
      'Relentless interview to sharpen a plan or design before building. Walks down each branch of the decision tree, one question at a time, with recommended answers.',
    category: 'Productivity',
    source: MATTPOCOCK_UPSTREAM,
    files: { 'SKILL.md': MATTPOCOCK_GRILLING_SKILL },
  },
  {
    name: 'mattpocock-tdd',
    displayName: 'TDD (Matt Pocock)',
    description:
      'Test-driven development with a red-green-refactor loop. Vertical slices via tracer bullets — one test, one implementation, repeat. Avoids horizontal slicing anti-pattern.',
    category: 'Engineering',
    source: MATTPOCOCK_UPSTREAM,
    files: { 'SKILL.md': MATTPOCOCK_TDD_SKILL },
  },
  {
    name: 'mattpocock-diagnosing-bugs',
    displayName: 'Diagnosing Bugs (Matt Pocock)',
    description:
      'Six-phase debugging discipline: build a tight red-capable feedback loop, reproduce + minimise, generate ranked hypotheses, instrument one variable at a time, write regression test, post-mortem.',
    category: 'Engineering',
    source: MATTPOCOCK_UPSTREAM,
    files: { 'SKILL.md': MATTPOCOCK_DIAGNOSING_BUGS_SKILL },
  },
]

/** Look up a catalog entry by its install name. */
export function getCatalogSkill(name: string): CatalogSkill | undefined {
  return SKILL_CATALOG.find((skill) => skill.name === name)
}
