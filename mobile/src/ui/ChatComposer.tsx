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
import { isComputerUseReference, withComputerUseReference } from '../core/computerUse'
import {
  composerPlaceholder,
  runCapsuleA11y,
  runShortcut,
  sendSlot,
  type RunCapsule,
} from './compose/runLogic'
import { ImagePreview } from './chat/ImagePreview'
import { attachmentImageSelection, attachmentImageUri, type ImagePreviewSelection } from './chat/attachmentPreview'
import { useVoiceDictation } from '../core/useVoiceDictation'
import { VoiceFeedback, VoiceMicrophone, VoiceRecordingBar } from './compose/VoiceInput'
import { simulatedPhoneChrome } from './webChrome'
import { subscribeWebKeyboard } from './webKeyboard'

/** Web preview simulates the iPhone home indicator height; native and H5 use the real safe area. */
export function useBottomInset() {
  const insets = useSafeAreaInsets()
  return simulatedPhoneChrome ? Math.max(insets.bottom, 34) : Math.max(insets.bottom, 12)
}

/** When the keyboard is up the input sits against it without leaving the home indicator gap. */
function useKeyboardVisible() {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (Platform.OS === 'web') return subscribeWebKeyboard(setVisible)
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

/** Small capsule: visual height 32, tap area 44. */
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

function AttachmentChip({ attachment, onRemove, onPreview }: { attachment: ComposerAttachment; onRemove(): void; onPreview(): void }) {
  const colors = useColors()
  const remove = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Remove ${attachment.name}`}
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
  const uri = attachmentImageUri(attachment)
  if (uri)
    return (
      <View style={{ width: 52, height: 52 }}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Preview ${attachment.name}`} onPress={onPreview}>
          <Image
            source={{ uri }}
            style={{ width: 52, height: 52, borderRadius: 12, backgroundColor: colors.fill }}
          />
        </Pressable>
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

/** `/` and the floating suggestion card triggered by `@`: each row has a type label on the right. */
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
                accessibilityLabel={`Use ${token}, ${candidate.description}, ${candidateTypeLabel(candidate)}`}
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
          <Text style={{ padding: 14, color: colors.ink3 }}>No matching skills or commands</Text>
        )}
      </ScrollView>
    </View>
  )
}

/**
 * Run capsule: shield + "model · effort" + ⌄, without background. Permission tiers are not distinguished by color: full access switches to a shield with an exclamation mark, 
 * with a separate confirmation when switching to it. When locked while running the text fades and shows a lock.
 */
