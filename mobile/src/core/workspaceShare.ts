import type { FocusedRequest } from './focusedRequests'

/** Leave no filesystem or system-sheet effects after the originating screen is left. */
export async function shareFocusedWorkspaceFile<T>(
  request: FocusedRequest,
  actions: {
    download(signal: AbortSignal): Promise<T>
    available(): Promise<boolean>
    write(value: T): string
    share(uri: string, value: T): Promise<void>
  }
) {
  const value = await actions.download(request.signal)
  if (!request.isCurrent()) return
  const available = await actions.available()
  if (!request.isCurrent()) return
  if (!available) throw new Error('此设备暂不支持系统分享')
  const uri = actions.write(value)
  await actions.share(uri, value)
}
