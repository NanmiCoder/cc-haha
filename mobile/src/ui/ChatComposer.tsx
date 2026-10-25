import { useEffect, useRef, useState, type ComponentRef, type ReactNode } from 'react'
import { Image, Keyboard, Platform, Pressable, ScrollView, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { LinearGradient } from 'expo-linear-gradient'
import { Text } from './Text'
import type { ApiClient } from '../core/client'
import {
  draftSkill,
  formatBytes,
  materialsFootnote,
  withSkill,
  type ComposerAttachment,
  type SkillCommand,
} from '../core/chatComposer'
import { pickChatMaterial } from './chatMaterials'
import {
  Icon,
  Mono,
  SearchField,
  Separator,
  Sheet,
  Spinner,
  Switch,
  useColors,
  type IconName,
} from './kit'
import { errorText } from './theme'

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
  skill: SkillCommand
  active: boolean
  onPress(): void
  numberOfLines?: number
}) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`使用 /${skill.name}，${skill.description}`}
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
        /{skill.name}
      </Mono>
      <Text numberOfLines={numberOfLines} style={{ flex: 1, minWidth: 0, fontSize: 14, color: colors.ink3 }}>
        {skill.description}
      </Text>
      {active ? <Icon name="check" size={16} color={colors.run} strokeWidth={2.4} /> : null}
    </Pressable>
  )
}

/**
 * 会话输入框：输入行 + 控制行（材料、权限模式、模型、团队标记、发送）。
 * 「+」打开的材料面板占在键盘的位置。
 */
