export const STORE_CLIENT_EXECUTION_ENVIRONMENT = 'storeClient'

export type AndroidOtaSupportInput = {
  platform: string
  isH5: boolean
  executionEnvironment: string | null | undefined
  hasNativeModule: boolean
}

/**
 * 仅在 Android 原生安装包（非 iOS、非 H5/Web、非 Expo Go）且本地更新模块可用时开启应用内更新。
 */
export function isAndroidOtaSupported(input: AndroidOtaSupportInput): boolean {
  if (input.platform !== 'android' || input.isH5) return false
  if (input.executionEnvironment === STORE_CLIENT_EXECUTION_ENVIRONMENT) return false
  return input.hasNativeModule
}
