import { useState } from 'react'
import { Linking, Platform, ScrollView, View } from 'react-native'
import { router } from 'expo-router'
import Constants from 'expo-constants'
import { useApp, useConnection } from '../state/AppContext'
import { usePushRegistration, useRetryPushRegistration } from '../state/PushRegistrationContext'
import { usePreferences } from '../state/PreferencesContext'
import {
  Footnote,
  Group,
  Icon,
  InlineError,
  LargeTitle,
  ListRow,
  Mono,
  NavBar,
  ScreenView,
  SectionHeader,
  Segmented,
  Separator,
  Switch,
  useColors,
  type IconName,
} from '../ui/kit'
import { Logo } from '../ui/Logo'
import { Text } from '../ui/Text'
import { errorText, useTheme } from '../ui/theme'
import { type } from '../ui/palette'
import {
  openAppSettings,
  openChannelSettings,
  openNotificationSettings,
  requestNotificationStatus,
  scheduleTestNotification,
} from '../core/systemPermissions'
import { getDevicePushToken } from '../state/devicePushToken'
import { DeliveryCard } from '../ui/settings/DeliveryCard'
import { ProfileEntry } from '../ui/profile/ProfileEntry'
import { QuietHoursSheet } from '../ui/settings/QuietHoursSheet'
import { useSystemPermissions } from '../ui/settings/useSystemPermissions'
import {
  aboutLinks,
  channelFootnote,
  channelRows,
  computerSettingsTitle,
  computersValue,
  deliveryNote,
  deliveryStatus,
  liveActivityValue,
  permissionLabel,
  remindFootnote,
  runTestNotification,
  versionLabel,
  type Delivery,
  type PushTestResult,
} from '../ui/settings/deliveryModel'
import { quietSummary } from '../ui/settings/settingsModel'

type NotificationKey = 'decisions' | 'completed' | 'errors'
const notificationRows: { key: NotificationKey; title: string; detail?: string }[] = [
  { key: 'decisions', title: '要我做决定', detail: '审批、提问、计划' },
  { key: 'completed', title: '任务完成' },
  { key: 'errors', title: '出错或 5 分钟没进展' },
]

const platform = Platform.OS === 'ios' ? 'ios' : 'android'

