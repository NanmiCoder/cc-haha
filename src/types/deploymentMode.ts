/**
 * Deployment Mode — shared type definitions.
 *
 * Single runtime config switch controlling all "public-internet dependency"
 * behavior differences. See docs/deployment-mode-architecture.md.
 *
 * Storage: user-level ~/.claude/settings.json
 *   { "deploymentMode": "private-cloud", "privateCloud": { ... } }
 *
 * Default / unknown value is always "public" (backward compatibility).
 */

export type DeploymentMode = 'public' | 'private-cloud'

export type PrivateCloudConfig = {
  /** Default hint value for new Provider baseUrl (OQ-3: not a forced override). */
  providerGatewayBaseUrl?: string
  /** DingTalk private-deployment endpoint. */
  dingtalkEndpoint?: string
  /** Feishu private-deployment endpoint. */
  feishuEndpoint?: string
  /** Auto-update server URL; overrides app-update.yml via setFeedURL. */
  updateServerUrl?: string
  /** MVP reserved — internal skill source (OQ-5: not consumed yet). */
  internalSkillSource?: string
  /** Telemetry redirect endpoint; empty/absent = disable telemetry. */
  telemetryEndpoint?: string
}

/**
 * Feature keys gated by deployment mode.
 *
 * Each key maps to the modes in which the feature is visible/enabled.
 * Adding a new public-internet-dependent feature = add a key here + gate
 * the consuming UI/service with isFeatureEnabled().
 */
export type FeatureKey =
  | 'skill-market'
  | 'official-oauth'
  | 'official-mcp-registry'
  | 'official-plugin-market'
  | 'claude-in-chrome'
  | 'im-telegram'
  | 'im-whatsapp'
  | 'im-wechat'
  | 'auto-update-check'

export const VALID_DEPLOYMENT_MODES: readonly DeploymentMode[] = ['public', 'private-cloud']

export function isValidDeploymentMode(value: unknown): value is DeploymentMode {
  return typeof value === 'string' && VALID_DEPLOYMENT_MODES.includes(value as DeploymentMode)
}

/**
 * Parse deployment mode from raw settings. Any missing/illegal value
 * degrades to 'public' to guarantee zero impact on existing users.
 */
export function parseDeploymentMode(raw: unknown): DeploymentMode {
  return isValidDeploymentMode(raw) ? raw : 'public'
}

/**
 * Parse private-cloud config block from raw settings.
 * Returns {} when absent or not an object.
 */
export function parsePrivateCloudConfig(raw: unknown): PrivateCloudConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const obj = raw as Record<string, unknown>
  const config: PrivateCloudConfig = {}
  if (typeof obj.providerGatewayBaseUrl === 'string' && obj.providerGatewayBaseUrl.trim()) {
    config.providerGatewayBaseUrl = obj.providerGatewayBaseUrl.trim()
  }
  if (typeof obj.dingtalkEndpoint === 'string' && obj.dingtalkEndpoint.trim()) {
    config.dingtalkEndpoint = obj.dingtalkEndpoint.trim()
  }
  if (typeof obj.feishuEndpoint === 'string' && obj.feishuEndpoint.trim()) {
    config.feishuEndpoint = obj.feishuEndpoint.trim()
  }
  if (typeof obj.updateServerUrl === 'string' && obj.updateServerUrl.trim()) {
    config.updateServerUrl = obj.updateServerUrl.trim()
  }
  if (typeof obj.internalSkillSource === 'string' && obj.internalSkillSource.trim()) {
    config.internalSkillSource = obj.internalSkillSource.trim()
  }
  if (typeof obj.telemetryEndpoint === 'string' && obj.telemetryEndpoint.trim()) {
    config.telemetryEndpoint = obj.telemetryEndpoint.trim()
  }
  return config
}
