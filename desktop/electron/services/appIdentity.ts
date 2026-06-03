export type AppUserModelIdHost = {
  setAppUserModelId(id: string): void
}

// Must stay in sync with build.appId in desktop/package.json. Windows attributes
// toast notifications (and taskbar pinning) to this AppUserModelID; without an
// explicit call, notifications from a dev/unpackaged run can silently fail to show.
export const WINDOWS_APP_USER_MODEL_ID = 'com.claude-code-haha.desktop'

export function applyWindowsAppUserModelId(
  app: AppUserModelIdHost,
  platform: NodeJS.Platform = process.platform,
  appUserModelId: string = WINDOWS_APP_USER_MODEL_ID,
): boolean {
  if (platform !== 'win32') return false
  app.setAppUserModelId(appUserModelId)
  return true
}