export default function Settings() {
  const colors = useColors()
  const { appearance, setAppearance } = useTheme()
  const { preferences, update, error: preferenceError } = usePreferences()
  const { registry } = useApp()
  const { host, client } = useConnection()
  const push = usePushRegistration(host?.id)
  const retryPush = useRetryPushRegistration(host?.id)
  const permissions = useSystemPermissions()
  const [busy, setBusy] = useState<Delivery['actions'][number]['kind'] | null>(null)
  const [deliveryError, setDeliveryError] = useState('')
  const [testNote, setTestNote] = useState('')
  const [notifyError, setNotifyError] = useState('')
  const [appearanceError, setAppearanceError] = useState('')
  const [linkError, setLinkError] = useState('')
  const [quietOpen, setQuietOpen] = useState(0)
  const [quietVisible, setQuietVisible] = useState(false)

  const delivery = deliveryStatus({
    platform,
    permission: permissions.notifications,
    push,
    hostName: host?.name,
    hasHost: Boolean(host),
    decisions: preferences.notifications.decisions,
    liveActivity: preferences.liveActivity,
  })
  const note = deliveryNote(push)
  const remind = remindFootnote(permissions.notifications)

  /** 向系统申请通知权限；申请过就记下，不再自动弹引导页。 */
  async function requestNotifications() {
    try {
      await requestNotificationStatus()
    } finally {
      await permissions.refresh()
      void update({ notifyPrompted: true }).catch(() => {})
    }
  }

  async function runAction(kind: Delivery['actions'][number]['kind']) {
    setDeliveryError('')
    setTestNote('')
    setBusy(kind)
    try {
      if (kind === 'request') await requestNotifications()
      else if (kind === 'settings') await openNotificationSettings()
      else if (kind === 'retry') retryPush()
      else {
        if (host && !client) throw new Error('电脑还没连上，稍后再试')
        const outcome = await runTestNotification({
          hostId: host?.id,
          getToken: getDevicePushToken,
          postTest: (body) =>
            client!.post<PushTestResult>('/api/sessions/mobile-push/test', body),
          scheduleLocal: scheduleTestNotification,
        })
        setTestNote(outcome.note)
      }
    } catch (e) {
      setDeliveryError(kind === 'test' ? '测试未完成，请检查电脑连接后重试。' : errorText(e))
    } finally {
      setBusy(null)
    }
  }

  async function notify(key: NotificationKey, value: boolean) {
    setNotifyError('')
    try {
      // 还能弹授权框就问一次；已经拒绝的由上面的卡片引导去系统设置，开关照常保存。
      const permission = permissions.notifications
      if (
        value &&
        Platform.OS !== 'web' &&
        permission?.status !== 'granted' &&
        (permission?.status === 'undetermined' || permission?.canAskAgain !== false)
      )
        await requestNotifications()
      await update({ notifications: { [key]: value } })
    } catch (e) {
      setNotifyError(errorText(e))
    }
  }

  async function open(url: string) {
    setLinkError('')
    try {
      await Linking.openURL(url)
    } catch (e) {
      setLinkError(errorText(e))
    }
  }

  async function openPermission(action: () => Promise<void>) {
    setLinkError('')
    try {
      await action()
    } catch (e) {
      setLinkError(errorText(e))
    }
  }

  return (
    <ScreenView>
      <NavBar floating />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 }}
        keyboardShouldPersistTaps="handled"
      >
        <LargeTitle title="设置" style={{ paddingTop: 12, paddingBottom: 18 }} />
        <InlineError text={preferenceError} style={{ marginBottom: 8 }} />

        <ProfileEntry />

        <DeliveryCard
          delivery={delivery}
          busy={busy ?? (push?.status === 'loading' ? 'retry' : null)}
          note={testNote || note}
          error={deliveryError}
          onAction={(kind) => void runAction(kind)}
          onGuide={() => void open(aboutLinks.pushSetup)}
        />
        <SectionHeader title="提醒我" />
        <Group>
          {notificationRows.map((item, index) => (
            <ListRowWithSwitch
              key={item.key}
              first={index === 0}
              title={item.title}
              detail={item.detail}
              value={preferences.notifications[item.key]}
              onChange={(value) => void notify(item.key, value)}
            />
          ))}
          {Platform.OS === 'ios' && (
            <ListRowWithSwitch
              first={false}
              title="专注模式下也提醒审批"
              detail="标成时效性通知，不被专注模式拦下"
              value={preferences.timeSensitive}
              onChange={(value) =>
                void update({ timeSensitive: value }).catch((e) => setNotifyError(errorText(e)))
              }
            />
          )}
          <Separator />
          <ListRow
            title="勿扰时段"
            accessibilityLabel={`勿扰时段，${quietSummary(preferences.quietHours)}`}
            value={<Value text={quietSummary(preferences.quietHours)} />}
            trailing={<Chev />}
            onPress={() => {
              setQuietOpen((count) => count + 1)
              setQuietVisible(true)
            }}
          />
        </Group>
        {notifyError ? (
          <InlineError text={notifyError} style={{ marginTop: 8 }} />
        ) : remind ? (
          <Footnote>{remind}</Footnote>
        ) : null}

        {Platform.OS === 'ios' ? (
          <>
            <SectionHeader title="锁屏与灵动岛" />
            <Group>
              <ListRow
                title="实时活动"
                value={<Value text={liveActivityValue(preferences.liveActivity)} />}
                trailing={<Chev />}
                onPress={() => router.push('/live-activity')}
              />
            </Group>
            <Footnote>锁屏上的允许和拒绝，都要先解锁才生效。</Footnote>
          </>
        ) : (
          <>
            <SectionHeader title="声音和震动" />
            <Group>
              {channelRows.map((row, index) => (
                <View key={row.kind}>
                  {index > 0 && <Separator />}
                  <ListRow
                    title={row.title}
                    accessibilityLabel={`${row.title}，${permissions.channels[row.kind] || '打开系统设置'}`}
                    value={
                      permissions.channels[row.kind] ? (
                        <Value text={permissions.channels[row.kind]} />
                      ) : undefined
                    }
                    trailing={<Chev />}
                    onPress={() => void openPermission(() => openChannelSettings(row.kind))}
                  />
                </View>
              ))}
            </Group>
            <Footnote>{channelFootnote}</Footnote>
          </>
        )}

        <SectionHeader title="外观" />
        <Segmented
          label="外观"
          style={{ padding: 3, gap: 0 }}
          value={appearance}
          options={[
            { label: '浅色', value: 'light' },
            { label: '深色', value: 'dark' },
            { label: '跟随系统', value: 'system' },
          ]}
          onChange={(value) => {
            setAppearanceError('')
            void setAppearance(value).catch((e) => setAppearanceError(errorText(e)))
          }}
        />
        <InlineError text={appearanceError} style={{ marginTop: 8 }} />

        <SectionHeader title="系统权限" />
        <Group>
          <PermissionRow
            icon="camera"
            title="相机"
            detail="扫码连接电脑"
            value={permissionLabel(permissions.camera)}
            onPress={() => void openPermission(openAppSettings)}
          />
          <Separator inset={48} />
          <PermissionRow
            icon="image"
            title="照片"
            detail="给电脑发截图和图片"
            value={permissionLabel(permissions.photos)}
            onPress={() => void openPermission(openAppSettings)}
          />
        </Group>
        <Footnote>
          在系统设置中管理相机和照片权限。局域网连接需要允许本地网络访问。
        </Footnote>

        <SectionHeader title="电脑" />
        <Group>
          {host && (
            <>
              <ListRow
                title={
                  <Text
                    numberOfLines={1}
                    style={{ fontSize: 16, lineHeight: 21, fontWeight: '600', color: colors.ink }}
                  >
                    {computerSettingsTitle(host.name)}
                  </Text>
                }
                subtitle={
                  <Text numberOfLines={1} style={[type.meta, { color: colors.ink3 }]}>
                    新任务默认模型、AI 代答、定时任务
                  </Text>
                }
                minHeight={64}
                leading={
                  <View
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 10,
                      backgroundColor: colors.fill,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Icon name="laptop" size={20} color={colors.ink} strokeWidth={1.7} />
                  </View>
                }
                trailing={<Chev />}
                onPress={() =>
                  router.push({ pathname: '/computer', params: { host: host.id } })
                }
              />
              <Separator />
            </>
          )}
          <ListRow
            title="你的电脑"
            value={<Value text={computersValue(registry.hosts.length)} />}
            trailing={<Chev />}
            onPress={() => router.push('/hosts')}
          />
        </Group>

        <SectionHeader title="关于" />
        <Group>
          <ListRow
            title={
              <Text style={{ fontSize: 16, lineHeight: 21, fontWeight: '600', color: colors.ink }}>
                cc-haha
              </Text>
            }
            subtitle={
              <Mono style={{ fontSize: 13, lineHeight: 18, color: colors.ink3 }}>
                {versionLabel(Constants.expoConfig?.version, Constants.nativeBuildVersion)}
              </Mono>
            }
            minHeight={64}
            leading={
              <View
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 9,
                  backgroundColor: colors.brandSoft,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Logo size={27} />
              </View>
            }
          />
          <Separator />
          <LinkRow title="使用指南" onPress={() => void open(aboutLinks.guide)} />
          <Separator />
          <LinkRow title="反馈问题" onPress={() => void open(aboutLinks.issues)} />
          <Separator />
          <LinkRow title="开源许可" onPress={() => void open(aboutLinks.license)} />
        </Group>
        <InlineError text={linkError} style={{ marginTop: 8 }} />
      </ScrollView>
      <QuietHoursSheet
        key={quietOpen}
        visible={quietVisible}
        initial={preferences.quietHours}
        onClose={() => setQuietVisible(false)}
        onSave={(quietHours) => update({ quietHours })}
      />
    </ScreenView>
  )
}

