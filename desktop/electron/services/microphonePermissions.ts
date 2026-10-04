import { pathToFileURL } from 'node:url'
import type { Session, WebContents } from 'electron'

type PermissionSession = Pick<Session, 'setPermissionCheckHandler' | 'setPermissionRequestHandler'>

export type MediaAccessStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'

export type MicrophoneSystemPreferences = {
  getMediaAccessStatus(mediaType: 'microphone'): MediaAccessStatus
  askForMediaAccess(mediaType: 'microphone'): Promise<boolean>
}

export type MicrophonePermissionOptions = {
  /**
   * True for contents that live in a window this application created and that
   * is still open. Deliberately not "is the main window": the policy belongs
   * to every application window, not to one specific window.
   */
  isAppContents: (contents: WebContents) => boolean
  /** True only for a frame URL that is the application's own renderer entry. */
  isAppUrl: (url: string) => boolean
  systemPreferences: MicrophoneSystemPreferences
  platform?: NodeJS.Platform
}

/**
 * Match the application's own renderer document: the dev server origin, or the
 * packaged `dist/index.html`. Query and hash are ignored because every
 * application window loads the same entry with its own query string.
 */
export function createRendererUrlMatcher(
  entry: string,
  platform: NodeJS.Platform = process.platform,
): (url: string) => boolean {
  if (/^https?:\/\//.test(entry)) {
    const origin = new URL(entry).origin
    return url => {
      try {
        return new URL(url).origin === origin
      } catch {
        return false
      }
    }
  }
  // Compare decoded paths (Chromium and pathToFileURL may encode differently)
  // and, on Windows, case-insensitively, so drive-letter case cannot lock
  // dictation out of an otherwise identical entry.
  const normalize = (pathname: string) => {
    let decoded = pathname
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      // Keep the raw path; it just will not match.
    }
    return platform === 'win32' ? decoded.toLowerCase() : decoded
  }
  const entryPath = normalize(pathToFileURL(entry).pathname)
  return url => {
    try {
      const parsed = new URL(url)
      return parsed.protocol === 'file:' && normalize(parsed.pathname) === entryPath
    } catch {
      return false
    }
  }
}

/**
 * Grant audio-only capture to the main frame of application windows and leave every
 * other permission at Electron's default. Installing any handler replaces that
 * default, so the non-media branches explicitly keep the previous "granted"
 * behaviour instead of silently tightening notifications, clipboard and so on.
 */
export function installMicrophonePermissions(
  session: PermissionSession,
  options: MicrophonePermissionOptions,
): void {
  const platform = options.platform ?? process.platform
  const prefs = options.systemPreferences

  const fromApplication = (
    contents: WebContents | null,
    isMainFrame: boolean,
    url: string | undefined,
  ) => {
    if (!contents || !isMainFrame || !url) return false
    return options.isAppContents(contents) && options.isAppUrl(url)
  }

  session.setPermissionCheckHandler((contents, permission, _origin, details) => {
    if (permission !== 'media') return true
    return fromApplication(contents, details.isMainFrame, details.requestingUrl)
      && details.mediaType === 'audio'
      && (platform !== 'darwin' || prefs.getMediaAccessStatus('microphone') === 'granted')
  })

  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission !== 'media') {
      callback(true)
      return
    }
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined
    const audioOnly = mediaTypes?.length === 1 && mediaTypes[0] === 'audio'
    if (!audioOnly || !fromApplication(contents, details.isMainFrame, details.requestingUrl)) {
      callback(false)
      return
    }
    if (platform !== 'darwin') {
      callback(true)
      return
    }
    const status = prefs.getMediaAccessStatus('microphone')
    if (status === 'granted') {
      callback(true)
    } else if (status === 'not-determined') {
      prefs.askForMediaAccess('microphone').then(callback, () => callback(false))
    } else {
      callback(false)
    }
  })
}
