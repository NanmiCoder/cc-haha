import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ConfigContext, ExpoConfig } from 'expo/config'

/** Build-time Firebase client metadata; service-account private keys belong on the desktop. */
export function withGoogleServicesFile(
  config: Partial<ExpoConfig>,
  file = process.env.CC_HAHA_GOOGLE_SERVICES_FILE
): Partial<ExpoConfig> {
  if (!file) return config
  const path = resolve(file)
  let services: {
    client?: {
      client_info?: { android_client_info?: { package_name?: string } }
    }[]
  }
  try {
    services = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(
      'CC_HAHA_GOOGLE_SERVICES_FILE 必须指向可读取的 Firebase Android 客户端 JSON'
    )
  }
  if (
    !Array.isArray(services.client) ||
    !services.client.some(
      (client) =>
        client.client_info?.android_client_info?.package_name ===
        config.android?.package
    )
  ) {
    throw new Error(
      'Firebase 客户端必须包含与 android.package 一致的 Android 应用'
    )
  }
  return { ...config, android: { ...config.android, googleServicesFile: path } }
}

/** CI overrides are public project identifiers, never signing or upload secrets. */
export function withEasProject(
  config: Partial<ExpoConfig>,
  environment: { EXPO_PROJECT_ID?: string, EXPO_OWNER?: string } = {
    EXPO_PROJECT_ID: process.env.EXPO_PROJECT_ID,
    EXPO_OWNER: process.env.EXPO_OWNER,
  }
): Partial<ExpoConfig> {
  const projectId = environment.EXPO_PROJECT_ID?.trim() || config.extra?.eas?.projectId
  const owner = environment.EXPO_OWNER?.trim() || config.owner
  if (projectId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
    throw new Error('EXPO_PROJECT_ID 必须是 EAS 项目的 UUID')
  }
  if (!projectId && !owner) return config
  return {
    ...config,
    ...(owner ? { owner } : {}),
    ...(projectId ? {
      extra: { ...config.extra, eas: { ...config.extra?.eas, projectId } },
    } : {}),
  }
}

export default ({ config }: ConfigContext) => withGoogleServicesFile(withEasProject(config))
