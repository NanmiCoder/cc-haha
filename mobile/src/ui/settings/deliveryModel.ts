import { classifyPermission } from '../../state/notifyPromptGate'
import type { LiveActivityMode } from '../../state/preferences'
import type { PushState } from './settingsModel'
import type { PushIssue } from '../../state/PushRegistrationContext'

/** 系统通知权限；null 表示还没读到。 */
export type NotificationPermission = 'granted' | 'denied' | 'undetermined'
export type PermissionSnapshot = {
  status: NotificationPermission
  /** 系统是否还会弹出授权框；iOS 拒绝后恒为 false。 */
  canAskAgain: boolean
}

/** 把 expo-notifications 的返回值收成三态：provisional 等已授予的情况也算 granted。 */
export function readNotificationPermission(response: {
  granted: boolean
  status?: string
  canAskAgain?: boolean
}): PermissionSnapshot {
  // 与通知引导页共用同一个分类器：安卓没问过时报 denied 但 canAskAgain 仍为 true，那是「未询问」。
  const status = classifyPermission({
    granted: response.granted,
    status: response.status ?? 'denied',
    canAskAgain: response.canAskAgain,
  })
  return { status, canAskAgain: status === 'granted' || response.canAskAgain !== false }
}

export type RowTone = 'ok' | 'warn' | 'bad' | 'off'
export type DeliveryRow = {
  key: 'system' | 'push' | 'live'
  label: string
  value: string
  tone: RowTone
}
export type DeliveryAction = {
  kind: 'request' | 'settings' | 'test' | 'retry'
  label: string
  /** primary=墨色主按钮，secondary=灰底按钮，plain=无底文字按钮。 */
  look: 'primary' | 'secondary' | 'plain'
}
export type Delivery = {
  /** checking=还在读状态，ok=离开 App 也能收到，blocked=离开 App 收不到。 */
  state: 'checking' | 'ok' | 'blocked'
  title: string
  subtitle: string
  rows: DeliveryRow[]
  actions: DeliveryAction[]
  /** 电脑还没配推送时，卡片底部多一条指向配置说明的文字链。 */
  guide: boolean
}

export type DeliveryInput = {
  platform: 'ios' | 'android'
  permission: PermissionSnapshot | null
  push: { status: PushState; error?: string; issue?: PushIssue } | undefined
  /** 没有已连接的电脑时为 undefined。 */
  hostName: string | undefined
  hasHost: boolean
  decisions: boolean
  liveActivity: LiveActivityMode
}

function systemRow(permission: PermissionSnapshot | null): DeliveryRow {
  const base = { key: 'system', label: '系统通知' } as const
  if (!permission) return { ...base, value: '检查中…', tone: 'off' }
  if (permission.status === 'granted') return { ...base, value: '已允许', tone: 'ok' }
  if (permission.status === 'undetermined')
    return { ...base, value: '还没开启', tone: 'warn' }
  return { ...base, value: '已关闭', tone: 'bad' }
}

function pushRow(input: DeliveryInput): DeliveryRow {
  const base = { key: 'push', label: '电脑推送' } as const
  if (!input.hasHost) return { ...base, value: '还没连接电脑', tone: 'off' }
  const name = input.hostName ?? '这台电脑'
  if (input.push?.issue === 'deviceNotConfigured')
    return { ...base, value: '当前版本暂不支持', tone: 'warn' }
  if (input.push?.issue === 'deviceUnavailable')
    return { ...base, value: '手机推送服务暂不可用', tone: 'warn' }
  if (input.push?.issue === 'hostUnsupported')
    return { ...base, value: '需更新电脑端', tone: 'warn' }
  if (input.push?.issue === 'authorization')
    return { ...base, value: '需重新连接电脑', tone: 'warn' }
  if (input.push?.issue === 'storage')
    return { ...base, value: '登记信息无法保存', tone: 'bad' }
  switch (input.push?.status) {
    case 'registered':
      return {
        ...base,
        value: `${name} 已开启`,
        tone: 'ok',
      }
    case 'notConfigured':
      return { ...base, value: `${name} 未设置`, tone: 'warn' }
    case 'permissionRequired':
      return { ...base, value: '要先允许系统通知', tone: 'warn' }
    case 'unsupported':
      return { ...base, value: '这台设备暂不支持', tone: 'warn' }
    case 'error':
      return { ...base, value: '连接失败', tone: 'bad' }
    default:
      return { ...base, value: '检查中…', tone: 'off' }
  }
}

