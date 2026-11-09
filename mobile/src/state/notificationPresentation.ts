/**
 * How a notification shows while it arrives. With the app on screen, alerts go to the list
 * quietly (what they report is already in front of the user), except the settings test:
 * it is tapped inside the app and exists to show the banner. A computer's new address is
 * applied by the app itself while it is on screen, so that one is not shown at all.
 */
export function notificationPresentation(appActive: boolean, data: unknown) {
  if (appActive && eventType(data) === 'hostUrl')
    return { shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false }
  // The desktop's test push and the phone's local test both carry `eventType: 'test'`.
  const quiet = appActive && eventType(data) !== 'test'
  return {
    shouldShowBanner: !quiet,
    shouldShowList: true,
    shouldPlaySound: !quiet,
    shouldSetBadge: false,
  }
}

function eventType(data: unknown) {
  return typeof data === 'object' && data !== null ? (data as { eventType?: unknown }).eventType : undefined
}
