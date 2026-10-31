import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import appConfig, { H5_BASE_PATH, withEasProject, withH5Build } from '../app.config'
import app from '../app.json'
import eas from '../eas.json'

test('existing app config remains valid before EAS association', () => {
  const legacy = { name: 'fixture', slug: 'fixture', extra: { feature: true } }
  expect(withEasProject(legacy, {})).toBe(legacy)
})

test('project association preserves widget declarations and other app configuration', () => {
  const projectId = '11111111-2222-4333-8444-555555555555'
  const extensions = [{ targetName: 'FixtureWidget', bundleIdentifier: 'test.fixture.widget' }]
  const old = {
    owner: 'fixture-owner',
    extra: { feature: true, eas: { projectId, build: { experimental: { ios: { appExtensions: extensions } } } } },
  }
  const updated = withEasProject(old, { EXPO_OWNER: 'ci-owner' })
  expect(updated.owner).toBe('ci-owner')
  expect(updated.extra).toEqual(old.extra)
  expect(old.owner).toBe('fixture-owner')
  expect(withEasProject(old, { EXPO_PROJECT_ID: ' ' }).extra?.eas.projectId).toBe(projectId)
  expect(() => withEasProject(old, { EXPO_PROJECT_ID: 'invalid' })).toThrow('UUID')
})

test('iOS builds carry the time-sensitive notification entitlement through app.config', () => {
  const key = 'com.apple.developer.usernotifications.time-sensitive'
  expect(app.expo.ios.entitlements[key]).toBe(true)
  const resolved = appConfig({ config: app.expo } as never)
  expect(resolved.ios?.entitlements?.[key]).toBe(true)
  // 加 entitlement 不能顶掉原有的 iOS 配置。
  expect(resolved.ios?.bundleIdentifier).toBe('com.yunce.cchaha.mobile')
  expect(resolved.ios?.infoPlist).toEqual(app.expo.ios.infoPlist)
})

test('the iOS home-screen icon is an opaque square, so Expo has no transparency to fill with white', () => {
  const resolved = appConfig({ config: app.expo } as never)
  const icon = resolved.ios?.icon
  expect(typeof icon).toBe('string')
  const png = readFileSync(join(import.meta.dir, '..', icon as string))
  // IHDR: width, height, then color type at byte 25 (2 = RGB without alpha).
  expect([png.readUInt32BE(16), png.readUInt32BE(20), png[25]]).toEqual([1024, 1024, 2])
  expect(png.includes('tRNS')).toBe(false)
})

test('production builds use remote credentials, increasing build numbers, and installable APKs', () => {
  expect(eas.cli.appVersionSource).toBe('remote')
  expect(eas.build.production).toMatchObject({
    distribution: 'store', credentialsSource: 'remote', autoIncrement: true,
    android: { buildType: 'apk' },
  })
  expect(eas.build.production).not.toHaveProperty('developmentClient')
})

test('only the desktop H5 export is served under a base path, and native builds are untouched', () => {
  const base = { name: 'fixture', slug: 'fixture', web: { bundler: 'metro' as const }, extra: { feature: true } }
  expect(withH5Build(base, {})).toBe(base)
  const h5 = withH5Build(base, { EXPO_PUBLIC_CC_HAHA_H5: '1' })
  expect(h5.experiments?.baseUrl).toBe(H5_BASE_PATH)
  expect(h5.web).toMatchObject({ bundler: 'metro', lang: 'zh-CN' })
  expect(h5.extra).toEqual({ feature: true })
  // The server's fallback for /m/* reloads is keyed to the same path.
  const server = readFileSync(join(import.meta.dir, '..', '..', 'src', 'server', 'staticH5.ts'), 'utf8')
  expect(server).toContain(`MOBILE_H5_BASE_PATH = '${H5_BASE_PATH}'`)
})
