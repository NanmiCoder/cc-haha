/**
 * Deployment Mode Service — the single read/parse point for deployment mode.
 *
 * Other services, routes, and network requests query this service; they must
 * NOT read settings.json directly for deployment-mode concerns.
 *
 * Lifecycle: init() is called once at server startup (before route
 * registration). The mode is cached for the entire process lifetime — there
 * is no hot-reload (OQ-2: switching mode requires restart).
 */

import {
  parseDeploymentMode,
  parsePrivateCloudConfig,
  type DeploymentMode,
  type PrivateCloudConfig,
  type FeatureKey,
} from '../../types/deploymentMode.js'
import { isFeatureEnabledInMode } from './featureGates.js'
import { SettingsService } from './settingsService.js'

class DeploymentModeService {
  private mode: DeploymentMode = 'public'
  private privateCloudConfig: PrivateCloudConfig = {}
  private initialized = false

  /**
   * Parse and cache deployment mode from raw settings.
   * Call once at startup, before route registration.
   */
  init(settings: Record<string, unknown>): void {
    const rawMode = settings.deploymentMode
    this.mode = parseDeploymentMode(rawMode)
    this.privateCloudConfig = this.mode === 'private-cloud'
      ? parsePrivateCloudConfig(settings.privateCloud)
      : {}

    if (rawMode !== undefined && rawMode !== this.mode) {
      // Illegal value degraded to 'public' -- warn but never throw.
      console.warn(
        `[deploymentMode] Unknown deploymentMode value "${String(rawMode)}", falling back to "public".`,
      )
    }

    this.initialized = true
    console.info(
      `[deploymentMode] Initialized: mode=${this.mode}, privateCloudConfig=${
        this.mode === 'private-cloud'
          ? Object.keys(this.privateCloudConfig).join(',') || '(none)'
          : '(ignored)'
      }`,
    )
  }

  /**
   * Convenience: read user settings from disk and init in one call.
   * Used at server startup before route registration.
   */
  async initFromSettingsFile(): Promise<void> {
    try {
      const settingsService = new SettingsService()
      const settings = await settingsService.getUserSettings()
      this.init(settings)
    } catch {
      // If settings read fails, default to public mode -- never block startup.
      this.init({})
    }
  }

  /** Current mode. Defaults to 'public' when uninitialized or value missing. */
  getMode(): DeploymentMode {
    return this.mode
  }

  /** Convenience predicate. */
  isPrivateCloud(): boolean {
    return this.mode === 'private-cloud'
  }

  /**
   * Private-cloud configuration block.
   * Returns {} when not in private-cloud mode.
   */
  getPrivateCloudConfig(): PrivateCloudConfig {
    return this.privateCloudConfig
  }

  /**
   * Feature gate query: is this feature enabled in the current mode?
   * O(1) lookup against the registry.
   */
  isFeatureEnabled(feature: FeatureKey): boolean {
    return isFeatureEnabledInMode(feature, this.mode)
  }

  /** Reset to default state (mainly for tests). */
  reset(): void {
    this.mode = 'public'
    this.privateCloudConfig = {}
    this.initialized = false
  }
}

export const deploymentModeService = new DeploymentModeService()
export { isFeatureEnabledInMode }
