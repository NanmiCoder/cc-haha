import { describe, expect, test } from 'bun:test'
import { buildLocalOnboardingStepIds } from './onboardingSteps.js'

describe('buildLocalOnboardingStepIds', () => {
  test('keeps first-run CLI onboarding free of Anthropic network steps', () => {
    const steps = buildLocalOnboardingStepIds({
      apiKeyNeedsApproval: false,
      offerTerminalSetup: false,
    })

    expect(steps).toEqual(['theme', 'security'])
    expect(steps).not.toContain('preflight')
    expect(steps).not.toContain('oauth')
  })

  test('preserves local-only optional onboarding steps', () => {
    expect(
      buildLocalOnboardingStepIds({
        apiKeyNeedsApproval: true,
        offerTerminalSetup: true,
      }),
    ).toEqual(['theme', 'api-key', 'security', 'terminal-setup'])
  })
})
