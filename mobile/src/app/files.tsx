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
 * 文件底单：会话「…」菜单的「文件」「更改」都进这里。
 * 路由参数 id（会话）、host、tab=changed|all。
 * 它是一个透明的 modal 路由，自己画遮罩和圆角的白底，所以 iOS 和 Android 长得一样；
 * 在 _layout 里注册同样的 presentation 更稳（见下面的 options）。
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

  /* 进出动画：遮罩淡入、白底从下滑上来；关闭时反过来，动画结束才真正返回。 */
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
  // 只在这一页是当前页时接管返回键。页面压在 diff / file / changes 下面时它仍然挂载，
  // 若一直监听，返回键会被它抢走：它自己滑出屏幕后留下一层看不见的透明页盖住聊天页。
  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        close()
        return true
      })
      return () => subscription.remove()
    }, [close])
  )

  /* 已修改：最近一轮检查点 */
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

  /* 所有文件：目录树 + 项目内搜索 */
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
          {/* 没有检查点也能看项目目录里没提交的改动，否则这一页进不了「项目文件」。 */}
          <LinkRow title="查看项目当前未提交的改动" onPress={openWorkspace} />
          <EmptyState
            icon="file"
            title="还没有改动记录"
            detail="电脑会在会话运行后记录可用的文件检查点。"
          />
        </>
      )
    } else {
      body = (
        <>
          <InlineError text={pageError} style={{ margin: 16, marginBottom: 0 }} />
          <LinkRow title="查看全部改动与回退" onPress={openChanges} />
          {changed.length ? (
            shownChanged.length ? (
              shownChanged.map((row) => (
                <ChangedFileRow key={row.path} row={row} onPress={() => openDiff(row.path)} />
              ))
            ) : (
              <EmptyState icon="search" title="没有匹配的文件" detail="只在这一轮更改的文件里找。" />
            )
          ) : (
            <EmptyState
              icon="file"
              title="这一轮没有更改的文件"
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
            只显示前 200 个，换个更具体的词。
          </Text>
        ) : null}
      </>
    ) : (
      <EmptyState icon="search" title="没有匹配的文件" />
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
        accessibilityLabel="关闭文件"
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
              文件
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭"
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
