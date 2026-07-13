import type { Session } from 'electron'

export const PREVIEW_SESSION_PARTITION = 'cc-haha-preview'

export function configurePreviewSessionPermissions(
  session: Pick<Session, 'setPermissionCheckHandler' | 'setPermissionRequestHandler'>,
): void {
  session.setPermissionCheckHandler(() => false)
  session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
}
