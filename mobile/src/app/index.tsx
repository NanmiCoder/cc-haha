import { useMemo, useState } from 'react'
import { RefreshControl, ScrollView, View } from 'react-native'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Text } from '../ui/Text'
import { useApp, useConnection } from '../state/AppContext'
import { useDashboard } from '../state/DashboardContext'
import { isH5, reconnectH5 } from '../state/h5'
import { groupDashboard, type DashboardRow } from '../core/dashboard'
import { EmptyState, Icon, InlineError, Loading, ScreenView, useColors } from '../ui/kit'
import { Logo } from '../ui/Logo'
import { canStartTask, hostLink, projectsOf } from '../ui/home/homeModel'
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
import { ComputerCard } from '../ui/home/ComputerCard'
import { useHostCardInfo } from '../ui/home/useHostCardInfo'
import { Welcome } from '../ui/home/Welcome'
import {
  FilterPills,
  FloatButton,
  FloatingComposer,
  MoreSessions,
  OfflineRow,
  ProjectHeader,
  ProjectSessionRow,
  RecentRow,
  SectionTitle,
} from '../ui/home/LightRows'
import { useBackgroundCounts } from '../ui/home/useBackgroundCounts'

const projectPage = 6
const offlineRecent = 5

export default function Home() {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const { ready, error: storageError } = useApp()
  const { host, error: credentialError, credentialIssue } = useConnection()
  const { snapshot, loading, fresh, error, failure, refresh } = useDashboard()
  const [searching, setSearching] = useState(false)
  // Status filters and project expansion are in memory only and follow the computer: switching computers resets to defaults.
  const [view, setView] = useState<{
    hostId: string
    filter: HomeFilter
    expanded: Record<string, boolean>
    shown: Record<string, number>
  } | null>(null)
  const mine = view && view.hostId === host?.id ? view : null
  const expanded = useMemo(() => mine?.expanded ?? {}, [mine])
  const shown = useMemo(() => mine?.shown ?? {}, [mine])
  const link = hostLink({ host, fresh, failure, credentialError, credentialIssue })
  // Model name / pairing expiry in the computer card status row: read only when the computer is reachable.
  const cardInfo = useHostCardInfo(link === 'online' || link === 'slow')

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
  // dir An existing new-task page param: when present, preselect this project as the working directory.
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

  // No computer yet: the whole page is the welcome page with no header (≡ and search lead nowhere without a computer).
  if (ready && !host)
    return (
      <ScreenView>
        <Welcome
          error={storageError}
          onScan={() => router.push('/connect')}
          onManual={() => router.push({ pathname: '/connect', params: { mode: 'manual' } })}
        />
      </ScreenView>
    )

  return (
    <View style={{ flex: 1 }}>
      <ScreenView>
        <View
          style={{
            height: 44,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            paddingHorizontal: 16,
          }}
        >
          {/* The brand is only a mark and not tappable; settings are on the right. */}
          <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 9 }}>
            <Logo size={35} />
            <Text
              accessibilityRole="header"
              style={{ fontSize: 20, lineHeight: 24, fontWeight: '700', letterSpacing: -0.2, color: colors.ink }}
            >
              cc-haha
            </Text>
          </View>
          <FloatButton
            label="Search tasks or projects"
            disabled={!host || disconnected}
            onPress={() => setSearching(true)}
          >
            <Icon name="search" size={20} color={colors.ink} strokeWidth={2} />
          </FloatButton>
          <FloatButton label="Settings" onPress={() => router.push('/settings')}>
            <Icon name="settings" size={21} color={colors.ink} strokeWidth={1.9} />
          </FloatButton>
        </View>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingTop: 14,
            paddingBottom: 96 + Math.max(insets.bottom, 12),
            flexGrow: 1,
          }}
          refreshControl={
            host ? (
              <RefreshControl refreshing={loading} onRefresh={refresh} tintColor={colors.ink3} />
            ) : undefined
          }
        >
          {host ? (
            <View style={{ marginBottom: 14 }}>
              <ComputerCard
                name={host.name}
                host={host}
                link={link}
                lastSyncedAt={snapshot?.checkedAt}
                model={cardInfo?.model}
                expiresAt={cardInfo?.expiresAt}
                onOpen={() =>
                  router.push({ pathname: '/computer', params: { host: host.id } })
                }
                onSwitch={isH5 ? undefined : () => router.push('/hosts')}
                onReconnect={() => void refresh()}
                onRepair={() => (isH5 ? reconnectH5(host.auth === 'remote') : router.push('/connect'))}
              />
            </View>
          ) : null}
          {!ready || !host ? (
            <Loading />
          ) : (
            <>
              <InlineError
                text={storageError || credentialError || (link === 'failed' ? error : '')}
                style={{ marginBottom: 12 }}
              />
              {disconnected ? (
                <>
                  {all.length ? (
                    <View style={{ opacity: 0.72 }}>
                      <SectionTitle>State before disconnect</SectionTitle>
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
                  title="No tasks yet"
                  detail="Hand the next thing to your computer and watch its progress here."
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
                  <SectionTitle>Recent</SectionTitle>
                  {recent.map((row) => (
                    <RecentRow
                      key={row.session.id}
                      row={row}
                      background={background[row.session.id]}
                      onPress={() => open(row)}
                    />
                  ))}
                  {groups.length || loose.length ? <SectionTitle bottom={4}>Projects</SectionTitle> : null}
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
                      <SectionTitle>Other</SectionTitle>
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
          <FloatingComposer disabled={!canStart} onPress={() => newTask()} />
        ) : null}
      </ScreenView>
    </View>
  )
}
