import * as Notifications from 'expo-notifications'

export class DevicePushTokenError extends Error {
  constructor(public readonly code: 'NOT_CONFIGURED' | 'UNAVAILABLE' | 'TIMEOUT') {
    super(code === 'NOT_CONFIGURED'
      ? '此版本暂不支持后台推送。'
      : code === 'TIMEOUT'
        ? '手机推送服务响应超时，请稍后重试。'
        : '暂时无法连接手机推送服务，请检查网络后重试。')
    this.name = 'DevicePushTokenError'
  }
}

/** APNs/FCM can be unavailable on a simulator or while offline. Never leave a
 * host-removal or widget queue waiting indefinitely on the native token request. */
export async function getDevicePushToken(): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const token = await Promise.race([
      Notifications.getDevicePushTokenAsync(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new DevicePushTokenError('TIMEOUT')),
          6000
        )
      }),
    ])
    if (typeof token.data !== 'string' || !token.data)
      throw new DevicePushTokenError('UNAVAILABLE')
    return token.data
  } catch (error) {
    if (error instanceof DevicePushTokenError) throw error
    const message = error instanceof Error ? error.message : ''
    // Expo uses E_REGISTRATION_FAILED for both missing Firebase configuration
    // and transient failures. Only its explicit initialization error is permanent.
    if (/Default FirebaseApp is not initialized/i.test(message))
      throw new DevicePushTokenError('NOT_CONFIGURED')
    throw new DevicePushTokenError('UNAVAILABLE')
  } finally {
    clearTimeout(timer)
  }
}
