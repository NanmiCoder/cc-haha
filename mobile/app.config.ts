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

/** Where the desktop server hosts this app for phone browsers. Keep in step with `src/server/staticH5.ts`. */
export const H5_BASE_PATH = '/m'

/**
 * The H5 build: the same app, served by the desktop to phone browsers under
 * {@link H5_BASE_PATH}. Expo also inlines `EXPO_PUBLIC_CC_HAHA_H5` into the
 * bundle, which is how the app knows to treat the page's own computer as its
 * only one (see `src/state/h5.ts`).
 */
export function withH5Build(
  config: Partial<ExpoConfig>,
  environment: { EXPO_PUBLIC_CC_HAHA_H5?: string } = {
    EXPO_PUBLIC_CC_HAHA_H5: process.env.EXPO_PUBLIC_CC_HAHA_H5,
  }
): Partial<ExpoConfig> {
  if (environment.EXPO_PUBLIC_CC_HAHA_H5 !== '1') return config
  return {
    ...config,
    experiments: { ...config.experiments, baseUrl: H5_BASE_PATH },
    web: { ...config.web, lang: 'zh-CN', name: 'cc-haha', themeColor: '#F4F3F0' },
  }
}

export default ({ config }: ConfigContext) =>
  withH5Build(withGoogleServicesFile(withEasProject(config)))
