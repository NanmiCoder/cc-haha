import { expect, test } from 'bun:test'
import { notificationPresentation } from './notificationPresentation'
import { testNotificationContent } from '../ui/settings/deliveryModel'

const banner = { shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }
const quiet = { shouldShowBanner: false, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }

test('alerts stay quiet in the list while the app is on screen and pop up otherwise', () => {
  const decision = { hostId: 'h', sessionId: 's', requestId: 'r', eventType: 'decision' }
  expect(notificationPresentation(true, decision)).toEqual(quiet)
  expect(notificationPresentation(false, decision)).toEqual(banner)
  expect(notificationPresentation(true, undefined)).toEqual(quiet)
  expect(notificationPresentation(true, null)).toEqual(quiet)
})

// The test button is tapped inside the app; a test that never shows a banner there
// cannot tell the user whether banners work.
test('the settings test shows its banner even though the app is on screen', () => {
  // What the desktop sends for POST /api/sessions/mobile-push/test.
  expect(notificationPresentation(true, { hostId: 'h', eventType: 'test' })).toEqual(banner)
  // The phone's own fallback test.
  expect(notificationPresentation(true, testNotificationContent.data)).toEqual(banner)
})

// The app applies a computer's new address itself while it is on screen; in the
// background it stays in the notification center until the app picks it up.
test('a new computer address is not shown while the app is open, and pops up otherwise', () => {
  const update = { hostId: 'h', eventType: 'hostUrl', url: 'https://new.example', mac: 'm' }
  expect(notificationPresentation(true, update)).toEqual({ ...quiet, shouldShowList: false })
  expect(notificationPresentation(false, update)).toEqual(banner)
})
