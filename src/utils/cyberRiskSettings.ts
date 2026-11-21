// Whether to include the Anthropic cyber-risk instruction in the system
// prompt and the file-read malware reminder. Mirrors gitSettings.ts:
// env override first, then the user setting, defaulting to included.

import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'
import { getInitialSettings } from './settings/settings.js'

export function shouldIncludeCyberRiskInstruction(): boolean {
  const envVal = process.env.CLAUDE_CODE_DISABLE_CYBER_RISK_INSTRUCTION
  if (isEnvTruthy(envVal)) return false
  if (isEnvDefinedFalsy(envVal)) return true
  return getInitialSettings().includeCyberRiskInstruction ?? true
}
