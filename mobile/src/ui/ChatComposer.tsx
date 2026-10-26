import { useEffect, useRef, useState, type ComponentRef, type ReactNode } from 'react'
import { Image, Keyboard, Platform, Pressable, ScrollView, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { LinearGradient } from 'expo-linear-gradient'
import { Text } from './Text'
import type { ApiClient } from '../core/client'
import { formatBytes, type ComposerAttachment } from '../core/chatComposer'
import { pickChatMaterial } from './chatMaterials'
import { Icon, Mono, Spinner, useColors } from './kit'
import { errorText } from './theme'
import type { RuntimeConfig } from '../core/types'
import {
  candidateTypeLabel,
  composerTrigger,
  filterComposerCandidates,
  insertComposerCandidate,
  loadComposerCandidates,
  mergeComposerReferences,
  type ComposerCandidate,
  type ComposerReference,
} from '../core/composerReferences'
import { BringSheet, type MaterialKind } from './compose/BringSheet'
import { Glyph } from './compose/glyphs'
import type { ComputerUse } from '../core/useComputerUse'
import {
  composerPlaceholder,
  runCapsuleA11y,
  runLockedNote,
  runShortcut,
  sendSlot,
  type RunCapsule,
} from './compose/runLogic'

/** web 预览里模拟 iPhone 的 Home 指示条高度，原生端用真实安全区。 */
export function useBottomInset() {
  const insets = useSafeAreaInsets()
  return Platform.OS === 'web' ? Math.max(insets.bottom, 34) : Math.max(insets.bottom, 12)
}

/** 键盘弹起时输入框贴着键盘，不再留 Home 指示条的空隙。 */
function useKeyboardVisible() {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      () => setVisible(true)
    )
    const hide = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setVisible(false)
    )
    return () => {
      show.remove()
      hide.remove()
    }
  }, [])
  return visible
}

/** 小胶囊：视觉 32 高，点按区域 44 高。 */
function Pill({
  label,
  accessibilityLabel,
  onPress,
  removable = true,
  icon,
  mono,
}: {
  label: string
  accessibilityLabel: string
  onPress(): void
  removable?: boolean
  icon?: ReactNode
  mono?: boolean
}) {
  const colors = useColors()
  const Body = mono ? Mono : Text
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={{ height: 44, justifyContent: 'center' }}
    >
      <View
        style={{
          height: 32,
          paddingLeft: 11,
          paddingRight: removable ? 8 : 11,
          borderRadius: 16,
          backgroundColor: colors.runTint,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
        }}
      >
        {icon}
        <Body numberOfLines={1} style={{ maxWidth: 180, fontSize: 13, fontWeight: '600', color: colors.run }}>
          {label}
        </Body>
        {removable ? <Icon name="x" size={13} color={colors.run} strokeWidth={2.6} /> : null}
      </View>
    </Pressable>
  )
}

function AttachmentChip({ attachment, onRemove }: { attachment: ComposerAttachment; onRemove(): void }) {
  const colors = useColors()
  const remove = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`移除 ${attachment.name}`}
      hitSlop={10}
      onPress={onRemove}
      style={{
        position: 'absolute',
        top: -6,
        right: -6,
        width: 22,
        height: 22,
        borderRadius: 11,
        backgroundColor: colors.ink,
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: `0 0 0 2px ${colors.card}`,
      }}
    >
      <Icon name="x" size={10} color={colors.bg} strokeWidth={3.5} />
    </Pressable>
  )
  if (attachment.type === 'image' && attachment.uri)
    return (
      <View style={{ width: 52, height: 52 }}>
        <Image
          accessibilityLabel={attachment.name}
          source={{ uri: attachment.uri }}
          style={{ width: 52, height: 52, borderRadius: 12, backgroundColor: colors.fill }}
        />
        {remove}
      </View>
    )
  return (
    <View
      style={{
        height: 52,
        maxWidth: 220,
        borderRadius: 12,
        backgroundColor: colors.fill,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
      }}
    >
      <Icon name={attachment.type === 'image' ? 'image' : 'file'} size={20} color={colors.ink2} />
      <View style={{ flexShrink: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: '500', color: colors.ink }}>
          {attachment.name}
        </Text>
        <Mono style={{ fontSize: 12, color: colors.ink3 }}>{formatBytes(attachment.bytes)}</Mono>
      </View>
      {remove}
    </View>
  )
}

