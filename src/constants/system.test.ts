import { describe, expect, test } from 'bun:test'
import { CLAUDE_CODE_COMPAT_VERSION } from './claudeCodeCompatibility.js'
import { getAttributionHeader } from './system.js'

describe('getAttributionHeader', () => {
  test('tracks the audited upstream Claude Code compatibility release', () => {
    expect(CLAUDE_CODE_COMPAT_VERSION).toBe('2.1.281')
  })

  test('uses Claude Code compatibility version and always includes CCH placeholder', () => {
    const originalEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
    const originalAttribution = process.env.CLAUDE_CODE_ATTRIBUTION_HEADER
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
    // The desktop app exports CLAUDE_CODE_ATTRIBUTION_HEADER=0 into its
    // processes; a falsy inherited value would disable the header and break
    // this default-enabled assertion, so pin it on for the test.
    process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '1'

    try {
      expect(getAttributionHeader('abc')).toBe(
        'x-anthropic-billing-header: cc_version=2.1.281.abc; cc_entrypoint=cli; cch=00000;',
      )
    } finally {
      if (originalEntrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT
      else process.env.CLAUDE_CODE_ENTRYPOINT = originalEntrypoint
      if (originalAttribution === undefined) delete process.env.CLAUDE_CODE_ATTRIBUTION_HEADER
      else process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = originalAttribution
    }
  })
})
