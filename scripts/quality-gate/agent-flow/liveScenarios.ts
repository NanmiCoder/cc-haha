/**
 * Agent-flow scenarios for a real provider.
 *
 * The deterministic catalog in `scenarios.ts` scripts the mock CLI down to the exact
 * tool call, which is what makes it reproducible and CI-safe. A real model will not
 * follow that script, so this is a separate catalog with the same job and different
 * rules: the prompt has to *induce* the behaviour rather than dictate it, and the
 * assertion has to describe the outcome a user would notice rather than an exact
 * frame payload.
 *
 * Everything here is model-agnostic on purpose — the point is that any provider the
 * user has configured can run it, including a local one. So: no prompt relies on a
 * particular model's phrasing, no assertion compares generated text, and the only
 * things checked are protocol shape and observable side effects on disk.
 *
 * Pure module, so the catalog and its rules stay unit-testable without a provider.
 */

/**
 * What a live run can prove that the deterministic one cannot: that a real model,
 * driven through the real protocol, still lands on the same user-visible outcome.
 */
export const LIVE_FLOW_COVERAGE = [
  'first-turn',
  'tool-execute',
  'permission-allow',
  'permission-deny',
  'interrupt',
  'reconnect',
  'session-recover',
] as const

export type LiveFlowCoverage = (typeof LIVE_FLOW_COVERAGE)[number]

export type LiveAgentFlowScenario = {
  id: string
  title: string
  covers: LiveFlowCoverage[]
  /**
   * Why this one is safe to assert against any model. A scenario without a defensible
   * answer here is a flake waiting to fail on someone else's provider.
   */
  modelAgnosticBecause: string
}

export const LIVE_AGENT_FLOW_SCENARIOS: readonly LiveAgentFlowScenario[] = [
  {
    id: 'live-first-turn',
    title: 'A real model answers the first turn over the real socket',
    covers: ['first-turn'],
    modelAgnosticBecause:
      'Asserts only that assistant text streamed and the turn completed. No comparison against generated wording.',
  },
  {
    id: 'live-permission-allow',
    title: 'Approving a write permission lets the file land',
    covers: ['tool-execute', 'permission-allow'],
    modelAgnosticBecause:
      'Every coding model reaches for a write tool when told to create a file; the assertion is that the file exists afterwards, not which tool was chosen.',
  },
  {
    id: 'live-permission-deny',
    title: 'Denying a write permission keeps the file off disk and still ends the turn',
    covers: ['permission-deny'],
    modelAgnosticBecause:
      'The check is the absence of the file plus a completed turn. How the model narrates the refusal is not asserted.',
  },
  {
    id: 'live-interrupt',
    title: 'Interrupting a long answer stops the stream',
    covers: ['interrupt'],
    modelAgnosticBecause:
      'Any model produces a long enough response to a "list many items" prompt to be interrupted mid-stream; the assertion is that streaming stops, not where it stopped.',
  },
  {
    id: 'live-reconnect',
    title: 'Reconnecting mid-turn does not duplicate the reply',
    covers: ['reconnect'],
    modelAgnosticBecause:
      'Counts assistant messages before and after a reconnect. Independent of content.',
  },
  {
    id: 'live-session-recovery',
    title: 'Reloading history returns the same turns the socket delivered',
    covers: ['session-recover'],
    modelAgnosticBecause:
      'Compares the transcript against what this run itself observed, so there is no fixed expected text.',
  },
] as const

/** Coverage the live catalog deliberately does not attempt. */
export const LIVE_FLOW_EXCLUSIONS: Readonly<Record<string, string>> = {
  'api-error':
    'Inducing a provider error means breaking the credentials or the base URL, which would prove the harness misconfigured itself rather than that the app handles an upstream failure. The deterministic lane covers it with the mock CLI.',
  'tool-error':
    'Depends on a model choosing a tool that then fails. Reachable, but not reliably enough across providers to belong in a gate.',
  'runtime-select':
    'Exercised implicitly: the run pins the provider under test with set_runtime_config before the first prompt, and a wrong pin shows up as the whole run failing.',
}
