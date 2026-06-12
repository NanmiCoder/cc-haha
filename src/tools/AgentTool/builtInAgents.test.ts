import { afterEach, describe, expect, test } from 'bun:test'
import {
  setIsInteractive,
} from '../../bootstrap/state.js'
import {
  areExplorePlanAgentsEnabled,
  getBuiltInAgents,
} from './builtInAgents.js'
import { PLAN_CRITIC_AGENT } from './built-in/planCriticAgent.js'

const originalDisableBuiltIns =
  process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS
const originalEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT

afterEach(() => {
  if (originalDisableBuiltIns === undefined) {
    delete process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS
  } else {
    process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS =
      originalDisableBuiltIns
  }

  if (originalEntrypoint === undefined) {
    delete process.env.CLAUDE_CODE_ENTRYPOINT
  } else {
    process.env.CLAUDE_CODE_ENTRYPOINT = originalEntrypoint
  }

  setIsInteractive(false)
})

describe('built-in agents', () => {
  test('enables public built-in agents in external builds', () => {
    setIsInteractive(true)

    expect(areExplorePlanAgentsEnabled()).toBe(true)

    const agentTypes = getBuiltInAgents().map(agent => agent.agentType)

    expect(agentTypes).toContain('Explore')
    expect(agentTypes).toContain('Plan')
    expect(agentTypes).toContain('verification')
    expect(agentTypes).toContain('test-author')
    expect(agentTypes).toContain('code-reviewer')
    expect(agentTypes).toContain('debugger')
    expect(agentTypes).toContain('security-reviewer')
    expect(agentTypes).toContain('refactor')
    expect(agentTypes).toContain('migration')
    expect(agentTypes).toContain('docs-writer')
    expect(agentTypes).toContain('performance')
    expect(agentTypes).toContain('commit-pr')
    expect(agentTypes).toContain('plan-critic')
    // game-developer is a project-level agent (.claude/agents), not a built-in.
    expect(agentTypes).not.toContain('game-developer')
  })

  test('always includes the new specialized agents regardless of Explore/Plan gating', () => {
    setIsInteractive(true)

    const agentTypes = getBuiltInAgents().map(agent => agent.agentType)

    // These live in the base array, so they ship even when other optional
    // built-ins are toggled off.
    expect(agentTypes).toContain('test-author')
    expect(agentTypes).toContain('code-reviewer')
    expect(agentTypes).toContain('debugger')
    expect(agentTypes).toContain('security-reviewer')
    expect(agentTypes).toContain('refactor')
    expect(agentTypes).toContain('migration')
    expect(agentTypes).toContain('docs-writer')
    expect(agentTypes).toContain('performance')
    expect(agentTypes).toContain('commit-pr')
    expect(agentTypes).toContain('plan-critic')
  })

  test('plan-critic is read-only and returns a parseable verdict', () => {
    expect(PLAN_CRITIC_AGENT.agentType).toBe('plan-critic')
    expect(PLAN_CRITIC_AGENT.disallowedTools).toEqual(expect.arrayContaining([
      'Agent',
      'ExitPlanMode',
      'Edit',
      'Write',
      'NotebookEdit',
    ]))

    const prompt = PLAN_CRITIC_AGENT.getSystemPrompt({} as never)
    expect(prompt).toContain('READ-ONLY plan critique task')
    expect(prompt).toContain('PLAN_REVIEW: APPROVE')
    expect(prompt).toContain('PLAN_REVIEW: CHANGES_NEEDED')
    expect(prompt).toContain('smaller or safer path')
    expect(PLAN_CRITIC_AGENT.criticalSystemReminder_EXPERIMENTAL).toContain('PLAN_REVIEW: APPROVE')
  })

  test('preserves SDK opt-out in noninteractive sessions', () => {
    setIsInteractive(false)
    process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS = 'true'

    expect(getBuiltInAgents()).toEqual([])
  })
})
