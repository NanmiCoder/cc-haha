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
    // 没有 canAskAgain 字段时按「还能问」处理，由系统决定要不要弹框
    expect(readNotificationPermission({ granted: false, status: 'denied' }).canAskAgain).toBe(true)
    // 安卓 13+ 没问过：系统报 denied 但还能问，设置页要说「未询问」，不能说「已关闭」
    expect(
      readNotificationPermission({ granted: false, status: 'denied', canAskAgain: true })
    ).toEqual({ status: 'undetermined', canAskAgain: true })
  })

  test('camera and photo rows say what the system allows', () => {
    expect(permissionLabel({ status: 'granted' })).toBe('已允许')
    expect(permissionLabel({ status: 'granted', accessPrivileges: 'all' })).toBe('已允许')
    expect(permissionLabel({ status: 'granted', accessPrivileges: 'limited' })).toBe('仅所选照片')
    expect(permissionLabel({ status: 'denied', accessPrivileges: 'none' })).toBe('未允许')
    expect(permissionLabel({ status: 'undetermined' })).toBe('未询问')
    expect(permissionLabel(null)).toBe('')
  })
})

describe('delivery card', () => {
  test('missing push build configuration is not blamed on computer connectivity or notification permission', () => {
    const push = { status: 'unsupported', issue: 'deviceNotConfigured' } as const
    const card = deliveryStatus(input({ push }))
    expect(card.title).toBe('此版本暂不支持后台推送')
    expect(card.rows[1].value).toBe('当前版本暂不支持')
    expect(deliveryNote(push)).toContain('无需重复修改手机通知权限')
    expect(deliveryNote(push)).not.toContain('检查连接')
    expect(card.actions.some((action) => action.kind === 'retry')).toBe(false)
  })

  test('temporary network and phone service failures offer a recheck with distinct explanations', () => {
    for (const issue of ['network', 'deviceUnavailable'] as const) {
      const push = { status: 'error', issue } as const
      expect(deliveryStatus(input({ push })).actions.some((action) => action.kind === 'retry')).toBe(true)
    }
    expect(deliveryNote({ status: 'error', issue: 'deviceUnavailable' })).toContain('手机暂时无法连接系统推送服务')
    expect(deliveryNote({ status: 'error', issue: 'authorization' })).toContain('授权已失效')
    expect(deliveryNote({ status: 'unsupported', issue: 'hostUnsupported' })).toContain('更新电脑端')
    expect(deliveryNote({ status: 'error', issue: 'storage' })).toContain('无法保存')
    expect(deliveryNote({ status: 'notConfigured' })).toContain('测试手机通知不能验证电脑推送')
  })

  test('everything on: leaving the app still gets reminders', () => {
    const card = deliveryStatus(input())
    expect(card.state).toBe('ok')
    expect(card.title).toBe('通知已就绪')
    expect(card.rows.map((row) => row.key)).toEqual(['system', 'push', 'live'])
    expect(values()).toEqual([
      '系统通知:已允许:ok',
      '电脑推送:MacBook Pro 已开启:ok',
      '锁屏实时活动:已开启:ok',
    ])
    expect(card.subtitle).toBe('离开 App 后也可接收电脑发来的提醒。')
    // 测试仅由详情里的按钮触发
    expect(card.actions).toEqual([
      { kind: 'test', label: '测试通知', look: 'secondary' },
    ])
    expect(card.guide).toBe(false)
  })

  test('iOS: lock screen not confirmed keeps the first two rings only in the subtitle', () => {
    const card = deliveryStatus(input({ decisions: false }))
    expect(card.state).toBe('ok')
    expect(card.subtitle).toBe('离开 App 后也可接收电脑发来的提醒。')
  })

  test('Android shows system and computer status without provider jargon', () => {
    const card = deliveryStatus(input({ platform: 'android' }))
    expect(card.rows.map((row) => row.key)).toEqual(['system', 'push'])
    expect(card.rows[1].value).toBe('MacBook Pro 已开启')
    expect(card.state).toBe('ok')
    expect(card.title).toBe('通知已就绪')
    expect(card.subtitle).toBe('离开 App 后也可接收电脑发来的提醒。')
    expect(card.actions).toEqual([{ kind: 'test', label: '测试通知', look: 'secondary' }])
  })

  test('system notifications denied: blocked, only the settings button remains', () => {
    const card = deliveryStatus(
      input({
        permission: { status: 'denied', canAskAgain: false },
        push: { status: 'permissionRequired' },
      })
    )
    expect(card.state).toBe('blocked')
    expect(card.title).toBe('通知未开启')
    expect(card.subtitle).toBe('开启系统通知，才能在离开 App 后收到提醒。')
    expect(values({ permission: { status: 'denied', canAskAgain: false }, push: { status: 'permissionRequired' } })).toEqual([
      '系统通知:已关闭:bad',
      '电脑推送:要先允许系统通知:warn',
      '锁屏实时活动:只在 App 打开时更新:off',
    ])
    expect(card.actions).toEqual([
      { kind: 'settings', label: '打开系统设置', look: 'primary' },
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

  test('never asked: offers 开启通知 and no test button', () => {
    const card = deliveryStatus(
      input({ permission: { status: 'undetermined', canAskAgain: true } })
    )
    expect(card.state).toBe('blocked')
    expect(card.subtitle).toBe('开启系统通知，才能在离开 App 后收到提醒。')
    expect(card.rows[0]).toMatchObject({ value: '还没开启', tone: 'warn' })
    expect(card.actions).toEqual([{ kind: 'request', label: '开启通知', look: 'primary' }])
  })

  test('desktop without APNs / FCM: blocked, shows the setup guide', () => {
    const card = deliveryStatus(input({ push: { status: 'notConfigured' } }))
    expect(card.state).toBe('blocked')
    expect(card.rows[1]).toMatchObject({ value: 'MacBook Pro 未设置', tone: 'warn' })
    expect(card.guide).toBe(true)
    // 系统通知是通的，测试按钮仍可用
    expect(card.actions[0].kind).toBe('test')
  })

  test('every push state has its own row text', () => {
    const row = (status: PushState) =>
      deliveryStatus(input({ push: { status } })).rows[1]
    expect(row('unsupported')).toMatchObject({ value: '这台设备暂不支持', tone: 'warn' })
    expect(row('error')).toMatchObject({ value: '连接失败', tone: 'bad' })
    expect(row('loading')).toMatchObject({ value: '检查中…', tone: 'off' })
    expect(deliveryStatus(input({ push: undefined })).rows[1].value).toBe('检查中…')
  })

  test('still reading state shows a neutral card instead of a verdict', () => {
    expect(deliveryStatus(input({ permission: null })).state).toBe('checking')
    expect(deliveryStatus(input({ push: { status: 'loading' } })).state).toBe('checking')
    // 系统通知已经确定没开时不必等推送
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
    expect(card.title).toBe('还未连接电脑')
    expect(card.subtitle).toBe('连接电脑后，可接收任务提醒。')
    expect(card.rows[1]).toMatchObject({ value: '还没连接电脑', tone: 'off' })
    expect(card.guide).toBe(false)
  })

  test('lock screen row is inferred only from what the app knows', () => {
    expect(values({ liveActivity: 'decisions' })[2]).toBe('锁屏实时活动:只在等你决定时:ok')
    expect(values({ decisions: false })[2]).toBe('锁屏实时活动:要我做决定已关闭:off')
    expect(
      values({ permission: { status: 'undetermined', canAskAgain: true } })[2]
    ).toBe('锁屏实时活动:只在 App 打开时更新:off')
  })

  test('footnotes: only failed or unsupported push needs an extra line', () => {
    expect(deliveryNote({ status: 'error', error: 'APNs 403' })).toBe('无法连接电脑推送，请检查连接后重试。')
    expect(deliveryNote({ status: 'error' })).toContain('检查连接')
    expect(deliveryNote({ status: 'unsupported' })).toContain('暂不支持电脑推送')
    expect(deliveryNote({ status: 'registered' })).toBe('')
    expect(deliveryNote(undefined)).toBe('')
    expect(remindFootnote({ status: 'denied', canAskAgain: false })).toContain('App 打开时')
    expect(remindFootnote({ status: 'undetermined', canAskAgain: true })).toContain('App 打开时')
    expect(remindFootnote(granted)).toBe('')
    expect(remindFootnote(null)).toBe('')
  })
})

describe('settings summaries and copy', () => {
  test('local fallback note says it only tests the system banner', () => {
    expect(testNotificationContent.title).toBe('测试通知 · cc-haha')
    expect(testNotificationNote).toContain('升级电脑端')
    expect(testNotificationNote).toContain('只测试手机通知，未验证电脑推送')
  })

  test('live activity row, computer count and version', () => {
    expect(liveActivityValue('running')).toBe('运行中也显示')
    expect(liveActivityValue('decisions')).toBe('只在等你决定时')
    expect(computersValue(2)).toBe('2 台')
    expect(versionLabel('0.1.1')).toBe('0.1.1')
    expect(versionLabel(undefined)).toBe('未知版本')
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
    expect(result.note).toContain('此版本暂不支持后台推送')
    expect(result.note).toContain('未验证电脑推送')
    expect(local).toBe(1)
    expect(remote).toBe(0)
  })

  const results = {
    sent: pushTestNote({ status: 'sent' }),
    notConfigured: pushTestNote({ status: 'notConfigured' }),
    noRegistration: pushTestNote({ status: 'noRegistration' }),
  }

  test('every server status has its own sentence', () => {
    expect(results.sent).toBe('电脑已发送测试通知，请回到手机主屏幕查看。')
    expect(results.notConfigured).toContain('电脑推送尚未设置')
    expect(results.noRegistration).toContain('电脑还未识别这台手机')
    expect(new Set(Object.values(results)).size).toBe(3)
    expect(pushTestNote({ status: 'failed', error: 'APNs 403' })).toBe('测试通知发送失败，请检查电脑推送设置后重试。')
    expect(pushTestNote({ status: 'failed' })).toContain('发送失败')
    expect(pushTestNote({ status: 'failed', error: '  ' })).toContain('发送失败')
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

  // 旧版电脑：局域网 POST 到 4 段路径回 405，公网白名单挡成 403，没有任何情况回 404。
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
    expect(outcome.note).not.toMatch(/Firebase|FCM|APNs|凭据/)
    expect(outcome.note).toContain('未验证电脑推送')
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
    expect(channelSummary({ importance: HIGH, sound: 'default' })).toBe('横幅 · 有声音')
    expect(channelSummary({ importance: MAX, sound: 'default' })).toBe('横幅 · 有声音')
    expect(channelSummary({ importance: HIGH, sound: null })).toBe('横幅')
    expect(channelSummary({ importance: DEFAULT, sound: 'default' })).toBe('有声音')
    expect(channelSummary({ importance: DEFAULT, sound: null })).toBe('静默')
    expect(channelSummary({ importance: LOW, sound: 'default' })).toBe('静默')
    expect(channelSummary({ importance: MIN, sound: null })).toBe('静默')
    expect(channelSummary({ importance: NONE, sound: 'default' })).toBe('已关闭')
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
      ['decisions', '要我做决定'],
      ['completed', '任务完成'],
      ['errors', '出错或卡住'],
    ])
    expect(channelFootnote).toBe('点选提醒类型，在系统设置中调整声音和震动。')
  })
})

describe('computer row title', () => {
  test('latin names keep the space, CJK names do not get a stray one', () => {
    expect(computerSettingsTitle('MacBook Pro')).toBe('MacBook Pro 的设置')
    expect(computerSettingsTitle('书房电脑')).toBe('书房电脑的设置')
    expect(computerSettingsTitle('我的Mac')).toBe('我的Mac 的设置')
    expect(computerSettingsTitle('  ')).toBe('这台电脑的设置')
    expect(computerSettingsTitle(undefined)).toBe('这台电脑的设置')
  })
})