/**
 * 锁屏实时活动只能按 App 自己知道的推断：系统通知没开、或「要我做决定」关着就不会有；
 * 系统设置里的「实时活动」总开关 JS 读不到，所以这里不声称它一定开着。
 */
export function liveActivityRow(input: DeliveryInput): DeliveryRow {
  const base = { key: 'live', label: '锁屏实时活动' } as const
  if (input.permission?.status !== 'granted')
    return { ...base, value: '只在 App 打开时更新', tone: 'off' }
  if (!input.decisions) return { ...base, value: '要我做决定已关闭', tone: 'off' }
  return {
    ...base,
    value: input.liveActivity === 'decisions' ? '只在等你决定时' : '已开启',
    tone: 'ok',
  }
}

export function deliveryStatus(input: DeliveryInput): Delivery {
  const system = systemRow(input.permission)
  const push = pushRow(input)
  const rows: DeliveryRow[] = [system, push]
  if (input.platform === 'ios') rows.push(liveActivityRow(input))

  const permission = input.permission
  const actions: DeliveryAction[] = []
  if (permission?.status === 'undetermined')
    actions.push({ kind: 'request', label: '开启通知', look: 'primary' })
  else if (permission?.status === 'denied') {
    if (permission.canAskAgain)
      actions.push({ kind: 'request', label: '开启通知', look: 'primary' })
    actions.push({
      kind: 'settings',
      label: '打开系统设置',
      look: permission.canAskAgain ? 'plain' : 'primary',
    })
  } else if (permission?.status === 'granted')
    actions.push({
      kind: 'test',
      label: '测试通知',
      look: 'secondary',
    })
  if (permission?.status === 'granted' && input.hasHost &&
    (input.push?.status === 'notConfigured' || (input.push?.status === 'error' &&
      input.push.issue !== 'authorization' && input.push.issue !== 'storage')))
    actions.push({ kind: 'retry', label: '重新检查', look: 'plain' })

  const guide = input.hasHost && input.push?.status === 'notConfigured'
  // 系统通知没开时结论已定，不必等推送登记；已允许才要等登记结果。
  const checking =
    !permission ||
    (permission.status === 'granted' &&
      input.hasHost &&
      (!input.push || input.push.status === 'loading'))
  if (checking)
    return {
      state: 'checking',
      title: '正在检查通知',
      subtitle: '正在获取系统权限和电脑推送状态。',
      rows,
      actions,
      guide,
    }
  if (permission?.status === 'granted' && input.push?.status === 'registered')
    return {
      state: 'ok',
      title: '通知已就绪',
      subtitle: '离开 App 后也可接收电脑发来的提醒。',
      rows,
      actions,
      guide,
    }
  return {
    state: 'blocked',
    title:
      permission.status !== 'granted'
        ? '通知未开启'
        : !input.hasHost
          ? '还未连接电脑'
          : input.push?.issue === 'deviceNotConfigured'
            ? '此版本暂不支持后台推送'
          : input.push?.status === 'notConfigured'
            ? '电脑推送未设置'
            : '推送暂不可用',
    subtitle:
      permission.status !== 'granted'
        ? '开启系统通知，才能在离开 App 后收到提醒。'
        : !input.hasHost
          ? '连接电脑后，可接收任务提醒。'
          : '暂时只能在 App 内查看提醒。',
    rows,
    actions,
    guide,
  }
}

