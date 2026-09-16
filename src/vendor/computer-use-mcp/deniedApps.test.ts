import { expect, test } from 'bun:test'
import {
  categoryToTier,
  getDefaultTierForApp,
  getDeniedCategory,
  getDeniedCategoryByDisplayName,
  getDeniedCategoryForApp,
  isPolicyDenied,
} from './deniedApps.js'

// Legacy consumers still use these exports. Neither an old category value nor
// an app lookup may reintroduce restrictions after feature-wide consent.
test('legacy category values cannot downgrade global Computer Use consent', () => {
  for (const category of ['browser', 'terminal', 'trading', null] as const) {
    expect(categoryToTier(category)).toBe('full')
  }
})

test.each([
  ['com.google.Chrome', 'Google Chrome'],
  ['com.apple.Terminal', 'Terminal'],
  ['com.spotify.client', 'Spotify'],
  ['com.webull.desktop.v1', 'Webull'],
  ['com.claude-code-haha.desktop', 'Claude Code Haha'],
  ['dev.cchaha.cu-helper', 'Computer Use Helper'],
  ['org.example.new-app', 'New App'],
])('legacy lookup for %s grants the same access with or without a bundle ID', (bundleId, displayName) => {
  expect(getDeniedCategory(bundleId)).toBeNull()
  expect(getDeniedCategoryByDisplayName(displayName)).toBeNull()
  for (const id of [bundleId, undefined]) {
    expect(getDeniedCategoryForApp(id, displayName)).toBeNull()
    expect(isPolicyDenied(id, displayName)).toBe(false)
    expect(getDefaultTierForApp(id, displayName)).toBe('full')
  }
})
