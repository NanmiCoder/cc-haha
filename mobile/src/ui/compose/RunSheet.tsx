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
      accessibilityLabel={`${title}${id === 'auto' ? '，需同意' : danger ? '，有风险' : ''}，${disabled ?? description}`}
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
          {id === 'auto' ? <Tag text="需同意" tone="attn" /> : null}
          {danger ? <Tag text="有风险" tone="err" /> : null}
        </View>
        <Text numberOfLines={1} style={{ fontSize: 13, lineHeight: 18, color: colors.ink3 }}>{disabled ?? description}</Text>
      </View>
    </Pressable>
  )
}

/**
 * 怎么跑：权限、模型、思考强度放在同一张底单里（Agent 团队和操作电脑在「＋」里，和桌面端一致）。
 * 受控组件——真正改会话设置的是页面传进来的回调，这里只负责呈现和转发。
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
  /** 各项现在不能改的原因；有值就置灰并显示这段文字。 */
  disabled?: { mode?: string; runtime?: string }
  /** 例如换模型会停掉后台任务。 */
  warning?: string
  error?: string
  /** 新任务页专有：运行档位（完整工具 / 轻量）。 */
  profile?: RunProfile
  /** 切到全权限时确认框里写明的目录。 */
  workDir?: string
}) {
  const colors = useColors()
  const [modelOpen, setModelOpen] = useState(false)
  // 每次打开都重读电脑上的来源和设置，丢掉上一次没保存的选择。
  const [shown, setShown] = useState(visible)
  const [epoch, setEpoch] = useState(0)
  // 滑动中的思考强度只记在这里，关掉底单时才提交（见 effortToCommit）。
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
  // 确认框开着时这一轮可能已经开始：确认那一刻按最新状态判断，用最新的回调。
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
      { text: '取消', style: 'cancel' },
      {
        text: copy.confirm,
        style: copy.destructive ? 'destructive' : 'default',
        onPress: () => {
          if (!latest.current.blocked) latest.current.onMode(next)
        },
      },
    ])
  }
  // 这里只用它查当前供应商和模型的能力；不带强度，改强度时不会重读整个目录、让滑块闪成转圈。
  const choice = useRuntimeChoice({
    client,
    initial: runtime ? { providerId: runtime.providerId, modelId: runtime.modelId } : undefined,
    active: visible,
    epoch,
  })
  // 模型已经选定：强度档位跟着它走，读不到模型列表时也给通用档位，不让用户先去重选模型。
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
      title="运行方式"
      initialDetent="full"
      footer={<Button title="完成" size="lg" onPress={close} />}
    >
      <Section title="权限">
        <View accessibilityRole="radiogroup" accessibilityLabel="权限" style={{ backgroundColor: colors.card, borderRadius: 16, overflow: 'hidden' }}>
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

      <Section title="模型">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`模型：${modelRowLabel({ source: choice.source?.name, model: choice.model?.name ?? runtime?.modelId })}`}
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

      <Section title="思考强度">
        {efforts.length ? (
          <EffortSlider
            label="思考强度"
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
            {!runtime ? '先选定模型，再调思考强度。' : effortUnavailableReason(choice)}
          </Footnote>
        )}
      </Section>

      {profile ? (
        <Section title="运行档位">
          <Segmented
            label="运行档位"
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
          // 换了模型就以新模型的强度为准，之前滑的草稿作废。
          setEffortDraft(undefined)
          onRuntime(value, model)
        }}
      />
    </DetentSheet>
  )
}
