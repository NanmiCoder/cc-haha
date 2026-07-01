import { describe, expect, test } from 'bun:test'
import {
  formatSpecialistRedirectMessage,
  suggestSpecialist,
} from './specialistRouter.js'

const ALL_AVAILABLE = new Set([
  'general-purpose',
  'code-reviewer',
  'security-reviewer',
  'debugger',
  'refactor',
  'migration',
  'docs-writer',
  'performance',
  'commit-pr',
  'test-author',
  'verification',
  'Explore',
  'Plan',
])

describe('suggestSpecialist', () => {
  test('returns undefined for vague prompts', () => {
    expect(suggestSpecialist('look at this code', ALL_AVAILABLE)).toBeUndefined()
    expect(suggestSpecialist('help me with src/', ALL_AVAILABLE)).toBeUndefined()
    expect(
      suggestSpecialist('find all TODO comments', ALL_AVAILABLE),
    ).toBeUndefined()
  })

  test('routes "code review" prompts to code-reviewer', () => {
    expect(
      suggestSpecialist('please code review the auth module', ALL_AVAILABLE),
    ).toBe('code-reviewer')
    expect(
      suggestSpecialist('review my changes in src/auth', ALL_AVAILABLE),
    ).toBe('code-reviewer')
    expect(
      suggestSpecialist('Review this PR before merge', ALL_AVAILABLE),
    ).toBe('code-reviewer')
  })

  test('routes security-flavoured prompts to security-reviewer', () => {
    expect(
      suggestSpecialist(
        'do a security review of the new endpoints',
        ALL_AVAILABLE,
      ),
    ).toBe('security-reviewer')
    expect(
      suggestSpecialist('check for SQL injection in queries.ts', ALL_AVAILABLE),
    ).toBe('security-reviewer')
    expect(
      suggestSpecialist('audit secrets handling', ALL_AVAILABLE),
    ).toBe('security-reviewer')
  })

  test('routes debugging prompts to debugger', () => {
    expect(
      suggestSpecialist(
        'find the root cause of this crash',
        ALL_AVAILABLE,
      ),
    ).toBe('debugger')
    expect(
      suggestSpecialist(
        'why does this test fail intermittently',
        ALL_AVAILABLE,
      ),
    ).toBe('debugger')
  })

  test('routes refactor prompts to refactor', () => {
    expect(
      suggestSpecialist('refactor the login flow', ALL_AVAILABLE),
    ).toBe('refactor')
    expect(
      suggestSpecialist('extract method from validateUser', ALL_AVAILABLE),
    ).toBe('refactor')
  })

  test('routes migration prompts to migration', () => {
    expect(
      suggestSpecialist(
        'migrate from React 17 to React 18',
        ALL_AVAILABLE,
      ),
    ).toBe('migration')
    expect(
      suggestSpecialist('upgrade to next major version', ALL_AVAILABLE),
    ).toBe('migration')
  })

  test('routes docs prompts to docs-writer', () => {
    expect(
      suggestSpecialist('update the README for the new flag', ALL_AVAILABLE),
    ).toBe('docs-writer')
    expect(
      suggestSpecialist(
        'write JSDoc for the public API',
        ALL_AVAILABLE,
      ),
    ).toBe('docs-writer')
  })

  test('routes performance prompts to performance', () => {
    expect(
      suggestSpecialist('investigate the performance issue', ALL_AVAILABLE),
    ).toBe('performance')
    expect(
      suggestSpecialist('this endpoint is too slow', ALL_AVAILABLE),
    ).toBe('performance')
    expect(
      suggestSpecialist('reduce bundle-size in the desktop build', ALL_AVAILABLE),
    ).toBe('performance')
  })

  test('routes commit-style prompts to commit-pr', () => {
    expect(
      suggestSpecialist(
        'write a commit message for this diff',
        ALL_AVAILABLE,
      ),
    ).toBe('commit-pr')
    expect(
      suggestSpecialist(
        'draft a PR description summarizing the change',
        ALL_AVAILABLE,
      ),
    ).toBe('commit-pr')
  })

  test('routes test-authoring prompts to test-author', () => {
    expect(
      suggestSpecialist('write a regression test for issue #42', ALL_AVAILABLE),
    ).toBe('test-author')
    expect(
      suggestSpecialist('add tests for the new helper', ALL_AVAILABLE),
    ).toBe('test-author')
  })

  test('falls through when matched specialist is not available', () => {
    // When the verification agent isn't loaded (e.g. SDK build), the
    // prompt should not redirect to it — falls through to default.
    const limited = new Set([
      'general-purpose',
      'code-reviewer',
      'debugger',
    ])
    expect(
      suggestSpecialist(
        'do an adversarial verification of the fix',
        limited,
      ),
    ).toBeUndefined()
  })

  test('does not match prose that incidentally contains a keyword', () => {
    // "audit log" is a feature, not an audit task.
    expect(
      suggestSpecialist(
        'add an audit log entry when users sign in',
        ALL_AVAILABLE,
      ),
    ).toBeUndefined()
    // "performance" as a noun in unrelated context shouldn't trigger.
    expect(
      suggestSpecialist(
        'rename the performance variable to perfStats',
        ALL_AVAILABLE,
      ),
    ).toBeUndefined()
  })

  test('higher-priority hints win when multiple match', () => {
    // A prompt that mentions both "security review" and "performance"
    // should route to security-reviewer (security listed first).
    const text =
      'security review of the slow endpoint, also check for SQL injection'
    expect(suggestSpecialist(text, ALL_AVAILABLE)).toBe('security-reviewer')
  })
})


describe('formatSpecialistRedirectMessage', () => {
  test('mentions the suggested specialist by name', () => {
    const msg = formatSpecialistRedirectMessage('code-reviewer', 'Agent')
    expect(msg).toContain('code-reviewer')
  })

  test('mentions the agent tool name passed in', () => {
    const msg = formatSpecialistRedirectMessage('debugger', 'Task')
    expect(msg).toContain('Task')
  })

  test('points the user at the env-var escape hatch', () => {
    const msg = formatSpecialistRedirectMessage('refactor', 'Agent')
    expect(msg).toContain('CLAUDE_CODE_GP_DEFAULT_STRICT')
  })

  // Regression for an observed live failure: when this message embedded
  // attribute-style fragments like `subagent_type="code-reviewer"`, the
  // downstream model copied them verbatim into a textual
  // `<tool_use name="Agent">{...}` block instead of issuing a real tool
  // call, and every subsequent Agent call in that session degraded to
  // text. The message must not contain any `key="value"` shapes that
  // a model could mistake for a JSON property or XML attribute.
  test('does not embed key="value" attribute-style fragments', () => {
    for (const specialist of [
      'code-reviewer',
      'security-reviewer',
      'debugger',
      'refactor',
      'migration',
      'docs-writer',
      'performance',
      'commit-pr',
      'test-author',
      'verification',
    ]) {
      const msg = formatSpecialistRedirectMessage(specialist, 'Agent')
      // No `something="something"` attribute pairs.
      expect(msg).not.toMatch(/[a-z_][a-z0-9_]*\s*=\s*"/i)
      // No XML-ish open tag.
      expect(msg).not.toMatch(/<\s*[a-z_][a-z0-9_]*[^>]*>/i)
      // No JSON-ish property fragment that names subagent_type.
      expect(msg).not.toMatch(/"subagent_type"\s*:/i)
    }
  })
})
