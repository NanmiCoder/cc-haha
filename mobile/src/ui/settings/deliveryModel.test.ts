import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  ANDROID_IMPORTANCE,
  aboutLinks,
  channelFootnote,
  channelRows,
  channelSummary,
  computerSettingsTitle,
  computersValue,
  deliveryNote,
  deliveryStatus,
  liveActivityValue,
  permissionLabel,
  pushTestNote,
  readNotificationPermission,
  remindFootnote,
  runTestNotification,
  testNotificationContent,
  noPushTokenNote,
  noHostTestNote,
  testNotificationNote,
  versionLabel,
  type DeliveryInput,
} from './deliveryModel'
import type { PushState } from './settingsModel'

const granted = { status: 'granted', canAskAgain: true } as const
const input = (patch: Partial<DeliveryInput> = {}): DeliveryInput => ({
  platform: 'ios',
  permission: granted,
  push: { status: 'registered' },
  hostName: 'MacBook Pro',
  hasHost: true,
  decisions: true,
  liveActivity: 'running',
  ...patch,
})
const values = (patch?: Partial<DeliveryInput>) =>
  deliveryStatus(input(patch)).rows.map((row) => `${row.label}:${row.value}:${row.tone}`)

describe('system permission mapping', () => {
  test('collapses expo responses into granted / denied / undetermined', () => {
    expect(readNotificationPermission({ granted: true, status: 'granted' })).toEqual(granted)
    expect(
      readNotificationPermission({ granted: false, status: 'undetermined', canAskAgain: true })
    ).toEqual({ status: 'undetermined', canAskAgain: true })
    expect(
      readNotificationPermission({ granted: false, status: 'denied', canAskAgain: false })
    ).toEqual({ status: 'denied', canAskAgain: false })
    // Without a canAskAgain field treat it as "can still ask" and let the system decide whether to prompt
    expect(readNotificationPermission({ granted: false, status: 'denied' }).canAskAgain).toBe(true)
    // Android 13+ not asked yet: the system reports denied but can still ask, so the settings page must say "Not asked", not "Off"
    expect(
      readNotificationPermission({ granted: false, status: 'denied', canAskAgain: true })
    ).toEqual({ status: 'undetermined', canAskAgain: true })
  })

  test('camera and photo rows say what the system allows', () => {
    expect(permissionLabel({ status: 'granted' })).toBe('Allowed')
    expect(permissionLabel({ status: 'granted', accessPrivileges: 'all' })).toBe('Allowed')
    expect(permissionLabel({ status: 'granted', accessPrivileges: 'limited' })).toBe('Selected photos only')
    expect(permissionLabel({ status: 'denied', accessPrivileges: 'none' })).toBe('Not allowed')
    expect(permissionLabel({ status: 'undetermined' })).toBe('Not asked')
    expect(permissionLabel(null)).toBe('')
  })
})

