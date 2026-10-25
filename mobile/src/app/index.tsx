import { useMemo, useState } from 'react'
import { Pressable, RefreshControl, ScrollView, View } from 'react-native'
import { router } from 'expo-router'
import { Text } from '../ui/Text'
import { useApp, useConnection } from '../state/AppContext'
import { useDashboard } from '../state/DashboardContext'
import { groupDashboard, type DashboardRow } from '../core/dashboard'
import {
  BottomBar,
  Button,
  EmptyState,
  Icon,
  IconButton,
  InlineError,
  LargeTitle,
  Loading,
  ScreenView,
  SectionHeader,
  TextButton,
  useColors,
} from '../ui/kit'
import {
  canStartTask,
  hostLink,
  hostStatusLine,
  inProject,
  projectsOf,
  type HostLink,
} from '../ui/home/homeModel'
import { DecisionCard } from '../ui/home/DecisionCard'
import { HomeSearch } from '../ui/home/HomeSearch'
import { HostSheet } from '../ui/home/HostSheet'
import { ConnectEmpty, OfflineCard, ProjectSheet } from '../ui/home/HomeStates'
import { RowGroup, StatusDot, useNow } from '../ui/home/parts'
import { MoreRow, OfflineRow, RunningRow, SettledRow } from '../ui/home/SessionRows'
import { useBackgroundCounts } from '../ui/home/useBackgroundCounts'

const recentPage = 10
const offlineRecent = 5