/** 卡片下的补充说明：只有登记失败、设备不支持这两种需要多说一句。 */
export function deliveryNote(
  push: DeliveryInput['push']
) {
  if (push?.issue === 'deviceNotConfigured')
    return '此版本暂不支持后台推送，请在 App 内查看任务提醒。无需重复修改手机通知权限。'
  if (push?.issue === 'deviceUnavailable')
    return '手机暂时无法连接系统推送服务，请检查网络后重新检查。'
  if (push?.issue === 'authorization')
    return '电脑连接授权已失效，请在「你的电脑」中重新连接。'
  if (push?.issue === 'hostUnsupported')
    return '这台电脑的版本不支持推送登记，请更新电脑端。'
  if (push?.issue === 'storage')
    return '手机无法保存推送登记信息，请重启 App 后重新检查。'
  if (push?.issue === 'unknown')
    return '推送登记未完成，请重新检查。'
  if (push?.status === 'notConfigured')
    return '这台电脑尚未启用推送服务。目前可在 App 内查看提醒，测试手机通知不能验证电脑推送。'
  if (push?.status === 'error') return '无法连接电脑推送，请检查连接后重试。'
  if (push?.status === 'unsupported') return '当前设备或安装版本暂不支持电脑推送。'
  return ''
}

/** 「提醒我」下的脚注：系统通知没开时，开关只管 App 打开时的提醒。 */
export function remindFootnote(permission: PermissionSnapshot | null) {
  return permission && permission.status !== 'granted'
    ? '系统通知关着时，这几项只决定 App 打开时要不要提醒你。'
    : ''
}

export const TEST_NOTIFICATION_DELAY_SECONDS = 5

/** 本地测试通知：延迟几秒再发，留时间回到主屏幕（前台时 App 不弹横幅）。 */
export const testNotificationContent = {
  title: '测试通知 · cc-haha',
  body: '看到这条，说明这台手机的系统通知正常。',
  data: { kind: 'test' },
}

/** 电脑还不支持远程测试（旧版桌面没有接口）时退回本地通知，要说清它只测了系统横幅。 */
const localTestInstruction = `请回到手机主屏幕，${TEST_NOTIFICATION_DELAY_SECONDS} 秒后查看通知。此次只测试手机通知，未验证电脑推送。`
export const noPushTokenNote = `暂时无法测试电脑推送。${localTestInstruction}`
export const testNotificationNote = `请升级电脑端后再测试推送。${localTestInstruction}`
export const noHostTestNote = `还未连接电脑。${localTestInstruction}`

/** `POST /api/sessions/mobile-push/test` 的返回。 */
export type PushTestResult = {
  status: 'sent' | 'notConfigured' | 'noRegistration' | 'failed'
  error?: string
}

/** 把电脑的测试结果翻成一句话；未知状态按失败处理，不假装成功。 */
export function pushTestNote(result: PushTestResult): string {
  switch (result.status) {
    case 'sent':
      return '电脑已发送测试通知，请回到手机主屏幕查看。'
    case 'notConfigured':
      return '电脑推送尚未设置，请查看「推送设置说明」。'
    case 'noRegistration':
      return '电脑还未识别这台手机，请重新连接后再试。'
    default:
      return '测试通知发送失败，请检查电脑推送设置后重试。'
  }
}

export type TestNotificationOutcome = {
  /** remote=经电脑真实推送，local=只发了本地通知。 */
  via: 'remote' | 'local'
  note: string
}

/** 旧版电脑没有测试接口时的三种回答：404 无路由、405 局域网方法不允许、403 公网白名单拒绝。 */
const oldDesktopStatuses = [404, 405, 403]

/**
 * 「发一条测试通知」：优先让电脑经 APNs / FCM 真发一条；旧版电脑没有这个接口时
 * 退回本地通知。其余错误（断网、凭据）原样抛出，不拿本地通知冒充成功。
 */
