/**
 * Deployment Mode — frontend type definitions.
 *
 * Mirrors src/types/deploymentMode.ts (backend). Kept separate for MVP;
 * P1 may consolidate to a shared module.
 */

export type DeploymentMode = 'public' | 'private-cloud'

export type PrivateCloudConfig = {
  providerGatewayBaseUrl?: string
  dingtalkEndpoint?: string
  feishuEndpoint?: string
  updateServerUrl?: string
  internalSkillSource?: string
  telemetryEndpoint?: string
}

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

export function parseDeploymentMode(raw: unknown): DeploymentMode {
  return isValidDeploymentMode(raw) ? raw : 'public'
}
