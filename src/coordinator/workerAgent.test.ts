import { describe, expect, test } from 'bun:test'
import { getCoordinatorAgents, WORKER_AGENT } from './workerAgent.js'

describe('coordinator agent registry', () => {
  test('returns a non-empty list with the worker first', () => {
    const agents = getCoordinatorAgents()
    expect(agents.length).toBeGreaterThan(0)
    expect(agents[0]?.agentType).toBe('worker')
  })

  test('includes the expected specialists', () => {
    const types = new Set(getCoordinatorAgents().map(a => a.agentType))
    const required = [
      'worker',
      'code-reviewer',
      'security-reviewer',
      'debugger',
      'refactor',
      'migration',
      'performance',
      'docs-writer',
      'test-author',
      'commit-pr',
      'Explore',
      'Plan',
      'plan-critic',
      'verification',
    ]
    for (const expected of required) {
      expect(types.has(expected)).toBe(true)
    }
  })

  test('excludes non-orchestrator agents', () => {
    // general-purpose is replaced by worker; the docs-guide and statusline
    // helpers don't fit a coordinator workflow.
    const types = new Set(getCoordinatorAgents().map(a => a.agentType))
    expect(types.has('general-purpose')).toBe(false)
    expect(types.has('claude-code-guide')).toBe(false)
    expect(types.has('statusline-setup')).toBe(false)
  })

  test('every agent has agentType, source, and a way to render a system prompt', () => {
    for (const agent of getCoordinatorAgents()) {
      expect(typeof agent.agentType).toBe('string')
      expect(agent.agentType.length).toBeGreaterThan(0)
      expect(agent.source).toBe('built-in')
      // BuiltInAgentDefinition has getSystemPrompt; CustomAgentDefinition
      // has its own. All coordinator-mode agents are built-in.
      expect(typeof (agent as { getSystemPrompt?: unknown }).getSystemPrompt).toBe(
        'function',
      )
    }
  })

  test('agentType values are unique', () => {
    const list = getCoordinatorAgents().map(a => a.agentType)
    expect(new Set(list).size).toBe(list.length)
  })

  test('WORKER_AGENT has wildcard tool access', () => {
    expect(WORKER_AGENT.tools).toEqual(['*'])
  })

  test('WORKER_AGENT system prompt acknowledges its coordinator-mode role', () => {
    const prompt = WORKER_AGENT.getSystemPrompt({} as never) as string
    expect(prompt.toLowerCase()).toContain('coordinator')
    expect(prompt.toLowerCase()).toContain('worker')
  })
})