/** `/` 和 `@` 触发的悬浮候选卡：每行右侧是类型标签。 */
function CandidateCard({
  candidates,
  loading,
  error,
  references,
  onChoose,
}: {
  candidates: ComposerCandidate[]
  loading: boolean
  error: string
  references: ComposerReference[]
  onChoose(candidate: ComposerCandidate): void
}) {
  const colors = useColors()
  return (
    <View
      style={{
        backgroundColor: colors.card,
        borderRadius: 18,
        overflow: 'hidden',
        boxShadow: `0 1px 2px rgba(28,25,23,0.06), 0 10px 28px rgba(28,25,23,0.14), 0 0 0 1px ${colors.hair}`,
      }}
    >
      <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 232 }} contentContainerStyle={{ padding: 6 }}>
        {loading ? (
          <View style={{ padding: 14 }}>
            <Spinner size={16} />
          </View>
        ) : error ? (
          <Text style={{ padding: 14, color: colors.err }}>{error}</Text>
        ) : candidates.length ? (
          candidates.map((candidate) => {
            const reference = candidate.reference
            const active =
              !!reference && references.some((value) => value.kind === reference.kind && value.id === reference.id)
            const token = `${reference ? '@' : '/'}${reference?.displayName || candidate.name}`
            return (
              <Pressable
                key={`${candidate.kind}:${candidate.name}`}
                accessibilityRole="button"
                accessibilityLabel={`使用 ${token}，${candidate.description}，${candidateTypeLabel(candidate)}`}
                accessibilityState={{ selected: active }}
                onPress={() => onChoose(candidate)}
                style={({ pressed }) => ({
                  minHeight: 48,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                  borderRadius: 12,
                  backgroundColor: pressed || active ? colors.runTint : 'transparent',
                })}
              >
                <Mono numberOfLines={1} style={{ flexShrink: 0, maxWidth: '45%', fontSize: 14, fontWeight: '500', color: active ? colors.run : colors.ink }}>
                  {token}
                </Mono>
                <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 14, color: colors.ink3 }}>
                  {candidate.description}
                </Text>
                {active ? <Icon name="check" size={16} color={colors.run} strokeWidth={2.4} /> : null}
                <View style={{ height: 22, paddingHorizontal: 7, borderRadius: 7, backgroundColor: colors.fill, justifyContent: 'center' }}>
                  <Text style={{ fontSize: 12, lineHeight: 16, color: colors.ink2 }}>{candidateTypeLabel(candidate)}</Text>
                </View>
              </Pressable>
            )
          })
        ) : (
          <Text style={{ padding: 14, color: colors.ink3 }}>没有匹配的技能或命令</Text>
        )}
      </ScrollView>
    </View>
  )
}

/** 运行胶囊：盾牌 + 「模型 · 强度」+ ⌄；运行中锁住时置灰带锁。 */
function RunPill({ run, onPress }: { run: ChatComposerRun; onPress(): void }) {
  const colors = useColors()
  const inactive = !!run.disabled || !!run.locked
  const tone =
    run.risk === 'danger'
      ? { bg: colors.errSoft, fg: colors.err, label: colors.err }
      : run.risk === 'attention'
        ? { bg: colors.attnSoft, fg: colors.attn, label: colors.attnInk }
        : { bg: colors.fill, fg: colors.ink2, label: colors.ink }
  const muted = !!run.locked
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={runCapsuleA11y(run)}
      accessibilityState={{ disabled: inactive }}
      aria-disabled={inactive}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => ({
        height: 44,
        flexShrink: 1,
        justifyContent: 'center',
        opacity: run.disabled && !run.locked ? 0.45 : pressed ? 0.7 : 1,
      })}
    >
      <View
        style={{
          height: 34,
          paddingHorizontal: 10,
          borderRadius: 17,
          backgroundColor: muted ? colors.fill : tone.bg,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <Icon name="shield" size={15} color={muted ? colors.ink3 : tone.fg} strokeWidth={2} />
        <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 13, fontWeight: '500', color: muted ? colors.ink3 : tone.label }}>
          {run.label}
        </Text>
        {run.locked ? (
          <Glyph name="lock" size={13} color={colors.ink3} strokeWidth={2.2} />
        ) : (
          <Icon name="chevron-down" size={12} color={colors.ink3} strokeWidth={2.4} />
        )}
      </View>
    </Pressable>
  )
}

export type ChatComposerRun = RunCapsule

/**
 * 新任务和追问共用的输入框：输入区在上，下面一行 ＋（带什么）…… 运行胶囊（怎么跑）+ 发送。
 * 已选的技能、团队、电脑和材料缩略图是输入区里的小胶囊。底部带一段向上渐隐，
 * 放在页面底部时内容可以在它下面滚动。
 */