function ListRowWithSwitch({
  first,
  title,
  detail,
  value,
  onChange,
}: {
  first: boolean
  title: string
  detail?: string
  value: boolean
  onChange(value: boolean): void
}) {
  return (
    <>
      {!first && <Separator />}
      <ListRow
        title={title}
        subtitle={detail}
        minHeight={detail ? 58 : 50}
        trailing={<Switch label={title} value={value} onValueChange={onChange} />}
      />
    </>
  )
}

function PermissionRow({
  icon,
  title,
  detail,
  value,
  onPress,
}: {
  icon: IconName
  title: string
  detail: string
  value: string
  onPress(): void
}) {
  const colors = useColors()
  return (
    <ListRow
      title={title}
      subtitle={detail}
      value={value ? <Value text={value} /> : undefined}
      minHeight={58}
      accessibilityLabel={value ? `${title}，${value}，打开系统设置` : `${title}，打开系统设置`}
      leading={<Icon name={icon} size={20} color={colors.ink2} strokeWidth={1.8} />}
      trailing={<Chev />}
      onPress={onPress}
    />
  )
}

function LinkRow({ title, onPress }: { title: string; onPress(): void }) {
  const colors = useColors()
  return (
    <ListRow
      title={title}
      accessibilityLabel={`${title}，在浏览器中打开`}
      trailing={<Icon name="external-link" size={15} color={colors.chevron} strokeWidth={2} />}
      onPress={onPress}
    />
  )
}

/** 设计稿的行尾取值：15pt 次要色，不收缩。 */
function Value({ text }: { text: string }) {
  const colors = useColors()
  return (
    <Text numberOfLines={1} style={{ fontSize: 15, color: colors.ink3, flexShrink: 0 }}>
      {text}
    </Text>
  )
}

/** 设计稿的行尾箭头：16pt、2 粗。 */
function Chev() {
  const colors = useColors()
  return <Icon name="chevron-right" size={16} color={colors.chevron} strokeWidth={2} />
}
