/**
 * useDeploymentMode — React hook for reading deployment mode from settings.
 *
 * UI components use this (or useFeatureGate) instead of branching on raw
 * mode strings. The mode is read from the settings store, which fetches it
 * from /api/settings/user at startup.
 */

import { useSettingsStore } from '../stores/settingsStore'
import {
  parseDeploymentMode,
  type DeploymentMode,
} from '../types/deploymentMode'
import { isFeatureEnabledInMode, type FeatureKey } from '../config/featureGates'

/**
 * Read the current deployment mode from the settings store.
 * Returns 'public' as the safe default when settings haven't loaded.
 */
export function useDeploymentMode(): {
  mode: DeploymentMode
  isPrivateCloud: boolean
} {
  // The settings store holds the raw user settings object internally via
  // fetchAll(). We read deploymentMode from the store's userSettings.
  // Since the store doesn't expose every raw field, we use getState to
  // access the persisted user settings for the deployment mode field.
  const deploymentMode = useSettingsStore(s => s.deploymentMode)
  const mode = parseDeploymentMode(deploymentMode)
  return {
    mode,
    isPrivateCloud: mode === 'private-cloud',
  }
}

/**
 * Feature gate hook: returns true if the feature should be rendered.
 *
 * Usage:
 *   const showSkillMarket = useFeatureGate('skill-market')
 *   {showSkillMarket && <MarketEntry />}
 */
export function useFeatureGate(feature: FeatureKey): boolean {
  const { mode } = useDeploymentMode()
  return isFeatureEnabledInMode(feature, mode)
}
