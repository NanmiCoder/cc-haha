import { expect, test } from 'bun:test'
import { foregroundTransitions, isAppForeground } from './appVisibility'

test('only a return from the background counts as coming back; inactive flickers do not', () => {
  const next = foregroundTransitions('active')
  expect(
    ['inactive', 'active', 'inactive', 'background', 'inactive', 'active', 'active'].map(next)
  ).toEqual([null, null, null, 'left', null, 'returned', null])
})

test('an app that starts in the background reports its first activation as a return', () => {
  const next = foregroundTransitions('background')
  expect(['background', 'active', 'background'].map(next)).toEqual([null, 'returned', 'left'])
})

test('iOS inactive (Notification Center, Face ID, app switcher) still counts as foreground', () => {
  expect(isAppForeground('active')).toBe(true)
  expect(isAppForeground('inactive')).toBe(true)
})

test('only background, or an unknown launch state, counts as away', () => {
  expect(isAppForeground('background')).toBe(false)
  expect(isAppForeground('unknown')).toBe(false)
  expect(isAppForeground(null)).toBe(false)
  expect(isAppForeground(undefined)).toBe(false)
})
