// Whether to include the Anthropic cyber-risk instruction in the system
// prompt and the file-read malware reminder. Mirrors gitSettings.ts:
// env override first, then Claude official account protection, then trusted
// settings sources (excluding untrusted projectSettings), latched once per
// session so toggling settings applies only to new sessions without busting
// a running session's prompt cache.

import { getOpenAIOAuthTokens } from '../services/openaiAuth/storage.js'
import { isClaudeAISubscriber } from './auth.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'
import {
  getAgentProviderRoute,
  getRequestProviderRoute,
} from './model/providerEnvScope.js'
import { hasAnthropicCompatibleThirdPartyConfig } from './model/providers.js'
import { getSettingsForSource } from './settings/settings.js'

const TRUSTED_CYBER_RISK_SETTING_SOURCES = [
  'policySettings',
  'flagSettings',
  'localSettings',
  'userSettings',
] as const

let latchedIncludeCyberRiskSetting: boolean | undefined

function readTrustedIncludeCyberRiskSetting(): boolean {
  for (const source of TRUSTED_CYBER_RISK_SETTING_SOURCES) {
    const value = getSettingsForSource(source)?.includeCyberRiskInstruction
    if (typeof value === 'boolean') return value
  }
  return true
}

function getLatchedIncludeCyberRiskSetting(): boolean {
  if (latchedIncludeCyberRiskSetting === undefined) {
    latchedIncludeCyberRiskSetting = readTrustedIncludeCyberRiskSetting()
  }
  return latchedIncludeCyberRiskSetting
}

export function resetCyberRiskInstructionSessionLatch(): void {
  latchedIncludeCyberRiskSetting = undefined
}

/**
 * Returns true when the active request/agent runs on a first-party Claude.ai
 * OAuth account (not routed to a saved third-party provider route, third-party
 * API endpoint, or active non-Claude OAuth provider). Keeps official Claude
 * accounts byte-identical to official Claude Code CLI even when the user opts
 * out for third-party providers.
 */
export function isClaudeOfficialAccountProtected(): boolean {
  if (getRequestProviderRoute() || getAgentProviderRoute()) {
    return false
  }
  const usingOpenAIOAuth =
    isEnvTruthy(process.env.CC_HAHA_OPENAI_OAUTH_PROVIDER) &&
    !!getOpenAIOAuthTokens()?.refreshToken
  if (
    usingOpenAIOAuth ||
    isEnvTruthy(process.env.CC_HAHA_GROK_OAUTH_PROVIDER) ||
    isEnvTruthy(process.env.CC_HAHA_DEEPSEEK_OAUTH_PROVIDER) ||
    hasAnthropicCompatibleThirdPartyConfig()
  ) {
    return false
  }
  try {
    return isClaudeAISubscriber()
  } catch {
    return false
  }
}

export function shouldIncludeCyberRiskInstruction(): boolean {
  const envVal = process.env.CLAUDE_CODE_DISABLE_CYBER_RISK_INSTRUCTION
  if (isEnvTruthy(envVal)) return false
  if (isEnvDefinedFalsy(envVal)) return true
  const setting = getLatchedIncludeCyberRiskSetting()
  if (isClaudeOfficialAccountProtected()) return true
  return setting
}
