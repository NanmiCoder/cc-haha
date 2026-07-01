import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  buildChildMessage,
  COORDINATOR_RESEARCH_FORK_SUBAGENT_TYPE,
  isCoordinatorResearchForkEnabled,
  isInForkChild,
} from './forkSubagent.js'

// These tests deliberately avoid touching `feature('FORK_SUBAGENT')` — that
// flag is decided at bundle time by the build pipeline, not at runtime.
// We focus on:
//   1. The runtime env-flag behaviour (CLAUDE_CODE_COORDINATOR_RESEARCH_FORK)
//   2. The boilerplate copy variants (normal vs coordinator-research)
//   3. The recursive-fork guard (must keep firing across both variants)
// Live coverage of the bundle-time gate happens via the e2e smoke and the
// feature-flag-aware integration tests.

describe('isCoordinatorResearchForkEnabled', () => {
  let originalCoord: string | undefined
  let originalFlag: string | undefined

  beforeEach(() => {
    originalCoord = process.env.CLAUDE_CODE_COORDINATOR_MODE
    originalFlag = process.env.CLAUDE_CODE_COORDINATOR_RESEARCH_FORK
  })

  afterEach(() => {
    if (originalCoord === undefined) delete process.env.CLAUDE_CODE_COORDINATOR_MODE
    else process.env.CLAUDE_CODE_COORDINATOR_MODE = originalCoord
    if (originalFlag === undefined) delete process.env.CLAUDE_CODE_COORDINATOR_RESEARCH_FORK
    else process.env.CLAUDE_CODE_COORDINATOR_RESEARCH_FORK = originalFlag
  })

  test('off when not in coordinator mode', () => {
    delete process.env.CLAUDE_CODE_COORDINATOR_MODE
    process.env.CLAUDE_CODE_COORDINATOR_RESEARCH_FORK = '1'
    expect(isCoordinatorResearchForkEnabled()).toBe(false)
  })

  test('off when in coordinator mode but flag missing', () => {
    process.env.CLAUDE_CODE_COORDINATOR_MODE = '1'
    delete process.env.CLAUDE_CODE_COORDINATOR_RESEARCH_FORK
    // The result depends on whether `feature('FORK_SUBAGENT')` is on at
    // bundle time. If it is, this still returns false because the env
    // flag is missing. If it isn't, this also returns false. Either way
    // the missing-flag case is observable as `false`.
    expect(isCoordinatorResearchForkEnabled()).toBe(false)
  })

  test('off when flag is not exactly "1"', () => {
    process.env.CLAUDE_CODE_COORDINATOR_MODE = '1'
    process.env.CLAUDE_CODE_COORDINATOR_RESEARCH_FORK = 'true'
    expect(isCoordinatorResearchForkEnabled()).toBe(false)
    process.env.CLAUDE_CODE_COORDINATOR_RESEARCH_FORK = '0'
    expect(isCoordinatorResearchForkEnabled()).toBe(false)
    process.env.CLAUDE_CODE_COORDINATOR_RESEARCH_FORK = ''
    expect(isCoordinatorResearchForkEnabled()).toBe(false)
  })
})

describe('COORDINATOR_RESEARCH_FORK_SUBAGENT_TYPE constant', () => {
  test('matches the literal "fork"', () => {
    // The constant is the single source of truth; the AgentTool input
    // schema accepts arbitrary strings, so this is what callers spell.
    expect(COORDINATOR_RESEARCH_FORK_SUBAGENT_TYPE).toBe('fork')
  })
})

describe('buildChildMessage', () => {
  test('default mode produces the original 10-rule boilerplate', () => {
    const msg = buildChildMessage('investigate the auth module')
    // Sanity: the boilerplate framing is present so isInForkChild keeps working.
    expect(msg).toContain('STOP. READ THIS FIRST.')
    expect(msg).toContain('You are a forked worker process.')
    // The original 10 rules end with the report rule.
    expect(msg).toContain('10. REPORT structured facts, then stop')
    // No research-only rule in default mode.
    expect(msg).not.toContain('RESEARCH FORK')
    expect(msg).not.toContain('11.')
    // Directive is appended after the boilerplate.
    expect(msg).toContain('investigate the auth module')
  })

  test('coordinator-research mode adds rule 11 about read-only investigation', () => {
    const msg = buildChildMessage(
      'find where session expiry is enforced',
      'coordinator-research',
    )
    expect(msg).toContain('11. RESEARCH FORK')
    expect(msg).toContain('Do NOT modify files')
    expect(msg).toContain('report your findings instead')
    // The directive is still appended.
    expect(msg).toContain('find where session expiry is enforced')
  })

  test('coordinator-research mode keeps the original 10 rules verbatim', () => {
    const normal = buildChildMessage('directive', 'normal')
    const research = buildChildMessage('directive', 'coordinator-research')
    // Pull the rules section (between "RULES (non-negotiable):" and the
    // "Output format" line) and verify the first 10 rules of research
    // mode are byte-identical to normal mode. This protects the cache:
    // a divergent prefix would defeat the parent's prompt cache reuse.
    const rulesOf = (s: string): string => {
      const start = s.indexOf('RULES (non-negotiable):')
      const end = s.indexOf('Output format')
      expect(start).toBeGreaterThanOrEqual(0)
      expect(end).toBeGreaterThan(start)
      return s.slice(start, end)
    }
    const normalRules = rulesOf(normal)
    const researchRules = rulesOf(research)
    // The research version is the normal version + extra rule 11.
    expect(researchRules.startsWith(normalRules.replace(/\s+$/, ''))).toBe(true)
    expect(researchRules).toContain('11. RESEARCH FORK')
    expect(normalRules).not.toContain('11.')
  })

  test('boilerplate framing tag is preserved across modes (fork-recursion guard safety)', () => {
    // The exact opening tag is what isInForkChild searches for. If a
    // mode variant changed the tag, fork children would silently lose
    // recursion protection.
    const normal = buildChildMessage('d', 'normal')
    const research = buildChildMessage('d', 'coordinator-research')
    const tagPattern = /<[^>]+>\s*\nSTOP\. READ THIS FIRST\./
    expect(normal).toMatch(tagPattern)
    expect(research).toMatch(tagPattern)
  })
})

describe('isInForkChild — recursive-fork guard works for both modes', () => {
  function makeForkChildHistory(directive: string, mode: 'normal' | 'coordinator-research') {
    const text = buildChildMessage(directive, mode)
    return [
      {
        type: 'user' as const,
        message: {
          content: [{ type: 'text' as const, text }],
        },
      },
    ]
  }

  test('detects normal-mode fork child', () => {
    const history = makeForkChildHistory('do thing', 'normal')
    // We pass a minimally-typed array — isInForkChild only inspects
    // type/message.content shape.
    expect(isInForkChild(history as never)).toBe(true)
  })

  test('detects coordinator-research-mode fork child', () => {
    const history = makeForkChildHistory('investigate', 'coordinator-research')
    expect(isInForkChild(history as never)).toBe(true)
  })

  test('does not flag plain user messages as fork children', () => {
    const history = [
      {
        type: 'user' as const,
        message: {
          content: [{ type: 'text' as const, text: 'help me with the login bug' }],
        },
      },
    ]
    expect(isInForkChild(history as never)).toBe(false)
  })
})