function RunPill({ run, onPress }: { run: ChatComposerRun; onPress(): void }) {
  const colors = useColors()
  const inactive = !!run.disabled || !!run.locked
  const muted = !!run.locked
  const iconColor = muted ? colors.ink3 : colors.ink2
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
      <View style={{ height: 34, paddingHorizontal: 6, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {run.risk === 'danger' ? (
          <Glyph name="shield-alert" size={15} color={iconColor} strokeWidth={2} />
        ) : (
          <Icon name="shield" size={15} color={iconColor} strokeWidth={2} />
        )}
        <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 13, fontWeight: '500', color: muted ? colors.ink3 : colors.ink }}>
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
 * Input shared by new task and follow-up: input area on top, below one row of + (bring) … run capsule (how to run) + send.
 * Selected skills, team, computer and material thumbnails are small capsules in the input area. The bottom has an upward fade, 
 * so content can scroll beneath it when placed at the bottom of the page.
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
  background = false,
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
  /** Computer authorization; the current message's selection lives in references. */
  computer: ComputerUse
  lean: boolean
  empty: boolean
  busy: boolean
  /** This turn ended while team members are still running: with no content this key is stop. */
  background?: boolean
  queueing?: boolean
  disabled: boolean
  run: ChatComposerRun
  onOpenRun(): void
  /** Returns true when the page took the draft and is clearing it. */
  onSend(): boolean | void
  /** While running with an empty input, the send slot becomes the stop key. */
  onStop?(): void
  onError(message: string): void
  /** Above the input: notices and queued messages. */
  above?: ReactNode
  /** One line of status above the input. */
  caption?: ReactNode
  /** Height of the whole block (including fade), used by the page for content bottom padding. */
  onHeight?(height: number): void
}) {
  const colors = useColors()
  const inset = useBottomInset()
  const keyboard = useKeyboardVisible()
  const input = useRef<ComponentRef<typeof TextInput>>(null)
  const [bringOpen, setBringOpen] = useState(false)
  const [selection, setSelection] = useState({ start: draft.length, end: draft.length })
  // The web version only hands the caret to the input when the input moves it itself (inserting suggestions, voice, sheets): 
  // setting the caret on every keystroke interrupts composition in IMEs such as pinyin. Native stays controlled as usual.
  const [caret, setCaret] = useState<{ start: number; end: number } | null>(null)
  const moveCaret = (position: number) => {
    const next = { start: position, end: position }
    setSelection(next)
    setCaret(next)
  }
  // React Native applies the page's clear after a send only when JS has seen every change
  // the field made (it compares event counts), and Android drops it otherwise. Two ways a
  // keyboard commit beats it, both seen on an emulator with a fast last key and send tap:
  // - the commit lands while the finger is on the button: React renders it only after the
  //   tap, so the tap would send without it and clear against a stale count. `unrendered`
  //   holds the field's change until a render shows it; such a send waits for that render.
  // - the commit lands after the clear left JS: the field keeps the sent text plus the key
  //   and reports both. `sent` holds the text a send took from the focused field until the
  //   field shows it cleared (caret back at 0) or reports text no longer starting with it.
  const unrendered = useRef<string | null>(null)
  const sendWhenRendered = useRef(false)
  const sent = useRef<string | null>(null)
  const [candidates, setCandidates] = useState<ComposerCandidate[]>([])
  const [catalogError, setCatalogError] = useState('')
  const [loading, setLoading] = useState(false)
  const [picking, setPicking] = useState<MaterialKind | null>(null)
  const [preview, setPreview] = useState<ImagePreviewSelection | null>(null)
  const voiceCanSend = !disabled && (!busy || queueing)
  const voice = useVoiceDictation({
    client,
    contextKey: `${client?.host.id ?? ''}:${sessionId ?? 'new'}:${workDir ?? ''}`,
    draft,
    selection,
    blocked: disabled || !!picking,
    canSend: voiceCanSend,
    onDraft: (text, cursor) => {
      onDraft(text)
      moveCaret(cursor)
    },
    onSubmit: onSend,
    focus: () => requestAnimationFrame(() => input.current?.focus()),
  })
  const referenceState = useRef({ references, onReferences })
  useEffect(() => {
    referenceState.current = { references, onReferences }
  }, [references, onReferences])
  const trigger = composerTrigger(draft, selection.start, selection.end)
  const showCandidates = !voice.live && !bringOpen && !disabled && !!trigger
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
    background,
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
    moveCaret(next.cursor)
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
    // Once only: a page that does not take the change must not hold the send forever.
    if (!sendWhenRendered.current && unrendered.current !== null && unrendered.current !== draft) {
      sendWhenRendered.current = true
      return
    }
    sendWhenRendered.current = false
    if (slot.kind === 'stop') return onStop?.()
    if (runShortcut(draft, references.length > 0 || attachments.length > 0)) {
      onDraft('')
      onOpenRun()
      return
    }
    const taken = onSend() === true
    // Only a focused field can have a key in flight, and only a caret away from 0 shows
    // the clear landing (selection events need focus and a change).
    sent.current =
      taken &&
      Platform.OS === 'android' &&
      draft &&
      input.current?.isFocused() &&
      (selection.start > 0 || selection.end > 0)
        ? draft
        : null
  }
  /** A change reported by the field; keys typed on top of the sent text keep only themselves. */
  function fieldText(value: string) {
    const taken = sent.current
    if (taken === null) return value
    if (value.startsWith(taken)) return value.slice(taken.length)
    sent.current = null
    return value
  }
  useEffect(() => {
    // Effects of an older render can run after newer changes were reported.
    if (unrendered.current !== draft) return
    unrendered.current = null
    if (sendWhenRendered.current) press()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per rendered draft
  }, [draft])
  function openBring() {
    input.current?.blur()
    setBringOpen(true)
  }

  const chips = attachments.length > 0 || references.length > 0 || team
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
            {attachments.map((attachment, index) => (
              <AttachmentChip
                key={attachment.id}
                attachment={attachment}
                onRemove={() => onAttachments(attachments.filter((value) => value.id !== attachment.id))}
                onPreview={() => {
                  Keyboard.dismiss()
                  setPreview(attachmentImageSelection(attachments, index))
                }}
              />
            ))}
            {references.map((reference) => (
              <Pill
                key={`${reference.kind}:${reference.id}`}
                label={isComputerUseReference(reference) ? 'Computer use' : `@${reference.displayName || reference.name}`}
                accessibilityLabel={isComputerUseReference(reference) ? 'Remove computer use' : `Remove skill ${reference.displayName || reference.name}`}
                onPress={() =>
                  onReferences(references.filter((value) => value.kind !== reference.kind || value.id !== reference.id))
                }
                icon={isComputerUseReference(reference) ? <Glyph name="monitor" size={14} color={colors.run} strokeWidth={2} /> : undefined}
              />
            ))}
            {team ? (
              <Pill
                label="Team"
                accessibilityLabel="Turn off the agent team for this message"
                onPress={() => onTeam(false)}
                icon={<Icon name="users" size={14} color={colors.run} strokeWidth={2} />}
              />
            ) : null}
          </ScrollView>
        ) : null}
        <TextInput
          ref={input}
          accessibilityLabel={sessionId ? 'Messages' : 'New task content'}
          value={draft}
          multiline
          editable={!disabled && !voice.live}
          onChangeText={(reported) => {
            voice.edited()
            const value = fieldText(reported)
            const cursor =
              value === reported
                ? Math.min(value.length, Math.max(0, selection.end + value.length - draft.length))
                : value.length
            unrendered.current = value
            onDraft(value)
            setSelection({ start: cursor, end: cursor })
            setCaret(null)
          }}
          selection={
            Platform.OS === 'web'
              ? caret ?? undefined
              : {
                  start: Math.min(selection.start, draft.length),
                  end: Math.min(selection.end, draft.length),
                }
          }
          onSelectionChange={({ nativeEvent }) => {
            // The caret back at 0 after a send: the clear landed.
            if (nativeEvent.selection.start === 0 && nativeEvent.selection.end === 0) sent.current = null
            setSelection(nativeEvent.selection)
            setCaret(null)
          }}
          placeholder={composerPlaceholder({ queueing, empty })}
          placeholderTextColor={colors.ink3}
          {...(Platform.OS === 'web' ? { rows: 1 } : {})}
          style={{
            // Keep the draft and caret mounted while the recording surface
            // takes its place; completion restores this same editable field.
            display: voice.live ? 'none' : 'flex',
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
        <VoiceFeedback voice={voice} blocked={disabled} onError={onError} />
        {voice.live ? <VoiceRecordingBar voice={voice} canSend={voiceCanSend} /> : <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add: skills, commands, materials"
            accessibilityState={{ expanded: bringOpen }}
            onPress={openBring}
            style={({ pressed }) => ({
              width: 44,
              height: 44,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.5 : 1,
            })}
          >
            <Icon name="plus" size={22} color={colors.ink} strokeWidth={2} />
          </Pressable>
          <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
            <RunPill run={run} onPress={onOpenRun} />
          </View>
          <VoiceMicrophone
            blocked={!client || disabled || !!picking}
            onPress={() => {
              input.current?.blur()
              Keyboard.dismiss()
              void voice.start()
            }}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={slot.label}
            accessibilityState={{ disabled: !slot.enabled }}
            disabled={!slot.enabled}
            onPress={press}
            style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
          >
            {/* Always a solid ink circle: tapping with no content does nothing and it does not turn grey; it fades only when there is content that cannot be sent (disconnected, configuration pending). */}
            <View
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                backgroundColor: colors.btn,
                opacity: slot.kind === 'blocked' ? 0.35 : 1,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {slot.kind === 'stop' ? (
                <Icon name="stop" size={14} color={colors.btnInk} />
              ) : (
                <Icon name="arrow-up" size={18} color={colors.btnInk} strokeWidth={2.4} />
              )}
            </View>
          </Pressable>
        </View>}
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
        onComputerSelected={(value) => {
          const current = referenceState.current
          current.onReferences(withComputerUseReference(current.references, value))
        }}
        onApply={(next) => {
          onDraft(next.draft)
          onReferences(next.references)
          moveCaret(next.draft.length)
          setBringOpen(false)
          requestAnimationFrame(() => input.current?.focus())
        }}
      />
      {preview ? <ImagePreview {...preview} onClose={() => setPreview(null)} /> : null}
    </View>
  )
}
