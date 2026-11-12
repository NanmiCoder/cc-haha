import { useState } from 'react'
import { Alert, Pressable, ScrollView, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { Text } from '../ui/Text'
import { useApp, useConnection } from '../state/AppContext'
import { isH5 } from '../state/h5'
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
import { goHome } from '../ui/navigation'
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

/** /computer?host — Settings for one computer: stored on the computer, one per computer. */
export default function Computer() {
  const { host: id } = useLocalSearchParams<{ host?: string }>()
  const { host } = useConnection(id)
  if (!host)
    return (
      <ScreenView>
        <NavBar floating title="Computer settings" />
        <EmptyState icon="laptop" title="No computer connected yet" detail="Connect a computer first, then come back here." />
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
  // Show the value once read; on failure show "Failed to load"; while pending show "Loading…".
  const shown = (key: ComputerKey, value: string | undefined) =>
    value ?? (values.errors[key] !== undefined ? 'Failed to load' : 'Loading…')
  const firstError = Object.values(values.errors).find(Boolean)

  async function savePermission(mode: PermissionMode) {
    if (!client) throw new Error('Connecting to computer')
    await client.put('/api/permissions/mode', { mode })
    patch({ mode })
  }
  async function saveAutoAnswer(minutes: number) {
    if (!client || !values.autoQuestion) throw new Error('Settings from the computer are not loaded yet; please try again later')
    const autoQuestion = nextAutoQuestion(values.autoQuestion, minutes)
    await client.put('/api/settings/user', { autoQuestion })
    patch({ autoQuestion })
  }
  function removeHost() {
    if (removing) return
    const text = removeConfirmText(host.name)
    Alert.alert(text.title, text.message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove connection',
        style: 'destructive',
        onPress: () => {
          setRemoving(true)
          setRemoveError('')
          remove(host.id)
            .then(() => goHome())
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
          {isH5 ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Switch computer"
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
              <Text style={{ fontSize: 14, fontWeight: '600', color: colors.ink }}>Switch</Text>
              <Icon name="chevron-down" size={14} color={colors.ink} strokeWidth={2.4} />
            </Pressable>
          )}
        </View>
        <InlineError text={connectionError || firstError} style={{ marginTop: 8 }} />

        <SectionHeader title="New task defaults" />
        <Group>
          <SettingRow
            icon="cpu"
            title="Model"
            value={shown('model', values.model)}
            onPress={() => go('/models')}
          />
          <Separator inset={48} />
          <SettingRow
            glyph={<GaugeGlyph color={colors.ink2} />}
            title="Thinking effort"
            value={shown('effort', values.effort && effortName(values.effort))}
            onPress={() => go('/models')}
          />
          <Separator inset={48} />
          <SettingRow
            icon="shield"
            title="Permissions"
            value={shown('mode', values.mode && modeName(values.mode))}
            disabled={access.editable && values.mode === undefined}
            onPress={access.editable ? () => setPermissionOpen(true) : undefined}
            label={`Permissions, ${values.mode ? modeName(values.mode) : 'Loading'}${access.editable ? '' : '; can only be changed on the computer over a public connection'}`}
          />
        </Group>
        <Footnote>{defaultsFootnote(host)}</Footnote>

        <SectionHeader title="While I am away" />
        <Group>
          <SettingRow
            glyph={<Glyph name="bot" color={colors.ink2} />}
            title="Unanswered questions get AI answers"
            subtitle="Answer with the recommended option; approvals are never answered for you"
            minHeight={60}
            value={shown(
              'autoQuestion',
              values.autoQuestion && autoAnswerValue(values.autoQuestion)
            )}
            disabled={!values.autoQuestion}
            onPress={() => setAutoOpen(true)}
          />
        </Group>

        <SectionHeader title="Run status" />
        <Group>
          <SettingRow
            icon="clock"
            title="Scheduled task"
            value={shown('schedules', values.schedules)}
            onPress={() => go('/schedules')}
          />
          <Separator inset={48} />
          <SettingRow
            icon="activity"
            title="Background activity"
            value={shown('activity', values.activity)}
            onPress={() => go('/activity')}
          />
        </Group>

        <SectionHeader title="Connection" />
        <Group>
          <SettingRow title="Method" value={connectionMethod(host)} />
          <Separator />
          <SettingRow title="Address" mono value={connectionAddress(host)} />
          {authLine ? (
            <>
              <Separator />
              <SettingRow title="Public access authorization" value={authLine} />
            </>
          ) : null}
        </Group>

        <SectionHeader title="Can only be changed on the computer" />
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

        {isH5 ? null : (
          <>
            <Group style={{ marginTop: 28 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove from this phone ${host.name}`}
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
                <Text style={{ fontSize: 16, color: colors.err }}>Remove from this phone</Text>
              </Pressable>
            </Group>
            <InlineError text={removeError} style={{ marginTop: 8 }} />
            <Footnote>Only removes the connection on the phone; sessions on the computer stay.</Footnote>
          </>
        )}
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
