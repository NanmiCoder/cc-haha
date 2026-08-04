/**
 * Frontend feature gate registry - mirror of src/server/services/featureGates.ts.
 *
 * Kept separate for MVP (no shared module). P1 may consolidate to src/shared/.
 */

import type { DeploymentMode, FeatureKey } from '../types/deploymentMode'

export type { FeatureKey }

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

export function isFeatureEnabledInMode(
  feature: FeatureKey,
  mode: DeploymentMode,
): boolean {
  return FEATURE_MODES[feature].includes(mode)
}
