import { useCallback, useEffect, useMemo, useState } from 'react'
import { Animated, BackHandler, Easing, Pressable, ScrollView, View, useWindowDimensions } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Text } from '../ui/Text'
import { useConnection } from '../state/AppContext'
import { listCheckpoints } from '../core/operations'
import { useFocusedResource } from '../core/useFocusedResource'
import { latestCheckpoint, translateReason } from '../core/changesView'
import { EmptyState, Icon, InlineError, Loading, useColors } from '../ui/kit'
import { KeyboardViewport } from '../ui/KeyboardViewport'
import { useCheckpointFileSummaries } from '../ui/results/hooks'
import { checkpointLists, sessionKey } from '../ui/results/resultsCache'
import {
  ChangedFileRow,
  FilesSearchBar,
  FilesTabs,
  Hairline,
  LinkRow,
  SearchResultRow,
  TreeFileRow,
  floatShadow,
} from '../ui/files/FileRows'
import {
  changedRows,
  filterChanged,
  parseFilesTab,
  searchQuery,
  treeItems,
  type FilesTab,
} from '../ui/files/filesModel'
import { useFileSearch, useWorkspaceTree } from '../ui/files/useWorkspaceFiles'

/**
 * Files sheet: both Files and Changes in the session "…" menu land here.
 * Route params id (session), host, tab=changed|all.
 * It is a transparent modal route that draws its own backdrop and rounded white sheet, so iOS and Android look the same; 
 * registering the same presentation in _layout is more reliable (see options below).
 */
export default function Files() {
  const { id, host, tab } = useLocalSearchParams<{ id: string; host: string; tab?: string }>()
  return <FilesSheet key={`${host}:${id}`} hostId={host} id={id} initialTab={parseFilesTab(tab)} />
}

const sheetOptions = {
  presentation: 'transparentModal',
  animation: 'none',
  contentStyle: { backgroundColor: 'transparent' },
} as const

