import { useEffect, useRef, useState } from 'react'
import { Alert, Pressable, View } from 'react-native'
import { Text } from '../Text'
import { DetentSheet } from '../DetentSheet'
import { Button, Callout, Footnote, Icon, InlineError, Segmented, Spinner, useColors } from '../kit'
import { Glyph } from './glyphs'
import { EffortSlider } from './EffortSlider'
import type { ApiClient } from '../../core/client'
import type { PermissionMode, RuntimeConfig } from '../../core/types'
import { currentModelEfforts, effortUnavailableReason } from '../../core/runtimeCatalog'
import { modes, profileDescription, profileName } from '../modes'
import { RuntimeSheet, useRuntimeChoice, type Model } from '../RuntimePicker'
import {
  effortSegments,
  effortToCommit,
  modeChange,
  modeConfirmation,
  modelRowLabel,
  runSheetReasons,
  type RunProfile,
} from './runLogic'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const colors = useColors()
  return (
    <View>
      <Text
        accessibilityRole="header"
        style={{ paddingTop: 14, paddingBottom: 6, paddingHorizontal: 4, fontSize: 13, lineHeight: 18, fontWeight: '600', color: colors.ink2 }}
      >
        {title}
      </Text>
      {children}
    </View>
  )
}

function Tag({ text, tone }: { text: string; tone: 'attn' | 'err' }) {
  const colors = useColors()
  return (
    <View style={{ borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1, backgroundColor: tone === 'err' ? colors.errSoft : colors.attnSoft }}>
      <Text style={{ fontSize: 12, lineHeight: 16, fontWeight: '600', color: tone === 'err' ? colors.err : colors.attn }}>{text}</Text>
    </View>
  )
}

function ModeRow({ id, title, description, selected, disabled, onPress }: {
  id: PermissionMode
  title: string
  description: string
  selected: boolean
  disabled?: string
  onPress(): void
}) {
  const colors = useColors()
  const danger = id === 'bypassPermissions'
  const tint = danger ? colors.err : colors.run
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={`${title}${id === 'auto' ? ', requires consent' : danger ? ', risky' : ''}, ${disabled ?? description}`}
      accessibilityState={{ checked: selected, disabled: !!disabled }}
      aria-checked={selected}
      disabled={!!disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 54,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 14,
        paddingVertical: 6,
        opacity: disabled ? 0.45 : 1,
        backgroundColor: pressed ? colors.fill : 'transparent',
      })}
    >
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 11,
          backgroundColor: selected ? tint : 'transparent',
          boxShadow: selected ? undefined : `inset 0 0 0 1.5px ${danger ? `${colors.err}8C` : colors.chevron}`,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {selected ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#FFFFFF' }} /> : null}
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          {danger ? <Glyph name="shield-alert" size={16} color={colors.err} strokeWidth={2} /> : null}
          <Text style={{ fontSize: 16, lineHeight: 21, fontWeight: '500', color: danger ? colors.err : colors.ink }}>{title}</Text>
          {id === 'auto' ? <Tag text="Requires consent" tone="attn" /> : null}
          {danger ? <Tag text="Risky" tone="err" /> : null}
        </View>
        <Text numberOfLines={1} style={{ fontSize: 13, lineHeight: 18, color: colors.ink3 }}>{disabled ?? description}</Text>
      </View>
    </Pressable>
  )
}

/**
 * How to run: permissions, model and thinking effort live in one sheet (agent team and computer use are in "+", consistent with desktop).
 * Controlled component — the callbacks passed by the page actually change session settings; this only renders and forwards.
 */