export async function runTestNotification(deps: {
  getToken(): Promise<string>
  postTest(body: { token: string; hostId: string }): Promise<PushTestResult>
  scheduleLocal(): Promise<void>
  hostId: string | undefined
}): Promise<TestNotificationOutcome> {
  if (!deps.hostId) {
    await deps.scheduleLocal()
    return { via: 'local', note: noHostTestNote }
  }
  let token: string
  try {
    token = await deps.getToken()
  } catch (error) {
    // 拿不到系统推送凭据（没配 FCM / APNs 的安装包、模拟器、断网）：电脑那条链路没法测，
    // 只测本机横幅，并如实说明，不把原生层的英文报错甩给用户。
    await deps.scheduleLocal()
    if ((error as { code?: string } | null)?.code === 'NOT_CONFIGURED')
      return { via: 'local', note: `此版本暂不支持后台推送。${localTestInstruction}` }
    return { via: 'local', note: noPushTokenNote }
  }
  try {
    const result = await deps.postTest({ token, hostId: deps.hostId })
    return { via: 'remote', note: pushTestNote(result) }
  } catch (error) {
    const status = (error as { status?: number } | null)?.status
    if (!status || !oldDesktopStatuses.includes(status)) throw error
    await deps.scheduleLocal()
    return { via: 'local', note: testNotificationNote }
  }
}

/** expo-notifications 的 AndroidImportance 数值（NONE=2 … MAX=7，与系统自身的 0–5 不同）。 */
export const ANDROID_IMPORTANCE = {
  NONE: 2,
  MIN: 3,
  LOW: 4,
  DEFAULT: 5,
  HIGH: 6,
  MAX: 7,
} as const

/**
 * 「声音和震动」行右侧的一句话。用户在系统里改过的重要程度和声音都以系统为准：
 * 横幅 = 重要程度高（弹出）；静默 = 低或最低；已关闭 = 渠道被关掉。
 * 读不到渠道（还没创建、旧系统）返回空串，行上不显示值。
 */
export function channelSummary(
  channel: { importance: number; sound: string | null } | null | undefined
): string {
  if (!channel) return ''
  const { importance } = channel
  if (importance === ANDROID_IMPORTANCE.NONE) return '已关闭'
  if (importance === ANDROID_IMPORTANCE.MIN || importance === ANDROID_IMPORTANCE.LOW)
    return '静默'
  const loud = channel.sound !== null
  if (importance >= ANDROID_IMPORTANCE.HIGH) return loud ? '横幅 · 有声音' : '横幅'
  return loud ? '有声音' : '静默'
}

/** 渠道行的标题：与系统里看到的渠道名一致。 */
export const channelRows = [
  { kind: 'decisions', title: '要我做决定' },
  { kind: 'completed', title: '任务完成' },
  { kind: 'errors', title: '出错或卡住' },
] as const

export const channelFootnote = '点选提醒类型，在系统设置中调整声音和震动。'

/** 电脑组首行：英文名后补一个空格（MacBook Pro 的设置），中文名直接相连（书房电脑的设置）。 */
export function computerSettingsTitle(name: string | undefined) {
  const trimmed = name?.trim()
  if (!trimmed) return '这台电脑的设置'
  return /[A-Za-z0-9]$/.test(trimmed) ? `${trimmed} 的设置` : `${trimmed}的设置`
}

export const liveActivityValue = (mode: LiveActivityMode) =>
  mode === 'decisions' ? '只在等你决定时' : '运行中也显示'

/** 相机、照片权限行右侧的值；还没读到时不显示。 */
export function permissionLabel(
  response: { status: string; accessPrivileges?: string } | null
) {
  if (!response) return ''
  if (response.status === 'granted')
    return response.accessPrivileges === 'limited' ? '仅所选照片' : '已允许'
  return response.status === 'undetermined' ? '未询问' : '未允许'
}

export const computersValue = (count: number) => `${count} 台`

/** 设置页关于区：「0.1.0 (12)」，构建号取原生包（读不到就只显示版本）。 */
export function versionLabel(version: string | undefined, build?: string | null) {
  if (!version) return '未知版本'
  return build ? `${version} (${build})` : version
}

export const repoUrl = 'https://github.com/NanmiCoder/cc-haha'
export const aboutLinks = {
  guide: repoUrl,
  issues: `${repoUrl}/issues`,
  license: `${repoUrl}/blob/main/LICENSE`,
  pushSetup: `${repoUrl}/blob/main/mobile/PUSH_NOTIFICATIONS.md`,
}
