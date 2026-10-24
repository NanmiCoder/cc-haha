import { useEffect, useRef, useState, type ComponentRef } from 'react'
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from 'react-native'
import { Text } from './Text'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { ApiClient } from '../core/client'
import {
  withSkill,
  type ComposerAttachment,
  type SkillCommand,
} from '../core/chatComposer'
import { pickChatMaterial } from './chatMaterials'
import {
  CircleButton,
  Divider,
  Icon,
  Inset,
  Raised,
  Toggle,
  errorText,
  mono,
  useTheme,
} from './theme'

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
  model,
  mode,
  disabled,
  busy,
  onSend,
  onStop,
  onModel,
  onMode,
  onError,
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
  model: string
  mode: string
  disabled: boolean
  busy: boolean
  onSend(): void
  onStop(): void
  onModel(): void
  onMode(): void
  onError(message: string): void
}) {
  const { colors: c, styles: s } = useTheme()
  const insets = useSafeAreaInsets()
  const input = useRef<ComponentRef<typeof TextInput>>(null)
  const [expanded, setExpanded] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [skills, setSkills] = useState<SkillCommand[]>([])
  const [skillsError, setSkillsError] = useState('')
  const [recentSkills, setRecentSkills] = useState<SkillCommand[]>([])
  const [picking, setPicking] = useState(false)
  const [hint, setHint] = useState('')
  useEffect(() => {
    if (!expanded || !client) return
    const controller = new AbortController()
    client
      .get<{ commands: SkillCommand[] }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/slash-commands`,
        { signal: controller.signal }
      )
      .then((value) => {
        if (!controller.signal.aborted) {
          setSkills(value.commands)
          setSkillsError('')
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setSkillsError(errorText(e))
      })
    return () => controller.abort()
  }, [client, sessionId, expanded])
  async function pick(kind: 'camera' | 'photos' | 'file') {
    if (picking) return
    setPicking(true)
    try {
      const next = await pickChatMaterial(kind)
      onAttachments([...attachments, ...next])
      if (next.length) setExpanded(false)
    } catch (e) {
      onError(errorText(e))
    } finally {
      setPicking(false)
    }
  }
  function chooseSkill(skill: SkillCommand) {
    try {
      onDraft(withSkill(draft, skill))
      setRecentSkills((values) =>
        [skill, ...values.filter((value) => value.name !== skill.name)].slice(
          0,
          3
        )
      )
      setSkillsOpen(false)
      setExpanded(false)
      input.current?.focus()
    } catch (e) {
      onError(errorText(e))
    }
  }
  return (
    <View
      style={{
        paddingHorizontal: 16,
        paddingTop: expanded ? 12 : 10,
        paddingBottom: Math.max(insets.bottom, 12),
        gap: 12,
        backgroundColor: expanded ? c.surface : c.paper,
        borderTopLeftRadius: expanded ? 26 : 0,
        borderTopRightRadius: expanded ? 26 : 0,
        boxShadow: expanded
          ? 'inset 0 1px 0 #FFFFFF66, 0 -5px 22px #3C2D1E20'
          : undefined,
      }}
    >
      {expanded && (
        <>
          <View
            style={{
              width: 36,
              height: 4,
              borderRadius: 2,
              backgroundColor: c.line,
              alignSelf: 'center',
              marginBottom: 2,
            }}
          />
          <View style={{ flexDirection: 'row', gap: 10 }}>
            {(
              [
                { kind: 'camera', title: '拍照', icon: 'camera' },
                { kind: 'photos', title: '相册', icon: 'image' },
                { kind: 'file', title: '文件', icon: 'file-text' },
                { kind: 'skill', title: '技能', icon: 'zap' },
              ] as const
            ).map((item) => (
              <Pressable
                key={item.kind}
                accessibilityRole="button"
                accessibilityLabel={`添加${item.title}`}
                disabled={picking}
                onPress={() =>
                  item.kind === 'skill'
                    ? setSkillsOpen((value) => !value)
                    : void pick(item.kind)
                }
                style={{ flex: 1 }}
              >
                <Raised
                  style={{
                    height: 76,
                    borderRadius: 17,
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 9,
                  }}
                >
                  <Icon name={item.icon} size={22} color={c.secondary} />
                  <Text style={[s.small, { color: c.secondary }]}>
                    {item.title}
                  </Text>
                </Raised>
              </Pressable>
            ))}
          </View>
          {picking && <ActivityIndicator color={c.accent} />}
          {skillsOpen ? (
            <ScrollView
              style={{ maxHeight: 170 }}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ gap: 4 }}
            >
              {skillsError ? (
                <Text style={[s.small, { color: c.red }]}>{skillsError}</Text>
              ) : !skills.length ? (
                <Text style={s.small}>
                  这段会话没有返回可引用的技能或命令。
                </Text>
              ) : (
                skills.map((skill) => (
                  <Pressable
                    accessibilityRole="button"
                    key={skill.name}
                    onPress={() => chooseSkill(skill)}
                    style={{ padding: 9, gap: 3 }}
                  >
                    <Text style={[s.text, { fontFamily: mono, fontSize: 13 }]}>
                      /{skill.name}
                    </Text>
                    <Text style={s.small}>{skill.description}</Text>
                  </Pressable>
                ))
              )}
            </ScrollView>
          ) : (
            recentSkills.length > 0 && (
              <View style={[s.row, { gap: 8, flexWrap: 'wrap' }]}>
                <Text style={s.small}>最近使用</Text>
                {recentSkills.map((skill) => (
                  <Pressable
                    accessibilityRole="button"
                    key={skill.name}
                    onPress={() => chooseSkill(skill)}
                  >
                    <Inset
                      style={{
                        borderRadius: 8,
                        paddingVertical: 7,
                        paddingHorizontal: 10,
                      }}
                    >
                      <Text
                        style={{
                          fontFamily: mono,
                          color: c.secondary,
                          fontSize: 11,
                        }}
                      >
                        /{skill.name}
                      </Text>
                    </Inset>
                  </Pressable>
                ))}
              </View>
            )
          )}
          <Divider inset={0} />
          <View style={s.between}>
            <View style={[s.row, { gap: 10 }]}>
              <Icon name="users" size={18} />
              <View>
                <Text style={s.text}>Agent 团队</Text>
                <Text style={s.small}>
                  {lean ? 'Lean 会话不支持团队' : '只对下一条消息生效'}
                </Text>
              </View>
            </View>
            <Toggle
              value={team}
              onChange={onTeam}
              label="下一条消息使用 Agent 团队"
              disabled={lean || busy}
            />
          </View>
          <View style={s.between}>
            <View style={[s.row, { gap: 10 }]}>
              <Icon name="monitor" size={18} color={c.muted} />
              <View>
                <Text style={[s.text, { color: c.muted }]}>Computer Use</Text>
                <Text style={s.small}>授权和系统权限请在电脑端管理</Text>
              </View>
            </View>
            <Icon name="external-link" size={14} color={c.muted} />
          </View>
          <Divider inset={0} />
        </>
      )}
      <View style={[s.row, { gap: 8 }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="权限模式"
          disabled={busy || disabled}
          onPress={onMode}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            backgroundColor: c.well,
            paddingVertical: 7,
            paddingHorizontal: 10,
            borderRadius: 9,
          }}
        >
          <Icon name="shield" size={12} color="#AAA59A" />
          <Text style={{ fontSize: 11, color: '#D8D4CA' }}>{mode}</Text>
          <Icon name="chevron-down" size={11} color="#AAA59A" />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="模型设置"
          disabled={busy || disabled}
          onPress={onModel}
          style={{
            flexShrink: 1,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            backgroundColor: c.well,
            paddingVertical: 7,
            paddingHorizontal: 10,
            borderRadius: 9,
          }}
        >
          <Text
            numberOfLines={1}
            style={{
              flexShrink: 1,
              color: c.screenText,
              fontFamily: mono,
              fontSize: 11,
            }}
          >
            {model}
          </Text>
          <Icon name="chevron-down" size={11} color="#AAA59A" />
        </Pressable>
        {team && <Icon name="users" size={14} color={c.accent} />}
      </View>
      {attachments.length > 0 && (
        <ScrollView
          horizontal
          contentContainerStyle={{ gap: 8 }}
          keyboardShouldPersistTaps="handled"
        >
          {attachments.map((attachment) => (
            <Raised
              key={attachment.id}
              style={{
                padding: 7,
                flexDirection: 'row',
                gap: 8,
                alignItems: 'center',
                borderRadius: 12,
                maxWidth: 250,
              }}
            >
              {attachment.type === 'image' && attachment.uri ? (
                <Image
                  source={{ uri: attachment.uri }}
                  style={{ width: 40, height: 40, borderRadius: 7 }}
                />
              ) : (
                <Icon name="file-text" size={20} />
              )}
              <View style={{ flexShrink: 1 }}>
                <Text
                  numberOfLines={1}
                  style={[s.small, { color: c.secondary }]}
                >
                  {attachment.name}
                </Text>
                <Text style={[s.small, { fontFamily: mono, fontSize: 10 }]}>
                  {Math.ceil(attachment.bytes / 1024)} KB
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`移除 ${attachment.name}`}
                onPress={() =>
                  onAttachments(
                    attachments.filter((value) => value.id !== attachment.id)
                  )
                }
                style={{ padding: 7 }}
              >
                <Icon name="x" size={13} />
              </Pressable>
            </Raised>
          ))}
        </ScrollView>
      )}
      <View style={{ flexDirection: 'row', gap: 9, alignItems: 'flex-end' }}>
        <CircleButton
          name={expanded ? 'x' : 'plus'}
          label={expanded ? '收起补充材料' : '补充材料'}
          onPress={() => {
            input.current?.blur()
            setExpanded((value) => !value)
          }}
        />
        <Inset
          style={{
            flex: 1,
            borderRadius: 22,
            minHeight: 44,
            flexDirection: 'row',
            alignItems: 'flex-end',
            paddingRight: 5,
          }}
        >
          <TextInput
            ref={input}
            accessibilityLabel="消息"
            value={draft}
            onChangeText={onDraft}
            placeholder={busy ? '写下下一步…' : '说说你想做什么…'}
            placeholderTextColor={c.muted}
            multiline
            style={{
              fontFamily: 'Geist',
              flex: 1,
              minHeight: 44,
              maxHeight: 130,
              paddingHorizontal: 14,
              paddingTop: 12,
              paddingBottom: 10,
              fontSize: 15,
              color: c.ink,
            }}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="使用系统键盘听写"
            onPress={() => {
              input.current?.focus()
              setHint('可点系统键盘上的麦克风进行听写。')
            }}
            style={{ padding: 10, marginBottom: 1 }}
          >
            <Icon name="mic" size={16} color={c.muted} />
          </Pressable>
        </Inset>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={busy ? '停止会话任务' : '发送消息'}
          disabled={
            !busy && (disabled || (!draft.trim() && !attachments.length))
          }
          onPress={
            busy
              ? onStop
              : () => {
                  onSend()
                  setExpanded(false)
                  setHint('')
                }
          }
          style={({ pressed }) => ({
            width: 44,
            height: 44,
            borderRadius: 22,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: c.accent,
            boxShadow:
              'inset 0 1px 0 #D88B70, 0 3px 0 #823B29, 0 5px 10px #783B2230',
            opacity:
              !busy && (disabled || (!draft.trim() && !attachments.length))
                ? 0.4
                : pressed
                  ? 0.7
                  : 1,
          })}
        >
          <Icon name={busy ? 'square' : 'arrow-up'} size={20} color="#fff" />
        </Pressable>
      </View>
      {hint && <Text style={[s.small, { fontSize: 10 }]}>{hint}</Text>}
    </View>
  )
}
