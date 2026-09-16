import { beforeEach, describe, expect, test } from 'bun:test'
import path from 'node:path'
import {
  DEFAULT_ICON_SIZE,
  MAX_ICON_SIZE,
  MIN_ICON_SIZE,
  __resetMacAppIconCacheForTests,
  normalizeIconFileName,
  normalizeIconSize,
  readAppIconPng,
  resolveAppIconPath,
} from './macAppIcon.js'

const APP = path.join('/Applications', 'Example.app')
const RESOURCES = path.join(APP, 'Contents', 'Resources')

/**
 * Builds deps over a virtual bundle. Nothing here touches the filesystem or
 * spawns `plutil`/`sips`, so the resolution ORDER is what these tests pin — the
 * part that decides whether a row shows the app's mark or a document badge.
 */
function bundle(options: {
  declaredIcon?: string | null
  resourceFiles?: string[]
  /** Files that "exist"; defaults to every entry in resourceFiles. */
  present?: string[]
  convert?: (iconPath: string, size: number) => Promise<Uint8Array>
}) {
  const resourceFiles = options.resourceFiles ?? []
  const present = new Set(
    (options.present ?? resourceFiles).map(name => path.join(RESOURCES, name)),
  )
  const converted: Array<{ iconPath: string; size: number }> = []

  return {
    converted,
    deps: {
      readIconFileName: async () => options.declaredIcon ?? null,
      listResourceFiles: async () => resourceFiles,
      pathExists: async (candidate: string) => present.has(candidate),
      convertToPng: options.convert
        ?? (async (iconPath: string, size: number) => {
          converted.push({ iconPath, size })
          return new Uint8Array([1, 2, 3])
        }),
    },
  }
}

beforeEach(() => {
  __resetMacAppIconCacheForTests()
})

describe('normalizeIconFileName', () => {
  test('appends .icns only when CFBundleIconFile omits an extension', () => {
    // Both spellings ship in real bundles.
    expect(normalizeIconFileName('AppIcon')).toBe('AppIcon.icns')
    expect(normalizeIconFileName('AppIcon.icns')).toBe('AppIcon.icns')
    expect(normalizeIconFileName('  AppIcon  ')).toBe('AppIcon.icns')
    expect(normalizeIconFileName('')).toBe('')
  })
})

describe('normalizeIconSize', () => {
  test('clamps to the renderable range and survives junk', () => {
    expect(normalizeIconSize(72)).toBe(72)
    expect(normalizeIconSize('72')).toBe(72)
    expect(normalizeIconSize(4)).toBe(MIN_ICON_SIZE)
    expect(normalizeIconSize(4096)).toBe(MAX_ICON_SIZE)
    expect(normalizeIconSize('not a number')).toBe(DEFAULT_ICON_SIZE)
    expect(normalizeIconSize(64.4)).toBe(64)
  })

  test('treats an absent size as the default, not the minimum', () => {
    // `searchParams.get('size')` is null when omitted, and Number(null) is 0 —
    // clamping that would serve a 16px icon to every caller that omits it.
    expect(normalizeIconSize(null)).toBe(DEFAULT_ICON_SIZE)
    expect(normalizeIconSize(undefined)).toBe(DEFAULT_ICON_SIZE)
    expect(normalizeIconSize('')).toBe(DEFAULT_ICON_SIZE)
  })
})