describe('delivery card', () => {
  test('missing push build configuration is not blamed on computer connectivity or notification permission', () => {
    const push = { status: 'unsupported', issue: 'deviceNotConfigured' } as const
    const card = deliveryStatus(input({ push }))
    expect(card.title).toBe('This version does not support background push yet')
    expect(card.rows[1].value).toBe('Not supported in this version yet')
    expect(deliveryNote(push)).toContain('No need to change phone notification permission again')
    expect(deliveryNote(push)).not.toContain('check the connection')
    expect(card.actions.some((action) => action.kind === 'retry')).toBe(false)
  })

  test('temporary network and phone service failures offer a recheck with distinct explanations', () => {
    for (const issue of ['network', 'deviceUnavailable'] as const) {
      const push = { status: 'error', issue } as const
      expect(deliveryStatus(input({ push })).actions.some((action) => action.kind === 'retry')).toBe(true)
    }
    expect(deliveryNote({ status: 'error', issue: 'deviceUnavailable' })).toContain('The phone cannot reach the system push service right now')
    expect(deliveryNote({ status: 'error', issue: 'authorization' })).toContain('authorization expired')
    expect(deliveryNote({ status: 'unsupported', issue: 'hostUnsupported' })).toContain('update the desktop app')
    expect(deliveryNote({ status: 'error', issue: 'storage' })).toContain('cannot save')
    expect(deliveryNote({ status: 'notConfigured' })).toContain('testing phone notifications cannot verify computer push')
  })

  test('everything on: leaving the app still gets reminders', () => {
    const card = deliveryStatus(input())
    expect(card.state).toBe('ok')
    expect(card.title).toBe('Notifications ready')
    expect(card.rows.map((row) => row.key)).toEqual(['system', 'push', 'live'])
    expect(values()).toEqual([
      'System notifications:Allowed:ok',
      'Computer push:Enabled on MacBook Pro:ok',
      'Lock screen Live Activities:Enabled:ok',
    ])
    expect(card.subtitle).toBe('You can receive alerts from the computer even after leaving the app.')
    // Tests are only triggered by the button in details
    expect(card.actions).toEqual([
      { kind: 'test', label: 'Test notification', look: 'secondary' },
    ])
    expect(card.guide).toBe(false)
  })

  test('iOS: lock screen not confirmed keeps the first two rings only in the subtitle', () => {
    const card = deliveryStatus(input({ decisions: false }))
    expect(card.state).toBe('ok')
    expect(card.subtitle).toBe('You can receive alerts from the computer even after leaving the app.')
  })

  test('Android shows system and computer status without provider jargon', () => {
    const card = deliveryStatus(input({ platform: 'android' }))
    expect(card.rows.map((row) => row.key)).toEqual(['system', 'push'])
    expect(card.rows[1].value).toBe('Enabled on MacBook Pro')
    expect(card.state).toBe('ok')
    expect(card.title).toBe('Notifications ready')
    expect(card.subtitle).toBe('You can receive alerts from the computer even after leaving the app.')
    expect(card.actions).toEqual([{ kind: 'test', label: 'Test notification', look: 'secondary' }])
  })

  test('system notifications denied: blocked, only the settings button remains', () => {
    const card = deliveryStatus(
      input({
        permission: { status: 'denied', canAskAgain: false },
        push: { status: 'permissionRequired' },
      })
    )
    expect(card.state).toBe('blocked')
    expect(card.title).toBe('Notifications off')
    expect(card.subtitle).toBe('Turn on system notifications to receive alerts after leaving the app.')
    expect(values({ permission: { status: 'denied', canAskAgain: false }, push: { status: 'permissionRequired' } })).toEqual([
      'System notifications:Off:bad',
      'Computer push:Allow system notifications first:warn',
      'Lock screen Live Activities:Updates only while the app is open:off',
    ])
    expect(card.actions).toEqual([
      { kind: 'settings', label: 'Open system settings', look: 'primary' },
    ])
  })

  test('denied but the system can still ask: request first, settings as the fallback', () => {
    const card = deliveryStatus(
      input({ permission: { status: 'denied', canAskAgain: true }, platform: 'android' })
    )
    expect(card.actions.map((action) => [action.kind, action.look])).toEqual([
      ['request', 'primary'],
      ['settings', 'plain'],
    ])
  })

  test('never asked: offers Turn on notifications and no test button', () => {
    const card = deliveryStatus(
      input({ permission: { status: 'undetermined', canAskAgain: true } })
    )
    expect(card.state).toBe('blocked')
    expect(card.subtitle).toBe('Turn on system notifications to receive alerts after leaving the app.')
    expect(card.rows[0]).toMatchObject({ value: 'Not turned on yet', tone: 'warn' })
    expect(card.actions).toEqual([{ kind: 'request', label: 'Turn on notifications', look: 'primary' }])
  })

  test('desktop without APNs / FCM: blocked, shows the setup guide', () => {
    const card = deliveryStatus(input({ push: { status: 'notConfigured' } }))
    expect(card.state).toBe('blocked')
    expect(card.rows[1]).toMatchObject({ value: 'MacBook Pro Not set up', tone: 'warn' })
    expect(card.guide).toBe(true)
    // System notifications work, so the test button is still available
    expect(card.actions[0].kind).toBe('test')
  })

  test('every push state has its own row text', () => {
    const row = (status: PushState) =>
      deliveryStatus(input({ push: { status } })).rows[1]
    expect(row('unsupported')).toMatchObject({ value: 'Not supported on this device yet', tone: 'warn' })
    expect(row('error')).toMatchObject({ value: 'Connection failed', tone: 'bad' })
    expect(row('loading')).toMatchObject({ value: 'Checking…', tone: 'off' })
    expect(deliveryStatus(input({ push: undefined })).rows[1].value).toBe('Checking…')
  })

  test('still reading state shows a neutral card instead of a verdict', () => {
    expect(deliveryStatus(input({ permission: null })).state).toBe('checking')
    expect(deliveryStatus(input({ push: { status: 'loading' } })).state).toBe('checking')
    // No need to wait for push when system notifications are definitely off
    expect(
      deliveryStatus(
        input({ permission: { status: 'denied', canAskAgain: false }, push: { status: 'loading' } })
      ).state
    ).toBe('blocked')
    expect(deliveryStatus(input({ permission: null })).actions).toEqual([])
  })

  test('no computer connected: cannot be reached', () => {
    const card = deliveryStatus(input({ hasHost: false, hostName: undefined, push: undefined }))
    expect(card.state).toBe('blocked')
    expect(card.title).toBe('No computer connected yet')
    expect(card.subtitle).toBe('Connect a computer to receive task alerts.')
    expect(card.rows[1]).toMatchObject({ value: 'No computer connected yet', tone: 'off' })
    expect(card.guide).toBe(false)
  })

  test('lock screen row is inferred only from what the app knows', () => {
    expect(values({ liveActivity: 'decisions' })[2]).toBe('Lock screen Live Activities:Only when waiting for your decision:ok')
    expect(values({ decisions: false })[2]).toBe('Lock screen Live Activities:“Needs my decision” is off:off')
    expect(
      values({ permission: { status: 'undetermined', canAskAgain: true } })[2]
    ).toBe('Lock screen Live Activities:Updates only while the app is open:off')
  })

  test('footnotes: only failed or unsupported push needs an extra line', () => {
    expect(deliveryNote({ status: 'error', error: 'APNs 403' })).toBe('Cannot reach computer push; check the connection and retry.')
    expect(deliveryNote({ status: 'error' })).toContain('check the connection')
    expect(deliveryNote({ status: 'unsupported' })).toContain('Computer push is not supported')
    expect(deliveryNote({ status: 'registered' })).toBe('')
    expect(deliveryNote(undefined)).toBe('')
    expect(remindFootnote({ status: 'denied', canAskAgain: false })).toContain('while the app is open')
    expect(remindFootnote({ status: 'undetermined', canAskAgain: true })).toContain('while the app is open')
    expect(remindFootnote(granted)).toBe('')
    expect(remindFootnote(null)).toBe('')
  })
})

