import { useCallback, useState, type ReactNode } from 'react'
import { Image, Platform, View } from 'react-native'
import { useFocusEffect, useLocalSearchParams } from 'expo-router'
import { fetch as expoFetch } from 'expo/fetch'
import { Directory, File as NativeFile, Paths } from 'expo-file-system'
import * as Sharing from 'expo-sharing'
import { randomUUID } from 'expo-crypto'
import { useConnection } from '../state/AppContext'
import { FocusedRequests } from '../core/focusedRequests'
import { useFocusedResource } from '../core/useFocusedResource'
import { shareFocusedWorkspaceFile } from '../core/workspaceShare'
import { downloadWorkspaceFile, type DownloadFetch } from '../core/workspaceDownload'
import {
  errorMessage,
  formatBytes,
  parentDir,
  previewFallback,
  splitPath,
} from '../core/changesView'
import {
  Callout,
  EmptyState,
  IconButton,
  InlineError,
  Loading,
  Mono,
  Spinner,
  useColors,
} from '../ui/kit'
import { ReaderScreen, SubtitleLine } from '../ui/results/parts'
import { CodeView } from '../ui/results/CodeView'
import { languageFor } from '../ui/results/highlight'

type WorkspaceFile = {
  state: string
  path?: string
  content?: string
  dataUrl?: string
  previewType?: string
  language?: string
  size?: number
  truncated?: boolean
  error?: string
}

/** 只读文件预览：文本带行号和轻量高亮，图片按比例显示，其他格式请到电脑上打开。 */
export default function FilePreview() {
  const { id, host, path } = useLocalSearchParams<{ id: string; host: string; path: string }>()
  return <FilePage key={`${host}:${id}:${path}`} hostId={host} id={id} path={path ?? ''} />
}

const SHARE_TIMEOUT_MS = 30000

function FilePage({ hostId, id, path }: { hostId: string; id: string; path: string }) {
  const colors = useColors()
  const { host, client, credential, error: connectionError } = useConnection(hostId)
  const root = `/api/sessions/${encodeURIComponent(id)}/workspace`
  const resource = useFocusedResource(
    useCallback(
      async (signal: AbortSignal) => {
        if (!client) return null
        return client.get<WorkspaceFile>(`${root}/file?path=${encodeURIComponent(path)}`, {
          signal,
        })
      },
      [client, root, path]
    )
  )
  const [transfers] = useState(() => new FocusedRequests())
  const [sharing, setSharing] = useState(false)
  const [shareError, setShareError] = useState('')
  useFocusEffect(
    useCallback(() => {
      transfers.focus()
      setSharing(false)
      return () => transfers.blur()
    }, [transfers])
  )

  async function shareFile() {
    if (!host || !credential || sharing) return
    const request = transfers.begin()
    if (!request) return
    setSharing(true)
    setShareError('')
    const timeout = setTimeout(() => {
      if (request.isCurrent()) {
        setShareError('文件下载超时，请重试')
        setSharing(false)
        transfers.invalidate()
      }
    }, SHARE_TIMEOUT_MS)
    try {
      if (Platform.OS === 'web') throw new Error('请在原生 App 中使用系统分享和存储文件')
      await shareFocusedWorkspaceFile(request, {
        download: (signal) =>
          downloadWorkspaceFile(host, credential, id, path, expoFetch as DownloadFetch, signal),
        available: Sharing.isAvailableAsync,
        write(result) {
          const directory = new Directory(Paths.cache, 'cc-haha-exports', randomUUID())
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
    } catch (error) {
      if (request.isCurrent()) setShareError(errorMessage(error))
    } finally {
      clearTimeout(timeout)
      if (request.isCurrent()) setSharing(false)
    }
  }

  const file = resource.value
  const { name } = splitPath(path)
  const dir = parentDir(path)
  const size = file?.state === 'ok' || (file?.size ?? 0) > 0 ? formatBytes(file?.size) : ''
  const error = connectionError || resource.error || shareError
  const fallback = file ? previewFallback(file) : null

  let body: ReactNode
  if (!file) body = error ? null : <Loading />
  else if (fallback)
    body = <EmptyState icon="file" title={fallback.title} detail={fallback.detail} />
  else if (file.previewType === 'image' && file.dataUrl)
    body = (
      <View style={{ flex: 1, padding: 16 }}>
        <Image
          accessibilityLabel={name}
          source={{ uri: file.dataUrl }}
          resizeMode="contain"
          style={{ flex: 1, width: '100%' }}
        />
      </View>
    )
  else body = <CodeView content={file.content ?? ''} language={languageFor(path, file.language)} />

  return (
    <ReaderScreen
      title={name || '文件'}
      subtitle={
        dir || size ? (
          <SubtitleLine>
            <Mono style={{ fontSize: 12, color: colors.ink3 }}>
              {[dir, size].filter(Boolean).join(' · ')}
            </Mono>
          </SubtitleLine>
        ) : undefined
      }
      right={
        sharing ? (
          <View style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Spinner size={18} color={colors.ink2} track={colors.fill} />
          </View>
        ) : (
          <IconButton
            icon="share"
            label="存储或分享文件"
            iconSize={20}
            color={colors.ink2}
            disabled={!host || !credential}
            onPress={() => void shareFile()}
          />
        )
      }
    >
      {error ? <InlineError text={error} style={{ margin: 16, marginBottom: file ? 0 : 16 }} /> : null}
      {file?.truncated ? (
        <Callout style={{ marginHorizontal: 16, marginTop: 12 }}>文件较大，只显示前面一部分。</Callout>
      ) : null}
      {body}
    </ReaderScreen>
  )
}
