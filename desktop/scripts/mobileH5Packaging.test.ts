// @vitest-environment node
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// electron-builder's own matcher, so the test follows its real rule order.
import { getMainFileMatchers } from 'app-builder-lib/out/fileMatcher'

const desktopRoot = path.resolve(__dirname, '..')
const manifest = JSON.parse(readFileSync(path.join(desktopRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
  build: Record<string, unknown>
}

function packagedFilter() {
  const platformPackager = {
    info: {
      projectDir: desktopRoot,
      buildResourcesDir: 'build',
      isPrepackedAppAsar: false,
      config: manifest.build,
      debugLogger: { isEnabled: false },
    },
  }
  const matchers = getMainFileMatchers(
    desktopRoot,
    '/packaged/app',
    (pattern: string) => pattern,
    {},
    platformPackager as never,
    path.join(desktopRoot, 'build-artifacts', 'electron'),
    false,
  )
  const filter = matchers[0]!.createFilter()
  const file = { isDirectory: () => false } as never
  const directory = { isDirectory: () => true } as never
  /** A file ships only if it and every directory above it pass, as the copier walks them. */
  return (relative: string) => {
    const parts = relative.split('/')
    for (let depth = 1; depth < parts.length; depth++) {
      if (!filter(path.join(desktopRoot, ...parts.slice(0, depth)), directory)) return false
    }
    return filter(path.join(desktopRoot, ...parts), file)
  }
}

describe('phone H5 packaging', () => {
  it('builds the phone app into dist/m after Vite has emptied dist', () => {
    const build = manifest.scripts.build!
    expect(build.indexOf('vite.js build')).toBeGreaterThan(-1)
    expect(build.indexOf('build:h5-mobile')).toBeGreaterThan(build.indexOf('vite.js build'))
    expect(manifest.scripts['build:h5-mobile']).toContain('./dist/m')
  })

  it('ships every exported file, including Expo assets that live under a node_modules path', () => {
    const ships = packagedFilter()
    expect(ships('dist/m/index.html')).toBe(true)
    expect(ships('dist/m/h5.json')).toBe(true)
    expect(ships('dist/m/_expo/static/js/web/entry-0123abcd.js')).toBe(true)
    expect(ships('dist/m/assets/assets/fonts/GeistMono.0123abcd.ttf')).toBe(true)
    // electron-builder drops **/node_modules/** unless a later pattern brings it back.
    expect(ships('dist/m/assets/node_modules/expo-router/assets/error.0123abcd.png')).toBe(true)
  })

  it('still keeps the rest of the source tree and dependencies out of the app', () => {
    const ships = packagedFilter()
    expect(ships('node_modules/react/index.js')).toBe(false)
    expect(ships('dist/node_modules/left-pad/index.js')).toBe(false)
    expect(ships('src/main.tsx')).toBe(false)
  })
})
