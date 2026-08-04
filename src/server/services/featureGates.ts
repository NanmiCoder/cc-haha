/**
 * Feature Gate Registry — declarative mapping of features to the deployment
 * modes in which they are enabled.
 *
 * Consuming code queries deploymentModeService.isFeatureEnabled(key) instead
 * of branching on raw mode. Adding a new public-internet-dependent feature
 * means adding a key here, not scattering if-statements across modules.
 *
 * NOTE: A frontend mirror exists at desktop/src/config/featureGates.ts.
 * They are intentionally separate for MVP (no shared module yet); P1 may
 * consolidate to src/shared/.
 */

import type { DeploymentMode, FeatureKey } from '../../types/deploymentMode.js'

/**
 * Modes in which each feature is visible/enabled.
 * 'public' features are hidden under 'private-cloud'.
 */
export const FEATURE_MODES: Record<FeatureKey, DeploymentMode[]> = {
  'skill-market': ['public'],
  'official-oauth': ['public'],
  'official-mcp-registry': ['public'],
  'official-plugin-market': ['public'],
  'claude-in-chrome': ['public'],
  'im-telegram': ['public'],
  'im-whatsapp': ['public'],
  'im-wechat': ['public'],
  'auto-update-check': ['public'],
}

/**
 * Check whether a feature is enabled in the given mode.
 * Pure function — no side effects, safe for tests.
 */
export function isFeatureEnabledInMode(
  feature: FeatureKey,
  mode: DeploymentMode,
): boolean {
  const modes = FEATURE_MODES[feature]
  return modes.includes(mode)
}
