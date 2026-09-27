import { describe, expect, test } from 'bun:test'
import { CLAUDE_CODE_COMPAT_VERSION } from './claudeCodeCompatibility.js'
import { getAttributionHeader } from './system.js'

describe('getAttributionHeader', () => {
  test('tracks the audited upstream Claude Code compatibility release', () => {
    expect(CLAUDE_CODE_COMPAT_VERSION).toBe('2.1.281')
  })

  test('uses Claude Code compatibility version and always includes CCH placeholder', () => {
    const originalEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'

    try {
      expect(getAttributionHeader('abc')).toBe(
        'x-anthropic-billing-header: cc_version=2.1.281.abc; cc_entrypoint=cli; cch=00000;',
      )
    } finally {
      if (originalEntrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT
      else process.env.CLAUDE_CODE_ENTRYPOINT = originalEntrypoint
    }
  })
})
