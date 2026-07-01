import { registerBundledSkill } from '../bundledSkills.js'

const DEFINE_GOAL_PROMPT = `# /define-goal — turn a vague request into a measurable goal

Help the user convert a fuzzy intention into a goal that you (or another agent) can pursue and verify. The goal you produce will guide the rest of the session.

## When to use

The user said something like "use the goal tool", "create a goal", "set an objective", "clarify success criteria", or asked you to plan work whose definition of done is not yet clear. If the request is already crisp ("rename foo to bar in src/"), skip this skill — just do it.

## Out of scope

This skill only produces or refines a goal. It does not execute the goal, write durable decision logs, or generate long-running execution plans. Once the goal is clear, hand off to the appropriate tool (Plan, sub-agents, or just start coding).

## A usable goal names five things

1. **Outcome** — what will be true when this is done
2. **Artifact / system** — the file, function, service, or behavior the change targets
3. **Verification method** — the concrete check that proves the outcome (test command, metric, manual repro, etc.)
4. **Scope boundary** — what is *not* part of this goal
5. **Stop condition for asking** — when do you stop asking the user clarifying questions and just attempt it

If any of the five is missing or hand-wavy, the goal is too weak.

## Quality bar

Prefer **quantitative** measures when they exist:
- Pass/fail validators (a specific test, lint rule, or script that returns 0)
- Numeric thresholds (latency, error rate, coverage, bundle size)
- Artifact constraints (file exists, contains pattern, schema valid)
- Evidence count (verified across N runs / N inputs)

Reject pure activity goals like "make progress on X" or "improve the code" unless the user sharpens them.

## Strong vs weak goals

| Weak | Strong |
|------|--------|
| Make checkout faster | Reduce p95 /api/checkout latency to ≤ 250 ms verified across 3 consecutive 1-minute load tests at 50 RPS |
| Fix the flaky test | \`bun test src/foo.test.ts\` passes 20 consecutive runs on this branch |
| Improve memory | Memory profile of the long-running worker stays under 500 MB RSS for 10 minutes of synthetic load |

## Heuristics by category

- **Bug fixes**: must include a reproduction step and a failing-then-passing validator
- **Performance**: metric + threshold + measurement method + run count
- **Research / spike**: name the *decision* the research will enable; the artifact is usually a written summary or a benchmark, not running code
- **Operations / infra**: define healthy state and the rollback trigger

## What to do

1. Restate the user's request in your own words. If you got it wrong they will correct you and that's fine.
2. Walk through the five fields above. For each one that is missing, decide: can you reasonably infer it from context, or is the next move a single clarifying question?
3. Ask **one** focused question at a time, only when inference is not safe. Examples:
   - "Which metric defines success — p95 latency, error rate, or both?"
   - "Should this also handle the legacy /v1 endpoint, or only /v2?"
   - "Is verification a passing test you'll write, or a manual repro I should reproduce after the fix?"
4. Once the five fields are filled, write the final goal in this shape:
   \`\`\`
   Goal: <one-line outcome>
   Target: <files/system in scope>
   Verification: <command or check>
   Out of scope: <what we are not doing>
   Stop condition: <when to stop asking>
   \`\`\`
5. Confirm with the user. If they approve, proceed to execute (or hand off to Plan / sub-agents). If they don't, revise and confirm again — do **not** start implementation against a goal the user hasn't endorsed.

If the user pushes back on the level of rigor ("just do it"), drop the formality but still privately note Outcome and Verification before starting work — those two are non-negotiable.
`

export function registerDefineGoalSkill(): void {
  registerBundledSkill({
    name: 'define-goal',
    description:
      'Turn a vague request into a measurable goal with outcome, target, verification, scope, and stop condition.',
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = DEFINE_GOAL_PROMPT
      if (args) {
        prompt += `\n\n## User-provided context\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