export default function Home() {
  const colors = useColors()
  const { ready, error: storageError } = useApp()
  const { host, error: credentialError } = useConnection()
  const { snapshot, loading, fresh, error, failure, refresh } = useDashboard()
  const [searching, setSearching] = useState(false)
  const [hostSheet, setHostSheet] = useState(false)
  const [projectSheet, setProjectSheet] = useState(false)
  // 项目筛选只在内存里，并且跟着电脑走：换电脑后回到“全部项目”。
  const [filter, setFilter] = useState<{ hostId: string; key: string | null } | null>(null)
  const [recentShown, setRecentShown] = useState(recentPage)
  const projectKey = filter && filter.hostId === host?.id ? filter.key : null
  const link = hostLink({ host, fresh, failure, credentialError })

  const grouped = useMemo(
    () => groupDashboard(snapshot?.sessions ?? [], snapshot?.activity ?? []),
    [snapshot]
  )
  const all = useMemo(
    () =>
      [...grouped.waiting, ...grouped.running, ...grouped.settled].sort((a, b) =>
        b.session.modifiedAt.localeCompare(a.session.modifiedAt)
      ),
    [grouped]
  )
  const projects = useMemo(() => projectsOf(all), [all])
  const project = projects.find((item) => item.key === projectKey) ?? null
  const waiting = grouped.waiting.filter((row) => inProject(row, projectKey))
  const running = grouped.running.filter((row) => inProject(row, projectKey))
  const settled = grouped.settled.filter((row) => inProject(row, projectKey))
  const activeSessionIds = useMemo(
    () => [...grouped.waiting, ...grouped.running].map((row) => row.session.id),
    [grouped]
  )
  const background = useBackgroundCounts(
    grouped.running.map((row) => row.session.id),
    link === 'online' && !searching
  )

  const open = (row: DashboardRow, params: Record<string, string> = {}) =>
    host &&
    router.push({
      pathname: '/chat/[id]',
      params: { id: row.session.id, host: host.id, ...params },
    })
  const newTask = () =>
    host &&
    router.push({
      pathname: '/new',
      params: { host: host.id, ...(project ? { dir: project.dir } : {}) },
    })
  const disconnected = link === 'offline' || link === 'unauthorized'

  if (searching && host)
    return (
      <ScreenView>
        <HomeSearch
          rows={all}
          projects={projects}
          initialProject={projectKey}
          onCancel={() => setSearching(false)}
          onOpen={(row) => open(row)}
        />
      </ScreenView>
    )

  return (
    <ScreenView>
      <View
        style={{
          height: 44,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'flex-end',
          paddingHorizontal: 16,
        }}
      >
        <IconButton
          icon="settings"
          label="设置"
          color={colors.ink2}
          iconSize={22}
          onPress={() => router.push('/settings')}
        />
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 28, flexGrow: 1 }}
        refreshControl={
          host ? (
            <RefreshControl refreshing={loading} onRefresh={refresh} tintColor={colors.ink3} />
          ) : undefined
        }
      >
        {!ready ? (
          <Loading />
        ) : !host ? (
          <View style={{ flex: 1, justifyContent: 'center', paddingBottom: 44 }}>
            <InlineError text={storageError} />
            <ConnectEmpty onConnect={() => router.push('/connect')} />
          </View>
        ) : (
          <>
            <LargeTitle
              title={host.name}
              chevron
              subtitle={
                <StatusLine link={link} host={host} lastSyncedAt={snapshot?.checkedAt} />
              }
              accessibilityLabel={`${host.name}，切换电脑或查看这台电脑`}
              onPress={() => setHostSheet(true)}
            />
            {disconnected ? null : <SearchEntry onPress={() => setSearching(true)} />}
            <InlineError
              text={storageError || (link === 'failed' ? error : '')}
              style={{ marginTop: disconnected ? 0 : 12, marginBottom: disconnected ? 12 : 0 }}
            />
            {disconnected ? (
              <>
                <OfflineCard
                  unauthorized={link === 'unauthorized'}
                  onSwitch={() => setHostSheet(true)}
                  onReconnect={() =>
                    link === 'unauthorized' ? router.push('/connect') : refresh()
                  }
                />
                {all.length ? (
                  <>
                    <SectionHeader title="断开前的状态" />
                    <RowGroup style={{ opacity: 0.72 }}>
                      {[...waiting, ...running, ...settled.slice(0, offlineRecent)].map((row) => (
                        <OfflineRow key={row.session.id} row={row} />
                      ))}
                    </RowGroup>
                  </>
                ) : null}
              </>
            ) : !snapshot ? (
              <Loading />
            ) : !all.length ? (
              <EmptyState
                icon="compose"
                title="还没有任务"
                detail="把下一件事交给电脑，在这里看它的进展。"
                action={<Button title="新任务" icon="compose" onPress={newTask} />}
              />
            ) : !waiting.length && !running.length && !settled.length ? (
              <EmptyState
                icon="folder"
                title={`${project?.name ?? '这个项目'} 里没有任务`}
                action={
                  <View style={{ alignItems: 'center' }}>
                    <TextButton title="查看全部项目" onPress={() => setFilter(null)} />
                  </View>
                }
              />
            ) : (
              <>
                {waiting.length ? (
                  <>
                    <SectionHeader title="等你决定" count={waiting.length} countColor={colors.attn} />
                    <View style={{ gap: 10 }}>
                      {waiting.map((row) => (
                        <DecisionCard
                          key={row.session.id}
                          row={row}
                          onOpen={() => open(row)}
                          onRespond={(action, requestId) =>
                            open(row, { requestId, notificationAction: action })
                          }
                        />
                      ))}
                    </View>
                  </>
                ) : null}
                {running.length ? (
                  <>
                    <SectionHeader title="进行中" count={running.length} countColor={colors.run} />
                    <RowGroup>
                      {running.map((row) => (
                        <RunningRow
                          key={row.session.id}
                          row={row}
                          background={background[row.session.id]}
                          onPress={() => open(row)}
                        />
                      ))}
                    </RowGroup>
                  </>
                ) : null}
                {settled.length ? (
                  <>
                    <SectionHeader title="最近" />
                    <RowGroup>
                      {settled.slice(0, recentShown).map((row) => (
                        <SettledRow key={row.session.id} row={row} onPress={() => open(row)} />
                      ))}
                      {settled.length > recentShown ? (
                        <MoreRow
                          count={settled.length - recentShown}
                          onPress={() => setRecentShown((value) => value + 20)}
                        />
                      ) : null}
                    </RowGroup>
                  </>
                ) : null}
              </>
            )}
          </>
        )}
      </ScrollView>
      <BottomBar
        style={{
          paddingTop: 8,
          flexDirection: 'row',
          alignItems: 'flex-start',
          justifyContent: host ? 'space-between' : 'flex-end',
        }}
      >
        {host ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`按项目查看，当前${project?.name ?? '全部项目'}`}
            onPress={() => setProjectSheet(true)}
            style={({ pressed }) => ({
              height: 44,
              flexShrink: 1,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingHorizontal: 6,
              opacity: pressed ? 0.5 : 1,
            })}
          >
            <Icon name="list-filter" size={19} color={colors.ink2} />
            <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 15, color: colors.ink2 }}>
              {project?.name ?? '全部项目'}
            </Text>
          </Pressable>
        ) : null}
        <Button
          title="新任务"
          icon="compose"
          pill
          disabled={!canStartTask(link)}
          onPress={newTask}
          style={{ paddingLeft: 14 }}
        />
      </BottomBar>
      {host ? (
        <>
          <HostSheet
            visible={hostSheet}
            onClose={() => setHostSheet(false)}
            host={host}
            link={link}
            activeSessionIds={activeSessionIds}
          />
          <ProjectSheet
            visible={projectSheet}
            onClose={() => setProjectSheet(false)}
            projects={projects}
            selected={projectKey}
            total={all.length}
            onSelect={(key) => {
              setFilter({ hostId: host.id, key })
              setRecentShown(recentPage)
            }}
          />
        </>
      ) : null}
    </ScreenView>
  )
}

/** 大标题下的状态行：圆点 + “在线 · 局域网 / 连接中… / 离线 · N 分钟前最后同步”。 */
function StatusLine({
  link,
  host,
  lastSyncedAt,
}: {
  link: HostLink
  host: { auth: 'lan' | 'remote' }
  lastSyncedAt?: number
}) {
  const colors = useColors()
  const now = useNow(30000, link !== 'online')
  const status = hostStatusLine(link, host, lastSyncedAt, now)
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
    >
      <StatusDot tone={status.tone} />
      <Text style={{ fontSize: 13, lineHeight: 18, color: colors.ink3 }}>{status.text}</Text>
    </View>
  )
}

/** 常驻在大标题下的搜索入口；点开进入搜索态。 */
function SearchEntry({ onPress }: { onPress(): void }) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="search"
      accessibilityLabel="搜索任务或项目"
      onPress={onPress}
      style={({ pressed }) => ({
        height: 40,
        borderRadius: 12,
        backgroundColor: colors.fill,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Icon name="search" size={17} color={colors.ink3} strokeWidth={2} />
      <Text style={{ fontSize: 15, color: colors.ink3 }}>搜索任务或项目</Text>
    </Pressable>
  )
}
