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

export default ({ config }: ConfigContext) => withGoogleServicesFile(config)
