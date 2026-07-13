import { randomUUID } from 'node:crypto'
import type { Session } from 'electron'

const PREVIEW_SESSION_PARTITION_PREFIX = 'cc-haha-preview-'

export function createPreviewSessionPartition(): string {
  return `${PREVIEW_SESSION_PARTITION_PREFIX}${randomUUID()}`
}

export type PreviewLocalAccess = {
  serverUrl: string
  token: string
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin
  } catch {
    return false
  }
}

export function configureLocalServerRequestAuth(
  webRequest: Pick<Session['webRequest'], 'onBeforeSendHeaders'>,
  resolveLocalAccess: () => PreviewLocalAccess | null,
): void {
  webRequest.onBeforeSendHeaders((details, callback) => {
    const localAccess = resolveLocalAccess()
    if (!localAccess || !sameOrigin(details.url, localAccess.serverUrl)) {
      callback({ requestHeaders: details.requestHeaders })
      return
    }

    callback({
      requestHeaders: {
        ...details.requestHeaders,
        Authorization: `Bearer ${localAccess.token}`,
      },
    })
  })
}

export function configurePreviewSessionPermissions(
  session: Pick<Session, 'setPermissionCheckHandler' | 'setPermissionRequestHandler'>,
): void {
  session.setPermissionCheckHandler(() => false)
  session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
}
