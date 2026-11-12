import { expect, test } from 'bun:test'
import {
  effortName,
  modeName,
  modes,
  planExecutionModes,
  profileName,
} from './modes'

test('every permission mode has exactly one user-facing name', () => {
  expect(modes.map((mode) => [mode.id, mode.title])).toEqual([
    ['default', 'Ask'],
    ['acceptEdits', 'Auto-accept edits'],
    ['auto', 'Auto'],
    ['plan', 'plan'],
    ['bypassPermissions', 'Full access'],
  ])
  expect(modeName('default')).toBe('Ask')
  expect(modeName('dontAsk')).toBe('Don’t ask')
  expect(modeName(undefined)).toBe('Ask')
  expect(modeName('futureMode')).toBe('futureMode')
})

test('plan execution reuses the same names instead of a second vocabulary', () => {
  expect(planExecutionModes.map((mode) => mode.title)).toEqual([
    'Ask',
    'Auto-accept edits',
    'Full access',
  ])
})

test('effort and profile labels are localized once with safe fallbacks', () => {
  expect(effortName('high')).toBe('High')
  expect(effortName('xhigh')).toBe('Max')
  expect(effortName('max')).toBe('Highest')
  expect(effortName(undefined)).toBe('Default')
  expect(effortName('turbo')).toBe('turbo')
  expect(profileName('lean')).toBe('Light')
  expect(profileName('standard')).toBe('Full tools')
  expect(profileName(undefined)).toBe('Full tools')
})
