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
    expect(quietSummary({ enabled: false, start: '23:00', end: '08:00' })).toBe('未开启')
    expect(quietSummary({ enabled: true, start: '23:00', end: '08:00' })).toBe(
      '23:00 – 08:00'
    )
    expect(quietSummary({ enabled: true, start: '09:00', end: '09:00' })).toBe('全天')
  })

  test('the all-day hint matches how notifications are actually muted', () => {
    const draft = { enabled: true, start: '09:00', end: '09:00' }
    expect(quietHint(draft)).toBe('开始和结束相同，表示全天勿扰。')
    const preferences = migratePreferences(JSON.stringify({ quietHours: draft }))
    expect(isQuietTime(preferences, new Date(2026, 0, 1, 15, 0))).toBe(true)
    expect(quietHint({ ...draft, enabled: false })).toBe('')
    expect(quietHint({ ...draft, end: '10:00' })).toBe('')
  })

  test('Done validates both times before anything is written', () => {
    expect(validateQuietHours({ enabled: true, start: '7:00', end: '08:00' })).toEqual({
      error: '时间请输入 HH:mm 格式',
    })
    expect(validateQuietHours({ enabled: false, start: '23:00', end: '24:00' })).toEqual({
      error: '时间请输入 HH:mm 格式',
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
      'MacBook Pro 已配好推送，App 不在前台也能收到。'
    )
    expect(pushFootnote({ status: 'notConfigured' }, 'A')).toContain('APNs / FCM')
    expect(pushFootnote({ status: 'permissionRequired' }, 'A')).toContain('系统设置')
    expect(pushFootnote({ status: 'unsupported' }, 'A')).toContain('登记不了')
    expect(pushFootnote({ status: 'error', error: 'offline' }, 'A')).toBe('offline')
    expect(pushFootnote({ status: 'error' }, 'A')).toContain('没能登记')
    expect(pushFootnote({ status: 'loading' }, 'A')).toBe('')
    expect(pushFootnote(undefined, undefined)).toBe('')
  })
})

describe('AI auto answer', () => {
  test('choices and labels follow the desktop timeout options', () => {
    expect(autoAnswerMinutes.map(autoAnswerLabel)).toEqual([
      '不代答',
      '1 分',
      '5 分',
      '10 分',
      '30 分',
    ])
    expect(autoAnswerValue({ enabled: true, timeoutMinutes: 5 })).toBe('等 5 分钟')
    expect(autoAnswerValue({ enabled: false, timeoutMinutes: 10 })).toBe('不代答')
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
    'MCP、技能与插件 · 服务商与 API Key · 官方账号登录 · IM 机器人 · 局域网和公网访问'
  )
})