describe('settings summaries and copy', () => {
  test('local fallback note says it only tests the system banner', () => {
    expect(testNotificationContent.title).toBe('Test notification · cc-haha')
    expect(testNotificationNote).toContain('update the desktop app')
    expect(testNotificationNote).toContain('This only tests phone notifications; computer push was not verified')
  })

  test('live activity row, computer count and version', () => {
    expect(liveActivityValue('running')).toBe('Also show while running')
    expect(liveActivityValue('decisions')).toBe('Only when waiting for your decision')
    expect(computersValue(2)).toBe('2 computers')
    expect(versionLabel('0.1.1')).toBe('0.1.1')
    expect(versionLabel(undefined)).toBe('Unknown version')
    expect(versionLabel('0.1.0', '12')).toBe('0.1.0 (12)')
    expect(versionLabel('0.1.0', null)).toBe('0.1.0')
  })

  test('about links point at the public repository', () => {
    for (const url of Object.values(aboutLinks))
      expect(url.startsWith('https://github.com/NanmiCoder/cc-haha')).toBe(true)
    expect(aboutLinks.issues.endsWith('/issues')).toBe(true)
    expect(aboutLinks.license.endsWith('/LICENSE')).toBe(true)
  })
})

describe('remote test notification', () => {
  test('a build missing push configuration only tests the phone and explains that limitation', async () => {
    let local = 0
    let remote = 0
    const result = await runTestNotification({
      hostId: 'fixture',
      getToken: async () => { throw { code: 'NOT_CONFIGURED' } },
      postTest: async () => { remote++; return { status: 'sent' } },
      scheduleLocal: async () => { local++ },
    })
    expect(result.via).toBe('local')
    expect(result.note).toContain('This version does not support background push yet')
    expect(result.note).toContain('computer push was not verified')
    expect(local).toBe(1)
    expect(remote).toBe(0)
  })

  const results = {
    sent: pushTestNote({ status: 'sent' }),
    notConfigured: pushTestNote({ status: 'notConfigured' }),
    noRegistration: pushTestNote({ status: 'noRegistration' }),
  }

  test('every server status has its own sentence', () => {
    expect(results.sent).toBe('The computer sent a test notification; a banner should appear at the top of the screen.')
    expect(results.notConfigured).toContain('Computer push is not set up yet')
    expect(results.noRegistration).toContain('The computer does not recognize this phone yet')
    expect(new Set(Object.values(results)).size).toBe(3)
    expect(pushTestNote({ status: 'failed', error: 'APNs 403' })).toBe('Test notification failed to send; check the computer push settings and retry.')
    expect(pushTestNote({ status: 'failed' })).toContain('failed to send')
    expect(pushTestNote({ status: 'failed', error: '  ' })).toContain('failed to send')
  })

  const deps = (overrides: Partial<Parameters<typeof runTestNotification>[0]> = {}) => {
    const calls: string[] = []
    return {
      calls,
      deps: {
        hostId: 'host-1',
        getToken: async () => {
          calls.push('token')
          return 'device-token'
        },
        postTest: async (body: { token: string; hostId: string }) => {
          calls.push(`post:${body.token}:${body.hostId}`)
          return { status: 'sent' as const }
        },
        scheduleLocal: async () => {
          calls.push('local')
        },
        ...overrides,
      },
    }
  }

  test('asks the desktop to push for real and does not fire a local notification', async () => {
    const { calls, deps: d } = deps()
    const outcome = await runTestNotification(d)
    expect(outcome).toEqual({ via: 'remote', note: results.sent })
    expect(calls).toEqual(['token', 'post:device-token:host-1'])
  })

  test('maps a non-sent server answer to its copy', async () => {
    const { deps: d } = deps({ postTest: async () => ({ status: 'notConfigured' }) })
    expect((await runTestNotification(d)).note).toBe(results.notConfigured)
  })

  // Older desktop versions: LAN POST to a 4-segment path returns 405, the public allowlist blocks with 403, and none return 404.
  for (const status of [404, 405, 403]) {
    test(`older desktops answer ${status}: fall back to a local banner and say so`, async () => {
      const { calls, deps: d } = deps({
        postTest: async () => {
          throw Object.assign(new Error('Unsupported'), { status })
        },
      })
      const outcome = await runTestNotification(d)
      expect(outcome).toEqual({ via: 'local', note: testNotificationNote })
      expect(calls).toEqual(['token', 'local'])
    })
  }

  test('no system push token (build without FCM): local banner with an honest Chinese note, no raw native error', async () => {
    const { calls, deps: d } = deps({
      getToken: async () => {
        throw new Error('Unable to get Firebase Messaging instance. Did you configure googleServicesFile')
      },
    })
    const outcome = await runTestNotification(d)
    expect(outcome).toEqual({ via: 'local', note: noPushTokenNote })
    expect(outcome.note).not.toMatch(/Firebase|FCM|APNs|credential/)
    expect(outcome.note).toContain('computer push was not verified')
    expect(calls).toEqual(['local'])
  })

  test('other failures surface instead of pretending the local banner proves delivery', async () => {
    const { calls, deps: d } = deps({
      postTest: async () => {
        throw Object.assign(new Error('boom'), { status: 500 })
      },
    })
    await expect(runTestNotification(d)).rejects.toThrow('boom')
    expect(calls).not.toContain('local')
    const offline = deps({
      postTest: async () => {
        throw new Error('offline')
      },
    })
    await expect(runTestNotification(offline.deps)).rejects.toThrow('offline')
    expect(offline.calls).not.toContain('local')
  })

  test('no computer connected: only the local banner is possible', async () => {
    const { calls, deps: d } = deps({ hostId: undefined })
    expect(await runTestNotification(d)).toEqual({ via: 'local', note: noHostTestNote })
    expect(calls).toEqual(['local'])
  })
})

