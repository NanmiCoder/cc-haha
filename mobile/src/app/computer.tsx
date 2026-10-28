import { useState } from 'react'
import { Alert, Pressable, ScrollView, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { Text } from '../ui/Text'
import { useApp, useConnection } from '../state/AppContext'
import type { Host, PermissionMode } from '../core/types'
import {
  EmptyState,
  Footnote,
  Group,
  Icon,
  InlineError,
  NavBar,
  ScreenView,
  SectionHeader,
  Separator,
  useColors,
} from '../ui/kit'
import { errorText } from '../ui/theme'
import { modeName, effortName } from '../ui/modes'
import { StatusDot, useNow } from '../ui/home/parts'
import { useHostCheck } from '../ui/home/useHostCheck'
import { Glyph } from '../ui/compose/glyphs'
import { AutoAnswerSheet } from '../ui/settings/AutoAnswerSheet'
import { autoAnswerValue, nextAutoQuestion } from '../ui/settings/settingsModel'
import {
  GaugeGlyph,
  SettingRow,
} from '../ui/computer/parts'
import { PermissionSheet } from '../ui/computer/PermissionSheet'
import { useComputerValues, type ComputerKey } from '../ui/computer/useComputerValues'
import {
  computerStatus,
  connectionAddress,
  connectionMethod,
  defaultsFootnote,
  desktopOnlyText,
  permissionAccess,
  remoteAuthLine,
  removeConfirmText,
} from '../ui/computer/computerModel'

/** /computer?host —— 一台电脑的设置：存在电脑上、每台一份。 */
export default function Computer() {
  const { host: id } = useLocalSearchParams<{ host?: string }>()
  const { host } = useConnection(id)
  if (!host)
    return (
      <ScreenView>
        <NavBar floating title="电脑设置" />
        <EmptyState icon="laptop" title="还没有连接电脑" detail="先连接一台电脑，再回到这里。" />
      </ScreenView>
    )
  return <ComputerBody key={host.id} host={host} />
}

function ComputerBody({ host }: { host: Host }) {
  const colors = useColors()
  const { remove } = useApp()
  const { client, error: connectionError } = useConnection(host.id)
  const check = useHostCheck(host)
  const now = useNow(60000)
  const { values, patch } = useComputerValues(client)
  const [permissionOpen, setPermissionOpen] = useState(false)
  const [autoOpen, setAutoOpen] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState('')

  const status = computerStatus(host, check, now)
  const access = permissionAccess(host)
  const authLine = remoteAuthLine(host, check)
  const go = (pathname: '/models' | '/schedules' | '/activity') =>
    router.push({ pathname, params: { host: host.id } })
  // 一项读到就显示值；读失败显示“读取失败”；还没回来显示“读取中…”。
  const shown = (key: ComputerKey, value: string | undefined) =>
    value ?? (values.errors[key] !== undefined ? '读取失败' : '读取中…')
  const firstError = Object.values(values.errors).find(Boolean)

  async function savePermission(mode: PermissionMode) {
    if (!client) throw new Error('正在连接电脑')
    await client.put('/api/permissions/mode', { mode })
    patch({ mode })
  }
  async function saveAutoAnswer(minutes: number) {
    if (!client || !values.autoQuestion) throw new Error('还没读到电脑上的设置，请稍后再试')
    const autoQuestion = nextAutoQuestion(values.autoQuestion, minutes)
    await client.put('/api/settings/user', { autoQuestion })
    patch({ autoQuestion })
  }
  function removeHost() {
    if (removing) return
    const text = removeConfirmText(host.name)
    Alert.alert(text.title, text.message, [
      { text: '取消', style: 'cancel' },
      {
        text: '移除连接',
        style: 'destructive',
        onPress: () => {
          setRemoving(true)
          setRemoveError('')
          remove(host.id)
            .then(() => router.replace('/'))
            .catch((e) => setRemoveError(errorText(e)))
            .finally(() => setRemoving(false))
        },
      },
    ])
  }

  return (
    <ScreenView>
      <NavBar floating />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 48 }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 18, paddingHorizontal: 4, paddingBottom: 6 }}>
          <View
            style={{
              width: 52,
              height: 52,
              borderRadius: 14,
              backgroundColor: colors.card,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="laptop" size={28} color={colors.ink} strokeWidth={1.6} />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <Text
              accessibilityRole="header"
              numberOfLines={1}
              style={{ fontSize: 24, lineHeight: 30, fontWeight: '600', color: colors.ink }}
            >
              {host.name}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <StatusDot tone={status.tone} size={6} />
              <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 13, lineHeight: 18, color: colors.ink3 }}>
                {status.text}
              </Text>
            </View>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="切换电脑"
            onPress={() => router.push('/hosts')}
            style={({ pressed }) => ({
              height: 34,
              paddingHorizontal: 12,
              borderRadius: 17,
              backgroundColor: colors.fill,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Text style={{ fontSize: 14, fontWeight: '600', color: colors.ink }}>切换</Text>
            <Icon name="chevron-down" size={14} color={colors.ink} strokeWidth={2.4} />
          </Pressable>
        </View>
        <InlineError text={connectionError || firstError} style={{ marginTop: 8 }} />

        <SectionHeader title="新任务默认" />
        <Group>
          <SettingRow
            icon="cpu"
            title="模型"
            value={shown('model', values.model)}
            onPress={() => go('/models')}
          />
          <Separator inset={48} />
          <SettingRow
            glyph={<GaugeGlyph color={colors.ink2} />}
            title="思考强度"
            value={shown('effort', values.effort && effortName(values.effort))}
            onPress={() => go('/models')}
          />
          <Separator inset={48} />
          <SettingRow
            icon="shield"
            title="权限"
            value={shown('mode', values.mode && modeName(values.mode))}
            disabled={access.editable && values.mode === undefined}
            onPress={access.editable ? () => setPermissionOpen(true) : undefined}
            label={`权限，${values.mode ? modeName(values.mode) : '读取中'}${access.editable ? '' : '，公网连接下只能在电脑上改'}`}
          />
        </Group>
        <Footnote>{defaultsFootnote(host)}</Footnote>

        <SectionHeader title="我不在的时候" />
        <Group>
          <SettingRow
            glyph={<Glyph name="bot" color={colors.ink2} />}
            title="提问没人回，AI 代答"
            subtitle="按推荐选项作答，审批永远不代答"
            minHeight={60}
            value={shown(
              'autoQuestion',
              values.autoQuestion && autoAnswerValue(values.autoQuestion)
            )}
            disabled={!values.autoQuestion}
            onPress={() => setAutoOpen(true)}
          />
        </Group>

        <SectionHeader title="运行情况" />
        <Group>
          <SettingRow
            icon="clock"
            title="定时任务"
            value={shown('schedules', values.schedules)}
            onPress={() => go('/schedules')}
          />
          <Separator inset={48} />
          <SettingRow
            icon="activity"
            title="后台活动"
            value={shown('activity', values.activity)}
            onPress={() => go('/activity')}
          />
        </Group>

        <SectionHeader title="连接" />
        <Group>
          <SettingRow title="方式" value={connectionMethod(host)} />
          <Separator />
          <SettingRow title="地址" mono value={connectionAddress(host)} />
          {authLine ? (
            <>
              <Separator />
              <SettingRow title="公网授权" value={authLine} />
            </>
          ) : null}
        </Group>

        <SectionHeader title="只能在电脑上改" />
        <Group>
          <View
            style={{
              minHeight: 72,
              flexDirection: 'row',
              alignItems: 'flex-start',
              gap: 12,
              paddingHorizontal: 14,
              paddingVertical: 14,
            }}
          >
            <View style={{ marginTop: 1 }}>
              <Glyph name="monitor" color={colors.ink2} />
            </View>
            <Text style={{ flex: 1, fontSize: 14, lineHeight: 21, color: colors.ink2 }}>
              {desktopOnlyText}
            </Text>
          </View>
        </Group>

        <Group style={{ marginTop: 28 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`从这台手机移除 ${host.name}`}
            disabled={removing}
            onPress={removeHost}
            style={({ pressed }) => ({
              minHeight: 52,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: pressed ? colors.fill : 'transparent',
              opacity: removing ? 0.45 : 1,
            })}
          >
            <Text style={{ fontSize: 16, color: colors.err }}>从这台手机移除</Text>
          </Pressable>
        </Group>
        <InlineError text={removeError} style={{ marginTop: 8 }} />
        <Footnote>只删掉手机上的连接和推送登记，电脑上的会话都还在。</Footnote>
      </ScrollView>
      <PermissionSheet
        visible={permissionOpen}
        current={values.mode ?? ''}
        onClose={() => setPermissionOpen(false)}
        onSelect={savePermission}
      />
      {values.autoQuestion && (
        <AutoAnswerSheet
          visible={autoOpen}
          hostName={host.name}
          current={values.autoQuestion}
          onClose={() => setAutoOpen(false)}
          onSelect={saveAutoAnswer}
        />
      )}
    </ScreenView>
  )
}
