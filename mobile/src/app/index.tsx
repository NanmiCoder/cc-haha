import { useMemo, useState } from 'react'
import { Pressable, RefreshControl, ScrollView, View } from 'react-native'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Text } from '../ui/Text'
import { useApp, useConnection } from '../state/AppContext'
import { useDashboard } from '../state/DashboardContext'
import { groupDashboard, type DashboardRow } from '../core/dashboard'
import { EmptyState, Icon, InlineError, Loading, ScreenView, useColors } from '../ui/kit'
import {
  canStartTask,
  hostLink,
  hostStatusLine,
  projectsOf,
  type HostLink,
} from '../ui/home/homeModel'
import {
  applyFilter,
  filterOptions,
  homeCounts,
  looseRows,
  projectGroups,
  recentRows,
  resolveFilter,
  type HomeFilter,
} from '../ui/home/homeList'
import { HomeSearch } from '../ui/home/HomeSearch'
import { HostSheet } from '../ui/home/HostSheet'
import { ConnectEmpty, OfflineCard } from '../ui/home/HomeStates'
import {
  FilterPills,
  FloatButton,
  FloatingComposer,
  MenuGlyph,
  MoreSessions,
  OfflineRow,
  ProjectHeader,
  ProjectSessionRow,
  RecentRow,
  SectionTitle,
} from '../ui/home/LightRows'
import { StatusDot, useNow } from '../ui/home/parts'
import { useBackgroundCounts } from '../ui/home/useBackgroundCounts'

const projectPage = 6
const offlineRecent = 5

