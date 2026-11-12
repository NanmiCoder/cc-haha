import { useCallback, useRef, useState, type ReactNode } from 'react'
import { Pressable, ScrollView, View, type ScrollViewInstance } from 'react-native'
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useConnection } from '../state/AppContext'
import { summarizeWorkspaceStatus } from '../core/workspaceStatus'
import {
  breadcrumbs,
  errorMessage,
  isImagePath,
  projectName,
  workspaceBadge,
  workspaceStatusLabel,
} from '../core/changesView'
import {
  Button,
  EmptyState,
  Footnote,
  Group,
  Icon,
  IconButton,
  InlineError,
  Loading,
  Mono,
  NavBar,
  ScreenView,
  Segmented,
  Separator,
  useColors,
} from '../ui/kit'
import { FileChangeRow, SubtitleLine, TreeRow } from '../ui/results/parts'
import {
  sessionKey,
  workspaceStatuses,
  type WorkspaceChange,
  type WorkspaceStatus,
} from '../ui/results/resultsCache'

type Entry = { name: string; path: string; isDirectory: boolean }
type Tree = { state: string; entries?: Entry[]; error?: string }
type Tab = 'changes' | 'files'

export default function Workspace() {
  const { id, host } = useLocalSearchParams<{ id: string; host: string }>()
  return <WorkspacePage key={`${host}:${id}`} hostId={host} id={id} />
}

function changeDetail(change: WorkspaceChange) {
  if (change.status === 'renamed' && change.oldPath) return `Renamed from ${change.oldPath}`
  return workspaceStatusLabel(change.status)
}

