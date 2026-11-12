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
 * Team member full-screen page: the header is name + status + model; below first its claimed tasks, then the same
 * read-only timeline as the main conversation (task from the lead, aggregated tool rows, current step, replies). Refreshes periodically while the team runs.
 */
export function MemberRun({ hostId, sessionId, agentId }: { hostId: string; sessionId: string; agentId: string }) {
  const colors = useColors()
  const { client, error: connectionError } = useConnection(hostId)
  const [live, setLive] = useState(true)
  const resource = useFocusedResource<Loaded>(
    useCallback(
      async (signal: AbortSignal) => {
        if (!client) throw new Error('Connecting to computer')
        const timeline = await loadTeam(client, sessionId, signal)
        // After the team wraps up it is archived: members and records stay viewable, just no longer refreshed.
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
  // No more refreshing after the team ends or the member exits.
  const stillLive = !resource.value || (!resource.value.ended && !!member && member.state !== 'Exited')
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
        <NavBar title="Team member" />
        <EmptyState title="Cannot find this member" detail="This session no longer has records of this team." />
      </ScreenView>
    )
  return (
    <ScreenView>
      <NavBar
        title={member?.name ?? 'Team member'}
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
            <Footnote>{working ? 'It has not left anything to view yet; wait a moment.' : 'No execution log to show.'}</Footnote>
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
                  {row.item.teammateFrom ? `${teammateLabel(row.item.teammateFrom)} sent` : 'Task given by the lead'}
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