function FilesSheet({ hostId, id, initialTab }: { hostId: string; id: string; initialTab: FilesTab }) {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const { height: windowHeight } = useWindowDimensions()
  const { client, error: connectionError } = useConnection(hostId)
  const [tab, setTab] = useState<FilesTab>(initialTab)
  const [query, setQuery] = useState('')
  const needle = searchQuery(query)

  /* Enter/exit animation: backdrop fades in, sheet slides up; reversed on close, and only actually goes back after the animation ends. */
  const [progress] = useState(() => new Animated.Value(0))
  const [closing, setClosing] = useState(false)
  useEffect(() => {
    Animated.timing(progress, {
      toValue: 1,
      duration: 260,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start()
  }, [progress])
  const close = useCallback(() => {
    if (closing) return
    setClosing(true)
    Animated.timing(progress, {
      toValue: 0,
      duration: 200,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(() => {
      if (router.canGoBack()) router.back()
      else router.replace('/')
    })
  }, [closing, progress])
  // Take over the back key only while this is the current page. It stays mounted under diff / file / changes, 
  // and if it always listened it would steal the back key: after sliding off screen it would leave an invisible transparent page covering chat.
  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        close()
        return true
      })
      return () => subscription.remove()
    }, [close])
  )

  /* Modified: latest turn checkpoint */
  const key = sessionKey(hostId, id)
  const checkpoints = useFocusedResource(
    useCallback(
      async (signal: AbortSignal) => {
        if (!client) return null
        const result = await listCheckpoints(client, id, signal)
        checkpointLists.set(key, result.checkpoints)
        return result
      },
      [client, id, key]
    )
  )
  const latest = latestCheckpoint(checkpoints.value?.checkpoints ?? [])
  const summary = useCheckpointFileSummaries(client, hostId, id, latest)
  const changed = useMemo(
    () => changedRows(latest?.code.filesChanged ?? [], summary),
    [latest, summary]
  )
  const shownChanged = filterChanged(changed, needle)

  /* All files: directory tree + in-project search */
  const tree = useWorkspaceTree(client, id, tab === 'all')
  const items = useMemo(() => treeItems(tree.dirs, tree.open), [tree.dirs, tree.open])
  const search = useFileSearch(client, id, needle, tab === 'all')

  const openDiff = (path: string) =>
    latest &&
    router.push({
      pathname: '/diff',
      params: { id, host: hostId, source: 'turn', target: latest.target.targetUserMessageId, path },
    })
  const openFile = (path: string) =>
    router.push({ pathname: '/file', params: { id, host: hostId, path } })
  const openChanges = () => router.push({ pathname: '/changes', params: { id, host: hostId } })
  const openWorkspace = () => router.push({ pathname: '/workspace', params: { id, host: hostId } })

  const pageError = connectionError || (checkpoints.value ? '' : checkpoints.error)
  const bottomGap = Math.max(insets.bottom, 12) + 22
  const listPadding = 52 + bottomGap + 24

  let body
  if (tab === 'changed') {
    if (!checkpoints.value) {
      body = pageError ? (
        <InlineError text={pageError} style={{ margin: 16 }} />
      ) : (
        <Loading />
      )
    } else if (!latest) {
      body = (
        <>
          {/* Uncommitted changes in the project directory are viewable even without checkpoints; otherwise this page could not reach "Project files". */}
          <LinkRow title="View current uncommitted changes in the project" onPress={openWorkspace} />
          <EmptyState
            icon="file"
            title="No change records yet"
            detail="The computer records available file checkpoints after the session runs."
          />
        </>
      )
    } else {
      body = (
        <>
          <InlineError text={pageError} style={{ margin: 16, marginBottom: 0 }} />
          <LinkRow title="View all changes and rewind" onPress={openChanges} />
          {changed.length ? (
            shownChanged.length ? (
              shownChanged.map((row) => (
                <ChangedFileRow key={row.path} row={row} onPress={() => openDiff(row.path)} />
              ))
            ) : (
              <EmptyState icon="search" title="No matching files" detail="Searches only files changed in this turn." />
            )
          ) : (
            <EmptyState
              icon="file"
              title="No files changed in this turn"
              detail={translateReason(latest.code.reason)}
            />
          )}
        </>
      )
    }
  } else if (needle) {
    body = search.error ? (
      <InlineError text={search.error} style={{ margin: 16 }} />
    ) : search.pending ? (
      <Loading />
    ) : search.rows.length ? (
      <>
        {search.rows.map((row) => (
          <SearchResultRow key={row.path} row={row} onPress={() => openFile(row.path)} />
        ))}
        {search.truncated ? (
          <Text style={{ padding: 16, fontSize: 13, color: colors.ink3 }}>
            Showing only the first 200; try a more specific term.
          </Text>
        ) : null}
      </>
    ) : (
      <EmptyState icon="search" title="No matching files" />
    )
  } else {
    body = connectionError ? (
      <InlineError text={connectionError} style={{ margin: 16 }} />
    ) : (
      items.map((item) => (
        <TreeFileRow
          key={item.key}
          item={item}
          onToggle={tree.toggle}
          onOpenFile={openFile}
          onRetry={tree.retry}
        />
      ))
    )
  }

  const top = Math.max(insets.top - 4, 8)
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={sheetOptions} />
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: colors.scrim,
          opacity: progress,
        }}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close files"
        onPress={close}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, height: top + 24 }}
      />
      <KeyboardViewport pointerEvents="box-none" style={{ flex: 1, paddingTop: top }}>
        <Animated.View
          accessibilityViewIsModal
          onAccessibilityEscape={close}
          style={{
            flex: 1,
            backgroundColor: colors.sheet,
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            overflow: 'hidden',
            transform: [
              {
                translateY: progress.interpolate({
                  inputRange: [0, 1],
                  outputRange: [windowHeight, 0],
                }),
              },
            ],
          }}
        >
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: 6,
              alignSelf: 'center',
              width: 36,
              height: 5,
              borderRadius: 3,
              backgroundColor: colors.chevron,
              opacity: 0.6,
            }}
          />
          <View style={{ height: 64, alignItems: 'center', justifyContent: 'center', paddingTop: 6 }}>
            <Text accessibilityRole="header" style={{ fontSize: 17, fontWeight: '600', color: colors.ink }}>
              Files
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={close}
            style={({ pressed }) => ({
              position: 'absolute',
              top: 14,
              right: 16,
              width: 44,
              height: 44,
              borderRadius: 22,
              backgroundColor: colors.card,
              boxShadow: floatShadow(colors.hair),
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Icon name="x" size={20} color={colors.ink} strokeWidth={2.2} />
          </Pressable>
          <View style={{ paddingTop: 14, paddingBottom: 10 }}>
            <FilesTabs value={tab} onChange={setTab} />
          </View>
          <View style={{ height: 1, backgroundColor: colors.hair }} />
          <ScrollView
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingBottom: listPadding }}
          >
            {body}
            {tab === 'changed' && changed.length ? <Hairline inset={0} /> : null}
          </ScrollView>
          <LinearGradient
            pointerEvents="none"
            colors={[`${colors.sheet}00`, colors.sheet]}
            locations={[0, 0.7]}
            style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 120 }}
          />
          <FilesSearchBar value={query} onChangeText={setQuery} bottom={bottomGap} />
        </Animated.View>
      </KeyboardViewport>
    </View>
  )
}
