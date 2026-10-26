import { connectionHeaders } from './connection'
import type { Host } from './types'

export type DownloadFetch = (
  url: string,
  init: RequestInit
) => Promise<
  Pick<Response, 'ok' | 'status' | 'url' | 'redirected' | 'body'> & {
    headers: { get(name: string): string | null }
  }
>
const maxBytes = 20 * 1024 * 1024
export async function downloadWorkspaceFile(
  host: Host,
  credential: string,
  sessionId: string,
  path: string,
  adapter: DownloadFetch,
  signal?: AbortSignal
) {
  const url = new URL(
    `/api/sessions/${encodeURIComponent(sessionId)}/workspace/download?path=${encodeURIComponent(path)}`,
    host.url
  )
  const response = await adapter(url.toString(), {
    headers: connectionHeaders(host, credential),
    redirect: 'error',
    credentials: 'omit',
    signal,
  })
  if (
    response.redirected ||
    (response.url &&
      new URL(response.url).origin !== new URL(host.url).origin) ||
    (response.status >= 300 && response.status < 400)
  )
    throw new Error('文件下载重定向已拒绝')
  if (!response.ok) throw new Error(`文件无法下载 (${response.status})`)
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel()
    throw new Error('文件超过 20 MB，请在电脑上处理')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('文件下载内容不可用')
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new Error('文件超过 20 MB，请在电脑上处理')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return {
    bytes,
    mimeType:
      response.headers.get('content-type')?.split(';')[0] ||
      'application/octet-stream',
    name: exportFileName(path),
  }
}
export function exportFileName(path: string) {
  const name = path
    .split(/[\\/]/)
    .pop()
    ?.replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .slice(0, 160)
  return name && name !== '.' && name !== '..' ? name : 'cc-haha-file'
}
