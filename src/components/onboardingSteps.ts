export type LocalOnboardingStepId =
  | 'theme'
  | 'api-key'
  | 'security'
  | 'terminal-setup'

type BuildLocalOnboardingStepIdsOptions = {
  apiKeyNeedsApproval: boolean
  offerTerminalSetup: boolean
}

export function buildLocalOnboardingStepIds({
  apiKeyNeedsApproval,
  offerTerminalSetup,
}: BuildLocalOnboardingStepIdsOptions): LocalOnboardingStepId[] {
  const steps: LocalOnboardingStepId[] = ['theme']

  if (apiKeyNeedsApproval) {
    steps.push('api-key')
  }

  steps.push('security')

  if (offerTerminalSetup) {
    steps.push('terminal-setup')
  }

  return steps
}