describe('android channel rows', () => {
  test('importance and sound read as one phrase', () => {
    const { NONE, MIN, LOW, DEFAULT, HIGH, MAX } = ANDROID_IMPORTANCE
    expect(channelSummary({ importance: HIGH, sound: 'default' })).toBe('Banner · with sound')
    expect(channelSummary({ importance: MAX, sound: 'default' })).toBe('Banner · with sound')
    expect(channelSummary({ importance: HIGH, sound: null })).toBe('Banner')
    expect(channelSummary({ importance: DEFAULT, sound: 'default' })).toBe('With sound')
    expect(channelSummary({ importance: DEFAULT, sound: null })).toBe('Silent')
    expect(channelSummary({ importance: LOW, sound: 'default' })).toBe('Silent')
    expect(channelSummary({ importance: MIN, sound: null })).toBe('Silent')
    expect(channelSummary({ importance: NONE, sound: 'default' })).toBe('Off')
    expect(channelSummary(null)).toBe('')
    expect(channelSummary(undefined)).toBe('')
  })

  test('importance numbers match the installed expo-notifications enum', () => {
    const source = readFileSync(
      new URL(
        '../../../node_modules/expo-notifications/build/NotificationChannelManager.types.js',
        import.meta.url
      ),
      'utf8'
    )
    for (const [name, value] of Object.entries(ANDROID_IMPORTANCE))
      expect(source).toContain(`AndroidImportance["${name}"] = ${value}]`)
  })

  test('the three rows follow the mockup order and copy', () => {
    expect(channelRows.map((row) => [row.kind, row.title])).toEqual([
      ['decisions', 'Needs my decision'],
      ['completed', 'Task finished'],
      ['errors', 'Error or stuck'],
    ])
    expect(channelFootnote).toBe('Tap an alert type to adjust sound and vibration in system settings.')
  })
})

