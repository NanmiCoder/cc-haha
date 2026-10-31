/**
 * index.html swaps in an in-memory storage when the browser denies web
 * storage. This runs that inline script verbatim against fake windows: it must
 * leave every browser whose storage can be read exactly as it was.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isLocalStoragePersistent } from './browserStorage'

const html = readFileSync(join(__dirname, '..', '..', 'index.html'), 'utf-8')

function extractStorageFallback(): string {
  const markerIndex = html.indexOf('Browsers that deny web storage outright')
  expect(markerIndex, 'index.html lost its storage fallback').toBeGreaterThan(0)
  const bodyStart = html.lastIndexOf('<script>', markerIndex) + '<script>'.length
  return html.slice(bodyStart, html.indexOf('</script>', bodyStart))
}

const script = extractStorageFallback()

function realStorage(initial: Record<string, string> = {}, { failWrites = false } = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failWrites) throw new DOMException('quota', 'QuotaExceededError')
      data.set(key, value)
    },
    removeItem: (key: string) => { data.delete(key) },
  }
}

function denied(): never {
  throw new DOMException('The operation is insecure.', 'SecurityError')
}

type FakeWindow = Record<string, unknown> & { __CC_HAHA_MEMORY_STORAGE__?: string[] }

function windowWith(local: () => unknown, session: () => unknown): FakeWindow {
  const win: FakeWindow = {}
  Object.defineProperty(win, 'localStorage', { configurable: true, get: local })
  Object.defineProperty(win, 'sessionStorage', { configurable: true, get: session })
  return win
}

function run(win: FakeWindow) {
  // eslint-disable-next-line no-new-func -- running the shipped script verbatim is the point
  new Function('window', script)(win)
  return win
}

describe('index.html storage fallback', () => {
  it('leaves readable storage untouched, including Electron and every normal browser', () => {
    const local = realStorage({ 'cc-haha-theme': 'dark' })
    const session = realStorage()
    const win = run(windowWith(() => local, () => session))
    expect(win.localStorage).toBe(local)
    expect(win.sessionStorage).toBe(session)
    expect(win.__CC_HAHA_MEMORY_STORAGE__).toBeUndefined()
    expect(isLocalStoragePersistent(win)).toBe(true)
  })

  it('keeps storage that reads but cannot be written, so what is already saved stays visible', () => {
    const local = realStorage({ 'cc-haha-h5-token': 'h5_saved' }, { failWrites: true })
    const win = run(windowWith(() => local, () => realStorage()))
    expect(win.localStorage).toBe(local)
    expect(isLocalStoragePersistent(win)).toBe(true)
  })

  it('swaps a denied storage for a working in-memory one and says so', () => {
    const win = run(windowWith(denied, denied))
    expect(win.__CC_HAHA_MEMORY_STORAGE__).toEqual(['localStorage', 'sessionStorage'])
    expect(isLocalStoragePersistent(win)).toBe(false)

    const local = win.localStorage as Storage
    expect(local.getItem('missing')).toBeNull()
    local.setItem('count', 3 as unknown as string)
    local.setItem('name', 'cc')
    expect(local.getItem('count')).toBe('3')
    expect(local.length).toBe(2)
    expect([local.key(0), local.key(1), local.key(2)]).toEqual(['count', 'name', null])
    local.removeItem('count')
    expect(local.length).toBe(1)
    local.clear()
    expect(local.getItem('name')).toBeNull()
    // Each storage is its own.
    ;(win.sessionStorage as Storage).setItem('only-session', '1')
    expect(local.getItem('only-session')).toBeNull()
  })

  it('also swaps a storage object whose reads throw', () => {
    const win = run(windowWith(() => ({ getItem: denied }), () => realStorage()))
    expect(win.__CC_HAHA_MEMORY_STORAGE__).toEqual(['localStorage'])
    expect((win.localStorage as Storage).getItem('x')).toBeNull()
  })
})
