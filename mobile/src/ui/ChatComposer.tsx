import { useEffect, useRef, useState, type ComponentRef, type ReactNode } from 'react'
import { Image, Keyboard, Platform, Pressable, ScrollView, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { LinearGradient } from 'expo-linear-gradient'
import { Text } from './Text'
import type { ApiClient } from '../core/client'
import {
  formatBytes,
  type ComposerAttachment,
} from '../core/chatComposer'
import { pickChatMaterial } from './chatMaterials'
import {
  Icon,
  Mono,
  Button,
  Sheet,
  Spinner,
  Switch,
  useColors,
  type IconName,
} from './kit'
import { errorText } from './theme'
import type { RuntimeConfig } from '../core/types'
import { composerTrigger, insertComposerCandidate, loadComposerCandidates, mergeComposerReferences, type ComposerCandidate, type ComposerReference } from '../core/composerReferences'
import { ComputerUseControl } from './ComputerUseControl'

type MaterialKind = 'photos' | 'camera' | 'file'
const tiles: { kind: MaterialKind; title: string; icon: IconName }[] = [
  { kind: 'photos', title: '相册', icon: 'image' },
  { kind: 'camera', title: '拍照', icon: 'camera' },
  { kind: 'file', title: '文件', icon: 'file' },
]

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

function AttachmentStrip({
  attachments,
  onRemove,
}: {
  attachments: ComposerAttachment[]
  onRemove(id: string): void
}) {
  const colors = useColors()
  const remove = (attachment: ComposerAttachment) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`移除 ${attachment.name}`}
      hitSlop={8}
      onPress={() => onRemove(attachment.id)}
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
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={{ marginTop: -6 }}
      contentContainerStyle={{ gap: 8, paddingTop: 8, paddingLeft: 6, paddingRight: 12, paddingBottom: 4 }}
    >
      {attachments.map((attachment) =>
        attachment.type === 'image' && attachment.uri ? (
          <View key={attachment.id} style={{ width: 56, height: 56 }}>
            <Image
              accessibilityLabel={attachment.name}
              source={{ uri: attachment.uri }}
              style={{ width: 56, height: 56, borderRadius: 12, backgroundColor: colors.fill }}
            />
            {remove(attachment)}
          </View>
        ) : (
          <View
            key={attachment.id}
            style={{
              height: 56,
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
            {remove(attachment)}
          </View>
        )
      )}
    </ScrollView>
  )
}

function SkillRow({
  skill,
  active,
  onPress,
  numberOfLines = 1,
}: {
  skill: ComposerCandidate
  active: boolean
  onPress(): void
  numberOfLines?: number
}) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`使用 ${skill.reference ? '@' : '/'}${skill.reference?.displayName || skill.name}，${skill.description}`}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 48,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 14,
        paddingVertical: numberOfLines > 1 ? 8 : 0,
        backgroundColor: pressed ? colors.fill : 'transparent',
      })}
    >
      <Mono numberOfLines={1} style={{ fontSize: 14, color: active ? colors.run : colors.ink, flexShrink: 0, maxWidth: '50%' }}>
        {skill.reference ? '@' : '/'}{skill.reference?.displayName || skill.name}
      </Mono>
      <Text numberOfLines={numberOfLines} style={{ flex: 1, minWidth: 0, fontSize: 14, color: colors.ink3 }}>
        {skill.description}
      </Text>
      {active ? <Icon name="check" size={16} color={colors.run} strokeWidth={2.4} /> : null}
    </Pressable>
  )
}

