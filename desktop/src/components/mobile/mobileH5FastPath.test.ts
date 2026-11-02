/**
 * index.html sends a returning phone straight to the phone app before the
 * desktop bundles load. This runs that inline script verbatim against a fake
 * window, so it stays in step with the H5 token the app stores and with the
 * layouts that use the phone app.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { H5_SERVER_URL_STORAGE_KEY, H5_TOKEN_STORAGE_KEY } from '../../lib/desktopRuntime'
import { MOBILE_H5_PATH } from './mobileH5Handoff'

const html = readFileSync(join(__dirname, '..', '..', '..', 'index.html'), 'utf-8')

function extractFastPath(): string {
  const markerIndex = html.indexOf('Returning phones go straight to the phone app')
  expect(markerIndex, 'index.html lost its phone fast path').toBeGreaterThan(0)
  const bodyStart = html.lastIndexOf('<script>', markerIndex) + '<script>'.length
  return html.slice(bodyStart, html.indexOf('</script>', bodyStart))
}

const script = extractFastPath()
const ORIGIN = 'http://192.168.1.8:3456'

type Setup = {
  path?: string
  search?: string
  width?: number
  coarse?: boolean
  touchPoints?: number
  stored?: Record<string, string>
  session?: Record<string, string>
  desktopHost?: boolean
  now?: number
}

function run(setup: Setup = {}) {
  const local = new Map(Object.entries(setup.stored ?? {
    [H5_SERVER_URL_STORAGE_KEY]: ORIGIN,
    [H5_TOKEN_STORAGE_KEY]: 'h5_verified_token',
  }))
  const session = new Map(Object.entries(setup.session ?? {}))
  const replaced: string[] = []
  const width = setup.width ?? 390
  const fakeWindow = {
    desktopHost: setup.desktopHost ? {} : undefined,
    location: {
      origin: ORIGIN,
      pathname: setup.path ?? '/',
      search: setup.search ?? '',
      hash: '',
      replace: (url: string) => replaced.push(url),
    },
    matchMedia: (query: string) => ({
      matches: query.includes('max-width')
        ? width <= Number(/max-width: (\d+)px/.exec(query)![1])
        : query.includes('pointer: coarse') && (setup.coarse ?? width < 768),
    }),
    localStorage: { getItem: (key: string) => local.get(key) ?? null },
    sessionStorage: {
      getItem: (key: string) => session.get(key) ?? null,
      setItem: (key: string, value: string) => session.set(key, value),
    },
  }
  const realNow = Date.now
  Date.now = () => setup.now ?? 1_000_000
  try {
    // eslint-disable-next-line no-new-func -- running the shipped script verbatim is the point
    new Function('window', 'navigator', script)(fakeWindow, { maxTouchPoints: setup.touchPoints ?? 0 })
  } finally {
    Date.now = realNow
  }
  return { replaced, session }
}

describe('index.html phone fast path', () => {
  it('sends a phone that already holds this server\'s verified token straight to the phone app', () => {
    const { replaced } = run()
    expect(replaced).toEqual([MOBILE_H5_PATH])
  })

  it('also sends a tablet, whose primary pointer is touch', () => {
    expect(run({ width: 1024, coarse: true, touchPoints: 5 }).replaced).toEqual([MOBILE_H5_PATH])
  })

  it('keeps a touch-screen laptop, whose primary pointer is a mouse or trackpad, on the desktop app', () => {
    expect(run({ width: 1920, coarse: false, touchPoints: 10 }).replaced).toEqual([])
  })

  it('leaves everything that needs the full entry to the app', () => {
    // A desktop browser keeps the desktop app.
    expect(run({ width: 1440, coarse: false }).replaced).toEqual([])
    // The Electron window.
    expect(run({ desktopHost: true }).replaced).toEqual([])
    // A scanned QR carries a token to verify; a reconnect asks for the token page.
    expect(run({ search: '?serverUrl=x&h5Token=y' }).replaced).toEqual([])
    expect(run({ search: '?reconnect=1' }).replaced).toEqual([])
    // Remote browsers pair through /remote with a cookie the page cannot read.
    expect(run({ path: '/remote' }).replaced).toEqual([])
    // No token yet, or a token paired with another server.
    expect(run({ stored: {} }).replaced).toEqual([])
    expect(run({
      stored: { [H5_SERVER_URL_STORAGE_KEY]: 'http://192.168.1.9:3456', [H5_TOKEN_STORAGE_KEY]: 't' },
    }).replaced).toEqual([])
  })

  it('does not bounce when /m/ could not take the page and sent it straight back', () => {
    const first = run({ now: 1_000_000 })
    expect(first.replaced).toEqual([MOBILE_H5_PATH])
    const session = Object.fromEntries(first.session)
    expect(run({ session, now: 1_005_000 }).replaced).toEqual([])
    // A later visit is a new decision.
    expect(run({ session, now: 1_060_000 }).replaced).toEqual([MOBILE_H5_PATH])
  })
})
