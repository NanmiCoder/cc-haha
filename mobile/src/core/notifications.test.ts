import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { migratePreferences } from '../state/preferences'
import {
  NOTIFICATION_COPY,
  decisionLabel,
  notificationEvents,
  notificationRequestTarget,
  notificationTarget,
  routeNotificationResponse,
  type NotificationTarget,
} from './notifications'
const prefs = migratePreferences(null)
// Direct APNs shape observed in the real plan notification. Expo 58 iOS maps
// userInfo.body to content.data and preserves the entire userInfo in trigger.payload.
const planPayload = {
  aps: { alert: { title: '测试任务', body: '需要确认计划' }, category: 'cchahaDecision' },
  hostId: 'known-host',
  sessionId: 'plan-session',
  requestId: 'pending-plan',
  eventType: 'decision',
}
test('direct APNs plan tap resolves the session from Expo iOS push trigger payload', () => {
  for (const data of [null, undefined, {}]) {
    expect(notificationRequestTarget({
      identifier: 'apns-plan',
      content: { data },
      trigger: { type: 'push', payload: planPayload },
    }, 'expo.modules.notifications.actions.DEFAULT', new Set(['known-host']))).toEqual({
      hostId: 'known-host',
      sessionId: 'plan-session',
      requestId: 'pending-plan',
      action: undefined,
    })
  }
})
test('fixture matches the installed Expo iOS remote serializer contract', () => {
  const swift = readFileSync(new URL(
    '../../node_modules/expo-notifications/ios/ExpoNotifications/Notifications/NotificationRecords.swift',
    import.meta.url
  ), 'utf8')
  expect(swift).toContain('self.payload = .value(unwrapped: request.content.userInfo)')
  expect(swift).toMatch(/if isRemote\s*\{\s*return request\.content\.userInfo\["body"\] as\? \[String: Any\]/)
})
test('local and FCM content data retain the same routing and exact action', () => {
  for (const trigger of [null, { type: 'push', remoteMessage: { data: planPayload } }]) {
    expect(notificationRequestTarget({
      identifier: 'known-data',
      content: { data: planPayload },
      trigger,
    }, 'allow', new Set(['known-host']))).toEqual({
      hostId: 'known-host',
      sessionId: 'plan-session',
      requestId: 'pending-plan',
      action: 'allow',
    })
  }
})
test('raw payload fallback cannot override explicit data or mix routing fields', () => {
  for (const data of [
    { ...planPayload, hostId: 'removed-host' },
    { hostId: 'known-host' },
    { sessionId: 'other-session', requestId: 'other-request' },
    'invalid',
    [],
  ]) {
    expect(notificationRequestTarget({
      identifier: 'conflicting-data',
      content: { data },
      trigger: { type: 'push', payload: planPayload },
    }, 'allow', new Set(['known-host']))).toBeNull()
  }
})
test('only a real push trigger may supply fallback data and known hosts remain required', () => {
  for (const trigger of [
    null,
    { type: 'calendar', payload: planPayload },
    { type: 'push', payload: [] },
    { type: 'push', payload: JSON.stringify(planPayload) },
    { type: 'push', payload: { ...planPayload, hostId: 'unknown-host' } },
    { type: 'push', payload: { ...planPayload, sessionId: '' } },
  ]) {
    expect(notificationRequestTarget({
      identifier: 'invalid-fallback',
      content: { data: null },
      trigger,
    }, 'allow', new Set(['known-host']))).toBeNull()
  }
  expect(notificationRequestTarget({
    identifier: 'missing-request',
    content: { data: null },
    trigger: { type: 'push', payload: { ...planPayload, requestId: undefined } },
  }, 'allow', new Set(['known-host']))?.action).toBeUndefined()
})
test('cold-start responses wait for readiness and cached/listener replay opens only once', () => {
  const response = {
    actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
    notification: { request: {
      identifier: 'cold-plan',
      content: { data: null },
      trigger: { type: 'push', payload: planPayload },
    } },
  }
  const opened: NotificationTarget[] = []
  const options = { ready: false, hostIds: new Set(['known-host']), handled: new Set<string>(), open: (target: NotificationTarget) => opened.push(target) }
  expect(routeNotificationResponse(response, options)).toBe(false)
  expect(options.handled.size).toBe(0)
  expect(opened).toEqual([])
  options.ready = true
  expect(routeNotificationResponse(response, options)).toBe(true)
  expect(routeNotificationResponse(response, options)).toBe(false)
  expect(opened).toEqual([{ hostId: 'known-host', sessionId: 'plan-session', requestId: 'pending-plan', action: undefined }])
})
test('a removed host or failed navigation does not consume the cached response', () => {
  const response = {
    actionIdentifier: 'deny',
    notification: { request: {
      identifier: 'retry-tool',
      content: { data: planPayload },
      trigger: null,
    } },
  }
  const options = { ready: true, hostIds: new Set<string>(), handled: new Set<string>(), open: () => { throw new Error('navigation unavailable') } }
  expect(routeNotificationResponse(response, options)).toBe(false)
  expect(options.handled.size).toBe(0)
  options.hostIds.add('known-host')
  expect(() => routeNotificationResponse(response, options)).toThrow('navigation unavailable')
  expect(options.handled.size).toBe(0)
  const opened: NotificationTarget[] = []
  expect(routeNotificationResponse(response, { ...options, open: (target) => opened.push(target) })).toBe(true)
  expect(opened[0].action).toBe('deny')
  expect(opened[0].requestId).toBe('pending-plan')
})
test('only new real waiting requests alert, questions never get tool allow actions', () => {
  const request = {
    id: 's',
    activityState: 'waiting' as const,
    requestId: 'r',
    toolName: 'AskUserQuestion',
  }
  expect(
    notificationEvents(null, [request], prefs, new Date())[0].category
  ).toBe('cchahaDecision')
  expect(notificationEvents([request], [request], prefs, new Date())).toEqual(
    []
  )
  expect(
    notificationEvents(
      [request],
      [{ ...request, requestId: 'r2', toolName: 'Bash' }],
      prefs,
      new Date()
    )[0].category
  ).toBe('cchahaTool')
})
test('hiding the command on the lock screen also hides the Bash command in local fallback banners', () => {
  const bash = {
    id: 's',
    activityState: 'waiting' as const,
    requestId: 'r',
    toolName: 'Bash',
    preview: 'curl http://secret.example',
  }
  const shown = notificationEvents(null, [bash], prefs, new Date())[0]
  expect(shown.preview).toContain('curl http://secret.example')
  const hidden = notificationEvents(
    null,
    [bash],
    { ...prefs, liveActivityShowCommand: false },
    new Date()
  )[0]
  expect(hidden.preview).toBe('想运行命令')
  const question = notificationEvents(
    null,
    [{ ...bash, toolName: 'AskUserQuestion', preview: '要用哪个分支？' }],
    { ...prefs, liveActivityShowCommand: false },
    new Date()
  )[0]
  expect(question.preview).toContain('要用哪个分支？')
})
test('completed alerts require new durable success evidence after the initial baseline', () => {
  const success = { id: 's', activityState: 'idle' as const, terminalOutcome: 'completed' as const, completedAt: 100 }
  expect(
    notificationEvents(
      null,
      [success],
      prefs,
      new Date()
    )
  ).toEqual([])
  expect(
    notificationEvents(
      [{ id: 's', activityState: 'waiting' }],
      [{ id: 's', activityState: 'idle' }],
      prefs,
      new Date()
    )
  ).toEqual([])
  expect(
    notificationEvents(
      [{ id: 's', activityState: 'running' }],
      [success],
      prefs,
      new Date()
    )[0].kind
  ).toBe('completed')
  expect(notificationEvents([success], [success], prefs, new Date())).toEqual([])
  expect(notificationEvents([{ id: 's', activityState: 'idle' }], [success], prefs, new Date())[0]?.kind).toBe('completed')
  for (const terminal of [
    { id: 's', activityState: 'idle' as const },
    { id: 's', activityState: 'idle' as const, terminalOutcome: 'stopped' as const },
    { id: 's', activityState: 'idle' as const, completedAt: 100 },
  ]) expect(notificationEvents([{ id: 's', activityState: 'running' }], [terminal], prefs, new Date())).toEqual([])
  expect(notificationEvents([{ id: 's', activityState: 'running' }], [], prefs, new Date())).toEqual([])
})
test('stalled alerts follow the actual progress clock and do not repeat each poll', () => {
  const running = {
    id: 's',
    activityState: 'running' as const,
    lastProgressAt: 100,
  }
  const stalled = { ...running, stalled: true }
  expect(
    notificationEvents([running], [stalled], prefs, new Date())[0]?.kind
  ).toBe('error')
  expect(notificationEvents([stalled], [stalled], prefs, new Date())).toEqual(
    []
  )
  expect(
    notificationEvents(
      [running],
      [stalled],
      { ...prefs, notifications: { ...prefs.notifications, errors: false } },
      new Date()
    )
  ).toEqual([])
  expect(
    notificationEvents(
      [stalled],
      [{ ...running, lastProgressAt: 200 }],
      prefs,
      new Date()
    )
  ).toEqual([])
})
test('quiet hours and notification toggles suppress notifications', () => {
  const p = migratePreferences(
    '{"quietHours":{"enabled":true,"start":"23:00","end":"08:00"}}'
  )
  expect(
    notificationEvents(
      null,
      [{ id: 's', activityState: 'waiting' }],
      p,
      new Date(2026, 9, 24, 1)
    )
  ).toEqual([])
  p.quietHours.enabled = false
  p.notifications.decisions = false
  expect(
    notificationEvents(
      null,
      [{ id: 's', activityState: 'waiting' }],
      p,
      new Date()
    )
  ).toEqual([])
})
test('notification actions remain scoped to a known host and exact request', () => {
  expect(
    notificationTarget(
      { hostId: 'other', sessionId: 's', requestId: 'r' },
      'allow',
      new Set(['a'])
    )
  ).toBeNull()
  expect(
    notificationTarget({ hostId: 'a', sessionId: 's' }, 'allow', new Set(['a']))
  ).toEqual({
    hostId: 'a',
    sessionId: 's',
    requestId: undefined,
    action: undefined,
  })
  expect(
    notificationTarget(
      { hostId: 'a', sessionId: 's', requestId: 'r' },
      'allow',
      new Set(['a'])
    )?.action
  ).toBe('allow')
})
test('decision notifications share one voice and only quote previews the server really projects', () => {
  const event = (toolName: string | undefined, preview?: string) =>
    notificationEvents(
      null,
      [{ id: 's', activityState: 'waiting', requestId: 'r', toolName, preview }],
      prefs,
      new Date()
    )[0]
  expect(event('Bash', 'bun test src/core')).toMatchObject({
    preview: '想运行 bun test src/core',
    category: 'cchahaTool',
  })
  expect(event('AskUserQuestion', '旧字段怎么处理？')).toMatchObject({
    preview: '在问你：旧字段怎么处理？',
    category: 'cchahaDecision',
  })
  expect(event('ExitPlanMode', '计划等待确认')).toMatchObject({
    preview: '计划写好了，等你确认',
    category: 'cchahaDecision',
  })
  // Non-Bash previews are generic server placeholders and are not quoted.
  expect(event('Edit', '等待工具权限确认').preview).toBe('想修改文件，等你确认')
  expect(event('PowerShell', '等待工具权限确认').preview).toBe('想运行命令，等你确认')
  expect(event('ComputerUse', '等待电脑操作权限确认')).toMatchObject({
    preview: '想操作电脑，等你允许',
    category: 'cchahaDecision',
  })
  expect(event(undefined).preview).toBe('需要你做决定')
  expect(event('Bash', '  ').preview).toBe('想运行命令')
  expect(decisionLabel('mcp__x__y')).toBe('想使用 mcp__x__y')
})
test('result notifications use the same plain wording', () => {
  expect(
    notificationEvents([{ id: 's', activityState: 'running' }], [{ id: 's', activityState: 'failed' }], prefs, new Date())[0].preview
  ).toBe(NOTIFICATION_COPY.failed)
  expect(
    notificationEvents(
      [{ id: 's', activityState: 'running', lastProgressAt: 1 }],
      [{ id: 's', activityState: 'running', lastProgressAt: 1, stalled: true }],
      prefs,
      new Date()
    )[0].preview
  ).toBe(NOTIFICATION_COPY.stalled)
  expect(
    notificationEvents(
      [{ id: 's', activityState: 'running' }],
      [{ id: 's', activityState: 'idle', terminalOutcome: 'completed', completedAt: 100 }],
      prefs,
      new Date()
    )[0].preview
  ).toBe(NOTIFICATION_COPY.completed)
})