export function ChatComposer({
  client,
  sessionId,
  draft,
  onDraft,
  attachments,
  onAttachments,
  team,
  onTeam,
  lean,
  empty,
  busy,
  queueing = false,
  disabled,
  mode,
  model,
  onMode,
  onModel,
  onSend,
  onError,
  header,
}: {
  client: ApiClient | null
  sessionId: string
  draft: string
  onDraft(value: string): void
  attachments: ComposerAttachment[]
  onAttachments(value: ComposerAttachment[]): void
  team: boolean
  onTeam(value: boolean): void
  lean: boolean
  /** 还没有任何消息。 */
  empty: boolean
  /** 这一轮还在进行，服务端不接收追加消息。 */
  busy: boolean
  /** 运行中发送会先在手机上排队，这一轮结束后自动发出。 */
  queueing?: boolean
  disabled: boolean
  mode: string
  model: string
  onMode(): void
  onModel(): void
  onSend(): void
  onError(message: string): void
  /** 输入框上方的状态条和提示。 */
  header?: ReactNode
}) {
  const colors = useColors()
  const inset = useBottomInset()
  const keyboard = useKeyboardVisible()
  const bottom = keyboard ? 10 : inset
  const input = useRef<ComponentRef<typeof TextInput>>(null)
  const [panel, setPanel] = useState(false)
  const [allSkills, setAllSkills] = useState(false)
  const [query, setQuery] = useState('')
  const [skills, setSkills] = useState<{ loaded: boolean; list: SkillCommand[]; error: string }>({
    loaded: false,
    list: [],
    error: '',
  })
  const [recentSkills, setRecentSkills] = useState<SkillCommand[]>([])
  const [picking, setPicking] = useState<MaterialKind | null>(null)
  const [focusRequest, setFocusRequest] = useState(0)
  useEffect(() => {
    if (focusRequest) input.current?.focus()
  }, [focusRequest])
  useEffect(() => {
    if (!panel || !client) return
    const controller = new AbortController()
    client
      .get<{ commands: SkillCommand[] }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/slash-commands`,
        { signal: controller.signal }
      )
      .then((value) => {
        if (!controller.signal.aborted) setSkills({ loaded: true, list: value.commands, error: '' })
      })
      .catch((e) => {
        if (!controller.signal.aborted) setSkills((value) => ({ ...value, loaded: true, error: errorText(e) }))
      })
    return () => controller.abort()
  }, [client, sessionId, panel])
  const canSend =
    (!busy || queueing) && !disabled && (!!draft.trim() || attachments.length > 0)
  const active = draftSkill(draft)
  async function pick(kind: MaterialKind) {
    if (picking) return
    setPicking(kind)
    try {
      const next = await pickChatMaterial(kind)
      onAttachments([...attachments, ...next])
      if (next.length) setPanel(false)
    } catch (e) {
      onError(errorText(e))
    } finally {
      setPicking(null)
    }
  }
  function chooseSkill(skill: SkillCommand) {
    try {
      onDraft(withSkill(draft, skill))
      setRecentSkills((values) =>
        [skill, ...values.filter((value) => value.name !== skill.name)].slice(0, 3)
      )
      setAllSkills(false)
      setPanel(false)
      setFocusRequest((value) => value + 1)
    } catch (e) {
      onError(errorText(e))
    }
  }
  const shownSkills = [
    ...recentSkills.filter((skill) => skills.list.some((value) => value.name === skill.name)),
    ...skills.list.filter((skill) => !recentSkills.some((value) => value.name === skill.name)),
  ].slice(0, 3)
  const filtered = skills.list.filter(
    (skill) =>
      !query.trim() ||
      `${skill.name} ${skill.description}`.toLowerCase().includes(query.trim().toLowerCase())
  )
  const placeholder = queueing
    ? '补充要求，这一轮结束后自动发送'
    : busy
      ? '这一步结束后就能发送'
      : empty
        ? '说说你想做什么…'
        : '接着说…'
  const runtimeText = (
    <>
      {team ? (
        <View
          accessible
          accessibilityLabel="这条消息使用 Agent 团队"
          style={{
            height: 28,
            paddingHorizontal: 10,
            borderRadius: 14,
            backgroundColor: colors.runTint,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 5,
            flexShrink: 0,
          }}
        >
          <Icon name="users" size={14} color={colors.run} strokeWidth={2} />
          <Text style={{ fontSize: 13, fontWeight: '600', color: colors.run }}>团队</Text>
        </View>
      ) : null}
      {team ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6, flexShrink: 1, minWidth: 0 }}>
          <Pressable accessibilityRole="button" accessibilityLabel={`权限模式：${mode}`} hitSlop={8} onPress={onMode}>
            <Text style={{ fontSize: 13, color: colors.ink2 }}>{mode} · </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`模型：${model}`}
            hitSlop={8}
            onPress={onModel}
            style={{ flexShrink: 1, minWidth: 0 }}
          >
            <Text numberOfLines={1} style={{ fontSize: 13, color: colors.ink2 }}>
              {model}
            </Text>
          </Pressable>
        </View>
      ) : (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`权限模式：${mode}`}
            onPress={onMode}
            style={({ pressed }) => ({
              height: 36,
              paddingHorizontal: 10,
              borderRadius: 18,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 5,
              flexShrink: 0,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Icon name="shield" size={15} color={colors.ink2} strokeWidth={2} />
            <Text style={{ fontSize: 13, color: colors.ink2 }}>{mode}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`模型：${model}`}
            onPress={onModel}
            style={({ pressed }) => ({
              height: 36,
              paddingHorizontal: 10,
              borderRadius: 18,
              justifyContent: 'center',
              flexShrink: 1,
              minWidth: 0,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Text numberOfLines={1} style={{ fontSize: 13, color: colors.ink2 }}>
              {model}
            </Text>
          </Pressable>
        </>
      )}
    </>
  )
  return (
    <View>
      <LinearGradient
        pointerEvents="none"
        colors={[`${colors.bg}00`, colors.bg]}
        style={{ position: 'absolute', top: -18, left: 0, right: 0, height: 18 }}
      />
      <View
        style={{
          backgroundColor: colors.bg,
          paddingHorizontal: 12,
          paddingTop: header ? 10 : 14,
          paddingBottom: panel ? 10 : bottom,
          gap: 8,
        }}
      >
        {header}
        <View
          style={{
            backgroundColor: colors.card,
            borderRadius: 22,
            boxShadow: '0 1px 2px rgba(28,25,23,0.05), 0 6px 20px rgba(28,25,23,0.07)',
            paddingTop: attachments.length ? 8 : 6,
            paddingHorizontal: 6,
            paddingBottom: 6,
            gap: attachments.length ? 4 : 0,
          }}
        >
          {attachments.length > 0 && (
            <AttachmentStrip
              attachments={attachments}
              onRemove={(id) => onAttachments(attachments.filter((value) => value.id !== id))}
            />
          )}
          <TextInput
            ref={input}
            accessibilityLabel="消息"
            value={draft}
            onChangeText={onDraft}
            onFocus={() => setPanel(false)}
            placeholder={placeholder}
            placeholderTextColor={colors.ink3}
            multiline
            // web 的 textarea 默认两行高；原生端的 rows 会固定行数，只在 web 上设。
            {...(Platform.OS === 'web' ? { rows: 1 } : {})}
            style={{
              minHeight: 44,
              maxHeight: 136,
              paddingHorizontal: 10,
              paddingTop: 11,
              paddingBottom: 10,
              fontSize: 16,
              lineHeight: 23,
              color: colors.ink,
              outlineStyle: 'none',
            } as object}
          />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={panel ? '收起材料面板' : '添加材料'}
              accessibilityState={{ expanded: panel }}
              onPress={() => {
                input.current?.blur()
                setPanel((value) => !value)
              }}
              style={({ pressed }) => ({
                width: 36,
                height: 36,
                borderRadius: 18,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: panel ? colors.fill : 'transparent',
                opacity: pressed ? 0.6 : 1,
                flexShrink: 0,
              })}
            >
              <View style={{ transform: [{ rotate: panel ? '45deg' : '0deg' }] }}>
                <Icon name="plus" size={20} color={panel ? colors.ink : colors.ink2} strokeWidth={2} />
              </View>
            </Pressable>
            {runtimeText}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="发送"
              accessibilityState={{ disabled: !canSend }}
              disabled={!canSend}
              onPress={() => {
                onSend()
                setPanel(false)
              }}
              style={({ pressed }) => ({
                marginLeft: 'auto',
                width: 36,
                height: 36,
                borderRadius: 18,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: canSend ? colors.btn : colors.fill,
                opacity: pressed ? 0.7 : 1,
                flexShrink: 0,
              })}
            >
              <Icon name="arrow-up" size={18} color={canSend ? colors.btnInk : colors.faint} strokeWidth={2.4} />
            </Pressable>
          </View>
        </View>
      </View>
      {panel && (
        <View
          style={{
            backgroundColor: colors.sheet,
            borderTopWidth: 1,
            borderTopColor: colors.hair,
            paddingTop: 14,
            paddingHorizontal: 16,
            paddingBottom: bottom,
            gap: 14,
          }}
        >
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {tiles.map((tile) => (
              <Pressable
                key={tile.kind}
                accessibilityRole="button"
                accessibilityLabel={`从${tile.title}添加`}
                disabled={!!picking}
                onPress={() => void pick(tile.kind)}
                style={({ pressed }) => ({
                  flex: 1,
                  height: 72,
                  borderRadius: 14,
                  backgroundColor: colors.card,
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  opacity: pressed ? 0.6 : picking && picking !== tile.kind ? 0.5 : 1,
                })}
              >
                {picking === tile.kind ? (
                  <Spinner size={22} />
                ) : (
                  <Icon name={tile.icon} size={22} color={colors.ink} />
                )}
                <Text style={{ fontSize: 13, color: colors.ink }}>{tile.title}</Text>
              </Pressable>
            ))}
          </View>
          <View style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4 }}>
              <Text accessibilityRole="header" style={{ fontSize: 13, fontWeight: '600', color: colors.ink2 }}>
                技能
              </Text>
              {skills.list.length > 0 ? (
                <Pressable
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={() => {
                    setQuery('')
                    setAllSkills(true)
                  }}
                  style={{ height: 28, justifyContent: 'center' }}
                >
                  <Text style={{ fontSize: 13, color: colors.ink2 }}>全部 {skills.list.length} 个</Text>
                </Pressable>
              ) : null}
            </View>
            <View style={{ backgroundColor: colors.card, borderRadius: 14, overflow: 'hidden' }}>
              {!skills.loaded ? (
                <View style={{ height: 48, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14 }}>
                  <Spinner size={14} />
                  <Text style={{ fontSize: 14, color: colors.ink3 }}>正在读取技能…</Text>
                </View>
              ) : skills.error ? (
                <Text style={{ fontSize: 14, lineHeight: 20, color: colors.err, padding: 14 }}>{skills.error}</Text>
              ) : !shownSkills.length ? (
                <Text style={{ fontSize: 14, lineHeight: 20, color: colors.ink3, padding: 14 }}>
                  这段会话没有可引用的技能或命令。
                </Text>
              ) : (
                shownSkills.map((skill, index) => (
                  <View key={skill.name}>
                    {index > 0 && <Separator />}
                    <SkillRow skill={skill} active={active === skill.name} onPress={() => chooseSkill(skill)} />
                  </View>
                ))
              )}
            </View>
          </View>
          <View
            style={{
              backgroundColor: colors.card,
              borderRadius: 14,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              paddingHorizontal: 14,
              paddingVertical: 10,
            }}
          >
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: 15, color: lean ? colors.ink3 : colors.ink }}>Agent 团队</Text>
              <Text style={{ fontSize: 12.5, lineHeight: 17, color: colors.ink3 }}>
                {lean
                  ? '轻量档位不支持团队，换成完整工具的会话后可用'
                  : '只对这一条消息生效，由队长分派给多个成员'}
              </Text>
            </View>
            <Switch value={team} onValueChange={onTeam} label="Agent 团队" disabled={lean || (busy && !queueing)} />
          </View>
          <Text style={{ paddingHorizontal: 4, fontSize: 12, lineHeight: 17, color: colors.ink3 }}>
            {materialsFootnote()}
          </Text>
        </View>
      )}
      <Sheet visible={allSkills} onClose={() => setAllSkills(false)} title="技能">
        <SearchField value={query} onChangeText={setQuery} placeholder="搜索技能和命令" />
        <View style={{ backgroundColor: colors.card, borderRadius: 16, overflow: 'hidden' }}>
          {filtered.length ? (
            filtered.map((skill, index) => (
              <View key={skill.name}>
                {index > 0 && <Separator />}
                <SkillRow
                  skill={skill}
                  active={active === skill.name}
                  numberOfLines={2}
                  onPress={() => chooseSkill(skill)}
                />
              </View>
            ))
          ) : (
            <Text style={{ fontSize: 14, color: colors.ink3, padding: 14 }}>没有匹配的技能。</Text>
          )}
        </View>
      </Sheet>
    </View>
  )
}
