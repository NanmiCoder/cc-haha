import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  createRendererUrlMatcher,
  installMicrophonePermissions,
  type MediaAccessStatus,
} from './microphonePermissions'

const APP_ENTRY = '/Applications/Claude Code Haha.app/Contents/Resources/app.asar/dist/index.html'
const APP_URL = pathToFileURL(APP_ENTRY).toString()

type CheckHandler = (
  contents: WebContents | null,
  permission: string,
  origin: string,
  details: Record<string, unknown>,
) => boolean
type RequestHandler = (
  contents: WebContents,
  permission: string,
  callback: (granted: boolean) => void,
  details: Record<string, unknown>,
) => void

function setup(options: {
  platform?: NodeJS.Platform
  status?: MediaAccessStatus
  ask?: () => Promise<boolean>
  entry?: string
} = {}) {
  const primary = { id: 1 } as unknown as WebContents
  const secondary = { id: 3 } as unknown as WebContents
  const other = { id: 2 } as unknown as WebContents
  const appContents = new Set<WebContents>([primary, secondary])
  let check!: CheckHandler
  let request!: RequestHandler
  const session = {
    setPermissionCheckHandler: vi.fn((handler: CheckHandler) => { check = handler }),
    setPermissionRequestHandler: vi.fn((handler: RequestHandler) => { request = handler }),
  }
  const systemPreferences = {
    getMediaAccessStatus: vi.fn(() => options.status ?? 'granted'),
    askForMediaAccess: vi.fn(options.ask ?? (async () => true)),
  }
  installMicrophonePermissions(session as never, {
    isAppContents: contents => appContents.has(contents),
    isAppUrl: createRendererUrlMatcher(options.entry ?? APP_ENTRY),
    systemPreferences,
    platform: options.platform ?? 'darwin',
  })
  const ask = (
    contents: WebContents,
    details: Record<string, unknown>,
    permission = 'media',
  ) => new Promise<boolean>(resolve => {
    request(contents, permission, resolve, {
      isMainFrame: true,
      requestingUrl: APP_URL,
      mediaTypes: ['audio'],
      ...details,
    })
  })
  const probe = (
    contents: WebContents | null,
    details: Record<string, unknown> = {},
    permission = 'media',
  ) => check(contents, permission, 'file:///', {
    isMainFrame: true,
    requestingUrl: APP_URL,
    mediaType: 'audio',
    ...details,
  })
  return {
    primary,
    secondary,
    other,
    systemPreferences,
    ask,
    probe,
    closeWindow: (contents: WebContents) => { appContents.delete(contents) },
  }
}

