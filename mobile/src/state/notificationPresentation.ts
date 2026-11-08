/**
 * How a notification shows while it arrives. With the app on screen, alerts go to the list
 * quietly (what they report is already in front of the user), except the settings test:
 * it is tapped inside the app and exists to show the banner.
 */
export function notificationPresentation(appActive: boolean, data: unknown) {
  const quiet = appActive && !isTestNotification(data)
  return {
    shouldShowBanner: !quiet,
    shouldShowList: true,
    shouldPlaySound: !quiet,
    shouldSetBadge: false,
  }
}

/** The desktop's test push and the phone's local test both carry `eventType: 'test'`. */
function isTestNotification(data: unknown) {
  return typeof data === 'object' && data !== null && (data as { eventType?: unknown }).eventType === 'test'
}
