import { useCallback, useState } from 'react'
import { Image, Platform, ScrollView, View } from 'react-native'
import { Text } from '../ui/Text'
import { useFocusEffect, useLocalSearchParams } from 'expo-router'
import { fetch as expoFetch } from 'expo/fetch'
import { Directory, File as NativeFile, Paths } from 'expo-file-system'
import * as Sharing from 'expo-sharing'
import { randomUUID } from 'expo-crypto'
import { shareFocusedWorkspaceFile } from '../core/workspaceShare'
import {
  downloadWorkspaceFile,
  type DownloadFetch,
} from '../core/workspaceDownload'
import { useConnection } from '../state/AppContext'
import { FocusedRequests } from '../core/focusedRequests'
import { summarizeWorkspaceStatus } from '../core/workspaceStatus'
import {
  Button,
  Empty,
  Loading,
  Notice,
  Row,
  Screen,
  errorText,
  mono,
  useTheme,
} from '../ui/theme'

type Entry = { name: string; path: string; isDirectory: boolean }
type File = {
  state: string
  content?: string
  dataUrl?: string
  previewType?: string
  truncated?: boolean
  error?: string
}
type Status = {
  state: string
  branch?: string
  changedFiles: {
    path: string
    status: string
    additions: number
    deletions: number
  }[]
  error?: string
}
export default function Workspace() {
  const { colors: c, styles: s } = useTheme()
  const [sharing, setSharing] = useState(false)
  const { id, host: hostId } = useLocalSearchParams<{
    id: string
    host: string
  }>()
  const {
    host,
    client,
    credential,
    error: connectionError,
  } = useConnection(hostId)
  const [tab, setTab] = useState<'files' | 'changes'>('changes')
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<Entry[]>([])
  const [status, setStatus] = useState<Status | null>(null)
  const [file, setFile] = useState<{ path: string; value: File } | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [opening, setOpening] = useState(false)
  const [revision, setRevision] = useState(0)
  const [previews] = useState(() => new FocusedRequests())
  const [transfers] = useState(() => new FocusedRequests())
  const root = `/api/sessions/${encodeURIComponent(id)}/workspace`
  const summary = summarizeWorkspaceStatus(status)
  useFocusEffect(
    useCallback(() => {
      if (!host?.id || !id) return
      previews.focus()
      transfers.focus()
      setOpening(false)
      setSharing(false)
      return () => {
        previews.blur()
        transfers.blur()
      }
    }, [previews, transfers, host?.id, id])
  )
  useFocusEffect(
    useCallback(() => {
      void revision
      const controller = new AbortController()
      setStatus(null)
      setEntries([])
      setError('')
      setLoading(Boolean(client))
      if (client) {
        Promise.all([
          client.get<{ state: string; entries: Entry[]; error?: string }>(
            `${root}/tree?path=${encodeURIComponent(path)}`,
            { signal: controller.signal }
          ),
          client.get<Status>(`${root}/status`, { signal: controller.signal }),
        ])
          .then(([tree, changes]) => {
            if (!controller.signal.aborted) {
              setEntries(tree.entries ?? [])
              setStatus(changes)
              if (tree.state !== 'ok') setError(tree.error ?? '目录无法读取')
            }
          })
          .catch((e) => {
            if (!controller.signal.aborted) setError(errorText(e))
          })
          .finally(() => {
            if (!controller.signal.aborted) setLoading(false)
          })
      }
      return () => controller.abort()
    }, [client, root, path, revision])
  )
  function showList() {
    previews.invalidate()
    transfers.invalidate()
    setSharing(false)
    setOpening(false)
    setFile(null)
  }
  function changePath(value: string) {
    showList()
    setPath(value)
  }
  async function open(target: string, diff: boolean) {
    if (!client) return
    const request = previews.begin()
    if (!request) return
    transfers.invalidate()
    setSharing(false)
    setOpening(true)
    setError('')
    try {
      let fileValue: File
      if (diff) {
        const value = await client.get<{
          state: string
          diff?: string
          error?: string
        }>(`${root}/diff?path=${encodeURIComponent(target)}`, {
          signal: request.signal,
        })
        fileValue = {
          state: value.state,
          content: value.diff || '没有可显示的文本差异',
          error: value.error,
        }
      } else
        fileValue = await client.get<File>(
          `${root}/file?path=${encodeURIComponent(target)}`,
          { signal: request.signal }
        )
      if (request.isCurrent()) setFile({ path: target, value: fileValue })
    } catch (e) {
      if (request.isCurrent()) setError(errorText(e))
    } finally {
      if (request.isCurrent()) setOpening(false)
    }
  }
  async function shareFile() {
    if (!host || !credential || !file || sharing) return
    const request = transfers.begin()
    if (!request) return
    setSharing(true)
    setError('')
    const timeout = setTimeout(() => {
      if (request.isCurrent()) {
        setError('文件下载超时，请重试')
        setSharing(false)
        transfers.invalidate()
      }
    }, 30000)
    try {
      if (Platform.OS === 'web')
        throw new Error('请在原生 App 中使用系统分享和存储文件')
      await shareFocusedWorkspaceFile(request, {
        download: (signal) =>
          downloadWorkspaceFile(
            host,
            credential,
            id,
            file.path,
            expoFetch as DownloadFetch,
            signal
          ),
        available: Sharing.isAvailableAsync,
        write(result) {
          const directory = new Directory(
            Paths.cache,
            'cc-haha-exports',
            randomUUID()
          )
          directory.create({ idempotent: true, intermediates: true })
          const target = new NativeFile(directory, result.name)
          target.write(result.bytes)
          return target.uri
        },
        share: (uri, result) => {
          clearTimeout(timeout)
          return Sharing.shareAsync(uri, {
            mimeType: result.mimeType,
            dialogTitle: '存储或分享文件',
          })
        },
      })
    } catch (e) {
      if (request.isCurrent()) setError(errorText(e))
    } finally {
      clearTimeout(timeout)
      if (request.isCurrent()) setSharing(false)
    }
  }
  return (
    <Screen
      title="文件"
      subtitle={`${host?.name ?? '电脑'} · ${status?.branch || '文件工作区'}`}
    >
      <Notice text={connectionError || error} error />
      {(loading || opening) && <Loading />}
      {file ? (
        <>
          <Button title="返回文件列表" secondary onPress={showList} />
          <Text selectable style={s.text}>
            {file.path}
          </Text>
          <Button
            title="存储或分享文件"
            busy={sharing}
            secondary
            onPress={() => void shareFile()}
          />
          {file.value.truncated && <Notice text="文件较大，仅显示部分内容。" />}
          {file.value.state !== 'ok' && (
            <Notice
              text={
                file.value.error || `此文件暂不支持预览 (${file.value.state})`
              }
            />
          )}
          {file.value.previewType === 'image' && file.value.dataUrl ? (
            <Image
              source={{ uri: file.value.dataUrl }}
              resizeMode="contain"
              style={{ width: '100%', height: 350 }}
            />
          ) : file.value.content !== undefined ? (
            <ScrollView
              horizontal
              style={{ backgroundColor: c.surface, borderRadius: 16 }}
              contentContainerStyle={{ padding: 16 }}
            >
              <Text
                selectable
                style={{
                  color: c.ink,
                  fontFamily: mono,
                  fontSize: 12,
                  lineHeight: 21,
                }}
              >
                {file.value.content}
              </Text>
            </ScrollView>
          ) : (
            <Empty
              title="请在电脑上打开"
              detail="当前 App 支持文本、图片和代码差异预览；此文件格式尚未接入。"
            />
          )}
        </>
      ) : (
        <>
          <View style={s.row}>
            <Button
              title="代码改动"
              secondary={tab !== 'changes'}
              onPress={() => {
                showList()
                setTab('changes')
              }}
            />
            <Button
              title="文件"
              secondary={tab !== 'files'}
              onPress={() => {
                showList()
                setTab('files')
              }}
            />
            <Button
              title="刷新"
              secondary
              onPress={() => {
                showList()
                setRevision((value) => value + 1)
              }}
            />
          </View>
          {tab === 'changes' ? (
            <>
              {!loading && (
                <>
                  {summary.kind === 'clean' && (
                    <Empty
                      title="工作区很干净"
                      detail="电脑上的文件改动会显示在这里。"
                    />
                  )}
                  {summary.kind === 'not_git_repo' && (
                    <Empty
                      title="普通文件夹"
                      detail="这个工作区没有 Git 仓库，可以切到文件查看内容。"
                    />
                  )}
                  {summary.kind === 'missing' && (
                    <Empty
                      title="工作目录不可用"
                      detail="请在电脑上恢复这段会话的工作目录后刷新。"
                    />
                  )}
                  {summary.kind === 'unavailable' && (
                    <Empty
                      title="尚未获取工作区状态"
                      detail="请确认电脑连接正常后刷新。"
                    />
                  )}
                  {summary.kind === 'error' && (
                    <Notice text={summary.message} error />
                  )}
                  {summary.kind === 'changes' &&
                    status?.changedFiles.map((entry) => (
                      <Row
                        key={entry.path}
                        title={entry.path}
                        detail={`${entry.status} · +${entry.additions} −${entry.deletions}`}
                        icon="git-commit"
                        onPress={() => open(entry.path, true)}
                      />
                    ))}
                </>
              )}
            </>
          ) : (
            <>
              <Text selectable style={s.small}>
                /{path}
              </Text>
              {path && (
                <Button
                  title="上一级"
                  secondary
                  onPress={() =>
                    changePath(path.split('/').slice(0, -1).join('/'))
                  }
                />
              )}
              {entries.map((entry) => (
                <Row
                  key={entry.path}
                  title={entry.name}
                  icon={entry.isDirectory ? 'folder' : 'file-text'}
                  onPress={() =>
                    entry.isDirectory
                      ? changePath(entry.path)
                      : open(entry.path, false)
                  }
                />
              ))}
            </>
          )}
        </>
      )}
    </Screen>
  )
}