describe('installMicrophonePermissions request handler', () => {
  it('grants audio-only capture from the primary window main frame', async () => {
    const { primary, ask } = setup({ platform: 'linux' })
    await expect(ask(primary, {})).resolves.toBe(true)
  })

  it('grants audio-only capture to a secondary application window, whatever its query string', async () => {
    const { secondary, ask } = setup({ platform: 'linux' })
    await expect(ask(secondary, { requestingUrl: `${APP_URL}?petWindow=1&sessionId=abc` })).resolves.toBe(true)
  })

  it('denies audio requests from contents that are not an application window', async () => {
    const { other, ask, systemPreferences } = setup()
    await expect(ask(other, {})).resolves.toBe(false)
    expect(systemPreferences.askForMediaAccess).not.toHaveBeenCalled()
  })

  it('denies once the application window is gone', async () => {
    const { primary, secondary, ask, closeWindow } = setup({ platform: 'win32' })
    closeWindow(primary)
    closeWindow(secondary)
    await expect(ask(primary, {})).resolves.toBe(false)
    await expect(ask(secondary, {})).resolves.toBe(false)
  })

  it('still denies subframes and video from a secondary application window', async () => {
    const { secondary, ask } = setup({ platform: 'win32' })
    await expect(ask(secondary, { isMainFrame: false })).resolves.toBe(false)
    await expect(ask(secondary, { mediaTypes: ['audio', 'video'] })).resolves.toBe(false)
    await expect(ask(secondary, { requestingUrl: 'https://example.com/' })).resolves.toBe(false)
  })

  it('denies subframes and foreign or missing frame URLs', async () => {
    const { primary, ask } = setup({ platform: 'win32' })
    await expect(ask(primary, { isMainFrame: false })).resolves.toBe(false)
    await expect(ask(primary, { requestingUrl: 'https://example.com/' })).resolves.toBe(false)
    await expect(ask(primary, { requestingUrl: 'file:///tmp/other.html' })).resolves.toBe(false)
    await expect(ask(primary, { requestingUrl: undefined })).resolves.toBe(false)
  })

  it('denies video, audio plus video, and requests without media types', async () => {
    const { primary, ask } = setup({ platform: 'win32' })
    await expect(ask(primary, { mediaTypes: ['video'] })).resolves.toBe(false)
    await expect(ask(primary, { mediaTypes: ['audio', 'video'] })).resolves.toBe(false)
    await expect(ask(primary, { mediaTypes: [] })).resolves.toBe(false)
    await expect(ask(primary, { mediaTypes: undefined })).resolves.toBe(false)
  })

  it('leaves every other permission granted as Electron does by default', async () => {
    const { primary, other, ask } = setup()
    for (const permission of ['notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'openExternal', 'geolocation']) {
      await expect(ask(primary, {}, permission)).resolves.toBe(true)
      await expect(ask(other, { isMainFrame: false, requestingUrl: 'https://example.com/' }, permission)).resolves.toBe(true)
    }
  })
})

describe('installMicrophonePermissions on macOS', () => {
  it('allows without prompting when the system already granted access', async () => {
    const { primary, ask, systemPreferences } = setup({ status: 'granted' })
    await expect(ask(primary, {})).resolves.toBe(true)
    expect(systemPreferences.askForMediaAccess).not.toHaveBeenCalled()
  })

  it('asks the system when access is undetermined and follows the answer', async () => {
    const granted = setup({ status: 'not-determined', ask: async () => true })
    await expect(granted.ask(granted.primary, {})).resolves.toBe(true)
    expect(granted.systemPreferences.askForMediaAccess).toHaveBeenCalledWith('microphone')

    const refused = setup({ status: 'not-determined', ask: async () => false })
    await expect(refused.ask(refused.primary, {})).resolves.toBe(false)
  })

  it('denies when the system prompt itself fails', async () => {
    const { primary, ask } = setup({ status: 'not-determined', ask: async () => { throw new Error('boom') } })
    await expect(ask(primary, {})).resolves.toBe(false)
  })

  it.each(['denied', 'restricted', 'unknown'] as const)('denies without prompting when the status is %s', async status => {
    const { primary, ask, systemPreferences } = setup({ status })
    await expect(ask(primary, {})).resolves.toBe(false)
    expect(systemPreferences.askForMediaAccess).not.toHaveBeenCalled()
  })

  it('does not consult the system for non-media permissions', async () => {
    const { primary, ask, systemPreferences } = setup({ status: 'denied' })
    await expect(ask(primary, {}, 'notifications')).resolves.toBe(true)
    expect(systemPreferences.getMediaAccessStatus).not.toHaveBeenCalled()
  })
})

describe('installMicrophonePermissions check handler', () => {
  it('reports audio as permitted for the primary main frame', () => {
    const { primary, probe } = setup({ platform: 'win32' })
    expect(probe(primary)).toBe(true)
  })

  it('requires the system grant on macOS and never prompts from a check', () => {
    const granted = setup({ status: 'granted' })
    expect(granted.probe(granted.primary)).toBe(true)

    for (const status of ['not-determined', 'denied', 'restricted'] as const) {
      const denied = setup({ status })
      expect(denied.probe(denied.primary)).toBe(false)
      expect(denied.systemPreferences.askForMediaAccess).not.toHaveBeenCalled()
    }
  })

  it('reports audio as permitted for a secondary application window but not for non-application contents', () => {
    const { secondary, other, probe } = setup({ platform: 'win32' })
    expect(probe(secondary, { requestingUrl: `${APP_URL}?petWindow=1` })).toBe(true)
    expect(probe(other)).toBe(false)
  })

  it('denies other windows, null contents, subframes, foreign URLs and non-audio media', () => {
    const { primary, other, probe } = setup({ platform: 'win32' })
    expect(probe(other)).toBe(false)
    expect(probe(null)).toBe(false)
    expect(probe(primary, { isMainFrame: false })).toBe(false)
    expect(probe(primary, { requestingUrl: 'https://example.com/' })).toBe(false)
    expect(probe(primary, { requestingUrl: undefined })).toBe(false)
    expect(probe(primary, { mediaType: 'video' })).toBe(false)
    expect(probe(primary, { mediaType: 'unknown' })).toBe(false)
    expect(probe(primary, { mediaType: undefined })).toBe(false)
  })

  it('keeps every other permission granted', () => {
    const { other, probe } = setup({ status: 'denied' })
    for (const permission of ['notifications', 'clipboard-read', 'fullscreen', 'openExternal']) {
      expect(probe(other, { isMainFrame: false }, permission)).toBe(true)
    }
  })
})

describe('createRendererUrlMatcher', () => {
  it('matches the packaged index.html regardless of query and hash', () => {
    const matches = createRendererUrlMatcher(APP_ENTRY)
    expect(matches(APP_URL)).toBe(true)
    expect(matches(`${APP_URL}?petWindow=1#/chat`)).toBe(true)
    expect(matches(pathToFileURL('/Applications/Other.app/dist/index.html').toString())).toBe(false)
    expect(matches('https://example.com/dist/index.html')).toBe(false)
    expect(matches('not a url')).toBe(false)
  })

  it('matches only the dev server origin for an http entry', () => {
    const matches = createRendererUrlMatcher('http://127.0.0.1:5173')
    expect(matches('http://127.0.0.1:5173/?petWindow=1')).toBe(true)
    expect(matches('http://127.0.0.1:5174/')).toBe(false)
    expect(matches('http://localhost:5173/')).toBe(false)
    expect(matches('file:///index.html')).toBe(false)
  })

  it('tolerates percent-encoding differences, and drive-letter case only on Windows', () => {
    const entry = '/Applications/My App/dist/index.html'
    const encoded = 'file:///Applications/My%20App/dist/index.html'
    const differentCase = 'file:///applications/my%20app/dist/index.html'
    expect(createRendererUrlMatcher(entry, 'darwin')(encoded)).toBe(true)
    expect(createRendererUrlMatcher(entry, 'darwin')(differentCase)).toBe(false)
    expect(createRendererUrlMatcher(entry, 'win32')(differentCase)).toBe(true)
  })
})

describe('main window wiring', () => {
  const desktopRoot = existsSync(path.resolve(process.cwd(), 'electron', 'main.ts'))
    ? process.cwd()
    : path.resolve(process.cwd(), 'desktop')
  const mainSource = readFileSync(path.join(desktopRoot, 'electron', 'main.ts'), 'utf8')
  const mainWindowSource = mainSource.slice(
    mainSource.indexOf('async function createMainWindow()'),
    mainSource.indexOf('if (!acquireSingleInstanceLock'),
  )

  it('installs the microphone policy once, on the shared app session, for any application window', () => {
    expect(mainWindowSource).toContain('installMicrophonePermissions(mainWindow.webContents.session')
    expect(mainSource.match(/installMicrophonePermissions\(/g)).toHaveLength(1)
    // The policy covers every application window, so the gate cannot be "is mainWindow".
    expect(mainWindowSource).toContain('BrowserWindow.fromWebContents(contents)')
    expect(mainWindowSource).not.toMatch(/primary:/)
  })

  it('ships the macOS entitlement and usage description', () => {
    for (const file of ['entitlements.mac.plist', 'entitlements.mac.inherit.plist']) {
      const plist = readFileSync(path.join(desktopRoot, 'build', file), 'utf8')
      expect(plist).toMatch(/<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/)
    }
    const pkg = JSON.parse(readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'))
    expect(pkg.build.mac.extendInfo.NSMicrophoneUsageDescription).toMatch(/麦克风/)
    expect(pkg.build.mac.extendInfo.NSMicrophoneUsageDescription).toMatch(/[Mm]icrophone/)
  })
})
