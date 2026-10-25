import { useCallback, useState } from 'react'
import { Platform, ScrollView } from 'react-native'
import { useFocusEffect } from 'expo-router'
import * as Notifications from 'expo-notifications'
import { useConnection } from '../state/AppContext'
import { usePushRegistration } from '../state/PushRegistrationContext'
import { usePreferences } from '../state/PreferencesContext'
import {
  Footnote,
  Group,
  InlineError,
  LargeTitle,
  ListRow,
  NavBar,
  ScreenView,
  SectionHeader,
  Segmented,
  Separator,
  Switch,
  useColors,
} from '../ui/kit'
import { Text } from '../ui/Text'
import { errorText, useTheme } from '../ui/theme'
import { QuietHoursSheet } from '../ui/settings/QuietHoursSheet'
import { AutoAnswerSheet } from '../ui/settings/AutoAnswerSheet'
import {
  autoAnswerValue,
  desktopOnly,
  nextAutoQuestion,
  pushFootnote,
  quietSummary,
  readAutoQuestion,
  type AutoQuestion,
} from '../ui/settings/settingsModel'

type NotificationKey = 'decisions' | 'completed' | 'errors'
const notificationRows: { key: NotificationKey; title: string; detail?: string }[] = [
  { key: 'decisions', title: '要我做决定', detail: '审批、提问、计划' },
  { key: 'completed', title: '任务完成' },
  { key: 'errors', title: '出错或 5 分钟没进展' },
]

export default function Settings() {
  const colors = useColors()
  const { appearance, setAppearance } = useTheme()
  const { preferences, update, error: preferenceError } = usePreferences()
  const { host, client, error: connectionError } = useConnection()
  const push = usePushRegistration(host?.id)
  const [remote, setRemote] = useState<{
    hostId: string
    autoQuestion?: AutoQuestion
    error?: string
  } | null>(null)
  const [notifyError, setNotifyError] = useState('')
  const [appearanceError, setAppearanceError] = useState('')
  const [quietOpen, setQuietOpen] = useState(0)
  const [quietVisible, setQuietVisible] = useState(false)
  const [autoVisible, setAutoVisible] = useState(false)
  const record = remote?.hostId === host?.id ? remote : null

  useFocusEffect(
    useCallback(() => {
      if (!client) return
      const controller = new AbortController()
      const hostId = client.host.id
      client
        .get<{ autoQuestion?: unknown }>('/api/settings/user', {
          signal: controller.signal,
        })
        .then((settings) => {
          if (!controller.signal.aborted)
            setRemote({ hostId, autoQuestion: readAutoQuestion(settings) })
        })
        .catch((e) => {
          if (!controller.signal.aborted) setRemote({ hostId, error: errorText(e) })
        })
      return () => controller.abort()
    }, [client])
  )

  async function notify(key: NotificationKey, value: boolean) {
    setNotifyError('')
    try {
      if (value && Platform.OS !== 'web') {
        const result = await Notifications.requestPermissionsAsync()
        if (!result.granted)
          throw new Error('通知权限未开启，请在系统设置中允许 cc-haha 通知')
      }
      await update({ notifications: { [key]: value } })
    } catch (e) {
      setNotifyError(errorText(e))
    }
  }

  async function saveAutoAnswer(minutes: number) {
    if (!client || !record?.autoQuestion) throw new Error('还没读到电脑上的设置，请稍后再试')
    const autoQuestion = nextAutoQuestion(record.autoQuestion, minutes)
    await client.put('/api/settings/user', { autoQuestion })
    const hostId = client.host.id
    setRemote((current) =>
      current?.hostId === hostId ? { hostId, autoQuestion } : current
    )
  }

  const autoValue = !host
    ? '未连接'
    : record?.autoQuestion
      ? autoAnswerValue(record.autoQuestion)
      : record?.error || connectionError
        ? '读取失败'
        : '读取中…'
  const autoError = host ? connectionError || record?.error : ''
  const footnote = pushFootnote(push, host?.name)

  return (
    <ScreenView>
      <NavBar />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 }}
        keyboardShouldPersistTaps="handled"
      >
        <LargeTitle title="设置" />
        <InlineError text={preferenceError} style={{ marginBottom: 8 }} />

        <SectionHeader title="通知我" style={{ paddingTop: 4 }} />
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
          <Separator />
          <ListRow
            title="勿扰时段"
            accessibilityLabel={`勿扰时段，${quietSummary(preferences.quietHours)}`}
            value={
              <Text style={{ fontSize: 15, color: colors.ink3 }}>
                {quietSummary(preferences.quietHours)}
              </Text>
            }
            chevron
            style={{ gap: 10 }}
            onPress={() => {
              setQuietOpen((count) => count + 1)
              setQuietVisible(true)
            }}
          />
        </Group>
        {notifyError ? (
          <InlineError text={notifyError} style={{ marginTop: 8 }} />
        ) : footnote ? (
          <Footnote>{footnote}</Footnote>
        ) : null}

        <SectionHeader title="我不在的时候" />
        <Group>
          <ListRow
            title="提问没人回，AI 代答"
            subtitle="按推荐选项作答，审批永远不代答"
            minHeight={58}
            value={<Text style={{ fontSize: 15, color: colors.ink3 }}>{autoValue}</Text>}
            chevron
            disabled={!record?.autoQuestion}
            style={{ gap: 10 }}
            onPress={() => setAutoVisible(true)}
          />
        </Group>
        <InlineError text={autoError} style={{ marginTop: 8 }} />

        <SectionHeader title="外观" />
        <Segmented
          label="外观"
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

        <SectionHeader title="只能在电脑上改" />
        <Text style={{ paddingHorizontal: 4, fontSize: 14, lineHeight: 22, color: colors.ink3 }}>
          {desktopOnly}
        </Text>
      </ScrollView>
      <QuietHoursSheet
        key={quietOpen}
        visible={quietVisible}
        initial={preferences.quietHours}
        onClose={() => setQuietVisible(false)}
        onSave={(quietHours) => update({ quietHours })}
      />
      {record?.autoQuestion && host && (
        <AutoAnswerSheet
          visible={autoVisible}
          hostName={host.name}
          current={record.autoQuestion}
          onClose={() => setAutoVisible(false)}
          onSelect={saveAutoAnswer}
        />
      )}
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