function WorkspacePage({ hostId, id }: { hostId: string; id: string }) {
  const colors = useColors()
  const { host, client, error: connectionError } = useConnection(hostId)
  const key = sessionKey(hostId, id)
  const root = `/api/sessions/${encodeURIComponent(id)}/workspace`
  const [tab, setTab] = useState<Tab>('changes')
  const [path, setPath] = useState('')
  const [revision, setRevision] = useState(0)
  const [status, setStatus] = useState<{ value?: WorkspaceStatus; error?: string } | null>(
    null
  )
  const [tree, setTree] = useState<{ path: string; value?: Tree; error?: string } | null>(
    null
  )
  const crumbs = useRef<ScrollViewInstance>(null)

  // Workspace status: refresh every time this page is revisited, keeping old results meanwhile so it does not flash blank.
  useFocusEffect(
    useCallback(() => {
      void revision
      if (!client) return
      const controller = new AbortController()
      client
        .get<WorkspaceStatus>(`${root}/status`, { signal: controller.signal })
        .then((value) => {
          if (controller.signal.aborted) return
          workspaceStatuses.set(key, value)
          setStatus({ value })
        })
        .catch((error) => {
          if (!controller.signal.aborted) setStatus({ error: errorMessage(error) })
        })
      return () => controller.abort()
    }, [client, key, root, revision])
  )

  // Current directory.
  useFocusEffect(
    useCallback(() => {
      void revision
      if (!client) return
      const controller = new AbortController()
      client
        .get<Tree>(`${root}/tree?path=${encodeURIComponent(path)}`, {
          signal: controller.signal,
        })
        .then((value) => {
          if (!controller.signal.aborted) setTree({ path, value })
        })
        .catch((error) => {
          if (!controller.signal.aborted) setTree({ path, error: errorMessage(error) })
        })
      return () => controller.abort()
    }, [client, root, path, revision])
  )

  const summary = status?.value ? summarizeWorkspaceStatus(status.value) : null
  const changed = summary?.kind === 'changes' ? (status?.value?.changedFiles ?? []) : []
  const changedByPath = new Map(changed.map((change) => [change.path, change]))
  const project = projectName(status?.value ?? null)
  const branch = status?.value?.branch
  const countLabel =
    summary?.kind === 'changes' || summary?.kind === 'clean'
      ? `Uncommitted changes · ${changed.length}`
      : 'Uncommitted changes'
  const waiting = !client && !connectionError

  const openDiff = (filePath: string) =>
    router.push({
      pathname: '/diff',
      params: { id, host: hostId, source: 'workspace', path: filePath },
    })
  const openFile = (filePath: string) =>
    router.push({ pathname: '/file', params: { id, host: hostId, path: filePath } })

  let changesBody: ReactNode = null
  if (connectionError) changesBody = null
  else if (waiting || !status) changesBody = <Loading />
  else if (status.error) changesBody = <InlineError text={status.error} />
  else if (summary?.kind === 'clean')
    changesBody = <EmptyState icon="circle-check" title="Workspace is clean" detail="File changes on the computer show up here." />
  else if (summary?.kind === 'not_git_repo')
    changesBody = (
      <EmptyState
        icon="folder"
        title="Plain folder"
        detail="This workspace has no Git repository; switch to Files to view contents."
        action={<Button title="View all files" variant="secondary" onPress={() => setTab('files')} />}
      />
    )
  else if (summary?.kind === 'missing')
    changesBody = (
      <EmptyState icon="circle-alert" title="Working directory unavailable" detail="Restore this session’s working directory on the computer and refresh." />
    )
  else if (summary?.kind === 'unavailable')
    changesBody = <EmptyState icon="wifi-off" title="Workspace status not loaded yet" detail="Check the computer connection and refresh." />
  else if (summary?.kind === 'error') changesBody = <InlineError text={summary.message} />
  else
    changesBody = (
      <>
        <Group>
          {changed.map((change, index) => (
            <View key={change.path}>
              {index ? <Separator inset={48} /> : null}
              <FileChangeRow
                path={change.path}
                status={workspaceBadge(change.status)}
                added={change.additions}
                removed={change.deletions}
                detail={changeDetail(change)}
                onPress={() => openDiff(change.path)}
              />
            </View>
          ))}
        </Group>
        <Footnote style={{ paddingTop: 10 }}>Read-only. To change files, just tell it.</Footnote>
      </>
    )

  const currentTree = tree?.path === path ? tree : undefined
  const entries = currentTree?.value?.entries ?? []
  let filesBody: ReactNode = null
  if (connectionError) filesBody = null
  else if (waiting || !currentTree) filesBody = <Loading />
  else if (currentTree.error) filesBody = <InlineError text={currentTree.error} />
  else if (currentTree.value?.state !== 'ok')
    filesBody = <InlineError text={currentTree.value?.error || 'Directory cannot be read'} />
  else if (!entries.length) filesBody = <EmptyState icon="folder" title="This folder is empty" />
  else
    filesBody = (
      <>
        <Group>
          {entries.map((entry, index) => {
            const change = changedByPath.get(entry.path)
            return (
              <View key={entry.path}>
                {index ? <Separator inset={46} /> : null}
                <TreeRow
                  name={entry.name}
                  directory={entry.isDirectory}
                  image={!entry.isDirectory && isImagePath(entry.name)}
                  badge={change ? workspaceBadge(change.status) : undefined}
                  onPress={() => (entry.isDirectory ? setPath(entry.path) : openFile(entry.path))}
                />
              </View>
            )
          })}
        </Group>
        <Footnote style={{ paddingTop: 10 }}>Read-only. To change files, just tell it.</Footnote>
      </>
    )

  const trail = breadcrumbs(project || host?.name || 'Workspace', path)

  return (
    <ScreenView>
      <NavBar
        title="Project files"
        subtitle={
          project ? (
            <SubtitleLine>
              {project}
              {branch ? ' · ' : null}
              {branch ? <Mono style={{ fontSize: 12 }}>{branch}</Mono> : null}
            </SubtitleLine>
          ) : (
            <SubtitleLine>{host?.name ?? ' '}</SubtitleLine>
          )
        }
        right={
          <IconButton
            icon="refresh-cw"
            label="Refresh"
            iconSize={20}
            color={colors.ink2}
            disabled={!client}
            onPress={() => setRevision((value) => value + 1)}
          />
        }
      />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 32 }}>
        <InlineError text={connectionError} style={{ marginBottom: 12 }} />
        <Segmented<Tab>
          label="View contents"
          height={36}
          options={[
            { label: countLabel, value: 'changes' },
            { label: 'All files', value: 'files' },
          ]}
          value={tab}
          onChange={setTab}
        />
        {tab === 'changes' ? (
          <View style={{ paddingTop: 16 }}>{changesBody}</View>
        ) : (
          <>
            <ScrollView
              ref={crumbs}
              horizontal
              showsHorizontalScrollIndicator={false}
              onContentSizeChange={() => crumbs.current?.scrollToEnd({ animated: false })}
              contentContainerStyle={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
                paddingTop: 16,
                paddingBottom: 8,
                paddingHorizontal: 4,
              }}
            >
              {trail.map((crumb, index) => {
                const last = index === trail.length - 1
                return (
                  <View key={crumb.path} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    {index ? (
                      <Icon name="chevron-right" size={12} color={colors.ink3} strokeWidth={2.2} />
                    ) : null}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={last ? `Current directory ${crumb.label}` : `Open ${crumb.label}`}
                      accessibilityState={{ disabled: last }}
                      disabled={last}
                      hitSlop={{ top: 10, bottom: 10, left: 4, right: 4 }}
                      onPress={() => setPath(crumb.path)}
                    >
                      <Mono
                        style={{
                          fontSize: 13,
                          lineHeight: 18,
                          color: last ? colors.ink : colors.ink3,
                          fontWeight: last ? '500' : '400',
                        }}
                      >
                        {crumb.label}
                      </Mono>
                    </Pressable>
                  </View>
                )
              })}
            </ScrollView>
            {filesBody}
          </>
        )}
      </ScrollView>
    </ScreenView>
  )
}