describe('computer row title', () => {
  test('the computer name is followed by “settings”', () => {
    expect(computerSettingsTitle('MacBook Pro')).toBe('MacBook Pro settings')
    expect(computerSettingsTitle(' Study computer ')).toBe('Study computer settings')
    expect(computerSettingsTitle('  ')).toBe('This computer’s settings')
    expect(computerSettingsTitle(undefined)).toBe('This computer’s settings')
  })
})

describe('Android background connection (pull from the computer)', () => {
  const android = (duty: DeliveryInput['duty']) => input({ platform: 'android', push: { status: 'registered' }, duty })
  const healthy = { running: true, connected: true, batteryOptimizationIgnored: true }
  test('is reported as its own row and only ready while the service runs', () => {
    expect(values({ platform: 'android' })).toEqual(['System notifications:Allowed:ok', 'Computer push:Enabled on MacBook Pro:ok'])
    expect(deliveryStatus(android(null)).state).toBe('checking')
    expect(deliveryStatus(android(healthy))).toMatchObject({ state: 'ok', title: 'Notifications ready' })
    expect(deliveryStatus(android(healthy)).rows.at(-1)).toEqual({ key: 'background', label: 'Background connection', value: 'Connected', tone: 'ok' })
    const stopped = deliveryStatus(android({ ...healthy, running: false }))
    expect(stopped).toMatchObject({ state: 'blocked', title: 'Background connection not running' })
    expect(stopped.rows.at(-1)?.tone).toBe('bad')
    expect(deliveryStatus(android({ ...healthy, connected: false })).rows.at(-1)?.value).toBe('Connecting to computer')
  })
  test('asks for the battery exemption until granted and always offers the vendor settings', () => {
    const limited = deliveryStatus(android({ ...healthy, batteryOptimizationIgnored: false }))
    expect(limited.rows.at(-1)).toMatchObject({ value: 'Connected, restricted by battery saver', tone: 'warn' })
    expect(limited.actions.map((action) => action.kind)).toEqual(['test', 'battery', 'appSettings'])
    expect(deliveryStatus(android(healthy)).actions.map((action) => action.kind)).toEqual(['test', 'appSettings'])
    expect(deliveryStatus(input()).actions.map((action) => action.kind)).toEqual(['test'])
  })
  test('explains the persistent notification and vendor autostart only for this channel', () => {
    expect(deliveryNote({ status: 'registered' }, healthy)).toContain('On duty')
    expect(deliveryNote({ status: 'registered' }, healthy)).toContain('autostart')
    expect(deliveryNote({ status: 'registered' })).toBe('')
  })
})

describe('iPhone alerts the computer could not send through Expo', () => {
  const failing = { status: 'registered', issue: 'relayFailing', error: 'The computer cannot reach the Expo push service (exp.host)' } as const
  test('the card stops claiming alerts are ready and offers a fresh check', () => {
    const card = deliveryStatus(input({ push: failing }))
    expect(card).toMatchObject({ state: 'blocked', title: 'Push delivery failed' })
    expect(card.rows.find((row) => row.key === 'push')).toMatchObject({ value: 'Last send failed', tone: 'bad' })
    expect(card.actions.map((action) => action.kind)).toEqual(['test', 'retry'])
    expect(deliveryStatus(input()).state).toBe('ok')
  })
  test('the note names the cause and the proxy setting that fixes it', () => {
    const note = deliveryNote(failing)
    expect(note).toContain('The computer cannot reach the Expo push service (exp.host)')
    expect(note).toContain('configure a network proxy in Settings → General')
  })
})