export function ChatComposer({
  client,
  sessionId,
  workDir,
  runtime,
  draft,
  onDraft,
  references,
  onReferences,
  attachments,
  onAttachments,
  team,
  onTeam,
  computer,
  lean,
  empty,
  busy,
  queueing = false,
  disabled,
  run,
  onOpenRun,
  onSend,
  onStop,
  onError,
  above,
  caption,
  onHeight,
}: {
  client: ApiClient | null
  sessionId?: string
  workDir?: string
  runtime?: RuntimeConfig
  draft: string
  onDraft(value: string): void
  references: ComposerReference[]
  onReferences(value: ComposerReference[]): void
  attachments: ComposerAttachment[]
  onAttachments(value: ComposerAttachment[]): void
  team: boolean
  onTeam(value: boolean): void
  /** 「操作电脑」的状态与动作（useComputerUse）：输入框上的「电脑」胶囊和「＋」里的开关共用。 */
  computer: ComputerUse
  lean: boolean
  empty: boolean
  busy: boolean
  queueing?: boolean
  disabled: boolean
  run: ChatComposerRun
  onOpenRun(): void
  onSend(): void
  /** 运行中且输入框是空的，发送位变成停止键。 */
  onStop?(): void
  onError(message: string): void
  /** 输入框上方：通知、排队中的消息。 */
  above?: ReactNode
  /** 输入框上方的一行状态说明。 */
  caption?: ReactNode
  /** 整块（含渐隐区）的高度，页面给内容留底边距用。 */
  onHeight?(height: number): void
}) {
  const colors = useColors()
  const inset = useBottomInset()
  const keyboard = useKeyboardVisible()
  const input = useRef<ComponentRef<typeof TextInput>>(null)
  const [bringOpen, setBringOpen] = useState(false)
  const [selection, setSelection] = useState({ start: draft.length, end: draft.length })
  const [candidates, setCandidates] = useState<ComposerCandidate[]>([])
  const [catalogError, setCatalogError] = useState('')
  const [loading, setLoading] = useState(false)
  const [picking, setPicking] = useState<MaterialKind | null>(null)
  const trigger = composerTrigger(draft, selection.start, selection.end)
  const showCandidates = !bringOpen && !disabled && !!trigger
  const needsCatalog = bringOpen || showCandidates
  const providerId = runtime?.providerId
  const hasRuntime = !!runtime
  useEffect(() => {
    if (!client || !needsCatalog) return
    const controller = new AbortController()
    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        setLoading(true)
        setCatalogError('')
        setCandidates([])
      }
    })
    loadComposerCandidates(
      client,
      { sessionId, workDir, runtime: hasRuntime ? { providerId: providerId ?? null, modelId: '' } : undefined, lean },
      controller.signal
    )
      .then((value) => {
        if (!controller.signal.aborted) setCandidates(value)
      })
      .catch((e) => {
        if (!controller.signal.aborted) setCatalogError(errorText(e))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [client, sessionId, workDir, providerId, hasRuntime, lean, needsCatalog])

  const hasContent = !!draft.trim() || attachments.length > 0 || references.length > 0
  const slot = sendSlot({
    hasContent,
    busy,
    queueing,
    disabled,
    picking: !!picking,
    canStop: !!onStop,
    starting: !sessionId,
  })

  function choose(candidate: ComposerCandidate) {
    const next = insertComposerCandidate(draft, showCandidates ? trigger : null, candidate)
    onDraft(next.text)
    if (candidate.reference) onReferences(mergeComposerReferences(references, [candidate.reference]))
    setSelection({ start: next.cursor, end: next.cursor })
    requestAnimationFrame(() => input.current?.focus())
  }
  async function pick(kind: MaterialKind) {
    if (picking) return
    setPicking(kind)
    try {
      const next = await pickChatMaterial(kind)
      onAttachments([...attachments, ...next])
      if (next.length) setBringOpen(false)
    } catch (e) {
      onError(errorText(e))
    } finally {
      setPicking(null)
    }
  }
  function press() {
    if (slot.kind === 'stop') return onStop?.()
    if (runShortcut(draft, references.length > 0 || attachments.length > 0)) {
      onDraft('')
      onOpenRun()
      return
    }
    onSend()
  }
  function openBring() {
    input.current?.blur()
    setBringOpen(true)
  }

  const chips = attachments.length > 0 || references.length > 0 || team || (computer.enabled && !lean)
  return (
    <View
      onLayout={(event) => onHeight?.(event.nativeEvent.layout.height)}
      style={{ paddingTop: 22, paddingHorizontal: 12, paddingBottom: keyboard ? 10 : inset, gap: 8 }}
    >
      <LinearGradient
        pointerEvents="none"
        colors={[`${colors.bg}00`, colors.bg]}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 22 }}
      />
      <View
        pointerEvents="none"
        style={{ position: 'absolute', top: 22, left: 0, right: 0, bottom: 0, backgroundColor: colors.bg }}
      />
      {above}
      {caption ? (
        typeof caption === 'string' ? (
          <Text style={{ paddingHorizontal: 8, fontSize: 12, lineHeight: 16, color: colors.ink3 }}>{caption}</Text>
        ) : (
          caption
        )
      ) : null}
      {showCandidates ? (
        <CandidateCard
          candidates={filterComposerCandidates(candidates, trigger)}
          loading={loading}
          error={catalogError}
          references={references}
          onChoose={choose}
        />
      ) : null}
      <View
        style={{
          backgroundColor: colors.card,
          borderRadius: 22,
          paddingHorizontal: 6,
          paddingTop: chips ? 10 : 6,
          paddingBottom: 4,
          boxShadow: `0 1px 2px rgba(28,25,23,0.05), 0 6px 20px rgba(28,25,23,0.10), 0 0 0 1px ${colors.hair}`,
        }}
      >
        {chips ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            style={{ flexGrow: 0 }}
            contentContainerStyle={{ alignItems: 'center', gap: 10, paddingTop: 8, paddingBottom: 2, paddingLeft: 10, paddingRight: 14 }}
          >
            {attachments.map((attachment) => (
              <AttachmentChip
                key={attachment.id}
                attachment={attachment}
                onRemove={() => onAttachments(attachments.filter((value) => value.id !== attachment.id))}
              />
            ))}
            {references.map((reference) => (
              <Pill
                key={`${reference.kind}:${reference.id}`}
                label={`@${reference.displayName || reference.name}`}
                accessibilityLabel={`移除技能 ${reference.displayName || reference.name}`}
                onPress={() =>
                  onReferences(references.filter((value) => value.kind !== reference.kind || value.id !== reference.id))
                }
              />
            ))}
            {team ? (
              <Pill
                label="团队"
                accessibilityLabel="关闭这条消息的 Agent 团队"
                onPress={() => onTeam(false)}
                icon={<Icon name="users" size={14} color={colors.run} strokeWidth={2} />}
              />
            ) : null}
            {computer.enabled && !lean ? (
              <Pill
                label="操作电脑"
                accessibilityLabel="操作电脑已开启，打开「＋」查看"
                removable={false}
                onPress={() => setBringOpen(true)}
                icon={<Glyph name="monitor" size={14} color={colors.run} strokeWidth={2} />}
              />
            ) : null}
          </ScrollView>
        ) : null}
        <TextInput
          ref={input}
          accessibilityLabel={sessionId ? '消息' : '新任务内容'}
          value={draft}
          multiline
          editable={!disabled}
          onChangeText={(value) => {
            const cursor = Math.min(value.length, Math.max(0, selection.end + value.length - draft.length))
            onDraft(value)
            setSelection({ start: cursor, end: cursor })
          }}
          selection={{
            start: Math.min(selection.start, draft.length),
            end: Math.min(selection.end, draft.length),
          }}
          onSelectionChange={({ nativeEvent }) => setSelection(nativeEvent.selection)}
          placeholder={composerPlaceholder({ queueing, empty })}
          placeholderTextColor={colors.ink3}
          {...(Platform.OS === 'web' ? { rows: 1 } : {})}
          style={{
            minHeight: 44,
            maxHeight: 136,
            paddingHorizontal: 10,
            paddingTop: 10,
            paddingBottom: 10,
            fontSize: 16,
            lineHeight: 23,
            color: colors.ink,
          }}
        />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="添加：技能、命令、材料"
            accessibilityState={{ expanded: bringOpen }}
            onPress={openBring}
            style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
          >
            <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: colors.fill, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="plus" size={20} color={colors.ink} strokeWidth={2} />
            </View>
          </Pressable>
          <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
            {run.locked ? (
              <Text numberOfLines={1} style={{ flexShrink: 0, textAlign: 'right', fontSize: 12, lineHeight: 16, color: colors.ink3 }}>
                {runLockedNote}
              </Text>
            ) : null}
            <RunPill run={run} onPress={onOpenRun} />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={slot.label}
            accessibilityState={{ disabled: !slot.enabled }}
            disabled={!slot.enabled}
            onPress={press}
            style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
          >
            <View
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                backgroundColor: slot.enabled ? colors.btn : colors.fill,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {slot.kind === 'stop' ? (
                <Icon name="stop" size={14} color={colors.btnInk} />
              ) : (
                <Icon name="arrow-up" size={18} color={slot.enabled ? colors.btnInk : colors.faint} strokeWidth={2.4} />
              )}
            </View>
          </Pressable>
        </View>
      </View>
      <BringSheet
        visible={bringOpen}
        onClose={() => setBringOpen(false)}
        client={client}
        workDir={workDir}
        lean={lean}
        candidates={candidates}
        loading={loading}
        error={catalogError}
        references={references}
        draft={draft}
        picking={picking}
        onPick={(kind) => void pick(kind)}
        team={team}
        onTeam={onTeam}
        computer={computer}
        onApply={(next) => {
          onDraft(next.draft)
          onReferences(next.references)
          setSelection({ start: next.draft.length, end: next.draft.length })
          setBringOpen(false)
          requestAnimationFrame(() => input.current?.focus())
        }}
      />
    </View>
  )
}