export function RunSheet({
  visible,
  onClose,
  client,
  mode,
  onMode,
  runtime,
  onRuntime,
  lean,
  disabled,
  warning,
  error,
  profile,
  workDir,
}: {
  visible: boolean
  onClose(): void
  client: ApiClient | null
  mode?: PermissionMode
  onMode(mode: PermissionMode): void
  runtime?: RuntimeConfig
  onRuntime(value: RuntimeConfig, model?: Model): void
  lean: boolean
  /** Reasons each item cannot be changed now; when set it is greyed out and shows this text. */
  disabled?: { mode?: string; runtime?: string }
  /** e.g. changing the model stops background tasks. */
  warning?: string
  error?: string
  /** New task page only: run tier (full tools / light). */
  profile?: RunProfile
  /** The directory stated in the confirmation when switching to full access. */
  workDir?: string
}) {
  const colors = useColors()
  const [modelOpen, setModelOpen] = useState(false)
  // Every open rereads sources and settings from the computer, dropping the last unsaved selection.
  const [shown, setShown] = useState(visible)
  const [epoch, setEpoch] = useState(0)
  // Thinking effort while sliding is only recorded here and committed when the sheet closes (see effortToCommit).
  const [effortDraft, setEffortDraft] = useState<string>()
  if (shown !== visible) {
    setShown(visible)
    if (visible) {
      setEpoch(epoch + 1)
      setEffortDraft(undefined)
    }
  }
  const reasons = runSheetReasons({ lean, teams: 'on', disabled })
  function close() {
    const next = effortToCommit({ runtime, draft: effortDraft, blocked: reasons.runtime })
    if (next) onRuntime(next)
    onClose()
  }
  // While the confirmation is open a turn may have started: decide by the latest state at the moment of confirmation, using the latest callbacks.
  const latest = useRef({ blocked: reasons.mode, onMode })
  useEffect(() => {
    latest.current = { blocked: reasons.mode, onMode }
  })
  function chooseMode(next: PermissionMode) {
    const change = modeChange(next, mode)
    if (change === 'apply') onMode(next)
    if (change !== 'confirm') return
    const copy = modeConfirmation(next === 'auto' ? 'auto' : 'bypassPermissions', workDir)
    Alert.alert(copy.title, copy.message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: copy.confirm,
        style: copy.destructive ? 'destructive' : 'default',
        onPress: () => {
          if (!latest.current.blocked) latest.current.onMode(next)
        },
      },
    ])
  }
  // Here it is only used to look up capabilities of the current provider and model; without effort, so changing effort does not reread the whole catalog and flash the slider into a spinner.
  const choice = useRuntimeChoice({
    client,
    initial: runtime ? { providerId: runtime.providerId, modelId: runtime.modelId } : undefined,
    active: visible,
    epoch,
  })
  // Model already chosen: effort tiers follow it, and generic tiers are given even when the model list cannot be read, without making the user reselect a model first.
  const current =
    runtime && (choice.catalogReady || choice.error) ? currentModelEfforts(choice.models, runtime.modelId) : undefined
  const efforts = effortSegments({
    canSetEffort: choice.canSetEffort,
    authReady: choice.source?.auth === 'ready',
    efforts: current?.efforts,
  })
  const effortWaiting =
    !!runtime && (choice.loading || (!choice.catalogReady && !choice.error && choice.source?.auth === 'ready'))
  const effortValue = runtime?.effortLevel ?? current?.defaultEffort

  return (
    <DetentSheet
      visible={visible}
      onClose={close}
      title="Run mode"
      initialDetent="full"
      footer={<Button title="Done" size="lg" onPress={close} />}
    >
      <Section title="Permissions">
        <View accessibilityRole="radiogroup" accessibilityLabel="Permissions" style={{ backgroundColor: colors.card, borderRadius: 16, overflow: 'hidden' }}>
          {modes.map((item, index) => (
            <View key={item.id}>
              {index > 0 ? <View style={{ height: 1, backgroundColor: colors.hair, marginLeft: 48 }} /> : null}
              <ModeRow
                id={item.id}
                title={item.title}
                description={item.description}
                selected={(mode ?? 'default') === item.id}
                disabled={reasons.mode ?? (item.id === 'plan' ? reasons.plan : undefined)}
                onPress={() => chooseMode(item.id)}
              />
            </View>
          ))}
        </View>
        {reasons.mode ? <Footnote>{reasons.mode}</Footnote> : null}
      </Section>

      <Section title="Model">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Model: ${modelRowLabel({ source: choice.source?.name, model: choice.model?.name ?? runtime?.modelId })}`}
          accessibilityState={{ disabled: !!reasons.runtime || !client }}
          disabled={!!reasons.runtime || !client}
          onPress={() => setModelOpen(true)}
          style={({ pressed }) => ({
            height: 52,
            borderRadius: 16,
            backgroundColor: colors.card,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            paddingHorizontal: 14,
            opacity: reasons.runtime || !client ? 0.5 : pressed ? 0.7 : 1,
          })}
        >
          <Icon name="cpu" size={20} color={colors.ink2} />
          <Text numberOfLines={1} style={{ flex: 1, fontSize: 16, color: colors.ink }}>
            {modelRowLabel({ source: choice.source?.name, model: choice.model?.name ?? runtime?.modelId })}
          </Text>
          <Icon name="chevron-right" size={16} color={colors.chevron} strokeWidth={2.2} />
        </Pressable>
        {reasons.runtime ? <Footnote>{reasons.runtime}</Footnote> : null}
        {warning ? <Callout style={{ marginTop: 8 }}>{warning}</Callout> : null}
      </Section>

      <Section title="Thinking effort">
        {efforts.length ? (
          <EffortSlider
            label="Thinking effort"
            disabled={!!reasons.runtime}
            options={efforts}
            value={effortDraft ?? effortValue ?? ''}
            onChange={(value) => {
              if (efforts.some((option) => option.value === value)) setEffortDraft(value)
            }}
          />
        ) : effortWaiting ? (
          <View style={{ height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Spinner size={18} />
          </View>
        ) : (
          <Footnote style={{ paddingTop: 0 }}>
            {!runtime ? 'Choose a model first, then adjust thinking effort.' : effortUnavailableReason(choice)}
          </Footnote>
        )}
      </Section>

      {profile ? (
        <Section title="Run tier">
          <Segmented
            label="Run tier"
            height={44}
            disabled={!!profile.disabled}
            options={[
              { label: profileName('standard'), value: 'standard' as const },
              { label: profileName('lean'), value: 'lean' as const },
            ]}
            value={profile.value}
            onChange={profile.onChange}
          />
          <Footnote>{profile.disabled ?? profileDescription(profile.value)}</Footnote>
        </Section>
      ) : null}

      <InlineError text={error} />

      <RuntimeSheet
        visible={modelOpen}
        onClose={() => setModelOpen(false)}
        client={client}
        initial={runtime}
        warning={warning}
        onApply={(value, model) => {
          setModelOpen(false)
          // When the model changes the new model's effort wins and the previously slid draft is discarded.
          setEffortDraft(undefined)
          onRuntime(value, model)
        }}
      />
    </DetentSheet>
  )
}
