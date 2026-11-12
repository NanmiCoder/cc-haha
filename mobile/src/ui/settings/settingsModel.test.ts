import { describe, expect, test } from 'bun:test'
import { isQuietTime, migratePreferences } from '../../state/preferences'
import {
  autoAnswerLabel,
  autoAnswerMinutes,
  autoAnswerValue,
  desktopOnly,
  nextAutoQuestion,
  pushFootnote,
  quietHint,
  quietSummary,
  readAutoQuestion,
  selectedMinutes,
  validateQuietHours,
} from './settingsModel'

describe('quiet hours', () => {
  test('summary reads off, a range, or all day when start equals end', () => {
    expect(quietSummary({ enabled: false, start: '23:00', end: '08:00' })).toBe('Off')
    expect(quietSummary({ enabled: true, start: '23:00', end: '08:00' })).toBe(
      '23:00 – 08:00'
    )
    expect(quietSummary({ enabled: true, start: '09:00', end: '09:00' })).toBe('All day')
  })

  test('the all-day hint matches how notifications are actually muted', () => {
    const draft = { enabled: true, start: '09:00', end: '09:00' }
    expect(quietHint(draft)).toBe('Same start and end means quiet all day.')
    const preferences = migratePreferences(JSON.stringify({ quietHours: draft }))
    expect(isQuietTime(preferences, new Date(2026, 0, 1, 15, 0))).toBe(true)
    expect(quietHint({ ...draft, enabled: false })).toBe('')
    expect(quietHint({ ...draft, end: '10:00' })).toBe('')
  })

  test('Done validates both times before anything is written', () => {
    expect(validateQuietHours({ enabled: true, start: '7:00', end: '08:00' })).toEqual({
      error: 'Please enter time in HH:mm format',
    })
    expect(validateQuietHours({ enabled: false, start: '23:00', end: '24:00' })).toEqual({
      error: 'Please enter time in HH:mm format',
    })
    // The toggle travels with the times, so switching it alone never saves early.
    expect(validateQuietHours({ enabled: true, start: ' 22:30', end: '07:15 ' })).toEqual({
      value: { enabled: true, start: '22:30', end: '07:15' },
    })
    const saved = validateQuietHours({ enabled: true, start: '22:30', end: '07:15' }).value
    expect(migratePreferences(JSON.stringify({ quietHours: saved })).quietHours).toEqual({
      enabled: true,
      start: '22:30',
      end: '07:15',
    })
  })
})

describe('push footnote', () => {
  test('each push state has one explanation', () => {
    expect(pushFootnote({ status: 'registered' }, 'MacBook Pro')).toBe(
      'MacBook Pro Push is set up; you receive alerts even when the app is not in the foreground.'
    )
    expect(pushFootnote({ status: 'notConfigured' }, 'A')).toContain('APNs / FCM')
    expect(pushFootnote({ status: 'permissionRequired' }, 'A')).toContain('system settings')
    expect(pushFootnote({ status: 'unsupported' }, 'A')).toContain('cannot register')
    expect(pushFootnote({ status: 'error', error: 'offline' }, 'A')).toBe('offline')
    expect(pushFootnote({ status: 'error' }, 'A')).toContain('Failed to register')
    expect(pushFootnote({ status: 'loading' }, 'A')).toBe('')
    expect(pushFootnote(undefined, undefined)).toBe('')
  })
})

describe('AI auto answer', () => {
  test('choices and labels follow the desktop timeout options', () => {
    expect(autoAnswerMinutes.map(autoAnswerLabel)).toEqual([
      'No auto-answer',
      '1 min',
      '5 min',
      '10 min',
      '30 min',
    ])
    expect(autoAnswerValue({ enabled: true, timeoutMinutes: 5 })).toBe('Wait 5 minutes')
    expect(autoAnswerValue({ enabled: false, timeoutMinutes: 10 })).toBe('No auto-answer')
    expect(selectedMinutes({ enabled: false, timeoutMinutes: 10 })).toBe(0)
    expect(selectedMinutes({ enabled: true, timeoutMinutes: 10 })).toBe(10)
  })

  test('writes enabled with the chosen wait, and keeps the wait when turned off', () => {
    expect(nextAutoQuestion({ enabled: false, timeoutMinutes: 5 }, 10)).toEqual({
      enabled: true,
      timeoutMinutes: 10,
    })
    expect(nextAutoQuestion({ enabled: true, timeoutMinutes: 30 }, 0)).toEqual({
      enabled: false,
      timeoutMinutes: 30,
    })
  })

  test('reads missing or unknown host values the way the desktop normalizes them', () => {
    expect(readAutoQuestion({})).toEqual({ enabled: false, timeoutMinutes: 5 })
    expect(readAutoQuestion({ autoQuestion: [] })).toEqual({ enabled: false, timeoutMinutes: 5 })
    expect(readAutoQuestion({ autoQuestion: { enabled: 'yes', timeoutMinutes: 7 } })).toEqual({
      enabled: false,
      timeoutMinutes: 5,
    })
    expect(readAutoQuestion({ autoQuestion: { enabled: true, timeoutMinutes: 30 } })).toEqual({
      enabled: true,
      timeoutMinutes: 30,
    })
  })
})

test('desktop-only list excludes Computer Use now available from the composer', () => {
  expect(desktopOnly).toBe(
    'MCP, skills and plugins · Providers and API keys · Official account sign-in · IM bots · LAN and public access'
  )
})
