/**
 * Deterministic agent-flow scenario catalog.
 *
 * `check:chat-contract` runs five unit files with per-layer fakes, so the part of a
 * turn that actually touches a user's machine — `tool_use → can_use_tool →
 * permission_request → permission_response → tool_result` — had no coverage that
 * crosses the real WebSocket. These scenarios drive the real server over the real
 * protocol with the existing mock SDK CLI, so every contributor can run them with no
 * provider, no credentials, and no network.
 *
 * This module stays pure so the catalog and its assertions are unit-testable; the
 * runner lives in `execute.ts`.
 */

/** The real user-facing steps a desktop chat session goes through. */
export const AGENT_FLOW_COVERAGE = [
  'session-create',
  'runtime-select',
  'first-turn',
  'tool-execute',
  'permission-allow',
  'permission-deny',
  'tool-error',
  'api-error',
  'interrupt',
  'reconnect',
  'session-recover',
] as const

export type AgentFlowCoverage = (typeof AGENT_FLOW_COVERAGE)[number]

export type MockToolStep = {
  tool: string
  input: Record<string, unknown>
  write?: { path: string; content: string }
  failWith?: string
  reply?: string
}

export type AgentFlowScenario = {
  id: string
  title: string
  covers: AgentFlowCoverage[]
}

export const AGENT_FLOW_SCENARIOS: AgentFlowScenario[] = [
  {
    id: 'session-and-first-turn',
    title: 'Create a session, pin a runtime, and stream a first turn',
    covers: ['session-create', 'runtime-select', 'first-turn'],
  },
  {
    id: 'tool-permission-allow',
    title: 'Approve a tool permission request and observe the edit land',
    covers: ['tool-execute', 'permission-allow'],
  },
  {
    id: 'tool-permission-deny',
    title: 'Reject a tool permission request and observe the file stay untouched',
    covers: ['permission-deny'],
  },
  {
    id: 'tool-failure',
    title: 'Surface an approved tool that fails as an error tool_result',
    covers: ['tool-error'],
  },
  {
    id: 'api-error',
    title: 'Surface a provider API error to the client without killing the session',
    covers: ['api-error'],
  },
  {
    id: 'interrupt',
    title: 'Stop generation mid-turn and return the session to idle',
    covers: ['interrupt'],
  },
  {
    id: 'reconnect-permission-replay',
    title: 'Reconnect while a permission request is pending and receive the replay',
    covers: ['reconnect'],
  },
  {
    id: 'session-recovery',
    title: 'Recover a session after the client disconnects and keep transcripts in the sandbox',
    covers: ['session-recover'],
  },
]

const MOCK_TOOL_PREFIX = 'MOCK_TOOL '

/**
 * Build the prompt that makes `src/server/__tests__/fixtures/mock-sdk-cli.ts` run a
 * tool step instead of echoing text.
 */
export function buildMockToolPrompt(step: MockToolStep): string {
  if (!step.tool.trim()) {
    throw new Error('mock tool step requires a tool name')
  }
  return `${MOCK_TOOL_PREFIX}${JSON.stringify(step)}`
}

export type ProtocolMessage = { type: string; [key: string]: unknown }

/**
 * Assert that `types` appear in `messages` in the given order, allowing unrelated
 * messages in between. Ordering is the contract that matters: a client that renders
 * `tool_result` before `permission_request` is broken even if both arrived.
 */
export function findOrderedTypes(
  messages: readonly ProtocolMessage[],
  types: readonly string[],
): { ok: true } | { ok: false; missing: string; seen: string[] } {
  let cursor = 0
  for (const type of types) {
    const index = messages.findIndex((message, position) => position >= cursor && message.type === type)
    if (index === -1) {
      return { ok: false, missing: type, seen: messages.map((message) => message.type) }
    }
    cursor = index + 1
  }
  return { ok: true }
}

export function firstOfType<T extends ProtocolMessage = ProtocolMessage>(
  messages: readonly ProtocolMessage[],
  type: string,
): T | undefined {
  return messages.find((message) => message.type === type) as T | undefined
}

export function coveredSteps(scenarios: readonly AgentFlowScenario[]): AgentFlowCoverage[] {
  const covered = new Set<AgentFlowCoverage>()
  for (const scenario of scenarios) {
    for (const step of scenario.covers) covered.add(step)
  }
  return AGENT_FLOW_COVERAGE.filter((step) => covered.has(step))
}

export function uncoveredSteps(scenarios: readonly AgentFlowScenario[]): AgentFlowCoverage[] {
  const covered = new Set(coveredSteps(scenarios))
  return AGENT_FLOW_COVERAGE.filter((step) => !covered.has(step))
}

export function selectScenarios(ids: readonly string[]): AgentFlowScenario[] {
  if (ids.length === 0) return AGENT_FLOW_SCENARIOS
  const known = new Map(AGENT_FLOW_SCENARIOS.map((scenario) => [scenario.id, scenario]))
  return ids.map((id) => {
    const scenario = known.get(id)
    if (!scenario) {
      throw new Error(`Unknown agent-flow scenario "${id}". Known: ${[...known.keys()].join(', ')}`)
    }
    return scenario
  })
}