export default function Home() {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const { ready, error: storageError } = useApp()
  const { host, error: credentialError } = useConnection()
  const { snapshot, loading, fresh, error, failure, refresh } = useDashboard()
  const [searching, setSearching] = useState(false)
  const [hostSheet, setHostSheet] = useState(false)
  // 状态筛选、项目展开都只在内存里，并且跟着电脑走：换电脑后回到默认。
  const [view, setView] = useState<{
    hostId: string
    filter: HomeFilter
    expanded: Record<string, boolean>
    shown: Record<string, number>
  } | null>(null)
  const mine = view && view.hostId === host?.id ? view : null
  const expanded = useMemo(() => mine?.expanded ?? {}, [mine])
  const shown = useMemo(() => mine?.shown ?? {}, [mine])
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
  const counts = useMemo(() => homeCounts(all), [all])
  const filter = resolveFilter(mine?.filter ?? 'all', counts)
  const rows = useMemo(() => applyFilter(all, filter), [all, filter])
  const recent = useMemo(() => recentRows(rows), [rows])
  const groups = useMemo(() => projectGroups(rows, expanded, new Set(recent)), [rows, expanded, recent])
  const loose = useMemo(() => looseRows(rows, new Set(recent)), [rows, recent])
  const activeSessionIds = useMemo(
    () => [...grouped.waiting, ...grouped.running].map((row) => row.session.id),
    [grouped]
  )
  const background = useBackgroundCounts(
    grouped.running.map((row) => row.session.id),
    link === 'online' && !searching
  )
  const patch = (next: Partial<NonNullable<typeof view>>) =>
    host &&
    setView({
      hostId: host.id,
      filter,
      expanded,
      shown,
      ...next,
    })

  const open = (row: DashboardRow, params: Record<string, string> = {}) =>
    host &&
    router.push({
      pathname: '/chat/[id]',
      params: { id: row.session.id, host: host.id, ...params },
    })
  // dir 是新任务页已有的参数：带上就把工作目录预选为这个项目。
  const newTask = (dir?: string) =>
    host &&
    router.push({
      pathname: '/new',
      params: { host: host.id, ...(dir ? { dir } : {}) },
    })
  const disconnected = link === 'offline' || link === 'unauthorized'
  const canStart = canStartTask(link)

  if (searching && host)
    return (
      <ScreenView>
        <HomeSearch
          rows={all}
          projects={projects}
          initialProject={null}
          onCancel={() => setSearching(false)}
          onOpen={(row) => open(row)}
        />
      </ScreenView>
    )

  return (
    <ScreenView>
      <View
        style={{
          height: 52,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingHorizontal: 16,
        }}
      >
        <FloatButton label="设置" onPress={() => router.push('/settings')}>
          <MenuGlyph color={colors.ink} />
        </FloatButton>
        <View style={{ flex: 1, minWidth: 0, alignItems: 'center' }}>
          {host ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${host.name}，切换电脑或查看这台电脑`}
              onPress={() => setHostSheet(true)}
              style={({ pressed }) => ({
                alignItems: 'center',
                justifyContent: 'center',
                minHeight: 44,
                maxWidth: '100%',
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: '100%' }}>
                <Text
                  numberOfLines={1}
                  style={{ flexShrink: 1, fontSize: 18, lineHeight: 22, fontWeight: '600', color: colors.ink }}
                >
                  {host.name}
                </Text>
                <Icon name="chevron-down" size={16} color={colors.ink3} strokeWidth={2.2} />
              </View>
              <StatusLine link={link} host={host} lastSyncedAt={snapshot?.checkedAt} />
            </Pressable>
          ) : null}
        </View>
        {host && !disconnected ? (
          <FloatButton label="搜索任务或项目" onPress={() => setSearching(true)}>
            <Icon name="search" size={20} color={colors.ink} strokeWidth={2} />
          </FloatButton>
        ) : (
          <View style={{ width: 44 }} />
        )}
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 8,
          paddingBottom: 96 + Math.max(insets.bottom, 12),
          flexGrow: 1,
        }}
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
            <InlineError
              text={storageError || (link === 'failed' ? error : '')}
              style={{ marginBottom: 12 }}
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
                  <View style={{ opacity: 0.72 }}>
                    <SectionTitle>断开前的状态</SectionTitle>
                    {[
                      ...grouped.waiting,
                      ...grouped.running,
                      ...grouped.settled.slice(0, offlineRecent),
                    ].map((row) => (
                      <OfflineRow key={row.session.id} row={row} />
                    ))}
                  </View>
                ) : null}
              </>
            ) : !snapshot ? (
              <Loading />
            ) : !all.length ? (
              <EmptyState
                icon="compose"
                title="还没有任务"
                detail="把下一件事交给电脑，在这里看它的进展。"
              />
            ) : (
              <>
                {filterOptions(counts).length > 1 ? (
                  <FilterPills
                    options={filterOptions(counts)}
                    value={filter}
                    onChange={(value) => patch({ filter: value })}
                  />
                ) : null}
                <SectionTitle>最近</SectionTitle>
                {recent.map((row) => (
                  <RecentRow
                    key={row.session.id}
                    row={row}
                    background={background[row.session.id]}
                    onPress={() => open(row)}
                  />
                ))}
                {groups.length || loose.length ? <SectionTitle>项目</SectionTitle> : null}
                {groups.map((group) => {
                  const limit = shown[group.key] ?? projectPage
                  return (
                    <View key={group.key}>
                      <ProjectHeader
                        group={group}
                        canStart={canStart}
                        onToggle={() =>
                          patch({ expanded: { ...expanded, [group.key]: !group.expanded } })
                        }
                        onNewTask={() => newTask(group.dir)}
                      />
                      {group.expanded && group.expandable ? (
                        <>
                          {group.rows.slice(0, limit).map((row) => (
                            <ProjectSessionRow
                              key={row.session.id}
                              row={row}
                              onPress={() => open(row)}
                            />
                          ))}
                          {group.rows.length > limit ? (
                            <MoreSessions
                              count={group.rows.length - limit}
                              onPress={() =>
                                patch({ shown: { ...shown, [group.key]: limit + 20 } })
                              }
                            />
                          ) : null}
                        </>
                      ) : null}
                    </View>
                  )
                })}
                {loose.length ? (
                  <>
                    <SectionTitle>其他</SectionTitle>
                    {loose.map((row) => (
                      <RecentRow
                        key={row.session.id}
                        row={row}
                        background={background[row.session.id]}
                        onPress={() => open(row)}
                      />
                    ))}
                  </>
                ) : null}
              </>
            )}
          </>
        )}
      </ScrollView>
      {host ? (
        <>
          <FloatingComposer disabled={!canStart} onPress={() => newTask()} />
          <HostSheet
            visible={hostSheet}
            onClose={() => setHostSheet(false)}
            host={host}
            link={link}
            activeSessionIds={activeSessionIds}
          />
        </>
      ) : null}
    </ScreenView>
  )
}

/** 标题下的状态行：圆点 + “在线 · 局域网 / 连接中… / 离线 · N 分钟前最后同步”。 */
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
      style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}
    >
      <StatusDot tone={status.tone} size={6} />
      <Text numberOfLines={1} style={{ fontSize: 12, lineHeight: 16, color: colors.ink3 }}>
        {status.text}
      </Text>
    </View>
  )
}
