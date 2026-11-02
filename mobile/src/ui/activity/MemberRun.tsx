import { useCallback, useRef, useState } from 'react'
import { FlatList, View } from 'react-native'
import { useConnection } from '../../state/AppContext'
import { teamModel, type TeamRow } from '../../core/sessionActivityModel'
import type { HistoryEntry } from '../../core/types'
import { useFocusedResource } from '../../core/useFocusedResource'
import { EmptyState, Footnote, InlineError, Loading, NavBar, ScreenView, Spinner, useColors } from '../kit'
import { Text } from '../Text'
import { Message } from '../Message'
import { StepGroup, TurnFold, type StepContext, type StepUi } from '../chat/StepGroup'
import { StatusCaption } from '../chat/StatusCaption'
import { toggleGroupOpen, visibleChatRows, type ChatRow } from '../chat/steps'
import { loadMemberHistory, loadTeam } from './activityData'
import { ReadOnlyBar, TaskPrompt } from './SubagentRun'
import { subagentRunView } from './subagentView'
import { TaskLines, memberTone } from './TeamMembers'
import { teammateLabel } from '../../core/teammateEnvelope'

const REFRESH_MS = 2500

type Loaded = { member: TeamRow | null; messages: HistoryEntry[]; ended: boolean }

const toggle = (set: ReadonlySet<string>, key: string) => {
  const next = new Set(set)
  if (!next.delete(key)) next.add(key)
  return next
}

/**
 * 团队成员全屏页：顶栏是名字 + 状态 + 模型，下面先列它认领的任务，再是和主对话同一种
 * 只读时间线（队长交给它的任务、聚合的工具行、当前一步、回复）。团队在跑时定时刷新。
 */
export function MemberRun({ hostId, sessionId, agentId }: { hostId: string; sessionId: string; agentId: string }) {
  const colors = useColors()
  const { client, error: connectionError } = useConnection(hostId)
  const [live, setLive] = useState(true)
  const resource = useFocusedResource<Loaded>(
    useCallback(
      async (signal: AbortSignal) => {
        if (!client) throw new Error('正在连接电脑')
        const timeline = await loadTeam(client, sessionId, signal)
        // 团队收尾后会归档：成员和记录照样能看，只是不再刷新。
        const ended = !teamModel(timeline)
        const team = teamModel(timeline, [], { ended: true })
        const member = team?.members.find((row) => row.id === agentId) ?? null
        if (!team || !member) return { member: null, messages: [], ended: true }
        return { member, messages: await loadMemberHistory(client, team, agentId, signal), ended }
      },
      [client, sessionId, agentId]
    ),
    live ? REFRESH_MS : 0
  )
  const member = resource.value?.member ?? null
  // 团队结束或成员退出后不再刷新。
  const stillLive = !resource.value || (!resource.value.ended && !!member && member.state !== '已退出')
  if (stillLive !== live) setLive(stillLive)
  const working = member?.tone === 'run'
  const view = subagentRunView(resource.value ? { messages: resource.value.messages } : null, working, { teammates: 'show' })
  const [ui, setUi] = useState<StepUi>({ expanded: new Set(), open: new Set(), closed: new Set(), revealed: new Set() })
  const context: StepContext = { workDir: undefined, waiting: new Set(), background: new Set(), turnActive: working }
  const rows = visibleChatRows(view.rows, ui.open)
  const list = useRef<FlatList<ChatRow>>(null)
  const stick = useRef(true)
  if (resource.value && !member)
    return (
      <ScreenView>
        <NavBar title="团队成员" />
        <EmptyState title="找不到这个成员" detail="这段会话里已经没有这个团队的记录。" />
      </ScreenView>
    )
  return (
    <ScreenView>
      <NavBar
        title={member?.name ?? '团队成员'}
        subtitle={
          member ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              {working ? <Spinner size={11} thickness={2.6} /> : null}
              <Text style={{ fontSize: 12, lineHeight: 16, fontWeight: '500', color: memberTone(member, colors) }}>{member.state}</Text>
              {member.model ? (
                <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 12, lineHeight: 16, color: colors.ink3 }}>{`· ${member.model}`}</Text>
              ) : null}
            </View>
          ) : undefined
        }
      />
      <View style={{ paddingHorizontal: 16 }}>
        <InlineError text={connectionError || (resource.value ? '' : resource.error)} />
      </View>
      {resource.loading && !resource.value ? (
        <Loading />
      ) : (
        <FlatList
          ref={list}
          data={rows}
          keyExtractor={(row) => row.key}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24, gap: 14 }}
          onScroll={({ nativeEvent }) => {
            const { contentOffset, contentSize, layoutMeasurement } = nativeEvent
            stick.current = contentSize.height - (contentOffset.y + layoutMeasurement.height) < 80
          }}
          scrollEventThrottle={64}
          onContentSizeChange={() => {
            if (working && stick.current) list.current?.scrollToEnd({ animated: false })
          }}
          ListHeaderComponent={
            member?.tasks.length ? (
              <View style={{ backgroundColor: colors.card, borderRadius: 16, boxShadow: `0 0 0 1px ${colors.hair}`, overflow: 'hidden', marginBottom: 2 }}>
                <View style={{ marginTop: -1 }}>
                  <TaskLines tasks={member.tasks} />
                </View>
              </View>
            ) : undefined
          }
          ListEmptyComponent={
            <Footnote>{working ? '它还没有留下可看的内容，稍等一下。' : '没有可以显示的执行记录。'}</Footnote>
          }
          ListFooterComponent={working && view.current ? <StatusCaption step={view.current} /> : undefined}
          renderItem={({ item: row }) =>
            row.kind === 'turn' ? (
              <TurnFold
                label={row.label}
                open={ui.open.has(row.key)}
                onToggle={() => setUi((value) => ({ ...value, open: toggle(value.open, row.key) }))}
              />
            ) : row.kind === 'message' && (row.item.id === view.prompt?.id || row.item.teammateFrom) ? (
              <View style={{ alignItems: 'flex-end', gap: 5 }}>
                <Text style={{ fontSize: 12, color: colors.ink3, paddingRight: 4 }}>
                  {row.item.teammateFrom ? `${teammateLabel(row.item.teammateFrom)} 发来` : '队长交给它的任务'}
                </Text>
                <TaskPrompt text={row.item.text ?? ''} />
              </View>
            ) : row.kind === 'message' ? (
              <Message item={row.item} />
            ) : (
              <StepGroup
                row={row}
                context={context}
                ui={ui}
                onToggleStep={(key) => setUi((value) => ({ ...value, expanded: toggle(value.expanded, key) }))}
                onToggleOpen={(key, open) => setUi((value) => toggleGroupOpen(value, key, open))}
                onReveal={(key) => setUi((value) => ({ ...value, revealed: toggle(value.revealed, key) }))}
              />
            )
          }
        />
      )}
      <ReadOnlyBar />
    </ScreenView>
  )
}