/** New tasks and follow-ups share the same input, capabilities and runtime bar. */
export function ChatComposer({ client, sessionId, workDir, runtime, draft, onDraft,
  references, onReferences, attachments, onAttachments, team, onTeam, lean, empty,
  busy, queueing = false, disabled, mode, model, onMode, onModel, onSend, onError,
  header, effortControl, profileControl,
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
  lean: boolean
  empty: boolean
  busy: boolean
  queueing?: boolean
  disabled: boolean
  mode: string
  model: string
  onMode(): void
  onModel(): void
  onSend(): void
  onError(message: string): void
  header?: ReactNode
  effortControl?: ReactNode
  profileControl?: ReactNode
}) {
  const colors = useColors()
  const inset = useBottomInset()
  const keyboard = useKeyboardVisible()
  const input = useRef<ComponentRef<typeof TextInput>>(null)
  const [panel, setPanel] = useState(false)
  const [selection, setSelection] = useState({ start: draft.length, end: draft.length })
  const [candidates, setCandidates] = useState<ComposerCandidate[]>([])
  const [catalogError, setCatalogError] = useState('')
  const [loading, setLoading] = useState(false)
  const [picking, setPicking] = useState<MaterialKind | null>(null)
  const [computerEnabled, setComputerEnabled] = useState(false)
  const [teamsEnabled, setTeamsEnabled] = useState(false)
  const [teamConsent, setTeamConsent] = useState(false)
  const [teamAccepted, setTeamAccepted] = useState(false)
  const trigger = composerTrigger(draft, selection.start, selection.end)
  const showCandidates = !panel && !disabled && !!trigger
  const needsCatalog = panel || showCandidates
  const providerId = runtime?.providerId
  const hasRuntime = !!runtime
  useEffect(() => {
    if (!client || !needsCatalog) return
    const controller = new AbortController()
    queueMicrotask(() => {
      if (!controller.signal.aborted) { setLoading(true); setCatalogError(''); setCandidates([]) }
    })
    loadComposerCandidates(client, { sessionId, workDir, runtime: hasRuntime ? { providerId: providerId ?? null, modelId: '' } : undefined, lean }, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setCandidates(value) })
      .catch((e) => { if (!controller.signal.aborted) setCatalogError(errorText(e)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [client, sessionId, workDir, providerId, hasRuntime, lean, needsCatalog])
  useEffect(() => {
    if (!client) return
    const controller = new AbortController()
    client.get<{ agentTeamsEnabled?: boolean }>('/api/settings/user', { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) { setTeamsEnabled(value.agentTeamsEnabled !== false); if (value.agentTeamsEnabled === false) onTeam(false) } })
      .catch(() => { if (!controller.signal.aborted) setTeamsEnabled(false) })
    return () => controller.abort()
  }, [client, panel, onTeam])
  const canSend = (!busy || queueing) && !disabled && !picking && (!!draft.trim() || attachments.length > 0 || references.length > 0)
  const query = trigger?.query.toLocaleLowerCase() ?? ''
  const filtered = candidates.filter((candidate) =>
    (trigger?.kind !== '@' || !!candidate.reference) &&
    (!query || `${candidate.name} ${candidate.description} ${candidate.reference?.displayName ?? ''}`.toLocaleLowerCase().includes(query))
  )
  function choose(candidate: ComposerCandidate) {
    const next = insertComposerCandidate(draft, showCandidates ? trigger : null, candidate)
    onDraft(next.text)
    if (candidate.reference) onReferences(mergeComposerReferences(references, [candidate.reference]))
    setSelection({ start: next.cursor, end: next.cursor })
    setPanel(false)
    requestAnimationFrame(() => input.current?.focus())
  }
  async function pick(kind: MaterialKind) {
    if (picking) return
    setPicking(kind)
    try {
      const next = await pickChatMaterial(kind)
      onAttachments([...attachments, ...next])
      if (next.length) setPanel(false)
    } catch (e) { onError(errorText(e)) }
    finally { setPicking(null) }
  }
  function toggleTeam(value: boolean) {
    if (!value) onTeam(false)
    else if (teamAccepted) onTeam(true)
    else setTeamConsent(true)
  }
  function send() {
    if (!references.length && !attachments.length) {
      if (draft.trim() === '/model') { onDraft(''); onModel(); return }
      if (draft.trim() === '/permissions') { onDraft(''); onMode(); return }
    }
    onSend()
    setPanel(false)
  }
  const candidateList = <View style={{ backgroundColor: colors.card, borderRadius: 14, overflow: 'hidden' }}>
    <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 188 }}>
      {loading ? <View style={{ padding: 14 }}><Spinner size={16} /></View> : catalogError ?
        <Text style={{ padding: 14, color: colors.err }}>{catalogError}</Text> : filtered.length ? filtered.map((candidate) => (
          <SkillRow key={`${candidate.kind}:${candidate.name}`} skill={candidate}
            active={!!candidate.reference && references.some((value) => value.kind === candidate.reference?.kind && value.id === candidate.reference.id)}
            onPress={() => choose(candidate)} numberOfLines={2} />
        )) : <Text style={{ padding: 14, color: colors.ink3 }}>没有匹配的技能或命令</Text>}
    </ScrollView>
  </View>
  return <View>
    <LinearGradient pointerEvents="none" colors={[`${colors.bg}00`, colors.bg]}
      style={{ position: 'absolute', top: -18, left: 0, right: 0, height: 18 }} />
    <View style={{ backgroundColor: colors.bg, paddingHorizontal: 12, paddingTop: 10, paddingBottom: panel ? 8 : keyboard ? 10 : inset, gap: 8 }}>
      {header}
      {showCandidates && candidateList}
      <View style={{ backgroundColor: colors.card, borderRadius: 22, padding: 6, gap: 4,
        boxShadow: '0 1px 2px rgba(28,25,23,0.05), 0 6px 20px rgba(28,25,23,0.07)' }}>
        {!!attachments.length && <AttachmentStrip attachments={attachments} onRemove={(id) => onAttachments(attachments.filter((value) => value.id !== id))} />}
        {(references.length > 0 || team || computerEnabled) && <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 8, paddingTop: 5, gap: 6 }}>
          {references.map((reference) => <Pressable key={`${reference.kind}:${reference.id}`} accessibilityRole="button"
            accessibilityLabel={`移除技能 ${reference.displayName || reference.name}`}
            onPress={() => onReferences(references.filter((value) => value.kind !== reference.kind || value.id !== reference.id))}
            style={{ minHeight: 32, paddingHorizontal: 10, borderRadius: 10, backgroundColor: colors.fill, flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <Text style={{ fontSize: 13, color: colors.ink2 }}>@{reference.displayName || reference.name}</Text><Icon name="x" size={12} color={colors.ink3} />
          </Pressable>)}
          {team && <Pressable accessibilityRole="button" accessibilityLabel="关闭这条消息的 Agent 团队" onPress={() => onTeam(false)}
            style={{ minHeight: 32, paddingHorizontal: 10, borderRadius: 10, backgroundColor: colors.runTint, justifyContent: 'center' }}>
            <Text style={{ fontSize: 13, color: colors.run }}>团队 ×</Text></Pressable>}
          {computerEnabled && <Pressable accessibilityRole="button" accessibilityLabel="Computer Use 已开启，打开控制菜单" onPress={() => { input.current?.blur(); setPanel(true) }}
            style={{ minHeight: 32, paddingHorizontal: 10, borderRadius: 10, backgroundColor: colors.fill, justifyContent: 'center' }}>
            <Text style={{ fontSize: 13, color: colors.ink2 }}>Computer Use</Text></Pressable>}
        </ScrollView>}
        <TextInput ref={input} accessibilityLabel={sessionId ? '消息' : '新任务内容'} value={draft} multiline editable={!disabled}
          onChangeText={(value) => {
            const cursor = Math.min(value.length, Math.max(0, selection.end + value.length - draft.length))
            onDraft(value); setSelection({ start: cursor, end: cursor })
          }}
          selection={{ start: Math.min(selection.start, draft.length), end: Math.min(selection.end, draft.length) }}
          onSelectionChange={({ nativeEvent }) => setSelection(nativeEvent.selection)}
          onFocus={() => setPanel(false)}
          placeholder={queueing ? '补充要求，这一轮结束后自动发送' : empty ? '说说你想做什么…' : '接着说…'}
          placeholderTextColor={colors.ink3}
          {...(Platform.OS === 'web' ? { rows: 1 } : {})}
          style={{ minHeight: 60, maxHeight: 136, paddingHorizontal: 10, paddingVertical: 12, fontSize: 16, lineHeight: 23, color: colors.ink }} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Pressable accessibilityRole="button" accessibilityLabel={panel ? '收起工具' : '添加材料和工具'} accessibilityState={{ expanded: panel }}
            onPress={() => { input.current?.blur(); setPanel(!panel) }} style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={panel ? 'x' : 'plus'} size={20} color={colors.ink2} />
          </Pressable>
          <View style={{ flex: 1 }} />
          <Pressable accessibilityRole="button" accessibilityLabel={sessionId ? '发送' : '开始任务'} disabled={!canSend}
            accessibilityState={{ disabled: !canSend }} onPress={send}
            style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: canSend ? colors.btn : colors.fill, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="arrow-up" size={18} color={canSend ? colors.btnInk : colors.faint} strokeWidth={2.4} />
          </Pressable>
        </View>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ alignItems: 'center', gap: 3 }}>
        <Pressable accessibilityRole="button" accessibilityLabel={`权限模式：${mode}`} onPress={onMode} disabled={busy || disabled}
          style={{ minHeight: 40, paddingHorizontal: 9, justifyContent: 'center' }}><Text style={{ fontSize: 13, color: colors.ink2 }}>{mode}⌄</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`模型：${model}`} onPress={onModel} disabled={busy || disabled}
          style={{ minHeight: 40, paddingHorizontal: 9, justifyContent: 'center' }}><Text numberOfLines={1} style={{ fontSize: 13, color: colors.ink2 }}>{model}⌄</Text></Pressable>
        {effortControl}
      </ScrollView>
    </View>
    {panel && <View style={{ backgroundColor: colors.sheet, borderTopWidth: 1, borderTopColor: colors.hair, paddingHorizontal: 16, paddingTop: 12, paddingBottom: inset, gap: 10 }}>
      <View style={{ flexDirection: 'row', gap: 8 }}>{tiles.map((tile) => <Pressable key={tile.kind} accessibilityRole="button" accessibilityLabel={`从${tile.title}添加`}
        disabled={!!picking} onPress={() => void pick(tile.kind)} style={{ flex: 1, minHeight: 60, backgroundColor: colors.card, borderRadius: 14, alignItems: 'center', justifyContent: 'center', gap: 4 }}>
        {picking === tile.kind ? <Spinner size={20} /> : <Icon name={tile.icon} size={20} color={colors.ink2} />}<Text style={{ fontSize: 13, color: colors.ink }}>{tile.title}</Text>
      </Pressable>)}</View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 14, backgroundColor: colors.card }}>
        <View style={{ flex: 1 }}><Text style={{ fontSize: 15, color: colors.ink }}>Agent 团队</Text>
          <Text style={{ fontSize: 12, color: colors.ink3 }}>{lean ? '轻量档位不支持团队' : !teamsEnabled ? '请先在电脑设置中启用团队' : '只对下一条消息生效'}</Text></View>
        <Switch label="Agent 团队" value={team} disabled={lean || !teamsEnabled || (busy && !queueing)} onValueChange={toggleTeam} />
      </View>
      {profileControl}
      <Text style={{ fontSize: 12, color: colors.ink3 }}>输入 / 查找命令，输入 @ 引用技能</Text>
    </View>}
    <ComputerUseControl client={client} visible={panel} onEnabled={setComputerEnabled} />
    <Sheet visible={teamConsent} onClose={() => setTeamConsent(false)} title="使用 Agent 团队">
      <Text style={{ fontSize: 15, lineHeight: 23, color: colors.ink }}>队长会拆分任务并协调多个成员。每个成员会独立调用模型，可能增加用量和费用。</Text>
      <Button title="使用团队" onPress={() => { setTeamAccepted(true); onTeam(true); setTeamConsent(false); setPanel(false) }} />
      <Button title="取消" variant="secondary" onPress={() => setTeamConsent(false)} />
    </Sheet>
  </View>
}
