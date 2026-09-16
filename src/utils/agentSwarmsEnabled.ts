import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { isEnvTruthy } from './envUtils.js'

/**
 * Check if --agent-teams flag is provided via CLI.
 * Checks process.argv directly to avoid import cycles with bootstrap/state.
 * Note: The flag is only shown in help for ant users, but if external users
 * pass it anyway, it will work (subject to the killswitch).
 */
function isAgentTeamsFlagSet(): boolean {
  return process.argv.includes('--agent-teams')
}

/**
 * Centralized runtime check for agent teams/teammate features.
 * This is the single gate that should be checked everywhere teammates
 * are referenced (prompts, code, tools isEnabled, UI, etc.).
 *
 * A cc-haha General opt-out takes priority over all opt-ins.
 * Ant builds: enabled unless the host explicitly opts out.
 * External builds require both:
 * 1. Opt-in via the cc-haha host preference, legacy env, or --agent-teams
 * 2. GrowthBook gate 'tengu_amber_flint' enabled (killswitch)
 */
export function isAgentSwarmsEnabled(): boolean {
  // A saved General opt-out is authoritative even for forced/team child launches.
  if (
    process.env.CC_HAHA_AGENT_TEAMS_ENABLED !== undefined &&
    !isEnvTruthy(process.env.CC_HAHA_AGENT_TEAMS_ENABLED)
  ) {
    return false
  }

  // Ant: always on unless the host explicitly disabled teams
  if (process.env.USER_TYPE === 'ant') {
    return true
  }

  // The host resolves General and legacy settings before launching. Standalone
  // CLI sessions retain their upstream opt-in behavior.
  const optIn = process.env.CC_HAHA_AGENT_TEAMS_ENABLED ??
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS ??
    process.env.CC_HAHA_AGENT_TEAMS_DEFAULT

  // External: require opt-in via env var, host default, or --agent-teams flag
  if (
    !isEnvTruthy(optIn) &&
    !isAgentTeamsFlagSet()
  ) {
    return false
  }

  // Killswitch — always respected for external users
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_flint', true)) {
    return false
  }

  return true
}
