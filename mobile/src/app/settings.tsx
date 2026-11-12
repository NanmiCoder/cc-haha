import { useState } from 'react'
import { Linking, Platform, ScrollView, View } from 'react-native'
import { router } from 'expo-router'
import Constants from 'expo-constants'
import { isH5 } from '../state/h5'
import { pushTokens, useApp, useConnection } from '../state/AppContext'
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
import { DeliveryCard } from '../ui/settings/DeliveryCard'
import { ProfileEntry } from '../ui/profile/ProfileEntry'
import { QuietHoursSheet } from '../ui/settings/QuietHoursSheet'
import { useSystemPermissions } from '../ui/settings/useSystemPermissions'
import { requestBackgroundRunning, useDutyStatus } from '../ui/settings/useDutyStatus'
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
  { key: 'decisions', title: 'Needs my decision', detail: 'Approvals, questions, plans' },
  { key: 'completed', title: 'Task finished' },
  { key: 'errors', title: 'Errors or no progress for 5 minutes' },
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
  const { decisions, completed, errors } = preferences.notifications
  // Only when this computer reaches the phone through the background connection.
  const duty = useDutyStatus(
    push?.status === 'registered' && push.provider === 'desktop' &&
      (decisions || completed || errors)
  )

  const delivery = deliveryStatus({
    platform,
    permission: permissions.notifications,
    push,
    hostName: host?.name,
    hasHost: Boolean(host),
    decisions: preferences.notifications.decisions,
    liveActivity: preferences.liveActivity,
    duty,
  })
  const note = deliveryNote(push, duty)
  const remind = remindFootnote(permissions.notifications)

  /** Request notification permission from the system; remember once requested and do not auto-show the onboarding again. */
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
      else if (kind === 'battery') requestBackgroundRunning()
      else if (kind === 'appSettings') await openAppSettings()
      else {
        if (host && !client) throw new Error('The computer is not connected yet; try again later')
        const outcome = await runTestNotification({
          hostId: host?.id,
          // The test must reach the phone the same way the computer's real alerts do.
          getToken: () => pushTokens.token(push?.provider ?? 'direct', host?.id ?? ''),
          postTest: (body) =>
            client!.post<PushTestResult>('/api/sessions/mobile-push/test', body),
          scheduleLocal: scheduleTestNotification,
        })
        setTestNote(outcome.note)
        // The computer just sent through its relay: read the fresh delivery state.
        if (outcome.via === 'remote') retryPush()
      }
    } catch (e) {
      setDeliveryError(kind === 'test' ? 'Test did not finish; check the computer connection and retry.' : errorText(e))
    } finally {
      setBusy(null)
    }
  }

  async function notify(key: NotificationKey, value: boolean) {
    setNotifyError('')
    try {
      // Ask once if the system prompt can still show; if already denied the card above guides to system settings, and the toggle saves as usual.
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
        <LargeTitle title="Settings" style={{ paddingTop: 12, paddingBottom: 18 }} />
        <InlineError text={preferenceError} style={{ marginBottom: 8 }} />

        <ProfileEntry />

        {/* The web version gets no push, lock screen or system permissions: these are set only in the phone app. */}
        {isH5 ? null : (
          <>
            <DeliveryCard
              delivery={delivery}
              busy={busy ?? (push?.status === 'loading' ? 'retry' : null)}
              note={testNote || note}
              error={deliveryError}
              onAction={(kind) => void runAction(kind)}
              onGuide={() => void open(aboutLinks.pushSetup)}
            />
            <SectionHeader title="Notify me" />
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
                  title="Alert approvals even in Focus mode"
                  detail="Mark as time-sensitive so Focus mode does not block it"
                  value={preferences.timeSensitive}
                  onChange={(value) =>
                    void update({ timeSensitive: value }).catch((e) => setNotifyError(errorText(e)))
                  }
                />
              )}
              <Separator />
              <ListRow
                title="Quiet hours"
                accessibilityLabel={`Quiet hours, ${quietSummary(preferences.quietHours)}`}
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
                <SectionHeader title="Lock screen and Dynamic Island" />
                <Group>
                  <ListRow
                    title="Live Activities"
                    value={<Value text={liveActivityValue(preferences.liveActivity)} />}
                    trailing={<Chev />}
                    onPress={() => router.push('/live-activity')}
                  />
                </Group>
                <Footnote>Allow and deny on the lock screen only take effect after unlocking.</Footnote>
              </>
            ) : (
              <>
                <SectionHeader title="Sounds & vibration" />
                <Group>
                  {channelRows.map((row, index) => (
                    <View key={row.kind}>
                      {index > 0 && <Separator />}
                      <ListRow
                        title={row.title}
                        accessibilityLabel={`${row.title}, ${permissions.channels[row.kind] || 'Open system settings'}`}
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
          </>
        )}

        <SectionHeader title="Appearance" />
        <Segmented
          label="Appearance"
          style={{ padding: 3, gap: 0 }}
          value={appearance}
          options={[
            { label: 'Light', value: 'light' },
            { label: 'Dark', value: 'dark' },
            { label: 'System', value: 'system' },
          ]}
          onChange={(value) => {
            setAppearanceError('')
            void setAppearance(value).catch((e) => setAppearanceError(errorText(e)))
          }}
        />
        <InlineError text={appearanceError} style={{ marginTop: 8 }} />

        {isH5 ? null : (
          <>
            <SectionHeader title="System permissions" />
            <Group>
              <PermissionRow
                icon="camera"
                title="Camera"
                detail="Scan to connect a computer"
                value={permissionLabel(permissions.camera)}
                onPress={() => void openPermission(openAppSettings)}
              />
              <Separator inset={48} />
              <PermissionRow
                icon="image"
                title="Photos"
                detail="Send screenshots and images to the computer"
                value={permissionLabel(permissions.photos)}
                onPress={() => void openPermission(openAppSettings)}
              />
            </Group>
            <Footnote>
              Manage camera and photo permissions in system settings. LAN connections need local network access allowed.
            </Footnote>
          </>
        )}

        <SectionHeader title="computer" />
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
                    New task default model, AI auto-answer, scheduled tasks
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
              {isH5 ? null : <Separator />}
            </>
          )}
          {isH5 ? null : (
            <ListRow
              title="Your computers"
              value={<Value text={computersValue(registry.hosts.length)} />}
              trailing={<Chev />}
              onPress={() => router.push('/hosts')}
            />
          )}
        </Group>

        <SectionHeader title="About" />
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
          <LinkRow title="User guide" onPress={() => void open(aboutLinks.guide)} />
          <Separator />
          <LinkRow title="Report an issue" onPress={() => void open(aboutLinks.issues)} />
          <Separator />
          <LinkRow title="Open source licenses" onPress={() => void open(aboutLinks.license)} />
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
      accessibilityLabel={value ? `${title}, ${value}, open system settings` : `${title}, open system settings`}
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
      accessibilityLabel={`${title}, open in browser`}
      trailing={<Icon name="external-link" size={15} color={colors.chevron} strokeWidth={2} />}
      onPress={onPress}
    />
  )
}

/** Design trailing value: 15pt secondary color, no shrink. */
function Value({ text }: { text: string }) {
  const colors = useColors()
  return (
    <Text numberOfLines={1} style={{ fontSize: 15, color: colors.ink3, flexShrink: 0 }}>
      {text}
    </Text>
  )
}

/** Design trailing chevron: 16pt, weight 2. */
function Chev() {
  const colors = useColors()
  return <Icon name="chevron-right" size={16} color={colors.chevron} strokeWidth={2} />
}
