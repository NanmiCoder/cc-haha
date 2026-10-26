import * as Notifications from 'expo-notifications'

/** APNs/FCM can be unavailable on a simulator or while offline. Never leave a
 * host-removal or widget queue waiting indefinitely on the native token request. */
export async function getDevicePushToken(): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const token = await Promise.race([
      Notifications.getDevicePushTokenAsync(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('未能获取系统推送凭据，请检查网络后重试')),
          6000
        )
      }),
    ])
    if (typeof token.data !== 'string' || !token.data)
      throw new Error('当前设备不支持原生推送凭据')
    return token.data
  } finally {
    clearTimeout(timer)
  }
}