describe('resolveAppIconPath', () => {
  test('prefers the icon the bundle declares', async () => {
    const { deps } = bundle({
      declaredIcon: 'AppIcon',
      resourceFiles: ['AppIcon.icns', 'Other.icns'],
    })

    expect(await resolveAppIconPath(APP, deps)).toBe(path.join(RESOURCES, 'AppIcon.icns'))
  })

  test('falls back to the sole .icns when the declared file is missing', async () => {
    // Seen in the wild: Info.plist names an icon that was renamed or dropped.
    const { deps } = bundle({
      declaredIcon: 'Stale',
      resourceFiles: ['Real.icns'],
      present: ['Real.icns'],
    })

    expect(await resolveAppIconPath(APP, deps)).toBe(path.join(RESOURCES, 'Real.icns'))
  })

  test('skips document icons when guessing', async () => {
    // Picking these would put a file badge where the app's own mark belongs.
    const { deps } = bundle({
      declaredIcon: null,
      resourceFiles: ['ProjectDocument.icns', 'document.icns', 'Brand.icns'],
    })

    expect(await resolveAppIconPath(APP, deps)).toBe(path.join(RESOURCES, 'Brand.icns'))
  })

  test('ignores non-icns resources', async () => {
    const { deps } = bundle({
      declaredIcon: null,
      resourceFiles: ['background.png', 'strings.plist', 'Brand.ICNS'],
    })

    expect(await resolveAppIconPath(APP, deps)).toBe(path.join(RESOURCES, 'Brand.ICNS'))
  })

  test('returns null when the bundle ships no icon at all', async () => {
    const { deps } = bundle({ declaredIcon: null, resourceFiles: ['strings.plist'] })

    expect(await resolveAppIconPath(APP, deps)).toBeNull()
  })

  test('returns null when only document icons exist', async () => {
    const { deps } = bundle({
      declaredIcon: null,
      resourceFiles: ['MyDocument.icns'],
    })

    expect(await resolveAppIconPath(APP, deps)).toBeNull()
  })
})

describe('readAppIconPng', () => {
  test('rasterises at the normalized size', async () => {
    const { deps, converted } = bundle({
      declaredIcon: 'AppIcon',
      resourceFiles: ['AppIcon.icns'],
    })

    const png = await readAppIconPng(APP, 9999, deps)

    expect(png).toEqual(new Uint8Array([1, 2, 3]))
    expect(converted).toEqual([
      { iconPath: path.join(RESOURCES, 'AppIcon.icns'), size: MAX_ICON_SIZE },
    ])
  })

  test('converts once per (bundle, size) and serves the rest from cache', async () => {
    // The picker asks for one icon per visible row while scrolling; each miss
    // is a subprocess.
    const { deps, converted } = bundle({
      declaredIcon: 'AppIcon',
      resourceFiles: ['AppIcon.icns'],
    })

    await readAppIconPng(APP, 72, deps)
    await readAppIconPng(APP, 72, deps)
    expect(converted).toHaveLength(1)

    // A different size is a different rendering, so it must not reuse bytes.
    await readAppIconPng(APP, 128, deps)
    expect(converted.map(c => c.size)).toEqual([72, 128])
  })

  test('returns null instead of throwing when rasterisation fails', async () => {
    const { deps } = bundle({
      declaredIcon: 'AppIcon',
      resourceFiles: ['AppIcon.icns'],
      convert: async () => {
        throw new Error('sips: unsupported file format')
      },
    })

    // A corrupt .icns must degrade to the letter tile, not break the page.
    expect(await readAppIconPng(APP, 72, deps)).toBeNull()
  })

  test('does not cache a failure, so a later read can still succeed', async () => {
    let attempt = 0
    const { deps } = bundle({
      declaredIcon: 'AppIcon',
      resourceFiles: ['AppIcon.icns'],
      convert: async () => {
        attempt += 1
        if (attempt === 1) throw new Error('transient')
        return new Uint8Array([9])
      },
    })

    expect(await readAppIconPng(APP, 72, deps)).toBeNull()
    expect(await readAppIconPng(APP, 72, deps)).toEqual(new Uint8Array([9]))
  })

  test('returns null without converting when there is no icon', async () => {
    const { deps, converted } = bundle({ declaredIcon: null, resourceFiles: [] })

    expect(await readAppIconPng(APP, 72, deps)).toBeNull()
    expect(converted).toHaveLength(0)
  })
})
