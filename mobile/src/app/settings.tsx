import { useCallback, useState } from 'react'
import { Modal, Platform, ScrollView, View } from 'react-native'
import { Text } from '../ui/Text'
import { router, useFocusEffect } from 'expo-router'
import * as Notifications from 'expo-notifications'
import { useApp, useConnection } from '../state/AppContext'
import { runtimeSourceName } from '../core/runtimeCatalog'
import { usePushRegistration } from '../state/PushRegistrationContext'
import { usePreferences } from '../state/PreferencesContext'
import {
  CircleButton,
  Divider,
  Field,
  Icon,
  Inset,
  Notice,
  PrimaryButton,
  Raised,
  Row,
  Screen,
  Segment,
  Toggle,
  errorText,
  mono,
  useTheme,
} from '../ui/theme'

type Defaults = {
  model: string
  provider: string
  effort: string
  autoQuestion: { enabled: boolean; timeoutMinutes: number }
}
export default function Settings() {
  const { colors: c, styles: s, appearance, setAppearance } = useTheme()
  const { registry } = useApp()
  const { preferences, update, error: preferenceError } = usePreferences()
  const { host, client, error: connectionError } = useConnection()
  const push = usePushRegistration(host?.id)
  const [record, setRecord] = useState<{
    hostId: string
    defaults: Defaults
    schedules: number | null
  } | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [quiet, setQuiet] = useState(false)
  const [quietError, setQuietError] = useState('')
  const [quietStart, setQuietStart] = useState(preferences.quietHours.start)
  const [quietEnd, setQuietEnd] = useState(preferences.quietHours.end)
  const data = record?.hostId === host?.id ? record : null
  useFocusEffect(
    useCallback(() => {
      const controller = new AbortController()
      if (client) {
        Promise.all([
          client.get<{ model: { id: string; name: string } }>(
            '/api/models/current',
            { signal: controller.signal }
          ),
          client.get<{
            activeId: string | null
            providers: { id: string; name: string }[]
          }>('/api/providers', { signal: controller.signal }),
          client.get<{ level: string }>('/api/effort', {
            signal: controller.signal,
          }),
          client.get<{
            autoQuestion?: { enabled: boolean; timeoutMinutes: number }
          }>('/api/settings/user', { signal: controller.signal }),
          client
            .get<{
              tasks: { enabled: boolean }[]
            }>('/api/scheduled-tasks', { signal: controller.signal })
            .catch(() => null),
        ])
          .then(([model, providers, effort, settings, scheduled]) => {
            if (!controller.signal.aborted)
              setRecord({
                hostId: client.host.id,
                schedules:
                  scheduled?.tasks.filter((task) => task.enabled).length ??
                  null,
                defaults: {
                  model: model.model.name || model.model.id,
                  provider: runtimeSourceName(
                    providers.activeId,
                    providers.providers
                  ),
                  effort:
                    {
                      low: '低',
                      medium: '中',
                      high: '高',
                      xhigh: '超高',
                      max: '最高',
                    }[effort.level] ?? effort.level,
                  autoQuestion: settings.autoQuestion ?? {
                    enabled: false,
                    timeoutMinutes: 5,
                  },
                },
              })
          })
          .catch((e) => {
            if (!controller.signal.aborted) setError(errorText(e))
          })
      }
      return () => controller.abort()
    }, [client])
  )
  async function notify(
    key: 'decisions' | 'completed' | 'errors',
    value: boolean
  ) {
    try {
      if (value && Platform.OS !== 'web') {
        const result = await Notifications.requestPermissionsAsync()
        if (!result.granted)
          throw new Error('通知权限未开启，请在系统设置中允许 cc-haha 通知')
      }
      await update({ notifications: { [key]: value } })
    } catch (e) {
      setError(errorText(e))
    }
  }
  async function autoAnswer(minutes: number) {
    if (!client || saving) return
    setSaving(true)
    setError('')
    try {
      const autoQuestion = {
        enabled: minutes > 0,
        timeoutMinutes: minutes || 5,
      }
      await client.put('/api/settings/user', { autoQuestion })
      setRecord((current) =>
        current?.hostId === client.host.id
          ? { ...current, defaults: { ...current.defaults, autoQuestion } }
          : current
      )
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSaving(false)
    }
  }
  const openModels = () =>
    host && router.push({ pathname: '/models', params: { host: host.id } })
  const section = (title: string, children: React.ReactNode) => (
    <View style={{ gap: 8 }}>
      <Text style={[s.label, { marginHorizontal: 4 }]}>{title}</Text>
      {children}
    </View>
  )
  return (
    <Screen title="设置">
      <Notice text={preferenceError || connectionError || error} error />
      {section(
        '通知',
        <Raised>
          {(
            [
              {
                key: 'decisions',
                title: '需要我做决定',
                detail: '审批、提问、计划',
              },
              { key: 'completed', title: '任务完成', detail: undefined },
              {
                key: 'errors',
                title: '出错，或长时间没有进展',
                detail: undefined,
              },
            ] as const
          ).map((item, index) => (
            <View key={item.key}>
              {index > 0 && <Divider />}
              <View
                style={[
                  s.between,
                  { paddingHorizontal: 16, minHeight: item.detail ? 56 : 52 },
                ]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.text}>{item.title}</Text>
                  {item.detail && <Text style={s.small}>{item.detail}</Text>}
                </View>
                <Toggle
                  label={item.title}
                  value={preferences.notifications[item.key]}
                  onChange={(value) => void notify(item.key, value)}
                />
              </View>
            </View>
          ))}
          <Divider />
          <Row
            title="勿扰时段"
            style={{ paddingHorizontal: 16 }}
            onPress={() => {
              setQuietStart(preferences.quietHours.start)
              setQuietEnd(preferences.quietHours.end)
              setQuietError('')
              setQuiet(true)
            }}
            trailing={
              <View style={s.row}>
                <Text
                  style={{
                    fontFamily: mono,
                    fontSize: 12,
                    padding: 5,
                    color: '#ECE8DE',
                    backgroundColor: c.well,
                    borderRadius: 6,
                  }}
                >
                  {preferences.quietHours.enabled
                    ? `${preferences.quietHours.start} – ${preferences.quietHours.end}`
                    : '未开启'}
                </Text>
                <Icon name="chevron-right" size={14} />
              </View>
            }
          />
        </Raised>
      )}
      {push && push.status !== 'registered' && push.status !== 'loading' && (
        <Notice
          text={
            push.status === 'notConfigured'
              ? '电脑尚未配置 APNs / FCM 推送。App 打开时仍可同步状态；离开 App 后的通知需要在电脑完成推送配置。'
              : push.status === 'permissionRequired'
                ? '请在系统设置中允许 cc-haha 通知，或重新打开上面的通知开关。'
                : push.status === 'unsupported'
                  ? '此设备暂不能登记远程通知。'
                  : push.error || '无法登记远程通知，请检查电脑连接。'
          }
        />
      )}
      {section(
        '我不在的时候',
        <Raised style={{ padding: 16, gap: 12 }}>
          <View style={{ gap: 3 }}>
            <Text style={s.text}>提问没人回答时，由 AI 代答</Text>
            <Text style={s.small}>
              按推荐选项作答，任务不会一直卡着。工具审批永远不会代答。
            </Text>
          </View>
          <Segment
            label="代答等待时间"
            value={
              data?.defaults.autoQuestion.enabled
                ? data.defaults.autoQuestion.timeoutMinutes
                : 0
            }
            disabled={!data || saving}
            options={[
              { label: '不代答', value: 0 },
              ...[1, 5, 10, 30].map((value) => ({
                label: `${value} 分`,
                value,
              })),
            ]}
            onChange={(value) => void autoAnswer(value)}
          />
        </Raised>
      )}
      {section(
        `${host?.name ?? '电脑'} 的默认值`,
        <>
          <Raised>
            {[
              { title: '模型', value: data?.defaults.model },
              { title: '思考强度', value: data?.defaults.effort },
              { title: '服务商', value: data?.defaults.provider },
            ].map((item, index) => (
              <View key={item.title}>
                {index > 0 && <Divider />}
                <Row
                  title={item.title}
                  style={{ paddingHorizontal: 16 }}
                  onPress={host ? openModels : undefined}
                  trailing={
                    <View style={s.row}>
                      <Text style={{ color: c.secondary, fontSize: 14 }}>
                        {item.value ?? (host ? '读取中…' : '未连接')}
                      </Text>
                      <Icon name="chevron-right" size={14} />
                    </View>
                  }
                />
              </View>
            ))}
          </Raised>
          <Text style={[s.small, { marginHorizontal: 4 }]}>
            只影响之后新建的会话，已经在跑的会话不变。
          </Text>
        </>
      )}
      {section(
        '外观',
        <Segment
          label="外观"
          value={appearance}
          options={[
            { label: '浅色', value: 'light' },
            { label: '深色', value: 'dark' },
            { label: '跟随系统', value: 'system' },
          ]}
          onChange={(value) => {
            void setAppearance(value).catch((e) => setError(errorText(e)))
          }}
        />
      )}
      <Raised>
        <Row
          title="定时任务"
          style={{ paddingHorizontal: 16 }}
          onPress={() =>
            host &&
            router.push({ pathname: '/schedules', params: { host: host.id } })
          }
          trailing={
            <View style={s.row}>
              <Text style={{ color: c.secondary, fontSize: 14 }}>
                {data?.schedules != null
                  ? `${data.schedules} 个开启`
                  : host
                    ? '未读取'
                    : '未连接'}
              </Text>
              <Icon name="chevron-right" size={14} />
            </View>
          }
        />
        <Divider />
        <Row
          title="你的电脑"
          style={{ paddingHorizontal: 16 }}
          onPress={() => router.push('/hosts')}
          trailing={
            <View style={s.row}>
              <Text style={{ color: c.secondary, fontSize: 14 }}>
                {registry.hosts.length} 台
              </Text>
              <Icon name="chevron-right" size={14} />
            </View>
          }
        />
      </Raised>
      {section(
        '需要在电脑上设置',
        <Inset style={{ paddingHorizontal: 16, paddingVertical: 6 }}>
          {[
            'MCP、技能与插件',
            '服务商的新增与 API Key',
            '官方账号登录',
            '操作电脑',
            'IM 机器人、局域网与公网访问',
          ].map((title) => (
            <View key={title} style={[s.row, { minHeight: 40, gap: 10 }]}>
              <Icon name="monitor" size={16} />
              <Text style={{ color: c.secondary, fontSize: 14 }}>{title}</Text>
            </View>
          ))}
        </Inset>
      )}
      <Modal
        visible={quiet}
        transparent
        animationType="slide"
        onRequestClose={() => setQuiet(false)}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: '#0005',
            justifyContent: 'flex-end',
          }}
        >
          <View
            style={{
              borderTopLeftRadius: 28,
              borderTopRightRadius: 28,
              padding: 24,
              paddingBottom: 40,
              gap: 20,
              backgroundColor: c.paper,
            }}
          >
            <View style={s.between}>
              <Text style={s.title}>勿扰时段</Text>
              <CircleButton
                name="x"
                label="关闭勿扰设置"
                onPress={() => setQuiet(false)}
              />
            </View>
            <ScrollView>
              <View style={{ gap: 16 }}>
                <Notice text={quietError} error />
                <View style={s.between}>
                  <Text style={s.text}>启用勿扰时段</Text>
                  <Toggle
                    label="启用勿扰时段"
                    value={preferences.quietHours.enabled}
                    onChange={(value) => {
                      void update({
                        quietHours: {
                          ...preferences.quietHours,
                          enabled: value,
                        },
                      }).catch((e) => setQuietError(errorText(e)))
                    }}
                  />
                </View>
                <Field
                  label="开始时间"
                  placeholder="23:00"
                  value={quietStart}
                  onChangeText={setQuietStart}
                />
                <Field
                  label="结束时间"
                  placeholder="08:00"
                  value={quietEnd}
                  onChangeText={setQuietEnd}
                />
                <PrimaryButton
                  title="保存"
                  onPress={() => {
                    if (
                      !/^([01]\d|2[0-3]):[0-5]\d$/.test(quietStart) ||
                      !/^([01]\d|2[0-3]):[0-5]\d$/.test(quietEnd)
                    ) {
                      setQuietError('时间请输入 HH:mm 格式')
                      return
                    }
                    void update({
                      quietHours: {
                        ...preferences.quietHours,
                        start: quietStart,
                        end: quietEnd,
                      },
                    })
                      .then(() => setQuiet(false))
                      .catch((e) => setQuietError(errorText(e)))
                  }}
                />
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </Screen>
  )
}
